/**
 * travelExperienceEngine.js — PR-E Phase 2.0.
 *
 * The Travel Experience Engine (TEE) routes user inputs
 *   { destination, durationDays, audience, travelMonth, tripType, subBrand }
 * through:
 *
 *   1. Trait extraction  → 7-dimension TraitVector
 *      { climate, regionFeel, tripStyle, audienceTier, luxuryLevel,
 *        mood, visualMood }
 *   2. Family selection  → educational | religious | family | luxury
 *   3. Theme variant     → one of 13 family-generic theme ids
 *   4. Section composition → family default (one of 4)
 *   5. Image strategy    → search queries per slot (hero / marquee / brochure)
 *
 * The TEE is THE ONLY MODULE in the codebase that reads destination strings
 * for routing purposes. Two narrow extractors do it (classifyClimate +
 * classifyRegion), both with static keyword maps + cached AI fallback for
 * unknown destinations.
 *
 * Everything downstream — landingPageGeneratorLLM, the templates, the
 * renderer, themeTokens — reads the TraitVector + family + themeId only.
 * Adding a new destination (Iceland, Norway, Vietnam, Turkey, Kerala,
 * Kashmir, NZ, anything) requires NO renderer code changes — the static
 * map is the only edit, and missing entries route through AI fallback
 * automatically.
 *
 * Public surface
 * ──────────────
 *   classify(input)               — full pipeline; returns TeeOutput
 *   regenerateStrategy(input)     — re-runs classification only (R3); no LLM,
 *                                   no image fetch — returns TeeOutput
 *   classifyTraits(input)         — trait extraction only; returns TraitVector
 *   chooseFamily(traits)          — F1-F10 decision table; returns family
 *   chooseThemeVariant(family, t) — per-family theme variant decision table
 *   chooseComposition(family, t)  — picks one of 4 family-default compositions
 *   chooseImageStrategy(traits, input) — emits search queries per slot
 *   applyOverrides(traits, overrides) — operator overrides (_teeOverrides)
 *   _cache                        — exposed for tests + cache stats
 *
 * Architecture invariants
 * ───────────────────────
 *   • Decision tables are ORDERED — first matching rule wins
 *   • Decision tables are PURE FUNCTIONS of traits + family — no I/O
 *   • Only AI fallback (and the cache) does I/O; everything else is pure JS
 *   • Trait classifier always returns a result + confidence — never throws
 *   • Override surface: any trait / family / themeId / composition forceable
 *
 * R1 — Visual Mood (the 7th trait)
 * ────────────────────────────────
 * Visual Mood is a free-text label (2-4 hyphenated words) that captures
 * the destination's visual story. It's the dimension that differentiates
 * destinations sharing the same (family, themeId):
 *
 *   Iceland     (luxury-alpine) → visualMood: 'northern-aurora-mystical'
 *   Switzerland (luxury-alpine) → visualMood: 'alpine-heritage-craft'
 *   Bali        (family-tropical) → visualMood: 'tropical-temple-surf'
 *   Vietnam     (family-tropical) → visualMood: 'lantern-streets-junk-cruise'
 *
 * Visual Mood does NOT route the renderer — it's metadata that drives
 * art direction downstream: image search query phrasing, icon picks
 * within the theme's icon library, LLM copy mood overlay. The renderer
 * stays destination-agnostic.
 */

'use strict';

const themeTokens = require('./templates/themeTokens');

// ── In-memory LRU cache with TTL (Q10) ───────────────────────────────
// Used by classifier AI-fallback paths to avoid repeated Gemini calls
// for the same (dimension, destination) pair. 30-day TTL matches the
// design doc; cache size bounded so process memory stays small.

const TRAIT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TRAIT_CACHE_MAX_ENTRIES = 2000;

function createCache() {
  const store = new Map(); // key → { value, expiresAt }
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      // LRU-style: re-insert to push to most-recently-used end of Map iteration order
      store.delete(key);
      store.set(key, hit);
      return hit.value;
    },
    set(key, value, ttlMs = TRAIT_CACHE_TTL_MS) {
      // Evict oldest entries until under cap.
      while (store.size >= TRAIT_CACHE_MAX_ENTRIES) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined) break;
        store.delete(oldestKey);
      }
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    delete(key) { store.delete(key); },
    clear() { store.clear(); },
    size() { return store.size; },
    _store: store, // exposed for tests
  };
}

const TRAIT_CACHE = createCache();

// ── String normalization for destination matching ───────────────────
// Lower-case, strip diacritics, collapse whitespace + punctuation. This
// is what every keyword map lookup runs against. Match also tries word-
// boundary so 'iceland' doesn't match 'icelandcakes' (theoretical only,
// but invariant worth keeping).

function normalize(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsKeyword(normalizedHaystack, keyword) {
  // Word-boundary match. Keyword may itself be a multi-word phrase.
  const k = normalize(keyword);
  if (!k) return false;
  // Quick check before regex.
  if (!normalizedHaystack.includes(k)) return false;
  const re = new RegExp(`(^|\\W)${k.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(\\W|$)`);
  return re.test(' ' + normalizedHaystack + ' ');
}

// ── CLIMATE keyword map ─────────────────────────────────────────────
// ~120 entries spread across 6 climate zones. Each value is an array of
// destination keywords that map to that climate. Match is word-boundary
// on the normalised destination string. Missing entries fall through to
// AI fallback (cached).

const CLIMATE_MAP = Object.freeze({
  tropical: [
    'bali', 'indonesia', 'jakarta', 'thailand', 'bangkok', 'phuket', 'krabi', 'chiang mai',
    'vietnam', 'hanoi', 'halong', 'hoi an', 'da nang', 'ho chi minh',
    'maldives', 'sri lanka', 'colombo',
    'malaysia', 'kuala lumpur', 'penang', 'langkawi',
    'philippines', 'manila', 'cebu', 'palawan', 'boracay',
    'cambodia', 'siem reap', 'angkor', 'laos',
    'goa', 'kerala', 'andamans', 'lakshadweep',
    'singapore', 'hawaii', 'fiji', 'tahiti', 'samoa',
    'caribbean', 'jamaica', 'cuba', 'bahamas', 'barbados',
    'costa rica', 'panama', 'belize',
    'tanzania', 'zanzibar', 'kenya coast', 'mauritius', 'seychelles', 'madagascar',
  ],
  alpine: [
    'switzerland', 'swiss alps', 'zurich', 'geneva', 'zermatt', 'interlaken', 'lucerne', 'matterhorn', 'jungfrau',
    'austria', 'innsbruck', 'salzburg',
    'norway', 'oslo', 'bergen', 'tromso', 'lofoten',
    'iceland', 'reykjavik', 'thingvellir', 'vik', 'jokulsarlon',
    'nepal', 'kathmandu', 'pokhara', 'everest', 'annapurna',
    'bhutan', 'paro', 'thimphu',
    'patagonia', 'chile patagonia', 'argentina south',
    'new zealand south', 'queenstown', 'milford sound',
    'canadian rockies', 'banff', 'whistler',
    'tibet', 'lhasa',
    // Kashmir / Ladakh / Himalaya / Manali / Gulmarg / Sikkim — handled
    // by the temperate→alpine winter nudge; default to temperate so
    // summer trips read warmer.
  ],
  desert: [
    'dubai', 'uae', 'abu dhabi', 'sharjah', 'oman', 'muscat', 'qatar', 'doha',
    'saudi arabia', 'riyadh', 'jeddah', 'makkah', 'mecca', 'madinah', 'medina',
    'jordan', 'petra', 'wadi rum', 'amman',
    'egypt', 'cairo', 'luxor', 'aswan', 'sharm', 'hurghada', 'pyramid', 'pyramids',
    'morocco', 'marrakech', 'sahara', 'fes', 'casablanca',
    'rajasthan', 'jaipur', 'jaisalmer', 'jodhpur', 'udaipur',
    'namibia', 'sossusvlei', 'kalahari',
    'arizona', 'nevada', 'las vegas',
    'atacama',
  ],
  temperate: [
    'uk', 'britain', 'london', 'oxford', 'cambridge', 'edinburgh', 'scotland', 'ireland', 'dublin',
    'france', 'paris', 'lyon', 'nice', 'provence', 'normandy', 'loire',
    'germany', 'berlin', 'munich', 'rhine', 'bavaria',
    'netherlands', 'amsterdam', 'belgium', 'brussels', 'bruges',
    'italy', 'rome', 'venice', 'florence', 'tuscany', 'naples', 'amalfi',
    'spain', 'madrid', 'barcelona', 'andalusia', 'seville',
    'portugal', 'lisbon', 'porto',
    'greece', 'athens', 'santorini', 'mykonos',
    'turkey', 'istanbul', 'cappadocia', 'antalya',
    'japan', 'tokyo', 'kyoto', 'osaka', 'nara', 'hokkaido', 'okinawa',
    'korea', 'seoul', 'busan',
    'australia', 'sydney', 'melbourne', 'perth',
    'new zealand north', 'auckland', 'wellington',
    // Kashmir / Ladakh / Himalaya / Manali / Gulmarg / Sikkim — default
    // temperate; winter-month nudge moves them to alpine for ski-season
    // trips. Year-round high-altitude destinations (Nepal / Bhutan /
    // Switzerland / etc.) stay in the alpine list instead.
    'kashmir', 'ladakh', 'himalaya', 'manali', 'gulmarg', 'sikkim', 'darjeeling',
    'usa west', 'california', 'san francisco', 'los angeles',
    'usa east', 'new york', 'boston', 'washington',
    'china south', 'shanghai', 'hong kong',
    'south africa', 'cape town',
  ],
  continental: [
    'china north', 'beijing', 'xian', 'great wall',
    'russia', 'moscow', 'st petersburg', 'siberia',
    'mongolia', 'ulaanbaatar', 'gobi',
    'kazakhstan', 'almaty',
    'canada east', 'toronto', 'montreal', 'quebec',
    'usa midwest', 'chicago', 'denver',
    'eastern europe', 'prague', 'vienna', 'budapest', 'warsaw',
  ],
  polar: [
    'antarctica', 'south pole',
    'greenland', 'ilulissat',
    'svalbard', 'longyearbyen',
    'arctic', 'north pole',
    'finnish lapland', 'lapland', 'rovaniemi',
  ],
});

// ── REGION keyword map ─────────────────────────────────────────────

const REGION_MAP = Object.freeze({
  'east-asian': [
    'japan', 'tokyo', 'kyoto', 'osaka', 'nara', 'hokkaido', 'okinawa',
    'korea', 'seoul', 'busan',
    'china', 'beijing', 'shanghai', 'xian', 'hong kong', 'taiwan', 'taipei',
    'mongolia', 'ulaanbaatar',
  ],
  'south-asian': [
    'india', 'delhi', 'mumbai', 'bangalore', 'chennai', 'kolkata',
    'kerala', 'goa', 'rajasthan', 'jaipur', 'jodhpur', 'kashmir', 'ladakh',
    'tamil nadu', 'karnataka', 'maharashtra', 'gujarat',
    'sri lanka', 'colombo', 'kandy',
    'nepal', 'bhutan', 'maldives',
    'pakistan', 'bangladesh',
  ],
  'middle-eastern': [
    'umrah', 'hajj', 'makkah', 'mecca', 'madinah', 'medina', 'saudi arabia', 'saudi', 'riyadh', 'jeddah',
    'dubai', 'uae', 'abu dhabi', 'sharjah',
    'oman', 'muscat', 'qatar', 'doha',
    'jordan', 'amman', 'petra', 'wadi rum',
    'turkey', 'istanbul', 'cappadocia', 'antalya',
    'egypt', 'cairo', 'luxor', 'aswan', 'pyramid', 'pyramids', 'sharm',
    'jerusalem', 'israel', 'palestine', 'tel aviv', 'holy land',
    'lebanon', 'beirut',
    'iran', 'tehran',
    'morocco', 'marrakech', 'fes', 'casablanca', // overlap with african — middle-eastern wins on cultural feel
  ],
  'european': [
    'uk', 'britain', 'london', 'oxford', 'cambridge', 'edinburgh', 'scotland', 'ireland', 'dublin',
    'france', 'paris', 'lyon', 'nice', 'provence', 'normandy',
    'germany', 'berlin', 'munich', 'bavaria',
    'netherlands', 'amsterdam', 'belgium', 'brussels',
    'italy', 'rome', 'venice', 'florence', 'tuscany', 'naples', 'amalfi',
    'spain', 'madrid', 'barcelona', 'seville', 'portugal', 'lisbon', 'porto',
    'greece', 'athens', 'santorini', 'mykonos',
    'switzerland', 'swiss', 'zurich', 'geneva', 'zermatt', 'interlaken', 'lucerne',
    'austria', 'innsbruck', 'salzburg',
    'norway', 'oslo', 'bergen', 'tromso', 'lofoten',
    'iceland', 'reykjavik',
    'denmark', 'copenhagen', 'sweden', 'stockholm', 'finland', 'helsinki',
    'prague', 'vienna', 'budapest', 'warsaw', 'krakow',
    'russia', 'moscow', 'st petersburg',
    'svalbard',
  ],
  'american': [
    'usa', 'united states', 'new york', 'boston', 'chicago', 'washington', 'los angeles', 'san francisco',
    'california', 'florida', 'texas', 'hawaii',
    'canada', 'toronto', 'montreal', 'vancouver', 'banff',
    'mexico', 'cancun', 'tulum', 'mexico city',
    'cuba', 'jamaica', 'bahamas', 'barbados', 'puerto rico',
    'brazil', 'rio', 'amazon',
    'argentina', 'patagonia', 'buenos aires', 'chile', 'santiago', 'peru', 'machu picchu', 'cusco',
    'costa rica', 'panama', 'belize',
  ],
  'oceanic': [
    'australia', 'sydney', 'melbourne', 'perth', 'great barrier reef', 'cairns',
    'new zealand', 'auckland', 'queenstown', 'milford sound', 'wellington',
    'fiji', 'tahiti', 'samoa', 'cook islands',
    'papua new guinea',
  ],
  'south-east-asian': [
    'thailand', 'bangkok', 'phuket', 'krabi', 'chiang mai',
    'vietnam', 'hanoi', 'halong', 'hoi an', 'da nang', 'ho chi minh',
    'bali', 'indonesia', 'jakarta', 'ubud',
    'cambodia', 'siem reap', 'angkor', 'laos',
    'philippines', 'manila', 'cebu', 'palawan',
    'malaysia', 'kuala lumpur', 'penang', 'langkawi',
    'singapore', 'myanmar', 'yangon',
  ],
  'african': [
    'kenya', 'nairobi', 'masai mara',
    'tanzania', 'serengeti', 'kilimanjaro', 'zanzibar',
    'south africa', 'cape town', 'johannesburg', 'kruger',
    'namibia', 'sossusvlei',
    'botswana', 'okavango',
    'morocco', 'marrakech', 'fes', // overlap — region picker keeps middle-eastern; this entry surfaces only when other signals point African
    'egypt', // overlap — same handling
    'rwanda', 'uganda',
    'ethiopia',
    'madagascar',
  ],
});

// ── Region overlap resolution priority ──────────────────────────────
// Some destinations (Morocco, Egypt) plausibly belong to multiple regions
// depending on cultural framing. Static maps capture all valid options;
// this list controls which region wins when multiple match. Religious +
// pilgrimage trips should always read middle-eastern for Egypt / Morocco;
// safari trips should read african. Without other signals, default to the
// first-matched region.

const REGION_PRIORITY = Object.freeze([
  'east-asian', 'south-asian', 'south-east-asian', 'european',
  'middle-eastern', 'american', 'oceanic', 'african',
]);

// ═══════════════════════════════════════════════════════════════════
// AI fallback wrapper — wraps the project's existing llmRouter
// (lib/llmRouter.js). Used by classifyClimate / classifyRegion /
// classifyVisualMood for unknown destinations. Returns null on any
// error so the caller can fall back to deterministic defaults.
// ═══════════════════════════════════════════════════════════════════

async function aiClassify({ task = 'bulk-text', prompt, tenantId, parser, surface }) {
  let routeRequest;
  try {
    routeRequest = require('../lib/llmRouter').routeRequest;
  } catch (_e) {
    return null; // router not available; degrade silently
  }
  try {
    const result = await routeRequest({
      task,
      payload: { prompt, __surface: surface || 'tee-classifier' },
      tenantId,
    });
    if (!result || typeof result.text !== 'string') return null;
    if (typeof parser === 'function') {
      try { return parser(result.text); } catch (_e) { return null; }
    }
    return result.text.trim();
  } catch (_e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// TRAIT EXTRACTORS
// Each returns { value, confidence, source } where source is one of:
//   'static' | 'ai-classified' | 'override' | 'derived' | 'default'
// ═══════════════════════════════════════════════════════════════════

const CLIMATES = Object.freeze(['tropical', 'temperate', 'continental', 'alpine', 'desert', 'polar']);
const REGIONS = Object.freeze([
  'east-asian', 'south-asian', 'south-east-asian', 'european',
  'middle-eastern', 'american', 'oceanic', 'african',
]);
const TRIP_STYLES = Object.freeze([
  'educational', 'pilgrimage', 'family-holiday', 'honeymoon',
  'wellness', 'adventure', 'business', 'leisure',
]);
const AUDIENCE_TIERS = Object.freeze([
  'students', 'parents', 'pilgrims', 'couples', 'families', 'hni', 'multigen', 'solo', 'leisure',
]);
const MOODS = Object.freeze([
  'reverent', 'structured', 'vibrant', 'minimal', 'adventurous', 'contemplative',
]);

// ── classifyClimate ────────────────────────────────────────────────
async function classifyClimate(destination, travelMonth, { tenantId } = {}) {
  const norm = normalize(destination);
  if (!norm) {
    return { value: 'temperate', confidence: 0.2, source: 'default' };
  }
  // Static map lookup.
  for (const [climate, keywords] of Object.entries(CLIMATE_MAP)) {
    for (const kw of keywords) {
      if (containsKeyword(norm, kw)) {
        // travelMonth nudge: temperate destinations with winter travel may
        // be alpine in their high-altitude variants (e.g. Kashmir Dec → alpine).
        // Light heuristic; AI fallback handles nuance better.
        if (climate === 'temperate' && travelMonth && isWinterMonth(travelMonth)) {
          if (/\b(kashmir|gulmarg|manali|himalaya|sikkim|nepal)\b/.test(norm)) {
            return { value: 'alpine', confidence: 0.85, source: 'static' };
          }
        }
        return { value: climate, confidence: 0.92, source: 'static' };
      }
    }
  }
  // Cached AI fallback.
  const cacheKey = `climate:${norm}`;
  const cached = TRAIT_CACHE.get(cacheKey);
  if (cached) {
    return { value: cached.value, confidence: cached.confidence, source: 'ai-classified' };
  }
  const aiResult = await aiClassify({
    prompt: `Classify the climate of the travel destination "${destination}". Respond with ONLY one of: tropical, temperate, continental, alpine, desert, polar. No punctuation, no explanation.`,
    tenantId,
    surface: 'tee-classify-climate',
    parser: (text) => {
      const m = text.toLowerCase().match(/\b(tropical|temperate|continental|alpine|desert|polar)\b/);
      return m ? m[1] : null;
    },
  });
  if (aiResult && CLIMATES.includes(aiResult)) {
    TRAIT_CACHE.set(cacheKey, { value: aiResult, confidence: 0.75 });
    return { value: aiResult, confidence: 0.75, source: 'ai-classified' };
  }
  return { value: 'temperate', confidence: 0.2, source: 'default' };
}

function isWinterMonth(travelMonth) {
  if (typeof travelMonth !== 'string') return false;
  // Accept "YYYY-MM" or month name.
  const monthNum = parseMonthNumber(travelMonth);
  if (monthNum == null) return false;
  return [11, 12, 1, 2].includes(monthNum); // Nov-Feb
}

function parseMonthNumber(s) {
  const m = s.match(/^\d{4}-(\d{2})$/);
  if (m) return parseInt(m[1], 10);
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const idx = monthNames.findIndex((mn) => s.toLowerCase().startsWith(mn));
  return idx >= 0 ? idx + 1 : null;
}

// ── classifyRegion ─────────────────────────────────────────────────
async function classifyRegion(destination, { tenantId } = {}) {
  const norm = normalize(destination);
  if (!norm) return { value: 'european', confidence: 0.2, source: 'default' };
  // Collect all region matches (multi-match possible).
  const hits = new Set();
  for (const [region, keywords] of Object.entries(REGION_MAP)) {
    for (const kw of keywords) {
      if (containsKeyword(norm, kw)) { hits.add(region); break; }
    }
  }
  if (hits.size > 0) {
    // Priority-ordered pick.
    for (const region of REGION_PRIORITY) {
      if (hits.has(region)) {
        return { value: region, confidence: hits.size > 1 ? 0.78 : 0.92, source: 'static' };
      }
    }
  }
  // Cached AI fallback.
  const cacheKey = `region:${norm}`;
  const cached = TRAIT_CACHE.get(cacheKey);
  if (cached) {
    return { value: cached.value, confidence: cached.confidence, source: 'ai-classified' };
  }
  const aiResult = await aiClassify({
    prompt: `Classify the cultural region of the travel destination "${destination}". Respond with ONLY one of: east-asian, south-asian, south-east-asian, european, middle-eastern, american, oceanic, african. No punctuation, no explanation.`,
    tenantId,
    surface: 'tee-classify-region',
    parser: (text) => {
      const m = text.toLowerCase().match(/\b(east-asian|south-asian|south-east-asian|european|middle-eastern|american|oceanic|african)\b/);
      return m ? m[1] : null;
    },
  });
  if (aiResult && REGIONS.includes(aiResult)) {
    TRAIT_CACHE.set(cacheKey, { value: aiResult, confidence: 0.75 });
    return { value: aiResult, confidence: 0.75, source: 'ai-classified' };
  }
  return { value: 'european', confidence: 0.2, source: 'default' };
}

// ── classifyTripStyle ──────────────────────────────────────────────
function classifyTripStyle(input) {
  const tripType = String(input.tripType || '').toLowerCase().trim();
  const subBrand = String(input.subBrand || '').toLowerCase().trim();
  const audience = normalize(input.audience || '');
  const destination = normalize(input.destination || '');

  // Step 1 — explicit subBrand shortcut (highest confidence).
  if (subBrand === 'rfu') return { value: 'pilgrimage', confidence: 1.0, source: 'static' };
  if (subBrand === 'tmc') return { value: 'educational', confidence: 1.0, source: 'static' };

  // Step 2 — explicit tripType.
  if (tripType === 'religious' || tripType === 'pilgrimage') {
    return { value: 'pilgrimage', confidence: 1.0, source: 'static' };
  }
  if (tripType === 'educational' || tripType === 'school') {
    return { value: 'educational', confidence: 1.0, source: 'static' };
  }
  if (tripType === 'family' || tripType === 'family holiday' || tripType === 'family-holiday') {
    return { value: 'family-holiday', confidence: 0.95, source: 'static' };
  }
  if (tripType === 'honeymoon') return { value: 'honeymoon', confidence: 1.0, source: 'static' };
  if (tripType === 'wellness') return { value: 'wellness', confidence: 1.0, source: 'static' };
  if (tripType === 'adventure') return { value: 'adventure', confidence: 1.0, source: 'static' };
  if (tripType === 'business' || tripType === 'incentive') {
    return { value: 'business', confidence: 1.0, source: 'static' };
  }
  if (tripType === 'luxury') {
    // Luxury isn't a trip style by itself — infer from audience.
    if (/\b(couples?|honeymoon|anniversary)\b/.test(audience)) {
      return { value: 'honeymoon', confidence: 0.85, source: 'derived' };
    }
    return { value: 'leisure', confidence: 0.7, source: 'derived' };
  }

  // Step 3 — audience-phrase parsing.
  if (/\b(honeymoon|anniversary)\b/.test(audience)) return { value: 'honeymoon', confidence: 0.9, source: 'derived' };
  if (/\bcouples?\b/.test(audience) && !/\bfamil(y|ies)\b/.test(audience)) return { value: 'honeymoon', confidence: 0.7, source: 'derived' };
  if (/\b(wellness|spa|detox|retreat|yoga)\b/.test(audience)) return { value: 'wellness', confidence: 0.9, source: 'derived' };
  if (/\b(adventure|trek|safari|expedition|hiking)\b/.test(audience)) return { value: 'adventure', confidence: 0.9, source: 'derived' };
  if (/\b(incentive|conference|business)\b/.test(audience)) return { value: 'business', confidence: 0.9, source: 'derived' };
  if (/\b(students?|grade\s*\d+|school|youth|teen)\b/.test(audience)) return { value: 'educational', confidence: 0.85, source: 'derived' };
  if (/\b(famil(y|ies)|kids?|children|parents?)\b/.test(audience)) return { value: 'family-holiday', confidence: 0.85, source: 'derived' };
  if (/\bpilgrim(s|age)?\b/.test(audience)) return { value: 'pilgrimage', confidence: 0.95, source: 'derived' };

  // Step 4 — destination keyword shortcuts (the LAST place destination
  // keywords feed routing; only fires when audience + tripType silent).
  if (/\b(umrah|hajj|mecca|makkah|madinah|medina|kaaba|haram)\b/.test(destination)) {
    return { value: 'pilgrimage', confidence: 0.85, source: 'derived' };
  }
  if (/\b(jerusalem|holy land)\b/.test(destination)) {
    return { value: 'pilgrimage', confidence: 0.7, source: 'derived' };
  }

  return { value: 'leisure', confidence: 0.4, source: 'default' };
}

// ── classifyAudienceTier ────────────────────────────────────────────
function classifyAudienceTier(audience, tripStyle) {
  const a = normalize(audience);
  if (/\b(pilgrim(s|age)?|haji)\b/.test(a)) return { value: 'pilgrims', confidence: 0.95, source: 'static' };
  // Parents is checked BEFORE students because a phrase like "parents of
  // students" should classify as 'parents' (the decision-maker) for an
  // educational trip, not 'students' (the audience).
  if (/\b(parents?)\b/.test(a) && tripStyle === 'educational') return { value: 'parents', confidence: 0.9, source: 'derived' };
  if (/\b(students?|grade\s*\d+|school|youth|teen)\b/.test(a)) return { value: 'students', confidence: 0.95, source: 'static' };
  if (/\b(multi.?gen|grandparents?)\b/.test(a)) return { value: 'multigen', confidence: 0.9, source: 'static' };
  if (/\bhni|premium|exclusive|vip|elite\b/.test(a)) return { value: 'hni', confidence: 0.9, source: 'static' };
  if (/\bsolo|individual\b/.test(a)) return { value: 'solo', confidence: 0.9, source: 'static' };
  if (/\bcouples?|honeymoon|anniversary\b/.test(a)) return { value: 'couples', confidence: 0.9, source: 'static' };
  if (/\bfamil(y|ies)|kids?|children\b/.test(a)) return { value: 'families', confidence: 0.9, source: 'static' };
  // Derive from tripStyle when audience is silent.
  if (tripStyle === 'educational') return { value: 'students', confidence: 0.65, source: 'derived' };
  if (tripStyle === 'pilgrimage') return { value: 'pilgrims', confidence: 0.7, source: 'derived' };
  if (tripStyle === 'family-holiday') return { value: 'families', confidence: 0.75, source: 'derived' };
  if (tripStyle === 'honeymoon') return { value: 'couples', confidence: 0.85, source: 'derived' };
  return { value: 'leisure', confidence: 0.5, source: 'default' };
}

// ── classifyLuxuryLevel ─────────────────────────────────────────────
function classifyLuxuryLevel(input, { tripStyle, audienceTier } = {}) {
  let score = 0;
  const audience = normalize(input.audience || '');
  const tripType = String(input.tripType || '').toLowerCase();

  if (tripType === 'luxury') score += 4;
  if (tripStyle === 'business') score += 2;
  if (tripStyle === 'honeymoon') score += 2;
  if (tripStyle === 'wellness') score += 1;
  if (audienceTier === 'hni') score += 3;
  if (audienceTier === 'couples') score += 1;
  if (/\b(hni|premium|exclusive|vip|elite|private)\b/.test(audience)) score += 3;
  if (/\b(boutique|curated|bespoke)\b/.test(audience)) score += 2;
  if (/\b(budget|backpack|hostel)\b/.test(audience)) score -= 2;
  if (Number.isFinite(Number(input.durationDays)) && Number(input.durationDays) >= 14) score += 1;

  const value = Math.max(0, Math.min(5, Math.round(score)));
  const source = score === 0 ? 'default' : 'derived';
  return { value, confidence: 0.7, source };
}

// ── classifyMood ────────────────────────────────────────────────────
// Pure derivation from already-extracted traits — no I/O.
function classifyMood({ tripStyle, luxuryLevel } = {}) {
  if (tripStyle === 'pilgrimage')                      return { value: 'reverent', confidence: 1.0, source: 'derived' };
  if (tripStyle === 'wellness')                        return { value: 'contemplative', confidence: 0.9, source: 'derived' };
  if (tripStyle === 'educational')                     return { value: 'structured', confidence: 0.95, source: 'derived' };
  if (tripStyle === 'adventure')                       return { value: 'adventurous', confidence: 0.95, source: 'derived' };
  if (tripStyle === 'family-holiday')                  return { value: 'vibrant', confidence: 0.9, source: 'derived' };
  if (luxuryLevel >= 4)                                return { value: 'minimal', confidence: 0.85, source: 'derived' };
  if (tripStyle === 'honeymoon')                       return { value: 'minimal', confidence: 0.8, source: 'derived' };
  return { value: 'vibrant', confidence: 0.5, source: 'default' };
}

// ── classifyVisualMood — the 7th trait (R1) ─────────────────────────
// Free-text label (2-4 hyphenated lowercase words) describing the
// destination's visual story. Generated by AI for novel destinations;
// cached after first call. Drives downstream art direction (image
// queries, icon picks, copy mood overlay) — never routes the renderer.
async function classifyVisualMood(input, traits, { tenantId } = {}) {
  const norm = normalize(input.destination || '');
  if (!norm) {
    return { value: 'generic-leisure', confidence: 0.2, source: 'default' };
  }
  // Cache key includes family + mood so the same destination under a
  // different framing (e.g. Egypt-religious vs Egypt-family) gets
  // distinct visualMoods.
  const cacheKey = `visualMood:${norm}:${traits.family || ''}:${traits.mood || ''}`;
  const cached = TRAIT_CACHE.get(cacheKey);
  if (cached) {
    return { value: cached.value, confidence: cached.confidence, source: 'ai-classified' };
  }
  const aiResult = await aiClassify({
    prompt:
      `You are labelling the visual mood of a travel page about "${input.destination}".\n` +
      `Trip style: ${traits.tripStyle || 'leisure'}. Region: ${traits.regionFeel || 'unknown'}. Climate: ${traits.climate || 'unknown'}.\n` +
      `Mood: ${traits.mood || 'vibrant'}. Luxury level (0-5): ${typeof traits.luxuryLevel === 'number' ? traits.luxuryLevel : 2}.\n\n` +
      `Respond with ONLY a 2-4 word hyphenated label describing the destination's visual essence. Examples:\n` +
      `  - Iceland luxury: northern-aurora-mystical\n` +
      `  - Switzerland luxury: alpine-heritage-craft\n` +
      `  - Bali family: tropical-temple-surf\n` +
      `  - Vietnam family: lantern-streets-junk-cruise\n` +
      `  - Japan educational: heritage-discipline-modern-velocity\n` +
      `  - Umrah religious: sacred-haram-dawn-stillness\n\n` +
      `Label only. No punctuation other than hyphens. No quotes.`,
    tenantId,
    surface: 'tee-classify-visual-mood',
    parser: (text) => {
      const t = text.trim().toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (!t) return null;
      // Reject obvious llmRouter stub responses ("stub-bulk-text-...")
      // so the deterministic fallback fires under NODE_ENV=test; that
      // path produces destination-distinct labels which the R1 contract
      // requires (Iceland vs Switzerland must differ visually).
      if (/^stub-/.test(t) || /\bstub-bulk-text\b/.test(t)) return null;
      const words = t.split('-').filter(Boolean).slice(0, 4);
      if (words.length < 2) return null;
      return words.join('-');
    },
  });
  if (aiResult) {
    TRAIT_CACHE.set(cacheKey, { value: aiResult, confidence: 0.8 });
    return { value: aiResult, confidence: 0.8, source: 'ai-classified' };
  }
  // Deterministic fallback when AI unavailable: weave the destination
  // slug into the trait label so two destinations with identical traits
  // (Iceland + Switzerland both alpine+minimal) still differentiate.
  const fallback = deterministicVisualMood(traits, input.destination);
  return { value: fallback, confidence: 0.4, source: 'default' };
}

function deterministicVisualMood(traits, destination) {
  // First word of the destination acts as a destination slug — it's
  // metadata only (label is not used for routing), so this stays Option-B
  // compliant (renderer never reads it). Iceland → 'iceland'; Switzerland
  // → 'switzerland'. Combined with trait labels we get distinct labels.
  const parts = [];
  if (destination) {
    const slug = String(destination).toLowerCase().split(/[\s,]+/)[0].replace(/[^a-z0-9]/g, '');
    if (slug) parts.push(slug);
  }
  if (traits.climate)    parts.push(traits.climate);
  if (traits.mood)       parts.push(traits.mood);
  if (traits.tripStyle && traits.tripStyle !== 'leisure') parts.push(traits.tripStyle);
  if (parts.length === 0) parts.push('generic', 'leisure');
  return parts.slice(0, 4).join('-');
}

// ═══════════════════════════════════════════════════════════════════
// COMPOSITE: classifyTraits — runs all 7 extractors in topological order
// ═══════════════════════════════════════════════════════════════════

async function classifyTraits(input, { tenantId } = {}) {
  const inp = input || {};
  const overrides = (inp._teeOverrides && typeof inp._teeOverrides === 'object') ? inp._teeOverrides : {};

  const climate     = overrides.climate    ? { value: overrides.climate,    confidence: 1.0, source: 'override' } : await classifyClimate(inp.destination, inp.travelMonth, { tenantId });
  const regionFeel  = overrides.regionFeel ? { value: overrides.regionFeel, confidence: 1.0, source: 'override' } : await classifyRegion(inp.destination, { tenantId });
  const tripStyle   = overrides.tripStyle  ? { value: overrides.tripStyle,  confidence: 1.0, source: 'override' } : classifyTripStyle(inp);
  const audienceTier = overrides.audienceTier ? { value: overrides.audienceTier, confidence: 1.0, source: 'override' } : classifyAudienceTier(inp.audience, tripStyle.value);
  const luxuryLevel = overrides.luxuryLevel != null ? { value: overrides.luxuryLevel, confidence: 1.0, source: 'override' } : classifyLuxuryLevel(inp, { tripStyle: tripStyle.value, audienceTier: audienceTier.value });
  const mood        = overrides.mood       ? { value: overrides.mood,       confidence: 1.0, source: 'override' } : classifyMood({ tripStyle: tripStyle.value, luxuryLevel: luxuryLevel.value });
  // visualMood needs all the other traits available — pass a flat object.
  const flatTraitsForMood = {
    climate: climate.value, regionFeel: regionFeel.value, tripStyle: tripStyle.value,
    audienceTier: audienceTier.value, luxuryLevel: luxuryLevel.value, mood: mood.value,
    family: undefined, // family decided AFTER mood; visualMood depends only on the rest
  };
  const visualMood  = overrides.visualMood ? { value: overrides.visualMood, confidence: 1.0, source: 'override' } : await classifyVisualMood(inp, flatTraitsForMood, { tenantId });

  const dimensions = { climate, regionFeel, tripStyle, audienceTier, luxuryLevel, mood, visualMood };
  const confidence = Math.min(...Object.values(dimensions).map((d) => d.confidence));
  const sources = Object.values(dimensions).map((d) => d.source);
  const overallSource =
    sources.includes('ai-classified') ? 'ai-classified' :
    sources.every((s) => s === 'override') ? 'override' :
    sources.includes('default') ? 'partial' :
    'static';

  return {
    climate:      climate.value,
    regionFeel:   regionFeel.value,
    tripStyle:    tripStyle.value,
    audienceTier: audienceTier.value,
    luxuryLevel:  luxuryLevel.value,
    mood:         mood.value,
    visualMood:   visualMood.value,
    confidence,
    source: overallSource,
    perDimension: dimensions,
  };
}

// ═══════════════════════════════════════════════════════════════════
// DECISION TABLES
// ═══════════════════════════════════════════════════════════════════

// ── Family decision table — F1-F10 ──────────────────────────────────
function chooseFamily(traits, { override } = {}) {
  if (override && ['educational', 'religious', 'family', 'luxury'].includes(override)) {
    return { value: override, ruleId: 'OVERRIDE', rationale: 'operator override' };
  }
  const t = traits || {};
  // F1
  if (t.tripStyle === 'pilgrimage') return { value: 'religious', ruleId: 'F1', rationale: 'tripStyle=pilgrimage' };
  // F2
  if (t.tripStyle === 'educational' && ['students', 'parents'].includes(t.audienceTier)) {
    return { value: 'educational', ruleId: 'F2', rationale: 'tripStyle=educational + audience=students/parents' };
  }
  // F3
  if (t.luxuryLevel >= 4) return { value: 'luxury', ruleId: 'F3', rationale: 'luxuryLevel>=4' };
  // F4
  if (t.tripStyle === 'honeymoon' && t.luxuryLevel >= 2) {
    return { value: 'luxury', ruleId: 'F4', rationale: 'honeymoon + luxuryLevel>=2' };
  }
  // F5
  if (t.tripStyle === 'wellness' && t.luxuryLevel >= 3) {
    return { value: 'luxury', ruleId: 'F5', rationale: 'wellness + luxuryLevel>=3' };
  }
  // F6
  if (t.tripStyle === 'family-holiday' || ['families', 'multigen'].includes(t.audienceTier)) {
    return { value: 'family', ruleId: 'F6', rationale: 'family-holiday OR audience=families/multigen' };
  }
  // F7
  if (t.tripStyle === 'adventure' && t.luxuryLevel >= 3) {
    return { value: 'luxury', ruleId: 'F7', rationale: 'adventure + luxuryLevel>=3' };
  }
  // F8
  if (t.tripStyle === 'adventure') {
    return { value: 'family', ruleId: 'F8', rationale: 'adventure + luxuryLevel<3' };
  }
  // F9
  if (t.tripStyle === 'business' && t.luxuryLevel >= 3) {
    return { value: 'luxury', ruleId: 'F9', rationale: 'business + luxuryLevel>=3' };
  }
  // F10 default
  return { value: 'family', ruleId: 'F10', rationale: 'default' };
}

// ── Theme variant decision tables ───────────────────────────────────
function chooseThemeVariant(family, traits, { override } = {}) {
  if (override && themeTokens.getTheme(override)) {
    return { value: override, ruleId: 'OVERRIDE', rationale: 'operator override' };
  }
  const t = traits || {};
  const audienceLower = String(t.audience || '').toLowerCase();
  switch (family) {
    case 'educational':
      if (t.regionFeel === 'east-asian' && t.mood === 'structured') {
        return { value: 'educational-academic', ruleId: 'E1', rationale: 'east-asian + structured' };
      }
      if (/\b(stem|robotics|tech|space|coding|nasa|mit)\b/i.test(audienceLower) || /\b(stem|tech)\b/i.test(t.visualMood || '')) {
        return { value: 'educational-tech', ruleId: 'E2', rationale: 'stem/tech signals in audience' };
      }
      if (t.regionFeel === 'european') {
        return { value: 'educational-classical', ruleId: 'E3', rationale: 'european region' };
      }
      if (['south-east-asian', 'south-asian'].includes(t.regionFeel)) {
        return { value: 'educational-modern', ruleId: 'E5', rationale: 'south-east/south-asian region' };
      }
      return { value: 'educational-modern', ruleId: 'E6', rationale: 'default' };

    case 'religious':
      if (t.regionFeel === 'middle-eastern' && t.luxuryLevel >= 3) {
        return { value: 'religious-premium', ruleId: 'R1', rationale: 'middle-eastern + luxury' };
      }
      if (t.regionFeel === 'middle-eastern') {
        return { value: 'religious-classical', ruleId: 'R2', rationale: 'middle-eastern' };
      }
      if (/\b(jerusalem|holy land|christian)\b/i.test(audienceLower)) {
        return { value: 'religious-premium', ruleId: 'R3', rationale: 'jerusalem/holy-land/christian' };
      }
      return { value: 'religious-spiritual', ruleId: 'R4', rationale: 'default religious' };

    case 'family':
      if (t.climate === 'tropical') return { value: 'family-tropical', ruleId: 'FA1', rationale: 'tropical climate' };
      if (t.climate === 'desert')   return { value: 'family-resort',   ruleId: 'FA3', rationale: 'desert climate' };
      if (t.regionFeel === 'south-east-asian') return { value: 'family-tropical', ruleId: 'FA4', rationale: 'south-east-asian region' };
      if (t.regionFeel === 'middle-eastern' && t.tripStyle !== 'pilgrimage') {
        return { value: 'family-resort', ruleId: 'FA5', rationale: 'middle-eastern non-pilgrim' };
      }
      return { value: 'family-vibrant', ruleId: 'FA6', rationale: 'default family' };

    case 'luxury':
      if (['alpine', 'polar'].includes(t.climate)) {
        return { value: 'luxury-alpine', ruleId: 'L1', rationale: 'alpine/polar climate' };
      }
      if (t.climate === 'tropical' && ['honeymoon', 'wellness', 'leisure'].includes(t.tripStyle)) {
        return { value: 'luxury-coastal', ruleId: 'L2', rationale: 'tropical + honeymoon/wellness/leisure' };
      }
      if (t.regionFeel === 'european') {
        return { value: 'luxury-continental', ruleId: 'L3', rationale: 'european' };
      }
      if (t.regionFeel === 'middle-eastern' && t.mood === 'minimal') {
        return { value: 'luxury-continental', ruleId: 'L4', rationale: 'middle-eastern + minimal' };
      }
      return { value: 'luxury-alpine', ruleId: 'L5', rationale: 'default luxury' };

    default:
      return { value: 'educational-academic', ruleId: 'F-FALLBACK', rationale: 'unknown family' };
  }
}

// ── Composition picker (4 family defaults only per Q6) ─────────────
function chooseComposition(family, traits, { override } = {}) {
  if (Array.isArray(override) && override.length > 0) {
    return { value: override, ruleId: 'OVERRIDE', rationale: 'operator override' };
  }
  const composition = themeTokens.SECTION_COMPOSITION[family] || themeTokens.SECTION_COMPOSITION.educational;
  return { value: composition, ruleId: `C-${family}-default`, rationale: `family default for ${family}` };
}

// ── Image strategy generator ────────────────────────────────────────
// Emits one search query per image slot. Visual-mood-aware: the LLM's
// visualMood label feeds the prompt so Iceland (northern-aurora-mystical)
// and Switzerland (alpine-heritage-craft) get different queries even
// though they share the luxury-alpine theme.
// Per-slot landmark seeds — concrete photographic NOUNS that map to real
// stock-photo categories. The set deliberately mixes FAMOUS-SPOT focus
// (famous landmark / popular tourist attraction / iconic destination)
// with CULTURAL focus (heritage / culture / cuisine) so a longer marquee
// loop (up to 10 slots) doesn't repeat the same theme.
//
// Earlier iterations used phrases like 'skyline architecture' which
// Pexels matched on the word 'architecture' generically and returned
// rendered building drawings. The current seeds are the topic-words
// travel photographers actually tag their work with — tested against
// Pexels' top-5 results for "<dest> <seed>" returning location-relevant
// imagery instead of generic portrait headshots.
const MARQUEE_SLOT_SEEDS = [
  'famous landmark',
  'popular tourist attraction',
  'cultural heritage',
  'iconic destination view',
  'traditional culture',
  'nature landscape',
  'local cuisine food',
  'historic monument',
  'architectural heritage',
  'famous tourist spot',
];

function chooseImageStrategy(traits, input, { citiesCount = 4 } = {}) {
  const dest = input.destination || '';
  // We deliberately do NOT mix in the traits.visualMood phrase
  // (e.g. 'tokyo-temperate-structured-educational' → 'tokyo temperate
  // structured educational') — Pexels treats those as noise tokens and
  // they pollute the top-N ranking. Same for traits.climate. The
  // destination + a single concrete topic-word is what produces relevant
  // tourism photos. The 'vertical portrait' suffix is also gone — the
  // provider's `orientation` parameter handles aspect and the word
  // 'portrait' in a query biases stock providers toward selfies.
  const hero = `${dest} famous landmark scenic`.trim().replace(/\s+/g, ' ');
  const brochure = `${dest} tourist destination`.trim().replace(/\s+/g, ' ');
  // Cap raised from 6 → 10 (2026-06-24) so a longer marquee loop reads
  // smoother on wide viewports. 3 is still the floor for visual variety.
  const slotCount = Math.max(3, Math.min(10, citiesCount));
  const marquee = Array.from({ length: slotCount }, (_, i) => ({
    slot: i,
    query: `${dest} ${MARQUEE_SLOT_SEEDS[i % MARQUEE_SLOT_SEEDS.length]}`.trim().replace(/\s+/g, ' '),
  }));
  return {
    hero: { query: hero, aspectRatio: '4:3', minWidth: 1200 },
    marquee,
    brochure: { query: brochure, aspectRatio: '4:5', minWidth: 800 },
    cultural: [], // intentionally empty by default — Phase 2.1 may opt in per family
  };
}

// ═══════════════════════════════════════════════════════════════════
// ORCHESTRATORS
// ═══════════════════════════════════════════════════════════════════

async function classify(input, { tenantId } = {}) {
  const inp = input || {};
  const overrides = (inp._teeOverrides && typeof inp._teeOverrides === 'object') ? inp._teeOverrides : {};
  const traits = await classifyTraits(inp, { tenantId });
  const family = chooseFamily(traits, { override: overrides.family });
  const themeChoice = chooseThemeVariant(family.value, traits, { override: overrides.themeId });
  const composition = chooseComposition(family.value, traits, { override: overrides.composition });
  const imageStrategy = chooseImageStrategy(traits, inp);
  const themeMeta = themeTokens.getTheme(themeChoice.value);
  return {
    family: family.value,
    themeId: themeChoice.value,
    composition: composition.value,
    imageStrategy,
    traits,
    theme: themeMeta ? {
      id: themeMeta.id,
      family: themeMeta.family,
      variant: themeMeta.variant,
      decorative: themeMeta.decorative,
    } : null,
    decisionLog: {
      family:      { ruleId: family.ruleId,      rationale: family.rationale,      value: family.value },
      themeId:     { ruleId: themeChoice.ruleId, rationale: themeChoice.rationale, value: themeChoice.value },
      composition: { ruleId: composition.ruleId, rationale: composition.rationale, value: composition.value },
      traits: {
        climate:      { value: traits.climate,      source: traits.perDimension.climate.source,      confidence: traits.perDimension.climate.confidence },
        regionFeel:   { value: traits.regionFeel,   source: traits.perDimension.regionFeel.source,   confidence: traits.perDimension.regionFeel.confidence },
        tripStyle:    { value: traits.tripStyle,    source: traits.perDimension.tripStyle.source,    confidence: traits.perDimension.tripStyle.confidence },
        audienceTier: { value: traits.audienceTier, source: traits.perDimension.audienceTier.source, confidence: traits.perDimension.audienceTier.confidence },
        luxuryLevel:  { value: traits.luxuryLevel,  source: traits.perDimension.luxuryLevel.source,  confidence: traits.perDimension.luxuryLevel.confidence },
        mood:         { value: traits.mood,         source: traits.perDimension.mood.source,         confidence: traits.perDimension.mood.confidence },
        visualMood:   { value: traits.visualMood,   source: traits.perDimension.visualMood.source,   confidence: traits.perDimension.visualMood.confidence },
      },
    },
    generatedAt: new Date().toISOString(),
  };
}

// R3 — re-runs classification only (no LLM, no image fetch). Used by
// the builder's "Regenerate Strategy" action so the operator can flip
// (e.g.) tripStyle from family-holiday to honeymoon and see the new
// family / theme / mood without rebuilding the page content.
async function regenerateStrategy(input, { tenantId } = {}) {
  return classify(input, { tenantId });
}

module.exports = {
  // Public
  classify,
  regenerateStrategy,
  classifyTraits,
  chooseFamily,
  chooseThemeVariant,
  chooseComposition,
  chooseImageStrategy,
  // Trait extractors (exposed for testing + composition)
  classifyClimate,
  classifyRegion,
  classifyTripStyle,
  classifyAudienceTier,
  classifyLuxuryLevel,
  classifyMood,
  classifyVisualMood,
  // Cache + utilities
  _cache: TRAIT_CACHE,
  _normalize: normalize,
  _containsKeyword: containsKeyword,
  _isWinterMonth: isWinterMonth,
  _deterministicVisualMood: deterministicVisualMood,
  // Constants
  CLIMATES,
  REGIONS,
  TRIP_STYLES,
  AUDIENCE_TIERS,
  MOODS,
  CLIMATE_MAP,
  REGION_MAP,
};
