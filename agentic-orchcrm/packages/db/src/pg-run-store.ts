/**
 * Postgres-backed RunStore — the production implementation of core's
 * persistence port. Inject it into createEngine() to persist every event and
 * usage record for analytics + billing:
 *
 *   const db = createDb(process.env.DATABASE_URL!);
 *   const store = new PgRunStore(db, tenantId);
 *   const { orchestrator } = createEngine(config, { store });
 */
import { eq, sql } from 'drizzle-orm';
import type { OrchestrationEvent, RunStatus, UsageRecord } from '@agentic-os/shared';
import { newUsageId } from '@agentic-os/shared';
import type { RunStore } from '@agentic-os/core';
import type { Database } from './client.js';
import { runEvents, runs, usageEvents } from './schema.js';

export class PgRunStore implements RunStore {
  constructor(
    private readonly db: Database,
    private readonly tenantId?: string,
  ) {}

  async appendEvent(event: OrchestrationEvent): Promise<void> {
    await this.db.insert(runEvents).values({
      id: event.id,
      runId: event.runId,
      ts: new Date(event.ts),
      type: event.type,
      agentKey: event.agentKey,
      parentAgentKey: event.parentAgentKey ?? null,
      data: event.data,
    });
  }

  async recordUsage(runId: string, agentKey: string, usage: UsageRecord): Promise<void> {
    await this.db.insert(usageEvents).values({
      id: newUsageId(),
      runId,
      tenantId: this.tenantId ?? null,
      agentKey,
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      billedUsd: usage.billedUsd,
    });
    // Keep the run's running billed total fresh for cheap dashboard reads.
    await this.db
      .update(runs)
      .set({ billedUsdTotal: sql`${runs.billedUsdTotal} + ${usage.billedUsd}` })
      .where(eq(runs.id, runId));
  }

  async setStatus(runId: string, status: RunStatus, result?: string): Promise<void> {
    const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    await this.db
      .update(runs)
      .set({
        status,
        ...(result !== undefined ? { result } : {}),
        ...(isTerminal ? { completedAt: new Date() } : {}),
      })
      .where(eq(runs.id, runId));
  }
}
