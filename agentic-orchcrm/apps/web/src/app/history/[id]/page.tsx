'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { OrchestrationEvent } from '@agentic-os/shared';
import { TraceConsole } from '@/components/TraceConsole';
import { DeliverablePanel } from '@/components/DeliverablePanel';
import { Bar, Card, Badge, EmptyState, PageHeader, Spinner, StatTile } from '@/components/ui';
import { formatDuration, formatTokens, formatUsd, statusTone } from '@/lib/format';
import type { RunDetail } from '@/lib/types';

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<RunDetail | null | 'missing'>(null);

  useEffect(() => {
    fetch(`/api/runs/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: RunDetail) => setRun(d))
      .catch(() => setRun('missing'));
  }, [id]);

  const back = (
    <Link href="/history" className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm text-muted transition hover:text-slate-200">
      ← History
    </Link>
  );

  if (run === null) {
    return (
      <>
        <PageHeader title="Run" actions={back} />
        <Card><Spinner label="Loading run…" /></Card>
      </>
    );
  }
  if (run === 'missing') {
    return (
      <>
        <PageHeader title="Run" actions={back} />
        <Card><EmptyState title="Run not found" hint="It may have been cleared (the dev store is in-memory)." /></Card>
      </>
    );
  }

  const totalTokens = run.inputTokens + run.outputTokens;
  const maxAgent = Math.max(1, ...run.perAgent.map((a) => a.inputTokens + a.outputTokens));

  return (
    <>
      <PageHeader
        title={run.goal || 'Run'}
        subtitle={`${run.sector} · ${run.runId}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={statusTone(run.status)}>{run.status}</Badge>
            {back}
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Total tokens" value={formatTokens(totalTokens)} sub={`↑${formatTokens(run.inputTokens)} ↓${formatTokens(run.outputTokens)}`} />
        <StatTile label="Model calls" value={run.calls} />
        <StatTile label="Est. cost" value={formatUsd(run.costUsd)} sub="provider list price" hint="Estimate at provider list prices — not an actual charge." />
        <StatTile label="Billable" value={formatUsd(run.billedUsd)} sub="cost × markup" hint="What you'd charge a tenant at the configured markup." />
        <StatTile label="Duration" value={formatDuration(run.durationMs)} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1 space-y-6">
          <Card title="Tokens by agent">
            {run.perAgent.length === 0 ? (
              <EmptyState title="No model calls recorded" />
            ) : (
              run.perAgent
                .slice()
                .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
                .map((a) => (
                  <Bar
                    key={a.agentKey}
                    label={`${a.agentKey} · ${a.calls} calls`}
                    value={a.inputTokens + a.outputTokens}
                    max={maxAgent}
                    valueLabel={`${formatTokens(a.inputTokens + a.outputTokens)} · ${formatUsd(a.costUsd)}`}
                  />
                ))
            )}
          </Card>

          <DeliverablePanel result={run.result} title="Deliverable" />
        </div>

        <div className="lg:col-span-2">
          <Card title="Orchestration trace" pad={false}>
            <div className="p-4 pt-3">
              <TraceConsole trace={run.events as OrchestrationEvent[]} height="h-[34rem]" autoScroll={false} />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
