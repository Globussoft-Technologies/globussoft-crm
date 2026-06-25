/**
 * Server-side singleton engine for the web app. One in-memory engine per server
 * process — fine for local dev and demos. In production, the web app should
 * enqueue runs for the orchestrator worker (apps/orchestrator) and read state
 * from Postgres instead of holding the engine in-process.
 *
 * IMPORTANT: the engine is pinned on `globalThis`, not a plain module variable.
 * Next.js does not reliably share module-level state across different route
 * handlers, which would split the run store/event bus per route. globalThis is
 * process-global and shared.
 *
 * Only import this from route handlers / server components.
 */
import fs from 'node:fs';
import path from 'node:path';
import { type CapabilityTier, loadConfig } from '@agentic-os/shared';
import { type Engine, InMemoryRunStore, createEngine } from '@agentic-os/core';

const globalForEngine = globalThis as unknown as {
  __agenticEngine?: Engine;
  __agenticEnvLoaded?: boolean;
  __agenticRootDir?: string;
};

type RoutingSel = { providerId: string; model: string };
type RoutingFile = Partial<Record<CapabilityTier, RoutingSel>>;

/**
 * Next runs from apps/web and only auto-loads apps/web/.env. Our .env lives at
 * the monorepo root — find the nearest .env by walking up from cwd and load it.
 * Robust to whether cwd is apps/web or the repo root. Idempotent, best-effort.
 */
function ensureRootEnv(): void {
  if (globalForEngine.__agenticEnvLoaded) return;
  globalForEngine.__agenticEnvLoaded = true;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const envPath = path.join(dir, '.env');
    if (fs.existsSync(envPath)) {
      globalForEngine.__agenticRootDir = dir;
      try {
        process.loadEnvFile(envPath);
      } catch {
        /* unreadable — ignore */
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/** Where the UI's per-tier model selection is persisted (survives restarts). */
function overridesPath(): string {
  const dir = globalForEngine.__agenticRootDir ?? process.cwd();
  return path.join(dir, '.model-routing.json');
}

function readOverridesFile(): RoutingFile {
  try {
    return JSON.parse(fs.readFileSync(overridesPath(), 'utf8')) as RoutingFile;
  } catch {
    return {};
  }
}

export function getEngine(): Engine {
  if (!globalForEngine.__agenticEngine) {
    ensureRootEnv();
    const engine = createEngine(loadConfig());
    // Re-apply any UI model selections persisted from a previous session.
    const saved = readOverridesFile();
    for (const [tier, sel] of Object.entries(saved)) {
      if (sel?.providerId && sel?.model) engine.deps.router.setOverride(tier as CapabilityTier, sel);
    }
    globalForEngine.__agenticEngine = engine;
  }
  return globalForEngine.__agenticEngine;
}

/**
 * Apply a per-tier model selection from the UI: update the live router AND persist it
 * (so it survives a restart). Pass `null` to clear a tier back to its .env default.
 */
export function setRoutingOverride(tier: CapabilityTier, sel: RoutingSel | null): void {
  getEngine().deps.router.setOverride(tier, sel);
  const file = readOverridesFile();
  if (sel) file[tier] = sel;
  else delete file[tier];
  try {
    fs.writeFileSync(overridesPath(), JSON.stringify(file, null, 2), 'utf8');
  } catch {
    /* read-only fs — runtime override still applied, just not persisted */
  }
}

/** The in-memory store, for live streaming + analytics reads. */
export function getStore(): InMemoryRunStore {
  return getEngine().store as InMemoryRunStore;
}
