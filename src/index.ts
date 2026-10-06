import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import "./utils/paths"; // side effect: ensures the data directory exists before the DB is opened
import { runMigrations, seedDefaults } from "./db/migrations";
import { authMiddleware } from "./middleware/auth";
import { getDb } from "./db/database";
import { ensureBillReplayIndex } from "./services/billing";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import posRoutes from "./routes/pos";
import productRoutes from "./routes/products";
import stockRoutes from "./routes/stock";
import recipeRoutes from "./routes/recipes";
import customerRoutes from "./routes/customers";
import preorderRoutes from "./routes/preorders";
import expenseRoutes from "./routes/expenses";
import incomeRoutes from "./routes/income";
import reportRoutes from "./routes/reports";
import settingsRoutes from "./routes/settings";
import cashRoutes from "./routes/cash";
import taskRoutes from "./routes/tasks";
import historyRoutes from "./routes/history";
import mobileRoutes from "./routes/mobile";

// Initialize database
runMigrations();
// AFTER runMigrations(), on every boot, and never before it. The duplicate-bill
// guard is a UNIQUE index on bills(cart_id, cart_fingerprint, created_at); the
// migration still creates the older bills(cart_id, cart_fingerprint) one, which
// would refuse the second bill of a genuine repeat order under a reused cart id
// and leave the cashier unable to bill. This swaps it, idempotently, and must
// run after every migration pass that could put the old one back. See
// ensureBillReplayIndex() in src/services/billing.ts.
ensureBillReplayIndex();
seedDefaults();

const app = new Hono();

// Any error that escapes a route handler. Without this Hono answers with a
// plain-text 500, which the frontend's api() cannot parse — so the user saw an
// opaque JSON syntax error instead of a message. Log the real error here and
// send back the same { error } shape every route uses; never the stack trace.
app.onError((err, c) => {
  console.error(`[error] ${c.req.method} ${c.req.path}`, err);
  // Deliberate HTTP errors keep their status and message; anything else is an
  // internal failure, so the client only ever sees a generic line.
  if (err instanceof HTTPException) {
    return c.json({ error: err.message || "Request failed" }, err.status);
  }
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

// ---------------------------------------------------------------------------
// CACHING: what may be reused, and for how long
// ---------------------------------------------------------------------------
// Nothing used to say. Every response left here with no caching directives at
// all, so a browser — or any proxy sitting in front of fly.io — was free to
// apply its own heuristic and hand a till yesterday's answer. That is why the
// stock counts and the day's totals only corrected themselves on a reload, and
// it made the lost-sale bug worse: a cashier who cannot see that her sale
// landed rings it up again.
//
// Three classes of response, three different answers:
//
//   /api/*  -> no-store.
//       These are stock levels, running totals, token numbers, shift state and
//       the bill endpoint itself. Every one of them is a fact about money or
//       goods RIGHT NOW, and a stale one is wrong rather than merely old; there
//       is no reuse worth having here at any age. no-store, not no-cache, on
//       purpose: no-cache would still permit a copy to be written to disk, and
//       these payloads carry customer names, phone numbers and takings onto a
//       shared shop tablet. It also costs nothing — these are small reads on a
//       LAN, and the till already re-reads them deliberately.
//
//   /public/*  -> public, max-age=300, must-revalidate.
//       The logo, the two stylesheets, the shared app.js/mobile.js and the
//       printer-driver download. These DO benefit from caching: a cashier
//       moving between the till, Stock and Bills all day should not refetch
//       them on every navigation. But none of them is content-hashed — they are
//       served at a fixed path and overwritten in place by a deploy — so the
//       cache lifetime is also the worst case for how long a till can keep
//       running yesterday's JavaScript against today's server. Five minutes is
//       the trade: navigations within a shift are free, and a deployed fix is
//       shop-wide within minutes without anyone clearing a cache.
//
//   everything else (the HTML pages)  -> no-cache.
//       Each page embeds the till's own logic in an inline <script>, so a stale
//       page IS stale application code — the same hazard as stale app.js, and
//       the reason these cannot be lumped in with the assets above. no-cache
//       (may be stored, must be revalidated before use) rather than no-store:
//       correctness is identical, since the page can never be used without
//       asking the server first, and it keeps the back/forward cache working on
//       a tablet where a cashier taps Back between screens.
//
// Registered FIRST, before every route including /api/auth and the static
// handler, because Hono dispatches in registration order and a middleware
// declared after a route never runs for it.
//
// The header is set in a `finally`, after the handler, so it also lands on
// responses the prepared-header path would miss: a route that builds its own
// Response (/api/settings/backup does), and an error answered by app.onError.
function cacheControlFor(path: string): string {
  if (path.startsWith("/api/")) return "no-store";
  if (path.startsWith("/public/")) return "public, max-age=300, must-revalidate";
  return "no-cache";
}

app.use("*", async (c, next) => {
  const policy = cacheControlFor(c.req.path);
  try {
    await next();
  } finally {
    c.header("Cache-Control", policy);
  }
});

// Static files
app.use("/public/*", serveStatic({ root: "./" }));

// Login page (no auth needed)
app.get("/login", async (c) => {
  const sessionId = getCookie(c, "session_id");
  if (sessionId) {
    const db = getDb();
    const session = db.query("SELECT id FROM sessions WHERE id = ? AND expires_at > datetime('now')").get(sessionId);
    if (session) return c.redirect("/");
  }
  const content = await Bun.file("views/login.html").text();
  return c.html(content);
});

// Auth API (no middleware for login/logout)
app.route("/api/auth", authRoutes);

// Auth middleware for all protected routes
app.use("*", async (c, next) => {
  const path = c.req.path;
  // Skip auth for login page, static files, and auth API
  if (path === "/login" || path.startsWith("/public/") || path.startsWith("/api/auth")) {
    return next();
  }
  return authMiddleware(c, next);
});

// API routes
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/pos", posRoutes);
app.route("/api/products", productRoutes);
app.route("/api/stock", stockRoutes);
app.route("/api/recipes", recipeRoutes);
app.route("/api/customers", customerRoutes);
app.route("/api/preorders", preorderRoutes);
app.route("/api/expenses", expenseRoutes);
app.route("/api/income", incomeRoutes);
app.route("/api/reports", reportRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/cash", cashRoutes);
app.route("/api/tasks", taskRoutes);
app.route("/api/history", historyRoutes);
app.route("/api/mobile", mobileRoutes);

// Auto-redirect phones hitting the main admin pages to their mobile equivalents.
// Skip when ?desktop=1 is set (lets you force the full UI from a phone).
const MOBILE_REDIRECTS: Record<string, string> = {
  "/": "/m",
  "/pos": "/m/pos",
  "/bills": "/m/bills",
  "/expenses": "/m/expenses",
  "/cash": "/m/cash",
  "/reports": "/m/reports",
  "/products": "/m/products",
  "/stock": "/m/stock",
  "/customers": "/m/customers",
  "/tasks": "/m/tasks",
};
const isMobileUA = (ua: string) => /Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);

for (const [from, to] of Object.entries(MOBILE_REDIRECTS)) {
  const desktopFile =
    from === "/" ? "views/dashboard.html"
    : `views/${from.replace(/^\//, "")}.html`;
  app.get(from, async (c) => {
    if (isMobileUA(c.req.header("user-agent") || "") && c.req.query("desktop") !== "1") {
      return c.redirect(to);
    }
    const content = await Bun.file(desktopFile).text();
    return c.html(content);
  });
}

// Page routes - serve HTML files (mobile equivalents + pages with no mobile twin)
const pages = [
  { path: "/m", file: "views/mobile.html" },
  { path: "/m/pos", file: "views/m-pos.html" },
  { path: "/m/bills", file: "views/m-bills.html" },
  { path: "/m/expenses", file: "views/m-expenses.html" },
  { path: "/m/cash", file: "views/m-cash.html" },
  { path: "/m/reports", file: "views/m-reports.html" },
  { path: "/m/products", file: "views/m-products.html" },
  { path: "/m/stock", file: "views/m-stock.html" },
  { path: "/m/customers", file: "views/m-customers.html" },
  { path: "/m/tasks", file: "views/m-tasks.html" },
  { path: "/recipes", file: "views/recipes.html" },
  { path: "/history", file: "views/history.html" },
  { path: "/income", file: "views/income.html" },
  { path: "/settings", file: "views/settings.html" },
  { path: "/users", file: "views/users.html" },
];

for (const page of pages) {
  app.get(page.path, async (c) => {
    const content = await Bun.file(page.file).text();
    return c.html(content);
  });
}

// The pre-orders screen. Separate from the list above because the view is being
// built alongside this API: until views/preorders.html lands, Bun.file().text()
// would throw and the page would answer with the generic 500 from app.onError,
// which says nothing useful. Check first and say what is actually missing. The
// route is registered now so the screen works the moment the file appears.
const PREORDER_PAGES: Record<string, string> = {
  "/preorders": "views/preorders.html",
  "/m/preorders": "views/m-preorders.html",
};
for (const [path, file] of Object.entries(PREORDER_PAGES)) {
  app.get(path, async (c) => {
    const f = Bun.file(file);
    if (!(await f.exists())) {
      return c.html(`<h1>Pre-orders screen not installed</h1><p>Expected <code>${file}</code>. The API is live at <code>/api/preorders</code>.</p>`, 404);
    }
    return c.html(await f.text());
  });
}

const PORT = parseInt(process.env.PORT || "3000");
console.log(`🍰 Cake Shop POS running at http://localhost:${PORT}`);

export default {
  port: PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
