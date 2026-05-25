// @ts-check
/**
 * Arc 2 #901 slice 14 — TravelInvoice CreditNote workflow contract.
 *
 * Pins POST /api/travel/invoices/:id/credit-note — the operator-action
 * "Issue Credit Note" endpoint that creates a NEW TravelInvoice row with
 * docType='CreditNote', linked via parentInvoiceId self-relation, with
 * the credited amount stored as NEGATIVE totalAmount. PRD_TRAVEL_BILLING
 * UC-2.7 (cancellation + refund flow).
 *
 * Mirrors backend/test/routes/travel-invoice-issue.test.js (commit b25e7d0e,
 * Arc 2 slice 5) — same prisma-singleton-patch + supertest pattern, same
 * JWT signing.
 *
 * Contracts asserted (12 cases):
 *   1. Happy path: parent Issued + amount=100 -> 201, new row totalAmount=-100,
 *      docType='CreditNote', parentInvoiceId set, invoiceNum=CN-<parent>.
 *   2. amount > parent.totalAmount -> 400 AMOUNT_EXCEEDS_PARENT.
 *   3. parent.docType=='CreditNote' -> 400 CANNOT_CREDIT_CREDIT_NOTE
 *      (no nested credit-of-credit).
 *   4. parent.status=='Draft' -> 400 INVALID_PARENT_STATE.
 *   5. parent.status=='Voided' -> 400 INVALID_PARENT_STATE.
 *   6. USER role -> 403 (verifyRole short-circuits before findFirst).
 *   7. Missing amount -> 400 MISSING_FIELDS.
 *   8. Zero / negative amount -> 400 INVALID_AMOUNT.
 *   9. Cross-tenant parent -> 404 INVOICE_NOT_FOUND.
 *  10. Sub-brand denied (MANAGER without access) -> 403 SUB_BRAND_DENIED.
 *  11. Audit row written with action=TRAVEL_INVOICE_CREDIT_NOTE_ISSUED.
 *  12. Audit details payload carries parentId + parentInvoiceNum + amount
 *      + reason + lineDescription.
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

function parentInvoice(overrides = {}) {
  return {
    id: 500,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    invoiceNum: 'TMC/26-27/0042',
    status: 'Issued',
    docType: 'TaxInvoice',
    totalAmount: '5000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 14 * 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.create.mockReset();
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/invoices/:id/credit-note — issue CreditNote against parent', () => {
  test('happy path: 201 + new row docType=CreditNote, totalAmount=-100, parentInvoiceId set', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 500, totalAmount: '5000.00' }),
    );
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 999, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/500/credit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 100, reason: 'Customer cancelled flight leg' });

    expect(res.status).toBe(201);
    expect(res.body.docType).toBe('CreditNote');
    expect(Number(res.body.totalAmount)).toBe(-100);
    expect(res.body.parentInvoiceId).toBe(500);
    expect(res.body.status).toBe('Issued');
    expect(res.body.invoiceNum).toBe('CN-TMC/26-27/0042');
    expect(res.body.subBrand).toBe('tmc');
    expect(res.body.contactId).toBe(999);
    expect(res.body.currency).toBe('INR');

    // Verify create call shape
    const createArgs = prisma.travelInvoice.create.mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      tenantId: 1,
      subBrand: 'tmc',
      contactId: 999,
      docType: 'CreditNote',
      status: 'Issued',
      totalAmount: -100,
      parentInvoiceId: 500,
      invoiceNum: 'CN-TMC/26-27/0042',
      currency: 'INR',
    });
  });

  test('amount > parent.totalAmount returns 400 AMOUNT_EXCEEDS_PARENT', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 501, totalAmount: '500.00' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/501/credit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 600 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'AMOUNT_EXCEEDS_PARENT' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('parent already CreditNote returns 400 CANNOT_CREDIT_CREDIT_NOTE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 502, docType: 'CreditNote', totalAmount: '-200.00' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/502/credit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 50 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CANNOT_CREDIT_CREDIT_NOTE' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('parent in Draft state returns 400 INVALID_PARENT_STATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 503, status: 'Draft' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/503/credit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 100 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARENT_STATE' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('parent Voided returns 400 INVALID_PARENT_STATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 504, status: 'Voided' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/504/credit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 100 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARENT_STATE' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('USER role returns 403 (verifyRole short-circuits before findFirst)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/500/credit-note')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ amount: 100 });

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('missing amount returns 400 MISSING_FIELDS', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(parentInvoice({ id: 505 }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/505/credit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('zero amount returns 400 INVALID_AMOUNT', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(parentInvoice({ id: 506 }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/506/credit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 0 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('negative amount returns 400 INVALID_AMOUNT', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(parentInvoice({ id: 507 }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/507/credit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: -50 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('cross-tenant parent returns 404 INVOICE_NOT_FOUND', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/invoices/9999/credit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 100 });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('sub-brand denied returns 403 SUB_BRAND_DENIED', async () => {
    // Parent is on RFU; MANAGER's access list is restricted to TMC.
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 508, subBrand: 'rfu' }),
    );
    prisma.user.findUnique.mockResolvedValueOnce({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .post('/api/travel/invoices/508/credit-note')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ amount: 100 });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('audit row written: action=TRAVEL_INVOICE_CREDIT_NOTE_ISSUED with full details payload', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 509, invoiceNum: 'TMC/26-27/0099', totalAmount: '3000.00' }),
    );
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 1000, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/509/credit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        amount: 250,
        reason: 'Hotel cancelled by supplier',
        lineDescription: 'Refund for 2-night stay at Taj',
      });

    expect(res.status).toBe(201);
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelInvoice',
      action: 'TRAVEL_INVOICE_CREDIT_NOTE_ISSUED',
      entityId: 1000,
      userId: 7,
      tenantId: 1,
    });
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({
      parentId: 509,
      parentInvoiceNum: 'TMC/26-27/0099',
      amount: 250,
      reason: 'Hotel cancelled by supplier',
      lineDescription: 'Refund for 2-night stay at Taj',
      subBrand: 'tmc',
    });
  });

  test('reason and lineDescription default to null when omitted', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 510, invoiceNum: 'TMC/26-27/0050', totalAmount: '1000.00' }),
    );
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 1001, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/510/credit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 75 });

    expect(res.status).toBe(201);
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details.reason).toBeNull();
    expect(details.lineDescription).toBeNull();
    expect(details.amount).toBe(75);
  });
});
