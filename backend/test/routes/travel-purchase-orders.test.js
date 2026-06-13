// PRD_TRAVEL_SUPPLIER_MASTER FR-3.2 (G035/G036/G037) — TravelPurchaseOrder
// CRUD + state machine + line items + auto-payable creation.
//
// Pins the contract for backend/routes/travel_purchase_orders.js. Test pattern
// mirrors backend/test/routes/travel-supplier-payables.test.js — patch the
// prisma singleton with vi.fn() shapes BEFORE requiring the router, then
// drive supertest with real HS256 JWTs signed with the same fallback
// secret the middleware uses in dev. verifyToken stays in the chain so the
// auth gate is exercised end-to-end.
//
// What's pinned
// -------------
//   GET    /purchase-orders                                  list + ?supplierId, ?bookingId, ?status filter
//   POST   /purchase-orders                                  201 happy, missing field 400, ADMIN/MANAGER gate
//   GET    /purchase-orders/:id                              detail (lines + supplier)
//   PUT    /purchase-orders/:id                              draft-only edit, 409 on non-draft
//   POST   /purchase-orders/:id/lines                        line add + total recompute
//   PUT    /purchase-orders/:id/lines/:lineId                line edit
//   DELETE /purchase-orders/:id/lines/:lineId                line delete
//   POST   /purchase-orders/:id/send                         draft → sent
//   POST   /purchase-orders/:id/acknowledge                  sent → acknowledged
//   POST   /purchase-orders/:id/fulfill                      acknowledged → fulfilled + auto-payable
//   POST   /purchase-orders/:id/cancel                       requires cancelReason
//   State-machine: rejects invalid transitions with 409 INVALID_STATUS_TRANSITION

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Stubs installed BEFORE requiring the router.
prisma.travelPurchaseOrder = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelPurchaseOrderLine = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
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
  subBrandConfigJson: null,
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

// $transaction stub: invoke callback with the same `prisma` so the
// route's tx-bound writes hit the same vi.fn() spies the assertions read.
prisma.$transaction = vi.fn(async (cb) => {
  if (typeof cb === 'function') return cb(prisma);
  return Promise.all(cb);
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const purchaseOrdersRouter = requireCJS('../../routes/travel_purchase_orders');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', purchaseOrdersRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const PARENT_SUPPLIER = {
  id: 100,
  tenantId: 1,
  subBrand: 'tmc',
  name: 'Air India',
  supplierCategory: 'flight',
  contactPerson: 'A. Receivables',
  phone: '+91 22 22796666',
  email: 'agents@airindia.in',
  gstin: '27AAACR4849R1ZW',
  addressLine: 'Airlines House',
  paymentTermsDays: 30,
};

function poFixture(overrides = {}) {
  return {
    id: 17,
    tenantId: 1,
    supplierId: 100,
    bookingId: null,
    poNumber: 'TPO-2026-0001',
    status: 'draft',
    currency: 'INR',
    subtotal: '0.00',
    taxAmount: '0.00',
    totalAmount: '0.00',
    notes: null,
    sentAt: null,
    acknowledgedAt: null,
    fulfilledAt: null,
    cancelledAt: null,
    cancelReason: null,
    createdBy: 7,
    createdAt: new Date('2026-06-12T10:00:00Z'),
    updatedAt: new Date('2026-06-12T10:00:00Z'),
    supplier: PARENT_SUPPLIER,
    ...overrides,
  };
}

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.travelPurchaseOrder.findMany.mockReset();
  prisma.travelPurchaseOrder.findFirst.mockReset();
  prisma.travelPurchaseOrder.count.mockReset();
  prisma.travelPurchaseOrder.create.mockReset();
  prisma.travelPurchaseOrder.update.mockReset();
  prisma.travelPurchaseOrder.delete.mockReset();
  prisma.travelPurchaseOrderLine.findMany.mockReset();
  prisma.travelPurchaseOrderLine.findFirst.mockReset();
  prisma.travelPurchaseOrderLine.count.mockReset().mockResolvedValue(0);
  prisma.travelPurchaseOrderLine.create.mockReset();
  prisma.travelPurchaseOrderLine.update.mockReset();
  prisma.travelPurchaseOrderLine.delete.mockReset();
  prisma.travelSupplier.findFirst.mockReset();
  prisma.travelSupplierPayable.create.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel', subBrandConfigJson: null,
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  // Provide a default findMany for line aggregator (recomputePoTotals).
  prisma.travelPurchaseOrderLine.findMany.mockResolvedValue([]);
  prisma.travelPurchaseOrder.update.mockResolvedValue(poFixture());
});

// ────────────────────────────────────────────────────────────────────
// GET /purchase-orders
// ────────────────────────────────────────────────────────────────────

describe('GET /api/travel/purchase-orders', () => {
  test('happy path returns tenant-scoped list', async () => {
    prisma.travelPurchaseOrder.findMany.mockResolvedValue([poFixture()]);
    prisma.travelPurchaseOrder.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/purchase-orders')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.purchaseOrders).toHaveLength(1);
    expect(prisma.travelPurchaseOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 1 }) }),
    );
  });

  test('?supplierId narrows where clause', async () => {
    prisma.travelPurchaseOrder.findMany.mockResolvedValue([]);
    prisma.travelPurchaseOrder.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/purchase-orders?supplierId=100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelPurchaseOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, supplierId: 100 }),
      }),
    );
  });

  test('?status filter narrows where clause', async () => {
    prisma.travelPurchaseOrder.findMany.mockResolvedValue([]);
    prisma.travelPurchaseOrder.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/purchase-orders?status=sent')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelPurchaseOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'sent' }),
      }),
    );
  });

  test('?status with invalid value returns 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/purchase-orders?status=archived')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
  });

  test('?bookingId narrows where clause', async () => {
    prisma.travelPurchaseOrder.findMany.mockResolvedValue([]);
    prisma.travelPurchaseOrder.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/purchase-orders?bookingId=42')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelPurchaseOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bookingId: 42 }),
      }),
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /purchase-orders
// ────────────────────────────────────────────────────────────────────

describe('POST /api/travel/purchase-orders', () => {
  test('happy path returns 201 with the created PO', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    // nextPoNumber's internal $transaction → tx.count then format.
    prisma.travelPurchaseOrder.count.mockResolvedValue(0);
    prisma.travelPurchaseOrder.create.mockResolvedValue(poFixture({ poNumber: 'TPO-2026-0001' }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ supplierId: 100, currency: 'INR', notes: 'New PO' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 17,
      poNumber: 'TPO-2026-0001',
      status: 'draft',
      supplierId: 100,
    });
    expect(prisma.travelPurchaseOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          supplierId: 100,
          status: 'draft',
          poNumber: expect.stringMatching(/^TPO-\d{4}-\d{4}$/),
        }),
      }),
    );
  });

  test('rejects missing supplierId with 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ currency: 'INR' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelPurchaseOrder.create).not.toHaveBeenCalled();
  });

  test('cross-tenant supplier returns 404 SUPPLIER_NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ supplierId: 9999 });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'SUPPLIER_NOT_FOUND' });
    expect(prisma.travelPurchaseOrder.create).not.toHaveBeenCalled();
  });

  test('USER role cannot create (403)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ supplierId: 100 });
    expect(res.status).toBe(403);
    expect(prisma.travelPurchaseOrder.create).not.toHaveBeenCalled();
  });

  test('PO number follows TPO-YYYY-NNNN format', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(PARENT_SUPPLIER);
    prisma.travelPurchaseOrder.count.mockResolvedValue(41);
    prisma.travelPurchaseOrder.create.mockResolvedValue(poFixture());
    await request(makeApp())
      .post('/api/travel/purchase-orders')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ supplierId: 100 });
    const created = prisma.travelPurchaseOrder.create.mock.calls[0][0].data;
    expect(created.poNumber).toMatch(/^TPO-\d{4}-0042$/);
  });
});

// ────────────────────────────────────────────────────────────────────
// GET /purchase-orders/:id
// ────────────────────────────────────────────────────────────────────

describe('GET /api/travel/purchase-orders/:id', () => {
  test('happy path returns PO + lines + supplier', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue({
      ...poFixture(),
      lines: [{ id: 1, lineType: 'service', description: 'Ticket', lineTotal: '1000' }],
    });
    const res = await request(makeApp())
      .get('/api/travel/purchase-orders/17')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 17, poNumber: 'TPO-2026-0001' });
    expect(res.body.lines).toHaveLength(1);
  });

  test('missing id returns 404 PO_NOT_FOUND', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/purchase-orders/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PO_NOT_FOUND' });
  });

  test('cross-sub-brand caller returns 403 SUB_BRAND_DENIED', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({
      supplier: { ...PARENT_SUPPLIER, subBrand: 'rfu' },
    }));
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: JSON.stringify(['tmc']) });
    const res = await request(makeApp())
      .get('/api/travel/purchase-orders/17')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
  });
});

// ────────────────────────────────────────────────────────────────────
// PUT /purchase-orders/:id
// ────────────────────────────────────────────────────────────────────

describe('PUT /api/travel/purchase-orders/:id', () => {
  test('draft → partial update succeeds', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    prisma.travelPurchaseOrder.update.mockResolvedValue(poFixture({ notes: 'Updated' }));
    const res = await request(makeApp())
      .put('/api/travel/purchase-orders/17')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ notes: 'Updated' });
    expect(res.status).toBe(200);
    const updateData = prisma.travelPurchaseOrder.update.mock.calls[0][0].data;
    expect(updateData.notes).toBe('Updated');
  });

  test('non-draft PO returns 409 INVALID_STATUS_TRANSITION', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'sent' }));
    const res = await request(makeApp())
      .put('/api/travel/purchase-orders/17')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ notes: 'Late edit' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
      from: 'sent',
    });
  });

  test('empty body returns 400 EMPTY_BODY', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    const res = await request(makeApp())
      .put('/api/travel/purchase-orders/17')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
  });
});

// ────────────────────────────────────────────────────────────────────
// Line items CRUD
// ────────────────────────────────────────────────────────────────────

describe('POST /api/travel/purchase-orders/:id/lines', () => {
  test('happy path creates line + recomputes totals', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    prisma.travelPurchaseOrderLine.create.mockResolvedValue({
      id: 1, lineType: 'service', description: 'Hotel', quantity: '2.00',
      unitPrice: '5000.00', lineTotal: '10000.00',
    });
    prisma.travelPurchaseOrderLine.findMany.mockResolvedValue([
      { lineType: 'service', lineTotal: '10000.00' },
    ]);
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ lineType: 'service', description: 'Hotel', quantity: 2, unitPrice: 5000 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 1, lineTotal: '10000.00' });
    const data = prisma.travelPurchaseOrderLine.create.mock.calls[0][0].data;
    expect(data.lineTotal).toBe('10000.00');
  });

  test('discount line negates the line total', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    prisma.travelPurchaseOrderLine.create.mockResolvedValue({
      id: 5, lineType: 'discount', lineTotal: '-500.00',
    });
    prisma.travelPurchaseOrderLine.findMany.mockResolvedValue([]);
    await request(makeApp())
      .post('/api/travel/purchase-orders/17/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ lineType: 'discount', description: 'Volume', quantity: 1, unitPrice: 500 });
    const data = prisma.travelPurchaseOrderLine.create.mock.calls[0][0].data;
    expect(data.lineTotal).toBe('-500.00');
  });

  test('rejects invalid lineType with 400 INVALID_LINE_TYPE', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ lineType: 'bogus', description: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_LINE_TYPE' });
  });

  test('rejects missing description with 400 MISSING_FIELDS', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ lineType: 'service', quantity: 1, unitPrice: 100 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });

  test('lines on fulfilled PO returns 409', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'fulfilled' }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ lineType: 'service', description: 'x', quantity: 1, unitPrice: 100 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
  });
});

describe('PUT /api/travel/purchase-orders/:id/lines/:lineId', () => {
  test('happy path updates line', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    prisma.travelPurchaseOrderLine.findFirst.mockResolvedValue({
      id: 1, purchaseOrderId: 17, lineType: 'service', quantity: '1', unitPrice: '100', lineTotal: '100',
    });
    prisma.travelPurchaseOrderLine.update.mockResolvedValue({
      id: 1, lineType: 'service', quantity: '5.00', unitPrice: '100.00', lineTotal: '500.00',
    });
    prisma.travelPurchaseOrderLine.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .put('/api/travel/purchase-orders/17/lines/1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quantity: 5 });
    expect(res.status).toBe(200);
    const data = prisma.travelPurchaseOrderLine.update.mock.calls[0][0].data;
    expect(data.lineTotal).toBe('500.00');
  });

  test('missing line returns 404 LINE_NOT_FOUND', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    prisma.travelPurchaseOrderLine.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/travel/purchase-orders/17/lines/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'X' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'LINE_NOT_FOUND' });
  });
});

describe('DELETE /api/travel/purchase-orders/:id/lines/:lineId', () => {
  test('happy path returns 204', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    prisma.travelPurchaseOrderLine.findFirst.mockResolvedValue({ id: 1, purchaseOrderId: 17 });
    prisma.travelPurchaseOrderLine.delete.mockResolvedValue({ id: 1 });
    prisma.travelPurchaseOrderLine.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .delete('/api/travel/purchase-orders/17/lines/1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(204);
  });
});

// ────────────────────────────────────────────────────────────────────
// State machine transitions
// ────────────────────────────────────────────────────────────────────

describe('POST /api/travel/purchase-orders/:id/send', () => {
  test('draft → sent succeeds + sets sentAt', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    prisma.travelPurchaseOrder.update.mockResolvedValue(poFixture({
      status: 'sent', sentAt: new Date(),
    }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/send')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const data = prisma.travelPurchaseOrder.update.mock.calls[0][0].data;
    expect(data.status).toBe('sent');
    expect(data.sentAt).toBeInstanceOf(Date);
  });

  test('sent → sent returns 409', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'sent' }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/send')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
      from: 'sent',
      to: 'sent',
    });
  });

  test('fulfilled → sent returns 409 with empty allowed', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'fulfilled' }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/send')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body.allowed).toEqual([]);
  });
});

describe('POST /api/travel/purchase-orders/:id/acknowledge', () => {
  test('sent → acknowledged succeeds', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'sent' }));
    prisma.travelPurchaseOrder.update.mockResolvedValue(poFixture({ status: 'acknowledged' }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/acknowledge')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const data = prisma.travelPurchaseOrder.update.mock.calls[0][0].data;
    expect(data.status).toBe('acknowledged');
    expect(data.acknowledgedAt).toBeInstanceOf(Date);
  });

  test('draft → acknowledged returns 409 (skip-stage)', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/acknowledge')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(409);
  });
});

describe('POST /api/travel/purchase-orders/:id/fulfill', () => {
  test('acknowledged → fulfilled + auto-creates payables for service lines', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({
      status: 'acknowledged',
      lines: [
        { id: 1, lineType: 'service', description: 'Ticket', lineTotal: '5000', pnr: 'AB12' },
        { id: 2, lineType: 'tax', description: 'GST 18%', lineTotal: '900' },
        { id: 3, lineType: 'service', description: 'Hotel', lineTotal: '8000' },
      ],
    }));
    prisma.travelPurchaseOrder.update.mockResolvedValue(poFixture({
      status: 'fulfilled', fulfilledAt: new Date(),
    }));
    prisma.travelSupplierPayable.create
      .mockResolvedValueOnce({ id: 901, purchaseOrderId: 17 })
      .mockResolvedValueOnce({ id: 902, purchaseOrderId: 17 });
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/fulfill')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      payablesCreated: 2,
    });
    // Only the 2 service lines should yield payables — tax line does NOT.
    expect(prisma.travelSupplierPayable.create).toHaveBeenCalledTimes(2);
    const firstPayable = prisma.travelSupplierPayable.create.mock.calls[0][0].data;
    expect(firstPayable.purchaseOrderId).toBe(17);
    expect(firstPayable.poNumber).toBe('TPO-2026-0001');
    expect(firstPayable.status).toBe('pending');
  });

  test('draft → fulfilled returns 409 (skip-stage)', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/fulfill')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(prisma.travelSupplierPayable.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/purchase-orders/:id/cancel', () => {
  test('draft → cancelled with reason succeeds', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    prisma.travelPurchaseOrder.update.mockResolvedValue(poFixture({
      status: 'cancelled', cancelReason: 'Operator error',
    }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/cancel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ cancelReason: 'Operator error' });
    expect(res.status).toBe(200);
    const data = prisma.travelPurchaseOrder.update.mock.calls[0][0].data;
    expect(data.status).toBe('cancelled');
    expect(data.cancelReason).toBe('Operator error');
    expect(data.cancelledAt).toBeInstanceOf(Date);
  });

  test('missing cancelReason returns 400 MISSING_FIELDS', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'draft' }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/cancel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelPurchaseOrder.update).not.toHaveBeenCalled();
  });

  test('fulfilled PO cannot be cancelled', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({ status: 'fulfilled' }));
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/cancel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ cancelReason: 'Late' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
      from: 'fulfilled',
    });
  });

  test('USER cannot cancel (ADMIN-only)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/cancel')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ cancelReason: 'unauthorized' });
    expect(res.status).toBe(403);
  });

  test('MANAGER cannot cancel (ADMIN-only)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/cancel')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ cancelReason: 'unauthorized' });
    expect(res.status).toBe(403);
  });
});

// ────────────────────────────────────────────────────────────────────
// PDF render
// ────────────────────────────────────────────────────────────────────

describe('GET /api/travel/purchase-orders/:id/pdf', () => {
  test('happy path returns PDF buffer', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue({
      ...poFixture({ status: 'sent' }),
      lines: [{ id: 1, lineType: 'service', description: 'Hotel', quantity: '1', unitPrice: '5000', lineTotal: '5000' }],
    });
    const res = await request(makeApp())
      .get('/api/travel/purchase-orders/17/pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/TPO-2026-0001\.pdf/);
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('USER cannot download (ADMIN/MANAGER only)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/purchase-orders/17/pdf')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
  });
});

// ────────────────────────────────────────────────────────────────────
// Sub-brand isolation (parent loader)
// ────────────────────────────────────────────────────────────────────

describe('Sub-brand isolation', () => {
  test('PATCH against cross-sub-brand PO returns 403 SUB_BRAND_DENIED', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({
      supplier: { ...PARENT_SUPPLIER, subBrand: 'rfu' },
    }));
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: JSON.stringify(['tmc']) });
    const res = await request(makeApp())
      .put('/api/travel/purchase-orders/17')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ notes: 'cross-brand' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
  });

  test('POST send against cross-sub-brand PO returns 403 SUB_BRAND_DENIED', async () => {
    prisma.travelPurchaseOrder.findFirst.mockResolvedValue(poFixture({
      status: 'draft',
      supplier: { ...PARENT_SUPPLIER, subBrand: 'rfu' },
    }));
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: JSON.stringify(['tmc']) });
    const res = await request(makeApp())
      .post('/api/travel/purchase-orders/17/send')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
  });
});
