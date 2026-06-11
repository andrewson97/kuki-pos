import { Hono } from "hono";
import { getDb } from "../db/database";
import { getUser } from "../middleware/auth";
import { todayDate } from "../utils/helpers";

const cash = new Hono();

const DENOMINATIONS = [20, 50, 100, 500, 1000, 2000, 5000] as const;

function computeTotal(notes: Record<string, number>): number {
  return DENOMINATIONS.reduce((sum, d) => sum + (notes[`notes_${d}`] || 0) * d, 0);
}

function getLatestOpen(date: string) {
  const db = getDb();
  return db.query(
    "SELECT cc.*, u.full_name as user_name FROM cash_counts cc LEFT JOIN users u ON cc.user_id = u.id WHERE count_date = ? AND count_type = 'open' ORDER BY created_at DESC LIMIT 1"
  ).get(date) as any;
}

function getLatestClose(date: string) {
  const db = getDb();
  return db.query(
    "SELECT cc.*, u.full_name as user_name FROM cash_counts cc LEFT JOIN users u ON cc.user_id = u.id WHERE count_date = ? AND count_type = 'close' ORDER BY created_at DESC LIMIT 1"
  ).get(date) as any;
}

// A shift is currently OPEN when the latest open is more recent than the latest close (or no close exists).
function isShiftOpen(date: string): boolean {
  const open = getLatestOpen(date);
  if (!open) return false;
  const close = getLatestClose(date);
  if (!close) return true;
  return new Date(open.created_at).getTime() > new Date(close.created_at).getTime();
}

function getCashSalesSince(date: string, since: string): number {
  const db = getDb();
  // Count cash received at the point of sale, regardless of later status.
  // Refunds are subtracted separately via getCashRefundsSince — counting cash
  // received here only by status='completed' double-counts the refund and shows
  // a phantom surplus in the closing variance.
  const row = db.query(`
    SELECT COALESCE(SUM(total), 0) as total
    FROM bills
    WHERE bill_date = ? AND payment_method = 'cash' AND status IN ('completed', 'refunded') AND created_at >= ?
  `).get(date, since) as { total: number };
  return row.total;
}

function getCashRefundsSince(date: string, since: string): number {
  const db = getDb();
  const row = db.query(`
    SELECT COALESCE(SUM(total), 0) as total
    FROM bills
    WHERE bill_date = ? AND payment_method = 'cash' AND status = 'refunded' AND refunded_at >= ?
  `).get(date, since) as { total: number };
  return row.total;
}

function getCashExpensesSince(date: string, since: string): number {
  const db = getDb();
  const row = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM expenses
    WHERE expense_date = ? AND payment_source = 'cash' AND status = 'approved' AND created_at >= ?
  `).get(date, since) as { total: number };
  return row.total;
}

function getPendingExpenseCountToday(date: string): number {
  const db = getDb();
  const row = db.query(
    "SELECT COUNT(*) as count FROM expenses WHERE expense_date = ? AND status = 'pending'"
  ).get(date) as { count: number };
  return row.count;
}

cash.get("/today", (c) => {
  const date = todayDate();
  const open = getLatestOpen(date);
  const close = getLatestClose(date);
  const shift_open = isShiftOpen(date);

  // Sales/refunds/expenses since the current shift started (or 00:00 today if none).
  const since = shift_open ? open.created_at : (close?.created_at || `${date} 00:00:00`);
  const cash_sales = getCashSalesSince(date, since);
  const cash_refunds = getCashRefundsSince(date, since);
  const cash_expenses = getCashExpensesSince(date, since);
  const pending_expenses = getPendingExpenseCountToday(date);

  return c.json({ date, open, close, shift_open, cash_sales, cash_refunds, cash_expenses, pending_expenses });
});

cash.post("/open", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json();
  const db = getDb();
  const date = todayDate();

  if (isShiftOpen(date)) return c.json({ error: "A shift is already open. Close it before starting a new one." }, 400);

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

  if (!isShiftOpen(date)) return c.json({ error: "No open shift to close." }, 400);

  const pending = getPendingExpenseCountToday(date);
  if (pending > 0) {
    return c.json({ error: `${pending} expense${pending > 1 ? "s" : ""} pending approval. Admin must approve or reject before closing.` }, 400);
  }

  const openRow = getLatestOpen(date);
  const opening = openRow?.total_amount || 0;
  const since = openRow.created_at;
  const cashSales = getCashSalesSince(date, since);
  const cashRefunds = getCashRefundsSince(date, since);
  const cashExpenses = getCashExpensesSince(date, since);
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
