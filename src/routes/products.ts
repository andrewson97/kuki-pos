import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly } from "../middleware/auth";

const products = new Hono();

products.get("/", (c) => {
  const db = getDb();
  const all = db.query("SELECT * FROM products ORDER BY name").all();
  return c.json(all);
});

products.get("/active", (c) => {
  const db = getDb();
  const all = db.query("SELECT * FROM products WHERE is_active = 1 ORDER BY category, name").all();
  return c.json(all);
});

products.get("/:id", (c) => {
  const db = getDb();
  const product = db.query("SELECT * FROM products WHERE id = ?").get(c.req.param("id"));
  if (!product) return c.json({ error: "Not found" }, 404);
  return c.json(product);
});

products.post("/", adminOnly, async (c) => {
  const { name, category, cost_price, selling_price, is_active } = await c.req.json();
  const db = getDb();
  const result = db.query(
    "INSERT INTO products (name, category, cost_price, selling_price, is_active) VALUES (?, ?, ?, ?, ?)"
  ).run(name, category || "General", cost_price || 0, selling_price, is_active ?? 1);
  return c.json({ id: Number(result.lastInsertRowid), name, category, cost_price, selling_price });
});

products.put("/:id", adminOnly, async (c) => {
  const id = c.req.param("id");
  const { name, category, cost_price, selling_price, is_active } = await c.req.json();
  const db = getDb();
  db.query(
    "UPDATE products SET name = ?, category = ?, cost_price = ?, selling_price = ?, is_active = ? WHERE id = ?"
  ).run(name, category, cost_price || 0, selling_price, is_active, id);
  return c.json({ success: true });
});

products.delete("/:id", adminOnly, (c) => {
  const db = getDb();
  const id = c.req.param("id");
  try {
    db.query("DELETE FROM products WHERE id = ?").run(id);
    return c.json({ success: true });
  } catch (err: any) {
    if (String(err?.message || "").includes("FOREIGN KEY")) {
      db.query("UPDATE products SET is_active = 0 WHERE id = ?").run(id);
      return c.json({ success: true, soft_deleted: true });
    }
    return c.json({ error: err?.message || "Delete failed" }, 500);
  }
});

export default products;
