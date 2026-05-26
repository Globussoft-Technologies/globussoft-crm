// @ts-check
/**
 * CRM polish — pin GET /api/estimates/stats contract.
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: missing Authorization header → 401.
 *   - 400 INVALID_DATE on bad ?from / ?to (independent validation).
 *   - Empty-tenant: zeroed envelope + byStatus={} + acceptanceRate=null + lastCreatedAt=null.
 *   - Happy path: 5 estimates across Draft/Sent/Accepted/Rejected/Expired →
 *     total + byStatus + totalValue + acceptedValue correct.
 *   - acceptanceRate formula: 2 accepted + 1 rejected → 2/3 = 0.67 (half-up 2dp).
 *   - acceptanceRate=null when no terminal decisions yet (only Draft/Sent rows).
 *   - expiredCount: Draft/Sent rows whose validUntil < now are counted.
 *   - expiredCount: Accepted rows are NOT counted as expired even when
 *     validUntil < now (terminal states win).
 *   - lastCreatedAt picks the most-recent createdAt.
 *   - Tenant isolation: prisma where.tenantId = req.user.tenantId.
 *   - ?from / ?to narrows the window via createdAt clauses.
 *   - NO audit row written (read-only meta surface).
 *
 * Schema notes (verified against routes/estimates.js validators)
 * --------------------------------------------------------------
 *   - Estimate.status enum: Draft, Sent, Accepted, Rejected, Expired, Converted
 *     (capitalized PascalCase, NOT UPPER_SNAKE).
 *   - Estimate.totalAmount (Float). Sum half-up to 2dp.
 *   - Estimate.validUntil (DateTime?). expiredCount derived from this + status.
 *
 * Pattern reference: billing-stats.test.js — patches the prisma singleton
 * with vi.fn() BEFORE requiring the router, drives supertest with HS256
 * JWTs signed against the dev-fallback secret. /stats endpoint mounts
 * explicit verifyToken so the 401-gate case can be exercised in isolation
 * without depending on a global guard.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.estimate = prisma.estimate || {};
prisma.estimate.findMany = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
// fieldFilter helpers may query this transitively at router require-time.
prisma.fieldPermission = prisma.fieldPermission || {};
prisma.fieldPermission.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const estimatesRouter = requireCJS('../../routes/estimates');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/estimates', estimatesRouter);
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
  prisma.estimate.findMany.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/estimates/stats', () => {
  test('auth gate: missing Authorization header → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/estimates/stats');
    expect(res.status).toBe(401);
    expect(prisma.estimate.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.estimate.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats?to=also-not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.estimate.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope with byStatus={} + acceptanceRate=null + lastCreatedAt=null', async () => {
    prisma.estimate.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byStatus: {},
      totalValue: 0,
      acceptedValue: 0,
      acceptanceRate: null,
      expiredCount: 0,
      lastCreatedAt: null,
    });
  });

  test('happy path: 5 estimates across multiple statuses → counts + sums correct', async () => {
    // 2 Accepted @ 1000, 500   — accepted sum 1500
    // 1 Sent @ 750
    // 1 Rejected @ 300
    // 1 Draft @ 200
    // totalValue = 1000 + 500 + 750 + 300 + 200 = 2750
    // acceptedValue = 1500
    const future = new Date(Date.now() + 7 * 86400000);
    prisma.estimate.findMany.mockResolvedValue([
      { status: 'Accepted', totalAmount: 1000, validUntil: future, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Accepted', totalAmount: 500, validUntil: future, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Sent', totalAmount: 750, validUntil: future, createdAt: new Date('2026-05-03T10:00:00Z') },
      { status: 'Rejected', totalAmount: 300, validUntil: future, createdAt: new Date('2026-05-04T10:00:00Z') },
      { status: 'Draft', totalAmount: 200, validUntil: future, createdAt: new Date('2026-05-05T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byStatus).toEqual({
      Accepted: 2,
      Sent: 1,
      Rejected: 1,
      Draft: 1,
    });
    expect(res.body.totalValue).toBe(2750);
    expect(res.body.acceptedValue).toBe(1500);
  });

  test('acceptanceRate formula: 2 accepted + 1 rejected → 2/3 = 0.67 (half-up 2dp)', async () => {
    const future = new Date(Date.now() + 7 * 86400000);
    prisma.estimate.findMany.mockResolvedValue([
      { status: 'Accepted', totalAmount: 100, validUntil: future, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Accepted', totalAmount: 100, validUntil: future, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Rejected', totalAmount: 100, validUntil: future, createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 2 / 3 = 0.6666... → half-up to 0.67
    expect(res.body.acceptanceRate).toBe(0.67);
  });

  test('acceptanceRate=null when no terminal decisions yet (only Draft/Sent rows)', async () => {
    const future = new Date(Date.now() + 7 * 86400000);
    prisma.estimate.findMany.mockResolvedValue([
      { status: 'Draft', totalAmount: 100, validUntil: future, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Sent', totalAmount: 200, validUntil: future, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Sent', totalAmount: 300, validUntil: future, createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.acceptanceRate).toBeNull();
  });

  test('expiredCount: Draft/Sent rows with validUntil < now are counted', async () => {
    const past = new Date(Date.now() - 7 * 86400000);
    const future = new Date(Date.now() + 7 * 86400000);
    prisma.estimate.findMany.mockResolvedValue([
      { status: 'Draft', totalAmount: 100, validUntil: past, createdAt: new Date('2026-05-01T10:00:00Z') },    // expired ✓
      { status: 'Sent', totalAmount: 100, validUntil: past, createdAt: new Date('2026-05-02T10:00:00Z') },     // expired ✓
      { status: 'Draft', totalAmount: 100, validUntil: future, createdAt: new Date('2026-05-03T10:00:00Z') },  // not expired
      { status: 'Sent', totalAmount: 100, validUntil: null, createdAt: new Date('2026-05-04T10:00:00Z') },     // no bound — not expired
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.expiredCount).toBe(2);
  });

  test('expiredCount: Accepted/Rejected/Converted rows are NOT counted even when validUntil < now (terminal states win)', async () => {
    const past = new Date(Date.now() - 7 * 86400000);
    prisma.estimate.findMany.mockResolvedValue([
      { status: 'Accepted', totalAmount: 100, validUntil: past, createdAt: new Date('2026-05-01T10:00:00Z') },   // terminal — not expired
      { status: 'Rejected', totalAmount: 100, validUntil: past, createdAt: new Date('2026-05-02T10:00:00Z') },   // terminal — not expired
      { status: 'Converted', totalAmount: 100, validUntil: past, createdAt: new Date('2026-05-03T10:00:00Z') },  // terminal — not expired
      { status: 'Draft', totalAmount: 100, validUntil: past, createdAt: new Date('2026-05-04T10:00:00Z') },      // expired ✓
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.expiredCount).toBe(1);
  });

  test('lastCreatedAt picks the most-recent createdAt', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.estimate.findMany.mockResolvedValue([
      { status: 'Draft', totalAmount: 100, validUntil: null, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Sent', totalAmount: 100, validUntil: null, createdAt: newest },
      { status: 'Draft', totalAmount: 100, validUntil: null, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId', async () => {
    prisma.estimate.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.estimate.findMany.mock.calls[0][0].where;
    expect(whereArg.tenantId).toBe(42);
  });

  test('?from/?to: narrows the window via createdAt clauses on the prisma query', async () => {
    prisma.estimate.findMany.mockResolvedValue([]);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/estimates/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.estimate.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.gte).toEqual(new Date(fromIso));
    expect(whereArg.createdAt.lte).toEqual(new Date(toIso));
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.estimate.findMany.mockResolvedValue([
      { status: 'Accepted', totalAmount: 1000, validUntil: null, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('defensive: null/undefined totalAmount fields default to 0 (no NaN poisoning)', async () => {
    prisma.estimate.findMany.mockResolvedValue([
      { status: 'Draft', totalAmount: null, validUntil: null, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Accepted', totalAmount: undefined, validUntil: null, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Accepted', totalAmount: 200, validUntil: null, createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalValue).toBe(200);
    expect(res.body.acceptedValue).toBe(200);
    expect(Number.isFinite(res.body.totalValue)).toBe(true);
    expect(Number.isFinite(res.body.acceptedValue)).toBe(true);
  });

  test('half-up rounding to 2dp on sums with float-noise inputs', async () => {
    prisma.estimate.findMany.mockResolvedValue([
      { status: 'Accepted', totalAmount: 100.555, validUntil: null, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Accepted', totalAmount: 50.005, validUntil: null, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Accepted', totalAmount: 25.001, validUntil: null, createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/estimates/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 100.555 + 50.005 + 25.001 = 175.561 → 175.56 half-up
    expect(res.body.totalValue).toBe(175.56);
    expect(res.body.acceptedValue).toBe(175.56);
  });
});
