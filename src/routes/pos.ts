import { Hono } from "hono";
import { getDb } from "../db/database";
import { getUser } from "../middleware/auth";
import { createBill, findBillByCartId, findBillBySale, saleFingerprint, getNextTokenNumber } from "../services/billing";
import { getSettings, buildReceiptText, buildKitchenTicket, buildProformaText, queuePrint } from "../services/printer";
import { restoreStockForBill } from "../services/stock";
import {
  syncCartReservations,
  releaseCartReservations,
  listActiveHolds,
  releaseHold,
  getCartHolds,
} from "../services/reservations";
import { adminOnly } from "../middleware/auth";
import { todayDate, formatDateTime } from "../utils/helpers";

const pos = new Hono();

pos.get("/token", (c) => {
  return c.json({ next_token: getNextTokenNumber() });
});

pos.post("/bill", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json();

  if (!body.items || body.items.length === 0) {
    return c.json({ error: "No items in bill" }, 400);
  }

  const settings = getSettings();
  const tax_rate = body.tax_rate ?? parseFloat(settings.tax_rate || "0");

  // Server-side duplicate-bill protection. The client guard (withBusy + the
  // checkoutInProgress flag) lives in one browser tab; two tabs, a reload
  // mid-request, or a connection that retries can still post the same sale
  // twice. The idempotency key is the cart id PAIRED WITH a fingerprint of the
  // sale's contents AND BOUNDED IN TIME — see saleFingerprint(), createBill()
  // and REPLAY_WINDOW_MINUTES. None of the three is droppable:
  //   * the cart id alone is not enough, because a lost response leaves the
  //     next customer's sale arriving under the old id, and keying on the id
  //     alone replayed the previous bill and swallowed that sale;
  //   * id + fingerprint is not enough either, because the same basket is sold
  //     again later. Untimed, a two-day-old bill matched a live sale and
  //     swallowed it the same way. Only a match from the last few minutes is a
  //     retry; anything older is a repeat order and gets its own bill.
  //
  // Fingerprinted from the RESOLVED tax rate and the same defaults createBill()
  // applies, so this hash and the one it computes cannot disagree.
  const cartId = String(body.cart_id || "").trim();
  const fingerprint = cartId
    ? saleFingerprint({
        items: body.items,
        customer_id: body.customer_id || null,
        discount: body.discount || 0,
        tax_rate,
        payment_method: body.payment_method || "cash",
        amount_given: body.amount_given ?? null,
      })
    : "";

  // This lookup is ADVISORY ONLY: it decides nothing about writing (createBill()
  // repeats the check inside its transaction, where it cannot go stale). It is
  // read here for one reason: a resubmission of a sale that is ALREADY recorded
  // writes nothing, so no policy gate below should turn it into an error. The
  // cash-shift rule exists to stop new money being taken outside an open shift;
  // handing back a receipt for money already banked is not that, and failing it
  // would leave the cashier believing the sale never happened.
  //
  // Matched on the PAIR, not on the cart id: a stale cart id carrying a sale
  // that has NOT been recorded is new money, and the shift rule must apply to
  // it exactly as it would to any other sale.
  const knownReplay = findBillBySale(cartId, fingerprint) !== null;

  // Enforce cash shift state. A shift is "open" when the most recent 'open'
  // record (across all dates) has no 'close' recorded after it. Shifts intentionally
  // span midnight so the cashier must explicitly close before starting fresh.
  if (settings.enforce_cash_shift === "1" && !knownReplay) {
    const db = getDb();
    const today = todayDate();
    const latestOpen = db.query(
      "SELECT created_at, count_date FROM cash_counts WHERE count_type = 'open' ORDER BY created_at DESC LIMIT 1"
    ).get() as { created_at: string; count_date: string } | null;
    const latestClose = db.query(
      "SELECT created_at FROM cash_counts WHERE count_type = 'close' ORDER BY created_at DESC LIMIT 1"
    ).get() as { created_at: string } | null;
    const shiftOpen = latestOpen && (!latestClose || new Date(latestClose.created_at) < new Date(latestOpen.created_at));
    if (!shiftOpen) {
      const msg = !latestOpen
        ? "Cash drawer not opened. Record opening float on the Cash Drawer page before taking sales."
        : "The cash shift has been closed. Open a new shift on the Cash Drawer page to continue billing.";
      return c.json({ error: msg }, 400);
    }
    if (latestOpen && latestOpen.count_date !== today) {
      return c.json({ error: `A shift from ${latestOpen.count_date} is still open. Close it on the Cash Drawer page before starting today's sales.` }, 400);
    }
  }

  let bill;
  try {
    bill = createBill({
      items: body.items,
      customer_id: body.customer_id || null,
      discount: body.discount || 0,
      tax_rate,
      payment_method: body.payment_method || "cash",
      user_id: user.id,
      amount_given: body.amount_given ?? null,
      // Threaded through so createBill() can release this cart's holds in the
      // same transaction as the stock deduction — and so it can recognise a
      // resubmission of this same SALE (this cart id plus this fingerprint) and
      // replay its bill instead of writing a second one. createBill() derives
      // the fingerprint itself from these very params, so there is no second
      // definition of it to drift.
      cart_id: cartId || null,
    });
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to create bill" }, 400);
  }

  // A resubmission got its own bill back instead of a second one. Everything
  // below still runs: the till is waiting for a receipt and must get the real
  // one, and it is read out of the stored bill either way.
  const isReplay = bill.replayed === true;

  // createBill() released this cart's holds inside the sale transaction, so its
  // claim now describes a cart that is over - the till rotates to a fresh cart
  // id the moment a sale completes. Outside that transaction on purpose: the
  // money is committed, and failing to tidy up an annotation must not turn a
  // recorded sale into an error (releaseCartClaim logs and swallows). A replay
  // tidies up too - the holds were already gone either way.
  releaseCartClaim(cartId);
  // The order became a bill, so it is not a parked order any more. Same call
  // site and same reasoning as the claim above: outside the sale transaction
  // (which lives in createBill() and has already committed), best-effort, and
  // never able to turn a recorded sale into an error. A replay tidies up too —
  // this cart is sold either way.
  releaseParkedCart(cartId);

  // Generate receipt
  const db = getDb();
  const billItems = db.query("SELECT * FROM bill_items WHERE bill_id = ?").all(bill.id) as any[];
  const fullBill = db.query("SELECT * FROM bills WHERE id = ?").get(bill.id) as any;
  let customerName: string | undefined;
  if (fullBill.customer_id) {
    const cust = db.query("SELECT name FROM customers WHERE id = ?").get(fullBill.customer_id) as any;
    customerName = cust?.name;
  }

  // On a replay the slip must describe the SALE, not this request: the time the
  // money was taken and the cashier who took it, exactly as the reprint route
  // does. For a fresh sale both are "now" and "me", so nothing changes there.
  const billDateText = formatDateTime(isReplay ? fullBill.created_at : new Date().toISOString());
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
    billDate: billDateText,
    items: billItems.map((i: any) => ({ name: i.product_name, qty: i.quantity, price: i.unit_price, total: i.total, original_price: i.original_price })),
    subtotal: fullBill.subtotal,
    discount: fullBill.discount,
    taxRate: fullBill.tax_rate,
    taxAmount: fullBill.tax_amount,
    total: fullBill.total,
    paymentMethod: fullBill.payment_method,
    cashierName,
    customerName,
    amountGiven: fullBill.amount_given,
    changeGiven: fullBill.change_given,
  };

  // Build the slips synchronously (pure string work), then hand the device write to
  // the print queue WITHOUT awaiting it. The bill is already committed at this point,
  // so a slow/jammed/offline printer must not keep the cashier staring at a frozen
  // screen — that wait is what made them tap Pay twice.
  const receiptText = buildReceiptText(receiptData);
  const kitchenText = buildKitchenTicket(receiptData);
  // A replay does NOT re-queue the device write. The sale that was actually
  // recorded already queued its slip, and a second identical slip bearing the
  // same token is worse than no slip: two pieces of paper for one sale is
  // exactly the confusion this whole guard exists to prevent, and the counter
  // reconciles by slip. The text still comes back in the response, so the till
  // shows the receipt, and /api/pos/bills/:id/receipt reprints on demand.
  if (!isReplay) {
    queuePrint(receiptText).then((r) => {
      if (!r.success) console.error(`[print] bill #${bill.id} token #${bill.token_number}: ${r.error}`);
    }).catch((err: any) => {
      console.error(`[print] bill #${bill.id} token #${bill.token_number}: ${err?.message || err}`);
    });
  } else {
    console.warn(
      `[pos] duplicate submission of the same sale on cart ${cartId} (fingerprint ${fingerprint.slice(0, 12)}) — replayed bill #${bill.id} token #${bill.token_number}, no second bill written`
    );
  }

  // Same keys, same types, fresh sale or replay — what tells them apart is
  // `replayed`, and BOTH tills now read it (checkout() in views/pos.html and
  // views/m-pos.html). They must: a replay wrote no new bill, and telling the
  // cashier "Bill created successfully" over an older bill's receipt is how a
  // lost sale went unnoticed. Everything else in this payload describes the one
  // real bill either way.
  // print_queued, not print_success: the write hasn't happened yet, so we can't
  // honestly report its outcome (and on a replay we did not queue one at all, so
  // it is false).
  return c.json({ ...bill, receipt_text: receiptText, kitchen_text: kitchenText, print_queued: !isReplay });
});

// Pre-payment slip. The cashier prints this, hands it over, takes the money and
// THEN presses Pay, which runs POST /bill exactly as before.
//
// Print-only by design: no bill row, no token, no stock movement, no activity log
// — nothing here touches the database except reading settings and (optionally) the
// customer's name. The cart stays intact in the browser, so the sale that follows
// is the ordinary one. That also means a proforma can be printed as many times as
// the cashier likes without burning a token or double-counting anything.
//
// Auth: same as every other route on this router — mounted behind authMiddleware
// in src/index.ts, so any logged-in user (cashier included) can print one. No
// adminOnly here: it writes nothing, and a cashier who can ring up a sale must
// obviously be able to quote its price first.
pos.post("/proforma", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json();

  if (!body.items || body.items.length === 0) {
    return c.json({ error: "No items to print" }, 400);
  }

  const settings = getSettings();
  const tax_rate = body.tax_rate ?? parseFloat(settings.tax_rate || "0");
  const discount = body.discount || 0;
  const items = body.items as {
    product_name: string;
    quantity: number;
    unit_price: number;
    original_price?: number;
  }[];

  // Totals: copied line for line from createBill() in src/services/billing.ts so
  // the figure on this slip cannot drift from the figure the customer is charged
  // a minute later. Same operands, same order, same lack of rounding — including
  // NOT clamping taxableAmount at zero, because createBill() doesn't either.
  // If billing.ts ever changes, this block must change with it.
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  const taxableAmount = subtotal - discount;
  const tax_amount = taxableAmount * (tax_rate / 100);
  const total = taxableAmount + tax_amount;

  let customerName: string | undefined;
  if (body.customer_id) {
    const db = getDb();
    const cust = db.query("SELECT name FROM customers WHERE id = ?").get(body.customer_id) as any;
    customerName = cust?.name;
  }

  const proformaText = buildProformaText({
    shopName: settings.shop_name || "My Cake Shop",
    shopAddress: settings.shop_address || "",
    shopPhone: settings.shop_phone || "",
    billDate: formatDateTime(new Date().toISOString()),
    items: items.map((i) => ({
      name: i.product_name,
      qty: i.quantity,
      price: i.unit_price,
      total: i.quantity * i.unit_price,
      original_price: i.original_price,
    })),
    subtotal,
    discount,
    taxRate: tax_rate,
    taxAmount: tax_amount,
    total,
    customerName,
  });

  // Same fire-and-forget as the bill route: the text is already built, and a
  // jammed or offline printer must not freeze the till. Going through queuePrint()
  // keeps this slip from interleaving its ESC/POS bytes with a receipt.
  queuePrint(proformaText).then((r) => {
    if (!r.success) console.error(`[print] proforma by ${user.username}: ${r.error}`);
  }).catch((err: any) => {
    console.error(`[print] proforma by ${user.username}: ${err?.message || err}`);
  });

  return c.json({ proforma_text: proformaText, print_queued: true });
});

pos.get("/bills", (c) => {
  const db = getDb();
  const date = c.req.query("date");
  const search = c.req.query("search");
  const limit = parseInt(c.req.query("limit") || "50");
  const offset = parseInt(c.req.query("offset") || "0");

  let query = `
    SELECT b.*, u.full_name as cashier_name, c.name as customer_name
    FROM bills b
    LEFT JOIN users u ON b.user_id = u.id
    LEFT JOIN customers c ON b.customer_id = c.id
  `;
  const conditions: string[] = [];
  const params: any[] = [];

  if (date) {
    conditions.push("b.bill_date = ?");
    params.push(date);
  }
  if (search) {
    conditions.push("(b.token_number = ? OR c.name LIKE ? OR c.phone LIKE ?)");
    params.push(parseInt(search) || 0, `%${search}%`, `%${search}%`);
  }

  if (conditions.length) query += " WHERE " + conditions.join(" AND ");
  query += " ORDER BY b.created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const bills = db.query(query).all(...params);
  return c.json(bills);
});

pos.get("/bills/:id", (c) => {
  const db = getDb();
  const bill = db.query(`
    SELECT b.*, u.full_name as cashier_name, c.name as customer_name, c.phone as customer_phone,
           ru.full_name as refunded_by_name
    FROM bills b
    LEFT JOIN users u ON b.user_id = u.id
    LEFT JOIN users ru ON b.refunded_by_user_id = ru.id
    LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.id = ?
  `).get(c.req.param("id"));
  if (!bill) return c.json({ error: "Not found" }, 404);

  const items = db.query("SELECT * FROM bill_items WHERE bill_id = ?").all(c.req.param("id"));
  return c.json({ ...(bill as any), items });
});

pos.post("/bills/:id/refund", async (c) => {
  const db = getDb();
  const user = getUser(c)!;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const reason = (body.reason || "").trim();
  if (!reason) return c.json({ error: "Refund reason is required" }, 400);

  const bill = db.query("SELECT * FROM bills WHERE id = ?").get(id) as any;
  if (!bill) return c.json({ error: "Not found" }, 404);
  if (bill.status !== "completed") return c.json({ error: "Bill is already " + bill.status }, 400);

  const items = db.query("SELECT product_id, quantity FROM bill_items WHERE bill_id = ?").all(id) as any[];

  db.transaction(() => {
    for (const item of items) {
      if (!item.product_id) continue;
      const product = db.query("SELECT track_stock FROM products WHERE id = ?").get(item.product_id) as any;

      // Restore this product's own stock if it's tracked.
      if (product?.track_stock) {
        db.query("UPDATE products SET stock_quantity = stock_quantity + ?, stock_updated_at = datetime('now') WHERE id = ?").run(item.quantity, item.product_id);
      } else {
        restoreStockForBill(item.product_id, item.quantity, Number(id), user.id);
      }

      // Restore any tracked components (composite/BoM).
      const components = db.query(
        "SELECT component_product_id, quantity FROM product_components WHERE product_id = ?"
      ).all(item.product_id) as any[];
      for (const c of components) {
        const comp = db.query("SELECT track_stock FROM products WHERE id = ?").get(c.component_product_id) as any;
        if (comp?.track_stock) {
          db.query("UPDATE products SET stock_quantity = stock_quantity + ?, stock_updated_at = datetime('now') WHERE id = ?").run(c.quantity * item.quantity, c.component_product_id);
        }
      }
    }
    db.query(
      "UPDATE bills SET status = 'refunded', refund_reason = ?, refunded_at = datetime('now'), refunded_by_user_id = ? WHERE id = ?"
    ).run(reason, user.id, id);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'refunded_bill', ?)").run(
      user.id, JSON.stringify({ bill_id: id, token: bill.token_number, amount: bill.total, reason })
    );
  })();

  return c.json({ success: true });
});

pos.get("/bills/:id/receipt", async (c) => {
  const db = getDb();
  const bill = db.query(`
    SELECT b.*, u.full_name as cashier_name, c.name as customer_name
    FROM bills b LEFT JOIN users u ON b.user_id = u.id LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.id = ?
  `).get(c.req.param("id")) as any;
  if (!bill) return c.json({ error: "Not found" }, 404);

  const items = db.query("SELECT * FROM bill_items WHERE bill_id = ?").all(bill.id) as any[];
  const settings = getSettings();

  const receiptData = {
    shopName: settings.shop_name || "My Cake Shop",
    shopAddress: settings.shop_address || "",
    shopPhone: settings.shop_phone || "",
    tokenNumber: bill.token_number,
    billDate: formatDateTime(bill.created_at),
    items: items.map((i: any) => ({ name: i.product_name, qty: i.quantity, price: i.unit_price, total: i.total, original_price: i.original_price })),
    subtotal: bill.subtotal,
    discount: bill.discount,
    taxRate: bill.tax_rate,
    taxAmount: bill.tax_amount,
    total: bill.total,
    paymentMethod: bill.payment_method,
    cashierName: bill.cashier_name,
    customerName: bill.customer_name,
    amountGiven: bill.amount_given,
    changeGiven: bill.change_given,
  };

  // Same treatment as checkout: the caller only renders the text in a browser print
  // popup, and a reprint hits the same shared printer — so it goes through the same
  // queue (never concurrently with a checkout slip) and is not awaited.
  const receiptText = buildReceiptText(receiptData);
  const kitchenText = buildKitchenTicket(receiptData);
  queuePrint(receiptText).then((r) => {
    if (!r.success) console.error(`[print] reprint bill #${bill.id} token #${bill.token_number}: ${r.error}`);
  }).catch((err: any) => {
    console.error(`[print] reprint bill #${bill.id} token #${bill.token_number}: ${err?.message || err}`);
  });

  return c.json({ text: receiptText, kitchen_text: kitchenText, print_queued: true });
});

// --- Cart claims ("which till still intends to sell this?") ------------------
//
// Holds never expire, by the owner's decision: a cart only exists once the
// customer has confirmed the order, so a hold is a real commitment. The cost of
// that is that the "Held stock" screen cannot tell a PARKED cart (holding stock
// on purpose; parking also rotates the till to a fresh cart id, so its hold
// looks like another cart's even on the same machine) from a STRANDED hold
// (closed till, cleared browser storage, or a hold older than the
// cart-persistence fix). Parked carts live in each browser's localStorage
// (kuki_held_carts), so the server can only know about them if the till says so.
//
// A claim is an ANNOTATION, never a lock and never an authorisation: it holds no
// stock, grants nothing, and every field in it is self-asserted by the till.

// Cart ids look like "pos-<base36 time>-<8 chars>" (~22 chars) and till labels
// are short human names. These caps only exist to stop a buggy or hostile till
// writing unbounded junk into the table.
const CLAIM_MAX_LEN = 200;
const CLAIM_MAX_PARKED = 200;

/**
 * Forget a cart's claim, because the cart itself is over.
 *
 * Called at the points where the cart's HOLDS are released - a completed sale
 * and an explicit clear/abandon - so a claim can never outlive the thing it
 * describes. Deliberately NOT a TTL and NOT a cron: a parked cart's claim must
 * survive its till being switched off for the night, exactly as its hold does.
 *
 * Best-effort and never fatal: at the sale call site the money is already
 * committed, and losing a row of annotation must not fail a sale. The till's
 * next heartbeat would correct it anyway (replace semantics).
 */
function releaseCartClaim(cartId: string | null | undefined): void {
  const cart = String(cartId || "").trim();
  if (!cart) return;
  try {
    getDb().query("DELETE FROM cart_claims WHERE cart_id = ?").run(cart);
  } catch (err: any) {
    console.error(`[pos] could not drop the cart claim for ${cart}:`, err?.message || err);
  }
}

// "These are ALL the carts this till is still working on."
//
// Body: { till_id, till_label, active_cart_id: string | null, parked_cart_ids: string[] }
//
// REPLACE semantics per till_id, exactly like /reservations/sync: whatever the
// till sends IS its complete set of claims and replaces its previous ones in one
// transaction. A delta drifts the moment a request is lost; a full replace is
// self-healing - the next call puts the server back in step with the till.
//
// Auth: no adminOnly. A cashier's till is the ONLY thing that knows which carts
// it is working on, so a guard here would silently blind the owner's screen to
// every cashier machine - which is the whole problem this endpoint exists to
// fix. Safe because it writes nothing but annotation: no stock moves, no money,
// no hold is created or released, and the worst a dishonest caller achieves is a
// wrong till label beside a hold it could already have created or released
// through /reservations/sync. user_id comes from getUser(c), never the body.
pos.post("/carts/claim", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Body must be a JSON object" }, 400);
  }

  const tillId = typeof body.till_id === "string" ? body.till_id.trim() : "";
  if (!tillId) return c.json({ error: "till_id is required and must be a non-empty string" }, 400);
  if (tillId.length > CLAIM_MAX_LEN) {
    return c.json({ error: `till_id must be at most ${CLAIM_MAX_LEN} characters` }, 400);
  }

  if (body.till_label != null && typeof body.till_label !== "string") {
    return c.json({ error: "till_label must be a string" }, 400);
  }
  // Falls back to the till id so the owner's screen always has something to
  // print beside a hold, even from a till that never set a friendly name.
  const tillLabel =
    (typeof body.till_label === "string" ? body.till_label.trim() : "").slice(0, CLAIM_MAX_LEN) || tillId;

  // null / absent = "no cart open on this till right now", a real and ordinary
  // state (nothing rung up yet). A blank string is NOT accepted as that: it is
  // the signature of a till that failed to read its own cart id, and silently
  // reading it as "no cart" would strand that cart's hold on the very screen
  // this feature exists to clear up.
  let activeCartId: string | null = null;
  if (body.active_cart_id != null) {
    if (typeof body.active_cart_id !== "string") {
      return c.json({ error: "active_cart_id must be a string or null" }, 400);
    }
    activeCartId = body.active_cart_id.trim();
    if (!activeCartId) {
      return c.json({ error: "active_cart_id must be a non-empty string, or null if no cart is open" }, 400);
    }
    if (activeCartId.length > CLAIM_MAX_LEN) {
      return c.json({ error: `active_cart_id must be at most ${CLAIM_MAX_LEN} characters` }, 400);
    }
  }

  if (!Array.isArray(body.parked_cart_ids)) {
    return c.json({ error: "parked_cart_ids must be an array of cart ids (send [] if none are parked)" }, 400);
  }
  if (body.parked_cart_ids.length > CLAIM_MAX_PARKED) {
    return c.json({ error: `parked_cart_ids must hold at most ${CLAIM_MAX_PARKED} cart ids` }, 400);
  }
  const parkedCartIds: string[] = [];
  for (let i = 0; i < body.parked_cart_ids.length; i++) {
    const raw = body.parked_cart_ids[i];
    if (typeof raw !== "string") {
      return c.json({ error: `parked_cart_ids[${i}] must be a string` }, 400);
    }
    const cart = raw.trim();
    if (!cart) return c.json({ error: `parked_cart_ids[${i}] must be a non-empty string` }, 400);
    if (cart.length > CLAIM_MAX_LEN) {
      return c.json({ error: `parked_cart_ids[${i}] must be at most ${CLAIM_MAX_LEN} characters` }, 400);
    }
    // The same cart parked twice is harmless but meaningless - one row per cart.
    if (!parkedCartIds.includes(cart)) parkedCartIds.push(cart);
  }
  // Rejected rather than resolved: parking rotates the till to a fresh cart id,
  // so one cart genuinely cannot be both, and a caller reporting both has a bug.
  // cart_claims stores one state per cart, and guessing which one the till meant
  // would put a wrong word ("active" / "parked") in front of the owner at
  // exactly the moment they are deciding whether to release the stock.
  if (activeCartId && parkedCartIds.includes(activeCartId)) {
    return c.json({ error: `cart ${activeCartId} cannot be both the active cart and a parked cart` }, 400);
  }

  const claims: { cart_id: string; state: "active" | "parked" }[] = [
    ...(activeCartId ? [{ cart_id: activeCartId, state: "active" as const }] : []),
    ...parkedCartIds.map((cart_id) => ({ cart_id, state: "parked" as const })),
  ];

  const db = getDb();
  // ON CONFLICT, not a plain INSERT: the DELETE below already cleared OUR rows,
  // so a conflict can only be another till claiming the same cart (a cloned
  // browser profile, or a cart id that physically moved machines). Last writer
  // wins is the right answer there - the freshest claim is the truthful one -
  // and it stops one till's oddity rolling back another till's whole sync.
  const upsert = db.query(`
    INSERT INTO cart_claims (cart_id, till_id, till_label, state, user_id, last_seen_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(cart_id) DO UPDATE SET
      till_id = excluded.till_id,
      till_label = excluded.till_label,
      state = excluded.state,
      user_id = excluded.user_id,
      last_seen_at = excluded.last_seen_at
  `);

  const transaction = db.transaction(() => {
    // Replace, don't diff.
    db.query("DELETE FROM cart_claims WHERE till_id = ?").run(tillId);
    for (const claim of claims) {
      upsert.run(claim.cart_id, tillId, tillLabel, claim.state, user.id);
    }
    // Housekeeping, so the table cannot grow forever. A claim whose cart holds
    // no stock describes nothing: the holds listing is its only reader, and that
    // only ever shows carts that HAVE holds. Such rows appear when a cashier
    // opens an empty till, and when a hold is released by a path that could not
    // call releaseCartClaim().
    //
    // `till_id != ?` protects the rows just written, so this till's freshly
    // reported empty active cart stays - the till is right there saying it is
    // real. Other tills' rows are reaped only once they have no holds: never on
    // age, never on silence, so a parked cart's claim survives its till being
    // switched off for a week exactly as its hold does.
    db.query(
      "DELETE FROM cart_claims WHERE till_id != ? AND cart_id NOT IN (SELECT cart_id FROM stock_reservations)"
    ).run(tillId);
  });
  transaction.immediate();

  const stored = db.query(
    "SELECT cart_id, till_id, till_label, state, user_id, last_seen_at FROM cart_claims WHERE till_id = ? ORDER BY state, cart_id"
  ).all(tillId) as any[];

  return c.json({ success: true, till_id: tillId, till_label: tillLabel, claims: stored });
});

// --- Parked bills ("held carts") ---------------------------------------------
//
// A parked bill is a CONFIRMED customer order set aside so the cashier can serve
// somebody else. Parking deliberately KEEPS the cart's stock hold — that is the
// point of it — but the order itself used to live only in the parking browser's
// localStorage (kuki_held_carts). So the hold was durable and shop-wide while
// the order that owned it was fragile and local:
//   * no other till could see, let alone resume, an order whose stock the whole
//     shop was already being denied;
//   * clearing that browser's data or swapping the tablet destroyed the
//     customer's order while its hold survived forever — stock locked until an
//     admin force-released it from the "Held stock" screen;
//   * only the browser that created a hold could ever give it back through
//     ordinary use.
// The order now lives on the server beside its hold, in parked_carts.
//
// This table does NOT replace cart_claims. A claim is an annotation a till
// asserts about itself ("I am still ringing this up"); a parked bill is a stored
// fact the server owns. An ACTIVE cart is still only knowable from the till, so
// claims keep doing that job — see POST /carts/claim.
//
// Auth: no adminOnly on ANY of these. A parked bill must be visible and
// resumable from every till — that is the whole reason it moved to the server —
// and parking, resuming and discarding an order is ordinary cashier work.
// Nothing here takes money, and the one destructive route (discard) hands stock
// BACK rather than taking it. user_id always comes from getUser(c), never the
// body.

// Cart ids and till names are short (see CLAIM_MAX_LEN); a label is a customer
// name or "Hold 10:42:03". A cart with more than 200 distinct lines is not a
// cake-shop order, it is a buggy or hostile till. These caps exist only to stop
// unbounded junk being written into the table.
const PARK_MAX_LEN = 200;
const PARK_MAX_ITEMS = 200;

// Every column the API hands back, with the cashier who parked it resolved to a
// name. Shared by the listing, the upsert's read-back and resume — so the three
// can never return different shapes for the same row.
const SELECT_PARKED = `
  SELECT p.id, p.cart_id, p.label, p.items, p.customer_id, p.customer_label, p.discount,
         p.user_id, u.full_name AS cashier_name, p.till_id, p.till_label,
         p.created_at, p.updated_at
  FROM parked_carts p
  LEFT JOIN users u ON u.id = p.user_id
`;

/**
 * Read a stored items blob back into lines.
 *
 * Returns an empty list rather than throwing if the blob is somehow unreadable:
 * the parked bill is holding stock, so the screen must still be able to SEE it
 * and an admin must still be able to discard it and get that stock back. Losing
 * the lines is bad; a 500 that hides the order and strands the hold is worse.
 * Everything written through POST /parked is validated and re-serialised below,
 * so this is a corruption guard, not a normal path.
 */
function parseParkedItems(raw: any, cartId: string): any[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    if (Array.isArray(parsed)) return parsed;
    console.error(`[pos] parked bill ${cartId} stores items that are not an array`);
  } catch (err: any) {
    console.error(`[pos] could not read the items of parked bill ${cartId}:`, err?.message || err);
  }
  return [];
}

/** A parked_carts row in the shape every parked-bill route returns. */
function shapeParked(row: any): any {
  return {
    cart_id: row.cart_id,
    label: row.label ?? "",
    items: parseParkedItems(row.items, row.cart_id),
    customer_id: row.customer_id ?? null,
    customer_label: row.customer_label ?? "",
    discount: row.discount ?? 0,
    user_id: row.user_id ?? null,
    cashier_name: row.cashier_name ?? null,
    till_id: row.till_id ?? null,
    till_label: row.till_label ?? "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Forget a cart's parked bill, because the order is not parked any more.
 *
 * Called where the cart's HOLDS are released and for the same reason: a parked
 * bill must never outlive the stock set aside for it, in either direction.
 *
 * Best-effort and never fatal at the sale call site, exactly like
 * releaseCartClaim(): the money is already committed there, and failing to tidy
 * up must not report a recorded sale as a failure.
 */
function releaseParkedCart(cartId: string | null | undefined): boolean {
  const cart = String(cartId || "").trim();
  if (!cart) return false;
  try {
    const result = getDb().query("DELETE FROM parked_carts WHERE cart_id = ?").run(cart);
    return Number(result.changes || 0) > 0;
  } catch (err: any) {
    console.error(`[pos] could not drop the parked bill for ${cart}:`, err?.message || err);
    return false;
  }
}

/** A number we are willing to store: finite, and not a string of nonsense. */
function parkedNumber(value: any): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// Every parked bill in the shop, newest first.
//
// Readable by ANY logged-in user, with no filter by till or cashier: a parked
// order must be resumable from whichever till the customer comes back to, and
// the stock it holds is denied to the whole shop, so the whole shop gets to see
// what is holding it. That is the entire point of this table.
pos.get("/parked", (c) => {
  const db = getDb();
  const rows = db.query(`${SELECT_PARKED} ORDER BY p.created_at DESC, p.id DESC`).all() as any[];
  return c.json(rows.map(shapeParked));
});

// Park a cart. Body:
// { cart_id, label, items: [{ product_id, product_name, quantity, unit_price,
//   original_price }], customer_id, customer_label, discount, till_id, till_label }
//
// UPSERT on cart_id: re-parking the same cart (the cashier adds a line and puts
// it down again) updates the one row instead of growing a second copy of one
// customer's order.
//
// Holds are NOT touched here. Parking exists precisely to keep them, and the
// till owns them through /reservations/sync; creating or re-checking stock here
// would either double-hold or, worse, refuse a park because of the cart's own
// hold and leave the cashier with an order they cannot put down.
pos.post("/parked", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Body must be a JSON object" }, 400);
  }

  const cartId = typeof body.cart_id === "string" ? body.cart_id.trim() : "";
  if (!cartId) return c.json({ error: "cart_id is required and must be a non-empty string" }, 400);
  if (cartId.length > PARK_MAX_LEN) {
    return c.json({ error: `cart_id must be at most ${PARK_MAX_LEN} characters` }, 400);
  }

  // A cart that has already become a bill is not parkable. The till rotates to a
  // fresh cart id the instant a sale completes, so this can only be a bug or a
  // stale retry — and storing it would put a ghost order in front of a cashier
  // whose only possible outcome is the duplicate-bill replay.
  const billed = findBillByCartId(cartId);
  if (billed) {
    return c.json(
      { error: `That cart has already been billed (token #${billed.token_number}), so it cannot be parked.` },
      400
    );
  }

  if (body.label != null && typeof body.label !== "string") {
    return c.json({ error: "label must be a string" }, 400);
  }
  const label = (typeof body.label === "string" ? body.label.trim() : "").slice(0, PARK_MAX_LEN);

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: "items must be a non-empty array of cart lines" }, 400);
  }
  if (body.items.length > PARK_MAX_ITEMS) {
    return c.json({ error: `items must hold at most ${PARK_MAX_ITEMS} lines` }, 400);
  }

  const db = getDb();
  const items: any[] = [];
  for (let i = 0; i < body.items.length; i++) {
    const raw = body.items[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: `items[${i}] must be an object` }, 400);
    }

    // product_id may be absent (a line that no longer points at a product), but
    // if it is sent it must be a real positive integer id.
    let productId: number | null = null;
    if (raw.product_id != null && raw.product_id !== "") {
      const pid = parkedNumber(raw.product_id);
      if (pid === null || !Number.isInteger(pid) || pid <= 0) {
        return c.json({ error: `items[${i}].product_id must be a positive integer or null` }, 400);
      }
      productId = pid;
    }

    // The name is what the cashier and the "Held stock" screen read, so a line
    // without one is useless. Filled in from the product rather than rejected
    // where that is possible: refusing a park loses the customer's order, which
    // is the harm this whole feature exists to stop.
    let productName = typeof raw.product_name === "string" ? raw.product_name.trim() : "";
    if (!productName && productId) {
      const p = db.query("SELECT name FROM products WHERE id = ?").get(productId) as any;
      productName = (p?.name || "").trim();
    }
    if (!productName) {
      return c.json({ error: `items[${i}].product_name is required` }, 400);
    }
    productName = productName.slice(0, PARK_MAX_LEN);

    const quantity = parkedNumber(raw.quantity);
    if (quantity === null || quantity <= 0) {
      return c.json({ error: `items[${i}].quantity must be a number greater than 0` }, 400);
    }
    const unitPrice = parkedNumber(raw.unit_price);
    if (unitPrice === null || unitPrice < 0) {
      return c.json({ error: `items[${i}].unit_price must be a number of 0 or more` }, 400);
    }
    const originalPrice = parkedNumber(raw.original_price);
    if (raw.original_price != null && raw.original_price !== "" && (originalPrice === null || originalPrice < 0)) {
      return c.json({ error: `items[${i}].original_price must be a number of 0 or more, or null` }, 400);
    }

    // Stored normalised, never as the caller sent it: the resume that reads this
    // back feeds a cart that takes money, so the only keys in here are the five
    // the till actually uses, with numbers that are numbers.
    items.push({
      product_id: productId,
      product_name: productName,
      quantity,
      unit_price: unitPrice,
      original_price: originalPrice ?? unitPrice,
    });
  }

  const discount = body.discount == null || body.discount === "" ? 0 : parkedNumber(body.discount);
  if (discount === null || discount < 0) {
    return c.json({ error: "discount must be a number of 0 or more" }, 400);
  }

  // A customer the row can no longer point at (deleted between parking and
  // re-parking) is stored as NULL rather than refused: customer_label keeps the
  // name on screen, and losing a link must not lose the order. A customer_id
  // that is not an id at all is still a caller bug, so that is a 400.
  let customerId: number | null = null;
  if (body.customer_id != null && body.customer_id !== "") {
    const cid = parkedNumber(body.customer_id);
    if (cid === null || !Number.isInteger(cid) || cid <= 0) {
      return c.json({ error: "customer_id must be a positive integer or null" }, 400);
    }
    const exists = db.query("SELECT id FROM customers WHERE id = ?").get(cid) as any;
    customerId = exists ? cid : null;
  }

  if (body.customer_label != null && typeof body.customer_label !== "string") {
    return c.json({ error: "customer_label must be a string" }, 400);
  }
  const customerLabel = (typeof body.customer_label === "string" ? body.customer_label.trim() : "").slice(
    0,
    PARK_MAX_LEN
  );

  // till_id / till_label are provenance ("which machine put this down"), shown
  // beside the order so a cashier knows where it came from. Optional: a till
  // that never named itself must still be able to park an order.
  if (body.till_id != null && typeof body.till_id !== "string") {
    return c.json({ error: "till_id must be a string or null" }, 400);
  }
  if (body.till_label != null && typeof body.till_label !== "string") {
    return c.json({ error: "till_label must be a string" }, 400);
  }
  const tillId = (typeof body.till_id === "string" ? body.till_id.trim() : "").slice(0, PARK_MAX_LEN) || null;
  const tillLabel =
    (typeof body.till_label === "string" ? body.till_label.trim() : "").slice(0, PARK_MAX_LEN) || tillId || "";

  // created_at is NOT in the UPDATE clause: it is when this order was first put
  // aside, and the cashier reading "parked at 10:42" must not see that jump every
  // time a line is added. updated_at carries "last re-parked".
  const upsert = db.query(`
    INSERT INTO parked_carts
      (cart_id, label, items, customer_id, customer_label, discount, user_id, till_id, till_label, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(cart_id) DO UPDATE SET
      label = excluded.label,
      items = excluded.items,
      customer_id = excluded.customer_id,
      customer_label = excluded.customer_label,
      discount = excluded.discount,
      user_id = excluded.user_id,
      till_id = excluded.till_id,
      till_label = excluded.till_label,
      updated_at = excluded.updated_at
  `);

  const stored = db.transaction(() => {
    upsert.run(
      cartId,
      label,
      JSON.stringify(items),
      customerId,
      customerLabel,
      discount,
      user.id,
      tillId,
      tillLabel
    );
    return db.query(`${SELECT_PARKED} WHERE p.cart_id = ?`).get(cartId) as any;
  }).immediate();

  return c.json({ success: true, parked: shapeParked(stored) });
});

// Resume a parked bill: hand the order back to the till that asked for it, and
// stop it being parked.
//
// RACE-SAFE BY CONSTRUCTION. The read and the delete are ONE immediate
// transaction with no await inside it, so two tills tapping Resume on the same
// customer's order at the same moment cannot both come away owning it: whoever
// gets there first takes the row, the other finds nothing and is told so. Two
// cashiers each believing they are serving one order — one of them doomed to find
// the stock gone — is the failure this endpoint must never allow.
//
// The cart's HOLDS are left exactly as they are: the resumed cart keeps the stock
// that was set aside for it, which is the continuity parking promised.
pos.post("/parked/:cartId/resume", (c) => {
  const cartId = (c.req.param("cartId") || "").trim();
  if (!cartId) return c.json({ error: "cart_id is required" }, 400);

  const db = getDb();
  const taken = db.transaction(() => {
    const row = db.query(`${SELECT_PARKED} WHERE p.cart_id = ?`).get(cartId) as any;
    if (!row) return null;
    // The DELETE's own change count is the authority on who won, not the SELECT:
    // only one transaction can remove this row, and 0 here means it was already
    // gone, so its contents must not be handed out.
    const deleted = db.query("DELETE FROM parked_carts WHERE cart_id = ?").run(cartId);
    if (Number(deleted.changes || 0) === 0) return null;
    return row;
  }).immediate();

  if (!taken) {
    return c.json({ error: "That parked bill has already been resumed or discarded." }, 404);
  }
  return c.json({ success: true, parked: shapeParked(taken) });
});

// Discard a parked bill: the customer walked away, the order is off.
//
// The row and its stock holds go in ONE transaction. Discarding an order and
// leaving its hold standing is the exact bug that started all of this — stock
// locked shop-wide behind an order that no longer exists anywhere — so it is not
// left to a second request that may never arrive.
//
// Idempotent: a cart with no parked row still has its holds released and still
// answers success, so a retry after a dropped response finishes the job instead
// of leaving stock locked.
pos.delete("/parked/:cartId", (c) => {
  const user = getUser(c)!;
  const cartId = (c.req.param("cartId") || "").trim();
  if (!cartId) return c.json({ error: "cart_id is required" }, 400);

  const db = getDb();
  const outcome = db.transaction(() => {
    const row = db.query("SELECT label, items FROM parked_carts WHERE cart_id = ?").get(cartId) as any;
    const removed = Number(db.query("DELETE FROM parked_carts WHERE cart_id = ?").run(cartId).changes || 0) > 0;
    const released = releaseCartReservations(cartId);
    // Logged because a discarded order is a real customer order being thrown
    // away, and the owner should be able to see that happen rather than discover
    // a hole later. Its own action name — nothing counts sales or stock movements
    // from it.
    if (removed) {
      const lines = parseParkedItems(row?.items, cartId);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'discarded_parked_bill', ?)").run(
        user.id,
        JSON.stringify({
          cart_id: cartId,
          label: row?.label || "",
          lines: lines.length,
          items: lines.map((i: any) => ({ product_name: i.product_name, quantity: i.quantity })),
          released,
        })
      );
    }
    return { removed, released };
  }).immediate();

  // Outside the transaction, like every other claim cleanup: a claim is only an
  // annotation, and losing one must not roll back stock going back on the shelf.
  releaseCartClaim(cartId);

  return c.json({ success: true, cart_id: cartId, released: outcome.released, removed: outcome.removed });
});

// --- Cart stock reservations ("holds") ---------------------------------------
//
// Mounted on the POS router rather than a router of their own: holds are a till
// concern, they live and die with a cart, and /api/pos/* already carries every
// other cart-shaped operation (bill, proforma, token). A separate router would
// only add a mount in src/index.ts for four handlers that share this one's
// auth and lifetime.
//
// Auth follows the house rule visible in products.ts / expenses.ts: reads are
// open to any logged-in user, writes that affect other people's data are
// adminOnly. Syncing and releasing YOUR OWN cart is ordinary cashier work, so
// no guard. Listing is read-only, so no guard — a cashier staring at a missing
// cake benefits from seeing who holds it. Releasing SOMEONE ELSE'S hold by id
// hands their stock to another till, so that one is adminOnly.

// "This cart now holds exactly these items." Full sync, not a delta.
// Body: { cart_id: string, items: [{ product_id, quantity }] }
pos.post("/reservations/sync", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json();
  const cartId = String(body.cart_id || "").trim();
  if (!cartId) return c.json({ error: "cart_id is required" }, 400);
  if (!Array.isArray(body.items)) return c.json({ error: "items must be an array" }, 400);

  try {
    const holds = syncCartReservations({
      cart_id: cartId,
      items: body.items,
      user_id: user.id,
    });
    return c.json({ success: true, cart_id: cartId, holds });
  } catch (err: any) {
    return c.json({ error: err?.message || "Could not hold stock for this cart" }, 400);
  }
});

// What this cart currently holds — handy after a reload/reconnect.
pos.get("/reservations/cart/:cartId", (c) => {
  const cartId = c.req.param("cartId");
  return c.json({ cart_id: cartId, holds: getCartHolds(cartId) });
});

// Cart cleared / sale abandoned / cart parked-and-dropped.
pos.delete("/reservations/cart/:cartId", (c) => {
  const cartId = c.req.param("cartId");
  const db = getDb();
  // The holds and any parked bill for this cart go in ONE transaction. Handing
  // a cart's stock back while leaving its parked order on the server would leave
  // an order the shop believes it owes with nothing set aside for it — the mirror
  // image of the bug parked_carts exists to fix.
  const released = db.transaction(() => {
    const n = releaseCartReservations(cartId);
    db.query("DELETE FROM parked_carts WHERE cart_id = ?").run(cartId);
    return n;
  }).immediate();
  // This cart is over, so its claim is over - nothing is left for a claim to
  // annotate. If the till keeps this cart id and holds something again, its next
  // heartbeat puts the claim straight back.
  releaseCartClaim(cartId);
  return c.json({ success: true, cart_id: cartId, released });
});

// Every live hold in the shop — the admin "Held stock" screen. There is no
// expiry by design, so this screen is the only way a hold stranded by a
// crashed tablet ever comes back.
//
// Each hold now carries a `claim`: either null (no till has ever told us about
// this cart) or { state, till_id, till_label, user_name, last_seen_at } - see
// POST /carts/claim. Still a bare array of holds with every key it had before,
// so existing callers keep working; `claim` is purely additive.
//
// Deliberately NOT a verdict. "Stranded" is not computed here and must not be
// inferred from a missing claim at this instant: a till closed for the night
// stops reporting, and its parked cart is still a real order. The facts go over
// instead - WHICH till claimed the cart, in WHAT state, and WHEN it last said
// so - and the screen decides what to show. `claim.last_seen_at` is the piece
// that separates "parked, till seen a minute ago" from "nothing has claimed
// this since Tuesday".
//
// The decoration itself lives in listHoldsWithClaims() rather than in the
// handler, because it is now read TWICE: once by this screen, and once by the
// bulk "release unreported holds" action below, which must decide what nothing
// is reporting any more from exactly the same facts this listing prints. Two
// derivations of "no till is behind this" could drift, and the screen would
// start promising to release something it is not showing as unclaimed.
function listHoldsWithClaims(): any[] {
  const holds = listActiveHolds();
  const db = getDb();

  // One query for the whole listing rather than a lookup per hold: several holds
  // routinely share a cart id (one row per product), and a shop with a handful
  // of tills has a handful of claims.
  const claims = db.query(`
    SELECT cc.cart_id, cc.till_id, cc.till_label, cc.state, cc.last_seen_at,
           u.full_name AS user_name
    FROM cart_claims cc
    LEFT JOIN users u ON u.id = cc.user_id
  `).all() as any[];

  const byCart = new Map<string, any>();
  for (const cl of claims) {
    byCart.set(cl.cart_id, {
      state: cl.state,
      till_id: cl.till_id,
      till_label: cl.till_label,
      user_name: cl.user_name ?? null,
      // UTC "YYYY-MM-DD HH:MM:SS" from datetime('now') - the same shape as the
      // created_at sitting beside it, so the frontend reads it with
      // parseDbDate() and the two ages are directly comparable. NOT a business
      // date: "how long since this till was heard from" is a wall-clock
      // question, and a 5 AM business-day rollover would make nonsense of it.
      last_seen_at: cl.last_seen_at,
      // Where this came from, so a screen never has to guess whether it is
      // reading a till's say-so or a fact the server stores.
      source: "till_claim",
    });
  }

  // parked_carts OVERRIDES a till's self-report, and stands in for a missing one.
  // A claim is an annotation a till asserts about itself; a parked bill is a
  // stored fact this server owns, so where the two disagree the row wins. This is
  // what finally makes "parked" trustworthy on the one screen that matters: a
  // till switched off for the night, or one that never claimed anything at all,
  // no longer makes a real customer's order look like a stranded hold — and the
  // order has a NAME, so the screen can say whose cake it is.
  //
  // ACTIVE carts are untouched: no parked_carts row exists for one, so only the
  // till can say it is ringing something up, exactly as before.
  const parkedRows = db.query(`
    SELECT p.cart_id, p.label, p.till_id, p.till_label, p.user_id, p.created_at, p.updated_at,
           u.full_name AS user_name
    FROM parked_carts p
    LEFT JOIN users u ON u.id = p.user_id
  `).all() as any[];

  for (const p of parkedRows) {
    const claim = byCart.get(p.cart_id);
    byCart.set(p.cart_id, {
      state: "parked",
      // The till's own values are kept where parked_carts has nothing to say, so
      // nothing the screen already prints disappears.
      till_id: p.till_id || claim?.till_id || null,
      till_label: p.till_label || claim?.till_label || "",
      user_name: p.user_name ?? claim?.user_name ?? null,
      // "When were we last told about this cart?" A live claim still answers that
      // best; otherwise it is when the order was last parked — the server's own
      // record rather than a heartbeat, which is why a till being off all night
      // no longer makes its parked order look abandoned. Same UTC
      // "YYYY-MM-DD HH:MM:SS" shape either way, so the frontend reads it with the
      // same parseDbDate().
      last_seen_at: claim?.last_seen_at || p.updated_at || p.created_at,
      // The name the cashier gave the order (the customer, or "Hold 10:42"), so
      // the "Held stock" screen can name what is holding the stock instead of
      // showing a bare cart id. `label` is an alias of `parked_label`.
      parked_label: p.label || "",
      label: p.label || "",
      parked_at: p.created_at,
      source: "parked_carts",
    });
  }

  return holds.map((h: any) => ({ ...h, claim: byCart.get(h.cart_id) ?? null }));
}

pos.get("/reservations", (c) => {
  return c.json(listHoldsWithClaims());
});

// Admin recovery: release one stranded hold.
pos.delete("/reservations/:id", adminOnly, (c) => {
  const id = parseInt(c.req.param("id") || "");
  if (!id) return c.json({ error: "Invalid hold id" }, 400);
  const user = getUser(c)!;
  const db = getDb();
  const hold = db.query(
    "SELECT r.id, r.quantity, r.cart_id, p.name AS product_name FROM stock_reservations r LEFT JOIN products p ON p.id = r.product_id WHERE r.id = ?"
  ).get(id) as any;
  if (!hold) return c.json({ error: "Hold not found" }, 404);

  db.transaction(() => {
    releaseHold(id);
    // If that was the cart's LAST hold its claim has nothing left to describe,
    // so it goes in the same transaction as the release. A cart with other holds
    // still standing keeps its claim: the owner released one cake, not the order.
    db.query(
      "DELETE FROM cart_claims WHERE cart_id = ? AND cart_id NOT IN (SELECT cart_id FROM stock_reservations)"
    ).run(hold.cart_id);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'released_stock_hold', ?)").run(
      user.id,
      JSON.stringify({ hold_id: id, product: hold.product_name, quantity: hold.quantity, cart_id: hold.cart_id })
    );
  })();

  return c.json({ success: true });
});

// --- Admin recovery: release the holds nothing is reporting any more ----------
//
// Holds are created in ONE place (the cart sync, while items are in a cart) and
// expire NEVER, by the owner's deliberate decision. Two things legitimately keep
// stock that way: a cart a till is actively ringing up, and a parked bill — a
// confirmed customer order the server itself stores in parked_carts.
//
// What leaks is the third case: a cart abandoned part-way through ringing up.
// The tablet sleeps, the tab is closed, the shift ends, the cashier moves to the
// phone. It was never parked, so it never shows up in the parked list, and
// nothing ever hands its stock back. The owner releases those one at a time,
// forever.
//
// This is that job done in one go — and deliberately still a BUTTON, not a cron:
// the owner asked to stay in control, so nothing here runs unless an admin asks
// for it, having first seen the list. There is still no TTL anywhere.
//
// The rule, in one sentence: a hold is UNREPORTED when no parked bill owns its
// cart AND no till is meaningfully reporting it. Both halves are read off the
// SAME decorated hold the "Held stock" screen shows (listHoldsWithClaims), so
// the screen and the sweep can never disagree about what is about to go.

// How long a claiming till may go quiet before its claim stops counting as a
// till reporting the cart.
//
// Tills heartbeat their claims every 5 minutes (CLAIM_HEARTBEAT_MS in pos.html
// and m-pos.html), so 60 minutes is TWELVE consecutive missed heartbeats. That
// is far past anything ordinary — flaky shop wifi, a fly.io cold start, a tablet
// asleep in a cashier's hand between two customers, a browser throttling timers
// in a background tab — and still inside the same trading session, so an
// abandoned cart's stock comes back the day it was abandoned rather than next
// week.
//
// Deliberately much more conservative than the 30-minute CLAIM_STALE_MINUTES the
// stock screens use to colour a row amber: that one only changes how loud a row
// looks, this one decides whether stock is taken off a cart. Where the two
// disagree the screen warns earlier than it sweeps, which is the right way round.
const UNREPORTED_CLAIM_MINUTES = 60;

// A cap on the id list a release may carry. A cake shop has tens of live holds,
// not thousands; this only stops a buggy or hostile caller posting an unbounded
// array.
const UNREPORTED_MAX_IDS = 2000;

type UnreportedReason = "no_claim" | "till_quiet";

/**
 * Why this hold counts as unreported — or null if something is still reporting
 * it, and it must be left alone.
 *
 * `claim` is exactly what the holds listing hands the screen, which is what
 * makes this one definition rather than a second one.
 */
function unreportedReason(claim: any, cutoff: string): UnreportedReason | null {
  // No till has ever told us about this cart, and no parked bill owns it.
  if (!claim) return "no_claim";

  // A parked bill owns it. NEVER released by this action, at ANY age: it is a
  // real customer order the server itself records, not a till's say-so, and the
  // listing already lets parked_carts override a till's claim. Discard the bill
  // (which hands the stock back) or release the row by hand instead.
  if (claim.source === "parked_carts") return null;

  // What is left is a till's self-report on a cart with no parked bill behind
  // it. It counts only while the till is still checking in. Both timestamps are
  // UTC "YYYY-MM-DD HH:MM:SS" from datetime('now'), a format that sorts
  // chronologically as text, so this compares as strings with no date parsing
  // and no timezone to get wrong.
  const seen = String(claim.last_seen_at || "");
  if (!seen) return "till_quiet";
  // A blank cutoff (impossible in practice) is read the safe way round: nothing
  // is swept on the strength of a threshold we could not compute.
  if (!cutoff) return null;
  return seen < cutoff ? "till_quiet" : null;
}

/**
 * Every live hold, plus the subset that nothing is reporting any more.
 *
 * Returns the whole decorated listing as well, so a caller can say what a hold
 * it did NOT release is claimed by now without going back to the database.
 */
function unreportedSnapshot(): { cutoff: string; all: any[]; rows: any[] } {
  const db = getDb();
  const cutoff = String(
    (db.query("SELECT datetime('now', ?) AS cutoff").get(`-${UNREPORTED_CLAIM_MINUTES} minutes`) as any)?.cutoff || ""
  );

  // One query for every hold's age rather than one per row, and computed by
  // SQLite so "how old" is measured against the same clock that wrote
  // created_at.
  const ages = new Map<number, number>();
  for (const r of db.query(
    "SELECT id, CAST(ROUND((julianday('now') - julianday(created_at)) * 1440) AS INTEGER) AS held_minutes FROM stock_reservations"
  ).all() as any[]) {
    ages.set(Number(r.id), Number(r.held_minutes || 0));
  }

  const all = listHoldsWithClaims();
  const rows: any[] = [];
  for (const h of all) {
    const reason = unreportedReason(h.claim, cutoff);
    if (!reason) continue;
    rows.push({
      ...h,
      // Why it qualified, so the screen can tell "nothing ever claimed this"
      // from "the till that claimed it went quiet an hour ago".
      reason,
      held_minutes: ages.get(Number(h.id)) ?? null,
      last_seen_at: h.claim?.last_seen_at ?? null,
      till_label: h.claim?.till_label || h.claim?.till_id || "",
    });
  }
  return { cutoff, all, rows };
}

/** The headline numbers both the preview and the release report. */
function unreportedTotals(rows: any[]) {
  return {
    count: rows.length,
    quantity: rows.reduce((sum, r) => sum + Number(r.quantity || 0), 0),
    carts: new Set(rows.map((r) => String(r.cart_id))).size,
  };
}

// The preview. Read-only: it destroys nothing, and it exists so the admin can
// SEE what the button is about to release — a bulk destructive action with
// nothing behind it but a number is not something anybody should click.
//
// adminOnly, matching the release and the per-row Release button it sits beside.
// (The plain holds listing stays open to everyone: a cashier hunting for the
// last cake benefits from seeing who holds it. This one is purely the admin
// cleanup tool's own view.)
//
// `hold_ids` is the contract with the release below: the client posts back the
// very list it was shown.
pos.get("/reservations/unreported", adminOnly, (c) => {
  const { cutoff, rows } = unreportedSnapshot();
  return c.json({
    threshold_minutes: UNREPORTED_CLAIM_MINUTES,
    cutoff,
    ...unreportedTotals(rows),
    hold_ids: rows.map((r) => r.id),
    holds: rows,
  });
});

// The release itself.
//
// Takes the exact set of hold ids the preview showed, and re-derives the
// unreported set INSIDE the same immediate transaction that deletes — so the
// write lock is held across "decide" and "delete" and nothing can be parked or
// claimed in between.
//
// The preview/confirm race is handled by refusing it, not by papering over it:
//   * a requested hold that is STILL unreported is released;
//   * a requested hold that has since become legitimate (its cart was resumed
//     and is being claimed again, or a bill was parked on it) ABORTS the whole
//     request with 409 and releases NOTHING. Releasing stock that just became a
//     real order again is the failure worth avoiding, and an admin re-reading a
//     refreshed list costs one click;
//   * a requested hold that has simply gone (its cart was sold or cleared) is
//     not an error — there is nothing left to release and nothing to protect —
//     so it is counted and skipped;
//   * a hold that became unreported AFTER the preview is left alone. It was
//     never shown, so it was never promised; the next preview will offer it.
pos.post("/reservations/release-unreported", adminOnly, async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Body must be a JSON object" }, 400);
  }
  // Required, and never inferred: "release whatever you think qualifies right
  // now" is precisely the blind bulk delete this endpoint refuses to be.
  if (!Array.isArray(body.hold_ids)) {
    return c.json({ error: "hold_ids must be an array of the hold ids the preview showed" }, 400);
  }
  if (body.hold_ids.length > UNREPORTED_MAX_IDS) {
    return c.json({ error: `hold_ids must hold at most ${UNREPORTED_MAX_IDS} ids` }, 400);
  }
  const requested: number[] = [];
  for (let i = 0; i < body.hold_ids.length; i++) {
    const id = Number(body.hold_ids[i]);
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: `hold_ids[${i}] must be a positive hold id` }, 400);
    }
    if (!requested.includes(id)) requested.push(id);
  }

  const db = getDb();
  const outcome = db.transaction(() => {
    const { cutoff, all, rows } = unreportedSnapshot();
    const unreported = new Map<number, any>(rows.map((r) => [Number(r.id), r]));
    const live = new Map<number, any>(all.map((h) => [Number(h.id), h]));

    const release: any[] = [];
    const conflicts: any[] = [];
    let alreadyGone = 0;
    for (const id of requested) {
      const row = unreported.get(id);
      if (row) {
        release.push(row);
        continue;
      }
      const hold = live.get(id);
      if (!hold) {
        // Sold, or cleared by its own till. Already back on the shelf.
        alreadyGone++;
        continue;
      }
      const claim = hold.claim;
      conflicts.push({
        hold_id: id,
        product: hold.product_name || `product #${hold.product_id}`,
        quantity: hold.quantity,
        cart_id: hold.cart_id,
        // What is standing behind it now, in the same words the screen uses.
        now: claim?.source === "parked_carts" ? "parked" : claim?.state === "active" ? "active" : "claimed",
        label: claim?.parked_label || claim?.label || "",
        till_label: claim?.till_label || claim?.till_id || "",
      });
    }

    if (conflicts.length) return { conflicts, cutoff, unreported_now: rows.length };

    for (const row of release) releaseHold(Number(row.id));

    const carts = [...new Set(release.map((r) => String(r.cart_id)))];
    for (const cart of carts) {
      // Same rule as the single-hold release: a claim describing a cart that
      // holds nothing describes nothing. A cart that still has holds standing
      // keeps its claim.
      db.query(
        "DELETE FROM cart_claims WHERE cart_id = ? AND cart_id NOT IN (SELECT cart_id FROM stock_reservations)"
      ).run(cart);
    }

    // One log row for one admin action, in the same transaction as the deletes,
    // and itemised: "released 7 holds" on its own would not let anybody work
    // out afterwards whose stock came back. Skipped when nothing was actually
    // released, so a no-op leaves no trail suggesting otherwise.
    if (release.length) {
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'released_unreported_stock_holds', ?)").run(
        user.id,
        JSON.stringify({
          released: release.length,
          carts: carts.length,
          threshold_minutes: UNREPORTED_CLAIM_MINUTES,
          already_gone: alreadyGone,
          holds: release.map((r) => ({
            hold_id: r.id,
            product: r.product_name,
            quantity: r.quantity,
            cart_id: r.cart_id,
            reason: r.reason,
            held_minutes: r.held_minutes,
          })),
        })
      );
    }

    return {
      released: release.length,
      carts: carts.length,
      already_gone: alreadyGone,
      quantity: unreportedTotals(release).quantity,
      holds: release.map((r) => ({
        hold_id: r.id,
        product: r.product_name,
        quantity: r.quantity,
        cart_id: r.cart_id,
        reason: r.reason,
      })),
    };
  }).immediate() as any;

  if (outcome?.conflicts) {
    const n = outcome.conflicts.length;
    const names = outcome.conflicts
      .slice(0, 5)
      .map((x: any) => `${x.quantity} x ${x.product}`)
      .join(", ");
    return c.json(
      {
        error:
          `${n} of those holds ${n === 1 ? "is" : "are"} being reported again since you looked ` +
          `(${names}${n > 5 ? ", and more" : ""}). Nothing was released — look at the list again.`,
        needs_refresh: true,
        conflicts: outcome.conflicts,
        unreported_now: outcome.unreported_now,
        released: 0,
      },
      409
    );
  }

  return c.json({ success: true, threshold_minutes: UNREPORTED_CLAIM_MINUTES, ...outcome });
});

export default pos;
