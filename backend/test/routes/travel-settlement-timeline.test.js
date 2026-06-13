// PRD_TRAVEL_BILLING G024 (FR-3.6.c) — settlement-timeline aggregator.
//
// Pins the contract for backend/routes/travel_settlement_timeline.js:
//   - Returns {items: [...], summary: {totalInflowExpected, totalOutflowExpected, netExpected}}
//   - Inflow comes from TravelPaymentSchedule joined to its invoice for subBrand
//   - Outflow comes from TravelSupplierPayable joined to its supplier for subBrand
//   - settled/waived/cancelled inflow + paid/cancelled outflow excluded from summary
//   - ?from / ?to required to be parseable; invalid → 400
//   - ?from > ?to → 400 INVERTED_DATE_RANGE
//   - ?subBrand narrows on both sides

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelPaymentSchedule = prisma.travelPaymentSchedule || {};
prisma.travelPaymentSchedule.findMany = vi.fn();
prisma.travelSupplierPayable = prisma.travelSupplierPayable || {};
prisma.travelSupplierPayable.findMany = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
  subBrandConfigJson: null,
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const timelineRouter = requireCJS('../../routes/travel_settlement_timeline');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', timelineRouter);
  return app;
}

function tokenFor(role = 'ADMIN') {
  return jwt.sign(
    { userId: 7, tenantId: 1, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeAll(() => {});

beforeEach(() => {
  prisma.travelPaymentSchedule.findMany.mockReset().mockResolvedValue([]);
  prisma.travelSupplierPayable.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1,
    vertical: 'travel',
    name: 'Test Travel',
    slug: 'test-travel',
    subBrandConfigJson: null,
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
});

describe('GET /api/travel/settlements/timeline', () => {
  test('empty range returns empty items + zero summary', async () => {
    const res = await request(makeApp())
      .get('/api/travel/settlements/timeline?from=2026-06-01&to=2026-07-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      items: [],
      summary: { totalInflowExpected: 0, totalOutflowExpected: 0, netExpected: 0 },
    });
  });

  test('inflow + outflow merged and sorted by dueDate', async () => {
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([
      {
        id: 1,
        invoiceId: 11,
        milestoneOrder: 1,
        dueDate: new Date('2026-06-15T00:00:00Z'),
        expectedAmount: '50000.00',
        expectedCurrency: 'INR',
        status: 'pending',
        invoice: { id: 11, invoiceNum: 'TINV-2026-0011', subBrand: 'tmc' },
      },
    ]);
    prisma.travelSupplierPayable.findMany.mockResolvedValue([
      {
        id: 200,
        supplierId: 99,
        dueDate: new Date('2026-06-10T00:00:00Z'),
        amount: '15000.00',
        currency: 'INR',
        status: 'pending',
        description: 'Hotel block',
        supplier: { id: 99, name: 'Hotel Test', subBrand: 'tmc' },
      },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/settlements/timeline?from=2026-06-01&to=2026-07-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // Sorted ascending by dueDate — payable (2026-06-10) first, schedule (2026-06-15) second.
    expect(res.body.items[0].type).toBe('supplier_payable');
    expect(res.body.items[1].type).toBe('invoice_payment_schedule');
    expect(res.body.summary).toMatchObject({
      totalInflowExpected: 50000,
      totalOutflowExpected: 15000,
      netExpected: 35000,
    });
  });

  test('settled inflow excluded from totalInflowExpected (already collected)', async () => {
    prisma.travelPaymentSchedule.findMany.mockResolvedValue([
      {
        id: 1,
        invoiceId: 11,
        milestoneOrder: 1,
        dueDate: new Date('2026-06-15T00:00:00Z'),
        expectedAmount: '50000.00',
        expectedCurrency: 'INR',
        status: 'paid',
        invoice: { id: 11, invoiceNum: 'TINV-2026-0011', subBrand: 'tmc' },
      },
      {
        id: 2,
        invoiceId: 12,
        milestoneOrder: 1,
        dueDate: new Date('2026-06-20T00:00:00Z'),
        expectedAmount: '30000.00',
        expectedCurrency: 'INR',
        status: 'pending',
        invoice: { id: 12, invoiceNum: 'TINV-2026-0012', subBrand: 'tmc' },
      },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/settlements/timeline?from=2026-06-01&to=2026-07-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.body.summary.totalInflowExpected).toBe(30000);
  });

  test('?subBrand narrows where clause on both queries', async () => {
    await request(makeApp())
      .get('/api/travel/settlements/timeline?from=2026-06-01&to=2026-07-31&subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(prisma.travelPaymentSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ invoice: { subBrand: 'rfu' } }),
      }),
    );
    expect(prisma.travelSupplierPayable.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ supplier: { subBrand: 'rfu' } }),
      }),
    );
  });

  test('?from > ?to returns 400 INVERTED_DATE_RANGE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/settlements/timeline?from=2026-07-31&to=2026-06-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVERTED_DATE_RANGE' });
  });

  test('invalid date returns 400 INVALID_DATE_RANGE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/settlements/timeline?from=not-a-date&to=2026-06-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE_RANGE' });
  });

  test('default range used when from/to omitted', async () => {
    const res = await request(makeApp())
      .get('/api/travel/settlements/timeline')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.range).toBeTruthy();
  });
});
