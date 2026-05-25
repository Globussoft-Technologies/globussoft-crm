// @ts-check
/**
 * PRD_TRAVEL_SUPPLIER_MASTER DD-5.1 — TravelSupplier CRUD scaffold tests.
 *
 * Pins the contract for the new operator-facing supplier master surface
 * added to backend/routes/travel_suppliers.js (which already hosts the
 * SupplierCredential vault — TravelSupplier is a separate model + a
 * separate concern; the file co-hosts both because the routes share the
 * /api/travel mount and the convention is one routes/<resource>.js per
 * Prisma model family).
 *
 * What's pinned
 * -------------
 *   - POST   /api/travel/suppliers       201 on happy path; 400 on missing
 *           name; 400 on invalid supplierCategory; ADMIN/MANAGER gate.
 *   - GET    /api/travel/suppliers       tenant-scoped list; honors
 *           ?subBrand + default isActive=true filter.
 *   - GET    /api/travel/suppliers/:id   404 on cross-tenant; 200 same-tenant.
 *   - DELETE /api/travel/suppliers/:id   204 + isActive=false soft-delete.
 *
 * Test pattern mirrors backend/test/routes/audit-viewer.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with real HS256 JWTs signed with the same fallback
 * secret the middleware uses in dev. verifyToken stays in the chain (we
 * don't bypass it) so the auth-gate is exercised end-to-end.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelSupplier = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelSuppliersRouter = requireCJS('../../routes/travel_suppliers');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelSuppliersRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.travelSupplier.findMany.mockReset();
  prisma.travelSupplier.findFirst.mockReset();
  prisma.travelSupplier.count.mockReset();
  prisma.travelSupplier.create.mockReset();
  prisma.travelSupplier.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/suppliers', () => {
  test('happy path returns 201 with the created supplier', async () => {
    prisma.travelSupplier.create.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', name: 'Acme Hotels', supplierCategory: 'hotel',
      isActive: true, contactPerson: null, phone: null, email: null,
      gstin: null, addressLine: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'Acme Hotels',
        subBrand: 'tmc',
        supplierCategory: 'hotel',
        gstin: '07AAAAA0000A1Z5',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 42, name: 'Acme Hotels', supplierCategory: 'hotel', subBrand: 'tmc', isActive: true,
    });
    // Verify tenantId came from req.user, not body.
    expect(prisma.travelSupplier.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          name: 'Acme Hotels',
          subBrand: 'tmc',
          supplierCategory: 'hotel',
          isActive: true,
        }),
      }),
    );
  });

  test('rejects missing name with 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'tmc', supplierCategory: 'hotel' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(res.body.error).toMatch(/name/i);
    expect(prisma.travelSupplier.create).not.toHaveBeenCalled();
  });

  test('rejects invalid supplierCategory with 400 + allowed values', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Foo', subBrand: 'tmc', supplierCategory: 'cruise' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUPPLIER_CATEGORY' });
    expect(res.body.error).toMatch(/hotel/);
    expect(res.body.error).toMatch(/flight/);
    expect(res.body.error).toMatch(/transport/);
    expect(res.body.error).toMatch(/visa-consul/);
    expect(res.body.error).toMatch(/other/);
    expect(prisma.travelSupplier.create).not.toHaveBeenCalled();
  });

  test('USER role cannot create (403)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ name: 'Foo', subBrand: 'tmc' });
    expect(res.status).toBe(403);
    expect(prisma.travelSupplier.create).not.toHaveBeenCalled();
  });
});

// PRD_TRAVEL_SUPPLIER_MASTER slice 1 (#903) — payment terms + credit + GSTIN.
//
// Pins:
//   - GSTIN format validation (15-char Indian regex; 400 INVALID_GSTIN on bad).
//   - paymentTermsDays: non-negative int (400 INVALID_PAYMENT_TERMS on negative).
//   - creditLimit:      non-negative number  (400 INVALID_CREDIT_LIMIT on negative).
//   - PUT update path accepts the new fields with same validation gates.
describe('POST /api/travel/suppliers — slice 1 (#903) payment + credit + GSTIN', () => {
  test('valid GSTIN persists through to prisma.create data', async () => {
    prisma.travelSupplier.create.mockResolvedValue({
      id: 50, tenantId: 1, subBrand: 'tmc', name: 'GST Holder', supplierCategory: 'hotel',
      isActive: true, gstin: '27ABCDE1234F1Z5',
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'GST Holder', subBrand: 'tmc', gstin: '27ABCDE1234F1Z5' });
    expect(res.status).toBe(201);
    expect(prisma.travelSupplier.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ gstin: '27ABCDE1234F1Z5' }),
      }),
    );
  });

  test('invalid GSTIN format returns 400 INVALID_GSTIN (no create call)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Bad GSTIN Co', subBrand: 'tmc', gstin: 'NOT-A-VALID-GSTIN' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_GSTIN' });
    expect(prisma.travelSupplier.create).not.toHaveBeenCalled();
  });

  test('lowercase GSTIN is rejected as INVALID_GSTIN (regex is case-strict)', async () => {
    // GSTIN canonical form is upper-case only; lower-case is invalid in slice 1.
    // (Future slices may auto-uppercase — explicitly NOT in scope here.)
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'lcase Co', subBrand: 'tmc', gstin: '27abcde1234f1z5' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_GSTIN' });
    expect(prisma.travelSupplier.create).not.toHaveBeenCalled();
  });

  test('paymentTermsDays=30 persists to prisma.create as int', async () => {
    prisma.travelSupplier.create.mockResolvedValue({
      id: 51, tenantId: 1, subBrand: 'tmc', name: 'NET30 Co',
      supplierCategory: 'other', isActive: true, paymentTermsDays: 30,
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'NET30 Co', subBrand: 'tmc', paymentTermsDays: 30 });
    expect(res.status).toBe(201);
    expect(prisma.travelSupplier.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentTermsDays: 30 }),
      }),
    );
  });

  test('negative paymentTermsDays returns 400 INVALID_PAYMENT_TERMS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'BadTerms Co', subBrand: 'tmc', paymentTermsDays: -5 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYMENT_TERMS' });
    expect(prisma.travelSupplier.create).not.toHaveBeenCalled();
  });

  test('creditLimit=50000 persists to prisma.create as Decimal-stringable', async () => {
    prisma.travelSupplier.create.mockResolvedValue({
      id: 52, tenantId: 1, subBrand: 'tmc', name: 'Credit Co',
      supplierCategory: 'other', isActive: true, creditLimit: '50000',
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Credit Co', subBrand: 'tmc', creditLimit: 50000 });
    expect(res.status).toBe(201);
    expect(prisma.travelSupplier.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ creditLimit: '50000' }),
      }),
    );
  });

  test('negative creditLimit returns 400 INVALID_CREDIT_LIMIT', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'BadCredit Co', subBrand: 'tmc', creditLimit: -1 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CREDIT_LIMIT' });
    expect(prisma.travelSupplier.create).not.toHaveBeenCalled();
  });
});

describe('PUT /api/travel/suppliers/:id — slice 1 (#903) update validation', () => {
  // The router uses PUT (not PATCH) for partial updates — sibling agents
  // and downstream consumers already mounted against PUT. Slice 1 validation
  // applies to the SAME update path.
  test('adding paymentTermsDays updates the row (200)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 60, tenantId: 1, subBrand: 'tmc', name: 'PutTest', isActive: true,
    });
    prisma.travelSupplier.update.mockResolvedValue({
      id: 60, tenantId: 1, subBrand: 'tmc', name: 'PutTest', isActive: true,
      paymentTermsDays: 45,
    });
    const res = await request(makeApp())
      .put('/api/travel/suppliers/60')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ paymentTermsDays: 45 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 60, paymentTermsDays: 45 });
    expect(prisma.travelSupplier.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 60 },
        data: expect.objectContaining({ paymentTermsDays: 45 }),
      }),
    );
  });

  test('invalid GSTIN on PUT returns 400 INVALID_GSTIN (no update call)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 61, tenantId: 1, subBrand: 'tmc', name: 'PutGstin', isActive: true,
    });
    const res = await request(makeApp())
      .put('/api/travel/suppliers/61')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ gstin: 'BAD-FORMAT' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_GSTIN' });
    expect(prisma.travelSupplier.update).not.toHaveBeenCalled();
  });
});

describe('GET /api/travel/suppliers', () => {
  test('returns tenant-scoped list with default isActive=true filter', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 1, name: 'Acme', subBrand: 'tmc', supplierCategory: 'hotel', isActive: true, tenantId: 1 },
    ]);
    prisma.travelSupplier.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.suppliers).toHaveLength(1);
    // The where clause MUST include tenantId from req.user.tenantId + isActive=true default.
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, isActive: true }),
      }),
    );
  });

  test('?subBrand filter narrows the where clause', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    prisma.travelSupplier.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/suppliers?subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, subBrand: 'rfu', isActive: true }),
      }),
    );
  });

  test('?includeInactive=1 drops the isActive filter', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([]);
    prisma.travelSupplier.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/suppliers?includeInactive=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const calledWhere = prisma.travelSupplier.findMany.mock.calls[0][0].where;
    expect(calledWhere.tenantId).toBe(1);
    expect(calledWhere.isActive).toBeUndefined();
  });
});

describe('GET /api/travel/suppliers/:id', () => {
  test('cross-tenant returns 404', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    // Confirm the lookup scoped to req.user.tenantId.
    expect(prisma.travelSupplier.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9999, tenantId: 1 }),
      }),
    );
  });

  test('same-tenant returns 200 with row', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, subBrand: 'tmc', name: 'Acme', supplierCategory: 'hotel', isActive: true,
    });
    const res = await request(makeApp())
      .get('/api/travel/suppliers/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, name: 'Acme' });
  });
});

describe('DELETE /api/travel/suppliers/:id (soft-delete)', () => {
  test('returns 204 and sets isActive=false', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, subBrand: 'tmc', name: 'Acme', isActive: true,
    });
    prisma.travelSupplier.update.mockResolvedValue({
      id: 5, tenantId: 1, subBrand: 'tmc', name: 'Acme', isActive: false,
    });
    const res = await request(makeApp())
      .delete('/api/travel/suppliers/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(204);
    // Body MUST be empty for 204.
    expect(res.body).toEqual({});
    // Confirm the update call's data block flips isActive=false (no hard delete).
    expect(prisma.travelSupplier.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5 },
        data: { isActive: false },
      }),
    );
  });

  test('cross-tenant returns 404 (no update call)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/suppliers/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(prisma.travelSupplier.update).not.toHaveBeenCalled();
  });
});
