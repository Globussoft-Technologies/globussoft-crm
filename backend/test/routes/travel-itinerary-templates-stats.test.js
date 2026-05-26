// @ts-check
/**
 * #907 rollup-family completion — GET /api/travel/itinerary-templates/stats.
 *
 * Pins the contract for the tenant-wide aggregate handler on
 * backend/routes/travel_itinerary_templates.js (declared BEFORE GET /:id,
 * so Express doesn't try to parse "stats" as a numeric :id and 400).
 *
 * Why distinct from the existing travel-itinerary-templates.test.js
 * -----------------------------------------------------------------
 * The sibling test file covers list + CRUD (POST / GET / PATCH / DELETE)
 * landed in slice 6 (commit 8972b8ca). The /stats endpoint (this file) is
 * the canonical tenant-wide aggregate envelope — separate concern, separate
 * test scaffolding.
 *
 * ItineraryTemplate has no status enum; the envelope groups by category +
 * isActive instead, and adds:
 *   - averageDurationDays  (mean days across templates)
 *   - averageBasePriceMinor / averageDefaultMarkupPercent
 *   - totalUsageCount      (sum of usageCount across templates)
 *   - topByUsage[]         (5 highest usageCount templates with id+name)
 *   - topDestinations[]    (5 most-common destinationName)
 *
 * Mirrors the travel_sightseeing /stats template at commit b0f702f5.
 *
 * Contracts asserted (12 cases)
 * -----------------------------
 *   1. ADMIN + mixed-category → byCategory + activeCount aggregates correct
 *   2. Empty result → zeroed envelope shape
 *   3. ?from=ISO + ?to=ISO threads where.createdAt = {gte, lte}
 *   4. ?from=garbage → 400 INVALID_DATE
 *   5. ?to=garbage   → 400 INVALID_DATE
 *   6. Non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant
 *   7. Unauthenticated → 401
 *   8. Sub-brand allow-set EMPTY → zeroed envelope (NOT 403, per #976 fix)
 *   9. Sub-brand allow-set NARROW → where.subBrand = { in: [...] }
 *  10. Tenant isolation — token tenantId=A → where.tenantId=A
 *  11. totalUsageCount sums usageCount across all rows
 *  12. topByUsage sorted desc + capped at 5
 *
 * Mocking strategy
 * ----------------
 * Patch prisma singleton with vi.fn() shapes BEFORE requiring the router
 * (CJS require — module cache is pinned by the patch). Real verifyToken
 * + requireTravelTenant middleware runs. Real getSubBrandAccessSet runs
 * (user.findUnique controls the access set). HS256 JWTs signed with the
 * dev fallback secret = "enterprise_super_secret_key_2026".
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.itineraryTemplate = prisma.itineraryTemplate || {};
prisma.itineraryTemplate.findMany = vi.fn();
prisma.itineraryTemplate.findFirst = prisma.itineraryTemplate.findFirst || vi.fn();
prisma.itineraryTemplate.count = prisma.itineraryTemplate.count || vi.fn();
prisma.itineraryTemplate.create = prisma.itineraryTemplate.create || vi.fn();
prisma.itineraryTemplate.update = prisma.itineraryTemplate.update || vi.fn();
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
const itineraryTemplatesRouter = requireCJS('../../routes/travel_itinerary_templates');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/itinerary-templates', itineraryTemplatesRouter);
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
  prisma.itineraryTemplate.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/itinerary-templates/stats', () => {
  test('case 1: ADMIN + mixed-category → byCategory + activeCount aggregates correctly', async () => {
    // 3 Adventure (2 active + 1 inactive), 2 Religious (active), 1 Family (active)
    prisma.itineraryTemplate.findMany.mockResolvedValue([
      { id: 1, name: '5-day Bali Trek',    destinationName: 'Bali',    subBrand: 'tmc',         category: 'Adventure', isActive: true,  durationDays: 5, basePriceMinor: 50000, defaultMarkupPercent: 15, usageCount: 10, updatedAt: new Date('2026-04-01T00:00:00Z') },
      { id: 2, name: '3-day Bali Quick',   destinationName: 'Bali',    subBrand: 'tmc',         category: 'Adventure', isActive: true,  durationDays: 3, basePriceMinor: 25000, defaultMarkupPercent: 12, usageCount: 7,  updatedAt: new Date('2026-04-02T00:00:00Z') },
      { id: 3, name: '7-day Nepal Trek',   destinationName: 'Nepal',   subBrand: 'rfu',         category: 'Adventure', isActive: false, durationDays: 7, basePriceMinor: 70000, defaultMarkupPercent: 20, usageCount: 2,  updatedAt: new Date('2026-04-05T00:00:00Z') },
      { id: 4, name: '5-day Mecca Umrah',  destinationName: 'Mecca',   subBrand: 'rfu',         category: 'Religious', isActive: true,  durationDays: 5, basePriceMinor: 80000, defaultMarkupPercent: 18, usageCount: 25, updatedAt: new Date('2026-04-06T00:00:00Z') },
      { id: 5, name: '7-day Madinah',      destinationName: 'Madinah', subBrand: 'travelstall', category: 'Religious', isActive: true,  durationDays: 7, basePriceMinor: 90000, defaultMarkupPercent: 20, usageCount: 15, updatedAt: new Date('2026-04-10T00:00:00Z') },
      { id: 6, name: '4-day Goa Beach',    destinationName: 'Goa',     subBrand: 'visasure',    category: 'Family',    isActive: true,  durationDays: 4, basePriceMinor: 30000, defaultMarkupPercent: 10, usageCount: 5,  updatedAt: new Date('2026-04-20T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(6);
    expect(res.body.activeCount).toBe(5);
    expect(res.body.inactiveCount).toBe(1);
    expect(res.body.byCategory).toEqual({
      Adventure: 3,
      Religious: 2,
      Family: 1,
    });
    expect(res.body.bySubBrand).toEqual({
      tmc:         { count: 2 },
      rfu:         { count: 2 },
      travelstall: { count: 1 },
      visasure:    { count: 1 },
    });
    // averageDurationDays = (5+3+7+5+7+4)/6 = 31/6 = 5.166... → round2 = 5.17
    expect(res.body.averageDurationDays).toBe(5.17);
    // averageBasePriceMinor = (50000+25000+70000+80000+90000+30000)/6 = 345000/6 = 57500
    expect(res.body.averageBasePriceMinor).toBe(57500);
    // averageDefaultMarkupPercent = (15+12+20+18+20+10)/6 = 95/6 = 15.833... → round2 = 15.83
    expect(res.body.averageDefaultMarkupPercent).toBe(15.83);
    // totalUsageCount = 10+7+2+25+15+5 = 64
    expect(res.body.totalUsageCount).toBe(64);
    // topDestinations: Bali=2, the rest at 1 each (Nepal, Mecca, Madinah, Goa)
    expect(res.body.topDestinations[0]).toEqual({ destinationName: 'Bali', count: 2 });
    // lastUpdatedAt = max updatedAt (id=6, 2026-04-20)
    expect(res.body.lastUpdatedAt).toBe(new Date('2026-04-20T00:00:00Z').toISOString());
  });

  test('case 2: empty result → zeroed envelope shape', async () => {
    prisma.itineraryTemplate.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      activeCount: 0,
      inactiveCount: 0,
      byCategory: {},
      bySubBrand: {},
      averageDurationDays: null,
      averageBasePriceMinor: null,
      averageDefaultMarkupPercent: null,
      totalUsageCount: 0,
      topDestinations: [],
      topByUsage: [],
      lastUpdatedAt: null,
    });
  });

  test('case 3: ?from=ISO + ?to=ISO threads where.createdAt = {gte, lte}', async () => {
    prisma.itineraryTemplate.findMany.mockResolvedValue([]);

    const from = '2026-01-01T00:00:00Z';
    const to = '2026-12-31T23:59:59Z';
    const res = await request(makeApp())
      .get(`/api/travel/itinerary-templates/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const call = prisma.itineraryTemplate.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.createdAt).toBeDefined();
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
    expect(call.where.createdAt.gte.toISOString()).toBe(new Date(from).toISOString());
    expect(call.where.createdAt.lte.toISOString()).toBe(new Date(to).toISOString());
  });

  test('case 4: ?from=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/stats?from=not-a-date-at-all')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.itineraryTemplate.findMany).not.toHaveBeenCalled();
  });

  test('case 5: ?to=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/stats?to=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.itineraryTemplate.findMany).not.toHaveBeenCalled();
  });

  test('case 6: non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Tenant', slug: 'generic',
    });

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.itineraryTemplate.findMany).not.toHaveBeenCalled();
  });

  test('case 7: unauthenticated → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/itinerary-templates/stats');
    expect(res.status).toBe(401);
    expect(prisma.itineraryTemplate.findMany).not.toHaveBeenCalled();
  });

  test('case 8: sub-brand allow-set EMPTY → zeroed envelope (NOT 403, per #976 fix)', async () => {
    // MANAGER role + subBrandAccess JSON with only-invalid brands → after
    // the VALID_SUB_BRANDS filter the Set is empty → route short-circuits
    // to the zeroed envelope BEFORE the findMany call.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['not-a-valid-brand']),
    });

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.activeCount).toBe(0);
    expect(res.body.inactiveCount).toBe(0);
    expect(res.body.byCategory).toEqual({});
    expect(res.body.averageDurationDays).toBeNull();
    expect(res.body.totalUsageCount).toBe(0);
    expect(res.body.topByUsage).toEqual([]);
    // No findMany call — empty-set short-circuit fires BEFORE prisma.
    expect(prisma.itineraryTemplate.findMany).not.toHaveBeenCalled();
  });

  test('case 9: sub-brand allow-set NARROW → where.subBrand = { in: [...] }', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.itineraryTemplate.findMany.mockResolvedValue([
      { id: 11, name: 'Mecca Umrah', destinationName: 'Mecca', subBrand: 'rfu', category: 'Religious', isActive: true, durationDays: 5, basePriceMinor: 80000, defaultMarkupPercent: 18, usageCount: 12, updatedAt: new Date('2026-04-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.itineraryTemplate.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.total).toBe(1);
    expect(res.body.byCategory).toEqual({ Religious: 1 });
    expect(res.body.bySubBrand).toEqual({ rfu: { count: 1 } });
    expect(res.body.totalUsageCount).toBe(12);
  });

  test('case 10: tenant isolation — token tenantId=A → where.tenantId=A', async () => {
    prisma.itineraryTemplate.findMany.mockResolvedValue([
      { id: 101, name: 'Goa Beach', destinationName: 'Goa', subBrand: 'tmc', category: 'Family', isActive: true, durationDays: 4, basePriceMinor: 30000, defaultMarkupPercent: 10, usageCount: 8, updatedAt: new Date('2026-05-01T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    const call = prisma.itineraryTemplate.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(res.body.total).toBe(1);
    expect(res.body.averageDurationDays).toBe(4);
    expect(res.body.averageBasePriceMinor).toBe(30000);
    expect(res.body.averageDefaultMarkupPercent).toBe(10);
  });

  test('case 11: totalUsageCount sums usageCount across all rows', async () => {
    prisma.itineraryTemplate.findMany.mockResolvedValue([
      { id: 50, name: 'A', destinationName: 'X', subBrand: 'tmc', category: 'Adventure', isActive: true, durationDays: 3, basePriceMinor: 10000, defaultMarkupPercent: 10, usageCount: 100, updatedAt: new Date('2026-04-01T00:00:00Z') },
      { id: 51, name: 'B', destinationName: 'X', subBrand: 'tmc', category: 'Adventure', isActive: true, durationDays: 4, basePriceMinor: 20000, defaultMarkupPercent: 15, usageCount: 50,  updatedAt: new Date('2026-04-02T00:00:00Z') },
      { id: 52, name: 'C', destinationName: 'Y', subBrand: 'tmc', category: 'Family',    isActive: true, durationDays: 5, basePriceMinor: 30000, defaultMarkupPercent: 20, usageCount: 0,   updatedAt: new Date('2026-04-03T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    // totalUsageCount = 100 + 50 + 0 = 150
    expect(res.body.totalUsageCount).toBe(150);
  });

  test('case 12: topByUsage sorted desc + capped at 5', async () => {
    // 7 templates with varying usageCount → top 5 by usage sorted desc, last 2 dropped.
    const spec = [
      ['Tokyo Highlights', 100],
      ['Paris Romance',     80],
      ['London Classic',    60],
      ['Rome Ancient',      40],
      ['Bali Beach',        30],
      ['NYC Skyline',       10],
      ['Cairo Pyramids',     5],
    ];
    const rows = spec.map(([name, usage], idx) => ({
      id: idx + 1,
      name,
      destinationName: name.split(' ')[0],
      subBrand: null,
      category: 'Adventure',
      isActive: true,
      durationDays: 5,
      basePriceMinor: 50000,
      defaultMarkupPercent: 15,
      usageCount: usage,
      updatedAt: new Date('2026-04-01T00:00:00Z'),
    }));
    prisma.itineraryTemplate.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(7);
    expect(res.body.totalUsageCount).toBe(325); // 100+80+60+40+30+10+5
    // Cap at 5.
    expect(res.body.topByUsage).toHaveLength(5);
    // Sorted desc — Tokyo first with usageCount=100, then Paris 80, London 60, Rome 40, Bali 30.
    expect(res.body.topByUsage[0]).toEqual({ id: 1, name: 'Tokyo Highlights', usageCount: 100 });
    expect(res.body.topByUsage[1]).toEqual({ id: 2, name: 'Paris Romance', usageCount: 80 });
    expect(res.body.topByUsage[2]).toEqual({ id: 3, name: 'London Classic', usageCount: 60 });
    expect(res.body.topByUsage[3]).toEqual({ id: 4, name: 'Rome Ancient', usageCount: 40 });
    expect(res.body.topByUsage[4]).toEqual({ id: 5, name: 'Bali Beach', usageCount: 30 });
    // Counts must be monotonically non-increasing across the slice.
    for (let i = 1; i < res.body.topByUsage.length; i++) {
      expect(res.body.topByUsage[i].usageCount)
        .toBeLessThanOrEqual(res.body.topByUsage[i - 1].usageCount);
    }
    // bySubBrand: all null → "_tenant" key.
    expect(res.body.bySubBrand).toEqual({ _tenant: { count: 7 } });
  });

  test('case 13: rows with null category roll into "_uncategorized" bucket', async () => {
    prisma.itineraryTemplate.findMany.mockResolvedValue([
      { id: 200, name: 'No-Cat A', destinationName: 'X', subBrand: 'tmc', category: null, isActive: true,  durationDays: 3, basePriceMinor: 10000, defaultMarkupPercent: 10, usageCount: 5, updatedAt: new Date('2026-04-01T00:00:00Z') },
      { id: 201, name: 'No-Cat B', destinationName: 'Y', subBrand: 'tmc', category: null, isActive: false, durationDays: 4, basePriceMinor: 20000, defaultMarkupPercent: 12, usageCount: 3, updatedAt: new Date('2026-04-02T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byCategory).toEqual({ _uncategorized: 2 });
    expect(res.body.activeCount).toBe(1);
    expect(res.body.inactiveCount).toBe(1);
    expect(res.body.totalUsageCount).toBe(8);
  });
});
