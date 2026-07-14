/**
 * apiPricing.js — static $-per-unit pricing table for external API cost
 * estimation, powering the Super Admin "API Analytics" dashboard.
 *
 * Deliberately a maintained constants table, not a live pricing API call —
 * the whole point is estimating cost WITHOUT hitting the provider (their
 * billing APIs are typically delayed/aggregated, not per-call). Prices are
 * list-price-as-of-authoring and WILL drift; there is no automatic refresh.
 * Update PRICING_PER_1K below when a provider changes list pricing.
 *
 * Two shapes:
 *   - LLM/token-based (Gemini, OpenAI, Anthropic, Perplexity, Groq):
 *     estimateLlmCost(model, promptTokens, completionTokens) -> Decimal-safe number
 *   - Flat-rate APIs (SerpApi — no token concept, priced per search):
 *     estimateFlatCost(provider) -> number | null (null = unknown, don't guess)
 */

'use strict';

// $ per 1,000 tokens, input/output split where the provider prices them
// differently (most do). Source: each provider's public pricing page,
// captured at authoring time (2026-07). Model-name keys mirror the `model`
// strings already used in llmRouter.js's MODEL_ROUTING / ENV_FOR_MODEL maps.
const PRICING_PER_1K = {
  // Gemini
  'gemini-flash': { in: 0.000075, out: 0.0003 }, // gemini-2.5-flash-ish tier
  'gemini-2.5-flash': { in: 0.000075, out: 0.0003 },
  'gemini-2.5-flash-lite': { in: 0.00002, out: 0.00008 },
  'gemini-2.0-flash': { in: 0.00005, out: 0.0002 },
  'gemini-pro': { in: 0.00125, out: 0.005 },

  // OpenAI
  'gpt-4': { in: 0.03, out: 0.06 },
  'gpt-4o': { in: 0.0025, out: 0.01 },
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'gpt-4o-search-preview': { in: 0.0025, out: 0.01 },

  // Anthropic
  'claude-opus-4-7': { in: 0.015, out: 0.075 },
  'claude-opus-4-8': { in: 0.015, out: 0.075 },
  'claude-haiku': { in: 0.0008, out: 0.004 },
  'claude-haiku-4-5': { in: 0.001, out: 0.005 },

  // Perplexity
  'perplexity-sonar': { in: 0.001, out: 0.001 },

  // Groq (Llama models — Groq's own hosted pricing)
  'groq-llama': { in: 0.00005, out: 0.00008 },
};

// Flat $/request pricing for non-token APIs. Providers absent from this
// table (or explicitly set to null) are "don't estimate, we don't know the
// plan's real per-call rate" — surfaced as "unknown" in the UI rather than a
// silently-wrong number. TripGo/Zoom have no public flat per-call price (both
// are typically negotiated/tiered plans); Razorpay is a % of the transaction
// amount, not a per-API-call cost — all three are tracked as request COUNTS
// only, never a fabricated $ figure.
const FLAT_RATE_PER_REQUEST = {
  serpapi: 0.015, // SerpApi's pay-as-you-go list rate ($75/5000 searches)
  tripgo: null,
  zoom: null,
  razorpay: null,
};

// provider inference from a model-name string — mirrors llmRouter.js's own
// providerForModel() so this module has zero import-cycle risk (llmRouter.js
// requires apiPricing.js, not the reverse) and can be reused by call sites
// that never touch llmRouter.js (routes/ai.js, sentimentEngine.js, etc.).
function inferProvider(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('gpt') || m.includes('openai')) return 'openai';
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('perplexity') || m.includes('sonar')) return 'perplexity';
  if (m.includes('groq') || m.includes('llama')) return 'groq';
  return 'unknown';
}

/**
 * Returns a plain number (USD), never throws. Falls back to 0 for unknown
 * models — callers should treat 0 as "unpriced", same convention llmRouter.js
 * already uses for costEstimate.
 */
function estimateLlmCost(model, promptTokens, completionTokens) {
  const key = String(model || '').toLowerCase();
  const rate = PRICING_PER_1K[key];
  if (!rate) return 0;
  const inCost = ((promptTokens || 0) / 1000) * rate.in;
  const outCost = ((completionTokens || 0) / 1000) * rate.out;
  return Math.round((inCost + outCost) * 1e6) / 1e6; // 6dp, matches Decimal(12,6)
}

/**
 * Returns a number for a known flat-rate provider, or null when the rate is
 * unknown — callers must NOT coerce null to 0 (that would silently claim
 * "free" instead of "unpriced").
 */
function estimateFlatCost(provider) {
  const rate = FLAT_RATE_PER_REQUEST[String(provider || '').toLowerCase()];
  return typeof rate === 'number' ? rate : null;
}

module.exports = {
  PRICING_PER_1K,
  FLAT_RATE_PER_REQUEST,
  inferProvider,
  estimateLlmCost,
  estimateFlatCost,
};
