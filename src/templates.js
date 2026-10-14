'use strict';

// Ready-made automations. "%%key%%" placeholders are replaced with the installer's settings.

const TEMPLATES = [
  {
    id: 'speed-to-lead',
    name: 'Speed-to-lead follow-up',
    category: 'Sales',
    summary: 'Every new lead gets a welcome email within a minute and a high-priority call task for the owner.',
    settings: [
      { key: 'companyName', label: 'Your company name', default: 'Our team' },
      { key: 'assignee', label: 'Who should call new leads?', default: 'sales@example.com' },
    ],
    workflow: {
      name: 'Speed-to-lead follow-up',
      description: 'Welcome email + call task for every new lead.',
      trigger: { type: 'event', event: 'contact.created', filter: "trigger.stage == 'lead'" },
      steps: [
        {
          id: 'has_email', type: 'condition', name: 'Has an email address?',
          if: 'isEmail(trigger.email)', then: 'welcome', else: 'call_task',
        },
        {
          id: 'welcome', type: 'send_email', name: 'Send welcome email',
          params: {
            to: '{{ trigger.email }}',
            subject: 'Thanks for reaching out, {{ first(split(trigger.name, " ")) }}!',
            body: 'Hi {{ first(split(trigger.name, " ")) }},\n\nThanks for your interest in %%companyName%%. Someone from our team will be in touch within one business day.\n\nBest,\n%%companyName%%',
          },
          retry: { max: 3, backoffMs: 30000 },
          onError: 'continue',
        },
        {
          id: 'call_task', type: 'create_task', name: 'Create call task',
          params: {
            title: 'Call new lead: {{ trigger.name }}{{ trigger.company ? " (" + trigger.company + ")" : "" }}',
            description: 'Email: {{ default(trigger.email, "n/a") }}\nPhone: {{ default(trigger.phone, "n/a") }}',
            priority: 'high',
            assignee: '%%assignee%%',
            dueInDays: 1,
            contact_id: '{{ trigger.id }}',
          },
        },
      ],
    },
  },
  {
    id: 'invoice-dunning',
    name: 'Overdue invoice collection',
    category: 'Finance',
    summary: 'Polite reminder when an invoice goes overdue, a firmer one a week later, then a follow-up task if still unpaid.',
    settings: [
      { key: 'companyName', label: 'Your company name', default: 'Our team' },
      { key: 'financeOwner', label: 'Who owns collections?', default: 'finance@example.com' },
    ],
    workflow: {
      name: 'Overdue invoice collection',
      description: 'Automated dunning sequence for overdue invoices.',
      trigger: { type: 'event', event: 'invoice.overdue' },
      steps: [
        {
          id: 'first_reminder', type: 'send_email', name: 'Friendly reminder',
          when: 'isEmail(trigger.contact.email)',
          params: {
            to: '{{ trigger.contact.email }}',
            subject: 'Reminder: invoice {{ trigger.number }} is past due',
            body: 'Hi {{ trigger.contact.name }},\n\nA quick reminder that invoice {{ trigger.number }} for {{ formatMoney(trigger.amount_cents, trigger.currency) }} was due on {{ trigger.due_date }}. If you have already paid, thank you and please ignore this message.\n\n%%companyName%%',
          },
          retry: { max: 3, backoffMs: 60000 },
        },
        { id: 'count1', type: 'record_invoice_reminder', params: { id: '{{ trigger.id }}' } },
        { id: 'wait', type: 'delay', name: 'Wait 7 days', params: { days: 7 } },
        { id: 'check', type: 'get_invoice', name: 'Re-check invoice', params: { id: '{{ trigger.id }}' } },
        { id: 'still_unpaid', type: 'condition', if: "steps.check.status == 'overdue'", then: 'second_reminder', else: 'end' },
        {
          id: 'second_reminder', type: 'send_email', name: 'Second reminder',
          when: 'isEmail(trigger.contact.email)',
          params: {
            to: '{{ trigger.contact.email }}',
            subject: 'Second notice: invoice {{ trigger.number }} is {{ daysBetween(trigger.due_date, today()) }} days overdue',
            body: 'Hi {{ trigger.contact.name }},\n\nInvoice {{ trigger.number }} for {{ formatMoney(trigger.amount_cents, trigger.currency) }} remains unpaid. Please arrange payment or reply to let us know if there is an issue.\n\n%%companyName%%',
          },
          retry: { max: 3, backoffMs: 60000 },
        },
        { id: 'count2', type: 'record_invoice_reminder', params: { id: '{{ trigger.id }}' } },
        {
          id: 'escalate', type: 'create_task', name: 'Escalate to a person',
          params: {
            title: 'Call about overdue invoice {{ trigger.number }} ({{ formatMoney(trigger.amount_cents, trigger.currency) }})',
            priority: 'urgent', assignee: '%%financeOwner%%', dueInDays: 1, contact_id: '{{ trigger.contact_id }}',
          },
        },
      ],
    },
  },
  {
    id: 'won-deal-onboarding',
    name: 'Won deal → customer onboarding',
    category: 'Customer success',
    summary: 'When a deal is marked won: welcome email, kickoff and check-in tasks, and a draft invoice for the deal value.',
    settings: [
      { key: 'companyName', label: 'Your company name', default: 'Our team' },
      { key: 'csOwner', label: 'Who onboards new customers?', default: 'success@example.com' },
    ],
    workflow: {
      name: 'Won deal → customer onboarding',
      trigger: { type: 'event', event: 'contact.stage_changed', filter: "trigger.to == 'won'" },
      steps: [
        {
          id: 'welcome', type: 'send_email', when: 'isEmail(trigger.email)',
          params: {
            to: '{{ trigger.email }}',
            subject: 'Welcome aboard, {{ trigger.company ?? trigger.name }}!',
            body: 'Hi {{ trigger.name }},\n\nWe are thrilled to be working with you. Your onboarding lead will reach out shortly to schedule a kickoff call.\n\n%%companyName%%',
          },
          retry: { max: 3, backoffMs: 30000 },
          onError: 'continue',
        },
        { id: 'kickoff', type: 'create_task', params: { title: 'Schedule kickoff with {{ trigger.name }}', priority: 'high', assignee: '%%csOwner%%', dueInDays: 2, contact_id: '{{ trigger.id }}' } },
        { id: 'checkin', type: 'create_task', params: { title: '30-day check-in with {{ trigger.name }}', assignee: '%%csOwner%%', dueInDays: 30, contact_id: '{{ trigger.id }}' } },
        {
          id: 'invoice', type: 'create_invoice', when: 'trigger.value_cents > 0',
          params: {
            contact_id: '{{ trigger.id }}',
            items: [{ description: 'Services for {{ trigger.company ?? trigger.name }}', quantity: 1, unit_price_cents: '{{ trigger.value_cents }}' }],
            dueInDays: 30,
          },
        },
        { id: 'tag', type: 'update_contact', params: { id: '{{ trigger.id }}', addTags: ['customer'] } },
      ],
    },
  },
  {
    id: 'big-deal-approval',
    name: 'Large deal approval',
    category: 'Sales',
    summary: 'Deals entering negotiation above a threshold need manager approval before pricing goes out.',
    settings: [
      { key: 'thresholdCents', label: 'Approval threshold (in cents)', default: '1000000' },
      { key: 'assignee', label: 'Deal desk / sales lead', default: 'sales@example.com' },
    ],
    workflow: {
      name: 'Large deal approval',
      trigger: { type: 'event', event: 'contact.stage_changed', filter: "trigger.to == 'negotiation' && trigger.value_cents >= %%thresholdCents%%" },
      steps: [
        {
          id: 'approve', type: 'approval', name: 'Manager approval',
          params: {
            title: 'Approve {{ formatMoney(trigger.value_cents) }} deal with {{ trigger.company ?? trigger.name }}',
            details: 'Contact: {{ trigger.name }} <{{ trigger.email }}>\nOwner: {{ default(trigger.owner, "unassigned") }}',
            timeoutHours: 72,
          },
        },
        { id: 'decision', type: 'condition', if: 'steps.approve.approved', then: 'approved_task', else: 'rejected_task' },
        {
          id: 'approved_task', type: 'create_task', next: 'end',
          params: { title: 'Send proposal to {{ trigger.name }} (approved by {{ steps.approve.decidedBy }})', priority: 'high', assignee: '%%assignee%%', dueInDays: 1, contact_id: '{{ trigger.id }}' },
        },
        {
          id: 'rejected_task', type: 'create_task',
          params: { title: 'Revisit pricing for {{ trigger.name }}: {{ steps.approve.status }}{{ steps.approve.comment ? " — " + steps.approve.comment : "" }}', assignee: '%%assignee%%', dueInDays: 1, contact_id: '{{ trigger.id }}' },
        },
      ],
    },
  },
  {
    id: 'weekly-digest',
    name: 'Monday business digest',
    category: 'Reporting',
    summary: 'Every Monday morning: pipeline value, unpaid invoices and overdue tasks in one email.',
    settings: [
      { key: 'recipient', label: 'Send the digest to', default: 'owner@example.com' },
      { key: 'timezone', label: 'Time zone (IANA)', default: 'America/New_York' },
    ],
    workflow: {
      name: 'Monday business digest',
      trigger: { type: 'schedule', cron: '0 8 * * 1', timezone: '%%timezone%%' },
      steps: [
        { id: 'negotiating', type: 'find_contacts', params: { stage: 'negotiation' } },
        { id: 'proposals', type: 'find_contacts', params: { stage: 'proposal' } },
        { id: 'unpaid', type: 'find_invoices', params: { status: 'unpaid' } },
        { id: 'overdue_invoices', type: 'find_invoices', params: { status: 'overdue' } },
        { id: 'late_tasks', type: 'find_tasks', params: { due: 'overdue' } },
        {
          id: 'send', type: 'send_email',
          params: {
            to: '%%recipient%%',
            subject: 'Your Monday digest: {{ formatMoney(steps.negotiating.totalValueCents + steps.proposals.totalValueCents) }} in late-stage pipeline',
            body: 'Good morning!\n\nPIPELINE\n• In negotiation: {{ steps.negotiating.total }} deals worth {{ formatMoney(steps.negotiating.totalValueCents) }}\n• Proposal sent: {{ steps.proposals.total }} deals worth {{ formatMoney(steps.proposals.totalValueCents) }}\n\nCASH\n• Unpaid invoices: {{ steps.unpaid.total }} totalling {{ formatMoney(steps.unpaid.totalCents) }}\n• Of which overdue: {{ steps.overdue_invoices.total }} ({{ formatMoney(steps.overdue_invoices.totalCents) }})\n\nTASKS\n• Overdue tasks: {{ steps.late_tasks.total }}{{ steps.late_tasks.total > 0 ? "\\n  - " + join(pluck(steps.late_tasks.items, "title"), "\\n  - ") : "" }}\n\nHave a great week.',
          },
          retry: { max: 3, backoffMs: 60000 },
        },
      ],
    },
  },
  {
    id: 'web-lead-capture',
    name: 'Website form → CRM',
    category: 'Sales',
    summary: 'A webhook your website form posts to. Creates (or finds) the contact, tags it and alerts the team.',
    settings: [{ key: 'assignee', label: 'Who handles web leads?', default: 'sales@example.com' }],
    workflow: {
      name: 'Website form → CRM',
      trigger: { type: 'webhook' },
      steps: [
        {
          id: 'contact', type: 'create_contact',
          params: {
            name: '{{ default(trigger.name, trigger.email) }}', email: '{{ trigger.email }}', phone: '{{ trigger.phone }}',
            company: '{{ trigger.company }}', notes: '{{ trigger.message }}', tags: ['web'], skipIfExists: true,
          },
        },
        {
          id: 'task', type: 'create_task', when: '!steps.contact.existed',
          params: { title: 'Respond to web enquiry from {{ steps.contact.name }}', description: '{{ trigger.message }}', priority: 'high', assignee: '%%assignee%%', dueInDays: 0, contact_id: '{{ steps.contact.id }}' },
        },
      ],
    },
  },
  {
    id: 'payment-thank-you',
    name: 'Payment received → thank you',
    category: 'Finance',
    summary: 'Sends a receipt-style thank-you when an invoice is marked paid and tags the contact as a paying customer.',
    settings: [{ key: 'companyName', label: 'Your company name', default: 'Our team' }],
    workflow: {
      name: 'Payment received → thank you',
      trigger: { type: 'event', event: 'invoice.paid' },
      steps: [
        {
          id: 'thanks', type: 'send_email', when: 'isEmail(trigger.contact.email)',
          params: {
            to: '{{ trigger.contact.email }}',
            subject: 'Payment received for invoice {{ trigger.number }}',
            body: 'Hi {{ trigger.contact.name }},\n\nWe received your payment of {{ formatMoney(trigger.amount_cents, trigger.currency) }} for invoice {{ trigger.number }}. Thank you!\n\n%%companyName%%',
          },
          retry: { max: 3, backoffMs: 30000 },
        },
        { id: 'tag', type: 'update_contact', when: 'trigger.contact_id', params: { id: '{{ trigger.contact_id }}', addTags: ['paying-customer'] } },
      ],
    },
  },
  {
    id: 'failure-alerts',
    name: 'Automation failure alerts',
    category: 'Operations',
    summary: 'Emails an admin whenever any workflow run fails, with a link to the run.',
    settings: [
      { key: 'recipient', label: 'Alert recipient', default: 'admin@example.com' },
      { key: 'baseUrl', label: 'App URL', default: 'http://localhost:3000' },
    ],
    workflow: {
      name: 'Automation failure alerts',
      trigger: { type: 'event', event: 'workflow.failed', filter: "trigger.workflowName != 'Automation failure alerts'" },
      steps: [
        {
          id: 'alert', type: 'send_email',
          params: {
            to: '%%recipient%%',
            subject: 'Automation failed: {{ trigger.workflowName }}',
            body: 'The workflow "{{ trigger.workflowName }}" failed.\n\nError: {{ trigger.error }}\n\nView the run: %%baseUrl%%/#/runs/{{ trigger.runId }}',
          },
        },
      ],
    },
  },
];

function list() {
  return TEMPLATES.map(({ workflow, ...meta }) => ({ ...meta, trigger: workflow.trigger, stepCount: workflow.steps.length }));
}

// Substitutes settings into the template. Values are JSON-escaped so they cannot break out of strings.
function instantiate(id, settings = {}) {
  const tpl = TEMPLATES.find((t) => t.id === id);
  if (!tpl) return null;
  const values = {};
  for (const s of tpl.settings) {
    const v = settings[s.key];
    values[s.key] = v === undefined || v === null || String(v).trim() === '' ? s.default : String(v).trim();
  }
  if (values.thresholdCents !== undefined && !/^\d+$/.test(values.thresholdCents)) {
    const err = new Error('Approval threshold must be a whole number of cents');
    err.status = 400;
    throw err;
  }
  const json = JSON.stringify(tpl.workflow).replace(/%%([A-Za-z]+)%%/g, (m, key) => {
    if (!Object.hasOwn(values, key)) return m;
    return JSON.stringify(values[key]).slice(1, -1);
  });
  return JSON.parse(json);
}

module.exports = { list, instantiate, TEMPLATES };
