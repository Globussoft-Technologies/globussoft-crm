/**
 * TMC curriculum→destination mapping — Phase 1 starter rows.
 *
 * Per PRD_TMC_CURRICULUM_MAPPING PC-1 RESOLVED 2026-05-24: GS drafts
 * 100-200 starter rows + TMC academic team validates over a 6-week window.
 * This file lands the CBSE half of the scaffold (PC-2 scopes V1 to CBSE +
 * ICSE only). Expand to 100-200 rows when TMC academic team validates the
 * schema.
 *
 * Idempotent — uses skipDuplicates: true against the
 * (tenantId, curriculum, grade, subject, learningOutcome) @@unique index.
 * Safe to re-run.
 *
 * Run via:
 *   node backend/prisma/seed-travel-curriculum.js
 *
 * Decision refs (docs/PRD_TMC_CURRICULUM_MAPPING.md):
 *   - PC-2 — Curriculum scope V1: CBSE + ICSE only (this file: CBSE).
 *   - PC-3 — Fine-grain key (curriculum, grade, subject, learningOutcome).
 *   - PC-4 — Human-judged fitScore (1-100 scale).
 *   - PC-5 — destinationLabel free-text fallback (TmcTrip catalogue FK
 *           via destinationId stays null in starter rows until the
 *           academic team picks specific trip templates).
 */
const path = require("path");
const dotenv = require("dotenv");

// Load .env (project root, 2 levels up from backend/prisma/)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { PrismaClient } = require("@prisma/client");

if (!process.env.DATABASE_URL) {
  console.error("Error: DATABASE_URL not set in .env file");
  process.exit(1);
}

const prisma = new PrismaClient();

const TENANT_SLUG = "travel-stall";

// Phase 1 starter rows — CBSE Class 9 Geography + CBSE Class 10 History +
// CBSE Class 9 Biology. fitScore is human-judged per PC-4 (50 = neutral,
// 70-85 = strong fit, 85+ = textbook-perfect match). Academic team will
// adjust during the 6-week validation window.
const STARTER_ROWS = [
  {
    curriculum: "CBSE",
    grade: "Class 9",
    subject: "Geography",
    learningOutcome: "Plate tectonics + landform formation",
    destinationLabel: "Italy + Iceland",
    fitScore: 85,
    fitRationale:
      "Volcanic landscapes (Vesuvius, Stromboli, Þingvellir mid-Atlantic ridge) directly map to plate-tectonic concepts in NCERT Chapter 3. Students see live geological processes — fumaroles, lava fields, rift valleys — instead of textbook diagrams.",
  },
  {
    curriculum: "CBSE",
    grade: "Class 9",
    subject: "Geography",
    learningOutcome: "Glacial landforms + river systems",
    destinationLabel: "Switzerland + Austria",
    fitScore: 80,
    fitRationale:
      "Alpine glaciers (Aletsch, Pasterze) plus the Rhine + Danube headwaters illustrate Chapter 4 landform genesis. Pairs well with a Mussoorie-Gangotri short-trip backup if international budget falls through.",
  },
  {
    curriculum: "CBSE",
    grade: "Class 9",
    subject: "Geography",
    learningOutcome: "Monsoon climate systems + Indian Ocean meteorology",
    destinationLabel: "Kerala backwaters + Western Ghats",
    fitScore: 75,
    fitRationale:
      "Domestic alternative when international trips are budget-constrained. Western Ghats orographic rainfall + backwater estuarine systems illustrate Chapter 5 monsoon mechanics. Cost-efficient for school cohorts under ₹50k/student budget.",
  },
  {
    curriculum: "CBSE",
    grade: "Class 10",
    subject: "History",
    learningOutcome: "Nationalism in Europe + rise of modern nation-states",
    destinationLabel: "France + Germany",
    fitScore: 88,
    fitRationale:
      "Paris (Bastille, Place de la Concorde, Versailles) + Berlin (Reichstag, Brandenburg Gate, DDR Museum) anchor NCERT Chapter 1's narrative of 1789-1914 nation-formation. Walking the actual streets makes the textbook timeline tangible.",
  },
  {
    curriculum: "CBSE",
    grade: "Class 10",
    subject: "History",
    learningOutcome: "Print culture + the modern world",
    destinationLabel: "Mainz + London (British Library)",
    fitScore: 70,
    fitRationale:
      "Gutenberg Museum (Mainz) + British Library's Treasures gallery cover NCERT Chapter 5's print-revolution material. Niche destination — better as a Europe-trip add-on than a standalone pitch.",
  },
  {
    curriculum: "CBSE",
    grade: "Class 9",
    subject: "Biology",
    learningOutcome: "Diversity in living organisms + biogeography",
    destinationLabel: "Costa Rica (Monteverde + Tortuguero) OR Sundarbans",
    fitScore: 82,
    fitRationale:
      "Costa Rica's cloud-forest + rainforest belts pack maximum biodiversity per trip-day (sloths, quetzals, leaf-cutter ants, frogs). Sundarbans is the domestic equivalent — mangrove ecology + Royal Bengal tiger habitat — for budget-constrained schools.",
  },
];

async function main() {
  console.log("[seed-travel-curriculum] starting…");

  // Resolve the travel-stall tenant. Skip seeding if tenant doesn't exist
  // (seed-travel.js hasn't been run yet) — that's a strict prerequisite.
  const tenant = await prisma.tenant.findUnique({
    where: { slug: TENANT_SLUG },
  });

  if (!tenant) {
    console.warn(
      `[seed-travel-curriculum] Tenant '${TENANT_SLUG}' not found — run \`node backend/prisma/seed-travel.js\` first to provision the Travel Stall tenant. Skipping curriculum seed.`
    );
    return;
  }

  const data = STARTER_ROWS.map((row) => ({
    tenantId: tenant.id,
    ...row,
  }));

  const result = await prisma.travelCurriculumMapping.createMany({
    data,
    skipDuplicates: true,
  });

  console.log(
    `[seed-travel-curriculum] inserted ${result.count} new rows (${data.length} attempted; ${data.length - result.count} already present from prior runs).`
  );
  console.log("[seed-travel-curriculum] done.");
}

main()
  .catch((err) => {
    console.error("[seed-travel-curriculum] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
