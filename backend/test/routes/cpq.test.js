// @ts-check
/**
 * Unit tests for backend/routes/cpq.js — pin the Configure-Price-Quote
 * contract (Product catalog read/create + Quote read/create with computed
 * totals + recurring MRR roll-up) against accidental regression.
 *
 * Why this file exists
 * ────────────────────
 * cpq.js is a small (~105 LOC) but load-bearing route surface that backs
 * the Deal → Quote flow + the master product catalog. The numeric-input
 * normalization on POST /quotes is non-obvious and has been bitten once
 * already (cpq-api spec line 382): missing/non-numeric quantity defaults
 * to 1, but EXPLICIT quantity=0 must be preserved (not coerced to 1 via
 * the falsy-default trick). totalAmount vs mrr is split by item.isRecurring
 * — recurring items roll into MRR; non-recurring roll into totalAmount.
 *
 * What this file pins
 * ───────────────────
 *   1. GET  /products              — tenant-scoped, alphabetical by name
 *   2. POST /products              — happy path with tenantId forced from req.user
 *   3. GET  /quotes/:dealId        — tenant-scoped, ordered desc, lineItems included
 *   4. GET  /quotes/:dealId        — empty-result returns []
 *   5. POST /quotes                — happy path with computed totalAmount + mrr split
 *   6. POST /quotes                — recurring-item routes into MRR (not totalAmount)
 *   7. POST /quotes                — missing quantity defaults to 1 (Number.isFinite guard)
 *   8. POST /quotes                — EXPLICIT quantity=0 stays 0 (not rewritten to 1)
 *   9. POST /quotes                — missing unitPrice defaults to 0 (no NaN leak to Prisma)
 *  10. POST /quotes                — productId stringified by caller is parsed to int;
 *                                    missing productId stored as null
 *  11. POST /quotes                — Prisma failure path returns 500 with route's
 *                                    error envelope (not the raw Prisma error)
 *  12. POST /products              — Prisma failure path returns 500 with route's
 *                                    error envelope
 *
 * What this file does NOT cover (intentional, out of scope):
 *   - FieldPermission integration (filterReadFields / filterWriteFields are
 *     stubbed to no-op via prisma.fieldPermission.findMany → []). The
 *     #577 field-level enforcement contract is covered by the route's
 *     e2e spec.
 *   - PUT/DELETE on quotes: route does not currently expose these handlers.
 *   - The /products catalog DELETE/PUT: same — route does not expose them.
 *
 * Test pattern
 * ────────────
 * Prisma singleton-monkey-patch + auth middleware bypass — same shape as
 * billing.test.js. The route's `require('./prisma')` + destructured
 * verifyToken capture happen at module-load time, so the patches MUST run
 * before requireCJS('../../routes/cpq') executes.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Patch verifyToken to a pass-through BEFORE requiring the cpq router.
// Destructured import in the route captures whatever authMw.verifyToken
// is the moment the route module evaluates.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Prisma singleton patching — replace lazy delegates with bare vi.fn()
// surfaces. The route touches product, quote, and (transitively, via
// filterReadFields/filterWriteFields) fieldPermission.
prisma.product = {
  findMany: vi.fn(),
  create: vi.fn(),
};
prisma.quote = {
  findMany: vi.fn(),
  create: vi.fn(),
};
// fieldFilter helpers query this — return empty perms so they no-op
// (default-allow when no rule exists, matching the route's expectation).
prisma.fieldPermission = {
  findMany: vi.fn().mockResolvedValue([]),
};

import express from 'express';
import request from 'supertest';
const cpqRouter = requireCJS('../../routes/cpq');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/cpq', cpqRouter);
  return app;
}

beforeEach(() => {
  prisma.product.findMany.mockReset();
  prisma.product.create.mockReset();
  prisma.quote.findMany.mockReset();
  prisma.quote.create.mockReset();
  prisma.fieldPermission.findMany.mockReset();
  prisma.fieldPermission.findMany.mockResolvedValue([]);
});

// ─── GET /products — master catalog list ─────────────────────────────

describe('GET /api/cpq/products — master catalog list', () => {
  test('happy path: returns tenant-scoped products ordered by name asc', async () => {
    const products = [
      { id: 1, name: 'Alpha Tier', tenantId: 1 },
      { id: 2, name: 'Beta Tier', tenantId: 1 },
    ];
    prisma.product.findMany.mockResolvedValue(products);
    const app = makeApp();
    const res = await request(app).get('/api/cpq/products');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(products);
    const findArgs = prisma.product.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 1 });
    expect(findArgs.orderBy).toEqual({ name: 'asc' });
  });
});

// ─── POST /products — push new SKU to catalog ────────────────────────

describe('POST /api/cpq/products — push SKU', () => {
  test('happy path: writes tenantId from req.user (not body), returns 201', async () => {
    prisma.product.create.mockResolvedValue({
      id: 99, name: 'Gamma Tier', sku: 'GAMMA-001', tenantId: 1,
    });
    const app = makeApp({ tenantId: 1 });
    const res = await request(app)
      .post('/api/cpq/products')
      .send({ name: 'Gamma Tier', sku: 'GAMMA-001', tenantId: 999 }); // body tenantId ignored
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(99);
    const createArgs = prisma.product.create.mock.calls[0][0];
    // tenantId from req.user wins over body
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.name).toBe('Gamma Tier');
  });

  test('Prisma failure → 500 with the route\'s error envelope', async () => {
    prisma.product.create.mockRejectedValue(new Error('DB exploded'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/cpq/products')
      .send({ name: 'X' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Product matrix mutation failed/i);
  });
});

// ─── GET /quotes/:dealId — list quotes for a deal ────────────────────

describe('GET /api/cpq/quotes/:dealId — list quotes', () => {
  test('happy path: tenant-scoped, ordered desc, includes lineItems', async () => {
    const quotes = [
      { id: 11, dealId: 42, title: 'Q-Nov', totalAmount: 1000, mrr: 0, tenantId: 1, lineItems: [] },
      { id: 10, dealId: 42, title: 'Q-Oct', totalAmount: 800, mrr: 0, tenantId: 1, lineItems: [] },
    ];
    prisma.quote.findMany.mockResolvedValue(quotes);
    const app = makeApp();
    const res = await request(app).get('/api/cpq/quotes/42');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const findArgs = prisma.quote.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ dealId: 42, tenantId: 1 });
    expect(findArgs.include).toEqual({ lineItems: true });
    expect(findArgs.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('no quotes for the deal → empty array', async () => {
    prisma.quote.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).get('/api/cpq/quotes/777');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─── POST /quotes — compile new CPQ quote with computed totals ───────

describe('POST /api/cpq/quotes — compile quote (totalAmount + mrr split)', () => {
  test('happy path: non-recurring items roll into totalAmount; mrr stays 0', async () => {
    prisma.quote.create.mockImplementation(async ({ data, include }) => ({
      id: 555,
      title: data.title,
      dealId: data.dealId,
      totalAmount: data.totalAmount,
      mrr: data.mrr,
      tenantId: data.tenantId,
      lineItems: include?.lineItems
        ? data.lineItems.create.map((li, i) => ({ id: 1000 + i, ...li }))
        : undefined,
    }));
    const app = makeApp({ tenantId: 1 });
    const res = await request(app)
      .post('/api/cpq/quotes')
      .send({
        dealId: 42,
        title: 'Q4 Renewal',
        lineItems: [
          { productName: 'Onboarding', quantity: 2, unitPrice: 500, isRecurring: false },
          { productName: 'Audit Fee', quantity: 1, unitPrice: 250, isRecurring: false },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.totalAmount).toBe(1250); // 2*500 + 1*250
    expect(res.body.mrr).toBe(0);
    const createArgs = prisma.quote.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.dealId).toBe(42);
    expect(createArgs.data.totalAmount).toBe(1250);
    expect(createArgs.data.mrr).toBe(0);
  });

  test('recurring items route into MRR, NOT totalAmount', async () => {
    prisma.quote.create.mockResolvedValue({
      id: 556, title: 'SaaS Renewal', dealId: 42, totalAmount: 500, mrr: 1200, tenantId: 1, lineItems: [],
    });
    const app = makeApp({ tenantId: 1 });
    const res = await request(app)
      .post('/api/cpq/quotes')
      .send({
        dealId: 42,
        title: 'SaaS Renewal',
        lineItems: [
          { productName: 'License', quantity: 12, unitPrice: 100, isRecurring: true },  // → mrr: 1200
          { productName: 'Setup',   quantity: 1,  unitPrice: 500, isRecurring: false }, // → total: 500
        ],
      });
    expect(res.status).toBe(201);
    const createArgs = prisma.quote.create.mock.calls[0][0];
    expect(createArgs.data.totalAmount).toBe(500);
    expect(createArgs.data.mrr).toBe(1200);
  });

  test('missing quantity defaults to 1 (Number.isFinite guard)', async () => {
    prisma.quote.create.mockResolvedValue({
      id: 557, title: 'T', dealId: 42, totalAmount: 99, mrr: 0, tenantId: 1, lineItems: [],
    });
    const app = makeApp();
    await request(app)
      .post('/api/cpq/quotes')
      .send({
        dealId: 42,
        title: 'T',
        lineItems: [
          { productName: 'X', unitPrice: 99, isRecurring: false }, // no quantity
        ],
      });
    const createArgs = prisma.quote.create.mock.calls[0][0];
    // Quantity defaults to 1 → 1 * 99 = 99 (NOT NaN, NOT 0).
    expect(createArgs.data.totalAmount).toBe(99);
    expect(createArgs.data.lineItems.create[0].quantity).toBe(1);
  });

  test('EXPLICIT quantity=0 stays 0 (NOT rewritten to 1 via falsy default) — #cpq-api:382', async () => {
    prisma.quote.create.mockResolvedValue({
      id: 558, title: 'Z', dealId: 42, totalAmount: 0, mrr: 0, tenantId: 1, lineItems: [],
    });
    const app = makeApp();
    await request(app)
      .post('/api/cpq/quotes')
      .send({
        dealId: 42,
        title: 'Z',
        lineItems: [
          { productName: 'Free Sample', quantity: 0, unitPrice: 1000, isRecurring: false },
        ],
      });
    const createArgs = prisma.quote.create.mock.calls[0][0];
    // The regression: `parseInt(0) || 1 === 1` because 0 is falsy in JS.
    // The route uses Number.isFinite to distinguish 0 from undefined.
    // Pin: explicit 0 stays 0 → totalAmount = 0 * 1000 = 0.
    expect(createArgs.data.lineItems.create[0].quantity).toBe(0);
    expect(createArgs.data.totalAmount).toBe(0);
  });

  test('missing unitPrice defaults to 0 (no NaN leak to Prisma)', async () => {
    prisma.quote.create.mockResolvedValue({
      id: 559, title: 'Y', dealId: 42, totalAmount: 0, mrr: 0, tenantId: 1, lineItems: [],
    });
    const app = makeApp();
    await request(app)
      .post('/api/cpq/quotes')
      .send({
        dealId: 42,
        title: 'Y',
        lineItems: [
          { productName: 'Mystery', quantity: 5, isRecurring: false }, // no unitPrice
        ],
      });
    const createArgs = prisma.quote.create.mock.calls[0][0];
    // Number.isFinite(parseFloat(undefined)) === false → fallback to 0.
    // 5 * 0 = 0 (NOT NaN, which Prisma would reject).
    expect(createArgs.data.lineItems.create[0].unitPrice).toBe(0);
    expect(createArgs.data.totalAmount).toBe(0);
  });

  test('productId stringified by caller is parsed to int; missing productId → null', async () => {
    prisma.quote.create.mockResolvedValue({
      id: 560, title: 'P', dealId: 42, totalAmount: 100, mrr: 0, tenantId: 1, lineItems: [],
    });
    const app = makeApp();
    await request(app)
      .post('/api/cpq/quotes')
      .send({
        dealId: 42,
        title: 'P',
        lineItems: [
          { productName: 'Linked', quantity: 1, unitPrice: 50, productId: '777', isRecurring: false },
          { productName: 'Custom', quantity: 1, unitPrice: 50, isRecurring: false }, // no productId
        ],
      });
    const createArgs = prisma.quote.create.mock.calls[0][0];
    const lines = createArgs.data.lineItems.create;
    expect(lines[0].productId).toBe(777); // parsed from '777'
    expect(lines[1].productId).toBe(null); // missing → null
  });

  test('Prisma failure → 500 with the route\'s error envelope (not raw Prisma error)', async () => {
    prisma.quote.create.mockRejectedValue(new Error('Connection lost'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/cpq/quotes')
      .send({
        dealId: 42,
        title: 'Boom',
        lineItems: [{ productName: 'X', quantity: 1, unitPrice: 10, isRecurring: false }],
      });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/CPQ SaaS Pipeline matrix compilation failed/i);
    // The raw Prisma message must not leak to the client.
    expect(res.body.error).not.toMatch(/Connection lost/i);
  });
});
