// @ts-check
/**
 * backend/routes/sequences.js — main-route contract tests.
 *
 * Scope
 * ─────
 *   This file pins the MAIN sequence CRUD + enroll + step-CRUD surface
 *   exposed by backend/routes/sequences.js (553 LOC). It complements the
 *   existing sequences-triggers.test.js (slice-specific — only pins the
 *   GET /triggers vertical-aware catalog #616). Together they form the
 *   vitest-level pin for this route.
 *
 * What's pinned here
 * ──────────────────
 *   - GET    /                        list with tenant scope + _count enrollments
 *   - GET    /:id                     n/a — route has no GET-by-id (verified via SUT read)
 *   - POST   /                        create with {name, nodes, edges} envelope;
 *                                     nodes/edges are JSON.stringify'd before write
 *                                     (#646 standing rule: JSON-string columns);
 *                                     isActive defaults FALSE (#374 draft on create);
 *                                     400 on missing/whitespace name (#396);
 *                                     400 on non-array nodes (#395).
 *   - PATCH  /:id                     partial-update (route uses PATCH, not PUT);
 *                                     INVALID_ID guard; cross-tenant 404;
 *                                     400 on empty name; 400 on non-array nodes.
 *   - PATCH  /:id/toggle              isActive flip; cross-tenant 404.
 *   - DELETE /:id                     deleteMany on enrollments BEFORE sequence
 *                                     (cascade requirement); cross-tenant 404;
 *                                     INVALID_ID guard.
 *   - POST   /:id/enroll              creates SequenceEnrollment row;
 *                                     400 missing contactId; 404 sequence/contact
 *                                     not in caller's tenant; 400 dup-enrollment.
 *   - Authentication gate             missing Bearer → 401 on every endpoint.
 *
 * Test pattern (canonical singleton-patch — see backend/test/routes/booking-pages.test.js)
 * ───────────────────────────────────────────────────────────────────────────
 *   - import prisma from lib/prisma → patch model surfaces with vi.fn() shapes
 *     BEFORE the router is required. This works because lib/prisma exports a
 *     singleton and CJS require() resolves to that same object.
 *   - verifyToken middleware stays in the chain (no bypass). HS256 JWTs signed
 *     with the dev-fallback secret drive authenticated requests.
 *   - Mocks reset in beforeEach so cases stay independent.
 *
 * No source changes — this is a pure contract pin.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ─── Prisma singleton patch (must run BEFORE the router is required) ──
prisma.sequence = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.sequenceEnrollment = {
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
};
// S85 — SequenceStep CRUD is pinned via the dedicated /steps describe blocks
// at the bottom. attachmentRefsJson POST/PUT forward is the new contract.
prisma.sequenceStep = {
  findFirst: vi.fn(),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const sequencesRouter = requireCJS('../../routes/sequences');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sequences', sequencesRouter);
  return app;
}

function tokenFor({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: 'admin@test.local' },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.sequence.findMany.mockReset();
  prisma.sequence.findFirst.mockReset();
  prisma.sequence.create.mockReset();
  prisma.sequence.update.mockReset();
  prisma.sequence.delete.mockReset();
  prisma.sequenceEnrollment.findFirst.mockReset();
  prisma.sequenceEnrollment.create.mockReset();
  prisma.sequenceEnrollment.update.mockReset();
  prisma.sequenceEnrollment.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.sequenceStep.findFirst.mockReset();
  prisma.sequenceStep.findMany.mockReset().mockResolvedValue([]);
  prisma.sequenceStep.create.mockReset();
  prisma.sequenceStep.update.mockReset();
  prisma.sequenceStep.delete.mockReset();
  prisma.contact.findFirst.mockReset();
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ─── Authentication gate ──────────────────────────────────────────────

describe('Authentication gate (verifyToken)', () => {
  test('GET / without Bearer → 401', async () => {
    const res = await request(makeApp()).get('/api/sequences');
    expect(res.status).toBe(401);
    expect(prisma.sequence.findMany).not.toHaveBeenCalled();
  });

  test('POST / without Bearer → 401', async () => {
    const res = await request(makeApp())
      .post('/api/sequences')
      .send({ name: 'Drip A', nodes: [], edges: [] });
    expect(res.status).toBe(401);
    expect(prisma.sequence.create).not.toHaveBeenCalled();
  });

  test('PATCH /:id without Bearer → 401', async () => {
    const res = await request(makeApp())
      .patch('/api/sequences/42')
      .send({ name: 'Renamed' });
    expect(res.status).toBe(401);
    expect(prisma.sequence.update).not.toHaveBeenCalled();
  });

  test('DELETE /:id without Bearer → 401', async () => {
    const res = await request(makeApp()).delete('/api/sequences/42');
    expect(res.status).toBe(401);
    expect(prisma.sequence.delete).not.toHaveBeenCalled();
  });

  test('POST /:id/enroll without Bearer → 401', async () => {
    const res = await request(makeApp())
      .post('/api/sequences/42/enroll')
      .send({ contactId: 9 });
    expect(res.status).toBe(401);
    expect(prisma.sequenceEnrollment.create).not.toHaveBeenCalled();
  });
});

// ─── GET / (list with tenant scope) ───────────────────────────────────

describe('GET /api/sequences (list)', () => {
  test('happy path: returns sequences scoped to caller tenant + _count include', async () => {
    prisma.sequence.findMany.mockResolvedValue([
      { id: 1, name: 'Welcome drip', tenantId: 1, _count: { enrollments: 5 } },
      { id: 2, name: 'Re-engagement', tenantId: 1, _count: { enrollments: 0 } },
    ]);
    const res = await request(makeApp())
      .get('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    // Tenant-scoped findMany with _count.enrollments + orderBy.
    const findArgs = prisma.sequence.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 1 });
    expect(findArgs.include).toMatchObject({
      _count: { select: { enrollments: true } },
    });
    expect(findArgs.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('different tenant ID flows through to where clause', async () => {
    prisma.sequence.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 99 })}`);
    expect(res.status).toBe(200);
    expect(prisma.sequence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 99 } }),
    );
  });

  test('prisma throw → 500 with safe error envelope (no leak of err.message)', async () => {
    prisma.sequence.findMany.mockRejectedValue(new Error('db connection lost'));
    const res = await request(makeApp())
      .get('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to read marketing sequences.');
    expect(JSON.stringify(res.body)).not.toMatch(/db connection lost/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /api/sequences?fields=summary — slim-shape opt-in (#920 slice 12)
// ─────────────────────────────────────────────────────────────────────────
//
// Mirror of slice 1 (contacts), slice 2 (deals), slice 3 (tickets),
// slice 4 (tasks), slice 5 (projects), slice 6 (expenses), slice 7
// (notifications), slice 8 (surveys), slice 9 (email-templates), slice 10
// (knowledge-base). When the caller passes ?fields=summary, the route
// emits a slim Prisma `select` keyed on the columns the Sequences list
// renderer actually consumes and drops the heavy `nodes`/`edges` columns
// (Sequence.nodes/edges are `String? @db.Text` JSON blobs storing legacy
// ReactFlow canvas — many KB per row) plus the `_count.enrollments`
// include. Opt-in additive.

describe('GET /api/sequences?fields=summary — slim-shape opt-in (#920 slice 12)', () => {
  test('?fields=summary triggers prisma.sequence.findMany with `select` (slim cols), not the default include shape', async () => {
    prisma.sequence.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/sequences?fields=summary')
      .set('Authorization', `Bearer ${tokenFor()}`);

    const args = prisma.sequence.findMany.mock.calls[0][0];
    expect(args.select).toBeDefined();
    expect(args.select).toEqual({
      id: true,
      name: true,
      isActive: true,
      tenantId: true,
      createdAt: true,
      updatedAt: true,
    });
    // Slim shape must NOT pull the heavy Text `nodes`/`edges` JSON blobs.
    expect(args.select.nodes).toBeUndefined();
    expect(args.select.edges).toBeUndefined();
    // include must NOT be set on slim path — `_count.enrollments` is dropped.
    expect(args.include).toBeUndefined();
  });

  test('default (no ?fields) preserves the full-row + _count.enrollments include shape — no `select` arg passed to findMany', async () => {
    prisma.sequence.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor()}`);

    const args = prisma.sequence.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
    expect(args.include).toMatchObject({
      _count: { select: { enrollments: true } },
    });
  });

  test('?fields=summary response rows reflect the slim Prisma select verbatim (no nodes/edges JSON in body)', async () => {
    // Prisma `select` honours only the chosen columns. The route forwards
    // whatever Prisma returns, so we pin the contract by mocking the slim
    // rows and confirming `nodes`/`edges`/`_count` are absent in the
    // response body too.
    prisma.sequence.findMany.mockResolvedValue([
      {
        id: 1, name: 'Welcome drip', isActive: true, tenantId: 1,
        createdAt: new Date('2026-05-26T00:00:00Z'),
        updatedAt: new Date('2026-05-26T01:00:00Z'),
      },
      {
        id: 2, name: 'Re-engagement', isActive: false, tenantId: 1,
        createdAt: new Date('2026-05-26T02:00:00Z'),
        updatedAt: new Date('2026-05-26T03:00:00Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/sequences?fields=summary')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    for (const row of res.body) {
      expect(row.id).toBeDefined();
      expect(row.name).toBeDefined();
      expect(row.isActive).toBeDefined();
      expect(row.nodes).toBeUndefined(); // heavy Text blob gone
      expect(row.edges).toBeUndefined();
      expect(row._count).toBeUndefined(); // enrollments count not pulled
    }
  });

  test('?fields=summary preserves tenant isolation on the where clause', async () => {
    prisma.sequence.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/sequences?fields=summary')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 99 })}`);

    const args = prisma.sequence.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 99 });
    // Slim select still applied — the tenant scope and the slim opt-in
    // are independent contracts that compose cleanly.
    expect(args.select).toBeDefined();
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields=other (any non-exact value) falls through to the default include shape', async () => {
    // Only the literal string "summary" opts into slim — every other value
    // (including "Summary", "full", arbitrary tokens) must preserve the
    // existing wire shape so we don't accidentally trim production callers.
    prisma.sequence.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/sequences?fields=Summary')
      .set('Authorization', `Bearer ${tokenFor()}`);

    const args = prisma.sequence.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
    expect(args.include).toMatchObject({
      _count: { select: { enrollments: true } },
    });

    // Same for arbitrary tokens.
    prisma.sequence.findMany.mockReset();
    prisma.sequence.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/sequences?fields=full')
      .set('Authorization', `Bearer ${tokenFor()}`);
    const args2 = prisma.sequence.findMany.mock.calls[0][0];
    expect(args2.select).toBeUndefined();
    expect(args2.include).toMatchObject({
      _count: { select: { enrollments: true } },
    });
  });
});

// ─── POST / (create) ──────────────────────────────────────────────────

describe('POST /api/sequences (create)', () => {
  test('happy path: 201 with name + JSON-stringified nodes/edges + isActive=false default (#374)', async () => {
    prisma.sequence.create.mockImplementation(async (args) => ({
      id: 100,
      ...args.data,
    }));
    const nodes = [{ id: 'n1', data: { label: 'Email step' } }];
    const edges = [{ id: 'e1', source: 'n1', target: 'n2' }];
    const res = await request(makeApp())
      .post('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ name: 'Welcome drip', nodes, edges });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 100,
      name: 'Welcome drip',
      tenantId: 1,
      isActive: false, // #374 — newly-created drips land as DRAFT
    });

    // #646 standing rule: nodes/edges are JSON.stringify'd before Prisma write
    // because Sequence.nodes/edges are `String? @db.Text` JSON columns.
    const createArgs = prisma.sequence.create.mock.calls[0][0];
    expect(typeof createArgs.data.nodes).toBe('string');
    expect(typeof createArgs.data.edges).toBe('string');
    expect(JSON.parse(createArgs.data.nodes)).toEqual(nodes);
    expect(JSON.parse(createArgs.data.edges)).toEqual(edges);
    // tenantId comes from req.user, not from body.
    expect(createArgs.data.tenantId).toBe(1);
  });

  test('empty array nodes/edges still valid (stored as JSON-stringified "[]")', async () => {
    prisma.sequence.create.mockImplementation(async (args) => ({
      id: 101,
      ...args.data,
    }));
    const res = await request(makeApp())
      .post('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ name: 'Empty canvas', nodes: [], edges: [] });
    expect(res.status).toBe(201);
    const createArgs = prisma.sequence.create.mock.calls[0][0];
    expect(createArgs.data.nodes).toBe('[]');
    expect(createArgs.data.edges).toBe('[]');
  });

  test('honours explicit isActive=true from body (e.g. "save & activate" CTA)', async () => {
    prisma.sequence.create.mockImplementation(async (args) => ({
      id: 102,
      ...args.data,
    }));
    const res = await request(makeApp())
      .post('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ name: 'Pre-armed', nodes: [], edges: [], isActive: true });
    expect(res.status).toBe(201);
    expect(res.body.isActive).toBe(true);
  });

  test('missing name → 400 INVALID_SEQUENCE (#396)', async () => {
    const res = await request(makeApp())
      .post('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ nodes: [], edges: [] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SEQUENCE' });
    expect(res.body.error).toMatch(/name is required/i);
    expect(prisma.sequence.create).not.toHaveBeenCalled();
  });

  test('whitespace-only name → 400 INVALID_SEQUENCE (sanitizeText trims to empty)', async () => {
    const res = await request(makeApp())
      .post('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ name: '   ', nodes: [], edges: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SEQUENCE');
    expect(prisma.sequence.create).not.toHaveBeenCalled();
  });

  test('non-array nodes → 400 INVALID_SEQUENCE (#395)', async () => {
    const res = await request(makeApp())
      .post('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ name: 'Bad shape', nodes: 'not-an-array', edges: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SEQUENCE');
    expect(prisma.sequence.create).not.toHaveBeenCalled();
  });

  test('non-array edges fallback-coerces to "[]" (route is lenient on edges)', async () => {
    // #395 only blocks non-array nodes; edges has the
    // `Array.isArray(edges) ? edges : []` fallback. Pin that behaviour.
    prisma.sequence.create.mockImplementation(async (args) => ({
      id: 103,
      ...args.data,
    }));
    const res = await request(makeApp())
      .post('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ name: 'Lenient edges', nodes: [], edges: 'not-an-array' });
    expect(res.status).toBe(201);
    const createArgs = prisma.sequence.create.mock.calls[0][0];
    expect(createArgs.data.edges).toBe('[]');
  });

  test('HTML in node label is scrubbed via sanitizeNodes before persisting (#398)', async () => {
    prisma.sequence.create.mockImplementation(async (args) => ({
      id: 104,
      ...args.data,
    }));
    const nodes = [
      { id: 'n1', data: { label: '<script>alert(1)</script>Real label' } },
    ];
    const res = await request(makeApp())
      .post('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ name: 'Sanitize test', nodes, edges: [] });
    expect(res.status).toBe(201);
    const createArgs = prisma.sequence.create.mock.calls[0][0];
    const persistedNodes = JSON.parse(createArgs.data.nodes);
    // Script tags stripped; inner text content / "Real label" survives.
    expect(persistedNodes[0].data.label).not.toMatch(/<script>/i);
    expect(persistedNodes[0].data.label).toMatch(/Real label/);
  });

  test('prisma create throw → 500 INVALID_SEQUENCE (no err.message leak)', async () => {
    prisma.sequence.create.mockRejectedValue(new Error('Compilation of Drip Array failed.'));
    const res = await request(makeApp())
      .post('/api/sequences')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ name: 'Will throw', nodes: [], edges: [] });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INVALID_SEQUENCE');
    expect(JSON.stringify(res.body)).not.toMatch(/Compilation of Drip Array/);
  });
});

// ─── PATCH /:id (update) ──────────────────────────────────────────────

describe('PATCH /api/sequences/:id (update)', () => {
  test('happy path: tenant-scoped update returns 200, partial fields applied', async () => {
    prisma.sequence.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, name: 'Old', nodes: '[]', edges: '[]', isActive: false,
    });
    prisma.sequence.update.mockImplementation(async (args) => ({
      id: 50, ...args.data,
    }));
    const res = await request(makeApp())
      .patch('/api/sequences/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ name: 'New name', isActive: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'New name', isActive: true });
    expect(prisma.sequence.findFirst).toHaveBeenCalledWith({
      where: { id: 50, tenantId: 1 },
    });
    // Only keys present in body land in update.data.
    const updateArgs = prisma.sequence.update.mock.calls[0][0];
    expect(updateArgs.data.name).toBe('New name');
    expect(updateArgs.data.isActive).toBe(true);
    expect(updateArgs.data.nodes).toBeUndefined();
    expect(updateArgs.data.edges).toBeUndefined();
  });

  test('nodes update gets JSON.stringify before write (#646 standing rule)', async () => {
    prisma.sequence.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.sequence.update.mockImplementation(async (args) => ({
      id: 50, ...args.data,
    }));
    const newNodes = [{ id: 'n2', data: { label: 'Updated step' } }];
    const res = await request(makeApp())
      .patch('/api/sequences/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ nodes: newNodes });
    expect(res.status).toBe(200);
    const updateArgs = prisma.sequence.update.mock.calls[0][0];
    expect(typeof updateArgs.data.nodes).toBe('string');
    expect(JSON.parse(updateArgs.data.nodes)).toEqual(newNodes);
  });

  test('cross-tenant sequence → 404 (tenant isolation)', async () => {
    prisma.sequence.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/sequences/999')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 2 })}`)
      .send({ name: 'Hijack' });
    expect(res.status).toBe(404);
    expect(prisma.sequence.update).not.toHaveBeenCalled();
    expect(prisma.sequence.findFirst).toHaveBeenCalledWith({
      where: { id: 999, tenantId: 2 },
    });
  });

  test('INVALID_ID guard: PATCH /:id with non-numeric id → 400', async () => {
    const res = await request(makeApp())
      .patch('/api/sequences/not-a-number')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ name: 'Foo' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid sequence id/i);
    expect(prisma.sequence.findFirst).not.toHaveBeenCalled();
  });

  test('whitespace-only name on update → 400 INVALID_SEQUENCE (#396)', async () => {
    prisma.sequence.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    const res = await request(makeApp())
      .patch('/api/sequences/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SEQUENCE');
    expect(prisma.sequence.update).not.toHaveBeenCalled();
  });

  test('non-array nodes on update → 400 INVALID_SEQUENCE (#395)', async () => {
    prisma.sequence.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    const res = await request(makeApp())
      .patch('/api/sequences/50')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ nodes: { not: 'array' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SEQUENCE');
    expect(prisma.sequence.update).not.toHaveBeenCalled();
  });
});

// ─── PATCH /:id/toggle ────────────────────────────────────────────────

describe('PATCH /api/sequences/:id/toggle', () => {
  test('happy path: flips isActive, returns {success: true}', async () => {
    prisma.sequence.findFirst.mockResolvedValue({ id: 50, tenantId: 1, isActive: false });
    prisma.sequence.update.mockResolvedValue({ id: 50, isActive: true });
    const res = await request(makeApp())
      .patch('/api/sequences/50/toggle')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ isActive: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.sequence.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { isActive: true },
    });
  });

  test('cross-tenant sequence → 404', async () => {
    prisma.sequence.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/sequences/777/toggle')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 2 })}`)
      .send({ isActive: true });
    expect(res.status).toBe(404);
    expect(prisma.sequence.update).not.toHaveBeenCalled();
  });
});

// ─── DELETE /:id ──────────────────────────────────────────────────────

describe('DELETE /api/sequences/:id', () => {
  test('happy path: cascade-deletes enrollments BEFORE sequence', async () => {
    prisma.sequence.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.sequenceEnrollment.deleteMany.mockResolvedValue({ count: 3 });
    prisma.sequence.delete.mockResolvedValue({ id: 50 });
    const res = await request(makeApp())
      .delete('/api/sequences/50')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    // Enrollments wiped first.
    expect(prisma.sequenceEnrollment.deleteMany).toHaveBeenCalledWith({
      where: { sequenceId: 50 },
    });
    expect(prisma.sequence.delete).toHaveBeenCalledWith({ where: { id: 50 } });
    // Call order: deleteMany BEFORE delete.
    const deleteManyOrder = prisma.sequenceEnrollment.deleteMany.mock.invocationCallOrder[0];
    const deleteOrder = prisma.sequence.delete.mock.invocationCallOrder[0];
    expect(deleteManyOrder).toBeLessThan(deleteOrder);
  });

  test('cross-tenant sequence → 404, no delete attempted', async () => {
    prisma.sequence.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/sequences/777')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 2 })}`);
    expect(res.status).toBe(404);
    expect(prisma.sequenceEnrollment.deleteMany).not.toHaveBeenCalled();
    expect(prisma.sequence.delete).not.toHaveBeenCalled();
  });

  test('INVALID_ID guard: DELETE /:id with non-numeric id → 400', async () => {
    const res = await request(makeApp())
      .delete('/api/sequences/not-a-number')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid sequence id/i);
    expect(prisma.sequence.findFirst).not.toHaveBeenCalled();
  });
});

// ─── POST /:id/enroll ─────────────────────────────────────────────────

describe('POST /api/sequences/:id/enroll', () => {
  test('happy path: creates SequenceEnrollment row with status=Active', async () => {
    prisma.sequence.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.contact.findFirst.mockResolvedValue({ id: 9, tenantId: 1 });
    prisma.sequenceEnrollment.findFirst.mockResolvedValue(null);
    prisma.sequenceEnrollment.create.mockImplementation(async (args) => ({
      id: 200,
      ...args.data,
    }));
    const res = await request(makeApp())
      .post('/api/sequences/50/enroll')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ contactId: 9 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      enrollment: expect.objectContaining({
        id: 200,
        sequenceId: 50,
        contactId: 9,
        status: 'Active',
        tenantId: 1,
      }),
    });
    // Both lookups must be tenant-scoped.
    expect(prisma.sequence.findFirst).toHaveBeenCalledWith({
      where: { id: 50, tenantId: 1 },
    });
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: 9, tenantId: 1 },
    });
  });

  test('missing contactId → 400', async () => {
    const res = await request(makeApp())
      .post('/api/sequences/50/enroll')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contactId/i);
    expect(prisma.sequenceEnrollment.create).not.toHaveBeenCalled();
  });

  test('non-numeric sequence id → 400 (parseInt → NaN)', async () => {
    const res = await request(makeApp())
      .post('/api/sequences/not-a-number/enroll')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ contactId: 9 });
    expect(res.status).toBe(400);
    expect(prisma.sequence.findFirst).not.toHaveBeenCalled();
  });

  test('sequence cross-tenant → 404 "Sequence not found"', async () => {
    prisma.sequence.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/sequences/999/enroll')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 2 })}`)
      .send({ contactId: 9 });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/sequence not found/i);
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('contact cross-tenant → 404 "Contact not found"', async () => {
    prisma.sequence.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.contact.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/sequences/50/enroll')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ contactId: 9999 });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/contact not found/i);
    expect(prisma.sequenceEnrollment.create).not.toHaveBeenCalled();
  });

  test('already enrolled → 400 "already enrolled"', async () => {
    prisma.sequence.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.contact.findFirst.mockResolvedValue({ id: 9, tenantId: 1 });
    prisma.sequenceEnrollment.findFirst.mockResolvedValue({ id: 1, sequenceId: 50, contactId: 9 });
    const res = await request(makeApp())
      .post('/api/sequences/50/enroll')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ contactId: 9 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already enrolled/i);
    expect(prisma.sequenceEnrollment.create).not.toHaveBeenCalled();
  });
});

// ─── Module exports (test-helper surface, #616) ───────────────────────

describe('module.exports — test helper surface', () => {
  test('exports sanitizeText, sanitizeJson, sanitizeNodes helpers', () => {
    expect(typeof sequencesRouter.sanitizeText).toBe('function');
    expect(typeof sequencesRouter.sanitizeJson).toBe('function');
    expect(typeof sequencesRouter.sanitizeNodes).toBe('function');
  });

  test('sanitizeNodes returns input unchanged for non-array input', () => {
    expect(sequencesRouter.sanitizeNodes(null)).toBe(null);
    expect(sequencesRouter.sanitizeNodes(undefined)).toBe(undefined);
    expect(sequencesRouter.sanitizeNodes('not array')).toBe('not array');
  });

  test('sanitizeNodes scrubs HTML from data.label across array entries', () => {
    const nodes = [
      { id: 'n1', data: { label: '<script>x</script>Step 1' } },
      { id: 'n2', data: { label: 'Clean label' } },
      { id: 'n3' }, // no data — passes through untouched
    ];
    const cleaned = sequencesRouter.sanitizeNodes(nodes);
    expect(cleaned[0].data.label).not.toMatch(/<script>/i);
    expect(cleaned[0].data.label).toMatch(/Step 1/);
    expect(cleaned[1].data.label).toBe('Clean label');
    expect(cleaned[2]).toEqual({ id: 'n3' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// S85 — SequenceStep route forwards attachmentRefsJson on POST + PUT
// (PRD_TRAVEL_MARKETING_FLYER FR-3.5 / AC-6.5)
//
// S19 shipped the schema column + cron consumer; S85 closes the API loop
// so operators can set flyer attachments via the route layer. The probe-
// skip e2e spec (sequence-engine-flyer-attachment-api.spec.js) flips green
// once the round-trip works — these vitest cases pin the contract from the
// unit-test side.
//
// Contract pinned:
//   - POST /:id/steps with valid attachmentRefsJson (string OR array) → persisted
//   - POST /:id/steps without attachmentRefsJson → unchanged, field null
//   - POST with invalid JSON string → 400 INVALID_ATTACHMENT_REFS
//   - POST with non-array JSON → 400 INVALID_ATTACHMENT_REFS
//   - POST with entry missing `kind` → 400 INVALID_ATTACHMENT_REFS
//   - POST with oversized JSON (>16KB) → 400 ATTACHMENT_REFS_TOO_LARGE
//   - POST sanitizes HTML inside JSON string values (HTML inside ref → stripped)
//   - PUT /steps/:id updates attachmentRefsJson
//   - PUT /steps/:id with null clears
//   - PUT /steps/:id with "" clears
//   - PUT /steps/:id with invalid JSON → 400 INVALID_ATTACHMENT_REFS
//   - Cross-tenant POST step is blocked (sequence findFirst returns null → 404)
//   - Auth gate: POST + PUT require Bearer
// ─────────────────────────────────────────────────────────────────────────

describe('S85 — SequenceStep route forwards attachmentRefsJson', () => {
  // POST /:id/steps lookup short-circuits on `findSequenceForTenant` (sequence.findFirst);
  // we mock a valid parent sequence + no prior steps so the create proceeds.
  function arrangeStepCreateMocks({ tenantId = 1 } = {}) {
    prisma.sequence.findFirst.mockResolvedValue({ id: 50, tenantId });
    prisma.sequenceStep.findFirst.mockResolvedValue(null);      // no prior steps → position 0
    prisma.sequenceStep.findMany.mockResolvedValue([]);          // no shift required
    prisma.sequenceStep.create.mockImplementation(async (args) => ({
      id: 900,
      ...args.data,
    }));
  }

  function arrangeStepPutMocks(existing = { id: 901, sequenceId: 50, attachmentRefsJson: null }) {
    prisma.sequenceStep.findFirst.mockResolvedValue(existing);
    prisma.sequenceStep.update.mockImplementation(async (args) => ({
      ...existing,
      ...args.data,
      id: existing.id,
    }));
  }

  // ── POST: happy path with string-encoded JSON ─────────────────────────
  test('POST /:id/steps with valid attachmentRefsJson string → persisted', async () => {
    arrangeStepCreateMocks();
    const refs = [
      { kind: 'flyer', flyerId: 42, format: 'pdf-a4' },
    ];
    const res = await request(makeApp())
      .post('/api/sequences/50/steps')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ kind: 'email', position: 0, attachmentRefsJson: JSON.stringify(refs) });
    expect(res.status).toBe(201);
    const createArgs = prisma.sequenceStep.create.mock.calls[0][0];
    // sanitizeJsonForStringColumn round-trips JSON-string → string (no HTML to strip)
    expect(typeof createArgs.data.attachmentRefsJson).toBe('string');
    expect(JSON.parse(createArgs.data.attachmentRefsJson)).toEqual(refs);
    // Response body forwards the stored value verbatim
    expect(typeof res.body.attachmentRefsJson).toBe('string');
    expect(res.body.attachmentRefsJson.length).toBeGreaterThan(0);
  });

  // ── POST: accept array-typed body (typed-client path) ─────────────────
  test('POST /:id/steps accepts a JS array (typed-client) and stringifies before store', async () => {
    arrangeStepCreateMocks();
    const refs = [
      { kind: 'flyer', flyerId: 7, format: 'png-square' },
      { kind: 'file', url: 'https://example.com/brochure.pdf', filename: 'brochure.pdf' },
    ];
    const res = await request(makeApp())
      .post('/api/sequences/50/steps')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ kind: 'email', position: 0, attachmentRefsJson: refs });
    expect(res.status).toBe(201);
    const createArgs = prisma.sequenceStep.create.mock.calls[0][0];
    expect(typeof createArgs.data.attachmentRefsJson).toBe('string');
    const parsed = JSON.parse(createArgs.data.attachmentRefsJson);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ kind: 'flyer', flyerId: 7 });
  });

  // ── POST: omitted field → null (existing behavior preserved) ──────────
  test('POST /:id/steps without attachmentRefsJson → field null, existing behavior unchanged', async () => {
    arrangeStepCreateMocks();
    const res = await request(makeApp())
      .post('/api/sequences/50/steps')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ kind: 'email', position: 0 });
    expect(res.status).toBe(201);
    const createArgs = prisma.sequenceStep.create.mock.calls[0][0];
    expect(createArgs.data.attachmentRefsJson).toBeNull();
  });

  // ── POST: malformed JSON string → 400 INVALID_ATTACHMENT_REFS ─────────
  test('POST /:id/steps with un-parseable JSON string → 400 INVALID_ATTACHMENT_REFS', async () => {
    arrangeStepCreateMocks();
    const res = await request(makeApp())
      .post('/api/sequences/50/steps')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ kind: 'email', position: 0, attachmentRefsJson: '{not valid json' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ATTACHMENT_REFS');
    expect(prisma.sequenceStep.create).not.toHaveBeenCalled();
  });

  // ── POST: parsed root not an array → 400 ──────────────────────────────
  test('POST /:id/steps with non-array JSON root → 400 INVALID_ATTACHMENT_REFS', async () => {
    arrangeStepCreateMocks();
    const res = await request(makeApp())
      .post('/api/sequences/50/steps')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ kind: 'email', position: 0, attachmentRefsJson: JSON.stringify({ kind: 'flyer' }) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ATTACHMENT_REFS');
    expect(prisma.sequenceStep.create).not.toHaveBeenCalled();
  });

  // ── POST: entry missing `kind` → 400 ──────────────────────────────────
  test('POST /:id/steps with array entry missing `kind` → 400 INVALID_ATTACHMENT_REFS', async () => {
    arrangeStepCreateMocks();
    const res = await request(makeApp())
      .post('/api/sequences/50/steps')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({
        kind: 'email',
        position: 0,
        attachmentRefsJson: JSON.stringify([{ flyerId: 1, format: 'pdf-a4' }]),
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ATTACHMENT_REFS');
    expect(prisma.sequenceStep.create).not.toHaveBeenCalled();
  });

  // ── POST: oversized blob → 400 ATTACHMENT_REFS_TOO_LARGE ─────────────
  test('POST /:id/steps with >16KB attachmentRefsJson → 400 ATTACHMENT_REFS_TOO_LARGE', async () => {
    arrangeStepCreateMocks();
    // Construct a > 16KB JSON-array payload — many flyer entries with padding.
    const padding = 'x'.repeat(2000);
    const bigRefs = [];
    for (let i = 0; i < 20; i += 1) {
      bigRefs.push({ kind: 'flyer', flyerId: i, format: 'pdf-a4', note: padding });
    }
    const oversized = JSON.stringify(bigRefs);
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(16 * 1024);
    const res = await request(makeApp())
      .post('/api/sequences/50/steps')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ kind: 'email', position: 0, attachmentRefsJson: oversized });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ATTACHMENT_REFS_TOO_LARGE');
    expect(prisma.sequenceStep.create).not.toHaveBeenCalled();
  });

  // ── POST: HTML inside string value scrubbed via sanitizeJsonForStringColumn ─
  test('POST /:id/steps strips HTML from string values inside attachmentRefsJson', async () => {
    arrangeStepCreateMocks();
    const refs = [
      { kind: 'flyer', flyerId: 1, format: 'pdf-a4', caption: '<script>alert(1)</script>Clean caption' },
    ];
    const res = await request(makeApp())
      .post('/api/sequences/50/steps')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ kind: 'email', position: 0, attachmentRefsJson: JSON.stringify(refs) });
    expect(res.status).toBe(201);
    const createArgs = prisma.sequenceStep.create.mock.calls[0][0];
    const persisted = JSON.parse(createArgs.data.attachmentRefsJson);
    expect(persisted[0].caption).not.toMatch(/<script>/i);
    expect(persisted[0].caption).toMatch(/Clean caption/);
  });

  // ── POST: cross-tenant rejection (parent sequence not found) ──────────
  test('POST /:id/steps cross-tenant → 404; sequenceStep.create never called', async () => {
    prisma.sequence.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/sequences/999/steps')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 2 })}`)
      .send({
        kind: 'email',
        position: 0,
        attachmentRefsJson: JSON.stringify([{ kind: 'flyer', flyerId: 1 }]),
      });
    expect(res.status).toBe(404);
    expect(prisma.sequenceStep.create).not.toHaveBeenCalled();
  });

  // ── PUT: updates the field ────────────────────────────────────────────
  test('PUT /steps/:id with valid attachmentRefsJson → persisted', async () => {
    arrangeStepPutMocks();
    const refs = [{ kind: 'flyer', flyerId: 99, format: 'pdf-a5' }];
    const res = await request(makeApp())
      .put('/api/sequences/steps/901')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ attachmentRefsJson: JSON.stringify(refs) });
    expect(res.status).toBe(200);
    const updateArgs = prisma.sequenceStep.update.mock.calls[0][0];
    expect(typeof updateArgs.data.attachmentRefsJson).toBe('string');
    expect(JSON.parse(updateArgs.data.attachmentRefsJson)).toEqual(refs);
  });

  // ── PUT: null clears the field ────────────────────────────────────────
  test('PUT /steps/:id with attachmentRefsJson=null clears the column', async () => {
    arrangeStepPutMocks({
      id: 901, sequenceId: 50,
      attachmentRefsJson: JSON.stringify([{ kind: 'flyer', flyerId: 1 }]),
    });
    const res = await request(makeApp())
      .put('/api/sequences/steps/901')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ attachmentRefsJson: null });
    expect(res.status).toBe(200);
    const updateArgs = prisma.sequenceStep.update.mock.calls[0][0];
    expect(updateArgs.data.attachmentRefsJson).toBeNull();
  });

  // ── PUT: empty string also clears ─────────────────────────────────────
  test('PUT /steps/:id with attachmentRefsJson="" also clears the column', async () => {
    arrangeStepPutMocks();
    const res = await request(makeApp())
      .put('/api/sequences/steps/901')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ attachmentRefsJson: '' });
    expect(res.status).toBe(200);
    const updateArgs = prisma.sequenceStep.update.mock.calls[0][0];
    expect(updateArgs.data.attachmentRefsJson).toBeNull();
  });

  // ── PUT: omitted field → no overwrite ─────────────────────────────────
  test('PUT /steps/:id without attachmentRefsJson key → field NOT touched on update', async () => {
    arrangeStepPutMocks({
      id: 901, sequenceId: 50,
      attachmentRefsJson: JSON.stringify([{ kind: 'flyer', flyerId: 1 }]),
    });
    const res = await request(makeApp())
      .put('/api/sequences/steps/901')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ smsBody: 'Hello' });
    expect(res.status).toBe(200);
    const updateArgs = prisma.sequenceStep.update.mock.calls[0][0];
    // attachmentRefsJson must NOT appear in data.* — undefined-body fields skip.
    expect(updateArgs.data).not.toHaveProperty('attachmentRefsJson');
  });

  // ── PUT: invalid JSON → 400 ───────────────────────────────────────────
  test('PUT /steps/:id with un-parseable JSON → 400 INVALID_ATTACHMENT_REFS', async () => {
    arrangeStepPutMocks();
    const res = await request(makeApp())
      .put('/api/sequences/steps/901')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ attachmentRefsJson: '{nope' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ATTACHMENT_REFS');
    expect(prisma.sequenceStep.update).not.toHaveBeenCalled();
  });

  // ── Auth gate ─────────────────────────────────────────────────────────
  test('POST /:id/steps without Bearer → 401', async () => {
    const res = await request(makeApp())
      .post('/api/sequences/50/steps')
      .send({ kind: 'email', position: 0, attachmentRefsJson: '[]' });
    expect(res.status).toBe(401);
    expect(prisma.sequenceStep.create).not.toHaveBeenCalled();
  });

  test('PUT /steps/:id without Bearer → 401', async () => {
    const res = await request(makeApp())
      .put('/api/sequences/steps/901')
      .send({ attachmentRefsJson: '[]' });
    expect(res.status).toBe(401);
    expect(prisma.sequenceStep.update).not.toHaveBeenCalled();
  });

  // ── ADMIN guard: USER role rejected (stepGuard = ADMIN-only) ─────────
  test('POST /:id/steps with USER role → 403 (stepGuard = ADMIN-only)', async () => {
    const res = await request(makeApp())
      .post('/api/sequences/50/steps')
      .set('Authorization', `Bearer ${tokenFor({ role: 'USER' })}`)
      .send({ kind: 'email', position: 0 });
    expect(res.status).toBe(403);
    expect(prisma.sequenceStep.create).not.toHaveBeenCalled();
  });
});
