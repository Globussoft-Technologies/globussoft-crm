// @ts-check
/**
 * PRD_TRAVEL_B2B_AGENT_PORTAL #905 slice 17 — annual commission summary contract.
 *
 * Pins GET /api/travel/commission-profiles/:id/summary/by-year which
 * aggregates the same Deal × Contact join the slice 9 ledger emits, one row
 * per UTC YYYY bucket present in the deal set. Each row reports
 * dealCount + totalSale + totalCommission. This is the data shape the
 * operator-facing "year-over-year commission trend" view consumes
 * (PRD §3 — annualised trend for multi-year operator KPI dashboards).
 * Coarser-bucket sibling to slice 15 (by-month) + slice 16 (by-quarter);
 * all three reads stay disjoint so each can evolve independently. Read-only;
 * reuses lib/agentCommissionCalculator.
 *
 * What's pinned
 * -------------
 *   - GET /api/travel/commission-profiles/:id/summary/by-year
 *       happy path: 3 deals across 2 calendar years → 2 rows summed
 *         per-year, grandTotalCommission = sum
 *       default sort year:asc (chronological — lexicographic on YYYY)
 *       ?orderBy=totalCommission:desc honored
 *       ?from=YYYY filter restricts buckets
 *       ?to=YYYY filter restricts buckets
 *       invalid ?from format (not YYYY, e.g. "26") → 400 INVALID_YEAR_FORMAT
 *       invalid ?from format (e.g. "20261") → 400 INVALID_YEAR_FORMAT
 *       cross-tenant profile id → 404 PROFILE_NOT_FOUND
 *       MANAGER restricted to ["rfu"] reading a "tmc"-scoped profile → 403 SUB_BRAND_DENIED
 *       malformed stored profileJson → 200 with per-row totalCommission=0,
 *         dealCount + totalSale still accurate (defensive parseError branch)
 *
 * Test pattern mirrors travel-commission-profiles-by-quarter.test.js — patch
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
  createdAt: new Date('2026-01-15T10:00:00Z'),
  updatedAt: new Date('2026-01-15T10:00:00Z'),
};

// 3 deals across 2 calendar years — used by the happy-path tests.
// 2026: 2 deals → sale 100000 + 50000 = 150000; commission 7500
// 2027: 1 deal  → sale 200000          = 200000; commission 10000
// Grand total commission = 7500 + 10000 = 17500.
const dealsHappy = [
  {
    id: 1, title: 'Bali 7N', stage: 'won', amount: 100000, currency: 'INR',
    createdAt: new Date('2026-02-05T08:00:00Z'),
    contact: { id: 501, name: 'Vinay' },
  },
  {
    id: 2, title: 'Goa 3N', stage: 'won', amount: 50000, currency: 'INR',
    createdAt: new Date('2026-08-22T08:00:00Z'),
    contact: { id: 501, name: 'Vinay' },
  },
  {
    id: 3, title: 'Munnar 4N', stage: 'won', amount: 200000, currency: 'INR',
    createdAt: new Date('2027-05-15T08:00:00Z'),
    contact: { id: 502, name: 'Priya' },
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

describe('GET /api/travel/commission-profiles/:id/summary/by-year (slice 17)', () => {
  test('happy path 3 deals × 2 years → 2 rows summed correctly, default sort year:asc', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profileId: 21,
      profileName: 'Standard 5%',
      profileType: 'flat_percent',
      totalYears: 2,
      grandTotalCommission: 17500, // 7500 + 10000
      limit: 10,
      offset: 0,
    });

    // Default sort is year:asc → 2026 before 2027.
    expect(res.body.years).toHaveLength(2);
    expect(res.body.years[0]).toMatchObject({
      year: '2026',
      dealCount: 2,
      totalSale: 150000,
      totalCommission: 7500,
    });
    expect(res.body.years[1]).toMatchObject({
      year: '2027',
      dealCount: 1,
      totalSale: 200000,
      totalCommission: 10000,
    });
  });

  test('?orderBy=totalCommission:desc reorders the years by commission earned', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-year?orderBy=totalCommission:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 2027 has 10000 commission, 2026 has 7500 → desc puts 2027 first.
    expect(res.body.years.map((y) => y.year)).toEqual(['2027', '2026']);
  });

  test('?from=2026&to=2026 restricts to 1 bucket', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-year?from=2026&to=2026')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.grandTotalCommission).toBe(7500);
  });

  test('invalid ?from format (two-digit "26") → 400 INVALID_YEAR_FORMAT', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-year?from=26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('invalid ?from format (five-digit "20261") → 400 INVALID_YEAR_FORMAT', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-year?from=20261')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('invalid ?to format ("2026-Q1") → 400 INVALID_YEAR_FORMAT', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(flatProfile);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-year?to=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('cross-tenant profile id → 404 PROFILE_NOT_FOUND', async () => {
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/9999/summary/by-year')
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
      .get('/api/travel/commission-profiles/21/summary/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('malformed stored profileJson → 200, per-row totalCommission=0, dealCount + totalSale accurate', async () => {
    const badProfile = { ...flatProfile, profileJson: 'not json {{{' };
    prisma.travelCommissionProfile.findFirst.mockResolvedValue(badProfile);
    prisma.deal.findMany.mockResolvedValue(dealsHappy);

    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/21/summary/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandTotalCommission).toBe(0);
    const y2026 = res.body.years.find((y) => y.year === '2026');
    expect(y2026.dealCount).toBe(2);
    expect(y2026.totalSale).toBe(150000);
    expect(y2026.totalCommission).toBe(0);
    const y2027 = res.body.years.find((y) => y.year === '2027');
    expect(y2027.dealCount).toBe(1);
    expect(y2027.totalSale).toBe(200000);
    expect(y2027.totalCommission).toBe(0);
  });

  test('invalid :id segment (non-numeric) → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/commission-profiles/abc/summary/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });
});
