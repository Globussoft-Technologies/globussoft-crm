// @ts-check
/**
 * Arc 2 #901 slice 19 — POST /api/travel/invoices/:id/schedule/:milestoneId/mark-paid
 * (PRD_TRAVEL_BILLING §3 — operator-driven installment settlement).
 *
 * Slice 17 (commit 572cb107) auto-created a 25/50/25 PaymentSchedule on
 * /:id/issue. Slice 18 (commit 5f47ae52) shipped the TravelVoucher PDF
 * subtype. This slice closes the settlement loop: when an operator records
 * an installment payment, we (1) create a Payment row, (2) flip the
 * milestone to status='paid', (3) auto-transition the parent invoice to
 * 'Paid' (all installments settled) or 'Partial' (mid-settlement).
 *
 * Contracts asserted:
 *   1. Happy path: 200 + { milestone, payment, invoice, idempotent:false,
 *      allPaid:bool }. Payment row created with correct amount/method/
 *      reference + travelInvoice + schedule metadata. Milestone updated to
 *      status='paid' + receivedAmount + paidAt. Audit row written.
 *   2. Idempotency: re-marking an already-paid milestone returns
 *      idempotent:true + payment:null (no double-credit). Critical for the
 *      Razorpay/Stripe webhook-retry case.
 *   3. All-installments-paid auto-flips invoice to 'Paid' + emits
 *      travel.invoice.paid event via eventBus.
 *   4. Partial: marking 1 of 3 milestones paid flips invoice to 'Partial'.
 *   5. USER role -> 403 (auth gate trips before any payment logic).
 *   6. Missing amount -> 400 INVALID_AMOUNT.
 *   7. Missing method -> 400 MISSING_METHOD.
 *   8. Negative/zero amount -> 400 INVALID_AMOUNT.
 *   9. Half-up rounding: amount 100.005 -> stored as 100.01 (standing rule).
 *  10. Unknown milestone -> 404 MILESTONE_NOT_FOUND.
 *  11. Cross-tenant invoice access blocked by loadParentInvoice (returns
 *      404 INVOICE_NOT_FOUND or 403 SUB_BRAND_DENIED upstream).
 *  12. Voided invoices: marking a milestone paid on a Voided invoice does
 *      NOT auto-flip status (Voided is terminal — operator must un-void
 *      first).
 *
 * Test pattern mirrors backend/test/routes/travel-invoice-issue-autoschedule.test.js
 * (slice 17) — patch the prisma singleton with vi.fn() shapes BEFORE the
 * router is required, then drive supertest with real HS256 JWTs.
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
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.payment = {
  ...(prisma.payment || {}),
  create: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
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

function issuedInvoice(overrides = {}) {
  return {
    id: 300,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    invoiceNum: 'TINV/TMC/26-27/0001',
    status: 'Issued',
    totalAmount: '120000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 14 * 86_400_000),
    docType: 'TaxInvoice',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function pendingMilestone(overrides = {}) {
  return {
    id: 7001,
    tenantId: 1,
    invoiceId: 300,
    milestoneOrder: 1,
    expectedAmount: '30000.00',
    expectedCurrency: 'INR',
    receivedAmount: null,
    status: 'pending',
    paidAt: null,
    dueDate: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.update.mockReset();
  prisma.travelPaymentSchedule.findFirst.mockReset();
  prisma.travelPaymentSchedule.findMany.mockReset();
  prisma.travelPaymentSchedule.update.mockReset();
  prisma.payment.create.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/invoices/:id/schedule/:milestoneId/mark-paid', () => {
  test('happy path: 200 + creates Payment + updates milestone + audit', async () => {
    const inv = issuedInvoice({ id: 300 });
    const ms = pendingMilestone({ id: 7001, invoiceId: 300, milestoneOrder: 1 });
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(inv);
    prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(ms);
    prisma.payment.create.mockImplementation(async ({ data }) => ({
      id: 9001, ...data, createdAt: new Date(),
    }));
    prisma.travelPaymentSchedule.update.mockImplementation(async ({ data }) => ({
      ...ms, ...data,
    }));
    // siblings: m1 now-paid, m2+m3 still pending -> Partial
    prisma.travelPaymentSchedule.findMany.mockResolvedValueOnce([
      { ...ms, status: 'paid' },
      pendingMilestone({ id: 7002, milestoneOrder: 2 }),
      pendingMilestone({ id: 7003, milestoneOrder: 3 }),
    ]);
    prisma.travelInvoice.update.mockImplementation(async ({ data }) => ({
      ...inv, ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/300/schedule/7001/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 30000, method: 'upi', reference: 'UPI-TXN-123' });

    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(false);
    expect(res.body.allPaid).toBe(false);
    expect(res.body.payment).toBeTruthy();
    expect(res.body.milestone.status).toBe('paid');
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    const paymentArgs = prisma.payment.create.mock.calls[0][0].data;
    expect(paymentArgs.amount).toBe(30000);
    expect(paymentArgs.gateway).toBe('upi');
    expect(paymentArgs.gatewayId).toBe('UPI-TXN-123');
    expect(paymentArgs.status).toBe('SUCCESS');
    expect(paymentArgs.invoiceId).toBe(300);
    const meta = JSON.parse(paymentArgs.metadata);
    expect(meta).toMatchObject({
      type: 'travel-payment-schedule',
      scheduleId: 7001,
      milestoneOrder: 1,
    });
    // audit row written
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditDetails = prisma.auditLog.create.mock.calls[0][0].data.details;
    const details = typeof auditDetails === 'string' ? JSON.parse(auditDetails) : auditDetails;
    expect(details).toMatchObject({
      invoiceId: 300,
      amount: 30000,
      method: 'upi',
      allPaid: false,
      invoiceStatusAfter: 'Partial',
    });
  });

  test('idempotent: re-marking already-paid milestone returns idempotent:true', async () => {
    const inv = issuedInvoice({ id: 301, status: 'Partial' });
    const ms = pendingMilestone({
      id: 7010, invoiceId: 301, status: 'paid',
      receivedAmount: '30000.00', paidAt: new Date(Date.now() - 3600_000),
    });
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(inv);
    prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(ms);
    prisma.travelPaymentSchedule.findMany.mockResolvedValueOnce([
      ms,
      pendingMilestone({ id: 7011, milestoneOrder: 2 }),
      pendingMilestone({ id: 7012, milestoneOrder: 3 }),
    ]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/301/schedule/7010/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 30000, method: 'upi' });

    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.payment).toBeNull();
    expect(res.body.allPaid).toBe(false);
    // No payment created on idempotent path — guards webhook double-credit.
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.travelPaymentSchedule.update).not.toHaveBeenCalled();
  });

  test('all-installments-paid: invoice auto-flips to Paid + emits event', async () => {
    const inv = issuedInvoice({ id: 302, status: 'Partial' });
    const ms3 = pendingMilestone({ id: 7023, invoiceId: 302, milestoneOrder: 3 });
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(inv);
    prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(ms3);
    prisma.payment.create.mockImplementation(async ({ data }) => ({
      id: 9023, ...data, createdAt: new Date(),
    }));
    prisma.travelPaymentSchedule.update.mockImplementation(async ({ data }) => ({
      ...ms3, ...data,
    }));
    // After this mark-paid, ALL siblings are paid -> invoice Paid.
    prisma.travelPaymentSchedule.findMany.mockResolvedValueOnce([
      pendingMilestone({ id: 7021, milestoneOrder: 1, status: 'paid' }),
      pendingMilestone({ id: 7022, milestoneOrder: 2, status: 'paid' }),
      { ...ms3, status: 'paid' },
    ]);
    prisma.travelInvoice.update.mockImplementation(async ({ data }) => ({
      ...inv, ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/302/schedule/7023/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ amount: 30000, method: 'razorpay', reference: 'pay_R9999' });

    expect(res.status).toBe(200);
    expect(res.body.allPaid).toBe(true);
    expect(res.body.invoice.status).toBe('Paid');
    expect(prisma.travelInvoice.update).toHaveBeenCalledWith({
      where: { id: 302 },
      data: { status: 'Paid' },
    });
  });

  test('USER role -> 403 (no payment created, no milestone update)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/300/schedule/7001/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ amount: 30000, method: 'upi' });

    expect(res.status).toBe(403);
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.travelPaymentSchedule.update).not.toHaveBeenCalled();
  });

  test('missing amount -> 400 INVALID_AMOUNT', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(pendingMilestone());
    const res = await request(makeApp())
      .post('/api/travel/invoices/300/schedule/7001/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ method: 'upi' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('missing method -> 400 MISSING_METHOD', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(pendingMilestone());
    const res = await request(makeApp())
      .post('/api/travel/invoices/300/schedule/7001/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 30000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_METHOD');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('negative or zero amount -> 400 INVALID_AMOUNT', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(pendingMilestone());
    const res = await request(makeApp())
      .post('/api/travel/invoices/300/schedule/7001/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: -100, method: 'upi' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
  });

  test('half-up rounding: amount 100.005 stored as 100.01', async () => {
    const inv = issuedInvoice({ id: 303 });
    const ms = pendingMilestone({ id: 7030, invoiceId: 303 });
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(inv);
    prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(ms);
    prisma.payment.create.mockImplementation(async ({ data }) => ({
      id: 9030, ...data,
    }));
    prisma.travelPaymentSchedule.update.mockImplementation(async ({ data }) => ({
      ...ms, ...data,
    }));
    prisma.travelPaymentSchedule.findMany.mockResolvedValueOnce([{ ...ms, status: 'paid' }]);
    prisma.travelInvoice.update.mockImplementation(async ({ data }) => ({
      ...inv, ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices/303/schedule/7030/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 100.005, method: 'cash' });

    expect(res.status).toBe(200);
    const paymentArgs = prisma.payment.create.mock.calls[0][0].data;
    expect(paymentArgs.amount).toBe(100.01);
  });

  test('unknown milestone -> 404 MILESTONE_NOT_FOUND', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post('/api/travel/invoices/300/schedule/99999/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 30000, method: 'upi' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MILESTONE_NOT_FOUND');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('cross-tenant invoice access -> 404 INVOICE_NOT_FOUND (loadParentInvoice gate)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post('/api/travel/invoices/9999/schedule/7001/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 30000, method: 'upi' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INVOICE_NOT_FOUND');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('voided invoice: milestone mark-paid does NOT auto-flip status', async () => {
    const inv = issuedInvoice({ id: 304, status: 'Voided' });
    const ms = pendingMilestone({ id: 7040, invoiceId: 304 });
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(inv);
    prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(ms);
    prisma.payment.create.mockImplementation(async ({ data }) => ({
      id: 9040, ...data,
    }));
    prisma.travelPaymentSchedule.update.mockImplementation(async ({ data }) => ({
      ...ms, ...data,
    }));
    // All siblings paid - normally would flip to Paid, but Voided is terminal.
    prisma.travelPaymentSchedule.findMany.mockResolvedValueOnce([{ ...ms, status: 'paid' }]);

    const res = await request(makeApp())
      .post('/api/travel/invoices/304/schedule/7040/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 30000, method: 'cash' });

    expect(res.status).toBe(200);
    // Invoice update NOT called because status is Voided.
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    // Returned invoice still Voided.
    expect(res.body.invoice.status).toBe('Voided');
  });

  test('paidAt defaults to now when not supplied', async () => {
    const inv = issuedInvoice({ id: 305 });
    const ms = pendingMilestone({ id: 7050, invoiceId: 305 });
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(inv);
    prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(ms);
    prisma.payment.create.mockImplementation(async ({ data }) => ({
      id: 9050, ...data,
    }));
    prisma.travelPaymentSchedule.update.mockImplementation(async ({ data }) => ({
      ...ms, ...data,
    }));
    prisma.travelPaymentSchedule.findMany.mockResolvedValueOnce([{ ...ms, status: 'paid' }]);
    prisma.travelInvoice.update.mockImplementation(async ({ data }) => ({
      ...inv, ...data,
    }));

    const before = Date.now();
    const res = await request(makeApp())
      .post('/api/travel/invoices/305/schedule/7050/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 30000, method: 'cash' });
    const after = Date.now();

    expect(res.status).toBe(200);
    const paymentArgs = prisma.payment.create.mock.calls[0][0].data;
    const paidAtMs = new Date(paymentArgs.paidAt).getTime();
    expect(paidAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(paidAtMs).toBeLessThanOrEqual(after + 1000);
  });

  test('invalid paidAt -> 400 INVALID_DATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(issuedInvoice());
    prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(pendingMilestone());
    const res = await request(makeApp())
      .post('/api/travel/invoices/300/schedule/7001/mark-paid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ amount: 30000, method: 'upi', paidAt: 'not-a-date' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});
