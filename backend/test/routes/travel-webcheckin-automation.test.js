// @ts-check
/**
 * Travel CRM — web check-in AUTOMATION route additions
 * (PRD_AIRLINE_WEBCHECKIN_AUTOMATION FR-8/FR-11/FR-12). Pins the three
 * surfaces added to routes/travel_webcheckin.js:
 *
 *   POST /api/travel/webcheckins/:id/automation/retry
 *     - 200 → status reset to 'reminded', attemptsJson cleared
 *     - 409 ALREADY_DONE when status='done'
 *     - 409 AUTOMATION_SKIPPED when automationSkipped=true
 *     - 404 NOT_FOUND cross-tenant
 *   PATCH /api/travel/webcheckins/:id
 *     - automationSkipped=true persisted
 *   GET /api/travel/automation-health/per-airline
 *     - rolling 24h per-airline rollup; successRate excludes not-implemented
 *
 * Mirrors travel-webcheckin.test.js — patch the prisma singleton before
 * requiring the router; drive supertest with real HS256 JWTs; full guard
 * chain (verifyToken + requirePermission + requireTravelTenant) stays live.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.webCheckin = {
  findFirst: vi.fn(),
  update: vi.fn(),
};
prisma.webCheckinAutomationRun = { findMany: vi.fn() };
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
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
  return jwt.sign({ userId, tenantId, role, email: `${role.toLowerCase()}@test.local` }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  prisma.webCheckin.findFirst.mockReset();
  prisma.webCheckin.update.mockReset();
  prisma.webCheckinAutomationRun.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 1, vertical: 'travel', name: 'T', slug: 't' });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('POST /api/travel/webcheckins/:id/automation/retry', () => {
  test('200 → resets status to reminded + clears attemptsJson', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue({ id: 5, tenantId: 1, status: 'fallback-agent', automationSkipped: false });
    prisma.webCheckin.update.mockImplementation(async ({ data }) => ({ id: 5, ...data }));
    const res = await request(makeApp())
      .post('/api/travel/webcheckins/5/automation/retry')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prisma.webCheckin.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { status: 'reminded', attemptsJson: null },
    });
  });

  test('409 ALREADY_DONE when status=done', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue({ id: 5, tenantId: 1, status: 'done', automationSkipped: false });
    const res = await request(makeApp())
      .post('/api/travel/webcheckins/5/automation/retry')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_DONE');
    expect(prisma.webCheckin.update).not.toHaveBeenCalled();
  });

  test('409 AUTOMATION_SKIPPED when automationSkipped=true', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue({ id: 5, tenantId: 1, status: 'reminded', automationSkipped: true });
    const res = await request(makeApp())
      .post('/api/travel/webcheckins/5/automation/retry')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AUTOMATION_SKIPPED');
  });

  test('404 NOT_FOUND cross-tenant', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/webcheckins/999/automation/retry')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .post('/api/travel/webcheckins/5/automation/retry')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/travel/webcheckins/:id — automationSkipped', () => {
  test('persists automationSkipped=true', async () => {
    prisma.webCheckin.findFirst.mockResolvedValue({ id: 5, tenantId: 1, status: 'reminded' });
    prisma.webCheckin.update.mockImplementation(async ({ data }) => ({ id: 5, ...data }));
    const res = await request(makeApp())
      .patch('/api/travel/webcheckins/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ automationSkipped: true });
    expect(res.status).toBe(200);
    expect(prisma.webCheckin.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: expect.objectContaining({ automationSkipped: true }),
    });
  });
});

describe('GET /api/travel/automation-health/per-airline', () => {
  test('rolls up per airline; successRate excludes not-implemented', async () => {
    const t = (mins) => new Date(Date.now() - mins * 60000);
    prisma.webCheckinAutomationRun.findMany.mockResolvedValue([
      // 6E: 2 success, 1 failure, 1 not-implemented → rate = 2/3
      { airlineCode: '6E', outcome: 'success', createdAt: t(5) },
      { airlineCode: '6E', outcome: 'failure', createdAt: t(10) },
      { airlineCode: '6E', outcome: 'success', createdAt: t(15) },
      { airlineCode: '6E', outcome: 'not-implemented', createdAt: t(20) },
      // EK: only not-implemented → rate = null (no real attempts)
      { airlineCode: 'EK', outcome: 'not-implemented', createdAt: t(8) },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/automation-health/per-airline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.windowHours).toBe(24);
    const six = res.body.perAirline.find((a) => a.airlineCode === '6E');
    expect(six).toMatchObject({ total: 4, success: 2, failure: 1, notImplemented: 1 });
    expect(six.successRate).toBeCloseTo(0.667, 2);
    expect(six.lastFailureAt).toBeTruthy();
    const ek = res.body.perAirline.find((a) => a.airlineCode === 'EK');
    expect(ek.successRate).toBeNull();
  });

  test('respects windowHours query (clamped) and tenant scoping', async () => {
    prisma.webCheckinAutomationRun.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/automation-health/per-airline?windowHours=48')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.windowHours).toBe(48);
    expect(prisma.webCheckinAutomationRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 1 }) }),
    );
  });
});
