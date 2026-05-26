// @ts-check
/**
 * GET /api/travel-personalised-destinations/by-month — tenant-wide
 * monthly rollup over the personalised-destinations LLM-consumer surface.
 *
 * PRD_TRAVEL §4.7 + §9.1 — sibling to /stats (shipped 9ef3068c). USER-
 * readable monthly time-series mirroring the broader by-month family
 * (/suppliers/by-month, /flyer-templates/by-month, /quotes/by-month,
 * /invoices/by-month) at the LLM-consumer layer.
 *
 * IMPORTANT — DATA SOURCE NOTE
 * ----------------------------
 * The personalised-destinations route has NO Prisma model of its own.
 * It is a pure LLM consumer (POST /recommend → lib/llmRouter.routeRequest
 * → LlmCallLog row). The rollup aggregates LlmCallLog where
 * (tenantId, surface="personalised-destinations") match.
 *
 * Sub-brand scope: LlmCallLog has NO subBrand column, so the rollup is
 * tenant-wide-only and the response envelope OMITS `bySubBrand`.
 *
 * What's pinned
 * -------------
 *   - Auth gate:                no token → 401
 *   - 400 INVALID_MONTH_FORMAT: invalid ?from / ?to YYYY-MM
 *   - Empty happy path:         total=0, rows=[]
 *   - Happy path bucketing:     3 logs across 2 months → 2 rows, byTask
 *                               + byModel + stub/live correct per bucket
 *   - Default ordering:         orderBy=month:asc chronological
 *   - count ordering:           ?orderBy=count:desc flips order
 *   - ?from / ?to filter:       narrows the bucket array
 *   - "unknown" bucket:         null createdAt → "unknown"; excluded when
 *                               either ?from or ?to set
 *   - Pagination:               slices AFTER aggregation + sort + filter
 *   - Surface narrowing:        where.surface pinned to
 *                               "personalised-destinations"
 *   - stub/live split:          stubCount + liveCount populated per bucket
 *   - No audit row:             auditLog.create not invoked
 *
 * Test pattern mirrors travel-personalised-destinations-stats.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with HS256 JWTs signed against the dev-fallback
 * secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.llmCallLog = prisma.llmCallLog || {};
prisma.llmCallLog.findMany = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  role: 'ADMIN',
  subBrandAccess: null,
});
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
const router = requireCJS('../../routes/travel_personalised_destinations');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel-personalised-destinations', router);
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
  prisma.llmCallLog.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1,
    vertical: 'travel',
    name: 'Test Travel',
    slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/travel-personalised-destinations/by-month', () => {
  test('auth gate: no Authorization header → 401', async () => {
    const app = makeApp();
    const res = await request(app).get(
      '/api/travel-personalised-destinations/by-month',
    );
    expect(res.status).toBe(401);
  });

  test('400 INVALID_MONTH_FORMAT on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/by-month?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('400 INVALID_MONTH_FORMAT on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/by-month?to=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('empty happy path: total=0, rows=[]', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, rows: [] });
    // Tenant-wide-only: no bySubBrand on the envelope.
    expect('bySubBrand' in res.body).toBe(false);
  });

  test('happy path: 3 logs across 2 months → 2 month rows with byTask + byModel + stub/live breakdowns', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([
      {
        id: 1,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-04-10T10:00:00Z'),
      },
      {
        id: 2,
        task: 'reasoning',
        model: 'gpt-4',
        stub: false,
        createdAt: new Date('2026-05-15T10:00:00Z'),
      },
      {
        id: 3,
        task: 'bulk-text',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-05-20T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);

    const apr = res.body.rows.find((r) => r.month === '2026-04');
    const may = res.body.rows.find((r) => r.month === '2026-05');
    expect(apr).toBeDefined();
    expect(may).toBeDefined();

    expect(apr.count).toBe(1);
    expect(apr.stubCount).toBe(1);
    expect(apr.liveCount).toBe(0);
    expect(apr.byTask).toEqual({ reasoning: 1 });
    expect(apr.byModel).toEqual({ 'claude-opus-4-7': 1 });

    expect(may.count).toBe(2);
    expect(may.stubCount).toBe(1);
    expect(may.liveCount).toBe(1);
    expect(may.byTask).toEqual({ reasoning: 1, 'bulk-text': 1 });
    expect(may.byModel).toEqual({ 'gpt-4': 1, 'claude-opus-4-7': 1 });
  });

  test('default orderBy=month:asc → chronological ordering', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([
      {
        id: 1,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 2,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-03-10T10:00:00Z'),
      },
      {
        id: 3,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-04-10T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.month)).toEqual([
      '2026-03',
      '2026-04',
      '2026-05',
    ]);
  });

  test('?orderBy=count:desc flips ordering by count', async () => {
    // Mar=1 row, Apr=3 rows, May=2 rows → count desc => Apr, May, Mar
    prisma.llmCallLog.findMany.mockResolvedValue([
      {
        id: 1,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-03-10T10:00:00Z'),
      },
      {
        id: 2,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-04-05T10:00:00Z'),
      },
      {
        id: 3,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-04-15T10:00:00Z'),
      },
      {
        id: 4,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-04-25T10:00:00Z'),
      },
      {
        id: 5,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 6,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-05-20T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/by-month?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.month)).toEqual([
      '2026-04',
      '2026-05',
      '2026-03',
    ]);
    expect(res.body.rows.map((r) => r.count)).toEqual([3, 2, 1]);
  });

  test('?from / ?to narrows the bucket array', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([
      {
        id: 1,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-03-10T10:00:00Z'),
      },
      {
        id: 2,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-04-10T10:00:00Z'),
      },
      {
        id: 3,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 4,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-06-10T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get(
        '/api/travel-personalised-destinations/by-month?from=2026-04&to=2026-05',
      )
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-04', '2026-05']);
  });

  test('defensive: null createdAt → "unknown" bucket; excluded when ?from/?to set', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([
      {
        id: 1,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: null,
      },
      {
        id: 2,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-05-10T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    // Without bounds, "unknown" bucket appears.
    const noBounds = await request(app)
      .get('/api/travel-personalised-destinations/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(noBounds.status).toBe(200);
    expect(noBounds.body.total).toBe(2);
    const unknownBucket = noBounds.body.rows.find((r) => r.month === 'unknown');
    expect(unknownBucket).toBeDefined();
    expect(unknownBucket.count).toBe(1);

    // With bounds, "unknown" bucket excluded.
    const withBounds = await request(app)
      .get('/api/travel-personalised-destinations/by-month?from=2026-01&to=2026-12')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(withBounds.status).toBe(200);
    expect(withBounds.body.total).toBe(1);
    expect(withBounds.body.rows.find((r) => r.month === 'unknown')).toBeUndefined();
  });

  test('pagination ?limit=2&offset=1 slices AFTER aggregation + sort', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([
      {
        id: 1,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-03-10T10:00:00Z'),
      },
      {
        id: 2,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-04-10T10:00:00Z'),
      },
      {
        id: 3,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 4,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-06-10T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/by-month?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // total reflects pre-pagination bucket count (4 months).
    expect(res.body.total).toBe(4);
    // Pagination slices the asc-sorted array: skip 1 (Mar), take 2 (Apr, May).
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-04', '2026-05']);
  });

  test('surface narrowing: where.surface pinned to "personalised-destinations"', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.llmCallLog.findMany.mock.calls[0][0].where;
    expect(whereArg.surface).toBe('personalised-destinations');
    expect(whereArg.tenantId).toBe(1);
  });

  test('stubCount/liveCount split correctly per row', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([
      {
        id: 1,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-05-05T10:00:00Z'),
      },
      {
        id: 2,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: false,
        createdAt: new Date('2026-05-10T10:00:00Z'),
      },
      {
        id: 3,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: false,
        createdAt: new Date('2026-05-15T10:00:00Z'),
      },
      {
        id: 4,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-05-20T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    const may = res.body.rows[0];
    expect(may.month).toBe('2026-05');
    expect(may.count).toBe(4);
    expect(may.stubCount).toBe(2);
    expect(may.liveCount).toBe(2);
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([
      {
        id: 1,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-05-10T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
