'use strict';

// A small, sandboxed expression language used for conditions, filters and templating.
// It never calls eval/Function, only reads own properties, and exposes a fixed set of helper functions.
//
//   trigger.amount > 1000 && endsWith(lower(trigger.email), "@acme.com")
//   steps.lookup.body.items[0].name
//   trigger.stage == "won" ? "Customer" : "Prospect"

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_EXPR_LENGTH = 4000;
const MAX_DEPTH = 64;

class ExprError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExprError';
  }
}

// ---------- tokenizer ----------

const PUNCT = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '??', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', '[', ']', '.', ',', '?', ':'];

function tokenize(src) {
  if (typeof src !== 'string') throw new ExprError('Expression must be a string');
  if (src.length > MAX_EXPR_LENGTH) throw new ExprError('Expression is too long');
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      tokens.push({ type: 'num', value: Number(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\') {
          const next = src[j + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" };
          if (next === undefined) break;
          out += map[next] !== undefined ? map[next] : next;
          j += 2;
        } else {
          out += src[j++];
        }
      }
      if (src[j] !== ch) throw new ExprError(`Unterminated string at position ${i}`);
      tokens.push({ type: 'str', value: out, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i));
      tokens.push({ type: 'ident', value: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const p = PUNCT.find((op) => src.startsWith(op, i));
    if (!p) throw new ExprError(`Unexpected character "${ch}" at position ${i}`);
    tokens.push({ type: 'op', value: p, pos: i });
    i += p.length;
  }
  tokens.push({ type: 'eof', pos: src.length });
  return tokens;
}

// ---------- parser (precedence climbing) ----------

const BINARY_PRECEDENCE = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4, '!=': 4, '===': 4, '!==': 4,
  '<': 5, '<=': 5, '>': 5, '>=': 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
};

function parse(src) {
  const tokens = tokenize(src);
  let pos = 0;
  let depth = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (v) => peek().type === 'op' && peek().value === v;
  const expect = (v) => {
    if (!isOp(v)) throw new ExprError(`Expected "${v}" at position ${peek().pos}`);
    return next();
  };
  const guard = () => {
    if (++depth > MAX_DEPTH) throw new ExprError('Expression is nested too deeply');
  };

  function parseExpression() {
    guard();
    const result = parseTernary();
    depth--;
    return result;
  }

  function parseTernary() {
    const test = parseBinary(1);
    if (isOp('?')) {
      next();
      const consequent = parseExpression();
      expect(':');
      const alternate = parseExpression();
      return { type: 'cond', test, consequent, alternate };
    }
    return test;
  }

  function parseBinary(minPrec) {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      const prec = t.type === 'op' ? BINARY_PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      next();
      const right = parseBinary(prec + 1);
      left = { type: 'bin', op: t.value, left, right };
    }
  }

  function parseUnary() {
    if (isOp('!') || isOp('-') || isOp('+')) {
      const op = next().value;
      guard();
      const argument = parseUnary();
      depth--;
      return { type: 'unary', op, argument };
    }
    return parsePostfix(parsePrimary());
  }

  function parsePostfix(node) {
    for (;;) {
      if (isOp('.')) {
        next();
        const t = next();
        if (t.type !== 'ident') throw new ExprError(`Expected property name at position ${t.pos}`);
        node = { type: 'member', object: node, property: { type: 'lit', value: t.value } };
      } else if (isOp('[')) {
        next();
        const property = parseExpression();
        expect(']');
        node = { type: 'member', object: node, property };
      } else {
        return node;
      }
    }
  }

  function parsePrimary() {
    const t = next();
    if (t.type === 'num' || t.type === 'str') return { type: 'lit', value: t.value };
    if (t.type === 'ident') {
      if (t.value === 'true') return { type: 'lit', value: true };
      if (t.value === 'false') return { type: 'lit', value: false };
      if (t.value === 'null') return { type: 'lit', value: null };
      if (t.value === 'undefined') return { type: 'lit', value: undefined };
      if (isOp('(')) {
        next();
        const args = [];
        if (!isOp(')')) {
          do {
            args.push(parseExpression());
          } while (isOp(',') && next());
        }
        expect(')');
        return { type: 'call', name: t.value, args };
      }
      return { type: 'ident', name: t.value };
    }
    if (t.type === 'op' && t.value === '(') {
      const inner = parseExpression();
      expect(')');
      return inner;
    }
    if (t.type === 'op' && t.value === '[') {
      const elements = [];
      if (!isOp(']')) {
        do {
          elements.push(parseExpression());
        } while (isOp(',') && next());
      }
      expect(']');
      return { type: 'array', elements };
    }
    if (t.type === 'eof') throw new ExprError('Unexpected end of expression');
    throw new ExprError(`Unexpected "${t.value}" at position ${t.pos}`);
  }

  const ast = parseExpression();
  if (peek().type !== 'eof') throw new ExprError(`Unexpected "${peek().value}" at position ${peek().pos}`);
  return ast;
}

// ---------- helpers ----------

const DAY_MS = 86400000;

function toDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string' && v) {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new ExprError(`Invalid date: ${JSON.stringify(v)}`);
}

const isoDay = (d) => d.toISOString().slice(0, 10);

const FUNCTIONS = {
  len: (v) => (v == null ? 0 : typeof v === 'string' || Array.isArray(v) ? v.length : typeof v === 'object' ? Object.keys(v).length : 0),
  lower: (v) => String(v ?? '').toLowerCase(),
  upper: (v) => String(v ?? '').toUpperCase(),
  trim: (v) => String(v ?? '').trim(),
  string: (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)),
  number: (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  },
  bool: (v) => Boolean(v),
  contains: (hay, needle) => {
    if (Array.isArray(hay)) return hay.includes(needle);
    return String(hay ?? '').toLowerCase().includes(String(needle ?? '').toLowerCase());
  },
  startsWith: (s, p) => String(s ?? '').startsWith(String(p ?? '')),
  endsWith: (s, p) => String(s ?? '').endsWith(String(p ?? '')),
  replace: (s, a, b) => String(s ?? '').split(String(a)).join(String(b ?? '')),
  split: (s, sep) => String(s ?? '').split(String(sep ?? ',')),
  join: (arr, sep) => (Array.isArray(arr) ? arr.join(sep === undefined ? ', ' : String(sep)) : String(arr ?? '')),
  first: (arr) => (Array.isArray(arr) ? arr[0] : undefined),
  last: (arr) => (Array.isArray(arr) ? arr[arr.length - 1] : undefined),
  sum: (arr, key) => {
    if (!Array.isArray(arr)) return 0;
    return arr.reduce((total, x) => {
      const n = Number(key ? readProp(x, key) : x);
      return Number.isFinite(n) ? total + n : total;
    }, 0);
  },
  pluck: (arr, key) => (Array.isArray(arr) ? arr.map((x) => readProp(x, key)) : []),
  keys: (o) => (o && typeof o === 'object' ? Object.keys(o) : []),
  round: (n, digits = 0) => {
    const f = 10 ** Number(digits);
    return Math.round(Number(n) * f) / f;
  },
  floor: (n) => Math.floor(Number(n)),
  ceil: (n) => Math.ceil(Number(n)),
  abs: (n) => Math.abs(Number(n)),
  min: (...a) => Math.min(...a.flat().map(Number)),
  max: (...a) => Math.max(...a.flat().map(Number)),
  coalesce: (...a) => a.find((x) => x !== null && x !== undefined && x !== ''),
  default: (v, fallback) => (v === null || v === undefined || v === '' ? fallback : v),
  isEmpty: (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && Object.keys(v).length === 0),
  matches: (s, pattern) => {
    const p = String(pattern);
    if (p.length > 200) throw new ExprError('Pattern too long');
    return new RegExp(p, 'i').test(String(s ?? ''));
  },
  isEmail: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s ?? '')),
  now: () => new Date().toISOString(),
  today: () => isoDay(new Date()),
  addDays: (d, n) => isoDay(new Date(toDate(d).getTime() + Number(n) * DAY_MS)),
  daysBetween: (a, b) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY_MS),
  daysUntil: (d) => Math.ceil((toDate(d).getTime() - Date.now()) / DAY_MS),
  date: (d) => isoDay(toDate(d)),
  formatMoney: (cents, currency = 'USD') =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency) }).format(Number(cents || 0) / 100),
  json: (v) => JSON.stringify(v),
};

// ---------- evaluator ----------

function readProp(obj, key) {
  if (obj === null || obj === undefined) return undefined;
  if (typeof key !== 'string' && typeof key !== 'number') throw new ExprError('Invalid property key');
  const k = String(key);
  if (FORBIDDEN_KEYS.has(k)) throw new ExprError(`Access to "${k}" is not allowed`);
  if (typeof obj === 'string') {
    if (k === 'length') return obj.length;
    return /^\d+$/.test(k) ? obj[Number(k)] : undefined;
  }
  if (typeof obj !== 'object') return undefined;
  if (Array.isArray(obj) && k === 'length') return obj.length;
  return Object.hasOwn(obj, k) ? obj[k] : undefined;
}

function looseEquals(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a);
    const nb = Number(b);
    return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb && typeof a !== 'object' && typeof b !== 'object';
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  return false;
}

function evaluate(node, scope) {
  switch (node.type) {
    case 'lit':
      return node.value;
    case 'ident':
      return readProp(scope, node.name);
    case 'array':
      return node.elements.map((e) => evaluate(e, scope));
    case 'member':
      return readProp(evaluate(node.object, scope), evaluate(node.property, scope));
    case 'unary': {
      const v = evaluate(node.argument, scope);
      if (node.op === '!') return !v;
      if (node.op === '-') return -Number(v);
      return Number(v);
    }
    case 'cond':
      return evaluate(node.test, scope) ? evaluate(node.consequent, scope) : evaluate(node.alternate, scope);
    case 'call': {
      if (!Object.hasOwn(FUNCTIONS, node.name)) throw new ExprError(`Unknown function "${node.name}"`);
      return FUNCTIONS[node.name](...node.args.map((a) => evaluate(a, scope)));
    }
    case 'bin': {
      const { op } = node;
      if (op === '&&') return evaluate(node.left, scope) && evaluate(node.right, scope);
      if (op === '||') return evaluate(node.left, scope) || evaluate(node.right, scope);
      if (op === '??') return evaluate(node.left, scope) ?? evaluate(node.right, scope);
      const l = evaluate(node.left, scope);
      const r = evaluate(node.right, scope);
      switch (op) {
        case '==': return looseEquals(l, r);
        case '!=': return !looseEquals(l, r);
        case '===': return l === r;
        case '!==': return l !== r;
        case '<': return compare(l, r) < 0;
        case '<=': return compare(l, r) <= 0;
        case '>': return compare(l, r) > 0;
        case '>=': return compare(l, r) >= 0;
        case '+':
          if (typeof l === 'string' || typeof r === 'string') return `${l ?? ''}${r ?? ''}`;
          return Number(l) + Number(r);
        case '-': return Number(l) - Number(r);
        case '*': return Number(l) * Number(r);
        case '/': return Number(r) === 0 ? null : Number(l) / Number(r);
        case '%': return Number(r) === 0 ? null : Number(l) % Number(r);
        default: throw new ExprError(`Unknown operator ${op}`);
      }
    }
    default:
      throw new ExprError(`Unknown node ${node.type}`);
  }
}

// Numbers compare numerically (numeric strings included); otherwise compare as strings. Missing values sort low.
function compare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb) && typeof a !== 'object' && typeof b !== 'object') {
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

const astCache = new Map();
function compile(src) {
  let ast = astCache.get(src);
  if (!ast) {
    ast = parse(src);
    if (astCache.size > 2000) astCache.clear();
    astCache.set(src, ast);
  }
  return ast;
}

function evalExpr(src, scope) {
  return evaluate(compile(src), scope || {});
}

function validateExpr(src) {
  try {
    compile(src);
    return null;
  } catch (err) {
    return err.message;
  }
}

module.exports = { evalExpr, validateExpr, ExprError, FUNCTIONS: Object.keys(FUNCTIONS) };
