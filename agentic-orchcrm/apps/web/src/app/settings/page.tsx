'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, EmptyState, PageHeader, Spinner } from '@/components/ui';
import type { AppConfigView, CatalogModelView, ModelsView } from '@/lib/types';

/** Per-tier role hints shown beside each picker. */
const TIER_INFO: Record<string, { label: string; hint: string }> = {
  reasoning: { label: 'Reasoning', hint: 'CEO planning + the brochure composer (the JSON). The quality lever.' },
  balanced: { label: 'Balanced', hint: 'General analysis / mid-weight steps.' },
  fast: { label: 'Fast', hint: 'Research & tool-running — keep this cheap.' },
  writing: { label: 'Writing', hint: "Copywriting — the brochure's words." },
};

const STRATEGY_LABEL: Record<string, string> = {
  recommended: 'Recommended (Auto)',
  cheapest: 'Cheapest',
  smartest: 'Smartest',
  custom: 'Custom',
};
const STRATEGY_HINT: Record<string, string> = {
  recommended: 'Auto: capable models where the output is seen, cheap models for research/plumbing.',
  cheapest: 'Lowest cost on every tier.',
  smartest: 'Most capable model on every tier (premium).',
  custom: 'You choose each tier yourself below.',
};

/** Rough token mix of one brochure run, per tier — for the cost estimate. */
const TIER_TOKENS: Record<string, { input: number; output: number }> = {
  reasoning: { input: 16000, output: 7000 },
  fast: { input: 8000, output: 3000 },
  writing: { input: 5000, output: 2500 },
  balanced: { input: 2000, output: 1000 },
};

export default function SettingsPage() {
  const [cfg, setCfg] = useState<AppConfigView | null | 'error'>(null);
  const [models, setModels] = useState<ModelsView | null>(null);

  const refreshModels = () =>
    fetch('/api/models')
      .then((r) => r.json())
      .then((d: ModelsView) => setModels(d))
      .catch(() => {});

  useEffect(() => {
    fetch('/api/config').then((r) => r.json()).then((d: AppConfigView) => setCfg(d)).catch(() => setCfg('error'));
    refreshModels();
  }, []);

  const byId = useMemo(() => {
    const m = new Map<string, CatalogModelView>();
    models?.models.forEach((x) => m.set(x.id, x));
    return m;
  }, [models]);

  async function post(body: Record<string, unknown>, optimistic?: () => void) {
    optimistic?.();
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) setModels((await res.json()) as ModelsView);
    else refreshModels();
  }

  const choose = (tier: string, model: string | null) =>
    post({ tier, model }, () =>
      setModels((prev) => (prev ? { ...prev, selection: { ...prev.selection, [tier]: model ?? prev.defaults[tier] ?? '' }, strategy: 'custom' } : prev)),
    );

  const chooseStrategy = (strategy: string) => {
    if (strategy === 'custom') {
      setModels((prev) => (prev ? { ...prev, strategy: 'custom' } : prev));
      return;
    }
    post({ strategy }, () => setModels((prev) => (prev ? { ...prev, strategy } : prev)));
  };

  const runCost = useMemo(() => {
    if (!models) return null;
    let cost = 0;
    let known = true;
    for (const tier of Object.keys(TIER_TOKENS)) {
      const m = byId.get(models.selection[tier] ?? '');
      if (!m) { known = false; continue; }
      const t = TIER_TOKENS[tier]!;
      cost += (t.input / 1e6) * m.inputPer1M + (t.output / 1e6) * m.outputPer1M;
    }
    return { cost, known };
  }, [models, byId]);

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Switch models per capability tier — applied live, no restart. Other config is read-only (.env)."
      />

      {cfg === null ? (
        <Card><Spinner label="Loading config…" /></Card>
      ) : cfg === 'error' ? (
        <Card><EmptyState title="Couldn't load config" /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* ── Model routing (interactive) ── */}
          <Card title="Model routing" className="lg:col-span-2">
            {!models ? (
              <Spinner label="Loading models…" />
            ) : (
              <>
                <p className="-mt-1 mb-3 text-xs text-muted">
                  Each capability tier resolves to the model you pick here. Only models reachable with your
                  configured keys are shown. <span className="text-slate-300">Smart</span> = capability ·{' '}
                  <span className="text-slate-300">Value</span> = cost-efficiency.
                </p>

                {/* Strategy preset */}
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel2 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-100">Strategy</div>
                    <div className="mt-0.5 text-[11px] leading-snug text-muted">{STRATEGY_HINT[models.strategy] ?? STRATEGY_HINT.custom}</div>
                  </div>
                  <select
                    value={models.strategy}
                    onChange={(e) => chooseStrategy(e.target.value)}
                    className="shrink-0 rounded-lg border border-edge bg-panel px-3 py-2 text-sm text-slate-100 outline-none transition hover:border-accent/40 focus:border-accent"
                  >
                    {(models.strategies ?? ['recommended', 'cheapest', 'smartest', 'custom']).map((s) => (
                      <option key={s} value={s}>
                        {STRATEGY_LABEL[s] ?? s}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {models.tiers.map((tier) => (
                    <TierPicker
                      key={tier}
                      tier={tier}
                      models={models.models}
                      currentId={models.selection[tier]!}
                      isDefault={!models.overridden[tier]}
                      defaultId={models.defaults[tier]!}
                      onChoose={(m) => choose(tier, m)}
                    />
                  ))}
                </div>
                {runCost && (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel2 px-4 py-3">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted">Estimated cost · one brochure run</div>
                      <div className="mt-0.5 text-[11px] text-muted">~31k in + 13.5k out across tiers, at your selected models</div>
                    </div>
                    <div className="text-right">
                      <div className="font-display text-2xl font-semibold tabular-nums text-slate-100">
                        {runCost.known ? `$${runCost.cost.toFixed(3)}` : '—'}
                      </div>
                      <div className="text-[11px] text-muted tabular-nums">
                        billed ≈ ${(runCost.cost * cfg.billing.markup).toFixed(3)} ({cfg.billing.markup}×)
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>

          {/* ── Providers ── */}
          <Card title="Providers">
            {cfg.providers.length === 0 ? (
              <EmptyState title="No provider keys configured" hint="Set one in .env (e.g. OPENAI_API_KEY)." />
            ) : (
              <ul className="space-y-2">
                {cfg.providers.map((p) => (
                  <li key={p.id} className="flex items-center justify-between rounded-lg border border-edge bg-panel2 px-3 py-2">
                    <span className="flex items-center gap-2 text-sm text-slate-200">
                      <span className="h-1.5 w-1.5 rounded-full bg-good" />
                      {p.id}
                    </span>
                    <span className="font-mono text-xs text-muted">{p.baseUrl}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted">Keys are never exposed by the API — only which providers are active.</p>
          </Card>

          {/* ── Orchestration ── */}
          <Card title="Orchestration">
            <dl className="space-y-1.5 text-sm">
              <KV k="Mode" v={cfg.orchestration.mode} />
              <KV k="Default sector" v={cfg.orchestration.defaultSector} />
              <KV k="Max delegation depth" v={String(cfg.orchestration.maxDelegationDepth)} />
              <KV k="Max agent steps" v={String(cfg.orchestration.maxAgentSteps)} />
            </dl>
          </Card>

          {/* ── Safety & billing ── */}
          <Card title="Safety & billing" className="lg:col-span-2">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-sm md:grid-cols-3">
              <KV k="Max run budget" v={`$${cfg.security.maxRunBudgetUsd}`} />
              <KV k="Max concurrent runs" v={String(cfg.security.maxConcurrentRuns)} />
              <KV k="Rate limit" v={`${cfg.security.rateLimitPerMinute}/min`} />
              <KV k="Max goal length" v={`${cfg.security.maxGoalChars} chars`} />
              <KV k="Billing markup" v={`${cfg.billing.markup}×`} />
            </dl>
          </Card>
        </div>
      )}
    </>
  );
}

/** One capability tier with its current model + a rich dropdown of choices. */
function TierPicker({
  tier,
  models,
  currentId,
  isDefault,
  defaultId,
  onChoose,
}: {
  tier: string;
  models: CatalogModelView[];
  currentId: string;
  isDefault: boolean;
  defaultId: string;
  onChoose: (model: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const info = TIER_INFO[tier] ?? { label: tier, hint: '' };
  const current = models.find((m) => m.id === currentId);
  const available = models.filter((m) => m.available);

  return (
    <div className="relative rounded-xl border border-edge bg-panel2 p-3.5 transition hover:border-accent/30">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold capitalize text-slate-100">{info.label}</div>
        {!isDefault && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">custom</span>}
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-muted">{info.hint}</p>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-2.5 flex w-full items-center justify-between gap-2 rounded-lg border border-edge bg-panel px-3 py-2 text-left transition hover:border-accent/40"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm text-slate-100">{current ? current.label : currentId}</span>
          <span className="block truncate font-mono text-[10px] text-muted">{currentId}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {current && <Pips value={current.intelligence} tone="accent" />}
          <svg width="14" height="14" viewBox="0 0 24 24" className={`text-muted transition ${open ? 'rotate-180' : ''}`}>
            <path fill="currentColor" d="M7 10l5 5 5-5z" />
          </svg>
        </span>
      </button>

      {current && (
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
          <div className="flex items-center gap-3">
            <Rating label="Smart" value={current.intelligence} tone="accent" />
            <Rating label="Value" value={current.costEff} tone="good" />
          </div>
          <span className="font-mono text-muted">
            ${current.inputPer1M}/${current.outputPer1M}<span className="text-muted/60"> /1M</span>
          </span>
        </div>
      )}

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-3 right-3 top-[4.5rem] z-20 max-h-80 overflow-auto rounded-xl border border-edge bg-panel shadow-card">
            {!isDefault && (
              <button
                type="button"
                onClick={() => { onChoose(null); setOpen(false); }}
                className="block w-full border-b border-edge px-3 py-2 text-left text-xs text-muted hover:bg-panel2"
              >
                ↺ Reset to .env default <span className="font-mono text-slate-300">{defaultId}</span>
              </button>
            )}
            {available.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted">No models reachable with the configured keys.</div>
            ) : (
              available.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { onChoose(m.id); setOpen(false); }}
                  className={`block w-full px-3 py-2.5 text-left transition hover:bg-panel2 ${m.id === currentId ? 'bg-panel2' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className="text-sm text-slate-100">{m.label}</span>
                      <span className="rounded bg-edge px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted">{m.provider}</span>
                      {m.id === currentId && <span className="text-[10px] text-accent">● selected</span>}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted">${m.inputPer1M}/${m.outputPer1M}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-3">
                    <Rating label="Smart" value={m.intelligence} tone="accent" />
                    <Rating label="Value" value={m.costEff} tone="good" />
                  </div>
                  <div className="mt-1 text-[10px] leading-snug text-muted">{m.blurb}</div>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Rating({ label, value, tone }: { label: string; value: number; tone: 'accent' | 'good' }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <Pips value={value} tone={tone} />
    </span>
  );
}

/** Five-segment rating meter. */
function Pips({ value, tone }: { value: number; tone: 'accent' | 'good' }) {
  const on = tone === 'good' ? 'bg-good' : 'bg-accent';
  return (
    <span className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={`h-1.5 w-2.5 rounded-sm ${i <= value ? on : 'bg-edge'}`} />
      ))}
    </span>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-edge/40 pb-1.5 last:border-0">
      <dt className="capitalize text-muted">{k}</dt>
      <dd className="text-right text-slate-200">{v}</dd>
    </div>
  );
}
