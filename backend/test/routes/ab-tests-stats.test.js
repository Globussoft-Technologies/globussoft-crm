// @ts-check
/**
 * Marketing polish — pin GET /api/ab-tests/stats tenant-wide aggregate.
 *
 * What this file pins
 * ───────────────────
 *   - Route ordering: literal-path /stats declared BEFORE the dynamic
 *     /:id family. If a future refactor accidentally moves the dynamic
 *     /:id route ABOVE /stats, the dynamic matcher will swallow "stats"
 *     as a numeric-id parse → res.json(null) or 404. The first happy-path
 *     test below would red instantly.
 *   - 400 INVALID_DATE on bad ?from / ?to (independent validation, same
 *     shape as routes/landing_pages.js /stats).
 *   - Empty-tenant: zeroed envelope + byStatus={} +
 *     winnerDistribution={A:0,B:0,none:0} + lastCreatedAt=null.
 *   - Happy path: status-bucket counts roll up correctly over a mixed
 *     population (DRAFT + RUNNING + COMPLETED).
 *   - completedCount + activeCount derived from byStatus.
 *   - winnerDistribution counts winningVariant A/B/null buckets,
 *     including DRAFT/RUNNING rows where winningVariant is naturally null.
 *   - lastCreatedAt = max createdAt as ISO string, null when empty.
 *   - Tenant isolation: prisma where.tenantId comes from req.user.tenantId.
 *   - ?from/?to narrows the window via createdAt clauses on the prisma
 *     query (gte / lte composition).
 *   - NO audit row written.
 *
 * Schema reality (verified against prisma/schema.prisma → model AbTest,
 * line 2058)
 * --------------------------------------------------------------------
 *   - status defaults to "DRAFT"; observed values are DRAFT | RUNNING |
 *     COMPLETED (uppercase, per ab_tests.js POST /:id/start + declare-
 *     winner handlers). The route is bucket-agnostic — any string seen
 *     in the column lands in the byStatus map.
 *   - winningVariant is String? ("A" | "B" | null); the "none" bucket
 *     covers DRAFT + RUNNING + COMPLETED-without-explicit-winner.
 *   - There is no separate `winner` column despite the gap-card framing;
 *     the canonical field is winningVariant (per declare-winner handler).
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/ab-tests.test.js — prisma singleton
 *   monkey-patch BEFORE the router require, then mount the router into a
 *   bare express app with a fake req.user injector. As of 214017c1
 *   ("security: audit-fix batch") every route now carries a route-level
 *   verifyRole(["ADMIN","MANAGER"]) guard that reads req.user.role, so the
 *   fake injector supplies role:'ADMIN' to clear the gate.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Prisma singleton patching — must happen BEFORE the router is required,
// since the router's top-level `require('../lib/prisma')` resolves at
// import time and captures whatever object prisma.abTest points at then.
prisma.abTest = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const abTestsRouter = requireCJS('../../routes/ab_tests');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // 214017c1 added verifyRole(["ADMIN","MANAGER"]) to every route, which
    // checks req.user.role — so the fake auth injector must supply a role.
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/ab-tests', abTestsRouter);
  return app;
}

beforeEach(() => {
  prisma.abTest.findMany.mockReset();
  prisma.abTest.findFirst.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/ab-tests/stats', () => {
  test('route ordering: /stats is NOT caught by /:id dynamic matcher (sanity probe)', async () => {
    // If a future refactor moves /:id ABOVE /stats, this test reds because
    // findFirst gets hit (with a NaN id) and findMany never fires.
    prisma.abTest.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/ab-tests/stats');

    expect(res.status).toBe(200);
    expect(prisma.abTest.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.abTest.findFirst).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const res = await request(makeApp()).get('/api/ab-tests/stats?from=not-a-date');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.abTest.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const res = await request(makeApp()).get('/api/ab-tests/stats?to=not-a-date');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.abTest.findMany).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope + lastCreatedAt=null + winnerDistribution all zero', async () => {
    prisma.abTest.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/ab-tests/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byStatus: {},
      completedCount: 0,
      activeCount: 0,
      winnerDistribution: { A: 0, B: 0, none: 0 },
      lastCreatedAt: null,
    });
  });

  test('happy path: 6 rows across DRAFT + RUNNING + COMPLETED → status buckets correct', async () => {
    prisma.abTest.findMany.mockResolvedValue([
      { status: 'DRAFT',     winningVariant: null, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'DRAFT',     winningVariant: null, createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'RUNNING',   winningVariant: null, createdAt: new Date('2026-05-03T10:00:00Z') },
      { status: 'RUNNING',   winningVariant: null, createdAt: new Date('2026-05-04T10:00:00Z') },
      { status: 'COMPLETED', winningVariant: 'A',  createdAt: new Date('2026-05-05T10:00:00Z') },
      { status: 'COMPLETED', winningVariant: 'B',  createdAt: new Date('2026-05-06T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/ab-tests/stats');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(6);
    expect(res.body.byStatus).toEqual({
      DRAFT: 2,
      RUNNING: 2,
      COMPLETED: 2,
    });
    expect(res.body.completedCount).toBe(2);
    expect(res.body.activeCount).toBe(2);
  });

  test('winnerDistribution counts A, B, and none (null winningVariant) buckets', async () => {
    prisma.abTest.findMany.mockResolvedValue([
      { status: 'COMPLETED', winningVariant: 'A',  createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'COMPLETED', winningVariant: 'A',  createdAt: new Date('2026-05-02T10:00:00Z') },
      { status: 'COMPLETED', winningVariant: 'A',  createdAt: new Date('2026-05-03T10:00:00Z') },
      { status: 'COMPLETED', winningVariant: 'B',  createdAt: new Date('2026-05-04T10:00:00Z') },
      // DRAFT + RUNNING contribute to "none" bucket because winningVariant
      // is null by construction (no declare-winner has fired yet).
      { status: 'DRAFT',     winningVariant: null, createdAt: new Date('2026-05-05T10:00:00Z') },
      { status: 'RUNNING',   winningVariant: null, createdAt: new Date('2026-05-06T10:00:00Z') },
      // A COMPLETED row without a winner — possible if status was manually
      // updated without going through /declare-winner. Still counts toward
      // "none".
      { status: 'COMPLETED', winningVariant: null, createdAt: new Date('2026-05-07T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/ab-tests/stats');

    expect(res.status).toBe(200);
    expect(res.body.winnerDistribution).toEqual({ A: 3, B: 1, none: 3 });
  });

  test('lastCreatedAt picks the maximum createdAt as an ISO string', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.abTest.findMany.mockResolvedValue([
      { status: 'DRAFT',     winningVariant: null, createdAt: new Date('2026-05-01T10:00:00Z') },
      { status: 'COMPLETED', winningVariant: 'A',  createdAt: newest },
      { status: 'RUNNING',   winningVariant: null, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/ab-tests/stats');

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });

  test('lastCreatedAt = null when no rows match', async () => {
    prisma.abTest.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/ab-tests/stats');

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBeNull();
  });

  test('tenant isolation: prisma where.tenantId comes from req.user.tenantId', async () => {
    prisma.abTest.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/ab-tests/stats');

    expect(res.status).toBe(200);
    const whereArg = prisma.abTest.findMany.mock.calls[0][0].where;
    expect(whereArg.tenantId).toBe(42);
  });

  test('?from narrows window via createdAt.gte on the prisma query', async () => {
    prisma.abTest.findMany.mockResolvedValue([]);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const res = await request(makeApp()).get(
      `/api/ab-tests/stats?from=${encodeURIComponent(fromIso)}`,
    );

    expect(res.status).toBe(200);
    const whereArg = prisma.abTest.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.gte).toEqual(new Date(fromIso));
    expect(whereArg.createdAt.lte).toBeUndefined();
  });

  test('?to narrows window via createdAt.lte on the prisma query', async () => {
    prisma.abTest.findMany.mockResolvedValue([]);

    const toIso = '2026-05-31T23:59:59.999Z';
    const res = await request(makeApp()).get(
      `/api/ab-tests/stats?to=${encodeURIComponent(toIso)}`,
    );

    expect(res.status).toBe(200);
    const whereArg = prisma.abTest.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.lte).toEqual(new Date(toIso));
    expect(whereArg.createdAt.gte).toBeUndefined();
  });

  test('?from + ?to compose into a single createdAt clause (gte + lte)', async () => {
    prisma.abTest.findMany.mockResolvedValue([]);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const res = await request(makeApp()).get(
      `/api/ab-tests/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
    );

    expect(res.status).toBe(200);
    const whereArg = prisma.abTest.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.gte).toEqual(new Date(fromIso));
    expect(whereArg.createdAt.lte).toEqual(new Date(toIso));
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.abTest.findMany.mockResolvedValue([
      { status: 'DRAFT', winningVariant: null, createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/ab-tests/stats');

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('500 envelope on Prisma fault', async () => {
    prisma.abTest.findMany.mockRejectedValue(new Error('db down'));

    const res = await request(makeApp()).get('/api/ab-tests/stats');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to compute AB-test stats' });
  });

  test('select projection contains only the columns the aggregator reads', async () => {
    // Defensive perf-pin: stats handler only reads status / winningVariant /
    // createdAt, so the select shouldn't drag the variant JSON blobs across
    // the wire. Will red if a future refactor accidentally drops the select
    // or adds the variant text columns.
    prisma.abTest.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/ab-tests/stats');

    const selectArg = prisma.abTest.findMany.mock.calls[0][0].select;
    expect(selectArg).toEqual({
      status: true,
      winningVariant: true,
      createdAt: true,
    });
  });
});
