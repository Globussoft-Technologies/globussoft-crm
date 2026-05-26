// @ts-check
/**
 * CRM polish — pin GET /api/contracts/stats contract.
 *
 * What this file pins
 * -------------------
 *   - Auth gate: missing Authorization header → 401.
 *   - 400 INVALID_DATE on bad ?from / ?to (independent validation).
 *   - Empty-tenant: zeroed envelope + byStatus={} + lastCreatedAt=null.
 *   - Happy path: 5 contracts across Draft/Sent/Active/Expired/Terminated →
 *     total + byStatus correct.
 *   - totalValue sums all rows (half-up 2dp).
 *   - signedValue sums only rows where status='Active' (the Contract
 *     enum's terminal-active state per schema.prisma).
 *   - activeCount: status='Active' AND (endDate is null OR endDate >= now).
 *   - expiringSoonCount: status='Active' AND endDate within next 30 days.
 *   - lastCreatedAt picks the most-recent createdAt.
 *   - Tenant isolation: prisma where.tenantId = req.user.tenantId.
 *   - ?from / ?to narrows the window via createdAt clauses.
 *   - NO audit row written (read-only meta surface).
 *
 * Schema notes (verified against schema.prisma Contract model + routes/contracts.js)
 * -----------------------------------------------------------------------------
 *   - Contract.status enum: Draft, Sent, Active, Expired, Terminated
 *     (PascalCase per schema.prisma:1186 default comment).
 *   - Contract.value (Float). Sum half-up to 2dp. Spec calls this "value"
 *     not "totalValue" — pinned to the real column.
 *   - Contract.endDate (DateTime?). activeCount + expiringSoonCount
 *     derived from this + status.
 *
 * Pattern reference: estimates-stats.test.js — patches the prisma singleton
 * with vi.fn() BEFORE requiring the router, drives supertest with HS256
 * JWTs signed against the dev-fallback secret. /stats endpoint mounts
 * explicit verifyToken so the 401-gate case can be exercised in isolation.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.contract = prisma.contract || {};
prisma.contract.findMany = vi.fn();
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
const contractsRouter = requireCJS('../../routes/contracts');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/contracts', contractsRouter);
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
  prisma.contract.findMany.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/contracts/stats', () => {
  test('auth gate: missing Authorization header → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/contracts/stats');
    expect(res.status).toBe(401);
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/contracts/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/contracts/stats?to=also-not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope with byStatus={} + lastCreatedAt=null', async () => {
    prisma.contract.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/contracts/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byStatus: {},
      totalValue: 0,
      signedValue: 0,
      activeCount: 0,
      expiringSoonCount: 0,
      lastCreatedAt: null,
    });
  });

  test('happy path: 5 contracts across multiple statuses → counts correct', async () => {
    const future = new Date(Date.now() + 365 * 86400000);
    prisma.contract.findMany.mockResolvedValue([
      { status: 'Draft', value: 100, endDate: future, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Sent', value: 200, endDate: future, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Active', value: 300, endDate: future, createdAt: new Date('2026-05-03T10:00:00Z') },
      { status: 'Expired', value: 400, endDate: new Date(Date.now() - 86400000), createdAt: new Date('2026-05-04T10:00:00Z') },
      { status: 'Terminated', value: 500, endDate: new Date(Date.now() - 86400000), createdAt: new Date('2026-05-05T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/contracts/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byStatus).toEqual({
      Draft: 1,
      Sent: 1,
      Active: 1,
      Expired: 1,
      Terminated: 1,
    });
  });

  test('totalValue sums all rows (half-up 2dp on float-noise inputs)', async () => {
    prisma.contract.findMany.mockResolvedValue([
      { status: 'Draft', value: 100.555, endDate: null, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Active', value: 50.005, endDate: null, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Terminated', value: 25.001, endDate: null, createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/contracts/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 100.555 + 50.005 + 25.001 = 175.561 → 175.56 half-up
    expect(res.body.totalValue).toBe(175.56);
  });

  test('signedValue sums only status=Active rows (the Contract enum terminal-active state)', async () => {
    const future = new Date(Date.now() + 365 * 86400000);
    prisma.contract.findMany.mockResolvedValue([
      { status: 'Active', value: 1000, endDate: future, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Active', value: 500, endDate: future, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Draft', value: 9999, endDate: future, createdAt: new Date('2026-05-03T10:00:00Z') },
      { status: 'Sent', value: 8888, endDate: future, createdAt: new Date('2026-05-04T10:00:00Z') },
      { status: 'Expired', value: 7777, endDate: future, createdAt: new Date('2026-05-05T10:00:00Z') },
      { status: 'Terminated', value: 6666, endDate: future, createdAt: new Date('2026-05-06T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/contracts/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Only the two Active rows: 1000 + 500 = 1500
    expect(res.body.signedValue).toBe(1500);
  });

  test('activeCount: status=Active AND (endDate null OR endDate >= now)', async () => {
    const future = new Date(Date.now() + 30 * 86400000);
    const past = new Date(Date.now() - 86400000);
    prisma.contract.findMany.mockResolvedValue([
      { status: 'Active', value: 100, endDate: future, createdAt: new Date('2026-05-01T10:00:00Z') },  // active ✓ (future end)
      { status: 'Active', value: 100, endDate: null, createdAt: new Date('2026-05-02T10:00:00Z') },    // active ✓ (open-ended)
      { status: 'Active', value: 100, endDate: past, createdAt: new Date('2026-05-03T10:00:00Z') },    // NOT active (past end)
      { status: 'Draft', value: 100, endDate: future, createdAt: new Date('2026-05-04T10:00:00Z') },   // NOT active (wrong status)
      { status: 'Terminated', value: 100, endDate: future, createdAt: new Date('2026-05-05T10:00:00Z') }, // NOT active
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/contracts/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.activeCount).toBe(2);
  });

  test('expiringSoonCount: status=Active AND endDate within next 30 days', async () => {
    const inFiveDays = new Date(Date.now() + 5 * 86400000);
    const inTenDays = new Date(Date.now() + 10 * 86400000);
    const inSixtyDays = new Date(Date.now() + 60 * 86400000);
    const past = new Date(Date.now() - 86400000);
    prisma.contract.findMany.mockResolvedValue([
      { status: 'Active', value: 100, endDate: inFiveDays, createdAt: new Date('2026-05-01T10:00:00Z') },   // expiring ✓
      { status: 'Active', value: 100, endDate: inTenDays, createdAt: new Date('2026-05-02T10:00:00Z') },    // expiring ✓
      { status: 'Active', value: 100, endDate: inSixtyDays, createdAt: new Date('2026-05-03T10:00:00Z') },  // NOT expiring (too far)
      { status: 'Active', value: 100, endDate: null, createdAt: new Date('2026-05-04T10:00:00Z') },         // NOT expiring (open-ended)
      { status: 'Active', value: 100, endDate: past, createdAt: new Date('2026-05-05T10:00:00Z') },         // NOT expiring (already past)
      { status: 'Draft', value: 100, endDate: inFiveDays, createdAt: new Date('2026-05-06T10:00:00Z') },    // NOT expiring (wrong status)
      { status: 'Sent', value: 100, endDate: inFiveDays, createdAt: new Date('2026-05-07T10:00:00Z') },     // NOT expiring (wrong status)
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/contracts/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.expiringSoonCount).toBe(2);
  });

  test('lastCreatedAt picks the most-recent createdAt', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.contract.findMany.mockResolvedValue([
      { status: 'Draft', value: 100, endDate: null, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Sent', value: 100, endDate: null, createdAt: newest },
      { status: 'Active', value: 100, endDate: null, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/contracts/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId', async () => {
    prisma.contract.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/contracts/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.contract.findMany.mock.calls[0][0].where;
    expect(whereArg.tenantId).toBe(42);
  });

  test('?from/?to narrows the window via createdAt clauses on the prisma query', async () => {
    prisma.contract.findMany.mockResolvedValue([]);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/contracts/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.contract.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.gte).toEqual(new Date(fromIso));
    expect(whereArg.createdAt.lte).toEqual(new Date(toIso));
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.contract.findMany.mockResolvedValue([
      { status: 'Active', value: 1000, endDate: null, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/contracts/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('defensive: null/undefined value fields default to 0 (no NaN poisoning)', async () => {
    prisma.contract.findMany.mockResolvedValue([
      { status: 'Draft', value: null, endDate: null, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Active', value: undefined, endDate: null, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Active', value: 200, endDate: null, createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/contracts/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalValue).toBe(200);
    expect(res.body.signedValue).toBe(200);
    expect(Number.isFinite(res.body.totalValue)).toBe(true);
    expect(Number.isFinite(res.body.signedValue)).toBe(true);
  });
});
