// @ts-check
/**
 * D16 Wallet Top-up — Arc 1 polish slice: GET /api/wallet/stats.
 *
 * First tenant-wide aggregate endpoint added to backend/routes/wallet.js
 * (the 4 existing endpoints are per-patient). Pins the dashboard wallet
 * tile's KPI surface — totalWallets + totalBalance + totalTopups +
 * totalRedemptions + activeCreditBatches + expiringSoonCount +
 * lastTopupAt — and the cross-cutting standing rules around it:
 *
 *   - Auth gate:    missing token → 401 (verifyToken).
 *   - RBAC:         USER role → 403 RBAC_DENIED (verifyRole(['ADMIN','MANAGER'])).
 *                   ADMIN+MANAGER intentionally locked tighter than the
 *                   per-patient phiReadGate set — tenant-wide aggregate
 *                   = owner-dashboard surface, minimise PII exposure.
 *   - Date input:   bad ?from / ?to → 400 INVALID_DATE.
 *   - Empty tenant: every aggregate 0, lastTopupAt null.
 *   - Happy path:   3 wallets + 5 transactions (3 TOP_UP + 2 REDEEM) +
 *                   2 active credit batches → counts + totals correct.
 *   - Precision:    Decimal sums round half-up to 2dp.
 *   - lastTopupAt:  picks newest TOP_UP createdAt — REDEEM rows ignored.
 *   - Tenant iso:   different tenantId in JWT → zeroed envelope.
 *   - Window:       ?from/?to narrows topups/redemptions (NOT wallet count).
 *   - Expiring30d:  expiresAt within +30d (and remainingCents > 0) counted.
 *   - ActiveBatch:  status='ACTIVE' + remainingCents>0 + (expiresAt null OR > now).
 *   - No audit row: read-only meta surface; mirrors /suppliers/stats.
 *
 * Mock pattern mirrors backend/test/routes/wallet-topup.test.js +
 * backend/test/routes/travel-trip-billing-stats.test.js — patch the
 * prisma singleton with vi.fn() shapes BEFORE requiring the router, then
 * drive supertest with HS256 JWTs signed against the dev-fallback secret.
 *
 * REDEEM amount-rupees rows are stored as NEGATIVE values per
 * routes/wallet.js:673 — the route sums Math.abs() to surface the
 * positive total. The tests mirror that wire shape.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.wallet = prisma.wallet || {};
prisma.wallet.findMany = vi.fn();

prisma.walletTransaction = prisma.walletTransaction || {};
prisma.walletTransaction.findMany = vi.fn();

prisma.walletCreditBatch = prisma.walletCreditBatch || {};
prisma.walletCreditBatch.count = vi.fn();

prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const walletRouter = requireCJS('../../routes/wallet');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/wallet', walletRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.wallet.findMany.mockReset().mockResolvedValue([]);
  prisma.walletTransaction.findMany.mockReset().mockResolvedValue([]);
  prisma.walletCreditBatch.count.mockReset().mockResolvedValue(0);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/wallet/stats', () => {
  test('1. 401 when no Authorization header', async () => {
    const res = await request(makeApp()).get('/api/wallet/stats');
    expect(res.status).toBe(401);
    // verifyToken fires before the route handler → no prisma reads.
    expect(prisma.wallet.findMany).not.toHaveBeenCalled();
  });

  test('2. 403 RBAC_DENIED when caller is USER role', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    // verifyRole fires before the route handler body — no prisma reads.
    expect(prisma.wallet.findMany).not.toHaveBeenCalled();
  });

  test('3. 400 INVALID_DATE on bad ?from', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('4. 400 INVALID_DATE on bad ?to', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/stats?to=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('5. Empty tenant: every aggregate 0, lastTopupAt null', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalWallets: 0,
      totalBalance: 0,
      totalTopups: 0,
      totalRedemptions: 0,
      activeCreditBatches: 0,
      expiringSoonCount: 0,
      lastTopupAt: null,
    });
    // NO audit row written (read-only meta surface).
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('6. Happy path: 3 wallets + 5 transactions → counts + totals correct', async () => {
    prisma.wallet.findMany.mockResolvedValue([
      { balance: 1000 },
      { balance: 500 },
      { balance: 250 },
    ]);
    // 3 TOP_UP rows (1000 + 500 + 250 = 1750) + 2 REDEEM rows stored as
    // negative amount-rupees (-200 + -50 = -250 → Math.abs sum = 250).
    prisma.walletTransaction.findMany
      .mockResolvedValueOnce([
        { amount: 1000, createdAt: new Date('2026-05-20T10:00:00Z') },
        { amount: 500, createdAt: new Date('2026-05-21T11:00:00Z') },
        { amount: 250, createdAt: new Date('2026-05-22T12:00:00Z') },
      ])
      .mockResolvedValueOnce([
        { amount: -200 },
        { amount: -50 },
      ]);
    prisma.walletCreditBatch.count
      .mockResolvedValueOnce(2) // active
      .mockResolvedValueOnce(1); // expiring-soon

    const res = await request(makeApp())
      .get('/api/wallet/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalWallets: 3,
      totalBalance: 1750,
      totalTopups: 1750,
      totalRedemptions: 250,
      activeCreditBatches: 2,
      expiringSoonCount: 1,
    });
    expect(res.body.lastTopupAt).toBe(new Date('2026-05-22T12:00:00Z').toISOString());
  });

  test('7. Sum precision: Decimal amounts round half-up to 2dp', async () => {
    prisma.wallet.findMany.mockResolvedValue([
      { balance: 100.005 }, // → rounds to 100.01 half-up (epsilon-adjusted)
      { balance: 50.124 },
      { balance: 25.871 },
    ]);
    // Sum = 100.005 + 50.124 + 25.871 = 176.000 → 176.00
    prisma.walletTransaction.findMany
      .mockResolvedValueOnce([
        { amount: 99.999, createdAt: new Date('2026-05-20T10:00:00Z') },
      ])
      .mockResolvedValueOnce([
        { amount: -33.336 },
      ]);

    const res = await request(makeApp())
      .get('/api/wallet/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // round half-up via (n + Number.EPSILON) * 100 → /100
    expect(res.body.totalBalance).toBe(176);
    expect(res.body.totalTopups).toBe(100);
    expect(res.body.totalRedemptions).toBe(33.34);
    // Critical: every Decimal-sum field is a Number, not a string (the
    // wire envelope cannot leak a Prisma.Decimal stringification).
    expect(typeof res.body.totalBalance).toBe('number');
    expect(typeof res.body.totalTopups).toBe('number');
    expect(typeof res.body.totalRedemptions).toBe('number');
  });

  test('8. lastTopupAt picks the most-recent TOP_UP (REDEEM rows do NOT influence it)', async () => {
    prisma.wallet.findMany.mockResolvedValue([{ balance: 1000 }]);
    // TOP_UP rows: oldest 2026-05-01, newest 2026-05-20.
    prisma.walletTransaction.findMany
      .mockResolvedValueOnce([
        { amount: 100, createdAt: new Date('2026-05-01T10:00:00Z') },
        { amount: 200, createdAt: new Date('2026-05-20T15:30:00Z') },
        { amount: 50, createdAt: new Date('2026-05-15T08:00:00Z') },
      ])
      // REDEEM rows AFTER the newest TOP_UP — must NOT bump lastTopupAt.
      // The handler only selects createdAt on the TOP_UP query, so even
      // if REDEEM rows had a newer timestamp it wouldn't matter, but we
      // exclude createdAt from this mock to pin that contract.
      .mockResolvedValueOnce([
        { amount: -30 },
        { amount: -10 },
      ]);

    const res = await request(makeApp())
      .get('/api/wallet/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastTopupAt).toBe(
      new Date('2026-05-20T15:30:00Z').toISOString(),
    );
  });

  test('9. Tenant isolation: different tenantId in JWT → zeroed envelope (prisma scoped by tenantId)', async () => {
    // Simulate a tenant with no wallets / txns / batches — verifies the
    // route is passing tenantId through to every prisma query. We also
    // assert the where clause actually carries the JWT's tenantId.
    const res = await request(makeApp())
      .get('/api/wallet/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 999 })}`);

    expect(res.status).toBe(200);
    expect(res.body.totalWallets).toBe(0);
    expect(res.body.totalBalance).toBe(0);

    // Verify tenant scoping was applied to every query.
    expect(prisma.wallet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 999 }) }),
    );
    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 999, type: 'TOP_UP' }) }),
    );
    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 999, type: 'REDEEM' }) }),
    );
    expect(prisma.walletCreditBatch.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 999 }) }),
    );
  });

  test('10. ?from/?to narrows topups/redemptions (NOT wallet count, which is point-in-time)', async () => {
    prisma.wallet.findMany.mockResolvedValue([
      { balance: 1000 },
      { balance: 500 },
    ]);
    prisma.walletTransaction.findMany
      .mockResolvedValueOnce([{ amount: 100, createdAt: new Date('2026-05-15T10:00:00Z') }])
      .mockResolvedValueOnce([{ amount: -25 }]);

    const res = await request(makeApp())
      .get('/api/wallet/stats?from=2026-05-01&to=2026-05-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Wallet count is point-in-time — full set (NOT narrowed by window).
    expect(res.body.totalWallets).toBe(2);
    expect(res.body.totalBalance).toBe(1500);
    expect(res.body.totalTopups).toBe(100);
    expect(res.body.totalRedemptions).toBe(25);

    // Critically: wallet.findMany was NOT given a createdAt filter.
    const walletCall = prisma.wallet.findMany.mock.calls[0][0];
    expect(walletCall.where.createdAt).toBeUndefined();

    // But the txn queries WERE given a createdAt window (both gte + lte).
    const topupCall = prisma.walletTransaction.findMany.mock.calls.find(
      (c) => c[0].where.type === 'TOP_UP',
    );
    expect(topupCall[0].where.createdAt).toMatchObject({
      gte: expect.any(Date),
      lte: expect.any(Date),
    });
    const redeemCall = prisma.walletTransaction.findMany.mock.calls.find(
      (c) => c[0].where.type === 'REDEEM',
    );
    expect(redeemCall[0].where.createdAt).toMatchObject({
      gte: expect.any(Date),
      lte: expect.any(Date),
    });
  });

  test('11. expiringSoonCount: WalletCreditBatch in (now, now+30d) AND remainingCents > 0 AND status=ACTIVE', async () => {
    prisma.walletCreditBatch.count
      .mockResolvedValueOnce(3) // active
      .mockResolvedValueOnce(2); // expiring-soon

    const res = await request(makeApp())
      .get('/api/wallet/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.expiringSoonCount).toBe(2);

    // 2nd call to count() is the expiring-soon query. Verify the where
    // clause shape: status ACTIVE, remainingCents > 0, expiresAt window.
    const expiringCall = prisma.walletCreditBatch.count.mock.calls[1][0];
    expect(expiringCall.where).toMatchObject({
      tenantId: 1,
      status: 'ACTIVE',
      remainingCents: { gt: 0 },
    });
    expect(expiringCall.where.expiresAt).toMatchObject({
      gt: expect.any(Date),
      lt: expect.any(Date),
    });
    // Window width = 30 days; tolerance for tick-elapse during test.
    const window = expiringCall.where.expiresAt.lt - expiringCall.where.expiresAt.gt;
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(window - thirtyDays)).toBeLessThan(60_000); // < 1min drift
  });

  test('12. activeCreditBatches: status=ACTIVE + remainingCents>0 + (expiresAt null OR > now)', async () => {
    prisma.walletCreditBatch.count
      .mockResolvedValueOnce(5) // active
      .mockResolvedValueOnce(0); // expiring-soon

    const res = await request(makeApp())
      .get('/api/wallet/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.activeCreditBatches).toBe(5);

    // 1st call is the active query. PRINCIPAL batches have expiresAt=null
    // (never expire) and BONUS batches have expiresAt set; ACTIVE counts
    // both via the OR clause.
    const activeCall = prisma.walletCreditBatch.count.mock.calls[0][0];
    expect(activeCall.where).toMatchObject({
      tenantId: 1,
      status: 'ACTIVE',
      remainingCents: { gt: 0 },
    });
    expect(activeCall.where.OR).toEqual([
      { expiresAt: null },
      { expiresAt: { gt: expect.any(Date) } },
    ]);
  });

  test('13. NO audit row written (read-only meta surface)', async () => {
    prisma.wallet.findMany.mockResolvedValue([{ balance: 100 }]);

    const res = await request(makeApp())
      .get('/api/wallet/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
