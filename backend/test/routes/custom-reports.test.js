// @ts-check
/**
 * Unit tests for backend/routes/custom_reports.js — pin the CustomReport
 * CRUD + ad-hoc /run + saved-report /:id/run execution contract.
 *
 * What this file pins
 * ───────────────────
 *   1. GET /                 — list saved reports for tenant (config JSON-parsed in response).
 *   2. GET /:id               — fetch one, 400 on non-numeric id, 404 on cross-tenant.
 *   3. POST /                 — create; 400 when `name` or `config` missing; userId pulled from req.user.userId.
 *   4. PUT /:id               — partial update; 404 on cross-tenant; config re-stringified.
 *   5. DELETE /:id            — returns 204 No Content (#550 sweep); 404 on cross-tenant.
 *   6. POST /run              — ad-hoc execute without saving; 400 on missing config.
 *   7. POST /run              — entity validation (unsupported entity → 400 with err.message).
 *   8. POST /run              — flat findMany happy path with filter (eq) + ordering + tenantId scoping.
 *   9. POST /run              — groupBy + aggregate (count / sum / avg) flow rewrites response columns.
 *  10. POST /run              — `limit` clamps to ≤1000.
 *  11. POST /:id/run          — load saved + execute; safeParse(config) round-trips JSON string.
 *  12. POST /:id/run          — cross-tenant id → 404.
 *  13. All endpoints          — tenantId scoping (every prisma where clause carries req.user.tenantId).
 *
 * Pattern reference
 * ─────────────────
 *   Mirrors backend/test/routes/attribution.test.js — prisma singleton
 *   monkey-patch BEFORE requiring the router, supertest with a fake auth
 *   middleware that sets req.user. The router has NO verifyRole gate so
 *   only req.user.tenantId / userId discipline matters.
 *
 * Notes on the route contract pinned here
 * ──────────────────────────────────────
 *   - DELETE returns 204 No Content (per the global #550 sweep — code comment
 *     "#550: DELETE → 204 No Content" on line 216 of custom_reports.js).
 *   - The /run endpoints return a 400 (not 500) when execution throws, because
 *     the catch arm maps `err.message` into a 400 envelope.
 *   - The route relies on `JSON.stringify(config)` round-tripping into a
 *     LongText column; specs assert `data.config` is a string at create/update.
 *   - executeReport() filters `columns` to entity-allowed fields; an empty
 *     filtered set falls back to the full field list (test 8 pins this).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Patch the prisma singleton BEFORE requiring the router. custom_reports.js
// touches customReport (CRUD) + deal/contact/invoice/activity/task (run).
prisma.customReport = prisma.customReport || {};
prisma.customReport.findMany = vi.fn();
prisma.customReport.findFirst = vi.fn();
prisma.customReport.create = vi.fn();
prisma.customReport.update = vi.fn();
prisma.customReport.delete = vi.fn();

prisma.deal = prisma.deal || {};
prisma.deal.findMany = vi.fn();
prisma.deal.groupBy = vi.fn();

prisma.contact = prisma.contact || {};
prisma.contact.findMany = vi.fn();
prisma.contact.groupBy = vi.fn();

prisma.invoice = prisma.invoice || {};
prisma.invoice.findMany = vi.fn();
prisma.invoice.groupBy = vi.fn();

prisma.activity = prisma.activity || {};
prisma.activity.findMany = vi.fn();

prisma.task = prisma.task || {};
prisma.task.findMany = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const customReportsRouter = requireCJS('../../routes/custom_reports');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  withUser = true,
} = {}) {
  const app = express();
  app.use(express.json());
  if (withUser) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role };
      next();
    });
  }
  app.use('/api/custom-reports', customReportsRouter);
  return app;
}

beforeEach(() => {
  prisma.customReport.findMany.mockReset();
  prisma.customReport.findFirst.mockReset();
  prisma.customReport.create.mockReset();
  prisma.customReport.update.mockReset();
  prisma.customReport.delete.mockReset();
  prisma.deal.findMany.mockReset();
  prisma.deal.groupBy.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.contact.groupBy.mockReset();
  prisma.invoice.findMany.mockReset();
  prisma.invoice.groupBy.mockReset();
  prisma.activity.findMany.mockReset();
  prisma.task.findMany.mockReset();
});

// ── GET / (list) ───────────────────────────────────────────────────────

describe('GET /api/custom-reports', () => {
  test('returns reports scoped to req.user.tenantId; config string is JSON-parsed', async () => {
    prisma.customReport.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Won deals by stage',
        description: null,
        config: JSON.stringify({ entity: 'Deal', groupBy: 'stage' }),
        userId: 7,
        tenantId: 1,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/custom-reports');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // config came back as an OBJECT (route safeParse-d the LongText string).
    expect(res.body[0].config).toEqual({ entity: 'Deal', groupBy: 'stage' });

    // Prisma where scoped by tenantId.
    expect(prisma.customReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1 },
        orderBy: { createdAt: 'desc' },
      })
    );
  });

  test('500 on Prisma blow-up (defensive try/catch)', async () => {
    prisma.customReport.findMany.mockRejectedValue(new Error('boom'));
    const res = await request(makeApp()).get('/api/custom-reports');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed/i);
  });
});

// ── GET /:id ───────────────────────────────────────────────────────────

describe('GET /api/custom-reports/:id', () => {
  test('happy path returns the saved report with parsed config', async () => {
    prisma.customReport.findFirst.mockResolvedValue({
      id: 42,
      name: 'My report',
      description: 'desc',
      config: JSON.stringify({ entity: 'Contact' }),
      userId: 7,
      tenantId: 1,
    });
    const res = await request(makeApp())
      .get('/api/custom-reports/42');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(42);
    expect(res.body.config).toEqual({ entity: 'Contact' });
    expect(prisma.customReport.findFirst).toHaveBeenCalledWith({
      where: { id: 42, tenantId: 1 },
    });
  });

  test('non-numeric id → 400 Invalid id', async () => {
    const res = await request(makeApp())
      .get('/api/custom-reports/abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
    expect(prisma.customReport.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant id → 404 (tenantId scoping)', async () => {
    prisma.customReport.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 9 }))
      .get('/api/custom-reports/42');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ── POST / (create) ────────────────────────────────────────────────────

describe('POST /api/custom-reports', () => {
  test('happy path: 201 + config stringified into LongText + userId pulled from req.user', async () => {
    prisma.customReport.create.mockResolvedValue({
      id: 9,
      name: 'New report',
      description: null,
      config: JSON.stringify({ entity: 'Deal' }),
      userId: 7,
      tenantId: 1,
      createdAt: '2026-05-25T00:00:00Z',
      updatedAt: '2026-05-25T00:00:00Z',
    });

    const res = await request(makeApp({ userId: 7, tenantId: 1 }))
      .post('/api/custom-reports')
      .send({ name: 'New report', config: { entity: 'Deal' } });

    expect(res.status).toBe(201);
    expect(res.body.config).toEqual({ entity: 'Deal' });
    // Verify prisma was called with stringified config + correct tenantId / userId.
    expect(prisma.customReport.create).toHaveBeenCalledWith({
      data: {
        name: 'New report',
        description: null,
        config: JSON.stringify({ entity: 'Deal' }),
        userId: 7,
        tenantId: 1,
      },
    });
  });

  test('missing name → 400', async () => {
    const res = await request(makeApp())
      .post('/api/custom-reports')
      .send({ config: { entity: 'Deal' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
    expect(prisma.customReport.create).not.toHaveBeenCalled();
  });

  test('missing config → 400', async () => {
    const res = await request(makeApp())
      .post('/api/custom-reports')
      .send({ name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/config/i);
    expect(prisma.customReport.create).not.toHaveBeenCalled();
  });

  test('non-object config → 400', async () => {
    const res = await request(makeApp())
      .post('/api/custom-reports')
      .send({ name: 'X', config: 'not-an-object' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/config/i);
    expect(prisma.customReport.create).not.toHaveBeenCalled();
  });
});

// ── PUT /:id ───────────────────────────────────────────────────────────

describe('PUT /api/custom-reports/:id', () => {
  test('partial update: only sent fields are written; config is re-stringified', async () => {
    prisma.customReport.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      name: 'Old',
      description: 'old',
      config: JSON.stringify({ entity: 'Deal' }),
    });
    prisma.customReport.update.mockResolvedValue({
      id: 42,
      tenantId: 1,
      name: 'Updated',
      description: 'old',
      config: JSON.stringify({ entity: 'Contact' }),
    });

    const res = await request(makeApp())
      .put('/api/custom-reports/42')
      .send({ name: 'Updated', config: { entity: 'Contact' } });

    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({ entity: 'Contact' });
    expect(prisma.customReport.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: {
        name: 'Updated',
        config: JSON.stringify({ entity: 'Contact' }),
      },
    });
  });

  test('non-numeric id → 400', async () => {
    const res = await request(makeApp())
      .put('/api/custom-reports/abc')
      .send({ name: 'X' });
    expect(res.status).toBe(400);
    expect(prisma.customReport.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant id → 404', async () => {
    prisma.customReport.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 9 }))
      .put('/api/custom-reports/42')
      .send({ name: 'X' });
    expect(res.status).toBe(404);
    expect(prisma.customReport.update).not.toHaveBeenCalled();
  });
});

// ── DELETE /:id ────────────────────────────────────────────────────────

describe('DELETE /api/custom-reports/:id', () => {
  test('happy path returns 204 No Content (per #550 sweep)', async () => {
    prisma.customReport.findFirst.mockResolvedValue({ id: 42, tenantId: 1 });
    prisma.customReport.delete.mockResolvedValue({ id: 42 });

    const res = await request(makeApp())
      .delete('/api/custom-reports/42');

    expect(res.status).toBe(204);
    // Body should be empty for 204.
    expect(res.body).toEqual({});
    expect(prisma.customReport.delete).toHaveBeenCalledWith({
      where: { id: 42 },
    });
  });

  test('non-numeric id → 400 (before any DB touch)', async () => {
    const res = await request(makeApp())
      .delete('/api/custom-reports/abc');
    expect(res.status).toBe(400);
    expect(prisma.customReport.findFirst).not.toHaveBeenCalled();
    expect(prisma.customReport.delete).not.toHaveBeenCalled();
  });

  test('cross-tenant id → 404 (delete is never called)', async () => {
    prisma.customReport.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 9 }))
      .delete('/api/custom-reports/42');
    expect(res.status).toBe(404);
    expect(prisma.customReport.delete).not.toHaveBeenCalled();
  });
});

// ── POST /run (ad-hoc) ─────────────────────────────────────────────────

describe('POST /api/custom-reports/run', () => {
  test('missing config → 400', async () => {
    const res = await request(makeApp())
      .post('/api/custom-reports/run')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/config/i);
  });

  test('unsupported entity → 400 (executeReport throw mapped to 400)', async () => {
    const res = await request(makeApp())
      .post('/api/custom-reports/run')
      .send({ config: { entity: 'NotARealEntity' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported entity/i);
  });

  test('flat findMany happy path: filter eq + ordering + tenantId scoping + entity-field column filter', async () => {
    prisma.deal.findMany.mockResolvedValue([
      { id: 1, title: 'A', amount: 1000 },
      { id: 2, title: 'B', amount: 2000 },
    ]);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/custom-reports/run')
      .send({
        config: {
          entity: 'Deal',
          filters: [{ field: 'stage', op: 'eq', value: 'won' }],
          // Mix legit and bogus columns — bogus filtered out.
          columns: ['id', 'title', 'amount', 'definitely-not-a-field'],
          orderBy: { field: 'amount', dir: 'asc' },
          limit: 50,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.columns).toEqual(['id', 'title', 'amount']);
    expect(res.body.chartType).toBe('table');

    const callArgs = prisma.deal.findMany.mock.calls[0][0];
    // tenantId always present in the where clause.
    expect(callArgs.where).toMatchObject({ tenantId: 1, stage: 'won' });
    // Only valid columns in the select projection.
    expect(callArgs.select).toEqual({ id: true, title: true, amount: true });
    // Ordering pinned.
    expect(callArgs.orderBy).toEqual({ amount: 'asc' });
    // Limit honoured (and ≤ 1000).
    expect(callArgs.take).toBe(50);
  });

  test('groupBy + sum aggregate rewrites columns into [groupKey, sum_field]', async () => {
    prisma.deal.groupBy.mockResolvedValue([
      { stage: 'won', _sum: { amount: 50000 } },
      { stage: 'lost', _sum: { amount: 10000 } },
    ]);

    const res = await request(makeApp())
      .post('/api/custom-reports/run')
      .send({
        config: {
          entity: 'Deal',
          groupBy: 'stage',
          aggregate: { type: 'sum', field: 'amount' },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual(['stage', 'sum_amount']);
    expect(res.body.rows).toEqual([
      { stage: 'won', sum_amount: 50000 },
      { stage: 'lost', sum_amount: 10000 },
    ]);

    // groupBy call was made with the expected aggregator shape + tenantId.
    const groupArgs = prisma.deal.groupBy.mock.calls[0][0];
    expect(groupArgs.by).toEqual(['stage']);
    expect(groupArgs.where).toMatchObject({ tenantId: 1 });
    expect(groupArgs._sum).toEqual({ amount: true });
  });

  test('groupBy with no aggregate type defaults to count', async () => {
    prisma.contact.groupBy.mockResolvedValue([
      { source: 'google', _count: { _all: 5 } },
      { source: 'organic', _count: { _all: 3 } },
    ]);

    const res = await request(makeApp())
      .post('/api/custom-reports/run')
      .send({
        config: { entity: 'Contact', groupBy: 'source' },
      });

    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual(['source', 'count']);
    expect(res.body.rows).toEqual([
      { source: 'google', count: 5 },
      { source: 'organic', count: 3 },
    ]);
  });

  test('limit > 1000 is clamped to 1000 (defensive ceiling)', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .post('/api/custom-reports/run')
      .send({
        config: { entity: 'Deal', limit: 9999 },
      });
    expect(res.status).toBe(200);
    const callArgs = prisma.deal.findMany.mock.calls[0][0];
    expect(callArgs.take).toBe(1000);
  });

  test('numeric coercion: filter value comes in as string but coerces to number for NUMERIC_FIELDS', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .post('/api/custom-reports/run')
      .send({
        config: {
          entity: 'Deal',
          filters: [{ field: 'amount', op: 'gt', value: '1000' }],
        },
      });
    expect(res.status).toBe(200);
    const callArgs = prisma.deal.findMany.mock.calls[0][0];
    // String '1000' should have been coerced to numeric 1000.
    expect(callArgs.where.amount).toEqual({ gt: 1000 });
  });

  test('unknown filter field is silently dropped (no exception, no SQL injection vector)', async () => {
    prisma.deal.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .post('/api/custom-reports/run')
      .send({
        config: {
          entity: 'Deal',
          filters: [
            { field: 'definitely-not-a-field', op: 'eq', value: 'x' },
            { field: 'stage', op: 'eq', value: 'won' },
          ],
        },
      });
    expect(res.status).toBe(200);
    const callArgs = prisma.deal.findMany.mock.calls[0][0];
    // Only the valid filter survived; tenantId still applied.
    expect(callArgs.where).toEqual({ tenantId: 1, stage: 'won' });
  });
});

// ── POST /:id/run ──────────────────────────────────────────────────────

describe('POST /api/custom-reports/:id/run', () => {
  test('loads saved report and executes against entity model', async () => {
    prisma.customReport.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      config: JSON.stringify({
        entity: 'Invoice',
        filters: [{ field: 'status', op: 'eq', value: 'paid' }],
        columns: ['id', 'amount', 'status'],
      }),
    });
    prisma.invoice.findMany.mockResolvedValue([
      { id: 100, amount: 5000, status: 'paid' },
    ]);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/custom-reports/42/run')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([{ id: 100, amount: 5000, status: 'paid' }]);
    expect(res.body.columns).toEqual(['id', 'amount', 'status']);

    // Tenant scope applied at BOTH the load and the run.
    expect(prisma.customReport.findFirst).toHaveBeenCalledWith({
      where: { id: 42, tenantId: 1 },
    });
    const runArgs = prisma.invoice.findMany.mock.calls[0][0];
    expect(runArgs.where).toMatchObject({ tenantId: 1, status: 'paid' });
  });

  test('non-numeric id → 400', async () => {
    const res = await request(makeApp())
      .post('/api/custom-reports/abc/run');
    expect(res.status).toBe(400);
    expect(prisma.customReport.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant id → 404 (saved report never loaded)', async () => {
    prisma.customReport.findFirst.mockResolvedValue(null);
    const res = await request(makeApp({ tenantId: 9 }))
      .post('/api/custom-reports/42/run');
    expect(res.status).toBe(404);
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(prisma.deal.findMany).not.toHaveBeenCalled();
  });

  test('saved report with unsupported entity → 400 mapped from executeReport throw', async () => {
    prisma.customReport.findFirst.mockResolvedValue({
      id: 42,
      tenantId: 1,
      config: JSON.stringify({ entity: 'NotARealEntity' }),
    });
    const res = await request(makeApp())
      .post('/api/custom-reports/42/run');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported entity/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /?fields=summary — slim-shape opt-in (#920 slice 41)
// ─────────────────────────────────────────────────────────────────────────
//
// Mirrors the slim-shape contract pinned in slices 1-39. The default list
// path returns the full CustomReport row including the heavy `config`
// @db.LongText JSON column (entity / filters / columns / groupBy /
// chartType — easily multi-KB for complex saved reports). When the caller
// passes ?fields=summary the route projects to id + name + description
// only via Prisma `select` so the heavy LongText never leaves the DB.
// Anything other than the exact string "summary" is treated as default
// (full row, with `config` JSON-parsed via safeParse).
describe('GET /api/custom-reports?fields=summary — slim-shape opt-in', () => {
  test('omitted ?fields returns default shape (full row, config parsed)', async () => {
    prisma.customReport.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Won deals by stage',
        description: null,
        config: JSON.stringify({ entity: 'Deal', groupBy: 'stage' }),
        userId: 7,
        tenantId: 1,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/custom-reports');

    expect(res.status).toBe(200);
    // Default path: config is parsed back into an object.
    expect(res.body[0].config).toEqual({ entity: 'Deal', groupBy: 'stage' });
    expect(res.body[0].userId).toBe(7);
    expect(res.body[0].createdAt).toBeDefined();

    const arg = prisma.customReport.findMany.mock.calls[0][0];
    // Default path: NO `select` clause — full row returned for safeParse.
    expect(arg.select).toBeUndefined();
    expect(arg.where).toEqual({ tenantId: 1 });
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields=summary forwards select with id+name+description only', async () => {
    prisma.customReport.findMany.mockResolvedValue([
      { id: 1, name: 'Won deals by stage', description: 'Pipeline rollup' },
      { id: 2, name: 'Activity heatmap', description: null },
    ]);

    const res = await request(makeApp())
      .get('/api/custom-reports?fields=summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual({ id: 1, name: 'Won deals by stage', description: 'Pipeline rollup' });
    // Slim path: `config` MUST NOT leak through the envelope.
    expect(res.body[0].config).toBeUndefined();

    const arg = prisma.customReport.findMany.mock.calls[0][0];
    // Heavy `config` LongText + userId + createdAt + updatedAt MUST NOT
    // appear in the slim select.
    expect(arg.select).toEqual({
      id: true,
      name: true,
      description: true,
    });
    expect(arg.select.config).toBeUndefined();
    expect(arg.select.userId).toBeUndefined();
    expect(arg.select.createdAt).toBeUndefined();
    expect(arg.select.updatedAt).toBeUndefined();
    // where + orderBy unchanged from default path.
    expect(arg.where).toEqual({ tenantId: 1 });
    expect(arg.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields=summary respects tenant scoping (cross-tenant token → different where)', async () => {
    prisma.customReport.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 99 }))
      .get('/api/custom-reports?fields=summary');

    const arg = prisma.customReport.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: 99 });
    expect(arg.select).toEqual({
      id: true,
      name: true,
      description: true,
    });
  });

  test('?fields=full (anything not exactly "summary") falls back to default shape', async () => {
    prisma.customReport.findMany.mockResolvedValue([
      {
        id: 5,
        name: 'X',
        description: null,
        config: JSON.stringify({ entity: 'Contact' }),
        userId: 1,
        tenantId: 1,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    const res = await request(makeApp())
      .get('/api/custom-reports?fields=full');

    expect(res.status).toBe(200);
    const arg = prisma.customReport.findMany.mock.calls[0][0];
    // Exact-string gate: only "summary" trips the slim branch. Anything
    // else falls back to the full-row path with no `select` clause.
    expect(arg.select).toBeUndefined();
    // Default path round-trips the LongText through safeParse.
    expect(res.body[0].config).toEqual({ entity: 'Contact' });
  });

  test('?fields=SUMMARY (uppercase) is treated as default — case-sensitive gate', async () => {
    prisma.customReport.findMany.mockResolvedValue([
      {
        id: 9,
        name: 'Y',
        description: null,
        config: JSON.stringify({ entity: 'Task' }),
        userId: 1,
        tenantId: 1,
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    const res = await request(makeApp())
      .get('/api/custom-reports?fields=SUMMARY');

    expect(res.status).toBe(200);
    const arg = prisma.customReport.findMany.mock.calls[0][0];
    // The gate is `req.query.fields === "summary"` (case-sensitive). Pin
    // the contract so a future refactor to .toLowerCase() shows up as a
    // deliberate spec edit, not a silent behaviour change.
    expect(arg.select).toBeUndefined();
    expect(res.body[0].config).toEqual({ entity: 'Task' });
  });

  test('?fields=summary returns 500 envelope on Prisma blow-up (defensive try/catch covers slim branch too)', async () => {
    prisma.customReport.findMany.mockRejectedValue(new Error('boom-slim'));

    const res = await request(makeApp())
      .get('/api/custom-reports?fields=summary');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed/i);
  });
});
