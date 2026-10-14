'use strict';

const { evalExpr, validateExpr } = require('./expr');

// "{{ expr }}" placeholders inside strings. A string that is exactly one placeholder keeps the value's
// type (so "{{ trigger.amount }}" yields a number); otherwise values are stringified into the text.
const PLACEHOLDER = /\{\{([\s\S]+?)\}\}/g;
const WHOLE = /^\{\{([\s\S]+?)\}\}$/;
const MAX_TEMPLATE_DEPTH = 20;

function stringify(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function renderString(str, scope) {
  const whole = WHOLE.exec(str);
  if (whole && !whole[1].includes('}}')) return evalExpr(whole[1].trim(), scope);
  return str.replace(PLACEHOLDER, (_, expr) => stringify(evalExpr(expr.trim(), scope)));
}

function render(value, scope, depth = 0) {
  if (depth > MAX_TEMPLATE_DEPTH) throw new Error('Template is nested too deeply');
  if (typeof value === 'string') return renderString(value, scope);
  if (Array.isArray(value)) return value.map((v) => render(v, scope, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = render(v, scope, depth + 1);
    return out;
  }
  return value;
}

// Returns a list of error messages for every invalid placeholder in a value tree.
function validateTemplate(value, path = 'params', errors = []) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PLACEHOLDER)) {
      const err = validateExpr(m[1].trim());
      if (err) errors.push(`${path}: ${err}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => validateTemplate(v, `${path}[${i}]`, errors));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) validateTemplate(v, `${path}.${k}`, errors);
  }
  return errors;
}

module.exports = { render, validateTemplate };
