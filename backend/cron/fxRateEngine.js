/**
 * backend/cron/fxRateEngine.js — hourly FX-rate cache refresh.
 *
 * PRD_TRAVEL_QUOTE_BUILDER G018 (DD-5.4) — operator QuoteBuilder needs
 * up-to-date FX conversions when a quote currency differs from a line's
 * currency. Rather than calling out to frankfurter.dev on every quote-
 * builder render (latency + rate-limit risk), the engine fans out one
 * fetch per (base, quote) pair per hour and persists the result into the
 * FxRate table; the /api/fx/latest read endpoint then serves the cached
 * row in O(1).
 *
 * Schedule: top-of-the-hour UTC (cron expression `0 * * * *`). The
 * frankfurter.dev free tier publishes one refresh per day per currency
 * pair, so hourly polling is intentionally over-frequent — it guarantees
 * we pick up the daily update within ~1 hour of its publication regardless
 * of demo-host clock skew.
 *
 * Contracts pinned by backend/test/cron/fxRateEngine.test.js:
 *   1. Empty supported-pair list → returns { fetched: 0, errors: [] }.
 *   2. Successful fetch upserts one FxRate row per pair.
 *   3. fetch failure for a single pair does NOT abort the other pairs.
 *   4. Engine never throws to the cron-scheduler harness.
 *   5. initCron() is idempotent — DISABLE_CRONS=1 path skips schedule.
 */

const cronRegistry = require("../lib/cronRegistry");
const realPrisma = require("../lib/prisma");
const fxRates = require("../lib/fxRates");

/**
 * One sweep pass. Returns { fetched, errors }.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.prisma] override prisma client for tests
 * @param {Array}  [opts.pairs] override the (base, quote) pair list for tests
 * @param {Function} [opts.fetchImpl] override fetch for tests (passed through to fxRates.fetchLatestRate)
 * @param {Date}   [opts.now] override the timestamp recorded on each row
 */
async function tick({
  prisma = realPrisma,
  pairs = fxRates.SUPPORTED_PAIRS,
  fetchImpl,
  now = new Date(),
} = {}) {
  const errors = [];
  let fetched = 0;
  for (const { base, quote } of pairs || []) {
    try {
      const result = await fxRates.fetchLatestRate(base, quote, { fetchImpl });
      if (!result) {
        errors.push({ base, quote, stage: "fetch", message: "no rate returned" });
        continue;
      }
      const row = await fxRates.upsertRate(prisma, {
        base,
        quote,
        rate: result.rate,
        fetchedAt: now,
        source: fxRates.DEFAULT_SOURCE,
      });
      if (row) fetched += 1;
    } catch (e) {
      errors.push({ base, quote, stage: "upsert", message: e.message });
    }
  }
  return { fetched, errors };
}

async function loggedTick() {
  const r = await tick();
  if (r.fetched > 0 || r.errors.length > 0) {
    console.log("[fxRateEngine]", r);
  }
  return r;
}

function initCron() {
  if (process.env.DISABLE_CRONS === "1") return;
  cronRegistry.register({
    name: "fxRateEngine",
    description: "Hourly FxRate cache refresh from frankfurter.dev",
    defaultSchedule: "0 * * * *",
    tickFn: loggedTick,
  }).catch((e) => console.error("[fxRateEngine] cronRegistry registration failed:", e.message));
}

module.exports = {
  tick,
  initCron,
};
