// Unit tests for backend/lib/poiDedup.js — Slice G055 (PRD_TRAVEL_ITINERARY_UPGRADES FR-3.2.f).
//
// Pins:
//   1. Module shape — exports haversineDistanceMeters + findNearbyPoi.
//   2. Haversine accuracy against four published city-pair distances
//      (within <0.5% error). Anchors the formula so future micro-edits
//      (e.g. swapping Earth radius constants) don't silently drift the
//      50m threshold.
//   3. Self-distance is zero.
//   4. Symmetry (d(A,B) === d(B,A)).
//   5. Bounding-box prefilter — verifies the Prisma `findMany` is called
//      with a sane lat/lng range that brackets the requested radius.
//   6. Approved-only — pendingApproval rows are excluded from the
//      candidate set (asserted via the where clause passed to Prisma).
//   7. Tenant scope — the where clause includes `tenantId IS NULL` (the
//      catalog-wide OpenTripMap seed) alongside the caller's tenant.
//   8. findNearbyPoi returns null when no row is in range.
//   9. findNearbyPoi returns the nearest of two overlapping candidates.
//  10. findNearbyPoi respects the radiusMeters override (e.g. 100m).
//  11. findNearbyPoi handles candidate rows with null lat/lng gracefully
//      (skips them rather than throwing).
//  12. findNearbyPoi short-circuits on non-finite inputs (returns null
//      rather than letting NaN propagate into a SQL range filter).
//  13. boundingBoxDeltas pole-safety — cos(89.9°) doesn't blow up the
//      longitude delta into Infinity.
//
// No real Prisma — every test uses an inline vi.fn() shim so the suite
// runs deterministically in <100ms.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  haversineDistanceMeters,
  findNearbyPoi,
  _internal,
} from '../../lib/poiDedup.js';

// ─── Reference distances (great-circle, published) ──────────────────
// Reference values cross-checked against multiple geospatial sources
// (distance.to, gpsvisualizer, Wolfram Alpha). All are well above the
// 50m radius we dedup at; this set serves as a "the formula isn't
// broken" gate — the 0.5% tolerance absorbs IUGG-vs-WGS84 radius
// pick + endpoint micro-coordinate rounding.
const PAIRS = [
  // London (Trafalgar Square) → Paris (Notre-Dame)
  { from: [51.50809, -0.12790], to: [48.85296, 2.34999], expected: 343_900, tolerance: 0.005 },
  // New York (Times Square) → Los Angeles (City Hall)
  { from: [40.75800, -73.98550], to: [34.05349, -118.24290], expected: 3_937_000, tolerance: 0.005 },
  // Mumbai (Gateway of India) → Delhi (India Gate)
  { from: [18.92200, 72.83470], to: [28.61290, 77.22950], expected: 1_166_400, tolerance: 0.005 },
  // Sydney (Opera House) → Auckland (Sky Tower)
  { from: [-33.85680, 151.21530], to: [-36.84850, 174.76330], expected: 2_155_700, tolerance: 0.005 },
];

describe('lib/poiDedup — module shape', () => {
  test('exports haversineDistanceMeters function', () => {
    expect(typeof haversineDistanceMeters).toBe('function');
  });
  test('exports findNearbyPoi async function', () => {
    expect(typeof findNearbyPoi).toBe('function');
  });
  test('exports _internal with EARTH_RADIUS_METERS + METERS_PER_DEGREE_LATITUDE + boundingBoxDeltas', () => {
    expect(typeof _internal.EARTH_RADIUS_METERS).toBe('number');
    expect(_internal.EARTH_RADIUS_METERS).toBeGreaterThan(6_300_000);
    expect(_internal.EARTH_RADIUS_METERS).toBeLessThan(6_400_000);
    expect(typeof _internal.METERS_PER_DEGREE_LATITUDE).toBe('number');
    expect(typeof _internal.boundingBoxDeltas).toBe('function');
  });
});

describe('lib/poiDedup — haversine accuracy', () => {
  test.each(PAIRS)(
    'pair ($from → $to) within $tolerance fractional tolerance of $expected m',
    ({ from, to, expected, tolerance }) => {
      const d = haversineDistanceMeters(from[0], from[1], to[0], to[1]);
      const fractionalError = Math.abs(d - expected) / expected;
      expect(fractionalError).toBeLessThan(tolerance);
    },
  );

  test('self-distance is 0', () => {
    expect(haversineDistanceMeters(28.6129, 77.2295, 28.6129, 77.2295)).toBe(0);
  });

  test('symmetry — d(A,B) === d(B,A)', () => {
    const ab = haversineDistanceMeters(18.922, 72.8347, 28.6129, 77.2295);
    const ba = haversineDistanceMeters(28.6129, 77.2295, 18.922, 72.8347);
    expect(ab).toBeCloseTo(ba, 6);
  });

  test('50m-scale accuracy — two points exactly 50m apart land within ±1m', () => {
    // Mumbai-ish lat (~18.92°). 50m due-east is +0.00047°lng (1° lng ≈ 105_300m at this lat).
    const lat = 18.92;
    const lng = 72.83;
    const deltaLng = 50 / (111_320 * Math.cos((lat * Math.PI) / 180));
    const d = haversineDistanceMeters(lat, lng, lat, lng + deltaLng);
    expect(Math.abs(d - 50)).toBeLessThan(1);
  });
});

describe('lib/poiDedup — boundingBoxDeltas', () => {
  test('1km radius at equator yields ~0.009° lat AND lng', () => {
    const { deltaLat, deltaLng } = _internal.boundingBoxDeltas(0, 1000);
    expect(deltaLat).toBeGreaterThan(0.008);
    expect(deltaLat).toBeLessThan(0.010);
    // At equator, lat-delta and lng-delta should be near-identical.
    expect(Math.abs(deltaLat - deltaLng)).toBeLessThan(1e-9);
  });

  test('1km radius at 60°N — lng-delta is ~2x lat-delta (cos(60°)=0.5)', () => {
    const { deltaLat, deltaLng } = _internal.boundingBoxDeltas(60, 1000);
    expect(deltaLng / deltaLat).toBeCloseTo(2, 1);
  });

  test('near-pole (89.9°) doesn\'t blow up to Infinity', () => {
    const { deltaLng } = _internal.boundingBoxDeltas(89.9, 100);
    expect(Number.isFinite(deltaLng)).toBe(true);
  });
});

describe('lib/poiDedup — findNearbyPoi (bounding-box prefilter + exact haversine)', () => {
  function makePrismaMock(rows) {
    return {
      travelPoi: { findMany: vi.fn().mockResolvedValue(rows) },
    };
  }

  let prismaMock;
  beforeEach(() => {
    prismaMock = makePrismaMock([]);
  });

  test('returns null when no candidates exist', async () => {
    const result = await findNearbyPoi(prismaMock, {
      tenantId: 7,
      lat: 18.922,
      lng: 72.8347,
    });
    expect(result).toBeNull();
  });

  test('passes a bounding-box where clause to Prisma', async () => {
    await findNearbyPoi(prismaMock, {
      tenantId: 7,
      lat: 18.922,
      lng: 72.8347,
      radiusMeters: 50,
    });
    expect(prismaMock.travelPoi.findMany).toHaveBeenCalledOnce();
    const args = prismaMock.travelPoi.findMany.mock.calls[0][0];
    expect(args.where.pendingApproval).toBe(false);
    expect(args.where.latitude.gte).toBeLessThan(18.922);
    expect(args.where.latitude.lte).toBeGreaterThan(18.922);
    expect(args.where.longitude.gte).toBeLessThan(72.8347);
    expect(args.where.longitude.lte).toBeGreaterThan(72.8347);
  });

  test('tenant scope — where OR includes both caller tenantId AND null', async () => {
    await findNearbyPoi(prismaMock, {
      tenantId: 7,
      lat: 18.922,
      lng: 72.8347,
    });
    const args = prismaMock.travelPoi.findMany.mock.calls[0][0];
    const orList = args.where.OR;
    expect(Array.isArray(orList)).toBe(true);
    const tenantIds = orList.map((c) => c.tenantId);
    expect(tenantIds).toContain(7);
    expect(tenantIds).toContain(null);
  });

  test('returns the row when one is within 50m', async () => {
    // Place a candidate at the same lat, +0.0001° lng (~10m at this lat) → well within 50m.
    prismaMock = makePrismaMock([
      { id: 42, latitude: 18.922, longitude: 72.83480, name: 'Existing POI' },
    ]);
    const result = await findNearbyPoi(prismaMock, {
      tenantId: 7,
      lat: 18.922,
      lng: 72.8347,
      radiusMeters: 50,
    });
    expect(result).toBeTruthy();
    expect(result.id).toBe(42);
    expect(result.distance).toBeGreaterThan(0);
    expect(result.distance).toBeLessThan(50);
  });

  test('returns null when candidate exists but is >50m away', async () => {
    // Place a candidate ~70m away (lng-delta 70m / 105300 ≈ 0.000665°).
    prismaMock = makePrismaMock([
      { id: 42, latitude: 18.922, longitude: 72.83537, name: 'Far POI' },
    ]);
    const result = await findNearbyPoi(prismaMock, {
      tenantId: 7,
      lat: 18.922,
      lng: 72.8347,
      radiusMeters: 50,
    });
    expect(result).toBeNull();
  });

  test('returns the NEAREST of two in-range candidates', async () => {
    prismaMock = makePrismaMock([
      { id: 1, latitude: 18.922, longitude: 72.83478, name: 'Closer' }, // ~8m
      { id: 2, latitude: 18.922, longitude: 72.83490, name: 'Further' }, // ~21m
    ]);
    const result = await findNearbyPoi(prismaMock, {
      tenantId: 7,
      lat: 18.922,
      lng: 72.8347,
      radiusMeters: 50,
    });
    expect(result.id).toBe(1);
  });

  test('radiusMeters override — 100m catches what 50m drops', async () => {
    prismaMock = makePrismaMock([
      { id: 42, latitude: 18.922, longitude: 72.83537, name: 'Mid POI' }, // ~70m
    ]);
    const result50 = await findNearbyPoi(prismaMock, {
      tenantId: 7,
      lat: 18.922,
      lng: 72.8347,
      radiusMeters: 50,
    });
    expect(result50).toBeNull();

    // Re-mock — radius=100 needs a larger bounding box, so reuse a fresh mock.
    prismaMock = makePrismaMock([
      { id: 42, latitude: 18.922, longitude: 72.83537, name: 'Mid POI' },
    ]);
    const result100 = await findNearbyPoi(prismaMock, {
      tenantId: 7,
      lat: 18.922,
      lng: 72.8347,
      radiusMeters: 100,
    });
    expect(result100).toBeTruthy();
    expect(result100.id).toBe(42);
  });

  test('skips candidate rows with null lat/lng (defensive)', async () => {
    prismaMock = makePrismaMock([
      { id: 1, latitude: null, longitude: null, name: 'No coords' },
      { id: 2, latitude: 18.922, longitude: 72.83478, name: 'Has coords' },
    ]);
    const result = await findNearbyPoi(prismaMock, {
      tenantId: 7,
      lat: 18.922,
      lng: 72.8347,
      radiusMeters: 50,
    });
    expect(result.id).toBe(2);
  });

  test('non-finite lat/lng input returns null without calling Prisma', async () => {
    const r1 = await findNearbyPoi(prismaMock, {
      tenantId: 7,
      lat: NaN,
      lng: 72.8347,
    });
    expect(r1).toBeNull();
    expect(prismaMock.travelPoi.findMany).not.toHaveBeenCalled();

    const r2 = await findNearbyPoi(prismaMock, {
      tenantId: 7,
      lat: 18.922,
      lng: Infinity,
    });
    expect(r2).toBeNull();
  });

  test('null tenantId is accepted (catalog-wide caller scope)', async () => {
    await findNearbyPoi(prismaMock, {
      tenantId: null,
      lat: 18.922,
      lng: 72.8347,
    });
    const args = prismaMock.travelPoi.findMany.mock.calls[0][0];
    const tenantIds = args.where.OR.map((c) => c.tenantId);
    // Both clauses end up as null when tenantId is null — that's fine,
    // the SQL is `(tenantId IS NULL OR tenantId IS NULL)` which the
    // Prisma planner reduces. Both members being null is the correct shape.
    expect(tenantIds.every((t) => t === null)).toBe(true);
  });

  test('caps candidate take at 50 — protects against misconfigured radius', async () => {
    await findNearbyPoi(prismaMock, {
      tenantId: 7,
      lat: 18.922,
      lng: 72.8347,
    });
    const args = prismaMock.travelPoi.findMany.mock.calls[0][0];
    expect(args.take).toBe(50);
  });
});
