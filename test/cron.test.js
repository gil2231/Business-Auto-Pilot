'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nextRun, parseCron, describeError } = require('../src/engine/cron');

const at = (s) => Date.parse(s);
const iso = (ms) => new Date(ms).toISOString();

test('basic schedules in UTC', () => {
  assert.equal(iso(nextRun('*/15 * * * *', at('2026-03-01T10:07:30Z'))), '2026-03-01T10:15:00.000Z');
  assert.equal(iso(nextRun('0 9 * * 1-5', at('2026-03-06T09:00:00Z'))), '2026-03-09T09:00:00.000Z'); // Fri 09:00 -> Mon
  assert.equal(iso(nextRun('@monthly', at('2026-03-15T00:00:00Z'))), '2026-04-01T00:00:00.000Z');
  assert.equal(iso(nextRun('0 0 29 2 *', at('2026-03-01T00:00:00Z'))), '2028-02-29T00:00:00.000Z');
  assert.equal(iso(nextRun('30 8 * JAN,JUL MON', at('2026-01-01T00:00:00Z'))), '2026-01-05T08:30:00.000Z');
  assert.equal(iso(nextRun('0 12 * * 7', at('2026-03-01T13:00:00Z'))), '2026-03-08T12:00:00.000Z'); // 7 == Sunday
});

test('day-of-month and day-of-week are OR-ed when both restricted', () => {
  // 13th of the month OR any Friday
  assert.equal(iso(nextRun('0 0 13 * 5', at('2026-03-01T00:00:00Z'))), '2026-03-06T00:00:00.000Z');
});

test('time zones and DST', () => {
  // 09:00 New York in winter is 14:00 UTC, in summer 13:00 UTC.
  assert.equal(iso(nextRun('0 9 * * *', at('2026-01-10T00:00:00Z'), 'America/New_York')), '2026-01-10T14:00:00.000Z');
  assert.equal(iso(nextRun('0 9 * * *', at('2026-07-10T00:00:00Z'), 'America/New_York')), '2026-07-10T13:00:00.000Z');
  // Across the spring-forward night midnight jobs still fire on the right local day.
  assert.equal(iso(nextRun('30 0 * * *', at('2026-03-08T06:00:00Z'), 'America/New_York')), '2026-03-09T04:30:00.000Z');
  assert.equal(iso(nextRun('0 8 * * *', at('2026-03-29T00:00:00Z'), 'Europe/London')), '2026-03-29T07:00:00.000Z');
});

test('invalid expressions are rejected with helpful messages', () => {
  assert.match(describeError('* * *'), /5 fields/);
  assert.match(describeError('60 * * * *'), /out of range/);
  assert.match(describeError('*/0 * * * *'), /Invalid step/);
  assert.match(describeError('5-1 * * * *'), /Invalid range/);
  assert.equal(describeError('0 9 * * mon-fri'), null);
  assert.ok(parseCron('@daily').minute.has(0));
});
