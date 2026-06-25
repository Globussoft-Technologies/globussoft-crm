import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * frontend/src/lib/geocoder.js — CRM backend proxy geocoder
 *
 * The geocoder no longer calls Nominatim directly from the browser (browsers
 * strip the User-Agent header, which Nominatim requires). Instead it proxies
 * through GET /api/travel/pois/geocode.
 *
 * What's tested
 *   - Forward geocode happy path: parses { results: [{lat, lng, display_name}] }
 *     into {lat, lng, display_name}.
 *   - Empty result → returns null (no throw).
 *   - Network / proxy error → returns null (no throw, warning logged).
 *   - Cache hit: a second call for the same query never fires fetchApi.
 *   - Cache key is normalized (case-insensitive + trimmed).
 *   - LRU eviction + recency promotion.
 *   - clearCache empties the LRU.
 *   - Reverse geocode happy path + null on no display_name.
 *   - Reverse geocode rejects non-finite lat/lng without calling fetchApi.
 */

import {
  geocode,
  reverseGeocode,
  clearCache,
  __test__,
} from '../lib/geocoder';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

beforeEach(() => {
  clearCache();
  fetchApiMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearCache();
});

describe('geocode — forward lookup', () => {
  it('returns {lat, lng, display_name} on a proxy hit', async () => {
    fetchApiMock.mockResolvedValueOnce({
      results: [{ lat: 15.2993, lng: 74.124, display_name: 'Goa, India' }],
    });

    const result = await geocode('Goa');

    expect(result).toEqual({
      lat: 15.2993,
      lng: 74.124,
      display_name: 'Goa, India',
    });
    expect(fetchApiMock).toHaveBeenCalledTimes(1);
    const url = fetchApiMock.mock.calls[0][0];
    expect(url).toMatch(/\/api\/travel\/pois\/geocode\?q=goa$/);
  });

  it('returns null when the proxy returns an empty result array', async () => {
    fetchApiMock.mockResolvedValueOnce({ results: [] });
    expect(await geocode('zzzzzzzzzzz-no-such-place')).toBeNull();
  });

  it('returns null when the proxy returns no results field', async () => {
    fetchApiMock.mockResolvedValueOnce({});
    expect(await geocode('Nowhere')).toBeNull();
  });

  it('returns null and does NOT throw when fetchApi rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchApiMock.mockRejectedValueOnce(new Error('proxy error'));
    expect(await geocode('Paris')).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns null for an empty / whitespace-only query without calling fetchApi', async () => {
    expect(await geocode('')).toBeNull();
    expect(await geocode('   ')).toBeNull();
    expect(await geocode(null)).toBeNull();
    expect(fetchApiMock).not.toHaveBeenCalled();
  });
});

describe('geocode — LRU cache', () => {
  it('a second call with the same query hits the cache (no second fetchApi)', async () => {
    fetchApiMock.mockResolvedValue({
      results: [{ lat: 48.8566, lng: 2.3522, display_name: 'Paris, France' }],
    });

    await geocode('Paris');
    const r2 = await geocode('Paris');

    expect(fetchApiMock).toHaveBeenCalledTimes(1);
    expect(r2).toEqual({
      lat: 48.8566,
      lng: 2.3522,
      display_name: 'Paris, France',
    });
  });

  it('normalizes cache key — "Goa", " goa ", "GOA" all hit the same slot', async () => {
    fetchApiMock.mockResolvedValue({
      results: [{ lat: 15.3, lng: 74.1, display_name: 'Goa' }],
    });

    await geocode('Goa');
    await geocode(' goa ');
    await geocode('GOA');

    expect(fetchApiMock).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest entry when over the LRU cap', async () => {
    fetchApiMock.mockImplementation(async (url) => {
      const q = decodeURIComponent(url.match(/q=([^&]+)/)?.[1] || 'x');
      return { results: [{ lat: '1', lng: '2', display_name: q }] };
    });

    for (let i = 0; i < __test__.LRU_CAP; i++) {
      await geocode(`q-${i}`);
    }
    expect(__test__.cache.size).toBe(__test__.LRU_CAP);
    expect(__test__.cache.has('fwd:q-0')).toBe(true);

    await geocode('q-extra');
    expect(__test__.cache.size).toBe(__test__.LRU_CAP);
    expect(__test__.cache.has('fwd:q-0')).toBe(false);
    expect(__test__.cache.has('fwd:q-extra')).toBe(true);
  });

  it('recency promotion: re-read keeps an old key alive past further evictions', async () => {
    fetchApiMock.mockImplementation(async (url) => {
      const q = decodeURIComponent(url.match(/q=([^&]+)/)?.[1] || 'x');
      return { results: [{ lat: '1', lng: '2', display_name: q }] };
    });

    for (let i = 0; i < __test__.LRU_CAP; i++) {
      await geocode(`q-${i}`);
    }
    await geocode('q-0'); // promote q-0
    await geocode('q-new'); // pushes q-1 out (oldest now)

    expect(__test__.cache.has('fwd:q-0')).toBe(true);
    expect(__test__.cache.has('fwd:q-1')).toBe(false);
  });

  it('clearCache empties the cache so cache-miss behaviour resumes', async () => {
    fetchApiMock.mockResolvedValue({
      results: [{ lat: '0', lng: '0', display_name: 'X' }],
    });

    await geocode('X');
    expect(__test__.cache.size).toBeGreaterThan(0);

    clearCache();
    expect(__test__.cache.size).toBe(0);

    await geocode('X');
    expect(fetchApiMock).toHaveBeenCalledTimes(2);
  });
});

describe('reverseGeocode', () => {
  it('returns {lat, lng, display_name} on a proxy hit', async () => {
    fetchApiMock.mockResolvedValueOnce({
      display_name: '742 Evergreen Terrace, Springfield',
    });

    const result = await reverseGeocode(40.7128, -74.006);

    expect(result).toEqual({
      lat: 40.7128,
      lng: -74.006,
      display_name: '742 Evergreen Terrace, Springfield',
    });
    const url = fetchApiMock.mock.calls[0][0];
    expect(url).toMatch(/\/api\/travel\/pois\/geocode\?reverse=1&lat=40\.7128&lng=-74\.006/);
  });

  it('returns null on a proxy response without display_name', async () => {
    fetchApiMock.mockResolvedValueOnce({});
    expect(await reverseGeocode(0, 0)).toBeNull();
  });

  it('returns null without firing fetchApi for non-finite lat/lng', async () => {
    expect(await reverseGeocode('not-a-number', 0)).toBeNull();
    expect(await reverseGeocode(0, NaN)).toBeNull();
    expect(await reverseGeocode(undefined, undefined)).toBeNull();
    expect(fetchApiMock).not.toHaveBeenCalled();
  });

  it('caches the result keyed by 6-dp rounded coords', async () => {
    fetchApiMock.mockResolvedValue({
      display_name: 'X',
    });

    await reverseGeocode(12.34567899, 98.76543211);
    await reverseGeocode(12.34567899, 98.76543211);

    expect(fetchApiMock).toHaveBeenCalledTimes(1);
  });
});
