'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// Each migration runs once, in order, inside a transaction. Never edit a shipped migration; append a new one.
const MIGRATIONS = [
  `
  CREATE TABLE orgs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_users_org ON users(org_id);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('admin','member')),
    last_used_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    company TEXT,
    stage TEXT NOT NULL DEFAULT 'lead',
    value_cents INTEGER NOT NULL DEFAULT 0,
    owner TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_contacts_org ON contacts(org_id, updated_at DESC);
  CREATE INDEX idx_contacts_email ON contacts(org_id, email);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
    assignee TEXT,
    due_date TEXT,
    contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    source TEXT,
    overdue_notified_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_tasks_org ON tasks(org_id, status, due_date);

  CREATE TABLE invoices (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    number TEXT NOT NULL,
    contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    items TEXT NOT NULL DEFAULT '[]',
    amount_cents INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','overdue','paid','void')),
    due_date TEXT,
    notes TEXT,
    sent_at INTEGER,
    paid_at INTEGER,
    reminder_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (org_id, number)
  );
  CREATE INDEX idx_invoices_org ON invoices(org_id, status, due_date);

  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    trigger TEXT NOT NULL,
    steps TEXT NOT NULL,
    webhook_secret TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    last_scheduled_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_workflows_org ON workflows(org_id);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    workflow_version INTEGER NOT NULL,
    definition TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','waiting','succeeded','failed','cancelled')),
    trigger_type TEXT NOT NULL,
    trigger_data TEXT NOT NULL DEFAULT '{}',
    context TEXT NOT NULL DEFAULT '{}',
    current_step TEXT,
    step_count INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    next_run_at INTEGER,
    event_depth INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX idx_runs_claim ON runs(status, next_run_at);
  CREATE INDEX idx_runs_workflow ON runs(workflow_id, created_at DESC);
  CREATE INDEX idx_runs_org ON runs(org_id, created_at DESC);
  CREATE UNIQUE INDEX idx_runs_idem ON runs(workflow_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

  CREATE TABLE run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_id TEXT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_run_logs_run ON run_logs(run_id, id);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
    decided_by TEXT,
    comment TEXT,
    expires_at INTEGER,
    decided_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_approvals_org ON approvals(org_id, status, created_at DESC);

  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    run_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_outbox_org ON outbox(org_id, created_at DESC);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    data TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_audit_org ON audit_log(org_id, id DESC);
  `,
];

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

function open(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  migrate(db);
  return wrap(db);
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  const current = row.v || 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${i + 1} failed: ${err.message}`);
    }
  }
}

// Thin helper layer over node:sqlite with a statement cache and plain-object rows.
function wrap(raw) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const plain = (row) => (row ? { ...row } : row);
  // node:sqlite cannot bind undefined; treat it as NULL so optional fields can be passed straight through.
  const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
  let txDepth = 0;

  return {
    raw,
    get: (sql, ...params) => plain(stmt(sql).get(...norm(params))),
    all: (sql, ...params) => stmt(sql).all(...norm(params)).map(plain),
    run: (sql, ...params) => stmt(sql).run(...norm(params)),
    exec: (sql) => raw.exec(sql),
    // Nested calls reuse the outer transaction via savepoints.
    transaction(fn) {
      const sp = `sp_${txDepth}`;
      raw.exec(txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
      txDepth++;
      try {
        const result = fn();
        txDepth--;
        raw.exec(txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
        return result;
      } catch (err) {
        txDepth--;
        raw.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw err;
      }
    },
    close: () => raw.close(),
  };
}

function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

module.exports = { open, newId, parseJson };
