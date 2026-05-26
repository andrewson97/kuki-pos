import { Hono } from "hono";
import { getDb } from "../db/database";
import { todayDate } from "../utils/helpers";

const reports = new Hono();

reports.get("/daily", (c) => {
  const db = getDb();
  const date = c.req.query("date") || todayDate();

  const sales = db.query(`
    SELECT COUNT(*) as bill_count, COALESCE(SUM(total), 0) as total_sales,
           COALESCE(SUM(discount), 0) as total_discount, COALESCE(SUM(tax_amount), 0) as total_tax
    FROM bills WHERE bill_date = ? AND status = 'completed'
  `).get(date) as any;

  const byPayment = db.query(`
    SELECT payment_method, COUNT(*) as count, SUM(total) as total
    FROM bills WHERE bill_date = ? AND status = 'completed'
    GROUP BY payment_method
  `).all(date);

  const topProducts = db.query(`
    SELECT bi.product_name, SUM(bi.quantity) as total_qty, SUM(bi.total) as total_revenue,
           SUM(bi.cost_price * bi.quantity) as total_cost
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    WHERE b.bill_date = ? AND b.status = 'completed'
    GROUP BY bi.product_name
    ORDER BY total_qty DESC
    LIMIT 10
  `).all(date);

  const totalCost = db.query(`
    SELECT COALESCE(SUM(bi.cost_price * bi.quantity), 0) as total_cost
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    WHERE b.bill_date = ? AND b.status = 'completed'
  `).get(date) as any;

  const expenses = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total_expenses
    FROM expenses WHERE expense_date = ?
  `).get(date) as any;

  const grossProfit = sales.total_sales - totalCost.total_cost;

  return c.json({ date, sales, cost_of_goods: totalCost.total_cost, gross_profit: grossProfit, by_payment: byPayment, top_products: topProducts, expenses: expenses.total_expenses });
});

reports.get("/monthly", (c) => {
  const db = getDb();
  const month = c.req.query("month") || (new Date().getMonth() + 1).toString().padStart(2, "0");
  const year = c.req.query("year") || new Date().getFullYear().toString();
  const prefix = `${year}-${month}`;

  const sales = db.query(`
    SELECT COUNT(*) as bill_count, COALESCE(SUM(total), 0) as total_sales,
           COALESCE(SUM(discount), 0) as total_discount, COALESCE(SUM(tax_amount), 0) as total_tax
    FROM bills WHERE bill_date LIKE ? AND status = 'completed'
  `).get(`${prefix}%`) as any;

  const dailySales = db.query(`
    SELECT bill_date, COUNT(*) as bill_count, SUM(total) as total_sales
    FROM bills WHERE bill_date LIKE ? AND status = 'completed'
    GROUP BY bill_date ORDER BY bill_date
  `).all(`${prefix}%`);

  const expenses = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total_expenses
    FROM expenses WHERE expense_date LIKE ?
  `).get(`${prefix}%`) as any;

  const expensesByCategory = db.query(`
    SELECT ec.name as category, SUM(e.amount) as total
    FROM expenses e
    JOIN expense_categories ec ON e.category_id = ec.id
    WHERE e.expense_date LIKE ?
    GROUP BY ec.name ORDER BY total DESC
  `).all(`${prefix}%`);

  const otherIncome = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total_income
    FROM income WHERE income_date LIKE ?
  `).get(`${prefix}%`) as any;

  const topProducts = db.query(`
    SELECT bi.product_name, SUM(bi.quantity) as total_qty, SUM(bi.total) as total_revenue,
           SUM(bi.cost_price * bi.quantity) as total_cost
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    WHERE b.bill_date LIKE ? AND b.status = 'completed'
    GROUP BY bi.product_name
    ORDER BY total_revenue DESC
    LIMIT 10
  `).all(`${prefix}%`);

  const totalCost = db.query(`
    SELECT COALESCE(SUM(bi.cost_price * bi.quantity), 0) as total_cost
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    WHERE b.bill_date LIKE ? AND b.status = 'completed'
  `).get(`${prefix}%`) as any;

  const grossProfit = sales.total_sales - totalCost.total_cost;
  const totalIncome = sales.total_sales + otherIncome.total_income;
  const netProfit = totalIncome - totalCost.total_cost - expenses.total_expenses;

  return c.json({
    month: prefix,
    sales,
    cost_of_goods: totalCost.total_cost,
    gross_profit: grossProfit,
    daily_sales: dailySales,
    expenses: { total: expenses.total_expenses, by_category: expensesByCategory },
    other_income: otherIncome.total_income,
    total_income: totalIncome,
    net_profit: netProfit,
    top_products: topProducts,
  });
});

reports.get("/top-products", (c) => {
  const db = getDb();
  const days = parseInt(c.req.query("days") || "30");
  const products = db.query(`
    SELECT bi.product_name, SUM(bi.quantity) as total_qty, SUM(bi.total) as total_revenue,
           SUM(bi.cost_price * bi.quantity) as total_cost
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    WHERE b.bill_date >= date('now', '-' || ? || ' days') AND b.status = 'completed'
    GROUP BY bi.product_name
    ORDER BY total_revenue DESC
    LIMIT 20
  `).all(days);
  return c.json(products);
});

reports.get("/stock-summary", (c) => {
  const db = getDb();
  const items = db.query(`
    SELECT si.*, sc.name as category_name,
           CASE WHEN si.reorder_level > 0 AND si.quantity <= si.reorder_level THEN 1 ELSE 0 END as is_low
    FROM stock_items si
    LEFT JOIN stock_categories sc ON si.category_id = sc.id
    ORDER BY is_low DESC, sc.name, si.name
  `).all();
  return c.json(items);
});

export default reports;
