// Shared helpers for /m/* pages.
window.TZ = 'Asia/Colombo';
const BUSINESS_DAY_START_HOUR = 5;
window.currentUser = null;
window.appSettings = {};

function $(id) { return document.getElementById(id); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function fmt(amount) {
  const sym = appSettings.currency_symbol || 'Rs. ';
  return sym + parseFloat(amount || 0).toFixed(2);
}
function todayISO() {
  const adjusted = new Date(Date.now() - BUSINESS_DAY_START_HOUR * 60 * 60 * 1000);
  return adjusted.toLocaleDateString('en-CA', { timeZone: TZ });
}
function parseDbDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d;
  let s = String(d);
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  return new Date(s.replace(' ', 'T') + 'Z');
}
function formatDate(d) {
  if (!d) return '';
  return parseDbDate(d).toLocaleDateString('en-LK', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric' });
}
function formatTime(d) {
  if (!d) return '';
  return parseDbDate(d).toLocaleTimeString('en-LK', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}
function formatDateTime(d) {
  if (!d) return '';
  return parseDbDate(d).toLocaleString('en-LK', { timeZone: TZ, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Unauthorized'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg, kind = 'ok') {
  let area = $('toast-area');
  if (!area) {
    area = document.createElement('div');
    area.id = 'toast-area';
    document.body.appendChild(area);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' err' : '');
  el.textContent = msg;
  area.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

async function bootMobile() {
  try {
    const [me, settings] = await Promise.all([api('/api/auth/me'), api('/api/settings')]);
    currentUser = me.user;
    appSettings = settings;
  } catch (err) {
    /* auth handler already redirects */
  }
}

function openSheet(id) {
  const el = $(id);
  if (el) el.classList.add('open');
}
function closeSheet(id) {
  const el = $(id);
  if (el) el.classList.remove('open');
}
