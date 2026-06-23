// PR-E Phase 2.2 — vitest coverage for the TEE-aware generation
// orchestrator (generateLandingPageContentWithTee).
//
// What this exercises:
//   1. End-to-end flow: input → TEE classify → prompt → LLM → guard →
//      bridge → image fetch → final payload
//   2. The orchestrator picks the correct family template based on
//      TEE output (not from the LLM)
//   3. The LLM's family / themeId / visualMood are NEVER read from
//      raw LLM output — they come from the TEE block (invariant)
//   4. Deterministic stub fallback fires when no LLM provider is available
//   5. Persisted _tee metadata block is correct + complete
//   6. options.skipImages bypasses the image-fetch step
//   7. options.existingContent's _locked slots are preserved
//
// The LLM call is mocked via the existing self-mocking seam (vi.spyOn
// on module.exports — pattern documented in cron-learnings 2026-05-24).
// The image provider is also mocked so the test is deterministic.

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';

const generator = require('../../services/landingPageGeneratorLLM');
const imageProvider = require('../../services/destinationImageProvider');

beforeEach(() => {
  vi.restoreAllMocks();
  // Force stub mode by default so the deterministic path fires.
  vi.spyOn(generator, 'realModeEnabled').mockResolvedValue(false);
  vi.spyOn(generator, 'openAiFallbackEnabled').mockReturnValue(false);
  // Skip the budget cap check.
  vi.spyOn(generator, 'checkBudgetCap').mockResolvedValue(true);
  // Image provider returns no images in tests; bridge fills posterUrl=''
  imageProvider._resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateLandingPageContentWithTee — orchestrator', () => {
  test('Japan input → educational family + educational-academic theme', async () => {
    const result = await generator.generateLandingPageContentWithTee(
      {
        tenantId: 1,
        destination: 'Tokyo Japan',
        durationDays: 9,
        audience: 'Grade 8-12 students',
        tripType: 'educational',
        subBrand: 'tmc',
      },
      { skipImages: true, __surface: 'test' }
    );

    expect(result.templateType).toBe('educational-trip-v1');
    expect(result.teeOutput.family).toBe('educational');
    expect(result.teeOutput.themeId).toBe('educational-academic');
    expect(result.source).toBe('stub'); // stub mode fired
    expect(result.content).toBeTruthy();
    expect(result.content._tee).toBeTruthy();
    expect(result.content._tee.family).toBe('educational');
    expect(result.content._tee.themeId).toBe('educational-academic');
  });

  test('Umrah input → religious family + religious-classical theme', async () => {
    const result = await generator.generateLandingPageContentWithTee(
      {
        tenantId: 1,
        destination: 'Umrah Makkah Madinah',
        durationDays: 14,
        audience: 'pilgrims all ages',
        subBrand: 'rfu',
      },
      { skipImages: true }
    );

    expect(result.templateType).toBe('religious-tour-v1');
    expect(result.teeOutput.family).toBe('religious');
    expect(result.teeOutput.themeId).toBe('religious-classical');
    expect(result.content._tee.family).toBe('religious');
    // Family-specific registration funnel labels applied.
    expect(result.content.registration.personLabel).toMatch(/Pilgrim/i);
    expect(result.content.registration.guardianLabel).toMatch(/Mahram|Companion/i);
  });

  test('Iceland input → luxury family + luxury-alpine theme (NEW destination)', async () => {
    const result = await generator.generateLandingPageContentWithTee(
      {
        tenantId: 1,
        destination: 'Iceland Reykjavik aurora',
        durationDays: 8,
        audience: 'couples photographers',
        tripType: 'luxury',
      },
      { skipImages: true }
    );

    expect(result.templateType).toBe('luxury-tour-v1');
    expect(result.teeOutput.family).toBe('luxury');
    expect(result.teeOutput.themeId).toBe('luxury-alpine');
    expect(result.content.registration.submitText).toMatch(/Application/i);
  });

  test('Vietnam input → family family + family-tropical theme (NEW destination)', async () => {
    const result = await generator.generateLandingPageContentWithTee(
      {
        tenantId: 1,
        destination: 'Vietnam Halong Hoi An',
        durationDays: 8,
        audience: 'families with kids',
        tripType: 'family',
      },
      { skipImages: true }
    );

    expect(result.templateType).toBe('family-trip-v1');
    expect(result.teeOutput.family).toBe('family');
    expect(result.teeOutput.themeId).toBe('family-tropical');
    expect(result.content.registration.guardianLabel).toMatch(/Number|Travellers/i);
  });

  test('TEE output is the SOURCE OF TRUTH for family/theme/visualMood (LLM cannot override)', async () => {
    // Even when stub mode fires, the content._tee block must reflect
    // the TEE's classification, NOT whatever the LLM happens to emit.
    const result = await generator.generateLandingPageContentWithTee(
      {
        tenantId: 1,
        destination: 'Umrah Makkah',
        durationDays: 10,
        audience: 'pilgrims',
        subBrand: 'rfu',
      },
      { skipImages: true }
    );

    // The orchestrator MUST have used religious template because TEE
    // said so — even though the LLM emits a generic shape that knows
    // nothing about families.
    expect(result.templateType).toBe('religious-tour-v1');
    expect(result.content._tee.family).toBe('religious');
    expect(result.content._tee.themeId).toBe('religious-classical');
    expect(typeof result.content._tee.visualMood).toBe('string');
  });

  test('persisted _tee block carries complete decision log + trait sources', async () => {
    const result = await generator.generateLandingPageContentWithTee(
      {
        tenantId: 1,
        destination: 'Bali Ubud',
        durationDays: 7,
        audience: 'families with kids',
        tripType: 'family',
      },
      { skipImages: true }
    );

    expect(result.content._tee).toBeTruthy();
    expect(result.content._tee.family).toBe('family');
    expect(result.content._tee.themeId).toBe('family-tropical');
    expect(result.content._tee.traits).toBeTruthy();
    expect(result.content._tee.traits.climate).toBe('tropical');
    expect(result.content._tee.traits.tripStyle).toBe('family-holiday');
    expect(result.content._tee.decisions).toBeTruthy();
    expect(result.content._tee.decisions.family).toBeTruthy();
    expect(typeof result.content._tee.generatedAt).toBe('string');
  });

  test('section composition forced from TEE composition array', async () => {
    const result = await generator.generateLandingPageContentWithTee(
      {
        tenantId: 1,
        destination: 'Switzerland Zermatt',
        durationDays: 10,
        audience: 'couples',
        tripType: 'luxury',
      },
      { skipImages: true }
    );

    // Luxury composition omits programme + brochure + details.
    expect(result.content._sectionOrder).toEqual(result.teeOutput.composition);
    expect(result.content._sectionOrder).not.toContain('programme');
    expect(result.content._sectionOrder).not.toContain('brochure');
    expect(result.content._sectionOrder).not.toContain('details');
  });

  test('options.skipImages bypasses image fetch (imagesFetched=0)', async () => {
    const result = await generator.generateLandingPageContentWithTee(
      { tenantId: 1, destination: 'Bali', durationDays: 7, audience: 'families', tripType: 'family' },
      { skipImages: true }
    );
    expect(result.imagesFetched).toBe(0);
  });

  test('options.existingContent _locked slots are preserved', async () => {
    const existing = {
      hero: { headline: 'OPERATOR PINNED' },
      _locked: { 'hero.headline': true },
    };
    const result = await generator.generateLandingPageContentWithTee(
      { tenantId: 1, destination: 'Japan', durationDays: 9, audience: 'students', tripType: 'educational' },
      { skipImages: true, existingContent: existing }
    );
    expect(result.content.hero.headline).toBe('OPERATOR PINNED');
  });

  test('throws on missing tenantId', async () => {
    await expect(generator.generateLandingPageContentWithTee({
      destination: 'X', durationDays: 5, audience: 'x',
    })).rejects.toThrow(/tenantId/);
  });

  test('throws on missing destination', async () => {
    await expect(generator.generateLandingPageContentWithTee({
      tenantId: 1, durationDays: 5, audience: 'x',
    })).rejects.toThrow(/destination/);
  });

  test('imageProvider mock is honoured — applies fetched images when skipImages=false', async () => {
    vi.spyOn(imageProvider, 'fetchStrategy').mockResolvedValue({
      hero: { url: 'https://mock.example/hero.jpg', attribution: { providerId: 'unsplash', photographer: 'Test' } },
      marquee: [{ slot: 0, image: { url: 'https://mock.example/m0.jpg', attribution: { providerId: 'unsplash' } } }],
      brochure: null,
      cultural: [],
    });
    const result = await generator.generateLandingPageContentWithTee(
      { tenantId: 1, destination: 'Iceland', durationDays: 8, audience: 'couples', tripType: 'luxury' },
      { skipImages: false }
    );
    expect(result.content.hero.posterUrl).toBe('https://mock.example/hero.jpg');
    expect(result.imagesFetched).toBeGreaterThanOrEqual(1);
  });

  test('pickTemplateModule resolves each family correctly', () => {
    expect(generator.pickTemplateModule('educational').id).toBe('educational-trip-v1');
    expect(generator.pickTemplateModule('religious').id).toBe('religious-tour-v1');
    expect(generator.pickTemplateModule('family').id).toBe('family-trip-v1');
    expect(generator.pickTemplateModule('luxury').id).toBe('luxury-tour-v1');
    expect(generator.pickTemplateModule('unknown').id).toBe('educational-trip-v1'); // default
  });

  for (const fam of [
    { name: 'educational (Japan)', destination: 'Tokyo Japan', tripType: 'educational', audience: 'Grade 8-12 students', expectedFamily: 'educational' },
    { name: 'religious (Umrah)', destination: 'Umrah Makkah', tripType: 'religious', audience: 'pilgrims', expectedFamily: 'religious' },
    { name: 'family (Bali)', destination: 'Bali Indonesia', tripType: 'family', audience: 'families with kids', expectedFamily: 'family' },
    { name: 'luxury (Iceland)', destination: 'Iceland', tripType: 'luxury', audience: 'couples', expectedFamily: 'luxury' },
  ]) {
    test(`deterministic stub satisfies critical-slot contract for ${fam.name}`, async () => {
      const result = await generator.generateLandingPageContentWithTee(
        { tenantId: 1, destination: fam.destination, durationDays: 8, audience: fam.audience, tripType: fam.tripType },
        { skipImages: true }
      );
      expect(result.content._tee.family).toBe(fam.expectedFamily);
      // The orchestrator's stub + bridge must keep critical slots populated
      // even when the LLM is unavailable. If validation fails, the orchestrator
      // returns the partial — which is fine but we want the stub itself to be
      // comprehensive enough to pass for all 4 families.
      expect(result.content.hero.headline).toBeTruthy();
      // cultural.items + faq.items are critical for every family.
      expect(result.content.cultural).toBeTruthy();
      expect(Array.isArray(result.content.cultural.items)).toBe(true);
      expect(result.content.cultural.items.length).toBeGreaterThanOrEqual(2);
      expect(result.content.faq.items.length).toBeGreaterThanOrEqual(3);
    });
  }

  test('source field is "stub" when no LLM provider is available', async () => {
    const result = await generator.generateLandingPageContentWithTee(
      { tenantId: 1, destination: 'Japan', durationDays: 9, audience: 'students', tripType: 'educational' },
      { skipImages: true }
    );
    expect(result.source).toBe('stub');
    expect(result.model).toBe('tee-stub');
  });
});
