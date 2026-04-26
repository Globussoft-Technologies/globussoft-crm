#!/usr/bin/env node
/**
 * One-time data migration: normalise legacy Deal.stage values + clip negative amounts.
 *
 * Closes GitHub issue #190.
 *
 * Background:
 *   The validateDealInput stage enum was tightened to lowercase-only:
 *     { lead | contacted | proposal | negotiation | won | lost }
 *   But existing rows still carry "Lead", "LEAD", "Lead ", "Won (auto)", etc.
 *   PUT/PATCH on those rows returns INVALID_STAGE — the row is read-only from the UI.
 *   Likewise, rows with negative amount values fail the amount validator.
 *
 * What this script does:
 *   1. For every Deal whose stage is not already in the canonical lowercase set,
 *      try to coerce it (lowercase, trim whitespace, strip "(auto)" / "(manual)"
 *      style suffixes). If the coerced value is in the canonical set, write it back.
 *      If it isn't, log it and leave it alone — no silent data loss.
 *   2. Clip Deal.amount < 0 to 0. We pick 0 (not Math.abs) because flipping the
 *      sign would silently fabricate revenue; clipping to 0 is honest about the
 *      fact that the original value was bad.
 *
 * Idempotent: a second run finds zero offending rows and exits with 0 changes.
 *
 * Usage:
 *   cd backend && node scripts/migrate-deal-stage-lowercase.js
 */

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const CANONICAL_STAGES = new Set(["lead", "contacted", "proposal", "negotiation", "won", "lost"]);

/**
 * Coerce an arbitrary stage string to a canonical lowercase stage, or null if
 * we can't safely normalise it.
 */
function coerceStage(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().toLowerCase();
  // strip parenthesised suffixes like "won (auto)" or "lost (manual)"
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  // collapse internal whitespace
  s = s.replace(/\s+/g, " ");
  return CANONICAL_STAGES.has(s) ? s : null;
}

async function migrateStages() {
  console.log("─── Stage normalisation ───");

  const allDeals = await prisma.deal.findMany({ select: { id: true, stage: true } });
  console.log(`Scanned ${allDeals.length} deals.`);

  // Already-canonical rows are skipped.
  const offenders = allDeals.filter((d) => !CANONICAL_STAGES.has(d.stage));
  console.log(`Found ${offenders.length} deals with non-canonical stage values.`);

  // Group offenders by raw value so we can do one updateMany per distinct value
  // and print a clean before/after table.
  const byRawStage = new Map();
  for (const d of offenders) {
    if (!byRawStage.has(d.stage)) byRawStage.set(d.stage, []);
    byRawStage.get(d.stage).push(d.id);
  }

  let totalUpdated = 0;
  let totalSkipped = 0;

  for (const [rawStage, ids] of byRawStage.entries()) {
    const target = coerceStage(rawStage);
    if (!target) {
      console.warn(`  SKIP  "${rawStage}" → no safe canonical mapping (${ids.length} row${ids.length === 1 ? "" : "s"})`);
      totalSkipped += ids.length;
      continue;
    }
    try {
      const before = ids.length;
      const res = await prisma.deal.updateMany({
        where: { id: { in: ids } },
        data: { stage: target },
      });
      console.log(`  OK    "${rawStage}" → "${target}"  (${before} row${before === 1 ? "" : "s"}, updated ${res.count})`);
      totalUpdated += res.count;
    } catch (err) {
      console.error(`  FAIL  "${rawStage}" → "${target}":`, err.message);
    }
  }

  console.log(`Stage migration done. Updated: ${totalUpdated}. Skipped (no mapping): ${totalSkipped}.`);
}

async function migrateAmounts() {
  console.log("─── Negative amount clip ───");

  try {
    const negCount = await prisma.deal.count({ where: { amount: { lt: 0 } } });
    console.log(`Deals with amount < 0: ${negCount}`);

    if (negCount === 0) {
      console.log("Nothing to do.");
      return;
    }

    // Clip to 0 (chosen over Math.abs because flipping the sign would silently
    // fabricate revenue; 0 is honest about the original being bad).
    const res = await prisma.deal.updateMany({
      where: { amount: { lt: 0 } },
      data: { amount: 0 },
    });
    console.log(`Clipped ${res.count} negative amount${res.count === 1 ? "" : "s"} to 0.`);
  } catch (err) {
    console.error("Amount clip failed:", err.message);
  }
}

async function main() {
  console.log(`migrate-deal-stage-lowercase.js — ${new Date().toISOString()}`);
  await migrateStages();
  await migrateAmounts();
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error("Fatal:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
