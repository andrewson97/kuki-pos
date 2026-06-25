import { Hono } from "hono";
import path from "path";
import { unlinkSync } from "fs";
import { getDb } from "../db/database";
import { adminOnly } from "../middleware/auth";
import { UPLOADS_DIR } from "../utils/paths";

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

// Pick a canonical casing for a category: trim, and reuse the existing casing
// of any product whose category matches case-insensitively. So "cakes" and
// "Cakes" merge into whichever was created first.
function canonicalCategory(input: string | undefined | null): string {
  const trimmed = (input || "General").trim() || "General";
  const db = getDb();
  const existing = db.query(
    "SELECT category FROM products WHERE LOWER(category) = LOWER(?) LIMIT 1"
  ).get(trimmed) as { category: string } | null;
  return existing?.category || trimmed;
}

products.post("/", adminOnly, async (c) => {
  const { name, category, cost_price, selling_price, discount_price, is_active } = await c.req.json();
  const db = getDb();
  const dp = discount_price && discount_price > 0 && discount_price < selling_price ? discount_price : null;
  const cat = canonicalCategory(category);
  const cleanName = (name || "").trim();
  const result = db.query(
    "INSERT INTO products (name, category, cost_price, selling_price, discount_price, is_active) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(cleanName, cat, cost_price || 0, selling_price, dp, is_active ?? 1);
  return c.json({ id: Number(result.lastInsertRowid), name: cleanName, category: cat, cost_price, selling_price, discount_price: dp });
});

products.put("/:id", adminOnly, async (c) => {
  const id = c.req.param("id");
  const { name, category, cost_price, selling_price, discount_price, is_active } = await c.req.json();
  const db = getDb();
  const dp = discount_price && discount_price > 0 && discount_price < selling_price ? discount_price : null;
  const cat = canonicalCategory(category);
  const cleanName = (name || "").trim();
  db.query(
    "UPDATE products SET name = ?, category = ?, cost_price = ?, selling_price = ?, discount_price = ?, is_active = ? WHERE id = ?"
  ).run(cleanName, cat, cost_price || 0, selling_price, dp, is_active, id);
  return c.json({ success: true });
});

products.post("/:id/image", adminOnly, async (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const exists = db.query("SELECT id, image_path FROM products WHERE id = ?").get(id) as any;
  if (!exists) return c.json({ error: "Product not found" }, 404);

  const body = await c.req.parseBody();
  const file = body.image as File | undefined;
  if (!file || typeof file === "string" || !file.size) {
    return c.json({ error: "No file uploaded" }, 400);
  }
  if (file.size > 3 * 1024 * 1024) {
    return c.json({ error: "Max file size is 3 MB" }, 400);
  }
  if (!file.type.startsWith("image/")) {
    return c.json({ error: "Only image files allowed" }, 400);
  }

  const extMatch = file.name.match(/\.[a-z0-9]+$/i);
  const ext = (extMatch ? extMatch[0] : ".jpg").toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
    return c.json({ error: "Unsupported image type" }, 400);
  }
  const filename = `product_${id}_${Date.now()}${ext}`;
  await Bun.write(path.join(UPLOADS_DIR, filename), file);

  // Remove old file if present
  if (exists.image_path) {
    try { unlinkSync(path.join(UPLOADS_DIR, exists.image_path)); } catch {}
  }

  db.query("UPDATE products SET image_path = ? WHERE id = ?").run(filename, id);
  return c.json({ image_path: filename });
});

products.delete("/:id/image", adminOnly, (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = db.query("SELECT image_path FROM products WHERE id = ?").get(id) as any;
  if (row?.image_path) {
    try { unlinkSync(path.join(UPLOADS_DIR, row.image_path)); } catch {}
  }
  db.query("UPDATE products SET image_path = NULL WHERE id = ?").run(id);
  return c.json({ success: true });
});

products.delete("/:id", adminOnly, (c) => {
  const db = getDb();
  const id = c.req.param("id");
  const row = db.query("SELECT image_path FROM products WHERE id = ?").get(id) as any;
  try {
    db.query("DELETE FROM products WHERE id = ?").run(id);
    if (row?.image_path) {
      try { unlinkSync(path.join(UPLOADS_DIR, row.image_path)); } catch {}
    }
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
