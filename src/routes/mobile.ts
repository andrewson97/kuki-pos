import { Hono } from "hono";
import { getDb } from "../db/database";
import { todayDate } from "../utils/helpers";
import { getStockAlerts } from "../services/stock";

const mobile = new Hono();

// Single batched endpoint so the mobile dashboard makes one network call.
mobile.get("/dashboard", (c) => {
  const db = getDb();
  const today = todayDate();

  const todaySales = db.query(`
    SELECT COUNT(*) AS bill_count, COALESCE(SUM(total), 0) AS total_sales
    FROM bills WHERE bill_date = ? AND status = 'completed'
  `).get(today) as any;

  const todayCost = db.query(`
    SELECT COALESCE(SUM(bi.cost_price * bi.quantity), 0) AS total_cost
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    WHERE b.bill_date = ? AND b.status = 'completed'
  `).get(today) as any;

  const todayExpensesApproved = db.query(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM expenses WHERE expense_date = ? AND status = 'approved'
  `).get(today) as any;

  const pendingExpenses = db.query(`
    SELECT e.id, e.amount, e.description, e.payment_source, e.expense_date, e.created_at,
           ec.name AS category_name, u.full_name AS submitted_by
    FROM expenses e
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    LEFT JOIN users u ON u.id = e.user_id
    WHERE e.status = 'pending'
    ORDER BY e.created_at DESC
  `).all();

  const tasks = db.query(`
    SELECT t.id, t.title, t.category, c.id AS completion_id
    FROM daily_tasks t
    LEFT JOIN daily_task_completions c
      ON c.task_id = t.id AND c.business_date = ?
    WHERE t.is_active = 1
    ORDER BY CASE t.category WHEN 'opening' THEN 0 ELSE 1 END, t.display_order, t.id
  `).all(today) as any[];

  const opening = tasks.filter(t => (t.category || 'opening') === 'opening');
  const closing = tasks.filter(t => t.category === 'closing');
  const taskSummary = {
    opening: { done: opening.filter(t => t.completion_id != null).length, total: opening.length },
    closing: { done: closing.filter(t => t.completion_id != null).length, total: closing.length },
  };

  // Same two lists as the desktop dashboard, from the same query, so the phone
  // and the laptop can never disagree about what is out of stock. Kept whole
  // rather than trimmed to the top few: low_stock_count has to match the list
  // it counts, and the view decides how many rows to show.
  const { low_stock_items, out_of_stock_earlier } = getStockAlerts(today);

  return c.json({
    date: today,
    today: {
      sales: todaySales.total_sales,
      bills: todaySales.bill_count,
      cost: todayCost.total_cost,
      profit: todaySales.total_sales - todayCost.total_cost,
      expenses_approved: todayExpensesApproved.total,
      net: todaySales.total_sales - todayCost.total_cost - todayExpensesApproved.total,
    },
    pending_expenses: pendingExpenses,
    tasks: taskSummary,
    // `low_stock` keeps its name — views/mobile.html reads it — and the second
    // list rides alongside under the shared contract name.
    low_stock: low_stock_items,
    low_stock_count: low_stock_items.length,
    out_of_stock_earlier,
    out_of_stock_earlier_count: out_of_stock_earlier.length,
  });
});

export default mobile;
