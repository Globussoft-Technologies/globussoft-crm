// @ts-check
/**
 * GET /api/travel-personalised-destinations/stats — tenant-wide
 * personalised-destinations rollup (first /stats endpoint for the
 * admin-curated tailored destinations domain).
 *
 * Mirrors the broader stats family (#903 /suppliers/stats, #905
 * /commission-profiles/stats, #908 /flyer-templates/global-stats,
 * /religious-packets/stats). USER-readable anodyne aggregate that
 * surfaces a tenant-wide LLM-call rollup for the personalised-
 * destinations domain.
 *
 * IMPORTANT — DATA SOURCE NOTE
 * ----------------------------
 * The personalised-destinations route has NO Prisma model of its own.
 * It is a pure LLM consumer (POST /recommend → lib/llmRouter.routeRequest
 * → LlmCallLog row). The rollup aggregates LlmCallLog where
 * (tenantId, surface="personalised-destinations") match — there is no
 * domain table to count.
 *
 * Sub-brand scope: LlmCallLog has NO subBrand column, so this rollup
 * is tenant-wide-only and the response envelope OMITS `bySubBrand`.
 * Cases #8 and #10 from the spec template (sub-brand bucketing + falsy
 * subBrand → _tenant) are dropped accordingly; replaced with additional
 * date-window edge cases per the prompt's "If model has NO subBrand"
 * branch.
 *
 * What's pinned
 * -------------
 *   - Empty tenant:        zeroed envelope with empty byTask/byModel
 *                          and lastCreatedAt=null.
 *   - Happy path:          N rows → total count + byTask/byModel
 *                          buckets + stubCount/liveCount split.
 *   - lastCreatedAt:       max(createdAt) across visible rows, ISO
 *                          string; null on empty.
 *   - Surface narrowing:   the where clause pins surface=
 *                          "personalised-destinations" (so other LLM
 *                          consumers' rows don't leak into the rollup).
 *   - Tenant isolation:    different tenant returns 0 (where.tenantId
 *                          set from req.travelTenant.id).
 *   - Date bounds:         ?from + ?to feed into createdAt clause;
 *                          invalid ISO → 400 INVALID_DATE.
 *   - Date edges:          single-day window; future-only window
 *                          returns 0; boundary date inclusive.
 *   - Defensive timestamps: rows with null createdAt still count in
 *                          `total` but are skipped for lastCreatedAt.
 *   - Auth gate:           no token → 401.
 *   - No audit row:        auditLog.create MUST NOT be called.
 *
 * Test pattern mirrors travel-religious-packets-stats.test.js — patch
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

describe('GET /api/travel-personalised-destinations/stats', () => {
  test('auth gate: no Authorization header → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/travel-personalised-destinations/stats');
    expect(res.status).toBe(401);
  });

  test('400 INVALID_DATE on unparseable ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('400 INVALID_DATE on unparseable ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/stats?to=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('empty tenant → zeroed envelope, lastCreatedAt=null, no bySubBrand', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byTask: {},
      byModel: {},
      stubCount: 0,
      liveCount: 0,
      lastCreatedAt: null,
    });
    // Sub-brand scope: the model has no subBrand column, so the envelope
    // MUST NOT include a bySubBrand field. Pinning here protects against
    // accidental future "add bySubBrand:{}" envelope drift.
    expect('bySubBrand' in res.body).toBe(false);
  });

  test('happy path: 4 rows → total count + byTask/byModel buckets + stub/live split', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
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
        stub: false, // live call
        createdAt: newest, // newest createdAt — drives lastCreatedAt
      },
      {
        id: 3,
        task: 'reasoning',
        model: 'gpt-4',
        stub: true,
        createdAt: new Date('2026-05-15T10:00:00Z'),
      },
      {
        id: 4,
        task: 'bulk-text',
        model: 'claude-haiku',
        stub: true,
        createdAt: new Date('2026-05-18T10:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.stubCount).toBe(3);
    expect(res.body.liveCount).toBe(1);
    expect(res.body.byTask).toEqual({
      reasoning: { count: 3 },
      'bulk-text': { count: 1 },
    });
    expect(res.body.byModel).toEqual({
      'claude-opus-4-7': { count: 2 },
      'gpt-4': { count: 1 },
      'claude-haiku': { count: 1 },
    });
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });

  test('?from / ?to narrows the count to the date window (where.createdAt populated)', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/stats?from=2026-05-01T00:00:00Z&to=2026-05-31T23:59:59Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.llmCallLog.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt).toBeDefined();
    expect(whereArg.createdAt.gte).toBeInstanceOf(Date);
    expect(whereArg.createdAt.lte).toBeInstanceOf(Date);
    expect(whereArg.createdAt.gte.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(whereArg.createdAt.lte.toISOString()).toBe('2026-05-31T23:59:59.000Z');
  });

  test('lastCreatedAt is the most-recent createdAt as ISO string', async () => {
    const newest = new Date('2026-05-25T12:34:56Z');
    prisma.llmCallLog.findMany.mockResolvedValue([
      {
        id: 1,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-05-10T00:00:00Z'),
      },
      {
        id: 2,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: newest,
      },
      {
        id: 3,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: new Date('2026-05-20T00:00:00Z'),
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });

  test('surface narrowing: where clause pins surface="personalised-destinations"', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.llmCallLog.findMany.mock.calls[0][0].where;
    expect(whereArg.surface).toBe('personalised-destinations');
  });

  test('tenant isolation: where.tenantId set from req.travelTenant.id', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 42,
      vertical: 'travel',
      name: 'Other Tenant',
      slug: 'other-tenant',
    });
    prisma.llmCallLog.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { userId: 7, tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.llmCallLog.findMany.mock.calls[0][0].where;
    expect(whereArg.tenantId).toBe(42);
    // No leak — total is 0 because the mock returned [] for this tenant.
    expect(res.body.total).toBe(0);
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
      .get('/api/travel-personalised-destinations/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('defensive: rows with null createdAt are still counted in total (lastCreatedAt skips them)', async () => {
    const realTs = new Date('2026-05-15T10:00:00Z');
    prisma.llmCallLog.findMany.mockResolvedValue([
      {
        id: 1,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: null, // defensive: still counted in total
      },
      {
        id: 2,
        task: 'reasoning',
        model: 'claude-opus-4-7',
        stub: true,
        createdAt: realTs,
      },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    // lastCreatedAt skips the null-createdAt row.
    expect(res.body.lastCreatedAt).toBe(realTs.toISOString());
  });

  test('single-day window: ?from + ?to on same day still feed createdAt clause', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/stats?from=2026-05-15T00:00:00Z&to=2026-05-15T23:59:59Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.llmCallLog.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.gte.toISOString()).toBe('2026-05-15T00:00:00.000Z');
    expect(whereArg.createdAt.lte.toISOString()).toBe('2026-05-15T23:59:59.000Z');
  });

  test('future-only window: ?from=tomorrow → mock returns 0, total=0 (no actual DB filter needed in test)', async () => {
    // Using unambiguously-future tomorrow per the date-boundary standing
    // rule — avoids TZ-window flakes on midnight test runs.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const tomorrowIso = tomorrow.toISOString();
    prisma.llmCallLog.findMany.mockResolvedValue([]); // future window returns nothing

    const app = makeApp();
    const res = await request(app)
      .get(`/api/travel-personalised-destinations/stats?from=${encodeURIComponent(tomorrowIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.lastCreatedAt).toBe(null);
    // Verify the future bound made it into the where clause.
    const whereArg = prisma.llmCallLog.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.gte).toBeInstanceOf(Date);
    expect(whereArg.createdAt.gte.toISOString()).toBe(tomorrowIso);
  });

  test('only ?from (no ?to) → where.createdAt has gte but no lte', async () => {
    prisma.llmCallLog.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/stats?from=2026-05-01T00:00:00Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const whereArg = prisma.llmCallLog.findMany.mock.calls[0][0].where;
    expect(whereArg.createdAt.gte).toBeInstanceOf(Date);
    expect(whereArg.createdAt.lte).toBeUndefined();
  });

  test('USER role → 200 (anodyne aggregate; sibling stats endpoints behave the same)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: null,
    });
    prisma.llmCallLog.findMany.mockResolvedValue([]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel-personalised-destinations/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
});
