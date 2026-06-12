import { Hono } from "hono";
import { getDb } from "../db/database";
import { getUser } from "../middleware/auth";
import { todayDate } from "../utils/helpers";

const cash = new Hono();

const DENOMINATIONS = [20, 50, 100, 500, 1000, 2000, 5000] as const;

function computeTotal(notes: Record<string, number>): number {
  return DENOMINATIONS.reduce((sum, d) => sum + (notes[`notes_${d}`] || 0) * d, 0);
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
  const pending_expenses = open ? getPendingExpenseCountSince(open.created_at) : 0;

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

  const total = computeTotal(body);
  db.query(`
    INSERT INTO cash_counts (count_type, count_date, user_id, notes_20, notes_50, notes_100, notes_500, notes_1000, notes_2000, notes_5000, total_amount, notes)
    VALUES ('open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    date, user.id,
    body.notes_20 || 0, body.notes_50 || 0, body.notes_100 || 0,
    body.notes_500 || 0, body.notes_1000 || 0, body.notes_2000 || 0, body.notes_5000 || 0,
    total, body.notes || null
  );
  return c.json({ success: true, total_amount: total });
});

cash.post("/close", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json();
  const db = getDb();
  const date = todayDate();

  const openRow = getCurrentOpenShift();
  if (!openRow) return c.json({ error: "No open shift to close." }, 400);

  const since = openRow.created_at;
  const pending = getPendingExpenseCountSince(since);
  if (pending > 0) {
    return c.json({ error: `${pending} expense${pending > 1 ? "s" : ""} pending approval. Admin must approve or reject before closing.` }, 400);
  }

  const opening = openRow.total_amount || 0;
  const cashSales = getCashSalesSince(since);
  const cashRefunds = getCashRefundsSince(since);
  const cashExpenses = getCashExpensesSince(since);
  const expected = opening + cashSales - cashRefunds - cashExpenses;
  const counted = computeTotal(body);
  const variance = counted - expected;

  db.query(`
    INSERT INTO cash_counts (count_type, count_date, user_id, notes_20, notes_50, notes_100, notes_500, notes_1000, notes_2000, notes_5000, total_amount, expected_amount, variance, notes)
    VALUES ('close', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    date, user.id,
    body.notes_20 || 0, body.notes_50 || 0, body.notes_100 || 0,
    body.notes_500 || 0, body.notes_1000 || 0, body.notes_2000 || 0, body.notes_5000 || 0,
    counted, expected, variance, body.notes || null
  );
  return c.json({ success: true, total_amount: counted, expected_amount: expected, variance });
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
