'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, Badge, EmptyState, PageHeader, Spinner } from '@/components/ui';
import { formatDuration, formatTokens, formatUsd, relativeTime, statusTone } from '@/lib/format';
import type { RunSummary } from '@/lib/types';

export default function HistoryPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);

  const load = useCallback(() => {
    fetch('/api/runs')
      .then((r) => r.json())
      .then((d: { runs: RunSummary[] }) => setRuns(d.runs))
      .catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <PageHeader
        title="History"
        subtitle="Every run, with exact token usage and estimated cost."
        actions={
          <button
            onClick={load}
            className="rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm text-muted transition hover:text-slate-200"
          >
            Refresh
          </button>
        }
      />

      <Card pad={false}>
        {runs === null ? (
          <div className="p-6">
            <Spinner label="Loading runs…" />
          </div>
        ) : runs.length === 0 ? (
          <div className="p-6">
            <EmptyState title="No runs yet" hint="Assign a goal in the Command Center to create your first run." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-left text-xs uppercase tracking-wide text-muted">
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Goal</th>
                  <th className="px-5 py-3 font-medium">Sector</th>
                  <th className="px-5 py-3 text-right font-medium">Tokens</th>
                  <th className="px-5 py-3 text-right font-medium">Est. cost</th>
                  <th className="px-5 py-3 text-right font-medium">Duration</th>
                  <th className="px-5 py-3 text-right font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.runId} className="group border-b border-edge/50 last:border-0 hover:bg-panel2/60">
                    <td className="px-5 py-3">
                      <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                    </td>
                    <td className="max-w-md px-5 py-3">
                      <Link href={`/history/${r.runId}`} className="line-clamp-1 text-slate-200 transition group-hover:text-accent">
                        {r.goal || '(no goal)'}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-muted">{r.sector}</td>
                    <td className="px-5 py-3 text-right font-mono tabular-nums text-slate-300">
                      {formatTokens(r.inputTokens + r.outputTokens)}
                    </td>
                    <td className="px-5 py-3 text-right font-mono tabular-nums text-muted">{formatUsd(r.costUsd)}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-muted">{formatDuration(r.durationMs)}</td>
                    <td className="px-5 py-3 text-right text-muted">{relativeTime(r.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
