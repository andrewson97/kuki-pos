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

// Sort category names by the admin-defined order in settings.category_order.
// Categories not in the saved order are appended alphabetically.
function sortCategoriesPOS(cats) {
  let saved = [];
  try { saved = JSON.parse(appSettings.category_order || '[]'); } catch {}
  const order = saved.map(s => String(s).toLowerCase());
  const indexOf = c => order.indexOf(String(c).toLowerCase());
  return [...cats].sort((a, b) => {
    const ia = indexOf(a), ib = indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Unauthorized'); }
  // The body is not always JSON. A cold-started machine, a proxy error page or an
  // uncaught server error can answer with plain text, and parsing that blindly threw
  // an opaque "Unexpected token E in JSON" that told the user nothing. Report the
  // HTTP status instead.
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(res.ok ? 'Unexpected response from server' : `Server error (${res.status})`);
  }
  if (!res.ok) {
    // Carry the status and parsed body on the error too, so a caller needing
    // more than the message (e.g. a 409 asking for confirmation) can read it.
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ===== withBusy: one-at-a-time guard for save buttons =====
// This app runs on fly.io with auto_stop_machines and min_machines_running = 0,
// so the first request after an idle period pays a cold start and can take
// several seconds. Nothing on the server de-duplicates writes, so a user staring
// at a button that looks untouched clicks it again and again and ends up with N
// duplicate rows. withBusy() disables the button, optionally swaps in a busy
// label, and refuses to run the action again until the first one settles.
// It also catches errors so a failed save surfaces as a toast instead of dying
// silently in the console — callers never need their own try/catch.
const busyFns = new Set();

async function withBusy(btn, fn, busyLabel) {
  const el = typeof btn === 'string' ? document.getElementById(btn) : btn;

  // Re-entry guard. With an element the state lives on the element itself, so it
  // survives re-renders of the surrounding markup; without one we fall back to a
  // module-level set keyed off the function.
  if (el) {
    if (el.getAttribute('data-busy') === '1') return;
  } else {
    if (busyFns.has(fn)) return;
    busyFns.add(fn);
  }

  let prevLabel = null;
  if (el) {
    el.setAttribute('data-busy', '1');
    el.disabled = true;
    if (busyLabel) {
      prevLabel = el.textContent;
      el.textContent = busyLabel;
    }
  }

  try {
    return await fn();
  } catch (err) {
    toast((err && err.message) || 'Something went wrong. Please try again.', 'error');
    return undefined;
  } finally {
    // Always restore, even if fn() threw or closed the modal the button lives in.
    if (el) {
      el.removeAttribute('data-busy');
      el.disabled = false;
      if (prevLabel !== null) el.textContent = prevLabel;
    } else {
      busyFns.delete(fn);
    }
  }
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
