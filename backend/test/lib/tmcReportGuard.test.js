// Unit tests for backend/lib/tmcReportGuard.js — TMC report 3-layer guardrail
// per PRD §3.7.1.
//
// Contract: pure function `guardReportOutput(jobKey, llmOutput, opts) →
// {layer, accepted, output, reasons}`. 3 layers: (1) schema validation, (2)
// content strip-check (destination blocklist / number check / board-term
// check / restricted-word check), (3) deterministic template fallback.
//
// These tests pin BOTH the per-check firing/non-firing behaviour AND the
// fallback template shape (so the downstream renderer in T8 cannot crash on
// a missing field even when the LLM output is wholesale rejected).
//
// The PRD's load-bearing invariants pinned here:
//   - Layer 1 schema is exact-fields (6 for Job A / 7 for Job B); extra
//     fields are rejected (strict mode).
//   - Layer 2 number check has the §11.4 honest-at-305 carve-out + the
//     §3.5.5 standing-facts whitelist.
//   - Layer 2 board-term check covers all 11 PRD §3.7.1 board terms.
//   - Layer 3 fallback is filled from school answers + standing config, not
//     from LLM text — guarantees the renderer never sees ungoverned output
//     OR an empty section (NF-4 + NF-8).

import { describe, test, expect } from 'vitest';

const {
  guardReportOutput,
  JOB_A_FIELDS,
  JOB_B_FIELDS,
  DEFAULT_BOARD_TERMS,
  DEFAULT_RESTRICTED_WORDS,
  HONEST_NUMBERS_WHITELIST,
  validateSchema,
  checkContent,
  buildJobAFallback,
  buildJobBFallback,
  extractIntegers,
  extractSpelledIntegers,
  makeWholeWordRegex,
} = await import('../../lib/tmcReportGuard.js').then((m) => m.default || m);

// ---------------------------------------------------------------------------
// Test fixtures — valid Job A / Job B outputs that pass all 3 layers.

function makeValidJobAOutput() {
  return {
    ambition_restatement:
      'You named building independent thinkers as your central goal, supported by communication and resilience.',
    readiness_profile:
      'Your students have room to grow in their ability to operate without scaffolding. Experiential learning shapes this by removing the safety net briefly and asking them to apply judgement.',
    what_becomes_possible:
      'Three pathways open by what each one produces. A short structured day reveals first practice; an extended residential builds endurance; an extended cross-cultural arc reshapes how a student sees themselves as a citizen.',
    cost_of_waiting:
      'The gap you named does not wait. Each cohort that moves through without addressing it carries the same shape into the next year.',
    institutional_benefit:
      'Schools that build this into the academic calendar see it in their student outcomes, in parent satisfaction, and in admissions conversations.',
    assurance_framing:
      'Four concerns sit between any school and a successful trip: safety, reputation, governance, and parent acceptance. Each is addressed below with a fact.',
  };
}

function makeValidJobBOutput() {
  return {
    lead_quality_summary:
      'Routing as standard priority — answers show a thoughtful intent without contradictory profile signals.',
    what_school_wants:
      'A residential experience that builds resilience and self-management for the senior cohort, with growth focused on independent thinking.',
    primary_rationale:
      'The primary recommendation matches the school’s stated outcome and pairs the chosen growth area with the right structural setting per the engine signals.',
    alternative_rationale:
      'The alternative offers a lower-commitment structure on the same outcome — useful as a fallback if budget or runway becomes a blocker.',
    positioning_notes:
      'Anchor the conversation on the named growth area, then walk the school through the two options as a structured choice.',
    custom_concept_note_or_empty: '',
    flags_to_action: ['thin_alternative'],
  };
}

function makeSchoolAnswers() {
  return {
    primary_outcome: 'building independent thinkers',
    secondary_skills: ['communication', 'resilience'],
    growth_area: 'self-management',
  };
}

// ---------------------------------------------------------------------------
// Layer 1 — Schema validation

describe('Layer 1 — schema validation', () => {
  test('Job A: valid output with all 6 fields → accepted, layer=1', () => {
    const output = makeValidJobAOutput();
    const result = guardReportOutput('A', output, {});
    expect(result.layer).toBe(1);
    expect(result.accepted).toBe(true);
    expect(result.output).toBe(output); // same reference — no mutation
    expect(result.reasons).toEqual([]);
  });

  test('Job B: valid output with all 7 fields → accepted, layer=1', () => {
    const output = makeValidJobBOutput();
    const result = guardReportOutput('B', output, {});
    expect(result.layer).toBe(1);
    expect(result.accepted).toBe(true);
    expect(result.output).toBe(output);
    expect(result.reasons).toEqual([]);
  });

  test('Job A: missing required field → layer=3, output=fallback, reason recorded', () => {
    const output = makeValidJobAOutput();
    delete output.assurance_framing;
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain('schema.missing_field:assurance_framing');
    // Fallback object MUST have all 6 Job A fields so the renderer can't crash.
    for (const field of JOB_A_FIELDS) {
      expect(result.output).toHaveProperty(field);
      expect(typeof result.output[field]).toBe('string');
    }
  });

  test('Job A: wrong-type field (number where string expected) → layer=3', () => {
    const output = makeValidJobAOutput();
    output.readiness_profile = 12345;
    const result = guardReportOutput('A', output, {});
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('schema.wrong_type:readiness_profile');
  });

  test('Job B: extra unexpected field → layer=3 (strict mode)', () => {
    const output = makeValidJobBOutput();
    output.invented_destination = 'Sri Lanka';
    const result = guardReportOutput('B', output, {});
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('schema.unexpected_field:invented_destination');
  });

  test('Job B: flags_to_action must be array<string>; string fails type-check', () => {
    const output = makeValidJobBOutput();
    output.flags_to_action = 'thin_alternative';
    const result = guardReportOutput('B', output, {});
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('schema.wrong_type:flags_to_action');
  });

  test('Layer 1: non-object (null) input → layer=3 immediately', () => {
    const result = guardReportOutput('A', null, {});
    expect(result.layer).toBe(3);
    expect(result.reasons).toEqual(['schema.not_object']);
  });

  test('Layer 1: array input is not a valid object → layer=3', () => {
    const result = guardReportOutput('A', ['some', 'array'], {});
    expect(result.layer).toBe(3);
    expect(result.reasons).toEqual(['schema.not_object']);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Destination blocklist

describe('Layer 2 — destination blocklist', () => {
  test('catalogue has "Sri Lanka" archived; LLM mentions it → REJECT', () => {
    const output = makeValidJobAOutput();
    output.what_becomes_possible += ' One pathway recalls trips to Sri Lanka.';
    const result = guardReportOutput('A', output, {
      destinationBlocklist: ['Sri Lanka', 'Europe', 'the canals of Amsterdam'],
      schoolAnswers: makeSchoolAnswers(),
    });
    expect(result.layer).toBe(3);
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain('destination_blocklist:Sri Lanka');
  });

  test('multi-word phrase "the canals of Amsterdam" with case insensitivity', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting = 'Picture The Canals Of Amsterdam in your mind';
    const result = guardReportOutput('A', output, {
      destinationBlocklist: ['the canals of Amsterdam'],
      schoolAnswers: makeSchoolAnswers(),
    });
    expect(result.layer).toBe(3);
    expect(result.reasons.some((r) => r.startsWith('destination_blocklist:'))).toBe(true);
  });

  test('LLM output stays in "active" territory; not in blocklist → PASS Layer 2', () => {
    const output = makeValidJobAOutput();
    // No destination mention whatsoever in the valid fixture.
    const result = guardReportOutput('A', output, {
      destinationBlocklist: ['Sri Lanka', 'Europe'],
    });
    expect(result.layer).toBe(1);
    expect(result.accepted).toBe(true);
  });

  test('empty destinationBlocklist → no destination check fires', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' Even Sri Lanka would be reachable.';
    const result = guardReportOutput('A', output, {
      destinationBlocklist: [],
    });
    expect(result.layer).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Number check (honest-at-305)

describe('Layer 2 — number check', () => {
  test('LLM invents "200 international students" → REJECT', () => {
    const output = makeValidJobAOutput();
    output.what_becomes_possible += ' We moved 200 international students last year.';
    const result = guardReportOutput('A', output, {
      schoolAnswers: makeSchoolAnswers(),
    });
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('invented_number:200');
  });

  test('LLM mentions "305 international students" → ACCEPT (honest-at-305 whitelist)', () => {
    const output = makeValidJobAOutput();
    output.what_becomes_possible += ' 305 international students moved last year.';
    const result = guardReportOutput('A', output, {});
    expect(result.layer).toBe(1);
    expect(result.accepted).toBe(true);
  });

  test('LLM mentions standing facts (14,018 / 12,055 / 1,658) → ACCEPT', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting +=
      ' Last year 14,018 students moved (12,055 day, 1,658 overnight).';
    const result = guardReportOutput('A', output, {});
    expect(result.layer).toBe(1);
    expect(result.accepted).toBe(true);
  });

  test('LLM mentions an invented year like "2030" → REJECT (not in whitelist)', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' By 2030 every school will need this.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('invented_number:2030');
  });

  test('LLM mentions "since 2015" → ACCEPT (operating-since year on whitelist)', () => {
    const output = makeValidJobAOutput();
    output.institutional_benefit = output.institutional_benefit + ' Since 2015 this pattern has held.';
    const result = guardReportOutput('A', output, {});
    expect(result.layer).toBe(1);
  });

  test('caller can override the honestNumbersWhitelist', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' By 2030 the calendar will be different.';
    const result = guardReportOutput('A', output, {
      honestNumbersWhitelist: [...HONEST_NUMBERS_WHITELIST, 2030],
    });
    expect(result.layer).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Board-term check

describe('Layer 2 — board-term check', () => {
  test('LLM uses "NEP" anywhere → REJECT (board hook is renderer-injected)', () => {
    const output = makeValidJobAOutput();
    output.institutional_benefit += ' NEP supports this approach.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('board_term:NEP');
  });

  test('LLM uses "CBSE" → REJECT (board hook is renderer-injected)', () => {
    const output = makeValidJobAOutput();
    output.institutional_benefit += ' CBSE schools see this benefit clearly.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('board_term:CBSE');
  });

  test('LLM uses "CAS" (IB-only term) → REJECT', () => {
    const output = makeValidJobBOutput();
    output.positioning_notes += ' Position around CAS hours.';
    const result = guardReportOutput('B', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('board_term:CAS');
  });

  test('all 11 PRD board terms are in DEFAULT_BOARD_TERMS', () => {
    const expected = ['NEP', 'CBSE', 'ICSE', 'ISC', 'IGCSE', 'IB', 'Cambridge', 'CISCE', 'CAS', 'SUPW', 'NCF'];
    for (const term of expected) {
      expect(DEFAULT_BOARD_TERMS).toContain(term);
    }
    expect(DEFAULT_BOARD_TERMS.length).toBe(11);
  });

  test('caller can override boardTerms (e.g. tighten or relax)', () => {
    const output = makeValidJobAOutput();
    output.institutional_benefit += ' NEP is a real framework.';
    // Override with empty list → no board terms fire.
    const result = guardReportOutput('A', output, { boardTerms: [] });
    expect(result.layer).toBe(1);
  });

  test('whole-word match: "carbon" should not trigger "CAS" (substring false-positive avoided)', () => {
    const output = makeValidJobAOutput();
    output.institutional_benefit += ' Carbon footprint is relevant.';
    const result = guardReportOutput('A', output, {});
    // Should pass — "carbon" includes "cas" but not as a whole-word match.
    // Note: "carbon" does contain "Cas" substring but our whole-word regex blocks that.
    expect(result.layer).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — Restricted-word check

describe('Layer 2 — restricted-word check', () => {
  test('LLM uses "urgent" → REJECT (calm-institutional voice)', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' This is urgent.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    expect(result.reasons.some((r) => r.startsWith('restricted_word:'))).toBe(true);
  });

  test('LLM uses "limited time offer" → REJECT (substring match)', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' This is a limited time offer for senior students.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('restricted_word:limited time');
  });

  test('LLM uses "guaranteed" → REJECT', () => {
    const output = makeValidJobAOutput();
    output.what_becomes_possible += ' Outcomes guaranteed.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    expect(result.reasons.some((r) => r.startsWith('restricted_word:'))).toBe(true);
  });

  test('caller can extend restrictedWords (additive to defaults)', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' This is a fantastic opportunity.';
    const result = guardReportOutput('A', output, {
      restrictedWords: ['fantastic', 'opportunity'],
      schoolAnswers: makeSchoolAnswers(),
    });
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('restricted_word:fantastic');
  });

  test('caller can override restrictedWords (replaces defaults)', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' This is urgent business.';
    const result = guardReportOutput('A', output, {
      restrictedWordsOverride: ['fantastic'], // 'urgent' is now allowed
    });
    expect(result.layer).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — Fallback template shape

describe('Layer 3 — fallback templates', () => {
  test('Job A fallback has all 6 expected fields as non-empty strings', () => {
    const fallback = buildJobAFallback({ schoolAnswers: makeSchoolAnswers() });
    for (const field of JOB_A_FIELDS) {
      expect(fallback).toHaveProperty(field);
      expect(typeof fallback[field]).toBe('string');
      expect(fallback[field].length).toBeGreaterThan(0);
    }
  });

  test('Job B fallback has all 7 expected fields with correct types', () => {
    const fallback = buildJobBFallback({ schoolAnswers: { flags: ['suspect'] }, leadQuality: 'suspect' });
    for (const field of JOB_B_FIELDS) {
      expect(fallback).toHaveProperty(field);
    }
    for (const field of JOB_B_FIELDS) {
      if (field === 'flags_to_action') {
        expect(Array.isArray(fallback[field])).toBe(true);
      } else {
        expect(typeof fallback[field]).toBe('string');
      }
    }
  });

  test('Job A fallback embeds school answers (Q1 + Q2 skills + Q3 growth area)', () => {
    const fallback = buildJobAFallback({
      schoolAnswers: {
        primary_outcome: 'foo-outcome',
        secondary_skills: ['skill-alpha', 'skill-beta'],
        growth_area: 'growth-zeta',
      },
    });
    expect(fallback.ambition_restatement).toContain('foo-outcome');
    expect(fallback.ambition_restatement).toContain('skill-alpha');
    expect(fallback.ambition_restatement).toContain('skill-beta');
    expect(fallback.readiness_profile).toContain('growth-zeta');
    expect(fallback.cost_of_waiting).toContain('growth-zeta');
  });

  test('Job A fallback contains NO board terms or invented numbers', () => {
    const fallback = buildJobAFallback({ schoolAnswers: makeSchoolAnswers() });
    const concatenated = Object.values(fallback).join(' ');
    for (const term of DEFAULT_BOARD_TERMS) {
      expect(makeWholeWordRegex(term).test(concatenated)).toBe(false);
    }
    const integers = extractIntegers(concatenated);
    for (const n of integers) {
      expect(HONEST_NUMBERS_WHITELIST).toContain(n);
    }
  });

  test('Job B fallback signals "LLM brief unavailable" so executive routes via engine output', () => {
    const fallback = buildJobBFallback({ schoolAnswers: { flags: [] } });
    expect(fallback.positioning_notes.toLowerCase()).toContain('unavailable');
  });

  test('Job A fallback gracefully handles missing schoolAnswers', () => {
    const fallback = buildJobAFallback({});
    for (const field of JOB_A_FIELDS) {
      expect(typeof fallback[field]).toBe('string');
      expect(fallback[field].length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Reasons array — multi-reason enumeration

describe('Reasons array — multi-fault enumeration', () => {
  test('multiple Layer-2 violations all appear in reasons[]', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' This is urgent — Sri Lanka calls. 500 students moved.';
    const result = guardReportOutput('A', output, {
      destinationBlocklist: ['Sri Lanka'],
      schoolAnswers: makeSchoolAnswers(),
    });
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('destination_blocklist:Sri Lanka');
    expect(result.reasons).toContain('invented_number:500');
    expect(result.reasons.some((r) => r.startsWith('restricted_word:'))).toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });

  test('Layer 1 failures short-circuit Layer 2 (no double-report)', () => {
    const output = { ambition_restatement: 'NEP is great' }; // missing 5 fields + has board term
    const result = guardReportOutput('A', output, {});
    expect(result.layer).toBe(3);
    // Reasons should be schema-only — board-term check shouldn't have run.
    for (const r of result.reasons) {
      expect(r.startsWith('schema.')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Public entry point — input-validation guardrails

describe('guardReportOutput — input validation', () => {
  test('invalid jobKey throws', () => {
    expect(() => guardReportOutput('C', {}, {})).toThrow(/jobKey/);
  });

  test('jobKey is case-sensitive', () => {
    expect(() => guardReportOutput('a', {}, {})).toThrow(/jobKey/);
  });

  test('opts is optional (defaults work)', () => {
    const output = makeValidJobAOutput();
    const result = guardReportOutput('A', output);
    expect(result.layer).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Helper functions — direct unit tests

describe('Helper: extractIntegers', () => {
  test('extracts 3+ digit integers', () => {
    expect(extractIntegers('moved 305 students')).toEqual(['305']);
    expect(extractIntegers('14,018 total')).toEqual(['14018']);
    expect(extractIntegers('14,018 + 12,055 + 1,658')).toEqual(['14018', '12055', '1658']);
  });

  test('ignores 1-2 digit integers', () => {
    // 12 is not 3+ digits → ignored. 100 IS 3+ digits → extracted.
    expect(extractIntegers('only 5 of 12 schools')).toEqual([]);
    expect(extractIntegers('about 100 schools')).toEqual(['100']);
  });

  test('non-string input returns []', () => {
    expect(extractIntegers(null)).toEqual([]);
    expect(extractIntegers(undefined)).toEqual([]);
    expect(extractIntegers(42)).toEqual([]);
  });
});

describe('Helper: makeWholeWordRegex', () => {
  test('matches "NEP" but not "INEPT"', () => {
    const re = makeWholeWordRegex('NEP');
    expect(re.test('NEP framework')).toBe(true);
    expect(re.test('framework NEP')).toBe(true);
    expect(re.test('inside NEP curriculum')).toBe(true);
    expect(re.test('INEPT players')).toBe(false);
  });

  test('matches multi-word phrases like "Sri Lanka" with flexible whitespace', () => {
    const re = makeWholeWordRegex('Sri Lanka');
    expect(re.test('Sri Lanka is reachable')).toBe(true);
    expect(re.test('to Sri Lanka next year')).toBe(true);
    expect(re.test('Sri  Lanka with double spaces')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Constants — export shape

describe('Exported constants', () => {
  test('JOB_A_FIELDS has the 6 PRD §3.7 fields', () => {
    expect(JOB_A_FIELDS).toHaveLength(6);
    expect(JOB_A_FIELDS).toContain('ambition_restatement');
    expect(JOB_A_FIELDS).toContain('assurance_framing');
  });

  test('JOB_B_FIELDS has the 7 PRD §3.7 fields', () => {
    expect(JOB_B_FIELDS).toHaveLength(7);
    expect(JOB_B_FIELDS).toContain('lead_quality_summary');
    expect(JOB_B_FIELDS).toContain('flags_to_action');
  });

  test('HONEST_NUMBERS_WHITELIST contains all 7 PRD §3.5.5/§3.5.3 standing figures', () => {
    expect(HONEST_NUMBERS_WHITELIST).toContain('14018');
    expect(HONEST_NUMBERS_WHITELIST).toContain('12055');
    expect(HONEST_NUMBERS_WHITELIST).toContain('1658');
    expect(HONEST_NUMBERS_WHITELIST).toContain('305');
    expect(HONEST_NUMBERS_WHITELIST).toContain('50');
    expect(HONEST_NUMBERS_WHITELIST).toContain('100000');
    expect(HONEST_NUMBERS_WHITELIST).toContain('2015');
  });

  test('DEFAULT_RESTRICTED_WORDS includes the PRD §11.3 calm-voice violations', () => {
    expect(DEFAULT_RESTRICTED_WORDS).toContain('urgent');
    expect(DEFAULT_RESTRICTED_WORDS).toContain('limited time');
    expect(DEFAULT_RESTRICTED_WORDS).toContain('guaranteed');
    expect(DEFAULT_RESTRICTED_WORDS).toContain('act now');
  });
});

// ---------------------------------------------------------------------------
// T17 — Layer 2 number-word check (spelled-form integers)
//
// PRD §3.7.1 check 2 names BOTH digit AND word forms as forbidden. The
// original Layer 2 implementation (T7) only scanned 3+ digit integers and
// missed spelled forms like "five hundred" or "two thousand five hundred".
// T17 closes the gap with a word-to-digit canonicaliser that runs the same
// whitelist check on spelled forms ≥ 100. Whitelisted spelled forms (e.g.
// "three hundred and five" → 305) accept; non-whitelisted spelled forms
// reject with a `invented_number_spelled:<value>` reason.
//
// Floor: 100 (matches the existing integer-check ≥3-digit floor). Values
// below floor (e.g. "fifty", "twenty-five") cannot collide with whitelist
// and are intentionally dropped to keep the canonicaliser cheap.
//
// Limitations (documented inline in the source): no support for billion+,
// ordinals, fractions, decimals, or non-English forms. If the LLM ever
// produces those, a follow-up slice should extend the canonicaliser.

describe('Layer 2 — number-word check (T17)', () => {
  test('"three hundred and five" → 305 → ACCEPT (on whitelist)', () => {
    const output = makeValidJobAOutput();
    output.what_becomes_possible += ' three hundred and five international students.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(1);
    expect(result.accepted).toBe(true);
  });

  test('"fourteen thousand and eighteen" → 14018 → ACCEPT (on whitelist)', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' Last year fourteen thousand and eighteen students moved.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(1);
    expect(result.accepted).toBe(true);
  });

  test('"two hundred international students" → 200 → REJECT (off-whitelist spelled)', () => {
    const output = makeValidJobAOutput();
    output.what_becomes_possible += ' We moved two hundred international students last year.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('invented_number_spelled:200');
  });

  test('"one hundred thousand" → 100000 → ACCEPT', () => {
    const output = makeValidJobAOutput();
    output.institutional_benefit += ' Since 2015 we have moved more than one hundred thousand students.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(1);
    expect(result.accepted).toBe(true);
  });

  test('"Twenty-five" (mixed-case + hyphen, < floor) → ACCEPT (below 3-digit floor)', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' Twenty-five schools have run this with us so far.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(1);
    expect(result.accepted).toBe(true);
  });

  test('"five hundred" → 500 → REJECT (off-whitelist spelled)', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' five hundred families benefited last year.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('invented_number_spelled:500');
  });

  test('"fifty plus schools" → 50 (< floor) → ACCEPT', () => {
    const output = makeValidJobAOutput();
    output.institutional_benefit += ' Fifty plus schools have joined since 2015.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(1);
    expect(result.accepted).toBe(true);
  });

  test('mixed "200 (two hundred)" → single REJECT, not double-firing', () => {
    const output = makeValidJobAOutput();
    output.what_becomes_possible += ' We moved 200 (two hundred) students.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    // Count rejections referencing the value 200 — either digit OR spelled
    // form is allowed, but the total count for 200 must be exactly 1.
    const twoHundredRejections = result.reasons.filter(
      (r) => r === 'invented_number:200' || r === 'invented_number_spelled:200',
    );
    expect(twoHundredRejections).toHaveLength(1);
  });

  test('Layer 3 fallback triggers when spelled REJECT fires', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' five hundred new students.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    expect(result.accepted).toBe(false);
    // Fallback object MUST have all 6 Job A fields populated as non-empty
    // strings — renderer (T8) cannot crash on a missing field.
    for (const field of JOB_A_FIELDS) {
      expect(result.output).toHaveProperty(field);
      expect(typeof result.output[field]).toBe('string');
      expect(result.output[field].length).toBeGreaterThan(0);
    }
  });

  test('"one hundred two thousand" → 102000 → REJECT (scale composition for non-whitelisted values)', () => {
    // Bonus scale-invariance test. The canonicaliser handles "<n> thousand"
    // composition: 102000 is not on the whitelist so this rejects. If scale
    // composition didn't work, the test would silently pass at Layer 1 —
    // making the rejection assertion the load-bearing check that the
    // composition actually works.
    const output = makeValidJobAOutput();
    output.what_becomes_possible += ' one hundred two thousand students reportedly travelled.';
    const result = guardReportOutput('A', output, { schoolAnswers: makeSchoolAnswers() });
    expect(result.layer).toBe(3);
    expect(result.reasons).toContain('invented_number_spelled:102000');
  });

  test('caller-supplied honestNumbersWhitelist also applies to spelled forms', () => {
    const output = makeValidJobAOutput();
    output.cost_of_waiting += ' five hundred new students.';
    const result = guardReportOutput('A', output, {
      honestNumbersWhitelist: [...HONEST_NUMBERS_WHITELIST, 500],
    });
    expect(result.layer).toBe(1);
    expect(result.accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helper: extractSpelledIntegers — direct unit tests (T17)

describe('Helper: extractSpelledIntegers', () => {
  test('parses common compound forms', () => {
    expect(extractSpelledIntegers('three hundred and five students')).toEqual([305]);
    expect(extractSpelledIntegers('fourteen thousand and eighteen')).toEqual([14018]);
    expect(extractSpelledIntegers('two hundred ')).toEqual([200]);
    expect(extractSpelledIntegers('one hundred thousand')).toEqual([100000]);
  });

  test('handles hyphens and case', () => {
    // Hyphens become spaces; case is folded. "Twenty-five" is below floor.
    expect(extractSpelledIntegers('Twenty-Five')).toEqual([]);
    expect(extractSpelledIntegers('TWO HUNDRED')).toEqual([200]);
    expect(extractSpelledIntegers('one-hundred')).toEqual([100]);
  });

  test('drops values below 100 floor', () => {
    expect(extractSpelledIntegers('fifty schools')).toEqual([]);
    expect(extractSpelledIntegers('twenty-five')).toEqual([]);
    expect(extractSpelledIntegers('ninety nine')).toEqual([]);
  });

  test('emits multiple values across the same text', () => {
    expect(extractSpelledIntegers('two hundred. three hundred. five hundred.')).toEqual([200, 300, 500]);
  });

  test('non-string input returns []', () => {
    expect(extractSpelledIntegers(null)).toEqual([]);
    expect(extractSpelledIntegers(undefined)).toEqual([]);
    expect(extractSpelledIntegers(42)).toEqual([]);
  });

  test('text with no number words returns []', () => {
    expect(extractSpelledIntegers('the canals of Amsterdam')).toEqual([]);
    expect(extractSpelledIntegers('')).toEqual([]);
  });
});
