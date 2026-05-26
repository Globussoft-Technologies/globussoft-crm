// @ts-check
/**
 * D16 Wallet Top-up — Arc 1 polish slice: GET /api/wallet/by-month.
 *
 * Sibling to /stats — both ship under backend/routes/wallet.js as
 * tenant-wide read-only meta endpoints powering the dashboard wallet tile
 * (/stats) and the dashboard wallet trend chart (/by-month).
 *
 * Pins the monthly-rollup contract:
 *
 *   - Auth gate:        missing token → 401 (verifyToken).
 *   - RBAC:             USER role → 403 RBAC_DENIED
 *                       (verifyRole(['ADMIN','MANAGER']) — same set as /stats).
 *   - Month-format:     bad ?from / ?to → 400 INVALID_MONTH_FORMAT.
 *   - Empty tenant:     total=0, rows=[].
 *   - Happy path:       5 transactions across 2 months → 2 month rows;
 *                       per-bucket counts + amounts correct (REDEEM rows
 *                       stored negative but surface POSITIVE in redeemAmount
 *                       via Math.abs).
 *   - REDEEM math:      negative amount-rupees row surfaces as positive
 *                       redeemAmount sum (mirrors /stats:673 wire shape).
 *   - Default sort:     orderBy=month:asc — chronological.
 *   - count sort:       orderBy=count:desc — flips order; count =
 *                       topupCount + redeemCount.
 *   - ?from/?to filter: narrows the bucket array (excludes "unknown" when
 *                       either bound is set).
 *   - Defensive:        null createdAt → "unknown" bucket (when neither
 *                       bound set).
 *   - Pagination:       ?limit=2&offset=1 slices AFTER aggregation+sort.
 *   - Tenant isolation: different tenantId in JWT → prisma where carries
 *                       that tenantId.
 *   - No audit row:     read-only meta surface; mirrors /stats.
 *
 * Mock pattern mirrors backend/test/routes/wallet-stats.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with HS256 JWTs signed against the dev-fallback
 * secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.walletTransaction = prisma.walletTransaction || {};
prisma.walletTransaction.findMany = vi.fn();

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
  prisma.walletTransaction.findMany.mockReset().mockResolvedValue([]);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/wallet/by-month', () => {
  test('1. 401 when no Authorization header', async () => {
    const res = await request(makeApp()).get('/api/wallet/by-month');
    expect(res.status).toBe(401);
    // verifyToken fires before the route handler → no prisma reads.
    expect(prisma.walletTransaction.findMany).not.toHaveBeenCalled();
  });

  test('2. 403 RBAC_DENIED when caller is USER role (ADMIN+MANAGER only)', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    // verifyRole fires before the route handler body — no prisma reads.
    expect(prisma.walletTransaction.findMany).not.toHaveBeenCalled();
  });

  test('3. 400 INVALID_MONTH_FORMAT on bad ?from', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/by-month?from=not-a-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('4. 400 INVALID_MONTH_FORMAT on bad ?to', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/by-month?to=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('5. Empty tenant: total=0, rows=[]', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, rows: [] });
    // NO audit row written (read-only meta surface).
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('6. Happy path: 5 transactions across 2 months → 2 month rows with correct counts + amounts', async () => {
    // 3 TOP_UPs + 2 REDEEMs across 2026-04 and 2026-05.
    // 2026-04: 1 TOP_UP (1000) + 1 REDEEM (-200 → 200)
    // 2026-05: 2 TOP_UPs (500 + 250) + 1 REDEEM (-50 → 50)
    prisma.walletTransaction.findMany.mockResolvedValue([
      { type: 'TOP_UP', amount: 1000, createdAt: new Date('2026-04-15T10:00:00Z') },
      { type: 'REDEEM', amount: -200, createdAt: new Date('2026-04-20T10:00:00Z') },
      { type: 'TOP_UP', amount: 500, createdAt: new Date('2026-05-10T10:00:00Z') },
      { type: 'TOP_UP', amount: 250, createdAt: new Date('2026-05-15T10:00:00Z') },
      { type: 'REDEEM', amount: -50, createdAt: new Date('2026-05-20T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/wallet/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);

    // Default orderBy=month:asc → 2026-04 first.
    expect(res.body.rows[0]).toEqual({
      month: '2026-04',
      topupCount: 1,
      redeemCount: 1,
      topupAmount: 1000,
      redeemAmount: 200,
    });
    expect(res.body.rows[1]).toEqual({
      month: '2026-05',
      topupCount: 2,
      redeemCount: 1,
      topupAmount: 750,
      redeemAmount: 50,
    });
  });

  test('7. REDEEM amount uses Math.abs (negative stored → positive surfaced)', async () => {
    // Single REDEEM row stored as -333.33 should surface as redeemAmount: 333.33.
    prisma.walletTransaction.findMany.mockResolvedValue([
      { type: 'REDEEM', amount: -333.33, createdAt: new Date('2026-05-10T10:00:00Z') },
      { type: 'REDEEM', amount: -100, createdAt: new Date('2026-05-15T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/wallet/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toEqual({
      month: '2026-05',
      topupCount: 0,
      redeemCount: 2,
      topupAmount: 0,
      redeemAmount: 433.33,
    });
    // redeemAmount must be a Number (no Decimal stringification leak).
    expect(typeof res.body.rows[0].redeemAmount).toBe('number');
  });

  test('8. Default orderBy=month:asc — chronological', async () => {
    // Intentionally out-of-order input.
    prisma.walletTransaction.findMany.mockResolvedValue([
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-05-15T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-03-15T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-04-15T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/wallet/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-03', '2026-04', '2026-05']);
  });

  test('9. ?orderBy=count:desc flips ordering (count = topupCount + redeemCount)', async () => {
    // 2026-03: 1 tx total. 2026-04: 3 tx total. 2026-05: 2 tx total.
    prisma.walletTransaction.findMany.mockResolvedValue([
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-03-15T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-04-10T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-04-15T10:00:00Z') },
      { type: 'REDEEM', amount: -50, createdAt: new Date('2026-04-20T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-05-10T10:00:00Z') },
      { type: 'REDEEM', amount: -25, createdAt: new Date('2026-05-15T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/wallet/by-month?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Highest count (2026-04: 3) first, then 2026-05: 2, then 2026-03: 1.
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-04', '2026-05', '2026-03']);
  });

  test('10. ?from / ?to narrows the bucket array', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-02-10T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-03-10T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-04-10T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-05-10T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-06-10T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/wallet/by-month?from=2026-03&to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-03', '2026-04', '2026-05']);
  });

  test('11. Defensive: null createdAt → "unknown" bucket (when no bounds set)', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([
      { type: 'TOP_UP', amount: 100, createdAt: null },
      { type: 'REDEEM', amount: -25, createdAt: null },
      { type: 'TOP_UP', amount: 50, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/wallet/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const unknown = res.body.rows.find((r) => r.month === 'unknown');
    expect(unknown).toEqual({
      month: 'unknown',
      topupCount: 1,
      redeemCount: 1,
      topupAmount: 100,
      redeemAmount: 25,
    });
  });

  test('12. Pagination ?limit=2&offset=1 slices AFTER aggregation+sort', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-01-10T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-02-10T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-03-10T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-04-10T10:00:00Z') },
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/wallet/by-month?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // total = pre-pagination bucket count (5 months).
    expect(res.body.total).toBe(5);
    // After skip=1, take=2 → months [02, 03].
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-02', '2026-03']);
  });

  test('13. Tenant isolation: prisma where.tenantId carries the JWT tenantId', async () => {
    const res = await request(makeApp())
      .get('/api/wallet/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 999 })}`);

    expect(res.status).toBe(200);
    expect(prisma.walletTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 999 }),
      }),
    );
  });

  test('14. NO audit row written (read-only meta surface)', async () => {
    prisma.walletTransaction.findMany.mockResolvedValue([
      { type: 'TOP_UP', amount: 100, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/wallet/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
