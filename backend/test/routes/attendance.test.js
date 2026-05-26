// @ts-check
/**
 * Unit + integration tests for backend/routes/attendance.js — pins the route
 * contract for self-service clock-in / clock-out, history endpoints (/me +
 * /staff/:userId), biometric device CRUD, and the public biometric webhook.
 *
 * Scope split with the existing companion attendance-summary.test.js:
 *   - This file covers ALL routes except GET /summary (which has its own
 *     dedicated companion pinning #802 + #804 additive contract).
 *   - We deliberately don't duplicate /summary coverage here.
 *
 * What this file pins
 * ───────────────────
 *   /clock-in:
 *     1. First clock-in of the day creates an Attendance row, anchored to
 *        00:00 UTC of the calendar day, source=MANUAL, 201 response.
 *     2. Duplicate clock-in returns 409 ALREADY_CLOCKED_IN with the existing row.
 *     3. Missing Authorization → 401 (verifyToken gate).
 *
 *   /clock-out:
 *     4. Clock-out without prior clock-in returns 409 NO_OPEN_CLOCK_IN.
 *     5. Duplicate clock-out (clockOutAt already set) returns 409 ALREADY_CLOCKED_OUT.
 *     6. Successful clock-out computes totalMinutes + sets status=PRESENT
 *        for shifts ≥ 4h, HALF_DAY for shorter ones.
 *
 *   /me history:
 *     7. Scopes prisma.attendance.findMany by req.user.tenantId AND req.user.userId.
 *     8. Inverted date range (to < from) returns 400 INVERTED_DATE_RANGE
 *        (#665 validateDateRange).
 *
 *   /staff/:userId history (manager + admin only):
 *     9. USER role → 403 (verifyRole gate).
 *    10. Target user must exist in caller's tenant; otherwise 404
 *        USER_NOT_FOUND. This is the existence-leak guard noted in the
 *        route header.
 *    11. Non-numeric userId param → 400 INVALID_USER_ID.
 *
 *   /devices CRUD:
 *    12. GET /devices omits apiKey from the response shape (rotation = destroy
 *        + recreate; apiKey is returned only once on POST).
 *    13. POST /devices without deviceId → 400 DEVICE_ID_REQUIRED.
 *    14. POST /devices duplicate (Prisma P2002) → 409 DEVICE_ID_DUPLICATE.
 *    15. POST /devices as MANAGER (non-ADMIN) → 403 (verifyRole gate).
 *
 *   /biometric/webhook (public, X-API-Key authed):
 *    16. Missing X-API-Key → 401 API_KEY_REQUIRED.
 *    17. Unknown / inactive key → 401 INVALID_DEVICE_KEY (no tenant leak).
 *    18. Invalid eventType → 400 INVALID_EVENT_TYPE.
 *    19. Body deviceId mismatching the key's device → 400 DEVICE_MISMATCH.
 *    20. Idempotent retry: same-second clock_in returns 200 with dedup=true,
 *        does NOT create a duplicate attendance row.
 *    21. Successful clock_in via webhook creates a row with source=BIOMETRIC
 *        and the device's tenantId (NOT a body-claimed tenantId — cross-
 *        tenant device-key abuse is structurally impossible).
 *
 * Test pattern mirrors backend/test/routes/attendance-summary.test.js —
 * prisma singleton monkey-patch, supertest with a real verifyToken middleware
 * fed a signed JWT.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── Prisma singleton patching. Must happen BEFORE the router is required. ──
prisma.attendance = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.leaveRequest = prisma.leaveRequest || {};
prisma.leaveRequest.findMany = vi.fn().mockResolvedValue([]);
prisma.user = prisma.user || {};
prisma.user.findFirst = vi.fn();
prisma.biometricDevice = prisma.biometricDevice || {};
prisma.biometricDevice.findMany = vi.fn();
prisma.biometricDevice.findFirst = vi.fn();
prisma.biometricDevice.findUnique = vi.fn();
prisma.biometricDevice.create = vi.fn();
prisma.biometricDevice.update = vi.fn();
prisma.biometricDevice.delete = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// Patch the prisma singleton models touched by the writeAudit helper
// (lib/audit.js) and the emitEvent helper (lib/eventBus.js). Both are
// required transitively via the CJS route module, so we can't use vi.mock
// (which only intercepts ESM imports). Patching the singleton makes the
// real helpers run with stubbed prisma calls — they no-op cleanly without
// touching the DB.
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({});
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.notification = prisma.notification || {};
prisma.notification.create = vi.fn().mockResolvedValue({});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const attendanceRouter = requireCJS('../../routes/attendance');

// Keep in sync with backend/middleware/auth.js fallback.
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function tokenFor({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/attendance', attendanceRouter);
  return app;
}

function authedReq(method, url, { tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const token = tokenFor({ tenantId, userId, role });
  return request(makeApp())[method](url).set('Authorization', `Bearer ${token}`);
}

beforeEach(() => {
  prisma.attendance.findMany.mockReset();
  prisma.attendance.findUnique.mockReset();
  prisma.attendance.create.mockReset();
  prisma.attendance.update.mockReset();
  prisma.user.findFirst.mockReset();
  prisma.biometricDevice.findMany.mockReset();
  prisma.biometricDevice.findFirst.mockReset();
  prisma.biometricDevice.findUnique.mockReset();
  prisma.biometricDevice.create.mockReset();
  prisma.biometricDevice.update.mockReset();
  prisma.biometricDevice.delete.mockReset();
  prisma.attendance.findMany.mockResolvedValue([]);
  prisma.attendance.findUnique.mockResolvedValue(null);
  prisma.biometricDevice.findMany.mockResolvedValue([]);
});

// ── /clock-in ──────────────────────────────────────────────────────────

describe('POST /clock-in', () => {
  test('first punch-in of the day creates an Attendance row anchored to 00:00 UTC, source=MANUAL', async () => {
    prisma.attendance.findUnique.mockResolvedValue(null);
    const createdRow = {
      id: 501,
      tenantId: 1,
      userId: 7,
      date: new Date('2026-05-25T00:00:00.000Z'),
      clockInAt: new Date(),
      source: 'MANUAL',
    };
    prisma.attendance.create.mockResolvedValue(createdRow);

    const res = await authedReq('post', '/api/attendance/clock-in').send({});

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(501);
    expect(prisma.attendance.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.attendance.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.userId).toBe(7);
    expect(createArgs.data.source).toBe('MANUAL');
    // date is anchored to 00:00 UTC of the calendar day
    const d = createArgs.data.date;
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
  });

  test('duplicate clock-in returns 409 ALREADY_CLOCKED_IN with the existing row', async () => {
    const existing = {
      id: 99,
      tenantId: 1,
      userId: 7,
      date: new Date('2026-05-25T00:00:00.000Z'),
      clockInAt: new Date(),
      clockOutAt: null,
    };
    prisma.attendance.findUnique.mockResolvedValue(existing);

    const res = await authedReq('post', '/api/attendance/clock-in').send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_CLOCKED_IN');
    expect(res.body.attendance.id).toBe(99);
    expect(prisma.attendance.create).not.toHaveBeenCalled();
  });

  test('missing Authorization → 401 (verifyToken gate)', async () => {
    const res = await request(makeApp()).post('/api/attendance/clock-in').send({});
    expect(res.status).toBe(401);
  });
});

// ── /clock-out ─────────────────────────────────────────────────────────

describe('POST /clock-out', () => {
  test('clock-out with no prior clock-in returns 409 NO_OPEN_CLOCK_IN', async () => {
    prisma.attendance.findUnique.mockResolvedValue(null);

    const res = await authedReq('post', '/api/attendance/clock-out').send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_OPEN_CLOCK_IN');
    expect(prisma.attendance.update).not.toHaveBeenCalled();
  });

  test('duplicate clock-out (clockOutAt already set) returns 409 ALREADY_CLOCKED_OUT', async () => {
    prisma.attendance.findUnique.mockResolvedValue({
      id: 50,
      tenantId: 1,
      userId: 7,
      date: new Date('2026-05-25T00:00:00.000Z'),
      clockInAt: new Date(Date.now() - 60 * 60 * 1000),
      clockOutAt: new Date(Date.now() - 30 * 60 * 1000),
    });

    const res = await authedReq('post', '/api/attendance/clock-out').send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_CLOCKED_OUT');
    expect(prisma.attendance.update).not.toHaveBeenCalled();
  });

  test('successful clock-out: shift ≥ 4h sets status=PRESENT and computes totalMinutes', async () => {
    const clockInAt = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago
    prisma.attendance.findUnique.mockResolvedValue({
      id: 75,
      tenantId: 1,
      userId: 7,
      date: new Date('2026-05-25T00:00:00.000Z'),
      clockInAt,
      clockOutAt: null,
    });
    prisma.attendance.update.mockImplementation(({ where, data }) => ({
      id: where.id,
      tenantId: 1,
      userId: 7,
      clockInAt,
      clockOutAt: data.clockOutAt,
      totalMinutes: data.totalMinutes,
      status: data.status,
    }));

    const res = await authedReq('post', '/api/attendance/clock-out').send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PRESENT');
    expect(res.body.totalMinutes).toBeGreaterThanOrEqual(299);
    expect(res.body.totalMinutes).toBeLessThanOrEqual(301);
  });

  test('clock-out for a short shift (<4h) sets status=HALF_DAY', async () => {
    const clockInAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    prisma.attendance.findUnique.mockResolvedValue({
      id: 76,
      tenantId: 1,
      userId: 7,
      date: new Date('2026-05-25T00:00:00.000Z'),
      clockInAt,
      clockOutAt: null,
    });
    prisma.attendance.update.mockImplementation(({ where, data }) => ({
      id: where.id,
      clockOutAt: data.clockOutAt,
      totalMinutes: data.totalMinutes,
      status: data.status,
    }));

    const res = await authedReq('post', '/api/attendance/clock-out').send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('HALF_DAY');
  });
});

// ── /me history ────────────────────────────────────────────────────────

describe('GET /me history', () => {
  test('scopes attendance.findMany by req.user.tenantId AND req.user.userId', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    await authedReq('get', '/api/attendance/me?from=2026-01-01&to=2026-01-31', { tenantId: 42, userId: 99 });

    expect(prisma.attendance.findMany).toHaveBeenCalledTimes(1);
    const where = prisma.attendance.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(42);
    expect(where.userId).toBe(99);
    expect(where.date).toEqual({
      gte: new Date('2026-01-01'),
      lte: new Date('2026-01-31'),
    });
  });

  test('inverted date range (to < from) returns 400 INVERTED_DATE_RANGE (#665)', async () => {
    const res = await authedReq('get', '/api/attendance/me?from=2026-01-31&to=2026-01-01');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVERTED_DATE_RANGE');
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
  });
});

// ── /staff/:userId history ─────────────────────────────────────────────

describe('GET /staff/:userId history', () => {
  test('USER role bearer → 403 (verifyRole gate)', async () => {
    const res = await authedReq('get', '/api/attendance/staff/100', { role: 'USER' });
    expect(res.status).toBe(403);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  test('target user not in caller tenant → 404 USER_NOT_FOUND (existence-leak guard)', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    const res = await authedReq('get', '/api/attendance/staff/100', { tenantId: 1, role: 'ADMIN' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
    // Tenant scope was applied to the user lookup — important; otherwise an
    // admin in tenant 1 could read user metadata for tenant 2's userIds.
    expect(prisma.user.findFirst.mock.calls[0][0].where.tenantId).toBe(1);
    expect(prisma.user.findFirst.mock.calls[0][0].where.id).toBe(100);
    expect(prisma.attendance.findMany).not.toHaveBeenCalled();
  });

  test('non-numeric userId param → 400 INVALID_USER_ID', async () => {
    const res = await authedReq('get', '/api/attendance/staff/not-a-number', { role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_USER_ID');
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});

// ── /devices CRUD ──────────────────────────────────────────────────────

describe('GET /devices', () => {
  test('omits apiKey from the response shape (rotation = destroy + recreate)', async () => {
    prisma.biometricDevice.findMany.mockResolvedValue([
      {
        id: 1, tenantId: 1, locationId: null, deviceId: 'BIO-001',
        vendor: 'ZKTeco', lastSyncAt: null, isActive: true,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      },
    ]);

    const res = await authedReq('get', '/api/attendance/devices', { role: 'ADMIN' });

    expect(res.status).toBe(200);
    // Verify the select clause omits apiKey
    const selectArgs = prisma.biometricDevice.findMany.mock.calls[0][0].select;
    expect(selectArgs.apiKey).toBeUndefined();
    expect(selectArgs.deviceId).toBe(true);
    expect(selectArgs.vendor).toBe(true);
    // And the returned rows therefore lack it
    expect(res.body[0].apiKey).toBeUndefined();
    expect(res.body[0].deviceId).toBe('BIO-001');
  });
});

describe('POST /devices', () => {
  test('missing deviceId → 400 DEVICE_ID_REQUIRED', async () => {
    const res = await authedReq('post', '/api/attendance/devices', { role: 'ADMIN' })
      .send({ vendor: 'ZKTeco' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DEVICE_ID_REQUIRED');
    expect(prisma.biometricDevice.create).not.toHaveBeenCalled();
  });

  test('duplicate deviceId (Prisma P2002) → 409 DEVICE_ID_DUPLICATE', async () => {
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    prisma.biometricDevice.create.mockRejectedValue(p2002);

    const res = await authedReq('post', '/api/attendance/devices', { role: 'ADMIN' })
      .send({ deviceId: 'BIO-001', vendor: 'ZKTeco' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEVICE_ID_DUPLICATE');
  });

  test('MANAGER role → 403 (only ADMIN can register devices)', async () => {
    const res = await authedReq('post', '/api/attendance/devices', { role: 'MANAGER' })
      .send({ deviceId: 'BIO-001', vendor: 'ZKTeco' });

    expect(res.status).toBe(403);
    expect(prisma.biometricDevice.create).not.toHaveBeenCalled();
  });
});

// ── /biometric/webhook (public, X-API-Key authed) ──────────────────────

describe('POST /biometric/webhook', () => {
  test('missing X-API-Key → 401 API_KEY_REQUIRED', async () => {
    const res = await request(makeApp())
      .post('/api/attendance/biometric/webhook')
      .send({ deviceId: 'BIO-001', userExternalId: '7', eventType: 'clock_in' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('API_KEY_REQUIRED');
    expect(prisma.biometricDevice.findUnique).not.toHaveBeenCalled();
  });

  test('unknown or inactive key → 401 INVALID_DEVICE_KEY (no tenant leak)', async () => {
    prisma.biometricDevice.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/attendance/biometric/webhook')
      .set('X-API-Key', 'bio_unknown')
      .send({ deviceId: 'BIO-001', userExternalId: '7', eventType: 'clock_in' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_DEVICE_KEY');
  });

  test('invalid eventType → 400 INVALID_EVENT_TYPE', async () => {
    prisma.biometricDevice.findUnique.mockResolvedValue({
      id: 1, tenantId: 1, deviceId: 'BIO-001', apiKey: 'bio_xyz', isActive: true, locationId: null,
    });

    const res = await request(makeApp())
      .post('/api/attendance/biometric/webhook')
      .set('X-API-Key', 'bio_xyz')
      .send({ deviceId: 'BIO-001', userExternalId: '7', eventType: 'lunch_break' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_EVENT_TYPE');
  });

  test('body deviceId mismatching key device → 400 DEVICE_MISMATCH', async () => {
    prisma.biometricDevice.findUnique.mockResolvedValue({
      id: 1, tenantId: 1, deviceId: 'BIO-001', apiKey: 'bio_xyz', isActive: true, locationId: null,
    });

    const res = await request(makeApp())
      .post('/api/attendance/biometric/webhook')
      .set('X-API-Key', 'bio_xyz')
      .send({ deviceId: 'BIO-OTHER', userExternalId: '7', eventType: 'clock_in' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DEVICE_MISMATCH');
  });

  test('idempotent retry: same-second clock_in returns 200 with dedup=true', async () => {
    const ts = '2026-05-25T09:00:00.000Z';
    const existing = {
      id: 999, tenantId: 1, userId: 7,
      date: new Date('2026-05-25T00:00:00.000Z'),
      clockInAt: new Date(ts), // same instant as incoming ts
      clockOutAt: null,
    };
    prisma.biometricDevice.findUnique.mockResolvedValue({
      id: 1, tenantId: 1, deviceId: 'BIO-001', apiKey: 'bio_xyz', isActive: true, locationId: null,
    });
    prisma.user.findFirst.mockResolvedValue({ id: 7 });
    prisma.attendance.findUnique.mockResolvedValue(existing);

    const res = await request(makeApp())
      .post('/api/attendance/biometric/webhook')
      .set('X-API-Key', 'bio_xyz')
      .send({ deviceId: 'BIO-001', userExternalId: '7', eventType: 'clock_in', timestamp: ts });

    expect(res.status).toBe(200);
    expect(res.body.dedup).toBe(true);
    expect(res.body.attendance.id).toBe(999);
    // CRITICAL: no duplicate row created on retry
    expect(prisma.attendance.create).not.toHaveBeenCalled();
    expect(prisma.attendance.update).not.toHaveBeenCalled();
  });

  test('successful clock_in derives tenantId from device, not body — cross-tenant abuse impossible', async () => {
    prisma.biometricDevice.findUnique.mockResolvedValue({
      id: 1,
      tenantId: 42, // device belongs to tenant 42
      deviceId: 'BIO-001',
      apiKey: 'bio_xyz',
      isActive: true,
      locationId: 5,
    });
    prisma.user.findFirst.mockResolvedValue({ id: 7 });
    prisma.attendance.findUnique.mockResolvedValue(null);
    prisma.attendance.create.mockImplementation(({ data }) => ({
      id: 1234,
      ...data,
    }));
    prisma.biometricDevice.update.mockResolvedValue({ id: 1 });

    const res = await request(makeApp())
      .post('/api/attendance/biometric/webhook')
      .set('X-API-Key', 'bio_xyz')
      .send({
        deviceId: 'BIO-001',
        userExternalId: '7',
        eventType: 'clock_in',
        timestamp: '2026-05-25T09:00:00.000Z',
      });

    expect(res.status).toBe(201);
    expect(res.body.dedup).toBe(false);
    // Tenant scope on the user lookup was the device's tenant (42), not anything the body could influence.
    expect(prisma.user.findFirst.mock.calls[0][0].where.tenantId).toBe(42);
    // The created attendance row inherits the device's tenantId.
    const createArgs = prisma.attendance.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(42);
    expect(createArgs.data.source).toBe('BIOMETRIC');
    expect(createArgs.data.biometricDeviceId).toBe(1);
    expect(createArgs.data.clockInLocationId).toBe(5);
  });
});
