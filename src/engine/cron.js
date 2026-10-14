'use strict';

// Standard 5-field cron: minute hour day-of-month month day-of-week, evaluated in an IANA time zone.
// Supports *, lists (1,2), ranges (1-5), steps (*/15, 0-30/5), month/day names and @hourly-style macros.
// When both day-of-month and day-of-week are restricted, a time matches if EITHER matches (Vixie cron semantics).

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], offset: 1 },
  { name: 'day of week', min: 0, max: 7, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], offset: 0 },
];

function parseValue(token, field) {
  const upper = token.toUpperCase();
  if (field.names) {
    const idx = field.names.indexOf(upper);
    if (idx !== -1) return idx + field.offset;
  }
  if (!/^\d+$/.test(token)) throw new Error(`Invalid ${field.name} value "${token}"`);
  const n = Number(token);
  if (n < field.min || n > field.max) throw new Error(`${field.name} value ${n} is out of range ${field.min}-${field.max}`);
  return n;
}

function parseField(text, field) {
  const values = new Set();
  for (const part of text.split(',')) {
    if (part === '') throw new Error(`Empty list item in ${field.name}`);
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`Invalid step in ${field.name}: "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) throw new Error(`Invalid step in ${field.name}: "${part}"`);
      step = Number(stepPart);
    }
    let lo;
    let hi;
    if (rangePart === '*') {
      lo = field.min;
      hi = field.max === 7 ? 6 : field.max;
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-');
      if (more !== undefined) throw new Error(`Invalid range in ${field.name}: "${part}"`);
      lo = parseValue(a, field);
      hi = parseValue(b, field);
      if (lo > hi) throw new Error(`Invalid range in ${field.name}: "${part}"`);
    } else {
      lo = parseValue(rangePart, field);
      hi = stepPart !== undefined ? (field.max === 7 ? 6 : field.max) : lo;
    }
    for (let v = lo; v <= hi; v += step) values.add(field.max === 7 && v === 7 ? 0 : v);
  }
  return values;
}

function parseCron(expression) {
  if (typeof expression !== 'string' || !expression.trim()) throw new Error('Cron expression is required');
  const expr = MACROS[expression.trim().toLowerCase()] || expression.trim();
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron expression must have 5 fields: minute hour day-of-month month day-of-week');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

const formatterCache = new Map();
function getFormatter(timeZone) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function localParts(ms, timeZone) {
  const parts = {};
  for (const p of getFormatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dow: WEEKDAYS[parts.weekday],
  };
}

function isValidTimeZone(tz) {
  try {
    getFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(c, p) {
  const domOk = c.dom.has(p.day);
  const dowOk = c.dow.has(p.dow);
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

const MINUTE = 60000;

// Next matching minute strictly after `afterMs`. Walks forward skipping whole days/hours that cannot match,
// which keeps the search fast and correct across DST transitions (we always test real instants).
function nextRun(expression, afterMs, timeZone = 'UTC') {
  const c = typeof expression === 'string' ? parseCron(expression) : expression;
  let t = Math.floor(afterMs / MINUTE) * MINUTE + MINUTE;
  const limit = afterMs + 5 * 366 * 24 * 60 * MINUTE;
  while (t <= limit) {
    const p = localParts(t, timeZone);
    if (!c.month.has(p.month) || !dayMatches(c, p)) {
      // Jump to 23:00 local (or the next hour if already there). Stopping short of midnight means a
      // 23-hour DST day can never make us overshoot into the following day's early hours.
      t += p.hour < 23 ? ((22 - p.hour) * 60 + (60 - p.minute)) * MINUTE : (60 - p.minute) * MINUTE;
      continue;
    }
    if (!c.hour.has(p.hour)) {
      t += (60 - p.minute) * MINUTE;
      continue;
    }
    if (!c.minute.has(p.minute)) {
      t += MINUTE;
      continue;
    }
    return t;
  }
  return null;
}

function describeError(expression) {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return err.message;
  }
}

module.exports = { parseCron, nextRun, isValidTimeZone, describeError };
