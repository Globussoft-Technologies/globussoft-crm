/**
 * backend/lib/fxRates.js — pure helpers for FX-rate lookup + conversion.
 *
 * PRD_TRAVEL_QUOTE_BUILDER G018 (DD-5.4) — the FX-rate cache feeds two
 * downstream consumers:
 *   1. fxRateEngine cron — hourly poll of frankfurter.dev that upserts
 *      FxRate rows for the base→quote pairs we care about.
 *   2. /api/fx/* read endpoints — surfaced in the operator QuoteBuilder
 *      so an INR-priced line on a USD quote shows its converted equivalent.
 *
 * This module keeps the maths/fetch logic separate from the Prisma /
 * Express layer so the cron + route stay small and the test surface
 * exercises pure functions directly.
 *
 * Contracts pinned by backend/test/lib/fxRates.test.js:
 *   - fetchLatestRate(base, quote) returns { base, quote, rate } from
 *     frankfurter.dev or null on any fetch/parse failure (fail-soft —
 *     a single cron iteration must not crash on transient network errors).
 *   - convert(amount, rate) returns Number(amount) * Number(rate) with a
 *     guard against null/undefined/NaN inputs (returns null in those
 *     cases so the UI shows a "—" placeholder instead of NaN).
 *   - getLatestFromDb(prisma, base, quote) returns the most recent row
 *     for the pair or null if nothing has been fetched yet.
 *   - SUPPORTED_PAIRS — the seed pair list the cron polls each tick.
 *     Tenant-default currency + the major travel-spend currencies
 *     (USD / EUR / GBP / AED / SAR) keep the cron token-cheap.
 */

const DEFAULT_SOURCE = "frankfurter";
// Frankfurter is a community-maintained open-data FX API (no auth, no
// rate-limit on the free tier under reasonable use). Chosen over
// alternatives that require an API key (fxapi.com / openexchangerates.org)
// so the cron can ship without a Q-cluster cred chase.
const FRANKFURTER_LATEST_URL = "https://api.frankfurter.dev/v1/latest";

// Currency pairs the cron polls each tick. Keep tight — every new pair is
// one more HTTP call per hour. Travel CRM today serves INR-base tenants
// with conversions to the major destination currencies.
const SUPPORTED_PAIRS = [
  { base: "INR", quote: "USD" },
  { base: "INR", quote: "EUR" },
  { base: "INR", quote: "GBP" },
  { base: "INR", quote: "AED" },
  { base: "INR", quote: "SAR" },
  { base: "USD", quote: "INR" },
  { base: "EUR", quote: "INR" },
  { base: "GBP", quote: "INR" },
];

/**
 * Fetch the latest rate for a base→quote pair from frankfurter.dev.
 * Returns { base, quote, rate } on success; null on any failure (timeout,
 * non-200, malformed body, unknown currency). The cron's fail-soft loop
 * relies on a null return here — never let this throw to the caller.
 *
 * @param {string} base   ISO 4217 base currency (e.g. "INR")
 * @param {string} quote  ISO 4217 quote currency (e.g. "USD")
 * @param {Object} [opts]
 * @param {Function} [opts.fetchImpl] override for tests (default global fetch)
 */
async function fetchLatestRate(base, quote, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  if (!base || !quote || base === quote) return null;
  const url = `${FRANKFURTER_LATEST_URL}?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(quote)}`;
  try {
    const res = await fetchImpl(url);
    if (!res || !res.ok) return null;
    const body = await res.json();
    if (!body || !body.rates) return null;
    const rate = body.rates[quote];
    if (!Number.isFinite(Number(rate))) return null;
    return { base, quote, rate: Number(rate) };
  } catch (_e) {
    return null;
  }
}

/**
 * Convert an amount in the base currency to the quote currency using a
 * rate previously fetched from the FxRate table.
 *
 * Returns null on any non-finite input — caller MUST treat null as "no
 * conversion available" (typically renders "—" in the UI).
 */
function convert(amount, rate) {
  if (amount == null || rate == null) return null;
  const a = Number(amount);
  const r = Number(rate);
  if (!Number.isFinite(a) || !Number.isFinite(r)) return null;
  return a * r;
}

/**
 * Read the freshest FxRate row for a base→quote pair from the DB.
 * Returns the row object (Prisma shape) or null if no row has been
 * persisted yet.
 */
async function getLatestFromDb(prisma, base, quote) {
  if (!prisma || !base || !quote) return null;
  const row = await prisma.fxRate.findFirst({
    where: { baseCurrency: base, quoteCurrency: quote },
    orderBy: { fetchedAt: "desc" },
  });
  return row || null;
}

/**
 * Read FxRate rows for a base→quote pair within a date range.
 * Both `from` and `to` are inclusive ISO date strings or Date objects.
 * Returns an array ordered ascending by fetchedAt.
 */
async function getHistoryFromDb(prisma, base, quote, from, to) {
  if (!prisma || !base || !quote) return [];
  const where = { baseCurrency: base, quoteCurrency: quote };
  if (from || to) {
    where.fetchedAt = {};
    if (from) where.fetchedAt.gte = new Date(from);
    if (to) where.fetchedAt.lte = new Date(to);
  }
  return prisma.fxRate.findMany({
    where,
    orderBy: { fetchedAt: "asc" },
  });
}

/**
 * Persist a fetched rate (idempotent — duplicate (base, quote, fetchedAt)
 * triggers a unique-constraint catch that swallows silently).
 *
 * Returns the row or null on collision.
 */
async function upsertRate(prisma, { base, quote, rate, fetchedAt, source }) {
  if (!prisma) return null;
  try {
    return await prisma.fxRate.create({
      data: {
        baseCurrency: base,
        quoteCurrency: quote,
        rate,
        fetchedAt: fetchedAt || new Date(),
        source: source || DEFAULT_SOURCE,
      },
    });
  } catch (_e) {
    // Unique-collision (very rare — same pair + millisecond timestamp).
    return null;
  }
}

module.exports = {
  DEFAULT_SOURCE,
  FRANKFURTER_LATEST_URL,
  SUPPORTED_PAIRS,
  fetchLatestRate,
  convert,
  getLatestFromDb,
  getHistoryFromDb,
  upsertRate,
};
