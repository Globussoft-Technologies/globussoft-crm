/**
 * Seed script — populates the MySQL database with realistic CRM demo data.
 * Run: node prisma/seed.js
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Globussoft CRM database...\n');

  // ── Users ──────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash('password123', 10);

  const users = await Promise.all([
    prisma.user.upsert({ where: { email: 'admin@globussoft.com' },  update: {}, create: { email: 'admin@globussoft.com',  password: passwordHash, role: 'ADMIN',   name: 'Rajesh Sharma' } }),
    prisma.user.upsert({ where: { email: 'manager@crm.com' },      update: {}, create: { email: 'manager@crm.com',      password: passwordHash, role: 'MANAGER', name: 'Priya Patel' } }),
    prisma.user.upsert({ where: { email: 'user@crm.com' },         update: {}, create: { email: 'user@crm.com',         password: passwordHash, role: 'USER',    name: 'Amit Singh' } }),
    prisma.user.upsert({ where: { email: 'sales@globussoft.com' },  update: {}, create: { email: 'sales@globussoft.com',  password: passwordHash, role: 'USER',    name: 'Sneha Reddy' } }),
    prisma.user.upsert({ where: { email: 'ops@globussoft.com' },    update: {}, create: { email: 'ops@globussoft.com',    password: passwordHash, role: 'MANAGER', name: 'Vikram Joshi' } }),
  ]);
  console.log(`✅ ${users.length} users seeded`);

  // ── Contacts ───────────────────────────────────────────────
  const contactsData = [
    { name: 'Sarah Chen',        email: 'sarah.chen@techflow.io',       company: 'TechFlow Solutions',    title: 'VP Engineering',      status: 'Customer',  source: 'Referral',  aiScore: 92 },
    { name: 'Marcus Johnson',    email: 'marcus@pinnacle.co',           company: 'Pinnacle Ventures',     title: 'Managing Partner',    status: 'Prospect',  source: 'LinkedIn',  aiScore: 87 },
    { name: 'Elena Rodriguez',   email: 'elena@brighthorizon.com',      company: 'BrightHorizon Media',   title: 'CMO',                 status: 'Customer',  source: 'Webinar',   aiScore: 95 },
    { name: 'James O\'Brien',    email: 'jobrien@cloudnine.dev',        company: 'CloudNine Dev',         title: 'CTO',                 status: 'Lead',      source: 'Organic',   aiScore: 64 },
    { name: 'Aisha Patel',       email: 'aisha@greenleaf.eco',          company: 'GreenLeaf Eco',         title: 'CEO',                 status: 'Prospect',  source: 'Conference', aiScore: 78 },
    { name: 'David Kim',         email: 'dkim@quantumleap.ai',          company: 'QuantumLeap AI',        title: 'Head of Product',     status: 'Customer',  source: 'Partner',   aiScore: 91 },
    { name: 'Maria Santos',      email: 'maria@solarbright.energy',     company: 'SolarBright Energy',    title: 'Director of Ops',     status: 'Lead',      source: 'Cold Call', aiScore: 45 },
    { name: 'Thomas Müller',     email: 'thomas@eurotech.de',           company: 'EuroTech GmbH',         title: 'Sales Director',      status: 'Prospect',  source: 'Trade Show', aiScore: 73 },
    { name: 'Fatima Al-Hussein', email: 'fatima@gulfstar.ae',           company: 'GulfStar Trading',      title: 'Procurement Manager', status: 'Customer',  source: 'Referral',  aiScore: 88 },
    { name: 'Ryan Cooper',       email: 'ryan@nexgenfintech.com',       company: 'NexGen FinTech',        title: 'CFO',                 status: 'Lead',      source: 'Organic',   aiScore: 56 },
    { name: 'Li Wei',            email: 'liwei@shenzhen-micro.cn',      company: 'Shenzhen Micro',        title: 'Engineering Lead',    status: 'Customer',  source: 'LinkedIn',  aiScore: 82 },
    { name: 'Nina Petrov',       email: 'nina@balticventures.io',       company: 'Baltic Ventures',       title: 'Investment Analyst',  status: 'Prospect',  source: 'Webinar',   aiScore: 69 },
    { name: 'Carlos Mendez',     email: 'carlos@latamlogistics.com',    company: 'LatAm Logistics',       title: 'VP Supply Chain',     status: 'Lead',      source: 'Conference', aiScore: 41 },
    { name: 'Emily Watson',      email: 'emily@brightspark.edu',        company: 'BrightSpark Academy',   title: 'Director',            status: 'Customer',  source: 'Referral',  aiScore: 93 },
    { name: 'Kenji Tanaka',      email: 'kenji@tokyorobotics.jp',       company: 'Tokyo Robotics',        title: 'CTO',                 status: 'Prospect',  source: 'Partner',   aiScore: 77 },
    { name: 'Sophie Laurent',    email: 'sophie@parisian.agency',       company: 'Parisian Agency',       title: 'Creative Director',   status: 'Lead',      source: 'Organic',   aiScore: 52 },
    { name: 'Ahmed Hassan',      email: 'ahmed@cairoinnovate.com',      company: 'Cairo Innovate',        title: 'Founder & CEO',       status: 'Customer',  source: 'Cold Call', aiScore: 86 },
    { name: 'Jessica Morgan',    email: 'jessica@westcoasthr.com',      company: 'WestCoast HR',          title: 'HR Director',         status: 'Prospect',  source: 'LinkedIn',  aiScore: 71 },
    { name: 'Oleg Volkov',       email: 'oleg@slavicsoft.dev',          company: 'SlavicSoft',            title: 'Lead Architect',      status: 'Lead',      source: 'GitHub',    aiScore: 63 },
    { name: 'Amanda Brooks',     email: 'amanda@silverline.co',         company: 'Silverline Consulting', title: 'Managing Director',   status: 'Customer',  source: 'Referral',  aiScore: 96 },
  ];

  const contacts = [];
  for (const c of contactsData) {
    const contact = await prisma.contact.upsert({
      where: { email: c.email },
      update: {},
      create: c,
    });
    contacts.push(contact);
  }
  console.log(`✅ ${contacts.length} contacts seeded`);

  // ── Deals ──────────────────────────────────────────────────
  const dealsData = [
    { title: 'TechFlow Enterprise License',       amount: 125000, probability: 90, stage: 'won',       contactIdx: 0,  ownerIdx: 0 },
    { title: 'Pinnacle Series B Analytics',        amount: 85000,  probability: 65, stage: 'proposal',  contactIdx: 1,  ownerIdx: 1 },
    { title: 'BrightHorizon Campaign Suite',       amount: 42000,  probability: 95, stage: 'won',       contactIdx: 2,  ownerIdx: 3 },
    { title: 'CloudNine Infrastructure Deal',      amount: 200000, probability: 30, stage: 'lead',      contactIdx: 3,  ownerIdx: 0 },
    { title: 'GreenLeaf Sustainability Platform',  amount: 67000,  probability: 55, stage: 'contacted', contactIdx: 4,  ownerIdx: 1 },
    { title: 'QuantumLeap AI Integration',         amount: 310000, probability: 85, stage: 'proposal',  contactIdx: 5,  ownerIdx: 0 },
    { title: 'SolarBright IoT Monitoring',         amount: 18000,  probability: 20, stage: 'lead',      contactIdx: 6,  ownerIdx: 3 },
    { title: 'EuroTech Expansion Pack',            amount: 54000,  probability: 70, stage: 'contacted', contactIdx: 7,  ownerIdx: 4 },
    { title: 'GulfStar Fleet Management',          amount: 150000, probability: 80, stage: 'proposal',  contactIdx: 8,  ownerIdx: 0 },
    { title: 'NexGen Compliance Module',           amount: 95000,  probability: 40, stage: 'contacted', contactIdx: 9,  ownerIdx: 1 },
    { title: 'Shenzhen Hardware Partnership',      amount: 275000, probability: 88, stage: 'won',       contactIdx: 10, ownerIdx: 0 },
    { title: 'Baltic Ventures Portfolio Tool',     amount: 38000,  probability: 50, stage: 'lead',      contactIdx: 11, ownerIdx: 3 },
    { title: 'BrightSpark LMS Enterprise',         amount: 72000,  probability: 92, stage: 'won',       contactIdx: 13, ownerIdx: 1 },
    { title: 'Tokyo Robotics R&D License',         amount: 185000, probability: 60, stage: 'proposal',  contactIdx: 14, ownerIdx: 4 },
    { title: 'Silverline Consulting Retainer',     amount: 96000,  probability: 98, stage: 'won',       contactIdx: 19, ownerIdx: 0 },
    { title: 'Cairo Innovate Startup Bundle',      amount: 22000,  probability: 75, stage: 'contacted', contactIdx: 16, ownerIdx: 3 },
    { title: 'LatAm Logistics Tracking',           amount: 33000,  probability: 15, stage: 'lost',      contactIdx: 12, ownerIdx: 1 },
    { title: 'Parisian Agency Creative Suite',     amount: 28000,  probability: 35, stage: 'lead',      contactIdx: 15, ownerIdx: 3 },
  ];

  const deals = [];
  for (const d of dealsData) {
    const deal = await prisma.deal.create({
      data: {
        title: d.title,
        amount: d.amount,
        probability: d.probability,
        stage: d.stage,
        contactId: contacts[d.contactIdx].id,
        ownerId: users[d.ownerIdx].id,
        expectedClose: new Date(Date.now() + Math.random() * 90 * 24 * 60 * 60 * 1000),
      },
    });
    deals.push(deal);
  }
  console.log(`✅ ${deals.length} deals seeded`);

  // ── Activities ─────────────────────────────────────────────
  const activityTypes = ['Email', 'Call', 'Meeting', 'Note'];
  const activityDescriptions = [
    'Initial discovery call — discussed pain points and timeline',
    'Sent product demo video and pricing sheet',
    'Follow-up meeting to review technical requirements',
    'Proposal walkthrough with decision makers',
    'Negotiation on volume discount terms',
    'Quarterly business review completed',
    'Discussed integration timeline with engineering',
    'Left voicemail — will follow up Thursday',
    'Onboarding kickoff session scheduled',
    'Renewed contract discussion — upsell opportunity',
    'Discussed competitive landscape and positioning',
    'Technical deep-dive with CTO on architecture',
    'Sent case study from similar customer segment',
    'Budget approval meeting with CFO',
    'Demo of new features launching Q2',
  ];

  let activityCount = 0;
  for (const contact of contacts) {
    const numActivities = 2 + Math.floor(Math.random() * 5);
    for (let i = 0; i < numActivities; i++) {
      await prisma.activity.create({
        data: {
          type: activityTypes[Math.floor(Math.random() * activityTypes.length)],
          description: activityDescriptions[Math.floor(Math.random() * activityDescriptions.length)],
          contactId: contact.id,
          createdAt: new Date(Date.now() - Math.random() * 60 * 24 * 60 * 60 * 1000),
        },
      });
      activityCount++;
    }
  }
  console.log(`✅ ${activityCount} activities seeded`);

  // ── Tasks ──────────────────────────────────────────────────
  const taskTitles = [
    'Send follow-up proposal',
    'Schedule product demo',
    'Review contract terms',
    'Prepare quarterly report',
    'Update CRM notes',
    'Call to discuss renewal',
    'Send pricing comparison',
    'Coordinate with engineering',
    'Book travel for client visit',
    'Draft partnership agreement',
  ];

  let taskCount = 0;
  for (let i = 0; i < 15; i++) {
    await prisma.task.create({
      data: {
        title: taskTitles[i % taskTitles.length],
        status: Math.random() > 0.4 ? 'Pending' : 'Completed',
        notes: Math.random() > 0.5 ? 'High priority — client expecting by EOW' : null,
        dueDate: new Date(Date.now() + (Math.random() * 14 - 3) * 24 * 60 * 60 * 1000),
        contactId: contacts[Math.floor(Math.random() * contacts.length)].id,
        userId: users[Math.floor(Math.random() * users.length)].id,
      },
    });
    taskCount++;
  }
  console.log(`✅ ${taskCount} tasks seeded`);

  // ── Campaigns ──────────────────────────────────────────────
  const campaigns = [
    { name: 'Q1 Product Launch Blitz',        status: 'Completed', sent: 12500, opened: 4200, clicked: 890,  budget: 15000 },
    { name: 'Enterprise Webinar Series',       status: 'Active',    sent: 8700,  opened: 3100, clicked: 620,  budget: 8500  },
    { name: 'Partner Referral Program',        status: 'Active',    sent: 3200,  opened: 1400, clicked: 380,  budget: 5000  },
    { name: 'Holiday Season Nurture',          status: 'Draft',     sent: 0,     opened: 0,    clicked: 0,    budget: 12000 },
    { name: 'Competitive Win-Back Campaign',   status: 'Completed', sent: 5600,  opened: 1900, clicked: 310,  budget: 7200  },
    { name: 'Developer Community Outreach',    status: 'Active',    sent: 2100,  opened: 980,  clicked: 245,  budget: 3500  },
  ];

  for (const c of campaigns) {
    await prisma.campaign.create({ data: c });
  }
  console.log(`✅ ${campaigns.length} campaigns seeded`);

  // ── Tickets ────────────────────────────────────────────────
  const tickets = [
    { subject: 'API rate limit exceeded',              description: 'Customer hitting 429 errors on /api/contacts endpoint during peak hours', status: 'Open',     priority: 'High',   assigneeId: users[2].id },
    { subject: 'Dashboard charts not loading',         description: 'Recharts components throwing null data error on initial render',           status: 'Pending',  priority: 'Medium', assigneeId: users[0].id },
    { subject: 'SSO integration broken after update',  description: 'OAuth2 callback failing with invalid_grant error since v2.0 deploy',      status: 'Open',     priority: 'Urgent', assigneeId: users[0].id },
    { subject: 'Export to CSV missing columns',        description: 'Contact export omits aiScore and source fields',                          status: 'Resolved', priority: 'Low',    assigneeId: users[2].id },
    { subject: 'Mobile layout misaligned on pipeline', description: 'Kanban cards overlap on screens < 375px width',                           status: 'Pending',  priority: 'Medium', assigneeId: users[3].id },
    { subject: 'Webhook delivery failing silently',    description: 'Event payloads not reaching customer endpoint — no error logs',            status: 'Open',     priority: 'High',   assigneeId: users[4].id },
  ];

  for (const t of tickets) {
    await prisma.ticket.create({ data: t });
  }
  console.log(`✅ ${tickets.length} tickets seeded`);

  // ── Invoices ───────────────────────────────────────────────
  const invoiceStatuses = ['PAID', 'UNPAID', 'OVERDUE'];
  const invoiceTimestamp = Date.now();
  let invoiceCount = 0;
  const customerContacts = contacts.filter(c => ['Customer'].includes(c.status));
  for (let i = 0; i < 12; i++) {
    const contact = customerContacts[i % customerContacts.length];
    const deal = deals.find(d => d.contactId === contact.id);
    await prisma.invoice.create({
      data: {
        invoiceNum: `INV-${invoiceTimestamp}-${String(i + 1).padStart(4, '0')}`,
        amount: 5000 + Math.floor(Math.random() * 50000),
        status: invoiceStatuses[Math.floor(Math.random() * invoiceStatuses.length)],
        dueDate: new Date(Date.now() + (Math.random() * 60 - 30) * 24 * 60 * 60 * 1000),
        contactId: contact.id,
        dealId: deal ? deal.id : null,
      },
    });
    invoiceCount++;
  }
  console.log(`✅ ${invoiceCount} invoices seeded`);

  // ── Email Messages ─────────────────────────────────────────
  const emailSubjects = [
    'Re: Proposal Review — Next Steps',
    'Meeting Recap & Action Items',
    'Updated Pricing for Enterprise Tier',
    'Quick Question About Integration',
    'Contract Renewal — 30 Day Notice',
    'Welcome to Globussoft CRM!',
    'Your Support Ticket #4521 Update',
    'Invitation: Q2 Strategy Planning',
  ];

  let emailCount = 0;
  for (let i = 0; i < 20; i++) {
    const contact = contacts[Math.floor(Math.random() * contacts.length)];
    const isInbound = Math.random() > 0.5;
    await prisma.emailMessage.create({
      data: {
        subject: emailSubjects[Math.floor(Math.random() * emailSubjects.length)],
        body: `Hi ${contact.name.split(' ')[0]},\n\nThank you for your time today. I wanted to follow up on our conversation and share the next steps.\n\nBest regards,\n${isInbound ? contact.name : 'Globussoft Team'}`,
        from: isInbound ? contact.email : 'team@globussoft.com',
        to: isInbound ? 'team@globussoft.com' : contact.email,
        direction: isInbound ? 'INBOUND' : 'OUTBOUND',
        read: Math.random() > 0.3,
        contactId: contact.id,
        createdAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000),
      },
    });
    emailCount++;
  }
  console.log(`✅ ${emailCount} emails seeded`);

  // ── Integrations ───────────────────────────────────────────
  const integrations = [
    { provider: 'slack',      isActive: true,  settings: JSON.stringify({ channel: '#crm-alerts', notifications: true }) },
    { provider: 'google',     isActive: true,  settings: JSON.stringify({ syncCalendar: true, syncContacts: false }) },
    { provider: 'stripe',     isActive: false, settings: JSON.stringify({ mode: 'test' }) },
    { provider: 'mailchimp',  isActive: true,  settings: JSON.stringify({ listId: 'abc123', doubleOptIn: true }) },
  ];

  for (const integ of integrations) {
    await prisma.integration.upsert({
      where: { provider: integ.provider },
      update: {},
      create: integ,
    });
  }
  console.log(`✅ ${integrations.length} integrations seeded`);

  // ── Sequences ──────────────────────────────────────────────
  const sequences = [
    { name: 'New Lead Nurture (7-day)', isActive: true,  nodes: JSON.stringify([{id:'1',type:'email',data:{label:'Welcome Email'}},{id:'2',type:'wait',data:{label:'Wait 2 days'}},{id:'3',type:'email',data:{label:'Case Study'}},{id:'4',type:'wait',data:{label:'Wait 3 days'}},{id:'5',type:'email',data:{label:'Book a Demo'}}]), edges: JSON.stringify([{source:'1',target:'2'},{source:'2',target:'3'},{source:'3',target:'4'},{source:'4',target:'5'}]) },
    { name: 'Enterprise Onboarding',    isActive: true,  nodes: JSON.stringify([{id:'1',type:'email',data:{label:'Welcome Package'}},{id:'2',type:'task',data:{label:'Assign CSM'}},{id:'3',type:'wait',data:{label:'Wait 1 day'}},{id:'4',type:'email',data:{label:'Training Resources'}}]), edges: JSON.stringify([{source:'1',target:'2'},{source:'2',target:'3'},{source:'3',target:'4'}]) },
    { name: 'Win-Back Campaign',        isActive: false, nodes: JSON.stringify([{id:'1',type:'email',data:{label:'We miss you'}},{id:'2',type:'wait',data:{label:'Wait 5 days'}},{id:'3',type:'email',data:{label:'Special Offer'}}]), edges: JSON.stringify([{source:'1',target:'2'},{source:'2',target:'3'}]) },
  ];

  for (const seq of sequences) {
    await prisma.sequence.create({ data: seq });
  }
  console.log(`✅ ${sequences.length} sequences seeded`);

  // ── Products (CPQ) ─────────────────────────────────────────
  const products = [
    { name: 'CRM Professional',    sku: 'CRM-PRO-001',   price: 49.99,  isRecurring: true,  description: 'Full CRM suite with pipeline and reporting' },
    { name: 'CRM Enterprise',      sku: 'CRM-ENT-001',   price: 149.99, isRecurring: true,  description: 'Enterprise tier with AI scoring and custom objects' },
    { name: 'API Access Add-on',   sku: 'API-ADD-001',    price: 29.99,  isRecurring: true,  description: 'RESTful API access with 10K monthly requests' },
    { name: 'Onboarding Package',  sku: 'SVC-ONB-001',    price: 2500,   isRecurring: false, description: 'White-glove setup with data migration' },
    { name: 'Training Workshop',   sku: 'SVC-TRN-001',    price: 1500,   isRecurring: false, description: '2-day on-site training for up to 20 users' },
    { name: 'Premium Support',     sku: 'SUP-PREM-001',   price: 99.99,  isRecurring: true,  description: '24/7 priority support with dedicated CSM' },
  ];

  for (const p of products) {
    await prisma.product.upsert({ where: { sku: p.sku }, update: {}, create: p });
  }
  console.log(`✅ ${products.length} products seeded`);

  // ── Automation Rules ──────────────────────────────────────
  const rules = [
    { name: 'Auto-assign high-score leads',            triggerType: 'contact.created',  actionType: 'assign_owner',     targetState: 'aiScore > 80', isActive: true },
    { name: 'Move deal to won on contract signed',     triggerType: 'deal.updated',     actionType: 'change_stage',     targetState: 'won',          isActive: true },
    { name: 'Send welcome email on signup',            triggerType: 'contact.created',  actionType: 'send_email',       targetState: 'welcome',      isActive: true },
    { name: 'Escalate overdue tickets',                triggerType: 'ticket.overdue',   actionType: 'change_priority',  targetState: 'Urgent',       isActive: false },
  ];

  for (const r of rules) {
    await prisma.automationRule.create({ data: r });
  }
  console.log(`✅ ${rules.length} automation rules seeded`);

  console.log('\n🎉 Database seeded successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
