// @ts-check
/**
 * Arc 2 #900 slice 5 — TravelQuote pricing-preview endpoint
 * (PRD_TRAVEL_QUOTE_BUILDER FR-3.3.2 / FR-3.3.4).
 *
 * Pins the read-only composition endpoint added to
 * backend/routes/travel_quotes.js:
 *
 *   GET /api/travel/quotes/:id/pricing-preview     any verified token
 *
 * Contracts asserted:
 *   - Loads parent quote tenant-scoped + sub-brand-scoped (shared
 *     loadParentQuote helper → same INVALID_ID / QUOTE_NOT_FOUND /
 *     SUB_BRAND_DENIED shape as the line endpoints).
 *   - Loads ONLY active TravelMarkupRule rows for the quote's sub-brand
 *     (`{ tenantId, subBrand, isActive: true }` with `priority asc`).
 *   - Per-line markup composition via lib/travelPricing.js::pickMarkup:
 *     each line's `lineType` maps to a markup scope via
 *     mapCategoryToScope (visa/service/other collapse to "package"),
 *     pickMarkup returns the highest-priority rule for that scope.
 *   - Aggregate `markupApplied[]` dedupes by ruleId — a single rule
 *     covering multiple lines surfaces as one entry with summed amount.
 *   - subtotal == sum of line amounts (pre-markup); total ==
 *     subtotal + sum of markup amounts (post-markup).
 *   - Empty-quote case: subtotal=0, total=0, markupApplied=[], lines=[].
 *   - No active rules case: total === subtotal, markupApplied=[].
 *   - Decorated lines carry { id, lineType, description, amount,
 *     amountWithMarkup } — no Prisma internals leaked.
 *
 * Pattern mirrors travel-quote-lines.test.js (CJS prisma singleton
 * patched BEFORE the router is required so verifyToken's revokedToken
 * probe + route findFirst probes both hit stubs; HS256 JWT via the dev
 * fallback secret).
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
  findMany: vi.fn(),
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
    totalAmount: '45000.00',
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
    quantity: 3,
    unitPrice: '5000.00',
    amount: '15000.00',
    currency: 'INR',
    supplierId: null,
    sortOrder: 0,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRule(overrides = {}) {
  return {
    id: 1,
    tenantId: 1,
    subBrand: 'tmc',
    scope: 'hotel',
    matchKeyJson: 'hotel-default',
    markupPct: '10.0000',
    markupFlat: null,
    ownerUserId: null,
    priority: 100,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuoteLine.findMany.mockReset().mockResolvedValue([]);
  prisma.travelMarkupRule.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/quotes/:id/pricing-preview — happy paths', () => {
  test('2 lines + 1 active hotel-scope rule → subtotal, markup applied to hotel only, total reflects markup', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 555, lineType: 'hotel', amount: '10000.00' }),
      makeLine({ id: 556, lineType: 'flight', amount: '5000.00' }),
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([
      makeRule({ id: 11, scope: 'hotel', markupPct: '10.0000', matchKeyJson: 'hotel-default' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.subtotal).toBe(15000);
    expect(res.body.currency).toBe('INR');
    // Only hotel line gets markup; flight line passes through.
    expect(res.body.markupApplied).toHaveLength(1);
    expect(res.body.markupApplied[0]).toMatchObject({
      ruleId: 11,
      ruleName: 'hotel-default',
      percent: 10,
      amount: 1000, // 10% of 10000
    });
    expect(res.body.total).toBe(16000); // 15000 + 1000
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines[0]).toMatchObject({
      id: 555, lineType: 'hotel', amount: 10000, amountWithMarkup: 11000,
    });
    expect(res.body.lines[1]).toMatchObject({
      id: 556, lineType: 'flight', amount: 5000, amountWithMarkup: 5000,
    });
  });

  test('no active rules → total === subtotal, markupApplied empty', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 555, lineType: 'hotel', amount: '12000.00' }),
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.subtotal).toBe(12000);
    expect(res.body.total).toBe(12000);
    expect(res.body.markupApplied).toEqual([]);
    expect(res.body.lines[0].amountWithMarkup).toBe(12000);
  });

  test('empty quote (zero lines) → subtotal=0, total=0, markupApplied=[], lines=[]', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([
      makeRule({ id: 1, scope: 'hotel', markupPct: '10.0000' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      subtotal: 0,
      total: 0,
      markupApplied: [],
      lines: [],
      currency: 'INR',
    });
  });

  test('multiple rules across scopes: hotel + package both apply, markupApplied lists both', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '10000.00' }),
      makeLine({ id: 2, lineType: 'visa', amount: '2000.00' }), // → "package" scope
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([
      makeRule({ id: 11, scope: 'hotel', markupPct: '10.0000', matchKeyJson: 'hotel-default' }),
      makeRule({ id: 22, scope: 'package', markupPct: '15.0000', matchKeyJson: 'package-default' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.subtotal).toBe(12000);
    expect(res.body.markupApplied).toHaveLength(2);
    const byId = Object.fromEntries(res.body.markupApplied.map((m) => [m.ruleId, m]));
    expect(byId[11]).toMatchObject({ percent: 10, amount: 1000 });
    expect(byId[22]).toMatchObject({ percent: 15, amount: 300 }); // 15% of 2000
    expect(res.body.total).toBe(13300); // 12000 + 1000 + 300
  });

  test('single rule covering multiple lines of same scope: markupApplied has ONE entry with summed amount', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '10000.00' }),
      makeLine({ id: 2, lineType: 'hotel', amount: '5000.00' }),
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([
      makeRule({ id: 11, scope: 'hotel', markupPct: '10.0000', matchKeyJson: 'hotel-default' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.markupApplied).toHaveLength(1);
    expect(res.body.markupApplied[0]).toMatchObject({
      ruleId: 11,
      amount: 1500, // 10% of (10000 + 5000)
    });
    expect(res.body.total).toBe(16500);
  });

  test('flat markup rule (markupFlat) emits percent=null and amount=flat', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'flight', amount: '8000.00' }),
    ]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([
      makeRule({
        id: 33, scope: 'flight', markupPct: null, markupFlat: '500.00',
        matchKeyJson: 'flight-flat',
      }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.markupApplied).toHaveLength(1);
    expect(res.body.markupApplied[0]).toMatchObject({
      ruleId: 33,
      percent: null,
      amount: 500,
    });
    expect(res.body.total).toBe(8500);
  });

  test('inactive rule is filtered out by the findMany where-clause (only active=true rules reach pickMarkup)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '10000.00' }),
    ]);
    // The route's findMany passes isActive:true so the inactive rule
    // never reaches the helper. We mirror that by returning an empty
    // array here, then assert the where-clause was scoped accordingly.
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.travelMarkupRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 1, subBrand: 'tmc', isActive: true },
      }),
    );
    expect(res.body.markupApplied).toEqual([]);
    expect(res.body.total).toBe(10000);
  });
});

describe('GET /api/travel/quotes/:id/pricing-preview — auth / scoping', () => {
  test('cross-tenant parent → 404 QUOTE_NOT_FOUND', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_FOUND');
    // Should NOT have loaded lines or rules before parent-not-found.
    expect(prisma.travelQuoteLine.findMany).not.toHaveBeenCalled();
    expect(prisma.travelMarkupRule.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand denial → 403 SUB_BRAND_DENIED', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ subBrand: 'rfu' }));
    // User has access only to tmc; quote is under rfu.
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('INVALID_ID non-numeric → 400', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/notanumber/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(prisma.travelQuote.findFirst).not.toHaveBeenCalled();
  });

  test('USER role is sufficient (read endpoint — no ADMIN/MANAGER gate)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
  });

  test('no auth header → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/quotes/100/pricing-preview');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/travel/quotes/:id/pricing-preview — rule scoping', () => {
  test('findMany scoped to quote.subBrand (not the user\'s sub-brand)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ subBrand: 'tmc' }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([]);
    prisma.travelMarkupRule.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/quotes/100/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(prisma.travelMarkupRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subBrand: 'tmc', isActive: true }),
        orderBy: expect.arrayContaining([
          expect.objectContaining({ priority: 'asc' }),
        ]),
      }),
    );
  });

  test('rule for a different sub-brand is NOT applied (defense-in-depth on top of where-clause)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ subBrand: 'tmc' }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 1, lineType: 'hotel', amount: '10000.00' }),
    ]);
    // Even if a wrong-sub-brand rule slipped through findMany, pickMarkup
    // filters by subBrand internally so the markup is not applied.
    prisma.travelMarkupRule.findMany.mockResolvedValue([
      makeRule({ id: 99, subBrand: 'rfu', scope: 'hotel', markupPct: '50.0000' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/pricing-preview')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.markupApplied).toEqual([]);
    expect(res.body.total).toBe(10000);
  });
});
