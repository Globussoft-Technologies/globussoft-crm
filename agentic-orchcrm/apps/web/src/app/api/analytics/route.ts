/**
 * GET /api/analytics — cost + activity rollups for the Analytics page.
 * Reads the in-memory store (dev). In production this would query the
 * usage_events / runs tables in Postgres via @agentic-os/db.
 *
 * Tokens are exact (from provider usage). costUsd is an ESTIMATE at provider
 * list prices — not an actual charge (your key may be on a free tier).
 * billedUsd is costUsd × markup — what you'd charge a tenant.
 */
import { getStore } from '@/lib/engine';
import { clientKey, rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  if (!rateLimit(clientKey(req, 'analytics'), 120).ok) {
    return Response.json({ error: 'Rate limit exceeded.' }, { status: 429 });
  }
  const store = getStore();
  const runs = store.listRunSummaries();
  const models = store.getModelBreakdown();

  const totals = runs.reduce(
    (acc, r) => {
      acc.runs += 1;
      acc.calls += r.calls;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.costUsd += r.costUsd;
      acc.billedUsd += r.billedUsd;
      if (r.status === 'completed') acc.completed += 1;
      if (r.status === 'failed') acc.failed += 1;
      return acc;
    },
    { runs: 0, completed: 0, failed: 0, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, billedUsd: 0 },
  );

  return Response.json({ totals, models, runs });
}
