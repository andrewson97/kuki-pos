import { getDb } from "../db/database";
import { todayDate } from "../utils/helpers";
export function getNextTokenNumber(): number {
  const db = getDb();
  const today = todayDate();
  const result = db.query(
    "SELECT MAX(token_number) as max_token FROM bills WHERE bill_date = ?"
  ).get(today) as { max_token: number | null };
  return (result?.max_token ?? 0) + 1;
}

interface BillItem {
  product_id: number;
  product_name: string;
  quantity: number;
  unit_price: number;
  original_price?: number;
}

interface CreateBillParams {
  items: BillItem[];
  customer_id?: number | null;
  discount: number;
  tax_rate: number;
  payment_method: "cash" | "card" | "upi";
  user_id: number;
  amount_given?: number | null;
}

export function createBill(params: CreateBillParams): any {
  const db = getDb();
  const { items, customer_id, discount, tax_rate, payment_method, user_id, amount_given } = params;

  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  const taxableAmount = subtotal - discount;
  const tax_amount = taxableAmount * (tax_rate / 100);
  const total = taxableAmount + tax_amount;
  const token_number = getNextTokenNumber();
  const bill_date = todayDate();

  const changeGiven = amount_given != null ? Math.max(0, amount_given - total) : null;

  const insertBill = db.query(`
    INSERT INTO bills (token_number, bill_date, customer_id, subtotal, discount, tax_rate, tax_amount, total, payment_method, status, user_id, amount_given, change_given)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
  `);

  const insertItem = db.query(`
    INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, original_price, cost_price, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    // Aggregate stock needs across all items — a product's own count + any
    // components (composite/BoM). Same underlying product referenced multiple
    // times in the cart or across item+component sums correctly.
    const needs = new Map<number, { name: string; needed: number }>();
    const bump = (pid: number, name: string, qty: number) => {
      const cur = needs.get(pid) || { name, needed: 0 };
      cur.needed += qty;
      needs.set(pid, cur);
    };

    for (const item of items) {
      const p = db.query(
        "SELECT id, name, track_stock FROM products WHERE id = ?"
      ).get(item.product_id) as any;
      if (p?.track_stock) bump(p.id, p.name, item.quantity);

      const components = db.query(
        "SELECT component_product_id, quantity FROM product_components WHERE product_id = ?"
      ).all(item.product_id) as any[];
      for (const c of components) {
        const comp = db.query(
          "SELECT id, name, track_stock FROM products WHERE id = ?"
        ).get(c.component_product_id) as any;
        if (comp?.track_stock) bump(comp.id, comp.name, c.quantity * item.quantity);
      }
    }

    // Validate every aggregated need against current stock.
    for (const [pid, need] of needs) {
      const row = db.query("SELECT stock_quantity FROM products WHERE id = ?").get(pid) as any;
      if ((row?.stock_quantity ?? 0) < need.needed) {
        throw new Error(`${need.name} is out of stock (need ${need.needed}, have ${row?.stock_quantity ?? 0})`);
      }
    }

    const result = insertBill.run(
      token_number, bill_date, customer_id || null,
      subtotal, discount, tax_rate, tax_amount, total,
      payment_method, user_id, amount_given ?? null, changeGiven
    );
    const billId = Number(result.lastInsertRowid);

    for (const item of items) {
      const product = db.query("SELECT cost_price FROM products WHERE id = ?").get(item.product_id) as any;
      const costPrice = product?.cost_price || 0;
      const original = item.original_price ?? item.unit_price;
      insertItem.run(billId, item.product_id, item.product_name, item.quantity, item.unit_price, original, costPrice, item.quantity * item.unit_price);
    }

    // Deduct all aggregated needs in one pass.
    for (const [pid, need] of needs) {
      db.query("UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?").run(need.needed, pid);
    }

    // Log activity
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'created_bill', ?)").run(
      user_id, JSON.stringify({ bill_id: billId, token: token_number, total })
    );

    return { id: billId, token_number, total, bill_date };
  });

  return transaction();
}
