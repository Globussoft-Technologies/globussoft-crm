// One-time cleanup for issue #218 — removes Service rows with absurd
// price/duration that survived from before the #209 caps shipped.
// Idempotent (a second run finds zero rows).
const prisma = require("../lib/prisma");

(async () => {
  const where = {
    OR: [
      { name: { equals: "Z" } },
      { basePrice: { gt: 5_000_000 } },
      { durationMin: { gt: 720 } },
      // Test pollution: rows with the literal "Test Consultation" prefix
      // accumulated by automated tests at duration 6030 (clearly bogus).
      { name: { startsWith: "Test Consultation " } },
    ],
  };
  const before = await prisma.service.findMany({ where, select: { id: true, name: true, basePrice: true, durationMin: true, tenantId: true } });
  console.log(`Found ${before.length} corrupt services:`, before);
  if (before.length === 0) {
    console.log("Nothing to do.");
    await prisma.$disconnect();
    return;
  }
  const result = await prisma.service.deleteMany({ where });
  console.log(`Deleted ${result.count} services.`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
