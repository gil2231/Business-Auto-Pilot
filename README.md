# Business Auto-Pilot

Self-hosted workflow automation for small and mid-sized businesses. It combines a CRM, tasks, invoicing and approvals with a durable workflow engine, so routine follow-up runs without anyone having to remember it.

- **Zero runtime dependencies.** Runs on Node.js 22+ with its built-in SQLite. There is no `npm install`, no external database and no supply-chain surface.
- **One process, one file of data.** Back up a single `.db` file. Deploy with Docker or `node`.

## What it does out of the box

| Area | Features |
| --- | --- |
| **CRM** | Contacts with pipeline stages, deal values, tags and owners. List and drag-and-drop board views. |
| **Tasks** | Priorities, assignees, due dates and overdue detection. Can be linked to contacts. |
| **Invoicing** | Line items, automatic numbering (`INV-0001`), draft → sent → overdue → paid/void lifecycle, reminder counting. |
| **Approvals** | Workflows pause for a human decision, with optional expiry. There's an inbox for approve/reject with comments. |
| **Automations** | Visual builder (or raw JSON) with event, schedule (cron and time zone), webhook and manual triggers. |
| **Dashboard** | Pipeline, outstanding and overdue cash, revenue trend, task load, automation health and an estimate of hours saved. |
| **Team & security** | Owner/admin/member roles, API keys, an audit log, rate limiting, CSRF protection, strict CSP and SSRF protection. |

### Ready-made automation templates

1. **Speed-to-lead:** a welcome email and a call task for every new lead.
2. **Overdue invoice collection:** a reminder, a 7-day wait, a re-check, a second notice, then escalation to a person.
3. **Won deal → onboarding:** a welcome email, kickoff and 30-day tasks, and a draft invoice for the deal value.
4. **Large deal approval:** manager sign-off before pricing goes out, branching on the decision.
5. **Monday business digest:** pipeline, cash and overdue work in one email.
6. **Website form → CRM:** a webhook for any site form. It dedupes contacts and creates a follow-up task.
7. **Payment received → thank you:** a receipt email and tags the customer.
8. **Automation failure alerts:** emails an admin when any workflow fails.

## Quick start

```bash
npm start            # http://localhost:3000, data in ./data/autopilot.db
npm run seed         # optional demo workspace: demo@example.com / demo-password-123
npm test             # full test suite
```

With Docker:

```bash
docker build -t business-auto-pilot .
docker run -p 3000:3000 -v autopilot-data:/data business-auto-pilot
```

Configuration is through environment variables. See [`.env.example`](.env.example). For production, put it behind HTTPS (Caddy, nginx or a load balancer) and set `SECURE_COOKIES=true` and `TRUST_PROXY=true`.

## The workflow engine

A workflow is a **trigger** plus a list of **steps**:

```json
{
  "trigger": { "type": "event", "event": "contact.stage_changed", "filter": "trigger.to == 'won'" },
  "steps": [
    { "id": "welcome", "type": "send_email", "when": "isEmail(trigger.email)",
      "params": { "to": "{{ trigger.email }}", "subject": "Welcome, {{ trigger.name }}!", "body": "..." },
      "retry": { "max": 3, "backoffMs": 30000 }, "onError": "continue" },
    { "id": "big", "type": "condition", "if": "trigger.value_cents >= 1000000", "then": "approve", "else": "end" },
    { "id": "approve", "type": "approval", "params": { "title": "Approve {{ formatMoney(trigger.value_cents) }}?", "timeoutHours": 48 } }
  ]
}
```

**Triggers:** `manual`, `webhook`, `schedule` (5-field cron, IANA time zone, DST-safe) and `event`. Events support wildcards such as `invoice.*`. Every trigger can have a `filter` expression.

**Built-in events:** `contact.created/updated/stage_changed`, `task.created/completed/overdue`, `invoice.created/sent/paid/overdue/voided`, `approval.decided`, `workflow.failed`, plus your own `custom.*` events.

**Steps:** `condition`, `goto`, `delay`, `approval`, `send_email`, `slack_message` (Slack, Teams, Discord and Google Chat webhooks), `http_request`, `create/update/get/find_contact(s)`, `create/update/find_task(s)`, `create/get/find_invoice(s)`, `set_invoice_status`, `record_invoice_reminder`, `set_variables`, `transform`, `emit_event` and `log`.

**Per-step controls:** `when` (skip unless true), `next` (jump), `retry` (exponential backoff with jitter), and `onError` (`fail`, `continue`, or a step id to jump to).

**Expressions:** `{{ … }}` templates and conditions use a sandboxed expression language. It has no `eval` and no prototype access. It supports `trigger.*`, `steps.<id>.*`, `vars.*`, `event.*`, `run.*`, arithmetic, comparison, `&& || ?? ?:`, and helpers such as `formatMoney`, `addDays`, `daysBetween`, `isEmail`, `contains`, `join`, `pluck`, `sum` and `default`.

### Reliability guarantees

- **Durable:** every run is checkpointed after each step. Delays, approvals and retries park the run in the database, so restarts lose nothing. A run interrupted by a crash resumes at the step that was running (at-least-once execution).
- **Versioned:** each run snapshots the workflow definition it started with, so editing a workflow never changes runs already in progress.
- **Loop-safe:** event chains are depth-limited (`MAX_EVENT_DEPTH`) and runs are step-limited (`MAX_STEPS_PER_RUN`).
- **Idempotent:** webhooks and manual runs accept an `Idempotency-Key` header. Overdue sweeps fire each event once.
- **Schedules:** each schedule slot fires once. Missed slots during downtime collapse into a single catch-up run.

## API

Every UI action has a REST endpoint. Authenticate with an API key from **Settings → API keys**:

```bash
curl -H "Authorization: Bearer bap_..." http://localhost:3000/api/contacts
curl -X POST -H "Authorization: Bearer bap_..." -H "Content-Type: application/json" \
     -d '{"name":"Jane","email":"jane@example.com","stage":"lead"}' http://localhost:3000/api/contacts
```

Main routes:

- `/api/contacts`, `/api/tasks` and `/api/invoices`: full CRUD. Invoices also have `/api/invoices/:id/status`.
- `/api/workflows`: CRUD, plus `/:id/run`, `/:id/runs`, `/:id/duplicate`, `/:id/rotate-secret` and `/api/workflows/validate`.
- `/api/templates` and `/api/templates/:id/install`.
- `/api/runs` and `/api/runs/:id`: logs and outputs, plus `/:id/cancel` and `/:id/retry`.
- `/api/approvals` and `/api/approvals/:id/decide`.
- `/api/events`: custom events. `/api/outbox`, `/api/dashboard` and `/api/audit` are read-only views.
- `/hooks/:workflowId`: inbound webhooks, using the `X-Webhook-Secret` header or `?secret=`.

## Project layout

```
src/
  server.js, app.js, config.js, db.js (schema + migrations), seed.js, templates.js
  http/server.js        router, auth, rate limiting, CSRF, static files
  routes.js             REST API
  services/             records (CRM/tasks/invoices), auth, workflows, sweeps, audit
  engine/               engine (runner), actions, definition (validation), expr, template, cron, http-client
public/                 single-page web app (vanilla JS, CSP-safe)
test/                   node:test suites (engine, API/security, expressions, cron)
```

## Operational notes and limits

- **Email:** with `EMAIL_PROVIDER=log`, messages are recorded in the Outbox but not delivered. Set `EMAIL_PROVIDER=webhook` and point `EMAIL_WEBHOOK_URL` at a relay for your provider (Postmark, SendGrid, SES, or a Zapier/Make hook). Each message is POSTed as JSON: `{from, to, cc, subject, text, messageId}`.
- **Scale:** this is a single-node design with SQLite in WAL mode. It suits thousands of runs per hour for typical SMB workloads. The worker claims runs with atomic conditional updates, but rate limiting is in-memory, so run one instance per database file.
- **Dates:** the overdue checks use UTC dates. Schedule triggers use each workflow's own time zone.
- **SSRF:** the HTTP action blocks private and internal addresses after DNS resolution and on every redirect hop. A DNS-rebinding window between that check and the connection remains. If you need stronger isolation, route outbound traffic through an egress proxy.
- **Backups:** copy `autopilot.db` (with `-wal`/`-shm`) while the app is stopped, or use `sqlite3 autopilot.db ".backup backup.db"` while it's running.
