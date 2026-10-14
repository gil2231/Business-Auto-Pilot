'use strict';

// Durable workflow engine.
//
// Runs are rows in the `runs` table. A worker loop claims due runs (queued, or waiting with next_run_at in
// the past), executes steps one by one and checkpoints the run context after every step. Delays,
// approvals and retries park the run with a future next_run_at, so nothing is held in memory and a restart
// resumes exactly where it left off. A step interrupted by a crash is re-executed (at-least-once).

const { newId, parseJson } = require('../db');
const { ACTIONS } = require('./actions');
const { render } = require('./template');
const { evalExpr } = require('./expr');
const { eventMatches } = require('./definition');
const cron = require('./cron');
const audit = require('../services/audit');

const SUSPEND = Symbol('suspend');
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function safeJson(value) {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function truncate(value, max = 20000) {
  const s = safeJson(value);
  if (s === undefined) return null;
  return s.length > max ? `${s.slice(0, max)}…(truncated)` : s;
}

class Engine {
  constructor(app, { now = () => Date.now(), logger = console } = {}) {
    this.app = app;
    this.now = now;
    this.logger = logger;
    this.active = new Set();
    this.timer = null;
    this.scheduleTimer = null;
    this.stopped = true;
    this.idleWaiters = [];
    this.unsubscribe = app.events.subscribe((event) => this.handleEvent(event));
  }

  // ---------- enqueueing ----------

  enqueue(workflow, { triggerType, data = {}, event = null, idempotencyKey = null, depth = 0, delayMs = 0 }) {
    const { db } = this.app;
    if (idempotencyKey) {
      const existing = db.get('SELECT id, status FROM runs WHERE workflow_id = ? AND idempotency_key = ?', workflow.id, idempotencyKey);
      if (existing) return { id: existing.id, status: existing.status, duplicate: true };
    }
    const id = newId('run');
    const now = this.now();
    const definition = { name: workflow.name, trigger: parseJson(workflow.trigger, {}), steps: parseJson(workflow.steps, []) };
    const context = { trigger: data, event, vars: {}, steps: {}, state: {} };
    db.run(
      `INSERT INTO runs (id, org_id, workflow_id, workflow_version, definition, status, trigger_type, trigger_data, context,
                         current_step, next_run_at, event_depth, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, workflow.org_id, workflow.id, workflow.version, safeJson(definition), triggerType, truncate(data, 200000) ?? '{}',
      safeJson(context), definition.steps[0]?.id ?? null, now + delayMs, depth, idempotencyKey, now,
    );
    this.log(id, null, 'info', `Run queued (${triggerType})`);
    this.wake();
    return { id, status: 'queued', duplicate: false };
  }

  handleEvent(event) {
    const { db, config } = this.app;
    if (event.depth > config.maxEventDepth) {
      this.logger.warn(`[engine] dropping event ${event.type}: depth ${event.depth} exceeds limit (possible workflow loop)`);
      return;
    }
    const workflows = db.all(
      "SELECT * FROM workflows WHERE org_id = ? AND enabled = 1 AND json_extract(trigger, '$.type') = 'event'",
      event.orgId,
    );
    for (const wf of workflows) {
      const trigger = parseJson(wf.trigger, {});
      if (!trigger.event || !eventMatches(trigger.event, event.type)) continue;
      const eventInfo = { type: event.type, at: new Date(event.at).toISOString() };
      if (trigger.filter) {
        let pass = false;
        try {
          pass = Boolean(evalExpr(trigger.filter, { trigger: event.data, event: eventInfo }));
        } catch (err) {
          this.logger.warn(`[engine] filter error in workflow ${wf.id}: ${err.message}`);
        }
        if (!pass) continue;
      }
      this.enqueue(wf, { triggerType: 'event', data: event.data, event: eventInfo, depth: event.depth });
    }
  }

  // ---------- worker ----------

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.recoverInterrupted();
    this.tick();
    this.scheduleTimer = setInterval(() => this.safe(() => this.checkSchedules()), 15000);
    this.scheduleTimer.unref?.();
    this.safe(() => this.checkSchedules());
  }

  async stop({ timeoutMs = 10000 } = {}) {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.scheduleTimer);
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  safe(fn) {
    try {
      fn();
    } catch (err) {
      this.logger.error('[engine]', err);
    }
  }

  wake() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), 0);
  }

  tick() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    try {
      this.claimAndRun();
    } catch (err) {
      this.logger.error('[engine] tick failed', err);
    }
    this.timer = setTimeout(() => this.tick(), this.app.config.workerPollMs);
    this.timer.unref?.();
  }

  claimAndRun() {
    const { db, config } = this.app;
    const capacity = config.workerConcurrency - this.active.size;
    if (capacity <= 0) return;
    const due = db.all(
      `SELECT id FROM runs WHERE status IN ('queued','waiting') AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at LIMIT ?`,
      this.now(), capacity + this.active.size,
    );
    for (const { id } of due) {
      if (this.active.size >= config.workerConcurrency) break;
      if (this.active.has(id)) continue;
      const claimed = db.run(
        `UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?)
         WHERE id = ? AND status IN ('queued','waiting') AND next_run_at IS NOT NULL AND next_run_at <= ?`,
        this.now(), id, this.now(),
      );
      if (claimed.changes !== 1) continue;
      this.active.add(id);
      this.execute(id)
        .catch((err) => {
          this.logger.error(`[engine] run ${id} crashed`, err);
          this.finish(id, 'failed', `Internal error: ${err.message}`);
        })
        .finally(() => {
          this.active.delete(id);
          this.notifyIdle();
          this.wake();
        });
    }
  }

  // Runs left in "running" by a previous process are put back on the queue.
  recoverInterrupted() {
    const { db } = this.app;
    const stuck = db.all("SELECT id FROM runs WHERE status = 'running'");
    for (const { id } of stuck) {
      if (this.active.has(id)) continue;
      db.run("UPDATE runs SET status = 'queued', next_run_at = ? WHERE id = ? AND status = 'running'", this.now(), id);
      this.log(id, null, 'warn', 'Run was interrupted by a restart and has been resumed');
    }
  }

  // Resolves when no runs are executing and none are due. Used by tests and graceful shutdown.
  async drain({ timeoutMs = 10000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.claimAndRun();
      const due = this.app.db.get(
        "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','waiting') AND next_run_at IS NOT NULL AND next_run_at <= ?",
        this.now(),
      ).n;
      if (this.active.size === 0 && due === 0) return;
      if (Date.now() > deadline) throw new Error('Timed out waiting for workflow runs to finish');
      await new Promise((resolve) => {
        this.idleWaiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  }

  notifyIdle() {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  // ---------- execution ----------

  async execute(runId) {
    const { db, config } = this.app;
    const run = db.get('SELECT * FROM runs WHERE id = ?', runId);
    if (!run || run.status !== 'running') return;
    const definition = parseJson(run.definition, { steps: [] });
    const workflow = { id: run.workflow_id, name: definition.name, version: run.workflow_version };
    const steps = definition.steps;
    const byId = new Map(steps.map((s, i) => [s.id, { step: s, index: i }]));
    const ctx = parseJson(run.context, {});
    ctx.vars ||= {};
    ctx.steps ||= {};
    ctx.state ||= {};
    let stepId = run.current_step;
    let stepCount = run.step_count;
    let attempt = run.attempt;

    const scope = () => ({
      trigger: ctx.trigger,
      event: ctx.event,
      vars: ctx.vars,
      steps: ctx.steps,
      run: { id: run.id, workflowId: workflow.id, workflowName: workflow.name, attempt },
    });
    const defaultNext = (id) => steps[byId.get(id).index + 1]?.id ?? 'end';

    while (stepId && stepId !== 'end') {
      const entry = byId.get(stepId);
      if (!entry) return this.finish(runId, 'failed', `Step "${stepId}" does not exist`);
      if (stepCount >= config.maxStepsPerRun) {
        return this.finish(runId, 'failed', `Stopped after ${config.maxStepsPerRun} steps (possible infinite loop)`);
      }
      const current = db.get('SELECT status FROM runs WHERE id = ?', runId);
      if (!current || current.status !== 'running') return undefined; // cancelled meanwhile

      const { step } = entry;
      let next;
      let output;
      try {
        if (step.when && !evalExpr(step.when, scope())) {
          output = { skipped: true };
          this.log(runId, step.id, 'info', 'Skipped (when condition was false)');
        } else if (step.type === 'condition') {
          const result = Boolean(evalExpr(step.if, scope()));
          output = { result };
          next = result ? step.then : step.else;
          this.log(runId, step.id, 'info', `Condition is ${result}`);
        } else if (step.type === 'goto') {
          output = {};
          next = step.next;
        } else {
          const action = ACTIONS[step.type];
          const params = render(step.params || {}, scope());
          const state = (ctx.state[step.id] ||= {});
          const actionCtx = {
            app: this.app,
            orgId: run.org_id,
            run: { id: run.id },
            workflow,
            step,
            vars: ctx.vars,
            state,
            depth: run.event_depth,
            now: this.now,
            log: (level, message, data) => this.log(runId, step.id, level, message, data),
            suspend: (until) => ({ [SUSPEND]: true, until: until ?? null }),
          };
          const started = Date.now();
          output = await action.run(params, actionCtx);
          if (output && output[SUSPEND]) {
            this.checkpoint(runId, { status: 'waiting', context: ctx, currentStep: step.id, stepCount, attempt: 0, nextRunAt: output.until });
            this.log(runId, step.id, 'info', output.until ? `Waiting until ${new Date(output.until).toISOString()}` : 'Waiting for a decision');
            return undefined;
          }
          delete ctx.state[step.id];
          this.log(runId, step.id, 'info', `${step.name || step.type} completed in ${Date.now() - started}ms`, output);
        }
      } catch (err) {
        const retry = step.retry || { max: 0, backoffMs: 2000 };
        const retryable = err.retryable !== false && err.name !== 'ExprError';
        if (retryable && attempt < retry.max) {
          const delay = Math.min(retry.backoffMs * 2 ** attempt, 24 * 3600000);
          const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
          this.log(runId, step.id, 'warn', `Attempt ${attempt + 1} failed: ${err.message}. Retrying in ${Math.round(jittered / 1000)}s`);
          this.checkpoint(runId, { status: 'queued', context: ctx, currentStep: step.id, stepCount, attempt: attempt + 1, nextRunAt: this.now() + jittered });
          return undefined;
        }
        this.log(runId, step.id, 'error', err.message);
        const onError = step.onError || 'fail';
        delete ctx.state[step.id];
        if (onError === 'fail') {
          this.checkpoint(runId, { status: 'running', context: ctx, currentStep: step.id, stepCount, attempt });
          return this.finish(runId, 'failed', `Step "${step.name || step.id}" failed: ${err.message}`);
        }
        output = { error: err.message };
        next = onError === 'continue' ? undefined : onError;
      }

      ctx.steps[step.id] = output === undefined ? null : output;
      stepCount++;
      attempt = 0;
      stepId = next ?? step.next ?? defaultNext(step.id);
      this.checkpoint(runId, { status: 'running', context: ctx, currentStep: stepId, stepCount, attempt: 0 });
    }
    return this.finish(runId, 'succeeded', null);
  }

  checkpoint(runId, { status, context, currentStep, stepCount, attempt, nextRunAt = null }) {
    this.app.db.run(
      `UPDATE runs SET status = ?, context = ?, current_step = ?, step_count = ?, attempt = ?, next_run_at = ?
       WHERE id = ? AND status = 'running'`,
      status, truncate(context, 5_000_000), currentStep, stepCount, attempt, nextRunAt, runId,
    );
  }

  finish(runId, status, error) {
    const { db } = this.app;
    const res = db.run(
      "UPDATE runs SET status = ?, error = ?, finished_at = ?, next_run_at = NULL WHERE id = ? AND status = 'running'",
      status, error, this.now(), runId,
    );
    if (res.changes !== 1) return;
    this.log(runId, null, status === 'succeeded' ? 'info' : 'error', status === 'succeeded' ? 'Run succeeded' : `Run failed: ${error}`);
    if (status === 'failed') {
      const run = db.get('SELECT r.id, r.org_id, r.workflow_id, r.event_depth, w.name FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?', runId);
      if (run) {
        this.app.events.emit(run.org_id, 'workflow.failed', { runId, workflowId: run.workflow_id, workflowName: run.name, error }, { depth: run.event_depth + 1 });
      }
    }
  }

  log(runId, stepId, level, message, data) {
    this.app.db.run(
      'INSERT INTO run_logs (run_id, step_id, level, message, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      runId, stepId, level, String(message).slice(0, 2000), data === undefined ? null : truncate(data, 20000), this.now(),
    );
  }

  // ---------- run control ----------

  cancel(orgId, runId, actor) {
    const { db } = this.app;
    const res = db.run(
      "UPDATE runs SET status = 'cancelled', finished_at = ?, next_run_at = NULL, error = 'Cancelled by user' WHERE id = ? AND org_id = ? AND status IN ('queued','waiting','running')",
      this.now(), runId, orgId,
    );
    if (res.changes === 1) {
      db.run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE run_id = ? AND status = 'pending'", this.now(), runId);
      this.log(runId, null, 'warn', `Run cancelled by ${actor}`);
      audit.record(db, { orgId, actor, action: 'run.cancelled', entity: 'run', entityId: runId });
    }
    return res.changes === 1;
  }

  // Starts a fresh run with the same trigger data using the workflow's current definition.
  retry(orgId, runId, actor) {
    const { db } = this.app;
    const run = db.get('SELECT * FROM runs WHERE id = ? AND org_id = ?', runId, orgId);
    if (!run) return null;
    const wf = db.get('SELECT * FROM workflows WHERE id = ? AND org_id = ?', run.workflow_id, orgId);
    if (!wf) return null;
    const ctx = parseJson(run.context, {});
    const result = this.enqueue(wf, { triggerType: run.trigger_type, data: parseJson(run.trigger_data, {}), event: ctx.event || null });
    audit.record(db, { orgId, actor, action: 'run.retried', entity: 'run', entityId: runId, data: { newRunId: result.id } });
    return result;
  }

  decideApproval(orgId, approvalId, { approved, decidedBy, comment }) {
    const { db } = this.app;
    return db.transaction(() => {
      const approval = db.get('SELECT * FROM approvals WHERE id = ? AND org_id = ?', approvalId, orgId);
      if (!approval) return { error: 'not_found' };
      if (approval.status !== 'pending') return { error: 'already_decided', approval };
      const status = approved ? 'approved' : 'rejected';
      db.run(
        'UPDATE approvals SET status = ?, decided_by = ?, comment = ?, decided_at = ? WHERE id = ?',
        status, decidedBy, comment || null, this.now(), approvalId,
      );
      db.run("UPDATE runs SET next_run_at = ? WHERE id = ? AND status = 'waiting'", this.now(), approval.run_id);
      this.log(approval.run_id, approval.step_id, 'info', `${status === 'approved' ? 'Approved' : 'Rejected'} by ${decidedBy}${comment ? `: ${comment}` : ''}`);
      audit.record(db, { orgId, actor: decidedBy, action: `approval.${status}`, entity: 'approval', entityId: approvalId });
      const updated = db.get('SELECT * FROM approvals WHERE id = ?', approvalId);
      this.app.events.emit(orgId, 'approval.decided', { ...updated }, { depth: 1 });
      this.wake();
      return { approval: updated };
    });
  }

  // ---------- schedules ----------

  checkSchedules() {
    const { db } = this.app;
    const now = this.now();
    const workflows = db.all("SELECT * FROM workflows WHERE enabled = 1 AND json_extract(trigger, '$.type') = 'schedule'");
    for (const wf of workflows) {
      const trigger = parseJson(wf.trigger, {});
      const since = wf.last_scheduled_at ?? wf.updated_at;
      let due;
      try {
        due = cron.nextRun(trigger.cron, since, trigger.timezone || 'UTC');
      } catch (err) {
        this.logger.warn(`[engine] invalid schedule on workflow ${wf.id}: ${err.message}`);
        continue;
      }
      if (due === null || due > now) continue;
      // Missed slots while the server was down collapse into a single catch-up run.
      db.transaction(() => {
        const claimed = db.run(
          'UPDATE workflows SET last_scheduled_at = ? WHERE id = ? AND (last_scheduled_at IS ? OR last_scheduled_at = ?)',
          now, wf.id, wf.last_scheduled_at, wf.last_scheduled_at,
        );
        if (claimed.changes !== 1) return;
        this.enqueue(wf, {
          triggerType: 'schedule',
          data: { scheduledFor: new Date(due).toISOString(), firedAt: new Date(now).toISOString() },
          idempotencyKey: `schedule:${due}`,
        });
      });
    }
  }

  nextScheduledRun(workflow) {
    const trigger = typeof workflow.trigger === 'string' ? parseJson(workflow.trigger, {}) : workflow.trigger;
    if (!workflow.enabled || trigger?.type !== 'schedule') return null;
    try {
      const at = cron.nextRun(trigger.cron, Math.max(this.now(), workflow.last_scheduled_at ?? 0) - 1, trigger.timezone || 'UTC');
      return at ? new Date(at).toISOString() : null;
    } catch {
      return null;
    }
  }
}

module.exports = { Engine, TERMINAL };
