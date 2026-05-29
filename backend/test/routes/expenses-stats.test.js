// @ts-check
/**
 * CRM polish — pin GET /api/expenses/stats contract.
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: missing Authorization header → 401.
 *   - 400 INVALID_DATE on bad ?from / ?to (independent validation).
 *   - Empty-tenant: zeroed envelope + byStatus={} + byCategory={} +
 *     lastCreatedAt=null + sums all 0.
 *   - Happy path: 5 expenses across statuses + categories → counts +
 *     sums correct.
 *   - totalAmount sums ALL rows (regardless of status).
 *   - approvedAmount sums Approved + Reimbursed only (terminal-positive).
 *   - pendingAmount sums Pending only (awaiting decision).
 *   - lastCreatedAt: picks the maximum createdAt.
 *   - Tenant isolation: prisma where.tenantId comes from req.user.tenantId.
 *   - ?from/?to narrows the window (createdAt clauses present on the query).
 *   - NO audit row written (auditLog.create not called).
 *   - Defensive: null/undefined amount fields don't NaN-poison the sums.
 *   - Half-up rounding to 2dp on float-noise inputs.
 *
 * Schema notes (verified against prisma/schema.prisma → model Expense)
 * -------------------------------------------------------------------
 *   - Status values (capitalized strings, NOT enum): "Draft", "Pending",
 *     "Approved", "Rejected", "Reimbursed". Default "Pending".
 *   - Category default "General". Free-string column.
 *   - amount: Float. NO submittedAt column; date bounds use createdAt.
 *
 * Pattern reference: billing-stats.test.js — patches the prisma singleton
 * with vi.fn() BEFORE requiring the router, drives supertest with HS256
 * JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.expense = prisma.expense || {};
prisma.expense.findMany = vi.fn();
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

// Side-effect note: requiring the expenses router transitively pulls in
// lib/eventBus.js which calls dotenv.config({ override: true }) against
// the repo-root .env — that sets process.env.JWT_SECRET to whatever the
// dev .env has. We must read JWT_SECRET AFTER that require so the test's
// signed tokens match what verifyToken's config/secrets.js resolves at
// request time (otherwise tokens are signed with the dev-fallback secret
// while the route verifies with the .env-supplied one → 401 cascade).
const expensesRouter = requireCJS('../../routes/expenses');
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/expenses', expensesRouter);
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
  prisma.expense.findMany.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/expenses/stats', () => {
  test('auth gate: missing Authorization header → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/expenses/stats');
    expect(res.status).toBe(401);
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/expenses/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/expenses/stats?to=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope with byStatus={} + byCategory={} + lastCreatedAt=null', async () => {
    prisma.expense.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/expenses/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byStatus: {},
      byCategory: {},
      totalAmount: 0,
      approvedAmount: 0,
      pendingAmount: 0,
      lastCreatedAt: null,
    });
  });

  test('happy path: 5 expenses across statuses + categories → counts + sums correct', async () => {
    // 1 Draft @ 100 (Travel)
    // 1 Pending @ 250 (Meals)
    // 1 Approved @ 500 (Software)
    // 1 Rejected @ 75 (Office)
    // 1 Reimbursed @ 300 (Travel)
    prisma.expense.findMany.mockResolvedValue([
      { status: 'Draft', category: 'Travel', amount: 100, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Pending', category: 'Meals', amount: 250, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Approved', category: 'Software', amount: 500, createdAt: new Date('2026-05-03T10:00:00Z') },
      { status: 'Rejected', category: 'Office', amount: 75, createdAt: new Date('2026-05-04T10:00:00Z') },
      { status: 'Reimbursed', category: 'Travel', amount: 300, createdAt: new Date('2026-05-05T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/expenses/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byStatus).toEqual({
      Draft: 1,
      Pending: 1,
      Approved: 1,
      Rejected: 1,
      Reimbursed: 1,
    });
    expect(res.body.byCategory).toEqual({
      Travel: 2,
      Meals: 1,
      Software: 1,
      Office: 1,
    });
  });

  test('totalAmount sums ALL rows regardless of status', async () => {
    prisma.expense.findMany.mockResolvedValue([
      { status: 'Draft', category: 'Travel', amount: 100, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Pending', category: 'Meals', amount: 250, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Approved', category: 'Software', amount: 500, createdAt: new Date('2026-05-03T10:00:00Z') },
      { status: 'Rejected', category: 'Office', amount: 75, createdAt: new Date('2026-05-04T10:00:00Z') },
      { status: 'Reimbursed', category: 'Travel', amount: 300, createdAt: new Date('2026-05-05T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/expenses/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 100 + 250 + 500 + 75 + 300 = 1225 — every row, every status.
    expect(res.body.totalAmount).toBe(1225);
  });

  test('approvedAmount sums Approved + Reimbursed only (terminal-positive states)', async () => {
    prisma.expense.findMany.mockResolvedValue([
      { status: 'Draft', category: 'Travel', amount: 100, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Pending', category: 'Meals', amount: 250, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Approved', category: 'Software', amount: 500, createdAt: new Date('2026-05-03T10:00:00Z') },
      { status: 'Rejected', category: 'Office', amount: 75, createdAt: new Date('2026-05-04T10:00:00Z') },
      { status: 'Reimbursed', category: 'Travel', amount: 300, createdAt: new Date('2026-05-05T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/expenses/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 500 (Approved) + 300 (Reimbursed) = 800. Draft/Pending/Rejected excluded.
    expect(res.body.approvedAmount).toBe(800);
  });

  test('pendingAmount sums Pending only (awaiting decision)', async () => {
    prisma.expense.findMany.mockResolvedValue([
      { status: 'Draft', category: 'Travel', amount: 100, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Pending', category: 'Meals', amount: 250, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Pending', category: 'Software', amount: 175, createdAt: new Date('2026-05-03T10:00:00Z') },
      { status: 'Approved', category: 'Office', amount: 500, createdAt: new Date('2026-05-04T10:00:00Z') },
      { status: 'Reimbursed', category: 'Travel', amount: 300, createdAt: new Date('2026-05-05T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/expenses/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 250 + 175 = 425. Draft/Approved/Reimbursed excluded from "pending".
    expect(res.body.pendingAmount).toBe(425);
  });

  test('lastCreatedAt: picks the most-recent createdAt', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.expense.findMany.mockResolvedValue([
      { status: 'Pending', category: 'Travel', amount: 100, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Pending', category: 'Travel', amount: 100, createdAt: newest }, // newest
      { status: 'Pending', category: 'Travel', amount: 100, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/expenses/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId', async () => {
    prisma.expense.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/expenses/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.expense.findMany.mock.calls[0][0].where;
    expect(whereArg.tenantId).toBe(42);
  });

  test('?from/?to: narrows the window via createdAt clauses on the prisma query', async () => {
    prisma.expense.findMany.mockResolvedValue([]);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/expenses/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.expense.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.gte).toEqual(new Date(fromIso));
    expect(whereArg.createdAt.lte).toEqual(new Date(toIso));
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.expense.findMany.mockResolvedValue([
      { status: 'Approved', category: 'Travel', amount: 100, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/expenses/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('defensive: null/undefined amount fields default to 0 (no NaN poisoning)', async () => {
    prisma.expense.findMany.mockResolvedValue([
      { status: 'Pending', category: 'Travel', amount: null, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Approved', category: 'Travel', amount: undefined, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Approved', category: 'Travel', amount: 200, createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/expenses/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // null + undefined coerce to 0; only the 200 Approved contributes.
    expect(res.body.totalAmount).toBe(200);
    expect(res.body.approvedAmount).toBe(200);
    expect(res.body.pendingAmount).toBe(0);
    expect(Number.isFinite(res.body.totalAmount)).toBe(true);
    expect(Number.isFinite(res.body.approvedAmount)).toBe(true);
    expect(Number.isFinite(res.body.pendingAmount)).toBe(true);
  });

  test('half-up rounding to 2dp on sums with float-noise inputs', async () => {
    prisma.expense.findMany.mockResolvedValue([
      { status: 'Approved', category: 'Travel', amount: 100.555, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'Reimbursed', category: 'Travel', amount: 50.005, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'Pending', category: 'Travel', amount: 25.001, createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/expenses/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // totalAmount: 100.555 + 50.005 + 25.001 = 175.561 → 175.56 half-up
    expect(res.body.totalAmount).toBe(175.56);
    // approvedAmount: 100.555 + 50.005 = 150.560 → 150.56
    expect(res.body.approvedAmount).toBe(150.56);
    // pendingAmount: 25.001 → 25.00
    expect(res.body.pendingAmount).toBe(25);
  });
});
