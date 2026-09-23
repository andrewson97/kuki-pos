import { getDb } from "../db/database";
import { todayDate } from "../utils/helpers";

export function deductStockForBill(productId: number, quantity: number, billId: number, userId: number): void {
  const db = getDb();
  const recipe = db.query(
    "SELECT stock_item_id, quantity_needed FROM recipes WHERE product_id = ?"
  ).all(productId) as { stock_item_id: number; quantity_needed: number }[];

  for (const item of recipe) {
    const totalNeeded = item.quantity_needed * quantity;
    db.query(
      "UPDATE stock_items SET quantity = quantity - ?, updated_at = datetime('now') WHERE id = ?"
    ).run(totalNeeded, item.stock_item_id);
    db.query(
      "INSERT INTO stock_transactions (stock_item_id, type, quantity, reference, user_id) VALUES (?, 'usage', ?, ?, ?)"
    ).run(item.stock_item_id, -totalNeeded, `Bill #${billId}`, userId);
  }
}

export function restoreStockForBill(productId: number, quantity: number, billId: number, userId: number): void {
  const db = getDb();
  const recipe = db.query(
    "SELECT stock_item_id, quantity_needed FROM recipes WHERE product_id = ?"
  ).all(productId) as { stock_item_id: number; quantity_needed: number }[];

  for (const item of recipe) {
    const totalReturned = item.quantity_needed * quantity;
    db.query(
      "UPDATE stock_items SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?"
    ).run(totalReturned, item.stock_item_id);
    db.query(
      "INSERT INTO stock_transactions (stock_item_id, type, quantity, reference, user_id) VALUES (?, 'adjustment', ?, ?, ?)"
    ).run(item.stock_item_id, totalReturned, `Refund Bill #${billId}`, userId);
  }
}

export function getLowStockItems(): any[] {
  const db = getDb();
  return db.query(
    "SELECT si.*, sc.name as category_name FROM stock_items si LEFT JOIN stock_categories sc ON si.category_id = sc.id WHERE si.quantity <= si.reorder_level AND si.reorder_level > 0"
  ).all();
}

// --- Dashboard stock alerts (shared by /api/dashboard/stats and /api/mobile/dashboard) ---

// UTC timestamp -> Asia/Colombo business date (5 AM rollover). Same algebra as
// src/routes/history.ts: Colombo is UTC+5:30 and the business day rolls over at
// 05:00 local, so the business date is the UTC date shifted by
// +5:30 - 5:00 = +30 minutes. todayDate() stays the single source of truth for
// what "today" is; this only converts a stored UTC column to the same scale.
const BIZ_DATE = (col: string) => `date(${col}, '+30 minutes')`;

export interface StockAlertRow {
  kind: "product" | "ingredient";
  id: number;
  name: string;
  quantity: number;
  unit: string;
  reorder_level: number;
  category_name: string | null;
  /** 'out' when quantity <= 0, otherwise 'low'. Pre-derived so the UI never has to. */
  state: "low" | "out";
  /** Business date (YYYY-MM-DD) this item's stock last changed, or null if unknown. */
  since: string | null;
}

export interface StockAlerts {
  /** Needs attention now: everything low, plus everything that went out TODAY. */
  low_stock_items: StockAlertRow[];
  /** Out of stock since before today — or for an unknown length of time. */
  out_of_stock_earlier: StockAlertRow[];
}

// An item qualifies when it is LOW (still has stock but is at or under a real
// threshold) or when it is OUT (nothing left). The `reorder_level > 0` guard is
// kept for the LOW case on purpose — an item with no threshold set is never
// "low" — but zero stock is zero whether a threshold was configured or not, so
// OUT stands on its own.
const ALERT_INGREDIENTS_SQL = `
  SELECT 'ingredient' AS kind, si.id, si.name, si.quantity, si.unit, si.reorder_level,
         sc.name AS category_name,
         CASE WHEN si.quantity <= 0 THEN 'out' ELSE 'low' END AS state,
         ${BIZ_DATE("si.updated_at")} AS since
  FROM stock_items si
  LEFT JOIN stock_categories sc ON si.category_id = sc.id
  WHERE si.quantity <= 0
     OR (si.reorder_level > 0 AND si.quantity <= si.reorder_level)
`;

// is_active = 1 keeps inactive products out, and discontinued products always
// carry is_active = 0, so they are excluded twice over — is_discontinued = 0 is
// spelled out anyway so a future change to one flag cannot quietly leak
// dead products onto the owner's alert list.
const ALERT_PRODUCTS_SQL = `
  SELECT 'product' AS kind, id, name, stock_quantity AS quantity, 'unit' AS unit,
         stock_reorder_level AS reorder_level, category AS category_name,
         CASE WHEN stock_quantity <= 0 THEN 'out' ELSE 'low' END AS state,
         ${BIZ_DATE("stock_updated_at")} AS since
  FROM products
  WHERE track_stock = 1 AND is_active = 1 AND is_discontinued = 0
    AND (stock_quantity <= 0
         OR (stock_reorder_level > 0 AND stock_quantity <= stock_reorder_level))
`;

/**
 * The two stock lists the dashboards show, over ingredients and tracked
 * products alike.
 *
 * Ordering is "most urgent first" in both lists:
 *  - low_stock_items by how far below its threshold an item is
 *    (quantity / reorder_level), so anything at zero — ratio <= 0 — floats to
 *    the top, then the deepest shortfalls, then ties by name.
 *  - out_of_stock_earlier oldest first, so the thing that has been missing
 *    longest leads. Rows with an unknown date sort last: they cannot be ranked
 *    against real dates, and they are the legacy rows nobody has touched.
 */
export function getStockAlerts(today: string = todayDate()): StockAlerts {
  const db = getDb();
  const rows = [
    ...(db.query(ALERT_INGREDIENTS_SQL).all() as StockAlertRow[]),
    ...(db.query(ALERT_PRODUCTS_SQL).all() as StockAlertRow[]),
  ];

  // A row is "out earlier" only when it is out AND we can see that its stock
  // last moved before today. A NULL `since` means we have no record of when it
  // ran out — and if we do not know, it was not today, so it belongs here
  // rather than on the "needs attention now" list.
  const outEarlier = (r: StockAlertRow) =>
    r.state === "out" && (r.since == null || r.since < today);

  const urgency = (r: StockAlertRow) => r.quantity / Math.max(1, r.reorder_level);

  const low_stock_items = rows
    .filter(r => !outEarlier(r))
    .sort((a, b) => urgency(a) - urgency(b) || a.name.localeCompare(b.name));

  const out_of_stock_earlier = rows
    .filter(outEarlier)
    .sort((a, b) =>
      (a.since == null ? 1 : 0) - (b.since == null ? 1 : 0) ||
      (a.since ?? "").localeCompare(b.since ?? "") ||
      a.name.localeCompare(b.name));

  return { low_stock_items, out_of_stock_earlier };
}

export function getProductCost(productId: number): number {
  const db = getDb();
  const items = db.query(
    "SELECT r.quantity_needed, si.cost_per_unit FROM recipes r JOIN stock_items si ON r.stock_item_id = si.id WHERE r.product_id = ?"
  ).all(productId) as { quantity_needed: number; cost_per_unit: number }[];
  return items.reduce((sum, i) => sum + i.quantity_needed * i.cost_per_unit, 0);
}
