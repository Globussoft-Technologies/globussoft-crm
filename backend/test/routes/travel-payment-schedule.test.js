// @ts-check
/**
 * Arc 2 #901 slice 6 — TravelPaymentSchedule CRUD contract
 * (PRD_TRAVEL_BILLING FR-3.2.a).
 *
 * Pins the four milestone endpoints added to backend/routes/travel_invoices.js:
 *
 *   GET    /api/travel/invoices/:id/schedule                       any verified token
 *   POST   /api/travel/invoices/:id/schedule                       ADMIN/MANAGER
 *   PUT    /api/travel/invoices/:id/schedule/:milestoneId          ADMIN/MANAGER
 *   DELETE /api/travel/invoices/:id/schedule/:milestoneId          ADMIN/MANAGER
 *
 * Contracts asserted:
 *   - expectedCurrency falls back to the parent invoice's currency when the
 *     body omits it (operator-side default — single-currency invoices
 *     shouldn't need to repeat).
 *   - Status enum: pending | partial | paid | overdue | waived. Bad → 400.
 *   - milestoneOrder must be a positive integer; missing → 400 MISSING_FIELDS;
 *     non-positive / non-integer → 400 INVALID_MILESTONE_ORDER.
 *   - expectedAmount missing → 400 MISSING_FIELDS; negative → 400 INVALID_AMOUNT.
 *   - PUT partial-update only writes the supplied fields (no clobbering).
 *   - PUT status='paid' auto-sets paidAt=now() when not already set.
 *   - PUT explicit paidAt override → uses operator-supplied timestamp.
 *   - Tenant + sub-brand isolation: cross-tenant parent → 404 INVOICE_NOT_FOUND;
 *     sub-brand mismatch → 403 SUB_BRAND_DENIED (requires MANAGER role —
 *     ADMIN short-circuits the deny path in getSubBrandAccessSet).
 *   - Milestone under a different parent → 404 MILESTONE_NOT_FOUND.
 *
 * Test pattern mirrors backend/test/routes/travel-supplier-payables.test.js
 * (commit 59336ab7) — patch the prisma singleton with vi.fn() shapes BEFORE
 * requiring the router, then drive supertest with real HS256 JWTs signed
 * with the same fallback secret the middleware uses in dev. verifyToken
 * stays in the chain (we don't bypass it) so the auth-gate is exercised
 * end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelInvoice = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoiceLine = {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelPaymentSchedule = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
// $transaction is used by nextInvoiceNum in the parent invoice routes —
// not exercised here but the router needs the surface present.
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
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
const travelInvoicesRouter = requireCJS('../../routes/travel_invoices');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelInvoicesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function parentInvoice(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    quoteId: null,
    invoiceNum: 'TINV-2026-0001',
    status: 'Issued',
    totalAmount: '120000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 7 * 86_400_000),
    paidAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMilestone(overrides = {}) {
  return {
    id: 555,
    tenantId: 1,
    invoiceId: 100,
    milestoneOrder: 1,
    dueDate: null,
    expectedAmount: '30000.00',
    expectedCurrency: 'INR',
    receivedAmount: null,
    status: 'pending',
    paidAt: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelPaymentSchedule.findMany.mockReset().mockResolvedValue([]);
  prisma.travelPaymentSchedule.findFirst.mockReset();
  prisma.travelPaymentSchedule.create.mockReset();
  prisma.travelPaymentSchedule.update.mockReset();
  prisma.travelPaymentSchedule.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/invoices/:id/schedule', () => {
  test('happy path: returns schedule for parent invoice ordered by milestoneOrder', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const rows = [
      makeMilestone({ id: 1, milestoneOrder: 1, expectedAmount: '30000.00' }),
      makeMilestone({ id: 2, milestoneOrder: 2, expectedAmount: '60000.00' }),
      makeMilestone({ id: 3, milestoneOrder: 3, expectedAmount: '30000.00' }),
    ];
    prisma.travelPaymentSchedule.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/schedule')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3 });
    expect(res.body.schedule).toHaveLength(3);
    expect(prisma.travelPaymentSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, invoiceId: 100 }),
        orderBy: [{ milestoneOrder: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  test('cross-tenant parent invoice returns 404 INVOICE_NOT_FOUND', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/invoices/9999/schedule')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(prisma.travelPaymentSchedule.findMany).not.toHaveBeenCalled();
  });

  test('non-numeric :id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/notanumber/schedule')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelPaymentSchedule.findMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/travel/invoices/:id/schedule', () => {
  test('happy path with all fields returns 201 and persists', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelPaymentSchedule.create.mockImplementation(({ data }) =>
      // Simulate Prisma's @default("pending") on the status column. The
      // route passes status: status || undefined which spreads as undefined
      // in mock-land; we have to apply the default AFTER the spread.
      Promise.resolve({
        id: 777,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
        status: data.status || 'pending',
      }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/schedule')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        milestoneOrder: 2,
        expectedAmount: 60000,
        expectedCurrency: 'INR',
        dueDate: '2026-08-15',
        notes: 'Pre-departure 50%',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 777,
      milestoneOrder: 2,
      expectedAmount: '60000',
      expectedCurrency: 'INR',
      status: 'pending',
      notes: 'Pre-departure 50%',
    });
    expect(prisma.travelPaymentSchedule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          invoiceId: 100,
          milestoneOrder: 2,
          expectedAmount: '60000',
          expectedCurrency: 'INR',
        }),
      }),
    );
    const dataArg = prisma.travelPaymentSchedule.create.mock.calls[0][0].data;
    expect(dataArg.dueDate).toBeInstanceOf(Date);
  });

  test('defaults expectedCurrency to parent invoice currency when omitted', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice({ currency: 'USD' }));
    prisma.travelPaymentSchedule.create.mockResolvedValue(
      makeMilestone({ expectedCurrency: 'USD' }),
    );

    await request(makeApp())
      .post('/api/travel/invoices/100/schedule')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ milestoneOrder: 1, expectedAmount: 100 });

    expect(prisma.travelPaymentSchedule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ expectedCurrency: 'USD' }),
      }),
    );
  });

  test('rejects missing milestoneOrder with 400 MISSING_FIELDS', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/schedule')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ expectedAmount: 100 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelPaymentSchedule.create).not.toHaveBeenCalled();
  });

  test('rejects non-positive milestoneOrder with 400 INVALID_MILESTONE_ORDER', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/schedule')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ milestoneOrder: 0, expectedAmount: 100 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MILESTONE_ORDER' });
    expect(prisma.travelPaymentSchedule.create).not.toHaveBeenCalled();
  });

  test('rejects negative expectedAmount with 400 INVALID_AMOUNT', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/schedule')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ milestoneOrder: 1, expectedAmount: -100 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(prisma.travelPaymentSchedule.create).not.toHaveBeenCalled();
  });

  test('rejects invalid status with 400 INVALID_STATUS listing valid values', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/schedule')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ milestoneOrder: 1, expectedAmount: 100, status: 'frozen' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(res.body.error).toMatch(/pending/);
    expect(res.body.error).toMatch(/partial/);
    expect(res.body.error).toMatch(/paid/);
    expect(res.body.error).toMatch(/overdue/);
    expect(res.body.error).toMatch(/waived/);
    expect(prisma.travelPaymentSchedule.create).not.toHaveBeenCalled();
  });

  test('rejects invalid dueDate with 400 INVALID_DUE_DATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/schedule')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ milestoneOrder: 1, expectedAmount: 100, dueDate: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DUE_DATE' });
    expect(prisma.travelPaymentSchedule.create).not.toHaveBeenCalled();
  });

  test('USER role cannot create milestones (403)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/schedule')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ milestoneOrder: 1, expectedAmount: 100 });
    expect(res.status).toBe(403);
    expect(prisma.travelPaymentSchedule.create).not.toHaveBeenCalled();
  });
});

describe('PUT /api/travel/invoices/:id/schedule/:milestoneId', () => {
  test('partial update changing only dueDate returns 200 + only dueDate diff', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(makeMilestone());
    prisma.travelPaymentSchedule.update.mockResolvedValue(
      makeMilestone({ dueDate: new Date('2026-12-31T00:00:00.000Z') }),
    );

    const res = await request(makeApp())
      .put('/api/travel/invoices/100/schedule/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ dueDate: '2026-12-31' });

    expect(res.status).toBe(200);
    const dataArg = prisma.travelPaymentSchedule.update.mock.calls[0][0].data;
    expect(Object.keys(dataArg)).toEqual(['dueDate']);
    expect(dataArg.dueDate).toBeInstanceOf(Date);
  });

  test("status='paid' auto-sets paidAt to a recent timestamp", async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(
      makeMilestone({ status: 'partial', paidAt: null }),
    );
    prisma.travelPaymentSchedule.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...makeMilestone(), status: 'paid', paidAt: data.paidAt }),
    );

    const before = Date.now();
    const res = await request(makeApp())
      .put('/api/travel/invoices/100/schedule/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'paid' });
    const after = Date.now();

    expect(res.status).toBe(200);
    const dataArg = prisma.travelPaymentSchedule.update.mock.calls[0][0].data;
    expect(dataArg.status).toBe('paid');
    expect(dataArg.paidAt).toBeInstanceOf(Date);
    const paidAtMs = dataArg.paidAt.getTime();
    expect(paidAtMs).toBeGreaterThanOrEqual(before);
    expect(paidAtMs).toBeLessThanOrEqual(after);
  });

  test('explicit paidAt override uses the operator-supplied timestamp', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(
      makeMilestone({ status: 'partial', paidAt: null }),
    );
    prisma.travelPaymentSchedule.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...makeMilestone(), status: 'paid', paidAt: data.paidAt }),
    );

    const override = '2026-03-15T10:30:00.000Z';
    const res = await request(makeApp())
      .put('/api/travel/invoices/100/schedule/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'paid', paidAt: override });

    expect(res.status).toBe(200);
    const dataArg = prisma.travelPaymentSchedule.update.mock.calls[0][0].data;
    expect(dataArg.paidAt).toBeInstanceOf(Date);
    expect(dataArg.paidAt.toISOString()).toBe(override);
  });

  test('invalid status on PUT returns 400 INVALID_STATUS (no update)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(makeMilestone());
    const res = await request(makeApp())
      .put('/api/travel/invoices/100/schedule/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'frozen' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.travelPaymentSchedule.update).not.toHaveBeenCalled();
  });

  test('empty body returns 400 EMPTY_BODY', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(makeMilestone());
    const res = await request(makeApp())
      .put('/api/travel/invoices/100/schedule/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BODY' });
    expect(prisma.travelPaymentSchedule.update).not.toHaveBeenCalled();
  });

  test('missing milestone returns 404 MILESTONE_NOT_FOUND', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/travel/invoices/100/schedule/77777')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'partial' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'MILESTONE_NOT_FOUND' });
    expect(prisma.travelPaymentSchedule.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/travel/invoices/:id/schedule/:milestoneId', () => {
  test('happy path returns 204 + hard delete', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(makeMilestone());
    prisma.travelPaymentSchedule.delete.mockResolvedValue({ id: 555 });

    const res = await request(makeApp())
      .delete('/api/travel/invoices/100/schedule/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(prisma.travelPaymentSchedule.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 555 } }),
    );
  });

  test('missing milestone returns 404 MILESTONE_NOT_FOUND (no delete)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/travel/invoices/100/schedule/77777')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'MILESTONE_NOT_FOUND' });
    expect(prisma.travelPaymentSchedule.delete).not.toHaveBeenCalled();
  });
});

describe('Sub-brand isolation (parent loader)', () => {
  // ADMIN role short-circuits the sub-brand deny path via getSubBrandAccessSet,
  // so isolation tests use MANAGER which still honors subBrandAccess.
  test('GET on a sub-brand the user cannot access returns 403 SUB_BRAND_DENIED', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice({ subBrand: 'rfu' }));
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/schedule')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelPaymentSchedule.findMany).not.toHaveBeenCalled();
  });

  test('POST on a sub-brand the user cannot access returns 403 SUB_BRAND_DENIED', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice({ subBrand: 'rfu' }));
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/schedule')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ milestoneOrder: 1, expectedAmount: 100 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelPaymentSchedule.create).not.toHaveBeenCalled();
  });
});
