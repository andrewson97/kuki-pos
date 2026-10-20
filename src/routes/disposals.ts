import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly, getUser, type SessionUser } from "../middleware/auth";
import { todayDate } from "../utils/helpers";
import { heldByOtherCarts } from "../services/reservations";

// --- Disposal requests: a cashier reports waste, an admin approves it ---------
//
// Throwing stock away used to be admin-only (Adjust stock → Waste on a product,
// a 'waste' transaction on an ingredient), so a cashier who dropped a tray of
// fish buns had no way to record it, and the shelf count stayed wrong until the
// owner happened to notice. Now a cashier files a REQUEST and an admin approves
// or rejects it — the same pending → approved/rejected shape expenses use, and
// like expenses an admin's own request is approved on the spot.
//
// WHAT APPROVAL WRITES is deliberately nothing new: exactly the records an
// admin's own waste already writes, so reports (cost of disposals), the profit
// figures and Stock History pick it up with no special case:
//   - product    → a product_disposals row (with the loss at cost price), the
//                  stock deducted if the product is tracked, and a
//                  'disposed_product' activity_log row;
//   - ingredient → a 'waste' stock_transactions row (negative quantity) and the
//                  stock_items quantity reduced.
// The requester is recorded as the person who disposed of it (they did); the
// approver is in the request row and the log.
//
// WHILE A REQUEST WAITS the goods are already in the bin, so for a TRACKED
// product the quantity is held in stock_reservations under cart_id
// 'disposal-<id>' — the tills subtract every hold from what they will sell, so
// the binned stock cannot be sold to a customer in the meantime. Approval
// deducts the stock and drops the hold in one transaction; rejection just drops
// the hold. Ingredients are never sold at the till, so there is nothing to hold;
// instead a new request may not claim more than is on hand minus what other
// pending requests already claim.
//
// The day the loss is booked against is the day the waste was REPORTED
// (business_date on the request), not the day it was approved: the stock left
// the shelf then.

const disposals = new Hono();

const holdCartId = (id: number) => `disposal-${id}`;

/** Thrown inside a transaction to roll it back and answer with this status. */
class Refused extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

const fmtQty = (n: number) => String(+Number(n).toFixed(3));

/**
 * Carry out an approved request. Runs INSIDE the caller's transaction, after
 * the caller has checked the request is still pending. Throws Refused when the
 * disposal can no longer be done as asked (the stock has since gone, or the
 * item was deleted) — the admin can then reject it, or correct the stock first.
 */
function carryOut(req: any, approver: SessionUser): void {
  const db = getDb();
  const approvedNote = req.requested_by !== approver.id ? ` · approved by ${approver.full_name}` : "";

  if (req.item_kind === "product") {
    const p = db.query("SELECT id, name, cost_price, track_stock, stock_quantity FROM products WHERE id = ?").get(req.item_id) as any;
    // The hold has done its job either way: released before the stock check so
    // the request's own hold is never counted against it.
    db.query("DELETE FROM stock_reservations WHERE cart_id = ?").run(holdCartId(req.id));
    if (!p) throw new Refused(`${req.item_name} no longer exists, so it cannot be disposed of. Reject the request instead.`, 409);

    const previous = Number(p.stock_quantity) || 0;
    let next = previous;
    if (p.track_stock) {
      if (req.quantity > previous + 1e-9) {
        throw new Refused(
          `Only ${fmtQty(previous)} of ${p.name} are on hand, so ${fmtQty(req.quantity)} cannot be disposed of. Count the stock first, or reject the request.`,
          409
        );
      }
      next = previous - req.quantity;
      db.query("UPDATE products SET stock_quantity = ?, stock_updated_at = datetime('now') WHERE id = ?").run(next, p.id);
    }
    const costLoss = req.quantity * (p.cost_price || 0);
    const reason = req.reason + approvedNote;
    db.query(
      "INSERT INTO product_disposals (product_id, quantity, cost_loss, reason, business_date, user_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(p.id, req.quantity, costLoss, reason, req.business_date, req.requested_by);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'disposed_product', ?)").run(
      approver.id,
      JSON.stringify({
        product_id: p.id, name: p.name, quantity: req.quantity, cost_loss: costLoss, reason,
        previous, new_quantity: next, disposal_request_id: req.id, requested_by: req.requested_by,
      })
    );
    return;
  }

  const item = db.query("SELECT id, name, unit, quantity FROM stock_items WHERE id = ?").get(req.item_id) as any;
  if (!item) throw new Refused(`${req.item_name} no longer exists, so it cannot be disposed of. Reject the request instead.`, 409);
  const onHand = Number(item.quantity) || 0;
  const unit = item.unit ? ` ${item.unit}` : "";
  if (req.quantity > onHand + 1e-9) {
    throw new Refused(
      `Only ${fmtQty(onHand)}${unit} of ${item.name} is on hand, so ${fmtQty(req.quantity)}${unit} cannot be disposed of. Count the stock first, or reject the request.`,
      409
    );
  }
  db.query(
    "INSERT INTO stock_transactions (stock_item_id, type, quantity, reference, user_id) VALUES (?, 'waste', ?, ?, ?)"
  ).run(item.id, -req.quantity, `Disposal request #${req.id} — ${req.reason}${approvedNote}`, req.requested_by);
  db.query("UPDATE stock_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?").run(onHand - req.quantity, item.id);
}

/** The request rows every screen reads, with who asked and who decided. */
const SELECT_REQUESTS = `
  SELECT r.*, ru.full_name AS requested_by_name, du.full_name AS decided_by_name
  FROM disposal_requests r
  LEFT JOIN users ru ON ru.id = r.requested_by
  LEFT JOIN users du ON du.id = r.decided_by
`;

// The list. An admin sees everyone's requests; a cashier sees only their own
// (so they can tell whether theirs was approved, and why one was rejected).
// ?status=pending|approved|rejected, or omitted for all; newest first.
disposals.get("/", (c) => {
  const user = getUser(c)!;
  const status = c.req.query("status");
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (status) {
    if (!["pending", "approved", "rejected"].includes(status)) return c.json({ error: "Unknown status" }, 400);
    conditions.push("r.status = ?");
    params.push(status);
  }
  if (user.role !== "admin") {
    conditions.push("r.requested_by = ?");
    params.push(user.id);
  }
  const limitRaw = parseInt(c.req.query("limit") || "", 10);
  const limit = Math.min(200, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50);
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .query(`${SELECT_REQUESTS}${where} ORDER BY r.requested_at DESC, r.id DESC LIMIT ?`)
    .all(...params, limit);
  return c.json(rows);
});

disposals.get("/pending-count", (c) => {
  const row = getDb().query("SELECT COUNT(*) AS count FROM disposal_requests WHERE status = 'pending'").get() as any;
  return c.json({ count: row?.count ?? 0 });
});

// File a request. Body: { item_kind: 'product'|'ingredient', item_id, quantity, reason }.
// Open to every logged-in user — reporting waste is ordinary shop-floor work.
// An admin's request is approved immediately (and so behaves exactly like
// Adjust stock → Waste), which is the same rule expenses follow.
disposals.post("/", async (c) => {
  const user = getUser(c)!;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "Body must be a JSON object" }, 400);

  const kind = body.item_kind;
  if (kind !== "product" && kind !== "ingredient") {
    return c.json({ error: "item_kind must be 'product' or 'ingredient'" }, 400);
  }
  const itemId = Number(body.item_id);
  if (!Number.isInteger(itemId) || itemId <= 0) return c.json({ error: "Choose the item to dispose of" }, 400);
  const qty = Number(body.quantity);
  if (body.quantity === null || body.quantity === "" || !Number.isFinite(qty) || qty <= 0) {
    return c.json({ error: "Enter how many were thrown away (more than 0)" }, 400);
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!reason) return c.json({ error: "Say why it was thrown away" }, 400);

  const db = getDb();
  try {
    const created = db.transaction(() => {
      let itemName: string;
      let unit = "";
      let holdProduct = false;

      if (kind === "product") {
        const p = db.query("SELECT id, name, track_stock, stock_quantity FROM products WHERE id = ?").get(itemId) as any;
        if (!p) throw new Refused("Product not found", 404);
        if (!Number.isInteger(qty)) throw new Refused("Products are disposed of in whole units");
        itemName = p.name;
        unit = "pcs";
        if (p.track_stock) {
          // What may still be claimed: on hand, minus every hold — customers'
          // carts and parked bills, and other pending disposals. A customer's
          // confirmed order outranks a waste report that would take its cake.
          const available = (Number(p.stock_quantity) || 0) - heldByOtherCarts(p.id, null);
          if (qty > available + 1e-9) {
            throw new Refused(
              `Only ${fmtQty(Math.max(0, available))} of ${p.name} can be reported — the rest is on hand but held (customers' carts or other disposal requests). If the count is wrong, ask an admin to count it.`
            );
          }
          holdProduct = true;
        }
      } else {
        const it = db.query("SELECT id, name, unit, quantity FROM stock_items WHERE id = ?").get(itemId) as any;
        if (!it) throw new Refused("Ingredient not found", 404);
        itemName = it.name;
        unit = it.unit || "";
        const pendingOther = (db.query(
          "SELECT COALESCE(SUM(quantity), 0) AS q FROM disposal_requests WHERE status = 'pending' AND item_kind = 'ingredient' AND item_id = ?"
        ).get(itemId) as any).q as number;
        const available = (Number(it.quantity) || 0) - pendingOther;
        if (qty > available + 1e-9) {
          const u = unit ? ` ${unit}` : "";
          throw new Refused(
            `Only ${fmtQty(Math.max(0, available))}${u} of ${it.name} can be reported${pendingOther > 0 ? ` (${fmtQty(pendingOther)}${u} is already waiting in other requests)` : ""}. If the count is wrong, ask an admin to count it.`
          );
        }
      }

      const ins = db.query(
        "INSERT INTO disposal_requests (item_kind, item_id, item_name, unit, quantity, reason, business_date, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(kind, itemId, itemName, unit, qty, reason, todayDate(), user.id);
      const id = Number(ins.lastInsertRowid);

      if (holdProduct) {
        db.query("INSERT INTO stock_reservations (product_id, quantity, cart_id, user_id) VALUES (?, ?, ?, ?)").run(
          itemId, qty, holdCartId(id), user.id
        );
      }
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'requested_disposal', ?)").run(
        user.id, JSON.stringify({ disposal_request_id: id, item_kind: kind, item_id: itemId, name: itemName, quantity: qty, reason })
      );

      // An admin's own report needs nobody's approval.
      if (user.role === "admin") {
        const req = db.query("SELECT * FROM disposal_requests WHERE id = ?").get(id) as any;
        carryOut(req, user);
        db.query("UPDATE disposal_requests SET status = 'approved', decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(user.id, id);
      }
      return db.query(`${SELECT_REQUESTS} WHERE r.id = ?`).get(id);
    }).immediate();
    return c.json({ success: true, request: created });
  } catch (err: any) {
    if (err instanceof Refused) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

/** Shared by approve and reject: lock, re-read, and refuse a decided request. */
function decide(id: number, fn: (req: any) => void): any {
  const db = getDb();
  return db.transaction(() => {
    const req = db.query("SELECT * FROM disposal_requests WHERE id = ?").get(id) as any;
    if (!req) throw new Refused("Request not found", 404);
    if (req.status !== "pending") throw new Refused(`This request was already ${req.status}.`, 409);
    fn(req);
    return db.query(`${SELECT_REQUESTS} WHERE r.id = ?`).get(id);
  }).immediate();
}

disposals.post("/:id/approve", adminOnly, (c) => {
  const admin = getUser(c)!;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid request id" }, 400);
  try {
    const row = decide(id, (req) => {
      carryOut(req, admin);
      getDb().query("UPDATE disposal_requests SET status = 'approved', decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(admin.id, id);
    });
    return c.json({ success: true, request: row });
  } catch (err: any) {
    if (err instanceof Refused) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

// Reject: nothing is disposed of and the held stock goes back on sale.
// Body: { reason } — optional, shown to the cashier on their request.
disposals.post("/:id/reject", adminOnly, async (c) => {
  const admin = getUser(c)!;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: "Invalid request id" }, 400);
  const body = await c.req.json().catch(() => ({}));
  const why = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  try {
    const row = decide(id, (req) => {
      const db = getDb();
      db.query("DELETE FROM stock_reservations WHERE cart_id = ?").run(holdCartId(req.id));
      db.query(
        "UPDATE disposal_requests SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), reject_reason = ? WHERE id = ?"
      ).run(admin.id, why || null, id);
      db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'rejected_disposal', ?)").run(
        admin.id, JSON.stringify({ disposal_request_id: id, name: req.item_name, quantity: req.quantity, reason: why })
      );
    });
    return c.json({ success: true, request: row });
  } catch (err: any) {
    if (err instanceof Refused) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

export default disposals;
