import { getDb } from "./database";

export function runMigrations(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier' CHECK(role IN ('admin', 'cashier')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category_id INTEGER REFERENCES stock_categories(id),
      unit TEXT NOT NULL DEFAULT 'pcs',
      quantity REAL NOT NULL DEFAULT 0,
      reorder_level REAL NOT NULL DEFAULT 0,
      cost_per_unit REAL NOT NULL DEFAULT 0,
      expiry_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
      type TEXT NOT NULL CHECK(type IN ('purchase', 'usage', 'adjustment', 'waste')),
      quantity REAL NOT NULL,
      reference TEXT,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      cost_price REAL NOT NULL DEFAULT 0,
      selling_price REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
      quantity_needed REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_number INTEGER NOT NULL,
      bill_date TEXT NOT NULL DEFAULT (date('now')),
      customer_id INTEGER REFERENCES customers(id),
      subtotal REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'cash' CHECK(payment_method IN ('cash', 'card', 'upi')),
      status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed', 'cancelled', 'refunded')),
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL,
      total REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expense_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER REFERENCES expense_categories(id),
      amount REAL NOT NULL,
      description TEXT,
      expense_date TEXT NOT NULL DEFAULT (date('now')),
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS income (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      income_date TEXT NOT NULL DEFAULT (date('now')),
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_task_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES daily_tasks(id) ON DELETE CASCADE,
      business_date TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      notes TEXT,
      completed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(task_id, business_date)
    );

    CREATE TABLE IF NOT EXISTS product_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      component_product_id INTEGER NOT NULL REFERENCES products(id),
      quantity REAL NOT NULL DEFAULT 1,
      UNIQUE(product_id, component_product_id)
    );

    CREATE TABLE IF NOT EXISTS product_disposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity REAL NOT NULL,
      cost_loss REAL NOT NULL DEFAULT 0,
      reason TEXT,
      business_date TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity REAL NOT NULL,
      cart_id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_stock_reservations_cart ON stock_reservations(cart_id);
    CREATE INDEX IF NOT EXISTS idx_stock_reservations_product ON stock_reservations(product_id);

    -- Which till still claims which cart. Holds never expire (a cart only
    -- exists once the customer has confirmed the order), so the admin "Held
    -- stock" screen could see a hold but never tell these two apart:
    --   * a PARKED cart, which legitimately keeps its hold — and because
    --     parking rotates the till to a fresh cart id, its hold looks like
    --     "some other cart" even on the same machine;
    --   * a STRANDED hold, whose cart no longer exists anywhere (closed till,
    --     cleared browser storage, or a hold predating cart persistence).
    -- Parked carts live only in each browser's localStorage, so the server can
    -- only learn about them if the till says so: POST /api/pos/carts/claim.
    --
    -- cart_id is UNIQUE: one cart is claimed by at most one till, and that is
    -- also the lookup index the holds listing joins on. The claim is purely an
    -- annotation on stock_reservations — it never holds stock itself, and it is
    -- self-asserted by the till, so it must never be read as an authorisation.
    CREATE TABLE IF NOT EXISTS cart_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cart_id TEXT NOT NULL UNIQUE,
      till_id TEXT NOT NULL,
      till_label TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL CHECK(state IN ('active', 'parked')),
      user_id INTEGER REFERENCES users(id),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Claiming is a full replace per till ("these are ALL my carts"), which
    -- deletes the till's previous rows on every heartbeat, so that DELETE needs
    -- an index. cart_id's UNIQUE constraint already indexes the other lookup.
    CREATE INDEX IF NOT EXISTS idx_cart_claims_till ON cart_claims(till_id);

    -- Parked bills ("held carts"): a confirmed customer order the cashier has
    -- set aside to serve someone else. These used to live ONLY in the parking
    -- browser's localStorage (kuki_held_carts) while the stock hold they own
    -- lives here, shop-wide — so the hold was durable and global while the order
    -- that justified it was fragile and local: invisible from every other till,
    -- and permanently lost (hold included, standing forever) if that tablet was
    -- wiped or replaced. The order now lives on the server beside its hold.
    --
    -- cart_id is UNIQUE: one parked bill per cart, which makes re-parking the
    -- same cart an upsert instead of a duplicate, makes resume/discard a lookup
    -- by cart id, and is the key the holds listing joins on.
    --
    -- items is the cart lines as JSON text — the same shape the till sends and
    -- receives, [{ product_id, product_name, quantity, unit_price,
    -- original_price }]. JSON, not a child table: this is a snapshot of an
    -- unsold cart that is only ever read and written whole (never joined,
    -- aggregated or reported on), and it must keep the prices as quoted to the
    -- customer even if the product's price changes while the bill is parked.
    -- The real line items become rows in bill_items when the sale completes.
    --
    -- customer_id is nullable and customer_label is kept alongside it so a
    -- parked order still names its customer even if that customer row is gone.
    -- created_at is when the order was first parked (an upsert keeps it, so the
    -- "parked at" time the cashier sees does not jump); updated_at moves on
    -- every re-park.
    CREATE TABLE IF NOT EXISTS parked_carts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cart_id TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      items TEXT NOT NULL DEFAULT '[]',
      customer_id INTEGER REFERENCES customers(id),
      customer_label TEXT NOT NULL DEFAULT '',
      discount REAL NOT NULL DEFAULT 0,
      user_id INTEGER REFERENCES users(id),
      till_id TEXT,
      till_label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- The listing is "every parked bill, newest first" (any till may resume any
    -- of them), so created_at is what it orders on. cart_id's UNIQUE constraint
    -- already indexes the by-cart lookups that resume, discard, the completed
    -- sale and the holds listing all use.
    CREATE INDEX IF NOT EXISTS idx_parked_carts_created ON parked_carts(created_at DESC);

    CREATE TABLE IF NOT EXISTS cash_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      count_type TEXT NOT NULL CHECK(count_type IN ('open', 'close')),
      count_date TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      notes_20 INTEGER NOT NULL DEFAULT 0,
      notes_50 INTEGER NOT NULL DEFAULT 0,
      notes_100 INTEGER NOT NULL DEFAULT 0,
      notes_500 INTEGER NOT NULL DEFAULT 0,
      notes_1000 INTEGER NOT NULL DEFAULT 0,
      notes_2000 INTEGER NOT NULL DEFAULT 0,
      notes_5000 INTEGER NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      expected_amount REAL,
      variance REAL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- --- Pre-orders -------------------------------------------------------
    -- A customer orders ahead: a custom birthday cake described in words,
    -- and/or bulk savoury items off the product list, for collection on a
    -- future date, usually leaving a deposit.
    --
    -- A pre-order RESERVES NO STOCK, on purpose. A cake due next Saturday must
    -- not lock today's shelf, so there is deliberately no row written to
    -- stock_reservations here and no link to one. Stock moves exactly once, at
    -- collection, when the order is rung up as an ordinary bill -- see the
    -- collect route in src/routes/preorders.ts.
    --
    -- customer_id is NOT NULL and a real foreign key: there are no walk-in
    -- pre-orders. Somebody has to be phoned if the cake is late, so the order
    -- must point at a customer row that already exists.
    --
    -- collection_date is a BUSINESS date ('YYYY-MM-DD', the same convention as
    -- bills.bill_date / todayDate()), never a timestamp: the production list is
    -- "what leaves the shop today". collection_time is free text and nullable
    -- because "morning" or "after 4" is what customers actually say.
    --
    -- total is a STORED CACHE of SUM(quantity * unit_price) over
    -- pre_order_items, rewritten by the server every time the lines change and
    -- never taken from a client. It exists so the listing can show money
    -- without aggregating the children for every row; pre_order_items stays the
    -- source of truth, and nothing reads the cached total to decide what to charge.
    --
    -- bill_id is NULL until collection, then points at the one bill that sold
    -- this order. That link is what makes the pair idempotent: see the UNIQUE
    -- index below, and the bills(cart_id, cart_fingerprint) guard that backs it.
    CREATE TABLE IF NOT EXISTS pre_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      collection_date TEXT NOT NULL,
      collection_time TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'taken' CHECK(status IN ('taken', 'ready', 'collected', 'cancelled')),
      total REAL NOT NULL DEFAULT 0,
      user_id INTEGER REFERENCES users(id),
      bill_id INTEGER REFERENCES bills(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- The production view ("what is due today / this week") is the single most
    -- frequent read, and it filters on collection_date alone or on
    -- collection_date + status ("still owed to a customer"), so both are
    -- indexed. The composite is status-first because status is the equality
    -- term and collection_date the range term.
    CREATE INDEX IF NOT EXISTS idx_pre_orders_collection_date ON pre_orders(collection_date);
    CREATE INDEX IF NOT EXISTS idx_pre_orders_status_date ON pre_orders(status, collection_date);
    CREATE INDEX IF NOT EXISTS idx_pre_orders_customer ON pre_orders(customer_id);

    -- One bill can settle at most one pre-order. Partial (WHERE bill_id IS NOT
    -- NULL) because every uncollected order carries NULL and those must not
    -- collide, and because it doubles as the "which order did this bill
    -- settle?" lookup, which only ever searches non-NULL values. It is the
    -- database's last word; the real guarantee against two bills for one order
    -- is in POST /:id/collect, which re-reads the order's status, writes the
    -- bill and marks the order collected in ONE immediate transaction. A second
    -- Collect - a double tap, or a second till with a different payment method
    -- (and so a different bills.cart_fingerprint, which the bills index would
    -- NOT catch) - therefore finds the order already 'collected' and gets a 409
    -- carrying the first bill, and a crash part-way leaves neither a bill nor a
    -- link behind.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pre_orders_bill ON pre_orders(bill_id) WHERE bill_id IS NOT NULL;

    -- A line is EITHER a catalogue product OR a free-text custom line, and both
    -- kinds live in one order ("one 2kg chocolate cake + 50 fish buns").
    --
    -- product_id nullable is the whole point. A custom cake is not in the
    -- catalogue and must never be added to it just to be sold once: it has no
    -- recipe, no cost price and no stock. So product_id IS NULL and description
    -- carries the agreed specification in the customer's own words ("2kg
    -- chocolate cake, butterscotch filling, Happy Birthday Amal"), with its own
    -- negotiated unit_price.
    --
    -- description is NOT NULL for BOTH kinds: for a catalogue line it is the
    -- product name as quoted to the customer, snapshotted here so the order
    -- still reads correctly if the product is later renamed, discontinued or
    -- repriced -- the same reasoning as bill_items.product_name.
    --
    -- unit_price is stored per line rather than read from the product at
    -- collection because bulk is negotiated at this counter: 50 fish buns at an
    -- agreed rate is the normal case, and the price the customer was quoted
    -- weeks ago is the price they must be charged.
    --
    -- quantity is INTEGER to match bill_items.quantity, which these lines
    -- become. Weight lives in the description ("2kg chocolate cake"), not in
    -- the quantity: the shop sells one cake, not two kilograms of cake.
    CREATE TABLE IF NOT EXISTS pre_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pre_order_id INTEGER NOT NULL REFERENCES pre_orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      description TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0),
      unit_price REAL NOT NULL DEFAULT 0 CHECK(unit_price >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_pre_order_items_order ON pre_order_items(pre_order_id);

    -- Deposits and later top-ups: part-payment taken BEFORE collection.
    --
    -- A table, not a column on pre_orders, for two reasons the shop actually
    -- runs into. First, the close-of-day cash reconciliation needs deposits BY
    -- DATE: a deposit is cash in the drawer that is not a sale, so the drawer
    -- cannot be reconciled from one running "deposit_paid" figure that says
    -- nothing about when the money arrived. Second, customers top up -- half
    -- now, the rest on Friday, the balance on collection -- and each of those
    -- is its own event with its own date, method and cashier.
    --
    -- paid_on is the BUSINESS date (todayDate()), which is what a deposits
    -- report groups by; created_at is the wall clock, which is what a shift
    -- that spans midnight compares against (see src/routes/cash.ts).
    --
    -- Rows here are ONLY pre-collection payments. The balance taken at the till
    -- on collection day is recorded by the BILL and never duplicated here --
    -- that is what stops the deposit being counted twice.
    CREATE TABLE IF NOT EXISTS pre_order_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pre_order_id INTEGER NOT NULL REFERENCES pre_orders(id) ON DELETE CASCADE,
      amount REAL NOT NULL CHECK(amount > 0),
      payment_method TEXT NOT NULL DEFAULT 'cash' CHECK(payment_method IN ('cash', 'card', 'upi')),
      paid_on TEXT NOT NULL DEFAULT (date('now')),
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- paid_on: the cash reconciliation line and any "deposits taken" report.
    -- pre_order_id: the balance of one order, read on every order screen.
    CREATE INDEX IF NOT EXISTS idx_pre_order_payments_paid_on ON pre_order_payments(paid_on);
    CREATE INDEX IF NOT EXISTS idx_pre_order_payments_order ON pre_order_payments(pre_order_id);
  `);

  // Incremental migrations for existing databases
  const addColumn = (table: string, column: string, type: string) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch {
      // Column already exists
    }
  };
  addColumn("products", "cost_price", "REAL NOT NULL DEFAULT 0");
  addColumn("bill_items", "cost_price", "REAL NOT NULL DEFAULT 0");
  addColumn("bills", "refund_reason", "TEXT");
  addColumn("bills", "refunded_at", "TEXT");
  addColumn("bills", "refunded_by_user_id", "INTEGER");
  addColumn("products", "discount_price", "REAL");
  addColumn("bill_items", "original_price", "REAL");
  addColumn("bills", "amount_given", "REAL");
  addColumn("bills", "change_given", "REAL");
  addColumn("expenses", "status", "TEXT NOT NULL DEFAULT 'approved'");
  addColumn("expenses", "payment_source", "TEXT NOT NULL DEFAULT 'cash'");
  addColumn("expenses", "approved_by_user_id", "INTEGER");
  addColumn("expenses", "approved_at", "TEXT");
  addColumn("expenses", "rejected_reason", "TEXT");
  addColumn("daily_tasks", "category", "TEXT NOT NULL DEFAULT 'opening'");
  addColumn("products", "track_stock", "INTEGER NOT NULL DEFAULT 0");
  addColumn("products", "stock_quantity", "REAL NOT NULL DEFAULT 0");
  addColumn("products", "stock_reorder_level", "REAL NOT NULL DEFAULT 0");
  // Discontinued: permanently off the menu, kept only because history (past
  // bills / disposals) points at the row. Distinct from is_active = 0, which
  // means "temporarily off the menu". Added as a column, never by rebuilding
  // the table — production carries real sales data on a fly.io volume.
  addColumn("products", "is_discontinued", "INTEGER NOT NULL DEFAULT 0");
  // When this product's stock_quantity last changed (UTC, datetime('now')).
  // stock_items already carry updated_at; products had no equivalent, so there
  // was no way to tell "ran out today" from "ran out weeks ago". Nullable on
  // purpose: every row that exists before this migration gets NULL, and NULL
  // means "we do not know when it ran out" — which is treated as NOT today,
  // because if we cannot show a date we must not claim it happened today.
  // Added as a column, never by rebuilding the table (production data lives on
  // a fly.io volume).
  addColumn("products", "stock_updated_at", "TEXT");
  // The till's cart id, carried onto the bill it became. HALF of the server's
  // idempotency key for checkout; bills.cart_fingerprint below is the other
  // half. A cart id is minted per customer and the till rotates to a fresh one
  // when a sale completes (startNewCart() in views/pos.html) — but ONLY on a
  // successful response, so a response lost to flaky wifi, a cold start or a
  // closed tab leaves the till on the old id and the NEXT customer's sale
  // arrives under it. The cart id alone therefore cannot mean "this is the same
  // sale". See createBill() in src/services/billing.ts.
  //
  // Nullable on purpose: every row that exists before this migration gets NULL,
  // and a caller that sends no cart_id still bills normally (NULL = "no key, no
  // dedupe"). Added as a column, never by rebuilding the table — production data
  // lives on a fly.io volume.
  addColumn("bills", "cart_id", "TEXT");
  // A hash of WHAT WAS SOLD: the lines (product, name, quantity, unit price,
  // original price), the customer, the discount, the resolved tax rate, the
  // payment method and the cash tendered. Built by saleFingerprint() in
  // src/services/billing.ts, which is the one definition of it.
  //
  // This is what makes the idempotency key identify the SALE and not merely the
  // cart. Two submissions under the same cart id replay each other only when
  // they are the same sale; a different sale that happens to arrive under a
  // stale cart id hashes differently and is billed normally instead of being
  // silently swallowed (which is how real takings were lost).
  //
  // Nullable on purpose, and that nullability is deliberate migration safety:
  // every bill written BEFORE this migration has a cart_id but no fingerprint,
  // and in SQLite a NULL in an indexed column makes a row distinct from every
  // other row, so those legacy rows can never collide with one another nor
  // block a new bill under the same cart id. Every bill written AFTER it always
  // carries a fingerprint whenever it carries a cart id (createBill() computes
  // one unconditionally), so the pair-uniqueness below is fully effective going
  // forward. Added as a column, never by rebuilding the table.
  addColumn("bills", "cart_fingerprint", "TEXT");
  // The hard guarantee behind the replay check in createBill(): the database
  // itself refuses a second bill for the same CART ID AND SALE CONTENTS.
  //
  // This replaces idx_bills_cart_id, which covered bills(cart_id) alone and so
  // made a second bill under a reused cart id physically impossible even when
  // it was a genuinely different sale. It is dropped first — dropping and
  // recreating an INDEX rewrites no table data, so it is safe on the live
  // volume — and the drop/create pair is idempotent, so restarting the server
  // simply finds the new index already there.
  //
  // Still PARTIAL (WHERE cart_id IS NOT NULL) for the same two reasons as
  // before:
  //   1. NULLs. Bills with no cart id (legacy rows, and any caller that sends
  //      no key) stay out of the index entirely rather than relying on
  //      SQLite's NULLs-are-distinct rule to keep them from colliding.
  //   2. It doubles as the lookup index for both "has this cart already billed
  //      THIS sale?" (cart_id + cart_fingerprint) and "has this cart billed at
  //      all?" (cart_id, a prefix of the same index) — SQLite uses it for both,
  //      and neither query ever searches a NULL cart_id.
  // Wrapped, and loud if it fails: billing must not be dead on startup, but a
  // missing guarantee must not be silent either (createBill() still checks
  // in-transaction, which covers this single-process deployment on its own).
  try {
    db.exec("DROP INDEX IF EXISTS idx_bills_cart_id");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_cart_sale ON bills(cart_id, cart_fingerprint) WHERE cart_id IS NOT NULL"
    );
  } catch (err: any) {
    console.error(
      "[migration] could not create UNIQUE index idx_bills_cart_sale on bills(cart_id, cart_fingerprint) — duplicate-bill protection falls back to the in-transaction check only:",
      err?.message || err
    );
  }

  // One-shot: merge product categories that differ only by casing.
  // For each lowercase key, pick the most common casing as canonical.
  try {
    const rows = db.query(
      "SELECT category, COUNT(*) as n FROM products WHERE category IS NOT NULL GROUP BY category"
    ).all() as { category: string; n: number }[];
    const byKey: Record<string, { category: string; n: number }> = {};
    for (const r of rows) {
      const key = r.category.trim().toLowerCase();
      if (!byKey[key] || byKey[key].n < r.n) byKey[key] = { category: r.category.trim(), n: r.n };
    }
    for (const r of rows) {
      const key = r.category.trim().toLowerCase();
      const canonical = byKey[key].category;
      if (r.category !== canonical) {
        db.query("UPDATE products SET category = ? WHERE category = ?").run(canonical, r.category);
      }
    }
  } catch {
    // Silent — fine if products table is empty or anything odd.
  }

  // ── fix/labels-inputs ──────────────────────────────────────────────────────
  // One-shot: the shop trades in LKR, but seedDefaults() used to seed the
  // currency symbol as the Indian rupee sign. Existing installs got that wrong
  // default, so swap it for "Rs." — but only when it is still exactly the old
  // seeded value, never overwriting a symbol the owner chose in Settings.
  // Idempotent: once converted the WHERE no longer matches.
  try {
    db.query("UPDATE settings SET value = 'Rs.' WHERE key = 'currency_symbol' AND value = '₹'").run();
  } catch {
    // Silent — settings table always exists by now; nothing to recover anyway.
  }

  // ===== fix/till =====================================================
  // One-shot: the receipt footer's phone number moves into Settings.
  //
  // buildReceiptText() (src/services/printer.ts) used to print a hard-coded
  // "+94 76 565 2881" as the slip's last line, whatever settings.shop_phone
  // said. It now prints settings.shop_phone instead — so a shop whose setting
  // is blank would silently lose the number from every receipt. Copy the old
  // hard-coded number in wherever the setting is missing or blank.
  //
  // ONCE, not on every boot: a marker row records that it ran. Without it, an
  // owner who deliberately blanks the number in Settings would have it put
  // back by the next restart. The upsert also covers a brand-new database,
  // where this runs before seedDefaults() has created the shop_phone row at
  // all (seedDefaults() then leaves it alone: INSERT OR IGNORE). Both writes
  // in one transaction, so a failure leaves neither behind and the next boot
  // simply tries again.
  try {
    const done = db.query("SELECT 1 FROM settings WHERE key = 'migration_fix_till_shop_phone'").get();
    if (!done) {
      db.transaction(() => {
        db.query(
          "INSERT INTO settings (key, value) VALUES ('shop_phone', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE trim(settings.value) = ''"
        ).run("+94 76 565 2881");
        db.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('migration_fix_till_shop_phone', '1')").run();
      })();
    }
  } catch (err: any) {
    console.error("[migration] fix/till: could not default settings.shop_phone:", err?.message || err);
  }

  // ---------------------------------------------------------------------------
  // fix/preorders — what a collection bill had already been paid, and what
  // happened to the deposit of a cancelled order.
  // ---------------------------------------------------------------------------
  // bills.paid_in_advance: on a pre-order's collection bill, the deposits taken
  // BEFORE collection (the same figure the collect route subtracts to get
  // cash_to_collect). The bill itself records the FULL sale, so without this the
  // bill alone cannot say how much of it changed hands at the till: a reprint
  // could not print "Paid in advance / Balance", and a report splitting the
  // day's takings by method would count the deposit twice (once on the day it
  // was taken, again inside this bill's total). 0 for every ordinary sale.
  // The exact declaration is shared with the reports branch, which adds the
  // identical line; addColumn() swallows the second ALTER, so they cannot fight.
  addColumn("bills", "paid_in_advance", "REAL NOT NULL DEFAULT 0");
  // One-shot backfill for collection bills written before the column existed.
  // Only rows still at 0 and actually linked from a pre-order are touched, and
  // the figure is recomputed from pre_order_payments, which holds pre-collection
  // payments only (see that table's comment) — so re-running it is a no-op.
  try {
    db.exec(`
      UPDATE bills SET paid_in_advance = (
        SELECT COALESCE(SUM(pop.amount), 0)
        FROM pre_orders po JOIN pre_order_payments pop ON pop.pre_order_id = po.id
        WHERE po.bill_id = bills.id
      )
      WHERE paid_in_advance = 0
        AND id IN (SELECT bill_id FROM pre_orders WHERE bill_id IS NOT NULL)
    `);
  } catch (err: any) {
    console.error("[migration] paid_in_advance backfill failed:", err?.message || err);
  }

  // The deposit of a CANCELLED pre-order. Cancelling used to leave it in limbo:
  // the screen said "pay it back as a cash expense" (which wrongly cut profit),
  // a deposit the customer forfeited never became income, and money owed back
  // simply vanished. Now cancelling an order that has payments must settle them
  // one of two ways, recorded here:
  //   deposit_outcome         'refunded' | 'kept'; NULL when there was nothing
  //                           to settle (or for orders cancelled before this).
  //   deposit_settled_amount  what was refunded / kept: the order's payments at
  //                           the moment of cancelling.
  //   deposit_refund_method   cash | card | upi, refunds only. A CASH refund is
  //                           money leaving the drawer, which the cash shift
  //                           subtracts (getDepositsRefundedSince in
  //                           src/routes/cash.ts) — not an expense, not income.
  //   deposit_settled_at      UTC datetime('now'), what a shift window compares.
  //   deposit_settled_by      users.id of the admin who cancelled.
  // A KEPT deposit is written to the income table as well, so it appears in the
  // existing income reports without any report knowing about pre-orders.
  addColumn("pre_orders", "deposit_outcome", "TEXT");
  addColumn("pre_orders", "deposit_settled_amount", "REAL");
  addColumn("pre_orders", "deposit_refund_method", "TEXT");
  addColumn("pre_orders", "deposit_settled_at", "TEXT");
  addColumn("pre_orders", "deposit_settled_by", "INTEGER");

  // --- fix/stock-refunds ---------------------------------------------------
  // Whether a refund put the bill's items back into stock. A refund used to
  // restore stock unconditionally; now the cashier chooses ("Put items back
  // into stock", off by default — a returned cake usually goes in the bin, not
  // back on the shelf), and POST /api/pos/bills/:id/refund records the choice
  // here. 1 = stock was restored, 0 = it was not (or the bill is not refunded).
  // The reports branch adds this identical line and reads it; addColumn is a
  // no-op for whichever runs second. Added as a column, never by rebuilding the
  // table.
  addColumn("bills", "refund_restocked", "INTEGER NOT NULL DEFAULT 0");
  // Backfill: every refund made BEFORE the choice existed did restore stock, so
  // those bills must read 1, not the column default. They are recognised by
  // their 'refunded_bill' log row, which predates the 'restock' key — every
  // refund from now on writes that key, true or false. Idempotent: it only ever
  // touches legacy rows still at 0, so running it on every boot is harmless.
  try {
    db.exec(`
      UPDATE bills SET refund_restocked = 1
      WHERE status = 'refunded' AND refund_restocked = 0
        AND id IN (
          SELECT CAST(json_extract(details, '$.bill_id') AS INTEGER) FROM activity_log
          WHERE action = 'refunded_bill' AND json_extract(details, '$.restock') IS NULL
        )
    `);
  } catch (err: any) {
    console.error("[migration] could not backfill bills.refund_restocked for legacy refunds:", err?.message || err);
  }

  // --- fix/cash-reports ----------------------------------------------------
  // Coins in the drawer. The count only ever had Rs 20–5000 note rows, so every
  // coin in the till was either left out of the count (a phantom shortage at
  // close) or folded into a note row by guesswork. One running total rather
  // than a row per coin: nobody counts Rs 1 coins one by one at closing time,
  // they bag or weigh them. Counts saved before this had no coins, hence 0.
  addColumn("cash_counts", "coins_total", "REAL NOT NULL DEFAULT 0");
  // The two lines below are IDENTICAL to ones another branch adds; addColumn()
  // swallows "duplicate column", so whichever branch lands second is a no-op.
  // They are here because the reports in this branch read them:
  //   refund_restocked — 1 when the refund put the bill's items back into
  //     stock. Only then does the item cost come back off cost of goods on the
  //     refund day; otherwise the cake is gone and its cost stays a cost.
  //   paid_in_advance — the part of a pre-order collection bill that was paid
  //     as deposits before collection day, so "money received by method" counts
  //     only the balance under the bill's own day and method.
  addColumn("bills", "refund_restocked", "INTEGER NOT NULL DEFAULT 0");
  addColumn("bills", "paid_in_advance", "REAL NOT NULL DEFAULT 0");

  // --- fix/post-merge ------------------------------------------------------
  // 1 when the bill moved no stock at all: createBill() was called with
  // skip_stock (a pre-order collection; pre-ordered goods are never stock).
  // Stock History reads it so such a bill never shows as stock leaving. Every
  // existing row gets 0, which is right: before skip_stock existed, collections
  // went through the ordinary stock deduction like any other sale.
  addColumn("bills", "stock_skipped", "INTEGER NOT NULL DEFAULT 0");

  // Per-cashier choice, made by an admin on the Users page: may this cashier
  // see the day's money (sales, profit, expenses, money received) on the
  // dashboards? Default 0 = hidden, exactly how every cashier behaved before
  // the option existed. Admins always see it regardless (canSeeDashboardMoney).
  addColumn("users", "show_dashboard_money", "INTEGER NOT NULL DEFAULT 0");

  // --- feature/opened-ingredients-order-type --------------------------------
  // Dine-in or takeaway. Nullable on purpose: every bill written before the
  // choice existed gets NULL, which means "not recorded", never a guess. Every
  // bill written from now on carries one (createBill() resolves it, falling
  // back to settings.default_order_type). Added as a column, never by
  // rebuilding the table.
  addColumn("bills", "order_type", "TEXT CHECK(order_type IN ('dine_in', 'takeaway'))");
  // The same choice on a parked bill, so a dine-in order parked and resumed is
  // not billed as the default. NULL for bills parked before it existed; the
  // route stores only the two values, so no CHECK is needed here.
  addColumn("parked_carts", "order_type", "TEXT");

  db.exec(`
    -- "This product is made from an OPENED unit of that ingredient": a milk box
    -- makes 4 milkshakes. servings_per_unit is how many of the PRODUCT one unit
    -- of the ingredient (one box, one tub, in the stock item's own unit) makes.
    -- Unlike recipes (costing only), these links are enforced: a linked product
    -- can only be billed while an opened unit of every ingredient it is linked
    -- to has enough left. See src/services/portions.ts.
    --
    -- product_id cascades: the link is the product's own configuration. The
    -- stock item does not: deleting an ingredient that products are made from is
    -- refused with their names (src/routes/stock.ts), like a recipe.
    CREATE TABLE IF NOT EXISTS product_ingredient_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
      servings_per_unit REAL NOT NULL CHECK(servings_per_unit > 0),
      UNIQUE(product_id, stock_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_product_ingredient_links_item ON product_ingredient_links(stock_item_id);

    -- One opened unit of an ingredient: the box on the counter. Opening takes the
    -- unit out of stock_items.quantity (a 'usage' stock_transactions row), so
    -- stock_items.quantity is what is still SEALED. The three states the till
    -- shows are therefore: in stock (sealed, stock_items.quantity), 'opened' and
    -- 'finished' (rows here).
    --
    -- remaining is the FRACTION of the unit left, 1 at opening. A fraction, not
    -- a serving count, because one box can feed several products with different
    -- yields (4 milkshakes OR 8 iced coffees per box): each sale takes
    -- quantity / servings_per_unit of it. It is rounded to 6 places on every
    -- write and compared with a small tolerance (PORTION_EPSILON), so three
    -- thirds use up a box exactly.
    --
    -- finish_reason: 'used_up' when sales emptied it, 'manual' when someone
    -- marked it finished early (spilled, gone off) — remaining then keeps what
    -- was thrown away, which is what anyone later asks about.
    CREATE TABLE IF NOT EXISTS opened_stock_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'opened' CHECK(status IN ('opened', 'finished')),
      remaining REAL NOT NULL DEFAULT 1,
      opened_by INTEGER REFERENCES users(id),
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_by INTEGER REFERENCES users(id),
      finished_at TEXT,
      finish_reason TEXT CHECK(finish_reason IN ('used_up', 'manual')),
      finish_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_opened_stock_units_open ON opened_stock_units(stock_item_id, status);

    -- Which sale used how much of which opened unit. History only: nothing reads
    -- it to decide anything, it answers "why is this box finished already?".
    -- product_id is a plain integer (no foreign key) with the name kept beside
    -- it, so this history never stops a product from being deleted.
    CREATE TABLE IF NOT EXISTS opened_unit_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opened_unit_id INTEGER NOT NULL REFERENCES opened_stock_units(id) ON DELETE CASCADE,
      bill_id INTEGER REFERENCES bills(id),
      product_id INTEGER,
      product_name TEXT NOT NULL DEFAULT '',
      quantity REAL NOT NULL,
      fraction REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_opened_unit_usage_unit ON opened_unit_usage(opened_unit_id);

    -- Packing a product uses up: a cake box, a cup and lid, a napkin. quantity is
    -- per unit of the product sold. applies_to says when: 'takeaway' (only on a
    -- takeaway bill — a dine-in milkshake goes in a glass) or 'always'. Deducted
    -- from stock_items at checkout by src/services/packing.ts. Same cascade rule
    -- as the ingredient links above.
    CREATE TABLE IF NOT EXISTS product_packing_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
      quantity REAL NOT NULL CHECK(quantity > 0),
      applies_to TEXT NOT NULL DEFAULT 'takeaway' CHECK(applies_to IN ('takeaway', 'always')),
      UNIQUE(product_id, stock_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_product_packing_links_item ON product_packing_links(stock_item_id);
  `);

  // --- feature/stock-sync-cash-close -----------------------------------------
  // Closing the cash drawer now has two gates (src/services/closing.ts):
  //   1. A STOCK SYNC for the shift: everything with stock above 0 counted. A
  //      count that differs from the system needs an admin's approval before
  //      the stock is changed and the drawer may close. Any stock movement after
  //      the sync settles means syncing again.
  //   2. A drawer VARIANCE above settings.cash_variance_limit (either way) needs
  //      an admin's approval before the close is accepted.
  // An admin approves from their own login, or by typing their password at the
  // till; an admin's own sync or close needs no approval.
  db.exec(`
    -- One count of the shop's stock during a shift. shift_open_id is the
    -- cash_counts 'open' row, which is what "this shift" means everywhere else.
    -- status: matched (counts agreed, nothing to approve), pending (waiting for
    -- an admin), approved (an admin accepted the counts, possibly corrected,
    -- and stock was changed), rejected (count again), superseded (a newer sync
    -- replaced a pending one). settled_at is when it became matched/approved.
    -- settled_snapshot is every in-stock quantity at that moment (JSON,
    -- "product:12" / "ingredient:3" → qty): when the stock no longer equals it,
    -- something moved after the sync and the shift needs a new one. A snapshot,
    -- not a timestamp, because a sale in the same second as the sync must count.
    CREATE TABLE IF NOT EXISTS stock_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_open_id INTEGER NOT NULL REFERENCES cash_counts(id),
      user_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('matched', 'pending', 'approved', 'rejected', 'superseded')),
      mismatch_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      decision_note TEXT,
      settled_at TEXT,
      settled_snapshot TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stock_syncs_shift ON stock_syncs(shift_open_id, id);

    -- One counted item. system_qty is what the system said when the count was
    -- submitted; counted_qty what was counted; approved_qty what the admin
    -- accepted (the count, or their correction of it); applied_delta what was
    -- actually added to / taken off stock on approval. name/unit are copied so
    -- the record still reads after a rename or a delete.
    CREATE TABLE IF NOT EXISTS stock_sync_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id INTEGER NOT NULL REFERENCES stock_syncs(id) ON DELETE CASCADE,
      item_kind TEXT NOT NULL CHECK(item_kind IN ('product', 'ingredient')),
      item_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT '',
      system_qty REAL NOT NULL,
      counted_qty REAL NOT NULL,
      approved_qty REAL,
      applied_delta REAL
    );
    CREATE INDEX IF NOT EXISTS idx_stock_sync_lines_sync ON stock_sync_lines(sync_id);

    -- A cashier's request to close a drawer whose variance is over the limit.
    -- count_json is the count exactly as submitted (notes + coins), so the
    -- approved close is THAT count and nobody retypes it. expected_amount and
    -- variance are as of the request; the close refuses if the expected figure
    -- has moved since (money came in or went out after the admin looked).
    -- status: pending, approved, rejected, used (the close happened),
    -- superseded (a newer request replaced a pending one).
    CREATE TABLE IF NOT EXISTS cash_close_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_open_id INTEGER NOT NULL REFERENCES cash_counts(id),
      user_id INTEGER REFERENCES users(id),
      count_json TEXT NOT NULL,
      total_amount REAL NOT NULL,
      expected_amount REAL NOT NULL,
      variance REAL NOT NULL,
      notes TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'used', 'superseded')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      decision_note TEXT,
      used_close_id INTEGER REFERENCES cash_counts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cash_close_requests_shift ON cash_close_requests(shift_open_id, id);
  `);
  // Who let a close over the variance limit through (an admin closing it
  // themselves, an admin's password at the till, or an approved request), and
  // the stock sync it closed on. NULL for every close before this existed.
  addColumn("cash_counts", "variance_approved_by", "INTEGER");
  addColumn("cash_counts", "stock_sync_id", "INTEGER");

  // --- feature/daily-sync-selection ------------------------------------------
  // Which items the closing stock sync asks to be counted (listSyncItems):
  // only those "in the daily sync" with stock above 0. Two levels, both set by
  // an admin on the Stock page:
  //   * GROUPS (daily_sync_groups): a whole stock category, a whole product
  //     category, or every tracked product. A standing rule — an item added to
  //     a ticked group later is counted too.
  //   * the ITEM's own choice (daily_sync): NULL = follow its groups, 1 = always
  //     counted, 0 = never (e.g. one item left out of a ticked group).
  // The owner chose to start with nothing counted: every item NULL and no group
  // ticked. See PRODUCT_IN_SYNC / ITEM_IN_SYNC in src/services/closing.ts.
  addColumn("products", "daily_sync", "INTEGER");
  addColumn("stock_items", "daily_sync", "INTEGER");
  // One-time repair for a database made by an early build of this feature,
  // where daily_sync was NOT NULL DEFAULT 0. addColumn() cannot change an
  // existing column, and NOT NULL breaks "NULL = follow the group" (inserts
  // fail, and every 0 means "never"). Swap it for the nullable column, keeping
  // the 1s; the 0s become NULL, which is what they meant then ("not ticked").
  // Never touches a database where the column is already nullable — which is
  // every database this build creates, and production.
  for (const table of ["products", "stock_items"]) {
    try {
      const col = (db.query(`SELECT "notnull" AS nn FROM pragma_table_info('${table}') WHERE name = 'daily_sync'`).get() as any);
      if (!col || !col.nn) continue;
      db.transaction(() => {
        db.exec(`ALTER TABLE ${table} RENAME COLUMN daily_sync TO daily_sync_old`);
        db.exec(`ALTER TABLE ${table} ADD COLUMN daily_sync INTEGER`);
        db.exec(`UPDATE ${table} SET daily_sync = CASE WHEN daily_sync_old = 1 THEN 1 ELSE NULL END`);
        db.exec(`ALTER TABLE ${table} DROP COLUMN daily_sync_old`);
      })();
      console.log(`[migration] ${table}.daily_sync made nullable (follow-the-group)`);
    } catch (err: any) {
      console.error(`[migration] could not make ${table}.daily_sync nullable:`, err?.message || err);
    }
  }
  db.exec(`
    -- A ticked group. group_type: 'stock_category' (group_key = the
    -- stock_categories id, as text), 'product_category' (group_key = the
    -- product category name; matched without regard to case, like the
    -- category merge in this file), 'all_products' (group_key '').
    CREATE TABLE IF NOT EXISTS daily_sync_groups (
      group_type TEXT NOT NULL CHECK(group_type IN ('stock_category', 'product_category', 'all_products')),
      group_key TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_type, group_key)
    );
  `);

  // --- feature/refund-approval -----------------------------------------------
  // A cashier's refund needs an admin (see POST /api/pos/bills/:id/refund): the
  // admin's password at the till, or a request the admin approves from their
  // own login. Approving the request IS the refund. status: pending, approved,
  // rejected, cancelled (the bill was refunded some other way meanwhile).
  // restock is the cashier's "put items back into stock" choice, carried to
  // the refund as asked. Pending refunds block closing the drawer.
  db.exec(`
    CREATE TABLE IF NOT EXISTS refund_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER NOT NULL REFERENCES bills(id),
      user_id INTEGER REFERENCES users(id),
      reason TEXT NOT NULL,
      restock INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      decision_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_refund_requests_bill ON refund_requests(bill_id, status);
    CREATE INDEX IF NOT EXISTS idx_refund_requests_status ON refund_requests(status);
  `);
  // The admin who allowed a refund (the same admin when they did it
  // themselves). NULL for every refund before approval existed.
  addColumn("bills", "refund_approved_by", "INTEGER");
}

export function seedDefaults(): void {
  const db = getDb();

  // Default admin user (password: admin123)
  const adminExists = db.query("SELECT id FROM users WHERE username = 'admin'").get();
  if (!adminExists) {
    const hash = Bun.password.hashSync("admin123", { algorithm: "bcrypt", cost: 10 });
    db.query("INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)").run(
      "admin", hash, "Administrator", "admin"
    );
  }

  // Default stock categories
  const categories = ["Ingredients", "Packing Items", "Finished Products"];
  for (const cat of categories) {
    db.query("INSERT OR IGNORE INTO stock_categories (name) VALUES (?)").run(cat);
  }

  // Default expense categories
  const expCats = ["Rent", "Utilities", "Supplies", "Salary", "Transport", "Maintenance", "Other"];
  for (const cat of expCats) {
    db.query("INSERT OR IGNORE INTO expense_categories (name) VALUES (?)").run(cat);
  }

  // Default settings
  const defaults: Record<string, string> = {
    shop_name: "My Cake Shop",
    shop_address: "",
    shop_phone: "",
    tax_rate: "0",
    currency_symbol: "Rs.",
    printer_type: "none",
    printer_address: "",
    enforce_cash_shift: "1",
    category_order: "[]",
    // What the till's Takeaway / Dine-in toggle starts on for each new sale.
    default_order_type: "takeaway",
    // Rs: a drawer closing more than this over OR short needs an admin's approval.
    cash_variance_limit: "200",
  };
  for (const [key, value] of Object.entries(defaults)) {
    db.query("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
}
