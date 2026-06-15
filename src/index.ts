import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getCookie } from "hono/cookie";
import path from "path";
import { runMigrations, seedDefaults } from "./db/migrations";
import { UPLOADS_DIR } from "./utils/paths";
import { authMiddleware } from "./middleware/auth";
import { getDb } from "./db/database";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import posRoutes from "./routes/pos";
import productRoutes from "./routes/products";
import stockRoutes from "./routes/stock";
import recipeRoutes from "./routes/recipes";
import customerRoutes from "./routes/customers";
import expenseRoutes from "./routes/expenses";
import incomeRoutes from "./routes/income";
import reportRoutes from "./routes/reports";
import settingsRoutes from "./routes/settings";
import cashRoutes from "./routes/cash";
import taskRoutes from "./routes/tasks";
import mobileRoutes from "./routes/mobile";

// Initialize database
runMigrations();
seedDefaults();

const app = new Hono();

// Static files
app.use("/public/*", serveStatic({ root: "./" }));

// Uploaded product images — public read, no auth needed
app.get("/uploads/:filename", async (c) => {
  const filename = c.req.param("filename");
  if (!/^[\w.-]+$/.test(filename)) return c.notFound();
  const file = Bun.file(path.join(UPLOADS_DIR, filename));
  if (!(await file.exists())) return c.notFound();
  return new Response(file);
});

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
  if (path === "/login" || path.startsWith("/public/") || path.startsWith("/uploads/") || path.startsWith("/api/auth")) {
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
app.route("/api/expenses", expenseRoutes);
app.route("/api/income", incomeRoutes);
app.route("/api/reports", reportRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/cash", cashRoutes);
app.route("/api/tasks", taskRoutes);
app.route("/api/mobile", mobileRoutes);

// Auto-redirect phones hitting the dashboard to the mobile view.
// (Skip if user explicitly asked for desktop via ?desktop=1)
app.get("/", async (c) => {
  const ua = c.req.header("user-agent") || "";
  const isMobile = /Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  if (isMobile && c.req.query("desktop") !== "1") return c.redirect("/m");
  const content = await Bun.file("views/dashboard.html").text();
  return c.html(content);
});

// Page routes - serve HTML files
const pages = [
  { path: "/m", file: "views/mobile.html" },
  { path: "/pos", file: "views/pos.html" },
  { path: "/bills", file: "views/bills.html" },
  { path: "/products", file: "views/products.html" },
  { path: "/recipes", file: "views/recipes.html" },
  { path: "/stock", file: "views/stock.html" },
  { path: "/customers", file: "views/customers.html" },
  { path: "/cash", file: "views/cash.html" },
  { path: "/tasks", file: "views/tasks.html" },
  { path: "/expenses", file: "views/expenses.html" },
  { path: "/income", file: "views/income.html" },
  { path: "/reports", file: "views/reports.html" },
  { path: "/settings", file: "views/settings.html" },
  { path: "/users", file: "views/users.html" },
];

for (const page of pages) {
  app.get(page.path, async (c) => {
    const content = await Bun.file(page.file).text();
    return c.html(content);
  });
}

const PORT = parseInt(process.env.PORT || "3000");
console.log(`🍰 Cake Shop POS running at http://localhost:${PORT}`);

export default {
  port: PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
