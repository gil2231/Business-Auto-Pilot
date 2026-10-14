'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evalExpr, validateExpr } = require('../src/engine/expr');
const { render, validateTemplate } = require('../src/engine/template');

const scope = {
  trigger: { name: 'Ada Lovelace', amount: 1500, email: 'ADA@Example.com', tags: ['vip', 'b2b'], items: [{ p: 2 }, { p: 3 }], nested: { a: { b: 7 } } },
  steps: { check: { status: 'overdue' } },
};

test('arithmetic, comparison and logic', () => {
  assert.equal(evalExpr('1 + 2 * 3', scope), 7);
  assert.equal(evalExpr('(1 + 2) * 3', scope), 9);
  assert.equal(evalExpr('10 % 4', scope), 2);
  assert.equal(evalExpr('-trigger.amount', scope), -1500);
  assert.equal(evalExpr('trigger.amount > 1000 && trigger.amount <= 1500', scope), true);
  assert.equal(evalExpr('!true || false', scope), false);
  assert.equal(evalExpr("'5' == 5", scope), true);
  assert.equal(evalExpr("'5' === 5", scope), false);
  assert.equal(evalExpr("'10' > 9", scope), true);
  assert.equal(evalExpr('1 / 0', scope), null);
});

test('member access, ternary and nullish', () => {
  assert.equal(evalExpr('trigger.nested.a.b', scope), 7);
  assert.equal(evalExpr("trigger['name']", scope), 'Ada Lovelace');
  assert.equal(evalExpr('trigger.tags[1]', scope), 'b2b');
  assert.equal(evalExpr('trigger.tags.length', scope), 2);
  assert.equal(evalExpr('trigger.missing.deep', scope), undefined);
  assert.equal(evalExpr('trigger.missing ?? "fallback"', scope), 'fallback');
  assert.equal(evalExpr("steps.check.status == 'overdue' ? 'chase' : 'ok'", scope), 'chase');
  assert.deepEqual(evalExpr('[1, "a", true]', scope), [1, 'a', true]);
});

test('helper functions', () => {
  assert.equal(evalExpr('lower(trigger.email)', scope), 'ada@example.com');
  assert.equal(evalExpr('first(split(trigger.name, " "))', scope), 'Ada');
  assert.equal(evalExpr('contains(trigger.tags, "vip")', scope), true);
  assert.equal(evalExpr('sum(trigger.items, "p")', scope), 5);
  assert.equal(evalExpr('sum([5, -5, 3])', scope), 3);
  assert.equal(evalExpr('join(pluck(trigger.items, "p"), "+")', scope), '2+3');
  assert.equal(evalExpr('isEmail(trigger.email)', scope), true);
  assert.equal(evalExpr('formatMoney(123456, "USD")', scope), '$1,234.56');
  assert.equal(evalExpr('addDays("2026-01-30", 3)', scope), '2026-02-02');
  assert.equal(evalExpr('daysBetween("2026-01-01", "2026-01-31")', scope), 30);
  assert.equal(evalExpr('default("", "x")', scope), 'x');
  assert.equal(evalExpr('round(2.345, 2)', scope), 2.35);
});

test('sandbox blocks prototype access and unknown functions', () => {
  assert.throws(() => evalExpr('trigger.__proto__', scope), /not allowed/);
  assert.throws(() => evalExpr('trigger.constructor', scope), /not allowed/);
  assert.throws(() => evalExpr("trigger['constructor']['constructor']('return process')()", scope), /not allowed|Unexpected/);
  assert.throws(() => evalExpr('process.exit(1)', scope), /Unknown function|Unexpected/);
  assert.throws(() => evalExpr('eval("1")', scope), /Unknown function/);
  assert.equal(evalExpr('trigger.toString', scope), undefined);
  assert.equal(evalExpr('trigger.hasOwnProperty', scope), undefined);
});

test('syntax errors are reported', () => {
  assert.match(validateExpr('1 +'), /Unexpected end/);
  assert.match(validateExpr('"unterminated'), /Unterminated/);
  assert.match(validateExpr('a ; b'), /Unexpected character/);
  assert.equal(validateExpr('a.b == 1'), null);
});

test('templates keep types for whole placeholders and interpolate otherwise', () => {
  assert.equal(render('{{ trigger.amount }}', scope), 1500);
  assert.equal(render('Total: {{ trigger.amount }}', scope), 'Total: 1500');
  assert.equal(render('{{ trigger.missing }}', scope), undefined);
  assert.equal(render('x{{ trigger.missing }}y', scope), 'xy');
  assert.deepEqual(render({ a: ['{{ trigger.tags }}'], b: { c: 'Hi {{ upper(trigger.name) }}' } }, scope), {
    a: [['vip', 'b2b']],
    b: { c: 'Hi ADA LOVELACE' },
  });
  assert.deepEqual(validateTemplate({ x: 'ok {{ 1 + }}' }), ['params.x: Unexpected end of expression']);
});
