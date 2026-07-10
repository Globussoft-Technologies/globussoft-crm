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
  search: { primary: "perplexity-sonar", fallback: null },
  citation: { primary: "perplexity-sonar", fallback: null },
  reasoning: { primary: "claude-opus-4-7", fallback: "gpt-4" },
  "talking-points": { primary: "claude-opus-4-7", fallback: "gpt-4" },
  "form-vs-call": { primary: "claude-opus-4-7", fallback: "gpt-4" },
  "bulk-text": { primary: "gemini-flash", fallback: "groq-llama" },
  "call-summary": { primary: "gemini-flash", fallback: null },
  // Itinerary-suggest (PRD_TRAVEL_ITINERARY_UPGRADES FR-3.6 + AI_SURFACES §3
  // table). 2K in / 4K out — larger out than bulk-text because the full
  // itinerary JSON shape (daySplit + poiSuggestions + thematicNotes) lands
  // in one response. Routed to gemini-flash to match PRD §9.1's locked
  // routing table for Travel Stall's bulk-shape Gemini calls. Real call
  // gated on Q-IT-2 / Q11 GEMINI_API_KEY (see CREDS_TRACKER).
  // Cross-provider fallback: Gemini Flash primary, OpenAI (gpt-4 → gpt-4o)
  // fallback. Gemini Flash hits 503 overloads + 429 free-tier quota caps under
  // load; when it errors, routeRequest retries the OpenAI fallback so the
  // operator still gets a REAL AI itinerary instead of the deterministic stub.
  "itinerary-suggest": { primary: "gemini-flash", fallback: "gpt-4" },
  // Trip-countdown nudge (pre-trip daily reminder emails). Short, upbeat,
  // destination-personalised copy (subject + body) keyed to days-to-go.
  // ~0.5K in / 0.5K out — routed to gemini-flash for low-cost bulk-shape
  // calls. Falls back to the deterministic template library in
  // backend/lib/tripCountdownContent.js until Q11 GEMINI_API_KEY lands.
  "trip-countdown": { primary: "gemini-flash", fallback: "groq-llama" },
  // Pay-or-cancel deposit-deadline reminder (2026-06-16). Short, courteous-but-
  // urgent copy (subject + body) keyed to days-until-deadline, telling the
  // customer to pay the 50% deposit before the cut-off. Same shape/cost profile
  // as trip-countdown → gemini-flash; falls back to the deterministic template
  // library in backend/lib/paymentDeadlineContent.js until Q11 keys land.
  "payment-reminder": { primary: "gemini-flash", fallback: "groq-llama" },
  // WhatsApp lead qualification (2026-06-19). Classifies an inbound WhatsApp
  // conversation as a travel/business enquiry vs personal/spam and extracts
  // {isEnquiry, confidence, destination, dates, pax, intent, suggestedSubBrand}
  // so lib/travelWhatsappLeadCapture can auto-create a Travel lead. Small in/out
  // → gemini-flash. Falls back to the deterministic keyword heuristic in
  // lib/travelWhatsappLeadCapture.js whenever the call stubs (no Q11 key / test).
  "whatsapp-lead-qualify": {
    primary: "gemini-flash",
    fallback: "groq-llama",
  },
  // Lead conversation summary (2026-07-07). Turns a batch of new WhatsApp
  // messages into one structured, append-only business summary block stored
  // on Contact.description ("Sync Lead" action). Gemini primary per product
  // ask; OpenAI (gpt-4) as the cross-provider fallback so a Gemini 503/429
  // still yields a REAL summary instead of the deterministic stub. Small
  // in/out (a handful of chat lines in, ~10-line summary out).
  "lead-conversation-summary": { primary: "gemini-flash", fallback: "gpt-4" },
  // Lead full-history narrative summary (2026-07-07). On-demand "Summarize"
  // button on the Contact page — re-reads the ENTIRE linked WhatsApp history
  // and writes ONE flowing narrative (paragraphs, not bullets) covering the
  // whole relationship end-to-end. Replaces Contact.description outright
  // (unlike the incremental "Sync Lead" append-only task above). Same
  // Gemini-primary / OpenAI-fallback routing. Larger in (full thread) / small
  // out (a few paragraphs).
  "lead-narrative-summary": { primary: "gemini-flash", fallback: "gpt-4" },
  // GlobusCRM browser-extension lead capture (2026-07-09) — "Summarize
  // again" button on the Contact page for gmail / whatsapp-extension
  // sourced leads. Unlike lead-narrative-summary (which re-reads raw
  // WhatsAppMessage rows from a live session), extension captures have NO
  // raw message log — each capture already wrote a one-time dated summary
  // block straight into Contact.description (routes/leads_extension_capture.js).
  // This task's INPUT is therefore the alreadysummarized block text itself
  // (however many dated blocks have piled up), and its job is to consolidate
  // them into one flowing narrative — same output shape as
  // lead-narrative-summary so both share one render path, but a distinct
  // prompt since the input is prose, not a raw message array.
  "lead-capture-consolidate": { primary: "gemini-flash", fallback: "gpt-4" },
  // Marketing-flyer-copy (PRD_TRAVEL_MARKETING_FLYER FR-3.6.1 + AC-6.8).
  // 1K in / 1K out — short-form headline + body + CTA JSON. Routed to
  // gemini-flash for low-cost bulk-shape Gemini calls per PRD §9.1.
  // Structured-JSON path lives in backend/services/marketingFlyerCopyLLM.js
  // (S15 — same commit); this scaffold's stub-text path returns a tagged
  // synthetic string for routeRequest text-envelope callers. Real call
  // gated on Q-AI-3 / Q11 GEMINI_API_KEY.
  "marketing-flyer-copy": { primary: "gemini-flash", fallback: "groq-llama" },
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
  // TBO search fallback (PRD_TRAVEL — flight/hotel quote builder). When TBO
  // creds aren't set yet, services/tboClient.js asks a model for current
  // flight/hotel options as strict JSON. 2026-06-23: switched primary to
  // gpt-4o-search (OpenAI's WEB-SEARCH-enabled model — gpt-4o-search-preview)
  // so results are grounded in live web data (real fares/flight numbers/times)
  // instead of the model's stale training memory. This uses the SAME OpenAI key
  // already configured (OPENAI_API_KEY). Plain gpt-4 stays as the fallback (no
  // web access — degraded estimate). The moment TBO_* creds land, tboClient's
  // tier-1 takes priority over this regardless of routing, so no code change is
  // needed for the TBO cutover.
  "flight-search": { primary: "gpt-4o-search", fallback: "gpt-4" },
  "hotel-search": { primary: "gpt-4o-search", fallback: "gpt-4" },
  "transfer-search": { primary: "gpt-4o-search", fallback: "gpt-4" },
  // Airport/city name → IATA code (2026-06-19). Lets flight search accept a
  // free-text place ("Delhi", "Bengaluru") and resolve it server-side before
  // the IATA-speaking TBO/LLM search. 2026-06-23: switched to gpt-4 primary to
  // match the flight-search provider (one configured key powers the whole flow);
  // gemini-flash fallback. The static alias map in lib/airportResolver.js still
  // resolves common cities first, so this only fires for places not in the map.
  "airport-iata": { primary: "gpt-4", fallback: "gemini-flash" },
  // Quote-template line-item generation. Takes a natural-language prompt
  // ("5-night Umrah package from Mumbai, 2 pax") and returns a JSON array
  // of TravelQuoteLine-shaped objects. gemini-flash primary (low-cost,
  // fast); gpt-4 fallback for quota/503 situations.
  "quote-template-generate": { primary: "gemini-flash", fallback: "gpt-4" },
  // Landing-page-generate (PR-B — docs/TRAVEL_LANDING_PAGE_PARITY_GAPS.md).
  // Generates structured LandingPage block JSON for a destination given
  // (destination, durationDays, audience, subBrand). Hard rules: NO
  // pricing values, NO testimonials, NO image URLs, NO discounts, NO
  // ratings. Structured-JSON path lives in
  // backend/services/landingPageGeneratorLLM.js; this scaffold's
  // stub-text path returns a tagged synthetic string for routeRequest
  // text-envelope callers (the canonical consumer uses the service
  // module directly). 2K in / 4K out — full block array lands in one
  // response. Routed to gemini-flash for low-cost bulk-shape JSON
  // generation; falls back to claude-haiku on quota / 404.
  "landing-page-generate": {
    primary: "gemini-flash",
    fallback: "groq-llama",
  },
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
  // OpenAI's web-search-enabled chat model — same OPENAI_API_KEY, but the
  // model itself browses the live web (gpt-4o-search-preview). Used by the
  // flight/hotel/transfer search tasks so estimates are web-grounded.
  "gpt-4o-search": "OPENAI_API_KEY",
  "gemini-flash": "GEMINI_API_KEY",
  "claude-haiku": "ANTHROPIC_API_KEY",
  "groq-llama": "GROQ_API_KEY",
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
    if (
      !prisma.llmCallLog ||
      typeof prisma.llmCallLog.aggregate !== "function"
    ) {
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
    console.error(
      `[llm-router] spend aggregate failed (non-fatal, treating as 0): ${e.message}`,
    );
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
    console.warn(
      `[llm-router] unknown task "${task}" — routing to reasoning fallback`,
    );
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
  if (process.env.NODE_ENV !== "test") {
    // Build the ordered model chain: the task's primary, then its configured
    // fallback (typically a DIFFERENT provider, e.g. Gemini → OpenAI). Keep only
    // candidates whose API key is actually available (per-tenant or env). When
    // the primary errors (Gemini 503 overload / 429 quota), we transparently try
    // the fallback so the operator still gets a real AI result rather than the
    // deterministic stub. Empty chain (no keys) falls through to the stub below.
    const route = TASK_ROUTING[task] || {};
    const chain = [];
    for (const cand of [model, route.fallback]) {
      if (!cand || chain.includes(cand)) continue;
      const k = await module.exports.getLlmKey(tenantId, cand);
      if (k) chain.push(cand);
    }
    if (chain.length) {
      let lastErr;
      for (let i = 0; i < chain.length; i += 1) {
        const m = chain[i];
        try {
          return await realProviderCall({ task, model: m, payload, tenantId });
        } catch (e) {
          lastErr = e;
          console.error(`[llm-router] provider failed (task=${task} model=${m}): ${e.message}`);
          if (i < chain.length - 1) {
            console.warn(`[llm-router] task=${task}: falling back from ${m} to ${chain[i + 1]}`);
          }
        }
      }
      const err = new Error(`LLM provider call failed: ${lastErr ? lastErr.message : "all providers failed"}`);
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
    case "lead-conversation-summary":
      // Stub returns valid JSON matching the real-mode shape so
      // leadConversationSummary.js can parse it in dev/CI without a key.
      return JSON.stringify({
        purpose: "Customer reached out via WhatsApp regarding a travel enquiry (synthetic — real Gemini summary lands when GEMINI_API_KEY is set).",
        highlights: ["Conversation received", "Awaiting AI summarisation (stub mode)"],
        leadStage: "New Enquiry",
      });
    case "lead-narrative-summary":
      return JSON.stringify({
        narrative: "The customer's WhatsApp conversation could not be summarised (synthetic — real Gemini narrative lands when GEMINI_API_KEY is set).",
        leadStage: "New Enquiry",
      });
    case "lead-capture-consolidate":
      return JSON.stringify({
        narrative: "The customer's captured emails/chats could not be consolidated (synthetic — real Gemini narrative lands when GEMINI_API_KEY is set).",
        leadStage: "New Enquiry",
      });
    case "form-vs-call":
      return `${tag} Form-vs-call comparison: 85% match (synthetic). Real Claude comparison lands when Q11 keys arrive.`;
    case "search":
    case "citation":
      return `${tag} Cited search result: "Synthetic citation pending Q11 Perplexity key." (https://example.invalid/q11-stub)`;
    case "bulk-text":
      return `${tag} Bulk text output (synthetic). Real Gemini Flash lands when Q11 keys arrive.`;
    case "flight-search":
      // tboClient treats a stub envelope as "no live data" and falls through to
      // its own canned sample flights, so this text is never parsed as results.
      return `${tag} Flight search (synthetic). Real web-grounded results land when a TBO or Perplexity/Gemini key is set.`;
    case "hotel-search":
      return `${tag} Hotel search (synthetic). Real web-grounded results land when a TBO or Perplexity/Gemini key is set.`;
    case "transfer-search":
      return `${tag} Transfer search (synthetic). Real web-grounded results land when a TBO or Perplexity/Gemini key is set.`;
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
    case "quote-template-generate":
      // Stub returns a valid JSON array so the generate endpoint can parse it.
      // Real Gemini Flash / GPT-4 generation lands when GEMINI_API_KEY is set.
      return JSON.stringify([
        { lineType: "flight", description: "Return flights (Economy)", quantity: 2, unitPrice: 18500, currency: "INR" },
        { lineType: "hotel", description: "Hotel accommodation (3★), 7 nights", quantity: 7, unitPrice: 4500, currency: "INR" },
        { lineType: "transport", description: "Airport transfers (return)", quantity: 1, unitPrice: 3500, currency: "INR" },
        { lineType: "visa", description: "Visa fees per person", quantity: 2, unitPrice: 6000, currency: "INR" },
        { lineType: "service", description: "Travel insurance per person", quantity: 2, unitPrice: 1200, currency: "INR" },
      ]);
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
  // llama-3.3-70b-versatile: best Groq model for multilingual (incl. Indian regional languages)
  "groq-llama": ["LLM_MODEL_GROQ", "llama-3.3-70b-versatile"],
  "gpt-4": ["LLM_MODEL_GPT", "gpt-4o"],
  // Web-search-enabled OpenAI model (browses the live web at query time).
  "gpt-4o-search": ["LLM_MODEL_GPT_SEARCH", "gpt-4o-search-preview"],
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
  if (label.startsWith("groq")) return "groq";
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
    "itinerary-suggest": "You are an expert travel planner pricing a trip for a per-person quote. Given a destination, departure city, number of days, budget tier, and traveller interests/pace, return a realistic day-by-day itinerary as STRICT JSON only — no markdown, no text outside the JSON. Shape: {\"summary\":string,\"days\":[{\"dayNumber\":number,\"items\":[{\"itemType\":string,\"description\":string,\"estimatedCost\":number}]}]}. itemType MUST be one of: flight, transfer, hotel, sightseeing, activity, meals, visa, insurance, other. estimatedCost is the typical PER-PERSON cost in INR (Indian Rupees) — always give a REALISTIC POSITIVE number; use 0 only when genuinely free. CRITICAL FOR FLIGHTS: the context includes a departureCity field (e.g. \"Bangalore\") — use it to describe and price both the Day-1 outbound flight (e.g. \"Flight from Bangalore to Paris\") and the final-day return flight (e.g. \"Return flight Paris to Bangalore\") with a realistic one-way airfare in INR: economy ≈ ₹18,000–₹35,000, mid ≈ ₹35,000–₹65,000, luxury ≈ ₹65,000–₹1,50,000 for international routes; adjust down for short-haul. NEVER set a flight estimatedCost to 0. Each day should also include a hotel, at least one sightseeing, one activity, and one meals item. Keep descriptions short and destination-specific. Return ONLY the JSON object.",
    "trip-countdown": "You write a short, warm, upbeat PRE-TRIP reminder email for a travel customer. Return STRICT JSON only — no markdown, no text outside the JSON. Shape: {\"subject\":string,\"body\":string}. Use AT MOST one emoji in the subject. Mention the destination and the days-to-go. Keep the body under 80 words, friendly and encouraging (e.g. packing/prep tips as the trip nears). You may use the placeholder {name} for the customer's name in the body. Return ONLY the JSON object.",
    "payment-reminder": "You write a short, courteous but clearly URGENT deposit-reminder email for a travel customer whose booking is confirmed but whose 50% deposit is still due before a deadline. Return STRICT JSON only — no markdown, no text outside the JSON. Shape: {\"subject\":string,\"body\":string}. No emoji. State plainly that the deposit must be paid by the deadline to keep the booking, and that the booking is at risk of cancellation otherwise. Mention the destination and the days remaining. Keep the body under 90 words. You may use the placeholder {name} for the customer's name. Return ONLY the JSON object.",
    "airport-iata": "You convert a city or airport name to its airport code. Given a place, reply with ONLY the single primary 3-letter IATA airport code in uppercase — nothing else. If the city has multiple airports, return its main international one. Examples: 'Delhi' → DEL, 'Bengaluru' → BLR, 'Jeddah' → JED, 'New York' → JFK.",
    "flight-search": "You are a flight search assistant for a travel agency. Given an origin, destination, date(s), pax and cabin class, return CURRENT realistic flight options as STRICT JSON only — no markdown, no prose. Shape: {\"options\":[{\"airline\":\"AI\",\"airlineName\":\"Air India\",\"flightNumber\":\"AI-302\",\"from\":\"DEL\",\"to\":\"JED\",\"departAt\":\"2026-08-02T18:10:00\",\"arriveAt\":\"2026-08-02T23:10:00\",\"durationMinutes\":300,\"stops\":0,\"fare\":50000,\"fareClass\":\"Economy\",\"baggage\":\"30kg check-in + 7kg cabin\",\"refundable\":false}]}. `fare` is the per-person fare in the requested currency (a realistic positive number). `from`/`to` are IATA codes. Return 3-6 options across different airlines/times. Return ONLY the JSON object.",
    "hotel-search": "You are a hotel search assistant for a travel agency. Given a city, check-in/check-out dates, rooms, guests and (optional) star rating, return CURRENT realistic hotel options as STRICT JSON only — no markdown, no prose. Shape: {\"hotels\":[{\"name\":\"Hotel Name\",\"starRating\":4,\"address\":\"...\",\"area\":\"City centre\",\"ratePerNight\":6500,\"totalRate\":13000,\"roomType\":\"Deluxe Room\",\"board\":\"Breakfast\",\"refundable\":true}]}. Rates are in the requested currency; totalRate = ratePerNight × nights × rooms. Return 4-8 real hotels for that city. Return ONLY the JSON object.",
    "transfer-search": "You are a ground-transfer assistant for a travel agency. Given a pickup, drop-off, date and pax, return realistic road-transfer options (airport↔hotel or inter-city) as STRICT JSON only — no markdown, no prose. Shape: {\"transfers\":[{\"mode\":\"road\",\"vehicle\":\"Private Sedan\",\"from\":\"...\",\"to\":\"...\",\"durationMinutes\":75,\"price\":2200,\"pax\":2,\"note\":\"Up to 3 pax\"}]}. price is the TOTAL in the requested currency for the vehicle (or per-person for shared coach — say so in note). Return 2-4 options (private + shared). Return ONLY the JSON object.",
    "quote-template-generate": "You are a travel quote builder. Given a natural-language description of a travel package, generate a JSON array of line items. Each item must be a JSON object with: lineType (one of: flight, hotel, transport, transfer, visa, service, other), description (string), quantity (number), unitPrice (number, in the provided currency), currency (3-letter ISO code). Return ONLY a valid JSON array — no markdown, no code fences, no explanation, no text outside the JSON. Example: [{\"lineType\":\"flight\",\"description\":\"Air India DEL-JED (Economy)\",\"quantity\":2,\"unitPrice\":18500,\"currency\":\"INR\"}]",
    "bulk-text": "You write clear, customer-facing travel copy. Plain text.",
    "call-summary":
      "You summarise a sales/advisory call in a few sentences. Plain text.",
    "lead-conversation-summary":
      "You are a travel CRM assistant that writes concise, professional lead-history summaries from WhatsApp conversations — never a transcript, never chatty. Given the customer's name, the conversation date, and a batch of new WhatsApp messages (with direction: inbound = customer, outbound = agent), return STRICT JSON only — no markdown, no text outside the JSON. Shape: {\"purpose\":string,\"highlights\":string[],\"leadStage\":string}. `purpose` is 1-2 sentences on why the customer reached out / what this batch of messages was about. `highlights` is 2-6 short bullet phrases (no leading dash) covering: destination, travel dates, hotels/flights/visa/services requested, important questions raised, and actions the agent took. `leadStage` is your best single assessment of current status, one of: \"New Enquiry\", \"Quotation Pending\", \"Follow-up Required\", \"Documents Awaited\", \"Booking In Progress\", \"Booking Confirmed\", \"Payment Pending\", \"Closed\", \"Not Interested\" — pick the closest match, do not invent new ones unless truly none fit. Base everything ONLY on the messages given; do not invent destinations, dates or names not present. Return ONLY the JSON object.",
    "lead-narrative-summary":
      "You are a travel CRM assistant that writes a professional, business-focused NARRATIVE summary of a lead's entire WhatsApp relationship — flowing paragraphs, never a transcript, never bullet points. Given the customer's name and the FULL WhatsApp message history (with direction: inbound = customer, outbound = agent, and each message's date), return STRICT JSON only — no markdown, no text outside the JSON. Shape: {\"narrative\":string,\"leadStage\":string}. `narrative` should read like a case-file recap written by a colleague: 2-5 short paragraphs in chronological order, each covering one meaningful phase of the conversation (e.g. initial enquiry, a follow-up, a decision point), naming actual dates, destinations, dates of travel, services requested (hotels/flights/visa/etc), and actions the agent took. Do NOT restate every message — synthesize. Write in third person past tense, referring to the customer by name. `leadStage` is your best single current-status assessment, one of: \"New Enquiry\", \"Quotation Pending\", \"Follow-up Required\", \"Documents Awaited\", \"Booking In Progress\", \"Booking Confirmed\", \"Payment Pending\", \"Closed\", \"Not Interested\". Base everything ONLY on the messages given; never invent destinations, dates, or details not present. Return ONLY the JSON object.",
    "landing-page-generate":
      "You generate STRUCTURED travel-destination landing-page block JSON. The canonical consumer (landingPageGeneratorLLM.js) supplies the full prompt — this text-envelope entry is a safety net for routeRequest callers. Return a JSON object with keys suggestedTitle, suggestedSlug, seoMeta {metaTitle, metaDescription}, and blocks (array). NEVER include monetary values, testimonials, ratings, discounts, vendor names, partner names, or image URLs.",
    "lead-capture-consolidate":
      "You are a travel CRM assistant that consolidates a lead's captured email/WhatsApp history into ONE flowing narrative — flowing paragraphs, never a transcript, never bullet points. The input is NOT raw messages — it is a series of ALREADY-SUMMARIZED dated blocks (each with a Customer/Date/Purpose/Discussion Highlights/Lead Stage section) that were written one at a time as separate captures over time; your job is to read all of them and merge them into one coherent case-file recap. Given the customer's name and the full block text, return STRICT JSON only — no markdown, no text outside the JSON. Shape: {\"narrative\":string,\"leadStage\":string}. `narrative` should be 2-5 short paragraphs in chronological order, each covering one meaningful phase (initial contact, a follow-up, a decision point), naming actual dates, destinations, services requested, and outcomes — do NOT restate every block verbatim, synthesize across all of them. Write in third person past tense, referring to the customer by name. `leadStage` is your best single current-status assessment from the LATEST block's stage, one of: \"New Enquiry\", \"Quotation Pending\", \"Follow-up Required\", \"Documents Awaited\", \"Booking In Progress\", \"Booking Confirmed\", \"Payment Pending\", \"Closed\", \"Not Interested\". Base everything ONLY on the text given; never invent details not present. Return ONLY the JSON object.",
    reasoning:
      "You are a careful reasoning assistant for a travel CRM. Plain text.",
    search: "You answer with concise, well-sourced information. Plain text.",
    citation: "You answer with concise, well-sourced information. Plain text.",
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
      const msg =
        (body && (body.error?.message || body.error)) ||
        res.statusText ||
        `HTTP ${res.status}`;
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
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const text = (body.content || [])
    .map((c) => c.text || "")
    .join("")
    .trim();
  const u = body.usage || {};
  return {
    text,
    tokensIn: u.input_tokens || 0,
    tokensOut: u.output_tokens || 0,
  };
}

// OpenAI + Perplexity share the OpenAI chat-completions wire format.
async function callOpenAICompatible(
  baseUrl,
  modelId,
  system,
  user,
  apiKey,
  maxTokens,
) {
  const body = await httpJson(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  const text = (
    (body.choices &&
      body.choices[0] &&
      body.choices[0].message &&
      body.choices[0].message.content) ||
    ""
  ).trim();
  const u = body.usage || {};
  return {
    text,
    tokensIn: u.prompt_tokens || 0,
    tokensOut: u.completion_tokens || 0,
  };
}

// A single generateContent call against one Gemini model. Throws on non-2xx
// (httpJson surfaces "<status> <message>").
async function callGeminiOnce(modelId, system, user, apiKey, maxTokens) {
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
  const parts =
    (body.candidates &&
      body.candidates[0] &&
      body.candidates[0].content &&
      body.candidates[0].content.parts) ||
    [];
  const text = parts
    .map((p) => p.text || "")
    .join("")
    .trim();
  const m = body.usageMetadata || {};
  return {
    text,
    tokensIn: m.promptTokenCount || 0,
    tokensOut: m.candidatesTokenCount || 0,
  };
}

// Transient Gemini errors worth retrying / failing over to a lighter model:
// 429 quota spikes, 500/502/503 overloads. Permanent errors (400/401/403/404)
// fall through and throw immediately so we don't waste attempts.
const GEMINI_TRANSIENT_RE = /\b(429|500|502|503)\b|unavailable|overload|high demand|resource[_ ]exhausted|try again/i;

// Resolve the primary model + a fallback chain. When the primary model is
// overloaded (503) or quota-capped (429) — which Gemini Flash hits often under
// load — we automatically try a lighter sibling so the operator still gets a
// REAL AI itinerary instead of the deterministic skeleton. Env-overridable via
// LLM_GEMINI_FALLBACK_MODELS (comma-separated).
function geminiModelChain(primaryId) {
  const raw = process.env.LLM_GEMINI_FALLBACK_MODELS;
  const fallbacks = raw && raw.trim()
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["gemini-2.5-flash-lite", "gemini-2.0-flash"];
  return [primaryId, ...fallbacks].filter((m, i, a) => m && a.indexOf(m) === i);
}

async function callGemini(modelId, system, user, apiKey, maxTokens) {
  const chain = geminiModelChain(modelId);
  const attemptsPerModel = 2;
  let lastErr;
  for (const m of chain) {
    for (let attempt = 1; attempt <= attemptsPerModel; attempt += 1) {
      try {
        const out = await callGeminiOnce(m, system, user, apiKey, maxTokens);
        if (m !== modelId) {
          console.warn(`[llm-router] gemini: '${modelId}' unavailable, succeeded on fallback '${m}'`);
        }
        return out;
      } catch (e) {
        lastErr = e;
        const msg = String(e && e.message);
        // Permanent error (bad key, bad request, model not found) → stop now.
        if (!GEMINI_TRANSIENT_RE.test(msg)) throw e;
        // A 429 quota error won't clear in a few hundred ms (Google asks for a
        // ~40s wait) — don't burn a same-model retry; jump to the next model,
        // which may have its own quota. Only 5xx overloads get a same-model retry.
        const isQuota = /\b429\b|quota|resource[_ ]exhausted/i.test(msg);
        if (isQuota) break;
        if (attempt < attemptsPerModel) {
          await new Promise((r) => setTimeout(r, 600 * attempt));
        }
      }
    }
    console.warn(`[llm-router] gemini: '${m}' still failing after ${attemptsPerModel} attempts — trying next model`);
  }
  throw lastErr || new Error("gemini call failed");
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
  else if (provider === "openai") {
    // gpt-4o-search-preview browses the live web when web_search_options is set;
    // regular gpt-4o has no web access, so only enable it for the search model.
    const extra = /search/.test(modelId) ? { web_search_options: {} } : {};
    out = await callOpenAICompatible("https://api.openai.com/v1", modelId, system, user, apiKey, maxTokens, extra);
  }
  else if (provider === "perplexity") out = await callOpenAICompatible("https://api.perplexity.ai", modelId, system, user, apiKey, maxTokens);
  else if (provider === "gemini") out = await callGemini(modelId, system, user, apiKey, maxTokens);
  else if (provider === "groq") out = await callOpenAICompatible("https://api.groq.com/openai/v1", modelId, system, user, apiKey, maxTokens);
  else throw new Error(`unknown provider for ${model}`);

  const tokensIn =
    out.tokensIn || estimateTokens(JSON.stringify(payload || {}));
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
      .catch((e) =>
        console.error(
          `[llm-router] LlmCallLog persist failed (non-fatal): ${e.message}`,
        ),
      );
  } catch (e) {
    console.error(
      `[llm-router] LlmCallLog require failed (non-fatal): ${e.message}`,
    );
  }

  return {
    text: out.text || "",
    finishReason: "stop",
    usage: {
      promptTokens: tokensIn,
      completionTokens: tokensOut,
      totalTokens: tokensIn + tokensOut,
    },
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
