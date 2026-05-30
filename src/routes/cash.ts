import { Hono } from "hono";
import { getDb } from "../db/database";
import { getUser } from "../middleware/auth";
import { todayDate } from "../utils/helpers";

const cash = new Hono();

const DENOMINATIONS = [20, 50, 100, 500, 1000, 2000, 5000] as const;

function computeTotal(notes: Record<string, number>): number {
  return DENOMINATIONS.reduce((sum, d) => sum + (notes[`notes_${d}`] || 0) * d, 0);
}

function getCashSalesToday(date: string): number {
  const db = getDb();
  const row = db.query(`
    SELECT COALESCE(SUM(total), 0) as total
    FROM bills
    WHERE bill_date = ? AND payment_method = 'cash' AND status = 'completed'
  `).get(date) as { total: number };
  return row.total;
}

function getCashRefundsToday(date: string): number {
  const db = getDb();
  const row = db.query(`
    SELECT COALESCE(SUM(total), 0) as total
    FROM bills
    WHERE bill_date = ? AND payment_method = 'cash' AND status = 'refunded'
  `).get(date) as { total: number };
  return row.total;
}

function getCashExpensesToday(date: string): number {
  const db = getDb();
  const row = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM expenses
    WHERE expense_date = ? AND payment_source = 'cash' AND status = 'approved'
  `).get(date) as { total: number };
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
  const db = getDb();
  const date = todayDate();
  const open = db.query(
    "SELECT cc.*, u.full_name as user_name FROM cash_counts cc LEFT JOIN users u ON cc.user_id = u.id WHERE count_date = ? AND count_type = 'open' ORDER BY created_at DESC LIMIT 1"
  ).get(date);
  const close = db.query(
    "SELECT cc.*, u.full_name as user_name FROM cash_counts cc LEFT JOIN users u ON cc.user_id = u.id WHERE count_date = ? AND count_type = 'close' ORDER BY created_at DESC LIMIT 1"
  ).get(date);
  const cash_sales = getCashSalesToday(date);
  const cash_refunds = getCashRefundsToday(date);
  const cash_expenses = getCashExpensesToday(date);
  const pending_expenses = getPendingExpenseCountToday(date);
  return c.json({ date, open, close, cash_sales, cash_refunds, cash_expenses, pending_expenses });
});

cash.post("/open", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json();
  const db = getDb();
  const date = todayDate();

  const existing = db.query("SELECT id FROM cash_counts WHERE count_date = ? AND count_type = 'open'").get(date);
  if (existing) return c.json({ error: "Opening count already recorded today" }, 400);

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

  const existingClose = db.query("SELECT id FROM cash_counts WHERE count_date = ? AND count_type = 'close'").get(date);
  if (existingClose) return c.json({ error: "Closing count already recorded today" }, 400);

  const pending = getPendingExpenseCountToday(date);
  if (pending > 0) {
    return c.json({ error: `${pending} expense${pending > 1 ? "s" : ""} pending approval. Admin must approve or reject before closing.` }, 400);
  }

  const openRow = db.query("SELECT total_amount FROM cash_counts WHERE count_date = ? AND count_type = 'open'").get(date) as { total_amount: number } | null;
  const opening = openRow?.total_amount || 0;
  const cashSales = getCashSalesToday(date);
  const cashRefunds = getCashRefundsToday(date);
  const cashExpenses = getCashExpensesToday(date);
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
