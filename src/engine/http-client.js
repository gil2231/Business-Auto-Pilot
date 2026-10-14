'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_RESPONSE_BYTES = 1024 * 1024;

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

const PRIVATE_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return PRIVATE_V4.some(([base, mask]) => (n & mask) >>> 0 === base);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

class HttpActionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HttpActionError';
    Object.assign(this, details);
  }
}

async function assertPublicUrl(urlString, allowPrivate) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new HttpActionError(`Invalid URL: ${urlString}`, { retryable: false });
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpActionError('Only http and https URLs are allowed', { retryable: false });
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => {
    throw new HttpActionError(`Could not resolve host ${host}`, { retryable: true });
  });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new HttpActionError(`Requests to private or internal addresses are blocked (${host})`, { retryable: false });
  }
  return url;
}

async function readLimited(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new HttpActionError(`Response exceeded ${MAX_RESPONSE_BYTES} bytes`, { retryable: false });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Performs an outbound request with SSRF protection, timeout, size limit and no automatic redirects to
// private addresses (redirects are followed manually and each hop is re-validated).
async function request({ method = 'GET', url, headers = {}, body, timeoutMs = 15000, allowPrivate = false }) {
  let target = url;
  let currentMethod = method.toUpperCase();
  let currentBody = body;
  for (let hop = 0; hop < 5; hop++) {
    const parsed = await assertPublicUrl(target, allowPrivate);
    const init = {
      method: currentMethod,
      headers: { 'user-agent': 'BusinessAutoPilot/1.0', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (currentBody !== undefined && currentBody !== null && !['GET', 'HEAD'].includes(currentMethod)) {
      if (typeof currentBody === 'string') init.body = currentBody;
      else {
        init.body = JSON.stringify(currentBody);
        if (!Object.keys(init.headers).some((h) => h.toLowerCase() === 'content-type')) init.headers['content-type'] = 'application/json';
      }
    }
    let response;
    try {
      response = await fetch(parsed, init);
    } catch (err) {
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      throw new HttpActionError(timedOut ? `Request timed out after ${timeoutMs}ms` : `Request failed: ${err.cause?.message || err.message}`, { retryable: true });
    }
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
      target = new URL(response.headers.get('location'), parsed).toString();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      continue;
    }
    const text = await readLimited(response);
    let parsedBody = text;
    if ((response.headers.get('content-type') || '').includes('json')) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = text;
      }
    }
    return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), body: parsedBody };
  }
  throw new HttpActionError('Too many redirects', { retryable: false });
}

module.exports = { request, isPrivateAddress, HttpActionError };
