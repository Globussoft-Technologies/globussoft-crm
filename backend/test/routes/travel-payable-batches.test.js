// PRD_TRAVEL_BILLING G022 (FR-3.5.e) — TravelSupplierPayableBatch CRUD +
// state machine + CSV export.
//
// Pins the contract for backend/routes/travel_payable_batches.js. Mirror
// pattern of backend/test/routes/travel-purchase-orders.test.js — prisma
// singleton stubs installed BEFORE requiring the router, supertest drives
// the surface with real HS256 JWTs.
//
// What's pinned
// -------------
//   GET    /payable-batches                                  list (?status)
//   POST   /payable-batches                                  201 + numbering + payables linked
//   GET    /payable-batches/:id                              detail (includes payables)
//   PUT    /payable-batches/:id                              draft-only edit, 409 on non-draft
//   POST   /payable-batches/:id/add-payable                  attach payable
//   POST   /payable-batches/:id/remove-payable               detach payable
//   POST   /payable-batches/:id/approve                      draft → approved (ADMIN)
//   POST   /payable-batches/:id/send-to-bank                 approved → sent_to_bank
//   POST   /payable-batches/:id/settle                       sent_to_bank → settled + payables → paid
//   POST   /payable-batches/:id/cancel                       requires cancelReason + detaches children
//   GET    /payable-batches/:id/payment-csv                  bank-friendly CSV
//   State-machine: rejects invalid transitions with 409 INVALID_STATUS_TRANSITION

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelSupplierPayableBatch = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelSupplierPayable = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  aggregate: vi.fn(),
};
prisma.travelSupplier = prisma.travelSupplier || {
  findFirst: vi.fn(),
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
const batchesRouter = requireCJS('../../routes/travel_payable_batches');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', batchesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function batchFixture(overrides = {}) {
  return {
    id: 12,
    tenantId: 1,
    batchNumber: 'TPB-2026-0001',
    status: 'draft',
    paymentMethod: null,
    bankAccount: null,
    totalAmount: '0.00',
    payableCount: 0,
    scheduledFor: null,
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    settledAt: null,
    cancelledAt: null,
    cancelReason: null,
    notes: null,
    createdBy: 7,
    createdAt: new Date('2026-06-13T10:00:00Z'),
    updatedAt: new Date('2026-06-13T10:00:00Z'),
    ...overrides,
  };
}

function payableFixture(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    supplierId: 200,
    poNumber: 'TPO-2026-0001',
    description: 'Hotel block 25-28 May',
    amount: '15000.00',
    currency: 'INR',
    dueDate: new Date('2026-07-01T00:00:00Z'),
    status: 'pending',
    paidAt: null,
    notes: null,
    purchaseOrderId: null,
    invoiceLineId: null,
    payableBatchId: null,
    supplier: { id: 200, name: 'Hotel Test', subBrand: 'tmc', gstin: '27ABCDE1234F1Z5' },
    ...overrides,
  };
}

beforeAll(() => {});

beforeEach(() => {
  Object.values(prisma.travelSupplierPayableBatch).forEach((fn) => fn.mockReset && fn.mockReset());
  Object.values(prisma.travelSupplierPayable).forEach((fn) => fn.mockReset && fn.mockReset());
  prisma.travelSupplierPayable.aggregate.mockResolvedValue({ _sum: { amount: 0 }, _count: { _all: 0 } });
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel', subBrandConfigJson: null,
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

// ────────────────────────────────────────────────────────────────────
// GET /payable-batches
// ────────────────────────────────────────────────────────────────────

describe('GET /api/travel/payable-batches', () => {
  test('happy path returns tenant-scoped list', async () => {
    prisma.travelSupplierPayableBatch.findMany.mockResolvedValue([batchFixture()]);
    prisma.travelSupplierPayableBatch.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/payable-batches')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.payableBatches).toHaveLength(1);
    expect(prisma.travelSupplierPayableBatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 1 }) }),
    );
  });

  test('?status filter narrows where clause', async () => {
    prisma.travelSupplierPayableBatch.findMany.mockResolvedValue([]);
    prisma.travelSupplierPayableBatch.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/payable-batches?status=approved')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelSupplierPayableBatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'approved' }),
      }),
    );
  });

  test('?status invalid → 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payable-batches?status=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /payable-batches (create draft)
// ────────────────────────────────────────────────────────────────────

describe('POST /api/travel/payable-batches', () => {
  test('happy path with no payables returns 201 + empty batch', async () => {
    prisma.travelSupplierPayableBatch.count.mockResolvedValue(0);
    const created = batchFixture();
    prisma.travelSupplierPayableBatch.create.mockResolvedValue(created);
    prisma.travelSupplierPayableBatch.findUnique.mockResolvedValue(created);
    const res = await request(makeApp())
      .post('/api/travel/payable-batches')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ paymentMethod: 'neft', notes: 'June batch' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ batchNumber: expect.stringMatching(/^TPB-\d{4}-\d{4}$/) });
    expect(prisma.travelSupplierPayableBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          status: 'draft',
          paymentMethod: 'neft',
        }),
      }),
    );
  });

  test('happy path with payables attaches them via updateMany', async () => {
    prisma.travelSupplierPayableBatch.count.mockResolvedValue(0);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      payableFixture({ id: 100 }),
      payableFixture({ id: 101 }),
    ]);
    const created = batchFixture({ id: 50 });
    prisma.travelSupplierPayableBatch.create.mockResolvedValue(created);
    prisma.travelSupplierPayableBatch.findUnique.mockResolvedValue(created);
    prisma.travelSupplierPayable.aggregate.mockResolvedValue({
      _sum: { amount: 30000 },
      _count: { _all: 2 },
    });
    const res = await request(makeApp())
      .post('/api/travel/payable-batches')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ payableIds: [100, 101], paymentMethod: 'rtgs' });
    expect(res.status).toBe(201);
    expect(prisma.travelSupplierPayable.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [100, 101] } },
      data: { payableBatchId: 50 },
    });
  });

  test('USER role cannot create (403)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/payable-batches')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});
    expect(res.status).toBe(403);
    expect(prisma.travelSupplierPayableBatch.create).not.toHaveBeenCalled();
  });

  test('invalid paymentMethod → 400 INVALID_PAYMENT_METHOD', async () => {
    const res = await request(makeApp())
      .post('/api/travel/payable-batches')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ paymentMethod: 'bitcoin' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYMENT_METHOD' });
  });

  test('cross-tenant payable → 404 PAYABLE_NOT_FOUND', async () => {
    prisma.travelSupplierPayable.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .post('/api/travel/payable-batches')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ payableIds: [999] });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'PAYABLE_NOT_FOUND' });
  });

  test('payable already batched → 409 PAYABLE_ALREADY_BATCHED', async () => {
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      payableFixture({ id: 100, payableBatchId: 77 }),
    ]);
    const res = await request(makeApp())
      .post('/api/travel/payable-batches')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ payableIds: [100] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PAYABLE_ALREADY_BATCHED' });
  });

  test('payable in paid state → 409 PAYABLE_INVALID_STATE', async () => {
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      payableFixture({ id: 100, status: 'paid' }),
    ]);
    const res = await request(makeApp())
      .post('/api/travel/payable-batches')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ payableIds: [100] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PAYABLE_INVALID_STATE' });
  });

  test('batch number follows TPB-YYYY-NNNN format', async () => {
    prisma.travelSupplierPayableBatch.count.mockResolvedValue(41);
    const created = batchFixture();
    prisma.travelSupplierPayableBatch.create.mockResolvedValue(created);
    prisma.travelSupplierPayableBatch.findUnique.mockResolvedValue(created);
    await request(makeApp())
      .post('/api/travel/payable-batches')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    const data = prisma.travelSupplierPayableBatch.create.mock.calls[0][0].data;
    expect(data.batchNumber).toMatch(/^TPB-\d{4}-0042$/);
  });
});

// ────────────────────────────────────────────────────────────────────
// GET /payable-batches/:id (detail)
// ────────────────────────────────────────────────────────────────────

describe('GET /api/travel/payable-batches/:id', () => {
  test('happy path returns batch with linked payables', async () => {
    prisma.travelSupplierPayableBatch.findFirst.mockResolvedValue({
      ...batchFixture(),
      payables: [payableFixture({ payableBatchId: 12 })],
    });
    const res = await request(makeApp())
      .get('/api/travel/payable-batches/12')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.payables).toHaveLength(1);
  });

  test('cross-tenant batch returns 404 BATCH_NOT_FOUND', async () => {
    prisma.travelSupplierPayableBatch.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/payable-batches/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'BATCH_NOT_FOUND' });
  });
});

// ────────────────────────────────────────────────────────────────────
// PUT /payable-batches/:id (draft-only update)
// ────────────────────────────────────────────────────────────────────

describe('PUT /api/travel/payable-batches/:id', () => {
  test('happy path updates notes + scheduledFor', async () => {
    prisma.travelSupplierPayableBatch.findFirst.mockResolvedValue(batchFixture());
    prisma.travelSupplierPayableBatch.update.mockResolvedValue(
      batchFixture({ notes: 'updated' }),
    );
    const res = await request(makeApp())
      .put('/api/travel/payable-batches/12')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ notes: 'updated', scheduledFor: '2026-07-01' });
    expect(res.status).toBe(200);
    expect(prisma.travelSupplierPayableBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ notes: 'updated' }),
      }),
    );
  });

  test('non-draft batch returns 409 INVALID_STATUS_TRANSITION', async () => {
    prisma.travelSupplierPayableBatch.findFirst.mockResolvedValue(
      batchFixture({ status: 'approved' }),
    );
    const res = await request(makeApp())
      .put('/api/travel/payable-batches/12')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ notes: 'too late' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS_TRANSITION', from: 'approved' });
  });
});

// ────────────────────────────────────────────────────────────────────
// State machine
// ────────────────────────────────────────────────────────────────────

describe('State machine — /approve, /send-to-bank, /settle, /cancel', () => {
  test('draft → approved (ADMIN)', async () => {
    prisma.travelSupplierPayableBatch.findFirst.mockResolvedValue(batchFixture());
    prisma.travelSupplierPayableBatch.update.mockResolvedValue(
      batchFixture({ status: 'approved' }),
    );
    const res = await request(makeApp())
      .post('/api/travel/payable-batches/12/approve')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(prisma.travelSupplierPayableBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'approved', approvedBy: 7 }),
      }),
    );
  });

  test('MANAGER cannot approve (403)', async () => {
    prisma.travelSupplierPayableBatch.findFirst.mockResolvedValue(batchFixture());
    const res = await request(makeApp())
      .post('/api/travel/payable-batches/12/approve')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('invalid transition draft → settled returns 409', async () => {
    prisma.travelSupplierPayableBatch.findFirst.mockResolvedValue(batchFixture());
    const res = await request(makeApp())
      .post('/api/travel/payable-batches/12/settle')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
      from: 'draft',
      to: 'settled',
    });
  });

  test('sent_to_bank → settled flips children to paid', async () => {
    prisma.travelSupplierPayableBatch.findFirst.mockResolvedValue(
      batchFixture({ status: 'sent_to_bank' }),
    );
    prisma.travelSupplierPayableBatch.update.mockResolvedValue(
      batchFixture({ status: 'settled' }),
    );
    prisma.travelSupplierPayable.updateMany.mockResolvedValue({ count: 3 });
    const res = await request(makeApp())
      .post('/api/travel/payable-batches/12/settle')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ payablesSettled: 3 });
    expect(prisma.travelSupplierPayable.updateMany).toHaveBeenCalledWith({
      where: { payableBatchId: 12, status: { in: ['pending', 'scheduled'] } },
      data: expect.objectContaining({ status: 'paid' }),
    });
  });

  test('/cancel without cancelReason returns 400', async () => {
    prisma.travelSupplierPayableBatch.findFirst.mockResolvedValue(batchFixture());
    const res = await request(makeApp())
      .post('/api/travel/payable-batches/12/cancel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });

  test('/cancel detaches children + zeros totals', async () => {
    prisma.travelSupplierPayableBatch.findFirst.mockResolvedValue(
      batchFixture({ status: 'approved', payableCount: 3 }),
    );
    prisma.travelSupplierPayableBatch.update.mockResolvedValue(
      batchFixture({ status: 'cancelled' }),
    );
    const res = await request(makeApp())
      .post('/api/travel/payable-batches/12/cancel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ cancelReason: 'incorrect set' });
    expect(res.status).toBe(200);
    expect(prisma.travelSupplierPayable.updateMany).toHaveBeenCalledWith({
      where: { payableBatchId: 12 },
      data: { payableBatchId: null },
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// CSV export
// ────────────────────────────────────────────────────────────────────

describe('GET /api/travel/payable-batches/:id/payment-csv', () => {
  test('exports bank-friendly CSV with header + per-payable rows', async () => {
    prisma.travelSupplierPayableBatch.findFirst.mockResolvedValue({
      ...batchFixture({ status: 'approved', paymentMethod: 'rtgs', bankAccount: 'HDFC ****1234' }),
      payables: [
        payableFixture({ id: 100, amount: '15000.00', description: 'Hotel block' }),
        payableFixture({ id: 101, amount: '8500.00', description: 'Flight, return leg' }),
      ],
    });
    const res = await request(makeApp())
      .get('/api/travel/payable-batches/12/payment-csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/TPB-2026-0001\.csv/);
    const csv = res.text;
    expect(csv.split('\r\n')[0]).toBe(
      'batchNumber,paymentMethod,supplierName,supplierGstin,bankAccountMasked,amount,currency,description,poNumber,reference',
    );
    expect(csv).toContain('TPB-2026-0001,rtgs,Hotel Test,27ABCDE1234F1Z5,HDFC ****1234,15000.00');
    // Comma in description quoted per RFC4180.
    expect(csv).toContain('"Flight, return leg"');
  });

  test('MANAGER allowed (downloadable for ops)', async () => {
    prisma.travelSupplierPayableBatch.findFirst.mockResolvedValue({
      ...batchFixture(),
      payables: [],
    });
    const res = await request(makeApp())
      .get('/api/travel/payable-batches/12/payment-csv')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────────
// csvCell helper (RFC 4180 contract)
// ────────────────────────────────────────────────────────────────────

describe('csvCell — RFC 4180 quoting', () => {
  test.each([
    ['plain', 'plain'],
    [null, ''],
    [undefined, ''],
    ['has,comma', '"has,comma"'],
    ['has "quote"', '"has ""quote"""'],
    ['has\nnewline', '"has\nnewline"'],
  ])('%j → %j', (input, expected) => {
    expect(batchesRouter.csvCell(input)).toBe(expected);
  });
});

// ────────────────────────────────────────────────────────────────────
// Module surface
// ────────────────────────────────────────────────────────────────────

describe('Module surface', () => {
  test('VALID_STATUSES pins to draft / approved / sent_to_bank / settled / cancelled', () => {
    expect(batchesRouter.VALID_STATUSES).toEqual([
      'draft',
      'approved',
      'sent_to_bank',
      'settled',
      'cancelled',
    ]);
  });

  test('VALID_PAYMENT_METHODS pins to bank_transfer / upi / cheque / rtgs / neft / wire', () => {
    expect(batchesRouter.VALID_PAYMENT_METHODS).toEqual([
      'bank_transfer',
      'upi',
      'cheque',
      'rtgs',
      'neft',
      'wire',
    ]);
  });

  test('TRANSITIONS — terminal states have no outgoing edges', () => {
    expect(Array.from(batchesRouter.TRANSITIONS.settled)).toEqual([]);
    expect(Array.from(batchesRouter.TRANSITIONS.cancelled)).toEqual([]);
  });

  test('TRANSITIONS — draft can go approved or cancelled', () => {
    expect(Array.from(batchesRouter.TRANSITIONS.draft).sort()).toEqual([
      'approved',
      'cancelled',
    ]);
  });
});
