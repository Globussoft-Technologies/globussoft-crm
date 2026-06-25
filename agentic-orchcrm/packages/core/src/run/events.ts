/**
 * Run persistence + live event distribution.
 *
 *  - RunStore is the persistence port (dependency inversion): the engine writes
 *    events/usage/status through this interface and never imports a DB. The
 *    in-memory implementation here powers local dev and the demo; a
 *    Postgres-backed one lives in @agentic-os/db.
 *  - EventBus is in-process pub/sub so the web layer can stream a run live
 *    (SSE) as events are produced.
 */
import type {
  OrchestrationEvent,
  RunStatus,
  UsageRecord,
} from '@agentic-os/shared';

/** Aggregated usage for one agent within a run. Tokens are exact (from the API). */
export interface AgentUsage {
  agentKey: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated provider cost at list prices (NOT an actual charge). */
  costUsd: number;
  /** Cost × markup — what you'd bill a tenant. */
  billedUsd: number;
}

/** One run's headline numbers for lists/analytics. */
export interface RunSummary {
  runId: string;
  status: RunStatus;
  sector: string;
  goal: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  billedUsd: number;
  hasResult: boolean;
}

/** Full run record for the detail page. */
export interface RunDetail extends RunSummary {
  result?: string;
  perAgent: AgentUsage[];
  events: OrchestrationEvent[];
}

/** Persistence port. Implementations: InMemoryRunStore, (PgRunStore in db). */
export interface RunStore {
  appendEvent(event: OrchestrationEvent): void | Promise<void>;
  recordUsage(runId: string, agentKey: string, usage: UsageRecord): void | Promise<void>;
  setStatus(runId: string, status: RunStatus, result?: string): void | Promise<void>;
}

type Listener = (event: OrchestrationEvent) => void;

/** In-process pub/sub for live streaming of a run's events. */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(runId: string, fn: Listener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  publish(event: OrchestrationEvent): void {
    this.listeners.get(event.runId)?.forEach((fn) => fn(event));
  }
}

interface RunRecord {
  status: RunStatus;
  result?: string;
  events: OrchestrationEvent[];
  usage: Array<{ agentKey: string; usage: UsageRecord }>;
}

/**
 * Zero-dependency RunStore for local dev/demo. Also exposes read helpers and a
 * bus so the dashboard can render live and historical state without a database.
 */
export class InMemoryRunStore implements RunStore {
  readonly bus = new EventBus();
  private readonly runs = new Map<string, RunRecord>();

  private ensure(runId: string): RunRecord {
    let rec = this.runs.get(runId);
    if (!rec) {
      rec = { status: 'queued', events: [], usage: [] };
      this.runs.set(runId, rec);
    }
    return rec;
  }

  appendEvent(event: OrchestrationEvent): void {
    this.ensure(event.runId).events.push(event);
    this.bus.publish(event);
  }

  recordUsage(runId: string, agentKey: string, usage: UsageRecord): void {
    this.ensure(runId).usage.push({ agentKey, usage });
  }

  setStatus(runId: string, status: RunStatus, result?: string): void {
    const rec = this.ensure(runId);
    rec.status = status;
    if (result !== undefined) rec.result = result;
  }

  // ── read helpers (analytics / replay) ──────────────────────────────────────
  getEvents(runId: string): OrchestrationEvent[] {
    return this.runs.get(runId)?.events ?? [];
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  /** Total billed cost for a run (sum of marked-up usage). */
  getBilledTotal(runId: string): number {
    return (this.runs.get(runId)?.usage ?? []).reduce(
      (sum, u) => sum + u.usage.billedUsd,
      0,
    );
  }

  /** Per-run summaries (newest first) for lists + analytics. */
  listRunSummaries(): RunSummary[] {
    return [...this.runs.entries()]
      .map(([runId, rec]) => this.summarize(runId, rec))
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  }

  /** Full detail for one run, including per-agent usage and the event log. */
  getRunDetail(runId: string): RunDetail | undefined {
    const rec = this.runs.get(runId);
    if (!rec) return undefined;
    return {
      ...this.summarize(runId, rec),
      result: rec.result,
      perAgent: this.aggregateByAgent(rec),
      events: rec.events,
    };
  }

  /** Per-agent usage for a run (exact token counts; cost is an estimate). */
  getAgentUsage(runId: string): AgentUsage[] {
    const rec = this.runs.get(runId);
    return rec ? this.aggregateByAgent(rec) : [];
  }

  /** Cost + call counts grouped by model, across all runs. */
  getModelBreakdown(): Array<{
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    billedUsd: number;
  }> {
    const map = new Map<string, { model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number; billedUsd: number }>();
    for (const rec of this.runs.values()) {
      for (const { usage } of rec.usage) {
        const row = map.get(usage.model) ?? { model: usage.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, billedUsd: 0 };
        row.calls += 1;
        row.inputTokens += usage.inputTokens;
        row.outputTokens += usage.outputTokens;
        row.costUsd += usage.costUsd;
        row.billedUsd += usage.billedUsd;
        map.set(usage.model, row);
      }
    }
    return [...map.values()].sort((a, b) => b.costUsd - a.costUsd);
  }

  // ── internal aggregation ────────────────────────────────────────────────
  private summarize(runId: string, rec: RunRecord): RunSummary {
    const started = rec.events.find((e) => e.type === 'run.started');
    const ended = rec.events.find((e) => e.type === 'run.completed' || e.type === 'run.failed');
    const startedAt = started?.ts;
    const endedAt = ended?.ts;
    const totals = rec.usage.reduce(
      (acc, { usage }) => {
        acc.calls += 1;
        acc.inputTokens += usage.inputTokens;
        acc.outputTokens += usage.outputTokens;
        acc.costUsd += usage.costUsd;
        acc.billedUsd += usage.billedUsd;
        return acc;
      },
      { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, billedUsd: 0 },
    );
    return {
      runId,
      status: rec.status,
      sector: String(started?.data?.sector ?? ''),
      goal: String(started?.data?.goal ?? ''),
      startedAt,
      endedAt,
      durationMs: startedAt && endedAt ? new Date(endedAt).getTime() - new Date(startedAt).getTime() : undefined,
      hasResult: Boolean(rec.result),
      ...totals,
    };
  }

  private aggregateByAgent(rec: RunRecord): AgentUsage[] {
    const map = new Map<string, AgentUsage>();
    for (const { agentKey, usage } of rec.usage) {
      const row = map.get(agentKey) ?? {
        agentKey,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        billedUsd: 0,
      };
      row.calls += 1;
      row.inputTokens += usage.inputTokens;
      row.outputTokens += usage.outputTokens;
      row.costUsd += usage.costUsd;
      row.billedUsd += usage.billedUsd;
      map.set(agentKey, row);
    }
    return [...map.values()];
  }
}
