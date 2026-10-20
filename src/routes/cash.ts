import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly, getUser } from "../middleware/auth";
import {
  ClosingError, decideStockSync, getStockSync, itemToken, listSyncItems, pendingDisposalCount, resolveApprover, stockSyncState, submitStockSync,
  syncShortageValue, syncUnpricedShortLines, type Approver,
} from "../services/closing";
import {
  addLedgerEntry, allBalances, chargeDecisionNeeded, chargeUndecided, ledgerBalance, ledgerEntries, readChargeDecision, type LedgerKind,
} from "../services/accounts";
import { todayDate } from "../utils/helpers";

const cash = new Hono();

const DENOMINATIONS = [20, 50, 100, 500, 1000, 2000, 5000] as const;

// Every drawer figure is money, and money is kept to the cent. Summing floats
// leaves tails like 4999.999999999 which, compared with `=== 0` or shown as a
// variance, turned an exact count into "short by Rs. 0.00".
function money(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

type DrawerCount = { notes: Record<`notes_${(typeof DENOMINATIONS)[number]}`, number>; coins_total: number };

/**
 * Validates one open/close count from the request body, or says why it cannot
 * be saved.
 *
 * Note rows are COUNTS of notes: a whole number, never negative. Before this
 * the server multiplied whatever arrived — "-3" fifties or 2.5 thousands went
 * straight into total_amount, and from there into the stored variance. A
 * missing or empty field still means 0, which is what a blank row means on the
 * counting screen.
 *
 * coins_total is the one money field (Rs 1/2/5/10 coins, counted as a total):
 * any finite amount >= 0, kept to the cent.
 */
function parseCount(body: any): DrawerCount | string {
  const notes = {} as DrawerCount["notes"];
  for (const d of DENOMINATIONS) {
    const raw = body?.[`notes_${d}`];
    if (raw === undefined || raw === null || raw === "") {
      notes[`notes_${d}`] = 0;
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      return `Rs ${d} notes must be a whole number of notes, 0 or more.`;
    }
    notes[`notes_${d}`] = n;
  }
  const rawCoins = body?.coins_total;
  let coins = 0;
  if (rawCoins !== undefined && rawCoins !== null && rawCoins !== "") {
    coins = Number(rawCoins);
    if (!Number.isFinite(coins) || coins < 0) return "Coins total must be an amount of 0 or more.";
  }
  return { notes, coins_total: money(coins) };
}

function computeTotal(count: DrawerCount): number {
  return money(
    DENOMINATIONS.reduce((sum, d) => sum + count.notes[`notes_${d}`] * d, 0) + count.coins_total
  );
}

// Returns the currently OPEN shift across all dates — i.e. the latest 'open'
// record that has no 'close' recorded after it. If none, returns null.
// Shifts intentionally span midnight so the cashier MUST explicitly close
// before the day rolls over (or first thing the next morning).
function getCurrentOpenShift() {
  const db = getDb();
  const latestOpen = db.query(
    "SELECT cc.*, u.full_name as user_name FROM cash_counts cc LEFT JOIN users u ON cc.user_id = u.id WHERE count_type = 'open' ORDER BY created_at DESC, cc.id DESC LIMIT 1"
  ).get() as any;
  if (!latestOpen) return null;
  const latestClose = db.query(
    "SELECT id, created_at FROM cash_counts WHERE count_type = 'close' ORDER BY created_at DESC, id DESC LIMIT 1"
  ).get() as { id: number; created_at: string } | null;
  // Timestamps are to the second: in the same second, the later row (the
  // higher id) decides — an open straight after a close is open.
  if (latestClose) {
    const tc = new Date(latestClose.created_at).getTime();
    const to = new Date(latestOpen.created_at).getTime();
    if (tc > to || (tc === to && latestClose.id > latestOpen.id)) return null;
  }
  return latestOpen;
}

// Latest close across all dates (regardless of state). Used for status display.
function getLatestClose() {
  const db = getDb();
  return db.query(
    "SELECT cc.*, u.full_name as user_name FROM cash_counts cc LEFT JOIN users u ON cc.user_id = u.id WHERE count_type = 'close' ORDER BY created_at DESC, cc.id DESC LIMIT 1"
  ).get() as any;
}

function getCashSalesSince(since: string): number {
  const db = getDb();
  // Count cash received at the point of sale (whether later refunded or not).
  // No date filter so shifts that span midnight see all their sales.
  const row = db.query(`
    SELECT COALESCE(SUM(total), 0) as total
    FROM bills
    WHERE payment_method = 'cash' AND status IN ('completed', 'refunded') AND created_at >= ?
  `).get(since) as { total: number };
  return row.total;
}

function getCashRefundsSince(since: string): number {
  const db = getDb();
  const row = db.query(`
    SELECT COALESCE(SUM(total), 0) as total
    FROM bills
    WHERE payment_method = 'cash' AND status = 'refunded' AND refunded_at >= ?
  `).get(since) as { total: number };
  return row.total;
}

function getCashExpensesSince(since: string): number {
  const db = getDb();
  const row = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM expenses
    WHERE payment_source = 'cash' AND status = 'approved' AND created_at >= ?
  `).get(since) as { total: number };
  return row.total;
}

function getPendingExpenseCountSince(since: string): number {
  const db = getDb();
  const row = db.query(
    "SELECT COUNT(*) as count FROM expenses WHERE status = 'pending' AND created_at >= ?"
  ).get(since) as { count: number };
  return row.count;
}

/**
 * Deposits taken on pre-orders in CASH since the shift opened.
 *
 * This is cash in the drawer that is NOT a sale: no bill exists for it, so
 * getCashSalesSince() cannot see it, and before this line existed every
 * deposit the shop took showed up at close as an unexplained cash SURPLUS.
 *
 * Only payment_method = 'cash' counts — a card or UPI deposit never reaches the
 * drawer. Compared on created_at, not paid_on, for the same reason as sales and
 * expenses above: a shift may span midnight, and what matters is "since this
 * drawer was counted open", not "today's date".
 */
function getDepositsTakenSince(since: string): number {
  const db = getDb();
  const row = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM pre_order_payments
    WHERE payment_method = 'cash' AND created_at >= ?
  `).get(since) as { total: number };
  return row.total;
}

/**
 * The other half of the same term, and without it the variance would simply
 * move to collection day instead of being fixed.
 *
 * When a pre-order is collected it is rung up as an ordinary bill for the FULL
 * value of the cake (that is what keeps the day's SALES right). But the cashier
 * only takes the BALANCE at the counter — the rest arrived days ago as a
 * deposit, and was already counted in the drawer on that day. So for a CASH
 * collection bill, getCashSalesSince() over-states today's drawer by exactly
 * what had already been paid on that order, and that amount is subtracted back
 * out here.
 *
 * Summed over ALL payment methods, not just cash: the over-statement being
 * corrected is in the bill's total, whatever method the earlier deposit used. A
 * card deposit was never added by getDepositsTakenSince(), and it is not in the
 * drawer now either — but the cash bill counts it, so it still has to come off.
 *
 * Restricted to bills whose own payment_method is 'cash' and whose status is
 * one getCashSalesSince() counts, so this only ever cancels something that was
 * actually added.
 *
 * Note on the invariant it relies on: pre_order_payments holds PRE-collection
 * payments only. Collecting writes no payment row (the bill records the money),
 * and POST /api/preorders/:id/payments refuses an order that is already
 * collected — so every row joined here predates its bill.
 */
function getDepositsAppliedSince(since: string): number {
  const db = getDb();
  const row = db.query(`
    SELECT COALESCE(SUM(pop.amount), 0) as total
    FROM pre_order_payments pop
    JOIN pre_orders po ON po.id = pop.pre_order_id
    JOIN bills b ON b.id = po.bill_id
    WHERE b.payment_method = 'cash'
      AND b.status IN ('completed', 'refunded')
      AND b.created_at >= ?
  `).get(since) as { total: number };
  return row.total;
}

/**
 * Deposits paid BACK in cash when a pre-order was cancelled, since the shift
 * opened.
 *
 * Money leaving the drawer, so it comes off expected cash. It is deliberately
 * NOT an expense (it was the customer's money held for them, never the shop's
 * spending, and booking it as one used to cut the day's profit) and not
 * negative income — it simply undoes getDepositsTakenSince() for that order,
 * on the day the cash actually went back over the counter.
 *
 * Only cash refunds: a card or LankaQR refund never touches the drawer. A
 * deposit the customer forfeited ('kept') moves no cash at all — it was
 * counted in when it was taken and simply stays — so it is not here either.
 * Compared on deposit_settled_at (UTC datetime('now'), set by POST
 * /api/preorders/:id/cancel) for the same shift-window reason as the rest.
 */
function getDepositsRefundedSince(since: string): number {
  const db = getDb();
  const row = db.query(`
    SELECT COALESCE(SUM(deposit_settled_amount), 0) as total
    FROM pre_orders
    WHERE deposit_outcome = 'refunded' AND deposit_refund_method = 'cash'
      AND deposit_settled_at >= ?
  `).get(since) as { total: number };
  return row.total;
}

/**
 * Why a cash movement must be refused right now, or null if it may proceed.
 *
 * The same rule POST /api/pos/bill enforces inline, exposed as a function so
 * that the OTHER places money enters this drawer — a pre-order deposit, a
 * pre-order collection — are governed by one rule instead of three copies of
 * it. Returns null when enforce_cash_shift is off, so the setting keeps
 * meaning exactly what it meant before.
 */
export function cashShiftBlockReason(): string | null {
  const db = getDb();
  const setting = db.query("SELECT value FROM settings WHERE key = 'enforce_cash_shift'").get() as
    | { value: string }
    | null;
  if ((setting?.value ?? "1") !== "1") return null;

  const open = getCurrentOpenShift();
  if (!open) {
    const everOpened = db.query("SELECT id FROM cash_counts WHERE count_type = 'open' LIMIT 1").get();
    return everOpened
      ? "The cash shift has been closed. Open a new shift on the Cash Drawer page to continue."
      : "Cash drawer not opened. Record opening float on the Cash Drawer page before taking money.";
  }
  if (open.count_date !== todayDate()) {
    return `A shift from ${open.count_date} is still open. Close it on the Cash Drawer page before taking today's money.`;
  }
  return null;
}

// --- The drawer holder ---------------------------------------------------------
//
// One person answers for the drawer at a time: the HOLDER — the opener, until
// a handover passes it on (or an admin takes it over). Only the holder (or an
// admin) takes cash, counts the stock for it, hands it over or closes it, so a
// shortage is never charged to someone for cash another person handled.

/** Who holds an open shift's drawer: holder_user_id, else the opener. */
export function drawerHolder(open: any): { id: number; name: string } | null {
  if (!open) return null;
  const id = open.holder_user_id ?? open.user_id;
  const row = getDb().query("SELECT full_name FROM users WHERE id = ?").get(id) as any;
  return { id, name: row?.full_name || "the holder" };
}

/** The handover of this shift still waiting for its receiver, if any. */
function pendingHandover(shiftOpenId: number): any {
  return getDb().query(`
    SELECT h.*, f.full_name AS from_name, t.full_name AS to_name FROM drawer_handovers h
    LEFT JOIN users f ON f.id = h.from_user_id LEFT JOIN users t ON t.id = h.to_user_id
    WHERE h.shift_open_id = ? AND h.status IN ('pending', 'awaiting_admin') ORDER BY h.id DESC LIMIT 1
  `).get(shiftOpenId) as any;
}

/**
 * Why `user` may not take (or pay out) CASH right now, or null. The shift rule
 * (cashShiftBlockReason) first; then, while a shift is open, two more:
 *   * a handover is waiting — cash pauses for everyone, so the counts taken at
 *     both ends of it describe the same drawer (the owner's choice);
 *   * only the holder, or an admin, handles the drawer's cash.
 * Card and LankaQR never touch the drawer and are never refused here.
 */
export function cashTakerBlockReason(user: { id: number; role: string }): string | null {
  return cashShiftBlockReason() ?? drawerHandlerBlockReason(user);
}

/**
 * The holder half of cashTakerBlockReason alone: the handover pause and
 * holder-or-admin, only while a shift is open. For cash movements that never
 * needed a shift (an expense paid in cash), so they gain the holder rule
 * without suddenly needing a shift too.
 */
export function drawerHandlerBlockReason(user: { id: number; role: string }): string | null {
  const open = getCurrentOpenShift();
  if (!open) return null; // no shift at all (only possible with enforce_cash_shift off)
  const h = pendingHandover(open.id);
  if (h) {
    return h.status === "awaiting_admin"
      ? `The drawer handover to ${h.to_name} is waiting for an admin. Cash payments are paused until it is settled — card and LankaQR are fine.`
      : `The drawer is being handed over to ${h.to_name}. Cash payments are paused until they accept (or it is cancelled) — card and LankaQR are fine.`;
  }
  if (user.role === "admin") return null;
  const holder = drawerHolder(open)!;
  if (holder.id !== user.id) {
    return `${holder.name} holds the cash drawer, so only they can take or pay out cash. Card and LankaQR are fine — or ask them to hand the drawer over.`;
  }
  return null;
}

/** No shift open, but the drawer has been closed before: cash in it is carried, untouchable. */
export function drawerClosedBetweenShifts(): boolean {
  return !getCurrentOpenShift() && !!getLatestClose();
}

/** The latest change of hands of this shift (handover or takeover), if any. */
function lastAcceptedHandover(shiftOpenId: number): any {
  return getDb().query(
    "SELECT * FROM drawer_handovers WHERE shift_open_id = ? AND status = 'accepted' ORDER BY accepted_at DESC, id DESC LIMIT 1"
  ).get(shiftOpenId) as any;
}

/** Charge small shortages (within the limit) too? settings.charge_small_shortages. */
function chargeSmallShortages(): boolean {
  const row = getDb().query("SELECT value FROM settings WHERE key = 'charge_small_shortages'").get() as any;
  return row?.value === "1";
}

/**
 * What the drawer should hold right now for the open shift, and every part of
 * it. The ONE formula: GET /today shows it, POST /close stores it, and a close
 * request is checked against it — so the three can never quote different
 * figures.
 */
function expectedFor(openRow: any) {
  // After a handover the drawer goes on from what the RECEIVER counted:
  // whatever the giver was short (or over) is settled at the handover —
  // charged or written off there — so it must not be found, and charged to
  // the receiver, a second time at the close. Each accepted handover's
  // variance is that correction. (Not "start again from accepted_at": the
  // timestamps are to the second, so a sale in the same second as the
  // acceptance would be counted on the wrong side of it.)
  const since = openRow.created_at;
  const opening = openRow.total_amount || 0;
  const handovers = getDb().query(
    "SELECT COALESCE(SUM(variance), 0) AS v, COUNT(*) AS n FROM drawer_handovers WHERE shift_open_id = ? AND status = 'accepted'"
  ).get(openRow.id) as any;
  const handoverAdjustment = money(Number(handovers?.v) || 0);
  const baseline = handovers?.n ? lastAcceptedHandover(openRow.id) : null;
  const cashSales = getCashSalesSince(since);
  const cashRefunds = getCashRefundsSince(since);
  const cashExpenses = getCashExpensesSince(since);
  // Pre-order deposits. Two parts of one term, both needed:
  //   + depositsTaken   cash handed over for a future cake. Real money in the
  //                     drawer with no bill behind it, so without this it
  //                     looked like a surplus.
  //   - depositsApplied the share of today's CASH collection bills that was
  //                     already paid before today. cashSales counts those bills
  //                     at their full value (which is what keeps the day's
  //                     SALES honest), but only the balance came over the
  //                     counter today — so without this the variance would just
  //                     have moved to collection day.
  // Nothing else in this formula changes, and neither part is derived from the
  // other: a deposit taken and collected in the same shift nets to the bill
  // total, which is exactly what the drawer received.
  const depositsTaken = getDepositsTakenSince(since);
  const depositsApplied = getDepositsAppliedSince(since);
  //   - depositsRefunded cash deposits paid back on cancelled pre-orders during
  //                     this shift: real cash out of the drawer, neither an
  //                     expense nor income.
  const depositsRefunded = getDepositsRefundedSince(since);
  // Rounded to the cent, as are counted and variance, so the stored figures are
  // exactly the ones the close screen shows and an exact count stores 0.
  const expected = money(
    opening + cashSales - cashRefunds - cashExpenses + depositsTaken - depositsApplied - depositsRefunded + handoverAdjustment
  );
  return {
    expected,
    // The last change of hands: what the drawer was counted at then.
    baseline: baseline ? { handover_id: baseline.id, at: baseline.accepted_at, amount: Number(baseline.receiver_total) || 0 } : null,
    breakdown: {
      opening,
      cash_sales: cashSales,
      cash_refunds: cashRefunds,
      cash_expenses: cashExpenses,
      deposits_taken: depositsTaken,
      deposits_applied: depositsApplied,
      deposits_refunded: depositsRefunded,
      // What handovers counted short (-) or over (+), settled there.
      handover_adjustment: handoverAdjustment,
    },
  };
}

/** Rs. A close more than this over OR short needs an admin (settings.cash_variance_limit). */
function varianceLimit(): number {
  const row = getDb().query("SELECT value FROM settings WHERE key = 'cash_variance_limit'").get() as any;
  // Blank is not "0 allowed" (Number("") is 0): that would send every close to
  // the owner. Anything unreadable falls back to the default.
  const raw = String(row?.value ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) && n >= 0 ? n : 200;
}

/** Over the limit either way, with half a cent of slack for the float tail. */
const overLimit = (variance: number, limit: number) => Math.abs(variance) > limit + 0.005;

/** The latest close request of this shift that still means something (not superseded). */
function latestCloseRequest(shiftOpenId: number) {
  return getDb().query(`
    SELECT r.*, u.full_name AS user_name, d.full_name AS decided_by_name
    FROM cash_close_requests r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.decided_by
    WHERE r.shift_open_id = ? AND r.status != 'superseded' ORDER BY r.id DESC LIMIT 1
  `).get(shiftOpenId) as any;
}

/**
 * A stock sync as the person asking may see it. A cashier gets how many lines
 * did not match and nothing per line — no system figure, and not even WHICH
 * line was off, since that is enough to home in on the system's figure. An
 * admin sees everything.
 */
function syncForViewer(sync: any, isAdmin: boolean) {
  if (!sync) return null;
  if (isAdmin) return sync;
  const { lines, ...rest } = sync;
  return { ...rest, line_count: (lines || []).length };
}

/**
 * A handover as the asking user may see it. The giver's and receiver's counts
 * stay with them and an admin: the receiver counts blind, or they would just
 * copy the giver's figure. Everyone else sees who, when and the state.
 */
function handoverForViewer(h: any, user: { id: number; role: string }) {
  if (!h) return null;
  if (user.role === "admin") return h;
  const out: any = {
    id: h.id, kind: h.kind, status: h.status, from_user_id: h.from_user_id, to_user_id: h.to_user_id,
    from_name: h.from_name, to_name: h.to_name, created_at: h.created_at, answered_at: h.answered_at,
    decline_reason: h.decline_reason, giver_notes: h.giver_notes,
  };
  if (user.id === h.from_user_id) Object.assign(out, { giver_total: h.giver_total, giver_expected: h.giver_expected });
  // The receiver sees their own count, never the variance: that and their
  // count give away the expected figure for a recount.
  if (user.id === h.to_user_id && h.status !== "pending") Object.assign(out, { receiver_total: h.receiver_total });
  return out;
}

/**
 * A sync for an admin deciding it: what its shortage would charge, to whom,
 * and which short lines have no price (so the admin can set the amount).
 */
function withShortage(sync: any) {
  if (!sync) return sync;
  const holderId = sync.holder_user_id ?? sync.user_id;
  const holder = getDb().query("SELECT full_name FROM users WHERE id = ?").get(holderId) as any;
  return {
    ...sync,
    shortage_value: syncShortageValue(sync.id),
    unpriced_short_lines: syncUnpricedShortLines(sync.id),
    charge_to: { id: holderId, name: holder?.full_name || "the holder" },
  };
}

function closingError(c: any, err: any) {
  if (err instanceof ClosingError) return c.json({ error: err.message, ...err.extra }, err.status);
  throw err;
}

cash.get("/today", (c) => {
  const user = getUser(c)!;
  const date = todayDate();
  const open = getCurrentOpenShift();
  const close = getLatestClose();
  const shift_open = !!open;

  // With a shift open, every figure is expectedFor()'s — the same the close
  // stores, handover corrections included. With none open, a zeroed-out
  // summary since the last close.
  const exp = open ? expectedFor(open) : null;
  const since = close?.created_at || `${date} 00:00:00`;
  const cash_sales = exp ? exp.breakdown.cash_sales : getCashSalesSince(since);
  const cash_refunds = exp ? exp.breakdown.cash_refunds : getCashRefundsSince(since);
  const cash_expenses = exp ? exp.breakdown.cash_expenses : getCashExpensesSince(since);
  // Pre-order deposits: cash in the drawer that is not a sale (+), and the part
  // of today's cash bills that was already paid as a deposit earlier (-).
  const deposits_taken = exp ? exp.breakdown.deposits_taken : getDepositsTakenSince(since);
  const deposits_applied = exp ? exp.breakdown.deposits_applied : getDepositsAppliedSince(since);
  // Cash deposits handed back on cancelled pre-orders (-). Not an expense.
  const deposits_refunded = exp ? exp.breakdown.deposits_refunded : getDepositsRefundedSince(since);
  const pending_expenses = open ? getPendingExpenseCountSince(open.created_at) : 0;

  // What a close right now would expect to find in the drawer: expectedFor(),
  // the same figure POST /close stores. cash.html and m-cash.html show it as-is
  // and work the variance out from it.
  const expected_now = exp ? exp.expected : 0;
  // Who answers for the drawer, and any handover in flight.
  const holder = open ? drawerHolder(open) : null;
  const handover = open ? pendingHandover(open.id) ?? null : null;
  // While a shift is open, what the drawer should hold is for its holder and
  // admins only. Anyone else may be handed the drawer next, and counts it
  // blind: knowing the figure, they would just "find" it.
  const figuresHidden = !!open && user.role !== "admin" && holder?.id !== user.id;
  const hide = (n: number) => (figuresHidden ? null : n);

  // Surface whether the open shift is from a prior day (cashier must close it
  // before starting fresh today).
  const open_date = open?.count_date ?? null;
  const shift_from_prior_day = !!open && open_date !== date;

  // The two closing gates (src/services/closing.ts): where this shift's stock
  // sync stands, and any close request waiting on (or approved by) an admin.
  const syncState = open ? holderSyncState(open) : null;
  const close_request = open ? latestCloseRequest(open.id) ?? null : null;

  return c.json({
    date,
    open,
    // A non-admin may be the next opener, who counts blind: no figures.
    close: user.role === "admin" || !close ? close : { id: close.id, count_type: close.count_type, count_date: close.count_date, created_at: close.created_at, user_id: close.user_id, user_name: close.user_name },
    shift_open,
    shift_from_prior_day,
    cash_sales: hide(cash_sales),
    cash_refunds: hide(cash_refunds),
    cash_expenses: hide(cash_expenses),
    deposits_taken: hide(deposits_taken),
    deposits_applied: hide(deposits_applied),
    deposits_refunded: hide(deposits_refunded),
    expected_now: hide(expected_now),
    figures_hidden: figuresHidden,
    pending_expenses,
    // Refunds waiting on an admin: they block the close like pending expenses.
    pending_refunds: open ? pendingRefundCount() : 0,
    // Waste reports waiting on an admin: they block the stock count and the close.
    pending_disposals: open ? pendingDisposalCount() : 0,
    variance_limit: varianceLimit(),
    stock_sync: syncState
      ? { valid: syncState.valid, stale: syncState.stale, stale_reason: syncState.stale_reason, sync: syncForViewer(syncState.sync, user.role === "admin") }
      : null,
    close_request: figuresHidden ? null : close_request,
    // --- the holder and the handover (feature/drawer-accountability) ---
    holder,
    is_holder: !!holder && holder.id === user.id,
    // The last change of hands, and what handovers counted short/over in all.
    baseline: exp?.baseline ?? null,
    handover_adjustment: hide(exp?.breakdown.handover_adjustment ?? 0),
    handover: handover ? handoverForViewer(handover, user) : null,
    charge_small_shortages: chargeSmallShortages(),
    // The asking user's own pending account (what they owe the shop).
    my_balance: ledgerBalance(user.id),
    // Between shifts: the last close, what was collected from it and what is
    // left (admins only — the opener counts blind), and any opening request.
    carry: user.role === "admin" ? carriedForAdmin() : null,
    open_request: open ? null : openRequestForViewer(latestOpenRequest(close?.id ?? null), user),
  });
});

// --- Cash collected after a close, and the opening that follows ------------------
//
// After a close an admin takes cash out of the drawer (to the bank or the safe)
// and records it against that close (POST /collections). What is left is the
// CARRIED amount — the close's count minus what was collected — and the next
// opening has to count exactly that. If it does not, an admin approves the
// opening (their login, their password at the till, or a request they approve
// from their phone), and a shortfall is charged to the last holder or the
// opener, or written off. Nothing collected means everything is carried.

/** The collections still standing against a close, oldest first. */
function collectionsFor(closeId: number): any[] {
  return getDb().query(`
    SELECT cl.*, u.full_name AS user_name FROM cash_collections cl LEFT JOIN users u ON u.id = cl.user_id
    WHERE cl.close_id = ? AND cl.voided_at IS NULL ORDER BY cl.id
  `).all(closeId) as any[];
}

/**
 * What the next opening should count: the last close's count minus what was
 * collected from it. null when no shift was ever closed (the first opening
 * has nothing to match).
 */
function carriedOver(): { close: any; collected: number; carried: number } | null {
  const close = getLatestClose();
  if (!close) return null;
  const row = getDb().query(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM cash_collections WHERE close_id = ? AND voided_at IS NULL"
  ).get(close.id) as any;
  const collected = money(Number(row?.s) || 0);
  return { close, collected, carried: money((Number(close.total_amount) || 0) - collected) };
}

/** Who answered for the drawer at a close: its holder then, else whoever closed it. */
function closeHolder(close: any): { id: number; name: string } {
  // Closes from before holder_user_id was recorded: the holder of the shift
  // that close ended (an admin may have closed it for them).
  const shiftOpen = close.holder_user_id == null
    ? getDb().query("SELECT holder_user_id, user_id FROM cash_counts WHERE count_type = 'open' AND id < ? ORDER BY id DESC LIMIT 1").get(close.id) as any
    : null;
  const id = close.holder_user_id ?? shiftOpen?.holder_user_id ?? shiftOpen?.user_id ?? close.user_id;
  const row = getDb().query("SELECT full_name FROM users WHERE id = ?").get(id) as any;
  return { id, name: row?.full_name || "the last holder" };
}

/** Counts at opening that did not match, since this close (see /open). */
const OPEN_TRIES = 3;
function openMismatchCount(closeId: number): number {
  const row = getDb().query(
    "SELECT COUNT(*) AS n FROM activity_log WHERE action = 'cash_open_mismatch' AND json_extract(details, '$.close_id') = ?"
  ).get(closeId) as any;
  return Number(row?.n) || 0;
}

/** The latest opening request after this close that still means something. */
function latestOpenRequest(prevCloseId: number | null): any {
  if (prevCloseId == null) return null;
  return getDb().query(`
    SELECT r.*, u.full_name AS user_name, d.full_name AS decided_by_name, t.full_name AS charge_to_name
    FROM cash_open_requests r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.decided_by LEFT JOIN users t ON t.id = r.charge_to
    WHERE r.prev_close_id = ? AND r.status != 'superseded' ORDER BY r.id DESC LIMIT 1
  `).get(prevCloseId) as any;
}

/**
 * The admin's decision on an opening shortfall: charge it to the last holder
 * ("closer") or the opener, or write it off. Undecided → the 409 that makes
 * the page ask (with both people to choose from). Returns the decision, or a
 * Response-ready object { status, body } to send back.
 */
function openShortDecision(body: any, short: number, closer: { id: number; name: string }, opener: { id: number; name: string }):
  { charge: boolean; amount: number; note: string | null; toUserId: number | null } | { status: 400 | 409; body: any } {
  const options = [
    { key: "closer", id: closer.id, name: closer.name, label: `${closer.name} (held the drawer at the last close)` },
    { key: "opener", id: opener.id, name: opener.name, label: `${opener.name} (opening now)` },
  ];
  const charging = !(body?.charge === false || body?.charge === 0 || body?.charge === "0");
  if (chargeUndecided(body) || (charging && body?.charge_to !== "closer" && body?.charge_to !== "opener")) {
    return { status: 409, body: { ...chargeDecisionNeeded(short, closer), error: `The drawer is short by Rs ${short.toFixed(2)} from what was left at the last close. Choose who it is charged to, or write it off.`, charge_options: options } };
  }
  const d = readChargeDecision(body, short, short);
  if (typeof d === "string") return { status: 400, body: { error: d } };
  return { ...d, toUserId: d.charge ? (body.charge_to === "opener" ? opener.id : closer.id) : null };
}

// Open a shift. Body: the drawer count. Or { open_request_id } to open on a
// request an admin approved (its count is used). An opening that does not
// match what was carried needs an admin: their login or password here
// (admin_username / admin_password), with { charge, charge_to, ... } for a
// shortfall.
cash.post("/open", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => ({} as any));
  const db = getDb();
  const date = todayDate();

  if (getCurrentOpenShift()) {
    return c.json({ error: "A shift is already open (possibly from a previous day). Close it before starting a new one." }, 400);
  }
  let approver: Approver | null;
  try {
    approver = await resolveApprover(user, body);
  } catch (err: any) {
    return closingError(c, err);
  }

  const carry = carriedOver();
  let count: ReturnType<typeof parseCount>;
  let notes: string | null = body.notes || null;
  let requestId: number | null = null;
  let approvedBy: number | null = null;
  let opener: { id: number; name: string } = { id: user.id, name: user.full_name || "the opener" };
  // A shortfall's outcome: charged to someone, or written off (note), or nothing.
  let charge: { amount: number; toUserId: number; note: string | null } | null = null;
  let writeOff: string | null = null;

  if (body.open_request_id != null) {
    const req = db.query("SELECT r.*, u.full_name AS user_name FROM cash_open_requests r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?").get(Number(body.open_request_id)) as any;
    if (!req || !carry || req.prev_close_id !== carry.close.id) return c.json({ error: "That opening request is not for this drawer." }, 400);
    if (req.status !== "approved") return c.json({ error: `That opening request is ${req.status}, not approved.` }, 400);
    if (req.user_id !== user.id && user.role !== "admin") return c.json({ error: `That opening was approved for ${req.user_name}; they open on it.` }, 400);
    if (Math.abs(money(req.expected_amount) - carry.carried) > 0.005) {
      return c.json({ error: "The cash collected from the drawer has changed since the admin approved this. Count the drawer again." }, 409);
    }
    count = parseCount(JSON.parse(req.count_json));
    notes = req.notes;
    requestId = req.id;
    approvedBy = req.decided_by;
    opener = { id: req.user_id, name: req.user_name };
    if (req.charge_decision === "charge" && Number(req.charge_amount) > 0 && req.charge_to) {
      charge = { amount: Number(req.charge_amount), toUserId: req.charge_to, note: req.charge_note };
    } else if (req.charge_decision === "write_off") {
      writeOff = req.charge_note || "Written off";
    }
  } else {
    count = parseCount(body);
  }
  if (typeof count === "string") return c.json({ error: count }, 400);
  const n = count.notes;
  const total = computeTotal(count);
  const expected = carry ? carry.carried : null;
  const variance = expected == null ? 0 : money(total - expected);
  // The opener counts blind and is told only "does not match" — and only a
  // few times: after OPEN_TRIES counts that did not match, even a matching
  // one needs an admin, or counting again and again would find the figure.
  const tries = carry && !requestId ? openMismatchCount(carry.close.id) : 0;
  const off = Math.abs(variance) > 0.005 || (!approver && tries >= OPEN_TRIES);

  if (off && !requestId) {
    if (!approver) {
      if (Math.abs(variance) > 0.005) {
        db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cash_open_mismatch', ?)").run(
          user.id, JSON.stringify({ close_id: carry!.close.id, counted: total, carried: expected, variance })
        );
      }
      return c.json({
        error: tries >= OPEN_TRIES
          ? "The drawer has been counted several times without matching what was left at the last close. An admin has to approve this opening."
          : "The count does not match what was left in the drawer at the last close. Count it again, or ask an admin to approve this opening.",
        needs_approval: true,
      }, 409);
    }
    approvedBy = approver.id;
    if (variance < 0) {
      const d = openShortDecision(body, -variance, closeHolder(carry!.close), opener);
      if ("status" in d) return c.json(d.body, d.status);
      if (d.charge && d.amount > 0) charge = { amount: d.amount, toUserId: d.toUserId!, note: d.note };
      else if (!d.charge) writeOff = d.note;
    }
  }

  let openId: number;
  try {
    openId = db.transaction(() => {
      // Re-checked under the write lock: the password check awaited.
      if (getCurrentOpenShift()) throw new ClosingError("A shift has just been opened.", 409);
      const now = carriedOver();
      if ((now?.close.id ?? null) !== (carry?.close.id ?? null) || Math.abs((now?.carried ?? 0) - (carry?.carried ?? 0)) > 0.005) {
        throw new ClosingError("The cash collected from the drawer changed while opening. Count the drawer again.", 409);
      }
      if (requestId) {
        const used = db.query("UPDATE cash_open_requests SET status = 'used' WHERE id = ? AND status = 'approved'").run(requestId);
        if (Number(used.changes || 0) !== 1) throw new ClosingError("That approval has already been used.", 409);
      }
      const id = Number(db.query(`
        INSERT INTO cash_counts (count_type, count_date, user_id, notes_20, notes_50, notes_100, notes_500, notes_1000, notes_2000, notes_5000, coins_total, total_amount, notes, carried_amount, open_variance, variance_approved_by)
        VALUES ('open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        date, opener.id,
        n.notes_20, n.notes_50, n.notes_100, n.notes_500, n.notes_1000, n.notes_2000, n.notes_5000,
        count.coins_total, total, notes, expected, expected == null ? null : variance, off ? approvedBy : null
      ).lastInsertRowid);
      if (requestId) db.query("UPDATE cash_open_requests SET used_open_id = ? WHERE id = ?").run(id, requestId);
      if (carry) db.query("UPDATE cash_open_requests SET status = 'superseded' WHERE prev_close_id = ? AND status IN ('pending', 'approved')").run(carry.close.id);
      const by = approvedBy ?? user.id;
      if (charge) {
        addLedgerEntry({
          userId: charge.toUserId, kind: "cash_short", amount: charge.amount, sourceType: "open", sourceId: id,
          note: `Drawer short at opening (${date}): ${expected!.toFixed(2)} was left at the last close, ${total.toFixed(2)} counted${charge.note ? ` — ${charge.note}` : ""}`,
          createdBy: by,
        });
        db.query("UPDATE cash_counts SET charged_amount = ?, charged_to = ? WHERE id = ?").run(charge.amount, charge.toUserId, id);
      }
      if (writeOff) {
        db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cash_short_written_off', ?)").run(
          by, JSON.stringify({ open_id: id, short: -variance, carried: expected, note: writeOff })
        );
      }
      if (off) {
        db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cash_open_variance_approved', ?)").run(
          by, JSON.stringify({ open_id: id, carried: expected, counted: total, variance, open_request_id: requestId, charged_to: charge?.toUserId ?? null, written_off: writeOff })
        );
      }
      return id;
    }).immediate();
  } catch (err: any) {
    return closingError(c, err);
  }
  return c.json({ success: true, id: openId, total_amount: total, coins_total: count.coins_total, carried_amount: expected, variance });
});

// The opener asks an admin to approve opening on a count that does not match
// what was carried. Body: the count. A new request replaces an older one.
cash.post("/open-requests", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => ({} as any));
  const db = getDb();
  if (getCurrentOpenShift()) return c.json({ error: "A shift is already open." }, 400);
  const carry = carriedOver();
  if (!carry) return c.json({ error: "Nothing has been closed yet, so any opening count is fine — just open." }, 400);
  const count = parseCount(body);
  if (typeof count === "string") return c.json({ error: count }, 400);
  const total = computeTotal(count);
  const variance = money(total - carry.carried);
  const request = db.transaction(() => {
    db.query("UPDATE cash_open_requests SET status = 'superseded' WHERE prev_close_id = ? AND status IN ('pending', 'approved')").run(carry.close.id);
    const id = Number(db.query(`
      INSERT INTO cash_open_requests (prev_close_id, user_id, count_json, total_amount, expected_amount, variance, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(carry.close.id, user.id, JSON.stringify({ ...count.notes, coins_total: count.coins_total }), total, carry.carried, variance, body.notes || null).lastInsertRowid);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cash_open_requested', ?)").run(
      user.id, JSON.stringify({ open_request_id: id, carried: carry.carried, counted: total, variance })
    );
    return latestOpenRequest(carry.close.id);
  }).immediate();
  return c.json({ success: true, request: openRequestForViewer(request, user) });
});

// An admin decides an opening request. Approve body, for a shortfall:
// { charge, charge_to: 'closer' | 'opener', charge_amount?, write_off_note? }.
// Reject body: { note }.
for (const action of ["approve", "reject"] as const) {
  cash.post(`/open-requests/:id/${action}`, async (c) => {
    const user = getUser(c)!;
    const body = await c.req.json().catch(() => ({} as any));
    const db = getDb();
    let approver: Approver | null;
    try {
      approver = await resolveApprover(user, body);
    } catch (err: any) {
      return closingError(c, err);
    }
    if (!approver) return c.json({ error: "Only an admin can approve or reject an opening." }, 403);
    const note = String(body.note ?? "").trim() || null;
    if (action === "reject" && !note) return c.json({ error: "Say why it is rejected, so the drawer can be counted again properly." }, 400);
    const id = Number(c.req.param("id"));
    const result = db.transaction(() => {
      const req = db.query("SELECT r.*, u.full_name AS user_name FROM cash_open_requests r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = ?").get(id) as any;
      if (!req) return { status: 404 as const, body: { error: "That opening request was not found" } };
      if (req.status !== "pending") return { status: 400 as const, body: { error: `That opening request is already ${req.status}.` } };
      const carry = carriedOver();
      if (getCurrentOpenShift() || !carry || carry.close.id !== req.prev_close_id) return { status: 400 as const, body: { error: "A shift has opened since; this request no longer applies." } };
      let decision: string | null = null, chargeTo: number | null = null, chargeAmount: number | null = null, chargeNote: string | null = null;
      if (action === "approve" && Number(req.variance) < -0.005) {
        const d = openShortDecision(body, -Number(req.variance), closeHolder(carry.close), { id: req.user_id, name: req.user_name });
        if ("status" in d) return d;
        decision = d.charge ? "charge" : "write_off";
        chargeTo = d.toUserId;
        chargeAmount = d.charge ? d.amount : null;
        chargeNote = d.note;
      }
      db.query(`
        UPDATE cash_open_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ?,
          charge_decision = ?, charge_to = ?, charge_amount = ?, charge_note = ? WHERE id = ?
      `).run(action === "approve" ? "approved" : "rejected", approver!.id, note, decision, chargeTo, chargeAmount, chargeNote, id);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)").run(
        approver!.id, action === "approve" ? "cash_open_approved" : "cash_open_rejected",
        JSON.stringify({ open_request_id: id, variance: req.variance, note, at_till: approver!.at_till })
      );
      return { request: latestOpenRequest(req.prev_close_id) };
    }).immediate();
    if ("status" in result) return c.json(result.body, result.status);
    return c.json({ success: true, request: result.request });
  });
}

/** An opening request as the asker may see it: no carried figure for a non-admin. */
function openRequestForViewer(r: any, user: { role: string }) {
  if (!r || user.role === "admin") return r;
  const { expected_amount, variance, charge_amount, ...rest } = r;
  return rest;
}

// An admin records cash taken out of the drawer after the last close.
// Body: { amount, note? }. Only while no shift is open, and never more than is
// in the drawer.
cash.post("/collections", adminOnly, async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => ({} as any));
  const db = getDb();
  const amount = money(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: "Enter the amount taken out of the drawer." }, 400);
  const note = String(body.note ?? "").trim() || null;
  const out = db.transaction(() => {
    if (getCurrentOpenShift()) return { error: "A shift is open. Cash is collected after the drawer is closed." };
    const carry = carriedOver();
    if (!carry) return { error: "The drawer has never been closed." };
    if (amount > carry.carried + 0.005) return { error: `Only Rs ${carry.carried.toFixed(2)} is left in the drawer.` };
    const id = Number(db.query("INSERT INTO cash_collections (close_id, amount, note, user_id) VALUES (?, ?, ?, ?)").run(carry.close.id, amount, note, user.id).lastInsertRowid);
    // A request to open on a count made before this no longer compares with what is left.
    db.query("UPDATE cash_open_requests SET status = 'superseded' WHERE prev_close_id = ? AND status IN ('pending', 'approved')").run(carry.close.id);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cash_collected', ?)").run(
      user.id, JSON.stringify({ collection_id: id, close_id: carry.close.id, amount, note, left: money(carry.carried - amount) })
    );
    return { id };
  }).immediate();
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ success: true, id: out.id, carry: carriedForAdmin() });
});

// A collection recorded by mistake is voided (kept, marked), before the next opening.
cash.post("/collections/:id/void", adminOnly, async (c) => {
  const user = getUser(c)!;
  const db = getDb();
  const id = Number(c.req.param("id"));
  const out = db.transaction(() => {
    const row = db.query("SELECT * FROM cash_collections WHERE id = ?").get(id) as any;
    if (!row) return { error: "That collection was not found" };
    if (row.voided_at) return { error: "That collection was already removed." };
    if (getCurrentOpenShift() || getLatestClose()?.id !== row.close_id) return { error: "The drawer has been opened since; that collection can no longer be changed." };
    db.query("UPDATE cash_collections SET voided_by = ?, voided_at = datetime('now') WHERE id = ?").run(user.id, id);
    db.query("UPDATE cash_open_requests SET status = 'superseded' WHERE prev_close_id = ? AND status IN ('pending', 'approved')").run(row.close_id);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cash_collection_voided', ?)").run(user.id, JSON.stringify({ collection_id: id, amount: row.amount }));
    return {};
  }).immediate();
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ success: true, carry: carriedForAdmin() });
});

/** The admin's view of the drawer between shifts: the close, what was collected, what is left. */
function carriedForAdmin() {
  const carry = carriedOver();
  if (!carry || getCurrentOpenShift()) return null;
  return {
    close_id: carry.close.id,
    close_total: Number(carry.close.total_amount) || 0,
    closed_at: carry.close.created_at,
    closed_by: carry.close.user_name,
    holder: closeHolder(carry.close),
    collected: carry.collected,
    carried: carry.carried,
    collections: collectionsFor(carry.close.id),
  };
}

// --- Stock sync (gate 1 of closing) -----------------------------------------

// What to count: names and units, never the system's figures. Each item's
// token lets the submit tell whether its figure moved while it was being
// counted, without the till being able to read the figure (itemToken()).
cash.get("/stock-sync/items", (c) => {
  if (!getCurrentOpenShift()) return c.json({ error: "No open shift." }, 400);
  return c.json(listSyncItems().map(({ system_qty, ...rest }) => ({ ...rest, token: itemToken(rest.kind, rest.id, system_qty) })));
});

// Submit a count. Body: { counts: [{ kind, id, counted }], admin_username?, admin_password? }
cash.post("/stock-sync", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => ({} as any));
  const open = getCurrentOpenShift();
  if (!open) return c.json({ error: "No open shift to sync stock for." }, 400);
  try {
    // An admin's password at the till also lets the count through (a takeover
    // from an absent holder starts with one).
    const approver = await resolveApprover(user, body);
    // The stock is counted by whoever answers for it: a shortage this count
    // finds is charged to the holder. Read AFTER the password check, which
    // awaits — the drawer may have changed hands meanwhile.
    const openNow = getCurrentOpenShift();
    if (!openNow || openNow.id !== open.id) return c.json({ error: "The shift has just been closed." }, 409);
    const holder = drawerHolder(openNow)!;
    if (user.role !== "admin" && holder.id !== user.id && !approver) {
      return c.json({ error: `${holder.name} holds the drawer, so they count the stock for it.` }, 400);
    }
    const sync = submitStockSync({ shiftOpenId: open.id, user, approver, counts: body.counts, holderId: holder.id, chargeBody: body });
    return c.json({ success: true, sync: syncForViewer(sync, user.role === "admin" || !!approver) });
  } catch (err: any) {
    return closingError(c, err);
  }
});

// An admin at the till (password typed in) looks at a waiting sync with the
// system's figures, to correct and approve it there. Body: admin credentials.
cash.post("/stock-sync/:id/admin-view", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => ({} as any));
  try {
    const approver = await resolveApprover(user, body);
    if (!approver) return c.json({ error: "An admin username and password are needed." }, 400);
    const sync = getStockSync(Number(c.req.param("id")));
    if (!sync) return c.json({ error: "That stock sync was not found" }, 404);
    return c.json({ sync: withShortage(sync) });
  } catch (err: any) {
    return closingError(c, err);
  }
});

// Approve or reject a waiting sync: the admin's own login, or their password at
// the till. Approve body: { corrections?: [{ line_id, approved_qty }], note? }.
// Reject body: { note } (required).
for (const action of ["approve", "reject"] as const) {
  cash.post(`/stock-sync/:id/${action}`, async (c) => {
    const user = getUser(c)!;
    const body = await c.req.json().catch(() => ({} as any));
    try {
      const approver = await resolveApprover(user, body);
      if (!approver) return c.json({ error: "Only an admin can approve or reject a stock sync." }, 403);
      const sync = decideStockSync({
        syncId: Number(c.req.param("id")),
        approver,
        approve: action === "approve",
        note: body.note,
        corrections: body.corrections,
        shiftOpenId: getCurrentOpenShift()?.id ?? null,
        // { charge, charge_amount?, write_off_note? } — see readChargeDecision.
        chargeBody: body,
      });
      return c.json({ success: true, sync });
    } catch (err: any) {
      return closingError(c, err);
    }
  });
}

// --- Close (needs gate 1, and gate 2 when the variance is over the limit) ----
//
// Body: the drawer count, as before. Or { close_request_id } to close on a
// request an admin approved — that request's own count is used, so the
// cashier never retypes it. admin_username / admin_password let an admin
// approve an over-limit variance right at the till.
cash.post("/close", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json();
  const db = getDb();
  const date = todayDate();

  const openRow = getCurrentOpenShift();
  if (!openRow) return c.json({ error: "No open shift to close." }, 400);

  // Only the person who answers for the drawer closes it (or an admin, who
  // then decides about any shortage for them). A handover still in flight is
  // finished or cancelled first.
  const holder = drawerHolder(openRow)!;
  if (user.role !== "admin" && holder.id !== user.id) {
    return c.json({ error: `${holder.name} holds the drawer, so only they (or an admin) can close it. Ask them to close it, or to hand it over to you.` }, 400);
  }
  const inFlight = pendingHandover(openRow.id);
  if (inFlight) {
    return c.json({ error: `The drawer handover to ${inFlight.to_name} is not finished. It has to be accepted, declined or cancelled before closing.` }, 400);
  }

  const pending = getPendingExpenseCountSince(openRow.created_at);
  if (pending > 0) {
    return c.json({ error: `${pending} expense${pending > 1 ? "s" : ""} pending approval. Admin must approve or reject before closing.` }, 400);
  }
  // A refund still waiting would move the drawer's expected cash after it was
  // counted — decide it first, exactly as with a pending expense.
  const refundsWaiting = pendingRefundCount();
  if (refundsWaiting > 0) {
    return c.json({ error: `${refundsWaiting} cash refund${refundsWaiting > 1 ? "s are" : " is"} waiting for an admin. Approve or reject ${refundsWaiting > 1 ? "them" : "it"} (or withdraw the request) before closing.` }, 400);
  }
  // A waste report still waiting would change the stock after it was synced
  // (and the goods are already gone) — decided first, like the rest.
  const wasteWaiting = pendingDisposalCount();
  if (wasteWaiting > 0) {
    return c.json({ error: `${wasteWaiting} waste report${wasteWaiting > 1 ? "s are" : " is"} waiting for an admin. ${wasteWaiting > 1 ? "They have" : "It has"} to be approved or rejected before closing.` }, 400);
  }

  // Gate 1: the shift's stock has to be synced, and nothing moved since.
  const syncState = holderSyncState(openRow);
  if (!syncState.valid) {
    const s = syncState.sync;
    const msg = syncState.stale
      ? (syncState.stale_reason === "listed"
          ? "The count list has changed since the stock was synced (an item was ticked for the daily sync, or came into stock). Sync the stock again before closing."
          : syncState.stale_reason === "holder"
            ? "The stock was last counted for the previous holder of the drawer. Count it again before closing."
            : "Stock has changed since it was synced (a sale, a delivery or an opened box). Sync the stock again before closing.")
      : s?.status === "pending"
        ? "The stock sync is waiting for an admin to approve it. The drawer can close once it is approved."
        : s?.status === "rejected"
          ? `The stock sync was rejected${s.decision_note ? ` (${s.decision_note})` : ""}. Count the stock again before closing.`
          : "Sync the stock before closing the drawer.";
    return c.json({ error: msg, needs_stock_sync: true }, 400);
  }

  let approver: Approver | null;
  try {
    approver = await resolveApprover(user, body);
  } catch (err: any) {
    return closingError(c, err);
  }

  const { expected, breakdown } = expectedFor(openRow);
  const limit = varianceLimit();

  // Closing on an approved request: its count, and only if nothing has moved
  // the expected figure since the admin saw it.
  let count: ReturnType<typeof parseCount>;
  let notes: string | null = body.notes || null;
  let requestId: number | null = null;
  let varianceApprovedBy: number | null = null;
  // The shortage decision: from the approved request, or (an admin closing it,
  // or their password at the till) from this body. readChargeDecision().
  let decisionBody: any = body;
  if (body.close_request_id != null) {
    const req = db.query("SELECT * FROM cash_close_requests WHERE id = ?").get(Number(body.close_request_id)) as any;
    if (!req || req.shift_open_id !== openRow.id) return c.json({ error: "That close request is not for this shift." }, 400);
    if (req.status !== "approved") return c.json({ error: `That close request is ${req.status}, not approved.` }, 400);
    if (Math.abs(money(req.expected_amount) - expected) > 0.005) {
      return c.json({ error: "Cash has come in or gone out since the admin approved this. Count the drawer again." }, 409);
    }
    count = parseCount(JSON.parse(req.count_json));
    notes = req.notes;
    requestId = req.id;
    varianceApprovedBy = req.decided_by;
    decisionBody = { charge: req.charge_decision !== "write_off", write_off_note: req.charge_note, charge_amount: req.charge_amount };
  } else {
    count = parseCount(body);
  }
  if (typeof count === "string") return c.json({ error: count }, 400);

  const counted = computeTotal(count);
  const variance = money(counted - expected);

  // What happens to a SHORTAGE (variance < 0). Over the limit: the admin's
  // decision (charge to the holder, the default, or write off). Within it:
  // charged only when settings.charge_small_shortages is on — the limit is a
  // tolerance otherwise. An over count is never credited.
  const short = variance < -0.005 ? money(-variance) : 0;
  let charge: { charge: boolean; amount: number; note: string | null } = { charge: false, amount: 0, note: null };
  if (short > 0) {
    if (overLimit(variance, limit)) {
      // Nothing is charged by default: an approver closing it here says which.
      // (Without an approver the close is refused below with needs_approval.)
      if (!requestId && approver && chargeUndecided(decisionBody)) {
        return c.json(chargeDecisionNeeded(short, holder), 409);
      }
      const d = readChargeDecision(decisionBody, short, short);
      if (typeof d === "string") return c.json({ error: d }, 400);
      charge = d;
    } else if (chargeSmallShortages()) {
      charge = { charge: true, amount: short, note: "Within the allowed variance; charged by the shop's setting" };
    }
  }

  // Gate 2: over the limit either way needs an admin. An admin closing it, or
  // their password typed at the till, is that approval; otherwise the till is
  // told to ask (POST /close-requests).
  if (overLimit(variance, limit) && !requestId) {
    if (!approver) {
      return c.json({
        error: `The drawer is ${variance > 0 ? "over" : "short"} by ${Math.abs(variance).toFixed(2)}, more than the ${limit.toFixed(2)} allowed. An admin has to approve this close.`,
        needs_approval: true,
        variance,
        expected_amount: expected,
        total_amount: counted,
        limit,
      }, 409);
    }
    varianceApprovedBy = approver.id;
  }

  const n = count.notes;
  let closeId: number;
  try {
    closeId = db.transaction(() => {
    // Everything above was read outside this lock, and the admin password check
    // awaited in between — long enough for a second close, a sale or a change
    // of heart to land. So the facts the close rests on are checked again here,
    // under the write lock: still this shift open, stock still synced, money
    // still as expected, and the request (if any) still approved and unused.
    if (getCurrentOpenShift()?.id !== openRow.id) throw new ClosingError("This shift has just been closed.", 409);
    // Handed over, or a handover started, while the password was checked.
    if (pendingHandover(openRow.id)) throw new ClosingError("A drawer handover started. Finish or cancel it before closing.", 409);
    if (drawerHolder(getCurrentOpenShift())!.id !== holder.id) throw new ClosingError("The drawer has just changed hands. Look again before closing.", 409);
    // A cash refund asked for while the password above was being checked.
    if (pendingRefundCount() > 0) throw new ClosingError("A cash refund is waiting for an admin. It must be approved or rejected before closing.", 400);
    if (!holderSyncState(openRow).valid) {
      throw new ClosingError("Stock changed while closing (a sale or a delivery). Sync the stock again.", 400, { needs_stock_sync: true });
    }
    if (Math.abs(expectedFor(openRow).expected - expected) > 0.005) {
      throw new ClosingError("Cash came in or went out while closing. Count the drawer again.", 409);
    }
    if (requestId) {
      const used = db.query("UPDATE cash_close_requests SET status = 'used' WHERE id = ? AND status = 'approved'").run(requestId);
      if (Number(used.changes || 0) !== 1) throw new ClosingError("That approval has already been used.", 409);
    }
    const id = Number(db.query(`
      INSERT INTO cash_counts (count_type, count_date, user_id, notes_20, notes_50, notes_100, notes_500, notes_1000, notes_2000, notes_5000, coins_total, total_amount, expected_amount, variance, notes, variance_approved_by, stock_sync_id, holder_user_id)
      VALUES ('close', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      date, user.id,
      n.notes_20, n.notes_50, n.notes_100, n.notes_500, n.notes_1000, n.notes_2000, n.notes_5000,
      count.coins_total, counted, expected, variance, notes, varianceApprovedBy, syncState.sync?.id ?? null,
      // On a close row: who held the drawer as it closed — the one answering
      // for what is left in it until the next opening (cash collection).
      holder.id
    ).lastInsertRowid);
    if (requestId) db.query("UPDATE cash_close_requests SET used_close_id = ? WHERE id = ?").run(id, requestId);
    // The holder's pending account: the shortage, as decided.
    if (charge.charge && charge.amount > 0) {
      addLedgerEntry({
        userId: holder.id, kind: "cash_short", amount: charge.amount, sourceType: "close", sourceId: id,
        note: `Drawer short at close (${date})${charge.note ? ` — ${charge.note}` : ""}`,
        createdBy: varianceApprovedBy ?? approver?.id ?? user.id,
      });
      db.query("UPDATE cash_counts SET charged_amount = ?, charged_to = ? WHERE id = ?").run(charge.amount, holder.id, id);
    } else if (short > 0 && !charge.charge && charge.note) {
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cash_short_written_off', ?)").run(
        varianceApprovedBy ?? approver?.id ?? user.id, JSON.stringify({ close_id: id, short, holder: holder.id, note: charge.note })
      );
    }
    // Anything still waiting on this shift is moot now.
    db.query("UPDATE cash_close_requests SET status = 'superseded' WHERE shift_open_id = ? AND status IN ('pending', 'approved')").run(openRow.id);
    if (varianceApprovedBy && overLimit(variance, limit)) {
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cash_variance_approved', ?)").run(
        varianceApprovedBy, JSON.stringify({ close_id: id, variance, limit, closed_by: user.id, close_request_id: requestId, at_till: !!approver?.at_till && !requestId })
      );
    }
    return id;
    }).immediate();
  } catch (err: any) {
    return closingError(c, err);
  }

  // The breakdown comes back so the close screen can show WHY expected is what
  // it is. expected_amount / variance keep their existing meaning and are the
  // only figures stored on the cash_counts row.
  return c.json({
    success: true,
    id: closeId,
    total_amount: counted,
    coins_total: count.coins_total,
    expected_amount: expected,
    variance,
    breakdown,
  });
});

// --- Close requests (gate 2: variance over the limit) ------------------------

// The cashier asks an admin to approve closing on this count. Body: the count.
cash.post("/close-requests", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => ({} as any));
  const db = getDb();
  const openRow = getCurrentOpenShift();
  if (!openRow) return c.json({ error: "No open shift to close." }, 400);
  const holder = drawerHolder(openRow)!;
  if (user.role !== "admin" && holder.id !== user.id) {
    return c.json({ error: `${holder.name} holds the drawer, so only they can ask to close it.` }, 400);
  }
  if (pendingHandover(openRow.id)) return c.json({ error: "A drawer handover is not finished. Settle it before closing." }, 400);
  const count = parseCount(body);
  if (typeof count === "string") return c.json({ error: count }, 400);
  const { expected } = expectedFor(openRow);
  const counted = computeTotal(count);
  const variance = money(counted - expected);
  const limit = varianceLimit();
  if (!overLimit(variance, limit)) {
    return c.json({ error: `The variance (${variance.toFixed(2)}) is within the ${limit.toFixed(2)} allowed — no approval is needed, just close.` }, 400);
  }
  const request = db.transaction(() => {
    db.query("UPDATE cash_close_requests SET status = 'superseded' WHERE shift_open_id = ? AND status IN ('pending', 'approved')").run(openRow.id);
    const id = Number(db.query(`
      INSERT INTO cash_close_requests (shift_open_id, user_id, count_json, total_amount, expected_amount, variance, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(openRow.id, user.id, JSON.stringify({ ...count.notes, coins_total: count.coins_total }), counted, expected, variance, body.notes || null).lastInsertRowid);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cash_close_requested', ?)").run(
      user.id, JSON.stringify({ close_request_id: id, variance, expected, counted, limit })
    );
    return latestCloseRequest(openRow.id);
  }).immediate();
  return c.json({ success: true, request });
});

// An admin decides. Approving does not close the drawer — the cashier closes on
// it (POST /close with close_request_id). Reject needs a reason.
for (const action of ["approve", "reject"] as const) {
  cash.post(`/close-requests/:id/${action}`, async (c) => {
    const user = getUser(c)!;
    const body = await c.req.json().catch(() => ({} as any));
    const db = getDb();
    let approver: Approver | null;
    try {
      approver = await resolveApprover(user, body);
    } catch (err: any) {
      return closingError(c, err);
    }
    if (!approver) return c.json({ error: "Only an admin can approve or reject a close." }, 403);
    const note = String(body.note ?? "").trim() || null;
    if (action === "reject" && !note) return c.json({ error: "Say why it is rejected, so the drawer can be counted again properly." }, 400);
    const id = Number(c.req.param("id"));
    const openRow = getCurrentOpenShift();
    const result = db.transaction(() => {
      const req = db.query("SELECT * FROM cash_close_requests WHERE id = ?").get(id) as any;
      if (!req) return { status: 404 as const, error: "That close request was not found" };
      if (req.status !== "pending") return { status: 400 as const, error: `That close request is already ${req.status}.` };
      if (!openRow || req.shift_open_id !== openRow.id) return { status: 400 as const, error: "That close request belongs to a shift that is no longer open." };
      // Approving a SHORTAGE: charge it to the holder (default) or write it
      // off. The close that uses this approval carries it out.
      let chargeDecision: string | null = null;
      let chargeNote: string | null = null;
      let chargeAmount: number | null = null;
      if (action === "approve" && Number(req.variance) < -0.005) {
        if (chargeUndecided(body)) return { status: 409 as const, error: "", needs: -Number(req.variance) };
        const d = readChargeDecision(body, -Number(req.variance), -Number(req.variance));
        if (typeof d === "string") return { status: 400 as const, error: d };
        chargeDecision = d.charge ? "charge" : "write_off";
        chargeNote = d.note;
        chargeAmount = d.charge ? d.amount : null;
      }
      db.query(`UPDATE cash_close_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ?, charge_decision = ?, charge_note = ?, charge_amount = ? WHERE id = ?`)
        .run(action === "approve" ? "approved" : "rejected", approver!.id, note, chargeDecision, chargeNote, chargeAmount, id);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)").run(
        approver!.id, action === "approve" ? "cash_close_approved" : "cash_close_rejected",
        JSON.stringify({ close_request_id: id, variance: req.variance, note, at_till: approver!.at_till })
      );
      return { request: latestCloseRequest(req.shift_open_id) };
    }).immediate();
    if ("needs" in result) return c.json(chargeDecisionNeeded(Number(result.needs), openRow ? drawerHolder(openRow) : null), 409);
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({ success: true, request: result.request });
  });
}

// --- Drawer handover -----------------------------------------------------------
//
// The holder passes the drawer to someone else mid-shift:
//   1. the giver syncs the stock (charged to them if short), counts the cash and
//      names the receiver (POST /handovers). Cash payments pause for everyone.
//   2. the receiver counts the cash blind and accepts (POST /handovers/:id/accept)
//      — or declines with a reason. The giver (or an admin) can cancel while
//      it waits.
//   3. the receiver's count against what the drawer should hold is the
//      giver's variance. Within the limit: accepted at once. Over it: an admin
//      approves (charging a shortage to the GIVER, or writing it off) or
//      rejects (the giver keeps the drawer and counts again).
// From acceptance, the receiver holds the drawer and the close counts from the
// receiver's figure (expectedFor's handover adjustment).
//
// An admin can also TAKE OVER a drawer whose holder is not there
// (POST /handovers/takeover): they sync the stock and count, and the shortage
// is the absent holder's, decided as at a close.

/**
 * Why the drawer cannot change hands right now, or null. Everything that would
 * move the drawer's figures after the count is settled first — as for a close
 * — and the stock must have been counted for the current holder since they
 * took the drawer, or a loss on their watch would pass to the next person.
 */
function handoverBlockReason(open: any, takeover = false): string | null {
  // An earlier day's shift is closed, not handed on — but an admin may take it
  // over from a holder who forgot it, so someone can close it (or carry on
  // with enforce_cash_shift off).
  if (!takeover && open.count_date !== todayDate()) return `This shift is from ${open.count_date}. Close it instead of handing it over.`;
  if (pendingHandover(open.id)) return "A handover of this drawer is already waiting.";
  const exp = getPendingExpenseCountSince(open.created_at);
  if (exp > 0) return `${exp} expense${exp > 1 ? "s are" : " is"} waiting for an admin. Settle ${exp > 1 ? "them" : "it"} before handing over.`;
  const ref = pendingRefundCount();
  if (ref > 0) return `${ref} cash refund${ref > 1 ? "s are" : " is"} waiting for an admin. Settle ${ref > 1 ? "them" : "it"} before handing over.`;
  const waste = pendingDisposalCount();
  if (waste > 0) return `${waste} waste report${waste > 1 ? "s are" : " is"} waiting for an admin. Settle ${waste > 1 ? "them" : "it"} before handing over.`;
  // The count has to be this holder's (holderSyncState).
  const state = holderSyncState(open);
  if (state.sync?.status === "pending") return "The stock count is waiting for an admin. Hand over once it is approved.";
  if (!state.valid) {
    return state.stale && state.stale_reason !== "holder"
      ? "Stock has changed since it was counted. Sync the stock again, then hand over."
      : "Sync the stock first — the next person takes the drawer and the stock as they are now.";
  }
  return null;
}

/**
 * stockSyncState, but a count only stands for the holder it was made for:
 * counted while they held the drawer, after they took it. Otherwise a loss on
 * the new holder's watch would close on the previous holder's count (nothing
 * moved on the books, so it would still look "valid"). stale_reason 'holder'
 * tells the till to count again for that reason.
 */
function holderSyncState(open: any) {
  const state = stockSyncState(open.id);
  const s = state.sync;
  if (!s || s.status === "pending" || s.status === "rejected") return state;
  const holderId = drawerHolder(open)!.id;
  const lastChange = lastAcceptedHandover(open.id);
  const mine = (s.holder_user_id ?? s.user_id) === holderId && s.id > Number(lastChange?.stock_sync_id || 0);
  if (mine) return state;
  return { ...state, valid: false, stale: true, stale_reason: "holder" as const };
}

/** An active user by id, or null. */
function activeUser(id: number): { id: number; full_name: string; role: string } | null {
  return getDb().query("SELECT id, full_name, role FROM users WHERE id = ? AND is_active = 1").get(id) as any;
}

/** A handover with both names, for the routes below. */
function getHandover(id: number): any {
  return getDb().query(`
    SELECT h.*, f.full_name AS from_name, t.full_name AS to_name, d.full_name AS decided_by_name FROM drawer_handovers h
    LEFT JOIN users f ON f.id = h.from_user_id LEFT JOIN users t ON t.id = h.to_user_id LEFT JOIN users d ON d.id = h.decided_by
    WHERE h.id = ?
  `).get(id) as any;
}

/**
 * Pass the drawer to the handover's receiver: the open row's holder, and the
 * moment (accepted_at) the drawer's figures count from again. Inside the
 * caller's transaction.
 */
function completeHandover(h: any, openId: number) {
  const db = getDb();
  db.query("UPDATE drawer_handovers SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?").run(h.id);
  db.query("UPDATE cash_counts SET holder_user_id = ? WHERE id = ?").run(h.to_user_id, openId);
}

/** A cash shortage at a handover, charged to the giver. Inside the caller's transaction. */
function chargeHandoverShort(h: any, amount: number, note: string | null, createdBy: number) {
  addLedgerEntry({
    userId: h.from_user_id, kind: "cash_short", amount, sourceType: "handover", sourceId: h.id,
    note: `Drawer short when ${h.kind === "takeover" ? "taken over" : `handed to ${h.to_name || "the next holder"}`}${note ? ` — ${note}` : ""}`,
    createdBy,
  });
  getDb().query("UPDATE drawer_handovers SET charge_amount = ? WHERE id = ?").run(amount, h.id);
}

// Who the drawer can be handed to: every other active user.
cash.get("/handovers/candidates", (c) => {
  const user = getUser(c)!;
  return c.json(getDb().query("SELECT id, full_name, role FROM users WHERE is_active = 1 AND id != ? ORDER BY full_name").all(user.id));
});

// Handovers waiting on me (the receiver), any shift — for the badge and banner.
cash.get("/handovers/incoming", (c) => {
  const user = getUser(c)!;
  const rows = getDb().query(`
    SELECT h.*, f.full_name AS from_name, t.full_name AS to_name FROM drawer_handovers h
    LEFT JOIN users f ON f.id = h.from_user_id LEFT JOIN users t ON t.id = h.to_user_id
    WHERE h.to_user_id = ? AND h.status = 'pending' ORDER BY h.id
  `).all(user.id) as any[];
  return c.json(rows.map((h) => handoverForViewer(h, user)));
});

// Recent handovers of the open shift (everyone sees who and when; counts per handoverForViewer).
cash.get("/handovers", (c) => {
  const user = getUser(c)!;
  const open = getCurrentOpenShift();
  if (!open) return c.json([]);
  const rows = getDb().query(`
    SELECT h.*, f.full_name AS from_name, t.full_name AS to_name, d.full_name AS decided_by_name FROM drawer_handovers h
    LEFT JOIN users f ON f.id = h.from_user_id LEFT JOIN users t ON t.id = h.to_user_id LEFT JOIN users d ON d.id = h.decided_by
    WHERE h.shift_open_id = ? ORDER BY h.id DESC LIMIT 20
  `).all(open.id) as any[];
  return c.json(rows.map((h) => handoverForViewer(h, user)));
});

// The holder starts a handover. Body: the drawer count, to_user_id, notes?
cash.post("/handovers", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => ({} as any));
  const db = getDb();
  const open = getCurrentOpenShift();
  if (!open) return c.json({ error: "No open shift to hand over." }, 400);
  const holder = drawerHolder(open)!;
  if (holder.id !== user.id) {
    return c.json({ error: user.role === "admin"
      ? `${holder.name} holds the drawer. To take it from them while they are away, use Take over.`
      : `${holder.name} holds the drawer, so only they can hand it over.` }, 400);
  }
  const to = activeUser(Number(body.to_user_id));
  if (!to) return c.json({ error: "Choose who takes the drawer." }, 400);
  if (to.id === user.id) return c.json({ error: "You already hold the drawer." }, 400);
  const count = parseCount(body);
  if (typeof count === "string") return c.json({ error: count }, 400);
  const counted = computeTotal(count);
  try {
    const handover = db.transaction(() => {
      const why = handoverBlockReason(open);
      if (why) throw new ClosingError(why, 400);
      if (drawerHolder(getCurrentOpenShift())?.id !== user.id) throw new ClosingError("The drawer has just changed hands.", 409);
      const { expected } = expectedFor(open);
      const syncId = stockSyncState(open.id).sync!.id;
      // A close waiting on (or approved by) an admin was for this holder's count; it no longer stands.
      db.query("UPDATE cash_close_requests SET status = 'superseded' WHERE shift_open_id = ? AND status IN ('pending', 'approved')").run(open.id);
      const id = Number(db.query(`
        INSERT INTO drawer_handovers (shift_open_id, kind, from_user_id, to_user_id, status, giver_count_json, giver_total, giver_expected, giver_notes, stock_sync_id)
        VALUES (?, 'handover', ?, ?, 'pending', ?, ?, ?, ?, ?)
      `).run(open.id, user.id, to.id, JSON.stringify({ ...count.notes, coins_total: count.coins_total }), counted, expected,
        String(body.notes ?? "").trim() || null, syncId).lastInsertRowid);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'drawer_handover_started', ?)").run(
        user.id, JSON.stringify({ handover_id: id, to_user_id: to.id, counted, expected })
      );
      return getHandover(id);
    }).immediate();
    return c.json({ success: true, handover: handoverForViewer(handover, user) });
  } catch (err: any) {
    return closingError(c, err);
  }
});

// The giver (or an admin) calls a waiting handover off. Cash payments resume.
cash.post("/handovers/:id/cancel", async (c) => {
  const user = getUser(c)!;
  const db = getDb();
  const h = getHandover(Number(c.req.param("id")));
  if (!h) return c.json({ error: "That handover was not found" }, 404);
  if (h.from_user_id !== user.id && user.role !== "admin") return c.json({ error: "Only the person handing over (or an admin) can cancel it." }, 400);
  const res = db.query("UPDATE drawer_handovers SET status = 'cancelled', answered_at = datetime('now') WHERE id = ? AND status = 'pending'").run(h.id);
  if (Number(res.changes || 0) !== 1) return c.json({ error: `That handover is already ${h.status === "awaiting_admin" ? "waiting for an admin" : h.status}.` }, 400);
  db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'drawer_handover_cancelled', ?)").run(user.id, JSON.stringify({ handover_id: h.id }));
  return c.json({ success: true });
});

// The receiver turns it down. Body: { reason }. The giver keeps the drawer.
cash.post("/handovers/:id/decline", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => ({} as any));
  const db = getDb();
  const reason = String(body.reason ?? "").trim();
  if (!reason) return c.json({ error: "Say why, so the giver knows what to put right." }, 400);
  const h = getHandover(Number(c.req.param("id")));
  if (!h) return c.json({ error: "That handover was not found" }, 404);
  if (h.to_user_id !== user.id) return c.json({ error: "Only the person it is handed to can decline it." }, 400);
  const res = db.query("UPDATE drawer_handovers SET status = 'declined', answered_at = datetime('now'), decline_reason = ? WHERE id = ? AND status = 'pending'").run(reason, h.id);
  if (Number(res.changes || 0) !== 1) return c.json({ error: `That handover is already ${h.status}.` }, 400);
  db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'drawer_handover_declined', ?)").run(user.id, JSON.stringify({ handover_id: h.id, reason }));
  return c.json({ success: true });
});

// The receiver counts (blind) and accepts. Body: the drawer count, notes?
cash.post("/handovers/:id/accept", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => ({} as any));
  const db = getDb();
  const count = parseCount(body);
  if (typeof count === "string") return c.json({ error: count }, 400);
  const counted = computeTotal(count);
  const id = Number(c.req.param("id"));
  try {
    const out = db.transaction(() => {
      const h = getHandover(id);
      if (!h) throw new ClosingError("That handover was not found", 404);
      if (h.to_user_id !== user.id) throw new ClosingError("Only the person it is handed to can accept it.", 400);
      if (h.status !== "pending") throw new ClosingError(`That handover is already ${h.status === "awaiting_admin" ? "waiting for an admin" : h.status}.`, 400);
      const open = getCurrentOpenShift();
      if (!open || open.id !== h.shift_open_id) throw new ClosingError("That handover's shift is no longer open.", 400);
      if (drawerHolder(open)!.id !== h.from_user_id) throw new ClosingError("The drawer has changed hands since this was asked.", 409);
      if (!activeUser(user.id)) throw new ClosingError("Your account is not active.", 400);
      // Cash was paused, so this is normally what the giver saw.
      const { expected } = expectedFor(open);
      const variance = money(counted - expected);
      const limit = varianceLimit();
      db.query(`
        UPDATE drawer_handovers SET receiver_count_json = ?, receiver_total = ?, receiver_expected = ?, variance = ?, receiver_notes = ?, answered_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify({ ...count.notes, coins_total: count.coins_total }), counted, expected, variance, String(body.notes ?? "").trim() || null, id);
      if (overLimit(variance, limit)) {
        db.query("UPDATE drawer_handovers SET status = 'awaiting_admin' WHERE id = ?").run(id);
        db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'drawer_handover_needs_admin', ?)").run(
          user.id, JSON.stringify({ handover_id: id, counted, expected, variance, limit })
        );
        return { accepted: false, variance };
      }
      // Within the limit: a shortage is the giver's only if the shop charges small ones.
      if (variance < -0.005 && chargeSmallShortages()) {
        chargeHandoverShort(h, -variance, "within the allowed variance; charged by the shop's setting", user.id);
        db.query("UPDATE drawer_handovers SET decision = 'charge' WHERE id = ?").run(id);
      }
      completeHandover(h, open.id);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'drawer_handover_accepted', ?)").run(
        user.id, JSON.stringify({ handover_id: id, from_user_id: h.from_user_id, counted, expected, variance })
      );
      return { accepted: true, variance };
    }).immediate();
    const h = getHandover(id);
    // No variance back to the receiver (see handoverForViewer); an admin sees it.
    return c.json({ success: true, accepted: out.accepted, ...(user.role === "admin" ? { variance: out.variance } : {}), handover: handoverForViewer(h, user) });
  } catch (err: any) {
    return closingError(c, err);
  }
});

// An admin decides a handover whose count was off by more than the limit.
// Approve body: { charge?, charge_amount?, write_off_note? } (a shortage is the
// giver's — readChargeDecision). Reject body: { note } — the giver keeps the
// drawer and counts again.
for (const action of ["approve", "reject"] as const) {
  cash.post(`/handovers/:id/${action}`, async (c) => {
    const user = getUser(c)!;
    const body = await c.req.json().catch(() => ({} as any));
    const db = getDb();
    let approver: Approver | null;
    try {
      approver = await resolveApprover(user, body);
    } catch (err: any) {
      return closingError(c, err);
    }
    if (!approver) return c.json({ error: "Only an admin can decide a handover." }, 403);
    const note = String(body.note ?? "").trim() || null;
    if (action === "reject" && !note) return c.json({ error: "Say why it is rejected, so the drawer can be counted again." }, 400);
    const id = Number(c.req.param("id"));
    try {
      db.transaction(() => {
        const h = getHandover(id);
        if (!h) throw new ClosingError("That handover was not found", 404);
        if (h.status !== "awaiting_admin") throw new ClosingError(`That handover is ${h.status}, not waiting for an admin.`, 400);
        const open = getCurrentOpenShift();
        if (!open || open.id !== h.shift_open_id) throw new ClosingError("That handover's shift is no longer open.", 400);
        if (action === "reject") {
          db.query("UPDATE drawer_handovers SET status = 'declined', decline_reason = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?")
            .run(`Rejected by an admin: ${note}`, approver!.id, id);
        } else {
          const short = Number(h.variance) < -0.005 ? money(-Number(h.variance)) : 0;
          if (short > 0) {
            if (chargeUndecided(body)) {
              const { error, ...extra } = chargeDecisionNeeded(short, { id: h.from_user_id, name: h.from_name });
              throw new ClosingError(error, 409, extra);
            }
            const d = readChargeDecision(body, short, short);
            if (typeof d === "string") throw new ClosingError(d, 400);
            if (d.charge && d.amount > 0) chargeHandoverShort(h, d.amount, d.note, approver!.id);
            db.query("UPDATE drawer_handovers SET decision = ?, decision_note = ? WHERE id = ?").run(d.charge ? "charge" : "write_off", d.note, id);
          }
          db.query("UPDATE drawer_handovers SET decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(approver!.id, id);
          completeHandover(h, open.id);
        }
        db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)").run(
          approver!.id, action === "approve" ? "drawer_handover_approved" : "drawer_handover_rejected",
          JSON.stringify({ handover_id: id, variance: h.variance, note, at_till: approver!.at_till })
        );
      }).immediate();
      return c.json({ success: true, handover: getHandover(id) });
    } catch (err: any) {
      return closingError(c, err);
    }
  });
}

// An admin takes the drawer from a holder who is not there. Body: the drawer
// count, reason, to_user_id? (who holds it next; default the admin), and for a
// shortage over the limit the charge decision (the absent holder's). The stock
// is synced first, as for a handover. Admin login, or their password at the till.
cash.post("/handovers/takeover", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => ({} as any));
  const db = getDb();
  let approver: Approver | null;
  try {
    approver = await resolveApprover(user, body);
  } catch (err: any) {
    return closingError(c, err);
  }
  if (!approver) return c.json({ error: "Only an admin can take over the drawer." }, 403);
  const reason = String(body.reason ?? "").trim();
  if (!reason) return c.json({ error: "Say why the drawer is taken over (e.g. the holder went home)." }, 400);
  const open = getCurrentOpenShift();
  if (!open) return c.json({ error: "No open shift." }, 400);
  const prev = drawerHolder(open)!;
  const to = activeUser(body.to_user_id != null && body.to_user_id !== "" ? Number(body.to_user_id) : approver.id);
  if (!to) return c.json({ error: "Choose who holds the drawer next." }, 400);
  if (to.id === prev.id) return c.json({ error: `${prev.name} already holds the drawer.` }, 400);
  const count = parseCount(body);
  if (typeof count === "string") return c.json({ error: count }, 400);
  const counted = computeTotal(count);
  try {
    const out = db.transaction(() => {
      const why = handoverBlockReason(open, true);
      if (why) throw new ClosingError(why, 400);
      if (drawerHolder(getCurrentOpenShift())!.id !== prev.id) throw new ClosingError("The drawer has just changed hands.", 409);
      const { expected } = expectedFor(open);
      const variance = money(counted - expected);
      const limit = varianceLimit();
      const short = variance < -0.005 ? money(-variance) : 0;
      let decision: { charge: boolean; amount: number; note: string | null } | null = null;
      if (short > 0) {
        if (overLimit(variance, limit)) {
          // Decided on the server's figure: the page's may be out of date.
          if (chargeUndecided(body)) {
            const { error, ...extra } = chargeDecisionNeeded(short, prev);
            throw new ClosingError(error, 409, extra);
          }
          const d = readChargeDecision(body, short, short);
          if (typeof d === "string") throw new ClosingError(d, 400);
          decision = d;
        } else if (chargeSmallShortages()) {
          decision = { charge: true, amount: short, note: "within the allowed variance; charged by the shop's setting" };
        }
      }
      db.query("UPDATE cash_close_requests SET status = 'superseded' WHERE shift_open_id = ? AND status IN ('pending', 'approved')").run(open.id);
      const id = Number(db.query(`
        INSERT INTO drawer_handovers (shift_open_id, kind, from_user_id, to_user_id, status, giver_notes, stock_sync_id,
          receiver_count_json, receiver_total, receiver_expected, variance, receiver_notes, answered_at, decided_by, decided_at, decision, decision_note)
        VALUES (?, 'takeover', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, datetime('now'), ?, ?)
      `).run(open.id, prev.id, to.id, reason, stockSyncState(open.id).sync!.id,
        JSON.stringify({ ...count.notes, coins_total: count.coins_total }), counted, expected, variance, String(body.notes ?? "").trim() || null,
        approver!.id, decision ? (decision.charge ? "charge" : "write_off") : null, decision?.note ?? null).lastInsertRowid);
      const h = getHandover(id);
      if (decision?.charge && decision.amount > 0) chargeHandoverShort(h, decision.amount, decision.note, approver!.id);
      completeHandover(h, open.id);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'drawer_taken_over', ?)").run(
        approver!.id, JSON.stringify({ handover_id: id, from_user_id: prev.id, to_user_id: to.id, counted, expected, variance, reason, at_till: approver!.at_till })
      );
      return { id, variance };
    }).immediate();
    return c.json({ success: true, variance: out.variance, handover: getHandover(out.id) });
  } catch (err: any) {
    return closingError(c, err);
  }
});

// --- Pending accounts (what a cashier owes for charged shortages) ---------------

// My own account: balance and history. Everyone sees their own.
cash.get("/accounts/me", (c) => {
  const user = getUser(c)!;
  return c.json({ user_id: user.id, balance: ledgerBalance(user.id), entries: ledgerEntries(user.id, 100) });
});

// Every user's balance (admin).
cash.get("/accounts", adminOnly, (c) => c.json(allBalances()));

// One user's account (admin).
cash.get("/accounts/:userId", adminOnly, (c) => {
  const id = Number(c.req.param("userId"));
  const u = getDb().query("SELECT id, full_name, username, role, is_active FROM users WHERE id = ?").get(id) as any;
  if (!u) return c.json({ error: "That user was not found" }, 404);
  return c.json({ user: u, balance: ledgerBalance(id), entries: ledgerEntries(id, 200) });
});

// The admin records a payment, a write-off or a charge by hand.
// Body: { kind: 'payment' | 'write_off' | 'charge', amount, note }. A write-off
// or a charge needs a note; nothing is ever edited or deleted.
cash.post("/accounts/:userId/entries", adminOnly, async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => ({} as any));
  const id = Number(c.req.param("userId"));
  if (!getDb().query("SELECT 1 FROM users WHERE id = ?").get(id)) return c.json({ error: "That user was not found" }, 404);
  const kind = String(body.kind ?? "") as LedgerKind;
  if (!["payment", "write_off", "charge"].includes(kind)) return c.json({ error: "Choose a payment, a write-off or a charge." }, 400);
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return c.json({ error: "Enter an amount above 0." }, 400);
  const note = String(body.note ?? "").trim() || null;
  if (kind !== "payment" && !note) return c.json({ error: kind === "charge" ? "Say what the charge is for." : "Say why it is written off." }, 400);
  // Overages are never credited, so neither is an over-payment: a payment or
  // write-off is at most what is owed, or it would quietly soak up the next
  // shortage.
  const out = getDb().transaction(() => {
    const owed = ledgerBalance(id);
    if (kind !== "charge" && amount > owed + 0.005) {
      return { error: owed > 0 ? `Only Rs ${owed.toFixed(2)} is owed.` : "Nothing is owed on this account." };
    }
    return { id: addLedgerEntry({ userId: id, kind, amount, sourceType: "manual", note, createdBy: user.id }) };
  }).immediate();
  if ("error" in out) return c.json({ error: out.error }, 400);
  return c.json({ success: true, id: out.id, balance: ledgerBalance(id) });
});

// --- The admin's queue -------------------------------------------------------

// Everything waiting on an admin for the open shift: a stock sync with
// mismatches (with the system's figures, to judge it) and a close request.
cash.get("/approvals", adminOnly, (c) => {
  const db = getDb();
  // Refunds wait on the admin whether or not a shift is open (a bill can be
  // refunded any time), so they are listed either way.
  const refund_requests = db.query(`
    SELECT r.*, u.full_name AS user_name, b.token_number, b.total, b.payment_method, b.bill_date, b.cart_id
    FROM refund_requests r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN bills b ON b.id = r.bill_id
    WHERE r.status = 'pending' ORDER BY r.id
  `).all();
  const open = getCurrentOpenShift();
  // Opening requests wait while no shift is open.
  const lastClose = getLatestClose();
  const open_requests = !open && lastClose
    ? db.query(`
        SELECT r.*, u.full_name AS user_name FROM cash_open_requests r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.prev_close_id = ? AND r.status = 'pending' ORDER BY r.id
      `).all(lastClose.id).map((r: any) => ({ ...r, closer: closeHolder(lastClose), expected_now: carriedOver()?.carried ?? null }))
    : [];
  if (!open) return c.json({ stock_syncs: [], close_requests: [], handovers: [], open_requests, refund_requests, shift: null });
  const syncIds = db.query("SELECT id FROM stock_syncs WHERE shift_open_id = ? AND status = 'pending' ORDER BY id").all(open.id) as any[];
  const closeRequests = db.query(`
    SELECT r.*, u.full_name AS user_name FROM cash_close_requests r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.shift_open_id = ? AND r.status = 'pending' ORDER BY r.id
  `).all(open.id) as any[];
  const handoverIds = db.query("SELECT id FROM drawer_handovers WHERE shift_open_id = ? AND status = 'awaiting_admin' ORDER BY id").all(open.id) as any[];
  const holder = drawerHolder(open);
  return c.json({
    shift: { id: open.id, opened_at: open.created_at, opened_by: open.user_name, holder },
    stock_syncs: syncIds.map((r) => withShortage(getStockSync(r.id))),
    // A close's shortage is the holder's.
    close_requests: closeRequests.map((r) => ({ ...r, expected_now: expectedFor(open).expected, charge_to: holder })),
    // A handover's shortage is the giver's.
    handovers: handoverIds.map((r) => getHandover(r.id)),
    refund_requests,
  });
});

// The sidebar badge: how many things are waiting on an admin.
cash.get("/approvals/count", adminOnly, (c) => {
  const open = getCurrentOpenShift();
  const db = getDb();
  const row = db.query(`
    SELECT (SELECT COUNT(*) FROM stock_syncs WHERE shift_open_id = ?1 AND status = 'pending')
         + (SELECT COUNT(*) FROM cash_close_requests WHERE shift_open_id = ?1 AND status = 'pending')
         + (SELECT COUNT(*) FROM drawer_handovers WHERE shift_open_id = ?1 AND status = 'awaiting_admin')
         + (CASE WHEN ?1 = -1 THEN (SELECT COUNT(*) FROM cash_open_requests WHERE status = 'pending'
              AND prev_close_id = (SELECT id FROM cash_counts WHERE count_type = 'close' ORDER BY created_at DESC, id DESC LIMIT 1)) ELSE 0 END)
         + (SELECT COUNT(*) FROM refund_requests WHERE status = 'pending') AS count
  `).get(open?.id ?? -1) as any;
  return c.json({ count: row?.count || 0 });
});

/**
 * CASH refunds waiting on an admin — they would take money out of the drawer
 * after it was counted, so any of them blocks closing (POST /close). Card and
 * LankaQR refunds never touch the drawer and do not hold the close up.
 */
function pendingRefundCount(): number {
  const row = getDb().query(`
    SELECT COUNT(*) AS n FROM refund_requests r JOIN bills b ON b.id = r.bill_id
    WHERE r.status = 'pending' AND b.payment_method = 'cash'
  `).get() as any;
  return row?.n ?? 0;
}

cash.get("/history", (c) => {
  const db = getDb();
  const limit = parseInt(c.req.query("limit") || "30");
  const rows = db.query(`
    SELECT cc.*, u.full_name as user_name, a.full_name as variance_approved_by_name,
      (SELECT COALESCE(SUM(cl.amount), 0) FROM cash_collections cl WHERE cl.close_id = cc.id AND cl.voided_at IS NULL) AS collected
    FROM cash_counts cc
    LEFT JOIN users u ON cc.user_id = u.id
    LEFT JOIN users a ON cc.variance_approved_by = a.id
    ORDER BY count_date DESC, created_at DESC
    LIMIT ?
  `).all(limit) as any[];
  // Counted figures, differences and collections are for admins: a cashier may
  // be the next opener, who counts blind.
  const user = getUser(c)!;
  if (user.role === "admin") return c.json(rows);
  return c.json(rows.map((r) => ({
    id: r.id, count_type: r.count_type, count_date: r.count_date, created_at: r.created_at,
    user_name: r.user_name, variance_approved_by_name: r.variance_approved_by_name,
  })));
});

export default cash;
