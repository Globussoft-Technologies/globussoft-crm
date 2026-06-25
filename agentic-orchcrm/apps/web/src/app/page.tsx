'use client';

import { useEffect, useMemo, useState } from 'react';
import { AgentNetwork } from '@/components/AgentNetwork';
import { CommandConsole } from '@/components/CommandConsole';
import { TraceConsole } from '@/components/TraceConsole';
import { DeliverablePanel } from '@/components/DeliverablePanel';
import { Card, EmptyState, PageHeader, StatTile } from '@/components/ui';
import { useOrchestration } from '@/lib/useOrchestration';
import { formatTokens, formatUsd } from '@/lib/format';
import type { UiPack } from '@/lib/types';

const COST_HINT =
  'Estimated at provider list prices. Your current key may be on a free tier — this is an estimate, not an actual charge. Token counts are exact.';

export default function CommandCenter() {
  const [packs, setPacks] = useState<UiPack[]>([]);
  const [sectorKey, setSectorKey] = useState('');
  const { state, start } = useOrchestration();

  useEffect(() => {
    // Prefer the configured default sector (DEFAULT_SECTOR) over registry order,
    // so the picker lands on the intended sector. Falls back to the first pack.
    Promise.all([
      fetch('/api/sectors').then((r) => r.json()),
      fetch('/api/config').then((r) => r.json()).catch(() => null),
    ])
      .then(([s, c]) => {
        const list = (s as { packs: UiPack[] }).packs ?? [];
        setPacks(list);
        const preferred = (c as { orchestration?: { defaultSector?: string } } | null)
          ?.orchestration?.defaultSector;
        const initial = preferred && list.some((p) => p.key === preferred) ? preferred : list[0]?.key;
        if (initial) setSectorKey(initial);
      })
      .catch(() => {});
  }, []);

  const pack = useMemo(() => packs.find((p) => p.key === sectorKey), [packs, sectorKey]);
  const { totals } = state;

  return (
    <>
      <PageHeader
        title="Command Center"
        subtitle="Assign one goal to the CEO — it plans, delegates, and delivers autonomously."
        actions={
          state.runId ? (
            <span className="rounded-lg border border-edge bg-panel px-3 py-1.5 font-mono text-xs text-muted">
              {state.runId.slice(0, 18)}…
            </span>
          ) : undefined
        }
      />

      {/* Live task totals */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Input tokens" value={formatTokens(totals.inputTokens)} sub="exact · this task" />
        <StatTile label="Output tokens" value={formatTokens(totals.outputTokens)} sub="exact · this task" />
        <StatTile label="Model calls" value={totals.calls} sub={state.running ? 'in progress' : 'this task'} />
        <StatTile label="Est. cost" value={formatUsd(totals.costUsd)} sub="estimate, not billed" hint={COST_HINT} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <CommandConsole
            packs={packs}
            sectorKey={sectorKey}
            onSectorChange={setSectorKey}
            onSubmit={(goal, styleKey, brand) =>
              sectorKey &&
              start(sectorKey, goal, {
                ...(styleKey ? { styleKey } : {}),
                ...(brand ? { brand } : {}),
              })
            }
            running={state.running}
          />
        </div>

        <div className="lg:col-span-2">
          {pack ? (
            <AgentNetwork pack={pack} statuses={state.statuses} tokensByAgent={state.tokensByAgent} />
          ) : (
            <Card>
              <EmptyState title="Loading sector packs…" />
            </Card>
          )}
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6">
        <Card title="Orchestration trace" pad={false}>
          <div className="p-4 pt-3">
            <TraceConsole trace={state.trace} />
          </div>
        </Card>

        <DeliverablePanel
          result={state.result}
          running={state.running}
          error={state.error}
          actions={
            state.result ? <span className="text-xs text-muted">est. {formatUsd(totals.costUsd)}</span> : undefined
          }
        />
      </div>
    </>
  );
}
