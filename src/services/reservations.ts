import { getDb } from "../db/database";

// --- Cart stock reservations ("holds") ---------------------------------------
//
// The shop runs a desktop till AND a mobile till, and the desktop can park a
// cart (which clears it locally). So "the last cake is in someone's cart" can
// only be known server-side. A hold is created the moment a confirmed cart
// syncs, and it survives until the cart is cleared, the item is removed, the
// sale completes, or an admin releases it by hand.
//
// Deliberately NO expiry, NO TTL, NO cleanup job: a cart only exists once the
// customer has confirmed the order, so a hold is a real commitment. Stranded
// holds are recovered through the admin "Held stock" screen instead.

export interface StockNeedItem {
  product_id: number;
  quantity: number;
}

export interface StockNeed {
  name: string;
  needed: number;
}

/**
 * Aggregate the stock a set of cart/bill lines actually consumes.
 *
 * A product's own count plus any components (composite/BoM) it explodes into.
 * The same underlying product referenced multiple times in the cart, or across
 * item + component sums, is summed correctly.
 *
 * This is the single source of truth shared by createBill() (deduction) and
 * syncCartReservations() (holding). If the two ever drifted, holding the last
 * composite cake would not hold its scarce ingredient.
 */
export function computeStockNeeds(items: StockNeedItem[]): Map<number, StockNeed> {
  const db = getDb();
  const needs = new Map<number, StockNeed>();
  const bump = (pid: number, name: string, qty: number) => {
    const cur = needs.get(pid) || { name, needed: 0 };
    cur.needed += qty;
    needs.set(pid, cur);
  };

  for (const item of items) {
    const p = db.query(
      "SELECT id, name, track_stock FROM products WHERE id = ?"
    ).get(item.product_id) as any;
    if (p?.track_stock) bump(p.id, p.name, item.quantity);

    const components = db.query(
      "SELECT component_product_id, quantity FROM product_components WHERE product_id = ?"
    ).all(item.product_id) as any[];
    for (const c of components) {
      const comp = db.query(
        "SELECT id, name, track_stock FROM products WHERE id = ?"
      ).get(c.component_product_id) as any;
      if (comp?.track_stock) bump(comp.id, comp.name, c.quantity * item.quantity);
    }
  }

  return needs;
}

/**
 * How much of a product is held by carts OTHER than `cartId`.
 * Passing a blank/null cart id treats every hold as somebody else's — the safe
 * default for a caller that cannot identify itself.
 */
export function heldByOtherCarts(productId: number, cartId?: string | null): number {
  const db = getDb();
  const cart = (cartId || "").trim();
  const row = cart
    ? db.query(
        "SELECT COALESCE(SUM(quantity), 0) AS held FROM stock_reservations WHERE product_id = ? AND cart_id != ?"
      ).get(productId, cart) as any
    : db.query(
        "SELECT COALESCE(SUM(quantity), 0) AS held FROM stock_reservations WHERE product_id = ?"
      ).get(productId) as any;
  return row?.held ?? 0;
}

/** Everything held by OTHER carts, keyed by product id — one query for a whole grid. */
export function heldByOtherCartsMap(cartId?: string | null): Map<number, number> {
  const db = getDb();
  const cart = (cartId || "").trim();
  const rows = (cart
    ? db.query(
        "SELECT product_id, COALESCE(SUM(quantity), 0) AS held FROM stock_reservations WHERE cart_id != ? GROUP BY product_id"
      ).all(cart)
    : db.query(
        "SELECT product_id, COALESCE(SUM(quantity), 0) AS held FROM stock_reservations GROUP BY product_id"
      ).all()) as any[];
  const map = new Map<number, number>();
  for (const r of rows) map.set(r.product_id, r.held ?? 0);
  return map;
}

/**
 * What `cartId` may still take of a product: stock minus everyone else's holds.
 * A cart is never blocked by its own hold, or it could not raise its own qty.
 */
export function availableFor(productId: number, cartId?: string | null): number {
  const db = getDb();
  const row = db.query("SELECT stock_quantity FROM products WHERE id = ?").get(productId) as any;
  return (row?.stock_quantity ?? 0) - heldByOtherCarts(productId, cartId);
}

/** The rows a cart currently holds, with product names — what the sync returns. */
export function getCartHolds(cartId: string): any[] {
  const db = getDb();
  return db.query(`
    SELECT r.id, r.product_id, p.name AS product_name, r.quantity, r.cart_id, r.user_id, r.created_at
    FROM stock_reservations r
    LEFT JOIN products p ON p.id = r.product_id
    WHERE r.cart_id = ?
    ORDER BY p.name
  `).all(cartId) as any[];
}

/**
 * Drop every hold a cart owns. Plain (non-transactional) on purpose so that
 * createBill() can call it INSIDE its own transaction — the sale and the
 * release must land or roll back together.
 */
export function releaseCartReservations(cartId: string): number {
  const db = getDb();
  const result = db.query("DELETE FROM stock_reservations WHERE cart_id = ?").run(cartId);
  return Number(result.changes || 0);
}

/**
 * "This cart now holds exactly these items."
 *
 * Sync semantics, not deltas: the cart's whole reservation set is replaced in
 * one transaction. A delta drifts the moment a request is lost; a full sync is
 * self-healing — the next one puts the server back in step with the cart.
 *
 * The DELETE + check + INSERT all run inside a single immediate transaction, so
 * two tills syncing the last cake at the same instant cannot both pass the
 * check, and a rejected sync leaves the cart's previous holds untouched.
 */
export function syncCartReservations(params: {
  cart_id: string;
  items: StockNeedItem[];
  user_id: number;
}): any[] {
  const db = getDb();
  const cartId = String(params.cart_id || "").trim();
  if (!cartId) throw new Error("cart_id is required");

  const items = (params.items || [])
    .map((i) => ({ product_id: Number(i.product_id), quantity: Number(i.quantity) }))
    .filter((i) => i.product_id && i.quantity > 0);

  const insert = db.query(
    "INSERT INTO stock_reservations (product_id, quantity, cart_id, user_id) VALUES (?, ?, ?, ?)"
  );

  const transaction = db.transaction(() => {
    // Aggregate inside the transaction so the BoM we hold against is the same
    // one the check saw.
    const needs = computeStockNeeds(items);

    // Replace, don't diff. Our own old rows go first so the availability check
    // below never counts this cart against itself.
    db.query("DELETE FROM stock_reservations WHERE cart_id = ?").run(cartId);

    for (const [pid, need] of needs) {
      if (need.needed <= 0) continue;
      const row = db.query("SELECT stock_quantity FROM products WHERE id = ?").get(pid) as any;
      const available = (row?.stock_quantity ?? 0) - heldByOtherCarts(pid, cartId);
      if (available < need.needed) {
        // Same shape as the out-of-stock line in billing.ts, but the number the
        // cashier is told is what's left AFTER other carts' holds.
        throw new Error(
          `${need.name} is out of stock (need ${need.needed}, available ${Math.max(0, available)})`
        );
      }
      insert.run(pid, need.needed, cartId, params.user_id);
    }
  });

  // A throw rolls the DELETE back too, so a failed sync never silently drops
  // the holds this cart already had.
  transaction.immediate();

  return getCartHolds(cartId);
}

/** Every live hold in the shop — feeds the admin "Held stock" recovery screen. */
export function listActiveHolds(): any[] {
  const db = getDb();
  return db.query(`
    SELECT r.id, r.product_id, p.name AS product_name, r.quantity, r.cart_id,
           r.user_id, u.full_name AS cashier_name, r.created_at
    FROM stock_reservations r
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN users u ON u.id = r.user_id
    ORDER BY r.created_at DESC, r.id DESC
  `).all() as any[];
}

/** Admin recovery: drop one stranded hold. Returns false if it was already gone. */
export function releaseHold(id: number): boolean {
  const db = getDb();
  const result = db.query("DELETE FROM stock_reservations WHERE id = ?").run(id);
  return Number(result.changes || 0) > 0;
}
