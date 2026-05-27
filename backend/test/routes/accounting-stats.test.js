// @ts-check
/**
 * CRM polish — pin GET /api/accounting/stats contract.
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: missing Authorization header → 401.
 *   - 400 INVALID_DATE on bad ?from / ?to (independent validation).
 *   - Empty-tenant: zeroed envelope + byEntityType={} + byProvider={} +
 *     successRate=null + lastSuccessfulSyncAt=null.
 *   - Happy path: 5 sync attempts across providers + entityTypes →
 *     byProvider + byEntityType counts correct.
 *   - successRate = 1.0 when total > 0 (every persisted AccountingSync
 *     row is a successful sync by construction — see schema-drift note
 *     in the route handler).
 *   - successRate = null when total = 0.
 *   - totalRecordsSynced equals the total count (1 row = 1 record in
 *     the current schema).
 *   - lastSuccessfulSyncAt picks the max syncedAt as an ISO string.
 *   - lastSuccessfulSyncAt = null when no rows match.
 *   - Tenant isolation: prisma where.tenantId comes from
 *     req.user.tenantId.
 *   - ?from/?to narrows the window via syncedAt clauses on the prisma
 *     query.
 *   - NO audit row written (auditLog.create not called).
 *
 * Schema reality (verified against prisma/schema.prisma → model
 * AccountingSync, line 2442)
 * --------------------------------------------------------------------
 *   - Columns: id, provider, entityType, entityId, externalId,
 *     syncedAt, tenantId.
 *   - NO status / recordsSynced / errorMessage / createdAt columns —
 *     every persisted row represents a SUCCESSFUL sync, so
 *     successRate degenerates to 1.0 when total > 0 and the
 *     `byStatus` aggregate from the original gap-card framing is
 *     replaced with `byEntityType` (Invoice/Expense/Customer, per
 *     the live recordSync() callers in routes/accounting.js).
 *   - The route filters on syncedAt (the only timestamp column on
 *     this table — billing-stats filters on createdAt, but
 *     AccountingSync has no createdAt).
 *
 * Pattern reference: backend/test/routes/billing-stats.test.js — patches
 * the prisma singleton with vi.fn() BEFORE requiring the router, drives
 * supertest with HS256 JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.accountingSync = prisma.accountingSync || {};
prisma.accountingSync.findMany = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
// fieldFilter helpers may query this transitively; return empty perms so
// they no-op (stats handler doesn't actually call fieldFilter but other
// router handlers loaded at require-time may).
prisma.fieldPermission = prisma.fieldPermission || {};
prisma.fieldPermission.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const accountingRouter = requireCJS('../../routes/accounting');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/accounting', accountingRouter);
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
  prisma.accountingSync.findMany.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/accounting/stats', () => {
  test('auth gate: missing Authorization header → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/accounting/stats');
    expect(res.status).toBe(401);
    expect(prisma.accountingSync.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/accounting/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.accountingSync.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/accounting/stats?to=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.accountingSync.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope + successRate=null + lastSuccessfulSyncAt=null', async () => {
    prisma.accountingSync.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/accounting/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byEntityType: {},
      byProvider: {},
      successRate: null,
      totalRecordsSynced: 0,
      lastSuccessfulSyncAt: null,
    });
  });

  test('happy path: 5 sync attempts across providers + entityTypes → counts correct', async () => {
    // 2 tally Invoices, 1 tally Expense, 1 quickbooks Invoice, 1 xero Customer.
    prisma.accountingSync.findMany.mockResolvedValue([
      { provider: 'tally', entityType: 'Invoice', syncedAt: new Date('2026-05-01T10:00:00Z') },
      { provider: 'tally', entityType: 'Invoice', syncedAt: new Date('2026-05-02T10:00:00Z') },
      { provider: 'tally', entityType: 'Expense', syncedAt: new Date('2026-05-03T10:00:00Z') },
      { provider: 'quickbooks', entityType: 'Invoice', syncedAt: new Date('2026-05-04T10:00:00Z') },
      { provider: 'xero', entityType: 'Customer', syncedAt: new Date('2026-05-05T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/accounting/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byProvider).toEqual({
      tally: 3,
      quickbooks: 1,
      xero: 1,
    });
    expect(res.body.byEntityType).toEqual({
      Invoice: 3,
      Expense: 1,
      Customer: 1,
    });
  });

  test('successRate = 1.0 when total > 0 (every persisted row represents a successful sync)', async () => {
    // Schema-drift note: AccountingSync has no `status` column. Every
    // persisted row is a successful sync by construction (the route's
    // recordSync() helper only upserts AFTER the external-system call
    // returns). So successRate degenerates to 1.0 whenever total > 0.
    prisma.accountingSync.findMany.mockResolvedValue([
      { provider: 'tally', entityType: 'Invoice', syncedAt: new Date('2026-05-01T10:00:00Z') },
      { provider: 'tally', entityType: 'Invoice', syncedAt: new Date('2026-05-02T10:00:00Z') },
      { provider: 'quickbooks', entityType: 'Expense', syncedAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/accounting/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.successRate).toBe(1.0);
  });

  test('successRate = null when total = 0', async () => {
    prisma.accountingSync.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/accounting/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.successRate).toBeNull();
  });

  test('totalRecordsSynced equals total (1 row = 1 successfully synced record in current schema)', async () => {
    prisma.accountingSync.findMany.mockResolvedValue([
      { provider: 'tally', entityType: 'Invoice', syncedAt: new Date('2026-05-01T10:00:00Z') },
      { provider: 'tally', entityType: 'Invoice', syncedAt: new Date('2026-05-02T10:00:00Z') },
      { provider: 'xero', entityType: 'Customer', syncedAt: new Date('2026-05-03T10:00:00Z') },
      { provider: 'quickbooks', entityType: 'Expense', syncedAt: new Date('2026-05-04T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/accounting/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.totalRecordsSynced).toBe(4);
  });

  test('lastSuccessfulSyncAt picks the maximum syncedAt as an ISO string', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.accountingSync.findMany.mockResolvedValue([
      { provider: 'tally', entityType: 'Invoice', syncedAt: new Date('2026-05-01T10:00:00Z') },
      { provider: 'tally', entityType: 'Invoice', syncedAt: newest }, // newest
      { provider: 'quickbooks', entityType: 'Expense', syncedAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/accounting/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastSuccessfulSyncAt).toBe(newest.toISOString());
  });

  test('lastSuccessfulSyncAt = null when no rows match', async () => {
    prisma.accountingSync.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/accounting/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastSuccessfulSyncAt).toBeNull();
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId', async () => {
    prisma.accountingSync.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/accounting/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.accountingSync.findMany.mock.calls[0][0].where;
    expect(whereArg.tenantId).toBe(42);
  });

  test('?from/?to: narrows the window via syncedAt clauses on the prisma query', async () => {
    prisma.accountingSync.findMany.mockResolvedValue([]);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/accounting/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.accountingSync.findMany.mock.calls[0][0].where;
    expect(whereArg.syncedAt.gte).toEqual(new Date(fromIso));
    expect(whereArg.syncedAt.lte).toEqual(new Date(toIso));
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.accountingSync.findMany.mockResolvedValue([
      { provider: 'tally', entityType: 'Invoice', syncedAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/accounting/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
