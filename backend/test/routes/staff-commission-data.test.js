// @ts-check
/**
 * backend/routes/staff.js commission-data aggregation tests.
 *
 * Pins that GET /api/staff/commission-data computes per-staff historical
 * breakdowns live from completed POS sales (Sale.cashierId + SaleLineItem) and
 * successful visit-linked payments (Invoice → Visit → doctorId), instead of
 * reading the empty CommissionData table.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.staffRevenueGoal = { findMany: vi.fn() };
prisma.user = { findMany: vi.fn() };
prisma.sale = { findMany: vi.fn() };
prisma.invoice = { findMany: vi.fn() };
prisma.payment = { aggregate: vi.fn(), findMany: vi.fn() };
prisma.service = { findMany: vi.fn() };

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const staffRouter = requireCJS('../../routes/staff');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/staff', staffRouter);
  return app;
}

beforeEach(() => {
  prisma.staffRevenueGoal.findMany.mockReset();
  prisma.user.findMany.mockReset();
  prisma.user.findMany.mockResolvedValue([]);
  prisma.sale.findMany.mockReset();
  prisma.invoice.findMany.mockReset();
  prisma.payment.aggregate.mockReset();
  prisma.payment.findMany.mockReset();
  prisma.service.findMany.mockReset();
});

describe('GET /api/staff/commission-data — historical data aggregation', () => {
  function currentProfile(overrides = {}) {
    const now = new Date();
    return {
      id: 31,
      tenantId: 1,
      name: 'Standard commission',
      basis: 'REVENUE_PERCENT',
      percentage: '10',
      flatAmount: null,
      period: 'MONTHLY',
      periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
      isActive: true,
      ...overrides,
    };
  }

  test('calculates assigned percentage commission without a revenue goal', async () => {
    prisma.staffRevenueGoal.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([
      { id: 5, name: 'Anita Das', email: 'anita@example.com', commissionProfile: currentProfile() },
    ]);
    prisma.sale.findMany.mockResolvedValue([{
      id: 101, discountTotal: 100,
      lineItems: [{ lineType: 'SERVICE', lineTotal: 1000, quantity: 1 }],
    }]);
    prisma.invoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/staff/commission-data');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      employeeName: 'Anita Das', netSales: 900,
      commissionProfile: { name: 'Standard commission', basis: 'REVENUE_PERCENT' },
      commissionableAmount: 900, commission: 90,
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 1 }),
    }));
  });

  test('applies a flat product rule only to the selected product quantity', async () => {
    prisma.staffRevenueGoal.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([{ id: 5, name: 'Anita Das', commissionProfile: currentProfile({
      basis: 'PER_PRODUCT', percentage: null, flatAmount: '50', appliesToProduct: 'Serum',
    }) }]);
    prisma.sale.findMany.mockResolvedValue([{
      id: 102, discountTotal: 0,
      lineItems: [
        { lineType: 'PRODUCT', name: 'Serum', lineTotal: 400, quantity: 2 },
        { lineType: 'PRODUCT', name: 'Cream', lineTotal: 100, quantity: 1 },
      ],
    }]);
    prisma.invoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/staff/commission-data');
    expect(res.status).toBe(200);
    expect(res.body[0].productRevenue).toBe(500);
    expect(res.body[0].commissionableAmount).toBe(400);
    expect(res.body[0].commission).toBe(100);
  });

  test('uses category-filtered service revenue and avoids double-counting line discounts', async () => {
    prisma.staffRevenueGoal.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([{ id: 5, name: 'Anita Das', commissionProfile: currentProfile({
      basis: 'PER_SERVICE', percentage: '10', appliesToCategory: 'Skin',
    }) }]);
    prisma.sale.findMany.mockResolvedValue([{
      id: 103, discountTotal: 150,
      lineItems: [
        { lineType: 'SERVICE', refId: 21, lineTotal: 900, lineDiscount: 100, quantity: 1 },
        { lineType: 'SERVICE', refId: 22, lineTotal: 100, lineDiscount: 0, quantity: 1 },
      ],
    }]);
    prisma.service.findMany.mockResolvedValue([{ id: 21, category: 'Skin' }, { id: 22, category: 'Hair' }]);
    prisma.invoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/staff/commission-data');
    expect(res.status).toBe(200);
    expect(res.body[0].netSales).toBe(950);
    expect(res.body[0].commissionableAmount).toBe(855); // 900 minus 90% of the order discount
    expect(res.body[0].commission).toBe(85.5);
  });

  test('does not report zero commission when a category lookup fails', async () => {
    prisma.staffRevenueGoal.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([{ id: 5, name: 'Anita Das', commissionProfile: currentProfile({
      basis: 'PER_SERVICE', percentage: '10', appliesToCategory: 'Skin',
    }) }]);
    prisma.sale.findMany.mockResolvedValue([{
      id: 103, discountTotal: 0,
      lineItems: [{ lineType: 'SERVICE', refId: 21, lineTotal: 100, quantity: 1 }],
    }]);
    prisma.service.findMany.mockRejectedValue(new Error('Catalogue unavailable'));
    prisma.invoice.findMany.mockResolvedValue([]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(makeApp()).get('/api/staff/commission-data');
      expect(res.status).toBe(200);
      expect(res.body[0].commission).toBeNull();
      expect(res.body[0].commissionProfile.name).toBe('Standard commission');
    } finally {
      consoleError.mockRestore();
    }
  });

  test('counts each paid invoice once for a flat per invoice rule', async () => {
    prisma.staffRevenueGoal.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([{ id: 5, name: 'Anita Das', commissionProfile: currentProfile({
      basis: 'FLAT_PER_INVOICE', percentage: null, flatAmount: '75',
    }) }]);
    prisma.sale.findMany.mockResolvedValue([
      { id: 101, discountTotal: 0, lineItems: [{ lineType: 'SERVICE', lineTotal: 100 }] },
      { id: 102, discountTotal: 0, lineItems: [{ lineType: 'PRODUCT', lineTotal: 100 }] },
    ]);
    prisma.invoice.findMany.mockResolvedValue([{ id: 501 }]);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 100 } });
    prisma.payment.findMany.mockResolvedValue([{ invoiceId: 501 }]);

    const res = await request(makeApp()).get('/api/staff/commission-data');
    expect(res.status).toBe(200);
    expect(res.body[0].commission).toBe(225);
    expect(prisma.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({ distinct: ['invoiceId'] }));
  });

  test('returns live breakdown from POS line items and visit-linked payments', async () => {
    const periodStart = new Date('2026-07-01');
    const periodEnd = new Date('2026-08-01');

    prisma.staffRevenueGoal.findMany.mockResolvedValue([
      {
        id: 1,
        userId: 5,
        period: 'MONTHLY',
        periodStart,
        periodEnd,
        targetAmount: '1000',
        scope: 'ALL',
        user: { id: 5, name: 'Anita Das', email: 'anita@example.com' },
      },
    ]);

    prisma.sale.findMany.mockResolvedValue([
      {
        id: 101,
        discountTotal: 50,
        lineItems: [
          { lineType: 'SERVICE', lineTotal: 1200 },
          { lineType: 'PRODUCT', lineTotal: 300 },
        ],
      },
    ]);

    prisma.invoice.findMany.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 700 } });

    const res = await request(makeApp({ tenantId: 1 })).get(
      '/api/staff/commission-data',
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const row = res.body[0];
    expect(row.id).toBe(1);
    expect(row.employeeName).toBe('Anita Das');
    expect(row.serviceRevenue).toBe(1900); // 1200 + 700
    expect(row.productRevenue).toBe(300);
    expect(row.totalSales).toBe(2200);
    expect(row.discount).toBe(50);
    expect(row.netSales).toBe(2150);
    expect(row.commission).toBeNull();

    expect(prisma.sale.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 1,
        cashierId: 5,
        status: 'COMPLETED',
        createdAt: { gte: periodStart, lt: periodEnd },
      },
      include: { lineItems: true },
    });
    expect(prisma.invoice.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, visit: { doctorId: 5 } },
      select: { id: true },
    });
    expect(prisma.payment.aggregate).toHaveBeenCalledWith({
      where: {
        tenantId: 1,
        invoiceId: { in: [10, 11] },
        status: 'SUCCESS',
        paidAt: { gte: periodStart, lt: periodEnd },
      },
      _sum: { amount: true },
    });
  });

  test('includes package, membership, and giftcard revenue in totalSales', async () => {
    prisma.staffRevenueGoal.findMany.mockResolvedValue([
      {
        id: 2,
        userId: 6,
        period: 'MONTHLY',
        periodStart: new Date('2026-07-01'),
        periodEnd: new Date('2026-08-01'),
        targetAmount: '5000',
        scope: 'ALL',
        user: { id: 6, name: 'Dr. Harsh', email: 'harsh@example.com' },
      },
    ]);

    prisma.sale.findMany.mockResolvedValue([
      {
        id: 102,
        discountTotal: 100,
        lineItems: [
          { lineType: 'SERVICE', lineTotal: 500 },
          { lineType: 'PACKAGE', lineTotal: 800 },
          { lineType: 'MEMBERSHIP', lineTotal: 400 },
          { lineType: 'GIFTCARD', lineTotal: 300 },
        ],
      },
    ]);

    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    const res = await request(makeApp({ tenantId: 1 })).get(
      '/api/staff/commission-data',
    );

    expect(res.status).toBe(200);
    const row = res.body[0];
    expect(row.serviceRevenue).toBe(500);
    expect(row.productRevenue).toBe(0);
    expect(row.totalSales).toBe(2000);
    expect(row.discount).toBe(100);
    expect(row.netSales).toBe(1900);
  });

  test('filters by employeeName query parameter', async () => {
    prisma.staffRevenueGoal.findMany.mockResolvedValue([
      {
        id: 3,
        userId: 7,
        period: 'MONTHLY',
        periodStart: new Date('2026-07-01'),
        periodEnd: new Date('2026-08-01'),
        targetAmount: '2000',
        scope: 'ALL',
        user: { id: 7, name: 'Bob Smith', email: 'bob@example.com' },
      },
      {
        id: 4,
        userId: 8,
        period: 'MONTHLY',
        periodStart: new Date('2026-07-01'),
        periodEnd: new Date('2026-08-01'),
        targetAmount: '2000',
        scope: 'ALL',
        user: { id: 8, name: 'Alice Das', email: 'alice@example.com' },
      },
    ]);

    prisma.sale.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    const res = await request(makeApp({ tenantId: 1 })).get(
      '/api/staff/commission-data?employeeName=alice',
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].employeeName).toBe('Alice Das');
  });

  test('respects startDate and endDate filters on goal periodStart', async () => {
    prisma.staffRevenueGoal.findMany.mockResolvedValue([]);

    prisma.sale.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });

    const res = await request(makeApp({ tenantId: 1 })).get(
      '/api/staff/commission-data?startDate=2026-07-01&endDate=2026-07-31',
    );

    expect(res.status).toBe(200);
    expect(prisma.staffRevenueGoal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 1,
          periodStart: {
            gte: new Date('2026-07-01'),
            lte: new Date('2026-07-31'),
          },
        },
      }),
    );
  });
});
