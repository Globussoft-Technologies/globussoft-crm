// @ts-check
/**
 * backend/routes/travel_tmc_catalogue.js — TmcTripCatalogue CRUD contract pin.
 *
 * PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE §10 row T5 (depends on T1 schema
 * shipped tick e43788e1). The TmcTripCatalogue model holds the curated
 * trip-database rows the diagnostic engine recommends from. PRD §3.2 says
 * every row's curriculum_hooks + price_band must be human-verified before it
 * goes "active" — the route enforces this structurally: POST always lands
 * status="archived" regardless of body input, and ONLY the senior-role-gated
 * POST /:id/promote-to-active path flips it to "active".
 *
 * What's pinned
 * -------------
 *   - GET   /api/travel-tmc-catalogue                        ?status=active|archived|all
 *                                                            (default "active"; invalid → 400)
 *                                                            tenant-scoped; ADMIN+MANAGER gate
 *   - GET   /api/travel-tmc-catalogue/:id                    INVALID_ID / CATALOGUE_NOT_FOUND
 *                                                            (cross-tenant returns 404, not 403)
 *   - POST  /api/travel-tmc-catalogue                        MISSING_FIELDS / INVALID_DURATION /
 *                                                            INVALID_GROUP_SIZE / INVALID_PRICE /
 *                                                            INVALID_JSON_FIELD / CATALOGUE_DUPLICATE.
 *                                                            **Body status is IGNORED — created row
 *                                                            ALWAYS has status="archived"** (the
 *                                                            human-verify gate per PRD §3.2).
 *   - PATCH /api/travel-tmc-catalogue/:id                    EMPTY_BODY / STATUS_NOT_PATCHABLE.
 *                                                            Partial update; status cannot be
 *                                                            changed (must use promote endpoint or
 *                                                            DELETE).
 *   - DELETE /api/travel-tmc-catalogue/:id                   Soft archive (status→archived).
 *                                                            Row remains queryable for audit.
 *   - POST  /api/travel-tmc-catalogue/:id/promote-to-active  Flips status→active. ADMIN-only
 *                                                            (MANAGER → 403 RBAC_DENIED). Cross-
 *                                                            tenant → 404. PRD §3.2 senior-role
 *                                                            language.
 *
 * Pinned auth chain (all routes):
 *   verifyToken → requirePermission('tmc_catalogue', read/write/update/delete) → handler  (5 of 6 endpoints)
 *   verifyToken → requirePermission('tmc_catalogue', 'manage')                  → handler  (promote-to-active only)
 *
 * Failure-path codes pinned by the route source as of this commit:
 *   400 INVALID_ID / INVALID_STATUS / MISSING_FIELDS / INVALID_DURATION /
 *       INVALID_GROUP_SIZE / INVALID_PRICE / INVALID_JSON_FIELD / EMPTY_BODY /
 *       STATUS_NOT_PATCHABLE
 *   401 — verifyToken (missing/invalid Authorization)
 *   403 RBAC_DENIED — RBAC gate
 *   404 CATALOGUE_NOT_FOUND — id absent or cross-tenant
 *   409 CATALOGUE_DUPLICATE — @@unique([tenantId, tripId]) violation
 *
 * Test pattern mirrors backend/test/routes/travel_curriculum.test.js (tick
 * #180, the sibling tenant-wide-ADMIN catalogue-style route): patch the
 * prisma singleton with vi.fn() shapes BEFORE requiring the router so the
 * router's CJS require binds to the spies; mint JWTs with the same dev
 * fallback secret the middleware uses; full guard chain (verifyToken +
 * requirePermission) runs end-to-end — no middleware bypass.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.tmcTripCatalogue = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const catalogueRouter = requireCJS('../../routes/travel_tmc_catalogue');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel-tmc-catalogue', catalogueRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// A minimal-valid POST body for the catalogue. Matches the schema's NOT NULL
// columns. Tests that exercise create-with-overrides spread on top of this.
function validCreateBody(overrides = {}) {
  return {
    tripId: 'golden-triangle-delhi-agra-jaipur',
    title: 'Golden Triangle Trail',
    tagline: 'Three cities, one civilisational thread',
    tier: 'domestic',
    region: 'North India',
    durationDays: 6,
    durationNights: 5,
    minGradeBand: '6-8',
    maxGradeBand: '11-12',
    boardsSupportedJson: ['CBSE', 'ICSE', 'IB'],
    minGroupSize: 25,
    priceBand: '30k-75k',
    indicativePricePerStudent: 55000,
    primaryOutcomesJson: ['cultural-immersion', 'history-deep-dive'],
    skillsDevelopedJson: ['Cultural respect and inclusion', 'Lifelong learning and curiosity'],
    subjectsTouchedJson: ['History', 'Geography', 'Art'],
    anchorExperiencesJson: [
      { name: 'Taj Mahal sunrise', what_students_do: 'Architectural sketching workshop', skill_link: 'Cultural respect and inclusion', subject_link: 'History' },
      { name: 'Amber Fort climb', what_students_do: 'Geology field journal', skill_link: 'Collaboration and teamwork', subject_link: 'Geography' },
      { name: 'Delhi street-food guided walk', what_students_do: 'Culinary geography interviews', skill_link: 'Empathy', subject_link: 'Geography' },
    ],
    curriculumHooksJson: [
      { board: 'CBSE', grade_band: '9-10', subject: 'History', topic: 'Medieval India', hook_text: 'Direct Mughal-era touchpoints' },
    ],
    reportSkillBlurb: 'Students grow in cross-cultural fluency and historical reasoning by reading three cities as a single civilisational text.',
    summaryForBrief: 'Delhi-Agra-Jaipur circuit anchored by Taj sunrise + Amber Fort + Old Delhi food walk; pairs cleanly with Classes 7-10 CBSE history syllabus.',
    imageUrl: null,
    ...overrides,
  };
}

beforeEach(() => {
  prisma.tmcTripCatalogue.findMany.mockReset();
  prisma.tmcTripCatalogue.findFirst.mockReset();
  prisma.tmcTripCatalogue.count.mockReset();
  prisma.tmcTripCatalogue.create.mockReset();
  prisma.tmcTripCatalogue.update.mockReset();
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/travel-tmc-catalogue
// ─────────────────────────────────────────────────────────────────────

describe('GET /api/travel-tmc-catalogue', () => {
  test('happy path — returns active rows tenant-scoped (default ?status=active)', async () => {
    const rows = [
      { id: 1, tenantId: 1, tripId: 'golden-triangle', tier: 'domestic', status: 'active' },
      { id: 2, tenantId: 1, tripId: 'eagles-unbound-junior', tier: 'day', status: 'active' },
    ];
    prisma.tmcTripCatalogue.findMany.mockResolvedValue(rows);
    prisma.tmcTripCatalogue.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      catalogue: expect.any(Array),
      total: 2,
      limit: 100,
      offset: 0,
    });
    expect(res.body.catalogue).toHaveLength(2);

    // Tenant scoping pinned + default status filter is "active".
    expect(prisma.tmcTripCatalogue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1, status: 'active' },
      }),
    );
  });

  test('cross-tenant isolation — tenant 2 caller cannot see tenant 1 rows', async () => {
    prisma.tmcTripCatalogue.findMany.mockResolvedValue([]);
    prisma.tmcTripCatalogue.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 2 })}`);

    // The WHERE clause must scope to tenantId=2, NOT 1.
    expect(prisma.tmcTripCatalogue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 2, status: 'active' },
      }),
    );
  });

  test('?status=archived returns only archived rows', async () => {
    prisma.tmcTripCatalogue.findMany.mockResolvedValue([
      { id: 3, tenantId: 1, tripId: 'unverified-trip', status: 'archived' },
    ]);
    prisma.tmcTripCatalogue.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel-tmc-catalogue?status=archived')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.catalogue[0].status).toBe('archived');
    expect(prisma.tmcTripCatalogue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1, status: 'archived' },
      }),
    );
  });

  test('?status=all returns both active + archived (no status filter)', async () => {
    prisma.tmcTripCatalogue.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, tripId: 'a', status: 'active' },
      { id: 2, tenantId: 1, tripId: 'b', status: 'archived' },
    ]);
    prisma.tmcTripCatalogue.count.mockResolvedValue(2);

    await request(makeApp())
      .get('/api/travel-tmc-catalogue?status=all')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    // Critical: the WHERE clause must NOT contain `status` when ?status=all.
    const calledWhere = prisma.tmcTripCatalogue.findMany.mock.calls[0][0].where;
    expect(calledWhere).toEqual({ tenantId: 1 });
    expect(calledWhere).not.toHaveProperty('status');
  });

  test('?status=invalidValue returns 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel-tmc-catalogue?status=draft')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.tmcTripCatalogue.findMany).not.toHaveBeenCalled();
  });

  test('USER role denied with 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .get('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.tmcTripCatalogue.findMany).not.toHaveBeenCalled();
  });

  test('missing Authorization header returns 401', async () => {
    const res = await request(makeApp())
      .get('/api/travel-tmc-catalogue');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/travel-tmc-catalogue/:id
// ─────────────────────────────────────────────────────────────────────

describe('GET /api/travel-tmc-catalogue/:id', () => {
  test('happy path returns single row', async () => {
    prisma.tmcTripCatalogue.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, tripId: 'golden-triangle', status: 'active', title: 'Golden Triangle',
    });
    const res = await request(makeApp())
      .get('/api/travel-tmc-catalogue/42')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 42, tripId: 'golden-triangle' });
    expect(prisma.tmcTripCatalogue.findFirst).toHaveBeenCalledWith({
      where: { id: 42, tenantId: 1 },
    });
  });

  test('cross-tenant fetch returns 404 CATALOGUE_NOT_FOUND (not 403)', async () => {
    // Tenant-1 caller asks for an id owned by tenant 2 — findFirst's WHERE
    // scope filters it out and returns null.
    prisma.tmcTripCatalogue.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel-tmc-catalogue/42')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CATALOGUE_NOT_FOUND' });
  });

  test('missing id returns 404 CATALOGUE_NOT_FOUND', async () => {
    prisma.tmcTripCatalogue.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel-tmc-catalogue/999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CATALOGUE_NOT_FOUND' });
  });

  test('non-numeric id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel-tmc-catalogue/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/travel-tmc-catalogue — the human-verify gate test bed
// ─────────────────────────────────────────────────────────────────────

describe('POST /api/travel-tmc-catalogue', () => {
  test('happy path returns 201 — body status is IGNORED and row lands status="archived"', async () => {
    prisma.tmcTripCatalogue.create.mockImplementation(async ({ data }) => ({
      id: 100, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    // Caller deliberately attempts to set status="active" — the route MUST
    // ignore this and force "archived" (the PRD §3.2 human-verify gate).
    const body = validCreateBody({ status: 'active' });

    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { userId: 7, tenantId: 1 })}`)
      .send(body);

    expect(res.status).toBe(201);
    // Critical assertion: the persisted row's status is "archived" regardless
    // of the caller's body.
    expect(res.body.status).toBe('archived');

    const createCall = prisma.tmcTripCatalogue.create.mock.calls[0][0];
    expect(createCall.data.status).toBe('archived');
    expect(createCall.data.tenantId).toBe(1);
    expect(createCall.data.tripId).toBe('golden-triangle-delhi-agra-jaipur');
  });

  test('JSON-array fields are stringified before storage', async () => {
    prisma.tmcTripCatalogue.create.mockImplementation(async ({ data }) => ({ id: 101, ...data }));

    await request(makeApp())
      .post('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validCreateBody());

    const createCall = prisma.tmcTripCatalogue.create.mock.calls[0][0];
    // Every *Json field should be a JSON string, not a JS array.
    expect(typeof createCall.data.boardsSupportedJson).toBe('string');
    expect(JSON.parse(createCall.data.boardsSupportedJson)).toEqual(['CBSE', 'ICSE', 'IB']);
    expect(typeof createCall.data.primaryOutcomesJson).toBe('string');
    expect(typeof createCall.data.anchorExperiencesJson).toBe('string');
    expect(JSON.parse(createCall.data.anchorExperiencesJson)).toHaveLength(3);
  });

  test('missing required field (no tripId) returns 400 MISSING_FIELDS', async () => {
    const body = validCreateBody();
    delete body.tripId;
    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.tmcTripCatalogue.create).not.toHaveBeenCalled();
  });

  test('missing required JSON field (anchorExperiencesJson) returns 400 MISSING_FIELDS', async () => {
    const body = validCreateBody();
    delete body.anchorExperiencesJson;
    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });

  test('invalid durationDays (negative) returns 400 INVALID_DURATION', async () => {
    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validCreateBody({ durationDays: -1 }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DURATION' });
    expect(prisma.tmcTripCatalogue.create).not.toHaveBeenCalled();
  });

  test('invalid minGroupSize (zero) returns 400 INVALID_GROUP_SIZE', async () => {
    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validCreateBody({ minGroupSize: 0 }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_GROUP_SIZE' });
  });

  test('non-array non-string JSON field returns 400 INVALID_JSON_FIELD', async () => {
    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validCreateBody({ boardsSupportedJson: 42 }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_JSON_FIELD' });
  });

  test('duplicate tripId (Prisma P2002) returns 409 CATALOGUE_DUPLICATE', async () => {
    const p2002 = new Error(
      'Unique constraint failed on the fields: (`tenantId`,`tripId`)',
    );
    // @ts-expect-error — synthesising a Prisma error shape
    p2002.code = 'P2002';
    prisma.tmcTripCatalogue.create.mockRejectedValue(p2002);
    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validCreateBody());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'CATALOGUE_DUPLICATE' });
  });

  test('MANAGER role can create (catalogue prep is MANAGER-allowed)', async () => {
    prisma.tmcTripCatalogue.create.mockImplementation(async ({ data }) => ({ id: 102, ...data }));
    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send(validCreateBody());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('archived');
  });

  test('USER role denied with 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(validCreateBody());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.tmcTripCatalogue.create).not.toHaveBeenCalled();
  });

  test('pre-stringified JSON string passes through unchanged', async () => {
    prisma.tmcTripCatalogue.create.mockImplementation(async ({ data }) => ({ id: 103, ...data }));
    const preStringified = JSON.stringify(['CBSE']);

    await request(makeApp())
      .post('/api/travel-tmc-catalogue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validCreateBody({ boardsSupportedJson: preStringified }));

    const createCall = prisma.tmcTripCatalogue.create.mock.calls[0][0];
    // A pre-stringified payload is stored verbatim — no double-encoding.
    expect(createCall.data.boardsSupportedJson).toBe(preStringified);
  });
});

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/travel-tmc-catalogue/:id
// ─────────────────────────────────────────────────────────────────────

describe('PATCH /api/travel-tmc-catalogue/:id', () => {
  test('happy path updates allowed fields', async () => {
    prisma.tmcTripCatalogue.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, tripId: 'golden-triangle', tier: 'domestic', status: 'archived',
    });
    prisma.tmcTripCatalogue.update.mockImplementation(async ({ data }) => ({
      id: 5, tenantId: 1, tripId: 'golden-triangle', tier: 'domestic', status: 'archived', ...data,
    }));

    const res = await request(makeApp())
      .patch('/api/travel-tmc-catalogue/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ title: 'Golden Triangle — Revised', durationDays: 7 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, title: 'Golden Triangle — Revised', durationDays: 7 });

    const updateCall = prisma.tmcTripCatalogue.update.mock.calls[0][0];
    expect(updateCall.data).toMatchObject({ title: 'Golden Triangle — Revised', durationDays: 7 });
    expect(updateCall.data).not.toHaveProperty('status');
  });

  test('attempting to change status via PATCH returns 400 STATUS_NOT_PATCHABLE', async () => {
    prisma.tmcTripCatalogue.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, tripId: 'golden-triangle', status: 'archived',
    });

    const res = await request(makeApp())
      .patch('/api/travel-tmc-catalogue/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'active', title: 'Trying to slip status in' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'STATUS_NOT_PATCHABLE' });
    expect(prisma.tmcTripCatalogue.update).not.toHaveBeenCalled();
  });

  test('empty body returns 400 EMPTY_BODY', async () => {
    prisma.tmcTripCatalogue.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, tripId: 'golden-triangle', status: 'archived',
    });
    const res = await request(makeApp())
      .patch('/api/travel-tmc-catalogue/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
  });

  test('cross-tenant PATCH returns 404 CATALOGUE_NOT_FOUND', async () => {
    prisma.tmcTripCatalogue.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel-tmc-catalogue/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 2 })}`)
      .send({ title: 'New title' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CATALOGUE_NOT_FOUND' });
  });

  test('PATCH with invalid JSON field returns 400 INVALID_JSON_FIELD', async () => {
    prisma.tmcTripCatalogue.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, tripId: 'x', status: 'archived',
    });
    const res = await request(makeApp())
      .patch('/api/travel-tmc-catalogue/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ boardsSupportedJson: 42 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_JSON_FIELD' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/travel-tmc-catalogue/:id — soft archive
// ─────────────────────────────────────────────────────────────────────

describe('DELETE /api/travel-tmc-catalogue/:id (soft archive)', () => {
  test('flips status to "archived"; row still queryable', async () => {
    prisma.tmcTripCatalogue.findFirst.mockResolvedValue({
      id: 9, tenantId: 1, tripId: 'old-trip', status: 'active',
    });
    prisma.tmcTripCatalogue.update.mockResolvedValue({
      id: 9, tenantId: 1, tripId: 'old-trip', status: 'archived',
    });

    const res = await request(makeApp())
      .delete('/api/travel-tmc-catalogue/9')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 9, status: 'archived' });

    // Soft-delete shape — prisma.update called with status: archived only.
    expect(prisma.tmcTripCatalogue.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { status: 'archived' },
    });
  });

  test('cross-tenant DELETE returns 404', async () => {
    prisma.tmcTripCatalogue.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel-tmc-catalogue/9')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 2 })}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CATALOGUE_NOT_FOUND' });
    expect(prisma.tmcTripCatalogue.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/travel-tmc-catalogue/:id/promote-to-active — human-verify gate
// ─────────────────────────────────────────────────────────────────────

describe('POST /api/travel-tmc-catalogue/:id/promote-to-active', () => {
  test('ADMIN promotes archived row → active', async () => {
    prisma.tmcTripCatalogue.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, tripId: 'newly-verified', status: 'archived',
    });
    prisma.tmcTripCatalogue.update.mockResolvedValue({
      id: 11, tenantId: 1, tripId: 'newly-verified', status: 'active',
    });

    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue/11/promote-to-active')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 11, status: 'active' });
    expect(prisma.tmcTripCatalogue.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { status: 'active' },
    });
  });

  test('MANAGER cannot promote — returns 403 RBAC_DENIED', async () => {
    // The senior-role gate per PRD §3.2 — only ADMIN may flip into the
    // engine's recommendation pool. MANAGER is allowed to prepare rows
    // (POST/PATCH/DELETE) but not promote.
    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue/11/promote-to-active')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.tmcTripCatalogue.findFirst).not.toHaveBeenCalled();
    expect(prisma.tmcTripCatalogue.update).not.toHaveBeenCalled();
  });

  test('USER cannot promote — returns 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue/11/promote-to-active')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
  });

  test('cross-tenant promote returns 404 CATALOGUE_NOT_FOUND', async () => {
    prisma.tmcTripCatalogue.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue/11/promote-to-active')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 2 })}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CATALOGUE_NOT_FOUND' });
    expect(prisma.tmcTripCatalogue.update).not.toHaveBeenCalled();
  });

  test('non-numeric :id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel-tmc-catalogue/abc/promote-to-active')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });
});
