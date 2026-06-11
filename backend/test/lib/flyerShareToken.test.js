// @ts-check
/**
 * Tests for backend/lib/flyerShareToken.js — TravelFlyerTemplate public-share
 * JWT helper (S18 + S80 — PRD_TRAVEL_MARKETING_FLYER #908).
 *
 * S80 extends the helper with two new contracts:
 *   1. mintShareToken() embeds a unique jti (crypto.randomUUID()) per mint.
 *   2. verifyShareToken() is now async + checks `prisma.revokedToken.findUnique`
 *      by jti; rejects with REVOKED_TOKEN if the row exists; fail-soft on DB
 *      error (mirrors middleware/auth.js Issue #180 pattern).
 *
 * The existing route-level test at backend/test/routes/travel-flyer-public-api.test.js
 * covers the route handlers' integration with this helper; this file pins the
 * helper's unit-level contract independently so a future refactor that swaps
 * the prisma client (e.g. moving to a `prismaForFlyerShare` injected dep)
 * doesn't break the contract without surfacing here.
 *
 * Strategy: CJS singleton-patch — monkey-patch prisma.revokedToken on the
 * SAME module the helper's lazy `require('./prisma')` resolves to. Same
 * pattern as test/routes/travel-flyer-public-api.test.js + lib/eventBus
 * (see 2026-05-09 wave-3c cron-learning).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Resolve prisma + monkey-patch BEFORE the SUT require so the lazy
// getPrisma() inside the helper resolves to our patched singleton.
const prismaModule = requireCJS('../../lib/prisma');
prismaModule.revokedToken = prismaModule.revokedToken || {};
prismaModule.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

const { mintShareToken, verifyShareToken, _internal } = requireCJS('../../lib/flyerShareToken');
const jwt = requireCJS('jsonwebtoken');

const SHARE_SECRET =
  process.env.FLYER_SHARE_JWT_SECRET ||
  process.env.JWT_SECRET ||
  'dev-flyer-share-secret';

beforeEach(() => {
  prismaModule.revokedToken.findUnique.mockReset();
  prismaModule.revokedToken.findUnique.mockResolvedValue(null);
});

describe('mintShareToken — S80 jti embedding', () => {
  test('mint embeds a jti in the JWT payload', () => {
    const token = mintShareToken({ flyerId: 42, tenantId: 7 });
    const decoded = jwt.decode(token);
    expect(decoded.jti).toBeTruthy();
    expect(typeof decoded.jti).toBe('string');
    // crypto.randomUUID() — RFC 4122 v4 dashed shape.
    expect(decoded.jti).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('two consecutive mints produce DIFFERENT jti values', () => {
    const a = mintShareToken({ flyerId: 1, tenantId: 1 });
    const b = mintShareToken({ flyerId: 1, tenantId: 1 });
    const ja = jwt.decode(a);
    const jb = jwt.decode(b);
    expect(ja.jti).toBeTruthy();
    expect(jb.jti).toBeTruthy();
    expect(ja.jti).not.toBe(jb.jti);
  });

  test('100 mints produce 100 unique jti values (no collisions)', () => {
    const jtis = new Set();
    for (let i = 0; i < 100; i += 1) {
      const t = mintShareToken({ flyerId: 1, tenantId: 1 });
      jtis.add(jwt.decode(t).jti);
    }
    expect(jtis.size).toBe(100);
  });

  test('purpose + aud + flyerId + tenantId still preserved alongside jti', () => {
    const token = mintShareToken({ flyerId: 42, tenantId: 7 });
    const decoded = jwt.decode(token);
    expect(decoded.purpose).toBe(_internal.PURPOSE);
    expect(decoded.aud).toBe('flyer-share');
    expect(decoded.flyerId).toBe(42);
    expect(decoded.tenantId).toBe(7);
    expect(decoded.jti).toBeTruthy();
  });
});

describe('verifyShareToken — S80 RevokedToken lookup', () => {
  test('valid + non-revoked token → returns payload incl jti', async () => {
    prismaModule.revokedToken.findUnique.mockResolvedValue(null);
    const token = mintShareToken({ flyerId: 42, tenantId: 7 });
    const payload = await verifyShareToken(token);
    expect(payload.flyerId).toBe(42);
    expect(payload.tenantId).toBe(7);
    expect(payload.jti).toBeTruthy();
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('revoked token → throws REVOKED_TOKEN', async () => {
    prismaModule.revokedToken.findUnique.mockResolvedValue({ id: 99 });
    const token = mintShareToken({ flyerId: 42, tenantId: 7 });
    await expect(verifyShareToken(token)).rejects.toThrow(/REVOKED_TOKEN/);
    // findUnique was called with the jti from the token.
    expect(prismaModule.revokedToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ jti: expect.any(String) }),
      }),
    );
  });

  test('revoked token error carries .code = REVOKED_TOKEN', async () => {
    prismaModule.revokedToken.findUnique.mockResolvedValue({ id: 99 });
    const token = mintShareToken({ flyerId: 42, tenantId: 7 });
    let caught;
    try {
      await verifyShareToken(token);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('REVOKED_TOKEN');
  });

  test('DB error during revocation check → fail-soft (token still accepted)', async () => {
    prismaModule.revokedToken.findUnique.mockRejectedValue(
      new Error('connection refused'),
    );
    const token = mintShareToken({ flyerId: 42, tenantId: 7 });
    const payload = await verifyShareToken(token);
    // Fail-soft per the canonical middleware/auth.js Issue #180 pattern —
    // signature + purpose + expiry held; revocation check degraded gracefully.
    expect(payload.flyerId).toBe(42);
    expect(payload.tenantId).toBe(7);
  });

  test('expired token throws TokenExpiredError BEFORE revocation check fires', async () => {
    const expired = jwt.sign(
      { flyerId: 42, tenantId: 1, purpose: _internal.PURPOSE, jti: 'expired-jti' },
      SHARE_SECRET,
      { expiresIn: '-1s' },
    );
    await expect(verifyShareToken(expired)).rejects.toThrow(/jwt expired/);
    // jwt.verify throws BEFORE we reach the prisma lookup.
    expect(prismaModule.revokedToken.findUnique).not.toHaveBeenCalled();
  });

  test('tampered token throws JsonWebTokenError BEFORE revocation check fires', async () => {
    const token = mintShareToken({ flyerId: 42, tenantId: 1 });
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2].length)}`;
    await expect(verifyShareToken(tampered)).rejects.toThrow();
    expect(prismaModule.revokedToken.findUnique).not.toHaveBeenCalled();
  });

  test('wrong-purpose token throws INVALID_PURPOSE BEFORE revocation check fires', async () => {
    const wrong = jwt.sign(
      { flyerId: 42, tenantId: 1, purpose: 'travel-quote-share', jti: 'x' },
      SHARE_SECRET,
      { expiresIn: '30d' },
    );
    await expect(verifyShareToken(wrong)).rejects.toThrow(/INVALID_PURPOSE/);
    expect(prismaModule.revokedToken.findUnique).not.toHaveBeenCalled();
  });

  test('legacy token without jti is accepted (pre-S80 fallback)', async () => {
    // Hand-craft a token without jti (mintShareToken now always adds one).
    const legacy = jwt.sign(
      { flyerId: 42, tenantId: 1, purpose: _internal.PURPOSE, aud: 'flyer-share' },
      SHARE_SECRET,
      { expiresIn: '7d' },
    );
    const payload = await verifyShareToken(legacy);
    expect(payload.flyerId).toBe(42);
    expect(payload.jti).toBeNull();
    // Without a jti we never query the revocation list.
    expect(prismaModule.revokedToken.findUnique).not.toHaveBeenCalled();
  });
});

describe('round-trip — mint + verify with rotated revocation state', () => {
  test('verify then revoke then verify → second verify rejects', async () => {
    const token = mintShareToken({ flyerId: 5, tenantId: 5 });
    // First verify: not in revocation list.
    prismaModule.revokedToken.findUnique.mockResolvedValueOnce(null);
    const first = await verifyShareToken(token);
    expect(first.flyerId).toBe(5);
    // Operator revokes — next verify lookup hits.
    prismaModule.revokedToken.findUnique.mockResolvedValueOnce({ id: 7 });
    await expect(verifyShareToken(token)).rejects.toThrow(/REVOKED_TOKEN/);
  });
});
