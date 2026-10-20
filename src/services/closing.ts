import { createHmac, randomBytes } from "node:crypto";
import { getDb } from "../db/database";
import type { SessionUser } from "../middleware/auth";

// --- Closing the drawer: stock sync and admin approval ------------------------
//
// Before a cash drawer may close, the shift's stock has to be SYNCED: whoever
// is closing counts everything the system says is in stock (anything above 0 —
// there is no point walking the shelves for what is already at zero) and types
// the figures in. The count is BLIND: the screen never shows the system figure
// while counting, or the count would just copy it.
//
//   * Every figure agrees: the sync is 'matched' and settles at once.
//   * Something differs: an admin must approve before the stock changes. The
//     admin may correct a figure before approving. Rejecting sends it back for
//     a recount. An admin's own count needs no approval.
//   * A sync is only good while nothing moves stock after it settled: a sale of
//     a tracked product, a box opened, a delivery. Then it is synced again, so
//     the count the drawer closes on is the end-of-shift count.
//
// Approving applies the DIFFERENCE the count found (counted − what the system
// said at the time) to the stock as it is now, never below zero. A sale made
// while the request waited for the admin is therefore not undone.
//
// Every stock change goes where Stock History already reads it: a product as a
// 'counted_product_stock' log row (an anchor there, with the resulting figure
// as `counted`), an ingredient as a stock_transactions 'adjustment'.

const QTY_EPS = 1e-9;
const roundQty = (x: number) => Math.round(x * 1e6) / 1e6;

export class ClosingError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409 = 400, public extra: Record<string, any> = {}) {
    super(message);
  }
}

export interface Approver { id: number; full_name: string; at_till: boolean }

/** Admin-password checks still running, per cashier: see resolveApprover(). */
const approvalsInFlight = new Map<number, number>();
const DUMMY_HASH = Bun.password.hashSync("not-a-real-password", { algorithm: "bcrypt", cost: 10 });

/**
 * Who is approving this request, if anyone. The logged-in user when they are an
 * admin; otherwise an admin who typed their username and password at this till
 * (admin_username / admin_password in the body); otherwise null. Wrong or
 * non-admin credentials are refused outright rather than treated as "no
 * approver", so the cashier is told the password was wrong.
 */
export async function resolveApprover(user: SessionUser, body: any): Promise<Approver | null> {
  if (user.role === "admin") return { id: user.id, full_name: user.full_name, at_till: false };
  const username = String(body?.admin_username ?? "").trim();
  const password = String(body?.admin_password ?? "");
  if (!username && !password) return null;
  // A till is not a login page: a cashier's session must not be able to guess
  // the owner's password without end. Five wrong tries from one user in 15
  // minutes and it stops checking for a while (each failure is logged below).
  // Tries still being checked count too, and are counted BEFORE the await:
  // otherwise a burst of parallel guesses all read "0 failures so far" and
  // every one of them gets checked against the real password.
  const recent = getDb().query(
    "SELECT COUNT(*) AS n FROM activity_log WHERE user_id = ? AND action = 'admin_approval_failed' AND created_at >= datetime('now', '-15 minutes')"
  ).get(user.id) as any;
  const checking = approvalsInFlight.get(user.id) ?? 0;
  if ((recent?.n ?? 0) + checking >= 5) {
    throw new ClosingError("Too many wrong admin passwords from this login. Wait 15 minutes, or have the admin approve from their own login.", 400);
  }
  approvalsInFlight.set(user.id, checking + 1);
  let row: any;
  let ok = false;
  try {
    row = getDb().query(
      "SELECT id, full_name, role, is_active, password_hash FROM users WHERE username = ?"
    ).get(username) as any;
    // Hashed against a dummy when the user does not exist, so how long the
    // answer takes does not say which admin usernames are real.
    const hash = row?.password_hash || DUMMY_HASH;
    ok = (await Bun.password.verify(password, hash)) && !!row && !!row.is_active && row.role === "admin";
  } finally {
    const left = (approvalsInFlight.get(user.id) ?? 1) - 1;
    if (left > 0) approvalsInFlight.set(user.id, left); else approvalsInFlight.delete(user.id);
  }
  if (!ok) {
    getDb().query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'admin_approval_failed', ?)").run(
      user.id, JSON.stringify({ admin_username: username })
    );
    // 400, never 401: the tills treat any 401 as "your session ended" and send
    // the cashier to the login page, which a mistyped admin password must not do.
    throw new ClosingError("That admin username or password is wrong.", 400);
  }
  return { id: row.id, full_name: row.full_name, at_till: true };
}

export interface SyncItem { kind: "product" | "ingredient"; id: number; name: string; unit: string; category: string; system_qty: number }

// A sale (or delivery) between loading the count list and submitting it would
// otherwise read as a mismatch: 5 cakes counted, 1 sold before Submit, system
// now 4 — "1 found", and approving it puts a cake on the books that is not on
// the shelf. So every listed item carries a token of the figure it was listed
// at, and the submit refuses the items whose figure has moved since, asking
// for just those to be counted again.
//
// The token is an HMAC of the figure under a secret: the till can hand it
// back but cannot read the figure out of it (a plain hash of a small whole
// number would be guessed in a moment), so the count stays blind.
//
// The secret is made ONCE and kept in settings, not made at boot. The machine
// sleeps when idle and a deploy restarts it; a cashier counting fifty items on
// a page that sends nothing can come back to a fresh process. A boot-time
// secret turned every token "changed" and wiped the whole count.
let tokenSecret: string | null = null;
function getTokenSecret(): string {
  if (tokenSecret) return tokenSecret;
  const db = getDb();
  db.query("INSERT OR IGNORE INTO settings (key, value) VALUES ('stock_sync_token_secret', ?)").run(randomBytes(32).toString("hex"));
  tokenSecret = (db.query("SELECT value FROM settings WHERE key = 'stock_sync_token_secret'").get() as any).value as string;
  return tokenSecret;
}
export function itemToken(kind: string, id: number, qty: number): string {
  return createHmac("sha256", getTokenSecret()).update(`${kind}:${id}:${roundQty(qty)}`).digest("hex").slice(0, 20);
}

// Counts are of things on a shelf: whole pieces for products, and nothing
// absurd for anything (1e308 would round to Infinity and poison the stock).
const MAX_COUNT = 1_000_000;

/**
 * What has to be counted: tracked finished products and store-room items
 * (ingredients, packing) the system says are above 0. Opened boxes are not
 * counted — only what is still sealed, which is stock_items.quantity.
 * Discontinued products are left out (they are off the menu for good), but
 * inactive ones stay in: off the menu today is still on the shelf.
 *
 * Only what the admin ticked for the daily sync (products.daily_sync /
 * stock_items.daily_sync, set on the Stock page). Unticking or ticking an item
 * changes this list, and so the snapshot a settled sync is checked against —
 * a sync settled before the change asks to be done again, which is right: it
 * no longer counted the list the shop now closes on.
 */
export function listSyncItems(): SyncItem[] {
  const db = getDb();
  const products = db.query(`
    SELECT id, name, category, stock_quantity AS qty FROM products
    WHERE track_stock = 1 AND is_discontinued = 0 AND daily_sync = 1 AND stock_quantity > ${QTY_EPS}
    ORDER BY category, name
  `).all() as any[];
  const items = db.query(`
    SELECT si.id, si.name, si.unit, si.quantity AS qty, COALESCE(sc.name, 'Uncategorised') AS category
    FROM stock_items si LEFT JOIN stock_categories sc ON sc.id = si.category_id
    WHERE si.daily_sync = 1 AND si.quantity > ${QTY_EPS}
    ORDER BY sc.name, si.name
  `).all() as any[];
  return [
    ...products.map((p) => ({ kind: "product" as const, id: p.id, name: p.name, unit: "pcs", category: p.category || "General", system_qty: roundQty(p.qty) })),
    ...items.map((i) => ({ kind: "ingredient" as const, id: i.id, name: i.name, unit: i.unit || "", category: i.category, system_qty: roundQty(i.qty) })),
  ];
}

/**
 * What a settled sync remembers: the figure of every item it COUNTED (its
 * lines), as the stock stands at settlement, keyed "product:12" /
 * "ingredient:3". Not "everything listed now": an item ticked, or delivered,
 * while a count waited for the admin was never counted, and must not slip into
 * the snapshot as though it had been.
 */
function countedSnapshot(syncId: number): Record<string, number> {
  const snap: Record<string, number> = {};
  const lines = getDb().query("SELECT item_kind, item_id FROM stock_sync_lines WHERE sync_id = ?").all(syncId) as any[];
  for (const l of lines) {
    const q = currentSystemQty(l.item_kind, l.item_id);
    if (q != null) snap[`${l.item_kind}:${l.item_id}`] = q;
  }
  return snap;
}

/** Is this item still one the sync counts (ticked, and a tracked current product)? Its figure aside. */
function stillCounted(kind: string, id: number): boolean {
  const db = getDb();
  return kind === "product"
    ? !!db.query("SELECT 1 FROM products WHERE id = ? AND track_stock = 1 AND is_discontinued = 0 AND daily_sync = 1").get(id)
    : !!db.query("SELECT 1 FROM stock_items WHERE id = ? AND daily_sync = 1").get(id);
}

/**
 * Why a settled sync no longer holds, or null if it does. Exact, not by time:
 *   'moved'   — something it counted has changed since (a sale, a delivery,
 *               an opened box), including selling down to 0. An item the
 *               admin has since UNTICKED is no longer the shop's business at
 *               closing, so it is not looked at: unticking forces no recount.
 *   'listed'  — something is on the count list now that this sync never
 *               counted: newly ticked, or come into stock from 0.
 * A movement that nets to nothing (one sold, one baked) leaves the count true.
 */
function staleReason(snap: Record<string, number>): "moved" | "listed" | null {
  for (const [key, qty] of Object.entries(snap)) {
    const [kind = "", idStr = ""] = key.split(":");
    const id = Number(idStr);
    if (!stillCounted(kind, id)) continue;
    const now = currentSystemQty(kind, id);
    if (now == null) continue; // deleted: nothing left to count
    if (Math.abs(now - qty) > QTY_EPS) return "moved";
  }
  for (const i of listSyncItems()) if (!(`${i.kind}:${i.id}` in snap)) return "listed";
  return null;
}

function currentSystemQty(kind: string, id: number): number | null {
  const db = getDb();
  const row = kind === "product"
    ? db.query("SELECT stock_quantity AS q FROM products WHERE id = ?").get(id) as any
    : db.query("SELECT quantity AS q FROM stock_items WHERE id = ?").get(id) as any;
  return row ? roundQty(Number(row.q) || 0) : null;
}

function syncWithLines(id: number) {
  const db = getDb();
  const sync = db.query(`
    SELECT s.*, u.full_name AS user_name, d.full_name AS decided_by_name
    FROM stock_syncs s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN users d ON d.id = s.decided_by
    WHERE s.id = ?
  `).get(id) as any;
  if (!sync) return null;
  delete sync.settled_snapshot; // internal to stockSyncState(); never sent to a till
  sync.lines = db.query("SELECT * FROM stock_sync_lines WHERE sync_id = ? ORDER BY id").all(id);
  return sync;
}

/**
 * Where the shift's stock sync stands: the latest sync for this shift (not a
 * superseded one), and whether it is good to close on. `valid` is the one
 * thing POST /api/cash/close checks.
 */
export function stockSyncState(shiftOpenId: number) {
  const db = getDb();
  const latest = db.query(
    "SELECT id FROM stock_syncs WHERE shift_open_id = ? AND status != 'superseded' ORDER BY id DESC LIMIT 1"
  ).get(shiftOpenId) as any;
  const sync = latest ? syncWithLines(latest.id) : null;
  const settled = !!sync && (sync.status === "matched" || sync.status === "approved");
  let reason: "moved" | "listed" | null = null;
  if (settled) {
    const raw = (db.query("SELECT settled_snapshot FROM stock_syncs WHERE id = ?").get(sync.id) as any)?.settled_snapshot;
    let snap: Record<string, number> | null = null;
    try { snap = JSON.parse(raw || "null"); } catch {}
    reason = snap ? staleReason(snap) : "moved";
  }
  const stale = !!reason;
  return {
    sync,
    valid: settled && !stale,
    // Settled, but no longer holds: the cashier is told why a fresh count is needed.
    stale,
    stale_reason: reason,
  };
}

/**
 * Write the approved figures into stock, as differences against what the
 * system said when it was counted. Inside the caller's transaction.
 */
function applySync(syncId: number, approver: { id: number; full_name: string }, corrections: Map<number, number>) {
  const db = getDb();
  const lines = db.query("SELECT * FROM stock_sync_lines WHERE sync_id = ?").all(syncId) as any[];
  for (const l of lines) {
    const approved = corrections.has(l.id) ? corrections.get(l.id)! : Number(l.counted_qty);
    const delta = roundQty(approved - Number(l.system_qty));
    db.query("UPDATE stock_sync_lines SET approved_qty = ? WHERE id = ?").run(approved, l.id);
    if (Math.abs(delta) <= QTY_EPS) {
      db.query("UPDATE stock_sync_lines SET applied_delta = 0 WHERE id = ?").run(l.id);
      continue;
    }
    // Deleted since the count, or a product no longer tracked / discontinued:
    // there is no count of it left to correct, so nothing is written.
    const current = currentSystemQty(l.item_kind, l.item_id);
    const stillCounted = l.item_kind !== "product" ||
      !!db.query("SELECT 1 FROM products WHERE id = ? AND track_stock = 1 AND is_discontinued = 0").get(l.item_id);
    if (current == null || !stillCounted) {
      db.query("UPDATE stock_sync_lines SET applied_delta = 0 WHERE id = ?").run(l.id);
      continue;
    }
    const next = Math.max(0, roundQty(current + delta));
    const applied = roundQty(next - current);
    const why = `Stock sync at close: counted ${approved} (system said ${l.system_qty}) — approved by ${approver.full_name}`;
    if (l.item_kind === "product") {
      db.query("UPDATE products SET stock_quantity = ?, stock_updated_at = datetime('now') WHERE id = ?").run(next, l.item_id);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'counted_product_stock', ?)").run(
        approver.id, JSON.stringify({ product_id: l.item_id, name: l.name, previous: current, counted: next, difference: applied, reason: why, stock_sync_id: syncId })
      );
    } else {
      db.query(
        "INSERT INTO stock_transactions (stock_item_id, type, quantity, reference, user_id) VALUES (?, 'adjustment', ?, ?, ?)"
      ).run(l.item_id, applied, why, approver.id);
      db.query("UPDATE stock_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?").run(next, l.item_id);
    }
    db.query("UPDATE stock_sync_lines SET applied_delta = ? WHERE id = ?").run(applied, l.id);
  }
}

/** Mark a sync settled. Last, after every stock write, so the snapshot is the stock as it now stands. */
function settle(syncId: number, status: "matched" | "approved", approver: Approver | null, note: string | null) {
  getDb().query(`
    UPDATE stock_syncs SET status = ?, decided_by = ?, decided_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
           decision_note = ?, settled_at = datetime('now'), settled_snapshot = ?
    WHERE id = ?
  `).run(status, approver?.id ?? null, approver?.id ?? null, note, JSON.stringify(countedSnapshot(syncId)), syncId);
}

/**
 * Record a count. `counts` is [{ kind, id, counted, token }] and must cover
 * every item listSyncItems() returns NOW — if the list grew since the screen
 * loaded it (a delivery came in), the count is refused so nothing goes
 * uncounted. An item whose figure moved while it was being counted (its token
 * no longer matches) is refused too, and only those need counting again. A
 * count for an item that has since dropped to 0 is still compared — finding
 * stock the system thinks is gone is exactly what this is for — but only for
 * things that are counted at all (a tracked, current product or a stock item).
 *
 * While a count is WAITING for an admin, a cashier cannot send another one.
 * Otherwise "count again" until it matches would make a shortage vanish
 * before the admin ever saw it. A mistake is for the admin to correct or send
 * back; an admin (or their password at the till) may replace it.
 */
export function submitStockSync(params: { shiftOpenId: number; user: SessionUser; approver: Approver | null; counts: any[] }) {
  const db = getDb();
  if (!Array.isArray(params.counts)) throw new ClosingError("counts must be a list");
  const counted = new Map<string, { qty: number; token: string }>();
  for (const c of params.counts) {
    const kind = c?.kind === "product" ? "product" : c?.kind === "ingredient" ? "ingredient" : null;
    const id = Number(c?.id);
    const raw = c?.counted;
    if (!kind || !Number.isInteger(id) || id <= 0) throw new ClosingError("Each count needs a kind (product / ingredient) and an id.");
    const n = raw === "" || raw == null ? NaN : Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > MAX_COUNT) throw new ClosingError("Every count must be a number from 0 up.");
    if (kind === "product" && !Number.isInteger(n)) throw new ClosingError("Products are counted in whole pieces.");
    counted.set(`${kind}:${id}`, { qty: roundQty(n), token: String(c?.token ?? "") });
  }

  return db.transaction(() => {
    if (!params.approver) {
      const waiting = db.query("SELECT 1 FROM stock_syncs WHERE shift_open_id = ? AND status = 'pending'").get(params.shiftOpenId);
      if (waiting) {
        throw new ClosingError(
          "A stock count is already waiting for an admin. If it has a mistake, the admin can correct it or send it back for a recount.",
          409,
          { sync_pending: true }
        );
      }
    }
    const items = listSyncItems();
    const missing = items.filter((i) => !counted.has(`${i.kind}:${i.id}`));
    if (missing.length) {
      throw new ClosingError(
        `${missing.map((m) => m.name).slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""} ${missing.length === 1 ? "was" : "were"} not counted. The list has been reloaded — count ${missing.length === 1 ? "it" : "them"} too.`,
        409,
        { list_changed: true }
      );
    }
    const moved: { kind: string; id: number; name: string }[] =
      items.filter((i) => counted.get(`${i.kind}:${i.id}`)!.token !== itemToken(i.kind, i.id, i.system_qty));
    // An item counted from the list that has since sold down to 0 is no longer
    // in `items`, but it moved all the same: its token says what it was listed
    // at. Without this, "1 counted, then sold" went through as "1 found" and an
    // approval put a cake that is gone back on the books. Only a line with no
    // token at all (not from this list) is taken at face value below.
    const listedNow = new Set(items.map((i) => `${i.kind}:${i.id}`));
    for (const [key, c] of counted) {
      if (listedNow.has(key) || !c.token) continue;
      const [kind = "", idStr = ""] = key.split(":");
      const id = Number(idStr);
      const sys = currentSystemQty(kind, id);
      if (sys == null) continue; // deleted meanwhile: nothing to compare
      // Unticked (or untracked) since the list loaded: no longer counted at all,
      // so never "count it again" — the line is simply dropped below.
      if (!stillCounted(kind, id)) continue;
      if (c.token !== itemToken(kind, id, sys)) {
        const row = kind === "product"
          ? db.query("SELECT name FROM products WHERE id = ?").get(id) as any
          : db.query("SELECT name FROM stock_items WHERE id = ?").get(id) as any;
        moved.push({ kind, id, name: row?.name || "An item" });
      }
    }
    if (moved.length) {
      throw new ClosingError(
        `${moved.map((m) => m.name).slice(0, 5).join(", ")}${moved.length > 5 ? ` and ${moved.length - 5} more` : ""} changed while you were counting (a sale or a delivery). Count ${moved.length === 1 ? "it" : "them"} again.`,
        409,
        { list_changed: true, changed: moved.map((m) => ({ kind: m.kind, id: m.id })) }
      );
    }
    const listed = new Set(items.map((i) => `${i.kind}:${i.id}`));
    const lines: any[] = items.map((i) => ({ ...i, counted_qty: counted.get(`${i.kind}:${i.id}`)!.qty }));
    for (const [key, c] of counted) {
      if (listed.has(key)) continue;
      const [kind = "", idStr = ""] = key.split(":");
      const id = Number(idStr);
      const row = kind === "product"
        ? db.query("SELECT name, 'pcs' AS unit FROM products WHERE id = ? AND track_stock = 1 AND is_discontinued = 0 AND daily_sync = 1").get(id) as any
        : db.query("SELECT name, unit FROM stock_items WHERE id = ? AND daily_sync = 1").get(id) as any;
      if (!row) continue; // deleted, untracked or discontinued meanwhile: not counted stock
      lines.push({ kind, id, name: row.name, unit: row.unit || "", system_qty: currentSystemQty(kind, id) ?? 0, counted_qty: c.qty });
    }
    const mismatches = lines.filter((l) => Math.abs(l.counted_qty - l.system_qty) > QTY_EPS);

    // Only an approver gets here with a count waiting; theirs replaces it.
    db.query("UPDATE stock_syncs SET status = 'superseded' WHERE shift_open_id = ? AND status = 'pending'").run(params.shiftOpenId);
    const syncId = Number(db.query(
      "INSERT INTO stock_syncs (shift_open_id, user_id, status, mismatch_count) VALUES (?, ?, 'pending', ?)"
    ).run(params.shiftOpenId, params.user.id, mismatches.length).lastInsertRowid);
    const ins = db.query(
      "INSERT INTO stock_sync_lines (sync_id, item_kind, item_id, name, unit, system_qty, counted_qty) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    for (const l of lines) ins.run(syncId, l.kind, l.id, l.name, l.unit, l.system_qty, l.counted_qty);

    if (!mismatches.length) {
      settle(syncId, "matched", null, null);
    } else if (params.approver) {
      applySync(syncId, params.approver, new Map());
      settle(syncId, "approved", params.approver, params.approver.at_till ? "Approved with the admin's password at the till" : "Counted by an admin");
    }
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'stock_synced', ?)").run(
      params.user.id, JSON.stringify({ stock_sync_id: syncId, items: lines.length, mismatches: mismatches.length, approved_by: params.approver?.id ?? null })
    );
    return syncWithLines(syncId);
  }).immediate();
}

/**
 * An admin's decision on a pending sync. `corrections` (line id → figure) lets
 * the admin approve a different figure than was counted; any line they leave
 * alone is approved as counted. The sync must belong to the shift still open.
 */
export function decideStockSync(params: {
  syncId: number; approver: Approver; approve: boolean; note?: string | null;
  corrections?: { line_id: number; approved_qty: number }[]; shiftOpenId: number | null;
}) {
  const db = getDb();
  const note = String(params.note ?? "").trim() || null;
  if (!params.approve && !note) throw new ClosingError("Say why it is rejected, so the count can be redone properly.");
  const corrections = new Map<number, number>();
  for (const c of params.corrections || []) {
    const lid = Number(c?.line_id);
    const q = Number(c?.approved_qty);
    if (!Number.isInteger(lid) || !Number.isFinite(q) || q < 0 || q > MAX_COUNT) throw new ClosingError("Corrected figures must be numbers from 0 up.");
    corrections.set(lid, roundQty(q));
  }
  return db.transaction(() => {
    const sync = db.query("SELECT * FROM stock_syncs WHERE id = ?").get(params.syncId) as any;
    if (!sync) throw new ClosingError("That stock sync was not found", 404);
    if (sync.status !== "pending") throw new ClosingError(`That stock sync is already ${sync.status}.`);
    if (sync.shift_open_id !== params.shiftOpenId) throw new ClosingError("That stock sync belongs to a shift that is no longer open.");
    const kindOf = new Map((db.query("SELECT id, item_kind FROM stock_sync_lines WHERE sync_id = ?").all(params.syncId) as any[]).map((r) => [r.id, r.item_kind]));
    for (const [lid, q] of corrections) {
      if (!kindOf.has(lid)) throw new ClosingError("A corrected figure is for a line that is not on this sync.");
      if (kindOf.get(lid) === "product" && !Number.isInteger(q)) throw new ClosingError("Products are counted in whole pieces.");
    }
    if (params.approve) {
      applySync(params.syncId, params.approver, corrections);
      settle(params.syncId, "approved", params.approver, note);
    } else {
      db.query("UPDATE stock_syncs SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?")
        .run(params.approver.id, note, params.syncId);
    }
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)").run(
      params.approver.id, params.approve ? "stock_sync_approved" : "stock_sync_rejected",
      JSON.stringify({ stock_sync_id: params.syncId, corrected: corrections.size, note, at_till: params.approver.at_till })
    );
    return syncWithLines(params.syncId);
  }).immediate();
}

export function getStockSync(id: number) {
  return syncWithLines(id);
}
