// LLM router — STUB MODE.
//
// Per-task model routing per PRD §9.1 (docs/TRAVEL_CRM_PRD.md lines 700-708,
// Q11 locked). API keys are held by Travel Stall and stored under
// SupplierCredential category "llm-key" — until they land, this module
// returns deterministic synthetic responses so downstream consumers
// (talking-points endpoint, personalised recs PDF, form-vs-call mismatch)
// can be built + tested end-to-end without external dependencies.
//
// Real-mode swap: each provider gets a top-of-file `if (apiKey)
// return realProviderCall(...)` branch inside routeRequest. The
// envelope is the SAME shape for stub + real
// ({ text, finishReason, usage, model, stub }) so consumers don't
// break on the cutover.
//
// Per-tenant LLM key resolution (S45 — 2026-06-10):
//   `getLlmKey(tenantId, model)` checks SupplierCredential category
//   'llm-key' first (supplierName matches model name like 'gemini-flash'
//   or the env-var like 'GEMINI_API_KEY'); falls back to process.env
//   on miss. Returns null if both miss. Async because the DB lookup
//   requires an await — `llmEnabled` followed it from sync to async
//   in the same slice. Callers grep + audit was zero outside this
//   module's own tests, so the contract flip was safe.
//
// Cost attribution: every call emits a structured log line:
//   [llm-router] task=X model=Y tenant=Z tokens_in=N tokens_out=M
//                cost_estimate=$ stub=<bool> reason=<routing-reason>
// AND persists an LlmCallLog row (PRD §9.1 + R7). The DB write is fire-
// and-forget — a Prisma failure logs an error but never throws out of
// routeRequest. Powers GET /api/admin/llm-spend daily summary.
//
// Caller-supplied __userId + __surface payload hints land on the
// LlmCallLog row when present; existing callers (talking-points endpoint
// at routes/travel_diagnostics.js) pass none today, so those columns
// stay null until a follow-up wires them through. The __ prefix avoids
// collision with real payload fields the prompt cares about.
//
// PII discipline: payload contents (talking-points input, call
// transcripts) are NEVER logged — only the token count. The structured
// log line surfaces routing/cost telemetry only.
//
// Per-tenant monthly budget cap (2026-05-24 product-call):
//   routeRequest performs a pre-call cap check using the shared
//   tenantSettings helper (getBudgetCap + evaluateCap). The cap is
//   sourced from TenantSetting.budgetCap_llm_monthly_usd_cents with
//   env-var fallback ($100 / 10000 cents). Monthly spend is summed
//   from LlmCallLog.costEstimate (DB Decimal, USD) since the start
//   of the current month, converted to cents (× 100).
//   - Over cap: throw { code: 'LLM_BUDGET_EXCEEDED', error,
//     spentCents, capCents }. Caller decides whether to fall back
//     or surface to the operator.
//   - ≥80% spent: console.warn so the alert appears in logs (Slack
//     wiring is future work — the 80% threshold is the call point).
//   - Missing tenantId: skip the cap check (best-effort; matches the
//     existing tenantId-optional contract).
//   - First consumer of the per-tenant cap pattern. AdsGPT, AI Calling,
//     RateHawk clone this wiring against their own integration name.

const { getBudgetCap, evaluateCap } = require("./tenantSettings");

// PRD §9.1 routing table. Each entry: { primary, fallback }.
// Primary is what we call first; fallback is the real-mode degraded
// path when the primary provider errors or rate-limits. The scaffold
// always returns the primary's model identifier so consumers can
// pin the contract; fallback wiring lands with real-mode.
const TASK_ROUTING = {
  "search":            { primary: "perplexity-sonar",  fallback: null },
  "citation":          { primary: "perplexity-sonar",  fallback: null },
  "reasoning":         { primary: "claude-opus-4-7",   fallback: "gpt-4" },
  "talking-points":    { primary: "claude-opus-4-7",   fallback: "gpt-4" },
  "form-vs-call":      { primary: "claude-opus-4-7",   fallback: "gpt-4" },
  "bulk-text":         { primary: "gemini-flash",      fallback: "claude-haiku" },
  "call-summary":      { primary: "gemini-flash",      fallback: null },
  // Itinerary-suggest (PRD_TRAVEL_ITINERARY_UPGRADES FR-3.6 + AI_SURFACES §3
  // table). 2K in / 4K out — larger out than bulk-text because the full
  // itinerary JSON shape (daySplit + poiSuggestions + thematicNotes) lands
  // in one response. Routed to gemini-flash to match PRD §9.1's locked
  // routing table for Travel Stall's bulk-shape Gemini calls. Real-mode
  // swap lives in backend/services/itinerarySuggestLLM.js (S14 — same
  // commit). Real call gated on Q-IT-2 / Q11 GEMINI_API_KEY.
  "itinerary-suggest": { primary: "gemini-flash",      fallback: "claude-haiku" },
  // Catch-all for unrecognized tasks → reasoning model (Claude)
  // matches PRD's preference for a high-quality default.
};

const VALID_TASKS = Object.keys(TASK_ROUTING);

// Model → env var. PRD doesn't enumerate the env names; these are
// the conventional names used by each provider's official SDK. When
// real-mode lands, SupplierCredential resolution overrides these
// (per-tenant key support); ENV stays as the dev/CI fallback.
const ENV_FOR_MODEL = {
  "perplexity-sonar": "PERPLEXITY_API_KEY",
  "claude-opus-4-7":  "ANTHROPIC_API_KEY",
  "gpt-4":            "OPENAI_API_KEY",
  "gemini-flash":     "GEMINI_API_KEY",
  "claude-haiku":     "ANTHROPIC_API_KEY",
};

/**
 * Resolve an LLM API key for a tenant + model. SupplierCredential lookup
 * first (per-tenant override), then process.env fallback (dev/CI default).
 * Returns null if both miss.
 *
 * SupplierCredential row contract (per S45):
 *   category    = 'llm-key'
 *   supplierName = either the model name ('gemini-flash', 'claude-opus-4-7')
 *                  OR the env-var name ('GEMINI_API_KEY', 'ANTHROPIC_API_KEY')
 *                  — accepted as a fuzzy match so seeding scripts can pick
 *                  whichever feels more natural to operators.
 *   passwordEncrypted = AES-256-GCM ciphertext of the actual API key
 *                       (loginIdEncrypted reserved for a "key-id" if the
 *                       provider has one, otherwise placeholder).
 *
 * Decryption is delegated to backend/lib/fieldEncryption.decrypt() which
 * no-ops cleanly when the value isn't an ENC: prefix (so tests that seed
 * plaintext rows still work). Missing WELLNESS_FIELD_KEY → decrypt
 * returns the row's stored value as-is.
 *
 * Best-effort: any Prisma / decrypt error is logged and treated as a
 * miss (caller falls through to ENV). NEVER throws.
 *
 * @param {number} tenantId    — optional. When omitted, skip the DB
 *                              lookup and return the ENV value directly.
 * @param {string} model       — e.g. 'gemini-flash' or 'claude-opus-4-7'
 * @returns {Promise<string|null>}
 */
async function getLlmKey(tenantId, model) {
  const envVar = ENV_FOR_MODEL[model];
  const envValue = envVar ? process.env[envVar] : null;

  // No tenant scope (e.g. sync probes from /api/health legacy callers
  // wrapped via .then()) → ENV only. Matches the pre-S45 contract.
  if (!tenantId) {
    return envValue || null;
  }

  try {
    const prisma = require("./prisma");
    if (
      !prisma.supplierCredential ||
      typeof prisma.supplierCredential.findFirst !== "function"
    ) {
      return envValue || null;
    }
    // Accept either the model name OR the env-var name as supplierName.
    // PRD §9.1 doesn't pin the naming convention; we accept both so the
    // operator seeding the row doesn't need to know which one our code
    // looks up. The 'in' filter is one Prisma round-trip vs. two.
    const candidates = [model];
    if (envVar) candidates.push(envVar);
    const row = await prisma.supplierCredential.findFirst({
      where: {
        tenantId,
        category: "llm-key",
        supplierName: { in: candidates },
      },
      select: { passwordEncrypted: true },
    });
    if (row && row.passwordEncrypted) {
      // Lazy require to avoid a circular bomb in test harnesses that
      // hand-roll the crypto layer.
      const { decrypt } = require("./fieldEncryption");
      const plaintext = decrypt(row.passwordEncrypted);
      if (plaintext) return plaintext;
    }
  } catch (e) {
    console.error(
      `[llm-router] getLlmKey supplierCredential lookup failed (non-fatal, falling back to ENV): ${e.message}`,
    );
  }

  return envValue || null;
}

/**
 * Whether the provider for `task` has a real API key available, either
 * via SupplierCredential (per-tenant) or process.env (dev/CI fallback).
 *
 * Async since 2026-06-10 (S45) — the SupplierCredential lookup requires
 * a DB round-trip. Pre-S45 the function was sync and ENV-only; the
 * surface is back-compat for ENV-only callers (just await it).
 *
 * @param {string} task
 * @param {number} [tenantId] — optional. Omit for ENV-only behaviour.
 * @returns {Promise<boolean>}
 */
async function llmEnabled(task, tenantId) {
  const route = TASK_ROUTING[task];
  if (!route) return false;
  const key = await module.exports.getLlmKey(tenantId, route.primary);
  return Boolean(key);
}

function pickModel(task) {
  if (!TASK_ROUTING[task]) {
    // Unknown task → reasoning catch-all (Claude). PRD prefers a
    // high-quality default for unknown classes — talking-points/
    // form-vs-call quality matters more than bulk-text/call-summary.
    return { task, model: "claude-opus-4-7", reason: "unknown-task-fallback" };
  }
  return { task, model: TASK_ROUTING[task].primary, reason: "primary" };
}

/**
 * Compute month-to-date LLM spend in USD cents for a tenant. Sums the
 * LlmCallLog.costEstimate column (Decimal in USD) since the first of
 * the current month, then multiplies by 100 to land in cents (matches
 * the unit the cap is stored in).
 *
 * If the LlmCallLog model is unavailable (e.g. test harness with no
 * Prisma client patched in) the function returns 0 cents — the caller
 * treats this as "no spend recorded yet" and proceeds. A Prisma error
 * is logged + treated the same way (best-effort observability —
 * don't block the LLM call on an aggregate-query hiccup).
 */
async function computeMonthlySpendCents(tenantId) {
  try {
    const prisma = require("./prisma");
    if (!prisma.llmCallLog || typeof prisma.llmCallLog.aggregate !== "function") {
      return 0;
    }
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const agg = await prisma.llmCallLog.aggregate({
      where: { tenantId, createdAt: { gte: monthStart } },
      _sum: { costEstimate: true },
    });
    // costEstimate is Decimal (USD). Prisma returns it as a Decimal-like
    // object or string depending on driver — coerce via Number then × 100
    // for cents. Round to integer cents to avoid float drift.
    const dollars = Number(agg?._sum?.costEstimate ?? 0) || 0;
    return Math.round(dollars * 100);
  } catch (e) {
    console.error(`[llm-router] spend aggregate failed (non-fatal, treating as 0): ${e.message}`);
    return 0;
  }
}

async function routeRequest({ task, payload, tenantId } = {}) {
  if (!task) {
    throw new Error("routeRequest: task required");
  }
  if (!VALID_TASKS.includes(task)) {
    // Don't reject — just route to the catch-all + log the unknown
    // task so config drift surfaces. STUB: real impl might error
    // to flag a config gap; the scaffold is forgiving so downstream
    // consumers can iterate without a routing-table update.
    console.warn(`[llm-router] unknown task "${task}" — routing to reasoning fallback`);
  }

  // Per-tenant monthly budget cap pre-check (2026-05-24 product-call).
  // First consumer of the cap pattern — AdsGPT / AI Calling / RateHawk
  // clone this block against their own integration names. The cap +
  // evaluator come from backend/lib/tenantSettings.js; spend comes from
  // LlmCallLog (this module's own audit row). Cap check is skipped when
  // tenantId is omitted (best-effort; matches the existing optional-
  // tenantId contract — pre-cap callers don't always thread it).
  if (tenantId) {
    const capCents = await getBudgetCap(tenantId, "llm");
    const spentCents = await computeMonthlySpendCents(tenantId);
    const verdict = evaluateCap(spentCents, capCents);
    if (!verdict.withinCap) {
      const err = new Error("Monthly LLM spend cap reached for this tenant.");
      err.code = "LLM_BUDGET_EXCEEDED";
      err.spentCents = verdict.spentCents;
      err.capCents = verdict.capCents;
      throw err;
    }
    if (verdict.alertThreshold) {
      console.warn(
        `[llm-router] tenant=${tenantId} approaching LLM monthly cap: ` +
        `spent=${verdict.spentCents}c cap=${verdict.capCents}c ` +
        `percent=${(verdict.percent * 100).toFixed(1)}% (Slack alert pending wire-in)`,
      );
    }
  }

  const { model, reason } = pickModel(task);

  // STUB: real provider call. When the matching API key lands in
  // env (or in SupplierCredential per PRD §9.1), swap this block
  // for `return realProviderCall(model, payload)`.
  // Synthetic response shape matches what the real providers return
  // after normalization: { text, finishReason, usage, model, stub }.
  const stubText = buildStubText(task, payload);
  const tokensIn = estimateTokens(JSON.stringify(payload || {}));
  const tokensOut = estimateTokens(stubText);

  // Structured log line — token counts ONLY, never payload content.
  // Format pinned as the real-mode swap-point contract.
  console.log(
    `[llm-router] task=${task} model=${model} tenant=${tenantId || "?"} ` +
    `tokens_in=${tokensIn} tokens_out=${tokensOut} cost_estimate=$0.0000 stub=true reason=${reason}`,
  );

  // PRD §9.1 + R7 — persist one LlmCallLog row per call for the admin
  // daily-summary endpoint (GET /api/admin/llm-spend). Best-effort: a
  // DB-write failure must NEVER fail the LLM call (the in-memory response
  // is the primary contract, the audit row is observability). Prisma is
  // required lazily so test harnesses / seed scripts that hand-roll their
  // own PrismaClient don't trigger a circular-import bomb.
  try {
    const prisma = require("./prisma");
    prisma.llmCallLog
      .create({
        data: {
          tenantId: tenantId || 1,
          task,
          model,
          reason,
          promptTokens: tokensIn,
          completionTokens: tokensOut,
          totalTokens: tokensIn + tokensOut,
          costEstimate: 0, // stub mode = $0; real-mode wire-in adds per-token pricing
          stub: true,
          userId: (payload && payload.__userId) || null,
          surface: (payload && payload.__surface) || null,
        },
      })
      .catch((e) => {
        // Log + swallow. Don't let observability break the primary call.
        console.error(
          `[llm-router] LlmCallLog persist failed (non-fatal): ${e.message}`,
        );
      });
  } catch (e) {
    console.error(
      `[llm-router] LlmCallLog require failed (non-fatal): ${e.message}`,
    );
  }

  return {
    text: stubText,
    finishReason: "stop",
    usage: {
      promptTokens: tokensIn,
      completionTokens: tokensOut,
      totalTokens: tokensIn + tokensOut,
    },
    model,
    stub: true,
  };
}

function buildStubText(task, _payload) {
  // Deterministic stub text per task class — useful for tests that
  // need predictable strings AND for demo screenshots where the
  // operator wants to see SOMETHING in the talking-points field
  // even without LLM creds. Payload is deliberately ignored (PII
  // discipline — see header). Real-mode renders the payload.
  const tag = `[STUB-${task.toUpperCase()}]`;
  switch (task) {
    case "talking-points":
      return `${tag} Lead profile suggests: (1) confirm budget tier, (2) ask about prior travel, (3) probe destination flexibility. Synthetic content — real Claude reasoning lands when Q11 keys arrive.`;
    case "call-summary":
      return `${tag} Call summary: customer expressed interest in trip, advisor walked through options, follow-up scheduled. Synthetic content — real Gemini summary lands when Q11 keys arrive.`;
    case "form-vs-call":
      return `${tag} Form-vs-call comparison: 85% match (synthetic). Real Claude comparison lands when Q11 keys arrive.`;
    case "search":
    case "citation":
      return `${tag} Cited search result: "Synthetic citation pending Q11 Perplexity key." (https://example.invalid/q11-stub)`;
    case "bulk-text":
      return `${tag} Bulk text output (synthetic). Real Gemini Flash lands when Q11 keys arrive.`;
    case "itinerary-suggest":
      // Routed to gemini-flash per PRD §9.1 + FR-3.6 (S14). Detailed
      // suggestionJson shape (daySplit + poiSuggestions + thematicNotes)
      // is produced by backend/services/itinerarySuggestLLM.js — this
      // stub-text exists only so unrecognised-task callers of routeRequest
      // get a sensible string. The structured-JSON path uses the service
      // module directly, not routeRequest's text envelope.
      return `${tag} Itinerary suggestion (synthetic). Real Gemini Flash itinerary lands when Q-IT-2 / Q11 keys arrive — see backend/services/itinerarySuggestLLM.js for the structured-JSON path.`;
    case "reasoning":
      return `${tag} Reasoning output (synthetic). Real Claude/GPT lands when Q11 keys arrive.`;
    default:
      // Unknown task → still produce SOMETHING so the consumer
      // doesn't bomb on a null/empty response. Tag uses the
      // raw task name so the operator can spot config drift.
      return `${tag} Reasoning output (synthetic). Real Claude/GPT lands when Q11 keys arrive.`;
  }
}

function estimateTokens(s) {
  // Rough heuristic: ~4 chars per token (English text). Real
  // providers return exact token counts; this is just for the
  // log line in stub mode. Don't pin this in a contract — the
  // real-mode swap returns provider-reported counts.
  if (!s) return 0;
  return Math.ceil(String(s).length / 4);
}

module.exports = {
  TASK_ROUTING,
  VALID_TASKS,
  ENV_FOR_MODEL,
  llmEnabled,
  getLlmKey,
  pickModel,
  routeRequest,
  // Exported for unit-test introspection only — not part of the
  // consumer-facing contract.
  buildStubText,
  estimateTokens,
  computeMonthlySpendCents,
};
