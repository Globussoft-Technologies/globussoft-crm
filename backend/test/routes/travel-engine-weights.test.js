// @ts-check
/**
 * backend/routes/travel_engine_weights.js — EngineWeights CRUD contract pin.
 *
 * PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE §10 row T15 (depends on T1 schema
 * shipped tick e43788e1). The EngineWeights model is a single-row-per-tenant
 * config table holding the 6 §3.3.3 weight knobs + scoresWellThreshold +
 * version label. The version is captured on every TravelDiagnostic at
 * scoring time so §3.3.7 weight-tuning disagreement triage can replay any
 * past submission's exact weights.
 *
 * What's pinned
 * -------------
 *   - GET   /api/travel/engine-weights
 *       happy path with persisted row (returned verbatim)
 *       no-row-yet -> PRD §3.3.3 defaults + `isDefault: true`
 *       cross-tenant isolation (tenant B caller scopes WHERE to tenant B)
 *       USER role -> 403 RBAC_DENIED
 *       missing Authorization -> 401
 *
 *   - PUT   /api/travel/engine-weights
 *       happy path first-time creates row via upsert (calls .upsert with
 *         create=update=data shape; @@unique([tenantId]) prevents race
 *         duplicates).
 *       auto-version-bump (v1 -> v2 when weights changed AND version omitted)
 *       caller-supplied NEW version honored verbatim (no auto-bump)
 *       idempotent re-PUT (same weights + same version -> returns existing
 *         row unchanged; upsert NOT called)
 *       validation: negative weight -> 400 INVALID_WEIGHT
 *       validation: threshold > 100 -> 400 INVALID_THRESHOLD
 *       validation: threshold < 0 -> 400 INVALID_THRESHOLD
 *       validation: missing required field -> 400 MISSING_FIELDS
 *       validation: empty body -> 400 MISSING_FIELDS
 *       validation: empty-string version -> 400 INVALID_VERSION
 *       USER role -> 403 RBAC_DENIED
 *       cross-tenant scope — caller's tenantId, not body's, lands in WHERE
 *         (stripDangerous middleware drops body.tenantId in production; the
 *         handler never reads body.tenantId regardless)
 *
 * Pinned auth chain (all routes):
 *   verifyToken -> requirePermission("diagnostics", "read"|"update") -> handler
 *
 * Failure-path codes pinned by the route source:
 *   400 MISSING_FIELDS    — any of 6 weights or threshold absent
 *   400 INVALID_WEIGHT    — weight not an integer >= 0
 *   400 INVALID_THRESHOLD — scoresWellThreshold not an integer in [0, 100]
 *   400 INVALID_VERSION   — version provided but not a non-empty string
 *   401                   — verifyToken (missing Authorization)
 *   403 RBAC_DENIED       — requirePermission gate
 *
 * Test pattern mirrors backend/test/routes/travel-tmc-catalogue.test.js (T5)
 * + backend/test/routes/travel_curriculum.test.js — patch the prisma
 * singleton with vi.fn() shapes BEFORE requiring the router so the router's
 * CJS require binds to the spies; mint JWTs with the same dev fallback
 * secret the middleware uses; full guard chain (verifyToken + requirePermission)
 * runs end-to-end — no middleware bypass.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.engineWeights = {
  findFirst: vi.fn(),
  upsert: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const weightsRouter = requireCJS('../../routes/travel_engine_weights');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/engine-weights', weightsRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// PRD §3.3.3 defaults — kept here so the test pins the contract literally,
// not via re-import (test-author intent is "this is what the PRD says";
// re-importing the route's constant would make the test pass whatever
// the route ships, defeating the contract pin).
const PRD_DEFAULTS = {
  version: 'v1',
  weightPrimaryOutcome: 50,
  weightSecondarySkill: 20,
  weightGrowthArea: 15,
  weightCurriculumHook: 10,
  weightGradeBandCenter: 10,
  weightTierValueLean: 8,
  scoresWellThreshold: 70,
};

function validPutBody(overrides = {}) {
  // Spread defaults sans version (caller may add/omit). PUT happy paths
  // typically omit `version` to exercise the auto-bump path; tests that
  // want to assert verbatim-version-honor add `version` in overrides.
  const { version, ...rest } = PRD_DEFAULTS;
  void version;
  return { ...rest, ...overrides };
}

beforeEach(() => {
  prisma.engineWeights.findFirst.mockReset();
  prisma.engineWeights.upsert.mockReset();
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/travel/engine-weights
// ─────────────────────────────────────────────────────────────────────

describe('GET /api/travel/engine-weights', () => {
  test('happy path — persisted row returned verbatim, tenant-scoped', async () => {
    const row = {
      id: 1,
      tenantId: 1,
      version: 'v3',
      weightPrimaryOutcome: 55,
      weightSecondarySkill: 18,
      weightGrowthArea: 15,
      weightCurriculumHook: 10,
      weightGradeBandCenter: 10,
      weightTierValueLean: 7,
      scoresWellThreshold: 72,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prisma.engineWeights.findFirst.mockResolvedValue(row);

    const res = await request(makeApp())
      .get('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 'v3',
      weightPrimaryOutcome: 55,
      weightSecondarySkill: 18,
      weightTierValueLean: 7,
      scoresWellThreshold: 72,
    });
    // No `isDefault` flag on persisted rows.
    expect(res.body).not.toHaveProperty('isDefault');
    // Tenant scoping pinned.
    expect(prisma.engineWeights.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 1 },
    });
  });

  test('no row yet — returns PRD §3.3.3 defaults + isDefault: true', async () => {
    prisma.engineWeights.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 'v1',
      weightPrimaryOutcome: 50,
      weightSecondarySkill: 20,
      weightGrowthArea: 15,
      weightCurriculumHook: 10,
      weightGradeBandCenter: 10,
      weightTierValueLean: 8,
      scoresWellThreshold: 70,
      isDefault: true,
    });
  });

  test('cross-tenant isolation — tenant 2 caller scopes WHERE to tenant 2', async () => {
    prisma.engineWeights.findFirst.mockResolvedValue(null);

    await request(makeApp())
      .get('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 2 })}`);

    expect(prisma.engineWeights.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 2 },
    });
  });

  test('MANAGER role allowed (200)', async () => {
    prisma.engineWeights.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(200);
  });

  test('USER role denied with 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .get('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.engineWeights.findFirst).not.toHaveBeenCalled();
  });

  test('missing Authorization returns 401', async () => {
    const res = await request(makeApp()).get('/api/travel/engine-weights');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
// PUT /api/travel/engine-weights — upsert + auto-bump
// ─────────────────────────────────────────────────────────────────────

describe('PUT /api/travel/engine-weights', () => {
  test('happy path first-time create — upsert called with caller body + version "v1"', async () => {
    prisma.engineWeights.findFirst.mockResolvedValue(null);
    prisma.engineWeights.upsert.mockImplementation(async ({ create }) => ({
      id: 1, ...create, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send(validPutBody());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantId: 1,
      version: 'v1',
      weightPrimaryOutcome: 50,
      weightSecondarySkill: 20,
      scoresWellThreshold: 70,
    });

    const upsertCall = prisma.engineWeights.upsert.mock.calls[0][0];
    expect(upsertCall.where).toEqual({ tenantId: 1 });
    // Create + update payloads identical (single canonical row).
    expect(upsertCall.create).toEqual(upsertCall.update);
    expect(upsertCall.create).toMatchObject({
      tenantId: 1,
      version: 'v1',
      weightPrimaryOutcome: 50,
    });
  });

  test('auto-version-bump — weights changed AND version omitted -> vN -> v(N+1)', async () => {
    prisma.engineWeights.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      version: 'v3',
      weightPrimaryOutcome: 50,
      weightSecondarySkill: 20,
      weightGrowthArea: 15,
      weightCurriculumHook: 10,
      weightGradeBandCenter: 10,
      weightTierValueLean: 8,
      scoresWellThreshold: 70,
    });
    prisma.engineWeights.upsert.mockImplementation(async ({ create }) => ({
      id: 1, ...create, createdAt: new Date(), updatedAt: new Date(),
    }));

    // Caller bumps weightPrimaryOutcome 50 -> 55 and omits version.
    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send(validPutBody({ weightPrimaryOutcome: 55 }));

    expect(res.status).toBe(200);
    expect(res.body.version).toBe('v4'); // v3 -> v4
    expect(res.body.weightPrimaryOutcome).toBe(55);

    const persisted = prisma.engineWeights.upsert.mock.calls[0][0].create;
    expect(persisted.version).toBe('v4');
  });

  test('explicit NEW version string honored verbatim (no auto-bump)', async () => {
    prisma.engineWeights.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      version: 'v2',
      ...validPutBody(),
    });
    prisma.engineWeights.upsert.mockImplementation(async ({ create }) => ({
      id: 1, ...create, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send(validPutBody({
        weightPrimaryOutcome: 60,
        version: 'pilot-2026-yasin',
      }));

    expect(res.status).toBe(200);
    expect(res.body.version).toBe('pilot-2026-yasin');

    const persisted = prisma.engineWeights.upsert.mock.calls[0][0].create;
    expect(persisted.version).toBe('pilot-2026-yasin');
  });

  test('idempotent re-PUT — same weights + same version -> existing row returned untouched, upsert NOT called', async () => {
    const existing = {
      id: 1,
      tenantId: 1,
      version: 'v3',
      weightPrimaryOutcome: 50,
      weightSecondarySkill: 20,
      weightGrowthArea: 15,
      weightCurriculumHook: 10,
      weightGradeBandCenter: 10,
      weightTierValueLean: 8,
      scoresWellThreshold: 70,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    };
    prisma.engineWeights.findFirst.mockResolvedValue(existing);

    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send(validPutBody({ version: 'v3' }));

    expect(res.status).toBe(200);
    expect(res.body.version).toBe('v3');
    expect(res.body.weightPrimaryOutcome).toBe(50);
    // True idempotent: NO write at all.
    expect(prisma.engineWeights.upsert).not.toHaveBeenCalled();
  });

  test('idempotent re-PUT with version OMITTED — same weights -> existing row untouched, upsert NOT called', async () => {
    // Mirrors the UI flow: operator opens the panel, hits Save without
    // changing anything. Frontend sends current weights without bumping
    // version. Backend must not rewrite the row.
    prisma.engineWeights.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      version: 'v5',
      ...validPutBody(),
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    });

    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send(validPutBody());

    expect(res.status).toBe(200);
    expect(res.body.version).toBe('v5');
    expect(prisma.engineWeights.upsert).not.toHaveBeenCalled();
  });

  test('validation — negative weight -> 400 INVALID_WEIGHT', async () => {
    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validPutBody({ weightPrimaryOutcome: -5 }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_WEIGHT' });
    expect(prisma.engineWeights.upsert).not.toHaveBeenCalled();
  });

  test('validation — non-integer weight -> 400 INVALID_WEIGHT', async () => {
    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validPutBody({ weightSecondarySkill: 20.5 }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_WEIGHT' });
  });

  test('validation — threshold > 100 -> 400 INVALID_THRESHOLD', async () => {
    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validPutBody({ scoresWellThreshold: 150 }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_THRESHOLD' });
  });

  test('validation — threshold < 0 -> 400 INVALID_THRESHOLD', async () => {
    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validPutBody({ scoresWellThreshold: -1 }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_THRESHOLD' });
  });

  test('validation — missing weight field -> 400 MISSING_FIELDS', async () => {
    const body = validPutBody();
    delete body.weightGrowthArea;

    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });

  test('validation — missing threshold -> 400 MISSING_FIELDS', async () => {
    const body = validPutBody();
    delete body.scoresWellThreshold;

    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });

  test('validation — empty body -> 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });

  test('validation — empty-string version -> 400 INVALID_VERSION', async () => {
    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validPutBody({ version: '   ' }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_VERSION' });
  });

  test('USER role denied with 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(validPutBody());

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.engineWeights.upsert).not.toHaveBeenCalled();
  });

  test('cross-tenant scope — caller tenantId lands in upsert WHERE, not body', async () => {
    prisma.engineWeights.findFirst.mockResolvedValue(null);
    prisma.engineWeights.upsert.mockImplementation(async ({ create }) => ({
      id: 1, ...create, createdAt: new Date(), updatedAt: new Date(),
    }));

    // Caller is tenant 5; the body has no tenantId surface to leak — the
    // handler reads tenantId from req.user only. We pin the WHERE clause.
    await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 5 })}`)
      .send(validPutBody());

    const findCall = prisma.engineWeights.findFirst.mock.calls[0][0];
    expect(findCall.where).toEqual({ tenantId: 5 });

    const upsertCall = prisma.engineWeights.upsert.mock.calls[0][0];
    expect(upsertCall.where).toEqual({ tenantId: 5 });
    expect(upsertCall.create.tenantId).toBe(5);
  });

  test('MANAGER role allowed (200) on PUT', async () => {
    prisma.engineWeights.findFirst.mockResolvedValue(null);
    prisma.engineWeights.upsert.mockImplementation(async ({ create }) => ({
      id: 1, ...create, createdAt: new Date(), updatedAt: new Date(),
    }));
    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send(validPutBody());
    expect(res.status).toBe(200);
  });

  test('missing Authorization returns 401', async () => {
    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .send(validPutBody());
    expect(res.status).toBe(401);
  });

  test('auto-bump fallback — non-vN version -> "<prev>-revised"', async () => {
    // Some operator manually labelled the row "pilot-q1". Weights change,
    // version omitted -> bump to "pilot-q1-revised".
    prisma.engineWeights.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      version: 'pilot-q1',
      ...validPutBody(),
    });
    prisma.engineWeights.upsert.mockImplementation(async ({ create }) => ({
      id: 1, ...create, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send(validPutBody({ weightTierValueLean: 12 }));

    expect(res.status).toBe(200);
    expect(res.body.version).toBe('pilot-q1-revised');
  });

  test('threshold change alone triggers auto-bump (threshold counts as a "weight" for bump purposes)', async () => {
    prisma.engineWeights.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      version: 'v7',
      ...validPutBody(),
    });
    prisma.engineWeights.upsert.mockImplementation(async ({ create }) => ({
      id: 1, ...create, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .put('/api/travel/engine-weights')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send(validPutBody({ scoresWellThreshold: 75 }));

    expect(res.status).toBe(200);
    expect(res.body.version).toBe('v8');
    expect(res.body.scoresWellThreshold).toBe(75);
  });
});
