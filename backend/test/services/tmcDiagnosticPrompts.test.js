// Unit tests for backend/services/tmcDiagnosticPrompts.js — TMC diagnostic
// LLM prompt builders for Job A (readiness narrative) + Job B (sales brief)
// per PRD §3.7.
//
// Contract: pure functions
//   buildReadinessNarrativePrompt(input) → {task, system, user, messages, expectedFields=undefined}
//   buildSalesBriefPrompt(input)         → {task, system, user, messages, expectedFields=undefined}
//
// Both emit a {system, user} pair that hard-constrains the LLM to:
//   * Strict JSON output with the exact field names PRD §3.7 names
//     (6 for Job A; 7 for Job B).
//   * Standing-facts injection without invention (PRD §3.5.5).
//   * Board-policy-hook framing per Q6 (CBSE→NEP, IGCSE→Cambridge,
//     IB→CAS, ICSE/ISC→voluntary, State Board→generic) per §3.5.1.
//   * §11.3 calm-institutional voice / no manufactured urgency.
//   * §11.4 international figure honesty.
//   * Job A: NO destination words, NO numbers, NO board names in output
//     (downstream Layer 2 enforces — prompt pre-empts).
//   * Job B: NO invented destination / vendor / price.
//   * Deterministic — same inputs → byte-identical outputs.

import { describe, test, expect } from 'vitest';

const promptsModule = await import('../../services/tmcDiagnosticPrompts.js').then(
  (m) => m.default || m,
);

const {
  buildReadinessNarrativePrompt,
  buildSalesBriefPrompt,
  READINESS_NARRATIVE_FIELDS,
  SALES_BRIEF_FIELDS,
  TASK_READINESS_NARRATIVE,
  TASK_SALES_BRIEF,
  BOARD_HOOK_FRAMING,
  VOICE_RULES,
  HALLUCINATION_GUARDS_JOB_A,
  HALLUCINATION_GUARDS_JOB_B,
  resolveBoardFramings,
} = promptsModule;

// ── Fixtures ─────────────────────────────────────────────────────────

const STANDING_FACTS = {
  trust: {
    schools_served_since_2015: 'over 50',
    students_moved_since_2015: 'more than 100,000',
    students_moved_last_year: 14018,
    day_students_last_year: 12055,
    overnight_students_last_year: 1658,
    international_students_last_year: 305,
    operating_since: 2015,
    teacher_student_ratio: '1 teacher per 15 students',
    safety_record_line: 'TMC-supplied, must be defensible',
  },
  runway: {
    day: { lead_days: 7, display: 'about 1 week' },
    domestic_bus: { lead_days: 30, display: 'about 1 month' },
    domestic_flight: { lead_days: 90, display: 'minimum 90 days' },
    international: { lead_days: 180, display: 'minimum 4 to 6 months' },
  },
};

function cbseAnswers(overrides = {}) {
  return {
    primary_outcome: 'Confidence',
    secondary_skills: ['Empathy', 'Collaboration and teamwork'],
    growth_area: 'global_curiosity',
    travel_maturity: 'occasional_day',
    grade_band: '9-10',
    curriculum: 'CBSE',
    geo_preference: 'domestic',
    group_size: '35-45',
    budget_band: '30k-75k',
    timeline: 'next_term',
    school_profile: {
      school_name: 'St. Mary School',
      city: 'Pune',
      branches: '2',
      student_strength: '1000-2000',
      fee_band: '1lakh+',
    },
    contact: {
      contact_name: 'Asha Reddy',
      contact_role: 'Principal',
      email: 'asha@stmary.edu.in',
      phone: '9876543210',
    },
    ...overrides,
  };
}

const SAMPLE_ENGINE_OUTPUT = {
  state: 'strong_match',
  primary: { trip_id: 'golden-triangle', title: 'Golden Triangle' },
  alternative: { trip_id: 'mp-heritage', title: 'Madhya Pradesh' },
  flags: [],
  icpTier: 'breadwinning',
  leadQuality: 'clean',
  scores: { 'golden-triangle': 88, 'mp-heritage': 60 },
};

const SAMPLE_CATALOGUE_MATCHED = [
  {
    trip_id: 'golden-triangle',
    title: 'Golden Triangle',
    region: 'North India',
    price_band: '30k-75k',
    indicative_price_per_student: 42000,
    report_skill_blurb:
      'Real-world tasks build collaboration and resilience through varied site engagements that require students to plan, observe, and synthesize.',
    summary_for_brief: 'Heritage and culture circuit; strong on cultural respect + history hooks.',
    curriculum_hooks: [{ board: 'CBSE', grade_band: '9-10', subject: 'History', topic: 'Medieval India', hook_text: 'NCERT class 9-10' }],
  },
];

// ── Module shape ─────────────────────────────────────────────────────

describe('module shape', () => {
  test('exports both builders + field-name constants', () => {
    expect(typeof buildReadinessNarrativePrompt).toBe('function');
    expect(typeof buildSalesBriefPrompt).toBe('function');
    expect(Array.isArray(READINESS_NARRATIVE_FIELDS)).toBe(true);
    expect(Array.isArray(SALES_BRIEF_FIELDS)).toBe(true);
    expect(typeof TASK_READINESS_NARRATIVE).toBe('string');
    expect(typeof TASK_SALES_BRIEF).toBe('string');
  });

  test('READINESS_NARRATIVE_FIELDS has the 6 PRD §3.7 Job A keys exactly', () => {
    expect(READINESS_NARRATIVE_FIELDS).toEqual([
      'ambition_restatement',
      'readiness_profile',
      'what_becomes_possible',
      'cost_of_waiting',
      'institutional_benefit',
      'assurance_framing',
    ]);
  });

  test('SALES_BRIEF_FIELDS has the 7 PRD §3.7 Job B keys exactly', () => {
    expect(SALES_BRIEF_FIELDS).toEqual([
      'lead_quality_summary',
      'what_school_wants',
      'primary_rationale',
      'alternative_rationale',
      'positioning_notes',
      'custom_concept_note_or_empty',
      'flags_to_action',
    ]);
  });

  test('BOARD_HOOK_FRAMING covers all PRD §3.5.1 boards', () => {
    expect(BOARD_HOOK_FRAMING).toHaveProperty('CBSE');
    expect(BOARD_HOOK_FRAMING).toHaveProperty('IGCSE');
    expect(BOARD_HOOK_FRAMING).toHaveProperty('IB');
    expect(BOARD_HOOK_FRAMING).toHaveProperty('State Board');
    // ICSE/ISC may live as one or many keys; accept either
    expect(
      BOARD_HOOK_FRAMING['ICSE/ISC'] || BOARD_HOOK_FRAMING['ICSE'],
    ).toBeTruthy();
  });
});

// ── Job A — Readiness narrative ──────────────────────────────────────

describe('buildReadinessNarrativePrompt — envelope shape', () => {
  test('returns {task, system, user, messages} with non-empty strings', () => {
    const out = buildReadinessNarrativePrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      catalogueMatched: SAMPLE_CATALOGUE_MATCHED,
      standingFactsConfig: STANDING_FACTS,
    });
    expect(out.task).toBe(TASK_READINESS_NARRATIVE);
    expect(typeof out.system).toBe('string');
    expect(out.system.length).toBeGreaterThan(100);
    expect(typeof out.user).toBe('string');
    expect(out.user.length).toBeGreaterThan(50);
    expect(Array.isArray(out.messages)).toBe(true);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toEqual({ role: 'user', content: out.user });
  });

  test('system prompt names all 6 Job A JSON fields by exact key', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers(),
      standingFactsConfig: STANDING_FACTS,
    });
    for (const field of READINESS_NARRATIVE_FIELDS) {
      expect(system).toContain(field);
    }
  });

  test('system prompt demands strict JSON (no markdown fences, no preamble)', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers(),
      standingFactsConfig: STANDING_FACTS,
    });
    // pin the exact phrases the prompt uses to fence the model
    expect(system).toMatch(/STRICT JSON/);
    expect(system).toMatch(/no markdown fences/i);
  });
});

describe('buildReadinessNarrativePrompt — standing-facts injection (PRD §3.5.5)', () => {
  test('user prompt embeds the trust numbers verbatim so model knows NOT to invent them', () => {
    const { user } = buildReadinessNarrativePrompt({
      answers: cbseAnswers(),
      standingFactsConfig: STANDING_FACTS,
    });
    // International figure (PRD §11.4) appears in the injected config
    expect(user).toContain('305');
    // Last-year figure appears literally
    expect(user).toContain('14018');
    // Runway display strings appear
    expect(user).toContain('minimum 4 to 6 months');
  });

  test('system prompt forbids the LLM from writing ANY number', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers(),
      standingFactsConfig: STANDING_FACTS,
    });
    // Layer-2 number-check pre-emption
    expect(system).toMatch(/NEVER produce a number/);
  });
});

describe('buildReadinessNarrativePrompt — board framing branches (PRD §3.5.1)', () => {
  test('CBSE input embeds NEP/NCF framing context (renderer injects, LLM does not write)', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers({ curriculum: 'CBSE' }),
      standingFactsConfig: STANDING_FACTS,
    });
    // PRE-EMPTIVE board-framing-context line
    expect(system).toContain('CBSE');
    // CBSE-mapped phrase from BOARD_HOOK_FRAMING
    expect(system).toMatch(/NEP 2020|NCF-SE/);
  });

  test('IGCSE input embeds Cambridge Learner Attributes framing', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers({ curriculum: 'IGCSE' }),
      standingFactsConfig: STANDING_FACTS,
    });
    expect(system).toMatch(/Cambridge Learner Attributes/);
  });

  test('IB input embeds CAS/Learner-Profile framing', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers({ curriculum: 'IB' }),
      standingFactsConfig: STANDING_FACTS,
    });
    expect(system).toMatch(/CAS/);
    expect(system).toMatch(/Learner Profile/);
  });

  test('ICSE/ISC input embeds CISCE voluntary-alignment framing', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers({ curriculum: 'ICSE/ISC' }),
      standingFactsConfig: STANDING_FACTS,
    });
    expect(system).toMatch(/CISCE|voluntary|SUPW/);
  });

  test('Unknown / no-board input falls back to generic copy notice', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers({ curriculum: null }),
      standingFactsConfig: STANDING_FACTS,
    });
    expect(system).toMatch(/did not name a recognised board|generic/);
  });

  test('Multi-board (array) input stacks framings', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers({ curriculum: ['CBSE', 'IB'] }),
      standingFactsConfig: STANDING_FACTS,
    });
    expect(system).toMatch(/NEP 2020|NCF-SE/);
    expect(system).toMatch(/CAS/);
  });

  test('IB school NEVER sees NEP framing (PRD AC-3 + §3.5.1 NEP-CBSE-only rule)', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers({ curriculum: 'IB' }),
      standingFactsConfig: STANDING_FACTS,
    });
    // Extract just the Board-framing context LINE (single line — multiline-aware).
    // The IB framing line must NOT mention NEP 2020 or NCF (NEP-CBSE-only rule).
    const lines = system.split('\n');
    const ibLine = lines.find((l) => l.startsWith('Board-framing context'));
    expect(ibLine).toBeTruthy();
    expect(ibLine).not.toMatch(/NEP 2020/);
    expect(ibLine).not.toMatch(/NCF-SE/);
    // And it should still carry the IB framing
    expect(ibLine).toMatch(/CAS/);
  });
});

describe('buildReadinessNarrativePrompt — Layer-2 strip-check pre-emption (PRD §3.7.1)', () => {
  test('destination blocklist passed through as "do not mention" instruction', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers(),
      standingFactsConfig: STANDING_FACTS,
      destinationBlocklist: ['Europe', 'Amsterdam canals', 'Egypt pyramids'],
    });
    expect(system).toMatch(/Forbidden destination tokens/);
    expect(system).toContain('Europe');
    expect(system).toContain('Amsterdam canals');
    expect(system).toContain('Egypt pyramids');
  });

  test('empty blocklist defaults to a "ALL place names" forbid instruction', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers(),
      standingFactsConfig: STANDING_FACTS,
      destinationBlocklist: [],
    });
    expect(system).toMatch(/ALL place names|cities|countries/);
  });

  test('board-term strip pre-emption — system forbids writing NEP/CBSE/IB/IGCSE/CAS', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers(),
      standingFactsConfig: STANDING_FACTS,
    });
    // The hallucination-guard block must explicitly list the board policy
    // names the LLM is not allowed to produce — strip-check downstream
    // catches violations, prompt pre-empts.
    expect(system).toMatch(/NEVER name a curriculum board/);
    expect(system).toMatch(/NEP/);
    expect(system).toMatch(/CBSE/);
    expect(system).toMatch(/IB/);
    expect(system).toMatch(/CAS/);
  });

  test('engine output is stripped of trip names/IDs in the prompt context', () => {
    const { user } = buildReadinessNarrativePrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      catalogueMatched: SAMPLE_CATALOGUE_MATCHED,
      standingFactsConfig: STANDING_FACTS,
    });
    // The Engine context block must NOT contain the trip_id or title —
    // PRD §3.7 Job A inputs are "school's answers + report_skill_blurb"
    // ONLY. Trip names + destinations are intentionally stripped.
    const engineSection = user.split('Engine context')[1].split('Catalogue narrative blurbs')[0];
    expect(engineSection).not.toContain('golden-triangle');
    expect(engineSection).not.toContain('Golden Triangle');
  });
});

describe('buildReadinessNarrativePrompt — voice rules (PRD §11.3 + §11.4)', () => {
  test('calm-institutional voice rule appears in the system prompt', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers(),
      standingFactsConfig: STANDING_FACTS,
    });
    // PRD §11.3 calm-institutional pinning — match the load-bearing
    // phrase "calm" + "institutional" anywhere in the system prompt.
    expect(system).toMatch(/calm/i);
    expect(system).toMatch(/institutional/i);
  });

  test('no-manufactured-urgency rule appears in the system prompt', () => {
    const { system } = buildReadinessNarrativePrompt({
      answers: cbseAnswers(),
      standingFactsConfig: STANDING_FACTS,
    });
    expect(system).toMatch(/manufactured pressure|countdown timer|three slots left/);
  });
});

describe('buildReadinessNarrativePrompt — determinism', () => {
  test('same inputs produce byte-identical {system, user} on repeat calls', () => {
    const input = {
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      catalogueMatched: SAMPLE_CATALOGUE_MATCHED,
      standingFactsConfig: STANDING_FACTS,
      destinationBlocklist: ['Europe'],
    };
    const a = buildReadinessNarrativePrompt(input);
    const b = buildReadinessNarrativePrompt(input);
    expect(a.system).toBe(b.system);
    expect(a.user).toBe(b.user);
  });

  test('handles empty / null inputs without crashing (graceful defaults)', () => {
    const a = buildReadinessNarrativePrompt({});
    expect(a.task).toBe(TASK_READINESS_NARRATIVE);
    expect(typeof a.system).toBe('string');
    expect(typeof a.user).toBe('string');

    const b = buildReadinessNarrativePrompt(null);
    expect(b.task).toBe(TASK_READINESS_NARRATIVE);
    expect(typeof b.system).toBe('string');
  });
});

// ── Job B — Sales brief ──────────────────────────────────────────────

describe('buildSalesBriefPrompt — envelope shape', () => {
  test('returns {task, system, user, messages} with non-empty strings', () => {
    const out = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      catalogueMatched: SAMPLE_CATALOGUE_MATCHED,
      leadQuality: 'clean',
      icpTier: 'breadwinning',
    });
    expect(out.task).toBe(TASK_SALES_BRIEF);
    expect(typeof out.system).toBe('string');
    expect(out.system.length).toBeGreaterThan(100);
    expect(typeof out.user).toBe('string');
    expect(out.messages).toEqual([{ role: 'user', content: out.user }]);
  });

  test('system prompt names all 7 Job B JSON fields by exact key', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      catalogueMatched: SAMPLE_CATALOGUE_MATCHED,
    });
    for (const field of SALES_BRIEF_FIELDS) {
      expect(system).toContain(field);
    }
  });

  test('system prompt demands strict JSON output (no fences)', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
    });
    expect(system).toMatch(/STRICT JSON/);
    expect(system).toMatch(/no markdown fences/i);
  });
});

describe('buildSalesBriefPrompt — lead-quality + ICP branches (PRD §3.6 + DD-5.6)', () => {
  test('suspect lead surfaces "Review before contact, low-confidence lead" framing in system prompt', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      leadQuality: 'suspect',
      icpTier: 'breadwinning',
    });
    expect(system).toMatch(/Review before contact, low-confidence lead/);
    expect(system).toMatch(/drops below all clean leads/);
  });

  test('clean lead does NOT carry the suspect branch-conditional framing', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      leadQuality: 'clean',
      icpTier: 'breadwinning',
    });
    // The phrase "Review before contact, low-confidence lead" appears in the
    // JSON-shape description as the suspect-case example copy regardless of
    // branch — that's correct (it tells the model what to write IF suspect).
    // What MUST NOT appear in the clean branch is the dynamic conditional
    // line "LEAD QUALITY: SUSPECT — Lead the brief with …".
    expect(system).not.toMatch(/LEAD QUALITY: SUSPECT/);
    expect(system).not.toMatch(/drops below all clean leads/);
    expect(system).toMatch(/Lead quality: clean/);
  });

  test('lead quality + reasons appear in the USER prompt context block', () => {
    const { user } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: { ...SAMPLE_ENGINE_OUTPUT, leadQuality: 'suspect' },
      leadQuality: 'suspect',
    });
    expect(user).toMatch(/Lead quality:.*suspect/);
  });

  test('ICP tier "amazing" gets highest-priority framing in system prompt', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      icpTier: 'amazing',
    });
    expect(system).toMatch(/Highest sales priority/);
  });

  test('ICP tier "breadwinning" gets high-priority framing', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      icpTier: 'breadwinning',
    });
    expect(system).toMatch(/High sales priority/);
  });

  test('ICP tier "dangerous" gets the avoid-with-flag framing', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      icpTier: 'dangerous',
    });
    expect(system).toMatch(/Avoid/);
  });

  test('ICP tier "unclassified" routes as breadwinning + flags for review', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      icpTier: 'unclassified',
    });
    expect(system).toMatch(/Unclassified|breadwinning by default/);
  });

  test('ICP tier falls back from engineOutput when not passed explicitly', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: { ...SAMPLE_ENGINE_OUTPUT, icpTier: 'convenience' },
    });
    expect(system).toMatch(/Low priority/);
  });
});

describe('buildSalesBriefPrompt — hallucination guards (PRD §3.7 + §11.4)', () => {
  test('forbids inventing destinations / vendors / prices not in catalogue', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
    });
    expect(system).toMatch(/NEVER invent a destination, vendor, price/);
  });

  test('no_match → custom_concept must be built around nearest REAL product', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: { ...SAMPLE_ENGINE_OUTPUT, state: 'no_match' },
    });
    expect(system).toMatch(/nearest real product|NEAREST REAL product/);
    expect(system).toMatch(/concept to scope on the call/);
  });

  test('international figure honesty rule (PRD §11.4) appears in system prompt', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
    });
    // emerging-tier framing reference
    expect(system).toMatch(/emerging|305/);
  });

  test('voice rules carried into Job B too', () => {
    const { system } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
    });
    expect(system).toMatch(/calm/i);
    expect(system).toMatch(/institutional/i);
    expect(system).toMatch(/manufactured pressure/);
  });
});

describe('buildSalesBriefPrompt — input embedding', () => {
  test('full engine output (including trip names) is embedded in user prompt — Job B is internal', () => {
    const { user } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      catalogueMatched: SAMPLE_CATALOGUE_MATCHED,
    });
    // Unlike Job A, Job B SHOULD see destinations + prices + trip IDs
    // because it's internal-only and the executive needs them.
    expect(user).toContain('golden-triangle');
    expect(user).toContain('Golden Triangle');
    expect(user).toContain('42000'); // indicative_price_per_student
  });

  test('catalogue summary_for_brief is embedded (internal-only context)', () => {
    const { user } = buildSalesBriefPrompt({
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      catalogueMatched: SAMPLE_CATALOGUE_MATCHED,
    });
    expect(user).toContain('Heritage and culture circuit');
  });
});

describe('buildSalesBriefPrompt — determinism', () => {
  test('same inputs produce byte-identical {system, user} on repeat calls', () => {
    const input = {
      answers: cbseAnswers(),
      engineOutput: SAMPLE_ENGINE_OUTPUT,
      catalogueMatched: SAMPLE_CATALOGUE_MATCHED,
      leadQuality: 'clean',
      icpTier: 'breadwinning',
    };
    const a = buildSalesBriefPrompt(input);
    const b = buildSalesBriefPrompt(input);
    expect(a.system).toBe(b.system);
    expect(a.user).toBe(b.user);
  });

  test('handles empty / null inputs without crashing', () => {
    const a = buildSalesBriefPrompt({});
    expect(a.task).toBe(TASK_SALES_BRIEF);
    expect(typeof a.system).toBe('string');

    const b = buildSalesBriefPrompt(null);
    expect(b.task).toBe(TASK_SALES_BRIEF);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────

describe('resolveBoardFramings — Q6 multi-select normalisation', () => {
  test('single board string returns single framing', () => {
    const out = resolveBoardFramings('CBSE');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/NEP/);
  });

  test('array input maps each recognised board', () => {
    const out = resolveBoardFramings(['CBSE', 'IB']);
    expect(out).toHaveLength(2);
  });

  test('unrecognised boards are dropped silently', () => {
    const out = resolveBoardFramings(['CBSE', 'made-up-board']);
    expect(out).toHaveLength(1);
  });

  test('empty / null returns empty array', () => {
    expect(resolveBoardFramings(null)).toEqual([]);
    expect(resolveBoardFramings(undefined)).toEqual([]);
    expect(resolveBoardFramings('')).toEqual([]);
    expect(resolveBoardFramings([])).toEqual([]);
  });
});

// ── Shared constants ────────────────────────────────────────────────

describe('exported voice + guard constants', () => {
  test('VOICE_RULES is non-empty array of strings', () => {
    expect(Array.isArray(VOICE_RULES)).toBe(true);
    expect(VOICE_RULES.length).toBeGreaterThan(0);
    for (const rule of VOICE_RULES) {
      expect(typeof rule).toBe('string');
    }
  });

  test('HALLUCINATION_GUARDS_JOB_A bans destinations / numbers / board-policy names', () => {
    const joined = HALLUCINATION_GUARDS_JOB_A.join('\n');
    expect(joined).toMatch(/NEVER name a destination/);
    expect(joined).toMatch(/NEVER produce a number/);
    expect(joined).toMatch(/NEVER name a curriculum board/);
  });

  test('HALLUCINATION_GUARDS_JOB_B bans inventing destinations / vendors / prices', () => {
    const joined = HALLUCINATION_GUARDS_JOB_B.join('\n');
    expect(joined).toMatch(/NEVER invent a destination, vendor, price/);
  });
});
