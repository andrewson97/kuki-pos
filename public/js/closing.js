// ===== Closing the drawer: stock sync + admin approvals =====
// Shared by the desktop (views/cash.html) and mobile (views/m-cash.html) Cash
// Drawer pages, so the two cannot drift on rules that decide whether a drawer
// may close. The server is the authority on all of it (src/routes/cash.ts,
// src/services/closing.ts); this file only shows where things stand and sends
// what the person at the till does.
//
// The page gives it three containers and a few helpers:
//   Closing.init({
//     sync: el, gate: el, approvals: el,   // Step 1 panel, variance box, admin queue
//     notify(msg, kind),                  // kind: 'ok' | 'error'
//     money(n),                           // Rs. formatting
//     withBusy(btn, fn, label),           // the page's one-at-a-time guard
//     isAdmin,                            // the logged-in user is an admin
//     onState(today),                     // the page re-checks its Close button
//     onClosed(),                         // a close went through: reload the page
//   })
//   Closing.update(today)                 // after every GET /api/cash/today
//   Closing.closeAllowed()                // false until the stock sync is good
//   Closing.needsApproval(body, data)     // POST /close answered 409 needs_approval
//
// Every name a till or admin typed reaches the screen through esc(): product
// and item names are admin-entered free text.

window.Closing = (() => {
  let cfg = null;
  let today = null;
  let counting = false;       // the count form is open
  let countItems = [];        // the blind list being counted
  let gateBody = null;        // the drawer count a 409 refused, for "request" / "approve here"
  let gateInfo = null;        // that 409's figures
  let pollTimer = null;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const qty = (n) => String(Math.round((Number(n) || 0) * 1000) / 1000);
  const time = (d) => (typeof formatTime === 'function' ? formatTime(d) : d);

  // One small stylesheet so the panels look the same on both pages, whatever
  // framework the page itself uses (Bootstrap on desktop, mobile.css on phones).
  function injectStyles() {
    if (document.getElementById('closing-styles')) return;
    const s = document.createElement('style');
    s.id = 'closing-styles';
    s.textContent = `
      .cc-box { border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; border: 1px solid #e5e7eb; background: #fff; font-size: 0.92rem; }
      .cc-box h4 { font-size: 1rem; font-weight: 700; margin: 0 0 6px; }
      .cc-ok { border-left: 5px solid #16a34a; background: #f0fdf4; }
      .cc-wait { border-left: 5px solid #d97706; background: #fffbeb; }
      .cc-bad { border-left: 5px solid #dc2626; background: #fef2f2; }
      .cc-step { border-left: 5px solid #2563eb; }
      .cc-muted { color: #6b7280; font-size: 0.82rem; }
      .cc-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .cc-btn { display: inline-block; width: auto; padding: 7px 14px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; color: #111827; font-weight: 600; font-size: 0.88rem; cursor: pointer; }
      .cc-btn:disabled { opacity: 0.55; cursor: default; }
      .cc-primary { background: #2563eb; border-color: #2563eb; color: #fff; }
      .cc-success { background: #16a34a; border-color: #16a34a; color: #fff; }
      .cc-danger { color: #dc2626; border-color: #fca5a5; }
      .cc-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 0.88rem; }
      .cc-table th { text-align: left; font-size: 0.75rem; text-transform: uppercase; color: #6b7280; padding: 4px 6px; border-bottom: 1px solid #e5e7eb; }
      .cc-table td { padding: 6px; border-bottom: 1px solid #f3f4f6; vertical-align: middle; }
      .cc-table td.num, .cc-table th.num { text-align: right; white-space: nowrap; }
      .cc-input { width: 90px; padding: 6px 8px; border: 1.5px solid #d1d5db; border-radius: 6px; text-align: right; font-weight: 600; font-size: 0.95rem; }
      .cc-text { width: 100%; padding: 7px 9px; border: 1.5px solid #d1d5db; border-radius: 6px; font-size: 0.92rem; box-sizing: border-box; }
      .cc-diff-neg { color: #dc2626; font-weight: 700; }
      .cc-diff-pos { color: #d97706; font-weight: 700; }
      .cc-cat { background: #f9fafb; font-weight: 700; font-size: 0.78rem; color: #374151; }
      .cc-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 2000; display: flex; align-items: center; justify-content: center; padding: 12px; }
      .cc-dialog { background: #fff; border-radius: 12px; padding: 16px; width: 100%; max-width: 560px; max-height: 90vh; overflow-y: auto; box-shadow: 0 10px 30px rgba(0,0,0,0.25); }
      .cc-dialog label { display: block; font-size: 0.82rem; font-weight: 600; margin: 8px 0 3px; }
    `;
    document.head.appendChild(s);
  }

  function init(c) {
    cfg = c;
    injectStyles();
  }

  function shiftOpen() { return !!(today && today.shift_open); }
  function syncState() { return (today && today.stock_sync) || null; }
  function closeAllowed() { return !!(syncState() && syncState().valid); }

  function update(t) {
    today = t;
    if (!shiftOpen()) { counting = false; gateBody = null; gateInfo = null; }
    render();
    schedulePoll();
  }

  // While something waits on an admin, look again every 15 s so the screen
  // changes by itself when they decide. Only /api/cash/today: the page's own
  // drawer count is never reloaded (or the notes typed in would be wiped).
  //
  // The machine this runs on sleeps when nothing asks it anything, and every
  // request wakes it: so nobody polls from a hidden tab (it catches up the
  // moment the tab is looked at again), and an admin with nothing waiting
  // looks only once a minute — often enough to notice a new request, rare
  // enough not to hold the machine up all night on a shift nobody closed.
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (document.hidden) return;
    // Between shifts only refunds can wait on the admin; a slow look for them.
    if (!shiftOpen()) { if (cfg.isAdmin) pollTimer = setTimeout(refresh, 60000); return; }
    const s = syncState();
    const waiting = (s && s.sync && s.sync.status === 'pending') ||
      (today.close_request && today.close_request.status === 'pending') ||
      (today.pending_refunds || 0) > 0 || // the Close button unlocks once they are decided
      (today.pending_disposals || 0) > 0; // and Step 1 opens once waste reports are
    if (waiting) pollTimer = setTimeout(refresh, 15000);
    else if (cfg.isAdmin) pollTimer = setTimeout(refresh, 60000);
  }

  document.addEventListener('visibilitychange', () => {
    if (!cfg || !today) return;
    if (document.hidden) { clearTimeout(pollTimer); pollTimer = null; }
    else refresh();
  });

  async function refresh() {
    try {
      const t = await api('/api/cash/today');
      today = t;
      render();
      if (cfg.onState) cfg.onState(t);
    } catch {}
    schedulePoll();
  }

  // Re-rendering must never wipe what someone is typing: an open count form is
  // left alone (only a deliberate action redraws it), and the admin's queue is
  // only redrawn when the set of waiting items changed.
  function render() {
    renderSync();
    renderGate();
    renderApprovals();
  }

  // ----- Step 1: the stock sync -------------------------------------------------
  function renderSync() {
    const el = cfg.sync;
    if (!el) return;
    if (!shiftOpen()) { el.innerHTML = ''; return; }
    if (counting) {
      if (!el.querySelector('[data-role="count-form"]')) renderCountForm();
      return;
    }
    const st = syncState() || {};
    const s = st.sync;
    if (st.valid) {
      const how = s.status === 'approved'
        ? `approved by ${esc(s.decided_by_name || 'an admin')}`
        : 'everything matched';
      el.innerHTML = `<div class="cc-box cc-ok"><h4>&#9989; Step 1 done &mdash; stock synced</h4>
        <div>Counted by ${esc(s.user_name || '-')} at ${esc(time(s.created_at))}, ${how}. You can close the drawer below.</div>
        <div class="cc-muted">A sale, a delivery or an opened box after this means syncing again.</div>
        <div class="cc-row"><button class="cc-btn" onclick="Closing.startCount(this)">Sync again</button></div></div>`;
      return;
    }
    // Waiting on an admin. The cashier is told HOW MANY lines were off, never
    // which — and cannot send a new count meanwhile (the server refuses it):
    // "count again until it matches" would hide a shortage from the admin.
    if (s && s.status === 'pending') {
      const n = Number(s.mismatch_count) || 0;
      const total = Number(s.line_count ?? (s.lines || []).length);
      el.innerHTML = `<div class="cc-box cc-wait"><h4>&#9203; Step 1 &mdash; waiting for an admin</h4>
        <div>${n} of ${total} item${total === 1 ? '' : 's'} did not match the system. The count has been sent to an admin to approve.</div>
        <div class="cc-muted">Made a mistake? Tell the admin &mdash; they can correct the figure or send it back for a recount.</div>
        <div class="cc-row">
          ${cfg.isAdmin ? '<span class="cc-muted">Review it in "Waiting for your approval" above.</span>'
            : `<button class="cc-btn cc-primary" onclick="Closing.adminApproveSync(${Number(s.id)})">Admin: approve here</button>`}
        </div></div>`;
      return;
    }
    let head = '&#128230; Step 1 &mdash; sync the stock';
    let msg = 'Before closing, count the items ticked for the daily stock sync and enter the figures. Items already at 0 are not listed.';
    let cls = 'cc-step';
    if (st.stale) {
      head = '&#128260; Step 1 &mdash; sync the stock again';
      msg = st.stale_reason === 'listed'
        ? 'The count list has changed since the last sync (an item was ticked for the daily sync, or came into stock). Count again before closing.'
        : 'Stock has changed since the last sync (a sale, a delivery or an opened box). Count again before closing.';
      cls = 'cc-wait';
    } else if (s && s.status === 'rejected') {
      head = '&#10060; Step 1 &mdash; the count was rejected';
      msg = `${esc(s.decided_by_name || 'The admin')} rejected it${s.decision_note ? `: &ldquo;${esc(s.decision_note)}&rdquo;` : ''}. Count the stock again.`;
      cls = 'cc-bad';
    }
    // A waste report still waiting: its goods are binned but still on the
    // books, so the count would show them as missing. Decided first.
    const waste = Number(today.pending_disposals) || 0;
    if (waste > 0) {
      el.innerHTML = `<div class="cc-box cc-wait"><h4>&#9203; Step 1 &mdash; waiting for waste reports</h4>
        <div>${waste} waste report${waste === 1 ? ' is' : 's are'} waiting for an admin. The stock is counted once ${waste === 1 ? 'it is' : 'they are'} approved or rejected.</div></div>`;
      return;
    }
    el.innerHTML = `<div class="cc-box ${cls}"><h4>${head}</h4><div>${msg}</div>
      <div class="cc-row"><button class="cc-btn cc-primary" onclick="Closing.startCount(this)">Start stock sync</button></div></div>`;
  }

  async function startCount(btn) {
    await cfg.withBusy(btn, async () => {
      countItems = await api('/api/cash/stock-sync/items');
      counting = true;
      renderSync();
    }, 'Loading…');
  }

  // What has been typed so far, by "kind:id", so a reloaded list (something
  // arrived, or changed while being counted) keeps every other figure.
  function typedCounts() {
    const typed = {};
    countItems.forEach((it, i) => {
      const inp = document.getElementById(`cc-count-${i}`);
      if (inp && inp.value !== '') typed[`${it.kind}:${it.id}`] = inp.value;
    });
    return typed;
  }

  // The blind count: names and units only. Blank is not 0 — every listed item
  // has to be counted on purpose, and "0" typed in is a real count. `keep`
  // refills figures already typed; `flag` marks the items to count again.
  function renderCountForm(keep, flag) {
    keep = keep || {};
    flag = flag || new Set();
    const el = cfg.sync;
    if (!countItems.length) {
      el.innerHTML = `<div class="cc-box cc-step" data-role="count-form"><h4>&#128230; Step 1 &mdash; sync the stock</h4>
        <div>Nothing ticked for the daily stock sync has stock right now, so there is nothing to count.</div>
        <div class="cc-muted">An admin chooses what is counted with the Daily sync ticks on the Stock page.</div>
        <div class="cc-row"><button class="cc-btn cc-primary" onclick="Closing.submitCount(this)">Confirm</button>
        <button class="cc-btn" onclick="Closing.cancelCount()">Cancel</button></div></div>`;
      return;
    }
    let lastCat = null;
    const rows = countItems.map((it, i) => {
      const cat = `${it.kind === 'product' ? 'Products' : 'Store room'} · ${it.category || ''}`;
      const catRow = cat !== lastCat ? `<tr><td colspan="2" class="cc-cat">${esc(cat)}</td></tr>` : '';
      lastCat = cat;
      const key = `${it.kind}:${it.id}`;
      const again = flag.has(key);
      const val = !again && keep[key] != null ? ` value="${esc(keep[key])}"` : '';
      // Products are whole pieces; store-room items may be 2.5 kg.
      const step = it.kind === 'product' ? '1' : 'any';
      return `${catRow}<tr${again ? ' style="background:#fff7ed;"' : ''}><td>${esc(it.name)} <span class="cc-muted">${esc(it.unit || '')}</span>${again ? ' <strong class="cc-diff-pos">count again</strong>' : ''}</td>
        <td class="num"><input class="cc-input" type="number" min="0" step="${step}" inputmode="${it.kind === 'product' ? 'numeric' : 'decimal'}" id="cc-count-${i}"${val} aria-label="Count of ${esc(it.name)}"></td></tr>`;
    }).join('');
    el.innerHTML = `<div class="cc-box cc-step" data-role="count-form"><h4>&#128230; Step 1 &mdash; count the stock (${countItems.length} item${countItems.length === 1 ? '' : 's'})</h4>
      <div class="cc-muted">Count what is actually there and type it in. Type 0 if it is gone.</div>
      <table class="cc-table"><thead><tr><th>Item</th><th class="num">Counted</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="cc-row"><button class="cc-btn cc-success" onclick="Closing.submitCount(this)">Submit count</button>
      <button class="cc-btn" onclick="Closing.cancelCount()">Cancel</button></div></div>`;
  }

  function cancelCount() { counting = false; renderSync(); }

  async function submitCount(btn, creds) {
    const counts = [];
    for (let i = 0; i < countItems.length; i++) {
      const raw = (document.getElementById(`cc-count-${i}`) || {}).value;
      if (raw === '' || raw == null) { cfg.notify(`Enter a count for ${countItems[i].name} (0 if there are none).`, 'error'); document.getElementById(`cc-count-${i}`).focus(); return; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) { cfg.notify(`The count for ${countItems[i].name} must be 0 or more.`, 'error'); return; }
      if (countItems[i].kind === 'product' && !Number.isInteger(n)) { cfg.notify(`${countItems[i].name} is counted in whole pieces.`, 'error'); return; }
      counts.push({ kind: countItems[i].kind, id: countItems[i].id, counted: n, token: countItems[i].token });
    }
    await cfg.withBusy(btn, async () => {
      let res;
      try {
        res = await api('/api/cash/stock-sync', { method: 'POST', body: { counts, ...(creds || {}) } });
      } catch (err) {
        // The list moved under the count: reload it, keep every figure typed,
        // and clear (and mark) only the items that must be counted again.
        if (err && err.data && err.data.list_changed) {
          cfg.notify(err.message, 'error');
          const keep = typedCounts();
          const flag = new Set((err.data.changed || []).map((c) => `${c.kind}:${c.id}`));
          countItems = await api('/api/cash/stock-sync/items');
          for (const it of countItems) if (keep[`${it.kind}:${it.id}`] == null) flag.add(`${it.kind}:${it.id}`);
          renderCountForm(keep, flag);
          return;
        }
        // Someone else's count is already waiting on the admin.
        if (err && err.data && err.data.sync_pending) {
          counting = false;
          cfg.notify(err.message, 'error');
          await refresh();
          return;
        }
        throw err;
      }
      counting = false;
      const s = res.sync;
      if (s.status === 'matched') cfg.notify('Stock matches the system. Step 1 done.');
      else if (s.status === 'approved') cfg.notify(`${s.mismatch_count} difference(s) approved and stock updated.`);
      else cfg.notify(`${s.mismatch_count} item(s) did not match. An admin has been asked to approve.`, 'error');
      await refresh();
    }, 'Saving…');
  }

  // ----- The admin at the till: password, then the same review ------------------
  function dialog(html) {
    closeDialog();
    const ov = document.createElement('div');
    ov.className = 'cc-overlay';
    ov.id = 'cc-overlay';
    ov.innerHTML = `<div class="cc-dialog">${html}</div>`;
    ov.addEventListener('click', (e) => { if (e.target === ov) closeDialog(); });
    document.body.appendChild(ov);
    return ov;
  }
  function closeDialog() { const o = document.getElementById('cc-overlay'); if (o) o.remove(); }

  // Ask for an admin's username and password; resolves with them, or null if
  // cancelled. Also used outside the Cash pages (a refund on the Bills pages),
  // where Closing.init() never ran — so it needs nothing from cfg.
  function askAdmin(title, explain) {
    injectStyles();
    return new Promise((resolve) => {
      const ov = dialog(`<h4 style="margin:0 0 6px;font-weight:700;">${esc(title)}</h4>
        <div class="cc-muted">${esc(explain)}</div>
        <label for="cc-adm-user">Admin username</label><input class="cc-text" id="cc-adm-user" autocomplete="off">
        <label for="cc-adm-pass">Admin password</label><input class="cc-text" id="cc-adm-pass" type="password" autocomplete="off">
        <div class="cc-muted" id="cc-adm-err" style="color:#dc2626;display:none;margin-top:6px;"></div>
        <div class="cc-row"><button class="cc-btn cc-primary" id="cc-adm-go">Continue</button><button class="cc-btn" id="cc-adm-cancel">Cancel</button></div>`);
      const done = (v) => { closeDialog(); resolve(v); };
      ov.querySelector('#cc-adm-cancel').onclick = () => done(null);
      const go = () => {
        const admin_username = ov.querySelector('#cc-adm-user').value.trim();
        const admin_password = ov.querySelector('#cc-adm-pass').value;
        if (!admin_username || !admin_password) {
          const e = ov.querySelector('#cc-adm-err');
          e.textContent = 'Enter the admin username and password.';
          e.style.display = 'block';
          return;
        }
        // The dialog closes; the credentials live only in this call.
        done({ admin_username, admin_password });
      };
      ov.querySelector('#cc-adm-go').onclick = go;
      ov.querySelector('#cc-adm-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      setTimeout(() => ov.querySelector('#cc-adm-user').focus(), 50);
    });
  }

  async function adminApproveSync(syncId) {
    const creds = await askAdmin('Admin approval — stock count', 'The admin checks the counts against the system and approves (correcting any figure) or rejects.');
    if (!creds) return;
    let data;
    try {
      data = await api(`/api/cash/stock-sync/${Number(syncId)}/admin-view`, { method: 'POST', body: creds });
    } catch (err) {
      cfg.notify((err && err.message) || 'Could not open the count', 'error');
      return;
    }
    const ov = dialog(`<h4 style="margin:0 0 6px;font-weight:700;">Stock count &mdash; approve as admin</h4>
      <div class="cc-muted">Only items that did not match are listed. Change "Approve as" to correct a figure.</div>
      <div id="cc-review"></div>`);
    renderReview(ov.querySelector('#cc-review'), data.sync, creds, true);
  }

  // The admin's review of one stock sync: system vs counted for every line that
  // differs, an editable "approve as", and Approve / Reject. Used by the admin's
  // own queue (creds null) and at the till (creds from askAdmin).
  function renderReview(el, sync, creds, inDialog) {
    const off = (sync.lines || []).filter((l) => Math.abs(l.counted_qty - l.system_qty) > 1e-9);
    const rows = off.map((l) => {
      const d = l.counted_qty - l.system_qty;
      return `<tr><td>${esc(l.name)} <span class="cc-muted">${esc(l.unit || '')}</span></td>
        <td class="num">${qty(l.system_qty)}</td><td class="num">${qty(l.counted_qty)}</td>
        <td class="num ${d < 0 ? 'cc-diff-neg' : 'cc-diff-pos'}">${d > 0 ? '+' : ''}${qty(d)}</td>
        <td class="num"><input class="cc-input" type="number" min="0" step="any" data-line="${Number(l.id)}" data-orig="${esc(String(l.counted_qty))}" value="${esc(String(l.counted_qty))}"></td></tr>`;
    }).join('');
    el.innerHTML = `<div class="cc-muted">Counted by ${esc(sync.user_name || '-')} at ${esc(time(sync.created_at))} &middot; ${(sync.lines || []).length} item(s), ${off.length} did not match.</div>
      <table class="cc-table"><thead><tr><th>Item</th><th class="num">System</th><th class="num">Counted</th><th class="num">Diff</th><th class="num">Approve as</th></tr></thead><tbody>${rows}</tbody></table>
      <label class="cc-muted" style="display:block;margin-top:8px;">Note (needed to reject)</label><input class="cc-text" data-role="note" placeholder="e.g. 2 cakes given to staff">
      <div class="cc-row"><button class="cc-btn cc-success" data-act="approve">Approve &amp; update stock</button>
      <button class="cc-btn cc-danger" data-act="reject">Reject &mdash; count again</button>
      ${inDialog ? '<button class="cc-btn" data-act="cancel">Cancel</button>' : ''}</div>`;
    const decide = async (btn, approve) => {
      const note = el.querySelector('[data-role="note"]').value.trim();
      if (!approve && !note) { cfg.notify('Say why it is rejected', 'error'); return; }
      // Only figures the admin actually changed are sent as corrections; a line
      // left alone is approved exactly as counted (no rounding on the way).
      const corrections = [];
      for (const inp of el.querySelectorAll('input[data-line]')) {
        if (inp.value === inp.dataset.orig) continue;
        const v = Number(inp.value);
        if (inp.value === '' || !Number.isFinite(v) || v < 0) { cfg.notify('Approved figures must be 0 or more', 'error'); return; }
        corrections.push({ line_id: Number(inp.dataset.line), approved_qty: v });
      }
      await cfg.withBusy(btn, async () => {
        await api(`/api/cash/stock-sync/${Number(sync.id)}/${approve ? 'approve' : 'reject'}`, {
          method: 'POST', body: { note, ...(approve ? { corrections } : {}), ...(creds || {}) },
        });
        if (inDialog) closeDialog();
        cfg.notify(approve ? 'Stock count approved — stock updated' : 'Stock count rejected');
        await refresh();
      }, approve ? 'Approving…' : 'Rejecting…');
    };
    el.querySelector('[data-act="approve"]').onclick = (e) => decide(e.currentTarget, true);
    el.querySelector('[data-act="reject"]').onclick = (e) => decide(e.currentTarget, false);
    const cancel = el.querySelector('[data-act="cancel"]');
    if (cancel) cancel.onclick = closeDialog;
  }

  // ----- Step 2's gate: a variance over the limit --------------------------------
  function needsApproval(body, data) {
    gateBody = body;
    gateInfo = data;
    renderGate();
  }

  function renderGate() {
    const el = cfg.gate;
    if (!el) return;
    if (!shiftOpen()) { el.innerHTML = ''; return; }
    const r = today.close_request;
    const lim = cfg.money(today.variance_limit ?? 200);
    const word = (v) => `${v > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(v))}`;
    // A count the server just refused is NEWER than any request on record
    // (the cashier counted again), so it wins: requesting replaces the old
    // request, and an old approval no longer applies to this count.
    if (gateInfo && gateBody) {
      const older = r && (r.status === 'pending' || r.status === 'approved')
        ? `<div class="cc-muted">This replaces the earlier ${r.status === 'pending' ? 'request still waiting' : 'approval'} (counted ${cfg.money(r.total_amount)}).</div>` : '';
      el.innerHTML = `<div class="cc-box cc-bad"><h4>&#9888;&#65039; The drawer is ${word(gateInfo.variance)}</h4>
        <div>That is more than the ${lim} allowed, so an admin has to approve this close.</div>${older}
        <div class="cc-row"><button class="cc-btn cc-primary" onclick="Closing.requestApproval(this)">Request admin approval</button>
        <button class="cc-btn" onclick="Closing.adminApproveClose()">Admin: approve here</button></div></div>`;
      return;
    }
    if (r && r.status === 'pending') {
      el.innerHTML = `<div class="cc-box cc-wait"><h4>&#9203; Waiting for an admin to approve the close</h4>
        <div>Counted ${cfg.money(r.total_amount)} &mdash; ${word(r.variance)} (limit ${lim}). Asked by ${esc(r.user_name || '-')} at ${esc(time(r.created_at))}.</div>
        <div class="cc-muted">Count again and save if the count was wrong; that replaces this request.</div>
        ${cfg.isAdmin ? '' : `<div class="cc-row"><button class="cc-btn cc-primary" onclick="Closing.adminApproveRequest(${Number(r.id)})">Admin: approve here</button></div>`}</div>`;
      return;
    }
    if (r && r.status === 'approved') {
      el.innerHTML = `<div class="cc-box cc-ok"><h4>&#9989; ${esc(r.decided_by_name || 'An admin')} approved closing</h4>
        <div>On the count of ${cfg.money(r.total_amount)} (${word(r.variance)})${r.decision_note ? ` &mdash; &ldquo;${esc(r.decision_note)}&rdquo;` : ''}.</div>
        <div class="cc-row"><button class="cc-btn cc-success" onclick="Closing.closeOnRequest(${Number(r.id)}, this)">Close the drawer now</button></div></div>`;
      return;
    }
    el.innerHTML = r && r.status === 'rejected'
      ? `<div class="cc-box cc-bad"><h4>&#10060; Close rejected</h4><div>${esc(r.decided_by_name || 'The admin')}: &ldquo;${esc(r.decision_note || '')}&rdquo;. Count the drawer again.</div></div>`
      : '';
  }

  // The drawer count on screen changed: a refused count waiting for "request" /
  // "approve here" is not this count any more, so it must not be sent.
  function clearGate() {
    if (!gateBody) return;
    gateBody = null;
    gateInfo = null;
    renderGate();
  }

  async function requestApproval(btn) {
    if (!gateBody) return;
    await cfg.withBusy(btn, async () => {
      await api('/api/cash/close-requests', { method: 'POST', body: gateBody });
      gateBody = null; gateInfo = null;
      cfg.notify('Sent to the admin for approval');
      await refresh();
    }, 'Sending…');
  }

  // The admin types their password and the close goes through at once, on the
  // count that was refused.
  async function adminApproveClose() {
    if (!gateBody) return;
    const creds = await askAdmin('Admin approval — drawer variance', `Closing ${gateInfo.variance > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(gateInfo.variance))}. The admin's password approves it.`);
    if (!creds) return;
    try {
      const res = await api('/api/cash/close', { method: 'POST', body: { ...gateBody, ...creds } });
      gateBody = null; gateInfo = null;
      cfg.notify(`Drawer closed with the admin's approval (${res.variance > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(res.variance))})`);
      if (cfg.onClosed) await cfg.onClosed();
    } catch (err) {
      cfg.notify((err && err.message) || 'Could not close', 'error');
      await refresh();
    }
  }

  // A request is waiting and the admin is at the till: approve it, then close on it.
  async function adminApproveRequest(reqId) {
    const creds = await askAdmin('Admin approval — drawer variance', 'Approving closes the drawer on the count that was sent.');
    if (!creds) return;
    try {
      await api(`/api/cash/close-requests/${Number(reqId)}/approve`, { method: 'POST', body: creds });
      const res = await api('/api/cash/close', { method: 'POST', body: { close_request_id: reqId } });
      cfg.notify(`Drawer closed with the admin's approval (${res.variance > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(res.variance))})`);
      if (cfg.onClosed) await cfg.onClosed();
    } catch (err) {
      cfg.notify((err && err.message) || 'Could not approve', 'error');
      await refresh();
    }
  }

  async function closeOnRequest(reqId, btn) {
    await cfg.withBusy(btn, async () => {
      let res;
      try {
        res = await api('/api/cash/close', { method: 'POST', body: { close_request_id: reqId } });
      } catch (err) {
        // Refused (stock moved, cash moved): show why, and bring the panels up
        // to date so the screen stops offering a close that cannot happen.
        cfg.notify((err && err.message) || 'Could not close', 'error');
        await refresh();
        return;
      }
      cfg.notify(`Drawer closed (${res.variance > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(res.variance))}, approved)`);
      if (cfg.onClosed) await cfg.onClosed();
    }, 'Closing…');
  }

  // ----- The admin's queue -------------------------------------------------------
  let approvalsKey = '';
  async function renderApprovals() {
    const el = cfg.approvals;
    if (!el) return;
    // Refunds can wait on the admin with no shift open, so the queue is looked
    // at whatever the shift is doing.
    if (!cfg.isAdmin) { el.innerHTML = ''; approvalsKey = ''; return; }
    let q;
    try { q = await api('/api/cash/approvals'); } catch { return; }
    const refunds = q.refund_requests || [];
    // Same items still waiting: leave the panel (and any figure being corrected) as it is.
    const key = q.stock_syncs.map((s) => 's' + s.id).concat(q.close_requests.map((r) => 'r' + r.id), refunds.map((f) => 'f' + f.id)).join(',');
    if (key === approvalsKey && el.innerHTML) return;
    approvalsKey = key;
    if (!q.stock_syncs.length && !q.close_requests.length && !refunds.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="cc-box cc-wait"><h4>&#128276; Waiting for your approval</h4>
      ${refunds.map((f) => `<div style="margin-top:10px;" data-refund="${Number(f.id)}">${refundRequestHtml(f)}
        <input class="cc-text" data-role="note" placeholder="Note (needed to reject)" style="margin-top:6px;">
        <div class="cc-row"><button class="cc-btn cc-success" data-act="approve">Approve refund</button><button class="cc-btn cc-danger" data-act="reject">Reject</button></div></div>`).join('')}
      ${q.stock_syncs.map((s) => `<div style="margin-top:10px;"><strong>Stock count</strong><div data-sync="${Number(s.id)}"></div></div>`).join('')}
      ${q.close_requests.map((r) => `<div style="margin-top:12px;" data-req="${Number(r.id)}"><strong>Close the drawer</strong>
        <div>${esc(r.user_name || '-')} counted ${cfg.money(r.total_amount)} against ${cfg.money(r.expected_amount)} expected &mdash;
        <strong class="${r.variance < 0 ? 'cc-diff-neg' : 'cc-diff-pos'}">${r.variance > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(r.variance))}</strong> (limit ${cfg.money(today.variance_limit ?? 200)}).</div>
        ${Math.abs(r.expected_now - r.expected_amount) > 0.005 ? `<div class="cc-muted">Expected has moved to ${cfg.money(r.expected_now)} since — approving will not let it close; they need to count again.</div>` : ''}
        ${r.notes ? `<div class="cc-muted">Note: ${esc(r.notes)}</div>` : ''}
        <input class="cc-text" data-role="note" placeholder="Note (needed to reject)" style="margin-top:6px;">
        <div class="cc-row"><button class="cc-btn cc-success" data-act="approve">Approve close</button><button class="cc-btn cc-danger" data-act="reject">Reject &mdash; count again</button></div></div>`).join('')}
    </div>`;
    for (const f of refunds) {
      const box = el.querySelector(`[data-refund="${Number(f.id)}"]`);
      wireRefundDecision(box, f.id, null, refresh, cfg.notify, cfg.withBusy);
    }
    for (const s of q.stock_syncs) renderReview(el.querySelector(`[data-sync="${Number(s.id)}"]`), s, null, false);
    for (const r of q.close_requests) {
      const box = el.querySelector(`[data-req="${Number(r.id)}"]`);
      const decide = async (btn, approve) => {
        const note = box.querySelector('[data-role="note"]').value.trim();
        if (!approve && !note) { cfg.notify('Say why it is rejected', 'error'); return; }
        await cfg.withBusy(btn, async () => {
          await api(`/api/cash/close-requests/${Number(r.id)}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: { note } });
          cfg.notify(approve ? 'Close approved — the cashier can close now' : 'Close rejected');
          await refresh();
        }, '…');
      };
      box.querySelector('[data-act="approve"]').onclick = (e) => decide(e.currentTarget, true);
      box.querySelector('[data-act="reject"]').onclick = (e) => decide(e.currentTarget, false);
    }
  }

  // ----- Refund requests (shared with the Bills pages) --------------------------
  const payWord = (m) => ({ cash: 'Cash', card: 'Card', upi: 'LankaQR' })[m] || (m || '-');
  const rs = (n) => 'Rs. ' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

  /** One waiting refund, described for the admin deciding it. */
  function refundRequestHtml(f) {
    return `<strong>Refund bill #${String(f.token_number).padStart(3, '0')}</strong> &mdash; ${rs(f.total)} (${esc(payWord(f.payment_method))})
      <div>Asked by ${esc(f.user_name || '-')} at ${esc(time(f.created_at))}: &ldquo;${esc(f.reason)}&rdquo;</div>
      <div class="cc-muted">${f.restock ? 'Items WILL be put back into stock.' : 'Items will NOT be put back into stock.'}</div>`;
  }

  /**
   * Wire Approve / Reject on a refund request box (a [data-act] pair and a
   * [data-role="note"] input). creds: an admin's typed-in password, or null
   * for an admin's own login. Approving IS the refund.
   */
  function wireRefundDecision(box, requestId, creds, after, notify, busy) {
    const decide = async (btn, approve) => {
      const note = (box.querySelector('[data-role="note"]') || {}).value?.trim() || '';
      if (!approve && !note) { notify('Say why the refund is rejected', 'error'); return; }
      await busy(btn, async () => {
        await api(`/api/pos/refund-requests/${Number(requestId)}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: { note, ...(creds || {}) } });
        notify(approve ? 'Refund approved — the bill is refunded' : 'Refund rejected');
        await after(approve);
      }, '…');
    };
    box.querySelector('[data-act="approve"]').onclick = (e) => decide(e.currentTarget, true);
    box.querySelector('[data-act="reject"]').onclick = (e) => decide(e.currentTarget, false);
  }

  return {
    askAdmin, refundRequestHtml, wireRefundDecision,
    init, update, refresh, closeAllowed, needsApproval, clearGate,
    startCount, cancelCount, submitCount, adminApproveSync,
    requestApproval, adminApproveClose, adminApproveRequest, closeOnRequest,
  };
})();
