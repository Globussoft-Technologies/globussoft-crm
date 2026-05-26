// @ts-check
/**
 * Travel CRM — Owner Dashboard aggregate (Phase 1) contract tests.
 *
 * Pins backend/routes/travel_dashboard.js:
 *   GET /api/travel/dashboard — single endpoint, runs 14 prisma aggregates
 *   in parallel and shapes a response with seven sections (trips,
 *   diagnostics, itineraries, microsites, costMaster, pricingRules,
 *   recentTrips).
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing Bearer → 401 (verifyToken).
 *   - Vertical gate: non-travel tenant → 403 WRONG_VERTICAL
 *     (requireTravelTenant); tenant missing → 404 TENANT_NOT_FOUND.
 *   - Happy path (ADMIN): 200 + the full envelope shape with all 7
 *     sections, byStatus / byClassification / bySubBrand counts flattened
 *     from prisma groupBy rows, and the recentTrips array (max 5).
 *   - Sub-brand scope: ADMIN gets allowed=null → no subBrand filter
 *     applied to the where clause; non-admin with explicit
 *     subBrandAccess=["tmc"] → where.subBrand = { in: ["tmc"] }.
 *   - Recent-trip select shape: id / tripCode / destination / departDate /
 *     returnDate / status — no PII (no participant names / amounts).
 *   - Microsite counts use tenantId only (NOT sub-brand narrowed) per
 *     the route comment: "the sub-brand scope on the parent trip is the
 *     source of truth; the microsite row has tenantId but inherits scope
 *     through the trip."
 *   - DB error path returns 500 with `{ error: "Failed to compute dashboard" }`.
 *
 * Test pattern mirrors backend/test/routes/travel_quotes.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with real HS256 JWTs signed with the dev-fallback
 * secret. verifyToken + requireTravelTenant + getSubBrandAccessSet all
 * stay in the chain (no bypass) so guards are exercised end-to-end.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router. The dashboard touches 6
// tables across 14 calls; each model needs its own vi.fn() shape.
prisma.tmcTrip = {
  count: vi.fn(),
  groupBy: vi.fn(),
  findMany: vi.fn(),
};
prisma.travelDiagnostic = {
  count: vi.fn(),
  groupBy: vi.fn(),
};
prisma.itinerary = {
  count: vi.fn(),
  groupBy: vi.fn(),
};
prisma.tripMicrosite = {
  count: vi.fn(),
};
prisma.travelCostMaster = {
  count: vi.fn(),
  groupBy: vi.fn(),
};
prisma.travelSeasonCalendar = {
  count: vi.fn(),
};
prisma.travelMarkupRule = {
  count: vi.fn(),
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
const travelDashboardRouter = requireCJS('../../routes/travel_dashboard');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelDashboardRouter);
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
 * Wire every aggregate to a deterministic default so individual tests
 * only need to override the values they actually assert on.
 */
function installDefaultAggregates() {
  prisma.tmcTrip.count.mockResolvedValue(0);
  prisma.tmcTrip.groupBy.mockResolvedValue([]);
  prisma.tmcTrip.findMany.mockResolvedValue([]);
  prisma.travelDiagnostic.count.mockResolvedValue(0);
  prisma.travelDiagnostic.groupBy.mockResolvedValue([]);
  prisma.itinerary.count.mockResolvedValue(0);
  prisma.itinerary.groupBy.mockResolvedValue([]);
  prisma.tripMicrosite.count.mockResolvedValue(0);
  prisma.travelCostMaster.count.mockResolvedValue(0);
  prisma.travelCostMaster.groupBy.mockResolvedValue([]);
  prisma.travelSeasonCalendar.count.mockResolvedValue(0);
  prisma.travelMarkupRule.count.mockResolvedValue(0);
}

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.tmcTrip.count.mockReset();
  prisma.tmcTrip.groupBy.mockReset();
  prisma.tmcTrip.findMany.mockReset();
  prisma.travelDiagnostic.count.mockReset();
  prisma.travelDiagnostic.groupBy.mockReset();
  prisma.itinerary.count.mockReset();
  prisma.itinerary.groupBy.mockReset();
  prisma.tripMicrosite.count.mockReset();
  prisma.travelCostMaster.count.mockReset();
  prisma.travelCostMaster.groupBy.mockReset();
  prisma.travelSeasonCalendar.count.mockReset();
  prisma.travelMarkupRule.count.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  installDefaultAggregates();
});

describe('GET /api/travel/dashboard — auth gate', () => {
  test('missing Bearer token returns 401', async () => {
    const res = await request(makeApp()).get('/api/travel/dashboard');
    expect(res.status).toBe(401);
    // verifyToken sets WWW-Authenticate per #537 RFC 7235 semantics.
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    // None of the aggregates should fire.
    expect(prisma.tmcTrip.count).not.toHaveBeenCalled();
  });

  test('garbage Bearer token returns 401 (verifyToken rejects bad sig)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', 'Bearer not.a.real.jwt');
    expect(res.status).toBe(401);
    expect(prisma.tmcTrip.count).not.toHaveBeenCalled();
  });
});

describe('GET /api/travel/dashboard — vertical gate (requireTravelTenant)', () => {
  test('non-travel tenant returns 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Co', slug: 'generic',
    });
    const res = await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    // None of the aggregates should fire.
    expect(prisma.tmcTrip.count).not.toHaveBeenCalled();
    expect(prisma.itinerary.count).not.toHaveBeenCalled();
  });

  test('tenant row missing returns 404 TENANT_NOT_FOUND', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect(prisma.tmcTrip.count).not.toHaveBeenCalled();
  });

  test('wellness-vertical tenant is also rejected (not travel)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'wellness', name: 'Wellness Co', slug: 'wellness',
    });
    const res = await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
  });
});

describe('GET /api/travel/dashboard — happy path envelope', () => {
  test('ADMIN with no data: 200 + all 7 sections present with zeroed counts', async () => {
    const res = await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      trips: { total: 0, byStatus: {}, upcoming30d: 0 },
      diagnostics: { totalLast30d: 0, byClassification: {} },
      itineraries: { total: 0, byStatus: {} },
      microsites: { published: 0, expired: 0 },
      costMaster: { activeRows: 0, bySubBrand: {} },
      pricingRules: { seasons: 0, markupRules: 0 },
      recentTrips: [],
    });
    // Every aggregate should fire — Promise.all dispatches all 14.
    expect(prisma.tmcTrip.count).toHaveBeenCalledTimes(2); // total + upcoming30d
    expect(prisma.tmcTrip.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.tmcTrip.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.travelDiagnostic.count).toHaveBeenCalledTimes(1);
    expect(prisma.travelDiagnostic.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.itinerary.count).toHaveBeenCalledTimes(1);
    expect(prisma.itinerary.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.tripMicrosite.count).toHaveBeenCalledTimes(2); // published + expired
    expect(prisma.travelCostMaster.count).toHaveBeenCalledTimes(1);
    expect(prisma.travelCostMaster.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.travelSeasonCalendar.count).toHaveBeenCalledTimes(1);
    expect(prisma.travelMarkupRule.count).toHaveBeenCalledTimes(1);
  });

  test('flattens prisma groupBy rows into byStatus / byClassification / bySubBrand maps', async () => {
    prisma.tmcTrip.count.mockResolvedValue(42);
    prisma.tmcTrip.groupBy.mockResolvedValue([
      { status: 'confirmed', _count: { _all: 10 } },
      { status: 'in-trip', _count: { _all: 5 } },
      { status: 'completed', _count: { _all: 20 } },
      { status: 'cancelled', _count: { _all: 7 } },
    ]);
    prisma.travelDiagnostic.count.mockResolvedValue(15);
    prisma.travelDiagnostic.groupBy.mockResolvedValue([
      { classification: 'budget', _count: { _all: 8 } },
      { classification: 'premium', _count: { _all: 7 } },
    ]);
    prisma.itinerary.groupBy.mockResolvedValue([
      { status: 'draft', _count: { _all: 3 } },
      { status: 'sent', _count: { _all: 2 } },
      { status: 'accepted', _count: { _all: 4 } },
    ]);
    prisma.travelCostMaster.groupBy.mockResolvedValue([
      { subBrand: 'tmc', _count: { _all: 12 } },
      { subBrand: 'rfu', _count: { _all: 8 } },
      { subBrand: 'travelstall', _count: { _all: 4 } },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.trips.total).toBe(42);
    expect(res.body.trips.byStatus).toEqual({
      confirmed: 10, 'in-trip': 5, completed: 20, cancelled: 7,
    });
    expect(res.body.diagnostics.totalLast30d).toBe(15);
    expect(res.body.diagnostics.byClassification).toEqual({ budget: 8, premium: 7 });
    expect(res.body.itineraries.byStatus).toEqual({ draft: 3, sent: 2, accepted: 4 });
    expect(res.body.costMaster.bySubBrand).toEqual({ tmc: 12, rfu: 8, travelstall: 4 });
  });

  test('recentTrips select shape carries metadata only — no PII fields', async () => {
    const now = new Date();
    const depart = new Date(now.getTime() + 7 * 86_400_000);
    prisma.tmcTrip.findMany.mockResolvedValue([
      {
        id: 1, tripCode: 'TMC-2026-001', destination: 'Bali',
        departDate: depart, returnDate: new Date(depart.getTime() + 5 * 86_400_000),
        status: 'confirmed',
      },
      {
        id: 2, tripCode: 'TMC-2026-002', destination: 'Singapore',
        departDate: depart, returnDate: depart, status: 'draft',
      },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.recentTrips).toHaveLength(2);
    expect(res.body.recentTrips[0]).toMatchObject({
      id: 1, tripCode: 'TMC-2026-001', destination: 'Bali', status: 'confirmed',
    });
    // Verify the select clause asked for exactly the metadata fields.
    const findManyArgs = prisma.tmcTrip.findMany.mock.calls[0][0];
    expect(findManyArgs).toMatchObject({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        tripCode: true,
        destination: true,
        departDate: true,
        returnDate: true,
        status: true,
      },
    });
    // Explicit anti-PII assertion — no participant fields in the select.
    expect(findManyArgs.select).not.toHaveProperty('participants');
    expect(findManyArgs.select).not.toHaveProperty('participantNames');
    expect(findManyArgs.select).not.toHaveProperty('totalAmount');
  });
});

describe('GET /api/travel/dashboard — tenant + sub-brand scoping', () => {
  test('all aggregate where clauses include tenantId from req.user', async () => {
    await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { userId: 7, tenantId: 1 })}`);
    // tmcTrip.count(total) — first call
    expect(prisma.tmcTrip.count.mock.calls[0][0]).toMatchObject({
      where: expect.objectContaining({ tenantId: 1 }),
    });
    // itinerary.count
    expect(prisma.itinerary.count.mock.calls[0][0]).toMatchObject({
      where: expect.objectContaining({ tenantId: 1 }),
    });
    // travelCostMaster.count (with isActive=true narrow)
    expect(prisma.travelCostMaster.count.mock.calls[0][0]).toMatchObject({
      where: expect.objectContaining({ tenantId: 1, isActive: true }),
    });
    // travelSeasonCalendar.count
    expect(prisma.travelSeasonCalendar.count.mock.calls[0][0]).toMatchObject({
      where: expect.objectContaining({ tenantId: 1 }),
    });
    // travelMarkupRule.count (with isActive=true)
    expect(prisma.travelMarkupRule.count.mock.calls[0][0]).toMatchObject({
      where: expect.objectContaining({ tenantId: 1, isActive: true }),
    });
  });

  test('ADMIN (allowed=null) → no subBrand filter applied to where clauses', async () => {
    await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    // ADMIN gets allowed=null → narrowWhereBySubBrand is a no-op, so the
    // tmcTrip aggregate where clause must NOT contain a subBrand key.
    const tmcWhere = prisma.tmcTrip.count.mock.calls[0][0].where;
    expect(tmcWhere).not.toHaveProperty('subBrand');
    const itinWhere = prisma.itinerary.count.mock.calls[0][0].where;
    expect(itinWhere).not.toHaveProperty('subBrand');
    const costWhere = prisma.travelCostMaster.count.mock.calls[0][0].where;
    expect(costWhere).not.toHaveProperty('subBrand');
  });

  test('non-admin with subBrandAccess=["tmc"] narrows where.subBrand to { in: ["tmc"] }', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    // tmcTrip aggregates must narrow to the user's allowed sub-brands.
    const tmcWhere = prisma.tmcTrip.count.mock.calls[0][0].where;
    expect(tmcWhere).toMatchObject({
      tenantId: 1,
      subBrand: { in: ['tmc'] },
    });
    // Same narrow on itineraries.
    const itinWhere = prisma.itinerary.count.mock.calls[0][0].where;
    expect(itinWhere).toMatchObject({
      tenantId: 1,
      subBrand: { in: ['tmc'] },
    });
    // Same narrow on travelCostMaster.
    const costWhere = prisma.travelCostMaster.count.mock.calls[0][0].where;
    expect(costWhere).toMatchObject({
      tenantId: 1,
      subBrand: { in: ['tmc'] },
      isActive: true,
    });
  });

  test('microsite counts use tenantId ONLY (NOT sub-brand narrowed — sourced from parent trip)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    // Microsites are NOT narrowed by sub-brand even for a non-admin —
    // the route comment explains: scope inherits through the parent trip.
    const publishedWhere = prisma.tripMicrosite.count.mock.calls[0][0].where;
    expect(publishedWhere).toEqual({ tenantId: 1 });
    expect(publishedWhere).not.toHaveProperty('subBrand');
    // The "expired" microsite call also stays tenant-only + the expiresAt narrow.
    const expiredWhere = prisma.tripMicrosite.count.mock.calls[1][0].where;
    expect(expiredWhere).toMatchObject({ tenantId: 1 });
    expect(expiredWhere).toHaveProperty('expiresAt');
    expect(expiredWhere).not.toHaveProperty('subBrand');
  });

  test('diagnostics and trips upcoming30d carry the time-window narrow', async () => {
    await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    // diagnostic.count carries `createdAt: { gte: thirtyDaysAgo }`.
    const diagWhere = prisma.travelDiagnostic.count.mock.calls[0][0].where;
    expect(diagWhere).toHaveProperty('createdAt');
    expect(diagWhere.createdAt).toHaveProperty('gte');
    // tmcTrip.count second call (upcoming30d) carries departDate window.
    const upcomingWhere = prisma.tmcTrip.count.mock.calls[1][0].where;
    expect(upcomingWhere).toHaveProperty('departDate');
    expect(upcomingWhere.departDate).toHaveProperty('gte');
    expect(upcomingWhere.departDate).toHaveProperty('lte');
  });

  test('aggregate where objects are independent references (no shared mutation)', async () => {
    await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    // Per the route comment, scoped() builds a fresh object each call so
    // narrowWhereBySubBrand doesn't accidentally cross-contaminate where
    // clauses. Probe by asserting the tmcTrip(total) where and the
    // tmcTrip(upcoming30d) where are distinct object instances.
    const totalWhere = prisma.tmcTrip.count.mock.calls[0][0].where;
    const upcomingWhere = prisma.tmcTrip.count.mock.calls[1][0].where;
    expect(totalWhere).not.toBe(upcomingWhere);
    // total doesn't carry the departDate window; upcoming does.
    expect(totalWhere).not.toHaveProperty('departDate');
    expect(upcomingWhere).toHaveProperty('departDate');
  });
});

describe('GET /api/travel/dashboard — error path', () => {
  test('prisma aggregate throws → 500 with generic error envelope', async () => {
    prisma.tmcTrip.count.mockRejectedValue(new Error('connection refused'));
    const res = await request(makeApp())
      .get('/api/travel/dashboard')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Failed to compute dashboard' });
    // The catch block must NOT leak the underlying DB error message.
    expect(JSON.stringify(res.body)).not.toMatch(/connection refused/);
  });
});
