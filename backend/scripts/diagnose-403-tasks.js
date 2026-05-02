// Diagnostic for issue #403 — find tasks matching `^Tenant B scoped` and
// report their tenantId distribution. If they're all tenantId != 2 (wellness),
// the bug is in the GET /api/tasks query (cross-tenant leak). If some are
// tenantId == 2, the bug is data-level (a previous run created the task
// under wellness, residue).
const { PrismaClient } = require('@prisma/client');
(async () => {
  const prisma = new PrismaClient();
  const rows = await prisma.task.findMany({
    where: { title: { startsWith: 'Tenant B scoped' } },
    select: { id: true, title: true, tenantId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  console.log(`Tasks matching ^Tenant B scoped: ${rows.length}`);
  const byTenant = {};
  for (const r of rows) {
    byTenant[r.tenantId] = (byTenant[r.tenantId] || 0) + 1;
  }
  console.log('By tenantId:', byTenant);
  console.log('\nMost-recent 10:');
  for (const r of rows.slice(0, 10)) {
    console.log(`  id=${r.id}  tenantId=${r.tenantId}  ${r.createdAt.toISOString().slice(0, 19)}  ${JSON.stringify(r.title).slice(0, 70)}`);
  }
  await prisma.$disconnect();
})();
