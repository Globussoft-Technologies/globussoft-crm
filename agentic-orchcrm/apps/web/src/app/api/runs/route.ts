/**
 * POST /api/runs — assign ONE goal to the CEO and start an autonomous run.
 * Hardened: rate limited, input-validated, sector-allowlisted, and gated by a
 * max-concurrency cap. Returns the runId immediately; watch via the SSE stream.
 *
 * Orchestration runs in-process (fire-and-forget) for the dev/demo setup. In
 * production this handler would enqueue the run for the worker instead.
 */
import { newRunId } from '@agentic-os/shared';
import { getSectorPack, listSectorPacks } from '@agentic-os/sectors';
import { getEngine, getStore } from '@/lib/engine';
import { clientKey, rateLimit } from '@/lib/rate-limit';
import { releaseRun, tryAcquireRun } from '@/lib/guards';
import { sanitizeBrandKit } from '@/lib/brand-kit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/runs — list run summaries (newest first) for the History page. */
export function GET() {
  return Response.json({ runs: getStore().listRunSummaries() });
}

export async function POST(req: Request) {
  const { orchestrator, deps } = getEngine();
  const { security } = deps.config;

  // 1. Rate limit per client.
  const limit = rateLimit(clientKey(req, 'runs'), security.rateLimitPerMinute);
  if (!limit.ok) {
    return Response.json(
      { error: 'Rate limit exceeded. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } },
    );
  }

  // 2. Parse + validate input.
  const body = (await req.json().catch(() => null)) as
    | { sectorKey?: unknown; goal?: unknown; styleKey?: unknown; brand?: unknown }
    | null;
  if (!body) return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });

  const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
  const sectorKey = typeof body.sectorKey === 'string' ? body.sectorKey.trim() : '';

  if (!goal) return Response.json({ error: 'goal is required.' }, { status: 400 });
  if (goal.length > security.maxGoalChars) {
    return Response.json(
      { error: `goal exceeds ${security.maxGoalChars} characters.` },
      { status: 400 },
    );
  }
  const validSectors = new Set(listSectorPacks().map((p) => p.key));
  if (!validSectors.has(sectorKey)) {
    return Response.json({ error: 'Unknown sectorKey.' }, { status: 400 });
  }

  // Validate an optional design style against THIS sector's allowlist. Only the
  // key crosses the trust boundary; the art-direction text is resolved server-side.
  // A sector with no declared styles has an empty allowlist, so any styleKey is
  // rejected — the field can't be abused on non-styled sectors.
  const allowedStyles = getSectorPack(sectorKey).finalize?.styles ?? [];
  let styleKey: string | undefined;
  if (typeof body.styleKey === 'string' && body.styleKey.trim()) {
    const k = body.styleKey.trim();
    if (!allowedStyles.includes(k)) {
      return Response.json({ error: 'Unknown styleKey for this sector.' }, { status: 400 });
    }
    styleKey = k;
  }

  // Optional brand kit (logo + details). Fully sanitized server-side: the logo is
  // re-emitted as a magic-byte-verified, size-capped data: URI (no SVG, no external
  // URL), every text field is length-capped. Invalid input is dropped (→ undefined),
  // never fatal — the brochure just falls back to its text wordmark.
  const brand = sanitizeBrandKit(body.brand);

  // 3. Concurrency cap (cost/load protection).
  if (!tryAcquireRun(security.maxConcurrentRuns)) {
    return Response.json(
      { error: 'Server at capacity (max concurrent runs). Try again shortly.' },
      { status: 429 },
    );
  }

  // 4. Start the run; always release the concurrency slot when it settles.
  const runId = newRunId();
  void orchestrator
    .run({ runId, sectorKey, goal, ...(styleKey ? { styleKey } : {}), ...(brand ? { brand } : {}) })
    .catch(() => {
      /* failure is recorded as a run.failed event in the store */
    })
    .finally(releaseRun);

  return Response.json({ runId });
}
