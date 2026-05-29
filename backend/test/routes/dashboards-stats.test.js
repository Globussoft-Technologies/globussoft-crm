// @ts-check
/**
 * CRM polish — pin GET /api/dashboards/stats contract.
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: missing Authorization header -> 401.
 *   - 400 INVALID_DATE on bad ?from / ?to (independent validation).
 *   - Empty-tenant: zeroed envelope with byVisibility={shared:0,private:0} +
 *     defaultDashboardId=null + byOwner=[] + lastCreatedAt=null.
 *   - Happy path: mixed shared/private/default rows -> total + byVisibility
 *     + defaultDashboardId + totalOwners + byOwner + lastCreatedAt correct.
 *   - byVisibility classification: userId=null -> shared; userId set -> private.
 *   - defaultDashboardId: id of row where isDefault=true, else null.
 *   - byOwner: top 5 by count (ties broken by ascending userId); shared
 *     rows (userId=null) excluded from the owner buckets.
 *   - totalOwners: distinct userId count among PRIVATE rows.
 *   - lastCreatedAt: max(createdAt) across selected rows, ISO string.
 *   - Tenant isolation: where.tenantId = req.user.tenantId on prisma.dashboard.findMany.
 *   - ?from / ?to narrows the window via createdAt gte/lte on the same call.
 *   - NO audit row written (read-only meta surface).
 *   - Route ordering: /stats path resolves BEFORE /:id (literal beats wildcard).
 *
 * Schema notes (verified against prisma/schema.prisma:2347-2357)
 * ------------------------------------------------------------
 *   - Dashboard.{ id, name, isDefault (bool), layout, userId (nullable),
 *     tenantId, createdAt, updatedAt }.
 *   - NO visibility column — shared/private is derived from userId
 *     (null = shared/tenant-wide, set = private to that user).
 *
 * Pattern reference: landing-pages-stats.test.js — patches the prisma
 * singleton with vi.fn() BEFORE requiring the router, drives supertest
 * with HS256 JWTs signed against the dev-fallback secret. dashboards.js
 * mounts router.use(verifyToken) at the router level so the 401-gate
 * case can be exercised in isolation.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.dashboard = prisma.dashboard || {};
prisma.dashboard.findMany = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.fieldPermission = prisma.fieldPermission || {};
prisma.fieldPermission.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const dashboardsRouter = requireCJS('../../routes/dashboards');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/dashboards', dashboardsRouter);
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
  prisma.dashboard.findMany.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/dashboards/stats', () => {
  test('auth gate: missing Authorization header -> 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/dashboards/stats');
    expect(res.status).toBe(401);
    expect(prisma.dashboard.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/dashboards/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.dashboard.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/dashboards/stats?to=also-not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.dashboard.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope', async () => {
    prisma.dashboard.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/dashboards/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byVisibility: { shared: 0, private: 0 },
      defaultDashboardId: null,
      totalOwners: 0,
      byOwner: [],
      lastCreatedAt: null,
    });
  });

  test('happy path: mixed shared/private/default -> total + byVisibility + default + owners correct', async () => {
    prisma.dashboard.findMany.mockResolvedValue([
      { id: 1, isDefault: true,  userId: null, createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 2, isDefault: false, userId: null, createdAt: new Date('2026-05-02T10:00:00Z') },
      { id: 3, isDefault: false, userId: 11,   createdAt: new Date('2026-05-03T10:00:00Z') },
      { id: 4, isDefault: false, userId: 11,   createdAt: new Date('2026-05-04T10:00:00Z') },
      { id: 5, isDefault: false, userId: 12,   createdAt: new Date('2026-05-05T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/dashboards/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byVisibility).toEqual({ shared: 2, private: 3 });
    expect(res.body.defaultDashboardId).toBe(1);
    expect(res.body.totalOwners).toBe(2);
    expect(res.body.byOwner).toEqual([
      { userId: 11, count: 2 },
      { userId: 12, count: 1 },
    ]);
    expect(res.body.lastCreatedAt).toBe(new Date('2026-05-05T10:00:00Z').toISOString());
  });

  test('defaultDashboardId is null when no row has isDefault=true', async () => {
    prisma.dashboard.findMany.mockResolvedValue([
      { id: 10, isDefault: false, userId: 1, createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 11, isDefault: false, userId: 2, createdAt: new Date('2026-05-02T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/dashboards/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.defaultDashboardId).toBeNull();
    expect(res.body.total).toBe(2);
  });

  test('byOwner: top 5 owners only; ties broken by ascending userId', async () => {
    // 7 distinct owners; userIds 1-3 have count=3 each, 4-5 have count=2,
    // 6-7 have count=1. After sort: 1,2,3 (count=3, tiebreak asc), then
    // 4,5 (count=2). Owner 6 + 7 fall off the top-5 cap.
    const rows = [];
    [1, 2, 3].forEach((u) => {
      for (let i = 0; i < 3; i++) {
        rows.push({ id: rows.length + 1, isDefault: false, userId: u, createdAt: new Date('2026-05-01T10:00:00Z') });
      }
    });
    [4, 5].forEach((u) => {
      for (let i = 0; i < 2; i++) {
        rows.push({ id: rows.length + 1, isDefault: false, userId: u, createdAt: new Date('2026-05-01T10:00:00Z') });
      }
    });
    [6, 7].forEach((u) => {
      rows.push({ id: rows.length + 1, isDefault: false, userId: u, createdAt: new Date('2026-05-01T10:00:00Z') });
    });
    prisma.dashboard.findMany.mockResolvedValue(rows);

    const app = makeApp();
    const res = await request(app)
      .get('/api/dashboards/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byOwner).toEqual([
      { userId: 1, count: 3 },
      { userId: 2, count: 3 },
      { userId: 3, count: 3 },
      { userId: 4, count: 2 },
      { userId: 5, count: 2 },
    ]);
    expect(res.body.totalOwners).toBe(7);
  });

  test('byOwner excludes shared rows (userId=null) from buckets', async () => {
    prisma.dashboard.findMany.mockResolvedValue([
      { id: 1, isDefault: false, userId: null, createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 2, isDefault: false, userId: null, createdAt: new Date('2026-05-02T10:00:00Z') },
      { id: 3, isDefault: false, userId: 42,   createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/dashboards/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byOwner).toEqual([{ userId: 42, count: 1 }]);
    expect(res.body.totalOwners).toBe(1);
    expect(res.body.byVisibility).toEqual({ shared: 2, private: 1 });
  });

  test('lastCreatedAt: max(createdAt) ISO across selected rows', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.dashboard.findMany.mockResolvedValue([
      { id: 1, isDefault: false, userId: 1, createdAt: new Date('2026-05-01T10:00:00Z') },
      { id: 2, isDefault: false, userId: 2, createdAt: newest },
      { id: 3, isDefault: false, userId: 3, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/dashboards/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId', async () => {
    prisma.dashboard.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/dashboards/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const dashWhere = prisma.dashboard.findMany.mock.calls[0][0].where;
    expect(dashWhere.tenantId).toBe(42);
  });

  test('?from/?to narrows window via createdAt gte/lte clauses', async () => {
    prisma.dashboard.findMany.mockResolvedValue([]);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/dashboards/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const dashWhere = prisma.dashboard.findMany.mock.calls[0][0].where;
    expect(dashWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(dashWhere.createdAt.lte).toEqual(new Date(toIso));
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.dashboard.findMany.mockResolvedValue([
      { id: 1, isDefault: true, userId: null, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/dashboards/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('route ordering: /stats resolves before /:id (literal beats wildcard)', async () => {
    // If /stats were AFTER /:id, the request would route to the :id handler,
    // parseInt("stats") -> NaN, and the response would be 400 "Invalid
    // dashboard ID" — NOT the /stats envelope. We assert the envelope shape
    // is returned, which proves /stats was matched first.
    prisma.dashboard.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/dashboards/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('byVisibility');
    expect(res.body).toHaveProperty('defaultDashboardId');
    // The /:id path would have returned an `error` string, not `total`.
    expect(res.body.error).toBeUndefined();
  });
});
