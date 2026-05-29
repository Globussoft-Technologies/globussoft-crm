// @ts-check
/**
 * PRD_TRAVEL_SUPPLIER_MASTER #903 slice 26 — by-year endpoint tests.
 *
 * Pins the contract for the new tenant-wide annual rollup:
 *   GET /api/travel/suppliers/by-year
 *
 * Completes the by-month/by-quarter/by-year triplet — mirrors slice 24
 * (/suppliers/by-month) + slice 25 (/suppliers/by-quarter) at the
 * coarsest calendar resolution. One row per UTC YYYY bucket with
 * count + activeCount + archivedCount, plus grand totals for the page
 * header.
 *
 * What's pinned
 * -------------
 *   - 400 INVALID_YEAR_FORMAT on bad ?from / ?to tokens (3-digit,
 *     5-digit, non-numeric, YYYY-MM-shaped)
 *   - Happy path: 4 suppliers spanning 2 years → 2 year rows with
 *     correct counts + year-asc ordering
 *   - Calendar year via getUTCFullYear() — cross-year span resolves to
 *     the expected YYYY tokens
 *   - Sort: ?orderBy=count:desc flips the ordering
 *   - ?from / ?to narrows the bucket array (single-year window)
 *   - activeCount vs archivedCount split (isActive=false → archived
 *     bucket; row identity count == activeCount + archivedCount)
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     `subBrand: { in: ['rfu'] }` into the Prisma where (no `null`
 *     clause — TravelSupplier.subBrand is non-nullable)
 *   - Pagination ?limit / ?offset
 *   - limit cap at 30 (year-scale cap, smaller than by-quarter's 40)
 *   - 401 when no Authorization header (verifyToken gate)
 *   - Defensive: row with null/invalid createdAt → "unknown" bucket;
 *     excluded when from/to is set
 *   - Unknown orderBy degrades silently to year:asc default
 *   - No audit row written by this read-only endpoint
 *
 * Pattern mirrors travel-suppliers-by-quarter.test.js — patch prisma
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

// Spread of suppliers across 2025 + 2026.
//   2025: 1 supplier (Dec),         1 active + 0 archived
//   2026: 3 suppliers (May+Jul+Oct), 2 active + 1 archived
const baseRows = [
  { isActive: true,  createdAt: new Date('2025-12-15T08:00:00Z') }, // 2025
  { isActive: true,  createdAt: new Date('2026-05-17T10:30:00Z') }, // 2026
  { isActive: false, createdAt: new Date('2026-07-09T09:00:00Z') }, // 2026
  { isActive: true,  createdAt: new Date('2026-10-28T18:45:00Z') }, // 2026
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

describe('GET /api/travel/suppliers/by-year (slice 26)', () => {
  test('400 INVALID_YEAR_FORMAT on bad ?from token (3-digit year)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year?from=202')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
    expect(prisma.travelSupplier.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_YEAR_FORMAT on bad ?from token (5-digit year)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year?from=20260')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('400 INVALID_YEAR_FORMAT on ?to with YYYY-MM shape (not bare year)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year?to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('400 INVALID_YEAR_FORMAT on non-numeric ?from token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year?from=abcd')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('happy path: 4 suppliers across 2 years → 2 rows year:asc', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandActiveCount).toBe(3);
    expect(res.body.years).toHaveLength(2);
    expect(res.body.years[0]).toMatchObject({
      year: '2025',
      count: 1,
      activeCount: 1,
      archivedCount: 0,
    });
    expect(res.body.years[1]).toMatchObject({
      year: '2026',
      count: 3,
      activeCount: 2,
      archivedCount: 1,
    });
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  test('calendar year via getUTCFullYear(): cross-year span resolves to expected YYYY tokens', async () => {
    // 1 supplier per year across a 4-year window.
    prisma.travelSupplier.findMany.mockResolvedValue([
      { isActive: true, createdAt: new Date('2023-06-15T08:00:00Z') },
      { isActive: true, createdAt: new Date('2024-06-15T08:00:00Z') },
      { isActive: true, createdAt: new Date('2025-06-15T08:00:00Z') },
      { isActive: true, createdAt: new Date('2026-06-15T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(4);
    const tokens = res.body.years.map((y) => y.year);
    expect(tokens).toEqual(['2023', '2024', '2025', '2026']);
  });

  test('orderBy=count:desc puts the busier year first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.years[0].count).toBe(3);
    expect(res.body.years[1].year).toBe('2025');
    expect(res.body.years[1].count).toBe(1);
  });

  test('?from=2026&to=2026 narrows the bucket array to a single year', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year?from=2026&to=2026')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.grandCount).toBe(3);
    expect(res.body.grandActiveCount).toBe(2);
  });

  test('activeCount vs archivedCount split: 1 archived row in 2026', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const y2026 = res.body.years.find((y) => y.year === '2026');
    expect(y2026.count).toBe(3);
    expect(y2026.activeCount).toBe(2);
    expect(y2026.archivedCount).toBe(1);
    // Per-row identity: count == activeCount + archivedCount
    for (const row of res.body.years) {
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
      .get('/api/travel/suppliers/by-year')
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
      .get('/api/travel/suppliers/by-year?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Totals reflect the FULL aggregation, not the paged window.
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandActiveCount).toBe(3);
    expect(res.body.years).toHaveLength(1);
    // Default order is year:asc → offset=1 returns 2026.
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('limit cap: ?limit=200 clamps to 30 (year-scale cap)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year?limit=200')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(30);
  });

  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year');

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
      .get('/api/travel/suppliers/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 1 row in 2026 + 2 in "unknown" → 2 buckets, 3 rows total.
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(3);
    const unknown = res.body.years.find((y) => y.year === 'unknown');
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
      .get('/api/travel/suppliers/by-year?from=2024')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.grandCount).toBe(1);
  });

  test('unknown orderBy token degrades silently to year:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[1].year).toBe('2026');
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
