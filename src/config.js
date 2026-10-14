'use strict';

const path = require('node:path');

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function load(overrides = {}) {
  const config = {
    port: int('PORT', 3000),
    host: process.env.HOST || '0.0.0.0',
    dbPath: process.env.DB_PATH || path.join(process.cwd(), 'data', 'autopilot.db'),
    // Public base URL used when building webhook URLs shown to users.
    publicUrl: process.env.PUBLIC_URL || '',
    sessionTtlHours: int('SESSION_TTL_HOURS', 24 * 14),
    workerConcurrency: int('WORKER_CONCURRENCY', 4),
    workerPollMs: int('WORKER_POLL_MS', 500),
    maxStepsPerRun: int('MAX_STEPS_PER_RUN', 500),
    maxEventDepth: int('MAX_EVENT_DEPTH', 5),
    httpActionTimeoutMs: int('HTTP_ACTION_TIMEOUT_MS', 15000),
    // When false, the http_request action refuses private / loopback addresses (SSRF protection).
    allowPrivateNetworkRequests: bool('ALLOW_PRIVATE_NETWORK_REQUESTS', false),
    // Email delivery: "log" stores messages in the outbox only; "webhook" POSTs each message as JSON to EMAIL_WEBHOOK_URL.
    emailProvider: process.env.EMAIL_PROVIDER || 'log',
    emailWebhookUrl: process.env.EMAIL_WEBHOOK_URL || '',
    emailFrom: process.env.EMAIL_FROM || 'autopilot@localhost',
    trustProxy: bool('TRUST_PROXY', false),
    secureCookies: bool('SECURE_COOKIES', false),
    runRetentionDays: int('RUN_RETENTION_DAYS', 90),
    maxBodyBytes: int('MAX_BODY_BYTES', 1024 * 1024),
    ...overrides,
  };
  if (!['log', 'webhook'].includes(config.emailProvider)) {
    throw new Error('EMAIL_PROVIDER must be "log" or "webhook"');
  }
  if (config.emailProvider === 'webhook' && !config.emailWebhookUrl) {
    throw new Error('EMAIL_WEBHOOK_URL is required when EMAIL_PROVIDER=webhook');
  }
  return config;
}

module.exports = { load };
