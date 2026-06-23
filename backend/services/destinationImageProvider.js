/**
 * destinationImageProvider.js — PR-E Phase 2.1.
 *
 * Image provider abstraction + fallback hierarchy for the Travel
 * Experience Engine. Takes a search query (per-slot, emitted by
 * travelExperienceEngine.chooseImageStrategy) and returns the best
 * available image with attribution metadata.
 *
 * Hierarchy
 * ─────────
 *   Unsplash  (premium, photographer-curated)        — requires UNSPLASH_ACCESS_KEY
 *     ↓ on miss / unavailable
 *   Pexels    (good, photographer-curated)           — requires PEXELS_API_KEY
 *     ↓ on miss / unavailable
 *   Pixabay   (acceptable, stock-mix)                — anonymous tier; PIXABAY_API_KEY optional
 *     ↓ on miss / unavailable
 *   AI fallback (Gemini Imagen)                      — gated by per-tenant LLM budget
 *
 * The first provider with a non-empty result wins. All providers expose
 * the same envelope so calling code never branches on providerId.
 *
 * Q3 lockdown — tenant attribution config
 * ────────────────────────────────────────
 * Every returned image carries `attribution` metadata regardless of
 * tenant settings (always-store). VISIBLE attribution rendering is
 * controlled per-tenant via TenantSetting.imageAttributionVisible
 * (default ON; tenant can opt out via settings UI). The renderer
 * consults the setting at request time; this module only persists
 * the metadata.
 *
 * Q10 lockdown — in-memory cache only (no Redis in Phase 2)
 * ──────────────────────────────────────────────────────────
 * Search results cached by (providerId, normalized-query) → 7-day TTL.
 * Cache bounded by LRU at 5K entries.
 *
 * Public surface
 * ──────────────
 *   fetchOne(query, opts)        — try providers in order; return first hit (or null)
 *   fetchStrategy(strategy, opts) — fetch ALL slots in a TeeOutput.imageStrategy
 *                                    → { hero, marquee[], brochure }
 *   PROVIDERS                    — array of provider modules in fallback order
 *   _cache                       — exposed for tests
 *   _resetForTests()             — clears cache + provider state (test helper)
 */

'use strict';

const unsplashProvider = require('./imageProviders/unsplashProvider');
const pexelsProvider = require('./imageProviders/pexelsProvider');
const pixabayProvider = require('./imageProviders/pixabayProvider');
const aiImageFallbackProvider = require('./imageProviders/aiImageFallbackProvider');

// Fallback hierarchy — in priority order. Each provider implements:
//   { id, isAvailable(), search(query, opts) → SearchResult[] }
const PROVIDERS = Object.freeze([
  unsplashProvider,
  pexelsProvider,
  pixabayProvider,
  aiImageFallbackProvider,
]);

// ── In-memory cache (Q10) ──────────────────────────────────────────
const IMAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const IMAGE_CACHE_MAX_ENTRIES = 5000;

function createCache() {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expiresAt < Date.now()) { store.delete(key); return null; }
      store.delete(key); store.set(key, hit);
      return hit.value;
    },
    set(key, value, ttlMs = IMAGE_CACHE_TTL_MS) {
      while (store.size >= IMAGE_CACHE_MAX_ENTRIES) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    delete(key) { store.delete(key); },
    clear() { store.clear(); },
    size() { return store.size; },
    _store: store,
  };
}

const IMAGE_CACHE = createCache();

function cacheKey(providerId, query, opts = {}) {
  const normQuery = String(query || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const ar = opts.aspectRatio || '';
  return `img:${providerId}:${ar}:${normQuery}`;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Fetch ONE image for a query, iterating the provider hierarchy.
 *
 * Returns the SearchResult envelope from the first provider with a
 * non-empty response, or null if all providers fail.
 *
 * opts:
 *   aspectRatio: '4:3' | '3:4' | '16:9' | …    — passed to each provider
 *   tenantId:    string                         — passed to AI fallback for budget gating
 *   excludeProviders: string[]                  — skip these providerIds (test / debugging)
 *   perPage:     int                            — how many results to request per provider
 */
async function fetchOne(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) {
    console.log(`[image-provider] fetchOne: empty query — skipping`);
    return null;
  }
  const shortQ = q.slice(0, 80);
  const excludeProviders = new Set(opts.excludeProviders || []);
  for (const provider of PROVIDERS) {
    if (excludeProviders.has(provider.id)) {
      console.log(`[image-provider] "${shortQ}" — skipping ${provider.id} (excluded)`);
      continue;
    }
    if (typeof provider.isAvailable === 'function' && !provider.isAvailable()) {
      console.log(`[image-provider] "${shortQ}" — skipping ${provider.id} (no env key / not available)`);
      continue;
    }

    const ck = cacheKey(provider.id, q, opts);
    const cached = IMAGE_CACHE.get(ck);
    if (cached) {
      console.log(`[image-provider] "${shortQ}" — ${provider.id} CACHE HIT`);
      return cached;
    }

    let results = [];
    const t0 = Date.now();
    try {
      results = await provider.search(q, opts);
    } catch (e) {
      console.log(`[image-provider] "${shortQ}" — ${provider.id} THREW in ${Date.now() - t0}ms: ${e.message || e}`);
      results = [];
    }
    if (results && results.length > 0) {
      const pick = results[0];
      console.log(`[image-provider] "${shortQ}" — ${provider.id} HIT in ${Date.now() - t0}ms (url=${String(pick.url || '').slice(0, 100)}…)`);
      IMAGE_CACHE.set(ck, pick);
      return pick;
    }
    console.log(`[image-provider] "${shortQ}" — ${provider.id} returned no results in ${Date.now() - t0}ms`);
    // No results — try next provider.
  }
  console.warn(`[image-provider] "${shortQ}" — EVERY provider returned null`);
  return null;
}

/**
 * Fetch all slots in a TeeOutput.imageStrategy.
 *
 * Returns:
 *   {
 *     hero:     SearchResult | null,
 *     marquee:  Array<{ slot, image: SearchResult | null }>,
 *     brochure: SearchResult | null,
 *     cultural: Array<{ slot, image: SearchResult | null }>,
 *   }
 *
 * Empty slots are valid; renderer handles them (shows placeholder text
 * or omits the section). Caller should NOT throw on null images.
 */
async function fetchStrategy(strategy, opts = {}) {
  const s = strategy || {};
  const heroOpts = { ...opts, aspectRatio: s.hero && s.hero.aspectRatio };
  const broOpts = { ...opts, aspectRatio: s.brochure && s.brochure.aspectRatio };

  const heroP = s.hero && s.hero.query ? fetchOne(s.hero.query, heroOpts) : Promise.resolve(null);
  const broP = s.brochure && s.brochure.query ? fetchOne(s.brochure.query, broOpts) : Promise.resolve(null);

  const marqueeArr = Array.isArray(s.marquee) ? s.marquee : [];
  const marqueePs = marqueeArr.map((m) => (
    m && m.query
      ? fetchOne(m.query, { ...opts, aspectRatio: '3:4' }).then((image) => ({ slot: m.slot, image }))
      : Promise.resolve({ slot: m && m.slot, image: null })
  ));

  const culturalArr = Array.isArray(s.cultural) ? s.cultural : [];
  const culturalPs = culturalArr.map((c) => (
    c && c.query
      ? fetchOne(c.query, { ...opts, aspectRatio: '4:3' }).then((image) => ({ slot: c.slot, image }))
      : Promise.resolve({ slot: c && c.slot, image: null })
  ));

  const [hero, brochure, marquee, cultural] = await Promise.all([
    heroP, broP, Promise.all(marqueePs), Promise.all(culturalPs),
  ]);

  return { hero, brochure, marquee, cultural };
}

/**
 * Apply fetched images to a content payload — used by the bridge to
 * merge image strategy results into LandingPage.content.
 *
 * Mutates a copy of `content` and returns it. Operator-uploaded image
 * URLs (anything starting with `/uploads/`) are PRESERVED — the bridge
 * never overwrites operator choices.
 */
function applyImagesToContent(content, fetched) {
  if (!content || typeof content !== 'object') return content;
  const out = JSON.parse(JSON.stringify(content));

  // Hero poster.
  if (!isOperatorOwned(out.hero && out.hero.posterUrl) && fetched.hero && fetched.hero.url) {
    out.hero = out.hero || {};
    out.hero.posterUrl = fetched.hero.url;
    if (!out.hero.posterAlt && fetched.hero.attribution) {
      out.hero.posterAlt = `Photo by ${fetched.hero.attribution.photographer || fetched.hero.attribution.providerId}`;
    }
  }

  // Marquee cities — fetched[i].image corresponds to marquee.cities[i].
  if (out.marquee && Array.isArray(out.marquee.cities) && Array.isArray(fetched.marquee)) {
    out.marquee.cities = out.marquee.cities.map((city, i) => {
      const fetchedM = fetched.marquee[i];
      if (fetchedM && fetchedM.image && fetchedM.image.url && !isOperatorOwned(city.img)) {
        return { ...city, img: fetchedM.image.url };
      }
      return city;
    });
  }

  // Brochure cover (future slot; only applies when content.brochure.coverUrl exists).
  if (out.brochure && fetched.brochure && fetched.brochure.url && !isOperatorOwned(out.brochure.coverUrl)) {
    out.brochure.coverUrl = fetched.brochure.url;
  }

  // _tee.images attribution block — always store regardless of tenant
  // visible-attribution config (Q3: always store, visibility is per-tenant).
  out._tee = out._tee || {};
  out._tee.images = {
    hero: fetched.hero ? fetched.hero.attribution : null,
    brochure: fetched.brochure ? fetched.brochure.attribution : null,
    marquee: (fetched.marquee || []).map((m) => m && m.image ? m.image.attribution : null),
    cultural: (fetched.cultural || []).map((c) => c && c.image ? c.image.attribution : null),
    fetchedAt: new Date().toISOString(),
  };
  return out;
}

// An image URL is "operator-owned" (do not overwrite) when it's a local
// upload path. Any TEE-fetched URL starts with https://; operator
// uploads start with /uploads/.
function isOperatorOwned(url) {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('/uploads/');
}

function _resetForTests() {
  IMAGE_CACHE.clear();
}

module.exports = {
  PROVIDERS,
  fetchOne,
  fetchStrategy,
  applyImagesToContent,
  isOperatorOwned,
  _cache: IMAGE_CACHE,
  _cacheKey: cacheKey,
  _resetForTests,
};
