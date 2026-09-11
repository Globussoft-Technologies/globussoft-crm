// @ts-check
import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);

vi.hoisted(() => {
  const { createRequire } = require('node:module');
  const hoistedRequire = createRequire(__filename || process.cwd() + '/');

  const auth = hoistedRequire('../../middleware/auth');
  auth.verifyToken = (req, res, next) => {
    if (req.headers['x-test-staff-auth'] !== 'yes') {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = { userId: 9, tenantId: 7, role: 'USER' };
    next();
  };

  const travelGuards = hoistedRequire('../../middleware/travelGuards');
  travelGuards.requireTravelTenant = (req, _res, next) => {
    req.travelTenant = { id: req.user.tenantId, vertical: 'travel' };
    next();
  };

  const permissions = hoistedRequire('../../middleware/requirePermission');
  permissions.requireAnyPermission = () => (req, res, next) => {
    if (req.headers['x-test-permission'] !== 'trips.update') {
      return res.status(403).json({ error: 'Forbidden', code: 'PERMISSION_DENIED' });
    }
    next();
  };
});

prisma.tenant = { ...(prisma.tenant || {}), findUnique: vi.fn() };
prisma.contact = { ...(prisma.contact || {}), findFirst: vi.fn(), findMany: vi.fn() };
prisma.tmcTrip = { ...(prisma.tmcTrip || {}), findMany: vi.fn(), findFirst: vi.fn() };
prisma.tripParticipant = { ...(prisma.tripParticipant || {}), findMany: vi.fn() };
prisma.pendingTripRegistration = { ...(prisma.pendingTripRegistration || {}), findMany: vi.fn() };
prisma.tmcParentTrip = { ...(prisma.tmcParentTrip || {}), findMany: vi.fn() };

const { JWT_SECRET } = requireCJS('../../config/secrets');
const router = requireCJS('../../routes/tmc_portal');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal/tmc', router);
  return app;
}

function portalToken(overrides = {}) {
  return jwt.sign({
    type: 'PORTAL',
    contactId: 41,
    tenantId: 7,
    ...overrides,
  }, JWT_SECRET, { expiresIn: '10m' });
}

function bearer(token = portalToken()) {
  return { Authorization: `Bearer ${token}` };
}

function contact(persona, overrides = {}) {
  return {
    id: 41,
    name: `${persona} Contact`,
    email: `${persona.toLowerCase()}@example.test`,
    phone: null,
    subBrand: 'tmc',
    portalRole: persona,
    ...overrides,
  };
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 7, vertical: 'travel', slug: 'tmc' });
  prisma.contact.findFirst.mockReset();
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcTrip.findFirst.mockReset();
  prisma.tripParticipant.findMany.mockReset().mockResolvedValue([]);
  prisma.pendingTripRegistration.findMany.mockReset().mockResolvedValue([]);
  prisma.tmcParentTrip.findMany.mockReset().mockResolvedValue([]);
});

describe('TMC portal authentication and tenant isolation', () => {
  test('teacher routes reject missing portal JWTs before querying tenant data', async () => {
    const res = await request(makeApp()).get('/api/portal/tmc/teacher/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('PORTAL_TOKEN_REQUIRED');
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('teacher identity lookup requires both contact id and token tenant id', async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/portal/tmc/teacher/me')
      .set(bearer());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PORTAL_CONTACT_NOT_FOUND');
    expect(prisma.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 41, tenantId: 7, deletedAt: null },
    }));
  });

  test('teacher trip listing is scoped to the authenticated tenant and teacher', async () => {
    prisma.contact.findFirst.mockResolvedValue(contact('TEACHER'));
    const res = await request(makeApp())
      .get('/api/portal/tmc/teacher/trips')
      .set(bearer());

    expect(res.status).toBe(200);
    expect(prisma.tmcTrip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, teacherContactId: 41 },
    }));
  });
});

describe('TMC parent trip isolation', () => {
  test('a parent link grants only its explicit trip, not every trip owned by that teacher', async () => {
    prisma.contact.findFirst.mockResolvedValue(contact('PARENT'));
    prisma.tmcParentTrip.findMany.mockResolvedValue([
      { id: 1, tripId: 501, createdAt: new Date(), teacher: { id: 70 }, trip: { id: 501, landingPage: null } },
    ]);
    prisma.tmcTrip.findMany.mockResolvedValue([{ id: 501, tripCode: 'TMC-501', landingPage: null }]);

    const res = await request(makeApp())
      .get('/api/portal/tmc/parent/trips')
      .set(bearer());

    expect(res.status).toBe(200);
    expect(res.body.trips.map((trip) => trip.id)).toEqual([501]);
    expect(prisma.tmcTrip.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenantId: 7,
        id: { in: [501] },
        status: { not: 'cancelled' },
      },
    }));
  });
});

describe('TMC staff permission enforcement', () => {
  test('staff teacher directory rejects authenticated users without an allowed permission', async () => {
    const res = await request(makeApp())
      .get('/api/portal/tmc/staff/teachers')
      .set('x-test-staff-auth', 'yes');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('authorized staff query remains tenant scoped', async () => {
    const res = await request(makeApp())
      .get('/api/portal/tmc/staff/teachers')
      .set('x-test-staff-auth', 'yes')
      .set('x-test-permission', 'trips.update');
    expect(res.status).toBe(200);
    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, subBrand: 'tmc', portalRole: 'TEACHER', deletedAt: null },
    }));
  });
});
