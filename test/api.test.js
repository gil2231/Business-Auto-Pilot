'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { silent } = require('./helpers');

async function startServer() {
  const app = createApp({ dbPath: ':memory:', port: 0, host: '127.0.0.1', workerPollMs: 20 }, { logger: silent });
  const addr = await app.start();
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (method, path, { body, token, headers = {}, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, data, headers: res.headers };
  };
  const signup = async (email, orgName = 'Org') => {
    const r = await call('POST', '/api/auth/signup', { body: { orgName, name: 'Owner', email, password: 'a-strong-password' } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.token;
  };
  return { app, base, call, signup };
}

test('auth: signup, login, me, logout and bad credentials', async (t) => {
  const s = await startServer();
  t.after(() => s.app.stop());
  const token = await s.signup('ann@acme.dev', 'Acme');
  const me = await s.call('GET', '/api/auth/me', { token });
  assert.equal(me.data.user.email, 'ann@acme.dev');
  assert.equal(me.data.user.role, 'owner');
  assert.equal(me.data.org.name, 'Acme');
  assert.equal((await s.call('POST', '/api/auth/signup', { body: { orgName: 'X', name: 'Y', email: 'ANN@acme.dev', password: 'a-strong-password' } })).status, 400);
  assert.equal((await s.call('POST', '/api/auth/signup', { body: { orgName: 'X', name: 'Y', email: 'z@acme.dev', password: 'short' } })).status, 400);
  assert.equal((await s.call('POST', '/api/auth/login', { body: { email: 'ann@acme.dev', password: 'wrong-password' } })).status, 401);
  assert.equal((await s.call('POST', '/api/auth/login', { body: { email: 'nobody@acme.dev', password: 'wrong-password' } })).status, 401);
  const login = await s.call('POST', '/api/auth/login', { body: { email: 'Ann@Acme.dev', password: 'a-strong-password' } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /bap_session=.*HttpOnly.*SameSite=Lax/);
  await s.call('POST', '/api/auth/logout', { token: login.data.token });
  assert.equal((await s.call('GET', '/api/auth/me', { token: login.data.token })).status, 401);
  assert.equal((await s.call('GET', '/api/contacts')).status, 401);
});

test('tenancy: one organisation can never see another', async (t) => {
  const s = await startServer();
  t.after(() => s.app.stop());
  const a = await s.signup('a@one.dev');
  const b = await s.signup('b@two.dev');
  const contact = await s.call('POST', '/api/contacts', { token: a, body: { name: 'Secret Customer', email: 'sc@x.dev' } });
  assert.equal(contact.status, 201);
  assert.equal((await s.call('GET', `/api/contacts/${contact.data.id}`, { token: b })).status, 404);
  assert.equal((await s.call('PATCH', `/api/contacts/${contact.data.id}`, { token: b, body: { name: 'pwned' } })).status, 404);
  assert.equal((await s.call('DELETE', `/api/contacts/${contact.data.id}`, { token: b })).status, 404);
  assert.equal((await s.call('GET', '/api/contacts', { token: b })).data.total, 0);
  assert.equal((await s.call('POST', '/api/tasks', { token: b, body: { title: 'x', contact_id: contact.data.id } })).status, 400);
});

test('roles: members cannot manage automations, team or keys', async (t) => {
  const s = await startServer();
  t.after(() => s.app.stop());
  const owner = await s.signup('owner@acme.dev');
  const add = await s.call('POST', '/api/users', { token: owner, body: { name: 'Mo', email: 'mo@acme.dev', password: 'member-password', role: 'member' } });
  assert.equal(add.status, 201);
  const member = (await s.call('POST', '/api/auth/login', { body: { email: 'mo@acme.dev', password: 'member-password' } })).data.token;
  const def = { name: 'x', trigger: { type: 'manual' }, steps: [{ id: 'a', type: 'log', params: { message: 'x' } }] };
  assert.equal((await s.call('POST', '/api/workflows', { token: member, body: def })).status, 403);
  assert.equal((await s.call('POST', '/api/api-keys', { token: member, body: { name: 'k' } })).status, 403);
  assert.equal((await s.call('GET', '/api/audit', { token: member })).status, 403);
  assert.equal((await s.call('POST', '/api/contacts', { token: member, body: { name: 'ok' } })).status, 201);
  // Deactivated users are logged out immediately.
  await s.call('PATCH', `/api/users/${add.data.id}`, { token: owner, body: { active: false } });
  assert.equal((await s.call('GET', '/api/contacts', { token: member })).status, 401);
  // The owner cannot be demoted.
  const users = (await s.call('GET', '/api/users', { token: owner })).data.items;
  const ownerUser = users.find((u) => u.role === 'owner');
  assert.equal((await s.call('PATCH', `/api/users/${ownerUser.id}`, { token: owner, body: { role: 'member' } })).status, 400);
});

test('API keys authenticate and can be revoked', async (t) => {
  const s = await startServer();
  t.after(() => s.app.stop());
  const owner = await s.signup('k@acme.dev');
  const key = await s.call('POST', '/api/api-keys', { token: owner, body: { name: 'zapier', role: 'member' } });
  assert.match(key.data.key, /^bap_/);
  assert.equal((await s.call('POST', '/api/contacts', { token: key.data.key, body: { name: 'From API' } })).status, 201);
  assert.equal((await s.call('POST', '/api/workflows', { token: key.data.key, body: {} })).status, 403);
  const list = await s.call('GET', '/api/api-keys', { token: owner });
  assert.equal(list.data.items[0].key, undefined, 'key secret must never be listed');
  await s.call('DELETE', `/api/api-keys/${key.data.id}`, { token: owner });
  assert.equal((await s.call('GET', '/api/contacts', { token: key.data.key })).status, 401);
});

test('CSRF: cookie sessions reject cross-origin and non-JSON writes', async (t) => {
  const s = await startServer();
  t.after(() => s.app.stop());
  const token = await s.signup('c@acme.dev');
  const cookie = `bap_session=${token}`;
  const evil = await s.call('POST', '/api/contacts', { body: { name: 'x' }, headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const form = await s.call('POST', '/api/contacts', { raw: 'name=x', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
  const ok = await s.call('POST', '/api/contacts', { body: { name: 'x' }, headers: { cookie, origin: s.base } });
  assert.equal(ok.status, 201);
});

test('validation errors are clear and invalid JSON is rejected', async (t) => {
  const s = await startServer();
  t.after(() => s.app.stop());
  const token = await s.signup('v@acme.dev');
  const r = await s.call('POST', '/api/contacts', { token, body: { email: 'not-an-email', stage: 'bogus', value_cents: -5 } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.data.details.length, 4);
  assert.equal((await s.call('PATCH', '/api/tasks/x', { token, raw: '{bad', headers: { 'content-type': 'application/json' } })).status, 400);
  const c = await s.call('POST', '/api/contacts', { token, body: { name: 'N' } });
  assert.equal((await s.call('PATCH', `/api/contacts/${c.data.id}`, { token, body: { stage: null } })).status, 400);
});

test('invoices: totals, numbering and status transitions', async (t) => {
  const s = await startServer();
  t.after(() => s.app.stop());
  const token = await s.signup('i@acme.dev');
  const inv = await s.call('POST', '/api/invoices', { token, body: { items: [{ description: 'A', quantity: 2.5, unit_price_cents: 1999 }, { description: 'B', unit_price_cents: 100 }] } });
  assert.equal(inv.data.number, 'INV-0001');
  assert.equal(inv.data.amount_cents, Math.round(2.5 * 1999) + 100);
  assert.equal((await s.call('POST', '/api/invoices', { token, body: {} })).data.number, 'INV-0002');
  assert.equal((await s.call('POST', `/api/invoices/${inv.data.id}/status`, { token, body: { status: 'paid' } })).status, 400);
  assert.equal((await s.call('POST', `/api/invoices/${inv.data.id}/status`, { token, body: { status: 'sent' } })).data.status, 'sent');
  assert.equal((await s.call('PATCH', `/api/invoices/${inv.data.id}`, { token, body: { notes: 'x' } })).status, 400);
  assert.equal((await s.call('DELETE', `/api/invoices/${inv.data.id}`, { token })).status, 400);
  const paid = await s.call('POST', `/api/invoices/${inv.data.id}/status`, { token, body: { status: 'paid' } });
  assert.ok(paid.data.paid_at);
  assert.equal((await s.call('POST', `/api/invoices/${inv.data.id}/status`, { token, body: { status: 'void' } })).status, 400);
});

test('webhooks: secret required, idempotent, and start runs', async (t) => {
  const s = await startServer();
  t.after(() => s.app.stop());
  const token = await s.signup('w@acme.dev');
  const wf = await s.call('POST', '/api/templates/web-lead-capture/install', { token, body: { settings: {} } });
  assert.equal(wf.status, 201);
  const { id, webhook_secret: secret } = wf.data;
  assert.equal((await s.call('POST', `/hooks/${id}`, { body: { email: 'a@b.dev' } })).status, 404);
  assert.equal((await s.call('POST', `/hooks/${id}`, { body: { email: 'a@b.dev' }, headers: { 'x-webhook-secret': 'wrong' } })).status, 404);
  const headers = { 'x-webhook-secret': secret, 'idempotency-key': 'form-1' };
  const first = await s.call('POST', `/hooks/${id}`, { body: { name: 'Lead', email: 'lead@b.dev', message: 'Need a quote' }, headers });
  assert.equal(first.status, 202);
  const second = await s.call('POST', `/hooks/${id}`, { body: { name: 'Lead', email: 'lead@b.dev' }, headers });
  assert.equal(second.data.runId, first.data.runId);
  assert.equal(second.data.duplicate, true);
  // Form-encoded bodies are accepted too.
  const form = await s.call('POST', `/hooks/${id}?secret=${secret}`, { raw: 'name=Form+Person&email=form%40b.dev', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 202);
  await s.app.engine.drain();
  const run = await s.call('GET', `/api/runs/${first.data.runId}`, { token });
  assert.equal(run.data.status, 'succeeded');
  const contacts = await s.call('GET', '/api/contacts', { token });
  assert.deepEqual(contacts.data.items.map((c) => c.email).sort(), ['form@b.dev', 'lead@b.dev']);
  const tasks = await s.call('GET', '/api/tasks', { token });
  assert.equal(tasks.data.total, 2);
  // Disabled workflows refuse webhooks.
  await s.call('PATCH', `/api/workflows/${id}`, { token, body: { enabled: false } });
  assert.equal((await s.call('POST', `/hooks/${id}`, { body: {}, headers: { 'x-webhook-secret': secret } })).status, 409);
});

test('approvals over the API resume the run; dashboard aggregates', async (t) => {
  const s = await startServer();
  t.after(() => s.app.stop());
  const token = await s.signup('ap@acme.dev');
  await s.call('POST', '/api/templates/big-deal-approval/install', { token, body: { settings: { thresholdCents: '100000' } } });
  const c = await s.call('POST', '/api/contacts', { token, body: { name: 'Big Co', value_cents: 500000 } });
  await s.call('PATCH', `/api/contacts/${c.data.id}`, { token, body: { stage: 'negotiation' } });
  await s.app.engine.drain();
  const pending = await s.call('GET', '/api/approvals', { token });
  assert.equal(pending.data.items.length, 1);
  const decided = await s.call('POST', `/api/approvals/${pending.data.items[0].id}/decide`, { token, body: { approved: false, comment: 'Too steep' } });
  assert.equal(decided.data.status, 'rejected');
  await s.app.engine.drain();
  const tasks = await s.call('GET', '/api/tasks', { token });
  assert.match(tasks.data.items[0].title, /Revisit pricing for Big Co: rejected — Too steep/);
  const dash = await s.call('GET', '/api/dashboard', { token });
  assert.equal(dash.status, 200);
  assert.equal(dash.data.automation.pendingApprovals, 0);
  assert.equal(dash.data.automation.runs24h.succeeded, 1);
});

test('custom events are restricted to the custom.* namespace', async (t) => {
  const s = await startServer();
  t.after(() => s.app.stop());
  const token = await s.signup('e@acme.dev');
  assert.equal((await s.call('POST', '/api/events', { token, body: { type: 'invoice.paid', data: {} } })).status, 400);
  assert.equal((await s.call('POST', '/api/events', { token, body: { type: 'custom.signed_contract', data: { x: 1 } } })).status, 202);
});

test('login is rate limited', async (t) => {
  const s = await startServer();
  t.after(() => s.app.stop());
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    statuses.push((await s.call('POST', '/api/auth/login', { body: { email: 'x@y.dev', password: 'whatever-pass' } })).status);
  }
  assert.ok(statuses.includes(429));
});

test('static app and security headers are served', async (t) => {
  const s = await startServer();
  t.after(() => s.app.stop());
  const res = await fetch(`${s.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const traversal = await fetch(`${s.base}/%2e%2e/package.json`);
  assert.notEqual((await traversal.text()).includes('"business-auto-pilot"'), true);
  assert.equal((await fetch(`${s.base}/healthz`)).status, 200);
});
