import { Hono } from "hono";
import { getDb } from "../db/database";
import { getUser } from "../middleware/auth";
import { createBill, getNextTokenNumber } from "../services/billing";
import { getSettings, buildReceiptText, buildKitchenTicket, printReceipt } from "../services/printer";

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

  const bill = createBill({
    items: body.items,
    customer_id: body.customer_id || null,
    discount: body.discount || 0,
    tax_rate,
    payment_method: body.payment_method || "cash",
    user_id: user.id,
  });

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
    billDate: new Date().toLocaleString("en-IN"),
    items: billItems.map((i: any) => ({ name: i.product_name, qty: i.quantity, price: i.unit_price, total: i.total })),
    subtotal: fullBill.subtotal,
    discount: fullBill.discount,
    taxRate: fullBill.tax_rate,
    taxAmount: fullBill.tax_amount,
    total: fullBill.total,
    paymentMethod: fullBill.payment_method,
    cashierName: user.full_name,
    customerName,
  };

  const printResult = await printReceipt(receiptData);
  const kitchenText = buildKitchenTicket(receiptData);

  return c.json({ ...bill, receipt_text: printResult.text, kitchen_text: kitchenText, print_success: printResult.success, print_error: printResult.error });
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
    SELECT b.*, u.full_name as cashier_name, c.name as customer_name, c.phone as customer_phone
    FROM bills b
    LEFT JOIN users u ON b.user_id = u.id
    LEFT JOIN customers c ON b.customer_id = c.id
    WHERE b.id = ?
  `).get(c.req.param("id"));
  if (!bill) return c.json({ error: "Not found" }, 404);

  const items = db.query("SELECT * FROM bill_items WHERE bill_id = ?").all(c.req.param("id"));
  return c.json({ ...(bill as any), items });
});

pos.post("/bills/:id/cancel", async (c) => {
  const db = getDb();
  const user = getUser(c)!;
  const id = c.req.param("id");
  const bill = db.query("SELECT * FROM bills WHERE id = ?").get(id) as any;
  if (!bill) return c.json({ error: "Not found" }, 404);
  if (bill.status !== "completed") return c.json({ error: "Bill already " + bill.status }, 400);

  db.query("UPDATE bills SET status = 'cancelled' WHERE id = ?").run(id);
  db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cancelled_bill', ?)").run(
    user.id, JSON.stringify({ bill_id: id, token: bill.token_number })
  );
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
    billDate: new Date(bill.created_at).toLocaleString("en-IN"),
    items: items.map((i: any) => ({ name: i.product_name, qty: i.quantity, price: i.unit_price, total: i.total })),
    subtotal: bill.subtotal,
    discount: bill.discount,
    taxRate: bill.tax_rate,
    taxAmount: bill.tax_amount,
    total: bill.total,
    paymentMethod: bill.payment_method,
    cashierName: bill.cashier_name,
    customerName: bill.customer_name,
  };

  const result = await printReceipt(receiptData);
  const kitchenText = buildKitchenTicket(receiptData);
  return c.json({ ...result, kitchen_text: kitchenText });
});

export default pos;
