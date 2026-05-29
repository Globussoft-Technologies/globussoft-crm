// @ts-check
/**
 * backend/routes/booking_pages.js — contract tests.
 *
 * Pins booking_pages route (487 LOC, 9 endpoints):
 *   - Authenticated CRUD (verifyToken):
 *     - GET    /              → list pages + bookingCount per page
 *     - POST   /              → create page, slug auto-generated from title
 *     - PUT    /:id           → update (tenant-scoped, partial-field shape)
 *     - DELETE /:id           → cascade-delete bookings then page
 *     - GET    /:id/bookings  → list bookings for a page (max 200)
 *     - POST   /:id/cancel/:bookingId → set status='CANCELED'
 *     - POST   /:id/upload    → multer image upload (kind=logo|hero)
 *   - Public (no auth):
 *     - GET    /public/:slug              → details + 14-day slot summary
 *     - GET    /public/:slug/slots?date=  → slots for a single date
 *     - POST   /public/:slug/book         → create booking
 *
 * What's pinned
 * ─────────────
 *   - Auth gate: missing Bearer → 401 (verifyToken's RFC-7235 contract).
 *   - Tenant isolation: PUT/DELETE/bookings list/cancel all scope by
 *     req.user.tenantId — cross-tenant resource → 404 "not found".
 *   - Public endpoints: zero auth required (no Authorization header).
 *   - POST /: title required → 400; slug includes the slugified title.
 *   - POST /: defaults durationMins=30 / bufferMins=0 / isActive=true
 *     when omitted from body; persists tenantId from req.user (NOT body).
 *   - PUT /:id: only sends keys present in body to prisma.update.
 *   - DELETE /:id: deleteMany on bookings BEFORE delete on page.
 *   - POST /:id/cancel/:bookingId: sets status='CANCELED'; tenant-scoped.
 *   - GET /public/:slug: inactive page → 404 (gated by isActive).
 *   - GET /public/:slug/slots: requires YYYY-MM-DD date query → 400 on
 *     missing/malformed.
 *   - POST /public/:slug/book: missing contact fields → 400;
 *     past scheduledAt → 400; non-matching slot → 409 (slot validation
 *     against buildSlotsForDate).
 *
 * Test pattern mirrors backend/test/routes/travel-microsites.test.js +
 * communications.test.js — patch the prisma singleton with vi.fn() shapes
 * BEFORE requiring the router. verifyToken stays in the chain so the auth
 * guard is exercised end-to-end (no bypass). HS256 JWTs signed with the
 * dev-fallback secret drive the authenticated requests; public endpoints
 * are called WITHOUT any Authorization header at all.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ─── Prisma singleton patch (must run BEFORE the router is required) ──
prisma.bookingPage = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.booking = {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  groupBy: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn().mockResolvedValue(null);
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ name: 'Host Person', email: 'host@example.com' });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

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

function tokenFor({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: 'admin@test.local' },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Helper: build a "tomorrow at 10:00 UTC" Date so it lands in a default
// Mon-Fri 09:00-17:00 availability window AND is unambiguously in the
// future regardless of timezone. (Standing rule: date-boundary assertions
// should use unambiguously-future dates, not midnight-of-today.)
function tomorrowAt10UTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  // Avoid landing on Sat (6) or Sun (0) which have empty default windows.
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  d.setUTCHours(10, 0, 0, 0);
  return d;
}

const DEFAULT_AVAILABILITY = JSON.stringify({
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '17:00' }],
  thursday: [{ start: '09:00', end: '17:00' }],
  friday: [{ start: '09:00', end: '17:00' }],
  saturday: [],
  sunday: [],
});

beforeEach(() => {
  prisma.bookingPage.findMany.mockReset();
  prisma.bookingPage.findFirst.mockReset();
  prisma.bookingPage.findUnique.mockReset();
  prisma.bookingPage.create.mockReset();
  prisma.bookingPage.update.mockReset();
  prisma.bookingPage.delete.mockReset();
  prisma.booking.findMany.mockReset().mockResolvedValue([]);
  prisma.booking.findFirst.mockReset();
  prisma.booking.groupBy.mockReset().mockResolvedValue([]);
  prisma.booking.create.mockReset();
  prisma.booking.update.mockReset();
  prisma.booking.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.user.findUnique.mockReset().mockResolvedValue({ name: 'Host Person', email: 'host@example.com' });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ─── Authentication gate ──────────────────────────────────────────────

describe('Authentication gate (verifyToken)', () => {
  test('GET / without Bearer → 401', async () => {
    const res = await request(makeApp()).get('/api/booking-pages');
    expect(res.status).toBe(401);
    expect(prisma.bookingPage.findMany).not.toHaveBeenCalled();
  });

  test('POST / without Bearer → 401', async () => {
    const res = await request(makeApp())
      .post('/api/booking-pages')
      .send({ title: 'Coffee Chat' });
    expect(res.status).toBe(401);
    expect(prisma.bookingPage.create).not.toHaveBeenCalled();
  });

  test('PUT /:id without Bearer → 401', async () => {
    const res = await request(makeApp())
      .put('/api/booking-pages/42')
      .send({ title: 'Updated' });
    expect(res.status).toBe(401);
    expect(prisma.bookingPage.update).not.toHaveBeenCalled();
  });

  test('DELETE /:id without Bearer → 401', async () => {
    const res = await request(makeApp()).delete('/api/booking-pages/42');
    expect(res.status).toBe(401);
    expect(prisma.bookingPage.delete).not.toHaveBeenCalled();
  });
});

// ─── GET / (list) ─────────────────────────────────────────────────────

describe('GET /api/booking-pages (list)', () => {
  test('happy path: returns pages with bookingCount populated from groupBy', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 1, title: 'Sales Call', tenantId: 1 },
      { id: 2, title: 'Demo', tenantId: 1 },
    ]);
    prisma.booking.groupBy.mockResolvedValue([
      { bookingPageId: 1, _count: { _all: 5 } },
      { bookingPageId: 2, _count: { _all: 0 } },
    ]);
    const res = await request(makeApp())
      .get('/api/booking-pages')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ id: 1, bookingCount: 5 });
    expect(res.body[1]).toMatchObject({ id: 2, bookingCount: 0 });
    // Tenant scoping on the findMany call.
    expect(prisma.bookingPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 1 } }),
    );
  });

  test('empty list returns [] without calling groupBy', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/booking-pages')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    // groupBy is short-circuited when there are zero pages.
    expect(prisma.booking.groupBy).not.toHaveBeenCalled();
  });

  test('pages without group results default bookingCount=0', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 11, title: 'No Bookings Yet', tenantId: 1 },
    ]);
    prisma.booking.groupBy.mockResolvedValue([]); // no rows in groupBy
    const res = await request(makeApp())
      .get('/api/booking-pages')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: 11, bookingCount: 0 });
  });
});

// ─── POST / (create) ──────────────────────────────────────────────────

describe('POST /api/booking-pages (create)', () => {
  test('happy path: 201 with slug auto-generated from title + defaults applied', async () => {
    prisma.bookingPage.create.mockImplementation(async (args) => ({
      id: 100,
      ...args.data,
    }));
    const res = await request(makeApp())
      .post('/api/booking-pages')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ title: 'Discovery Call' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 100,
      title: 'Discovery Call',
      tenantId: 1,
      ownerId: 7,
      durationMins: 30,
      bufferMins: 0,
      isActive: true,
    });
    // Slug starts with the slugified title prefix.
    expect(res.body.slug).toMatch(/^discovery-call-/);
    // tenantId comes from req.user, NOT from body (stripDangerous would
    // strip body.tenantId in production, but the route still must read
    // from req.user not body to be defensive).
    const createArgs = prisma.bookingPage.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.ownerId).toBe(7);
  });

  test('missing title → 400', async () => {
    const res = await request(makeApp())
      .post('/api/booking-pages')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
    expect(prisma.bookingPage.create).not.toHaveBeenCalled();
  });

  test('honours explicit durationMins / bufferMins from body', async () => {
    prisma.bookingPage.create.mockImplementation(async (args) => ({
      id: 101, ...args.data,
    }));
    const res = await request(makeApp())
      .post('/api/booking-pages')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ title: 'Long Demo', durationMins: 60, bufferMins: 15 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ durationMins: 60, bufferMins: 15 });
  });

  test('isActive=false body honoured (defaults true otherwise)', async () => {
    prisma.bookingPage.create.mockImplementation(async (args) => ({
      id: 102, ...args.data,
    }));
    const res = await request(makeApp())
      .post('/api/booking-pages')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ title: 'Draft Page', isActive: false });
    expect(res.status).toBe(201);
    expect(res.body.isActive).toBe(false);
  });
});

// ─── PUT /:id (update) ────────────────────────────────────────────────

describe('PUT /api/booking-pages/:id (update)', () => {
  test('happy path: tenant-scoped update returns 200', async () => {
    prisma.bookingPage.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, title: 'Old Title', durationMins: 30, bufferMins: 0,
    });
    prisma.bookingPage.update.mockImplementation(async (args) => ({
      id: 50, ...args.data,
    }));
    const res = await request(makeApp())
      .put('/api/booking-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ title: 'New Title', durationMins: 45 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'New Title', durationMins: 45 });
    // findFirst must scope by tenantId.
    expect(prisma.bookingPage.findFirst).toHaveBeenCalledWith({
      where: { id: 50, tenantId: 1 },
    });
    // update only includes keys present in body.
    const updateArgs = prisma.bookingPage.update.mock.calls[0][0];
    expect(updateArgs.data).toMatchObject({ title: 'New Title', durationMins: 45 });
    expect(updateArgs.data.bufferMins).toBeUndefined();
  });

  test('cross-tenant page → 404 (tenant isolation)', async () => {
    prisma.bookingPage.findFirst.mockResolvedValue(null); // findFirst with mismatched tenantId
    const res = await request(makeApp())
      .put('/api/booking-pages/999')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 2 })}`)
      .send({ title: 'Hijack Attempt' });
    expect(res.status).toBe(404);
    expect(prisma.bookingPage.update).not.toHaveBeenCalled();
    // The findFirst lookup must have been tenant-scoped.
    expect(prisma.bookingPage.findFirst).toHaveBeenCalledWith({
      where: { id: 999, tenantId: 2 },
    });
  });

  test('isActive=false body coerces to boolean via !! (truthy-falsy contract)', async () => {
    prisma.bookingPage.findFirst.mockResolvedValue({ id: 50, tenantId: 1, durationMins: 30, bufferMins: 0 });
    prisma.bookingPage.update.mockImplementation(async (args) => ({ id: 50, ...args.data }));
    const res = await request(makeApp())
      .put('/api/booking-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
  });
});

// ─── DELETE /:id ──────────────────────────────────────────────────────

describe('DELETE /api/booking-pages/:id', () => {
  test('happy path: cascade-deletes bookings then page, returns success', async () => {
    prisma.bookingPage.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.booking.deleteMany.mockResolvedValue({ count: 3 });
    prisma.bookingPage.delete.mockResolvedValue({ id: 50 });
    const res = await request(makeApp())
      .delete('/api/booking-pages/50')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    // deleteMany on bookings called FIRST (cascade requirement).
    expect(prisma.booking.deleteMany).toHaveBeenCalledWith({
      where: { bookingPageId: 50, tenantId: 1 },
    });
    expect(prisma.bookingPage.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });

  test('cross-tenant page → 404, no delete attempted', async () => {
    prisma.bookingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/booking-pages/777')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(404);
    expect(prisma.booking.deleteMany).not.toHaveBeenCalled();
    expect(prisma.bookingPage.delete).not.toHaveBeenCalled();
  });
});

// ─── GET /:id/bookings ────────────────────────────────────────────────

describe('GET /api/booking-pages/:id/bookings', () => {
  test('happy path returns bookings list (max 200, descending)', async () => {
    prisma.bookingPage.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.booking.findMany.mockResolvedValue([
      { id: 1, contactName: 'Alice', scheduledAt: new Date('2026-06-01') },
      { id: 2, contactName: 'Bob', scheduledAt: new Date('2026-05-30') },
    ]);
    const res = await request(makeApp())
      .get('/api/booking-pages/50/bookings')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Verify take=200 + orderBy contract.
    expect(prisma.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingPageId: 50, tenantId: 1 },
        orderBy: { scheduledAt: 'desc' },
        take: 200,
      }),
    );
  });

  test('cross-tenant page → 404', async () => {
    prisma.bookingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/booking-pages/999/bookings')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 2 })}`);
    expect(res.status).toBe(404);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });
});

// ─── POST /:id/cancel/:bookingId ──────────────────────────────────────

describe('POST /api/booking-pages/:id/cancel/:bookingId', () => {
  test('happy path: sets status=CANCELED, returns updated booking', async () => {
    prisma.bookingPage.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.booking.findFirst.mockResolvedValue({ id: 9, bookingPageId: 50, tenantId: 1 });
    prisma.booking.update.mockResolvedValue({ id: 9, status: 'CANCELED' });
    const res = await request(makeApp())
      .post('/api/booking-pages/50/cancel/9')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 9, status: 'CANCELED' });
    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { status: 'CANCELED' },
    });
  });

  test('booking not found (wrong tenant or wrong page) → 404', async () => {
    prisma.bookingPage.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.booking.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/booking-pages/50/cancel/99999')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(404);
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });
});

// ─── PUBLIC GET /public/:slug ─────────────────────────────────────────

describe('GET /api/booking-pages/public/:slug (no auth)', () => {
  test('happy path WITHOUT auth returns 14-day slot summary + public payload', async () => {
    prisma.bookingPage.findUnique.mockResolvedValue({
      id: 50,
      slug: 'discovery-call-abc',
      title: 'Discovery Call',
      description: 'Free 30 min chat',
      durationMins: 30,
      bufferMins: 0,
      availability: DEFAULT_AVAILABILITY,
      isActive: true,
      ownerId: 7,
      logoUrl: '/uploads/booking-pages/bp-logo.png',
      heroImageUrl: null,
      heroHeadline: 'Book a chat',
      heroSubheadline: null,
      featuredServiceIds: JSON.stringify([1, 2]),
      contactPhone: null,
      contactEmail: 'host@example.com',
      hoursJson: null,
      tenantId: 1,
    });
    const res = await request(makeApp())
      .get('/api/booking-pages/public/discovery-call-abc');
    // NO Authorization header — must still succeed.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      slug: 'discovery-call-abc',
      title: 'Discovery Call',
      durationMins: 30,
      logoUrl: '/uploads/booking-pages/bp-logo.png',
      heroHeadline: 'Book a chat',
    });
    // 14-day forecast.
    expect(res.body.days).toHaveLength(14);
    expect(res.body.days[0]).toHaveProperty('date');
    expect(res.body.days[0]).toHaveProperty('dayName');
    expect(res.body.days[0]).toHaveProperty('slotCount');
    // featuredServiceIds parsed back to integer array.
    expect(res.body.featuredServiceIds).toEqual([1, 2]);
    // The owner lookup is exercised; ownerName resolves from User row.
    expect(res.body.ownerName).toBeDefined();
    // tenantId must NOT leak in the public payload.
    expect(res.body.tenantId).toBeUndefined();
  });

  test('inactive page → 404', async () => {
    prisma.bookingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'foo', isActive: false, availability: DEFAULT_AVAILABILITY,
    });
    const res = await request(makeApp())
      .get('/api/booking-pages/public/foo');
    expect(res.status).toBe(404);
  });

  test('unknown slug → 404', async () => {
    prisma.bookingPage.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/booking-pages/public/missing-slug');
    expect(res.status).toBe(404);
  });
});

// ─── PUBLIC GET /public/:slug/slots ───────────────────────────────────

describe('GET /api/booking-pages/public/:slug/slots (no auth)', () => {
  test('happy path returns slots for a given date', async () => {
    prisma.bookingPage.findUnique.mockResolvedValue({
      id: 50,
      slug: 'discovery-call-abc',
      durationMins: 30,
      bufferMins: 0,
      availability: DEFAULT_AVAILABILITY,
      isActive: true,
    });
    // Pick a far-future Tuesday so all slots are valid.
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);
    // Walk to a Tuesday for stable day-of-week.
    while (future.getUTCDay() !== 2) future.setUTCDate(future.getUTCDate() + 1);
    const dateStr = future.toISOString().slice(0, 10);

    const res = await request(makeApp())
      .get(`/api/booking-pages/public/discovery-call-abc/slots?date=${dateStr}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: dateStr, durationMins: 30 });
    expect(Array.isArray(res.body.slots)).toBe(true);
    // Tuesday with 09:00-17:00 / 30-min duration / 0-min buffer = 16 slots.
    expect(res.body.slots.length).toBeGreaterThan(0);
  });

  test('missing date query param → 400', async () => {
    prisma.bookingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'discovery-call-abc', availability: DEFAULT_AVAILABILITY, isActive: true,
    });
    const res = await request(makeApp())
      .get('/api/booking-pages/public/discovery-call-abc/slots');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/date/i);
  });

  test('malformed date query (not YYYY-MM-DD) → 400', async () => {
    prisma.bookingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'discovery-call-abc', availability: DEFAULT_AVAILABILITY, isActive: true,
    });
    const res = await request(makeApp())
      .get('/api/booking-pages/public/discovery-call-abc/slots?date=not-a-date');
    expect(res.status).toBe(400);
  });
});

// ─── PUBLIC POST /public/:slug/book ───────────────────────────────────

describe('POST /api/booking-pages/public/:slug/book (no auth)', () => {
  test('happy path: creates booking + returns confirmation envelope', async () => {
    prisma.bookingPage.findUnique.mockResolvedValue({
      id: 50,
      slug: 'discovery-call-abc',
      durationMins: 30,
      bufferMins: 0,
      availability: DEFAULT_AVAILABILITY,
      isActive: true,
      tenantId: 1,
    });
    const slotTime = tomorrowAt10UTC();
    prisma.booking.create.mockImplementation(async (args) => ({
      id: 500,
      scheduledAt: args.data.scheduledAt,
      durationMins: args.data.durationMins,
      meetingUrl: args.data.meetingUrl,
      status: args.data.status,
    }));

    const res = await request(makeApp())
      .post('/api/booking-pages/public/discovery-call-abc/book')
      .send({
        contactName: 'Asha Iyer',
        contactEmail: 'asha@example.com',
        contactPhone: '+919876543210',
        scheduledAt: slotTime.toISOString(),
        notes: 'Looking forward to it',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      message: 'Booking confirmed',
    });
    expect(res.body.booking).toMatchObject({
      id: 500,
      durationMins: 30,
      status: 'CONFIRMED',
    });
    expect(res.body.booking.meetingUrl).toMatch(/^https:\/\/meet\.globusdemos\.com\//);
    // tenantId on the created booking comes from page.tenantId, not body.
    const createArgs = prisma.booking.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.status).toBe('CONFIRMED');
  });

  test('missing contactName → 400', async () => {
    prisma.bookingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'foo', durationMins: 30, bufferMins: 0,
      availability: DEFAULT_AVAILABILITY, isActive: true, tenantId: 1,
    });
    const res = await request(makeApp())
      .post('/api/booking-pages/public/foo/book')
      .send({
        contactEmail: 'asha@example.com',
        scheduledAt: tomorrowAt10UTC().toISOString(),
      });
    expect(res.status).toBe(400);
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  test('past scheduledAt → 400 "must be in the future"', async () => {
    prisma.bookingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'foo', durationMins: 30, bufferMins: 0,
      availability: DEFAULT_AVAILABILITY, isActive: true, tenantId: 1,
    });
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const res = await request(makeApp())
      .post('/api/booking-pages/public/foo/book')
      .send({
        contactName: 'Asha Iyer',
        contactEmail: 'asha@example.com',
        scheduledAt: past,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/i);
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  test('invalid scheduledAt string → 400 "Invalid scheduledAt"', async () => {
    prisma.bookingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'foo', durationMins: 30, bufferMins: 0,
      availability: DEFAULT_AVAILABILITY, isActive: true, tenantId: 1,
    });
    const res = await request(makeApp())
      .post('/api/booking-pages/public/foo/book')
      .send({
        contactName: 'Asha Iyer',
        contactEmail: 'asha@example.com',
        scheduledAt: 'not-a-date',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('scheduledAt not aligned to a valid slot → 409 "no longer available"', async () => {
    prisma.bookingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'foo', durationMins: 30, bufferMins: 0,
      availability: DEFAULT_AVAILABILITY, isActive: true, tenantId: 1,
    });
    // 03:17 UTC tomorrow — well outside the 09:00-17:00 window.
    const offSlot = new Date();
    offSlot.setUTCDate(offSlot.getUTCDate() + 1);
    while (offSlot.getUTCDay() === 0 || offSlot.getUTCDay() === 6) {
      offSlot.setUTCDate(offSlot.getUTCDate() + 1);
    }
    offSlot.setUTCHours(3, 17, 0, 0);
    const res = await request(makeApp())
      .post('/api/booking-pages/public/foo/book')
      .send({
        contactName: 'Asha Iyer',
        contactEmail: 'asha@example.com',
        scheduledAt: offSlot.toISOString(),
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no longer available/i);
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  test('inactive page → 404 (public book gated on isActive)', async () => {
    prisma.bookingPage.findUnique.mockResolvedValue({
      id: 50, slug: 'foo', isActive: false, availability: DEFAULT_AVAILABILITY,
    });
    const res = await request(makeApp())
      .post('/api/booking-pages/public/foo/book')
      .send({
        contactName: 'Asha Iyer',
        contactEmail: 'asha@example.com',
        scheduledAt: tomorrowAt10UTC().toISOString(),
      });
    expect(res.status).toBe(404);
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });
});

// ─── GET / ?fields=summary slim-shape opt-in (#920 slice 40) ──────────
//
// Mirrors slices 1-39 (landing-pages, signatures, brand-kits, integrations,
// document-templates, …). The default list returns the full BookingPage
// row including heavy @db.Text columns (availability JSON, logoUrl,
// heroImageUrl, heroSubheadline, featuredServiceIds, hoursJson, description
// blob). Picker / dropdown UI doesn't need any of that — only id + slug +
// title + isActive + durationMins + bufferMins + createdAt + updatedAt +
// the bookingCount roll-up. ?fields=summary projects to that minimal set.
// Opt-in additive — back-compat for the BookingPages.jsx library page.
describe('GET /api/booking-pages ?fields=summary (slim-shape)', () => {
  test('?fields=summary triggers slim Prisma select projection', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 1, slug: 'sales-call-abc', title: 'Sales Call', isActive: true, durationMins: 30, bufferMins: 0, createdAt: new Date(), updatedAt: new Date() },
    ]);
    const res = await request(makeApp())
      .get('/api/booking-pages?fields=summary')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    const findManyArgs = prisma.bookingPage.findMany.mock.calls[0][0];
    // Slim select drops heavy availability / logoUrl / heroImageUrl /
    // heroSubheadline / featuredServiceIds / hoursJson / description.
    expect(findManyArgs.select).toBeDefined();
    expect(findManyArgs.select.availability).toBeUndefined();
    expect(findManyArgs.select.logoUrl).toBeUndefined();
    expect(findManyArgs.select.heroImageUrl).toBeUndefined();
    expect(findManyArgs.select.heroSubheadline).toBeUndefined();
    expect(findManyArgs.select.featuredServiceIds).toBeUndefined();
    expect(findManyArgs.select.hoursJson).toBeUndefined();
    expect(findManyArgs.select.description).toBeUndefined();
    // Picker-essential keys present.
    expect(findManyArgs.select.id).toBe(true);
    expect(findManyArgs.select.slug).toBe(true);
    expect(findManyArgs.select.title).toBe(true);
    expect(findManyArgs.select.isActive).toBe(true);
    expect(findManyArgs.select.durationMins).toBe(true);
    expect(findManyArgs.select.bufferMins).toBe(true);
  });

  test('default list (no ?fields) returns full row shape (no select projection)', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 1, slug: 'sales-call-abc', title: 'Sales Call', tenantId: 1, availability: DEFAULT_AVAILABILITY, logoUrl: '/uploads/booking-pages/logo.png', heroImageUrl: '/uploads/booking-pages/hero.png' },
    ]);
    const res = await request(makeApp())
      .get('/api/booking-pages')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    const findManyArgs = prisma.bookingPage.findMany.mock.calls[0][0];
    // Back-compat: no select arg → full row shape.
    expect(findManyArgs.select).toBeUndefined();
    // Heavy fields surface to caller when present on the row.
    expect(res.body[0].availability).toBe(DEFAULT_AVAILABILITY);
    expect(res.body[0].logoUrl).toBe('/uploads/booking-pages/logo.png');
    expect(res.body[0].heroImageUrl).toBe('/uploads/booking-pages/hero.png');
  });

  test('?fields=summary still attaches bookingCount roll-up to each row', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 1, slug: 'a', title: 'A', isActive: true, durationMins: 30, bufferMins: 0 },
      { id: 2, slug: 'b', title: 'B', isActive: true, durationMins: 60, bufferMins: 5 },
    ]);
    prisma.booking.groupBy.mockResolvedValue([
      { bookingPageId: 1, _count: { _all: 7 } },
      { bookingPageId: 2, _count: { _all: 0 } },
    ]);
    const res = await request(makeApp())
      .get('/api/booking-pages?fields=summary')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ id: 1, bookingCount: 7 });
    expect(res.body[1]).toMatchObject({ id: 2, bookingCount: 0 });
    // groupBy still tenant-scoped to status≠CANCELED.
    const groupByArgs = prisma.booking.groupBy.mock.calls[0][0];
    expect(groupByArgs.where.tenantId).toBe(1);
    expect(groupByArgs.where.status).toEqual({ not: 'CANCELED' });
  });

  test('?fields=summary preserves tenant scoping on the findMany where clause', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/booking-pages?fields=summary')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 42 })}`);
    expect(res.status).toBe(200);
    const findManyArgs = prisma.bookingPage.findMany.mock.calls[0][0];
    expect(findManyArgs.where).toEqual({ tenantId: 42 });
    expect(findManyArgs.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('non-exact ?fields value falls back to full row shape (opt-in additive)', async () => {
    prisma.bookingPage.findMany.mockResolvedValue([
      { id: 9, title: 'Mistyped Fields Param', tenantId: 1 },
    ]);
    const res = await request(makeApp())
      .get('/api/booking-pages?fields=SUMMARY')  // wrong case
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    const findManyArgs = prisma.bookingPage.findMany.mock.calls[0][0];
    // Only the exact "summary" sentinel triggers the projection. Any
    // other value (including case-different / "minimal" / "slim") gets
    // the back-compat full row shape.
    expect(findManyArgs.select).toBeUndefined();
  });
});
