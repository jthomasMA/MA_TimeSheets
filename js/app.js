/* M-A Building Field Timesheets
 * Plain JavaScript, no build step — works on GitHub Pages.
 * Roles: employee (own hours), foreman (crew hours on assigned jobsites),
 *        supervisor (everything + approvals, jobsites, people).
 */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const WSD = Number.isInteger(CFG.WEEK_START_DAY) ? CFG.WEEK_START_DAY : 1;
  const OT = Number(CFG.OVERTIME_THRESHOLD) || 40;
  const COST_CODES = Array.isArray(CFG.COST_CODES) ? CFG.COST_CODES : [];
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const ROLE_LABEL = { employee: 'Employee', foreman: 'Foreman', supervisor: 'Supervisor' };

  const $app = document.getElementById('app');
  let sb = null;

  const state = {
    user: null,
    me: null,
    profiles: [],
    jobsites: [],
    siteForemen: [],          // [{jobsite_id, foreman_id}]
    tab: 'mine',
    weekStart: startOfWeek(new Date()),
    crewSite: '',
    review: { site: '', status: '', entries: [], selected: new Set() },
    grid: null,               // active hours grid
  };

  // ---------------------------------------------------------------- utils
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function startOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() - WSD + 7) % 7));
    return x;
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function weekDates(start) { return Array.from({ length: 7 }, (_, i) => toISO(addDays(start, i))); }
  function fmtShort(iso) { const d = parseISO(iso); return (d.getMonth() + 1) + '/' + d.getDate(); }
  function fmtWeek(start) {
    const end = addDays(start, 6);
    const o = { month: 'short', day: 'numeric' };
    return start.toLocaleDateString(undefined, o) + ' – ' +
      end.toLocaleDateString(undefined, { ...o, year: 'numeric' });
  }
  function num(v) { const n = parseFloat(v); return isFinite(n) ? n : 0; }
  function fmtH(n) { return (Math.round(n * 100) / 100).toString(); }
  function uid() { return Math.random().toString(36).slice(2, 10); }

  function toast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = ''; }, isError ? 5000 : 2500);
  }
  function fail(err) {
    console.error(err);
    toast((err && err.message) || String(err), true);
  }

  const isSupervisor = () => state.me && state.me.role === 'supervisor';
  const isForeman = () => state.me && (state.me.role === 'foreman' || state.me.role === 'supervisor');
  const profileById = id => state.profiles.find(p => p.id === id);
  const siteById = id => state.jobsites.find(s => s.id === id);
  const personName = id => { const p = profileById(id); return p ? (p.full_name || p.email) : '(unknown)'; };
  const siteName = id => { const s = siteById(id); return s ? (s.job_number ? s.job_number + ' – ' : '') + s.name : '(unknown)'; };
  function myForemanSites() {
    if (isSupervisor()) return state.jobsites.filter(s => s.active);
    const ids = new Set(state.siteForemen.filter(r => r.foreman_id === state.me.id).map(r => r.jobsite_id));
    return state.jobsites.filter(s => s.active && ids.has(s.id));
  }
  function confirmLeave() {
    return !(state.grid && state.grid.dirty) || confirm('You have unsaved hours. Leave without saving?');
  }

  function downloadCSV(filename, rows) {
    const csv = rows.map(r => r.map(v => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    if (!window.supabase || !CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes('YOUR-PROJECT')) {
      $app.innerHTML = `<div class="center-screen"><div class="card login">
        <h2>Almost there</h2>
        <p>Open <code>js/config.js</code> and paste in your Supabase project URL and anon key.
        See the setup guide (README) for step-by-step instructions.</p></div></div>`;
      return;
    }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') { renderSetPassword(); return; }
      if (event === 'SIGNED_OUT') { state.user = null; state.me = null; renderLogin(); return; }
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
        if (!state.user || state.user.id !== session.user.id) { state.user = session.user; start(); }
      } else if (event === 'INITIAL_SESSION' && !session) {
        renderLogin();
      }
    });
  }

  async function start() {
    $app.innerHTML = '<div class="center-screen"><p class="muted">Loading…</p></div>';
    try {
      const { data: me, error } = await sb.from('profiles').select('*').eq('id', state.user.id).maybeSingle();
      if (error) throw error;
      if (!me || !me.active) {
        $app.innerHTML = `<div class="center-screen"><div class="card login">
          <h2>Account not active</h2>
          <p>Your login works, but your account hasn't been activated. Please contact your supervisor.</p>
          <button class="btn" id="out">Sign out</button></div></div>`;
        document.getElementById('out').onclick = () => sb.auth.signOut();
        return;
      }
      state.me = me;
      await loadRefs();
      renderShell();
    } catch (e) { fail(e); }
  }

  async function loadRefs() {
    const [p, j, f] = await Promise.all([
      sb.from('profiles').select('*').order('full_name'),
      sb.from('jobsites').select('*').order('job_number').order('name'),
      sb.from('jobsite_foremen').select('*'),
    ]);
    for (const r of [p, j, f]) if (r.error) throw r.error;
    state.profiles = p.data; state.jobsites = j.data; state.siteForemen = f.data;
    state.me = profileById(state.me.id) || state.me;
  }

  // ---------------------------------------------------------------- auth screens
  function renderLogin() {
    $app.innerHTML = `<div class="center-screen"><form class="card login" id="loginForm">
      <div class="logo">MA</div>
      <h2>${esc(CFG.COMPANY_NAME || '')} Timesheets</h2>
      <p class="muted small">Sign in to enter your weekly hours.</p>
      <label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn primary" type="submit">Sign in</button>
      <p class="small" style="text-align:center;margin-top:12px"><a href="#" id="forgot">Forgot password?</a></p>
    </form></div>`;
    const form = document.getElementById('loginForm');
    form.onsubmit = async e => {
      e.preventDefault();
      const btn = form.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
      const { error } = await sb.auth.signInWithPassword({
        email: form.email.value.trim(), password: form.password.value });
      if (error) { toast('Sign-in failed: ' + error.message, true); btn.disabled = false; btn.textContent = 'Sign in'; }
    };
    document.getElementById('forgot').onclick = async e => {
      e.preventDefault();
      const email = form.email.value.trim();
      if (!email) { toast('Type your email above first.', true); return; }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
      if (error) fail(error);
      else toast('If that email is on file, a reset link is on its way. Otherwise ask your supervisor.');
    };
  }

  function renderSetPassword() {
    $app.innerHTML = `<div class="center-screen"><form class="card login" id="pwForm">
      <h2>Set a new password</h2>
      <label class="field"><span>New password (8+ characters)</span><input type="password" name="pw" minlength="8" autocomplete="new-password" required></label>
      <button class="btn primary" type="submit">Save password</button></form></div>`;
    document.getElementById('pwForm').onsubmit = async e => {
      e.preventDefault();
      const { error } = await sb.auth.updateUser({ password: e.target.pw.value });
      if (error) return fail(error);
      toast('Password updated.');
      const { data } = await sb.auth.getSession();
      if (data.session) { state.user = data.session.user; start(); } else renderLogin();
    };
  }

  function openPasswordModal() {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<form class="card modal">
      <h2>Change password</h2>
      <label class="field"><span>New password (8+ characters)</span><input type="password" name="pw" minlength="8" autocomplete="new-password" required></label>
      <div class="toolbar"><span class="grow"></span><button type="button" class="btn" data-x>Cancel</button>
      <button class="btn primary" type="submit">Save</button></div></form>`;
    document.body.appendChild(back);
    back.querySelector('[data-x]').onclick = () => back.remove();
    back.querySelector('form').onsubmit = async e => {
      e.preventDefault();
      const { error } = await sb.auth.updateUser({ password: e.target.pw.value });
      if (error) return fail(error);
      back.remove(); toast('Password changed.');
    };
    back.querySelector('input').focus();
  }

  // ---------------------------------------------------------------- shell
  function tabsFor() {
    const t = [['mine', 'My Hours']];
    if (isForeman()) t.push(['crew', 'Crew Hours']);
    if (isSupervisor()) t.push(['review', 'Review & Export'], ['sites', 'Jobsites'], ['people', 'People']);
    return t;
  }

  function renderShell() {
    const tabs = tabsFor();
    if (!tabs.some(t => t[0] === state.tab)) state.tab = 'mine';
    $app.innerHTML = `
      <header class="topbar">
        <div class="brand">${esc(CFG.COMPANY_NAME || '')} Timesheets
          <span>${esc(state.me.full_name || state.me.email)} · ${ROLE_LABEL[state.me.role]}</span></div>
        <div class="user">
          <button class="btn small" id="pwBtn">Password</button>
          <button class="btn small" id="outBtn">Sign out</button>
        </div>
      </header>
      <nav class="tabs">${tabs.map(([k, l]) =>
        `<button data-tab="${k}" class="${k === state.tab ? 'active' : ''}">${l}</button>`).join('')}</nav>
      <main id="view"></main>
      ${COST_CODES.length ? `<datalist id="costcodes">${COST_CODES.map(c => `<option value="${esc(c)}">`).join('')}</datalist>` : ''}`;
    document.getElementById('pwBtn').onclick = openPasswordModal;
    document.getElementById('outBtn').onclick = () => { if (confirmLeave()) sb.auth.signOut(); };
    $app.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
      if (b.dataset.tab === state.tab || !confirmLeave()) return;
      state.tab = b.dataset.tab;
      $app.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b));
      renderTab();
    });
    renderTab();
  }

  function renderTab() {
    state.grid = null;
    const v = document.getElementById('view');
    ({ mine: viewMine, crew: viewCrew, review: viewReview, sites: viewSites, people: viewPeople }[state.tab])(v);
  }

  function weekPickerHTML() {
    return `<div class="weekpicker">
      <button class="btn icon" data-week="-1" aria-label="Previous week">◀</button>
      <div class="label">${fmtWeek(state.weekStart)}</div>
      <button class="btn icon" data-week="1" aria-label="Next week">▶</button>
      <button class="btn small" data-week="0">This week</button></div>`;
  }
  function bindWeekPicker(root, onChange) {
    root.querySelectorAll('[data-week]').forEach(b => b.onclick = () => {
      if (!confirmLeave()) return;
      const n = Number(b.dataset.week);
      state.weekStart = n === 0 ? startOfWeek(new Date()) : addDays(state.weekStart, 7 * n);
      onChange();
    });
  }

  // ================================================================ HOURS GRID
  // mode 'mine': rows are jobsite + cost code for the signed-in user
  // mode 'crew': rows are employee + cost code on one jobsite
  function makeGrid(mode, entries, opts) {
    const dates = weekDates(state.weekStart);
    const rows = [];
    const byKey = new Map();
    for (const e of entries) {
      const k = e.employee_id + '|' + e.jobsite_id + '|' + e.cost_code;
      let r = byKey.get(k);
      if (!r) {
        r = { id: uid(), employee_id: e.employee_id, jobsite_id: e.jobsite_id, cost_code: e.cost_code, notes: e.notes || '', cells: {} };
        byKey.set(k, r); rows.push(r);
      }
      r.cells[e.work_date] = { hours: num(e.hours), status: e.status, id: e.id };
      if (!r.notes && e.notes) r.notes = e.notes;
    }
    rows.sort((a, b) => mode === 'crew'
      ? personName(a.employee_id).localeCompare(personName(b.employee_id))
      : siteName(a.jobsite_id).localeCompare(siteName(b.jobsite_id)));
    return { mode, dates, rows, loaded: entries, dirty: false, ...opts };
  }

  function newRow(g, employee_id) {
    return {
      id: uid(),
      employee_id: g.mode === 'mine' ? state.me.id : (employee_id || ''),
      jobsite_id: g.mode === 'crew' ? g.site : '',
      cost_code: '', notes: '', cells: {},
    };
  }

  const rowLocked = r => Object.values(r.cells).some(c => c.status === 'approved');
  const rowTotal = r => Object.values(r.cells).reduce((s, c) => s + num(c.hours), 0);

  function renderGrid(container) {
    const g = state.grid;
    const today = toISO(new Date());
    const selectOpts = (list, val, labelFn, placeholder) =>
      `<option value="">${placeholder}</option>` + list.map(x =>
        `<option value="${x.id}" ${x.id === val ? 'selected' : ''}>${esc(labelFn(x))}</option>`).join('');

    let sites = state.jobsites.filter(s => s.active);
    let people = state.profiles.filter(p => p.active);

    const rowsHTML = g.rows.map(r => {
      const locked = rowLocked(r);
      let picker;
      if (g.mode === 'mine') {
        const list = sites.some(s => s.id === r.jobsite_id) || !r.jobsite_id ? sites : sites.concat(siteById(r.jobsite_id) || []);
        picker = `<select data-f="jobsite_id" ${locked ? 'disabled' : ''} aria-label="Jobsite">${selectOpts(list, r.jobsite_id, s => siteName(s.id), 'Select jobsite…')}</select>`;
      } else {
        const list = people.some(p => p.id === r.employee_id) || !r.employee_id ? people : people.concat(profileById(r.employee_id) || []);
        picker = `<select data-f="employee_id" ${locked ? 'disabled' : ''} aria-label="Employee">${selectOpts(list, r.employee_id, p => p.full_name || p.email, 'Select employee…')}</select>`;
      }
      const statuses = [...new Set(Object.values(r.cells).filter(c => c.status && num(c.hours) > 0).map(c => c.status))];
      return `<div class="card row-card" data-row="${r.id}">
        <div class="row-head">
          ${picker}
          <input class="cc" data-f="cost_code" value="${esc(r.cost_code)}" placeholder="Cost code (optional)" ${COST_CODES.length ? 'list="costcodes"' : ''} ${locked ? 'disabled' : ''} aria-label="Cost code">
          <button class="btn icon danger" data-remove ${locked ? 'disabled title="Approved hours can\'t be removed"' : 'title="Remove row"'} aria-label="Remove row">✕</button>
        </div>
        <div class="days">${g.dates.map(d => {
          const c = r.cells[d] || {};
          const dow = parseISO(d).getDay();
          const cls = c.status === 'approved' ? 'approved' : c.status === 'rejected' ? 'rejected' : '';
          return `<label class="day ${dow === 0 || dow === 6 ? 'weekend' : ''}">
            <span class="dlabel"><b>${DAY_NAMES[dow]}${d === today ? ' •' : ''}</b>${fmtShort(d)}</span>
            <input type="number" inputmode="decimal" step="0.25" min="0" max="24" data-d="${d}"
              class="${cls}" value="${c.hours ? fmtH(c.hours) : ''}" ${c.status === 'approved' ? 'disabled' : ''}
              aria-label="${DAY_NAMES[dow]} ${fmtShort(d)} hours"></label>`;
        }).join('')}</div>
        <div class="row-foot">
          <input data-f="notes" value="${esc(r.notes)}" placeholder="Notes (optional)" ${locked ? 'disabled' : ''} aria-label="Notes">
          ${statuses.map(s => `<span class="badge ${s}">${s}</span>`).join('')}
          <span class="row-total" data-total>${fmtH(rowTotal(r))} h</span>
        </div>
      </div>`;
    }).join('');

    container.innerHTML = `
      ${g.rows.some(r => Object.values(r.cells).some(c => c.status === 'rejected'))
        ? '<div class="notice bad">Some hours were sent back by your supervisor (red boxes). Fix them and save to resubmit.</div>' : ''}
      ${rowsHTML || '<div class="card muted">No hours yet for this week.</div>'}
      <div class="card totals-card">
        <div class="days" data-daytotals></div>
        <div class="row-foot"><span class="grow muted small">Daily totals</span><span class="grow"></span><span class="row-total" data-weektotal></span></div>
      </div>`;
    updateTotals(container);
  }

  function updateTotals(container) {
    const g = state.grid;
    const dayTotals = g.dates.map(d => g.rows.reduce((s, r) => s + num(r.cells[d] && r.cells[d].hours), 0));
    const week = dayTotals.reduce((a, b) => a + b, 0);
    const dt = container.querySelector('[data-daytotals]');
    if (dt) dt.innerHTML = dayTotals.map(t => `<div>${t ? fmtH(t) : '–'}</div>`).join('');
    const wt = container.querySelector('[data-weektotal]');
    if (wt) {
      const otNote = g.mode === 'mine' && week > OT ? ` <span class="badge ot">${fmtH(week - OT)} OT</span>` : '';
      wt.innerHTML = `${fmtH(week)} h${otNote}`;
    }
    container.querySelectorAll('[data-row]').forEach(el => {
      const r = g.rows.find(x => x.id === el.dataset.row);
      if (r) el.querySelector('[data-total]').textContent = fmtH(rowTotal(r)) + ' h';
    });
    const ind = document.getElementById('dirtyInd');
    if (ind) ind.innerHTML = g.dirty ? '<span class="dirty-dot">● Unsaved changes</span>' : '<span class="muted small">All changes saved</span>';
  }

  function bindGrid(container) {
    container.addEventListener('input', e => {
      const g = state.grid; if (!g) return;
      const card = e.target.closest('[data-row]'); if (!card) return;
      const r = g.rows.find(x => x.id === card.dataset.row); if (!r) return;
      if (e.target.dataset.d) {
        const d = e.target.dataset.d;
        r.cells[d] = r.cells[d] || {};
        r.cells[d].hours = num(e.target.value);
        if (r.cells[d].status === 'rejected') r.cells[d].edited = true;
      } else if (e.target.dataset.f) {
        r[e.target.dataset.f] = e.target.dataset.f === 'cost_code' ? e.target.value.trim() : e.target.value;
      }
      g.dirty = true;
      updateTotals(container);
    });
    container.addEventListener('change', e => {
      if (e.target.tagName === 'SELECT') e.target.dispatchEvent(new Event('input', { bubbles: true }));
    });
    container.addEventListener('click', e => {
      const btn = e.target.closest('[data-remove]'); if (!btn) return;
      const g = state.grid;
      const card = btn.closest('[data-row]');
      const r = g.rows.find(x => x.id === card.dataset.row);
      if (rowTotal(r) > 0 && !confirm('Remove this row and its hours?')) return;
      g.rows = g.rows.filter(x => x !== r);
      g.dirty = true;
      renderGrid(container);
    });
  }

  async function saveGrid() {
    const g = state.grid;
    const errors = [];
    const seen = new Set();
    const desired = new Map();
    const perPersonDay = {};

    for (const r of g.rows) {
      const total = rowTotal(r);
      if (!r.employee_id || !r.jobsite_id) {
        if (total > 0) errors.push(g.mode === 'mine' ? 'Pick a jobsite for every row with hours.' : 'Pick an employee for every row with hours.');
        continue;
      }
      const rk = r.employee_id + '|' + r.jobsite_id + '|' + r.cost_code;
      if (seen.has(rk) && total > 0) {
        errors.push(`Duplicate row: ${g.mode === 'mine' ? siteName(r.jobsite_id) : personName(r.employee_id)}${r.cost_code ? ' / ' + r.cost_code : ''}. Combine them into one row.`);
        continue;
      }
      seen.add(rk);
      for (const d of g.dates) {
        const h = num(r.cells[d] && r.cells[d].hours);
        if (h < 0 || h > 24) { errors.push(`Hours must be between 0 and 24 (${fmtShort(d)}).`); continue; }
        if (h > 0) {
          desired.set(rk + '|' + d, { employee_id: r.employee_id, jobsite_id: r.jobsite_id, cost_code: r.cost_code, work_date: d, hours: h, notes: r.notes.trim() });
          const pk = r.employee_id + '|' + d;
          perPersonDay[pk] = (perPersonDay[pk] || 0) + h;
        }
      }
    }
    for (const [k, h] of Object.entries(perPersonDay)) {
      if (h > 24) { const [emp, d] = k.split('|'); errors.push(`${personName(emp)} has ${fmtH(h)} hours on ${fmtShort(d)} (over 24).`); }
    }
    if (errors.length) { toast([...new Set(errors)][0], true); return false; }

    const loadedByKey = new Map(g.loaded.map(e => [e.employee_id + '|' + e.jobsite_id + '|' + e.cost_code + '|' + e.work_date, e]));
    const upserts = [];
    for (const [k, v] of desired) {
      const ex = loadedByKey.get(k);
      if (ex && ex.status === 'approved') continue;
      if (!ex || num(ex.hours) !== v.hours || (ex.notes || '') !== v.notes || ex.status === 'rejected') {
        upserts.push({ ...v, status: 'submitted' });
      }
    }
    const deletes = g.loaded.filter(e => e.status !== 'approved' &&
      !desired.has(e.employee_id + '|' + e.jobsite_id + '|' + e.cost_code + '|' + e.work_date)).map(e => e.id);

    try {
      if (deletes.length) {
        const { error } = await sb.from('time_entries').delete().in('id', deletes);
        if (error) throw error;
      }
      if (upserts.length) {
        const { error } = await sb.from('time_entries').upsert(upserts, { onConflict: 'employee_id,jobsite_id,work_date,cost_code' });
        if (error) throw error;
      }
      g.dirty = false;
      toast(upserts.length || deletes.length ? 'Hours saved.' : 'Nothing to save.');
      return true;
    } catch (e) { fail(e); return false; }
  }

  // ================================================================ MY HOURS
  async function viewMine(v) {
    v.innerHTML = `
      <div class="toolbar">${weekPickerHTML()}</div>
      <div id="grid"><p class="muted">Loading…</p></div>
      <div class="save-bar">
        <button class="btn" id="addRow">+ Add jobsite</button>
        <button class="btn" id="copyLast" title="Copy last week's jobsites and cost codes (no hours)">Copy last week's jobsites</button>
        <span class="grow" id="dirtyInd"></span>
        <button class="btn primary" id="save">Save hours</button>
      </div>`;
    bindWeekPicker(v, () => viewMine(v));
    const gridEl = v.querySelector('#grid');
    const dates = weekDates(state.weekStart);
    const { data, error } = await sb.from('time_entries').select('*')
      .eq('employee_id', state.me.id).gte('work_date', dates[0]).lte('work_date', dates[6]);
    if (error) return fail(error);
    if (state.tab !== 'mine') return;
    state.grid = makeGrid('mine', data, {});
    if (!state.grid.rows.length) state.grid.rows.push(newRow(state.grid));
    renderGrid(gridEl); bindGrid(gridEl);

    v.querySelector('#addRow').onclick = () => { state.grid.rows.push(newRow(state.grid)); renderGrid(gridEl); };
    v.querySelector('#copyLast').onclick = async () => {
      const prev = weekDates(addDays(state.weekStart, -7));
      const { data: pd, error: pe } = await sb.from('time_entries').select('jobsite_id,cost_code')
        .eq('employee_id', state.me.id).gte('work_date', prev[0]).lte('work_date', prev[6]);
      if (pe) return fail(pe);
      const have = new Set(state.grid.rows.map(r => r.jobsite_id + '|' + r.cost_code));
      let added = 0;
      for (const e of pd) {
        const k = e.jobsite_id + '|' + e.cost_code;
        if (have.has(k)) continue;
        have.add(k);
        const r = newRow(state.grid); r.jobsite_id = e.jobsite_id; r.cost_code = e.cost_code;
        state.grid.rows.push(r); added++;
      }
      state.grid.rows = state.grid.rows.filter(r => r.jobsite_id || rowTotal(r) > 0 || state.grid.rows.length === 1);
      if (added) state.grid.dirty = true;
      renderGrid(gridEl);
      toast(added ? `Added ${added} row(s) from last week.` : 'Nothing new to copy from last week.');
    };
    v.querySelector('#save').onclick = async e => {
      e.target.disabled = true;
      if (await saveGrid()) viewMine(v); else e.target.disabled = false;
    };
  }

  // ================================================================ CREW HOURS
  async function viewCrew(v) {
    const sites = myForemanSites();
    if (!sites.length) {
      v.innerHTML = `<div class="card"><h2>No jobsites assigned</h2>
        <p class="muted">A supervisor needs to assign you to a jobsite before you can enter crew hours.</p></div>`;
      return;
    }
    if (!sites.some(s => s.id === state.crewSite)) state.crewSite = sites[0].id;
    v.innerHTML = `
      <div class="toolbar">
        <select id="siteSel" aria-label="Jobsite">${sites.map(s =>
          `<option value="${s.id}" ${s.id === state.crewSite ? 'selected' : ''}>${esc(siteName(s.id))}</option>`).join('')}</select>
        <span class="grow"></span>${weekPickerHTML()}
      </div>
      <div id="grid"><p class="muted">Loading…</p></div>
      <div class="save-bar">
        <button class="btn" id="addRow">+ Add employee</button>
        <button class="btn" id="lastCrew" title="Add everyone who worked this jobsite last week">Add last week's crew</button>
        <button class="btn" id="fillDown" title="Copy the first row's hours to rows that are still empty">Copy row 1 hours to empty rows</button>
        <span class="grow" id="dirtyInd"></span>
        <button class="btn primary" id="save">Save crew hours</button>
      </div>`;
    v.querySelector('#siteSel').onchange = e => {
      if (!confirmLeave()) { e.target.value = state.crewSite; return; }
      state.crewSite = e.target.value; viewCrew(v);
    };
    bindWeekPicker(v, () => viewCrew(v));
    const site = state.crewSite;
    const gridEl = v.querySelector('#grid');
    const dates = weekDates(state.weekStart);
    const { data, error } = await sb.from('time_entries').select('*')
      .eq('jobsite_id', site).gte('work_date', dates[0]).lte('work_date', dates[6]);
    if (error) return fail(error);
    if (state.tab !== 'crew' || state.crewSite !== site) return;
    state.grid = makeGrid('crew', data, { site });
    renderGrid(gridEl); bindGrid(gridEl);

    v.querySelector('#addRow').onclick = () => { state.grid.rows.push(newRow(state.grid)); renderGrid(gridEl); };
    v.querySelector('#lastCrew').onclick = async () => {
      const prev = weekDates(addDays(state.weekStart, -7));
      const { data: pd, error: pe } = await sb.from('time_entries').select('employee_id,cost_code')
        .eq('jobsite_id', site).gte('work_date', prev[0]).lte('work_date', prev[6]);
      if (pe) return fail(pe);
      const have = new Set(state.grid.rows.map(r => r.employee_id + '|' + r.cost_code));
      let added = 0;
      for (const e of pd) {
        const k = e.employee_id + '|' + e.cost_code;
        if (have.has(k) || !(profileById(e.employee_id) || {}).active) continue;
        have.add(k);
        const r = newRow(state.grid, e.employee_id); r.cost_code = e.cost_code;
        state.grid.rows.push(r); added++;
      }
      if (added) state.grid.dirty = true;
      renderGrid(gridEl);
      toast(added ? `Added ${added} crew row(s).` : 'No new crew from last week.');
    };
    v.querySelector('#fillDown').onclick = () => {
      const g = state.grid;
      if (!g.rows.length || rowTotal(g.rows[0]) === 0) { toast('Enter hours in the first row first.', true); return; }
      const src = g.rows[0];
      let n = 0;
      for (const r of g.rows.slice(1)) {
        if (rowTotal(r) > 0 || rowLocked(r)) continue;
        for (const d of g.dates) if (src.cells[d] && src.cells[d].hours) r.cells[d] = { hours: src.cells[d].hours };
        n++;
      }
      if (n) g.dirty = true;
      renderGrid(gridEl);
      toast(n ? `Filled ${n} row(s).` : 'No empty rows to fill.');
    };
    v.querySelector('#save').onclick = async e => {
      e.target.disabled = true;
      if (await saveGrid()) viewCrew(v); else e.target.disabled = false;
    };
  }

  // ================================================================ REVIEW (supervisor)
  async function viewReview(v) {
    const R = state.review;
    R.selected = new Set();
    v.innerHTML = `
      <div class="toolbar">${weekPickerHTML()}<span class="grow"></span>
        <select id="fSite" aria-label="Filter jobsite"><option value="">All jobsites</option>${state.jobsites.map(s =>
          `<option value="${s.id}" ${s.id === R.site ? 'selected' : ''}>${esc(siteName(s.id))}</option>`).join('')}</select>
        <select id="fStatus" aria-label="Filter status">
          ${[['', 'All statuses'], ['submitted', 'Waiting approval'], ['approved', 'Approved'], ['rejected', 'Sent back']].map(([k, l]) =>
            `<option value="${k}" ${k === R.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div id="missing"></div>
      <div class="toolbar">
        <button class="btn" id="selAll">Select all waiting</button>
        <button class="btn ok" id="approve">Approve selected</button>
        <button class="btn danger" id="reject">Send back selected</button>
        <span class="grow"></span>
        <button class="btn" id="csvSummary">Export payroll summary</button>
        <button class="btn" id="csvDetail">Export detail</button>
      </div>
      <div class="card table-wrap" id="tbl"><p class="muted">Loading…</p></div>`;
    bindWeekPicker(v, () => viewReview(v));
    v.querySelector('#fSite').onchange = e => { R.site = e.target.value; viewReview(v); };
    v.querySelector('#fStatus').onchange = e => { R.status = e.target.value; viewReview(v); };

    const dates = weekDates(state.weekStart);
    let q = sb.from('time_entries').select('*').gte('work_date', dates[0]).lte('work_date', dates[6]);
    if (R.site) q = q.eq('jobsite_id', R.site);
    const { data, error } = await q.order('work_date');
    if (error) return fail(error);
    if (state.tab !== 'review') return;

    // Overtime is based on the person's full week, regardless of filters.
    const weekTotals = {};
    for (const e of data) weekTotals[e.employee_id] = (weekTotals[e.employee_id] || 0) + num(e.hours);
    let entries = R.status ? data.filter(e => e.status === R.status) : data;
    entries.sort((a, b) => personName(a.employee_id).localeCompare(personName(b.employee_id)) ||
      a.work_date.localeCompare(b.work_date) || siteName(a.jobsite_id).localeCompare(siteName(b.jobsite_id)));
    R.entries = entries;

    // Who has no hours this week (only meaningful without a jobsite filter)
    const missingEl = v.querySelector('#missing');
    if (!R.site) {
      const withHours = new Set(data.map(e => e.employee_id));
      const missing = state.profiles.filter(p => p.active && p.role !== 'supervisor' && !withHours.has(p.id));
      missingEl.innerHTML = missing.length
        ? `<div class="notice warn"><b>No hours entered yet (${missing.length}):</b> ${missing.map(p => esc(p.full_name || p.email)).join(', ')}</div>`
        : '<div class="notice">Everyone has hours entered for this week.</div>';
    }

    const tbl = v.querySelector('#tbl');
    if (!entries.length) { tbl.innerHTML = '<p class="muted">No hours match these filters.</p>'; }
    else {
      let html = `<table><thead><tr><th></th><th>Date</th><th>Jobsite</th><th>Cost code</th><th class="num">Hours</th><th>Status</th><th>Entered by</th><th>Notes</th></tr></thead><tbody>`;
      let cur = null;
      for (const e of entries) {
        if (e.employee_id !== cur) {
          cur = e.employee_id;
          const wk = weekTotals[cur] || 0;
          const shown = entries.filter(x => x.employee_id === cur).reduce((s, x) => s + num(x.hours), 0);
          html += `<tr class="group"><td><input type="checkbox" data-group="${cur}" aria-label="Select all for ${esc(personName(cur))}"></td>
            <td colspan="3">${esc(personName(cur))}</td>
            <td class="num">${fmtH(shown)}</td>
            <td colspan="3">${R.site || R.status ? `<span class="muted small">week total ${fmtH(wk)} h</span> ` : ''}${wk > OT ? `<span class="badge ot">${fmtH(wk - OT)} h overtime</span>` : ''}</td></tr>`;
        }
        const d = parseISO(e.work_date);
        html += `<tr><td><input type="checkbox" data-id="${e.id}" aria-label="Select"></td>
          <td>${DAY_NAMES[d.getDay()]} ${fmtShort(e.work_date)}</td>
          <td>${esc(siteName(e.jobsite_id))}</td><td>${esc(e.cost_code)}</td>
          <td class="num">${fmtH(num(e.hours))}</td>
          <td><span class="badge ${e.status}">${e.status === 'rejected' ? 'sent back' : e.status}</span></td>
          <td class="small">${e.entered_by && e.entered_by !== e.employee_id ? esc(personName(e.entered_by)) : '<span class="muted">self</span>'}</td>
          <td class="small">${esc(e.notes)}</td></tr>`;
      }
      const total = entries.reduce((s, e) => s + num(e.hours), 0);
      html += `</tbody><tfoot><tr><td></td><td colspan="3"><b>Total</b></td><td class="num"><b>${fmtH(total)}</b></td><td colspan="3"></td></tr></tfoot></table>`;
      tbl.innerHTML = html;
    }

    tbl.addEventListener('change', e => {
      if (e.target.dataset.id) { e.target.checked ? R.selected.add(e.target.dataset.id) : R.selected.delete(e.target.dataset.id); }
      if (e.target.dataset.group) {
        const on = e.target.checked;
        R.entries.filter(x => x.employee_id === e.target.dataset.group).forEach(x => {
          on ? R.selected.add(x.id) : R.selected.delete(x.id);
          const cb = tbl.querySelector(`[data-id="${x.id}"]`); if (cb) cb.checked = on;
        });
      }
    });
    v.querySelector('#selAll').onclick = () => {
      R.entries.filter(e => e.status === 'submitted').forEach(e => {
        R.selected.add(e.id);
        const cb = tbl.querySelector(`[data-id="${e.id}"]`); if (cb) cb.checked = true;
      });
    };
    const setStatus = async status => {
      const ids = [...R.selected];
      if (!ids.length) { toast('Select some hours first.', true); return; }
      if (status === 'rejected' && !confirm(`Send back ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} for correction?`)) return;
      const { error: ue } = await sb.from('time_entries').update({ status }).in('id', ids);
      if (ue) return fail(ue);
      toast(status === 'approved' ? `Approved ${ids.length}.` : `Sent back ${ids.length}.`);
      viewReview(v);
    };
    v.querySelector('#approve').onclick = () => setStatus('approved');
    v.querySelector('#reject').onclick = () => setStatus('rejected');

    const tag = dates[0];
    v.querySelector('#csvDetail').onclick = () => {
      const rows = [['Employee', 'Email', 'Date', 'Day', 'Job #', 'Jobsite', 'Cost code', 'Hours', 'Status', 'Entered by', 'Notes']];
      for (const e of R.entries) {
        const s = siteById(e.jobsite_id) || {}; const p = profileById(e.employee_id) || {};
        rows.push([personName(e.employee_id), p.email, e.work_date, DAY_NAMES[parseISO(e.work_date).getDay()],
          s.job_number, s.name, e.cost_code, num(e.hours), e.status, e.entered_by ? personName(e.entered_by) : '', e.notes]);
      }
      downloadCSV(`timesheets-detail-${tag}.csv`, rows);
    };
    v.querySelector('#csvSummary').onclick = () => {
      // One line per employee + jobsite + cost code, with each day as a column,
      // plus each employee's weekly regular / overtime split.
      const head = ['Employee', 'Job #', 'Jobsite', 'Cost code', ...dates.map(d => DAY_NAMES[parseISO(d).getDay()] + ' ' + fmtShort(d)), 'Total', 'Employee week total', 'Regular', 'Overtime'];
      const groups = new Map();
      for (const e of R.entries) {
        const k = e.employee_id + '|' + e.jobsite_id + '|' + e.cost_code;
        if (!groups.has(k)) groups.set(k, { e, days: {} });
        const gg = groups.get(k); gg.days[e.work_date] = (gg.days[e.work_date] || 0) + num(e.hours);
      }
      const rows = [head];
      const lines = [...groups.values()].sort((a, b) => personName(a.e.employee_id).localeCompare(personName(b.e.employee_id)));
      let lastEmp = null;
      for (const { e, days } of lines) {
        const s = siteById(e.jobsite_id) || {};
        const tot = Object.values(days).reduce((x, y) => x + y, 0);
        const wk = weekTotals[e.employee_id] || 0;
        const first = e.employee_id !== lastEmp; lastEmp = e.employee_id;
        rows.push([personName(e.employee_id), s.job_number, s.name, e.cost_code, ...dates.map(d => days[d] || ''), fmtH(tot),
          first ? fmtH(wk) : '', first ? fmtH(Math.min(wk, OT)) : '', first ? fmtH(Math.max(0, wk - OT)) : '']);
      }
      downloadCSV(`timesheets-summary-${tag}.csv`, rows);
    };
  }

  // ================================================================ JOBSITES (supervisor)
  function viewSites(v) {
    const foremen = state.profiles.filter(p => p.active && (p.role === 'foreman' || p.role === 'supervisor'));
    const assigned = id => new Set(state.siteForemen.filter(r => r.jobsite_id === id).map(r => r.foreman_id));
    v.innerHTML = `
      <form class="card" id="addSite">
        <h2>Add a jobsite</h2>
        <div class="toolbar">
          <input name="job_number" placeholder="Job #" style="max-width:140px">
          <input name="name" placeholder="Jobsite name" required style="flex:2;min-width:180px">
          <input name="address" placeholder="Address (optional)" style="flex:2;min-width:180px">
          <button class="btn primary" type="submit">Add</button>
        </div>
      </form>
      ${foremen.length ? '' : '<div class="notice warn">No foremen yet. Set someone\'s role to Foreman on the People tab, then assign them here.</div>'}
      <div id="siteList">${state.jobsites.map(s => {
        const a = assigned(s.id);
        return `<div class="card" data-site="${s.id}">
          <div class="toolbar">
            <input data-f="job_number" value="${esc(s.job_number)}" placeholder="Job #" style="max-width:140px">
            <input data-f="name" value="${esc(s.name)}" placeholder="Name" style="flex:2;min-width:180px">
            <input data-f="address" value="${esc(s.address)}" placeholder="Address" style="flex:2;min-width:180px">
            <label class="chip"><input type="checkbox" data-f="active" ${s.active ? 'checked' : ''}> Active</label>
          </div>
          <div class="small muted" style="margin-bottom:6px">Foremen on this jobsite:</div>
          <div class="chips">${foremen.map(f => `<label class="chip"><input type="checkbox" data-foreman="${f.id}" ${a.has(f.id) ? 'checked' : ''}> ${esc(f.full_name || f.email)}</label>`).join('') || '<span class="muted small">—</span>'}</div>
          <div class="toolbar" style="margin:10px 0 0"><span class="grow"></span><button class="btn small primary" data-save>Save</button></div>
        </div>`;
      }).join('') || '<div class="card muted">No jobsites yet.</div>'}</div>`;

    v.querySelector('#addSite').onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      const { error } = await sb.from('jobsites').insert({ job_number: f.job_number.value.trim(), name: f.name.value.trim(), address: f.address.value.trim() });
      if (error) return fail(error);
      toast('Jobsite added.'); await loadRefs(); viewSites(v);
    };
    v.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
      const card = b.closest('[data-site]'); const id = card.dataset.site;
      const val = f => card.querySelector(`[data-f="${f}"]`);
      if (!val('name').value.trim()) { toast('Name is required.', true); return; }
      b.disabled = true;
      try {
        const { error } = await sb.from('jobsites').update({
          job_number: val('job_number').value.trim(), name: val('name').value.trim(),
          address: val('address').value.trim(), active: val('active').checked }).eq('id', id);
        if (error) throw error;
        const want = [...card.querySelectorAll('[data-foreman]')].filter(c => c.checked).map(c => c.dataset.foreman);
        const have = assigned(id);
        const toRemove = [...have].filter(x => !want.includes(x));
        const toAdd = want.filter(x => !have.has(x));
        if (toRemove.length) {
          const { error: de } = await sb.from('jobsite_foremen').delete().eq('jobsite_id', id).in('foreman_id', toRemove);
          if (de) throw de;
        }
        if (toAdd.length) {
          const { error: ie } = await sb.from('jobsite_foremen').insert(toAdd.map(f => ({ jobsite_id: id, foreman_id: f })));
          if (ie) throw ie;
        }
        await loadRefs(); toast('Jobsite saved.');
      } catch (e) { fail(e); }
      b.disabled = false;
    });
  }

  // ================================================================ PEOPLE (supervisor)
  // Creating logins / resetting passwords goes through the "manage-users"
  // Supabase Edge Function, which holds the admin key server-side.
  async function manageUsers(body) {
    let res;
    try { res = await sb.functions.invoke('manage-users', { body }); }
    catch (e) { return { error: 'Could not reach the user-management function. ' + (e.message || '') }; }
    const { data, error } = res;
    if (!error) return data || {};
    let msg = '';
    try { const j = await error.context.json(); msg = j && j.error; } catch (_) { /* not JSON */ }
    const status = error.context && error.context.status;
    if (!msg && (status === 404 || /fetch|relay|not found/i.test(error.message || ''))) {
      msg = 'User management isn\'t set up yet. Deploy the "manage-users" Edge Function (setup guide, Part 7).';
    }
    if (!msg && status === 401) {
      msg = 'Supabase rejected the request. In the manage-users function settings, turn OFF "Verify JWT" (setup guide, Part 7).';
    }
    return { error: msg || error.message || 'Something went wrong.' };
  }

  function genPassword() {
    const words = ['Timber', 'Rebar', 'Gravel', 'Beam', 'Brick', 'Crane', 'Level', 'Hammer', 'Anchor', 'Joist', 'Truss', 'Mortar'];
    const a = new Uint32Array(2); crypto.getRandomValues(a);
    return words[a[0] % words.length] + '-' + String(1000 + (a[1] % 9000));
  }

  function openModal(html, onMount) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="card modal">${html}</div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-x]')) close(); });
    onMount(back, close);
    const first = back.querySelector('input'); if (first) first.focus();
  }

  function showLoginDetails(title, name, email, password) {
    const text = `${CFG.COMPANY_NAME || ''} Timesheets\nSite: ${location.href.split('#')[0]}\nLogin: ${email}\nPassword: ${password}`;
    openModal(`
      <h2>${esc(title)}</h2>
      <p class="muted small">Give these to ${esc(name)}. They can change the password with the <b>Password</b> button after signing in.
      This password won't be shown again.</p>
      <pre class="logincard">${esc(text)}</pre>
      <div class="toolbar"><span class="grow"></span>
        <button class="btn" data-copy>Copy</button><button class="btn primary" data-x>Done</button></div>`,
      back => {
        back.querySelector('[data-copy]').onclick = async () => {
          try { await navigator.clipboard.writeText(text); toast('Copied.'); }
          catch (_) { toast('Copy not available — select the text and copy it.', true); }
        };
      });
  }

  function openAddPerson(v) {
    openModal(`
      <form id="addPerson">
        <h2>Add a person</h2>
        <label class="field"><span>Full name</span><input name="full_name" required autocomplete="off"></label>
        <label class="field"><span>Email / login</span><input name="email" type="email" required autocomplete="off" placeholder="jsmith@mabldg.com">
          <span class="small muted" style="font-weight:400">No email? Make one up in a set format, e.g. jsmith@mabldg-crew.com.</span></label>
        <label class="field"><span>Temporary password</span>
          <div style="display:flex;gap:6px"><input name="password" required minlength="8" autocomplete="off">
          <button type="button" class="btn" data-gen>New</button></div></label>
        <label class="field"><span>Role</span><select name="role">
          ${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <div class="toolbar"><span class="grow"></span>
          <button type="button" class="btn" data-x>Cancel</button>
          <button class="btn primary" type="submit">Create login</button></div>
      </form>`,
      (back, close) => {
        const f = back.querySelector('form');
        f.password.value = genPassword();
        back.querySelector('[data-gen]').onclick = () => { f.password.value = genPassword(); };
        f.onsubmit = async e => {
          e.preventDefault();
          const btn = f.querySelector('[type=submit]');
          btn.disabled = true; btn.textContent = 'Creating…';
          const body = { action: 'create', full_name: f.full_name.value.trim(), email: f.email.value.trim(),
            password: f.password.value, role: f.role.value };
          const r = await manageUsers(body);
          if (r.error) { toast(r.error, true); btn.disabled = false; btn.textContent = 'Create login'; return; }
          close();
          try { await loadRefs(); } catch (err) { fail(err); }
          viewPeople(v);
          showLoginDetails('Login created', body.full_name, r.email || body.email, body.password);
        };
      });
  }

  function openResetPassword(person) {
    const name = person.full_name || person.email;
    openModal(`
      <form>
        <h2>Reset password</h2>
        <p class="muted small">Set a new password for <b>${esc(name)}</b>. Their old password stops working right away.</p>
        <label class="field"><span>New password</span>
          <div style="display:flex;gap:6px"><input name="password" required minlength="8" autocomplete="off">
          <button type="button" class="btn" data-gen>New</button></div></label>
        <div class="toolbar"><span class="grow"></span>
          <button type="button" class="btn" data-x>Cancel</button>
          <button class="btn primary" type="submit">Reset password</button></div>
      </form>`,
      (back, close) => {
        const f = back.querySelector('form');
        f.password.value = genPassword();
        back.querySelector('[data-gen]').onclick = () => { f.password.value = genPassword(); };
        f.onsubmit = async e => {
          e.preventDefault();
          const btn = f.querySelector('[type=submit]'); btn.disabled = true;
          const r = await manageUsers({ action: 'reset_password', user_id: person.id, password: f.password.value });
          if (r.error) { toast(r.error, true); btn.disabled = false; return; }
          close();
          showLoginDetails('Password reset', name, person.email, f.password.value);
        };
      });
  }

  function viewPeople(v) {
    const counts = { employee: 0, foreman: 0, supervisor: 0 };
    state.profiles.forEach(p => { if (p.active) counts[p.role]++; });
    v.innerHTML = `
      <div class="card">
        <div class="toolbar" style="margin:0 0 6px">
          <h2 class="grow" style="margin:0">People</h2>
          <button class="btn primary" id="addPersonBtn">+ Add person</button>
        </div>
        <p class="muted small" style="margin:0">
          ${counts.employee} employees · ${counts.foreman} foremen · ${counts.supervisor} supervisors active.
          Unticking <b>Active</b> blocks someone from the app but keeps their past hours.</p>
      </div>
      <div class="card table-wrap"><table>
        <thead><tr><th>Name</th><th>Email / login</th><th>Role</th><th>Active</th><th></th></tr></thead>
        <tbody>${state.profiles.map(p => {
          const self = p.id === state.me.id;
          return `<tr data-person="${p.id}">
            <td><input data-f="full_name" value="${esc(p.full_name)}" aria-label="Name"></td>
            <td class="small">${esc(p.email)}</td>
            <td><select data-f="role" ${self ? 'disabled title="You can\'t change your own role"' : ''} aria-label="Role">
              ${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${k === p.role ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
            <td><input type="checkbox" data-f="active" ${p.active ? 'checked' : ''} ${self ? 'disabled' : ''} aria-label="Active"></td>
            <td style="white-space:nowrap"><button class="btn small primary" data-save>Save</button>
              <button class="btn small" data-reset>Reset password</button></td></tr>`;
        }).join('')}</tbody></table></div>`;
    v.querySelector('#addPersonBtn').onclick = () => openAddPerson(v);
    v.querySelectorAll('[data-reset]').forEach(b => b.onclick = () => {
      const p = profileById(b.closest('[data-person]').dataset.person);
      if (p) openResetPassword(p);
    });
    v.querySelectorAll('[data-save]').forEach(b => b.onclick = async () => {
      const tr = b.closest('[data-person]'); const id = tr.dataset.person;
      const upd = { full_name: tr.querySelector('[data-f="full_name"]').value.trim() };
      if (id !== state.me.id) {
        upd.role = tr.querySelector('[data-f="role"]').value;
        upd.active = tr.querySelector('[data-f="active"]').checked;
      }
      b.disabled = true;
      const { error } = await sb.from('profiles').update(upd).eq('id', id);
      b.disabled = false;
      if (error) return fail(error);
      await loadRefs(); toast('Saved.');
      if (id === state.me.id) renderShell();
    });
  }

  window.addEventListener('beforeunload', e => {
    if (state.grid && state.grid.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  boot();
})();
