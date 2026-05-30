import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly, getUser } from "../middleware/auth";

const expenses = new Hono();

expenses.get("/categories", (c) => {
  const db = getDb();
  return c.json(db.query("SELECT * FROM expense_categories ORDER BY name").all());
});

expenses.post("/categories", adminOnly, async (c) => {
  const { name } = await c.req.json();
  const db = getDb();
  const result = db.query("INSERT INTO expense_categories (name) VALUES (?)").run(name);
  return c.json({ id: Number(result.lastInsertRowid), name });
});

expenses.get("/pending-count", (c) => {
  const db = getDb();
  const row = db.query("SELECT COUNT(*) as count FROM expenses WHERE status = 'pending'").get() as any;
  return c.json({ count: row.count });
});

expenses.get("/", (c) => {
  const db = getDb();
  const startDate = c.req.query("start_date");
  const endDate = c.req.query("end_date");
  const status = c.req.query("status");

  let query = `
    SELECT e.*, ec.name as category_name, u.full_name as user_name, a.full_name as approver_name
    FROM expenses e
    LEFT JOIN expense_categories ec ON e.category_id = ec.id
    LEFT JOIN users u ON e.user_id = u.id
    LEFT JOIN users a ON e.approved_by_user_id = a.id
  `;
  const conditions: string[] = [];
  const params: any[] = [];

  if (startDate) { conditions.push("e.expense_date >= ?"); params.push(startDate); }
  if (endDate) { conditions.push("e.expense_date <= ?"); params.push(endDate); }
  if (status) { conditions.push("e.status = ?"); params.push(status); }

  if (conditions.length) query += " WHERE " + conditions.join(" AND ");
  query += " ORDER BY e.expense_date DESC, e.created_at DESC";

  return c.json(db.query(query).all(...params));
});

expenses.post("/", async (c) => {
  const { category_id, amount, description, expense_date, payment_source } = await c.req.json();
  const user = getUser(c)!;
  const db = getDb();
  // Admins' submissions are auto-approved; cashiers' need approval
  const isAdmin = user.role === "admin";
  const status = isAdmin ? "approved" : "pending";
  const approvedBy = isAdmin ? user.id : null;
  const approvedAt = isAdmin ? new Date().toISOString() : null;
  const result = db.query(
    "INSERT INTO expenses (category_id, amount, description, expense_date, user_id, payment_source, status, approved_by_user_id, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(category_id, amount, description || null, expense_date, user.id, payment_source || "cash", status, approvedBy, approvedAt);
  return c.json({ id: Number(result.lastInsertRowid), status });
});

expenses.post("/:id/approve", adminOnly, (c) => {
  const user = getUser(c)!;
  const db = getDb();
  const id = c.req.param("id");
  const row = db.query("SELECT status FROM expenses WHERE id = ?").get(id) as any;
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status !== "pending") return c.json({ error: "Already " + row.status }, 400);
  db.query(
    "UPDATE expenses SET status = 'approved', approved_by_user_id = ?, approved_at = datetime('now'), rejected_reason = NULL WHERE id = ?"
  ).run(user.id, id);
  return c.json({ success: true });
});

expenses.post("/:id/reject", adminOnly, async (c) => {
  const user = getUser(c)!;
  const db = getDb();
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const reason = (body.reason || "").trim() || "No reason given";
  const row = db.query("SELECT status FROM expenses WHERE id = ?").get(id) as any;
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status !== "pending") return c.json({ error: "Already " + row.status }, 400);
  db.query(
    "UPDATE expenses SET status = 'rejected', approved_by_user_id = ?, approved_at = datetime('now'), rejected_reason = ? WHERE id = ?"
  ).run(user.id, reason, id);
  return c.json({ success: true });
});

expenses.delete("/:id", adminOnly, (c) => {
  const db = getDb();
  db.query("DELETE FROM expenses WHERE id = ?").run(c.req.param("id"));
  return c.json({ success: true });
});

export default expenses;
