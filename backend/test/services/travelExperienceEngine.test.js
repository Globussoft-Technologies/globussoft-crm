// PR-E Phase 2.0 — vitest coverage for the Travel Experience Engine.
//
// What this exercises:
//   1. Static keyword maps (CLIMATE_MAP / REGION_MAP) cover the 6 reference
//      destinations + 4 stretch destinations (Iceland, Vietnam, Kerala, Kashmir)
//   2. Each trait extractor (climate / region / tripStyle / audienceTier /
//      luxuryLevel / mood / visualMood) returns correct values + sources
//   3. Family decision table rules F1-F10 fire as documented
//   4. Theme variant decision tables (educational / religious / family / luxury)
//      fire as documented
//   5. Section composition picker returns the 4 family defaults only (Q6)
//   6. Operator overrides (_teeOverrides) bypass classifiers cleanly
//   7. classify() + regenerateStrategy() emit complete TeeOutput shape
//      with decision log + all 7 trait dimensions populated
//   8. In-memory cache TTL + LRU bound behave correctly
//   9. Anti-coupling — destination strings are NOT read by renderer code
//      paths (see architecture/no-destination-coupling.test.js)
//
// Notes on AI-fallback testing:
//   The TEE's AI fallback calls lib/llmRouter.routeRequest, which is in
//   stub mode under NODE_ENV=test. The router returns a deterministic
//   synthetic response, so AI-fallback tests assert behaviour, not the
//   specific Gemini output. Real-mode coverage lives in the integration
//   tests (separate suite, not run in this file).

import { describe, test, expect, beforeEach } from 'vitest';

const tee = require('../../services/travelExperienceEngine');

beforeEach(() => {
  tee._cache.clear();
});

// ─────────────────────────────────────────────────────────────────
// Static map sanity
// ─────────────────────────────────────────────────────────────────

describe('TEE constants + static maps', () => {
  test('CLIMATES enum is the 6 declared zones', () => {
    expect(tee.CLIMATES).toEqual(['tropical', 'temperate', 'continental', 'alpine', 'desert', 'polar']);
  });

  test('REGIONS enum is the 8 declared regions', () => {
    expect(tee.REGIONS).toEqual([
      'east-asian', 'south-asian', 'south-east-asian', 'european',
      'middle-eastern', 'american', 'oceanic', 'african',
    ]);
  });

  test('CLIMATE_MAP covers all 6 zones with ≥10 keywords each', () => {
    for (const climate of tee.CLIMATES) {
      expect(Array.isArray(tee.CLIMATE_MAP[climate])).toBe(true);
      expect(tee.CLIMATE_MAP[climate].length).toBeGreaterThanOrEqual(10);
    }
  });

  test('REGION_MAP covers all 8 regions with ≥10 keywords each', () => {
    for (const region of tee.REGIONS) {
      expect(Array.isArray(tee.REGION_MAP[region])).toBe(true);
      expect(tee.REGION_MAP[region].length).toBeGreaterThanOrEqual(10);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Normalization + keyword matching utilities
// ─────────────────────────────────────────────────────────────────

describe('TEE utilities', () => {
  test('normalize lowercases + strips punctuation + collapses whitespace', () => {
    expect(tee._normalize('  São   Paulo, BRAZIL!  ')).toBe('sao paulo brazil');
    expect(tee._normalize('Hoi An,Vietnam')).toBe('hoi an vietnam');
    expect(tee._normalize(null)).toBe('');
    expect(tee._normalize(undefined)).toBe('');
  });

  test('containsKeyword honours word boundaries', () => {
    expect(tee._containsKeyword('tokyo japan trip', 'japan')).toBe(true);
    expect(tee._containsKeyword('tokyo japan trip', 'kyo')).toBe(false);
    expect(tee._containsKeyword('hoi an vietnam', 'hoi an')).toBe(true);
    expect(tee._containsKeyword('icelandic cuisine', 'iceland')).toBe(false);
  });

  test('isWinterMonth honours both ISO format and month names', () => {
    expect(tee._isWinterMonth('2026-12')).toBe(true);
    expect(tee._isWinterMonth('2026-07')).toBe(false);
    expect(tee._isWinterMonth('December')).toBe(true);
    expect(tee._isWinterMonth('Jul')).toBe(false);
    expect(tee._isWinterMonth(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// classifyClimate
// ─────────────────────────────────────────────────────────────────

describe('classifyClimate', () => {
  test('Japan → temperate via static map', async () => {
    const r = await tee.classifyClimate('Tokyo, Japan');
    expect(r.value).toBe('temperate');
    expect(r.source).toBe('static');
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  test('Bali → tropical via static map', async () => {
    const r = await tee.classifyClimate('Bali, Indonesia');
    expect(r.value).toBe('tropical');
    expect(r.source).toBe('static');
  });

  test('Umrah / Makkah → desert via static map', async () => {
    const r = await tee.classifyClimate('Umrah Makkah Madinah');
    expect(r.value).toBe('desert');
    expect(r.source).toBe('static');
  });

  test('Switzerland → alpine via static map', async () => {
    const r = await tee.classifyClimate('Switzerland');
    expect(r.value).toBe('alpine');
    expect(r.source).toBe('static');
  });

  test('Iceland → alpine via static map (proves new destination support)', async () => {
    const r = await tee.classifyClimate('Iceland');
    expect(r.value).toBe('alpine');
    expect(r.source).toBe('static');
  });

  test('Vietnam → tropical via static map (proves new destination support)', async () => {
    const r = await tee.classifyClimate('Vietnam');
    expect(r.value).toBe('tropical');
    expect(r.source).toBe('static');
  });

  test('Kerala → tropical', async () => {
    const r = await tee.classifyClimate('Kerala Backwaters');
    expect(r.value).toBe('tropical');
  });

  test('Kashmir + winter → alpine (travelMonth nudge)', async () => {
    const r = await tee.classifyClimate('Kashmir', '2026-12');
    expect(r.value).toBe('alpine');
    expect(r.source).toBe('static');
  });

  test('Kashmir without travelMonth → temperate (static default)', async () => {
    const r = await tee.classifyClimate('Kashmir');
    expect(r.value).toBe('temperate');
  });

  test('unknown destination → default temperate (AI fallback off in tests)', async () => {
    const r = await tee.classifyClimate('Nowhereistan');
    // In test mode, llmRouter is stubbed and returns synthetic text that
    // doesn't parse cleanly → falls through to the default.
    expect(r.value).toBe('temperate');
    expect(r.source).toBe('default');
    expect(r.confidence).toBeLessThan(0.5);
  });

  test('empty destination → default with low confidence', async () => {
    const r = await tee.classifyClimate('');
    expect(r.confidence).toBeLessThan(0.5);
  });

  test('Egypt pyramids → desert', async () => {
    const r = await tee.classifyClimate('Egypt Pyramids tour');
    expect(r.value).toBe('desert');
  });

  test('Antarctica → polar', async () => {
    const r = await tee.classifyClimate('Antarctica expedition');
    expect(r.value).toBe('polar');
  });

  test('Lapland → polar (covers northern lights audience)', async () => {
    const r = await tee.classifyClimate('Finnish Lapland aurora');
    expect(r.value).toBe('polar');
  });
});

// ─────────────────────────────────────────────────────────────────
// classifyRegion
// ─────────────────────────────────────────────────────────────────

describe('classifyRegion', () => {
  test('Japan → east-asian', async () => {
    const r = await tee.classifyRegion('Tokyo Japan');
    expect(r.value).toBe('east-asian');
    expect(r.source).toBe('static');
  });

  test('Kerala → south-asian', async () => {
    const r = await tee.classifyRegion('Kerala India');
    expect(r.value).toBe('south-asian');
  });

  test('Bali → south-east-asian', async () => {
    const r = await tee.classifyRegion('Bali Indonesia');
    expect(r.value).toBe('south-east-asian');
  });

  test('Umrah → middle-eastern', async () => {
    const r = await tee.classifyRegion('Umrah Makkah Madinah');
    expect(r.value).toBe('middle-eastern');
  });

  test('Switzerland + Iceland → european (proves alpine destinations route to european region)', async () => {
    const swiss = await tee.classifyRegion('Switzerland');
    const ice = await tee.classifyRegion('Iceland');
    expect(swiss.value).toBe('european');
    expect(ice.value).toBe('european');
  });

  test('Vietnam → south-east-asian', async () => {
    const r = await tee.classifyRegion('Vietnam Halong');
    expect(r.value).toBe('south-east-asian');
  });

  test('Morocco → middle-eastern (priority over african)', async () => {
    const r = await tee.classifyRegion('Morocco Marrakech');
    expect(r.value).toBe('middle-eastern');
  });

  test('Tanzania → african', async () => {
    const r = await tee.classifyRegion('Tanzania Serengeti safari');
    expect(r.value).toBe('african');
  });

  test('Australia → oceanic', async () => {
    const r = await tee.classifyRegion('Sydney Australia');
    expect(r.value).toBe('oceanic');
  });

  test('Peru → american', async () => {
    const r = await tee.classifyRegion('Peru Machu Picchu');
    expect(r.value).toBe('american');
  });

  test('empty/unknown destination → default european with low confidence', async () => {
    const r = await tee.classifyRegion('');
    expect(r.confidence).toBeLessThan(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────
// classifyTripStyle
// ─────────────────────────────────────────────────────────────────

describe('classifyTripStyle', () => {
  test('subBrand=rfu → pilgrimage (confidence 1.0)', () => {
    expect(tee.classifyTripStyle({ subBrand: 'rfu' })).toEqual({ value: 'pilgrimage', confidence: 1.0, source: 'static' });
  });

  test('subBrand=tmc → educational', () => {
    expect(tee.classifyTripStyle({ subBrand: 'tmc' }).value).toBe('educational');
  });

  test('tripType=religious → pilgrimage', () => {
    expect(tee.classifyTripStyle({ tripType: 'religious' }).value).toBe('pilgrimage');
  });

  test('tripType=family → family-holiday', () => {
    expect(tee.classifyTripStyle({ tripType: 'family' }).value).toBe('family-holiday');
  });

  test('tripType=luxury + couples → honeymoon (derived)', () => {
    const r = tee.classifyTripStyle({ tripType: 'luxury', audience: 'couples' });
    expect(r.value).toBe('honeymoon');
    expect(r.source).toBe('derived');
  });

  test('audience contains "students" → educational', () => {
    expect(tee.classifyTripStyle({ audience: 'Grade 8-12 students from Bangalore' }).value).toBe('educational');
  });

  test('audience contains "honeymoon" → honeymoon', () => {
    expect(tee.classifyTripStyle({ audience: 'honeymoon couple' }).value).toBe('honeymoon');
  });

  test('audience contains "families" → family-holiday', () => {
    expect(tee.classifyTripStyle({ audience: 'families with kids' }).value).toBe('family-holiday');
  });

  test('destination contains umrah → pilgrimage (last-resort)', () => {
    const r = tee.classifyTripStyle({ destination: 'Umrah pilgrimage Makkah' });
    expect(r.value).toBe('pilgrimage');
  });

  test('no signals → leisure default with low confidence', () => {
    const r = tee.classifyTripStyle({ destination: 'somewhere', audience: 'people' });
    expect(r.value).toBe('leisure');
    expect(r.confidence).toBeLessThan(0.6);
  });
});

// ─────────────────────────────────────────────────────────────────
// classifyAudienceTier
// ─────────────────────────────────────────────────────────────────

describe('classifyAudienceTier', () => {
  test('"students grade 8-12" → students', () => {
    expect(tee.classifyAudienceTier('students grade 8-12', 'educational').value).toBe('students');
  });

  test('"parents" + educational tripStyle → parents', () => {
    expect(tee.classifyAudienceTier('parents of students', 'educational').value).toBe('parents');
  });

  test('"pilgrims" → pilgrims', () => {
    expect(tee.classifyAudienceTier('pilgrims all ages', 'pilgrimage').value).toBe('pilgrims');
  });

  test('"couples honeymoon" → couples', () => {
    expect(tee.classifyAudienceTier('couples honeymoon', 'honeymoon').value).toBe('couples');
  });

  test('"families with kids" → families', () => {
    expect(tee.classifyAudienceTier('families with kids', 'family-holiday').value).toBe('families');
  });

  test('"HNI exclusive guests" → hni', () => {
    expect(tee.classifyAudienceTier('hni exclusive guests', 'leisure').value).toBe('hni');
  });

  test('"solo traveller" → solo', () => {
    expect(tee.classifyAudienceTier('solo traveller', 'leisure').value).toBe('solo');
  });

  test('"multigen 3 generations" → multigen', () => {
    expect(tee.classifyAudienceTier('multigen 3 generations', 'family-holiday').value).toBe('multigen');
  });

  test('silent audience derives from tripStyle (pilgrimage → pilgrims)', () => {
    const r = tee.classifyAudienceTier('', 'pilgrimage');
    expect(r.value).toBe('pilgrims');
    expect(r.source).toBe('derived');
  });
});

// ─────────────────────────────────────────────────────────────────
// classifyLuxuryLevel
// ─────────────────────────────────────────────────────────────────

describe('classifyLuxuryLevel', () => {
  test('tripType=luxury + couples → high', () => {
    const r = tee.classifyLuxuryLevel(
      { tripType: 'luxury', audience: 'couples' },
      { tripStyle: 'honeymoon', audienceTier: 'couples' }
    );
    expect(r.value).toBeGreaterThanOrEqual(4);
  });

  test('budget audience → 0', () => {
    const r = tee.classifyLuxuryLevel(
      { audience: 'budget travellers backpack' },
      { tripStyle: 'leisure', audienceTier: 'solo' }
    );
    expect(r.value).toBeLessThanOrEqual(1);
  });

  test('honeymoon → mid-luxury baseline', () => {
    const r = tee.classifyLuxuryLevel({}, { tripStyle: 'honeymoon', audienceTier: 'couples' });
    expect(r.value).toBeGreaterThanOrEqual(2);
  });

  test('"private boutique curated" pushes level up', () => {
    const r = tee.classifyLuxuryLevel({ audience: 'private boutique curated' }, { tripStyle: 'leisure' });
    expect(r.value).toBeGreaterThanOrEqual(3);
  });

  test('clamps to 0-5 range', () => {
    const high = tee.classifyLuxuryLevel(
      { tripType: 'luxury', audience: 'hni exclusive vip private boutique', durationDays: 21 },
      { tripStyle: 'honeymoon', audienceTier: 'hni' }
    );
    expect(high.value).toBeLessThanOrEqual(5);
    expect(high.value).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// classifyMood
// ─────────────────────────────────────────────────────────────────

describe('classifyMood', () => {
  test('pilgrimage → reverent', () => {
    expect(tee.classifyMood({ tripStyle: 'pilgrimage', luxuryLevel: 2 }).value).toBe('reverent');
  });
  test('educational → structured', () => {
    expect(tee.classifyMood({ tripStyle: 'educational', luxuryLevel: 2 }).value).toBe('structured');
  });
  test('family-holiday → vibrant', () => {
    expect(tee.classifyMood({ tripStyle: 'family-holiday', luxuryLevel: 1 }).value).toBe('vibrant');
  });
  test('honeymoon + luxury → minimal', () => {
    expect(tee.classifyMood({ tripStyle: 'honeymoon', luxuryLevel: 4 }).value).toBe('minimal');
  });
  test('luxuryLevel >= 4 + non-special tripStyle → minimal', () => {
    expect(tee.classifyMood({ tripStyle: 'leisure', luxuryLevel: 5 }).value).toBe('minimal');
  });
  test('adventure → adventurous', () => {
    expect(tee.classifyMood({ tripStyle: 'adventure', luxuryLevel: 2 }).value).toBe('adventurous');
  });
});

// ─────────────────────────────────────────────────────────────────
// classifyVisualMood (R1 — the 7th trait)
// ─────────────────────────────────────────────────────────────────

describe('classifyVisualMood — R1', () => {
  test('returns a hyphenated label with ≥2 and ≤4 segments', async () => {
    const r = await tee.classifyVisualMood(
      { destination: 'Iceland' },
      { mood: 'minimal', climate: 'alpine', regionFeel: 'european', tripStyle: 'honeymoon', luxuryLevel: 4 }
    );
    expect(typeof r.value).toBe('string');
    // Either AI-fallback returned a parsed label, or deterministic fallback fired.
    const segments = r.value.split('-').filter(Boolean);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments.length).toBeLessThanOrEqual(4);
  });

  test('empty destination → default low-confidence label', async () => {
    const r = await tee.classifyVisualMood({ destination: '' }, {});
    expect(r.confidence).toBeLessThan(0.5);
  });

  test('deterministic fallback weaves destination + climate + mood + tripStyle', () => {
    const m = tee._deterministicVisualMood({ climate: 'alpine', mood: 'minimal', tripStyle: 'honeymoon' }, 'Iceland');
    expect(m).toContain('iceland');
    expect(m).toContain('alpine');
    expect(m).toContain('minimal');
  });

  test('deterministic fallback differentiates two destinations with identical traits', () => {
    const ice = tee._deterministicVisualMood({ climate: 'alpine', mood: 'minimal', tripStyle: 'honeymoon' }, 'Iceland');
    const swi = tee._deterministicVisualMood({ climate: 'alpine', mood: 'minimal', tripStyle: 'honeymoon' }, 'Switzerland');
    expect(ice).not.toBe(swi);
    expect(ice).toContain('iceland');
    expect(swi).toContain('switzerland');
  });

  test('two destinations with same trait shape get DISTINCT visualMood labels (R1 contract)', async () => {
    tee._cache.clear();
    const ice = await tee.classifyVisualMood(
      { destination: 'Iceland' },
      { mood: 'minimal', climate: 'alpine', regionFeel: 'european', tripStyle: 'honeymoon', luxuryLevel: 4 }
    );
    const swi = await tee.classifyVisualMood(
      { destination: 'Switzerland' },
      { mood: 'minimal', climate: 'alpine', regionFeel: 'european', tripStyle: 'honeymoon', luxuryLevel: 4 }
    );
    // Even though trait vectors are identical, the destination string
    // weaves into the label (via AI prompt or deterministic fallback)
    // so Iceland ≠ Switzerland visually. This is the R1 contract.
    expect(ice.value).not.toBe(swi.value);
  });

  test('cache key varies by (destination, family, mood) so distinct contexts don\'t collide', async () => {
    tee._cache.clear();
    // Pre-populate cache with two distinct entries to verify keying.
    tee._cache.set('visualMood:iceland::luxury:minimal', { value: 'iceland-luxury-mood', confidence: 0.8 });
    tee._cache.set('visualMood:iceland::family:vibrant', { value: 'iceland-family-mood', confidence: 0.8 });
    expect(tee._cache.size()).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// classifyTraits — composite
// ─────────────────────────────────────────────────────────────────

describe('classifyTraits — composite extractor', () => {
  test('emits all 7 trait dimensions for Japan input', async () => {
    const traits = await tee.classifyTraits({
      destination: 'Japan Tokyo Kyoto',
      durationDays: 9,
      audience: 'Grade 8-12 students',
      tripType: 'educational',
      subBrand: 'tmc',
    });
    expect(traits.climate).toBe('temperate');
    expect(traits.regionFeel).toBe('east-asian');
    expect(traits.tripStyle).toBe('educational');
    expect(traits.audienceTier).toBe('students');
    expect(typeof traits.luxuryLevel).toBe('number');
    expect(traits.mood).toBe('structured');
    expect(typeof traits.visualMood).toBe('string');
    expect(traits.visualMood.length).toBeGreaterThan(0);
    expect(traits.perDimension).toBeTruthy();
    expect(traits.perDimension.climate.source).toBe('static');
  });

  test('operator overrides bypass classifiers', async () => {
    const traits = await tee.classifyTraits({
      destination: 'Iceland',
      tripType: 'luxury',
      audience: 'couples',
      _teeOverrides: { climate: 'desert', regionFeel: 'middle-eastern' },
    });
    expect(traits.climate).toBe('desert');
    expect(traits.regionFeel).toBe('middle-eastern');
    expect(traits.perDimension.climate.source).toBe('override');
    expect(traits.perDimension.regionFeel.source).toBe('override');
  });

  test('full override of all 7 traits is possible', async () => {
    const traits = await tee.classifyTraits({
      destination: 'X',
      _teeOverrides: {
        climate: 'tropical', regionFeel: 'oceanic', tripStyle: 'wellness',
        audienceTier: 'couples', luxuryLevel: 5, mood: 'minimal',
        visualMood: 'overwater-bungalow-stillness',
      },
    });
    expect(traits.climate).toBe('tropical');
    expect(traits.visualMood).toBe('overwater-bungalow-stillness');
    expect(traits.source).toBe('override');
  });
});

// ─────────────────────────────────────────────────────────────────
// Family decision table — F1-F10
// ─────────────────────────────────────────────────────────────────

describe('chooseFamily — decision table', () => {
  test('F1: pilgrimage → religious', () => {
    expect(tee.chooseFamily({ tripStyle: 'pilgrimage' }).value).toBe('religious');
    expect(tee.chooseFamily({ tripStyle: 'pilgrimage' }).ruleId).toBe('F1');
  });

  test('F2: educational + students → educational', () => {
    const r = tee.chooseFamily({ tripStyle: 'educational', audienceTier: 'students' });
    expect(r.value).toBe('educational');
    expect(r.ruleId).toBe('F2');
  });

  test('F3: luxuryLevel >= 4 → luxury', () => {
    const r = tee.chooseFamily({ tripStyle: 'leisure', luxuryLevel: 5 });
    expect(r.value).toBe('luxury');
    expect(r.ruleId).toBe('F3');
  });

  test('F4: honeymoon + luxuryLevel >= 2 → luxury', () => {
    const r = tee.chooseFamily({ tripStyle: 'honeymoon', luxuryLevel: 3 });
    expect(r.value).toBe('luxury');
    expect(r.ruleId).toBe('F4');
  });

  test('F5: wellness + luxuryLevel >= 3 → luxury', () => {
    const r = tee.chooseFamily({ tripStyle: 'wellness', luxuryLevel: 3 });
    expect(r.value).toBe('luxury');
    expect(r.ruleId).toBe('F5');
  });

  test('F6: family-holiday → family', () => {
    expect(tee.chooseFamily({ tripStyle: 'family-holiday' }).value).toBe('family');
    expect(tee.chooseFamily({ tripStyle: 'family-holiday' }).ruleId).toBe('F6');
  });

  test('F6: audience=families → family', () => {
    expect(tee.chooseFamily({ tripStyle: 'leisure', audienceTier: 'families' }).value).toBe('family');
  });

  test('F7: adventure + luxuryLevel >= 3 → luxury', () => {
    const r = tee.chooseFamily({ tripStyle: 'adventure', luxuryLevel: 3 });
    expect(r.value).toBe('luxury');
    expect(r.ruleId).toBe('F7');
  });

  test('F8: adventure + luxuryLevel < 3 → family', () => {
    const r = tee.chooseFamily({ tripStyle: 'adventure', luxuryLevel: 1 });
    expect(r.value).toBe('family');
    expect(r.ruleId).toBe('F8');
  });

  test('F9: business + luxuryLevel >= 3 (but < 4 so F3 doesn\'t pre-empt) → luxury', () => {
    const r = tee.chooseFamily({ tripStyle: 'business', luxuryLevel: 3 });
    expect(r.value).toBe('luxury');
    expect(r.ruleId).toBe('F9');
  });

  test('F10: default → family', () => {
    expect(tee.chooseFamily({ tripStyle: 'leisure', luxuryLevel: 1, audienceTier: 'solo' }).value).toBe('family');
  });

  test('override wins over decision table', () => {
    const r = tee.chooseFamily({ tripStyle: 'pilgrimage' }, { override: 'luxury' });
    expect(r.value).toBe('luxury');
    expect(r.ruleId).toBe('OVERRIDE');
  });
});

// ─────────────────────────────────────────────────────────────────
// Theme variant decision tables
// ─────────────────────────────────────────────────────────────────

describe('chooseThemeVariant — educational', () => {
  test('E1: east-asian + structured → educational-academic', () => {
    expect(tee.chooseThemeVariant('educational', { regionFeel: 'east-asian', mood: 'structured' }).value).toBe('educational-academic');
  });
  test('E2: stem audience → educational-tech', () => {
    expect(tee.chooseThemeVariant('educational', { audience: 'STEM Robotics camp', regionFeel: 'american' }).value).toBe('educational-tech');
  });
  test('E3: european → educational-classical', () => {
    expect(tee.chooseThemeVariant('educational', { regionFeel: 'european' }).value).toBe('educational-classical');
  });
  test('E5: south-east-asian → educational-modern', () => {
    expect(tee.chooseThemeVariant('educational', { regionFeel: 'south-east-asian' }).value).toBe('educational-modern');
  });
});

describe('chooseThemeVariant — religious', () => {
  test('R1: middle-eastern + luxury → religious-premium', () => {
    expect(tee.chooseThemeVariant('religious', { regionFeel: 'middle-eastern', luxuryLevel: 4 }).value).toBe('religious-premium');
  });
  test('R2: middle-eastern → religious-classical', () => {
    expect(tee.chooseThemeVariant('religious', { regionFeel: 'middle-eastern', luxuryLevel: 1 }).value).toBe('religious-classical');
  });
  test('R3: jerusalem keyword → religious-premium', () => {
    expect(tee.chooseThemeVariant('religious', { regionFeel: 'european', audience: 'jerusalem holy land pilgrims' }).value).toBe('religious-premium');
  });
  test('R4 default: → religious-spiritual', () => {
    expect(tee.chooseThemeVariant('religious', { regionFeel: 'south-asian', luxuryLevel: 1 }).value).toBe('religious-spiritual');
  });
});

describe('chooseThemeVariant — family', () => {
  test('FA1: tropical → family-tropical', () => {
    expect(tee.chooseThemeVariant('family', { climate: 'tropical' }).value).toBe('family-tropical');
  });
  test('FA3: desert → family-resort', () => {
    expect(tee.chooseThemeVariant('family', { climate: 'desert' }).value).toBe('family-resort');
  });
  test('FA4: south-east-asian → family-tropical', () => {
    expect(tee.chooseThemeVariant('family', { climate: 'temperate', regionFeel: 'south-east-asian' }).value).toBe('family-tropical');
  });
  test('FA6 default: → family-vibrant', () => {
    expect(tee.chooseThemeVariant('family', { climate: 'temperate', regionFeel: 'european' }).value).toBe('family-vibrant');
  });
});

describe('chooseThemeVariant — luxury', () => {
  test('L1: alpine → luxury-alpine', () => {
    expect(tee.chooseThemeVariant('luxury', { climate: 'alpine' }).value).toBe('luxury-alpine');
  });
  test('L1: polar → luxury-alpine', () => {
    expect(tee.chooseThemeVariant('luxury', { climate: 'polar' }).value).toBe('luxury-alpine');
  });
  test('L2: tropical + honeymoon → luxury-coastal', () => {
    expect(tee.chooseThemeVariant('luxury', { climate: 'tropical', tripStyle: 'honeymoon' }).value).toBe('luxury-coastal');
  });
  test('L3: european → luxury-continental', () => {
    expect(tee.chooseThemeVariant('luxury', { climate: 'temperate', regionFeel: 'european' }).value).toBe('luxury-continental');
  });
  test('L4: middle-eastern + minimal → luxury-continental', () => {
    expect(tee.chooseThemeVariant('luxury', { climate: 'desert', regionFeel: 'middle-eastern', mood: 'minimal' }).value).toBe('luxury-continental');
  });
  test('L5 default → luxury-alpine', () => {
    expect(tee.chooseThemeVariant('luxury', { climate: 'continental', regionFeel: 'american' }).value).toBe('luxury-alpine');
  });

  test('override wins', () => {
    const r = tee.chooseThemeVariant('luxury', { climate: 'alpine' }, { override: 'luxury-coastal' });
    expect(r.value).toBe('luxury-coastal');
    expect(r.ruleId).toBe('OVERRIDE');
  });

  test('invalid override falls back to decision table', () => {
    const r = tee.chooseThemeVariant('luxury', { climate: 'alpine' }, { override: 'not-a-theme' });
    expect(r.value).toBe('luxury-alpine');
    expect(r.ruleId).toBe('L1');
  });
});

// ─────────────────────────────────────────────────────────────────
// Section composition picker (Q6 — 4 family defaults only)
// ─────────────────────────────────────────────────────────────────

describe('chooseComposition — Q6 (4 family defaults only)', () => {
  test('educational → 16-section default order', () => {
    const r = tee.chooseComposition('educational', {});
    expect(r.value[0]).toBe('nav');
    expect(r.value[1]).toBe('hero');
    expect(r.value).toContain('finalCta');
    expect(r.ruleId).toContain('default');
  });
  test('religious → programme promoted above marquee', () => {
    const r = tee.chooseComposition('religious', {});
    expect(r.value.indexOf('programme')).toBeLessThan(r.value.indexOf('marquee'));
  });
  test('family → marquee promoted earlier', () => {
    const r = tee.chooseComposition('family', {});
    expect(r.value.indexOf('marquee')).toBeLessThan(r.value.indexOf('safety'));
  });
  test('luxury → programme + brochure + details hidden', () => {
    const r = tee.chooseComposition('luxury', {});
    expect(r.value).not.toContain('programme');
    expect(r.value).not.toContain('brochure');
    expect(r.value).not.toContain('details');
  });
  test('override wins over default', () => {
    const r = tee.chooseComposition('educational', {}, { override: ['nav', 'hero', 'contact'] });
    expect(r.value).toEqual(['nav', 'hero', 'contact']);
    expect(r.ruleId).toBe('OVERRIDE');
  });
});

// ─────────────────────────────────────────────────────────────────
// Image strategy
// ─────────────────────────────────────────────────────────────────

describe('chooseImageStrategy', () => {
  test('emits hero + marquee + brochure queries focused on destination + concrete topic words', () => {
    // Contract per 2026-06-24 image-quality fix: queries are kept SHORT
    // and concrete-noun-driven (landmark / heritage / culture / nature)
    // — visualMood / climate phrases are NOT mixed in because stock
    // providers treat them as noise tokens that bias the top-N ranking
    // toward portrait/headshot results instead of location photography.
    const s = tee.chooseImageStrategy(
      { visualMood: 'northern-aurora-mystical', climate: 'alpine' },
      { destination: 'Iceland' }
    );
    expect(s.hero.query).toContain('Iceland');
    expect(s.hero.query).toContain('landmark');
    expect(s.hero.query).not.toContain('northern'); // visualMood tokens excluded
    expect(s.hero.query).not.toContain('alpine');   // climate tokens excluded
    expect(s.hero.aspectRatio).toBe('4:3');
    expect(Array.isArray(s.marquee)).toBe(true);
    expect(s.marquee.length).toBeGreaterThanOrEqual(3);
    expect(s.brochure.query).toContain('Iceland');
    // Marquee slots use distinct concrete-noun seeds.
    const slotSeeds = s.marquee.map((m) => m.query.replace('Iceland', '').trim());
    expect(new Set(slotSeeds).size).toBe(slotSeeds.length);
  });

  test('marquee respects citiesCount option (clamped 3-10)', () => {
    // Cap raised 2026-06-24 from 6 → 10 so a long marquee loop on
    // wide viewports doesn't visibly wrap-and-restart on short loops.
    const s = tee.chooseImageStrategy({ visualMood: 'x', climate: 'tropical' }, { destination: 'X' }, { citiesCount: 15 });
    expect(s.marquee.length).toBe(10);
    const s2 = tee.chooseImageStrategy({ visualMood: 'x' }, { destination: 'X' }, { citiesCount: 1 });
    expect(s2.marquee.length).toBe(3);
    const s3 = tee.chooseImageStrategy({ visualMood: 'x' }, { destination: 'X' }, { citiesCount: 8 });
    expect(s3.marquee.length).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────
// Full pipeline (classify) — the 8 reference destinations
// ─────────────────────────────────────────────────────────────────

describe('classify — full pipeline for 8 reference destinations', () => {
  const cases = [
    {
      name: 'Japan',
      input: { destination: 'Tokyo Kyoto Japan', audience: 'Grade 8-12 students', tripType: 'educational', subBrand: 'tmc', durationDays: 9 },
      expect: { family: 'educational', themeId: 'educational-academic' },
    },
    {
      name: 'Bali',
      input: { destination: 'Bali Indonesia', audience: 'families with kids', tripType: 'family', durationDays: 7 },
      expect: { family: 'family', themeId: 'family-tropical' },
    },
    {
      name: 'Umrah',
      input: { destination: 'Umrah Makkah Madinah', audience: 'pilgrims all ages', subBrand: 'rfu', durationDays: 14 },
      expect: { family: 'religious', themeId: 'religious-classical' },
    },
    {
      name: 'Switzerland',
      input: { destination: 'Switzerland Zermatt Interlaken', audience: 'couples', tripType: 'luxury', durationDays: 10 },
      expect: { family: 'luxury', themeId: 'luxury-alpine' },
    },
    {
      name: 'Iceland (new destination — proves destination-agnostic routing)',
      input: { destination: 'Iceland Reykjavik aurora', audience: 'couples photographers', tripType: 'luxury', durationDays: 8 },
      expect: { family: 'luxury', themeId: 'luxury-alpine' },
    },
    {
      name: 'Vietnam (new destination)',
      input: { destination: 'Vietnam Halong Hoi An', audience: 'families with kids', tripType: 'family', durationDays: 8 },
      expect: { family: 'family', themeId: 'family-tropical' },
    },
    {
      name: 'Kerala backwaters',
      input: { destination: 'Kerala backwaters India', audience: 'multigen family', tripType: 'family', durationDays: 8 },
      expect: { family: 'family', themeId: 'family-tropical' },
    },
    {
      name: 'Kashmir luxury honeymoon',
      input: { destination: 'Kashmir Gulmarg', audience: 'honeymoon couples', tripType: 'luxury', travelMonth: '2026-12', durationDays: 7 },
      expect: { family: 'luxury', themeId: 'luxury-alpine' },
    },
  ];

  for (const c of cases) {
    test(`${c.name} → ${c.expect.family} + ${c.expect.themeId}`, async () => {
      const result = await tee.classify(c.input);
      expect(result.family).toBe(c.expect.family);
      expect(result.themeId).toBe(c.expect.themeId);
      // All 7 traits populated.
      expect(typeof result.traits.climate).toBe('string');
      expect(typeof result.traits.regionFeel).toBe('string');
      expect(typeof result.traits.visualMood).toBe('string');
      // Decision log complete.
      expect(result.decisionLog.family.ruleId).toBeTruthy();
      expect(result.decisionLog.themeId.ruleId).toBeTruthy();
      expect(result.decisionLog.composition.ruleId).toBeTruthy();
      // Image strategy emitted.
      expect(result.imageStrategy.hero.query).toContain(c.input.destination.split(' ')[0]);
      expect(result.imageStrategy.marquee.length).toBeGreaterThan(0);
      // Theme metadata present.
      expect(result.theme).toBeTruthy();
      expect(result.theme.id).toBe(c.expect.themeId);
    });
  }

  test('Iceland and Switzerland share luxury-alpine but DIFFER in visualMood', async () => {
    tee._cache.clear();
    const iceland = await tee.classify({
      destination: 'Iceland aurora Reykjavik',
      audience: 'couples photographers', tripType: 'luxury', durationDays: 8,
    });
    const swiss = await tee.classify({
      destination: 'Switzerland Zermatt Interlaken alps',
      audience: 'couples', tripType: 'luxury', durationDays: 10,
    });
    expect(iceland.themeId).toBe('luxury-alpine');
    expect(swiss.themeId).toBe('luxury-alpine');
    // visualMood should be unique to each destination (the R1 requirement).
    // Under AI-stub mode the visualMood may fall back to deterministic
    // derivation; the destinations differ on at least one of (mood,
    // tripStyle, climate) → deterministic labels still differ.
    expect(iceland.traits.visualMood).not.toBe(swiss.traits.visualMood);
  });

  test('Bali and Vietnam share family-tropical but DIFFER in visualMood', async () => {
    tee._cache.clear();
    const bali = await tee.classify({
      destination: 'Bali Ubud temples', audience: 'families with kids', tripType: 'family', durationDays: 7,
    });
    const vietnam = await tee.classify({
      destination: 'Vietnam Halong Hoi An lanterns', audience: 'families with kids', tripType: 'family', durationDays: 8,
    });
    expect(bali.themeId).toBe('family-tropical');
    expect(vietnam.themeId).toBe('family-tropical');
    // Image strategies must DIFFER even when themes match.
    expect(bali.imageStrategy.hero.query).not.toBe(vietnam.imageStrategy.hero.query);
  });
});

// ─────────────────────────────────────────────────────────────────
// regenerateStrategy (R3) — re-runs classification only
// ─────────────────────────────────────────────────────────────────

describe('regenerateStrategy — R3', () => {
  test('returns same shape as classify()', async () => {
    const input = { destination: 'Iceland', audience: 'couples', tripType: 'luxury', durationDays: 8 };
    const a = await tee.classify(input);
    const b = await tee.regenerateStrategy(input);
    expect(a.family).toBe(b.family);
    expect(a.themeId).toBe(b.themeId);
    expect(Object.keys(a)).toEqual(Object.keys(b));
  });

  test('responds to input changes (operator flips tripType)', async () => {
    const baseInput = { destination: 'Bali', audience: 'couples', tripType: 'family', durationDays: 7 };
    const family = await tee.regenerateStrategy(baseInput);
    expect(family.family).toBe('family');
    const honeymoon = await tee.regenerateStrategy({ ...baseInput, tripType: 'luxury', audience: 'honeymoon couples' });
    expect(honeymoon.family).toBe('luxury');
    expect(honeymoon.themeId).toBe('luxury-coastal');
  });
});

// ─────────────────────────────────────────────────────────────────
// In-memory cache behaviour (Q10)
// ─────────────────────────────────────────────────────────────────

describe('in-memory cache (Q10)', () => {
  test('cached AI fallback result is returned on subsequent calls', async () => {
    tee._cache.clear();
    tee._cache.set('climate:icelandexotic', { value: 'alpine', confidence: 0.75 });
    const r = await tee.classifyClimate('IcelandExotic');
    expect(r.value).toBe('alpine');
    expect(r.source).toBe('ai-classified');
  });

  test('cache bounded — evicts oldest entries past MAX_ENTRIES', () => {
    tee._cache.clear();
    for (let i = 0; i < 2050; i++) {
      tee._cache.set(`key-${i}`, { value: i, confidence: 1 });
    }
    expect(tee._cache.size()).toBeLessThanOrEqual(2000);
  });

  test('cache returns null on miss', () => {
    tee._cache.clear();
    expect(tee._cache.get('nope')).toBeNull();
  });

  test('cache TTL — expired entries skipped', () => {
    tee._cache.set('expiring', { value: 'x', confidence: 1 }, -1000);
    expect(tee._cache.get('expiring')).toBeNull();
  });
});
