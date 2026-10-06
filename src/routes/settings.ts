import { Hono } from "hono";
import { getDb } from "../db/database";
import { isValidPrinterTarget } from "../services/printer";
import { adminOnly } from "../middleware/auth";
import { createDownloadSnapshot, isSnapshotName, listSnapshots, snapshotPath } from "../services/backup";
import { todayDate } from "../utils/helpers";
import type { SessionUser } from "../middleware/auth";

const settings = new Hono();

settings.get("/", (c) => {
  const db = getDb();
  const rows = db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return c.json(result);
});

settings.put("/", adminOnly, async (c) => {
  const updates = await c.req.json();
  const db = getDb();

  // Catch a mistyped printer address here rather than letting every receipt be
  // written silently into a folder on the server (see isValidPrinterTarget).
  if ("printer_address" in updates) {
    const addr = String(updates.printer_address ?? "").trim();
    if (addr && !isValidPrinterTarget(addr)) {
      return c.json(
        { error: `"${addr}" does not look like a printer. Use a share (\\\\PC-NAME\\Printer), a port (LPT1:) or a full path.` },
        400
      );
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    db.query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
  }
  return c.json({ success: true });
});

// User management (admin only)
settings.get("/users", adminOnly, (c) => {
  const db = getDb();
  return c.json(db.query("SELECT id, username, full_name, role, is_active, show_dashboard_money, created_at FROM users ORDER BY id").all());
});

// show_dashboard_money: whether a cashier sees the day's money on the
// dashboards (see canSeeDashboardMoney in ../middleware/auth). Stored as 0/1;
// anything truthy from the form counts as on. Ignored for admins, who always
// see it, but stored as sent so flipping someone's role back keeps their choice.
const dashboardMoneyFlag = (v: unknown): number => (v === true || v === 1 || v === "1" ? 1 : 0);

settings.post("/users", adminOnly, async (c) => {
  const { username, password, full_name, role, show_dashboard_money } = await c.req.json();
  const db = getDb();
  const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
  const result = db.query(
    "INSERT INTO users (username, password_hash, full_name, role, show_dashboard_money) VALUES (?, ?, ?, ?, ?)"
  ).run(username, hash, full_name, role || "cashier", dashboardMoneyFlag(show_dashboard_money));
  return c.json({ id: Number(result.lastInsertRowid) });
});

settings.put("/users/:id", adminOnly, async (c) => {
  const id = c.req.param("id");
  const { full_name, role, is_active, password, show_dashboard_money } = await c.req.json();
  const db = getDb();
  // show_dashboard_money only changes when the form sends it, so an older
  // client that does not know the field cannot switch it off by omission.
  db.query(
    "UPDATE users SET full_name = ?, role = ?, is_active = ?, show_dashboard_money = COALESCE(?, show_dashboard_money) WHERE id = ?"
  ).run(full_name, role, is_active, show_dashboard_money === undefined ? null : dashboardMoneyFlag(show_dashboard_money), id);
  if (password) {
    const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
    db.query("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);
  }
  return c.json({ success: true });
});

settings.get("/activity-log", adminOnly, (c) => {
  const db = getDb();
  const limit = parseInt(c.req.query("limit") || "100");
  return c.json(
    db.query(`
      SELECT al.*, u.full_name as user_name
      FROM activity_log al
      LEFT JOIN users u ON al.user_id = u.id
      ORDER BY al.created_at DESC
      LIMIT ?
    `).all(limit)
  );
});

// Backup - download a consistent copy of the live database, as of now.
// This used to stream Bun.file("data/shop.db"), relative to the working
// directory: on fly.io the database is /data/shop.db on the volume, so that path
// did not exist, and even where it did, copying the main file of a WAL database
// misses every transaction not yet checkpointed into it. createDownloadSnapshot()
// takes a VACUUM INTO snapshot of the real file instead (see
// src/services/backup.ts). Named by BUSINESS date, so a backup taken at 1 AM
// after a late shift carries the date of the day it belongs to.
settings.get("/backup", adminOnly, async (c) => {
  let bytes: Uint8Array;
  try {
    bytes = await createDownloadSnapshot();
  } catch (err) {
    console.error("[backup] download snapshot failed", err);
    return c.json({ error: "Could not create a backup. Please try again; if it keeps failing, check the server log." }, 500);
  }
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="shop-backup-${todayDate()}.db"`,
    },
  });
});

// The automatic daily snapshots kept on the volume (newest first), and a
// download for each. The filename is checked against the exact snapshot pattern
// by snapshotPath(); anything else - "../shop.db", another file in the folder -
// is refused before the filesystem is touched.
settings.get("/backups", adminOnly, (c) => {
  return c.json(listSnapshots());
});

settings.get("/backups/:file", adminOnly, (c) => {
  const name = c.req.param("file") ?? "";
  if (!isSnapshotName(name)) {
    return c.json({ error: "Not a backup file name" }, 400);
  }
  const full = snapshotPath(name);
  if (!full) {
    return c.json({ error: "That backup no longer exists" }, 404);
  }
  return new Response(Bun.file(full), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
});

export default settings;
