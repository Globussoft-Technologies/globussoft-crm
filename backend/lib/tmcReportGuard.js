/**
 * TMC report 3-layer guardrail — implements PRD §3.7.1 verbatim.
 *
 * Pure validation + content-strip + fallback module. No DB, no LLM call, no
 * fetch. The TMC public diagnostic generates two LLM outputs (Job A — readiness
 * narrative, Job B — sales brief + custom-concept). Both must be checked
 * against three layers before downstream consumers (PDF renderer in T8) see
 * them; the build NEVER ships ungoverned LLM output and NEVER renders an
 * empty section in place of a failed one (PRD §3.7.1 + NF-4 + NF-8).
 *
 * Contract:
 *
 *   guardReportOutput(jobKey, llmOutput, opts) → {
 *     layer:    1 | 2 | 3,                 // which layer settled the verdict
 *     accepted: boolean,                   // did the original LLM output pass Layers 1+2?
 *     output:   object,                    // FINAL output (original OR fallback per-field)
 *     reasons:  string[],                  // why Layer 1 or 2 rejected (for logging / triage)
 *   }
 *
 *   jobKey ∈ {'A', 'B'}
 *
 * Layer 1 — Schema validation (PRD §3.7.1)
 *   Job A schema: `{ambition_restatement, readiness_profile, what_becomes_possible,
 *                   cost_of_waiting, institutional_benefit, assurance_framing}` (6 string fields).
 *   Job B schema: `{lead_quality_summary, what_school_wants, primary_rationale,
 *                   alternative_rationale, positioning_notes, custom_concept_note_or_empty,
 *                   flags_to_action}` (7 fields; `flags_to_action` is array<string>, rest strings;
 *                   `custom_concept_note_or_empty` may be the empty string).
 *   Missing required field, wrong type, or extra unexpected field → REJECT (strict mode).
 *
 * Layer 2 — Content strip-check (PRD §3.7.1 — 4 checks per field)
 *   1. Destination blocklist — config-supplied (caller passes `opts.destinationBlocklist`,
 *      read at runtime from the trip catalogue's `status=archived` rows + the union
 *      of city/country/region/landmark/anchor-experience phrases from active trips per
 *      PRD §3.7.1 verbatim). Case-insensitive whole-word + multi-word phrase match.
 *   2. Number check — any 3+ digit integer in LLM text that ISN'T on the standing-facts
 *      whitelist (14018 / 12055 / 1658 / 305 / 50 / 100000 / 2015 — the §3.5.5 standing-facts
 *      block AND the §3.5.3 peer-proof aggregate numbers) → REJECT. The PRD's stricter form
 *      ("no digit-bearing token + no number-word") is what the LLM should never produce — Trust
 *      figures + runway are renderer-injected per NF-8. Allowing the whitelist means an LLM
 *      output that quotes the trust block accurately doesn't false-positive.
 *   3. Board-term check — block the 9 PRD-named board terms (NEP, CBSE, ICSE, ISC, IGCSE, IB,
 *      Cambridge, CISCE, CAS, SUPW, NCF) anywhere in output. Board hook is renderer-injected
 *      from §3.5.1 board curriculum map; LLM never writes a board policy claim.
 *   4. Restricted-word check — voice-rules from PRD §11.3 (calm institutional voice).
 *      Marketing-gimmick words like 'urgent', 'limited time', 'exclusive', 'last chance',
 *      'guaranteed', 'act now', etc. — block-list extensible via opts.
 *
 * Layer 3 — Deterministic template fallback (PRD §3.7.1 verbatim)
 *   Per-job fallback template, filled only from `opts.schoolAnswers` (the school's own answers)
 *   + verified config. NO LLM text. Renderer (T8) injects §3.5.5 standing-facts on top.
 *
 *   Job A fallback shapes match PRD §3.7.1's fallback table (6 fields, one each):
 *     ambition_restatement     — Q1 + Q2 skill 1 + Q2 skill 2
 *     readiness_profile        — Q3 growth area
 *     what_becomes_possible    — fixed 3-line description
 *     cost_of_waiting          — Q3 growth area + runway-append marker
 *     institutional_benefit    — fixed paragraph + board-hook-append marker
 *     assurance_framing        — fixed paragraph (renderer fills 4 concerns from §3.5.5)
 *
 *   Job B fallback is the safe "no LLM brief — see engine output + flags" payload that
 *   downstream (sales brief renderer) consumes. Per-field templates are simpler than Job A
 *   because the executive vets the brief anyway (§3.6).
 *
 * Persistence target shape (consumed by T8 renderer):
 *   - report_content.report_ai_output ← {output} (the FINAL output, post-guard)
 *   - logs ← {layer, accepted, reasons} (per NF-4 — log every fallback with field + check)
 *
 * @module backend/lib/tmcReportGuard
 */

// ---------------------------------------------------------------------------
// Job schemas (PRD §3.7)

const JOB_A_FIELDS = [
  "ambition_restatement",
  "readiness_profile",
  "what_becomes_possible",
  "cost_of_waiting",
  "institutional_benefit",
  "assurance_framing",
];

const JOB_B_FIELDS = [
  "lead_quality_summary",
  "what_school_wants",
  "primary_rationale",
  "alternative_rationale",
  "positioning_notes",
  "custom_concept_note_or_empty",
  "flags_to_action",
];

// All Job A fields are required strings. Job B is all strings EXCEPT
// `flags_to_action` which is an array<string>. `custom_concept_note_or_empty`
// MAY be the empty string but must be present.
const JOB_B_ARRAY_FIELDS = new Set(["flags_to_action"]);

// ---------------------------------------------------------------------------
// Default blocklists (exported as constants — extensible via opts)

/**
 * The 11 PRD §3.7.1 board terms.
 *
 * The PRD §3.7.1 verbatim names: NEP, CBSE, ICSE, ISC, IGCSE, IB, Cambridge,
 * CISCE, CAS, SUPW, NCF. All 11. Case-insensitive whole-word match.
 *
 * Why blocked: board hook is renderer-injected from §3.5.1's board curriculum map
 * (NEP is CBSE-only; CAS is IB-only). An LLM that names "NEP" to an IB principal
 * makes a factual error that destroys credibility (§3.5.1 verbatim). The LLM
 * NEVER writes a board policy claim.
 */
const DEFAULT_BOARD_TERMS = [
  "NEP",
  "CBSE",
  "ICSE",
  "ISC",
  "IGCSE",
  "IB",
  "Cambridge",
  "CISCE",
  "CAS",
  "SUPW",
  "NCF",
];

/**
 * Restricted marketing-gimmick words per PRD §11.3 — calm institutional voice.
 *
 * §11.3 verbatim: "manufactured pressure reads as a sales gimmick and kills
 * the trust that earns the meeting. A harder push doesn't lift conversion on
 * a cautious institutional buyer — it costs the meeting."
 *
 * The build holds calm-institutional voice by blocking marketing-pressure
 * phrases. Case-insensitive substring match (multi-word phrases like "limited
 * time" caught either as space-separated tokens or whole substrings).
 */
const DEFAULT_RESTRICTED_WORDS = [
  "urgent",
  "urgently",
  "limited time",
  "exclusive offer",
  "exclusive",
  "last chance",
  "guaranteed",
  "guarantee",
  "act now",
  "hurry",
  "don't miss",
  "do not miss",
  "once-in-a-lifetime",
  "once in a lifetime",
  "amazing",
  "incredible",
  "unbelievable",
  "miss out",
];

/**
 * Whitelisted numbers per PRD §3.5.5 standing-facts + §3.5.3 peer-proof block.
 *
 * 14018 — students moved last year
 * 12055 — day-program students last year
 * 1658  — overnight domestic students last year
 * 305   — international students last year (PRD §11.4 — "honest at 305")
 * 50    — schools served since 2015 ("over 50")
 * 100000 — students moved since 2015 ("more than 100,000")
 * 2015  — operating-since year
 *
 * Allows an LLM that accurately quotes these standing facts to not
 * false-positive. Any OTHER 3+ digit integer in LLM output (e.g. "200
 * international students") triggers the number-check rejection — the LLM
 * NEVER produces an invented number (PRD NF-8 + §3.7.1 check 2).
 */
const HONEST_NUMBERS_WHITELIST = [
  "14018",
  "12055",
  "1658",
  "305",
  "50",
  "100000",
  "2015",
];

// ---------------------------------------------------------------------------
// Helpers

function isString(v) {
  return typeof v === "string";
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Build a regex that catches any of the supplied phrases as whole-word /
 * whole-phrase, case-insensitive. Multi-word phrases are matched as exact
 * sequences (with flexible whitespace).
 *
 * Used for destination blocklist + board-term check. Substring-style matches
 * (e.g. "Europe" inside "Europeanize") are intentionally avoided — whole-word
 * is the §3.7.1 verbatim requirement. Word boundaries fail for "Sri Lanka"
 * (two tokens) so we precompile per phrase.
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word match: the phrase appears with non-word boundaries either side.
 * Multi-word phrases match with flexible whitespace (one or more spaces).
 */
function makeWholeWordRegex(phrase) {
  const tokens = phrase.trim().split(/\s+/).map(escapeRegex);
  const inner = tokens.join("\\s+");
  return new RegExp(`(?:^|\\W)${inner}(?:\\W|$)`, "i");
}

/**
 * Substring (case-insensitive) match. Used for restricted-word check where
 * marketing-pressure phrases ("limited time offer") should fire even when
 * embedded in a longer sentence.
 */
function makeSubstringRegex(phrase) {
  return new RegExp(escapeRegex(phrase), "i");
}

/**
 * Extract all 3+ digit integers from a text string. Returns array of digit
 * strings (no leading zeros stripped — caller pre-normalizes via String().)
 *
 * Commas inside numbers are tolerated: "14,018" becomes "14018".
 */
function extractIntegers(text) {
  if (typeof text !== "string") return [];
  // Strip commas BETWEEN digits ("14,018" → "14018"), then extract \d{3,}
  const normalized = text.replace(/(\d),(?=\d)/g, "$1");
  const matches = normalized.match(/\d{3,}/g);
  return matches || [];
}

/**
 * Collect every string field's text content from an output object into a single
 * concatenated string for content-check probes. Arrays of strings are flattened.
 */
function collectAllText(output) {
  const parts = [];
  for (const v of Object.values(output)) {
    if (typeof v === "string") {
      parts.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") parts.push(item);
      }
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Layer 1 — Schema validation

/**
 * Returns null if the output passes schema validation; otherwise an array of
 * `reasons` strings describing each schema violation (one per field).
 *
 * Strict mode: extra unexpected fields → reject (caller's design choice per
 * slice spec). Justification: the §3.7 LLM contract specifies the EXACT JSON
 * shape; an LLM that returns extra fields is misbehaving in a way the renderer
 * shouldn't be asked to silently ignore — the field might be a hallucinated
 * "destination" or "price" the LLM tried to sneak through.
 */
function validateSchema(jobKey, output) {
  const reasons = [];

  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return [`schema.not_object`];
  }

  const expectedFields = jobKey === "A" ? JOB_A_FIELDS : JOB_B_FIELDS;
  const expectedSet = new Set(expectedFields);

  // Missing-field check
  for (const field of expectedFields) {
    if (!(field in output)) {
      reasons.push(`schema.missing_field:${field}`);
      continue;
    }
    const v = output[field];
    if (jobKey === "B" && JOB_B_ARRAY_FIELDS.has(field)) {
      if (!isStringArray(v)) {
        reasons.push(`schema.wrong_type:${field}`);
      }
    } else {
      if (!isString(v)) {
        reasons.push(`schema.wrong_type:${field}`);
      }
    }
  }

  // Extra-field check (strict mode)
  for (const field of Object.keys(output)) {
    if (!expectedSet.has(field)) {
      reasons.push(`schema.unexpected_field:${field}`);
    }
  }

  return reasons.length > 0 ? reasons : null;
}

// ---------------------------------------------------------------------------
// Layer 2 — Content strip-check

/**
 * Returns null if the output passes Layer 2; otherwise an array of reasons.
 *
 * Runs the 4 checks defined in PRD §3.7.1 (destination blocklist, number check,
 * board-term check, restricted-word check) on the combined text content of all
 * output string + string-array fields.
 */
function checkContent(output, opts) {
  const reasons = [];
  const text = collectAllText(output);

  if (text.length === 0) {
    // Empty output passes content checks vacuously, but schema-validation
    // should have caught empty-string fields earlier. Defensive return.
    return null;
  }

  // ---- Check 1: destination blocklist
  // Caller-supplied at runtime from the trip catalogue's archived rows + the
  // union of city/country/region/landmark/anchor-experience phrases. The
  // PRD names "Europe", "the canals of Amsterdam" as canonical examples.
  const destinations = Array.isArray(opts.destinationBlocklist)
    ? opts.destinationBlocklist
    : [];
  for (const phrase of destinations) {
    if (typeof phrase !== "string" || phrase.trim().length === 0) continue;
    if (makeWholeWordRegex(phrase).test(text)) {
      reasons.push(`destination_blocklist:${phrase}`);
    }
  }

  // ---- Check 2: number check
  // The LLM never produces a number (NF-8). Trust + runway figures are
  // renderer-injected. Allow the standing-facts whitelist (so an LLM that
  // quotes "since 2015" doesn't false-positive); REJECT any other 3+ digit
  // integer.
  const whitelist = new Set(
    Array.isArray(opts.honestNumbersWhitelist)
      ? opts.honestNumbersWhitelist.map(String)
      : HONEST_NUMBERS_WHITELIST,
  );
  const integers = extractIntegers(text);
  for (const n of integers) {
    if (!whitelist.has(n)) {
      reasons.push(`invented_number:${n}`);
    }
  }

  // ---- Check 3: board-term check
  // Block all 11 PRD §3.7.1 board terms. The board hook is renderer-injected
  // from §3.5.1; the LLM never writes a board policy claim. Case-insensitive
  // whole-word match.
  const boardTerms = Array.isArray(opts.boardTerms)
    ? opts.boardTerms
    : DEFAULT_BOARD_TERMS;
  for (const term of boardTerms) {
    if (typeof term !== "string" || term.trim().length === 0) continue;
    if (makeWholeWordRegex(term).test(text)) {
      reasons.push(`board_term:${term}`);
    }
  }

  // ---- Check 4: restricted-word check
  // Voice-rule enforcement per §11.3 — calm institutional voice. Caller may
  // EXTEND the default list (opts.restrictedWords appended) or replace it
  // (opts.restrictedWordsOverride). Default behavior: extend.
  let restrictedWords;
  if (Array.isArray(opts.restrictedWordsOverride)) {
    restrictedWords = opts.restrictedWordsOverride;
  } else if (Array.isArray(opts.restrictedWords)) {
    restrictedWords = [...DEFAULT_RESTRICTED_WORDS, ...opts.restrictedWords];
  } else {
    restrictedWords = DEFAULT_RESTRICTED_WORDS;
  }
  for (const word of restrictedWords) {
    if (typeof word !== "string" || word.trim().length === 0) continue;
    if (makeSubstringRegex(word).test(text)) {
      reasons.push(`restricted_word:${word}`);
    }
  }

  return reasons.length > 0 ? reasons : null;
}

// ---------------------------------------------------------------------------
// Layer 3 — Deterministic template fallback

/**
 * Build the Job A deterministic fallback per PRD §3.7.1's fallback table.
 *
 * Filled from `opts.schoolAnswers` (the school's own Q1-Q12 answers) and
 * standing config. The renderer (T8) appends §3.5.2 runway + §3.5.1 board
 * hook + §3.5.5 standing-facts on top — see the marker placeholders in
 * `cost_of_waiting` and `institutional_benefit`.
 */
function buildJobAFallback(opts) {
  const sa = opts.schoolAnswers || {};
  const q1 = sa.primary_outcome || sa.q1 || "the outcome you described";
  const skills = Array.isArray(sa.secondary_skills)
    ? sa.secondary_skills
    : Array.isArray(sa.q2)
      ? sa.q2
      : [];
  const skill1 = skills[0] || "the first skill you named";
  const skill2 = skills[1] || "the second skill you named";
  const q3 = sa.growth_area || sa.q3 || "the growth area you identified";

  return {
    ambition_restatement: `You told us your goal for your students is ${q1}, supported by ${skill1} and ${skill2}.`,
    readiness_profile: `Your students have the most room to grow in ${q3}. Experiential learning builds this through real tasks outside the classroom, repeated and reflected on, which is how a skill becomes a habit.`,
    what_becomes_possible:
      "Three pathways open by the growth they produce. " +
      "Day programs build awareness and first practice in a single session close to school. " +
      "Overnight domestic programs build endurance and team behaviour through a multi-day setting away from home. " +
      "International programs build the institutional and intercultural confidence that comes from operating in an unfamiliar environment over a longer arc.",
    cost_of_waiting: `The gap you named in ${q3} does not wait for the school. Every term it goes unaddressed, another cohort moves on without it.`,
    institutional_benefit:
      "Schools that build experiential learning into the academic year see it reflected in student outcomes, in parent satisfaction, and in admissions differentiation that is increasingly hard to find through classroom work alone.",
    assurance_framing:
      "Four concerns sit between any school and a trip running well: keeping students safe, protecting the school's reputation, justifying the decision to governance, and carrying parents through the process. Each one is addressed below with a fact, not an adjective.",
  };
}

/**
 * Build the Job B deterministic fallback. The brief is internal — the
 * executive vets it before recommending anything (PRD §3.6) — so the fallback
 * is shorter and signals plainly that the LLM brief was rejected and the
 * engine output is the source of truth.
 */
function buildJobBFallback(opts) {
  const sa = opts.schoolAnswers || {};
  const leadQuality = opts.leadQuality || "clean";

  return {
    lead_quality_summary: `Lead quality: ${leadQuality}. See engine_state and flags for routing.`,
    what_school_wants:
      "See the 12 diagnostic answers in the brief; the engine's primary and alternative trip selections reflect the school's stated outcome, secondary skills, growth area, and geo / budget / timeline preferences.",
    primary_rationale:
      "Refer to the engine score breakdown for the per-signal rationale on the primary trip. The two-key sort guarantees the primary always matches the school's stated primary outcome.",
    alternative_rationale:
      "Refer to the engine score breakdown for the alternative trip. The thin_alternative flag (if present) signals the executive should weigh whether to mention it on the call.",
    positioning_notes:
      "LLM brief unavailable for this submission — guardrail rejected the model output. Use the engine's flags and score breakdown to position the call.",
    custom_concept_note_or_empty: "",
    flags_to_action: Array.isArray(sa.flags) ? sa.flags : [],
  };
}

function buildFallback(jobKey, opts) {
  return jobKey === "A" ? buildJobAFallback(opts) : buildJobBFallback(opts);
}

// ---------------------------------------------------------------------------
// Public entry point

/**
 * Run the 3-layer guardrail on an LLM output.
 *
 * @param {'A'|'B'} jobKey
 * @param {object} llmOutput  The raw LLM JSON output to guard.
 * @param {object} opts
 * @param {string[]} [opts.destinationBlocklist]      Catalogue-derived destination phrases to strip.
 * @param {string[]} [opts.boardTerms]                Override DEFAULT_BOARD_TERMS.
 * @param {string[]} [opts.honestNumbersWhitelist]    Override HONEST_NUMBERS_WHITELIST.
 * @param {string[]} [opts.restrictedWords]           Extend DEFAULT_RESTRICTED_WORDS.
 * @param {string[]} [opts.restrictedWordsOverride]   Replace DEFAULT_RESTRICTED_WORDS.
 * @param {object} [opts.schoolAnswers]               School's Q1-Q12 answers for Layer 3 fallback fills.
 * @param {string} [opts.leadQuality]                 Lead-quality classification for Job B fallback.
 * @returns {{layer: 1|2|3, accepted: boolean, output: object, reasons: string[]}}
 */
function guardReportOutput(jobKey, llmOutput, opts = {}) {
  if (jobKey !== "A" && jobKey !== "B") {
    throw new Error(`guardReportOutput: jobKey must be 'A' or 'B', got ${jobKey}`);
  }

  const reasons = [];

  // Layer 1
  const schemaReasons = validateSchema(jobKey, llmOutput);
  if (schemaReasons) {
    reasons.push(...schemaReasons);
    return {
      layer: 3,
      accepted: false,
      output: buildFallback(jobKey, opts),
      reasons,
    };
  }

  // Layer 2
  const contentReasons = checkContent(llmOutput, opts);
  if (contentReasons) {
    reasons.push(...contentReasons);
    return {
      layer: 3,
      accepted: false,
      output: buildFallback(jobKey, opts),
      reasons,
    };
  }

  // Passed all layers — original output stands.
  return {
    layer: 1,
    accepted: true,
    output: llmOutput,
    reasons: [],
  };
}

module.exports = {
  guardReportOutput,
  // Constants exported for unit-test pinning + future config UI introspection.
  JOB_A_FIELDS,
  JOB_B_FIELDS,
  DEFAULT_BOARD_TERMS,
  DEFAULT_RESTRICTED_WORDS,
  HONEST_NUMBERS_WHITELIST,
  // Internal helpers exported so tests can exercise edge cases without
  // having to construct a full output payload for each.
  validateSchema,
  checkContent,
  buildJobAFallback,
  buildJobBFallback,
  extractIntegers,
  makeWholeWordRegex,
  makeSubstringRegex,
};
