/**
 * Concurrency guard — caps the number of orchestrations running at once to
 * protect cost and load. In-process (single instance); for multi-instance use a
 * shared counter (e.g. Redis) instead.
 */
let active = 0;

export function tryAcquireRun(max: number): boolean {
  if (active >= max) return false;
  active += 1;
  return true;
}

export function releaseRun(): void {
  active = Math.max(0, active - 1);
}

export function activeRuns(): number {
  return active;
}
