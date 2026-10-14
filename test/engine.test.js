'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeApp } = require('./helpers');
const records = require('../src/services/records');
const workflows = require('../src/services/workflows');

test('steps run in order and outputs flow into later steps', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const wf = app.createWorkflow({
    steps: [
      { id: 'vars', type: 'set_variables', params: { values: { greeting: 'Hello {{ trigger.name }}', n: '{{ trigger.n * 2 }}' } } },
      { id: 'shape', type: 'transform', params: { value: { msg: '{{ vars.greeting }}!', doubled: '{{ vars.n }}' } } },
      { id: 'task', type: 'create_task', params: { title: '{{ steps.shape.msg }}', dueInDays: 2 } },
    ],
  });
  const run = await app.runWorkflow(wf, { name: 'Ada', n: 21 });
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.context.steps.shape, { msg: 'Hello Ada!', doubled: 42 });
  const task = records.getTask(app, app.orgId, run.context.steps.task.id);
  assert.equal(task.title, 'Hello Ada!');
  assert.equal(task.source, 'workflow:wf');
  assert.equal(run.step_count, 3);
});

test('conditions branch, "when" skips and "end" stops', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const wf = app.createWorkflow({
    steps: [
      { id: 'check', type: 'condition', if: 'trigger.amount >= 100', then: 'big', else: 'small' },
      { id: 'big', type: 'transform', params: { value: 'big' }, next: 'end' },
      { id: 'small', type: 'transform', params: { value: 'small' } },
      { id: 'maybe', type: 'transform', when: 'trigger.amount > 5', params: { value: 'ran' } },
    ],
  });
  const big = await app.runWorkflow(wf, { amount: 500 });
  assert.deepEqual(Object.keys(big.context.steps), ['check', 'big']);
  const small = await app.runWorkflow(wf, { amount: 1 });
  assert.equal(small.context.steps.small, 'small');
  assert.deepEqual(small.context.steps.maybe, { skipped: true });
  assert.equal(small.context.steps.big, undefined);
});

test('failing steps respect onError continue / goto / fail', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const wf = app.createWorkflow({
    steps: [
      { id: 'bad1', type: 'update_task', params: { id: 'missing' }, onError: 'continue' },
      { id: 'bad2', type: 'update_task', params: { id: 'missing' }, onError: 'recover' },
      { id: 'skipped', type: 'transform', params: { value: 1 } },
      { id: 'recover', type: 'transform', params: { value: '{{ steps.bad2.error }}' } },
      { id: 'fatal', type: 'get_invoice', params: { id: 'nope' } },
    ],
  });
  const run = await app.runWorkflow(wf);
  assert.equal(run.status, 'failed');
  assert.match(run.context.steps.bad1.error, /Task not found/);
  assert.equal(run.context.steps.skipped, undefined);
  assert.match(run.context.steps.recover, /Task not found/);
  assert.match(run.error, /fatal.*Invoice not found/);
  // A failure publishes workflow.failed for alerting workflows.
  const alert = app.createWorkflow({ name: 'alert', trigger: { type: 'event', event: 'workflow.failed' }, steps: [{ id: 'x', type: 'log', params: { message: '{{ trigger.error }}' } }] });
  await app.runWorkflow(wf);
  const alertRuns = app.db.all('SELECT status FROM runs WHERE workflow_id = ?', alert.id);
  assert.deepEqual(alertRuns.map((r) => r.status), ['succeeded']);
});

test('transient HTTP failures are retried with backoff, then succeed', async (t) => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    res.writeHead(calls < 3 ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ calls }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const app = await makeApp({ allowPrivateNetworkRequests: true });
  t.after(async () => {
    server.close();
    await app.close();
  });
  const wf = app.createWorkflow({
    steps: [{ id: 'call', type: 'http_request', params: { url: `http://127.0.0.1:${server.address().port}/x` }, retry: { max: 3, backoffMs: 1000 } }],
  });
  const row = workflows.getRow(app, app.orgId, wf.id);
  const { id } = app.engine.enqueue(row, { triggerType: 'manual' });
  await app.engine.drain();
  assert.equal(app.getRun(id).status, 'queued'); // parked for retry
  for (let i = 0; i < 3; i++) {
    app.clock.now += 10000;
    await app.engine.drain();
  }
  const run = app.getRun(id);
  assert.equal(run.status, 'succeeded');
  assert.equal(calls, 3);
  assert.deepEqual(run.context.steps.call.body, { calls: 3 });
  assert.equal(run.logs.filter((l) => l.level === 'warn').length, 2);
});

test('SSRF protection blocks private addresses by default without retrying', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const wf = app.createWorkflow({ steps: [{ id: 'call', type: 'http_request', params: { url: 'http://169.254.169.254/latest/meta-data' }, retry: { max: 5, backoffMs: 100 } }] });
  const run = await app.runWorkflow(wf);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /private or internal/);
  assert.equal(run.attempt, 0);
});

test('delays park the run and resume when due', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const wf = app.createWorkflow({ steps: [{ id: 'wait', type: 'delay', params: { hours: 2 } }, { id: 'after', type: 'transform', params: { value: 'done' } }] });
  const run1 = await app.runWorkflow(wf);
  assert.equal(run1.status, 'waiting');
  app.clock.now += 3600000;
  await app.engine.drain();
  assert.equal(app.getRun(run1.id).status, 'waiting');
  app.clock.now += 3600000 + 1;
  await app.engine.drain();
  const run = app.getRun(run1.id);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.context.steps.after, 'done');
});

test('approvals pause until decided, then branch on the decision', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const wf = app.createWorkflow({
    steps: [
      { id: 'ask', type: 'approval', params: { title: 'Approve {{ trigger.what }}?', timeoutHours: 1 } },
      { id: 'branch', type: 'condition', if: 'steps.ask.approved', then: 'yes', else: 'no' },
      { id: 'yes', type: 'transform', params: { value: 'approved by {{ steps.ask.decidedBy }}' }, next: 'end' },
      { id: 'no', type: 'transform', params: { value: '{{ steps.ask.status }}' } },
    ],
  });
  const r1 = await app.runWorkflow(wf, { what: 'discount' });
  assert.equal(r1.status, 'waiting');
  const approval = app.db.get('SELECT * FROM approvals WHERE run_id = ?', r1.id);
  assert.equal(approval.title, 'Approve discount?');
  const res = app.engine.decideApproval(app.orgId, approval.id, { approved: true, decidedBy: 'boss@test.dev' });
  assert.equal(res.approval.status, 'approved');
  assert.equal(app.engine.decideApproval(app.orgId, approval.id, { approved: false, decidedBy: 'x' }).error, 'already_decided');
  await app.engine.drain();
  assert.equal(app.getRun(r1.id).context.steps.yes, 'approved by boss@test.dev');

  // Unanswered approvals expire after the timeout and take the "no" branch.
  const r2 = await app.runWorkflow(wf, { what: 'x' });
  app.clock.now += 3600000 + 1;
  await app.engine.drain();
  const done = app.getRun(r2.id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.context.steps.no, 'expired');
});

test('event triggers honour filters and loop protection', async (t) => {
  const app = await makeApp({ maxEventDepth: 3 });
  t.after(() => app.close());
  const wf = app.createWorkflow({
    trigger: { type: 'event', event: 'contact.*', filter: "trigger.stage == 'lead'" },
    steps: [{ id: 'x', type: 'log', params: { message: 'hi' } }],
  });
  records.createContact(app, app.orgId, { name: 'A', stage: 'lead' });
  records.createContact(app, app.orgId, { name: 'B', stage: 'won' });
  await app.engine.drain();
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM runs WHERE workflow_id = ?', wf.id).n, 1);

  // A workflow that creates the very thing that triggers it must not loop forever.
  const loop = app.createWorkflow({
    name: 'loop',
    trigger: { type: 'event', event: 'task.created' },
    steps: [{ id: 't', type: 'create_task', params: { title: 'again' } }],
  });
  records.createTask(app, app.orgId, { title: 'seed' });
  await app.engine.drain();
  const loopRuns = app.db.get('SELECT COUNT(*) AS n FROM runs WHERE workflow_id = ?', loop.id).n;
  assert.ok(loopRuns >= 1 && loopRuns <= 4, `expected bounded runs, got ${loopRuns}`);
});

test('runaway goto loops are stopped by the step limit', async (t) => {
  const app = await makeApp({ maxStepsPerRun: 25 });
  t.after(() => app.close());
  const wf = app.createWorkflow({ steps: [{ id: 'a', type: 'log', params: { message: 'tick' } }, { id: 'b', type: 'goto', next: 'a' }] });
  const run = await app.runWorkflow(wf);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /possible infinite loop/);
});

test('idempotency keys deduplicate runs; cancel stops waiting runs', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const wf = app.createWorkflow({ steps: [{ id: 'w', type: 'delay', params: { days: 1 } }] });
  const row = workflows.getRow(app, app.orgId, wf.id);
  const a = app.engine.enqueue(row, { triggerType: 'webhook', idempotencyKey: 'k1' });
  const b = app.engine.enqueue(row, { triggerType: 'webhook', idempotencyKey: 'k1' });
  assert.equal(a.id, b.id);
  assert.equal(b.duplicate, true);
  await app.engine.drain();
  assert.equal(app.engine.cancel(app.orgId, a.id, 'tester'), true);
  assert.equal(app.engine.cancel(app.orgId, a.id, 'tester'), false);
  app.clock.now += 2 * 86400000;
  await app.engine.drain();
  assert.equal(app.getRun(a.id).status, 'cancelled');
});

test('runs interrupted by a crash resume after restart', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const wf = app.createWorkflow({ steps: [{ id: 'a', type: 'transform', params: { value: 1 } }] });
  const row = workflows.getRow(app, app.orgId, wf.id);
  await app.engine.stop();
  const { id } = app.engine.enqueue(row, { triggerType: 'manual' });
  app.db.run("UPDATE runs SET status = 'running' WHERE id = ?", id); // simulate a crash mid-run
  app.engine.start();
  await app.engine.drain();
  const run = app.getRun(id);
  assert.equal(run.status, 'succeeded');
  assert.ok(run.logs.some((l) => /interrupted by a restart/.test(l.message)));
});

test('schedules fire once per due slot and catch up only once', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  app.clock.now = Date.parse('2026-05-04T08:59:30Z');
  const wf = app.createWorkflow({ trigger: { type: 'schedule', cron: '0 9 * * *', timezone: 'UTC' }, steps: [{ id: 'a', type: 'log', params: { message: 'go' } }] });
  app.db.run('UPDATE workflows SET last_scheduled_at = ?, updated_at = ? WHERE id = ?', app.clock.now, app.clock.now, wf.id);
  const count = () => app.db.get('SELECT COUNT(*) AS n FROM runs WHERE workflow_id = ?', wf.id).n;
  app.engine.checkSchedules();
  assert.equal(count(), 0);
  app.clock.now = Date.parse('2026-05-04T09:00:05Z');
  app.engine.checkSchedules();
  app.engine.checkSchedules();
  assert.equal(count(), 1);
  // Server "down" for three days: one catch-up run, not three.
  app.clock.now = Date.parse('2026-05-07T12:00:00Z');
  app.engine.checkSchedules();
  app.engine.checkSchedules();
  assert.equal(count(), 2);
  await app.engine.drain();
});

test('overdue sweeps emit events exactly once', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const sweeps = require('../src/services/sweeps');
  const seen = [];
  app.events.subscribe((e) => seen.push(e.type));
  const c = records.createContact(app, app.orgId, { name: 'Payer', email: 'p@x.dev' });
  const inv = records.createInvoice(app, app.orgId, { contact_id: c.id, items: [{ description: 'Work', unit_price_cents: 1000 }], due_date: '2020-01-01' });
  records.setInvoiceStatus(app, app.orgId, inv.id, 'sent');
  records.createTask(app, app.orgId, { title: 'late', due_date: '2020-01-01' });
  sweeps.runAll(app);
  sweeps.runAll(app);
  assert.equal(seen.filter((x) => x === 'invoice.overdue').length, 1);
  assert.equal(seen.filter((x) => x === 'task.overdue').length, 1);
  assert.equal(records.getInvoice(app, app.orgId, inv.id).status, 'overdue');
});

test('workflow definitions are validated thoroughly', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const bad = (def) => {
    try {
      app.createWorkflow(def);
    } catch (err) {
      return err.message;
    }
    return null;
  };
  assert.match(bad({ steps: [] }), /at least one step/);
  assert.match(bad({ steps: [{ id: 'a', type: 'nope' }] }), /not a known step type/);
  assert.match(bad({ steps: [{ id: 'a', type: 'log', params: { message: 'x' } }, { id: 'a', type: 'log', params: { message: 'y' } }] }), /Duplicate step id/);
  assert.match(bad({ steps: [{ id: 'a', type: 'condition', if: 'x', then: 'zzz' }] }), /unknown step "zzz"/);
  assert.match(bad({ steps: [{ id: 'a', type: 'send_email', params: { to: 'x' } }] }), /subject is required/);
  assert.match(bad({ steps: [{ id: 'a', type: 'log', params: { message: '{{ 1 + }}' } }] }), /Unexpected end/);
  assert.match(bad({ trigger: { type: 'schedule', cron: '* *' }, steps: [{ id: 'a', type: 'log', params: { message: 'x' } }] }), /5 fields/);
  assert.match(bad({ trigger: { type: 'schedule', cron: '* * * * *', timezone: 'Mars/Base' }, steps: [{ id: 'a', type: 'log', params: { message: 'x' } }] }), /time zone/);
  assert.match(bad({ steps: [{ id: 'end', type: 'log', params: { message: 'x' } }] }), /must start with a letter/);
});

test('every bundled template installs and validates', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const templates = require('../src/templates');
  for (const tpl of templates.list()) {
    const def = templates.instantiate(tpl.id, {});
    const wf = app.createWorkflow(def);
    assert.equal(wf.name, def.name);
  }
  // Settings values cannot break out of JSON strings.
  const evil = templates.instantiate('speed-to-lead', { companyName: 'Acme", "x": "y' });
  assert.match(evil.steps[1].params.body, /Acme", "x": "y/);
});
