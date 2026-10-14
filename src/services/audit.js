'use strict';

function record(db, { orgId, actor, action, entity = null, entityId = null, data = null }) {
  db.run(
    'INSERT INTO audit_log (org_id, actor, action, entity, entity_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    orgId,
    actor || 'system',
    action,
    entity,
    entityId,
    data === null ? null : JSON.stringify(data),
    Date.now(),
  );
}

module.exports = { record };
