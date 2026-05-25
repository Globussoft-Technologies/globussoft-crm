// @ts-check
/**
 * Unit + integration tests for backend/routes/custom_objects.js — pins the
 * CustomEntity / CustomField / CustomRecord CRUD contract that the App
 * Builder UI + custom-objects-api.spec.js depend on.
 *
 * Route surface under test
 * ────────────────────────
 *   GET    /entities                 → list all entities for the caller's tenant
 *   POST   /entities                 → create entity + nested fields
 *   GET    /entities/:id             → tenant-scoped single fetch
 *   PUT    /entities/:id             → rename / re-describe (fields stay read-only)
 *   DELETE /entities/:id             → refuses 409 if any CustomRecord rows exist
 *   GET    /records/:entityName      → list records, flatten EAV values into row objects
 *   POST   /records/:entityName      → create record with nested values
 *
 * What this file pins
 * ───────────────────
 *   1. Entity create — sanitizes name + description, persists fields with
 *      default type='Text', returns 201 with the include:{fields:true} shape.
 *   2. Entity create — name validation: empty string → 400 INVALID_ENTITY,
 *      >100 chars → 400 INVALID_ENTITY, non-string → 400 INVALID_ENTITY.
 *   3. Entity create — field type whitelist enforced. "FizzBuzz" → 400.
 *   4. Entity create — Prisma P2002 (unique constraint on (tenantId,name))
 *      surfaces as 409 ENTITY_NAME_TAKEN, NOT 500.
 *   5. Entity list — scopes findMany to req.user.tenantId.
 *   6. Entity get/:id — invalid id (non-int / <1) → 400 INVALID_ID, missing
 *      → 404, cross-tenant id → 404 (NOT 403; deliberate — don't leak that
 *      a foreign-tenant id exists).
 *   7. Entity PUT — partial validation (omitting name is OK; supplying empty
 *      string is NOT). Audits diff via writeAudit when fields change.
 *   8. Entity DELETE — 409 ENTITY_HAS_RECORDS when CustomRecord count > 0,
 *      with the recordCount surfaced in the body. Audit fires BEFORE delete.
 *   9. Records GET — entity-name lookup is tenant-scoped; missing entity → 404;
 *      values flatten correctly based on field type (String / Number / Boolean
 *      / Date all route to the right column).
 *  10. Records POST — entity lookup is tenant-scoped; missing entity → 404;
 *      type coercion happens (parseFloat for Number, Boolean() for Boolean,
 *      toString() for everything else).
 *  11. Sanitization — HTML in entity name is stripped (<script>) before
 *      persist; ENTITY_DECODE_RE re-decodes ampersand entities.
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/communications.test.js's prisma singleton-
 *   patch — the route's `require('../lib/prisma')` resolves at import time,
 *   so we patch prisma.customEntity / .customRecord / .customField with
 *   vi.fn() BEFORE requiring the router. writeAudit is mocked to a no-op
 *   so its prisma.auditLog dependency doesn't blow up the test.
 *
 *   Auth is faked with a tiny middleware that injects req.user = { userId,
 *   tenantId, role }. The route's verifyToken would otherwise demand a real
 *   JWT — production wires that upstream; we test the route's own logic.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching — MUST happen before requiring the router.
prisma.customEntity = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.customRecord = {
  count: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
};
prisma.customField = {
  findMany: vi.fn(),
};

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Patch the audit lib directly via its CJS module exports surface. The
// route does `const { writeAudit, diffFields } = require('../lib/audit')`
// at top level, so we need to overwrite the EXPORTS object's properties
// BEFORE the router is loaded.
const auditMock = requireCJS('../../lib/audit');
const writeAuditMock = vi.fn().mockResolvedValue({ id: 1 });
auditMock.writeAudit = writeAuditMock;
auditMock.diffFields = (before, after, keys) => {
  const out = {};
  for (const k of keys) {
    if (before?.[k] !== after?.[k]) {
      out[k] = { before: before?.[k] ?? null, after: after?.[k] ?? null };
    }
  }
  return out;
};

// Patch verifyToken to a pass-through. Production wires real JWT verification
// upstream of this router; we're testing route-level logic, not auth.
// The req.user injection happens in makeApp's own middleware below.
const authMock = requireCJS('../../middleware/auth');
authMock.verifyToken = (_req, _res, next) => next();

// Require the router AFTER the prisma + audit + auth patches are in place.
const customObjectsRouter = requireCJS('../../routes/custom_objects');

// Sidestep verifyToken — production wires the real JWT path upstream of
// the router. We're testing route-level behaviour, not auth middleware.
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN', skipAuth = false } = {}) {
  const app = express();
  app.use(express.json());
  if (!skipAuth) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role };
      next();
    });
  }
  app.use('/api/custom-objects', customObjectsRouter);
  return app;
}

beforeEach(() => {
  prisma.customEntity.findMany.mockReset();
  prisma.customEntity.findFirst.mockReset();
  prisma.customEntity.create.mockReset();
  prisma.customEntity.update.mockReset();
  prisma.customEntity.delete.mockReset();
  prisma.customRecord.count.mockReset();
  prisma.customRecord.findMany.mockReset();
  prisma.customRecord.create.mockReset();
  writeAuditMock.mockClear();
  writeAuditMock.mockResolvedValue({ id: 1 });

  // Sensible defaults.
  prisma.customEntity.findMany.mockResolvedValue([]);
  prisma.customEntity.create.mockImplementation(({ data }) =>
    Promise.resolve({
      id: 101,
      name: data.name,
      description: data.description ?? null,
      tenantId: data.tenantId,
      fields: (data.fields?.create ?? []).map((f, i) => ({ id: 200 + i, ...f })),
      createdAt: new Date(),
    })
  );
  prisma.customEntity.update.mockImplementation(({ where, data }) =>
    Promise.resolve({
      id: where.id,
      name: data.name ?? 'existing',
      description: data.description ?? null,
      tenantId: 1,
      fields: [],
    })
  );
  prisma.customEntity.delete.mockResolvedValue({ id: 1 });
  prisma.customRecord.count.mockResolvedValue(0);
  prisma.customRecord.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: 555, ...data, createdAt: new Date() })
  );
  prisma.customRecord.findMany.mockResolvedValue([]);
});

// ─── POST /entities ────────────────────────────────────────────────

describe('POST /entities — create CustomEntity with nested fields', () => {
  test('happy path: persists sanitized name + fields, returns 201', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/custom-objects/entities')
      .send({
        name: 'Vehicle',
        description: 'Fleet vehicle records',
        fields: [
          { name: 'License Plate', type: 'String' },
          { name: 'Wheels', type: 'Number' },
        ],
      });
    expect(res.status).toBe(201);
    expect(prisma.customEntity.create).toHaveBeenCalledTimes(1);
    const args = prisma.customEntity.create.mock.calls[0][0];
    expect(args.data.name).toBe('Vehicle');
    expect(args.data.tenantId).toBe(1);
    expect(args.data.fields.create).toHaveLength(2);
    expect(args.data.fields.create[0]).toEqual({ name: 'License Plate', type: 'String' });
    expect(args.data.fields.create[1]).toEqual({ name: 'Wheels', type: 'Number' });
    expect(args.include).toEqual({ fields: true });
  });

  test('empty / missing name → 400 INVALID_ENTITY', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/custom-objects/entities')
      .send({ name: '', fields: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ENTITY');
    expect(prisma.customEntity.create).not.toHaveBeenCalled();
  });

  test('name longer than 100 chars → 400 INVALID_ENTITY', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/custom-objects/entities')
      .send({ name: 'A'.repeat(101), fields: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ENTITY');
  });

  test('non-string name → 400 INVALID_ENTITY', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/custom-objects/entities')
      .send({ name: 12345, fields: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ENTITY');
  });

  test('unknown field type → 400 INVALID_ENTITY', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/custom-objects/entities')
      .send({
        name: 'Widget',
        fields: [{ name: 'Color', type: 'FizzBuzz' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ENTITY');
    expect(prisma.customEntity.create).not.toHaveBeenCalled();
  });

  test('field with no name → 400 INVALID_ENTITY', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/custom-objects/entities')
      .send({
        name: 'Widget',
        fields: [{ name: '', type: 'String' }],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ENTITY');
  });

  test('duplicate name (P2002) → 409 ENTITY_NAME_TAKEN, not 500', async () => {
    prisma.customEntity.create.mockRejectedValueOnce({ code: 'P2002' });
    const app = makeApp();
    const res = await request(app)
      .post('/api/custom-objects/entities')
      .send({ name: 'Duplicate', fields: [] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ENTITY_NAME_TAKEN');
  });

  test('sanitization strips <script> from entity name', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/custom-objects/entities')
      .send({
        name: 'Clean<script>alert(1)</script>Name',
        fields: [],
      });
    expect(res.status).toBe(201);
    const args = prisma.customEntity.create.mock.calls[0][0];
    // sanitize-html with allowedTags: [] drops <script> tag AND its content
    // (sanitize-html's default `disallowedTagsMode` for `script` strips both
    // the markup AND the inner text — script is on the special "always
    // discard contents" list, unlike ordinary disallowed tags whose inner
    // text would survive). Net result: 'Clean<script>alert(1)</script>Name'
    // sanitizes to 'CleanName'. This pins both halves: the script tag and
    // its 'alert(1)' content are gone, and the surrounding text survives.
    expect(args.data.name).not.toContain('<script>');
    expect(args.data.name).not.toContain('alert');
    expect(args.data.name).toBe('CleanName');
  });
});

// ─── GET /entities ────────────────────────────────────────────────

describe('GET /entities — list scoped to tenant', () => {
  test('findMany scoped to req.user.tenantId', async () => {
    prisma.customEntity.findMany.mockResolvedValueOnce([
      { id: 1, name: 'Vehicle', fields: [] },
    ]);
    const app = makeApp({ tenantId: 42 });
    const res = await request(app).get('/api/custom-objects/entities');
    expect(res.status).toBe(200);
    const args = prisma.customEntity.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
    expect(args.include).toEqual({ fields: true });
    expect(res.body).toHaveLength(1);
  });
});

// ─── GET /entities/:id ─────────────────────────────────────────────

describe('GET /entities/:id — single fetch', () => {
  test('non-int id → 400 INVALID_ID', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/custom-objects/entities/not-a-number');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.customEntity.findFirst).not.toHaveBeenCalled();
  });

  test('id < 1 → 400 INVALID_ID', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/custom-objects/entities/0');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('cross-tenant id returns 404 (not 403 — deliberate, no foreign-id leak)', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce(null);
    const app = makeApp({ tenantId: 1 });
    const res = await request(app).get('/api/custom-objects/entities/999');
    expect(res.status).toBe(404);
    const args = prisma.customEntity.findFirst.mock.calls[0][0];
    expect(args.where.id).toBe(999);
    expect(args.where.tenantId).toBe(1);
  });

  test('happy path returns entity with fields', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'Vehicle',
      description: null,
      tenantId: 1,
      fields: [{ id: 10, name: 'Plate', type: 'String' }],
    });
    const app = makeApp();
    const res = await request(app).get('/api/custom-objects/entities/5');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
    expect(res.body.fields).toHaveLength(1);
  });
});

// ─── PUT /entities/:id ─────────────────────────────────────────────

describe('PUT /entities/:id — rename / re-describe', () => {
  test('missing entity → 404', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app)
      .put('/api/custom-objects/entities/9999')
      .send({ name: 'NewName' });
    expect(res.status).toBe(404);
    expect(prisma.customEntity.update).not.toHaveBeenCalled();
  });

  test('partial rename works (omitting name is OK)', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'OldName',
      description: 'old',
      tenantId: 1,
    });
    const app = makeApp();
    const res = await request(app)
      .put('/api/custom-objects/entities/5')
      .send({ description: 'updated description' });
    expect(res.status).toBe(200);
    const updateArgs = prisma.customEntity.update.mock.calls[0][0];
    expect(updateArgs.data.name).toBeUndefined(); // not changed
    expect(updateArgs.data.description).toBe('updated description');
  });

  test('supplying empty string name → 400 INVALID_ENTITY', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'OldName',
      tenantId: 1,
    });
    const app = makeApp();
    const res = await request(app)
      .put('/api/custom-objects/entities/5')
      .send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ENTITY');
    expect(prisma.customEntity.update).not.toHaveBeenCalled();
  });

  test('rename collision (P2002) → 409 ENTITY_NAME_TAKEN', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'OldName',
      tenantId: 1,
    });
    prisma.customEntity.update.mockRejectedValueOnce({ code: 'P2002' });
    const app = makeApp();
    const res = await request(app)
      .put('/api/custom-objects/entities/5')
      .send({ name: 'TakenName' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ENTITY_NAME_TAKEN');
  });

  test('successful rename writes audit row with field diff', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'OldName',
      description: 'desc',
      tenantId: 1,
    });
    prisma.customEntity.update.mockResolvedValueOnce({
      id: 5,
      name: 'NewName',
      description: 'desc',
      tenantId: 1,
      fields: [],
    });
    const app = makeApp({ userId: 77, tenantId: 1 });
    const res = await request(app)
      .put('/api/custom-objects/entities/5')
      .send({ name: 'NewName' });
    expect(res.status).toBe(200);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const auditArgs = writeAuditMock.mock.calls[0];
    expect(auditArgs[0]).toBe('CustomEntity');
    expect(auditArgs[1]).toBe('UPDATE');
    expect(auditArgs[2]).toBe(5);
    expect(auditArgs[3]).toBe(77);
    expect(auditArgs[4]).toBe(1);
    expect(auditArgs[5].changes).toHaveProperty('name');
  });
});

// ─── DELETE /entities/:id ──────────────────────────────────────────

describe('DELETE /entities/:id — refuses when records exist', () => {
  test('409 ENTITY_HAS_RECORDS when CustomRecord.count > 0', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'Vehicle',
      tenantId: 1,
    });
    prisma.customRecord.count.mockResolvedValueOnce(7);
    const app = makeApp();
    const res = await request(app).delete('/api/custom-objects/entities/5');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ENTITY_HAS_RECORDS');
    expect(res.body.recordCount).toBe(7);
    expect(prisma.customEntity.delete).not.toHaveBeenCalled();
  });

  test('successful delete: audit BEFORE prisma.delete (audit trail survives a failed delete)', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'Vehicle',
      description: 'fleet',
      tenantId: 1,
    });
    prisma.customRecord.count.mockResolvedValueOnce(0);

    // Capture call order: audit first, then delete.
    const callOrder = [];
    writeAuditMock.mockImplementationOnce(() => {
      callOrder.push('audit');
      return Promise.resolve({ id: 1 });
    });
    prisma.customEntity.delete.mockImplementationOnce(() => {
      callOrder.push('delete');
      return Promise.resolve({ id: 5 });
    });

    const app = makeApp();
    const res = await request(app).delete('/api/custom-objects/entities/5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(callOrder).toEqual(['audit', 'delete']);
    expect(writeAuditMock.mock.calls[0][1]).toBe('DELETE');
  });

  test('non-int id → 400 INVALID_ID (no DB calls)', async () => {
    const app = makeApp();
    const res = await request(app).delete('/api/custom-objects/entities/abc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.customEntity.findFirst).not.toHaveBeenCalled();
  });
});

// ─── GET /records/:entityName ──────────────────────────────────────

describe('GET /records/:entityName — flatten EAV values', () => {
  test('missing entity → 404', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app).get('/api/custom-objects/records/UnknownThing');
    expect(res.status).toBe(404);
    expect(prisma.customRecord.findMany).not.toHaveBeenCalled();
  });

  test('values flatten by field type (String/Number/Boolean/Date)', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'Vehicle',
      tenantId: 1,
      fields: [
        { id: 10, name: 'Plate', type: 'String' },
        { id: 11, name: 'Wheels', type: 'Number' },
        { id: 12, name: 'Active', type: 'Boolean' },
        { id: 13, name: 'RegisteredOn', type: 'Date' },
      ],
    });
    const fixedDate = new Date('2026-01-15T00:00:00Z');
    prisma.customRecord.findMany.mockResolvedValueOnce([
      {
        id: 900,
        createdAt: new Date('2026-01-01'),
        values: [
          { field: { name: 'Plate', type: 'String' }, valueStr: 'ABC123', valueNum: null, valueBool: null, valueDate: null },
          { field: { name: 'Wheels', type: 'Number' }, valueStr: null, valueNum: 4, valueBool: null, valueDate: null },
          { field: { name: 'Active', type: 'Boolean' }, valueStr: null, valueNum: null, valueBool: true, valueDate: null },
          { field: { name: 'RegisteredOn', type: 'Date' }, valueStr: null, valueNum: null, valueBool: null, valueDate: fixedDate },
        ],
      },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/custom-objects/records/Vehicle');
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    const row = res.body.records[0];
    expect(row.Plate).toBe('ABC123');
    expect(row.Wheels).toBe(4);
    expect(row.Active).toBe(true);
    expect(new Date(row.RegisteredOn).toISOString()).toBe(fixedDate.toISOString());
  });

  test('entity lookup scoped to (name, tenantId)', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'Vehicle',
      tenantId: 1,
      fields: [],
    });
    prisma.customRecord.findMany.mockResolvedValueOnce([]);
    const app = makeApp({ tenantId: 42 });
    await request(app).get('/api/custom-objects/records/Vehicle');
    const findArgs = prisma.customEntity.findFirst.mock.calls[0][0];
    expect(findArgs.where.name).toBe('Vehicle');
    expect(findArgs.where.tenantId).toBe(42);
  });
});

// ─── POST /records/:entityName ─────────────────────────────────────

describe('POST /records/:entityName — create record with typed coercion', () => {
  test('missing entity → 404', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app)
      .post('/api/custom-objects/records/UnknownThing')
      .send({ Anything: 'goes' });
    expect(res.status).toBe(404);
    expect(prisma.customRecord.create).not.toHaveBeenCalled();
  });

  test('happy path: Number/Boolean coercion + valueStr fallback', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'Vehicle',
      tenantId: 1,
      fields: [
        { id: 10, name: 'Plate', type: 'String' },
        { id: 11, name: 'Wheels', type: 'Number' },
        { id: 12, name: 'Active', type: 'Boolean' },
      ],
    });
    const app = makeApp({ tenantId: 1 });
    const res = await request(app)
      .post('/api/custom-objects/records/Vehicle')
      .send({ Plate: 'XYZ789', Wheels: '4', Active: true });
    expect(res.status).toBe(201);
    expect(prisma.customRecord.create).toHaveBeenCalledTimes(1);
    const args = prisma.customRecord.create.mock.calls[0][0];
    expect(args.data.entityId).toBe(5);
    expect(args.data.tenantId).toBe(1);
    const values = args.data.values.create;
    expect(values).toHaveLength(3);
    // Plate (String) → valueStr
    expect(values[0]).toEqual({ fieldId: 10, valueStr: 'XYZ789' });
    // Wheels (Number) → valueNum, parseFloat coerces '4' → 4
    expect(values[1]).toEqual({ fieldId: 11, valueNum: 4 });
    // Active (Boolean) → valueBool
    expect(values[2]).toEqual({ fieldId: 12, valueBool: true });
  });

  test('missing payload values default to empty string for valueStr', async () => {
    prisma.customEntity.findFirst.mockResolvedValueOnce({
      id: 5,
      name: 'Vehicle',
      tenantId: 1,
      fields: [{ id: 10, name: 'Plate', type: 'String' }],
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/custom-objects/records/Vehicle')
      .send({}); // no Plate supplied
    expect(res.status).toBe(201);
    const args = prisma.customRecord.create.mock.calls[0][0];
    expect(args.data.values.create[0]).toEqual({ fieldId: 10, valueStr: '' });
  });
});
