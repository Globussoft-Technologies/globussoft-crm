/**
 * S11 — TravelPoi seed wrapper.
 *
 * Per PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.5. Thin shim around
 * backend/scripts/seedOpenTripMapPois.js that forces fixture-mode so
 * `prisma db seed` runs work offline (no OPENTRIPMAP_API_KEY required)
 * and don't depend on Yasin's self-serve signup at opentripmap.io.
 *
 * Why a separate file: prisma/seed.js convention is to call sub-seeders
 * from the main entrypoint. seedOpenTripMapPois.js is dual-purpose
 * (CLI + library); this wrapper is the in-process variant used by
 * other seeders + the seed.js orchestrator (wire-in into prisma/seed.js
 * is deferred per S11 instructions — flag, don't fix).
 *
 * Run via:
 *   node backend/prisma/seed-travel-pois.js
 *
 * Exports:
 *   seedTravelPois({ prisma, useFixture, destinations? }) - in-process
 *     invocation; the orchestrator calls this with its shared prisma
 *     instance + useFixture: true.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load .env (project root, 2 levels up from backend/prisma/)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { runSeed, PLACEHOLDER_KEY } = require('../scripts/seedOpenTripMapPois');

/**
 * In-process invocation. Default uses fixture so the seed pipeline never
 * waits on network. Caller can override with useFixture: false if they
 * actually want live API hits (rare — production CRON or one-off ops).
 *
 * @param {object} opts
 * @param {object} opts.prisma           - PrismaClient
 * @param {boolean} [opts.useFixture]    - default true
 * @param {string[]} [opts.destinations] - default all 10
 * @returns {Promise<{totalFetched:number,totalUpserted:number,perDest:object[]}>}
 */
async function seedTravelPois({ prisma, useFixture = true, destinations = null } = {}) {
  if (!prisma) throw new Error('[seed-travel-pois] prisma instance required');
  const apiKey = process.env.OPENTRIPMAP_API_KEY || PLACEHOLDER_KEY;
  return runSeed(
    { prisma, fetchImpl: (typeof fetch === 'function' ? fetch : null), logger: console },
    {
      apiKey,
      useFixture,
      dryRun: false,
      destinations,
    }
  );
}

async function main() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  if (!process.env.DATABASE_URL) {
    console.error('[seed-travel-pois] DATABASE_URL not set; aborting');
    process.exit(1);
  }

  console.log('[seed-travel-pois] starting (fixture-mode)…');
  try {
    const result = await seedTravelPois({ prisma, useFixture: true });
    console.log(`[seed-travel-pois] done: upserted ${result.totalUpserted} POIs across ${result.perDest.length} destinations`);
  } catch (err) {
    console.error('[seed-travel-pois] fatal:', err);
    await prisma.$disconnect();
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main && require.main === module) {
  main();
}

module.exports = { seedTravelPois };
