// @ts-check
/**
 * Travel CRM — Reports aggregates (Phase 1 §4.9) contract tests.
 *
 * Pins backend/routes/travel_reports.js:
 *   GET /api/travel/reports/tmc          — TMC analytics (school trips)
 *   GET /api/travel/reports/rfu          — RFU analytics (Umrah pilgrimage)
 *   GET /api/travel/reports/cross-brand  — Multi-sub-brand revenue + conversion
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing / garbage Bearer → 401 (verifyToken). Aggregates
 *     never fire when the gate trips.
 *   - Vertical gate: non-travel tenant → 403 WRONG_VERTICAL
 *     (requireTravelTenant); tenant row missing → 404 TENANT_NOT_FOUND.
 *   - Sub-brand gate (TMC + RFU endpoints): caller without TMC/RFU access
 *     → 403 SUB_BRAND_DENIED. Cross-brand endpoint has no per-endpoint
 *     sub-brand gate — it just narrows the result set to the caller's
 *     allowed sub-brands.
 *   - TMC happy path: tripsByStatus rolled into trips.byStatus +
 *     trips.total; revenue computed as `pricePerStudent × participantCount`
 *     for ACTIVE statuses only (confirmed / in-trip / completed);
 *     topDestinations sorted desc, capped at 10; repeat-school detection
 *     counts contacts with ≥2 trips.
 *   - RFU happy path: itineraries aggregated by status (count + sum of
 *     totalAmount); deals aggregated by stage; diagnostics grouped by
 *     tier + classification; repeat-customer rate computed from itinerary
 *     counts per contact.
 *   - Cross-brand happy path: per-sub-brand object containing
 *     dealsByStage / dealAmountByStage / diagnostics / won / lost /
 *     wonRevenue / conversionPct. Conversion = won / (won + lost) with
 *     zero-terminal-deal-count safely yielding 0 (no divide-by-zero).
 *   - Cross-brand sub-brand narrowing: ADMIN (allowed=null) → no subBrand
 *     filter on deal where clause beyond `subBrand: { not: null }`; non-admin
 *     with subBrandAccess=["rfu"] → deal where narrows to subBrand `{ in: ["rfu"] }`.
 *   - Error path: prisma aggregate throws → 500 with the expected envelope
 *     per endpoint; no DB error leak.
 *
 * Test pattern mirrors backend/test/routes/travel-dashboard.test.js +
 * travel-visa-analytics.test.js — patch the prisma singleton with vi.fn()
 * shapes BEFORE requiring the router, then drive supertest with real HS256
 * JWTs signed with the dev-fallback secret. verifyToken +
 * requireTravelTenant + getSubBrandAccessSet all stay in the chain (no
 * bypass) so guards are exercised end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router. Reports route touches 5
// tables across 3 endpoints. Each model needs its own vi.fn() shape.
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

/**
 * Wire every aggregate to a deterministic empty default so individual
 * tests only need to override the values they actually assert on.
 */
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

describe('travel_reports — auth gate', () => {
  test('GET /reports/tmc without Bearer returns 401', async () => {
    const res = await request(makeApp()).get('/api/travel/reports/tmc');
    expect(res.status).toBe(401);
    expect(prisma.tmcTrip.groupBy).not.toHaveBeenCalled();
  });

  test('GET /reports/rfu with garbage Bearer returns 401', async () => {
    const res = await request(makeApp())
      .get('/api/travel/reports/rfu')
      .set('Authorization', 'Bearer not.a.real.jwt');
    expect(res.status).toBe(401);
    expect(prisma.itinerary.groupBy).not.toHaveBeenCalled();
  });

  test('GET /reports/cross-brand without Bearer returns 401', async () => {
    const res = await request(makeApp()).get('/api/travel/reports/cross-brand');
    expect(res.status).toBe(401);
    expect(prisma.deal.groupBy).not.toHaveBeenCalled();
  });
});

// ─── Vertical gate ─────────────────────────────────────────────────

describe('travel_reports — vertical gate', () => {
  test('non-travel tenant returns 403 WRONG_VERTICAL on TMC report', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Co', slug: 'generic',
    });
    const res = await request(makeApp())
      .get('/api/travel/reports/tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.tmcTrip.groupBy).not.toHaveBeenCalled();
  });

  test('wellness-vertical tenant rejected on RFU report', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'wellness', name: 'Wellness Co', slug: 'wellness',
    });
    const res = await request(makeApp())
      .get('/api/travel/reports/rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
  });

  test('tenant row missing returns 404 TENANT_NOT_FOUND on cross-brand', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/reports/cross-brand')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect(prisma.deal.groupBy).not.toHaveBeenCalled();
  });
});

// ─── Sub-brand gate (TMC + RFU endpoints) ──────────────────────────

describe('travel_reports — sub-brand gate', () => {
  test('TMC: non-admin without "tmc" access → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    const res = await request(makeApp())
      .get('/api/travel/reports/tmc')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    // None of the TMC aggregates should fire when the sub-brand gate trips.
    expect(prisma.tmcTrip.groupBy).not.toHaveBeenCalled();
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
  });

  test('RFU: non-admin without "rfu" access → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .get('/api/travel/reports/rfu')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.itinerary.groupBy).not.toHaveBeenCalled();
  });

  test('TMC: ADMIN bypasses sub-brand gate even with no subBrandAccess column', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'ADMIN', subBrandAccess: null,
    });
    const res = await request(makeApp())
      .get('/api/travel/reports/tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.tmcTrip.groupBy).toHaveBeenCalled();
  });

  test('RFU: caller with ["rfu","tmc"] access reaches the aggregates', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu', 'tmc']),
    });
    const res = await request(makeApp())
      .get('/api/travel/reports/rfu')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(200);
    expect(prisma.itinerary.groupBy).toHaveBeenCalled();
  });
});

// ─── TMC happy path ────────────────────────────────────────────────

describe('GET /api/travel/reports/tmc — happy path', () => {
  test('ADMIN with no data: 200 + empty-shape envelope', async () => {
    const res = await request(makeApp())
      .get('/api/travel/reports/tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      trips: { total: 0, byStatus: {}, active: 0 },
      revenue: { total: 0, topDestinations: [], currency: 'INR' },
      schools: { unique: 0, repeat: 0, repeatRatePct: 0 },
      deals: { byStage: {}, amountByStage: {} },
      diagnostics: { byClassification: {} },
    });
  });

  test('rolls tripsByStatus into byStatus + total; reflects active count', async () => {
    prisma.tmcTrip.groupBy.mockResolvedValue([
      { status: 'confirmed', _count: { _all: 4 } },
      { status: 'in-trip', _count: { _all: 2 } },
      { status: 'completed', _count: { _all: 10 } },
      { status: 'cancelled', _count: { _all: 3 } },
    ]);
    prisma.tmcTrip.findMany.mockResolvedValue([
      // 16 active rows (4 + 2 + 10) — but findMany returns the actual
      // selected rows; for `active` count we just use array length.
      { id: 1, destination: 'Bali', pricePerStudent: 100, schoolContactId: 1 },
      { id: 2, destination: 'Bali', pricePerStudent: 100, schoolContactId: 1 },
      { id: 3, destination: 'Singapore', pricePerStudent: 200, schoolContactId: 2 },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/reports/tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.trips.total).toBe(4 + 2 + 10 + 3);
    expect(res.body.trips.byStatus).toEqual({
      confirmed: 4, 'in-trip': 2, completed: 10, cancelled: 3,
    });
    expect(res.body.trips.active).toBe(3);
  });

  test('revenue = pricePerStudent × participantCount across active trips; topDestinations sorted desc', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 1, destination: 'Bali', pricePerStudent: 100, schoolContactId: 1 },
      { id: 2, destination: 'Singapore', pricePerStudent: 200, schoolContactId: 2 },
      { id: 3, destination: 'Bali', pricePerStudent: 100, schoolContactId: 3 },
    ]);
    prisma.tripParticipant.groupBy.mockResolvedValue([
      { tripId: 1, _count: { _all: 30 } }, // Bali $100 × 30 = $3000
      { tripId: 2, _count: { _all: 25 } }, // Singapore $200 × 25 = $5000
      { tripId: 3, _count: { _all: 10 } }, // Bali $100 × 10 = $1000
    ]);

    const res = await request(makeApp())
      .get('/api/travel/reports/tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.revenue.total).toBe(3000 + 5000 + 1000);
    // topDestinations sorted by revenue DESC. Bali aggregates to $4000;
    // Singapore is $5000 → Singapore first.
    expect(res.body.revenue.topDestinations).toEqual([
      { destination: 'Singapore', revenue: 5000 },
      { destination: 'Bali', revenue: 4000 },
    ]);
    expect(res.body.revenue.currency).toBe('INR');
  });

  test('repeat-school detection: schools with ≥2 trips count toward repeat + repeatRatePct', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      // School 1 → 2 trips (repeat)
      { id: 1, destination: 'A', pricePerStudent: 100, schoolContactId: 1 },
      { id: 2, destination: 'B', pricePerStudent: 100, schoolContactId: 1 },
      // School 2 → 3 trips (repeat)
      { id: 3, destination: 'A', pricePerStudent: 100, schoolContactId: 2 },
      { id: 4, destination: 'B', pricePerStudent: 100, schoolContactId: 2 },
      { id: 5, destination: 'C', pricePerStudent: 100, schoolContactId: 2 },
      // School 3 → 1 trip (not repeat)
      { id: 6, destination: 'A', pricePerStudent: 100, schoolContactId: 3 },
      // School 4 → 1 trip (not repeat)
      { id: 7, destination: 'B', pricePerStudent: 100, schoolContactId: 4 },
    ]);
    prisma.tripParticipant.groupBy.mockResolvedValue([]); // no participants → revenue=0

    const res = await request(makeApp())
      .get('/api/travel/reports/tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.schools.unique).toBe(4); // 4 distinct schoolContactId
    expect(res.body.schools.repeat).toBe(2); // schools 1 + 2
    // 2 / 4 = 50%
    expect(res.body.schools.repeatRatePct).toBe(50);
  });

  test('deals.byStage + amountByStage roll up from prisma.deal.groupBy calls', async () => {
    // Two separate groupBy calls — _count and _sum — return matching shapes.
    prisma.deal.groupBy
      .mockResolvedValueOnce([ // _count call
        { stage: 'qualified', _count: { _all: 5 } },
        { stage: 'won', _count: { _all: 3 } },
      ])
      .mockResolvedValueOnce([ // _sum call
        { stage: 'qualified', _sum: { amount: 150000 } },
        { stage: 'won', _sum: { amount: 90000 } },
      ]);

    const res = await request(makeApp())
      .get('/api/travel/reports/tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.deals.byStage).toEqual({ qualified: 5, won: 3 });
    expect(res.body.deals.amountByStage).toEqual({ qualified: 150000, won: 90000 });
  });

  test('only ACTIVE statuses contribute to active count — findMany where clause asserts this', async () => {
    await request(makeApp())
      .get('/api/travel/reports/tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    // findMany's where clause restricts to status in [confirmed, in-trip, completed].
    const findManyArgs = prisma.tmcTrip.findMany.mock.calls[0][0];
    expect(findManyArgs.where).toMatchObject({
      tenantId: 1,
      status: { in: ['confirmed', 'in-trip', 'completed'] },
    });
    // Select clause has no PII / participant fields (only the metadata
    // needed for revenue computation).
    expect(findManyArgs.select).toEqual({
      id: true,
      destination: true,
      pricePerStudent: true,
      schoolContactId: true,
    });
  });

  test('TMC: all deal + diagnostic where clauses narrow to subBrand="tmc"', async () => {
    await request(makeApp())
      .get('/api/travel/reports/tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    // Both deal.groupBy calls scope to subBrand="tmc".
    for (const call of prisma.deal.groupBy.mock.calls) {
      expect(call[0].where).toMatchObject({
        tenantId: 1, subBrand: 'tmc', deletedAt: null,
      });
    }
    // Diagnostic groupBy also scoped to subBrand="tmc".
    const diagArgs = prisma.travelDiagnostic.groupBy.mock.calls[0][0];
    expect(diagArgs.where).toMatchObject({ tenantId: 1, subBrand: 'tmc' });
  });
});

// ─── RFU happy path ────────────────────────────────────────────────

describe('GET /api/travel/reports/rfu — happy path', () => {
  test('ADMIN with no data: 200 + empty-shape envelope', async () => {
    const res = await request(makeApp())
      .get('/api/travel/reports/rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      itineraries: { total: 0, byStatus: {}, amountByStatus: {} },
      deals: { byStage: {}, amountByStage: {} },
      diagnostics: { byTier: {}, byClassification: {} },
      customers: { unique: 0, repeat: 0, repeatRatePct: 0 },
      currency: 'INR',
    });
  });

  test('flattens itinerary count + sum aggregates into byStatus / amountByStatus', async () => {
    prisma.itinerary.groupBy
      .mockResolvedValueOnce([ // count
        { status: 'draft', _count: { _all: 3 } },
        { status: 'sent', _count: { _all: 5 } },
        { status: 'accepted', _count: { _all: 8 } },
      ])
      .mockResolvedValueOnce([ // sum totalAmount
        { status: 'draft', _sum: { totalAmount: 30000 } },
        { status: 'sent', _sum: { totalAmount: 75000 } },
        { status: 'accepted', _sum: { totalAmount: 200000 } },
      ])
      // The contactId groupBy comes LAST in the Promise.all order — but
      // since we use mockResolvedValue defaults for safety we redirect
      // each sequential call here.
      .mockResolvedValueOnce([]); // contactId groupBy

    const res = await request(makeApp())
      .get('/api/travel/reports/rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.itineraries.total).toBe(3 + 5 + 8);
    expect(res.body.itineraries.byStatus).toEqual({ draft: 3, sent: 5, accepted: 8 });
    expect(res.body.itineraries.amountByStatus).toEqual({
      draft: 30000, sent: 75000, accepted: 200000,
    });
  });

  test('RFU: repeat-customer detection counts contacts with ≥2 itineraries', async () => {
    // First two itinerary.groupBy calls (status count / status sum) → empty.
    // Third call (contactId groupBy) carries the per-customer counts.
    prisma.itinerary.groupBy
      .mockResolvedValueOnce([])  // status count
      .mockResolvedValueOnce([])  // status sum
      .mockResolvedValueOnce([    // contactId groupBy
        { contactId: 1, _count: { _all: 1 } },  // not repeat
        { contactId: 2, _count: { _all: 3 } },  // repeat
        { contactId: 3, _count: { _all: 2 } },  // repeat
        { contactId: 4, _count: { _all: 1 } },  // not repeat
        { contactId: 5, _count: { _all: 1 } },  // not repeat
      ]);

    const res = await request(makeApp())
      .get('/api/travel/reports/rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.customers.unique).toBe(5);
    expect(res.body.customers.repeat).toBe(2);
    // 2 / 5 = 40%
    expect(res.body.customers.repeatRatePct).toBe(40);
  });

  test('RFU: diagnostics roll up by tier AND by classification — two distinct groupBys', async () => {
    // Two travelDiagnostic.groupBy calls — tier first, classification
    // second per the Promise.all ordering in the route.
    prisma.travelDiagnostic.groupBy
      .mockResolvedValueOnce([
        { recommendedTier: 'entry', _count: { _all: 5 } },
        { recommendedTier: 'primary', _count: { _all: 7 } },
        { recommendedTier: 'premium', _count: { _all: 2 } },
      ])
      .mockResolvedValueOnce([
        { classification: 'qualified', _count: { _all: 10 } },
        { classification: 'unqualified', _count: { _all: 4 } },
      ]);

    const res = await request(makeApp())
      .get('/api/travel/reports/rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.diagnostics.byTier).toEqual({ entry: 5, primary: 7, premium: 2 });
    expect(res.body.diagnostics.byClassification).toEqual({
      qualified: 10, unqualified: 4,
    });
  });

  test('RFU: all aggregates scope to subBrand="rfu" + tenantId', async () => {
    await request(makeApp())
      .get('/api/travel/reports/rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    // Every itinerary groupBy carries subBrand="rfu".
    for (const call of prisma.itinerary.groupBy.mock.calls) {
      expect(call[0].where).toMatchObject({ tenantId: 1, subBrand: 'rfu' });
    }
    // Both deal groupBys carry subBrand="rfu".
    for (const call of prisma.deal.groupBy.mock.calls) {
      expect(call[0].where).toMatchObject({
        tenantId: 1, subBrand: 'rfu', deletedAt: null,
      });
    }
    // Both diagnostic groupBys carry subBrand="rfu".
    for (const call of prisma.travelDiagnostic.groupBy.mock.calls) {
      expect(call[0].where).toMatchObject({ tenantId: 1, subBrand: 'rfu' });
    }
  });
});

// ─── Cross-brand happy path ────────────────────────────────────────

describe('GET /api/travel/reports/cross-brand — happy path', () => {
  test('ADMIN with no data: 200 + empty subBrands map + currency', async () => {
    const res = await request(makeApp())
      .get('/api/travel/reports/cross-brand')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subBrands: {}, currency: 'INR' });
  });

  test('builds per-sub-brand object with dealsByStage / dealAmountByStage / diagnostics', async () => {
    prisma.deal.groupBy
      .mockResolvedValueOnce([ // count by (subBrand, stage)
        { subBrand: 'tmc', stage: 'won', _count: { _all: 8 } },
        { subBrand: 'tmc', stage: 'lost', _count: { _all: 2 } },
        { subBrand: 'rfu', stage: 'won', _count: { _all: 4 } },
        { subBrand: 'rfu', stage: 'qualified', _count: { _all: 6 } },
      ])
      .mockResolvedValueOnce([ // sum amount by (subBrand, stage)
        { subBrand: 'tmc', stage: 'won', _sum: { amount: 800000 } },
        { subBrand: 'rfu', stage: 'won', _sum: { amount: 400000 } },
      ]);
    prisma.travelDiagnostic.groupBy.mockResolvedValueOnce([
      { subBrand: 'tmc', _count: { _all: 25 } },
      { subBrand: 'rfu', _count: { _all: 15 } },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/reports/cross-brand')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.subBrands.tmc).toMatchObject({
      dealsByStage: { won: 8, lost: 2 },
      dealAmountByStage: { won: 800000 },
      diagnostics: 25,
      won: 8,
      lost: 2,
      wonRevenue: 800000,
      // Conversion = won / (won+lost) = 8 / 10 = 80%
      conversionPct: 80,
    });
    expect(res.body.subBrands.rfu).toMatchObject({
      dealsByStage: { won: 4, qualified: 6 },
      dealAmountByStage: { won: 400000 },
      diagnostics: 15,
      won: 4,
      lost: 0,
      wonRevenue: 400000,
      // Only won (no lost) → conversion = 4 / (4+0) = 100%
      conversionPct: 100,
    });
  });

  test('zero terminal deals (no won, no lost) → conversionPct safely 0 (no NaN)', async () => {
    prisma.deal.groupBy
      .mockResolvedValueOnce([
        { subBrand: 'travelstall', stage: 'qualified', _count: { _all: 5 } },
      ])
      .mockResolvedValueOnce([]);
    prisma.travelDiagnostic.groupBy.mockResolvedValueOnce([]);

    const res = await request(makeApp())
      .get('/api/travel/reports/cross-brand')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.subBrands.travelstall).toMatchObject({
      won: 0,
      lost: 0,
      conversionPct: 0,
      wonRevenue: 0,
    });
    // NaN / Infinity must never appear in the response.
    expect(JSON.stringify(res.body)).not.toMatch(/NaN|Infinity/);
  });

  test('ADMIN (allowed=null): deal where carries subBrand:{not:null} but NOT a {in:[...]} narrow', async () => {
    await request(makeApp())
      .get('/api/travel/reports/cross-brand')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    // Both deal groupBy calls share the same dealWhere envelope.
    const dealWhere = prisma.deal.groupBy.mock.calls[0][0].where;
    expect(dealWhere).toMatchObject({ tenantId: 1, deletedAt: null });
    // ADMIN means no narrow — subBrand should be { not: null } (the
    // route's default to exclude null-subBrand deals), NOT a { in: [...] }
    // restriction.
    expect(dealWhere.subBrand).toEqual({ not: null });
    expect(dealWhere.subBrand).not.toHaveProperty('in');
  });

  test('non-admin with subBrandAccess=["rfu"]: deal where narrows to subBrand:{in:["rfu"]}', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    await request(makeApp())
      .get('/api/travel/reports/cross-brand')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    const dealWhere = prisma.deal.groupBy.mock.calls[0][0].where;
    expect(dealWhere).toMatchObject({
      tenantId: 1,
      deletedAt: null,
      subBrand: { in: ['rfu'] },
    });
    // The { not: null } default must be overridden by the in-narrow.
    expect(dealWhere.subBrand).not.toHaveProperty('not');
  });

  test('diagnostic groupBy uses scoped() helper — tenantId + sub-brand intersection', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc', 'rfu']),
    });
    await request(makeApp())
      .get('/api/travel/reports/cross-brand')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    const diagWhere = prisma.travelDiagnostic.groupBy.mock.calls[0][0].where;
    expect(diagWhere).toMatchObject({
      tenantId: 1,
      subBrand: { in: ['tmc', 'rfu'] },
    });
  });
});

// ─── Error path ────────────────────────────────────────────────────

describe('travel_reports — error path', () => {
  test('TMC: prisma throws → 500 with "Failed to compute TMC report"; no DB-msg leak', async () => {
    prisma.tmcTrip.groupBy.mockRejectedValue(new Error('connection refused'));
    const res = await request(makeApp())
      .get('/api/travel/reports/tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Failed to compute TMC report' });
    expect(JSON.stringify(res.body)).not.toMatch(/connection refused/);
  });

  test('RFU: prisma throws → 500 with "Failed to compute RFU report"; no DB-msg leak', async () => {
    prisma.itinerary.groupBy.mockRejectedValue(new Error('innodb cluster down'));
    const res = await request(makeApp())
      .get('/api/travel/reports/rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Failed to compute RFU report' });
    expect(JSON.stringify(res.body)).not.toMatch(/innodb cluster down/);
  });

  test('cross-brand: prisma throws → 500 with "Failed to compute cross-brand report"; no DB-msg leak', async () => {
    prisma.deal.groupBy.mockRejectedValue(new Error('mysql gone away'));
    const res = await request(makeApp())
      .get('/api/travel/reports/cross-brand')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Failed to compute cross-brand report' });
    expect(JSON.stringify(res.body)).not.toMatch(/mysql gone away/);
  });
});
