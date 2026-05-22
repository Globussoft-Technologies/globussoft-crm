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
// break on the cutover. SupplierCredential resolution (DB lookup)
// lands with the real-mode swap; this scaffold only checks ENV
// so llmEnabled() stays synchronous (callable from health checks).
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

function llmEnabled(task) {
  // Check whether the provider for `task` has a real API key in ENV.
  // Per PRD §9.1 keys also land under SupplierCredential — that DB
  // lookup is intentionally NOT done here so llmEnabled() stays
  // synchronous (callable from /api/health and other sync paths).
  // SupplierCredential resolution lands with the real-mode swap.
  const route = TASK_ROUTING[task];
  if (!route) return false;
  const envVar = ENV_FOR_MODEL[route.primary];
  return Boolean(envVar && process.env[envVar]);
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
  llmEnabled,
  pickModel,
  routeRequest,
  // Exported for unit-test introspection only — not part of the
  // consumer-facing contract.
  buildStubText,
  estimateTokens,
};
