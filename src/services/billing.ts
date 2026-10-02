import { createHash } from "node:crypto";
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

// ---------------------------------------------------------------------------
// IDEMPOTENCY: the key is the SALE, not the cart
// ---------------------------------------------------------------------------
// The till mints a cart id per customer and rotates to a fresh one when a sale
// completes — but only when the SUCCESS RESPONSE ARRIVES. Lose that response
// (flaky wifi, a fly.io cold start, a tab closed mid-request) and the till is
// still holding the old id, so the next customer's sale is posted under it.
//
// Keying the duplicate guard on the cart id alone therefore silently swallowed
// real sales: "2 buns, Rs200" under cart X was recorded, and "7 buns, Rs700"
// under the same stale cart X a minute later was answered with the Rs200 bill
// and never written. That is money gone, with a success message on the screen.
//
// So the key is the pair (cart_id, fingerprint-of-the-sale). A resubmission of
// the SAME sale hashes identically and still replays — which is the protection
// that was added for the double-tap and the refresh-mid-request, and it must
// not regress. A DIFFERENT sale hashes differently and is billed normally, no
// matter which cart id it arrives under.
//
// WHAT THE FINGERPRINT COVERS, and why each field is in:
//   - every line, IN THE ORDER SENT: product_id, product_name, quantity,
//     unit_price, original_price. This is what was sold and for how much; it is
//     the sale. original_price is in because it is stored on bill_items and
//     printed on the slip, so two submissions that disagree about it do not
//     describe the same piece of paper. The order is NOT sorted: a resubmission
//     is the same request body and so the same order, whereas sorting would
//     merge two submissions the till never actually produces.
//   - customer_id: whose history the sale lands on, and whose name prints.
//   - discount: changes the money taken.
//   - tax_rate: changes the money taken. The RESOLVED rate is hashed (the one
//     createBill() is about to compute with), never the raw request field,
//     which may be absent and defaulted from settings.
//   - payment_method: cash, card and UPI are different records in the drawer
//     and in the cash-shift reconciliation, so they are different sales.
//   - amount_given: the cash tendered, which sets change_given and so the
//     drawer figure. An automatic resubmission re-sends the identical body,
//     tendered amount included, so including it costs the double-tap guard
//     nothing — while leaving it out would let a genuinely different tender be
//     swallowed.
//
// WHAT IS DELIBERATELY OUT:
//   - user_id. A sale is defined by what was sold, to whom, for how much and
//     how it was paid, not by who keyed it. It also could not help: a cart id
//     lives in one browser's localStorage, so a resubmission always carries the
//     same session, and the replay path deliberately attributes the bill to the
//     cashier who took the money rather than the one who retried.
//   - the request time, the token number, and everything else the server mints
//     — all of which differ between a first attempt and its retry and would
//     therefore defeat the guard entirely.
//
// KNOWN RESIDUAL, stated plainly: two consecutive sales identical in every
// field above (same items, same prices, same discount, same tax, same payment
// method, same tender, no customer) arriving under the SAME stale cart id are
// indistinguishable by content, so the second still replays the first. Closing
// that needs a key the till varies per attempt rather than per cart; content
// hashing cannot do it. It is a far narrower window than the bug it replaces,
// and the till now clears the cart and rotates its id on a replay too (see
// views/pos.html), so a stale id does not persist across further sales.
const FP_VERSION = "v1";

/** Length-prefixed, so a product name containing the separator cannot forge a
 *  field boundary (pre-order lines carry free text the customer dictated). */
function fpStr(v: unknown): string {
  const s = v == null ? "" : String(v);
  return s.length + ":" + s;
}

/** Numbers normalised to 4 decimal places so 200 and 200.00000000000003 — the
 *  same figure after a round trip through JSON and floating point — hash the
 *  same, and so do -0 and 0. Absent and non-finite values collapse to one
 *  marker rather than "NaN" / "null" / "undefined" all differing. */
function fpNum(v: unknown): string {
  if (v == null || v === "") return "-";
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return (Math.round(n * 10000) / 10000 + 0).toFixed(4);
}

export interface SaleFingerprintInput {
  items: {
    product_id?: number | null;
    product_name?: string;
    quantity: number;
    unit_price: number;
    original_price?: number | null;
  }[];
  customer_id?: number | null;
  discount: number;
  /** The RESOLVED tax rate that will actually be charged, not the raw request field. */
  tax_rate: number;
  payment_method: string;
  amount_given?: number | null;
}

/**
 * The one definition of "is this the same sale?". Stable across processes and
 * restarts (plain SHA-256 over a canonical string: no object key ordering, no
 * locale, no clock), so a retry that lands on a restarted server still replays.
 */
export function saleFingerprint(input: SaleFingerprintInput): string {
  const items = Array.isArray(input.items) ? input.items : [];
  const parts: string[] = [
    FP_VERSION,
    // customer_id is normalised the way createBill() stores it: any falsy value
    // (0, "", null, undefined) becomes "no customer", so those cannot disagree.
    fpNum(input.customer_id || null),
    fpNum(input.discount || 0),
    fpNum(input.tax_rate || 0),
    // Trimmed and lower-cased to match how the value is compared everywhere
    // else; "Cash" and "cash" are not two different sales.
    fpStr(String(input.payment_method || "").trim().toLowerCase()),
    fpNum(input.amount_given ?? null),
    "n=" + items.length,
  ];
  for (const it of items) {
    parts.push(
      fpNum(it?.product_id ?? null),
      fpStr(it?.product_name),
      fpNum(it?.quantity),
      fpNum(it?.unit_price),
      // Defaulted exactly as the INSERT below defaults it, so a line that omits
      // original_price and a line that sends it equal to unit_price — the same
      // stored row — hash the same.
      fpNum(it?.original_price ?? it?.unit_price)
    );
  }
  // \u001f is the ASCII unit separator: not typeable into a product name, and
  // the length prefixes above make it unforgeable in any case.
  return createHash("sha256").update(parts.join("\u001f"), "utf8").digest("hex");
}

// The lookups behind the whole idempotency scheme. Both read only the four
// fields a caller gets back, so the replay path and the fresh path return the
// same shape, and both are served by idx_bills_cart_sale.
const SELECT_BILL_BY_SALE =
  "SELECT id, token_number, total, bill_date FROM bills WHERE cart_id = ? AND cart_fingerprint = ?";
const SELECT_BILL_BY_CART = "SELECT id, token_number, total, bill_date FROM bills WHERE cart_id = ?";

function toCreated(row: any): CreatedBill | null {
  return row
    ? { id: row.id, token_number: row.token_number, total: row.total, bill_date: row.bill_date, replayed: true }
    : null;
}

/**
 * Has this cart already produced a bill for THIS EXACT SALE? Returns that bill
 * in the CreatedBill shape (with replayed = true), or null.
 *
 * This is the question the replay decision turns on. Note what it does NOT ask:
 * whether the cart has billed anything at all (findBillByCartId below), which
 * is true of a stale cart id carrying a brand-new sale.
 *
 * ADVISORY when called outside a transaction: a caller may use it to decide
 * whether a request is a resubmission, but it must NOT be used to decide whether
 * to write — createBill() repeats the check inside its own transaction, which is
 * the only place the answer cannot go stale.
 */
export function findBillBySale(
  cartId: string | null | undefined,
  fingerprint: string | null | undefined
): CreatedBill | null {
  const id = String(cartId || "").trim();
  const fp = String(fingerprint || "").trim();
  if (!id || !fp) return null;
  return toCreated(getDb().query(SELECT_BILL_BY_SALE).get(id, fp));
}

/**
 * Has this cart produced ANY bill, whatever was on it?
 *
 * Deliberately NOT the replay test — a stale cart id that already billed one
 * customer answers true here while the sale in hand is a different one. It
 * answers a different question, "is this cart finished with?", which is what
 * POST /api/pos/parked needs before it stores a ghost order, and what the
 * pre-order collect route reads (its cart id is the deterministic
 * 'preorder-<id>', one cart per order, so for that caller the two questions
 * coincide).
 */
export function findBillByCartId(cartId: string | null | undefined): CreatedBill | null {
  const id = String(cartId || "").trim();
  if (!id) return null;
  return toCreated(getDb().query(SELECT_BILL_BY_CART).get(id));
}

/**
 * Did this error come from the partial UNIQUE index on
 * bills(cart_id, cart_fingerprint)?
 *
 * SQLite words a violation of it as
 *   "UNIQUE constraint failed: bills.cart_id, bills.cart_fingerprint"
 * (verified against bun:sqlite with the partial index in place). The older
 * single-column form, "...: bills.cart_id", is still accepted so a database
 * where the index drop/recreate did not run is handled too. Both mention
 * cart_id, and nothing else unique in this transaction does.
 */
function isDuplicateSaleKey(err: any): boolean {
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
  // Together with the fingerprint of everything else in these params it is also
  // this sale's IDEMPOTENCY KEY: a cart id that already has a bill FOR THIS
  // SAME SALE replays that bill instead of writing a second one, while the same
  // cart id carrying a different sale is billed normally. See the gate at the
  // top of the transaction below.
  cart_id?: string | null;
}

export function createBill(params: CreateBillParams): CreatedBill {
  const db = getDb();
  const { items, customer_id, discount, tax_rate, payment_method, user_id, amount_given, cart_id } = params;
  const cartId = String(cart_id || "").trim();
  // Computed from the RESOLVED params — the tax rate the caller settled on, the
  // payment method it will store — so the hash describes the sale that is about
  // to be written, not the raw request. Only meaningful alongside a cart id, so
  // it is left empty (stored as NULL) when there is no key to pair it with.
  const fingerprint = cartId ? saleFingerprint({ items, customer_id, discount, tax_rate, payment_method, amount_given }) : "";

  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
  const taxableAmount = subtotal - discount;
  const tax_amount = taxableAmount * (tax_rate / 100);
  const total = taxableAmount + tax_amount;
  const token_number = getNextTokenNumber();
  const bill_date = todayDate();

  const changeGiven = amount_given != null ? Math.max(0, amount_given - total) : null;

  const insertBill = db.query(`
    INSERT INTO bills (token_number, bill_date, customer_id, subtotal, discount, tax_rate, tax_amount, total, payment_method, status, user_id, amount_given, change_given, cart_id, cart_fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
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
    // Keyed on the PAIR (cart_id, fingerprint), never on cart_id alone. The
    // cart id says which till conversation this is; the fingerprint says which
    // sale. Both must match, because the till only rotates its cart id on a
    // SUCCESSFUL response: a lost response leaves it on the old id and the next
    // customer's sale arrives under it. Matching on the id alone answered that
    // customer with the previous bill and wrote nothing — a real sale lost. A
    // matching cart id with a different fingerprint is a NEW sale and falls
    // straight through to the ordinary billing path below.
    if (cartId && fingerprint) {
      const existing = db.query(SELECT_BILL_BY_SALE).get(cartId, fingerprint) as any;
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
          JSON.stringify({
            bill_id: existing.id,
            token: existing.token_number,
            total: existing.total,
            cart_id: cartId,
            cart_fingerprint: fingerprint,
          })
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
      cartId || null,
      // Always written alongside a cart id, never without one: that is what
      // keeps the (cart_id, cart_fingerprint) uniqueness effective, since a row
      // with a NULL fingerprint sits outside it. NULL only for keyless bills,
      // which are not deduped at all, and for rows that predate the column.
      fingerprint || null
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
  // stock_reservations AND bills(cart_id, cart_fingerprint), so it takes its
  // write lock up front rather than trying to upgrade one half-way through.
  // That lock is what makes the duplicate-bill gate above race-safe: the check
  // and the insert are one atomic unit, so two simultaneous submissions of the
  // same sale cannot both see "no bill yet" — one writes, the other replays
  // what the first wrote.
  try {
    return transaction.immediate();
  } catch (err: any) {
    // Belt and braces. If the write lost anyway — a second process, a future
    // worker, anything the in-transaction check cannot see — the partial UNIQUE
    // index on bills(cart_id, cart_fingerprint) rejected the INSERT and rolled
    // this transaction back whole (no token, no deduction, no release). The
    // winning bill is on disk, so this is still a replay, not a failure.
    if (cartId && fingerprint && isDuplicateSaleKey(err)) {
      const existing = findBillBySale(cartId, fingerprint);
      if (existing) return existing;
    }
    throw err;
  }
}
