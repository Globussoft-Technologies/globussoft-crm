const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  console.log('=== Checking Auto-Consumption Rules ===\n');

  const rules = await prisma.autoConsumptionRule.findMany({
    include: {
      service: { select: { id: true, name: true, tenantId: true } },
      product: { select: { id: true, name: true, tenantId: true } }
    }
  });

  console.log(`Total rules found: ${rules.length}\n`);

  if (rules.length === 0) {
    console.log('❌ No auto-consumption rules found!');
  } else {
    rules.forEach((rule, idx) => {
      console.log(`${idx + 1}. Service: ${rule.service.name} (ID: ${rule.service.id}, Tenant: ${rule.service.tenantId})`);
      console.log(`   Product: ${rule.product.name} (ID: ${rule.product.id}, Tenant: ${rule.product.tenantId})`);
      console.log(`   Quantity per visit: ${rule.quantityPerVisit}`);
      console.log(`   Rule Tenant ID: ${rule.tenantId}\n`);
    });
  }

  // Check if services exist
  console.log('\n=== Checking Services ===\n');
  const services = await prisma.service.findMany({
    select: { id: true, name: true, tenantId: true }
  });
  console.log(`Total services: ${services.length}`);
  services.forEach(s => console.log(`  - ${s.name} (ID: ${s.id}, Tenant: ${s.tenantId})`));

  // Check if products exist
  console.log('\n=== Checking Products ===\n');
  const products = await prisma.product.findMany({
    select: { id: true, name: true, tenantId: true }
  });
  console.log(`Total products: ${products.length}`);
  products.slice(0, 5).forEach(p => console.log(`  - ${p.name} (ID: ${p.id}, Tenant: ${p.tenantId})`));
  if (products.length > 5) console.log(`  ... and ${products.length - 5} more`);

  await prisma.$disconnect();
})();
