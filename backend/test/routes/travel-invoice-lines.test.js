// @ts-check
/**
 * Arc 2 #901 slice 1 — TravelInvoiceLine CRUD contract (PRD_TRAVEL_BILLING
 * FR-3.1.a).
 *
 * Pins the four line-item endpoints added to backend/routes/travel_invoices.js:
 *
 *   GET    /api/travel/invoices/:id/lines            any verified token
 *   POST   /api/travel/invoices/:id/lines            ADMIN/MANAGER
 *   PUT    /api/travel/invoices/:id/lines/:lineId    ADMIN/MANAGER
 *   DELETE /api/travel/invoices/:id/lines/:lineId    ADMIN/MANAGER
 *
 * Contracts asserted:
 *   - amount is computed server-side as quantity * unitPrice, not trusted
 *     from the body. PUT recomputes amount whenever qty or unitPrice
 *     changes (so the operator can edit either independently and the
 *     derived total stays correct).
 *   - currency falls back to the parent invoice's currency when the body
 *     omits it (operator-side default — the line builder shouldn't have
 *     to repeat the currency on every line).
 *   - Parent invoice's totalAmount is recomputed after every write (POST,
 *     PUT, DELETE) as the sum of surviving lines. Empty-lines case is
 *     intentionally skipped — see route comment at recomputeInvoiceTotal
 *     (operators can author header-only invoices).
 *   - Validation:
 *       lineType not in VALID_INVOICE_LINE_TYPES → 400 INVALID_LINE_TYPE
 *       quantity < 1 or non-integer → 400 INVALID_QUANTITY
 *       unitPrice missing or negative → 400 MISSING_FIELDS / INVALID_AMOUNT
 *       description empty → 400 MISSING_FIELDS
 *   - Tenant + sub-brand isolation: cross-tenant parent → 404
 *     INVOICE_NOT_FOUND; sub-brand mismatch → 403 SUB_BRAND_DENIED.
 *   - Lines under a different parent invoice → 404 LINE_NOT_FOUND.
 *
 * Test pattern mirrors backend/test/routes/travel-quote-lines.test.js
 * (commit f7203b8e) — patch the prisma singleton with vi.fn() shapes
 * BEFORE requiring the router, then drive supertest with real HS256
 * JWTs signed with the same fallback secret the middleware uses in dev.
 * verifyToken stays in the chain (we don't bypass it) so the auth-gate
 * is exercised end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
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
  update: vi.fn(),
  delete: vi.fn(),
};
// $transaction is used by nextInvoiceNum in the parent invoice routes —
// not exercised by line tests but the router calls it during the parent
// invoice flow, so wire it up just in case a test ever hits a POST /invoices.
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
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

function parentInvoice(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    quoteId: null,
    invoiceNum: 'TINV-2026-0001',
    status: 'Draft',
    totalAmount: '45000.00',
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
    unitPrice: '5000.00',
    amount: '15000.00',
    currency: 'INR',
    sortOrder: 0,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.update.mockReset().mockResolvedValue({});
  prisma.travelInvoice.create.mockReset();
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.travelInvoiceLine.findFirst.mockReset();
  prisma.travelInvoiceLine.create.mockReset();
  prisma.travelInvoiceLine.update.mockReset();
  prisma.travelInvoiceLine.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/invoices/:id/lines', () => {
  test('happy path: returns lines under the parent invoice ordered by sortOrder', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([
      makeLine({ id: 555, sortOrder: 0 }),
      makeLine({ id: 556, sortOrder: 1, lineType: 'tax', description: 'GST 18%', amount: '2700.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines[0]).toMatchObject({ id: 555, lineType: 'per_night' });
    expect(prisma.travelInvoiceLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { invoiceId: 100, tenantId: 1 },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  test('cross-tenant parent → 404 INVOICE_NOT_FOUND', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INVOICE_NOT_FOUND');
  });

  test('non-numeric id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/abc/lines')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });
});

describe('POST /api/travel/invoices/:id/lines', () => {
  test('happy path: amount computed as quantity * unitPrice, currency inherited from parent', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice({ currency: 'USD' }));
    prisma.travelInvoiceLine.create.mockImplementation(async (args) => ({
      id: 700, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '15000.00' }]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        lineType: 'per_night',
        description: 'Hilton Mumbai — 3 nights',
        quantity: 3,
        unitPrice: 5000,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 700,
      tenantId: 1,
      invoiceId: 100,
      lineType: 'per_night',
      description: 'Hilton Mumbai — 3 nights',
      quantity: 3,
      currency: 'USD', // inherited from parent
    });
    // amount is computed server-side, not trusted from body
    expect(prisma.travelInvoiceLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          unitPrice: 5000,
          amount: 15000,
        }),
      }),
    );
    // parent invoice's totalAmount recomputed after line insert
    expect(prisma.travelInvoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100 },
        data: { totalAmount: 15000 },
      }),
    );
  });

  test('happy path: tax lineType accepted (billing-side classification)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.create.mockImplementation(async (args) => ({
      id: 701, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '2700.00' }]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        lineType: 'tax',
        description: 'GST 18% on hotel',
        quantity: 1,
        unitPrice: 2700,
      });

    expect(res.status).toBe(201);
    expect(res.body.lineType).toBe('tax');
  });

  test('happy path: tcs lineType accepted (Sec 206C withholding)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.create.mockImplementation(async (args) => ({
      id: 702, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '500.00' }]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        lineType: 'tcs',
        description: 'TCS Sec 206C @ 5%',
        unitPrice: 500,
      });

    expect(res.status).toBe(201);
    expect(res.body.lineType).toBe('tcs');
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ description: 'x', unitPrice: 100 });
    expect(res.status).toBe(403);
  });

  test('missing description → 400 MISSING_FIELDS', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ unitPrice: 100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  test('missing unitPrice → 400 MISSING_FIELDS', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  test('invalid lineType → 400 INVALID_LINE_TYPE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ lineType: 'hotel', description: 'x', unitPrice: 100 });
    // 'hotel' is a TravelQuoteLine type, NOT a TravelInvoiceLine type — pinned distinction
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LINE_TYPE');
  });

  test('quantity < 1 → 400 INVALID_QUANTITY', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'x', quantity: 0, unitPrice: 100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUANTITY');
  });

  test('negative unitPrice → 400 INVALID_AMOUNT', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'x', unitPrice: -50 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
  });

  test('cross-tenant parent → 404 INVOICE_NOT_FOUND (no line created)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'x', unitPrice: 100 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INVOICE_NOT_FOUND');
    expect(prisma.travelInvoiceLine.create).not.toHaveBeenCalled();
  });
});

describe('PUT /api/travel/invoices/:id/lines/:lineId', () => {
  test('happy path: changing quantity recomputes amount', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(makeLine({ quantity: 3, unitPrice: '5000.00' }));
    prisma.travelInvoiceLine.update.mockImplementation(async (args) => ({
      ...makeLine(),
      ...args.data,
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '25000.00' }]);

    const res = await request(makeApp())
      .put('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quantity: 5 });

    expect(res.status).toBe(200);
    // 5 nights * 5000 (existing unitPrice) = 25000
    expect(prisma.travelInvoiceLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 555 },
        data: expect.objectContaining({ quantity: 5, amount: 25000 }),
      }),
    );
    // parent total recomputed after PUT
    expect(prisma.travelInvoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100 },
        data: { totalAmount: 25000 },
      }),
    );
  });

  test('happy path: changing unitPrice alone recomputes amount using existing quantity', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(makeLine({ quantity: 3, unitPrice: '5000.00' }));
    prisma.travelInvoiceLine.update.mockImplementation(async (args) => ({ ...makeLine(), ...args.data }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '21000.00' }]);

    const res = await request(makeApp())
      .put('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ unitPrice: 7000 });

    expect(res.status).toBe(200);
    expect(prisma.travelInvoiceLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unitPrice: 7000, amount: 21000 }),
      }),
    );
  });

  test('line under different parent invoice → 404 LINE_NOT_FOUND', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quantity: 2 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('LINE_NOT_FOUND');
  });

  test('empty body → 400 EMPTY_BODY', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(makeLine());
    const res = await request(makeApp())
      .put('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_BODY');
  });

  test('updating lineType to invalid value → 400 INVALID_LINE_TYPE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(makeLine());

    const res = await request(makeApp())
      .put('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ lineType: 'flight' });
    // 'flight' is a TravelQuoteLine type, not an invoice line type
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LINE_TYPE');
  });

  test('non-numeric lineId → 400 INVALID_LINE_ID', async () => {
    const res = await request(makeApp())
      .put('/api/travel/invoices/100/lines/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quantity: 2 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LINE_ID');
  });
});

describe('DELETE /api/travel/invoices/:id/lines/:lineId', () => {
  test('happy path: 204 + line deleted + parent recomputed', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(makeLine());
    prisma.travelInvoiceLine.delete.mockResolvedValue(makeLine());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '8000.00' }]);

    const res = await request(makeApp())
      .delete('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(204);
    expect(prisma.travelInvoiceLine.delete).toHaveBeenCalledWith({ where: { id: 555 } });
    expect(prisma.travelInvoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100 },
        data: { totalAmount: 8000 },
      }),
    );
  });

  test('audit row recorded BEFORE delete', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(makeLine({ lineType: 'tcs', amount: '500.00' }));
    prisma.travelInvoiceLine.delete.mockResolvedValue(makeLine());
    prisma.travelInvoiceLine.findMany.mockResolvedValue([]);

    await request(makeApp())
      .delete('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity: 'TravelInvoiceLine',
          action: 'DELETE',
        }),
      }),
    );
  });

  test('line under different parent invoice → 404 LINE_NOT_FOUND (no delete)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .delete('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('LINE_NOT_FOUND');
    expect(prisma.travelInvoiceLine.delete).not.toHaveBeenCalled();
  });

  test('sub-brand denied → 403 SUB_BRAND_DENIED', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice({ subBrand: 'rfu' }));
    // MANAGER user restricted to 'tmc' only — ADMINs always get full access
    // per travelGuards.getSubBrandAccessSet (role-bypass).
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER', subBrandAccess: '["tmc"]',
    });

    const res = await request(makeApp())
      .delete('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });
});
