// Unit tests for backend/lib/shareLinkPolicy.js — share-link expiry +
// revocation policy (PRD §4.7 "Document security model", gap A3).
//
// Pure helpers, no I/O — consumed by routes/travel_itineraries.js:
//   - share mint:   computeShareExpiresAt(req.body.expiryDays)
//   - public view:  shareLinkState(itin) → 410 SHARE_EXPIRED / SHARE_REVOKED
//
// Contract pinned here:
//   - clampExpiryDays: default 7, window [1, 30], floor-then-clamp,
//     garbage falls back to the default (never throws / never rejects).
//   - shareLinkState precedence: revoked > expired > active.
//   - Legacy back-compat: shareExpiresAt=null → never expires (rows
//     minted before the column existed must keep working).
//   - Boundary: now === shareExpiresAt is still ACTIVE (expiry is
//     strictly-after).
//
// Run: cd backend && npx vitest run test/lib/shareLinkPolicy.test.js

import { describe, test, expect } from 'vitest';
import {
  SHARE_EXPIRY_DEFAULT_DAYS,
  SHARE_EXPIRY_MIN_DAYS,
  SHARE_EXPIRY_MAX_DAYS,
  clampExpiryDays,
  computeShareExpiresAt,
  shareLinkState,
} from '../../lib/shareLinkPolicy.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('policy constants', () => {
  test('default 7, min 1, max 30 (PRD §4.7)', () => {
    expect(SHARE_EXPIRY_DEFAULT_DAYS).toBe(7);
    expect(SHARE_EXPIRY_MIN_DAYS).toBe(1);
    expect(SHARE_EXPIRY_MAX_DAYS).toBe(30);
  });
});

describe('clampExpiryDays', () => {
  test('missing / null / empty-string → default 7', () => {
    expect(clampExpiryDays(undefined)).toBe(7);
    expect(clampExpiryDays(null)).toBe(7);
    expect(clampExpiryDays('')).toBe(7);
  });

  test('non-numeric garbage → default 7 (never throws)', () => {
    expect(clampExpiryDays('soon')).toBe(7);
    expect(clampExpiryDays(NaN)).toBe(7);
    expect(clampExpiryDays({})).toBe(7);
  });

  test('in-window values pass through (number or numeric string)', () => {
    expect(clampExpiryDays(1)).toBe(1);
    expect(clampExpiryDays(14)).toBe(14);
    expect(clampExpiryDays(30)).toBe(30);
    expect(clampExpiryDays('21')).toBe(21);
  });

  test('values above 30 clamp to 30', () => {
    expect(clampExpiryDays(31)).toBe(30);
    expect(clampExpiryDays(365)).toBe(30);
    expect(clampExpiryDays(Infinity)).toBe(7); // not finite → default
  });

  test('values below 1 clamp to 1', () => {
    expect(clampExpiryDays(0)).toBe(1);
    expect(clampExpiryDays(-5)).toBe(1);
  });

  test('fractional values floor first, then clamp', () => {
    expect(clampExpiryDays(2.9)).toBe(2); // floor(2.9)=2, in-window
    expect(clampExpiryDays(0.4)).toBe(1); // floor(0.4)=0 → clamp to 1
    expect(clampExpiryDays(30.7)).toBe(30);
  });
});

describe('computeShareExpiresAt', () => {
  const now = new Date('2026-06-12T10:00:00.000Z');

  test('default → now + 7 days', () => {
    expect(computeShareExpiresAt(undefined, now).getTime())
      .toBe(now.getTime() + 7 * MS_PER_DAY);
  });

  test('explicit in-window value → now + N days', () => {
    expect(computeShareExpiresAt(3, now).getTime())
      .toBe(now.getTime() + 3 * MS_PER_DAY);
  });

  test('out-of-window value is clamped before computing', () => {
    expect(computeShareExpiresAt(90, now).getTime())
      .toBe(now.getTime() + 30 * MS_PER_DAY);
    expect(computeShareExpiresAt(0, now).getTime())
      .toBe(now.getTime() + 1 * MS_PER_DAY);
  });

  test('returns a Date instance', () => {
    expect(computeShareExpiresAt(7, now)).toBeInstanceOf(Date);
  });
});

describe('shareLinkState', () => {
  const now = new Date('2026-06-12T10:00:00.000Z');
  const past = new Date(now.getTime() - 60 * 1000);
  const future = new Date(now.getTime() + 60 * 1000);

  test('active: unexpired + unrevoked', () => {
    expect(shareLinkState({ shareExpiresAt: future, shareRevokedAt: null }, now))
      .toEqual({ state: 'active', code: null });
  });

  test('legacy link (both null) → active forever (back-compat)', () => {
    expect(shareLinkState({ shareExpiresAt: null, shareRevokedAt: null }, now))
      .toEqual({ state: 'active', code: null });
  });

  test('expired: now strictly after shareExpiresAt → SHARE_EXPIRED', () => {
    expect(shareLinkState({ shareExpiresAt: past, shareRevokedAt: null }, now))
      .toEqual({ state: 'expired', code: 'SHARE_EXPIRED' });
  });

  test('boundary: now === shareExpiresAt is still active (strictly-after)', () => {
    expect(shareLinkState({ shareExpiresAt: new Date(now.getTime()), shareRevokedAt: null }, now))
      .toEqual({ state: 'active', code: null });
  });

  test('revoked → SHARE_REVOKED', () => {
    expect(shareLinkState({ shareExpiresAt: future, shareRevokedAt: past }, now))
      .toEqual({ state: 'revoked', code: 'SHARE_REVOKED' });
  });

  test('revoked wins over expired (precedence)', () => {
    expect(shareLinkState({ shareExpiresAt: past, shareRevokedAt: past }, now))
      .toEqual({ state: 'revoked', code: 'SHARE_REVOKED' });
  });

  test('ISO-string dates are accepted (Prisma rows may round-trip JSON)', () => {
    expect(shareLinkState({ shareExpiresAt: past.toISOString(), shareRevokedAt: null }, now).state)
      .toBe('expired');
    expect(shareLinkState({ shareExpiresAt: future.toISOString(), shareRevokedAt: null }, now).state)
      .toBe('active');
  });

  test('null/undefined row → active (defensive)', () => {
    expect(shareLinkState(null, now)).toEqual({ state: 'active', code: null });
    expect(shareLinkState(undefined, now)).toEqual({ state: 'active', code: null });
  });

  test('unparseable expiry string → treated as non-expiring, not a crash', () => {
    expect(shareLinkState({ shareExpiresAt: 'not-a-date', shareRevokedAt: null }, now).state)
      .toBe('active');
  });
});
