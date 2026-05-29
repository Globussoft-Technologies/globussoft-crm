// @ts-check
/**
 * backend/routes/projects.js — GET /api/projects/stats contract pin.
 *
 * CRM polish — first /stats endpoint for the Project route. Mirrors deals/stats
 * + travel-suppliers/stats posture. Read-only KPI surface for the project-
 * management dashboard header strip.
 *
 * What's pinned
 * -------------
 *   - GET /api/projects/stats
 *       - 401 when no Authorization header present (verifyToken in chain).
 *       - 400 INVALID_DATE on a malformed ?from.
 *       - 400 INVALID_DATE on a malformed ?to.
 *       - Empty-tenant returns total=0, byStatus={}, activeCount=0,
 *         totalBudget=0, overdueCount=0, lastCreatedAt=null.
 *       - Happy path with 5 projects across statuses returns the right
 *         total + byStatus enum bucket counts.
 *       - totalBudget sums every project's budget (half-up to 2dp).
 *       - activeCount excludes terminal states (Completed, Cancelled).
 *       - overdueCount counts only endDate<now AND not-terminal.
 *       - lastCreatedAt is the ISO max(createdAt).
 *       - Tenant isolation: where: { tenantId } is honored — the route never
 *         passes a body- or query-supplied tenantId through.
 *       - ?from/?to narrow the createdAt window (gte/lte).
 *       - NO audit row written (auditLog.create not invoked).
 *
 * Test pattern mirrors backend/test/routes/travel_suppliers.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router, then
 * drive supertest with real HS256 JWTs signed with the same fallback secret
 * the middleware uses in dev. verifyToken is mounted explicitly here because
 * the projects router itself has no guards — auth lives at the server.js
 * global-middleware layer in production. Mounting verifyToken in the test
 * exercises the full guard chain end-to-end (the 401 case).
 *
 * Project schema (verified against prisma/schema.prisma):
 *   - status enum values: Planning, Active, On Hold, Completed, Cancelled
 *   - closed/terminal states: Completed, Cancelled
 *   - budget: Float (defaults to 0)
 *   - endDate: DateTime?
 *   - createdAt: DateTime (default now())
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.project = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'generic',
  name: 'Test Tenant',
  slug: 'test-tenant',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
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
const { verifyToken } = requireCJS('../../middleware/auth');
const projectsRouter = requireCJS('../../routes/projects');

function makeApp() {
  const app = express();
  app.use(express.json());
  // Mirror server.js global guard chain — verifyToken on every /api/projects
  // request. This exposes the 401 path the production stack guards globally.
  app.use('/api/projects', verifyToken, projectsRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function isoNow() {
  return new Date();
}
function daysFromNow(n) {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
}

beforeEach(() => {
  prisma.project.findMany.mockReset();
  prisma.project.findFirst.mockReset();
  prisma.project.count.mockReset();
  prisma.project.create.mockReset();
  prisma.project.update.mockReset();
  prisma.project.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'generic', name: 'Test Tenant', slug: 'test-tenant',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/projects/stats — auth gate', () => {
  test('returns 401 when no Authorization header is present', async () => {
    const res = await request(makeApp()).get('/api/projects/stats');
    expect(res.status).toBe(401);
    // findMany must not have been called — the auth gate fires first.
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/projects/stats — date-bound validation', () => {
  test('returns 400 INVALID_DATE on a malformed ?from', async () => {
    const res = await request(makeApp())
      .get('/api/projects/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  test('returns 400 INVALID_DATE on a malformed ?to', async () => {
    const res = await request(makeApp())
      .get('/api/projects/stats?to=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/projects/stats — aggregation', () => {
  test('empty tenant returns zero-shape envelope', async () => {
    prisma.project.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/projects/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byStatus: {},
      activeCount: 0,
      totalBudget: 0,
      overdueCount: 0,
      lastCreatedAt: null,
    });
  });

  test('5 projects across statuses returns the right total + byStatus bucket counts', async () => {
    const now = isoNow();
    prisma.project.findMany.mockResolvedValue([
      { id: 1, status: 'Planning',   budget: 0,    endDate: null,             createdAt: now, tenantId: 1 },
      { id: 2, status: 'Active',     budget: 100,  endDate: daysFromNow(30),  createdAt: now, tenantId: 1 },
      { id: 3, status: 'On Hold',    budget: 50,   endDate: null,             createdAt: now, tenantId: 1 },
      { id: 4, status: 'Completed',  budget: 200,  endDate: daysFromNow(-10), createdAt: now, tenantId: 1 },
      { id: 5, status: 'Cancelled',  budget: 30,   endDate: daysFromNow(-5),  createdAt: now, tenantId: 1 },
    ]);
    const res = await request(makeApp())
      .get('/api/projects/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byStatus).toEqual({
      Planning: 1,
      Active: 1,
      'On Hold': 1,
      Completed: 1,
      Cancelled: 1,
    });
  });

  test('totalBudget sums all rows (half-up to 2dp)', async () => {
    prisma.project.findMany.mockResolvedValue([
      { id: 1, status: 'Active',    budget: 100.005, endDate: null, createdAt: new Date(), tenantId: 1 },
      { id: 2, status: 'Active',    budget: 200.5,   endDate: null, createdAt: new Date(), tenantId: 1 },
      { id: 3, status: 'Completed', budget: 50.123,  endDate: null, createdAt: new Date(), tenantId: 1 },
      { id: 4, status: 'Active',    budget: null,    endDate: null, createdAt: new Date(), tenantId: 1 },
    ]);
    const res = await request(makeApp())
      .get('/api/projects/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // 100.005 + 200.5 + 50.123 + 0 = 350.628 → 350.63 (half-up at 2dp)
    expect(res.body.totalBudget).toBe(350.63);
  });

  test('activeCount excludes Completed + Cancelled terminal states', async () => {
    prisma.project.findMany.mockResolvedValue([
      { id: 1, status: 'Planning',  budget: 0, endDate: null, createdAt: new Date(), tenantId: 1 },
      { id: 2, status: 'Active',    budget: 0, endDate: null, createdAt: new Date(), tenantId: 1 },
      { id: 3, status: 'On Hold',   budget: 0, endDate: null, createdAt: new Date(), tenantId: 1 },
      { id: 4, status: 'Completed', budget: 0, endDate: null, createdAt: new Date(), tenantId: 1 },
      { id: 5, status: 'Cancelled', budget: 0, endDate: null, createdAt: new Date(), tenantId: 1 },
    ]);
    const res = await request(makeApp())
      .get('/api/projects/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Planning + Active + On Hold = 3; Completed + Cancelled excluded.
    expect(res.body.activeCount).toBe(3);
  });

  test('overdueCount counts only endDate<now AND not Completed/Cancelled', async () => {
    prisma.project.findMany.mockResolvedValue([
      // overdue + open → counts
      { id: 1, status: 'Active',    budget: 0, endDate: daysFromNow(-3), createdAt: new Date(), tenantId: 1 },
      // overdue + Planning → counts
      { id: 2, status: 'Planning',  budget: 0, endDate: daysFromNow(-7), createdAt: new Date(), tenantId: 1 },
      // overdue + Completed → does NOT count (terminal)
      { id: 3, status: 'Completed', budget: 0, endDate: daysFromNow(-1), createdAt: new Date(), tenantId: 1 },
      // overdue + Cancelled → does NOT count (terminal)
      { id: 4, status: 'Cancelled', budget: 0, endDate: daysFromNow(-2), createdAt: new Date(), tenantId: 1 },
      // future endDate + open → does NOT count (not overdue)
      { id: 5, status: 'Active',    budget: 0, endDate: daysFromNow(7),  createdAt: new Date(), tenantId: 1 },
      // null endDate + open → does NOT count (no deadline)
      { id: 6, status: 'Active',    budget: 0, endDate: null,            createdAt: new Date(), tenantId: 1 },
    ]);
    const res = await request(makeApp())
      .get('/api/projects/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.overdueCount).toBe(2);
  });

  test('lastCreatedAt is the ISO max(createdAt)', async () => {
    const oldest = new Date('2026-01-01T00:00:00.000Z');
    const middle = new Date('2026-03-15T10:30:00.000Z');
    const newest = new Date('2026-05-20T23:59:00.000Z');
    prisma.project.findMany.mockResolvedValue([
      { id: 1, status: 'Active', budget: 0, endDate: null, createdAt: middle, tenantId: 1 },
      { id: 2, status: 'Active', budget: 0, endDate: null, createdAt: oldest, tenantId: 1 },
      { id: 3, status: 'Active', budget: 0, endDate: null, createdAt: newest, tenantId: 1 },
    ]);
    const res = await request(makeApp())
      .get('/api/projects/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });
});

describe('GET /api/projects/stats — tenant isolation', () => {
  test('honors req.user.tenantId in the where clause', async () => {
    prisma.project.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/projects/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);
    expect(res.status).toBe(200);
    expect(prisma.project.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.project.findMany.mock.calls[0][0];
    expect(call.where).toEqual(expect.objectContaining({ tenantId: 42 }));
    // Sanity: the where should NOT have leaked from any other tenant id.
    expect(call.where.tenantId).not.toBe(1);
  });

  test('a different tenant cannot scope the query to tenant 1', async () => {
    prisma.project.findMany.mockResolvedValue([]);
    // Token says tenantId=99; if the route honored a body- or query-supplied
    // tenantId by mistake, the where clause would mention 1. It should not.
    await request(makeApp())
      .get('/api/projects/stats?tenantId=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 99 })}`);
    const call = prisma.project.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(99);
  });
});

describe('GET /api/projects/stats — date-range window', () => {
  test('?from narrows where.createdAt.gte', async () => {
    prisma.project.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/projects/stats?from=2026-01-01T00:00:00Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const call = prisma.project.findMany.mock.calls[0][0];
    expect(call.where.createdAt).toBeDefined();
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('?to narrows where.createdAt.lte', async () => {
    prisma.project.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/projects/stats?to=2026-06-30T23:59:59Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const call = prisma.project.findMany.mock.calls[0][0];
    expect(call.where.createdAt).toBeDefined();
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte.toISOString()).toBe('2026-06-30T23:59:59.000Z');
  });

  test('?from and ?to applied together as a half-open window', async () => {
    prisma.project.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/projects/stats?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const call = prisma.project.findMany.mock.calls[0][0];
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
  });
});

describe('GET /api/projects/stats — audit-row guarantee', () => {
  test('does NOT write an audit row (read-only meta surface)', async () => {
    prisma.project.findMany.mockResolvedValue([
      { id: 1, status: 'Active', budget: 100, endDate: null, createdAt: new Date(), tenantId: 1 },
    ]);
    const res = await request(makeApp())
      .get('/api/projects/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
