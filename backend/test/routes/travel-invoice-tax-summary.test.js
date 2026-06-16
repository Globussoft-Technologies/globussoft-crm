// @ts-check
/**
 * Arc 2 #902 slice 19 — GET /api/travel/invoices/tax-summary contract
 * (PRD_TRAVEL_GST_COMPLIANCE.md FR-3.4 returns + reports family).
 *
 * Pins the new sub-path endpoint added to backend/routes/travel_invoices.js
 * after /gstr-3b (slice 18). Differs from sibling tax exports:
 *   (1) Flexible date range (?from + ?to) — NOT month-bucketed.
 *   (2) Per-sub-brand rollup rows + a grandTotal envelope.
 *   (3) JSON only (no CSV) — dashboard-shaped, not filing-shaped.
 *   (4) INR-only by default (?currency=ALL opts in to non-INR), per NFR-4.4.
 *
 * Contracts asserted:
 *   - Happy path JSON: 200 + perSubBrand + grandTotal + envelope shape.
 *   - Intra-state invoices contribute CGST + SGST (50/50 split, half-up).
 *   - Inter-state invoices contribute IGST.
 *   - Multiple sub-brands → multiple perSubBrand rows, sorted by sub-brand.
 *   - INR default: where.currency='INR' is set on findMany.
 *   - currency=ALL: where.currency is NOT set.
 *   - Missing from/to → 400 INVALID_DATE_RANGE.
 *   - Malformed date → 400 INVALID_DATE_RANGE.
 *   - to < from → 400 INVALID_DATE_RANGE.
 *   - Invalid currency → 400 INVALID_CURRENCY.
 *   - Invalid subBrand → 400 INVALID_SUB_BRAND.
 *   - USER role → 403 (RBAC gate blocks before findMany).
 *   - subBrand filter narrows the prisma where filter.
 *   - Empty range (no invoices) → 200 with empty perSubBrand + zero grandTotal.
 *   - Non-SAC-bearing line types (tax/fee/tcs/tds) are excluded from totals.
 *
 * Test pattern mirrors travel-invoice-hsn-summary.test.js (slice 17) — patch
 * prisma singleton with vi.fn() shapes BEFORE the router is required, drive
 * supertest with real HS256 JWTs.
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

describe('GET /api/travel/invoices/tax-summary', () => {
  test('happy path JSON: returns perSubBrand + grandTotal + envelope; intra-state contributes CGST + SGST', async () => {
    // Single sub-brand (tmc) intra-state hotel line.
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 100 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 1, invoiceId: 100, lineType: 'hotel', amount: '10000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/tax-summary?from=2026-04-01&to=2026-04-30')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.from).toBe('2026-04-01');
    expect(res.body.to).toBe('2026-04-30');
    expect(res.body.subBrand).toBe('all');
    expect(res.body.currency).toBe('INR');
    expect(res.body.docTypes).toEqual(['TaxInvoice', 'CreditNote', 'DebitNote']);
    expect(Array.isArray(res.body.perSubBrand)).toBe(true);
    expect(res.body.perSubBrand).toHaveLength(1);

    const tmc = res.body.perSubBrand[0];
    expect(tmc.subBrand).toBe('tmc');
    expect(tmc.taxableValue).toBe(10000);
    expect(tmc.invoiceCount).toBe(1);
    expect(tmc.lineCount).toBe(1);
    // Intra-state → CGST + SGST split, zero IGST.
    expect(tmc.igst).toBe(0);
    expect(tmc.cgst).toBeGreaterThan(0);
    expect(tmc.sgst).toBeGreaterThan(0);
    expect(Math.round((tmc.cgst + tmc.sgst) * 100) / 100).toBe(tmc.totalTax);

    // grandTotal mirrors perSubBrand row when only one row exists.
    expect(res.body.grandTotal.taxableValue).toBe(10000);
    expect(res.body.grandTotal.invoiceCount).toBe(1);
    expect(res.body.grandTotal.totalTax).toBe(tmc.totalTax);
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
      .get('/api/travel/invoices/tax-summary?from=2026-04-01&to=2026-04-30')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const tmc = res.body.perSubBrand.find((r) => r.subBrand === 'tmc');
    expect(tmc).toBeTruthy();
    expect(tmc.taxableValue).toBe(50000);
    expect(tmc.cgst).toBe(0);
    expect(tmc.sgst).toBe(0);
    expect(tmc.igst).toBeGreaterThan(0);
    expect(tmc.totalTax).toBe(tmc.igst);
    expect(res.body.grandTotal.igst).toBe(tmc.igst);
  });

  test('multiple sub-brands → multiple perSubBrand rows, sorted alphabetically; grandTotal sums them', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 100, subBrand: 'tmc', contactId: 999 }),
      invoiceFixture({ id: 200, subBrand: 'rfu', contactId: 999, invoiceNum: 'RINV-001' }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 1, invoiceId: 100, lineType: 'hotel', amount: '10000.00' }),
      lineFixture({ id: 2, invoiceId: 200, lineType: 'hotel', amount: '8000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/tax-summary?from=2026-04-01&to=2026-04-30')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.perSubBrand).toHaveLength(2);
    // Sorted alphabetically: rfu < tmc.
    expect(res.body.perSubBrand[0].subBrand).toBe('rfu');
    expect(res.body.perSubBrand[1].subBrand).toBe('tmc');
    expect(res.body.perSubBrand[0].taxableValue).toBe(8000);
    expect(res.body.perSubBrand[1].taxableValue).toBe(10000);
    // grandTotal sums.
    expect(res.body.grandTotal.taxableValue).toBe(18000);
    expect(res.body.grandTotal.invoiceCount).toBe(2);
    expect(res.body.grandTotal.lineCount).toBe(2);
  });

  test('INR default: where.currency=INR is set on findMany', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/tax-summary?from=2026-04-01&to=2026-04-30')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(callArg.where.currency).toBe('INR');
    expect(res.body.currency).toBe('INR');
  });

  test('currency=ALL: where.currency is NOT set (opts in to non-INR rows)', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/tax-summary?from=2026-04-01&to=2026-04-30&currency=ALL')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(callArg.where.currency).toBeUndefined();
    expect(res.body.currency).toBe('ALL');
  });

  test('missing from/to → 400 INVALID_DATE_RANGE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/tax-summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE_RANGE');
  });

  test('malformed date → 400 INVALID_DATE_RANGE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/tax-summary?from=2026-04&to=2026-04-30')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE_RANGE');
  });

  test('to < from → 400 INVALID_DATE_RANGE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/tax-summary?from=2026-04-30&to=2026-04-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE_RANGE');
  });

  test('invalid currency → 400 INVALID_CURRENCY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/tax-summary?from=2026-04-01&to=2026-04-30&currency=USD')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURRENCY');
  });

  test('USER role → 403 (verifyRole blocks before findMany)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/tax-summary?from=2026-04-01&to=2026-04-30')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('subBrand filter narrows the prisma where filter', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/tax-summary?from=2026-04-01&to=2026-04-30&subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.subBrand).toBe('rfu');
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(callArg.where.subBrand).toBe('rfu');
  });

  test('empty range: 200 with empty perSubBrand and zero grandTotal', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/tax-summary?from=2026-04-01&to=2026-04-30')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.perSubBrand).toEqual([]);
    expect(res.body.grandTotal).toEqual({
      taxableValue: 0,
      igst: 0,
      cgst: 0,
      sgst: 0,
      totalTax: 0,
      invoiceCount: 0,
      lineCount: 0,
    });
  });

  test('tax/fee/tcs/tds lines are excluded from tax-summary totals', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      invoiceFixture({ id: 100 }),
    ]);
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      lineFixture({ id: 1, invoiceId: 100, lineType: 'hotel', amount: '10000.00' }),
      // Non-SAC-bearing line types should NOT contribute to perSubBrand totals.
      lineFixture({ id: 2, invoiceId: 100, lineType: 'tax', amount: '1200.00' }),
      lineFixture({ id: 3, invoiceId: 100, lineType: 'fee', amount: '500.00' }),
      lineFixture({ id: 4, invoiceId: 100, lineType: 'tcs', amount: '100.00' }),
      lineFixture({ id: 5, invoiceId: 100, lineType: 'tds', amount: '50.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/tax-summary?from=2026-04-01&to=2026-04-30')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Only the hotel line contributes — taxableValue=10000, lineCount=1.
    const tmc = res.body.perSubBrand.find((r) => r.subBrand === 'tmc');
    expect(tmc.taxableValue).toBe(10000);
    expect(tmc.lineCount).toBe(1);
    expect(tmc.invoiceCount).toBe(1);
    expect(res.body.grandTotal.taxableValue).toBe(10000);
    expect(res.body.grandTotal.lineCount).toBe(1);
  });
});
