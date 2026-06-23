/**
 * pixabayProvider.js — PR-E Phase 2.1.
 *
 * Adapter for Pixabay search API. Always available (free tier, no auth)
 * — guarantees image fallback even when Unsplash + Pexels keys missing.
 *
 * Auth: PIXABAY_API_KEY env var (preferred). Falls back to anonymous
 * access if no key — Pixabay rate-limits anonymous calls but the
 * abstraction handles failure gracefully.
 */

'use strict';

const PROVIDER_ID = 'pixabay';
const API_BASE = 'https://pixabay.com/api';

function isAvailable() {
  // Pixabay anonymous access works but is rate-limited; key preferred.
  // We always advertise available so the fallback hierarchy lands here.
  return true;
}

async function search(query, { aspectRatio, perPage = 5 } = {}) {
  const key = process.env.PIXABAY_API_KEY || '';
  const orientation = pickOrientation(aspectRatio);
  const params = new URLSearchParams({
    q: String(query || '').slice(0, 200),
    per_page: String(perPage),
    safesearch: 'true',
    image_type: 'photo',
    orientation: orientation || 'all',
  });
  if (key) params.set('key', key);
  let response;
  try {
    response = await fetch(`${API_BASE}/?${params}`, {
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
  if (!data || !Array.isArray(data.hits)) return [];
  return data.hits.map(normalize).filter(Boolean);
}

function pickOrientation(aspectRatio) {
  if (!aspectRatio) return 'all';
  if (['16:9', '4:3', '3:2'].includes(aspectRatio)) return 'horizontal';
  if (['3:4', '4:5', '9:16'].includes(aspectRatio)) return 'vertical';
  return 'all';
}

function normalize(item) {
  if (!item || !item.largeImageURL) return null;
  return {
    url: item.largeImageURL || item.webformatURL || '',
    thumbUrl: item.previewURL || '',
    width: item.imageWidth || item.webformatWidth,
    height: item.imageHeight || item.webformatHeight,
    attribution: {
      photographer: item.user || '',
      photographerUrl: item.user_id ? `https://pixabay.com/users/${item.user}-${item.user_id}/` : 'https://pixabay.com',
      providerId: PROVIDER_ID,
      providerUrl: item.pageURL || '',
      license: 'pixabay-license',
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
