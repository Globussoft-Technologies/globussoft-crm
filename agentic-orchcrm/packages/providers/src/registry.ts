/**
 * Builds the set of *available* providers from configured keys. A provider only
 * exists in the registry if its key is set — this is what lets the router
 * "adaptively use whatever keys you have".
 */
import type { AppConfig } from '@agentic-os/shared';
import { createLogger } from '@agentic-os/shared';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { LLMProvider } from './types.js';

const log = createLogger('providers');

export type ProviderRegistry = Map<string, LLMProvider>;

export function buildProviderRegistry(cfg: AppConfig): ProviderRegistry {
  const registry: ProviderRegistry = new Map();

  // Moonshot / Kimi — OpenAI-compatible.
  if (cfg.providers.moonshot.apiKey) {
    registry.set(
      'moonshot',
      new OpenAICompatibleProvider({
        id: 'moonshot',
        apiKey: cfg.providers.moonshot.apiKey,
        baseUrl: cfg.providers.moonshot.baseUrl,
      }),
    );
  }

  // OpenAI — OpenAI-compatible (native endpoint).
  if (cfg.providers.openai.apiKey) {
    registry.set(
      'openai',
      new OpenAICompatibleProvider({
        id: 'openai',
        apiKey: cfg.providers.openai.apiKey,
        baseUrl: 'https://api.openai.com/v1',
      }),
    );
  }

  // xAI / Grok — OpenAI-compatible at https://api.x.ai/v1. A single
  // XAI_API_KEY is enough; the base URL is defaulted in config.
  if (cfg.providers.xai.apiKey) {
    registry.set(
      'xai',
      new OpenAICompatibleProvider({
        id: 'xai',
        apiKey: cfg.providers.xai.apiKey,
        baseUrl: cfg.providers.xai.baseUrl,
      }),
    );
  }

  // Groq — OpenAI-compatible at https://api.groq.com/openai/v1. A single
  // GROQ_API_KEY is enough; the base URL is defaulted in config.
  if (cfg.providers.groq.apiKey) {
    registry.set(
      'groq',
      new OpenAICompatibleProvider({
        id: 'groq',
        apiKey: cfg.providers.groq.apiKey,
        baseUrl: cfg.providers.groq.baseUrl,
      }),
    );
  }

  // Generic OpenAI-compatible (Together, DeepSeek, local vLLM, …).
  if (cfg.providers.openaiCompatible.apiKey && cfg.providers.openaiCompatible.baseUrl) {
    registry.set(
      'openai-compatible',
      new OpenAICompatibleProvider({
        id: 'openai-compatible',
        apiKey: cfg.providers.openaiCompatible.apiKey,
        baseUrl: cfg.providers.openaiCompatible.baseUrl,
      }),
    );
  }

  // Anthropic uses a native (non-OpenAI) format.
  // TODO: add `AnthropicProvider implements LLMProvider` (see providers/src/
  // anthropic.ts) and register it here when ANTHROPIC_API_KEY is set.
  if (cfg.providers.anthropic.apiKey) {
    log.warn('ANTHROPIC_API_KEY is set but the Anthropic adapter is not implemented yet — skipping.');
  }

  if (registry.size === 0) {
    log.warn('No provider keys configured. Set MOONSHOT_API_KEY (or another provider) in .env.');
  } else {
    log.info('Providers available', { providers: [...registry.keys()] });
  }
  return registry;
}
