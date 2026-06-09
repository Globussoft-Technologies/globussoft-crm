/**
 * Travel itinerary-suggest LLM client — STUB MODE.
 *
 * STUB: real Gemini 2.5 Flash call pending Q-IT-2 / Q11 keys (overlapping
 * cred chase — same `GEMINI_API_KEY` env var the lib/llmRouter.js `bulk-text`
 * task class wires to per PRD §9.1's locked routing table). When the key
 * lands, the `suggestItinerary` body checks `process.env.GEMINI_API_KEY`
 * and dispatches via `@google/generative-ai` (already in backend/package.json
 * at ^0.24.1). On any error / missing key the module falls through to the
 * deterministic stub — downstream consumers (S9 visual editor, S11 POI
 * import) get a stable shape contract today.
 *
 * Source of truth: docs/PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.6:
 *   - (a) Trigger: "Suggest itinerary" button on Itineraries.jsx +
 *         blank-state of visual editor.
 *   - (b) Prompt inputs: destination, durationDays, travellerProfile
 *         (free-text), budget tier, sub-brand context.
 *   - (c) Routed via lib/llmRouter.js new task class `itinerary-suggest`.
 *         Model: gemini-2.5-flash. Budget 2K in / 4K out.
 *   - (d) Returned shape: structured JSON with `daySplit` + `poiSuggestions`
 *         + `thematicNotes`. Items materialise into ItineraryItem rows
 *         only on operator-accept.
 *   - (e) AI Re-score-style UX — operator reviews + edits + accepts /
 *         rejects per-day. No auto-write.
 *
 * Canonical return envelope (STUB + REAL — same shape):
 *   {
 *     suggestionJson: {
 *       daySplit: [
 *         { dayNumber: 1, theme: "...", items: [
 *           { itemType: "activity"|"meal"|"transfer"|"accommodation",
 *             description: "...", estimatedCost: <number|null>,
 *             latitude: <number|null>, longitude: <number|null>,
 *             suggestedSupplierName: <string|null> }
 *         ] }, …
 *       ],
 *       poiSuggestions: [
 *         { name: "...", description: "...", latitude: <number|null>,
 *           longitude: <number|null>, themeTag: "..." }, …
 *       ],
 *       thematicNotes: "<2-4 sentences on overall trip framing>",
 *       summary: "<one-line overview>",
 *     },
 *     source: "stub" | "gemini",
 *     model: "gemini-2.5-flash",          // primary per PRD §9.1
 *     stub: <bool>,                        // mirrors lib/llmRouter envelope
 *   }
 *
 * The `suggestionJson` shape is what S9 (visual editor) + S11 (POI seed
 * import) consume — pinning it here lets those slices iterate without
 * waiting for real Gemini access.
 *
 * Budget cap: $100/month per tenant via the cross-cutting TenantSetting
 * pattern (LLM_MONTHLY_CAP_USD_CENTS = 10000 cents default per
 * backend/lib/tenantSettings.js DEFAULTS — shares the cap with the rest
 * of the LLM router because every gemini-flash / claude-opus call goes
 * through the same monthly budget envelope). Mirrors callifiedClient +
 * adsGptClient + ratehawkClient self-mocking seam (`module.exports.fn(...)`
 * indirection) so vitest can `vi.spyOn(client, 'computeMonthlySpendCents')`.
 *
 * Cred chase: docs/CREDS_TRACKER.md Q11 row (LLM keys).
 * Mirror clients:
 *   - backend/services/adsGptClient.js  (commit 9f35040)
 *   - backend/services/ratehawkClient.js (commit 2852b82)
 *   - backend/services/callifiedClient.js (commit 9ec52df)
 *   - backend/services/tmcDiagnosticPrompts.js (TMC LLM prompts — pure
 *     prompt-builder; this module is the consumer-shape equivalent for
 *     itinerary-suggest)
 */

'use strict';

const { getBudgetCap, evaluateCap, KEYS } = require('../lib/tenantSettings');

const INTEGRATION = 'llm'; // share the LLM monthly cap envelope
const TASK_NAME = 'itinerary-suggest'; // PRD §9.1 + FR-3.6
const MODEL_PRIMARY = 'gemini-2.5-flash'; // PRD FR-3.6 + AI_SURFACES §3
const GEMINI_KEY_ENV = 'GEMINI_API_KEY'; // matches lib/llmRouter ENV_FOR_MODEL

// Touch KEYS so the imported binding isn't flagged unused — also makes
// the canonical-keys dependency explicit for future readers grep-tracing
// the cap pattern across consumers.
void KEYS;

/**
 * Pre-call cap check. Returns evaluateCap envelope.
 * Throws { code: 'ITINERARY_SUGGEST_BUDGET_EXCEEDED', spentCents, capCents }
 * if over cap.
 *
 * CJS self-mocking seam: calls `module.exports.computeMonthlySpendCents(...)`
 * via the exports indirection so vitest spies installed via
 * `vi.spyOn(client, 'computeMonthlySpendCents')` intercept correctly.
 * Mirrors callifiedClient / ratehawkClient / adsGptClient.
 */
async function checkBudgetCap(tenantId) {
  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  // Resolve via module.exports indirection — see CJS-self-mocking-seam
  // standing rule (cron-learning 2026-05-24).
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly LLM spend cap reached for this tenant.');
    err.code = 'ITINERARY_SUGGEST_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(
      `[itinerarySuggestLLM] tenant ${tenantId} at ${Math.round(
        evaluation.percent * 100,
      )}% of monthly LLM cap ($${(spentCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)})`,
    );
  }
  return evaluation;
}

/**
 * Sum month-to-date LLM spend in cents. STUB: returns 0 (the real spend
 * lives in LlmCallLog and is summed by lib/llmRouter.computeMonthlySpendCents;
 * we could call across but keeping this stub-local mirrors the other cap
 * consumers and avoids a circular dep when real-mode lands).
 *
 * Real-mode TODO: either delegate to llmRouter's computeMonthlySpendCents
 * (single source of truth for LLM spend) OR sum the same LlmCallLog rows
 * here (filtered by task='itinerary-suggest' if we want task-scoped cap).
 * PRD doesn't require task-scoped — share the LLM envelope.
 */
async function computeMonthlySpendCents(_tenantId) {
  // STUB: zero spend. Real-mode swap = call lib/llmRouter's helper.
  return 0;
}

/**
 * Build the deterministic stub suggestion. Pure function — same inputs
 * always render the same output. Used both as the no-creds fallback AND
 * as the fail-soft path when the real Gemini call errors.
 *
 * The shape mirrors the canonical envelope documented in the module
 * header. S9 (visual editor) + S11 (POI seed) MUST be able to consume
 * this without branch-on-`source` — both modes return the same shape.
 */
function buildStubSuggestion({ destination, durationDays, themeJson, budgetTier }) {
  const days = Math.max(1, Number(durationDays) || 1);
  const destLabel = destination || 'destination';
  const tier = budgetTier || 'standard';
  // Theme tag: pick the first theme key if themeJson is an object, else
  // a generic label. We deliberately don't fabricate strong claims about
  // the destination — the stub stays neutral so operators don't ship
  // synthetic details to customers thinking they came from real research.
  let themeTag = 'general';
  if (themeJson && typeof themeJson === 'object' && !Array.isArray(themeJson)) {
    const keys = Object.keys(themeJson);
    if (keys.length > 0) themeTag = String(keys[0]).slice(0, 40);
  } else if (typeof themeJson === 'string' && themeJson.trim()) {
    themeTag = themeJson.trim().slice(0, 40);
  }

  const daySplit = [];
  for (let d = 1; d <= days; d += 1) {
    daySplit.push({
      dayNumber: d,
      theme: `[STUB] Day ${d} — ${themeTag} theme placeholder`,
      items: [
        {
          itemType: 'activity',
          description: `[STUB] Day ${d} activity placeholder for ${destLabel} (${tier} tier). Real Gemini itinerary lands when Q-IT-2 key arrives.`,
          estimatedCost: null,
          latitude: null,
          longitude: null,
          suggestedSupplierName: null,
        },
        {
          itemType: 'meal',
          description: `[STUB] Day ${d} meal placeholder`,
          estimatedCost: null,
          latitude: null,
          longitude: null,
          suggestedSupplierName: null,
        },
      ],
    });
  }

  return {
    daySplit,
    poiSuggestions: [
      {
        name: `[STUB] POI placeholder for ${destLabel}`,
        description: '[STUB] Real Gemini-sourced POI suggestions land when Q-IT-2 key arrives.',
        latitude: null,
        longitude: null,
        themeTag,
      },
    ],
    thematicNotes: `[STUB-ITINERARY-SUGGEST] Synthetic ${days}-day ${tier}-tier outline for ${destLabel}. Real Gemini reasoning lands when Q-IT-2 key arrives.`,
    summary: `[STUB] ${days}-day ${destLabel} (${tier}) — synthetic content pending Q-IT-2.`,
  };
}

/**
 * Whether the real Gemini call should fire. Wraps the env-var probe so
 * tests can `vi.spyOn(client, 'realModeEnabled').mockReturnValue(true)`
 * without setting the env directly. Synchronous — callable from sync paths.
 *
 * Note: per PRD §9.1, per-tenant key support eventually comes via
 * SupplierCredential (category "llm-key"). This module checks ENV only
 * for now; the SupplierCredential lookup is a follow-up gap (mirrors the
 * lib/llmRouter scaffold's `llmEnabled` contract).
 */
function realModeEnabled() {
  return Boolean(process.env[GEMINI_KEY_ENV]);
}

/**
 * Attempt a real Gemini call. STUB: real-mode wire-in is gated on
 * Q-IT-2 (Gemini API key) arriving — until then, this function is
 * unreachable in practice (realModeEnabled() returns false). The
 * scaffold is present so the swap-in is a single-file edit when keys
 * land.
 *
 * Contract: returns a structured suggestionJson object matching the
 * stub shape (so consumers don't branch). Throws on any error —
 * caller falls through to the stub via try/catch.
 */
async function callGemini({ destination, durationDays, themeJson, budgetTier }) {
  // Touch params so linter doesn't flag unused — and so the real-mode
  // implementation has the same destructure shape ready.
  void destination;
  void durationDays;
  void themeJson;
  void budgetTier;
  // Real-mode TODO (post-Q-IT-2):
  //   const { GoogleGenerativeAI } = require('@google/generative-ai');
  //   const ai = new GoogleGenerativeAI(process.env[GEMINI_KEY_ENV]);
  //   const model = ai.getGenerativeModel({ model: MODEL_PRIMARY,
  //     generationConfig: { responseMimeType: 'application/json',
  //                         maxOutputTokens: 4096 } });
  //   const prompt = buildSuggestPrompt({ destination, durationDays,
  //     themeJson, budgetTier });
  //   const res = await model.generateContent(prompt);
  //   return JSON.parse(res.response.text());
  throw new Error('itinerarySuggestLLM real-mode not yet wired (Q-IT-2 pending).');
}

/**
 * Primary surface: suggest an itinerary.
 *
 * @param {Object} args
 * @param {number|string} args.tenantId    — required for the budget cap
 * @param {string} args.destination        — free-text or Cost Master destination
 * @param {number} args.durationDays       — number of days
 * @param {Object|string} [args.themeJson] — traveller profile / theme hints
 * @param {string} [args.budgetTier]       — 'economy' | 'standard' | 'premium' | etc.
 * @param {Object} [_ctx]                  — { prisma } context (currently unused;
 *                                            reserved for future per-tenant key /
 *                                            SupplierCredential lookup per PRD §9.1)
 *
 * @returns {Promise<{
 *   suggestionJson: Object,
 *   source: 'stub' | 'gemini',
 *   model: string,
 *   stub: boolean,
 * }>}
 */
async function suggestItinerary(args = {}, _ctx = {}) {
  const { tenantId, destination, durationDays, themeJson, budgetTier } = args;

  if (!tenantId) {
    // Same shape as adsGptClient — fail fast before the cap query so a
    // null tenant doesn't silently fall through to tenant-0 cap lookup.
    throw new Error('tenantId required');
  }
  if (durationDays != null && Number(durationDays) <= 0) {
    throw new Error('durationDays must be > 0');
  }

  // Pre-call cap check via the self-mocking seam.
  await module.exports.checkBudgetCap(tenantId);

  // STUB observability log (matches adsGptClient format). Token counts
  // not yet measured in stub mode — would land with real-mode swap
  // alongside the LlmCallLog persist.
  console.log(
    `[itinerarySuggestLLM STUB] suggestItinerary called: tenantId=${tenantId} destination=${destination || '?'} durationDays=${durationDays || '?'} budgetTier=${budgetTier || '?'}`,
  );

  // Real-mode dispatch — try the Gemini call; fall through to stub on
  // any error or when key is absent.
  if (module.exports.realModeEnabled()) {
    try {
      const realJson = await module.exports.callGemini({
        destination,
        durationDays,
        themeJson,
        budgetTier,
      });
      return {
        suggestionJson: realJson,
        source: 'gemini',
        model: MODEL_PRIMARY,
        stub: false,
      };
    } catch (e) {
      // Fail-soft: never break the operator UX on a Gemini hiccup.
      // Stub shape is the same; the operator just sees the [STUB-…]
      // markers on the suggestions.
      console.error(
        `[itinerarySuggestLLM] real-mode call failed (falling through to stub): ${e.message}`,
      );
    }
  }

  const suggestionJson = buildStubSuggestion({
    destination,
    durationDays,
    themeJson,
    budgetTier,
  });
  return {
    suggestionJson,
    source: 'stub',
    model: MODEL_PRIMARY,
    stub: true,
  };
}

module.exports = {
  // Primary surface
  suggestItinerary,
  // Budget-cap surface (mirrors adsGptClient / ratehawkClient / callifiedClient)
  checkBudgetCap,
  computeMonthlySpendCents,
  // Real-mode probe + dispatch (exported for vi.spyOn in tests)
  realModeEnabled,
  callGemini,
  // Stub builder exported for test-side determinism pins
  buildStubSuggestion,
  // Constants for cross-module references + test pins
  INTEGRATION,
  TASK_NAME,
  MODEL_PRIMARY,
  GEMINI_KEY_ENV,
};
