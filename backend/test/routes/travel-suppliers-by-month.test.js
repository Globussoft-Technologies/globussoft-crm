// @ts-check
/**
 * PRD_TRAVEL_SUPPLIER_MASTER #903 slice 24 — by-month endpoint tests.
 *
 * Pins the contract for the new tenant-wide monthly rollup:
 *   GET /api/travel/suppliers/by-month
 *
 * Mirrors #908 slice 21 (/flyer-templates/by-month) + #900 slice 16
 * (/quotes/by-month) + #901 slice 29 (/invoices/by-month). One row per
 * UTC YYYY-MM bucket with count + activeCount + archivedCount, plus
 * grand totals for the page header.
 *
 * What's pinned
 * -------------
 *   - 400 INVALID_MONTH_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 4 suppliers across 2 months → 2 month rows with
 *     correct counts + month-asc ordering
 *   - Sort: ?orderBy=count:desc flips the ordering
 *   - ?from / ?to narrows the bucket array (single-month window)
 *   - activeCount vs archivedCount split (1 archived in a month;
 *     isActive=false → archived bucket)
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     `subBrand: { in: ['rfu'] }` into the Prisma where (no `null`
 *     clause — TravelSupplier.subBrand is non-nullable, distinct from
 *     the flyer-templates pattern)
 *   - Pagination ?limit / ?offset
 *   - 401 when no Authorization header (verifyToken gate)
 *   - Defensive: row with null createdAt → "unknown" bucket; excluded
 *     when from/to is set
 *
 * Pattern mirrors travel-flyer-templates-by-month.test.js — patch prisma
 * BEFORE requiring the router, drive with real HS256 JWTs against the
 * dev fallback secret. verifyToken + requireTravelTenant +
 * getSubBrandAccessSet all run for real.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelSupplier = prisma.travelSupplier || {};
prisma.travelSupplier.findMany = vi.fn();
prisma.travelSupplier.findFirst = prisma.travelSupplier.findFirst || vi.fn();
prisma.travelSupplier.count = prisma.travelSupplier.count || vi.fn();
prisma.travelSupplier.create = prisma.travelSupplier.create || vi.fn();
prisma.travelSupplier.update = prisma.travelSupplier.update || vi.fn();
prisma.travelSupplierPayable = prisma.travelSupplierPayable || {};
prisma.travelSupplierPayable.findMany = prisma.travelSupplierPayable.findMany || vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const suppliersRouter = requireCJS('../../routes/travel_suppliers');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', suppliersRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Spread of suppliers across May + June 2026, mixed isActive split.
//   2026-05: 3 suppliers, 2 active + 1 archived
//   2026-06: 1 supplier,  1 active + 0 archived
const baseRows = [
  { isActive: true,  createdAt: new Date('2026-05-03T08:00:00Z') },
  { isActive: true,  createdAt: new Date('2026-05-17T10:30:00Z') },
  { isActive: false, createdAt: new Date('2026-05-28T18:45:00Z') },
  { isActive: true,  createdAt: new Date('2026-06-09T09:00:00Z') },
];

beforeEach(() => {
  prisma.travelSupplier.findMany.mockReset().mockResolvedValue(baseRows);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/suppliers/by-month (slice 24)', () => {
  test('400 INVALID_MONTH_FORMAT on bad ?from token (e.g. month 13)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT on short ?from token (e.g. "26")', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month?from=26')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('400 INVALID_MONTH_FORMAT on bad ?to token (no dash)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month?to=20260501')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('happy path: 4 suppliers across 2 months → 2 rows month:asc', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandActiveCount).toBe(3);
    expect(res.body.months).toHaveLength(2);
    expect(res.body.months[0]).toMatchObject({
      month: '2026-05',
      count: 3,
      activeCount: 2,
      archivedCount: 1,
    });
    expect(res.body.months[1]).toMatchObject({
      month: '2026-06',
      count: 1,
      activeCount: 1,
      archivedCount: 0,
    });
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });

  test('orderBy=count:desc puts the busier month first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.months[0].count).toBe(3);
    expect(res.body.months[1].month).toBe('2026-06');
    expect(res.body.months[1].count).toBe(1);
  });

  test('?from=2026-05&to=2026-05 narrows the bucket array to a single month', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month?from=2026-05&to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.grandCount).toBe(3);
    expect(res.body.grandActiveCount).toBe(2);
  });

  test('activeCount vs archivedCount split: 1 archived row in 2026-05', async () => {
    // Reuse baseRows — May has 1 archived row (isActive=false).
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const may = res.body.months.find((m) => m.month === '2026-05');
    expect(may.count).toBe(3);
    expect(may.activeCount).toBe(2);
    expect(may.archivedCount).toBe(1);
    // Per-row identity: count == activeCount + archivedCount
    for (const row of res.body.months) {
      expect(row.count).toBe(row.activeCount + row.archivedCount);
    }
  });

  test('MANAGER subBrandAccess=[rfu] threads { in: [rfu] } into Prisma where (no null clause — non-nullable)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelSupplier.findMany.mockResolvedValue([
      { isActive: true, createdAt: new Date('2026-05-10T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    // Verify the where clause carried the sub-brand narrowing.
    const call = prisma.travelSupplier.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    // TravelSupplier.subBrand is NON-nullable — so this is a single
    // `subBrand: { in: [...] }` clause, NOT the flyer-templates-style
    // `OR: [{ subBrand: { in } }, { subBrand: null }]`.
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(call.where.OR).toBeUndefined();
  });

  test('pagination: ?limit=1&offset=1 returns 2nd row only with stable grand totals', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Totals reflect the FULL aggregation, not the paged window.
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandActiveCount).toBe(3);
    expect(res.body.months).toHaveLength(1);
    // Default order is month:asc → offset=1 returns 2026-06.
    expect(res.body.months[0].month).toBe('2026-06');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month');

    // verifyToken returns 401 for missing/invalid bearer.
    expect(res.status).toBe(401);
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('defensive: row with null createdAt → "unknown" bucket (kept when no from/to set)', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      { isActive: true, createdAt: new Date('2026-05-03T08:00:00Z') },
      { isActive: true, createdAt: null },
      { isActive: false, createdAt: new Date('not a date') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 1 row in 2026-05 + 2 in "unknown" → 2 buckets, 3 rows total.
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(3);
    const unknown = res.body.months.find((m) => m.month === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
    expect(unknown.activeCount).toBe(1);
    expect(unknown.archivedCount).toBe(1);
  });

  test('defensive: "unknown" bucket EXCLUDED when ?from / ?to is set', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      { isActive: true, createdAt: new Date('2026-05-03T08:00:00Z') },
      { isActive: true, createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month?from=2026-01')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].month).toBe('2026-05');
    // grand totals reflect the post-filter set.
    expect(res.body.grandCount).toBe(1);
  });

  test('unknown orderBy token degrades silently to month:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.months[1].month).toBe('2026-06');
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
