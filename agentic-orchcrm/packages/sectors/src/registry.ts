/**
 * Sector registry. The single place that knows all available packs. Add a pack
 * here and it's instantly selectable across the engine and the dashboard.
 */
import type { AgentDefinition, SectorPack } from '@agentic-os/shared';
import { reportWritingPack } from './packs/report-writing.js';
import { financePack } from './packs/finance.js';
import { healthcarePack } from './packs/healthcare.js';
import { travelPack } from './packs/travel.js';

const PACKS: SectorPack[] = [reportWritingPack, travelPack, financePack, healthcarePack];

const byKey = new Map(PACKS.map((p) => [p.key, p]));

/**
 * Sectors shown in the UI pickers/listings. Focused on TRAVEL for now — the other
 * packs remain registered and runnable (getSectorPack works), just hidden from the UI.
 * To bring them back, return `[...PACKS]`.
 */
export function listSectorPacks(): SectorPack[] {
  return PACKS.filter((p) => p.key === 'travel');
}

/** Look up a pack by key, throwing if unknown. */
export function getSectorPack(key: string): SectorPack {
  const pack = byKey.get(key);
  if (!pack) {
    throw new Error(
      `Unknown sector pack "${key}". Available: ${[...byKey.keys()].join(', ')}`,
    );
  }
  return pack;
}

/** Find one agent definition within a pack. */
export function getAgent(pack: SectorPack, agentKey: string): AgentDefinition {
  const agent = pack.agents.find((a) => a.key === agentKey);
  if (!agent) {
    throw new Error(`Pack "${pack.key}" has no agent "${agentKey}".`);
  }
  return agent;
}
