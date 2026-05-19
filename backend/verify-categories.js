const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

(async () => {
  try {
    console.log('=== Service Categories Verification ===\n');

    const tenant = await prisma.tenant.findFirst({
      where: { vertical: 'wellness' }
    });

    console.log(`✅ Wellness Tenant: ${tenant.name}\n`);

    // Get all categories
    const categories = await prisma.serviceCategory.findMany({
      where: { tenantId: tenant.id },
      include: { children: true },
      orderBy: { createdAt: 'asc' }
    });

    console.log(`✅ Total Service Categories: ${categories.length}\n`);

    const parents = categories.filter(c => !c.parentId);
    const children = categories.filter(c => c.parentId);

    console.log(`📁 Parent Categories (${parents.length}):`);
    parents.forEach(c => {
      console.log(`   - ${c.name} (${c.children.length} children)`);
    });

    console.log(`\n📄 Child Categories (${children.length}):`);
    children.forEach(c => {
      const parent = categories.find(p => p.id === c.parentId);
      console.log(`   - ${c.name} → ${parent?.name || 'Unknown'}`);
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
