import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly, getUser } from "../middleware/auth";
import { createBill, findBillByCartId } from "../services/billing";
import { buildKitchenTicket, buildReceiptText, getSettings, queuePrint } from "../services/printer";
import { formatDateTime, todayDate } from "../utils/helpers";
import { cashShiftBlockReason } from "./cash";

// ---------------------------------------------------------------------------
// Pre-orders: a customer orders ahead (a custom birthday cake described in
// words, and/or bulk savoury items off the product list) for collection on a
// future date, usually leaving a deposit.
//
// Two rules shape everything in this file:
//
//   1. A PRE-ORDER RESERVES NO STOCK. Nothing here writes to
//      stock_reservations and nothing here touches products.stock_quantity. A
//      cake due next Saturday must not lock today's shelf. Stock moves exactly
//      once, at collection, because collection goes through the ordinary
//      createBill() — the same code path as any walk-in sale.
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
 *               collection_date = today AND status = 'taken'.
 *   collected — sold. A bill exists (bill_id), stock has moved, the money is
 *               settled. Terminal.
 *   cancelled — the order will not happen. Terminal.
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
 * Throws with a cashier-readable message; the caller turns that into a 400.
 */
function normaliseLines(raw: unknown): NormalisedLine[] {
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
      if (product.is_discontinued) {
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
  const toBake = db
    .query("SELECT COUNT(*) AS n FROM pre_orders WHERE collection_date = ? AND status = 'taken'")
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

  return c.json(loadOrder(newId), 201);
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
// ---------------------------------------------------------------------------
preorders.put("/:id", async (c) => {
  const user = getUser(c)!;
  const id = finiteNumber(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);
  const db = getDb();

  const existing = db.query("SELECT * FROM pre_orders WHERE id = ?").get(id) as any;
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (!(OPEN_STATUSES as string[]).includes(existing.status)) {
    return c.json({ error: `This order is ${existing.status} and can no longer be changed.` }, 400);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Invalid request body." }, 400);

  let collectionDate = existing.collection_date;
  if (body.collection_date !== undefined) {
    const d = resolveDate(body.collection_date);
    if (!d) return c.json({ error: "collection_date must be a date in YYYY-MM-DD form." }, 400);
    collectionDate = d;
  }

  let collectionTime = existing.collection_time;
  if (body.collection_time !== undefined) {
    collectionTime =
      typeof body.collection_time === "string" && body.collection_time.trim()
        ? body.collection_time.trim().slice(0, 50)
        : null;
  }

  let notes = existing.notes;
  if (body.notes !== undefined) {
    notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, 2000) : null;
  }

  // Status may only be nudged between taken and ready here. Collecting writes
  // a bill and cancelling releases a promise; both have their own route, so
  // neither can be reached by PUTting a string.
  let status: Status = existing.status;
  if (body.status !== undefined) {
    if (!(OPEN_STATUSES as string[]).includes(body.status)) {
      return c.json(
        { error: "status here may only be 'taken' or 'ready'. Use /collect or /cancel for the rest." },
        400
      );
    }
    status = body.status;
  }

  // Lines are replaced wholesale when present, never diffed: the screen holds
  // the whole order, and a diff drifts the moment one request is lost.
  let lines: NormalisedLine[] | null = null;
  if (body.items !== undefined) {
    try {
      lines = normaliseLines(body.items);
    } catch (err: any) {
      return c.json({ error: err?.message || "Invalid order lines." }, 400);
    }
    const newTotal = sumLines(lines);
    const paid = amountPaid(id);
    if (newTotal < paid - CENT) {
      return c.json(
        {
          error: `The new total (${newTotal}) is less than the ${paid} already paid on this order. Refund the difference first, or keep the total at or above ${paid}.`,
        },
        400
      );
    }
  }

  const deleteItems = db.query("DELETE FROM pre_order_items WHERE pre_order_id = ?");
  const insertItem = db.query(
    "INSERT INTO pre_order_items (pre_order_id, product_id, description, quantity, unit_price) VALUES (?, ?, ?, ?, ?)"
  );

  db.transaction(() => {
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
  })();

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

  const existing = db.query("SELECT id, status FROM pre_orders WHERE id = ?").get(id) as any;
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (!(OPEN_STATUSES as string[]).includes(existing.status)) {
    return c.json({ error: `This order is ${existing.status}; its status is settled.` }, 400);
  }

  const body = await c.req.json().catch(() => null);
  const status = body?.status;
  if (!(OPEN_STATUSES as string[]).includes(status)) {
    return c.json({ error: "status must be 'taken' or 'ready'." }, 400);
  }

  db.query("UPDATE pre_orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('taken', 'ready')").run(
    status,
    id
  );
  db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'pre_order_status', ?)").run(
    user.id,
    JSON.stringify({ pre_order_id: id, from: existing.status, to: status })
  );
  return c.json(loadOrder(id));
});

// ---------------------------------------------------------------------------
// POST /api/preorders/:id/payments — take a deposit or a top-up.
//
// Not adminOnly: taking the deposit is the other half of taking the order.
// ---------------------------------------------------------------------------
preorders.post("/:id/payments", async (c) => {
  const user = getUser(c)!;
  const id = finiteNumber(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);
  const db = getDb();

  const existing = db.query("SELECT id, status FROM pre_orders WHERE id = ?").get(id) as any;
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (!(OPEN_STATUSES as string[]).includes(existing.status)) {
    // A collected order's money is settled by its bill; a cancelled order
    // should not be taking more money.
    return c.json({ error: `This order is ${existing.status}; no further payment can be recorded against it.` }, 400);
  }

  const body = await c.req.json().catch(() => null);
  const amount = finiteNumber(body?.amount);
  if (amount === null || amount <= 0) return c.json({ error: "Amount must be more than zero." }, 400);

  const method = (body?.payment_method || "cash") as PaymentMethod;
  if (!PAYMENT_METHODS.includes(method)) return c.json({ error: "Unknown payment method." }, 400);

  const paidOn = body?.paid_on ? resolveDate(body.paid_on) : todayDate();
  if (!paidOn) return c.json({ error: "paid_on must be a date in YYYY-MM-DD form." }, 400);

  // Never more than the balance. An overpayment would have to be refunded, and
  // there is no refund path for pre-orders — so it is refused at the door
  // instead of being stored as a negative balance nobody notices.
  const total = recacheTotal(id);
  const paid = amountPaid(id);
  const balance = money(total - paid);
  if (money(amount) > balance + CENT) {
    return c.json(
      { error: `Only ${balance} is outstanding on this order; ${money(amount)} would overpay it.` },
      400
    );
  }

  if (method === "cash") {
    const blocked = cashShiftBlockReason();
    if (blocked) return c.json({ error: blocked }, 400);
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
  return c.json(loadOrder(id), 201);
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

  const order = db.query("SELECT id, status FROM pre_orders WHERE id = ?").get(id) as any;
  if (!order) return c.json({ error: "Not found" }, 404);
  if (order.status === "collected") {
    return c.json({ error: "This order has been collected and billed; its payments cannot be altered." }, 400);
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
// Cancelling does NOT refund and does NOT delete the deposit rows. Those rows
// are the record of cash that really did enter the drawer on a day that has
// already been reconciled; deleting them would retroactively falsify that
// close. The response reports refund_due so the owner can pay it out through
// the existing cash-expense path.
// ---------------------------------------------------------------------------
preorders.post("/:id/cancel", adminOnly, async (c) => {
  const user = getUser(c)!;
  const id = finiteNumber(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);
  const db = getDb();

  const existing = db.query("SELECT * FROM pre_orders WHERE id = ?").get(id) as any;
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (existing.status === "collected") {
    return c.json(
      { error: `This order was collected on bill #${existing.bill_id}. Refund the bill instead of cancelling the order.` },
      400
    );
  }
  if (existing.status === "cancelled") {
    return c.json({ error: "This order is already cancelled." }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  const paid = amountPaid(id);

  db.transaction(() => {
    // The reason is appended to notes rather than given a column of its own:
    // it is read by a human on the order screen and nothing aggregates it.
    const note = reason ? `${existing.notes ? existing.notes + "\n" : ""}[Cancelled] ${reason}` : existing.notes;
    db.query(
      "UPDATE pre_orders SET status = 'cancelled', notes = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('taken', 'ready')"
    ).run(note, id);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cancelled_pre_order', ?)").run(
      user.id,
      JSON.stringify({ pre_order_id: id, reason, refund_due: paid })
    );
  })();

  return c.json({
    ...loadOrder(id),
    // Money already taken that the shop now owes back. Reported, not acted on:
    // the owner pays it out as a cash expense, which is what the drawer and the
    // books already understand.
    refund_due: paid,
  });
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

/**
 * The extra block printed under a pre-order's receipt.
 *
 * buildReceiptText() knows nothing about deposits (it describes one bill paid
 * in one go), so the breakdown the customer needs — what the cake cost, what
 * they had already paid, what they handed over today — is appended here. Same
 * width and the same label/value alignment as the receipt it is glued to, so it
 * comes off the thermal printer as one slip.
 */
function settlementBlock(args: {
  preOrderId: number;
  billTotal: number;
  depositApplied: number;
  cashToCollect: number;
  cashReceived: number | null;
  changeDue: number | null;
}): string | null {
  // Nothing to add when the order was paid in full at the counter like any
  // other sale and no change was worked out: the receipt above already says it
  // all, and a block reading "Paid in Advance -0.00" is noise that invites the
  // customer to ask what it means.
  if (args.depositApplied <= CENT && args.cashReceived == null) return null;
  const w = 28;
  const center = (t: string) => " ".repeat(Math.max(0, Math.floor((w - t.length) / 2))) + t;
  const line = (label: string, value: number, neg = false) =>
    `${label.padEnd(17)} ${(neg ? "-" : "") + value.toFixed(2)}`.padEnd(w);

  const lines: string[] = [];
  lines.push("");
  lines.push("=".repeat(w));
  lines.push(center(`PRE-ORDER #${args.preOrderId}`));
  lines.push("-".repeat(w));
  lines.push(line("Bill Total", args.billTotal));
  if (args.depositApplied > CENT) {
    lines.push(line("Paid in Advance", args.depositApplied, true));
    lines.push(line("Balance Due Now", args.cashToCollect));
  }
  if (args.cashReceived != null) {
    lines.push(line("Cash Given", args.cashReceived));
    lines.push(line("Change", args.changeDue ?? 0));
  }
  lines.push("=".repeat(w));
  return "\n" + lines.join("\n");
}

// ---------------------------------------------------------------------------
// POST /api/preorders/:id/collect — the customer is at the counter.
//
// Not adminOnly: this is a sale, and ringing up sales is the cashier's job.
//
// What it does, and why in this order:
//
//   1. It writes a REAL BILL through the ordinary createBill(). Not a special
//      "pre-order sale" path — the same function the walk-in till uses. That is
//      what makes the token, the receipt, the stock deduction, the duplicate
//      guard, the activity log, the day's sales total and every report behave
//      identically to any other sale. The day's takings are only correct
//      because this is not special-cased.
//
//   2. CUSTOM FREE-TEXT LINES reach the bill with product_id = NULL and the
//      customer's own description as product_name. bill_items.product_id is
//      nullable and bill_items.product_name is the text every report groups on,
//      so a custom cake appears in the day's sales, in top products and on the
//      receipt with its real revenue. computeStockNeeds() looks a line's
//      product up by id, finds nothing for a NULL, and so moves no stock —
//      which is right: a custom cake has no catalogue row, no recipe and no
//      stock count. Its cost_price lands as 0 for the same reason (there is no
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
//      bill total it counts as cash sales did not all arrive today.
//
//   4. Idempotency comes free. The bill's cart_id is always the deterministic
//      'preorder-<id>', which the UNIQUE index on bills(cart_id) and the gate
//      inside createBill() already protect: a double-tapped Collect replays the
//      first bill instead of writing a second, burning a second token, or
//      deducting stock twice. A client-supplied cart_id is deliberately
//      ignored, since accepting one would defeat exactly that guard.
// ---------------------------------------------------------------------------
preorders.post("/:id/collect", async (c) => {
  const user = getUser(c)!;
  const id = finiteNumber(c.req.param("id"));
  if (id === null) return c.json({ error: "Not found" }, 404);
  const db = getDb();

  const order = loadOrder(id);
  if (!order) return c.json({ error: "Not found" }, 404);

  if (order.status === "cancelled") {
    return c.json({ error: "This order was cancelled and cannot be collected." }, 400);
  }
  if (order.status === "collected") {
    // 409, not 400: the request is not malformed, it has already happened. The
    // existing bill comes back so the till can show/reprint it rather than
    // leaving the cashier wondering whether to ring it up again.
    return c.json(
      {
        error: `This order was already collected on bill #${order.bill_id} (token #${order.bill?.token_number}).`,
        already_collected: true,
        pre_order: order,
        bill: order.bill,
      },
      409
    );
  }
  if (order.items.length === 0) {
    return c.json({ error: "This order has no lines to bill." }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const settings = getSettings();

  const method = (body?.payment_method || "cash") as PaymentMethod;
  if (!PAYMENT_METHODS.includes(method)) return c.json({ error: "Unknown payment method." }, 400);

  const discount = money(finiteNumber(body?.discount) ?? 0);
  if (discount < 0) return c.json({ error: "Discount cannot be negative." }, 400);
  if (discount > order.total + CENT) {
    return c.json({ error: `Discount (${discount}) is more than the order total (${order.total}).` }, 400);
  }

  const taxRate = finiteNumber(body?.tax_rate) ?? (parseFloat(settings.tax_rate || "0") || 0);
  if (taxRate < 0) return c.json({ error: "Tax rate cannot be negative." }, 400);

  // The same arithmetic createBill() will do, worked out here so the balance
  // can be checked and reported BEFORE any money or stock moves.
  const subtotal = order.total;
  const taxable = subtotal - discount;
  const taxAmount = money(taxable * (taxRate / 100));
  const billTotal = money(taxable + taxAmount);
  const depositApplied = order.amount_paid;

  if (depositApplied > billTotal + CENT) {
    return c.json(
      {
        error: `${depositApplied} has already been paid on this order but the bill would only come to ${billTotal}. Reduce the discount, or refund the difference before collecting.`,
      },
      400
    );
  }
  const cashToCollect = money(billTotal - depositApplied);

  const cashReceived = finiteNumber(body?.cash_received);
  if (cashReceived !== null) {
    if (cashReceived < 0) return c.json({ error: "Cash received cannot be negative." }, 400);
    if (cashReceived < cashToCollect - CENT) {
      return c.json(
        { error: `${cashToCollect} is still due on this order; ${money(cashReceived)} is not enough to collect it.` },
        400
      );
    }
  }
  const changeDue = cashReceived === null ? null : money(cashReceived - cashToCollect);

  // Deterministic and server-chosen — see note 4 in the header above.
  const cartId = `preorder-${id}`;
  const knownReplay = findBillByCartId(cartId) !== null;

  // Same exemption as POST /api/pos/bill: a resubmission of a sale that is
  // already on disk writes nothing, so a policy gate must not turn it into an
  // error that reads to the cashier as "the sale failed".
  if (!knownReplay) {
    const blocked = cashShiftBlockReason();
    if (blocked) return c.json({ error: blocked }, 400);
  }

  let bill;
  try {
    bill = createBill({
      items: order.items.map((l: any) => ({
        // NULL for a custom line. bill_items.product_id is nullable and
        // createBill()/computeStockNeeds() both handle a missing product by
        // moving no stock, which is exactly the required behaviour. The cast is
        // only to satisfy the BillItem signature, which was written for the
        // walk-in till where every line is a catalogue product.
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
      // Deliberately null. bills.amount_given means "cash handed over for this
      // bill at this till", and part of this bill was paid days ago — writing
      // the sum of both there would put a number in the drawer record that was
      // never handed over today. The till gets cash_to_collect / change_due in
      // this response, and the printed slip carries the real breakdown.
      amount_given: null,
      cart_id: cartId,
    });
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to bill this order." }, 400);
  }

  const isReplay = bill.replayed === true;

  // Link and close the order. Guarded on the open statuses so two simultaneous
  // Collects cannot both claim it: the loser matches no row, and since
  // createBill() handed it the SAME bill, the order is already pointing where
  // it should.
  const linked = db
    .query(
      `UPDATE pre_orders SET status = 'collected', bill_id = ?, updated_at = datetime('now')
       WHERE id = ? AND status IN ('taken', 'ready')`
    )
    .run(bill.id, id);
  if (Number(linked.changes || 0) === 0) {
    const now = db.query("SELECT status, bill_id FROM pre_orders WHERE id = ?").get(id) as any;
    if (!(now?.status === "collected" && now?.bill_id === bill.id)) {
      // The bill is committed and must not be hidden, but the order did not
      // close — say so loudly rather than reporting a clean collection.
      console.error(
        `[preorders] bill #${bill.id} was written for pre-order #${id} but the order could not be marked collected (status=${now?.status}, bill_id=${now?.bill_id})`
      );
      return c.json(
        {
          error: `Bill #${bill.id} (token #${bill.token_number}) was created, but this pre-order could not be marked collected. Do NOT bill it again — show this to the owner.`,
          bill,
        },
        500
      );
    }
  }
  if (!isReplay) {
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
  }

  // --- Receipt, exactly as the walk-in till builds it ----------------------
  const billItems = db.query("SELECT * FROM bill_items WHERE bill_id = ?").all(bill.id) as any[];
  const fullBill = db.query("SELECT * FROM bills WHERE id = ?").get(bill.id) as any;
  let cashierName = user.full_name;
  if (isReplay && fullBill.user_id) {
    const orig = db.query("SELECT full_name FROM users WHERE id = ?").get(fullBill.user_id) as any;
    if (orig?.full_name) cashierName = orig.full_name;
  }
  const receiptData = {
    shopName: settings.shop_name || "My Cake Shop",
    shopAddress: settings.shop_address || "",
    shopPhone: settings.shop_phone || "",
    tokenNumber: bill.token_number,
    // On a replay the slip must describe the sale, not this request.
    billDate: formatDateTime(isReplay ? fullBill.created_at : new Date().toISOString()),
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
    cashierName,
    customerName: order.customer_name as string,
    amountGiven: null,
    changeGiven: null,
  };
  const receiptText =
    buildReceiptText(receiptData) +
    (settlementBlock({
      preOrderId: id,
      billTotal: fullBill.total,
      depositApplied,
      cashToCollect,
      cashReceived,
      changeDue,
    }) || "");
  const kitchenText = buildKitchenTicket(receiptData);

  // Fire and forget, like POST /api/pos/bill: the sale is committed, so a
  // jammed printer must not freeze the till. A replay queues nothing — two
  // slips bearing one token is the confusion the duplicate guard exists to
  // prevent — but the text still comes back so the screen can show it.
  if (!isReplay) {
    queuePrint(receiptText)
      .then((r) => {
        if (!r.success) console.error(`[print] pre-order #${id} bill #${bill.id}: ${r.error}`);
      })
      .catch((err: any) => {
        console.error(`[print] pre-order #${id} bill #${bill.id}: ${err?.message || err}`);
      });
  } else {
    console.warn(
      `[preorders] duplicate collect for pre-order #${id} — replayed bill #${bill.id} token #${bill.token_number}, no second bill written`
    );
  }

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
    // collected again now.
    deposit_applied: depositApplied,
    // The only money that changes hands at this collection.
    cash_to_collect: cashToCollect,
    cash_received: cashReceived,
    change_due: changeDue,
    receipt_text: receiptText,
    kitchen_text: kitchenText,
    print_queued: !isReplay,
    replayed: isReplay,
  });
});

export default preorders;
