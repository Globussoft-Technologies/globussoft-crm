// @ts-check
/**
 * Arc 2 #902 slice 2 — TravelQuote tax-preview endpoint
 * (PRD_TRAVEL_GST_COMPLIANCE.md FR-3.2.3 / FR-3.4.3 / NFR-4.2).
 *
 * Pins the read-only GST-composition endpoint added to
 * backend/routes/travel_quotes.js by slice 2:
 *
 *   GET /api/travel/quotes/:id/tax-preview     any verified token
 *
 * Consumes lib/gstCalculation.js (commit ced09867) — the pure
 * CGST/SGST/IGST math + place-of-supply decision + per-category rate
 * lookup. Place-of-supply state codes come from query params
 * (?operatorStateCode= + ?customerStateCode=) for slice 2; slice 3 will
 * pull from Tenant.gstStateCode + Contact.stateCode.
 *
 * Contracts asserted:
 *   - Loads parent quote via the existing loadParentQuote helper
 *     (tenant + sub-brand scoped — same INVALID_ID / QUOTE_NOT_FOUND /
 *     SUB_BRAND_DENIED shape as the markup pricing-preview endpoint).
 *   - Per-line GST split via gstRateForCategory(lineType) + intra/inter
 *     decision via isInterstateSupply.
 *   - Intra-state: cgst + sgst (half-rate each), igst=0.
 *   - Inter-state: igst at full rate, cgst=sgst=0.
 *   - Default behaviour (no query params) → operator=customer="IN-MH"
 *     → intra-state split.
 *   - Default customerStateCode (operatorStateCode supplied alone)
 *     mirrors the operator → intra-state.
 *   - Empty-string state-code query param → 400 INVALID_STATE_CODE
 *     (defense-in-depth on top of the lib helper's empty-string throw).
 *   - Envelope-level totals come from the bucket summary
 *     (computeGstForLines) — GSTR-1 HSN-summary shape per FR-3.4.3, so
 *     the consistency invariants hold tightly:
 *       totalTax === totalCgst + totalSgst + totalIgst
 *       subtotal + totalTax === grandTotal  (to 2 decimals)
 *   - Composite supply (FR-3.2.4): different lineTypes → different
 *     rates in the same envelope, buckets[] groups by rate.
 *   - Empty quote → subtotal=0, all tax=0, lines=[], buckets=[].
 *
 * Pattern mirrors travel-quote-pricing-preview.test.js (commit 91a7b931):
 * CJS prisma singleton patched BEFORE the router is required so
 * verifyToken's revokedToken probe + loadParentQuote's findFirst probe
 * both hit stubs; HS256 JWT via the dev fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelQuote = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelQuoteLine = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelMarkupRule = {
  findMany: vi.fn().mockResolvedValue([]),
};
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
const travelQuotesRouter = requireCJS('../../routes/travel_quotes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelQuotesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function parentQuote(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    status: 'Draft',
    totalAmount: '15000.00',
    currency: 'INR',
    validUntil: new Date(Date.now() + 7 * 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeLine(overrides = {}) {
  return {
    id: 555,
    tenantId: 1,
    quoteId: 100,
    lineType: 'hotel',
    description: 'Hilton Mumbai — 3 nights',
    quantity: 1,
    unitPrice: '1000.00',
    amount: '1000.00',
    currency: 'INR',
    supplierId: null,
    sortOrder: 0,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuoteLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/quotes/:id/tax-preview — happy paths', () => {
  test('intra-state hotel ₹1000 @ 12% → cgst=60, sgst=60, igst=0', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 555, lineType: 'hotel', amount: '1000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview?operatorStateCode=IN-MH&customerStateCode=IN-MH')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.subtotal).toBe(1000);
    expect(res.body.isInterstate).toBe(false);
    expect(res.body.operatorStateCode).toBe('IN-MH');
    expect(res.body.customerStateCode).toBe('IN-MH');
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0]).toMatchObject({
      id: 555,
      lineType: 'hotel',
      amount: 1000,
      gstPercent: 12,
      cgst: 60,
      sgst: 60,
      igst: 0,
      totalTax: 120,
      amountWithTax: 1120,
    });
    expect(res.body.totalCgst).toBe(60);
    expect(res.body.totalSgst).toBe(60);
    expect(res.body.totalIgst).toBe(0);
    expect(res.body.totalTax).toBe(120);
    expect(res.body.grandTotal).toBe(1120);
    expect(res.body.buckets).toHaveLength(1);
    expect(res.body.buckets[0]).toMatchObject({
      gstPercent: 12, cgst: 60, sgst: 60, igst: 0, totalTax: 120,
    });
  });

  test('inter-state hotel ₹1000 @ 12% → igst=120, cgst=0, sgst=0', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 555, lineType: 'hotel', amount: '1000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview?operatorStateCode=IN-MH&customerStateCode=IN-KA')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.isInterstate).toBe(true);
    expect(res.body.operatorStateCode).toBe('IN-MH');
    expect(res.body.customerStateCode).toBe('IN-KA');
    expect(res.body.lines[0]).toMatchObject({
      gstPercent: 12, cgst: 0, sgst: 0, igst: 120, totalTax: 120, amountWithTax: 1120,
    });
    expect(res.body.totalCgst).toBe(0);
    expect(res.body.totalSgst).toBe(0);
    expect(res.body.totalIgst).toBe(120);
    expect(res.body.grandTotal).toBe(1120);
  });

  test('multi-line quote: hotel(12%) + flight(5%) + service(18%) → buckets[] has 3 entries sorted by rate', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '1000.00' }),    // 12% → tax 120
      makeLine({ id: 2, lineType: 'flight', amount: '2000.00' }),   // 5%  → tax 100
      makeLine({ id: 3, lineType: 'service', amount: '500.00' }),   // 18% → tax 90
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview?operatorStateCode=IN-MH&customerStateCode=IN-MH')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.subtotal).toBe(3500);
    expect(res.body.lines).toHaveLength(3);
    // Per-line rates
    expect(res.body.lines[0].gstPercent).toBe(12);
    expect(res.body.lines[1].gstPercent).toBe(5);
    expect(res.body.lines[2].gstPercent).toBe(18);
    // Bucket summary sorted ascending by rate (5, 12, 18)
    expect(res.body.buckets).toHaveLength(3);
    expect(res.body.buckets.map((b) => b.gstPercent)).toEqual([5, 12, 18]);
    // 5% on 2000 = 100, intra-state → 50 cgst + 50 sgst
    expect(res.body.buckets[0]).toMatchObject({ gstPercent: 5, cgst: 50, sgst: 50, igst: 0, totalTax: 100 });
    // 12% on 1000 = 120 → 60 + 60
    expect(res.body.buckets[1]).toMatchObject({ gstPercent: 12, cgst: 60, sgst: 60, igst: 0, totalTax: 120 });
    // 18% on 500 = 90 → 45 + 45
    expect(res.body.buckets[2]).toMatchObject({ gstPercent: 18, cgst: 45, sgst: 45, igst: 0, totalTax: 90 });
    expect(res.body.totalTax).toBe(310);
    expect(res.body.grandTotal).toBe(3810);
  });

  test('empty quote (zero lines) → subtotal=0, all tax=0, lines=[], buckets=[]', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      subtotal: 0,
      totalCgst: 0,
      totalSgst: 0,
      totalIgst: 0,
      totalTax: 0,
      grandTotal: 0,
      lines: [],
      buckets: [],
    });
  });

  test('default state codes (no query params) → operator=customer="IN-MH" → intra-state split', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '1000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.operatorStateCode).toBe('IN-MH');
    expect(res.body.customerStateCode).toBe('IN-MH');
    expect(res.body.isInterstate).toBe(false);
    expect(res.body.lines[0].cgst).toBe(60);
    expect(res.body.lines[0].sgst).toBe(60);
    expect(res.body.lines[0].igst).toBe(0);
  });

  test('operatorStateCode supplied alone → customer defaults to mirror operator → intra-state', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '1000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview?operatorStateCode=IN-DL')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.operatorStateCode).toBe('IN-DL');
    expect(res.body.customerStateCode).toBe('IN-DL');
    expect(res.body.isInterstate).toBe(false);
  });

  test('envelope consistency: totalTax === totalCgst + totalSgst + totalIgst AND subtotal + totalTax === grandTotal', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '7777.77' }),    // 12%
      makeLine({ id: 2, lineType: 'flight', amount: '3333.33' }),   // 5%
      makeLine({ id: 3, lineType: 'transport', amount: '1234.56' }),// 5%
      makeLine({ id: 4, lineType: 'service', amount: '999.99' }),   // 18%
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview?operatorStateCode=IN-MH&customerStateCode=IN-KA')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Round to 2dp because the envelope is rounded; tolerate 0.01 paise
    // drift when summing the three sub-totals (lib uses round2 at every
    // step so this should match exactly).
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

describe('GET /api/travel/quotes/:id/tax-preview — auth / scoping', () => {
  test('cross-tenant parent → 404 QUOTE_NOT_FOUND', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_FOUND');
    expect(prisma.travelQuoteLine.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand denial → 403 SUB_BRAND_DENIED', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ subBrand: 'rfu' }));
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('INVALID_ID non-numeric → 400', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/notanumber/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.travelQuote.findFirst).not.toHaveBeenCalled();
  });

  test('empty-string operatorStateCode → 400 INVALID_STATE_CODE', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview?operatorStateCode=&customerStateCode=IN-MH')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATE_CODE');
    expect(prisma.travelQuoteLine.findMany).not.toHaveBeenCalled();
  });

  test('empty-string customerStateCode → 400 INVALID_STATE_CODE', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview?operatorStateCode=IN-MH&customerStateCode=')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATE_CODE');
    expect(prisma.travelQuoteLine.findMany).not.toHaveBeenCalled();
  });

  test('no auth header → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/quotes/100/tax-preview');
    expect(res.status).toBe(401);
  });
});
