import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly, getUser } from "../middleware/auth";
import { todayDate } from "../utils/helpers";

const tasks = new Hono();

// List active tasks plus today's completion state (joined).
tasks.get("/", (c) => {
  const db = getDb();
  const today = todayDate();
  const rows = db.query(`
    SELECT t.*,
           c.id           AS completion_id,
           c.completed_at AS completed_at,
           c.user_id      AS completed_by_user_id,
           u.full_name    AS completed_by_name,
           c.notes        AS completion_notes
    FROM daily_tasks t
    LEFT JOIN daily_task_completions c
      ON c.task_id = t.id AND c.business_date = ?
    LEFT JOIN users u ON u.id = c.user_id
    WHERE t.is_active = 1
    ORDER BY CASE t.category WHEN 'opening' THEN 0 ELSE 1 END, t.display_order, t.id
  `).all(today);
  return c.json(rows);
});

// Admin: all tasks (including inactive) for management screen.
tasks.get("/all", adminOnly, (c) => {
  const db = getDb();
  const rows = db.query("SELECT * FROM daily_tasks ORDER BY CASE category WHEN 'opening' THEN 0 ELSE 1 END, display_order, id").all();
  return c.json(rows);
});

tasks.post("/", adminOnly, async (c) => {
  const { title, description, display_order, category } = await c.req.json();
  if (!title || !title.trim()) return c.json({ error: "Title is required" }, 400);
  const cat = category === "closing" ? "closing" : "opening";
  const db = getDb();
  const result = db.query(
    "INSERT INTO daily_tasks (title, description, display_order, category) VALUES (?, ?, ?, ?)"
  ).run(title.trim(), description?.trim() || null, display_order || 0, cat);
  return c.json({ id: Number(result.lastInsertRowid) });
});

tasks.put("/:id", adminOnly, async (c) => {
  const id = c.req.param("id");
  const { title, description, display_order, is_active, category } = await c.req.json();
  const cat = category === "closing" ? "closing" : "opening";
  const db = getDb();
  db.query(
    "UPDATE daily_tasks SET title = ?, description = ?, display_order = ?, is_active = ?, category = ? WHERE id = ?"
  ).run(title, description || null, display_order || 0, is_active ? 1 : 0, cat, id);
  return c.json({ success: true });
});

tasks.delete("/:id", adminOnly, (c) => {
  const db = getDb();
  db.query("DELETE FROM daily_tasks WHERE id = ?").run(c.req.param("id"));
  return c.json({ success: true });
});

// Mark today's completion. UNIQUE constraint prevents duplicates.
tasks.post("/:id/complete", async (c) => {
  const user = getUser(c)!;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();
  const today = todayDate();
  try {
    db.query(
      "INSERT INTO daily_task_completions (task_id, business_date, user_id, notes) VALUES (?, ?, ?, ?)"
    ).run(id, today, user.id, body.notes?.trim() || null);
  } catch (err: any) {
    if (String(err?.message || "").includes("UNIQUE")) {
      return c.json({ error: "Task already marked done for today" }, 400);
    }
    return c.json({ error: err?.message || "Failed to mark done" }, 500);
  }
  return c.json({ success: true });
});

// Un-mark today's completion (for fixing mistakes).
tasks.delete("/:id/complete", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const today = todayDate();
  db.query("DELETE FROM daily_task_completions WHERE task_id = ? AND business_date = ?").run(id, today);
  return c.json({ success: true });
});

// History — recent completions across all tasks (admin overview).
tasks.get("/history", adminOnly, (c) => {
  const db = getDb();
  const limit = parseInt(c.req.query("limit") || "100");
  const rows = db.query(`
    SELECT c.*, t.title AS task_title, u.full_name AS user_name
    FROM daily_task_completions c
    JOIN daily_tasks t ON t.id = c.task_id
    LEFT JOIN users u ON u.id = c.user_id
    ORDER BY c.business_date DESC, c.completed_at DESC
    LIMIT ?
  `).all(limit);
  return c.json(rows);
});

export default tasks;
