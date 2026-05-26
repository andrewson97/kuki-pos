import { getDb } from "../db/database";

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

export function getLowStockItems(): any[] {
  const db = getDb();
  return db.query(
    "SELECT si.*, sc.name as category_name FROM stock_items si LEFT JOIN stock_categories sc ON si.category_id = sc.id WHERE si.quantity <= si.reorder_level AND si.reorder_level > 0"
  ).all();
}

export function getProductCost(productId: number): number {
  const db = getDb();
  const items = db.query(
    "SELECT r.quantity_needed, si.cost_per_unit FROM recipes r JOIN stock_items si ON r.stock_item_id = si.id WHERE r.product_id = ?"
  ).all(productId) as { quantity_needed: number; cost_per_unit: number }[];
  return items.reduce((sum, i) => sum + i.quantity_needed * i.cost_per_unit, 0);
}
