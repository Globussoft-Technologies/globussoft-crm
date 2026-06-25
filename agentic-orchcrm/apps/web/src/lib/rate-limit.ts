/**
 * In-memory fixed-window rate limiter. Adequate for a single web instance /
 * dev. For multi-instance production, back this with Redis (same interface).
 */
interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface RateResult {
  ok: boolean;
  /** Seconds until the window resets (for the Retry-After header). */
  retryAfter: number;
}

export function rateLimit(key: string, limit: number, windowMs = 60_000): RateResult {
  const now = Date.now();
  const w = windows.get(key);

  if (!w || now >= w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  if (w.count >= limit) {
    return { ok: false, retryAfter: Math.ceil((w.resetAt - now) / 1000) };
  }
  w.count += 1;
  return { ok: true, retryAfter: 0 };
}

/** Best-effort client identifier from proxy headers. */
export function clientKey(req: Request, scope: string): string {
  const xff = req.headers.get('x-forwarded-for');
  const ip = (xff?.split(',')[0] ?? '').trim() || req.headers.get('x-real-ip') || 'unknown';
  return `${scope}:${ip}`;
}
