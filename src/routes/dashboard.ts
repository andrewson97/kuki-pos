import { Hono } from "hono";
import { getDb } from "../db/database";
import { todayDate } from "../utils/helpers";

const dashboard = new Hono();

dashboard.get("/stats", (c) => {
  const db = getDb();
  const today = todayDate();

  const todaySales = db.query(`
    SELECT COUNT(*) as bill_count, COALESCE(SUM(total), 0) as total_sales
    FROM bills WHERE bill_date = ? AND status = 'completed'
  `).get(today) as any;

  const todayExpenses = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM expenses WHERE expense_date = ? AND status = 'approved'
  `).get(today) as any;

  const lowStockCount = db.query(`
    SELECT
      (SELECT COUNT(*) FROM stock_items WHERE quantity <= reorder_level AND reorder_level > 0)
      +
      (SELECT COUNT(*) FROM products WHERE track_stock = 1 AND is_active = 1 AND stock_quantity <= stock_reorder_level)
      AS count
  `).get() as any;

  const totalProducts = db.query("SELECT COUNT(*) as count FROM products WHERE is_active = 1").get() as any;
  const totalCustomers = db.query("SELECT COUNT(*) as count FROM customers").get() as any;

  // Recent bills
  const recentBills = db.query(`
    SELECT b.id, b.token_number, b.total, b.payment_method, b.created_at, c.name as customer_name
    FROM bills b
    LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.bill_date = ? AND b.status = 'completed'
    ORDER BY b.created_at DESC
    LIMIT 10
  `).all(today);

  // Low stock — combine ingredients (stock_items) and tracked products.
  const lowIngredients = db.query(`
    SELECT 'ingredient' AS kind, si.name, si.quantity, si.unit, si.reorder_level, sc.name AS category_name
    FROM stock_items si
    LEFT JOIN stock_categories sc ON si.category_id = sc.id
    WHERE si.quantity <= si.reorder_level AND si.reorder_level > 0
  `).all() as any[];
  const lowProducts = db.query(`
    SELECT 'product' AS kind, name, stock_quantity AS quantity, 'unit' AS unit,
           stock_reorder_level AS reorder_level, category AS category_name
    FROM products
    WHERE track_stock = 1 AND is_active = 1 AND stock_quantity <= stock_reorder_level
  `).all() as any[];
  const lowStockItems = [...lowIngredients, ...lowProducts]
    .sort((a, b) => (a.quantity / Math.max(1, a.reorder_level)) - (b.quantity / Math.max(1, b.reorder_level)))
    .slice(0, 10);

  const todayCost = db.query(`
    SELECT COALESCE(SUM(bi.cost_price * bi.quantity), 0) as total_cost
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    WHERE b.bill_date = ? AND b.status = 'completed'
  `).get(today) as any;

  return c.json({
    today: {
      sales: todaySales.total_sales,
      bill_count: todaySales.bill_count,
      cost_of_goods: todayCost.total_cost,
      gross_profit: todaySales.total_sales - todayCost.total_cost,
      expenses: todayExpenses.total,
      net_profit: todaySales.total_sales - todayCost.total_cost - todayExpenses.total,
    },
    low_stock_count: lowStockCount.count,
    total_products: totalProducts.count,
    total_customers: totalCustomers.count,
    recent_bills: recentBills,
    low_stock_items: lowStockItems,
  });
});

export default dashboard;
