/**
 * Central, typed access to environment configuration.
 * Every package reads config through here — no `process.env` scattered around.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityTier } from './types.js';

/**
 * Load the workspace `.env` into process.env — ONCE, at module load.
 *
 * This repo documents "secrets live in .env; loadConfig() reads them", but
 * nothing actually loaded that file: there is no dotenv dependency and no
 * --env-file flag, so `loadConfig()` only ever saw variables that happened to
 * be exported by the parent process. Keys that live ONLY in this workspace's
 * .env (GEOAPIFY_API_KEY / MAPTILER_API_KEY) were therefore invisible whenever
 * the engine ran as a subprocess of the CRM backend, silently disabling the
 * route map. Implemented inline rather than via dotenv so no new dependency is
 * introduced.
 *
 * IMPORTANT — only fills variables that are genuinely ABSENT. The CRM
 * deliberately blanks provider keys to "" (see brochureEngineProviderEnv.js)
 * to pin a tenant's chosen provider; treating "" as unset would resurrect the
 * keys it just cleared and break that isolation. An inherited value always wins.
 */
function loadWorkspaceEnvOnce(): void {
  const g = globalThis as { __agenticEnvLoaded?: boolean };
  if (g.__agenticEnvLoaded) return;
  g.__agenticEnvLoaded = true;
  try {
    // packages/shared/src → up to the workspace root.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(here, '..', '..', '..');
    const file = path.join(root, '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || line.trimStart().startsWith('#')) continue;
      const key = m[1]!;
      if (process.env[key] !== undefined) continue; // inherited value wins
      let value = m[2]!.trim();
      const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
      value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, '').trim();
      process.env[key] = value;
    }
  } catch {
    /* Never let config loading crash startup — env may simply be provided. */
  }
}

loadWorkspaceEnvOnce();

function str(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export type OrchestrationMode = 'autonomous' | 'supervised';

export interface AppConfig {
  providers: {
    moonshot: { apiKey: string; baseUrl: string };
    anthropic: { apiKey: string };
    openai: { apiKey: string };
    /** xAI / Grok — OpenAI-compatible; base URL defaults to the xAI endpoint. */
    xai: { apiKey: string; baseUrl: string };
    /** Groq — OpenAI-compatible; base URL defaults to the Groq endpoint. */
    groq: { apiKey: string; baseUrl: string };
    openaiCompatible: { apiKey: string; baseUrl: string };
  };
  /** Capability tier -> concrete model id (env-overridable). */
  models: Record<CapabilityTier, string>;
  /**
   * Force a specific provider for ALL tiers, bypassing the priority order — set via
   * `PROVIDER_OVERRIDE` (e.g. "openai"). Empty = use the normal priority resolution.
   * Lets you A/B a provider (e.g. OpenAI gpt-5.4-mini) without touching other keys;
   * unset the one env var to revert.
   */
  providerOverride: string;
  orchestration: {
    mode: OrchestrationMode;
    defaultSector: string;
    maxDelegationDepth: number;
    maxAgentSteps: number;
    /** Max times one coordinator may delegate to the SAME specialist (anti-loop). */
    maxDelegationsPerPair: number;
  };
  billing: { markup: number };
  /** Fundamental safety limits — abuse, runaway-spend, and DoS protection. */
  security: {
    /** Max characters accepted for a goal (caps prompt-injection / cost abuse). */
    maxGoalChars: number;
    /** Hard cap on billed USD per run; the run aborts if exceeded (0 = off). */
    maxRunBudgetUsd: number;
    /** Max simultaneously-running orchestrations (cost + load protection). */
    maxConcurrentRuns: number;
    /** Per-client request budget per minute on the API. */
    rateLimitPerMinute: number;
  };
  databaseUrl: string;
}

/** Read the current config from the environment. Call once at startup. */
export function loadConfig(): AppConfig {
  return {
    providers: {
      moonshot: {
        apiKey: str('MOONSHOT_API_KEY'),
        baseUrl: str('MOONSHOT_BASE_URL', 'https://api.moonshot.ai/v1'),
      },
      anthropic: { apiKey: str('ANTHROPIC_API_KEY') },
      openai: { apiKey: str('OPENAI_API_KEY') },
      xai: {
        apiKey: str('XAI_API_KEY'),
        baseUrl: str('XAI_BASE_URL', 'https://api.x.ai/v1'),
      },
      groq: {
        apiKey: str('GROQ_API_KEY'),
        baseUrl: str('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
      },
      openaiCompatible: {
        apiKey: str('OPENAI_COMPATIBLE_API_KEY'),
        baseUrl: str('OPENAI_COMPATIBLE_BASE_URL'),
      },
    },
    models: {
      reasoning: str('MODEL_REASONING', 'kimi-k2-thinking'),
      balanced: str('MODEL_BALANCED', 'kimi-k2.6'),
      fast: str('MODEL_FAST', 'kimi-k2-turbo-preview'),
      writing: str('MODEL_WRITING', 'kimi-k2.6'),
    },
    providerOverride: str('PROVIDER_OVERRIDE'),
    orchestration: {
      mode: (str('ORCHESTRATION_MODE', 'autonomous') as OrchestrationMode),
      defaultSector: str('DEFAULT_SECTOR', 'report-writing'),
      maxDelegationDepth: num('MAX_DELEGATION_DEPTH', 3),
      maxAgentSteps: num('MAX_AGENT_STEPS', 24),
      maxDelegationsPerPair: num('MAX_DELEGATIONS_PER_PAIR', 5),
    },
    billing: { markup: num('BILLING_MARKUP', 1.5) },
    security: {
      maxGoalChars: num('MAX_GOAL_CHARS', 8000),
      maxRunBudgetUsd: num('MAX_RUN_BUDGET_USD', 1.0),
      maxConcurrentRuns: num('MAX_CONCURRENT_RUNS', 5),
      rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 20),
    },
    databaseUrl: str('DATABASE_URL'),
  };
}
