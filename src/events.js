'use strict';

// In-process event bus. Domain changes (contact.created, invoice.paid, ...) are published here and the
// workflow engine subscribes to start event-triggered workflows. Handlers run synchronously so that the
// runs they enqueue are written in the same database transaction as the change that caused them.
class EventBus {
  constructor(logger = console) {
    this.handlers = [];
    this.logger = logger;
  }

  subscribe(handler) {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  emit(orgId, type, data = {}, meta = {}) {
    const event = { orgId, type, data, depth: meta.depth || 0, at: Date.now() };
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        this.logger.error(`[events] handler failed for ${type}:`, err);
      }
    }
    return event;
  }
}

const EVENT_TYPES = [
  'contact.created',
  'contact.updated',
  'contact.stage_changed',
  'task.created',
  'task.completed',
  'task.overdue',
  'invoice.created',
  'invoice.sent',
  'invoice.paid',
  'invoice.overdue',
  'invoice.voided',
  'approval.decided',
  'workflow.failed',
];

module.exports = { EventBus, EVENT_TYPES };
