// @ts-check
/**
 * D17 POS New Sale — Arc 1 polish slice: GET /api/pos/sales/stats.
 *
 * First tenant-wide aggregate endpoint added to backend/routes/pos.js
 * (the 30+ existing endpoints are per-register / per-shift / per-sale).
 * Pins the owner-dashboard POS tile's KPI surface — total + totalRevenue
 * + byStatus + refundCount + voidCount + averageSaleValue + lastSaleAt —
 * and the cross-cutting contracts around it:
 *
 *   - Auth gate:    no req.user → 401 Authentication required (verifyWellnessRole).
 *   - RBAC:         role=USER + wellnessRole=null → 403 WELLNESS_ROLE_FORBIDDEN
 *                   (adminGate = verifyWellnessRole(['admin', 'manager'])).
 *                   Tighter than cashierGate intentionally — tenant-wide
 *                   aggregate is owner-dashboard surface, minimise PII
 *                   exposure.
 *   - Date input:   bad ?from / ?to → 400 INVALID_DATE.
 *   - Empty tenant: every aggregate 0, lastSaleAt null, byStatus={}.
 *   - Happy path:   3 COMPLETED + 1 VOIDED + 1 REFUNDED → counts + revenue
 *                   correct; averageSaleValue divides by COMPLETED count
 *                   (not total) to avoid skew from drafts/voids/refunds.
 *   - Precision:    Float sums round half-up to 2dp via
 *                   `Math.round((n + Number.EPSILON) * 100) / 100`.
 *   - Zero-completed: averageSaleValue=0 when no COMPLETED sales (avoid /0).
 *   - Tenant iso:   different tenantId in JWT → zeroed envelope; prisma
 *                   where always carries the JWT's tenantId.
 *   - Window:       ?from/?to narrows the count + totalRevenue.
 *   - lastSaleAt:   picks newest createdAt across all rows in window.
 *   - No audit row: read-only meta surface; mirrors /wallet/stats +
 *                   /suppliers/stats.
 *
 * Mock pattern mirrors backend/test/routes/pos-void-refund.test.js +
 * backend/test/routes/wallet-stats.test.js — patch the prisma singleton
 * with vi.fn() shapes BEFORE requiring the router, then drive supertest
 * with a custom req.user-stub middleware (same shape as the POS sibling
 * tests). prisma.tenant.findUnique returns vertical='wellness' so the
 * wellness-vertical gate inside verifyWellnessRole passes.
 *
 * Sale status enum (schema.prisma:4028 + routes/pos.js void/refund):
 *   DRAFT | COMPLETED | VOIDED | REFUNDED | PARTIALLY_REFUNDED
 * Revenue column = Sale.total (Float, schema.prisma:4025).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by /sales/stats ──
prisma.sale = prisma.sale || {};
prisma.sale.findMany = vi.fn();

// verifyWellnessRole reads tenant.vertical via prisma.tenant.findUnique.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });

prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const posRouter = requireCJS('../../routes/pos');

/**
 * Build an Express test app with a req.user-stubbing middleware in front
 * of the pos router. Pass `stubUser: false` to skip the stub entirely
 * (simulates a request with no Authorization header — verifyWellnessRole
 * returns 401 Authentication required).
 */
function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = 'admin',
  vertical = 'wellness',
  stubUser = true,
} = {}) {
  const app = express();
  app.use(express.json());
  if (stubUser) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role, wellnessRole, vertical };
      next();
    });
  }
  app.use('/api/pos', posRouter);
  return app;
}

beforeEach(() => {
  prisma.sale.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'wellness' });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/pos/sales/stats', () => {
  test('1. 401 when no req.user (no Authorization header)', async () => {
    const res = await request(makeApp({ stubUser: false })).get(
      '/api/pos/sales/stats',
    );
    expect(res.status).toBe(401);
    // verifyWellnessRole bails at the !req.user check before any prisma read.
    expect(prisma.sale.findMany).not.toHaveBeenCalled();
  });

  test('2. 403 WELLNESS_ROLE_FORBIDDEN when caller is USER role (no wellnessRole)', async () => {
    const res = await request(
      makeApp({ role: 'USER', wellnessRole: null }),
    ).get('/api/pos/sales/stats');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    // adminGate denies before the handler body — no prisma reads.
    expect(prisma.sale.findMany).not.toHaveBeenCalled();
  });

  test('3. 400 INVALID_DATE on bad ?from', async () => {
    const res = await request(makeApp()).get(
      '/api/pos/sales/stats?from=not-a-date',
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.sale.findMany).not.toHaveBeenCalled();
  });

  test('4. 400 INVALID_DATE on bad ?to', async () => {
    const res = await request(makeApp()).get(
      '/api/pos/sales/stats?to=not-a-date',
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.sale.findMany).not.toHaveBeenCalled();
  });

  test('5. Empty tenant: every aggregate 0, lastSaleAt null, byStatus={}', async () => {
    const res = await request(makeApp()).get('/api/pos/sales/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      totalRevenue: 0,
      byStatus: {},
      refundCount: 0,
      voidCount: 0,
      averageSaleValue: 0,
      lastSaleAt: null,
    });
    // NO audit row written (read-only meta surface).
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('6. Happy path: 5 sales (3 COMPLETED + 1 VOIDED + 1 REFUNDED) → counts + totalRevenue correct', async () => {
    prisma.sale.findMany.mockResolvedValue([
      { total: 1000, status: 'COMPLETED', createdAt: new Date('2026-05-20T10:00:00Z') },
      { total: 500, status: 'COMPLETED', createdAt: new Date('2026-05-21T11:00:00Z') },
      { total: 250, status: 'COMPLETED', createdAt: new Date('2026-05-22T12:00:00Z') },
      { total: 100, status: 'VOIDED', createdAt: new Date('2026-05-19T09:00:00Z') },
      { total: 200, status: 'REFUNDED', createdAt: new Date('2026-05-18T08:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/pos/sales/stats');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 5,
      // totalRevenue sums ONLY COMPLETED rows: 1000 + 500 + 250 = 1750
      totalRevenue: 1750,
      byStatus: { COMPLETED: 3, VOIDED: 1, REFUNDED: 1 },
      refundCount: 1,
      voidCount: 1,
      // 1750 / 3 = 583.33 (half-up)
      averageSaleValue: 583.33,
    });
    // lastSaleAt = newest createdAt across ALL rows (2026-05-22T12:00:00Z)
    expect(res.body.lastSaleAt).toBe(
      new Date('2026-05-22T12:00:00Z').toISOString(),
    );
  });

  test('7. averageSaleValue divides by COMPLETED count (not total count) — pin the formula', async () => {
    // 2 COMPLETED at ₹500 each (total=1000) + 8 drafts/voids/refunds.
    // If we divided by total (10), avg = 100. Correct divides by 2 = 500.
    prisma.sale.findMany.mockResolvedValue([
      { total: 500, status: 'COMPLETED', createdAt: new Date('2026-05-20T10:00:00Z') },
      { total: 500, status: 'COMPLETED', createdAt: new Date('2026-05-21T10:00:00Z') },
      { total: 0, status: 'DRAFT', createdAt: new Date('2026-05-15T10:00:00Z') },
      { total: 0, status: 'DRAFT', createdAt: new Date('2026-05-15T10:00:00Z') },
      { total: 100, status: 'VOIDED', createdAt: new Date('2026-05-15T10:00:00Z') },
      { total: 100, status: 'VOIDED', createdAt: new Date('2026-05-15T10:00:00Z') },
      { total: 100, status: 'VOIDED', createdAt: new Date('2026-05-15T10:00:00Z') },
      { total: 100, status: 'REFUNDED', createdAt: new Date('2026-05-15T10:00:00Z') },
      { total: 100, status: 'REFUNDED', createdAt: new Date('2026-05-15T10:00:00Z') },
      { total: 100, status: 'PARTIALLY_REFUNDED', createdAt: new Date('2026-05-15T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/pos/sales/stats');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(10);
    expect(res.body.totalRevenue).toBe(1000);
    expect(res.body.averageSaleValue).toBe(500); // 1000 / 2 (NOT 1000 / 10 = 100)
    expect(res.body.byStatus).toEqual({
      COMPLETED: 2,
      DRAFT: 2,
      VOIDED: 3,
      REFUNDED: 2,
      PARTIALLY_REFUNDED: 1,
    });
    // refundCount = REFUNDED + PARTIALLY_REFUNDED (3); voidCount = VOIDED (3).
    expect(res.body.refundCount).toBe(3);
    expect(res.body.voidCount).toBe(3);
  });

  test('8. averageSaleValue = 0 when no COMPLETED sales (avoid divide-by-zero)', async () => {
    prisma.sale.findMany.mockResolvedValue([
      { total: 100, status: 'DRAFT', createdAt: new Date('2026-05-15T10:00:00Z') },
      { total: 200, status: 'VOIDED', createdAt: new Date('2026-05-16T10:00:00Z') },
      { total: 300, status: 'REFUNDED', createdAt: new Date('2026-05-17T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/pos/sales/stats');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.totalRevenue).toBe(0); // No COMPLETED → 0
    expect(res.body.averageSaleValue).toBe(0); // Divide-by-zero guarded → 0
    expect(res.body.byStatus).toEqual({
      DRAFT: 1,
      VOIDED: 1,
      REFUNDED: 1,
    });
  });

  test('9. Tenant isolation: different tenantId in JWT → zeroed envelope; prisma scoped by tenantId', async () => {
    const res = await request(makeApp({ tenantId: 999 })).get(
      '/api/pos/sales/stats',
    );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.totalRevenue).toBe(0);

    // Verify tenant scoping was applied to the query.
    expect(prisma.sale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 999 }),
      }),
    );
  });

  test('10. ?from/?to narrows the count + totalRevenue window', async () => {
    prisma.sale.findMany.mockResolvedValue([
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-05-15T10:00:00Z') },
      { total: 200, status: 'COMPLETED', createdAt: new Date('2026-05-20T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get(
      '/api/pos/sales/stats?from=2026-05-01&to=2026-05-31',
    );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.totalRevenue).toBe(300);

    // Verify the where.createdAt window was applied with BOTH gte + lte.
    const call = prisma.sale.findMany.mock.calls[0][0];
    expect(call.where.createdAt).toMatchObject({
      gte: expect.any(Date),
      lte: expect.any(Date),
    });
  });

  test('11. lastSaleAt picks the most-recent createdAt across all rows', async () => {
    prisma.sale.findMany.mockResolvedValue([
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-05-01T10:00:00Z') },
      { total: 200, status: 'VOIDED', createdAt: new Date('2026-05-25T15:30:00Z') }, // newest
      { total: 300, status: 'REFUNDED', createdAt: new Date('2026-05-15T08:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/pos/sales/stats');

    expect(res.status).toBe(200);
    // lastSaleAt picks the absolute newest createdAt across ALL rows (incl.
    // voids/refunds — it's a recency signal, not a revenue signal).
    expect(res.body.lastSaleAt).toBe(
      new Date('2026-05-25T15:30:00Z').toISOString(),
    );
  });

  test('12. NO audit row written (read-only meta surface)', async () => {
    prisma.sale.findMany.mockResolvedValue([
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-05-20T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/pos/sales/stats');

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('13. Half-up rounding: totalRevenue + averageSaleValue round to 2dp', async () => {
    // 3 COMPLETED rows: 100.005 + 50.124 + 25.871 = 176.000 → 176.00.
    // averageSaleValue = 176.00 / 3 = 58.6666... → 58.67 (half-up).
    prisma.sale.findMany.mockResolvedValue([
      { total: 100.005, status: 'COMPLETED', createdAt: new Date('2026-05-20T10:00:00Z') },
      { total: 50.124, status: 'COMPLETED', createdAt: new Date('2026-05-21T10:00:00Z') },
      { total: 25.871, status: 'COMPLETED', createdAt: new Date('2026-05-22T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/pos/sales/stats');

    expect(res.status).toBe(200);
    expect(res.body.totalRevenue).toBe(176); // 176.00 (display 176)
    expect(res.body.averageSaleValue).toBe(58.67); // half-up to 2dp
    // Critically: every Float-sum field is a Number, not a Prisma.Decimal string.
    expect(typeof res.body.totalRevenue).toBe('number');
    expect(typeof res.body.averageSaleValue).toBe('number');
  });
});
