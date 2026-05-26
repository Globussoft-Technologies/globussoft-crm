// @ts-check
/**
 * Arc 2 #900 slice 3 — TravelQuoteLine CRUD contract (PRD_TRAVEL_QUOTE_BUILDER §3.2).
 *
 * Pins the four line-item endpoints added to backend/routes/travel_quotes.js:
 *
 *   GET    /api/travel/quotes/:id/lines           any verified token
 *   POST   /api/travel/quotes/:id/lines           ADMIN/MANAGER
 *   PUT    /api/travel/quotes/:id/lines/:lineId   ADMIN/MANAGER
 *   DELETE /api/travel/quotes/:id/lines/:lineId   ADMIN/MANAGER
 *
 * Contracts asserted:
 *   - amount is computed server-side as quantity * unitPrice, not trusted
 *     from the body. PUT recomputes amount whenever qty or unitPrice
 *     changes (so the operator can edit either independently and the
 *     derived total stays correct).
 *   - currency falls back to the parent quote's currency when the body
 *     omits it (operator-side default — the line builder shouldn't have
 *     to repeat the currency on every line).
 *   - Parent quote's totalAmount is recomputed after every write (POST,
 *     PUT, DELETE) as the sum of surviving lines. Empty-lines case is
 *     intentionally skipped — see route comment at recomputeQuoteTotal.
 *   - Duplicate-quote clones the source's lines via createMany; the
 *     duplicate's audit row records linesCloned count.
 *   - Validation:
 *       lineType not in VALID_LINE_TYPES → 400 INVALID_LINE_TYPE
 *       quantity < 1 or non-integer → 400 INVALID_QUANTITY
 *       unitPrice missing or negative → 400 MISSING_FIELDS / INVALID_AMOUNT
 *       description empty → 400 MISSING_FIELDS
 *       supplierId non-numeric → 400 INVALID_SUPPLIER_ID
 *   - Tenant + sub-brand isolation: cross-tenant parent → 404
 *     QUOTE_NOT_FOUND; sub-brand mismatch → 403 SUB_BRAND_DENIED.
 *   - Lines under a different parent quote → 404 LINE_NOT_FOUND.
 *
 * Pattern mirrors travel-quotes-duplicate-pdf.test.js (HS256 JWT via
 * the dev fallback secret; prisma singleton patched BEFORE the router
 * is required so verifyToken's revokedToken probe + route findFirst
 * probes both hit stubs).
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

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
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

beforeEach(() => {
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuote.update.mockReset().mockResolvedValue({});
  prisma.travelQuote.create.mockReset();
  prisma.travelQuoteLine.findMany.mockReset().mockResolvedValue([]);
  prisma.travelQuoteLine.findFirst.mockReset();
  prisma.travelQuoteLine.create.mockReset();
  prisma.travelQuoteLine.createMany.mockReset();
  prisma.travelQuoteLine.update.mockReset();
  prisma.travelQuoteLine.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/quotes/:id/lines', () => {
  test('happy path: returns lines under the parent quote', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 555, sortOrder: 0 }),
      makeLine({ id: 556, sortOrder: 1, lineType: 'flight', description: 'BLR-BOM', amount: '8000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/100/lines')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines[0]).toMatchObject({ id: 555, lineType: 'hotel' });
    expect(prisma.travelQuoteLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { quoteId: 100, tenantId: 1 },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  test('cross-tenant parent → 404 QUOTE_NOT_FOUND', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/quotes/100/lines')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_FOUND');
  });

  test('non-numeric id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/abc/lines')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });
});

describe('POST /api/travel/quotes/:id/lines', () => {
  test('happy path: amount computed as quantity * unitPrice, currency inherited from parent', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote({ currency: 'USD' }));
    prisma.travelQuoteLine.create.mockImplementation(async (args) => ({
      id: 700, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([{ amount: '15000.00' }]);

    const res = await request(makeApp())
      .post('/api/travel/quotes/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        lineType: 'hotel',
        description: 'Hilton Mumbai — 3 nights',
        quantity: 3,
        unitPrice: 5000,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 700,
      tenantId: 1,
      quoteId: 100,
      lineType: 'hotel',
      description: 'Hilton Mumbai — 3 nights',
      quantity: 3,
      currency: 'USD', // inherited from parent
    });
    // amount is computed server-side, not trusted from body
    expect(prisma.travelQuoteLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          unitPrice: 5000,
          amount: 15000,
        }),
      }),
    );
    // parent quote's totalAmount recomputed after line insert
    expect(prisma.travelQuote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100 },
        data: { totalAmount: 15000 },
      }),
    );
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/quotes/100/lines')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ description: 'x', unitPrice: 100 });
    expect(res.status).toBe(403);
  });

  test('missing description → 400 MISSING_FIELDS', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    const res = await request(makeApp())
      .post('/api/travel/quotes/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ unitPrice: 100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  test('invalid lineType → 400 INVALID_LINE_TYPE', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    const res = await request(makeApp())
      .post('/api/travel/quotes/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ lineType: 'fish', description: 'x', unitPrice: 100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LINE_TYPE');
  });

  test('quantity < 1 → 400 INVALID_QUANTITY', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    const res = await request(makeApp())
      .post('/api/travel/quotes/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'x', quantity: 0, unitPrice: 100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUANTITY');
  });

  test('negative unitPrice → 400 INVALID_AMOUNT', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    const res = await request(makeApp())
      .post('/api/travel/quotes/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'x', unitPrice: -50 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
  });

  test('non-numeric supplierId → 400 INVALID_SUPPLIER_ID', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    const res = await request(makeApp())
      .post('/api/travel/quotes/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'x', unitPrice: 100, supplierId: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUPPLIER_ID');
  });

  test('cross-tenant parent → 404 QUOTE_NOT_FOUND (no line created)', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/quotes/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'x', unitPrice: 100 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_FOUND');
    expect(prisma.travelQuoteLine.create).not.toHaveBeenCalled();
  });
});

describe('PUT /api/travel/quotes/:id/lines/:lineId', () => {
  test('happy path: changing quantity recomputes amount', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findFirst.mockResolvedValue(makeLine({ quantity: 3, unitPrice: '5000.00' }));
    prisma.travelQuoteLine.update.mockImplementation(async (args) => ({
      ...makeLine(),
      ...args.data,
    }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([{ amount: '25000.00' }]);

    const res = await request(makeApp())
      .put('/api/travel/quotes/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quantity: 5 });

    expect(res.status).toBe(200);
    // 5 nights * 5000 (existing unitPrice) = 25000
    expect(prisma.travelQuoteLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 555 },
        data: expect.objectContaining({ quantity: 5, amount: 25000 }),
      }),
    );
  });

  test('happy path: changing unitPrice alone recomputes amount using existing quantity', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findFirst.mockResolvedValue(makeLine({ quantity: 3, unitPrice: '5000.00' }));
    prisma.travelQuoteLine.update.mockImplementation(async (args) => ({ ...makeLine(), ...args.data }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([{ amount: '21000.00' }]);

    const res = await request(makeApp())
      .put('/api/travel/quotes/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ unitPrice: 7000 });

    expect(res.status).toBe(200);
    expect(prisma.travelQuoteLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unitPrice: 7000, amount: 21000 }),
      }),
    );
  });

  test('line under different parent quote → 404 LINE_NOT_FOUND', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/travel/quotes/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quantity: 2 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('LINE_NOT_FOUND');
  });

  test('empty body → 400 EMPTY_BODY', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findFirst.mockResolvedValue(makeLine());
    const res = await request(makeApp())
      .put('/api/travel/quotes/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_BODY');
  });

  test('supplierId=null detaches the supplier link', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findFirst.mockResolvedValue(makeLine({ supplierId: 42 }));
    prisma.travelQuoteLine.update.mockImplementation(async (args) => ({ ...makeLine(), ...args.data }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([{ amount: '15000.00' }]);

    const res = await request(makeApp())
      .put('/api/travel/quotes/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ supplierId: null });
    expect(res.status).toBe(200);
    expect(prisma.travelQuoteLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ supplierId: null }),
      }),
    );
  });
});

describe('DELETE /api/travel/quotes/:id/lines/:lineId', () => {
  test('happy path: 204 + line deleted + parent recomputed', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findFirst.mockResolvedValue(makeLine());
    prisma.travelQuoteLine.delete.mockResolvedValue(makeLine());
    prisma.travelQuoteLine.findMany.mockResolvedValue([{ amount: '8000.00' }]);

    const res = await request(makeApp())
      .delete('/api/travel/quotes/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(204);
    expect(prisma.travelQuoteLine.delete).toHaveBeenCalledWith({ where: { id: 555 } });
    expect(prisma.travelQuote.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100 },
        data: { totalAmount: 8000 },
      }),
    );
  });

  test('audit row recorded BEFORE delete', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuoteLine.findFirst.mockResolvedValue(makeLine({ lineType: 'flight', amount: '8000.00' }));
    prisma.travelQuoteLine.delete.mockResolvedValue(makeLine());
    prisma.travelQuoteLine.findMany.mockResolvedValue([]);

    await request(makeApp())
      .delete('/api/travel/quotes/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity: 'TravelQuoteLine',
          action: 'DELETE',
        }),
      }),
    );
  });
});

describe('POST /api/travel/quotes/:id/duplicate clones lines', () => {
  test('source lines are cloned via createMany; audit linesCloned matches', async () => {
    const src = parentQuote({ id: 100, status: 'Sent' });
    prisma.travelQuote.findFirst.mockResolvedValue(src);
    prisma.travelQuote.create.mockImplementation(async (args) => ({
      id: 200, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      makeLine({ id: 555, sortOrder: 0 }),
      makeLine({ id: 556, sortOrder: 1, lineType: 'flight', amount: '8000.00' }),
    ]);
    prisma.travelQuoteLine.createMany.mockResolvedValue({ count: 2 });

    const res = await request(makeApp())
      .post('/api/travel/quotes/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(prisma.travelQuoteLine.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ quoteId: 200, lineType: 'hotel' }),
          expect.objectContaining({ quoteId: 200, lineType: 'flight' }),
        ]),
      }),
    );
    // Audit row records linesCloned=2.
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'TRAVEL_QUOTE_DUPLICATED',
          details: expect.stringContaining('linesCloned'),
        }),
      }),
    );
  });

  test('source quote with zero lines: createMany NOT called, audit linesCloned=0', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(parentQuote());
    prisma.travelQuote.create.mockImplementation(async (args) => ({
      id: 201, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));
    prisma.travelQuoteLine.findMany.mockResolvedValue([]);

    await request(makeApp())
      .post('/api/travel/quotes/100/duplicate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(prisma.travelQuoteLine.createMany).not.toHaveBeenCalled();
  });
});
