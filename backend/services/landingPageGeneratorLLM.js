/**
 * landingPageGeneratorLLM.js — orchestrator for the
 * landing-page-generate task.
 *
 * Glue between:
 *   - services/landingPagePrompts.js   (system + user prompt)
 *   - lib/llmRouter.js                 (Gemini key resolution, spend log)
 *   - lib/landingPageGuard.js          (3-layer output validation)
 *
 * Surfaces ONE function:
 *
 *   generateLandingPageContent({
 *     tenantId, destination, durationDays, audience, subBrand
 *   }) → {
 *     blocks: Array<object>,
 *     suggestedSlug: string,
 *     suggestedTitle: string,
 *     seoMeta: { metaTitle, metaDescription },
 *     source: 'gemini' | 'stub',
 *     model: string,
 *     stub: boolean,
 *     verdict: 'passed' | 'scrubbed' | 'fallback',
 *     guardrailIssues: string[],
 *     realModeError?: string,
 *   }
 *
 * Mirror of backend/services/marketingFlyerCopyLLM.js for the LLM call +
 * self-mocking seam, plus the structured-JSON safety net from
 * lib/landingPageGuard.js.
 *
 * Budget cap: tenant's 'llm' monthly cap (LlmCallLog → computeMonthlySpendCents).
 * Stub fallback: returns guard.buildDeterministicFallback(input) — same
 * shape contract as a real-mode success.
 */

'use strict';

if (process.env.NODE_ENV !== 'test') {
  const _path = require('path');
  require('dotenv').config({ path: _path.resolve(__dirname, '..', '.env'), override: false });
}

const { getBudgetCap, evaluateCap, KEYS } = require('../lib/tenantSettings');
const { buildDestinationLandingPagePrompt } = require('./landingPagePrompts');
const { guardLandingPageOutput, buildDeterministicFallback } = require('../lib/landingPageGuard');
const { estimateLlmCost } = require('../lib/apiPricing');

void KEYS;

const INTEGRATION = 'llm';
const TASK_NAME = 'landing-page-generate';
const MODEL_PRIMARY = 'gemini-2.5-flash';
const MODEL_PRIMARY_FALLBACK = 'gemini-2.0-flash';
const GEMINI_KEY_ENV = 'GEMINI_API_KEY';
// Cross-provider fallback. When the entire Gemini cascade fails (every
// model returns 503 / 429 / model-gone) we try OpenAI before bailing to
// the deterministic stub — Gemini's transient 503 / quota windows
// shouldn't drop demos and UAT to the [REVIEW] stub when the operator
// has paid OpenAI credit ready to spend. JSON-mode keeps the response
// shape compatible with the guardrail.
const MODEL_OPENAI_FALLBACK = 'gpt-4o-mini';
const OPENAI_KEY_ENV = 'OPENAI_API_KEY';
// Groq promoted to PRIMARY (2026-06-23) — Llama-3.3-70B JSON-mode is
// notably faster + cheaper than Gemini Flash for the long-context
// landing-page schema, and Groq's JSON-mode is more reliable than
// Gemini's transient 503 / 429 windows during demos. Cascade is now
// Groq → Gemini → OpenAI → deterministic stub. Empty GROQ_API_KEY
// skips Groq cleanly (env-key probe), so existing tenants without
// a Groq key keep working through Gemini.
const MODEL_GROQ_PRIMARY = 'llama-3.3-70b-versatile';
const GROQ_KEY_ENV = 'GROQ_API_KEY';

/**
 * Pre-call budget cap. Mirrors marketingFlyerCopyLLM pattern — calls
 * computeMonthlySpendCents via module.exports indirection so vitest spies
 * intercept (CJS self-mocking seam — cron-learning 2026-05-24).
 *
 * Throws Error w/ code 'LANDING_PAGE_GENERATE_BUDGET_EXCEEDED' on cap hit.
 */
async function checkBudgetCap(tenantId) {
  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly LLM spend cap reached for this tenant.');
    err.code = 'LANDING_PAGE_GENERATE_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(
      `[landingPageGeneratorLLM] tenant ${tenantId} at ${Math.round(
        evaluation.percent * 100,
      )}% of monthly LLM cap ($${(spentCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)})`,
    );
  }
  return evaluation;
}

/**
 * Sum month-to-date LLM spend in cents. Delegates to the same source-of-
 * truth helper that the LLM router uses so multi-task spending is
 * counted once.
 */
async function computeMonthlySpendCents(tenantId) {
  const llmRouter = require('../lib/llmRouter');
  return llmRouter.computeMonthlySpendCents(tenantId);
}

/**
 * Whether the real Gemini call should fire. Wraps the key probe so
 * vitest can mock it without setting the env directly.
 */
async function realModeEnabled(tenantId) {
  const llmRouter = require('../lib/llmRouter');
  const key = await llmRouter.getLlmKey(tenantId, 'gemini-flash');
  return Boolean(key);
}

/**
 * Defensive JSON parser — strips markdown fences, BOMs, and surrounding
 * prose so JSON.parse() succeeds even when Gemini ignores
 * `responseMimeType: 'application/json'`.
 *
 * Mirrors the helper in marketingFlyerCopyLLM.js / itinerarySuggestLLM.js.
 */
function parseGeminiJson(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error(`Gemini returned empty / non-string response (type=${typeof raw})`);
  }
  let cleaned = raw.trim();
  if (cleaned.charCodeAt(0) === 0xFEFF) cleaned = cleaned.slice(1);
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  if (!cleaned.startsWith('{')) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const preview = raw.length > 240 ? `${raw.slice(0, 240)}…(+${raw.length - 240} more chars)` : raw;
    throw new Error(`Gemini JSON parse failed: ${e.message}. Raw response: ${preview}`);
  }
}

/**
 * Single Gemini attempt against the supplied model name. Multi-model
 * cascade lives in the caller. Pure — no retries here.
 *
 * maxOutputTokens was bumped to 8192 in PR-C — the richer 9-block prompt
 * (added safetyFeatures + contactFooter + expanded FAQ + longer city
 * bodies + longer highlight bodies) produces significantly more tokens
 * than the 7-block PR-B version. 4096 truncated mid-JSON on several
 * destinations during the quality-validation sweep.
 */
async function callGeminiAttempt({ apiKey, modelName, prompt }, _usageOut) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const ai = new GoogleGenerativeAI(apiKey);
  const model = ai.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      maxOutputTokens: 8192,
    },
  });
  // Pass system as the first part of the user message so the structured-
  // output enforcement (responseMimeType) applies to the entire request.
  // Gemini's systemInstruction is supported via separate field, but
  // putting both in a single user turn produces more reliable JSON in
  // testing.
  const fullPrompt = `${prompt.system}\n\n${prompt.user}`;
  const res = await model.generateContent(fullPrompt);
  const text = res?.response?.text?.();
  // Optional out-parameter — callers that want real token usage (for
  // LlmCallLog cost estimation) pass a plain object here; we mutate it
  // in place so callGeminiAttempt's return contract (a bare string) stays
  // unchanged for existing callers (callGeminiForTee et al).
  if (_usageOut && typeof _usageOut === 'object') {
    const usage = (res && res.response && res.response.usageMetadata) || {};
    _usageOut.promptTokens = usage.promptTokenCount || 0;
    _usageOut.completionTokens = usage.candidatesTokenCount || 0;
  }
  if (!text) throw new Error('Gemini returned an empty response');
  return text;
}

/**
 * Real-mode Gemini call with quota / model-gone cascade.
 *
 * Cascade order matches marketingFlyerCopyLLM:
 *   gemini-2.5-flash → gemini-2.0-flash → gemini-2.0-flash-lite → gemini-2.5-flash-lite
 *
 * Returns { rawJson, modelUsed } when ANY cascade step succeeds.
 * Throws on full-cascade exhaustion — the caller decides whether to
 * fall through to OpenAI or to the deterministic stub.
 */
async function callGemini({ destination, durationDays, audience, subBrand, tenantId }) {
  const llmRouter = require('../lib/llmRouter');
  const apiKey = await llmRouter.getLlmKey(tenantId, 'gemini-flash');
  if (!apiKey) {
    throw new Error(`landingPageGeneratorLLM: ${GEMINI_KEY_ENV} not set`);
  }
  const prompt = buildDestinationLandingPagePrompt({ destination, durationDays, audience, subBrand });

  const cascade = Array.from(new Set([
    process.env.LLM_MODEL_GEMINI || MODEL_PRIMARY,
    process.env.LLM_MODEL_GEMINI_FALLBACK || MODEL_PRIMARY_FALLBACK,
    'gemini-2.0-flash-lite',
    'gemini-2.5-flash-lite',
  ]));

  let raw;
  let modelUsed;
  let lastError;
  const usageOut = {};
  for (const modelName of cascade) {
    try {
      raw = await callGeminiAttempt({ apiKey, modelName, prompt }, usageOut);
      modelUsed = modelName;
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      const msg = e.message || '';
      const isQuota = /429|Too Many Requests|exceeded.*quota|Quota exceeded/i.test(msg);
      const isModelGone = /404.*Not Found|is not found for API version|is not supported for generateContent/i.test(msg);
      // 503 (Service Unavailable / high demand) is a transient capacity
      // signal — fall through to the next model rather than failing the
      // whole generation. Each Gemini model has its own capacity pool,
      // so the next model in the cascade usually serves cleanly.
      const isTransient = /503|Service Unavailable|high demand|currently unavailable/i.test(msg);
      if (!isQuota && !isModelGone && !isTransient) throw e;
      const reason = isQuota ? 'hit quota' : isModelGone ? 'model unavailable' : 'transient 503';
      console.warn(
        `[landingPageGeneratorLLM] '${modelName}' ${reason} — falling through cascade`,
      );
    }
  }
  if (raw === undefined) throw lastError;

  return {
    rawJson: parseGeminiJson(raw),
    modelUsed,
    promptTokens: usageOut.promptTokens || 0,
    completionTokens: usageOut.completionTokens || 0,
  };
}

/**
 * Cross-provider OpenAI fallback. Fires when the entire Gemini cascade
 * fails (quota / 503 / model-gone). Uses chat/completions with JSON-mode
 * so the response_format guarantees a parseable JSON object — same
 * guardrail downstream.
 *
 * Returns { rawJson, modelUsed }. Throws on auth / network / quota failure.
 *
 * Model defaults to gpt-4o-mini (cheap + fast + reliable JSON-mode).
 * Override via env LLM_MODEL_OPENAI_LANDING for cost/quality tuning.
 */
async function callOpenAI({ destination, durationDays, audience, subBrand }) {
  const apiKey = process.env[OPENAI_KEY_ENV];
  if (!apiKey) {
    throw new Error(`landingPageGeneratorLLM: ${OPENAI_KEY_ENV} not set`);
  }
  const modelName = process.env.LLM_MODEL_OPENAI_LANDING || MODEL_OPENAI_FALLBACK;
  const prompt = buildDestinationLandingPagePrompt({ destination, durationDays, audience, subBrand });

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      // JSON-mode: forces a single valid JSON object — eliminates the
      // markdown-fence / surrounding-prose edge cases the Gemini path
      // handles via parseGeminiJson.
      response_format: { type: 'json_object' },
      max_tokens: 8192,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${errBody.slice(0, 240)}`);
  }
  const body = await res.json();
  const raw = body?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('OpenAI returned an empty response');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const preview = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
    throw new Error(`OpenAI JSON parse failed: ${e.message}. Raw: ${preview}`);
  }
  return { rawJson: parsed, modelUsed: modelName };
}

/**
 * Whether the OpenAI cross-provider fallback is configured. ENV-only —
 * OpenAI keys live in process.env (not per-tenant SupplierCredential)
 * because the fallback is shared infrastructure, not customer-billable.
 *
 * Disabled under NODE_ENV=test by default so unit suites stay offline
 * and deterministic; the OpenAI-fallback-path tests in
 * landingPageGeneratorLLM.test.js use vi.spyOn(...).mockReturnValue(true)
 * to opt in for that specific branch.
 */
function openAiFallbackEnabled() {
  if (process.env.NODE_ENV === 'test') return false;
  return Boolean(process.env[OPENAI_KEY_ENV]);
}

/**
 * Groq primary path. Calls Groq's OpenAI-compatible chat-completions API
 * (https://api.groq.com/openai/v1) in JSON-mode so the response_format
 * guarantees a parseable JSON object — same guardrail downstream as the
 * Gemini and OpenAI paths.
 *
 * Model defaults to GROQ_MODEL env (or llama-3.3-70b-versatile if unset)
 * — runs sub-second on Groq's hardware, so the demo / UAT experience is
 * significantly snappier than the Gemini cascade.
 *
 * Returns { rawJson, modelUsed }. Throws on auth / network / quota failure
 * so the caller can fall through to Gemini → OpenAI → stub.
 */
async function callGroq({ destination, durationDays, audience, subBrand }) {
  const apiKey = process.env[GROQ_KEY_ENV];
  if (!apiKey) {
    throw new Error(`landingPageGeneratorLLM: ${GROQ_KEY_ENV} not set`);
  }
  const modelName = process.env.GROQ_MODEL || MODEL_GROQ_PRIMARY;
  const prompt = buildDestinationLandingPagePrompt({ destination, durationDays, audience, subBrand });

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      response_format: { type: 'json_object' },
      max_tokens: 8192,
      // Llama 3.3-70B is happiest with a touch more creativity for
      // marketing-copy tasks while staying inside the JSON envelope.
      temperature: 0.6,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${errBody.slice(0, 240)}`);
  }
  const body = await res.json();
  const raw = body?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Groq returned an empty response');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const preview = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
    throw new Error(`Groq JSON parse failed: ${e.message}. Raw: ${preview}`);
  }
  return { rawJson: parsed, modelUsed: modelName };
}

/**
 * Whether the Groq primary path is configured. ENV-only — same shared-
 * infrastructure model as OpenAI. Disabled under NODE_ENV=test so the
 * existing unit-test mocks don't have to rewire for the new path.
 */
function groqEnabled() {
  if (process.env.NODE_ENV === 'test') return false;
  return Boolean(process.env[GROQ_KEY_ENV]);
}

/**
 * Persist one LlmCallLog row best-effort. Mirrors the lib/llmRouter
 * pattern so the admin spend dashboard sees this task class. When the
 * caller has real Gemini usageMetadata (promptTokens/completionTokens
 * params), those are used for accurate cost estimation; otherwise falls
 * back to the pre-existing string-length heuristic (Groq/OpenAI paths,
 * or Gemini responses that omitted usageMetadata).
 */
function persistCallLog({
  tenantId, stub, realModeError, inputSize, outputSize, model, userId, surface,
  provider, status, errorMessage, promptTokens, completionTokens,
}) {
  try {
    const prisma = require('../lib/prisma');
    const finalPromptTokens = typeof promptTokens === 'number' ? promptTokens : Math.ceil(inputSize / 4);
    const finalCompletionTokens = typeof completionTokens === 'number' ? completionTokens : Math.ceil(outputSize / 4);
    prisma.llmCallLog
      .create({
        data: {
          tenantId: tenantId || 1,
          task: TASK_NAME,
          model,
          provider: provider || 'gemini',
          reason: stub ? 'stub' : 'real',
          promptTokens: finalPromptTokens,
          completionTokens: finalCompletionTokens,
          totalTokens: finalPromptTokens + finalCompletionTokens,
          costEstimate: estimateLlmCost(model, finalPromptTokens, finalCompletionTokens),
          stub,
          userId: userId || null,
          surface: surface || null,
          status: status || (realModeError && !stub ? 'failed' : 'success'),
          errorMessage: errorMessage || null,
        },
      })
      .catch((e) => console.error(`[landingPageGeneratorLLM] LlmCallLog persist failed (non-fatal): ${e.message}`));
  } catch (e) {
    console.error(`[landingPageGeneratorLLM] LlmCallLog require failed (non-fatal): ${e.message}`);
  }
  if (realModeError) {
    console.warn(`[landingPageGeneratorLLM] real-mode call failed (stub returned): ${realModeError}`);
  }
}

/**
 * Primary surface. See module header for the full envelope shape.
 *
 * @param {Object} args
 * @param {number|string} args.tenantId       — required (budget cap scope)
 * @param {string} args.destination           — required, ≤80 chars
 * @param {number} args.durationDays          — required, 1..60
 * @param {string} [args.audience]            — free-text traveller profile
 * @param {string|null} [args.subBrand]       — 'tmc' | 'rfu' | 'travelstall' | 'visasure' | null
 * @param {number} [args.__userId]            — caller hint for LlmCallLog
 * @param {string} [args.__surface]           — caller hint for LlmCallLog
 */
async function generateLandingPageContent(args = {}) {
  const { tenantId, destination, durationDays, audience, subBrand, __userId, __surface } = args;

  if (!tenantId) throw new Error('tenantId required');
  if (!destination || typeof destination !== 'string' || !destination.trim()) {
    throw new Error('destination required');
  }
  if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 60) {
    throw new Error('durationDays must be an integer between 1 and 60');
  }

  // Pre-call budget cap (via self-mocking seam).
  await module.exports.checkBudgetCap(tenantId);

  const input = { destination, durationDays, audience, subBrand };
  const inputSize = JSON.stringify(input).length;

  // Real-mode dispatch — cascade is Groq → Gemini → OpenAI → stub.
  // Groq (Llama-3.3-70B JSON-mode) is the new PRIMARY (2026-06-23):
  // faster, cheaper, and free of Gemini's transient 503/429 windows
  // that dropped UAT demos to the [REVIEW] stub. Skipped cleanly when
  // GROQ_API_KEY is unset. The guardrail (Layer 3) wraps ALL providers
  // so callers see one consistent shape regardless of which path served.
  let realModeError = null;
  let groqError = null;
  let geminiError = null;
  if (module.exports.groqEnabled()) {
    try {
      const { rawJson, modelUsed } = await module.exports.callGroq(input);
      const guardResult = guardLandingPageOutput(rawJson, input);
      const outputSize = JSON.stringify(guardResult.output).length;
      persistCallLog({
        tenantId,
        stub: false,
        realModeError: null,
        inputSize,
        outputSize,
        model: modelUsed,
        userId: __userId,
        surface: __surface,
      });
      return {
        ...guardResult.output,
        source: 'groq',
        model: modelUsed,
        stub: false,
        verdict: guardResult.verdict,
        guardrailIssues: guardResult.issues,
      };
    } catch (e) {
      groqError = e.message || String(e);
      console.error(
        `[landingPageGeneratorLLM] Groq primary failed (falling through to Gemini): ${groqError}`,
      );
    }
  }

  if (await module.exports.realModeEnabled(tenantId)) {
    try {
      const { rawJson, modelUsed, promptTokens, completionTokens } = await module.exports.callGemini({ ...input, tenantId });
      const guardResult = guardLandingPageOutput(rawJson, input);
      const outputSize = JSON.stringify(guardResult.output).length;
      persistCallLog({
        tenantId,
        stub: false,
        realModeError: null,
        inputSize,
        outputSize,
        model: modelUsed || MODEL_PRIMARY,
        userId: __userId,
        surface: __surface,
        provider: 'gemini',
        status: 'success',
        promptTokens,
        completionTokens,
      });
      return {
        ...guardResult.output,
        source: 'gemini',
        model: modelUsed || MODEL_PRIMARY,
        stub: false,
        verdict: guardResult.verdict,
        guardrailIssues: guardResult.issues,
      };
    } catch (e) {
      geminiError = e.message || String(e);
      persistCallLog({
        tenantId,
        stub: false,
        realModeError: null,
        inputSize,
        outputSize: 0,
        model: MODEL_PRIMARY,
        userId: __userId,
        surface: __surface,
        provider: 'gemini',
        status: 'failed',
        errorMessage: geminiError,
        promptTokens: 0,
        completionTokens: 0,
      });
      console.error(
        `[landingPageGeneratorLLM] Gemini cascade exhausted: ${geminiError}`,
        e.stack ? `\n${e.stack}` : '',
      );
    }
  }

  // OpenAI cross-provider fallback. Fires when Gemini was unavailable
  // OR exhausted — covers the "Gemini 503 + 429 storm" case from the
  // 2026-06-22 UAT report. Keeps real-mode output instead of dropping
  // to [REVIEW] stubs when the operator has OpenAI credit available.
  if (module.exports.openAiFallbackEnabled()) {
    try {
      const { rawJson, modelUsed } = await module.exports.callOpenAI(input);
      const guardResult = guardLandingPageOutput(rawJson, input);
      const outputSize = JSON.stringify(guardResult.output).length;
      persistCallLog({
        tenantId,
        stub: false,
        realModeError: geminiError,
        inputSize,
        outputSize,
        model: modelUsed,
        userId: __userId,
        surface: __surface,
      });
      return {
        ...guardResult.output,
        source: 'openai',
        model: modelUsed,
        stub: false,
        verdict: guardResult.verdict,
        guardrailIssues: guardResult.issues,
        // Surface the upstream Gemini failure so the operator can see
        // why the fallback fired (or null when Gemini was simply absent).
        realModeError: geminiError,
      };
    } catch (e) {
      realModeError = `Groq: ${groqError || 'n/a'}; Gemini: ${geminiError || 'n/a'}; OpenAI: ${e.message || String(e)}`;
      console.error(
        `[landingPageGeneratorLLM] OpenAI fallback also failed (dropping to stub): ${e.message || e}`,
        e.stack ? `\n${e.stack}` : '',
      );
    }
  } else {
    // No OpenAI key configured — surface the upstream failures (Groq +
    // Gemini, whichever fired) so the operator can see why we landed in
    // the stub.
    realModeError = [groqError && `Groq: ${groqError}`, geminiError && `Gemini: ${geminiError}`]
      .filter(Boolean)
      .join('; ') || null;
  }

  // Stub mode — deterministic fallback. Same shape as a real-mode return
  // so callers (route + frontend) don't branch on `source`.
  const fallback = buildDeterministicFallback(input);
  const outputSize = JSON.stringify(fallback).length;
  persistCallLog({
    tenantId,
    stub: true,
    realModeError,
    inputSize,
    outputSize,
    model: MODEL_PRIMARY,
    userId: __userId,
    surface: __surface,
  });
  return {
    ...fallback,
    source: 'stub',
    model: MODEL_PRIMARY,
    stub: true,
    verdict: 'fallback',
    guardrailIssues: [],
    realModeError,
  };
}

// ═══════════════════════════════════════════════════════════════════
// PR-E Phase 2.2 — TEE-aware generation flow
// ═══════════════════════════════════════════════════════════════════
// Architectural invariant: TEE is the AUTHORITATIVE source of family,
// themeId, visualMood, composition, imageStrategy. The LLM consumes
// these as INPUTS and writes content within them. The LLM never picks
// the family/theme/etc; if its output declared a different family,
// the bridge rejects it.

const REGISTRY_BY_FAMILY = {
  educational: 'educational-trip-v1',
  religious: 'religious-tour-v1',
  family: 'family-trip-v1',
  luxury: 'luxury-tour-v1',
};

async function callGeminiForTee({ system, user, apiKey, modelName }) {
  // The existing callGeminiAttempt expects a single combined prompt.
  // For TEE we concatenate system + user with a separator.
  const combined = `${system}\n\n──────────────────────────\nUSER REQUEST:\n${user}`;
  return callGeminiAttempt({ apiKey, modelName, prompt: combined });
}

async function callGeminiTeeCascade({ system, user, tenantId }) {
  let apiKey = process.env[GEMINI_KEY_ENV];
  try {
    const { getLlmKey } = require('../lib/llmRouter');
    if (typeof getLlmKey === 'function') {
      apiKey = (await getLlmKey(tenantId, MODEL_PRIMARY)) || apiKey;
    }
  } catch (_e) { /* not available; use env */ }
  if (!apiKey) {
    throw new Error('Gemini API key missing');
  }
  const models = [MODEL_PRIMARY, MODEL_PRIMARY_FALLBACK];
  let lastErr;
  for (const modelName of models) {
    try {
      const { rawJson } = await callGeminiForTee({ system, user, apiKey, modelName });
      return { rawJson, modelUsed: modelName };
    } catch (e) {
      lastErr = e;
      console.warn(`[landingPageGeneratorLLM-TEE] Gemini model=${modelName} failed: ${e && e.message}`);
    }
  }
  throw lastErr || new Error('Gemini TEE cascade exhausted');
}

/**
 * generateLandingPageContentWithTee(input, options)
 *
 * Primary Phase-2 entrypoint. Pipeline:
 *
 *   1. TEE classify     — produce { family, themeId, visualMood, composition, imageStrategy }
 *   2. teePrompts.buildTeeContentPrompt with TEE output as inputs
 *   3. LLM call (Gemini cascade → OpenAI fallback → deterministic stub)
 *   4. landingPageGuard.scrub on raw JSON
 *   5. mapTeeOutputToContent (per template) — bridge to semantic payload
 *   6. destinationImageProvider.fetchStrategy + applyImagesToContent
 *   7. Persist content with full _tee metadata block
 *
 * @param {Object} input             — { destination, durationDays, audience, tripType,
 *                                      travelMonth, subBrand, tenantSlug, tenantId }
 * @param {Object} [options]
 *   options.existingContent          — prior LandingPage.content for _locked preservation
 *   options.skipImages               — boolean, skip the image-fetch step (e.g. fast preview)
 *   options.__userId                 — caller hint for LlmCallLog
 *   options.__surface                — caller hint for LlmCallLog
 *
 * @returns {Object} {
 *   templateType:      string (e.g. 'religious-tour-v1'),
 *   content:           object (template payload + _tee block),
 *   teeOutput:         object (the TEE decision log),
 *   model:             string (LLM model used),
 *   source:            'gemini' | 'openai' | 'stub' | 'fallback-blocks',
 *   imagesFetched:     number,
 * }
 */
async function generateLandingPageContentWithTee(input = {}, options = {}) {
  const { tenantId, destination } = input;
  const __userId = options.__userId;
  const __surface = options.__surface || 'tee-generate';

  if (!tenantId) throw new Error('tenantId required');
  if (!destination || typeof destination !== 'string' || !destination.trim()) {
    throw new Error('destination required');
  }

  // Pre-call budget cap (reused — same budget envelope as legacy flow).
  await module.exports.checkBudgetCap(tenantId);

  // ── 1. TEE classify ───────────────────────────────────────────────
  const tee = require('./travelExperienceEngine');
  const teeOutput = await tee.classify(input, { tenantId });
  console.log(
    `[landingPageGeneratorLLM-TEE] classified: family=${teeOutput.family} ` +
    `themeId=${teeOutput.themeId} visualMood=${teeOutput.traits.visualMood} ` +
    `(source=${teeOutput.traits.source}, confidence=${teeOutput.traits.confidence})`
  );

  // ── 2. Build family-aware prompt ──────────────────────────────────
  const { buildTeeContentPrompt } = require('./teePrompts');
  const { system, user } = buildTeeContentPrompt({ teeOutput, input });

  // ── 3. LLM call (Gemini → OpenAI → Groq → stub) ─────────────────
  // Each provider is tried in turn; the FIRST that returns parseable
  // JSON wins. Mid-batch quota exhaustion on one provider does not halt
  // the workflow — the next one picks up. Stub is the guaranteed-non-
  // empty last resort so the operator always sees a renderable page.
  let rawJson = null;
  let modelUsed = null;
  let source = null;
  if (await module.exports.realModeEnabled(tenantId)) {
    try {
      const r = await callGeminiTeeCascade({ system, user, tenantId });
      rawJson = r.rawJson;
      modelUsed = r.modelUsed;
      source = 'gemini';
    } catch (geminiErr) {
      console.error(`[landingPageGeneratorLLM-TEE] Gemini cascade exhausted: ${geminiErr && geminiErr.message}`);
      if (module.exports.openAiFallbackEnabled()) {
        try {
          // OpenAI fallback also accepts the TEE prompt — same shape.
          const openaiInput = { ...input, __teeSystem: system, __teeUser: user };
          const r = await module.exports.callOpenAI(openaiInput);
          rawJson = r.rawJson;
          modelUsed = r.modelUsed;
          source = 'openai';
        } catch (openAiErr) {
          console.error(`[landingPageGeneratorLLM-TEE] OpenAI fallback failed: ${openAiErr && openAiErr.message}`);
        }
      }
      if (!rawJson && module.exports.groqEnabled()) {
        try {
          const r = await module.exports.callGroq(input);
          rawJson = r.rawJson;
          modelUsed = r.modelUsed;
          source = 'groq';
        } catch (groqErr) {
          console.error(`[landingPageGeneratorLLM-TEE] Groq fallback failed: ${groqErr && groqErr.message}`);
        }
      }
    }
  }

  // ── 3b. Deterministic stub when all providers unavailable ────────
  if (!rawJson) {
    rawJson = buildTeeStubContent(teeOutput, input);
    modelUsed = 'tee-stub';
    source = 'stub';
  }

  // ── 4. Guard pass — semantic-payload guard (Phase 2.4.0) ─────────
  // guardTeeContent enforces the locked safety contract before content
  // reaches the bridge: no pricing claims, no testimonials, no ratings,
  // no fake urgency, no unsupported URLs, no arbitrary external links,
  // required slots present. Issues are logged; payload is sanitized
  // (banned strings → empty; banned operator-only slots → cleared).
  // Verdict is informational — `bridge.mapTeeOutputToContent` is still
  // the authoritative gate on critical-slot presence.
  let guarded = rawJson;
  let guardResult = { accepted: true, verdict: 'clean', issues: [] };
  try {
    const { guardTeeContent } = require('../lib/guardTeeContent');
    guardResult = guardTeeContent(rawJson, {
      family: teeOutput.family,
      traits: teeOutput.traits,
      input,
    });
    guarded = guardResult.output || rawJson;
    if (guardResult.issues && guardResult.issues.length > 0) {
      console.log(
        `[landingPageGeneratorLLM-TEE] guardTeeContent verdict=${guardResult.verdict} ` +
        `issues=${guardResult.issues.length} (${guardResult.issues.slice(0, 4).join(', ')}${guardResult.issues.length > 4 ? ', …' : ''})`
      );
    }
  } catch (e) {
    console.warn(`[landingPageGeneratorLLM-TEE] guardTeeContent failed (non-fatal): ${e && e.message}`);
  }

  // ── 5. Bridge — LLM output → template payload ────────────────────
  const templateModule = pickTemplateModule(teeOutput.family);
  let bridgeResult;
  try {
    bridgeResult = templateModule.mapTeeOutputToContent({
      rawLLMOutput: guarded,
      teeOutput,
      input,
      existingContent: options.existingContent || null,
    });
  } catch (validationErr) {
    if (validationErr && validationErr.name === 'TeeContentValidationError') {
      console.warn(
        `[landingPageGeneratorLLM-TEE] validation failed, missing slots: ${validationErr.missing.join(', ')}`
      );
      // Fallback to the partial payload (operator sees [REVIEW] markers).
      bridgeResult = { content: validationErr.partial || {}, validation: { ok: false, missing: validationErr.missing } };
    } else {
      throw validationErr;
    }
  }
  let content = bridgeResult.content;

  // ── 6. Image fetch + apply ────────────────────────────────────────
  let imagesFetched = 0;
  if (!options.skipImages) {
    try {
      const imageProvider = require('./destinationImageProvider');
      // Enrich marquee queries with the bridged city titles/tags so each
      // slot gets a city-specific search (Osaka/CULINARY → an Osaka photo,
      // Kyoto/HERITAGE → a Kyoto photo). Without this, every slot shares
      // the destination-level query and the provider cache returns the
      // same image for every card. See chooseImageStrategy() default seeds
      // for the no-cities fallback.
      const enrichedStrategy = enrichMarqueeQueriesWithCities(teeOutput.imageStrategy, content, input.destination || '');
      const fetched = await imageProvider.fetchStrategy(enrichedStrategy, { tenantId });
      content = imageProvider.applyImagesToContent(content, fetched);
      imagesFetched = (fetched.hero ? 1 : 0) +
        (fetched.brochure ? 1 : 0) +
        ((fetched.marquee || []).filter((m) => m && m.image).length);
    } catch (e) {
      console.warn(`[landingPageGeneratorLLM-TEE] image fetch failed (non-fatal): ${e && e.message}`);
    }
  }

  // ── 7. Persist call log ────────────────────────────────────────────
  try {
    persistCallLog({
      tenantId,
      stub: source === 'stub',
      realModeError: null,
      inputSize: JSON.stringify(input).length,
      outputSize: JSON.stringify(content).length,
      model: modelUsed,
      userId: __userId,
      surface: __surface,
    });
  } catch (_e) { /* observability is best-effort */ }

  return {
    templateType: REGISTRY_BY_FAMILY[teeOutput.family] || 'educational-trip-v1',
    content,
    teeOutput,
    model: modelUsed,
    source,
    imagesFetched,
    validation: bridgeResult.validation,
    // Surface the guardTeeContent verdict + issues so the operator-facing
    // /api/landing-pages/generate-with-tee response carries a full audit
    // trail. The builder UI's TEE Decision Panel can flag pages with
    // verdict='scrubbed' so demos can show "AI tried to insert X, guard
    // blocked it".
    guard: {
      accepted: guardResult.accepted,
      verdict: guardResult.verdict,
      issues: guardResult.issues || [],
    },
  };
}

// Deterministic stub content (used when LLM unavailable). Produces a
// minimal payload sufficient for guardTeeContent's family-specific
// required-slot validation to pass on every family. Operator sees
// [REVIEW] markers and fills the real copy in the builder.
//
// FAMILY-AWARENESS: religious needs `programme.leftHeadline`; luxury
// needs >=2 investment tiers; educational/family need contact.label.
// The stub satisfies all four families' required-slot specs.
function buildTeeStubContent(teeOutput, input) {
  const dest = (input && input.destination) || 'Destination';
  const visualMood = (teeOutput && teeOutput.traits && teeOutput.traits.visualMood) || 'considered';
  const family = (teeOutput && teeOutput.family) || 'educational';
  return {
    brand: {
      label: `[REVIEW] ${String(dest).toUpperCase()} 2026`,
      programmeName: `[REVIEW] ${dest}`,
      programmeTagline: `[REVIEW] A ${visualMood.replace(/-/g, ' ')} journey.`,
    },
    hero: {
      eyebrow: { date: '', audience: '', batchPill: '' },
      kicker: '',
      headline: `[REVIEW] ${dest} — ${visualMood.replace(/-/g, ' ')}`,
      lede: '[REVIEW] Lede paragraph to write.',
      benefitCards: [
        { icon: '◈', title: '[REVIEW] Benefit 1', desc: '[REVIEW]' },
        { icon: '⊕', title: '[REVIEW] Benefit 2', desc: '[REVIEW]' },
        { icon: '⌂', title: '[REVIEW] Benefit 3', desc: '[REVIEW]' },
        { icon: '❖', title: '[REVIEW] Benefit 4', desc: '[REVIEW]' },
      ],
      visualTitle: `[REVIEW] ${dest}`,
      visualSub: `[REVIEW] ${visualMood.replace(/-/g, ' ')}`,
    },
    // Religious requires `programme.leftHeadline`; we ship it for every
    // family so the stub passes guardTeeContent's check uniformly.
    // Non-religious families' templates will hide programme if their
    // composition omits it.
    programme: {
      leftHeadline: '[REVIEW] Why this journey.',
      leftParagraphs: ['[REVIEW] Operator to write.'],
      rightHeadline: '[REVIEW] What you carry home',
      rightChecks: ['[REVIEW]', '[REVIEW]', '[REVIEW]'],
    },
    cultural: {
      title: '[REVIEW] Highlights',
      items: [
        { name: '[REVIEW] Place 1', label: '[REVIEW]', body: ['[REVIEW]'], benefit: '[REVIEW]' },
        { name: '[REVIEW] Place 2', label: '[REVIEW]', body: ['[REVIEW]'], benefit: '[REVIEW]' },
      ],
    },
    safety: {
      title: '[REVIEW] Safety',
      features: [
        { icon: 'shield', title: '[REVIEW] 1', desc: '[REVIEW]' },
        { icon: 'briefcase', title: '[REVIEW] 2', desc: '[REVIEW]' },
      ],
    },
    investment: {
      title: '[REVIEW] Investment',
      tiers: [
        { step: 1, title: '[REVIEW] Reservation', subtitle: '[REVIEW]' },
        { step: 2, title: '[REVIEW] Balance', subtitle: '[REVIEW]' },
      ],
    },
    faq: {
      items: [
        { cat: 'all', q: '[REVIEW] Q1?', a: '[REVIEW]' },
        { cat: 'all', q: '[REVIEW] Q2?', a: '[REVIEW]' },
        { cat: 'all', q: '[REVIEW] Q3?', a: '[REVIEW]' },
      ],
    },
    contact: {
      label: `[REVIEW] ${dest}`,
    },
  };
}

// Mix the bridged city titles into the TEE imageStrategy.marquee queries
// so each slot fetches a city-specific photo. Strips the literal " city"
// suffix. Final query shape is:
//
//   "<cityName> <destination> <lowercased-tag>"
//
// The tag (FOOD / HISTORY / NATURE / etc.) is included lowercased as a
// topic anchor — this is the strongest signal that biases stock
// providers away from person-portrait results when the cityName
// coincides with a common given name (Nandan / William / Rabindra all
// match Pexels person photos otherwise). The earlier
// "landmark famous tourism" boilerplate is GONE because "famous" /
// "tourism" pulled tourist-pose people-photos to the top.
// Operator-uploaded poster images are preserved by applyImagesToContent.
function enrichMarqueeQueriesWithCities(imageStrategy, content, destination = '') {
  const strategy = imageStrategy || {};
  const cities = (content && content.marquee && Array.isArray(content.marquee.cities)) ? content.marquee.cities : [];
  if (cities.length === 0) return strategy;
  const cleanCityName = (raw) => String(raw || '')
    .replace(/\s+city\b/i, '')   // strip "Jorhat City" → "Jorhat"
    .replace(/\s+/g, ' ')
    .trim();
  // Pad the strategy marquee to match the LLM-emitted city count so an
  // 8 or 10-card emission isn't silently truncated to the default 4
  // slots. Pre-existing slot queries (with their per-slot landmark
  // seeds) are preserved; padded slots reuse the last existing slot's
  // query as their seed, with the city-specific suffix added below.
  const baseMarquee = Array.isArray(strategy.marquee) ? strategy.marquee : [];
  const padded = [...baseMarquee];
  while (padded.length < cities.length) {
    const seedTemplate = baseMarquee.length > 0
      ? baseMarquee[padded.length % baseMarquee.length]
      : { slot: padded.length, query: `${destination} famous landmark` };
    padded.push({ ...seedTemplate, slot: padded.length });
  }
  const marquee = padded.map((slot, i) => {
    const city = cities[i];
    const cityName = cleanCityName(city && city.title);
    if (!cityName) return slot;
    const destPhrase = destination ? ` ${destination}` : '';
    const tag = (city && typeof city.tag === 'string') ? city.tag.toLowerCase().trim() : '';
    const tagPhrase = tag ? ` ${tag}` : '';
    return { ...slot, query: `${cityName}${destPhrase}${tagPhrase}`.replace(/\s+/g, ' ').trim() };
  });
  return { ...strategy, marquee };
}

function pickTemplateModule(family) {
  switch (family) {
    case 'religious': return require('./templates/religiousTourV1');
    case 'family':    return require('./templates/familyTripV1');
    case 'luxury':    return require('./templates/luxuryTourV1');
    case 'educational':
    default:          return require('./templates/educationalTripV1');
  }
}

module.exports = {
  generateLandingPageContent,
  generateLandingPageContentWithTee, // PR-E Phase 2.2 — primary entrypoint
  // Test seams — vitest spies on these via module.exports indirection
  // per the CJS self-mocking pattern (cron-learning 2026-05-24).
  checkBudgetCap,
  computeMonthlySpendCents,
  realModeEnabled,
  callGemini,
  callOpenAI,
  openAiFallbackEnabled,
  callGroq,
  groqEnabled,
  // Pure helpers exported for unit-test introspection.
  parseGeminiJson,
  // Phase 2.2 test seams
  pickTemplateModule,
  buildTeeStubContent,
};
