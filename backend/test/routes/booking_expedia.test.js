// @ts-check
/**
 * PRD_BOOKING_EXPEDIA_DIRECT — /api/booking-expedia operator-wrapper tests.
 *
 * Pins the contract for the thin wrapper added at backend/routes/booking_expedia.js,
 * which exposes services/bookingExpediaClient.js (stub-mode today, real post
 * Q-cluster B6/C cred handover) to UI consumers without touching the
 * service module.
 *
 * What's pinned
 * -------------
 *   - POST /search    provider='booking' happy path returns client envelope.
 *   - POST /search    provider='expedia' → 503 EXPEDIA_NOT_YET_ENABLED
 *                     (Phase 2 deferred-by-design per DC-4 — NOT a 400, since
 *                     the request is well-formed and the caller should retry
 *                     after the demand-threshold flips).
 *   - POST /search    provider='unknown' → 400 UNKNOWN_PROVIDER.
 *   - POST /search    client throws BOOKING_EXPEDIA_BUDGET_EXCEEDED → 402
 *                     + structured error body.
 *   - POST /book      ADMIN happy path returns the client envelope + writes
 *                     BookingExpediaBooking BOOK audit row.
 *   - POST /book      USER → 403 (ADMIN/MANAGER gate fires before client).
 *   - GET  /cap-status ADMIN — returns spent/cap/percent/withinCap/alert.
 *   - POST /search    API-key sub-brand mismatch (apiKeySubBrand='tmc' +
 *                     body subBrand='rfu') → 403 SUB_BRAND_MISMATCH.
 *
 * Test pattern mirrors backend/test/routes/ratehawk.test.js (commit be67789)
 * and backend/test/routes/callified.test.js (commit cdad62d) — patch the
 * bookingExpediaClient module exports with vi.fn() BEFORE requiring the
 * router via the SAME require() path so the router's closure sees our
 * mutations. verifyToken + verifyRole stay in the chain (we don't bypass
 * them) so the auth gate is exercised end-to-end.
 *
 * CJS-mock seam: see ratehawk.test.js precedent — vi.mock() can't reliably
 * intercept the SUT's `require()` of a CJS module under vitest with
 * `inline: [/backend\/services\//]`. Use `createRequire(import.meta.url)`
 * to mutate the SAME require-cache object the router reads. Direct vi.mock
 * would silently miss.
 *
 * Note vs simpler AdsGPT/RateHawk wrappers: BookingExpedia has THREE
 * structured error paths — BOOKING_EXPEDIA_BUDGET_EXCEEDED (402),
 * EXPEDIA_NOT_YET_ENABLED (503, Phase 2 deferred), and UNKNOWN_PROVIDER
 * (400). All three are explicit tests here.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Resolve bookingExpediaClient + router via the SAME require() path the
// route uses, so mutations to module.exports propagate to the router's
// closure.
const bookingExpediaClient = requireCJS('../../services/bookingExpediaClient');
bookingExpediaClient.searchHotels = vi.fn();
bookingExpediaClient.bookHotel = vi.fn();
bookingExpediaClient.cancelBooking = vi.fn();
bookingExpediaClient.checkBudgetCap = vi.fn();

// Prisma stubs for the auth-middleware path (verifyToken loads the user
// + checks revokedToken) and the audit-write path.
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  id: 7, role: 'ADMIN', tenantId: 1, isActive: true,
});
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};

const bookingExpediaRouter = requireCJS('../../routes/booking_expedia');

function makeApp({ apiKeySubBrand } = {}) {
  const app = express();
  app.use(express.json());
  // Optional pre-middleware to simulate externalAuth/voyagrAuth having
  // pinned req.apiKeySubBrand. Used by the SUB_BRAND_MISMATCH probe.
  if (apiKeySubBrand !== undefined) {
    app.use((req, _res, next) => {
      req.apiKeySubBrand = apiKeySubBrand;
      next();
    });
  }
  app.use('/api/booking-expedia', bookingExpediaRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeAll(() => {
  // No-op: stubs already installed above.
});

beforeEach(() => {
  bookingExpediaClient.searchHotels.mockReset();
  bookingExpediaClient.bookHotel.mockReset();
  bookingExpediaClient.cancelBooking.mockReset();
  bookingExpediaClient.checkBudgetCap.mockReset();
  prisma.user.findUnique.mockReset().mockResolvedValue({
    id: 7, role: 'ADMIN', tenantId: 1, isActive: true,
  });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/booking-expedia/search', () => {
  test("provider='booking' happy path returns the client envelope verbatim", async () => {
    const cannedEnvelope = {
      stub: true,
      tenantId: 1,
      provider: 'booking',
      query: {
        destinationCity: 'Mumbai',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
        guests: 2,
        rooms: 1,
      },
      hotels: [],
      note: 'Booking.com integration pending Q-cluster B6/C creds.',
    };
    bookingExpediaClient.searchHotels.mockResolvedValue(cannedEnvelope);

    const res = await request(makeApp())
      .post('/api/booking-expedia/search')
      .send({
        provider: 'booking',
        subBrand: 'rfu',
        destinationCity: 'Mumbai',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
        guests: 2,
        rooms: 1,
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stub: true, tenantId: 1, provider: 'booking' });
    // Tenant came from req.user.tenantId, not the body. Provider passed
    // through verbatim from the body.
    expect(bookingExpediaClient.searchHotels).toHaveBeenCalledWith({
      tenantId: 1,
      provider: 'booking',
      subBrand: 'rfu',
      destinationCity: 'Mumbai',
      checkInDate: '2026-06-01',
      checkOutDate: '2026-06-05',
      guests: 2,
      rooms: 1,
    });
    // Read-only — no audit row.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test("provider='expedia' → 503 EXPEDIA_NOT_YET_ENABLED (Phase 2 deferred)", async () => {
    // Client's assertProviderEnabled throws inside searchHotels for Phase 2.
    const err = new Error('expedia is Phase 2 (DC-4 deferred). Not yet enabled.');
    err.code = 'EXPEDIA_NOT_YET_ENABLED';
    bookingExpediaClient.searchHotels.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/booking-expedia/search')
      .send({
        provider: 'expedia',
        destinationCity: 'Mumbai',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    // 503 Service Unavailable — NOT 400. Phase-2 deferred-by-design: the
    // request is well-formed, but the upstream is intentionally not
    // enabled yet. Operators retry once DC-4 flips.
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'EXPEDIA_NOT_YET_ENABLED' });
    expect(res.body.error).toMatch(/phase 2|not yet enabled/i);
  });

  test("provider='unknown' → 400 UNKNOWN_PROVIDER", async () => {
    const err = new Error('Unknown provider: unknown. Allowed: booking, expedia');
    err.code = 'UNKNOWN_PROVIDER';
    bookingExpediaClient.searchHotels.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/booking-expedia/search')
      .send({
        provider: 'unknown',
        destinationCity: 'Mumbai',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'UNKNOWN_PROVIDER' });
  });

  test('client throws BOOKING_EXPEDIA_BUDGET_EXCEEDED → 402 with structured error', async () => {
    const err = new Error('Monthly Booking/Expedia hotel-inventory cap reached.');
    err.code = 'BOOKING_EXPEDIA_BUDGET_EXCEEDED';
    err.spentCents = 12000;
    err.capCents = 10000;
    bookingExpediaClient.searchHotels.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/booking-expedia/search')
      .send({
        destinationCity: 'Mumbai',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      code: 'BOOKING_EXPEDIA_BUDGET_EXCEEDED',
      spentCents: 12000,
      capCents: 10000,
    });
    expect(res.body.error).toMatch(/cap/i);
  });

  test("API-key sub-brand mismatch (apiKeySubBrand='tmc', body subBrand='rfu') → 403 SUB_BRAND_MISMATCH", async () => {
    const res = await request(makeApp({ apiKeySubBrand: 'tmc' }))
      .post('/api/booking-expedia/search')
      .send({
        subBrand: 'rfu',
        destinationCity: 'Mumbai',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_MISMATCH' });
    expect(res.body.error).toMatch(/tmc/);
    expect(res.body.error).toMatch(/rfu/);
    // Client must NOT be called when sub-brand isolation rejects the request.
    expect(bookingExpediaClient.searchHotels).not.toHaveBeenCalled();
  });
});

describe('POST /api/booking-expedia/book', () => {
  test('ADMIN happy path returns the book envelope and writes audit', async () => {
    const cannedEnvelope = {
      stub: true,
      bookingId: 'BKG-STUB-99',
      status: 'pending-cred-drop',
      tenantId: 1,
      provider: 'booking',
      hotelId: 'HTL-7',
      note: 'Booking.com integration pending Q-cluster B6/C creds.',
    };
    bookingExpediaClient.bookHotel.mockResolvedValue(cannedEnvelope);

    const res = await request(makeApp())
      .post('/api/booking-expedia/book')
      .send({
        provider: 'booking',
        subBrand: 'rfu',
        hotelId: 'HTL-7',
        roomType: 'deluxe',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
        guestNames: ['Alice', 'Bob'],
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stub: true, bookingId: 'BKG-STUB-99' });
    expect(bookingExpediaClient.bookHotel).toHaveBeenCalledWith({
      tenantId: 1,
      provider: 'booking',
      subBrand: 'rfu',
      hotelId: 'HTL-7',
      roomType: 'deluxe',
      checkInDate: '2026-06-01',
      checkOutDate: '2026-06-05',
      guestNames: ['Alice', 'Bob'],
    });
    // Audit row written on success with BookingExpediaBooking BOOK entity/action.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'BookingExpediaBooking',
      action: 'BOOK',
      userId: 7,
      tenantId: 1,
    });
  });

  test('USER → 403 (ADMIN/MANAGER gate fires before client)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, role: 'USER', tenantId: 1, isActive: true,
    });

    const res = await request(makeApp())
      .post('/api/booking-expedia/book')
      .send({
        provider: 'booking',
        hotelId: 'HTL-7',
        roomType: 'deluxe',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    // bookHotel MUST NOT have been called — the role gate fires before
    // the handler runs.
    expect(bookingExpediaClient.bookHotel).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/booking-expedia/cap-status', () => {
  test('ADMIN returns {spentCents, capCents, percent, withinCap, alertThreshold}', async () => {
    bookingExpediaClient.checkBudgetCap.mockResolvedValue({
      spentCents: 4200,
      capCents: 10000,
      percent: 0.42,
      withinCap: true,
      alertThreshold: false,
    });

    const res = await request(makeApp())
      .get('/api/booking-expedia/cap-status')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      spentCents: 4200,
      capCents: 10000,
      percent: 0.42,
      withinCap: true,
      alertThreshold: false,
    });
    expect(bookingExpediaClient.checkBudgetCap).toHaveBeenCalledWith(1);
    // Cap-status is read-only — no audit fires.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
