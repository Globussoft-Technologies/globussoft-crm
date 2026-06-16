// @ts-check
/**
 * Arc 2 #901 slice 15 — TravelInvoice DebitNote workflow contract.
 *
 * Pins POST /api/travel/invoices/:id/debit-note — the operator-action
 * "Issue Debit Note" endpoint that creates a NEW TravelInvoice row with
 * docType='DebitNote', linked via parentInvoiceId self-relation, with
 * the additional-charge amount stored as POSITIVE totalAmount. The
 * inverse of slice 14's CreditNote workflow (commit 9af0e1dd).
 * PRD_TRAVEL_BILLING UC-2.7 (cancellation + refund flow — supplemental
 * charges arm: late fees, T&C revisions, supplier surcharge pass-through).
 *
 * Mirrors backend/test/routes/travel-invoice-credit-note.test.js (slice 14)
 * — same prisma-singleton-patch + supertest + HS256 JWT pattern.
 *
 * Contract differences from slice 14:
 *   - totalAmount is POSITIVE (+amount), not negative.
 *   - docType is 'DebitNote' not 'CreditNote'.
 *   - invoiceNum prefix is 'DN-' not 'CN-'.
 *   - Audit action is TRAVEL_INVOICE_DEBIT_NOTE_ISSUED.
 *   - Rejects BOTH DebitNote AND CreditNote parents (CANNOT_DEBIT_CREDIT_NOTE).
 *   - NO AMOUNT_EXCEEDS_PARENT gate — debit notes routinely exceed parent
 *     (e.g. 5000 trip + 8000 cancellation fee).
 *
 * Contracts asserted (12 cases):
 *   1. Happy path: parent Issued + amount=200 -> 201, new row totalAmount=+200,
 *      docType='DebitNote', parentInvoiceId set, invoiceNum=DN-<parent>.
 *   2. Zero amount -> 400 INVALID_AMOUNT.
 *   3. Negative amount -> 400 INVALID_AMOUNT.
 *   4. Parent already CreditNote -> 400 CANNOT_DEBIT_CREDIT_NOTE.
 *   5. Parent already DebitNote -> 400 CANNOT_DEBIT_CREDIT_NOTE.
 *   6. Parent in Draft state -> 400 INVALID_PARENT_STATE.
 *   7. USER role -> 403 (RBAC gate short-circuits before findFirst).
 *   8. Cross-tenant parent -> 404 INVOICE_NOT_FOUND.
 *   9. Sub-brand denied (MANAGER without access) -> 403 SUB_BRAND_DENIED.
 *  10. Audit row written with action=TRAVEL_INVOICE_DEBIT_NOTE_ISSUED.
 *  11. invoiceNum format: 'DN-<parent.invoiceNum>'.
 *  12. amount > parent.totalAmount succeeds (no AMOUNT_EXCEEDS_PARENT —
 *      this is the BEHAVIOURAL difference from slice 14's credit-note path).
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

describe('POST /api/travel/invoices/:id/debit-note — issue DebitNote against parent', () => {
  test('happy path: 201 + new row docType=DebitNote, totalAmount=+200, parentInvoiceId set', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 500, totalAmount: '5000.00' }),
    );
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 999, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/500/debit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 200, reason: 'Late cancellation fee' });

    expect(res.status).toBe(201);
    expect(res.body.docType).toBe('DebitNote');
    expect(Number(res.body.totalAmount)).toBe(200);
    expect(res.body.parentInvoiceId).toBe(500);
    expect(res.body.status).toBe('Issued');
    expect(res.body.invoiceNum).toBe('DN-TMC/26-27/0042');
    expect(res.body.subBrand).toBe('tmc');
    expect(res.body.contactId).toBe(999);
    expect(res.body.currency).toBe('INR');

    // Verify create call shape — totalAmount is POSITIVE (the slice-15 inverse).
    const createArgs = prisma.travelInvoice.create.mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      tenantId: 1,
      subBrand: 'tmc',
      contactId: 999,
      docType: 'DebitNote',
      status: 'Issued',
      totalAmount: 200,
      parentInvoiceId: 500,
      invoiceNum: 'DN-TMC/26-27/0042',
      currency: 'INR',
    });
  });

  test('zero amount returns 400 INVALID_AMOUNT', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(parentInvoice({ id: 501 }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/501/debit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 0 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('negative amount returns 400 INVALID_AMOUNT', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(parentInvoice({ id: 502 }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/502/debit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: -5 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('parent already CreditNote returns 400 CANNOT_DEBIT_CREDIT_NOTE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 503, docType: 'CreditNote', totalAmount: '-200.00' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/503/debit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 50 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CANNOT_DEBIT_CREDIT_NOTE' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('parent already DebitNote returns 400 CANNOT_DEBIT_CREDIT_NOTE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 504, docType: 'DebitNote', totalAmount: '200.00' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/504/debit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 50 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CANNOT_DEBIT_CREDIT_NOTE' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('parent in Draft state returns 400 INVALID_PARENT_STATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 505, status: 'Draft' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/505/debit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 100 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARENT_STATE' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('USER role returns 403 (verifyRole short-circuits before findFirst)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/500/debit-note')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ amount: 200 });

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('cross-tenant parent returns 404 INVOICE_NOT_FOUND', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/invoices/9999/debit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 200 });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('sub-brand denied returns 403 SUB_BRAND_DENIED', async () => {
    // Parent is on RFU; MANAGER's access list is restricted to TMC.
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 506, subBrand: 'rfu' }),
    );
    prisma.user.findUnique.mockResolvedValueOnce({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .post('/api/travel/invoices/506/debit-note')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ amount: 200 });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('audit row written: action=TRAVEL_INVOICE_DEBIT_NOTE_ISSUED with full details payload', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 507, invoiceNum: 'TMC/26-27/0099', totalAmount: '3000.00' }),
    );
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 1000, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/507/debit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        amount: 250,
        reason: 'Supplier-side surcharge pass-through',
        lineDescription: 'Hotel rate hike for revised stay dates',
      });

    expect(res.status).toBe(201);
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelInvoice',
      action: 'TRAVEL_INVOICE_DEBIT_NOTE_ISSUED',
      entityId: 1000,
      userId: 7,
      tenantId: 1,
    });
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({
      parentId: 507,
      parentInvoiceNum: 'TMC/26-27/0099',
      amount: 250,
      reason: 'Supplier-side surcharge pass-through',
      lineDescription: 'Hotel rate hike for revised stay dates',
      subBrand: 'tmc',
    });
  });

  test('invoiceNum format: DN-<parent.invoiceNum> (prefix is DN- not CN-)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 508, invoiceNum: 'RFU/26-27/0077' }),
    );
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 1001, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/508/debit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 100 });

    expect(res.status).toBe(201);
    expect(res.body.invoiceNum).toBe('DN-RFU/26-27/0077');
    // Explicitly confirm prefix discriminator vs slice-14's CN-.
    expect(res.body.invoiceNum.startsWith('DN-')).toBe(true);
    expect(res.body.invoiceNum.startsWith('CN-')).toBe(false);
  });

  test('amount > parent.totalAmount succeeds (NO AMOUNT_EXCEEDS_PARENT — inverse of slice 14)', async () => {
    // PRD UC-2.7 explicitly allows debit-note amount to exceed parent —
    // a 5000 trip can incur an 8000 cancellation fee. This is the
    // BEHAVIOURAL difference vs slice-14 credit-note (which would 400
    // AMOUNT_EXCEEDS_PARENT on this same shape).
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      parentInvoice({ id: 509, totalAmount: '5000.00' }),
    );
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 1002, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/509/debit-note')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 8000, reason: 'Cancellation fee exceeds trip cost' });

    expect(res.status).toBe(201);
    expect(Number(res.body.totalAmount)).toBe(8000);
    expect(res.body.docType).toBe('DebitNote');
    // Ensure no AMOUNT_EXCEEDS_PARENT-style envelope leaked.
    expect(res.body.code).toBeUndefined();
  });
});
