import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly, getUser } from "../middleware/auth";

const stock = new Hono();

// Categories
stock.get("/categories", (c) => {
  const db = getDb();
  return c.json(db.query("SELECT * FROM stock_categories ORDER BY name").all());
});

stock.post("/categories", adminOnly, async (c) => {
  const { name } = await c.req.json();
  const db = getDb();
  const result = db.query("INSERT INTO stock_categories (name) VALUES (?)").run(name);
  return c.json({ id: Number(result.lastInsertRowid), name });
});

// Stock Items
stock.get("/items", (c) => {
  const db = getDb();
  const items = db.query(`
    SELECT si.*, sc.name as category_name
    FROM stock_items si
    LEFT JOIN stock_categories sc ON si.category_id = sc.id
    ORDER BY si.name
  `).all();
  return c.json(items);
});

stock.get("/items/:id", (c) => {
  const db = getDb();
  const item = db.query(`
    SELECT si.*, sc.name as category_name
    FROM stock_items si
    LEFT JOIN stock_categories sc ON si.category_id = sc.id
    WHERE si.id = ?
  `).get(c.req.param("id"));
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json(item);
});

stock.post("/items", adminOnly, async (c) => {
  const { name, category_id, unit, quantity, reorder_level, cost_per_unit, expiry_date } = await c.req.json();
  const db = getDb();
  const user = getUser(c)!;

  const result = db.query(
    "INSERT INTO stock_items (name, category_id, unit, quantity, reorder_level, cost_per_unit, expiry_date) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(name, category_id, unit || "pcs", quantity || 0, reorder_level || 0, cost_per_unit || 0, expiry_date || null);

  const itemId = Number(result.lastInsertRowid);

  // Log initial stock as purchase transaction
  if (quantity && quantity > 0) {
    db.query(
      "INSERT INTO stock_transactions (stock_item_id, type, quantity, reference, user_id) VALUES (?, 'purchase', ?, 'Initial stock', ?)"
    ).run(itemId, quantity, user.id);
  }

  return c.json({ id: itemId, name });
});

stock.put("/items/:id", adminOnly, async (c) => {
  const id = c.req.param("id");
  const { name, category_id, unit, reorder_level, cost_per_unit, expiry_date } = await c.req.json();
  const db = getDb();
  db.query(
    "UPDATE stock_items SET name = ?, category_id = ?, unit = ?, reorder_level = ?, cost_per_unit = ?, expiry_date = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(name, category_id, unit, reorder_level, cost_per_unit, expiry_date || null, id);
  return c.json({ success: true });
});

// Stock Transactions (add/remove stock)
stock.post("/items/:id/transaction", adminOnly, async (c) => {
  const stockItemId = c.req.param("id");
  const { type, quantity, reference } = await c.req.json();
  const user = getUser(c)!;
  const db = getDb();

  db.query(
    "INSERT INTO stock_transactions (stock_item_id, type, quantity, reference, user_id) VALUES (?, ?, ?, ?, ?)"
  ).run(stockItemId, type, quantity, reference || null, user.id);

  db.query(
    "UPDATE stock_items SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?"
  ).run(quantity, stockItemId);

  return c.json({ success: true });
});

stock.get("/items/:id/transactions", (c) => {
  const db = getDb();
  const transactions = db.query(
    "SELECT st.*, u.full_name as user_name FROM stock_transactions st LEFT JOIN users u ON st.user_id = u.id WHERE st.stock_item_id = ? ORDER BY st.created_at DESC LIMIT 50"
  ).all(c.req.param("id"));
  return c.json(transactions);
});

// Bulk usage - mark multiple items as used at once
stock.post("/usage", async (c) => {
  const { items, purpose } = await c.req.json();
  const user = getUser(c)!;
  const db = getDb();

  if (!items || items.length === 0) {
    return c.json({ error: "No items provided" }, 400);
  }

  const transaction = db.transaction(() => {
    for (const item of items) {
      const qty = Math.abs(item.quantity); // ensure positive
      db.query(
        "INSERT INTO stock_transactions (stock_item_id, type, quantity, reference, user_id) VALUES (?, 'usage', ?, ?, ?)"
      ).run(item.stock_item_id, -qty, purpose || null, user.id);

      db.query(
        "UPDATE stock_items SET quantity = quantity - ?, updated_at = datetime('now') WHERE id = ?"
      ).run(qty, item.stock_item_id);
    }

    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'stock_usage', ?)").run(
      user.id, JSON.stringify({ items_count: items.length, purpose })
    );
  });

  transaction();
  return c.json({ success: true });
});

// Alerts
stock.get("/alerts", (c) => {
  const db = getDb();
  const items = db.query(`
    SELECT si.*, sc.name as category_name
    FROM stock_items si
    LEFT JOIN stock_categories sc ON si.category_id = sc.id
    WHERE si.quantity <= si.reorder_level AND si.reorder_level > 0
    ORDER BY (si.quantity / si.reorder_level) ASC
  `).all();
  return c.json(items);
});

export default stock;
