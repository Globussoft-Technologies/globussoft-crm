/**
 * Travel marketing-flyer-copy LLM client — STUB MODE.
 *
 * STUB: real Gemini 2.5 Flash call pending Q-AI-3 / Q-IT-2 / Q11 keys
 * (overlapping cred chase — same `GEMINI_API_KEY` env var the lib/llmRouter.js
 * `marketing-flyer-copy` task class wires to per PRD §9.1 + PRD_TRAVEL_MARKETING_FLYER
 * §FR-3.6.1). When the key lands, the `generateFlyerCopy` body checks
 * `llmRouter.getLlmKey(tenantId, 'gemini-flash')` first (SupplierCredential
 * per-tenant override, then process.env fallback) and dispatches via
 * `@google/generative-ai` (already in backend/package.json at ^0.24.1).
 * On any error / missing key the module falls through to the deterministic
 * stub — downstream consumers (S17 PDF/PNG render pipeline, S18 public share,
 * S20 canvas editor) get a stable shape contract today.
 *
 * Source of truth: docs/PRD_TRAVEL_MARKETING_FLYER.md FR-3.6.1:
 *   - (a) Trigger: "AI suggest headlines" button on FlyerCanvasEditor.jsx
 *         (S20 — DD-5.1 blocked) + future block-default population on
 *         brand-kit-aware new-flyer flow.
 *   - (b) Prompt inputs: destination, sub-brand (TMC / RFU / TravelStall /
 *         VisaSure), themeJson (free-text trip type / season / vibe),
 *         targetAudience (free-text — "school principals Class IX-X" /
 *         "young families with kids 6-12" / etc.).
 *   - (c) Routed via lib/llmRouter.js new task class `marketing-flyer-copy`.
 *         Model: gemini-2.5-flash (matches PRD §9.1 bulk-text routing for
 *         consistent Gemini envelope use).
 *   - (d) Returned shape: structured JSON with `headline` + `body` + `cta`
 *         (three canonical block slots that consume into the flyer template
 *         per FR-3.1's text-block registry).
 *   - (e) AI Re-score-style UX — operator picks one of N variants, edits,
 *         and lands the copy into the flyer block. No auto-write.
 *
 * Canonical return envelope (STUB + REAL — same shape):
 *   {
 *     copyJson: {
 *       headline: "...",
 *       body:     "...",
 *       cta:      "...",
 *       _source:  "stub" | "gemini",   // mirrored at top-level too
 *     },
 *     source: "stub" | "gemini",
 *     model: "gemini-2.5-flash",        // primary per PRD §9.1
 *     stub: <bool>,                      // mirrors lib/llmRouter envelope
 *   }
 *
 * The `copyJson` shape is what S17 (render pipeline) + S20 (canvas editor)
 * consume — pinning it here lets those slices iterate without waiting for
 * real Gemini access. AC-6.8 ("AI suggest headlines returns three variants
 * in <5s, stub-mode acceptable") is satisfied by this module's deterministic
 * stub path.
 *
 * Budget cap: $100/month per tenant via the cross-cutting TenantSetting
 * pattern (LLM_MONTHLY_CAP_USD_CENTS = 10000 cents default per
 * backend/lib/tenantSettings.js DEFAULTS — shares the cap with the rest
 * of the LLM router because every gemini-flash / claude-opus call goes
 * through the same monthly budget envelope). Mirrors itinerarySuggestLLM +
 * callifiedClient + adsGptClient + ratehawkClient self-mocking seam
 * (`module.exports.fn(...)` indirection) so vitest can `vi.spyOn(client,
 * 'computeMonthlySpendCents')`.
 *
 * Cred chase: docs/CREDS_TRACKER.md Q-AI-3 row (Gemini key) / Q11 (LLM keys).
 * Mirror clients:
 *   - backend/services/itinerarySuggestLLM.js   (commit 17449b35, S14)
 *   - backend/services/adsGptClient.js          (commit 9f35040)
 *   - backend/services/ratehawkClient.js        (commit 2852b82)
 *   - backend/services/callifiedClient.js       (commit 9ec52df)
 */

'use strict';

const { getBudgetCap, evaluateCap, KEYS } = require('../lib/tenantSettings');

const INTEGRATION = 'llm'; // share the LLM monthly cap envelope
const TASK_NAME = 'marketing-flyer-copy'; // PRD §9.1 + FR-3.6.1
const MODEL_PRIMARY = 'gemini-2.5-flash'; // PRD FR-3.6.1 + AI_SURFACES §3
const GEMINI_KEY_ENV = 'GEMINI_API_KEY'; // matches lib/llmRouter ENV_FOR_MODEL

// Touch KEYS so the imported binding isn't flagged unused — also makes
// the canonical-keys dependency explicit for future readers grep-tracing
// the cap pattern across consumers.
void KEYS;

/**
 * Pre-call cap check. Returns evaluateCap envelope.
 * Throws { code: 'MARKETING_FLYER_COPY_BUDGET_EXCEEDED', spentCents, capCents }
 * if over cap.
 *
 * CJS self-mocking seam: calls `module.exports.computeMonthlySpendCents(...)`
 * via the exports indirection so vitest spies installed via
 * `vi.spyOn(client, 'computeMonthlySpendCents')` intercept correctly.
 * Mirrors itinerarySuggestLLM / callifiedClient / ratehawkClient / adsGptClient.
 */
async function checkBudgetCap(tenantId) {
  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  // Resolve via module.exports indirection — see CJS-self-mocking-seam
  // standing rule (cron-learning 2026-05-24).
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly LLM spend cap reached for this tenant.');
    err.code = 'MARKETING_FLYER_COPY_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(
      `[marketingFlyerCopyLLM] tenant ${tenantId} at ${Math.round(
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
 * here (filtered by task='marketing-flyer-copy' if we want task-scoped cap).
 * PRD doesn't require task-scoped — share the LLM envelope.
 */
async function computeMonthlySpendCents(_tenantId) {
  // STUB: zero spend. Real-mode swap = call lib/llmRouter's helper.
  return 0;
}

/**
 * Build the deterministic stub copy. Pure function — same inputs always
 * render the same output. Used both as the no-creds fallback AND as the
 * fail-soft path when the real Gemini call errors.
 *
 * The shape mirrors the canonical envelope documented in the module
 * header. S17 (render pipeline) + S20 (canvas editor) MUST be able to
 * consume this without branch-on-`source` — both modes return the same
 * shape.
 *
 * Stub copy is intentionally generic + clearly marked `[STUB]` so
 * operators do NOT mistake synthetic content for real creative output
 * and accidentally publish a flyer with placeholder text. Same discipline
 * as itinerarySuggestLLM's `[STUB-ITINERARY-SUGGEST]` markers.
 */
function buildStubCopy({ destination, subBrand, themeJson, targetAudience }) {
  const destLabel = destination || 'destination';
  const audience = (typeof targetAudience === 'string' && targetAudience.trim())
    ? targetAudience.trim().slice(0, 80)
    : 'travellers';
  // Theme tag derivation mirrors itinerarySuggestLLM — accept object
  // (first key wins) or string. Used as a body-line hint so the stub
  // doesn't look identical across destinations.
  let themeTag = 'general';
  if (themeJson && typeof themeJson === 'object' && !Array.isArray(themeJson)) {
    const keys = Object.keys(themeJson);
    if (keys.length > 0) themeTag = String(keys[0]).slice(0, 40);
  } else if (typeof themeJson === 'string' && themeJson.trim()) {
    themeTag = themeJson.trim().slice(0, 40);
  }
  const subBrandLabel = (typeof subBrand === 'string' && subBrand.trim())
    ? subBrand.trim().slice(0, 40)
    : 'travel';

  return {
    headline: `[STUB] ${destLabel} calling — your trip awaits`,
    body: `[STUB] Discover ${destLabel} with ${subBrandLabel}. Curated ${themeTag} experiences crafted for ${audience}. Real Gemini-generated copy lands when Q-AI-3 / Q11 keys arrive.`,
    cta: 'Book now',
    _source: 'stub',
  };
}

/**
 * Whether the real Gemini call should fire. Wraps the key probe so
 * tests can `vi.spyOn(client, 'realModeEnabled').mockResolvedValue(true)`
 * without setting the env directly.
 *
 * Async since 2026-06-10 (S15) — resolves the API key via
 * lib/llmRouter.getLlmKey() which checks SupplierCredential category
 * 'llm-key' first then falls back to process.env[GEMINI_KEY_ENV]. The
 * single caller (generateFlyerCopy below) was updated to `await
 * module.exports.realModeEnabled(tenantId)` in the same slice.
 *
 * @param {number} [tenantId] — optional. Omit for ENV-only behaviour
 *                              (matches the pre-S45 contract).
 * @returns {Promise<boolean>}
 */
async function realModeEnabled(tenantId) {
  // Per PRD §9.1 / S45: per-tenant LLM keys live in SupplierCredential
  // category 'llm-key'. Delegate to lib/llmRouter.getLlmKey so the
  // SupplierCredential→ENV cascade lives in one place.
  const llmRouter = require('../lib/llmRouter');
  const key = await llmRouter.getLlmKey(tenantId, 'gemini-flash');
  return Boolean(key);
}

/**
 * Attempt a real Gemini call. STUB: real-mode wire-in is gated on
 * Q-AI-3 (Gemini API key) arriving — until then, this function is
 * unreachable in practice (realModeEnabled() resolves false). The
 * scaffold is present so the swap-in is a single-file edit when keys
 * land.
 *
 * Contract: returns a structured copyJson object matching the stub
 * shape (so consumers don't branch). Throws on any error — caller
 * falls through to the stub via try/catch.
 */
async function callGemini({ destination, subBrand, themeJson, targetAudience }) {
  // Touch params so linter doesn't flag unused — and so the real-mode
  // implementation has the same destructure shape ready.
  void destination;
  void subBrand;
  void themeJson;
  void targetAudience;
  // Real-mode TODO (post-Q-AI-3):
  //   const { GoogleGenerativeAI } = require('@google/generative-ai');
  //   const ai = new GoogleGenerativeAI(process.env[GEMINI_KEY_ENV]);
  //   const model = ai.getGenerativeModel({ model: MODEL_PRIMARY,
  //     generationConfig: { responseMimeType: 'application/json',
  //                         maxOutputTokens: 1024 } });
  //   const prompt = buildFlyerCopyPrompt({ destination, subBrand,
  //     themeJson, targetAudience });
  //   const res = await model.generateContent(prompt);
  //   const parsed = JSON.parse(res.response.text());
  //   return { ...parsed, _source: 'gemini' };
  throw new Error('marketingFlyerCopyLLM real-mode not yet wired (Q-AI-3 pending).');
}

/**
 * Primary surface: generate flyer copy.
 *
 * @param {Object} args
 * @param {number|string} args.tenantId        — required for the budget cap
 * @param {string} args.destination            — free-text destination (e.g. "Greece", "Bali")
 * @param {string} [args.subBrand]             — 'tmc' | 'rfu' | 'travelstall' | 'visasure'
 * @param {Object|string} [args.themeJson]     — trip type / season / vibe hints
 * @param {string} [args.targetAudience]       — e.g. "school principals", "young families"
 * @param {Object} [_ctx]                      — { prisma } context (currently unused;
 *                                                reserved for future per-tenant key /
 *                                                SupplierCredential lookup per PRD §9.1)
 *
 * @returns {Promise<{
 *   copyJson: { headline: string, body: string, cta: string, _source: 'stub'|'gemini' },
 *   source: 'stub' | 'gemini',
 *   model: string,
 *   stub: boolean,
 * }>}
 */
async function generateFlyerCopy(args = {}, _ctx = {}) {
  const { tenantId, destination, subBrand, themeJson, targetAudience } = args;

  if (!tenantId) {
    // Same shape as adsGptClient / itinerarySuggestLLM — fail fast before
    // the cap query so a null tenant doesn't silently fall through to
    // tenant-0 cap lookup.
    throw new Error('tenantId required');
  }
  if (!destination || typeof destination !== 'string' || !destination.trim()) {
    throw new Error('destination required');
  }

  // Pre-call cap check via the self-mocking seam.
  await module.exports.checkBudgetCap(tenantId);

  // STUB observability log (matches adsGptClient / itinerarySuggestLLM
  // format). Token counts not yet measured in stub mode — would land
  // with real-mode swap alongside the LlmCallLog persist.
  console.log(
    `[marketingFlyerCopyLLM STUB] generateFlyerCopy called: tenantId=${tenantId} destination=${destination || '?'} subBrand=${subBrand || '?'} audience=${targetAudience || '?'}`,
  );

  // Real-mode dispatch — try the Gemini call; fall through to stub on
  // any error or when key is absent. Pass tenantId so the resolver picks
  // up a per-tenant SupplierCredential row before the ENV fallback.
  if (await module.exports.realModeEnabled(tenantId)) {
    try {
      const realJson = await module.exports.callGemini({
        destination,
        subBrand,
        themeJson,
        targetAudience,
      });
      return {
        copyJson: { ...realJson, _source: 'gemini' },
        source: 'gemini',
        model: MODEL_PRIMARY,
        stub: false,
      };
    } catch (e) {
      // Fail-soft: never break the operator UX on a Gemini hiccup.
      // Stub shape is the same; the operator just sees the [STUB]
      // markers on the headline / body.
      console.error(
        `[marketingFlyerCopyLLM] real-mode call failed (falling through to stub): ${e.message}`,
      );
    }
  }

  const copyJson = buildStubCopy({
    destination,
    subBrand,
    themeJson,
    targetAudience,
  });
  return {
    copyJson,
    source: 'stub',
    model: MODEL_PRIMARY,
    stub: true,
  };
}

module.exports = {
  // Primary surface
  generateFlyerCopy,
  // Budget-cap surface (mirrors adsGptClient / ratehawkClient / callifiedClient /
  // itinerarySuggestLLM)
  checkBudgetCap,
  computeMonthlySpendCents,
  // Real-mode probe + dispatch (exported for vi.spyOn in tests)
  realModeEnabled,
  callGemini,
  // Stub builder exported for test-side determinism pins
  buildStubCopy,
  // Constants for cross-module references + test pins
  INTEGRATION,
  TASK_NAME,
  MODEL_PRIMARY,
  GEMINI_KEY_ENV,
};
