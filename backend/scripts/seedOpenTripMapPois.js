/**
 * S11 — OpenTripMap POI catalog seed import.
 *
 * Per PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.5: a curated catalog of
 * ~500 Points-of-Interest spanning the top-10 trip destinations across
 * India + Saudi + Europe, populating the TravelPoi model so the inline
 * Add-POI modal (S12) and itinerary-item generators (S9/S14) can suggest
 * real-world entries instead of free-text guessing.
 *
 * Modes:
 *   - LIVE: hits the OpenTripMap public API per destination. Requires
 *     OPENTRIPMAP_API_KEY env (free-tier signup at opentripmap.io —
 *     Yasin needs to do ~5min self-serve). 1-req/sec throttle to stay
 *     well inside the ~1000/day free-tier ceiling.
 *   - FIXTURE: reads backend/test/fixtures/opentripmap-sample-response.json
 *     and treats those entries as the canonical response. Activated by
 *     --use-fixture flag or when OPENTRIPMAP_API_KEY === '__PLACEHOLDER__'.
 *     Lets prisma db seed runs work offline without depending on Yasin's
 *     key, and lets vitest exercise the upsert pipeline deterministically.
 *
 * Idempotent: the (externalSource, externalId) UNIQUE on TravelPoi means
 * re-running over the same fixture re-upserts existing rows (refreshes
 * name / category / imageUrl / descriptionShort while preserving local
 * id + any pendingApproval / tenant-pin fields). Safe to run on every
 * deploy.
 *
 * CLI:
 *   node backend/scripts/seedOpenTripMapPois.js              # live, all 10 destinations
 *   node backend/scripts/seedOpenTripMapPois.js --use-fixture # offline fixture-mode
 *   node backend/scripts/seedOpenTripMapPois.js --dry-run    # parse only, no upsert
 *   node backend/scripts/seedOpenTripMapPois.js --destinations=goa,jaipur  # scope to subset
 *
 * Exit code: 0 on success, 1 on fatal error.
 *
 * Logging format (pinned by tests; do not change without updating the
 * test that asserts the pattern):
 *   [seedPois] dest=<slug> fetched=<n> upserted=<m>
 */

const path = require('path');
const fs = require('fs');

// ── Top-10 destinations (India + Saudi + Europe) ───────────────────────
// Each entry drives one OpenTripMap radius-query call (LIVE mode) and is
// the destinationSlug grouping key (used for the offline-fixture filter
// + the upsert payload).
const DESTINATIONS = [
  // India
  { slug: 'goa',      name: 'Goa',      country: 'IN', lat: 15.2993, lng: 74.1240, radiusMeters: 50000 },
  { slug: 'jaipur',   name: 'Jaipur',   country: 'IN', lat: 26.9124, lng: 75.7873, radiusMeters: 50000 },
  { slug: 'agra',     name: 'Agra',     country: 'IN', lat: 27.1751, lng: 78.0421, radiusMeters: 30000 },
  { slug: 'kerala',   name: 'Kerala',   country: 'IN', lat: 9.9312,  lng: 76.2673, radiusMeters: 50000 },
  // Saudi Arabia
  { slug: 'mecca',    name: 'Mecca',    country: 'SA', lat: 21.4225, lng: 39.8262, radiusMeters: 30000 },
  { slug: 'medina',   name: 'Medina',   country: 'SA', lat: 24.5247, lng: 39.5692, radiusMeters: 30000 },
  // Europe
  { slug: 'paris',    name: 'Paris',    country: 'FR', lat: 48.8566, lng: 2.3522,  radiusMeters: 30000 },
  { slug: 'rome',     name: 'Rome',     country: 'IT', lat: 41.9028, lng: 12.4964, radiusMeters: 30000 },
  { slug: 'london',   name: 'London',   country: 'GB', lat: 51.5074, lng: -0.1278, radiusMeters: 30000 },
  { slug: 'istanbul', name: 'Istanbul', country: 'TR', lat: 41.0082, lng: 28.9784, radiusMeters: 30000 },
];

const FIXTURE_PATH = path.resolve(__dirname, '../test/fixtures/opentripmap-sample-response.json');
const PLACEHOLDER_KEY = '__PLACEHOLDER__';
const PER_DESTINATION_LIMIT = 50;
const RATE_LIMIT_MS = 1000; // 1 req/sec — well inside OpenTripMap free-tier 1000/day

// ── Helpers ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    dryRun: false,
    useFixture: false,
    destinations: null, // null = all
  };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--use-fixture') args.useFixture = true;
    else if (a.startsWith('--destinations=')) {
      const list = a.slice('--destinations='.length).split(',').map((s) => s.trim()).filter(Boolean);
      args.destinations = list.length ? list : null;
    }
  }
  return args;
}

function pickDestinations(filter) {
  if (!filter) return DESTINATIONS;
  const set = new Set(filter.map((s) => s.toLowerCase()));
  return DESTINATIONS.filter((d) => set.has(d.slug));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map an OpenTripMap radius-list entry to a TravelPoi upsert payload.
 * Shape of the source:
 *   { xid, name, dist, rate, osm, wikidata, kinds, point: {lon, lat} }
 * plus our offline-fixture extension which may include image, country,
 * destinationSlug, descriptionShort, nameLocal.
 *
 * The transform tolerates partial data — only xid + name are required;
 * everything else is nullable in the model.
 */
function mapToUpsert(raw, dest) {
  if (!raw || !raw.xid || !raw.name) return null;
  const lat = raw.point && typeof raw.point.lat === 'number' ? raw.point.lat
    : (typeof raw.lat === 'number' ? raw.lat : null);
  const lng = raw.point && typeof raw.point.lon === 'number' ? raw.point.lon
    : (typeof raw.lng === 'number' ? raw.lng : null);
  const kinds = typeof raw.kinds === 'string' ? raw.kinds : '';
  const category = pickPrimaryCategory(kinds);
  return {
    externalSource: 'opentripmap',
    externalId: String(raw.xid),
    name: String(raw.name),
    nameLocal: raw.nameLocal || null,
    category,
    latitude: lat,
    longitude: lng,
    country: raw.country || (dest ? dest.country : null),
    destinationSlug: raw.destinationSlug || (dest ? dest.slug : null),
    imageUrl: raw.image || raw.imageUrl || null,
    wikidataId: raw.wikidata || raw.wikidataId || null,
    descriptionShort: raw.descriptionShort || null,
    pendingApproval: false,
  };
}

/**
 * Reduce OpenTripMap's comma-delimited 'kinds' string to a single
 * category bucket: religious | historical | natural | cultural | other.
 * The first matching match wins (priority order); falls back to 'other'
 * when nothing recognisable lands.
 */
function pickPrimaryCategory(kinds) {
  if (!kinds) return null;
  const k = kinds.toLowerCase();
  if (k.includes('religion') || k.includes('mosque') || k.includes('church') || k.includes('temple')) return 'religious';
  if (k.includes('historic') || k.includes('archaeolog') || k.includes('monument')) return 'historical';
  if (k.includes('natural') || k.includes('beach') || k.includes('mountain') || k.includes('park')) return 'natural';
  if (k.includes('museum') || k.includes('cultural') || k.includes('theatre') || k.includes('palace')) return 'cultural';
  return 'other';
}

function loadFixture(fixturePath) {
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`[seedPois] fixture not found at ${fixturePath}`);
  }
  const raw = fs.readFileSync(fixturePath, 'utf8');
  const parsed = JSON.parse(raw);
  // Two accepted shapes:
  //   { features: [POI, ...] }  ← OpenTripMap-style top-level
  //   [POI, ...]                ← bare array (legacy)
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.features)) return parsed.features;
  throw new Error('[seedPois] fixture shape invalid (expected array or { features: [...] })');
}

/**
 * Pull entries from the fixture that match the given destination's slug
 * OR country (graceful fallback when fixture entries don't tag a slug).
 */
function filterFixtureForDest(features, dest) {
  return features.filter((f) => {
    if (f.destinationSlug && f.destinationSlug === dest.slug) return true;
    if (!f.destinationSlug && f.country === dest.country) return true;
    return false;
  });
}

async function fetchDestinationLive(dest, apiKey, fetchImpl) {
  const url = `https://api.opentripmap.com/0.1/en/places/radius`
    + `?radius=${dest.radiusMeters}`
    + `&lon=${dest.lng}`
    + `&lat=${dest.lat}`
    + `&kinds=interesting_places`
    + `&format=json`
    + `&limit=${PER_DESTINATION_LIMIT}`
    + `&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`[seedPois] OpenTripMap returned ${res.status} for ${dest.slug}`);
  }
  const body = await res.json();
  if (!Array.isArray(body)) {
    throw new Error(`[seedPois] OpenTripMap returned non-array body for ${dest.slug}`);
  }
  return body;
}

/**
 * Run the seed pipeline. Pure-function — accepts prisma + fetch + a logger
 * + an args object, returns a per-destination summary. Tests drive this
 * directly without spawning a subprocess.
 *
 * @param {object} deps
 * @param {object} deps.prisma          - PrismaClient with .travelPoi.upsert
 * @param {function} deps.fetchImpl     - fetch-API-compatible implementation
 * @param {function} deps.logger        - logger.log (defaults to console.log)
 * @param {object} args                 - parsed CLI args
 * @param {string} args.apiKey          - OPENTRIPMAP_API_KEY value
 * @param {boolean} args.useFixture     - force fixture mode
 * @param {boolean} args.dryRun         - skip upsert
 * @param {string[]|null} args.destinations - slug list (null = all)
 * @returns {Promise<{totalFetched: number, totalUpserted: number, perDest: object[]}>}
 */
async function runSeed(deps, args) {
  const { prisma, fetchImpl, logger } = deps;
  const log = (logger && logger.log) ? logger.log : console.log;
  const apiKey = args.apiKey || '';
  const forceFixture = args.useFixture || apiKey === PLACEHOLDER_KEY || apiKey === '';

  if (!forceFixture && typeof fetchImpl !== 'function') {
    throw new Error('[seedPois] live mode requires a fetch implementation');
  }

  const destinations = pickDestinations(args.destinations);
  if (destinations.length === 0) {
    log('[seedPois] no destinations selected (check --destinations flag)');
    return { totalFetched: 0, totalUpserted: 0, perDest: [] };
  }

  let fixtureFeatures = null;
  if (forceFixture) {
    fixtureFeatures = loadFixture(FIXTURE_PATH);
  }

  const summary = { totalFetched: 0, totalUpserted: 0, perDest: [] };

  for (let i = 0; i < destinations.length; i++) {
    const dest = destinations[i];
    let rawFeatures;
    try {
      if (forceFixture) {
        rawFeatures = filterFixtureForDest(fixtureFeatures, dest);
      } else {
        if (i > 0) await sleep(RATE_LIMIT_MS); // throttle between live calls
        rawFeatures = await fetchDestinationLive(dest, apiKey, fetchImpl);
      }
    } catch (err) {
      log(`[seedPois] dest=${dest.slug} ERROR ${err.message}`);
      summary.perDest.push({ slug: dest.slug, fetched: 0, upserted: 0, error: err.message });
      continue; // one destination's failure doesn't abort the whole run
    }

    const payloads = rawFeatures.map((r) => mapToUpsert(r, dest)).filter(Boolean);
    let upsertedCount = 0;

    if (!args.dryRun) {
      for (const p of payloads) {
        try {
          await prisma.travelPoi.upsert({
            where: { externalSource_externalId: { externalSource: p.externalSource, externalId: p.externalId } },
            create: p,
            update: {
              name: p.name,
              nameLocal: p.nameLocal,
              category: p.category,
              latitude: p.latitude,
              longitude: p.longitude,
              country: p.country,
              destinationSlug: p.destinationSlug,
              imageUrl: p.imageUrl,
              wikidataId: p.wikidataId,
              descriptionShort: p.descriptionShort,
              // intentionally NOT updating pendingApproval — preserves
              // rep-approval state set after the original import.
            },
          });
          upsertedCount += 1;
        } catch (err) {
          log(`[seedPois] dest=${dest.slug} upsert-error xid=${p.externalId} ${err.message}`);
          // continue — one POI failure doesn't abort the destination run
        }
      }
    }

    summary.totalFetched += rawFeatures.length;
    summary.totalUpserted += upsertedCount;
    summary.perDest.push({ slug: dest.slug, fetched: rawFeatures.length, upserted: upsertedCount });
    log(`[seedPois] dest=${dest.slug} fetched=${rawFeatures.length} upserted=${upsertedCount}`);
  }

  log(`[seedPois] DONE totalFetched=${summary.totalFetched} totalUpserted=${summary.totalUpserted}`);
  return summary;
}

// ── CLI entrypoint ─────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.apiKey = process.env.OPENTRIPMAP_API_KEY || PLACEHOLDER_KEY;

  // Lazy require — keeps the module load fast when tests import the SUT
  // surface without invoking main().
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const fetchImpl = (typeof fetch === 'function') ? fetch : null;

  try {
    await runSeed({ prisma, fetchImpl, logger: console }, args);
    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    console.error('[seedPois] fatal:', err);
    try { await prisma.$disconnect(); } catch { /* ignore */ }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runSeed,
  parseArgs,
  pickDestinations,
  mapToUpsert,
  pickPrimaryCategory,
  loadFixture,
  filterFixtureForDest,
  fetchDestinationLive,
  DESTINATIONS,
  FIXTURE_PATH,
  PLACEHOLDER_KEY,
  PER_DESTINATION_LIMIT,
  RATE_LIMIT_MS,
};
