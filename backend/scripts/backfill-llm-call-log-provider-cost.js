/**
 * scripts/backfill-llm-call-log-provider-cost.js — one-time backfill for
 * LlmCallLog rows written before provider/cost estimation was wired in
 * (2026-07-14). Those rows have provider:"unknown" and costEstimate:0
 * baked in permanently — this script infers the real provider from each
 * row's `model` string and recomputes costEstimate from its token counts,
 * using the exact same lib/apiPricing.js table live calls use going forward.
 *
 * Idempotent: only touches rows where provider = "unknown" (the column
 * default), so re-running is safe and a no-op once everything is backfilled.
 * Stub rows (stub:true) are intentionally left at costEstimate:0 — no real
 * API call was made, so there's no real cost to attribute, but they DO get
 * a real `provider` tag so "Calls by provider" reflects them correctly.
 *
 * Usage: node scripts/backfill-llm-call-log-provider-cost.js [--dry-run]
 */

'use strict';

const prisma = require('../lib/prisma');
const { inferProvider, estimateLlmCost } = require('../lib/apiPricing');

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  const rows = await prisma.llmCallLog.findMany({ where: { provider: 'unknown' } });

  if (rows.length === 0) {
    console.log('[backfill] no rows with provider="unknown" — nothing to do.');
    return { updated: 0, total: 0 };
  }

  console.log(`[backfill] found ${rows.length} row(s) to backfill${dryRun ? ' (dry run — no writes)' : ''}.`);

  let updated = 0;
  for (const row of rows) {
    const provider = inferProvider(row.model);
    const costEstimate = row.stub ? 0 : estimateLlmCost(row.model, row.promptTokens, row.completionTokens);

    if (dryRun) {
      console.log(`  [dry-run] id=${row.id} model=${row.model} -> provider=${provider} cost=${costEstimate}`);
      continue;
    }

    await prisma.llmCallLog.update({
      where: { id: row.id },
      data: { provider, costEstimate },
    });
    updated += 1;
  }

  console.log(`[backfill] ${dryRun ? 'would update' : 'updated'} ${dryRun ? rows.length : updated} of ${rows.length} row(s).`);
  return { updated: dryRun ? 0 : updated, total: rows.length };
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[backfill] failed:', e);
      process.exit(1);
    });
}

module.exports = { run };
