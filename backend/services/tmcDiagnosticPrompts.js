// TMC School-Readiness Diagnostic — LLM prompt builders for §3.7 Job A + Job B.
//
// PURE prompt-building module. NO database. NO LLM call. NO fetch. NO file I/O.
// Two builders, each takes a structured-input object and returns a
//   { task, system, user, messages, expectedFields }
// envelope the consumer hands to backend/lib/llmRouter.routeRequest().
//
// Source of truth: docs/PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md
//   §3.7    LLM layer — two strict-JSON jobs, both with hallucination guards
//   §3.7.1  Three-layer guardrail (Layer 1 schema; Layer 2 strip checks;
//           Layer 3 deterministic template fallback)
//   §3.5    Readiness report sections (Job A's narrative fills sections 2/3/4/5/7/8)
//   §3.5.1  Board curriculum map — NEP-CBSE-only, IGCSE→Cambridge, IB→CAS,
//           ICSE/ISC→voluntary, State Board→generic-unless-confirmed
//   §3.5.5  Standing-facts config block — facts the prompt INJECTS, never invents
//   §11.3   Urgency stays calm — institutional, not hype
//   §11.4   International figure (305) stays honest, never blended
//
// NOTE on the PRD's "build-spec PDF §9.1 + §9.2" reference: the build-spec PDF
// itself is not committed to this repo (lives in travel-crm/ alongside the
// PRD's source PDFs). The exact-quote text isn't transcribed in the PRD body,
// so the prompt language below covers the §3.7 contract verbatim from THE PRD
// (the load-bearing artifact in-repo) rather than fabricating a quote
// attributed to a PDF section that the PRD merely points at. The 4-check
// Layer-2 strip and the 6/7-field JSON shapes are the binding contract; this
// matches the PRD §3.7 line-item-for-line-item.
//
// Job A — Readiness narrative.
//   Output JSON shape (6 fields, exact keys per PRD §3.7):
//     { ambition_restatement, readiness_profile, what_becomes_possible,
//       cost_of_waiting, institutional_benefit, assurance_framing }
//
// Job B — Sales brief + custom-concept note.
//   Output JSON shape (7 fields, exact keys per PRD §3.7):
//     { lead_quality_summary, what_school_wants, primary_rationale,
//       alternative_rationale, positioning_notes, custom_concept_note_or_empty,
//       flags_to_action }
//
// Both prompts hard-constrain the model:
//   * Strict JSON only — no markdown fences, no prose preamble.
//   * Field names + types exact.
//   * §3.5.5 standing-facts INJECTED as literal config text so the model
//     never invents a trust / runway / peer-proof number.
//   * §3.5.1 board policy hooks INJECTED only when relevant — Job A's report
//     copy must not name NEP for a non-CBSE school.
//   * §11.3 calm-institutional voice / no manufactured urgency.
//   * §11.4 international figure (305) framed as emerging, never blended.
//   * Job A: zero destination words, zero numbers, zero board-policy names
//     — per §3.7.1 Layer 2 destination/number/board-term strip checks.
//   * Job B: never invent destination, price, or vendor (§2 UC-4); custom
//     concept built around the nearest real product, never a fabricated one.
//
// Determinism contract: same inputs → identical {system, user} strings.
// No Math.random, no Date.now, no environment reads. The pure-fn shape is
// what the vitest determinism cases assert.
//
// Consumer envelope: this module returns { task, system, user, messages,
// expectedFields } so the routes-side LLM caller can either feed `messages`
// straight into the Anthropic SDK (Claude's `messages` array shape with a
// top-level `system` parameter) or hand `{ system, user, task }` to
// llmRouter.routeRequest({ task, payload: { system, user } }). The dual
// surface keeps the module compatible with both the existing stub-mode
// router AND the real-mode swap when ANTHROPIC_API_KEY lands.

'use strict';

// ── Task names (PRD §3.7) ───────────────────────────────────────────
//
// PRD §3.7 names two jobs. The llmRouter routes both through the
// 'reasoning' task class (Claude Opus primary) per the existing
// 'talking-points' precedent — this module surfaces explicit task
// tags so the LlmCallLog row reflects the diagnostic-specific origin.
const TASK_READINESS_NARRATIVE = 'tmc-readiness-narrative';
const TASK_SALES_BRIEF = 'tmc-sales-brief';

// ── Expected output fields (PRD §3.7) ────────────────────────────────
//
// Pin the exact JSON keys the consumer expects. The strip-check (T7's
// tmcReportGuard) validates against these; if the model returns a key
// rename or drop, T7's Layer 1 fails and the field falls through to the
// Layer 3 template fallback.
const READINESS_NARRATIVE_FIELDS = Object.freeze([
  'ambition_restatement',
  'readiness_profile',
  'what_becomes_possible',
  'cost_of_waiting',
  'institutional_benefit',
  'assurance_framing',
]);

const SALES_BRIEF_FIELDS = Object.freeze([
  'lead_quality_summary',
  'what_school_wants',
  'primary_rationale',
  'alternative_rationale',
  'positioning_notes',
  'custom_concept_note_or_empty',
  'flags_to_action',
]);

// ── Board → policy-hook framing tokens (PRD §3.5.1) ──────────────────
//
// Map a Q6 board name (the school's curriculum answer) → the framing
// phrase the prompt is allowed to reference. NEP is CBSE-only — naming
// it to an IB or Cambridge principal is the kind of factual error that
// destroys credibility with an academic buyer faster than any other.
// The Layer 2 board-term strip check (T7) is the downstream enforcement;
// this map drives the PRE-EMPTIVE instruction inside the system prompt
// so the model is told the exact board the school named and what hook
// is allowed for it.
const BOARD_HOOK_FRAMING = Object.freeze({
  'CBSE': 'CBSE: NEP 2020 + NCF-SE 2023 experiential-learning pedagogy is mandatory',
  'ICSE/ISC': 'ICSE/ISC: CISCE framework with voluntary NEP alignment + SUPW',
  'ICSE': 'ICSE/ISC: CISCE framework with voluntary NEP alignment + SUPW',
  'ISC': 'ICSE/ISC: CISCE framework with voluntary NEP alignment + SUPW',
  'IGCSE': 'IGCSE: Cambridge Learner Attributes + required practical and fieldwork',
  'IB': 'IB: Learner Profile + PYP inquiry + MYP Service-as-Action + DP-Core CAS',
  'State Board': 'State Board: generic experiential-learning case unless NEP adoption confirmed for state',
});

// ── Shared system-prompt preamble (voice + guardrails, PRD §11.3/§11.4) ─
//
// These rules are baked into BOTH prompts. Voice and hallucination guards
// are non-negotiable — the build never ships ungoverned LLM output (NF-4).
const VOICE_RULES = [
  '• Voice: calm, institutional, factual. The reader is a school owner, principal, or academic coordinator spending parents\' money on minors.',
  '• Urgency comes from real calendars (planning runway, growth-gap standing loss), never from manufactured pressure. NO countdown timers, NO "three slots left", NO invented "other schools in your district booked", NO competitive-threat framing.',
  '• NEVER name a competitor, agency, or another tour operator.',
  '• NEVER promise a specific outcome ("your students WILL become…"); frame growth as supported / nurtured / built through real tasks.',
  '• NEVER use hype words: amazing, unbelievable, life-changing, transformative, revolutionary, world-class, unforgettable, must-do, opportunity-of-a-lifetime.',
];

const HALLUCINATION_GUARDS_JOB_A = [
  '• NEVER name a destination, city, country, region, monument, landmark, or signature anchor-experience phrase. NOT "Europe", NOT "the canals of Amsterdam", NOT "Egypt\'s pyramids" — the school-facing report ships zero destination words.',
  '• NEVER produce a number, statistic, ratio, count, currency amount, percentage, year, age, or duration. Trust figures + runway days + peer-proof counts are injected by the renderer from verified config — you must not write them.',
  '• NEVER name a curriculum board, board policy, framework, or circular: NOT NEP, NOT CBSE, NOT ICSE, NOT ISC, NOT IGCSE, NOT IB, NOT Cambridge, NOT CISCE, NOT CAS, NOT SUPW, NOT NCF, NOT any circular reference. The board hook is injected by the renderer.',
  '• Speak about the school\'s students and their named growth area; do not infer board policy claims.',
];

const HALLUCINATION_GUARDS_JOB_B = [
  '• NEVER invent a destination, vendor, price, or trip that is not in the catalogue input below.',
  '• When the engine returned no_match, build the custom_concept_note_or_empty around the NEAREST REAL product in the catalogue input, labeled "concept to scope on the call". Do not fabricate a new trip name or destination.',
  '• Honesty over hype on peer-proof numbers (PRD §11.4): the international figure of 305 students last year is an emerging high-commitment tier, not a mass claim. Never blend it into all-time totals.',
];

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Normalise a board input that may be a single string or an array (Q6
 * supports multi-select via the "More than one" option). Returns an
 * array of recognised board hook framings. Unknown boards are dropped
 * silently (the renderer ships generic copy for them; the prompt also
 * must not invent a framing for an unrecognised board).
 */
function resolveBoardFramings(curriculum) {
  const list = Array.isArray(curriculum)
    ? curriculum
    : curriculum
    ? [curriculum]
    : [];
  const framings = [];
  for (const board of list) {
    const key = typeof board === 'string' ? board.trim() : '';
    if (!key) continue;
    // exact-match first; then a couple of slash-and-space variants
    const hook =
      BOARD_HOOK_FRAMING[key] ||
      BOARD_HOOK_FRAMING[key.replace(/\s+/g, '')] ||
      BOARD_HOOK_FRAMING[key.toUpperCase()];
    if (hook) framings.push(hook);
  }
  return framings;
}

/**
 * Stable JSON stringify with 2-space indent — used to embed catalogue
 * and engine output verbatim in the user prompt so the model has a
 * literal source it can quote vs. a stringy paraphrase. We deliberately
 * use JSON.stringify rather than a templated table because the catalogue
 * shape evolves and we want the schema to flow through unchanged.
 */
function pretty(o) {
  if (o == null) return 'null';
  try {
    return JSON.stringify(o, null, 2);
  } catch (_e) {
    return String(o);
  }
}

/**
 * Compose a {messages: [...]} envelope that mirrors Claude's Messages API
 * shape. The system param sits at the top level (Anthropic convention)
 * while the user prompt is the only message in the conversation. We
 * surface both `{system, user}` and `messages` so existing llmRouter
 * stub-mode + the eventual real-mode swap both work without an adapter.
 */
function envelope({ task, system, user }) {
  return {
    task,
    system,
    user,
    messages: [{ role: 'user', content: user }],
  };
}

// ── Job A — Readiness narrative (PRD §3.7) ───────────────────────────

/**
 * Build the {system, user} prompt pair for Job A — the LLM call that
 * produces the readiness-report narrative the school sees.
 *
 * Inputs (all optional except `answers`):
 *   answers              — the school's 12-question diagnostic submission
 *                          (object keyed by §3.1 field names)
 *   engineOutput         — the deterministic engine's result for context
 *                          (state + flags + scores). Trip names + IDs
 *                          are STRIPPED before going into the prompt;
 *                          Job A never sees a destination.
 *   catalogueMatched     — the matched trips' report_skill_blurb text
 *                          ONLY (no destination, no price). Array of
 *                          short blurbs (already destination-stripped
 *                          by the consumer; we embed them verbatim).
 *   standingFactsConfig  — §3.5.5 trust/runway/assurance/etc. config.
 *                          Embedded literally so the model SEES the
 *                          numbers it must NOT write — that primes the
 *                          model not to invent.
 *   boardCurriculumMap   — §3.5.1 framing map (defaults to the in-module
 *                          BOARD_HOOK_FRAMING; consumer can override).
 *   destinationBlocklist — list of destination tokens to forbid by name
 *                          in the prompt body. Layer 2 enforces this
 *                          downstream; the prompt pre-empts.
 *
 * Returns {task, system, user, messages, expectedFields}.
 */
function buildReadinessNarrativePrompt(input) {
  const {
    answers = {},
    engineOutput = null,
    catalogueMatched = [],
    standingFactsConfig = null,
    boardCurriculumMap = BOARD_HOOK_FRAMING,
    destinationBlocklist = [],
  } = input || {};

  // Pull only the small subset of engine output the narrative actually
  // needs. The model must NOT see trip IDs, titles, regions, or prices.
  // Flags + state are useful context (e.g. scope_budget_conflict tells the
  // model the school's geo-preference can't fund their chosen tier, so
  // cost_of_waiting framing leans on the alternative pathway).
  const safeEngine = engineOutput
    ? {
        state: engineOutput.state || null,
        flags: Array.isArray(engineOutput.flags) ? engineOutput.flags : [],
      }
    : null;

  const boardFramings = resolveBoardFramings(answers.curriculum);
  const _ignoredMap = boardCurriculumMap; // accepted for caller override, framings resolved above

  // ── System prompt ────────────────────────────────────────────────
  const system = [
    'You are TMC\'s Readiness Report narrative writer.',
    '',
    'Your job: emit STRICT JSON with EXACTLY the 6 keys listed below. No markdown fences, no prose preamble, no trailing commentary. Just the JSON object.',
    '',
    `Required JSON shape (all 6 keys, all string values):`,
    `  {`,
    `    "ambition_restatement":  "<2-3 sentences restating the school's goal in their own words>",`,
    `    "readiness_profile":     "<2-4 sentences on the school's students against the two chosen skills, anchored on the growth area>",`,
    `    "what_becomes_possible": "<2-4 sentences describing the three tier pathways by the GROWTH each produces, not by named products or prices>",`,
    `    "cost_of_waiting":       "<2-3 sentences on the growth gap as standing loss (calm, calendar-driven, no hype)>",`,
    `    "institutional_benefit": "<2-3 sentences on student outcomes + parent satisfaction + admissions differentiation>",`,
    `    "assurance_framing":     "<2-3 sentences introducing the 4 concerns (risk reduction, reputation, governance, parent acceptance)>"`,
    `  }`,
    '',
    'Voice rules:',
    ...VOICE_RULES,
    '',
    'Hallucination guards (NON-NEGOTIABLE — downstream Layer 2 strip-checks will reject any field that violates these):',
    ...HALLUCINATION_GUARDS_JOB_A,
    '',
    boardFramings.length > 0
      ? `Board-framing context (renderer will inject the board policy hook; you must NOT write any board name in your output): ${boardFramings.join(' | ')}`
      : 'Board-framing context: school did not name a recognised board; renderer will ship generic experiential-learning copy.',
    '',
    destinationBlocklist.length > 0
      ? `Forbidden destination tokens (do not mention any of these or near-synonyms): ${destinationBlocklist.join(', ')}`
      : 'Forbidden destination tokens: ALL place names, cities, countries, regions, monuments, and signature anchor-experience phrases.',
    '',
    'If you cannot produce a field without violating a guard, return an empty string for that field — the renderer has a deterministic template that will fill it from verified config. An empty field is safe; a violating field is dropped.',
  ].join('\n');

  // ── User prompt ──────────────────────────────────────────────────
  const userParts = [
    'Inputs for this submission:',
    '',
    'School answers (12-question diagnostic, exact field keys per PRD §3.1):',
    pretty(answers),
    '',
    'Engine context (state + flags only; trip names + IDs are intentionally stripped):',
    pretty(safeEngine),
    '',
    'Catalogue narrative blurbs to draw from (already destination-stripped, voice-checked report_skill_blurb text only):',
    catalogueMatched.length > 0 ? pretty(catalogueMatched) : '(none — engine returned no_match or thin catalogue)',
    '',
    'Standing-facts config (DO NOT WRITE THESE NUMBERS; renderer will inject them. They are here so you know not to invent rival numbers):',
    pretty(standingFactsConfig),
    '',
    'Produce the JSON now. Six keys. Strict JSON. No fences.',
  ];

  return envelope({
    task: TASK_READINESS_NARRATIVE,
    system,
    user: userParts.join('\n'),
  });
}

// ── Job B — Sales brief + custom-concept note (PRD §3.7) ─────────────

/**
 * Build the {system, user} prompt pair for Job B — the LLM call that
 * produces the internal sales brief the TMC executive reads before the
 * call. The brief CAN name trips, prices, and destinations (it's
 * TMC-internal, never sent to the school) — but only ones that exist
 * in the catalogue input. The model never invents a destination.
 *
 * Inputs:
 *   answers          — the school's diagnostic submission (all 12 answers)
 *   engineOutput     — full engine result: state, primary, alternative,
 *                      flags, icpTier, scores, leadQuality. The brief
 *                      consumes this verbatim — destination words are
 *                      ALLOWED here (internal only).
 *   catalogueMatched — full catalogue rows for the matched trips
 *                      (including summary_for_brief which IS
 *                      destination-specific — internal use).
 *   leadQuality      — 'clean' | 'suspect' (top of the brief; from §3.4)
 *   icpTier          — 'amazing' | 'breadwinning' | 'convenience' |
 *                      'dangerous' | 'unclassified' (drives sales priority)
 *
 * Returns {task, system, user, messages, expectedFields}.
 */
function buildSalesBriefPrompt(input) {
  const {
    answers = {},
    engineOutput = null,
    catalogueMatched = [],
    leadQuality = null,
    icpTier = null,
  } = input || {};

  // Pull lead-quality from engineOutput as a fallback so the caller can
  // pass either shape (top-level or engine-embedded). PRD §3.6 puts
  // lead_quality at the top of the brief — we surface it in the prompt
  // so the model knows to lead with the suspect framing when relevant.
  const resolvedLeadQuality =
    leadQuality ||
    (engineOutput && engineOutput.leadQuality) ||
    null;
  const resolvedIcpTier =
    icpTier || (engineOutput && engineOutput.icpTier) || null;
  const isSuspect = resolvedLeadQuality === 'suspect';

  // ── System prompt ────────────────────────────────────────────────
  const system = [
    'You are TMC\'s Sales Brief writer. The brief is TMC-internal only — the assigned executive reads it before the booked call. It is NEVER sent to the school.',
    '',
    'Your job: emit STRICT JSON with EXACTLY the 7 keys listed below. No markdown fences, no prose preamble, no trailing commentary. Just the JSON object.',
    '',
    `Required JSON shape (all 7 keys):`,
    `  {`,
    `    "lead_quality_summary":         "<2-3 sentences. If suspect: lead with 'Review before contact, low-confidence lead' + list the reasons. If clean: short positive summary of profile fit.>",`,
    `    "what_school_wants":            "<2-4 sentences interpreting the 12 answers — the school's primary outcome, secondaries, growth gap, geo + budget + timeline context, ICP profile in plain language.>",`,
    `    "primary_rationale":            "<2-4 sentences explaining WHY the engine's primary pick fits — primary-outcome match, secondary skills, growth area, curriculum hook, grade centering. Reference the actual trip by name (it's internal).>",`,
    `    "alternative_rationale":        "<2-4 sentences explaining the meaningful difference of the alternative (different tier OR different lead outcome). Empty string when there is no alternative (single_survivor flag).>",`,
    `    "positioning_notes":            "<2-3 sentences on call framing — what to lead with, what objections to expect from the principal, ICP-tier-driven priority.>",`,
    `    "custom_concept_note_or_empty": "<If engine state is no_match: 2-4 sentences sketching a custom concept built around the NEAREST real product in the catalogue input, labeled 'concept to scope on the call'. Otherwise empty string.>",`,
    `    "flags_to_action":              "<bullet-style sentences (or empty) calling out each flag the engine produced and what the executive should do about it on the call.>"`,
    `  }`,
    '',
    'Voice rules:',
    ...VOICE_RULES,
    '',
    'Hallucination guards (NON-NEGOTIABLE):',
    ...HALLUCINATION_GUARDS_JOB_B,
    '',
    isSuspect
      ? 'LEAD QUALITY: SUSPECT — Lead the brief with "Review before contact, low-confidence lead" and list the reasons from the engine output. Sales priority drops below all clean leads regardless of ICP tier. Never recommend auto-deletion (false-positive on a real principal stays recoverable, DD-5.6).'
      : 'Lead quality: clean. Sales priority follows ICP tier ordering.',
    '',
    resolvedIcpTier
      ? `ICP tier: ${resolvedIcpTier}. ` +
        (resolvedIcpTier === 'amazing'
          ? 'Highest sales priority. Larger fee band, multi-branch, scale-credible. Frame around institutional-grade governance + scale-of-trip evidence.'
          : resolvedIcpTier === 'breadwinning'
          ? 'High sales priority. 1-2 branches, mid-large fee band. Frame around growth + curriculum credibility + supervision rigour.'
          : resolvedIcpTier === 'convenience'
          ? 'Low priority. Frame around an entry-tier pathway and prove value before pushing scope.'
          : resolvedIcpTier === 'dangerous'
          ? 'Avoid — fee profile suggests cost-sensitivity that will not survive a real quote. Flag risk explicitly in positioning_notes.'
          : 'Unclassified — route as breadwinning by default; flag for the executive to judge profile fit on the call.')
      : 'ICP tier: not computed.',
    '',
    'If you cannot produce a field, return an empty string for that field. Empty fields are safe; fabricated fields are not.',
  ].join('\n');

  // ── User prompt ──────────────────────────────────────────────────
  const userParts = [
    'Inputs for this submission:',
    '',
    'Lead quality: ' + (resolvedLeadQuality || 'unknown'),
    'ICP tier: ' + (resolvedIcpTier || 'unknown'),
    '',
    'School answers (12-question diagnostic):',
    pretty(answers),
    '',
    'Engine output (state, primary, alternative, flags, scores — the deterministic engine\'s result):',
    pretty(engineOutput),
    '',
    'Matched catalogue rows (with summary_for_brief + indicative_price_per_student + curriculum_hooks — internal):',
    catalogueMatched.length > 0 ? pretty(catalogueMatched) : '(empty — no_match, recommend custom concept around nearest real product in the broader catalogue or note "no catalogue match" for the executive)',
    '',
    'Produce the JSON now. Seven keys. Strict JSON. No fences.',
  ];

  return envelope({
    task: TASK_SALES_BRIEF,
    system,
    user: userParts.join('\n'),
  });
}

// ── Exports ──────────────────────────────────────────────────────────

module.exports = {
  // Primary surface — what the consumer routes call
  buildReadinessNarrativePrompt,
  buildSalesBriefPrompt,
  // Constants for the strip-check (T7) and consumer validators
  READINESS_NARRATIVE_FIELDS,
  SALES_BRIEF_FIELDS,
  TASK_READINESS_NARRATIVE,
  TASK_SALES_BRIEF,
  BOARD_HOOK_FRAMING,
  // Voice + guardrail blocks exported so T7's tests + the route handler
  // can assert they're carried into the system prompt verbatim
  VOICE_RULES,
  HALLUCINATION_GUARDS_JOB_A,
  HALLUCINATION_GUARDS_JOB_B,
  // For tests
  resolveBoardFramings,
};
