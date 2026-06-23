// PR-E Phase 2.2 — vitest coverage for teeContentBridge.js
//
// What this exercises:
//   1. mapTeeOutputToContent — happy path for all 4 families
//   2. Critical-slot validation — missing slots throw TeeContentValidationError
//   3. Operator-locked slots preserved through regeneration
//   4. Family-specific registration funnel labels applied
//   5. TEE composition rewrites section show flags + _sectionOrder
//   6. _tee metadata block stamped correctly with traits + decisions
//   7. Banned fields (testimonials, image URLs, pricing values) scrubbed
//   8. Tenant context (tenantSlug / subBrand) propagated to form metadata

import { describe, test, expect } from 'vitest';
const bridge = require('../../services/teeContentBridge');
const educational = require('../../services/templates/educationalTripV1');
const religious = require('../../services/templates/religiousTourV1');
const family = require('../../services/templates/familyTripV1');
const luxury = require('../../services/templates/luxuryTourV1');

function basicTeeOutput(family = 'educational', themeId = 'educational-academic', composition) {
  return {
    family,
    themeId,
    composition: composition || ['nav', 'hero', 'marquee', 'preview', 'programme', 'cultural', 'safety',
                                  'testimonials', 'investment', 'registration', 'brochure', 'faq', 'details',
                                  'finalCta', 'contact', 'floatingCta'],
    traits: {
      climate: 'temperate', regionFeel: 'east-asian', tripStyle: 'educational',
      audienceTier: 'students', luxuryLevel: 2, mood: 'structured',
      visualMood: 'heritage-discipline-modern-velocity',
    },
    decisionLog: { family: { ruleId: 'F2', rationale: 'educational + students' } },
    generatedAt: '2026-01-01T00:00:00Z',
  };
}

function basicInput() {
  return {
    destination: 'Tokyo Japan',
    durationDays: 9,
    audience: 'Grade 8-12 students',
    tripType: 'educational',
    subBrand: 'tmc',
    tenantSlug: 'travel-stall',
  };
}

function basicLLMOutput() {
  return {
    brand: {
      label: 'JAPAN 2026', programmeName: 'Japan 2026', programmeTagline: 'Heritage meets tomorrow.',
    },
    hero: {
      eyebrow: { date: 'OCT-NOV 2026', audience: 'STUDENTS GRADES 8-12' },
      kicker: '09 Days. 04 Cities.',
      headline: 'Japan 2026 — Heritage Meets Tomorrow.',
      lede: 'Tokyo, Kyoto, Osaka and Nara.',
      benefitCards: [
        { icon: '◈', title: 'Academic', desc: 'University-led visits.' },
        { icon: '⊕', title: 'Cultural', desc: 'Tea ceremony etiquette.' },
        { icon: '⌂', title: 'Safety', desc: '1:6 host ratio.' },
        { icon: '❖', title: 'Network', desc: 'Alumni cohort.' },
      ],
    },
    marquee: { cities: [{ tag: 'METROPOLIS', title: 'Tokyo' }, { tag: 'IMPERIAL', title: 'Kyoto' }] },
    cultural: {
      title: 'Cultural Highlights',
      items: [
        { name: 'Tokyo', label: 'METROPOLIS', body: ['Body para'], benefit: 'Modernity at velocity' },
        { name: 'Kyoto', label: 'IMPERIAL', body: ['Body para'], benefit: 'Ritual as discipline' },
      ],
    },
    safety: {
      title: 'Engineered for Safety.',
      stats: [{ stat: '1:6', title: 'Host Ratio', body: 'One trained guide per six students.' }],
      features: [
        { icon: 'shield', title: 'Vetted hosts', desc: 'Inspected.' },
        { icon: 'briefcase', title: 'Insurance', desc: 'Cover.' },
      ],
    },
    investment: {
      title: 'Investment',
      tiers: [
        { step: 1, title: 'Booking', subtitle: 'Reserve' },
        { step: 2, title: 'Balance', subtitle: 'Pre-departure' },
      ],
    },
    faq: {
      items: [
        { cat: 'all', q: 'How long?', a: 'Nine days.' },
        { cat: 'all', q: 'Ages?', a: 'Grades 8-12.' },
        { cat: 'all', q: 'Cost?', a: 'Operator to share.' },
      ],
    },
    contact: { label: 'JAPAN 2026' },
  };
}

describe('mapTeeOutputToContent — happy path', () => {
  test('educational: produces a complete template payload + _tee block', () => {
    const { content, validation } = educational.mapTeeOutputToContent({
      rawLLMOutput: basicLLMOutput(),
      teeOutput: basicTeeOutput('educational', 'educational-academic'),
      input: basicInput(),
    });
    expect(validation.ok).toBe(true);
    expect(content.brand.label).toBe('JAPAN 2026');
    expect(content.hero.headline).toContain('Japan');
    expect(content.cultural.items.length).toBeGreaterThanOrEqual(2);
    expect(content._tee).toBeTruthy();
    expect(content._tee.family).toBe('educational');
    expect(content._tee.themeId).toBe('educational-academic');
    expect(content._tee.visualMood).toBe('heritage-discipline-modern-velocity');
  });

  test('religious: family-specific registration funnel labels applied', () => {
    const tee = basicTeeOutput('religious', 'religious-classical');
    const { content } = religious.mapTeeOutputToContent({
      rawLLMOutput: basicLLMOutput(),
      teeOutput: tee,
      input: { ...basicInput(), tripType: 'religious', subBrand: 'rfu' },
    });
    expect(content.registration.personLabel).toMatch(/Pilgrim/i);
    expect(content.registration.guardianLabel).toMatch(/Mahram|Companion/i);
    expect(content.registration.showStudentFields).toBe(false);
    expect(content.registration.showSchoolField).toBe(false);
    expect(content.registration.submitText).toMatch(/Reservation/i);
  });

  test('family: lead-family-member + headcount funnel labels', () => {
    const tee = basicTeeOutput('family', 'family-tropical');
    const { content } = family.mapTeeOutputToContent({
      rawLLMOutput: basicLLMOutput(),
      teeOutput: tee,
      input: { ...basicInput(), tripType: 'family' },
    });
    expect(content.registration.personLabel).toMatch(/Family|Lead/i);
    expect(content.registration.guardianLabel).toMatch(/Number|Travellers/i);
  });

  test('luxury: application-style registration funnel labels', () => {
    const tee = basicTeeOutput('luxury', 'luxury-alpine', [
      'nav', 'hero', 'marquee', 'cultural', 'investment', 'registration', 'faq', 'finalCta', 'contact', 'floatingCta',
    ]);
    const llm = basicLLMOutput();
    // Luxury needs >= 2 cultural items + >= 2 investment tiers (per CRITICAL_SLOTS.luxury).
    const { content } = luxury.mapTeeOutputToContent({
      rawLLMOutput: llm,
      teeOutput: tee,
      input: { ...basicInput(), tripType: 'luxury' },
    });
    expect(content.registration.submitText).toMatch(/Application/i);
    expect(content.registration.personLabel).toMatch(/Name/i);
    // Composition strips programme / brochure / details.
    expect(content._sectionOrder).not.toContain('programme');
    expect(content._sectionOrder).not.toContain('brochure');
  });
});

describe('critical slot validation — early failure', () => {
  test('missing hero.headline throws TeeContentValidationError', () => {
    const llm = basicLLMOutput();
    delete llm.hero.headline;
    delete llm.hero.lede;
    // The defaults' [REVIEW] markers are non-empty strings, so without
    // an explicit override the slots stay populated. To exercise the
    // missing-slot path we have to override defaults' fields too.
    const stripped = JSON.parse(JSON.stringify(educational.defaultContent));
    stripped.hero.headline = '';
    stripped.hero.lede = '';
    const { mapTeeOutputToContent } = require('../../services/teeContentBridge');
    expect(() => mapTeeOutputToContent({
      rawLLMOutput: { hero: { headline: '', lede: '' } },
      teeOutput: basicTeeOutput(),
      input: basicInput(),
      templateDefaults: stripped,
    })).toThrow(/missing critical slots/);
  });

  test('missing cultural items (< 2) → throws', () => {
    const stripped = JSON.parse(JSON.stringify(educational.defaultContent));
    stripped.cultural.items = [];
    const { mapTeeOutputToContent } = require('../../services/teeContentBridge');
    expect(() => mapTeeOutputToContent({
      rawLLMOutput: { cultural: { items: [{ name: 'Only-one' }] } },
      teeOutput: basicTeeOutput(),
      input: basicInput(),
      templateDefaults: stripped,
    })).toThrow(/missing critical slots/);
  });

  test('thrown error carries `missing` array + `partial` payload', () => {
    const stripped = JSON.parse(JSON.stringify(educational.defaultContent));
    stripped.hero.headline = '';
    stripped.hero.lede = '';
    stripped.cultural.items = [];
    const { mapTeeOutputToContent, TeeContentValidationError } = require('../../services/teeContentBridge');
    try {
      mapTeeOutputToContent({
        rawLLMOutput: {},
        teeOutput: basicTeeOutput(),
        input: basicInput(),
        templateDefaults: stripped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(TeeContentValidationError);
      expect(Array.isArray(e.missing)).toBe(true);
      expect(e.missing.length).toBeGreaterThan(0);
      expect(e.partial).toBeTruthy();
    }
  });

  test('validateRequiredSlots returns { ok, missing[] }', () => {
    const { validateRequiredSlots } = require('../../services/teeContentBridge');
    const good = {
      brand: { label: 'X', programmeName: 'Y' },
      hero: { headline: 'H', lede: 'L' },
      cultural: { items: [{ name: '1' }, { name: '2' }] },
      safety: { features: [{ title: 'a' }, { title: 'b' }] },
      faq: { items: [{ q: '1' }, { q: '2' }, { q: '3' }] },
      contact: { label: 'C' },
    };
    expect(validateRequiredSlots(good, 'educational').ok).toBe(true);
  });
});

describe('operator-locked slots preserved through regeneration', () => {
  test('_locked.hero.headline pins the slot through regeneration', () => {
    const existing = {
      hero: { headline: 'OPERATOR PINNED HEADLINE' },
      _locked: { 'hero.headline': true },
    };
    const { content } = educational.mapTeeOutputToContent({
      rawLLMOutput: basicLLMOutput(),
      teeOutput: basicTeeOutput(),
      input: basicInput(),
      existingContent: existing,
    });
    expect(content.hero.headline).toBe('OPERATOR PINNED HEADLINE');
    expect(content._locked).toBeTruthy();
  });
});

describe('TEE composition rewrites section show flags', () => {
  test('luxury composition omits programme / brochure / details (show=false stays the default false)', () => {
    const tee = basicTeeOutput('luxury', 'luxury-alpine', [
      'nav', 'hero', 'marquee', 'cultural', 'investment', 'registration', 'faq', 'finalCta', 'contact', 'floatingCta',
    ]);
    const { content } = luxury.mapTeeOutputToContent({
      rawLLMOutput: basicLLMOutput(),
      teeOutput: tee,
      input: basicInput(),
    });
    // luxury's DEFAULT_CONTENT carries programme.show=false / brochure.show=false / details.show=false
    expect(content.programme && content.programme.show).toBeFalsy();
    expect(content.brochure && content.brochure.show).toBeFalsy();
    expect(content.details && content.details.show).toBeFalsy();
  });

  test('_sectionOrder is set on content for the renderer', () => {
    const tee = basicTeeOutput('religious', 'religious-classical', ['nav', 'hero', 'programme', 'cultural', 'faq', 'contact']);
    const llm = basicLLMOutput();
    llm.programme = { leftHeadline: 'Why pilgrimage', leftParagraphs: ['p'], rightChecks: ['a'] };
    const { content } = religious.mapTeeOutputToContent({
      rawLLMOutput: llm,
      teeOutput: tee,
      input: { ...basicInput(), tripType: 'religious', subBrand: 'rfu' },
    });
    expect(content._sectionOrder).toEqual(['nav', 'hero', 'programme', 'cultural', 'faq', 'contact']);
  });
});

describe('banned-field defensive scrub', () => {
  test('testimonials.items always empties', () => {
    const llm = basicLLMOutput();
    llm.testimonials = { items: [{ name: 'X', text: 'Y' }] }; // LLM tried to inject
    const { content } = educational.mapTeeOutputToContent({
      rawLLMOutput: llm,
      teeOutput: basicTeeOutput(),
      input: basicInput(),
    });
    expect(content.testimonials.items).toEqual([]);
  });

  test('investment.tiers commercial fields force null', () => {
    const llm = basicLLMOutput();
    llm.investment = {
      tiers: [{ step: 1, title: 'X', subtitle: 'Y', amount: '50,000', tag: 'VIP', date: 'Apr', vendor: 'X' }],
    };
    const { content } = educational.mapTeeOutputToContent({
      rawLLMOutput: llm,
      teeOutput: basicTeeOutput(),
      input: basicInput(),
    });
    const t = content.investment.tiers[0];
    expect(t.amount).toBeNull();
    expect(t.tag).toBeNull();
    expect(t.date).toBeNull();
    expect(t.vendor).toBeNull();
  });

  test('hero.posterUrl, brand.logoUrl, partnerLogos[], marquee city imgs all null', () => {
    const llm = basicLLMOutput();
    llm.hero.posterUrl = 'https://leak.example/x.jpg';
    llm.brand.logoUrl = 'https://leak.example/logo.png';
    llm.brand.partnerLogos = [{ src: 'https://leak.example/p.png', alt: 'P' }];
    llm.marquee.cities[0].img = 'https://leak.example/city.jpg';
    const { content } = educational.mapTeeOutputToContent({
      rawLLMOutput: llm,
      teeOutput: basicTeeOutput(),
      input: basicInput(),
    });
    expect(content.hero.posterUrl).toBe('');
    expect(content.brand.logoUrl).toBe('');
    expect(content.brand.partnerLogos).toEqual([]);
    expect(content.marquee.cities[0].img).toBeNull();
  });
});

describe('_tee metadata block (decision log persistence)', () => {
  test('contains family + themeId + visualMood + composition + traits + decisions + generatedAt', () => {
    const tee = basicTeeOutput('educational', 'educational-academic');
    const { content } = educational.mapTeeOutputToContent({
      rawLLMOutput: basicLLMOutput(),
      teeOutput: tee,
      input: basicInput(),
    });
    expect(content._tee.family).toBe('educational');
    expect(content._tee.themeId).toBe('educational-academic');
    expect(content._tee.visualMood).toBe('heritage-discipline-modern-velocity');
    expect(Array.isArray(content._tee.composition)).toBe(true);
    expect(content._tee.traits.climate).toBe('temperate');
    expect(content._tee.traits.tripStyle).toBe('educational');
    expect(typeof content._tee.generatedAt).toBe('string');
    expect(content._tee.decisions).toBeTruthy();
  });
});

describe('tenant context propagation', () => {
  test('registration + brochure carry tenantSlug + subBrand from input', () => {
    const llm = basicLLMOutput();
    llm.brochure = { headTitle: 'Brochure' };
    const { content } = educational.mapTeeOutputToContent({
      rawLLMOutput: llm,
      teeOutput: basicTeeOutput(),
      input: { ...basicInput(), tenantSlug: 'travel-stall', subBrand: 'tmc' },
    });
    expect(content.registration.tenantSlug).toBe('travel-stall');
    expect(content.registration.leadSubBrand).toBe('tmc');
    expect(content.brochure.tenantSlug).toBe('travel-stall');
    expect(content.brochure.leadSubBrand).toBe('tmc');
  });
});

describe('all 4 templates expose mapTeeOutputToContent()', () => {
  test('the function is registered on every family template', () => {
    expect(typeof educational.mapTeeOutputToContent).toBe('function');
    expect(typeof religious.mapTeeOutputToContent).toBe('function');
    expect(typeof family.mapTeeOutputToContent).toBe('function');
    expect(typeof luxury.mapTeeOutputToContent).toBe('function');
  });
});

describe('helper functions', () => {
  test('_deepMerge replaces arrays wholesale (matches existing renderer semantics)', () => {
    const out = bridge._deepMerge({ a: [1, 2, 3] }, { a: [4] });
    expect(out.a).toEqual([4]);
  });

  test('_deepMerge merges objects recursively', () => {
    const out = bridge._deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 20, z: 30 } });
    expect(out.a).toEqual({ x: 1, y: 20, z: 30 });
  });

  test('_checkSlot honours length>=N spec', () => {
    const c = { items: [1, 2, 3] };
    expect(bridge._checkSlot(c, 'items.[length>=2]')).toBe(true);
    expect(bridge._checkSlot(c, 'items.[length>=4]')).toBe(false);
  });
});
