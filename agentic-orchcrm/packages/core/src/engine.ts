/**
 * Engine assembly. One call wires providers + router + tools + store into a
 * ready-to-use Orchestrator. Apps call this and then `orchestrator.run(...)`.
 */
import type { AppConfig } from '@agentic-os/shared';
import { ModelRouter, buildProviderRegistry } from '@agentic-os/providers';
import { buildDefaultRegistry, type Tool } from '@agentic-os/tools';
import type { EngineDeps } from './agent/agent-loop.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { InMemoryRunStore, type RunStore } from './run/events.js';

export interface Engine {
  orchestrator: Orchestrator;
  deps: EngineDeps;
  /** The run store in use (in-memory unless a store was injected). */
  store: RunStore;
}

export interface CreateEngineOptions {
  /** Inject a persistent store (e.g. Postgres) instead of the in-memory default. */
  store?: RunStore;
  /** Extra tools to register on top of the built-ins. */
  extraTools?: Tool[];
}

export function createEngine(config: AppConfig, opts: CreateEngineOptions = {}): Engine {
  const registry = buildProviderRegistry(config);
  const router = new ModelRouter(registry, config);
  const tools = buildDefaultRegistry(opts.extraTools ?? []);
  const store = opts.store ?? new InMemoryRunStore();

  const deps: EngineDeps = { router, tools, store, config };
  return { orchestrator: new Orchestrator(deps), deps, store };
}
