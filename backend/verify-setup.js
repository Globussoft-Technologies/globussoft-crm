const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  try {
    console.log('=== Verifying Setup ===\n');

    // Check user
    const user = await prisma.user.findFirst({
      where: { email: 'ganeshsharmayoyo@gmail.com' },
      include: { tenant: { select: { name: true } } }
    });

    if (user) {
      console.log('✅ User Found:');
      console.log(`   Email: ${user.email}`);
      console.log(`   Name: ${user.name}`);
      console.log(`   Role: ${user.role}`);
      console.log(`   Tenant: ${user.tenant.name}\n`);
    } else {
      console.log('❌ User not found\n');
      process.exit(1);
    }

    // Check services
    const services = await prisma.service.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true, name: true }
    });

    console.log(`✅ Services (${services.length}):`);
    services.forEach(s => console.log(`   - ${s.name}`));

    // Check products
    const products = await prisma.product.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true, name: true }
    });

    console.log(`\n✅ Products (${products.length}):`);
    products.slice(0, 10).forEach(p => console.log(`   - ${p.name}`));

    // Check auto-consumption rules
    const rules = await prisma.autoConsumptionRule.findMany({
      where: { tenantId: user.tenantId },
      include: {
        service: { select: { name: true } },
        product: { select: { name: true } }
      }
    });

    console.log(`\n✅ Auto-Consumption Rules (${rules.length}):`);
    rules.forEach((r, i) => {
      console.log(`   ${i + 1}. ${r.service.name} → ${r.product.name} (x${r.quantityPerVisit})`);
    });

    console.log('\n✅ Setup verification complete!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
