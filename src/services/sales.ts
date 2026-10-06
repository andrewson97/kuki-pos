import { getDb } from "../db/database";

// ---------------------------------------------------------------------------
// Sales figures shared by /api/reports/*, /api/dashboard/stats and
// /api/mobile/dashboard, so the three can never disagree about the same day.
//
// Every function takes an inclusive [start, end] window of BUSINESS dates
// ("YYYY-MM-DD", 5 AM Asia/Colombo rollover — see todayDate()). A single day is
// start === end; a month is `${YYYY-MM}-01` .. `${YYYY-MM}-31` (plain string
// comparison, so a short month simply has no rows after its last day).
//
// THE RULE FOR REFUNDS (it used to be "a refunded bill vanishes"):
//   Every report filtered status = 'completed' by bill_date, so refunding an
//   Oct 1 bill on Oct 5 quietly lowered Oct 1 — a day that had already been
//   closed and reconciled — and Oct 5 showed nothing at all, although the money
//   left the shop that day. Now:
//     * gross sales  = bills with status IN ('completed','refunded') on their
//                      bill_date. The sale happened; that day keeps it.
//     * refunds      = refunded bills on the business date of refunded_at, as
//                      their own figure.
//     * net sales    = gross - refunds.
//   'cancelled' bills were never sales and stay out of everything.
//
// Cost of goods follows the same split: a refunded bill's items stay a cost on
// the sale day (the cake was made and handed over), and only if the refund put
// the items back into stock (bills.refund_restocked = 1) does that bill's item
// cost come back off cost of goods — on the refund day, beside the refund.
// ---------------------------------------------------------------------------

// UTC timestamp -> Asia/Colombo business date. Same algebra as
// src/services/stock.ts and src/routes/history.ts: Colombo is UTC+5:30 and the
// business day rolls over at 05:00 local, so the shift is +30 minutes.
const BIZ_DATE = (col: string) => `date(${col}, '+30 minutes')`;

// "This bill was a sale." Shared so no query can drift back to 'completed' only.
const SOLD = "b.status IN ('completed', 'refunded')";
// A refunded bill with no refunded_at (a refund recorded before that column
// existed) is treated as refunded on its own sale day. That is exactly how every
// report showed it before this change, and it keeps such a bill from turning
// into a sale with no matching refund now that gross sales include refunded
// bills.
const REFUND_DAY = `CASE WHEN b.refunded_at IS NULL THEN b.bill_date ELSE ${BIZ_DATE("b.refunded_at")} END`;
const IN_REFUND_WINDOW = `b.status = 'refunded' AND ${REFUND_DAY} >= ? AND ${REFUND_DAY} <= ?`;

// Report figures are money; keep them to the cent so a refunded day nets to a
// clean 0.00 rather than -1.8e-12.
export function money(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export interface SalesSummary {
  /** Bills sold in the window (completed + later refunded), by bill_date. */
  bill_count: number;
  /** GROSS sales: the sum of those bills' totals. */
  total_sales: number;
  total_discount: number;
  total_tax: number;
  /** Bills refunded in the window, by the business date of refunded_at. */
  refund_count: number;
  total_refunds: number;
  /** total_sales - total_refunds. The headline "sales" figure on every page. */
  net_sales: number;
}

export function salesSummary(start: string, end: string): SalesSummary {
  const db = getDb();
  const gross = db.query(`
    SELECT COUNT(*) AS bill_count, COALESCE(SUM(b.total), 0) AS total_sales,
           COALESCE(SUM(b.discount), 0) AS total_discount, COALESCE(SUM(b.tax_amount), 0) AS total_tax
    FROM bills b
    WHERE b.bill_date >= ? AND b.bill_date <= ? AND ${SOLD}
  `).get(start, end) as any;
  const refunds = db.query(`
    SELECT COUNT(*) AS refund_count, COALESCE(SUM(b.total), 0) AS total_refunds
    FROM bills b
    WHERE ${IN_REFUND_WINDOW}
  `).get(start, end) as any;
  return {
    bill_count: gross.bill_count,
    total_sales: money(gross.total_sales),
    total_discount: money(gross.total_discount),
    total_tax: money(gross.total_tax),
    refund_count: refunds.refund_count,
    total_refunds: money(refunds.total_refunds),
    net_sales: money(gross.total_sales - refunds.total_refunds),
  };
}

export interface CostOfGoods {
  /** Item cost of every bill sold in the window (refunded or not), by bill_date. */
  sold_cost: number;
  /** Item cost of bills refunded in the window whose refund restocked the items. */
  restocked_cost: number;
  /** sold_cost - restocked_cost: the figure reports subtract from net sales. */
  total_cost: number;
}

export function costOfGoods(start: string, end: string): CostOfGoods {
  const db = getDb();
  const sold = db.query(`
    SELECT COALESCE(SUM(bi.cost_price * bi.quantity), 0) AS total
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    WHERE b.bill_date >= ? AND b.bill_date <= ? AND ${SOLD}
  `).get(start, end) as { total: number };
  const restocked = db.query(`
    SELECT COALESCE(SUM(bi.cost_price * bi.quantity), 0) AS total
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    WHERE ${IN_REFUND_WINDOW} AND b.refund_restocked = 1
  `).get(start, end) as { total: number };
  return {
    sold_cost: money(sold.total),
    restocked_cost: money(restocked.total),
    total_cost: money(sold.total - restocked.total),
  };
}

export interface DailySalesRow {
  bill_date: string;
  bill_count: number;
  /** Gross sales made that day. */
  total_sales: number;
  /** Refunds handed back that day (whatever day the bill was sold). */
  refunds: number;
  net_sales: number;
}

/**
 * One row per business day in the window that had a sale OR a refund, in date
 * order. A day with only a refund gets a row too — with a negative net — since
 * that is the day the money went back.
 */
export function dailySales(start: string, end: string): DailySalesRow[] {
  const db = getDb();
  const gross = db.query(`
    SELECT b.bill_date AS day, COUNT(*) AS bill_count, COALESCE(SUM(b.total), 0) AS total
    FROM bills b
    WHERE b.bill_date >= ? AND b.bill_date <= ? AND ${SOLD}
    GROUP BY b.bill_date
  `).all(start, end) as { day: string; bill_count: number; total: number }[];
  const refunds = db.query(`
    SELECT ${REFUND_DAY} AS day, COALESCE(SUM(b.total), 0) AS total
    FROM bills b
    WHERE ${IN_REFUND_WINDOW}
    GROUP BY day
  `).all(start, end) as { day: string; total: number }[];

  const byDay = new Map<string, DailySalesRow>();
  const row = (day: string) => {
    let r = byDay.get(day);
    if (!r) {
      r = { bill_date: day, bill_count: 0, total_sales: 0, refunds: 0, net_sales: 0 };
      byDay.set(day, r);
    }
    return r;
  };
  for (const g of gross) {
    const r = row(g.day);
    r.bill_count = g.bill_count;
    r.total_sales = money(g.total);
  }
  for (const f of refunds) row(f.day).refunds = money(f.total);
  for (const r of byDay.values()) r.net_sales = money(r.total_sales - r.refunds);
  return [...byDay.values()].sort((a, b) => (a.bill_date < b.bill_date ? -1 : a.bill_date > b.bill_date ? 1 : 0));
}

export interface MoneyReceivedRow {
  payment_method: string;
  /** Bills rung up under this method in the window (sale day). */
  count: number;
  /** What those bills brought in at the till: total less any deposits paid earlier. */
  sales: number;
  deposit_count: number;
  /** Pre-order deposits taken by this method in the window. */
  deposits: number;
  refund_count: number;
  /** Refunds handed back in the window, under the refunded bill's method. */
  refunds: number;
  /** sales + deposits - refunds: the money actually received by this method. */
  total: number;
}

// The part of a bill that was paid BEFORE its own day, as pre-order deposits.
//
// bills.paid_in_advance is the source of truth once it is written (the pre-order
// collection flow records it). A collection bill rung up before that column
// existed reads 0 there, so for those the deposits are summed off the order
// that bill settled — the same rows getDepositsAppliedSince() in
// src/routes/cash.ts uses. pre_order_payments holds pre-collection payments
// only, so for any bill both give the same figure; the fallback can never add a
// deposit the bill was not actually settled with.
const PAID_IN_ADVANCE = `
  CASE WHEN b.paid_in_advance > 0 THEN b.paid_in_advance
       ELSE COALESCE((SELECT SUM(pop.amount)
                        FROM pre_order_payments pop
                        JOIN pre_orders po ON po.id = pop.pre_order_id
                       WHERE po.bill_id = b.id), 0)
  END`;

/**
 * Money received by payment method — NOT sales by payment method.
 *
 * Example: a Rs 3,000 deposit by CARD on Monday, the Rs 7,000 balance in CASH
 * on Saturday at collection. Sales (revenue) are still Rs 10,000 on Saturday,
 * once, at the full bill total. But the money arrived as Rs 3,000 card on
 * Monday and Rs 7,000 cash on Saturday, and that is what this returns — the
 * old query showed Rs 10,000 cash on Saturday and nothing anywhere for card,
 * which matched neither the drawer nor the card settlement.
 *
 * Per method, for the window:
 *   + bills sold on their bill_date: total - paid_in_advance, under the bill's method
 *   + pre-order deposits on the business date of created_at, under their own method
 *   - refunds on their refund day, under the refunded bill's method
 *   - deposits paid back when a pre-order was cancelled, on the business date
 *     of deposit_settled_at, under the method they were paid back by (a kept
 *     deposit moves no money, so only 'refunded' outcomes count)
 *
 * Consequently these rows do not sum to the sales total on a day with deposits
 * or collections, and the pages label them "Money received by method".
 */
export function moneyReceivedByMethod(start: string, end: string): MoneyReceivedRow[] {
  const db = getDb();
  const sales = db.query(`
    SELECT b.payment_method AS method, COUNT(*) AS n, COALESCE(SUM(b.total - ${PAID_IN_ADVANCE}), 0) AS amount
    FROM bills b
    WHERE b.bill_date >= ? AND b.bill_date <= ? AND ${SOLD}
    GROUP BY b.payment_method
  `).all(start, end) as { method: string; n: number; amount: number }[];
  const deposits = db.query(`
    SELECT payment_method AS method, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
    FROM pre_order_payments
    WHERE ${BIZ_DATE("created_at")} >= ? AND ${BIZ_DATE("created_at")} <= ?
    GROUP BY payment_method
  `).all(start, end) as { method: string; n: number; amount: number }[];
  const refunds = db.query(`
    SELECT b.payment_method AS method, COUNT(*) AS n, COALESCE(SUM(b.total), 0) AS amount
    FROM bills b
    WHERE ${IN_REFUND_WINDOW}
    GROUP BY b.payment_method
  `).all(start, end) as { method: string; n: number; amount: number }[];
  // A cancelled order's deposit handed back is money leaving by that method,
  // exactly like a bill refund — it is counted with the refunds so the cash row
  // here agrees with the drawer (cash.ts subtracts it from expected cash too).
  const depositRefunds = db.query(`
    SELECT deposit_refund_method AS method, COUNT(*) AS n, COALESCE(SUM(deposit_settled_amount), 0) AS amount
    FROM pre_orders
    WHERE deposit_outcome = 'refunded' AND deposit_settled_at IS NOT NULL
      AND ${BIZ_DATE("deposit_settled_at")} >= ? AND ${BIZ_DATE("deposit_settled_at")} <= ?
    GROUP BY deposit_refund_method
  `).all(start, end) as { method: string; n: number; amount: number }[];

  const byMethod = new Map<string, MoneyReceivedRow>();
  const row = (method: string) => {
    const key = method || "cash";
    let r = byMethod.get(key);
    if (!r) {
      r = { payment_method: key, count: 0, sales: 0, deposit_count: 0, deposits: 0, refund_count: 0, refunds: 0, total: 0 };
      byMethod.set(key, r);
    }
    return r;
  };
  for (const s of sales) {
    const r = row(s.method);
    r.count += s.n;
    r.sales = money(r.sales + s.amount);
  }
  for (const d of deposits) {
    const r = row(d.method);
    r.deposit_count += d.n;
    r.deposits = money(r.deposits + d.amount);
  }
  for (const f of [...refunds, ...depositRefunds]) {
    const r = row(f.method);
    r.refund_count += f.n;
    r.refunds = money(r.refunds + f.amount);
  }
  for (const r of byMethod.values()) r.total = money(r.sales + r.deposits - r.refunds);
  return [...byMethod.values()].sort((a, b) => b.total - a.total);
}
