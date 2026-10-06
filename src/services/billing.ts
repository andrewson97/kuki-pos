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
// hashing cannot do it.
//
// Two things since cut it down to a sliver:
//   1. THE MATCH IS TIME-BOUNDED. Only a bill from the last few minutes can be
//      replayed at all — see REPLAY_WINDOW_MINUTES below. The identical basket
//      an hour later, or two days later, is a repeat order and gets its own
//      bill. That is what the Oct 4 / Oct 6 incident needed and did not have.
//   2. THE TILL ROTATES ITS CART ID WHEN A SALE BEGINS, not only when one ends
//      (see addToCart()/beginSaleIfCartEmpty() in views/pos.html and
//      views/m-pos.html). A lost response can no longer leave a stale id in
//      place for the NEXT customer, because the next customer's first item
//      mints a fresh one. For the residual above to bite, a sale would now
//      have to be byte-identical AND under ten minutes old AND under a cart id
//      that survived the rotation — which, with an empty cart holding no
//      stock, it does not.
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

// ---------------------------------------------------------------------------
// HOW LONG A SALE STAYS REPLAYABLE
// ---------------------------------------------------------------------------
// A replay is a RETRY: the same request body arriving a second time because the
// first answer never got back to the till. That happens in seconds — an
// auto-retry, a double tap, a reload mid-request — and at the very outside in a
// minute or two, when a cashier watches a fly.io cold start time out and rings
// the identical basket up again by hand.
//
// It is NOT what happens two days later. On Oct 4 a checkout response was lost,
// so the till kept its cart id (it only rotated on success). On Oct 6 the same
// two cakes hashed to the same fingerprint under that same stale id, matched the
// Oct 4 bill, and the real sale was answered with "already recorded as Token
// #014" and never written. Money gone, with a success message on the screen.
// An unbounded lookup cannot tell a retry from a repeat order, because after
// enough time there is no such thing as a retry.
//
// So the question the replay gate asks is "did THIS SALE go through JUST NOW?",
// and the window is the honest answer to "just now".
//
// Why ten minutes:
//   * Far above every real retry. A cold start plus the client's own timeout
//     plus a cashier noticing and pressing Pay again is tens of seconds; re-
//     ringing the same basket by hand is a minute or two. Ten minutes is an
//     order of magnitude of headroom, which matters because the asymmetry runs
//     one way: a missed replay DOUBLE-CHARGES a customer and double-deducts
//     stock, while a missed match merely writes the second bill that the sale
//     deserved.
//   * Far below every real repeat order. A cake shop sells the same basket all
//     day; "two fish buns, cash, exact change" recurs within the hour. Ten
//     minutes keeps the content-only collision (see KNOWN RESIDUAL above) down
//     to a window in which a till would have to be sitting on a stale cart id
//     AND take a byte-identical sale — and the till now rotates its id the
//     moment an empty cart takes its first item, so it is not sitting on one.
//   * It is measured in ABSOLUTE TIME, not in business days. created_at is UTC
//     `datetime('now')` and the bound below is UTC `datetime('now', '-N
//     minutes')`, so the shop's 5 AM business-day rollover (todayDate(), which
//     bills_date uses) never enters into it. Widening this to "the whole
//     business day" would be the Oct 4 bug with a shorter fuse: it would still
//     swallow the 11 AM repeat of the 9 AM order, and across the 5 AM rollover
//     a 4:55 AM sale and a 5:05 AM one would fall in different days while being
//     ten minutes apart. Absolute minutes have neither problem.
const REPLAY_WINDOW_MINUTES = 10;

// Guard the interpolation below: this value is inlined into SQL, so it must be
// a plain positive integer and nothing else, ever.
if (!Number.isInteger(REPLAY_WINDOW_MINUTES) || REPLAY_WINDOW_MINUTES <= 0) {
  throw new Error("REPLAY_WINDOW_MINUTES must be a positive whole number of minutes");
}

/** The SQL bound, as a readable string, for logs and for the index comment. */
export const REPLAY_WINDOW_DESCRIPTION = `${REPLAY_WINDOW_MINUTES} minutes`;

// The lookups behind the whole idempotency scheme. Both read only the four
// fields a caller gets back, so the replay path and the fresh path return the
// same shape, and both are served by idx_bills_cart_sale_window.
//
// ORDER BY created_at DESC, id DESC on both: the same (cart_id, fingerprint)
// pair can now legitimately appear more than once — that is the whole point of
// the window — so "the bill for this sale" has to mean the LATEST one. Without
// it SQLite's choice would be arbitrary, and a retry of today's sale could be
// answered with a two-day-old token. id DESC breaks a same-second tie.
const SELECT_BILL_BY_SALE =
  "SELECT id, token_number, total, bill_date FROM bills" +
  " WHERE cart_id = ? AND cart_fingerprint = ?" +
  //  >= so a row written in this very second always matches, and a row with a
  //  clock-skewed future timestamp still replays rather than being billed twice.
  `   AND created_at >= datetime('now', '-${REPLAY_WINDOW_MINUTES} minutes')` +
  " ORDER BY created_at DESC, id DESC LIMIT 1";
// DELIBERATELY NOT time-bounded. This one answers "is this cart finished with?",
// and that is a fact with no expiry date: a cart that was billed last week must
// never be parked again, and a pre-order's 'preorder-<id>' cart must never be
// collectable a second time however long the customer takes to come back. Only
// the RETRY question (above) has a shelf life.
const SELECT_BILL_BY_CART =
  "SELECT id, token_number, total, bill_date FROM bills WHERE cart_id = ?" +
  " ORDER BY created_at DESC, id DESC LIMIT 1";

function toCreated(row: any): CreatedBill | null {
  return row
    ? { id: row.id, token_number: row.token_number, total: row.total, bill_date: row.bill_date, replayed: true }
    : null;
}

/**
 * Has this cart already produced a bill for THIS EXACT SALE, JUST NOW? Returns
 * that bill in the CreatedBill shape (with replayed = true), or null.
 *
 * This is the question the replay decision turns on. Note what it does NOT ask:
 *   * whether the cart has billed anything at all (findBillByCartId below),
 *     which is true of a stale cart id carrying a brand-new sale;
 *   * whether it EVER billed this sale. Only the last REPLAY_WINDOW_MINUTES
 *     count — see the note on that constant. Past the window the identical
 *     basket under the identical cart id is a genuine repeat order and gets a
 *     bill of its own.
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
 *
 * And deliberately NOT time-bounded, unlike findBillBySale: "finished with" is
 * permanent. A cart billed last month is still not parkable, and a pre-order
 * collected last month is still collected. Putting the replay window on this
 * one would let a double Collect past the only check that is not a status
 * check, which is precisely what must not happen to a customer's deposit.
 */
export function findBillByCartId(cartId: string | null | undefined): CreatedBill | null {
  const id = String(cartId || "").trim();
  if (!id) return null;
  return toCreated(getDb().query(SELECT_BILL_BY_CART).get(id));
}

// ---------------------------------------------------------------------------
// THE INDEX BEHIND THE WINDOW
// ---------------------------------------------------------------------------
// The guard used to be a partial UNIQUE index on bills(cart_id,
// cart_fingerprint). That is now WRONG BY CONSTRUCTION: outside the replay
// window the same cart id carrying the same basket is a genuine repeat order
// and MUST get a second bill, and that second row would violate it — the
// cashier would be told "UNIQUE constraint failed" and still could not bill.
//
// So the key gains created_at:
//     UNIQUE (cart_id, cart_fingerprint, created_at) WHERE cart_id IS NOT NULL
// which is exactly as strong as it can be while still permitting what the
// window permits:
//   * two bills for the same basket under the same cart id are allowed — they
//     differ in created_at, and they can only exist at all if they are more
//     than REPLAY_WINDOW_MINUTES apart, because anything closer is caught by
//     the in-transaction gate before it reaches the INSERT;
//   * two bills for the same basket, same cart id, IN THE SAME SECOND are
//     still refused. That is the only case the gate cannot see — a second
//     process racing this one — and it is also the only shape a genuine
//     duplicate can take, since a legitimate repeat is minutes away by
//     definition. The catch below turns that refusal back into a replay.
// It can never reject a legitimate write: to collide, two bills would have to
// be both >= 10 minutes apart (to exist) and in the same second (to collide).
//
// It is also still the index the two lookups above read: (cart_id) and
// (cart_id, cart_fingerprint) are prefixes of it, and the trailing created_at
// serves the window's range test and the ORDER BY in the same seek.
//
// A STRAIGHT SWAP, NOT A TABLE REBUILD. production is a fly.io volume holding
// real sales; nothing here touches a row.
const REPLAY_INDEX = "idx_bills_cart_sale_window";
const REPLAY_INDEX_COLUMNS = "bills(cart_id, cart_fingerprint, created_at) WHERE cart_id IS NOT NULL";
/** The index this one replaces. See runMigrations(), which still creates it. */
const SUPERSEDED_INDEX = "idx_bills_cart_sale";

/**
 * Put the windowed uniqueness guard in place, replacing the pair-unique one.
 *
 * MUST be called AFTER runMigrations(), and on EVERY boot: migrations still
 * creates idx_bills_cart_sale with IF NOT EXISTS, so a swap done once would be
 * undone by the next start and billing would break again the moment a genuine
 * repeat order came through. Running it every boot is cheap (two DDL statements
 * against one index) and idempotent.
 *
 * Both statements go in one transaction, so there is never a moment on disk
 * with no guard at all — and the new one is created BEFORE the old one is
 * dropped, so a failure leaves the database exactly as it was found.
 */
export function ensureBillReplayIndex(): void {
  const db = getDb();
  try {
    db.transaction(() => {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${REPLAY_INDEX} ON ${REPLAY_INDEX_COLUMNS}`);
      db.exec(`DROP INDEX IF EXISTS ${SUPERSEDED_INDEX}`);
    })();
    return;
  } catch (err: any) {
    // Only reachable on a database that already holds two bills with the same
    // (cart_id, cart_fingerprint, created_at) — i.e. one where the pair-unique
    // index was never successfully created either. Billing must not be dead on
    // startup over a belt-and-braces guarantee, and it must certainly not be
    // left with the OLD index, which would refuse every genuine repeat order.
    // Fall back to the same index without UNIQUE: the lookups and the window
    // still have their index, and the in-transaction gate under BEGIN IMMEDIATE
    // is the protection that actually runs in this single-process deployment.
    console.error(
      `[billing] could not create UNIQUE ${REPLAY_INDEX} — falling back to a non-unique index; ` +
        `duplicate-bill protection rests on the in-transaction check alone:`,
      err?.message || err
    );
  }
  try {
    db.transaction(() => {
      db.exec(`CREATE INDEX IF NOT EXISTS ${REPLAY_INDEX} ON ${REPLAY_INDEX_COLUMNS}`);
      db.exec(`DROP INDEX IF EXISTS ${SUPERSEDED_INDEX}`);
    })();
  } catch (err: any) {
    console.error(
      `[billing] could not create ${REPLAY_INDEX} at all. If ${SUPERSEDED_INDEX} is still in place, ` +
        `a genuine repeat order under a reused cart id will be REFUSED at the till:`,
      err?.message || err
    );
  }
}

/**
 * Did this error come from the partial UNIQUE index on
 * bills(cart_id, cart_fingerprint, created_at)?
 *
 * SQLite words a violation of it as
 *   "UNIQUE constraint failed: bills.cart_id, bills.cart_fingerprint, bills.created_at"
 * (verified against bun:sqlite with the partial index in place). The two older
 * forms — "...: bills.cart_id, bills.cart_fingerprint" and the single-column
 * "...: bills.cart_id" — are still accepted so a database where the index swap
 * did not run is handled too. All three mention cart_id, and nothing else
 * unique in this transaction does.
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
  // Bill WITHOUT checking or deducting stock. Only for a pre-order collection
  // (src/routes/preorders.ts): the owner never enters pre-ordered goods as
  // stock — they are baked or bought in for that customer — so even a
  // catalogue line whose product has track_stock = 1 must neither be refused
  // for "out of stock" nor push the shelf count negative. Holds are still
  // released and everything else (token, lines, cost price, log) is unchanged.
  // Not part of the fingerprint: it changes what happens to the shelf, not
  // which sale this is.
  skip_stock?: boolean;
}

// CALLING THIS INSIDE YOUR OWN TRANSACTION is supported, and is what the
// pre-order collect route does so that "bill written" and "order marked
// collected" commit together or not at all. bun:sqlite turns a transaction
// started while one is already open into a SAVEPOINT — including the
// .immediate() variant below, whose BEGIN IMMEDIATE is simply not issued when
// nested (verified against bun 1.3: an inner throw rolls back only the inner
// savepoint, an inner success is committed or rolled back with the outer
// transaction). So the caller must open its outer transaction with
// .immediate() itself; that is what then holds the write lock across both.
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
    // Keyed on the TRIPLE (cart_id, fingerprint, recency), never on cart_id
    // alone. The cart id says which till conversation this is; the fingerprint
    // says which sale; the window (SELECT_BILL_BY_SALE, bounded by
    // REPLAY_WINDOW_MINUTES) says it was JUST NOW and is therefore a retry.
    //
    // All three must match:
    //   * the id alone is not enough, because a lost response leaves the till
    //     on the old id and the next customer's sale arrives under it. Matching
    //     on the id alone answered that customer with the previous bill and
    //     wrote nothing — a real sale lost.
    //   * id + fingerprint is not enough either, because a cake shop sells the
    //     same basket twice. Days later, under an id that was never rotated, an
    //     untimed match answered a live customer with an old receipt and again
    //     wrote nothing. That is the Oct 4 / Oct 6 failure.
    // A matching cart id with a different fingerprint, or a match too old to be
    // a retry, is a NEW sale and falls straight through to the ordinary billing
    // path below.
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
    // skip_stock: no needs at all, so neither the check nor the deduction below
    // runs. See the option's note on CreateBillParams.
    const needs: ReturnType<typeof computeStockNeeds> = params.skip_stock ? new Map() : computeStockNeeds(items);

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
  // stock_reservations AND bills(cart_id, cart_fingerprint, created_at), so it takes its
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
    // index on bills(cart_id, cart_fingerprint, created_at) rejected the INSERT
    // and rolled this transaction back whole (no token, no deduction, no
    // release). The winning bill is on disk, written in the same second (that
    // is the only way the triple can collide), so it is inside the replay
    // window by construction and findBillBySale() will see it: this is still a
    // replay, not a failure.
    if (cartId && fingerprint && isDuplicateSaleKey(err)) {
      const existing = findBillBySale(cartId, fingerprint);
      if (existing) return existing;
    }
    throw err;
  }
}
