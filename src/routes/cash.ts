import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly, getUser } from "../middleware/auth";
import {
  ClosingError, decideStockSync, getStockSync, itemToken, listSyncItems, resolveApprover, stockSyncState, submitStockSync,
  type Approver,
} from "../services/closing";
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
    "SELECT cc.*, u.full_name as user_name FROM cash_counts cc LEFT JOIN users u ON cc.user_id = u.id WHERE count_type = 'open' ORDER BY created_at DESC LIMIT 1"
  ).get() as any;
  if (!latestOpen) return null;
  const latestClose = db.query(
    "SELECT created_at FROM cash_counts WHERE count_type = 'close' ORDER BY created_at DESC LIMIT 1"
  ).get() as { created_at: string } | null;
  if (latestClose && new Date(latestClose.created_at).getTime() >= new Date(latestOpen.created_at).getTime()) {
    return null;
  }
  return latestOpen;
}

// Latest close across all dates (regardless of state). Used for status display.
function getLatestClose() {
  const db = getDb();
  return db.query(
    "SELECT cc.*, u.full_name as user_name FROM cash_counts cc LEFT JOIN users u ON cc.user_id = u.id WHERE count_type = 'close' ORDER BY created_at DESC LIMIT 1"
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

/**
 * What the drawer should hold right now for the open shift, and every part of
 * it. The ONE formula: GET /today shows it, POST /close stores it, and a close
 * request is checked against it — so the three can never quote different
 * figures.
 */
function expectedFor(openRow: any) {
  const since = openRow.created_at;
  const opening = openRow.total_amount || 0;
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
    opening + cashSales - cashRefunds - cashExpenses + depositsTaken - depositsApplied - depositsRefunded
  );
  return {
    expected,
    breakdown: {
      opening,
      cash_sales: cashSales,
      cash_refunds: cashRefunds,
      cash_expenses: cashExpenses,
      deposits_taken: depositsTaken,
      deposits_applied: depositsApplied,
      deposits_refunded: depositsRefunded,
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

  // Sales/refunds/expenses since the active shift started, or since the last
  // close if no shift is open (to show a zeroed-out summary).
  const since = open ? open.created_at : (close?.created_at || `${date} 00:00:00`);
  const cash_sales = getCashSalesSince(since);
  const cash_refunds = getCashRefundsSince(since);
  const cash_expenses = getCashExpensesSince(since);
  // Pre-order deposits: cash in the drawer that is not a sale (+), and the part
  // of today's cash bills that was already paid as a deposit earlier (-). See
  // the two helpers above; the close below applies exactly these figures.
  const deposits_taken = getDepositsTakenSince(since);
  const deposits_applied = getDepositsAppliedSince(since);
  // Cash deposits handed back on cancelled pre-orders (-). Not an expense.
  const deposits_refunded = getDepositsRefundedSince(since);
  const pending_expenses = open ? getPendingExpenseCountSince(open.created_at) : 0;

  // What a close right now would expect to find in the drawer: expectedFor(),
  // the same figure POST /close stores. cash.html and m-cash.html show it as-is
  // and work the variance out from it.
  const expected_now = open ? expectedFor(open).expected : 0;

  // Surface whether the open shift is from a prior day (cashier must close it
  // before starting fresh today).
  const open_date = open?.count_date ?? null;
  const shift_from_prior_day = !!open && open_date !== date;

  // The two closing gates (src/services/closing.ts): where this shift's stock
  // sync stands, and any close request waiting on (or approved by) an admin.
  const syncState = open ? stockSyncState(open.id) : null;
  const close_request = open ? latestCloseRequest(open.id) ?? null : null;

  return c.json({
    date,
    open,
    close,
    shift_open,
    shift_from_prior_day,
    cash_sales,
    cash_refunds,
    cash_expenses,
    deposits_taken,
    deposits_applied,
    deposits_refunded,
    expected_now,
    pending_expenses,
    // Refunds waiting on an admin: they block the close like pending expenses.
    pending_refunds: open ? pendingRefundCount() : 0,
    variance_limit: varianceLimit(),
    stock_sync: syncState
      ? { valid: syncState.valid, stale: syncState.stale, sync: syncForViewer(syncState.sync, user.role === "admin") }
      : null,
    close_request,
  });
});

cash.post("/open", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json();
  const db = getDb();
  const date = todayDate();

  if (getCurrentOpenShift()) {
    return c.json({ error: "A shift is already open (possibly from a previous day). Close it before starting a new one." }, 400);
  }

  const count = parseCount(body);
  if (typeof count === "string") return c.json({ error: count }, 400);
  const n = count.notes;
  const total = computeTotal(count);
  db.query(`
    INSERT INTO cash_counts (count_type, count_date, user_id, notes_20, notes_50, notes_100, notes_500, notes_1000, notes_2000, notes_5000, coins_total, total_amount, notes)
    VALUES ('open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    date, user.id,
    n.notes_20, n.notes_50, n.notes_100, n.notes_500, n.notes_1000, n.notes_2000, n.notes_5000,
    count.coins_total, total, body.notes || null
  );
  return c.json({ success: true, total_amount: total, coins_total: count.coins_total });
});

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
    const approver = await resolveApprover(user, body);
    const sync = submitStockSync({ shiftOpenId: open.id, user, approver, counts: body.counts });
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
    return c.json({ sync });
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

  const pending = getPendingExpenseCountSince(openRow.created_at);
  if (pending > 0) {
    return c.json({ error: `${pending} expense${pending > 1 ? "s" : ""} pending approval. Admin must approve or reject before closing.` }, 400);
  }
  // A refund still waiting would move the drawer's expected cash after it was
  // counted — decide it first, exactly as with a pending expense.
  const refundsWaiting = pendingRefundCount();
  if (refundsWaiting > 0) {
    return c.json({ error: `${refundsWaiting} refund${refundsWaiting > 1 ? "s are" : " is"} waiting for an admin. They must be approved or rejected before closing.` }, 400);
  }

  // Gate 1: the shift's stock has to be synced, and nothing moved since.
  const syncState = stockSyncState(openRow.id);
  if (!syncState.valid) {
    const s = syncState.sync;
    const msg = syncState.stale
      ? "Stock has changed since it was synced (a sale, a delivery or an opened box). Sync the stock again before closing."
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
  } else {
    count = parseCount(body);
  }
  if (typeof count === "string") return c.json({ error: count }, 400);

  const counted = computeTotal(count);
  const variance = money(counted - expected);

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
    if (!stockSyncState(openRow.id).valid) {
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
      INSERT INTO cash_counts (count_type, count_date, user_id, notes_20, notes_50, notes_100, notes_500, notes_1000, notes_2000, notes_5000, coins_total, total_amount, expected_amount, variance, notes, variance_approved_by, stock_sync_id)
      VALUES ('close', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      date, user.id,
      n.notes_20, n.notes_50, n.notes_100, n.notes_500, n.notes_1000, n.notes_2000, n.notes_5000,
      count.coins_total, counted, expected, variance, notes, varianceApprovedBy, syncState.sync?.id ?? null
    ).lastInsertRowid);
    if (requestId) db.query("UPDATE cash_close_requests SET used_close_id = ? WHERE id = ?").run(id, requestId);
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
      db.query(`UPDATE cash_close_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?`)
        .run(action === "approve" ? "approved" : "rejected", approver!.id, note, id);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)").run(
        approver!.id, action === "approve" ? "cash_close_approved" : "cash_close_rejected",
        JSON.stringify({ close_request_id: id, variance: req.variance, note, at_till: approver!.at_till })
      );
      return { request: latestCloseRequest(req.shift_open_id) };
    }).immediate();
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({ success: true, request: result.request });
  });
}

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
  if (!open) return c.json({ stock_syncs: [], close_requests: [], refund_requests, shift: null });
  const syncIds = db.query("SELECT id FROM stock_syncs WHERE shift_open_id = ? AND status = 'pending' ORDER BY id").all(open.id) as any[];
  const closeRequests = db.query(`
    SELECT r.*, u.full_name AS user_name FROM cash_close_requests r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.shift_open_id = ? AND r.status = 'pending' ORDER BY r.id
  `).all(open.id) as any[];
  return c.json({
    shift: { id: open.id, opened_at: open.created_at, opened_by: open.user_name },
    stock_syncs: syncIds.map((r) => getStockSync(r.id)),
    close_requests: closeRequests.map((r) => ({ ...r, expected_now: expectedFor(open).expected })),
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
         + (SELECT COUNT(*) FROM refund_requests WHERE status = 'pending') AS count
  `).get(open?.id ?? -1) as any;
  return c.json({ count: row?.count || 0 });
});

/** Refunds waiting on an admin. Any of them blocks closing: see POST /close. */
function pendingRefundCount(): number {
  const row = getDb().query("SELECT COUNT(*) AS n FROM refund_requests WHERE status = 'pending'").get() as any;
  return row?.n ?? 0;
}

cash.get("/history", (c) => {
  const db = getDb();
  const limit = parseInt(c.req.query("limit") || "30");
  const rows = db.query(`
    SELECT cc.*, u.full_name as user_name, a.full_name as variance_approved_by_name
    FROM cash_counts cc
    LEFT JOIN users u ON cc.user_id = u.id
    LEFT JOIN users a ON cc.variance_approved_by = a.id
    ORDER BY count_date DESC, created_at DESC
    LIMIT ?
  `).all(limit);
  return c.json(rows);
});

export default cash;
