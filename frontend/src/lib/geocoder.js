// frontend/src/lib/geocoder.js — Geocoding via the CRM backend proxy.
//
// Per PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.4. Used by Itinerary editor to
// resolve user-typed place names into {lat, lng} coordinates for map pinning.
//
// Why a backend proxy instead of calling Nominatim directly:
//   Browsers silently drop the User-Agent header (forbidden header name in the
//   Fetch spec). Nominatim requires an identifiable User-Agent per their usage
//   policy — anonymous requests get 403 + IP ban. The backend endpoint at
//   GET /api/travel/pois/geocode sets the header server-side where Node.js
//   can set it freely.
//
// Design notes
//   - In-memory LRU keyed by normalized (lowercased + trimmed) query.
//     Cap at 500 entries (~100KB of JS heap).
//   - No client-side rate-limit queue needed — the backend enforces Nominatim
//     policy; the PoiPicker's 250ms debounce prevents UI spam.
//   - Network errors swallowed (returned as null + console.warn) so a
//     transient outage doesn't crash the UI. Callers treat null as
//     "couldn't resolve" and show the Google Maps fallback link.
//   - clearCache() exported for tests.
//
// Contract (unchanged from prior version):
//   geocode(query) → Promise<{lat, lng, display_name} | null>
//   reverseGeocode(lat, lng) → Promise<{lat, lng, display_name} | null>

import { fetchApi } from '../utils/api';

const LRU_CAP = 500;

const cache = new Map();

// Keep place-picker labels in the CRM's English UI language. Providers may
// return a local-script name (such as Devanagari) in one of the fields that a
// caller displays. This filters suggestions only; coordinates and reverse
// geocoding are deliberately unaffected.
export function isEnglishPlaceSuggestion(result) {
  const label = [
    result?.name, result?.display_name, result?.street, result?.city,
    result?.district, result?.county, result?.state, result?.country,
  ].filter(Boolean).join(" ");
  const letters = label.match(/\p{Letter}/gu) || [];
  return letters.every((letter) => /\p{Script=Latin}/u.test(letter));
}

function normalizeQuery(query) {
  return String(query || '').trim().toLowerCase();
}

function lruGet(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function lruSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > LRU_CAP) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

/**
 * Forward-geocode a free-text query to a lat/lng pair via the backend proxy.
 *
 * @param {string} query — free-text place name, e.g. "ISKCON Temple Rajajinagar Bangalore"
 * @returns {Promise<{lat:number, lng:number, display_name:string} | null>}
 */
export async function geocode(query) {
  const key = normalizeQuery(query);
  if (!key) return null;

  const cached = lruGet(`fwd:${key}`);
  if (cached !== undefined) return cached;

  let result = null;
  try {
    const data = await fetchApi(
      `/api/travel/pois/geocode?q=${encodeURIComponent(key)}`,
      { silent: true },
    );
    if (Array.isArray(data?.results) && data.results.length > 0) {
      const top = data.results[0];
      if (Number.isFinite(top.lat) && Number.isFinite(top.lng)) {
        result = { lat: top.lat, lng: top.lng, display_name: top.display_name || key };
      }
    }
  } catch (err) {
    console.warn('[geocoder] proxy error:', err?.message || err);
  }

  lruSet(`fwd:${key}`, result);
  return result;
}

/**
 * Forward-geocode a free-text query to a short list of candidate places, for
 * type-ahead/autocomplete UIs. Unlike geocode() (which returns only the top
 * match), this returns up to `limit` candidates so the caller can render a
 * dropdown of suggestions as the user types.
 *
 * @param {string} query — free-text partial place name
 * @param {{limit?: number}} [options]
 * @returns {Promise<Array<{lat:number, lng:number, display_name:string}>>}
 */
export async function geocodeSuggestions(query, { limit = 6 } = {}) {
  const key = normalizeQuery(query);
  if (!key) return [];

  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 1, 1), 5);
  const cacheKey = `sugg:${cappedLimit}:${key}`;
  const cached = lruGet(cacheKey);
  if (cached !== undefined) return cached;

  let results = [];
  try {
    const data = await fetchApi(
      `/api/travel/pois/geocode?q=${encodeURIComponent(key)}&limit=${cappedLimit}`,
      { silent: true },
    );
    if (Array.isArray(data?.results)) {
      results = data.results.filter(
        (r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lng) && r?.display_name && isEnglishPlaceSuggestion(r),
      );
    }
  } catch (err) {
    console.warn('[geocoder] suggestions proxy error:', err?.message || err);
  }

  lruSet(cacheKey, results);
  return results;
}

/**
 * Reverse-geocode a lat/lng pair to a human-readable place name.
 * Also proxied through the backend for the same User-Agent reason.
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

  let result = null;
  try {
    const data = await fetchApi(
      `/api/travel/pois/geocode?reverse=1&lat=${latNum}&lng=${lngNum}`,
      { silent: true },
    );
    if (data?.display_name) {
      result = { lat: latNum, lng: lngNum, display_name: data.display_name };
    }
  } catch (err) {
    console.warn('[geocoder] reverse proxy error:', err?.message || err);
  }

  lruSet(key, result);
  return result;
}

/**
 * Forward-geocode to a RANKED LIST of candidates, for typeahead pickers.
 *
 * Unlike geocode() — which resolves one query to one best-guess point and is
 * used for unattended auto-pinning — this is the interactive path: the user
 * sees every candidate and picks the right one, so ambiguity is a feature,
 * not a failure. It hits the vertical-neutral /api/geocode mount rather than
 * /api/travel/pois/geocode, because the wellness clinic geofence picker is a
 * caller and has no business inside the travel namespace.
 *
 * Results carry address components (city/state/postcode) alongside the
 * coordinates so a form can pre-fill sibling fields from one pick.
 *
 * @param {string} query
 * @param {number} [limit=6] — backend clamps to 1..10
 * @param {object} [opts]
 * @param {string} [opts.bbox] — "minLon,minLat,maxLon,maxLat". Upstream this
 *        is a HARD filter, so callers that pass one must be willing to retry
 *        without it (see GeofencePicker, which falls back to a worldwide
 *        search when the in-country box comes back empty).
 * @returns {Promise<Array<{lat:number, lng:number, display_name:string, name:string, street:string, city:string, district:string, county:string, state:string, country:string, postcode:string}>>}
 *          Empty array on no-match OR on any network/upstream failure —
 *          a typeahead must never throw into a keystroke handler.
 */
export async function geocodeSuggest(query, limit = 6, opts = {}) {
  const key = normalizeQuery(query);
  if (!key) return [];

  const bbox = opts.bbox || '';
  // bbox is part of the cache key: the same text inside vs. outside a box is
  // a genuinely different query, and collapsing them would serve worldwide
  // results to a caller that asked to stay in-country (or vice versa).
  const cacheKey = `sug:${limit}:${bbox}:${key}`;
  const cached = lruGet(cacheKey);
  if (cached !== undefined) return cached;

  let results = [];
  try {
    const data = await fetchApi(
      `/api/geocode?q=${encodeURIComponent(key)}&limit=${limit}`
        + (bbox ? `&bbox=${encodeURIComponent(bbox)}` : ''),
      { silent: true },
    );
    if (Array.isArray(data?.results)) {
      results = data.results.filter(
        (r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lng) && isEnglishPlaceSuggestion(r),
      );
    }
  } catch (err) {
    console.warn('[geocoder] suggest proxy error:', err?.message || err);
  }

  lruSet(cacheKey, results);
  return results;
}

/**
 * Test-only — empties the LRU cache.
 */
export function clearCache() {
  cache.clear();
}

// Internal — exported for test inspection only.
export const __test__ = {
  cache,
  LRU_CAP,
};
