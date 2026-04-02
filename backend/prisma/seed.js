/**
 * Seed script — wipes the database clean, then populates it with realistic
 * enterprise CRM demo data for a fictional company "NovaCrest Technologies".
 *
 * Run: node prisma/seed.js
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('=== Globussoft CRM — Database Reset & Seed ===\n');

  // ══════════════════════════════════════════════════════════════
  // STEP 1: WIPE ALL TABLES (order matters for foreign keys)
  // ══════════════════════════════════════════════════════════════
  console.log('Wiping all tables...');
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
  const tables = [
    'Notification', 'AuditLog', 'PipelineStage', 'EmailTemplate',
    'CustomValue', 'CustomRecord', 'CustomField', 'CustomEntity',
    'QuoteLineItem', 'Quote', 'Product',
    'EstimateLineItem', 'Estimate',
    'SequenceEnrollment', 'Sequence',
    'Attachment', 'CallLog', 'EmailMessage',
    'Activity', 'Task', 'Expense', 'Invoice', 'Contract', 'Project',
    'Deal', 'Ticket', 'Campaign', 'AutomationRule', 'Integration',
    'Webhook', 'ApiKey', 'Contact', 'User',
  ];
  for (const table of tables) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``);
  }
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  console.log('  All tables truncated.\n');

  // ══════════════════════════════════════════════════════════════
  // STEP 2: USERS — The NovaCrest team
  // ══════════════════════════════════════════════════════════════
  const pw = await bcrypt.hash('password123', 10);
  const users = await Promise.all([
    prisma.user.create({ data: { email: 'admin@globussoft.com',    password: pw, role: 'ADMIN',   name: 'Rajesh Sharma' } }),
    prisma.user.create({ data: { email: 'manager@crm.com',        password: pw, role: 'MANAGER', name: 'Priya Patel' } }),
    prisma.user.create({ data: { email: 'user@crm.com',           password: pw, role: 'USER',    name: 'Amit Singh' } }),
    prisma.user.create({ data: { email: 'sneha@globussoft.com',    password: pw, role: 'USER',    name: 'Sneha Reddy' } }),
    prisma.user.create({ data: { email: 'vikram@globussoft.com',   password: pw, role: 'MANAGER', name: 'Vikram Joshi' } }),
    prisma.user.create({ data: { email: 'anita@globussoft.com',    password: pw, role: 'USER',    name: 'Anita Desai' } }),
  ]);
  console.log(`Users: ${users.length} created`);

  // Helper to pick random items
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const between = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const daysAgo = (n) => new Date(Date.now() - n * 86400000);
  const daysFromNow = (n) => new Date(Date.now() + n * 86400000);

  // ══════════════════════════════════════════════════════════════
  // STEP 3: CONTACTS — 30 realistic global contacts
  // ══════════════════════════════════════════════════════════════
  const contactsData = [
    // Customers (12)
    { name: 'Sarah Chen',          email: 'sarah.chen@techflow.io',         company: 'TechFlow Solutions',     title: 'VP Engineering',        status: 'Customer', source: 'Referral',    aiScore: 92 },
    { name: 'Elena Rodriguez',     email: 'elena@brighthorizon.com',        company: 'BrightHorizon Media',    title: 'CMO',                   status: 'Customer', source: 'Webinar',     aiScore: 95 },
    { name: 'David Kim',           email: 'dkim@quantumleap.ai',            company: 'QuantumLeap AI',         title: 'Head of Product',       status: 'Customer', source: 'Partner',     aiScore: 91 },
    { name: 'Fatima Al-Hussein',   email: 'fatima@gulfstar.ae',             company: 'GulfStar Trading LLC',   title: 'Procurement Director',  status: 'Customer', source: 'Referral',    aiScore: 88 },
    { name: 'Li Wei',              email: 'liwei@shenzhen-micro.cn',        company: 'Shenzhen Micro Ltd',     title: 'Engineering Lead',      status: 'Customer', source: 'LinkedIn',    aiScore: 82 },
    { name: 'Emily Watson',        email: 'emily@brightspark.edu',          company: 'BrightSpark Academy',    title: 'Director of Technology', status: 'Customer', source: 'Referral',    aiScore: 93 },
    { name: 'Ahmed Hassan',        email: 'ahmed@cairoinnovate.com',        company: 'Cairo Innovate',         title: 'Founder & CEO',         status: 'Customer', source: 'Cold Call',   aiScore: 86 },
    { name: 'Amanda Brooks',       email: 'amanda@silverline.co',           company: 'Silverline Consulting',  title: 'Managing Director',     status: 'Customer', source: 'Referral',    aiScore: 96 },
    { name: 'Henrik Larsson',      email: 'henrik@nordiccloud.se',          company: 'Nordic Cloud AB',        title: 'CTO',                   status: 'Customer', source: 'Conference',  aiScore: 89 },
    { name: 'Priyanka Mehta',      email: 'priyanka@velocitycrm.in',       company: 'Velocity CRM India',     title: 'VP Sales',              status: 'Customer', source: 'Partner',     aiScore: 84 },
    { name: 'Robert Fitzgerald',   email: 'robert@aspengroup.com',         company: 'Aspen Group Holdings',   title: 'COO',                   status: 'Customer', source: 'Trade Show',  aiScore: 90 },
    { name: 'Yuki Tanaka',         email: 'yuki@tokyorobotics.jp',         company: 'Tokyo Robotics Corp',    title: 'CTO',                   status: 'Customer', source: 'Partner',     aiScore: 77 },
    // Prospects (10)
    { name: 'Marcus Johnson',      email: 'marcus@pinnacle.co',             company: 'Pinnacle Ventures',      title: 'Managing Partner',      status: 'Prospect', source: 'LinkedIn',    aiScore: 87 },
    { name: 'Aisha Patel',         email: 'aisha@greenleaf.eco',            company: 'GreenLeaf Eco',          title: 'CEO',                   status: 'Prospect', source: 'Conference',  aiScore: 78 },
    { name: 'Thomas Mueller',      email: 'thomas@eurotech.de',             company: 'EuroTech GmbH',          title: 'Sales Director',        status: 'Prospect', source: 'Trade Show',  aiScore: 73 },
    { name: 'Nina Petrov',         email: 'nina@balticventures.io',          company: 'Baltic Ventures',        title: 'Investment Analyst',    status: 'Prospect', source: 'Webinar',     aiScore: 69 },
    { name: 'Yuki Yamamoto',       email: 'yuki.y@sakuratech.jp',           company: 'Sakura Technologies',    title: 'Director of IT',        status: 'Prospect', source: 'Organic',     aiScore: 74 },
    { name: 'Jessica Morgan',      email: 'jessica@westcoasthr.com',        company: 'WestCoast HR Solutions', title: 'HR Director',           status: 'Prospect', source: 'LinkedIn',    aiScore: 71 },
    { name: 'Daniel Okafor',       email: 'daniel@lagosfintech.ng',         company: 'Lagos FinTech',          title: 'CEO',                   status: 'Prospect', source: 'Referral',    aiScore: 80 },
    { name: 'Isabella Rossi',      email: 'isabella@milandesign.it',        company: 'Milan Design Studio',    title: 'Creative Director',     status: 'Prospect', source: 'Instagram',   aiScore: 65 },
    // Leads (8)
    { name: "James O'Brien",       email: 'jobrien@cloudnine.dev',          company: 'CloudNine Dev',          title: 'CTO',                   status: 'Lead',     source: 'Organic',     aiScore: 64 },
    { name: 'Maria Santos',        email: 'maria@solarbright.energy',       company: 'SolarBright Energy',     title: 'Director of Operations', status: 'Lead',    source: 'Cold Call',   aiScore: 45 },
    { name: 'Ryan Cooper',         email: 'ryan@nexgenfintech.com',         company: 'NexGen FinTech',         title: 'CFO',                   status: 'Lead',     source: 'Organic',     aiScore: 56 },
    { name: 'Carlos Mendez',       email: 'carlos@latamlogistics.com',      company: 'LatAm Logistics',        title: 'VP Supply Chain',       status: 'Lead',     source: 'Conference',  aiScore: 41 },
    { name: 'Sophie Laurent',      email: 'sophie@parisian.agency',         company: 'Parisian Agency',        title: 'Account Director',      status: 'Lead',     source: 'Organic',     aiScore: 52 },
    { name: 'Oleg Volkov',         email: 'oleg@slavicsoft.dev',            company: 'SlavicSoft',             title: 'Lead Architect',        status: 'Lead',     source: 'GitHub',      aiScore: 63 },
    { name: 'Grace Kimani',        email: 'grace@nairobitech.co.ke',        company: 'Nairobi Tech Hub',       title: 'Program Manager',       status: 'Lead',     source: 'LinkedIn',    aiScore: 58 },
    { name: 'Arjun Krishnan',      email: 'arjun@bangaloreai.in',           company: 'Bangalore AI Labs',      title: 'ML Engineer',           status: 'Lead',     source: 'GitHub',      aiScore: 70 },
  ];

  const contacts = [];
  for (const c of contactsData) {
    contacts.push(await prisma.contact.create({ data: c }));
  }
  console.log(`Contacts: ${contacts.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 4: PIPELINE STAGES — Custom enterprise stages
  // ══════════════════════════════════════════════════════════════
  const stagesData = [
    { name: 'New Lead',       color: '#3b82f6', position: 0 },
    { name: 'Contacted',      color: '#f59e0b', position: 1 },
    { name: 'Proposal Sent',  color: '#a855f7', position: 2 },
    { name: 'Negotiation',    color: '#ec4899', position: 3 },
    { name: 'Closed Won',     color: '#10b981', position: 4 },
    { name: 'Closed Lost',    color: '#6b7280', position: 5 },
  ];
  for (const s of stagesData) {
    await prisma.pipelineStage.create({ data: s });
  }
  console.log(`Pipeline Stages: ${stagesData.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 5: DEALS — 24 realistic deals across pipeline stages
  // ══════════════════════════════════════════════════════════════
  const dealsData = [
    // Won deals
    { title: 'TechFlow Enterprise License Renewal',     amount: 125000, probability: 100, stage: 'won',       ci: 0,  ui: 0, close: daysAgo(15) },
    { title: 'BrightHorizon Campaign Platform',         amount: 42000,  probability: 100, stage: 'won',       ci: 1,  ui: 3, close: daysAgo(30) },
    { title: 'QuantumLeap AI Annual Subscription',      amount: 310000, probability: 100, stage: 'won',       ci: 2,  ui: 0, close: daysAgo(5) },
    { title: 'Shenzhen Micro Hardware Integration',     amount: 275000, probability: 100, stage: 'won',       ci: 4,  ui: 0, close: daysAgo(45) },
    { title: 'BrightSpark LMS Enterprise',              amount: 72000,  probability: 100, stage: 'won',       ci: 5,  ui: 1, close: daysAgo(20) },
    { title: 'Silverline Consulting Retainer',          amount: 96000,  probability: 100, stage: 'won',       ci: 7,  ui: 0, close: daysAgo(8) },
    { title: 'Nordic Cloud Infrastructure Deal',        amount: 180000, probability: 100, stage: 'won',       ci: 8,  ui: 4, close: daysAgo(60) },
    { title: 'Aspen Group Digital Transformation',      amount: 450000, probability: 100, stage: 'won',       ci: 10, ui: 0, close: daysAgo(12) },
    // Proposal stage
    { title: 'GulfStar Fleet Management System',        amount: 150000, probability: 80,  stage: 'proposal',  ci: 3,  ui: 0, close: daysFromNow(20) },
    { title: 'Tokyo Robotics R&D Platform',             amount: 185000, probability: 65,  stage: 'proposal',  ci: 11, ui: 4, close: daysFromNow(35) },
    { title: 'Pinnacle Ventures Analytics Dashboard',   amount: 85000,  probability: 70,  stage: 'proposal',  ci: 12, ui: 1, close: daysFromNow(15) },
    { title: 'GreenLeaf Sustainability Platform',       amount: 67000,  probability: 55,  stage: 'proposal',  ci: 13, ui: 1, close: daysFromNow(25) },
    { title: 'Lagos FinTech Payment Gateway',           amount: 92000,  probability: 60,  stage: 'proposal',  ci: 20, ui: 3, close: daysFromNow(30) },
    // Contacted stage
    { title: 'EuroTech Expansion Pack',                 amount: 54000,  probability: 45,  stage: 'contacted', ci: 14, ui: 4, close: daysFromNow(45) },
    { title: 'NexGen Compliance Module',                amount: 95000,  probability: 40,  stage: 'contacted', ci: 24, ui: 1, close: daysFromNow(50) },
    { title: 'Cairo Innovate Startup Bundle',           amount: 22000,  probability: 50,  stage: 'contacted', ci: 6,  ui: 3, close: daysFromNow(40) },
    { title: 'Sakura Technologies CRM Migration',      amount: 68000,  probability: 35,  stage: 'contacted', ci: 18, ui: 5, close: daysFromNow(55) },
    { title: 'WestCoast HR Workforce Module',           amount: 38000,  probability: 40,  stage: 'contacted', ci: 19, ui: 2, close: daysFromNow(60) },
    // Lead stage
    { title: 'CloudNine Infrastructure Assessment',     amount: 200000, probability: 20,  stage: 'lead',      ci: 22, ui: 0, close: daysFromNow(75) },
    { title: 'SolarBright IoT Monitoring Pilot',        amount: 18000,  probability: 15,  stage: 'lead',      ci: 23, ui: 3, close: daysFromNow(60) },
    { title: 'Parisian Agency Creative Suite',          amount: 28000,  probability: 25,  stage: 'lead',      ci: 26, ui: 3, close: daysFromNow(65) },
    { title: 'Bangalore AI Labs ML Platform',           amount: 115000, probability: 30,  stage: 'lead',      ci: 29, ui: 2, close: daysFromNow(80) },
    // Lost
    { title: 'LatAm Logistics Tracking System',         amount: 33000,  probability: 0,   stage: 'lost',      ci: 25, ui: 1, close: daysAgo(40) },
    { title: 'Milan Design Studio Proposal',            amount: 15000,  probability: 0,   stage: 'lost',      ci: 21, ui: 5, close: daysAgo(25) },
  ];

  const deals = [];
  for (const d of dealsData) {
    deals.push(await prisma.deal.create({
      data: {
        title: d.title, amount: d.amount, probability: d.probability, stage: d.stage,
        contactId: contacts[d.ci].id, ownerId: users[d.ui].id, expectedClose: d.close,
      },
    }));
  }
  console.log(`Deals: ${deals.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 6: ACTIVITIES — 80+ timeline entries across contacts
  // ══════════════════════════════════════════════════════════════
  const actDescriptions = [
    { type: 'Call',    text: 'Discovery call — mapped out current tech stack and pain points' },
    { type: 'Call',    text: 'Follow-up call to discuss pricing and implementation timeline' },
    { type: 'Call',    text: 'Quarterly business review — 15% increase in adoption noted' },
    { type: 'Call',    text: 'Left voicemail regarding contract renewal — will follow up Thursday' },
    { type: 'Email',   text: 'Sent product comparison PDF and ROI calculator' },
    { type: 'Email',   text: 'Shared customer success story from similar industry vertical' },
    { type: 'Email',   text: 'Sent updated pricing proposal with volume discounts' },
    { type: 'Email',   text: 'Follow-up on demo — requested feedback by end of week' },
    { type: 'Email',   text: 'Sent meeting recap with action items and next steps' },
    { type: 'Meeting', text: 'In-person demo at client HQ — well received by the C-suite' },
    { type: 'Meeting', text: 'Technical deep-dive with CTO on API architecture and security' },
    { type: 'Meeting', text: 'Onboarding kickoff session with 8 team members' },
    { type: 'Meeting', text: 'Joint planning session for Q2 campaign launch' },
    { type: 'Meeting', text: 'Contract negotiation meeting — legal reviewing final terms' },
    { type: 'Note',    text: 'Champion internally — pushing for budget approval this quarter' },
    { type: 'Note',    text: 'Decision-maker going on leave for 2 weeks — pause outreach' },
    { type: 'Note',    text: 'Competitor pitched last week — need to differentiate on support SLA' },
    { type: 'Note',    text: 'Strong referral potential — ask for LinkedIn recommendation after go-live' },
  ];

  let activityCount = 0;
  for (const contact of contacts) {
    const count = between(2, 6);
    for (let i = 0; i < count; i++) {
      const a = pick(actDescriptions);
      await prisma.activity.create({
        data: { type: a.type, description: a.text, contactId: contact.id, createdAt: daysAgo(between(1, 90)) },
      });
      activityCount++;
    }
  }
  console.log(`Activities: ${activityCount} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 7: TASKS — 20 actionable tasks
  // ══════════════════════════════════════════════════════════════
  const tasksData = [
    { title: 'Prepare Pinnacle Ventures proposal deck',     priority: 'High',     status: 'Pending',   ci: 12, ui: 1, due: daysFromNow(3),  notes: 'Include competitive analysis and ROI projections' },
    { title: 'Schedule GulfStar demo with procurement',     priority: 'High',     status: 'Pending',   ci: 3,  ui: 0, due: daysFromNow(2),  notes: 'Fatima requested a 30-min slot next week' },
    { title: 'Send TechFlow renewal invoice',               priority: 'Critical', status: 'Pending',   ci: 0,  ui: 3, due: daysFromNow(1),  notes: 'Renewal is due April 15 — send early' },
    { title: 'Follow up with EuroTech on pricing feedback', priority: 'Medium',   status: 'Pending',   ci: 14, ui: 4, due: daysFromNow(5),  notes: null },
    { title: 'Book flight to Mumbai for Velocity CRM visit', priority: 'Medium',  status: 'Pending',   ci: 9,  ui: 0, due: daysFromNow(10), notes: 'Conference + client visit combo trip' },
    { title: 'Draft partnership agreement for QuantumLeap', priority: 'High',     status: 'Pending',   ci: 2,  ui: 0, due: daysFromNow(7),  notes: 'Legal template is in Google Drive' },
    { title: 'Update CRM notes for all Q1 touchpoints',    priority: 'Low',      status: 'Pending',   ci: 7,  ui: 2, due: daysFromNow(14), notes: 'Batch update for reporting accuracy' },
    { title: 'Prepare Q1 revenue report for board',         priority: 'Critical', status: 'Pending',   ci: null, ui: 0, due: daysFromNow(2),  notes: 'Include MRR breakdown by segment' },
    { title: 'Send case study to GreenLeaf',                priority: 'Medium',   status: 'Pending',   ci: 13, ui: 1, due: daysFromNow(4),  notes: 'Use the SolarBright case study — similar industry' },
    { title: 'Review contract terms for Nordic Cloud',      priority: 'Low',      status: 'Pending',   ci: 8,  ui: 4, due: daysFromNow(12), notes: null },
    // Completed tasks
    { title: 'Onboard BrightSpark Academy team',            priority: 'High',     status: 'Completed', ci: 5,  ui: 1, due: daysAgo(5),  notes: '8 users trained, all active' },
    { title: 'Close Silverline retainer deal',              priority: 'Critical', status: 'Completed', ci: 7,  ui: 0, due: daysAgo(8),  notes: 'Closed at $96K annual — great margin' },
    { title: 'Migrate Aspen Group legacy data',             priority: 'High',     status: 'Completed', ci: 10, ui: 0, due: daysAgo(12), notes: '50K records migrated with zero data loss' },
    { title: 'Run competitive analysis for Q1',             priority: 'Medium',   status: 'Completed', ci: null, ui: 2, due: daysAgo(20), notes: 'Salesforce, HubSpot, Zoho compared' },
    { title: 'Fix API rate limiting for QuantumLeap',       priority: 'Critical', status: 'Completed', ci: 2,  ui: 0, due: daysAgo(3),  notes: 'Increased to 10K/min for enterprise tier' },
  ];

  for (const t of tasksData) {
    await prisma.task.create({
      data: {
        title: t.title, priority: t.priority, status: t.status, notes: t.notes,
        dueDate: t.due, contactId: t.ci !== null ? contacts[t.ci].id : null, userId: users[t.ui].id,
      },
    });
  }
  console.log(`Tasks: ${tasksData.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 8: INVOICES — 15 realistic invoices
  // ══════════════════════════════════════════════════════════════
  const invoicesData = [
    { num: 'INV-2026-001', amount: 125000, status: 'PAID',    ci: 0,  di: 0,  due: daysAgo(10) },
    { num: 'INV-2026-002', amount: 42000,  status: 'PAID',    ci: 1,  di: 1,  due: daysAgo(25) },
    { num: 'INV-2026-003', amount: 310000, status: 'PAID',    ci: 2,  di: 2,  due: daysAgo(2) },
    { num: 'INV-2026-004', amount: 275000, status: 'PAID',    ci: 4,  di: 3,  due: daysAgo(40) },
    { num: 'INV-2026-005', amount: 72000,  status: 'PAID',    ci: 5,  di: 4,  due: daysAgo(15) },
    { num: 'INV-2026-006', amount: 96000,  status: 'PAID',    ci: 7,  di: 5,  due: daysAgo(3) },
    { num: 'INV-2026-007', amount: 180000, status: 'PAID',    ci: 8,  di: 6,  due: daysAgo(55) },
    { num: 'INV-2026-008', amount: 450000, status: 'PAID',    ci: 10, di: 7,  due: daysAgo(7) },
    { num: 'INV-2026-009', amount: 150000, status: 'UNPAID',  ci: 3,  di: 8,  due: daysFromNow(25) },
    { num: 'INV-2026-010', amount: 185000, status: 'UNPAID',  ci: 11, di: 9,  due: daysFromNow(40) },
    { num: 'INV-2026-011', amount: 85000,  status: 'UNPAID',  ci: 12, di: 10, due: daysFromNow(10) },
    { num: 'INV-2026-012', amount: 67000,  status: 'UNPAID',  ci: 13, di: 11, due: daysFromNow(20) },
    { num: 'INV-2026-013', amount: 54000,  status: 'OVERDUE', ci: 14, di: 13, due: daysAgo(5) },
    { num: 'INV-2026-014', amount: 22000,  status: 'OVERDUE', ci: 6,  di: 15, due: daysAgo(10) },
    { num: 'INV-2026-015', amount: 38000,  status: 'UNPAID',  ci: 19, di: 17, due: daysFromNow(30) },
  ];

  for (const inv of invoicesData) {
    await prisma.invoice.create({
      data: {
        invoiceNum: inv.num, amount: inv.amount, status: inv.status, dueDate: inv.due,
        contactId: contacts[inv.ci].id, dealId: deals[inv.di].id,
      },
    });
  }
  console.log(`Invoices: ${invoicesData.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 9: TICKETS — 8 support tickets
  // ══════════════════════════════════════════════════════════════
  const ticketsData = [
    { subject: 'API rate limit exceeded during batch sync',      description: 'QuantumLeap hitting 429 errors on /api/contacts during hourly ETL job. Need rate limit increase for enterprise tier.', status: 'Open',     priority: 'Urgent',  ui: 0 },
    { subject: 'Dashboard revenue chart showing stale data',     description: 'MRR chart not updating after new invoices are marked paid. Cache invalidation issue suspected.', status: 'Pending',  priority: 'High',    ui: 2 },
    { subject: 'SSO login failing with Google Workspace',        description: 'OAuth2 callback returning invalid_grant error for users with @techflow.io domain since yesterday.', status: 'Open',     priority: 'Urgent',  ui: 0 },
    { subject: 'Contacts CSV export missing AI score column',    description: 'When exporting contacts to CSV, the aiScore and source fields are not included in the download.', status: 'Resolved', priority: 'Low',     ui: 2 },
    { subject: 'Mobile pipeline view cards overlapping',         description: 'On iPhone 12 (Safari), Kanban deal cards overlap when stage has >5 deals. Responsive CSS issue.', status: 'Pending',  priority: 'Medium',  ui: 3 },
    { subject: 'Webhook payloads not reaching endpoint',         description: 'Customer webhook at https://api.gulfstar.ae/hooks/crm not receiving deal.updated events. No error in logs.', status: 'Open',     priority: 'High',    ui: 4 },
    { subject: 'Slow query on contacts page with 1000+ records', description: 'Page takes 8+ seconds to load for accounts with large contact databases. Need pagination or virtual scroll.', status: 'Open',     priority: 'Medium',  ui: 0 },
    { subject: 'Email template variables not rendering',         description: '{{contact_name}} placeholder showing raw text instead of actual name in outbound campaign emails.', status: 'Resolved', priority: 'High',    ui: 5 },
  ];

  for (const t of ticketsData) {
    await prisma.ticket.create({
      data: { subject: t.subject, description: t.description, status: t.status, priority: t.priority, assigneeId: users[t.ui].id },
    });
  }
  console.log(`Tickets: ${ticketsData.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 10: CAMPAIGNS — 8 marketing campaigns
  // ══════════════════════════════════════════════════════════════
  const campaigns = [
    { name: 'Q1 2026 Product Launch',           status: 'Completed', sent: 14200, opened: 5680, clicked: 1136, budget: 18000 },
    { name: 'Enterprise Webinar: AI in CRM',    status: 'Completed', sent: 8700,  opened: 3480, clicked: 870,  budget: 8500  },
    { name: 'Partner Referral Program Q2',      status: 'Active',    sent: 3200,  opened: 1600, clicked: 480,  budget: 5000  },
    { name: 'Holiday Season Nurture Sequence',  status: 'Draft',     sent: 0,     opened: 0,    clicked: 0,    budget: 12000 },
    { name: 'Competitive Win-Back — Salesforce', status: 'Completed', sent: 5600,  opened: 2240, clicked: 448,  budget: 7200  },
    { name: 'Developer Community Newsletter',   status: 'Active',    sent: 2100,  opened: 1050, clicked: 315,  budget: 3500  },
    { name: 'Q2 2026 Feature Announcement',     status: 'Active',    sent: 9400,  opened: 3760, clicked: 940,  budget: 10000 },
    { name: 'Customer Success Story Campaign',  status: 'Draft',     sent: 0,     opened: 0,    clicked: 0,    budget: 6000  },
  ];

  for (const c of campaigns) {
    await prisma.campaign.create({ data: c });
  }
  console.log(`Campaigns: ${campaigns.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 11: EMAILS — 25 realistic inbox messages
  // ══════════════════════════════════════════════════════════════
  const emailData = [
    { subj: 'Re: Enterprise Pricing — Final Approval',    ci: 0,  dir: 'INBOUND',  read: true,  ago: 1 },
    { subj: 'Meeting Recap: Q1 Business Review',          ci: 7,  dir: 'OUTBOUND', read: true,  ago: 2 },
    { subj: 'Updated Proposal — QuantumLeap AI Platform', ci: 2,  dir: 'OUTBOUND', read: true,  ago: 3 },
    { subj: 'Quick Question About API Rate Limits',       ci: 2,  dir: 'INBOUND',  read: true,  ago: 1 },
    { subj: 'Contract Renewal — 30-Day Notice',           ci: 8,  dir: 'OUTBOUND', read: true,  ago: 5 },
    { subj: 'Welcome to Globussoft CRM!',                 ci: 10, dir: 'OUTBOUND', read: true,  ago: 12 },
    { subj: 'Re: Demo Request — GulfStar Fleet System',   ci: 3,  dir: 'INBOUND',  read: false, ago: 0 },
    { subj: 'Invoice INV-2026-008 Payment Confirmation',  ci: 10, dir: 'INBOUND',  read: true,  ago: 7 },
    { subj: 'Your Support Ticket #3 Update',              ci: 0,  dir: 'OUTBOUND', read: true,  ago: 1 },
    { subj: 'Re: Partnership Opportunity — Lagos FinTech', ci: 20, dir: 'INBOUND', read: false, ago: 0 },
    { subj: 'Invitation: Q2 Strategy Planning Meeting',   ci: 1,  dir: 'OUTBOUND', read: true,  ago: 4 },
    { subj: 'Feedback on Product Demo — Very Impressed',  ci: 13, dir: 'INBOUND',  read: false, ago: 0 },
    { subj: 'Re: Competitive Analysis — HubSpot vs Us',   ci: 12, dir: 'INBOUND',  read: true,  ago: 6 },
    { subj: 'BrightSpark Onboarding Complete — 8 Users',  ci: 5,  dir: 'OUTBOUND', read: true,  ago: 5 },
    { subj: 'Re: Budget Approval for Q2 Expansion',       ci: 14, dir: 'INBOUND',  read: false, ago: 1 },
    { subj: 'Weekly Pipeline Summary — Week 13',          ci: null, dir: 'OUTBOUND', read: true, ago: 2 },
    { subj: 'Integration Setup Guide — Slack + CRM',      ci: 9,  dir: 'OUTBOUND', read: true,  ago: 8 },
    { subj: 'Re: Mobile App Beta Access Request',         ci: 11, dir: 'INBOUND',  read: true,  ago: 10 },
    { subj: 'Urgent: SSO Issue Affecting @techflow.io',   ci: 0,  dir: 'INBOUND',  read: false, ago: 0 },
    { subj: 'Follow-up: GreenLeaf Sustainability Demo',   ci: 13, dir: 'OUTBOUND', read: true,  ago: 3 },
  ];

  for (const e of emailData) {
    const contact = e.ci !== null ? contacts[e.ci] : null;
    const isIn = e.dir === 'INBOUND';
    await prisma.emailMessage.create({
      data: {
        subject: e.subj,
        body: `Hi ${contact ? contact.name.split(' ')[0] : 'Team'},\n\nThank you for your time. I wanted to follow up on our recent conversation and outline the next steps.\n\nPlease don't hesitate to reach out if you have any questions.\n\nBest regards,\n${isIn && contact ? contact.name : 'Globussoft CRM Team'}`,
        from: isIn && contact ? contact.email : 'team@globussoft.com',
        to: isIn ? 'team@globussoft.com' : (contact ? contact.email : 'all@globussoft.com'),
        direction: e.dir, read: e.read,
        contactId: contact ? contact.id : null,
        createdAt: daysAgo(e.ago),
      },
    });
  }
  console.log(`Emails: ${emailData.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 12: EXPENSES — 10 team expenses
  // ══════════════════════════════════════════════════════════════
  const expensesData = [
    { title: 'Flight SFO→NYC for Aspen Group kickoff',    amount: 1250,  cat: 'Travel',    status: 'Approved',    ui: 0, ci: 10, date: daysAgo(12) },
    { title: 'Figma Enterprise annual license',           amount: 2400,  cat: 'Software',  status: 'Approved',    ui: 1, ci: null, date: daysAgo(45) },
    { title: 'SaaS India 2026 conference booth',          amount: 4500,  cat: 'Marketing', status: 'Approved',    ui: 3, ci: null, date: daysAgo(20) },
    { title: 'Standing desk and ergonomic chair',         amount: 680,   cat: 'Office',    status: 'Reimbursed',  ui: 2, ci: null, date: daysAgo(60) },
    { title: 'Client dinner — Pinnacle Ventures team',    amount: 285,   cat: 'General',   status: 'Approved',    ui: 4, ci: 12, date: daysAgo(8) },
    { title: 'Uber rides during Dubai trade show',        amount: 142,   cat: 'Travel',    status: 'Pending',     ui: 3, ci: null, date: daysAgo(3) },
    { title: 'LinkedIn Sales Navigator annual plan',      amount: 1800,  cat: 'Software',  status: 'Pending',     ui: 1, ci: null, date: daysAgo(5) },
    { title: 'Co-working space for Mumbai trip',          amount: 95,    cat: 'Travel',    status: 'Pending',     ui: 0, ci: 9,  date: daysAgo(1) },
    { title: 'Team lunch — product launch celebration',   amount: 320,   cat: 'General',   status: 'Approved',    ui: 0, ci: null, date: daysAgo(30) },
    { title: 'AWS credits for staging environment',       amount: 500,   cat: 'Software',  status: 'Rejected',    ui: 2, ci: null, date: daysAgo(15) },
  ];

  for (const e of expensesData) {
    await prisma.expense.create({
      data: {
        title: e.title, amount: e.amount, category: e.cat, status: e.status,
        expenseDate: e.date, userId: users[e.ui].id,
        contactId: e.ci !== null ? contacts[e.ci].id : null,
      },
    });
  }
  console.log(`Expenses: ${expensesData.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 13: CONTRACTS — 6 enterprise contracts
  // ══════════════════════════════════════════════════════════════
  const contractsData = [
    { title: 'TechFlow Enterprise SLA',        status: 'Active',     value: 125000, ci: 0,  di: 0,  start: '2025-06-01', end: '2026-05-31', terms: 'Annual enterprise SLA: 24/7 priority support, 99.95% uptime, quarterly business reviews, dedicated CSM.' },
    { title: 'QuantumLeap AI Partnership',     status: 'Active',     value: 310000, ci: 2,  di: 2,  start: '2026-01-01', end: '2027-12-31', terms: '2-year partnership: AI model hosting, 50K API calls/month, joint marketing, co-branded case studies.' },
    { title: 'Aspen Group Digital Transform',   status: 'Active',     value: 450000, ci: 10, di: 7,  start: '2026-01-15', end: '2027-01-14', terms: 'Full digital transformation engagement: CRM setup, data migration, 50-user training, 12 months support.' },
    { title: 'BrightHorizon Campaign Retainer', status: 'Active',     value: 42000,  ci: 1,  di: 1,  start: '2026-01-01', end: '2026-12-31', terms: 'Monthly retainer: 10 campaigns/quarter, A/B testing, performance analytics, dedicated campaign manager.' },
    { title: 'EuroTech Legacy Support',         status: 'Expired',    value: 5000,   ci: 14, di: 13, start: '2024-01-01', end: '2025-12-31', terms: 'Legacy v1.x support: critical bug fixes only, 48h response time, no new features.' },
    { title: 'GulfStar Fleet Management',       status: 'Draft',      value: 150000, ci: 3,  di: 8,  start: '2026-05-01', end: '2027-04-30', terms: 'Draft: Fleet management system deployment, GPS tracking for 200 vehicles, real-time analytics dashboard.' },
  ];

  for (const c of contractsData) {
    await prisma.contract.create({
      data: {
        title: c.title, status: c.status, value: c.value, terms: c.terms,
        startDate: new Date(c.start), endDate: new Date(c.end),
        contactId: contacts[c.ci].id, dealId: deals[c.di].id,
      },
    });
  }
  console.log(`Contracts: ${contractsData.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 14: ESTIMATES — 4 with line items
  // ══════════════════════════════════════════════════════════════
  const estimatesData = [
    { num: 'EST-2026-001', title: 'GreenLeaf Sustainability Platform', status: 'Sent', ci: 13, di: 11, valid: daysFromNow(30), notes: 'Includes carbon tracking, ESG reporting, and sustainability dashboard.', items: [
        { description: 'Platform setup and configuration', quantity: 1, unitPrice: 12000 },
        { description: 'Custom sustainability dashboard',  quantity: 1, unitPrice: 18000 },
        { description: 'ESG reporting module',             quantity: 1, unitPrice: 15000 },
        { description: 'Data migration and training',      quantity: 1, unitPrice: 5000 },
    ]},
    { num: 'EST-2026-002', title: 'GulfStar Fleet Management System', status: 'Sent', ci: 3, di: 8, valid: daysFromNow(20), notes: 'GPS tracking for 200+ vehicles with real-time fleet analytics.', items: [
        { description: 'Fleet tracking module (GPS)',      quantity: 200, unitPrice: 350 },
        { description: 'Real-time analytics dashboard',    quantity: 1,   unitPrice: 25000 },
        { description: 'Driver management portal',         quantity: 1,   unitPrice: 18000 },
        { description: 'Mobile app for drivers',           quantity: 1,   unitPrice: 22000 },
        { description: 'Implementation and training',      quantity: 1,   unitPrice: 15000 },
    ]},
    { num: 'EST-2026-003', title: 'Tokyo Robotics R&D License Bundle', status: 'Accepted', ci: 11, di: 9, valid: daysFromNow(45), notes: 'Multi-year volume discount applied. Converting to contract.', items: [
        { description: 'Enterprise R&D license (annual)',  quantity: 5,   unitPrice: 18500 },
        { description: 'Dedicated support engineer',       quantity: 1,   unitPrice: 36000 },
        { description: 'On-site training (2 days)',        quantity: 2,   unitPrice: 7500 },
    ]},
    { num: 'EST-2026-004', title: 'Lagos FinTech Payment Integration', status: 'Draft', ci: 20, di: 12, valid: daysFromNow(60), notes: 'Initial scoping — payment gateway integration for Nigerian market.', items: [
        { description: 'Payment gateway integration',     quantity: 1,   unitPrice: 35000 },
        { description: 'Compliance and security audit',    quantity: 1,   unitPrice: 15000 },
        { description: 'API documentation and SDK',        quantity: 1,   unitPrice: 12000 },
    ]},
  ];

  for (const est of estimatesData) {
    const total = est.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
    await prisma.estimate.create({
      data: {
        estimateNum: est.num, title: est.title, status: est.status, totalAmount: total,
        validUntil: est.valid, notes: est.notes,
        contactId: contacts[est.ci].id, dealId: deals[est.di].id,
        lineItems: { create: est.items },
      },
    });
  }
  console.log(`Estimates: ${estimatesData.length} created (with line items)`);

  // ══════════════════════════════════════════════════════════════
  // STEP 15: PROJECTS — 5 active projects
  // ══════════════════════════════════════════════════════════════
  const projectsData = [
    { name: 'CRM v3.0 Platform Rebuild',           status: 'Active',    priority: 'Critical', budget: 95000,  ui: 0, ci: 0,  di: 0,  start: '2026-01-15', end: '2026-09-30', desc: 'Major platform rebuild: microservices architecture, improved API, real-time collaboration, mobile-first design.' },
    { name: 'GreenLeaf Sustainability Dashboard',   status: 'Planning',  priority: 'High',     budget: 50000,  ui: 1, ci: 13, di: 11, start: '2026-04-15', end: '2026-08-31', desc: 'Custom sustainability dashboard with carbon tracking, ESG metrics, and automated compliance reporting.' },
    { name: 'Mobile App — React Native',            status: 'Active',    priority: 'High',     budget: 65000,  ui: 4, ci: 2,  di: 2,  start: '2026-03-01', end: '2026-08-15', desc: 'Cross-platform mobile app for field sales: pipeline view, contact lookup, offline sync, push notifications.' },
    { name: 'GulfStar Fleet Management Build',      status: 'Planning',  priority: 'Medium',   budget: 150000, ui: 0, ci: 3,  di: 8,  start: '2026-05-01', end: '2026-12-31', desc: 'Full fleet management system: GPS tracking, driver portal, real-time analytics, and mobile companion app.' },
    { name: 'EuroTech Legacy Data Migration',       status: 'Completed', priority: 'Low',      budget: 12000,  ui: 0, ci: 14, di: 13, start: '2025-10-01', end: '2026-01-15', desc: 'Migrated 50K+ records from EuroTech v1 system. Completed ahead of schedule with zero data loss.' },
  ];

  for (const p of projectsData) {
    await prisma.project.create({
      data: {
        name: p.name, description: p.desc, status: p.status, priority: p.priority, budget: p.budget,
        startDate: new Date(p.start), endDate: new Date(p.end),
        ownerId: users[p.ui].id, contactId: contacts[p.ci].id, dealId: deals[p.di].id,
      },
    });
  }
  console.log(`Projects: ${projectsData.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 16: SEQUENCES, PRODUCTS, RULES, INTEGRATIONS
  // ══════════════════════════════════════════════════════════════
  const sequences = [
    { name: 'New Lead 7-Day Nurture', isActive: true,
      nodes: JSON.stringify([{id:'1',type:'input',position:{x:250,y:50},data:{label:'Lead Created'}},{id:'2',type:'default',position:{x:250,y:150},data:{label:'Send Welcome Email'}},{id:'3',type:'default',position:{x:250,y:250},data:{label:'Wait 2 Days'}},{id:'4',type:'default',position:{x:250,y:350},data:{label:'Send Case Study'}},{id:'5',type:'default',position:{x:250,y:450},data:{label:'Wait 3 Days'}},{id:'6',type:'output',position:{x:250,y:550},data:{label:'Book a Demo CTA'}}]),
      edges: JSON.stringify([{id:'e1-2',source:'1',target:'2'},{id:'e2-3',source:'2',target:'3'},{id:'e3-4',source:'3',target:'4'},{id:'e4-5',source:'4',target:'5'},{id:'e5-6',source:'5',target:'6'}]) },
    { name: 'Enterprise Onboarding Flow', isActive: true,
      nodes: JSON.stringify([{id:'1',type:'input',position:{x:250,y:50},data:{label:'Deal Closed Won'}},{id:'2',type:'default',position:{x:250,y:150},data:{label:'Welcome Package Email'}},{id:'3',type:'default',position:{x:250,y:250},data:{label:'Assign CSM'}},{id:'4',type:'default',position:{x:250,y:350},data:{label:'Wait 1 Day'}},{id:'5',type:'default',position:{x:250,y:450},data:{label:'Training Resources'}},{id:'6',type:'output',position:{x:250,y:550},data:{label:'30-Day Check-in'}}]),
      edges: JSON.stringify([{id:'e1-2',source:'1',target:'2'},{id:'e2-3',source:'2',target:'3'},{id:'e3-4',source:'3',target:'4'},{id:'e4-5',source:'4',target:'5'},{id:'e5-6',source:'5',target:'6'}]) },
    { name: 'Win-Back Campaign', isActive: false,
      nodes: JSON.stringify([{id:'1',type:'input',position:{x:250,y:50},data:{label:'Churned 30+ Days'}},{id:'2',type:'default',position:{x:250,y:150},data:{label:'We Miss You Email'}},{id:'3',type:'default',position:{x:250,y:250},data:{label:'Wait 5 Days'}},{id:'4',type:'output',position:{x:250,y:350},data:{label:'Special Offer'}}]),
      edges: JSON.stringify([{id:'e1-2',source:'1',target:'2'},{id:'e2-3',source:'2',target:'3'},{id:'e3-4',source:'3',target:'4'}]) },
  ];
  for (const s of sequences) { await prisma.sequence.create({ data: s }); }
  console.log(`Sequences: ${sequences.length} created`);

  const products = [
    { name: 'CRM Professional',      sku: 'CRM-PRO-001',  price: 49.99,   isRecurring: true,  description: 'Full CRM suite with pipeline, contacts, and reporting' },
    { name: 'CRM Enterprise',        sku: 'CRM-ENT-001',  price: 149.99,  isRecurring: true,  description: 'Enterprise tier: AI scoring, custom objects, API access, SSO' },
    { name: 'CRM Ultimate',          sku: 'CRM-ULT-001',  price: 299.99,  isRecurring: true,  description: 'Everything in Enterprise + dedicated CSM, 99.99% SLA, custom integrations' },
    { name: 'API Access Add-on',     sku: 'API-ADD-001',   price: 29.99,   isRecurring: true,  description: 'RESTful API access with 10K requests/month' },
    { name: 'Premium Support',       sku: 'SUP-PREM-001', price: 99.99,   isRecurring: true,  description: '24/7 priority support with <1hr response time' },
    { name: 'Onboarding Package',    sku: 'SVC-ONB-001',  price: 3500,    isRecurring: false, description: 'White-glove setup: data migration, configuration, 2-day training' },
    { name: 'Custom Integration',    sku: 'SVC-INT-001',  price: 5000,    isRecurring: false, description: 'Custom API integration with your existing tech stack' },
    { name: 'Training Workshop',     sku: 'SVC-TRN-001',  price: 1500,    isRecurring: false, description: 'On-site or virtual training for up to 20 users (2 days)' },
  ];
  for (const p of products) { await prisma.product.upsert({ where: { sku: p.sku }, update: {}, create: p }); }
  console.log(`Products: ${products.length} created`);

  const rules = [
    { name: 'Auto-assign leads with AI score > 80',      triggerType: 'contact.created',  actionType: 'assign_owner',     targetState: 'aiScore > 80',  isActive: true },
    { name: 'Move deal to Won when contract signed',     triggerType: 'contract.signed',  actionType: 'change_stage',     targetState: 'won',           isActive: true },
    { name: 'Send welcome email on new customer',        triggerType: 'contact.converted', actionType: 'send_email',       targetState: 'welcome_email', isActive: true },
    { name: 'Escalate overdue tickets to Urgent',        triggerType: 'ticket.overdue',   actionType: 'change_priority',  targetState: 'Urgent',        isActive: true },
    { name: 'Notify manager when deal > $100K created',  triggerType: 'deal.created',     actionType: 'notify',           targetState: 'amount > 100000', isActive: true },
    { name: 'Archive completed projects after 30 days',  triggerType: 'project.completed', actionType: 'archive',          targetState: '30_days',       isActive: false },
  ];
  for (const r of rules) { await prisma.automationRule.create({ data: r }); }
  console.log(`Automation Rules: ${rules.length} created`);

  const integrations = [
    { provider: 'slack',     isActive: true,  settings: JSON.stringify({ channel: '#crm-notifications', botName: 'CRM Bot', events: ['deal.won', 'ticket.created'] }) },
    { provider: 'google',    isActive: true,  settings: JSON.stringify({ syncCalendar: true, syncContacts: true, domain: 'globussoft.com' }) },
    { provider: 'stripe',    isActive: false, settings: JSON.stringify({ mode: 'test', webhookConfigured: false }) },
    { provider: 'mailchimp', isActive: true,  settings: JSON.stringify({ listId: 'abc123def', audienceSegment: 'Active Customers', doubleOptIn: true }) },
  ];
  for (const i of integrations) { await prisma.integration.upsert({ where: { provider: i.provider }, update: {}, create: i }); }
  console.log(`Integrations: ${integrations.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 17: EMAIL TEMPLATES
  // ══════════════════════════════════════════════════════════════
  const templates = [
    { name: 'Welcome Email', subject: 'Welcome to Globussoft CRM — Let\'s Get Started!', body: '<h2>Welcome aboard, {{contact_name}}!</h2><p>We\'re thrilled to have {{company}} on board. Your account is ready and your team can start using the platform immediately.</p><p><strong>Quick Start:</strong></p><ul><li>Import your contacts</li><li>Set up your pipeline stages</li><li>Connect your email</li></ul><p>Your dedicated CSM will reach out within 24 hours to schedule an onboarding session.</p><p>Best,<br/>The Globussoft Team</p>', category: 'Onboarding' },
    { name: 'Follow-up After Demo', subject: 'Thanks for the Demo — Next Steps', body: '<p>Hi {{contact_name}},</p><p>Great meeting with you and the {{company}} team today! As discussed, here are the next steps:</p><ol><li>I\'ll send over the customized proposal by {{due_date}}</li><li>Technical deep-dive with your engineering team (scheduling link attached)</li><li>30-day pilot access for your team to evaluate</li></ol><p>Feel free to reach out with any questions in the meantime.</p><p>Best regards,<br/>{{sender_name}}</p>', category: 'Sales' },
    { name: 'Proposal Follow-up', subject: 'Following Up on Our Proposal — {{deal_name}}', body: '<p>Hi {{contact_name}},</p><p>I wanted to check in on the proposal we sent over for {{deal_name}}. Has your team had a chance to review it?</p><p>I\'m happy to schedule a call to walk through any questions or discuss adjustments to the scope.</p><p>Looking forward to hearing from you.</p><p>Best,<br/>{{sender_name}}</p>', category: 'Follow-up' },
    { name: 'Contract Renewal Reminder', subject: 'Your {{company}} Contract Renews in 30 Days', body: '<p>Hi {{contact_name}},</p><p>This is a friendly reminder that your contract with Globussoft CRM is set to renew on {{renewal_date}}.</p><p>Over the past year, your team has:</p><ul><li>Closed {{deals_won}} deals worth ${{revenue}}</li><li>Managed {{contacts_count}} contacts</li><li>Sent {{emails_sent}} emails through the platform</li></ul><p>I\'d love to schedule a quick call to discuss renewal terms and any new features you\'d like to explore.</p><p>Best,<br/>{{sender_name}}</p>', category: 'General' },
    { name: 'Support Ticket Resolved', subject: 'Your Support Ticket Has Been Resolved', body: '<p>Hi {{contact_name}},</p><p>Good news — your support ticket <strong>{{ticket_subject}}</strong> has been resolved.</p><p><strong>Resolution:</strong> {{resolution_notes}}</p><p>If you experience any further issues, please don\'t hesitate to reach out. We\'re here to help.</p><p>Best,<br/>Globussoft Support Team</p>', category: 'Support' },
  ];
  for (const t of templates) { await prisma.emailTemplate.create({ data: t }); }
  console.log(`Email Templates: ${templates.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 18: NOTIFICATIONS — Recent activity notifications
  // ══════════════════════════════════════════════════════════════
  const notifs = [
    { title: 'Deal Won!',                  message: 'Aspen Group Digital Transformation closed at $450,000',          type: 'success', userId: users[0].id, ago: 0 },
    { title: 'New Lead Assigned',          message: 'Arjun Krishnan (Bangalore AI Labs) assigned to your pipeline',    type: 'info',    userId: users[0].id, ago: 1 },
    { title: 'Invoice Overdue',            message: 'INV-2026-013 for EuroTech GmbH is 5 days past due ($54,000)',    type: 'warning', userId: users[0].id, ago: 2 },
    { title: 'Ticket Escalated',           message: 'SSO login failing — escalated to Urgent by support team',        type: 'error',   userId: users[0].id, ago: 0 },
    { title: 'Contract Expiring',          message: 'TechFlow Enterprise SLA expires in 30 days — schedule renewal',  type: 'warning', userId: users[0].id, ago: 3 },
    { title: 'New Proposal Sent',          message: 'GulfStar Fleet Management proposal sent to Fatima Al-Hussein',   type: 'info',    userId: users[0].id, ago: 1 },
    { title: 'Task Due Tomorrow',          message: 'Send TechFlow renewal invoice — due April 3',                    type: 'warning', userId: users[3].id, ago: 0 },
    { title: 'Campaign Performance',       message: 'Q2 Feature Announcement: 40% open rate, 10% click-through',     type: 'success', userId: users[1].id, ago: 1 },
    { title: 'Deal Won!',                  message: 'Silverline Consulting Retainer closed at $96,000',               type: 'success', userId: users[0].id, ago: 5 },
    { title: 'New Support Ticket',         message: 'Slow query on contacts page — assigned to Rajesh Sharma',        type: 'info',    userId: users[0].id, ago: 2 },
  ];
  for (const n of notifs) {
    await prisma.notification.create({
      data: { title: n.title, message: n.message, type: n.type, userId: n.userId, isRead: n.ago > 2, createdAt: daysAgo(n.ago) },
    });
  }
  console.log(`Notifications: ${notifs.length} created`);

  // ══════════════════════════════════════════════════════════════
  // STEP 19: AUDIT LOG — Recent system actions
  // ══════════════════════════════════════════════════════════════
  const auditData = [
    { action: 'CREATE', entity: 'Deal',     details: 'Created "Aspen Group Digital Transformation" — $450,000',   ui: 0, ago: 12 },
    { action: 'UPDATE', entity: 'Deal',     details: 'Moved "Aspen Group Digital Transformation" to Won',         ui: 0, ago: 12 },
    { action: 'CREATE', entity: 'Invoice',  details: 'Issued INV-2026-008 for $450,000 to Aspen Group Holdings',  ui: 0, ago: 7 },
    { action: 'UPDATE', entity: 'Invoice',  details: 'Marked INV-2026-008 as PAID',                              ui: 0, ago: 7 },
    { action: 'CREATE', entity: 'Contact',  details: 'Added Arjun Krishnan (Bangalore AI Labs)',                   ui: 2, ago: 3 },
    { action: 'UPDATE', entity: 'Contract', details: 'Activated "QuantumLeap AI Partnership" contract',           ui: 0, ago: 5 },
    { action: 'CREATE', entity: 'Ticket',   details: 'Created "API rate limit exceeded during batch sync"',        ui: 2, ago: 2 },
    { action: 'UPDATE', entity: 'Ticket',   details: 'Resolved "Email template variables not rendering"',          ui: 5, ago: 1 },
    { action: 'DELETE', entity: 'Contact',  details: 'Removed duplicate contact "test@example.com"',              ui: 0, ago: 4 },
    { action: 'CREATE', entity: 'Campaign', details: 'Created "Q2 2026 Feature Announcement" campaign',            ui: 1, ago: 6 },
    { action: 'UPDATE', entity: 'Deal',     details: 'Moved "GulfStar Fleet Management" to Proposal stage',       ui: 0, ago: 1 },
    { action: 'CREATE', entity: 'Estimate', details: 'Created EST-2026-002 for GulfStar Fleet — $150,000',        ui: 0, ago: 1 },
  ];
  for (const a of auditData) {
    await prisma.auditLog.create({
      data: { action: a.action, entity: a.entity, details: a.details, userId: users[a.ui].id, createdAt: daysAgo(a.ago) },
    });
  }
  console.log(`Audit Logs: ${auditData.length} created`);

  // ══════════════════════════════════════════════════════════════
  // DONE
  // ══════════════════════════════════════════════════════════════
  console.log('\n=== Database seeded successfully! ===');
  console.log('  Users: 6  |  Contacts: 30  |  Deals: 24  |  Invoices: 15');
  console.log('  Tasks: 15  |  Tickets: 8  |  Campaigns: 8  |  Projects: 5');
  console.log('  Contracts: 6  |  Estimates: 4  |  Expenses: 10  |  Emails: 20');
  console.log('  Pipeline Stages: 6  |  Products: 8  |  Sequences: 3');
  console.log('  Email Templates: 5  |  Notifications: 10  |  Audit Logs: 12');
  console.log('  Automation Rules: 6  |  Integrations: 4');
}

main()
  .catch((e) => { console.error('Seed failed:', e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
