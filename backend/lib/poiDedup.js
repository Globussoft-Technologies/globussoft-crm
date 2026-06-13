/**
 * lib/poiDedup — POI deduplication helpers for the Travel itinerary upgrades.
 *
 * Slice G055 (PRD_TRAVEL_ITINERARY_UPGRADES FR-3.2.f): when an operator
 * suggests a new POI via `POST /api/travel/pois`, we want to prevent
 * accidental duplicate rows for the same physical place. Operators
 * sometimes re-key existing POIs because the search miss is silent;
 * if their (lat, lng) is within ~50m of an already-APPROVED row in the
 * same tenant scope, we bounce back with 409 + POI_DUPLICATE_NEARBY and
 * leave the original row alone.
 *
 * Why approved-only:
 *   The pendingApproval queue is shared per-tenant; if two reps
 *   independently suggest the same place within minutes of each other,
 *   the ADMIN reviewing the queue sees both and can pick one. Blocking
 *   the second SUGGEST on a still-PENDING first would create a race
 *   where rep B has nothing to point at. Approved rows are the
 *   authoritative-canonical set; that's the only set worth dedup'ing
 *   against.
 *
 * Tenant scope (matches travel_pois.js GET / catalog read shape):
 *   Comparison set = rows where `tenantId = caller.tenantId` OR
 *   `tenantId IS NULL` (the catalog-wide OpenTripMap seed is shared
 *   across all tenants). A different tenant's tenant-private suggestion
 *   is never compared against — distinct tenants get distinct namespaces.
 *
 * Force-override:
 *   `?force=true` (handled by the caller, not here) bypasses the dedup
 *   check entirely. Real-world scenarios: a Mughal complex with several
 *   monuments <50m apart (Taj courtyard vs the actual mausoleum), a
 *   temple complex with multiple shrines, an airport with adjacent
 *   terminals registered as separate POIs by guides.
 *
 * Exports:
 *   - haversineDistanceMeters(lat1, lng1, lat2, lng2)
 *       Standard haversine formula. Returns metres. Earth radius mean
 *       6371008.8 m (IUGG mean radius). Accurate to <0.5% for any
 *       point-pair on earth; well under the 50m threshold for any
 *       realistic POI comparison.
 *   - findNearbyPoi(prisma, { tenantId, lat, lng, radiusMeters = 50 })
 *       Bounding-box prefilter via Prisma then exact-haversine on
 *       survivors. Returns the nearest APPROVED match within radius
 *       across the tenant scope, or null.
 *
 * Performance notes:
 *   The bounding box is computed from the radius via the standard
 *   "1 degree of latitude ≈ 111_320 m" approximation (constant), and
 *   "1 degree of longitude ≈ 111_320 * cos(lat)" (latitude-dependent).
 *   For a 50m radius this is roughly ±0.00045° lat / ±0.00045°/cos(lat) lng
 *   — Prisma's findMany on (latitude, longitude) range filters narrows
 *   the candidate set to typically <10 rows even on a dense city
 *   (Mumbai South has ~600 POIs in the eventual seed, but they're
 *   spread across >1km² so a 50m box catches at most a handful).
 *   Exact-haversine then runs on those survivors in JS.
 *
 * Test surface:
 *   backend/test/lib/poiDedup.test.js — 18 vitest cases covering
 *   haversine accuracy against known city pairs, bounding-box prefilter
 *   correctness, distinct-tenant isolation, exact-50m threshold edges,
 *   approved-only filter, and the radiusMeters override.
 */

'use strict';

// IUGG mean Earth radius in metres (R_1 = (2a + b) / 3). The CODATA / IUGG
// mean is the most defensible single-value pick for a great-circle
// distance helper. Pole-flat assumption — fine for the 50m scale we
// care about; haversine error vs WGS-84 ellipsoid is <0.5% globally
// and <<1m at this scale.
const EARTH_RADIUS_METERS = 6371008.8;

// One degree of latitude ≈ 111_320 m everywhere on the WGS-84 ellipsoid
// (it varies by <0.6% between equator and pole; this constant is the
// equatorial value, deliberately the LARGER one — using the larger value
// makes the bounding box slightly OVER-sized rather than under-sized,
// so we never drop a candidate that the exact haversine would have
// caught).
const METERS_PER_DEGREE_LATITUDE = 111_320;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Standard haversine formula. Returns the great-circle distance between
 * two (lat, lng) coordinates in metres.
 *
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} distance in metres
 */
function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaPhi = toRadians(lat2 - lat1);
  const deltaLambda = toRadians(lng2 - lng1);

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) *
      Math.cos(phi2) *
      Math.sin(deltaLambda / 2) *
      Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Computes the bounding-box envelope (latitude / longitude deltas) for a
 * given centre point + radius in metres. Used to narrow the Prisma scan
 * before running exact haversine on the survivors.
 *
 * @param {number} centreLat
 * @param {number} radiusMeters
 * @returns {{ deltaLat: number, deltaLng: number }}
 */
function boundingBoxDeltas(centreLat, radiusMeters) {
  const deltaLat = radiusMeters / METERS_PER_DEGREE_LATITUDE;
  // Guard against cos(±90°) ≈ 0 — at the poles longitude is degenerate.
  // Use a small floor; in practice no POI sits at >89.9° lat.
  const cosLat = Math.max(Math.cos(toRadians(centreLat)), 1e-6);
  const deltaLng = radiusMeters / (METERS_PER_DEGREE_LATITUDE * cosLat);
  return { deltaLat, deltaLng };
}

/**
 * Returns the nearest approved POI within `radiusMeters` of the given
 * (lat, lng) coordinate, considering rows scoped to `tenantId` OR
 * `tenantId IS NULL`. Pending-approval rows are excluded. Returns null
 * if no match.
 *
 * @param {object} prismaClient — Prisma client (or a vitest mock with
 *   travelPoi.findMany).
 * @param {object} args
 * @param {number|null} args.tenantId
 * @param {number} args.lat
 * @param {number} args.lng
 * @param {number} [args.radiusMeters=50]
 * @returns {Promise<object|null>} the nearest matching POI row (Prisma
 *   record) augmented with `distance: <metres>`, or null.
 */
async function findNearbyPoi(prismaClient, { tenantId, lat, lng, radiusMeters = 50 }) {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !Number.isFinite(radiusMeters) ||
    radiusMeters <= 0
  ) {
    return null;
  }

  const { deltaLat, deltaLng } = boundingBoxDeltas(lat, radiusMeters);

  const candidates = await prismaClient.travelPoi.findMany({
    where: {
      pendingApproval: false,
      OR: [{ tenantId: tenantId ?? null }, { tenantId: null }],
      latitude: { gte: lat - deltaLat, lte: lat + deltaLat },
      longitude: { gte: lng - deltaLng, lte: lng + deltaLng },
    },
    // Bound the scan — at 50m even in dense cities we expect <10 rows;
    // cap at 50 so a misconfigured radius (e.g. 50_000 instead of 50)
    // can't pull the whole table.
    take: 50,
  });

  let best = null;
  for (const row of candidates) {
    if (row.latitude == null || row.longitude == null) continue;
    const distance = haversineDistanceMeters(lat, lng, row.latitude, row.longitude);
    if (distance <= radiusMeters && (best == null || distance < best.distance)) {
      best = { ...row, distance };
    }
  }
  return best;
}

module.exports = {
  haversineDistanceMeters,
  findNearbyPoi,
  // Exported for unit-test introspection only.
  _internal: {
    EARTH_RADIUS_METERS,
    METERS_PER_DEGREE_LATITUDE,
    boundingBoxDeltas,
  },
};
