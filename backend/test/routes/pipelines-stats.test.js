// @ts-check
/**
 * CRM polish — pin GET /api/pipelines/stats contract.
 *
 * What this file pins
 * ───────────────────
 *   - Auth gate: missing Authorization header -> 401.
 *   - 400 INVALID_DATE on bad ?from / ?to (independent validation, short-circuit
 *     BEFORE any prisma call).
 *   - Empty tenant: zeroed envelope (totalPipelines=0, totalStages=0,
 *     avgStagesPerPipeline=null, defaultPipelineId=null, lastCreatedAt=null).
 *   - Happy path: 4 pipelines + 6 stages -> totalPipelines=4, totalStages=6,
 *     avgStagesPerPipeline=1.5 (half-up 2dp).
 *   - avgStagesPerPipeline rounding: 7 stages / 3 pipelines -> 2.33 (half-up).
 *   - avgStagesPerPipeline = null when totalPipelines = 0 even if stages > 0
 *     (orphaned stages from an earlier soft-deleted-pipeline state).
 *   - defaultPipelineId = id of pipeline where isDefault=true.
 *   - defaultPipelineId = null when no pipeline is the default.
 *   - lastCreatedAt = max Pipeline.createdAt as ISO string.
 *   - Tenant isolation: prisma where.tenantId comes from req.user.tenantId
 *     on BOTH Pipeline.count and PipelineStage.count.
 *   - ?from/?to narrows pipeline aggregates via createdAt clauses; stages
 *     count stays unbounded (PipelineStage has no Pipeline FK).
 *   - NO audit row written (auditLog.create not called).
 *
 * Schema reality (verified against prisma/schema.prisma)
 * --------------------------------------------------------------------
 *   Pipeline (line 1956): id, name, isDefault, description, tenantId,
 *     createdAt, updatedAt.
 *   PipelineStage (line 1333): id, name, color, position, createdAt,
 *     tenantId. NO pipelineId column — stages are tenant-shared, not
 *     scoped to a specific pipeline.
 *
 * Pattern reference: backend/test/routes/accounting-stats.test.js — patches
 * the prisma singleton with vi.fn() BEFORE requiring the router, drives
 * supertest with HS256 JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.pipeline = prisma.pipeline || {};
prisma.pipeline.count = vi.fn();
prisma.pipeline.findFirst = vi.fn();
prisma.pipelineStage = prisma.pipelineStage || {};
prisma.pipelineStage.count = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.fieldPermission = prisma.fieldPermission || {};
prisma.fieldPermission.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const pipelinesRouter = requireCJS('../../routes/pipelines');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/pipelines', pipelinesRouter);
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
  prisma.pipeline.count.mockReset();
  prisma.pipeline.findFirst.mockReset();
  prisma.pipelineStage.count.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/pipelines/stats', () => {
  test('auth gate: missing Authorization header -> 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/pipelines/stats');
    expect(res.status).toBe(401);
    expect(prisma.pipeline.count).not.toHaveBeenCalled();
    expect(prisma.pipelineStage.count).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?from', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/pipelines/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.pipeline.count).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE on bad ?to', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/api/pipelines/stats?to=also-bad')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.pipeline.count).not.toHaveBeenCalled();
  });

  test('empty tenant: zeroed envelope + nullable fields all null', async () => {
    prisma.pipeline.count.mockResolvedValue(0);
    prisma.pipelineStage.count.mockResolvedValue(0);
    prisma.pipeline.findFirst.mockResolvedValue(null);

    const app = makeApp();
    const res = await request(app)
      .get('/api/pipelines/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalPipelines: 0,
      totalStages: 0,
      avgStagesPerPipeline: null,
      defaultPipelineId: null,
      lastCreatedAt: null,
    });
  });

  test('happy path: 4 pipelines + 6 stages -> avgStagesPerPipeline=1.5', async () => {
    const defaultPipe = { id: 11 };
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.pipeline.count.mockResolvedValue(4);
    prisma.pipelineStage.count.mockResolvedValue(6);
    // Two findFirst calls: [default-lookup, latest-lookup]
    prisma.pipeline.findFirst
      .mockResolvedValueOnce(defaultPipe)
      .mockResolvedValueOnce({ createdAt: newest });

    const app = makeApp();
    const res = await request(app)
      .get('/api/pipelines/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalPipelines).toBe(4);
    expect(res.body.totalStages).toBe(6);
    expect(res.body.avgStagesPerPipeline).toBe(1.5);
    expect(res.body.defaultPipelineId).toBe(11);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
  });

  test('avgStagesPerPipeline half-up 2dp rounding: 7/3 -> 2.33', async () => {
    prisma.pipeline.count.mockResolvedValue(3);
    prisma.pipelineStage.count.mockResolvedValue(7);
    prisma.pipeline.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ createdAt: new Date('2026-05-01T00:00:00Z') });

    const app = makeApp();
    const res = await request(app)
      .get('/api/pipelines/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.avgStagesPerPipeline).toBe(2.33);
  });

  test('avgStagesPerPipeline = null when totalPipelines = 0 even if stages > 0', async () => {
    // Orphaned stages w/ zero pipelines (edge case: pre-seed or post-delete).
    prisma.pipeline.count.mockResolvedValue(0);
    prisma.pipelineStage.count.mockResolvedValue(5);
    prisma.pipeline.findFirst.mockResolvedValue(null);

    const app = makeApp();
    const res = await request(app)
      .get('/api/pipelines/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalPipelines).toBe(0);
    expect(res.body.totalStages).toBe(5);
    expect(res.body.avgStagesPerPipeline).toBeNull();
  });

  test('defaultPipelineId = id when a pipeline is the tenant default', async () => {
    prisma.pipeline.count.mockResolvedValue(2);
    prisma.pipelineStage.count.mockResolvedValue(4);
    prisma.pipeline.findFirst
      .mockResolvedValueOnce({ id: 42 })
      .mockResolvedValueOnce({ createdAt: new Date('2026-05-01T00:00:00Z') });

    const app = makeApp();
    const res = await request(app)
      .get('/api/pipelines/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.defaultPipelineId).toBe(42);
  });

  test('defaultPipelineId = null when no pipeline is the default', async () => {
    prisma.pipeline.count.mockResolvedValue(2);
    prisma.pipelineStage.count.mockResolvedValue(4);
    prisma.pipeline.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ createdAt: new Date('2026-05-01T00:00:00Z') });

    const app = makeApp();
    const res = await request(app)
      .get('/api/pipelines/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.defaultPipelineId).toBeNull();
  });

  test('lastCreatedAt = max Pipeline.createdAt as ISO string', async () => {
    const newest = new Date('2026-05-26T12:34:56.789Z');
    prisma.pipeline.count.mockResolvedValue(3);
    prisma.pipelineStage.count.mockResolvedValue(9);
    prisma.pipeline.findFirst
      .mockResolvedValueOnce({ id: 1 })
      .mockResolvedValueOnce({ createdAt: newest });

    const app = makeApp();
    const res = await request(app)
      .get('/api/pipelines/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastCreatedAt).toBe(newest.toISOString());
    // And the latest-lookup query uses orderBy createdAt desc.
    const lastCall = prisma.pipeline.findFirst.mock.calls[1][0];
    expect(lastCall.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('tenant isolation: where.tenantId comes from req.user.tenantId', async () => {
    prisma.pipeline.count.mockResolvedValue(0);
    prisma.pipelineStage.count.mockResolvedValue(0);
    prisma.pipeline.findFirst.mockResolvedValue(null);

    const app = makeApp();
    const res = await request(app)
      .get('/api/pipelines/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    const pipelineWhere = prisma.pipeline.count.mock.calls[0][0].where;
    const stageWhere = prisma.pipelineStage.count.mock.calls[0][0].where;
    expect(pipelineWhere.tenantId).toBe(42);
    expect(stageWhere.tenantId).toBe(42);
  });

  test('?from/?to narrows Pipeline.createdAt; PipelineStage count stays unbounded', async () => {
    prisma.pipeline.count.mockResolvedValue(0);
    prisma.pipelineStage.count.mockResolvedValue(0);
    prisma.pipeline.findFirst.mockResolvedValue(null);

    const fromIso = '2026-05-01T00:00:00.000Z';
    const toIso = '2026-05-31T23:59:59.999Z';
    const app = makeApp();
    const res = await request(app)
      .get(`/api/pipelines/stats?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const pipelineWhere = prisma.pipeline.count.mock.calls[0][0].where;
    expect(pipelineWhere.createdAt.gte).toEqual(new Date(fromIso));
    expect(pipelineWhere.createdAt.lte).toEqual(new Date(toIso));
    // Stages query has NO createdAt narrowing — stages are tenant-shared.
    const stageWhere = prisma.pipelineStage.count.mock.calls[0][0].where;
    expect(stageWhere.createdAt).toBeUndefined();
  });

  test('NO audit row written (read-only meta surface)', async () => {
    prisma.pipeline.count.mockResolvedValue(1);
    prisma.pipelineStage.count.mockResolvedValue(3);
    prisma.pipeline.findFirst
      .mockResolvedValueOnce({ id: 1 })
      .mockResolvedValueOnce({ createdAt: new Date('2026-05-01T00:00:00Z') });

    const app = makeApp();
    const res = await request(app)
      .get('/api/pipelines/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('non-ADMIN USER role can read /stats (mirrors GET / list auth gate)', async () => {
    // GET / list is `verifyToken` only (no role gate) — /stats mirrors that.
    prisma.pipeline.count.mockResolvedValue(2);
    prisma.pipelineStage.count.mockResolvedValue(4);
    prisma.pipeline.findFirst
      .mockResolvedValueOnce({ id: 9 })
      .mockResolvedValueOnce({ createdAt: new Date('2026-05-01T00:00:00Z') });

    const app = makeApp();
    const res = await request(app)
      .get('/api/pipelines/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalPipelines).toBe(2);
  });
});
