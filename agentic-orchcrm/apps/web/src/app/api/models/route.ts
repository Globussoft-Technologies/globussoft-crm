/**
 * GET  /api/models — the model catalog filtered to what the configured keys can reach,
 *                    each with ratings (intelligence + cost-efficiency) and price, plus
 *                    the current per-tier selection.
 * POST /api/models — set (or reset) the model for a capability tier. Live + persisted,
 *                    no restart. Body: { tier, model }  (model:null/'' resets to default).
 * NEVER returns secrets — only provider availability.
 */
import type { AppConfig, CapabilityTier } from '@agentic-os/shared';
import { MODEL_CATALOG, type LogicalProvider, costEffOf, priceOf } from '@agentic-os/providers';
import { getEngine, setRoutingOverride } from '@/lib/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIERS: CapabilityTier[] = ['reasoning', 'balanced', 'fast', 'writing'];

/**
 * Map each LOGICAL provider to a CONCRETE registered provider id, inferring what the
 * generic `openai-compatible` slot actually serves from its base URL. Only providers
 * with a configured key appear.
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

type ModelView = ReturnType<typeof catalogView>[number];
const STRATEGIES = ['recommended', 'cheapest', 'smartest', 'custom'] as const;
type Strategy = (typeof STRATEGIES)[number];

const blended = (m: ModelView) => m.inputPer1M + m.outputPer1M;

/** Per-tier model ids for a strategy (null for 'custom' or when nothing is available). */
function strategyAssignment(models: ModelView[], strategy: Strategy): Record<CapabilityTier, string> | null {
  const avail = models.filter((m) => m.available);
  if (!avail.length || strategy === 'custom') return null;
  const cheapest = [...avail].sort((a, b) => blended(a) - blended(b) || b.intelligence - a.intelligence)[0]!;
  const smartest = [...avail].sort((a, b) => b.intelligence - a.intelligence || blended(b) - blended(a))[0]!;
  // Best balance: weight capability, then value, then cheaper.
  const balanced = [...avail].sort(
    (a, b) => b.intelligence * 2 + b.costEff - (a.intelligence * 2 + a.costEff) || blended(a) - blended(b),
  )[0]!;
  if (strategy === 'cheapest') return { reasoning: cheapest.id, balanced: cheapest.id, fast: cheapest.id, writing: cheapest.id };
  if (strategy === 'smartest') return { reasoning: smartest.id, balanced: smartest.id, fast: smartest.id, writing: smartest.id };
  // recommended: capable models where the output is SEEN, cheap for plumbing.
  return { reasoning: balanced.id, balanced: balanced.id, fast: cheapest.id, writing: balanced.id };
}

/** Which strategy the current selection matches (else 'custom'). */
function detectStrategy(models: ModelView[], selection: Record<string, string>): Strategy {
  for (const s of ['cheapest', 'smartest', 'recommended'] as const) {
    const a = strategyAssignment(models, s);
    if (a && TIERS.every((t) => selection[t] === a[t])) return s;
  }
  return 'custom';
}

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

export function GET() {
  const { config, router } = getEngine().deps;
  const overrides = router.getOverrides();
  const models = catalogView(config);
  const selection: Record<string, string> = {};
  const overridden: Record<string, boolean> = {};
  for (const t of TIERS) {
    const o = overrides[t];
    selection[t] = o ? o.model : config.models[t];
    overridden[t] = !!o;
  }
  return Response.json({
    tiers: TIERS,
    models,
    selection,
    overridden,
    defaults: config.models,
    strategy: detectStrategy(models, selection),
    strategies: STRATEGIES,
  });
}

export async function POST(req: Request) {
  const { config } = getEngine().deps;
  let body: { tier?: string; model?: string | null; strategy?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  // Strategy preset: assign all tiers at once (Recommended / Cheapest / Smartest).
  if (body.strategy) {
    const strat = body.strategy as Strategy;
    if (!STRATEGIES.includes(strat)) return Response.json({ error: 'invalid strategy' }, { status: 400 });
    if (strat !== 'custom') {
      const assign = strategyAssignment(catalogView(config), strat);
      if (!assign) return Response.json({ error: 'no models available' }, { status: 400 });
      const active = activeProviders(config);
      for (const t of TIERS) {
        const entry = MODEL_CATALOG.find((m) => m.id === assign[t]);
        const concrete = entry && active.get(entry.provider);
        if (entry && concrete) setRoutingOverride(t, { providerId: concrete, model: entry.id });
      }
    }
    return GET();
  }

  const tier = body.tier as CapabilityTier;
  if (!TIERS.includes(tier)) return Response.json({ error: 'invalid tier' }, { status: 400 });

  // Reset to the .env default.
  if (!body.model) {
    setRoutingOverride(tier, null);
    return GET();
  }

  const entry = MODEL_CATALOG.find((m) => m.id === body.model);
  if (!entry) return Response.json({ error: 'unknown model' }, { status: 400 });
  const concrete = activeProviders(config).get(entry.provider);
  if (!concrete) {
    return Response.json({ error: `no configured key for ${entry.provider}` }, { status: 400 });
  }
  setRoutingOverride(tier, { providerId: concrete, model: entry.id });
  return GET();
}
