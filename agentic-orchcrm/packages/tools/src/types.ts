/**
 * Tool contract. A tool is a typed capability an agent can invoke. The engine
 * passes a ToolContext so a tool can: emit trace events, delegate to another
 * agent, or request human approval — without knowing how those are implemented.
 */
import type { JSONSchema, LLMToolDef } from '@agentic-os/providers';
import type { Logger, ToolPermission } from '@agentic-os/shared';

/** Capabilities the engine injects into every tool call. */
export interface ToolContext {
  runId: string;
  /** The agent invoking the tool. */
  agentKey: string;
  /** Emit a free-form trace event (surfaces in the dashboard / event log). */
  emit: (type: string, data: Record<string, unknown>) => void;
  /**
   * Run another agent on a sub-task and return its final text. This is how the
   * `delegate` tool hands work to a specialist. Provided by the orchestrator.
   */
  invokeAgent: (agentKey: string, task: string) => Promise<string>;
  /**
   * Ask for human approval of an action. In 'autonomous' mode this resolves
   * true immediately (minimal human-in-loop); in 'supervised' mode it can block
   * until a human responds.
   */
  requestApproval: (summary: string) => Promise<boolean>;
  log: Logger;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** 'auto' runs silently; 'ask' goes through requestApproval first. */
  permission: ToolPermission;
  handler(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<string>;
}

export type { LLMToolDef };
