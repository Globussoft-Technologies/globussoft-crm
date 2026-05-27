// @ts-check
/**
 * Arc 2 Travel Gap (TMC trip billing) — GET /api/travel/trip-billing/by-month
 * tenant-wide TMC instalment monthly rollup.
 *
 * Sibling to /trip-billing/stats — the single-point-in-time KPI tile shipped
 * earlier in this route file (commit 833ef34a). /by-month is the per-month
 * time series across the same TmcTrip → TripInstalmentPayment population —
 * powers the trip-billing dashboard's trend chart.
 *
 * Mirrors the canonical /suppliers/by-month + /commission-profiles/by-month +
 * /quotes/by-month shape — UTC YYYY-MM bucketing, JS-side aggregation over a
 * light Prisma projection, defensive "unknown" bucket, pagination AFTER
 * aggregation + sort + filter, NO audit row written.
 *
 * What's pinned
 * -------------
 *   - Auth gate:           missing token → 401.
 *   - TMC sub-brand gate:  non-TMC MANAGER (subBrandAccess=['rfu']) → 403
 *                          SUB_BRAND_DENIED.
 *   - Format validation:   bad ?from / ?to (not YYYY-MM) → 400
 *                          INVALID_MONTH_FORMAT.
 *   - Empty tenant:        zeroed envelope { total: 0, rows: [] }.
 *   - Happy path:          3 instalments across 2 months → 2 month rows
 *                          with correct byStatus + totalReceived + count.
 *   - Default order:       orderBy=month:asc renders rows chronologically.
 *   - Order flip:          ?orderBy=count:desc flips ordering by count.
 *   - Window filter:       ?from/?to narrows the bucket array.
 *   - "unknown" bucket:    null createdAt rows land in "unknown" bucket
 *                          (included when no window; excluded when window
 *                          is set).
 *   - Pagination:          ?limit/?offset slices AFTER aggregation.
 *   - NO audit row:        read-only meta surface (auditLog.create not
 *                          called).
 *
 * Drift call-out
 * --------------
 * The Arc 2 prompt's response specced status keys as DRAFT/PARTIAL/PAID/OVERDUE
 * (uppercase). Verified the schema (prisma/schema.prisma:4594 — TripInstalmentPayment.status
 * default "pending", comment "pending | partial | paid | overdue") + the
 * existing /stats handler at the top of routes/travel_trip_billing.js (uses
 * VALID_INSTALMENT_STATUSES = ["pending", "partial", "paid", "overdue"]). The
 * SPEC pins reality (lowercase) — uppercase would be a contract divergence
 * vs. the schema + the sibling /stats endpoint.
 *
 * Test pattern mirrors backend/test/routes/travel-trip-billing-stats.test.js —
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * drive supertest with HS256 JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.tmcTrip = prisma.tmcTrip || {};
prisma.tmcTrip.findMany = vi.fn();
prisma.tmcTrip.findFirst = vi.fn();
prisma.tripInstalmentPayment = prisma.tripInstalmentPayment || {};
prisma.tripInstalmentPayment.findMany = vi.fn();
// /stats handler also needs these — make sure they exist as no-op stubs so
// the module loads cleanly even though /by-month doesn't call them.
prisma.tripPaymentPlan = prisma.tripPaymentPlan || {};
prisma.tripPaymentPlan.findMany = prisma.tripPaymentPlan.findMany || vi.fn();
prisma.roomingAssignment = prisma.roomingAssignment || {};
prisma.roomingAssignment.count = prisma.roomingAssignment.count || vi.fn();
prisma.roomingAssignment.findMany = prisma.roomingAssignment.findMany || vi.fn();
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
  prisma.tripInstalmentPayment.findMany.mockReset();
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

describe('GET /api/travel/trip-billing/by-month', () => {
  test('auth gate: missing Authorization header → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/travel/trip-billing/by-month');
    expect(res.status).toBe(401);
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
  });

  test('TMC sub-brand gate: non-TMC MANAGER (subBrandAccess=["rfu"]) → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
    // requireTmcAccess fires BEFORE any aggregation runs — verify no
    // child-table reads happened.
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
    expect(prisma.tripInstalmentPayment.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT on bad ?from (e.g. month 13)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.tmcTrip.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT on bad ?to (no dash)', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month?to=20260501')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('empty tenant: 0 trips → { total: 0, rows: [] }', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, rows: [] });
    // No children fetched on empty short-circuit.
    expect(prisma.tripInstalmentPayment.findMany).not.toHaveBeenCalled();
  });

  test('happy path: 3 instalments across 2 months → 2 month rows with byStatus + totalReceived correct', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      // 2026-04: 1 paid (250), 1 pending (0)
      { status: 'paid', paidAmount: 250, createdAt: new Date('2026-04-15T10:00:00Z') },
      { status: 'pending', paidAmount: 0, createdAt: new Date('2026-04-20T10:00:00Z') },
      // 2026-05: 1 partial (100)
      { status: 'partial', paidAmount: 100, createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);

    const april = res.body.rows.find((r) => r.month === '2026-04');
    expect(april).toBeDefined();
    expect(april.count).toBe(2);
    expect(april.byStatus).toEqual({ pending: 1, partial: 0, paid: 1, overdue: 0 });
    expect(april.totalReceived).toBe(250);

    const may = res.body.rows.find((r) => r.month === '2026-05');
    expect(may).toBeDefined();
    expect(may.count).toBe(1);
    expect(may.byStatus).toEqual({ pending: 0, partial: 1, paid: 0, overdue: 0 });
    expect(may.totalReceived).toBe(100);
  });

  test('default orderBy=month:asc renders rows chronologically', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { status: 'paid', paidAmount: 50, createdAt: new Date('2026-06-10T10:00:00Z') },
      { status: 'paid', paidAmount: 50, createdAt: new Date('2026-04-10T10:00:00Z') },
      { status: 'paid', paidAmount: 50, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-04', '2026-05', '2026-06']);
  });

  test('?orderBy=count:desc flips ordering by bucket count', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      // 2026-04: 3 rows (highest)
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-04-01T10:00:00Z') },
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-04-02T10:00:00Z') },
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-04-03T10:00:00Z') },
      // 2026-05: 1 row (lowest)
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-05-01T10:00:00Z') },
      // 2026-06: 2 rows
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-06-01T10:00:00Z') },
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-06-02T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-04', '2026-06', '2026-05']);
    expect(res.body.rows.map((r) => r.count)).toEqual([3, 2, 1]);
  });

  test('?from/?to narrows the bucket array (single-month window)', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-04-15T10:00:00Z') },
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-05-15T10:00:00Z') },
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-06-15T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month?from=2026-05&to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].month).toBe('2026-05');
  });

  test('null createdAt rows land in "unknown" bucket (included when no window set)', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { status: 'paid', paidAmount: 100, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'pending', paidAmount: 0, createdAt: null },
      { status: 'pending', paidAmount: 0, createdAt: null },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const unknown = res.body.rows.find((r) => r.month === 'unknown');
    expect(unknown).toBeDefined();
    expect(unknown.count).toBe(2);
    expect(unknown.byStatus).toEqual({ pending: 2, partial: 0, paid: 0, overdue: 0 });
  });

  test('"unknown" bucket is excluded when ?from/?to window is set', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'pending', paidAmount: 0, createdAt: null },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month?from=2026-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows.find((r) => r.month === 'unknown')).toBeUndefined();
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].month).toBe('2026-05');
  });

  test('?limit=2&offset=1 paginates AFTER aggregation', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-01-15T10:00:00Z') },
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-02-15T10:00:00Z') },
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-03-15T10:00:00Z') },
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-04-15T10:00:00Z') },
      { status: 'paid', paidAmount: 0, createdAt: new Date('2026-05-15T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Pre-pagination total reflects the FULL bucket count, not the slice.
    expect(res.body.total).toBe(5);
    expect(res.body.rows).toHaveLength(2);
    // month:asc default → 5 buckets [Jan..May]; offset=1, limit=2 → [Feb, Mar].
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-02', '2026-03']);
  });

  test('totalReceived: paidAmount with decimals → half-up rounded to 2dp per bucket', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      // 100.555 + 50.005 + 25.001 = 175.561 → 175.56 (half-up to 2dp)
      { status: 'paid', paidAmount: 100.555, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'paid', paidAmount: 50.005, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'paid', paidAmount: 25.001, createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].totalReceived).toBe(175.56);
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 10 }]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { status: 'paid', paidAmount: 250, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('tenant scoping: tmcTrip.findMany was queried with the caller\'s tenantId first', async () => {
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 42 }]);
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/trip-billing/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const tripWhere = prisma.tmcTrip.findMany.mock.calls[0][0].where;
    expect(tripWhere.tenantId).toBe(1);
    // Children scoped to the returned trip-id set — no tenantId on
    // TripInstalmentPayment.
    const insWhere = prisma.tripInstalmentPayment.findMany.mock.calls[0][0].where;
    expect(insWhere.tripId).toEqual({ in: [42] });
  });
});
