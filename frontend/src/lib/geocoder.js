// frontend/src/lib/geocoder.js — OSM Nominatim wrapper with LRU cache + rate limiting.
//
// Per PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.4. Used by Itinerary editor +
// MapPreview to resolve user-typed place names ("Goa beach", "Sheikh Zayed
// Mosque, Abu Dhabi") into {lat, lng} coordinates for map pinning, and
// the reverse — turning a manually-clicked map point into a display name.
//
// Why a custom wrapper instead of a Google/Mapbox SDK
//   - Nominatim is FREE — no API key, no quota negotiation with finance.
//   - The cost is the strict usage policy: max 1 req/sec, identifiable
//     User-Agent header, attribution required on rendering. This wrapper
//     enforces (1) and (2); MapPreview enforces (3).
//   - Yasin's brand pack (Q22) is still pending, but a free geocoder lets
//     itinerary builders ship usable maps today.
//
// Design notes
//   - In-memory LRU keyed by normalized (lowercased + trimmed) query.
//     Cap at 500 entries — at ~200 bytes per entry that's ~100KB of JS heap
//     which is well below any reasonable budget.
//   - Rate-limit via a single promise-chain queue. All callers share the
//     same queue so parallel `geocode(...)` invocations serialize at the
//     wire while still returning Promises eagerly.
//   - Network errors swallowed (returned as null + console.warn) so a
//     transient outage doesn't cascade into a UI crash. Callers should
//     treat null as "couldn't resolve" and fall back to a manual pin.
//   - `clearCache()` exported solely for tests.
//
// Contract pinned
//   - geocode(query) → Promise<{lat, lng, display_name} | null>
//   - reverseGeocode(lat, lng) → Promise<{lat, lng, display_name} | null>
//   - Cache key is `query.trim().toLowerCase()` (geocode) or
//     `${lat.toFixed(6)},${lng.toFixed(6)}` (reverse).
//   - User-Agent: 'GlobussoftCRM/1.0 (https://crm.globusdemos.com)'.
//   - Minimum gap between outbound Nominatim requests: 1000ms.

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'GlobussoftCRM/1.0 (https://crm.globusdemos.com)';
const RATE_LIMIT_MS = 1000;
const LRU_CAP = 500;

// Map preserves insertion order, so we exploit that for LRU semantics:
//   - on read hit:   delete + re-set (moves to most-recently-used end)
//   - on write:      delete + set (same; then evict head if over cap)
const cache = new Map();

// Single shared promise chain — every outbound request awaits the prior
// one then sleeps RATE_LIMIT_MS so we never exceed 1 req/sec.
let rateLimitTail = Promise.resolve();

function normalizeQuery(query) {
  return String(query || '').trim().toLowerCase();
}

function lruGet(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  // Move to most-recently-used position.
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function lruSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  // Evict oldest while over cap. Map iteration order = insertion order,
  // so the first key is the least recently used.
  while (cache.size > LRU_CAP) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function scheduleRateLimited(fn) {
  // Chain the new call onto the tail. The tail resolves only after the
  // prior fetch completed AND we slept RATE_LIMIT_MS. Caller's promise
  // resolves with whatever `fn()` resolves.
  const result = rateLimitTail.then(fn);
  rateLimitTail = result.then(
    () => new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS)),
    () => new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS)),
  );
  return result;
}

async function fetchNominatim(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        // Nominatim policy: identifiable UA is required. Anonymous /
        // generic UAs are rejected with 403 and the IP is rate-banned.
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (!resp || !resp.ok) {
      console.warn(`[geocoder] Nominatim returned ${resp?.status || 'no-response'} for ${url}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.warn('[geocoder] Nominatim network error:', err?.message || err);
    return null;
  }
}

/**
 * Forward-geocode a free-text query to a lat/lng pair.
 *
 * @param {string} query — free-text place name, e.g. "Goa beach"
 * @returns {Promise<{lat:number, lng:number, display_name:string} | null>}
 */
export async function geocode(query) {
  const key = normalizeQuery(query);
  if (!key) return null;

  const cached = lruGet(`fwd:${key}`);
  if (cached !== undefined) return cached;

  const url = `${NOMINATIM_BASE}/search?format=json&q=${encodeURIComponent(key)}&limit=1`;
  const data = await scheduleRateLimited(() => fetchNominatim(url));

  let result = null;
  if (Array.isArray(data) && data.length > 0) {
    const top = data[0];
    const lat = parseFloat(top.lat);
    const lng = parseFloat(top.lon);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      result = { lat, lng, display_name: top.display_name || key };
    }
  }
  lruSet(`fwd:${key}`, result);
  return result;
}

/**
 * Reverse-geocode a lat/lng pair to a human-readable place name.
 *
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{lat:number, lng:number, display_name:string} | null>}
 */
export async function reverseGeocode(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;

  const key = `rev:${latNum.toFixed(6)},${lngNum.toFixed(6)}`;
  const cached = lruGet(key);
  if (cached !== undefined) return cached;

  const url = `${NOMINATIM_BASE}/reverse?format=json&lat=${latNum}&lon=${lngNum}`;
  const data = await scheduleRateLimited(() => fetchNominatim(url));

  let result = null;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (data.display_name) {
      result = {
        lat: latNum,
        lng: lngNum,
        display_name: data.display_name,
      };
    }
  }
  lruSet(key, result);
  return result;
}

/**
 * Test-only — empties the LRU cache and resets the rate-limit chain.
 * Call between tests so cache hits from one test don't pollute the next.
 */
export function clearCache() {
  cache.clear();
  rateLimitTail = Promise.resolve();
}

// Internal — exported for test inspection only. NOT part of the public API.
export const __test__ = {
  cache,
  LRU_CAP,
  RATE_LIMIT_MS,
  USER_AGENT,
};
