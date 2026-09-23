import { getDb } from "../db/database";
import { todayDate } from "../utils/helpers";
import { computeStockNeeds, heldByOtherCarts, releaseCartReservations } from "./reservations";
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
  // The till's cart id, when it has one. Optional so existing callers that
  // never held stock keep working — but without it this sale is treated as
  // "not the holder", so any hold on the goods will block it.
  cart_id?: string | null;
}

export function createBill(params: CreateBillParams): any {
  const db = getDb();
  const { items, customer_id, discount, tax_rate, payment_method, user_id, amount_given, cart_id } = params;
  const cartId = String(cart_id || "").trim();

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
    // Shared with cart reservations (src/services/reservations.ts) so a hold
    // and a deduction can never disagree about what a cake consumes.
    const needs = computeStockNeeds(items);

    // Validate every aggregated need against stock that is actually ours to
    // take: on-hand minus whatever OTHER carts are holding. With no holds in
    // play this is exactly the old check, message included.
    for (const [pid, need] of needs) {
      const row = db.query("SELECT stock_quantity FROM products WHERE id = ?").get(pid) as any;
      const available = (row?.stock_quantity ?? 0) - heldByOtherCarts(pid, cartId);
      if (available < need.needed) {
        throw new Error(`${need.name} is out of stock (need ${need.needed}, have ${Math.max(0, available)})`);
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

    // Deduct all aggregated needs in one pass. `needs` covers the products sold
    // AND the components of composite products, so stamping stock_updated_at
    // here dates every row whose stock actually moved — which is why the "ran
    // out today" date cannot be derived from bill_items alone: a component that
    // hit zero was never a line on the bill.
    for (const [pid, need] of needs) {
      db.query("UPDATE products SET stock_quantity = stock_quantity - ?, stock_updated_at = datetime('now') WHERE id = ?").run(need.needed, pid);
    }

    // The sale landed, so this cart's holds have served their purpose. Inside
    // the same transaction as the bill insert and the stock deduction, so it is
    // impossible to deduct stock and strand the hold, or to release the hold
    // without the sale committing.
    if (cartId) releaseCartReservations(cartId);

    // Log activity
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'created_bill', ?)").run(
      user_id, JSON.stringify({ bill_id: billId, token: token_number, total })
    );

    return { id: billId, token_number, total, bill_date };
  });

  // BEGIN IMMEDIATE: this transaction check-then-writes against both products
  // and stock_reservations, so it takes its write lock up front rather than
  // trying to upgrade one half-way through.
  return transaction.immediate();
}
