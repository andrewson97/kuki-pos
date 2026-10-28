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
//   2. activity_log        — 'restocked_product' (tracked finished goods),
//                            'counted_product_stock' (a stock count that set the
//                            figure — POST /api/products/:id/stock-adjust), plus
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
  "opened_finished",
  "packing_shortfall",
];

const DIRECTIONS = ["in", "out", "info"];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

// UTC timestamp -> Asia/Colombo business date (5 AM rollover). See note above.
const BIZ_DATE = (col: string) => `date(${col}, '+30 minutes')`;

// Which bills' sales still count as stock that left the shop: completed bills,
// and refunded bills whose refund did NOT put the items back. A refund that
// restocked (refund_restocked = 1, including every refund from before the
// choice existed — see the backfill in src/db/migrations.ts) cancels its sale.
// A bill rung up with skip_stock (a pre-order collection — pre-ordered goods are
// never stock) moved nothing at all, so it is never a stock movement here.
const SALE_STILL_OUT =
  "(b.stock_skipped = 0 AND (b.status = 'completed' OR (b.status = 'refunded' AND b.refund_restocked = 0)))";

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
    NULL                                            AS cost_loss,
    NULL                                            AS anchor_after
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
    NULL,
    json_extract(al.details, '$.new_quantity')
  FROM activity_log al
  LEFT JOIN users u ON u.id = al.user_id
  WHERE al.action = 'restocked_product'

  UNION ALL

  -- 2d. A tracked product counted and set to the counted figure ("there are
  --     actually 5"). The log keeps the signed difference, which is the
  --     movement; a count that matched is an 'info' row so the check itself
  --     still shows. The note carries both figures so "why did it jump?" is
  --     answered on the row.
  SELECT
    'stock_count',
    al.id,
    al.created_at,
    ${BIZ_DATE("al.created_at")},
    'product',
    CAST(json_extract(al.details, '$.product_id') AS INTEGER),
    COALESCE(json_extract(al.details, '$.name'), 'Deleted product'),
    'pcs',
    'adjustment',
    CASE
      WHEN json_extract(al.details, '$.difference') > 0 THEN 'in'
      WHEN json_extract(al.details, '$.difference') < 0 THEN 'out'
      ELSE 'info'
    END,
    ABS(COALESCE(json_extract(al.details, '$.difference'), 0)),
    'Counted ' || COALESCE(json_extract(al.details, '$.counted'), '?')
      || ' (was ' || COALESCE(json_extract(al.details, '$.previous'), '?') || ')'
      || COALESCE(' — ' || json_extract(al.details, '$.reason'), ''),
    NULL,
    u.full_name,
    NULL,
    json_extract(al.details, '$.counted')
  FROM activity_log al
  LEFT JOIN users u ON u.id = al.user_id
  WHERE al.action = 'counted_product_stock'

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
    d.cost_loss,
    NULL
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
    NULL,
    NULL
  FROM bill_items bi
  JOIN bills b ON b.id = bi.bill_id
  JOIN products p ON p.id = bi.product_id
  LEFT JOIN users u ON u.id = b.user_id
  WHERE ${SALE_STILL_OUT} AND p.track_stock = 1

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
    NULL,
    NULL
  FROM bill_items bi
  JOIN bills b ON b.id = bi.bill_id
  JOIN product_components pc ON pc.product_id = bi.product_id
  JOIN products cp ON cp.id = pc.component_product_id
  LEFT JOIN users u ON u.id = b.user_id
  WHERE ${SALE_STILL_OUT} AND cp.track_stock = 1

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
    NULL,
    NULL
  FROM activity_log al
  LEFT JOIN users u ON u.id = al.user_id
  WHERE al.action = 'released_stock_hold'

  UNION ALL

  -- 2c. A refunded bill. A refund only puts stock back when the cashier ticked
  --     "Put items back into stock" (bills.refund_restocked = 1). For those,
  --     branch 4 drops the bill's sale rows AND the stock came back — the two
  --     cancel out and the timeline stays consistent with on-hand stock. For a
  --     refund that did NOT restock, the units really did leave, so branch 4
  --     keeps the sale rows (see SALE_STILL_OUT). Either way the refund itself
  --     is shown as an 'info' row, saying which of the two happened. Log rows
  --     written before the choice existed have no 'restock' key; every refund
  --     back then restored stock, so a missing key reads as "returned". The log
  --     has no per-item detail, hence no quantity.
  SELECT
    'refund',
    al.id,
    al.created_at,
    ${BIZ_DATE("al.created_at")},
    '',
    NULL,
    CASE WHEN json_extract(al.details, '$.restock') = 0
      THEN 'All items on bill (NOT returned to stock)'
      ELSE 'All items on bill (returned to stock)'
    END,
    '',
    'refund',
    'info',
    NULL,
    json_extract(al.details, '$.reason'),
    'Bill #' || COALESCE(json_extract(al.details, '$.token'), '?'),
    u.full_name,
    NULL,
    NULL
  FROM activity_log al
  LEFT JOIN users u ON u.id = al.user_id
  WHERE al.action = 'refunded_bill'

  UNION ALL

  -- 2e. An opened ingredient unit (a milk box) reaching FINISHED. Not a stock
  --     movement — the unit left sealed stock when it was opened, which is the
  --     'usage' row in source 1 — so it is an 'info' row. Used up by sales:
  --     quantity NULL. Finished early (spilled, gone off): quantity is the
  --     fraction of the unit thrown away, with the reason. See
  --     src/services/portions.ts.
  SELECT
    'opened_finished',
    o.id,
    o.finished_at,
    ${BIZ_DATE("o.finished_at")},
    'ingredient',
    o.stock_item_id,
    COALESCE(si.name, 'Deleted item'),
    COALESCE(si.unit, ''),
    'opened_finished',
    'info',
    CASE WHEN o.finish_reason = 'manual' THEN ROUND(o.remaining, 3) END,
    CASE WHEN o.finish_reason = 'manual'
      THEN 'Finished early, ' || ROUND(o.remaining, 3) || ' of ' || ROUND(COALESCE(o.size, 1), 3) || COALESCE(' ' || NULLIF(si.unit, ''), '') || ' left — ' || COALESCE(o.finish_note, '')
      ELSE 'Used up by sales'
    END,
    'Opened ' || o.opened_at,
    u.full_name,
    NULL,
    NULL
  FROM opened_stock_units o
  LEFT JOIN stock_items si ON si.id = o.stock_item_id
  LEFT JOIN users u ON u.id = o.finished_by
  WHERE o.status = 'finished' AND o.finished_at IS NOT NULL

  UNION ALL

  -- 2f. A sale's packing that was not on record (src/services/packing.ts): the
  --     sale took what was recorded and went through anyway, so the shortfall
  --     itself moved nothing — an 'info' row per packing item, so a count that
  --     is wrong shows up where the owner looks. source_id is the log row id
  --     scaled with the item's position, unique per row.
  SELECT
    'packing_shortfall',
    al.id * 1000 + j.key,
    al.created_at,
    ${BIZ_DATE("al.created_at")},
    'ingredient',
    CAST(json_extract(j.value, '$.stock_item_id') AS INTEGER),
    COALESCE(si.name, json_extract(j.value, '$.name'), 'Deleted item'),
    COALESCE(si.unit, ''),
    'packing_shortfall',
    'info',
    json_extract(j.value, '$.short'),
    'Not on record: ' || json_extract(j.value, '$.needed') || ' needed, only '
      || json_extract(j.value, '$.taken') || ' recorded. Count it.',
    'Bill #' || COALESCE(json_extract(al.details, '$.token'), '?'),
    u.full_name,
    NULL,
    NULL
  FROM activity_log al
  JOIN json_each(al.details, '$.items') j
  LEFT JOIN stock_items si ON si.id = CAST(json_extract(j.value, '$.stock_item_id') AS INTEGER)
  LEFT JOIN users u ON u.id = al.user_id
  WHERE al.action = 'packing_shortfall'
`;

// --- Stock after each movement ---------------------------------------------
// No source stores "how much was left after this", so it is WORKED BACK from
// what is on hand now: walk an item's movements newest-first and undo each one.
//
//   stock_after(row) = on_hand_now − (sum of the signed changes of every
//                                     NEWER movement of the same item)
//
// That is exact for as long as every change is in the timeline. It is not, for
// older product history: before Oct 2026 a product's count could be changed
// from its edit form with no record at all (it was how stock was set). Walking
// back across such a silent change makes every row older than it wrong, and
// with no record nothing can say where it happened.
//
// Two things keep that honest:
//   1. ANCHORS. Rows that RECORD the exact figure left restart the walk:
//        - a stock count ('counted_product_stock' → details.counted), and
//        - a restock/opening stock logged with details.new_quantity (the old
//          restock endpoint did not write it; those rows are plain movements).
//      anchor_grp numbers the anchors newest to oldest. Group 0 is everything
//      newer than the newest anchor and starts from on-hand stock; group k
//      starts from anchor k's recorded figure. Either way the newer changes in
//      the group are undone, the anchor's own included, which is exactly
//      "stock before the anchor" for the row just older than it.
//   2. A CHECK between anchors. Walking all the way through group k must land
//      on the figure anchor k+1 recorded. If it does not, something changed in
//      that stretch without a record, so every row in it except group k's own
//      anchor (whose figure is recorded, so exact) is flagged
//      stock_after_approx = 1 and the page shows it as "≈". The oldest stretch
//      has no older anchor to check against and is left unflagged.
//
// Computed over the WHOLE timeline, before the page's filters and paging, so a
// filtered or second-page view shows the same figure as the full list. Info
// rows change nothing and show the level they happened at; the refund note has
// no item, and an untracked product has no meaningful count, so both are NULL.
// The ordering is the display ordering, so "newer" means "above it on screen".
const STOCK_AFTER_ORDER = "occurred_at DESC, source ASC, source_id DESC";
const WITH_STOCK_AFTER_SQL = `
  WITH moves AS (
    SELECT u.*,
           CASE u.direction WHEN 'in' THEN u.quantity WHEN 'out' THEN -u.quantity ELSE 0 END AS delta
    FROM (${UNIFIED_SQL}) u
  ),
  grouped AS (
    SELECT moves.*,
           SUM(CASE WHEN anchor_after IS NOT NULL THEN 1 ELSE 0 END)
             OVER (PARTITION BY item_kind, item_id ORDER BY ${STOCK_AFTER_ORDER} ROWS UNBOUNDED PRECEDING) AS anchor_grp
    FROM moves
  ),
  walked AS (
    SELECT grouped.*,
           FIRST_VALUE(anchor_after) OVER grp AS grp_anchor,
           COALESCE(SUM(delta) OVER (grp ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS newer_delta,
           SUM(delta) OVER (PARTITION BY item_kind, item_id, anchor_grp) AS grp_total,
           CASE item_kind
             WHEN 'product' THEN (SELECT CASE WHEN p.track_stock = 1 THEN p.stock_quantity END FROM products p WHERE p.id = grouped.item_id)
             WHEN 'ingredient' THEN (SELECT si.quantity FROM stock_items si WHERE si.id = grouped.item_id)
           END AS on_hand_now
    FROM grouped
    WINDOW grp AS (PARTITION BY item_kind, item_id, anchor_grp ORDER BY ${STOCK_AFTER_ORDER})
  ),
  started AS (
    SELECT walked.*,
           CASE WHEN anchor_grp = 0 THEN on_hand_now ELSE grp_anchor END AS grp_start
    FROM walked
  ),
  -- One row per stretch: where its walk starts, and where it ends up after
  -- undoing every change in it (the predicted figure for the next anchor).
  stretches AS (
    SELECT DISTINCT item_kind, item_id, anchor_grp, grp_anchor, grp_start - grp_total AS predicted_next
    FROM started
  )
  SELECT s.source, s.source_id, s.occurred_at, s.business_date, s.item_kind, s.item_id, s.item_name, s.unit,
         s.movement_type, s.direction, s.quantity, s.note, s.reference, s.user_name, s.cost_loss,
         CASE
           WHEN s.item_id IS NULL OR s.on_hand_now IS NULL THEN NULL
           ELSE ROUND(s.grp_start - s.newer_delta, 3)
         END AS stock_after,
         CASE
           WHEN s.item_id IS NULL OR s.on_hand_now IS NULL THEN 0
           WHEN s.anchor_after IS NOT NULL AND s.anchor_grp > 0 THEN 0
           WHEN nxt.anchor_grp IS NOT NULL AND ABS(cur.predicted_next - nxt.grp_anchor) > 0.0005 THEN 1
           ELSE 0
         END AS stock_after_approx
  FROM started s
  JOIN stretches cur
    ON cur.item_kind = s.item_kind AND cur.item_id IS s.item_id AND cur.anchor_grp = s.anchor_grp
  LEFT JOIN stretches nxt
    ON nxt.item_kind = s.item_kind AND nxt.item_id IS s.item_id AND nxt.anchor_grp = s.anchor_grp + 1
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
  // so paging can never repeat or skip a row. Read through WITH_STOCK_AFTER_SQL
  // so each row carries stock_after (see above); the count stays on the plain
  // union, which has the same rows and does not need the window functions.
  const rows = db
    .query(
      `SELECT * FROM (${WITH_STOCK_AFTER_SQL}) ${filters.where}
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
