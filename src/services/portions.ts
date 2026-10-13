import { getDb } from "../db/database";

// --- Opened ingredients ("portions") -----------------------------------------
//
// Some products are made from an ingredient that is OPENED and then used up a
// serving at a time: a milk box makes 4 milkshakes. The owner links the product
// to the ingredient with a yield (product_ingredient_links.servings_per_unit),
// a cashier opens a unit from the till's Use stock panel (which takes it out of
// sealed stock), and from then on:
//
//   * a linked product can only be billed while the opened units of EVERY
//     ingredient it is linked to have enough left — checkPortions(), called by
//     the cart hold sync AND by createBill(), so the till is told when the item
//     goes into the cart and the server still refuses at payment;
//   * each sale uses quantity / servings_per_unit of a unit, oldest opened unit
//     first — consumePortions(), inside the sale transaction;
//   * a unit that reaches zero is marked 'finished' on the spot.
//
// Explosion matches computeStockNeeds() (src/services/reservations.ts): a
// product's own lines, plus the components of a composite it is part of. That
// is what lets a hold on a composite cover the milkshake inside it, and it is
// what keeps the hold rows consistent — see syncCartReservations().
//
// Holds. A linked product in a cart is held through the ordinary
// stock_reservations rows (one per product, units of that product), whether or
// not the product tracks its own stock. What another cart holds of an opened
// unit is then worked out from those rows and the links, so two tills cannot
// both sell the last milkshake in the box, and a parked bill keeps its share.

// The largest yield a link may have (src/routes/products.ts refuses more). It
// bounds the smallest serving at 1/1000 of a unit, which is what lets one
// fixed tolerance below be tiny next to any real serving.
export const MAX_SERVINGS_PER_UNIT = 1000;

/**
 * Below this, a fraction of a unit is nothing: three thirds use up a box. It
 * must stay far below the smallest serving (1 / MAX_SERVINGS_PER_UNIT) — it is
 * 0.1% of one — or a box would be called finished with servings still in it,
 * or a sale let through that the box cannot cover.
 */
export const PORTION_EPSILON = 1e-6;

// Stored fractions are rounded to 9 places: drift from a thousand sales of
// 1/999 stays under 1e-6, inside the tolerance above.
const roundFrac = (x: number) => Math.round(x * 1e9) / 1e9;

export class PortionError extends Error {
  constructor(message: string, public status: 400 | 404 = 400) { super(message); }
}

export interface LinkedUnits {
  name: string;
  /** Units of THIS product the lines consume, components included. */
  units: number;
}

/** Product ids that have at least one ingredient link. One query per call. */
function linkedProductIds(): Set<number> {
  const rows = getDb().query("SELECT DISTINCT product_id FROM product_ingredient_links").all() as any[];
  return new Set(rows.map((r) => Number(r.product_id)));
}

/**
 * Units of every LINKED product a set of lines consumes, exploded through
 * product_components exactly as computeStockNeeds() explodes tracked stock.
 * Products with no ingredient link are left out.
 */
export function computeLinkedUnits(items: { product_id: number; quantity: number }[]): Map<number, LinkedUnits> {
  const db = getDb();
  const linked = linkedProductIds();
  const out = new Map<number, LinkedUnits>();
  if (linked.size === 0) return out;
  const nameOf = (pid: number) => (db.query("SELECT name FROM products WHERE id = ?").get(pid) as any)?.name || "Product";
  const bump = (pid: number, qty: number) => {
    const cur = out.get(pid) || { name: nameOf(pid), units: 0 };
    cur.units += qty;
    out.set(pid, cur);
  };
  for (const item of items) {
    const pid = Number(item.product_id);
    const qty = Number(item.quantity);
    if (!pid || !(qty > 0)) continue;
    if (linked.has(pid)) bump(pid, qty);
    const components = db.query(
      "SELECT component_product_id, quantity FROM product_components WHERE product_id = ?"
    ).all(pid) as any[];
    for (const c of components) {
      if (linked.has(c.component_product_id)) bump(c.component_product_id, c.quantity * qty);
    }
  }
  return out;
}

interface NeedPart { product_id: number; product_name: string; units: number; fraction: number; servings_per_unit: number }
interface IngredientNeed { stock_item_id: number; name: string; fraction: number; parts: NeedPart[] }

/** What the linked units take of each ingredient, as fractions of one unit. */
function ingredientNeeds(units: Map<number, LinkedUnits>): Map<number, IngredientNeed> {
  const db = getDb();
  const needs = new Map<number, IngredientNeed>();
  for (const [pid, u] of units) {
    const links = db.query(`
      SELECT l.stock_item_id, l.servings_per_unit, si.name
      FROM product_ingredient_links l JOIN stock_items si ON si.id = l.stock_item_id
      WHERE l.product_id = ?
    `).all(pid) as any[];
    for (const l of links) {
      const fraction = u.units / l.servings_per_unit;
      const need = needs.get(l.stock_item_id) || { stock_item_id: l.stock_item_id, name: l.name, fraction: 0, parts: [] };
      need.fraction += fraction;
      need.parts.push({ product_id: pid, product_name: u.name, units: u.units, fraction, servings_per_unit: l.servings_per_unit });
      needs.set(l.stock_item_id, need);
    }
  }
  return needs;
}

/** Sum of what is left in the opened units of each ingredient. */
function openRemainingMap(): Map<number, number> {
  const rows = getDb().query(
    "SELECT stock_item_id, COALESCE(SUM(remaining), 0) AS left FROM opened_stock_units WHERE status = 'opened' GROUP BY stock_item_id"
  ).all() as any[];
  return new Map(rows.map((r) => [Number(r.stock_item_id), Number(r.left) || 0]));
}

/**
 * How much of each ingredient's opened units OTHER carts are holding, as a
 * fraction of one unit. Same "blank cart id = every hold is somebody else's"
 * rule as heldByOtherCarts().
 */
function heldPortionsByOtherCarts(cartId?: string | null): Map<number, number> {
  const cart = String(cartId || "").trim();
  const sql = `
    SELECT l.stock_item_id, COALESCE(SUM(r.quantity / l.servings_per_unit), 0) AS held
    FROM stock_reservations r JOIN product_ingredient_links l ON l.product_id = r.product_id
    ${cart ? "WHERE r.cart_id != ?" : ""}
    GROUP BY l.stock_item_id`;
  const rows = (cart ? getDb().query(sql).all(cart) : getDb().query(sql).all()) as any[];
  return new Map(rows.map((r) => [Number(r.stock_item_id), Number(r.held) || 0]));
}

const servingsFrom = (fraction: number, servingsPerUnit: number) =>
  Math.max(0, Math.floor(fraction * servingsPerUnit + PORTION_EPSILON));

/**
 * Refuse lines whose opened ingredients cannot cover them. Throws a
 * PortionError with a message the cashier can act on. Plain (not its own
 * transaction): callers run it inside theirs, before they write.
 */
export function checkPortions(units: Map<number, LinkedUnits>, cartId?: string | null): void {
  if (units.size === 0) return;
  const db = getDb();
  const open = openRemainingMap();
  const held = heldPortionsByOtherCarts(cartId);
  for (const need of ingredientNeeds(units).values()) {
    const available = (open.get(need.stock_item_id) ?? 0) - (held.get(need.stock_item_id) ?? 0);
    if (available + PORTION_EPSILON >= need.fraction) continue;

    const first = need.parts[0];
    const sealed = Number((db.query("SELECT quantity FROM stock_items WHERE id = ?").get(need.stock_item_id) as any)?.quantity) || 0;
    const sealedHint = sealed >= 1 ? ` (${+sealed.toFixed(3)} sealed in stock)` : " — and none are left in stock, so restock it first";
    if (!open.has(need.stock_item_id) || (open.get(need.stock_item_id) ?? 0) <= PORTION_EPSILON) {
      throw new PortionError(`${first.product_name} needs an opened ${need.name}. Open one from "Use stock" first${sealedHint}.`);
    }
    const left = servingsFrom(available, first.servings_per_unit);
    const heldNote = (held.get(need.stock_item_id) ?? 0) > PORTION_EPSILON ? ", after what other carts are holding" : "";
    // Several products sharing the box: the whole cart's need, in servings of
    // the product named, so "need" is comparable with "only N left".
    const needServings = +(need.fraction * first.servings_per_unit).toFixed(3);
    const others = need.parts.length > 1 ? " with the rest of this cart" : "";
    throw new PortionError(
      `Only ${left} ${first.product_name} left in the opened ${need.name}${heldNote} (need ${needServings}${others}). Open another ${need.name} from "Use stock"${sealedHint}.`
    );
  }
}

/**
 * Take a sale's portions out of the opened units, oldest unit first, and mark
 * every unit that runs out as finished. Must run inside the sale transaction,
 * AFTER checkPortions() passed in that same transaction.
 */
export function consumePortions(billId: number, units: Map<number, LinkedUnits>, userId: number): void {
  if (units.size === 0) return;
  const db = getDb();
  const insertUsage = db.query(
    "INSERT INTO opened_unit_usage (opened_unit_id, bill_id, product_id, product_name, quantity, fraction) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const need of ingredientNeeds(units).values()) {
    for (const part of need.parts) {
      let left = part.fraction;
      const openUnits = db.query(
        "SELECT id, remaining FROM opened_stock_units WHERE stock_item_id = ? AND status = 'opened' ORDER BY opened_at, id"
      ).all(need.stock_item_id) as any[];
      for (const u of openUnits) {
        if (left <= PORTION_EPSILON) break;
        const take = Math.min(Number(u.remaining) || 0, left);
        if (take <= 0) continue;
        const remaining = roundFrac((Number(u.remaining) || 0) - take);
        left = roundFrac(left - take);
        // Rounding dust is not a serving: anything under the tolerance is an
        // empty box, so it is finished rather than left "opened" with nothing in it.
        if (remaining <= PORTION_EPSILON) {
          db.query(
            "UPDATE opened_stock_units SET remaining = 0, status = 'finished', finish_reason = 'used_up', finished_at = datetime('now'), finished_by = ? WHERE id = ?"
          ).run(userId, u.id);
        } else {
          db.query("UPDATE opened_stock_units SET remaining = ? WHERE id = ?").run(remaining, u.id);
        }
        insertUsage.run(u.id, billId, part.product_id, part.product_name, roundFrac(take * part.servings_per_unit), roundFrac(take));
      }
      // checkPortions() ran under the same write lock, so this cannot happen;
      // if it ever does, the sale must not commit having used less than it sold.
      if (left > PORTION_EPSILON) throw new PortionError(`${part.product_name}: the opened ${need.name} ran out during the sale. Open another and try again.`);
    }
  }
}

/**
 * Open one unit of an ingredient: take it out of sealed stock (a 'usage'
 * movement, so Stock History shows it) and start an opened unit with all of
 * it left. Only ingredients that some product is made from can be opened.
 */
export function openStockUnit(stockItemId: number, userId: number, note?: string | null) {
  const db = getDb();
  return db.transaction(() => {
    const item = db.query("SELECT id, name, unit, quantity FROM stock_items WHERE id = ?").get(stockItemId) as any;
    if (!item) throw new PortionError("Stock item not found", 404);
    const links = db.query(`
      SELECT p.name, l.servings_per_unit FROM product_ingredient_links l JOIN products p ON p.id = l.product_id
      WHERE l.stock_item_id = ? ORDER BY p.name
    `).all(stockItemId) as any[];
    if (!links.length) {
      throw new PortionError(`Nothing on the menu is made from ${item.name}, so there is nothing to open it for. Use "Use" to record it instead.`);
    }
    const onHand = Number(item.quantity) || 0;
    const unit = item.unit ? ` ${item.unit}` : "";
    if (onHand < 1 - 1e-9) {
      throw new PortionError(`No sealed ${item.name} left (${+onHand.toFixed(3)}${unit} on hand). Restock it on the Stock page first.`);
    }
    const next = roundFrac(onHand - 1);
    const makes = links.map((l) => `${+Number(l.servings_per_unit).toFixed(3)} ${l.name}`).join(" / ");
    const cleanNote = String(note || "").trim();
    const ref = `Opened at POS — makes ${makes}` + (cleanNote ? ` — ${cleanNote}` : "");
    db.query(
      "INSERT INTO stock_transactions (stock_item_id, type, quantity, reference, user_id) VALUES (?, 'usage', -1, ?, ?)"
    ).run(stockItemId, ref, userId);
    db.query("UPDATE stock_items SET quantity = ?, updated_at = datetime('now') WHERE id = ?").run(next, stockItemId);
    const result = db.query(
      "INSERT INTO opened_stock_units (stock_item_id, status, remaining, opened_by) VALUES (?, 'opened', 1, ?)"
    ).run(stockItemId, userId);
    const openedId = Number(result.lastInsertRowid);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'opened_stock_unit', ?)").run(
      userId, JSON.stringify({ opened_unit_id: openedId, stock_item_id: stockItemId, name: item.name, previous: onHand, new_quantity: next, note: cleanNote || null })
    );
    return { id: openedId, name: item.name, sealed_left: next };
  }).immediate();
}

/**
 * Mark an opened unit finished before sales used it up (spilled, gone off, the
 * last bit went into something else). Whatever was left is recorded with the
 * reason; it does not go back into stock — an opened box is not sealed stock.
 */
export function finishStockUnit(openedId: number, userId: number, note: string) {
  const db = getDb();
  const reason = String(note || "").trim();
  if (!reason) throw new PortionError("Say why it is being finished early");
  return db.transaction(() => {
    const u = db.query(`
      SELECT o.id, o.status, o.remaining, o.stock_item_id, si.name
      FROM opened_stock_units o JOIN stock_items si ON si.id = o.stock_item_id WHERE o.id = ?
    `).get(openedId) as any;
    if (!u) throw new PortionError("That opened item was not found", 404);
    if (u.status !== "opened") throw new PortionError(`That ${u.name} is already finished`);
    db.query(
      "UPDATE opened_stock_units SET status = 'finished', finish_reason = 'manual', finish_note = ?, finished_at = datetime('now'), finished_by = ? WHERE id = ?"
    ).run(reason, userId, openedId);
    db.query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'finished_stock_unit', ?)").run(
      userId, JSON.stringify({ opened_unit_id: openedId, stock_item_id: u.stock_item_id, name: u.name, remaining_discarded: roundFrac(Number(u.remaining) || 0), reason })
    );
    return { id: openedId, name: u.name, remaining_discarded: roundFrac(Number(u.remaining) || 0) };
  }).immediate();
}

/**
 * Every ingredient that something is made from, with its links and its opened
 * units — what the till's Use stock panel shows. servings_left is per linked
 * product for each opened unit, ignoring holds (a unit's contents, not what is
 * free to sell; the grid's figures come from productPortionStatus()).
 */
export function listPortionIngredients(): any[] {
  const db = getDb();
  const links = db.query(`
    SELECT l.stock_item_id, l.product_id, l.servings_per_unit, p.name AS product_name
    FROM product_ingredient_links l JOIN products p ON p.id = l.product_id
    ORDER BY p.name
  `).all() as any[];
  const opened = db.query(`
    SELECT o.id, o.stock_item_id, o.remaining, o.opened_at, u.full_name AS opened_by_name
    FROM opened_stock_units o LEFT JOIN users u ON u.id = o.opened_by
    WHERE o.status = 'opened' ORDER BY o.opened_at, o.id
  `).all() as any[];
  const byItem = new Map<number, any>();
  const entry = (id: number) => {
    const it = byItem.get(id) || { stock_item_id: id, links: [], opened_units: [] };
    byItem.set(id, it);
    return it;
  };
  for (const l of links) {
    entry(l.stock_item_id).links.push({ product_id: l.product_id, product_name: l.product_name, servings_per_unit: l.servings_per_unit });
  }
  for (const o of opened) {
    // An item whose last link was removed while a unit stood open is still
    // listed (links empty): nothing sells from it, but it must stay visible so
    // someone can finish it rather than have it come back stale if relinked.
    const it = entry(o.stock_item_id);
    it.opened_units.push({
      id: o.id,
      remaining: roundFrac(Number(o.remaining) || 0),
      opened_at: o.opened_at,
      opened_by_name: o.opened_by_name,
      servings_left: it.links.map((l: any) => ({ product_name: l.product_name, servings: servingsFrom(Number(o.remaining) || 0, l.servings_per_unit) })),
    });
  }
  return [...byItem.values()];
}

/**
 * For the POS grid: every linked product's sellable servings, after what other
 * carts hold, and which ingredient is the limit. A product is sellable only
 * while servings_left > 0. Keyed by product id; products with no link are absent.
 */
export function productPortionStatus(cartId?: string | null): Map<number, any> {
  const db = getDb();
  const links = db.query(`
    SELECT l.product_id, l.stock_item_id, l.servings_per_unit, si.name AS ingredient_name, si.quantity AS sealed_quantity, si.unit
    FROM product_ingredient_links l JOIN stock_items si ON si.id = l.stock_item_id
  `).all() as any[];
  const out = new Map<number, any>();
  if (!links.length) return out;
  const open = openRemainingMap();
  const held = heldPortionsByOtherCarts(cartId);
  for (const l of links) {
    const available = Math.max(0, (open.get(l.stock_item_id) ?? 0) - (held.get(l.stock_item_id) ?? 0));
    const servings = servingsFrom(available, l.servings_per_unit);
    const status = out.get(l.product_id) || { servings_left: Infinity, links: [] };
    status.links.push({
      stock_item_id: l.stock_item_id,
      ingredient_name: l.ingredient_name,
      servings_per_unit: l.servings_per_unit,
      servings_left: servings,
      // The same figure as a fraction of one unit, so the till can add up what
      // SEVERAL products in its cart take from one shared box.
      available: roundFrac(available),
      is_open: (open.get(l.stock_item_id) ?? 0) > PORTION_EPSILON,
      sealed_quantity: Number(l.sealed_quantity) || 0,
      unit: l.unit,
    });
    status.servings_left = Math.min(status.servings_left, servings);
    out.set(l.product_id, status);
  }
  return out;
}
