import { Hono } from "hono";
import { getDb } from "../db/database";

const customers = new Hono();

customers.get("/", (c) => {
  const db = getDb();
  const search = c.req.query("search");
  if (search) {
    return c.json(
      db.query("SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY name").all(`%${search}%`, `%${search}%`)
    );
  }
  return c.json(db.query("SELECT * FROM customers ORDER BY name").all());
});

customers.get("/:id", (c) => {
  const db = getDb();
  const customer = db.query("SELECT * FROM customers WHERE id = ?").get(c.req.param("id"));
  if (!customer) return c.json({ error: "Not found" }, 404);
  return c.json(customer);
});

customers.post("/", async (c) => {
  const { name, phone, address, notes } = await c.req.json();
  const db = getDb();
  const result = db.query(
    "INSERT INTO customers (name, phone, address, notes) VALUES (?, ?, ?, ?)"
  ).run(name, phone || null, address || null, notes || null);
  return c.json({ id: Number(result.lastInsertRowid), name });
});

customers.put("/:id", async (c) => {
  const id = c.req.param("id");
  const { name, phone, address, notes } = await c.req.json();
  const db = getDb();
  db.query("UPDATE customers SET name = ?, phone = ?, address = ?, notes = ? WHERE id = ?").run(
    name, phone || null, address || null, notes || null, id
  );
  return c.json({ success: true });
});

customers.get("/:id/orders", (c) => {
  const db = getDb();
  const bills = db.query(`
    SELECT b.*, u.full_name as cashier_name
    FROM bills b
    LEFT JOIN users u ON b.user_id = u.id
    WHERE b.customer_id = ?
    ORDER BY b.created_at DESC
    LIMIT 50
  `).all(c.req.param("id"));
  return c.json(bills);
});

export default customers;
