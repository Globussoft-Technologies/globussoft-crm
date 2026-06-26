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
//
// Pexels is the primary source: it's the only stock provider with a
// configured PEXELS_API_KEY on this demo + only one whose terms cover the
// travel-microsite use case end-to-end. Unsplash + Pixabay stay in the
// chain as defensive fallbacks if those keys are ever added; they
// self-skip via isAvailable() when their env vars are unset. The AI
// fallback (Gemini Imagen → DALL-E → Pollinations) lands LAST so a query
// always resolves to *some* image rather than an empty card.
const PROVIDERS = Object.freeze([
  pexelsProvider,
  unsplashProvider,
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
 *   excludeUrls: Set<string>                    — URLs already used on this page (dedup);
 *                                                 the picker skips any result whose URL is in
 *                                                 this set. When every result from a provider
 *                                                 is already used, the cascade falls through
 *                                                 to the next provider rather than emitting a
 *                                                 duplicate. AI fallback ALWAYS generates a
 *                                                 fresh image (unique seed/prompt) so the
 *                                                 cascade is guaranteed to land non-empty.
 */
async function fetchOne(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  const shortQ = q.slice(0, 80);
  const excludeProviders = new Set(opts.excludeProviders || []);
  const excludeUrls = opts.excludeUrls instanceof Set ? opts.excludeUrls : new Set();
  const perPage = Number.isFinite(opts.perPage) ? opts.perPage : 5;
  for (const provider of PROVIDERS) {
    if (excludeProviders.has(provider.id)) continue;
    if (typeof provider.isAvailable === 'function' && !provider.isAvailable()) continue;

    const ck = cacheKey(provider.id, q, opts);
    const cached = IMAGE_CACHE.get(ck);
    if (cached && cached.url && !excludeUrls.has(cached.url)) {
      return cached;
    }
    // Cache hit but URL is already used on this page — bypass cache and
    // re-search so we can pick a different candidate from this provider.

    let results = [];
    const t0 = Date.now();
    try {
      results = await provider.search(q, { ...opts, perPage });
    } catch (e) {
      console.warn(`[image-provider] "${shortQ}" — ${provider.id} THREW in ${Date.now() - t0}ms: ${e.message || e}`);
      results = [];
    }
    // Pick the FIRST result whose URL isn't already used. Defeats the
    // "Pexels returns the same top image for two similar queries" duplicate.
    const pick = (results || []).find((r) => r && r.url && !excludeUrls.has(r.url));
    if (pick) {
      IMAGE_CACHE.set(ck, pick);
      return pick;
    }
    // No usable results — try next provider.
  }
  console.warn(`[image-provider] "${shortQ}" — EVERY provider returned null`);
  return null;
}

/**
 * Fetch UP TO `limit` DISTINCT images for a query — the gallery counterpart
 * to fetchOne(). Powers the public destination-photo proxy
 * (routes/travel_destination_photos.js) that feeds the customer-facing
 * quote / itinerary / microsite hero + side-rail images.
 *
 * Walks the SAME provider cascade as fetchOne (Pexels → Unsplash → Pixabay),
 * collecting distinct URLs across providers until it has `limit` of them, and
 * shares the SAME 7-day IMAGE_CACHE. By default the AI-generation fallback is
 * EXCLUDED (stockOnly): a customer-facing photo rail should never burn the
 * tenant's image-LLM budget or show a synthetic image — it degrades to the
 * frontend's keyless Wikipedia fallback instead when stock providers miss.
 *
 * opts:
 *   limit:      int (default 12, clamped 1..30) — max distinct images to return
 *   aspectRatio: string (default '16:9')        — passed to each provider
 *   stockOnly:  bool (default true)             — exclude the AI fallback
 *
 * Returns SearchResult[] (possibly empty). Never throws.
 */
const GALLERY_DEFAULT_LIMIT = 12;
const GALLERY_MAX_LIMIT = 30;

async function fetchMany(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  let limit = parseInt(opts.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = GALLERY_DEFAULT_LIMIT;
  if (limit > GALLERY_MAX_LIMIT) limit = GALLERY_MAX_LIMIT;
  const stockOnly = opts.stockOnly !== false;
  const aspectRatio = opts.aspectRatio || '16:9';

  const normQuery = q.toLowerCase().replace(/\s+/g, ' ').trim();
  const ck = `imgmany:${stockOnly ? 'stock' : 'all'}:${aspectRatio}:${limit}:${normQuery}`;
  const cached = IMAGE_CACHE.get(ck);
  if (cached) return cached;

  const providers = stockOnly
    ? PROVIDERS.filter((p) => p.id !== 'ai-fallback')
    : PROVIDERS;

  const seen = new Set();
  const out = [];
  for (const provider of providers) {
    if (out.length >= limit) break;
    if (typeof provider.isAvailable === 'function' && !provider.isAvailable()) continue;
    let results = [];
    try {
      results = await provider.search(q, { ...opts, aspectRatio, perPage: limit });
    } catch (e) {
      console.warn(`[image-provider] gallery "${q.slice(0, 80)}" — ${provider.id} THREW: ${e.message || e}`);
      results = [];
    }
    for (const r of results || []) {
      if (!r || !r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  // Only cache a non-empty result so a transient miss doesn't pin "no photos"
  // for 7 days (a later request can retry).
  if (out.length) IMAGE_CACHE.set(ck, out);
  return out;
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
  const heroOpts = { ...opts, aspectRatio: (s.hero && s.hero.aspectRatio) || '4:3' };
  const broOpts = { ...opts, aspectRatio: (s.brochure && s.brochure.aspectRatio) || '4:5' };

  // ── Pass 1: parallel fetch (fast happy path) ──────────────────────
  // Each slot independently cascades through the provider chain. A
  // mid-batch quota / rate-limit on the primary provider does NOT halt
  // the workflow — the slot's per-call cascade falls through to the
  // next provider (Pexels → Unsplash → Pixabay → AI fallback), so every
  // slot lands with SOME image. Same-page duplicates are handled in
  // pass 2 below.
  const heroP = s.hero && s.hero.query ? fetchOne(s.hero.query, heroOpts) : Promise.resolve(null);
  const broP = s.brochure && s.brochure.query ? fetchOne(s.brochure.query, broOpts) : Promise.resolve(null);

  const marqueeArr = Array.isArray(s.marquee) ? s.marquee : [];
  // Marquee photos request LANDSCAPE orientation even though the cards
  // render tall (3:4). Reason: Pexels' portrait filter biases results
  // toward people-portrait photography — when the cityName overlaps a
  // common person name (Nandan / William / Rabindra / etc.) the top
  // results are celebrity headshots, not landmarks. Landscape orientation
  // returns a wider pool of architecture / street / scenic photos; the
  // CSS background-image cover-crop handles the aspect mismatch.
  const marqueePs = marqueeArr.map((m) => (
    m && m.query
      ? fetchOne(m.query, { ...opts, aspectRatio: '4:3' }).then((image) => ({ slot: m.slot, query: m.query, image }))
      : Promise.resolve({ slot: m && m.slot, query: m && m.query, image: null })
  ));

  const culturalArr = Array.isArray(s.cultural) ? s.cultural : [];
  const culturalPs = culturalArr.map((c) => (
    c && c.query
      ? fetchOne(c.query, { ...opts, aspectRatio: '4:3' }).then((image) => ({ slot: c.slot, query: c.query, image }))
      : Promise.resolve({ slot: c && c.slot, query: c && c.query, image: null })
  ));

  let [hero, brochure, marquee, cultural] = await Promise.all([
    heroP, broP, Promise.all(marqueePs), Promise.all(culturalPs),
  ]);

  // ── Pass 2: per-page de-duplication ───────────────────────────────
  // First occurrence wins; later dupes are re-fetched serially with the
  // already-used URL set passed through. Priority: hero > marquee[0..N]
  // > brochure > cultural[0..N]. AI fallback's Pollinations / Gemini /
  // DALL-E paths emit a fresh image per call (random seed / sampling),
  // so dedup is guaranteed to converge.
  const usedUrls = new Set();
  if (hero && hero.url) usedUrls.add(hero.url);

  for (let i = 0; i < marquee.length; i++) {
    const m = marquee[i];
    if (m.image && m.image.url && !usedUrls.has(m.image.url)) {
      usedUrls.add(m.image.url);
      continue;
    }
    if (m.query) {
      const replacement = await fetchOne(m.query, { ...opts, aspectRatio: '4:3', excludeUrls: usedUrls });
      m.image = replacement;
      if (replacement && replacement.url) usedUrls.add(replacement.url);
    }
  }

  if (brochure && brochure.url && !usedUrls.has(brochure.url)) {
    usedUrls.add(brochure.url);
  } else if (brochure && brochure.url && s.brochure && s.brochure.query) {
    brochure = await fetchOne(s.brochure.query, { ...broOpts, excludeUrls: usedUrls });
    if (brochure && brochure.url) usedUrls.add(brochure.url);
  }

  for (let i = 0; i < cultural.length; i++) {
    const c = cultural[i];
    if (c.image && c.image.url && !usedUrls.has(c.image.url)) {
      usedUrls.add(c.image.url);
      continue;
    }
    if (c.query) {
      const replacement = await fetchOne(c.query, { ...opts, aspectRatio: '4:3', excludeUrls: usedUrls });
      c.image = replacement;
      if (replacement && replacement.url) usedUrls.add(replacement.url);
    }
  }

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
  fetchMany,
  fetchStrategy,
  applyImagesToContent,
  isOperatorOwned,
  _cache: IMAGE_CACHE,
  _cacheKey: cacheKey,
  _resetForTests,
};
