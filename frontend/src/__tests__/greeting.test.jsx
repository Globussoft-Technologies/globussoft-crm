/**
 * greeting.test.jsx — pins the four-branch time-of-day greeting helper.
 *
 * #636: prior wellness OwnerDashboard had an inline IST-only computation;
 * generic Dashboard had no greeting. The helper now centralises the branches
 * and these tests pin every boundary so a future refactor can't silently
 * collapse them back to a single string.
 *
 * Boundaries asserted (local hour, 24h):
 *   05:00 → "Good morning"   11:59 → "Good morning"
 *   12:00 → "Good afternoon" 16:59 → "Good afternoon"
 *   17:00 → "Good evening"   21:59 → "Good evening"
 *   22:00 → "Good night"     04:59 → "Good night"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getGreeting } from '../utils/greeting';

function atHour(h, m = 0) {
  // Build a Date at the given LOCAL hour. Using setHours keeps the test
  // independent of the host's timezone — no UTC math, no DST surprises.
  const d = new Date(2026, 0, 15, h, m, 0, 0);
  return d;
}

describe('getGreeting — branch coverage', () => {
  it('returns "Good morning" at 05:00 (lower morning boundary)', () => {
    expect(getGreeting(atHour(5))).toBe('Good morning');
  });

  it('returns "Good morning" at 09:00 (mid-morning)', () => {
    expect(getGreeting(atHour(9))).toBe('Good morning');
  });

  it('returns "Good morning" at 11:59 (upper morning boundary)', () => {
    expect(getGreeting(atHour(11, 59))).toBe('Good morning');
  });

  it('returns "Good afternoon" at 12:00 (lower afternoon boundary)', () => {
    expect(getGreeting(atHour(12))).toBe('Good afternoon');
  });

  it('returns "Good afternoon" at 14:30 (mid-afternoon)', () => {
    expect(getGreeting(atHour(14, 30))).toBe('Good afternoon');
  });

  it('returns "Good afternoon" at 16:59 (upper afternoon boundary)', () => {
    expect(getGreeting(atHour(16, 59))).toBe('Good afternoon');
  });

  it('returns "Good evening" at 17:00 (lower evening boundary)', () => {
    expect(getGreeting(atHour(17))).toBe('Good evening');
  });

  it('returns "Good evening" at 20:00 (mid-evening)', () => {
    expect(getGreeting(atHour(20))).toBe('Good evening');
  });

  it('returns "Good evening" at 21:59 (upper evening boundary)', () => {
    expect(getGreeting(atHour(21, 59))).toBe('Good evening');
  });

  it('returns "Good night" at 22:00 (lower late-night boundary)', () => {
    expect(getGreeting(atHour(22))).toBe('Good night');
  });

  it('returns "Good night" at 00:00 (midnight)', () => {
    expect(getGreeting(atHour(0))).toBe('Good night');
  });

  it('returns "Good night" at 04:59 (upper late-night boundary)', () => {
    expect(getGreeting(atHour(4, 59))).toBe('Good night');
  });
});

describe('getGreeting — default arg via vi fake timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads new Date() when called with no args (10:00 → morning)', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));
    expect(getGreeting()).toBe('Good morning');
  });

  it('reads new Date() when called with no args (15:00 → afternoon)', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 15, 0, 0));
    expect(getGreeting()).toBe('Good afternoon');
  });

  it('reads new Date() when called with no args (19:00 → evening)', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 19, 0, 0));
    expect(getGreeting()).toBe('Good evening');
  });

  it('reads new Date() when called with no args (23:30 → night)', () => {
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0));
    expect(getGreeting()).toBe('Good night');
  });
});
