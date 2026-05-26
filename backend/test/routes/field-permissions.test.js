// @ts-check
/**
 * Unit + integration tests for backend/routes/field_permissions.js — pins
 * the per-tenant FieldPermission CRUD surface that backs the Settings →
 * Field Permissions matrix UI + the routes/deals.js / routes/contacts.js
 * filterReadFields / filterWriteFields runtime gates.
 *
 * Issue context
 * ─────────────
 *   PRD Gap §1.3 — the FieldPermission table was extended with an `action`
 *          column (READ | WRITE | DELETE | EXPORT) so the matrix UI can
 *          express the full module × action × role topology a clinic
 *          operator cares about. The legacy bucket is action='WRITE'
 *          (preserves existing canRead / canWrite semantics).
 *
 *   #464 — every write to a rule must call clearFieldFilterCache() so the
 *          in-process fieldFilter cache (30s TTL) doesn't keep stripping
 *          fields based on the stale rule for half a minute. The 5
 *          write endpoints (POST /, POST /bulk-update, PUT /:id, DELETE
 *          /:id) all invoke the helper. The test patches the
 *          middleware/fieldFilter module's clearCache export with vi.fn
 *          via the CJS self-mocking seam so we can assert call shape.
 *
 *   #574 (CRIT-10) — admin-only across the board. Tests use a real
 *          JWT (signed with the test-process JWT_SECRET fallback) carrying
 *          role: 'ADMIN' so verifyToken + verifyRole(['ADMIN']) both pass.
 *          Mirrors routes/pipelines.js post-#527.
 *
 *   #550 — DELETE handlers consistently return 204 No Content (was a mix
 *          of 200 + {message} before). Pinned in the DELETE describe block.
 *
 * What this file pins
 * ───────────────────
 *   1. GET /entities returns the supported entity → fields registry, with
 *      both generic (Deal, Contact, Invoice, Quote) and wellness-vertical
 *      (Patient, Visit, Prescription, ConsentForm, Staff, Settings, Audit,
 *      Reports) modules present. The wellness modules carry only the
 *      synthetic '*' field today (module-level — the matrix UI renders
 *      just the action row for these).
 *   2. GET /actions returns SUPPORTED_ACTIONS + SUPPORTED_ROLES — the
 *      registry the matrix UI consumes to enumerate axis labels.
 *   3. GET /effective resolves field-by-field permissions for (role,
 *      entity, action), defaulting missing rules to { canRead:true,
 *      canWrite:true } (default-allow). Action defaults to 'WRITE' when
 *      the caller doesn't pass one (back-compat with pre-action callers).
 *   4. GET /effective rejects unknown role / unsupported entity /
 *      invalid action with 400.
 *   5. GET /matrix returns the full module × role × action topology with
 *      default-allow gaps filled in. Only field='*' rules contribute
 *      (per-field rules are surfaced separately via GET / and GET
 *      /effective).
 *   6. GET / lists all tenant-scoped rules grouped by entity.
 *   7. POST / upserts a single rule and clears the fieldFilter cache.
 *   8. POST / rejects missing role/entity/field with 400; rejects an
 *      unsupported entity / field-not-in-entity / invalid action / unknown
 *      role with 400. These are the input-validation contracts the matrix
 *      UI relies on.
 *   9. POST / accepts both wellness-vertical lowercase roles ('doctor',
 *      'telecaller') and RBAC uppercase roles ('ADMIN', 'MANAGER',
 *      'USER') via normalizeRole — case-tolerant lookup is required
 *      because the matrix UI sometimes posts back the displayed label.
 *  10. POST /bulk-update upserts an array of rules, surfacing per-row
 *      validation errors in `errors[]` without aborting the whole batch.
 *      The response shape is { updated, errors, rules } so the matrix UI
 *      can do partial-success rendering.
 *  11. PUT /:id updates an existing rule's canRead/canWrite (tenant-
 *      scoped lookup → 404 if cross-tenant). DELETE /:id deletes the
 *      row and returns 204 No Content (#550). Both clear the
 *      fieldFilter cache.
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/ai-scoring.test.js — prisma singleton
 *   patch + real JWT bearer signed with the same JWT_SECRET that
 *   verifyToken uses + CJS self-mocking seam on middleware/fieldFilter to
 *   replace clearCache with a vi.fn() so we can assert it gets called on
 *   every write (#464 regression bait). vi.mock against the CJS
 *   `require('../middleware/auth')` does NOT reliably intercept in this
 *   repo's vitest config (verified — same caveat documented in
 *   test/integration/stripe-webhook.test.js); the real-JWT path is the
 *   canonical workaround.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patching ─────────────────────────────────────
// Must happen BEFORE the router is required, since the router's
// top-level `require('../lib/prisma')` resolves at import time.
prisma.fieldPermission = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  upsert: vi.fn(),
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

// CJS self-mocking seam: the route does `require('../middleware/fieldFilter')`
// at module load. Node CJS caches modules by resolved path — so the require
// inside the route returns the SAME object identity as our require here. We
// mutate that object's exported fn in place with vi.fn() so we can assert
// "cache invalidated on every write" (#464). See cron-learnings 2026-05-24
// ~01:43 UTC for the canonical pattern.
const fieldFilterModule = requireCJS('../../middleware/fieldFilter');
const clearFieldFilterCacheMock = vi.fn();
fieldFilterModule.clearCache = clearFieldFilterCacheMock;

const fpRouter = requireCJS('../../routes/field_permissions');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/field-permissions', fpRouter);
  return app;
}

beforeEach(() => {
  prisma.fieldPermission.findMany.mockReset();
  prisma.fieldPermission.findFirst.mockReset();
  prisma.fieldPermission.upsert.mockReset();
  prisma.fieldPermission.update.mockReset();
  prisma.fieldPermission.delete.mockReset();
  clearFieldFilterCacheMock.mockReset();
});

// ── GET /entities — registry of supported entities + fields ─────────

describe('GET /entities — registry', () => {
  test('returns generic + wellness modules with their field lists', async () => {
    const res = await request(makeApp())
      .get('/api/field-permissions/entities')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(200);
    // Generic modules carry per-field arrays
    expect(res.body.Deal).toEqual(expect.arrayContaining(['title', 'amount', 'stage', 'ownerId']));
    expect(res.body.Contact).toEqual(expect.arrayContaining(['name', 'email', 'phone']));
    expect(res.body.Invoice).toEqual(expect.arrayContaining(['amount', 'status', 'dueDate']));
    // Wellness modules carry only the synthetic '*' marker (module-level)
    expect(res.body.Patient).toEqual(['*']);
    expect(res.body.Visit).toEqual(['*']);
    expect(res.body.Prescription).toEqual(['*']);
    expect(res.body.ConsentForm).toEqual(['*']);
    expect(res.body.Staff).toEqual(['*']);
    expect(res.body.Settings).toEqual(['*']);
    expect(res.body.Audit).toEqual(['*']);
    expect(res.body.Reports).toEqual(['*']);
  });
});

// ── GET /actions — SUPPORTED_ACTIONS + SUPPORTED_ROLES registry ─────

describe('GET /actions — registry', () => {
  test('returns the four supported actions + all eight roles', async () => {
    const res = await request(makeApp())
      .get('/api/field-permissions/actions')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual(['READ', 'WRITE', 'DELETE', 'EXPORT']);
    // 3 RBAC + 5 wellness sub-roles = 8 total.
    expect(res.body.roles).toEqual(expect.arrayContaining([
      'ADMIN', 'MANAGER', 'USER',
      'doctor', 'professional', 'telecaller', 'helper', 'stylist',
    ]));
  });
});

// ── GET /effective — per-field resolution with default-allow gaps ───

describe('GET /effective — per-field resolution', () => {
  test('returns default-allow for fields with no rule', async () => {
    prisma.fieldPermission.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/field-permissions/effective?role=USER&entity=Deal')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(200);
    // No rules → every Deal field defaults to { canRead:true, canWrite:true }
    expect(res.body.title).toEqual({ canRead: true, canWrite: true });
    expect(res.body.amount).toEqual({ canRead: true, canWrite: true });
    expect(res.body.stage).toEqual({ canRead: true, canWrite: true });
    // Action defaulted to 'WRITE' — verify the prisma query reflects that
    expect(prisma.fieldPermission.findMany).toHaveBeenCalledWith({
      where: { role: 'USER', entity: 'Deal', action: 'WRITE', tenantId: 1 },
    });
  });

  test('returns the persisted rule for matched fields, defaults for unmatched', async () => {
    prisma.fieldPermission.findMany.mockResolvedValue([
      { field: 'amount', canRead: true, canWrite: false },
    ]);
    const res = await request(makeApp())
      .get('/api/field-permissions/effective?role=USER&entity=Deal')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(200);
    expect(res.body.amount).toEqual({ canRead: true, canWrite: false });
    // Unmatched field still defaults to full access
    expect(res.body.title).toEqual({ canRead: true, canWrite: true });
  });

  test('rejects unknown role with 400', async () => {
    const res = await request(makeApp())
      .get('/api/field-permissions/effective?role=GOD&entity=Deal')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid role/);
  });

  test('rejects unsupported entity with 400', async () => {
    const res = await request(makeApp())
      .get('/api/field-permissions/effective?role=USER&entity=Unicorn')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported entity/);
  });

  test('rejects invalid action with 400', async () => {
    const res = await request(makeApp())
      .get('/api/field-permissions/effective?role=USER&entity=Deal&action=PURGE')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid action/);
  });
});

// ── GET /matrix — module × role × action topology ───────────────────

describe('GET /matrix — full topology', () => {
  test('returns module × role × action with default-allow gaps', async () => {
    prisma.fieldPermission.findMany.mockResolvedValue([
      // Single rule denying USER role from DELETEing Patients
      { entity: 'Patient', role: 'USER', action: 'DELETE', field: '*', canRead: true, canWrite: false },
    ]);
    const res = await request(makeApp())
      .get('/api/field-permissions/matrix')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(200);

    // Persisted rule surfaces verbatim
    expect(res.body.Patient.USER.DELETE).toEqual({ canRead: true, canWrite: false });
    // Default-allow gaps fill the rest
    expect(res.body.Patient.USER.READ).toEqual({ canRead: true, canWrite: true });
    expect(res.body.Patient.ADMIN.DELETE).toEqual({ canRead: true, canWrite: true });
    expect(res.body.Deal.USER.WRITE).toEqual({ canRead: true, canWrite: true });

    // Tenant-scoped + field=* filter on the query
    expect(prisma.fieldPermission.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, field: '*' },
    });
  });
});

// ── GET / — list rules grouped by entity ────────────────────────────

describe('GET / — list rules grouped', () => {
  test('groups rules by entity in the response shape the UI consumes', async () => {
    prisma.fieldPermission.findMany.mockResolvedValue([
      { id: 1, entity: 'Deal',    role: 'USER',    field: 'amount', canRead: true,  canWrite: false },
      { id: 2, entity: 'Deal',    role: 'MANAGER', field: 'amount', canRead: true,  canWrite: true  },
      { id: 3, entity: 'Contact', role: 'USER',    field: 'phone',  canRead: false, canWrite: false },
    ]);
    const res = await request(makeApp())
      .get('/api/field-permissions')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(200);
    expect(res.body.Deal).toHaveLength(2);
    expect(res.body.Contact).toHaveLength(1);
    expect(res.body.Deal[0]).toEqual({ id: 1, role: 'USER', field: 'amount', canRead: true, canWrite: false });
    // Tenant-scoped query
    expect(prisma.fieldPermission.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 1 },
    }));
  });
});

// ── POST / — upsert a single rule ───────────────────────────────────

describe('POST / — upsert', () => {
  test('upserts a rule, clears the fieldFilter cache, returns 201', async () => {
    prisma.fieldPermission.upsert.mockResolvedValue({
      id: 9, role: 'USER', entity: 'Deal', field: 'amount', action: 'WRITE',
      canRead: true, canWrite: false, tenantId: 1,
    });
    const res = await request(makeApp())
      .post('/api/field-permissions')
      .set('Authorization', makeBearer())
      .send({ role: 'USER', entity: 'Deal', field: 'amount', canRead: true, canWrite: false });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(9);
    expect(prisma.fieldPermission.upsert).toHaveBeenCalledTimes(1);
    // #464 — cache MUST be invalidated on every write
    expect(clearFieldFilterCacheMock).toHaveBeenCalledTimes(1);

    const args = prisma.fieldPermission.upsert.mock.calls[0][0];
    expect(args.where.role_entity_field_action_tenantId).toEqual({
      role: 'USER', entity: 'Deal', field: 'amount', action: 'WRITE', tenantId: 1,
    });
  });

  test('accepts both lowercase wellness roles and uppercase RBAC roles', async () => {
    prisma.fieldPermission.upsert.mockResolvedValue({
      id: 10, role: 'doctor', entity: 'Patient', field: '*', action: 'WRITE',
      canRead: true, canWrite: true, tenantId: 1,
    });

    // Lowercase wellness sub-role — normalizeRole keeps it lowercase
    const res = await request(makeApp())
      .post('/api/field-permissions')
      .set('Authorization', makeBearer())
      .send({ role: 'doctor', entity: 'Patient', field: '*', canRead: true, canWrite: true });
    expect(res.status).toBe(201);

    const args = prisma.fieldPermission.upsert.mock.calls[0][0];
    expect(args.where.role_entity_field_action_tenantId.role).toBe('doctor');
  });

  test('rejects missing required fields with 400', async () => {
    const res = await request(makeApp())
      .post('/api/field-permissions')
      .set('Authorization', makeBearer())
      .send({ role: 'USER', entity: 'Deal' }); // missing field
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
    expect(prisma.fieldPermission.upsert).not.toHaveBeenCalled();
    expect(clearFieldFilterCacheMock).not.toHaveBeenCalled();
  });

  test('POST rejects unsupported entity with 400', async () => {
    const res = await request(makeApp())
      .post('/api/field-permissions')
      .set('Authorization', makeBearer())
      .send({ role: 'USER', entity: 'Unicorn', field: 'horn', canRead: true, canWrite: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported entity/);
  });

  test('rejects a field not in the entity registry with 400', async () => {
    const res = await request(makeApp())
      .post('/api/field-permissions')
      .set('Authorization', makeBearer())
      .send({ role: 'USER', entity: 'Deal', field: 'unicornHorn', canRead: true, canWrite: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported on Deal/);
  });

  test('rejects an invalid action with 400', async () => {
    const res = await request(makeApp())
      .post('/api/field-permissions')
      .set('Authorization', makeBearer())
      .send({ role: 'USER', entity: 'Deal', field: 'amount', action: 'PURGE', canRead: true, canWrite: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid action/);
  });

  test('POST rejects an unknown role with 400', async () => {
    const res = await request(makeApp())
      .post('/api/field-permissions')
      .set('Authorization', makeBearer())
      .send({ role: 'GOD', entity: 'Deal', field: 'amount', canRead: true, canWrite: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid role/);
  });
});

// ── POST /bulk-update — multi-row upsert with per-row error surfacing ──

describe('POST /bulk-update — multi-row upsert', () => {
  test('upserts each valid row, returns { updated, errors, rules } shape', async () => {
    prisma.fieldPermission.upsert
      .mockResolvedValueOnce({ id: 1, role: 'USER', entity: 'Deal', field: 'amount', action: 'WRITE', canRead: true, canWrite: false, tenantId: 1 })
      .mockResolvedValueOnce({ id: 2, role: 'USER', entity: 'Deal', field: 'title',  action: 'WRITE', canRead: true, canWrite: true,  tenantId: 1 });

    const res = await request(makeApp())
      .post('/api/field-permissions/bulk-update')
      .set('Authorization', makeBearer())
      .send({ rules: [
        { role: 'USER', entity: 'Deal', field: 'amount', canRead: true, canWrite: false },
        { role: 'USER', entity: 'Deal', field: 'title',  canRead: true, canWrite: true  },
      ] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(res.body.errors).toEqual([]);
    expect(res.body.rules).toHaveLength(2);
    // #464 — cache cleared once after the batch (not per-row)
    expect(clearFieldFilterCacheMock).toHaveBeenCalledTimes(1);
  });

  test('surfaces per-row invalid rows in errors[] but processes the valid ones', async () => {
    prisma.fieldPermission.upsert.mockResolvedValue({
      id: 5, role: 'USER', entity: 'Deal', field: 'amount', action: 'WRITE',
      canRead: true, canWrite: false, tenantId: 1,
    });

    const res = await request(makeApp())
      .post('/api/field-permissions/bulk-update')
      .set('Authorization', makeBearer())
      .send({ rules: [
        { role: 'USER',  entity: 'Deal', field: 'amount',     canRead: true, canWrite: false }, // valid
        { role: 'GOD',   entity: 'Deal', field: 'amount',     canRead: true, canWrite: false }, // bad role
        { role: 'USER',  entity: 'Deal', field: 'unicornHorn',canRead: true, canWrite: false }, // bad field
        { role: 'USER',  entity: 'Unicorn', field: 'amount',  canRead: true, canWrite: false }, // bad entity
      ] });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.errors).toHaveLength(3);
    // Each error row carries enough context for the matrix UI to highlight
    // the bad cell
    expect(res.body.errors[0]).toEqual(expect.objectContaining({
      role: 'GOD', entity: 'Deal', field: 'amount',
    }));
  });

  test('rejects non-array body with 400', async () => {
    const res = await request(makeApp())
      .post('/api/field-permissions/bulk-update')
      .set('Authorization', makeBearer())
      .send({ rules: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rules array is required/);
  });
});

// ── PUT /:id — update an existing rule ──────────────────────────────

describe('PUT /:id — update', () => {
  test('updates canRead/canWrite, clears cache, returns the row', async () => {
    prisma.fieldPermission.findFirst.mockResolvedValue({
      id: 9, role: 'USER', entity: 'Deal', field: 'amount', action: 'WRITE',
      canRead: true, canWrite: true, tenantId: 1,
    });
    prisma.fieldPermission.update.mockResolvedValue({
      id: 9, role: 'USER', entity: 'Deal', field: 'amount', action: 'WRITE',
      canRead: true, canWrite: false, tenantId: 1,
    });

    const res = await request(makeApp())
      .put('/api/field-permissions/9')
      .set('Authorization', makeBearer())
      .send({ canWrite: false });

    expect(res.status).toBe(200);
    expect(res.body.canWrite).toBe(false);
    expect(prisma.fieldPermission.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { canWrite: false },
    });
    expect(clearFieldFilterCacheMock).toHaveBeenCalledTimes(1);
  });

  test('returns 400 on a non-numeric id', async () => {
    const res = await request(makeApp())
      .put('/api/field-permissions/abc')
      .set('Authorization', makeBearer())
      .send({ canRead: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid id/);
  });

  test('PUT cross-tenant id returns 404', async () => {
    prisma.fieldPermission.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/field-permissions/9999')
      .set('Authorization', makeBearer())
      .send({ canRead: false });
    expect(res.status).toBe(404);
    expect(prisma.fieldPermission.update).not.toHaveBeenCalled();
    expect(clearFieldFilterCacheMock).not.toHaveBeenCalled();
  });
});

// ── DELETE /:id — remove a rule, return 204 (#550) ──────────────────

describe('DELETE /:id — delete', () => {
  test('deletes the row, clears cache, returns 204 No Content (#550)', async () => {
    prisma.fieldPermission.findFirst.mockResolvedValue({
      id: 9, role: 'USER', entity: 'Deal', field: 'amount', action: 'WRITE',
      canRead: true, canWrite: false, tenantId: 1,
    });
    prisma.fieldPermission.delete.mockResolvedValue({ id: 9 });

    const res = await request(makeApp())
      .delete('/api/field-permissions/9')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(204);
    // 204 No Content: the body MUST be empty
    expect(res.body).toEqual({});
    expect(prisma.fieldPermission.delete).toHaveBeenCalledWith({ where: { id: 9 } });
    expect(clearFieldFilterCacheMock).toHaveBeenCalledTimes(1);
  });

  test('DELETE cross-tenant id returns 404', async () => {
    prisma.fieldPermission.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/field-permissions/9999')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(404);
    expect(prisma.fieldPermission.delete).not.toHaveBeenCalled();
    expect(clearFieldFilterCacheMock).not.toHaveBeenCalled();
  });
});
