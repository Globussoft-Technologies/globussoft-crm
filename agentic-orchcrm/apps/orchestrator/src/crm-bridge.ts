/**
 * crm-bridge.ts — the entry point the Globussoft CRM's
 * `backend/services/brochureEngineBridge.js` spawns to drive the brochure engine.
 *
 * TWO MODES, selected by env:
 *
 * 1. RUN (default) — generate ONE brochure.
 *    IN  — the brief as a JSON string in `BROCHURE_BRIEF`:
 *          { runId?, sectorKey, goal, styleKey?, brand?, models?, strategy? }
 *          • models   — optional per-tier model id map (switchable models),
 *                       e.g. { reasoning, balanced, fast, writing } from the catalog.
 *          • strategy — optional preset ('recommended'|'cheapest'|'smartest'),
 *                       applied only when `models` is absent.
 *    OUT — every engine event as one JSON line on STDERR (the bridge forwards
 *          these to its live trace), and exactly ONE final JSON object on STDOUT
 *          (the bridge reads the LAST non-empty stdout line):
 *            { ok: true,  runId, result, billedUsd }   on success
 *            { ok: false, runId?, error }              on failure
 *
 * 2. CATALOG — set env `BROCHURE_MODE=catalog` (no brief needed). Prints the
 *    model catalog the CRM's picker + pre-run cost estimator need, on STDOUT:
 *      { ok: true, tiers, strategies, defaults, models:[{ id,label,provider,
 *        available, intelligence, costEff, inputPer1M, outputPer1M, blurb }] }
 *    `available` reflects which providers the configured keys can actually reach.
 *
 * Nothing else may be written to STDOUT in either mode.
 *
 * Invoked as:
 *   node <engineRoot>/node_modules/tsx/dist/cli.mjs <engineRoot>/apps/orchestrator/src/crm-bridge.ts
 * with cwd = <engineRoot> and env including BROCHURE_BRIEF (or BROCHURE_MODE) and
 * ≥1 provider key (in <engineRoot>/.env or inherited from the CRM backend).
 *
 * The PDF is written to GENERATED_DIR (defaults to <cwd>/public/generated) and the
 * result string carries its `/generated/<file>.pdf` URL, which the bridge re-maps to
 * the CRM's `/api/brochure-assets/<file>`.
 *
 * The `brand` kit is passed through verbatim — the CRM route layer is the trust
 * boundary and must sanitise it (logo magic-byte check, length caps, clamped
 * placement) before it reaches this bridge.
 */
import {
  type AppConfig,
  type CapabilityTier,
  type OrchestrationEvent,
  loadConfig,
  newRunId,
} from '@agentic-os/shared';
import { InMemoryRunStore, createEngine } from '@agentic-os/core';
import { MODEL_CATALOG, type LogicalProvider, costEffOf, priceOf } from '@agentic-os/providers';
import type { BrandKit } from '@agentic-os/tools';

// Load the engine's own .env (cwd = engine root). Best-effort: the spawn also
// inherits the CRM backend's environment, so a provider key set there works too.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — rely on the inherited environment */
}

// Keep STDOUT pristine: the CRM bridge reads the final result as the LAST stdout
// line, so route EVERY other write (the engine's logger banners, any console.log)
// to STDERR. Only `finish()` uses the captured real stdout for the result line.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
  (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;

/** One engine event → one JSON line on stderr. */
function emitEvent(e: unknown): void {
  process.stderr.write(`${JSON.stringify(e)}\n`);
}

/** Write the single final result line to the REAL stdout, flush, then exit. */
function finish(payload: Record<string, unknown>, code: number): void {
  realStdoutWrite(`${JSON.stringify(payload)}\n`, () => process.exit(code));
}

const TIERS: CapabilityTier[] = ['reasoning', 'balanced', 'fast', 'writing'];
const STRATEGIES = ['recommended', 'cheapest', 'smartest', 'custom'] as const;
type Strategy = (typeof STRATEGIES)[number];

/**
 * Map each LOGICAL provider to a CONCRETE registered provider id, inferring what
 * the generic `openai-compatible` slot serves from its base URL. Only providers
 * with a configured key appear. (Mirrors apps/web/src/app/api/models/route.ts.)
 */
function activeProviders(config: AppConfig): Map<LogicalProvider, string> {
  const map = new Map<LogicalProvider, string>();
  const p = config.providers;
  if (p.openai.apiKey) map.set('openai', 'openai');
  if (p.moonshot.apiKey) map.set('moonshot', 'moonshot');
  if (p.xai.apiKey) map.set('xai', 'xai');
  if (p.groq.apiKey) map.set('groq', 'groq');
  if (p.openaiCompatible.apiKey) {
    const u = (p.openaiCompatible.baseUrl || '').toLowerCase();
    const add = (l: LogicalProvider) => {
      if (!map.has(l)) map.set(l, 'openai-compatible');
    };
    if (u.includes('groq')) add('groq');
    else if (u.includes('deepseek')) add('deepseek');
    else if (u.includes('generativelanguage') || u.includes('gemini')) add('gemini');
    else if (u.includes('x.ai')) add('xai');
    else if (u.includes('moonshot') || u.includes('kimi')) add('moonshot');
    else if (u.includes('openai.com')) add('openai');
  }
  return map;
}

/** The model catalog filtered to availability, each with ratings + price. */
function catalogView(config: AppConfig) {
  const active = activeProviders(config);
  return MODEL_CATALOG.map((m) => {
    const concrete = active.get(m.provider) ?? null;
    const price = priceOf(m.id);
    return {
      id: m.id,
      label: m.label,
      provider: m.provider,
      blurb: m.blurb,
      available: !!concrete,
      concreteProvider: concrete,
      intelligence: m.intelligence,
      costEff: costEffOf(m.id),
      inputPer1M: price.input,
      outputPer1M: price.output,
    };
  });
}
type ModelView = ReturnType<typeof catalogView>[number];
const blended = (m: ModelView) => m.inputPer1M + m.outputPer1M;

/** Per-tier model ids for a strategy preset (null for 'custom' / nothing available). */
function strategyAssignment(models: ModelView[], strategy: Strategy): Record<CapabilityTier, string> | null {
  const avail = models.filter((m) => m.available);
  if (!avail.length || strategy === 'custom') return null;
  const cheapest = [...avail].sort((a, b) => blended(a) - blended(b) || b.intelligence - a.intelligence)[0]!;
  const smartest = [...avail].sort((a, b) => b.intelligence - a.intelligence || blended(b) - blended(a))[0]!;
  const balanced = [...avail].sort(
    (a, b) => b.intelligence * 2 + b.costEff - (a.intelligence * 2 + a.costEff) || blended(a) - blended(b),
  )[0]!;
  if (strategy === 'cheapest') return { reasoning: cheapest.id, balanced: cheapest.id, fast: cheapest.id, writing: cheapest.id };
  if (strategy === 'smartest') return { reasoning: smartest.id, balanced: smartest.id, fast: smartest.id, writing: smartest.id };
  return { reasoning: balanced.id, balanced: balanced.id, fast: cheapest.id, writing: balanced.id };
}

interface Brief {
  runId?: string;
  sectorKey?: string;
  goal?: string;
  styleKey?: string;
  brand?: BrandKit;
  /** Per-tier model id (switchable models); takes precedence over `strategy`. */
  models?: Partial<Record<CapabilityTier, string>>;
  /** A preset applied when `models` is absent. */
  strategy?: string;
}

/** A router with the override hook used to switch models per run. */
interface RoutingRouter {
  setOverride(tier: CapabilityTier, sel: { providerId: string; model: string } | null): void;
}

/** Apply the brief's per-tier model selection (or strategy preset) to the router. */
function applyRouting(config: AppConfig, router: RoutingRouter, brief: Brief): void {
  const active = activeProviders(config);
  const setTier = (tier: CapabilityTier, modelId: string | undefined): void => {
    if (!modelId) return;
    const entry = MODEL_CATALOG.find((m) => m.id === modelId);
    const concrete = entry && active.get(entry.provider);
    if (entry && concrete) router.setOverride(tier, { providerId: concrete, model: entry.id });
  };
  if (brief.models && typeof brief.models === 'object') {
    for (const t of TIERS) setTier(t, brief.models[t]);
    return;
  }
  if (brief.strategy && (STRATEGIES as readonly string[]).includes(brief.strategy) && brief.strategy !== 'custom') {
    const assign = strategyAssignment(catalogView(config), brief.strategy as Strategy);
    if (assign) for (const t of TIERS) setTier(t, assign[t]);
  }
}

async function main(): Promise<void> {
  // ── CATALOG MODE ── print the model catalog for the CRM's picker + cost estimator.
  if (process.env.BROCHURE_MODE === 'catalog') {
    const config = loadConfig();
    return finish(
      { ok: true, tiers: TIERS, strategies: STRATEGIES, defaults: config.models, models: catalogView(config) },
      0,
    );
  }

  // ── RUN MODE ──
  const raw = process.env.BROCHURE_BRIEF;
  if (!raw) return finish({ ok: false, error: 'BROCHURE_BRIEF env var is not set' }, 1);

  let brief: Brief;
  try {
    brief = JSON.parse(raw) as Brief;
  } catch {
    return finish({ ok: false, error: 'BROCHURE_BRIEF is not valid JSON' }, 1);
  }

  const sectorKey = String(brief.sectorKey ?? '').trim();
  const goal = String(brief.goal ?? '').trim();
  const runId = brief.runId || newRunId();
  if (!sectorKey || !goal) {
    return finish({ ok: false, runId, error: 'brief requires both sectorKey and goal' }, 1);
  }

  const config = loadConfig();
  const { orchestrator, store, deps } = createEngine(config);
  // Per-run model switching: apply the brief's selection BEFORE the run.
  applyRouting(config, deps.router as RoutingRouter, brief);
  const inMem = store as InMemoryRunStore;

  // Stream every event for THIS run to stderr (the bridge tails stderr line-by-line).
  inMem.bus.subscribe(runId, (e: OrchestrationEvent) => emitEvent(e));

  try {
    const { result } = await orchestrator.run({
      runId,
      sectorKey,
      goal,
      ...(brief.styleKey ? { styleKey: brief.styleKey } : {}),
      ...(brief.brand ? { brand: brief.brand } : {}),
    });
    finish({ ok: true, runId, result, billedUsd: inMem.getBilledTotal(runId) }, 0);
  } catch (err) {
    const message = (err as Error)?.message || 'engine run failed';
    emitEvent({ type: 'run.failed', agentKey: 'system', data: { error: message } });
    finish({ ok: false, runId, error: message }, 1);
  }
}

void main();
