/**
 * Curated model catalog for the UI model picker. Each entry carries a LOGICAL provider
 * (which key it needs) + an `intelligence` rating; price + a derived `costEff` rating
 * come from the pricing table so the UI and billing never disagree. The API filters
 * this to the models actually reachable with the configured keys.
 */
import { priceOf } from './pricing.js';

/** Logical provider a model needs (mapped to a configured key by the API). */
export type LogicalProvider = 'openai' | 'groq' | 'moonshot' | 'xai' | 'gemini' | 'deepseek';

export interface CatalogModel {
  id: string; // the id sent to the provider (also the pricing key)
  label: string; // display name
  provider: LogicalProvider;
  /** Curated capability rating, 1–5 (5 = most capable). */
  intelligence: number;
  blurb: string;
}

export const MODEL_CATALOG: CatalogModel[] = [
  // ── OpenAI (proprietary; needs OPENAI_API_KEY) ──
  { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', intelligence: 5, blurb: 'Most capable OpenAI model — top reasoning, premium price.' },
  { id: 'gpt-5.4', label: 'GPT-5.4', provider: 'openai', intelligence: 5, blurb: 'Flagship reasoning, strong all-rounder.' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', provider: 'openai', intelligence: 4, blurb: 'Smart reasoning at a fraction of flagship cost — great default.' },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', provider: 'openai', intelligence: 3, blurb: 'Fast & very cheap — ideal for plumbing/tool steps.' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'openai', intelligence: 3, blurb: 'Older small model — cheap, capable for simple work.' },

  // ── Groq-hosted open models (needs GROQ_API_KEY, or an OpenAI-compatible Groq URL) ──
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', provider: 'groq', intelligence: 4, blurb: 'Open 120B on Groq — capable + extremely cheap. Strong default.' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', provider: 'groq', intelligence: 3, blurb: 'Open 20B on Groq — fast, cheap, reliable tool-calling.' },
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', provider: 'groq', intelligence: 3, blurb: 'Meta Llama on Groq — fast; weaker tool-calling.' },
  { id: 'qwen/qwen3-32b', label: 'Qwen3 32B', provider: 'groq', intelligence: 3, blurb: 'Alibaba Qwen on Groq — solid, low cost.' },

  // ── Moonshot / Kimi (needs MOONSHOT_API_KEY) ──
  { id: 'kimi-k2-thinking', label: 'Kimi K2 Thinking', provider: 'moonshot', intelligence: 4, blurb: 'Strong reasoning, good value.' },
  { id: 'kimi-k2.6', label: 'Kimi K2.6', provider: 'moonshot', intelligence: 4, blurb: 'Balanced all-rounder.' },
  { id: 'kimi-k2-turbo-preview', label: 'Kimi K2 Turbo', provider: 'moonshot', intelligence: 4, blurb: 'Faster Kimi variant.' },

  // ── xAI / Grok (needs XAI_API_KEY) ──
  { id: 'grok-4', label: 'Grok 4', provider: 'xai', intelligence: 5, blurb: 'xAI flagship — strong reasoning.' },
  { id: 'grok-3-mini', label: 'Grok 3 mini', provider: 'xai', intelligence: 3, blurb: 'Cheaper, faster Grok.' },

  // ── Google Gemini (via an OpenAI-compatible Gemini URL) ──
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'gemini', intelligence: 4, blurb: 'Google flagship — long context.' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'gemini', intelligence: 3, blurb: 'Fast & cheap; generous free tier.' },

  // ── DeepSeek (via an OpenAI-compatible DeepSeek URL) ──
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', provider: 'deepseek', intelligence: 4, blurb: 'Strong reasoning, low cost.' },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'deepseek', intelligence: 3, blurb: 'Very cheap, fast.' },
];

/** Cost-efficiency rating 1–5 (5 = cheapest) derived from the blended price. */
export function costEffOf(model: string): number {
  const p = priceOf(model);
  const blended = p.input + p.output; // USD / 1M (rough blend)
  if (blended <= 1) return 5;
  if (blended <= 3.5) return 4;
  if (blended <= 9) return 3;
  if (blended <= 20) return 2;
  return 1;
}
