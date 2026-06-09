// TMC School-Readiness Diagnostic — deterministic matching + routing engine.
//
// Pure function. NO database. NO LLM. NO fetch. NO file I/O. Takes
// (answers, catalogue, weights) and returns
//   { state, primary, alternative, flags, icpTier, scores }
//
// Source of truth: docs/PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md
//   §3.3   matching + routing engine (3 output states, hard filters,
//          6 scoring signals, two-key sort, select+flag)
//   §3.3.6 ICP tier computation (5 tiers from Q11 profile)
//   §3.10  build sequence step 2 (this module + 10 vitest cases)
//   §11.1  two-key sort invariant proof (the +50 primary weight does
//          NOT enforce the ordering; it lives in a sort tier above
//          score, not inside it — see "Two-key sort" section below).
//   §11.2  grade-centering rule lockdown (midpoint ceiling, upper-half
//          of trip range only)
//
// The LLM never picks a trip. This module is the authority. T6
// (tmcDiagnosticPrompts) and T7 (tmcReportGuard) consume the result;
// they never reorder or override it.
//
// Determinism contract (NF-1): same (answers, catalogue, weights) →
// byte-identical output. Tie-breaks are explicit (tighter primary
// match → higher affordable tier → tripId asc). Sort is stable on
// equal sort keys via tripId asc fallback. No Math.random, no Date.now,
// no environment reads.
//
// Why this is a separate module from backend/lib/travelDiagnosticScoring.js
// (the generic RFU/TS/VS weighted-sum scorer): the TMC contract is
// structurally distinct — two-key lexicographic sort + ICP tier +
// per-signal breakdown + invariant proofs that don't fit the
// "sum weights, classify band" shape. The generic scorer continues
// to serve RFU/Travel Stall/Visa Sure unchanged.
//
// Parallel-safe with T3 (lead-quality classifier) and T4 (seed). All
// three share no files.

'use strict';

// ── Default weights (PRD §3.3.3 + EngineWeights model defaults) ─────
//
// These match the EngineWeights Prisma model defaults exactly so a
// caller that hasn't loaded the DB row gets the same result the DB
// would have produced. Callers MAY override any subset; the engine
// merges over these defaults.
const DEFAULT_WEIGHTS = Object.freeze({
  weightPrimaryOutcome: 50,
  weightSecondarySkill: 20, // per match, capped at 40 (max 2 secondaries)
  weightGrowthArea: 15, // once; 0 if duplicates a Q2 pick (no double-pay)
  weightCurriculumHook: 10,
  weightGradeBandCenter: 10,
  weightTierValueLean: 8, // applied only when geo_preference=open
  scoresWellThreshold: 70,
});

// ── Grade-band index lookup (PRD §3.1 Q5 + §3.3.3 grade-centering) ──
//
// The 4 fixed Q5 bands as ordered indices. Used by the hard grade-band
// filter AND the grade-centering scoring signal. PRD §11.2 locks the
// rule with a boundary test — band exactly at the midpoint ceiling
// scores; one below doesn't.
const GRADE_BAND_INDEX = Object.freeze({
  '4-6': 0,
  '6-8': 1,
  '9-10': 2,
  '11-12': 3,
});

// ── Price band ordering (PRD §3.1 Q9 + §3.3.3 budget hard filter) ───
//
// Lower index = cheaper. Budget hard filter removes trips whose
// priceBand index > school's budgetBand index. PRD frozen tokens.
const PRICE_BAND_INDEX = Object.freeze({
  'upto-5k': 0,
  '10k-30k': 1,
  '30k-75k': 2,
  '1l-2l': 3,
  '2l-plus': 4,
});

// ── Tier ordering (PRD §3.3.3 tier-value lean + DD-5.1) ─────────────
//
// Higher index = preferred under "open" geo + budget-allows. Used by
// the tier-value-lean +8 scoring signal AND the tie-break "higher
// affordable tier" rule in the two-key sort.
const TIER_INDEX = Object.freeze({
  day: 0,
  domestic: 1,
  international: 2,
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Safe JSON parse for the *Json columns on TmcTripCatalogue. Returns
 * [] on parse failure rather than throwing — the engine treats a
 * malformed row the same as a row that simply doesn't carry that
 * field. The catalogue admin gate (NF-9) is responsible for keeping
 * the rows clean before status=active.
 */
function parseJsonArray(maybeJson) {
  if (Array.isArray(maybeJson)) return maybeJson;
  if (typeof maybeJson !== 'string' || maybeJson.length === 0) return [];
  try {
    const parsed = JSON.parse(maybeJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return [];
  }
}

/**
 * Normalize the school's curriculum answer (Q6) into an array of board
 * keys. Q6 can be a single string ("CBSE") or an array (the "More than
 * one" follow-up). PRD §3.3.3 step 4 says "if multiple selected, pass
 * if ANY selected board is supported."
 */
function curriculumToArray(curriculum) {
  if (Array.isArray(curriculum)) return curriculum.filter(Boolean);
  if (typeof curriculum === 'string' && curriculum.length > 0) {
    return [curriculum];
  }
  return [];
}

/**
 * Merge caller weights over DEFAULT_WEIGHTS. Numeric coercion, NaN
 * → fallback to default. This is the only place the engine reads
 * weights — every scoring signal pulls from the merged object.
 */
function mergeWeights(weights) {
  const merged = { ...DEFAULT_WEIGHTS };
  if (weights && typeof weights === 'object') {
    for (const key of Object.keys(DEFAULT_WEIGHTS)) {
      const v = weights[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        merged[key] = v;
      }
    }
  }
  return merged;
}

// ── ICP tier (PRD §3.3.6) ────────────────────────────────────────────
//
// Computed from Q11 profile fields:
//   branches:         "1" | "2" | "3+"            (mapped to integer)
//   student_strength: "under 500" | "500-1000" | "1000-2000" | "2000-plus"
//   fee_band:         "under 75k" | "75k-1l" | "1l-plus"
//
// The token strings are the §3.1 Q11 contract. The engine accepts both
// the token forms AND already-coerced integers so callers can pre-parse
// if convenient. Profiles that don't classify fall back to
// 'unclassified' which the brief routes as breadwinning per PRD.

function branchesToInt(branches) {
  if (typeof branches === 'number') return branches;
  if (typeof branches !== 'string') return 0;
  const s = branches.trim().toLowerCase();
  if (s === '1') return 1;
  if (s === '2') return 2;
  if (s === '3+' || s === '3') return 3;
  return 0;
}

function studentStrengthMin(token) {
  if (typeof token === 'number') return token;
  if (typeof token !== 'string') return 0;
  const t = token.trim().toLowerCase();
  if (t === 'under 500') return 0;
  if (t === '500-1000') return 500;
  if (t === '1000-2000') return 1000;
  if (t === '2000-plus' || t === '2000+') return 2000;
  return 0;
}

function feeBandMin(token) {
  if (typeof token === 'number') return token;
  if (typeof token !== 'string') return 0;
  const t = token.trim().toLowerCase();
  if (t === 'under 75k') return 0;
  if (t === '75k-1l') return 75000;
  if (t === '1l-plus' || t === '1l+') return 100000;
  return 0;
}

/**
 * Returns one of {amazing, breadwinning, convenience, dangerous,
 * unclassified} per the PRD §3.3.6 table. The function is intentionally
 * a chain of explicit checks (not a scoring table) because the rules
 * are categorical, not weighted.
 */
function computeIcpTier(answers) {
  const profile = answers.school_profile || answers;
  const branches = branchesToInt(profile.branches);
  const strengthMin = studentStrengthMin(profile.student_strength);
  const feeMin = feeBandMin(profile.fee_band);

  // Dangerous (checked first — short-circuits other bands):
  //   fee < 75k OR (strength < 500 AND fee < 75k)
  // The second leg is logically implied by the first leg given the
  // bands, but the PRD spells it out, so we mirror it exactly.
  if (feeMin < 75000) return 'dangerous';
  if (strengthMin < 500 && feeMin < 75000) return 'dangerous';

  // Amazing: branches ≥ 3 AND strength ≥ 2000 AND fee ≥ 1L
  if (branches >= 3 && strengthMin >= 2000 && feeMin >= 100000) {
    return 'amazing';
  }

  // Breadwinning: branches ∈ [1,2] AND strength ∈ [1000, 2000] AND fee ≥ 1L
  if (
    branches >= 1 &&
    branches <= 2 &&
    strengthMin >= 1000 &&
    strengthMin < 2000 &&
    feeMin >= 100000
  ) {
    return 'breadwinning';
  }

  // Convenience: strength < 1000 AND fee ∈ [75k, 1L]
  if (strengthMin < 1000 && feeMin >= 75000 && feeMin < 100000) {
    return 'convenience';
  }

  return 'unclassified';
}

// ── Hard filters (PRD §3.3.2) ────────────────────────────────────────
//
// Applied in PRD order: budget → tier scope → grade band → board.
// Returns the filter outcome per trip so the caller can audit which
// trips were eliminated and why (used by §3.3.7 audit, also exposed
// in the `scores` return for triage).

/** Budget hard filter. Returns true if the trip survives. */
function passesBudgetFilter(trip, budgetBand) {
  if (budgetBand === 'unknown' || budgetBand == null) return true;
  const schoolIdx = PRICE_BAND_INDEX[budgetBand];
  const tripIdx = PRICE_BAND_INDEX[trip.priceBand];
  if (schoolIdx == null || tripIdx == null) return true; // unknown band → don't filter
  return tripIdx <= schoolIdx;
}

/** Tier-scope hard filter. */
function passesTierFilter(trip, geoPreference) {
  if (geoPreference === 'open' || geoPreference == null) return true;
  if (geoPreference === 'day') return trip.tier === 'day';
  if (geoPreference === 'domestic') return trip.tier === 'domestic';
  if (geoPreference === 'international') return trip.tier === 'international';
  return true;
}

/** Grade-band hard filter — school band within trip's [min, max] range. */
function passesGradeBandFilter(trip, gradeBand) {
  const schoolIdx = GRADE_BAND_INDEX[gradeBand];
  const tripMinIdx = GRADE_BAND_INDEX[trip.minGradeBand];
  const tripMaxIdx = GRADE_BAND_INDEX[trip.maxGradeBand];
  if (schoolIdx == null || tripMinIdx == null || tripMaxIdx == null) {
    return false;
  }
  return schoolIdx >= tripMinIdx && schoolIdx <= tripMaxIdx;
}

/** Board hard filter — any selected board in trip's boardsSupportedJson. */
function passesBoardFilter(trip, curriculumArr) {
  if (curriculumArr.length === 0) return true; // no constraint
  const supported = parseJsonArray(trip.boardsSupportedJson);
  if (supported.length === 0) return false; // trip declares no boards = misconfigured
  for (const board of curriculumArr) {
    if (supported.includes(board)) return true;
  }
  return false;
}

// ── 6 scoring signals (PRD §3.3.3) ───────────────────────────────────
//
// Each signal is a separate function so the test suite can probe it in
// isolation. Returns `{ points, matched }` so the per-signal breakdown
// captured in `engine_scores` JSON (NF-3) shows both the awarded
// points AND a boolean of whether the signal fired (the latter matters
// for two-key sort — primary-outcome match is sort tier 1, separate
// from the +50 score contribution).

function scorePrimaryOutcome(trip, answers, weights) {
  const tripOutcomes = parseJsonArray(trip.primaryOutcomesJson);
  const matched =
    typeof answers.primary_outcome === 'string' &&
    tripOutcomes.includes(answers.primary_outcome);
  return {
    points: matched ? weights.weightPrimaryOutcome : 0,
    matched,
  };
}

function scoreSecondarySkill(trip, answers, weights) {
  const tripSkills = parseJsonArray(trip.skillsDevelopedJson);
  const schoolSkills = Array.isArray(answers.secondary_skills)
    ? answers.secondary_skills
    : [];
  let matches = 0;
  for (const s of schoolSkills) {
    if (tripSkills.includes(s)) matches++;
  }
  // Per PRD §3.3.3: +20 each, max +40 (cap at 2 even if school answer
  // accidentally contains 3+; the Q2 contract is exactly 2, but the
  // engine defends against malformed answers).
  const cappedMatches = Math.min(matches, 2);
  const points = cappedMatches * weights.weightSecondarySkill;
  // The per-signal cap is 2 * weightSecondarySkill regardless of how
  // many extra matches a malformed answer accidentally provides.
  const capPoints = 2 * weights.weightSecondarySkill;
  return {
    points: Math.min(points, capPoints),
    matchCount: cappedMatches,
    matched: cappedMatches > 0,
  };
}

function scoreGrowthArea(trip, answers, weights) {
  const growthSkill = answers.growth_area_skill || answers.growth_area;
  if (typeof growthSkill !== 'string' || growthSkill.length === 0) {
    return { points: 0, matched: false, duplicateOfSecondary: false };
  }
  const tripSkills = parseJsonArray(trip.skillsDevelopedJson);
  const schoolSecondaries = Array.isArray(answers.secondary_skills)
    ? answers.secondary_skills
    : [];

  // PRD §3.3.3 + AC-5: "AND NOT already a Q2 pick (no double-pay)"
  if (schoolSecondaries.includes(growthSkill)) {
    return {
      points: 0,
      matched: tripSkills.includes(growthSkill),
      duplicateOfSecondary: true,
    };
  }
  const matched = tripSkills.includes(growthSkill);
  return {
    points: matched ? weights.weightGrowthArea : 0,
    matched,
    duplicateOfSecondary: false,
  };
}

function scoreCurriculumHook(trip, answers, weights) {
  const hooks = parseJsonArray(trip.curriculumHooksJson);
  const curriculumArr = curriculumToArray(answers.curriculum);
  const schoolGradeBand = answers.grade_band;
  for (const h of hooks) {
    if (!h || typeof h !== 'object') continue;
    if (
      curriculumArr.includes(h.board) &&
      h.grade_band === schoolGradeBand
    ) {
      return { points: weights.weightCurriculumHook, matched: true };
    }
  }
  return { points: 0, matched: false };
}

/**
 * Grade-band centering per PRD §3.3.3 + §11.2.
 *
 * Bands 4-6 / 6-8 / 9-10 / 11-12 are indices 0..3. Trip range is
 * [minGradeBand, maxGradeBand]. Midpoint = (min + max) / 2. Ceiling =
 * Math.ceil. Award +10 only when school's band index ≥ midpoint
 * ceiling.
 *
 * Example from §3.3.3: trip 6-8 to 11-12 has indices [1, 3], midpoint
 * 2, ceiling 2. So bands 9-10 (idx 2) and 11-12 (idx 3) score; band
 * 6-8 (idx 1) doesn't.
 *
 * Boundary case from PRD §3.10 step 2 case 8: a band exactly at the
 * midpoint ceiling MUST score; one below MUST not. Locked by the
 * grade-centering boundary test.
 */
function scoreGradeCenter(trip, answers, weights) {
  const schoolIdx = GRADE_BAND_INDEX[answers.grade_band];
  const tripMinIdx = GRADE_BAND_INDEX[trip.minGradeBand];
  const tripMaxIdx = GRADE_BAND_INDEX[trip.maxGradeBand];
  if (schoolIdx == null || tripMinIdx == null || tripMaxIdx == null) {
    return { points: 0, matched: false };
  }
  const midpointCeil = Math.ceil((tripMinIdx + tripMaxIdx) / 2);
  const matched = schoolIdx >= midpointCeil;
  return {
    points: matched ? weights.weightGradeBandCenter : 0,
    matched,
  };
}

/**
 * Tier-value lean per PRD §3.3.3. Applied ONLY when
 * geo_preference=open. Prefers higher affordable tier (international >
 * domestic > day). The "budget allows" condition is structural — only
 * trips that pass the budget hard filter reach scoring, so any
 * surviving trip's tier is, by definition, affordable. The lean just
 * differentiates the survivors.
 *
 * Award +8 when:
 *   - geo_preference is "open" or null/undefined
 *   - trip.tier is the highest tier present in the surviving set
 *
 * We don't have visibility into "highest surviving tier" from this
 * per-trip scorer, so we award +8 to international, +4 (no — the
 * weight is integer; PRD says +8 binary). Re-reading PRD: "Prefer
 * higher affordable tier (international > domestic > day)." Treated
 * as "+8 when the trip's tier is international AND geo=open" because
 * that's the cleanest binary interpretation of the lean. Domestic
 * doesn't get the lean because it's not the "higher" affordable tier
 * — the lean is a tiebreak toward international when budget allows
 * AND school is open to anything.
 *
 * If both an international AND a domestic trip survive under open
 * geo, the international gets +8 and the domestic doesn't — that's
 * the "lean toward higher". If only a domestic survives, no lean
 * applies (no higher tier was an option). This is the rule the
 * worked example in §3.10 lines up with.
 */
function scoreTierLean(trip, answers, weights) {
  const geo = answers.geo_preference;
  if (geo !== 'open' && geo != null) {
    return { points: 0, matched: false };
  }
  const matched = trip.tier === 'international';
  return {
    points: matched ? weights.weightTierValueLean : 0,
    matched,
  };
}

// ── Per-trip score breakdown ─────────────────────────────────────────

/**
 * Compute the full per-signal breakdown for one trip. Returns
 *   { tripId, total, primaryMatch, signals: {...}, trip }
 * where `signals` contains the points + matched flag for each of the
 * 6 signals, and `primaryMatch` is the sort-tier-1 key (separate from
 * the +50 inside `total`).
 *
 * Persisted in `TravelDiagnostic.engineScoresJson` for audit (NF-3)
 * and §3.3.7 tuning-protocol disagreement triage.
 */
function scoreTrip(trip, answers, weights) {
  const primary = scorePrimaryOutcome(trip, answers, weights);
  const secondary = scoreSecondarySkill(trip, answers, weights);
  const growth = scoreGrowthArea(trip, answers, weights);
  const hook = scoreCurriculumHook(trip, answers, weights);
  const grade = scoreGradeCenter(trip, answers, weights);
  const tierLean = scoreTierLean(trip, answers, weights);
  const total =
    primary.points +
    secondary.points +
    growth.points +
    hook.points +
    grade.points +
    tierLean.points;
  return {
    tripId: trip.tripId,
    total,
    primaryMatch: primary.matched,
    signals: {
      primaryOutcome: primary,
      secondarySkill: secondary,
      growthArea: growth,
      curriculumHook: hook,
      gradeBandCenter: grade,
      tierValueLean: tierLean,
    },
    trip,
  };
}

// ── Two-key sort (PRD §3.3.4 + §11.1) ────────────────────────────────
//
// THE LOAD-BEARING INVARIANT. A trip missing the school's primary
// outcome can NEVER outrank a trip matching it. This is NOT enforced
// by the +50 weight (which is a hypothesis, tunable in pilot). It's
// enforced structurally by sorting on (primaryMatch, total) where
// primaryMatch is the OUTER key.
//
// Tie-break order:
//   1. primaryMatch desc (matched > unmatched) — the invariant
//   2. total desc
//   3. "tighter primary match" — trip with FEWER primary_outcomes
//      listed beats one with more (a trip serving 1 outcome is a
//      tighter fit than a trip serving 3, when both match the school's
//      primary). Determinism: cheaper than a separate "specificity"
//      score because the catalogue already encodes specificity in
//      array length.
//   4. higher affordable tier (international > domestic > day) —
//      structural under "open" geo, deterministic fallback under
//      strict geo (only one tier survives anyway)
//   5. tripId alphabetical asc — the deterministic deadlock break
//      that locks NF-1 (same inputs → byte-identical output)
function compareScored(a, b) {
  // 1. primaryMatch outer key
  if (a.primaryMatch !== b.primaryMatch) {
    return a.primaryMatch ? -1 : 1;
  }
  // 2. total score desc
  if (a.total !== b.total) {
    return b.total - a.total;
  }
  // 3. tighter primary match — fewer primary_outcomes in trip wins
  const aOutcomes = parseJsonArray(a.trip.primaryOutcomesJson).length;
  const bOutcomes = parseJsonArray(b.trip.primaryOutcomesJson).length;
  if (aOutcomes !== bOutcomes) {
    return aOutcomes - bOutcomes;
  }
  // 4. higher affordable tier
  const aTier = TIER_INDEX[a.trip.tier] ?? -1;
  const bTier = TIER_INDEX[b.trip.tier] ?? -1;
  if (aTier !== bTier) {
    return bTier - aTier;
  }
  // 5. tripId asc — deterministic fallback (NF-1)
  if (a.tripId < b.tripId) return -1;
  if (a.tripId > b.tripId) return 1;
  return 0;
}

// ── Alternative selection (PRD §3.3.5) ───────────────────────────────
//
// "Meaningfully different" = different tier OR different lead
// primary_outcome. If next-down matches BOTH axes, skip and take the
// next that differs. If no surviving trip differs on either axis,
// return next-highest + flag `thin_alternative`. Never fabricate
// difference.

function pickAlternative(sortedScored) {
  if (sortedScored.length <= 1) return { alternative: null, thin: false };
  const primary = sortedScored[0];
  const primaryTier = primary.trip.tier;
  const primaryLeadOutcome = parseJsonArray(
    primary.trip.primaryOutcomesJson,
  )[0];

  for (let i = 1; i < sortedScored.length; i++) {
    const candidate = sortedScored[i];
    const candTier = candidate.trip.tier;
    const candLead = parseJsonArray(candidate.trip.primaryOutcomesJson)[0];
    const differsOnTier = candTier !== primaryTier;
    const differsOnLead = candLead !== primaryLeadOutcome;
    if (differsOnTier || differsOnLead) {
      return { alternative: candidate, thin: false };
    }
  }
  // No surviving trip differs — return next-highest + thin flag
  return { alternative: sortedScored[1], thin: true };
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Run the TMC deterministic matching + routing engine.
 *
 * @param {object} answers - The school's 12-question diagnostic answers
 *   (PRD §3.1). Required keys for scoring:
 *     - primary_outcome (string, Q1 option key)
 *     - secondary_skills (string[], Q2, exactly 2 of the 7 canonical)
 *     - growth_area (string, Q3 option) and/or growth_area_skill
 *       (the mapped canonical skill key from the Q3-to-skill table)
 *     - grade_band (string, Q5 one of "4-6"/"6-8"/"9-10"/"11-12")
 *     - curriculum (string | string[], Q6 board(s))
 *     - geo_preference (string, Q7 "day"/"domestic"/"international"/"open")
 *     - budget_band (string, Q9 — "unknown" disables budget filter)
 *     - group_size (string, Q8 — used only for below_min_group flag)
 *     - school_profile (object, Q11 — drives ICP tier)
 *
 * @param {Array<object>} catalogue - Active TmcTripCatalogue rows.
 *   Engine treats all passed rows as candidates (caller is expected
 *   to filter `status=active` already, but engine doesn't depend on
 *   the field).
 *
 * @param {object} [weights] - Override for any of the 6 weights +
 *   scoresWellThreshold. Missing keys fall back to DEFAULT_WEIGHTS.
 *
 * @returns {object} {
 *   state: 'strong_match' | 'partial_match' | 'no_match',
 *   primary: trip | null,
 *   alternative: trip | null,
 *   flags: string[],
 *   icpTier: 'amazing'|'breadwinning'|'convenience'|'dangerous'|'unclassified',
 *   scores: {
 *     survivors: ScoredTrip[],            // sorted, full per-signal breakdown
 *     eliminated: { tripId, reason }[],   // hard-filter audit trail
 *     weightsUsed: { ... },               // merged weights snapshot
 *   }
 * }
 */
function runTmcDiagnosticEngine(answers, catalogue, weights, curriculumMappings) {
  if (!answers || typeof answers !== 'object') {
    throw new TypeError('runTmcDiagnosticEngine: answers must be an object');
  }
  if (!Array.isArray(catalogue)) {
    throw new TypeError('runTmcDiagnosticEngine: catalogue must be an array');
  }
  const mergedWeights = mergeWeights(weights);
  const curriculumArr = curriculumToArray(answers.curriculum);
  // C7 — curriculum-fit top-N. Optional input; missing/empty → empty
  // array (no behaviour change for any pre-C7 caller).
  const curriculumFit = Array.isArray(curriculumMappings)
    && curriculumMappings.length > 0
      ? computeCurriculumFit(answers, curriculumMappings, { topN: 5 })
      : [];

  // ── Step 1: hard filters (PRD §3.3.2), in PRD order ───────────────
  const survivors = [];
  const eliminated = [];

  for (const trip of catalogue) {
    if (!trip || typeof trip !== 'object') continue;
    if (!passesBudgetFilter(trip, answers.budget_band)) {
      eliminated.push({ tripId: trip.tripId, reason: 'budget' });
      continue;
    }
    if (!passesTierFilter(trip, answers.geo_preference)) {
      eliminated.push({ tripId: trip.tripId, reason: 'tier_scope' });
      continue;
    }
    if (!passesGradeBandFilter(trip, answers.grade_band)) {
      eliminated.push({ tripId: trip.tripId, reason: 'grade_band' });
      continue;
    }
    if (!passesBoardFilter(trip, curriculumArr)) {
      eliminated.push({ tripId: trip.tripId, reason: 'board' });
      continue;
    }
    survivors.push(trip);
  }

  // ── Cross-cutting flags computed up front (UC-5 + UC-7 + budget) ──
  const flags = [];
  if (answers.budget_band === 'unknown' || answers.budget_band == null) {
    flags.push('budget_unknown');
  }
  // Scope-budget conflict per UC-5: international geo + a cheap band.
  // PRD names "10k-30k" explicitly; generalize to "any band < 30k-75k"
  // (i.e. upto-5k or 10k-30k) under international geo.
  if (
    answers.geo_preference === 'international' &&
    (answers.budget_band === 'upto-5k' || answers.budget_band === '10k-30k')
  ) {
    flags.push('scope_budget_conflict');
  }

  // ── ICP tier (PRD §3.3.6) — always computed, never depends on match ─
  const icpTier = computeIcpTier(answers);

  // ── Step 2: score the survivors (PRD §3.3.3) ──────────────────────
  const scored = survivors.map((t) => scoreTrip(t, answers, mergedWeights));

  // ── Step 3: two-key sort (PRD §3.3.4 + §11.1) ─────────────────────
  scored.sort(compareScored);

  // ── Step 4: select + flag (PRD §3.3.5) ────────────────────────────

  // Zero-survivor → no_match + custom-concept brief signal
  if (scored.length === 0) {
    flags.push('needs_custom');
    return {
      state: 'no_match',
      primary: null,
      alternative: null,
      flags,
      icpTier,
      scores: {
        survivors: [],
        eliminated,
        weightsUsed: mergedWeights,
      },
      curriculumFit,
    };
  }

  // Single-survivor → partial_match, no alternative, single_survivor flag
  if (scored.length === 1) {
    const only = scored[0];
    flags.push('single_survivor');
    // Single survivor can still be a strong match if it cleared the bar.
    // PRD §3.3.5: "Scores well = primary-outcome match AND total ≥70."
    const scoresWell =
      only.primaryMatch && only.total >= mergedWeights.scoresWellThreshold;
    // Below-min-group flag check on the chosen primary (UC-7)
    maybeBelowMinGroup(only.trip, answers, flags);
    return {
      state: scoresWell ? 'strong_match' : 'partial_match',
      primary: only.trip,
      alternative: null,
      flags,
      icpTier,
      scores: {
        survivors: scored,
        eliminated,
        weightsUsed: mergedWeights,
      },
      curriculumFit,
    };
  }

  // ≥2 survivors: primary = top, alternative = first meaningfully-different
  const primary = scored[0];
  const { alternative, thin } = pickAlternative(scored);
  if (thin) flags.push('thin_alternative');

  // Below-min-group flag (UC-7) checked on primary
  maybeBelowMinGroup(primary.trip, answers, flags);

  // State: strong_match requires primary-outcome match AND total ≥ threshold
  const strong =
    primary.primaryMatch &&
    primary.total >= mergedWeights.scoresWellThreshold;

  return {
    state: strong ? 'strong_match' : 'partial_match',
    primary: primary.trip,
    alternative: alternative ? alternative.trip : null,
    flags,
    icpTier,
    scores: {
      survivors: scored,
      eliminated,
      weightsUsed: mergedWeights,
    },
    curriculumFit,
  };
}

/**
 * Below-min-group flag per UC-7 + PRD §3.3.2 "group_size is NOT a hard
 * filter — produces a below_min_group flag." The engine compares the
 * Q8 group_size band's lower bound against the trip's minGroupSize.
 * Q8 tokens map to minimum integers:
 *   "<35" → 1, "35-45" → 35, "45-80" → 45, "80-150" → 80, "150+" → 150
 */
function groupSizeMin(token) {
  if (typeof token === 'number') return token;
  if (typeof token !== 'string') return null;
  const t = token.trim().toLowerCase();
  if (t === '<35' || t === 'under 35') return 1;
  if (t === '35-45') return 35;
  if (t === '45-80') return 45;
  if (t === '80-150') return 80;
  if (t === '150+' || t === '150-plus') return 150;
  return null;
}

function maybeBelowMinGroup(trip, answers, flags) {
  const schoolMin = groupSizeMin(answers.group_size);
  if (schoolMin == null) return;
  const tripMin = Number(trip.minGroupSize);
  if (!Number.isFinite(tripMin)) return;
  if (schoolMin < tripMin) {
    if (!flags.includes('below_min_group')) {
      flags.push('below_min_group');
    }
  }
}

// ── C7 — Curriculum-Fit top-N recommendations (PRD §FR-5) ────────────
//
// Per PRD_TMC_CURRICULUM_MAPPING.md FR-5 the engine extends its envelope
// with a `curriculumFit` array: the top-N TravelCurriculumMapping rows
// that best fit the submitter's (board × grade-band × outcome) profile.
// Pure function — no DB, no fetch. Takes pre-fetched mapping rows as
// input. The submit-tmc route fetches active mappings up-front and
// hands them in.
//
// The scoring is deliberately simple (overlap-with-outcomes) so the
// signal is auditable end-to-end during the V1 pilot. A learned scorer
// can replace this later without changing the route's contract — the
// route only knows about the function signature + output shape.

// Q5 grade_band → curriculum-mapping `grade` string tokens. Used to
// match Q5 ("9-10") against the curriculum mapping's free-text grade
// field ("Class 9", "Class 10", "IB Year 1", "IGCSE Year 10", etc.).
// The mapping is a substring-match — if a mapping's grade contains the
// digit pair the band names, it counts as a band hit. This lets one
// table serve CBSE + ICSE + IB + Cambridge without per-curriculum
// branching, at the cost of a slightly noisier match (e.g. "Class 6"
// hits both band 4-6 AND 6-8). The duplicate hit is intentional —
// schools straddling the boundary year see destinations from both
// neighbours, which matches real classroom planning.
const GRADE_BAND_TO_GRADE_NUMBERS = Object.freeze({
  '4-6': ['4', '5', '6'],
  '6-8': ['6', '7', '8'],
  '9-10': ['9', '10'],
  '11-12': ['11', '12'],
});

function gradeMatchesBand(gradeStr, gradeBand) {
  if (typeof gradeStr !== 'string' || gradeStr.length === 0) return false;
  const numbers = GRADE_BAND_TO_GRADE_NUMBERS[gradeBand];
  if (!numbers || numbers.length === 0) return false;
  // Tokenize on word boundaries so "Class 10" matches '10' but
  // "Class 100" wouldn't (defensive — we don't ship Class 100,
  // but the substring-on-digits approach without word-bounding
  // would also accept "Class 102", "IB 11 Year" etc. incorrectly).
  // Pattern: a digit-run boundary.
  for (const n of numbers) {
    const re = new RegExp(`(?:^|\\D)${n}(?:\\D|$)`);
    if (re.test(gradeStr)) return true;
  }
  return false;
}

/**
 * Compute top-N curriculum-fit recommendations for a TMC submission.
 *
 * Filters mappings by (board × grade-band) THEN scores each surviving
 * mapping by the overlap between its `learningOutcome` and the school's
 * primary_outcome + secondary_skills. Returns top-N sorted by fitScore
 * descending, with mappingId asc as the deterministic tie-break.
 *
 * @param {object} answers - TMC §3.1 answers. Reads:
 *     - primary_outcome (string, Q1 — primary outcome key)
 *     - secondary_skills (string[], Q2 — exactly 2)
 *     - curriculum (string | string[], Q6 — board(s))
 *     - grade_band (string, Q5 — "4-6"/"6-8"/"9-10"/"11-12")
 * @param {Array<object>} curriculumMappings - Active rows from
 *   TravelCurriculumMapping (already tenant-scoped). Each row shape:
 *     { id, curriculum, grade, subject, learningOutcome,
 *       destinationId, destinationLabel, fitScore, fitRationale }
 * @param {object} [opts]
 * @param {number} [opts.topN=5] - Max recommendations returned.
 * @returns {Array<object>} Top-N curriculum-fit rows, each:
 *   { mappingId, board, subject, grade, learningOutcome,
 *     destinationLabel, destinationId, fitScore, fitRationale }
 *
 * Empty cases:
 *   - curriculumMappings empty → []
 *   - answers.curriculum missing/empty → [] (no board to filter on)
 *   - zero rows survive board+grade filter → []
 */
function computeCurriculumFit(answers, curriculumMappings, opts) {
  const topN =
    opts && typeof opts.topN === 'number' && opts.topN > 0 ? opts.topN : 5;
  if (!Array.isArray(curriculumMappings) || curriculumMappings.length === 0) {
    return [];
  }
  if (!answers || typeof answers !== 'object') return [];

  const curriculumArr = curriculumToArray(answers.curriculum);
  if (curriculumArr.length === 0) return [];

  const gradeBand = answers.grade_band;
  const primaryOutcome =
    typeof answers.primary_outcome === 'string' ? answers.primary_outcome : '';
  const secondarySkills = Array.isArray(answers.secondary_skills)
    ? answers.secondary_skills.filter(
      (s) => typeof s === 'string' && s.length > 0,
    )
    : [];

  // Primary outcome bonus: +50 (primary match is the dominant signal,
  // mirrors the engine's weightPrimaryOutcome shape for symmetry).
  // Secondary skill bonus: +20 each, capped at +40 (cap of 2 matches —
  // mirrors scoreSecondarySkill's max). Grade-band aligned: +10
  // (matches weightGradeBandCenter shape). Base score before bonuses:
  // 50 (so a board+grade match with NO outcome overlap still surfaces).
  const PRIMARY_OUTCOME_BONUS = 50;
  const SECONDARY_SKILL_BONUS = 20;
  const SECONDARY_CAP_MATCHES = 2;
  const GRADE_BAND_BONUS = 10;
  const BASE_SCORE = 50;

  const scored = [];
  for (const mapping of curriculumMappings) {
    if (!mapping || typeof mapping !== 'object') continue;
    // Board (curriculum) filter — any of the school's selected boards
    // must match the mapping's curriculum.
    if (typeof mapping.curriculum !== 'string') continue;
    if (!curriculumArr.includes(mapping.curriculum)) continue;
    // Grade-band filter — mapping's grade string must reference any
    // class number that falls inside the school's Q5 band.
    if (!gradeMatchesBand(mapping.grade, gradeBand)) continue;

    const mappingOutcome =
      typeof mapping.learningOutcome === 'string'
        ? mapping.learningOutcome
        : '';

    // Outcome-overlap scoring. Substring-tolerant match (case-insensitive)
    // because mapping outcomes are advisor-authored free text while
    // answer outcomes are option keys — "empathy" ⊂ "Empathy + Cultural
    // respect" type matches MUST count.
    const lcOutcome = mappingOutcome.toLowerCase();
    const primaryMatched =
      primaryOutcome.length > 0 &&
      lcOutcome.length > 0 &&
      lcOutcome.includes(primaryOutcome.toLowerCase());
    let secondaryMatchCount = 0;
    const matchedSecondaries = [];
    for (const s of secondarySkills) {
      if (
        s.length > 0 &&
        lcOutcome.length > 0 &&
        lcOutcome.includes(s.toLowerCase())
      ) {
        secondaryMatchCount++;
        matchedSecondaries.push(s);
        if (secondaryMatchCount >= SECONDARY_CAP_MATCHES) break;
      }
    }

    const fitScore =
      BASE_SCORE +
      (primaryMatched ? PRIMARY_OUTCOME_BONUS : 0) +
      secondaryMatchCount * SECONDARY_SKILL_BONUS +
      GRADE_BAND_BONUS;

    // Human-readable rationale. Composed from the parts that fired so
    // advisors / parents see why the destination came up.
    const rationaleParts = [];
    if (primaryMatched) {
      rationaleParts.push(`Primary outcome match (${primaryOutcome})`);
    }
    if (secondaryMatchCount > 0) {
      rationaleParts.push(
        `secondary skill alignment (${matchedSecondaries.join(', ')})`,
      );
    }
    rationaleParts.push('grade band aligned');
    const fitRationale = rationaleParts
      .join(' + ')
      .replace(/^./, (c) => c.toUpperCase());

    // mappingId is the deterministic tie-break for byte-identical
    // ordering on equal-score rows (NF-1 contract).
    const mappingId = Number.isFinite(mapping.id) ? mapping.id : 0;

    scored.push({
      mappingId,
      board: mapping.curriculum,
      subject: typeof mapping.subject === 'string' ? mapping.subject : '',
      grade: typeof mapping.grade === 'string' ? mapping.grade : '',
      learningOutcome: mappingOutcome,
      destinationLabel:
        typeof mapping.destinationLabel === 'string'
          ? mapping.destinationLabel
          : null,
      destinationId: Number.isFinite(mapping.destinationId)
        ? mapping.destinationId
        : null,
      fitScore,
      fitRationale,
    });
  }

  // Sort: fitScore desc, mappingId asc (deterministic tie-break).
  scored.sort((a, b) => {
    if (a.fitScore !== b.fitScore) return b.fitScore - a.fitScore;
    return a.mappingId - b.mappingId;
  });

  return scored.slice(0, topN);
}

// ── Exports ──────────────────────────────────────────────────────────
//
// Public surface: runTmcDiagnosticEngine is the entry point. The
// constants + per-signal scorers + ICP computer are exported for the
// vitest suite so each piece can be probed independently per PRD §3.10
// step 2's hand-checked test cases.
//
// C7 additive: runTmcDiagnosticEngine accepts an optional 4th argument
// (curriculumMappings array). When supplied, the returned envelope
// includes a `curriculumFit` field (top-N recommendations). When omitted
// or empty, `curriculumFit` is [] — backward-compatible with every
// pre-C7 caller.
module.exports = {
  runTmcDiagnosticEngine,
  // For tests: probe each piece independently
  DEFAULT_WEIGHTS,
  GRADE_BAND_INDEX,
  PRICE_BAND_INDEX,
  TIER_INDEX,
  computeIcpTier,
  passesBudgetFilter,
  passesTierFilter,
  passesGradeBandFilter,
  passesBoardFilter,
  scorePrimaryOutcome,
  scoreSecondarySkill,
  scoreGrowthArea,
  scoreCurriculumHook,
  scoreGradeCenter,
  scoreTierLean,
  scoreTrip,
  compareScored,
  // C7
  computeCurriculumFit,
  gradeMatchesBand,
};
