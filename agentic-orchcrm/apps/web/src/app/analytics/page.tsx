'use client';

import { useEffect, useState } from 'react';
import { Bar, Card, EmptyState, PageHeader, StatTile } from '@/components/ui';
import { formatTokens, formatUsd } from '@/lib/format';
import type { Analytics } from '@/lib/types';

const COST_HINT =
  'Estimated at provider list prices — not an actual charge (your key may be free). Token counts are exact.';

export default function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetch('/api/analytics')
        .then((r) => r.json())
        .then((d: Analytics) => active && setData(d))
        .catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  const t = data?.totals;
  const models = data?.models ?? [];
  const maxCost = Math.max(1e-9, ...models.map((m) => m.costUsd));
  const maxTok = Math.max(1, ...models.map((m) => m.inputTokens + m.outputTokens));

  return (
    <>
      <PageHeader title="Analytics" subtitle="Usage, cost estimates, and model activity across all runs." />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile
          label="Runs"
          value={t?.runs ?? 0}
          sub={t ? `${t.completed} done · ${t.failed} failed` : '—'}
        />
        <StatTile label="Model calls" value={t?.calls ?? 0} />
        <StatTile
          label="Total tokens"
          value={formatTokens((t?.inputTokens ?? 0) + (t?.outputTokens ?? 0))}
          sub={t ? `↑${formatTokens(t.inputTokens)} ↓${formatTokens(t.outputTokens)}` : '—'}
        />
        <StatTile label="Est. cost" value={formatUsd(t?.costUsd ?? 0)} sub="not billed" hint={COST_HINT} />
        <StatTile
          label="Billable"
          value={formatUsd(t?.billedUsd ?? 0)}
          sub="cost × markup"
          hint="What you'd charge tenants at the configured markup."
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Estimated cost by model">
          {models.length === 0 ? (
            <EmptyState title="No usage yet" hint="Run a goal to populate analytics." />
          ) : (
            models.map((m) => (
              <Bar
                key={m.model}
                label={m.model}
                value={m.costUsd}
                max={maxCost}
                valueLabel={`${formatUsd(m.costUsd)} · ${m.calls} calls`}
              />
            ))
          )}
        </Card>

        <Card title="Tokens by model">
          {models.length === 0 ? (
            <EmptyState title="No usage yet" />
          ) : (
            models.map((m) => (
              <Bar
                key={m.model}
                tone="accent2"
                label={m.model}
                value={m.inputTokens + m.outputTokens}
                max={maxTok}
                valueLabel={`${formatTokens(m.inputTokens + m.outputTokens)} tok`}
              />
            ))
          )}
        </Card>
      </div>
    </>
  );
}
