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
