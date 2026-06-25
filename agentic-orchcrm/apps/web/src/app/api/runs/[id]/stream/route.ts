/**
 * GET /api/runs/:id/stream — Server-Sent Events for one run.
 * Subscribes first (so nothing is missed), then replays any events that were
 * already produced, de-duplicating by event id. Closes on run completion.
 *
 * Streams in REAL TIME even behind a buffering proxy/CDN (e.g. a Cloudflare tunnel,
 * nginx). Three things make that work: the `X-Accel-Buffering: no` + `no-transform`
 * headers (tell the proxy not to buffer/compress), an initial ~2 KB comment burst
 * (many proxies hold the first kilobyte or two before flushing), and a periodic
 * heartbeat comment (keeps the connection flushing through the gaps between the
 * LLM calls, and under idle timeouts). All extra writes are SSE comments (lines
 * starting with `:`), which EventSource ignores — the client logic is unchanged.
 */
import type { OrchestrationEvent } from '@agentic-os/shared';
import { getStore } from '@/lib/engine';
import { clientKey, rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Initial padding to push past a proxy's first-flush buffer threshold.
const PAD = ' '.repeat(2048);
const HEARTBEAT_MS = 15000;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!rateLimit(clientKey(req, 'stream'), 60).ok) {
    return new Response('Rate limit exceeded.', { status: 429 });
  }
  const { id: runId } = await ctx.params;
  const store = getStore();

  const encoder = new TextEncoder();
  const seen = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true; // controller already torn down
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const send = (event: OrchestrationEvent) => {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'run.completed' || event.type === 'run.failed') close();
      };

      // Open the pipe immediately and force the proxy's first flush.
      write(`retry: 3000\n`);
      write(`: ${PAD}\n\n`);

      // Subscribe before replay so concurrent events aren't lost.
      unsubscribe = store.bus.subscribe(runId, send);
      for (const event of store.getEvents(runId)) send(event);

      // Keep the connection flushing during quiet stretches (between LLM calls).
      heartbeat = setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      // Disable proxy buffering (nginx/ingress honour this; harmless elsewhere).
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
