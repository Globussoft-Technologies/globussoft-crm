'use client';

/**
 * Client hook that owns a single run's lifecycle: POST the goal, open the SSE
 * stream, and fold incoming events into UI state — per-agent status, the live
 * trace, exact per-agent + total token counts, estimated cost, and the result.
 */
import { useCallback, useRef, useState } from 'react';
import type { OrchestrationEvent } from '@agentic-os/shared';
import type { AgentStatus, AgentTokens } from './types';
import type { BrandInput } from '@/components/CommandConsole';

interface Totals {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costUsd: number;
  billedUsd: number;
}

export interface OrchestrationState {
  running: boolean;
  runId?: string;
  statuses: Record<string, AgentStatus>;
  tokensByAgent: Record<string, AgentTokens>;
  totals: Totals;
  trace: OrchestrationEvent[];
  result?: string;
  error?: string;
}

const EMPTY: OrchestrationState = {
  running: false,
  statuses: {},
  tokensByAgent: {},
  totals: { inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0, billedUsd: 0 },
  trace: [],
};

export function useOrchestration() {
  const [state, setState] = useState<OrchestrationState>(EMPTY);
  const esRef = useRef<EventSource | null>(null);
  // De-dupe by event id across the whole run: a proxy/tunnel drop makes EventSource
  // reconnect, and the server replays everything it has — without this, the trace
  // and token totals would double-count on every reconnect.
  const seenRef = useRef<Set<string>>(new Set());

  const start = useCallback(
    async (
      sectorKey: string,
      goal: string,
      options?: { styleKey?: string; brand?: BrandInput },
    ) => {
      esRef.current?.close();
      seenRef.current = new Set();
      setState({ ...EMPTY, running: true });

      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sectorKey,
          goal,
          ...(options?.styleKey ? { styleKey: options.styleKey } : {}),
          ...(options?.brand ? { brand: options.brand } : {}),
        }),
      });
    if (!res.ok) {
      const { error } = (await res.json().catch(() => ({}))) as { error?: string };
      setState((s) => ({ ...s, running: false, error: error ?? 'Failed to start run.' }));
      return;
    }
    const { runId } = (await res.json()) as { runId: string };
    setState((s) => ({ ...s, runId }));

    const es = new EventSource(`/api/runs/${runId}/stream`);
    esRef.current = es;
    es.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as OrchestrationEvent;
      if (seenRef.current.has(event.id)) return; // skip replayed events after a reconnect
      seenRef.current.add(event.id);
      setState((s) => fold(s, event));
      if (event.type === 'run.completed' || event.type === 'run.failed') es.close();
    };
    es.onerror = () => {
      // EventSource auto-reconnects on a transient drop (readyState === CONNECTING),
      // and the server replays missed events (deduped above) — so DON'T tear down on
      // every blip. Only give up once the browser has permanently closed it.
      if (es.readyState === EventSource.CLOSED) {
        setState((s) => (s.running ? { ...s, running: false } : s));
      }
    };
  }, []);

  return { state, start };
}

function fold(s: OrchestrationState, e: OrchestrationEvent): OrchestrationState {
  const statuses = { ...s.statuses };
  const tokensByAgent = { ...s.tokensByAgent };
  let totals = s.totals;
  let { result, running, error } = s;

  switch (e.type) {
    case 'agent.started':
    case 'delegation.started':
      statuses[e.agentKey] = 'working';
      break;
    case 'agent.message':
      if ((e.data as { final?: boolean }).final) statuses[e.agentKey] = 'done';
      break;
    case 'delegation.completed':
      statuses[e.agentKey] = 'done';
      break;
    case 'usage': {
      const d = e.data as { inputTokens?: number; outputTokens?: number; costUsd?: number; billedUsd?: number };
      const prev = tokensByAgent[e.agentKey] ?? { inputTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 };
      tokensByAgent[e.agentKey] = {
        inputTokens: prev.inputTokens + (d.inputTokens ?? 0),
        outputTokens: prev.outputTokens + (d.outputTokens ?? 0),
        calls: prev.calls + 1,
        costUsd: prev.costUsd + (d.costUsd ?? 0),
      };
      totals = {
        inputTokens: totals.inputTokens + (d.inputTokens ?? 0),
        outputTokens: totals.outputTokens + (d.outputTokens ?? 0),
        calls: totals.calls + 1,
        costUsd: totals.costUsd + (d.costUsd ?? 0),
        billedUsd: totals.billedUsd + (d.billedUsd ?? 0),
      };
      break;
    }
    case 'run.completed':
      result = String((e.data as { result?: string }).result ?? '');
      running = false;
      break;
    case 'run.failed':
      error = String((e.data as { error?: string }).error ?? 'Run failed.');
      running = false;
      break;
    default:
      break;
  }

  return { ...s, statuses, tokensByAgent, totals, result, running, error, trace: [...s.trace, e] };
}
