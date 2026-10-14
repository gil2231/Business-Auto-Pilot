'use strict';

// Creates a demo workspace with realistic data. Usage: npm run seed
// Login: demo@example.com / demo-password-123

const { createApp } = require('./app');
const auth = require('./services/auth');
const records = require('./services/records');
const workflows = require('./services/workflows');
const templates = require('./templates');

const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

async function main() {
  const app = createApp();
  const email = process.env.SEED_EMAIL || 'demo@example.com';
  const password = process.env.SEED_PASSWORD || 'demo-password-123';
  if (app.db.get('SELECT 1 FROM users WHERE email = ?', email)) {
    console.log(`A user ${email} already exists, nothing to do.`);
    app.db.close();
    return;
  }
  const { orgId } = await auth.signup(app, { orgName: 'Northwind Services', name: 'Demo Owner', email, password });
  const opts = { actor: 'seed' };

  const people = [
    ['Maria Garcia', 'maria@brightsmile.example', 'BrightSmile Dental', 'won', 1850000],
    ['James Chen', 'james@chenlogistics.example', 'Chen Logistics', 'negotiation', 4200000],
    ['Aisha Patel', 'aisha@patelarch.example', 'Patel Architects', 'proposal', 960000],
    ['Tom Becker', 'tom@beckerbuild.example', 'Becker Builders', 'qualified', 1500000],
    ['Sofia Rossi', 'sofia@rossifoods.example', 'Rossi Foods', 'lead', 300000],
    ['Liam O\'Brien', 'liam@obrienlaw.example', 'O\'Brien Law', 'lead', 750000],
    ['Emma Novak', 'emma@novakfit.example', 'Novak Fitness', 'won', 620000],
    ['Noah Kim', 'noah@kimcafe.example', 'Kim Café', 'lost', 180000],
    ['Olivia Brown', 'olivia@brownhr.example', 'Brown HR Consulting', 'proposal', 2100000],
    ['Lucas Silva', 'lucas@silvaauto.example', 'Silva Auto Repair', 'qualified', 540000],
  ];
  const contacts = people.map(([name, mail, company, stage, value]) =>
    records.createContact(app, orgId, { name, email: mail, company, stage, value_cents: value, owner: 'Demo Owner', tags: stage === 'won' ? ['customer'] : [] }, opts));
  const byName = Object.fromEntries(contacts.map((c) => [c.name, c]));

  const tasks = [
    ['Send revised proposal to Chen Logistics', 'high', -2, byName['James Chen'].id],
    ['Kickoff call with BrightSmile Dental', 'normal', 1, byName['Maria Garcia'].id],
    ['Follow up with Rossi Foods', 'high', 0, byName['Sofia Rossi'].id],
    ['Prepare Q4 pricing sheet', 'normal', 5, null],
    ['Check in with Novak Fitness', 'low', 12, byName['Emma Novak'].id],
  ];
  for (const [title, priority, due, contactId] of tasks) {
    records.createTask(app, orgId, { title, priority, due_date: iso(due), contact_id: contactId, assignee: 'Demo Owner' }, opts);
  }

  const invoices = [
    [byName['Maria Garcia'].id, [['Website redesign', 1, 1250000], ['Hosting (12 months)', 12, 50000]], -40, 'paid'],
    [byName['Emma Novak'].id, [['Booking system setup', 1, 620000]], -10, 'sent'],
    [byName['Maria Garcia'].id, [['SEO retainer: October', 1, 180000]], 14, 'sent'],
    [byName['James Chen'].id, [['Discovery workshop', 2, 150000]], 30, 'draft'],
  ];
  for (const [contactId, items, due, status] of invoices) {
    const inv = records.createInvoice(app, orgId, {
      contact_id: contactId,
      items: items.map(([description, quantity, unit]) => ({ description, quantity, unit_price_cents: unit })),
      due_date: iso(due),
    }, opts);
    if (status !== 'draft') records.setInvoiceStatus(app, orgId, inv.id, 'sent', opts);
    if (status === 'paid') records.setInvoiceStatus(app, orgId, inv.id, 'paid', opts);
  }

  // Automations are installed last so the demo data above does not trigger them.
  const settings = { companyName: 'Northwind Services', assignee: 'Demo Owner', financeOwner: 'Demo Owner', csOwner: 'Demo Owner', recipient: email, timezone: 'UTC' };
  for (const id of ['speed-to-lead', 'invoice-dunning', 'won-deal-onboarding', 'big-deal-approval', 'weekly-digest', 'web-lead-capture', 'payment-thank-you']) {
    workflows.create(app, orgId, { ...templates.instantiate(id, settings), enabled: true }, 'seed');
  }

  console.log('Demo workspace created.');
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  app.db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
