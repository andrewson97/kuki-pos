import { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { getDb } from "../db/database";

export interface SessionUser {
  id: number;
  username: string;
  full_name: string;
  role: "admin" | "cashier";
}

// Get user from session cookie — works in both parent app and sub-routers
export function getUser(c: Context): SessionUser | null {
  // Try context first (set by middleware on parent app)
  const cached = c.get("user") as SessionUser | undefined;
  if (cached) return cached;

  // Fallback: look up from cookie directly
  const sessionId = getCookie(c, "session_id");
  if (!sessionId) return null;

  const db = getDb();
  const session = db.query(`
    SELECT u.id as user_id, u.username, u.full_name, u.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > datetime('now') AND u.is_active = 1
  `).get(sessionId) as any;

  if (!session) return null;
  const user: SessionUser = {
    id: session.user_id,
    username: session.username,
    full_name: session.full_name,
    role: session.role,
  };
  c.set("user", user);
  return user;
}

export async function authMiddleware(c: Context, next: Next) {
  const user = getUser(c);
  if (!user) {
    // Return 401 JSON for API requests, redirect for pages
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: "Not authenticated" }, 401);
    }
    return c.redirect("/login");
  }
  await next();
}

export function adminOnly(c: Context, next: Next) {
  const user = getUser(c);
  if (!user || user.role !== "admin") {
    return c.json({ error: "Admin access required" }, 403);
  }
  return next();
}
