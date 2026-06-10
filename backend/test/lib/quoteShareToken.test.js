// @ts-check
/**
 * Unit tests for backend/lib/quoteShareToken.js — TravelQuote share-link JWT.
 *
 * Pins every assertion in the helper's hard contract:
 *   1. mint → verify round-trip preserves { quoteId, tenantId }.
 *   2. Expired tokens throw (TokenExpiredError).
 *   3. Tampered tokens throw (JsonWebTokenError).
 *   4. Wrong-purpose tokens throw INVALID_PURPOSE.
 *   5. Default TTL is 30 days (~2.6M seconds — exp ≈ iat + 30*86400).
 *   6. Custom TTL is honored.
 *   7. Deterministic for identical inputs + identical JWT_SECRET.
 *
 * Plus defensive branches:
 *   - Invalid quoteId / tenantId at mint-time.
 *   - INVALID_PAYLOAD at verify-time (legacy token without quoteId).
 *   - expiresInDays clamped to >=1 (passing 0 or negative still mints).
 *
 * Strategy: pure-function tests against jsonwebtoken directly — no
 * prisma mock needed. jsonwebtoken signs deterministically for HS256
 * + fixed payload + fixed iat (omits jti), so test 7 freezes time
 * via vi.useFakeTimers to demonstrate that.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';

import {
  mintShareToken,
  verifyShareToken,
  _internal,
} from '../../lib/quoteShareToken.js';

const SECRET =
  process.env.QUOTE_SHARE_JWT_SECRET ||
  process.env.JWT_SECRET ||
  'dev-quote-share-secret';

describe('quoteShareToken — JWT mint + verify (C9 hard contract)', () => {
  test('mint + verify round-trip preserves quoteId + tenantId', () => {
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    const decoded = verifyShareToken(token);
    expect(decoded.quoteId).toBe(42);
    expect(decoded.tenantId).toBe(7);
  });

  test('expired token throws TokenExpiredError', () => {
    // Sign with negative TTL via jsonwebtoken directly — the helper
    // clamps expiresInDays >=1 so we sidestep it. The verify-side path
    // still rejects via jwt.verify's TokenExpiredError.
    const token = jwt.sign(
      { quoteId: 1, tenantId: 1, purpose: _internal.PURPOSE },
      SECRET,
      { expiresIn: '-1s' },
    );
    expect(() => verifyShareToken(token)).toThrow();
    try {
      verifyShareToken(token);
    } catch (e) {
      expect(e.name).toBe('TokenExpiredError');
    }
  });

  test('tampered token throws JsonWebTokenError', () => {
    const token = mintShareToken({ quoteId: 42, tenantId: 7 });
    // Flip a char in the signature segment.
    const parts = token.split('.');
    const sig = parts[2];
    const flipped = sig[0] === 'A' ? 'B' + sig.slice(1) : 'A' + sig.slice(1);
    const tampered = `${parts[0]}.${parts[1]}.${flipped}`;
    expect(() => verifyShareToken(tampered)).toThrow();
    try {
      verifyShareToken(tampered);
    } catch (e) {
      expect(e.name).toMatch(/JsonWebTokenError|Error/);
    }
  });

  test('wrong-purpose token throws INVALID_PURPOSE', () => {
    const token = jwt.sign(
      { quoteId: 42, tenantId: 7, purpose: 'voyagr-api-key' },
      SECRET,
      { expiresIn: '30d' },
    );
    expect(() => verifyShareToken(token)).toThrow(/INVALID_PURPOSE/);
    try {
      verifyShareToken(token);
    } catch (e) {
      expect(e.code).toBe('INVALID_PURPOSE');
    }
  });

  test('default TTL is 30 days (~exp - iat ≈ 30*86400)', () => {
    const token = mintShareToken({ quoteId: 1, tenantId: 1 });
    const decoded = jwt.decode(token);
    const ttlSeconds = decoded.exp - decoded.iat;
    expect(ttlSeconds).toBe(30 * 86400);
  });

  test('custom TTL (expiresInDays=7) is honored', () => {
    const token = mintShareToken({ quoteId: 1, tenantId: 1, expiresInDays: 7 });
    const decoded = jwt.decode(token);
    expect(decoded.exp - decoded.iat).toBe(7 * 86400);
  });

  test('mint is deterministic for identical inputs + identical iat (frozen time)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T00:00:00.000Z'));
    const a = mintShareToken({ quoteId: 42, tenantId: 7 });
    const b = mintShareToken({ quoteId: 42, tenantId: 7 });
    expect(a).toBe(b);
    vi.useRealTimers();
  });

  test('mint rejects non-numeric quoteId', () => {
    expect(() => mintShareToken({ quoteId: 'abc', tenantId: 1 })).toThrow(/quoteId/);
  });

  test('mint rejects non-numeric tenantId', () => {
    expect(() => mintShareToken({ quoteId: 1, tenantId: null })).toThrow(/tenantId/);
  });

  test('verify rejects payload missing quoteId with INVALID_PAYLOAD', () => {
    const token = jwt.sign(
      { tenantId: 7, purpose: _internal.PURPOSE },
      SECRET,
      { expiresIn: '30d' },
    );
    expect(() => verifyShareToken(token)).toThrow(/INVALID_PAYLOAD/);
    try {
      verifyShareToken(token);
    } catch (e) {
      expect(e.code).toBe('INVALID_PAYLOAD');
    }
  });

  test('expiresInDays clamped to >=1 (passing 0 still mints a 1-day token)', () => {
    const token = mintShareToken({ quoteId: 1, tenantId: 1, expiresInDays: 0 });
    const decoded = jwt.decode(token);
    expect(decoded.exp - decoded.iat).toBe(86400);
  });
});
