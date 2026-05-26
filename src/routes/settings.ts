import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly } from "../middleware/auth";
import type { SessionUser } from "../middleware/auth";

const settings = new Hono();

settings.get("/", (c) => {
  const db = getDb();
  const rows = db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return c.json(result);
});

settings.put("/", adminOnly, async (c) => {
  const updates = await c.req.json();
  const db = getDb();
  for (const [key, value] of Object.entries(updates)) {
    db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
  }
  return c.json({ success: true });
});

// User management (admin only)
settings.get("/users", adminOnly, (c) => {
  const db = getDb();
  return c.json(db.query("SELECT id, username, full_name, role, is_active, created_at FROM users ORDER BY id").all());
});

settings.post("/users", adminOnly, async (c) => {
  const { username, password, full_name, role } = await c.req.json();
  const db = getDb();
  const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
  const result = db.query(
    "INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)"
  ).run(username, hash, full_name, role || "cashier");
  return c.json({ id: Number(result.lastInsertRowid) });
});

settings.put("/users/:id", adminOnly, async (c) => {
  const id = c.req.param("id");
  const { full_name, role, is_active, password } = await c.req.json();
  const db = getDb();
  db.query("UPDATE users SET full_name = ?, role = ?, is_active = ? WHERE id = ?").run(
    full_name, role, is_active, id
  );
  if (password) {
    const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);
  }
  return c.json({ success: true });
});

settings.get("/activity-log", adminOnly, (c) => {
  const db = getDb();
  const limit = parseInt(c.req.query("limit") || "100");
  return c.json(
    db.query(`
      SELECT al.*, u.full_name as user_name
      FROM activity_log al
      LEFT JOIN users u ON al.user_id = u.id
      ORDER BY al.created_at DESC
      LIMIT ?
    `).all(limit)
  );
});

// Backup - download database
settings.get("/backup", adminOnly, (c) => {
  const db = getDb();
  const file = Bun.file("data/shop.db");
  return new Response(file, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="shop-backup-${new Date().toISOString().split("T")[0]}.db"`,
    },
  });
});

export default settings;
