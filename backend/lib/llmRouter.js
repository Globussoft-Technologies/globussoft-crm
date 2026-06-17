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
  "search": { primary: "perplexity-sonar", fallback: null },
  "citation": { primary: "perplexity-sonar", fallback: null },
  "reasoning": { primary: "claude-opus-4-7", fallback: "gpt-4" },
  "talking-points": { primary: "claude-opus-4-7", fallback: "gpt-4" },
  "form-vs-call": { primary: "claude-opus-4-7", fallback: "gpt-4" },
  "bulk-text": { primary: "gemini-flash", fallback: "claude-haiku" },
  "call-summary": { primary: "gemini-flash", fallback: null },
  // Itinerary-suggest (PRD_TRAVEL_ITINERARY_UPGRADES FR-3.6 + AI_SURFACES §3
  // table). 2K in / 4K out — larger out than bulk-text because the full
  // itinerary JSON shape (daySplit + poiSuggestions + thematicNotes) lands
  // in one response. Routed to gemini-flash to match PRD §9.1's locked
  // routing table for Travel Stall's bulk-shape Gemini calls. Real call
  // gated on Q-IT-2 / Q11 GEMINI_API_KEY (see CREDS_TRACKER).
  "itinerary-suggest": { primary: "gemini-flash", fallback: "claude-haiku" },
  // Trip-countdown nudge (pre-trip daily reminder emails). Short, upbeat,
  // destination-personalised copy (subject + body) keyed to days-to-go.
  // ~0.5K in / 0.5K out — routed to gemini-flash for low-cost bulk-shape
  // calls. Falls back to the deterministic template library in
  // backend/lib/tripCountdownContent.js until Q11 GEMINI_API_KEY lands.
  "trip-countdown": { primary: "gemini-flash", fallback: "claude-haiku" },
  // Pay-or-cancel deposit-deadline reminder (2026-06-16). Short, courteous-but-
  // urgent copy (subject + body) keyed to days-until-deadline, telling the
  // customer to pay the 50% deposit before the cut-off. Same shape/cost profile
  // as trip-countdown → gemini-flash; falls back to the deterministic template
  // library in backend/lib/paymentDeadlineContent.js until Q11 keys land.
  "payment-reminder": { primary: "gemini-flash", fallback: "claude-haiku" },
  // Marketing-flyer-copy (PRD_TRAVEL_MARKETING_FLYER FR-3.6.1 + AC-6.8).
  // 1K in / 1K out — short-form headline + body + CTA JSON. Routed to
  // gemini-flash for low-cost bulk-shape Gemini calls per PRD §9.1.
  // Structured-JSON path lives in backend/services/marketingFlyerCopyLLM.js
  // (S15 — same commit); this scaffold's stub-text path returns a tagged
  // synthetic string for routeRequest text-envelope callers. Real call
  // gated on Q-AI-3 / Q11 GEMINI_API_KEY.
  "marketing-flyer-copy": { primary: "gemini-flash", fallback: "claude-haiku" },
  // Marketing-flyer-image (PRD_TRAVEL_MARKETING_FLYER FR-3.6.3).
  // AI image-gen for flyer hero blocks. Primary: DALL-E 3 (OpenAI API).
  // Fallback: Stability AI XL. Structured-image path lives in
  // backend/services/marketingFlyerImageLLM.js (S16 — same commit); this
  // scaffold's stub-text path returns a tagged synthetic string for
  // routeRequest text-envelope callers, though the canonical consumer
  // uses the service module directly to get the imageUrl envelope. Real
  // call gated on Q-MF-2 (OPENAI_API_KEY or STABILITY_API_KEY).
  // Image tasks may be priced separately from text tasks (DALL-E 3 HD is
  // $0.12/image vs Gemini Flash $0.0001/1K tokens) — flagged for future
  // product call to split into its own `image-llm` integration cap so a
  // runaway image-gen burst doesn't silently exhaust the text-LLM
  // budget. Until then both share the 'llm' cap envelope.
  "marketing-flyer-image": { primary: "dall-e-3", fallback: "stability-xl" },
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
  "claude-opus-4-7": "ANTHROPIC_API_KEY",
  "gpt-4": "OPENAI_API_KEY",
  "gemini-flash": "GEMINI_API_KEY",
  "claude-haiku": "ANTHROPIC_API_KEY",
  // S16 — image-gen providers for marketing-flyer-image task class
  // (PRD_TRAVEL_MARKETING_FLYER FR-3.6.3). DALL-E 3 reuses the OpenAI
  // key (same env var as gpt-4); Stability XL needs its own dedicated key.
  "dall-e-3": "OPENAI_API_KEY",
  "stability-xl": "STABILITY_API_KEY",
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

  // Real-mode: when the task's provider key is present in env AND we're not
  // under test, call the REAL provider — so the moment a key lands the output
  // is real with ZERO further code changes (no "swap the stub later" landmine).
  // No key (dev / CI / demo-without-keys) OR NODE_ENV==='test' falls through to
  // the deterministic stub below, keeping unit + e2e runs offline + repeatable.
  // NOTE: llmEnabled is async — it MUST be awaited (an unawaited call returns a
  // truthy Promise, which made routeRequest attempt the real provider even when
  // the model's key was absent → talking-points/etc. 500'd instead of stubbing).
  // Passing tenantId also lets the per-tenant SupplierCredential key resolve.
  if (process.env.NODE_ENV !== "test" && (await llmEnabled(task, tenantId))) {
    try {
      return await realProviderCall({ task, model, payload, tenantId });
    } catch (e) {
      console.error(`[llm-router] real provider call failed (task=${task} model=${model}): ${e.message}`);
      const err = new Error(`LLM provider call failed: ${e.message}`);
      err.code = "LLM_PROVIDER_ERROR";
      throw err;
    }
  }

  // STUB: deterministic synthetic response used when no provider key is set
  // (or under test). Same envelope shape as the real path:
  // { text, finishReason, usage, model, stub }.
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
      // Routed to gemini-flash per PRD §9.1 + FR-3.6 (S14). This stub-text
      // exists only so unrecognised-task callers of routeRequest get a
      // sensible string. The structured-JSON path (daySplit +
      // poiSuggestions + thematicNotes) is produced inline in
      // routes/travel_itineraries.js's FR-3.4 handler, not via this
      // text envelope.
      return `${tag} Itinerary suggestion (synthetic). Real-mode swap pending Q-IT-2 (Gemini key) — see CREDS_TRACKER.`;
    case "marketing-flyer-copy":
      // Routed to gemini-flash per PRD §9.1 + FR-3.6.1 (S15). Detailed
      // copyJson shape (headline + body + cta) is produced by
      // backend/services/marketingFlyerCopyLLM.js — this stub-text exists
      // only so unrecognised-task callers of routeRequest get a sensible
      // string. The structured-JSON path uses the service module directly,
      // not routeRequest's text envelope.
      return `${tag} Marketing flyer copy (synthetic). Real Gemini Flash flyer copy lands when Q-AI-3 / Q11 keys arrive — see backend/services/marketingFlyerCopyLLM.js for the structured-JSON path.`;
    case "marketing-flyer-image":
      // Routed to dall-e-3 primary / stability-xl fallback per PRD §9.1 +
      // FR-3.6.3 (S16). Detailed imageUrl envelope (imageUrl + source +
      // model + stub) is produced by backend/services/marketingFlyerImageLLM.js
      // — this stub-text exists only so unrecognised-task callers of
      // routeRequest get a sensible string. The structured-image path uses
      // the service module directly, not routeRequest's text envelope.
      return `${tag} Marketing flyer image (synthetic placeholder URL). Real DALL-E 3 / Stability XL image lands when Q-MF-2 keys arrive — see backend/services/marketingFlyerImageLLM.js for the structured-image path.`;
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

// ── Real-mode provider calls ─────────────────────────────────────────
//
// Activated by routeRequest when the task's provider key is present (and not
// under test). The REAL provider model id per routing label is env-overridable
// so a model rename is a config change, never a code change (no stale-model
// landmine). Defaults track the current model generation.
const MODEL_ID_ENV = {
  "claude-opus-4-7": ["LLM_MODEL_CLAUDE_OPUS", "claude-opus-4-8"],
  "claude-haiku": ["LLM_MODEL_CLAUDE_HAIKU", "claude-haiku-4-5-20251001"],
  "gpt-4": ["LLM_MODEL_GPT", "gpt-4o"],
  "gemini-flash": ["LLM_MODEL_GEMINI", "gemini-2.5-flash"],
  "perplexity-sonar": ["LLM_MODEL_PERPLEXITY", "sonar"],
};

function resolveRealModelId(label) {
  const entry = MODEL_ID_ENV[label];
  if (!entry) return label;
  const [envVar, dflt] = entry;
  return process.env[envVar] || dflt;
}

function providerForModel(label) {
  if (label.startsWith("claude")) return "anthropic";
  if (label.startsWith("gpt")) return "openai";
  if (label.startsWith("gemini")) return "gemini";
  if (label.startsWith("perplexity") || label === "sonar") return "perplexity";
  return "anthropic";
}

// Build a task-appropriate { system, user } prompt. The payload's __-prefixed
// hint keys (e.g. __userId / __surface) are stripped — only real content is
// sent to the provider.
function buildPrompt(task, payload) {
  const content = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (!String(k).startsWith("__")) content[k] = v;
  }
  const SYS = {
    "talking-points": "You are a senior travel advisor. Given a lead's diagnostic profile, produce concise, actionable talking points for the advisor's next call. Plain text, 3-6 short bullets.",
    "form-vs-call": "You compare a customer's web-form answers against their phone-call answers, summarise the level of match, and flag any mismatches. Plain text.",
    "itinerary-suggest": "You are an expert travel planner pricing a trip for a per-person quote. Given a destination, number of days, budget tier, and traveller interests/pace, return a realistic day-by-day itinerary as STRICT JSON only — no markdown, no text outside the JSON. Shape: {\"summary\":string,\"days\":[{\"dayNumber\":number,\"items\":[{\"itemType\":string,\"description\":string,\"estimatedCost\":number}]}]}. itemType MUST be one of: flight, transfer, hotel, sightseeing, activity, meals, visa, insurance, other. estimatedCost is the typical PER-PERSON cost in INR (Indian Rupees) for that item, using your best knowledge of current average prices for that destination and budget tier — give a realistic positive number; use 0 only when the item is genuinely free. Each day should include a hotel plus at least one sightseeing, one activity, and one meals item; put an arrival flight on day 1 and a departure flight on the final day. Keep each description short and specific to the destination. Return ONLY the JSON object.",
    "trip-countdown": "You write a short, warm, upbeat PRE-TRIP reminder email for a travel customer. Return STRICT JSON only — no markdown, no text outside the JSON. Shape: {\"subject\":string,\"body\":string}. Use AT MOST one emoji in the subject. Mention the destination and the days-to-go. Keep the body under 80 words, friendly and encouraging (e.g. packing/prep tips as the trip nears). You may use the placeholder {name} for the customer's name in the body. Return ONLY the JSON object.",
    "payment-reminder": "You write a short, courteous but clearly URGENT deposit-reminder email for a travel customer whose booking is confirmed but whose 50% deposit is still due before a deadline. Return STRICT JSON only — no markdown, no text outside the JSON. Shape: {\"subject\":string,\"body\":string}. No emoji. State plainly that the deposit must be paid by the deadline to keep the booking, and that the booking is at risk of cancellation otherwise. Mention the destination and the days remaining. Keep the body under 90 words. You may use the placeholder {name} for the customer's name. Return ONLY the JSON object.",
    "bulk-text": "You write clear, customer-facing travel copy. Plain text.",
    "call-summary": "You summarise a sales/advisory call in a few sentences. Plain text.",
    "reasoning": "You are a careful reasoning assistant for a travel CRM. Plain text.",
    "search": "You answer with concise, well-sourced information. Plain text.",
    "citation": "You answer with concise, well-sourced information. Plain text.",
  };
  const system = SYS[task] || SYS.reasoning;
  const user = `Task: ${task}\nContext (JSON):\n${JSON.stringify(content)}`;
  return { system, user };
}

async function httpJson(url, opts, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (body && (body.error?.message || body.error)) || res.statusText || `HTTP ${res.status}`;
      throw new Error(`${res.status} ${msg}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(modelId, system, user, apiKey, maxTokens) {
  const body = await httpJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: modelId, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  const text = (body.content || []).map((c) => c.text || "").join("").trim();
  const u = body.usage || {};
  return { text, tokensIn: u.input_tokens || 0, tokensOut: u.output_tokens || 0 };
}

// OpenAI + Perplexity share the OpenAI chat-completions wire format.
async function callOpenAICompatible(baseUrl, modelId, system, user, apiKey, maxTokens) {
  const body = await httpJson(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  const text = (body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content || "").trim();
  const u = body.usage || {};
  return { text, tokensIn: u.prompt_tokens || 0, tokensOut: u.completion_tokens || 0 };
}

async function callGemini(modelId, system, user, apiKey, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = await httpJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  const parts = (body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || "").join("").trim();
  const m = body.usageMetadata || {};
  return { text, tokensIn: m.promptTokenCount || 0, tokensOut: m.candidatesTokenCount || 0 };
}

async function realProviderCall({ task, model, payload, tenantId }) {
  const provider = providerForModel(model);
  const envVar = ENV_FOR_MODEL[model];
  const apiKey = envVar && process.env[envVar];
  if (!apiKey) throw new Error(`no API key for ${model}`);
  const modelId = resolveRealModelId(model);
  const { system, user } = buildPrompt(task, payload);
  const maxTokens = 4096;

  let out;
  if (provider === "anthropic") out = await callAnthropic(modelId, system, user, apiKey, maxTokens);
  else if (provider === "openai") out = await callOpenAICompatible("https://api.openai.com/v1", modelId, system, user, apiKey, maxTokens);
  else if (provider === "perplexity") out = await callOpenAICompatible("https://api.perplexity.ai", modelId, system, user, apiKey, maxTokens);
  else if (provider === "gemini") out = await callGemini(modelId, system, user, apiKey, maxTokens);
  else throw new Error(`unknown provider for ${model}`);

  const tokensIn = out.tokensIn || estimateTokens(JSON.stringify(payload || {}));
  const tokensOut = out.tokensOut || estimateTokens(out.text);

  // Token-only telemetry — NEVER log payload content (PII discipline).
  console.log(
    `[llm-router] task=${task} model=${model} (${modelId}) tenant=${tenantId || "?"} ` +
    `tokens_in=${tokensIn} tokens_out=${tokensOut} cost_estimate=$0.0000 stub=false reason=real`,
  );

  // Persist one LlmCallLog row (best-effort, fire-and-forget) — mirrors the
  // stub path so the admin spend dashboard counts real calls too.
  try {
    const prisma = require("./prisma");
    prisma.llmCallLog
      .create({
        data: {
          tenantId: tenantId || 1,
          task,
          model,
          reason: "real",
          promptTokens: tokensIn,
          completionTokens: tokensOut,
          totalTokens: tokensIn + tokensOut,
          costEstimate: 0, // real per-token pricing is a follow-up; tokens are real
          stub: false,
          userId: (payload && payload.__userId) || null,
          surface: (payload && payload.__surface) || null,
        },
      })
      .catch((e) => console.error(`[llm-router] LlmCallLog persist failed (non-fatal): ${e.message}`));
  } catch (e) {
    console.error(`[llm-router] LlmCallLog require failed (non-fatal): ${e.message}`);
  }

  return {
    text: out.text || "",
    finishReason: "stop",
    usage: { promptTokens: tokensIn, completionTokens: tokensOut, totalTokens: tokensIn + tokensOut },
    model,
    stub: false,
  };
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
  buildPrompt,
  resolveRealModelId,
  providerForModel,
};
