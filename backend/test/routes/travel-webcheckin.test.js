// @ts-check
/**
 * Travel CRM — WebCheckin CRUD route (PRD §4.6) contract tests.
 *
 * Pins backend/routes/travel_webcheckin.js (8 endpoints over WebCheckin).
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing Bearer → 401 (verifyToken in chain).
 *   - Vertical gate: non-travel tenant → 403 WRONG_VERTICAL
 *     (requireTravelTenant); tenant missing → 404 TENANT_NOT_FOUND.
 *   - RBAC gate: USER → 403 RBAC_DENIED on POST/PATCH/upload/deliver;
 *     non-ADMIN → 403 on DELETE (ADMIN-only).
 *   - GET /api/travel/webcheckins — tenant-scoped list; ?status filter;
 *     ?status=garbage → 400 INVALID_STATUS.
 *   - GET /api/travel/webcheckins/upcoming — windowOpenAt range filter
 *     within next 48h, status in (pending, reminded).
 *   - GET /api/travel/webcheckins/:id — 400 INVALID_ID on NaN; 404 NOT_FOUND
 *     when cross-tenant (findFirst returns null).
 *   - POST /api/travel/webcheckins — 201 happy path; 400 MISSING_FIELDS;
 *     400 INVALID_DATE on bad departureAt; windowOpenAt auto-computed
 *     from airline code (T-48h default).
 *   - PATCH /api/travel/webcheckins/:id — 400 EMPTY_BODY when no
 *     updatable fields; 400 INVALID_STATUS on bad status; happy path
 *     200 with updated row.
 *   - POST /:id/deliver — 409 NO_BOARDING_PASS when boardingPassUrl is
 *     null; 200 + deliveredAt set when boarding pass already on file.
 *   - DELETE /:id — 204 ADMIN; 403 MANAGER (RBAC).
 *
 * Test pattern mirrors backend/test/routes/travel_quotes.test.js +
 * travel-dashboard.test.js — patch the prisma singleton with vi.fn()
 * shapes BEFORE requiring the router, drive supertest with real HS256
 * JWTs signed with the dev-fallback secret. verifyToken + verifyRole +
 * requireTravelTenant all stay in the chain (no bypass) so guards are
 * exercised end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.webCheckin = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn().mockResolvedValue({ phone: '+919876543210' });
prisma.itinerary = prisma.itinerary || {};
prisma.itinerary.findUnique = vi.fn().mockResolvedValue({ subBrand: 'tmc' });
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
const webcheckinRouter = requireCJS('../../routes/travel_webcheckin');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', webcheckinRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Departure 4 days in the future — unambiguously future + outside the
// 48h "upcoming" window so the auto-computed windowOpenAt for IndiGo
// (T-48h) is 2 days from now.
const futureDeparture = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
const futureDepartureIso = futureDeparture.toISOString();

beforeEach(() => {
  prisma.webCheckin.findMany.mockReset();
  prisma.webCheckin.findFirst.mockReset();
  prisma.webCheckin.count.mockReset();
  prisma.webCheckin.create.mockReset();
  prisma.webCheckin.update.mockReset();
  prisma.webCheckin.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.contact.findUnique.mockReset().mockResolvedValue({ phone: '+919876543210' });
  prisma.itinerary.findUnique.mockReset().mockResolvedValue({ subBrand: 'tmc' });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/travel/webcheckins (list)', () => {
  test('returns tenant-scoped list with total/limit/offset envelope', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, pnr: 'ABC123', airlineCode: '6E', status: 'pending' },
    ]);
    prisma.webCheckin.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/webcheckins')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(res.body.webcheckins).toHaveLength(1);
    // The where clause MUST include tenantId from req.user.tenantId.
    expect(prisma.webCheckin.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1 }),
      }),
    );
  });

  test('?status=garbage returns 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins?status=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.webCheckin.findMany).not.toHaveBeenCalled();
  });

  test('missing Bearer returns 401', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins');
    expect(res.status).toBe(401);
    expect(prisma.webCheckin.findMany).not.toHaveBeenCalled();
  });

  test('non-travel tenant returns 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'wellness', name: 'Wellness Co', slug: 'wellness',
    });
    const res = await request(makeApp())
      .get('/api/travel/webcheckins')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.webCheckin.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/travel/webcheckins/upcoming', () => {
  test('returns rows in the next-48h window with status in (pending, reminded)', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, pnr: 'ABC', status: 'pending', windowOpenAt: new Date() },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/upcoming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    // Where clause: tenantId + status:in + windowOpenAt range.
    expect(prisma.webCheckin.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          status: { in: ['pending', 'reminded'] },
          windowOpenAt: expect.objectContaining({ gte: expect.any(Date), lte: expect.any(Date) }),
        }),
        orderBy: { windowOpenAt: 'asc' },
      }),
    );
  });

  test('/upcoming does NOT collide with /:id route precedence', async () => {
    // Regression guard: if /:id is mounted first, parseInt("upcoming")
    // → NaN trap on this path. Verify the /upcoming handler answered
    // (not the /:id 400 INVALID_ID).
    prisma.webCheckin.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/upcoming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toMatchObject({ code: 'INVALID_ID' });
  });
});

describe('GET /api/travel/webcheckins/:id', () => {
  test('non-numeric id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.webCheckin.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant returns 404 NOT_FOUND', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    // The lookup MUST be scoped to req.travelTenant.id.
    expect(prisma.webCheckin.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9999, tenantId: 1 }),
      }),
    );
  });
});

describe('POST /api/travel/webcheckins', () => {
  test('happy path returns 201; tenantId from req.user; windowOpenAt auto-computed', async () => {
    prisma.webCheckin.create.mockImplementation(async (args) => ({
      id: 42, ...args.data,
    }));
    const res = await request(makeApp())
      .post('/api/travel/webcheckins')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 99,
        pnr: 'ABC123',
        airlineCode: '6e', // lower-cased on purpose — route uppercases.
        flightNumber: '6E2125',
        departureAt: futureDepartureIso,
        passengerName: 'Asha Iyer',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 42,
      contactId: 99,
      pnr: 'ABC123',
      airlineCode: '6E', // upper-cased by route
      passengerName: 'Asha Iyer',
      status: 'pending',
    });
    // Verify tenantId came from req.user, not body.
    expect(prisma.webCheckin.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          contactId: 99,
          pnr: 'ABC123',
          airlineCode: '6E',
          status: 'pending',
        }),
      }),
    );
    // windowOpenAt should be auto-computed (T-48h for 6E IndiGo).
    const createArgs = prisma.webCheckin.create.mock.calls[0][0];
    const departureMs = new Date(futureDepartureIso).getTime();
    const windowMs = new Date(createArgs.data.windowOpenAt).getTime();
    expect(departureMs - windowMs).toBe(48 * 60 * 60 * 1000);
  });

  test('rejects missing pnr with 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/webcheckins')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 99,
        // pnr missing
        airlineCode: '6E',
        flightNumber: '6E2125',
        departureAt: futureDepartureIso,
        passengerName: 'Asha Iyer',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.webCheckin.create).not.toHaveBeenCalled();
  });

  test('rejects invalid departureAt with 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/webcheckins')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 99,
        pnr: 'ABC123',
        airlineCode: '6E',
        flightNumber: '6E2125',
        departureAt: 'not-a-date',
        passengerName: 'Asha Iyer',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
    expect(prisma.webCheckin.create).not.toHaveBeenCalled();
  });

  test('USER role gets 403 RBAC_DENIED (POST is ADMIN/MANAGER only)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/webcheckins')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({
        contactId: 99,
        pnr: 'ABC123',
        airlineCode: '6E',
        flightNumber: '6E2125',
        departureAt: futureDepartureIso,
        passengerName: 'Asha Iyer',
      });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.webCheckin.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/travel/webcheckins/:id', () => {
  test('happy path updates status and returns updated row', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, status: 'pending',
    });
    prisma.webCheckin.update.mockResolvedValue({
      id: 5, tenantId: 1, status: 'done',
    });
    const res = await request(makeApp())
      .patch('/api/travel/webcheckins/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'done' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, status: 'done' });
    expect(prisma.webCheckin.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { status: 'done' },
    });
  });

  test('empty body returns 400 EMPTY_BODY', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, status: 'pending',
    });
    const res = await request(makeApp())
      .patch('/api/travel/webcheckins/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
    expect(prisma.webCheckin.update).not.toHaveBeenCalled();
  });

  test('invalid status returns 400 INVALID_STATUS', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, status: 'pending',
    });
    const res = await request(makeApp())
      .patch('/api/travel/webcheckins/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'garbage' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.webCheckin.update).not.toHaveBeenCalled();
  });

  test('cross-tenant returns 404 NOT_FOUND', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel/webcheckins/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'done' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.webCheckin.update).not.toHaveBeenCalled();
  });

  test('attemptsJson object is JSON.stringified before write', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, status: 'pending',
    });
    prisma.webCheckin.update.mockResolvedValue({ id: 5, attemptsJson: '[]' });
    const attempts = [{ at: '2026-05-25T00:00:00Z', result: 'ok', errorReason: null }];
    await request(makeApp())
      .patch('/api/travel/webcheckins/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ attemptsJson: attempts });
    const updateArgs = prisma.webCheckin.update.mock.calls[0][0];
    expect(typeof updateArgs.data.attemptsJson).toBe('string');
    expect(JSON.parse(updateArgs.data.attemptsJson)).toEqual(attempts);
  });
});

describe('POST /api/travel/webcheckins/:id/deliver', () => {
  test('returns 409 NO_BOARDING_PASS when boardingPassUrl is null', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, contactId: 99, pnr: 'ABC',
      boardingPassUrl: null, itineraryId: null,
      tenant: { name: 'Test Travel' },
    });
    const res = await request(makeApp())
      .post('/api/travel/webcheckins/5/deliver')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'NO_BOARDING_PASS' });
    expect(prisma.webCheckin.update).not.toHaveBeenCalled();
  });

  test('200 + deliveredAt set when boardingPassUrl present', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, contactId: 99, pnr: 'ABC123',
      boardingPassUrl: '/uploads/boarding-passes/bp-abc.pdf',
      itineraryId: null,
      tenant: { name: 'Test Travel' },
    });
    prisma.webCheckin.update.mockImplementation(async (args) => ({
      id: 5, ...args.data,
    }));
    // Tenant config lookup (subBrandConfigJson) in /deliver path.
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
    }).mockResolvedValueOnce({ subBrandConfigJson: null });
    const res = await request(makeApp())
      .post('/api/travel/webcheckins/5/deliver')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5 });
    expect(res.body.deliveredAt).toBeTruthy();
    // The write MUST set deliveredAt to a Date.
    expect(prisma.webCheckin.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { deliveredAt: expect.any(Date) },
    });
  });
});

describe('DELETE /api/travel/webcheckins/:id (ADMIN-only)', () => {
  test('ADMIN returns 204', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue({ id: 5, tenantId: 1 });
    prisma.webCheckin.delete.mockResolvedValue({ id: 5 });
    const res = await request(makeApp())
      .delete('/api/travel/webcheckins/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(prisma.webCheckin.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });

  test('MANAGER role gets 403 RBAC_DENIED (DELETE is ADMIN-only)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    const res = await request(makeApp())
      .delete('/api/travel/webcheckins/5')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.webCheckin.delete).not.toHaveBeenCalled();
  });

  test('cross-tenant returns 404 NOT_FOUND (no delete fires)', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/webcheckins/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.webCheckin.delete).not.toHaveBeenCalled();
  });
});
