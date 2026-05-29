// @ts-check
/**
 * Travel CRM — Sightseeing Master CRUD (#907 slice 2/N) — route tests.
 *
 * Pins the 5-endpoint contract for /api/travel/sightseeing:
 *   GET    /            list, paginated, tenant + sub-brand scoped
 *   POST   /            create (ADMIN+MANAGER)
 *   GET    /:id         get one, sub-brand gate
 *   PATCH  /:id         update (ADMIN+MANAGER)
 *   DELETE /:id         soft-delete (ADMIN only) via isActive=false
 *
 * What's pinned
 * -------------
 *   - GET happy path returns { items, total, limit, offset }
 *   - GET non-travel tenant → 403 WRONG_VERTICAL (requireTravelTenant)
 *   - GET unauthenticated → 401 (verifyToken)
 *   - GET ?limit clamp: >200 → 200, <1 → 1
 *   - GET MANAGER subBrandAccess=['rfu'] threads
 *     `OR: [{ subBrand: null }, { subBrand: { in: ['rfu'] } }]` (nullable
 *     subBrand semantics — tenant-wide rows visible to everyone)
 *   - POST ADMIN happy path → 201 + record
 *   - POST missing destinationName → 400 MISSING_DESTINATION
 *   - POST invalid currency "usd" (lowercase) → 400 INVALID_CURRENCY
 *   - POST USER role → 403 (verifyRole gate)
 *   - GET /:id found / invalid id / not-found shapes
 *   - PATCH /:id happy path
 *   - DELETE /:id sets isActive=false (no destructive delete)
 *
 * Pattern mirrors travel-suppliers-by-month.test.js — patch prisma BEFORE
 * requiring the router, drive with real HS256 JWTs against the dev
 * fallback secret. verifyToken + verifyRole + requireTravelTenant +
 * getSubBrandAccessSet all run for real.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelSightseeing = prisma.travelSightseeing || {};
prisma.travelSightseeing.findMany = vi.fn();
prisma.travelSightseeing.findFirst = vi.fn();
prisma.travelSightseeing.count = vi.fn();
prisma.travelSightseeing.create = vi.fn();
prisma.travelSightseeing.update = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  findMany: vi.fn().mockResolvedValue([]),
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
const sightseeingRouter = requireCJS('../../routes/travel_sightseeing');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/sightseeing', sightseeingRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const sampleRows = [
  {
    id: 101,
    tenantId: 1,
    destinationName: 'Paris',
    name: 'Eiffel Tower',
    description: 'Iconic 330m wrought-iron lattice tower.',
    imageUrl: 'https://cdn.example.com/eiffel.jpg',
    durationMinutes: 120,
    priceReferenceMinor: 290000,
    currency: 'EUR',
    category: 'monument',
    subBrand: 'travelstall',
    notes: null,
    isActive: true,
    createdAt: new Date('2026-05-10T09:00:00Z'),
    updatedAt: new Date('2026-05-10T09:00:00Z'),
  },
  {
    id: 102,
    tenantId: 1,
    destinationName: 'Mecca',
    name: 'Masjid al-Haram',
    description: 'Holiest mosque in Islam.',
    imageUrl: null,
    durationMinutes: 240,
    priceReferenceMinor: null,
    currency: null,
    category: 'religious',
    subBrand: 'rfu',
    notes: null,
    isActive: true,
    createdAt: new Date('2026-05-09T08:00:00Z'),
    updatedAt: new Date('2026-05-09T08:00:00Z'),
  },
];

beforeEach(() => {
  prisma.travelSightseeing.findMany.mockReset().mockResolvedValue(sampleRows);
  prisma.travelSightseeing.findFirst.mockReset();
  prisma.travelSightseeing.count.mockReset().mockResolvedValue(sampleRows.length);
  prisma.travelSightseeing.create.mockReset();
  prisma.travelSightseeing.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
});

describe('GET /api/travel/sightseeing — list', () => {
  test('happy path: returns paginated envelope', async () => {
    const res = await request(makeApp())
      .get('/api/travel/sightseeing')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.items[0].name).toBe('Eiffel Tower');
  });

  test('non-travel tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'wellness', name: 'Wellness', slug: 'wellness',
    });
    const res = await request(makeApp())
      .get('/api/travel/sightseeing')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('unauthenticated (no header) → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/sightseeing');
    expect(res.status).toBe(401);
    expect(prisma.travelSightseeing.findMany).not.toHaveBeenCalled();
  });

  test('?limit=300 clamps to 200; ?limit=0 clamps to 1', async () => {
    let res = await request(makeApp())
      .get('/api/travel/sightseeing?limit=300')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
    expect(prisma.travelSightseeing.findMany.mock.calls[0][0].take).toBe(200);

    res = await request(makeApp())
      .get('/api/travel/sightseeing?limit=0')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1);
    expect(prisma.travelSightseeing.findMany.mock.calls[1][0].take).toBe(1);
  });

  test('MANAGER subBrandAccess=["rfu"] threads OR clause (nullable subBrand)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    const res = await request(makeApp())
      .get('/api/travel/sightseeing')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelSightseeing.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.OR).toEqual([
      { subBrand: null },
      { subBrand: { in: ['rfu'] } },
    ]);
  });

  test('?destinationName + ?category + ?isActive filters thread into where', async () => {
    const res = await request(makeApp())
      .get('/api/travel/sightseeing?destinationName=Paris&category=monument&isActive=true')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelSightseeing.findMany.mock.calls[0][0];
    expect(call.where.destinationName).toBe('Paris');
    expect(call.where.category).toBe('monument');
    expect(call.where.isActive).toBe(true);
  });
});

describe('POST /api/travel/sightseeing — create', () => {
  test('ADMIN happy path → 201', async () => {
    prisma.travelSightseeing.create.mockResolvedValue({
      id: 999,
      tenantId: 1,
      destinationName: 'Tokyo',
      name: 'Sensoji Temple',
      durationMinutes: 90,
      priceReferenceMinor: null,
      currency: 'JPY',
      category: 'religious',
      subBrand: null,
      isActive: true,
    });

    const res = await request(makeApp())
      .post('/api/travel/sightseeing')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        destinationName: 'Tokyo',
        name: 'Sensoji Temple',
        durationMinutes: 90,
        currency: 'JPY',
        category: 'religious',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(999);
    expect(res.body.name).toBe('Sensoji Temple');
    expect(prisma.travelSightseeing.create).toHaveBeenCalled();
    const data = prisma.travelSightseeing.create.mock.calls[0][0].data;
    expect(data.tenantId).toBe(1);
    expect(data.destinationName).toBe('Tokyo');
    expect(data.currency).toBe('JPY');
  });

  test('missing destinationName → 400 MISSING_DESTINATION', async () => {
    const res = await request(makeApp())
      .post('/api/travel/sightseeing')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Anonymous Park' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DESTINATION');
    expect(prisma.travelSightseeing.create).not.toHaveBeenCalled();
  });

  test('missing name → 400 MISSING_NAME', async () => {
    const res = await request(makeApp())
      .post('/api/travel/sightseeing')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ destinationName: 'Paris' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_NAME');
    expect(prisma.travelSightseeing.create).not.toHaveBeenCalled();
  });

  test('invalid lowercase currency "usd" → 400 INVALID_CURRENCY', async () => {
    const res = await request(makeApp())
      .post('/api/travel/sightseeing')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        destinationName: 'Paris',
        name: 'Louvre',
        currency: 'usd',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURRENCY');
    expect(prisma.travelSightseeing.create).not.toHaveBeenCalled();
  });

  test('USER role → 403 (verifyRole gate; create blocked)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/sightseeing')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ destinationName: 'Paris', name: 'Louvre' });

    expect(res.status).toBe(403);
    expect(prisma.travelSightseeing.create).not.toHaveBeenCalled();
  });

  test('MANAGER with subBrandAccess=["rfu"] cannot create under "travelstall" → 403 FORBIDDEN_SUB_BRAND', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    const res = await request(makeApp())
      .post('/api/travel/sightseeing')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({
        destinationName: 'Paris',
        name: 'Louvre',
        subBrand: 'travelstall',
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_SUB_BRAND');
    expect(prisma.travelSightseeing.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/travel/sightseeing/:id', () => {
  test('found → 200 + row', async () => {
    prisma.travelSightseeing.findFirst.mockResolvedValue(sampleRows[0]);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/101')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(101);
    expect(res.body.name).toBe('Eiffel Tower');
  });

  test('invalid id "abc" → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/sightseeing/abc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.travelSightseeing.findFirst).not.toHaveBeenCalled();
  });

  test('not found → 404 SIGHTSEEING_NOT_FOUND', async () => {
    prisma.travelSightseeing.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/sightseeing/9999')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SIGHTSEEING_NOT_FOUND');
  });
});

describe('PATCH /api/travel/sightseeing/:id', () => {
  test('ADMIN happy path → 200 + updated', async () => {
    prisma.travelSightseeing.findFirst.mockResolvedValue(sampleRows[0]);
    prisma.travelSightseeing.update.mockResolvedValue({
      ...sampleRows[0],
      durationMinutes: 180,
    });

    const res = await request(makeApp())
      .patch('/api/travel/sightseeing/101')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ durationMinutes: 180 });

    expect(res.status).toBe(200);
    expect(res.body.durationMinutes).toBe(180);
    const updateCall = prisma.travelSightseeing.update.mock.calls[0][0];
    expect(updateCall.where.id).toBe(101);
    expect(updateCall.data.durationMinutes).toBe(180);
  });

  test('empty body → 400 EMPTY_BODY', async () => {
    prisma.travelSightseeing.findFirst.mockResolvedValue(sampleRows[0]);

    const res = await request(makeApp())
      .patch('/api/travel/sightseeing/101')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_BODY');
    expect(prisma.travelSightseeing.update).not.toHaveBeenCalled();
  });

  test('USER role → 403 (verifyRole gate)', async () => {
    const res = await request(makeApp())
      .patch('/api/travel/sightseeing/101')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ durationMinutes: 180 });

    expect(res.status).toBe(403);
    expect(prisma.travelSightseeing.update).not.toHaveBeenCalled();
  });

  test('not found → 404 SIGHTSEEING_NOT_FOUND', async () => {
    prisma.travelSightseeing.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .patch('/api/travel/sightseeing/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SIGHTSEEING_NOT_FOUND');
    expect(prisma.travelSightseeing.update).not.toHaveBeenCalled();
  });

  test('invalid currency on PATCH → 400 INVALID_CURRENCY', async () => {
    prisma.travelSightseeing.findFirst.mockResolvedValue(sampleRows[0]);

    const res = await request(makeApp())
      .patch('/api/travel/sightseeing/101')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ currency: 'eur' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURRENCY');
    expect(prisma.travelSightseeing.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/travel/sightseeing/:id — soft delete', () => {
  test('ADMIN sets isActive=false (does NOT actually destroy)', async () => {
    prisma.travelSightseeing.findFirst.mockResolvedValue(sampleRows[0]);
    prisma.travelSightseeing.update.mockResolvedValue({
      ...sampleRows[0],
      isActive: false,
    });

    const res = await request(makeApp())
      .delete('/api/travel/sightseeing/101')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    const updateCall = prisma.travelSightseeing.update.mock.calls[0][0];
    expect(updateCall.where.id).toBe(101);
    expect(updateCall.data).toEqual({ isActive: false });
  });

  test('MANAGER role → 403 (ADMIN-only gate)', async () => {
    const res = await request(makeApp())
      .delete('/api/travel/sightseeing/101')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(prisma.travelSightseeing.update).not.toHaveBeenCalled();
  });

  test('not found → 404 SIGHTSEEING_NOT_FOUND', async () => {
    prisma.travelSightseeing.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .delete('/api/travel/sightseeing/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SIGHTSEEING_NOT_FOUND');
    expect(prisma.travelSightseeing.update).not.toHaveBeenCalled();
  });
});
