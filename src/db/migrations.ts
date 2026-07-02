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
      image_path TEXT,
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
