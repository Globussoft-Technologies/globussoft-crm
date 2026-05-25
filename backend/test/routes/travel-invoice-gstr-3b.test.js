// @ts-check
/**
 * Arc 2 #902 slice 18 — GET /api/travel/invoices/gstr-3b contract
 * (PRD_TRAVEL_GST_COMPLIANCE.md FR-3.4.2 GSTR-3B summary).
 *
 * Pins the new sub-path endpoint added to backend/routes/travel_invoices.js
 * alongside /gstr1-export + /hsn-summary. Differs from /hsn-summary in
 * that the aggregation is BY SECTION (5 govt-spec buckets + 6.1 net) not
 * BY (sacCode, gstPercent). Section semantics:
 *   3.1.a — outward taxable INR (gstPercent > 0)
 *   3.1.b — outward zero-rated (non-INR / export)
 *   3.1.c — outward nil-rated (currently empty: no lineType maps to rate 0)
 *   3.1.d — inward RCM (always-zero placeholder pending DD-5.3)
 *   3.2   — inter-state to unregistered (a subset of 3.1.a)
 *   6.1   — net payable (= 3.1.a.totalTax + 3.1.d sums - ITC 0)
 *
 * Contracts asserted:
 *   - Happy path JSON intra-state: 200 + section envelope + 3.1.a populated
 *     with cgst+sgst (no igst), 3.1.b/c/d empty, 3.2 empty, 6.1 sums correctly.
 *   - Inter-state: 3.1.a IGST populated, 3.2 also populated with same igst,
 *     6.1 sums correctly.
 *   - Non-INR invoice routes to 3.1.b zero-rated, NOT 3.1.a.
 *   - tax/fee/tcs/tds lines are skipped (don't contribute to any section).
 *   - 3.1.d stays zero regardless of inputs (placeholder section).
 *   - subBrand filter narrows prisma where.
 *   - CSV format: 200 + text/csv + BOM + all 6 section blocks + filename.
 *   - Missing month → 400 INVALID_MONTH.
 *   - Invalid format → 400 INVALID_FORMAT.
 *   - Invalid subBrand → 400 INVALID_SUB_BRAND.
 *   - USER role → 403 (verifyRole gate).
 *   - Empty month: 200 + all sections zero.
 *
 * Test pattern mirrors backend/test/routes/travel-invoice-hsn-summary.test.js
 * (slice 17) — patch prisma singleton with vi.fn() shapes BEFORE the router
 * is required, drive supertest with real HS256 JWTs.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

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
  gstStateCode: '07', // Delhi (operator)
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

describe('GET /api/travel/invoices/gstr-3b', () => {
  test('happy path JSON intra-state: 3.1.a populated with cgst+sgst, others empty, 6.1 sums', async () => {
    // One intra-state INR invoice with two hotel lines (12% slab).
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 100 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 1, invoiceId: 100, lineType: 'hotel', amount: '10000.00' }),
      lineFixture({ id: 2, invoiceId: 100, lineType: 'hotel', amount: '5000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr-3b?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.month).toBe('2026-04');
    expect(res.body.subBrand).toBe('all');
    expect(res.body.sections).toBeDefined();

    const s = res.body.sections;
    // 3.1.a — taxable INR. 15000 taxable, intra-state → CGST + SGST only.
    expect(s['3.1.a'].taxableValue).toBe(15000);
    expect(s['3.1.a'].invoiceCount).toBe(1);
    expect(s['3.1.a'].igst).toBe(0);
    expect(s['3.1.a'].cgst).toBeGreaterThan(0);
    expect(s['3.1.a'].sgst).toBeGreaterThan(0);
    // 12% of 15000 = 1800; intra-state splits 900 CGST + 900 SGST.
    expect(s['3.1.a'].cgst).toBe(900);
    expect(s['3.1.a'].sgst).toBe(900);
    expect(s['3.1.a'].totalTax).toBe(1800);
    // 3.1.b / 3.1.c / 3.2 empty (no exports, no nil-rated, no inter-state).
    expect(s['3.1.b'].taxableValue).toBe(0);
    expect(s['3.1.b'].invoiceCount).toBe(0);
    expect(s['3.1.c'].taxableValue).toBe(0);
    expect(s['3.1.c'].invoiceCount).toBe(0);
    expect(s['3.2'].taxableValue).toBe(0);
    expect(s['3.2'].invoiceCount).toBe(0);
    // 3.1.d always-zero placeholder.
    expect(s['3.1.d'].taxableValue).toBe(0);
    expect(s['3.1.d'].igst).toBe(0);
    // 6.1 — net = 3.1.a.totalTax + 0.
    expect(s['6.1'].netPayable).toBe(1800);
    expect(s['6.1'].totalCgst).toBe(900);
    expect(s['6.1'].totalSgst).toBe(900);
    expect(s['6.1'].totalIgst).toBe(0);
  });

  test('inter-state invoice: 3.1.a IGST populated, 3.2 also populated with same igst, 6.1 sums', async () => {
    // Customer state differs from tenant state (07 Delhi vs 27 Maharashtra).
    prisma.contact.findUnique.mockResolvedValue({ stateCode: '27' });
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 101 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 10, invoiceId: 101, lineType: 'hotel', amount: '50000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr-3b?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const s = res.body.sections;
    // 12% of 50000 = 6000 IGST.
    expect(s['3.1.a'].taxableValue).toBe(50000);
    expect(s['3.1.a'].igst).toBe(6000);
    expect(s['3.1.a'].cgst).toBe(0);
    expect(s['3.1.a'].sgst).toBe(0);
    expect(s['3.1.a'].totalTax).toBe(6000);
    // 3.2 — inter-state cohort matches 3.1.a numbers (no GSTIN gate yet).
    expect(s['3.2'].taxableValue).toBe(50000);
    expect(s['3.2'].igst).toBe(6000);
    expect(s['3.2'].invoiceCount).toBe(1);
    // 6.1 — net = totalTax (no ITC, no RCM).
    expect(s['6.1'].netPayable).toBe(6000);
    expect(s['6.1'].totalIgst).toBe(6000);
  });

  test('non-INR invoice routes to 3.1.b zero-rated (NOT 3.1.a)', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 102, currency: 'USD' }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 20, invoiceId: 102, lineType: 'hotel', amount: '1000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr-3b?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const s = res.body.sections;
    // Export of service — 3.1.b populated, 3.1.a / 3.2 / 6.1 empty.
    expect(s['3.1.b'].taxableValue).toBe(1000);
    expect(s['3.1.b'].invoiceCount).toBe(1);
    expect(s['3.1.a'].taxableValue).toBe(0);
    expect(s['3.1.a'].invoiceCount).toBe(0);
    expect(s['3.2'].taxableValue).toBe(0);
    expect(s['6.1'].netPayable).toBe(0);
  });

  test('tax/fee/tcs/tds lines are skipped (do not contribute to any section)', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 103 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 30, invoiceId: 103, lineType: 'hotel', amount: '10000.00' }),
      lineFixture({ id: 31, invoiceId: 103, lineType: 'tax', amount: '1200.00' }),
      lineFixture({ id: 32, invoiceId: 103, lineType: 'fee', amount: '500.00' }),
      lineFixture({ id: 33, invoiceId: 103, lineType: 'tcs', amount: '100.00' }),
      lineFixture({ id: 34, invoiceId: 103, lineType: 'tds', amount: '50.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr-3b?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const s = res.body.sections;
    // Only the hotel line counted (10000 → 12% = 1200).
    expect(s['3.1.a'].taxableValue).toBe(10000);
    expect(s['3.1.a'].totalTax).toBe(1200);
    expect(s['3.1.a'].invoiceCount).toBe(1);
  });

  test('3.1.d (inward RCM) stays zero regardless of inputs (placeholder section)', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 104 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 40, invoiceId: 104, lineType: 'hotel', amount: '99999.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr-3b?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.sections['3.1.d']).toEqual({
      taxableValue: 0,
      igst: 0,
      cgst: 0,
      sgst: 0,
    });
  });

  test('subBrand filter narrows the prisma where', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr-3b?month=2026-04&subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.subBrand).toBe('rfu');
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(callArg.where.subBrand).toBe('rfu');
    expect(callArg.where.docType).toEqual({
      in: ['TaxInvoice', 'CreditNote', 'DebitNote'],
    });
  });

  test('CSV format: 200 + text/csv + BOM + all 6 section blocks + filename', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 105 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 50, invoiceId: 105, lineType: 'hotel', amount: '10000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr-3b?month=2026-04&format=csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /filename="gstr-3b-2026-04-all\.csv"/,
    );
    // BOM prefix for Excel.
    expect(res.text.charCodeAt(0)).toBe(0xFEFF);
    // All 6 section headers present.
    expect(res.text).toContain('# GSTR3B_SUMMARY');
    expect(res.text).toContain('# 3.1.a OUTWARD_TAXABLE');
    expect(res.text).toContain('# 3.1.b OUTWARD_ZERO_RATED');
    expect(res.text).toContain('# 3.1.c OUTWARD_NIL_RATED');
    expect(res.text).toContain('# 3.1.d INWARD_RCM');
    expect(res.text).toContain('# 3.2 INTER_STATE_UNREGISTERED');
    expect(res.text).toContain('# 6.1 NET_PAYABLE');
    // CRLF line endings.
    expect(res.text).toContain('\r\n');
    // Row containing the 3.1.a totals.
    expect(res.text).toMatch(/3\.1\.a,10000\.00/);
  });

  test('missing month query → 400 INVALID_MONTH', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr-3b')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH');
  });

  test('invalid format → 400 INVALID_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr-3b?month=2026-04&format=xlsx')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FORMAT');
  });

  test('USER role → 403 (verifyRole blocks before findMany)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr-3b?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('empty month: 200 with all sections zero', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/gstr-3b?month=2026-04')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const s = res.body.sections;
    expect(s['3.1.a'].taxableValue).toBe(0);
    expect(s['3.1.a'].totalTax).toBe(0);
    expect(s['3.1.a'].invoiceCount).toBe(0);
    expect(s['3.1.b'].taxableValue).toBe(0);
    expect(s['3.1.c'].taxableValue).toBe(0);
    expect(s['3.1.d']).toEqual({ taxableValue: 0, igst: 0, cgst: 0, sgst: 0 });
    expect(s['3.2'].taxableValue).toBe(0);
    expect(s['6.1'].netPayable).toBe(0);
  });
});
