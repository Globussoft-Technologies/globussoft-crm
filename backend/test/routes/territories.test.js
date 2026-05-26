// @ts-check
/**
 * Unit tests for backend/routes/territories.js — pin the sales-territories CRUD +
 * contact-assignment surface (admin-gated for writes, tenant-scoped on every
 * read), backing the LeadRouting + Territories admin pages.
 *
 * Why this file exists
 * ────────────────────
 * territories.js is 183 LOC of multi-tenant CRUD with two historically-fragile
 * shapes that need pinning:
 *
 *   1. JSON-string columns. `regions` and `assignedUserIds` are stored as
 *      `String? @db.Text` rendering of a JSON array — the route stringifies on
 *      WRITE and JSON.parses on READ via the `shape()` helper. Untested, the
 *      contract drifts the moment someone "helpfully" switches a column to
 *      Prisma Json type or vice versa.
 *   2. Admin-only writes (#527 CRIT-02). GET stays open (USERs need to see
 *      their territory); POST/PUT/DELETE/assign-contact all require
 *      verifyRole(["ADMIN"]). Mirrored canonically in the auth middleware.
 *
 * What this file pins (14 cases across 6 describe blocks)
 * ───────────────────────────────────────────────────────
 *   1. GET / — tenant-scoped list with contact-count rollup; cross-tenant
 *      territories never appear (where.tenantId = req.user.tenantId).
 *   2. GET / — JSON-string columns are .parse()d back to arrays before the
 *      response, and contactCount comes from the contact.groupBy rollup.
 *   3. GET / — when there are no territories, groupBy is skipped (no useless
 *      DB round-trip) and the response is `[]`.
 *   4. POST / — creates with name, stringified regions, stringified
 *      assignedUserIds (Number-coerced + NaN-filtered), under req.user.tenantId.
 *   5. POST / — 400 when name is missing (rejects empty-body create).
 *   6. POST / — non-array `regions` / `assignedUserIds` defaults to `[]`
 *      (defensive coerce — never store a non-array value).
 *   7. POST / — 403 RBAC_DENIED for non-ADMIN role (admin-only gate).
 *   8. PUT /:id — happy path updates name + restringifies arrays; 200 with
 *      reshaped response.
 *   9. PUT /:id — 404 when id belongs to a different tenant (cross-tenant
 *      isolation — findFirst returns null because where.tenantId mismatches).
 *  10. PUT /:id — 400 when :id is not a number ("Invalid id").
 *  11. DELETE /:id — detaches contacts via contact.updateMany THEN deletes the
 *      territory (order matters — the FK constraint would otherwise block
 *      the delete).
 *  12. POST /:id/assign-contact — 400 when contactId is missing.
 *  13. POST /:id/assign-contact — happy path updates Contact.territoryId and
 *      returns `{success, contact:{id, territoryId}}`.
 *  14. GET /:id/contacts — returns selected fields only (no PHI / no internal
 *      audit fields) scoped by territory + tenant.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/payments.test.js — prisma singleton monkey-patch
 * BEFORE requiring the router (vi.mock doesn't reliably intercept CJS require
 * in this repo's vitest config). Real JWTs are NOT needed here because the
 * auth middleware is replaced by a fake that sets `req.user` — exactly the
 * pattern payments.test.js uses, which is canon for this codebase.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// ── prisma singleton patching ──────────────────────────────────────────
import prisma from '../../lib/prisma.js';

prisma.territory = prisma.territory || {};
prisma.territory.findMany = vi.fn();
prisma.territory.findFirst = vi.fn();
prisma.territory.create = vi.fn();
prisma.territory.update = vi.fn();
prisma.territory.delete = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.groupBy = vi.fn();
prisma.contact.findFirst = vi.fn();
prisma.contact.findMany = vi.fn();
prisma.contact.update = vi.fn();
prisma.contact.updateMany = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Stub the auth middleware BEFORE requiring the router — the router pulls
// verifyToken + verifyRole at module-load and binds them as adminOnly[].
// vi.mock has timing issues with the CJS bridge in this repo; the canonical
// pattern is to inject a fake req.user via a global pre-router middleware
// (see payments.test.js). For the admin-only RBAC test we plumb the role
// through req.user and rely on the REAL verifyRole to do its job.
//
// Because verifyToken reads `Authorization: Bearer <jwt>`, and we don't want
// to mint a real JWT for every test, we mount a tiny middleware BEFORE the
// router that sets req.user, and replace verifyToken with a passthrough at
// the module-cache level so verifyRole's "req.user.role" check still fires.

const authMod = requireCJS('../../middleware/auth');
const originalVerifyToken = authMod.verifyToken;
// Replace verifyToken with a passthrough — req.user is already populated by
// the test's pre-router middleware. verifyRole stays REAL so we exercise the
// admin-only gate end-to-end.
authMod.verifyToken = (_req, _res, next) => next();

const territoriesRouter = requireCJS('../../routes/territories');

// Restore verifyToken so other tests in this file (if any future ones rely
// on the real flow) aren't tripped — module cache is shared. Actually keep
// the passthrough for the duration; restoring would un-patch the router's
// already-bound reference. (Express captures the function reference at route
// registration time, so this restore would be a no-op anyway — kept here
// only as documentation.)
void originalVerifyToken;

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/territories', territoriesRouter);
  return app;
}

beforeEach(() => {
  prisma.territory.findMany.mockReset();
  prisma.territory.findFirst.mockReset();
  prisma.territory.create.mockReset();
  prisma.territory.update.mockReset();
  prisma.territory.delete.mockReset();
  prisma.contact.groupBy.mockReset();
  prisma.contact.findFirst.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.contact.update.mockReset();
  prisma.contact.updateMany.mockReset();

  // Sensible defaults — each test overrides what it cares about.
  prisma.territory.findMany.mockResolvedValue([]);
  prisma.territory.findFirst.mockResolvedValue(null);
  prisma.territory.create.mockResolvedValue({});
  prisma.territory.update.mockResolvedValue({});
  prisma.territory.delete.mockResolvedValue({});
  prisma.contact.groupBy.mockResolvedValue([]);
  prisma.contact.findFirst.mockResolvedValue(null);
  prisma.contact.findMany.mockResolvedValue([]);
  prisma.contact.update.mockResolvedValue({});
  prisma.contact.updateMany.mockResolvedValue({ count: 0 });
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — list territories
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list territories under tenant scope', () => {
  test('returns shaped territories with contactCount rollup, tenant-scoped', async () => {
    prisma.territory.findMany.mockResolvedValue([
      {
        id: 10,
        name: 'North Region',
        regions: JSON.stringify(['IN-DL', 'IN-HR']),
        assignedUserIds: JSON.stringify([2, 5]),
        tenantId: 1,
      },
      {
        id: 11,
        name: 'South Region',
        regions: JSON.stringify(['IN-KA']),
        assignedUserIds: JSON.stringify([]),
        tenantId: 1,
      },
    ]);
    prisma.contact.groupBy.mockResolvedValue([
      { territoryId: 10, _count: { _all: 3 } },
      { territoryId: 11, _count: { _all: 0 } },
    ]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/territories');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      id: 10,
      name: 'North Region',
      regions: ['IN-DL', 'IN-HR'],
      assignedUserIds: [2, 5],
      contactCount: 3,
    });
    expect(res.body[1]).toMatchObject({
      id: 11,
      regions: ['IN-KA'],
      assignedUserIds: [],
      contactCount: 0,
    });

    // Tenant isolation pinned: where.tenantId comes from req.user.tenantId,
    // not from any caller-supplied input.
    expect(prisma.territory.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: { id: 'asc' },
    });
    expect(prisma.contact.groupBy).toHaveBeenCalledWith({
      by: ['territoryId'],
      where: { tenantId: 1, territoryId: { in: [10, 11] } },
      _count: { _all: true },
    });
  });

  test('skips contact.groupBy when there are no territories (no useless round-trip)', async () => {
    prisma.territory.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/territories');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(prisma.contact.groupBy).not.toHaveBeenCalled();
  });

  test('safeJson tolerates already-parsed objects and malformed JSON (regions=null → [])', async () => {
    prisma.territory.findMany.mockResolvedValue([
      {
        id: 50,
        name: 'Legacy',
        regions: null,                // never stringified — must default to []
        assignedUserIds: '{invalid-json',  // parse failure — must default to []
        tenantId: 1,
      },
    ]);
    prisma.contact.groupBy.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/territories');

    expect(res.status).toBe(200);
    expect(res.body[0].regions).toEqual([]);
    expect(res.body[0].assignedUserIds).toEqual([]);
    expect(res.body[0].contactCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /?fields=summary — slim-shape opt-in (#920 slice 22)
// ─────────────────────────────────────────────────────────────────────────
//
// Mirrors slices 1-20. When the caller passes ?fields=summary, the route
// returns ONLY id + name + regions (parsed) + assignedUserIds (parsed) — the
// tenantId / createdAt / updatedAt metadata and the contactCount rollup are
// dropped. Opt-in additive: legacy callers (no ?fields, or any non-exact
// value) get the full row shape unchanged.

describe('GET /?fields=summary — slim-shape opt-in (#920 slice 22)', () => {
  test('?fields=summary returns slim shape with id+name+regions+assignedUserIds only', async () => {
    prisma.territory.findMany.mockResolvedValue([
      {
        id: 10,
        name: 'North Region',
        regions: JSON.stringify(['IN-DL', 'IN-HR']),
        assignedUserIds: JSON.stringify([2, 5]),
      },
      {
        id: 11,
        name: 'South Region',
        regions: JSON.stringify(['IN-KA']),
        assignedUserIds: JSON.stringify([]),
      },
    ]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/territories?fields=summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // Slim shape: only the 4 columns; no tenantId, no createdAt, no
    // contactCount.
    expect(res.body[0]).toEqual({
      id: 10,
      name: 'North Region',
      regions: ['IN-DL', 'IN-HR'],
      assignedUserIds: [2, 5],
    });
    expect(res.body[1]).toEqual({
      id: 11,
      name: 'South Region',
      regions: ['IN-KA'],
      assignedUserIds: [],
    });
  });

  test('?fields=summary calls findMany with a Prisma select dropping heavy/leak fields', async () => {
    prisma.territory.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 1 })).get('/api/territories?fields=summary');

    // Pin the exact select — slim shape MUST drop tenantId + createdAt +
    // updatedAt (the only metadata columns on Territory). Adding/removing
    // a field here is a wire-shape change for downstream consumers.
    expect(prisma.territory.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        regions: true,
        assignedUserIds: true,
      },
    });
  });

  test('?fields=summary skips the contact.groupBy rollup (cross-table aggregate not needed for picker)', async () => {
    prisma.territory.findMany.mockResolvedValue([
      { id: 10, name: 'A', regions: '[]', assignedUserIds: '[]' },
      { id: 11, name: 'B', regions: '[]', assignedUserIds: '[]' },
    ]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/territories?fields=summary');

    expect(res.status).toBe(200);
    // groupBy is NEVER called in summary mode — even with ids present in the
    // findMany result. This is the perf win: no cross-table aggregate when
    // the caller asked for a dropdown / picker shape.
    expect(prisma.contact.groupBy).not.toHaveBeenCalled();
    // And the response has no contactCount field.
    expect(res.body[0]).not.toHaveProperty('contactCount');
  });

  test('no ?fields query returns full shape (back-compat) — contactCount + tenantId preserved', async () => {
    prisma.territory.findMany.mockResolvedValue([
      {
        id: 10, name: 'North',
        regions: JSON.stringify(['IN-DL']),
        assignedUserIds: JSON.stringify([2]),
        tenantId: 1,
        createdAt: new Date('2026-01-01').toISOString(),
        updatedAt: new Date('2026-01-02').toISOString(),
      },
    ]);
    prisma.contact.groupBy.mockResolvedValue([
      { territoryId: 10, _count: { _all: 4 } },
    ]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/territories');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      id: 10,
      name: 'North',
      regions: ['IN-DL'],
      assignedUserIds: [2],
      tenantId: 1,
      contactCount: 4,
    });
    // Legacy findMany call — no select clause; full row shape returned.
    expect(prisma.territory.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: { id: 'asc' },
    });
    expect(prisma.contact.groupBy).toHaveBeenCalled();
  });

  test('?fields=other (non-exact value) falls through to full shape (only "summary" triggers opt-in)', async () => {
    prisma.territory.findMany.mockResolvedValue([
      {
        id: 10, name: 'North',
        regions: JSON.stringify(['IN-DL']),
        assignedUserIds: JSON.stringify([2]),
        tenantId: 1,
      },
    ]);
    prisma.contact.groupBy.mockResolvedValue([
      { territoryId: 10, _count: { _all: 1 } },
    ]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/territories?fields=full');

    expect(res.status).toBe(200);
    // Full shape — contactCount present, tenantId present, no select clause.
    expect(res.body[0]).toMatchObject({
      id: 10,
      tenantId: 1,
      contactCount: 1,
    });
    expect(prisma.territory.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      orderBy: { id: 'asc' },
    });
  });

  test('?fields=summary remains tenant-scoped — cross-tenant rows never returned', async () => {
    prisma.territory.findMany.mockResolvedValue([
      { id: 10, name: 'Tenant-7 Only', regions: '[]', assignedUserIds: '[]' },
    ]);

    await request(makeApp({ tenantId: 7 }))
      .get('/api/territories?fields=summary');

    // Even with the slim select, where.tenantId is sourced from req.user
    // (NOT any caller-supplied input). The opt-in shape MUST NOT relax
    // tenant isolation.
    expect(prisma.territory.findMany).toHaveBeenCalledWith({
      where: { tenantId: 7 },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        regions: true,
        assignedUserIds: true,
      },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — create territory (admin-only)
// ─────────────────────────────────────────────────────────────────────────

describe('POST / — create territory (admin-gated #527)', () => {
  test('creates with name + stringified arrays + tenant from JWT, 201 + shaped response', async () => {
    prisma.territory.create.mockResolvedValue({
      id: 99,
      name: 'East Region',
      regions: JSON.stringify(['IN-WB']),
      assignedUserIds: JSON.stringify([42]),
      tenantId: 1,
    });

    const res = await request(makeApp({ tenantId: 1, role: 'ADMIN' }))
      .post('/api/territories')
      .send({ name: 'East Region', regions: ['IN-WB'], assignedUserIds: [42] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 99,
      name: 'East Region',
      regions: ['IN-WB'],
      assignedUserIds: [42],
      contactCount: 0,
    });

    expect(prisma.territory.create).toHaveBeenCalledWith({
      data: {
        name: 'East Region',
        // Arrays are stringified to JSON before persisting — this contract
        // matters because the column type is String? @db.Text, NOT Json.
        regions: JSON.stringify(['IN-WB']),
        assignedUserIds: JSON.stringify([42]),
        tenantId: 1,
      },
    });
  });

  test('returns 400 when name is missing (rejects empty-body create)', async () => {
    const res = await request(makeApp({ role: 'ADMIN' }))
      .post('/api/territories')
      .send({ regions: ['IN-DL'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
    expect(prisma.territory.create).not.toHaveBeenCalled();
  });

  test('non-array regions / assignedUserIds default to [] (defensive coerce)', async () => {
    prisma.territory.create.mockResolvedValue({
      id: 1, name: 'X',
      regions: JSON.stringify([]),
      assignedUserIds: JSON.stringify([]),
      tenantId: 1,
    });

    await request(makeApp({ role: 'ADMIN' }))
      .post('/api/territories')
      .send({ name: 'X', regions: 'not-an-array', assignedUserIds: 'also-not' });

    // Critical: route MUST NOT persist the raw non-array value.
    expect(prisma.territory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        regions: JSON.stringify([]),
        assignedUserIds: JSON.stringify([]),
      }),
    });
  });

  test('coerces string-id userIds via Number() and drops NaN entries', async () => {
    prisma.territory.create.mockResolvedValue({
      id: 1, name: 'Y',
      regions: JSON.stringify([]),
      assignedUserIds: JSON.stringify([1, 2]),
      tenantId: 1,
    });

    await request(makeApp({ role: 'ADMIN' }))
      .post('/api/territories')
      .send({ name: 'Y', assignedUserIds: ['1', '2', 'not-a-num'] });

    // 'not-a-num' → NaN → filtered out. '1' + '2' coerced to 1 + 2.
    expect(prisma.territory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        assignedUserIds: JSON.stringify([1, 2]),
      }),
    });
  });

  test('returns 403 RBAC_DENIED when caller is not ADMIN (#527 admin-only gate)', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .post('/api/territories')
      .send({ name: 'Should-Not-Create' });

    expect(res.status).toBe(403);
    // Canonical RBAC denial envelope (#590/#591) — code lets specs distinguish
    // RBAC denial from other 403s without pattern-matching the human string.
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.territory.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id — update territory
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /:id — update territory (admin-gated)', () => {
  test('200 + restringifies arrays under tenant scope on happy path', async () => {
    prisma.territory.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, name: 'Old', regions: '[]', assignedUserIds: '[]',
    });
    prisma.territory.update.mockResolvedValue({
      id: 5, tenantId: 1, name: 'New',
      regions: JSON.stringify(['IN-MH']),
      assignedUserIds: JSON.stringify([9]),
    });

    const res = await request(makeApp({ tenantId: 1, role: 'ADMIN' }))
      .put('/api/territories/5')
      .send({ name: 'New', regions: ['IN-MH'], assignedUserIds: [9] });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
    expect(res.body.regions).toEqual(['IN-MH']);
    expect(res.body.assignedUserIds).toEqual([9]);

    // Existence check is tenant-scoped (cross-tenant id won't be found).
    expect(prisma.territory.findFirst).toHaveBeenCalledWith({
      where: { id: 5, tenantId: 1 },
    });
    expect(prisma.territory.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: {
        name: 'New',
        regions: JSON.stringify(['IN-MH']),
        assignedUserIds: JSON.stringify([9]),
      },
    });
  });

  test('returns 404 when id belongs to a different tenant (cross-tenant isolation)', async () => {
    // findFirst returns null because its where clause includes tenantId: 1,
    // even though a Territory id=777 exists in another tenant.
    prisma.territory.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1, role: 'ADMIN' }))
      .put('/api/territories/777')
      .send({ name: 'Hijack' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.territory.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.territory.update).not.toHaveBeenCalled();
  });

  test('returns 400 when :id is not a number', async () => {
    const res = await request(makeApp({ role: 'ADMIN' }))
      .put('/api/territories/not-an-int')
      .send({ name: 'Whatever' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
    expect(prisma.territory.findFirst).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — delete territory (admin-gated, detach contacts)
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /:id — delete territory + detach contacts', () => {
  test('detaches contacts THEN deletes territory (FK-safe ordering)', async () => {
    prisma.territory.findFirst.mockResolvedValue({
      id: 7, tenantId: 1, name: 'Doomed', regions: '[]', assignedUserIds: '[]',
    });

    // Order-of-calls tracking — contact.updateMany MUST be called before
    // territory.delete so the FK constraint doesn't blow up.
    const callOrder = [];
    prisma.contact.updateMany.mockImplementation(async () => {
      callOrder.push('contact.updateMany');
      return { count: 3 };
    });
    prisma.territory.delete.mockImplementation(async () => {
      callOrder.push('territory.delete');
      return { id: 7 };
    });

    const res = await request(makeApp({ tenantId: 1, role: 'ADMIN' }))
      .delete('/api/territories/7');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    // Detach happened first.
    expect(callOrder).toEqual(['contact.updateMany', 'territory.delete']);

    expect(prisma.contact.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 1, territoryId: 7 },
      data: { territoryId: null },
    });
    expect(prisma.territory.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/assign-contact — move a contact into a territory
// ─────────────────────────────────────────────────────────────────────────

describe('POST /:id/assign-contact — move contact into territory', () => {
  test('returns 400 when contactId is missing', async () => {
    prisma.territory.findFirst.mockResolvedValue({
      id: 3, tenantId: 1, name: 'T', regions: '[]', assignedUserIds: '[]',
    });

    const res = await request(makeApp({ role: 'ADMIN' }))
      .post('/api/territories/3/assign-contact')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contactId/i);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('happy path — updates Contact.territoryId, tenant-scoped on both lookups', async () => {
    prisma.territory.findFirst.mockResolvedValue({
      id: 3, tenantId: 1, name: 'T', regions: '[]', assignedUserIds: '[]',
    });
    prisma.contact.findFirst.mockResolvedValue({ id: 88, tenantId: 1 });
    prisma.contact.update.mockResolvedValue({ id: 88, territoryId: 3 });

    const res = await request(makeApp({ tenantId: 1, role: 'ADMIN' }))
      .post('/api/territories/3/assign-contact')
      .send({ contactId: 88 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      contact: { id: 88, territoryId: 3 },
    });

    // Both lookups MUST scope by tenantId — a caller cannot assign a contact
    // from another tenant into their own territory by passing the foreign id.
    expect(prisma.territory.findFirst).toHaveBeenCalledWith({
      where: { id: 3, tenantId: 1 },
    });
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: 88, tenantId: 1 },
    });
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 88 },
      data: { territoryId: 3 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id/contacts — list contacts in a territory
// ─────────────────────────────────────────────────────────────────────────

describe('GET /:id/contacts — list contacts in territory', () => {
  test('returns only the selected fields (no PHI / internal audit columns)', async () => {
    prisma.territory.findFirst.mockResolvedValue({
      id: 4, tenantId: 1, name: 'T', regions: '[]', assignedUserIds: '[]',
    });
    prisma.contact.findMany.mockResolvedValue([
      {
        id: 1, name: 'Asha Kapoor', email: 'asha@x.test', phone: '+91…',
        company: 'AcmeCo', status: 'qualified', source: 'web',
        assignedToId: 5,
      },
    ]);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/territories/4/contacts');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    // Pin the exact select set — adding or removing a field here is a
    // wire-shape change downstream consumers care about.
    expect(prisma.contact.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, territoryId: 4 },
      select: {
        id: true, name: true, email: true, phone: true, company: true,
        status: true, source: true, assignedToId: true,
      },
      orderBy: { id: 'desc' },
    });
  });
});
