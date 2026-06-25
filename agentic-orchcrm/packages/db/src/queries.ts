/**
 * Convenience queries used by the API/dashboard. Keep DB access in this layer
 * so route handlers stay thin and the SQL is reviewable in one place.
 */
import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { runEvents, runs, usageEvents } from './schema.js';

/** Create the run row before handing the id to the Orchestrator. */
export async function createRun(
  db: Database,
  args: { runId: string; tenantId?: string; sectorKey: string; goal: string },
): Promise<void> {
  await db.insert(runs).values({
    id: args.runId,
    tenantId: args.tenantId ?? null,
    sectorKey: args.sectorKey,
    goal: args.goal,
    status: 'queued',
  });
}

export async function listRuns(db: Database, tenantId?: string, limit = 50) {
  const q = db.select().from(runs).orderBy(desc(runs.createdAt)).limit(limit);
  return tenantId ? q.where(eq(runs.tenantId, tenantId)) : q;
}

export async function getRunEvents(db: Database, runId: string) {
  return db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(runEvents.ts);
}

/** Cost rollup for the analytics dashboard. */
export async function getUsageSummary(db: Database, tenantId?: string) {
  const base = db
    .select({
      provider: usageEvents.provider,
      model: usageEvents.model,
      calls: sql<number>`count(*)`,
      inputTokens: sql<number>`sum(${usageEvents.inputTokens})`,
      outputTokens: sql<number>`sum(${usageEvents.outputTokens})`,
      costUsd: sql<number>`sum(${usageEvents.costUsd})`,
      billedUsd: sql<number>`sum(${usageEvents.billedUsd})`,
    })
    .from(usageEvents)
    .groupBy(usageEvents.provider, usageEvents.model);
  return tenantId ? base.where(eq(usageEvents.tenantId, tenantId)) : base;
}
