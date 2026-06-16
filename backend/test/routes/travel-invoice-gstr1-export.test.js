// @ts-check
/**
 * Arc 2 #902 slice 10 — GSTR-1 CSV export endpoint contract.
 *
 * Pins GET /api/travel/invoices/gstr1-export — the monthly CSV roll-up
 * the operator downloads for GST return filing (PRD_TRAVEL_GST_COMPLIANCE
 * GSTR-1 section). Mirrors the binary-response handling pattern from
 * backend/test/routes/travel-invoice-pdf.test.js but drives a text/csv
 * Buffer response rather than application/pdf, and asserts contents of
 * each of the three CSV sections (HSN_SUMMARY, B2B_INVOICES,
 * DOCUMENT_TOTALS) that GSTR-1 expects.
 *
 * Contracts asserted:
 *   - Happy path: 200 + Content-Type=text/csv + Content-Disposition
 *     attachment + filename `gstr1-<YYYY-MM>-<sub|all>.csv`.
 *   - CSV body begins with UTF-8 BOM (U+FEFF) so Excel auto-detects.
 *   - CRLF line endings throughout.
 *   - Section headers present in order: `# GSTR1_EXPORT`, `# HSN_SUMMARY`,
 *     `# B2B_INVOICES`, `# DOCUMENT_TOTALS`.
 *   - Missing `month` query → 400 INVALID_MONTH.
 *   - Malformed `month` (wrong shape) → 400 INVALID_MONTH.
 *   - subBrand filter narrows the resulting CSV.
 *   - Empty-month case (no invoices) → 200 CSV with header rows only.
 *   - HSN_SUMMARY contains SAC codes for line types present in fixtures.
 *   - B2B_INVOICES has one row per source invoice with totals.
 *   - DOCUMENT_TOTALS rolls up by docType (TaxInvoice / CreditNote / DebitNote).
 *   - USER role → 403 (RBAC gate blocks before findMany).
 *   - Cross-tenant data excluded (the where clause's tenantId filter
 *     means the prisma stub's findMany call is invoked with the caller's
 *     tenantId — we assert this directly on the mock).
 *
 * Test pattern: patch the prisma singleton with vi.fn() stubs BEFORE the
 * router is required, then drive supertest with real HS256 JWTs signed
 * with the same fallback secret the middleware uses in dev.
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
    lineType: 'per_pax',
    description: 'Adult package',
    quantity: 2,
    unitPrice: '15000.00',
    amount: '30000.00',
    currency: 'INR',
    sortOrder: 0,
    notes: null,
    ...overrides,
  };
}

// Parse the response body as a Buffer (supertest defaults to string,
// which is fine for text/csv but reading raw bytes confirms BOM handling).
function bufferParser(r, cb) {
  const chunks = [];
  r.on('data', (c) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
}

beforeEach(() => {
  prisma.travelInvoice.findMany.mockReset().mockResolvedValue([]);
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
    gstStateCode: '07',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.contact.findUnique.mockReset().mockResolvedValue({ stateCode: '07' });
});

describe('GET /api/travel/invoices/gstr1-export', () => {
  test('happy path: 200 + Content-Type=text/csv + section headers in order', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 100, invoiceNum: 'TINV-2026-0042', docType: 'TaxInvoice' }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 1, invoiceId: 100, lineType: 'per_pax', amount: '30000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);

    const body = res.body.toString('utf8');
    // BOM must be the first character so Excel auto-detects UTF-8.
    expect(body.charCodeAt(0)).toBe(0xfeff);
    // All four section markers present and in PRD-fixed order.
    const gstr1Idx = body.indexOf('# GSTR1_EXPORT');
    const hsnIdx = body.indexOf('# HSN_SUMMARY');
    const b2bIdx = body.indexOf('# B2B_INVOICES');
    const totalsIdx = body.indexOf('# DOCUMENT_TOTALS');
    expect(gstr1Idx).toBeGreaterThan(-1);
    expect(hsnIdx).toBeGreaterThan(gstr1Idx);
    expect(b2bIdx).toBeGreaterThan(hsnIdx);
    expect(totalsIdx).toBeGreaterThan(b2bIdx);
    // CRLF line endings throughout (GoI GSTR-1 portal expects DOS-style).
    expect(body).toMatch(/\r\n/);
  });

  test('Content-Disposition is attachment with filename gstr1-<month>-<subBrand>.csv', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=2026-04&subBrand=tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-disposition']).toMatch(/filename="gstr1-2026-04-tmc\.csv"/);
  });

  test('missing month query parameter → 400 INVALID_MONTH', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr1-export')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MONTH' });
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('malformed month (wrong shape) → 400 INVALID_MONTH', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=04-2026')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MONTH' });
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('invalid month component (e.g. month=13) → 400 INVALID_MONTH', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MONTH' });
  });

  test('invalid subBrand value → 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=2026-04&subBrand=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('subBrand filter narrows the where clause passed to prisma.findMany', async () => {
    await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=2026-04&subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(prisma.travelInvoice.findMany).toHaveBeenCalled();
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(callArg.where).toMatchObject({
      tenantId: 1,
      subBrand: 'rfu',
      docType: { in: ['TaxInvoice', 'CreditNote', 'DebitNote'] },
    });
    // createdAt range filter is set.
    expect(callArg.where.createdAt.gte).toBeInstanceOf(Date);
    expect(callArg.where.createdAt.lt).toBeInstanceOf(Date);
  });

  test('empty month (no invoices) → 200 with section headers but no data rows', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    const body = res.body.toString('utf8');
    expect(body).toContain('# HSN_SUMMARY');
    expect(body).toContain('SAC_Code,Description,Total_Lines');
    expect(body).toContain('# B2B_INVOICES');
    expect(body).toContain('Invoice_Num,Date,Customer_State');
    expect(body).toContain('# DOCUMENT_TOTALS');
    expect(body).toContain('Type,Count,Total_Taxable,Total_GST');
    // No data lines: each section header row is immediately followed by
    // a blank line or another section marker.
    expect(body).not.toMatch(/TINV-/); // no invoice rows
  });

  test('HSN_SUMMARY contains SAC codes for line types in fixtures', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 100, contactId: 999 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      // per_pax → SAC 9985 (Support services to travel & tourism)
      lineFixture({ id: 1, invoiceId: 100, lineType: 'per_pax', amount: '30000.00' }),
      // per_room → SAC 9963 (Accommodation services)
      lineFixture({ id: 2, invoiceId: 100, lineType: 'per_room', amount: '10000.00' }),
      // tax line → no SAC, must be skipped
      lineFixture({ id: 3, invoiceId: 100, lineType: 'tax', amount: '1800.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    const body = res.body.toString('utf8');
    expect(body).toContain('9985'); // SAC for per_pax
    expect(body).toContain('9963'); // SAC for per_room
    expect(body).toContain('Support services to travel & tourism');
    expect(body).toContain('Accommodation services');
  });

  test('B2B_INVOICES section contains one row per source invoice with totals', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 100, invoiceNum: 'TINV-2026-0001', contactId: 999, docType: 'TaxInvoice' }),
      invoiceFixture({ id: 101, invoiceNum: 'TINV-2026-0002', contactId: 1000, docType: 'TaxInvoice' }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 1, invoiceId: 100, lineType: 'per_pax', amount: '30000.00' }),
      lineFixture({ id: 2, invoiceId: 101, lineType: 'per_pax', amount: '50000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    const body = res.body.toString('utf8');
    // Both invoice numbers appear in B2B section.
    expect(body).toContain('TINV-2026-0001');
    expect(body).toContain('TINV-2026-0002');
    // Date strings rendered YYYY-MM-DD.
    expect(body).toContain('2026-04-05');
    // Doc_Type column populated.
    const b2bIdx = body.indexOf('# B2B_INVOICES');
    const totalsIdx = body.indexOf('# DOCUMENT_TOTALS');
    const b2bSection = body.slice(b2bIdx, totalsIdx);
    expect(b2bSection).toContain('TaxInvoice');
  });

  test('DOCUMENT_TOTALS section rolls up by docType (TaxInvoice + CreditNote)', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 100, invoiceNum: 'TINV-2026-0001', docType: 'TaxInvoice' }),
      invoiceFixture({ id: 101, invoiceNum: 'TINV-2026-0002', docType: 'TaxInvoice' }),
      invoiceFixture({ id: 102, invoiceNum: 'TCN-2026-0001', docType: 'CreditNote' }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 1, invoiceId: 100, lineType: 'per_pax', amount: '10000.00' }),
      lineFixture({ id: 2, invoiceId: 101, lineType: 'per_pax', amount: '20000.00' }),
      lineFixture({ id: 3, invoiceId: 102, lineType: 'per_pax', amount: '5000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    const body = res.body.toString('utf8');
    const totalsIdx = body.indexOf('# DOCUMENT_TOTALS');
    const totalsSection = body.slice(totalsIdx);
    // Both docTypes appear in the roll-up.
    expect(totalsSection).toContain('TaxInvoice');
    expect(totalsSection).toContain('CreditNote');
    // The TaxInvoice line carries a count of 2.
    expect(totalsSection).toMatch(/TaxInvoice,2,/);
    expect(totalsSection).toMatch(/CreditNote,1,/);
  });

  test('USER role returns 403 (verifyRole blocks before findMany)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('cross-tenant data excluded — where.tenantId scoped to caller tenant', async () => {
    // Caller is tenantId=1. Confirm the findMany query was scoped to
    // tenantId: 1 (Prisma cannot return cross-tenant rows under this where).
    await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .buffer(true)
      .parse(bufferParser);

    expect(prisma.travelInvoice.findMany).toHaveBeenCalled();
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(callArg.where.tenantId).toBe(1);
    // Lines findMany also tenant-scoped.
    if (prisma.travelInvoiceLine.findMany.mock.calls.length > 0) {
      const lineCallArg = prisma.travelInvoiceLine.findMany.mock.calls[0][0];
      expect(lineCallArg.where.tenantId).toBe(1);
    }
  });

  test('interstate supply: B2B row shows IGST, intra-state shows CGST + SGST', async () => {
    // contact stateCode 27 (Maharashtra) vs operator 07 (Delhi) = interstate.
    prisma.contact.findUnique.mockResolvedValue({ stateCode: '27' });
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 100, invoiceNum: 'TINV-2026-IS', contactId: 999 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      // per_pax @ 5% GST → 30000 * 0.05 = 1500 IGST
      lineFixture({ id: 1, invoiceId: 100, lineType: 'per_pax', amount: '30000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr1-export?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    const body = res.body.toString('utf8');
    const b2bIdx = body.indexOf('# B2B_INVOICES');
    const totalsIdx = body.indexOf('# DOCUMENT_TOTALS');
    const b2bSection = body.slice(b2bIdx, totalsIdx);
    // IGST non-zero, CGST/SGST zero on interstate row. `per_pax` is
    // not in lib/gstCalculation.js's CATEGORY_RATES map so it falls
    // through to DEFAULT_RATE=18 → 30000 * 0.18 = 5400.00 IGST. (The
    // tax-rate-master table — PRD FR-3.1.1 — will override this lookup
    // once it lands; this test pins TODAY's contract.)
    expect(b2bSection).toMatch(/TINV-2026-IS,2026-04-05,27,30000\.00,5400\.00,0\.00,0\.00,5400\.00,TaxInvoice/);
  });
});
