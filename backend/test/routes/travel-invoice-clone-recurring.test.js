// @ts-check
/**
 * Arc 2 #901 slice 16 — TravelInvoice clone-as-recurring contract.
 *
 * Pins POST /api/travel/invoices/:id/clone-as-recurring — the operator-
 * action "Clone for next cycle" endpoint that duplicates an Issued or
 * Paid invoice (header + lines) into a NEW Draft TravelInvoice that the
 * operator can review, tweak, and issue as the next billing cycle.
 * PRD_TRAVEL_BILLING §3.4 (recurring billing). Distinct from the
 * upcoming slice 17 (cron-driven auto-clone on a schedule).
 *
 * Mirrors backend/test/routes/travel-invoice-debit-note.test.js (slice 15)
 * — same prisma-singleton-patch + supertest + HS256 JWT pattern.
 *
 * Key contract points:
 *   - Source must be [Issued, Paid] — Draft/Partial/Voided all rejected
 *     with INVALID_SOURCE_STATE.
 *   - CreditNote / DebitNote sources rejected outright (CANNOT_CLONE_NOTE).
 *   - Clone is born Draft with a fresh TINV-YYYY-NNNN invoiceNum.
 *   - parentInvoiceId stays NULL (recurring cycles are independent, not
 *     credit-note-style adjustments — keeps the credit-note subgraph clean).
 *   - dueDate default = NOW + 30 days; body override accepted.
 *   - clearTcs default TRUE (TCS Sec 206C is FY-cumulative-spend-dependent;
 *     historical values are stale). clearTcs=false inherits source TCS.
 *   - Lines duplicated via createMany — preserves all per-line fields.
 *
 * Contracts asserted (12 cases):
 *   1. Happy path: Issued source → 201 with new Draft invoice, same
 *      currency + subBrand + contactId + docType.
 *   2. Lines cloned via createMany (count matches source).
 *   3. Source Paid → 201 (also cloneable).
 *   4. Source Draft → 400 INVALID_SOURCE_STATE.
 *   5. Source Voided → 400 INVALID_SOURCE_STATE.
 *   6. Source CreditNote → 400 CANNOT_CLONE_NOTE.
 *   7. Source DebitNote → 400 CANNOT_CLONE_NOTE.
 *   8. Default dueDate ≈ NOW + 30 days (clone date wraps a 30-day window).
 *   9. Override dueDate accepted (body.dueDate wins over default).
 *  10. clearTcs=true (default) → TCS fields null on clone.
 *  11. clearTcs=false → TCS fields inherited from source.
 *  12. USER role → 403 (RBAC gate short-circuits).
 *  13. Audit row written with sourceId + lineCount + clearTcs flag.
 *
 * Test pattern: patch the prisma singleton with vi.fn() stubs BEFORE the
 * router is required, then drive supertest with real HS256 JWTs signed
 * with the same fallback secret the middleware uses in dev.
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
  createMany: vi.fn().mockResolvedValue({ count: 0 }),
  update: vi.fn(),
  delete: vi.fn(),
};
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

function sourceInvoice(overrides = {}) {
  return {
    id: 600,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 888,
    invoiceNum: 'TMC/26-27/0050',
    status: 'Issued',
    docType: 'TaxInvoice',
    totalAmount: '7500.00',
    currency: 'INR',
    dueDate: new Date('2026-04-15'),
    parentInvoiceId: null,
    tcsAmount: '375.00',
    tcsRate: '5.00',
    tcsExceedingAmount: '0.00',
    tcsAppliedAt: new Date('2026-04-01'),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function sourceLine(idSuffix, overrides = {}) {
  return {
    id: 7000 + idSuffix,
    tenantId: 1,
    invoiceId: 600,
    lineType: 'per_pax',
    description: `Line ${idSuffix}`,
    quantity: 2,
    unitPrice: '1500.00',
    amount: '3000.00',
    currency: 'INR',
    sortOrder: idSuffix,
    notes: null,
    pnr: null,
    bookingRef: null,
    serviceStartDate: null,
    serviceEndDate: null,
    fxRateToBase: null,
    baseAmount: null,
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.create.mockReset();
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.travelInvoiceLine.createMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/invoices/:id/clone-as-recurring — duplicate template for next billing cycle', () => {
  test('happy path: Issued source → 201, new Draft invoice with same currency + subBrand + contactId + docType', async () => {
    // nextInvoiceNum: findFirst inside $transaction (latest with TINV-YYYY-)
    // returns null → serial 0001.
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(sourceInvoice({ id: 600 })) // loadParentInvoice
      .mockResolvedValueOnce(null); // nextInvoiceNum's latest lookup
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 9000, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/600/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.invoice).toBeDefined();
    expect(res.body.invoice.status).toBe('Draft');
    expect(res.body.invoice.subBrand).toBe('tmc');
    expect(res.body.invoice.contactId).toBe(888);
    expect(res.body.invoice.currency).toBe('INR');
    expect(res.body.invoice.docType).toBe('TaxInvoice');
    expect(res.body.invoice.parentInvoiceId).toBeNull();
    // Fresh TINV-YYYY-NNNN invoiceNum (not inherited)
    expect(res.body.invoice.invoiceNum).toMatch(/^TINV-\d{4}-\d{4}$/);
    expect(res.body.invoice.invoiceNum).not.toBe('TMC/26-27/0050');
    expect(res.body.lineCount).toBe(0);
  });

  test('lines cloned via createMany (count matches source line count)', async () => {
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(sourceInvoice({ id: 601 }))
      .mockResolvedValueOnce(null);
    prisma.travelInvoiceLine.findMany.mockResolvedValueOnce([
      sourceLine(1, { lineType: 'per_pax', amount: '3000.00' }),
      sourceLine(2, { lineType: 'fee', amount: '500.00' }),
      sourceLine(3, { lineType: 'tax', amount: '630.00' }),
    ]);
    prisma.travelInvoiceLine.createMany.mockResolvedValueOnce({ count: 3 });
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 9001, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/601/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.lineCount).toBe(3);
    expect(prisma.travelInvoiceLine.createMany).toHaveBeenCalledTimes(1);
    const callArgs = prisma.travelInvoiceLine.createMany.mock.calls[0][0];
    expect(Array.isArray(callArgs.data)).toBe(true);
    expect(callArgs.data).toHaveLength(3);
    // Each cloned row is re-stamped with the new invoiceId (9001), not the source's (601).
    expect(callArgs.data[0].invoiceId).toBe(9001);
    expect(callArgs.data[0].lineType).toBe('per_pax');
    expect(callArgs.data[0].tenantId).toBe(1);
    expect(callArgs.data[1].lineType).toBe('fee');
    expect(callArgs.data[2].lineType).toBe('tax');
  });

  test('source Paid → 201 (also cloneable)', async () => {
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(sourceInvoice({ id: 602, status: 'Paid' }))
      .mockResolvedValueOnce(null);
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 9002, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/602/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.invoice.status).toBe('Draft'); // clone is Draft regardless of source state
  });

  test('source Draft → 400 INVALID_SOURCE_STATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      sourceInvoice({ id: 603, status: 'Draft' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/603/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SOURCE_STATE' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('source Voided → 400 INVALID_SOURCE_STATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      sourceInvoice({ id: 604, status: 'Voided' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/604/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SOURCE_STATE' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('source CreditNote → 400 CANNOT_CLONE_NOTE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      sourceInvoice({
        id: 605,
        docType: 'CreditNote',
        totalAmount: '-200.00',
        parentInvoiceId: 500,
      }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/605/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CANNOT_CLONE_NOTE' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('source DebitNote → 400 CANNOT_CLONE_NOTE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      sourceInvoice({
        id: 606,
        docType: 'DebitNote',
        totalAmount: '250.00',
        parentInvoiceId: 500,
      }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/606/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CANNOT_CLONE_NOTE' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('default dueDate ≈ NOW + 30 days when body omits override', async () => {
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(sourceInvoice({ id: 607 }))
      .mockResolvedValueOnce(null);
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 9007, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const before = Date.now();
    const res = await request(makeApp())
      .post('/api/travel/invoices/607/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    const after = Date.now();

    expect(res.status).toBe(201);
    const dueMs = new Date(res.body.invoice.dueDate).getTime();
    const expectedMin = before + 30 * 86_400_000 - 60_000; // 1-min slack
    const expectedMax = after + 30 * 86_400_000 + 60_000;
    expect(dueMs).toBeGreaterThanOrEqual(expectedMin);
    expect(dueMs).toBeLessThanOrEqual(expectedMax);
  });

  test('override dueDate accepted (body.dueDate wins over default)', async () => {
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(sourceInvoice({ id: 608 }))
      .mockResolvedValueOnce(null);
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 9008, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const override = '2026-12-31T00:00:00.000Z';
    const res = await request(makeApp())
      .post('/api/travel/invoices/608/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ dueDate: override });

    expect(res.status).toBe(201);
    expect(new Date(res.body.invoice.dueDate).toISOString()).toBe(override);
  });

  test('clearTcs=true (default) → TCS fields null on clone', async () => {
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(sourceInvoice({
        id: 609,
        tcsAmount: '375.00',
        tcsRate: '5.00',
        tcsExceedingAmount: '100.00',
        tcsAppliedAt: new Date('2026-04-01'),
      }))
      .mockResolvedValueOnce(null);
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 9009, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/609/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({}); // no clearTcs → default true

    expect(res.status).toBe(201);
    // Inspect the create call to confirm the TCS fields were null at write time.
    const createArgs = prisma.travelInvoice.create.mock.calls[0][0];
    expect(createArgs.data.tcsAmount).toBeNull();
    expect(createArgs.data.tcsRate).toBeNull();
    expect(createArgs.data.tcsExceedingAmount).toBeNull();
    expect(createArgs.data.tcsAppliedAt).toBeNull();
  });

  test('clearTcs=false → TCS fields inherited from source', async () => {
    const sourceTcsAppliedAt = new Date('2026-04-01T08:00:00.000Z');
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(sourceInvoice({
        id: 610,
        tcsAmount: '375.00',
        tcsRate: '5.00',
        tcsExceedingAmount: '100.00',
        tcsAppliedAt: sourceTcsAppliedAt,
      }))
      .mockResolvedValueOnce(null);
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 9010, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/610/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ clearTcs: false });

    expect(res.status).toBe(201);
    const createArgs = prisma.travelInvoice.create.mock.calls[0][0];
    expect(createArgs.data.tcsAmount).toBe('375.00');
    expect(createArgs.data.tcsRate).toBe('5.00');
    expect(createArgs.data.tcsExceedingAmount).toBe('100.00');
    expect(createArgs.data.tcsAppliedAt).toEqual(sourceTcsAppliedAt);
  });

  test('USER role → 403 (verifyRole short-circuits before findFirst)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/600/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('audit row written: action=TRAVEL_INVOICE_CLONED_RECURRING with sourceId + lineCount + clearTcs', async () => {
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(sourceInvoice({
        id: 611,
        invoiceNum: 'RFU/26-27/0099',
        subBrand: 'rfu',
      }))
      .mockResolvedValueOnce(null);
    prisma.travelInvoiceLine.findMany.mockResolvedValueOnce([
      sourceLine(1),
      sourceLine(2),
    ]);
    prisma.travelInvoiceLine.createMany.mockResolvedValueOnce({ count: 2 });
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 9011, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/611/clone-as-recurring')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelInvoice',
      action: 'TRAVEL_INVOICE_CLONED_RECURRING',
      entityId: 9011,
      userId: 7,
      tenantId: 1,
    });
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({
      sourceId: 611,
      sourceInvoiceNum: 'RFU/26-27/0099',
      lineCount: 2,
      clearTcs: true,
      subBrand: 'rfu',
    });
    expect(typeof details.dueDate).toBe('string');
  });
});
