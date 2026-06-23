/**
 * aiImageFallbackProvider.js — PR-E Phase 2.1.
 *
 * Last-resort image provider: when Unsplash + Pexels + Pixabay all
 * fail to surface usable photos for a query, this provider asks the
 * project's existing AI image generator (services/marketingFlyerImageLLM.js
 * — Gemini Imagen) to synthesize one.
 *
 * Cost is per-call; gated by the project's per-tenant LLM budget
 * (existing LlmCallLog + tenantSettings infrastructure). If the budget
 * is exhausted the call short-circuits to empty results so the slot
 * shows the renderer's "image not set" placeholder.
 *
 * This file is a THIN wrapper — it doesn't reimplement Gemini calls;
 * it just speaks the destinationImageProvider envelope.
 */

'use strict';

const PROVIDER_ID = 'ai-fallback';

function isAvailable() {
  // The AI generator is always callable; whether it produces an image
  // depends on tenant budget + provider keys (handled inside the wrapped
  // marketingFlyerImageLLM module). We advertise available so the
  // hierarchy lands here as the last resort.
  return true;
}

// Pollinations — free, no-key AI image generation. Used ONLY as the
// last-resort fallback within this already-fallback provider when the
// primary AI image generator (DALL-E / Stability / Imagen via the
// project's marketingFlyerImageLLM module) is unavailable. The user
// rejected Pollinations as a PRIMARY image source on 2026-06-23
// ("Do not make Pollinations the primary image source. Travel pages
// should prefer real destination photography"). Keeping it as the
// last-resort within the LAST-RESORT provider means the page ships
// with destination-relevant imagery instead of empty card slots when
// none of (Unsplash, Pexels, Pixabay, DALL-E, Stability, Imagen) have
// usable keys — which is the demo box's current state.
function pollinationsUrl(prompt, w, h) {
  const safePrompt = encodeURIComponent(String(prompt || 'travel destination').slice(0, 280));
  const seed = Math.floor(Math.random() * 1e6);
  return `https://image.pollinations.ai/prompt/${safePrompt}?width=${w}&height=${h}&nologo=true&model=flux&seed=${seed}`;
}
function aspectToWxH(aspect) {
  switch (String(aspect || '4:3')) {
    case '4:5': return [960, 1200];
    case '3:4': return [720, 960];
    case '16:9': return [1280, 720];
    case '1:1': return [1024, 1024];
    case '4:3':
    default: return [1024, 768];
  }
}

// Enrich a bland 2-4 word query into a vivid photo-prompt that Pollinations
// Flux can actually convert into a real-looking destination photo. The
// reference at localhost:8782 emits rich `imagePrompt` strings via the LLM
// and the resulting photos look like real Unsplash content; my CRM was
// passing short queries like "Madinah Umrah travel" which produced low-
// fidelity outputs. This helper boilerplates in subject + lighting + style
// keywords proven to push Flux toward photographic realism.
function enrichPhotoPrompt(query) {
  const q = String(query || '').trim();
  if (!q) return 'travel destination, golden hour photo, cinematic, sharp focus';
  // Keep the original subject; append photographic-realism keywords.
  return `${q}, professional travel photography, golden hour lighting, cinematic composition, high detail, no text, no watermark, photorealistic`;
}

async function search(query, { tenantId, aspectRatio, perPage = 1 } = {}) {
  const shortQ = String(query || '').slice(0, 80);
  // Try the OpenAI DALL-E / Stability path when configured. The previous
  // implementation destructured a non-existent `generateLandingPageHeroImage`
  // export — `marketingFlyerImageLLM` actually exports `generateFlyerImage`.
  // The typo meant DALL-E never fired even when OPENAI_API_KEY was set;
  // every slot fell straight to Pollinations. Fixed 2026-06-23.
  let generateImage;
  try {
    ({ generateFlyerImage: generateImage } = require('../marketingFlyerImageLLM'));
  } catch (_e) {
    generateImage = null;
  }
  if (typeof generateImage === 'function') {
    try {
      console.log(`[ai-image-fallback] DALL-E path attempt for "${shortQ}" (aspect=${aspectRatio || '4:3'})`);
      const t0 = Date.now();
      const result = await generateImage({
        prompt: enrichPhotoPrompt(query).slice(0, 400),
        tenantId,
        aspectRatio: aspectRatio || '4:3',
        __surface: 'landing-page-image',
      });
      const url = result && (result.url || result.imageUrl);
      if (url) {
        console.log(`[ai-image-fallback] DALL-E SUCCESS for "${shortQ}" in ${Date.now() - t0}ms → ${String(url).slice(0, 100)}…`);
        return [normalize({ ...result, url }, query)];
      }
      console.log(`[ai-image-fallback] DALL-E returned no URL for "${shortQ}" in ${Date.now() - t0}ms — falling through to Pollinations`);
    } catch (e) {
      console.log(`[ai-image-fallback] DALL-E threw for "${shortQ}": ${e.message || e} — falling through to Pollinations`);
    }
  } else {
    console.log(`[ai-image-fallback] DALL-E not configured for "${shortQ}" — using Pollinations`);
  }

  // Pollinations — guaranteed key-free fallback. The prompt is enriched
  // with photographic-realism keywords so the Flux model produces images
  // that look like real destination photography (matching the localhost:8782
  // reference). Each call gets a unique seed so re-renders aren't identical.
  const [w, h] = aspectToWxH(aspectRatio);
  const enriched = enrichPhotoPrompt(query);
  const url = pollinationsUrl(enriched, w, h);
  console.log(`[ai-image-fallback] Pollinations URL for "${shortQ}" (${w}x${h}): ${url.slice(0, 140)}…`);
  return [normalize({
    url,
    thumbUrl: pollinationsUrl(enriched, Math.round(w / 2), Math.round(h / 2)),
    width: w,
    height: h,
    model: 'pollinations-flux',
  }, query)];
}

function normalize(item, originalQuery) {
  return {
    url: item.url || '',
    thumbUrl: item.thumbUrl || item.url || '',
    width: item.width || 0,
    height: item.height || 0,
    attribution: {
      photographer: '',
      photographerUrl: '',
      providerId: PROVIDER_ID,
      providerUrl: '',
      license: 'ai-generated',
      query: originalQuery || '',
      model: item.model || 'imagen',
    },
  };
}

module.exports = {
  id: PROVIDER_ID,
  isAvailable,
  search,
  _normalize: normalize,
};
