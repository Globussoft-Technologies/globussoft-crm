/**
 * EmbassyRule starter seed — Phase 1 rows for the most-common Indian-outbound
 * destinations. Run via `node backend/prisma/seed-embassy-rules.js`. Idempotent
 * via `skipDuplicates: true`. Expand as advisor-head + advisor team flag
 * additional embassy quirks. Per PC-3 + PC-7 RESOLVED 2026-05-24.
 *
 * Schema (backend/prisma/schema.prisma model EmbassyRule):
 *   - @@unique([tenantId, destinationCountry, applicationType, ruleType])
 *   - conditionJson is `String? @db.Text` storing JSON.stringify(...) per the
 *     sanitizeJson convention. We stringify at the call-site.
 *   - destinationCountry uses ISO-3166-1 alpha-2. Schengen rules are anchored
 *     to 'DE' (Germany) as the canonical Schengen-entry country since the
 *     schema doesn't model a Schengen-area pseudo-code.
 *   - severity ∈ {info, warning, blocker}.
 *
 * Run via:
 *   node backend/prisma/seed-embassy-rules.js
 *
 * Decision refs (docs/PRD_VISA_SURE_PHASE_3.md):
 *   - PC-3 — Embassy rule catalogue scope (cooldown + document + interview +
 *           minimum-funds rule families).
 *   - PC-7 — Advisor warning surfaces (severity ladder info → warning → blocker).
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

// Phase 1 starter rows — 13 rules across the 4 ruleType families for the
// most-common Indian-outbound visa destinations. Expand as advisor team
// surfaces additional embassy quirks per PC-3.
const STARTER_ROWS = [
  // ── Cooldown period rules ────────────────────────────────────────────
  {
    ruleType: "cooldown_period",
    destinationCountry: "US",
    applicationType: "tourist",
    conditionJson: { days: 180 },
    actionLabel:
      "US tourist visa — wait 180 days after a rejection before re-applying (advisor should counsel applicant on rejection-letter analysis first).",
    severity: "warning",
  },
  {
    ruleType: "cooldown_period",
    destinationCountry: "GB",
    applicationType: "tourist",
    conditionJson: { days: 90 },
    actionLabel:
      "UK tourist visa — 90-day cooldown after rejection. Strengthen ties-to-India evidence before re-applying.",
    severity: "warning",
  },
  {
    ruleType: "cooldown_period",
    destinationCountry: "DE",
    applicationType: "tourist",
    conditionJson: { days: 30 },
    actionLabel:
      "Schengen tourist visa — 30-day cooldown after rejection. Address the specific Annex VI rejection ground before re-applying.",
    severity: "warning",
  },
  {
    ruleType: "cooldown_period",
    destinationCountry: "AE",
    applicationType: "tourist",
    conditionJson: { days: 60 },
    actionLabel:
      "UAE tourist visa — 60-day cooldown after rejection. UAE rejections often stem from sponsor-side issues; verify sponsor status first.",
    severity: "warning",
  },
  {
    ruleType: "cooldown_period",
    destinationCountry: "AU",
    applicationType: "tourist",
    conditionJson: { days: 90 },
    actionLabel:
      "Australia tourist visa — 90-day cooldown after rejection. Subclass 600 PIC 4020 rejections require 3-year cooldown — verify the rejection ground.",
    severity: "warning",
  },
  {
    ruleType: "cooldown_period",
    destinationCountry: "CA",
    applicationType: "tourist",
    conditionJson: { days: 180 },
    actionLabel:
      "Canada tourist visa — 180-day cooldown after rejection. Re-applying without addressing the GCMS notes typically yields a faster second rejection.",
    severity: "warning",
  },

  // ── Document requirement rules ───────────────────────────────────────
  {
    ruleType: "document_required",
    destinationCountry: "US",
    applicationType: "tourist",
    conditionJson: {
      docs: ["DS-160", "biometric-appointment", "ds-160-confirmation-page"],
    },
    actionLabel:
      "DS-160 + in-person interview required — schedule biometric appointment at the nearest US consulate (Mumbai/Delhi/Chennai/Kolkata/Hyderabad).",
    severity: "blocker",
  },
  {
    ruleType: "document_required",
    destinationCountry: "GB",
    applicationType: "tourist",
    conditionJson: { docs: ["biometric-appointment", "VAF-confirmation"] },
    actionLabel:
      "UK tourist visa — biometric appointment at VFS Global required. Book before flight booking; biometric slots are typically 7-14 days out.",
    severity: "blocker",
  },
  {
    ruleType: "document_required",
    destinationCountry: "DE",
    applicationType: "tourist",
    conditionJson: {
      docs: ["travel-insurance"],
      insuranceMinCoverageEUR: 30000,
      insuranceCoverageArea: "Schengen",
    },
    actionLabel:
      "Schengen tourist visa — travel insurance proof required (Schengen-area coverage, minimum €30,000 medical + repatriation).",
    severity: "blocker",
  },
  {
    ruleType: "document_required",
    destinationCountry: "CA",
    applicationType: "tourist",
    conditionJson: { docs: ["biometrics-at-VAC", "IMM-5257"] },
    actionLabel:
      "Canada tourist visa — biometrics enrollment at VAC required (valid 10 years). Book VAC appointment before file submission.",
    severity: "blocker",
  },

  // ── Interview required rules ─────────────────────────────────────────
  {
    ruleType: "interview_required",
    destinationCountry: "US",
    applicationType: "tourist",
    conditionJson: { mode: "in-person", location: "US-consulate" },
    actionLabel:
      "US tourist visa — in-person consular interview required for all first-time applicants and most renewals. Counsel applicant on interview prep (purpose-of-visit clarity, ties-to-India, financial means).",
    severity: "blocker",
  },

  // ── Minimum funds rules ──────────────────────────────────────────────
  {
    ruleType: "minimum_funds",
    destinationCountry: "DE",
    applicationType: "tourist",
    conditionJson: {
      amountUSD: 5000,
      evidence: "bank-statement-3-months",
      perApplicant: true,
    },
    actionLabel:
      "Schengen tourist visa — minimum $5,000 USD per applicant (3-month bank statement). Schengen consulates apply a per-day rate (~€50-100/day × trip length); $5k covers a typical 2-week trip.",
    severity: "warning",
  },
  {
    ruleType: "minimum_funds",
    destinationCountry: "GB",
    applicationType: "tourist",
    conditionJson: {
      amountUSD: 4000,
      evidence: "bank-statement-6-months",
      perApplicant: true,
    },
    actionLabel:
      "UK tourist visa — minimum ~£3,000 (≈$4,000 USD) per applicant with 6-month bank statement showing stable balance (no last-minute deposits — caseworkers flag those as borrowed funds).",
    severity: "warning",
  },
];

async function main() {
  console.log("[seed-embassy-rules] starting…");

  // Resolve the travel-stall tenant. Skip seeding if tenant doesn't exist
  // (seed-travel.js hasn't been run yet) — that's a strict prerequisite.
  const tenant = await prisma.tenant.findUnique({
    where: { slug: TENANT_SLUG },
  });

  if (!tenant) {
    console.warn(
      `[seed-embassy-rules] Tenant '${TENANT_SLUG}' not found — run \`node backend/prisma/seed-travel.js\` first to provision the Travel Stall tenant. Skipping embassy-rule seed.`
    );
    return;
  }

  const data = STARTER_ROWS.map((row) => ({
    tenantId: tenant.id,
    ruleType: row.ruleType,
    destinationCountry: row.destinationCountry,
    applicationType: row.applicationType,
    // conditionJson is `String? @db.Text` storing JSON-stringified payload
    // per the sanitizeJson convention used by routes/embassy_rules.js.
    conditionJson:
      row.conditionJson == null ? null : JSON.stringify(row.conditionJson),
    actionLabel: row.actionLabel,
    severity: row.severity,
    isActive: true,
  }));

  const result = await prisma.embassyRule.createMany({
    data,
    skipDuplicates: true,
  });

  console.log(
    `[seed-embassy-rules] inserted ${result.count} new rules (${data.length} attempted; ${data.length - result.count} already present from prior runs).`
  );
  console.log("[seed-embassy-rules] done.");
}

main()
  .catch((err) => {
    console.error("[seed-embassy-rules] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
