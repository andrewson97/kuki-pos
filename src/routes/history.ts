import { Hono } from "hono";
import { getDb } from "../db/database";
import { adminOnly } from "../middleware/auth";

// --- Unified stock history -------------------------------------------------
//
// READ-ONLY. Nothing here writes, and no new table was added: every movement
// the owner wants to see is already recorded somewhere, just in four different
// shapes. This router is the report that merges them, which means the whole
// history that existed before this screen was built shows up retroactively and
// stock accuracy is untouched.
//
// The four sources:
//   1. stock_transactions  — ingredients (stock_items). purchase/usage/adjustment/waste.
//   2. activity_log        — 'restocked_product' (tracked finished goods), plus
//                            'released_stock_hold' and 'refunded_bill' as context rows.
//   3. product_disposals   — tracked-product wastage, with its cost.
//   4. bill_items + bills  — sales. No stock-movement row is ever written for a
//                            sale, so the outward movement is DERIVED here.
//
// activity_log actions deliberately NOT included, because they would duplicate
// a source that carries strictly more detail:
//   - 'disposed_product' → duplicates source 3 (which also has cost_loss and the
//                          business_date the disposal was booked against).
//   - 'stock_usage'      → the bulk-usage endpoint writes one summary log row AND
//                          one stock_transactions row per item; source 1 has the
//                          per-item quantities, the summary has none.
//   - 'created_bill'     → duplicates source 4, which is itemised.
//
// --- Composite (BoM) sales -------------------------------------------------
// A sale does not necessarily deduct the product on the receipt. computeStockNeeds()
// in src/services/reservations.ts — the single implementation shared by createBill()
// and the cart holds — deducts (a) the sold product's own count when track_stock = 1,
// AND (b) every tracked component in product_components, quantity × line quantity.
// So a "Birthday Box" that is itself untracked but explodes into two tracked cakes
// moves two cakes and zero boxes.
//
// Deriving sales from bill_items alone would therefore show a misleading picture:
// it would invent movements for untracked products and hide the component
// movements that actually happened. The sale branch below mirrors computeStockNeeds()
// exactly — one arm for the product itself, one arm for its tracked components —
// so the timeline matches what the stock column really did.
//
// --- UTC timestamps vs business dates --------------------------------------
// created_at columns are UTC (datetime('now')); business_date / bill_date are
// Asia/Colombo business dates that roll over at 5 AM (see todayDate() in
// src/utils/helpers.ts). Filtering a UTC timestamp with a date picked in Colombo
// silently misfiles anything near midnight.
//
// Colombo is UTC+5:30 with no DST, and the business day starts 5 hours into the
// local day, so:
//     business_date(utc) = date(utc + 5:30 − 5:00) = date(utc, '+30 minutes')
// That is exactly what todayDate() computes in JS. Every row therefore gets a
// business_date: the stored column where one exists (sources 3 and 4 — that is
// the date the sale/disposal was actually booked against), and the derived
// expression for the UTC-only sources (1 and 2). start_date/end_date filter on
// that one normalised column, so all four sources agree.
//
// Ordering is by created_at, the true UTC instant, so the merge is a real
// chronological timeline regardless of which business day each row belongs to.

const history = new Hono();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MOVEMENT_TYPES = [
  "purchase",
  "usage",
  "adjustment",
  "waste",
  "restock",
  "sale",
  "disposal",
  "hold_released",
  "refund",
];

const DIRECTIONS = ["in", "out", "info"];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

// UTC timestamp -> Asia/Colombo business date (5 AM rollover). See note above.
const BIZ_DATE = (col: string) => `date(${col}, '+30 minutes')`;

// One SELECT per source, all sharing the same column list. Column names come
// from the first branch, but every branch is aliased so the shape is obvious.
const UNIFIED_SQL = `
  -- 1. Ingredients: stock_transactions. The sign of quantity is the direction.
  SELECT
    'stock_txn'                                     AS source,
    st.id                                           AS source_id,
    st.created_at                                   AS occurred_at,
    ${BIZ_DATE("st.created_at")}                    AS business_date,
    'ingredient'                                    AS item_kind,
    st.stock_item_id                                AS item_id,
    COALESCE(si.name, 'Deleted item')               AS item_name,
    COALESCE(si.unit, '')                           AS unit,
    st.type                                         AS movement_type,
    CASE WHEN st.quantity < 0 THEN 'out' ELSE 'in' END AS direction,
    ABS(st.quantity)                                AS quantity,
    NULL                                            AS note,
    st.reference                                    AS reference,
    u.full_name                                     AS user_name,
    NULL                                            AS cost_loss
  FROM stock_transactions st
  LEFT JOIN stock_items si ON si.id = st.stock_item_id
  LEFT JOIN users u ON u.id = st.user_id

  UNION ALL

  -- 2a. Tracked finished products restocked by an admin.
  SELECT
    'restock',
    al.id,
    al.created_at,
    ${BIZ_DATE("al.created_at")},
    'product',
    CAST(json_extract(al.details, '$.product_id') AS INTEGER),
    COALESCE(json_extract(al.details, '$.name'), 'Deleted product'),
    'pcs',
    'restock',
    'in',
    ABS(COALESCE(json_extract(al.details, '$.quantity'), 0)),
    json_extract(al.details, '$.note'),
    NULL,
    u.full_name,
    NULL
  FROM activity_log al
  LEFT JOIN users u ON u.id = al.user_id
  WHERE al.action = 'restocked_product'

  UNION ALL

  -- 3. Tracked-product disposals, with the money lost.
  SELECT
    'disposal',
    d.id,
    d.created_at,
    d.business_date,
    'product',
    d.product_id,
    COALESCE(p.name, 'Deleted product'),
    'pcs',
    'disposal',
    'out',
    ABS(d.quantity),
    d.reason,
    NULL,
    u.full_name,
    d.cost_loss
  FROM product_disposals d
  LEFT JOIN products p ON p.id = d.product_id
  LEFT JOIN users u ON u.id = d.user_id

  UNION ALL

  -- 4a. Sales: the sold product's own stock, when it is tracked.
  --     Mirrors the first half of computeStockNeeds().
  SELECT
    'sale',
    bi.id,
    b.created_at,
    b.bill_date,
    'product',
    p.id,
    COALESCE(p.name, bi.product_name),
    'pcs',
    'sale',
    'out',
    bi.quantity,
    NULL,
    'Bill #' || b.token_number,
    u.full_name,
    NULL
  FROM bill_items bi
  JOIN bills b ON b.id = bi.bill_id
  JOIN products p ON p.id = bi.product_id
  LEFT JOIN users u ON u.id = b.user_id
  WHERE b.status = 'completed' AND p.track_stock = 1

  UNION ALL

  -- 4b. Sales: the tracked COMPONENTS a composite product explodes into.
  --     Mirrors the second half of computeStockNeeds(). Without this arm a
  --     composite sale would look like nothing moved.
  SELECT
    'sale_component',
    bi.id,
    b.created_at,
    b.bill_date,
    'product',
    cp.id,
    COALESCE(cp.name, 'Deleted product'),
    'pcs',
    'sale',
    'out',
    pc.quantity * bi.quantity,
    'Component of ' || bi.product_name,
    'Bill #' || b.token_number,
    u.full_name,
    NULL
  FROM bill_items bi
  JOIN bills b ON b.id = bi.bill_id
  JOIN product_components pc ON pc.product_id = bi.product_id
  JOIN products cp ON cp.id = pc.component_product_id
  LEFT JOIN users u ON u.id = b.user_id
  WHERE b.status = 'completed' AND cp.track_stock = 1

  UNION ALL

  -- 2b. A hold released by an admin. Not a stock movement (a hold never changes
  --     stock_quantity) but it is the answer to "why did that cake come back?",
  --     so it rides along as an 'info' row. The log stores only the product NAME,
  --     so the id is looked up by name to keep the item filter working.
  SELECT
    'hold_released',
    al.id,
    al.created_at,
    ${BIZ_DATE("al.created_at")},
    'product',
    (SELECT pr.id FROM products pr WHERE pr.name = json_extract(al.details, '$.product')),
    COALESCE(json_extract(al.details, '$.product'), 'Unknown product'),
    'pcs',
    'hold_released',
    'info',
    ABS(COALESCE(json_extract(al.details, '$.quantity'), 0)),
    'Cart ' || COALESCE(json_extract(al.details, '$.cart_id'), '?'),
    NULL,
    u.full_name,
    NULL
  FROM activity_log al
  LEFT JOIN users u ON u.id = al.user_id
  WHERE al.action = 'released_stock_hold'

  UNION ALL

  -- 2c. A refunded bill. Branch 4 only counts status = 'completed', so refunding
  --     a bill removes its sale rows from this timeline AND the refund handler
  --     puts the stock back — the two cancel out and the timeline stays
  --     consistent with on-hand stock. But rows silently vanishing is exactly the
  --     misleading picture to avoid, so the refund itself is shown as an 'info'
  --     row. The log has no per-item detail, hence no quantity.
  SELECT
    'refund',
    al.id,
    al.created_at,
    ${BIZ_DATE("al.created_at")},
    '',
    NULL,
    'All items on bill (returned to stock)',
    '',
    'refund',
    'info',
    NULL,
    json_extract(al.details, '$.reason'),
    'Bill #' || COALESCE(json_extract(al.details, '$.token'), '?'),
    u.full_name,
    NULL
  FROM activity_log al
  LEFT JOIN users u ON u.id = al.user_id
  WHERE al.action = 'refunded_bill'
`;

interface Filters {
  where: string;
  params: (string | number)[];
}

function buildFilters(c: any): Filters | { error: string } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  const startDate = c.req.query("start_date");
  const endDate = c.req.query("end_date");
  if (startDate) {
    if (!DATE_RE.test(startDate)) return { error: "start_date must be YYYY-MM-DD" };
    conditions.push("business_date >= ?");
    params.push(startDate);
  }
  if (endDate) {
    if (!DATE_RE.test(endDate)) return { error: "end_date must be YYYY-MM-DD" };
    conditions.push("business_date <= ?");
    params.push(endDate);
  }

  // Item: either an exact product/ingredient, or a name search.
  const itemKind = c.req.query("item_kind");
  if (itemKind) {
    if (itemKind !== "product" && itemKind !== "ingredient") {
      return { error: "item_kind must be 'product' or 'ingredient'" };
    }
    conditions.push("item_kind = ?");
    params.push(itemKind);
  }
  const itemId = c.req.query("item_id");
  if (itemId) {
    const id = parseInt(itemId, 10);
    if (!id) return { error: "item_id must be a number" };
    conditions.push("item_id = ?");
    params.push(id);
  }
  const q = (c.req.query("q") || "").trim();
  if (q) {
    conditions.push("item_name LIKE ?");
    params.push(`%${q}%`);
  }

  // Movement type: repeatable ?type=sale&type=waste, or comma-separated.
  const rawTypes: string[] = [];
  for (const v of c.req.queries("type") || []) {
    for (const part of String(v).split(",")) {
      const t = part.trim();
      if (t) rawTypes.push(t);
    }
  }
  if (rawTypes.length) {
    for (const t of rawTypes) {
      if (!MOVEMENT_TYPES.includes(t)) return { error: `Unknown type '${t}'` };
    }
    conditions.push(`movement_type IN (${rawTypes.map(() => "?").join(", ")})`);
    params.push(...rawTypes);
  }

  const direction = c.req.query("direction");
  if (direction) {
    if (!DIRECTIONS.includes(direction)) return { error: "direction must be in, out or info" };
    conditions.push("direction = ?");
    params.push(direction);
  }

  return { where: conditions.length ? " WHERE " + conditions.join(" AND ") : "", params };
}

/**
 * The merged timeline, newest first. Always paged — this view grows forever.
 */
history.get("/stock", adminOnly, (c) => {
  const filters = buildFilters(c);
  if ("error" in filters) return c.json({ error: filters.error }, 400);

  const limitRaw = parseInt(c.req.query("limit") || "", 10);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT)
  );
  const offsetRaw = parseInt(c.req.query("offset") || "", 10);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  const db = getDb();

  const totalRow = db
    .query(`SELECT COUNT(*) AS n FROM (${UNIFIED_SQL}) ${filters.where}`)
    .get(...filters.params) as { n: number } | null;
  const total = totalRow?.n ?? 0;

  // occurred_at is the real UTC instant, so this is a true chronological merge.
  // The extra keys only break ties within the same second, deterministically,
  // so paging can never repeat or skip a row.
  const rows = db
    .query(
      `SELECT * FROM (${UNIFIED_SQL}) ${filters.where}
       ORDER BY occurred_at DESC, source ASC, source_id DESC, item_id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...filters.params, limit, offset);

  return c.json({ rows, total, limit, offset, has_more: offset + rows.length < total });
});

/**
 * The items that can appear in the timeline — feeds the page's item filter.
 * Products that are untracked but have been disposed of still have history,
 * so they are included too.
 */
history.get("/items", adminOnly, (c) => {
  const db = getDb();
  const products = db
    .query(
      `SELECT id, name FROM products
       WHERE track_stock = 1
          OR id IN (SELECT product_id FROM product_disposals)
          OR id IN (SELECT component_product_id FROM product_components)
       ORDER BY name`
    )
    .all();
  const ingredients = db.query("SELECT id, name, unit FROM stock_items ORDER BY name").all();
  return c.json({ products, ingredients, movement_types: MOVEMENT_TYPES });
});

export default history;
