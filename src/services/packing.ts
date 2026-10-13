import { getDb } from "../db/database";

// --- Packing items used by a sale ---------------------------------------------
//
// A product can be linked to the packing it uses up (product_packing_links): a
// cake box, a cup and lid, a napkin, per unit sold. A link applies either to
// TAKEAWAY bills only (a dine-in milkshake goes in a glass) or to EVERY sale.
// That is why the till records dine-in / takeaway on every bill: without it
// there is no telling whether the box left the shop.
//
// Deducted from stock_items inside the sale transaction as ordinary 'usage'
// movements, one per packing item, so Stock History shows them against the bill.
//
// Packing NEVER blocks a sale. The customer is standing there with the cake;
// a box count that says zero is a wrong count, not a reason to refuse money.
// So the deduction takes what is recorded, never goes below zero, and logs a
// 'packing_shortfall' for whatever it could not take — that row, and the item
// sitting at zero on the dashboard's stock alerts, are the owner's cue to count.
//
// Only the products on the bill's lines are looked at: a composite's packing is
// set on the composite (one box for "Brownie with Ice Cream"), never also on its
// components, or the same sale would count two boxes.
//
// A refund never puts packing back: the box went home with the customer.

export type OrderType = "dine_in" | "takeaway";
export const ORDER_TYPES: OrderType[] = ["dine_in", "takeaway"];

export const orderTypeLabel = (t: string | null | undefined) =>
  t === "dine_in" ? "Dine in" : t === "takeaway" ? "Takeaway" : "";

/** The shop's default for a sale that did not say: settings.default_order_type, else takeaway. */
export function defaultOrderType(): OrderType {
  const row = getDb().query("SELECT value FROM settings WHERE key = 'default_order_type'").get() as any;
  return row?.value === "dine_in" ? "dine_in" : "takeaway";
}

/**
 * The order type a sale is billed as. Absent / blank falls back to the shop's
 * default (an older till page that predates the toggle sends nothing); anything
 * else that is not one of the two is refused rather than guessed.
 */
export function resolveOrderType(raw: unknown): OrderType {
  const v = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!v) return defaultOrderType();
  if (v === "dine_in" || v === "takeaway") return v;
  throw new Error("Order type must be dine-in or takeaway.");
}

/**
 * Take the packing a sale uses out of stock. Plain, not its own transaction:
 * createBill() calls it inside the sale transaction, after the bill is written.
 */
export function deductPacking(params: {
  bill_id: number;
  token_number: number;
  order_type: OrderType;
  items: { product_id: number; quantity: number }[];
  user_id: number;
}): void {
  const db = getDb();
  const qtyByProduct = new Map<number, number>();
  for (const it of params.items) {
    const pid = Number(it.product_id);
    const qty = Number(it.quantity);
    if (!pid || !(qty > 0)) continue;
    qtyByProduct.set(pid, (qtyByProduct.get(pid) || 0) + qty);
  }
  if (qtyByProduct.size === 0) return;

  const ids = [...qtyByProduct.keys()];
  const links = db.query(`
    SELECT product_id, stock_item_id, quantity, applies_to FROM product_packing_links
    WHERE product_id IN (${ids.map(() => "?").join(",")})
  `).all(...ids) as any[];

  const needs = new Map<number, number>();
  for (const l of links) {
    if (l.applies_to === "takeaway" && params.order_type !== "takeaway") continue;
    const need = (qtyByProduct.get(l.product_id) || 0) * Number(l.quantity);
    if (need > 0) needs.set(l.stock_item_id, (needs.get(l.stock_item_id) || 0) + need);
  }
  if (needs.size === 0) return;

  const label = orderTypeLabel(params.order_type).toLowerCase();
  const shortfalls: any[] = [];
  for (const [stockItemId, rawNeed] of needs) {
    const need = Math.round(rawNeed * 1000) / 1000;
    const item = db.query("SELECT name, unit, quantity FROM stock_items WHERE id = ?").get(stockItemId) as any;
    if (!item) continue;
    const onHand = Math.max(0, Number(item.quantity) || 0);
    const take = Math.min(need, onHand);
    const short = Math.round((need - take) * 1000) / 1000;
    if (take > 0) {
      const ref = `Bill #${params.token_number} (${label}) — packing` +
        (short > 0 ? ` — needed ${need}, only ${onHand} recorded` : "");
      db.query(
        "INSERT INTO stock_transactions (stock_item_id, type, quantity, reference, user_id) VALUES (?, 'usage', ?, ?, ?)"
      ).run(stockItemId, -take, ref, params.user_id);
      db.query(
        "UPDATE stock_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(Math.round((onHand - take) * 1e6) / 1e6, stockItemId);
    }
    if (short > 0) shortfalls.push({ stock_item_id: stockItemId, name: item.name, needed: need, taken: take, short });
  }
  if (shortfalls.length) {
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'packing_shortfall', ?)").run(
      params.user_id, JSON.stringify({ bill_id: params.bill_id, token: params.token_number, order_type: params.order_type, items: shortfalls })
    );
  }
}
