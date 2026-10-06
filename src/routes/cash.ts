import { Hono } from "hono";
import { getDb } from "../db/database";
import { getUser } from "../middleware/auth";
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

cash.get("/today", (c) => {
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
  const pending_expenses = open ? getPendingExpenseCountSince(open.created_at) : 0;

  // What a close right now would expect to find in the drawer. Returned so the
  // close screen can show the running figure and its parts without having to
  // re-derive the formula in the browser.
  //
  // This is THE expected figure for the live close screen: cash.html and
  // m-cash.html show it as-is and work the variance out from it, so the screen
  // can never again quote a different "expected" from the one the close stores
  // (they used to re-add the parts in the browser and leave the deposits out).
  const expected_now = open
    ? money((open.total_amount || 0) + cash_sales - cash_refunds - cash_expenses + deposits_taken - deposits_applied)
    : 0;

  // Surface whether the open shift is from a prior day (cashier must close it
  // before starting fresh today).
  const open_date = open?.count_date ?? null;
  const shift_from_prior_day = !!open && open_date !== date;

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
    expected_now,
    pending_expenses,
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

cash.post("/close", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json();
  const db = getDb();
  const date = todayDate();

  const openRow = getCurrentOpenShift();
  if (!openRow) return c.json({ error: "No open shift to close." }, 400);

  const count = parseCount(body);
  if (typeof count === "string") return c.json({ error: count }, 400);

  const since = openRow.created_at;
  const pending = getPendingExpenseCountSince(since);
  if (pending > 0) {
    return c.json({ error: `${pending} expense${pending > 1 ? "s" : ""} pending approval. Admin must approve or reject before closing.` }, 400);
  }

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
  // Rounded to the cent, as are counted and variance, so the stored figures are
  // exactly the ones the close screen shows and an exact count stores 0.
  const expected = money(opening + cashSales - cashRefunds - cashExpenses + depositsTaken - depositsApplied);
  const counted = computeTotal(count);
  const variance = money(counted - expected);
  const n = count.notes;

  db.query(`
    INSERT INTO cash_counts (count_type, count_date, user_id, notes_20, notes_50, notes_100, notes_500, notes_1000, notes_2000, notes_5000, coins_total, total_amount, expected_amount, variance, notes)
    VALUES ('close', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    date, user.id,
    n.notes_20, n.notes_50, n.notes_100, n.notes_500, n.notes_1000, n.notes_2000, n.notes_5000,
    count.coins_total, counted, expected, variance, body.notes || null
  );
  // The breakdown comes back so the close screen can show WHY expected is what
  // it is. expected_amount / variance keep their existing meaning and are the
  // only figures stored on the cash_counts row.
  return c.json({
    success: true,
    total_amount: counted,
    coins_total: count.coins_total,
    expected_amount: expected,
    variance,
    breakdown: {
      opening,
      cash_sales: cashSales,
      cash_refunds: cashRefunds,
      cash_expenses: cashExpenses,
      deposits_taken: depositsTaken,
      deposits_applied: depositsApplied,
    },
  });
});

cash.get("/history", (c) => {
  const db = getDb();
  const limit = parseInt(c.req.query("limit") || "30");
  const rows = db.query(`
    SELECT cc.*, u.full_name as user_name
    FROM cash_counts cc
    LEFT JOIN users u ON cc.user_id = u.id
    ORDER BY count_date DESC, created_at DESC
    LIMIT ?
  `).all(limit);
  return c.json(rows);
});

export default cash;
