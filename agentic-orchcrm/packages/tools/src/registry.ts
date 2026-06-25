/**
 * ToolRegistry — a name-keyed catalog of tools. Agents reference tools by name
 * in their definition; the engine asks the registry for the subset an agent is
 * allowed to use and converts them to provider tool-defs.
 */
import { ToolError } from '@agentic-os/shared';
import type { LLMToolDef, Tool } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: Tool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError(`Unknown tool: ${name}`);
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** The provider-facing tool definitions for a set of allowed tool names. */
  toToolDefs(names: string[]): LLMToolDef[] {
    return names
      .filter((n) => this.tools.has(n))
      .map((n) => {
        const t = this.get(n);
        return { name: t.name, description: t.description, parameters: t.parameters };
      });
  }
}
