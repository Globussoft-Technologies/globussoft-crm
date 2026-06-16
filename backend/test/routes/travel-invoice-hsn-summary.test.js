// @ts-check
/**
 * Arc 2 #902 slice 17 — GET /api/travel/invoices/hsn-summary contract
 * (PRD_TRAVEL_GST_COMPLIANCE.md FR-3.4.3 HSN/SAC summary report).
 *
 * Pins the new sub-path endpoint added to backend/routes/travel_invoices.js
 * alongside /gstr1-export + /aged-receivable. Differs from /gstr1-export
 * in three ways:
 *   (1) JSON by default; ?format=csv opts into the CSV alternate.
 *   (2) Single section only — no B2B_INVOICES / DOCUMENT_TOTALS roll-ups.
 *   (3) ?docType= optional narrowing filter.
 *
 * Contracts asserted:
 *   - Happy path JSON: 200 + rows + totals + month + subBrand + docTypes envelope.
 *   - HSN buckets group by (sacCode, gstPercent) and sum taxableValue + counts.
 *   - Intra-state invoices contribute CGST + SGST (50/50 split, half-up).
 *   - Inter-state invoices contribute IGST.
 *   - CSV format: 200 + text/csv + BOM + CRLF + single-section layout +
 *     filename `hsn-summary-<month>-<sub|all>.csv`.
 *   - Missing month → 400 INVALID_MONTH.
 *   - Malformed month (wrong shape) → 400 INVALID_MONTH.
 *   - Invalid subBrand → 400 INVALID_SUB_BRAND.
 *   - Invalid docType → 400 INVALID_DOC_TYPE.
 *   - Invalid format → 400 INVALID_FORMAT.
 *   - USER role → 403 (RBAC gate blocks before findMany).
 *   - subBrand filter narrows the prisma where filter.
 *   - docType filter narrows to a single doc-type cohort.
 *   - Empty-month case (no invoices) → 200 with empty rows + zero totals.
 *
 * Test pattern mirrors backend/test/routes/travel-invoice-gstr1-export.test.js
 * (slice 10) — patch prisma singleton with vi.fn() shapes BEFORE the router
 * is required, drive supertest with real HS256 JWTs.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelInvoice = {
  findMany: vi.fn().mockResolvedValue([]),
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
  gstStateCode: '07', // Delhi
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn().mockResolvedValue({ stateCode: '07' }); // intra-state default
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

function invoiceFixture(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    invoiceNum: 'TINV-2026-0042',
    status: 'Issued',
    totalAmount: '45000.00',
    currency: 'INR',
    dueDate: new Date('2026-04-14'),
    issuedDate: new Date('2026-04-01'),
    docType: 'TaxInvoice',
    createdAt: new Date('2026-04-05T10:00:00.000Z'),
    updatedAt: new Date('2026-04-05T10:00:00.000Z'),
    ...overrides,
  };
}

function lineFixture(overrides = {}) {
  return {
    id: 1,
    invoiceId: 100,
    tenantId: 1,
    lineType: 'hotel',
    description: 'Hotel night',
    amount: '10000.00',
    sortOrder: 1,
    createdAt: new Date('2026-04-05'),
    updatedAt: new Date('2026-04-05'),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findMany.mockReset().mockResolvedValue([]);
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
    gstStateCode: '07',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
  prisma.contact.findUnique.mockReset().mockResolvedValue({ stateCode: '07' });
});

describe('GET /api/travel/invoices/hsn-summary', () => {
  test('happy path JSON: returns rows + totals + envelope; intra-state contributes CGST + SGST', async () => {
    // Two hotel lines (SAC 9963) + one flight line (SAC 9964), intra-state
    // contact (state 07 == tenant state 07).
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 100 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 1, invoiceId: 100, lineType: 'hotel', amount: '10000.00' }),
      lineFixture({ id: 2, invoiceId: 100, lineType: 'hotel', amount: '5000.00' }),
      lineFixture({ id: 3, invoiceId: 100, lineType: 'flight', amount: '20000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/hsn-summary?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.month).toBe('2026-04');
    expect(res.body.subBrand).toBe('all');
    expect(res.body.docTypes).toEqual(['TaxInvoice', 'CreditNote', 'DebitNote']);
    expect(Array.isArray(res.body.rows)).toBe(true);
    // Two SAC cohorts (9963 hotel x 12% GST, 9964 flight x 5% GST).
    const hotel = res.body.rows.find((r) => r.sacCode === '9963');
    const flight = res.body.rows.find((r) => r.sacCode === '9964');
    expect(hotel).toBeTruthy();
    expect(flight).toBeTruthy();
    // Hotel: 10000 + 5000 = 15000 taxable, 2 lines. Intra-state → CGST+SGST.
    expect(hotel.taxableValue).toBe(15000);
    expect(hotel.count).toBe(2);
    expect(hotel.igst).toBe(0);
    expect(hotel.cgst).toBeGreaterThan(0);
    expect(hotel.sgst).toBeGreaterThan(0);
    // CGST + SGST = total tax.
    expect(Math.round((hotel.cgst + hotel.sgst) * 100) / 100).toBe(hotel.totalTax);
    // Flight: 20000 taxable, 1 line.
    expect(flight.taxableValue).toBe(20000);
    expect(flight.count).toBe(1);
    // Sorted by sacCode ascending.
    expect(res.body.rows[0].sacCode).toBe('9963');
    expect(res.body.rows[1].sacCode).toBe('9964');
    // Totals sum across all rows.
    expect(res.body.totals.taxableValue).toBe(35000);
    expect(res.body.totals.lineCount).toBe(3);
    expect(res.body.totals.totalTax).toBe(
      Math.round((hotel.totalTax + flight.totalTax) * 100) / 100,
    );
  });

  test('inter-state invoice routes tax to IGST (zero CGST/SGST)', async () => {
    // Customer state differs from tenant state (07 Delhi vs 27 Maharashtra).
    prisma.contact.findUnique.mockResolvedValue({ stateCode: '27' });
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 101 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 10, invoiceId: 101, lineType: 'hotel', amount: '50000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/hsn-summary?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const hotel = res.body.rows.find((r) => r.sacCode === '9963');
    expect(hotel).toBeTruthy();
    expect(hotel.taxableValue).toBe(50000);
    expect(hotel.cgst).toBe(0);
    expect(hotel.sgst).toBe(0);
    expect(hotel.igst).toBeGreaterThan(0);
    expect(hotel.totalTax).toBe(hotel.igst);
  });

  test('CSV format: 200 + text/csv + BOM + single-section + filename attachment', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 100 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 1, invoiceId: 100, lineType: 'hotel', amount: '10000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/hsn-summary?month=2026-04&format=csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /filename="hsn-summary-2026-04-all\.csv"/,
    );
    // BOM prefix for Excel.
    expect(res.text.charCodeAt(0)).toBe(0xFEFF);
    // Single # HSN_SUMMARY comment line, NOT the gstr1's three-section layout.
    expect(res.text).toContain('# HSN_SUMMARY');
    expect(res.text).not.toContain('# B2B_INVOICES');
    expect(res.text).not.toContain('# DOCUMENT_TOTALS');
    // Header row.
    expect(res.text).toContain('SAC_Code,Description,GST_Rate,Total_Lines,Taxable_Value,IGST,CGST,SGST,Total_Tax');
    // 9963 row present.
    expect(res.text).toContain('9963');
    // CRLF line endings.
    expect(res.text).toContain('\r\n');
  });

  test('missing month query → 400 INVALID_MONTH', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/hsn-summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH');
  });

  test('malformed month query → 400 INVALID_MONTH', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/hsn-summary?month=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH');
  });

  test('invalid format → 400 INVALID_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/hsn-summary?month=2026-04&format=xlsx')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FORMAT');
  });

  test('invalid docType → 400 INVALID_DOC_TYPE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/hsn-summary?month=2026-04&docType=Proforma')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DOC_TYPE');
  });

  test('docType filter narrows the prisma where to a single cohort', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/hsn-summary?month=2026-04&docType=CreditNote')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.docTypes).toEqual(['CreditNote']);
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(callArg.where.docType).toEqual({ in: ['CreditNote'] });
  });

  test('subBrand filter narrows the prisma where filter', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/hsn-summary?month=2026-04&subBrand=tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.subBrand).toBe('tmc');
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(callArg.where.subBrand).toBe('tmc');
  });

  test('USER role → 403 (verifyRole blocks before findMany)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/hsn-summary?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('empty month: 200 with empty rows and zero totals', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/hsn-summary?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.totals).toEqual({
      taxableValue: 0,
      igst: 0,
      cgst: 0,
      sgst: 0,
      totalTax: 0,
      lineCount: 0,
    });
  });

  test('tax/fee/tcs/tds lines are excluded from HSN-summary buckets', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 100 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 1, invoiceId: 100, lineType: 'hotel', amount: '10000.00' }),
      // Non-SAC-bearing line types should NOT contribute to any bucket.
      lineFixture({ id: 2, invoiceId: 100, lineType: 'tax', amount: '1200.00' }),
      lineFixture({ id: 3, invoiceId: 100, lineType: 'fee', amount: '500.00' }),
      lineFixture({ id: 4, invoiceId: 100, lineType: 'tcs', amount: '100.00' }),
      lineFixture({ id: 5, invoiceId: 100, lineType: 'tds', amount: '50.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/hsn-summary?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Only the hotel line should appear — totals.lineCount === 1.
    expect(res.body.totals.lineCount).toBe(1);
    expect(res.body.totals.taxableValue).toBe(10000);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].sacCode).toBe('9963');
  });
});
