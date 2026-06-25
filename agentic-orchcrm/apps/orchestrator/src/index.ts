/**
 * Production worker entry point. Long-running agent loops should not run inside
 * web request handlers — this process owns them.
 *
 * Scaffold version: a simple poll loop over queued runs in Postgres. For scale,
 * swap the poll for a real queue (BullMQ/Redis) or a durable engine (Temporal),
 * and run N replicas. The execution code (createEngine + orchestrator.run) stays
 * identical — only how work is fetched changes.
 *
 *   npm run worker        # requires DATABASE_URL; otherwise use `npm run demo`
 */
import { createLogger, loadConfig } from '@agentic-os/shared';
import { createEngine } from '@agentic-os/core';
import { PgRunStore, createDb, runs } from '@agentic-os/db';
import { and, eq } from 'drizzle-orm';

try {
  process.loadEnvFile('.env');
} catch {
  /* rely on ambient env */
}

const log = createLogger('worker');
const config = loadConfig();

if (!config.databaseUrl) {
  log.error('DATABASE_URL is not set. The worker needs Postgres. For a no-DB run, use `npm run demo`.');
  process.exit(1);
}

const db = createDb(config.databaseUrl);
const POLL_MS = 2000;

log.info('Worker started — polling for queued runs.', { pollMs: POLL_MS });

// eslint-disable-next-line no-constant-condition
while (true) {
  const queued = await db.select().from(runs).where(eq(runs.status, 'queued')).limit(1);
  const run = queued[0];

  if (!run) {
    await sleep(POLL_MS);
    continue;
  }

  // Claim the run so other replicas don't pick it up.
  const claimed = await db
    .update(runs)
    .set({ status: 'running' })
    .where(and(eq(runs.id, run.id), eq(runs.status, 'queued')))
    .returning({ id: runs.id });
  if (claimed.length === 0) continue; // lost the race

  log.info('Executing run', { runId: run.id, sector: run.sectorKey });
  const store = new PgRunStore(db, run.tenantId ?? undefined);
  const { orchestrator } = createEngine(config, { store });

  try {
    await orchestrator.run({ runId: run.id, sectorKey: run.sectorKey, goal: run.goal });
    log.info('Run completed', { runId: run.id });
  } catch (err) {
    log.error('Run failed', { runId: run.id, error: (err as Error).message });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
