// @ts-check
/**
 * Arc 2 #901 slice 23 — GET /api/travel/invoices/aged-receivable contract
 * (PRD_TRAVEL_BILLING FR-3.6.a aged-receivable bucketed report).
 *
 * Pins the new sub-path endpoint added to backend/routes/travel_invoices.js
 * alongside the existing /payment-schedules/upcoming and /gstr1-export
 * aggregate reads. Bucketing follows FR-3.6.a verbatim:
 *   0-30 / 31-60 / 61-90 / 90+ days past due (plus `notYetDue` for invoices
 *   whose dueDate is in the future or null).
 *
 * Per-invoice outstanding balance = totalAmount - sum(schedule.receivedAmount).
 * Half-up rounded to 2dp.
 *
 * Contracts asserted (3+ tests required per slice convention):
 *   - Happy path: returns invoices array + buckets + totals; outstanding
 *     subtracts schedule.receivedAmount from totalAmount; bucket assignment
 *     matches the day-bin classification.
 *   - Bucket boundaries: dueDate at -30/-31/-60/-61/-90/-91 days assigns
 *     to "0-30" / "31-60" / "61-90" / "90+" respectively (half-open
 *     buckets — exactly 30 days past due lands in "0-30").
 *   - notYetDue bucket: dueDate in future OR null routes to notYetDue.
 *   - ?subBrand=tmc narrows the prisma where filter.
 *   - ?contactId=999 narrows the prisma where filter.
 *   - ?asOf=2026-05-25 buckets against that date instead of "now"
 *     (reproducible snapshot use case).
 *   - Invalid ?asOf → 400 INVALID_AS_OF.
 *   - Invalid ?subBrand → 400 INVALID_SUB_BRAND.
 *   - Invalid ?contactId → 400 INVALID_CONTACT_ID.
 *   - USER role → 403 (verifyRole gate blocks before findMany).
 *   - Sub-brand-restricted MANAGER (subBrandAccess=["tmc"]) gets the
 *     where.subBrand={in:["tmc"]} narrowing applied.
 *   - currencyBreakdown groups by invoice.currency.
 *
 * Test pattern mirrors backend/test/routes/travel-payment-schedule-summary.test.js
 * (slice 7) — patch prisma singleton with vi.fn() shapes BEFORE the router
 * is required, drive supertest with real HS256 JWTs.
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
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  count: vi.fn().mockResolvedValue(0),
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

/** Construct an invoice fixture relative to a fixed asOf date. */
function makeInvoice({
  id = 100,
  subBrand = 'tmc',
  contactId = 999,
  invoiceNum = 'TINV-2026-0001',
  status = 'Issued',
  totalAmount = '30000.00',
  currency = 'INR',
  dueDate = null,
  schedule = [],
} = {}) {
  return {
    id,
    tenantId: 1,
    subBrand,
    contactId,
    invoiceNum,
    status,
    totalAmount,
    currency,
    dueDate,
    paidAt: null,
    docType: 'TaxInvoice',
    schedule,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

const AS_OF_FIXED = new Date('2026-05-25T00:00:00.000Z');
function daysAgo(n) {
  return new Date(AS_OF_FIXED.getTime() - n * 86_400_000);
}
function daysAhead(n) {
  return new Date(AS_OF_FIXED.getTime() + n * 86_400_000);
}

beforeEach(() => {
  prisma.travelInvoice.findMany.mockReset().mockResolvedValue([]);
  prisma.travelInvoice.count.mockReset().mockResolvedValue(0);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
});

describe('GET /api/travel/invoices/aged-receivable', () => {
  test('happy path: returns invoices + bucketed summary + outstanding subtracts schedule.receivedAmount', async () => {
    const invoices = [
      makeInvoice({
        id: 1,
        invoiceNum: 'TINV-2026-0001',
        totalAmount: '30000.00',
        dueDate: daysAgo(10), // 0-30 bucket
        schedule: [{ receivedAmount: '5000.00', status: 'partial' }],
      }),
      makeInvoice({
        id: 2,
        invoiceNum: 'TINV-2026-0002',
        totalAmount: '60000.00',
        dueDate: daysAgo(45), // 31-60
        schedule: [],
      }),
      makeInvoice({
        id: 3,
        invoiceNum: 'TINV-2026-0003',
        totalAmount: '90000.00',
        dueDate: daysAgo(75), // 61-90
        schedule: [{ receivedAmount: '20000.00', status: 'partial' }],
      }),
      makeInvoice({
        id: 4,
        invoiceNum: 'TINV-2026-0004',
        totalAmount: '15000.00',
        dueDate: daysAgo(120), // 90+
      }),
      makeInvoice({
        id: 5,
        invoiceNum: 'TINV-2026-0005',
        totalAmount: '10000.00',
        dueDate: daysAhead(15), // notYetDue
      }),
    ];
    prisma.travelInvoice.findMany.mockResolvedValue(invoices);
    prisma.travelInvoice.count.mockResolvedValue(invoices.length);

    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?asOf=2026-05-25')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
    expect(res.body.invoices).toHaveLength(5);

    // Outstanding = totalAmount - sum(schedule.receivedAmount)
    // Row 1: 30000 - 5000 = 25000
    const r1 = res.body.invoices.find((r) => r.id === 1);
    expect(r1.outstandingAmount).toBe('25000.00');
    expect(r1.bucket).toBe('0-30');
    // Row 3: 90000 - 20000 = 70000
    const r3 = res.body.invoices.find((r) => r.id === 3);
    expect(r3.outstandingAmount).toBe('70000.00');
    expect(r3.bucket).toBe('61-90');

    // Summary buckets
    expect(res.body.summary.byBucket['0-30']).toMatchObject({ count: 1, outstanding: '25000.00' });
    expect(res.body.summary.byBucket['31-60']).toMatchObject({ count: 1, outstanding: '60000.00' });
    expect(res.body.summary.byBucket['61-90']).toMatchObject({ count: 1, outstanding: '70000.00' });
    expect(res.body.summary.byBucket['90+']).toMatchObject({ count: 1, outstanding: '15000.00' });
    expect(res.body.summary.byBucket.notYetDue).toMatchObject({ count: 1, outstanding: '10000.00' });
    // Total = 25000 + 60000 + 70000 + 15000 + 10000 = 180000
    expect(res.body.summary.totalOutstanding).toBe('180000.00');
    expect(res.body.summary.currencyBreakdown.INR).toBe('180000.00');

    // findMany called with status:{in:[Issued,Partial]} and schedule include.
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(callArg.where.status).toEqual({ in: ['Issued', 'Partial'] });
    expect(callArg.where.tenantId).toBe(1);
    expect(callArg.include).toMatchObject({
      schedule: expect.objectContaining({
        select: expect.objectContaining({ receivedAmount: true }),
      }),
    });
  });

  test('bucket boundaries: 30 days past due is "0-30", 31 days is "31-60"', async () => {
    const invoices = [
      makeInvoice({ id: 1, totalAmount: '1000.00', dueDate: daysAgo(30) }), // exactly 30 → 0-30
      makeInvoice({ id: 2, totalAmount: '1000.00', dueDate: daysAgo(31) }), // 31 → 31-60
      makeInvoice({ id: 3, totalAmount: '1000.00', dueDate: daysAgo(60) }), // 60 → 31-60
      makeInvoice({ id: 4, totalAmount: '1000.00', dueDate: daysAgo(61) }), // 61 → 61-90
      makeInvoice({ id: 5, totalAmount: '1000.00', dueDate: daysAgo(90) }), // 90 → 61-90
      makeInvoice({ id: 6, totalAmount: '1000.00', dueDate: daysAgo(91) }), // 91 → 90+
    ];
    prisma.travelInvoice.findMany.mockResolvedValue(invoices);
    prisma.travelInvoice.count.mockResolvedValue(invoices.length);

    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?asOf=2026-05-25')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.invoices.find((r) => r.id === 1).bucket).toBe('0-30');
    expect(res.body.invoices.find((r) => r.id === 2).bucket).toBe('31-60');
    expect(res.body.invoices.find((r) => r.id === 3).bucket).toBe('31-60');
    expect(res.body.invoices.find((r) => r.id === 4).bucket).toBe('61-90');
    expect(res.body.invoices.find((r) => r.id === 5).bucket).toBe('61-90');
    expect(res.body.invoices.find((r) => r.id === 6).bucket).toBe('90+');
    expect(res.body.summary.byBucket['0-30'].count).toBe(1);
    expect(res.body.summary.byBucket['31-60'].count).toBe(2);
    expect(res.body.summary.byBucket['61-90'].count).toBe(2);
    expect(res.body.summary.byBucket['90+'].count).toBe(1);
  });

  test('notYetDue bucket: future dueDate AND null dueDate both route to notYetDue', async () => {
    const invoices = [
      makeInvoice({ id: 1, totalAmount: '5000.00', dueDate: daysAhead(7) }),
      makeInvoice({ id: 2, totalAmount: '3000.00', dueDate: null }),
    ];
    prisma.travelInvoice.findMany.mockResolvedValue(invoices);
    prisma.travelInvoice.count.mockResolvedValue(invoices.length);

    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?asOf=2026-05-25')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.invoices.find((r) => r.id === 1).bucket).toBe('notYetDue');
    expect(res.body.invoices.find((r) => r.id === 2).bucket).toBe('notYetDue');
    expect(res.body.summary.byBucket.notYetDue.count).toBe(2);
    expect(res.body.summary.byBucket.notYetDue.outstanding).toBe('8000.00');
  });

  test('?subBrand=tmc adds subBrand filter to where', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    prisma.travelInvoice.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?subBrand=tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(callArg.where.subBrand).toBe('tmc');
  });

  test('?contactId=999 adds contactId filter to where', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    prisma.travelInvoice.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?contactId=999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(callArg.where.contactId).toBe(999);
  });

  test('?asOf is honored for bucket assignment (snapshot use case)', async () => {
    // Two invoices, both with dueDate = 2026-01-01.
    // With asOf=2026-02-01 → ~31 days past due → 31-60.
    // With asOf=2026-04-15 → ~104 days past due → 90+.
    const inv = makeInvoice({
      id: 1,
      totalAmount: '5000.00',
      dueDate: new Date('2026-01-01'),
    });
    prisma.travelInvoice.findMany.mockResolvedValue([inv]);
    prisma.travelInvoice.count.mockResolvedValue(1);

    const res1 = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?asOf=2026-02-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res1.status).toBe(200);
    expect(res1.body.invoices[0].bucket).toBe('31-60');

    const res2 = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?asOf=2026-04-15')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res2.status).toBe(200);
    expect(res2.body.invoices[0].bucket).toBe('90+');
  });

  test('invalid ?asOf returns 400 INVALID_AS_OF', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?asOf=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AS_OF');
  });

  test('invalid ?subBrand returns 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?subBrand=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUB_BRAND');
  });

  test('invalid ?contactId returns 400 INVALID_CONTACT_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?contactId=zero')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CONTACT_ID');
  });

  test('USER role returns 403 (verifyRole gate)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    // findMany never invoked because verifyRole rejected upstream.
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand-restricted MANAGER gets where.subBrand={in:[...]} narrowing', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    prisma.travelInvoice.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    // sub-brand narrowing applied via {in:['tmc']}.
    expect(callArg.where.subBrand).toEqual({ in: ['tmc'] });
  });

  test('sub-brand-restricted MANAGER requesting disallowed sub-brand gets sentinel filter', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    prisma.travelInvoice.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?subBrand=rfu')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    // Caller can't see rfu → sentinel substitution returns empty list silently.
    expect(callArg.where.subBrand).toBe('__none__');
  });

  test('currencyBreakdown groups by invoice.currency', async () => {
    const invoices = [
      makeInvoice({ id: 1, totalAmount: '10000.00', currency: 'INR', dueDate: daysAgo(10) }),
      makeInvoice({ id: 2, totalAmount: '500.00', currency: 'USD', dueDate: daysAgo(15) }),
      makeInvoice({ id: 3, totalAmount: '5000.00', currency: 'INR', dueDate: daysAgo(20) }),
    ];
    prisma.travelInvoice.findMany.mockResolvedValue(invoices);
    prisma.travelInvoice.count.mockResolvedValue(invoices.length);

    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?asOf=2026-05-25')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.summary.currencyBreakdown).toMatchObject({
      INR: '15000.00',
      USD: '500.00',
    });
  });

  test('?limit clamped to MAX_LIMIT=500', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);
    prisma.travelInvoice.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/invoices/aged-receivable?limit=5000')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(500);
    const callArg = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(callArg.take).toBe(500);
  });
});
