const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const seasonTotal = await prisma.travelSeasonCalendar.count();
  const seasonDupGroups = await prisma.$queryRaw`
    SELECT tenantId, subBrand, seasonName, COUNT(*) as cnt, MIN(id) as keepId, GROUP_CONCAT(id ORDER BY id ASC) as ids
    FROM TravelSeasonCalendar
    GROUP BY tenantId, subBrand, seasonName
    HAVING cnt > 1
  `;
  const seasonDupCount = seasonDupGroups.reduce((acc, g) => acc + (Number(g.cnt) - 1), 0);

  const markupTotal = await prisma.travelMarkupRule.count();
  const markupDupGroups = await prisma.$queryRaw`
    SELECT tenantId, subBrand, scope, matchKeyJson, COUNT(*) as cnt, MIN(id) as keepId, GROUP_CONCAT(id ORDER BY id ASC) as ids
    FROM TravelMarkupRule
    GROUP BY tenantId, subBrand, scope, matchKeyJson
    HAVING cnt > 1
  `;
  const markupDupCount = markupDupGroups.reduce((acc, g) => acc + (Number(g.cnt) - 1), 0);

  console.log(`TravelSeasonCalendar: ${seasonTotal} total rows, ${seasonDupCount} duplicate rows to delete`);
  console.log(`TravelMarkupRule: ${markupTotal} total rows, ${markupDupCount} duplicate rows to delete`);

  if (seasonDupCount > 0) {
    console.log("Season duplicate groups (keeping lowest id):");
    seasonDupGroups.forEach((g) => console.log(`  ${g.tenantId}/${g.subBrand}/${g.seasonName}: count=${g.cnt}, keep=${g.keepId}, ids=${g.ids}`));
  }
  if (markupDupCount > 0) {
    console.log("Markup duplicate groups (keeping lowest id):");
    markupDupGroups.slice(0, 20).forEach((g) => console.log(`  ${g.tenantId}/${g.subBrand}/${g.scope}/${g.matchKeyJson}: count=${g.cnt}, keep=${g.keepId}, ids=${g.ids}`));
    if (markupDupGroups.length > 20) console.log(`  ... and ${markupDupGroups.length - 20} more groups`);
  }

  const shouldDelete = process.argv.includes("--delete");
  if (shouldDelete) {
    if (seasonDupCount > 0) {
      const seasonResult = await prisma.$executeRaw`
        DELETE t1 FROM TravelSeasonCalendar t1
        JOIN TravelSeasonCalendar t2
          ON t1.tenantId = t2.tenantId
          AND t1.subBrand = t2.subBrand
          AND t1.seasonName = t2.seasonName
          AND t1.id > t2.id
      `;
      console.log(`Deleted ${seasonResult} duplicate season rows`);
    }
    if (markupDupCount > 0) {
      const markupResult = await prisma.$executeRaw`
        DELETE t1 FROM TravelMarkupRule t1
        JOIN TravelMarkupRule t2
          ON t1.tenantId = t2.tenantId
          AND t1.subBrand = t2.subBrand
          AND t1.scope = t2.scope
          AND t1.matchKeyJson = t2.matchKeyJson
          AND t1.id > t2.id
      `;
      console.log(`Deleted ${markupResult} duplicate markup rule rows`);
    }
  } else {
    console.log("Run with --delete to remove duplicates.");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
