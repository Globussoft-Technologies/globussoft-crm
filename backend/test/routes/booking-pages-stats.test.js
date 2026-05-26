// @ts-check
/**
 * Booking polish — pin GET /api/booking-pages/stats contract.
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: missing Authorization header → 401.
 *   - 400 INVALID_DATE on bad ?from / ?to (independent validation).
 *   - Empty-tenant: zeroed envelope + byVertical={} + lastCreatedAt=null,
 *     totalBookings=0.
 *   - Happy path: 4 pages (3 active, 1 inactive) + 5 bookings (1 CANCELED)
 *     → totalPages=4, activeCount=3, totalBookings=4, lastCreatedAt=newest.
 *   - byVertical: surfaces the tenant's vertical as a single-key map.
 *   - Tenant isolation: prisma where.tenantId comes from req.user.tenantId
 *     for BOTH bookingPage.findMany AND booking.count.
 *   - ?from/?to narrows the BookingPage window via createdAt clauses.
 *   - Booking count excludes CANCELED rows (status: { not: 'CANCELED' }).
 *   - NO audit row written (auditLog.create not called).
 *   - Tenant lookup falls back gracefully when tenant row is missing
 *     (defensive: byVertical[_unknown] populated, no 500).
 *   - Literal path /stats does NOT resolve to /:id family — fast-path before
 *     PUT /:id / DELETE /:id / GET /:id/bookings.
 *
 * Schema notes (verified against prisma/schema.prisma → models BookingPage
 * and Booking, lines 2261-2317)
 * ---------------------------------------------------------------------
 *   - BookingPage has: id, slug, title, description, ownerId, durationMins,
 *     bufferMins, availability, isActive, logoUrl?, heroImageUrl?,
 *     heroHeadline?, heroSubheadline?, featuredServiceIds?, contactPhone?,
 *     contactEmail?, hoursJson?, tenantId, createdAt, updatedAt.
 *     NO vertical column — vertical lives on Tenant (joined via tenantId).
 *   - Booking has: id, bookingPageId, contactName, contactEmail,
 *     contactPhone?, scheduledAt, durationMins, meetingUrl?, notes?,
 *     status (default CONFIRMED, values: CONFIRMED, CANCELED, COMPLETED),
 *     contactId?, tripId?, itineraryId?, tenantId, createdAt.
 *
 * Pattern reference: billing-stats.test.js — patches the prisma singleton
 * with vi.fn() BEFORE requiring the router, drives supertest with HS256
 * JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.bookingPage = prisma.bookingPage || {};
prisma.bookingPage.findMany = vi.fn();
prisma.booking = prisma.booking || {};
prisma.booking.count = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.fieldPermission = prisma.fieldPermission || {};
prisma.fieldPermission.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const bookingPagesRouter = requireCJS('../../routes/booking_pages');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/booking-pages', bookingPagesRouter);
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
  prisma.bookingPage.findMany.mockReset();
  prisma.booking.count.mockReset().mockResolvedValue(0);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'wellness' });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/booking-pages/stats', () => {
  test('auth gate: missing Authorization header → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/booking-pages/stats');
    expect(res.status).toBe(401);
    expect(prisma.bookingPage.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/booking-pages/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.bookingPage.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/booking-pages/stats?to=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.bookingPage.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope (totalPages=0, byVertical={}, lastCreatedAt=null)', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/booking-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalPages: 0,
      activeCount: 0,
      byVertical: {},
      totalBookings: 0,
      lastCreatedAt: null,
    });
    // Booking count is short-circuited when no pages exist.
    expect(prisma.booking.count).not.toHaveBeenCalled();
  });

  test('happy path: 4 pages (3 active, 1 inactive) → counts + lastCreatedAt correct', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 1, isActive: true, createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 2, isActive: true, createdAt: new Date('2026-05-10T10:00:00Z') },
      { id: 3, isActive: false, createdAt: new Date('2026-05-15T10:00:00Z') },
      { id: 4, isActive: true, createdAt: newest },
    ]);
    // 4 live bookings (CANCELED excluded by the prisma where clause).
    prisma.booking.count.mockResolvedValue(4);

    const app = makeApp();
    const res = await request(app)
      .get('/api/booking-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalPages).toBe(4);
    expect(res.body.activeCount).toBe(3);
    expect(res.body.totalBookings).toBe(4);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
    expect(res.body.byVertical).toEqual({ wellness: 4 });
  });

  test('byVertical: surfaces tenant.vertical as single-key map', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ vertical: 'travel' });
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 1, isActive: true, createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 2, isActive: true, createdAt: new Date('2026-05-02T10:00:00Z') },
    ]);
    prisma.booking.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/booking-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byVertical).toEqual({ travel: 2 });
  });

  test('byVertical: defensive fallback to _unknown when tenant row is missing', async () => {
    // Simulate the tenant lookup returning null (FK constraint should
    // prevent this in practice, but the response shape stays stable).
    prisma.tenant.findUnique.mockResolvedValue(null);
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 1, isActive: true, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);
    prisma.booking.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/booking-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byVertical).toEqual({ _unknown: 1 });
    expect(res.body.totalPages).toBe(1);
  });

  test('tenant isolation: where.tenantId comes from req.user.tenantId for BOTH queries', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 99, isActive: true, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);
    prisma.booking.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/booking-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);

    const pageWhere = prisma.bookingPage.findMany.mock.calls[0][0].where;
    expect(pageWhere.tenantId).toBe(42);

    const bookingWhere = prisma.booking.count.mock.calls[0][0].where;
    expect(bookingWhere.tenantId).toBe(42);

    // Tenant lookup also scoped to req.user.tenantId.
    const tenantWhere = prisma.tenant.findUnique.mock.calls[0][0].where;
    expect(tenantWhere.id).toBe(42);
  });

  test('?from/?to: narrows the BookingPage window via createdAt clauses', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([]);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/booking-pages/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.bookingPage.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.gte).toEqual(new Date(fromIso));
    expect(whereArg.createdAt.lte).toEqual(new Date(toIso));
  });

  test('booking count excludes CANCELED rows via status: { not: "CANCELED" }', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 1, isActive: true, createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 2, isActive: true, createdAt: new Date('2026-05-02T10:00:00Z') },
    ]);
    prisma.booking.count.mockResolvedValue(3);

    const app = makeApp();
    const res = await request(app)
      .get('/api/booking-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalBookings).toBe(3);

    const bookingWhere = prisma.booking.count.mock.calls[0][0].where;
    expect(bookingWhere.status).toEqual({ not: 'CANCELED' });
    // bookingPageId filter must scope to the page ids returned by findMany.
    expect(bookingWhere.bookingPageId).toEqual({ in: [1, 2] });
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 1, isActive: true, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);
    prisma.booking.count.mockResolvedValue(1);

    const app = makeApp();
    const res = await request(app)
      .get('/api/booking-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('literal path /stats does NOT resolve to /:id (express route ordering check)', async () => {
    // If /:id were declared before /stats, parseInt("stats") yields NaN
    // and the handler would short-circuit with 404 "Booking page not found"
    // via the findFirst -> null path. /stats reaching the stats handler
    // returns 200 with the zeroed envelope on empty tenant — proves the
    // route ordering is correct.
    prisma.bookingPage.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/booking-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalPages');
    expect(res.body).toHaveProperty('activeCount');
    expect(res.body).toHaveProperty('byVertical');
    expect(res.body).toHaveProperty('totalBookings');
    expect(res.body).toHaveProperty('lastCreatedAt');
  });

  test('lastCreatedAt: picks the most-recent createdAt across the page set', async () => {
    const newest = new Date('2026-05-25T10:00:00Z');
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 1, isActive: true, createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 2, isActive: true, createdAt: newest },
      { id: 3, isActive: false, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);
    prisma.booking.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/booking-pages/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });
});
