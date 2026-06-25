/**
 * The `delegate` tool — the mechanism behind autonomous orchestration.
 *
 * The CEO/coordinator calls this to hand a self-contained sub-task to a
 * specialist. The handler simply asks the engine (via ctx.invokeAgent) to run
 * that specialist and returns its result back into the CEO's context. This is
 * what lets a human give ONE goal and have the CEO fan it out with no further
 * human input.
 */
import type { Tool } from '../types.js';

export const delegateTool: Tool = {
  name: 'delegate',
  description:
    'Hand a self-contained sub-task to a specialist agent and receive its result. ' +
    'Break the overall goal into parts and assign each to the most suitable specialist. ' +
    'Include ALL context the specialist needs in the task — specialists do not see this conversation.',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'The key of the specialist agent to delegate to.',
      },
      task: {
        type: 'string',
        description:
          'A clear, self-contained instruction for the specialist, including all needed context.',
      },
    },
    required: ['agent', 'task'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const agent = String(args.agent ?? '').trim();
    const task = String(args.task ?? '').trim();
    if (!agent || !task) return 'Error: both "agent" and "task" are required.';
    return ctx.invokeAgent(agent, task);
  },
};
