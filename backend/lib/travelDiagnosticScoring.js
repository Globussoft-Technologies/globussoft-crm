// Travel CRM — diagnostic scoring engine.
//
// Per Q16 decision (view-only P1, edit-with-audit P1.5): the scoring
// rules are loaded from TravelDiagnosticQuestionBank.scoringRulesJson at
// submission time and ARE NOT mutated by this module. This helper is a
// pure function; same (rules, answers) → same output. No side effects,
// no DB calls. Routes call this to compute the score before persisting
// the TravelDiagnostic row.
//
// Why pure: makes the scoring auditable. The TravelDiagnostic row
// captures questionsJson + answersJson + scoringRulesJson at submission
// time, so the score can be recomputed deterministically months later
// for audit / dispute resolution.
//
// See docs/TRAVEL_CRM_PRD.md §4.2 for the diagnostic-engine contract.

/**
 * @typedef {Object} ScoringResult
 * @property {number} score                  Weighted-sum total
 * @property {string|null} classification    e.g. "level_1" .. "level_4"; null if no band matches
 * @property {string|null} classificationLabel  e.g. "Confident & Prepared"; null when classification is null
 * @property {string|null} recommendedTier   e.g. "entry" | "primary" | "premium"; null when classification is null
 * @property {string[]} warnings             Non-fatal issues (unanswered Qs, unknown options, ...) for advisor visibility
 */

/**
 * Compute the weighted score + classification for a diagnostic submission.
 *
 * @param {object} bank
 *   - `questionsJson` already parsed into `{ questions: [{id, options: [{value, weight}]}] }`
 *   - `scoringRulesJson` already parsed into `{ method, bands: [{minScore, maxScore, classification, label, recommendedTier}] }`
 * @param {Record<string, string|string[]>} answers — { qid: answerValue }
 * @returns {ScoringResult}
 */
function scoreDiagnostic(bank, answers) {
  if (!bank || typeof bank !== "object") {
    throw new TypeError("scoreDiagnostic: bank must be an object");
  }
  if (!answers || typeof answers !== "object") {
    throw new TypeError("scoreDiagnostic: answers must be an object");
  }
  const questions = (bank.questions || []).filter((q) => q && q.id);
  const bands = (bank.bands || []).filter((b) => b && typeof b.minScore === "number");
  const method = bank.method || "weighted-sum";

  if (method !== "weighted-sum") {
    // Only one scoring method supported in Phase 1. Future methods
    // (per-section weights, branching tree) land in P1.5+.
    throw new Error(`scoreDiagnostic: unsupported method "${method}" (only "weighted-sum")`);
  }

  const warnings = [];
  let score = 0;

  for (const q of questions) {
    const ans = answers[q.id];
    if (ans == null || (typeof ans === "string" && ans.trim() === "")) {
      warnings.push(`unanswered:${q.id}`);
      continue;
    }
    // Multi-select question — sum all selected weights
    if (Array.isArray(ans)) {
      for (const v of ans) {
        const opt = (q.options || []).find((o) => o.value === v);
        if (!opt) {
          warnings.push(`unknown-option:${q.id}:${v}`);
          continue;
        }
        score += Number(opt.weight) || 0;
      }
      continue;
    }
    // Single-choice — find the matched option's weight
    const opt = (q.options || []).find((o) => o.value === ans);
    if (!opt) {
      warnings.push(`unknown-option:${q.id}:${ans}`);
      continue;
    }
    score += Number(opt.weight) || 0;
  }

  // Round to 4 decimal places to match Decimal(10,4) column precision.
  score = Math.round(score * 10000) / 10000;

  // Find the first band whose [minScore, maxScore] contains the score.
  // Bands are checked in declared order, so authors can have overlapping
  // bands and the first-match wins (rules are advisor-curated, not
  // strict mathematical partitions).
  const band = bands.find((b) => {
    const min = Number(b.minScore);
    const max = typeof b.maxScore === "number" ? Number(b.maxScore) : Infinity;
    return score >= min && score <= max;
  });

  if (!band) {
    warnings.push(`no-band-matched:score=${score}`);
    return {
      score,
      classification: null,
      classificationLabel: null,
      recommendedTier: null,
      warnings,
    };
  }

  return {
    score,
    classification: band.classification || null,
    classificationLabel: band.label || null,
    recommendedTier: band.recommendedTier || null,
    warnings,
  };
}

/**
 * Parse questionsJson + scoringRulesJson from their stored String form
 * into a shape the scoring engine understands. Returns null + a single
 * `parse-error` warning on bad JSON rather than throwing — callers
 * decide whether to 400 the request or persist the diagnostic with
 * score=null + the warning attached.
 *
 * @param {string} questionsJson
 * @param {string} scoringRulesJson
 * @returns {{ bank: object|null, warnings: string[] }}
 */
function parseBank(questionsJson, scoringRulesJson) {
  const warnings = [];
  let qs = null;
  let rules = null;
  try {
    qs = JSON.parse(questionsJson);
  } catch (e) {
    warnings.push(`parse-error:questions:${e.message}`);
  }
  try {
    rules = JSON.parse(scoringRulesJson);
  } catch (e) {
    warnings.push(`parse-error:scoring-rules:${e.message}`);
  }
  if (!qs || !rules) {
    return { bank: null, warnings };
  }
  return {
    bank: {
      method: rules.method,
      questions: qs.questions || [],
      bands: rules.bands || [],
    },
    warnings,
  };
}

module.exports = { scoreDiagnostic, parseBank };
