/**
 * aiImageFallbackProvider.js — PR-E Phase 2.1.
 *
 * Last-resort image provider: when Pexels + Unsplash + Pixabay all fail to
 * surface a usable photo, this provider cascades through AI image
 * generators and emits the first hit:
 *
 *   1. Gemini Imagen (`GEMINI_API_KEY`) — Google AI Studio `:predict`
 *      endpoint with `imagen-3.0-generate-002`. Free-tier keys may not be
 *      entitled to Imagen; the call falls through on any non-200.
 *   2. OpenAI DALL-E (`OPENAI_API_KEY`) — via the existing
 *      `services/marketingFlyerImageLLM.generateFlyerImage` wrapper.
 *   3. Pollinations (key-free) — guaranteed fallback so an empty card
 *      never ships. Lower fidelity than the AI providers above.
 *
 * Groq is intentionally NOT in this cascade — `GROQ_API_KEY` only gates
 * text models (Llama / Mixtral on Groq's LPU); Groq exposes no image
 * generation API as of 2026-06.
 *
 * Per-call cost on the Gemini + DALL-E paths is gated by the project's
 * per-tenant LLM budget (LlmCallLog + tenantSettings). When budget is
 * exhausted the AI providers return null and the cascade lands on
 * Pollinations.
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

// Try Gemini Imagen first when GEMINI_API_KEY is present. Uses the public
// generativelanguage.googleapis.com :predict endpoint with the imagen-3
// model. Returns a persisted /uploads/ URL on success, null on any failure
// (key not entitled to Imagen, quota, parse error, etc.) so the caller
// falls through to DALL-E + Pollinations. Groq is intentionally absent —
// it ships text models only; no image-generation surface as of 2026-06.
async function tryGeminiImagen(query, aspectRatio) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const shortQ = String(query || '').slice(0, 80);
  const aspect = ['1:1', '3:4', '4:3', '9:16', '16:9'].includes(aspectRatio) ? aspectRatio : '4:3';
  const prompt = enrichPhotoPrompt(query).slice(0, 480);
  const model = process.env.LLM_MODEL_GEMINI_IMAGE || 'imagen-3.0-generate-002';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${encodeURIComponent(apiKey)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let resp;
  let body;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio: aspect },
      }),
      signal: ctrl.signal,
    });
    body = await resp.json().catch(() => ({}));
  } catch (e) {
    clearTimeout(timer);
    console.log(`[ai-image-fallback] Gemini Imagen threw for "${shortQ}": ${e.message || e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const msg = (body && body.error && (body.error.message || body.error.status)) || resp.statusText;
    console.log(`[ai-image-fallback] Gemini Imagen ${resp.status} for "${shortQ}": ${msg}`);
    return null;
  }
  const b64 = body?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) {
    console.log(`[ai-image-fallback] Gemini Imagen returned no bytesBase64Encoded for "${shortQ}"`);
    return null;
  }
  try {
    const path = require('path');
    const fs = require('fs');
    const crypto = require('crypto');
    const uploadsDir = path.join(__dirname, '..', '..', 'uploads', 'ai-fallback');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const hash = crypto.createHash('sha1').update(`${prompt}${aspect}${Date.now()}`).digest('hex').slice(0, 16);
    const filename = `gemini-${hash}.png`;
    fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(b64, 'base64'));
    return `/uploads/ai-fallback/${filename}`;
  } catch (e) {
    console.log(`[ai-image-fallback] Gemini Imagen persist failed for "${shortQ}": ${e.message || e}`);
    return null;
  }
}

async function search(query, { tenantId, aspectRatio, perPage = 1 } = {}) {
  const shortQ = String(query || '').slice(0, 80);

  // 1. Gemini Imagen (free-tier may not be entitled — falls through silently).
  const geminiUrl = await tryGeminiImagen(query, aspectRatio);
  if (geminiUrl) {
    console.log(`[ai-image-fallback] Gemini Imagen SUCCESS for "${shortQ}" → ${geminiUrl}`);
    return [normalize({ url: geminiUrl, model: 'gemini-imagen' }, query)];
  }

  // 2. OpenAI DALL-E via the existing marketingFlyerImageLLM wrapper.
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
