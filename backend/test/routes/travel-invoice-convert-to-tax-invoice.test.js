// @ts-check
/**
 * Arc 2 #901 slice 26 — TravelInvoice Proforma -> TaxInvoice conversion contract.
 *
 * Pins POST /api/travel/invoices/:id/convert-to-tax-invoice — the operator-action
 * "Convert Proforma to Tax Invoice" endpoint that flips a Draft Proforma's
 * docType to TaxInvoice in-place and reassigns invoiceNum to a fresh
 * sub-brand serial via nextSubBrandInvoiceNum. PRD_TRAVEL_BILLING FR-3.8
 * (doc-type taxonomy) + UC-2.6 (overseas TCS estimation flow).
 *
 * Mirrors backend/test/routes/travel-invoice-credit-note.test.js (commit
 * 9af0e1dd, Arc 2 slice 14) — same prisma-singleton-patch + supertest pattern,
 * same JWT signing.
 *
 * Contracts asserted (10 cases):
 *   1. Happy path: Draft Proforma -> 200, docType flips to 'TaxInvoice',
 *      invoiceNum rewritten to a fresh per-sub-brand serial.
 *   2. invoice.docType=='TaxInvoice' -> 400 NOT_A_PROFORMA.
 *   3. invoice.docType=='CreditNote' -> 400 NOT_A_PROFORMA.
 *   4. invoice.docType==null (back-compat) -> 400 NOT_A_PROFORMA.
 *   5. invoice.status=='Issued' Proforma -> 400 INVALID_INVOICE_STATE.
 *   6. invoice.status=='Voided' Proforma -> 400 INVALID_INVOICE_STATE.
 *   7. USER role -> 403 (RBAC gate short-circuits before findFirst).
 *   8. Cross-tenant invoice -> 404 INVOICE_NOT_FOUND.
 *   9. Sub-brand denied (MANAGER without access) -> 403 SUB_BRAND_DENIED.
 *  10. Audit row written with action=TRAVEL_INVOICE_CONVERTED_TO_TAX_INVOICE
 *      carrying prevInvoiceNum + newInvoiceNum + subBrand details.
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

function proformaInvoice(overrides = {}) {
  return {
    id: 600,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    invoiceNum: 'PRO-TMC/26-27/0007',
    status: 'Draft',
    docType: 'Proforma',
    totalAmount: '12000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 14 * 86_400_000),
    parentInvoiceId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.update.mockReset();
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/invoices/:id/convert-to-tax-invoice — Proforma -> TaxInvoice flip', () => {
  test('happy path: Draft Proforma -> 200, docType=TaxInvoice + fresh sub-brand serial', async () => {
    // First findFirst: loadParentInvoice returns the Proforma.
    // Second findFirst (inside nextSubBrandInvoiceNum's $transaction):
    //   "latest TaxInvoice serial in this prefix" — return null so the new
    //   serial starts at 0001.
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(proformaInvoice({ id: 600 }))
      .mockResolvedValueOnce(null);
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...proformaInvoice({ id: where.id }),
      ...data,
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/600/convert-to-tax-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.docType).toBe('TaxInvoice');
    expect(res.body.status).toBe('Draft'); // status preserved
    expect(res.body.invoiceNum).not.toBe('PRO-TMC/26-27/0007');
    // invoicePrefixFor('tmc', new Date()) -> "TMC/<fy>" so the new serial
    // must start with "TMC/" + "/0001"
    expect(res.body.invoiceNum).toMatch(/^TMC\/\d{2}-\d{2}\/0001$/);

    // Verify update call shape.
    const updateArgs = prisma.travelInvoice.update.mock.calls[0][0];
    expect(updateArgs.where).toMatchObject({ id: 600 });
    expect(updateArgs.data).toMatchObject({ docType: 'TaxInvoice' });
    expect(updateArgs.data.invoiceNum).toMatch(/^TMC\/\d{2}-\d{2}\/0001$/);
  });

  test('docType=TaxInvoice already returns 400 NOT_A_PROFORMA', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      proformaInvoice({ id: 601, docType: 'TaxInvoice', invoiceNum: 'TMC/26-27/0042' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/601/convert-to-tax-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'NOT_A_PROFORMA' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('docType=CreditNote returns 400 NOT_A_PROFORMA', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      proformaInvoice({ id: 602, docType: 'CreditNote', invoiceNum: 'CN-TMC/26-27/0042', totalAmount: '-500.00' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/602/convert-to-tax-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'NOT_A_PROFORMA' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('docType=null (back-compat row) returns 400 NOT_A_PROFORMA', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      proformaInvoice({ id: 603, docType: null, invoiceNum: 'TMC/26-27/0001' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/603/convert-to-tax-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'NOT_A_PROFORMA' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('Proforma in Issued state returns 400 INVALID_INVOICE_STATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      proformaInvoice({ id: 604, status: 'Issued' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/604/convert-to-tax-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_INVOICE_STATE' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('Proforma in Voided state returns 400 INVALID_INVOICE_STATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      proformaInvoice({ id: 605, status: 'Voided' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/605/convert-to-tax-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_INVOICE_STATE' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('USER role returns 403 (verifyRole short-circuits before findFirst)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/600/convert-to-tax-invoice')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('cross-tenant invoice returns 404 INVOICE_NOT_FOUND', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/invoices/9999/convert-to-tax-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('sub-brand denied returns 403 SUB_BRAND_DENIED', async () => {
    // Proforma is on RFU; MANAGER's access list is restricted to TMC.
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      proformaInvoice({ id: 606, subBrand: 'rfu' }),
    );
    prisma.user.findUnique.mockResolvedValueOnce({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .post('/api/travel/invoices/606/convert-to-tax-invoice')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('audit row written: action=TRAVEL_INVOICE_CONVERTED_TO_TAX_INVOICE with prev/new invoiceNum + subBrand', async () => {
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(
        proformaInvoice({ id: 607, invoiceNum: 'PRO-RFU/26-27/0012', subBrand: 'rfu' }),
      )
      .mockResolvedValueOnce(
        // simulate a prior TaxInvoice in this sub-brand serial so the new
        // number lands at /0042 (just a non-trivial value to verify capture)
        { invoiceNum: 'RFU/26-27/0041' },
      );
    prisma.travelInvoice.update.mockImplementation(async ({ data, where }) => ({
      ...proformaInvoice({ id: where.id, subBrand: 'rfu', invoiceNum: 'PRO-RFU/26-27/0012' }),
      ...data,
      updatedAt: new Date(),
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/607/convert-to-tax-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.invoiceNum).toBe('RFU/26-27/0042');
    expect(res.body.docType).toBe('TaxInvoice');

    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelInvoice',
      action: 'TRAVEL_INVOICE_CONVERTED_TO_TAX_INVOICE',
      entityId: 607,
      userId: 7,
      tenantId: 1,
    });
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({
      prevInvoiceNum: 'PRO-RFU/26-27/0012',
      newInvoiceNum: 'RFU/26-27/0042',
      subBrand: 'rfu',
    });
  });
});
