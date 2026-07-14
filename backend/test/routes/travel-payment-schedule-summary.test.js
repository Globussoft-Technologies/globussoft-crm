// @ts-check
/**
 * Arc 2 #901 slice 7 — GET /api/travel/payment-schedules/upcoming contract
 * (PRD_TRAVEL_BILLING UC-2.5 month-end-close + DD-5.5 reminders cadence).
 *
 * Pins the cross-invoice milestone summary endpoint added to
 * backend/routes/travel_invoices.js. Slice 6 (commit af0c6709) shipped the
 * per-invoice CRUD; this slice ships the cross-invoice aggregate read.
 *
 * Contracts asserted:
 *   - Happy path: returns milestone rows with joined invoiceNum/subBrand/
 *     contactId fields hoisted onto each row (not nested under .invoice).
 *   - ?status=pending narrows the prisma where filter.
 *   - ?overdueOnly=true filters dueDate < now (overrides ?within).
 *   - ?within=7 filters dueDate <= now + 7 days.
 *   - ?subBrand=tmc adds a nested invoice.subBrand filter.
 *   - summary.byStatus counts match the milestones returned.
 *   - summary.totalExpected = sum of expectedAmount across the returned page.
 *   - summary.currencyBreakdown groups by expectedCurrency.
 *   - Invalid ?status → 400 INVALID_STATUS.
 *   - Invalid ?within (non-numeric / zero / negative) → 400 INVALID_WITHIN.
 *   - Invalid ?subBrand → 400 INVALID_SUB_BRAND.
 *   - ?limit=1000 → clamped to 500.
 *   - Sub-brand-restricted MANAGER: caller with subBrandAccess=["tmc"] gets
 *     invoice.subBrand={in:["tmc"]} pushed into the prisma where, so RFU
 *     rows can't be queried.
 *
 * Test pattern mirrors backend/test/routes/travel-payment-schedule.test.js
 * (commit af0c6709) — patch the prisma singleton with vi.fn() shapes BEFORE
 * requiring the router, then drive supertest with real HS256 JWTs signed
 * with the same fallback secret the middleware uses in dev.
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
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelPaymentSchedule = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
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

function makeMilestone(overrides = {}) {
  return {
    id: 555,
    tenantId: 1,
    invoiceId: 100,
    milestoneOrder: 1,
    dueDate: new Date(Date.now() + 3 * 86_400_000),
    expectedAmount: '30000.00',
    expectedCurrency: 'INR',
    receivedAmount: null,
    status: 'pending',
    paidAt: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    invoice: {
      invoiceNum: 'TINV-2026-0001',
      subBrand: 'tmc',
      contactId: 999,
    },
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelPaymentSchedule.findMany.mockReset().mockResolvedValue([]);
  prisma.travelPaymentSchedule.count.mockReset().mockResolvedValue(0);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
});

describe('GET /api/travel/payment-schedules/upcoming', () => {
  test('happy path: returns milestones with hoisted invoice fields + summary block', async () => {
    const rows = [
      makeMilestone({
        id: 1, expectedAmount: '30000.00', status: 'pending',
        invoice: { invoiceNum: 'TINV-2026-0001', subBrand: 'tmc', contactId: 111 },
      }),
      makeMilestone({
        id: 2, expectedAmount: '60000.00', status: 'partial', expectedCurrency: 'INR',
        invoice: { invoiceNum: 'TINV-2026-0002', subBrand: 'rfu', contactId: 222 },
      }),
    ];
    prisma.travelPaymentSchedule.findMany.mockResolvedValue(rows);
    prisma.travelPaymentSchedule.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
    expect(res.body.milestones).toHaveLength(2);
    // Joined invoice fields hoisted onto the milestone row.
    expect(res.body.milestones[0]).toMatchObject({
      id: 1, invoiceNum: 'TINV-2026-0001', subBrand: 'tmc', contactId: 111,
      expectedAmount: '30000.00', status: 'pending',
    });
    expect(res.body.milestones[1]).toMatchObject({
      id: 2, invoiceNum: 'TINV-2026-0002', subBrand: 'rfu', contactId: 222,
    });
    // daysUntilDue computed.
    expect(typeof res.body.milestones[0].daysUntilDue).toBe('number');
    // Summary block present.
    expect(res.body.summary).toMatchObject({
      byStatus: { pending: 1, partial: 1 },
      totalExpected: '90000.00',
    });
    // findMany called with include for the invoice join.
    expect(prisma.travelPaymentSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          invoice: expect.objectContaining({
            select: expect.objectContaining({
              invoiceNum: true, subBrand: true, contactId: true,
            }),
          }),
        }),
        where: expect.objectContaining({ tenantId: 1 }),
      }),
    );
  });

  test('a PAID milestone with a past dueDate gets daysUntilDue: null, NOT a negative "overdue" count (settled status overrides pure date math)', async () => {
    const rows = [
      makeMilestone({
        id: 3, status: 'paid', dueDate: new Date(Date.now() - 14 * 86_400_000),
        invoice: { invoiceNum: 'TINV-2026-0014', subBrand: 'rfu', contactId: 333 },
      }),
    ];
    prisma.travelPaymentSchedule.findMany.mockResolvedValue(rows);
    prisma.travelPaymentSchedule.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.milestones[0].status).toBe('paid');
    expect(res.body.milestones[0].daysUntilDue).toBeNull();
  });

  test('a WAIVED milestone with a past dueDate also gets daysUntilDue: null', async () => {
    const rows = [
      makeMilestone({
        id: 4, status: 'waived', dueDate: new Date(Date.now() - 5 * 86_400_000),
      }),
    ];
    prisma.travelPaymentSchedule.findMany.mockResolvedValue(rows);
    prisma.travelPaymentSchedule.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.body.milestones[0].daysUntilDue).toBeNull();
  });

  test('a PENDING milestone with a past dueDate KEEPS its real negative daysUntilDue (only paid/waived are suppressed)', async () => {
    const rows = [
      makeMilestone({
        id: 5, status: 'pending', dueDate: new Date(Date.now() - 3 * 86_400_000),
      }),
    ];
    prisma.travelPaymentSchedule.findMany.mockResolvedValue(rows);
    prisma.travelPaymentSchedule.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.body.milestones[0].daysUntilDue).toBeLessThan(0);
  });

  test('?status=pending narrows the prisma where filter', async () => {
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([]);
    prisma.travelPaymentSchedule.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming?status=pending')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelPaymentSchedule.findMany.mock.calls[0][0];
    expect(callArg.where.status).toBe('pending');
  });

  test('?overdueOnly=true filters dueDate < now (overrides ?within)', async () => {
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([]);
    prisma.travelPaymentSchedule.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming?overdueOnly=true&within=30')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelPaymentSchedule.findMany.mock.calls[0][0];
    expect(callArg.where.dueDate).toHaveProperty('lt');
    expect(callArg.where.dueDate).not.toHaveProperty('lte');
    expect(callArg.where.dueDate.lt).toBeInstanceOf(Date);
  });

  test('?within=7 filters dueDate <= now+7days', async () => {
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([]);
    prisma.travelPaymentSchedule.count.mockResolvedValue(0);

    const before = Date.now();
    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming?within=7')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const after = Date.now();

    expect(res.status).toBe(200);
    const callArg = prisma.travelPaymentSchedule.findMany.mock.calls[0][0];
    expect(callArg.where.dueDate).toHaveProperty('lte');
    const lteMs = callArg.where.dueDate.lte.getTime();
    // Should be ~7 days from now (allow generous slack for slow CI).
    expect(lteMs).toBeGreaterThanOrEqual(before + 7 * 86_400_000 - 5_000);
    expect(lteMs).toBeLessThanOrEqual(after + 7 * 86_400_000 + 5_000);
  });

  test('?subBrand=tmc nests an invoice.subBrand filter through the join', async () => {
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([]);
    prisma.travelPaymentSchedule.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming?subBrand=tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .expect(200);

    const callArg = prisma.travelPaymentSchedule.findMany.mock.calls[0][0];
    expect(callArg.where.invoice).toMatchObject({ is: { subBrand: 'tmc' } });
  });

  test('summary.byStatus counts match the rows returned', async () => {
    const rows = [
      makeMilestone({ id: 1, status: 'pending', expectedAmount: '10000.00' }),
      makeMilestone({ id: 2, status: 'pending', expectedAmount: '20000.00' }),
      makeMilestone({ id: 3, status: 'overdue', expectedAmount: '5000.00' }),
      makeMilestone({ id: 4, status: 'partial', expectedAmount: '15000.00' }),
    ];
    prisma.travelPaymentSchedule.findMany.mockResolvedValue(rows);
    prisma.travelPaymentSchedule.count.mockResolvedValue(4);

    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.body.summary.byStatus).toEqual({
      pending: 2,
      overdue: 1,
      partial: 1,
    });
  });

  test('summary.totalExpected sums expectedAmount across the page', async () => {
    const rows = [
      makeMilestone({ id: 1, expectedAmount: '30000.00' }),
      makeMilestone({ id: 2, expectedAmount: '45000.50' }),
      makeMilestone({ id: 3, expectedAmount: '12500.25' }),
    ];
    prisma.travelPaymentSchedule.findMany.mockResolvedValue(rows);
    prisma.travelPaymentSchedule.count.mockResolvedValue(3);

    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.body.summary.totalExpected).toBe('87500.75');
    // totalReceived sums receivedAmount (all null in the fixtures → "0.00").
    expect(res.body.summary.totalReceived).toBe('0.00');
  });

  test('summary.currencyBreakdown groups by expectedCurrency', async () => {
    const rows = [
      makeMilestone({ id: 1, expectedAmount: '30000.00', expectedCurrency: 'INR' }),
      makeMilestone({ id: 2, expectedAmount: '20000.00', expectedCurrency: 'INR' }),
      makeMilestone({ id: 3, expectedAmount: '500.00', expectedCurrency: 'USD' }),
      makeMilestone({ id: 4, expectedAmount: '250.50', expectedCurrency: 'USD' }),
    ];
    prisma.travelPaymentSchedule.findMany.mockResolvedValue(rows);
    prisma.travelPaymentSchedule.count.mockResolvedValue(4);

    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.body.summary.currencyBreakdown).toEqual({
      INR: '50000.00',
      USD: '750.50',
    });
  });

  test('invalid ?status returns 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming?status=frozen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.travelPaymentSchedule.findMany).not.toHaveBeenCalled();
  });

  test('invalid ?within (non-numeric) returns 400 INVALID_WITHIN', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming?within=abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_WITHIN' });
    expect(prisma.travelPaymentSchedule.findMany).not.toHaveBeenCalled();
  });

  test('invalid ?subBrand returns 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming?subBrand=nonsense')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelPaymentSchedule.findMany).not.toHaveBeenCalled();
  });

  test('?limit=1000 is clamped to 500', async () => {
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([]);
    prisma.travelPaymentSchedule.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming?limit=1000')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(500);
    const callArg = prisma.travelPaymentSchedule.findMany.mock.calls[0][0];
    expect(callArg.take).toBe(500);
  });

  test('sub-brand-restricted MANAGER cannot see RFU rows (where narrows to allowed set)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([]);
    prisma.travelPaymentSchedule.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .expect(200);

    const callArg = prisma.travelPaymentSchedule.findMany.mock.calls[0][0];
    // The where should funnel through invoice.subBrand IN ['tmc'].
    expect(callArg.where.invoice).toMatchObject({
      is: { subBrand: { in: ['tmc'] } },
    });
  });

  test('sub-brand-restricted MANAGER asking for forbidden sub-brand gets silently-empty filter', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([]);
    prisma.travelPaymentSchedule.count.mockResolvedValue(0);

    await request(makeApp())
      .get('/api/travel/payment-schedules/upcoming?subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .expect(200);

    const callArg = prisma.travelPaymentSchedule.findMany.mock.calls[0][0];
    // Should substitute __none__ (never-matches) rather than 403.
    expect(callArg.where.invoice).toMatchObject({
      is: { subBrand: '__none__' },
    });
  });
});
