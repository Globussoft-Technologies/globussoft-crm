// @ts-check
/**
 * Arc 2 #901 slice 21 — TDS withholding sum on POST /api/travel/invoices/:id/issue.
 *
 * PRD_TRAVEL_BILLING §3 — When a Travel invoice is issued, the response
 * envelope must surface `totalTds` (sum of amounts on lineType==='tds'
 * lines) and `payableAfterTds = totalAmount - totalTds`. Slice 5 shipped
 * the bare /issue handler; slice 17 added the auto-PaymentSchedule;
 * slice 21 ships the TDS envelope additively (top-level invoice fields
 * remain spread for back-compat with slice-5/17 callers).
 *
 * Test pattern mirrors backend/test/routes/travel-invoice-issue-autoschedule.test.js
 * (slice 17) — patch the prisma singleton before requiring the router,
 * drive supertest with real HS256 JWTs.
 *
 * Contracts asserted:
 *   1. No TDS lines → totalTds=0, payableAfterTds=totalAmount, perLineTds=[].
 *   2. Single TDS line → totalTds=line.amount, payableAfterTds reduced
 *      accordingly, perLineTds carries the line id.
 *   3. Multiple TDS lines → summed; non-tds lines (per_pax, tax, fee)
 *      excluded; perLineTds preserves the input order.
 *   4. Envelope shape — body has top-level invoice fields (status,
 *      invoiceNum) AND envelope fields (invoice, paymentSchedule,
 *      totalTds, perLineTds, payableAfterTds).
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
  create: vi.fn(),
  createMany: vi.fn().mockResolvedValue({ count: 3 }),
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

function draftInvoice(overrides = {}) {
  return {
    id: 500,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    invoiceNum: 'TINV-2026-0001',
    status: 'Draft',
    totalAmount: '120000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 14 * 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.update.mockReset();
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.travelPaymentSchedule.findMany.mockReset().mockResolvedValue([]);
  prisma.travelPaymentSchedule.findFirst.mockReset();
  prisma.travelPaymentSchedule.createMany.mockReset().mockResolvedValue({ count: 3 });
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

async function issueWithLines({
  invoiceId = 500,
  totalAmount = '120000.00',
  lines = [],
  schedule = [],
} = {}) {
  const invoice = draftInvoice({ id: invoiceId, totalAmount });
  prisma.travelInvoice.findFirst
    .mockResolvedValueOnce(invoice)
    .mockResolvedValueOnce(null); // FY counter scan
  prisma.travelInvoice.update.mockImplementation(async ({ data }) => ({
    ...invoice,
    ...data,
  }));
  // Auto-schedule side effect mocks (slice 17 path).
  prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(null);
  // The envelope-fetch findMany is called AFTER update + auto-create.
  prisma.travelInvoiceLine.findMany.mockResolvedValue(lines);
  prisma.travelPaymentSchedule.findMany.mockResolvedValue(schedule);

  return request(makeApp())
    .post(`/api/travel/invoices/${invoiceId}/issue`)
    .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
}

describe('POST /api/travel/invoices/:id/issue — TDS withholding envelope (slice 21)', () => {
  test('no TDS lines → totalTds=0, payableAfterTds=totalAmount, perLineTds=[]', async () => {
    const res = await issueWithLines({
      invoiceId: 501,
      totalAmount: '50000.00',
      lines: [
        { id: 1, lineType: 'per_pax', amount: '40000.00' },
        { id: 2, lineType: 'tax', amount: '7200.00' },
        { id: 3, lineType: 'fee', amount: '2800.00' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.totalTds).toBe(0);
    expect(res.body.payableAfterTds).toBe(50000);
    expect(res.body.perLineTds).toEqual([]);
  });

  test('single TDS line → totalTds reflects line amount; payableAfterTds reduced', async () => {
    const res = await issueWithLines({
      invoiceId: 502,
      totalAmount: '120000.00',
      lines: [
        { id: 10, lineType: 'per_pax', amount: '100000.00' },
        { id: 11, lineType: 'tax', amount: '18000.00' },
        { id: 12, lineType: 'tds', amount: '1200.00' }, // 1% TDS hypothetical
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.totalTds).toBe(1200);
    expect(res.body.payableAfterTds).toBe(118800); // 120000 - 1200
    expect(res.body.perLineTds).toEqual([{ lineId: 12, amount: 1200 }]);
  });

  test('multiple TDS lines summed; non-tds lines excluded; order preserved', async () => {
    const res = await issueWithLines({
      invoiceId: 503,
      totalAmount: '250000.00',
      lines: [
        { id: 20, lineType: 'tds', amount: '500.00' },
        { id: 21, lineType: 'per_pax', amount: '200000.00' },
        { id: 22, lineType: 'tax', amount: '36000.00' },
        { id: 23, lineType: 'tds', amount: '750.50' },
        { id: 24, lineType: 'addon', amount: '12749.50' },
        { id: 25, lineType: 'tds', amount: '249.50' },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.totalTds).toBe(1500); // 500 + 750.50 + 249.50
    expect(res.body.payableAfterTds).toBe(248500); // 250000 - 1500
    expect(res.body.perLineTds.map((p) => p.lineId)).toEqual([20, 23, 25]);
  });

  test('envelope shape — top-level invoice fields + envelope keys both present', async () => {
    const res = await issueWithLines({
      invoiceId: 504,
      totalAmount: '120000.00',
      lines: [{ id: 30, lineType: 'tds', amount: '600.00' }],
    });

    expect(res.status).toBe(200);
    // Top-level back-compat (slice 5 + slice 17 callers):
    expect(res.body.status).toBe('Issued');
    expect(res.body.invoiceNum).toBeTruthy();
    // Envelope additive fields (slice 21):
    expect(res.body.invoice).toBeTruthy();
    expect(res.body.invoice.status).toBe('Issued');
    expect(Array.isArray(res.body.paymentSchedule)).toBe(true);
    expect(typeof res.body.totalTds).toBe('number');
    expect(typeof res.body.payableAfterTds).toBe('number');
    expect(Array.isArray(res.body.perLineTds)).toBe(true);
  });

  test('paymentSchedule envelope reflects findMany return (smoke — slice 17 coexists)', async () => {
    const fakeSchedule = [
      { id: 100, milestoneOrder: 1, status: 'pending', expectedAmount: '30000.00' },
      { id: 101, milestoneOrder: 2, status: 'pending', expectedAmount: '60000.00' },
      { id: 102, milestoneOrder: 3, status: 'pending', expectedAmount: '30000.00' },
    ];
    const res = await issueWithLines({
      invoiceId: 505,
      totalAmount: '120000.00',
      lines: [],
      schedule: fakeSchedule,
    });

    expect(res.status).toBe(200);
    expect(res.body.paymentSchedule).toHaveLength(3);
    expect(res.body.paymentSchedule.map((s) => s.milestoneOrder)).toEqual([1, 2, 3]);
  });
});
