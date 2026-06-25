/**
 * The generic agent loop. Every agent — the CEO and every specialist — runs
 * through this same function. It is provider-agnostic (talks to ModelRouter)
 * and tool-agnostic (talks to ToolRegistry).
 *
 * Loop: call model -> if it requests tools, run them and feed results back ->
 * repeat until the model returns a final text answer (or a safety limit trips).
 */
import type {
  AgentDefinition,
  AppConfig,
  OrchestrationEvent,
  OrchestrationEventType,
} from '@agentic-os/shared';
import { LimitError, newEventId } from '@agentic-os/shared';
import type { ModelRouter } from '@agentic-os/providers';
import { buildUsageRecord } from '@agentic-os/providers';
import type { LLMMessage } from '@agentic-os/providers';
import type { ToolContext, ToolRegistry } from '@agentic-os/tools';
import type { RunStore } from '../run/events.js';

/** Shared services every agent loop needs. */
export interface EngineDeps {
  router: ModelRouter;
  tools: ToolRegistry;
  store: RunStore;
  config: AppConfig;
}

/** Per-invocation arguments for one agent run. */
export interface RunAgentArgs {
  runId: string;
  agent: AgentDefinition;
  /** The instruction this agent must carry out. */
  task: string;
  /** The agent that delegated to this one (undefined for the top-level CEO). */
  parentAgentKey?: string;
  /** Delegation depth (0 = CEO). Guards against runaway recursion. */
  depth: number;
  /**
   * Run-scoped budget shared across every agent in the run. Tracks total model
   * calls and total billed USD so the loop can wind down on runaway spend/steps.
   * `capped` flips to true when the step limit is reached, so the orchestrator
   * finalizes with the best available output instead of failing the run.
   */
  budget: { count: number; spentUsd: number; capped?: boolean };
  /** Callback that runs another agent — provided by the Orchestrator. */
  invokeAgent: (agentKey: string, task: string, parentKey: string, depth: number) => Promise<string>;
}

export async function runAgent(deps: EngineDeps, args: RunAgentArgs): Promise<string> {
  const { router, tools, store, config } = deps;
  const { runId, agent, task, parentAgentKey, depth } = args;

  const emit = makeEmitter(store, runId, agent.key, parentAgentKey);
  emit('agent.started', { name: agent.name, tier: agent.tier, task });

  const messages: LLMMessage[] = [
    { role: 'system', content: agent.systemPrompt },
    { role: 'user', content: task },
  ];

  const toolDefs = tools.toToolDefs(agent.tools);

  // Tool execution context — the bridge from a tool back into the engine.
  const ctx: ToolContext = {
    runId,
    agentKey: agent.key,
    emit: (type, data) => emit(type as OrchestrationEventType, data),
    invokeAgent: (childKey, childTask) =>
      args.invokeAgent(childKey, childTask, agent.key, depth + 1),
    requestApproval: async (summary) => requestApproval(deps, runId, agent.key, summary, emit),
    log: consoleLogger,
  };

  // Best text this agent has produced so far. Returned if the step cap trips at
  // the top of the loop, so a capped agent still hands back its latest work.
  let lastAssistantText = '';

  while (true) {
    if (args.budget.count >= config.orchestration.maxAgentSteps) {
      // Step cap reached. STOP this agent gracefully instead of throwing, so the
      // orchestrator's finalize block still runs and the run yields a deliverable
      // (e.g. the already-rendered brochure HTML) rather than failing outright.
      args.budget.capped = true;
      emit('agent.message', { text: lastAssistantText, final: true, capped: true });
      return lastAssistantText || '[Run hit the step limit before this agent produced output.]';
    }
    args.budget.count += 1;

    const res = await router.chat(
      agent.tier,
      {
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        ...(agent.maxOutputTokens ? { maxTokens: agent.maxOutputTokens } : {}),
        // Schema-constrained output for JSON-emitting agents (e.g. the brochure
        // composer): forces a schema-valid reply when the provider supports it.
        ...(agent.responseSchema
          ? { responseFormat: { type: 'json_schema' as const, name: `${agent.key}_output`, schema: agent.responseSchema } }
          : {}),
      },
      agent.model, // per-agent model override (e.g. a stronger model for the designer)
    );

    // Record cost for billing/analytics.
    const usage = buildUsageRecord({
      provider: res.provider,
      model: res.model,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      markup: config.billing.markup,
    });
    await store.recordUsage(runId, agent.key, usage);
    emit('usage', { ...usage });

    // Runaway-spend guard: this stays a HARD stop — real money must not run away.
    args.budget.spentUsd += usage.billedUsd;
    const cap = config.security.maxRunBudgetUsd;
    if (cap > 0 && args.budget.spentUsd > cap) {
      throw new LimitError(
        `Run exceeded MAX_RUN_BUDGET_USD ($${cap}); spent $${args.budget.spentUsd.toFixed(4)}.`,
      );
    }

    messages.push(res.message);
    if (res.message.content) lastAssistantText = res.message.content;

    const toolCalls = res.message.toolCalls ?? [];
    if (toolCalls.length === 0) {
      // Final answer.
      emit('agent.message', { text: res.message.content, final: true });
      return res.message.content;
    }

    // The model wants to use tools. Run each and feed results back.
    if (res.message.content) emit('agent.message', { text: res.message.content, final: false });

    for (const call of toolCalls) {
      emit('agent.tool_call', { tool: call.name, args: call.arguments });
      const result = await executeTool(deps, ctx, call.name, call.arguments, emit);
      emit('agent.tool_result', { tool: call.name, result: truncate(result) });
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result,
      });
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function executeTool(
  deps: EngineDeps,
  ctx: ToolContext,
  name: string,
  rawArgs: Record<string, unknown>,
  emit: Emit,
): Promise<string> {
  if (!deps.tools.has(name)) return `Error: unknown tool "${name}".`;
  const tool = deps.tools.get(name);

  // Centralized permission gating: 'ask' tools go through the approval policy.
  if (tool.permission === 'ask') {
    const ok = await ctx.requestApproval(`${name}(${JSON.stringify(rawArgs)})`);
    if (!ok) return `Action "${name}" was denied by the approval policy.`;
  }

  try {
    return await tool.handler(rawArgs, ctx);
  } catch (err) {
    emit('agent.tool_result', { tool: name, error: (err as Error).message });
    return `Tool "${name}" failed: ${(err as Error).message}`;
  }
}

/**
 * Approval policy. In 'autonomous' mode (the default and the product's
 * differentiator) this approves immediately while still emitting the event so
 * the dashboard shows what the agent did. In 'supervised' mode a real
 * implementation would block on a human decision delivered via the EventBus —
 * left as a clearly-marked extension point.
 */
async function requestApproval(
  deps: EngineDeps,
  runId: string,
  agentKey: string,
  summary: string,
  emit: Emit,
): Promise<boolean> {
  emit('approval.requested', { summary, mode: deps.config.orchestration.mode });
  if (deps.config.orchestration.mode === 'autonomous') return true;
  // TODO(supervised): await a human decision (e.g. via a pending-approvals
  // queue + EventBus round-trip) instead of auto-approving.
  return true;
}

type Emit = (type: OrchestrationEventType, data: Record<string, unknown>) => void;

function makeEmitter(
  store: RunStore,
  runId: string,
  agentKey: string,
  parentAgentKey: string | undefined,
): Emit {
  return (type, data) => {
    const event: OrchestrationEvent = {
      id: newEventId(),
      runId,
      ts: new Date().toISOString(),
      type,
      agentKey,
      ...(parentAgentKey ? { parentAgentKey } : {}),
      data,
    };
    void store.appendEvent(event);
  };
}

function truncate(s: string, n = 600): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const consoleLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
