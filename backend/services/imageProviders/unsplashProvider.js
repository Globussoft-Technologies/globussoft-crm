/**
 * unsplashProvider.js — PR-E Phase 2.1.
 *
 * Adapter for the Unsplash search API. Returns a normalized
 * SearchResult envelope so the destinationImageProvider hierarchy can
 * treat all providers uniformly.
 *
 * Auth: UNSPLASH_ACCESS_KEY env var. Free tier = 50 req/hour.
 *
 * Output normalization
 * ────────────────────
 *   {
 *     url:           string  // image URL (raw / regular size)
 *     thumbUrl:      string  // smaller URL for previews
 *     width, height: number
 *     attribution: {
 *       photographer:    string
 *       photographerUrl: string
 *       providerId:      'unsplash'
 *       providerUrl:     string  // image's permalink
 *       license:         'unsplash-license'
 *     }
 *   }
 *
 * Failure modes
 * ─────────────
 *   - No key → isAvailable() returns false; search() returns []
 *   - API error / rate-limit → search() returns []
 *   - Zero results → search() returns []
 *
 * The provider NEVER throws; callers iterate the fallback hierarchy
 * looking for the first non-empty result.
 */

'use strict';

const PROVIDER_ID = 'unsplash';
const API_BASE = 'https://api.unsplash.com';

function isAvailable() {
  return !!process.env.UNSPLASH_ACCESS_KEY;
}

async function search(query, { aspectRatio, perPage = 5 } = {}) {
  if (!isAvailable()) return [];
  const key = process.env.UNSPLASH_ACCESS_KEY;
  const orientation = pickOrientation(aspectRatio);
  const params = new URLSearchParams({
    query: String(query || '').slice(0, 200),
    per_page: String(perPage),
    orientation: orientation || 'landscape',
    content_filter: 'high', // family-safe by default
  });
  let response;
  try {
    response = await fetch(`${API_BASE}/search/photos?${params}`, {
      headers: {
        'Authorization': `Client-ID ${key}`,
        'Accept-Version': 'v1',
      },
      // 5-sec timeout — fall through to next provider on slow Unsplash
      signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
    });
  } catch (_e) {
    return [];
  }
  if (!response || !response.ok) return [];
  let data;
  try {
    data = await response.json();
  } catch (_e) {
    return [];
  }
  if (!data || !Array.isArray(data.results)) return [];
  return data.results.map(normalize).filter(Boolean);
}

function pickOrientation(aspectRatio) {
  if (!aspectRatio) return 'landscape';
  // Unsplash accepts: landscape, portrait, squarish
  if (aspectRatio === '16:9' || aspectRatio === '4:3' || aspectRatio === '3:2') return 'landscape';
  if (aspectRatio === '3:4' || aspectRatio === '4:5' || aspectRatio === '9:16') return 'portrait';
  if (aspectRatio === '1:1') return 'squarish';
  return 'landscape';
}

function normalize(item) {
  if (!item || !item.urls) return null;
  return {
    url: item.urls.regular || item.urls.full || item.urls.raw || '',
    thumbUrl: item.urls.thumb || item.urls.small || '',
    width: item.width,
    height: item.height,
    attribution: {
      photographer: (item.user && item.user.name) || '',
      photographerUrl: (item.user && item.user.links && item.user.links.html) || '',
      providerId: PROVIDER_ID,
      providerUrl: (item.links && item.links.html) || '',
      license: 'unsplash-license',
    },
  };
}

module.exports = {
  id: PROVIDER_ID,
  isAvailable,
  search,
  // Test exposures
  _normalize: normalize,
  _pickOrientation: pickOrientation,
};
