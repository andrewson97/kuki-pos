import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly, getUser } from "../middleware/auth";
import { PortionError, finishStockUnit, listPortionIngredients, openStockUnit, undoOpenStockUnit } from "../services/portions";
import { ITEM_IN_SYNC } from "../services/closing";

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
  // in_daily_sync: whether the closing stock sync counts it — its own tick or
  // its category's (ITEM_IN_SYNC).
  const items = db.query(`
    SELECT si.*, sc.name as category_name, ${ITEM_IN_SYNC} AS in_daily_sync
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
  const { name, category_id, unit, quantity, reorder_level, cost_per_unit, expiry_date, daily_sync } = await c.req.json();
  const db = getDb();
  const user = getUser(c)!;

  // daily_sync: counted in the closing stock sync. Unticked unless asked for.
  const result = db.query(
    "INSERT INTO stock_items (name, category_id, unit, quantity, reorder_level, cost_per_unit, expiry_date, daily_sync) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(name, category_id, unit || "pcs", quantity || 0, reorder_level || 0, cost_per_unit || 0, expiry_date || null,
    // Ticked in the form: always counted. Otherwise NULL — it follows its
    // category's group tick, so an item added to a ticked group is counted.
    daily_sync ? 1 : null);

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
  const { name, category_id, unit, reorder_level, cost_per_unit, expiry_date, daily_sync } = await c.req.json();
  const db = getDb();
  // daily_sync absent (an older form, the mobile page) keeps what is stored.
  const sync = daily_sync === undefined || daily_sync === null ? null : (daily_sync ? 1 : 0);
  db.query(
    "UPDATE stock_items SET name = ?, category_id = ?, unit = ?, reorder_level = ?, cost_per_unit = ?, expiry_date = ?, daily_sync = COALESCE(?, daily_sync), updated_at = datetime('now') WHERE id = ?"
  ).run(name, category_id, unit, reorder_level, cost_per_unit, expiry_date || null, sync, id);
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

  // Same rule for the till links: products made from it as an opened
  // ingredient, or packed in it. Deleting would leave them pointing at nothing.
  const linkedBy = db.query(
    `SELECT p.name FROM product_ingredient_links l JOIN products p ON p.id = l.product_id WHERE l.stock_item_id = ?
     UNION
     SELECT p.name FROM product_packing_links l JOIN products p ON p.id = l.product_id WHERE l.stock_item_id = ?
     ORDER BY 1`
  ).all(id, id) as any[];
  if (linkedBy.length) {
    const names = linkedBy.map((r) => r.name).join(", ");
    return c.json(
      { error: `${item.name} is linked to ${names} (as an ingredient or packing). Remove it from those products first.` },
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

// --- Opened ingredients (src/services/portions.ts) ---------------------------
// Ordinary till work, so no adminOnly — the same as /usage above. Opening and
// finishing are both on the record (stock_transactions / activity_log) with
// the cashier's name.

// Every ingredient something is made from: its links and its opened units.
stock.get("/portions", (c) => c.json(listPortionIngredients()));

// Open a sealed unit: it leaves stock and its servings become sellable.
// Body: { size, note? } — size is how much is in this one, in the item's unit
// (a 2 L or a 1 L box). Required: a page from before sizes existed must not
// open a 2 L box as 1.
stock.post("/items/:id/open", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid stock item id" }, 400);
  const body = await c.req.json().catch(() => ({} as any));
  const raw = body?.size;
  if (raw === undefined || raw === null || raw === "") {
    return c.json({ error: "Enter how much is in the one being opened. Reload the page if it does not ask." }, 400);
  }
  try {
    return c.json({ success: true, ...openStockUnit(id, getUser(c)!.id, body?.note, Number(raw)) });
  } catch (err: any) {
    if (err instanceof PortionError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

// Finish an opened unit early (spilled, gone off). A reason is required.
stock.post("/opened/:id/finish", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid opened item id" }, 400);
  const body = await c.req.json().catch(() => ({} as any));
  try {
    return c.json({ success: true, ...finishStockUnit(id, getUser(c)!.id, body?.reason) });
  } catch (err: any) {
    if (err instanceof PortionError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

// Undo an Open made by mistake. Admin-only: it puts a unit back into sealed
// stock, which is a correction to the record, not till work.
stock.post("/opened/:id/undo", adminOnly, (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid opened item id" }, 400);
  try {
    return c.json({ success: true, ...undoOpenStockUnit(id, getUser(c)!.id) });
  } catch (err: any) {
    if (err instanceof PortionError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

// --- Daily stock sync selection ----------------------------------------------
// Which items the closing stock sync asks to be counted (src/services/closing.ts
// listSyncItems). Body: { items: [{ kind: 'product' | 'ingredient', id, on }] }
// — one checkbox, or "tick all" on a list, in one call. Products must track
// their stock to be counted, so ticking an untracked one is refused.
stock.post("/daily-sync", adminOnly, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  if (!Array.isArray(body.items) || !body.items.length) return c.json({ error: "items must be a non-empty list" }, 400);
  const db = getDb();
  const user = getUser(c)!;
  try {
    const changed = db.transaction(() => {
      let n = 0;
      for (const it of body.items) {
        const id = Number(it?.id);
        const on = it?.on === true || it?.on === 1 ? 1 : 0;
        if (!Number.isInteger(id) || id <= 0) throw new TxnError("Each item needs an id");
        if (it?.kind === "product") {
          const p = db.query("SELECT name, track_stock FROM products WHERE id = ?").get(id) as any;
          if (!p) throw new TxnError("Product not found", 404);
          if (on && !p.track_stock) throw new TxnError(`${p.name} does not track its stock, so it cannot be counted. Turn tracking on first.`);
          n += Number(db.query("UPDATE products SET daily_sync = ? WHERE id = ? AND daily_sync IS NOT ?").run(on, id, on).changes || 0);
        } else if (it?.kind === "ingredient") {
          if (!db.query("SELECT 1 FROM stock_items WHERE id = ?").get(id)) throw new TxnError("Stock item not found", 404);
          n += Number(db.query("UPDATE stock_items SET daily_sync = ? WHERE id = ? AND daily_sync IS NOT ?").run(on, id, on).changes || 0);
        } else {
          throw new TxnError("kind must be product or ingredient");
        }
      }
      if (n) {
        db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'daily_sync_selection', ?)").run(
          user.id, JSON.stringify({
            changed: n,
            // Only the fields this route reads, whatever else the body carried.
            items: body.items.slice(0, 200).map((it: any) => ({ kind: String(it?.kind), id: Number(it?.id), on: it?.on === true || it?.on === 1 })),
          })
        );
      }
      return n;
    }).immediate();
    return c.json({ success: true, changed });
  } catch (err: any) {
    if (err instanceof TxnError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

// --- Daily stock sync: whole groups ------------------------------------------
// A ticked group is a standing rule: everything in it now, and anything added
// to it later, is counted in the closing stock sync. Groups: a stock category
// ('stock_category', key = its id), a product category ('product_category',
// key = its name, any casing) or every tracked product ('all_products').
//
// Ticking or unticking a group puts every item in it back on "follow the
// group" (daily_sync NULL), so the group's tick is what the admin then sees on
// every row; single items can be left out (or in) again afterwards.
stock.get("/daily-sync/groups", (c) => {
  return c.json(getDb().query("SELECT group_type, group_key FROM daily_sync_groups ORDER BY group_type, group_key").all());
});

stock.post("/daily-sync/groups", adminOnly, async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const type = String(body.group_type || "");
  const on = body.on === true || body.on === 1;
  const db = getDb();
  let key = "";
  if (type === "stock_category") {
    const id = Number(body.group_key);
    if (!Number.isInteger(id) || !db.query("SELECT 1 FROM stock_categories WHERE id = ?").get(id)) {
      return c.json({ error: "That stock category was not found" }, 404);
    }
    key = String(id);
  } else if (type === "product_category") {
    key = String(body.group_key ?? "").trim();
    if (!key) return c.json({ error: "Say which product category" }, 400);
    // Ticking needs a real category, or the rule would sit unseen and count
    // whatever product is given that name later. Unticking always works, so a
    // group whose products have all gone can still be cleared.
    if (on && !db.query("SELECT 1 FROM products WHERE LOWER(TRIM(category)) = LOWER(?) LIMIT 1").get(key)) {
      return c.json({ error: `There is no product category called "${key}".` }, 404);
    }
  } else if (type !== "all_products") {
    return c.json({ error: "group_type must be stock_category, product_category or all_products" }, 400);
  }
  const user = getUser(c)!;
  const reset = db.transaction(() => {
    if (on) {
      db.query("INSERT OR IGNORE INTO daily_sync_groups (group_type, group_key, user_id) VALUES (?, ?, ?)").run(type, key, user.id);
    } else {
      // A product category is matched without regard to case, so its rows go
      // the same way.
      db.query("DELETE FROM daily_sync_groups WHERE group_type = ? AND LOWER(group_key) = LOWER(?)").run(type, key);
    }
    // While "All finished products" is ticked, a product category adds and
    // removes nothing — All already counts every product. Its own tick is kept
    // (it applies again once All is unticked), but no item is reset: a reset
    // would quietly put back a product the admin had left out.
    if (type === "product_category" && db.query("SELECT 1 FROM daily_sync_groups WHERE group_type = 'all_products'").get()) {
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'daily_sync_group', ?)").run(
        user.id, JSON.stringify({ group_type: type, group_key: key, on, items_reset: 0, covered_by_all: true })
      );
      return 0;
    }
    // Everyone in the group follows it from now on.
    const r = type === "stock_category"
      ? db.query("UPDATE stock_items SET daily_sync = NULL WHERE category_id = ? AND daily_sync IS NOT NULL").run(Number(key))
      : type === "product_category"
        ? db.query("UPDATE products SET daily_sync = NULL WHERE LOWER(category) = LOWER(?) AND daily_sync IS NOT NULL").run(key)
        : db.query("UPDATE products SET daily_sync = NULL WHERE daily_sync IS NOT NULL").run();
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'daily_sync_group', ?)").run(
      user.id, JSON.stringify({ group_type: type, group_key: key, on, items_reset: Number(r.changes || 0) })
    );
    return Number(r.changes || 0);
  }).immediate();
  return c.json({ success: true, group_type: type, group_key: key, on, items_reset: reset });
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
