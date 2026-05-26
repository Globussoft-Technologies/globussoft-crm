// @ts-check
/**
 * Unit + integration tests for backend/routes/playbooks.js — pins the
 * Playbook CRUD + per-deal enrollment + step-toggle progress contracts.
 *
 * What this file pins
 * ───────────────────
 *   1. POST /api/playbooks — happy path creates a row scoped to tenantId
 *      with normalized + JSON-stringified steps; missing name/stage → 400.
 *   2. GET /api/playbooks — returns hydrated playbooks (steps parsed back
 *      to an array), supports ?stage and ?isActive query filters which
 *      flow through to the prisma where-clause exactly.
 *   3. GET /api/playbooks/:id — hydrates the JSON steps column on read;
 *      404 when the tenant scope mismatches (cross-tenant isolation),
 *      400 on a non-numeric id.
 *   4. PUT /api/playbooks/:id — partial updates respect the prisma update
 *      contract (only included fields land in data); cross-tenant
 *      mismatch returns 404 not 500.
 *   5. DELETE /api/playbooks/:id — returns 204 No Content per the #550
 *      cross-route sweep; cascades to PlaybookProgress.deleteMany first;
 *      404 when the row doesn't belong to the caller's tenant.
 *   6. POST /api/playbooks/:id/duplicate — clones the source row with a
 *      "(Copy)" suffix on the name; 404 when the source is out-of-tenant.
 *   7. GET /api/playbooks/deal/:dealId — joins playbooks-by-deal-stage,
 *      synthesizes a zero-progress row when no PlaybookProgress exists,
 *      and computes pctComplete from completedSteps + total steps.
 *   8. POST /api/playbooks/deal/:dealId/step — toggles step completion
 *      idempotently (Set semantics), creates a PlaybookProgress row on
 *      first toggle, updates the existing row on subsequent toggles,
 *      and recomputes pctComplete on the response.
 *   9. GET /api/playbooks/stats — aggregates total / active / inactive
 *      counts + per-stage avg completion percentage; back-compat shape.
 *
 * Pattern
 * ───────
 *   Mirrors backend/test/routes/communications.test.js — prisma singleton
 *   patched BEFORE the router require, no real DB needed. The route uses
 *   `prisma.playbook` + `prisma.playbookProgress` + `prisma.deal`, all
 *   stubbed with vi.fn().
 *
 *   Tenant isolation is exercised by mocking findFirst to return null
 *   when the (id, tenantId) tuple wouldn't match — the route's logic
 *   converts that null into a 404 (NOT a 500 or a silent leak).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching — must happen BEFORE the router is required.
prisma.playbook = {
  create: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.playbookProgress = {
  create: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
};
prisma.deal = prisma.deal || {};
prisma.deal.findFirst = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const playbooksRouter = requireCJS('../../routes/playbooks');

function makeApp({ tenantId = 1, userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId };
    next();
  });
  app.use('/api/playbooks', playbooksRouter);
  return app;
}

beforeEach(() => {
  prisma.playbook.create.mockReset();
  prisma.playbook.findMany.mockReset();
  prisma.playbook.findFirst.mockReset();
  prisma.playbook.update.mockReset();
  prisma.playbook.delete.mockReset();
  prisma.playbookProgress.create.mockReset();
  prisma.playbookProgress.findMany.mockReset();
  prisma.playbookProgress.findFirst.mockReset();
  prisma.playbookProgress.update.mockReset();
  prisma.playbookProgress.deleteMany.mockReset();
  prisma.deal.findFirst.mockReset();
});

// ─── POST /api/playbooks — create ────────────────────────────────────

describe('POST /api/playbooks — create', () => {
  test('happy path persists tenant-scoped row with normalized JSON steps', async () => {
    prisma.playbook.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 42, ...data, createdAt: new Date() })
    );
    const app = makeApp({ tenantId: 9 });
    const res = await request(app)
      .post('/api/playbooks')
      .send({
        name: 'Discovery Call Checklist',
        stage: 'discovery',
        steps: [
          { title: 'Send agenda', description: 'within 24h', order: 0 },
          { title: 'Confirm attendees' }, // missing description → defaults to ''
        ],
        isActive: true,
      });
    expect(res.status).toBe(201);
    expect(prisma.playbook.create).toHaveBeenCalledTimes(1);
    const args = prisma.playbook.create.mock.calls[0][0];
    expect(args.data.tenantId).toBe(9);
    expect(args.data.name).toBe('Discovery Call Checklist');
    expect(args.data.stage).toBe('discovery');
    expect(args.data.isActive).toBe(true);
    // Steps land as a JSON string on the row.
    const persistedSteps = JSON.parse(args.data.steps);
    expect(persistedSteps).toHaveLength(2);
    expect(persistedSteps[0].title).toBe('Send agenda');
    expect(persistedSteps[1].description).toBe(''); // normalizeSteps fills the blank
    // Response is hydrated (steps come back as an array, not a JSON string).
    expect(Array.isArray(res.body.steps)).toBe(true);
    expect(res.body.steps[0].title).toBe('Send agenda');
  });

  test('rejects missing name with 400', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/playbooks').send({ stage: 'discovery' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name and stage are required/);
    expect(prisma.playbook.create).not.toHaveBeenCalled();
  });

  test('rejects missing stage with 400', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/playbooks').send({ name: 'no-stage' });
    expect(res.status).toBe(400);
    expect(prisma.playbook.create).not.toHaveBeenCalled();
  });

  test('isActive defaults to true when omitted', async () => {
    prisma.playbook.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 1, ...data })
    );
    const app = makeApp();
    const res = await request(app)
      .post('/api/playbooks')
      .send({ name: 'auto-active', stage: 'demo' });
    expect(res.status).toBe(201);
    expect(prisma.playbook.create.mock.calls[0][0].data.isActive).toBe(true);
  });
});

// ─── GET /api/playbooks — list + filter ─────────────────────────────

describe('GET /api/playbooks — list', () => {
  test('returns tenant-scoped hydrated playbooks ordered by createdAt desc', async () => {
    prisma.playbook.findMany.mockResolvedValue([
      { id: 1, name: 'P1', stage: 'discovery', steps: '[{"title":"A","description":"","order":0}]', isActive: true, tenantId: 1 },
      { id: 2, name: 'P2', stage: 'demo', steps: '[]', isActive: false, tenantId: 1 },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/playbooks');
    expect(res.status).toBe(200);
    expect(prisma.playbook.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.playbook.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(1);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    // Hydration: steps come back as arrays.
    expect(Array.isArray(res.body[0].steps)).toBe(true);
    expect(res.body[0].steps[0].title).toBe('A');
    expect(res.body[1].steps).toEqual([]);
  });

  test('?stage=demo filter flows to where clause', async () => {
    prisma.playbook.findMany.mockResolvedValue([]);
    const app = makeApp();
    await request(app).get('/api/playbooks?stage=demo');
    const args = prisma.playbook.findMany.mock.calls[0][0];
    expect(args.where.stage).toBe('demo');
  });

  test('?isActive=true → where.isActive=true; ?isActive=false → false', async () => {
    prisma.playbook.findMany.mockResolvedValue([]);
    const app = makeApp();
    await request(app).get('/api/playbooks?isActive=true');
    expect(prisma.playbook.findMany.mock.calls[0][0].where.isActive).toBe(true);
    prisma.playbook.findMany.mockClear();
    await request(app).get('/api/playbooks?isActive=false');
    expect(prisma.playbook.findMany.mock.calls[0][0].where.isActive).toBe(false);
  });
});

// ─── GET /api/playbooks?fields=summary — #920 slice 11 slim-shape opt-in ─

describe('GET /api/playbooks?fields=summary — #920 slice 11 slim-shape opt-in', () => {
  test('?fields=summary attaches a slim Prisma select dropping `steps`', async () => {
    prisma.playbook.findMany.mockResolvedValue([
      { id: 1, name: 'P1', stage: 'discovery', isActive: true, tenantId: 1,
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-05-02T00:00:00Z') },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/playbooks?fields=summary');
    expect(res.status).toBe(200);
    expect(prisma.playbook.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.playbook.findMany.mock.calls[0][0];
    // Slim select MUST be present and MUST NOT include the heavy `steps` column.
    expect(args.select).toBeDefined();
    expect(args.select).toEqual({
      id: true,
      name: true,
      stage: true,
      isActive: true,
      tenantId: true,
      createdAt: true,
      updatedAt: true,
    });
    expect(args.select.steps).toBeUndefined();
    // Filters + ordering still flow through unchanged.
    expect(args.where.tenantId).toBe(1);
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('summary mode skips hydratePlaybook — response rows have NO `steps` key', async () => {
    // Prisma `select` would omit `steps` from the row entirely; the route
    // must NOT try to JSON.parse(undefined) and inject an empty `steps: []`.
    prisma.playbook.findMany.mockResolvedValue([
      { id: 1, name: 'P1', stage: 'discovery', isActive: true, tenantId: 1 },
      { id: 2, name: 'P2', stage: 'demo', isActive: false, tenantId: 1 },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/playbooks?fields=summary');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    for (const row of res.body) {
      expect(row).not.toHaveProperty('steps');
      expect(row.id).toBeDefined();
      expect(row.name).toBeDefined();
      expect(row.stage).toBeDefined();
    }
  });

  test('omitting ?fields preserves full row shape — `steps` hydrated to array (back-compat)', async () => {
    // Existing callers (no ?fields) get the unchanged response shape.
    prisma.playbook.findMany.mockResolvedValue([
      { id: 1, name: 'P1', stage: 'discovery',
        steps: '[{"title":"A","description":"","order":0}]',
        isActive: true, tenantId: 1 },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/playbooks');
    expect(res.status).toBe(200);
    // No `select` key when summary mode is OFF — full row returned.
    const args = prisma.playbook.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
    // hydratePlaybook ran → steps is an ARRAY, not the raw JSON string.
    expect(Array.isArray(res.body[0].steps)).toBe(true);
    expect(res.body[0].steps[0].title).toBe('A');
  });

  test('non-exact ?fields value (e.g. "summary,extra") falls through to full shape', async () => {
    // Strict equality only — `fields=summary` triggers slim, anything else
    // (including superset values) returns the full hydrated row.
    prisma.playbook.findMany.mockResolvedValue([
      { id: 1, name: 'P1', stage: 'discovery', steps: '[]', isActive: true, tenantId: 1 },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/playbooks?fields=summary,extra');
    expect(res.status).toBe(200);
    const args = prisma.playbook.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined(); // NOT slim
    // Hydrate path ran → `steps` is present as an array.
    expect(Array.isArray(res.body[0].steps)).toBe(true);
  });

  test('?fields=summary composes with ?stage filter — both flow through where', async () => {
    prisma.playbook.findMany.mockResolvedValue([]);
    const app = makeApp();
    await request(app).get('/api/playbooks?fields=summary&stage=demo');
    const args = prisma.playbook.findMany.mock.calls[0][0];
    expect(args.where.stage).toBe('demo');
    expect(args.where.tenantId).toBe(1);
    expect(args.select).toBeDefined();
    expect(args.select.steps).toBeUndefined();
  });

  test('?fields=summary composes with ?isActive filter', async () => {
    prisma.playbook.findMany.mockResolvedValue([]);
    const app = makeApp();
    await request(app).get('/api/playbooks?fields=summary&isActive=true');
    const args = prisma.playbook.findMany.mock.calls[0][0];
    expect(args.where.isActive).toBe(true);
    expect(args.select).toBeDefined();
  });
});

// ─── GET /api/playbooks/:id — read ──────────────────────────────────

describe('GET /api/playbooks/:id — read', () => {
  test('happy path hydrates JSON steps column', async () => {
    prisma.playbook.findFirst.mockResolvedValue({
      id: 7,
      name: 'pin',
      stage: 'demo',
      steps: '[{"title":"x","description":"","order":0}]',
      isActive: true,
      tenantId: 1,
    });
    const app = makeApp();
    const res = await request(app).get('/api/playbooks/7');
    expect(res.status).toBe(200);
    expect(prisma.playbook.findFirst.mock.calls[0][0].where).toEqual({ id: 7, tenantId: 1 });
    expect(Array.isArray(res.body.steps)).toBe(true);
    expect(res.body.steps[0].title).toBe('x');
  });

  test('400 when :id is not numeric', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/playbooks/not-a-number');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid playbook ID/);
    expect(prisma.playbook.findFirst).not.toHaveBeenCalled();
  });

  test('tenant isolation — cross-tenant id returns 404 not 500/leak', async () => {
    // The findFirst predicate's (id, tenantId) tuple won't match → null.
    prisma.playbook.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).get('/api/playbooks/999');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Playbook not found/);
  });
});

// ─── PUT /api/playbooks/:id — update ────────────────────────────────

describe('PUT /api/playbooks/:id — update', () => {
  test('partial update only sends provided fields to prisma.update', async () => {
    prisma.playbook.findFirst.mockResolvedValue({
      id: 7, name: 'old', stage: 'discovery', steps: '[]', isActive: true, tenantId: 1,
    });
    prisma.playbook.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 7, name: data.name || 'old', stage: 'discovery', steps: '[]', isActive: true, tenantId: 1 })
    );
    const app = makeApp();
    const res = await request(app)
      .put('/api/playbooks/7')
      .send({ name: 'new-name' });
    expect(res.status).toBe(200);
    const args = prisma.playbook.update.mock.calls[0][0];
    expect(args.data).toEqual({ name: 'new-name' }); // ONLY name; stage/steps/isActive untouched
    expect(args.where).toEqual({ id: 7 });
  });

  test('cross-tenant update returns 404 (findFirst null guards before update)', async () => {
    prisma.playbook.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).put('/api/playbooks/7').send({ name: 'will-not-land' });
    expect(res.status).toBe(404);
    expect(prisma.playbook.update).not.toHaveBeenCalled();
  });
});

// ─── DELETE /api/playbooks/:id — destroy + cascade ──────────────────

describe('DELETE /api/playbooks/:id — destroy', () => {
  test('204 No Content + cascades PlaybookProgress.deleteMany before delete', async () => {
    prisma.playbook.findFirst.mockResolvedValue({ id: 7, tenantId: 1 });
    prisma.playbookProgress.deleteMany.mockResolvedValue({ count: 3 });
    prisma.playbook.delete.mockResolvedValue({ id: 7 });
    const app = makeApp();
    const res = await request(app).delete('/api/playbooks/7');
    // #550 cross-route sweep: DELETE → 204 No Content.
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    // Cascade order: progress wiped first, then the playbook row.
    expect(prisma.playbookProgress.deleteMany).toHaveBeenCalledWith({
      where: { playbookId: 7, tenantId: 1 },
    });
    expect(prisma.playbook.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  test('cross-tenant delete returns 404 and does NOT touch progress rows', async () => {
    prisma.playbook.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).delete('/api/playbooks/999');
    expect(res.status).toBe(404);
    expect(prisma.playbookProgress.deleteMany).not.toHaveBeenCalled();
    expect(prisma.playbook.delete).not.toHaveBeenCalled();
  });
});

// ─── POST /api/playbooks/:id/duplicate — clone ──────────────────────

describe('POST /api/playbooks/:id/duplicate — clone', () => {
  test('clones source row with "(Copy)" suffix', async () => {
    prisma.playbook.findFirst.mockResolvedValue({
      id: 7, name: 'Original', stage: 'demo', steps: '[{"title":"a","description":"","order":0}]', isActive: true, tenantId: 1,
    });
    prisma.playbook.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 8, ...data })
    );
    const app = makeApp();
    const res = await request(app).post('/api/playbooks/7/duplicate');
    expect(res.status).toBe(201);
    const args = prisma.playbook.create.mock.calls[0][0];
    expect(args.data.name).toBe('Original (Copy)');
    expect(args.data.stage).toBe('demo');
    expect(args.data.tenantId).toBe(1);
    // steps column copied verbatim (still a JSON string at persist time).
    expect(args.data.steps).toBe('[{"title":"a","description":"","order":0}]');
    // Response is hydrated.
    expect(Array.isArray(res.body.steps)).toBe(true);
  });

  test('cross-tenant duplicate returns 404 — does NOT create stray row', async () => {
    prisma.playbook.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).post('/api/playbooks/999/duplicate');
    expect(res.status).toBe(404);
    expect(prisma.playbook.create).not.toHaveBeenCalled();
  });
});

// ─── GET /api/playbooks/deal/:dealId — enrollment view ──────────────

describe('GET /api/playbooks/deal/:dealId — enrollment view', () => {
  test('returns playbooks for the deal stage with synthesized zero-progress when none exists', async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: 50, stage: 'discovery', tenantId: 1 });
    prisma.playbook.findMany.mockResolvedValue([
      {
        id: 7, name: 'Disco', stage: 'discovery',
        steps: '[{"title":"a","description":"","order":0},{"title":"b","description":"","order":1}]',
        isActive: true, tenantId: 1,
      },
    ]);
    prisma.playbookProgress.findFirst.mockResolvedValue(null); // no enrollment yet
    const app = makeApp();
    const res = await request(app).get('/api/playbooks/deal/50');
    expect(res.status).toBe(200);
    expect(prisma.playbook.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      stage: 'discovery',
      isActive: true,
    });
    expect(res.body).toHaveLength(1);
    expect(res.body[0].playbook.id).toBe(7);
    expect(res.body[0].progress.completedSteps).toEqual([]);
    expect(res.body[0].progress.pctComplete).toBe(0);
  });

  test('hydrates existing progress + computes pctComplete = round(done/total * 100)', async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: 50, stage: 'demo', tenantId: 1 });
    prisma.playbook.findMany.mockResolvedValue([
      {
        id: 9, name: 'Demo', stage: 'demo',
        // 3 steps total
        steps: '[{"title":"a","description":"","order":0},{"title":"b","description":"","order":1},{"title":"c","description":"","order":2}]',
        isActive: true, tenantId: 1,
      },
    ]);
    prisma.playbookProgress.findFirst.mockResolvedValue({
      id: 100,
      dealId: 50,
      playbookId: 9,
      completedSteps: '[0,2]', // 2 of 3 done
      tenantId: 1,
    });
    const app = makeApp();
    const res = await request(app).get('/api/playbooks/deal/50');
    expect(res.status).toBe(200);
    expect(res.body[0].progress.completedSteps).toEqual([0, 2]);
    expect(res.body[0].progress.pctComplete).toBe(67); // Math.round(2/3 * 100) = 67
  });

  test('404 when deal does not exist (cross-tenant or unknown id)', async () => {
    prisma.deal.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app).get('/api/playbooks/deal/99999');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Deal not found/);
    expect(prisma.playbook.findMany).not.toHaveBeenCalled();
  });

  test('400 when :dealId is non-numeric', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/playbooks/deal/abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid deal ID/);
  });
});

// ─── POST /api/playbooks/deal/:dealId/step — toggle progress ────────

describe('POST /api/playbooks/deal/:dealId/step — toggle step', () => {
  test('first toggle creates a PlaybookProgress row with the step in completedSteps', async () => {
    prisma.playbook.findFirst.mockResolvedValue({
      id: 7, name: 'p', stage: 'discovery',
      steps: '[{"title":"a","description":"","order":0},{"title":"b","description":"","order":1}]',
      tenantId: 1,
    });
    prisma.deal.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.playbookProgress.findFirst.mockResolvedValue(null); // no row yet
    prisma.playbookProgress.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 200, ...data })
    );
    const app = makeApp();
    const res = await request(app)
      .post('/api/playbooks/deal/50/step')
      .send({ playbookId: 7, stepIndex: 1, completed: true });
    expect(res.status).toBe(200);
    expect(prisma.playbookProgress.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.playbookProgress.create.mock.calls[0][0];
    expect(createArgs.data.dealId).toBe(50);
    expect(createArgs.data.playbookId).toBe(7);
    expect(createArgs.data.tenantId).toBe(1);
    expect(JSON.parse(createArgs.data.completedSteps)).toEqual([1]);
    // Response carries hydrated progress + pctComplete (1 of 2 = 50%).
    expect(res.body.completedSteps).toEqual([1]);
    expect(res.body.pctComplete).toBe(50);
  });

  test('idempotent toggle — re-adding an already-completed step does not duplicate it', async () => {
    prisma.playbook.findFirst.mockResolvedValue({
      id: 7, steps: '[{"title":"a","description":"","order":0},{"title":"b","description":"","order":1}]',
      tenantId: 1,
    });
    prisma.deal.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.playbookProgress.findFirst.mockResolvedValue({
      id: 200, dealId: 50, playbookId: 7, completedSteps: '[0]', tenantId: 1,
    });
    prisma.playbookProgress.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 200, dealId: 50, playbookId: 7, completedSteps: data.completedSteps, tenantId: 1 })
    );
    const app = makeApp();
    const res = await request(app)
      .post('/api/playbooks/deal/50/step')
      .send({ playbookId: 7, stepIndex: 0, completed: true });
    expect(res.status).toBe(200);
    // Set semantics: step 0 already in the list, nothing new gets added.
    const args = prisma.playbookProgress.update.mock.calls[0][0];
    expect(JSON.parse(args.data.completedSteps)).toEqual([0]);
  });

  test('un-toggle removes the step from completedSteps (completed=false)', async () => {
    prisma.playbook.findFirst.mockResolvedValue({
      id: 7, steps: '[{"title":"a","description":"","order":0},{"title":"b","description":"","order":1},{"title":"c","description":"","order":2}]',
      tenantId: 1,
    });
    prisma.deal.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.playbookProgress.findFirst.mockResolvedValue({
      id: 200, dealId: 50, playbookId: 7, completedSteps: '[0,1,2]', tenantId: 1,
    });
    prisma.playbookProgress.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 200, dealId: 50, playbookId: 7, completedSteps: data.completedSteps, tenantId: 1 })
    );
    const app = makeApp();
    const res = await request(app)
      .post('/api/playbooks/deal/50/step')
      .send({ playbookId: 7, stepIndex: 1, completed: false });
    expect(res.status).toBe(200);
    const args = prisma.playbookProgress.update.mock.calls[0][0];
    expect(JSON.parse(args.data.completedSteps)).toEqual([0, 2]);
  });

  test('400 when playbookId or stepIndex is missing/non-numeric', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/playbooks/deal/50/step')
      .send({ completed: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/playbookId and stepIndex are required/);
    expect(prisma.playbookProgress.create).not.toHaveBeenCalled();
    expect(prisma.playbookProgress.update).not.toHaveBeenCalled();
  });

  test('404 when playbook is out-of-tenant', async () => {
    prisma.playbook.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app)
      .post('/api/playbooks/deal/50/step')
      .send({ playbookId: 999, stepIndex: 0, completed: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Playbook not found/);
  });

  test('404 when deal is out-of-tenant (playbook ok but deal lookup fails)', async () => {
    prisma.playbook.findFirst.mockResolvedValue({ id: 7, steps: '[]', tenantId: 1 });
    prisma.deal.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app)
      .post('/api/playbooks/deal/999/step')
      .send({ playbookId: 7, stepIndex: 0, completed: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Deal not found/);
  });
});

// ─── GET /api/playbooks/stats — aggregate metrics ───────────────────

describe('GET /api/playbooks/stats — aggregate metrics', () => {
  test('returns total / active / inactive counts and per-stage avg completion', async () => {
    prisma.playbook.findMany.mockResolvedValue([
      {
        id: 1, stage: 'discovery', isActive: true,
        steps: '[{"title":"a","description":"","order":0},{"title":"b","description":"","order":1}]',
      },
      {
        id: 2, stage: 'discovery', isActive: false,
        steps: '[{"title":"x","description":"","order":0}]',
      },
    ]);
    // Per-playbook progress lookups:
    //   p1 (2 steps): 1 enrollment at 50% (1/2 done)
    //   p2 (1 step):  1 enrollment at 100% (1/1 done)
    // Avg for 'discovery' stage = round((50 + 100) / 2) = 75
    prisma.playbookProgress.findMany
      .mockResolvedValueOnce([{ completedSteps: '[0]' }])
      .mockResolvedValueOnce([{ completedSteps: '[0]' }]);
    const app = makeApp();
    const res = await request(app).get('/api/playbooks/stats');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.active).toBe(1);
    expect(res.body.inactive).toBe(1);
    expect(Array.isArray(res.body.stages)).toBe(true);
    const discovery = res.body.stages.find((s) => s.stage === 'discovery');
    expect(discovery.count).toBe(2);
    expect(discovery.avgCompletion).toBe(75);
  });

  test('empty tenant returns zero totals + empty stages array', async () => {
    prisma.playbook.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).get('/api/playbooks/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, active: 0, inactive: 0, stages: [] });
    expect(prisma.playbookProgress.findMany).not.toHaveBeenCalled();
  });
});
