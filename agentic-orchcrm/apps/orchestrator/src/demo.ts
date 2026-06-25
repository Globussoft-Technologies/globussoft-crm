/**
 * End-to-end CLI demo. Runs ONE goal through the CEO orchestrator and prints
 * the live trace (CEO planning → delegating to specialists → final answer) plus
 * the billed cost. Uses the in-memory store, so it needs only a provider key.
 *
 *   npm run demo                      # default goal, default sector
 *   npm run demo -- "Write a brief on X"
 *   DEFAULT_SECTOR=finance npm run demo -- "Assess the risk of Y"
 */
import { loadConfig, newRunId, type OrchestrationEvent } from '@agentic-os/shared';
import { InMemoryRunStore, createEngine } from '@agentic-os/core';

// Load .env (Node 20.12+). Harmless if the file is absent.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env — rely on the ambient environment */
}

const config = loadConfig();
const { orchestrator, store } = createEngine(config);
const inMem = store as InMemoryRunStore;

const runId = newRunId();
inMem.bus.subscribe(runId, printEvent);

const goal =
  process.argv.slice(2).join(' ') ||
  'Write a concise 200-word brief on the business benefits of multi-agent AI orchestration.';
const sectorKey = config.orchestration.defaultSector;

console.log(`\n▶  Sector: ${sectorKey}   Mode: ${config.orchestration.mode}`);
console.log(`▶  Goal:   ${goal}\n`);

try {
  const { result } = await orchestrator.run({ runId, sectorKey, goal });
  console.log('\n' + '─'.repeat(72));
  console.log('FINAL DELIVERABLE\n');
  console.log(result);
  console.log('\n' + '─'.repeat(72));
  console.log(`Billed (incl. ${config.billing.markup}x markup): $${inMem.getBilledTotal(runId).toFixed(4)}`);
} catch (err) {
  console.error(`\n✖  Run failed: ${(err as Error).message}`);
  process.exitCode = 1;
}

// ── pretty trace printer ───────────────────────────────────────────────────
function printEvent(e: OrchestrationEvent): void {
  const who = e.parentAgentKey ? `${e.parentAgentKey} → ${e.agentKey}` : e.agentKey;
  switch (e.type) {
    case 'agent.started':
      console.log(`◆ ${who} started`);
      break;
    case 'delegation.started':
      console.log(`  ↳ delegate to ${e.agentKey}: ${String((e.data as any).task).slice(0, 80)}`);
      break;
    case 'agent.tool_call':
      console.log(`    · ${e.agentKey} calls ${String((e.data as any).tool)}`);
      break;
    case 'agent.message':
      if ((e.data as any).final) console.log(`  ✓ ${e.agentKey} produced its result`);
      break;
    case 'usage': {
      const d = e.data as any;
      console.log(`    [${d.model} | in ${d.inputTokens} / out ${d.outputTokens} | $${Number(d.billedUsd).toFixed(4)}]`);
      break;
    }
    case 'run.failed':
      console.log(`✖ run failed: ${String((e.data as any).error)}`);
      break;
    default:
      break;
  }
}
