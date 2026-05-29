// @ts-check
/**
 * PRD_TRAVEL_RFU §3 — GET /api/travel/rfu-profiles/stats
 * tenant-wide RFU pilgrim profile rollup.
 *
 * Mirrors #903 slice 23 /suppliers/stats + #905 slice 18
 * /commission-profiles/stats. USER-readable anodyne aggregate that powers
 * the RFU pilgrim library page header summary strip. Pins the contract
 * for the new route handler added at backend/routes/travel_rfu_profiles.js
 * (placed BEFORE the /:id family so the literal-path /stats wins over the
 * :id matcher).
 *
 * What's pinned
 * -------------
 *   - Empty tenant:        zeroed envelope with pre-seeded tier buckets
 *                          (entry/primary/premium each at count:0),
 *                          empty byTravelStyle map, lastUpdatedAt=null.
 *   - Happy path:          4 profiles across 3 tiers + mixed travelStyle
 *                          + mixed passport state → counts correct
 *                          (byProductTier, byTravelStyle, withPassport,
 *                          expiringPassports, lastUpdatedAt).
 *   - Travel-style bucket: defensive — null/empty travelStyle lands in
 *                          the `_unset` bucket, not lost.
 *   - Cross-tenant:        WHERE clause carries tenantId, defensive
 *                          (requireTravelTenant + tenantId clause both
 *                          enforce isolation).
 *   - RFU sub-brand gate:  MANAGER with subBrandAccess=['tmc'] (no rfu) →
 *                          403 SUB_BRAND_DENIED (mirrors list endpoint).
 *   - USER-readable:       USER role returns 200 (anodyne aggregate).
 *   - Auth gate:           no token → 401.
 *   - ?from/?to ISO bounds: forwarded to WHERE.createdAt; invalid ISO → 400.
 *   - Defensive math:      unknown productTier → skipped (doesn't pollute
 *                          the pre-seeded {entry, primary, premium} shape).
 *                          0 rows → lastUpdatedAt:null.
 *
 * Test pattern mirrors backend/test/routes/travel-supplier-stats.test.js
 * (slice 23) — patch the prisma singleton with vi.fn() shapes BEFORE
 * requiring the router, then drive supertest with HS256 JWTs signed
 * against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.rfuLeadProfile = prisma.rfuLeadProfile || {};
prisma.rfuLeadProfile.findMany = vi.fn();
prisma.rfuLeadProfile.count = vi.fn();
prisma.rfuLeadProfile.findFirst = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  role: 'ADMIN',
  subBrandAccess: null,
});
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
const rfuProfilesRouter = requireCJS('../../routes/travel_rfu_profiles');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', rfuProfilesRouter);
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
  prisma.rfuLeadProfile.findMany.mockReset();
  prisma.rfuLeadProfile.count.mockReset();
  prisma.rfuLeadProfile.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1,
    vertical: 'travel',
    name: 'Test Travel',
    slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/rfu-profiles/stats', () => {
  test('empty tenant → zeroed envelope with pre-seeded tier buckets', async () => {
    prisma.rfuLeadProfile.findMany.mockResolvedValue([]);
    prisma.rfuLeadProfile.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/rfu-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byProductTier: {
        entry: { count: 0 },
        primary: { count: 0 },
        premium: { count: 0 },
      },
      byTravelStyle: {},
      withPassport: 0,
      expiringPassports: 0,
      lastUpdatedAt: null,
      aggregateExceedsCap: false,
    });
  });

  test('happy path: 4 profiles across 3 tiers + mixed travelStyle + mixed passport → counts correct', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    // Expiry threshold is now + 6 months. Pick one that's clearly in the
    // window (2 weeks out) and one clearly outside (3 years out).
    const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const farFuture = new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000);

    prisma.rfuLeadProfile.findMany.mockResolvedValue([
      {
        id: 1,
        productTier: 'premium',
        travelStyle: 'luxury',
        passportNumber: 'A1234567',
        passportExpiry: soon, // counts toward expiringPassports
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2,
        productTier: 'primary',
        travelStyle: 'comfort',
        passportNumber: 'B2345678',
        passportExpiry: farFuture, // does NOT count
        updatedAt: newest, // newest updatedAt — should drive lastUpdatedAt
      },
      {
        id: 3,
        productTier: 'primary',
        travelStyle: 'comfort',
        passportNumber: null, // no passport on file
        passportExpiry: null,
        updatedAt: new Date('2026-05-15T10:00:00Z'),
      },
      {
        id: 4,
        productTier: 'entry',
        travelStyle: 'budget',
        passportNumber: 'D4567890',
        passportExpiry: soon, // counts toward expiringPassports
        updatedAt: new Date('2026-05-12T10:00:00Z'),
      },
    ]);
    prisma.rfuLeadProfile.count.mockResolvedValue(4);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/rfu-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.byProductTier).toEqual({
      entry: { count: 1 },
      primary: { count: 2 },
      premium: { count: 1 },
    });
    expect(res.body.byTravelStyle).toEqual({
      luxury: { count: 1 },
      comfort: { count: 2 },
      budget: { count: 1 },
    });
    expect(res.body.withPassport).toBe(3); // ids 1, 2, 4
    expect(res.body.expiringPassports).toBe(2); // ids 1, 4
    expect(res.body.lastUpdatedAt).toBe(newest.toISOString());
    expect(res.body.aggregateExceedsCap).toBe(false);
  });

  test('travelStyle bucketing: null/empty travelStyle lands in `_unset` bucket (defensive)', async () => {
    prisma.rfuLeadProfile.findMany.mockResolvedValue([
      {
        id: 1,
        productTier: 'entry',
        travelStyle: null,
        passportNumber: null,
        passportExpiry: null,
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2,
        productTier: 'entry',
        travelStyle: '',
        passportNumber: null,
        passportExpiry: null,
        updatedAt: new Date('2026-05-11T10:00:00Z'),
      },
      {
        id: 3,
        productTier: 'primary',
        travelStyle: 'luxury',
        passportNumber: null,
        passportExpiry: null,
        updatedAt: new Date('2026-05-12T10:00:00Z'),
      },
    ]);
    prisma.rfuLeadProfile.count.mockResolvedValue(3);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/rfu-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byTravelStyle).toEqual({
      _unset: { count: 2 },
      luxury: { count: 1 },
    });
  });

  test('cross-tenant: tenantId clause prevents leak from another tenant', async () => {
    prisma.rfuLeadProfile.findMany.mockResolvedValue([
      {
        id: 1,
        productTier: 'entry',
        travelStyle: 'budget',
        passportNumber: null,
        passportExpiry: null,
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
    ]);
    prisma.rfuLeadProfile.count.mockResolvedValue(1);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/rfu-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.rfuLeadProfile.findMany.mock.calls[0][0].where;
    expect(whereArg.tenantId).toBe(1);
    const countWhere = prisma.rfuLeadProfile.count.mock.calls[0][0].where;
    expect(countWhere.tenantId).toBe(1);
  });

  test('RFU sub-brand gate: MANAGER with subBrandAccess=["tmc"] → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/rfu-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
    // Prisma should NEVER be hit — the gate denies before query.
    expect(prisma.rfuLeadProfile.findMany).not.toHaveBeenCalled();
  });

  test('USER role → 200 (anodyne aggregate; same contract as sibling /stats endpoints)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: null,
    });
    prisma.rfuLeadProfile.findMany.mockResolvedValue([]);
    prisma.rfuLeadProfile.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/rfu-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test('auth gate: missing token → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/travel/rfu-profiles/stats');
    expect(res.status).toBe(401);
  });

  test('?from/?to ISO bounds forwarded to WHERE.createdAt; invalid ISO → 400', async () => {
    prisma.rfuLeadProfile.findMany.mockResolvedValue([]);
    prisma.rfuLeadProfile.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/rfu-profiles/stats?from=2026-01-01&to=2026-03-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.rfuLeadProfile.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.gte).toBeInstanceOf(Date);
    expect(whereArg.createdAt.lte).toBeInstanceOf(Date);
    expect(whereArg.createdAt.gte.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(whereArg.createdAt.lte.toISOString().slice(0, 10)).toBe('2026-03-31');

    // Invalid ISO → 400
    const bad = await request(app)
      .get('/api/travel/rfu-profiles/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_DATE');
  });

  test('defensive: unknown productTier → skipped (does not pollute the pre-seeded shape); 0 rows → lastUpdatedAt:null', async () => {
    prisma.rfuLeadProfile.findMany.mockResolvedValue([
      {
        id: 1,
        productTier: 'gold-vip', // bogus tier — should NOT show up in byProductTier
        travelStyle: 'luxury',
        passportNumber: null,
        passportExpiry: null,
        updatedAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2,
        productTier: null, // null tier — also skipped
        travelStyle: null,
        passportNumber: null,
        passportExpiry: null,
        updatedAt: new Date('2026-05-11T10:00:00Z'),
      },
    ]);
    prisma.rfuLeadProfile.count.mockResolvedValue(2);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/rfu-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.byProductTier).toEqual({
      entry: { count: 0 },
      primary: { count: 0 },
      premium: { count: 0 },
    });

    // Separately confirm 0-row case for lastUpdatedAt: null
    prisma.rfuLeadProfile.findMany.mockResolvedValue([]);
    prisma.rfuLeadProfile.count.mockResolvedValue(0);
    const empty = await request(app)
      .get('/api/travel/rfu-profiles/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(empty.status).toBe(200);
    expect(empty.body.lastUpdatedAt).toBe(null);
  });
});
