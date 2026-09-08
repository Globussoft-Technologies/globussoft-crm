// @ts-check
/**
 * Tests for backend/lib/callifiedRedialGuard.js.
 *
 * Outbound calls cost real money and reach real people, so a double-click —
 * or two operators working the same list — must not fire two calls at the same
 * customer. The frontend disables its buttons while a call is in flight; this
 * guard is the server-side backstop that makes the guarantee real, and it is
 * enforced on BOTH the AI dial and the manual/browser call.
 *
 * The message is asserted here too. It used to print the previous call's ISO
 * timestamp, which asks an operator staring at a dialog to do date arithmetic;
 * it now says how long is left in words, while keeping the precise instant in
 * `redialAfter` for anything scheduling against it.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const {
  REDIAL_COOLDOWN_MS,
  redialCooldownError,
  describeWait,
} = requireCJS('../../lib/callifiedRedialGuard');

afterEach(() => {
  vi.useRealTimers();
});

describe('describeWait', () => {
  test('reads in seconds under a minute', () => {
    expect(describeWait(45_000)).toBe('45 seconds');
    expect(describeWait(1_000)).toBe('1 second');
  });

  test('rounds up rather than saying "0 seconds"', () => {
    expect(describeWait(1)).toBe('1 second');
    expect(describeWait(0)).toBe('1 second');
  });

  test('switches to minutes past sixty seconds', () => {
    expect(describeWait(60_000)).toBe('1 minute');
    expect(describeWait(90_000)).toBe('2 minutes');
  });
});

describe('redialCooldownError', () => {
  test('says how long is LEFT, not when the last call happened', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-25T10:00:00.000Z');
    vi.setSystemTime(now);

    // Called 20s ago with a 60s cooldown → 40s remaining.
    const body = redialCooldownError(new Date(now.getTime() - 20_000), 60_000);

    expect(body.error).toContain('40 seconds');
    expect(body.code).toBe('CALLIFIED_REDIAL_COOLDOWN');
    // The operator should never be shown a raw timestamp to subtract from.
    expect(body.error).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test('still carries the precise instant for machine callers', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-25T10:00:00.000Z');
    vi.setSystemTime(now);

    const body = redialCooldownError(new Date(now.getTime() - 20_000), 60_000);

    expect(body.redialAfter).toBe('2026-08-25T10:00:40.000Z');
    expect(body.retryAfterSeconds).toBe(40);
  });

  test('degrades gracefully if the window has already elapsed', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-25T10:00:00.000Z');
    vi.setSystemTime(now);

    // A race: the cooldown expired between the lookup and this call.
    const body = redialCooldownError(new Date(now.getTime() - 120_000), 60_000);

    expect(body.error).toMatch(/try again/i);
    expect(body.error).not.toContain('NaN');
    expect(body.error).not.toMatch(/-\d/);
  });

  test('defaults to the configured cooldown window', () => {
    expect(REDIAL_COOLDOWN_MS).toBeGreaterThan(0);
    const body = redialCooldownError(new Date());
    expect(body.redialAfter).toBeTruthy();
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });
});
