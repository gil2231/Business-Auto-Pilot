'use strict';

// Business records (contacts, tasks, invoices). Shared by the REST API and workflow actions so that every
// change is validated, audited and published as an event no matter where it comes from.

const { newId, parseJson } = require('../db');
const { check, ValidationError } = require('../validate');
const audit = require('./audit');

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const INVOICE_STATUSES = ['draft', 'sent', 'overdue', 'paid', 'void'];

class NotFoundError extends Error {
  constructor(what) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

function clampLimit(limit, fallback = 50, max = 500) {
  const n = Number.parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function likeEscape(s) {
  return `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ---------------- contacts ----------------

const contactSchema = {
  name: { type: 'string', required: true, max: 200 },
  email: { type: 'string', format: 'email', max: 254, emptyAsNull: true },
  phone: { type: 'string', max: 50, emptyAsNull: true },
  company: { type: 'string', max: 200, emptyAsNull: true },
  stage: { type: 'string', enum: STAGES, default: 'lead' },
  value_cents: { type: 'integer', min: 0, max: 1e13, default: 0 },
  owner: { type: 'string', max: 200, emptyAsNull: true },
  tags: { type: 'array', max: 50, items: { type: 'string', max: 50 }, default: () => [] },
  notes: { type: 'string', max: 20000, emptyAsNull: true, trim: false },
};

function serializeContact(row) {
  return row && { ...row, tags: parseJson(row.tags, []) };
}

function getContact(app, orgId, id) {
  const row = app.db.get('SELECT * FROM contacts WHERE id = ? AND org_id = ?', id, orgId);
  if (!row) throw new NotFoundError('Contact');
  return serializeContact(row);
}

function findContactByEmail(app, orgId, email) {
  if (!email) return null;
  return serializeContact(app.db.get('SELECT * FROM contacts WHERE org_id = ? AND email = ? COLLATE NOCASE ORDER BY created_at LIMIT 1', orgId, String(email).trim()));
}

function listContacts(app, orgId, { q, stage, tag, limit, offset } = {}) {
  const where = ['org_id = ?'];
  const params = [orgId];
  if (q) {
    where.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\')");
    const like = likeEscape(q);
    params.push(like, like, like);
  }
  if (stage) {
    where.push('stage = ?');
    params.push(stage);
  }
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)');
    params.push(tag);
  }
  const sql = `SELECT * FROM contacts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
  const total = app.db.get(`SELECT COUNT(*) AS n FROM contacts WHERE ${where.join(' AND ')}`, ...params).n;
  const rows = app.db.all(sql, ...params, clampLimit(limit), Math.max(0, Number.parseInt(offset, 10) || 0));
  return { items: rows.map(serializeContact), total };
}

function createContact(app, orgId, input, { actor = 'system', depth = 0 } = {}) {
  const data = check(contactSchema, input);
  const now = Date.now();
  const id = newId('con');
  return app.db.transaction(() => {
    app.db.run(
      `INSERT INTO contacts (id, org_id, name, email, phone, company, stage, value_cents, owner, tags, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, orgId, data.name, data.email, data.phone, data.company, data.stage, data.value_cents, data.owner,
      JSON.stringify(dedupe(data.tags)), data.notes, now, now,
    );
    const contact = getContact(app, orgId, id);
    audit.record(app.db, { orgId, actor, action: 'contact.created', entity: 'contact', entityId: id });
    app.events.emit(orgId, 'contact.created', contact, { depth });
    return contact;
  });
}

function updateContact(app, orgId, id, input, { actor = 'system', depth = 0 } = {}) {
  const changes = check(contactSchema, input, { partial: true });
  return app.db.transaction(() => {
    const before = getContact(app, orgId, id);
    if (changes.tags) changes.tags = dedupe(changes.tags);
    const fields = Object.keys(changes);
    if (fields.length === 0) return before;
    const sets = fields.map((f) => `${f} = ?`);
    const values = fields.map((f) => (f === 'tags' ? JSON.stringify(changes[f]) : changes[f]));
    app.db.run(`UPDATE contacts SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`, ...values, Date.now(), id, orgId);
    const after = getContact(app, orgId, id);
    const changed = fields.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
    if (changed.length === 0) return after;
    audit.record(app.db, { orgId, actor, action: 'contact.updated', entity: 'contact', entityId: id, data: { changed } });
    app.events.emit(orgId, 'contact.updated', { ...after, changed, previous: pick(before, changed) }, { depth });
    if (changed.includes('stage')) {
      app.events.emit(orgId, 'contact.stage_changed', { ...after, from: before.stage, to: after.stage }, { depth });
    }
    return after;
  });
}

function deleteContact(app, orgId, id, { actor = 'system' } = {}) {
  return app.db.transaction(() => {
    getContact(app, orgId, id);
    app.db.run('DELETE FROM contacts WHERE id = ? AND org_id = ?', id, orgId);
    audit.record(app.db, { orgId, actor, action: 'contact.deleted', entity: 'contact', entityId: id });
  });
}

// ---------------- tasks ----------------

const taskSchema = {
  title: { type: 'string', required: true, max: 300 },
  description: { type: 'string', max: 20000, emptyAsNull: true, trim: false },
  status: { type: 'string', enum: TASK_STATUSES, default: 'open' },
  priority: { type: 'string', enum: PRIORITIES, default: 'normal' },
  assignee: { type: 'string', max: 200, emptyAsNull: true },
  due_date: { type: 'string', format: 'date', emptyAsNull: true },
  contact_id: { type: 'string', max: 64, emptyAsNull: true },
  source: { type: 'string', max: 200, emptyAsNull: true },
};

function getTask(app, orgId, id) {
  const row = app.db.get('SELECT * FROM tasks WHERE id = ? AND org_id = ?', id, orgId);
  if (!row) throw new NotFoundError('Task');
  return row;
}

function listTasks(app, orgId, { q, status, assignee, contact_id: contactId, due, limit, offset } = {}) {
  const where = ['org_id = ?'];
  const params = [orgId];
  if (q) {
    where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    params.push(likeEscape(q), likeEscape(q));
  }
  if (status === 'active') where.push("status IN ('open','in_progress')");
  else if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (assignee) {
    where.push('assignee = ?');
    params.push(assignee);
  }
  if (contactId) {
    where.push('contact_id = ?');
    params.push(contactId);
  }
  if (due === 'overdue') {
    where.push("due_date < ? AND status IN ('open','in_progress')");
    params.push(today());
  } else if (due === 'today') {
    where.push("due_date = ? AND status IN ('open','in_progress')");
    params.push(today());
  }
  const w = where.join(' AND ');
  const total = app.db.get(`SELECT COUNT(*) AS n FROM tasks WHERE ${w}`, ...params).n;
  const items = app.db.all(
    `SELECT * FROM tasks WHERE ${w}
     ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 0 ELSE 1 END,
              CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              due_date IS NULL, due_date, created_at DESC
     LIMIT ? OFFSET ?`,
    ...params, clampLimit(limit), Math.max(0, Number.parseInt(offset, 10) || 0),
  );
  return { items, total };
}

function assertContact(app, orgId, contactId) {
  if (contactId && !app.db.get('SELECT 1 FROM contacts WHERE id = ? AND org_id = ?', contactId, orgId)) {
    throw new ValidationError('contact_id does not refer to an existing contact');
  }
}

function createTask(app, orgId, input, { actor = 'system', depth = 0 } = {}) {
  const data = check(taskSchema, input);
  const now = Date.now();
  const id = newId('tsk');
  return app.db.transaction(() => {
    assertContact(app, orgId, data.contact_id);
    app.db.run(
      `INSERT INTO tasks (id, org_id, title, description, status, priority, assignee, due_date, contact_id, source, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, orgId, data.title, data.description, data.status, data.priority, data.assignee, data.due_date,
      data.contact_id, data.source, data.status === 'done' ? now : null, now, now,
    );
    const task = getTask(app, orgId, id);
    audit.record(app.db, { orgId, actor, action: 'task.created', entity: 'task', entityId: id });
    app.events.emit(orgId, 'task.created', task, { depth });
    return task;
  });
}

function updateTask(app, orgId, id, input, { actor = 'system', depth = 0 } = {}) {
  const changes = check(taskSchema, input, { partial: true });
  return app.db.transaction(() => {
    const before = getTask(app, orgId, id);
    if ('contact_id' in changes) assertContact(app, orgId, changes.contact_id);
    const fields = Object.keys(changes);
    if (fields.length === 0) return before;
    const sets = fields.map((f) => `${f} = ?`);
    const values = fields.map((f) => changes[f]);
    if (changes.status === 'done' && before.status !== 'done') sets.push(`completed_at = ${Date.now()}`);
    if (changes.status && changes.status !== 'done') sets.push('completed_at = NULL');
    // Moving the due date re-arms the overdue notification.
    if ('due_date' in changes && changes.due_date !== before.due_date) sets.push('overdue_notified_at = NULL');
    app.db.run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`, ...values, Date.now(), id, orgId);
    const after = getTask(app, orgId, id);
    audit.record(app.db, { orgId, actor, action: 'task.updated', entity: 'task', entityId: id, data: { fields } });
    if (after.status === 'done' && before.status !== 'done') app.events.emit(orgId, 'task.completed', after, { depth });
    return after;
  });
}

function deleteTask(app, orgId, id, { actor = 'system' } = {}) {
  return app.db.transaction(() => {
    getTask(app, orgId, id);
    app.db.run('DELETE FROM tasks WHERE id = ? AND org_id = ?', id, orgId);
    audit.record(app.db, { orgId, actor, action: 'task.deleted', entity: 'task', entityId: id });
  });
}

// ---------------- invoices ----------------

const itemSchema = {
  description: { type: 'string', required: true, max: 500 },
  quantity: { type: 'number', min: 0, max: 1e9, default: 1 },
  unit_price_cents: { type: 'integer', min: 0, max: 1e13, required: true },
};

const invoiceSchema = {
  number: { type: 'string', max: 50, pattern: /^[A-Za-z0-9._\-/#]+$/, emptyAsNull: true },
  contact_id: { type: 'string', max: 64, emptyAsNull: true },
  currency: { type: 'string', pattern: /^[A-Z]{3}$/, default: 'USD' },
  items: { type: 'array', max: 200, items: { type: 'object', schema: itemSchema }, default: () => [] },
  due_date: { type: 'string', format: 'date', emptyAsNull: true },
  notes: { type: 'string', max: 5000, emptyAsNull: true, trim: false },
};

function computeTotal(items) {
  return items.reduce((t, it) => t + Math.round(it.quantity * it.unit_price_cents), 0);
}

function serializeInvoice(row, app) {
  if (!row) return row;
  const inv = { ...row, items: parseJson(row.items, []) };
  if (app && row.contact_id) {
    const c = app.db.get('SELECT id, name, email, company FROM contacts WHERE id = ?', row.contact_id);
    inv.contact = c || null;
  }
  return inv;
}

function getInvoice(app, orgId, id) {
  const row = app.db.get('SELECT * FROM invoices WHERE id = ? AND org_id = ?', id, orgId);
  if (!row) throw new NotFoundError('Invoice');
  return serializeInvoice(row, app);
}

function listInvoices(app, orgId, { q, status, contact_id: contactId, limit, offset } = {}) {
  const where = ['i.org_id = ?'];
  const params = [orgId];
  if (status === 'unpaid') where.push("i.status IN ('sent','overdue')");
  else if (status) {
    where.push('i.status = ?');
    params.push(status);
  }
  if (contactId) {
    where.push('i.contact_id = ?');
    params.push(contactId);
  }
  if (q) {
    where.push("(i.number LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.company LIKE ? ESCAPE '\\')");
    const like = likeEscape(q);
    params.push(like, like, like);
  }
  const w = where.join(' AND ');
  const from = 'FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id';
  const total = app.db.get(`SELECT COUNT(*) AS n ${from} WHERE ${w}`, ...params).n;
  const rows = app.db.all(
    `SELECT i.*, c.name AS contact_name, c.email AS contact_email ${from} WHERE ${w} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
    ...params, clampLimit(limit), Math.max(0, Number.parseInt(offset, 10) || 0),
  );
  return { items: rows.map((r) => serializeInvoice(r)), total };
}

function nextInvoiceNumber(app, orgId) {
  const rows = app.db.all("SELECT number FROM invoices WHERE org_id = ? AND number LIKE 'INV-%'", orgId);
  let max = 0;
  for (const r of rows) {
    const n = Number.parseInt(r.number.slice(4), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `INV-${String(max + 1).padStart(4, '0')}`;
}

function createInvoice(app, orgId, input, { actor = 'system', depth = 0 } = {}) {
  const data = check(invoiceSchema, input);
  const now = Date.now();
  const id = newId('inv');
  return app.db.transaction(() => {
    assertContact(app, orgId, data.contact_id);
    const number = data.number || nextInvoiceNumber(app, orgId);
    if (app.db.get('SELECT 1 FROM invoices WHERE org_id = ? AND number = ?', orgId, number)) {
      throw new ValidationError(`Invoice number ${number} is already in use`);
    }
    app.db.run(
      `INSERT INTO invoices (id, org_id, number, contact_id, currency, items, amount_cents, status, due_date, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      id, orgId, number, data.contact_id, data.currency, JSON.stringify(data.items), computeTotal(data.items),
      data.due_date, data.notes, now, now,
    );
    const invoice = getInvoice(app, orgId, id);
    audit.record(app.db, { orgId, actor, action: 'invoice.created', entity: 'invoice', entityId: id });
    app.events.emit(orgId, 'invoice.created', invoice, { depth });
    return invoice;
  });
}

function updateInvoice(app, orgId, id, input, { actor = 'system' } = {}) {
  const changes = check(invoiceSchema, input, { partial: true });
  return app.db.transaction(() => {
    const before = getInvoice(app, orgId, id);
    if (before.status !== 'draft') throw new ValidationError('Only draft invoices can be edited');
    if ('contact_id' in changes) assertContact(app, orgId, changes.contact_id);
    if (changes.number && changes.number !== before.number &&
        app.db.get('SELECT 1 FROM invoices WHERE org_id = ? AND number = ?', orgId, changes.number)) {
      throw new ValidationError(`Invoice number ${changes.number} is already in use`);
    }
    if (changes.number === null) delete changes.number;
    const fields = Object.keys(changes);
    if (fields.length === 0) return before;
    const sets = fields.map((f) => `${f} = ?`);
    const values = fields.map((f) => (f === 'items' ? JSON.stringify(changes[f]) : changes[f]));
    if (changes.items) {
      sets.push('amount_cents = ?');
      values.push(computeTotal(changes.items));
    }
    app.db.run(`UPDATE invoices SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`, ...values, Date.now(), id, orgId);
    audit.record(app.db, { orgId, actor, action: 'invoice.updated', entity: 'invoice', entityId: id, data: { fields } });
    return getInvoice(app, orgId, id);
  });
}

const TRANSITIONS = {
  draft: ['sent', 'void'],
  sent: ['paid', 'void', 'overdue'],
  overdue: ['paid', 'void', 'sent'],
  paid: [],
  void: [],
};

function setInvoiceStatus(app, orgId, id, status, { actor = 'system', depth = 0 } = {}) {
  if (!INVOICE_STATUSES.includes(status)) throw new ValidationError(`status must be one of: ${INVOICE_STATUSES.join(', ')}`);
  return app.db.transaction(() => {
    const before = getInvoice(app, orgId, id);
    if (before.status === status) return before;
    if (!TRANSITIONS[before.status].includes(status)) {
      throw new ValidationError(`Cannot change invoice from ${before.status} to ${status}`);
    }
    if (status === 'sent' && before.items.length === 0) throw new ValidationError('Add at least one line item before sending');
    const now = Date.now();
    app.db.run(
      `UPDATE invoices SET status = ?, sent_at = CASE WHEN ? = 'sent' AND sent_at IS NULL THEN ? ELSE sent_at END,
         paid_at = CASE WHEN ? = 'paid' THEN ? ELSE paid_at END, updated_at = ? WHERE id = ? AND org_id = ?`,
      status, status, now, status, now, now, id, orgId,
    );
    const after = getInvoice(app, orgId, id);
    audit.record(app.db, { orgId, actor, action: `invoice.${status}`, entity: 'invoice', entityId: id, data: { from: before.status } });
    const eventName = { sent: 'invoice.sent', paid: 'invoice.paid', overdue: 'invoice.overdue', void: 'invoice.voided' }[status];
    if (eventName) app.events.emit(orgId, eventName, after, { depth });
    return after;
  });
}

function deleteInvoice(app, orgId, id, { actor = 'system' } = {}) {
  return app.db.transaction(() => {
    const inv = getInvoice(app, orgId, id);
    if (inv.status !== 'draft') throw new ValidationError('Only draft invoices can be deleted; void it instead');
    app.db.run('DELETE FROM invoices WHERE id = ? AND org_id = ?', id, orgId);
    audit.record(app.db, { orgId, actor, action: 'invoice.deleted', entity: 'invoice', entityId: id });
  });
}

function recordInvoiceReminder(app, orgId, id) {
  app.db.run('UPDATE invoices SET reminder_count = reminder_count + 1, updated_at = ? WHERE id = ? AND org_id = ?', Date.now(), id, orgId);
}

// ---------------- helpers ----------------

function dedupe(arr) {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

module.exports = {
  STAGES,
  TASK_STATUSES,
  PRIORITIES,
  INVOICE_STATUSES,
  NotFoundError,
  clampLimit,
  getContact,
  findContactByEmail,
  listContacts,
  createContact,
  updateContact,
  deleteContact,
  getTask,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  getInvoice,
  listInvoices,
  createInvoice,
  updateInvoice,
  setInvoiceStatus,
  deleteInvoice,
  recordInvoiceReminder,
};
