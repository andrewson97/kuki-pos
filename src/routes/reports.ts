import { Hono } from "hono";
import { getDb } from "../db/database";
import { todayDate } from "../utils/helpers";
import { costOfGoods, dailySales, money, moneyReceivedByMethod, salesSummary } from "../services/sales";

const reports = new Hono();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Sales, refunds, cost of goods and the payment split all come from
// ../services/sales — see the rule for refunds at the top of that file. In
// short: `sales.total_sales` is GROSS (completed + later-refunded bills, on
// their sale day), `sales.total_refunds` is what went back on each refund's own
// day, and every profit figure starts from `sales.net_sales`. `by_payment` is
// money RECEIVED by method (deposits on their own day and method, refunds
// subtracted on theirs), so it does not sum to the sales total.
//
// Top products deliberately stay on completed + refunded bills by SALE date:
// they answer "what did we make and hand over", and a refund days later does
// not un-bake the cake. They therefore reconcile with the GROSS total.
const TOP_PRODUCTS_SOLD = "b.status IN ('completed', 'refunded')";

reports.get("/daily", (c) => {
  const db = getDb();
  const date = c.req.query("date") || todayDate();

  const sales = salesSummary(date, date);
  const byPayment = moneyReceivedByMethod(date, date);

  const topProducts = db.query(`
    SELECT bi.product_name, SUM(bi.quantity) as total_qty, SUM(bi.total) as total_revenue,
           SUM(bi.cost_price * bi.quantity) as total_cost
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    WHERE b.bill_date = ? AND ${TOP_PRODUCTS_SOLD}
    GROUP BY bi.product_name
    ORDER BY total_qty DESC, product_name ASC
  `).all(date);

  const totalCost = costOfGoods(date, date);

  const expenses = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total_expenses
    FROM expenses WHERE expense_date = ? AND status = 'approved'
  `).get(date) as any;

  const disposals = db.query(`
    SELECT COALESCE(SUM(cost_loss), 0) AS total_loss, COUNT(*) AS count
    FROM product_disposals WHERE business_date = ?
  `).get(date) as any;

  const disposalItems = db.query(`
    SELECT d.quantity, d.cost_loss, d.reason, d.created_at, p.name AS product_name, u.full_name AS user_name
    FROM product_disposals d
    LEFT JOIN products p ON p.id = d.product_id
    LEFT JOIN users u ON u.id = d.user_id
    WHERE d.business_date = ?
    ORDER BY d.created_at DESC
  `).all(date);

  const grossProfit = money(sales.net_sales - totalCost.total_cost);

  return c.json({
    date,
    sales,
    refunds: sales.total_refunds,
    net_sales: sales.net_sales,
    cost_of_goods: totalCost.total_cost,
    cost_of_goods_restocked: totalCost.restocked_cost,
    gross_profit: grossProfit,
    by_payment: byPayment,
    top_products: topProducts,
    expenses: expenses.total_expenses,
    disposal_loss: disposals.total_loss,
    disposal_count: disposals.count,
    disposals: disposalItems,
  });
});

reports.get("/monthly", (c) => {
  const db = getDb();
  const month = c.req.query("month") || (new Date().getMonth() + 1).toString().padStart(2, "0");
  const year = c.req.query("year") || new Date().getFullYear().toString();
  const prefix = `${year}-${month}`;
  // The same month as an inclusive business-date window, for the shared sales
  // figures. "-31" is a plain string bound, so it covers every month length.
  const monthStart = `${prefix}-01`;
  const monthEnd = `${prefix}-31`;

  const sales = salesSummary(monthStart, monthEnd);
  const daily = dailySales(monthStart, monthEnd);
  const byPayment = moneyReceivedByMethod(monthStart, monthEnd);

  const expenses = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total_expenses
    FROM expenses WHERE expense_date LIKE ? AND status = 'approved'
  `).get(`${prefix}%`) as any;

  const expensesByCategory = db.query(`
    SELECT ec.name as category, SUM(e.amount) as total
    FROM expenses e
    JOIN expense_categories ec ON e.category_id = ec.id
    WHERE e.expense_date LIKE ? AND e.status = 'approved'
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
    WHERE b.bill_date LIKE ? AND ${TOP_PRODUCTS_SOLD}
    GROUP BY bi.product_name
    ORDER BY total_revenue DESC, product_name ASC
  `).all(`${prefix}%`);

  const totalCost = costOfGoods(monthStart, monthEnd);

  // Wastage is a real cost of the month, so it comes off net profit here exactly
  // as it does in /range. These two reports disagreeing over the same period was
  // the bug: a month and a custom range covering it returned different figures.
  const disposals = db.query(`
    SELECT COALESCE(SUM(cost_loss), 0) AS total_loss, COUNT(*) AS count
    FROM product_disposals WHERE business_date LIKE ?
  `).get(`${prefix}%`) as any;

  const grossProfit = money(sales.net_sales - totalCost.total_cost);
  const totalIncome = money(sales.net_sales + otherIncome.total_income);
  const netProfit = money(
    totalIncome - totalCost.total_cost - expenses.total_expenses - disposals.total_loss
  );

  return c.json({
    month: prefix,
    sales,
    refunds: sales.total_refunds,
    net_sales: sales.net_sales,
    cost_of_goods: totalCost.total_cost,
    cost_of_goods_restocked: totalCost.restocked_cost,
    gross_profit: grossProfit,
    by_payment: byPayment,
    daily_sales: daily,
    expenses: { total: expenses.total_expenses, by_category: expensesByCategory },
    other_income: otherIncome.total_income,
    total_income: totalIncome,
    net_profit: netProfit,
    disposal_loss: disposals.total_loss,
    disposal_count: disposals.count,
    top_products: topProducts,
  });
});

reports.get("/range", (c) => {
  const db = getDb();

  const rawEnd = c.req.query("end_date");
  const rawStart = c.req.query("start_date");

  if (rawEnd && !DATE_RE.test(rawEnd)) {
    return c.json({ error: "Invalid end_date, expected YYYY-MM-DD" }, 400);
  }
  if (rawStart && !DATE_RE.test(rawStart)) {
    return c.json({ error: "Invalid start_date, expected YYYY-MM-DD" }, 400);
  }

  let endDate = rawEnd || todayDate();
  let startDate = rawStart || endDate;
  // Swap instead of erroring so a back-to-front range still produces a report
  if (startDate > endDate) {
    const swap = startDate;
    startDate = endDate;
    endDate = swap;
  }

  const days =
    Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000
    ) + 1;

  // Every query below filters the same inclusive [start_date, end_date] window
  const params: any[] = [startDate, endDate];

  const sales = salesSummary(startDate, endDate);
  const byPayment = moneyReceivedByMethod(startDate, endDate);
  const daily = dailySales(startDate, endDate);
  const totalCost = costOfGoods(startDate, endDate);

  const expenses = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total_expenses
    FROM expenses WHERE expense_date >= ? AND expense_date <= ? AND status = 'approved'
  `).get(...params) as any;

  const expensesByCategory = db.query(`
    SELECT ec.name as category, COALESCE(SUM(e.amount), 0) as total
    FROM expenses e
    JOIN expense_categories ec ON e.category_id = ec.id
    WHERE e.expense_date >= ? AND e.expense_date <= ? AND e.status = 'approved'
    GROUP BY ec.name ORDER BY total DESC
  `).all(...params);

  const otherIncome = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total_income
    FROM income WHERE income_date >= ? AND income_date <= ?
  `).get(...params) as any;

  const disposals = db.query(`
    SELECT COALESCE(SUM(cost_loss), 0) AS total_loss, COUNT(*) AS count
    FROM product_disposals WHERE business_date >= ? AND business_date <= ?
  `).get(...params) as any;

  const topProducts = db.query(`
    SELECT bi.product_name, COALESCE(SUM(bi.quantity), 0) as total_qty,
           COALESCE(SUM(bi.total), 0) as total_revenue,
           COALESCE(SUM(bi.cost_price * bi.quantity), 0) as total_cost
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    WHERE b.bill_date >= ? AND b.bill_date <= ? AND ${TOP_PRODUCTS_SOLD}
    GROUP BY bi.product_name
    ORDER BY total_revenue DESC, product_name ASC
  `).all(...params);

  const grossProfit = money(sales.net_sales - totalCost.total_cost);
  const totalIncome = money(sales.net_sales + otherIncome.total_income);
  // Same as /monthly: disposal (wastage) loss comes off net profit too
  const netProfit = money(
    totalIncome - totalCost.total_cost - expenses.total_expenses - disposals.total_loss
  );

  return c.json({
    start_date: startDate,
    end_date: endDate,
    days,
    sales,
    refunds: sales.total_refunds,
    net_sales: sales.net_sales,
    cost_of_goods: totalCost.total_cost,
    cost_of_goods_restocked: totalCost.restocked_cost,
    gross_profit: grossProfit,
    by_payment: byPayment,
    daily_sales: daily,
    expenses: { total: expenses.total_expenses, by_category: expensesByCategory },
    other_income: otherIncome.total_income,
    total_income: totalIncome,
    net_profit: netProfit,
    disposal_loss: disposals.total_loss,
    disposal_count: disposals.count,
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
    WHERE b.bill_date >= date('now', '-' || ? || ' days') AND ${TOP_PRODUCTS_SOLD}
    GROUP BY bi.product_name
    ORDER BY total_revenue DESC, product_name ASC
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
