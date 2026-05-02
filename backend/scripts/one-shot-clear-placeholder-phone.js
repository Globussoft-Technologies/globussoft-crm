// One-shot: clear the phone on Patient.id=471 (name="(deleted-by-qa)")
// so the (tenantId, normalizedPhone) @@unique constraint can be applied
// without conflict against the real "X" / id=249 row carrying the same
// phone "9999999999". Both rows are pre-existing QA placeholder data.
//
// After this runs, re-run backfill — should land cleanly with zero
// collisions. This file can be deleted after one use.
const { PrismaClient } = require('@prisma/client');
(async () => {
  const prisma = new PrismaClient();
  const r = await prisma.patient.update({
    where: { id: 471 },
    data: { phone: null, normalizedPhone: null },
  });
  console.log(`updated id=${r.id} name=${JSON.stringify(r.name)} → phone=null normalizedPhone=null`);
  await prisma.$disconnect();
})();
