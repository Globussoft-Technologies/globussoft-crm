'use client';

import type { AgentStatus, AgentTokens, UiPack } from '@/lib/types';
import { Badge } from '@/components/ui';
import { formatTokens } from '@/lib/format';

function tone(status: AgentStatus) {
  return status === 'working' ? 'running' : status === 'done' ? 'done' : status === 'waiting' ? 'waiting' : 'idle';
}

function TokenLine({ t }: { t?: AgentTokens }) {
  if (!t || t.calls === 0) {
    return <span className="text-[11px] text-muted/60">no calls yet</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted">
      <span className="text-good">↑{formatTokens(t.inputTokens)}</span>
      <span className="text-accent">↓{formatTokens(t.outputTokens)}</span>
      <span className="text-slate-400">{formatTokens(t.inputTokens + t.outputTokens)} tok</span>
      <span className="opacity-60">· {t.calls} {t.calls === 1 ? 'call' : 'calls'}</span>
    </span>
  );
}

export function AgentNetwork({
  pack,
  statuses,
  tokensByAgent,
}: {
  pack: UiPack;
  statuses: Record<string, AgentStatus>;
  tokensByAgent: Record<string, AgentTokens>;
}) {
  const coordinator = pack.agents.find((a) => a.key === pack.coordinatorKey);
  const specialists = pack.agents.filter((a) => a.key !== pack.coordinatorKey);
  const statusOf = (k: string): AgentStatus => statuses[k] ?? 'idle';

  return (
    <div className="space-y-4">
      {coordinator && (
        <div className="rounded-2xl border border-edge bg-gradient-to-br from-panel2 to-panel p-5 shadow-card">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-widest text-accent">{coordinator.title}</div>
              <h2 className="mt-0.5 text-lg font-semibold text-slate-100">{coordinator.name}</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted">{coordinator.description}</p>
            </div>
            <Badge tone={tone(statusOf(coordinator.key))}>{statusOf(coordinator.key)}</Badge>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-edge/60 pt-3">
            <span className="text-xs text-muted">Delegates to: {coordinator.delegatesTo.join(', ') || '—'}</span>
            <TokenLine t={tokensByAgent[coordinator.key]} />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {specialists.map((a, i) => {
          const st = statusOf(a.key);
          return (
            <div
              key={a.key}
              style={{ animationDelay: `${i * 50}ms` }}
              className={`fade-up rounded-2xl border bg-panel p-4 shadow-card transition duration-200 hover:-translate-y-0.5 ${
                st === 'working' ? 'border-good/50 shadow-glow' : 'border-edge hover:border-accent/30'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-[10px] font-medium tracking-widest text-muted">{a.title}</div>
                <Badge tone={tone(st)}>{st}</Badge>
              </div>
              <h3 className="mt-1 font-semibold text-slate-100">{a.name}</h3>
              <p className="mt-1 line-clamp-2 text-sm text-muted">{a.description}</p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
                <span className="rounded bg-edge px-1.5 py-0.5">tier: {a.tier}</span>
                {a.tools.length > 0 && <span className="rounded bg-edge px-1.5 py-0.5">{a.tools.join(', ')}</span>}
              </div>
              <div className="mt-2 border-t border-edge/60 pt-2">
                <TokenLine t={tokensByAgent[a.key]} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
