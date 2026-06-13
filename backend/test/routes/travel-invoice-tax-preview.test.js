// @ts-check
/**
 * Arc 2 #902 slice 7 — TravelInvoice tax-preview endpoint
 * (PRD_TRAVEL_GST_COMPLIANCE.md FR-3.2.3 / FR-3.4.3 / NFR-4.2).
 *
 * Pins the read-only GST-composition endpoint added to
 * backend/routes/travel_invoices.js by slice 7:
 *
 *   GET /api/travel/invoices/:id/tax-preview     any verified token
 *
 * Mirrors slice 6's TravelQuote analog endpoint (commit b9833a0e —
 * /quotes/:id/tax-preview) — identical envelope, identical library
 * consumers, scoped to TravelInvoiceLine instead of TravelQuoteLine.
 *
 * Library consumers verified:
 *   - lib/gstCalculation.js (slice 1, ced09867) — CGST/SGST/IGST math
 *     + place-of-supply decision + per-category rate lookup.
 *   - lib/gstStateCodeResolver.js (slice 4 wire-in, faf40fa4) —
 *     resolves operator/customer state codes from query overrides /
 *     Tenant.gstStateCode / Contact.stateCode.
 *   - lib/hsnSacMapper.js (slice 5+6, 6aca2361/b9833a0e) — per-line SAC
 *     code + description + GSTR-1 HSN-summary grouping.
 *
 * Invoice-specific lineType decisions verified:
 *   - per_room / per_night → SAC 9963 (accommodation).
 *   - per_pax / per_trip / addon → SAC 9985 (travel-tourism support).
 *   - tax / fee / tcs / tds → SAC null → skipped in hsnSummary (these
 *     are withholdings, not GST output — reported on Form 27EQ).
 *   - gstRateForCategory does NOT know invoice-specific types so they
 *     fall through to DEFAULT_RATE (18%) — verified explicitly.
 *
 * Contracts asserted:
 *   - Loads parent invoice via loadParentInvoice (tenant + sub-brand
 *     scoped — same INVALID_ID / INVOICE_NOT_FOUND / SUB_BRAND_DENIED
 *     shape as every other invoice child endpoint).
 *   - invoiceId echoed back in the response envelope (mirrors the
 *     pattern used by the invoice TCS-preview endpoint).
 *   - Intra-state: cgst + sgst (half-rate each), igst=0.
 *   - Inter-state: igst at full rate, cgst=sgst=0.
 *   - Default behaviour (no query params) → resolves via Tenant +
 *     Contact then falls back to "IN-MH" / mirrored when both null.
 *   - Empty-string state-code query → 400 INVALID_STATE_CODE
 *     (defense-in-depth on top of resolver's empty=no-override).
 *   - SAC code + description appear on every per-line entry.
 *   - hsnSummary present + groups by (sacCode, gstPercent).
 *   - Envelope-level totals come from bucket summary
 *     (computeGstForLines) — invariants hold tightly:
 *       totalTax === totalCgst + totalSgst + totalIgst
 *       subtotal + totalTax === grandTotal  (to 2 decimals)
 *   - Empty invoice (zero lines) → all-zero envelope, lines=[],
 *     buckets=[], hsnSummary=[].
 *
 * Pattern mirrors backend/test/routes/travel-quote-tax-preview.test.js
 * (commit 1b4bb86c → b9833a0e): CJS prisma singleton patched BEFORE
 * the router is required so verifyToken's revokedToken probe +
 * loadParentInvoice's findFirst probe both hit stubs; HS256 JWT via
 * the dev fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelInvoice = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoiceLine = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn().mockResolvedValue(null);
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'USER', subBrandAccess: null });
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

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
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
    status: 'Draft',
    totalAmount: '15000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 7 * 86_400_000),
    paidAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeLine(overrides = {}) {
  return {
    id: 555,
    tenantId: 1,
    invoiceId: 100,
    lineType: 'per_night',
    description: 'Hilton Mumbai — 3 nights',
    quantity: 3,
    unitPrice: '1000.00',
    amount: '1000.00',
    currency: 'INR',
    sortOrder: 0,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Default tenant.findUnique impl that discriminates on the select
 * shape so the middleware (requireTravelTenant, selects
 * vertical/name/slug) and the slice-4 resolver (resolveStateCodes,
 * selects gstStateCode) can both share the same Prisma surface
 * without trampling each other. Individual tests override via
 * mockImplementation when they want non-null gstStateCode.
 */
function defaultTenantFindUniqueImpl({ select } = {}) {
  if (select && select.gstStateCode) {
    return Promise.resolve(null); // no DB value populated by default
  }
  return Promise.resolve({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockImplementation(defaultTenantFindUniqueImpl);
  prisma.contact.findUnique.mockReset().mockResolvedValue(null);
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/invoices/:id/tax-preview — happy paths', () => {
  test('intra-state per_night ₹1000 @ 18% (default) → cgst=90, sgst=90, igst=0', async () => {
    // per_night isn't in CATEGORY_RATES, so gstRateForCategory falls
    // through to DEFAULT_RATE = 18 (operator-safe — highest common
    // slab; tax-rate-master FR-3.1 will override per-tenant).
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      makeLine({ id: 555, lineType: 'per_night', amount: '1000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview?operatorStateCode=IN-MH&customerStateCode=IN-MH')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.invoiceId).toBe(100);
    expect(res.body.subtotal).toBe(1000);
    expect(res.body.isInterstate).toBe(false);
    expect(res.body.operatorStateCode).toBe('IN-MH');
    expect(res.body.customerStateCode).toBe('IN-MH');
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0]).toMatchObject({
      id: 555,
      lineType: 'per_night',
      amount: 1000,
      gstPercent: 18,
      cgst: 90,
      sgst: 90,
      igst: 0,
      totalTax: 180,
      amountWithTax: 1180,
    });
    expect(res.body.totalCgst).toBe(90);
    expect(res.body.totalSgst).toBe(90);
    expect(res.body.totalIgst).toBe(0);
    expect(res.body.totalTax).toBe(180);
    expect(res.body.grandTotal).toBe(1180);
    expect(res.body.buckets).toHaveLength(1);
    expect(res.body.buckets[0]).toMatchObject({
      gstPercent: 18, cgst: 90, sgst: 90, igst: 0, totalTax: 180,
    });
  });

  test('inter-state per_night ₹1000 @ 18% → igst=180, cgst=0, sgst=0', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      makeLine({ id: 555, lineType: 'per_night', amount: '1000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview?operatorStateCode=IN-MH&customerStateCode=IN-KA')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.isInterstate).toBe(true);
    expect(res.body.operatorStateCode).toBe('IN-MH');
    expect(res.body.customerStateCode).toBe('IN-KA');
    expect(res.body.lines[0]).toMatchObject({
      gstPercent: 18, cgst: 0, sgst: 0, igst: 180, totalTax: 180, amountWithTax: 1180,
    });
    expect(res.body.totalCgst).toBe(0);
    expect(res.body.totalSgst).toBe(0);
    expect(res.body.totalIgst).toBe(180);
    expect(res.body.grandTotal).toBe(1180);
  });

  test('per-line SAC code + description: per_room → 9963 accommodation, per_pax → 9985 travel-tourism', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'per_room', amount: '5000.00' }),
      makeLine({ id: 2, lineType: 'per_pax', amount: '2000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview?operatorStateCode=IN-MH&customerStateCode=IN-MH')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines[0]).toMatchObject({
      lineType: 'per_room',
      sacCode: '9963',
      sacDescription: 'Accommodation services',
    });
    expect(res.body.lines[1]).toMatchObject({
      lineType: 'per_pax',
      sacCode: '9985',
      sacDescription: 'Support services to travel & tourism',
    });
  });

  test('hsnSummary groups distinct (sacCode, gstPercent) pairs and sums taxable + count', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'per_room', amount: '5000.00' }),    // 9963 @ 18%
      makeLine({ id: 2, lineType: 'per_night', amount: '3000.00' }),   // 9963 @ 18% (same group)
      makeLine({ id: 3, lineType: 'per_pax', amount: '2000.00' }),     // 9985 @ 18%
      makeLine({ id: 4, lineType: 'addon', amount: '500.00' }),        // 9985 @ 18% (same group as per_pax)
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.hsnSummary)).toBe(true);
    // 2 distinct (sacCode, gstPercent) pairs: (9963,18) and (9985,18)
    expect(res.body.hsnSummary).toHaveLength(2);
    const accomGroup = res.body.hsnSummary.find((g) => g.sacCode === '9963');
    expect(accomGroup).toBeDefined();
    expect(accomGroup.count).toBe(2);
    expect(accomGroup.taxableValue).toBe(8000); // 5000 + 3000
    expect(accomGroup.gstPercent).toBe(18);
    expect(accomGroup.description).toBe('Accommodation services');

    const travelGroup = res.body.hsnSummary.find((g) => g.sacCode === '9985');
    expect(travelGroup).toBeDefined();
    expect(travelGroup.count).toBe(2);
    expect(travelGroup.taxableValue).toBe(2500); // 2000 + 500
  });

  test('tax/fee/tcs/tds lines have null sacCode AND are skipped from hsnSummary (withholdings → Form 27EQ, not GSTR-1)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'per_room', amount: '5000.00' }),    // 9963 — included
      makeLine({ id: 2, lineType: 'tax', amount: '100.00' }),          // null SAC — skipped from hsn
      makeLine({ id: 3, lineType: 'fee', amount: '50.00' }),           // null SAC — skipped
      makeLine({ id: 4, lineType: 'tcs', amount: '250.00' }),          // null SAC — skipped
      makeLine({ id: 5, lineType: 'tds', amount: '40.00' }),           // null SAC — skipped
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Per-line: each withholding line carries null sacCode
    const taxLine = res.body.lines.find((l) => l.lineType === 'tax');
    const feeLine = res.body.lines.find((l) => l.lineType === 'fee');
    const tcsLine = res.body.lines.find((l) => l.lineType === 'tcs');
    const tdsLine = res.body.lines.find((l) => l.lineType === 'tds');
    expect(taxLine.sacCode).toBeNull();
    expect(taxLine.sacDescription).toBeNull();
    expect(feeLine.sacCode).toBeNull();
    expect(tcsLine.sacCode).toBeNull();
    expect(tdsLine.sacCode).toBeNull();
    // hsnSummary: only the per_room line is grouped
    expect(res.body.hsnSummary).toHaveLength(1);
    expect(res.body.hsnSummary[0].sacCode).toBe('9963');
    expect(res.body.hsnSummary[0].count).toBe(1);
    expect(res.body.hsnSummary[0].taxableValue).toBe(5000);
  });

  test('empty invoice (zero lines) → subtotal=0, all tax=0, lines=[], buckets=[], hsnSummary=[]', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      invoiceId: 100,
      subtotal: 0,
      totalCgst: 0,
      totalSgst: 0,
      totalIgst: 0,
      totalTax: 0,
      grandTotal: 0,
      lines: [],
      buckets: [],
      hsnSummary: [],
    });
  });

  test('default behaviour (no query params, no DB state codes) → operator=customer="IN-MH" → intra-state', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'per_room', amount: '1000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.operatorStateCode).toBe('IN-MH');
    expect(res.body.customerStateCode).toBe('IN-MH');
    expect(res.body.isInterstate).toBe(false);
    // per_room @ 18% on 1000 → cgst 90 + sgst 90
    expect(res.body.lines[0].cgst).toBe(90);
    expect(res.body.lines[0].sgst).toBe(90);
    expect(res.body.lines[0].igst).toBe(0);
  });

  test('default behaviour (Tenant.gstStateCode set + Contact.stateCode set) → resolver picks DB values (inter-state)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice({ contactId: 999 }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'per_room', amount: '1000.00' }),
    ]);
    prisma.tenant.findUnique.mockImplementation(({ select } = {}) => {
      if (select && select.gstStateCode) {
        return Promise.resolve({ gstStateCode: 'IN-DL' });
      }
      return Promise.resolve({
        id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
      });
    });
    prisma.contact.findUnique.mockResolvedValue({ stateCode: 'IN-KA' });

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.operatorStateCode).toBe('IN-DL');
    expect(res.body.customerStateCode).toBe('IN-KA');
    expect(res.body.isInterstate).toBe(true);
    // Inter-state per_room ₹1000 @ 18% → igst=180, cgst=sgst=0
    expect(res.body.lines[0]).toMatchObject({ cgst: 0, sgst: 0, igst: 180 });
    // Verify resolver actually consulted Contact.findUnique with the
    // billingStateCode + stateCode select. G034 (FR-3.5.2) added
    // billingStateCode to the select so the resolver can prefer the
    // billing-address state over residence state — the shape is now
    // a two-column select.
    expect(prisma.contact.findUnique).toHaveBeenCalledWith({
      where: { id: 999 },
      select: { stateCode: true, billingStateCode: true },
    });
  });

  test('envelope consistency: totalTax === totalCgst + totalSgst + totalIgst AND subtotal + totalTax === grandTotal (rounding-safe)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'per_room',  amount: '7777.77' }),    // 18%
      makeLine({ id: 2, lineType: 'per_pax',   amount: '3333.33' }),    // 18%
      makeLine({ id: 3, lineType: 'per_trip',  amount: '1234.56' }),    // 18%
      makeLine({ id: 4, lineType: 'addon',     amount: '999.99' }),     // 18%
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview?operatorStateCode=IN-MH&customerStateCode=IN-KA')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    const sumCgstSgstIgst = Math.round(
      (res.body.totalCgst + res.body.totalSgst + res.body.totalIgst) * 100,
    ) / 100;
    expect(sumCgstSgstIgst).toBe(res.body.totalTax);

    const subPlusTax = Math.round(
      (res.body.subtotal + res.body.totalTax) * 100,
    ) / 100;
    expect(subPlusTax).toBe(res.body.grandTotal);

    // Inter-state → all tax is IGST, cgst+sgst should both be 0.
    expect(res.body.totalCgst).toBe(0);
    expect(res.body.totalSgst).toBe(0);
    expect(res.body.isInterstate).toBe(true);
  });
});

describe('GET /api/travel/invoices/:id/tax-preview — auth / scoping / validation', () => {
  test('cross-tenant parent → 404 INVOICE_NOT_FOUND (and line query NOT issued)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INVOICE_NOT_FOUND');
    expect(prisma.travelInvoiceLine.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand denial → 403 SUB_BRAND_DENIED', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice({ subBrand: 'rfu' }));
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
    expect(prisma.travelInvoiceLine.findMany).not.toHaveBeenCalled();
  });

  test('non-numeric :id → 400 INVALID_ID (and findFirst NOT issued)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/notanumber/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
  });

  test('empty-string operatorStateCode → 400 INVALID_STATE_CODE (and resolver/line-query NOT invoked)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview?operatorStateCode=&customerStateCode=IN-MH')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATE_CODE');
    expect(prisma.travelInvoiceLine.findMany).not.toHaveBeenCalled();
  });

  test('empty-string customerStateCode → 400 INVALID_STATE_CODE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/tax-preview?operatorStateCode=IN-MH&customerStateCode=')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATE_CODE');
    expect(prisma.travelInvoiceLine.findMany).not.toHaveBeenCalled();
  });

  test('no auth header → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/invoices/100/tax-preview');
    expect(res.status).toBe(401);
  });
});
