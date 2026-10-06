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
    -- settle?" lookup, which only ever searches non-NULL values. Together with
    -- the deterministic cart_id used at collection ('preorder-<id>', which the
    -- UNIQUE index on bills(cart_id, cart_fingerprint) guards) this makes a
    -- double-tapped Collect physically unable to produce two bills or two
    -- links: a double tap resubmits the IDENTICAL collection, so it hashes to
    -- the same fingerprint and replays. (A second Collect that is not identical
    -- cannot get that far anyway: POST /:id/collect refuses an order whose
    -- status is already 'collected' with a 409 before any bill is written.)
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
    currency_symbol: "₹",
    printer_type: "none",
    printer_address: "",
    enforce_cash_shift: "1",
    category_order: "[]",
  };
  for (const [key, value] of Object.entries(defaults)) {
    db.query("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
}
