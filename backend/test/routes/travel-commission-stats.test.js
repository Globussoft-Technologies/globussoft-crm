// @ts-check
/**
 * PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 18 — tenant-wide commission profile rollup.
 *
 * Pins GET /api/travel/commission-profiles/stats which aggregates ALL
 * TravelCommissionProfile rows for the caller's tenant (sub-brand-narrowed
 * for MANAGER) into counts split by status / profileType / subBrand plus
 * a per-bucket totalCommission summed in-process via computeCommission()
 * over the Deals tied to each profile via Contact.commissionProfileId.
 *
 * This is the canonical "header summary strip" feed for the operator-facing
 * CommissionProfiles library page — one round-trip replaces the previous
 * fan-out (list + count×N profileTypes + count×N subBrands + audit poll).
 * Mirrors the /flyer-templates/global-stats pattern from #908 slice 19.
 *
 * What's pinned
 * -------------
 *   - GET /api/travel/commission-profiles/stats
 *       1. empty tenant → zeroed shape (no 500)
 *       2. happy path: 3 profiles (1 flat / 1 tiered / 1 per_pax_flat) ×
 *          5 deals → counts + totalCommission correct per profileType
 *          + per subBrand bucket
 *       3. archived rollup: 2 active + 1 isActive=false → archived=1
 *       4. null subBrand → '_tenant' bucket
 *       5. malformed profileJson on one profile → that profile's
 *          totalCommission=0 (other 2 still correct, no 500)
 *       6. MANAGER subBrandAccess=['rfu'] → only rfu (and tenant-wide)
 *          profiles visible in the rollup
 *       7. USER role → 200 (anodyne aggregate is USER-readable)
 *       8. cross-tenant: profiles from another tenant don't appear
 *       9. no token → 401
 *
 * Test pattern mirrors travel-commission-by-year.test.js — patch prisma
 * singleton with vi.fn() shapes BEFORE requiring the router, drive
 * supertest with HS256 JWTs.
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
const profileFlatTmc = {
  id: 21,
  tenantId: 1,
  name: 'Standard 5% TMC',
  profileType: 'flat_percent',
  profileJson: JSON.stringify({ type: 'flat_percent', percent: 5 }),
  subBrand: 'tmc',
  isActive: true,
  notes: null,
  createdAt: new Date('2026-01-15T10:00:00Z'),
  updatedAt: new Date('2026-02-10T10:00:00Z'),
};
const profileTieredRfu = {
  id: 22,
  tenantId: 1,
  name: 'Tiered RFU',
  profileType: 'tiered',
  // tiers use `uptoCents` per agentCommissionCalculator's contract; null/missing
  // collapses to Infinity (an open-ended top band).
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
  createdAt: new Date('2026-01-20T10:00:00Z'),
  updatedAt: new Date('2026-03-05T10:00:00Z'),
};
const profilePerPaxTenant = {
  id: 23,
  tenantId: 1,
  name: 'Per-pax flat tenant',
  profileType: 'per_pax_flat',
  profileJson: JSON.stringify({ type: 'per_pax_flat', amountPerPax: 1000 }),
  subBrand: null, // tenant-wide
  isActive: true,
  notes: null,
  createdAt: new Date('2026-02-01T10:00:00Z'),
  updatedAt: new Date('2026-03-15T10:00:00Z'),
};

// --- Fixture deals (attached via Contact.commissionProfileId) ---------------
// 2 deals → profile 21 (flat 5%): 100000 + 50000 → commission 5000 + 2500 = 7500
// 2 deals → profile 22 (tiered): 80000 + 200000 → 3200 + (4000 + 100000*0.06=6000) = wait
//                                                  tier: <=100k @4%, >100k @6%
//                                                  80000 → 80000*0.04 = 3200
//                                                  200000 → 100000*0.04 + 100000*0.06 = 4000+6000 = 10000
// 1 deal  → profile 23 (per_pax_flat amountPerPax=1000): 1 pax → commission 1000
//
// Total commission: 7500 (flat) + 13200 (tiered) + 1000 (per_pax) = 21700
const dealsHappy = [
  { id: 1, amount: 100000, contact: { commissionProfileId: 21 } },
  { id: 2, amount: 50000,  contact: { commissionProfileId: 21 } },
  { id: 3, amount: 80000,  contact: { commissionProfileId: 22 } },
  { id: 4, amount: 200000, contact: { commissionProfileId: 22 } },
  { id: 5, amount: 70000,  contact: { commissionProfileId: 23 } },
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

describe('GET /api/travel/commission-profiles/stats (slice 18)', () => {
  test('empty tenant → zeroed shape (no 500)', async () => {
    prisma.travelCommissionProfile.findMany.mockResolvedValue([]);
    prisma.travelCommissionProfile.count.mockResolvedValue(0);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      active: 0,
      archived: 0,
      byProfileType: {},
      bySubBrand: {},
      totalDealsScoped: 0,
      lastActivityAt: null,
      aggregateExceedsCap: false,
    });
  });

  test('happy path 3 profiles × 5 deals → counts + totalCommission correct per type + sub-brand', async () => {
    prisma.travelCommissionProfile.findMany.mockResolvedValue([
      profileFlatTmc, profileTieredRfu, profilePerPaxTenant,
    ]);
    prisma.travelCommissionProfile.count.mockResolvedValue(3);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.active).toBe(3);
    expect(res.body.archived).toBe(0);
    expect(res.body.totalDealsScoped).toBe(5);
    expect(res.body.aggregateExceedsCap).toBe(false);

    // byProfileType: each type appears with count + commission
    expect(res.body.byProfileType.flat_percent).toEqual({ count: 1, totalCommission: 7500 });
    expect(res.body.byProfileType.tiered).toEqual({ count: 1, totalCommission: 13200 });
    expect(res.body.byProfileType.per_pax_flat).toEqual({ count: 1, totalCommission: 1000 });

    // bySubBrand: tmc / rfu / _tenant
    expect(res.body.bySubBrand.tmc).toEqual({ count: 1, totalCommission: 7500 });
    expect(res.body.bySubBrand.rfu).toEqual({ count: 1, totalCommission: 13200 });
    expect(res.body.bySubBrand._tenant).toEqual({ count: 1, totalCommission: 1000 });

    // lastActivityAt: max(updatedAt) across the 3 profiles → 2026-03-15
    expect(res.body.lastActivityAt).toBe('2026-03-15T10:00:00.000Z');
  });

  test('archived rollup: 2 active + 1 archived → archived=1', async () => {
    const archivedProfile = { ...profilePerPaxTenant, isActive: false };
    prisma.travelCommissionProfile.findMany.mockResolvedValue([
      profileFlatTmc, profileTieredRfu, archivedProfile,
    ]);
    prisma.travelCommissionProfile.count.mockResolvedValue(3);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.active).toBe(2);
    expect(res.body.archived).toBe(1);
  });

  test('null subBrand → _tenant bucket appears with correct count', async () => {
    prisma.travelCommissionProfile.findMany.mockResolvedValue([profilePerPaxTenant]);
    prisma.travelCommissionProfile.count.mockResolvedValue(1);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.bySubBrand._tenant).toEqual({ count: 1, totalCommission: 0 });
    expect(res.body.bySubBrand.tmc).toBeUndefined();
    expect(res.body.bySubBrand.rfu).toBeUndefined();
  });

  test('malformed profileJson on one profile → that one contributes 0, others accurate', async () => {
    const broken = { ...profileFlatTmc, profileJson: 'not json {{{' };
    prisma.travelCommissionProfile.findMany.mockResolvedValue([
      broken, profileTieredRfu, profilePerPaxTenant,
    ]);
    prisma.travelCommissionProfile.count.mockResolvedValue(3);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    // Flat profile broken → 0 commission; counts still register normally
    expect(res.body.byProfileType.flat_percent).toEqual({ count: 1, totalCommission: 0 });
    expect(res.body.bySubBrand.tmc).toEqual({ count: 1, totalCommission: 0 });
    // Tiered + per_pax untouched
    expect(res.body.byProfileType.tiered.totalCommission).toBe(13200);
    expect(res.body.byProfileType.per_pax_flat.totalCommission).toBe(1000);
  });

  test('MANAGER subBrandAccess=["rfu"] → only rfu (and tenant-wide) profiles in rollup', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    // The route's where-clause narrows the findMany — assert the where shape
    // includes the OR clause for subBrand IN allowed OR null.
    prisma.travelCommissionProfile.findMany.mockImplementation(async ({ where }) => {
      expect(where.OR).toBeDefined();
      const orClause = where.OR;
      const hasInRfu = orClause.some(
        (c) => c.subBrand && c.subBrand.in && c.subBrand.in.includes('rfu'),
      );
      const hasNull = orClause.some((c) => c.subBrand === null);
      expect(hasInRfu).toBe(true);
      expect(hasNull).toBe(true);
      // Manager sees rfu + tenant-wide (NOT tmc)
      return [profileTieredRfu, profilePerPaxTenant];
    });
    prisma.travelCommissionProfile.count.mockResolvedValue(2);
    prisma.deal.findMany.mockResolvedValue([
      { id: 3, amount: 80000,  contact: { commissionProfileId: 22 } },
      { id: 4, amount: 200000, contact: { commissionProfileId: 22 } },
      { id: 5, amount: 70000,  contact: { commissionProfileId: 23 } },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.bySubBrand.rfu).toEqual({ count: 1, totalCommission: 13200 });
    expect(res.body.bySubBrand._tenant).toEqual({ count: 1, totalCommission: 1000 });
    expect(res.body.bySubBrand.tmc).toBeUndefined();
  });

  test('USER role → 200 (anodyne aggregate is USER-readable)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    prisma.travelCommissionProfile.findMany.mockResolvedValue([profileFlatTmc]);
    prisma.travelCommissionProfile.count.mockResolvedValue(1);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  test('cross-tenant: where-clause pins tenantId, no other-tenant rows returned', async () => {
    // The route should only ever pass { tenantId: req.travelTenant.id } in
    // the where-clause. We assert that via the mock contract; the mock
    // already returns scoped rows.
    prisma.travelCommissionProfile.findMany.mockImplementation(async ({ where }) => {
      expect(where.tenantId).toBe(1);
      return [profileFlatTmc];
    });
    prisma.travelCommissionProfile.count.mockImplementation(async ({ where }) => {
      expect(where.tenantId).toBe(1);
      return 1;
    });
    prisma.deal.findMany.mockImplementation(async ({ where }) => {
      expect(where.tenantId).toBe(1);
      // Defensive contact-scope clause should also be tenant-bound
      expect(where.contact.tenantId).toBe(1);
      return [];
    });

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  test('no token → 401', async () => {
    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/stats');
    expect(res.status).toBe(401);
  });
});
