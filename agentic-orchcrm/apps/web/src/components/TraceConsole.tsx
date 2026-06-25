'use client';

import { useEffect, useRef } from 'react';
import type { OrchestrationEvent } from '@agentic-os/shared';

/** Live event trace — the human's window into what the agents are doing. */
export function TraceConsole({
  trace,
  height = 'h-80',
  autoScroll = true,
}: {
  trace: OrchestrationEvent[];
  height?: string;
  autoScroll?: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [trace.length, autoScroll]);

  return (
    <div
      className={`scroll-thin ${height} overflow-y-auto rounded-xl border border-edge bg-ink p-3 font-mono text-xs leading-relaxed`}
    >
      {trace.length === 0 && <div className="text-muted">Waiting for a run…</div>}
      {trace.map((e) => (
        <div key={e.id} className="fade-up whitespace-pre-wrap text-slate-300">
          <span className="text-muted/70">{e.ts.slice(11, 19)} </span>
          <span className={lineColor(e.type)}>{formatLine(e)}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function lineColor(type: string): string {
  if (type === 'run.failed') return 'text-bad';
  if (type === 'run.completed') return 'text-good';
  if (type === 'usage') return 'text-muted/70';
  if (type === 'approval.requested') return 'text-warn';
  return 'text-slate-300';
}

function formatLine(e: OrchestrationEvent): string {
  const d = e.data as Record<string, unknown>;
  const who = e.parentAgentKey ? `${e.parentAgentKey}→${e.agentKey}` : e.agentKey;
  switch (e.type) {
    case 'run.started':
      return `▶ run started · sector=${String(d.sector)}`;
    case 'agent.started':
      return `◆ ${e.agentKey} started`;
    case 'delegation.started':
      return `  ↳ ${who}: ${truncate(String(d.task))}`;
    case 'agent.tool_call':
      return `    · ${e.agentKey} → ${String(d.tool)}(${truncate(JSON.stringify(d.args ?? {}), 80)})`;
    case 'agent.tool_result':
      return `    · ${String(d.tool)} → ${truncate(String(d.result ?? d.error ?? ''), 90)}`;
    case 'agent.message':
      return d.final ? `  ✓ ${e.agentKey} finished` : `  … ${e.agentKey}: ${truncate(String(d.text ?? ''), 90)}`;
    case 'usage':
      return `    [${String(d.model)} · ↑${d.inputTokens} ↓${d.outputTokens} · est $${Number(d.costUsd ?? 0).toFixed(4)}]`;
    case 'approval.requested':
      return `    ⚑ approval (${String(d.mode)}): ${truncate(String(d.summary), 80)}`;
    case 'delegation.completed':
      return `  ◀ ${e.agentKey} returned`;
    case 'run.completed':
      return `■ run completed`;
    case 'run.failed':
      return `✖ run failed: ${truncate(String(d.error), 160)}`;
    default:
      return e.type;
  }
}

function truncate(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
