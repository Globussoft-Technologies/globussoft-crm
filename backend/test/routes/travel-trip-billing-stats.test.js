// @ts-check
/**
 * Arc 2 Travel Gap (TMC trip billing) — GET /api/travel/trip-billing/stats
 * tenant-wide TMC trip-billing rollup.
 *
 * First rollup endpoint shipped for backend/routes/travel_trip_billing.js
 * (the per-trip rooming/payment-plan/instalments surface had no aggregate).
 * Mirrors /suppliers/stats + /commission-profiles/stats shape — USER-readable
 * anodyne aggregate, TMC sub-brand locked via requireTmcAccess, NO audit
 * row written.
 *
 * What's pinned
 * -------------
 *   - Auth gate:           missing token → 401.
 *   - TMC sub-brand gate:  non-TMC MANAGER (subBrandAccess=['rfu']) → 403
 *                          SUB_BRAND_DENIED.
 *   - Date validation:     bad ?from / ?to → 400 INVALID_DATE.
 *   - Empty tenant:        zeroed envelope with empty bucket set populated
 *                          and lastPlanCreatedAt=null.
 *   - Happy path:          2 trips + 2 plans + 5 instalments + 3 rooming →
 *                          counts correct, instalmentsByStatus tallied,
 *                          totalReceived sums only paid-status rows'
 *                          paidAmount (NOT amount column — that's the
 *                          scheduled value, paidAmount is the canonical
 *                          paid-amount field per PATCH handler at ~line 488).
 *   - Sum precision:       paidAmount with decimals → half-up rounded to 2dp.
 *   - lastPlanCreatedAt:   max(createdAt) across plans (newest wins).
 *   - Tenant isolation:    different tenantId → 0s (route's tmcTrip.findMany
 *                          scopes by tenantId before fetching children).
 *   - Window filter:       ?from/?to narrows the child rows' createdAt;
 *                          out-of-window rows are excluded by the prisma
 *                          where clause.
 *   - No audit row:        read-only meta surface — auditLog.create not
 *                          called.
 *
 * Discovered: the canonical paid-amount column is `paidAmount` (Decimal
 * @db.Decimal(15, 2), default 0) on TripInstalmentPayment per
 * prisma/schema.prisma:4591 + routes/travel_trip_billing.js PATCH handler
 * at ~line 511. NOT `receivedAmount` (which doesn't exist on the model).
 *
 * Test pattern mirrors backend/test/routes/travel-trip-billing.test.js +
 * backend/test/routes/travel-supplier-stats.test.js — patch the prisma
 * singleton with vi.fn() shapes BEFORE requiring the router, then drive
 * supertest with HS256 JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.tmcTrip = prisma.tmcTrip || {};
prisma.tmcTrip.findMany = vi.fn();
prisma.tmcTrip.findFirst = vi.fn();
prisma.tripPaymentPlan = prisma.tripPaymentPlan || {};
prisma.tripPaymentPlan.findMany = vi.fn();
prisma.tripInstalmentPayment = prisma.tripInstalmentPayment || {};
prisma.tripInstalmentPayment.findMany = vi.fn();
prisma.roomingAssignment = prisma.roomingAssignment || {};
prisma.roomingAssignment.count = vi.fn();
prisma.roomingAssignment.findMany = vi.fn();
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
const tripBillingRouter = requireCJS('../../routes/travel_trip_billing');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', tripBillingRouter);
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
  prisma.tmcTrip.findMany.mockReset();
  prisma.tripPaymentPlan.findMany.mockReset();
  prisma.tripInstalmentPayment.findMany.mockReset();
  prisma.roomingAssignment.count.mockReset();
  prisma.roomingAssignment.findMany.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
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

describe('GET /api/travel/trip-billing/stats', () => {
  test('auth gate: missing Authorization header → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/travel/trip-billing/stats');
    expect(res.status).toBe(401);
  });

  test('TMC sub-brand gate: non-TMC MANAGER (subBrandAccess=["rfu"]) → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
    // requireTmcAccess fires BEFORE any prisma aggregation — verify no
    // child-table reads happened.
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
    expect(prisma.tripPaymentPlan.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/stats?to=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('empty tenant: 0 trips → zeroed envelope with status buckets all 0 + lastPlanCreatedAt=null', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalTrips: 0,
      totalPlans: 0,
      totalInstalments: 0,
      instalmentsByStatus: { pending: 0, partial: 0, paid: 0, overdue: 0 },
      totalReceived: 0,
      totalRoomingAssignments: 0,
      lastPlanCreatedAt: null,
    });
    // Children were never queried — empty short-circuit kicked in.
    expect(prisma.tripPaymentPlan.findMany).not.toHaveBeenCalled();
    expect(prisma.tripInstalmentPayment.findMany).not.toHaveBeenCalled();
    expect(prisma.roomingAssignment.count).not.toHaveBeenCalled();
  });

  test('happy path: 2 plans + 5 instalments (2 paid + 2 pending + 1 overdue) + 3 rooming → counts + totalReceived sum correct', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 10 },
      { id: 11 },
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 10, createdAt: new Date('2026-05-10T10:00:00Z') },
      { tripId: 11, createdAt: new Date('2026-05-15T10:00:00Z') },
    ]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { tripId: 10, status: 'paid', paidAmount: 1000 },
      { tripId: 10, status: 'paid', paidAmount: 500 },
      { tripId: 10, status: 'pending', paidAmount: 0 },
      { tripId: 11, status: 'pending', paidAmount: 0 },
      { tripId: 11, status: 'overdue', paidAmount: 0 },
    ]);
    prisma.roomingAssignment.count.mockResolvedValue(3);
    prisma.roomingAssignment.findMany.mockResolvedValue([
      { tripId: 10 },
      { tripId: 11 },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalTrips).toBe(2);
    expect(res.body.totalPlans).toBe(2);
    expect(res.body.totalInstalments).toBe(5);
    expect(res.body.instalmentsByStatus).toEqual({
      pending: 2,
      partial: 0,
      paid: 2,
      overdue: 1,
    });
    expect(res.body.totalReceived).toBe(1500); // 1000 + 500
    expect(res.body.totalRoomingAssignments).toBe(3);
    expect(res.body.lastPlanCreatedAt).toBe(new Date('2026-05-15T10:00:00Z').toISOString());
  });

  test('sum precision: paidAmount with decimals → totalReceived half-up rounded to 2dp', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { tripId: 10, status: 'paid', paidAmount: 100.555 },
      { tripId: 10, status: 'paid', paidAmount: 50.005 },
      { tripId: 10, status: 'paid', paidAmount: 25.001 },
    ]);
    prisma.roomingAssignment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 100.555 + 50.005 + 25.001 = 175.561 → 175.56 (half-up rounded)
    expect(res.body.totalReceived).toBe(175.56);
  });

  test('lastPlanCreatedAt: picks the maximum createdAt across plans', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 10, createdAt: new Date('2026-05-01T10:00:00Z') },
      { tripId: 10, createdAt: newest }, // newest — should drive lastPlanCreatedAt
      { tripId: 10, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([]);
    prisma.roomingAssignment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastPlanCreatedAt).toBe(newest.toISOString());
  });

  test('tenant isolation: tmcTrip.findMany was scoped by tenantId before fetching children', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 99 }]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([]);
    prisma.roomingAssignment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // The tenantId clause on the trip lookup is the only tenant boundary —
    // children are then scoped via tripId IN (tenant's trip ids).
    const tripWhere = prisma.tmcTrip.findMany.mock.calls[0][0].where;
    expect(tripWhere.tenantId).toBe(1);
    // Children scoped to the returned trip-id set.
    const planWhere = prisma.tripPaymentPlan.findMany.mock.calls[0][0].where;
    expect(planWhere.tripId).toEqual({ in: [99] });
    const insWhere = prisma.tripInstalmentPayment.findMany.mock.calls[0][0].where;
    expect(insWhere.tripId).toEqual({ in: [99] });
    const roomWhere = prisma.roomingAssignment.count.mock.calls[0][0].where;
    expect(roomWhere.tripId).toEqual({ in: [99] });
  });

  test('?from/?to: narrows the window — date clauses appear on all 3 child queries', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([]);
    prisma.roomingAssignment.count.mockResolvedValue(0);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/travel/trip-billing/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const planWhere = prisma.tripPaymentPlan.findMany.mock.calls[0][0].where;
    expect(planWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(planWhere.createdAt.lte).toEqual(new Date(toIso));
    const insWhere = prisma.tripInstalmentPayment.findMany.mock.calls[0][0].where;
    expect(insWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(insWhere.createdAt.lte).toEqual(new Date(toIso));
    const roomWhere = prisma.roomingAssignment.count.mock.calls[0][0].where;
    expect(roomWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(roomWhere.createdAt.lte).toEqual(new Date(toIso));
  });

  test('NO audit row written (verify auditLog.create not called)', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 10, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { tripId: 10, status: 'paid', paidAmount: 250 },
    ]);
    prisma.roomingAssignment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Read-only meta surface — no audit row written. Matches /suppliers/stats
    // posture.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('USER role → 200 (anodyne aggregate; matches sibling /stats endpoints)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: null,
    });
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([]);
    prisma.roomingAssignment.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalTrips).toBe(0); // 1 trip but no billing rows
  });

  test('totalTrips: only trips with at least one billing row count (rooming-only trip still counts via distinct query)', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([
      { id: 10 },
      { id: 11 },
      { id: 12 }, // no children at all — should NOT appear in totalTrips
    ]);
    prisma.tripPaymentPlan.findMany.mockResolvedValue([
      { tripId: 10, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([]);
    // trip 11 has only rooming; trip 12 has nothing
    prisma.roomingAssignment.count.mockResolvedValue(2);
    prisma.roomingAssignment.findMany.mockResolvedValue([
      { tripId: 11 },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Trips 10 (plan) + 11 (rooming) = 2; trip 12 has no billing → excluded.
    expect(res.body.totalTrips).toBe(2);
    expect(res.body.totalRoomingAssignments).toBe(2);
  });
});
