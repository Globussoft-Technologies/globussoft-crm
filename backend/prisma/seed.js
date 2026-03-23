const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  await prisma.user.create({
    data: { email: 'admin@globussoft.com', password: 'password123', role: 'admin' }
  });

  const alice = await prisma.contact.create({
    data: { name: 'Alice Cooper', email: 'alice@example.com', company: 'TechCorp', title: 'CEO', status: 'Customer' }
  });

  await prisma.contact.create({
    data: { name: 'Bob Smith', email: 'bob@example.com', company: 'Initech', title: 'Sales Director', status: 'Lead' }
  });

  await prisma.activity.create({
    data: { type: 'Email', description: 'Proposal Attached', contactId: alice.id }
  });

  await prisma.deal.createMany({
    data: [
      { title: 'Enterprise Software License', company: 'TechCorp', amount: 45000, probability: 50, stage: 'lead' },
      { title: 'Cloud Migration Project', company: 'Initech', amount: 120000, probability: 75, stage: 'contacted' },
      { title: 'Annual Support Contract', company: 'Globex', amount: 15000, probability: 90, stage: 'proposal' },
      { title: 'Security Audit', company: 'Stark Industries', amount: 25000, probability: 100, stage: 'won' }
    ]
  });

  await prisma.ticket.createMany({
    data: [
      { subject: 'Cannot access billing portal', requester: 'Alice Cooper', status: 'Open', priority: 'High', lastUpdated: '10 mins ago' },
      { subject: 'Feature Request: Custom fields', requester: 'Bob Smith', status: 'Closed', priority: 'Low', lastUpdated: '2 days ago' }
    ]
  });

  await prisma.campaign.createMany({
    data: [
      { name: 'Q4 Enterprise Outreach', status: 'Running', sent: 5000, opened: 42, clicked: 12 },
      { name: 'Inactive Leads Nurture', status: 'Draft', sent: 0, opened: 0, clicked: 0 }
    ]
  });

  console.log("Database seeded successfully!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
