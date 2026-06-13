// @ts-check
/**
 * backend/routes/travel_invoice_ledgers.js — G030+G031+G032 contract pin.
 *
 * What's pinned
 * -------------
 *   - GET /api/travel/invoices/customer-ledger  400 INVALID_FISCAL_YEAR;
 *                                                400 MISSING_FILTER; 404
 *                                                CONTACT_NOT_FOUND;
 *                                                JSON envelope shape;
 *                                                ?format=csv content-type
 *   - GET /api/travel/invoices/tds-register     400 INVALID_FISCAL_YEAR;
 *                                                400 INVALID_SECTION;
 *                                                section filter narrows;
 *                                                ?format=csv content-type
 *   - GET /api/travel/invoices/commission-ledger 400 INVALID_FISCAL_YEAR;
 *                                                400 INVALID_TYPE;
 *                                                type filter narrows;
 *                                                ?format=csv content-type
 *
 * Pattern mirrors travel-cancellation-policies.test.js — patch the prisma
 * singleton BEFORE requiring the router; sign real HS256 JWTs against the
 * dev-fallback secret so verifyToken + verifyRole + requireTravelTenant
 * stay in the chain.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelInvoice = {
  ...(prisma.travelInvoice || {}),
  findMany: vi.fn(),
};
prisma.travelPaymentSchedule = {
  ...(prisma.travelPaymentSchedule || {}),
  findMany: vi.fn(),
};
prisma.travelSupplierCommissionEntry = {
  ...(prisma.travelSupplierCommissionEntry || {}),
  findMany: vi.fn(),
};
prisma.contact = {
  ...(prisma.contact || {}),
  findMany: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
  defaultCurrency: 'INR',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const ledgersRouter = requireCJS('../../routes/travel_invoice_ledgers');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', ledgersRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.travelInvoice.findMany.mockReset();
  prisma.travelPaymentSchedule.findMany.mockReset();
  prisma.travelSupplierCommissionEntry.findMany.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel', defaultCurrency: 'INR',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// /invoices/customer-ledger — G030
// ---------------------------------------------------------------------------

describe('GET /api/travel/invoices/customer-ledger', () => {
  test('401 when no token', async () => {
    const res = await request(makeApp()).get('/api/travel/invoices/customer-ledger?fy=FY2025-26&contactId=1');
    expect([401, 403]).toContain(res.status);
  });

  test('400 INVALID_FISCAL_YEAR on malformed fy', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/customer-ledger?fy=2025-26&contactId=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FISCAL_YEAR');
  });

  test('400 MISSING_FILTER when neither gstin nor contactId given', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/customer-ledger?fy=FY2025-26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FILTER');
  });

  test('400 INVALID_GSTIN on bad GSTIN shape', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/customer-ledger?fy=FY2025-26&gstin=notarealgstin')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_GSTIN');
  });

  test('400 INVALID_CONTACT_ID on non-numeric contactId', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/customer-ledger?fy=FY2025-26&contactId=abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CONTACT_ID');
  });

  test('404 CONTACT_NOT_FOUND when contactId resolves nothing', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/customer-ledger?fy=FY2025-26&contactId=999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTACT_NOT_FOUND');
  });

  test('200 envelope shape — opening / transactions / closing / summary', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 5, name: 'Ravi Kumar', email: 'ravi@example.com', phone: '9876543210', stateCode: '27', gst: null },
    ]);
    prisma.travelInvoice.findMany.mockResolvedValue([
      {
        id: 100,
        invoiceNum: 'TINV-2025-0001',
        totalAmount: 1500,
        currency: 'INR',
        status: 'Issued',
        docType: 'TaxInvoice',
        dueDate: new Date(Date.UTC(2025, 6, 10)),
        paidAt: null,
        createdAt: new Date(Date.UTC(2025, 5, 10)),
        subBrand: 'tmc',
      },
    ]);
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([
      {
        id: 200,
        invoiceId: 100,
        receivedAmount: 1500,
        paidAt: new Date(Date.UTC(2025, 5, 25)),
        milestoneOrder: 1,
        invoice: { invoiceNum: 'TINV-2025-0001', subBrand: 'tmc' },
      },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/customer-ledger?fy=FY2025-26&contactId=5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.fiscalYear).toBe('FY2025-26');
    expect(res.body.contact.id).toBe(5);
    expect(res.body.openingBalance).toMatchObject({ amount: 0, currency: 'INR' });
    expect(res.body.transactions).toHaveLength(2);
    expect(res.body.closingBalance).toMatchObject({ amount: 0, currency: 'INR' });
    expect(res.body.summary.totalInvoiced).toBe(1500);
    expect(res.body.summary.totalPaid).toBe(1500);
  });

  test('?format=csv returns text/csv with attachment header', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 5, name: 'Ravi Kumar', email: 'ravi@example.com', phone: '9876543210', stateCode: '27', gst: null },
    ]);
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/customer-ledger?fy=FY2025-26&contactId=5&format=csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment.*\.csv/);
    expect(res.text).toContain('date,type,refNumber');
  });

  test('GSTIN filter scopes contact lookup via gst column', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 5, name: 'GST Co', email: 'g@e.com', phone: '1', stateCode: '27', gst: '27ABCDE1234F1Z5' },
    ]);
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/customer-ledger?fy=FY2025-26&gstin=27ABCDE1234F1Z5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const callArgs = prisma.contact.findMany.mock.calls[0][0];
    expect(callArgs.where.gst).toBe('27ABCDE1234F1Z5');
  });
});

// ---------------------------------------------------------------------------
// /invoices/tds-register — G031
// ---------------------------------------------------------------------------

describe('GET /api/travel/invoices/tds-register', () => {
  test('401 when no token', async () => {
    const res = await request(makeApp()).get('/api/travel/invoices/tds-register?fy=FY2025-26');
    expect([401, 403]).toContain(res.status);
  });

  test('400 INVALID_FISCAL_YEAR on malformed fy', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/tds-register?fy=2025-26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FISCAL_YEAR');
  });

  test('400 INVALID_SECTION on unknown section', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/tds-register?fy=FY2025-26&section=194Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SECTION');
  });

  test('200 — empty register when no entries match', async () => {
    prisma.travelSupplierCommissionEntry.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/tds-register?fy=FY2025-26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.summary.totalDeducted).toBe(0);
  });

  test('200 — entries roll up across deductees + sections', async () => {
    prisma.travelSupplierCommissionEntry.findMany.mockResolvedValue([
      {
        id: 1,
        supplierId: 7,
        commissionAmount: 1000,
        tdsAmount: 50,
        accruedAt: new Date(Date.UTC(2025, 5, 10)),
        fiscalYear: 'FY2025-26',
        currency: 'INR',
        supplier: {
          id: 7,
          name: 'Vendor A',
          subBrand: 'tmc',
          gstin: '27ABCDE1234F1Z5',
          kyc: { panNumber: 'ABCDE1234F' },
        },
      },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/tds-register?fy=FY2025-26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].deducteeName).toBe('Vendor A');
    expect(res.body.entries[0].section).toBe('194H');
    expect(res.body.summary.totalDeducted).toBe(50);
  });

  test('?format=csv returns text/csv with Form-26Q header', async () => {
    prisma.travelSupplierCommissionEntry.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/tds-register?fy=FY2025-26&format=csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('paymentDate,deducteeName,deducteePan');
  });
});

// ---------------------------------------------------------------------------
// /invoices/commission-ledger — G032
// ---------------------------------------------------------------------------

describe('GET /api/travel/invoices/commission-ledger', () => {
  test('401 when no token', async () => {
    const res = await request(makeApp()).get('/api/travel/invoices/commission-ledger?fy=FY2025-26');
    expect([401, 403]).toContain(res.status);
  });

  test('400 INVALID_FISCAL_YEAR on malformed fy', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/commission-ledger?fy=2025')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FISCAL_YEAR');
  });

  test('400 INVALID_TYPE on unknown type', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/commission-ledger?fy=FY2025-26&type=foo')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TYPE');
  });

  test('200 — entries categorized correctly via supplier.supplierCategory', async () => {
    prisma.travelSupplierCommissionEntry.findMany.mockResolvedValue([
      {
        id: 1,
        supplierId: 7,
        baseAmount: 10000,
        commissionPercent: 7.5,
        commissionAmount: 750,
        tdsAmount: 37.5,
        netAmount: 712.5,
        status: 'accrued',
        accruedAt: new Date(Date.UTC(2025, 5, 10)),
        fiscalYear: 'FY2025-26',
        currency: 'INR',
        supplier: { id: 7, name: 'IATA Air Co', subBrand: 'tmc', supplierCategory: 'flight' },
      },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/commission-ledger?fy=FY2025-26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].category).toBe('iata_inward');
    expect(res.body.summary.totalAccrued).toBe(750);
    expect(res.body.summary.totalTds).toBe(37.5);
  });

  test('type=hotel filter narrows entries', async () => {
    prisma.travelSupplierCommissionEntry.findMany.mockResolvedValue([
      {
        id: 1, supplierId: 7,
        baseAmount: 1000, commissionAmount: 50, tdsAmount: 0, netAmount: 50,
        status: 'accrued', accruedAt: new Date(Date.UTC(2025, 5, 10)),
        fiscalYear: 'FY2025-26', currency: 'INR',
        supplier: { id: 7, name: 'X', subBrand: 'tmc', supplierCategory: 'flight' },
      },
      {
        id: 2, supplierId: 8,
        baseAmount: 1000, commissionAmount: 100, tdsAmount: 0, netAmount: 100,
        status: 'accrued', accruedAt: new Date(Date.UTC(2025, 5, 12)),
        fiscalYear: 'FY2025-26', currency: 'INR',
        supplier: { id: 8, name: 'Y', subBrand: 'tmc', supplierCategory: 'hotel' },
      },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/commission-ledger?fy=FY2025-26&type=hotel')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].category).toBe('hotel');
  });

  test('?format=csv returns text/csv with header row', async () => {
    prisma.travelSupplierCommissionEntry.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/invoices/commission-ledger?fy=FY2025-26&format=csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('date,supplierName,subBrand,category');
  });
});
