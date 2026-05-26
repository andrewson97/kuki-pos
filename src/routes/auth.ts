import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { getDb } from "../db/database";
import { generateSessionId } from "../utils/helpers";
import type { SessionUser } from "../middleware/auth";

const auth = new Hono();

auth.post("/login", async (c) => {
  const { username, password } = await c.req.json();
  const db = getDb();

  const user = db.query(
    "SELECT id, username, password_hash, full_name, role, is_active FROM users WHERE username = ?"
  ).get(username) as any;

  if (!user || !user.is_active) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const valid = await Bun.password.verify(password, user.password_hash);
  if (!valid) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  // Create session (expires in 12 hours)
  const sessionId = generateSessionId();
  db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+12 hours'))").run(
    sessionId, user.id
  );

  // Clean up expired sessions
  db.query("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

  setCookie(c, "session_id", sessionId, {
    httpOnly: true,
    path: "/",
    maxAge: 12 * 60 * 60,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
  });

  return c.json({
    user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
  });
});

auth.post("/logout", (c) => {
  const sessionId = getCookie(c, "session_id");
  if (sessionId) {
    const db = getDb();
    db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
    deleteCookie(c, "session_id", { path: "/" });
  }
  return c.json({ success: true });
});

auth.get("/me", (c) => {
  // Manually look up session since this route is mounted before auth middleware
  const sessionId = getCookie(c, "session_id");
  if (!sessionId) {
    return c.json({ error: "Not authenticated" }, 401);
  }
  const db = getDb();
  const session = db.query(`
    SELECT u.id, u.username, u.full_name, u.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now') AND u.is_active = 1
  `).get(sessionId) as any;
  if (!session) {
    return c.json({ error: "Session expired" }, 401);
  }
  return c.json({ user: { id: session.id, username: session.username, full_name: session.full_name, role: session.role } });
});

export default auth;
