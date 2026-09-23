import { Hono } from "hono";
import { getDb } from "../db/database";
import { getUser } from "../middleware/auth";
import { createBill, getNextTokenNumber } from "../services/billing";
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

  // Enforce cash shift state. A shift is "open" when the most recent 'open'
  // record (across all dates) has no 'close' recorded after it. Shifts intentionally
  // span midnight so the cashier must explicitly close before starting fresh.
  if (settings.enforce_cash_shift === "1") {
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
      // same transaction as the stock deduction.
      cart_id: body.cart_id || null,
    });
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to create bill" }, 400);
  }

  // Generate receipt
  const db = getDb();
  const billItems = db.query("SELECT * FROM bill_items WHERE bill_id = ?").all(bill.id) as any[];
  const fullBill = db.query("SELECT * FROM bills WHERE id = ?").get(bill.id) as any;
  let customerName: string | undefined;
  if (fullBill.customer_id) {
    const cust = db.query("SELECT name FROM customers WHERE id = ?").get(fullBill.customer_id) as any;
    customerName = cust?.name;
  }

  const receiptData = {
    shopName: settings.shop_name || "My Cake Shop",
    shopAddress: settings.shop_address || "",
    shopPhone: settings.shop_phone || "",
    tokenNumber: bill.token_number,
    billDate: formatDateTime(new Date().toISOString()),
    items: billItems.map((i: any) => ({ name: i.product_name, qty: i.quantity, price: i.unit_price, total: i.total, original_price: i.original_price })),
    subtotal: fullBill.subtotal,
    discount: fullBill.discount,
    taxRate: fullBill.tax_rate,
    taxAmount: fullBill.tax_amount,
    total: fullBill.total,
    paymentMethod: fullBill.payment_method,
    cashierName: user.full_name,
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
  queuePrint(receiptText).then((r) => {
    if (!r.success) console.error(`[print] bill #${bill.id} token #${bill.token_number}: ${r.error}`);
  }).catch((err: any) => {
    console.error(`[print] bill #${bill.id} token #${bill.token_number}: ${err?.message || err}`);
  });

  // print_queued, not print_success: the write hasn't happened yet, so we can't
  // honestly report its outcome. Nothing in the UI reads it either way.
  return c.json({ ...bill, receipt_text: receiptText, kitchen_text: kitchenText, print_queued: true });
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
  const released = releaseCartReservations(cartId);
  return c.json({ success: true, cart_id: cartId, released });
});

// Every live hold in the shop — the admin "Held stock" screen. There is no
// expiry by design, so this screen is the only way a hold stranded by a
// crashed tablet ever comes back.
pos.get("/reservations", (c) => {
  return c.json(listActiveHolds());
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
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'released_stock_hold', ?)").run(
      user.id,
      JSON.stringify({ hold_id: id, product: hold.product_name, quantity: hold.quantity, cart_id: hold.cart_id })
    );
  })();

  return c.json({ success: true });
});

export default pos;
