import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly, getUser } from "../middleware/auth";
import { createBill, findBillByCartId, type CreatedBill } from "../services/billing";
import {
  buildDepositSlipText,
  buildKitchenTicket,
  buildPreorderSettlementBlock,
  buildReceiptText,
  getSettings,
  queuePrint,
} from "../services/printer";
import { formatDateTime, todayDate } from "../utils/helpers";
import { cashShiftBlockReason } from "./cash";

// ---------------------------------------------------------------------------
// Pre-orders: a customer orders ahead (a custom birthday cake described in
// words, and/or bulk savoury items off the product list) for collection on a
// future date, usually leaving a deposit.
//
// Two rules shape everything in this file:
//
//   1. A PRE-ORDER NEVER TOUCHES STOCK. Nothing here writes to
//      stock_reservations and nothing here touches products.stock_quantity —
//      not when the order is taken (a cake due next Saturday must not lock
//      today's shelf) and not when it is collected either: the owner never
//      enters pre-ordered goods as stock, because they are baked or bought in
//      for that customer. Collection still goes through the ordinary
//      createBill() — the same code path as any walk-in sale — but with
//      skip_stock, so a catalogue line whose product tracks stock is neither
//      refused for "out of stock" nor allowed to drive the shelf negative.
//
//   2. MONEY IS NEVER TAKEN FROM THE CLIENT. The order total is always
//      recomputed as SUM(quantity * unit_price) over the stored lines, and the
//      balance is always that total minus the payments on record. A `total`
//      field in a request body is ignored.
//
// Auth: this router is mounted behind authMiddleware in src/index.ts, so every
// route already requires a logged-in user. adminOnly is applied per route
// below, and each one says why.
// ---------------------------------------------------------------------------

const preorders = new Hono();

/** Two decimal places. Prices are REAL in SQLite, so sums pick up float dust. */
const money = (n: number) => Math.round(n * 100) / 100;

/** Half a cent: the tolerance for "are these two money figures equal?". */
const CENT = 0.005;

const PAYMENT_METHODS = ["cash", "card", "upi"] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * The four statuses, and why there are only four.
 *
 *   taken     — the order is on the book and not yet made. The default: this is
 *               what the cashier creates at the counter.
 *   ready     — made, decorated, boxed, sitting on the shelf with the
 *               customer's name on it. This is the one state the KITCHEN sets
 *               rather than the till, and it is the whole point of the
 *               production view: "what still has to be baked for today" is
 *               collection_date <= today AND status = 'taken' (today's orders
 *               plus overdue ones nobody made yet).
 *   collected — sold. A bill exists (bill_id) and the money is settled. (No
 *               stock moves — see rule 1 above.) Terminal.
 *   cancelled — the order will not happen. Terminal. Any deposit was settled
 *               at the moment of cancelling — refunded or kept — and that
 *               outcome is recorded on the row (deposit_outcome).
 *
 * Deliberately NOT modelled as separate states:
 *   * "paid" / "deposit taken" — payment is not a stage of an order, it is a
 *     ledger (pre_order_payments). An order can be fully paid and not made, or
 *     made and unpaid; one status column cannot say both, and the balance
 *     already answers the money question exactly.
 *   * "no_show" — a customer who never came is a cancellation with a note, and
 *     the production view already surfaces it as overdue (collection_date in
 *     the past, status still taken/ready). A fifth state would need its own
 *     rules about the deposit and would be indistinguishable in every report.
 *
 * Transitions: taken <-> ready freely; taken|ready -> collected (only via
 * /collect, which must write a bill); taken|ready -> cancelled (admin only).
 * collected and cancelled are terminal and immutable.
 */
const STATUSES = ["taken", "ready", "collected", "cancelled"] as const;
type Status = (typeof STATUSES)[number];

/** The two statuses that mean "the shop still owes this customer a cake". */
const OPEN_STATUSES: Status[] = ["taken", "ready"];

// ---------------------------------------------------------------------------
// READ THE BODY, THEN CHECK INSIDE THE WRITE
// ---------------------------------------------------------------------------
// Every route here that changes an order used to check the order's status and
// THEN `await c.req.json()`. That await yields: another request runs in the
// gap, and the check is stale by the time the write happens. Two Collects
// pressed at two tills with different payment methods both saw 'ready', both
// wrote a bill (different fingerprints, so the duplicate-bill gate could not
// match them), and the shop had two sales for one cake. Edits and cancels had
// the same hole on a smaller scale.
//
// So each such route now:
//   1. reads and validates the body first — the only await;
//   2. then, in ONE BEGIN IMMEDIATE transaction, re-loads the order, checks its
//      status, and writes. Everything after step 1 is synchronous, so in this
//      single-process server nothing can run between the check and the write,
//      and the immediate lock covers a second process too.
// A refusal discovered inside the transaction is THROWN as Refused, which also
// rolls back anything already written in it (collect may have written a bill
// by then), and the route turns it into the response.
class Refused extends Error {
  constructor(
    public status: 400 | 404 | 409 | 500,
    public body: Record<string, unknown>
  ) {
    super(String(body.error ?? "Refused"));
  }
}

/** Run `fn` as one BEGIN IMMEDIATE transaction: the write lock is taken before
 *  the first read, so the checks in `fn` cannot go stale before its writes. */
function writeTx<T>(fn: () => T): T {
  return getDb().transaction(fn).immediate();
}

function isBusinessDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  // Rejects 2026-02-31 and friends: round-tripping through Date only yields the
  // same string for a date that really exists.
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** `today` is accepted everywhere a collection date is read, for the views. */
function resolveDate(v: unknown): string | null {
  if (v === "today") return todayDate();
  return isBusinessDate(v) ? v : null;
}

function finiteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface NormalisedLine {
  product_id: number | null;
  description: string;
  quantity: number;
  unit_price: number;
}

/**
 * Turn whatever the till posted into lines we are willing to store.
 *
 * A line is EITHER a catalogue product OR a free-text custom line:
 *
 *   catalogue — product_id must exist. description defaults to the product's
 *               current name but is snapshotted on the row, so a later rename
 *               cannot rewrite what the customer ordered. unit_price defaults
 *               to the product's live price (discount price if one is set) but
 *               may be overridden, because bulk is negotiated at this counter.
 *
 *   custom    — product_id is null, description is REQUIRED (it is the entire
 *               specification of the cake), and unit_price is REQUIRED: there
 *               is no catalogue price to fall back on, so a missing price is a
 *               mistake, never a zero.
 *
 * `alreadyOrdered` is the set of product ids the order ALREADY has lines for
 * (empty for a new order). A discontinued product in that set is let through:
 * see the discontinued check below.
 *
 * Throws with a cashier-readable message; the caller turns that into a 400.
 */
function normaliseLines(raw: unknown, alreadyOrdered: ReadonlySet<number> = new Set()): NormalisedLine[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("A pre-order needs at least one line.");
  }
  if (raw.length > 100) {
    throw new Error("A pre-order cannot have more than 100 lines.");
  }
  const db = getDb();
  const lines: NormalisedLine[] = [];

  raw.forEach((item: any, i: number) => {
    const at = `Line ${i + 1}`;
    if (!item || typeof item !== "object") throw new Error(`${at} is not a line.`);

    const quantity = finiteNumber(item.quantity);
    if (quantity === null || !Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`${at}: quantity must be a whole number of 1 or more.`);
    }
    if (quantity > 100000) throw new Error(`${at}: quantity looks wrong (${quantity}).`);

    const rawDescription = typeof item.description === "string" ? item.description.trim() : "";
    if (rawDescription.length > 500) {
      throw new Error(`${at}: description is too long (max 500 characters).`);
    }

    const hasProduct = item.product_id !== null && item.product_id !== undefined && item.product_id !== "";
    let productId: number | null = null;
    let description = rawDescription;
    let unitPrice = finiteNumber(item.unit_price);

    if (hasProduct) {
      productId = Number(item.product_id);
      if (!Number.isInteger(productId) || productId < 1) {
        throw new Error(`${at}: product_id is not valid.`);
      }
      const product = db
        .query("SELECT id, name, selling_price, discount_price, is_discontinued FROM products WHERE id = ?")
        .get(productId) as any;
      if (!product) throw new Error(`${at}: product #${productId} does not exist.`);
      // Discontinued means permanently off the menu — it only still exists
      // because past bills point at it. Promising a customer one next week is a
      // promise the shop has decided not to keep. is_active = 0 ("temporarily
      // off the menu") is deliberately still allowed: made-to-order bulk items
      // are often hidden from the shelf grid but perfectly orderable ahead.
      //
      // EXCEPT a line the order already had. The promise was made before the
      // product was discontinued and the shop still means to keep it; and the
      // editor always sends every line (items is a full replace), so refusing
      // here made the whole order uneditable — not even the collection time
      // could be changed. Only ADDING a discontinued product is refused.
      if (product.is_discontinued && !alreadyOrdered.has(productId)) {
        throw new Error(`${at}: ${product.name} is discontinued and cannot be pre-ordered.`);
      }
      if (!description) description = product.name;
      if (unitPrice === null) unitPrice = product.discount_price ?? product.selling_price ?? 0;
    } else {
      if (!description) {
        throw new Error(`${at}: a custom line needs a description of what the customer ordered.`);
      }
      if (unitPrice === null) {
        throw new Error(`${at}: a custom line needs an agreed price.`);
      }
    }

    if (unitPrice === null || unitPrice < 0) throw new Error(`${at}: price cannot be negative.`);
    lines.push({ product_id: productId, description, quantity, unit_price: money(unitPrice) });
  });

  return lines;
}

function sumLines(lines: { quantity: number; unit_price: number }[]): number {
  return money(lines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0));
}

/** Rewrite the cached pre_orders.total from the rows that are the truth. */
function recacheTotal(preOrderId: number): number {
  const db = getDb();
  const row = db
    .query("SELECT COALESCE(SUM(quantity * unit_price), 0) AS total FROM pre_order_items WHERE pre_order_id = ?")
    .get(preOrderId) as { total: number };
  const total = money(row.total);
  db.query("UPDATE pre_orders SET total = ?, updated_at = datetime('now') WHERE id = ?").run(total, preOrderId);
  return total;
}

function amountPaid(preOrderId: number): number {
  const db = getDb();
  const row = db
    .query("SELECT COALESCE(SUM(amount), 0) AS paid FROM pre_order_payments WHERE pre_order_id = ?")
    .get(preOrderId) as { paid: number };
  return money(row.paid);
}

/**
 * One pre-order, fully hydrated: lines, payments, the customer, and the money.
 *
 * total / amount_paid / balance are computed HERE from the child rows on every
 * read. The cached pre_orders.total is overwritten by the computed one in the
 * returned object, so a caller can never be handed a stale figure even if a
 * cache rewrite were ever missed.
 */
function loadOrder(id: number): any | null {
  const db = getDb();
  const order = db
    .query(
      `SELECT po.*, c.name AS customer_name, c.phone AS customer_phone,
              u.full_name AS taken_by
       FROM pre_orders po
       JOIN customers c ON c.id = po.customer_id
       LEFT JOIN users u ON u.id = po.user_id
       WHERE po.id = ?`
    )
    .get(id) as any;
  if (!order) return null;

  const items = db
    .query(
      `SELECT id, product_id, description, quantity, unit_price,
              (quantity * unit_price) AS line_total
       FROM pre_order_items WHERE pre_order_id = ? ORDER BY id`
    )
    .all(id) as any[];

  const payments = db
    .query(
      `SELECT pop.id, pop.amount, pop.payment_method, pop.paid_on,
              pop.user_id, u.full_name AS taken_by, pop.created_at
       FROM pre_order_payments pop
       LEFT JOIN users u ON u.id = pop.user_id
       WHERE pop.pre_order_id = ?
       ORDER BY pop.created_at, pop.id`
    )
    .all(id) as any[];

  const total = sumLines(items);
  const paid = money(payments.reduce((s, p) => s + p.amount, 0));

  const bill = order.bill_id
    ? db
        .query(
          `SELECT id, token_number, bill_date, subtotal, discount, tax_amount, total,
                  payment_method, status, created_at
           FROM bills WHERE id = ?`
        )
        .get(order.bill_id)
    : null;

  return {
    ...order,
    items,
    payments,
    total,
    amount_paid: paid,
    balance: money(total - paid),
    bill,
  };
}

/**
 * The slip for a deposit or top-up that has JUST been recorded, built from the
 * order as it now stands (so "Total Paid" includes this payment), and queued on
 * the shop printer the same fire-and-forget way as receipts. The text is also
 * returned so the screen can show it and print it in the browser, exactly as
 * it does a collection receipt.
 */
function depositSlip(order: any, payment: { amount: number; payment_method: string }, cashierName: string | null): string {
  const settings = getSettings();
  const text = buildDepositSlipText({
    shopName: settings.shop_name || "My Cake Shop",
    shopAddress: settings.shop_address || "",
    shopPhone: settings.shop_phone || "",
    preOrderId: order.id,
    printedAt: formatDateTime(new Date().toISOString()),
    customerName: order.customer_name || "",
    customerPhone: order.customer_phone || null,
    collectionDate: order.collection_date,
    collectionTime: order.collection_time || null,
    items: (order.items || []).map((i: any) => ({
      qty: i.quantity,
      name: i.description,
      total: money(i.quantity * i.unit_price),
    })),
    orderTotal: order.total,
    paymentAmount: payment.amount,
    paymentMethod: payment.payment_method,
    totalPaid: order.amount_paid,
    balanceDue: order.balance,
    cashierName,
  });
  queuePrint(text)
    .then((r) => {
      if (!r.success) console.error(`[print] pre-order #${order.id} deposit slip: ${r.error}`);
    })
    .catch((err: any) => {
      console.error(`[print] pre-order #${order.id} deposit slip: ${err?.message || err}`);
    });
  return text;
}

// ---------------------------------------------------------------------------
// GET /api/preorders  — the list, and the production view.
// ---------------------------------------------------------------------------
preorders.get("/", (c) => {
  const db = getDb();
  const where: string[] = [];
  const params: any[] = [];

  const dateParam = c.req.query("date");
  if (dateParam) {
    const date = resolveDate(dateParam);
    if (!date) return c.json({ error: "date must be YYYY-MM-DD or 'today'." }, 400);
    where.push("po.collection_date = ?");
    params.push(date);
  }

  const fromParam = c.req.query("from");
  if (fromParam) {
    const from = resolveDate(fromParam);
    if (!from) return c.json({ error: "from must be YYYY-MM-DD or 'today'." }, 400);
    where.push("po.collection_date >= ?");
    params.push(from);
  }

  const toParam = c.req.query("to");
  if (toParam) {
    const to = resolveDate(toParam);
    if (!to) return c.json({ error: "to must be YYYY-MM-DD or 'today'." }, 400);
    where.push("po.collection_date <= ?");
    params.push(to);
  }

  // status: a comma-separated list of real statuses, or the alias 'open'
  // (taken + ready = "the shop still owes this customer"), or 'all'.
  const statusParam = (c.req.query("status") || "").trim();
  if (statusParam && statusParam !== "all") {
    const wanted = new Set<string>();
    for (const part of statusParam.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (part === "open") {
        for (const s of OPEN_STATUSES) wanted.add(s);
      } else if ((STATUSES as readonly string[]).includes(part)) {
        wanted.add(part);
      } else {
        return c.json({ error: `Unknown status '${part}'. Use ${STATUSES.join(", ")}, open or all.` }, 400);
      }
    }
    if (wanted.size === 0) return c.json({ error: "status was empty." }, 400);
    where.push(`po.status IN (${[...wanted].map(() => "?").join(", ")})`);
    params.push(...wanted);
  }

  // overdue=1: due before today and still owed. The thing the owner wants to
  // see first thing in the morning.
  if (c.req.query("overdue") === "1") {
    where.push(`po.collection_date < ? AND po.status IN (${OPEN_STATUSES.map(() => "?").join(", ")})`);
    params.push(todayDate(), ...OPEN_STATUSES);
  }

  const customerId = finiteNumber(c.req.query("customer_id"));
  if (customerId !== null) {
    where.push("po.customer_id = ?");
    params.push(customerId);
  }

  const q = (c.req.query("q") || "").trim();
  if (q) {
    const like = `%${q}%`;
    where.push(
      `(c.name LIKE ? OR IFNULL(c.phone, '') LIKE ? OR IFNULL(po.notes, '') LIKE ?
        OR EXISTS (SELECT 1 FROM pre_order_items i WHERE i.pre_order_id = po.id AND i.description LIKE ?))`
    );
    params.push(like, like, like, like);
  }

  const limit = Math.min(Math.max(finiteNumber(c.req.query("limit")) ?? 200, 1), 500);
  const offset = Math.max(finiteNumber(c.req.query("offset")) ?? 0, 0);

  // 'due' (the default) is the production order: soonest collection first.
  // 'recent' is the back-office order: newest order taken first.
  const sort = c.req.query("sort") === "recent" ? "recent" : "due";
  const orderBy =
    sort === "recent"
      ? "po.created_at DESC, po.id DESC"
      : "po.collection_date ASC, IFNULL(po.collection_time, '') ASC, po.id ASC";

  const sql = `
    SELECT po.*, c.name AS customer_name, c.phone AS customer_phone, u.full_name AS taken_by
    FROM pre_orders po
    JOIN customers c ON c.id = po.customer_id
    LEFT JOIN users u ON u.id = po.user_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;
  const rows = db.query(sql).all(...params, limit, offset) as any[];
  if (rows.length === 0) return c.json([]);

  // Lines and payment totals for the whole page in two queries, not 2N. The
  // kitchen list is useless without the lines ("2kg chocolate cake, butterscotch
  // filling"), so they are always included rather than hidden behind a flag.
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");
  const itemRows = db
    .query(
      `SELECT id, pre_order_id, product_id, description, quantity, unit_price,
              (quantity * unit_price) AS line_total
       FROM pre_order_items WHERE pre_order_id IN (${placeholders}) ORDER BY id`
    )
    .all(...ids) as any[];
  const paidRows = db
    .query(
      `SELECT pre_order_id, COALESCE(SUM(amount), 0) AS paid
       FROM pre_order_payments WHERE pre_order_id IN (${placeholders}) GROUP BY pre_order_id`
    )
    .all(...ids) as any[];

  const itemsBy = new Map<number, any[]>();
  for (const it of itemRows) {
    const list = itemsBy.get(it.pre_order_id) || [];
    list.push(it);
    itemsBy.set(it.pre_order_id, list);
  }
  const paidBy = new Map<number, number>();
  for (const p of paidRows) paidBy.set(p.pre_order_id, money(p.paid));

  const today = todayDate();
  const out = rows.map((r) => {
    const items = itemsBy.get(r.id) || [];
    const total = sumLines(items);
    const paid = paidBy.get(r.id) ?? 0;
    return {
      ...r,
      items,
      total,
      amount_paid: paid,
      balance: money(total - paid),
      // Computed, not stored: "late" is a function of today, so storing it
      // would be wrong by tomorrow morning.
      is_overdue: r.collection_date < today && (OPEN_STATUSES as string[]).includes(r.status),
    };
  });
  return c.json(out);
});

// ---------------------------------------------------------------------------
// GET /api/preorders/summary — counts for the POS entry point's badge.
// Registered BEFORE /:id so "summary" is not read as an id.
// ---------------------------------------------------------------------------
preorders.get("/summary", (c) => {
  const db = getDb();
  const today = todayDate();
  const open = OPEN_STATUSES.map(() => "?").join(", ");

  const dueToday = db
    .query(`SELECT COUNT(*) AS n FROM pre_orders WHERE collection_date = ? AND status IN (${open})`)
    .get(today, ...OPEN_STATUSES) as { n: number };
  const overdue = db
    .query(`SELECT COUNT(*) AS n FROM pre_orders WHERE collection_date < ? AND status IN (${open})`)
    .get(today, ...OPEN_STATUSES) as { n: number };
  const readyToday = db
    .query("SELECT COUNT(*) AS n FROM pre_orders WHERE collection_date = ? AND status = 'ready'")
    .get(today) as { n: number };
  // "Still to bake" includes OVERDUE orders that were never made: a cake that
  // was due on Friday and is still 'taken' has to come out of the oven today
  // just as much as one due today, and leaving it out made the kitchen's count
  // smaller than the list it is meant to summarise.
  const toBake = db
    .query("SELECT COUNT(*) AS n FROM pre_orders WHERE collection_date <= ? AND status = 'taken'")
    .get(today) as { n: number };
  const upcoming = db
    .query(`SELECT COUNT(*) AS n FROM pre_orders WHERE collection_date > ? AND status IN (${open})`)
    .get(today, ...OPEN_STATUSES) as { n: number };

  // Money still owed to the shop on every open order, regardless of date.
  const outstanding = db
    .query(
      `SELECT COALESCE(SUM(po.total), 0) AS total,
              COALESCE((SELECT SUM(amount) FROM pre_order_payments pop
                        JOIN pre_orders p2 ON p2.id = pop.pre_order_id
                        WHERE p2.status IN (${open})), 0) AS paid
       FROM pre_orders po WHERE po.status IN (${open})`
    )
    .get(...OPEN_STATUSES, ...OPEN_STATUSES) as { total: number; paid: number };

  return c.json({
    date: today,
    due_today: dueToday.n,
    to_bake_today: toBake.n,
    ready_today: readyToday.n,
    overdue: overdue.n,
    upcoming: upcoming.n,
    open_order_value: money(outstanding.total),
    deposits_held: money(outstanding.paid),
    outstanding_balance: money(outstanding.total - outstanding.paid),
  });
});

// ---------------------------------------------------------------------------
// GET /api/preorders/:id
// ---------------------------------------------------------------------------
preorders.get("/:id", (c) => {
  const id = finiteNumber(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);
  const order = loadOrder(id);
  if (!order) return c.json({ error: "Not found" }, 404);
  return c.json(order);
});

// ---------------------------------------------------------------------------
// POST /api/preorders — take an order.
//
// Not adminOnly: taking the order IS the cashier's job. They are standing at
// the counter with the customer in front of them.
// ---------------------------------------------------------------------------
preorders.post("/", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid request body." }, 400);
  const db = getDb();

  // The customer is mandatory and must already exist. No walk-in pre-orders:
  // if the cake is late, somebody has to be phoned.
  const customerId = finiteNumber(body.customer_id);
  if (customerId === null || !Number.isInteger(customerId) || customerId < 1) {
    return c.json({ error: "A customer is required for a pre-order." }, 400);
  }
  const customer = db.query("SELECT id, name FROM customers WHERE id = ?").get(customerId) as any;
  if (!customer) {
    return c.json({ error: `Customer #${customerId} does not exist. Add the customer first.` }, 400);
  }

  const collectionDate = resolveDate(body.collection_date);
  if (!collectionDate) {
    return c.json({ error: "collection_date must be a date in YYYY-MM-DD form." }, 400);
  }

  const collectionTime =
    typeof body.collection_time === "string" && body.collection_time.trim()
      ? body.collection_time.trim().slice(0, 50)
      : null;
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 2000) : null;

  let lines: NormalisedLine[];
  try {
    lines = normaliseLines(body.items);
  } catch (err: any) {
    return c.json({ error: err?.message || "Invalid order lines." }, 400);
  }
  const total = sumLines(lines);

  // An optional deposit taken in the same breath as the order, because that is
  // how it happens at the counter. Validated here, written in the same
  // transaction as the order so there is no window in which the order exists
  // without the money that was handed over for it.
  let deposit: { amount: number; payment_method: PaymentMethod; paid_on: string } | null = null;
  if (body.deposit != null) {
    const amount = finiteNumber(body.deposit.amount);
    if (amount === null || amount <= 0) return c.json({ error: "Deposit amount must be more than zero." }, 400);
    if (amount > total + CENT) {
      return c.json({ error: `Deposit (${money(amount)}) is more than the order total (${total}).` }, 400);
    }
    const method = (body.deposit.payment_method || "cash") as PaymentMethod;
    if (!PAYMENT_METHODS.includes(method)) return c.json({ error: "Unknown payment method." }, 400);
    const paidOn = body.deposit.paid_on ? resolveDate(body.deposit.paid_on) : todayDate();
    if (!paidOn) return c.json({ error: "deposit.paid_on must be a date in YYYY-MM-DD form." }, 400);
    // A cash deposit is cash into the drawer, so it is subject to the same
    // shift rule as a sale: money that arrives outside an open shift can never
    // be reconciled by a close. Card/UPI never touches the drawer.
    if (method === "cash") {
      const blocked = cashShiftBlockReason();
      if (blocked) return c.json({ error: blocked }, 400);
    }
    deposit = { amount: money(amount), payment_method: method, paid_on: paidOn };
  }

  const insertOrder = db.query(
    `INSERT INTO pre_orders (customer_id, collection_date, collection_time, notes, status, total, user_id)
     VALUES (?, ?, ?, ?, 'taken', ?, ?)`
  );
  const insertItem = db.query(
    "INSERT INTO pre_order_items (pre_order_id, product_id, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)"
  );
  const insertPayment = db.query(
    "INSERT INTO pre_order_payments (pre_order_id, amount, payment_method, paid_on, user_id) VALUES (?, ?, ?, ?, ?)"
  );

  const newId = db.transaction((): number => {
    const res = insertOrder.run(customerId, collectionDate, collectionTime, notes, total, user.id);
    const id = Number(res.lastInsertRowid);
    for (const l of lines) insertItem.run(id, l.product_id, l.description, l.quantity, l.unit_price);
    if (deposit) {
      insertPayment.run(id, deposit.amount, deposit.payment_method, deposit.paid_on, user.id);
    }
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'created_pre_order', ?)").run(
      user.id,
      JSON.stringify({
        pre_order_id: id,
        customer_id: customerId,
        collection_date: collectionDate,
        total,
        deposit: deposit?.amount ?? 0,
      })
    );
    return id;
  })();

  const created = loadOrder(newId);
  // A deposit taken with the order gets its slip, printed now, while the
  // customer is still at the counter. slip_text is null when no money changed
  // hands, so the till knows there is nothing to print.
  const slipText = deposit ? depositSlip(created, deposit, user.full_name ?? null) : null;
  return c.json({ ...created, slip_text: slipText }, 201);
});

// ---------------------------------------------------------------------------
// PUT /api/preorders/:id — change an order that has not been settled.
//
// Not adminOnly: "make it 3kg instead", "she'll come at 4 not 2" and "spell it
// Amaal" are the normal life of a cake order, and they happen on the phone to
// whoever picks up. The guards that matter are not about rank:
//   * only taken/ready may be edited — a collected or cancelled order is
//     history, and history is not editable here;
//   * the new total may never fall below what has already been paid, or the
//     order would owe the customer money and no refund has been made.
//
// The body is read FIRST and the order is checked INSIDE the write
// transaction, never the other way round — see "READ THE BODY, THEN CHECK
// INSIDE THE WRITE" above.
// ---------------------------------------------------------------------------
preorders.put("/:id", async (c) => {
  const user = getUser(c)!;
  const id = finiteNumber(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);
  const db = getDb();

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid request body." }, 400);

  // Everything that depends only on the body is validated before the lock.
  // `undefined` means "not sent, keep what the order has".
  let newDate: string | undefined;
  if (body.collection_date !== undefined) {
    const d = resolveDate(body.collection_date);
    if (!d) return c.json({ error: "collection_date must be a date in YYYY-MM-DD form." }, 400);
    newDate = d;
  }

  let newTime: string | null | undefined;
  if (body.collection_time !== undefined) {
    newTime =
      typeof body.collection_time === "string" && body.collection_time.trim()
        ? body.collection_time.trim().slice(0, 50)
        : null;
  }

  let newNotes: string | null | undefined;
  if (body.notes !== undefined) {
    newNotes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 2000) : null;
  }

  // Status may only be nudged between taken and ready here. Collecting writes
  // a bill and cancelling releases a promise; both have their own route, so
  // neither can be reached by PUTting a string.
  let newStatus: Status | undefined;
  if (body.status !== undefined) {
    if (!(OPEN_STATUSES as string[]).includes(body.status)) {
      return c.json(
        { error: "status here may only be 'taken' or 'ready'. Use /collect or /cancel for the rest." },
        400
      );
    }
    newStatus = body.status;
  }

  const deleteItems = db.query("DELETE FROM pre_order_items WHERE pre_order_id = ?");
  const insertItem = db.query(
    "INSERT INTO pre_order_items (pre_order_id, product_id, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)"
  );

  try {
    writeTx(() => {
      const existing = db.query("SELECT * FROM pre_orders WHERE id = ?").get(id) as any;
      if (!existing) throw new Refused(404, { error: "Not found" });
      if (!(OPEN_STATUSES as string[]).includes(existing.status)) {
        throw new Refused(400, { error: `This order is ${existing.status} and can no longer be changed.` });
      }
      const collectionDate = newDate ?? existing.collection_date;
      const collectionTime = newTime !== undefined ? newTime : existing.collection_time;
      const notes = newNotes !== undefined ? newNotes : existing.notes;
      const status: Status = newStatus ?? existing.status;

      // Lines are replaced wholesale when present, never diffed: the screen
      // holds the whole order, and a diff drifts the moment one request is
      // lost. Normalised in here because what is allowed depends on the lines
      // the order has right now (a discontinued product it already had).
      let lines: NormalisedLine[] | null = null;
      if (body.items !== undefined) {
        const had = new Set<number>(
          (
            db
              .query("SELECT DISTINCT product_id FROM pre_order_items WHERE pre_order_id = ? AND product_id IS NOT NULL")
              .all(id) as { product_id: number }[]
          ).map((r) => r.product_id)
        );
        try {
          lines = normaliseLines(body.items, had);
        } catch (err: any) {
          throw new Refused(400, { error: err?.message || "Invalid order lines." });
        }
        const newTotal = sumLines(lines);
        const paid = amountPaid(id);
        if (newTotal < paid - CENT) {
          throw new Refused(400, {
            error: `The new total (${newTotal}) is less than the ${paid} already paid on this order. Refund the difference first, or keep the total at or above ${paid}.`,
          });
        }
      }

      db.query(
        `UPDATE pre_orders SET collection_date = ?, collection_time = ?, notes = ?, status = ?,
                updated_at = datetime('now')
         WHERE id = ? AND status IN ('taken', 'ready')`
      ).run(collectionDate, collectionTime, notes, status, id);
      if (lines) {
        deleteItems.run(id);
        for (const l of lines) insertItem.run(id, l.product_id, l.description, l.quantity, l.unit_price);
        recacheTotal(id);
      }
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'updated_pre_order', ?)").run(
        user.id,
        JSON.stringify({ pre_order_id: id, collection_date: collectionDate, status, lines_replaced: !!lines })
      );
    });
  } catch (err) {
    if (err instanceof Refused) return c.json(err.body, err.status);
    throw err;
  }

  return c.json(loadOrder(id));
});

// ---------------------------------------------------------------------------
// POST /api/preorders/:id/status — the kitchen's button.
//
// Not adminOnly: whoever boxed the cake marks it ready. It moves no money and
// no stock, and the two states it toggles are both reversible.
// ---------------------------------------------------------------------------
preorders.post("/:id/status", async (c) => {
  const user = getUser(c)!;
  const id = finiteNumber(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);
  const db = getDb();

  const body = await c.req.json().catch(() => null);
  const status = body?.status;
  if (!(OPEN_STATUSES as string[]).includes(status)) {
    return c.json({ error: "status must be 'taken' or 'ready'." }, 400);
  }

  try {
    writeTx(() => {
      const existing = db.query("SELECT id, status FROM pre_orders WHERE id = ?").get(id) as any;
      if (!existing) throw new Refused(404, { error: "Not found" });
      if (!(OPEN_STATUSES as string[]).includes(existing.status)) {
        throw new Refused(400, { error: `This order is ${existing.status}; its status is settled.` });
      }
      db.query(
        "UPDATE pre_orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('taken', 'ready')"
      ).run(status, id);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'pre_order_status', ?)").run(
        user.id,
        JSON.stringify({ pre_order_id: id, from: existing.status, to: status })
      );
    });
  } catch (err) {
    if (err instanceof Refused) return c.json(err.body, err.status);
    throw err;
  }
  return c.json(loadOrder(id));
});

// ---------------------------------------------------------------------------
// POST /api/preorders/:id/payments — take a deposit or a top-up.
//
// Not adminOnly: taking the deposit is the other half of taking the order.
//
// Body first, then the status and balance checks inside the write (see "READ
// THE BODY, THEN CHECK INSIDE THE WRITE"): two top-ups typed at once must not
// both pass a balance check that only one of them can satisfy, and money must
// never land on an order that was collected or cancelled in the meantime.
// ---------------------------------------------------------------------------
preorders.post("/:id/payments", async (c) => {
  const user = getUser(c)!;
  const id = finiteNumber(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);
  const db = getDb();

  const body = await c.req.json().catch(() => null);
  const amount = finiteNumber(body?.amount);
  if (amount === null || amount <= 0) return c.json({ error: "Amount must be more than zero." }, 400);

  const method = (body?.payment_method || "cash") as PaymentMethod;
  if (!PAYMENT_METHODS.includes(method)) return c.json({ error: "Unknown payment method." }, 400);

  const paidOn = body?.paid_on ? resolveDate(body.paid_on) : todayDate();
  if (!paidOn) return c.json({ error: "paid_on must be a date in YYYY-MM-DD form." }, 400);

  try {
    writeTx(() => {
      const existing = db.query("SELECT id, status FROM pre_orders WHERE id = ?").get(id) as any;
      if (!existing) throw new Refused(404, { error: "Not found" });
      if (!(OPEN_STATUSES as string[]).includes(existing.status)) {
        // A collected order's money is settled by its bill; a cancelled order
        // should not be taking more money.
        throw new Refused(400, {
          error: `This order is ${existing.status}; no further payment can be recorded against it.`,
        });
      }

      // Never more than the balance. An overpayment would have to be refunded,
      // and there is no refund path for an open pre-order — so it is refused at
      // the door instead of being stored as a negative balance nobody notices.
      const total = recacheTotal(id);
      const paid = amountPaid(id);
      const balance = money(total - paid);
      if (money(amount) > balance + CENT) {
        throw new Refused(400, {
          error: `Only ${balance} is outstanding on this order; ${money(amount)} would overpay it.`,
        });
      }

      if (method === "cash") {
        const blocked = cashShiftBlockReason();
        if (blocked) throw new Refused(400, { error: blocked });
      }

      const res = db
        .query(
          "INSERT INTO pre_order_payments (pre_order_id, amount, payment_method, paid_on, user_id) VALUES (?, ?, ?, ?, ?)"
        )
        .run(id, money(amount), method, paidOn, user.id);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'pre_order_payment', ?)").run(
        user.id,
        JSON.stringify({
          pre_order_id: id,
          payment_id: Number(res.lastInsertRowid),
          amount: money(amount),
          payment_method: method,
          paid_on: paidOn,
        })
      );
    });
  } catch (err) {
    if (err instanceof Refused) return c.json(err.body, err.status);
    throw err;
  }

  const order = loadOrder(id);
  // The customer's proof of this payment, printed now (see depositSlip()).
  const slipText = depositSlip(order, { amount: money(amount), payment_method: method }, user.full_name ?? null);
  return c.json({ ...order, slip_text: slipText }, 201);
});

// ---------------------------------------------------------------------------
// DELETE /api/preorders/:id/payments/:paymentId — undo a mis-keyed deposit.
//
// adminOnly. This is the one route that can make money that was counted in a
// close-of-day reconciliation disappear from the books, so it is the owner's
// key, not the cashier's. A cashier who types 20000 instead of 2000 calls the
// owner over; that is the intended friction.
// ---------------------------------------------------------------------------
preorders.delete("/:id/payments/:paymentId", adminOnly, (c) => {
  const user = getUser(c)!;
  const id = finiteNumber(c.req.param("id"));
  const paymentId = finiteNumber(c.req.param("paymentId"));
  if (id === null || paymentId === null) return c.json({ error: "Not found" }, 404);
  const db = getDb();

  const order = db.query("SELECT id, status, deposit_outcome FROM pre_orders WHERE id = ?").get(id) as any;
  if (!order) return c.json({ error: "Not found" }, 404);
  if (order.status === "collected") {
    return c.json({ error: "This order has been collected and billed; its payments cannot be altered." }, 400);
  }
  // A cancelled order whose deposit was settled (refunded or kept) is closed
  // the same way: deposit_settled_amount, the drawer's refund figure and any
  // income row were all written from these payments, and deleting one now
  // would leave them describing money the order no longer shows.
  if (order.status === "cancelled" && order.deposit_outcome) {
    return c.json(
      { error: `This order was cancelled and its deposit was ${order.deposit_outcome}; its payments cannot be altered.` },
      400
    );
  }
  const payment = db
    .query("SELECT * FROM pre_order_payments WHERE id = ? AND pre_order_id = ?")
    .get(paymentId, id) as any;
  if (!payment) return c.json({ error: "Not found" }, 404);

  db.query("DELETE FROM pre_order_payments WHERE id = ?").run(paymentId);
  db.query("UPDATE pre_orders SET updated_at = datetime('now') WHERE id = ?").run(id);
  db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'pre_order_payment_deleted', ?)").run(
    user.id,
    JSON.stringify({
      pre_order_id: id,
      payment_id: paymentId,
      amount: payment.amount,
      payment_method: payment.payment_method,
      paid_on: payment.paid_on,
    })
  );
  return c.json(loadOrder(id));
});

// ---------------------------------------------------------------------------
// POST /api/preorders/:id/cancel
//
// adminOnly, and this is the deliberate choice. A cancelled order usually has
// the customer's deposit sitting in the drawer, so cancelling decides that
// money has to go back out — an owner's call, not a cashier's. It is also the
// only action by which a cashier could make an inconvenient order vanish from
// the book after taking money for it.
//
// Cancelling never deletes the deposit rows. Those rows are the record of
// money that really did arrive, possibly on a day that has already been
// reconciled; deleting them would retroactively falsify that close.
//
// Instead, an order WITH payments cannot be cancelled without saying what
// happens to that money (body.deposit_action), and the answer is recorded on
// the order in the same transaction as the cancel:
//
//   'refund' + refund_method (cash | card | upi) — the customer gets it back.
//       This is NOT an expense (it was never the shop's money to spend, and
//       booking it as one cut the profit by a sale that never happened) and NOT
//       negative income. A CASH refund is money leaving the drawer, so the cash
//       shift subtracts it (getDepositsRefundedSince in src/routes/cash.ts), and
//       like any cash movement it needs an open shift. Card / LankaQR refunds
//       are made outside the drawer and only recorded here.
//
//   'keep' — the customer forfeits it (a no-show, a late cancellation). Now it
//       IS the shop's income: one row goes into the income table, dated today,
//       so the existing income and profit reports pick it up unchanged. No
//       drawer movement — the cash came in when the deposit was taken and has
//       already been counted then.
//
// An order with no payments cancels exactly as before; deposit_action is
// ignored. A cancelled order holds no deposit in /summary either way, because
// deposits_held only sums OPEN orders.
// ---------------------------------------------------------------------------
preorders.post("/:id/cancel", adminOnly, async (c) => {
  const user = getUser(c)!;
  const id = finiteNumber(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);
  const db = getDb();

  const body = await c.req.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  const action = body?.deposit_action;
  if (action != null && action !== "refund" && action !== "keep") {
    return c.json({ error: "deposit_action must be 'refund' or 'keep'." }, 400);
  }
  const refundMethod = body?.refund_method;
  if (action === "refund" && !PAYMENT_METHODS.includes(refundMethod)) {
    return c.json({ error: "Choose how the deposit is refunded: cash, card or LankaQR." }, 400);
  }

  let settled: { outcome: "refunded" | "kept"; amount: number } | null = null;
  try {
    settled = writeTx(() => {
      const existing = db
        .query("SELECT po.*, c.name AS customer_name FROM pre_orders po JOIN customers c ON c.id = po.customer_id WHERE po.id = ?")
        .get(id) as any;
      if (!existing) throw new Refused(404, { error: "Not found" });
      if (existing.status === "collected") {
        throw new Refused(400, {
          error: `This order was collected on bill #${existing.bill_id}. Refund the bill instead of cancelling the order.`,
        });
      }
      if (existing.status === "cancelled") {
        throw new Refused(400, { error: "This order is already cancelled." });
      }

      const paid = amountPaid(id);
      const hasDeposit = paid > CENT;
      if (hasDeposit && !action) {
        throw new Refused(400, {
          error: `${paid} has been paid on this order. Choose whether the deposit is refunded or kept before cancelling.`,
          deposit_required: true,
          amount_paid: paid,
        });
      }
      if (hasDeposit && action === "refund" && refundMethod === "cash") {
        const blocked = cashShiftBlockReason();
        if (blocked) {
          throw new Refused(400, { error: `A cash refund comes out of the drawer. ${blocked}` });
        }
      }

      // The reason is appended to notes rather than given a column of its own:
      // it is read by a human on the order screen and nothing aggregates it.
      const note = reason ? `${existing.notes ? existing.notes + "\n" : ""}[Cancelled] ${reason}` : existing.notes;
      const outcome = !hasDeposit ? null : action === "refund" ? "refunded" : "kept";
      db.query(
        `UPDATE pre_orders SET status = 'cancelled', notes = ?, updated_at = datetime('now'),
                deposit_outcome = ?, deposit_settled_amount = ?, deposit_refund_method = ?,
                deposit_settled_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
                deposit_settled_by = ?
         WHERE id = ? AND status IN ('taken', 'ready')`
      ).run(
        note,
        outcome,
        outcome ? paid : null,
        outcome === "refunded" ? refundMethod : null,
        outcome,
        outcome ? user.id : null,
        id
      );

      if (outcome === "kept") {
        db.query(
          "INSERT INTO income (source, amount, description, income_date, user_id) VALUES (?, ?, ?, ?, ?)"
        ).run(
          "Kept pre-order deposit",
          paid,
          `Pre-order #${id} for ${existing.customer_name} was cancelled and the deposit kept${reason ? ` (${reason})` : ""}.`,
          todayDate(),
          user.id
        );
      }

      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cancelled_pre_order', ?)").run(
        user.id,
        JSON.stringify({
          pre_order_id: id,
          reason,
          amount_paid: paid,
          deposit_outcome: outcome,
          refund_method: outcome === "refunded" ? refundMethod : null,
        })
      );
      return outcome ? { outcome, amount: paid } : null;
    });
  } catch (err) {
    if (err instanceof Refused) return c.json(err.body, err.status);
    throw err;
  }

  return c.json({ ...loadOrder(id), deposit_settled: settled });
});

// ---------------------------------------------------------------------------
// DELETE /api/preorders/:id — remove an order typed in by mistake.
//
// adminOnly, and only for an order with NO payments and NO bill. Anything with
// money or a sale attached must be cancelled instead: cancelling keeps the
// trail, deleting would cascade the payment rows away and silently rewrite a
// day that has already been closed and reconciled.
// ---------------------------------------------------------------------------
preorders.delete("/:id", adminOnly, (c) => {
  const user = getUser(c)!;
  const id = finiteNumber(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);
  const db = getDb();

  const existing = db.query("SELECT * FROM pre_orders WHERE id = ?").get(id) as any;
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (existing.bill_id) {
    return c.json({ error: "This order has been billed and cannot be deleted." }, 400);
  }
  const paid = amountPaid(id);
  if (paid > CENT) {
    return c.json(
      { error: `${paid} has been paid on this order. Cancel it instead of deleting it, so the money stays on the books.` },
      400
    );
  }

  db.transaction(() => {
    // pre_order_items cascades (and there are no payments, by the check above).
    db.query("DELETE FROM pre_orders WHERE id = ?").run(id);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'deleted_pre_order', ?)").run(
      user.id,
      JSON.stringify({ pre_order_id: id, customer_id: existing.customer_id, total: existing.total })
    );
  })();
  return c.json({ success: true, deleted_id: id });
});

// ---------------------------------------------------------------------------
// POST /api/preorders/:id/collect — the customer is at the counter.
//
// Not adminOnly: this is a sale, and ringing up sales is the cashier's job.
//
// What it does, and why in this order:
//
//   1. It writes a REAL BILL through the ordinary createBill(). Not a special
//      "pre-order sale" path — the same function the walk-in till uses. That is
//      what makes the token, the receipt, the activity log, the day's sales
//      total and every report behave identically to any other sale. The day's
//      takings are only correct because this is not special-cased. The one
//      difference is skip_stock: pre-ordered goods are never entered as stock
//      (rule 1 in the header), so collecting checks and deducts nothing — not
//      even for a catalogue line whose product tracks stock. The bill's
//      cart_id is 'preorder-<id>', which is how anything downstream (a refund
//      deciding whether to put stock back, say) can tell such a bill apart.
//
//   2. CUSTOM FREE-TEXT LINES reach the bill with product_id = NULL and the
//      customer's own description as product_name. bill_items.product_id is
//      nullable and bill_items.product_name is the text every report groups on,
//      so a custom cake appears in the day's sales, in top products and on the
//      receipt with its real revenue. Its cost_price lands as 0 (there is no
//      product to read a cost from), so it shows as pure margin; that is a
//      known limitation of selling an off-catalogue item, not a pre-order bug.
//
//   3. THE DEPOSIT. The bill records the FULL value of the sale (every line, no
//      "minus deposit" line), so the day's sales figure is the whole cake, not
//      the balance — nothing is understated. No pre_order_payments row is
//      written here, so the deposit is counted exactly once in the deposit
//      ledger, on the day it was actually taken — nothing is double-counted.
//      The cashier is told to collect only bill_total - already_paid
//      (cash_to_collect), and the close-of-day reconciliation subtracts that
//      already-paid amount back out of today's expected cash for cash bills
//      (see getDepositsAppliedSince in src/routes/cash.ts), because the full
//      bill total it counts as cash sales did not all arrive today. The same
//      already-paid figure is stored on the bill as bills.paid_in_advance, so
//      the bill can later say on its own how much of it changed hands at the
//      till (reprints print it; reports split takings with it).
//
//   4. ONE TRANSACTION, CHECKED INSIDE. The body is read first; then the order
//      is re-loaded, its status checked, the bill written and the order linked
//      and marked collected in a single BEGIN IMMEDIATE transaction (createBill
//      nests inside it as a savepoint — see its note). Consequences:
//        * two Collects at once — a double tap, or two tills with different
//          payment methods, which hash to different fingerprints and so would
//          sail past createBill()'s own duplicate gate — cannot both bill: the
//          second finds the order already 'collected' and gets the 409 below
//          carrying the first bill;
//        * nothing half-done can persist: if anything fails after the bill is
//          written, the bill rolls back with it. There is no longer such a
//          thing as a bill no order points at.
//      The bill's cart_id is still the deterministic 'preorder-<id>' and a
//      client-supplied one is ignored: one order, one cart, permanently (see
//      findBillByCartId).
// ---------------------------------------------------------------------------
preorders.post("/:id/collect", async (c) => {
  const user = getUser(c)!;
  const id = finiteNumber(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);
  const db = getDb();

  // --- 1. The body, and everything that depends on it alone ----------------
  const body = await c.req.json().catch(() => ({}));
  const settings = getSettings();

  const method = (body?.payment_method || "cash") as PaymentMethod;
  if (!PAYMENT_METHODS.includes(method)) return c.json({ error: "Unknown payment method." }, 400);

  const discount = money(finiteNumber(body?.discount) ?? 0);
  if (discount < 0) return c.json({ error: "Discount cannot be negative." }, 400);

  const taxRate = finiteNumber(body?.tax_rate) ?? (parseFloat(settings.tax_rate || "0") || 0);
  if (taxRate < 0) return c.json({ error: "Tax rate cannot be negative." }, 400);

  const cashReceived = finiteNumber(body?.cash_received);
  if (cashReceived !== null && cashReceived < 0) {
    return c.json({ error: "Cash received cannot be negative." }, 400);
  }

  // Deterministic and server-chosen — see note 4 above.
  const cartId = `preorder-${id}`;

  // --- 2. Check and write, atomically --------------------------------------
  let outcome: {
    order: any;
    bill: CreatedBill;
    subtotal: number;
    depositApplied: number;
    cashToCollect: number;
    changeDue: number | null;
  };
  try {
    outcome = writeTx(() => {
      const order = loadOrder(id);
      if (!order) throw new Refused(404, { error: "Not found" });

      if (order.status === "cancelled") {
        throw new Refused(400, { error: "This order was cancelled and cannot be collected." });
      }
      if (order.status === "collected") {
        // 409, not 400: the request is not malformed, it has already happened.
        // The existing bill comes back so the till can show/reprint it rather
        // than leaving the cashier wondering whether to ring it up again.
        throw new Refused(409, {
          error: `This order was already collected on bill #${order.bill_id} (token #${order.bill?.token_number}).`,
          already_collected: true,
          pre_order: order,
          bill: order.bill,
        });
      }
      if (order.items.length === 0) {
        throw new Refused(400, { error: "This order has no lines to bill." });
      }

      // A bill already under this order's cart id while the order is still
      // open can only be left over from before collect was one transaction (a
      // crash between "bill written" and "order marked collected"). Billing
      // again would sell the cake twice, so stop and hand it to the owner.
      const stray = findBillByCartId(cartId);
      if (stray) {
        throw new Refused(409, {
          error: `Bill #${stray.id} (token #${stray.token_number}) was already written for this pre-order, but the order was never marked collected. Do NOT bill it again — show this to the owner.`,
          bill: stray,
        });
      }

      if (discount > order.total + CENT) {
        throw new Refused(400, { error: `Discount (${discount}) is more than the order total (${order.total}).` });
      }

      // The same arithmetic createBill() will do, worked out here so the
      // balance can be checked and reported BEFORE any money moves.
      const subtotal = order.total;
      const taxable = subtotal - discount;
      const taxAmount = money(taxable * (taxRate / 100));
      const billTotal = money(taxable + taxAmount);
      const depositApplied = order.amount_paid;

      if (depositApplied > billTotal + CENT) {
        throw new Refused(400, {
          error: `${depositApplied} has already been paid on this order but the bill would only come to ${billTotal}. Reduce the discount, or refund the difference before collecting.`,
        });
      }
      const cashToCollect = money(billTotal - depositApplied);

      if (cashReceived !== null && cashReceived < cashToCollect - CENT) {
        throw new Refused(400, {
          error: `${cashToCollect} is still due on this order; ${money(cashReceived)} is not enough to collect it.`,
        });
      }
      const changeDue = cashReceived === null ? null : money(cashReceived - cashToCollect);

      // Same rule as POST /api/pos/bill. No replay exemption is needed any
      // more: an order that reaches this line has no bill yet (checked just
      // above), so this request is always a new sale.
      const blocked = cashShiftBlockReason();
      if (blocked) throw new Refused(400, { error: blocked });

      let bill: CreatedBill;
      try {
        bill = createBill({
          items: order.items.map((l: any) => ({
            // NULL for a custom line. bill_items.product_id is nullable. The
            // cast is only to satisfy the BillItem signature, which was written
            // for the walk-in till where every line is a catalogue product.
            product_id: (l.product_id ?? null) as unknown as number,
            // The customer's own words become the bill line, and therefore the
            // receipt line and the reporting key.
            product_name: l.description,
            quantity: l.quantity,
            unit_price: l.unit_price,
          })),
          customer_id: order.customer_id,
          discount,
          tax_rate: taxRate,
          payment_method: method,
          user_id: user.id,
          // Deliberately null. bills.amount_given means "cash handed over for
          // this bill at this till", and part of this bill was paid days ago —
          // writing the sum of both there would put a number in the drawer
          // record that was never handed over today. The till gets
          // cash_to_collect / change_due in this response, and the printed slip
          // carries the real breakdown.
          amount_given: null,
          cart_id: cartId,
          // Pre-ordered goods are never stock: see note 1 above.
          skip_stock: true,
        });
      } catch (err: any) {
        throw new Refused(400, { error: err?.message || "Failed to bill this order." });
      }

      // Link and close the order, in the same transaction as the bill. The
      // status guard cannot miss while this transaction holds the write lock,
      // but if it ever did, throwing here takes the bill back out with it.
      const linked = db
        .query(
          `UPDATE pre_orders SET status = 'collected', bill_id = ?, updated_at = datetime('now')
           WHERE id = ? AND status IN ('taken', 'ready')`
        )
        .run(bill.id, id);
      if (Number(linked.changes || 0) !== 1) {
        throw new Refused(500, { error: "This pre-order could not be marked collected. Nothing was billed; try again." });
      }
      db.query("UPDATE bills SET paid_in_advance = ? WHERE id = ?").run(depositApplied, bill.id);

      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'collected_pre_order', ?)").run(
        user.id,
        JSON.stringify({
          pre_order_id: id,
          bill_id: bill.id,
          token: bill.token_number,
          bill_total: bill.total,
          deposit_applied: depositApplied,
          cash_to_collect: cashToCollect,
        })
      );
      return { order, bill, subtotal, depositApplied, cashToCollect, changeDue };
    });
  } catch (err) {
    if (err instanceof Refused) return c.json(err.body, err.status);
    throw err;
  }
  const { order, bill, subtotal, depositApplied, cashToCollect, changeDue } = outcome;

  // --- 3. Receipt, exactly as the walk-in till builds it -------------------
  const billItems = db.query("SELECT * FROM bill_items WHERE bill_id = ?").all(bill.id) as any[];
  const fullBill = db.query("SELECT * FROM bills WHERE id = ?").get(bill.id) as any;
  const receiptData = {
    shopName: settings.shop_name || "My Cake Shop",
    shopAddress: settings.shop_address || "",
    shopPhone: settings.shop_phone || "",
    tokenNumber: bill.token_number,
    billDate: formatDateTime(new Date().toISOString()),
    items: billItems.map((i: any) => ({
      name: i.product_name,
      qty: i.quantity,
      price: i.unit_price,
      total: i.total,
      original_price: i.original_price,
    })),
    subtotal: fullBill.subtotal,
    discount: fullBill.discount,
    taxRate: fullBill.tax_rate,
    taxAmount: fullBill.tax_amount,
    total: fullBill.total,
    paymentMethod: fullBill.payment_method,
    cashierName: user.full_name,
    customerName: order.customer_name as string,
    amountGiven: null,
    changeGiven: null,
  };
  const receiptText =
    buildReceiptText(receiptData) +
    (buildPreorderSettlementBlock({
      preOrderId: id,
      billTotal: fullBill.total,
      depositApplied,
      cashToCollect,
      cashReceived,
      changeDue,
    }) || "");
  const kitchenText = buildKitchenTicket(receiptData);

  // Fire and forget, like POST /api/pos/bill: the sale is committed, so a
  // jammed printer must not freeze the till.
  queuePrint(receiptText)
    .then((r) => {
      if (!r.success) console.error(`[print] pre-order #${id} bill #${bill.id}: ${r.error}`);
    })
    .catch((err: any) => {
      console.error(`[print] pre-order #${id} bill #${bill.id}: ${err?.message || err}`);
    });

  return c.json({
    pre_order: loadOrder(id),
    bill,
    order_total: subtotal,
    discount,
    tax_rate: taxRate,
    tax_amount: fullBill.tax_amount,
    // The FULL value of the sale. This is what the day's sales record.
    bill_total: fullBill.total,
    // Already in the drawer from an earlier day (or earlier today) — NOT
    // collected again now. Also stored as bills.paid_in_advance.
    deposit_applied: depositApplied,
    // The only money that changes hands at this collection.
    cash_to_collect: cashToCollect,
    cash_received: cashReceived,
    change_due: changeDue,
    receipt_text: receiptText,
    kitchen_text: kitchenText,
    print_queued: true,
    // Always false now: a repeat Collect is answered with the 409 above, never
    // by replaying the bill. Kept so the pages' existing check stays valid.
    replayed: false,
  });
});

export default preorders;
