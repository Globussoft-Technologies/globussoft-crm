/**
 * ModelRouter — the heart of provider-agnosticism.
 *
 * Agents ask for a CAPABILITY TIER ("reasoning"); the router resolves it to:
 *   1. the highest-priority provider that actually has a key configured, and
 *   2. the model id configured for that tier (the MODEL_* env vars).
 *
 * So the same agent definition runs on Kimi, DeepSeek, OpenAI, or a local model
 * with no code change — you set the provider key(s) and the MODEL_* ids for the
 * provider you're using.
 */
import type { AppConfig, CapabilityTier } from '@agentic-os/shared';
import { NoProviderError } from '@agentic-os/shared';
import type { ProviderRegistry } from './registry.js';
import type { ChatRequest, ChatResponse, LLMProvider } from './types.js';

/**
 * Order in which providers are preferred when several are configured. The first
 * one with a key configured wins. (Cross-provider fallback on error is a future
 * enhancement — today the active provider is the first available here.)
 */
const PROVIDER_PRIORITY = ['moonshot', 'xai', 'groq', 'openai-compatible', 'openai', 'anthropic'];

export interface Resolved {
  provider: LLMProvider;
  model: string;
}

export class ModelRouter {
  /**
   * Runtime per-tier model override, set from the UI (Settings). Wins over both the
   * env PROVIDER_OVERRIDE and per-agent model pins, so the user fully controls which
   * model each capability tier uses — live, no restart. `providerId` is a CONCRETE
   * registered provider id (resolved by the caller).
   */
  private readonly overrides = new Map<CapabilityTier, { providerId: string; model: string }>();

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly cfg: AppConfig,
  ) {}

  /** Set (or clear, with null) the runtime model for a tier. */
  setOverride(tier: CapabilityTier, sel: { providerId: string; model: string } | null): void {
    if (sel) this.overrides.set(tier, sel);
    else this.overrides.delete(tier);
  }

  /** Current runtime overrides (tier → {providerId, model}). */
  getOverrides(): Partial<Record<CapabilityTier, { providerId: string; model: string }>> {
    return Object.fromEntries(this.overrides) as Partial<
      Record<CapabilityTier, { providerId: string; model: string }>
    >;
  }

  /**
   * Resolve a capability tier to an available provider + model. An optional
   * `overrideModel` (a per-agent model id on the SAME provider) wins over the
   * tier's configured model — used for per-agent upgrades (e.g. a designer).
   */
  resolve(tier: CapabilityTier, overrideModel?: string): Resolved {
    // 1) UI runtime override (Settings) wins over everything — incl. per-agent pins, so
    //    `overrideModel` is intentionally ignored when the user has chosen a tier model.
    const ui = this.overrides.get(tier);
    if (ui) {
      const provider = this.registry.get(ui.providerId);
      if (provider) return { provider, model: ui.model };
    }
    // PROVIDER_OVERRIDE forces one provider for every tier (bypassing priority) — used to
    // A/B a provider (e.g. OpenAI gpt-5.4-mini) without touching the other keys. Unset
    // the env var to revert. If the forced provider has no key, fall through to priority.
    const forced = this.cfg.providerOverride;
    if (forced) {
      const provider = this.registry.get(forced);
      // IGNORE per-agent model overrides under a forced provider: those ids belong to
      // the ORIGINAL provider (e.g. a pack pins Groq's "openai/gpt-oss-120b") and don't
      // exist on the forced one — sending them yields "invalid model ID". Use the tier's
      // configured MODEL_* instead so every agent runs on the override provider's model.
      if (provider) return { provider, model: this.cfg.models[tier] };
    }
    for (const id of PROVIDER_PRIORITY) {
      const provider = this.registry.get(id);
      if (provider) return { provider, model: overrideModel || this.cfg.models[tier] };
    }
    throw new NoProviderError(
      `No provider available for tier "${tier}". Configure a provider key in .env.`,
    );
  }

  /** Convenience: resolve a tier and run a chat call in one step. */
  async chat(
    tier: CapabilityTier,
    req: Omit<ChatRequest, 'model'>,
    overrideModel?: string,
  ): Promise<ChatResponse & { provider: string }> {
    const { provider, model } = this.resolve(tier, overrideModel);
    const res = await provider.chat({ ...req, model });
    return { ...res, provider: provider.id };
  }
}
