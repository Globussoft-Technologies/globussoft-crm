/**
 * Prefixed, sortable-ish id generation. Prefixes make ids self-describing in
 * logs and the DB (run_…, evt_…, usg_…). Uses crypto.randomUUID under the hood.
 */
import { randomUUID } from 'node:crypto';

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export const newRunId = () => id('run');
export const newEventId = () => id('evt');
export const newUsageId = () => id('usg');
export const newAgentRunId = () => id('arun');
