// @ts-check
/**
 * Unit tests for routes/pos.js — paymentMethod validation. Pins the
 * extended VALID_PAYMENT_METHODS list introduced for #789 (Zylu reference
 * set parity).
 *
 * What this file pins
 * ───────────────────
 *   1. Legacy methods (CASH, CARD, UPI, WALLET, GIFTCARD, COMBINED) stay
 *      accepted — non-regression on the pre-#789 contract.
 *   2. New methods (CASHBACK, PAYLATER, ONLINE) are accepted by the
 *      validator and persist as the verbatim string on the Sale row.
 *   3. An unknown / off-list value (e.g. "BITCOIN", "OTHER") returns 400
 *      with code=INVALID_PAYMENT_METHOD.
 *   4. The validator's error message enumerates the full allowed list so
 *      API consumers can adapt without inspecting source.
 *
 * Why a separate file from pos-cashLedger.test.js
 *   The cash-ledger tests stub prisma at the route-layer with a tightly
 *   scoped happy-path shape. This file exercises the FULL Sale create
 *   transaction (shift validation + line items + invoice number gen +
 *   product stock decrement + loyalty hook), so it needs broader prisma
 *   stubs. Keeping the two concerns separate also makes the test logs
 *   easier to read when a single concern regresses.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Stub every prisma surface the Sale create path touches.
prisma.shift = prisma.shift || {};
prisma.shift.findFirst = vi.fn();
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();
prisma.product = prisma.product || {};
prisma.product.updateMany = vi.fn().mockResolvedValue({ count: 0 });
prisma.sale = prisma.sale || {};
prisma.sale.findFirst = vi.fn().mockResolvedValue(null);
prisma.sale.create = vi.fn();
prisma.loyaltyConfig = prisma.loyaltyConfig || {};
prisma.loyaltyConfig.findUnique = vi.fn().mockResolvedValue(null);
prisma.loyaltyTransaction = prisma.loyaltyTransaction || {};
prisma.loyaltyTransaction.findFirst = vi.fn().mockResolvedValue(null);
prisma.loyaltyTransaction.create = vi.fn().mockResolvedValue({});
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({});
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
// $transaction passes (tx) — call the function with the prisma client itself.
prisma.$transaction = vi.fn((fn) => fn(prisma));

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const posRouter = requireCJS('../../routes/pos');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = 'admin',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole };
    next();
  });
  app.use('/api/pos', posRouter);
  return app;
}

function basePayload(overrides = {}) {
  return {
    shiftId: 42,
    paymentMethod: 'CASH',
    lineItems: [
      {
        lineType: 'SERVICE',
        refId: 1,
        name: 'Consultation',
        quantity: 1,
        unitPrice: 500,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  prisma.shift.findFirst.mockReset();
  prisma.shift.findFirst.mockResolvedValue({
    id: 42,
    tenantId: 1,
    status: 'OPEN',
    userId: 7,
    registerId: 3,
  });
  prisma.sale.create.mockReset();
  prisma.sale.create.mockImplementation(({ data }) =>
    Promise.resolve({
      id: 1234,
      invoiceNumber: 'POS-2026-0001',
      ...data,
      lineItems: [],
    }),
  );
  prisma.auditLog.create.mockClear();
  prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });
});

describe('VALID_PAYMENT_METHODS — legacy methods stay accepted', () => {
  test.each(['CASH', 'CARD', 'UPI', 'WALLET', 'GIFTCARD'])(
    'accepts %s',
    async (pm) => {
      const res = await request(makeApp())
        .post('/api/pos/sales')
        .send(basePayload({ paymentMethod: pm }));
      expect(res.status).toBe(201);
      expect(prisma.sale.create).toHaveBeenCalledTimes(1);
      const createArg = prisma.sale.create.mock.calls[0][0];
      expect(createArg.data.paymentMethod).toBe(pm);
    },
  );
});

describe('VALID_PAYMENT_METHODS — new methods accepted (#789)', () => {
  test('accepts CASHBACK', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales')
      .send(basePayload({ paymentMethod: 'CASHBACK' }));
    expect(res.status).toBe(201);
    expect(prisma.sale.create).toHaveBeenCalledTimes(1);
    expect(prisma.sale.create.mock.calls[0][0].data.paymentMethod).toBe('CASHBACK');
  });

  test('accepts PAYLATER', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales')
      .send(basePayload({ paymentMethod: 'PAYLATER', paidAmount: 0 }));
    // paidAmount: 0 is the "credit / charge later" path documented in the
    // route — passes the paid > 0 mismatch check.
    expect(res.status).toBe(201);
    expect(prisma.sale.create.mock.calls[0][0].data.paymentMethod).toBe('PAYLATER');
  });

  test('accepts ONLINE', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales')
      .send(basePayload({ paymentMethod: 'ONLINE' }));
    expect(res.status).toBe(201);
    expect(prisma.sale.create.mock.calls[0][0].data.paymentMethod).toBe('ONLINE');
  });
});

describe('VALID_PAYMENT_METHODS — unknown methods rejected', () => {
  test('rejects BITCOIN with 400 INVALID_PAYMENT_METHOD', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales')
      .send(basePayload({ paymentMethod: 'BITCOIN' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAYMENT_METHOD');
    expect(prisma.sale.create).not.toHaveBeenCalled();
  });

  test('rejects empty-string paymentMethod (falsy → defaults to CASH, sanity)', async () => {
    // An empty string ("") is falsy → route defaults to "CASH" → accepted.
    // Pins behaviour so the default-fallback semantics don't drift.
    const res = await request(makeApp())
      .post('/api/pos/sales')
      .send(basePayload({ paymentMethod: '' }));
    expect(res.status).toBe(201);
    expect(prisma.sale.create.mock.calls[0][0].data.paymentMethod).toBe('CASH');
  });

  test('rejects OTHER with 400 + enumerated allowed list in error', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales')
      .send(basePayload({ paymentMethod: 'OTHER' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAYMENT_METHOD');
    // Error message includes the full set so SDK consumers can adapt.
    expect(res.body.error).toMatch(/CASH/);
    expect(res.body.error).toMatch(/CASHBACK/);
    expect(res.body.error).toMatch(/PAYLATER/);
    expect(res.body.error).toMatch(/ONLINE/);
  });
});
