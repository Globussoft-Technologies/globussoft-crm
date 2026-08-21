// @ts-check
/**
 * Unit tests for the POS sale coupon-excess wallet credit added in Wave 11.
 *
 * When a FLAT coupon's face value exceeds the net basket total, the leftover
 * amount must be credited to the patient's wallet as a CREDIT_COUPON_EXCESS
 * transaction. The sale itself must complete successfully regardless of
 * wallet-credit side effects.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Sale-create path stubs.
prisma.shift = prisma.shift || {};
prisma.shift.findFirst = vi.fn();
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();
prisma.product = prisma.product || {};
prisma.product.updateMany = vi.fn().mockResolvedValue({ count: 0 });
prisma.sale = prisma.sale || {};
prisma.sale.findFirst = vi.fn().mockResolvedValue(null);
prisma.sale.create = vi.fn();
prisma.invoiceCounter = prisma.invoiceCounter || {};
prisma.invoiceCounter.upsert = vi.fn().mockResolvedValue({ nextSeq: 2 });
prisma.loyaltyConfig = prisma.loyaltyConfig || {};
prisma.loyaltyConfig.findUnique = vi.fn().mockResolvedValue(null);
prisma.loyaltyTransaction = prisma.loyaltyTransaction || {};
prisma.loyaltyTransaction.findFirst = vi.fn().mockResolvedValue(null);
prisma.loyaltyTransaction.create = vi.fn().mockResolvedValue({});
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness', defaultCurrency: 'INR' });
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({});
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.webhook = prisma.webhook || {};
prisma.webhook.findMany = vi.fn().mockResolvedValue([]);

// Coupon + wallet stubs for the excess credit path.
prisma.coupon = prisma.coupon || {};
prisma.coupon.findFirst = vi.fn();
prisma.coupon.update = vi.fn();
prisma.wallet = prisma.wallet || {};
prisma.wallet.findFirst = vi.fn();
prisma.wallet.create = vi.fn();
prisma.wallet.update = vi.fn();
prisma.walletTransaction = prisma.walletTransaction || {};
prisma.walletTransaction.create = vi.fn();

// $transaction passes the prisma client itself so tx.* resolves to prisma.* mocks.
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
        unitPrice: 100,
      },
    ],
    patientId: 5,
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
  prisma.patient.findFirst.mockReset();
  prisma.patient.findFirst.mockResolvedValue({ id: 5 });
  prisma.sale.create.mockReset();
  prisma.sale.create.mockImplementation(({ data }) =>
    Promise.resolve({
      id: 1234,
      invoiceNumber: 'POS-2026-0001',
      ...data,
      lineItems: [],
    }),
  );
  prisma.coupon.findFirst.mockReset();
  prisma.coupon.update.mockReset();
  prisma.wallet.findFirst.mockReset();
  prisma.wallet.create.mockReset();
  prisma.wallet.update.mockReset();
  prisma.walletTransaction.create.mockReset();
  prisma.auditLog.create.mockClear();
  prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness', defaultCurrency: 'INR' });
});

describe('POST /api/pos/sales — FLAT coupon excess credit', () => {
  test('credits excess to patient wallet when FLAT coupon exceeds basket total', async () => {
    prisma.coupon.findFirst.mockResolvedValue({
      id: 9,
      tenantId: 1,
      code: 'FLAT6000',
      isActive: true,
      discountType: 'FLAT',
      discountValue: 6000,
      redemptionCount: 0,
      maxRedemptions: null,
      validFrom: null,
      validUntil: null,
    });
    prisma.wallet.findFirst.mockResolvedValue({
      id: 55,
      tenantId: 1,
      patientId: 5,
      balance: 0,
    });
    prisma.coupon.update.mockResolvedValue({ id: 9, redemptionCount: 1 });
    prisma.walletTransaction.create.mockResolvedValue({ id: 888, amount: 5900 });

    const res = await request(makeApp())
      .post('/api/pos/sales')
      .send(basePayload({
        discountTotal: 100,
        paidAmount: 0,
        couponCode: 'FLAT6000',
      }));

    expect(res.status).toBe(201);
    expect(prisma.coupon.update).toHaveBeenCalledTimes(1);
    expect(prisma.coupon.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 9 },
        data: { redemptionCount: { increment: 1 } },
      }),
    );
    expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
    const txCall = prisma.walletTransaction.create.mock.calls[0][0];
    expect(txCall.data.type).toBe('CREDIT_COUPON_EXCESS');
    expect(txCall.data.amount).toBe(5900);
    expect(txCall.data.reason).toBe('Coupon FLAT6000 excess credited');
    expect(txCall.data.couponId).toBe(9);
  });

  test('no wallet credit when coupon discount is less than basket total', async () => {
    prisma.coupon.findFirst.mockResolvedValue({
      id: 10,
      tenantId: 1,
      code: 'FLAT50',
      isActive: true,
      discountType: 'FLAT',
      discountValue: 50,
      redemptionCount: 0,
      maxRedemptions: null,
      validFrom: null,
      validUntil: null,
    });
    prisma.coupon.update.mockResolvedValue({ id: 10, redemptionCount: 1 });

    const res = await request(makeApp())
      .post('/api/pos/sales')
      .send(basePayload({
        discountTotal: 50,
        paidAmount: 50,
        couponCode: 'FLAT50',
      }));

    expect(res.status).toBe(201);
    expect(prisma.coupon.update).toHaveBeenCalledTimes(1);
    expect(prisma.wallet.findFirst).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  test('no wallet credit for anonymous sale without patientId', async () => {
    prisma.coupon.findFirst.mockResolvedValue({
      id: 11,
      tenantId: 1,
      code: 'FLAT6000',
      isActive: true,
      discountType: 'FLAT',
      discountValue: 6000,
      redemptionCount: 0,
      maxRedemptions: null,
      validFrom: null,
      validUntil: null,
    });
    prisma.coupon.update.mockResolvedValue({ id: 11, redemptionCount: 1 });

    const res = await request(makeApp())
      .post('/api/pos/sales')
      .send(basePayload({
        patientId: null,
        discountTotal: 0,
        paidAmount: 0,
        couponCode: 'FLAT6000',
      }));

    expect(res.status).toBe(201);
    expect(prisma.coupon.update).not.toHaveBeenCalled();
    expect(prisma.wallet.findFirst).not.toHaveBeenCalled();
  });

  test('sale still succeeds when coupon lookup fails', async () => {
    prisma.coupon.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/pos/sales')
      .send(basePayload({
        discountTotal: 0,
        paidAmount: 100,
        couponCode: 'UNKNOWN',
      }));

    expect(res.status).toBe(201);
    expect(prisma.coupon.update).not.toHaveBeenCalled();
    expect(prisma.wallet.findFirst).not.toHaveBeenCalled();
  });
});
