import { Hono } from "hono";
import { getDb } from "../db/database";
import { todayDate } from "../utils/helpers";
import { getStockAlerts } from "../services/stock";

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

  // Stock alerts — ingredients (stock_items) and tracked products in two lists:
  // what needs attention now (low, plus anything that went out TODAY) and what
  // has been out since before today. Neither list is truncated, so
  // low_stock_count is exactly what the list shows.
  const { low_stock_items, out_of_stock_earlier } = getStockAlerts(today);

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
    low_stock_count: low_stock_items.length,
    total_products: totalProducts.count,
    total_customers: totalCustomers.count,
    recent_bills: recentBills,
    low_stock_items,
    out_of_stock_earlier,
    out_of_stock_earlier_count: out_of_stock_earlier.length,
  });
});

export default dashboard;
