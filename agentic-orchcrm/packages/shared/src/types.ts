/**
 * Core domain types shared across every package.
 *
 * Naming intent for new readers:
 *  - A CAPABILITY TIER is an abstract need ("I need strong reasoning").
 *    Agents declare a tier, never a hard model id. The ModelRouter
 *    (packages/providers) maps a tier -> a concrete provider+model based on
 *    which provider keys are configured. This is what makes the system
 *    provider-agnostic and "adaptively use whatever keys you have".
 *  - An AGENT DEFINITION is pure config: a role's persona + tier + tools.
 *  - A SECTOR PACK is a bundle of agent definitions for one domain
 *    (healthcare / finance / report-writing). Swapping packs re-skins the
 *    whole orchestration without touching the engine.
 */

/** Abstract capability need. The router resolves this to a real model. */
export type CapabilityTier = 'reasoning' | 'balanced' | 'fast' | 'writing';

/** How a tool call is authorized. 'auto' runs without a human; 'ask' may pause. */
export type ToolPermission = 'auto' | 'ask';

/**
 * A single agent's configuration. The CEO/orchestrator is just an agent whose
 * `delegatesTo` is non-empty and whose tool set includes the `delegate` tool.
 */
export interface AgentDefinition {
  /** Stable key, unique within a sector pack, e.g. "researcher". */
  key: string;
  /** Display name, e.g. "Researcher". */
  name: string;
  /** Short subtitle shown in the UI, e.g. "INTEL GATHERER". */
  title: string;
  /** One-line description of what this agent does. */
  description: string;
  /** Full system prompt that defines the agent's behavior. */
  systemPrompt: string;
  /** Abstract capability tier — resolved to a model at runtime. */
  tier: CapabilityTier;
  /** Names of tools (from the ToolRegistry) this agent is allowed to use. */
  tools: string[];
  /** For coordinator agents: keys of specialists this agent may delegate to. */
  delegatesTo?: string[];
  /**
   * Optional per-agent output-token ceiling. Raise it for agents that emit
   * large artifacts (e.g. a brochure designer producing full HTML). Defaults to
   * the provider adapter's limit when unset.
   */
  maxOutputTokens?: number;
  /**
   * Optional per-agent model id override (same provider as the agent's tier).
   * Lets a single high-value agent (e.g. a designer) run on a stronger model —
   * e.g. 'openai/gpt-oss-120b' for richer HTML — while the rest of the run stays
   * on the cheap/fast tier model. Unset = use the tier's configured model.
   */
  model?: string;
  /**
   * Optional JSON Schema for schema-constrained output. When set, the engine asks
   * the provider to force the model's reply to match this schema (e.g. Groq/OpenAI
   * `response_format: json_schema`) — used by JSON-emitting agents like the brochure
   * composer so a malformed reply can't reach the renderer. Providers that don't
   * support it ignore it; output is still parsed defensively. A loose object so the
   * leaf `shared` package needn't depend on the providers' JSONSchema type.
   */
  responseSchema?: Record<string, unknown>;
}

/**
 * Post-run finalization. Some sectors produce a file artifact rather than text:
 * the named agent outputs raw HTML, and the engine renders it to a downloadable
 * PDF after the run, replacing the deliverable with the download URL.
 *
 * 'brochure_json': the named agent outputs structured brochure CONTENT as JSON
 * (no HTML); the engine fetches assets and renders it through the chosen template
 * (styleKey = a template key). Layout/quality is owned by the engine, not the LLM.
 */
export interface SectorFinalize {
  /** The agent whose output is the artifact source (e.g. a brochure designer). */
  fromAgentKey: string;
  /** Rendering strategy. */
  render: 'html_to_pdf' | 'brochure_json';
  /**
   * Style keys (see @agentic-os/sectors `styles.ts`) the human may pick for this
   * artifact; the chosen style's art-direction is injected into `fromAgentKey`'s
   * system prompt at run start. Validated against this list at the API boundary.
   * Kept as `string[]` so this leaf package never imports @agentic-os/sectors.
   */
  styles?: string[];
  /** Style key applied when the human picks none. Conventionally 'auto'. */
  defaultStyleKey?: string;
  /** Server-controlled PDF options (NEVER agent-supplied). */
  pdf?: {
    /** Noun in the success message, e.g. 'report' | 'summary' | 'brochure'. Defaults to 'document'. */
    label?: string;
    /** Output filename prefix, e.g. 'finance' | 'clinical' | 'report' | 'brochure'. */
    basePrefix?: string;
    /** Default PDF <title> injected when the HTML lacks one. */
    title?: string;
    /** Page-number footer (off by default; conflicts with full-bleed covers). */
    footer?: { text?: string } | boolean;
  };
}

/** A domain bundle: the roster + which agent is the entry-point coordinator. */
export interface SectorPack {
  key: string;
  name: string;
  description: string;
  /** Key of the agent the human talks to (the CEO/Orchestrator). */
  coordinatorKey: string;
  agents: AgentDefinition[];
  /** Optional artifact rendering applied after the run completes. */
  finalize?: SectorFinalize;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Live agent status, mirrored to the dashboard ("working" / "waiting" / "idle"). */
export type AgentLiveStatus = 'idle' | 'working' | 'waiting';

export type OrchestrationEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'agent.started'
  | 'agent.message'
  | 'agent.tool_call'
  | 'agent.tool_result'
  | 'delegation.started'
  | 'delegation.completed'
  | 'approval.requested'
  | 'usage';

/** Everything that happens during a run is an event — the unit of the trace. */
export interface OrchestrationEvent {
  id: string;
  runId: string;
  /** ISO-8601 timestamp. */
  ts: string;
  type: OrchestrationEventType;
  /** The agent that emitted this event (e.g. "ceo" or a specialist key). */
  agentKey: string;
  /** For delegated work: the agent that initiated it. */
  parentAgentKey?: string;
  /** Type-specific payload (message text, tool name+args, usage numbers, …). */
  data: Record<string, unknown>;
}

/** Token usage + cost for a single model call. The basis of markup billing. */
export interface UsageRecord {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Raw provider cost in USD. */
  costUsd: number;
  /** Cost after the configured markup — what the tenant is billed. */
  billedUsd: number;
}
