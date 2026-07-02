// @ts-check
/**
 * backend/routes/travel_trip_billing.js — TMC trip billing surface contract pin.
 *
 * What's pinned
 * -------------
 *   - Rooming (5 routes):
 *       GET    /trips/:tripId/rooming                    all-roles, requireTmcAccess
 *       POST   /trips/:tripId/rooming                    ADMIN+MGR, room-type enum,
 *                                                        capacity caps (1/2/3/4),
 *                                                        participantIds-on-trip check
 *       PATCH  /trips/:tripId/rooming/:roomId            ADMIN+MGR, partial-update,
 *                                                        capacity re-check, 404 cross-trip
 *       DELETE /trips/:tripId/rooming/:roomId            ADMIN only
 *       GET    /trips/:tripId/rooming/export.xlsx        ADMIN+MGR, XLSX content-type
 *   - Payment plan (3 routes):
 *       GET    /trips/:tripId/payment-plan               all-roles, 404 NOT_FOUND on miss
 *       PUT    /trips/:tripId/payment-plan               ADMIN+MGR, upsert semantics,
 *                                                        instalmentsJson must parse +
 *                                                        be non-empty array
 *       DELETE /trips/:tripId/payment-plan               ADMIN only
 *   - Per-participant instalments (4 routes):
 *       GET    /trips/:tripId/instalments                all-roles, ?participantId +
 *                                                        ?status filters, INVALID_STATUS
 *       POST   /trips/:tripId/instalments                ADMIN+MGR, MISSING_FIELDS,
 *                                                        INVALID_INPUT (numeric +
 *                                                        non-negative), INVALID_DATE,
 *                                                        PARTICIPANT_OFF_TRIP gate
 *       PATCH  /trips/:tripId/instalments/:id            ADMIN+MGR, EMPTY_BODY,
 *                                                        INVALID_AMOUNT, INVALID_STATUS,
 *                                                        404 cross-trip
 *       DELETE /trips/:tripId/instalments/:id            ADMIN only
 *
 * Pinned guards (all routes go through these in order):
 *   verifyToken → [requirePermission?] → requireTravelTenant → requireTmcAccess → handler
 *
 * Failure-path codes pinned by the route source as of this commit:
 *   400 INVALID_ID / INVALID_ROOM_ID / MISSING_FIELDS / INVALID_ROOM_TYPE /
 *       ROOM_CAPACITY_EXCEEDED / PARTICIPANTS_OFF_TRIP / INVALID_PARTICIPANTS /
 *       EMPTY_BODY / INVALID_JSON / EMPTY_INSTALMENTS / INVALID_STATUS /
 *       INVALID_INPUT / INVALID_DATE / INVALID_AMOUNT / PARTICIPANT_OFF_TRIP
 *   401 — verifyToken (missing Authorization)
 *   403 SUB_BRAND_DENIED / WRONG_VERTICAL — guard stack
 *   404 TRIP_NOT_FOUND / ROOM_NOT_FOUND / NOT_FOUND — cross-trip / cross-tenant
 *
 * Test pattern mirrors backend/test/routes/travel-cost-master.test.js (commit
 * 5ddb82d1) — patch the prisma singleton with vi.fn() shapes BEFORE requiring
 * the router, then drive supertest with real HS256 JWTs signed with the same
 * fallback secret the middleware uses in dev. The full guard chain
 * (verifyToken + requirePermission + requireTravelTenant + requireTmcAccess) is
 * exercised end-to-end; we don't bypass middleware.
 *
 * Note: requireTmcAccess calls getSubBrandAccessSet(req.user.userId) which
 * reads prisma.user.findUnique. We default that mock to ADMIN + subBrandAccess=null
 * (full access) and override per-test when narrowing.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.tmcTrip = {
  findFirst: vi.fn(),
};
prisma.roomingAssignment = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tripParticipant = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
};
prisma.tripPaymentPlan = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
};
prisma.tripInstalmentPayment = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
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
  prisma.tmcTrip.findFirst.mockReset().mockResolvedValue({ id: 100 });
  prisma.roomingAssignment.findMany.mockReset();
  prisma.roomingAssignment.findFirst.mockReset();
  prisma.roomingAssignment.create.mockReset();
  prisma.roomingAssignment.update.mockReset();
  prisma.roomingAssignment.delete.mockReset();
  prisma.tripParticipant.findMany.mockReset().mockResolvedValue([]);
  prisma.tripParticipant.findFirst.mockReset();
  prisma.tripParticipant.count.mockReset();
  prisma.tripPaymentPlan.findUnique.mockReset();
  prisma.tripPaymentPlan.upsert.mockReset();
  prisma.tripPaymentPlan.delete.mockReset();
  prisma.tripInstalmentPayment.findMany.mockReset();
  prisma.tripInstalmentPayment.findFirst.mockReset();
  prisma.tripInstalmentPayment.create.mockReset();
  prisma.tripInstalmentPayment.update.mockReset();
  prisma.tripInstalmentPayment.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// -----------------------------------------------------------------------------
// GET /api/travel/trips/:tripId/rooming — list
// -----------------------------------------------------------------------------

describe('GET /api/travel/trips/:tripId/rooming', () => {
  test('returns rooming list scoped to the trip', async () => {
    prisma.roomingAssignment.findMany.mockResolvedValue([
      { id: 1, tripId: 100, roomNumber: '101', roomType: 'twin', participantIds: '[1,2]' },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/rooming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rooming: expect.any(Array) });
    expect(res.body.rooming).toHaveLength(1);
    expect(prisma.roomingAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tripId: 100 },
        orderBy: { roomNumber: 'asc' },
      }),
    );
  });

  test('non-numeric tripId returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/trips/abc/rooming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.roomingAssignment.findMany).not.toHaveBeenCalled();
  });

  test('cross-tenant trip lookup returns 404 TRIP_NOT_FOUND', async () => {
    prisma.tmcTrip.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/trips/9999/rooming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TRIP_NOT_FOUND' });
    // The lookup MUST scope by req.travelTenant.id (=1).
    expect(prisma.tmcTrip.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 9999, tenantId: 1 } }),
    );
    expect(prisma.roomingAssignment.findMany).not.toHaveBeenCalled();
  });

  test('caller without TMC sub-brand access returns 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    const res = await request(makeApp())
      .get('/api/travel/trips/100/rooming')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.roomingAssignment.findMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// POST /api/travel/trips/:tripId/rooming — create
// -----------------------------------------------------------------------------

describe('POST /api/travel/trips/:tripId/rooming', () => {
  test('happy path returns 201 with persisted row (participantIds stringified)', async () => {
    prisma.tripParticipant.count.mockResolvedValue(2);
    prisma.roomingAssignment.findFirst.mockResolvedValue(null); // no duplicate room
    prisma.roomingAssignment.findMany.mockResolvedValue([]); // no existing assignments
    prisma.roomingAssignment.create.mockResolvedValue({
      id: 50, tripId: 100, roomNumber: '101', roomType: 'twin', participantIds: '[1,2]',
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/rooming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ roomNumber: '101', roomType: 'twin', participantIds: [1, 2] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 50, roomType: 'twin' });
    // tripId comes from the URL param (after loadTrip), NOT body.
    expect(prisma.roomingAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tripId: 100,
          roomNumber: '101',
          roomType: 'twin',
          participantIds: JSON.stringify([1, 2]),
        }),
      }),
    );
  });

  test('missing roomType returns 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/100/rooming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ roomNumber: '101', participantIds: [1] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.roomingAssignment.create).not.toHaveBeenCalled();
  });

  test('participantIds must be an array (string yields 400 MISSING_FIELDS)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/100/rooming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ roomNumber: '101', roomType: 'twin', participantIds: 'not-array' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.roomingAssignment.create).not.toHaveBeenCalled();
  });

  test('invalid roomType returns 400 INVALID_ROOM_TYPE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/100/rooming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ roomNumber: '101', roomType: 'penthouse', participantIds: [1] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ROOM_TYPE' });
    expect(res.body.error).toMatch(/single/);
    expect(res.body.error).toMatch(/quad/);
    expect(prisma.roomingAssignment.create).not.toHaveBeenCalled();
  });

  test('participantIds.length over room capacity returns 400 ROOM_CAPACITY_EXCEEDED', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/100/rooming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ roomNumber: '101', roomType: 'twin', participantIds: [1, 2, 3] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'ROOM_CAPACITY_EXCEEDED' });
    expect(res.body.error).toMatch(/twin/);
    expect(res.body.error).toMatch(/at most 2/);
    expect(prisma.roomingAssignment.create).not.toHaveBeenCalled();
  });

  test('participantIds off-trip returns 400 PARTICIPANTS_OFF_TRIP', async () => {
    // Count returns 1 but we sent 2 ids — one isn't on this trip.
    prisma.tripParticipant.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .post('/api/travel/trips/100/rooming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ roomNumber: '101', roomType: 'twin', participantIds: [1, 999] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'PARTICIPANTS_OFF_TRIP' });
    expect(prisma.roomingAssignment.create).not.toHaveBeenCalled();
  });

  test('USER role is rejected with 403 (verifyRole ADMIN+MANAGER gate)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/100/rooming')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ roomNumber: '101', roomType: 'twin', participantIds: [] });
    expect(res.status).toBe(403);
    expect(prisma.roomingAssignment.create).not.toHaveBeenCalled();
  });

  test('MANAGER role IS allowed (gate is ADMIN+MANAGER)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    prisma.tripParticipant.count.mockResolvedValue(0);
    prisma.roomingAssignment.create.mockResolvedValue({
      id: 51, tripId: 100, roomNumber: '102', roomType: 'single', participantIds: '[]',
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/rooming')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ roomNumber: '102', roomType: 'single', participantIds: [] });
    expect(res.status).toBe(201);
    expect(prisma.roomingAssignment.create).toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// PATCH /api/travel/trips/:tripId/rooming/:roomId — amend
// -----------------------------------------------------------------------------

describe('PATCH /api/travel/trips/:tripId/rooming/:roomId', () => {
  test('happy partial-update returns 200 with updated row', async () => {
    // First call loads the existing room; second call is the duplicate-room check.
    prisma.roomingAssignment.findFirst
      .mockResolvedValueOnce({
        id: 50, tripId: 100, roomNumber: '101', roomType: 'twin', participantIds: '[1,2]',
      })
      .mockResolvedValueOnce(null);
    prisma.roomingAssignment.update.mockResolvedValue({
      id: 50, tripId: 100, roomNumber: '101A', roomType: 'twin', participantIds: '[1,2]',
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/rooming/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ roomNumber: '101A' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 50, roomNumber: '101A' });
    expect(prisma.roomingAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 50 }, data: expect.objectContaining({ roomNumber: '101A' }) }),
    );
  });

  test('cross-trip roomId returns 404 ROOM_NOT_FOUND (no update)', async () => {
    prisma.roomingAssignment.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/rooming/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ roomNumber: '999' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'ROOM_NOT_FOUND' });
    expect(prisma.roomingAssignment.update).not.toHaveBeenCalled();
  });

  test('empty body returns 400 EMPTY_BODY (no update)', async () => {
    prisma.roomingAssignment.findFirst.mockResolvedValue({
      id: 50, tripId: 100, roomNumber: '101', roomType: 'twin',
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/rooming/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
    expect(prisma.roomingAssignment.update).not.toHaveBeenCalled();
  });

  test('PATCH-time capacity check uses NEW roomType when both type+ids change', async () => {
    prisma.roomingAssignment.findFirst.mockResolvedValue({
      id: 50, tripId: 100, roomNumber: '101', roomType: 'quad', participantIds: '[1,2,3,4]',
    });
    // Shrinking quad → single while keeping 2 ids should fail single's cap of 1.
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/rooming/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ roomType: 'single', participantIds: [1, 2] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'ROOM_CAPACITY_EXCEEDED' });
    expect(res.body.error).toMatch(/single/);
    expect(prisma.roomingAssignment.update).not.toHaveBeenCalled();
  });

  test('USER role is rejected with 403 (no findFirst call)', async () => {
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/rooming/50')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ roomNumber: '999' });
    expect(res.status).toBe(403);
    expect(prisma.roomingAssignment.findFirst).not.toHaveBeenCalled();
    expect(prisma.roomingAssignment.update).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// DELETE /api/travel/trips/:tripId/rooming/:roomId — ADMIN only
// -----------------------------------------------------------------------------

describe('DELETE /api/travel/trips/:tripId/rooming/:roomId', () => {
  test('happy delete returns 200 + { deleted: true, id }', async () => {
    prisma.roomingAssignment.findFirst.mockResolvedValue({
      id: 50, tripId: 100, roomNumber: '101', roomType: 'twin',
    });
    prisma.roomingAssignment.delete.mockResolvedValue({ id: 50 });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/rooming/50')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 50 });
    expect(prisma.roomingAssignment.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });

  test('MANAGER role is rejected with 403 (ADMIN-only gate)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/rooming/50')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(prisma.roomingAssignment.delete).not.toHaveBeenCalled();
  });

  test('cross-trip DELETE returns 404 ROOM_NOT_FOUND (no delete)', async () => {
    prisma.roomingAssignment.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/rooming/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'ROOM_NOT_FOUND' });
    expect(prisma.roomingAssignment.delete).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// GET /api/travel/trips/:tripId/rooming/export.xlsx — XLSX stream
// -----------------------------------------------------------------------------

describe('GET /api/travel/trips/:tripId/rooming/export.xlsx', () => {
  test('returns XLSX content-type + attachment disposition with trip-id-named file', async () => {
    prisma.roomingAssignment.findMany.mockResolvedValue([
      { id: 1, tripId: 100, roomNumber: '101', roomType: 'twin', participantIds: '[1,2]' },
    ]);
    prisma.tripParticipant.findMany.mockResolvedValue([
      { id: 1, fullName: 'Alice Sharma' },
      { id: 2, fullName: 'Bob Patel' },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/rooming/export.xlsx')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse((response, callback) => {
        response.setEncoding('binary');
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => callback(null, Buffer.from(data, 'binary')));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(
      /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/,
    );
    expect(res.headers['content-disposition']).toMatch(/rooming-trip-100\.xlsx/);
    // XLSX files start with the ZIP magic bytes 'PK' (0x50 0x4B).
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.slice(0, 2).toString('utf8')).toBe('PK');
  });

  test('USER role is rejected with 403 (ADMIN+MANAGER gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/trips/100/rooming/export.xlsx')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.roomingAssignment.findMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// GET /api/travel/trips/:tripId/payment-plan
// -----------------------------------------------------------------------------

describe('GET /api/travel/trips/:tripId/payment-plan', () => {
  test('returns the plan row when one exists', async () => {
    prisma.tripPaymentPlan.findUnique.mockResolvedValue({
      id: 7, tripId: 100, instalmentsJson: '[{"pct":50,"dueAt":"2026-06-01"}]', graceDays: 5,
    });
    const res = await request(makeApp())
      .get('/api/travel/trips/100/payment-plan')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, tripId: 100, graceDays: 5 });
    expect(prisma.tripPaymentPlan.findUnique).toHaveBeenCalledWith({ where: { tripId: 100 } });
  });

  test('returns 404 NOT_FOUND when no plan exists for the trip', async () => {
    prisma.tripPaymentPlan.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/payment-plan')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});

// -----------------------------------------------------------------------------
// PUT /api/travel/trips/:tripId/payment-plan — upsert
// -----------------------------------------------------------------------------

describe('PUT /api/travel/trips/:tripId/payment-plan', () => {
  test('happy upsert returns 200 with persisted plan', async () => {
    const instalmentsJson = JSON.stringify([{ pct: 50, dueAt: '2026-06-01' }, { pct: 50, dueAt: '2026-07-01' }]);
    prisma.tripPaymentPlan.upsert.mockResolvedValue({
      id: 8, tripId: 100, instalmentsJson, graceDays: 7,
    });
    const res = await request(makeApp())
      .put('/api/travel/trips/100/payment-plan')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ instalmentsJson, graceDays: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 8, graceDays: 7 });
    expect(prisma.tripPaymentPlan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tripId: 100 },
        create: expect.objectContaining({ tripId: 100, graceDays: 7 }),
        update: expect.objectContaining({ graceDays: 7 }),
      }),
    );
  });

  test('missing instalmentsJson returns 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .put('/api/travel/trips/100/payment-plan')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ graceDays: 7 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.tripPaymentPlan.upsert).not.toHaveBeenCalled();
  });

  test('unparseable instalmentsJson returns 400 INVALID_JSON', async () => {
    const res = await request(makeApp())
      .put('/api/travel/trips/100/payment-plan')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ instalmentsJson: '{not json' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_JSON' });
    expect(prisma.tripPaymentPlan.upsert).not.toHaveBeenCalled();
  });

  test('empty-array instalmentsJson returns 400 EMPTY_INSTALMENTS', async () => {
    const res = await request(makeApp())
      .put('/api/travel/trips/100/payment-plan')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ instalmentsJson: '[]' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_INSTALMENTS' });
    expect(prisma.tripPaymentPlan.upsert).not.toHaveBeenCalled();
  });

  test('USER role rejected with 403 (verifyRole ADMIN+MANAGER gate)', async () => {
    const res = await request(makeApp())
      .put('/api/travel/trips/100/payment-plan')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ instalmentsJson: '[{"pct":100}]' });
    expect(res.status).toBe(403);
    expect(prisma.tripPaymentPlan.upsert).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// DELETE /api/travel/trips/:tripId/payment-plan — ADMIN only
// -----------------------------------------------------------------------------

describe('DELETE /api/travel/trips/:tripId/payment-plan', () => {
  test('happy delete returns 200 + { deleted: true }', async () => {
    prisma.tripPaymentPlan.findUnique.mockResolvedValue({ id: 8, tripId: 100 });
    prisma.tripPaymentPlan.delete.mockResolvedValue({ id: 8 });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/payment-plan')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(prisma.tripPaymentPlan.delete).toHaveBeenCalledWith({ where: { tripId: 100 } });
  });

  test('no existing plan returns 404 NOT_FOUND (no delete)', async () => {
    prisma.tripPaymentPlan.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/payment-plan')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.tripPaymentPlan.delete).not.toHaveBeenCalled();
  });

  test('MANAGER role rejected with 403 (ADMIN-only gate)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/payment-plan')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(prisma.tripPaymentPlan.delete).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// GET /api/travel/trips/:tripId/instalments — list (filtered)
// -----------------------------------------------------------------------------

describe('GET /api/travel/trips/:tripId/instalments', () => {
  test('returns instalments list scoped to trip with default ordering', async () => {
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([
      { id: 1, tripId: 100, participantId: 5, instalmentIndex: 0, amount: 5000, status: 'pending' },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/trips/100/instalments')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ instalments: expect.any(Array) });
    expect(prisma.tripInstalmentPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tripId: 100 },
        orderBy: [{ participantId: 'asc' }, { instalmentIndex: 'asc' }],
        take: 500,
      }),
    );
  });

  test('honors ?participantId + ?status filters in the where clause', async () => {
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/trips/100/instalments?participantId=5&status=paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const calledWhere = prisma.tripInstalmentPayment.findMany.mock.calls[0][0].where;
    expect(calledWhere).toMatchObject({
      tripId: 100,
      participantId: 5,
      status: 'paid',
    });
  });

  test('invalid ?status returns 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/trips/100/instalments?status=disputed')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.tripInstalmentPayment.findMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// POST /api/travel/trips/:tripId/instalments — create
// -----------------------------------------------------------------------------

describe('POST /api/travel/trips/:tripId/instalments', () => {
  const validBody = () => ({
    participantId: 5,
    instalmentIndex: 0,
    dueDate: '2026-06-01',
    amount: 5000,
  });

  test('happy path returns 201 with persisted instalment (status pending by default)', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue({ id: 5 });
    prisma.tripInstalmentPayment.create.mockResolvedValue({
      id: 200, tripId: 100, participantId: 5, instalmentIndex: 0, amount: 5000, status: 'pending',
    });
    const res = await request(makeApp())
      .post('/api/travel/trips/100/instalments')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 200, status: 'pending', amount: 5000 });
    expect(prisma.tripInstalmentPayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tripId: 100,
          participantId: 5,
          instalmentIndex: 0,
          amount: 5000,
          status: 'pending',
        }),
      }),
    );
  });

  test('missing dueDate returns 400 MISSING_FIELDS', async () => {
    const body = validBody();
    delete body.dueDate;
    const res = await request(makeApp())
      .post('/api/travel/trips/100/instalments')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.tripInstalmentPayment.create).not.toHaveBeenCalled();
  });

  test('negative amount returns 400 INVALID_INPUT', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/100/instalments')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), amount: -100 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_INPUT' });
    expect(prisma.tripInstalmentPayment.create).not.toHaveBeenCalled();
  });

  test('unparseable dueDate returns 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/100/instalments')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ ...validBody(), dueDate: 'garbage' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
    expect(prisma.tripInstalmentPayment.create).not.toHaveBeenCalled();
  });

  test('participant not on this trip returns 400 PARTICIPANT_OFF_TRIP', async () => {
    prisma.tripParticipant.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/trips/100/instalments')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'PARTICIPANT_OFF_TRIP' });
    expect(prisma.tripInstalmentPayment.create).not.toHaveBeenCalled();
  });

  test('USER role rejected with 403 (verifyRole ADMIN+MANAGER gate)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/trips/100/instalments')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(validBody());
    expect(res.status).toBe(403);
    expect(prisma.tripInstalmentPayment.create).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// PATCH /api/travel/trips/:tripId/instalments/:id — amend
// -----------------------------------------------------------------------------

describe('PATCH /api/travel/trips/:tripId/instalments/:id', () => {
  test('happy mark-paid returns 200 with updated row', async () => {
    prisma.tripInstalmentPayment.findFirst.mockResolvedValue({
      id: 200, tripId: 100, participantId: 5, instalmentIndex: 0, amount: 5000, status: 'pending',
    });
    prisma.tripInstalmentPayment.update.mockResolvedValue({
      id: 200, tripId: 100, participantId: 5, instalmentIndex: 0, amount: 5000,
      paidAmount: 5000, status: 'paid',
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/instalments/200')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ paidAmount: 5000, status: 'paid' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 200, status: 'paid', paidAmount: 5000 });
    expect(prisma.tripInstalmentPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 200 },
        data: expect.objectContaining({ paidAmount: 5000, status: 'paid' }),
      }),
    );
  });

  test('cross-trip instalment id returns 404 NOT_FOUND (no update)', async () => {
    prisma.tripInstalmentPayment.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/instalments/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'paid' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.tripInstalmentPayment.update).not.toHaveBeenCalled();
  });

  test('empty body returns 400 EMPTY_BODY', async () => {
    prisma.tripInstalmentPayment.findFirst.mockResolvedValue({
      id: 200, tripId: 100, participantId: 5,
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/instalments/200')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
    expect(prisma.tripInstalmentPayment.update).not.toHaveBeenCalled();
  });

  test('invalid status returns 400 INVALID_STATUS', async () => {
    prisma.tripInstalmentPayment.findFirst.mockResolvedValue({
      id: 200, tripId: 100, participantId: 5,
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/instalments/200')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'disputed' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.tripInstalmentPayment.update).not.toHaveBeenCalled();
  });

  test('negative amount returns 400 INVALID_AMOUNT', async () => {
    prisma.tripInstalmentPayment.findFirst.mockResolvedValue({
      id: 200, tripId: 100, participantId: 5,
    });
    const res = await request(makeApp())
      .patch('/api/travel/trips/100/instalments/200')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: -50 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(prisma.tripInstalmentPayment.update).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// DELETE /api/travel/trips/:tripId/instalments/:id — ADMIN only
// -----------------------------------------------------------------------------

describe('DELETE /api/travel/trips/:tripId/instalments/:id', () => {
  test('happy delete returns 200 + { deleted: true, id }', async () => {
    prisma.tripInstalmentPayment.findFirst.mockResolvedValue({
      id: 200, tripId: 100, participantId: 5,
    });
    prisma.tripInstalmentPayment.delete.mockResolvedValue({ id: 200 });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/instalments/200')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 200 });
    expect(prisma.tripInstalmentPayment.delete).toHaveBeenCalledWith({ where: { id: 200 } });
  });

  test('cross-trip DELETE returns 404 NOT_FOUND (no delete)', async () => {
    prisma.tripInstalmentPayment.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/instalments/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.tripInstalmentPayment.delete).not.toHaveBeenCalled();
  });

  test('MANAGER role rejected with 403 (ADMIN-only gate)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    const res = await request(makeApp())
      .delete('/api/travel/trips/100/instalments/200')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(prisma.tripInstalmentPayment.delete).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Auth gate + vertical guard
// -----------------------------------------------------------------------------

describe('auth + vertical guard', () => {
  test('missing Authorization header returns 401', async () => {
    const res = await request(makeApp()).get('/api/travel/trips/100/rooming');
    expect(res.status).toBe(401);
    expect(prisma.tmcTrip.findFirst).not.toHaveBeenCalled();
  });

  test('non-travel-vertical tenant returns 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Co', slug: 'generic',
    });
    const res = await request(makeApp())
      .get('/api/travel/trips/100/rooming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.tmcTrip.findFirst).not.toHaveBeenCalled();
  });
});
