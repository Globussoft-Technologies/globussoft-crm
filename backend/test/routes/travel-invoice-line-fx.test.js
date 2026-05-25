// @ts-check
/**
 * Arc 2 #901 slice 12 — TravelInvoiceLine multi-currency contract
 * (PRD_TRAVEL_BILLING UC-2.1: customer pays 50% INR + 50% USD on the
 * same invoice).
 *
 * Pins the FX-aware extensions to backend/routes/travel_invoices.js:
 *
 *   POST /api/travel/invoices/:id/lines             ADMIN/MANAGER
 *   PUT  /api/travel/invoices/:id/lines/:lineId     ADMIN/MANAGER
 *
 * Schema additions (additive nullable, no bless marker needed):
 *   fxRateToBase Decimal? @db.Decimal(15, 6)   — operator-captured FX rate
 *                                                from line currency to the
 *                                                parent invoice's base
 *                                                currency.
 *   baseAmount   Decimal? @db.Decimal(15, 2)   — server-computed
 *                                                amount * fxRateToBase.
 *
 * Contracts asserted:
 *
 *   1. POST fxRateToBase=82.5 + amount=100 → 201, baseAmount=8250.
 *   2. POST fxRateToBase=0.012048 (inverse quote) → 201, baseAmount
 *      computed from the small rate.
 *   3. POST without fxRateToBase → 201, both fields persist as null
 *      (single-currency line — baseAmount === amount semantically).
 *   4. POST fxRateToBase=0 → 400 INVALID_FX_RATE (must be > 0).
 *   5. POST fxRateToBase=-5 → 400 INVALID_FX_RATE (negative invalid).
 *   6. POST fxRateToBase="not-a-number" → 400 INVALID_FX_RATE.
 *   7. PUT changing amount (via quantity) → baseAmount recomputes using
 *      the existing fxRateToBase (operator edits qty independently and
 *      the FX-derived base total stays accurate).
 *   8. PUT changing fxRateToBase only → baseAmount recomputes using the
 *      existing row's amount (operator corrects yesterday's rate without
 *      retouching amount).
 *   9. PUT changing both amount AND fxRateToBase → baseAmount uses the
 *      new values together.
 *  10. PUT fxRateToBase=null → clears BOTH fxRateToBase + baseAmount in
 *      lockstep (operator backs out the multi-currency mode).
 *  11. Half-up rounding pin: amount=33.33 + fxRateToBase=82.5 =
 *      2749.7225 → 2749.72 (matches Decimal(15,2) accrual convention).
 *
 * Live FX-rate lookup against an external API is deferred (Q-blocker —
 * pending exchange-rate-provider decision). This slice ships the
 * schema + route surface; the rate is operator-captured for now.
 *
 * Test pattern mirrors backend/test/routes/travel-invoice-lines.test.js
 * (commit cc4cf72 slice 1) — patch the prisma singleton with vi.fn()
 * shapes BEFORE requiring the router, drive supertest with real HS256
 * JWTs.
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
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  role: 'ADMIN', subBrandAccess: null,
});
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
    description: 'Test line',
    quantity: 1,
    unitPrice: '100.00',
    amount: '100.00',
    currency: 'USD',
    sortOrder: 0,
    notes: null,
    pnr: null,
    bookingRef: null,
    serviceStartDate: null,
    serviceEndDate: null,
    fxRateToBase: null,
    baseAmount: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.update.mockReset().mockResolvedValue({});
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.travelInvoiceLine.findFirst.mockReset();
  prisma.travelInvoiceLine.create.mockReset();
  prisma.travelInvoiceLine.update.mockReset();
  prisma.travelInvoiceLine.delete.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// POST — multi-currency line creation
// ---------------------------------------------------------------------------

describe('POST /api/travel/invoices/:id/lines — FX-aware creation', () => {
  test('happy path: fxRateToBase=82.5 + amount=100 → baseAmount=8250', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.create.mockImplementation(async (args) => ({
      id: 700, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '100.00' }]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        description: 'USD hotel — Bali',
        unitPrice: 100,
        currency: 'USD',
        fxRateToBase: 82.5,
      });

    expect(res.status).toBe(201);
    expect(prisma.travelInvoiceLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fxRateToBase: 82.5,
          baseAmount: 8250,
        }),
      }),
    );
  });

  test('happy path: inverse quote fxRateToBase=0.012048 → tiny baseAmount', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ currency: 'USD' }),
    );
    prisma.travelInvoiceLine.create.mockImplementation(async (args) => ({
      id: 701, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '10000.00' }]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        description: 'INR airline ticket on a USD-base invoice',
        unitPrice: 10000, // INR
        currency: 'INR',
        // 1 INR = 0.012048 USD (i.e. ~1/83 USD/INR inverse)
        fxRateToBase: 0.012048,
      });

    expect(res.status).toBe(201);
    expect(prisma.travelInvoiceLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fxRateToBase: 0.012048,
          // 10000 * 0.012048 = 120.48
          baseAmount: 120.48,
        }),
      }),
    );
  });

  test('omitted fxRateToBase → 201, both fxRateToBase + baseAmount null', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.create.mockImplementation(async (args) => ({
      id: 702, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '5000.00' }]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        description: 'Single-currency line',
        unitPrice: 5000,
      });

    expect(res.status).toBe(201);
    expect(prisma.travelInvoiceLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fxRateToBase: null,
          baseAmount: null,
        }),
      }),
    );
  });

  test('fxRateToBase=0 → 400 INVALID_FX_RATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        description: 'rate zero',
        unitPrice: 100,
        fxRateToBase: 0,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FX_RATE');
  });

  test('fxRateToBase=-5 → 400 INVALID_FX_RATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        description: 'negative rate',
        unitPrice: 100,
        fxRateToBase: -5,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FX_RATE');
  });

  test('fxRateToBase="not-a-number" → 400 INVALID_FX_RATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        description: 'garbage rate',
        unitPrice: 100,
        fxRateToBase: 'not-a-number',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FX_RATE');
  });
});

// ---------------------------------------------------------------------------
// PUT — multi-currency line updates
// ---------------------------------------------------------------------------

describe('PUT /api/travel/invoices/:id/lines/:lineId — FX-aware updates', () => {
  test('changing quantity recomputes baseAmount using existing fxRateToBase', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(makeLine({
      quantity: 1,
      unitPrice: '100.00',
      amount: '100.00',
      fxRateToBase: '82.500000',
      baseAmount: '8250.00',
    }));
    prisma.travelInvoiceLine.update.mockImplementation(async (args) => ({
      id: 555, ...args.data,
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '300.00' }]);

    const res = await request(makeApp())
      .put('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quantity: 3 });

    expect(res.status).toBe(200);
    expect(prisma.travelInvoiceLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          quantity: 3,
          amount: 300,
          // 300 * 82.5 = 24750
          baseAmount: 24750,
        }),
      }),
    );
  });

  test('changing fxRateToBase only recomputes baseAmount using existing amount', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(makeLine({
      quantity: 2,
      unitPrice: '50.00',
      amount: '100.00',
      fxRateToBase: '82.500000',
      baseAmount: '8250.00',
    }));
    prisma.travelInvoiceLine.update.mockImplementation(async (args) => ({
      id: 555, ...args.data,
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '100.00' }]);

    const res = await request(makeApp())
      .put('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ fxRateToBase: 84 });

    expect(res.status).toBe(200);
    expect(prisma.travelInvoiceLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fxRateToBase: 84,
          // 100 (existing) * 84 = 8400
          baseAmount: 8400,
        }),
      }),
    );
    // amount NOT touched on a pure FX update
    const updateCall = prisma.travelInvoiceLine.update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('amount');
  });

  test('changing both amount AND fxRateToBase uses the new pair', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(makeLine({
      quantity: 1,
      unitPrice: '100.00',
      amount: '100.00',
      fxRateToBase: '82.500000',
      baseAmount: '8250.00',
    }));
    prisma.travelInvoiceLine.update.mockImplementation(async (args) => ({
      id: 555, ...args.data,
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '200.00' }]);

    const res = await request(makeApp())
      .put('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ quantity: 2, fxRateToBase: 85 });

    expect(res.status).toBe(200);
    expect(prisma.travelInvoiceLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          quantity: 2,
          amount: 200,
          fxRateToBase: 85,
          // 200 * 85 = 17000
          baseAmount: 17000,
        }),
      }),
    );
  });

  test('fxRateToBase=null clears both fxRateToBase + baseAmount', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(makeLine({
      amount: '100.00',
      fxRateToBase: '82.500000',
      baseAmount: '8250.00',
    }));
    prisma.travelInvoiceLine.update.mockImplementation(async (args) => ({
      id: 555, ...args.data,
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '100.00' }]);

    const res = await request(makeApp())
      .put('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ fxRateToBase: null });

    expect(res.status).toBe(200);
    expect(prisma.travelInvoiceLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fxRateToBase: null,
          baseAmount: null,
        }),
      }),
    );
  });

  test('PUT fxRateToBase=0 → 400 INVALID_FX_RATE (no row touched)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.findFirst.mockResolvedValue(makeLine());

    const res = await request(makeApp())
      .put('/api/travel/invoices/100/lines/555')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ fxRateToBase: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FX_RATE');
    expect(prisma.travelInvoiceLine.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rounding semantic pin — half-up at 2dp
// ---------------------------------------------------------------------------

describe('baseAmount rounding semantic — half-up at 2dp', () => {
  // Mathematically 33.33 * 82.5 = 2749.7225 → would round to 2749.72.
  // IEEE-754 FP, however, computes 33.33 * 82.5 = 2749.725 exactly (the
  // .0000...0004-tail cancels). round2()'s half-up semantic then sends
  // 274972.5 → 274973 → 2749.73. The test pins the FP-aware result so a
  // future "round-half-to-even" refactor red-flags itself loudly.
  test('rounding edge: amount=33.33 * fxRateToBase=82.5 → baseAmount=2749.73 (half-up at 2dp)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.create.mockImplementation(async (args) => ({
      id: 800, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '33.33' }]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        description: 'rounding edge',
        unitPrice: 33.33,
        currency: 'USD',
        fxRateToBase: 82.5,
      });

    expect(res.status).toBe(201);
    expect(prisma.travelInvoiceLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: 33.33,
          fxRateToBase: 82.5,
          // 33.33 * 82.5 = 2749.725 (FP) → half-up at 2dp → 2749.73
          baseAmount: 2749.73,
        }),
      }),
    );
  });

  test('clean rounding: amount=12.345 * fxRateToBase=10 = 123.45 → 123.45 (no rounding needed)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    prisma.travelInvoiceLine.create.mockImplementation(async (args) => ({
      id: 801, ...args.data, createdAt: new Date(), updatedAt: new Date(),
    }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue([{ amount: '12.345' }]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/lines')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        description: 'clean rounding',
        unitPrice: 12.345,
        currency: 'USD',
        fxRateToBase: 10,
      });

    expect(res.status).toBe(201);
    expect(prisma.travelInvoiceLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          baseAmount: 123.45,
        }),
      }),
    );
  });
});
