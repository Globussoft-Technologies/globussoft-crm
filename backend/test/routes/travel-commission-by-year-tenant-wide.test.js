// @ts-check
/**
 * PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 21 — tenant-wide commission
 * annual rollup.
 *
 * Pins GET /api/travel/commission-profiles/by-year which aggregates
 * commission across ALL TravelCommissionProfile rows visible to the
 * caller (sub-brand-narrowed for MANAGER) and buckets the underlying
 * Deal × Contact join by Deal.createdAt's UTC year via getUTCFullYear().
 *
 * Annual sibling of slice 19 (/by-month tenant-wide) + slice 20
 * (/by-quarter tenant-wide). Completes the by-month / by-quarter /
 * by-year tenant-wide triplet at the coarsest bucket grain. NOT the same
 * as /:id/summary/by-year (slice 17) which is per-profile. Both endpoints
 * coexist: per-profile drills into one chosen profile; this endpoint feeds
 * the cross-profile annual ("YoY") trend tile on the library page.
 *
 * What's pinned
 * -------------
 *   - GET /api/travel/commission-profiles/by-year
 *       1. INVALID_YEAR_FORMAT for from=26 (not 4 digits)
 *       2. happy path: 2 profiles × 4 deals across 2 years → rollup
 *          (UTC YYYY bucketing, sum-up across profiles)
 *       3. orderBy=totalCommission:desc sorts years by commission DESC
 *       4. from/to single-year window filters out other years
 *       5. malformed profileJson on one of two profiles → that profile
 *          contributes 0 commission; the other still aggregates correctly
 *       6. MANAGER subBrandAccess=['rfu'] → only rfu (and tenant-wide)
 *          profiles + their deals appear in the rollup
 *       7. pagination via limit + offset (totalYears reflects full
 *          filtered population, not page window)
 *       8. no token → 401
 *
 * Test pattern mirrors travel-commission-by-quarter-tenant-wide.test.js —
 * patch prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * drive supertest with HS256 JWTs.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelCommissionProfile = prisma.travelCommissionProfile || {};
prisma.travelCommissionProfile.findMany = vi.fn();
prisma.travelCommissionProfile.count = vi.fn();
prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();
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
const profilesRouter = requireCJS('../../routes/travel_commission_profiles');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', profilesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// --- Fixture profiles -------------------------------------------------------
// Profile 31 — flat 5% on TMC sub-brand.
const profileFlatTmc = {
  id: 31,
  tenantId: 1,
  name: 'Standard 5% TMC',
  profileType: 'flat_percent',
  profileJson: JSON.stringify({ type: 'flat_percent', percent: 5 }),
  subBrand: 'tmc',
  isActive: true,
  notes: null,
  createdAt: new Date('2025-01-15T10:00:00Z'),
  updatedAt: new Date('2025-02-10T10:00:00Z'),
};
// Profile 32 — tiered <=100k @ 4%, >100k @ 6% on RFU sub-brand.
const profileTieredRfu = {
  id: 32,
  tenantId: 1,
  name: 'Tiered RFU',
  profileType: 'tiered',
  profileJson: JSON.stringify({
    type: 'tiered',
    tiers: [
      { uptoCents: 100000, percent: 4 },
      { uptoCents: null,   percent: 6 },
    ],
  }),
  subBrand: 'rfu',
  isActive: true,
  notes: null,
  createdAt: new Date('2025-01-20T10:00:00Z'),
  updatedAt: new Date('2025-03-05T10:00:00Z'),
};

// --- Fixture deals (attached via Contact.commissionProfileId) ---------------
// 2025 (UTC year 2025):
//   - Deal 101 → profile 31 (flat 5%): 100000 → commission 5000 (Mar 5 2025)
//   - Deal 102 → profile 31: 50000 → commission 2500 (Jun 12 2025)
//   - Deal 103 → profile 32 (tiered): 80000 → 80000*0.04 = 3200 (Sep 20 2025)
// 2026 (UTC year 2026):
//   - Deal 104 → profile 32 (tiered): 200000 → 100000*0.04 + 100000*0.06 = 10000 (Apr 10 2026)
//
// Per-year expected:
//   2025: profileCount=2, dealCount=3, totalSale=230000, totalCommission=10700
//   2026: profileCount=1, dealCount=1, totalSale=200000, totalCommission=10000
const dealsHappy = [
  {
    id: 101,
    amount: 100000,
    createdAt: new Date('2025-03-05T10:00:00Z'),
    contact: { commissionProfileId: 31 },
  },
  {
    id: 102,
    amount: 50000,
    createdAt: new Date('2025-06-12T10:00:00Z'),
    contact: { commissionProfileId: 31 },
  },
  {
    id: 103,
    amount: 80000,
    createdAt: new Date('2025-09-20T10:00:00Z'),
    contact: { commissionProfileId: 32 },
  },
  {
    id: 104,
    amount: 200000,
    createdAt: new Date('2026-04-10T10:00:00Z'),
    contact: { commissionProfileId: 32 },
  },
];

beforeEach(() => {
  prisma.travelCommissionProfile.findMany.mockReset();
  prisma.travelCommissionProfile.count.mockReset();
  prisma.deal.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/commission-profiles/by-year (slice 21)', () => {
  test('INVALID_YEAR_FORMAT for from=26 (not 4 digits)', async () => {
    prisma.travelCommissionProfile.findMany.mockResolvedValue([]);
    prisma.travelCommissionProfile.count.mockResolvedValue(0);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/by-year?from=26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('happy path: 2 profiles × 4 deals → correct per-year rollup', async () => {
    prisma.travelCommissionProfile.findMany.mockResolvedValue([
      profileFlatTmc, profileTieredRfu,
    ]);
    prisma.travelCommissionProfile.count.mockResolvedValue(2);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.years).toHaveLength(2);

    // Default sort is year:asc, so 2025 comes first.
    const y1 = res.body.years[0];
    expect(y1.year).toBe('2025');
    expect(y1.profileCount).toBe(2);
    expect(y1.dealCount).toBe(3);
    expect(y1.totalSale).toBe(230000);
    expect(y1.totalCommission).toBe(10700);

    const y2 = res.body.years[1];
    expect(y2.year).toBe('2026');
    expect(y2.profileCount).toBe(1);
    expect(y2.dealCount).toBe(1);
    expect(y2.totalSale).toBe(200000);
    expect(y2.totalCommission).toBe(10000);

    // Grand totals: distinct profiles across all years = 2.
    expect(res.body.grandProfileCount).toBe(2);
    expect(res.body.grandDealCount).toBe(4);
    expect(res.body.grandTotalSale).toBe(430000);
    expect(res.body.grandTotalCommission).toBe(20700);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
    expect(res.body.aggregateExceedsCap).toBe(false);
  });

  test('orderBy=totalCommission:desc sorts years by commission DESC', async () => {
    prisma.travelCommissionProfile.findMany.mockResolvedValue([
      profileFlatTmc, profileTieredRfu,
    ]);
    prisma.travelCommissionProfile.count.mockResolvedValue(2);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/by-year?orderBy=totalCommission:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 2025 has 10700, 2026 has 10000 → 2025 first under desc sort.
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[0].totalCommission).toBe(10700);
    expect(res.body.years[1].year).toBe('2026');
    expect(res.body.years[1].totalCommission).toBe(10000);
  });

  test('from/to single-year window: only that year appears', async () => {
    prisma.travelCommissionProfile.findMany.mockResolvedValue([
      profileFlatTmc, profileTieredRfu,
    ]);
    prisma.travelCommissionProfile.count.mockResolvedValue(2);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/by-year?from=2026&to=2026')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    // Grand totals reflect the filtered window only.
    expect(res.body.grandProfileCount).toBe(1);
    expect(res.body.grandDealCount).toBe(1);
    expect(res.body.grandTotalCommission).toBe(10000);
  });

  test('malformed profileJson on one profile → contributes 0; other still correct', async () => {
    const broken = { ...profileFlatTmc, profileJson: 'not json {{{' };
    prisma.travelCommissionProfile.findMany.mockResolvedValue([
      broken, profileTieredRfu,
    ]);
    prisma.travelCommissionProfile.count.mockResolvedValue(2);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 2025: broken profile's 2 deals (100000 + 50000) contribute 0 commission
    //       + tiered profile's 1 deal (80000) contributes 3200.
    //       totalSale still 230000 (broken profile's deals still counted),
    //       commission only 3200.
    const y1 = res.body.years.find((y) => y.year === '2025');
    expect(y1.dealCount).toBe(3);
    expect(y1.totalSale).toBe(230000);
    expect(y1.totalCommission).toBe(3200);

    // 2026: only tiered profile's deal → unchanged at 10000.
    const y2 = res.body.years.find((y) => y.year === '2026');
    expect(y2.totalCommission).toBe(10000);
  });

  test('MANAGER subBrandAccess=["rfu"] → only rfu (and tenant-wide) profiles in rollup', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    // Assert the where-clause narrows on subBrand IN ['rfu'] OR subBrand IS NULL.
    prisma.travelCommissionProfile.findMany.mockImplementation(async ({ where }) => {
      expect(where.OR).toBeDefined();
      const orClause = where.OR;
      const hasInRfu = orClause.some(
        (c) => c.subBrand && c.subBrand.in && c.subBrand.in.includes('rfu'),
      );
      const hasNull = orClause.some((c) => c.subBrand === null);
      expect(hasInRfu).toBe(true);
      expect(hasNull).toBe(true);
      // Manager sees only rfu profile (not tmc).
      return [profileTieredRfu];
    });
    prisma.travelCommissionProfile.count.mockResolvedValue(1);
    // Deals for the visible profile only (profile 32 = tiered/rfu).
    prisma.deal.findMany.mockResolvedValue([
      {
        id: 103,
        amount: 80000,
        createdAt: new Date('2025-09-20T10:00:00Z'),
        contact: { commissionProfileId: 32 },
      },
      {
        id: 104,
        amount: 200000,
        createdAt: new Date('2026-04-10T10:00:00Z'),
        contact: { commissionProfileId: 32 },
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandProfileCount).toBe(1);
    expect(res.body.grandDealCount).toBe(2);
    // 2025 3200 + 2026 10000 = 13200 across the two years.
    expect(res.body.grandTotalCommission).toBe(13200);
  });

  test('pagination: limit=1&offset=1 returns the second year only', async () => {
    prisma.travelCommissionProfile.findMany.mockResolvedValue([
      profileFlatTmc, profileTieredRfu,
    ]);
    prisma.travelCommissionProfile.count.mockResolvedValue(2);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/by-year?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // totalYears is the full filtered population, NOT the page slice.
    expect(res.body.totalYears).toBe(2);
    expect(res.body.years).toHaveLength(1);
    // Default sort year:asc → offset=1 gives the second year (2026).
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
    // Grand totals still reflect the full filtered population.
    expect(res.body.grandDealCount).toBe(4);
  });

  test('no token → 401', async () => {
    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/by-year');
    expect(res.status).toBe(401);
  });
});
