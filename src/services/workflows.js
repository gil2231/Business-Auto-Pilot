'use strict';

const crypto = require('node:crypto');
const { newId, parseJson } = require('../db');
const { check } = require('../validate');
const { validateDefinition } = require('../engine/definition');
const { NotFoundError } = require('./records');
const audit = require('./audit');

const metaSchema = {
  name: { type: 'string', required: true, max: 200 },
  description: { type: 'string', max: 2000, emptyAsNull: true },
  enabled: { type: 'boolean', default: false },
  trigger: { type: 'object', required: true },
  steps: { type: 'array', required: true, max: 100 },
};

function serialize(row, engine) {
  if (!row) return row;
  const wf = {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: Boolean(row.enabled),
    trigger: parseJson(row.trigger, {}),
    steps: parseJson(row.steps, []),
    version: row.version,
    webhook_secret: row.webhook_secret,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (engine) wf.next_run_at = engine.nextScheduledRun(row);
  return wf;
}

function getRow(app, orgId, id) {
  const row = app.db.get('SELECT * FROM workflows WHERE id = ? AND org_id = ?', id, orgId);
  if (!row) throw new NotFoundError('Workflow');
  return row;
}

function get(app, orgId, id) {
  return serialize(getRow(app, orgId, id), app.engine);
}

function list(app, orgId) {
  const rows = app.db.all('SELECT * FROM workflows WHERE org_id = ? ORDER BY name COLLATE NOCASE', orgId);
  const since = Date.now() - 7 * 86400000;
  const stats = app.db.all(
    `SELECT workflow_id,
            SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status IN ('queued','running','waiting') THEN 1 ELSE 0 END) AS active,
            MAX(created_at) AS last_run_at
     FROM runs WHERE org_id = ? AND created_at >= ? GROUP BY workflow_id`,
    orgId, since,
  );
  const byId = new Map(stats.map((s) => [s.workflow_id, s]));
  return rows.map((r) => {
    const s = byId.get(r.id) || {};
    return {
      ...serialize(r, app.engine),
      stats7d: { succeeded: s.succeeded || 0, failed: s.failed || 0, active: s.active || 0, lastRunAt: s.last_run_at || null },
    };
  });
}

function create(app, orgId, input, actor) {
  const meta = check(metaSchema, input);
  const def = validateDefinition(meta);
  const now = Date.now();
  const id = newId('wf');
  app.db.run(
    `INSERT INTO workflows (id, org_id, name, description, enabled, trigger, steps, webhook_secret, version, last_scheduled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    id, orgId, meta.name, meta.description, meta.enabled ? 1 : 0, JSON.stringify(def.trigger), JSON.stringify(def.steps),
    crypto.randomBytes(24).toString('base64url'), now, now, now,
  );
  audit.record(app.db, { orgId, actor, action: 'workflow.created', entity: 'workflow', entityId: id, data: { name: meta.name } });
  return get(app, orgId, id);
}

function update(app, orgId, id, input, actor) {
  return app.db.transaction(() => {
    const row = getRow(app, orgId, id);
    const current = serialize(row);
    const changes = check(metaSchema, input, { partial: true });
    const merged = { ...current, ...changes };
    const def = validateDefinition(merged);
    const definitionChanged = JSON.stringify(def.trigger) !== row.trigger || JSON.stringify(def.steps) !== row.steps;
    const now = Date.now();
    const enabling = merged.enabled && !current.enabled;
    app.db.run(
      `UPDATE workflows SET name = ?, description = ?, enabled = ?, trigger = ?, steps = ?, version = version + ?,
         last_scheduled_at = CASE WHEN ? THEN ? ELSE last_scheduled_at END, updated_at = ?
       WHERE id = ? AND org_id = ?`,
      merged.name, merged.description ?? null, merged.enabled ? 1 : 0, JSON.stringify(def.trigger), JSON.stringify(def.steps),
      definitionChanged ? 1 : 0, enabling || definitionChanged ? 1 : 0, now, now, id, orgId,
    );
    audit.record(app.db, {
      orgId, actor, action: 'workflow.updated', entity: 'workflow', entityId: id,
      data: { fields: Object.keys(changes), definitionChanged },
    });
    return get(app, orgId, id);
  });
}

function remove(app, orgId, id, actor) {
  return app.db.transaction(() => {
    const row = getRow(app, orgId, id);
    app.db.run('DELETE FROM workflows WHERE id = ? AND org_id = ?', id, orgId);
    audit.record(app.db, { orgId, actor, action: 'workflow.deleted', entity: 'workflow', entityId: id, data: { name: row.name } });
  });
}

function rotateSecret(app, orgId, id, actor) {
  getRow(app, orgId, id);
  app.db.run('UPDATE workflows SET webhook_secret = ?, updated_at = ? WHERE id = ?', crypto.randomBytes(24).toString('base64url'), Date.now(), id);
  audit.record(app.db, { orgId, actor, action: 'workflow.secret_rotated', entity: 'workflow', entityId: id });
  return get(app, orgId, id);
}

function duplicate(app, orgId, id, actor) {
  const wf = get(app, orgId, id);
  return create(app, orgId, { name: `${wf.name} (copy)`.slice(0, 200), description: wf.description, enabled: false, trigger: wf.trigger, steps: wf.steps }, actor);
}

module.exports = { get, getRow, list, create, update, remove, rotateSecret, duplicate, serialize };
