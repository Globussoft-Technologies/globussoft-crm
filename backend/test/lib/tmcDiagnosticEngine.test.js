// Unit tests for backend/lib/tmcDiagnosticEngine.js
//
// Pins the TMC matching-and-routing engine's deterministic contract
// per PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md §3.10 step 2:
//
//   The engine "as a pure testable function reading 6 weights +
//   threshold from `engine_weights` config. Sort is two-key
//   lexicographic from §3.3.4, NOT single-score. Unit-test against
//   spec §6.9 worked example + 9 more hand-checked cases."
//
// What each case locks:
//
//   1. WORKED-EXAMPLE — full happy path from a 5-trip catalogue →
//      strong_match + the documented primary + the documented
//      alternative + clean ICP tier. The canonical contract.
//   2. BUDGET-SCOPE-CONFLICT — international geo + cheap band sets
//      the `scope_budget_conflict` flag (UC-5) and never invents a
//      cheap international trip.
//   3. UNKNOWN-BUDGET — Q9=unknown disables the budget filter, sets
//      `budget_unknown` flag, doesn't crash.
//   4. ZERO-SURVIVOR — no trips clear the hard filters → no_match +
//      primary=null + alternative=null + `needs_custom` flag.
//   5. SINGLE-SURVIVOR — only one trip survives → partial_match (or
//      strong_match if it cleared the bar) + `single_survivor` flag +
//      alternative=null.
//   6. GROWTH-DUPLICATE — Q3 growth_area_skill duplicates a Q2
//      secondary → growth points = 0 (no double-pay, AC-5).
//   7. GROWTH-NON-DUPLICATE — Q3 growth_area_skill differs from both
//      Q2 secondaries → +15 awarded.
//   8. GRADE-CENTERING-BOUNDARY — band exactly at midpoint ceiling
//      scores; band one below doesn't. Locks §11.2.
//   9. SORT-INVARIANT — a primary-matching trip with low total beats
//      a primary-missing trip with high total. THIS IS THE LOAD-
//      BEARING TWO-KEY-SORT INVARIANT FROM §3.3.4 + §11.1. The +50
//      weight does NOT enforce it; the structural sort tier does.
//  10. THIN-ALTERNATIVE — multiple survivors with matching tier AND
//      matching lead primary_outcome → next-highest returned with
//      `thin_alternative` flag instead of fabricating difference.
//
// Plus auxiliary cases pinning ICP tier classification + the
// individual scoring signals + the determinism contract (NF-1: same
// inputs → byte-identical output).

import { describe, test, expect } from 'vitest';

const engine = await import('../../lib/tmcDiagnosticEngine.js');
const {
  runTmcDiagnosticEngine,
  DEFAULT_WEIGHTS,
  computeIcpTier,
  passesBudgetFilter,
  passesGradeBandFilter,
  passesBoardFilter,
  passesTierFilter,
  scorePrimaryOutcome,
  scoreSecondarySkill,
  scoreGrowthArea,
  scoreCurriculumHook,
  scoreGradeCenter,
  scoreTierLean,
  computeCurriculumFit,
  gradeMatchesBand,
} = engine;

// ── Fixtures ────────────────────────────────────────────────────────
//
// 5-trip catalogue mirroring the spec §6.9 worked example shape:
//   - Golden Triangle (domestic, 30k-75k, grade 6-8 to 9-10, Cultural
//     respect lead, CBSE board hook)
//   - Madhya Pradesh (domestic, 30k-75k, grade 6-8 to 11-12, Cultural
//     respect lead)
//   - Europe NL-BE-FR-ES (international, 2l-plus, grade 9-10 to 11-12,
//     Global awareness lead — same primary_outcome as the worked
//     school's Q1)
//   - Ladakh (domestic, 1l-2l, grade 11-12 only — narrow band)
//   - USA STEM (international, 2l-plus, grade 9-10 to 11-12)
//
// The boards + skills + hooks are spec-realistic but engine-side they
// only need to be self-consistent for the tests to pin the contract.

const TRIP_GOLDEN_TRIANGLE = {
  tripId: 'golden-triangle',
  title: 'Golden Triangle',
  tier: 'domestic',
  durationDays: 6,
  durationNights: 5,
  minGradeBand: '6-8',
  maxGradeBand: '9-10',
  boardsSupportedJson: JSON.stringify(['CBSE', 'ICSE-ISC', 'State Board']),
  minGroupSize: 30,
  priceBand: '30k-75k',
  primaryOutcomesJson: JSON.stringify(['Cultural respect and inclusion']),
  skillsDevelopedJson: JSON.stringify([
    'Cultural respect and inclusion',
    'Lifelong learning and curiosity',
    'Collaboration and teamwork',
  ]),
  curriculumHooksJson: JSON.stringify([
    { board: 'CBSE', grade_band: '6-8', subject: 'History', topic: 'Mughal era', hook_text: '...' },
    { board: 'CBSE', grade_band: '9-10', subject: 'History', topic: 'Independence', hook_text: '...' },
  ]),
  status: 'active',
};

const TRIP_MADHYA_PRADESH = {
  tripId: 'madhya-pradesh',
  title: 'Madhya Pradesh',
  tier: 'domestic',
  durationDays: 7,
  durationNights: 6,
  minGradeBand: '6-8',
  maxGradeBand: '11-12',
  boardsSupportedJson: JSON.stringify(['CBSE', 'ICSE-ISC']),
  minGroupSize: 30,
  priceBand: '30k-75k',
  primaryOutcomesJson: JSON.stringify(['Cultural respect and inclusion']),
  skillsDevelopedJson: JSON.stringify([
    'Cultural respect and inclusion',
    'Empathy',
    'Self-awareness',
  ]),
  curriculumHooksJson: JSON.stringify([
    { board: 'CBSE', grade_band: '9-10', subject: 'History', topic: 'Tribal heritage', hook_text: '...' },
  ]),
  status: 'active',
};

const TRIP_EUROPE = {
  tripId: 'europe-nl-be-fr-es',
  title: 'Europe NL-BE-FR-ES',
  tier: 'international',
  durationDays: 12,
  durationNights: 11,
  minGradeBand: '9-10',
  maxGradeBand: '11-12',
  boardsSupportedJson: JSON.stringify(['CBSE', 'IB', 'IGCSE']),
  minGroupSize: 25,
  priceBand: '2l-plus',
  primaryOutcomesJson: JSON.stringify(['Global awareness']),
  skillsDevelopedJson: JSON.stringify([
    'Cultural respect and inclusion',
    'Lifelong learning and curiosity',
    'Self-awareness',
    'Collaboration and teamwork',
  ]),
  curriculumHooksJson: JSON.stringify([
    { board: 'CBSE', grade_band: '9-10', subject: 'Geography', topic: 'Europe', hook_text: '...' },
    { board: 'CBSE', grade_band: '11-12', subject: 'History', topic: 'WWII', hook_text: '...' },
    { board: 'IB', grade_band: '11-12', subject: 'CAS', topic: 'service', hook_text: '...' },
  ]),
  status: 'active',
};

const TRIP_LADAKH = {
  tripId: 'ladakh',
  title: 'Ladakh',
  tier: 'domestic',
  durationDays: 9,
  durationNights: 8,
  minGradeBand: '11-12',
  maxGradeBand: '11-12',
  boardsSupportedJson: JSON.stringify(['CBSE', 'ICSE-ISC', 'IB']),
  minGroupSize: 20,
  priceBand: '1l-2l',
  primaryOutcomesJson: JSON.stringify(['Resilience']),
  skillsDevelopedJson: JSON.stringify([
    'Emotional resilience',
    'Mindfulness',
    'Self-awareness',
  ]),
  curriculumHooksJson: JSON.stringify([]),
  status: 'active',
};

const TRIP_USA_STEM = {
  tripId: 'usa-stem',
  title: 'USA STEM',
  tier: 'international',
  durationDays: 14,
  durationNights: 13,
  minGradeBand: '9-10',
  maxGradeBand: '11-12',
  boardsSupportedJson: JSON.stringify(['CBSE', 'IB', 'IGCSE']),
  minGroupSize: 25,
  priceBand: '2l-plus',
  primaryOutcomesJson: JSON.stringify(['Curiosity']),
  skillsDevelopedJson: JSON.stringify([
    'Lifelong learning and curiosity',
    'Collaboration and teamwork',
  ]),
  curriculumHooksJson: JSON.stringify([]),
  status: 'active',
};

const FULL_CATALOGUE = [
  TRIP_GOLDEN_TRIANGLE,
  TRIP_MADHYA_PRADESH,
  TRIP_EUROPE,
  TRIP_LADAKH,
  TRIP_USA_STEM,
];

// Canonical "amazing-ish" school profile (drives ICP tier).
const SCHOOL_BIG = {
  branches: '3+',
  student_strength: '2000-plus',
  fee_band: '1l-plus',
};

const SCHOOL_BREADWINNING = {
  branches: '2',
  student_strength: '1000-2000',
  fee_band: '1l-plus',
};

const SCHOOL_CONVENIENCE = {
  branches: '1',
  student_strength: 'under 500',
  fee_band: '75k-1l',
};

const SCHOOL_DANGEROUS = {
  branches: '1',
  student_strength: 'under 500',
  fee_band: 'under 75k',
};

// ── §3.10 step 2 case 1 — WORKED EXAMPLE ─────────────────────────────
//
// School: CBSE, grade 9-10, geo=open, budget=2l-plus, Q1=Global
// awareness (matches Europe), Q2 picks Cultural respect + Lifelong
// learning, Q3 growth_area=Empathy (NOT in Q2).
//
// Hard filters survival:
//   - Golden Triangle: passes all (CBSE, 30k-75k ≤ 2l-plus, 9-10 in
//     [6-8, 9-10])
//   - Madhya Pradesh: passes all (CBSE, 30k-75k, 9-10 in [6-8, 11-12])
//   - Europe: passes all (CBSE, 2l-plus = 2l-plus, 9-10 in [9-10, 11-12])
//   - Ladakh: FAILS grade (9-10 not in [11-12, 11-12])
//   - USA STEM: passes all (CBSE, 2l-plus = 2l-plus, 9-10 in [9-10, 11-12])
//
// Scoring under open + budget allows:
//
//   Golden Triangle (no primary match — lead is Cultural respect, Q1 is
//   Global awareness):
//     primary 0 + secondary 40 (Cultural respect + Lifelong learning
//     both in trip skills) + growth 0 (Empathy NOT in trip skills) +
//     hook 10 (CBSE+9-10 hook present) + grade-center 10 (band 9-10 idx
//     2 ≥ midpoint ceil of (1+2)/2=2) + tier-lean 0 (domestic, not
//     international) = 60.  PrimaryMatch=false.
//
//   Madhya Pradesh (no primary match — lead is Cultural respect):
//     primary 0 + secondary 20 (only Cultural respect; Lifelong learning
//     not in skills) + growth 0 (Empathy IS in trip skills → +15) =
//     correction: Empathy IS in MP's skills, AND Empathy is NOT in the
//     school's Q2 secondaries → growth = +15.
//     Hook: CBSE+9-10 → +10. Grade-center: midpoint of [1,3] = 2,
//     ceil 2, school band idx 2 → +10. Tier-lean: domestic → 0.
//     Total: 0 + 20 + 15 + 10 + 10 + 0 = 55.
//
//   Europe (primary match — Q1 Global awareness is in trip outcomes):
//     primary +50 + secondary 20 (only Cultural respect; Lifelong
//     learning IS in trip skills → both match → 40) + growth 0
//     (Empathy not in trip skills) + hook 10 (CBSE+9-10 hook present) +
//     grade-center 10 (midpoint of [2,3]=2.5, ceil 3, school idx 2 <
//     3 → 0). Wait — band 9-10 idx 2, ceil((2+3)/2)=ceil(2.5)=3 ≠ 2 →
//     0. Tier-lean +8 (international, open geo).
//     Total: 50 + 40 + 0 + 10 + 0 + 8 = 108. PrimaryMatch=true.
//
//   USA STEM (no primary match — lead is Curiosity):
//     primary 0 + secondary 20 (only Lifelong learning; Cultural
//     respect NOT in trip skills) + growth 0 + hook 0 (no curriculum
//     hooks) + grade-center 0 (school idx 2 < ceil(2.5)=3) + tier-lean
//     +8 (international, open) = 28. PrimaryMatch=false.
//
// Two-key sort (primaryMatch then total):
//   1. Europe        primaryMatch=true,  108  → PRIMARY
//   2. Golden Tri.   primaryMatch=false,  60
//   3. Madhya Prad.  primaryMatch=false,  55
//   4. USA STEM      primaryMatch=false,  28
//
// Alternative selection: primary is Europe (international, Global
// awareness lead). Golden Triangle differs on tier (domestic) AND lead
// (Cultural respect) → meaningfully different → alternative.
//
// State: Europe has primaryMatch=true AND total 108 ≥ 70 → strong_match.

describe('TMC engine — worked example (PRD §3.10 step 2 case 1)', () => {
  const answers = {
    primary_outcome: 'Global awareness',
    secondary_skills: [
      'Cultural respect and inclusion',
      'Lifelong learning and curiosity',
    ],
    growth_area: 'Empathy',
    growth_area_skill: 'Empathy',
    travel_maturity: 'regular_domestic',
    grade_band: '9-10',
    curriculum: 'CBSE',
    geo_preference: 'open',
    budget_band: '2l-plus',
    group_size: '45-80',
    school_profile: SCHOOL_BREADWINNING,
  };

  test('worked example produces strong_match with Europe primary + Golden Triangle alternative', () => {
    const result = runTmcDiagnosticEngine(answers, FULL_CATALOGUE);
    expect(result.state).toBe('strong_match');
    expect(result.primary.tripId).toBe('europe-nl-be-fr-es');
    expect(result.alternative.tripId).toBe('golden-triangle');
    expect(result.icpTier).toBe('breadwinning');
    expect(result.flags).not.toContain('budget_unknown');
    expect(result.flags).not.toContain('scope_budget_conflict');
    expect(result.flags).not.toContain('needs_custom');
    expect(result.flags).not.toContain('single_survivor');
    expect(result.flags).not.toContain('thin_alternative');
  });

  test('Ladakh is eliminated by grade-band hard filter, not surfaced in survivors', () => {
    const result = runTmcDiagnosticEngine(answers, FULL_CATALOGUE);
    const survivorIds = result.scores.survivors.map((s) => s.tripId);
    expect(survivorIds).not.toContain('ladakh');
    const ladakhElim = result.scores.eliminated.find(
      (e) => e.tripId === 'ladakh',
    );
    expect(ladakhElim).toBeDefined();
    expect(ladakhElim.reason).toBe('grade_band');
  });

  test('Europe per-signal breakdown matches the hand-calculated values', () => {
    const result = runTmcDiagnosticEngine(answers, FULL_CATALOGUE);
    const europe = result.scores.survivors.find(
      (s) => s.tripId === 'europe-nl-be-fr-es',
    );
    expect(europe.primaryMatch).toBe(true);
    expect(europe.signals.primaryOutcome.points).toBe(50);
    expect(europe.signals.secondarySkill.points).toBe(40); // both Q2 secondaries hit
    expect(europe.signals.growthArea.points).toBe(0); // Empathy not in trip skills
    expect(europe.signals.curriculumHook.points).toBe(10);
    expect(europe.signals.gradeBandCenter.points).toBe(0); // band 9-10 < ceil(2.5)=3
    expect(europe.signals.tierValueLean.points).toBe(8);
    expect(europe.total).toBe(108);
  });
});

// ── Case 2 — BUDGET-SCOPE-CONFLICT (UC-5) ────────────────────────────

describe('TMC engine — budget-scope conflict (PRD §3.10 case 2 + UC-5)', () => {
  test('international Q7 + 10k-30k Q9 flags scope_budget_conflict and never invents a cheap international trip', () => {
    const answers = {
      primary_outcome: 'Global awareness',
      secondary_skills: ['Empathy', 'Self-awareness'],
      growth_area: 'Mindfulness',
      growth_area_skill: 'Mindfulness',
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'international',
      budget_band: '10k-30k', // BLATANT CONFLICT WITH GEO
      group_size: '45-80',
      school_profile: SCHOOL_BREADWINNING,
    };
    const result = runTmcDiagnosticEngine(answers, FULL_CATALOGUE);
    expect(result.flags).toContain('scope_budget_conflict');
    // Europe + USA STEM both fail budget filter (2l-plus > 10k-30k)
    // → zero survivors → no_match
    expect(result.state).toBe('no_match');
    expect(result.primary).toBeNull();
    expect(result.alternative).toBeNull();
    expect(result.flags).toContain('needs_custom');
  });
});

// ── Case 3 — UNKNOWN BUDGET ──────────────────────────────────────────

describe('TMC engine — unknown budget (PRD §3.10 case 3)', () => {
  test('Q9=unknown disables budget filter, sets budget_unknown flag, does not crash', () => {
    const answers = {
      primary_outcome: 'Global awareness',
      secondary_skills: ['Cultural respect and inclusion', 'Lifelong learning and curiosity'],
      growth_area: 'Empathy',
      growth_area_skill: 'Empathy',
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'open',
      budget_band: 'unknown',
      group_size: '45-80',
      school_profile: SCHOOL_BREADWINNING,
    };
    const result = runTmcDiagnosticEngine(answers, FULL_CATALOGUE);
    expect(result.flags).toContain('budget_unknown');
    // All trips that pass non-budget hard filters survive (Ladakh still
    // eliminated on grade). Europe still wins.
    expect(result.state).toBe('strong_match');
    expect(result.primary.tripId).toBe('europe-nl-be-fr-es');
    // Audit: no survivor was eliminated for budget reason
    const budgetElim = result.scores.eliminated.find(
      (e) => e.reason === 'budget',
    );
    expect(budgetElim).toBeUndefined();
  });

  test('missing budget_band entirely behaves like unknown', () => {
    const answers = {
      primary_outcome: 'Global awareness',
      secondary_skills: ['Empathy', 'Self-awareness'],
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'open',
      // budget_band omitted
      school_profile: SCHOOL_BREADWINNING,
    };
    expect(() => runTmcDiagnosticEngine(answers, FULL_CATALOGUE)).not.toThrow();
    const result = runTmcDiagnosticEngine(answers, FULL_CATALOGUE);
    expect(result.flags).toContain('budget_unknown');
  });
});

// ── Case 4 — ZERO SURVIVOR ───────────────────────────────────────────

describe('TMC engine — zero survivor (PRD §3.10 case 4)', () => {
  test('no trip clears hard filters → state=no_match, primary=null, alternative=null, needs_custom flag', () => {
    const answers = {
      primary_outcome: 'Global awareness',
      secondary_skills: ['Empathy', 'Self-awareness'],
      growth_area: 'Mindfulness',
      growth_area_skill: 'Mindfulness',
      grade_band: '4-6', // No trip in our catalogue accepts 4-6
      curriculum: 'CBSE',
      geo_preference: 'open',
      budget_band: '2l-plus',
      school_profile: SCHOOL_DANGEROUS,
    };
    const result = runTmcDiagnosticEngine(answers, FULL_CATALOGUE);
    expect(result.state).toBe('no_match');
    expect(result.primary).toBeNull();
    expect(result.alternative).toBeNull();
    expect(result.flags).toContain('needs_custom');
    // Audit: every trip ends up in eliminated[]
    expect(result.scores.eliminated.length).toBe(FULL_CATALOGUE.length);
    expect(result.scores.survivors).toEqual([]);
  });
});

// ── Case 5 — SINGLE SURVIVOR ─────────────────────────────────────────

describe('TMC engine — single survivor (PRD §3.10 case 5)', () => {
  test('only one trip survives → state matches its score-or-not + single_survivor flag + alternative=null', () => {
    // School: grade 11-12, IB, budget 1l-2l (kills Europe/USA STEM at
    // 2l-plus), geo=domestic (kills both internationals). Among
    // remaining domestic trips, IB is supported only by Ladakh
    // (Golden Triangle + Madhya Pradesh declare CBSE+ICSE-ISC only;
    // Golden Triangle is also eliminated on grade band 6-8 to 9-10).
    // → Sole survivor: Ladakh.
    const answers = {
      primary_outcome: 'Resilience', // Ladakh's lead — matches
      secondary_skills: ['Mindfulness', 'Self-awareness'],
      growth_area: 'Empathy',
      growth_area_skill: 'Empathy',
      grade_band: '11-12',
      curriculum: 'IB',
      geo_preference: 'domestic',
      budget_band: '1l-2l',
      school_profile: SCHOOL_BREADWINNING,
    };
    const result = runTmcDiagnosticEngine(answers, FULL_CATALOGUE);
    expect(result.primary.tripId).toBe('ladakh');
    expect(result.alternative).toBeNull();
    expect(result.flags).toContain('single_survivor');
    // Ladakh: primary +50 (Resilience lead match) + secondary 40
    // (Mindfulness + Self-awareness both in Ladakh's skills) +
    // growth 0 (Empathy not in Ladakh's skills) + hook 0 (no IB
    // hooks present) + grade-center +10 (band idx 3 ≥
    // ceil((3+3)/2)=3) + tier 0 (domestic ≠ intl, geo not open).
    // Total: 100. 100 ≥ 70 + primaryMatch → strong_match.
    expect(result.state).toBe('strong_match');
  });

  test('single survivor with low score still flags single_survivor (state=partial_match)', () => {
    // Modify Ladakh so the school's Q1 no longer matches its primary
    // outcomes; school's Q2 + Q3 also miss its skills.
    const ladakhBlanked = {
      ...TRIP_LADAKH,
      primaryOutcomesJson: JSON.stringify(['Curiosity']), // school Q1 ≠
      skillsDevelopedJson: JSON.stringify([]),
      curriculumHooksJson: JSON.stringify([]),
    };
    const catalogue = [
      TRIP_GOLDEN_TRIANGLE,
      TRIP_MADHYA_PRADESH,
      TRIP_EUROPE,
      ladakhBlanked,
      TRIP_USA_STEM,
    ];
    const answers = {
      primary_outcome: 'Resilience', // no longer matches modified Ladakh
      secondary_skills: ['Empathy', 'Self-awareness'],
      growth_area: 'Mindfulness',
      growth_area_skill: 'Mindfulness',
      grade_band: '11-12',
      curriculum: 'IB', // isolates Ladakh as sole survivor
      geo_preference: 'domestic',
      budget_band: '1l-2l',
      school_profile: SCHOOL_BREADWINNING,
    };
    const result = runTmcDiagnosticEngine(answers, catalogue);
    expect(result.primary.tripId).toBe('ladakh');
    expect(result.alternative).toBeNull();
    expect(result.flags).toContain('single_survivor');
    expect(result.state).toBe('partial_match'); // misses primary outcome
  });
});

// ── Case 6 — GROWTH-DUPLICATE OF Q2 ──────────────────────────────────

describe('TMC engine — growth-area duplicate of Q2 (AC-5)', () => {
  test('Q3 growth_area_skill that duplicates a Q2 pick gets 0 growth points', () => {
    // School Q2 includes 'Empathy'. Q3 growth_area_skill also 'Empathy'.
    // Trip's skillsDevelopedJson contains Empathy. Engine should NOT
    // pay +15 (already-counted via Q2).
    const result = scoreGrowthArea(
      TRIP_MADHYA_PRADESH,
      {
        secondary_skills: ['Empathy', 'Self-awareness'],
        growth_area_skill: 'Empathy',
      },
      DEFAULT_WEIGHTS,
    );
    expect(result.points).toBe(0);
    expect(result.matched).toBe(true); // matched in trip's skills, but no points
    expect(result.duplicateOfSecondary).toBe(true);
  });
});

// ── Case 7 — GROWTH-NON-DUPLICATE ────────────────────────────────────

describe('TMC engine — growth-area non-duplicate', () => {
  test('Q3 skill that is NOT a Q2 pick AND IS in trip skills awards +15', () => {
    const result = scoreGrowthArea(
      TRIP_MADHYA_PRADESH, // skills include Empathy
      {
        secondary_skills: ['Self-awareness', 'Mindfulness'], // Empathy not here
        growth_area_skill: 'Empathy',
      },
      DEFAULT_WEIGHTS,
    );
    expect(result.points).toBe(15);
    expect(result.matched).toBe(true);
    expect(result.duplicateOfSecondary).toBe(false);
  });

  test('Q3 skill that is NOT a Q2 pick but ALSO NOT in trip skills awards 0', () => {
    const result = scoreGrowthArea(
      TRIP_MADHYA_PRADESH,
      {
        secondary_skills: ['Self-awareness', 'Mindfulness'],
        growth_area_skill: 'Cultural respect and inclusion', // wait, this IS in MP — use something not
      },
      DEFAULT_WEIGHTS,
    );
    // Cultural respect IS in MP — recompute. Use a skill not in MP:
    const result2 = scoreGrowthArea(
      TRIP_MADHYA_PRADESH,
      {
        secondary_skills: ['Self-awareness', 'Mindfulness'],
        growth_area_skill: 'Collaboration and teamwork', // not in MP
      },
      DEFAULT_WEIGHTS,
    );
    expect(result2.points).toBe(0);
    expect(result2.matched).toBe(false);
  });
});

// ── Case 8 — GRADE-CENTERING BOUNDARY (PRD §11.2) ────────────────────

describe('TMC engine — grade-centering boundary (PRD §11.2)', () => {
  test('band exactly at midpoint ceiling scores +10', () => {
    // Trip with range 6-8 to 11-12 → indices [1, 3] → midpoint 2,
    // ceiling 2. Band 9-10 (idx 2) sits exactly at the ceiling.
    const trip = {
      ...TRIP_MADHYA_PRADESH,
      minGradeBand: '6-8',
      maxGradeBand: '11-12',
    };
    const result = scoreGradeCenter(
      trip,
      { grade_band: '9-10' },
      DEFAULT_WEIGHTS,
    );
    expect(result.points).toBe(10);
    expect(result.matched).toBe(true);
  });

  test('band one below midpoint ceiling scores 0', () => {
    // Same trip, school band 6-8 (idx 1) — one below ceiling of 2.
    const trip = {
      ...TRIP_MADHYA_PRADESH,
      minGradeBand: '6-8',
      maxGradeBand: '11-12',
    };
    const result = scoreGradeCenter(
      trip,
      { grade_band: '6-8' },
      DEFAULT_WEIGHTS,
    );
    expect(result.points).toBe(0);
    expect(result.matched).toBe(false);
  });

  test('PRD §3.3.3 worked example: trip 6-8 to 11-12, band 11-12 scores; band 6-8 doesn’t', () => {
    const trip = {
      ...TRIP_MADHYA_PRADESH,
      minGradeBand: '6-8',
      maxGradeBand: '11-12',
    };
    const high = scoreGradeCenter(
      trip,
      { grade_band: '11-12' },
      DEFAULT_WEIGHTS,
    );
    const low = scoreGradeCenter(
      trip,
      { grade_band: '6-8' },
      DEFAULT_WEIGHTS,
    );
    expect(high.points).toBe(10);
    expect(low.points).toBe(0);
  });
});

// ── Case 9 — SORT INVARIANT (PRD §3.3.4 + §11.1) ─────────────────────
//
// THE LOAD-BEARING INVARIANT. A primary-matching trip with low total
// MUST outrank a primary-missing trip with high total — even when the
// primary trip's total is < the non-primary trip's total. The +50
// weight does NOT enforce this; the structural sort tier does.
//
// We construct an extreme case to exercise the structural-vs-arithmetic
// distinction: a primary-MATCHING trip with score exactly 50 (only the
// primary signal fires) vs a primary-MISSING trip with score 83
// (secondary 40 + growth 15 + hook 10 + grade-center 10 + tier 8 = 83 —
// the maximum non-primary stack per §11.1's arithmetic proof).

describe('TMC engine — two-key sort invariant (PRD §3.3.4 + §11.1)', () => {
  test('primary-matching low-score trip outranks primary-missing high-score trip', () => {
    // Trip "P-MATCH" matches school's primary outcome; nothing else.
    // Trip "P-MISS" stacks EVERY non-primary signal but misses primary.
    const P_MATCH = {
      tripId: 'p-match-low',
      title: 'Primary-Match Low Score',
      tier: 'domestic',
      durationDays: 4,
      durationNights: 3,
      minGradeBand: '9-10',
      maxGradeBand: '9-10',
      boardsSupportedJson: JSON.stringify(['CBSE']),
      minGroupSize: 30,
      priceBand: '30k-75k',
      primaryOutcomesJson: JSON.stringify(['Global awareness']),
      skillsDevelopedJson: JSON.stringify([]), // no secondaries match
      curriculumHooksJson: JSON.stringify([]),
      status: 'active',
    };
    const P_MISS = {
      tripId: 'p-miss-high',
      title: 'Primary-Miss High Score',
      tier: 'international', // tier-lean +8 under open geo
      durationDays: 10,
      durationNights: 9,
      minGradeBand: '6-8',
      maxGradeBand: '11-12', // midpoint ceiling 2 → band 9-10 idx 2 scores
      boardsSupportedJson: JSON.stringify(['CBSE']),
      minGroupSize: 25,
      priceBand: '2l-plus',
      primaryOutcomesJson: JSON.stringify(['Curiosity']), // ≠ school Q1
      skillsDevelopedJson: JSON.stringify([
        'Empathy', // school Q2 #1
        'Self-awareness', // school Q2 #2
        'Mindfulness', // school Q3 growth target
      ]),
      curriculumHooksJson: JSON.stringify([
        { board: 'CBSE', grade_band: '9-10', subject: 'X', topic: 'Y', hook_text: 'Z' },
      ]),
      status: 'active',
    };
    const answers = {
      primary_outcome: 'Global awareness',
      secondary_skills: ['Empathy', 'Self-awareness'],
      growth_area_skill: 'Mindfulness',
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'open',
      budget_band: '2l-plus',
      school_profile: SCHOOL_BREADWINNING,
    };
    const result = runTmcDiagnosticEngine(answers, [P_MISS, P_MATCH]);
    // P-MATCH total: 50 (primary) + 0 (no secondary skills in trip) + 0
    //   (Mindfulness not in trip skills) + 0 (no hook) + 10 (band 9-10
    //   idx 2 ≥ ceil((2+2)/2)=2) + 0 (domestic, +8 only for intl) = 60
    // P-MISS total: 0 (primary miss) + 40 (Empathy + Self-awareness) +
    //   15 (Mindfulness non-dup in trip) + 10 (CBSE+9-10 hook) + 10
    //   (band 9-10 idx 2 ≥ ceil((1+3)/2)=2) + 8 (intl + open) = 83
    // Arithmetic: P_MISS 83 > P_MATCH 60. Structural sort: P_MATCH wins.
    const survivors = result.scores.survivors;
    expect(survivors[0].tripId).toBe('p-match-low');
    expect(survivors[0].total).toBe(60);
    expect(survivors[0].primaryMatch).toBe(true);
    expect(survivors[1].tripId).toBe('p-miss-high');
    expect(survivors[1].total).toBe(83);
    expect(survivors[1].primaryMatch).toBe(false);
    // The actual contract: PRIMARY of result is p-match-low.
    expect(result.primary.tripId).toBe('p-match-low');
  });
});

// ── Case 10 — THIN ALTERNATIVE ───────────────────────────────────────

describe('TMC engine — thin alternative (PRD §3.3.5)', () => {
  test('survivors with matching tier AND matching lead primary_outcome trigger thin_alternative', () => {
    // Two domestic trips with same lead primary outcome.
    const TRIP_A = {
      tripId: 'a-domestic-cultural',
      title: 'A',
      tier: 'domestic',
      durationDays: 5,
      durationNights: 4,
      minGradeBand: '9-10',
      maxGradeBand: '9-10',
      boardsSupportedJson: JSON.stringify(['CBSE']),
      minGroupSize: 30,
      priceBand: '30k-75k',
      primaryOutcomesJson: JSON.stringify(['Cultural respect and inclusion']),
      skillsDevelopedJson: JSON.stringify([
        'Cultural respect and inclusion',
        'Empathy',
      ]),
      curriculumHooksJson: JSON.stringify([]),
      status: 'active',
    };
    const TRIP_B = {
      ...TRIP_A,
      tripId: 'b-domestic-cultural',
      title: 'B',
      skillsDevelopedJson: JSON.stringify(['Cultural respect and inclusion']),
    };
    const answers = {
      primary_outcome: 'Cultural respect and inclusion',
      secondary_skills: ['Empathy', 'Self-awareness'],
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'domestic',
      budget_band: '30k-75k',
      school_profile: SCHOOL_BREADWINNING,
    };
    const result = runTmcDiagnosticEngine(answers, [TRIP_A, TRIP_B]);
    // Both survive. Both share tier 'domestic' AND lead outcome.
    // → thin_alternative flag, alternative = next-highest.
    expect(result.primary).toBeTruthy();
    expect(result.alternative).toBeTruthy();
    expect(result.flags).toContain('thin_alternative');
    // Alternative should NOT be the primary (must differ on tripId)
    expect(result.alternative.tripId).not.toBe(result.primary.tripId);
  });

  test('survivors that differ on tier do NOT trigger thin_alternative', () => {
    // Worked example: Europe (intl, Global awareness lead) vs Golden
    // Triangle (domestic, Cultural respect lead) → meaningfully diff.
    const answers = {
      primary_outcome: 'Global awareness',
      secondary_skills: [
        'Cultural respect and inclusion',
        'Lifelong learning and curiosity',
      ],
      growth_area_skill: 'Empathy',
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'open',
      budget_band: '2l-plus',
      school_profile: SCHOOL_BREADWINNING,
    };
    const result = runTmcDiagnosticEngine(answers, FULL_CATALOGUE);
    expect(result.flags).not.toContain('thin_alternative');
  });
});

// ── ICP TIER classification (PRD §3.3.6) ─────────────────────────────

describe('TMC engine — ICP tier classification (PRD §3.3.6)', () => {
  test('amazing: branches ≥ 3 + strength ≥ 2000 + fee ≥ 1L', () => {
    expect(computeIcpTier({ school_profile: SCHOOL_BIG })).toBe('amazing');
  });
  test('breadwinning: branches 1-2 + strength 1000-2000 + fee ≥ 1L', () => {
    expect(computeIcpTier({ school_profile: SCHOOL_BREADWINNING })).toBe(
      'breadwinning',
    );
  });
  test('convenience: strength < 1000 + fee in [75k, 1L)', () => {
    expect(computeIcpTier({ school_profile: SCHOOL_CONVENIENCE })).toBe(
      'convenience',
    );
  });
  test('dangerous: fee < 75k', () => {
    expect(computeIcpTier({ school_profile: SCHOOL_DANGEROUS })).toBe(
      'dangerous',
    );
  });
  test('unclassified for profiles that fit no bucket', () => {
    // 1 branch + strength 1000-2000 + fee 75k-1L is BETWEEN buckets:
    // not amazing (needs branches 3+), not breadwinning (needs fee ≥1L),
    // not convenience (needs strength <1000), not dangerous (fee ≥75k).
    expect(
      computeIcpTier({
        school_profile: {
          branches: '1',
          student_strength: '1000-2000',
          fee_band: '75k-1l',
        },
      }),
    ).toBe('unclassified');
  });
});

// ── Hard-filter unit probes ──────────────────────────────────────────

describe('TMC engine — hard filters', () => {
  test('budget hard filter eliminates trips whose priceBand exceeds school band', () => {
    expect(passesBudgetFilter(TRIP_EUROPE, '30k-75k')).toBe(false);
    expect(passesBudgetFilter(TRIP_GOLDEN_TRIANGLE, '30k-75k')).toBe(true);
    expect(passesBudgetFilter(TRIP_GOLDEN_TRIANGLE, '2l-plus')).toBe(true);
    expect(passesBudgetFilter(TRIP_EUROPE, '2l-plus')).toBe(true);
  });

  test('tier scope hard filter respects geo_preference', () => {
    expect(passesTierFilter(TRIP_EUROPE, 'domestic')).toBe(false);
    expect(passesTierFilter(TRIP_GOLDEN_TRIANGLE, 'international')).toBe(false);
    expect(passesTierFilter(TRIP_EUROPE, 'international')).toBe(true);
    expect(passesTierFilter(TRIP_GOLDEN_TRIANGLE, 'domestic')).toBe(true);
    expect(passesTierFilter(TRIP_GOLDEN_TRIANGLE, 'open')).toBe(true);
  });

  test('grade-band hard filter requires school band inside trip range', () => {
    expect(passesGradeBandFilter(TRIP_LADAKH, '9-10')).toBe(false);
    expect(passesGradeBandFilter(TRIP_LADAKH, '11-12')).toBe(true);
    expect(passesGradeBandFilter(TRIP_GOLDEN_TRIANGLE, '11-12')).toBe(false);
    expect(passesGradeBandFilter(TRIP_GOLDEN_TRIANGLE, '6-8')).toBe(true);
  });

  test('board hard filter: any selected board in trip supported list passes', () => {
    expect(passesBoardFilter(TRIP_EUROPE, ['CBSE'])).toBe(true);
    expect(passesBoardFilter(TRIP_EUROPE, ['State Board'])).toBe(false);
    expect(passesBoardFilter(TRIP_EUROPE, ['IB', 'State Board'])).toBe(true);
    expect(passesBoardFilter(TRIP_EUROPE, [])).toBe(true); // no constraint
  });
});

// ── Per-signal unit probes ───────────────────────────────────────────

describe('TMC engine — per-signal scoring', () => {
  test('primary outcome match awards +50; miss awards 0', () => {
    expect(
      scorePrimaryOutcome(
        TRIP_EUROPE,
        { primary_outcome: 'Global awareness' },
        DEFAULT_WEIGHTS,
      ).points,
    ).toBe(50);
    expect(
      scorePrimaryOutcome(
        TRIP_EUROPE,
        { primary_outcome: 'Resilience' },
        DEFAULT_WEIGHTS,
      ).points,
    ).toBe(0);
  });

  test('secondary skill caps at +40 even if 3+ accidental matches', () => {
    const tripWithMany = {
      ...TRIP_EUROPE,
      skillsDevelopedJson: JSON.stringify([
        'Empathy',
        'Self-awareness',
        'Mindfulness',
      ]),
    };
    const result = scoreSecondarySkill(
      tripWithMany,
      {
        secondary_skills: ['Empathy', 'Self-awareness', 'Mindfulness'],
      },
      DEFAULT_WEIGHTS,
    );
    expect(result.points).toBe(40);
  });

  test('curriculum hook +10 only when board AND grade band both match', () => {
    expect(
      scoreCurriculumHook(
        TRIP_EUROPE,
        { curriculum: 'CBSE', grade_band: '9-10' },
        DEFAULT_WEIGHTS,
      ).points,
    ).toBe(10);
    // CBSE but wrong grade band
    expect(
      scoreCurriculumHook(
        TRIP_EUROPE,
        { curriculum: 'CBSE', grade_band: '6-8' },
        DEFAULT_WEIGHTS,
      ).points,
    ).toBe(0);
    // Right grade band but wrong board
    expect(
      scoreCurriculumHook(
        TRIP_EUROPE,
        { curriculum: 'State Board', grade_band: '9-10' },
        DEFAULT_WEIGHTS,
      ).points,
    ).toBe(0);
  });

  test('tier-value lean only fires under open geo', () => {
    expect(
      scoreTierLean(
        TRIP_EUROPE,
        { geo_preference: 'open' },
        DEFAULT_WEIGHTS,
      ).points,
    ).toBe(8);
    expect(
      scoreTierLean(
        TRIP_EUROPE,
        { geo_preference: 'international' },
        DEFAULT_WEIGHTS,
      ).points,
    ).toBe(0);
    expect(
      scoreTierLean(
        TRIP_GOLDEN_TRIANGLE,
        { geo_preference: 'open' },
        DEFAULT_WEIGHTS,
      ).points,
    ).toBe(0);
  });
});

// ── Determinism contract (NF-1) ──────────────────────────────────────

describe('TMC engine — determinism (NF-1)', () => {
  test('same inputs produce byte-identical output (JSON-comparable)', () => {
    const answers = {
      primary_outcome: 'Global awareness',
      secondary_skills: [
        'Cultural respect and inclusion',
        'Lifelong learning and curiosity',
      ],
      growth_area_skill: 'Empathy',
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'open',
      budget_band: '2l-plus',
      school_profile: SCHOOL_BREADWINNING,
    };
    const a = runTmcDiagnosticEngine(answers, FULL_CATALOGUE);
    const b = runTmcDiagnosticEngine(answers, FULL_CATALOGUE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ── Weight override contract (NF-2) ──────────────────────────────────

describe('TMC engine — weight overrides (NF-2)', () => {
  test('caller-supplied weights override defaults; missing keys fall back', () => {
    const answers = {
      primary_outcome: 'Global awareness',
      secondary_skills: ['Cultural respect and inclusion', 'Lifelong learning and curiosity'],
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'open',
      budget_band: '2l-plus',
      school_profile: SCHOOL_BREADWINNING,
    };
    // Bump primary to 100; everything else default
    const tuned = runTmcDiagnosticEngine(answers, FULL_CATALOGUE, {
      weightPrimaryOutcome: 100,
    });
    const europe = tuned.scores.survivors.find(
      (s) => s.tripId === 'europe-nl-be-fr-es',
    );
    expect(europe.signals.primaryOutcome.points).toBe(100);
    // Other signals untouched
    expect(europe.signals.secondarySkill.points).toBe(40);
  });

  test('non-numeric weight overrides are ignored (fallback to default)', () => {
    const answers = {
      primary_outcome: 'Global awareness',
      secondary_skills: ['Cultural respect and inclusion'],
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'open',
      budget_band: '2l-plus',
      school_profile: SCHOOL_BREADWINNING,
    };
    const result = runTmcDiagnosticEngine(answers, FULL_CATALOGUE, {
      weightPrimaryOutcome: 'oops',
      weightSecondarySkill: NaN,
    });
    const europe = result.scores.survivors.find(
      (s) => s.tripId === 'europe-nl-be-fr-es',
    );
    expect(europe.signals.primaryOutcome.points).toBe(50); // default
    expect(europe.signals.secondarySkill.points).toBe(20); // default × 1 match
  });
});

// ── below_min_group flag (UC-7) ──────────────────────────────────────

describe('TMC engine — below_min_group flag (UC-7)', () => {
  test('school group_size below trip minGroupSize raises flag without eliminating', () => {
    // Europe has minGroupSize 25. School picks group_size '<35' (min=1).
    const answers = {
      primary_outcome: 'Global awareness',
      secondary_skills: ['Cultural respect and inclusion', 'Lifelong learning and curiosity'],
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'international',
      budget_band: '2l-plus',
      group_size: '<35', // 1 < 25 → below_min_group
      school_profile: SCHOOL_BREADWINNING,
    };
    const result = runTmcDiagnosticEngine(answers, FULL_CATALOGUE);
    // Europe still wins under international scope.
    expect(result.primary.tripId).toBe('europe-nl-be-fr-es');
    // Wait — '<35' minimum is 1, but 1 < 25. Flag should fire.
    expect(result.flags).toContain('below_min_group');
  });
});

// ── Input-validation guardrails ──────────────────────────────────────

describe('TMC engine — input validation', () => {
  test('non-object answers throws TypeError', () => {
    expect(() => runTmcDiagnosticEngine(null, FULL_CATALOGUE)).toThrow(
      TypeError,
    );
    expect(() => runTmcDiagnosticEngine('answers', FULL_CATALOGUE)).toThrow(
      TypeError,
    );
  });

  test('non-array catalogue throws TypeError', () => {
    expect(() =>
      runTmcDiagnosticEngine({ primary_outcome: 'x' }, null),
    ).toThrow(TypeError);
    expect(() =>
      runTmcDiagnosticEngine({ primary_outcome: 'x' }, {}),
    ).toThrow(TypeError);
  });

  test('empty catalogue yields no_match without throwing', () => {
    const result = runTmcDiagnosticEngine(
      {
        primary_outcome: 'Global awareness',
        grade_band: '9-10',
        curriculum: 'CBSE',
        geo_preference: 'open',
        budget_band: '2l-plus',
        school_profile: SCHOOL_BREADWINNING,
      },
      [],
    );
    expect(result.state).toBe('no_match');
    expect(result.scores.survivors).toEqual([]);
  });

  test('malformed trip (missing JSON fields) survives gracefully — engine treats parse-failures as empty arrays', () => {
    const malformed = {
      tripId: 'malformed',
      title: 'M',
      tier: 'domestic',
      durationDays: 5,
      durationNights: 4,
      minGradeBand: '9-10',
      maxGradeBand: '9-10',
      boardsSupportedJson: 'not-json{', // parse fail
      minGroupSize: 20,
      priceBand: '30k-75k',
      primaryOutcomesJson: 'also-broken{',
      skillsDevelopedJson: '[invalid',
      curriculumHooksJson: '[]',
      status: 'active',
    };
    const answers = {
      primary_outcome: 'Global awareness',
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'domestic',
      budget_band: '30k-75k',
      school_profile: SCHOOL_BREADWINNING,
    };
    // boardsSupportedJson parses to [] → board filter ELIMINATES the
    // trip (empty supported list = misconfigured). That's the intended
    // engineering contract — bad data shouldn't surface to schools.
    const result = runTmcDiagnosticEngine(answers, [malformed]);
    expect(result.state).toBe('no_match');
    const elim = result.scores.eliminated.find((e) => e.tripId === 'malformed');
    expect(elim).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// C7 — computeCurriculumFit (PRD_TMC_CURRICULUM_MAPPING FR-5)
// ────────────────────────────────────────────────────────────────────
//
// Pins the new curriculum-fit top-N recommendation function. Filters
// candidate mappings by (board × grade-band) THEN scores by overlap
// between the school's primary_outcome + secondary_skills and the
// mapping's learningOutcome. Returns top-N by fitScore desc, mappingId
// asc tiebreak.
//
// Backward-compat contract: runTmcDiagnosticEngine without a 4th arg
// returns curriculumFit: [], all 39 prior cases keep passing.

function curriculumMappingRow(overrides = {}) {
  return {
    id: 1,
    tenantId: 1,
    curriculum: 'CBSE',
    grade: 'Class 9',
    subject: 'Social Studies',
    learningOutcome: 'Empathy and cultural respect through field study',
    destinationId: 4,
    destinationLabel: 'Madhya Pradesh',
    fitScore: 50,
    fitRationale: 'Strong NEP alignment',
    isActive: true,
    ...overrides,
  };
}

function curriculumAnswers(overrides = {}) {
  return {
    primary_outcome: 'Empathy',
    secondary_skills: ['Cultural respect and inclusion', 'Self-awareness'],
    grade_band: '9-10',
    curriculum: 'CBSE',
    ...overrides,
  };
}

describe('computeCurriculumFit (C7) — top-N curriculum-fit recommendations', () => {
  test('empty curriculumMappings → returns []', () => {
    const out = computeCurriculumFit(curriculumAnswers(), []);
    expect(out).toEqual([]);
  });

  test('null/undefined curriculumMappings → returns []', () => {
    expect(computeCurriculumFit(curriculumAnswers(), null)).toEqual([]);
    expect(computeCurriculumFit(curriculumAnswers(), undefined)).toEqual([]);
  });

  test('single mapping with board+grade match → fitScore > 0, returned', () => {
    const out = computeCurriculumFit(curriculumAnswers(), [
      curriculumMappingRow(),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].mappingId).toBe(1);
    expect(out[0].board).toBe('CBSE');
    expect(out[0].destinationLabel).toBe('Madhya Pradesh');
    expect(out[0].destinationId).toBe(4);
    expect(out[0].fitScore).toBeGreaterThan(0);
  });

  test('board mismatch (school=CBSE, mapping=ICSE) → mapping filtered out', () => {
    const out = computeCurriculumFit(curriculumAnswers(), [
      curriculumMappingRow({ id: 1, curriculum: 'ICSE' }),
    ]);
    expect(out).toEqual([]);
  });

  test('grade-band mismatch (school=9-10, mapping grade=Class 5) → filtered out', () => {
    const out = computeCurriculumFit(curriculumAnswers(), [
      curriculumMappingRow({ id: 1, grade: 'Class 5' }),
    ]);
    expect(out).toEqual([]);
  });

  test('primary-outcome substring match boosts score (+50)', () => {
    const withoutOutcome = computeCurriculumFit(curriculumAnswers(), [
      curriculumMappingRow({ id: 1, learningOutcome: 'Geometry homework drill' }),
    ]);
    const withOutcome = computeCurriculumFit(curriculumAnswers(), [
      curriculumMappingRow({ id: 2, learningOutcome: 'Empathy field study' }),
    ]);
    expect(withoutOutcome[0].fitScore).toBeLessThan(withOutcome[0].fitScore);
    expect(withOutcome[0].fitScore - withoutOutcome[0].fitScore).toBe(50);
  });

  test('secondary-skill match adds smaller bonus (+20 each, cap 2)', () => {
    // Mapping has BOTH secondary skills in its outcome → +40 (2*20).
    const out = computeCurriculumFit(curriculumAnswers(), [
      curriculumMappingRow({
        id: 1,
        learningOutcome:
          'Self-awareness combined with cultural respect and inclusion field work',
      }),
    ]);
    const onlySecondaries = computeCurriculumFit(curriculumAnswers(), [
      curriculumMappingRow({
        id: 2,
        learningOutcome:
          'Self-awareness combined with cultural respect and inclusion field work',
      }),
    ]);
    // Both calls identical mapping → identical score; check the score
    // includes +40 (2 secondary matches) on top of base + grade band.
    // Base 50 + grade band 10 + 2 secondary matches 40 = 100. No primary.
    expect(out[0].fitScore).toBe(100);
    expect(onlySecondaries[0].fitScore).toBe(100);
  });

  test('topN respected — 10 mappings, topN: 3 → only 3 returned', () => {
    const mappings = [];
    for (let i = 0; i < 10; i++) {
      mappings.push(
        curriculumMappingRow({
          id: i + 1,
          learningOutcome: i < 5 ? 'Empathy lesson' : 'Geography lesson',
        }),
      );
    }
    const out = computeCurriculumFit(curriculumAnswers(), mappings, { topN: 3 });
    expect(out).toHaveLength(3);
  });

  test('sort order is fitScore desc (primary-outcome match leads)', () => {
    const out = computeCurriculumFit(curriculumAnswers(), [
      curriculumMappingRow({ id: 1, learningOutcome: 'Geography drill' }),
      curriculumMappingRow({ id: 2, learningOutcome: 'Empathy and cultural respect' }),
      curriculumMappingRow({ id: 3, learningOutcome: 'History timeline' }),
    ]);
    // mappingId=2 has primary-outcome match → highest score, lands first
    expect(out[0].mappingId).toBe(2);
    expect(out[0].fitScore).toBeGreaterThan(out[1].fitScore);
  });

  test('ties broken by mappingId asc (deterministic)', () => {
    const out = computeCurriculumFit(curriculumAnswers(), [
      curriculumMappingRow({ id: 50, learningOutcome: 'Geography drill' }),
      curriculumMappingRow({ id: 10, learningOutcome: 'History timeline' }),
      curriculumMappingRow({ id: 30, learningOutcome: 'Civics review' }),
    ]);
    // All three have NO outcome overlap → identical scores → mappingId asc
    expect(out.map((r) => r.mappingId)).toEqual([10, 30, 50]);
  });

  test('fitRationale includes human-readable reason text', () => {
    const out = computeCurriculumFit(curriculumAnswers(), [
      curriculumMappingRow({
        id: 1,
        learningOutcome: 'Empathy + self-awareness lessons',
      }),
    ]);
    expect(out[0].fitRationale).toBeTruthy();
    expect(typeof out[0].fitRationale).toBe('string');
    expect(out[0].fitRationale.toLowerCase()).toMatch(/empathy|primary|secondary|grade/);
  });

  test('multi-board input (CBSE + IGCSE) → both branches matched', () => {
    const out = computeCurriculumFit(
      curriculumAnswers({ curriculum: ['CBSE', 'IGCSE'] }),
      [
        curriculumMappingRow({ id: 1, curriculum: 'CBSE', grade: 'Class 9' }),
        curriculumMappingRow({ id: 2, curriculum: 'IGCSE', grade: 'IGCSE Year 10' }),
        curriculumMappingRow({ id: 3, curriculum: 'ICSE', grade: 'Class 9' }),
      ],
    );
    const ids = out.map((r) => r.mappingId).sort((a, b) => a - b);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).not.toContain(3);
  });

  test('answers with no curriculum field → returns [] (no crash)', () => {
    const out = computeCurriculumFit(
      curriculumAnswers({ curriculum: undefined }),
      [curriculumMappingRow()],
    );
    expect(out).toEqual([]);
  });

  test('case-insensitive outcome match (Empathy ⊂ "Field empathy through travel")', () => {
    const out = computeCurriculumFit(curriculumAnswers(), [
      curriculumMappingRow({ id: 1, learningOutcome: 'FIELD EMPATHY THROUGH TRAVEL' }),
    ]);
    expect(out[0].fitScore).toBeGreaterThan(50);
    // Primary outcome bonus fired despite case mismatch.
    const baselineNoOutcome = computeCurriculumFit(curriculumAnswers(), [
      curriculumMappingRow({ id: 2, learningOutcome: 'Map drills only' }),
    ]);
    expect(out[0].fitScore - baselineNoOutcome[0].fitScore).toBe(50);
  });

  test('gradeMatchesBand helper — band 9-10 matches "Class 9" / "Class 10" but not "Class 5"', () => {
    expect(gradeMatchesBand('Class 9', '9-10')).toBe(true);
    expect(gradeMatchesBand('Class 10', '9-10')).toBe(true);
    expect(gradeMatchesBand('Class 5', '9-10')).toBe(false);
    expect(gradeMatchesBand('IGCSE Year 10', '9-10')).toBe(true);
    expect(gradeMatchesBand('IB Year 11', '11-12')).toBe(true);
  });

  test('default topN is 5 when opts omitted', () => {
    const mappings = [];
    for (let i = 0; i < 12; i++) {
      mappings.push(curriculumMappingRow({ id: i + 1 }));
    }
    const out = computeCurriculumFit(curriculumAnswers(), mappings);
    expect(out).toHaveLength(5);
  });

  test('runTmcDiagnosticEngine without 4th arg → curriculumFit: [] (backward compat)', () => {
    const answers = {
      primary_outcome: 'Global awareness',
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'domestic',
      budget_band: '30k-75k',
      school_profile: SCHOOL_BREADWINNING,
    };
    const result = runTmcDiagnosticEngine(answers, []);
    expect(result.curriculumFit).toEqual([]);
  });

  test('runTmcDiagnosticEngine with 4th arg → curriculumFit populated when matches exist', () => {
    const answers = {
      primary_outcome: 'Empathy',
      secondary_skills: ['Cultural respect and inclusion', 'Self-awareness'],
      grade_band: '9-10',
      curriculum: 'CBSE',
      geo_preference: 'domestic',
      budget_band: '30k-75k',
      school_profile: SCHOOL_BREADWINNING,
    };
    const result = runTmcDiagnosticEngine(
      answers,
      [],
      undefined,
      [curriculumMappingRow({ id: 1, learningOutcome: 'Empathy through field work' })],
    );
    expect(Array.isArray(result.curriculumFit)).toBe(true);
    expect(result.curriculumFit).toHaveLength(1);
    expect(result.curriculumFit[0].mappingId).toBe(1);
  });
});
