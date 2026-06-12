import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * frontend/src/lib/geocoder.js — OSM Nominatim wrapper
 *
 * What's tested
 *   - Forward geocode happy path: parses Nominatim's array response into
 *     {lat, lng, display_name}.
 *   - Empty Nominatim result → returns null (no throw).
 *   - Network error → returns null (no throw, warning logged).
 *   - Cache hit: a second call for the same query never fires fetch.
 *   - Cache key is normalized (case-insensitive + trimmed): "Goa", " goa ",
 *     "GOA" all hit the same cache slot.
 *   - LRU eviction at LRU_CAP: oldest entry drops when a 501st query lands.
 *   - LRU recency: re-reading a key moves it to most-recently-used so it
 *     survives subsequent evictions.
 *   - Rate-limit serialization: two parallel calls produce ≥1 RATE_LIMIT_MS
 *     spacing between outbound fetch invocations.
 *   - Reverse geocode happy path + null on no result.
 *   - Reverse geocode rejects non-finite lat/lng without calling fetch.
 *   - clearCache empties the LRU so cache-miss behaviour resumes.
 *   - User-Agent header is the canonical "GlobussoftCRM/1.0 (…)" form
 *     required by Nominatim policy.
 *
 * Why
 *   This geocoder is the only resolver path between user-typed place
 *   names ("Goa beach") and the lat/lng pins MapPreview consumes.
 *   Regressing the cache means we burst-hammer Nominatim and get IP-
 *   banned. Regressing the rate limit costs the same way. Regressing
 *   the error swallow turns one transient outage into a UI crash for
 *   every itinerary builder who types a place name.
 *
 * Contract pinned
 *   - geocode(q) hits /search?format=json&q=<q>&limit=1
 *   - reverseGeocode(lat, lng) hits /reverse?format=json&lat=…&lon=…
 *   - User-Agent: 'GlobussoftCRM/1.0 (https://crm.globusdemos.com)'
 *   - Min spacing between outbound requests: RATE_LIMIT_MS (1000ms)
 *   - LRU cap: LRU_CAP (500)
 */

import {
  geocode,
  reverseGeocode,
  clearCache,
  __test__,
} from '../lib/geocoder';

// We use fake timers so the rate-limit sleep doesn't actually block the
// test run. setTimeout calls inside the geocoder return immediately when
// vi.runAllTimersAsync() is awaited.
beforeEach(() => {
  clearCache();
  vi.useFakeTimers();
  // Default fetch mock — overridden per test.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearCache();
});

/** Helper: advance timers until a pending promise settles. */
async function flush(promise) {
  // Run pending micro/macrotasks (handles the rate-limit setTimeout).
  await vi.runAllTimersAsync();
  return promise;
}

describe('geocode — forward lookup', () => {
  it('returns {lat, lng, display_name} on a Nominatim hit', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { lat: '15.2993', lon: '74.124', display_name: 'Goa, India' },
      ],
    });

    const p = geocode('Goa');
    const result = await flush(p);

    expect(result).toEqual({
      lat: 15.2993,
      lng: 74.124,
      display_name: 'Goa, India',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = global.fetch.mock.calls[0][0];
    expect(url).toMatch(/\/search\?format=json&q=goa&limit=1$/);
  });

  it('sends the canonical User-Agent header on every outbound call', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ lat: '0', lon: '0', display_name: 'Equator' }],
    });

    const p = geocode('Equator');
    await flush(p);

    const opts = global.fetch.mock.calls[0][1];
    expect(opts.headers['User-Agent']).toBe(
      'GlobussoftCRM/1.0 (https://crm.globusdemos.com)',
    );
  });

  it('returns null when Nominatim returns an empty array (no match)', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [],
    });

    const p = geocode('zzzzzzzzzzz-no-such-place');
    const result = await flush(p);

    expect(result).toBeNull();
  });

  it('returns null and does NOT throw on a network error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch.mockRejectedValueOnce(new Error('ECONNRESET'));

    const p = geocode('Paris');
    const result = await flush(p);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns null and does NOT throw on a non-OK HTTP response', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => null,
    });

    const p = geocode('Mumbai');
    const result = await flush(p);

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns null for an empty / whitespace-only query without calling fetch', async () => {
    expect(await geocode('')).toBeNull();
    expect(await geocode('   ')).toBeNull();
    expect(await geocode(null)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('geocode — LRU cache', () => {
  it('a second call with the same query hits the cache (no second fetch)', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { lat: '48.8566', lon: '2.3522', display_name: 'Paris, France' },
      ],
    });

    const p1 = geocode('Paris');
    await flush(p1);
    const p2 = geocode('Paris');
    const r2 = await flush(p2);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(r2).toEqual({
      lat: 48.8566,
      lng: 2.3522,
      display_name: 'Paris, France',
    });
  });

  it('normalizes cache key — "Goa", " goa ", "GOA" all hit the same slot', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { lat: '15.3', lon: '74.1', display_name: 'Goa' },
      ],
    });

    await flush(geocode('Goa'));
    await flush(geocode(' goa '));
    await flush(geocode('GOA'));

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest entry when over the LRU cap', async () => {
    global.fetch.mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      json: async () => {
        const q = decodeURIComponent(url.match(/q=([^&]+)/)?.[1] || 'x');
        return [{ lat: '1', lon: '2', display_name: q }];
      },
    }));

    // Fill the cache to cap.
    for (let i = 0; i < __test__.LRU_CAP; i++) {
      await flush(geocode(`q-${i}`));
    }
    expect(__test__.cache.size).toBe(__test__.LRU_CAP);
    expect(__test__.cache.has('fwd:q-0')).toBe(true);

    // One more push — q-0 should be evicted as oldest.
    await flush(geocode('q-extra'));
    expect(__test__.cache.size).toBe(__test__.LRU_CAP);
    expect(__test__.cache.has('fwd:q-0')).toBe(false);
    expect(__test__.cache.has('fwd:q-extra')).toBe(true);
  });

  it('recency promotion: re-read keeps an old key alive past further evictions', async () => {
    global.fetch.mockImplementation(async (url) => ({
      ok: true,
      status: 200,
      json: async () => {
        const q = decodeURIComponent(url.match(/q=([^&]+)/)?.[1] || 'x');
        return [{ lat: '1', lon: '2', display_name: q }];
      },
    }));

    // Cache fill ending with q-0 ALREADY hit, then we re-read q-0 so
    // it becomes the most-recently-used.
    for (let i = 0; i < __test__.LRU_CAP; i++) {
      await flush(geocode(`q-${i}`));
    }
    await flush(geocode('q-0'));    // promote q-0
    await flush(geocode('q-new'));  // pushes q-1 out (oldest now)

    expect(__test__.cache.has('fwd:q-0')).toBe(true);
    expect(__test__.cache.has('fwd:q-1')).toBe(false);
  });

  it('clearCache empties the cache so cache-miss behaviour resumes', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ lat: '0', lon: '0', display_name: 'X' }],
    });

    await flush(geocode('X'));
    expect(__test__.cache.size).toBeGreaterThan(0);

    clearCache();
    expect(__test__.cache.size).toBe(0);

    await flush(geocode('X'));
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('geocode — rate limiting', () => {
  it('serializes parallel calls so outbound fetches are spaced by RATE_LIMIT_MS', async () => {
    // Track wall-clock time of each outbound fetch invocation. With fake
    // timers, "wall-clock" = vi.getMockTime() in ms.
    const callTimes = [];
    global.fetch.mockImplementation(async () => {
      callTimes.push(Date.now());
      return {
        ok: true,
        status: 200,
        json: async () => [{ lat: '0', lon: '0', display_name: 'X' }],
      };
    });

    // Fire 3 distinct queries in parallel.
    const p1 = geocode('alpha');
    const p2 = geocode('bravo');
    const p3 = geocode('charlie');

    await vi.runAllTimersAsync();
    await Promise.all([p1, p2, p3]);

    expect(callTimes.length).toBe(3);
    // Each subsequent call should be ≥ RATE_LIMIT_MS after the previous.
    expect(callTimes[1] - callTimes[0]).toBeGreaterThanOrEqual(
      __test__.RATE_LIMIT_MS,
    );
    expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(
      __test__.RATE_LIMIT_MS,
    );
  });
});

describe('reverseGeocode', () => {
  it('returns {lat, lng, display_name} on a Nominatim hit', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        display_name: '742 Evergreen Terrace, Springfield',
      }),
    });

    const p = reverseGeocode(40.7128, -74.006);
    const result = await flush(p);

    expect(result).toEqual({
      lat: 40.7128,
      lng: -74.006,
      display_name: '742 Evergreen Terrace, Springfield',
    });
    const url = global.fetch.mock.calls[0][0];
    expect(url).toMatch(/\/reverse\?format=json&lat=40\.7128&lon=-74\.006/);
  });

  it('returns null on a Nominatim response without display_name', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    const result = await flush(reverseGeocode(0, 0));
    expect(result).toBeNull();
  });

  it('returns null without firing fetch for non-finite lat/lng', async () => {
    expect(await reverseGeocode('not-a-number', 0)).toBeNull();
    expect(await reverseGeocode(0, NaN)).toBeNull();
    expect(await reverseGeocode(undefined, undefined)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('caches the result keyed by 6-dp rounded coords', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ display_name: 'X' }),
    });

    await flush(reverseGeocode(12.34567899, 98.76543211));
    // Identical coords → cache hit.
    await flush(reverseGeocode(12.34567899, 98.76543211));

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
