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
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn().mockResolvedValue(null);
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

// Default tenant.findUnique implementation discriminates by the `select`
// shape so the middleware (requireTravelTenant, selects vertical+name+slug)
// and the slice-4 resolver (resolveStateCodes, selects gstStateCode) can
// both hit the same Prisma surface without interfering. Individual tests
// override by stacking mockResolvedValueOnce or replacing the implementation.
function defaultTenantFindUniqueImpl({ select } = {}) {
  if (select && select.gstStateCode) {
    return Promise.resolve(null); // no DB value populated by default
  }
  return Promise.resolve({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
}

beforeEach(() => {
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuoteLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockImplementation(defaultTenantFindUniqueImpl);
  prisma.contact.findUnique.mockReset().mockResolvedValue(null);
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

// Slice 4 of #902 — wiring lib/gstStateCodeResolver.js (commit ef7573e7).
// Source-of-truth chain (per FR-3.x):
//   1. Truthy query-param override wins.
//   2. DB column — Tenant.gstStateCode for operator, Contact.stateCode
//      for customer (both nullable additive columns from slice 3).
//   3. Hard-coded "IN-MH" fallback (preserves slice 2 back-compat).
// Customer-side fallback: when override + DB are both null, mirror the
// operator (intra-state default) — resolver-internal.
describe('GET /api/travel/quotes/:id/tax-preview — slice 4 resolver wiring', () => {
  /** Helper: stub tenant.findUnique to return distinct payloads for
   * the middleware select-shape vs the resolver select-shape. */
  function stubTenantWithGstCode(gstStateCode) {
    prisma.tenant.findUnique.mockImplementation(({ select } = {}) => {
      if (select && select.gstStateCode) {
        return Promise.resolve({ gstStateCode });
      }
      return Promise.resolve({
        id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
      });
    });
  }

  test('no query params + Tenant.gstStateCode=IN-MH + Contact.stateCode=IN-KA → operator=IN-MH, customer=IN-KA (DB inter-state)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ contactId: 999 }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '1000.00' }),
    ]);
    stubTenantWithGstCode('IN-MH');
    prisma.contact.findUnique.mockResolvedValue({ stateCode: 'IN-KA' });

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.operatorStateCode).toBe('IN-MH');
    expect(res.body.customerStateCode).toBe('IN-KA');
    expect(res.body.isInterstate).toBe(true);
    // Inter-state hotel ₹1000 @ 12% → igst=120, cgst=sgst=0
    expect(res.body.lines[0]).toMatchObject({ cgst: 0, sgst: 0, igst: 120 });
  });

  test('no query params + Tenant.gstStateCode set + Contact.stateCode null → customer mirrors operator (DB intra-state)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ contactId: 999 }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '1000.00' }),
    ]);
    stubTenantWithGstCode('IN-DL');
    prisma.contact.findUnique.mockResolvedValue(null); // Contact missing / no stateCode

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.operatorStateCode).toBe('IN-DL');
    expect(res.body.customerStateCode).toBe('IN-DL'); // mirrored
    expect(res.body.isInterstate).toBe(false);
    expect(res.body.lines[0]).toMatchObject({ cgst: 60, sgst: 60, igst: 0 });
  });

  test('no query params + both DB nulls → both default to "IN-MH" (legacy fallback preserved)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ contactId: 999 }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '1000.00' }),
    ]);
    // Default impl already returns null for the gstStateCode-select call;
    // default contact.findUnique mock already returns null.

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.operatorStateCode).toBe('IN-MH');
    expect(res.body.customerStateCode).toBe('IN-MH');
    expect(res.body.isInterstate).toBe(false);
  });

  test('?operatorStateCode=IN-RJ override + Tenant.gstStateCode=IN-MH → override wins (response shows IN-RJ)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ contactId: 999 }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '1000.00' }),
    ]);
    stubTenantWithGstCode('IN-MH'); // DB says IN-MH
    prisma.contact.findUnique.mockResolvedValue({ stateCode: 'IN-KA' });

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview?operatorStateCode=IN-RJ')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.operatorStateCode).toBe('IN-RJ'); // override won
    expect(res.body.customerStateCode).toBe('IN-KA'); // DB
    expect(res.body.isInterstate).toBe(true);
  });

  test('?customerStateCode=IN-GJ override + Contact.stateCode=IN-KA → override wins', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ contactId: 999 }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '1000.00' }),
    ]);
    stubTenantWithGstCode('IN-MH');
    prisma.contact.findUnique.mockResolvedValue({ stateCode: 'IN-KA' }); // DB says IN-KA

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview?customerStateCode=IN-GJ')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.operatorStateCode).toBe('IN-MH'); // DB
    expect(res.body.customerStateCode).toBe('IN-GJ'); // override won
    expect(res.body.isInterstate).toBe(true);
  });

  test('no operator override → prisma.tenant.findUnique called with select: { gstStateCode: true }', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ contactId: 999 }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([]);
    stubTenantWithGstCode('IN-MH');

    await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    // At least one call should target gstStateCode select shape.
    const gstSelectCalls = prisma.tenant.findUnique.mock.calls.filter(
      ([arg]) => arg && arg.select && arg.select.gstStateCode === true,
    );
    expect(gstSelectCalls.length).toBeGreaterThanOrEqual(1);
    expect(gstSelectCalls[0][0]).toMatchObject({
      where: { id: 1 },
      select: { gstStateCode: true },
    });
  });

  test('no customer override → prisma.contact.findUnique called with select: { stateCode: true } and where.id = quote.contactId', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ contactId: 999 }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([]);
    stubTenantWithGstCode('IN-MH');
    prisma.contact.findUnique.mockResolvedValue({ stateCode: 'IN-KA' });

    await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(prisma.contact.findUnique).toHaveBeenCalledWith({
      where: { id: 999 },
      select: { stateCode: true },
    });
  });

  test('operator override present → prisma.tenant.findUnique NOT called with gstStateCode-select shape', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ contactId: 999 }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([]);
    stubTenantWithGstCode('IN-MH');

    await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview?operatorStateCode=IN-RJ&customerStateCode=IN-GJ')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    // Middleware still does a tenant.findUnique (vertical check), but
    // resolver should be short-circuited — no gstStateCode-select call.
    const gstSelectCalls = prisma.tenant.findUnique.mock.calls.filter(
      ([arg]) => arg && arg.select && arg.select.gstStateCode === true,
    );
    expect(gstSelectCalls).toHaveLength(0);
    // Same short-circuit for contact when customer override present.
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });
});

// Slice 6 of #902 — wiring lib/hsnSacMapper.js (commit 6aca2361). The
// tax-preview response now decorates each line with its canonical SAC
// code + description AND surfaces a top-level hsnSummary[] grouping
// for GSTR-1 export (FR-3.4.3). hsnSummary is a sibling of buckets[]:
// buckets groups by gstPercent only; hsnSummary groups by (sacCode,
// gstPercent) pair. Both ship in the envelope so callers pick the view
// they need (PDF on-quote = per-line; GSTR-1 JSON export = hsnSummary).
describe('GET /api/travel/quotes/:id/tax-preview — slice 6 SAC + hsnSummary', () => {
  test('per-line: every line carries a sacCode + sacDescription field', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '1000.00' }),
      makeLine({ id: 2, lineType: 'flight', amount: '2000.00' }),
      makeLine({ id: 3, lineType: 'service', amount: '500.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(3);
    for (const line of res.body.lines) {
      expect(line).toHaveProperty('sacCode');
      expect(line).toHaveProperty('sacDescription');
    }
  });

  test('hotel line → sacCode "9963", description "Accommodation services"', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '1000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.lines[0].sacCode).toBe('9963');
    expect(res.body.lines[0].sacDescription).toBe('Accommodation services');
  });

  test('flight line → sacCode "9964", description "Passenger transport services"', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'flight', amount: '2000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.lines[0].sacCode).toBe('9964');
    expect(res.body.lines[0].sacDescription).toBe('Passenger transport services');
  });

  test('unknown lineType → falls back to default SAC "9985" with travel-tourism description', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'something_weird', amount: '1000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.lines[0].sacCode).toBe('9985');
    expect(res.body.lines[0].sacDescription).toBe('Support services to travel & tourism');
  });

  test('hsnSummary present in response, length matches distinct (sacCode, gstPercent) pairs', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '1000.00' }),   // 9963 @ 12%
      makeLine({ id: 2, lineType: 'flight', amount: '2000.00' }),  // 9964 @ 5%
      makeLine({ id: 3, lineType: 'service', amount: '500.00' }),  // 9985 @ 18%
      makeLine({ id: 4, lineType: 'hotel', amount: '800.00' }),    // 9963 @ 12% (duplicate group)
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.hsnSummary)).toBe(true);
    // 3 distinct (sacCode, gstPercent) pairs: (9963,12), (9964,5), (9985,18)
    expect(res.body.hsnSummary).toHaveLength(3);
    // The two hotel lines must collapse into one group with count=2 + summed taxable
    const hotelGroup = res.body.hsnSummary.find((g) => g.sacCode === '9963');
    expect(hotelGroup).toBeDefined();
    expect(hotelGroup.count).toBe(2);
    expect(hotelGroup.taxableValue).toBe(1800);
    expect(hotelGroup.gstPercent).toBe(12);
  });

  test('hsnSummary entries have { sacCode, description, gstPercent, taxableValue, count } shape', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '1000.00' }),
      makeLine({ id: 2, lineType: 'flight', amount: '2000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    for (const entry of res.body.hsnSummary) {
      expect(entry).toEqual(expect.objectContaining({
        sacCode: expect.any(String),
        description: expect.any(String),
        gstPercent: expect.any(Number),
        taxableValue: expect.any(Number),
        count: expect.any(Number),
      }));
    }
    // Sorted by sacCode ascending — 9963 (hotel) before 9964 (flight)
    expect(res.body.hsnSummary[0].sacCode).toBe('9963');
    expect(res.body.hsnSummary[1].sacCode).toBe('9964');
  });

  test('empty quote (zero lines) → hsnSummary is []', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/tax-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.hsnSummary).toEqual([]);
  });
});
