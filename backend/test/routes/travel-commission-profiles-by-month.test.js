// @ts-check
/**
 * PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 15 — monthly commission summary contract.
 *
 * Pins GET /api/travel/commission-profiles/:id/summary/by-month which
 * aggregates the same Deal × Contact join the slice 9 ledger emits, one row
 * per UTC YYYY-MM bucket present in the deal set. Each row reports
 * dealCount + totalSale + totalCommission. This is the data shape the
 * operator-facing "commission trend" chart consumes (PRD §3 FR-3.6.3 —
 * per-FY summary with month-over-month trend) and the month-input the
 * eventual b2bCommissionEngine cron (FR-3.2.4, Phase 1-3) reads when
 * generating per-month PDF statements. Read-only; reuses
 * lib/agentCommissionCalculator.
 *
 * What's pinned
 * -------------
 *   - GET /api/travel/commission-profiles/:id/summary/by-month
 *       happy path: 6 deals across 3 months → 3 rows, dealCount + totalSale
 *         + totalCommission summed per-month, grandTotalCommission = sum
 *       default sort month:asc (chronological)
 *       ?orderBy=totalCommission:desc honored
 *       ?orderBy=month:desc honored
 *       unknown orderBy token degrades silently to default (no 400)
 *       ?from=YYYY-MM filter excludes earlier buckets
 *       ?to=YYYY-MM filter excludes later buckets
 *       ?from + ?to together narrow the window
 *       invalid ?from format (not YYYY-MM) → 400 INVALID_MONTH_FORMAT
 *       invalid ?to format (not YYYY-MM) → 400 INVALID_MONTH_FORMAT
 *       empty result (no deals carry this profile) → 200 with months=[]
 *       ?stage=won filter narrows the where
 *       ?limit/?offset applied AFTER aggregation (slice the months array)
 *       cross-tenant profile id → 404 PROFILE_NOT_FOUND
 *       MANAGER restricted to ["rfu"] reading a "tmc"-scoped profile → 403 SUB_BRAND_DENIED
 *       malformed stored profileJson → 200 with per-row totalCommission=0,
 *         dealCount + totalSale still accurate
 *       invalid :id segment (non-numeric) → 400 INVALID_ID
 *       half-up rounding: per-row totalSale + totalCommission rounded to 2dp;
 *         grandTotalCommission also rounded
 *       UTC month boundary: deal at 2026-05-31T23:30:00Z stays in 2026-05
 *         (UTC bucketing, not local-timezone)
 *
 * Test pattern mirrors travel-commission-profiles-summary.test.js — patch
 * prisma singleton with vi.fn() shapes BEFORE requiring the router, drive
 * supertest with HS256 JWTs. No RBAC narrowing (read-only endpoint).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelCommissionProfile = prisma.travelCommissionProfile || {};
prisma.travelCommissionProfile.findFirst = vi.fn();
prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();
prisma.deal.count = vi.fn();
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

// Canonical "Standard 5%" flat-percent profile under TMC sub-brand. Sale of
// X yields commission of X*0.05.
const flatProfile = {
  id: 21,
  tenantId: 1,
  name: 'Standard 5%',
  profileType: 'flat_percent',
  profileJson: JSON.stringify({ type: 'flat_percent', percent: 5 }),
  subBrand: 'tmc',
  isActive: true,
  notes: null,
  createdAt: new Date('2026-04-15T10:00:00Z'),
  updatedAt: new Date('2026-04-15T10:00:00Z'),
};

// 6 deals across 3 UTC months — used by the happy-path tests.
// 2026-03: 2 deals  → sale 100000 + 50000 = 150000; commission 7500
// 2026-04: 1 deal   → sale 200000          = 200000; commission 10000
// 2026-05: 3 deals  → sale 80000 + 150000 + 60000 = 290000; commission 14500
// Grand total commission = 7500 + 10000 + 14500 = 32000.
const dealsHappy = [
  {
    id: 1, title: 'Bali 7N', stage: 'won', amount: 100000, currency: 'INR',
    createdAt: new Date('2026-03-05T08:00:00Z'),
    contact: { id: 501, name: 'Vinay' },
  },
  {
    id: 2, title: 'Goa 3N', stage: 'won', amount: 50000, currency: 'INR',
    createdAt: new Date('2026-03-22T08:00:00Z'),
    contact: { id: 501, name: 'Vinay' },
  },
  {
    id: 3, title: 'Munnar 4N', stage: 'won', amount: 200000, currency: 'INR',
    createdAt: new Date('2026-04-15T08:00:00Z'),
    contact: { id: 502, name: 'Priya' },
  },
  {
    id: 4, title: 'Andamans 5N', stage: 'won', amount: 80000, currency: 'INR',
    createdAt: new Date('2026-05-02T08:00:00Z'),
    contact: { id: 502, name: 'Priya' },
  },
  {
    id: 5, title: 'Ladakh 6N', stage: 'won', amount: 150000, currency: 'INR',
    createdAt: new Date('2026-05-12T08:00:00Z'),
    contact: { id: 501, name: 'Vinay' },
  },
  {
    id: 6, title: 'Sikkim 4N', stage: 'won', amount: 60000, currency: 'INR',
    createdAt: new Date('2026-05-20T08:00:00Z'),
    contact: { id: 501, name: 'Vinay' },
  },
];

beforeEach(() => {
  prisma.travelCommissionProfile.findFirst.mockReset();
  prisma.deal.findMany.mockReset();
  prisma.deal.count.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/commission-profiles/:id/summary/by-month (slice 15)', () => {
  test('happy path 6 deals × 3 months → 3 rows summed correctly, default sort month:asc', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profileId: 21,
      profileName: 'Standard 5%',
      profileType: 'flat_percent',
      totalMonths: 3,
      grandTotalCommission: 32000, // 7500 + 10000 + 14500
      limit: 36,
      offset: 0,
    });

    // Default sort is month:asc → March before April before May.
    expect(res.body.months).toHaveLength(3);
    expect(res.body.months[0]).toMatchObject({
      month: '2026-03',
      dealCount: 2,
      totalSale: 150000,
      totalCommission: 7500,
    });
    expect(res.body.months[1]).toMatchObject({
      month: '2026-04',
      dealCount: 1,
      totalSale: 200000,
      totalCommission: 10000,
    });
    expect(res.body.months[2]).toMatchObject({
      month: '2026-05',
      dealCount: 3,
      totalSale: 290000,
      totalCommission: 14500,
    });
  });

  test('?orderBy=totalCommission:desc reorders the months by commission earned', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month?orderBy=totalCommission:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-05', '2026-04', '2026-03']);
  });

  test('?orderBy=month:desc reverses the chronological order', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month?orderBy=month:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-05', '2026-04', '2026-03']);
  });

  test('unknown orderBy token degrades silently to default (no 400)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month?orderBy=garbage:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Falls back to month:asc.
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-03', '2026-04', '2026-05']);
  });

  test('?from=YYYY-MM excludes earlier buckets', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month?from=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-04', '2026-05']);
    expect(res.body.grandTotalCommission).toBe(24500); // 10000 + 14500
  });

  test('?to=YYYY-MM excludes later buckets', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month?to=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-03', '2026-04']);
    expect(res.body.grandTotalCommission).toBe(17500); // 7500 + 10000
  });

  test('?from + ?to together narrow the window to one month', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month?from=2026-04&to=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0]).toMatchObject({
      month: '2026-04',
      dealCount: 1,
      totalSale: 200000,
      totalCommission: 10000,
    });
  });

  test('invalid ?from format (not YYYY-MM) → 400 INVALID_MONTH_FORMAT', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month?from=2026/04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('invalid ?to format (e.g. "2026-13") → 400 INVALID_MONTH_FORMAT', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month?to=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('empty deal set → 200 with months=[] and grandTotalCommission=0', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toEqual([]);
    expect(res.body.totalMonths).toBe(0);
    expect(res.body.grandTotalCommission).toBe(0);
  });

  test('?stage=won filter is passed into the prisma where', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month?stage=won')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const findManyCall = prisma.deal.findMany.mock.calls[0][0];
    expect(findManyCall.where.stage).toBe('won');
    expect(findManyCall.where.tenantId).toBe(1);
    expect(findManyCall.where.deletedAt).toBe(null);
    expect(findManyCall.where.contact.commissionProfileId).toBe(21);
  });

  test('?limit and ?offset apply AFTER aggregation (slice the months array)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Default sort month:asc → window is March / April / May, so offset=1
    // limit=1 → April only.
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].month).toBe('2026-04');
    // totalMonths reflects pre-pagination count.
    expect(res.body.totalMonths).toBe(3);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('cross-tenant profile id → 404 PROFILE_NOT_FOUND', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/9999/summary/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROFILE_NOT_FOUND');
  });

  test('MANAGER restricted to ["rfu"] reading a "tmc"-scoped profile → 403 SUB_BRAND_DENIED', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('malformed stored profileJson → 200, per-row totalCommission=0, dealCount + totalSale accurate', async () => {
    const badProfile = { ...flatProfile, profileJson: 'not json {{{' };
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(badProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(3);
    expect(res.body.grandTotalCommission).toBe(0);
    // dealCount + totalSale per row stay accurate even with malformed JSON.
    const may = res.body.months.find((m) => m.month === '2026-05');
    expect(may.dealCount).toBe(3);
    expect(may.totalSale).toBe(290000);
    expect(may.totalCommission).toBe(0);
  });

  test('invalid :id segment (non-numeric) → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/abc/summary/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('UTC month boundary: deal at 2026-05-31T23:30:00Z stays in 2026-05 bucket (not 2026-06)', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    // Single deal at end-of-month UTC. The route's UTC bucketing means even
    // a caller running in a positive-offset timezone (where the local clock
    // would say 2026-06-01 already) sees this as 2026-05.
    prisma.deal.findMany.mockResolvedValue([
      {
        id: 99, title: 'EOM Deal', stage: 'won', amount: 100000, currency: 'INR',
        createdAt: new Date('2026-05-31T23:30:00Z'),
        contact: { id: 501, name: 'Vinay' },
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].month).toBe('2026-05');
  });
});
