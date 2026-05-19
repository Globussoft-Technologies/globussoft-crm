const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

(async () => {
  const user = await prisma.user.findFirst({
    where: { email: 'ganeshsharmayoyo@gmail.com' },
    include: { tenant: true }
  });

  if (!user) {
    console.log('❌ User not found');
    process.exit(1);
  }

  console.log('✅ User Details:');
  console.log(`   Email: ${user.email}`);
  console.log(`   Tenant: ${user.tenant.name} (ID: ${user.tenantId})`);

  const patientCount = await prisma.patient.count({
    where: { tenantId: user.tenantId }
  });

  console.log(`\n✅ Patients on user's tenant: ${patientCount}`);

  const samplePatients = await prisma.patient.findMany({
    where: { tenantId: user.tenantId },
    select: { id: true, name: true, email: true, phone: true, gender: true },
    take: 5
  });

  console.log(`\n✅ Sample Patients:`);
  samplePatients.forEach((p, i) => {
    console.log(`   ${i + 1}. ${p.name} - ${p.email || p.phone || 'no contact'}`);
  });

  console.log('\n✅ Setup complete! All data is ready for the user account.');

  await prisma.$disconnect();
})();
