/**
 * Model pricing table -> cost + billed amount. This is the basis of the
 * pooled-key markup billing model: we record the raw provider cost and the
 * tenant-billed cost (cost * markup) for every model call.
 *
 * NOTE: prices are USD per 1,000,000 tokens and are estimates — verify against
 * your provider's current pricing and adjust. Unknown models fall back to
 * DEFAULT_PRICE so cost tracking never silently reports $0.
 */
import type { UsageRecord } from '@agentic-os/shared';

interface Price {
  input: number; // USD / 1M input tokens
  output: number; // USD / 1M output tokens
}

const DEFAULT_PRICE: Price = { input: 1.0, output: 3.0 };

const PRICES: Record<string, Price> = {
  // Moonshot / Kimi (estimates — confirm with Moonshot/Kimi pricing)
  'kimi-k2.6': { input: 0.6, output: 2.5 },
  'kimi-k2.5': { input: 0.6, output: 2.5 },
  'kimi-k2-thinking': { input: 0.6, output: 2.5 },
  'kimi-k2-thinking-turbo': { input: 1.2, output: 5.0 },
  'kimi-k2-turbo-preview': { input: 1.2, output: 5.0 },
  'kimi-k2-0905-preview': { input: 0.6, output: 2.5 },
  'kimi-k2.7-code': { input: 0.6, output: 2.5 },
  // Anthropic (per the published Claude pricing)
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  // OpenAI GPT-5 family — EXACT standard per-1M-token rates from
  // developers.openai.com/api/docs/pricing (verified 2026-06-23). Cost here uses
  // input/output only; cached-input (≈10× cheaper) isn't tracked, so estimates are
  // slightly conservative (never under-report).
  'gpt-5.5': { input: 5.0, output: 30.0 },
  'gpt-5.4': { input: 2.5, output: 15.0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'gpt-5.3-codex': { input: 1.75, output: 14.0 },
  'gpt-5-chat-latest': { input: 5.0, output: 30.0 },
  'chat-latest': { input: 5.0, output: 30.0 },
  // OpenAI (older — estimates)
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  // Google Gemini (estimates; $0 on the free tier — these apply only if you upgrade).
  // NOTE: use 2.5 models with the OpenAI-compatible endpoint — 3.x models require
  // a thought_signature on tool calls that the generic adapter doesn't preserve.
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-3.5-flash': { input: 0.3, output: 2.5 },
  'gemini-3.5-pro': { input: 1.25, output: 10.0 },
  // Groq ($0 on the free plan; estimates apply only on the paid Developer plan)
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
  // Groq-hosted OpenAI open models + Qwen (confirm at groq.com/pricing).
  // gpt-oss-120b verified 2026-06-26 at groq.com/pricing ($0.15 in / $0.60 out — Groq
  // lowered the output rate from $0.75). Cached input (≈$0.075) isn't tracked here.
  'openai/gpt-oss-20b': { input: 0.1, output: 0.5 },
  'openai/gpt-oss-120b': { input: 0.15, output: 0.6 },
  'qwen/qwen3.6-27b': { input: 0.2, output: 0.8 },
  'qwen/qwen3-32b': { input: 0.29, output: 0.59 },
  // xAI / Grok (estimates — confirm at console.x.ai; ids are stable aliases)
  'grok-4': { input: 3.0, output: 15.0 },
  'grok-4-latest': { input: 3.0, output: 15.0 },
  'grok-3': { input: 3.0, output: 15.0 },
  'grok-3-mini': { input: 0.3, output: 0.5 },
  'grok-2-1212': { input: 2.0, output: 10.0 },
  // DeepSeek (current ids; estimates — confirm with DeepSeek pricing)
  'deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'deepseek-v4-pro': { input: 1.74, output: 3.48 },
  // Deprecated 2026-07-24 (alias to v4-flash) — kept for back-compat.
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek-reasoner': { input: 0.14, output: 0.28 },
};

/** The input/output price ($/1M tokens) for a model — DEFAULT_PRICE if unknown.
 *  Providers return DATED snapshot ids (e.g. OpenAI's "gpt-5.4-mini-2026-03-17"); a
 *  trailing -YYYY-MM-DD (or -YYYYMMDD) date is stripped so the dated id maps to its
 *  base catalog entry instead of silently mis-billing against DEFAULT_PRICE. This is
 *  the SINGLE source for both the displayed catalog price AND the billed cost, so they
 *  can never diverge for the same model. */
export function priceOf(model: string): Price {
  if (PRICES[model]) return PRICES[model];
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
  if (base !== model && PRICES[base]) return PRICES[base]!;
  return DEFAULT_PRICE;
}

/** Raw provider cost in USD for a single call. */
export function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = priceOf(model); // normalize dated ids → correct base price (matches the catalog)
  return (
    (inputTokens / 1_000_000) * price.input +
    (outputTokens / 1_000_000) * price.output
  );
}

/** Build a full usage record including the marked-up billed amount. */
export function buildUsageRecord(args: {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  markup: number;
}): UsageRecord {
  const costUsd = computeCost(args.model, args.inputTokens, args.outputTokens);
  return {
    provider: args.provider,
    model: args.model,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    costUsd,
    billedUsd: costUsd * args.markup,
  };
}
