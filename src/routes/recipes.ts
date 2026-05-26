import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly } from "../middleware/auth";
import { getProductCost } from "../services/stock";

const recipes = new Hono();

recipes.get("/:productId", (c) => {
  const db = getDb();
  const items = db.query(`
    SELECT r.*, si.name as stock_item_name, si.unit, si.cost_per_unit
    FROM recipes r
    JOIN stock_items si ON r.stock_item_id = si.id
    WHERE r.product_id = ?
  `).all(c.req.param("productId"));
  const cost = getProductCost(Number(c.req.param("productId")));
  return c.json({ items, total_cost: cost });
});

recipes.post("/:productId", adminOnly, async (c) => {
  const productId = c.req.param("productId");
  const { ingredients } = await c.req.json();
  const db = getDb();

  // Replace all recipe items for this product
  const transaction = db.transaction(() => {
    db.query("DELETE FROM recipes WHERE product_id = ?").run(productId);
    for (const ing of ingredients) {
      db.query(
        "INSERT INTO recipes (product_id, stock_item_id, quantity_needed) VALUES (?, ?, ?)"
      ).run(productId, ing.stock_item_id, ing.quantity_needed);
    }
  });
  transaction();

  const cost = getProductCost(Number(productId));
  return c.json({ success: true, total_cost: cost });
});

export default recipes;
