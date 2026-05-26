// @ts-check
/**
 * Unit tests for backend/routes/projects.js — pin the Project CRUD surface
 * (list / get-one / create / update / delete) under tenant scope, backing the
 * Projects admin page + Task<>Project linkage in the Sales section.
 *
 * Why this file exists
 * ────────────────────
 * projects.js is 118 LOC of plain multi-tenant CRUD that was untested. The
 * route bakes in three contracts that need pinning before drift:
 *
 *   1. Tenant isolation on every endpoint — list/get/update/delete all scope
 *      via `where: { tenantId: req.user.tenantId }` (or `findFirst` for the
 *      :id paths). A regression here is a cross-tenant data leak.
 *   2. Owner stamping on create — `ownerId: req.user.userId`. The JWT key is
 *      `userId`, NOT `id` (eslint rule + standing rule). If someone "helpfully"
 *      flips it back to `id`, ownership silently goes null.
 *   3. DELETE returns 204 No Content (per #550 cross-route sweep — DELETE
 *      handlers in this repo are 204, not 200+{message}).
 *
 * What this file pins (16 cases across 5 describe blocks)
 * ───────────────────────────────────────────────────────
 *   1. GET /          — tenant-scoped list, status filter passed through,
 *                       include={owner,contact,deal,tasks}, orderBy desc.
 *   2. GET /          — list without status filter omits the status key from
 *                       the Prisma where clause (no `status: undefined`).
 *   3. GET /:id       — tenant-scoped findFirst, 404 when not found, 400 on
 *                       NaN id, 200 + include on happy path.
 *   4. POST /         — 201, ownerId from JWT, tenantId from JWT, optional-field
 *                       defaults (description=null, priority="Medium", budget=0,
 *                       contactId/dealId nullable + parseInt'd, dates parsed).
 *   5. POST /         — 400 when name is missing.
 *   6. PUT /:id       — tenant-scoped existence check, 404 cross-tenant, 400
 *                       NaN id, partial-update body (only keys with !== undefined
 *                       go into data), parsed dates + budget.
 *   7. DELETE /:id    — tenant-scoped existence check, 204 No Content (#550),
 *                       404 cross-tenant, 400 NaN id.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/territories.test.js — prisma singleton
 * monkey-patch BEFORE requiring the router (vi.mock has CJS-bridge timing
 * issues in this repo's vitest config). Real verifyToken is replaced with a
 * passthrough; req.user is injected by a pre-router middleware. The route
 * file does NOT mount verifyToken/verifyRole itself (those run at server.js
 * level as the global auth guard), so we only need to set req.user.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// ── prisma singleton patching ──────────────────────────────────────────
import prisma from '../../lib/prisma.js';

prisma.project = prisma.project || {};
prisma.project.findMany = vi.fn();
prisma.project.findFirst = vi.fn();
prisma.project.create = vi.fn();
prisma.project.update = vi.fn();
prisma.project.delete = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const projectsRouter = requireCJS('../../routes/projects');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/projects', projectsRouter);
  return app;
}

const FULL_INCLUDE = { owner: true, contact: true, deal: true, tasks: true };

beforeEach(() => {
  prisma.project.findMany.mockReset();
  prisma.project.findFirst.mockReset();
  prisma.project.create.mockReset();
  prisma.project.update.mockReset();
  prisma.project.delete.mockReset();

  prisma.project.findMany.mockResolvedValue([]);
  prisma.project.findFirst.mockResolvedValue(null);
  prisma.project.create.mockResolvedValue({});
  prisma.project.update.mockResolvedValue({});
  prisma.project.delete.mockResolvedValue({});
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — list projects
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list projects under tenant scope', () => {
  test('returns tenant-scoped projects with full include and desc order', async () => {
    prisma.project.findMany.mockResolvedValue([
      { id: 22, name: 'Atrium Refresh', status: 'Active', tenantId: 1, ownerId: 7 },
      { id: 21, name: 'Lobby Lighting', status: 'Planning', tenantId: 1, ownerId: 7 },
    ]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/projects');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].name).toBe('Atrium Refresh');

    // Tenant isolation pinned: tenantId comes from req.user, not the query.
    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      include: FULL_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  });

  test('applies status filter from query string when present', async () => {
    prisma.project.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 1 })).get('/api/projects?status=Active');

    expect(prisma.project.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, status: 'Active' },
      include: FULL_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  });

  test('omits status key from where when query absent (no status:undefined pollution)', async () => {
    await request(makeApp({ tenantId: 1 })).get('/api/projects');

    const callArgs = prisma.project.findMany.mock.calls[0][0];
    expect(callArgs.where).toEqual({ tenantId: 1 });
    expect('status' in callArgs.where).toBe(false);
  });

  test('500 envelope on prisma failure', async () => {
    prisma.project.findMany.mockRejectedValue(new Error('db down'));

    const res = await request(makeApp({ tenantId: 1 })).get('/api/projects');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to fetch projects/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id — single project
// ─────────────────────────────────────────────────────────────────────────

describe('GET /:id — single project', () => {
  test('happy path — tenant-scoped findFirst, full include, 200', async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: 9, name: 'X', tenantId: 1, ownerId: 7,
      owner: { id: 7 }, contact: null, deal: null, tasks: [],
    });

    const res = await request(makeApp({ tenantId: 1 })).get('/api/projects/9');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(9);
    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: { id: 9, tenantId: 1 },
      include: FULL_INCLUDE,
    });
  });

  test('404 when id belongs to a different tenant (cross-tenant isolation)', async () => {
    // findFirst returns null because its where includes tenantId: 1, even
    // though Project id=777 exists in another tenant.
    prisma.project.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/projects/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
      include: FULL_INCLUDE,
    });
  });

  test('400 when :id is not an integer', async () => {
    const res = await request(makeApp({ tenantId: 1 })).get('/api/projects/not-a-num');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid project id/i);
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — create project
// ─────────────────────────────────────────────────────────────────────────

describe('POST / — create project', () => {
  test('201, tenantId + ownerId stamped from JWT, defaults applied', async () => {
    prisma.project.create.mockResolvedValue({
      id: 50, name: 'Phase 2 Build-out', tenantId: 1, ownerId: 7,
      description: null, priority: 'Medium', budget: 0,
    });

    const res = await request(makeApp({ tenantId: 1, userId: 7 }))
      .post('/api/projects')
      .send({ name: 'Phase 2 Build-out' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(50);

    // Critical contract: tenantId + ownerId come from JWT, NOT from body.
    // ownerId references req.user.userId — NOT req.user.id (eslint-rule guard).
    expect(prisma.project.create).toHaveBeenCalledWith({
      data: {
        name: 'Phase 2 Build-out',
        description: null,
        priority: 'Medium',
        startDate: null,
        endDate: null,
        budget: 0,
        ownerId: 7,
        contactId: null,
        dealId: null,
        tenantId: 1,
      },
      include: FULL_INCLUDE,
    });
  });

  test('parses dates, parseFloat budget, parseInt contactId/dealId', async () => {
    prisma.project.create.mockResolvedValue({ id: 51, name: 'Y', tenantId: 1, ownerId: 7 });

    await request(makeApp({ tenantId: 1, userId: 7 }))
      .post('/api/projects')
      .send({
        name: 'Y',
        description: 'Multi-month rollout',
        priority: 'High',
        startDate: '2026-06-01T00:00:00.000Z',
        endDate: '2026-12-31T00:00:00.000Z',
        budget: '125000.50',
        contactId: '42',
        dealId: '99',
      });

    const callArgs = prisma.project.create.mock.calls[0][0];
    expect(callArgs.data.description).toBe('Multi-month rollout');
    expect(callArgs.data.priority).toBe('High');
    expect(callArgs.data.startDate).toBeInstanceOf(Date);
    expect(callArgs.data.startDate.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(callArgs.data.endDate).toBeInstanceOf(Date);
    expect(callArgs.data.budget).toBe(125000.5);
    expect(callArgs.data.contactId).toBe(42);
    expect(callArgs.data.dealId).toBe(99);
  });

  test('400 when name is missing (rejects empty-body create)', async () => {
    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/projects')
      .send({ description: 'orphaned-no-name' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
    expect(prisma.project.create).not.toHaveBeenCalled();
  });

  test('500 envelope on prisma failure', async () => {
    prisma.project.create.mockRejectedValue(new Error('unique-violation'));

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/projects')
      .send({ name: 'Conflicting' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to create project/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id — update project
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /:id — update project', () => {
  test('200, partial update — only !== undefined keys flow into data', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 5, tenantId: 1, name: 'Old', ownerId: 7 });
    prisma.project.update.mockResolvedValue({
      id: 5, tenantId: 1, name: 'Renamed', ownerId: 7, status: 'Active',
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/projects/5')
      .send({ name: 'Renamed', status: 'Active' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');

    // Existence check is tenant-scoped.
    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: { id: 5, tenantId: 1 },
    });

    // Critical: only the keys the caller sent end up in data — no nulling
    // out of priority/budget/dates just because they weren't in the body.
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { name: 'Renamed', status: 'Active' },
      include: FULL_INCLUDE,
    });
  });

  test('parses dates + budget + contactId/dealId on partial update', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 5, tenantId: 1 });
    prisma.project.update.mockResolvedValue({ id: 5, tenantId: 1 });

    await request(makeApp({ tenantId: 1 }))
      .put('/api/projects/5')
      .send({
        startDate: '2026-07-01T00:00:00.000Z',
        endDate: '',                // falsy → null (route does `? new Date() : null`)
        budget: '7500.25',
        contactId: '88',
        dealId: '',                 // falsy → null
      });

    const callArgs = prisma.project.update.mock.calls[0][0];
    expect(callArgs.data.startDate).toBeInstanceOf(Date);
    expect(callArgs.data.endDate).toBeNull();
    expect(callArgs.data.budget).toBe(7500.25);
    expect(callArgs.data.contactId).toBe(88);
    expect(callArgs.data.dealId).toBeNull();
  });

  test('404 when project id belongs to a different tenant', async () => {
    prisma.project.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/projects/777')
      .send({ name: 'Hijack' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  test('400 when :id is not an integer', async () => {
    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/projects/not-an-int')
      .send({ name: 'Whatever' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid project id/i);
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — delete project
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /:id — delete project', () => {
  test('204 No Content on happy path (#550 cross-route DELETE shape)', async () => {
    prisma.project.findFirst.mockResolvedValue({ id: 9, tenantId: 1, name: 'Old' });
    prisma.project.delete.mockResolvedValue({ id: 9 });

    const res = await request(makeApp({ tenantId: 1 })).delete('/api/projects/9');

    expect(res.status).toBe(204);
    // 204 means no body — supertest renders this as empty object/string.
    expect(res.body).toEqual({});
    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: { id: 9, tenantId: 1 },
    });
    expect(prisma.project.delete).toHaveBeenCalledWith({ where: { id: 9 } });
  });

  test('404 when id belongs to a different tenant', async () => {
    prisma.project.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).delete('/api/projects/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.project.delete).not.toHaveBeenCalled();
  });

  test('400 when :id is not an integer', async () => {
    const res = await request(makeApp({ tenantId: 1 })).delete('/api/projects/abc');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid project id/i);
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });
});

// ─── GET /?fields=summary — slim-shape PII reduction (#920 slice 5) ─

/**
 * #920 slice 5 — opt-in slim Prisma `select` to drop heavy nested includes
 * (owner + contact + deal + tasks) and sensitive flat columns (description,
 * budget) from list responses. Mirrors the contacts/deals/tickets/tasks shape
 * shipped in slices 1-4. ADDITIVE only; any non-`summary` value (or absent
 * param) leaves the existing full-shape include path untouched. Pins:
 *   1. response rows carry only the slim keys (no nested objects on the wire).
 *   2. prisma.project.findMany called with `select` (not `include`) on slim path.
 *   3. ?fields= absent → existing full-shape include path preserved.
 *   4. ?fields=anything-else → full-shape include path (exact-string match).
 *   5. tenant scoping is preserved on the slim path.
 */
describe('GET /api/projects?fields=summary — slim-shape opt-in (#920 slice 5)', () => {
  test('?fields=summary: response rows carry only slim keys (no nested objects)', async () => {
    prisma.project.findMany.mockResolvedValue([
      {
        id: 1, name: 'Atrium Refresh', status: 'Active', priority: 'High',
        startDate: new Date('2026-06-01'), endDate: new Date('2026-12-31'),
        ownerId: 7, tenantId: 1, createdAt: new Date('2026-01-01'),
      },
      {
        id: 2, name: 'Lobby Lighting', status: 'Planning', priority: 'Medium',
        startDate: null, endDate: null,
        ownerId: 7, tenantId: 1, createdAt: new Date('2026-01-02'),
      },
    ]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/projects?fields=summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // No nested includes leaked into the response.
    expect(res.body[0].owner).toBeUndefined();
    expect(res.body[0].contact).toBeUndefined();
    expect(res.body[0].deal).toBeUndefined();
    expect(res.body[0].tasks).toBeUndefined();
    // Slim keys present.
    expect(res.body[0]).toHaveProperty('id');
    expect(res.body[0]).toHaveProperty('name');
    expect(res.body[0]).toHaveProperty('status');
    expect(res.body[0]).toHaveProperty('priority');
    expect(res.body[0]).toHaveProperty('ownerId');
    expect(res.body[0]).toHaveProperty('tenantId');
    expect(res.body[0]).toHaveProperty('createdAt');
  });

  test('?fields=summary: prisma.project.findMany called with select (not include)', async () => {
    prisma.project.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 1 })).get('/api/projects?fields=summary');

    const findArgs = prisma.project.findMany.mock.calls[0][0];
    // Slim path: select is set, include is absent.
    expect(findArgs.select).toBeDefined();
    expect(findArgs.include).toBeUndefined();
    // The slim select contains exactly the documented field set.
    expect(findArgs.select).toEqual({
      id: true,
      name: true,
      status: true,
      priority: true,
      startDate: true,
      endDate: true,
      ownerId: true,
      tenantId: true,
      createdAt: true,
    });
  });

  test('?fields= (absent): existing full-shape include path is preserved', async () => {
    prisma.project.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 1 })).get('/api/projects');

    const findArgs = prisma.project.findMany.mock.calls[0][0];
    // Full-shape path: include is set, select is absent.
    expect(findArgs.include).toEqual(FULL_INCLUDE);
    expect(findArgs.select).toBeUndefined();
  });

  test('?fields=anything-else: opt-in is exact-string only, NOT a prefix match', async () => {
    prisma.project.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 1 })).get('/api/projects?fields=summaryfoo');

    const findArgs = prisma.project.findMany.mock.calls[0][0];
    // Any non-exact 'summary' value falls through to the full-shape include.
    expect(findArgs.include).toEqual(FULL_INCLUDE);
    expect(findArgs.select).toBeUndefined();
  });

  test('?fields=summary: tenant scoping + status filter preserved on slim path', async () => {
    prisma.project.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 42 })).get('/api/projects?fields=summary&status=Active');

    const findArgs = prisma.project.findMany.mock.calls[0][0];
    // Tenant isolation must survive the shape swap.
    expect(findArgs.where.tenantId).toBe(42);
    // Status filter must still apply on the slim path.
    expect(findArgs.where.status).toBe('Active');
    // Slim path was taken.
    expect(findArgs.select).toBeDefined();
    expect(findArgs.include).toBeUndefined();
  });
});
