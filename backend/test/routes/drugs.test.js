// @ts-check
/**
 * Unit tests for backend/routes/drugs.js — pin the contract of the wellness
 * drug-catalog CRUD + typeahead surface.
 *
 * Why this file exists
 * ────────────────────
 * routes/drugs.js (170 LOC) backs the prescription writer's drug typeahead
 * (used while a doctor authors a Prescription). It owns tenant-scoped
 * Drug-model CRUD, a `?q=` substring search across name + genericName,
 * a dosage-form enum guard, and role gating that gives doctors READ access
 * but reserves WRITE for admin/manager (operational catalog management,
 * not clinical authorship). Silent drift on any of these would either
 * pollute the typeahead with stale rows (read-side) or let any doctor
 * mutate the catalog mid-prescription (write-side). Pin the wire shape now.
 *
 * Endpoints under test
 * ────────────────────
 *   1. GET    /         — list with optional q + isActive + limit
 *   2. GET    /:id      — fetch one (tenant-scoped via findFirst)
 *   3. POST   /         — create with name required + dosageForm enum
 *   4. PUT    /:id      — partial update + cross-tenant 404
 *   5. DELETE /:id      — 204 No Content
 *
 * Cases (15 total)
 * ────────────────
 *   list: tenant-scoped findMany with default limit 50 + asc order (1)
 *   list: ?q=para → OR clause on name + genericName, ?isActive=true filter,
 *         ?limit capped at 200 (3)
 *   get: 400 invalid id; 404 cross-tenant (findFirst returns null);
 *        200 returns the drug (3)
 *   create: 400 NAME_REQUIRED on missing/empty/whitespace name;
 *           400 INVALID_DOSAGE_FORM on disallowed enum value;
 *           201 with defaults (dosageForm=tablet, isActive=true, tenantId
 *           from JWT) (3)
 *   update: 400 invalid id; 404 cross-tenant;
 *           400 INVALID_DOSAGE_FORM when supplied form rejected (3)
 *   delete: 404 cross-tenant; 204 No Content on success (2)
 *
 * Role gating
 * ───────────
 * doctor wellnessRole hits READ endpoints (list + get) successfully but
 * gets 403 WELLNESS_ROLE_FORBIDDEN on POST/PUT/DELETE. Covered inline in
 * the create + delete cases via role=USER + wellnessRole='doctor'.
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/wellness-patient-timeline.test.js — synthetic
 * auth middleware injects req.user with `vertical: 'wellness'` so the
 * verifyWellnessRole middleware short-circuits the tenant.findUnique
 * lookup (memoised on req.user.vertical, see middleware/wellnessRole.js:56).
 * Prisma singleton is monkey-patched BEFORE the router is required so the
 * route binds to the spy'd functions.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── Prisma singleton patching (BEFORE requiring the router) ───────────
const prisma = requireCJS('../../lib/prisma');

prisma.drug = prisma.drug || {};
prisma.drug.findMany = vi.fn();
prisma.drug.findFirst = vi.fn();
prisma.drug.create = vi.fn();
prisma.drug.update = vi.fn();
prisma.drug.delete = vi.fn();

// audit write target — writeAudit ultimately hits auditLog.create.
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// tenant.findUnique is called by verifyWellnessRole when req.user.vertical
// is missing; we inject vertical on req.user so this shouldn't fire, but
// stub defensively so a missed injection doesn't blow up.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });

// eventBus stubs — writeAudit triggers a best-effort emit downstream.
const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
if (eventBus.safeEmitEvent) eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);

import express from 'express';
import request from 'supertest';

const drugsRouter = requireCJS('../../routes/drugs');

/**
 * Build an express app with a synthetic auth middleware. Defaults to
 * ADMIN on a wellness tenant so the route admits write operations.
 * Override { role, wellnessRole } to exercise role-gating denial paths.
 */
function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole,
  vertical = 'wellness',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole, vertical };
    next();
  });
  app.use('/api/wellness/drugs', drugsRouter);
  return app;
}

beforeEach(() => {
  prisma.drug.findMany.mockReset();
  prisma.drug.findFirst.mockReset();
  prisma.drug.create.mockReset();
  prisma.drug.update.mockReset();
  prisma.drug.delete.mockReset();
  prisma.auditLog.create.mockClear();

  // Sensible defaults — individual tests override.
  prisma.drug.findMany.mockResolvedValue([]);
  prisma.drug.findFirst.mockResolvedValue(null);
  prisma.drug.create.mockResolvedValue({ id: 1 });
  prisma.drug.update.mockResolvedValue({ id: 1 });
  prisma.drug.delete.mockResolvedValue({ id: 1 });
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — list drugs
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list drugs', () => {
  test('200 with tenant-scoped findMany, default limit 50, asc order on name', async () => {
    prisma.drug.findMany.mockResolvedValue([
      { id: 1, name: 'Acetaminophen', genericName: 'Paracetamol', dosageForm: 'tablet' },
      { id: 2, name: 'Ibuprofen', genericName: null, dosageForm: 'tablet' },
    ]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/wellness/drugs');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(prisma.drug.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42 },
      orderBy: [{ name: 'asc' }],
      take: 50,
    });
  });

  test('200 with ?q=para → OR clause on name + genericName', async () => {
    prisma.drug.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/wellness/drugs?q=para');

    expect(res.status).toBe(200);
    const callArg = prisma.drug.findMany.mock.calls[0][0];
    expect(callArg.where.tenantId).toBe(42);
    expect(callArg.where.OR).toEqual([
      { name: { contains: 'para' } },
      { genericName: { contains: 'para' } },
    ]);
  });

  test('200 with ?isActive=true narrows the where clause', async () => {
    prisma.drug.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 })).get(
      '/api/wellness/drugs?isActive=true',
    );

    expect(res.status).toBe(200);
    const callArg = prisma.drug.findMany.mock.calls[0][0];
    expect(callArg.where.isActive).toBe(true);
  });

  test('200 with ?limit=500 caps at 200 (route enforces ceiling)', async () => {
    prisma.drug.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 })).get(
      '/api/wellness/drugs?limit=500',
    );

    expect(res.status).toBe(200);
    expect(prisma.drug.findMany.mock.calls[0][0].take).toBe(200);
  });

  test('200 for doctor wellnessRole (read gate admits doctor)', async () => {
    prisma.drug.findMany.mockResolvedValue([]);

    const res = await request(
      makeApp({ tenantId: 1, role: 'USER', wellnessRole: 'doctor' }),
    ).get('/api/wellness/drugs');

    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /?fields=summary — slim-shape opt-in (#920 slice 49)
// ─────────────────────────────────────────────────────────────────────────
//
// Mirrors slices 1-48: the typeahead callers (prescription writer) only need
// the lookup-shape columns (id, name, genericName, dosageForm, strength). The
// heavy free-text `notes` column (@db.Text — admin-only contraindications /
// scheduling info) plus timestamps + tenantId chrome are server-side noise
// for the typeahead. `?fields=summary` opts into a Prisma `select` that drops
// them; the default (unspecified fields) keeps the full row for the admin
// catalogue list page.

describe('GET /?fields=summary — slim-shape opt-in', () => {
  test('passes a slim `select` projection to findMany when fields=summary', async () => {
    prisma.drug.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 })).get(
      '/api/wellness/drugs?fields=summary',
    );

    expect(res.status).toBe(200);
    const callArg = prisma.drug.findMany.mock.calls[0][0];
    expect(callArg.select).toEqual({
      id: true,
      name: true,
      genericName: true,
      dosageForm: true,
      strengthValue: true,
      strengthUnit: true,
      isActive: true,
    });
  });

  test('slim select OMITS the heavy `notes` column (@db.Text)', async () => {
    prisma.drug.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 1 })).get(
      '/api/wellness/drugs?fields=summary',
    );

    const callArg = prisma.drug.findMany.mock.calls[0][0];
    expect(callArg.select.notes).toBeUndefined();
    // timestamps + tenantId chrome also dropped from the slim shape
    expect(callArg.select.createdAt).toBeUndefined();
    expect(callArg.select.updatedAt).toBeUndefined();
    expect(callArg.select.tenantId).toBeUndefined();
    // default dosage hint columns are also omitted (typeahead doesn't render them)
    expect(callArg.select.defaultDosage).toBeUndefined();
    expect(callArg.select.defaultFrequency).toBeUndefined();
    expect(callArg.select.defaultDuration).toBeUndefined();
  });

  test('default (no ?fields) returns the full row — no `select` clause sent', async () => {
    prisma.drug.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 1 })).get('/api/wellness/drugs');

    const callArg = prisma.drug.findMany.mock.calls[0][0];
    expect(callArg.select).toBeUndefined();
  });

  test('unknown ?fields value (anything not "summary") falls back to full shape', async () => {
    prisma.drug.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 1 })).get(
      '/api/wellness/drugs?fields=bogus',
    );

    const callArg = prisma.drug.findMany.mock.calls[0][0];
    expect(callArg.select).toBeUndefined();
  });

  test('slim mode composes with ?q= + ?isActive= + ?limit= filters', async () => {
    prisma.drug.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 42 })).get(
      '/api/wellness/drugs?fields=summary&q=para&isActive=true&limit=10',
    );

    expect(res.status).toBe(200);
    const callArg = prisma.drug.findMany.mock.calls[0][0];
    // composes correctly with the other query-string features
    expect(callArg.where.tenantId).toBe(42);
    expect(callArg.where.isActive).toBe(true);
    expect(callArg.where.OR).toEqual([
      { name: { contains: 'para' } },
      { genericName: { contains: 'para' } },
    ]);
    expect(callArg.take).toBe(10);
    // and the slim select still applies
    expect(callArg.select).toBeDefined();
    expect(callArg.select.id).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id — fetch one
// ─────────────────────────────────────────────────────────────────────────

describe('GET /:id — fetch one drug', () => {
  test('400 when :id is not an integer', async () => {
    const res = await request(makeApp()).get('/api/wellness/drugs/not-an-int');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
    expect(prisma.drug.findFirst).not.toHaveBeenCalled();
  });

  test('404 when drug belongs to a different tenant (findFirst returns null)', async () => {
    prisma.drug.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/wellness/drugs/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.drug.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
  });

  test('200 returns the drug payload (tenant-scoped)', async () => {
    prisma.drug.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, name: 'Acetaminophen', genericName: 'Paracetamol',
      dosageForm: 'tablet', isActive: true,
    });

    const res = await request(makeApp({ tenantId: 1 })).get('/api/wellness/drugs/50');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(50);
    expect(res.body.name).toBe('Acetaminophen');
    expect(prisma.drug.findFirst).toHaveBeenCalledWith({
      where: { id: 50, tenantId: 1 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — create
// ─────────────────────────────────────────────────────────────────────────

describe('POST / — create drug', () => {
  test('400 NAME_REQUIRED when name missing', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/drugs')
      .send({ dosageForm: 'tablet' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NAME_REQUIRED');
    expect(prisma.drug.create).not.toHaveBeenCalled();
  });

  test('400 NAME_REQUIRED when name is whitespace-only', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/drugs')
      .send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NAME_REQUIRED');
    expect(prisma.drug.create).not.toHaveBeenCalled();
  });

  test('400 INVALID_DOSAGE_FORM when dosageForm is not in the allowed enum', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/drugs')
      .send({ name: 'Paracetamol', dosageForm: 'lozenge' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DOSAGE_FORM');
    expect(res.body.error).toMatch(/dosageForm must be one of/i);
    expect(prisma.drug.create).not.toHaveBeenCalled();
  });

  test('201 with defaults: dosageForm=tablet, isActive=true, tenantId from JWT, name trimmed', async () => {
    prisma.drug.create.mockResolvedValue({
      id: 99,
      name: 'Paracetamol',
      genericName: null,
      dosageForm: 'tablet',
      isActive: true,
      tenantId: 42,
    });

    const res = await request(makeApp({ tenantId: 42, userId: 7 }))
      .post('/api/wellness/drugs')
      .send({ name: '  Paracetamol  ' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(99);
    const createArg = prisma.drug.create.mock.calls[0][0].data;
    expect(createArg.name).toBe('Paracetamol');     // trimmed
    expect(createArg.dosageForm).toBe('tablet');    // default
    expect(createArg.isActive).toBe(true);          // default
    expect(createArg.tenantId).toBe(42);            // from JWT
    expect(createArg.genericName).toBeNull();
  });

  test('403 WELLNESS_ROLE_FORBIDDEN when doctor attempts write (write gate excludes doctor)', async () => {
    const res = await request(
      makeApp({ tenantId: 1, role: 'USER', wellnessRole: 'doctor' }),
    )
      .post('/api/wellness/drugs')
      .send({ name: 'Paracetamol' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    expect(prisma.drug.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id — update
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /:id — update drug', () => {
  test('400 when :id is not an integer', async () => {
    const res = await request(makeApp())
      .put('/api/wellness/drugs/not-an-int')
      .send({ name: 'Renamed' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id/i);
    expect(prisma.drug.update).not.toHaveBeenCalled();
  });

  test('404 when drug belongs to a different tenant', async () => {
    prisma.drug.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/wellness/drugs/777')
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect(prisma.drug.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.drug.update).not.toHaveBeenCalled();
  });

  test('400 INVALID_DOSAGE_FORM when patched dosageForm not in enum', async () => {
    prisma.drug.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, name: 'Paracetamol', dosageForm: 'tablet',
    });

    const res = await request(makeApp())
      .put('/api/wellness/drugs/50')
      .send({ dosageForm: 'powder' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DOSAGE_FORM');
    expect(prisma.drug.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — delete
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /:id — delete drug', () => {
  test('404 when drug belongs to a different tenant', async () => {
    prisma.drug.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).delete(
      '/api/wellness/drugs/777',
    );

    expect(res.status).toBe(404);
    expect(prisma.drug.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.drug.delete).not.toHaveBeenCalled();
  });

  test('204 No Content on successful delete (no response body)', async () => {
    prisma.drug.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, name: 'Paracetamol',
    });
    prisma.drug.delete.mockResolvedValue({ id: 50 });

    const res = await request(makeApp({ tenantId: 1 })).delete(
      '/api/wellness/drugs/50',
    );

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(prisma.drug.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });
});
