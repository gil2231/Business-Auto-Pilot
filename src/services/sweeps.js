'use strict';

// Background "autopilot" sweeps: detect time-based business conditions (overdue invoices, overdue tasks)
// and publish events for them, plus routine data housekeeping. Every sweep is idempotent.

const records = require('./records');

function today(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function markOverdueInvoices(app, now = Date.now()) {
  const due = app.db.all("SELECT id, org_id FROM invoices WHERE status = 'sent' AND due_date IS NOT NULL AND due_date < ?", today(now));
  for (const inv of due) {
    try {
      records.setInvoiceStatus(app, inv.org_id, inv.id, 'overdue', { actor: 'autopilot' });
    } catch (err) {
      app.logger?.warn?.(`[sweeps] could not mark invoice ${inv.id} overdue: ${err.message}`);
    }
  }
  return due.length;
}

function notifyOverdueTasks(app, now = Date.now()) {
  const due = app.db.all(
    "SELECT id, org_id FROM tasks WHERE status IN ('open','in_progress') AND due_date IS NOT NULL AND due_date < ? AND overdue_notified_at IS NULL",
    today(now),
  );
  for (const t of due) {
    app.db.transaction(() => {
      const res = app.db.run('UPDATE tasks SET overdue_notified_at = ? WHERE id = ? AND overdue_notified_at IS NULL', now, t.id);
      if (res.changes === 1) app.events.emit(t.org_id, 'task.overdue', records.getTask(app, t.org_id, t.id));
    });
  }
  return due.length;
}

function housekeeping(app, now = Date.now()) {
  app.db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  const cutoff = now - app.config.runRetentionDays * 86400000;
  app.db.run("DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < ? AND status IN ('succeeded','failed','cancelled')", cutoff);
}

function runAll(app, now = Date.now()) {
  const invoices = markOverdueInvoices(app, now);
  const tasks = notifyOverdueTasks(app, now);
  housekeeping(app, now);
  return { invoices, tasks };
}

function start(app, intervalMs = 60000) {
  const tick = () => {
    try {
      runAll(app);
    } catch (err) {
      (app.logger || console).error('[sweeps] failed', err);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { runAll, start, markOverdueInvoices, notifyOverdueTasks };
