'use strict';

const { createApp } = require('../src/app');
const auth = require('../src/services/auth');
const workflows = require('../src/services/workflows');

const silent = { log() {}, warn() {}, error() {} };

// An app on an in-memory database with a controllable clock. The engine is started but no HTTP server.
async function makeApp(overrides = {}) {
  const clock = { now: Date.now() };
  const app = createApp({ dbPath: ':memory:', workerPollMs: 20, ...overrides }, { logger: silent, now: () => clock.now });
  app.clock = clock;
  const { orgId, userId } = await auth.signup(app, { orgName: 'Test Co', name: 'Owner', email: `owner${Math.random()}@test.dev`, password: 'correct-horse-battery' });
  app.orgId = orgId;
  app.userId = userId;
  app.engine.start();
  app.createWorkflow = (def) => workflows.create(app, orgId, { name: 'wf', enabled: true, trigger: { type: 'manual' }, ...def }, 'test');
  app.runWorkflow = async (wf, data = {}) => {
    const row = workflows.getRow(app, orgId, wf.id);
    const { id } = app.engine.enqueue(row, { triggerType: 'manual', data });
    await app.engine.drain();
    return app.getRun(id);
  };
  app.getRun = (id) => {
    const run = app.db.get('SELECT * FROM runs WHERE id = ?', id);
    return { ...run, context: JSON.parse(run.context), logs: app.db.all('SELECT * FROM run_logs WHERE run_id = ? ORDER BY id', id) };
  };
  app.close = async () => {
    await app.engine.stop();
    app.db.close();
  };
  return app;
}

module.exports = { makeApp, silent };
