// ===== Global State & Utilities =====
let currentUser = null;
let appSettings = {};

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401 || res.status === 403) {
    if (res.status === 401) window.location.href = '/login';
    throw new Error('Access denied');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container') || createToastContainer();
  const toast = document.createElement('div');
  toast.className = `alert alert-${type === 'error' ? 'danger' : type} alert-dismissible fade show`;
  toast.style.cssText = 'min-width:280px;box-shadow:0 4px 12px rgba(0,0,0,0.15);margin-bottom:8px;';
  toast.innerHTML = `${message}<button type="button" class="btn-close" onclick="this.parentElement.remove()"></button>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function createToastContainer() {
  const c = document.createElement('div');
  c.id = 'toast-container';
  c.className = 'toast-container';
  document.body.appendChild(c);
  return c;
}

function formatCurrency(amount) {
  const sym = appSettings.currency_symbol || '\u20B9';
  return `${sym}${parseFloat(amount).toFixed(2)}`;
}

// SQLite's datetime('now') returns UTC without a timezone marker.
// JavaScript's Date() parses "2026-06-03 14:23:45" as LOCAL time, which is wrong.
// This helper turns DB timestamps into a Date that JS knows is UTC.
function parseDbDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d;
  let s = String(d);
  // Already has timezone info?
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  // SQLite format "YYYY-MM-DD HH:MM:SS" — treat as UTC.
  return new Date(s.replace(' ', 'T') + 'Z');
}

const TZ = 'Asia/Colombo';
// Business day starts at 5 AM Asia/Colombo. Anything before 5 AM is the prior day.
const BUSINESS_DAY_START_HOUR = 5;

function formatDate(d) {
  if (!d) return '';
  const dt = parseDbDate(d);
  return dt.toLocaleDateString('en-LK', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTime(d) {
  if (!d) return '';
  return parseDbDate(d).toLocaleTimeString('en-LK', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(d) {
  if (!d) return '';
  return parseDbDate(d).toLocaleString('en-LK', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function todayISO() {
  // Today's BUSINESS date in Sri Lanka — rolls over at 5 AM, not midnight.
  const adjusted = new Date(Date.now() - BUSINESS_DAY_START_HOUR * 60 * 60 * 1000);
  return adjusted.toLocaleDateString('en-CA', { timeZone: TZ });
}

async function loadUser() {
  try {
    const data = await api('/api/auth/me');
    currentUser = data.user;
  } catch {
    window.location.href = '/login';
  }
}

async function loadSettings() {
  try {
    appSettings = await api('/api/settings');
  } catch {}
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

// ===== Layout Rendering =====
function renderLayout(activePage) {
  const isAdmin = currentUser?.role === 'admin';
  const navItems = [
    { path: '/', icon: '\u{1F4CA}', label: 'Dashboard', admin: false },
    { divider: 'Sales' },
    { path: '/pos', icon: '\u{1F6D2}', label: 'POS', admin: false },
    { path: '/bills', icon: '\u{1F9FE}', label: 'Bills', admin: false },
    { path: '/customers', icon: '\u{1F465}', label: 'Customers', admin: false },
    { path: '/tasks', icon: '✅', label: 'Daily Tasks', admin: false },
    { divider: 'Inventory' },
    { path: '/products', icon: '\u{1F382}', label: 'Products', admin: true },
    { path: '/recipes', icon: '\u{1F4D6}', label: 'Recipes', admin: true },
    { path: '/stock', icon: '\u{1F4E6}', label: 'Stock', admin: true },
    { divider: 'Finance' },
    { path: '/cash', icon: '\u{1F4B5}', label: 'Cash Drawer', admin: false },
    { path: '/expenses', icon: '\u{1F4B8}', label: 'Expenses', admin: false, badge: 'pending_expenses' },
    { path: '/income', icon: '\u{1F4B0}', label: 'Income', admin: true },
    { path: '/reports', icon: '\u{1F4C8}', label: 'Reports', admin: true },
    { divider: 'System' },
    { path: '/settings', icon: '\u2699\uFE0F', label: 'Settings', admin: true },
    { path: '/users', icon: '\u{1F464}', label: 'Users', admin: true },
  ];

  const visibleItems = navItems.filter(item => {
    if (item.divider) return true;
    return !item.admin || isAdmin;
  });
  // Remove dividers that have no items after them
  const sidebarHTML = visibleItems.filter((item, i) => {
    if (item.divider) {
      const next = visibleItems[i + 1];
      return next && !next.divider; // keep divider only if next item is a link
    }
    return true;
  }).map(item => {
    if (item.divider) return `<li class="nav-divider">${item.divider}</li>`;
    const active = item.path === activePage ? 'active' : '';
    const badgeAttr = item.badge ? ` data-badge="${item.badge}"` : '';
    return `<li><a href="${item.path}" class="${active}"${badgeAttr}>${item.icon} ${item.label}<span class="nav-badge ms-1" style="display:none;"></span></a></li>`;
  }).join('');

  document.getElementById('sidebar').innerHTML = `
    <div class="sidebar-brand">
      <img src="/public/img/kuki_logo.png" alt="KUKI" class="sidebar-logo">
      <small>POS System</small>
    </div>
    <ul class="sidebar-nav">${sidebarHTML}</ul>
  `;

  document.getElementById('top-bar-user').innerHTML = `
    <span class="me-3"><strong>${currentUser.full_name}</strong> <span class="badge bg-secondary">${currentUser.role}</span></span>
    <button class="btn btn-outline-secondary btn-sm" onclick="logout()">Logout</button>
  `;

  refreshSidebarBadges();
}

async function refreshSidebarBadges() {
  if (!currentUser || currentUser.role !== 'admin') return;
  try {
    const res = await fetch('/api/expenses/pending-count');
    if (!res.ok) return;
    const data = await res.json();
    const el = document.querySelector('[data-badge="pending_expenses"] .nav-badge');
    if (el) {
      if (data.count > 0) {
        el.textContent = data.count;
        el.style.cssText = 'display:inline-block;background:#dc3545;color:white;border-radius:10px;padding:1px 7px;font-size:0.75rem;font-weight:bold;';
      } else {
        el.style.display = 'none';
      }
    }
  } catch {}
}

// ===== Init =====
async function initApp(activePage, callback) {
  await loadUser();
  await loadSettings();
  renderLayout(activePage);
  if (callback) callback();
}
