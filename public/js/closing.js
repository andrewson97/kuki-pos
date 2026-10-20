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
//     drawer: el,                         // who holds the drawer: handover, takeover, my account
//     userId,                             // the logged-in user's id
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
//   Closing.closeBlockReason()            // why this user cannot close now (not the holder, a handover), or ''
//   Closing.withChargeDecision(send)      // send(extra) again with the admin's charge/write-off when the server asks (undefined = cancelled)
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
      .cc-charge { margin-top: 8px; padding: 8px 10px; border: 1px dashed #fca5a5; border-radius: 8px; background: #fff; }
      .cc-charge label.cc-opt { display: flex; align-items: center; gap: 6px; font-weight: 600; margin: 4px 0; font-size: 0.88rem; }
      .cc-denoms { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; margin-top: 6px; }
      .cc-denoms .cc-input { width: 100%; max-width: 120px; }
      .cc-total { font-size: 1.05rem; font-weight: 700; margin-top: 8px; }
      .cc-you { background: #dbeafe; color: #1e40af; border-radius: 999px; padding: 1px 8px; font-size: 0.75rem; font-weight: 700; margin-left: 4px; }
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

  const isMe = (id) => cfg.userId != null && Number(id) === Number(cfg.userId);

  /** Why this user cannot close the drawer right now, or '' (the server says the same). */
  function closeBlockReason() {
    if (!shiftOpen()) return '';
    const h = today.handover;
    if (h) return `The drawer is being handed over to ${h.to_name || 'someone'}. That has to be accepted, declined or cancelled before closing.`;
    if (!today.is_holder && !cfg.isAdmin) return `${(today.holder && today.holder.name) || 'Someone else'} holds the drawer, so only they (or an admin) can close it.`;
    return '';
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
    if (!shiftOpen()) {
      if (today.open_request && today.open_request.status === 'pending') pollTimer = setTimeout(refresh, 15000);
      else if (cfg.isAdmin) pollTimer = setTimeout(refresh, 60000);
      return;
    }
    const s = syncState();
    const waiting = (s && s.sync && s.sync.status === 'pending') ||
      !!today.handover || // a handover moves on when the other person answers
      (today.close_request && today.close_request.status === 'pending') ||
      (today.pending_refunds || 0) > 0 || // the Close button unlocks once they are decided
      (today.pending_disposals || 0) > 0; // and Step 1 opens once waste reports are
    if (waiting) pollTimer = setTimeout(refresh, 15000);
    // An admin, or someone the drawer could be handed to: a slow look.
    else if (cfg.isAdmin || !today.is_holder) pollTimer = setTimeout(refresh, 60000);
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
    renderDrawer();
    renderSync();
    renderGate();
    renderApprovals();
  }

  // ----- The drawer holder: handover, takeover, my account ---------------------
  // One person answers for the drawer at a time (src/routes/cash.ts). Only they
  // (or an admin) take cash and close it; a handover passes it on, with both
  // people counting the cash; an admin can take it over from someone who left.
  const DENOMS = [5000, 2000, 1000, 500, 100, 50, 20];
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // A drawer count inside a dialog: notes and coins, with a running total.
  function denomHtml() {
    return `<div class="cc-denoms">${DENOMS.map((d) => `<span>Rs. ${d} &times;</span><input class="cc-input" type="number" min="0" step="1" inputmode="numeric" data-denom="${d}" value="0">`).join('')}
      <span>Coins (Rs)</span><input class="cc-input" type="number" min="0" step="any" inputmode="decimal" data-role="coins" value="0"></div>
      <div class="cc-total">Counted: <span data-role="counted">${cfg.money(0)}</span></div>`;
  }
  function readDenoms(root) {
    const body = {};
    let total = 0;
    for (const inp of root.querySelectorAll('input[data-denom]')) {
      const n = Math.max(0, parseInt(inp.value, 10) || 0);
      body[`notes_${inp.dataset.denom}`] = n;
      total += n * Number(inp.dataset.denom);
    }
    const coins = Math.max(0, parseFloat(root.querySelector('[data-role="coins"]').value) || 0);
    body.coins_total = round2(coins);
    return { body, total: round2(total + coins) };
  }
  function wireDenoms(root, onChange) {
    const upd = () => {
      const { total } = readDenoms(root);
      root.querySelector('[data-role="counted"]').textContent = cfg.money(total);
      if (onChange) onChange(total);
    };
    root.querySelectorAll('.cc-denoms input').forEach((i) => i.addEventListener('input', upd));
    upd();
  }

  // The admin's choice on a shortage: charge it to someone's pending account
  // (the default) or write it off with a reason. `editable` lets the admin set
  // the amount (a stock item with no price, say).
  let chargeSeq = 0;
  // `who`: one name, or a list of { key, label } when the admin chooses who
  // is charged (an opening shortfall: the last holder or the opener).
  function chargeHtml(amount, who, editable, hint) {
    const n = ++chargeSeq;
    const amountBox = editable ? `&nbsp;Rs <input class="cc-input" type="number" min="0" step="any" data-role="charge-amount" value="${esc(String(round2(amount)))}">` : '';
    const options = Array.isArray(who)
      ? who.map((o, i) => `<label class="cc-opt"><input type="radio" name="cc-ch-${n}" value="charge:${esc(o.key)}"${i === 0 ? ' checked' : ''}> Charge to ${esc(o.label || o.name)}${i === 0 ? amountBox : ''}</label>`).join('')
      : `<label class="cc-opt"><input type="radio" name="cc-ch-${n}" value="charge" checked> Charge to ${esc(who || 'the holder')}'s pending account
        ${amountBox}</label>`;
    return `<div class="cc-charge" data-role="charge" data-amount="${esc(String(round2(amount)))}">
      <div>Short by <strong class="cc-diff-neg">${cfg.money(amount)}</strong>${hint ? ` <span class="cc-muted">${hint}</span>` : ''}</div>
      ${options}
      <label class="cc-opt"><input type="radio" name="cc-ch-${n}" value="write_off"> Write it off</label>
      <input class="cc-text" data-role="write-off-note" placeholder="Why it is written off (needed to write off)">
    </div>`;
  }
  /** {} when there is no choice on screen; the body fields; or an error string. */
  function readCharge(root) {
    const box = root && root.querySelector('[data-role="charge"]');
    if (!box || box.style.display === 'none') return {};
    const pick = box.querySelector('input[type="radio"]:checked');
    if (pick && pick.value === 'write_off') {
      const note = box.querySelector('[data-role="write-off-note"]').value.trim();
      if (!note) return 'Say why the shortage is written off.';
      return { charge: false, write_off_note: note };
    }
    const to = pick && pick.value.startsWith('charge:') ? { charge_to: pick.value.slice(7) } : {};
    const amt = box.querySelector('[data-role="charge-amount"]');
    // Only an amount the admin changed is sent; otherwise the server works it
    // out (on the approved figures, after any correction).
    if (amt && amt.value !== box.dataset.amount) {
      const v = Number(amt.value);
      if (amt.value === '' || !Number.isFinite(v) || v < 0) return 'The amount to charge must be 0 or more.';
      return { charge: true, charge_amount: v, ...to };
    }
    return { charge: true, ...to };
  }
  // The same choice as a dialog, for the flows that have no panel of their own.
  function askCharge(amount, who, title) {
    return new Promise((resolve) => {
      const ov = dialog(`<h4 style="margin:0 0 6px;font-weight:700;">${esc(title || 'The shortage')}</h4>
        <div class="cc-muted">Approving a shortage either charges it to someone's pending account, or writes it off.</div>
        ${chargeHtml(amount, who, false)}
        <div class="cc-row"><button class="cc-btn cc-primary" data-act="go">Continue</button><button class="cc-btn" data-act="cancel">Cancel</button></div>`);
      ov.querySelector('[data-act="cancel"]').onclick = () => { closeDialog(); resolve(null); };
      ov.querySelector('[data-act="go"]').onclick = () => {
        const c = readCharge(ov);
        if (typeof c === 'string') { notifyIn(ov, c); return; }
        closeDialog();
        resolve(c);
      };
    });
  }
  function notifyIn(ov, msg) {
    let e = ov.querySelector('[data-role="err"]');
    if (!e) {
      e = document.createElement('div');
      e.dataset.role = 'err';
      e.style.cssText = 'color:#dc2626;font-size:0.85rem;margin-top:6px;';
      ov.querySelector('.cc-row').before(e);
    }
    e.textContent = msg;
  }

  /**
   * The server never charges a shortage by default: settling one (an admin's
   * close, stock count, approval or takeover) without saying "charge" or
   * "write off" is refused with 409 needs_charge_decision and the amount, on
   * the server's own figures. This sends, and on that refusal asks the admin
   * and sends again with their answer. send(extra) does the request with
   * `extra` merged into its body. Resolves undefined if the admin cancels.
   */
  async function withChargeDecision(send) {
    try {
      return await send({});
    } catch (err) {
      if (!(err && err.status === 409 && err.data && err.data.needs_charge_decision)) throw err;
      const c = await askCharge(err.data.amount, err.data.charge_options || (err.data.charge_to && err.data.charge_to.name), 'The shortage');
      if (!c) return undefined;
      return await send(c);
    }
  }

  function renderDrawer() {
    const el = cfg.drawer;
    if (!el) return;
    const owe = Number(today && today.my_balance) || 0;
    const account = owe > 0.005
      ? `<div class="cc-muted" style="margin-top:6px;">Your pending account: <strong class="cc-diff-neg">${cfg.money(owe)}</strong> owed for shortages. <a href="#" onclick="Closing.showMyAccount();return false;">See why</a></div>`
      : '';
    if (!shiftOpen()) {
      const k = today.carry;
      if (!k) { el.innerHTML = account ? `<div class="cc-box">${account}</div>` : ''; return; }
      // Only admins get `carry`: the opener counts blind.
      const rows = (k.collections || []).map((x) => `<tr><td>${esc(time(x.created_at))}</td><td>${esc(x.user_name || '-')}${x.note ? ` &middot; <span class="cc-muted">${esc(x.note)}</span>` : ''}</td>
        <td class="num">${cfg.money(x.amount)}</td><td class="num"><button class="cc-btn cc-danger" style="padding:2px 8px;" onclick="Closing.voidCollection(${Number(x.id)}, this)">Remove</button></td></tr>`).join('');
      el.innerHTML = `<div class="cc-box cc-step"><h4>&#128176; Cash in the drawer since the last close</h4>
        <div>Closed at ${esc(time(k.closed_at))} by ${esc(k.closed_by || '-')} with <strong>${cfg.money(k.close_total)}</strong> counted.
          Collected: <strong>${cfg.money(k.collected)}</strong>. Left in the drawer: <strong>${cfg.money(k.carried)}</strong> &mdash; the next opening has to count exactly this.</div>
        ${rows ? `<table class="cc-table"><tbody>${rows}</tbody></table>` : ''}
        <div class="cc-row"><button class="cc-btn cc-primary" onclick="Closing.recordCollection(this)">Record cash collected</button></div>
        <div class="cc-muted">Anything missing at the next opening is ${esc(k.holder ? k.holder.name : 'the last holder')}'s or the opener's, as you decide then.</div>${account}</div>`;
      return;
    }
    const holder = today.holder || {};
    const h = today.handover;
    const you = today.is_holder ? '<span class="cc-you">you</span>' : '';
    let body = '';
    let cls = '';
    if (h && h.status === 'pending') {
      cls = 'cc-wait';
      if (isMe(h.to_user_id)) {
        body = `<div><strong>${esc(h.from_name)}</strong> is handing the drawer to you. Count the cash yourself, then accept it. From then on, the drawer is yours to answer for.</div>
          ${h.giver_notes ? `<div class="cc-muted">Their note: &ldquo;${esc(h.giver_notes)}&rdquo;</div>` : ''}
          <div class="cc-row"><button class="cc-btn cc-success" onclick="Closing.acceptHandover(${Number(h.id)})">Count &amp; accept</button>
          <button class="cc-btn cc-danger" onclick="Closing.declineHandover(${Number(h.id)}, this)">Decline</button></div>`;
      } else if (isMe(h.from_user_id)) {
        body = `<div>Waiting for <strong>${esc(h.to_name)}</strong> to count the cash and accept. You counted ${cfg.money(h.giver_total)} (expected ${cfg.money(h.giver_expected)}).</div>
          <div class="cc-muted">Cash payments are paused until then &mdash; card and LankaQR still work.</div>
          <div class="cc-row"><button class="cc-btn cc-danger" onclick="Closing.cancelHandover(${Number(h.id)}, this)">Cancel the handover</button></div>`;
      } else {
        body = `<div>Being handed from <strong>${esc(h.from_name)}</strong> to <strong>${esc(h.to_name)}</strong>. Cash payments are paused until it is accepted.</div>
          ${cfg.isAdmin ? `<div class="cc-row"><button class="cc-btn cc-danger" onclick="Closing.cancelHandover(${Number(h.id)}, this)">Cancel the handover</button></div>` : ''}`;
      }
    } else if (h && h.status === 'awaiting_admin') {
      cls = 'cc-wait';
      const counted = h.receiver_total != null ? ` ${esc(h.to_name)} counted ${cfg.money(h.receiver_total)}${h.variance != null ? ` (${h.variance > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(h.variance))})` : ''}.` : '';
      body = `<div>The handover from <strong>${esc(h.from_name)}</strong> to <strong>${esc(h.to_name)}</strong> is waiting for an admin: the count was off by more than the allowance.${counted}</div>
        <div class="cc-muted">Cash payments are paused until an admin decides.${cfg.isAdmin ? ' Decide it in &ldquo;Waiting for your approval&rdquo; below.' : ''}</div>`;
    } else if (today.is_holder) {
      body = `<div>Only you (or an admin) take cash and close this drawer. Going off shift? Hand it over: count the stock (Step 1), then the cash, and the next person counts and accepts it.</div>
        <div class="cc-row"><button class="cc-btn cc-primary" onclick="Closing.startHandover(this)">Hand over the drawer</button></div>`;
    } else {
      body = `<div>Only ${esc(holder.name)} (or an admin) takes cash and closes this drawer &mdash; card and LankaQR are fine. Taking over? Ask them to hand it over to you.</div>
        ${cfg.isAdmin ? `<div class="cc-row"><button class="cc-btn" onclick="Closing.startTakeover(this)">Take over the drawer</button></div><div class="cc-muted">If ${esc(holder.name)} is not here: you count the stock and the cash, and any shortage is theirs.</div>` : ''}`;
    }
    el.innerHTML = `<div class="cc-box ${cls}"><h4>&#128188; Drawer held by ${esc(holder.name || '-')} ${you}</h4>${body}${account}</div>`;
  }

  async function startHandover(btn) {
    if (!closeAllowed()) {
      cfg.notify('Count the stock first (Step 1) — the next person takes the drawer and the stock as they are now.', 'error');
      return;
    }
    let people;
    try { people = await api('/api/cash/handovers/candidates'); } catch (err) { cfg.notify(err.message, 'error'); return; }
    if (!people.length) { cfg.notify('There is nobody else to hand the drawer to.', 'error'); return; }
    const ov = dialog(`<h4 style="margin:0 0 6px;font-weight:700;">Hand over the drawer</h4>
      <div class="cc-muted">Count the cash now. The other person counts it again without seeing your figure; anything short is charged to you once an admin approves it. Cash payments pause until they accept.</div>
      <label>Hand to</label><select class="cc-text" data-role="to"><option value="">Choose&hellip;</option>${people.map((p) => `<option value="${Number(p.id)}">${esc(p.full_name)}${p.role === 'admin' ? ' (admin)' : ''}</option>`).join('')}</select>
      <label>Your count</label>${denomHtml()}
      <div class="cc-muted">Expected in the drawer: ${cfg.money(today.expected_now || 0)} &middot; <span data-role="var"></span></div>
      <label>Note <span class="cc-muted">(optional)</span></label><input class="cc-text" data-role="note">
      <div class="cc-row"><button class="cc-btn cc-primary" data-act="go">Hand over</button><button class="cc-btn" data-act="cancel">Cancel</button></div>`);
    wireDenoms(ov, (t) => {
      const v = round2(t - (today.expected_now || 0));
      ov.querySelector('[data-role="var"]').textContent = Math.abs(v) < 0.005 ? 'matches' : `${v > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(v))}`;
    });
    ov.querySelector('[data-act="cancel"]').onclick = closeDialog;
    ov.querySelector('[data-act="go"]').onclick = async (e) => {
      const to = ov.querySelector('[data-role="to"]').value;
      if (!to) { notifyIn(ov, 'Choose who takes the drawer.'); return; }
      const { body } = readDenoms(ov);
      await cfg.withBusy(e.currentTarget, async () => {
        try {
          await api('/api/cash/handovers', { method: 'POST', body: { ...body, to_user_id: Number(to), notes: ov.querySelector('[data-role="note"]').value } });
        } catch (err) { notifyIn(ov, err.message); return; }
        closeDialog();
        cfg.notify('Handover sent. Cash payments are paused until it is accepted.');
        await refresh();
      }, 'Sending…');
    };
  }

  async function acceptHandover(id) {
    const ov = dialog(`<h4 style="margin:0 0 6px;font-weight:700;">Count &amp; accept the drawer</h4>
      <div class="cc-muted">Count every note and coin in the drawer yourself. Once you accept, the drawer is yours to answer for until you close it or hand it on.</div>
      ${denomHtml()}
      <label>Note <span class="cc-muted">(optional)</span></label><input class="cc-text" data-role="note">
      <div class="cc-row"><button class="cc-btn cc-success" data-act="go">Accept the drawer</button><button class="cc-btn" data-act="cancel">Cancel</button></div>`);
    wireDenoms(ov);
    ov.querySelector('[data-act="cancel"]').onclick = closeDialog;
    ov.querySelector('[data-act="go"]').onclick = async (e) => {
      const { body, total } = readDenoms(ov);
      if (!confirm(`You counted ${cfg.money(total)}. Accept the drawer on this count?`)) return;
      await cfg.withBusy(e.currentTarget, async () => {
        let res;
        try {
          res = await api(`/api/cash/handovers/${Number(id)}/accept`, { method: 'POST', body: { ...body, notes: ov.querySelector('[data-role="note"]').value } });
        } catch (err) { notifyIn(ov, err.message); return; }
        closeDialog();
        // The receiver is not told the variance (it would give away the expected figure).
        if (res.accepted) cfg.notify('You now hold the drawer.');
        else cfg.notify('Your count is off by more than the allowance, so an admin has to approve the handover.', 'error');
        await refresh();
      }, 'Saving…');
    };
  }

  async function declineHandover(id, btn) {
    const reason = prompt('Why are you declining? (the giver sees this)');
    if (reason == null) return;
    if (!reason.trim()) { cfg.notify('Say why, so the giver knows what to put right.', 'error'); return; }
    await cfg.withBusy(btn, async () => {
      await api(`/api/cash/handovers/${Number(id)}/decline`, { method: 'POST', body: { reason } });
      cfg.notify('Handover declined');
      await refresh();
    }, '…');
  }

  async function cancelHandover(id, btn) {
    if (!confirm('Cancel this handover? The drawer stays with the person handing it over.')) return;
    await cfg.withBusy(btn, async () => {
      await api(`/api/cash/handovers/${Number(id)}/cancel`, { method: 'POST', body: {} });
      cfg.notify('Handover cancelled — cash payments are back on');
      await refresh();
    }, '…');
  }

  // An admin takes the drawer from a holder who is not there. The stock is
  // counted first (for the absent holder — a shortage it finds is theirs).
  async function startTakeover(btn) {
    if (!closeAllowed()) {
      cfg.notify(`Count the stock first (Step 1). It is counted for ${today.holder ? today.holder.name : 'the holder'}, so a shortage it finds is theirs.`, 'error');
      return;
    }
    let people;
    try { people = await api('/api/cash/handovers/candidates'); } catch (err) { cfg.notify(err.message, 'error'); return; }
    const holderName = (today.holder && today.holder.name) || 'the holder';
    const limit = Number(today.variance_limit) || 0;
    const ov = dialog(`<h4 style="margin:0 0 6px;font-weight:700;">Take over the drawer from ${esc(holderName)}</h4>
      <div class="cc-muted">Count the cash now. Anything short is ${esc(holderName)}'s, decided as at a close.</div>
      <label>Who holds it next</label><select class="cc-text" data-role="to"><option value="">Me</option>${people.filter((p) => !(today.holder && Number(p.id) === Number(today.holder.id))).map((p) => `<option value="${Number(p.id)}">${esc(p.full_name)}</option>`).join('')}</select>
      <label>Your count</label>${denomHtml()}
      <div class="cc-muted">Expected in the drawer: ${cfg.money(today.expected_now || 0)} &middot; <span data-role="var"></span></div>
      <div data-role="charge-slot"></div>
      <label>Why</label><input class="cc-text" data-role="reason" placeholder="e.g. went home sick without handing over">
      <div class="cc-row"><button class="cc-btn cc-primary" data-act="go">Take over</button><button class="cc-btn" data-act="cancel">Cancel</button></div>`);
    let shown = null;
    wireDenoms(ov, (t) => {
      const v = round2(t - (today.expected_now || 0));
      ov.querySelector('[data-role="var"]').textContent = Math.abs(v) < 0.005 ? 'matches' : `${v > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(v))}`;
      // Over the allowance short: the admin decides now (charge or write off).
      const need = v < 0 && -v > limit + 0.005 ? round2(-v) : null;
      if (need !== shown) {
        shown = need;
        ov.querySelector('[data-role="charge-slot"]').innerHTML = need ? chargeHtml(need, holderName, false) : '';
      }
    });
    ov.querySelector('[data-act="cancel"]').onclick = closeDialog;
    ov.querySelector('[data-act="go"]').onclick = async (e) => {
      const reason = ov.querySelector('[data-role="reason"]').value.trim();
      if (!reason) { notifyIn(ov, 'Say why the drawer is taken over.'); return; }
      const c = readCharge(ov);
      if (typeof c === 'string') { notifyIn(ov, c); return; }
      const { body } = readDenoms(ov);
      const to = ov.querySelector('[data-role="to"]').value;
      await cfg.withBusy(e.currentTarget, async () => {
        try {
          // The dialog closes first: the charge question (if the server's
          // figure says short) opens a dialog of its own.
          closeDialog();
          const done = await withChargeDecision((extra) => api('/api/cash/handovers/takeover', { method: 'POST', body: { ...body, ...c, ...extra, reason, ...(to ? { to_user_id: Number(to) } : {}) } }));
          if (!done) return;
        } catch (err) { cfg.notify(err.message, 'error'); await refresh(); return; }
        closeDialog();
        cfg.notify('Drawer taken over');
        await refresh();
      }, 'Saving…');
    };
  }

  const kindWord = { cash_short: 'Cash short', stock_short: 'Stock short', charge: 'Charge', payment: 'Paid back', write_off: 'Written off' };
  /** A ledger as a table (shared with the admin's Users page). */
  function ledgerHtml(entries) {
    injectStyles(); // also used on the Users page, where Closing.init() never runs
    if (!entries.length) return '<div class="cc-muted">Nothing on this account.</div>';
    return `<table class="cc-table"><thead><tr><th>When</th><th>What</th><th class="num">Amount</th></tr></thead><tbody>${entries.map((e) => `<tr>
      <td class="cc-muted">${esc(time(e.created_at))}<br>${esc(String(e.created_at || '').slice(0, 10))}</td>
      <td><strong>${esc(kindWord[e.kind] || e.kind)}</strong>${e.note ? `<div class="cc-muted">${esc(e.note)}</div>` : ''}<div class="cc-muted">by ${esc(e.created_by_name || '-')}</div></td>
      <td class="num ${e.amount > 0 ? 'cc-diff-neg' : ''}">${e.amount > 0 ? '' : '&minus;'}${cfg ? cfg.money(Math.abs(e.amount)) : rs(Math.abs(e.amount))}</td></tr>`).join('')}</tbody></table>`;
  }
  async function showMyAccount() {
    let a;
    try { a = await api('/api/cash/accounts/me'); } catch (err) { cfg.notify(err.message, 'error'); return; }
    const ov = dialog(`<h4 style="margin:0 0 6px;font-weight:700;">Your pending account</h4>
      <div>You owe <strong class="${a.balance > 0 ? 'cc-diff-neg' : ''}">${cfg.money(Math.max(0, a.balance))}</strong> for shortages charged to you. An admin records what you pay back.</div>
      ${ledgerHtml(a.entries || [])}
      <div class="cc-row"><button class="cc-btn" data-act="cancel">Close</button></div>`);
    ov.querySelector('[data-act="cancel"]').onclick = closeDialog;
  }

  // ----- Cash collected after a close (admin) -----------------------------------
  async function recordCollection(btn) {
    const k = today && today.carry;
    if (!k) return;
    const ov = dialog(`<h4 style="margin:0 0 6px;font-weight:700;">Record cash collected</h4>
      <div class="cc-muted">The cash you are taking out of the drawer now (to the bank or the safe). ${cfg.money(k.carried)} is in it.</div>
      <label>Amount (Rs)</label><input class="cc-text" type="number" min="0" step="any" inputmode="decimal" data-role="amount">
      <div class="cc-muted" data-role="left"></div>
      <label>Note <span class="cc-muted">(optional)</span></label><input class="cc-text" data-role="note" placeholder="e.g. banked at BOC">
      <div class="cc-row"><button class="cc-btn cc-primary" data-act="go">Save</button><button class="cc-btn" data-act="cancel">Cancel</button></div>`);
    const amt = ov.querySelector('[data-role="amount"]');
    amt.addEventListener('input', () => {
      const v = Number(amt.value) || 0;
      ov.querySelector('[data-role="left"]').textContent = `Leaves ${cfg.money(round2(k.carried - v))} for the next opening.`;
    });
    setTimeout(() => amt.focus(), 50);
    ov.querySelector('[data-act="cancel"]').onclick = closeDialog;
    ov.querySelector('[data-act="go"]').onclick = async (e) => {
      const v = Number(amt.value);
      if (!(v > 0)) { notifyIn(ov, 'Enter the amount taken out.'); return; }
      await cfg.withBusy(e.currentTarget, async () => {
        try {
          await api('/api/cash/collections', { method: 'POST', body: { amount: v, note: ov.querySelector('[data-role="note"]').value } });
        } catch (err) { notifyIn(ov, err.message); return; }
        closeDialog();
        cfg.notify(`Recorded ${cfg.money(v)} collected`);
        await refresh();
      }, 'Saving…');
    };
  }
  async function voidCollection(id, btn) {
    if (!confirm('Remove this collection? (It stays on record as removed.)')) return;
    await cfg.withBusy(btn, async () => {
      await api(`/api/cash/collections/${Number(id)}/void`, { method: 'POST', body: {} });
      cfg.notify('Collection removed');
      await refresh();
    }, '…');
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
        ${today.is_holder || cfg.isAdmin ? '<div class="cc-row"><button class="cc-btn" onclick="Closing.startCount(this)">Sync again</button></div>' : ''}</div>`;
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
        : st.stale_reason === 'holder'
          ? 'The drawer has changed hands since the stock was last counted. The new holder counts it again before closing or handing over.'
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
    // The stock is counted by whoever answers for it (or an admin): a
    // shortage it finds goes on the holder's account.
    if (!today.is_holder && !cfg.isAdmin) {
      el.innerHTML = `<div class="cc-box ${cls}"><h4>${head}</h4><div>${esc((today.holder && today.holder.name) || 'The holder')} holds the drawer, so they count the stock for it.</div></div>`;
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
        res = await withChargeDecision((extra) => api('/api/cash/stock-sync', { method: 'POST', body: { counts, ...extra, ...(creds || {}) } }));
        if (!res) return; // the admin cancelled the charge decision: nothing was saved
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
      ${Number(sync.shortage_value) > 0 || (sync.unpriced_short_lines || []).length
        ? chargeHtml(Number(sync.shortage_value) || 0, sync.charge_to && sync.charge_to.name, true,
            `(products at selling price, store-room items at cost${(sync.unpriced_short_lines || []).length ? `; no price set for ${esc(sync.unpriced_short_lines.join(', '))} &mdash; set the amount` : ''}). Correcting a figure works it out again unless you change the amount.`)
        : ''}
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
      const charge = approve ? readCharge(el) : {};
      if (typeof charge === 'string') { cfg.notify(charge, 'error'); return; }
      await cfg.withBusy(btn, async () => {
        const done = await withChargeDecision((extra) => api(`/api/cash/stock-sync/${Number(sync.id)}/${approve ? 'approve' : 'reject'}`, {
          method: 'POST', body: { note, ...(approve ? { corrections, ...charge, ...extra } : {}), ...(creds || {}) },
        }));
        if (!done) return;
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
    gateInfo = data || {};
    renderGate();
  }

  function renderGate() {
    const el = cfg.gate;
    if (!el) return;
    if (!shiftOpen()) { renderOpenGate(el); return; }
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

  // Opening: a count that does not match what was left at the last close needs
  // an admin. Same three ways as a close: request (approved from their own
  // login), their password here, or (an admin) answering the charge question.
  function renderOpenGate(el) {
    const r = today.open_request;
    // The opener counts blind: a non-admin is never sent the difference.
    const word = (v) => v == null ? 'does not match what was left' : `${v > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(v))}`;
    if (gateInfo && gateBody) {
      el.innerHTML = `<div class="cc-box cc-bad"><h4>&#9888;&#65039; The count does not match what was left at the last close</h4>
        <div>${/several times/.test(gateInfo.error || '') ? esc(gateInfo.error) : 'Count it again, or ask an admin to approve opening on this count.'}</div>
        <div class="cc-row"><button class="cc-btn cc-primary" onclick="Closing.requestApproval(this)">Request admin approval</button>
        <button class="cc-btn" onclick="Closing.adminApproveClose()">Admin: approve here</button></div></div>`;
      return;
    }
    if (r && r.status === 'pending') {
      el.innerHTML = `<div class="cc-box cc-wait"><h4>&#9203; Waiting for an admin to approve the opening</h4>
        <div>Counted ${cfg.money(r.total_amount)} &mdash; ${word(r.variance)}. Asked by ${esc(r.user_name || '-')} at ${esc(time(r.created_at))}.</div>
        <div class="cc-muted">Count again and save if the count was wrong; that replaces this request.</div>
        ${cfg.isAdmin ? '' : `<div class="cc-row"><button class="cc-btn cc-primary" onclick="Closing.adminApproveRequest(${Number(r.id)})">Admin: approve here</button></div>`}</div>`;
      return;
    }
    if (r && r.status === 'approved') {
      const charged = r.charge_decision === 'charge' ? ` Charged to ${esc(r.charge_to_name || '-')}.` : r.charge_decision === 'write_off' ? ' Written off.' : '';
      el.innerHTML = `<div class="cc-box cc-ok"><h4>&#9989; ${esc(r.decided_by_name || 'An admin')} approved the opening</h4>
        <div>On the count of ${cfg.money(r.total_amount)} (${word(r.variance)}).${charged}${r.decision_note ? ` &ldquo;${esc(r.decision_note)}&rdquo;` : ''}</div>
        ${isMe(r.user_id) || cfg.isAdmin ? `<div class="cc-row"><button class="cc-btn cc-success" onclick="Closing.openOnRequest(${Number(r.id)}, this)">Open the drawer now</button></div>` : `<div class="cc-muted">${esc(r.user_name)} opens on it.</div>`}</div>`;
      return;
    }
    el.innerHTML = r && r.status === 'rejected'
      ? `<div class="cc-box cc-bad"><h4>&#10060; Opening rejected</h4><div>${esc(r.decided_by_name || 'The admin')}: &ldquo;${esc(r.decision_note || '')}&rdquo;. Count the drawer again.</div></div>`
      : '';
  }

  async function openOnRequest(reqId, btn) {
    await cfg.withBusy(btn, async () => {
      try {
        await api('/api/cash/open', { method: 'POST', body: { open_request_id: reqId } });
      } catch (err) {
        cfg.notify((err && err.message) || 'Could not open', 'error');
        await refresh();
        return;
      }
      cfg.notify('Drawer opened (approved)');
      if (cfg.onClosed) await cfg.onClosed();
    }, 'Opening…');
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
      await api(shiftOpen() ? '/api/cash/close-requests' : '/api/cash/open-requests', { method: 'POST', body: gateBody });
      gateBody = null; gateInfo = null;
      cfg.notify('Sent to the admin for approval');
      await refresh();
    }, 'Sending…');
  }

  // The admin types their password and the close goes through at once, on the
  // count that was refused.
  async function adminApproveClose() {
    if (!gateBody) return;
    const opening = !shiftOpen();
    // An opener is not told the difference (blind count); the admin sees it in the charge question.
    const what = gateInfo.variance == null ? 'on a count that does not match what was left' : `${gateInfo.variance > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(gateInfo.variance))}`;
    const creds = await askAdmin('Admin approval — drawer variance', `${opening ? 'Opening' : 'Closing'} ${what}. The admin's password approves it.`);
    if (!creds) return;
    try {
      const res = await withChargeDecision((extra) => api(opening ? '/api/cash/open' : '/api/cash/close', { method: 'POST', body: { ...gateBody, ...extra, ...creds } }));
      if (!res) return;
      gateBody = null; gateInfo = null;
      cfg.notify(`Drawer ${opening ? 'opened' : 'closed'} with the admin's approval (${res.variance > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(res.variance))})`);
      if (cfg.onClosed) await cfg.onClosed();
    } catch (err) {
      cfg.notify((err && err.message) || 'Could not close', 'error');
      await refresh();
    }
  }

  // A request is waiting and the admin is at the till: approve it, then close on it.
  async function adminApproveRequest(reqId) {
    const opening = !shiftOpen();
    const creds = await askAdmin('Admin approval — drawer variance', `Approving ${opening ? 'opens' : 'closes'} the drawer on the count that was sent.`);
    if (!creds) return;
    try {
      const kind = opening ? 'open' : 'close';
      if (!(await withChargeDecision((extra) => api(`/api/cash/${kind}-requests/${Number(reqId)}/approve`, { method: 'POST', body: { ...extra, ...creds } })))) return;
      const res = await api(`/api/cash/${kind}`, { method: 'POST', body: { [`${kind}_request_id`]: reqId } });
      cfg.notify(`Drawer ${opening ? 'opened' : 'closed'} with the admin's approval (${res.variance > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(res.variance))})`);
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
    const handovers = q.handovers || [];
    const openings = q.open_requests || [];
    const key = q.stock_syncs.map((s) => 's' + s.id).concat(q.close_requests.map((r) => 'r' + r.id), refunds.map((f) => 'f' + f.id), handovers.map((h) => 'h' + h.id), openings.map((o) => 'o' + o.id)).join(',');
    if (key === approvalsKey && el.innerHTML) return;
    approvalsKey = key;
    if (!q.stock_syncs.length && !q.close_requests.length && !refunds.length && !handovers.length && !openings.length) { el.innerHTML = ''; return; }
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
        ${r.variance < 0 ? chargeHtml(-r.variance, r.charge_to && r.charge_to.name, false) : ''}
        <input class="cc-text" data-role="note" placeholder="Note (needed to reject)" style="margin-top:6px;">
        <div class="cc-row"><button class="cc-btn cc-success" data-act="approve">Approve close</button><button class="cc-btn cc-danger" data-act="reject">Reject &mdash; count again</button></div></div>`).join('')}
      ${openings.map((o) => `<div style="margin-top:12px;" data-opening="${Number(o.id)}"><strong>Open the drawer</strong>
        <div>${esc(o.user_name || '-')} counted ${cfg.money(o.total_amount)}; ${cfg.money(o.expected_amount)} was left at the last close &mdash;
        <strong class="${o.variance < 0 ? 'cc-diff-neg' : 'cc-diff-pos'}">${o.variance > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(o.variance))}</strong>.</div>
        ${o.notes ? `<div class="cc-muted">Note: ${esc(o.notes)}</div>` : ''}
        ${o.variance < 0 ? chargeHtml(-o.variance, [
          { key: 'closer', label: `${o.closer ? o.closer.name : 'the last holder'} (held the drawer at the last close)` },
          { key: 'opener', label: `${o.user_name || 'the opener'} (opening now)` },
        ], false) : ''}
        <input class="cc-text" data-role="note" placeholder="Note (needed to reject)" style="margin-top:6px;">
        <div class="cc-row"><button class="cc-btn cc-success" data-act="approve">Approve opening</button><button class="cc-btn cc-danger" data-act="reject">Reject &mdash; count again</button></div></div>`).join('')}
      ${handovers.map((h) => `<div style="margin-top:12px;" data-handover="${Number(h.id)}"><strong>Drawer handover</strong>
        <div>${esc(h.from_name || '-')} &rarr; ${esc(h.to_name || '-')}: expected ${cfg.money(h.receiver_expected)}; ${esc(h.from_name)} counted ${cfg.money(h.giver_total)}, ${esc(h.to_name)} counted ${cfg.money(h.receiver_total)} &mdash;
        <strong class="${h.variance < 0 ? 'cc-diff-neg' : 'cc-diff-pos'}">${h.variance > 0 ? 'over' : 'short'} by ${cfg.money(Math.abs(h.variance))}</strong> (limit ${cfg.money(today.variance_limit ?? 200)}).</div>
        ${Math.abs((h.giver_total || 0) - (h.receiver_total || 0)) > 0.005 ? '<div class="cc-muted">The two counts disagree &mdash; worth counting again together before deciding.</div>' : ''}
        ${h.giver_notes ? `<div class="cc-muted">${esc(h.from_name)}: ${esc(h.giver_notes)}</div>` : ''}
        ${h.receiver_notes ? `<div class="cc-muted">${esc(h.to_name)}: ${esc(h.receiver_notes)}</div>` : ''}
        ${h.variance < 0 ? chargeHtml(-h.variance, h.from_name, false) : ''}
        <input class="cc-text" data-role="note" placeholder="Note (needed to reject)" style="margin-top:6px;">
        <div class="cc-row"><button class="cc-btn cc-success" data-act="approve">Approve &mdash; ${esc(h.to_name)} takes the drawer</button><button class="cc-btn cc-danger" data-act="reject">Reject &mdash; ${esc(h.from_name)} keeps it</button></div></div>`).join('')}
    </div>`;
    for (const o of openings) {
      const box = el.querySelector(`[data-opening="${Number(o.id)}"]`);
      const decide = async (btn, approve) => {
        const note = box.querySelector('[data-role="note"]').value.trim();
        if (!approve && !note) { cfg.notify('Say why it is rejected', 'error'); return; }
        const charge = approve ? readCharge(box) : {};
        if (typeof charge === 'string') { cfg.notify(charge, 'error'); return; }
        await cfg.withBusy(btn, async () => {
          if (!(await withChargeDecision((extra) => api(`/api/cash/open-requests/${Number(o.id)}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: { note, ...charge, ...extra } })))) return;
          cfg.notify(approve ? `Opening approved — ${o.user_name} can open now` : 'Opening rejected');
          await refresh();
        }, '…');
      };
      box.querySelector('[data-act="approve"]').onclick = (e) => decide(e.currentTarget, true);
      box.querySelector('[data-act="reject"]').onclick = (e) => decide(e.currentTarget, false);
    }
    for (const h of handovers) {
      const box = el.querySelector(`[data-handover="${Number(h.id)}"]`);
      const decide = async (btn, approve) => {
        const note = box.querySelector('[data-role="note"]').value.trim();
        if (!approve && !note) { cfg.notify('Say why it is rejected', 'error'); return; }
        const charge = approve ? readCharge(box) : {};
        if (typeof charge === 'string') { cfg.notify(charge, 'error'); return; }
        await cfg.withBusy(btn, async () => {
          if (!(await withChargeDecision((extra) => api(`/api/cash/handovers/${Number(h.id)}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: { note, ...charge, ...extra } })))) return;
          cfg.notify(approve ? `Handover approved — ${h.to_name} holds the drawer` : 'Handover rejected');
          await refresh();
        }, '…');
      };
      box.querySelector('[data-act="approve"]').onclick = (e) => decide(e.currentTarget, true);
      box.querySelector('[data-act="reject"]').onclick = (e) => decide(e.currentTarget, false);
    }
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
        const charge = approve ? readCharge(box) : {};
        if (typeof charge === 'string') { cfg.notify(charge, 'error'); return; }
        await cfg.withBusy(btn, async () => {
          if (!(await withChargeDecision((extra) => api(`/api/cash/close-requests/${Number(r.id)}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: { note, ...charge, ...extra } })))) return;
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
    askAdmin, refundRequestHtml, wireRefundDecision, ledgerHtml,
    closeBlockReason, withChargeDecision, showMyAccount, recordCollection, voidCollection, openOnRequest,
    startHandover, acceptHandover, declineHandover, cancelHandover, startTakeover,
    init, update, refresh, closeAllowed, needsApproval, clearGate,
    startCount, cancelCount, submitCount, adminApproveSync,
    requestApproval, adminApproveClose, adminApproveRequest, closeOnRequest,
  };
})();
