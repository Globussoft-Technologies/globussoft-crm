// One-time cleanup for issue #277 — Visit rows with absurd amountCharged
// (≥ ₹1 crore) that survived from before the per-visit ₹50L cap shipped.
// Same root as the #218 "Z" service ₹1e15 pollution: a test that booked
// against the bad service inherited the bad price into Visit.amountCharged.
//
// Strategy: NULL out amountCharged on the offending rows (don't delete the
// visit — clinical artifacts are permanent per the #21 policy). The dashboard
// sum() coerces null to 0 so the 'Today's expected revenue' tile recovers.
//
// Idempotent (a second run finds zero rows).
const prisma = require("../lib/prisma");

const CAP = 5_000_000; // ₹50L — matches POST/PUT validator cap

(async () => {
  const polluted = await prisma.visit.findMany({
    where: { amountCharged: { gt: CAP } },
    select: { id: true, tenantId: true, patientId: true, serviceId: true, status: true, amountCharged: true, visitDate: true },
  });
  console.log(`Found ${polluted.length} visits with amountCharged > ₹${CAP.toLocaleString("en-IN")}`);
  for (const v of polluted) {
    console.log(`  id=${v.id} tenant=${v.tenantId} patient=${v.patientId} service=${v.serviceId} status=${v.status} amount=${v.amountCharged} visitDate=${v.visitDate.toISOString()}`);
  }
  if (polluted.length === 0) {
    console.log("Nothing to do.");
    await prisma.$disconnect();
    return;
  }
  const result = await prisma.visit.updateMany({
    where: { amountCharged: { gt: CAP } },
    data: { amountCharged: null },
  });
  console.log(`Nulled amountCharged on ${result.count} visits.`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
