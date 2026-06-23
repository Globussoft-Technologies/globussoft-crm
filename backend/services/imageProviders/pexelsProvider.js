/**
 * pexelsProvider.js — PR-E Phase 2.1.
 *
 * Adapter for Pexels search API. Same normalized envelope as
 * unsplashProvider so the hierarchy is interchangeable.
 *
 * Auth: PEXELS_API_KEY env var. Free tier = 200 req/hour.
 */

'use strict';

const PROVIDER_ID = 'pexels';
const API_BASE = 'https://api.pexels.com/v1';

function isAvailable() {
  return !!process.env.PEXELS_API_KEY;
}

async function search(query, { aspectRatio, perPage = 5 } = {}) {
  if (!isAvailable()) return [];
  const key = process.env.PEXELS_API_KEY;
  const orientation = pickOrientation(aspectRatio);
  const params = new URLSearchParams({
    query: String(query || '').slice(0, 200),
    per_page: String(perPage),
    orientation: orientation || 'landscape',
  });
  let response;
  try {
    response = await fetch(`${API_BASE}/search?${params}`, {
      headers: { 'Authorization': key },
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
  if (!data || !Array.isArray(data.photos)) return [];
  return data.photos.map(normalize).filter(Boolean);
}

function pickOrientation(aspectRatio) {
  if (!aspectRatio) return 'landscape';
  if (['16:9', '4:3', '3:2'].includes(aspectRatio)) return 'landscape';
  if (['3:4', '4:5', '9:16'].includes(aspectRatio)) return 'portrait';
  if (aspectRatio === '1:1') return 'square';
  return 'landscape';
}

function normalize(item) {
  if (!item || !item.src) return null;
  return {
    url: item.src.large2x || item.src.large || item.src.original || '',
    thumbUrl: item.src.medium || item.src.small || '',
    width: item.width,
    height: item.height,
    attribution: {
      photographer: item.photographer || '',
      photographerUrl: item.photographer_url || '',
      providerId: PROVIDER_ID,
      providerUrl: item.url || '',
      license: 'pexels-license',
    },
  };
}

module.exports = {
  id: PROVIDER_ID,
  isAvailable,
  search,
  _normalize: normalize,
  _pickOrientation: pickOrientation,
};
