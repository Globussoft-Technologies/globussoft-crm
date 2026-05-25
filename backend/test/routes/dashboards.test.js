// @ts-check
/**
 * Unit tests for backend/routes/dashboards.js — pins the Dashboard CRUD +
 * default-toggle + widget-data resolver surface that backs the Dashboards
 * page and the home Owner-Dashboard grid.
 *
 * Why this file exists
 * ────────────────────
 * dashboards.js is a 293-LOC route surface with several distinct contracts
 * that have never been pinned by vitest:
 *
 *   - GET / — list user's own dashboards + tenant-default + shared
 *             (userId === null) rows, ordered isDefault-first, updatedAt-desc.
 *   - GET /:id — tenant-scoped single fetch. Invalid id → 400; cross-tenant
 *             or non-existent → 404 without leaking the foreign row.
 *   - POST / — create requires non-empty string name. layout is normalised
 *             to JSON.stringify of an array (defensive against non-array
 *             input). userId on the new row comes from req.user.userId.
 *   - PUT /:id — tenant-scoped update. Empty body is a valid no-op. layout
 *             accepts both array and JSON-string input (parseLayout fallback).
 *   - DELETE /:id — tenant-scoped delete. Returns { deleted: true, id }.
 *   - POST /:id/set-default — ADMIN-only. Atomically demotes any prior
 *             default + promotes the target via prisma.$transaction.
 *   - GET /:id/data — resolves real widget data for every widget in the
 *             dashboard's layout. Unknown widget types return
 *             { error: 'Unknown widget type: <type>' } per-widget WITHOUT
 *             failing the parent request. Per-widget exceptions are caught
 *             and rendered as { error: 'Failed to load widget data' }.
 *
 * Bug exposure
 * ────────────
 * Filed via gh during this commit:
 *   - GET / destructures `{ tenantId, id: userId }` from req.user, but
 *     verifyToken places the JWT payload (which has `userId`, not `id`)
 *     onto req.user. So `userId` in the list handler is ALWAYS undefined,
 *     and the OR clause `[{userId: undefined}, {userId: null}, ...]` does
 *     NOT restrict to the caller's own dashboards. This is the canonical
 *     "req.user.id vs req.user.userId" bug class — already covered by an
 *     ESLint rule, but this destructure form bypasses it.
 *     → Test pinned as `it.skip` ("TODO: filed-issue") so the contract
 *       intent is documented even though the live route is broken.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/pipelines.test.js — prisma singleton patch
 * BEFORE the router is required, real-JWT signing via config/secrets, no
 * vi.mock against middleware/auth (it doesn't intercept reliably under
 * this vitest config). $transaction stub invokes callback args with the
 * prisma singleton OR Promise.all's array args, so the set-default route
 * (which passes an array of two pending promises) resolves cleanly.
 *
 * What this file pins (15 cases across 8 describe blocks)
 * ───────────────────────────────────────────────────────
 *   1. GET / — returns tenant-scoped dashboards, layout deserialised
 *      from the JSON-string column.
 *   2. GET /:id — happy fetch with layout deserialised.
 *   3. GET /:id — non-numeric id returns 400.
 *   4. GET /:id — cross-tenant id returns 404 (tenant isolation).
 *   5. POST / — happy create: layout JSON.stringify'd, 201 + layout
 *      deserialised in response, userId from req.user.userId.
 *   6. POST / — missing/empty name returns 400 without touching prisma.
 *   7. POST / — non-array layout falls through to [] before stringify.
 *   8. PUT /:id — happy update with name + layout (array input).
 *   9. PUT /:id — accepts JSON-string layout via parseLayout fallback.
 *  10. PUT /:id — cross-tenant id returns 404 without leaking.
 *  11. DELETE /:id — happy delete returns { deleted: true, id }.
 *  12. DELETE /:id — non-existent id returns 404.
 *  13. POST /:id/set-default — ADMIN demotes prior default + promotes
 *      target inside $transaction.
 *  14. POST /:id/set-default — non-ADMIN role rejected with 403.
 *  15. GET /:id/data — resolves a layout's widgets, unknown widget type
 *      renders per-widget error envelope WITHOUT failing the request.
 *  (16. it.skip — GET / restricts to caller's own dashboards. TODO once
 *      the req.user.id → req.user.userId destructure bug is fixed.)
 */

import { describe, test, it, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patching ─────────────────────────────────────────
// Must run BEFORE the router require resolves `../lib/prisma` at import
// time. Patching the shared singleton means every internal Prisma access
// inside the route hits our vi.fn() stubs.
prisma.dashboard = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
};
// Widget resolver hits these — stub aggregate/count/groupBy/findMany on
// each model so the /:id/data endpoint can exercise the unknown-type
// fallback without a live DB.
prisma.deal = prisma.deal || {};
prisma.deal.aggregate = vi.fn().mockResolvedValue({ _sum: { amount: 0 } });
prisma.deal.count = vi.fn().mockResolvedValue(0);
prisma.deal.groupBy = vi.fn().mockResolvedValue([]);
prisma.deal.findMany = vi.fn().mockResolvedValue([]);
prisma.contact = prisma.contact || {};
prisma.contact.count = vi.fn().mockResolvedValue(0);
prisma.contact.groupBy = vi.fn().mockResolvedValue([]);
prisma.task = prisma.task || {};
prisma.task.count = vi.fn().mockResolvedValue(0);
prisma.task.findMany = vi.fn().mockResolvedValue([]);

// verifyToken's revoked-token lookup hits prisma.revokedToken.findUnique;
// stub the surface so any incidental call returns "not revoked".
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// $transaction stub: when called with a callback, invoke it with the
// prisma singleton itself so all tx.* calls hit the same vi.fn() mocks.
// When called with an ARRAY of pending promises (route uses this form
// in POST /:id/set-default), Promise.all them.
prisma.$transaction = vi.fn().mockImplementation(async (arg) => {
  if (typeof arg === 'function') return arg(prisma);
  if (Array.isArray(arg)) return Promise.all(arg);
  return arg;
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Use the SAME JWT_SECRET that verifyToken will resolve — by reaching into
// the already-cached config/secrets module. Guarantees test-token signing
// path matches verifyToken's resolution regardless of env timing.
const { JWT_SECRET } = requireCJS('../../config/secrets');
function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

const dashboardsRouter = requireCJS('../../routes/dashboards');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/dashboards', dashboardsRouter);
  return app;
}

beforeEach(() => {
  prisma.dashboard.findMany.mockReset();
  prisma.dashboard.findFirst.mockReset();
  prisma.dashboard.findUnique.mockReset();
  prisma.dashboard.create.mockReset();
  prisma.dashboard.update.mockReset();
  prisma.dashboard.updateMany.mockReset();
  prisma.dashboard.delete.mockReset();
  prisma.deal.aggregate.mockClear();
  prisma.deal.count.mockClear();
  prisma.deal.groupBy.mockClear();
  prisma.deal.findMany.mockClear();
  prisma.contact.count.mockClear();
  prisma.contact.groupBy.mockClear();
  prisma.task.count.mockClear();
  prisma.task.findMany.mockClear();
  prisma.$transaction.mockClear();
});

// ── GET / — list dashboards (tenant-scoped) ────────────────────────────

describe('GET / — list dashboards', () => {
  test('returns tenant-scoped dashboards with layout deserialised from the JSON-string column', async () => {
    prisma.dashboard.findMany.mockResolvedValue([
      { id: 11, name: 'Owner Default', isDefault: true,  userId: null,
        layout: JSON.stringify([{ i: 'w1', type: 'kpi-revenue' }]), tenantId: 1 },
      { id: 12, name: 'My Custom',     isDefault: false, userId: 7,
        layout: JSON.stringify([]), tenantId: 1 },
    ]);

    const res = await request(makeApp())
      .get('/api/dashboards')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // isDefault row comes first per the route's orderBy
    expect(res.body[0]).toEqual(expect.objectContaining({
      id: 11, name: 'Owner Default', isDefault: true,
    }));
    // layout is parsed back into an array — not a stringified blob
    expect(Array.isArray(res.body[0].layout)).toBe(true);
    expect(res.body[0].layout[0]).toEqual({ i: 'w1', type: 'kpi-revenue' });
    expect(res.body[1].layout).toEqual([]);

    // Tenant-scoped + the documented ORDER BY contract
    expect(prisma.dashboard.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 1 }),
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    }));
  });

  it('restricts to caller userId OR shared/default rows (post-fix #936)', async () => {
    // The list handler destructures `{ tenantId, id: userId }` from req.user,
    // but verifyToken places the JWT payload (with `userId`, NOT `id`) onto
    // req.user. So `userId` in this handler is ALWAYS undefined and the
    // OR clause `[{userId: undefined}, {userId: null}, {isDefault: true}]`
    // does NOT scope to the caller's own dashboards as intended.
    //
    // When the destructure is fixed to `{ tenantId, userId }`, this test
    // pins the contract: the where clause MUST include the caller's userId.
    prisma.dashboard.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/dashboards')
      .set('Authorization', makeBearer({ userId: 42 }));
    expect(prisma.dashboard.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: 1,
        OR: expect.arrayContaining([
          { userId: 42 },
          { userId: null },
          { isDefault: true },
        ]),
      }),
    }));
  });
});

// ── GET /:id — single dashboard fetch (tenant-scoped) ──────────────────

describe('GET /:id — fetch single dashboard', () => {
  test('returns the dashboard with layout deserialised', async () => {
    prisma.dashboard.findFirst.mockResolvedValue({
      id: 21, name: 'Detail', isDefault: false, userId: 7,
      layout: JSON.stringify([{ i: 'r1', type: 'kpi-deals' }]),
      tenantId: 1,
    });

    const res = await request(makeApp())
      .get('/api/dashboards/21')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(21);
    expect(res.body.layout).toEqual([{ i: 'r1', type: 'kpi-deals' }]);
    // The tenant-scoped helper was called with the parsed numeric id
    expect(prisma.dashboard.findFirst).toHaveBeenCalledWith({
      where: { id: 21, tenantId: 1 },
    });
  });

  test('returns 400 on a non-numeric id', async () => {
    const res = await request(makeApp())
      .get('/api/dashboards/not-a-number')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid dashboard ID/);
    expect(prisma.dashboard.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant / non-existent id returns 404 without leaking the foreign row', async () => {
    // findFirst's tenant-scoped where returns null for a foreign row
    prisma.dashboard.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/dashboards/9999')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Dashboard not found/);
  });
});

// ── POST / — create new dashboard ──────────────────────────────────────

describe('POST / — create dashboard', () => {
  test('creates with stringified layout + 201, response layout deserialised back to array', async () => {
    prisma.dashboard.create.mockResolvedValue({
      id: 33, name: 'New One', isDefault: false, userId: 7,
      layout: JSON.stringify([{ i: 'w1', type: 'kpi-revenue', x: 0, y: 0 }]),
      tenantId: 1,
    });

    const res = await request(makeApp())
      .post('/api/dashboards')
      .set('Authorization', makeBearer())
      .send({ name: 'New One', layout: [{ i: 'w1', type: 'kpi-revenue', x: 0, y: 0 }] });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(33);
    expect(res.body.layout).toEqual([{ i: 'w1', type: 'kpi-revenue', x: 0, y: 0 }]);
    // The create payload had a JSON-stringified layout + userId from JWT
    expect(prisma.dashboard.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'New One',
        layout: JSON.stringify([{ i: 'w1', type: 'kpi-revenue', x: 0, y: 0 }]),
        userId: 7,
        tenantId: 1,
      }),
    });
  });

  test('rejects empty / missing / non-string name with 400', async () => {
    const res1 = await request(makeApp())
      .post('/api/dashboards')
      .set('Authorization', makeBearer())
      .send({}); // missing name
    expect(res1.status).toBe(400);
    expect(res1.body.error).toMatch(/Dashboard name is required/);

    const res2 = await request(makeApp())
      .post('/api/dashboards')
      .set('Authorization', makeBearer())
      .send({ name: '' }); // empty string is falsy
    expect(res2.status).toBe(400);

    const res3 = await request(makeApp())
      .post('/api/dashboards')
      .set('Authorization', makeBearer())
      .send({ name: 42 }); // non-string
    expect(res3.status).toBe(400);

    expect(prisma.dashboard.create).not.toHaveBeenCalled();
  });

  test('coerces non-array layout to [] before JSON.stringify (defensive)', async () => {
    prisma.dashboard.create.mockResolvedValue({
      id: 34, name: 'Empty Layout', layout: JSON.stringify([]),
      userId: 7, tenantId: 1, isDefault: false,
    });

    const res = await request(makeApp())
      .post('/api/dashboards')
      .set('Authorization', makeBearer())
      .send({ name: 'Empty Layout', layout: 'not-an-array' }); // bogus input

    expect(res.status).toBe(201);
    // create() got the SAFE default [] — never the raw string
    expect(prisma.dashboard.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ layout: JSON.stringify([]) }),
    });
  });
});

// ── PUT /:id — update dashboard ────────────────────────────────────────

describe('PUT /:id — update dashboard', () => {
  test('happy update with name + array layout', async () => {
    prisma.dashboard.findFirst.mockResolvedValue({
      id: 41, name: 'Old', layout: JSON.stringify([]), tenantId: 1, userId: 7, isDefault: false,
    });
    prisma.dashboard.update.mockResolvedValue({
      id: 41, name: 'Updated', layout: JSON.stringify([{ i: 'a', type: 'kpi-deals' }]),
      tenantId: 1, userId: 7, isDefault: false,
    });

    const res = await request(makeApp())
      .put('/api/dashboards/41')
      .set('Authorization', makeBearer())
      .send({ name: 'Updated', layout: [{ i: 'a', type: 'kpi-deals' }] });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated');
    expect(res.body.layout).toEqual([{ i: 'a', type: 'kpi-deals' }]);
    expect(prisma.dashboard.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: {
        name: 'Updated',
        layout: JSON.stringify([{ i: 'a', type: 'kpi-deals' }]),
      },
    });
  });

  test('accepts JSON-string layout via parseLayout fallback (round-trips through update)', async () => {
    prisma.dashboard.findFirst.mockResolvedValue({
      id: 42, name: 'Existing', layout: JSON.stringify([]), tenantId: 1, userId: 7, isDefault: false,
    });
    prisma.dashboard.update.mockResolvedValue({
      id: 42, name: 'Existing', layout: JSON.stringify([{ i: 'fromString', type: 'kpi-tasks' }]),
      tenantId: 1, userId: 7, isDefault: false,
    });

    const res = await request(makeApp())
      .put('/api/dashboards/42')
      .set('Authorization', makeBearer())
      .send({ layout: JSON.stringify([{ i: 'fromString', type: 'kpi-tasks' }]) });

    expect(res.status).toBe(200);
    // update() got the layout re-stringified after parseLayout parsed the JSON-string input
    expect(prisma.dashboard.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: {
        layout: JSON.stringify([{ i: 'fromString', type: 'kpi-tasks' }]),
      },
    });
  });

  test('cross-tenant id returns 404 without leaking the foreign row', async () => {
    prisma.dashboard.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/dashboards/9999')
      .set('Authorization', makeBearer())
      .send({ name: 'Cross-tenant attempt' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Dashboard not found/);
    expect(prisma.dashboard.update).not.toHaveBeenCalled();
  });
});

// ── DELETE /:id — delete dashboard ─────────────────────────────────────

describe('DELETE /:id — delete dashboard', () => {
  test('happy delete returns { deleted: true, id }', async () => {
    prisma.dashboard.findFirst.mockResolvedValue({
      id: 51, name: 'Bye', layout: JSON.stringify([]), tenantId: 1, userId: 7, isDefault: false,
    });
    prisma.dashboard.delete.mockResolvedValue({ id: 51 });

    const res = await request(makeApp())
      .delete('/api/dashboards/51')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 51 });
    expect(prisma.dashboard.delete).toHaveBeenCalledWith({ where: { id: 51 } });
  });

  test('non-existent / cross-tenant id returns 404 without calling delete', async () => {
    prisma.dashboard.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .delete('/api/dashboards/9999')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Dashboard not found/);
    expect(prisma.dashboard.delete).not.toHaveBeenCalled();
  });
});

// ── POST /:id/set-default — admin-only default toggle ──────────────────

describe('POST /:id/set-default — promote dashboard to tenant default', () => {
  test('ADMIN can demote prior default + promote target inside $transaction', async () => {
    prisma.dashboard.findFirst.mockResolvedValue({
      id: 61, name: 'Promote me', layout: JSON.stringify([]), tenantId: 1, userId: 7, isDefault: false,
    });
    prisma.dashboard.updateMany.mockResolvedValue({ count: 1 });
    prisma.dashboard.update.mockResolvedValue({
      id: 61, name: 'Promote me', layout: JSON.stringify([]), tenantId: 1, userId: 7, isDefault: true,
    });
    prisma.dashboard.findUnique.mockResolvedValue({
      id: 61, name: 'Promote me', layout: JSON.stringify([]), tenantId: 1, userId: 7, isDefault: true,
    });

    const res = await request(makeApp())
      .post('/api/dashboards/61/set-default')
      .set('Authorization', makeBearer({ role: 'ADMIN' }));

    expect(res.status).toBe(200);
    expect(res.body.isDefault).toBe(true);
    // Demote step ran tenant-scoped
    expect(prisma.dashboard.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, isDefault: true },
      data: { isDefault: false },
    });
    // Target was promoted
    expect(prisma.dashboard.update).toHaveBeenCalledWith({
      where: { id: 61 },
      data: { isDefault: true },
    });
    // Atomic step used a $transaction call
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  test('non-ADMIN role is rejected with 403', async () => {
    const res = await request(makeApp())
      .post('/api/dashboards/61/set-default')
      .set('Authorization', makeBearer({ role: 'USER' }));

    expect(res.status).toBe(403);
    expect(prisma.dashboard.updateMany).not.toHaveBeenCalled();
    expect(prisma.dashboard.update).not.toHaveBeenCalled();
  });
});

// ── GET /:id/data — widget data resolver ───────────────────────────────

describe('GET /:id/data — widget data resolver', () => {
  test('resolves a layout of widgets; unknown widget type returns a per-widget error envelope WITHOUT failing the parent request', async () => {
    prisma.dashboard.findFirst.mockResolvedValue({
      id: 71, name: 'Mixed Widgets', tenantId: 1, userId: 7, isDefault: false,
      layout: JSON.stringify([
        { i: 'rev',     type: 'kpi-revenue' },     // known → real value
        { i: 'cust',    type: 'kpi-contacts' },    // known → real value
        { i: 'mystery', type: 'definitely-not-a-real-widget' }, // unknown → per-widget error
      ]),
    });
    // kpi-revenue calls prisma.deal.aggregate
    prisma.deal.aggregate.mockResolvedValue({ _sum: { amount: 12345 } });
    // kpi-contacts calls prisma.contact.count
    prisma.contact.count.mockResolvedValue(99);

    const res = await request(makeApp())
      .get('/api/dashboards/71/data')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    // Each widget is keyed by its `i` id
    expect(res.body.rev).toEqual({ value: 12345, label: 'Revenue (30d)' });
    expect(res.body.cust).toEqual({ value: 99, label: 'Total Contacts' });
    // Unknown widget type renders its OWN error envelope — does NOT 500 the request
    expect(res.body.mystery).toEqual({
      error: expect.stringMatching(/Unknown widget type: definitely-not-a-real-widget/),
    });

    // Widget aggregations were tenant-scoped
    expect(prisma.deal.aggregate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 1, stage: 'won' }),
    }));
    expect(prisma.contact.count).toHaveBeenCalledWith({ where: { tenantId: 1 } });
  });
});
