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

// Delete a stock item. Two foreign keys point at stock_items and neither
// cascades, so a bare DELETE would just fail: recipes.stock_item_id (a real
// integrity problem - removing it would break the recipe) and
// stock_transactions.stock_item_id (that item's history).
stock.delete("/items/:id", adminOnly, (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid stock item id" }, 400);
  const force = c.req.query("force") === "1";
  const db = getDb();

  const item = db.query("SELECT id, name, quantity FROM stock_items WHERE id = ?").get(id) as any;
  if (!item) return c.json({ error: "Stock item not found" }, 404);

  // Used by a recipe: refuse outright and name the products, because deleting
  // would leave those recipes pointing at nothing. The user fixes the recipe first.
  const usedBy = db.query(
    `SELECT DISTINCT p.name FROM recipes r JOIN products p ON p.id = r.product_id
     WHERE r.stock_item_id = ? ORDER BY p.name`
  ).all(id) as any[];
  if (usedBy.length) {
    const names = usedBy.map((r) => r.name).join(", ");
    return c.json(
      { error: `${item.name} is used in the recipe for ${names}. Remove it from those recipes first.` },
      400
    );
  }

  // Has history: deleting the item takes its movements with it, so make the
  // caller confirm rather than quietly dropping rows out of the history screen.
  const history = db.query(
    "SELECT COUNT(*) AS count FROM stock_transactions WHERE stock_item_id = ?"
  ).get(id) as any;
  if (history.count > 0 && !force) {
    return c.json(
      {
        error: `${item.name} has ${history.count} stock movement${history.count === 1 ? "" : "s"} recorded. Deleting it removes those too.`,
        needs_confirm: true,
        history_count: history.count,
        name: item.name,
      },
      409
    );
  }

  const user = getUser(c)!;
  db.transaction(() => {
    db.query("DELETE FROM stock_transactions WHERE stock_item_id = ?").run(id);
    db.query("DELETE FROM stock_items WHERE id = ?").run(id);
    // The item and its movements are gone, so record that the deletion happened.
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'deleted_stock_item', ?)").run(
      user.id,
      JSON.stringify({
        stock_item_id: id,
        name: item.name,
        quantity_at_deletion: item.quantity,
        movements_removed: history.count,
      })
    );
  }).immediate();

  return c.json({ success: true, deleted: item.name, movements_removed: history.count });
});

// Stock Transactions (add/remove stock)
//
// The TYPE decides the direction; the quantity is always a plain amount. This
// used to add whatever number was typed regardless of type, so "Waste 5" ADDED
// five, and a negative typed into "Purchase" quietly removed stock. Now:
//   purchase   — "we bought N"            → on hand + N
//   usage      — "we used N"              → on hand − N
//   waste      — "N went in the bin"      → on hand − N
//   adjustment — "I counted it, there is N" → on hand = N
// usage/waste are refused when they would take the item below zero (same rule
// as the bulk-usage endpoint below), and purchase/usage/waste refuse a quantity
// of zero or less. An adjustment takes the counted figure, which may be zero.
//
// stock_transactions.quantity keeps its signed meaning — negative = out — so
// Stock History reads these rows unchanged. For an adjustment the row stores
// the DIFFERENCE between the count and what was on hand, which is the movement.
const TXN_TYPES = ["purchase", "usage", "waste", "adjustment"];

class TxnError extends Error {
  constructor(message: string, public status: 400 | 404 = 400) { super(message); }
}

stock.post("/items/:id/transaction", adminOnly, async (c) => {
  const stockItemId = Number(c.req.param("id"));
  if (!Number.isInteger(stockItemId) || stockItemId <= 0) return c.json({ error: "Invalid stock item id" }, 400);
  const { type, quantity, reference } = await c.req.json().catch(() => ({} as any));
  const user = getUser(c)!;
  const db = getDb();

  if (!TXN_TYPES.includes(type)) {
    return c.json({ error: "type must be purchase, usage, waste or adjustment" }, 400);
  }
  const qty = Number(quantity);
  if (quantity === null || quantity === undefined || quantity === "" || !Number.isFinite(qty)) {
    return c.json({ error: "Enter a quantity" }, 400);
  }
  if (type === "adjustment" ? qty < 0 : qty <= 0) {
    return c.json({ error: type === "adjustment" ? "The counted quantity cannot be negative" : "Quantity must be greater than zero" }, 400);
  }
  const note = String(reference || "").trim() || null;

  let result: any;
  try {
    // One write-locked transaction: the on-hand figure the checks and the
    // adjustment's difference are based on cannot change underneath them.
    result = db.transaction(() => {
      const item = db.query("SELECT name, unit, quantity FROM stock_items WHERE id = ?").get(stockItemId) as any;
      if (!item) throw new TxnError("Stock item not found", 404);
      const onHand = Number(item.quantity) || 0;
      const unit = item.unit ? ` ${item.unit}` : "";

      let delta: number;
      let next: number;
      let ref = note;
      if (type === "purchase") {
        delta = qty;
        next = onHand + qty;
      } else if (type === "adjustment") {
        delta = qty - onHand;
        next = qty;
        // Keep both figures on the row: the stored quantity is only the
        // difference, and "counted 3 (was 5)" is what someone reading the
        // history later actually wants to know.
        ref = `Counted ${qty}${unit} (was ${onHand}${unit})` + (note ? ` — ${note}` : "");
      } else {
        // usage / waste. The tiny tolerance stops float dust (0.30000000000000004)
        // refusing a removal of exactly what is on hand.
        if (qty > onHand + 1e-9) {
          throw new TxnError(`Only ${onHand}${unit} of ${item.name} on hand — cannot remove ${qty}${unit}. Use "Count" to correct the figure first if it is wrong.`);
        }
        delta = -qty;
        next = Math.max(0, onHand - qty);
      }

      // A count that matches what is recorded changes nothing; no movement row.
      if (delta === 0) return { quantity: 0, new_quantity: onHand, unchanged: true };

      db.query(
        "INSERT INTO stock_transactions (stock_item_id, type, quantity, reference, user_id) VALUES (?, ?, ?, ?, ?)"
      ).run(stockItemId, type, delta, ref, user.id);
      db.query(
        "UPDATE stock_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(next, stockItemId);
      return { quantity: delta, new_quantity: next };
    }).immediate();
  } catch (err: any) {
    if (err instanceof TxnError) return c.json({ error: err.message }, err.status);
    throw err;
  }

  return c.json({ success: true, type, ...result });
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

  // Aggregate first: the same item can appear on more than one usage line, and
  // checking each line on its own would let two half-valid lines overdraw it.
  const needs = new Map<number, number>();
  for (const item of items) {
    const id = Number(item.stock_item_id);
    if (!id) continue;
    needs.set(id, (needs.get(id) || 0) + Math.abs(item.quantity));
  }

  const transaction = db.transaction(() => {
    // Validate every aggregated need before deducting anything, so a usage that
    // would drive an item below zero is refused outright rather than half-applied.
    // Products get this at checkout (see createBill); stock items had no such
    // guard, which is how quantities went negative.
    for (const [stockItemId, needed] of needs) {
      const row = db.query(
        "SELECT name, quantity FROM stock_items WHERE id = ?"
      ).get(stockItemId) as any;
      if (!row) throw new Error("Stock item not found");
      if (row.quantity < needed) {
        throw new Error(`${row.name} is out of stock (need ${needed}, have ${row.quantity})`);
      }
    }

    for (const [stockItemId, qty] of needs) {
      db.query(
        "INSERT INTO stock_transactions (stock_item_id, type, quantity, reference, user_id) VALUES (?, 'usage', ?, ?, ?)"
      ).run(stockItemId, -qty, purpose || null, user.id);

      db.query(
        "UPDATE stock_items SET quantity = quantity - ?, updated_at = datetime('now') WHERE id = ?"
      ).run(qty, stockItemId);
    }

    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'stock_usage', ?)").run(
      user.id, JSON.stringify({ items_count: needs.size, purpose })
    );
  });

  try {
    // Take the write lock up front: this checks then writes across stock_items.
    transaction.immediate();
  } catch (err: any) {
    return c.json({ error: err.message || "Could not record usage" }, 400);
  }
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
