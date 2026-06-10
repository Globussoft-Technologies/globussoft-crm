/**
 * Unit tests for backend/scripts/seedOpenTripMapPois.js — the S11 POI
 * catalog seeder per PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.5.
 *
 * Scope:
 *   - runSeed() drives the whole pipeline; tests pass it mock prisma +
 *     mock fetch + a logger and verify upsert call shape, idempotency,
 *     rate-limit, fixture-mode fan-out, CLI-flag scoping, error isolation.
 *   - parseArgs() / pickDestinations() / mapToUpsert() / loadFixture() /
 *     filterFixtureForDest() / pickPrimaryCategory() are pure helpers
 *     exercised directly.
 *
 * Why this layer + not an integration test:
 *   - The script's behaviour is dominated by HTTP + DB shape — both are
 *     easier to pin via mock surfaces than via live calls. The fixture
 *     itself is the integration-test contract; vitest pins the transform
 *     + the upsert plumbing on top of it.
 *   - This avoids burning OpenTripMap free-tier quota on CI runs.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import {
  runSeed,
  parseArgs,
  pickDestinations,
  mapToUpsert,
  pickPrimaryCategory,
  loadFixture,
  filterFixtureForDest,
  DESTINATIONS,
  FIXTURE_PATH,
  PLACEHOLDER_KEY,
  PER_DESTINATION_LIMIT,
  RATE_LIMIT_MS,
} from '../../scripts/seedOpenTripMapPois.js';

function makeFakePrisma() {
  const upsert = vi.fn().mockResolvedValue({ id: 1 });
  return { travelPoi: { upsert }, _upsert: upsert };
}

function makeLogger() {
  const messages = [];
  return { log: (msg) => messages.push(String(msg)), messages };
}

describe('parseArgs', () => {
  test('--dry-run is captured', () => {
    expect(parseArgs(['--dry-run'])).toMatchObject({ dryRun: true, useFixture: false, destinations: null });
  });

  test('--use-fixture is captured', () => {
    expect(parseArgs(['--use-fixture'])).toMatchObject({ useFixture: true, dryRun: false });
  });

  test('--destinations=goa,jaipur parses to array', () => {
    expect(parseArgs(['--destinations=goa,jaipur'])).toMatchObject({ destinations: ['goa', 'jaipur'] });
  });

  test('--destinations= with empty list normalises to null (= all)', () => {
    expect(parseArgs(['--destinations='])).toMatchObject({ destinations: null });
  });

  test('multiple flags compose without clobbering each other', () => {
    const r = parseArgs(['--dry-run', '--use-fixture', '--destinations=paris']);
    expect(r).toMatchObject({ dryRun: true, useFixture: true, destinations: ['paris'] });
  });
});

describe('pickDestinations + DESTINATIONS constant', () => {
  test('DESTINATIONS covers all 10 expected slugs', () => {
    const slugs = DESTINATIONS.map((d) => d.slug).sort();
    expect(slugs).toEqual(
      ['agra', 'goa', 'istanbul', 'jaipur', 'kerala', 'london', 'mecca', 'medina', 'paris', 'rome'].sort()
    );
  });

  test('every destination has a country code + lat/lng + radiusMeters', () => {
    for (const d of DESTINATIONS) {
      expect(d.country).toMatch(/^[A-Z]{2}$/);
      expect(typeof d.lat).toBe('number');
      expect(typeof d.lng).toBe('number');
      expect(d.radiusMeters).toBeGreaterThan(0);
    }
  });

  test('pickDestinations(null) returns all 10', () => {
    expect(pickDestinations(null)).toHaveLength(10);
  });

  test('pickDestinations(["goa","paris"]) returns only those two (order from DESTINATIONS)', () => {
    const r = pickDestinations(['goa', 'paris']);
    expect(r.map((d) => d.slug)).toEqual(['goa', 'paris']);
  });

  test('pickDestinations is case-insensitive', () => {
    expect(pickDestinations(['GOA', 'Paris']).map((d) => d.slug)).toEqual(['goa', 'paris']);
  });
});

describe('pickPrimaryCategory (kinds → bucket)', () => {
  test.each([
    ['mosques,religion,historic', 'religious'],
    ['churches,religion', 'religious'],
    ['temples,architecture', 'religious'],
    ['historic,monuments_and_memorials', 'historical'],
    ['archaeological_sites', 'historical'],
    ['beaches,natural', 'natural'],
    ['mountains,natural', 'natural'],
    ['gardens_and_parks', 'natural'],
    ['museums,cultural', 'cultural'],
    ['theatres_and_entertainments', 'cultural'],
    ['palaces,museums', 'cultural'],
    ['unknown_kind', 'other'],
    ['', null],
    [null, null],
  ])('kinds=%s → %s', (kinds, expected) => {
    expect(pickPrimaryCategory(kinds)).toBe(expected);
  });
});

describe('mapToUpsert (POI shape → upsert payload)', () => {
  test('basic OpenTripMap-shaped row → full payload', () => {
    const dest = { slug: 'paris', country: 'FR' };
    const raw = {
      xid: 'Q243',
      name: 'Eiffel Tower',
      kinds: 'historic,architecture,interesting_places',
      wikidata: 'Q243',
      point: { lat: 48.8584, lon: 2.2945 },
    };
    const out = mapToUpsert(raw, dest);
    expect(out).toMatchObject({
      externalSource: 'opentripmap',
      externalId: 'Q243',
      name: 'Eiffel Tower',
      category: 'historical',
      latitude: 48.8584,
      longitude: 2.2945,
      country: 'FR',
      destinationSlug: 'paris',
      wikidataId: 'Q243',
      pendingApproval: false,
    });
  });

  test('fixture-augmented row honours nameLocal / image / descriptionShort', () => {
    const raw = {
      xid: 'Q11459',
      name: 'Taj Mahal',
      nameLocal: 'ताज महल',
      country: 'IN',
      destinationSlug: 'agra',
      image: 'https://example.com/taj.jpg',
      descriptionShort: '17th-century mausoleum',
      kinds: 'historic,unesco',
      point: { lat: 27.1751, lon: 78.0421 },
    };
    const out = mapToUpsert(raw, null);
    expect(out.nameLocal).toBe('ताज महल');
    expect(out.imageUrl).toBe('https://example.com/taj.jpg');
    expect(out.descriptionShort).toBe('17th-century mausoleum');
    expect(out.country).toBe('IN'); // raw.country wins over dest fallback
  });

  test('missing xid or name returns null (defensive)', () => {
    expect(mapToUpsert({ name: 'No Xid' }, null)).toBeNull();
    expect(mapToUpsert({ xid: 'X1' }, null)).toBeNull();
    expect(mapToUpsert(null, null)).toBeNull();
  });

  test('lat/lng falls back gracefully when point shape is missing', () => {
    const out = mapToUpsert({ xid: 'X1', name: 'P', kinds: '' }, { slug: 'goa', country: 'IN' });
    expect(out.latitude).toBeNull();
    expect(out.longitude).toBeNull();
  });
});

describe('loadFixture + filterFixtureForDest', () => {
  test('loadFixture reads the bundled sample fixture and returns features array', () => {
    const features = loadFixture(FIXTURE_PATH);
    expect(Array.isArray(features)).toBe(true);
    expect(features.length).toBeGreaterThanOrEqual(15);
    for (const f of features.slice(0, 3)) {
      expect(f.xid).toBeTruthy();
      expect(f.name).toBeTruthy();
    }
  });

  test('loadFixture throws on missing file', () => {
    expect(() => loadFixture(path.resolve('/does/not/exist.json'))).toThrow(/fixture not found/);
  });

  test('filterFixtureForDest matches by destinationSlug', () => {
    const features = loadFixture(FIXTURE_PATH);
    const goaPois = filterFixtureForDest(features, { slug: 'goa', country: 'IN' });
    expect(goaPois.length).toBeGreaterThan(0);
    expect(goaPois.every((f) => f.destinationSlug === 'goa')).toBe(true);
  });

  test('filterFixtureForDest falls back to country match when destinationSlug missing', () => {
    const features = [
      { xid: 'A', name: 'A', country: 'FR' }, // no destinationSlug → falls back to country
      { xid: 'B', name: 'B', destinationSlug: 'paris' },
      { xid: 'C', name: 'C', country: 'IN' },
    ];
    const out = filterFixtureForDest(features, { slug: 'paris', country: 'FR' });
    expect(out.map((f) => f.xid).sort()).toEqual(['A', 'B']);
  });
});

describe('runSeed (fixture-mode pipeline)', () => {
  let prisma;
  let logger;

  beforeEach(() => {
    prisma = makeFakePrisma();
    logger = makeLogger();
  });

  test('fixture-mode upserts every fixture POI across all destinations', async () => {
    const summary = await runSeed(
      { prisma, fetchImpl: null, logger },
      { apiKey: PLACEHOLDER_KEY, useFixture: true, dryRun: false, destinations: null }
    );
    expect(summary.perDest).toHaveLength(10);
    expect(summary.totalUpserted).toBeGreaterThan(0);
    expect(prisma._upsert).toHaveBeenCalled();
  });

  test('upsert call shape uses the natural-key compound on (externalSource, externalId)', async () => {
    await runSeed(
      { prisma, fetchImpl: null, logger },
      { apiKey: PLACEHOLDER_KEY, useFixture: true, dryRun: false, destinations: ['paris'] }
    );
    const firstCall = prisma._upsert.mock.calls[0][0];
    expect(firstCall.where).toMatchObject({
      externalSource_externalId: {
        externalSource: 'opentripmap',
        externalId: expect.any(String),
      },
    });
    expect(firstCall.create).toMatchObject({ externalSource: 'opentripmap', pendingApproval: false });
    // update intentionally excludes pendingApproval — preserves manual rep approval state
    expect(firstCall.update).not.toHaveProperty('pendingApproval');
  });

  test('idempotent: second run over same fixture upserts same xids again (no dup creates)', async () => {
    await runSeed(
      { prisma, fetchImpl: null, logger },
      { apiKey: PLACEHOLDER_KEY, useFixture: true, dryRun: false, destinations: ['agra'] }
    );
    const first = prisma._upsert.mock.calls.map((c) => c[0].where.externalSource_externalId.externalId);
    prisma._upsert.mockClear();
    await runSeed(
      { prisma, fetchImpl: null, logger },
      { apiKey: PLACEHOLDER_KEY, useFixture: true, dryRun: false, destinations: ['agra'] }
    );
    const second = prisma._upsert.mock.calls.map((c) => c[0].where.externalSource_externalId.externalId);
    expect(second).toEqual(first); // same xids, same shape — DB UNIQUE prevents dup rows
  });

  test('--dry-run skips upsert but still logs fetched counts', async () => {
    const summary = await runSeed(
      { prisma, fetchImpl: null, logger },
      { apiKey: PLACEHOLDER_KEY, useFixture: true, dryRun: true, destinations: ['paris'] }
    );
    expect(prisma._upsert).not.toHaveBeenCalled();
    expect(summary.totalUpserted).toBe(0);
    expect(summary.totalFetched).toBeGreaterThan(0);
  });

  test('--destinations scoping limits the per-destination loop', async () => {
    const summary = await runSeed(
      { prisma, fetchImpl: null, logger },
      { apiKey: PLACEHOLDER_KEY, useFixture: true, dryRun: false, destinations: ['mecca', 'medina'] }
    );
    expect(summary.perDest.map((d) => d.slug)).toEqual(['mecca', 'medina']);
  });

  test('empty destinations selection logs + returns zero counts gracefully', async () => {
    const summary = await runSeed(
      { prisma, fetchImpl: null, logger },
      { apiKey: PLACEHOLDER_KEY, useFixture: true, dryRun: false, destinations: ['nonexistent'] }
    );
    expect(summary.totalFetched).toBe(0);
    expect(summary.totalUpserted).toBe(0);
    expect(logger.messages.some((m) => /no destinations selected/i.test(m))).toBe(true);
  });

  test('per-POI upsert error is isolated — other POIs in the same destination still upsert', async () => {
    let n = 0;
    prisma.travelPoi.upsert = vi.fn().mockImplementation(() => {
      n += 1;
      if (n === 1) return Promise.reject(new Error('simulated DB error'));
      return Promise.resolve({ id: n });
    });
    const summary = await runSeed(
      { prisma, fetchImpl: null, logger },
      { apiKey: PLACEHOLDER_KEY, useFixture: true, dryRun: false, destinations: ['agra'] }
    );
    // perDest still records a positive count (the successful upserts)
    expect(summary.perDest[0].upserted).toBeGreaterThanOrEqual(1);
    expect(logger.messages.some((m) => /upsert-error/.test(m))).toBe(true);
  });

  test('logging format pinned: [seedPois] dest=<slug> fetched=<n> upserted=<m>', async () => {
    await runSeed(
      { prisma, fetchImpl: null, logger },
      { apiKey: PLACEHOLDER_KEY, useFixture: true, dryRun: false, destinations: ['rome'] }
    );
    const matched = logger.messages.find((m) => /^\[seedPois\] dest=rome fetched=\d+ upserted=\d+$/.test(m));
    expect(matched).toBeTruthy();
  });

  test('summary.totalFetched + totalUpserted are consistent across perDest entries', async () => {
    const summary = await runSeed(
      { prisma, fetchImpl: null, logger },
      { apiKey: PLACEHOLDER_KEY, useFixture: true, dryRun: false, destinations: ['paris', 'rome'] }
    );
    const sumFetched = summary.perDest.reduce((acc, d) => acc + d.fetched, 0);
    const sumUpserted = summary.perDest.reduce((acc, d) => acc + d.upserted, 0);
    expect(summary.totalFetched).toBe(sumFetched);
    expect(summary.totalUpserted).toBe(sumUpserted);
  });
});

describe('runSeed (live-mode pipeline)', () => {
  let prisma;
  let logger;

  beforeEach(() => {
    prisma = makeFakePrisma();
    logger = makeLogger();
  });

  test('live mode hits one URL per destination with apikey + radius + lat + lng query params', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ xid: 'X1', name: 'Demo', point: { lat: 0, lon: 0 }, kinds: 'historic' }]),
    });
    await runSeed(
      { prisma, fetchImpl, logger },
      { apiKey: 'real-key-abc', useFixture: false, dryRun: false, destinations: ['paris'] }
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = fetchImpl.mock.calls[0][0];
    expect(url).toContain('apikey=real-key-abc');
    expect(url).toContain('radius=30000');
    expect(url).toContain('lat=48.8566');
    expect(url).toContain('lon=2.3522');
    expect(url).toContain(`limit=${PER_DESTINATION_LIMIT}`);
  });

  test('live mode rate-limits at least 1s between consecutive destination calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    const startTimes = [];
    fetchImpl.mockImplementation(() => {
      startTimes.push(Date.now());
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    await runSeed(
      { prisma, fetchImpl, logger },
      { apiKey: 'real-key', useFixture: false, dryRun: false, destinations: ['paris', 'rome'] }
    );
    expect(startTimes).toHaveLength(2);
    expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(RATE_LIMIT_MS - 50); // allow scheduler jitter
  }, 15000);

  test('live mode: non-OK fetch response logs error + isolates failure to that destination', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: () => Promise.resolve({}),
    });
    const summary = await runSeed(
      { prisma, fetchImpl, logger },
      { apiKey: 'real-key', useFixture: false, dryRun: false, destinations: ['paris'] }
    );
    expect(summary.perDest[0].error).toMatch(/429/);
    expect(summary.totalUpserted).toBe(0);
  });

  test('placeholder API key forces fixture-mode even without --use-fixture flag', async () => {
    const fetchImpl = vi.fn();
    await runSeed(
      { prisma, fetchImpl, logger },
      { apiKey: PLACEHOLDER_KEY, useFixture: false, dryRun: false, destinations: ['paris'] }
    );
    expect(fetchImpl).not.toHaveBeenCalled(); // never hit live
    // and the fixture path was used → upserts happened
    expect(prisma._upsert).toHaveBeenCalled();
  });

  test('live mode + missing fetch implementation throws (defensive guard)', async () => {
    await expect(
      runSeed(
        { prisma, fetchImpl: null, logger },
        { apiKey: 'real-key', useFixture: false, dryRun: false, destinations: ['paris'] }
      )
    ).rejects.toThrow(/live mode requires a fetch/);
  });
});
