/** A page edge anchor for the interior logo running mark (mirrors @agentic-os/tools). */
export type LogoCorner =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/**
 * Exact logo placement from the visual "Place logo" placer (mirrors the engine's
 * `LogoPlacementCustom`). Pure numbers + a fixed corner enum; the server re-clamps
 * everything in `sanitizeBrandKit`, so this is only a convenience shape for the UI.
 */
export interface LogoPlacementCustom {
  /** Cover logo: normalised CENTRE (x,y in 0..1) + width as a fraction of page width. null = none. */
  cover: { x: number; y: number; scale: number } | null;
  /** Interior running mark: corner + width fraction. null = no inside mark. */
  interior: { corner: LogoCorner; scale: number } | null;
  /**
   * Logo backing: `none` renders the uploaded logo AS-IS (transparent, just a soft
   * shadow); `plate` puts a white box behind it (for legibility on busy photos).
   * Consumed at the API boundary (maps to the engine's `onDark`), not stored on the
   * engine kit. Absent → the server auto-detects from the logo's pixels.
   */
  backing?: 'plate' | 'none';
}

/** UI-side view models (mirror the API shapes). */
export interface UiAgent {
  key: string;
  name: string;
  title: string;
  description: string;
  tier: string;
  tools: string[];
  delegatesTo: string[];
}

export interface UiPack {
  key: string;
  name: string;
  description: string;
  coordinatorKey: string;
  agents: UiAgent[];
  /** Selectable design styles for this sector (empty if none). */
  styles?: Array<{ key: string; label: string }>;
  defaultStyleKey?: string;
  producesPdf?: boolean;
}

/** Live per-agent status shown on the agent cards. */
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'done';

/** Live token tally for one agent (exact, from API usage). */
export interface AgentTokens {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costUsd: number;
}

export interface AgentUsage extends AgentTokens {
  agentKey: string;
  billedUsd: number;
}

export interface RunSummary {
  runId: string;
  status: string;
  sector: string;
  goal: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  billedUsd: number;
  hasResult: boolean;
}

export interface RunDetail extends RunSummary {
  result?: string;
  perAgent: AgentUsage[];
  events: Array<{
    id: string;
    ts: string;
    type: string;
    agentKey: string;
    parentAgentKey?: string;
    data: Record<string, unknown>;
  }>;
}

export interface Analytics {
  totals: {
    runs: number;
    completed: number;
    failed: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    billedUsd: number;
  };
  models: Array<{
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    billedUsd: number;
  }>;
  runs: RunSummary[];
}

export interface CatalogModelView {
  id: string;
  label: string;
  provider: string;
  blurb: string;
  available: boolean;
  concreteProvider: string | null;
  intelligence: number; // 1–5
  costEff: number; // 1–5
  inputPer1M: number;
  outputPer1M: number;
}

export interface ModelsView {
  tiers: string[];
  models: CatalogModelView[];
  selection: Record<string, string>;
  overridden: Record<string, boolean>;
  defaults: Record<string, string>;
  strategy: string; // 'recommended' | 'cheapest' | 'smartest' | 'custom'
  strategies: string[];
}

export interface AppConfigView {
  providers: Array<{ id: string; baseUrl: string }>;
  models: Record<string, string>;
  orchestration: {
    mode: string;
    defaultSector: string;
    maxDelegationDepth: number;
    maxAgentSteps: number;
    maxDelegationsPerPair?: number;
  };
  security: {
    maxGoalChars: number;
    maxRunBudgetUsd: number;
    maxConcurrentRuns: number;
    rateLimitPerMinute: number;
  };
  billing: { markup: number };
}
