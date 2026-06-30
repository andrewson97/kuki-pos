import { Hono } from "hono";
import { getDb } from "../db/database";
import { todayDate } from "../utils/helpers";

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

  const lowIngredients = db.query(`
    SELECT 'ingredient' AS kind, id, name, quantity, unit, reorder_level
    FROM stock_items
    WHERE quantity <= reorder_level AND reorder_level > 0
  `).all() as any[];
  const lowProducts = db.query(`
    SELECT 'product' AS kind, id, name, stock_quantity AS quantity, 'unit' AS unit, stock_reorder_level AS reorder_level
    FROM products
    WHERE track_stock = 1 AND is_active = 1 AND stock_quantity <= stock_reorder_level
  `).all() as any[];
  const lowStock = [...lowIngredients, ...lowProducts]
    .sort((a, b) => (a.quantity / Math.max(1, a.reorder_level)) - (b.quantity / Math.max(1, b.reorder_level)))
    .slice(0, 5);

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
    low_stock: lowStock,
  });
});

export default mobile;
