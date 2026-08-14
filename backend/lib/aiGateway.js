"use strict";

// aiGateway.js — the ONE mandatory entry point for every AI-powered feature
// in the CRM. No route, cron, or service should call a provider SDK/fetch
// directly, and no route/cron/service should call aiCreditLedger.deductUsage
// directly either — everything goes through runAiRequest() (or
// runNonTokenAiRequest() for audio/image work) so:
//
//   1. Access resolution (BYOK vs CRM-managed vs blocked) always happens
//      the same way, via aiProviderManagement.resolveProviderConfig.
//   2. Every call — success or failure — writes exactly one LlmCallLog row.
//      Previously most direct-SDK call sites either hand-rolled their own
//      persistLlmCallLog or logged nothing at all; this collapses that to
//      one implementation.
//   3. Credit deduction happens in exactly one place (deductUsage, only for
//      accessType === "crm-managed", only after a successful response,
//      never estimated, never skipped). BYOK calls never touch the wallet.
//   4. A tenant with no BYOK key and no active/funded CRM subscription gets
//      the friendly blocked-access message (Step 9 of the spec) instead of
//      a raw provider error, consistently everywhere.
//
// Non-chat AI (Whisper audio transcription, DALL-E/gpt-image-1 image
// generation) doesn't have prompt/completion tokens — runNonTokenAiRequest
// wraps the same resolve/gate/log/deduct machinery but takes a $ cost and
// converts it to an equivalent token count via aiCreditLedger.deductCost.

const crypto = require("crypto");
const prisma = require("./prisma");
const aiProviderManagement = require("./aiProviderManagement");
const aiCreditLedger = require("./aiCreditLedger");
const { estimateLlmCost } = require("./apiPricing");
const { isGeminiLimitError } = require("./geminiErrors");

function newRequestId() {
  return crypto.randomUUID();
}

// A provider HTTP call can fail for many reasons; a quota/rate-limit
// response is the one shape worth a distinct, actionable message — the
// tenant (or their own BYOK key) has simply hit a request/spend ceiling,
// not a real integration bug. isGeminiLimitError's pattern is provider-
// agnostic (429 / "quota exceeded" / "rate limit" / "resource exhausted")
// despite the name (originally written for Gemini, reused here for any
// provider). Every other provider failure (auth, malformed request,
// network) passes through unchanged so real bugs stay visible in logs.
//
// BYOK vs CRM-managed get distinct wording because the fix is different:
// a BYOK tenant needs to wait out or upgrade THEIR OWN provider plan; a
// CRM-managed tenant should buy more CRM credits. Access-resolution
// failures (no BYOK + no funded subscription at all) are unrelated — those
// are already handled by assertAccessOrThrow before any provider call
// happens.
function friendlyProviderErrorOrNull(err, accessType) {
  if (!isGeminiLimitError(err)) return null;
  const friendly = new Error(
    accessType === "byok"
      ? "Your AI provider key has hit its usage limit (rate limit or quota exceeded). Please wait a few minutes and try again, or check your provider account's billing/quota settings."
      : "The CRM's shared AI provider is temporarily rate-limited. Please try again in a few minutes.",
  );
  friendly.code = "AI_PROVIDER_RATE_LIMITED";
  friendly.friendly = true;
  friendly.unavailableReason = "RATE_LIMITED";
  friendly.cause = err;
  return friendly;
}

async function persistLlmCallLog(data) {
  try {
    return await prisma.llmCallLog.create({ data });
  } catch (e) {
    console.error(`[aiGateway] LlmCallLog persist failed (non-fatal): ${e.message}`);
    return null;
  }
}

// Friendly-error passthrough: resolveProviderConfig() returning null means
// "no BYOK, no funded CRM subscription" — surface the Step 9 message instead
// of a generic 500. Callers (route handlers) should catch AI_BLOCKED and
// return { error: err.message, code: err.code } with a 402/403, not a 500.
async function assertAccessOrThrow(tenantId, requestedModelLabel) {
  const config = await aiProviderManagement.resolveProviderConfig(tenantId, { requestedModelLabel });
  if (config) return config;
  const state = await aiProviderManagement.getTenantAiState(tenantId);
  const err = new Error(state.friendlyMessage);
  err.code = state.unavailableReason === "CREDITS_EXHAUSTED" ? "AI_CREDITS_EXHAUSTED" : "AI_NOT_CONFIGURED";
  err.friendly = true;
  err.unavailableReason = state.unavailableReason;
  throw err;
}

/**
 * The standard chat-completion path. Every feature that sends a prompt and
 * gets text back (email drafts, deal insights, lead scoring, sentiment,
 * flyer copy, landing-page content, support chat, etc.) should call this
 * instead of touching a provider SDK.
 *
 * @param {number} tenantId
 * @param {string} task            - task label for LlmCallLog, e.g. "deal-insight"
 * @param {string} surface         - caller tag, e.g. "routes/deal_insights.js:generate"
 * @param {{role,content}[]} messages
 * @param {string} [requestedModelLabel] - hint for provider-family selection, e.g. "gemini-flash"
 * @param {number} [userId]
 * @param {object} [tools]         - optional tool-calling definitions, passed through
 * @param {string} [requestId]     - idempotency key; auto-generated if omitted
 * @param {object} [generationConfig] - Gemini-specific passthrough (e.g. {responseMimeType, maxOutputTokens}) for callers that need JSON-mode structured output. Ignored by non-Gemini providers.
 * @returns {Promise<{text, toolCalls, usage, model, provider, accessType, llmCallLogId}>}
 */
async function runAiRequest({
  tenantId,
  task,
  surface,
  messages,
  tools,
  requestedModelLabel = null,
  userId = null,
  requestId = null,
  generationConfig,
  fetchImpl,
}) {
  if (!tenantId) throw new Error("aiGateway.runAiRequest requires tenantId");
  if (!task) throw new Error("aiGateway.runAiRequest requires task");
  const effectiveRequestId = requestId || newRequestId();

  const config = await assertAccessOrThrow(tenantId, requestedModelLabel);

  const baseLog = {
    tenantId,
    task,
    surface: surface || null,
    userId,
    stub: false,
  };

  let response;
  try {
    response = await aiProviderManagement.generateChatCompletion(config, { messages, tools, generationConfig }, fetchImpl);
  } catch (err) {
    await persistLlmCallLog({
      ...baseLog,
      model: config.model || "unknown",
      provider: config.providerId || "unknown",
      reason: config.accessType,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costEstimate: 0,
      status: "failed",
      errorMessage: String(err.message || err).slice(0, 2000),
    });
    // No deduction on failure — the tenant didn't receive a usable response.
    throw friendlyProviderErrorOrNull(err, config.accessType) || err;
  }

  const usage = response.usage || {};
  const promptTokens = Math.round(Number(usage.promptTokens || 0));
  const completionTokens = Math.round(Number(usage.completionTokens || 0));
  const totalTokens = Math.round(Number(usage.totalTokens || promptTokens + completionTokens));
  const resolvedModel = response.model || config.model;
  // Prefer config.providerId (the specific catalog entry — "openai",
  // "groq", "claude", "gemini") over response.provider, which is only the
  // wire-family string ("openai-compatible" covers OpenAI AND Groq AND
  // every other OpenAI-shaped provider — too coarse to tell them apart in
  // LlmCallLog/AiCreditTransaction rows or a caller's `source` label).
  const resolvedProvider = config.providerId || response.provider;
  const costEstimate = estimateLlmCost(resolvedModel, promptTokens, completionTokens);

  const logged = await persistLlmCallLog({
    ...baseLog,
    model: resolvedModel,
    provider: resolvedProvider,
    reason: config.accessType,
    promptTokens,
    completionTokens,
    totalTokens,
    costEstimate,
    status: "success",
  });

  // Deduction happens ONLY here, after a confirmed-successful response,
  // using the ACTUAL usage the provider reported — and only for
  // crm-managed access. BYOK calls never touch the wallet.
  if (config.accessType === "crm-managed") {
    await aiCreditLedger.deductUsage({
      tenantId,
      requestId: effectiveRequestId,
      promptTokens,
      completionTokens,
      totalTokens,
      provider: resolvedProvider,
      model: resolvedModel,
      surface,
      llmCallLogId: logged ? logged.id : null,
    });
  }

  return {
    text: response.text || "",
    toolCalls: response.toolCalls || [],
    usage: { promptTokens, completionTokens, totalTokens },
    model: resolvedModel,
    provider: resolvedProvider,
    accessType: config.accessType,
    llmCallLogId: logged ? logged.id : null,
  };
}

/**
 * Non-chat AI path: audio transcription (Whisper), image generation
 * (DALL-E/gpt-image-1), or any other provider call billed by something
 * other than prompt/completion tokens. Caller does the actual provider
 * call itself (these have wildly different request/response shapes) but
 * MUST go through this function to gate access and record the spend —
 * `runFn` receives the resolved config and must return
 * { result, costUsd, model, provider } on success, or throw on failure.
 *
 * @param {number} tenantId
 * @param {string} task
 * @param {string} surface
 * @param {(config) => Promise<{result, costUsd, model, provider}>} runFn
 * @param {string} [requestedModelLabel]
 */
async function runNonTokenAiRequest({
  tenantId,
  task,
  surface,
  runFn,
  requestedModelLabel = null,
  userId = null,
  requestId = null,
}) {
  if (!tenantId) throw new Error("aiGateway.runNonTokenAiRequest requires tenantId");
  if (!task) throw new Error("aiGateway.runNonTokenAiRequest requires task");
  if (typeof runFn !== "function") throw new Error("aiGateway.runNonTokenAiRequest requires runFn");
  const effectiveRequestId = requestId || newRequestId();

  const config = await assertAccessOrThrow(tenantId, requestedModelLabel);

  const baseLog = {
    tenantId,
    task,
    surface: surface || null,
    userId,
    stub: false,
  };

  let outcome;
  try {
    outcome = await runFn(config);
  } catch (err) {
    await persistLlmCallLog({
      ...baseLog,
      model: config.model || "unknown",
      provider: config.providerId || "unknown",
      reason: config.accessType,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costEstimate: 0,
      status: "failed",
      errorMessage: String(err.message || err).slice(0, 2000),
    });
    throw friendlyProviderErrorOrNull(err, config.accessType) || err;
  }

  const resolvedModel = outcome.model || config.model;
  const resolvedProvider = outcome.provider || config.providerId;
  const costUsd = Number(outcome.costUsd || 0);
  const equivalentTokens = aiCreditLedger.usdCostToEquivalentTokens(costUsd);

  const logged = await persistLlmCallLog({
    ...baseLog,
    model: resolvedModel,
    provider: resolvedProvider,
    reason: config.accessType,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: equivalentTokens,
    costEstimate: costUsd,
    status: "success",
  });

  if (config.accessType === "crm-managed" && costUsd > 0) {
    await aiCreditLedger.deductCost({
      tenantId,
      requestId: effectiveRequestId,
      costUsd,
      provider: resolvedProvider,
      model: resolvedModel,
      surface,
      llmCallLogId: logged ? logged.id : null,
    });
  }

  return {
    result: outcome.result,
    costUsd,
    equivalentTokens,
    model: resolvedModel,
    provider: resolvedProvider,
    accessType: config.accessType,
    llmCallLogId: logged ? logged.id : null,
  };
}

module.exports = {
  runAiRequest,
  runNonTokenAiRequest,
  assertAccessOrThrow,
};
