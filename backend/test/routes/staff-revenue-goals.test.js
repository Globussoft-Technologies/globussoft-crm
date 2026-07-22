// @ts-check
/**
 * backend/routes/staff.js revenue-goals aggregation tests.
 *
 * Pins that GET /api/staff/revenue-goals computes achievedAmount from BOTH
 * completed POS sales (Sale.cashierId) and successful visit-linked payments
 * (Invoice → Visit → doctorId) so that online payments for a staff member's
 * diagnosed appointments fill the revenue-goal progress bar.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.staffRevenueGoal = {
  findMany: vi.fn(),
  update: vi.fn().mockResolvedValue({}),
  create: vi.fn(),
};
prisma.sale = { aggregate: vi.fn() };
prisma.saleLineItem = { findMany: vi.fn() };
prisma.invoice = { findMany: vi.fn() };
prisma.payment = { aggregate: vi.fn() };

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const staffRouter = requireCJS('../../routes/staff');

function formatDateInput(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getGoalWindowBounds() {
  const today = new Date();
  const currentMonthStart = formatDateInput(new Date(today.getFullYear(), today.getMonth(), 1));
  const maxWindowEnd = formatDateInput(new Date(today.getFullYear(), today.getMonth() + 12, 1));
  return { currentMonthStart, maxWindowEnd };
}

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
  prisma.staffRevenueGoal.update.mockReset().mockResolvedValue({});
  prisma.staffRevenueGoal.create.mockReset();
  prisma.sale.aggregate.mockReset();
  prisma.saleLineItem.findMany.mockReset();
  prisma.invoice.findMany.mockReset();
  prisma.payment.aggregate.mockReset();
});

describe('GET /api/staff/revenue-goals — achievement aggregation', () => {
  test('sums completed Sale totals + successful visit-linked Payment amounts', async () => {
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
        achievedAmount: '0',
        scope: 'ALL',
        scopeFilter: null,
        user: { id: 5, name: 'Anita Das' },
      },
    ]);
    prisma.sale.aggregate.mockResolvedValue({ _sum: { total: 300 } });
    prisma.invoice.findMany.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 700 } });

    const res = await request(makeApp({ tenantId: 1 })).get('/api/staff/revenue-goals');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].achievedAmount).toBe(1000);

    expect(prisma.sale.aggregate).toHaveBeenCalledWith({
      where: {
        tenantId: 1,
        cashierId: 5,
        status: 'COMPLETED',
        createdAt: { gte: periodStart, lt: periodEnd },
      },
      _sum: { total: true },
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

  test('SERVICE scope also counts visit-linked payments as service revenue', async () => {
    const periodStart = new Date('2026-07-01');
    const periodEnd = new Date('2026-08-01');
    prisma.staffRevenueGoal.findMany.mockResolvedValue([
      {
        id: 2,
        userId: 6,
        period: 'MONTHLY',
        periodStart,
        periodEnd,
        targetAmount: '5000',
        achievedAmount: '0',
        scope: 'SERVICE',
        scopeFilter: null,
        user: { id: 6, name: 'Dr. Harsh' },
      },
    ]);
    prisma.saleLineItem.findMany.mockResolvedValue([
      { lineTotal: 1000 },
      { lineTotal: 500 },
    ]);
    prisma.invoice.findMany.mockResolvedValue([{ id: 20 }]);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 2500 } });

    const res = await request(makeApp({ tenantId: 1 })).get('/api/staff/revenue-goals');

    expect(res.status).toBe(200);
    expect(res.body[0].achievedAmount).toBe(4000);
  });

  test('PRODUCT/MEMBERSHIP goals do NOT include visit-linked payments', async () => {
    const periodStart = new Date('2026-07-01');
    const periodEnd = new Date('2026-08-01');
    prisma.staffRevenueGoal.findMany.mockResolvedValue([
      {
        id: 3,
        userId: 7,
        period: 'MONTHLY',
        periodStart,
        periodEnd,
        targetAmount: '2000',
        achievedAmount: '0',
        scope: 'PRODUCT',
        scopeFilter: null,
        user: { id: 7, name: 'Bob' },
      },
    ]);
    prisma.saleLineItem.findMany.mockResolvedValue([{ lineTotal: 800 }]);
    prisma.invoice.findMany.mockResolvedValue([{ id: 30 }]);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 5000 } });

    const res = await request(makeApp({ tenantId: 1 })).get('/api/staff/revenue-goals');

    expect(res.status).toBe(200);
    expect(res.body[0].achievedAmount).toBe(800);
    expect(prisma.payment.aggregate).not.toHaveBeenCalled();
  });
});

describe('POST /api/staff/revenue-goals — date validation', () => {
  test('rejects a periodStart before the current month before Prisma create is called', async () => {
    const { currentMonthStart } = getGoalWindowBounds();
    const priorMonthStart = formatDateInput(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1));
    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/staff/revenue-goals')
      .send({
        targetUserId: 5,
        period: 'MONTHLY',
        periodStart: priorMonthStart,
        periodEnd: currentMonthStart,
        targetAmount: 1000,
        scope: 'ALL',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/periodStart cannot be before the current month/i);
    expect(prisma.staffRevenueGoal.create).not.toHaveBeenCalled();
  });

  test('rejects a periodEnd beyond one year from the current month before Prisma create is called', async () => {
    const { currentMonthStart } = getGoalWindowBounds();
    const overLimitEnd = formatDateInput(new Date(new Date().getFullYear(), new Date().getMonth() + 12, 2));

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/staff/revenue-goals')
      .send({
        targetUserId: 5,
        period: 'MONTHLY',
        periodStart: currentMonthStart,
        periodEnd: overLimitEnd,
        targetAmount: 1000,
        scope: 'ALL',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/periodEnd cannot be more than one year from the current month/i);
    expect(prisma.staffRevenueGoal.create).not.toHaveBeenCalled();
  });
});
