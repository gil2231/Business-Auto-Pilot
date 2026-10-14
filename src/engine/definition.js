'use strict';

// Validation and normalization of workflow definitions (trigger + steps).

const { ACTIONS, CONTROL_TYPES } = require('./actions');
const { validateExpr } = require('./expr');
const { validateTemplate } = require('./template');
const cron = require('./cron');

const TRIGGER_TYPES = ['manual', 'webhook', 'schedule', 'event'];
const RESERVED_IDS = new Set(['end', 'fail', 'continue']);
const STEP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const EVENT_PATTERN = /^[a-z0-9_*]+(\.[a-z0-9_*]+)*$/i;
const MAX_STEPS = 100;

function normalizeTrigger(trigger, errors) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
    errors.push('trigger must be an object');
    return null;
  }
  const out = { type: trigger.type };
  if (!TRIGGER_TYPES.includes(trigger.type)) {
    errors.push(`trigger.type must be one of: ${TRIGGER_TYPES.join(', ')}`);
    return out;
  }
  if (trigger.type === 'schedule') {
    const err = cron.describeError(trigger.cron);
    if (err) errors.push(`trigger.cron: ${err}`);
    out.cron = typeof trigger.cron === 'string' ? trigger.cron.trim() : trigger.cron;
    out.timezone = trigger.timezone || 'UTC';
    if (!cron.isValidTimeZone(out.timezone)) errors.push(`trigger.timezone "${out.timezone}" is not a valid IANA time zone`);
  }
  if (trigger.type === 'event') {
    if (typeof trigger.event !== 'string' || !EVENT_PATTERN.test(trigger.event)) {
      errors.push('trigger.event must be an event name such as "contact.created" or "invoice.*"');
    }
    out.event = trigger.event;
  }
  if (trigger.filter !== undefined && trigger.filter !== null && trigger.filter !== '') {
    if (typeof trigger.filter !== 'string') errors.push('trigger.filter must be an expression string');
    else {
      const err = validateExpr(trigger.filter);
      if (err) errors.push(`trigger.filter: ${err}`);
    }
    out.filter = trigger.filter;
  }
  return out;
}

function normalizeStep(step, index, errors) {
  const where = `steps[${index}]`;
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  const out = { id: step.id, type: step.type };
  if (typeof step.id !== 'string' || !STEP_ID.test(step.id) || RESERVED_IDS.has(step.id)) {
    errors.push(`${where}.id must start with a letter, use only letters, numbers, "-" or "_", and not be end/fail/continue`);
  }
  if (step.name !== undefined) out.name = String(step.name).slice(0, 200);
  const isControl = Object.hasOwn(CONTROL_TYPES, step.type);
  const action = Object.hasOwn(ACTIONS, step.type) ? ACTIONS[step.type] : null;
  if (!isControl && !action) {
    errors.push(`${where}.type "${step.type}" is not a known step type`);
    return out;
  }

  if (step.type === 'condition') {
    if (typeof step.if !== 'string' || !step.if.trim()) errors.push(`${where}.if is required for condition steps`);
    else {
      const err = validateExpr(step.if);
      if (err) errors.push(`${where}.if: ${err}`);
    }
    out.if = step.if;
    if (step.then !== undefined) out.then = step.then;
    if (step.else !== undefined) out.else = step.else;
  } else if (step.type === 'goto') {
    if (typeof step.next !== 'string') errors.push(`${where}.next is required for goto steps`);
  } else {
    const params = step.params === undefined ? {} : step.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      errors.push(`${where}.params must be an object`);
    } else {
      for (const [name, spec] of Object.entries(action.params || {})) {
        if (spec.required && (params[name] === undefined || params[name] === null || params[name] === '')) {
          errors.push(`${where}.params.${name} is required for ${step.type}`);
        }
      }
      for (const e of validateTemplate(params, `${where}.params`)) errors.push(e);
    }
    out.params = params;
  }

  if (step.next !== undefined) out.next = step.next;
  if (step.when !== undefined) {
    const err = typeof step.when === 'string' ? validateExpr(step.when) : 'must be an expression string';
    if (err) errors.push(`${where}.when: ${err}`);
    out.when = step.when;
  }
  if (step.retry !== undefined) {
    const r = step.retry;
    if (!r || typeof r !== 'object') errors.push(`${where}.retry must be an object`);
    else {
      const max = r.max ?? 0;
      const backoffMs = r.backoffMs ?? 2000;
      if (!Number.isInteger(max) || max < 0 || max > 10) errors.push(`${where}.retry.max must be an integer from 0 to 10`);
      if (!Number.isFinite(backoffMs) || backoffMs < 100 || backoffMs > 24 * 3600000) errors.push(`${where}.retry.backoffMs must be between 100 and 86400000`);
      out.retry = { max, backoffMs };
    }
  }
  if (step.onError !== undefined) {
    if (typeof step.onError !== 'string') errors.push(`${where}.onError must be "fail", "continue" or a step id`);
    out.onError = step.onError;
  }
  return out;
}

// Returns { trigger, steps } or throws an error carrying a list of messages.
function validateDefinition({ trigger, steps }) {
  const errors = [];
  const normTrigger = normalizeTrigger(trigger, errors);
  let normSteps = [];
  if (!Array.isArray(steps)) errors.push('steps must be an array');
  else if (steps.length === 0) errors.push('A workflow needs at least one step');
  else if (steps.length > MAX_STEPS) errors.push(`A workflow may have at most ${MAX_STEPS} steps`);
  else normSteps = steps.map((s, i) => normalizeStep(s, i, errors));

  const ids = new Set();
  for (const s of normSteps) {
    if (!s || typeof s.id !== 'string') continue;
    if (ids.has(s.id)) errors.push(`Duplicate step id "${s.id}"`);
    ids.add(s.id);
  }
  const checkRef = (s, field, value, allowFlow) => {
    if (value === undefined) return;
    if (typeof value !== 'string') {
      errors.push(`Step "${s.id}" ${field} must be a step id`);
      return;
    }
    if (value === 'end' || (allowFlow && (value === 'fail' || value === 'continue'))) return;
    if (!ids.has(value)) errors.push(`Step "${s.id}" ${field} refers to unknown step "${value}"`);
  };
  for (const s of normSteps) {
    if (!s) continue;
    checkRef(s, 'next', s.next, false);
    checkRef(s, 'then', s.then, false);
    checkRef(s, 'else', s.else, false);
    checkRef(s, 'onError', s.onError, true);
  }
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    err.errors = errors;
    throw err;
  }
  return { trigger: normTrigger, steps: normSteps };
}

// Shell-style glob for event names: "invoice.*" matches "invoice.paid"; "*" matches everything.
function eventMatches(pattern, type) {
  if (pattern === '*' || pattern === type) return true;
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^]*')}$`, 'i');
  return re.test(type);
}

module.exports = { validateDefinition, eventMatches, TRIGGER_TYPES };
