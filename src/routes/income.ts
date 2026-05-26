import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly, getUser } from "../middleware/auth";

const income = new Hono();

income.get("/", (c) => {
  const db = getDb();
  const startDate = c.req.query("start_date");
  const endDate = c.req.query("end_date");

  let query = `
    SELECT i.*, u.full_name as user_name
    FROM income i
    LEFT JOIN users u ON i.user_id = u.id
  `;
  const conditions: string[] = [];
  const params: any[] = [];

  if (startDate) { conditions.push("i.income_date >= ?"); params.push(startDate); }
  if (endDate) { conditions.push("i.income_date <= ?"); params.push(endDate); }

  if (conditions.length) query += " WHERE " + conditions.join(" AND ");
  query += " ORDER BY i.income_date DESC, i.created_at DESC";

  return c.json(db.query(query).all(...params));
});

income.post("/", adminOnly, async (c) => {
  const { source, amount, description, income_date } = await c.req.json();
  const user = getUser(c)!;
  const db = getDb();
  const result = db.query(
    "INSERT INTO income (source, amount, description, income_date, user_id) VALUES (?, ?, ?, ?, ?)"
  ).run(source, amount, description || null, income_date, user.id);
  return c.json({ id: Number(result.lastInsertRowid) });
});

income.delete("/:id", adminOnly, (c) => {
  const db = getDb();
  db.query("DELETE FROM income WHERE id = ?").run(c.req.param("id"));
  return c.json({ success: true });
});

export default income;
