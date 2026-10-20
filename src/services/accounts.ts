import { getDb } from "../db/database";

// --- Cashiers' pending accounts ------------------------------------------------
//
// What a cashier owes the shop for shortages charged to them: a cash shortage
// at a close or a handover, or a stock shortage found by a stock sync, each
// charged only when an admin approved it AND chose "charge" rather than
// "write off". The admin records what is paid back (or written off later), and
// can add a charge by hand. Overages are never credited here: the owner chose
// that a later "found" cannot pay off an earlier shortage.
//
// The ledger is append-only. Nothing is edited or deleted; a charge made in
// error is put right with a write-off row that says why.

export type LedgerKind = "cash_short" | "stock_short" | "charge" | "payment" | "write_off";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Add one ledger row. Charges (cash_short, stock_short, charge) are stored as
 * positive amounts, payments and write-offs as negative — callers pass the
 * plain positive figure. Plain, not its own transaction: callers run it inside
 * theirs. Returns the row id, or null when there was nothing to charge.
 */
export function addLedgerEntry(p: {
  userId: number;
  kind: LedgerKind;
  amount: number;
  sourceType: string;
  sourceId?: number | null;
  note?: string | null;
  createdBy: number;
}): number | null {
  const amount = round2(Math.abs(p.amount));
  if (!(amount > 0)) return null;
  const signed = p.kind === "payment" || p.kind === "write_off" ? -amount : amount;
  const db = getDb();
  const id = Number(db.query(
    "INSERT INTO cashier_ledger (user_id, amount, kind, source_type, source_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(p.userId, signed, p.kind, p.sourceType, p.sourceId ?? null, p.note ?? null, p.createdBy).lastInsertRowid);
  db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'cashier_ledger', ?)").run(
    p.createdBy, JSON.stringify({ ledger_id: id, user_id: p.userId, kind: p.kind, amount: signed, source_type: p.sourceType, source_id: p.sourceId ?? null })
  );
  return id;
}

/** One user's balance: what they owe now (never shown below 0 as "credit" — see top). */
export function ledgerBalance(userId: number): number {
  const row = getDb().query("SELECT COALESCE(SUM(amount), 0) AS b FROM cashier_ledger WHERE user_id = ?").get(userId) as any;
  return round2(row?.b ?? 0);
}

/** Every user with an account, and their balance — the admin's overview. */
export function allBalances() {
  return getDb().query(`
    SELECT u.id AS user_id, u.full_name, u.username, u.role, u.is_active,
           COALESCE(SUM(l.amount), 0) AS balance, COUNT(l.id) AS entries, MAX(l.created_at) AS last_entry_at
    FROM users u LEFT JOIN cashier_ledger l ON l.user_id = u.id
    GROUP BY u.id ORDER BY balance DESC, u.full_name
  `).all().map((r: any) => ({ ...r, balance: round2(r.balance) }));
}

/** A user's ledger, newest first, with who wrote each row. */
export function ledgerEntries(userId: number, limit = 100) {
  return getDb().query(`
    SELECT l.*, c.full_name AS created_by_name FROM cashier_ledger l
    LEFT JOIN users c ON c.id = l.created_by
    WHERE l.user_id = ? ORDER BY l.id DESC LIMIT ?
  `).all(userId, Math.max(1, Math.min(500, limit)));
}

/**
 * A charge decision as an approving admin sends it:
 *   { charge: false, write_off_note: "first count after go-live" }  → written off
 *   { charge: true (or absent), charge_amount?: number }            → charged
 * A write-off needs a reason. charge_amount lets the admin correct the figure
 * (e.g. an item with no price set); otherwise the computed shortage stands.
 */
export function chargeUndecided(body: any): boolean {
  const v = body?.charge;
  return v === undefined || v === null || v === "";
}

/**
 * The refusal sent when a shortage is being settled and the admin has not
 * said whether to charge it or write it off: nothing is charged by default,
 * the till asks and sends again (public/js/closing.js withChargeDecision).
 */
export function chargeDecisionNeeded(amount: number, chargeTo: { id: number; name: string } | null) {
  return {
    error: `Short by Rs ${round2(amount).toFixed(2)}. Choose whether to charge it to ${chargeTo?.name || "the holder"} or write it off.`,
    needs_charge_decision: true,
    amount: round2(amount),
    charge_to: chargeTo,
  };
}

export function readChargeDecision(body: any, computed: number, max?: number): { charge: boolean; amount: number; note: string | null } | string {
  const charge = body?.charge !== false && body?.charge !== 0 && body?.charge !== "0";
  const note = String(body?.write_off_note ?? body?.charge_note ?? "").trim() || null;
  if (!charge) {
    if (!note) return "Say why the shortage is written off.";
    return { charge: false, amount: 0, note };
  }
  let amount = round2(computed);
  if (body?.charge_amount !== undefined && body?.charge_amount !== null && body?.charge_amount !== "") {
    const n = Number(body.charge_amount);
    if (!Number.isFinite(n) || n < 0 || n > 10_000_000) return "The amount to charge must be 0 or more.";
    // A CASH shortage is known to the cent: never more than it (max). A stock
    // shortage has no max — an item with no price is set by hand.
    if (max != null && n > max + 0.005) return `Charge at most Rs ${round2(max).toFixed(2)} — the shortage.`;
    amount = round2(n);
  }
  return { charge: true, amount, note };
}
