'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('../services/auth');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const SESSION_COOKIE = 'bap_session';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// ---------- rate limiting (token bucket, in-memory) ----------

class RateLimiter {
  constructor({ capacity, refillPerSec }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
  }

  take(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size > 50000) this.buckets.clear();
      b = { tokens: this.capacity, at: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    if (b.tokens < 1) return Math.ceil((1 - b.tokens) / this.refillPerSec);
    b.tokens -= 1;
    return 0;
  }
}

// ---------- router ----------

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, options, handler) {
    if (typeof options === 'function') {
      handler = options;
      options = {};
    }
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/\/:([A-Za-z_]+)/g, (_, k) => {
      keys.push(k);
      return '/([^/]+)';
    })}/?$`);
    this.routes.push({ method, regex, keys, handler, auth: options.auth ?? 'member', rate: options.rate, raw: options.raw });
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function sendJson(res, status, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    // SPA fallback: unknown non-asset paths serve the app shell.
    if (path.extname(rel)) return false;
    rel = '/index.html';
    file = path.join(PUBLIC_DIR, rel);
    stat = fs.statSync(file);
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(file);
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=300');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  res.writeHead(200);
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}

function createServer(app, router) {
  const { config } = app;
  const limiters = {
    auth: new RateLimiter({ capacity: 10, refillPerSec: 10 / 60 }),
    webhook: new RateLimiter({ capacity: 120, refillPerSec: 2 }),
    api: new RateLimiter({ capacity: 600, refillPerSec: 10 }),
  };
  const logger = app.logger || console;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const requestId = crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', requestId);
    securityHeaders(res);
    const ip = (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Malformed URL' });
    }
    const { pathname } = url;

    try {
      const isApi = pathname.startsWith('/api/') || pathname.startsWith('/hooks/') || pathname === '/healthz';
      if (!isApi) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, pathname)) return;
        throw new HttpError(404, 'Not found');
      }

      const matched = router.match(req.method, pathname);
      if (!matched) throw new HttpError(404, 'Not found');
      if (matched.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
      const { route, params } = matched;

      const cookies = parseCookies(req.headers.cookie);
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
      const token = bearer || cookies[SESSION_COOKIE];
      const principal = token ? auth.authenticate(app, token) : null;

      const limiter = limiters[route.rate || 'api'];
      const wait = limiter.take(`${route.rate || 'api'}:${route.rate === 'webhook' ? params.id : principal?.id || ip}`);
      if (wait > 0) {
        res.setHeader('Retry-After', String(wait));
        throw new HttpError(429, 'Too many requests, please slow down');
      }

      if (route.auth !== 'none') {
        if (!principal) throw new HttpError(401, 'Authentication required');
        if (!auth.hasRole(principal, route.auth)) throw new HttpError(403, 'You do not have permission to do this');
      }

      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      // CSRF defence for cookie sessions: same-origin check plus JSON-only bodies (cross-site forms cannot send JSON).
      if (mutating && !bearer && cookies[SESSION_COOKIE] && route.auth !== 'none') {
        const { origin } = req.headers;
        if (origin) {
          let originHost = null;
          try {
            originHost = new URL(origin).host;
          } catch {
            // "null" or malformed origins are treated as cross-origin.
          }
          if (originHost !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
        }
      }

      let body = {};
      let rawBody = Buffer.alloc(0);
      if (mutating) {
        rawBody = await readBody(req, config.maxBodyBytes);
        if (rawBody.length > 0) {
          const type = String(req.headers['content-type'] || '');
          if (type.includes('application/json')) {
            try {
              body = JSON.parse(rawBody.toString('utf8'));
            } catch {
              throw new HttpError(400, 'Request body is not valid JSON');
            }
          } else if (route.raw) {
            body = type.includes('application/x-www-form-urlencoded')
              ? Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')))
              : { raw: rawBody.toString('utf8') };
          } else {
            throw new HttpError(415, 'Content-Type must be application/json');
          }
        }
      }

      const ctx = {
        req,
        res,
        params,
        query: Object.fromEntries(url.searchParams),
        body,
        rawBody,
        principal,
        ip,
        requestId,
        token,
        setSession(value, maxAgeSec) {
          const parts = [`${SESSION_COOKIE}=${value ? encodeURIComponent(value) : ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${value ? maxAgeSec : 0}`];
          if (config.secureCookies) parts.push('Secure');
          res.setHeader('Set-Cookie', parts.join('; '));
        },
      };
      const result = await route.handler(ctx);
      if (res.headersSent) return;
      if (result === undefined) {
        res.writeHead(204);
        res.end();
      } else {
        sendJson(res, result?.__status || 200, result?.__status ? result.body : result);
      }
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      if (status >= 500) logger.error(`[http] ${req.method} ${pathname} (${requestId})`, err);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: status >= 500 ? 'Internal server error' : err.message,
          ...(err.errors ? { details: err.errors } : {}),
          ...(err.details ? { details: err.details } : {}),
          requestId,
        });
      } else {
        res.end();
      }
    } finally {
      if (app.config.logRequests) logger.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  server.headersTimeout = 30000;
  server.requestTimeout = 60000;
  return server;
}

const created = (body) => ({ __status: 201, body });

module.exports = { createServer, Router, HttpError, created, RateLimiter, SESSION_COOKIE };
