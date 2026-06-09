/**
 * TMC school-term / holiday / exam-blackout baseline windows (TEMPORARY data).
 *
 * There is NO public API for a specific school's term calendar, so V1 seeds a
 * generic India baseline (national-ish break + typical exam windows) with
 * schoolName=null — meaning "applies to all schools until that school gives us
 * its own dates". Each school's ACTUAL dates are then captured by asking them
 * (source='manual') via Travel → School Term Calendar. A future feed can import
 * from school websites (source='website').
 *
 * Idempotent — skipDuplicates on (tenantId, ...) — safe to re-run.
 * Run via:  node backend/prisma/seed-travel-school-terms.js
 */
const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { PrismaClient } = require("@prisma/client");
if (!process.env.DATABASE_URL) {
  console.error("Error: DATABASE_URL not set in .env file");
  process.exit(1);
}
const prisma = new PrismaClient();
const TENANT_SLUG = "travel-stall";

// Baseline India 2026 windows. Dates are typical, not authoritative — each
// school overrides with its real dates. kind: holiday = trips OK; term /
// exam-blackout = warn (don't schedule a trip then).
const BASELINE_ROWS = [
  { kind: "holiday", label: "Summer Break 2026", board: null, startDate: "2026-04-20", endDate: "2026-06-10" },
  { kind: "holiday", label: "Dussehra / Diwali Break 2026", board: null, startDate: "2026-10-17", endDate: "2026-10-26" },
  { kind: "holiday", label: "Winter Break 2026", board: null, startDate: "2026-12-24", endDate: "2027-01-04" },
  { kind: "exam-blackout", label: "Half-yearly Exams (typical)", board: "CBSE", startDate: "2026-09-21", endDate: "2026-10-05" },
  { kind: "exam-blackout", label: "CBSE Board Exams (Class 10/12) — tentative", board: "CBSE", startDate: "2027-02-15", endDate: "2027-03-25" },
];

async function main() {
  console.log("[seed-travel-school-terms] starting…");
  const tenant = await prisma.tenant.findUnique({ where: { slug: TENANT_SLUG } });
  if (!tenant) {
    console.warn(
      `[seed-travel-school-terms] Tenant '${TENANT_SLUG}' not found — run \`node backend/prisma/seed-travel.js\` first. Skipping.`
    );
    return;
  }
  const data = BASELINE_ROWS.map((r) => ({
    tenantId: tenant.id,
    subBrand: "tmc",
    schoolName: null,
    source: "seed",
    isActive: true,
    ...r,
    startDate: new Date(r.startDate),
    endDate: new Date(r.endDate),
  }));
  const result = await prisma.travelSchoolTerm.createMany({ data, skipDuplicates: true });
  console.log(
    `[seed-travel-school-terms] inserted ${result.count} new rows (${data.length} attempted).`
  );
  console.log("[seed-travel-school-terms] done.");
}

main()
  .catch((err) => {
    console.error("[seed-travel-school-terms] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
