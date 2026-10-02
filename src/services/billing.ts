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

/**
 * What createBill() returns — identical field-for-field whether the sale was
 * just written or an existing one is being replayed, so the caller can build the
 * same response either way and only `replayed` tells them apart.
 */
export interface CreatedBill {
  id: number;
  token_number: number;
  total: number;
  bill_date: string;
  /** true when this bill already existed and is being returned again. */
  replayed: boolean;
}

// The lookup behind the whole idempotency scheme. Reads only the four fields a
// caller gets back, so the replay path and the fresh path return the same shape.
const SELECT_BILL_BY_CART = "SELECT id, token_number, total, bill_date FROM bills WHERE cart_id = ?";

/**
 * Has this cart already produced a bill? Returns that bill in the CreatedBill
 * shape (with replayed = true), or null.
 *
 * ADVISORY when called outside a transaction: a caller may use it to decide
 * whether a request is a resubmission, but it must NOT be used to decide whether
 * to write — createBill() repeats the check inside its own transaction, which is
 * the only place the answer cannot go stale.
 */
export function findBillByCartId(cartId: string | null | undefined): CreatedBill | null {
  const id = String(cartId || "").trim();
  if (!id) return null;
  const row = getDb().query(SELECT_BILL_BY_CART).get(id) as any;
  return row ? { id: row.id, token_number: row.token_number, total: row.total, bill_date: row.bill_date, replayed: true } : null;
}

/**
 * Did this error come from the partial UNIQUE index on bills(cart_id)?
 *
 * SQLite words it as "UNIQUE constraint failed: bills.cart_id" for a plain
 * index and "UNIQUE constraint failed: index 'idx_bills_cart_id'" for a partial
 * one; both mention cart_id, and nothing else unique in this transaction does.
 */
function isDuplicateCartId(err: any): boolean {
  const msg = String(err?.message || "");
  return /UNIQUE constraint failed/i.test(msg) && /cart_id/i.test(msg);
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
  //
  // It is also this sale's IDEMPOTENCY KEY: a cart id that already has a bill
  // replays that bill instead of writing a second one. See the gate at the top
  // of the transaction below.
  cart_id?: string | null;
}

export function createBill(params: CreateBillParams): CreatedBill {
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
    INSERT INTO bills (token_number, bill_date, customer_id, subtotal, discount, tax_rate, tax_amount, total, payment_method, status, user_id, amount_given, change_given, cart_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)
  `);

  const insertItem = db.query(`
    INSERT INTO bill_items (bill_id, product_id, product_name, quantity, unit_price, original_price, cost_price, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((): CreatedBill => {
    // --- Duplicate-bill gate (idempotency) ----------------------------------
    // FIRST thing in the transaction, before the stock check, before the insert,
    // before anything is deducted or released. A resubmission of a sale that is
    // already recorded must be a pure read: it must not fail the stock check
    // (the goods it is asking for were consumed by its own first attempt), must
    // not burn a token, must not deduct again — and must not error, because an
    // error reads to the cashier as "the sale failed", and they ring it up a
    // third time. So: return the bill that already exists.
    //
    // Keyed on cart_id, NOT on cart contents: two customers each buying one
    // cupcake seconds apart is ordinary trade at this counter, and refusing the
    // second one would be a worse bug than the one this guards against.
    if (cartId) {
      const existing = db.query(SELECT_BILL_BY_CART).get(cartId) as any;
      if (existing) {
        // Defensive, and cheap: this cart is sold, so any hold standing against
        // it is meaningless. Normally the first attempt already released them —
        // but a hold sync that was still in flight when that sale committed can
        // land just after it and strand stock under a cart nobody can see again.
        releaseCartReservations(cartId);
        // Logged under its own action, never 'created_bill': this is not a sale,
        // and anything counting sales from the log (or the stock history, which
        // whitelists action names) must not see one. It is recorded at all so the
        // owner can see duplicate submissions happening instead of guessing.
        db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'duplicate_bill_replayed', ?)").run(
          user_id,
          JSON.stringify({ bill_id: existing.id, token: existing.token_number, total: existing.total, cart_id: cartId })
        );
        return {
          id: existing.id,
          token_number: existing.token_number,
          total: existing.total,
          bill_date: existing.bill_date,
          replayed: true,
        };
      }
    }

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
      payment_method, user_id, amount_given ?? null, changeGiven,
      // Empty string would make every keyless till collide with every other one
      // under the UNIQUE index, so "no cart id" is stored as NULL — which the
      // index excludes, and NULLs never collide.
      cartId || null
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

    return { id: billId, token_number, total, bill_date, replayed: false };
  });

  // BEGIN IMMEDIATE: this transaction check-then-writes against products,
  // stock_reservations AND bills.cart_id, so it takes its write lock up front
  // rather than trying to upgrade one half-way through. That lock is what makes
  // the duplicate-bill gate above race-safe: the check and the insert are one
  // atomic unit, so two simultaneous submissions of the same cart_id cannot both
  // see "no bill yet" — one writes, the other replays what the first wrote.
  try {
    return transaction.immediate();
  } catch (err: any) {
    // Belt and braces. If the write lost anyway — a second process, a future
    // worker, anything the in-transaction check cannot see — the partial UNIQUE
    // index on bills(cart_id) rejected the INSERT and rolled this transaction
    // back whole (no token, no deduction, no release). The winning bill is on
    // disk, so this is still a replay, not a failure.
    if (cartId && isDuplicateCartId(err)) {
      const existing = findBillByCartId(cartId);
      if (existing) return existing;
    }
    throw err;
  }
}
