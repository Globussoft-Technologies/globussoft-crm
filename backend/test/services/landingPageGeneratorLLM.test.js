/**
 * landingPageGeneratorLLM.test.js — pins the orchestrator's contract:
 *
 *   - Stub mode (no GEMINI_API_KEY) returns the deterministic fallback
 *     shape with source='stub', stub=true.
 *   - Real mode: parsed Gemini output flows through the guardrail; valid
 *     output returns verdict='passed'; clean output keeps source='gemini'.
 *   - Real-mode error falls through to stub WITH realModeError set.
 *   - Budget cap throws LANDING_PAGE_GENERATE_BUDGET_EXCEEDED before any
 *     Gemini call fires.
 *   - parseGeminiJson strips markdown fences, BOMs, and surrounding prose.
 *   - Input validation: tenantId / destination / durationDays required.
 *
 * The module uses the CJS self-mocking seam (module.exports.fn(…))
 * because spies via vi.spyOn(client, 'fn') intercept exports indirection
 * — see CLAUDE.md "CJS self-mocking seam" standing rule.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Reset module cache between tests so each test gets fresh module state
// (matches the pattern in appointmentService.test.js / marketingFlyerCopyLLM.test.js).
beforeEach(() => {
  delete requireCjs.cache[requireCjs.resolve('../../services/landingPageGeneratorLLM.js')];
});

describe('input validation', () => {
  test('throws when tenantId missing', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    await expect(client.generateLandingPageContent({
      destination: 'Bali', durationDays: 7,
    })).rejects.toThrow(/tenantId required/);
  });

  test('throws when destination missing', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    await expect(client.generateLandingPageContent({
      tenantId: 1, durationDays: 7,
    })).rejects.toThrow(/destination required/);
  });

  test('throws on durationDays < 1', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    await expect(client.generateLandingPageContent({
      tenantId: 1, destination: 'Bali', durationDays: 0,
    })).rejects.toThrow(/durationDays/);
  });

  test('throws on durationDays > 60', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    await expect(client.generateLandingPageContent({
      tenantId: 1, destination: 'Bali', durationDays: 90,
    })).rejects.toThrow(/durationDays/);
  });
});

describe('budget cap enforcement', () => {
  test('over-cap → LANDING_PAGE_GENERATE_BUDGET_EXCEEDED', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    // Force cap-exceeded by making checkBudgetCap throw the canonical error.
    const capErr = new Error('Monthly LLM spend cap reached for this tenant.');
    capErr.code = 'LANDING_PAGE_GENERATE_BUDGET_EXCEEDED';
    capErr.spentCents = 99999999;
    capErr.capCents = 10000;
    vi.spyOn(client, 'checkBudgetCap').mockRejectedValue(capErr);
    vi.spyOn(client, 'realModeEnabled').mockResolvedValue(false);

    await expect(client.generateLandingPageContent({
      tenantId: 1, destination: 'Bali', durationDays: 7, audience: 'travellers',
    })).rejects.toMatchObject({ code: 'LANDING_PAGE_GENERATE_BUDGET_EXCEEDED' });
  });

  test('under-cap → falls through to stub when no Gemini key', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    vi.spyOn(client, 'checkBudgetCap').mockResolvedValue({ withinCap: true, percent: 0.1, alertThreshold: false });
    vi.spyOn(client, 'realModeEnabled').mockResolvedValue(false);

    const result = await client.generateLandingPageContent({
      tenantId: 1, destination: 'Bali', durationDays: 5, audience: 'photographers',
    });
    expect(result.stub).toBe(true);
    expect(result.source).toBe('stub');
    expect(result.verdict).toBe('fallback');
    expect(result.blocks).toHaveLength(9);
    expect(result.suggestedTitle).toContain('Bali');
    expect(result.suggestedSlug).toContain('bali');
  });
});

describe('stub mode returns deterministic fallback', () => {
  test('shape contract — has all top-level keys', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    vi.spyOn(client, 'checkBudgetCap').mockResolvedValue({ withinCap: true, percent: 0.1, alertThreshold: false });
    vi.spyOn(client, 'realModeEnabled').mockResolvedValue(false);

    const r = await client.generateLandingPageContent({
      tenantId: 1, destination: 'Iceland', durationDays: 4, audience: 'photographers',
    });
    expect(r).toHaveProperty('blocks');
    expect(r).toHaveProperty('suggestedSlug');
    expect(r).toHaveProperty('suggestedTitle');
    expect(r).toHaveProperty('seoMeta');
    expect(r).toHaveProperty('source', 'stub');
    expect(r).toHaveProperty('stub', true);
    expect(r).toHaveProperty('verdict', 'fallback');
  });

  test('itinerary day count matches input durationDays', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    vi.spyOn(client, 'checkBudgetCap').mockResolvedValue({ withinCap: true, percent: 0.1, alertThreshold: false });
    vi.spyOn(client, 'realModeEnabled').mockResolvedValue(false);

    const r = await client.generateLandingPageContent({
      tenantId: 1, destination: 'Bali', durationDays: 10, audience: 'travellers',
    });
    const itin = r.blocks.find((b) => b.type === 'itineraryTimeline');
    expect(itin.props.days).toHaveLength(10);
  });

  test('stub output preserves tierPricing as a null-shell, drops reviewCarousel, nulls all images', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    vi.spyOn(client, 'checkBudgetCap').mockResolvedValue({ withinCap: true, percent: 0.1, alertThreshold: false });
    vi.spyOn(client, 'realModeEnabled').mockResolvedValue(false);

    const r = await client.generateLandingPageContent({
      tenantId: 1, destination: 'Bali', durationDays: 3, audience: 'travellers',
    });
    // tierPricing PRESERVED as a structural shell — operator fills the
    // commercial fields in the builder. The publish gate then enforces
    // "every tier has an amount" before status flips PUBLISHED.
    const pricing = r.blocks.find((b) => b.type === 'tierPricing');
    expect(pricing).toBeTruthy();
    expect(pricing.props.tiers.length).toBeGreaterThan(0);
    pricing.props.tiers.forEach((t) => {
      expect(t.amount).toBeNull();
      expect(t.dueDate).toBeNull();
      expect(t.vendor).toBeNull();
      expect(t.tag).toBeNull();
    });
    // reviewCarousel still removed entirely (operator-only).
    expect(r.blocks.find((b) => b.type === 'reviewCarousel')).toBeUndefined();
    const hero = r.blocks.find((b) => b.type === 'destinationHero');
    expect(hero.props.posterUrl).toBeNull();
    const cities = r.blocks.find((b) => b.type === 'cityCards');
    expect(cities.props.cards.every((c) => c.img === null)).toBe(true);
  });
});

describe('real mode — happy path', () => {
  test('clean Gemini output flows through guardrail with verdict=passed', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    vi.spyOn(client, 'checkBudgetCap').mockResolvedValue({ withinCap: true, percent: 0.1, alertThreshold: false });
    vi.spyOn(client, 'realModeEnabled').mockResolvedValue(true);

    const cleanLlmOutput = {
      suggestedTitle: 'Bali — 5-day Escape',
      suggestedSlug: 'bali-5-days',
      seoMeta: {
        metaTitle: 'Bali — 5 days',
        metaDescription: 'A 5-day Bali itinerary covering Ubud, Seminyak, and the south coast.',
      },
      blocks: [
        { type: 'destinationHero', props: { destination: 'Bali', headline: 'A 5-day Bali escape', subhead: 'Quiet beaches and forest temples.', posterUrl: null, countdownTo: null, ctaText: 'Reserve Your Spot', ctaScrollTarget: '', palette: { bg: '#1f1a17', fg: '#fff', accent: '#b8893b' } } },
        { type: 'highlightsGrid', props: { title: 'Why Bali', subtitle: '', items: [
          { icon: '◈', title: 'Beaches', body: 'South coast sand.' },
          { icon: '⊕', title: 'Culture', body: 'Daily temple life.' },
          { icon: '⌂', title: 'Cuisine', body: 'Warungs everywhere.' },
        ] } },
        { type: 'cityCards', props: { title: 'Where', subtitle: '', cards: [
          { tag: 'FOREST', title: 'Ubud', img: null, body: 'Ricefield walks.' },
          { tag: 'COAST', title: 'Seminyak', img: null, body: 'Sunset beaches.' },
          { tag: 'CLIFF', title: 'Uluwatu', img: null, body: 'Clifftop temples.' },
        ] } },
        { type: 'safetyFeatures', props: { title: 'Safety', subtitle: '', items: [
          { icon: '🛡', title: 'Insurance', body: 'Covered.' }, { icon: '⚕', title: 'Medical', body: 'On call.' }, { icon: '☎', title: 'Support', body: '24/7.' },
        ] } },
        { type: 'inclusionsGrid', props: { title: 'Included', subtitle: '', items: ['Airfare', 'Villa stays', 'Daily breakfast', 'Transfers', 'Guide'] } },
        { type: 'itineraryTimeline', props: { title: 'Days', subtitle: '', days: [
          { day: 1, title: 'Arrival', bullets: ['Pickup', 'Welcome dinner'] },
          { day: 2, title: 'Ubud', bullets: ['Forest temple', 'Lunch warung'] },
          { day: 3, title: 'Seminyak', bullets: ['Beach', 'Spa'] },
          { day: 4, title: 'Uluwatu', bullets: ['Cliff temple', 'Kecak dance'] },
          { day: 5, title: 'Departure', bullets: ['Airport drop'] },
        ] } },
        { type: 'tierPricing', props: { title: 'Investment', subtitle: '', currency: '₹', tiers: [
          { step: 1, label: 'First Instalment', subtitle: 'Booking confirmation', amount: null, dueDate: null, vendor: null, tag: null },
          { step: 2, label: 'Mid-term Payment', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null },
          { step: 3, label: 'Final Payment', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null },
        ] } },
        { type: 'faqAccordion', props: { title: 'FAQ', subtitle: '', categories: [
          { id: 'all', label: 'All', icon: '◇' },
          { id: 'tour', label: 'Tour', icon: '◈' },
        ], faqs: [
          { cat: 'tour', q: 'When is the best time?', a: 'April through October.' },
          { cat: 'tour', q: 'Is this group or private?', a: 'Private guided.' },
          { cat: 'tour', q: 'How active is the trip?', a: 'Moderate walking.' },
          { cat: 'tour', q: 'Can I extend the trip?', a: 'Yes, with notice.' },
        ] } },
        { type: 'contactFooter', props: { brandName: null, phone: null, email: null, ctaText: 'Reserve Your Spot', ctaUrl: null } },
      ],
    };

    vi.spyOn(client, 'callGemini').mockResolvedValue({ rawJson: cleanLlmOutput, modelUsed: 'gemini-2.5-flash' });

    const r = await client.generateLandingPageContent({
      tenantId: 1, destination: 'Bali', durationDays: 5, audience: 'honeymooners',
    });

    expect(r.source).toBe('gemini');
    expect(r.stub).toBe(false);
    expect(r.verdict).toBe('passed');
    expect(r.blocks).toHaveLength(9);
    expect(r.suggestedSlug).toBe('bali-5-days');
  });
});

describe('real mode — scrubbed', () => {
  test('LLM emits tierPricing block with monetary value → block preserved, amount nulled, verdict=scrubbed', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    vi.spyOn(client, 'checkBudgetCap').mockResolvedValue({ withinCap: true, percent: 0.1, alertThreshold: false });
    vi.spyOn(client, 'realModeEnabled').mockResolvedValue(true);

    const naughty = {
      suggestedTitle: 'Bali 5-day',
      suggestedSlug: 'bali-5',
      seoMeta: { metaTitle: 'Bali', metaDescription: 'A 5-day Bali trip.' },
      blocks: [
        { type: 'destinationHero', props: { destination: 'Bali', headline: 'A trip', subhead: 'Sub.', posterUrl: null, countdownTo: null, ctaText: 'Go', ctaScrollTarget: '', palette: { bg: '#1f1a17', fg: '#fff', accent: '#b8893b' } } },
        { type: 'highlightsGrid', props: { title: 'Why', subtitle: '', items: [
          { icon: '◈', title: 'a', body: 'b' }, { icon: '⊕', title: 'c', body: 'd' }, { icon: '⌂', title: 'e', body: 'f' },
        ] } },
        { type: 'cityCards', props: { title: 'Where', subtitle: '', cards: [
          { tag: 'A', title: 'Ubud', img: null, body: 'b' },
        ] } },
        { type: 'safetyFeatures', props: { title: 'Safety', subtitle: '', items: [
          { icon: '🛡', title: 'Insurance', body: 'Covered.' }, { icon: '⚕', title: 'Medical', body: 'On call.' }, { icon: '☎', title: 'Support', body: '24/7.' },
        ] } },
        { type: 'inclusionsGrid', props: { title: 'I', subtitle: '', items: ['a', 'b', 'c'] } },
        { type: 'itineraryTimeline', props: { title: 'Days', subtitle: '', days: [
          { day: 1, title: 'A', bullets: ['x'] }, { day: 2, title: 'B', bullets: ['x'] },
          { day: 3, title: 'C', bullets: ['x'] }, { day: 4, title: 'D', bullets: ['x'] },
          { day: 5, title: 'E', bullets: ['x'] },
        ] } },
        // AI tried to inject pricing values — single tier with amount so
        // we land on the SCRUB path (block preserved, amount nulled), not
        // the >5-violation fallback.
        { type: 'tierPricing', props: { title: 'Investment', subtitle: '', currency: '₹', tiers: [
          { step: 1, label: 'Booking', subtitle: '', amount: '5000', dueDate: null, vendor: null, tag: null },
        ] } },
        { type: 'faqAccordion', props: { title: 'FAQ', subtitle: '', categories: [
          { id: 'all', label: 'All', icon: '◇' },
        ], faqs: [
          { cat: 'all', q: 'q1', a: 'a1' }, { cat: 'all', q: 'q2', a: 'a2' },
          { cat: 'all', q: 'q3', a: 'a3' }, { cat: 'all', q: 'q4', a: 'a4' },
        ] } },
        { type: 'contactFooter', props: { brandName: null, phone: null, email: null, ctaText: 'Reserve Your Spot', ctaUrl: null } },
      ],
    };
    vi.spyOn(client, 'callGemini').mockResolvedValue({ rawJson: naughty, modelUsed: 'gemini-2.5-flash' });

    const r = await client.generateLandingPageContent({
      tenantId: 1, destination: 'Bali', durationDays: 5, audience: 'honeymooners',
    });

    expect(r.source).toBe('gemini');
    expect(r.verdict).toBe('scrubbed');
    // tierPricing block PRESERVED as a structural shell — amount nulled,
    // operator types the real value in the builder.
    const pricing = r.blocks.find((b) => b.type === 'tierPricing');
    expect(pricing).toBeTruthy();
    expect(pricing.props.tiers).toHaveLength(1);
    expect(pricing.props.tiers[0].amount).toBeNull();
    expect(pricing.props.tiers[0].label).toBe('Booking');
    expect(r.guardrailIssues.some((i) => i.includes('amount:must_be_null'))).toBe(true);
  });

  test('LLM emits reviewCarousel block → still dropped entirely (testimonials are operator-only)', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    vi.spyOn(client, 'checkBudgetCap').mockResolvedValue({ withinCap: true, percent: 0.1, alertThreshold: false });
    vi.spyOn(client, 'realModeEnabled').mockResolvedValue(true);

    const naughty = {
      suggestedTitle: 'Bali 5-day',
      suggestedSlug: 'bali-5',
      seoMeta: { metaTitle: 'Bali', metaDescription: 'A 5-day Bali trip.' },
      blocks: [
        { type: 'destinationHero', props: { destination: 'Bali', headline: 'A trip', subhead: 'Sub.', posterUrl: null, countdownTo: null, ctaText: 'Go', ctaScrollTarget: '', palette: { bg: '#1f1a17', fg: '#fff', accent: '#b8893b' } } },
        { type: 'highlightsGrid', props: { title: 'Why', subtitle: '', items: [
          { icon: '◈', title: 'a', body: 'b' }, { icon: '⊕', title: 'c', body: 'd' }, { icon: '⌂', title: 'e', body: 'f' },
        ] } },
        { type: 'cityCards', props: { title: 'Where', subtitle: '', cards: [
          { tag: 'A', title: 'Ubud', img: null, body: 'b' },
        ] } },
        { type: 'safetyFeatures', props: { title: 'Safety', subtitle: '', items: [
          { icon: '🛡', title: 'Insurance', body: 'Covered.' }, { icon: '⚕', title: 'Medical', body: 'On call.' }, { icon: '☎', title: 'Support', body: '24/7.' },
        ] } },
        { type: 'inclusionsGrid', props: { title: 'I', subtitle: '', items: ['a', 'b', 'c'] } },
        { type: 'itineraryTimeline', props: { title: 'Days', subtitle: '', days: [
          { day: 1, title: 'A', bullets: ['x'] }, { day: 2, title: 'B', bullets: ['x'] },
          { day: 3, title: 'C', bullets: ['x'] }, { day: 4, title: 'D', bullets: ['x'] },
          { day: 5, title: 'E', bullets: ['x'] },
        ] } },
        { type: 'tierPricing', props: { title: 'Investment', subtitle: '', currency: '₹', tiers: [
          { step: 1, label: 'Booking', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null },
        ] } },
        { type: 'faqAccordion', props: { title: 'FAQ', subtitle: '', categories: [
          { id: 'all', label: 'All', icon: '◇' },
        ], faqs: [
          { cat: 'all', q: 'q1', a: 'a1' }, { cat: 'all', q: 'q2', a: 'a2' },
          { cat: 'all', q: 'q3', a: 'a3' }, { cat: 'all', q: 'q4', a: 'a4' },
        ] } },
        { type: 'contactFooter', props: { brandName: null, phone: null, email: null, ctaText: 'Reserve Your Spot', ctaUrl: null } },
        // DISALLOWED entirely.
        { type: 'reviewCarousel', props: { reviews: [{ name: 'Priya', text: 'Amazing!' }] } },
      ],
    };
    vi.spyOn(client, 'callGemini').mockResolvedValue({ rawJson: naughty, modelUsed: 'gemini-2.5-flash' });

    const r = await client.generateLandingPageContent({
      tenantId: 1, destination: 'Bali', durationDays: 5, audience: 'honeymooners',
    });

    expect(r.source).toBe('gemini');
    expect(r.verdict).toBe('scrubbed');
    expect(r.blocks.find((b) => b.type === 'reviewCarousel')).toBeUndefined();
    expect(r.guardrailIssues.some((i) => i.includes('disallowed_type:reviewCarousel'))).toBe(true);
  });
});

describe('real mode — failure falls through to stub', () => {
  test('callGemini throws + no OpenAI key → stub returned with realModeError set', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    vi.spyOn(client, 'checkBudgetCap').mockResolvedValue({ withinCap: true, percent: 0.1, alertThreshold: false });
    vi.spyOn(client, 'realModeEnabled').mockResolvedValue(true);
    vi.spyOn(client, 'callGemini').mockRejectedValue(new Error('Gemini quota exhausted'));
    vi.spyOn(client, 'openAiFallbackEnabled').mockReturnValue(false);

    const r = await client.generateLandingPageContent({
      tenantId: 1, destination: 'Bali', durationDays: 5, audience: 'travellers',
    });

    expect(r.source).toBe('stub');
    expect(r.stub).toBe(true);
    expect(r.realModeError).toMatch(/quota/);
    // Fallback is still a valid 9-block payload.
    expect(r.blocks).toHaveLength(9);
  });

  test('Gemini fails + OpenAI fallback succeeds → source=openai, real content kept', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    vi.spyOn(client, 'checkBudgetCap').mockResolvedValue({ withinCap: true, percent: 0.1, alertThreshold: false });
    vi.spyOn(client, 'realModeEnabled').mockResolvedValue(true);
    vi.spyOn(client, 'callGemini').mockRejectedValue(new Error('Gemini 503 high demand'));
    vi.spyOn(client, 'openAiFallbackEnabled').mockReturnValue(true);

    // Minimal 9-block valid payload — matches the guardrail's required-blocks
    // contract so verdict='passed'. Same shape as the real-mode happy-path mock.
    const openAiOutput = {
      suggestedTitle: 'Bali — 5-day Escape',
      suggestedSlug: 'bali-5-days',
      seoMeta: { metaTitle: 'Bali — 5 days', metaDescription: 'A 5-day Bali itinerary.' },
      blocks: [
        { type: 'destinationHero', props: { destination: 'Bali', headline: 'Bali in 5 days', subhead: 'Sub.', posterUrl: null, countdownTo: null, ctaText: 'Reserve', ctaScrollTarget: '', palette: { bg: '#1f1a17', fg: '#fff', accent: '#b8893b' } } },
        { type: 'highlightsGrid', props: { title: 'Why', subtitle: '', items: [
          { icon: '◈', title: 'a', body: 'b' }, { icon: '⊕', title: 'c', body: 'd' }, { icon: '⌂', title: 'e', body: 'f' },
        ] } },
        { type: 'cityCards', props: { title: 'Where', subtitle: '', cards: [
          { tag: 'A', title: 'Ubud', img: null, body: 'b' },
          { tag: 'B', title: 'Seminyak', img: null, body: 'b' },
          { tag: 'C', title: 'Uluwatu', img: null, body: 'b' },
        ] } },
        { type: 'safetyFeatures', props: { title: 'Safety', subtitle: '', items: [
          { icon: '🛡', title: 'Insurance', body: 'Covered.' }, { icon: '⚕', title: 'Medical', body: 'On call.' }, { icon: '☎', title: 'Support', body: '24/7.' },
        ] } },
        { type: 'inclusionsGrid', props: { title: 'I', subtitle: '', items: ['a', 'b', 'c', 'd', 'e'] } },
        { type: 'itineraryTimeline', props: { title: 'Days', subtitle: '', days: [
          { day: 1, title: 'Arrival', bullets: ['x'] }, { day: 2, title: 'B', bullets: ['x'] },
          { day: 3, title: 'C', bullets: ['x'] }, { day: 4, title: 'D', bullets: ['x'] },
          { day: 5, title: 'Departure', bullets: ['x'] },
        ] } },
        { type: 'tierPricing', props: { title: 'Investment', subtitle: '', currency: '₹', tiers: [
          { step: 1, label: 'Booking', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null },
          { step: 2, label: 'Mid-term', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null },
          { step: 3, label: 'Final', subtitle: '', amount: null, dueDate: null, vendor: null, tag: null },
        ] } },
        { type: 'faqAccordion', props: { title: 'FAQ', subtitle: '', categories: [
          { id: 'all', label: 'All', icon: '◇' },
        ], faqs: [
          { cat: 'all', q: 'q1', a: 'a1' }, { cat: 'all', q: 'q2', a: 'a2' },
          { cat: 'all', q: 'q3', a: 'a3' }, { cat: 'all', q: 'q4', a: 'a4' },
        ] } },
        { type: 'contactFooter', props: { brandName: null, phone: null, email: null, ctaText: 'Reserve', ctaUrl: null } },
      ],
    };
    vi.spyOn(client, 'callOpenAI').mockResolvedValue({ rawJson: openAiOutput, modelUsed: 'gpt-4o-mini' });

    const r = await client.generateLandingPageContent({
      tenantId: 1, destination: 'Bali', durationDays: 5, audience: 'honeymooners',
    });

    expect(r.source).toBe('openai');
    expect(r.stub).toBe(false);
    expect(r.model).toBe('gpt-4o-mini');
    expect(r.verdict).toBe('passed');
    expect(r.blocks).toHaveLength(9);
    // Surfaces WHY the OpenAI fallback fired so the operator can see it.
    expect(r.realModeError).toMatch(/503|high demand/);
  });

  test('Gemini fails + OpenAI fallback also fails → stub returned with combined error', async () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    vi.spyOn(client, 'checkBudgetCap').mockResolvedValue({ withinCap: true, percent: 0.1, alertThreshold: false });
    vi.spyOn(client, 'realModeEnabled').mockResolvedValue(true);
    vi.spyOn(client, 'callGemini').mockRejectedValue(new Error('Gemini 503'));
    vi.spyOn(client, 'openAiFallbackEnabled').mockReturnValue(true);
    vi.spyOn(client, 'callOpenAI').mockRejectedValue(new Error('OpenAI 429 rate limit'));

    const r = await client.generateLandingPageContent({
      tenantId: 1, destination: 'Bali', durationDays: 5, audience: 'travellers',
    });

    expect(r.source).toBe('stub');
    expect(r.stub).toBe(true);
    expect(r.realModeError).toMatch(/Gemini/);
    expect(r.realModeError).toMatch(/OpenAI/);
  });
});

describe('parseGeminiJson', () => {
  test('parses clean JSON', () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    expect(client.parseGeminiJson('{"a":1}')).toEqual({ a: 1 });
  });

  test('strips markdown fences', () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    expect(client.parseGeminiJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test('strips BOM', () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    expect(client.parseGeminiJson('﻿{"a":1}')).toEqual({ a: 1 });
  });

  test('extracts JSON from surrounding prose', () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    expect(client.parseGeminiJson('Here is the JSON: {"a":1} done.')).toEqual({ a: 1 });
  });

  test('empty input throws', () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    expect(() => client.parseGeminiJson('')).toThrow();
  });

  test('non-string input throws', () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    expect(() => client.parseGeminiJson(null)).toThrow();
    expect(() => client.parseGeminiJson(123)).toThrow();
  });

  test('malformed JSON throws with helpful preview', () => {
    const client = requireCjs('../../services/landingPageGeneratorLLM.js');
    expect(() => client.parseGeminiJson('{not valid')).toThrow(/parse failed/);
  });
});
