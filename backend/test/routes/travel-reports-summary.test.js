// @ts-check
/**
 * Travel CRM — Reports SUMMARY one-shot snapshot contract tests
 * (PRD_TRAVEL_REPORTS §3).
 *
 * Pins backend/routes/travel_reports.js GET /api/travel/reports/summary —
 * the rolled-up dashboard payload that composes top-level summaries from
 * the 3 existing report endpoints (tmc / rfu / cross-brand) into a single
 * snapshot for the Reports landing-page header.
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing Bearer → 401; no aggregates fire.
 *   - Happy path: ADMIN with full access → all 3 sections populated
 *     with their summary shapes (counts / totals only, NOT the full
 *     per-stage drill-down or topN lists the source endpoints carry).
 *   - Cross-tenant: tenantId is forwarded into every where clause; the
 *     scope cannot be widened by query-param or body. No row leak.
 *   - Sub-brand restriction: MANAGER with subBrandAccess=['rfu'] →
 *     tmc + crossBrand are null (graceful degradation, NOT 403); rfu
 *     carries the summary.
 *   - Date forwarding: ?from + ?to ISO bounds are turned into a
 *     createdAt range filter on every sub-query (tmc trips, rfu
 *     itineraries, cross-brand deals).
 *   - Graceful degradation: one sub-section's aggregate throws →
 *     that section is null; the other two survive with their data.
 *   - generatedAt is an ISO string within 5 seconds of `now`.
 *
 * Mocking pattern mirrors travel-reports.test.js — patch the prisma
 * singleton with vi.fn() shapes BEFORE requiring the router so
 * verifyToken + requireTravelTenant + getSubBrandAccessSet stay in the
 * chain (no bypass) and the route's compose-three-summaries logic is
 * exercised end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.tmcTrip = {
  ...(prisma.tmcTrip || {}),
  groupBy: vi.fn(),
  findMany: vi.fn(),
};
prisma.tripParticipant = {
  ...(prisma.tripParticipant || {}),
  groupBy: vi.fn(),
};
prisma.itinerary = {
  ...(prisma.itinerary || {}),
  groupBy: vi.fn(),
};
prisma.deal = {
  ...(prisma.deal || {}),
  groupBy: vi.fn(),
};
prisma.travelDiagnostic = {
  ...(prisma.travelDiagnostic || {}),
  groupBy: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
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
const travelReportsRouter = requireCJS('../../routes/travel_reports');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelReportsRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function installDefaults() {
  prisma.tmcTrip.groupBy.mockResolvedValue([]);
  prisma.tmcTrip.findMany.mockResolvedValue([]);
  prisma.tripParticipant.groupBy.mockResolvedValue([]);
  prisma.itinerary.groupBy.mockResolvedValue([]);
  prisma.deal.groupBy.mockResolvedValue([]);
  prisma.travelDiagnostic.groupBy.mockResolvedValue([]);
}

beforeEach(() => {
  prisma.tmcTrip.groupBy.mockReset();
  prisma.tmcTrip.findMany.mockReset();
  prisma.tripParticipant.groupBy.mockReset();
  prisma.itinerary.groupBy.mockReset();
  prisma.deal.groupBy.mockReset();
  prisma.travelDiagnostic.groupBy.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
  installDefaults();
});

// ─── Auth gate ─────────────────────────────────────────────────────

describe('GET /api/travel/reports/summary — auth gate', () => {
  test('without Bearer returns 401; no aggregates fire', async () => {
    const res = await request(makeApp()).get('/api/travel/reports/summary');
    expect(res.status).toBe(401);
    expect(prisma.tmcTrip.groupBy).not.toHaveBeenCalled();
    expect(prisma.itinerary.groupBy).not.toHaveBeenCalled();
    expect(prisma.deal.groupBy).not.toHaveBeenCalled();
  });
});

// ─── Happy path ────────────────────────────────────────────────────

describe('GET /api/travel/reports/summary — happy path', () => {
  test('ADMIN: all 3 sections populated with summary shapes', async () => {
    // TMC inputs: 3 active trips, 2 schools (one repeat), revenue from
    // pricePerStudent * participantCount.
    prisma.tmcTrip.groupBy.mockResolvedValue([
      { status: 'confirmed', _count: { _all: 2 } },
      { status: 'completed', _count: { _all: 1 } },
    ]);
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 1, pricePerStudent: 100, schoolContactId: 11 },
      { id: 2, pricePerStudent: 100, schoolContactId: 11 }, // repeat school
      { id: 3, pricePerStudent: 200, schoolContactId: 22 },
    ]);
    prisma.tripParticipant.groupBy.mockResolvedValue([
      { tripId: 1, _count: { _all: 10 } }, // 100 * 10 = 1000
      { tripId: 2, _count: { _all: 5 } },  // 100 * 5  = 500
      { tripId: 3, _count: { _all: 4 } },  // 200 * 4  = 800
    ]);

    // RFU inputs: 3 status rows + 2 amount rows + 2 contacts (1 repeat).
    prisma.itinerary.groupBy
      .mockResolvedValueOnce([
        { status: 'draft', _count: { _all: 2 } },
        { status: 'accepted', _count: { _all: 3 } },
      ])
      .mockResolvedValueOnce([
        { status: 'draft', _sum: { totalAmount: 10000 } },
        { status: 'accepted', _sum: { totalAmount: 50000 } },
      ])
      .mockResolvedValueOnce([
        { contactId: 1, _count: { _all: 2 } }, // repeat
        { contactId: 2, _count: { _all: 1 } },
      ]);

    // Cross-brand inputs: 2 sub-brands, 8 won, 2 lost.
    prisma.deal.groupBy
      .mockResolvedValueOnce([
        { subBrand: 'tmc', stage: 'won', _count: { _all: 5 } },
        { subBrand: 'tmc', stage: 'lost', _count: { _all: 1 } },
        { subBrand: 'rfu', stage: 'won', _count: { _all: 3 } },
        { subBrand: 'rfu', stage: 'lost', _count: { _all: 1 } },
      ])
      .mockResolvedValueOnce([
        { subBrand: 'tmc', stage: 'won', _sum: { amount: 500000 } },
        { subBrand: 'rfu', stage: 'won', _sum: { amount: 300000 } },
      ]);

    const res = await request(makeApp())
      .get('/api/travel/reports/summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.tmc).toMatchObject({
      trips: { total: 3, active: 3 },
      revenue: { total: 2300, currency: 'INR' },
      schools: { unique: 2, repeat: 1, repeatRatePct: 50 },
    });
    expect(res.body.rfu).toMatchObject({
      itineraries: { total: 5, revenue: 60000 },
      customers: { unique: 2, repeat: 1, repeatRatePct: 50 },
      currency: 'INR',
    });
    expect(res.body.crossBrand).toMatchObject({
      subBrandCount: 2,
      totalWon: 8,
      totalLost: 2,
      totalWonRevenue: 800000,
      conversionPct: 80,
      currency: 'INR',
    });
    expect(typeof res.body.generatedAt).toBe('string');
    // Sections must NOT carry the source endpoints' deep drill-down
    // arrays — keep this a summary, not a full payload.
    expect(res.body.tmc).not.toHaveProperty('deals');
    expect(res.body.rfu).not.toHaveProperty('diagnostics');
    expect(res.body.crossBrand).not.toHaveProperty('subBrands');
  });
});

// ─── Cross-tenant isolation ────────────────────────────────────────

describe('GET /api/travel/reports/summary — cross-tenant', () => {
  test('every where clause carries the caller tenantId (no leak)', async () => {
    await request(makeApp())
      .get('/api/travel/reports/summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    // TMC: tripWhere + activeWhere both carry tenantId.
    for (const call of prisma.tmcTrip.groupBy.mock.calls) {
      expect(call[0].where).toMatchObject({ tenantId: 1 });
    }
    for (const call of prisma.tmcTrip.findMany.mock.calls) {
      expect(call[0].where).toMatchObject({ tenantId: 1 });
    }
    // RFU: every itinerary groupBy carries tenantId + subBrand="rfu".
    for (const call of prisma.itinerary.groupBy.mock.calls) {
      expect(call[0].where).toMatchObject({ tenantId: 1, subBrand: 'rfu' });
    }
    // Cross-brand: deal where carries tenantId + deletedAt:null.
    for (const call of prisma.deal.groupBy.mock.calls) {
      expect(call[0].where).toMatchObject({ tenantId: 1, deletedAt: null });
    }
  });
});

// ─── Sub-brand restriction (graceful per-section) ──────────────────

describe('GET /api/travel/reports/summary — sub-brand graceful degradation', () => {
  test('MANAGER with subBrandAccess=["rfu"] → tmc and crossBrand sub-narrowed; only rfu populated', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    // Populate RFU so the assertion has a non-null body to inspect.
    prisma.itinerary.groupBy
      .mockResolvedValueOnce([{ status: 'sent', _count: { _all: 4 } }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    // Populate cross-brand with rfu-only data (the narrowed query would
    // only return rfu rows anyway under the in:["rfu"] filter).
    prisma.deal.groupBy
      .mockResolvedValueOnce([{ subBrand: 'rfu', stage: 'won', _count: { _all: 2 } }])
      .mockResolvedValueOnce([{ subBrand: 'rfu', stage: 'won', _sum: { amount: 100000 } }]);

    const res = await request(makeApp())
      .get('/api/travel/reports/summary')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    // TMC must be null — caller has no TMC access; the TMC sub-query
    // must not even run (no aggregates fire).
    expect(res.body.tmc).toBeNull();
    expect(prisma.tmcTrip.groupBy).not.toHaveBeenCalled();
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
    // RFU is populated.
    expect(res.body.rfu).not.toBeNull();
    expect(res.body.rfu.itineraries.total).toBe(4);
    // Cross-brand survives but is narrowed to rfu (subBrandCount=1).
    expect(res.body.crossBrand).not.toBeNull();
    expect(res.body.crossBrand.subBrandCount).toBe(1);
    // Verify the deal where carried the in-narrow.
    expect(prisma.deal.groupBy.mock.calls[0][0].where).toMatchObject({
      subBrand: { in: ['rfu'] },
    });
  });
});

// ─── ?from + ?to forwarding ────────────────────────────────────────

describe('GET /api/travel/reports/summary — date forwarding', () => {
  test('?from + ?to ISO bounds turn into createdAt range filter on every sub-query', async () => {
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-12-31T23:59:59.999Z';
    await request(makeApp())
      .get(`/api/travel/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const expectRange = expect.objectContaining({
      gte: new Date(from),
      lte: new Date(to),
    });
    // TMC: both trip queries carry createdAt range.
    for (const call of prisma.tmcTrip.groupBy.mock.calls) {
      expect(call[0].where.createdAt).toEqual(expectRange);
    }
    for (const call of prisma.tmcTrip.findMany.mock.calls) {
      expect(call[0].where.createdAt).toEqual(expectRange);
    }
    // RFU: every itinerary where carries createdAt range.
    for (const call of prisma.itinerary.groupBy.mock.calls) {
      expect(call[0].where.createdAt).toEqual(expectRange);
    }
    // Cross-brand: every deal where carries createdAt range.
    for (const call of prisma.deal.groupBy.mock.calls) {
      expect(call[0].where.createdAt).toEqual(expectRange);
    }
  });

  test('no ?from / ?to → no createdAt key set (avoids spurious range:{} filter)', async () => {
    await request(makeApp())
      .get('/api/travel/reports/summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    for (const call of prisma.tmcTrip.groupBy.mock.calls) {
      expect(call[0].where).not.toHaveProperty('createdAt');
    }
    for (const call of prisma.itinerary.groupBy.mock.calls) {
      expect(call[0].where).not.toHaveProperty('createdAt');
    }
    for (const call of prisma.deal.groupBy.mock.calls) {
      expect(call[0].where).not.toHaveProperty('createdAt');
    }
  });
});

// ─── Graceful degradation on per-section throw ────────────────────

describe('GET /api/travel/reports/summary — graceful degradation', () => {
  test('one sub-section throws → that section is null; others survive', async () => {
    // TMC will throw — tmc section should become null. RFU and
    // cross-brand should still populate with their data.
    prisma.tmcTrip.groupBy.mockRejectedValue(new Error('tmc db blown'));
    prisma.itinerary.groupBy
      .mockResolvedValueOnce([{ status: 'sent', _count: { _all: 1 } }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    prisma.deal.groupBy
      .mockResolvedValueOnce([{ subBrand: 'tmc', stage: 'won', _count: { _all: 1 } }])
      .mockResolvedValueOnce([]);

    const res = await request(makeApp())
      .get('/api/travel/reports/summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.tmc).toBeNull();
    expect(res.body.rfu).not.toBeNull();
    expect(res.body.rfu.itineraries.total).toBe(1);
    expect(res.body.crossBrand).not.toBeNull();
    expect(res.body.crossBrand.totalWon).toBe(1);
    // No DB error message leak.
    expect(JSON.stringify(res.body)).not.toMatch(/tmc db blown/);
  });
});

// ─── generatedAt freshness ─────────────────────────────────────────

describe('GET /api/travel/reports/summary — generatedAt', () => {
  test('generatedAt is an ISO string within 5 seconds of now', async () => {
    const before = Date.now();
    const res = await request(makeApp())
      .get('/api/travel/reports/summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const after = Date.now();
    expect(res.status).toBe(200);
    expect(typeof res.body.generatedAt).toBe('string');
    // Must round-trip through Date — i.e. valid ISO format.
    const parsed = new Date(res.body.generatedAt);
    expect(isNaN(parsed.getTime())).toBe(false);
    expect(parsed.toISOString()).toBe(res.body.generatedAt);
    // Within 5s window.
    const t = parsed.getTime();
    expect(t).toBeGreaterThanOrEqual(before - 5000);
    expect(t).toBeLessThanOrEqual(after + 5000);
  });
});
