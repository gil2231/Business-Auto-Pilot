'use strict';

class ValidationError extends Error {
  constructor(errors) {
    super(Array.isArray(errors) ? errors.join('; ') : String(errors));
    this.name = 'ValidationError';
    this.status = 400;
    this.errors = Array.isArray(errors) ? errors : [String(errors)];
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Schema: { field: { type, required, nullable, max, min, enum, format, items, default } }
// Unknown fields are dropped. With { partial: true } required checks and defaults are skipped (PATCH semantics).
function check(schema, input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Request body must be a JSON object');
  const out = {};
  const errors = [];
  for (const [key, rule] of Object.entries(schema)) {
    let value = input[key];
    const present = Object.hasOwn(input, key) && value !== undefined;
    if (!present) {
      if (partial) continue;
      if (rule.required) {
        errors.push(`${key} is required`);
        continue;
      }
      if (rule.default !== undefined) out[key] = typeof rule.default === 'function' ? rule.default() : rule.default;
      continue;
    }
    if (value === null || (value === '' && rule.type !== 'string')) {
      // Only fields that are explicitly optional-and-clearable accept null.
      if (rule.required) errors.push(`${key} is required`);
      else if (rule.nullable || rule.emptyAsNull) out[key] = null;
      else errors.push(`${key} cannot be empty`);
      continue;
    }
    const err = checkValue(key, value, rule);
    if (typeof err === 'string') errors.push(err);
    else {
      value = err.value;
      if (rule.required && value === '') errors.push(`${key} is required`);
      else out[key] = rule.type === 'string' && value === '' && rule.emptyAsNull ? null : value;
    }
  }
  if (errors.length) throw new ValidationError(errors);
  return out;
}

function checkValue(key, value, rule) {
  switch (rule.type) {
    case 'string': {
      if (typeof value !== 'string') return `${key} must be a string`;
      const v = rule.trim === false ? value : value.trim();
      if (rule.max && v.length > rule.max) return `${key} must be at most ${rule.max} characters`;
      if (rule.min && v.length < rule.min) return `${key} must be at least ${rule.min} characters`;
      if (rule.enum && !rule.enum.includes(v)) return `${key} must be one of: ${rule.enum.join(', ')}`;
      if (v !== '' && rule.format === 'email' && !EMAIL.test(v)) return `${key} must be a valid email address`;
      if (v !== '' && rule.format === 'date' && !isValidDate(v)) return `${key} must be a date in YYYY-MM-DD format`;
      if (v !== '' && rule.format === 'url') {
        try {
          const u = new URL(v);
          if (!['http:', 'https:'].includes(u.protocol)) return `${key} must be an http(s) URL`;
        } catch {
          return `${key} must be a valid URL`;
        }
      }
      if (rule.pattern && !rule.pattern.test(v)) return `${key} has an invalid format`;
      return { value: rule.format === 'email' ? v.toLowerCase() : v };
    }
    case 'integer':
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return `${key} must be a number`;
      if (rule.type === 'integer' && !Number.isInteger(n)) return `${key} must be an integer`;
      if (rule.min !== undefined && n < rule.min) return `${key} must be at least ${rule.min}`;
      if (rule.max !== undefined && n > rule.max) return `${key} must be at most ${rule.max}`;
      return { value: n };
    }
    case 'boolean':
      if (typeof value !== 'boolean') return `${key} must be true or false`;
      return { value };
    case 'array': {
      if (!Array.isArray(value)) return `${key} must be an array`;
      if (rule.max && value.length > rule.max) return `${key} may have at most ${rule.max} items`;
      if (!rule.items) return { value };
      const out = [];
      for (let i = 0; i < value.length; i++) {
        const r = checkValue(`${key}[${i}]`, value[i], rule.items);
        if (typeof r === 'string') return r;
        out.push(r.value);
      }
      return { value: out };
    }
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) return `${key} must be an object`;
      if (rule.schema) {
        try {
          return { value: check(rule.schema, value) };
        } catch (e) {
          return `${key}: ${e.message}`;
        }
      }
      return { value };
    case 'any':
      return { value };
    default:
      throw new Error(`Unknown rule type ${rule.type}`);
  }
}

module.exports = { check, ValidationError, isValidDate, EMAIL };
