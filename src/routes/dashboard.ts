import { Hono } from "hono";
import { getDb } from "../db/database";
import { canSeeDashboardMoney, getUser } from "../middleware/auth";
import { todayDate } from "../utils/helpers";
import { getStockAlerts } from "../services/stock";
import { costOfGoods, money, moneyReceivedByMethod, salesSummary } from "../services/sales";

const dashboard = new Hono();

dashboard.get("/stats", (c) => {
  const db = getDb();
  const today = todayDate();

  // The day's takings are shown to admins, and to a cashier only if an admin
  // has turned "Show today's money on the dashboard" on for them (Users page) —
  // see canSeeDashboardMoney(). Applied per field instead of per route: every
  // cashier still needs the bill count, the stock alerts and the recent bills
  // off this endpoint, so the route itself stays open and the money is left out
  // of the response. Hiding it in the view alone would not hide it at all —
  // anyone can open /api/dashboard/stats.
  const user = getUser(c);
  const showMoney = canSeeDashboardMoney(user);

  // Same figures as /api/reports/daily for today (../services/sales): gross
  // sales on the sale day, refunds on the refund day, net = gross - refunds.
  // bill_count is every bill sold today, refunded since or not.
  const todaySales = salesSummary(today, today);

  const todayExpenses = showMoney ? db.query(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM expenses WHERE expense_date = ? AND status = 'approved'
  `).get(today) as any : null;

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

  const todayCost = showMoney ? costOfGoods(today, today) : null;

  // Omitted, not nulled: a missing key is the only answer a caller cannot
  // mistake for a figure, and `null` would reach formatCurrency() as "Rs. 0.00"
  // — a wrong number is worse than no number. The view drops the money tiles
  // for a cashier, so nothing is left reading `today.sales`.
  //
  // `sales` stays the headline figure, and is now NET of refunds handed back
  // today; gross_sales and refunds are the two halves of it. by_payment is money
  // RECEIVED today by method (deposits included, refunds subtracted), so it does
  // not have to add up to `sales`.
  const todayStats = showMoney
    ? {
        sales: todaySales.net_sales,
        gross_sales: todaySales.total_sales,
        refunds: todaySales.total_refunds,
        refund_count: todaySales.refund_count,
        bill_count: todaySales.bill_count,
        cost_of_goods: todayCost!.total_cost,
        gross_profit: money(todaySales.net_sales - todayCost!.total_cost),
        expenses: todayExpenses.total,
        net_profit: money(todaySales.net_sales - todayCost!.total_cost - todayExpenses.total),
        by_payment: moneyReceivedByMethod(today, today),
      }
    : { bill_count: todaySales.bill_count };

  return c.json({
    today: todayStats,
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
