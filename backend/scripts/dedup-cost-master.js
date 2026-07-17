// One-shot script: dedup TravelCostMaster rows that share the same
// (tenantId, subBrand, category, routeOrSku) natural key.
//
// The original seed used upsert({ where: { id: -1 } }) which never
// matched and inserted fresh duplicates on every re-run. This script
// keeps the row with the lowest id per natural key and deletes the rest.
//
// Run BEFORE applying the @@unique constraint in schema.prisma, otherwise
// the db push will fail with a unique-constraint violation.
//
// Usage: node backend/scripts/dedup-cost-master.js [--apply]
//   --apply   Actually delete rows. Without this flag, dry-run only.

const prisma = require("../lib/prisma");

async function main() {
  const apply = process.argv.includes("--apply");

  const rows = await prisma.travelCostMaster.findMany({
    select: { id: true, tenantId: true, subBrand: true, category: true, routeOrSku: true },
    orderBy: { id: "asc" },
  });

  const seen = new Map();
  const toDelete = [];

  for (const r of rows) {
    const key = `${r.tenantId}|${r.subBrand}|${r.category}|${r.routeOrSku}`;
    if (seen.has(key)) {
      toDelete.push(r.id);
    } else {
      seen.set(key, r.id);
    }
  }

  console.log(`Total rows: ${rows.length}`);
  console.log(`Unique natural keys: ${seen.size}`);
  console.log(`Duplicate rows to delete: ${toDelete.length}`);

  if (toDelete.length === 0) {
    console.log("No duplicates found.");
    return;
  }

  if (!apply) {
    console.log("Dry-run — pass --apply to delete. IDs that would be deleted:", toDelete.slice(0, 20), toDelete.length > 20 ? `... (${toDelete.length} total)` : "");
    return;
  }

  const { count } = await prisma.travelCostMaster.deleteMany({ where: { id: { in: toDelete } } });
  console.log(`Deleted ${count} duplicate rows.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
