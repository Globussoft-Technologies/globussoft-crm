// Diagnostic: find Patient rows whose normalizedPhone would collide
// within their tenant. Run AFTER backfill to see what the @@unique
// constraint blocked. Read-only.
const { PrismaClient } = require('@prisma/client');
const { normalizePhone } = require('../utils/deduplication');

const TENANT_ID = parseInt(process.env.TENANT_ID || '2', 10);

(async () => {
  const prisma = new PrismaClient();
  const all = await prisma.patient.findMany({
    where: { tenantId: TENANT_ID, phone: { not: null } },
    select: { id: true, name: true, phone: true, normalizedPhone: true, createdAt: true },
  });
  const byPhone = {};
  for (const p of all) {
    const k = normalizePhone(p.phone);
    if (!k) continue;
    (byPhone[k] = byPhone[k] || []).push(p);
  }
  let groups = 0;
  for (const [k, group] of Object.entries(byPhone)) {
    if (group.length > 1) {
      groups++;
      console.log(`phone normalized=${k} (${group.length} patients):`);
      for (const p of group) {
        console.log(`  id=${p.id}  name=${JSON.stringify(p.name)}  phone=${p.phone}  normPhone=${p.normalizedPhone}  created=${p.createdAt.toISOString().slice(0,10)}`);
      }
    }
  }
  console.log(`\nTotal collision groups: ${groups}`);
  await prisma.$disconnect();
})();
