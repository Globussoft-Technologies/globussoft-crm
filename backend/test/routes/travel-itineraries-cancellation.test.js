// @ts-check
/**
 * PATCH /api/travel/itineraries/:id/cancellation — advisor cancellation
 * resolution (approve / decline / refunded).
 *
 * WHY this test exists: the itinerary list page badges an "accepted"
 * booking as "Deposit overdue" once cron/paymentDeadlineEngine stamps
 * paymentOverdueAt (see paymentDeadlineEngine.test.js). Cancelling a
 * booking never touches `status` — cancellationStatus is a separate
 * lifecycle field — so unless this route ALSO clears paymentOverdueAt,
 * a booking that was flagged overdue before cancellation keeps showing
 * the stale "Deposit overdue" badge forever after being cancelled and
 * refunded. This pins that both the "approve" and "refunded" decisions
 * clear the flag (the latter is belt-and-suspenders in case the cron
 * re-stamped it between the cancelled → refunded transitions).
 *
 * Mocking strategy (mirrors portal-travel-cancellation.test.js +
 * travel-itineraries-api.test.js): patch the prisma singleton BEFORE
 * requiring the router; real verifyToken + requireTravelTenant +
 * requirePermission middleware runs; ADMIN role short-circuits
 * requirePermission via req.user.isOwner is NOT used here — instead we
 * sign role:'ADMIN' and mock getSubBrandAccessSet's backing
 * prisma.user.findUnique to role:'ADMIN' so canAccessSubBrand always
 * passes. prisma.travelInvoice / prisma.cancellationPolicy resolve to
 * empty so resolveCancellationRefund short-circuits to its
 * computable:false base case — refund math itself is out of scope here.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma.js';

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.itinerary = prisma.itinerary || {};
prisma.itinerary.findFirst = vi.fn();
prisma.itinerary.update = vi.fn();
prisma.travelInvoice = prisma.travelInvoice || {};
prisma.travelInvoice.findFirst = vi.fn();
prisma.cancellationPolicy = prisma.cancellationPolicy || {};
prisma.cancellationPolicy.findFirst = vi.fn();
prisma.cancellationPolicy.findMany = vi.fn();
prisma.payment = prisma.payment || {};
prisma.payment.findFirst = vi.fn();
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.travelPortalNotification = prisma.travelPortalNotification || {};
prisma.travelPortalNotification.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelItinerariesRouter = requireCJS('../../routes/travel_itineraries');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelItinerariesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function itin(overrides = {}) {
  return {
    id: 55,
    tenantId: 1,
    subBrand: 'travelstall',
    contactId: 501,
    destination: 'Goa',
    currency: 'INR',
    cancellationStatus: null,
    advancePaidAmount: 0,
    startDate: new Date(Date.now() + 10 * 86_400_000),
    paymentReference: null,
    ...overrides,
  };
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.itinerary.findFirst.mockReset();
  prisma.itinerary.update.mockReset().mockImplementation(async ({ data }) => ({
    id: 55, status: 'accepted', cancellationStatus: null, cancellationReason: null,
    cancellationRequestedAt: null, paymentOverdueAt: null, ...data,
  }));
  prisma.travelInvoice.findFirst.mockReset().mockResolvedValue(null);
  prisma.cancellationPolicy.findFirst.mockReset().mockResolvedValue(null);
  prisma.cancellationPolicy.findMany.mockReset().mockResolvedValue([]);
  prisma.payment.findFirst.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.travelPortalNotification.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('PATCH /api/travel/itineraries/:id/cancellation — paymentOverdueAt clearing', () => {
  test('approve: a stale paymentOverdueAt flag is cleared alongside cancellationStatus=cancelled', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(
      itin({ cancellationStatus: 'requested', paymentOverdueAt: new Date('2026-06-01T00:00:00Z') }),
    );
    const res = await request(makeApp())
      .patch('/api/travel/itineraries/55/cancellation')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ decision: 'approve' });

    expect(res.status).toBe(200);
    expect(prisma.itinerary.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 55 },
        data: expect.objectContaining({ cancellationStatus: 'cancelled', paymentOverdueAt: null }),
      }),
    );
    expect(res.body.cancellationStatus).toBe('cancelled');
    expect(res.body.paymentOverdueAt).toBeNull();
  });

  test('refunded: paymentOverdueAt is cleared again (belt-and-suspenders vs. a cron re-stamp)', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(
      itin({ cancellationStatus: 'cancelled', paymentOverdueAt: new Date('2026-06-05T00:00:00Z') }),
    );
    const res = await request(makeApp())
      .patch('/api/travel/itineraries/55/cancellation')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ decision: 'refunded' });

    expect(res.status).toBe(200);
    expect(prisma.itinerary.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 55 },
        data: expect.objectContaining({ cancellationStatus: 'refunded', paymentOverdueAt: null }),
      }),
    );
    expect(res.body.cancellationStatus).toBe('refunded');
    expect(res.body.paymentOverdueAt).toBeNull();
  });

  test('decline: cancellationStatus resets to null; paymentOverdueAt is untouched (booking continues, still owes)', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(
      itin({ cancellationStatus: 'requested', paymentOverdueAt: new Date('2026-06-01T00:00:00Z') }),
    );
    const res = await request(makeApp())
      .patch('/api/travel/itineraries/55/cancellation')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ decision: 'decline' });

    expect(res.status).toBe(200);
    const data = prisma.itinerary.update.mock.calls[0][0].data;
    expect(data).toEqual({ cancellationStatus: null });
    expect(data).not.toHaveProperty('paymentOverdueAt');
  });

  test('approve with no prior paymentOverdueAt (never flagged) still succeeds — data.paymentOverdueAt explicitly null', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(
      itin({ cancellationStatus: 'requested', paymentOverdueAt: null }),
    );
    const res = await request(makeApp())
      .patch('/api/travel/itineraries/55/cancellation')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ decision: 'approve' });

    expect(res.status).toBe(200);
    expect(prisma.itinerary.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentOverdueAt: null }) }),
    );
  });
});

describe('PATCH /api/travel/itineraries/:id/cancellation — lifecycle guards', () => {
  test('approve without a pending request → 409 NO_PENDING_REQUEST, no write', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(itin({ cancellationStatus: null }));
    const res = await request(makeApp())
      .patch('/api/travel/itineraries/55/cancellation')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ decision: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_PENDING_REQUEST');
    expect(prisma.itinerary.update).not.toHaveBeenCalled();
  });

  test('refunded before cancelled → 409 NOT_CANCELLED, no write', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(itin({ cancellationStatus: 'requested' }));
    const res = await request(makeApp())
      .patch('/api/travel/itineraries/55/cancellation')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ decision: 'refunded' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_CANCELLED');
    expect(prisma.itinerary.update).not.toHaveBeenCalled();
  });

  test('invalid decision → 400 INVALID_DECISION', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(itin({ cancellationStatus: 'requested' }));
    const res = await request(makeApp())
      .patch('/api/travel/itineraries/55/cancellation')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ decision: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DECISION');
  });

  test('itinerary not found → 404 NOT_FOUND', async () => {
    prisma.itinerary.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel/itineraries/999/cancellation')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ decision: 'approve' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
