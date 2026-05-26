// @ts-check
/**
 * Unit tests for backend/routes/pipeline_stages.js — pins the PipelineStage
 * CRUD + reorder surface that backs the Settings → Pipelines → Stages editor
 * and the Deal Board's per-stage column ordering.
 *
 * Why this file exists
 * ────────────────────
 * pipeline_stages.js is an 85-LOC route surface that had ZERO direct vitest
 * coverage at the route level prior to this file. The Deal Board groups deals
 * by PipelineStage.position to render the kanban columns, so any silent drift
 * in the read-ordering contract (orderBy: position asc), the create-defaults
 * (color #3b82f6, position 0), the tenant-isolation 404 on PUT / DELETE, or
 * the reorder endpoint's "only-update-stages-this-tenant-owns" guard would
 * break the production board rendering for one or many tenants.
 *
 * Key contract points pinned
 * ──────────────────────────
 *   GET /            — tenant-scoped findMany ordered by position asc
 *   POST /           — create with defaults: color='#3b82f6', position=0,
 *                      tenantId from req.user.tenantId. Returns 201.
 *   PUT /reorder     — body { stages: [{id, position}, ...] }; only stages
 *                      whose id appears in the tenant's owned set are
 *                      updated (silent skip for foreign ids); returns the
 *                      full re-ordered list. Non-array body → 400.
 *   PUT /:id         — tenant-isolation via findFirst { id, tenantId }; 404
 *                      when the stage belongs to another tenant. Update
 *                      payload is { name, color, position }.
 *   DELETE /:id      — tenant-isolation via findFirst; returns 204 No Content
 *                      on success (#550 sweep — DELETE → 204 across the
 *                      codebase). 404 on cross-tenant access.
 *   verifyToken      — applied router-level via router.use(verifyToken). All
 *                      routes return 401 when the Authorization header is
 *                      missing or invalid.
 *
 * Note on INVALID_ID handling
 * ───────────────────────────
 *   The SUT does NOT short-circuit non-numeric ids — it lets parseInt(NaN)
 *   flow into findFirst's where clause, which returns null, which the route
 *   maps to 404. The test pins this observed behaviour (non-numeric id ⇒ 404,
 *   not 400) rather than asserting a guard that does not exist. If a future
 *   refactor adds an explicit 400 INVALID_ID short-circuit (matching
 *   pipelines.js's pattern) this test will need a one-line update.
 *
 * Test pattern
 * ────────────
 * Mirror of backend/test/routes/pipelines.test.js — prisma singleton patch
 * BEFORE the router is required, real JWT bearer signed with the same
 * config/secrets.JWT_SECRET that verifyToken (real middleware) resolves at
 * runtime. No CJS self-mocking seam needed (pipeline_stages.js has no audit
 * write path).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patching ─────────────────────────────────────────
// Must happen BEFORE the router is required, since the router's top-level
// `require('../lib/prisma')` resolves at import time.
prisma.pipelineStage = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

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

const pipelineStagesRouter = requireCJS('../../routes/pipeline_stages');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/pipeline-stages', pipelineStagesRouter);
  return app;
}

beforeEach(() => {
  prisma.pipelineStage.findMany.mockReset();
  prisma.pipelineStage.findFirst.mockReset();
  prisma.pipelineStage.create.mockReset();
  prisma.pipelineStage.update.mockReset();
  prisma.pipelineStage.delete.mockReset();
});

// ── Auth gate ───────────────────────────────────────────────────────────

describe('auth gate', () => {
  test('GET / with no Authorization header → 401', async () => {
    const res = await request(makeApp()).get('/api/pipeline-stages');
    expect(res.status).toBe(401);
    // pin the standard WWW-Authenticate response header
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    expect(prisma.pipelineStage.findMany).not.toHaveBeenCalled();
  });

  test('POST / with no Authorization header → 401 (no DB write)', async () => {
    const res = await request(makeApp())
      .post('/api/pipeline-stages')
      .send({ name: 'Should Fail' });
    expect(res.status).toBe(401);
    expect(prisma.pipelineStage.create).not.toHaveBeenCalled();
  });
});

// ── GET / — list stages tenant-scoped + ordered by position asc ─────────

describe('GET / — list pipeline stages', () => {
  test('returns tenant-scoped stages ordered by position asc', async () => {
    prisma.pipelineStage.findMany.mockResolvedValue([
      { id: 11, name: 'Lead',     color: '#3b82f6', position: 0, tenantId: 1 },
      { id: 12, name: 'Proposal', color: '#f59e0b', position: 1, tenantId: 1 },
      { id: 13, name: 'Won',      color: '#10b981', position: 2, tenantId: 1 },
    ]);

    const res = await request(makeApp())
      .get('/api/pipeline-stages')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0]).toEqual(expect.objectContaining({ id: 11, name: 'Lead', position: 0 }));
    expect(res.body[2]).toEqual(expect.objectContaining({ id: 13, name: 'Won', position: 2 }));

    // Tenant-scoped + ordered by position ascending
    expect(prisma.pipelineStage.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: { position: 'asc' },
    });
  });

  test('returns 500 envelope when prisma throws', async () => {
    prisma.pipelineStage.findMany.mockRejectedValue(new Error('connection lost'));

    const res = await request(makeApp())
      .get('/api/pipeline-stages')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch pipeline stages' });
  });
});

// ── POST / — create stage ────────────────────────────────────────────────

describe('POST / — create pipeline stage', () => {
  test('creates a stage with explicit name/color/position and stamps tenantId from JWT', async () => {
    prisma.pipelineStage.create.mockResolvedValue({
      id: 99, name: 'Negotiation', color: '#a855f7', position: 3, tenantId: 1,
    });

    const res = await request(makeApp())
      .post('/api/pipeline-stages')
      .set('Authorization', makeBearer())
      .send({ name: 'Negotiation', color: '#a855f7', position: 3 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      id: 99, name: 'Negotiation', color: '#a855f7', position: 3, tenantId: 1,
    }));
    expect(prisma.pipelineStage.create).toHaveBeenCalledWith({
      data: {
        name: 'Negotiation',
        color: '#a855f7',
        position: 3,
        tenantId: 1,
      },
    });
  });

  test('applies default color #3b82f6 and default position 0 when omitted', async () => {
    prisma.pipelineStage.create.mockImplementation(async ({ data }) => ({
      id: 100, ...data,
    }));

    const res = await request(makeApp())
      .post('/api/pipeline-stages')
      .set('Authorization', makeBearer())
      .send({ name: 'Stage With Defaults' });

    expect(res.status).toBe(201);
    expect(prisma.pipelineStage.create).toHaveBeenCalledWith({
      data: {
        name: 'Stage With Defaults',
        color: '#3b82f6',  // default blue
        position: 0,       // default top-of-list
        tenantId: 1,
      },
    });
    expect(res.body.color).toBe('#3b82f6');
    expect(res.body.position).toBe(0);
  });

  test('position=0 explicit value is preserved (does NOT fall back to default)', async () => {
    // Sanity check the `position ?? 0` operator — explicit 0 must not be
    // overwritten by the nullish-coalescing fallback.
    prisma.pipelineStage.create.mockImplementation(async ({ data }) => ({
      id: 101, ...data,
    }));

    const res = await request(makeApp())
      .post('/api/pipeline-stages')
      .set('Authorization', makeBearer())
      .send({ name: 'Explicit Zero', position: 0 });

    expect(res.status).toBe(201);
    expect(prisma.pipelineStage.create.mock.calls[0][0].data.position).toBe(0);
  });

  test('returns 500 envelope when prisma.create throws', async () => {
    prisma.pipelineStage.create.mockRejectedValue(new Error('db down'));

    const res = await request(makeApp())
      .post('/api/pipeline-stages')
      .set('Authorization', makeBearer())
      .send({ name: 'Will Fail' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to create pipeline stage' });
  });
});

// ── PUT /:id — update stage (tenant-isolated) ────────────────────────────

describe('PUT /:id — update pipeline stage', () => {
  test('happy update — patches name, color, position; preserves tenant scope', async () => {
    prisma.pipelineStage.findFirst.mockResolvedValue({
      id: 50, name: 'Old', color: '#000000', position: 1, tenantId: 1,
    });
    prisma.pipelineStage.update.mockResolvedValue({
      id: 50, name: 'New', color: '#ffffff', position: 2, tenantId: 1,
    });

    const res = await request(makeApp())
      .put('/api/pipeline-stages/50')
      .set('Authorization', makeBearer())
      .send({ name: 'New', color: '#ffffff', position: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      id: 50, name: 'New', color: '#ffffff', position: 2,
    }));
    // findFirst is tenant-scoped — not findUnique by id alone
    expect(prisma.pipelineStage.findFirst).toHaveBeenCalledWith({
      where: { id: 50, tenantId: 1 },
    });
    expect(prisma.pipelineStage.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { name: 'New', color: '#ffffff', position: 2 },
    });
  });

  test('cross-tenant id returns 404 — no foreign row leak', async () => {
    // findFirst's tenant-scoped where clause returns null for a foreign row.
    prisma.pipelineStage.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/pipeline-stages/9999')
      .set('Authorization', makeBearer())
      .send({ name: 'Cross-tenant attempt' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Pipeline stage not found' });
    expect(prisma.pipelineStage.update).not.toHaveBeenCalled();
  });

  test('non-numeric id → 404 (route lets parseInt NaN flow into findFirst, which misses)', async () => {
    // The SUT does NOT short-circuit non-numeric ids with a 400 INVALID_ID
    // guard. parseInt('not-a-number') → NaN; findFirst({ where: { id: NaN } })
    // returns null; route maps null → 404. This test pins the observed
    // behaviour. If a future refactor adds an explicit INVALID_ID short-
    // circuit (matching pipelines.js), update this assertion to expect 400.
    prisma.pipelineStage.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/pipeline-stages/not-a-number')
      .set('Authorization', makeBearer())
      .send({ name: 'Whatever' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Pipeline stage not found' });
    expect(prisma.pipelineStage.update).not.toHaveBeenCalled();
  });
});

// ── DELETE /:id — soft delete (tenant-isolated, returns 204 per #550) ────

describe('DELETE /:id — delete pipeline stage', () => {
  test('deletes a tenant-owned stage and returns 204 No Content (#550 sweep)', async () => {
    prisma.pipelineStage.findFirst.mockResolvedValue({
      id: 60, name: 'To Delete', color: '#3b82f6', position: 4, tenantId: 1,
    });
    prisma.pipelineStage.delete.mockResolvedValue({ id: 60 });

    const res = await request(makeApp())
      .delete('/api/pipeline-stages/60')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(204);
    // 204 No Content has zero body
    expect(res.body).toEqual({});
    expect(res.text).toBe('');
    expect(prisma.pipelineStage.delete).toHaveBeenCalledWith({ where: { id: 60 } });
  });

  test('cross-tenant id returns 404 without invoking delete', async () => {
    prisma.pipelineStage.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .delete('/api/pipeline-stages/9999')
      .set('Authorization', makeBearer());

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Pipeline stage not found' });
    expect(prisma.pipelineStage.delete).not.toHaveBeenCalled();
  });
});

// ── PUT /reorder — bulk reorder, tenant-owned ids only ───────────────────

describe('PUT /reorder — bulk reorder pipeline stages', () => {
  test('reorders the tenant\'s stages, returns the re-ordered list', async () => {
    // Tenant owns stages 11, 12, 13. Reorder sends new positions for all three.
    prisma.pipelineStage.findMany
      // First call — owned-ids check
      .mockResolvedValueOnce([{ id: 11 }, { id: 12 }, { id: 13 }])
      // Second call — final findMany after updates resolve
      .mockResolvedValueOnce([
        { id: 12, name: 'Proposal', color: '#f59e0b', position: 0, tenantId: 1 },
        { id: 13, name: 'Won',      color: '#10b981', position: 1, tenantId: 1 },
        { id: 11, name: 'Lead',     color: '#3b82f6', position: 2, tenantId: 1 },
      ]);
    prisma.pipelineStage.update.mockResolvedValue({ id: 0 });

    const res = await request(makeApp())
      .put('/api/pipeline-stages/reorder')
      .set('Authorization', makeBearer())
      .send({
        stages: [
          { id: 12, position: 0 },
          { id: 13, position: 1 },
          { id: 11, position: 2 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0]).toEqual(expect.objectContaining({ id: 12, position: 0 }));
    expect(res.body[1]).toEqual(expect.objectContaining({ id: 13, position: 1 }));
    expect(res.body[2]).toEqual(expect.objectContaining({ id: 11, position: 2 }));

    // Owned-ids check filtered by tenantId + the candidate id set
    expect(prisma.pipelineStage.findMany).toHaveBeenNthCalledWith(1, {
      where: { tenantId: 1, id: { in: [12, 13, 11] } },
      select: { id: true },
    });
    // Final list returned tenant-scoped + position-ordered
    expect(prisma.pipelineStage.findMany).toHaveBeenNthCalledWith(2, {
      where: { tenantId: 1 },
      orderBy: { position: 'asc' },
    });
    // Each owned stage was individually updated with its new position
    expect(prisma.pipelineStage.update).toHaveBeenCalledTimes(3);
    expect(prisma.pipelineStage.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { position: 0 },
    });
    expect(prisma.pipelineStage.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { position: 2 },
    });
  });

  test('silently skips foreign ids — only tenant-owned stages are updated', async () => {
    // Tenant owns 11 only; payload includes 11 (owned) + 999 (foreign).
    prisma.pipelineStage.findMany
      .mockResolvedValueOnce([{ id: 11 }]) // owned-ids check → only 11
      .mockResolvedValueOnce([
        { id: 11, name: 'Lead', color: '#3b82f6', position: 5, tenantId: 1 },
      ]);
    prisma.pipelineStage.update.mockResolvedValue({ id: 11 });

    const res = await request(makeApp())
      .put('/api/pipeline-stages/reorder')
      .set('Authorization', makeBearer())
      .send({
        stages: [
          { id: 11,  position: 5 },
          { id: 999, position: 0 }, // foreign — must NOT be updated
        ],
      });

    expect(res.status).toBe(200);
    // Only the owned stage was updated; foreign id silently dropped
    expect(prisma.pipelineStage.update).toHaveBeenCalledTimes(1);
    expect(prisma.pipelineStage.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { position: 5 },
    });
  });

  test('non-array body returns 400 stages-array-required', async () => {
    const res = await request(makeApp())
      .put('/api/pipeline-stages/reorder')
      .set('Authorization', makeBearer())
      .send({ stages: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'stages array required' });
    expect(prisma.pipelineStage.findMany).not.toHaveBeenCalled();
    expect(prisma.pipelineStage.update).not.toHaveBeenCalled();
  });
});
