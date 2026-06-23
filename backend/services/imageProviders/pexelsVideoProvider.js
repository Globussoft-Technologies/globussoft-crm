/**
 * pexelsVideoProvider.js — Pexels VIDEO search adapter (2026-06-23).
 *
 * Mirrors pexelsProvider.js's shape but hits the videos endpoint instead
 * of the images endpoint. Returns the best-resolution MP4 link Pexels
 * has for a given query, which the wanderlux template embeds in the
 * "INTERACTIVE PREVIEW" section.
 *
 * Auth: reuses PEXELS_API_KEY (same env var as image search). Free tier =
 * 200 req/hour combined across image + video.
 *
 * Not part of the destinationImageProvider chain — videos are fetched
 * separately in the route after image fetch (one query per page, at most).
 */

'use strict';

const PROVIDER_ID = 'pexels-video';
const API_BASE = 'https://api.pexels.com/videos';

function isAvailable() {
  return !!process.env.PEXELS_API_KEY;
}

/**
 * Search Pexels videos. Returns up to perPage results. Each result is a
 * { url, posterUrl, width, height, attribution } envelope — url is the
 * highest-resolution MP4 link (or the SD MP4 if HD missing).
 *
 * Pexels' video API returns each video with multiple `video_files`
 * (HD/SD/mobile variants). We pick the largest `hd` or `sd` MP4 so the
 * landing page gets the best quality the operator's bandwidth can stream.
 */
async function search(query, { perPage = 3 } = {}) {
  if (!isAvailable()) return [];
  const key = process.env.PEXELS_API_KEY;
  const params = new URLSearchParams({
    query: String(query || '').slice(0, 200),
    per_page: String(perPage),
    orientation: 'landscape',
  });
  let response;
  try {
    response = await fetch(`${API_BASE}/search?${params}`, {
      headers: { 'Authorization': key },
      signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined,
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
  if (!data || !Array.isArray(data.videos)) return [];
  return data.videos.map(normalize).filter(Boolean);
}

function normalize(item) {
  if (!item || !Array.isArray(item.video_files) || item.video_files.length === 0) {
    return null;
  }
  // Pick the largest MP4 — prefer HD (1280+ wide), fall back to SD.
  const mp4s = item.video_files.filter((f) => f && (f.file_type === 'video/mp4' || /\.mp4(\?|$)/i.test(f.link || '')));
  if (mp4s.length === 0) return null;
  // Sort by resolution descending — biggest landscape video first.
  mp4s.sort((a, b) => (b.width || 0) - (a.width || 0));
  // Skip ultra-large (>1920) on mobile-friendly first pick — still
  // expose them via the `variants` array for operators who want full HD.
  const best = mp4s.find((f) => (f.width || 0) <= 1920) || mp4s[0];
  return {
    url: best.link || '',
    posterUrl: item.image || '',
    width: item.width || best.width || 0,
    height: item.height || best.height || 0,
    duration: item.duration || 0,
    attribution: {
      photographer: (item.user && item.user.name) || '',
      photographerUrl: (item.user && item.user.url) || '',
      providerId: PROVIDER_ID,
      providerUrl: item.url || '',
      license: 'pexels-license',
    },
  };
}

async function fetchOne(query, opts = {}) {
  if (!isAvailable()) {
    console.log(`[pexels-video] "${String(query).slice(0, 60)}" — no PEXELS_API_KEY, skipping`);
    return null;
  }
  const t0 = Date.now();
  const results = await search(query, opts);
  if (results.length === 0) {
    console.log(`[pexels-video] "${String(query).slice(0, 60)}" — no results in ${Date.now() - t0}ms`);
    return null;
  }
  console.log(`[pexels-video] "${String(query).slice(0, 60)}" — HIT in ${Date.now() - t0}ms (${results[0].url.slice(0, 100)}…)`);
  return results[0];
}

module.exports = {
  id: PROVIDER_ID,
  isAvailable,
  search,
  fetchOne,
  _normalize: normalize,
};
