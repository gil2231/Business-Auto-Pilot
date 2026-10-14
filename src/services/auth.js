'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { newId } = require('../db');
const { check, ValidationError } = require('../validate');
const audit = require('./audit');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(key, expected);
}

// A hash of a random password, used to equalize login timing for unknown emails.
let dummyHash = null;
async function getDummyHash() {
  dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const passwordRule = { type: 'string', required: true, min: 10, max: 200, trim: false };

const signupSchema = {
  orgName: { type: 'string', required: true, max: 200 },
  name: { type: 'string', required: true, max: 200 },
  email: { type: 'string', required: true, format: 'email', max: 254 },
  password: passwordRule,
};

async function signup(app, input) {
  const data = check(signupSchema, input);
  const passwordHash = await hashPassword(data.password);
  const now = Date.now();
  const orgId = newId('org');
  const userId = newId('usr');
  app.db.transaction(() => {
    if (app.db.get('SELECT 1 FROM users WHERE email = ?', data.email)) {
      throw new ValidationError('An account with this email already exists');
    }
    app.db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)', orgId, data.orgName, now);
    app.db.run(
      "INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'owner', ?)",
      userId, orgId, data.email, data.name, passwordHash, now,
    );
    audit.record(app.db, { orgId, actor: data.email, action: 'org.created', entity: 'org', entityId: orgId });
  });
  return { userId, orgId, token: createSession(app, userId) };
}

async function login(app, input) {
  const data = check({ email: { type: 'string', required: true, max: 254 }, password: { type: 'string', required: true, max: 200, trim: false } }, input);
  const user = app.db.get('SELECT * FROM users WHERE email = ?', data.email.trim().toLowerCase());
  const ok = await verifyPassword(data.password, user ? user.password_hash : await getDummyHash());
  if (!user || !ok || !user.active) {
    const err = new Error('Invalid email or password');
    err.status = 401;
    throw err;
  }
  audit.record(app.db, { orgId: user.org_id, actor: user.email, action: 'user.login', entity: 'user', entityId: user.id });
  return { userId: user.id, token: createSession(app, user.id) };
}

function createSession(app, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  app.db.run(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    sha256(token), userId, now + app.config.sessionTtlHours * 3600000, now,
  );
  return token;
}

function destroySession(app, token) {
  if (token) app.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

// Resolves a session token or API key to a principal: { kind, userId?, orgId, role, name, email? }.
function authenticate(app, token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const now = Date.now();
  if (token.startsWith('bap_')) {
    const key = app.db.get('SELECT * FROM api_keys WHERE key_hash = ?', sha256(token));
    if (!key) return null;
    if (!key.last_used_at || now - key.last_used_at > 60000) {
      app.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now, key.id);
    }
    return { kind: 'api_key', id: key.id, orgId: key.org_id, role: key.role, name: `api-key:${key.name}` };
  }
  const row = app.db.get(
    `SELECT u.id, u.org_id, u.email, u.name, u.role, u.active, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    sha256(token),
  );
  if (!row || row.expires_at < now || !row.active) return null;
  return { kind: 'user', id: row.id, userId: row.id, orgId: row.org_id, role: row.role, name: row.email, email: row.email, displayName: row.name };
}

const ROLE_RANK = { member: 1, admin: 2, owner: 3 };
function hasRole(principal, role) {
  return (ROLE_RANK[principal.role] || 0) >= ROLE_RANK[role];
}

async function createUser(app, orgId, input, actor) {
  const data = check({
    name: { type: 'string', required: true, max: 200 },
    email: { type: 'string', required: true, format: 'email', max: 254 },
    password: passwordRule,
    role: { type: 'string', enum: ['admin', 'member'], default: 'member' },
  }, input);
  const hash = await hashPassword(data.password);
  const id = newId('usr');
  app.db.transaction(() => {
    if (app.db.get('SELECT 1 FROM users WHERE email = ?', data.email)) throw new ValidationError('An account with this email already exists');
    app.db.run(
      'INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, orgId, data.email, data.name, hash, data.role, Date.now(),
    );
    audit.record(app.db, { orgId, actor, action: 'user.created', entity: 'user', entityId: id, data: { role: data.role } });
  });
  return publicUser(app.db.get('SELECT * FROM users WHERE id = ?', id));
}

function updateUser(app, orgId, userId, input, principal) {
  const data = check({ role: { type: 'string', enum: ['admin', 'member'] }, active: { type: 'boolean' }, name: { type: 'string', max: 200 } }, input, { partial: true });
  return app.db.transaction(() => {
    const user = app.db.get('SELECT * FROM users WHERE id = ? AND org_id = ?', userId, orgId);
    if (!user) {
      const err = new Error('User not found');
      err.status = 404;
      throw err;
    }
    if (user.role === 'owner' && (data.role || data.active === false)) throw new ValidationError('The owner cannot be demoted or deactivated');
    if (user.id === principal.userId && data.active === false) throw new ValidationError('You cannot deactivate yourself');
    const fields = Object.keys(data);
    if (fields.length) {
      app.db.run(`UPDATE users SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, ...fields.map((f) => (f === 'active' ? (data[f] ? 1 : 0) : data[f])), userId);
      if (data.active === false) app.db.run('DELETE FROM sessions WHERE user_id = ?', userId);
      audit.record(app.db, { orgId, actor: principal.name, action: 'user.updated', entity: 'user', entityId: userId, data });
    }
    return publicUser(app.db.get('SELECT * FROM users WHERE id = ?', userId));
  });
}

async function changePassword(app, principal, input) {
  const data = check({ currentPassword: { type: 'string', required: true, max: 200, trim: false }, newPassword: passwordRule }, input);
  const user = app.db.get('SELECT * FROM users WHERE id = ?', principal.userId);
  if (!user || !(await verifyPassword(data.currentPassword, user.password_hash))) throw new ValidationError('Current password is incorrect');
  app.db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(data.newPassword), user.id);
  app.db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  audit.record(app.db, { orgId: user.org_id, actor: user.email, action: 'user.password_changed', entity: 'user', entityId: user.id });
  return createSession(app, user.id);
}

function createApiKey(app, orgId, input, principal) {
  const data = check({ name: { type: 'string', required: true, max: 100 }, role: { type: 'string', enum: ['admin', 'member'], default: 'member' } }, input);
  const secret = `bap_${crypto.randomBytes(24).toString('base64url')}`;
  const id = newId('key');
  app.db.run(
    'INSERT INTO api_keys (id, org_id, created_by, name, prefix, key_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, orgId, principal.userId || null, data.name, secret.slice(0, 10), sha256(secret), data.role, Date.now(),
  );
  audit.record(app.db, { orgId, actor: principal.name, action: 'api_key.created', entity: 'api_key', entityId: id });
  return { id, name: data.name, role: data.role, prefix: secret.slice(0, 10), key: secret };
}

function publicUser(u) {
  return u && { id: u.id, email: u.email, name: u.name, role: u.role, active: Boolean(u.active), created_at: u.created_at };
}

module.exports = {
  signup,
  login,
  authenticate,
  destroySession,
  hasRole,
  createUser,
  updateUser,
  changePassword,
  createApiKey,
  publicUser,
  hashPassword,
  verifyPassword,
  sha256,
};
