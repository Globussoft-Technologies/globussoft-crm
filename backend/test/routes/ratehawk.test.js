// @ts-check
/**
 * PRD_RATEHAWK_INTEGRATION — /api/ratehawk operator-wrapper tests.
 *
 * Pins the contract for the thin wrapper added at backend/routes/ratehawk.js,
 * which exposes services/ratehawkClient.js (stub-mode today, real post Q19
 * cred handover) to UI consumers without touching the service module.
 *
 * What's pinned
 * -------------
 *   - POST /search    happy path returns the client's envelope verbatim.
 *   - POST /search    missing destinationCity → 400 MISSING_DESTINATION.
 *   - POST /search    cap-exceeded throw → 402 + structured error body.
 *   - POST /book      ADMIN happy path returns the client envelope + audit
 *                     row written with subBrand/hotelId metadata.
 *   - POST /book      USER → 403 (verifyRole gate fires before client).
 *   - GET  /cap-status ADMIN — returns spent/cap/percent/withinCap/alert.
 *   - POST /search    API-key sub-brand mismatch (apiKeySubBrand='tmc' +
 *                     body subBrand='rfu') → 403 SUB_BRAND_MISMATCH.
 *
 * Test pattern mirrors backend/test/routes/adsgpt.test.js (commit 0d66a74)
 * — patch the ratehawkClient module exports with vi.fn() BEFORE requiring
 * the router via the SAME require() path so the router's closure sees our
 * mutations. verifyToken + verifyRole stay in the chain (we don't bypass
 * them) so the auth gate is exercised end-to-end.
 *
 * CJS-mock seam: see the adsgpt.test.js precedent at commit 0d66a74 —
 * vi.mock() can't reliably intercept the SUT's `require()` of a CJS
 * module under vitest with `inline: [/backend\/services\//]`. Use
 * `createRequire(import.meta.url)` to mutate the SAME require-cache
 * object the router reads. Direct vi.mock would silently miss.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Resolve ratehawkClient + router via the SAME require() path the route
// uses, so mutations to module.exports propagate to the router's closure.
const ratehawkClient = requireCJS('../../services/ratehawkClient');
ratehawkClient.searchHotels = vi.fn();
ratehawkClient.bookHotel = vi.fn();
ratehawkClient.cancelBooking = vi.fn();
ratehawkClient.checkBudgetCap = vi.fn();

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

const ratehawkRouter = requireCJS('../../routes/ratehawk');

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
  app.use('/api/ratehawk', ratehawkRouter);
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
  ratehawkClient.searchHotels.mockReset();
  ratehawkClient.bookHotel.mockReset();
  ratehawkClient.cancelBooking.mockReset();
  ratehawkClient.checkBudgetCap.mockReset();
  prisma.user.findUnique.mockReset().mockResolvedValue({
    id: 7, role: 'ADMIN', tenantId: 1, isActive: true,
  });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/ratehawk/search', () => {
  test('happy path returns the client envelope verbatim', async () => {
    const cannedEnvelope = {
      stub: true,
      tenantId: 1,
      query: {
        destinationCity: 'Mumbai',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
        guests: 2,
        rooms: 1,
      },
      hotels: [],
      note: 'RateHawk integration pending Q19 creds.',
    };
    ratehawkClient.searchHotels.mockResolvedValue(cannedEnvelope);

    const res = await request(makeApp())
      .post('/api/ratehawk/search')
      .send({
        subBrand: 'rfu',
        destinationCity: 'Mumbai',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
        guests: 2,
        rooms: 1,
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stub: true, tenantId: 1 });
    // Tenant came from req.user.tenantId, not the body.
    expect(ratehawkClient.searchHotels).toHaveBeenCalledWith({
      tenantId: 1,
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

  test('missing destinationCity → 400 MISSING_DESTINATION', async () => {
    const res = await request(makeApp())
      .post('/api/ratehawk/search')
      .send({
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_DESTINATION' });
    expect(ratehawkClient.searchHotels).not.toHaveBeenCalled();
  });

  test('client throws RATEHAWK_BUDGET_EXCEEDED → 402 with structured error', async () => {
    const err = new Error('Monthly RateHawk spend cap reached for this tenant.');
    err.code = 'RATEHAWK_BUDGET_EXCEEDED';
    err.spentCents = 7200;
    err.capCents = 5000;
    ratehawkClient.searchHotels.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/ratehawk/search')
      .send({
        destinationCity: 'Mumbai',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      code: 'RATEHAWK_BUDGET_EXCEEDED',
      spentCents: 7200,
      capCents: 5000,
    });
    expect(res.body.error).toMatch(/cap/i);
  });

  test('API-key sub-brand mismatch (apiKeySubBrand=tmc, body subBrand=rfu) → 403 SUB_BRAND_MISMATCH', async () => {
    const res = await request(makeApp({ apiKeySubBrand: 'tmc' }))
      .post('/api/ratehawk/search')
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
    expect(ratehawkClient.searchHotels).not.toHaveBeenCalled();
  });
});

describe('POST /api/ratehawk/book', () => {
  test('ADMIN happy path returns the book envelope and writes audit', async () => {
    const cannedEnvelope = {
      stub: true,
      bookingId: 'BKG-STUB-1',
      status: 'pending-cred-drop',
      tenantId: 1,
      query: {
        hotelId: 'HTL-42',
        roomType: 'deluxe',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
        guestNames: ['Alice', 'Bob'],
      },
    };
    ratehawkClient.bookHotel.mockResolvedValue(cannedEnvelope);

    const res = await request(makeApp())
      .post('/api/ratehawk/book')
      .send({
        subBrand: 'rfu',
        hotelId: 'HTL-42',
        roomType: 'deluxe',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
        guestNames: ['Alice', 'Bob'],
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stub: true, bookingId: 'BKG-STUB-1' });
    expect(ratehawkClient.bookHotel).toHaveBeenCalledWith({
      tenantId: 1,
      subBrand: 'rfu',
      hotelId: 'HTL-42',
      roomType: 'deluxe',
      checkInDate: '2026-06-01',
      checkOutDate: '2026-06-05',
      guestNames: ['Alice', 'Bob'],
    });
    // Audit row written on success with the RateHawkBooking BOOK entity/action.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'RateHawkBooking',
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
      .post('/api/ratehawk/book')
      .send({
        hotelId: 'HTL-42',
        roomType: 'deluxe',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    // bookHotel MUST NOT have been called — the role gate fires
    // before the handler runs.
    expect(ratehawkClient.bookHotel).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/ratehawk/cap-status', () => {
  test('ADMIN returns {spentCents, capCents, percent, withinCap, alertThreshold}', async () => {
    ratehawkClient.checkBudgetCap.mockResolvedValue({
      spentCents: 1800,
      capCents: 5000,
      percent: 0.36,
      withinCap: true,
      alertThreshold: false,
    });

    const res = await request(makeApp())
      .get('/api/ratehawk/cap-status')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      spentCents: 1800,
      capCents: 5000,
      percent: 0.36,
      withinCap: true,
      alertThreshold: false,
    });
    expect(ratehawkClient.checkBudgetCap).toHaveBeenCalledWith(1);
    // Cap-status is read-only — no audit fires.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Extended coverage (tick #N, +8 cases) — pinning the un-tested edges of the
// wrapper: search auth-gate + remaining missing-field validators + generic
// error fall-through; book MANAGER acceptance + cap-exceeded passthrough;
// cancel happy + USER 403 + audit; cap-status MANAGER 403.
//
// Mirrors the adsgpt.test.js extended-coverage block (commit 0d66a74) for
// consistency.
// ---------------------------------------------------------------------------
describe('POST /api/ratehawk/search — extended coverage', () => {
  test('missing checkInDate → 400 MISSING_CHECKIN', async () => {
    const res = await request(makeApp())
      .post('/api/ratehawk/search')
      .send({
        destinationCity: 'Mumbai',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_CHECKIN' });
    expect(ratehawkClient.searchHotels).not.toHaveBeenCalled();
  });

  test('missing Authorization header → 401 (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .post('/api/ratehawk/search')
      .send({
        destinationCity: 'Mumbai',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      });
    // No Authorization header set.

    expect(res.status).toBe(401);
    expect(ratehawkClient.searchHotels).not.toHaveBeenCalled();
  });

  test('generic client error (no .code, no .status) → 500 "Failed to search hotels"', async () => {
    ratehawkClient.searchHotels.mockRejectedValue(new Error('upstream blew up'));

    const res = await request(makeApp())
      .post('/api/ratehawk/search')
      .send({
        destinationCity: 'Mumbai',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to search hotels' });
  });
});

describe('POST /api/ratehawk/book — extended coverage', () => {
  test('missing hotelId → 400 MISSING_HOTEL_ID (validator short-circuits before sub-brand resolve)', async () => {
    const res = await request(makeApp())
      .post('/api/ratehawk/book')
      .send({
        roomType: 'deluxe',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_HOTEL_ID' });
    expect(ratehawkClient.bookHotel).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('MANAGER role accepted (ADMIN/MANAGER gate — not ADMIN-only)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, role: 'MANAGER', tenantId: 1, isActive: true,
    });
    ratehawkClient.bookHotel.mockResolvedValue({
      stub: true, bookingId: 'BKG-MGR-1', status: 'pending-cred-drop', tenantId: 1,
    });

    const res = await request(makeApp())
      .post('/api/ratehawk/book')
      .send({
        hotelId: 'HTL-7',
        roomType: 'standard',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stub: true, bookingId: 'BKG-MGR-1' });
    expect(ratehawkClient.bookHotel).toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('client throws RATEHAWK_BUDGET_EXCEEDED on book → 402 + structured error + NO audit', async () => {
    const err = new Error('Monthly RateHawk spend cap reached for this tenant.');
    err.code = 'RATEHAWK_BUDGET_EXCEEDED';
    err.spentCents = 9100;
    err.capCents = 5000;
    ratehawkClient.bookHotel.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/ratehawk/book')
      .send({
        hotelId: 'HTL-42',
        roomType: 'deluxe',
        checkInDate: '2026-06-01',
        checkOutDate: '2026-06-05',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      code: 'RATEHAWK_BUDGET_EXCEEDED',
      spentCents: 9100,
      capCents: 5000,
    });
    // Audit must NOT fire when the client throws before booking succeeds.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/ratehawk/cancel/:bookingId', () => {
  test('ADMIN happy path returns the cancel envelope and writes CANCEL audit row', async () => {
    const cannedEnvelope = {
      stub: true,
      bookingId: 'BKG-STUB-1',
      status: 'cancelled',
      cancelledAt: '2026-05-26T10:00:00.000Z',
      tenantId: 1,
    };
    ratehawkClient.cancelBooking.mockResolvedValue(cannedEnvelope);

    const res = await request(makeApp())
      .post('/api/ratehawk/cancel/BKG-STUB-1')
      .send({ reason: 'client requested' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stub: true, bookingId: 'BKG-STUB-1', status: 'cancelled' });
    expect(ratehawkClient.cancelBooking).toHaveBeenCalledWith({
      tenantId: 1,
      bookingId: 'BKG-STUB-1',
      reason: 'client requested',
    });
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'RateHawkBooking',
      action: 'CANCEL',
      userId: 7,
      tenantId: 1,
    });
  });

  test('USER role → 403 (ADMIN/MANAGER gate fires before client + audit)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, role: 'USER', tenantId: 1, isActive: true,
    });

    const res = await request(makeApp())
      .post('/api/ratehawk/cancel/BKG-STUB-1')
      .send({ reason: 'change of plans' })
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(ratehawkClient.cancelBooking).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('generic client error on cancel (no .code, no .status) → 500 "Failed to cancel booking"', async () => {
    ratehawkClient.cancelBooking.mockRejectedValue(new Error('provider 500'));

    const res = await request(makeApp())
      .post('/api/ratehawk/cancel/BKG-STUB-1')
      .send({ reason: 'test' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to cancel booking' });
    // Audit must NOT fire when the cancel itself throws.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/ratehawk/cap-status — extended coverage', () => {
  test('MANAGER → 403 (ADMIN-only gate, distinct from /book which accepts MANAGER)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, role: 'MANAGER', tenantId: 1, isActive: true,
    });

    const res = await request(makeApp())
      .get('/api/ratehawk/cap-status')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(ratehawkClient.checkBudgetCap).not.toHaveBeenCalled();
  });
});
