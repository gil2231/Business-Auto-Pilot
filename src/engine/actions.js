'use strict';

// Built-in workflow actions. Each action receives its params already rendered (templates resolved) and a
// context object. Throwing an error fails the step (subject to retry / onError policy). Errors with
// `retryable === false` skip remaining retries because repeating the call cannot succeed.

const records = require('../services/records');
const { newId } = require('../db');
const { request, HttpActionError } = require('./http-client');
const { EMAIL } = require('../validate');

class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentError';
    this.retryable = false;
  }
}

function requireString(params, key) {
  const v = params[key];
  if (typeof v !== 'string' || v.trim() === '') throw new PermanentError(`Parameter "${key}" is required`);
  return v.trim();
}

function recordOpts(ctx) {
  return { actor: `workflow:${ctx.workflow.id}`, depth: ctx.depth + 1 };
}

// Convert record-layer validation/not-found errors into permanent failures (retrying will not fix them).
async function permanent(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 400 || err.status === 404) throw new PermanentError(err.message);
    throw err;
  }
}

function pickDefined(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const CONTACT_FIELDS = ['name', 'email', 'phone', 'company', 'stage', 'value_cents', 'owner', 'tags', 'notes'];
const TASK_FIELDS = ['title', 'description', 'status', 'priority', 'assignee', 'due_date', 'contact_id', 'source'];

async function deliverEmail(ctx, { to, cc, subject, body }) {
  const { app } = ctx;
  const id = newId('msg');
  const now = Date.now();
  const recipients = [to, ...(cc ? [cc] : [])].join(', ');
  let status = 'logged';
  let error = null;
  if (app.config.emailProvider === 'webhook') {
    try {
      const res = await request({
        method: 'POST',
        url: app.config.emailWebhookUrl,
        body: { from: app.config.emailFrom, to, cc: cc || undefined, subject, text: body, messageId: id },
        timeoutMs: app.config.httpActionTimeoutMs,
        allowPrivate: true, // operator-configured endpoint
      });
      if (!res.ok) throw new HttpActionError(`Email provider responded with HTTP ${res.status}`, { retryable: res.status >= 500 || res.status === 429 });
      status = 'delivered';
    } catch (err) {
      status = 'failed';
      error = err.message;
      app.db.run(
        'INSERT INTO outbox (id, org_id, channel, recipient, subject, body, status, error, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, ctx.orgId, 'email', recipients, subject, body, status, error, ctx.run.id, now,
      );
      throw err;
    }
  }
  app.db.run(
    'INSERT INTO outbox (id, org_id, channel, recipient, subject, body, status, error, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, ctx.orgId, 'email', recipients, subject, body, status, error, ctx.run.id, now,
  );
  return { messageId: id, status, to, subject };
}

const ACTIONS = {
  log: {
    label: 'Log a message',
    category: 'Utility',
    params: { message: { type: 'string', required: true } },
    async run(params, ctx) {
      ctx.log('info', String(params.message ?? ''));
      return { message: params.message };
    },
  },

  set_variables: {
    label: 'Set variables',
    category: 'Utility',
    description: 'Store values under vars.* for later steps.',
    params: { values: { type: 'object', required: true } },
    async run(params, ctx) {
      if (!params.values || typeof params.values !== 'object' || Array.isArray(params.values)) throw new PermanentError('"values" must be an object');
      for (const [k, v] of Object.entries(params.values)) {
        if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
        ctx.vars[k] = v;
      }
      return params.values;
    },
  },

  transform: {
    label: 'Transform data',
    category: 'Utility',
    description: 'Outputs "value" after template evaluation, for reshaping data.',
    params: { value: { type: 'any', required: true } },
    async run(params) {
      return params.value;
    },
  },

  delay: {
    label: 'Wait',
    category: 'Flow',
    description: 'Pause the run for a duration (minutes/hours/days) or until a date/time.',
    params: { minutes: { type: 'number' }, hours: { type: 'number' }, days: { type: 'number' }, until: { type: 'string' } },
    async run(params, ctx) {
      if (ctx.state.until === undefined) {
        let until;
        if (params.until) {
          until = new Date(params.until).getTime();
          if (Number.isNaN(until)) throw new PermanentError(`Invalid "until" date: ${params.until}`);
        } else {
          const ms = (Number(params.minutes) || 0) * 60000 + (Number(params.hours) || 0) * 3600000 + (Number(params.days) || 0) * 86400000;
          if (ms <= 0) throw new PermanentError('delay needs a positive minutes, hours, days or an until date');
          until = ctx.now() + ms;
        }
        ctx.state.until = until;
      }
      if (ctx.now() < ctx.state.until) return ctx.suspend(ctx.state.until);
      return { resumedAt: new Date(ctx.now()).toISOString(), waitedUntil: new Date(ctx.state.until).toISOString() };
    },
  },

  approval: {
    label: 'Request approval',
    category: 'Flow',
    description: 'Pause until a teammate approves or rejects in the Approvals inbox. Output: { approved, status, decidedBy, comment }.',
    params: { title: { type: 'string', required: true }, details: { type: 'string' }, timeoutHours: { type: 'number' } },
    async run(params, ctx) {
      const { db } = ctx.app;
      if (!ctx.state.approvalId) {
        const id = newId('apr');
        const hours = Number(params.timeoutHours);
        const expiresAt = Number.isFinite(hours) && hours > 0 ? ctx.now() + hours * 3600000 : null;
        db.run(
          'INSERT INTO approvals (id, org_id, run_id, step_id, title, details, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, ctx.orgId, ctx.run.id, ctx.step.id, String(requireString(params, 'title')).slice(0, 300),
          params.details == null ? null : String(params.details).slice(0, 10000), 'pending', expiresAt, ctx.now(),
        );
        ctx.state.approvalId = id;
        ctx.log('info', `Waiting for approval: ${params.title}`, { approvalId: id });
        return ctx.suspend(expiresAt);
      }
      let approval = db.get('SELECT * FROM approvals WHERE id = ?', ctx.state.approvalId);
      if (!approval) throw new PermanentError('Approval record was deleted');
      if (approval.status === 'pending') {
        if (approval.expires_at && ctx.now() >= approval.expires_at) {
          db.run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", ctx.now(), approval.id);
          approval = db.get('SELECT * FROM approvals WHERE id = ?', approval.id);
        } else {
          return ctx.suspend(approval.expires_at);
        }
      }
      return {
        approvalId: approval.id,
        approved: approval.status === 'approved',
        status: approval.status,
        decidedBy: approval.decided_by,
        comment: approval.comment,
      };
    },
  },

  http_request: {
    label: 'HTTP request',
    category: 'Integrations',
    description: 'Call any API. Output: { status, ok, headers, body }.',
    params: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
      url: { type: 'string', required: true },
      headers: { type: 'object' },
      body: { type: 'any' },
      timeoutMs: { type: 'number' },
      failOnHttpError: { type: 'boolean' },
    },
    async run(params, ctx) {
      const method = String(params.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new PermanentError(`Unsupported method ${method}`);
      const headers = {};
      for (const [k, v] of Object.entries(params.headers || {})) headers[k] = String(v);
      const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || ctx.app.config.httpActionTimeoutMs, 100), 120000);
      const res = await request({
        method,
        url: requireString(params, 'url'),
        headers,
        body: params.body,
        timeoutMs,
        allowPrivate: ctx.app.config.allowPrivateNetworkRequests,
      });
      if (!res.ok && params.failOnHttpError !== false) {
        throw new HttpActionError(`HTTP ${res.status} from ${params.url}`, {
          retryable: res.status >= 500 || res.status === 429 || res.status === 408,
        });
      }
      return res;
    },
  },

  send_email: {
    label: 'Send email',
    category: 'Messaging',
    params: { to: { type: 'string', required: true }, cc: { type: 'string' }, subject: { type: 'string', required: true }, body: { type: 'string', required: true } },
    async run(params, ctx) {
      const to = requireString(params, 'to');
      const cc = params.cc ? String(params.cc).trim() : '';
      for (const addr of [to, ...(cc ? [cc] : [])].flatMap((s) => s.split(',').map((x) => x.trim()))) {
        if (!EMAIL.test(addr)) throw new PermanentError(`Invalid email address: ${addr}`);
      }
      return deliverEmail(ctx, { to, cc, subject: requireString(params, 'subject'), body: String(params.body ?? '') });
    },
  },

  slack_message: {
    label: 'Post to Slack / Teams',
    category: 'Messaging',
    description: 'Post a message to an incoming-webhook URL (Slack, Microsoft Teams, Discord, Google Chat).',
    params: { webhookUrl: { type: 'string', required: true }, text: { type: 'string', required: true } },
    async run(params, ctx) {
      const url = requireString(params, 'webhookUrl');
      const text = requireString(params, 'text');
      const body = /discord(app)?\.com/.test(url) ? { content: text } : { text };
      const res = await request({ method: 'POST', url, body, timeoutMs: ctx.app.config.httpActionTimeoutMs, allowPrivate: ctx.app.config.allowPrivateNetworkRequests });
      if (!res.ok) throw new HttpActionError(`Chat webhook responded with HTTP ${res.status}`, { retryable: res.status >= 500 || res.status === 429 });
      ctx.app.db.run(
        'INSERT INTO outbox (id, org_id, channel, recipient, subject, body, status, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId('msg'), ctx.orgId, 'chat', new URL(url).host, null, text, 'delivered', ctx.run.id, ctx.now(),
      );
      return { status: res.status };
    },
  },

  create_contact: {
    label: 'Create contact',
    category: 'CRM',
    description: 'Creates a contact. With "skipIfExists" and an email, returns the existing contact instead of a duplicate.',
    params: {
      name: { type: 'string', required: true }, email: { type: 'string' }, phone: { type: 'string' }, company: { type: 'string' },
      stage: { type: 'string' }, value_cents: { type: 'number' }, owner: { type: 'string' }, tags: { type: 'array' }, notes: { type: 'string' },
      skipIfExists: { type: 'boolean' },
    },
    async run(params, ctx) {
      return permanent(() => {
        if (params.skipIfExists !== false && params.email) {
          const existing = records.findContactByEmail(ctx.app, ctx.orgId, params.email);
          if (existing) return { ...existing, existed: true };
        }
        return { ...records.createContact(ctx.app, ctx.orgId, pickDefined(params, CONTACT_FIELDS), recordOpts(ctx)), existed: false };
      });
    },
  },

  update_contact: {
    label: 'Update contact',
    category: 'CRM',
    description: 'Updates a contact found by "id" or "email".',
    params: {
      id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' }, company: { type: 'string' },
      stage: { type: 'string' }, value_cents: { type: 'number' }, owner: { type: 'string' }, addTags: { type: 'array' }, notes: { type: 'string' },
    },
    async run(params, ctx) {
      return permanent(() => {
        const contact = params.id ? records.getContact(ctx.app, ctx.orgId, params.id) : records.findContactByEmail(ctx.app, ctx.orgId, params.email);
        if (!contact) throw new PermanentError('Contact not found (provide "id" or "email")');
        const changes = pickDefined(params, CONTACT_FIELDS.filter((f) => f !== 'email' && f !== 'tags'));
        if (Array.isArray(params.addTags)) changes.tags = [...contact.tags, ...params.addTags.map(String)];
        return records.updateContact(ctx.app, ctx.orgId, contact.id, changes, recordOpts(ctx));
      });
    },
  },

  get_contact: {
    label: 'Get contact',
    category: 'CRM',
    description: 'Loads the latest version of a contact by "id" or "email". Output: the contact, or { found: false }.',
    params: { id: { type: 'string' }, email: { type: 'string' } },
    async run(params, ctx) {
      if (params.id) {
        try {
          return { ...records.getContact(ctx.app, ctx.orgId, String(params.id)), found: true };
        } catch (err) {
          if (err.status === 404) return { found: false };
          throw err;
        }
      }
      const c = records.findContactByEmail(ctx.app, ctx.orgId, params.email);
      return c ? { ...c, found: true } : { found: false };
    },
  },

  find_contacts: {
    label: 'Find contacts',
    category: 'CRM',
    description: 'Output: { items, total, totalValueCents }.',
    params: { q: { type: 'string' }, stage: { type: 'string' }, tag: { type: 'string' }, limit: { type: 'number' } },
    async run(params, ctx) {
      const res = records.listContacts(ctx.app, ctx.orgId, { ...params, limit: params.limit || 100 });
      return { ...res, totalValueCents: res.items.reduce((t, c) => t + c.value_cents, 0) };
    },
  },

  create_task: {
    label: 'Create task',
    category: 'Tasks',
    params: {
      title: { type: 'string', required: true }, description: { type: 'string' }, priority: { type: 'string' }, assignee: { type: 'string' },
      due_date: { type: 'string' }, dueInDays: { type: 'number' }, contact_id: { type: 'string' },
    },
    async run(params, ctx) {
      const data = pickDefined(params, TASK_FIELDS);
      if (params.dueInDays !== undefined && !data.due_date) {
        data.due_date = new Date(ctx.now() + Number(params.dueInDays) * 86400000).toISOString().slice(0, 10);
      }
      data.source = data.source || `workflow:${ctx.workflow.name}`.slice(0, 200);
      return permanent(() => records.createTask(ctx.app, ctx.orgId, data, recordOpts(ctx)));
    },
  },

  update_task: {
    label: 'Update task',
    category: 'Tasks',
    params: { id: { type: 'string', required: true }, title: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' }, assignee: { type: 'string' }, due_date: { type: 'string' } },
    async run(params, ctx) {
      return permanent(() => records.updateTask(ctx.app, ctx.orgId, requireString(params, 'id'), pickDefined(params, TASK_FIELDS), recordOpts(ctx)));
    },
  },

  find_tasks: {
    label: 'Find tasks',
    category: 'Tasks',
    description: 'status: open|in_progress|done|cancelled|active; due: overdue|today. Output: { items, total }.',
    params: { status: { type: 'string' }, due: { type: 'string' }, assignee: { type: 'string' }, limit: { type: 'number' } },
    async run(params, ctx) {
      return records.listTasks(ctx.app, ctx.orgId, { ...params, limit: params.limit || 100 });
    },
  },

  create_invoice: {
    label: 'Create invoice',
    category: 'Billing',
    params: {
      contact_id: { type: 'string' }, items: { type: 'array', required: true }, currency: { type: 'string' }, due_date: { type: 'string' },
      dueInDays: { type: 'number' }, notes: { type: 'string' }, send: { type: 'boolean' },
    },
    async run(params, ctx) {
      const data = pickDefined(params, ['contact_id', 'items', 'currency', 'due_date', 'notes']);
      if (params.dueInDays !== undefined && !data.due_date) {
        data.due_date = new Date(ctx.now() + Number(params.dueInDays) * 86400000).toISOString().slice(0, 10);
      }
      return permanent(() => {
        const inv = records.createInvoice(ctx.app, ctx.orgId, data, recordOpts(ctx));
        return params.send ? records.setInvoiceStatus(ctx.app, ctx.orgId, inv.id, 'sent', recordOpts(ctx)) : inv;
      });
    },
  },

  set_invoice_status: {
    label: 'Set invoice status',
    category: 'Billing',
    params: { id: { type: 'string', required: true }, status: { type: 'string', required: true } },
    async run(params, ctx) {
      return permanent(() => records.setInvoiceStatus(ctx.app, ctx.orgId, requireString(params, 'id'), requireString(params, 'status'), recordOpts(ctx)));
    },
  },

  get_invoice: {
    label: 'Get invoice',
    category: 'Billing',
    description: 'Loads the latest version of an invoice (e.g. to check whether it was paid after a delay).',
    params: { id: { type: 'string', required: true } },
    async run(params, ctx) {
      return permanent(() => records.getInvoice(ctx.app, ctx.orgId, requireString(params, 'id')));
    },
  },

  find_invoices: {
    label: 'Find invoices',
    category: 'Billing',
    description: 'status: draft|sent|overdue|paid|void|unpaid. Output: { items, total, totalCents }.',
    params: { status: { type: 'string' }, contact_id: { type: 'string' }, limit: { type: 'number' } },
    async run(params, ctx) {
      const res = records.listInvoices(ctx.app, ctx.orgId, { ...params, limit: params.limit || 100 });
      return { ...res, totalCents: res.items.reduce((t, i) => t + i.amount_cents, 0) };
    },
  },

  record_invoice_reminder: {
    label: 'Count invoice reminder',
    category: 'Billing',
    description: 'Increments the reminder counter on an invoice (used by dunning workflows).',
    params: { id: { type: 'string', required: true } },
    async run(params, ctx) {
      return permanent(() => {
        const id = requireString(params, 'id');
        records.getInvoice(ctx.app, ctx.orgId, id);
        records.recordInvoiceReminder(ctx.app, ctx.orgId, id);
        return records.getInvoice(ctx.app, ctx.orgId, id);
      });
    },
  },

  emit_event: {
    label: 'Emit custom event',
    category: 'Flow',
    description: 'Publishes an event that can trigger other workflows (e.g. "custom.vip_signed").',
    params: { type: { type: 'string', required: true }, data: { type: 'object' } },
    async run(params, ctx) {
      const type = requireString(params, 'type');
      if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(type)) throw new PermanentError('Event type must look like "namespace.name"');
      ctx.app.events.emit(ctx.orgId, type, params.data && typeof params.data === 'object' ? params.data : {}, { depth: ctx.depth + 1 });
      return { emitted: type };
    },
  },
};

// Step types handled by the engine itself rather than as actions.
const CONTROL_TYPES = {
  condition: {
    label: 'If / else',
    category: 'Flow',
    description: 'Evaluates "if" and jumps to "then" or "else" (step ids or "end").',
  },
  goto: {
    label: 'Go to step',
    category: 'Flow',
    description: 'Jumps to the step named in "next".',
  },
};

function catalog() {
  const out = [];
  for (const [type, a] of Object.entries(CONTROL_TYPES)) out.push({ type, label: a.label, category: a.category, description: a.description, params: {} });
  for (const [type, a] of Object.entries(ACTIONS)) {
    out.push({ type, label: a.label, category: a.category, description: a.description || '', params: a.params });
  }
  return out;
}

module.exports = { ACTIONS, CONTROL_TYPES, catalog, PermanentError };
