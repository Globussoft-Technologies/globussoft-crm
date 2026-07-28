// @ts-check
/**
 * Route-level tests for the wellness coupon excess field.
 *
 * Pins that /api/wellness/coupons/preview and /api/wellness/coupons/apply
 * both return the new `excess` field, and that `excess` is positive for
 * FLAT coupons whose face value exceeds the base amount.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.coupon = prisma.coupon || {};
prisma.coupon.findFirst = vi.fn();
prisma.coupon.update = vi.fn();
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });
prisma.automationRule = { findMany: vi.fn().mockResolvedValue([]) };
prisma.webhook = { findMany: vi.fn().mockResolvedValue([]) };

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = 'admin',
  vertical = 'wellness',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole, vertical };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

beforeEach(() => {
  prisma.coupon.findFirst.mockReset();
  prisma.coupon.update.mockReset();
  prisma.auditLog.create.mockClear();
});

describe('POST /api/wellness/coupons/preview', () => {
  test('returns excess for a FLAT coupon that exceeds the base amount', async () => {
    prisma.coupon.findFirst.mockResolvedValue({
      id: 1,
      tenantId: 1,
      code: 'FLAT6000',
      isActive: true,
      discountType: 'FLAT',
      discountValue: 6000,
      redemptionCount: 0,
      maxRedemptions: null,
      validFrom: null,
      validUntil: null,
      serviceIds: null,
    });

    const res = await request(makeApp())
      .post('/api/wellness/coupons/preview')
      .send({ code: 'FLAT6000', baseAmount: 5000 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      code: 'FLAT6000',
      discountType: 'FLAT',
      discountValue: 6000,
      baseAmount: 5000,
      discount: 5000,
      finalAmount: 0,
      applied: true,
      excess: 1000,
      balance: 0,
      lockingFee: 0,
    });
  });

  test('returns excess:0 for a PERCENT coupon', async () => {
    prisma.coupon.findFirst.mockResolvedValue({
      id: 2,
      tenantId: 1,
      code: 'PERCENT10',
      isActive: true,
      discountType: 'PERCENT',
      discountValue: 10,
      redemptionCount: 0,
      maxRedemptions: null,
      validFrom: null,
      validUntil: null,
      serviceIds: null,
    });

    const res = await request(makeApp())
      .post('/api/wellness/coupons/preview')
      .send({ code: 'PERCENT10', baseAmount: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.excess).toBe(0);
    expect(res.body.discount).toBe(100);
  });
});

describe('POST /api/wellness/coupons/apply', () => {
  test('returns excess for a FLAT coupon that exceeds the base amount', async () => {
    prisma.coupon.findFirst.mockResolvedValue({
      id: 3,
      tenantId: 1,
      code: 'FLAT6000',
      isActive: true,
      discountType: 'FLAT',
      discountValue: 6000,
      redemptionCount: 0,
      maxRedemptions: null,
      validFrom: null,
      validUntil: null,
      serviceIds: null,
    });
    prisma.coupon.update.mockResolvedValue({
      id: 3,
      redemptionCount: 1,
    });

    const res = await request(makeApp())
      .post('/api/wellness/coupons/apply')
      .send({ code: 'FLAT6000', baseAmount: 5000 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      code: 'FLAT6000',
      discount: 5000,
      finalAmount: 0,
      applied: true,
      excess: 1000,
      redemptionCount: 1,
    });
  });
});
