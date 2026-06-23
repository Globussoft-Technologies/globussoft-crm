// PR-E Phase 2.2 — vitest coverage for teePrompts.js
//
// What this exercises:
//   1. FAMILY_VOICE — every family has register / tone / DO / DONT lists
//   2. REGISTRATION_SLOT_MAP — every family has the 9 funnel-label keys
//   3. buildTeeContentPrompt — system + user prompt structure for all
//      4 families, with TEE outputs threaded through correctly
//   4. visualMood is mentioned in the prompt (R1 requirement)
//   5. Guardrail bans appear in the system prompt
//   6. The prompt never tells the LLM to pick family / themeId / visualMood
//      (architectural invariant: TEE is authoritative)

import { describe, test, expect } from 'vitest';
const prompts = require('../../services/teePrompts');

describe('FAMILY_VOICE', () => {
  test('all 4 families are defined', () => {
    expect(prompts.FAMILY_VOICE.educational).toBeTruthy();
    expect(prompts.FAMILY_VOICE.religious).toBeTruthy();
    expect(prompts.FAMILY_VOICE.family).toBeTruthy();
    expect(prompts.FAMILY_VOICE.luxury).toBeTruthy();
  });

  test('every family has register + tone + DO + DONT + examples', () => {
    for (const family of ['educational', 'religious', 'family', 'luxury']) {
      const v = prompts.FAMILY_VOICE[family];
      expect(typeof v.register).toBe('string');
      expect(typeof v.tone).toBe('string');
      expect(Array.isArray(v.DO)).toBe(true);
      expect(Array.isArray(v.DONT)).toBe(true);
      expect(Array.isArray(v.examples)).toBe(true);
      expect(v.DO.length).toBeGreaterThanOrEqual(3);
      expect(v.DONT.length).toBeGreaterThanOrEqual(3);
      expect(v.examples.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('religious voice rules ban kid-friendly framing', () => {
    const v = prompts.FAMILY_VOICE.religious;
    const dontJoined = v.DONT.join(' ').toLowerCase();
    expect(dontJoined).toMatch(/kid|family-holiday/);
  });

  test('luxury voice rules ban superlatives and educational framing', () => {
    const v = prompts.FAMILY_VOICE.luxury;
    const dontJoined = v.DONT.join(' ').toLowerCase();
    expect(dontJoined).toMatch(/educational|academic|superlative|loud/);
  });

  test('family voice rules ban academic framing', () => {
    const v = prompts.FAMILY_VOICE.family;
    const dontJoined = v.DONT.join(' ').toLowerCase();
    expect(dontJoined).toMatch(/academic|educational|formal/);
  });

  test('educational voice rules ban casual / kid-friendly phrasing', () => {
    const v = prompts.FAMILY_VOICE.educational;
    const dontJoined = v.DONT.join(' ').toLowerCase();
    expect(dontJoined).toMatch(/casual|kid|fun/);
  });
});

describe('REGISTRATION_SLOT_MAP', () => {
  const REQUIRED_KEYS = [
    'personLabel', 'personPlaceholder',
    'showStudentFields', 'showSchoolField',
    'guardianLabel', 'guardianPlaceholder',
    'step1Title', 'step2Title', 'submitText',
  ];

  test('all 4 families have the full 9-key shape', () => {
    for (const family of ['educational', 'religious', 'family', 'luxury']) {
      const map = prompts.REGISTRATION_SLOT_MAP[family];
      for (const k of REQUIRED_KEYS) {
        expect(map[k]).toBeDefined();
      }
    }
  });

  test('educational asks student + parent', () => {
    const m = prompts.REGISTRATION_SLOT_MAP.educational;
    expect(m.personLabel).toMatch(/Student/i);
    expect(m.guardianLabel).toMatch(/Parent|Guardian/i);
    expect(m.showStudentFields).toBe(true);
    expect(m.showSchoolField).toBe(true);
  });

  test('religious asks pilgrim + mahram', () => {
    const m = prompts.REGISTRATION_SLOT_MAP.religious;
    expect(m.personLabel).toMatch(/Pilgrim/i);
    expect(m.guardianLabel).toMatch(/Mahram|Companion/i);
    expect(m.showStudentFields).toBe(false);
    expect(m.showSchoolField).toBe(false);
  });

  test('family asks lead member + headcount', () => {
    const m = prompts.REGISTRATION_SLOT_MAP.family;
    expect(m.personLabel).toMatch(/Family/i);
    expect(m.guardianLabel).toMatch(/Number|Travellers/i);
  });

  test('luxury asks guest + travel companion', () => {
    const m = prompts.REGISTRATION_SLOT_MAP.luxury;
    expect(m.personLabel).toMatch(/Name/i);
    expect(m.guardianLabel).toMatch(/Companion/i);
    expect(m.submitText).toMatch(/Application/i);
  });
});

describe('buildTeeContentPrompt — structure + threading', () => {
  function basicInput() {
    return {
      destination: 'Iceland Reykjavik',
      durationDays: 8,
      audience: 'couples photographers',
      tripType: 'luxury',
    };
  }
  function basicTeeOutput(over) {
    return {
      family: 'luxury',
      themeId: 'luxury-alpine',
      composition: ['nav', 'hero', 'marquee', 'cultural', 'investment', 'registration', 'faq', 'finalCta', 'contact', 'floatingCta'],
      traits: {
        climate: 'alpine', regionFeel: 'european', tripStyle: 'honeymoon',
        audienceTier: 'couples', luxuryLevel: 4, mood: 'minimal',
        visualMood: 'northern-aurora-mystical',
      },
      ...over,
    };
  }

  test('returns { system, user } strings', () => {
    const out = prompts.buildTeeContentPrompt({ teeOutput: basicTeeOutput(), input: basicInput() });
    expect(typeof out.system).toBe('string');
    expect(typeof out.user).toBe('string');
    expect(out.system.length).toBeGreaterThan(200);
    expect(out.user.length).toBeGreaterThan(50);
  });

  test('system prompt threads visualMood into voice + content guidance (R1)', () => {
    const out = prompts.buildTeeContentPrompt({ teeOutput: basicTeeOutput(), input: basicInput() });
    expect(out.system).toContain('northern-aurora-mystical');
    // The guidance lives directly in the system prompt — not a separate file.
    expect(out.system).toMatch(/HERO TONE|hero tone/i);
    expect(out.system).toMatch(/CTA LANGUAGE|cta language/i);
    expect(out.system).toMatch(/FAQ TONE|faq tone/i);
  });

  test('system prompt declares TEE inputs as AUTHORITATIVE (no LLM override)', () => {
    const out = prompts.buildTeeContentPrompt({ teeOutput: basicTeeOutput(), input: basicInput() });
    expect(out.system.toUpperCase()).toContain('AUTHORITATIVE');
    expect(out.system).toMatch(/NOT picking|NOT pick|DO NOT CHANGE/i);
  });

  test('system prompt includes family voice rules for the selected family', () => {
    // Luxury family — should warn against academic / superlative framing.
    const out = prompts.buildTeeContentPrompt({ teeOutput: basicTeeOutput(), input: basicInput() });
    expect(out.system.toLowerCase()).toContain('editorial restraint');
    expect(out.system.toLowerCase()).toContain('curated');
  });

  test('religious family prompt has reverent / scholar-led / pilgrim voice rules', () => {
    const tee = basicTeeOutput({
      family: 'religious', themeId: 'religious-classical',
      traits: { ...basicTeeOutput().traits, tripStyle: 'pilgrimage', visualMood: 'sacred-haram-dawn-stillness' },
    });
    const out = prompts.buildTeeContentPrompt({ teeOutput: tee, input: basicInput() });
    expect(out.system.toLowerCase()).toMatch(/reverent|scholar-led|pilgrim/);
    expect(out.system).toContain('sacred-haram-dawn-stillness');
  });

  test('educational family prompt has structured / parent-reassuring voice', () => {
    const tee = basicTeeOutput({
      family: 'educational', themeId: 'educational-academic',
      traits: { ...basicTeeOutput().traits, tripStyle: 'educational', visualMood: 'heritage-discipline-modern-velocity' },
    });
    const out = prompts.buildTeeContentPrompt({ teeOutput: tee, input: basicInput() });
    expect(out.system.toLowerCase()).toMatch(/structured|achievement|parent-reassuring|parent reassuring/);
  });

  test('family family prompt has vibrant / kid-friendly voice', () => {
    const tee = basicTeeOutput({
      family: 'family', themeId: 'family-tropical',
      traits: { ...basicTeeOutput().traits, tripStyle: 'family-holiday', visualMood: 'tropical-temple-surf' },
    });
    const out = prompts.buildTeeContentPrompt({ teeOutput: tee, input: basicInput() });
    expect(out.system.toLowerCase()).toMatch(/warm|vibrant|kid-friendly|kid friendly/);
  });

  test('system prompt restates guardrail bans (no pricing / testimonials / vendor names / image URLs)', () => {
    const out = prompts.buildTeeContentPrompt({ teeOutput: basicTeeOutput(), input: basicInput() });
    expect(out.system).toMatch(/NO monetary values|currency symbol|pricing/);
    expect(out.system).toMatch(/NO testimonial|testimonials/i);
    expect(out.system).toMatch(/NO image URL|posterUrl/);
    expect(out.system).toMatch(/NO vendor|brand|company names/i);
  });

  test('system prompt includes the JSON schema with critical slot shapes', () => {
    const out = prompts.buildTeeContentPrompt({ teeOutput: basicTeeOutput(), input: basicInput() });
    expect(out.system).toContain('"brand"');
    expect(out.system).toContain('"hero"');
    expect(out.system).toContain('"cultural"');
    expect(out.system).toContain('"safety"');
    expect(out.system).toContain('"faq"');
    expect(out.system).toContain('"finalCta"');
    // Schema explicitly notes stats[] for safety + featuredIndex / null
    // values for investment.tiers + 3-5 entries for FAQ items.
    expect(out.system).toContain('stats');
  });

  test('user prompt carries destination + duration + audience + tripType + travelMonth + subBrand', () => {
    const input = {
      destination: 'Iceland Reykjavik',
      durationDays: 8,
      audience: 'couples photographers',
      travelMonth: '2026-02',
      tripType: 'luxury',
      subBrand: 'travelstall',
    };
    const out = prompts.buildTeeContentPrompt({ teeOutput: basicTeeOutput(), input });
    expect(out.user).toContain('Iceland');
    expect(out.user).toContain('8');
    expect(out.user).toContain('couples');
    expect(out.user).toContain('2026-02');
    expect(out.user).toContain('luxury');
    expect(out.user).toContain('travelstall');
  });

  test('falls back to educational defaults when teeOutput.family is unknown', () => {
    const out = prompts.buildTeeContentPrompt({
      teeOutput: { family: 'unknown', traits: { visualMood: 'x' } },
      input: { destination: 'X' },
    });
    expect(out.system.toLowerCase()).toMatch(/structured|achievement/);
  });
});

describe('schemaFor', () => {
  test('returns a non-empty JSON-shaped schema string per family', () => {
    for (const f of ['educational', 'religious', 'family', 'luxury']) {
      const s = prompts.schemaFor(f);
      expect(typeof s).toBe('string');
      expect(s).toContain('"brand"');
      expect(s).toContain('"hero"');
    }
  });
});
