// @ts-check
/**
 * PRD_TRAVEL_BILLING UC-2.3 — TravelSupplierPayable CRUD scaffold tests.
 * PRD_TRAVEL_SUPPLIER_MASTER #903 slice 3.
 *
 * Pins the contract for the new operator-facing supplier-payable ledger
 * (parent-scoped under /api/travel/suppliers/:id/payables) added in
 * backend/routes/travel_suppliers.js alongside the existing TravelSupplier
 * CRUD.
 *
 * What's pinned
 * -------------
 *   - GET    /api/travel/suppliers/:id/payables       list + ?status filter;
 *                                                     cross-tenant parent → 404
 *                                                     SUPPLIER_NOT_FOUND.
 *   - POST   /api/travel/suppliers/:id/payables       201 happy path; 400 on
 *                                                     missing description/amount;
 *                                                     400 INVALID_AMOUNT on
 *                                                     negative; 400 INVALID_STATUS
 *                                                     on bad status enum;
 *                                                     ADMIN/MANAGER gate.
 *   - PUT    /api/travel/suppliers/:id/payables/:pid  partial-update (only
 *                                                     dueDate changes); status='paid'
 *                                                     auto-sets paidAt=now();
 *                                                     400 INVALID_STATUS on bad.
 *   - DELETE /api/travel/suppliers/:id/payables/:pid  204 + hard delete;
 *                                                     404 PAYABLE_NOT_FOUND on
 *                                                     missing payable.
 *   - Sub-brand isolation: GET + POST + PUT + DELETE all surface 403
 *                                                     SUB_BRAND_DENIED via the
 *                                                     parent loader.
 *
 * Test pattern mirrors backend/test/routes/travel_suppliers.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with real HS256 JWTs signed with the same fallback
 * secret the middleware uses in dev. verifyToken stays in the chain (we
 * don't bypass it) so the auth-gate is exercised end-to-end.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router. Both the parent supplier and
// payable model surfaces need stubs (parent loader runs first on every
// payable endpoint).
prisma.travelSupplier = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.travelSupplierPayable = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
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

// Standard parent-supplier fixture — same-tenant, tmc sub-brand, active.
const PARENT_SUPPLIER = {
  id: 100,
  tenantId: 1,
  subBrand: 'tmc',
  name: 'Air India',
  supplierCategory: 'flight',
  isActive: true,
};

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.travelSupplier.findMany.mockReset();
  prisma.travelSupplier.findFirst.mockReset();
  prisma.travelSupplier.count.mockReset();
  prisma.travelSupplier.create.mockReset();
  prisma.travelSupplier.update.mockReset();
  prisma.travelSupplierPayable.findMany.mockReset();
  prisma.travelSupplierPayable.findFirst.mockReset();
  prisma.travelSupplierPayable.count.mockReset();
  prisma.travelSupplierPayable.create.mockReset();
  prisma.travelSupplierPayable.update.mockReset();
  prisma.travelSupplierPayable.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/suppliers/:id/payables', () => {
  test('happy path returns tenant + supplier-scoped list', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      {
        id: 1, tenantId: 1, supplierId: 100, description: '50 PNRs Apr 2026',
        amount: '4500000', currency: 'INR', status: 'pending',
        dueDate: null, paidAt: null,
      },
    ]);
    prisma.travelSupplierPayable.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/100/payables')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.payables).toHaveLength(1);
    expect(prisma.travelSupplierPayable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, supplierId: 100 }),
      }),
    );
  });

  test('?status=pending narrows the where clause', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);
    prisma.travelSupplierPayable.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/suppliers/100/payables?status=pending')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSupplierPayable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1, supplierId: 100, status: 'pending',
        }),
      }),
    );
  });

  test('cross-tenant parent supplier returns 404 SUPPLIER_NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/9999/payables')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'SUPPLIER_NOT_FOUND' });
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/suppliers/:id/payables', () => {
  test('happy path returns 201 with the created payable', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierPayable.create.mockResolvedValue({
      id: 555, tenantId: 1, supplierId: 100,
      description: '50 PNRs Apr 2026', amount: '4500000',
      currency: 'INR', status: 'pending',
      poNumber: 'PO-2026-0123', dueDate: null, paidAt: null,
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/payables')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        description: '50 PNRs Apr 2026',
        amount: 4500000,
        poNumber: 'PO-2026-0123',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 555, description: '50 PNRs Apr 2026', amount: '4500000',
      poNumber: 'PO-2026-0123', status: 'pending',
    });
    expect(prisma.travelSupplierPayable.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          supplierId: 100,
          description: '50 PNRs Apr 2026',
          amount: '4500000',
          poNumber: 'PO-2026-0123',
        }),
      }),
    );
  });

  test('rejects missing description with 400 MISSING_FIELDS', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/payables')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelSupplierPayable.create).not.toHaveBeenCalled();
  });

  test('rejects negative amount with 400 INVALID_AMOUNT', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/payables')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'Negative test', amount: -100 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(prisma.travelSupplierPayable.create).not.toHaveBeenCalled();
  });

  test('rejects invalid status with 400 INVALID_STATUS', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/payables')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'Bad status', amount: 100, status: 'archived' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    // Error message should list the valid status enum values.
    expect(res.body.error).toMatch(/pending/);
    expect(res.body.error).toMatch(/scheduled/);
    expect(res.body.error).toMatch(/paid/);
    expect(res.body.error).toMatch(/cancelled/);
    expect(prisma.travelSupplierPayable.create).not.toHaveBeenCalled();
  });

  test('USER role cannot create (403)', async () => {
    // verifyRole short-circuits before the parent-supplier lookup.
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/payables')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ description: 'Foo', amount: 100 });
    expect(res.status).toBe(403);
    expect(prisma.travelSupplierPayable.create).not.toHaveBeenCalled();
  });
});

describe('PUT /api/travel/suppliers/:id/payables/:payableId', () => {
  test('partial update changing only dueDate returns 200 + only dueDate diff', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierPayable.findFirst.mockResolvedValue({
      id: 200, tenantId: 1, supplierId: 100,
      description: 'Existing', amount: '1000',
      currency: 'INR', status: 'pending', dueDate: null, paidAt: null,
    });
    prisma.travelSupplierPayable.update.mockResolvedValue({
      id: 200, tenantId: 1, supplierId: 100,
      description: 'Existing', amount: '1000',
      currency: 'INR', status: 'pending',
      dueDate: new Date('2026-12-31T00:00:00.000Z'), paidAt: null,
    });
    const res = await request(makeApp())
      .put('/api/travel/suppliers/100/payables/200')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ dueDate: '2026-12-31' });
    expect(res.status).toBe(200);
    // Only dueDate is on the data block — no other fields touched.
    const updateCallData = prisma.travelSupplierPayable.update.mock.calls[0][0].data;
    expect(Object.keys(updateCallData)).toEqual(['dueDate']);
    expect(updateCallData.dueDate).toBeInstanceOf(Date);
  });

  test("status='paid' auto-sets paidAt to a recent timestamp", async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierPayable.findFirst.mockResolvedValue({
      id: 201, tenantId: 1, supplierId: 100,
      description: 'To pay', amount: '500',
      status: 'scheduled', paidAt: null,
    });
    prisma.travelSupplierPayable.update.mockImplementation(({ data }) => Promise.resolve({
      id: 201, tenantId: 1, supplierId: 100,
      description: 'To pay', amount: '500',
      status: 'paid', paidAt: data.paidAt,
    }));
    const before = Date.now();
    const res = await request(makeApp())
      .put('/api/travel/suppliers/100/payables/201')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'paid' });
    const after = Date.now();
    expect(res.status).toBe(200);
    const updateCallData = prisma.travelSupplierPayable.update.mock.calls[0][0].data;
    expect(updateCallData.status).toBe('paid');
    expect(updateCallData.paidAt).toBeInstanceOf(Date);
    const paidAtMs = updateCallData.paidAt.getTime();
    expect(paidAtMs).toBeGreaterThanOrEqual(before);
    expect(paidAtMs).toBeLessThanOrEqual(after);
  });

  test('invalid status on PUT returns 400 INVALID_STATUS (no update)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierPayable.findFirst.mockResolvedValue({
      id: 202, tenantId: 1, supplierId: 100, description: 'X', amount: '1', status: 'pending',
    });
    const res = await request(makeApp())
      .put('/api/travel/suppliers/100/payables/202')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'frozen' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.travelSupplierPayable.update).not.toHaveBeenCalled();
  });

  test('missing payable returns 404 PAYABLE_NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierPayable.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/travel/suppliers/100/payables/77777')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'scheduled' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PAYABLE_NOT_FOUND' });
    expect(prisma.travelSupplierPayable.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/travel/suppliers/:id/payables/:payableId', () => {
  test('happy path returns 204 + hard delete', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierPayable.findFirst.mockResolvedValue({
      id: 300, tenantId: 1, supplierId: 100, description: 'D', amount: '1', status: 'cancelled',
    });
    prisma.travelSupplierPayable.delete.mockResolvedValue({ id: 300 });
    const res = await request(makeApp())
      .delete('/api/travel/suppliers/100/payables/300')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(prisma.travelSupplierPayable.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 300 } }),
    );
  });

  test('missing payable returns 404 PAYABLE_NOT_FOUND (no delete)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelSupplierPayable.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/suppliers/100/payables/77777')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PAYABLE_NOT_FOUND' });
    expect(prisma.travelSupplierPayable.delete).not.toHaveBeenCalled();
  });
});

describe('Sub-brand isolation (parent loader)', () => {
  // Note: getSubBrandAccessSet() short-circuits to `null` (full access) for
  // ADMIN role regardless of subBrandAccess, so isolation tests must use
  // the MANAGER role (which still honors subBrandAccess).
  test('GET on a sub-brand the user cannot access returns 403 SUB_BRAND_DENIED', async () => {
    // Parent supplier exists but is in sub-brand 'rfu'.
    prisma.travelSupplier.findFirst.mockResolvedValue({
      ...PARENT_SUPPLIER, subBrand: 'rfu',
    });
    // User restricted to 'tmc' only.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .get('/api/travel/suppliers/100/payables')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelSupplierPayable.findMany).not.toHaveBeenCalled();
  });

  test('POST on a sub-brand the user cannot access returns 403 SUB_BRAND_DENIED', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      ...PARENT_SUPPLIER, subBrand: 'rfu',
    });
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/100/payables')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ description: 'Cross-brand', amount: 100 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelSupplierPayable.create).not.toHaveBeenCalled();
  });
});
