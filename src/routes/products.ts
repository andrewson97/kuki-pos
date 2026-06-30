import { Hono } from "hono";
import path from "path";
import { unlinkSync } from "fs";
import { getDb } from "../db/database";
import { adminOnly, getUser } from "../middleware/auth";
import { UPLOADS_DIR } from "../utils/paths";
import { todayDate } from "../utils/helpers";

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
  const { name, category, cost_price, selling_price, discount_price, is_active, track_stock, stock_quantity, stock_reorder_level } = await c.req.json();
  const db = getDb();
  const dp = discount_price && discount_price > 0 && discount_price < selling_price ? discount_price : null;
  const cat = canonicalCategory(category);
  const cleanName = (name || "").trim();
  const ts = track_stock ? 1 : 0;
  const result = db.query(
    "INSERT INTO products (name, category, cost_price, selling_price, discount_price, is_active, track_stock, stock_quantity, stock_reorder_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(cleanName, cat, cost_price || 0, selling_price, dp, is_active ?? 1, ts, ts ? (stock_quantity || 0) : 0, ts ? (stock_reorder_level || 0) : 0);
  return c.json({ id: Number(result.lastInsertRowid), name: cleanName, category: cat, cost_price, selling_price, discount_price: dp });
});

// --- Disposal / wastage tracking ---
// History across a date range, optionally filtered by product.
products.get("/disposals", (c) => {
  const db = getDb();
  const start = c.req.query("start_date");
  const end = c.req.query("end_date");
  const productId = c.req.query("product_id");
  let query = `
    SELECT d.*, p.name AS product_name, p.cost_price, u.full_name AS user_name
    FROM product_disposals d
    LEFT JOIN products p ON p.id = d.product_id
    LEFT JOIN users u ON u.id = d.user_id
  `;
  const conds: string[] = [];
  const params: any[] = [];
  if (start) { conds.push("d.business_date >= ?"); params.push(start); }
  if (end) { conds.push("d.business_date <= ?"); params.push(end); }
  if (productId) { conds.push("d.product_id = ?"); params.push(productId); }
  if (conds.length) query += " WHERE " + conds.join(" AND ");
  query += " ORDER BY d.business_date DESC, d.created_at DESC";
  const rows = db.query(query).all(...params);
  return c.json(rows);
});

// Record a disposal: deducts product stock and stores cost_loss = qty × cost_price.
products.post("/:id/dispose", adminOnly, async (c) => {
  const id = c.req.param("id");
  const user = getUser(c)!;
  const body = await c.req.json();
  const qty = parseFloat(body.quantity);
  const reason = (body.reason || "").trim() || null;
  if (!qty || qty <= 0) return c.json({ error: "Quantity must be greater than zero" }, 400);

  const db = getDb();
  const product = db.query(
    "SELECT id, name, cost_price, track_stock, stock_quantity FROM products WHERE id = ?"
  ).get(id) as any;
  if (!product) return c.json({ error: "Product not found" }, 404);

  const costLoss = qty * (product.cost_price || 0);
  const businessDate = todayDate();

  db.transaction(() => {
    if (product.track_stock) {
      // Subtract from stock (allow going negative — admin's call)
      db.query("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?").run(qty, id);
    }
    db.query(
      "INSERT INTO product_disposals (product_id, quantity, cost_loss, reason, business_date, user_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, qty, costLoss, reason, businessDate, user.id);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'disposed_product', ?)").run(
      user.id, JSON.stringify({ product_id: id, name: product.name, quantity: qty, cost_loss: costLoss, reason })
    );
  })();

  return c.json({ success: true, cost_loss: costLoss, business_date: businessDate });
});

// IMPORTANT: register before PUT "/:id" so Hono doesn't treat
// "category-order" as a product id.
products.put("/category-order", adminOnly, async (c) => {
  const { order } = await c.req.json();
  if (!Array.isArray(order)) return c.json({ error: "order must be an array of category names" }, 400);
  const cleaned = order.map(x => String(x || "").trim()).filter(Boolean);
  const db = getDb();
  db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('category_order', ?)").run(JSON.stringify(cleaned));
  return c.json({ success: true, order: cleaned });
});

products.put("/:id", adminOnly, async (c) => {
  const id = c.req.param("id");
  const { name, category, cost_price, selling_price, discount_price, is_active, track_stock, stock_quantity, stock_reorder_level } = await c.req.json();
  const db = getDb();
  const dp = discount_price && discount_price > 0 && discount_price < selling_price ? discount_price : null;
  const cat = canonicalCategory(category);
  const cleanName = (name || "").trim();
  const ts = track_stock ? 1 : 0;
  db.query(
    "UPDATE products SET name = ?, category = ?, cost_price = ?, selling_price = ?, discount_price = ?, is_active = ?, track_stock = ?, stock_quantity = ?, stock_reorder_level = ? WHERE id = ?"
  ).run(cleanName, cat, cost_price || 0, selling_price, dp, is_active, ts, ts ? (stock_quantity || 0) : 0, ts ? (stock_reorder_level || 0) : 0, id);
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
