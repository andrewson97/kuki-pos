import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly, getUser } from "../middleware/auth";
import { todayDate } from "../utils/helpers";
import { heldByOtherCartsMap } from "../services/reservations";

const products = new Hono();

function attachComponents(rows: any[]): any[] {
  const db = getDb();
  const comps = db.query(
    "SELECT pc.product_id, pc.component_product_id, pc.quantity, p.name AS component_name, p.track_stock AS component_track_stock, p.stock_quantity AS component_stock_quantity FROM product_components pc JOIN products p ON p.id = pc.component_product_id"
  ).all() as any[];
  const byProduct = new Map<number, any[]>();
  for (const c of comps) {
    if (!byProduct.has(c.product_id)) byProduct.set(c.product_id, []);
    byProduct.get(c.product_id)!.push(c);
  }
  for (const r of rows) r.components = byProduct.get(r.id) || [];
  return rows;
}

// The admin product list. Discontinued products are permanently off the menu
// and only exist because history points at them, so they are hidden by default
// and asked for explicitly:
//   (no params)              → active + inactive, no discontinued
//   ?discontinued=1          → ONLY discontinued
//   ?include_discontinued=1  → everything
products.get("/", (c) => {
  const db = getDb();
  const onlyDiscontinued = c.req.query("discontinued") === "1";
  const includeDiscontinued = c.req.query("include_discontinued") === "1";
  const where = onlyDiscontinued
    ? "WHERE is_discontinued = 1"
    : includeDiscontinued
      ? ""
      : "WHERE is_discontinued = 0";
  const all = db.query(`SELECT * FROM products ${where} ORDER BY name`).all() as any[];
  return c.json(attachComponents(all));
});

// The POS grid. `stock_quantity` keeps its old meaning (units on hand) because
// other screens read this endpoint; what's new is `available_quantity` —
// on-hand minus the units OTHER carts are holding — which is what the grid
// should hide on.
//
// `?cart=<cart_id>` identifies the caller's own cart so its own holds don't
// make its own items vanish. With no cart param every hold counts as somebody
// else's, which is the safe direction to be wrong in.
//
// Discontinuing a product also sets is_active = 0, so the `is_active = 1`
// filter below already keeps discontinued products out of the till — no extra
// clause needed here.
products.get("/active", (c) => {
  const db = getDb();
  const cartId = c.req.query("cart") || c.req.query("cart_id") || "";
  const all = db.query("SELECT * FROM products WHERE is_active = 1 ORDER BY category, name").all() as any[];
  const rows = attachComponents(all);

  const held = heldByOtherCartsMap(cartId);
  for (const r of rows) {
    r.available_quantity = (r.stock_quantity ?? 0) - (held.get(r.id) ?? 0);
    for (const comp of r.components as any[]) {
      // Same figure for a composite's ingredients, so the grid can hide a cake
      // whose last tracked component is already spoken for.
      comp.component_available_quantity =
        (comp.component_stock_quantity ?? 0) - (held.get(comp.component_product_id) ?? 0);
    }
  }
  return c.json(rows);
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

function saveComponents(productId: number, components: any[] | undefined) {
  if (!Array.isArray(components)) return;
  const db = getDb();
  db.query("DELETE FROM product_components WHERE product_id = ?").run(productId);
  const insert = db.query(
    "INSERT INTO product_components (product_id, component_product_id, quantity) VALUES (?, ?, ?)"
  );
  for (const c of components) {
    const cid = parseInt(c.component_product_id);
    const qty = parseFloat(c.quantity);
    if (!cid || cid === productId || !qty || qty <= 0) continue;
    try { insert.run(productId, cid, qty); } catch { /* dup / bad row */ }
  }
}

products.post("/", adminOnly, async (c) => {
  const { name, category, cost_price, selling_price, discount_price, is_active, track_stock, stock_quantity, stock_reorder_level, components } = await c.req.json();
  const db = getDb();
  const dp = discount_price && discount_price > 0 && discount_price < selling_price ? discount_price : null;
  const cat = canonicalCategory(category);
  const cleanName = (name || "").trim();
  const ts = track_stock ? 1 : 0;
  // stock_updated_at is stamped here too: the row's stock was just set, so a
  // product created today at zero really did "run out" today, not at an
  // unknown time in the past.
  const result = db.query(
    "INSERT INTO products (name, category, cost_price, selling_price, discount_price, is_active, track_stock, stock_quantity, stock_reorder_level, stock_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
  ).run(cleanName, cat, cost_price || 0, selling_price, dp, is_active ?? 1, ts, ts ? (stock_quantity || 0) : 0, ts ? (stock_reorder_level || 0) : 0);
  const id = Number(result.lastInsertRowid);
  saveComponents(id, components);
  return c.json({ id, name: cleanName, category: cat, cost_price, selling_price, discount_price: dp });
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

// Add units to a tracked product's stock (purchase / restock / adjustment).
products.post("/:id/restock", adminOnly, async (c) => {
  const id = c.req.param("id");
  const user = getUser(c)!;
  const body = await c.req.json();
  const qty = parseFloat(body.quantity);
  const note = (body.note || "").trim() || null;
  if (!qty || qty <= 0) return c.json({ error: "Quantity must be greater than zero" }, 400);

  const db = getDb();
  const product = db.query(
    "SELECT id, name, track_stock, stock_quantity FROM products WHERE id = ?"
  ).get(id) as any;
  if (!product) return c.json({ error: "Product not found" }, 404);
  if (!product.track_stock) return c.json({ error: "Inventory tracking is off for this product" }, 400);

  db.transaction(() => {
    db.query("UPDATE products SET stock_quantity = stock_quantity + ?, stock_updated_at = datetime('now') WHERE id = ?").run(qty, id);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'restocked_product', ?)").run(
      user.id, JSON.stringify({ product_id: id, name: product.name, quantity: qty, note })
    );
  })();

  const updated = db.query("SELECT stock_quantity FROM products WHERE id = ?").get(id) as any;
  return c.json({ success: true, stock_quantity: updated.stock_quantity });
});

// Bring a discontinued product back. It returns to INACTIVE, not active: the
// owner reviews the price and stock and puts it back on the menu deliberately,
// rather than a restore dropping it straight into the till.
products.post("/:id/restore", adminOnly, (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid product id" }, 400);
  const user = getUser(c)!;

  const db = getDb();
  const product = db.query(
    "SELECT id, name, is_discontinued FROM products WHERE id = ?"
  ).get(id) as any;
  if (!product) return c.json({ error: "Product not found" }, 404);
  if (!product.is_discontinued) return c.json({ error: "That product is not discontinued" }, 404);

  db.transaction(() => {
    // is_active stays 0 on purpose — restored, but still off the menu.
    db.query("UPDATE products SET is_discontinued = 0, is_active = 0 WHERE id = ?").run(id);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'restored_product', ?)").run(
      user.id,
      JSON.stringify({ product_id: id, name: product.name, restored_to: "inactive" })
    );
  }).immediate();

  return c.json({ success: true, name: product.name, is_discontinued: 0, is_active: 0 });
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
      db.query("UPDATE products SET stock_quantity = stock_quantity - ?, stock_updated_at = datetime('now') WHERE id = ?").run(qty, id);
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
  const { name, category, cost_price, selling_price, discount_price, is_active, track_stock, stock_quantity, stock_reorder_level, components } = await c.req.json();
  const db = getDb();
  const dp = discount_price && discount_price > 0 && discount_price < selling_price ? discount_price : null;
  const cat = canonicalCategory(category);
  const cleanName = (name || "").trim();
  const ts = track_stock ? 1 : 0;

  // A discontinued product must never be re-activated through a plain edit.
  // is_discontinued is not in this payload, so saving one as active would leave
  // is_active = 1 with is_discontinued = 1: hidden from the product list but
  // visible in the POS grid. Restore is the only way back, and it returns the
  // product to inactive so it gets reviewed first.
  const existing = db.query("SELECT is_discontinued FROM products WHERE id = ?").get(Number(id)) as any;
  const active = existing?.is_discontinued ? 0 : is_active;

  // This UPDATE always writes stock_quantity, so it always re-dates the stock.
  db.query(
    "UPDATE products SET name = ?, category = ?, cost_price = ?, selling_price = ?, discount_price = ?, is_active = ?, track_stock = ?, stock_quantity = ?, stock_reorder_level = ?, stock_updated_at = datetime('now') WHERE id = ?"
  ).run(cleanName, cat, cost_price || 0, selling_price, dp, active, ts, ts ? (stock_quantity || 0) : 0, ts ? (stock_reorder_level || 0) : 0, id);
  saveComponents(parseInt(id), components);
  return c.json({ success: true });
});

/**
 * Delete a product — or discontinue it when history won't let it go.
 *
 * Four tables reference products(id) without a cascade, and they do NOT mean
 * the same thing, so they are not handled the same way:
 *
 *   stock_reservations  — it is in somebody's cart RIGHT NOW. Transient, and
 *   product_components  — it is an ingredient in another product's recipe.
 *                         Both are fixable, so both are refused with a reason
 *                         and nothing is changed.
 *
 *   bill_items          — it was sold. Real, permanent history.
 *   product_disposals   — it was written off. Same.
 *                         The row cannot go, so it is DISCONTINUED instead.
 *
 * (recipes.product_id and product_components.product_id are ON DELETE CASCADE —
 * the product's OWN recipe and bill of materials — and are fine to let go.)
 *
 * Discontinued sets is_discontinued = 1 AND is_active = 0 together. The second
 * half is what keeps it out of the till: every consumer filters on is_active
 * (the POS grid via /active, the dashboard and mobile low-stock queries, the
 * tracked-products table on the stock pages), so one UPDATE removes it
 * everywhere without touching those queries.
 */
products.delete("/:id", adminOnly, (c) => {
  const db = getDb();
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid product id" }, 400);
  const user = getUser(c)!;

  const product = db.query(
    "SELECT id, name, is_discontinued FROM products WHERE id = ?"
  ).get(id) as any;
  if (!product) return c.json({ error: "Product not found" }, 404);

  // 1. Held in a live cart. Transient — the sale finishes or the cart is
  // cleared and the blocker is gone, so refuse rather than discontinue.
  const held = db.query(
    "SELECT COUNT(*) AS holds, COALESCE(SUM(quantity), 0) AS quantity FROM stock_reservations WHERE product_id = ?"
  ).get(id) as any;
  if (held.holds > 0) {
    return c.json(
      {
        error: `${product.name} is in a cart right now (${held.quantity} held). Complete or clear that sale, then delete it.`,
        held_quantity: held.quantity,
      },
      400
    );
  }

  // 2. An ingredient in another product's bill of materials. Deleting would
  // leave those products pointing at nothing, so name them and let the user
  // fix the recipe first — same shape as the stock-item delete.
  const usedBy = db.query(
    `SELECT DISTINCT p.name FROM product_components pc JOIN products p ON p.id = pc.product_id
     WHERE pc.component_product_id = ? ORDER BY p.name`
  ).all(id) as any[];
  if (usedBy.length) {
    const names = usedBy.map((r) => r.name).join(", ");
    return c.json(
      { error: `${product.name} is a component of ${names}. Remove it from those products first.` },
      400
    );
  }

  // 3. Genuine history. The row has to stay, so retire it for good.
  const billed = db.query(
    "SELECT COUNT(*) AS count FROM bill_items WHERE product_id = ?"
  ).get(id) as any;
  const disposed = db.query(
    "SELECT COUNT(*) AS count FROM product_disposals WHERE product_id = ?"
  ).get(id) as any;

  if (billed.count > 0 || disposed.count > 0) {
    const parts: string[] = [];
    if (billed.count > 0) {
      parts.push(`appears on ${billed.count} past bill line${billed.count === 1 ? "" : "s"}`);
    }
    if (disposed.count > 0) {
      parts.push(`has ${disposed.count} disposal record${disposed.count === 1 ? "" : "s"}`);
    }
    const reason = `${product.name} ${parts.join(" and ")}, so it cannot be deleted without losing that history.`;

    db.transaction(() => {
      // One statement: discontinued AND off the menu, never one without the other.
      db.query("UPDATE products SET is_discontinued = 1, is_active = 0 WHERE id = ?").run(id);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'discontinued_product', ?)").run(
        user.id,
        JSON.stringify({
          product_id: id,
          name: product.name,
          reason,
          bill_items: billed.count,
          disposals: disposed.count,
        })
      );
    }).immediate();

    return c.json({ success: true, discontinued: true, name: product.name, reason });
  }

  // 4. Nothing points at it: really delete it.
  try {
    db.transaction(() => {
      db.query("DELETE FROM products WHERE id = ?").run(id);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'deleted_product', ?)").run(
        user.id,
        JSON.stringify({ product_id: id, name: product.name })
      );
    }).immediate();
    return c.json({ success: true, deleted: product.name });
  } catch (err: any) {
    // Backstop only. The four known references are all handled above, so this
    // should now be unreachable; it exists for a foreign key added later that
    // nobody taught this handler about. It no longer guesses "inactive" — an
    // undeletable product is discontinued, same as case 3, with an honest
    // reason instead of a made-up one.
    if (String(err?.message || "").includes("FOREIGN KEY")) {
      const reason = `${product.name} is still referenced by other records, so it cannot be deleted.`;
      db.transaction(() => {
        db.query("UPDATE products SET is_discontinued = 1, is_active = 0 WHERE id = ?").run(id);
        db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'discontinued_product', ?)").run(
          user.id,
          JSON.stringify({ product_id: id, name: product.name, reason, unexpected_reference: true })
        );
      }).immediate();
      return c.json({ success: true, discontinued: true, name: product.name, reason });
    }
    return c.json({ error: err?.message || "Delete failed" }, 500);
  }
});

export default products;
