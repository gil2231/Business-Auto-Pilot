'use strict';

/* Business Auto-Pilot web client. Vanilla JS, no build step. All DOM is created with textContent,
   never innerHTML, so user data can never inject markup. */

(() => {
  // ================= utilities =================

  const root = document.getElementById('app');
  const state = { me: null, catalog: null, pendingApprovals: 0, timers: [] };

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open') el[k] = Boolean(v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  class ApiError extends Error {
    constructor(status, body) {
      super(body?.error || `Request failed (${status})`);
      this.status = status;
      this.details = body?.details || [];
    }
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/api/auth/')) {
        state.me = null;
        renderAuth('login');
      }
      throw new ApiError(res.status, data);
    }
    return data;
  }

  function toast(message, type = 'info') {
    const el = h('div', { class: `toast ${type}` }, message);
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
  }

  function errorBox(err) {
    if (!err) return null;
    const details = (err.details || []).filter((d) => d && d !== err.message);
    const list = details.length > 1 || (details.length === 1 && !err.message.includes(details[0]));
    return h('div', { class: 'error-box' }, details.length > 1 ? 'Please fix the following:' : err.message, list ? h('ul', null, details.map((d) => h('li', null, d))) : null);
  }

  const withBusy = (btn, fn) => async (...args) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await fn(...args);
    } finally {
      btn.disabled = false;
    }
  };

  function money(cents, currency = 'USD') {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100);
    } catch {
      return `${((cents || 0) / 100).toFixed(2)} ${currency}`;
    }
  }

  function compactMoney(cents) {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format((cents || 0) / 100);
  }

  function dateTime(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function day(iso) {
    if (!iso) return '—';
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  function ago(ms) {
    if (!ms) return '—';
    const diff = Date.now() - ms;
    const abs = Math.abs(diff);
    const units = [['d', 86400000], ['h', 3600000], ['m', 60000]];
    for (const [u, size] of units) {
      if (abs >= size) {
        const n = Math.floor(abs / size);
        return diff >= 0 ? `${n}${u} ago` : `in ${n}${u}`;
      }
    }
    return diff >= 0 ? 'just now' : 'in <1m';
  }

  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const badge = (text, cls) => h('span', { class: `badge ${cls || text}` }, String(text).replace(/_/g, ' '));
  const label = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
  const isAdmin = () => ['admin', 'owner'].includes(state.me?.user?.role);

  function field(labelText, input, help) {
    return h('div', { class: 'field' }, h('label', null, labelText), input, help ? h('div', { class: 'help' }, help) : null);
  }

  function select(options, value, attrs = {}) {
    return h('select', attrs, options.map((o) => {
      const [v, text] = Array.isArray(o) ? o : [o, label(String(o))];
      return h('option', { value: v, selected: String(v) === String(value ?? '') }, text);
    }));
  }

  function toggle(checked, onChange, title) {
    const input = h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked, e.target), 'aria-label': title || 'Toggle' });
    return h('label', { class: 'switch', title }, input, h('span', { class: 'slider' }));
  }

  // ================= modal =================

  function modal({ title, body, actions = [], wide = false, onClose }) {
    const footer = h('div', { class: 'modal-foot' });
    const backdrop = h('div', { class: 'modal-backdrop', role: 'dialog', 'aria-modal': 'true' });
    const close = () => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      onClose?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    const errorSlot = h('div');
    const box = h('div', { class: `modal ${wide ? 'wide' : ''}` },
      h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'ghost', onclick: close, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'modal-body' }, errorSlot, body),
      footer);
    for (const a of actions) {
      const btn = h('button', { class: a.class || '' }, a.label);
      btn.addEventListener('click', withBusy(btn, async () => {
        clear(errorSlot);
        try {
          const keepOpen = await a.onClick?.({ close });
          if (!keepOpen && a.closes !== false) close();
        } catch (err) {
          errorSlot.appendChild(errorBox(err));
        }
      }));
      footer.appendChild(btn);
    }
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    const first = box.querySelector('input, select, textarea');
    if (first) setTimeout(() => first.focus(), 30);
    return { close, errorSlot };
  }

  function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = true } = {}) {
    return new Promise((resolve) => {
      let answered = false;
      modal({
        title,
        body: h('p', null, message),
        onClose: () => !answered && resolve(false),
        actions: [
          { label: 'Cancel', onClick: () => {} },
          { label: confirmLabel, class: danger ? 'danger solid' : 'primary', onClick: () => { answered = true; resolve(true); } },
        ],
      });
    });
  }

  // ================= auth screens =================

  function renderAuth(mode) {
    clearTimers();
    const err = h('div');
    const inputs = {
      orgName: h('input', { autocomplete: 'organization', required: true, placeholder: 'Acme Plumbing Ltd' }),
      name: h('input', { autocomplete: 'name', required: true, placeholder: 'Jane Smith' }),
      email: h('input', { type: 'email', autocomplete: 'email', required: true, placeholder: 'you@company.com' }),
      password: h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: mode === 'login' ? undefined : 10 }),
    };
    const submit = h('button', { class: 'primary', type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create workspace');
    const form = h('form', { class: 'card-body' },
      h('h1', null, mode === 'login' ? 'Welcome back' : 'Start automating'),
      h('p', { class: 'muted' }, mode === 'login' ? 'Sign in to your workspace.' : 'Create a workspace for your business. It takes 30 seconds.'),
      err,
      mode === 'signup' ? [field('Business name', inputs.orgName), field('Your name', inputs.name)] : null,
      field('Email', inputs.email),
      field('Password', inputs.password, mode === 'signup' ? 'At least 10 characters.' : null),
      h('div', { class: 'row' }, submit),
      h('div', { class: 'switcher' },
        mode === 'login' ? 'New here? ' : 'Already have an account? ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderAuth(mode === 'login' ? 'signup' : 'login'); } }, mode === 'login' ? 'Create a workspace' : 'Sign in')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(err);
      submit.disabled = true;
      try {
        const body = mode === 'login'
          ? { email: inputs.email.value, password: inputs.password.value }
          : { orgName: inputs.orgName.value, name: inputs.name.value, email: inputs.email.value, password: inputs.password.value };
        state.me = await api('POST', `/api/auth/${mode}`, body);
        if (mode === 'signup') location.hash = '#/welcome';
        await boot();
      } catch (ex) {
        err.appendChild(errorBox(ex));
      } finally {
        submit.disabled = false;
      }
    });
    clear(root).className = '';
    root.appendChild(h('div', { class: 'auth-wrap' },
      h('div', { class: 'auth-hero' },
        h('div', { class: 'row' }, h('img', { src: '/favicon.svg', alt: '', width: 40, height: 40 }), h('strong', null, 'Business Auto-Pilot')),
        h('h1', null, 'Your business, on autopilot.'),
        h('p', null, 'Leads, tasks, invoices and approvals in one place, with automations that do the follow-up for you.'),
        h('ul', null,
          h('li', null, 'Instant lead follow-up and task assignment'),
          h('li', null, 'Automatic overdue-invoice reminders'),
          h('li', null, 'Approval flows for big deals and spend'),
          h('li', null, 'Webhooks, schedules and an API for everything else'))),
      h('div', { class: 'auth-form' }, h('div', { class: 'card' }, form))));
  }

  // ================= layout & routing =================

  const NAV = [
    ['Overview', null],
    ['#/dashboard', 'Dashboard'],
    ['#/contacts', 'Contacts'],
    ['#/tasks', 'Tasks'],
    ['#/invoices', 'Invoices'],
    ['Automation', null],
    ['#/automations', 'Automations'],
    ['#/templates', 'Templates'],
    ['#/approvals', 'Approvals'],
    ['#/runs', 'Run history'],
    ['#/outbox', 'Outbox'],
    ['Account', null],
    ['#/settings', 'Settings'],
  ];

  let mainEl = null;
  let navEl = null;

  function renderShell() {
    navEl = h('nav', { class: 'nav' });
    mainEl = h('main', { class: 'main' });
    const logout = h('button', { class: 'sm' }, 'Sign out');
    logout.addEventListener('click', async () => {
      await api('POST', '/api/auth/logout').catch(() => {});
      state.me = null;
      location.hash = '';
      renderAuth('login');
    });
    clear(root).className = '';
    root.appendChild(h('div', { class: 'shell' },
      h('aside', { class: 'sidebar' },
        h('a', { class: 'brand', href: '#/dashboard' }, h('img', { src: '/favicon.svg', alt: '' }), 'Auto-Pilot'),
        navEl,
        h('div', { class: 'sidebar-footer' },
          h('div', { class: 'who' }, state.me.user?.name || 'API'),
          h('div', { class: 'org' }, state.me.org?.name),
          logout)),
      mainEl));
    renderNav();
  }

  function renderNav() {
    if (!navEl) return;
    clear(navEl);
    const current = `#/${(location.hash.slice(2) || 'dashboard').split('/')[0]}`;
    for (const [href, text] of NAV) {
      if (!text) {
        navEl.appendChild(h('div', { class: 'nav-section' }, href));
        continue;
      }
      const count = href === '#/approvals' && state.pendingApprovals > 0 ? h('span', { class: 'count' }, state.pendingApprovals) : null;
      navEl.appendChild(h('a', { href, class: current === href ? 'active' : '' }, text, count));
    }
  }

  async function refreshApprovalCount() {
    try {
      const res = await api('GET', '/api/approvals?status=pending');
      state.pendingApprovals = res.items.length;
      renderNav();
    } catch {
      /* ignore */
    }
  }

  function clearTimers() {
    for (const t of state.timers) clearInterval(t);
    state.timers = [];
  }

  function every(ms, fn) {
    state.timers.push(setInterval(fn, ms));
  }

  const ROUTES = [
    [/^dashboard$/, pageDashboard],
    [/^welcome$/, pageWelcome],
    [/^contacts$/, pageContacts],
    [/^contacts\/([^/]+)$/, pageContact],
    [/^tasks$/, pageTasks],
    [/^invoices$/, pageInvoices],
    [/^automations$/, pageAutomations],
    [/^automations\/new$/, (m) => pageWorkflowEditor(m, null)],
    [/^automations\/([^/]+)$/, (m, id) => pageWorkflowEditor(m, id)],
    [/^templates$/, pageTemplates],
    [/^approvals$/, pageApprovals],
    [/^runs$/, pageRuns],
    [/^runs\/([^/]+)$/, pageRun],
    [/^outbox$/, pageOutbox],
    [/^settings$/, pageSettings],
  ];

  let routeToken = 0;
  async function route() {
    if (!state.me) return;
    clearTimers();
    every(30000, refreshApprovalCount);
    const path = location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard';
    renderNav();
    const token = ++routeToken;
    clear(mainEl);
    for (const [re, page] of ROUTES) {
      const m = re.exec(path);
      if (!m) continue;
      try {
        await page(mainEl, ...m.slice(1).map(decodeURIComponent));
      } catch (err) {
        if (token !== routeToken) return;
        if (err.status === 401) return;
        clear(mainEl).appendChild(h('div', { class: 'card card-body' }, h('h2', null, err.status === 404 ? 'Not found' : 'Something went wrong'), h('p', { class: 'muted' }, err.message)));
      }
      return;
    }
    location.hash = '#/dashboard';
  }

  function pageHead(title, subtitle, ...actions) {
    return h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), subtitle ? h('p', null, subtitle) : null), h('div', { class: 'row' }, actions));
  }

  function emptyState(title, text, action) {
    return h('div', { class: 'empty' }, h('h3', null, title), h('p', null, text), action || null);
  }

  // ================= dashboard =================

  async function pageDashboard(main) {
    const d = await api('GET', '/api/dashboard');
    const openStages = ['lead', 'qualified', 'proposal', 'negotiation'];
    const byStage = Object.fromEntries(d.pipeline.map((p) => [p.stage, p]));
    const openPipeline = openStages.reduce((t, s) => t + (byStage[s]?.value_cents || 0), 0);
    const openDeals = openStages.reduce((t, s) => t + (byStage[s]?.count || 0), 0);
    const a = d.automation;

    const kpi = (labelText, value, sub, subClass) => h('div', { class: 'card kpi' }, h('div', { class: 'label' }, labelText), h('div', { class: 'value' }, value), h('div', { class: `sub ${subClass || ''}` }, sub));

    const maxStage = Math.max(1, ...['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'].map((s) => byStage[s]?.value_cents || 0));
    const bars = h('div', { class: 'bars' }, ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'].map((s) => {
      const fill = h('div', { class: 'bar-fill' });
      requestAnimationFrame(() => { fill.style.width = `${((byStage[s]?.value_cents || 0) / maxStage) * 100}%`; });
      if (s === 'won') fill.style.background = 'var(--success)';
      if (s === 'lost') fill.style.background = 'var(--danger)';
      return h('div', { class: 'bar-row' }, h('div', null, label(s), h('span', { class: 'muted small' }, ` · ${byStage[s]?.count || 0}`)), h('div', { class: 'bar-track' }, fill), h('div', { class: 'right' }, money(byStage[s]?.value_cents || 0)));
    }));

    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`);
    }
    const rev = Object.fromEntries(d.revenueByMonth.map((r) => [r.month, r.cents]));
    const maxRev = Math.max(1, ...months.map((m) => rev[m] || 0));
    const columns = h('div', { class: 'columns' }, months.map((m) => {
      const fill = h('div', { class: 'col-fill', title: money(rev[m] || 0) });
      fill.style.height = `${Math.max(2, ((rev[m] || 0) / maxRev) * 110)}px`;
      return h('div', { class: 'column' }, h('div', { class: 'small' }, rev[m] ? compactMoney(rev[m]) : ''), fill, new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' }));
    }));

    const runsTable = d.recentRuns.length === 0
      ? emptyState('No automation runs yet', 'Install a template to start automating.', h('a', { class: 'btn primary', href: '#/templates' }, 'Browse templates'))
      : h('div', { class: 'table-wrap' }, h('table', null,
        h('tbody', null, d.recentRuns.map((r) => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/runs/${r.id}`; } },
          h('td', null, h('div', { class: 'title' }, r.workflow_name), h('div', { class: 'sub' }, r.error || `Triggered by ${r.trigger_type}`)),
          h('td', null, badge(r.status)),
          h('td', { class: 'right muted nowrap' }, ago(r.created_at)))))));

    append(main, [
      pageHead('Dashboard', `${state.me.org.name} at a glance`),
      d.automation.activeWorkflows === 0 ? h('div', { class: 'card card-body', style: { marginBottom: '16px' } },
        h('div', { class: 'row' }, h('div', { class: 'spacer' }, h('h2', null, 'Put your business on autopilot'), h('p', { class: 'muted' }, 'You have no active automations. Install a ready-made one in under a minute.')),
          h('a', { class: 'btn primary', href: '#/templates' }, 'Browse templates'))) : null,
      h('div', { class: 'grid cols-4' },
        kpi('Open pipeline', money(openPipeline), `${openDeals} open deals · ${money(d.wonThisMonth.value_cents)} won this month`),
        kpi('Outstanding invoices', money(d.invoices.outstanding_cents), d.invoices.overdue_count ? `${money(d.invoices.overdue_cents)} overdue (${d.invoices.overdue_count})` : 'Nothing overdue', d.invoices.overdue_count ? 'bad' : 'good'),
        kpi('Open tasks', d.tasks.open, d.tasks.overdue ? `${d.tasks.overdue} overdue · ${d.tasks.due_today} due today` : `${d.tasks.due_today} due today · ${d.tasks.done_7d} done this week`, d.tasks.overdue ? 'bad' : ''),
        kpi('Time saved (30 days)', `${a.hoursSaved30d} h`, `${a.steps30d} automated steps · ${a.successRate24h === null ? 'no runs today' : `${Math.round(a.successRate24h * 100)}% success (24h)`}`)),
      h('div', { class: 'grid cols-2 mt' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Pipeline by stage'), h('a', { href: '#/contacts?view=board' }, 'Open board')), h('div', { class: 'card-body' }, bars)),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Revenue collected'), h('span', { class: 'muted small' }, `${money(d.invoices.paid_30d_cents)} in the last 30 days`)), h('div', { class: 'card-body' }, columns))),
      h('div', { class: 'grid cols-2 mt' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Recent automation activity'), h('a', { href: '#/runs' }, 'All runs')), runsTable),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Needs your attention')),
          h('div', { class: 'card-body stack' },
            attention(a.pendingApprovals, 'approval request(s) waiting', '#/approvals'),
            attention(d.invoices.overdue_count, 'overdue invoice(s)', '#/invoices?status=overdue'),
            attention(d.tasks.overdue, 'overdue task(s)', '#/tasks?due=overdue'),
            attention(d.automation.runs24h.failed || 0, 'failed automation run(s) today', '#/runs?status=failed'),
            !a.pendingApprovals && !d.invoices.overdue_count && !d.tasks.overdue && !d.automation.runs24h.failed ? h('p', { class: 'muted' }, 'All clear. Nice work.') : null))),
    ]);
  }

  function attention(n, text, href) {
    if (!n) return null;
    return h('a', { href, class: 'row' }, badge(String(n), 'danger'), h('span', null, text), h('span', { class: 'spacer' }), '→');
  }

  function pageWelcome(main) {
    append(main, [
      pageHead(`Welcome, ${state.me.user?.name?.split(' ')[0] || ''}!`, 'Three steps to put your business on autopilot.'),
      h('div', { class: 'grid cols-3' },
        welcomeCard('1. Add your contacts', 'Add leads and customers, or send them in from your website form via a webhook.', '#/contacts', 'Go to contacts'),
        welcomeCard('2. Install automations', 'Speed-to-lead, invoice reminders, deal approvals, weekly digests and more, all ready to use.', '#/templates', 'Browse templates'),
        welcomeCard('3. Invite your team', 'Add teammates so tasks and approvals reach the right people.', '#/settings', 'Open settings')),
    ]);
  }

  function welcomeCard(title, text, href, cta) {
    return h('div', { class: 'card tpl-card' }, h('h2', null, title), h('p', null, text), h('a', { class: 'btn primary', href }, cta));
  }

  function hashQuery() {
    const q = location.hash.split('?')[1] || '';
    return Object.fromEntries(new URLSearchParams(q));
  }

  // ================= contacts =================

  const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];

  async function pageContacts(main) {
    const query = hashQuery();
    let view = query.view === 'board' ? 'board' : 'list';
    const search = h('input', { type: 'search', placeholder: 'Search name, email, company…', value: query.q || '' });
    const stage = select([['', 'All stages'], ...STAGES.map((s) => [s, label(s)])], query.stage || '');
    const body = h('div');
    const viewBtn = h('button', null);
    const setViewLabel = () => { viewBtn.textContent = view === 'board' ? 'List view' : 'Board view'; };
    setViewLabel();
    viewBtn.addEventListener('click', () => { view = view === 'board' ? 'list' : 'board'; setViewLabel(); load(); });

    async function load() {
      const params = new URLSearchParams({ limit: view === 'board' ? '500' : '200' });
      if (search.value.trim()) params.set('q', search.value.trim());
      if (stage.value && view === 'list') params.set('stage', stage.value);
      const res = await api('GET', `/api/contacts?${params}`);
      clear(body);
      if (view === 'board') body.appendChild(contactBoard(res.items, load));
      else body.appendChild(h('div', { class: 'card' }, h('div', { class: 'toolbar' }, search, stage, h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, `${res.total} contact(s)`)), contactTable(res.items)));
    }
    let debounce;
    search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 250); });
    stage.addEventListener('change', load);

    append(main, [
      pageHead('Contacts', 'Leads, deals and customers.', viewBtn, h('button', { class: 'primary', onclick: () => contactModal(null, (c) => { location.hash = `#/contacts/${c.id}`; }) }, '+ New contact')),
      body,
    ]);
    await load();
  }

  function contactTable(items) {
    if (items.length === 0) return emptyState('No contacts found', 'Add your first contact or capture them automatically with the "Website form → CRM" template.');
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Company'), h('th', null, 'Stage'), h('th', { class: 'right' }, 'Value'), h('th', null, 'Owner'), h('th', null, 'Updated'))),
      h('tbody', null, items.map((c) => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/contacts/${c.id}`; } },
        h('td', null, h('div', { class: 'title' }, c.name), h('div', { class: 'sub' }, c.email || c.phone || ''), c.tags.map((t) => h('span', { class: 'tag' }, t))),
        h('td', null, c.company || '—'),
        h('td', null, badge(c.stage)),
        h('td', { class: 'right nowrap' }, money(c.value_cents)),
        h('td', null, c.owner || '—'),
        h('td', { class: 'muted nowrap' }, ago(c.updated_at)))))));
  }

  function contactBoard(items, reload) {
    let dragging = null;
    return h('div', { class: 'board' }, STAGES.map((s) => {
      const cards = items.filter((c) => c.stage === s);
      const col = h('div', { class: 'board-col' },
        h('h3', null, h('span', null, label(s)), h('span', null, compactMoney(cards.reduce((t, c) => t + c.value_cents, 0)))),
        cards.map((c) => {
          const card = h('div', { class: 'board-card', draggable: 'true', onclick: () => { location.hash = `#/contacts/${c.id}`; } },
            h('div', { class: 'name' }, c.name), h('div', { class: 'meta' }, h('span', null, c.company || ''), h('span', null, money(c.value_cents))));
          card.addEventListener('dragstart', (e) => { dragging = c; e.dataTransfer.effectAllowed = 'move'; });
          return card;
        }));
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
      col.addEventListener('dragleave', () => col.classList.remove('drop'));
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('drop');
        if (!dragging || dragging.stage === s) return;
        try {
          await api('PATCH', `/api/contacts/${dragging.id}`, { stage: s });
          toast(`${dragging.name} moved to ${label(s)}`);
          await reload();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      return col;
    }));
  }

  function contactModal(contact, onSaved) {
    const c = contact || {};
    const f = {
      name: h('input', { value: c.name || '' }),
      email: h('input', { type: 'email', value: c.email || '' }),
      phone: h('input', { value: c.phone || '' }),
      company: h('input', { value: c.company || '' }),
      stage: select(STAGES, c.stage || 'lead'),
      value: h('input', { type: 'number', min: 0, step: '0.01', value: c.value_cents ? (c.value_cents / 100).toFixed(2) : '' }),
      owner: h('input', { value: c.owner || '' }),
      tags: h('input', { value: (c.tags || []).join(', '), placeholder: 'vip, referral' }),
      notes: h('textarea', { value: c.notes || '' }),
    };
    modal({
      title: contact ? 'Edit contact' : 'New contact',
      body: h('div', { class: 'form-grid' },
        h('div', { class: 'full' }, field('Name *', f.name)),
        field('Email', f.email), field('Phone', f.phone),
        field('Company', f.company), field('Stage', f.stage),
        field('Deal value', f.value), field('Owner', f.owner),
        h('div', { class: 'full' }, field('Tags', f.tags, 'Comma separated')),
        h('div', { class: 'full' }, field('Notes', f.notes))),
      actions: [
        { label: 'Cancel' },
        {
          label: contact ? 'Save' : 'Create contact',
          class: 'primary',
          onClick: async () => {
            const body = {
              name: f.name.value, email: f.email.value, phone: f.phone.value, company: f.company.value, stage: f.stage.value,
              value_cents: f.value.value === '' ? 0 : Math.round(Number(f.value.value) * 100), owner: f.owner.value,
              tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean), notes: f.notes.value,
            };
            const saved = contact ? await api('PATCH', `/api/contacts/${contact.id}`, body) : await api('POST', '/api/contacts', body);
            toast(contact ? 'Contact saved' : 'Contact created');
            onSaved?.(saved);
          },
        },
      ],
    });
  }

  async function pageContact(main, id) {
    const c = await api('GET', `/api/contacts/${id}`);
    const reload = () => route();
    const del = h('button', { class: 'danger' }, 'Delete');
    del.addEventListener('click', async () => {
      if (!(await confirmDialog(`Delete ${c.name}? Linked tasks and invoices are kept but unlinked.`, { confirmLabel: 'Delete' }))) return;
      await api('DELETE', `/api/contacts/${c.id}`);
      toast('Contact deleted');
      location.hash = '#/contacts';
    });
    const stageSel = select(STAGES, c.stage);
    stageSel.addEventListener('change', async () => {
      try {
        await api('PATCH', `/api/contacts/${c.id}`, { stage: stageSel.value });
        toast(`Stage changed to ${label(stageSel.value)}`);
        reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    stageSel.style.width = 'auto';
    append(main, [
      h('div', { class: 'muted small' }, h('a', { href: '#/contacts' }, '← Contacts')),
      pageHead(c.name, [c.company, c.email].filter(Boolean).join(' · '), stageSel, h('button', { onclick: () => contactModal(c, reload) }, 'Edit'), del),
      h('div', { class: 'grid cols-3' },
        h('div', { class: 'card card-body' },
          h('dl', { class: 'kv' },
            h('dt', null, 'Email'), h('dd', null, c.email ? h('a', { href: `mailto:${c.email}` }, c.email) : '—'),
            h('dt', null, 'Phone'), h('dd', null, c.phone ? h('a', { href: `tel:${c.phone}` }, c.phone) : '—'),
            h('dt', null, 'Company'), h('dd', null, c.company || '—'),
            h('dt', null, 'Deal value'), h('dd', null, money(c.value_cents)),
            h('dt', null, 'Owner'), h('dd', null, c.owner || '—'),
            h('dt', null, 'Tags'), h('dd', null, c.tags.length ? c.tags.map((t) => h('span', { class: 'tag' }, t)) : '—'),
            h('dt', null, 'Created'), h('dd', null, dateTime(c.created_at))),
          c.notes ? [h('h3', { class: 'mt' }, 'Notes'), h('p', { class: 'muted' }, h('pre', null, c.notes))] : null),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', null, 'Tasks'), h('button', { class: 'sm', onclick: () => taskModal({ contact_id: c.id }, reload) }, '+ Task')),
          c.tasks.length ? h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, c.tasks.map((t) => taskRow(t, reload, false))))) : emptyState('No tasks', '')),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', null, 'Invoices'), h('button', { class: 'sm', onclick: () => invoiceModal({ contact_id: c.id }, reload) }, '+ Invoice')),
          c.invoices.length ? h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, c.invoices.map((i) => h('tr', { class: 'clickable', onclick: () => invoiceDetail(i.id, reload) },
            h('td', null, h('div', { class: 'title' }, i.number), h('div', { class: 'sub' }, `Due ${day(i.due_date)}`)), h('td', null, badge(i.status)), h('td', { class: 'right' }, money(i.amount_cents, i.currency))))))) : emptyState('No invoices', ''))),
    ]);
  }

  // ================= tasks =================

  async function pageTasks(main) {
    const query = hashQuery();
    const status = select([['active', 'Active'], ['open', 'Open'], ['in_progress', 'In progress'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['', 'All']], query.status ?? 'active');
    const due = select([['', 'Any due date'], ['overdue', 'Overdue'], ['today', 'Due today']], query.due || '');
    const search = h('input', { type: 'search', placeholder: 'Search tasks…' });
    const body = h('div');
    async function load() {
      const p = new URLSearchParams({ limit: '300' });
      if (status.value) p.set('status', status.value);
      if (due.value) p.set('due', due.value);
      if (search.value.trim()) p.set('q', search.value.trim());
      const res = await api('GET', `/api/tasks?${p}`);
      clear(body).appendChild(res.items.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Task'), h('th', null, 'Priority'), h('th', null, 'Assignee'), h('th', null, 'Due'), h('th', null, ''))),
          h('tbody', null, res.items.map((t) => taskRow(t, load, true)))))
        : emptyState('No tasks here', 'Tasks created by you or your automations appear here.'));
    }
    let debounce;
    search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 250); });
    status.addEventListener('change', load);
    due.addEventListener('change', load);
    append(main, [
      pageHead('Tasks', 'Everything that needs doing, from people and automations.', h('button', { class: 'primary', onclick: () => taskModal({}, load) }, '+ New task')),
      h('div', { class: 'card' }, h('div', { class: 'toolbar' }, search, status, due), body),
    ]);
    await load();
  }

  function taskRow(t, reload, full) {
    const overdue = t.due_date && t.due_date < todayIso() && ['open', 'in_progress'].includes(t.status);
    const check = h('input', { type: 'checkbox', checked: t.status === 'done', 'aria-label': 'Mark done', onclick: (e) => e.stopPropagation() });
    check.addEventListener('change', async () => {
      try {
        await api('PATCH', `/api/tasks/${t.id}`, { status: check.checked ? 'done' : 'open' });
        toast(check.checked ? 'Task completed' : 'Task reopened');
        reload();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    return h('tr', { class: 'clickable', onclick: () => taskModal(t, reload) },
      h('td', null, check),
      h('td', null, h('div', { class: 'title' }, t.status === 'done' ? h('s', null, t.title) : t.title), t.source ? h('div', { class: 'sub' }, `via ${t.source}`) : null),
      full ? h('td', null, badge(t.priority, t.priority === 'normal' || t.priority === 'low' ? '' : t.priority)) : null,
      full ? h('td', null, t.assignee || '—') : null,
      h('td', { class: 'nowrap' }, overdue ? badge(`Overdue · ${day(t.due_date)}`, 'overdue') : day(t.due_date)),
      full ? h('td', null, t.status !== 'open' && t.status !== 'done' ? badge(t.status) : null) : null);
  }

  function taskModal(task, onSaved) {
    const t = task || {};
    const editing = Boolean(t.id);
    const f = {
      title: h('input', { value: t.title || '' }),
      description: h('textarea', { value: t.description || '' }),
      status: select(['open', 'in_progress', 'done', 'cancelled'], t.status || 'open'),
      priority: select(['low', 'normal', 'high', 'urgent'], t.priority || 'normal'),
      assignee: h('input', { value: t.assignee || '' }),
      due: h('input', { type: 'date', value: t.due_date || '' }),
    };
    const actions = [{ label: 'Cancel' }];
    if (editing) {
      actions.unshift({
        label: 'Delete',
        class: 'danger',
        onClick: async () => {
          await api('DELETE', `/api/tasks/${t.id}`);
          toast('Task deleted');
          onSaved?.();
        },
      });
    }
    actions.push({
      label: editing ? 'Save' : 'Create task',
      class: 'primary',
      onClick: async () => {
        const body = { title: f.title.value, description: f.description.value, status: f.status.value, priority: f.priority.value, assignee: f.assignee.value, due_date: f.due.value || null };
        if (!editing && t.contact_id) body.contact_id = t.contact_id;
        if (editing) await api('PATCH', `/api/tasks/${t.id}`, body);
        else await api('POST', '/api/tasks', body);
        toast(editing ? 'Task saved' : 'Task created');
        onSaved?.();
      },
    });
    modal({
      title: editing ? 'Edit task' : 'New task',
      body: h('div', { class: 'form-grid' },
        h('div', { class: 'full' }, field('Title *', f.title)),
        h('div', { class: 'full' }, field('Description', f.description)),
        field('Status', f.status), field('Priority', f.priority),
        field('Assignee', f.assignee), field('Due date', f.due)),
      actions,
    });
  }

  // ================= invoices =================

  async function pageInvoices(main) {
    const query = hashQuery();
    const status = select([['', 'All statuses'], ['unpaid', 'Unpaid'], 'draft', 'sent', 'overdue', 'paid', 'void'], query.status || '');
    const search = h('input', { type: 'search', placeholder: 'Invoice # or customer…' });
    const body = h('div');
    async function load() {
      const p = new URLSearchParams({ limit: '300' });
      if (status.value) p.set('status', status.value);
      if (search.value.trim()) p.set('q', search.value.trim());
      const res = await api('GET', `/api/invoices?${p}`);
      clear(body).appendChild(res.items.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Invoice'), h('th', null, 'Customer'), h('th', null, 'Status'), h('th', null, 'Due'), h('th', { class: 'right' }, 'Amount'))),
          h('tbody', null, res.items.map((i) => h('tr', { class: 'clickable', onclick: () => invoiceDetail(i.id, load) },
            h('td', null, h('div', { class: 'title' }, i.number), h('div', { class: 'sub' }, `Created ${day(new Date(i.created_at).toISOString().slice(0, 10))}`)),
            h('td', null, i.contact_name || '—'),
            h('td', null, badge(i.status), i.reminder_count ? h('span', { class: 'muted small' }, ` ${i.reminder_count} reminder(s)`) : null),
            h('td', null, day(i.due_date)),
            h('td', { class: 'right nowrap' }, money(i.amount_cents, i.currency)))))))
        : emptyState('No invoices', 'Create an invoice, or let the "Won deal" automation draft them for you.'));
    }
    let debounce;
    search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 250); });
    status.addEventListener('change', load);
    append(main, [
      pageHead('Invoices', 'Bill customers and get paid faster with automatic reminders.', h('button', { class: 'primary', onclick: () => invoiceModal({}, load) }, '+ New invoice')),
      h('div', { class: 'card' }, h('div', { class: 'toolbar' }, search, status), body),
    ]);
    await load();
  }

  async function invoiceModal(invoice, onSaved) {
    const inv = invoice || {};
    const editing = Boolean(inv.id);
    const contacts = (await api('GET', '/api/contacts?limit=500')).items;
    const f = {
      contact: select([['', '— No contact —'], ...contacts.map((c) => [c.id, c.company ? `${c.name} (${c.company})` : c.name])], inv.contact_id || ''),
      number: h('input', { value: inv.number || '', placeholder: 'Auto (INV-0001)' }),
      currency: h('input', { value: inv.currency || 'USD', maxlength: 3 }),
      due: h('input', { type: 'date', value: inv.due_date || (() => { const d = new Date(Date.now() + 30 * 86400000); return d.toISOString().slice(0, 10); })() }),
      notes: h('textarea', { value: inv.notes || '' }),
    };
    const items = (inv.items?.length ? inv.items : [{ description: '', quantity: 1, unit_price_cents: 0 }]).map((it) => ({ ...it }));
    const itemsEl = h('div');
    const totalEl = h('strong');
    function renderItems() {
      clear(itemsEl);
      items.forEach((it, idx) => {
        const desc = h('input', { value: it.description, placeholder: 'Description' });
        const qty = h('input', { type: 'number', min: 0, step: 'any', value: it.quantity });
        const price = h('input', { type: 'number', min: 0, step: '0.01', value: (it.unit_price_cents / 100).toFixed(2) });
        desc.addEventListener('input', () => { it.description = desc.value; });
        qty.addEventListener('input', () => { it.quantity = Number(qty.value) || 0; updateTotal(); });
        price.addEventListener('input', () => { it.unit_price_cents = Math.round((Number(price.value) || 0) * 100); updateTotal(); });
        qty.style.width = '80px';
        price.style.width = '120px';
        itemsEl.appendChild(h('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'nowrap' } }, desc, qty, price,
          h('button', { class: 'ghost', title: 'Remove line', onclick: () => { if (items.length > 1) { items.splice(idx, 1); renderItems(); } } }, '✕')));
      });
      updateTotal();
    }
    function updateTotal() {
      totalEl.textContent = money(items.reduce((t, it) => t + Math.round(it.quantity * it.unit_price_cents), 0), f.currency.value.toUpperCase() || 'USD');
    }
    f.currency.addEventListener('input', updateTotal);
    renderItems();
    modal({
      title: editing ? `Edit ${inv.number}` : 'New invoice',
      wide: true,
      body: h('div', null,
        h('div', { class: 'form-grid' }, field('Customer', f.contact), field('Invoice number', f.number), field('Currency', f.currency), field('Due date', f.due)),
        h('label', null, 'Line items ', h('span', { class: 'hint' }, '(description · quantity · unit price)')),
        itemsEl,
        h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => { items.push({ description: '', quantity: 1, unit_price_cents: 0 }); renderItems(); } }, '+ Add line'), h('span', { class: 'spacer' }), 'Total: ', totalEl),
        h('div', { class: 'mt' }, field('Notes', f.notes))),
      actions: [
        { label: 'Cancel' },
        {
          label: editing ? 'Save draft' : 'Create draft',
          class: 'primary',
          onClick: async () => {
            const body = {
              contact_id: f.contact.value || null, number: f.number.value || null, currency: f.currency.value.toUpperCase(), due_date: f.due.value || null,
              notes: f.notes.value, items: items.filter((it) => it.description.trim()).map((it) => ({ description: it.description, quantity: it.quantity, unit_price_cents: it.unit_price_cents })),
            };
            const saved = editing ? await api('PATCH', `/api/invoices/${inv.id}`, body) : await api('POST', '/api/invoices', body);
            toast(editing ? 'Invoice saved' : `Invoice ${saved.number} created`);
            onSaved?.();
          },
        },
      ],
    });
  }

  async function invoiceDetail(id, onChange) {
    const inv = await api('GET', `/api/invoices/${id}`);
    const setStatus = (status, msg) => async () => {
      await api('POST', `/api/invoices/${id}/status`, { status });
      toast(msg);
      onChange?.();
    };
    const actions = [{ label: 'Close' }];
    if (inv.status === 'draft') {
      actions.unshift({ label: 'Delete', class: 'danger', onClick: async () => { await api('DELETE', `/api/invoices/${id}`); toast('Invoice deleted'); onChange?.(); } });
      actions.push({ label: 'Edit', onClick: () => invoiceModal(inv, onChange) });
      actions.push({ label: 'Mark as sent', class: 'primary', onClick: setStatus('sent', 'Invoice marked as sent') });
    }
    if (['sent', 'overdue'].includes(inv.status)) {
      actions.unshift({ label: 'Void', class: 'danger', onClick: setStatus('void', 'Invoice voided') });
      actions.push({ label: 'Mark as paid', class: 'success', onClick: setStatus('paid', 'Payment recorded') });
    }
    modal({
      title: `Invoice ${inv.number}`,
      wide: true,
      body: h('div', null,
        h('div', { class: 'row', style: { marginBottom: '14px' } }, badge(inv.status), h('span', { class: 'muted' }, inv.contact ? `${inv.contact.name}${inv.contact.email ? ` · ${inv.contact.email}` : ''}` : 'No customer'), h('span', { class: 'spacer' }), h('span', { class: 'muted' }, `Due ${day(inv.due_date)}`)),
        h('div', { class: 'card' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Description'), h('th', { class: 'right' }, 'Qty'), h('th', { class: 'right' }, 'Unit price'), h('th', { class: 'right' }, 'Amount'))),
          h('tbody', null,
            inv.items.map((it) => h('tr', null, h('td', null, it.description), h('td', { class: 'right' }, it.quantity), h('td', { class: 'right' }, money(it.unit_price_cents, inv.currency)), h('td', { class: 'right' }, money(Math.round(it.quantity * it.unit_price_cents), inv.currency)))),
            h('tr', null, h('td', { colspan: 3, class: 'right' }, h('strong', null, 'Total')), h('td', { class: 'right' }, h('strong', null, money(inv.amount_cents, inv.currency))))))),
        inv.notes ? h('p', { class: 'muted mt' }, inv.notes) : null,
        h('dl', { class: 'kv mt' },
          h('dt', null, 'Sent'), h('dd', null, dateTime(inv.sent_at)),
          h('dt', null, 'Paid'), h('dd', null, dateTime(inv.paid_at)),
          h('dt', null, 'Reminders sent'), h('dd', null, inv.reminder_count))),
      actions,
    });
  }

  // ================= automations =================

  async function loadCatalog() {
    state.catalog ||= await api('GET', '/api/catalog');
    return state.catalog;
  }

  function describeTrigger(t) {
    if (!t) return '';
    switch (t.type) {
      case 'manual': return 'Run manually';
      case 'webhook': return 'Incoming webhook';
      case 'schedule': return `Schedule: ${t.cron} (${t.timezone || 'UTC'})`;
      case 'event': return `When ${t.event}${t.filter ? ' (filtered)' : ''}`;
      default: return t.type;
    }
  }

  async function pageAutomations(main) {
    const res = await api('GET', '/api/workflows');
    const admin = isAdmin();
    const list = res.items.length === 0
      ? emptyState('No automations yet', 'Start from a proven template or build your own.', h('div', { class: 'row', style: { justifyContent: 'center' } }, h('a', { class: 'btn primary', href: '#/templates' }, 'Browse templates'), admin ? h('a', { class: 'btn', href: '#/automations/new' }, 'Build from scratch') : null))
      : h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'On'), h('th', null, 'Automation'), h('th', null, 'Last 7 days'), h('th', null, 'Last run'), h('th', null, ''))),
        h('tbody', null, res.items.map((wf) => {
          const runBtn = h('button', { class: 'sm', onclick: (e) => e.stopPropagation() }, 'Run now');
          runBtn.addEventListener('click', withBusy(runBtn, async () => {
            const r = await api('POST', `/api/workflows/${wf.id}/run`, { data: {} });
            toast('Run started');
            location.hash = `#/runs/${r.id}`;
          }));
          return h('tr', { class: 'clickable', onclick: () => { location.hash = `#/automations/${wf.id}`; } },
            h('td', { onclick: (e) => e.stopPropagation() }, toggle(wf.enabled, async (on, input) => {
              if (!admin) { input.checked = !on; return toast('Only admins can change automations', 'error'); }
              try {
                await api('PATCH', `/api/workflows/${wf.id}`, { enabled: on });
                toast(on ? `${wf.name} enabled` : `${wf.name} paused`);
              } catch (err) {
                input.checked = !on;
                toast(err.message, 'error');
              }
            }, 'Enabled')),
            h('td', null, h('div', { class: 'title' }, wf.name), h('div', { class: 'sub' }, describeTrigger(wf.trigger), wf.next_run_at ? ` · next ${dateTime(Date.parse(wf.next_run_at))}` : '', ` · ${wf.steps.length} step(s)`)),
            h('td', null, h('div', { class: 'row' }, badge(`${wf.stats7d.succeeded} ok`, 'succeeded'), wf.stats7d.failed ? badge(`${wf.stats7d.failed} failed`, 'failed') : null, wf.stats7d.active ? badge(`${wf.stats7d.active} active`, 'running') : null)),
            h('td', { class: 'muted nowrap' }, ago(wf.stats7d.lastRunAt)),
            h('td', { class: 'right' }, wf.trigger.type === 'manual' || wf.trigger.type === 'schedule' ? runBtn : null));
        }))));
    append(main, [
      pageHead('Automations', 'Workflows that run your business processes automatically.',
        h('a', { class: 'btn', href: '#/templates' }, 'Templates'),
        admin ? h('a', { class: 'btn primary', href: '#/automations/new' }, '+ New automation') : null),
      h('div', { class: 'card' }, list),
    ]);
  }

  async function pageTemplates(main) {
    const res = await api('GET', '/api/templates');
    const admin = isAdmin();
    append(main, [
      pageHead('Templates', 'Proven automations you can switch on in a minute. Every one is fully editable afterwards.'),
      admin ? null : h('div', { class: 'error-box' }, 'Only admins can install templates.'),
      h('div', { class: 'grid cols-3' }, res.items.map((t) => h('div', { class: 'card tpl-card' },
        h('div', { class: 'row' }, badge(t.category, 'primary'), h('span', { class: 'muted small' }, `${t.stepCount} steps`)),
        h('h2', null, t.name),
        h('p', null, t.summary),
        h('div', { class: 'muted small' }, describeTrigger(t.trigger)),
        admin ? h('button', { class: 'primary', onclick: () => installTemplate(t) }, 'Use this template') : null))),
    ]);
  }

  function installTemplate(t) {
    const inputs = {};
    const enable = h('input', { type: 'checkbox', checked: true });
    modal({
      title: t.name,
      body: h('div', null,
        h('p', { class: 'muted' }, t.summary),
        t.settings.map((s) => {
          inputs[s.key] = h('input', { value: s.default });
          return field(s.label, inputs[s.key]);
        }),
        h('label', { class: 'row' }, enable, 'Turn it on immediately')),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Install',
          class: 'primary',
          onClick: async () => {
            const settings = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
            const wf = await api('POST', `/api/templates/${t.id}/install`, { settings, enabled: enable.checked });
            toast(`"${wf.name}" installed${enable.checked ? ' and running' : ''}`);
            location.hash = `#/automations/${wf.id}`;
          },
        },
      ],
    });
  }

  // ----- workflow editor -----

  const STEP_SKELETONS = {
    send_email: { to: '{{ trigger.email }}', subject: '', body: '' },
    create_task: { title: '', priority: 'normal', dueInDays: 1 },
    http_request: { method: 'POST', url: 'https://', body: {} },
    slack_message: { webhookUrl: 'https://hooks.slack.com/services/…', text: '' },
    delay: { hours: 24 },
    approval: { title: '', details: '', timeoutHours: 48 },
    log: { message: '' },
    set_variables: { values: {} },
    transform: { value: {} },
    create_contact: { name: '', email: '', skipIfExists: true },
    update_contact: { id: '{{ trigger.id }}' },
    get_contact: { id: '{{ trigger.id }}' },
    find_contacts: { stage: 'lead' },
    update_task: { id: '', status: 'done' },
    find_tasks: { due: 'overdue' },
    create_invoice: { contact_id: '{{ trigger.id }}', items: [{ description: '', quantity: 1, unit_price_cents: 0 }], dueInDays: 30 },
    set_invoice_status: { id: '{{ trigger.id }}', status: 'sent' },
    get_invoice: { id: '{{ trigger.id }}' },
    find_invoices: { status: 'overdue' },
    record_invoice_reminder: { id: '{{ trigger.id }}' },
    emit_event: { type: 'custom.something_happened', data: {} },
  };

  async function pageWorkflowEditor(main, id) {
    const catalog = await loadCatalog();
    const admin = isAdmin();
    const wf = id ? await api('GET', `/api/workflows/${id}`) : {
      name: '', description: '', enabled: false, trigger: { type: 'event', event: 'contact.created' },
      steps: [{ id: 'step1', type: 'log', params: { message: 'New contact: {{ trigger.name }}' } }],
    };
    const model = JSON.parse(JSON.stringify({ name: wf.name, description: wf.description || '', enabled: wf.enabled, trigger: wf.trigger, steps: wf.steps }));
    const actionsByType = Object.fromEntries(catalog.actions.map((a) => [a.type, a]));
    const errorsEl = h('div');
    let jsonMode = false;

    const nameIn = h('input', { value: model.name, placeholder: 'e.g. Follow up with new leads' });
    const descIn = h('input', { value: model.description, placeholder: 'What does this automation do?' });
    nameIn.addEventListener('input', () => { model.name = nameIn.value; });
    descIn.addEventListener('input', () => { model.description = descIn.value; });

    const triggerEl = h('div', { class: 'trigger-box' });
    const stepsEl = h('div');
    const jsonEl = h('textarea', { class: 'code', style: { minHeight: '520px' } });

    function renderTrigger() {
      clear(triggerEl);
      const t = model.trigger;
      const typeSel = select([['event', 'When something happens (event)'], ['schedule', 'On a schedule'], ['webhook', 'When a webhook is received'], ['manual', 'Only when run manually']], t.type);
      typeSel.addEventListener('change', () => {
        model.trigger = { type: typeSel.value };
        if (typeSel.value === 'event') model.trigger.event = 'contact.created';
        if (typeSel.value === 'schedule') Object.assign(model.trigger, { cron: '0 9 * * 1-5', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
        renderTrigger();
      });
      const parts = [h('h3', null, '⚡ Trigger'), field('Starts', typeSel)];
      if (t.type === 'event') {
        const ev = h('input', { value: t.event || '', list: 'event-list' });
        ev.addEventListener('input', () => { t.event = ev.value.trim(); });
        parts.push(field('Event', ev, 'Built-in events are suggested. Use wildcards like "invoice.*", or your own "custom.*" events.'),
          h('datalist', { id: 'event-list' }, catalog.events.map((e) => h('option', { value: e }))));
      }
      if (t.type === 'schedule') {
        const cronIn = h('input', { value: t.cron || '', class: 'mono' });
        const tzIn = h('input', { value: t.timezone || 'UTC' });
        cronIn.addEventListener('input', () => { t.cron = cronIn.value; });
        tzIn.addEventListener('input', () => { t.timezone = tzIn.value; });
        const presets = select([['', 'Presets…'], ['0 9 * * 1-5', 'Weekdays at 9:00'], ['0 8 * * 1', 'Mondays at 8:00'], ['0 * * * *', 'Every hour'], ['*/15 * * * *', 'Every 15 minutes'], ['0 9 1 * *', 'First of the month at 9:00'], ['0 17 * * 5', 'Fridays at 17:00']], '');
        presets.addEventListener('change', () => { if (presets.value) { t.cron = presets.value; cronIn.value = presets.value; } });
        parts.push(h('div', { class: 'form-grid' }, field('Cron expression', cronIn, 'minute hour day month weekday'), field('Time zone', tzIn)), presets);
      }
      if (t.type === 'webhook') {
        parts.push(id
          ? h('div', null,
            h('label', null, 'Webhook URL'),
            h('div', { class: 'secret' }, `${location.origin}/hooks/${id}`),
            h('p', { class: 'small muted' }, 'POST JSON (or a form) with header ', h('code', null, 'X-Webhook-Secret'), '. The body becomes ', h('code', null, 'trigger'), '. Send an ', h('code', null, 'Idempotency-Key'), ' header to make retries safe.'),
            h('details', null, h('summary', null, 'Show secret & example'),
              h('div', { class: 'secret' }, wf.webhook_secret),
              h('pre', { class: 'secret mt' }, `curl -X POST ${location.origin}/hooks/${id} \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-Webhook-Secret: ${wf.webhook_secret}' \\\n  -d '{"name":"Jane","email":"jane@example.com"}'`)))
          : h('p', { class: 'muted' }, 'Save the automation to get its webhook URL.'));
      }
      if (t.type === 'manual') parts.push(h('p', { class: 'muted small' }, 'Run it from the Automations list or via the API: POST /api/workflows/:id/run'));
      const filterIn = h('input', { value: t.filter || '', class: 'mono', placeholder: "e.g. trigger.value_cents > 500000 && trigger.stage == 'lead'" });
      filterIn.addEventListener('input', () => { t.filter = filterIn.value || undefined; });
      if (t.type !== 'manual') parts.push(field('Only run if (optional)', filterIn, 'An expression; the run is skipped when it is false.'));
      append(triggerEl, parts);
    }

    function stepIdOptions(exclude) {
      return [['', '(next step)'], ...model.steps.filter((s) => s.id !== exclude).map((s) => [s.id, s.name ? `${s.id} – ${s.name}` : s.id]), ['end', 'End the run']];
    }

    function renderSteps() {
      clear(stepsEl);
      model.steps.forEach((step, idx) => {
        if (idx > 0) stepsEl.appendChild(h('div', { class: 'connector' }));
        stepsEl.appendChild(stepCard(step, idx));
      });
      const addSel = select([['', '+ Add a step…'], ...groupedTypes()], '');
      addSel.addEventListener('change', () => {
        if (!addSel.value) return;
        const type = addSel.value;
        let n = model.steps.length + 1;
        while (model.steps.some((s) => s.id === `step${n}`)) n++;
        const step = { id: `step${n}`, type };
        if (type === 'condition') Object.assign(step, { if: 'true' });
        else if (type === 'goto') step.next = 'end';
        else step.params = JSON.parse(JSON.stringify(STEP_SKELETONS[type] || {}));
        model.steps.push(step);
        renderSteps();
      });
      addSel.style.width = 'auto';
      stepsEl.appendChild(h('div', { class: 'row mt' }, addSel));
    }

    function groupedTypes() {
      const groups = {};
      for (const a of catalog.actions) (groups[a.category] ||= []).push(a);
      return Object.entries(groups).flatMap(([cat, list]) => list.map((a) => [a.type, `${cat}: ${a.label}`]));
    }

    function stepCard(step, idx) {
      const def = actionsByType[step.type] || {};
      const idIn = h('input', { value: step.id, class: 'mono', title: 'Step id (used as steps.<id> in later steps)' });
      idIn.style.width = '150px';
      idIn.addEventListener('change', () => {
        const old = step.id;
        step.id = idIn.value.trim();
        for (const s of model.steps) for (const k of ['next', 'then', 'else', 'onError']) if (s[k] === old) s[k] = step.id;
        renderSteps();
      });
      const nameIn2 = h('input', { value: step.name || '', placeholder: def.label || step.type });
      nameIn2.addEventListener('input', () => { step.name = nameIn2.value || undefined; });
      const move = (dir) => () => {
        const j = idx + dir;
        if (j < 0 || j >= model.steps.length) return;
        [model.steps[idx], model.steps[j]] = [model.steps[j], model.steps[idx]];
        renderSteps();
      };
      const body = h('div', { class: 'step-body' });
      if (def.description) body.appendChild(h('p', { class: 'muted small', style: { marginTop: 0 } }, def.description));
      if (step.type === 'condition') {
        const ifIn = h('input', { value: step.if || '', class: 'mono' });
        ifIn.addEventListener('input', () => { step.if = ifIn.value; });
        const thenSel = select(stepIdOptions(step.id), step.then || '');
        const elseSel = select(stepIdOptions(step.id), step.else || '');
        thenSel.addEventListener('change', () => { step.then = thenSel.value || undefined; });
        elseSel.addEventListener('change', () => { step.else = elseSel.value || undefined; });
        append(body, [field('If', ifIn, 'e.g. steps.approve.approved, or trigger.value_cents >= 100000'), h('div', { class: 'form-grid' }, field('Then go to', thenSel), field('Otherwise go to', elseSel))]);
      } else if (step.type === 'goto') {
        const nextSel = select(stepIdOptions(step.id).slice(1), step.next || 'end');
        nextSel.addEventListener('change', () => { step.next = nextSel.value; });
        body.appendChild(field('Go to', nextSel));
      } else {
        const paramsIn = h('textarea', { class: 'code' });
        paramsIn.value = JSON.stringify(step.params || {}, null, 2);
        const paramErr = h('div', { class: 'small', style: { color: 'var(--danger)' } });
        paramsIn.addEventListener('input', () => {
          try {
            step.params = JSON.parse(paramsIn.value);
            paramErr.textContent = '';
          } catch (e) {
            paramErr.textContent = `Invalid JSON: ${e.message}`;
          }
        });
        const paramDocs = Object.entries(def.params || {}).map(([k, p]) => h('span', { class: 'tag' }, `${k}${p.required ? '*' : ''}: ${p.type}`));
        append(body, [h('label', null, 'Parameters ', h('span', { class: 'hint' }, '(JSON; use {{ expressions }} in strings)')), paramsIn, paramErr, h('div', { class: 'small mt' }, paramDocs)]);
      }
      // Advanced
      const whenIn = h('input', { value: step.when || '', class: 'mono', placeholder: 'Run this step only if…' });
      whenIn.addEventListener('input', () => { step.when = whenIn.value || undefined; });
      const nextSel = select(stepIdOptions(step.id), step.type === 'goto' ? '' : step.next || '');
      nextSel.addEventListener('change', () => { step.next = nextSel.value || undefined; });
      const retryIn = h('input', { type: 'number', min: 0, max: 10, value: step.retry?.max ?? 0 });
      const backoffIn = h('input', { type: 'number', min: 1, value: Math.round((step.retry?.backoffMs ?? 5000) / 1000) });
      const updateRetry = () => {
        const max = Number(retryIn.value) || 0;
        step.retry = max > 0 ? { max, backoffMs: Math.max(100, (Number(backoffIn.value) || 5) * 1000) } : undefined;
      };
      retryIn.addEventListener('input', updateRetry);
      backoffIn.addEventListener('input', updateRetry);
      const onErrSel = select([['fail', 'Stop the run (fail)'], ['continue', 'Continue with next step'], ...model.steps.filter((s) => s.id !== step.id).map((s) => [s.id, `Go to ${s.id}`])], step.onError || 'fail');
      onErrSel.addEventListener('change', () => { step.onError = onErrSel.value === 'fail' ? undefined : onErrSel.value; });
      const hasAdvanced = step.when || (step.next && step.type !== 'goto') || step.retry || step.onError;
      body.appendChild(h('details', { open: hasAdvanced }, h('summary', null, 'Conditions, branching & error handling'),
        h('div', { class: 'form-grid mt' },
          h('div', { class: 'full' }, field('Only run when', whenIn)),
          step.type !== 'goto' && step.type !== 'condition' ? field('After this step, go to', nextSel) : null,
          step.type !== 'goto' && step.type !== 'condition' ? field('If it fails', onErrSel) : null,
          step.type !== 'goto' && step.type !== 'condition' ? field('Retries', retryIn) : null,
          step.type !== 'goto' && step.type !== 'condition' ? field('First retry after (seconds)', backoffIn, 'Doubles each attempt') : null)));

      return h('div', { class: 'step-card' },
        h('div', { class: 'step-head' },
          h('span', { class: 'step-num' }, idx + 1), badge(def.label || step.type, 'primary'), idIn, nameIn2,
          h('span', { class: 'spacer' }),
          h('button', { class: 'ghost sm', title: 'Move up', onclick: move(-1) }, '↑'),
          h('button', { class: 'ghost sm', title: 'Move down', onclick: move(1) }, '↓'),
          h('button', { class: 'ghost sm danger', title: 'Remove step', onclick: () => { model.steps.splice(idx, 1); renderSteps(); } }, '✕')),
        body);
    }

    function syncFromJson() {
      if (!jsonMode) return true;
      try {
        const parsed = JSON.parse(jsonEl.value);
        model.trigger = parsed.trigger;
        model.steps = parsed.steps;
        return true;
      } catch (e) {
        clear(errorsEl).appendChild(errorBox(new Error(`Invalid JSON: ${e.message}`)));
        return false;
      }
    }

    const payload = () => ({ name: model.name, description: model.description, enabled: model.enabled, trigger: model.trigger, steps: model.steps });

    const validateBtn = h('button', null, 'Validate');
    validateBtn.addEventListener('click', withBusy(validateBtn, async () => {
      if (!syncFromJson()) return;
      const res = await api('POST', '/api/workflows/validate', payload());
      clear(errorsEl);
      if (res.valid) errorsEl.appendChild(h('div', { class: 'ok-box' }, '✓ Looks good. This automation is valid.'));
      else errorsEl.appendChild(errorBox({ message: res.errors.join('; '), details: res.errors }));
    }));

    const saveBtn = h('button', { class: 'primary' }, id ? 'Save changes' : 'Create automation');
    saveBtn.addEventListener('click', withBusy(saveBtn, async () => {
      if (!syncFromJson()) return;
      clear(errorsEl);
      try {
        const saved = id ? await api('PUT', `/api/workflows/${id}`, payload()) : await api('POST', '/api/workflows', payload());
        toast('Automation saved');
        if (!id) location.hash = `#/automations/${saved.id}`;
        else route();
      } catch (err) {
        errorsEl.appendChild(errorBox(err));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }));

    const jsonBtn = h('button', null, 'Edit as JSON');
    jsonBtn.addEventListener('click', () => {
      if (jsonMode) {
        if (!syncFromJson()) return;
        jsonMode = false;
        jsonBtn.textContent = 'Edit as JSON';
        jsonEl.classList.add('hidden');
        triggerEl.classList.remove('hidden');
        stepsEl.classList.remove('hidden');
        renderTrigger();
        renderSteps();
      } else {
        jsonMode = true;
        jsonBtn.textContent = 'Visual editor';
        jsonEl.value = JSON.stringify({ trigger: model.trigger, steps: model.steps }, null, 2);
        jsonEl.classList.remove('hidden');
        triggerEl.classList.add('hidden');
        stepsEl.classList.add('hidden');
      }
    });
    jsonEl.classList.add('hidden');

    const headerActions = [];
    if (id) {
      const runBtn = h('button', null, '▶ Test run');
      runBtn.addEventListener('click', () => testRunModal(id));
      headerActions.push(h('a', { class: 'btn', href: `#/runs?workflow=${id}` }, 'Runs'), runBtn);
      if (admin) {
        const more = select([['', 'More…'], ['duplicate', 'Duplicate'], ['rotate', 'Rotate webhook secret'], ['delete', 'Delete']], '');
        more.style.width = 'auto';
        more.addEventListener('change', async () => {
          const v = more.value;
          more.value = '';
          try {
            if (v === 'duplicate') {
              const copy = await api('POST', `/api/workflows/${id}/duplicate`);
              toast('Duplicated');
              location.hash = `#/automations/${copy.id}`;
            } else if (v === 'rotate' && (await confirmDialog('Existing integrations using the old secret will stop working.', { confirmLabel: 'Rotate' }))) {
              await api('POST', `/api/workflows/${id}/rotate-secret`);
              toast('Webhook secret rotated');
              route();
            } else if (v === 'delete' && (await confirmDialog(`Delete "${wf.name}" and its run history?`, { confirmLabel: 'Delete' }))) {
              await api('DELETE', `/api/workflows/${id}`);
              toast('Automation deleted');
              location.hash = '#/automations';
            }
          } catch (err) {
            toast(err.message, 'error');
          }
        });
        headerActions.push(more);
      }
    }

    const enabledToggle = toggle(model.enabled, (on) => { model.enabled = on; }, 'Enabled');
    const reference = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Reference')),
      h('div', { class: 'card-body small' },
        h('h3', null, 'Data you can use'),
        h('div', { class: 'catalog-item' }, h('code', null, 'trigger.*'), ' — the event / webhook / schedule data'),
        h('div', { class: 'catalog-item' }, h('code', null, 'steps.<id>.*'), ' — output of an earlier step'),
        h('div', { class: 'catalog-item' }, h('code', null, 'vars.*'), ' — values from "Set variables"'),
        h('div', { class: 'catalog-item' }, h('code', null, 'event.type'), ', ', h('code', null, 'run.id')),
        h('h3', { class: 'mt' }, 'Examples'),
        h('pre', { class: 'secret' }, 'Hi {{ trigger.name }}!\n{{ formatMoney(trigger.amount_cents) }}\n{{ addDays(today(), 7) }}\n{{ trigger.company ?? "there" }}'),
        h('h3', { class: 'mt' }, 'Functions'),
        h('p', null, catalog.functions.map((fn) => h('span', { class: 'tag mono' }, fn))),
        h('h3', { class: 'mt' }, 'Events'),
        h('p', null, catalog.events.map((e) => h('span', { class: 'tag mono' }, e)))));

    append(main, [
      h('div', { class: 'muted small' }, h('a', { href: '#/automations' }, '← Automations')),
      pageHead(id ? wf.name : 'New automation', id ? `Version ${wf.version} · ${describeTrigger(wf.trigger)}` : 'Describe when it starts and what it should do.', headerActions),
      !admin ? h('div', { class: 'error-box' }, 'You can view this automation, but only admins can change it.') : null,
      errorsEl,
      h('div', { class: 'wf-layout' },
        h('div', null,
          h('div', { class: 'card card-body', style: { marginBottom: '14px' } },
            h('div', { class: 'form-grid' }, field('Name', nameIn), field('Description', descIn)),
            h('div', { class: 'row' }, enabledToggle, h('span', null, 'Enabled'), h('span', { class: 'spacer' }), jsonBtn, validateBtn, admin ? saveBtn : null)),
          triggerEl, stepsEl, jsonEl),
        reference),
    ]);
    renderTrigger();
    renderSteps();
  }

  function testRunModal(id) {
    const data = h('textarea', { class: 'code' });
    data.value = '{\n  "name": "Test Person",\n  "email": "test@example.com"\n}';
    modal({
      title: 'Test run',
      body: h('div', null, h('p', { class: 'muted' }, 'Runs the automation now with this sample trigger data. Real actions (emails, tasks…) will be performed.'), field('Trigger data (JSON)', data)),
      actions: [
        { label: 'Cancel' },
        {
          label: 'Run now',
          class: 'primary',
          onClick: async () => {
            let parsed;
            try {
              parsed = JSON.parse(data.value || '{}');
            } catch (e) {
              throw new Error(`Invalid JSON: ${e.message}`);
            }
            const r = await api('POST', `/api/workflows/${id}/run`, { data: parsed });
            location.hash = `#/runs/${r.id}`;
          },
        },
      ],
    });
  }

  // ================= runs =================

  async function pageRuns(main) {
    const query = hashQuery();
    const workflowsRes = await api('GET', '/api/workflows');
    const wfSel = select([['', 'All automations'], ...workflowsRes.items.map((w) => [w.id, w.name])], query.workflow || '');
    const statusSel = select([['', 'All statuses'], 'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'], query.status || '');
    const body = h('div');
    async function load() {
      const p = new URLSearchParams({ limit: '200' });
      if (wfSel.value) p.set('workflow_id', wfSel.value);
      if (statusSel.value) p.set('status', statusSel.value);
      const res = await api('GET', `/api/runs?${p}`);
      clear(body).appendChild(res.items.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Automation'), h('th', null, 'Status'), h('th', null, 'Trigger'), h('th', null, 'Steps'), h('th', null, 'Started'), h('th', null, 'Duration'))),
          h('tbody', null, res.items.map((r) => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/runs/${r.id}`; } },
            h('td', null, h('div', { class: 'title' }, r.workflow_name), r.error ? h('div', { class: 'sub' }, r.error) : null),
            h('td', null, badge(r.status), r.status === 'waiting' && r.next_run_at ? h('div', { class: 'sub' }, `resumes ${ago(r.next_run_at)}`) : null),
            h('td', null, r.trigger_type),
            h('td', null, r.step_count),
            h('td', { class: 'nowrap muted' }, ago(r.created_at)),
            h('td', { class: 'nowrap muted' }, r.finished_at && r.started_at ? `${((r.finished_at - r.started_at) / 1000).toFixed(1)}s` : '—'))))))
        : emptyState('No runs', 'Runs appear here as your automations fire.'));
    }
    wfSel.addEventListener('change', load);
    statusSel.addEventListener('change', load);
    append(main, [pageHead('Run history', 'Every automation run, step by step.'), h('div', { class: 'card' }, h('div', { class: 'toolbar' }, wfSel, statusSel), body)]);
    await load();
    every(5000, load);
  }

  async function pageRun(main, id) {
    const container = h('div');
    main.appendChild(container);
    let last = '';
    async function load() {
      const r = await api('GET', `/api/runs/${id}`);
      const sig = `${r.status}:${r.logs.length}`;
      if (sig === last) return;
      last = sig;
      const actions = [];
      if (['queued', 'running', 'waiting'].includes(r.status)) {
        const cancel = h('button', { class: 'danger' }, 'Cancel run');
        cancel.addEventListener('click', withBusy(cancel, async () => {
          if (!(await confirmDialog('Stop this run? Steps already completed are not undone.', { confirmLabel: 'Cancel run' }))) return;
          await api('POST', `/api/runs/${id}/cancel`);
          toast('Run cancelled');
          last = '';
          load();
        }));
        actions.push(cancel);
      } else if (isAdmin()) {
        const retry = h('button', null, '↻ Run again');
        retry.addEventListener('click', withBusy(retry, async () => {
          const res = await api('POST', `/api/runs/${id}/retry`);
          toast('New run started');
          location.hash = `#/runs/${res.id}`;
        }));
        actions.push(retry);
      }
      const pendingApproval = r.approvals.find((a) => a.status === 'pending');
      clear(container);
      append(container, [
        h('div', { class: 'muted small' }, h('a', { href: '#/runs' }, '← Run history')),
        pageHead(r.workflow_name, `Run ${r.id}`, badge(r.status), h('a', { class: 'btn', href: `#/automations/${r.workflow_id}` }, 'Open automation'), actions),
        r.error ? h('div', { class: 'error-box' }, r.error) : null,
        pendingApproval ? h('div', { class: 'card card-body', style: { marginBottom: '16px' } }, h('div', { class: 'row' }, h('div', { class: 'spacer' }, h('strong', null, 'Waiting for approval: '), pendingApproval.title), h('a', { class: 'btn primary', href: '#/approvals' }, 'Review'))) : null,
        h('div', { class: 'grid cols-2' },
          h('div', { class: 'card card-body' }, h('dl', { class: 'kv' },
            h('dt', null, 'Trigger'), h('dd', null, r.trigger_type),
            h('dt', null, 'Created'), h('dd', null, dateTime(r.created_at)),
            h('dt', null, 'Finished'), h('dd', null, dateTime(r.finished_at)),
            h('dt', null, 'Steps run'), h('dd', null, r.step_count),
            h('dt', null, 'Current step'), h('dd', null, r.current_step || '—'),
            r.status === 'waiting' || r.status === 'queued' ? [h('dt', null, 'Resumes'), h('dd', null, r.next_run_at ? `${dateTime(r.next_run_at)} (${ago(r.next_run_at)})` : 'on decision')] : null,
            h('dt', null, 'Version'), h('dd', null, r.workflow_version))),
          h('div', { class: 'card card-body' }, h('h3', null, 'Trigger data'), h('pre', { class: 'mt' }, JSON.stringify(r.trigger_data, null, 2)))),
        h('div', { class: 'card mt' }, h('div', { class: 'card-head' }, h('h2', null, 'Timeline')),
          h('div', { class: 'timeline' }, r.logs.map((l) => h('div', { class: `log ${l.level}` },
            h('div', { class: 'time' }, new Date(l.created_at).toLocaleTimeString()),
            h('div', { class: 'step' }, l.step_id || 'run'),
            h('div', null, l.message, l.data !== null && l.data !== undefined ? h('details', null, h('summary', null, 'Output'), h('pre', null, typeof l.data === 'string' ? l.data : JSON.stringify(l.data, null, 2))) : null))))),
        Object.keys(r.vars || {}).length ? h('div', { class: 'card card-body mt' }, h('h3', null, 'Variables'), h('pre', { class: 'mt' }, JSON.stringify(r.vars, null, 2))) : null,
      ]);
    }
    await load();
    every(2000, () => load().catch(() => {}));
  }

  // ================= approvals =================

  async function pageApprovals(main) {
    const statusSel = select([['pending', 'Waiting for decision'], ['all', 'All requests']], 'pending');
    const body = h('div');
    async function load() {
      const res = await api('GET', `/api/approvals?status=${statusSel.value}`);
      state.pendingApprovals = statusSel.value === 'pending' ? res.items.length : state.pendingApprovals;
      renderNav();
      clear(body).appendChild(res.items.length === 0
        ? emptyState(statusSel.value === 'pending' ? 'Inbox zero' : 'No approval requests yet', 'Automations that need a human decision will ask here.')
        : h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, res.items.map((a) => {
          const decide = (approved) => () => {
            const comment = h('textarea', { placeholder: 'Optional comment' });
            modal({
              title: approved ? 'Approve request' : 'Reject request',
              body: h('div', null, h('p', null, h('strong', null, a.title)), field('Comment', comment)),
              actions: [{ label: 'Cancel' }, {
                label: approved ? 'Approve' : 'Reject',
                class: approved ? 'success' : 'danger solid',
                onClick: async () => {
                  await api('POST', `/api/approvals/${a.id}/decide`, { approved, comment: comment.value });
                  toast(approved ? 'Approved, automation resumed' : 'Rejected, automation resumed');
                  load();
                },
              }],
            });
          };
          return h('tr', null,
            h('td', null, h('div', { class: 'title' }, a.title), a.details ? h('pre', { class: 'sub' }, a.details) : null,
              h('div', { class: 'sub' }, `${a.workflow_name} · requested ${ago(a.created_at)}`, a.expires_at && a.status === 'pending' ? ` · expires ${ago(a.expires_at)}` : '',
                a.decided_by ? ` · ${a.status} by ${a.decided_by}${a.comment ? `: "${a.comment}"` : ''}` : '')),
            h('td', { class: 'right nowrap' }, a.status === 'pending'
              ? [h('button', { class: 'danger', onclick: decide(false) }, 'Reject'), ' ', h('button', { class: 'success', onclick: decide(true) }, 'Approve')]
              : badge(a.status)));
        })))));
    }
    statusSel.addEventListener('change', load);
    append(main, [pageHead('Approvals', 'Decisions your automations are waiting on.'), h('div', { class: 'card' }, h('div', { class: 'toolbar' }, statusSel), body)]);
    await load();
    every(10000, load);
  }

  // ================= outbox =================

  async function pageOutbox(main) {
    const res = await api('GET', '/api/outbox?limit=200');
    append(main, [
      pageHead('Outbox', 'Emails and chat messages sent by your automations.'),
      h('div', { class: 'card' }, res.items.length === 0 ? emptyState('Nothing sent yet', 'Messages from automations will be listed here.') : h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Message'), h('th', null, 'To'), h('th', null, 'Status'), h('th', null, 'Sent'))),
        h('tbody', null, res.items.map((m) => h('tr', {
          class: 'clickable',
          onclick: () => modal({
            title: m.subject || `${label(m.channel)} message`,
            wide: true,
            body: h('div', null, h('p', { class: 'muted' }, `To: ${m.recipient} · ${dateTime(m.created_at)}`), m.error ? h('div', { class: 'error-box' }, m.error) : null, h('pre', { class: 'secret' }, m.body),
              m.run_id ? h('p', null, h('a', { href: `#/runs/${m.run_id}` }, 'View the run that sent this →')) : null),
            actions: [{ label: 'Close' }],
          }),
        },
        h('td', null, h('div', { class: 'title' }, m.subject || '(chat message)'), h('div', { class: 'sub' }, m.body.slice(0, 90))),
        h('td', null, m.recipient),
        h('td', null, badge(m.status), ' ', badge(m.channel, '')),
        h('td', { class: 'muted nowrap' }, ago(m.created_at)))))))),
    ]);
  }

  // ================= settings =================

  async function pageSettings(main) {
    const admin = isAdmin();
    const owner = state.me.user?.role === 'owner';
    const sections = [];

    // Organization
    if (owner) {
      const orgName = h('input', { value: state.me.org.name });
      const saveOrg = h('button', { class: 'primary' }, 'Save');
      saveOrg.addEventListener('click', withBusy(saveOrg, async () => {
        try {
          state.me.org = await api('PATCH', '/api/org', { name: orgName.value });
          toast('Workspace renamed');
          renderShell();
          route();
        } catch (err) {
          toast(err.message, 'error');
        }
      }));
      sections.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Workspace')), h('div', { class: 'card-body' }, field('Business name', orgName), saveOrg)));
    }

    // Password
    if (state.me.user) {
      const cur = h('input', { type: 'password', autocomplete: 'current-password' });
      const next = h('input', { type: 'password', autocomplete: 'new-password' });
      const pwBtn = h('button', null, 'Change password');
      const pwErr = h('div');
      pwBtn.addEventListener('click', withBusy(pwBtn, async () => {
        clear(pwErr);
        try {
          await api('POST', '/api/auth/password', { currentPassword: cur.value, newPassword: next.value });
          cur.value = '';
          next.value = '';
          toast('Password changed. Other sessions were signed out.');
        } catch (err) {
          pwErr.appendChild(errorBox(err));
        }
      }));
      sections.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Your account')),
        h('div', { class: 'card-body' }, h('p', { class: 'muted' }, `${state.me.user.name} · ${state.me.user.email} · ${state.me.user.role}`), pwErr, field('Current password', cur), field('New password', next, 'At least 10 characters'), pwBtn)));
    }

    if (admin) {
      // Team
      const team = await api('GET', '/api/users');
      const teamCard = h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Team'), h('button', { class: 'sm primary', onclick: inviteUser }, '+ Add teammate')),
        h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, team.items.map((u) => {
          const roleSel = u.role === 'owner' ? badge('owner', 'primary') : select(['admin', 'member'], u.role);
          if (u.role !== 'owner') {
            roleSel.style.width = 'auto';
            roleSel.addEventListener('change', async () => {
              try {
                await api('PATCH', `/api/users/${u.id}`, { role: roleSel.value });
                toast('Role updated');
              } catch (err) {
                toast(err.message, 'error');
              }
            });
          }
          const activeToggle = u.role === 'owner' || u.id === state.me.user?.id ? null : toggle(u.active, async (on, input) => {
            try {
              await api('PATCH', `/api/users/${u.id}`, { active: on });
              toast(on ? 'User reactivated' : 'User deactivated');
            } catch (err) {
              input.checked = !on;
              toast(err.message, 'error');
            }
          }, 'Active');
          return h('tr', null, h('td', null, h('div', { class: 'title' }, u.name), h('div', { class: 'sub' }, u.email)), h('td', null, roleSel), h('td', { class: 'right' }, activeToggle));
        })))));
      sections.push(teamCard);

      // API keys
      const keys = await api('GET', '/api/api-keys');
      sections.push(h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'API keys'), h('button', { class: 'sm primary', onclick: createKey }, '+ New key')),
        h('div', { class: 'card-body small muted' }, 'Use keys to connect other systems: ', h('code', null, 'Authorization: Bearer bap_…'), '. Every UI action is available over the REST API.'),
        keys.items.length ? h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, keys.items.map((k) => h('tr', null,
          h('td', null, h('div', { class: 'title' }, k.name), h('div', { class: 'sub mono' }, `${k.prefix}…`)),
          h('td', null, badge(k.role, '')),
          h('td', { class: 'muted small' }, k.last_used_at ? `used ${ago(k.last_used_at)}` : 'never used'),
          h('td', { class: 'right' }, h('button', {
            class: 'sm danger',
            onclick: async () => {
              if (!(await confirmDialog(`Revoke "${k.name}"? Integrations using it will stop working.`, { confirmLabel: 'Revoke' }))) return;
              await api('DELETE', `/api/api-keys/${k.id}`);
              toast('Key revoked');
              route();
            },
          }, 'Revoke'))))))) : null));

      // Audit
      const auditRes = await api('GET', '/api/audit?limit=50');
      sections.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'Audit log'), h('span', { class: 'muted small' }, 'Last 50 events')),
        h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, auditRes.items.map((a) => h('tr', null,
          h('td', { class: 'mono small' }, a.action), h('td', { class: 'small' }, a.actor), h('td', { class: 'muted small nowrap right' }, dateTime(a.created_at)))))))));
    }

    append(main, [pageHead('Settings', 'Workspace, team, security and integrations.'), h('div', { class: 'grid cols-2' }, sections)]);
  }

  function inviteUser() {
    const f = { name: h('input'), email: h('input', { type: 'email' }), password: h('input', { type: 'text', value: generatePassword() }), role: select(['member', 'admin'], 'member') };
    modal({
      title: 'Add teammate',
      body: h('div', null, field('Name', f.name), field('Email', f.email), field('Temporary password', f.password, 'Share it securely; they can change it in Settings.'), field('Role', f.role, 'Admins can manage automations, team and API keys.')),
      actions: [{ label: 'Cancel' }, {
        label: 'Add teammate',
        class: 'primary',
        onClick: async () => {
          await api('POST', '/api/users', { name: f.name.value, email: f.email.value, password: f.password.value, role: f.role.value });
          toast('Teammate added');
          route();
        },
      }],
    });
  }

  function generatePassword() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');
  }

  function createKey() {
    const name = h('input', { placeholder: 'e.g. Website, Zapier, Accounting sync' });
    const role = select(['member', 'admin'], 'member');
    modal({
      title: 'New API key',
      body: h('div', null, field('Name', name), field('Access', role, 'Member keys can manage records and run automations; admin keys can also edit automations.')),
      actions: [{ label: 'Cancel' }, {
        label: 'Create key',
        class: 'primary',
        onClick: async () => {
          const key = await api('POST', '/api/api-keys', { name: name.value, role: role.value });
          modal({
            title: 'Copy your API key',
            body: h('div', null, h('p', null, 'This is the only time the full key is shown. Store it somewhere safe.'), h('div', { class: 'secret' }, key.key)),
            actions: [{ label: 'Copy & close', class: 'primary', onClick: async () => { await navigator.clipboard?.writeText(key.key).catch(() => {}); toast('Copied'); } }],
            onClose: () => route(),
          });
        },
      }],
    });
  }

  // ================= boot =================

  async function boot() {
    try {
      state.me = await api('GET', '/api/auth/me');
    } catch {
      renderAuth('login');
      return;
    }
    renderShell();
    refreshApprovalCount();
    await route();
  }

  window.addEventListener('hashchange', () => route());
  boot();
})();
