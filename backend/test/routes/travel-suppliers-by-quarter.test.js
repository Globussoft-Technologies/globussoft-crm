// @ts-check
/**
 * PRD_TRAVEL_SUPPLIER_MASTER #903 slice 25 — by-quarter endpoint tests.
 *
 * Pins the contract for the new tenant-wide quarterly rollup:
 *   GET /api/travel/suppliers/by-quarter
 *
 * Mirrors slice 24 (/suppliers/by-month) at quarter resolution + the
 * #901 slice 30 (/invoices/by-quarter) + #900 slice 17 (/quotes/by-quarter)
 * + #908 slice 22 (/flyer-templates/by-quarter) pattern. One row per
 * UTC YYYY-Qn bucket with count + activeCount + archivedCount, plus
 * grand totals for the page header.
 *
 * What's pinned
 * -------------
 *   - 400 INVALID_QUARTER_FORMAT on bad ?from / ?to tokens (Q5, no-Q,
 *     short-year, non-Q suffix)
 *   - Happy path: 4 suppliers spanning Q2 + Q3 of 2026 → 2 quarter rows
 *     with correct counts + quarter-asc ordering
 *   - Calendar quarter math: Math.floor(month/3)+1 (Jan-Mar=Q1,
 *     Apr-Jun=Q2, Jul-Sep=Q3, Oct-Dec=Q4) — verified by mixing dates
 *     across quarter boundaries
 *   - Sort: ?orderBy=count:desc flips the ordering
 *   - ?from / ?to narrows the bucket array (single-quarter window)
 *   - activeCount vs archivedCount split (isActive=false → archived
 *     bucket; row identity count == activeCount + archivedCount)
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     `subBrand: { in: ['rfu'] }` into the Prisma where (no `null`
 *     clause — TravelSupplier.subBrand is non-nullable, distinct from
 *     the flyer-templates pattern)
 *   - Pagination ?limit / ?offset
 *   - 401 when no Authorization header (verifyToken gate)
 *   - Defensive: row with null/invalid createdAt → "unknown" bucket;
 *     excluded when from/to is set
 *   - Unknown orderBy degrades silently to quarter:asc default
 *   - No audit row written by this read-only endpoint
 *
 * Pattern mirrors travel-suppliers-by-month.test.js — patch prisma
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

// Spread of suppliers across Q2 (Apr-Jun) + Q3 (Jul-Sep) of 2026.
//   2026-Q2: 3 suppliers (May + May + Jun), 2 active + 1 archived
//   2026-Q3: 1 supplier  (Jul),             1 active + 0 archived
const baseRows = [
  { isActive: true,  createdAt: new Date('2026-05-03T08:00:00Z') }, // Q2
  { isActive: true,  createdAt: new Date('2026-05-17T10:30:00Z') }, // Q2
  { isActive: false, createdAt: new Date('2026-06-28T18:45:00Z') }, // Q2
  { isActive: true,  createdAt: new Date('2026-07-09T09:00:00Z') }, // Q3
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
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/travel/suppliers/by-quarter (slice 25)', () => {
  test('400 INVALID_QUARTER_FORMAT on bad ?from token (Q5)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-quarter?from=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?from token (Q0)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-quarter?from=2026-Q0')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('400 INVALID_QUARTER_FORMAT on ?to without Q prefix (YYYY-MM-shaped)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-quarter?to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('happy path: 4 suppliers across 2 quarters → 2 rows quarter:asc', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandActiveCount).toBe(3);
    expect(res.body.quarters).toHaveLength(2);
    expect(res.body.quarters[0]).toMatchObject({
      quarter: '2026-Q2',
      count: 3,
      activeCount: 2,
      archivedCount: 1,
    });
    expect(res.body.quarters[1]).toMatchObject({
      quarter: '2026-Q3',
      count: 1,
      activeCount: 1,
      archivedCount: 0,
    });
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });

  test('calendar quarter math: months 0..11 land in correct YYYY-Qn buckets', async () => {
    // 1 supplier per quarter, cross-year span to exercise Math.floor(m/3)+1.
    prisma.travelSupplier.findMany.mockResolvedValue([
      { isActive: true, createdAt: new Date('2026-01-15T08:00:00Z') }, // Q1
      { isActive: true, createdAt: new Date('2026-04-15T08:00:00Z') }, // Q2
      { isActive: true, createdAt: new Date('2026-07-15T08:00:00Z') }, // Q3
      { isActive: true, createdAt: new Date('2026-10-15T08:00:00Z') }, // Q4
      { isActive: true, createdAt: new Date('2027-01-15T08:00:00Z') }, // 2027-Q1
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(5);
    const tokens = res.body.quarters.map((q) => q.quarter);
    expect(tokens).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4', '2027-Q1']);
  });

  test('orderBy=count:desc puts the busier quarter first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-quarter?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.quarters[0].count).toBe(3);
    expect(res.body.quarters[1].quarter).toBe('2026-Q3');
    expect(res.body.quarters[1].count).toBe(1);
  });

  test('?from=2026-Q2&to=2026-Q2 narrows the bucket array to a single quarter', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-quarter?from=2026-Q2&to=2026-Q2')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(1);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.grandCount).toBe(3);
    expect(res.body.grandActiveCount).toBe(2);
  });

  test('activeCount vs archivedCount split: 1 archived row in 2026-Q2', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const q2 = res.body.quarters.find((q) => q.quarter === '2026-Q2');
    expect(q2.count).toBe(3);
    expect(q2.activeCount).toBe(2);
    expect(q2.archivedCount).toBe(1);
    // Per-row identity: count == activeCount + archivedCount
    for (const row of res.body.quarters) {
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
      .get('/api/travel/suppliers/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
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
      .get('/api/travel/suppliers/by-quarter?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Totals reflect the FULL aggregation, not the paged window.
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandActiveCount).toBe(3);
    expect(res.body.quarters).toHaveLength(1);
    // Default order is quarter:asc → offset=1 returns 2026-Q3.
    expect(res.body.quarters[0].quarter).toBe('2026-Q3');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('limit cap: ?limit=200 clamps to 40 (quarter-scale cap)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-quarter?limit=200')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(40);
  });

  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-quarter');

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
      .get('/api/travel/suppliers/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 1 row in 2026-Q2 + 2 in "unknown" → 2 buckets, 3 rows total.
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.grandCount).toBe(3);
    const unknown = res.body.quarters.find((q) => q.quarter === 'unknown');
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
      .get('/api/travel/suppliers/by-quarter?from=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(1);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.grandCount).toBe(1);
  });

  test('unknown orderBy token degrades silently to quarter:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-quarter?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.quarters[0].quarter).toBe('2026-Q2');
    expect(res.body.quarters[1].quarter).toBe('2026-Q3');
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
