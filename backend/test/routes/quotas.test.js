// @ts-check
/**
 * Unit tests for backend/routes/quotas.js — pins the Sales Quotas CRUD +
 * attainment/leaderboard surface used by the Quotas + Forecasting pages.
 *
 * Why this file exists
 * ────────────────────
 * quotas.js is a 227-LOC route surface backing per-user period-bounded sales
 * targets. It holds several non-obvious contracts that have rotted before:
 *
 *   - tenant isolation — every read / write / upsert / delete keys on
 *     req.user.tenantId; cross-tenant id lookups return 404, never the
 *     foreign row.
 *
 *   - #646 fallback contract — POST / reads `userId` from query string
 *     because the global stripDangerous middleware deletes `userId` from
 *     req.body. The route also has a defensive `|| req.body.userId` clause
 *     (allowlisted in backend/eslint.config.js + commented in routes/
 *     quotas.js:74) for the rare case where stripDangerous is not in the
 *     middleware chain (e.g. these very unit tests, which mount the router
 *     directly without the global guard). The contract surface tested here
 *     is: query.userId wins, body.userId is the documented fallback.
 *
 *   - period validation — periodToRange() supports `"2026"` (whole year)
 *     and `"2026-Q1"` through `"2026-Q4"` quarters; invalid periods cause
 *     /attainment + /leaderboard to return [] (empty array) NOT a 400. The
 *     /attainment + /leaderboard endpoints DO 400 on a fully-missing
 *     `?period` query param.
 *
 *   - upsert behaviour — POST / is composite-keyed on
 *     (userId, period, tenantId) via Prisma's `userId_period_tenantId`
 *     compound unique. Re-POSTing the same triple updates `target` instead
 *     of erroring on UNIQUE collision.
 *
 *   - DELETE returns 204 No Content (#550 cross-route shape sweep).
 *
 *   - attainment math — pulls Deal rows where stage='won' AND
 *     ownerId IN (quota userIds) AND createdAt within periodToRange()'s
 *     [start, end) half-open window. Per-owner amount sum / target × 100
 *     rounded to one decimal. target=0 yields attainmentPct=0 (no div by 0).
 *
 *   - leaderboard order — same buildAttainment() output as /attainment but
 *     sorted by attainmentPct descending.
 *
 * What this file pins (16 cases across 6 describe blocks)
 * ───────────────────────────────────────────────────────
 *   1. GET / — list tenant-scoped quotas with userName attached.
 *   2. GET / — ?userId filter coerces to int + adds to where clause.
 *   3. GET / — ?period filter narrows to a single string period value.
 *   4. GET / — userName falls back to email then "User #<id>" when name
 *      missing (canonical 3-tier display contract).
 *   5. POST / — happy path: 201 with the upserted row; userId read from
 *      query string per #646.
 *   6. POST / — #646 fallback: req.body.userId is honoured when
 *      ?userId query is absent (the documented belt-and-braces path).
 *   7. POST / — missing userId/period/target returns 400 with the route's
 *      shape-pinning error message.
 *   8. POST / — invalid target (non-numeric / negative) returns 400.
 *   9. POST / — upsert composite key uses userId+period+tenantId; tenantId
 *      always comes from req.user (never the body).
 *  10. PUT /:id — happy update of target; tenant-scoped findFirst lookup
 *      precedes the update.
 *  11. PUT /:id — cross-tenant id returns 404 (findFirst returns null,
 *      .update is NEVER invoked).
 *  12. PUT /:id — invalid target on PUT returns 400.
 *  13. DELETE /:id — 204 No Content on happy path (#550).
 *  14. DELETE /:id — cross-tenant id returns 404 without leaking the
 *      foreign row.
 *  15. GET /attainment — computes per-user achieved/target/pct from won
 *      Deal rows whose createdAt falls inside periodToRange's [start, end)
 *      window; target=0 yields attainmentPct=0 (no div by 0).
 *  16. GET /leaderboard — same shape as /attainment but ordered by
 *      attainmentPct descending; missing ?period returns 400.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/tickets.test.js — prisma singleton patch +
 * real JWT bearer signed with config/secrets.JWT_SECRET so the real
 * verifyToken middleware passes. routes/quotas.js mounts verifyToken
 * inline (router.use(verifyToken)) so the test app does NOT need to wire
 * it separately. No CJS self-mocking seam needed — quotas.js calls no
 * services or lib modules beyond lib/prisma (already patched).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patching ─────────────────────────────────────────
// Must happen BEFORE the router is required, since the router's top-level
// `require('../lib/prisma')` resolves at import time.
prisma.quota = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();
prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();

// verifyToken's revoked-token lookup hits prisma.revokedToken.findUnique;
// stub the surface so any incidental call returns "not revoked".
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Use the SAME JWT_SECRET that verifyToken will use — by reaching into the
// already-cached config/secrets module. This guarantees the test-token
// signing path matches verifyToken's resolution regardless of env timing.
const { JWT_SECRET } = requireCJS('../../config/secrets');
function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

// quotas.js mounts verifyToken via router.use(verifyToken) — we don't need
// to wire it inline like tickets does.
const quotasRouter = requireCJS('../../routes/quotas');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/quotas', quotasRouter);
  return app;
}

beforeEach(() => {
  prisma.quota.findMany.mockReset();
  prisma.quota.findFirst.mockReset();
  prisma.quota.upsert.mockReset();
  prisma.quota.update.mockReset();
  prisma.quota.delete.mockReset();
  prisma.user.findMany.mockReset();
  prisma.deal.findMany.mockReset();

  // Sensible defaults — each test overrides what it cares about.
  prisma.quota.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.deal.findMany.mockResolvedValue([]);
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — list quotas (tenant-scoped, with optional filters)
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list quotas', () => {
  test('returns tenant-scoped quotas with userName attached from User.name', async () => {
    prisma.quota.findMany.mockResolvedValue([
      { id: 1, userId: 7, period: '2026-Q2', target: 50000, tenantId: 1 },
      { id: 2, userId: 8, period: '2026-Q1', target: 30000, tenantId: 1 },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 7, name: 'Priya Iyer', email: 'priya@example.com' },
      { id: 8, name: 'Rahul Verma', email: 'rahul@example.com' },
    ]);

    const res = await request(makeApp())
      .get('/api/quotas')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual(expect.objectContaining({
      id: 1, userId: 7, period: '2026-Q2', target: 50000, userName: 'Priya Iyer',
    }));
    expect(res.body[1].userName).toBe('Rahul Verma');

    // Tenant-scoped from req.user.tenantId (never from query/body)
    expect(prisma.quota.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: [{ period: 'desc' }, { userId: 'asc' }],
    });
    // User lookup also tenant-scoped to block cross-tenant name-leak
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: [7, 8] }, tenantId: 1 },
      select: { id: true, name: true, email: true },
    });
  });

  test('?userId filter coerces to int + appends to where clause', async () => {
    prisma.quota.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/quotas?userId=42')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(prisma.quota.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, userId: 42 },
      orderBy: [{ period: 'desc' }, { userId: 'asc' }],
    });
  });

  test('?period filter narrows to single string period value', async () => {
    prisma.quota.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/quotas?period=2026-Q1')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(prisma.quota.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, period: '2026-Q1' },
      orderBy: [{ period: 'desc' }, { userId: 'asc' }],
    });
  });

  test('userName falls back to email then "User #<id>" when name missing', async () => {
    prisma.quota.findMany.mockResolvedValue([
      { id: 1, userId: 7, period: '2026-Q2', target: 50000, tenantId: 1 },
      { id: 2, userId: 8, period: '2026-Q1', target: 30000, tenantId: 1 },
      // Quota for a userId that no longer has a User row (deleted)
      { id: 3, userId: 99, period: '2026', target: 100000, tenantId: 1 },
    ]);
    prisma.user.findMany.mockResolvedValue([
      // User 7 has both name + email — name wins
      { id: 7, name: 'Priya Iyer', email: 'priya@example.com' },
      // User 8 has email only — email wins
      { id: 8, name: null, email: 'rahul@example.com' },
      // User 99 missing entirely — "User #99" fallback
    ]);

    const res = await request(makeApp())
      .get('/api/quotas')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body[0].userName).toBe('Priya Iyer');
    expect(res.body[1].userName).toBe('rahul@example.com');
    expect(res.body[2].userName).toBe('User #99');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — upsert quota (+ #646 fallback contract)
// ─────────────────────────────────────────────────────────────────────────

describe('POST / — upsert quota', () => {
  test('happy path: 201 with the upserted row; userId read from query string per #646', async () => {
    prisma.quota.upsert.mockResolvedValue({
      id: 50, userId: 7, period: '2026-Q3', target: 75000, tenantId: 1,
    });

    const res = await request(makeApp())
      .post('/api/quotas?userId=7')
      .set('Authorization', makeBearer())
      .send({ period: '2026-Q3', target: 75000 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      id: 50, userId: 7, period: '2026-Q3', target: 75000,
    }));
    // Upsert keyed on the compound unique; tenantId always from req.user
    expect(prisma.quota.upsert).toHaveBeenCalledWith({
      where: {
        userId_period_tenantId: { userId: 7, period: '2026-Q3', tenantId: 1 },
      },
      update: { target: 75000 },
      create: { userId: 7, period: '2026-Q3', target: 75000, tenantId: 1 },
    });
  });

  test('#646 fallback: req.body.userId is honoured when ?userId query is absent', async () => {
    // This test ALSO documents the eslint-allowlisted branch in routes/quotas.js:74
    // — the unit-test mount has no stripDangerous middleware, so body.userId
    // arrives intact and the route's `|| req.body.userId` clause picks it up.
    prisma.quota.upsert.mockResolvedValue({
      id: 51, userId: 9, period: '2026-Q4', target: 25000, tenantId: 1,
    });

    const res = await request(makeApp())
      .post('/api/quotas')
      .set('Authorization', makeBearer())
      .send({ userId: 9, period: '2026-Q4', target: 25000 });

    expect(res.status).toBe(201);
    expect(prisma.quota.upsert).toHaveBeenCalledWith({
      where: {
        userId_period_tenantId: { userId: 9, period: '2026-Q4', tenantId: 1 },
      },
      update: { target: 25000 },
      create: { userId: 9, period: '2026-Q4', target: 25000, tenantId: 1 },
    });
  });

  test('rejects missing userId/period/target with 400 + shape-pinning error message', async () => {
    const res = await request(makeApp())
      .post('/api/quotas')
      .set('Authorization', makeBearer())
      .send({ period: '2026-Q1' }); // missing userId + target

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/userId.*period.*target/i);
    expect(prisma.quota.upsert).not.toHaveBeenCalled();
  });

  test('rejects invalid target (non-numeric / negative) with 400', async () => {
    // Negative target
    const r1 = await request(makeApp())
      .post('/api/quotas?userId=7')
      .set('Authorization', makeBearer())
      .send({ period: '2026-Q1', target: -100 });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toMatch(/invalid target/i);

    // Non-numeric target
    const r2 = await request(makeApp())
      .post('/api/quotas?userId=7')
      .set('Authorization', makeBearer())
      .send({ period: '2026-Q1', target: 'not-a-number' });
    expect(r2.status).toBe(400);
    expect(r2.body.error).toMatch(/invalid target/i);

    expect(prisma.quota.upsert).not.toHaveBeenCalled();
  });

  test('upsert compound key uses userId+period+tenantId; tenantId comes from req.user (not body)', async () => {
    prisma.quota.upsert.mockResolvedValue({
      id: 60, userId: 7, period: '2026', target: 200000, tenantId: 1,
    });

    // A malicious caller tries to write a quota under a different tenantId
    // via body injection. In real prod stripDangerous deletes both
    // tenantId AND userId from req.body — here we don't run that middleware,
    // but the route MUST NOT read tenantId from body either way; it always
    // uses req.user.tenantId. Pinning that contract here.
    const res = await request(makeApp())
      .post('/api/quotas?userId=7')
      .set('Authorization', makeBearer({ tenantId: 1 }))
      .send({ period: '2026', target: 200000, tenantId: 999 });

    expect(res.status).toBe(201);
    expect(prisma.quota.upsert).toHaveBeenCalledWith({
      where: {
        userId_period_tenantId: { userId: 7, period: '2026', tenantId: 1 },
      },
      update: { target: 200000 },
      create: { userId: 7, period: '2026', target: 200000, tenantId: 1 },
    });
    // The body's tenantId=999 was NEVER honoured.
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id — update quota target (tenant-scoped)
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /:id — update quota target', () => {
  test('happy update: tenant-scoped findFirst, then update target', async () => {
    prisma.quota.findFirst.mockResolvedValue({
      id: 50, userId: 7, period: '2026-Q3', target: 50000, tenantId: 1,
    });
    prisma.quota.update.mockResolvedValue({
      id: 50, userId: 7, period: '2026-Q3', target: 80000, tenantId: 1,
    });

    const res = await request(makeApp())
      .put('/api/quotas/50')
      .set('Authorization', makeBearer())
      .send({ target: 80000 });

    expect(res.status).toBe(200);
    expect(res.body.target).toBe(80000);
    expect(prisma.quota.findFirst).toHaveBeenCalledWith({
      where: { id: 50, tenantId: 1 },
    });
    expect(prisma.quota.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { target: 80000 },
    });
  });

  test('cross-tenant id returns 404; .update is NEVER invoked', async () => {
    prisma.quota.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/quotas/9999')
      .set('Authorization', makeBearer())
      .send({ target: 80000 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/quota not found/i);
    expect(prisma.quota.update).not.toHaveBeenCalled();
  });

  test('invalid target on PUT returns 400', async () => {
    prisma.quota.findFirst.mockResolvedValue({
      id: 50, userId: 7, period: '2026-Q3', target: 50000, tenantId: 1,
    });

    const res = await request(makeApp())
      .put('/api/quotas/50')
      .set('Authorization', makeBearer())
      .send({ target: -500 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid target/i);
    expect(prisma.quota.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — delete quota (tenant-scoped, 204 per #550)
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /:id — delete quota', () => {
  test('happy delete returns 204 No Content (#550)', async () => {
    prisma.quota.findFirst.mockResolvedValue({
      id: 50, userId: 7, period: '2026-Q3', target: 50000, tenantId: 1,
    });
    prisma.quota.delete.mockResolvedValue({ id: 50 });

    const res = await request(makeApp())
      .delete('/api/quotas/50')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(204);
    // 204 must have no JSON body
    expect(res.body).toEqual({});
    expect(prisma.quota.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });

  test('cross-tenant id returns 404 without leaking the foreign row', async () => {
    prisma.quota.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .delete('/api/quotas/9999')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/quota not found/i);
    expect(prisma.quota.delete).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /attainment + GET /leaderboard — derived from buildAttainment()
// ─────────────────────────────────────────────────────────────────────────

describe('GET /attainment + /leaderboard', () => {
  test('/attainment computes per-user achieved/target/pct from won Deals in period window; target=0 yields 0%', async () => {
    prisma.quota.findMany.mockResolvedValue([
      { id: 1, userId: 7, period: '2026-Q1', target: 50000, tenantId: 1 },
      { id: 2, userId: 8, period: '2026-Q1', target: 30000, tenantId: 1 },
      // Zero-target quota — guard against div-by-zero in attainmentPct calc
      { id: 3, userId: 9, period: '2026-Q1', target: 0, tenantId: 1 },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 7, name: 'Priya', email: 'priya@example.com' },
      { id: 8, name: 'Rahul', email: 'rahul@example.com' },
      { id: 9, name: 'Anita', email: 'anita@example.com' },
    ]);
    prisma.deal.findMany.mockResolvedValue([
      { ownerId: 7, amount: 25000 }, // 50% of target
      { ownerId: 7, amount: 15000 }, // +30% → 80% total
      { ownerId: 8, amount: 45000 }, // 150% of target (overachievement)
      { ownerId: 9, amount: 5000 },  // target=0 → forced to 0%
    ]);

    const res = await request(makeApp())
      .get('/api/quotas/attainment?period=2026-Q1')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);

    const byUser = Object.fromEntries(res.body.map(r => [r.userId, r]));
    expect(byUser[7]).toEqual(expect.objectContaining({
      target: 50000, achieved: 40000, attainmentPct: 80,
    }));
    expect(byUser[8]).toEqual(expect.objectContaining({
      target: 30000, achieved: 45000, attainmentPct: 150,
    }));
    expect(byUser[9]).toEqual(expect.objectContaining({
      target: 0, achieved: 5000, attainmentPct: 0, // div-by-zero guarded
    }));

    // Deal query must scope by tenant + stage='won' + period window
    expect(prisma.deal.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 1,
        stage: 'won',
        ownerId: { in: [7, 8, 9] },
        createdAt: {
          gte: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
          lt: new Date(Date.UTC(2026, 3, 1, 0, 0, 0)),
        },
      },
      select: { ownerId: true, amount: true },
    });
  });

  test('/leaderboard returns same shape ordered by attainmentPct desc; missing ?period returns 400', async () => {
    // First, missing ?period
    const missing = await request(makeApp())
      .get('/api/quotas/leaderboard')
      .set('Authorization', makeBearer());
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/period required/i);

    // Now the happy path with descending pct order
    prisma.quota.findMany.mockResolvedValue([
      { id: 1, userId: 7, period: '2026-Q1', target: 50000, tenantId: 1 },
      { id: 2, userId: 8, period: '2026-Q1', target: 30000, tenantId: 1 },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 7, name: 'Priya', email: 'priya@example.com' },
      { id: 8, name: 'Rahul', email: 'rahul@example.com' },
    ]);
    prisma.deal.findMany.mockResolvedValue([
      { ownerId: 7, amount: 25000 }, // 50%
      { ownerId: 8, amount: 45000 }, // 150% — should sort to top
    ]);

    const res = await request(makeApp())
      .get('/api/quotas/leaderboard?period=2026-Q1')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Descending by attainmentPct: 8 (150%) before 7 (50%)
    expect(res.body[0].userId).toBe(8);
    expect(res.body[0].attainmentPct).toBe(150);
    expect(res.body[1].userId).toBe(7);
    expect(res.body[1].attainmentPct).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/quotas?fields=summary — #920 slice 25 slim-shape opt-in
// ─────────────────────────────────────────────────────────────────────────
//
// Mirrors slices 1-23. Pins the additive opt-in contract:
//
//   - ?fields=summary makes the route pass a slim `select` to Prisma
//     restricting the returned columns to id + userId + period + target.
//     tenantId, achieved, createdAt, updatedAt are dropped (the slim shape
//     is for picker / dropdown chrome that doesn't need them).
//
//   - Any OTHER value of ?fields (missing, ?fields=, ?fields=foo, ?fields=
//     SUMMARY, ?fields=summary,extra) is the legacy full-shape path —
//     comparison is strict equality `=== "summary"`.
//
//   - userName attach (the canonical 3-tier display contract from the
//     existing list tests) STILL runs on top of the slim row; the slim
//     shape is about Prisma's column projection, not the response-envelope
//     shape downstream of it.
//
//   - tenantId scoping + ?userId / ?period filters keep working identically
//     in the slim path; the slim shape is column-only, not where-clause-
//     mutating.
//
describe('GET /api/quotas?fields=summary — slim-shape opt-in (#920 slice 25)', () => {
  test('?fields=summary passes a slim Prisma select dropping tenantId/achieved/createdAt/updatedAt', async () => {
    prisma.quota.findMany.mockResolvedValue([
      { id: 1, userId: 7, period: '2026-Q2', target: 50000 },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 7, name: 'Priya Iyer', email: 'priya@example.com' },
    ]);

    const res = await request(makeApp())
      .get('/api/quotas?fields=summary')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(prisma.quota.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: [{ period: 'desc' }, { userId: 'asc' }],
      select: {
        id: true,
        userId: true,
        period: true,
        target: true,
      },
    });
  });

  test('without ?fields (legacy default) does NOT pass a select — full row shape preserved', async () => {
    prisma.quota.findMany.mockResolvedValue([
      { id: 1, userId: 7, period: '2026-Q2', target: 50000, tenantId: 1 },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 7, name: 'Priya Iyer', email: 'priya@example.com' },
    ]);

    const res = await request(makeApp())
      .get('/api/quotas')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    // No `select` key in the legacy path — full row shape comes back
    expect(prisma.quota.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: [{ period: 'desc' }, { userId: 'asc' }],
    });
  });

  test('?fields=foo (non-summary value) does NOT trigger slim shape — strict equality match', async () => {
    prisma.quota.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/quotas?fields=foo')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(prisma.quota.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: [{ period: 'desc' }, { userId: 'asc' }],
    });
    // No `select` key — legacy full-shape path
    const callArg = prisma.quota.findMany.mock.calls[0][0];
    expect(callArg.select).toBeUndefined();
  });

  test('?fields=SUMMARY (uppercase) does NOT match — strict case-sensitive equality', async () => {
    prisma.quota.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/quotas?fields=SUMMARY')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    const callArg = prisma.quota.findMany.mock.calls[0][0];
    expect(callArg.select).toBeUndefined();
  });

  test('?fields=summary still attaches userName post-query (slim is column-only, not envelope-mutating)', async () => {
    prisma.quota.findMany.mockResolvedValue([
      { id: 1, userId: 7, period: '2026-Q2', target: 50000 },
      { id: 2, userId: 8, period: '2026-Q1', target: 30000 },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 7, name: 'Priya Iyer', email: 'priya@example.com' },
      { id: 8, name: null, email: 'rahul@example.com' }, // email fallback
    ]);

    const res = await request(makeApp())
      .get('/api/quotas?fields=summary')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Slim shape still receives the userName envelope decoration
    expect(res.body[0].userName).toBe('Priya Iyer');
    expect(res.body[1].userName).toBe('rahul@example.com');
    // And the slim columns are present
    expect(res.body[0]).toEqual(expect.objectContaining({
      id: 1, userId: 7, period: '2026-Q2', target: 50000,
    }));
  });

  test('?fields=summary composes with ?userId + ?period filters (where clause unchanged)', async () => {
    prisma.quota.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/quotas?fields=summary&userId=42&period=2026-Q1')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    // Both filters AND the slim select must be honoured
    expect(prisma.quota.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, userId: 42, period: '2026-Q1' },
      orderBy: [{ period: 'desc' }, { userId: 'asc' }],
      select: {
        id: true,
        userId: true,
        period: true,
        target: true,
      },
    });
  });
});
