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

expenses.get("/", (c) => {
  const db = getDb();
  const startDate = c.req.query("start_date");
  const endDate = c.req.query("end_date");

  let query = `
    SELECT e.*, ec.name as category_name, u.full_name as user_name
    FROM expenses e
    LEFT JOIN expense_categories ec ON e.category_id = ec.id
    LEFT JOIN users u ON e.user_id = u.id
  `;
  const conditions: string[] = [];
  const params: any[] = [];

  if (startDate) { conditions.push("e.expense_date >= ?"); params.push(startDate); }
  if (endDate) { conditions.push("e.expense_date <= ?"); params.push(endDate); }

  if (conditions.length) query += " WHERE " + conditions.join(" AND ");
  query += " ORDER BY e.expense_date DESC, e.created_at DESC";

  return c.json(db.query(query).all(...params));
});

expenses.post("/", adminOnly, async (c) => {
  const { category_id, amount, description, expense_date } = await c.req.json();
  const user = getUser(c)!;
  const db = getDb();
  const result = db.query(
    "INSERT INTO expenses (category_id, amount, description, expense_date, user_id) VALUES (?, ?, ?, ?, ?)"
  ).run(category_id, amount, description || null, expense_date, user.id);
  return c.json({ id: Number(result.lastInsertRowid) });
});

expenses.delete("/:id", adminOnly, (c) => {
  const db = getDb();
  db.query("DELETE FROM expenses WHERE id = ?").run(c.req.param("id"));
  return c.json({ success: true });
});

export default expenses;
