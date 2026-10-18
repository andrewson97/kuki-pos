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
  const row = getDb().query(
    "SELECT id, full_name, role, is_active, password_hash FROM users WHERE username = ?"
  ).get(username) as any;
  const ok = row && row.is_active && row.role === "admin" && (await Bun.password.verify(password, row.password_hash));
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

/**
 * What has to be counted: tracked finished products and store-room items
 * (ingredients, packing) the system says are above 0. Opened boxes are not
 * counted — only what is still sealed, which is stock_items.quantity.
 * Discontinued products are left out (they are off the menu for good), but
 * inactive ones stay in: off the menu today is still on the shelf.
 */
export function listSyncItems(): SyncItem[] {
  const db = getDb();
  const products = db.query(`
    SELECT id, name, category, stock_quantity AS qty FROM products
    WHERE track_stock = 1 AND is_discontinued = 0 AND stock_quantity > ${QTY_EPS}
    ORDER BY category, name
  `).all() as any[];
  const items = db.query(`
    SELECT si.id, si.name, si.unit, si.quantity AS qty, COALESCE(sc.name, 'Uncategorised') AS category
    FROM stock_items si LEFT JOIN stock_categories sc ON sc.id = si.category_id
    WHERE si.quantity > ${QTY_EPS}
    ORDER BY sc.name, si.name
  `).all() as any[];
  return [
    ...products.map((p) => ({ kind: "product" as const, id: p.id, name: p.name, unit: "pcs", category: p.category || "General", system_qty: roundQty(p.qty) })),
    ...items.map((i) => ({ kind: "ingredient" as const, id: i.id, name: i.name, unit: i.unit || "", category: i.category, system_qty: roundQty(i.qty) })),
  ];
}

/**
 * Every in-stock quantity right now, keyed "product:12" / "ingredient:3" — the
 * same set listSyncItems() counts. Stored when a sync settles; the sync stays
 * good only while the stock still equals it. Exact, unlike a timestamp: a sale
 * in the same second as the sync still shows. A movement that nets to nothing
 * (one sold, one baked) leaves the count true, so it is rightly not flagged.
 */
function stockSnapshot(): Record<string, number> {
  const snap: Record<string, number> = {};
  for (const i of listSyncItems()) snap[`${i.kind}:${i.id}`] = i.system_qty;
  return snap;
}

function sameSnapshot(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > QTY_EPS) return false;
  return true;
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
  let stale = false;
  if (settled) {
    const raw = (db.query("SELECT settled_snapshot FROM stock_syncs WHERE id = ?").get(sync.id) as any)?.settled_snapshot;
    let snap: Record<string, number> | null = null;
    try { snap = JSON.parse(raw || "null"); } catch {}
    stale = !snap || !sameSnapshot(snap, stockSnapshot());
  }
  return {
    sync,
    valid: settled && !stale,
    // Settled, but stock moved after it: the cashier is told why a fresh count is needed.
    stale,
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
    const current = currentSystemQty(l.item_kind, l.item_id);
    if (current == null) continue; // deleted since the count: nothing left to correct
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
  `).run(status, approver?.id ?? null, approver?.id ?? null, note, JSON.stringify(stockSnapshot()), syncId);
}

/**
 * Record a count. `counts` is [{ kind, id, counted }] and must cover every item
 * listSyncItems() returns NOW — if the list grew since the screen loaded it (a
 * delivery came in), the count is refused so nothing goes uncounted. A count
 * for an item that has since dropped to 0 is still compared (finding stock the
 * system thinks is gone is exactly what this is for).
 */
export function submitStockSync(params: { shiftOpenId: number; user: SessionUser; approver: Approver | null; counts: any[] }) {
  const db = getDb();
  if (!Array.isArray(params.counts)) throw new ClosingError("counts must be a list");
  const counted = new Map<string, number>();
  for (const c of params.counts) {
    const kind = c?.kind === "product" ? "product" : c?.kind === "ingredient" ? "ingredient" : null;
    const id = Number(c?.id);
    const raw = c?.counted;
    if (!kind || !Number.isInteger(id) || id <= 0) throw new ClosingError("Each count needs a kind (product / ingredient) and an id.");
    const n = raw === "" || raw == null ? NaN : Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new ClosingError("Every count must be a number, 0 or more.");
    counted.set(`${kind}:${id}`, roundQty(n));
  }

  return db.transaction(() => {
    const items = listSyncItems();
    const missing = items.filter((i) => !counted.has(`${i.kind}:${i.id}`));
    if (missing.length) {
      throw new ClosingError(
        `${missing.map((m) => m.name).slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""} ${missing.length === 1 ? "was" : "were"} not counted. Reload the list and count again.`,
        409,
        { list_changed: true }
      );
    }
    const listed = new Set(items.map((i) => `${i.kind}:${i.id}`));
    const lines: any[] = items.map((i) => ({ ...i, counted_qty: counted.get(`${i.kind}:${i.id}`)! }));
    for (const [key, qty] of counted) {
      if (listed.has(key)) continue;
      const [kind = "", idStr = ""] = key.split(":");
      const id = Number(idStr);
      const sys = currentSystemQty(kind, id);
      if (sys == null) continue; // deleted meanwhile
      const row = kind === "product"
        ? db.query("SELECT name, 'pcs' AS unit FROM products WHERE id = ?").get(id) as any
        : db.query("SELECT name, unit FROM stock_items WHERE id = ?").get(id) as any;
      lines.push({ kind, id, name: row.name, unit: row.unit || "", system_qty: sys, counted_qty: qty });
    }
    const mismatches = lines.filter((l) => Math.abs(l.counted_qty - l.system_qty) > QTY_EPS);

    // A newer count replaces a pending one; a decided one stays as history.
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
    if (!Number.isInteger(lid) || !Number.isFinite(q) || q < 0) throw new ClosingError("Corrected figures must be numbers, 0 or more.");
    corrections.set(lid, roundQty(q));
  }
  return db.transaction(() => {
    const sync = db.query("SELECT * FROM stock_syncs WHERE id = ?").get(params.syncId) as any;
    if (!sync) throw new ClosingError("That stock sync was not found", 404);
    if (sync.status !== "pending") throw new ClosingError(`That stock sync is already ${sync.status}.`);
    if (sync.shift_open_id !== params.shiftOpenId) throw new ClosingError("That stock sync belongs to a shift that is no longer open.");
    const lineIds = new Set((db.query("SELECT id FROM stock_sync_lines WHERE sync_id = ?").all(params.syncId) as any[]).map((r) => r.id));
    for (const lid of corrections.keys()) if (!lineIds.has(lid)) throw new ClosingError("A corrected figure is for a line that is not on this sync.");
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
