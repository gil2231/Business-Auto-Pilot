'use strict';

const crypto = require('node:crypto');
const { Router, HttpError, created } = require('./http/server');
const auth = require('./services/auth');
const records = require('./services/records');
const workflows = require('./services/workflows');
const audit = require('./services/audit');
const templates = require('./templates');
const { catalog } = require('./engine/actions');
const { validateDefinition } = require('./engine/definition');
const { FUNCTIONS, evalExpr } = require('./engine/expr');
const { EVENT_TYPES } = require('./events');
const { parseJson } = require('./db');
const { check } = require('./validate');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function buildRouter(app) {
  const r = new Router();
  const { db, engine } = app;
  const actorOf = (ctx) => ctx.principal.name;
  const opts = (ctx) => ({ actor: actorOf(ctx) });
  const sessionMaxAge = app.config.sessionTtlHours * 3600;

  // ---------------- health ----------------
  r.add('GET', '/healthz', { auth: 'none' }, () => {
    db.get('SELECT 1 AS ok');
    return { status: 'ok', activeRuns: engine.active.size };
  });

  // ---------------- auth ----------------
  const me = (principal) => {
    const user = db.get('SELECT * FROM users WHERE id = ?', principal.userId);
    const org = db.get('SELECT id, name, created_at FROM orgs WHERE id = ?', principal.orgId);
    return { user: auth.publicUser(user), org };
  };

  r.add('POST', '/api/auth/signup', { auth: 'none', rate: 'auth' }, async (ctx) => {
    const { userId, orgId, token } = await auth.signup(app, ctx.body);
    ctx.setSession(token, sessionMaxAge);
    return created({ ...me({ userId, orgId }), token });
  });

  r.add('POST', '/api/auth/login', { auth: 'none', rate: 'auth' }, async (ctx) => {
    const { userId, token } = await auth.login(app, ctx.body);
    const user = db.get('SELECT org_id FROM users WHERE id = ?', userId);
    ctx.setSession(token, sessionMaxAge);
    return { ...me({ userId, orgId: user.org_id }), token };
  });

  r.add('POST', '/api/auth/logout', { auth: 'none' }, (ctx) => {
    if (ctx.principal?.kind === 'user') auth.destroySession(app, ctx.token);
    ctx.setSession(null);
    return undefined;
  });

  r.add('GET', '/api/auth/me', (ctx) => {
    if (ctx.principal.kind !== 'user') {
      return { user: null, apiKey: { id: ctx.principal.id, role: ctx.principal.role }, org: db.get('SELECT id, name FROM orgs WHERE id = ?', ctx.principal.orgId) };
    }
    return me(ctx.principal);
  });

  r.add('POST', '/api/auth/password', { rate: 'auth' }, async (ctx) => {
    if (ctx.principal.kind !== 'user') throw new HttpError(400, 'API keys do not have passwords');
    const token = await auth.changePassword(app, ctx.principal, ctx.body);
    ctx.setSession(token, sessionMaxAge);
    return { ok: true };
  });

  r.add('PATCH', '/api/org', { auth: 'owner' }, (ctx) => {
    const data = check({ name: { type: 'string', required: true, max: 200 } }, ctx.body);
    db.run('UPDATE orgs SET name = ? WHERE id = ?', data.name, ctx.principal.orgId);
    audit.record(db, { orgId: ctx.principal.orgId, actor: actorOf(ctx), action: 'org.renamed', data });
    return db.get('SELECT id, name, created_at FROM orgs WHERE id = ?', ctx.principal.orgId);
  });

  // ---------------- dashboard ----------------
  r.add('GET', '/api/dashboard', (ctx) => {
    const org = ctx.principal.orgId;
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const monthStart = `${today.slice(0, 7)}-01`;

    const pipeline = db.all(
      'SELECT stage, COUNT(*) AS count, COALESCE(SUM(value_cents), 0) AS value_cents FROM contacts WHERE org_id = ? GROUP BY stage',
      org,
    );
    const wonThisMonth = db.get(
      "SELECT COUNT(*) AS count, COALESCE(SUM(value_cents),0) AS value_cents FROM contacts WHERE org_id = ? AND stage = 'won' AND updated_at >= ?",
      org, Date.parse(`${monthStart}T00:00:00Z`),
    );
    const invoices = db.get(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('sent','overdue') THEN amount_cents END), 0) AS outstanding_cents,
         COALESCE(SUM(CASE WHEN status = 'overdue' THEN amount_cents END), 0) AS overdue_cents,
         SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) AS overdue_count,
         COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= ? THEN amount_cents END), 0) AS paid_30d_cents
       FROM invoices WHERE org_id = ?`,
      now - 30 * 86400000, org,
    );
    const revenueByMonth = db.all(
      `SELECT strftime('%Y-%m', paid_at / 1000, 'unixepoch') AS month, SUM(amount_cents) AS cents
       FROM invoices WHERE org_id = ? AND status = 'paid' AND paid_at >= ? GROUP BY month ORDER BY month`,
      org, now - 186 * 86400000,
    );
    const tasks = db.get(
      `SELECT
         SUM(CASE WHEN status IN ('open','in_progress') THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN status IN ('open','in_progress') AND due_date < ? THEN 1 ELSE 0 END) AS overdue,
         SUM(CASE WHEN status IN ('open','in_progress') AND due_date = ? THEN 1 ELSE 0 END) AS due_today,
         SUM(CASE WHEN status = 'done' AND completed_at >= ? THEN 1 ELSE 0 END) AS done_7d
       FROM tasks WHERE org_id = ?`,
      today, today, now - 7 * 86400000, org,
    );
    const runs24h = db.all(
      'SELECT status, COUNT(*) AS n FROM runs WHERE org_id = ? AND created_at >= ? GROUP BY status',
      org, now - 86400000,
    );
    const steps30d = db.get(
      "SELECT COALESCE(SUM(step_count), 0) AS n, COUNT(*) AS runs FROM runs WHERE org_id = ? AND created_at >= ? AND status = 'succeeded'",
      org, now - 30 * 86400000,
    );
    const counts = db.get(
      `SELECT (SELECT COUNT(*) FROM workflows WHERE org_id = ? AND enabled = 1) AS active_workflows,
              (SELECT COUNT(*) FROM approvals WHERE org_id = ? AND status = 'pending') AS pending_approvals,
              (SELECT COUNT(*) FROM contacts WHERE org_id = ?) AS contacts`,
      org, org, org,
    );
    const recentRuns = db.all(
      `SELECT r.id, r.status, r.trigger_type, r.created_at, r.finished_at, r.error, w.name AS workflow_name
       FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.org_id = ? ORDER BY r.created_at DESC LIMIT 8`,
      org,
    );
    const byStatus = Object.fromEntries(runs24h.map((x) => [x.status, x.n]));
    const finished = (byStatus.succeeded || 0) + (byStatus.failed || 0);
    return {
      pipeline,
      wonThisMonth,
      invoices: { ...invoices, overdue_count: invoices.overdue_count || 0 },
      revenueByMonth,
      tasks: { open: tasks.open || 0, overdue: tasks.overdue || 0, due_today: tasks.due_today || 0, done_7d: tasks.done_7d || 0 },
      automation: {
        runs24h: byStatus,
        successRate24h: finished ? (byStatus.succeeded || 0) / finished : null,
        runs30d: steps30d.runs,
        steps30d: steps30d.n,
        // Conservative estimate: each automated step replaces ~3 minutes of manual work.
        hoursSaved30d: Math.round((steps30d.n * 3) / 6) / 10,
        activeWorkflows: counts.active_workflows,
        pendingApprovals: counts.pending_approvals,
      },
      contacts: counts.contacts,
      recentRuns,
    };
  });

  // ---------------- contacts ----------------
  r.add('GET', '/api/contacts', (ctx) => records.listContacts(app, ctx.principal.orgId, ctx.query));
  r.add('POST', '/api/contacts', (ctx) => created(records.createContact(app, ctx.principal.orgId, ctx.body, opts(ctx))));
  r.add('GET', '/api/contacts/:id', (ctx) => {
    const contact = records.getContact(app, ctx.principal.orgId, ctx.params.id);
    return {
      ...contact,
      tasks: records.listTasks(app, ctx.principal.orgId, { contact_id: contact.id, limit: 100 }).items,
      invoices: records.listInvoices(app, ctx.principal.orgId, { contact_id: contact.id, limit: 100 }).items,
    };
  });
  r.add('PATCH', '/api/contacts/:id', (ctx) => records.updateContact(app, ctx.principal.orgId, ctx.params.id, ctx.body, opts(ctx)));
  r.add('DELETE', '/api/contacts/:id', (ctx) => records.deleteContact(app, ctx.principal.orgId, ctx.params.id, opts(ctx)));

  // ---------------- tasks ----------------
  r.add('GET', '/api/tasks', (ctx) => records.listTasks(app, ctx.principal.orgId, ctx.query));
  r.add('POST', '/api/tasks', (ctx) => created(records.createTask(app, ctx.principal.orgId, ctx.body, opts(ctx))));
  r.add('GET', '/api/tasks/:id', (ctx) => records.getTask(app, ctx.principal.orgId, ctx.params.id));
  r.add('PATCH', '/api/tasks/:id', (ctx) => records.updateTask(app, ctx.principal.orgId, ctx.params.id, ctx.body, opts(ctx)));
  r.add('DELETE', '/api/tasks/:id', (ctx) => records.deleteTask(app, ctx.principal.orgId, ctx.params.id, opts(ctx)));

  // ---------------- invoices ----------------
  r.add('GET', '/api/invoices', (ctx) => records.listInvoices(app, ctx.principal.orgId, ctx.query));
  r.add('POST', '/api/invoices', (ctx) => created(records.createInvoice(app, ctx.principal.orgId, ctx.body, opts(ctx))));
  r.add('GET', '/api/invoices/:id', (ctx) => records.getInvoice(app, ctx.principal.orgId, ctx.params.id));
  r.add('PATCH', '/api/invoices/:id', (ctx) => records.updateInvoice(app, ctx.principal.orgId, ctx.params.id, ctx.body, opts(ctx)));
  r.add('DELETE', '/api/invoices/:id', (ctx) => records.deleteInvoice(app, ctx.principal.orgId, ctx.params.id, opts(ctx)));
  r.add('POST', '/api/invoices/:id/status', (ctx) => {
    const { status } = check({ status: { type: 'string', required: true, enum: records.INVOICE_STATUSES } }, ctx.body);
    return records.setInvoiceStatus(app, ctx.principal.orgId, ctx.params.id, status, opts(ctx));
  });

  // ---------------- workflows ----------------
  r.add('GET', '/api/catalog', () => ({ actions: catalog(), events: EVENT_TYPES, functions: FUNCTIONS }));
  r.add('GET', '/api/workflows', (ctx) => ({ items: workflows.list(app, ctx.principal.orgId) }));
  r.add('POST', '/api/workflows', { auth: 'admin' }, (ctx) => created(workflows.create(app, ctx.principal.orgId, ctx.body, actorOf(ctx))));
  r.add('POST', '/api/workflows/validate', { auth: 'admin' }, (ctx) => {
    try {
      validateDefinition(ctx.body || {});
      return { valid: true, errors: [] };
    } catch (err) {
      if (!err.errors) throw err;
      return { valid: false, errors: err.errors };
    }
  });
  r.add('GET', '/api/workflows/:id', (ctx) => workflows.get(app, ctx.principal.orgId, ctx.params.id));
  r.add('PUT', '/api/workflows/:id', { auth: 'admin' }, (ctx) => workflows.update(app, ctx.principal.orgId, ctx.params.id, ctx.body, actorOf(ctx)));
  r.add('PATCH', '/api/workflows/:id', { auth: 'admin' }, (ctx) => workflows.update(app, ctx.principal.orgId, ctx.params.id, ctx.body, actorOf(ctx)));
  r.add('DELETE', '/api/workflows/:id', { auth: 'admin' }, (ctx) => workflows.remove(app, ctx.principal.orgId, ctx.params.id, actorOf(ctx)));
  r.add('POST', '/api/workflows/:id/duplicate', { auth: 'admin' }, (ctx) => created(workflows.duplicate(app, ctx.principal.orgId, ctx.params.id, actorOf(ctx))));
  r.add('POST', '/api/workflows/:id/rotate-secret', { auth: 'admin' }, (ctx) => workflows.rotateSecret(app, ctx.principal.orgId, ctx.params.id, actorOf(ctx)));
  r.add('POST', '/api/workflows/:id/run', (ctx) => {
    const wf = workflows.getRow(app, ctx.principal.orgId, ctx.params.id);
    const data = ctx.body?.data && typeof ctx.body.data === 'object' ? ctx.body.data : {};
    const key = ctx.req.headers['idempotency-key'] ? String(ctx.req.headers['idempotency-key']).slice(0, 200) : null;
    const result = engine.enqueue(wf, { triggerType: 'manual', data, event: { type: 'manual', by: actorOf(ctx) }, idempotencyKey: key });
    audit.record(db, { orgId: ctx.principal.orgId, actor: actorOf(ctx), action: 'workflow.run', entity: 'workflow', entityId: wf.id, data: { runId: result.id } });
    return { __status: 202, body: result };
  });
  r.add('GET', '/api/workflows/:id/runs', (ctx) => {
    workflows.getRow(app, ctx.principal.orgId, ctx.params.id);
    return listRuns(ctx.principal.orgId, { ...ctx.query, workflow_id: ctx.params.id });
  });

  // ---------------- templates ----------------
  r.add('GET', '/api/templates', () => ({ items: templates.list() }));
  r.add('POST', '/api/templates/:id/install', { auth: 'admin' }, (ctx) => {
    const def = templates.instantiate(ctx.params.id, ctx.body?.settings || {});
    if (!def) throw new HttpError(404, 'Template not found');
    return created(workflows.create(app, ctx.principal.orgId, { ...def, enabled: ctx.body?.enabled !== false }, actorOf(ctx)));
  });

  // ---------------- runs ----------------
  function listRuns(orgId, { status, workflow_id: workflowId, limit, offset }) {
    const where = ['r.org_id = ?'];
    const params = [orgId];
    if (status) {
      where.push('r.status = ?');
      params.push(status);
    }
    if (workflowId) {
      where.push('r.workflow_id = ?');
      params.push(workflowId);
    }
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM runs r WHERE ${w}`, ...params).n;
    const items = db.all(
      `SELECT r.id, r.workflow_id, r.workflow_version, r.status, r.trigger_type, r.current_step, r.step_count, r.attempt,
              r.next_run_at, r.error, r.created_at, r.started_at, r.finished_at, w.name AS workflow_name
       FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE ${w} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
      ...params, records.clampLimit(limit), Math.max(0, Number.parseInt(offset, 10) || 0),
    );
    return { items, total };
  }

  r.add('GET', '/api/runs', (ctx) => listRuns(ctx.principal.orgId, ctx.query));
  r.add('GET', '/api/runs/:id', (ctx) => {
    const run = db.get(
      'SELECT r.*, w.name AS workflow_name FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ? AND r.org_id = ?',
      ctx.params.id, ctx.principal.orgId,
    );
    if (!run) throw new HttpError(404, 'Run not found');
    const logs = db.all('SELECT id, step_id, level, message, data, created_at FROM run_logs WHERE run_id = ? ORDER BY id LIMIT 2000', run.id)
      .map((l) => ({ ...l, data: parseJson(l.data, l.data) }));
    const { definition, trigger_data: triggerData, context, ...rest } = run;
    const ctxObj = parseJson(context, {});
    return {
      ...rest,
      definition: parseJson(definition, {}),
      trigger_data: parseJson(triggerData, {}),
      outputs: ctxObj.steps || {},
      vars: ctxObj.vars || {},
      logs,
      approvals: db.all('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at', run.id),
    };
  });
  r.add('POST', '/api/runs/:id/cancel', (ctx) => {
    if (!engine.cancel(ctx.principal.orgId, ctx.params.id, actorOf(ctx))) throw new HttpError(409, 'Run is not active');
    return { ok: true };
  });
  r.add('POST', '/api/runs/:id/retry', { auth: 'admin' }, (ctx) => {
    const res = engine.retry(ctx.principal.orgId, ctx.params.id, actorOf(ctx));
    if (!res) throw new HttpError(404, 'Run not found');
    return { __status: 202, body: res };
  });

  // ---------------- approvals ----------------
  r.add('GET', '/api/approvals', (ctx) => {
    const status = ctx.query.status || 'pending';
    const items = db.all(
      `SELECT a.*, w.name AS workflow_name FROM approvals a JOIN runs r ON r.id = a.run_id JOIN workflows w ON w.id = r.workflow_id
       WHERE a.org_id = ? AND (? = 'all' OR a.status = ?) ORDER BY a.created_at DESC LIMIT 200`,
      ctx.principal.orgId, status, status,
    );
    return { items };
  });
  r.add('POST', '/api/approvals/:id/decide', (ctx) => {
    const data = check({ approved: { type: 'boolean', required: true }, comment: { type: 'string', max: 2000, emptyAsNull: true } }, ctx.body);
    const res = engine.decideApproval(ctx.principal.orgId, ctx.params.id, { approved: data.approved, comment: data.comment, decidedBy: actorOf(ctx) });
    if (res.error === 'not_found') throw new HttpError(404, 'Approval not found');
    if (res.error === 'already_decided') throw new HttpError(409, `This request was already ${res.approval.status}`);
    return res.approval;
  });

  // ---------------- outbox / events ----------------
  r.add('GET', '/api/outbox', (ctx) => ({
    items: db.all('SELECT * FROM outbox WHERE org_id = ? ORDER BY created_at DESC LIMIT ?', ctx.principal.orgId, records.clampLimit(ctx.query.limit, 100)),
  }));

  r.add('POST', '/api/events', (ctx) => {
    const data = check({ type: { type: 'string', required: true, max: 100, pattern: /^custom(\.[a-z0-9_]+)+$/i }, data: { type: 'object', default: () => ({}) } }, ctx.body);
    app.events.emit(ctx.principal.orgId, data.type, data.data);
    return { __status: 202, body: { accepted: true, type: data.type } };
  });

  // ---------------- team & API keys ----------------
  r.add('GET', '/api/users', { auth: 'admin' }, (ctx) => ({
    items: db.all('SELECT * FROM users WHERE org_id = ? ORDER BY created_at', ctx.principal.orgId).map(auth.publicUser),
  }));
  r.add('POST', '/api/users', { auth: 'admin' }, async (ctx) => created(await auth.createUser(app, ctx.principal.orgId, ctx.body, actorOf(ctx))));
  r.add('PATCH', '/api/users/:id', { auth: 'admin' }, (ctx) => auth.updateUser(app, ctx.principal.orgId, ctx.params.id, ctx.body, ctx.principal));

  r.add('GET', '/api/api-keys', { auth: 'admin' }, (ctx) => ({
    items: db.all('SELECT id, name, prefix, role, last_used_at, created_at FROM api_keys WHERE org_id = ? ORDER BY created_at DESC', ctx.principal.orgId),
  }));
  r.add('POST', '/api/api-keys', { auth: 'admin' }, (ctx) => created(auth.createApiKey(app, ctx.principal.orgId, ctx.body, ctx.principal)));
  r.add('DELETE', '/api/api-keys/:id', { auth: 'admin' }, (ctx) => {
    const res = db.run('DELETE FROM api_keys WHERE id = ? AND org_id = ?', ctx.params.id, ctx.principal.orgId);
    if (res.changes !== 1) throw new HttpError(404, 'API key not found');
    audit.record(db, { orgId: ctx.principal.orgId, actor: actorOf(ctx), action: 'api_key.revoked', entity: 'api_key', entityId: ctx.params.id });
    return undefined;
  });

  r.add('GET', '/api/audit', { auth: 'admin' }, (ctx) => ({
    items: db.all('SELECT * FROM audit_log WHERE org_id = ? ORDER BY id DESC LIMIT ?', ctx.principal.orgId, records.clampLimit(ctx.query.limit, 100))
      .map((a) => ({ ...a, data: parseJson(a.data, null) })),
  }));

  // ---------------- inbound webhooks ----------------
  r.add('POST', '/hooks/:id', { auth: 'none', rate: 'webhook', raw: true }, (ctx) => {
    const wf = db.get('SELECT * FROM workflows WHERE id = ?', ctx.params.id);
    const secret = ctx.req.headers['x-webhook-secret'] || ctx.query.secret || '';
    // Same response for unknown workflow and bad secret so IDs cannot be probed.
    if (!wf || !safeEqual(secret, wf.webhook_secret)) throw new HttpError(404, 'Not found');
    const trigger = parseJson(wf.trigger, {});
    if (trigger.type !== 'webhook') throw new HttpError(409, 'This workflow is not webhook-triggered');
    if (!wf.enabled) throw new HttpError(409, 'This workflow is disabled');
    const key = ctx.req.headers['idempotency-key'] ? String(ctx.req.headers['idempotency-key']).slice(0, 200) : null;
    const { secret: _omit, ...query } = ctx.query;
    const data = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : { items: ctx.body };
    if (trigger.filter) {
      let pass = false;
      try {
        pass = Boolean(evalExpr(trigger.filter, { trigger: data, event: { type: 'webhook', query } }));
      } catch {
        pass = false;
      }
      if (!pass) return { __status: 202, body: { runId: null, skipped: true } };
    }
    const result = engine.enqueue(wf, {
      triggerType: 'webhook',
      data,
      event: { type: 'webhook', at: new Date().toISOString(), query },
      idempotencyKey: key,
    });
    return { __status: 202, body: { runId: result.id, duplicate: result.duplicate } };
  });

  return r;
}

module.exports = { buildRouter };
