// @ts-check
/**
 * Unit tests for backend/routes/billing.js — pin the generic-CRM billing
 * (Invoice CRUD + status transitions + payment + void/refund/credit-note)
 * contract against accidental regression.
 *
 * Why this file exists
 * ────────────────────
 * billing.js is a 1033-LOC route surface that backs the Invoices page +
 * the deal-money flow. Several issues have closed inside it:
 *   - #158 / #177 / #198 — POST validation (amount > 0, amount ≤ 1e10,
 *     ≤2-decimal precision, dueDate required + not past, contactId required).
 *   - #196              — GET /:id must guard against `parseInt('foo') ⇒ NaN`
 *     (return 400 INVALID_ID instead of leaking a 500).
 *   - #202              — PATCH /:id is whitelist-based; PAID/VOIDED/REFUNDED/
 *     CREDIT_NOTE are terminal (422 INVALID_INVOICE_TRANSITION); `amount` is
 *     immutable via PATCH (400 AMOUNT_IMMUTABLE — money moves go through
 *     /refund or /credit-note so the audit row captures *why*).
 *   - #202              — POST /:id/mark-paid is idempotent: re-marking PAID
 *     returns 200 { idempotent:true }; VOIDED/REFUNDED/CREDIT_NOTE return 422.
 *   - #193              — /:id/refund only flips PAID → REFUNDED (400
 *     INVOICE_NOT_PAID otherwise); /:id/credit-note creates a NEW invoice
 *     row with negative amount + parentInvoiceId link, 400 if requested
 *     amount > original.
 *   - #122 reopen       — DELETE was a hard-delete; it's now an alias for
 *     /void (same handler) — the row + audit trail are preserved.
 *
 * What this file pins
 * ───────────────────
 *   1. POST /         — happy path, all six validation paths above.
 *   2. GET /:id       — happy path, INVALID_ID guard, 404 on missing/cross-tenant.
 *   3. PATCH /:id     — terminal-status guard, amount-immutable guard.
 *   4. POST /:id/mark-paid — happy path (UNPAID → PAID), idempotency on PAID,
 *      422 on VOIDED.
 *   5. POST /:id/refund  — PAID → REFUNDED happy, 400 INVOICE_NOT_PAID on UNPAID.
 *   6. POST /:id/credit-note — happy (creates negative-amount row), 400 on
 *      AMOUNT_EXCEEDS_ORIGINAL, 400 on INVOICE_VOIDED.
 *
 * Pattern reference: accounting.test.js (auth-middleware bypass + prisma
 * singleton-monkey-patch). The route's CJS `require('../middleware/auth')`
 * + destructured `verifyToken` / `verifyRole` is replaced at module-load
 * with pass-through fns so we exercise the route logic without minting JWTs.
 * `req.user` is injected by the test's express middleware.
 *
 * What this file does NOT cover (intentional, out of scope for ≥12 cases):
 *   - GET /:id/pdf       — PDFKit binary; covered by pdf-rendering specs.
 *   - PUT /:id/recurring — separate recurring-template flow; deep-dive belongs
 *                          in its own test file alongside the recurring engine.
 *   - POST /recurring/run — G-9 cron-engine manual trigger; covered by
 *                           backend/test/cron/recurringInvoiceEngine.test.js.
 *   - /export/tally.xml + /export/ca-summary.csv — covered by buildTallyXml
 *     + buildCaCsv helper tests.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Patch the auth middleware BEFORE the billing router is required — the
// router does `const { verifyToken, verifyRole } = require(...)` at module-load,
// so the destructured reference captures whatever `authMw.{verifyToken,verifyRole}`
// points at THE MOMENT the route is required. Pass-through both so the
// route's handlers see whatever req.user we inject downstream.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

// Patch eventBus.emitEvent BEFORE the router is required so emit attempts
// from inside the route don't hit the real DB-backed workflow path. The
// route already wraps every emit in try/catch, but stubbing keeps the test
// output clean.
const eventBus = requireCJS('../../lib/eventBus');
eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);

// Prisma singleton patching — replace the lazy delegates with bare vi.fn()
// surfaces. The route touches invoice, payment, tenant, auditLog, and
// (transitively, via filterReadFields/filterWriteFields) fieldPermission.
prisma.invoice = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.payment = {
  create: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  findMany: vi.fn(),
  aggregate: vi.fn(),
};
prisma.paymentGatewayConfig = {
  findFirst: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.auditLog = {
  findFirst: vi.fn(),
  create: vi.fn(),
};
// fieldFilter helpers query this — return empty perms so they no-op.
prisma.fieldPermission = {
  findMany: vi.fn().mockResolvedValue([]),
};
// TMC instalment reconciliation path — stubs so the tmc-instalment
// confirm-payment block doesn't throw when kind='tmc-instalment' is set.
prisma.tripInstalmentPayment = prisma.tripInstalmentPayment || {};
prisma.tripInstalmentPayment.findFirst = vi.fn().mockResolvedValue(null);
prisma.tripInstalmentPayment.update = vi.fn().mockResolvedValue({});
prisma.tripParticipant = prisma.tripParticipant || {};
prisma.tripParticipant.findFirst = vi.fn().mockResolvedValue(null);
prisma.itinerary = prisma.itinerary || {};
prisma.itinerary.findFirst = vi.fn().mockResolvedValue(null);
prisma.itinerary.update = vi.fn().mockResolvedValue({});
prisma.tripInstalmentPayment.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
const billingRouter = requireCJS('../../routes/billing');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/billing', billingRouter);
  return app;
}

beforeEach(() => {
  prisma.invoice.findMany.mockReset();
  prisma.invoice.findFirst.mockReset();
  prisma.invoice.create.mockReset();
  prisma.invoice.update.mockReset();
  prisma.payment.create.mockReset();
  prisma.payment.findFirst.mockReset();
  prisma.payment.update.mockReset();
  prisma.payment.findMany.mockReset();
  prisma.payment.aggregate.mockReset();
  prisma.paymentGatewayConfig.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.auditLog.findFirst.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.fieldPermission.findMany.mockReset();
  prisma.fieldPermission.findMany.mockResolvedValue([]);
  prisma.tripInstalmentPayment.findFirst.mockReset().mockResolvedValue(null);
  prisma.tripInstalmentPayment.findMany.mockReset().mockResolvedValue([]);
  prisma.tripInstalmentPayment.update.mockReset().mockResolvedValue({});
  prisma.tripParticipant.findFirst.mockReset().mockResolvedValue(null);
  prisma.itinerary.findFirst.mockReset().mockResolvedValue(null);
  prisma.itinerary.update.mockReset().mockResolvedValue({});
  // Sensible defaults — happy-path resolves.
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.payment.create.mockResolvedValue({ id: 555, amount: 0, currency: 'USD' });
  prisma.paymentGatewayConfig.findFirst.mockResolvedValue(null);
  eventBus.emitEvent.mockClear();
});

describe('POST /api/billing/public/confirm-payment - payment-link statuses', () => {
  test('Razorpay partially_paid callback is reconciled as a successful payment', async () => {
    const payment = {
      id: 901,
      tenantId: 1,
      invoiceId: null,
      gateway: 'razorpay',
      gatewayId: 'plink_partial_123',
      status: 'PENDING',
      amount: 5000,
      currency: 'INR',
      metadata: JSON.stringify({ mode: 'payment_link', plinkId: 'plink_partial_123' }),
    };
    prisma.payment.findFirst
      .mockResolvedValueOnce(payment)
      .mockResolvedValueOnce({
        amount: 5000,
        currency: 'INR',
        metadata: payment.metadata,
      });
    prisma.payment.update.mockResolvedValue({ ...payment, status: 'SUCCESS' });

    const app = makeApp();
    const res = await request(app)
      .post('/api/billing/public/confirm-payment')
      .send({
        razorpay_payment_link_id: 'plink_partial_123',
        razorpay_payment_link_reference_id: 'quote-10',
        razorpay_payment_link_status: 'partially_paid',
        razorpay_payment_id: 'pay_partial_123',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      plinkId: 'plink_partial_123',
      amountPaid: 5000,
      currency: 'INR',
    });
    expect(prisma.payment.update).toHaveBeenCalledWith({
      where: { id: 901 },
      data: expect.objectContaining({
        status: 'SUCCESS',
        metadata: expect.stringContaining('"razorpayPaymentId":"pay_partial_123"'),
      }),
    });
  });

  test('non-complete Razorpay payment-link status is still rejected', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/billing/public/confirm-payment')
      .send({
        razorpay_payment_link_id: 'plink_partial_123',
        razorpay_payment_link_status: 'created',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Payment not completed');
    expect(prisma.payment.findFirst).not.toHaveBeenCalled();
  });
});

// ─── POST / — Invoice creation (validation contract) ───────────────

describe('POST /api/billing — create invoice (#158 #177 #198)', () => {
  test('happy path: amount + dueDate + contactId → 201 with created row', async () => {
    const futureDate = new Date(Date.now() + 7 * 86400000).toISOString();
    prisma.invoice.create.mockResolvedValue({
      id: 1001,
      invoiceNum: 'INV-ABC123',
      amount: 250,
      dueDate: new Date(futureDate),
      contactId: 42,
      tenantId: 1,
      status: 'UNPAID',
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/billing')
      .send({ amount: 250, dueDate: futureDate, contactId: 42 });
    expect(res.status).toBe(201);
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.invoice.create.mock.calls[0][0];
    expect(createArgs.data.amount).toBe(250);
    expect(createArgs.data.contactId).toBe(42);
    expect(createArgs.data.tenantId).toBe(1);
    expect(createArgs.data.invoiceNum).toMatch(/^INV-/);
  });

  test('amount ≤ 0 → 400 INVALID_AMOUNT', async () => {
    const app = makeApp();
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const res = await request(app)
      .post('/api/billing')
      .send({ amount: 0, dueDate: futureDate, contactId: 42 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  test('amount > 1e10 → 400 AMOUNT_TOO_HIGH', async () => {
    const app = makeApp();
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const res = await request(app)
      .post('/api/billing')
      .send({ amount: 1e11, dueDate: futureDate, contactId: 42 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMOUNT_TOO_HIGH');
  });

  test('sub-paise precision → 400 INVALID_AMOUNT_PRECISION (#198)', async () => {
    const app = makeApp();
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const res = await request(app)
      .post('/api/billing')
      .send({ amount: 123.456789, dueDate: futureDate, contactId: 42 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT_PRECISION');
  });

  test('dueDate missing → 400 INVALID_DUE_DATE', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/billing')
      .send({ amount: 100, contactId: 42 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DUE_DATE');
  });

  test('dueDate in the past → 400 DUE_DATE_IN_PAST', async () => {
    const app = makeApp();
    const pastDate = new Date(Date.now() - 7 * 86400000).toISOString();
    const res = await request(app)
      .post('/api/billing')
      .send({ amount: 100, dueDate: pastDate, contactId: 42 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DUE_DATE_IN_PAST');
  });

  test('contactId missing → 400 CONTACT_REQUIRED', async () => {
    const app = makeApp();
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const res = await request(app)
      .post('/api/billing')
      .send({ amount: 100, dueDate: futureDate });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONTACT_REQUIRED');
  });
});

// ─── GET /:id — fetch single invoice (#196) ────────────────────────

describe('GET /api/billing/:id — fetch one (#196)', () => {
  test('happy path: returns invoice scoped to tenant', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 7,
      invoiceNum: 'INV-X',
      amount: 100,
      status: 'UNPAID',
      tenantId: 1,
      contact: { id: 42, name: 'Acme' },
      deal: null,
    });
    const app = makeApp();
    const res = await request(app).get('/api/billing/7');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    const findArgs = prisma.invoice.findFirst.mock.calls[0][0];
    expect(findArgs.where).toEqual({ id: 7, tenantId: 1 });
  });

  test('non-numeric id → 400 INVALID_ID (parseInt-NaN guard, #196)', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/billing/not-a-number');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    // Crucially, the parseInt-NaN guard must short-circuit BEFORE Prisma.
    expect(prisma.invoice.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant fetch → 404 (findFirst returns null because tenant filter does not match)', async () => {
    prisma.invoice.findFirst.mockResolvedValue(null);
    const app = makeApp({ tenantId: 99 });
    const res = await request(app).get('/api/billing/7');
    expect(res.status).toBe(404);
    const findArgs = prisma.invoice.findFirst.mock.calls[0][0];
    // Tenant-isolation: the where clause MUST include the caller's tenantId.
    expect(findArgs.where.tenantId).toBe(99);
  });
});

// ─── PATCH /:id — terminal-status + amount-immutable guards (#202) ─

describe('PATCH /api/billing/:id — terminal & amount-immutable guards (#202)', () => {
  test('PAID invoice → 422 INVALID_INVOICE_TRANSITION', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 7, status: 'PAID', tenantId: 1 });
    const app = makeApp();
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const res = await request(app)
      .patch('/api/billing/7')
      .send({ dueDate: futureDate });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_INVOICE_TRANSITION');
    expect(res.body.currentStatus).toBe('PAID');
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  test('amount in body → 400 AMOUNT_IMMUTABLE (money moves go via refund/credit-note)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 7, status: 'UNPAID', tenantId: 1 });
    const app = makeApp();
    const res = await request(app)
      .patch('/api/billing/7')
      .send({ amount: 999 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMOUNT_IMMUTABLE');
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });
});

// ─── POST /:id/mark-paid — idempotency contract (#202) ─────────────

describe('POST /api/billing/:id/mark-paid — UNPAID → PAID + idempotency (#202)', () => {
  test('UNPAID → PAID: flips status, writes Payment row, emits invoice.paid', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 7, invoiceNum: 'INV-X', amount: 100, status: 'UNPAID', tenantId: 1, contactId: 42, dealId: null,
    });
    prisma.invoice.update.mockResolvedValue({
      id: 7, invoiceNum: 'INV-X', amount: 100, status: 'PAID', tenantId: 1,
      contactId: 42, dealId: null, paidAt: new Date(),
    });
    prisma.payment.create.mockResolvedValue({ id: 99, amount: 100, currency: 'USD' });
    const app = makeApp();
    const res = await request(app)
      .post('/api/billing/7/mark-paid')
      .send({ paymentMethod: 'razorpay', transactionRef: 'rzp_abc123' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PAID');
    expect(res.body.payment).toBeTruthy();
    const updateArgs = prisma.invoice.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('PAID');
    expect(updateArgs.data.paidAt).toBeInstanceOf(Date);
    // invoice.paid emitted (downstream automations subscribe).
    const eventNames = eventBus.emitEvent.mock.calls.map(([name]) => name);
    expect(eventNames).toContain('invoice.paid');
  });

  test('already-PAID invoice → 200 { idempotent: true } (#202 contract)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 7, invoiceNum: 'INV-X', amount: 100, status: 'PAID', tenantId: 1,
    });
    const app = makeApp();
    const res = await request(app).post('/api/billing/7/mark-paid').send({});
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    // Crucially, no Prisma update fires — the status was already PAID.
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  test('VOIDED invoice → 422 INVALID_INVOICE_TRANSITION', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 7, invoiceNum: 'INV-X', amount: 100, status: 'VOIDED', tenantId: 1,
    });
    const app = makeApp();
    const res = await request(app).post('/api/billing/7/mark-paid').send({});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_INVOICE_TRANSITION');
    expect(res.body.currentStatus).toBe('VOIDED');
  });
});

// ─── POST /:id/refund — PAID-only guard (#193) ─────────────────────

describe('POST /api/billing/:id/refund — PAID → REFUNDED (#193)', () => {
  test('PAID → REFUNDED: flips status + audit + invoice.refunded event', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 7, invoiceNum: 'INV-X', amount: 100, status: 'PAID', tenantId: 1,
      contactId: 42, dealId: null,
    });
    prisma.invoice.update.mockResolvedValue({
      id: 7, invoiceNum: 'INV-X', amount: 100, status: 'REFUNDED', tenantId: 1,
      contactId: 42, dealId: null,
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/billing/7/refund')
      .send({ reason: 'customer dissatisfied' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REFUNDED');
    const updateArgs = prisma.invoice.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('REFUNDED');
    const eventNames = eventBus.emitEvent.mock.calls.map(([name]) => name);
    expect(eventNames).toContain('invoice.refunded');
  });

  test('non-PAID invoice → 400 INVOICE_NOT_PAID', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 7, invoiceNum: 'INV-X', amount: 100, status: 'UNPAID', tenantId: 1,
    });
    const app = makeApp();
    const res = await request(app).post('/api/billing/7/refund').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVOICE_NOT_PAID');
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });
});

// ─── POST /:id/credit-note — GST-compliant negative-amount row (#193) ─

describe('POST /api/billing/:id/credit-note — issue credit note (#193)', () => {
  test('happy path: creates negative-amount Invoice row with parentInvoiceId link', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 7, invoiceNum: 'INV-X', amount: 100, status: 'PAID', tenantId: 1,
      contactId: 42, dealId: null, dueDate: new Date('2026-12-31'),
    });
    prisma.invoice.create.mockResolvedValue({
      id: 8, invoiceNum: 'CN-XYZ123', amount: -50, parentInvoiceId: 7,
      status: 'CREDIT_NOTE', tenantId: 1, contactId: 42, dealId: null,
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/billing/7/credit-note')
      .send({ amount: 50, reason: 'partial refund' });
    expect(res.status).toBe(201);
    expect(res.body.creditNote.amount).toBe(-50);
    expect(res.body.creditNote.parentInvoiceId).toBe(7);
    expect(res.body.creditNote.status).toBe('CREDIT_NOTE');
    expect(res.body.originalInvoiceId).toBe(7);
    const createArgs = prisma.invoice.create.mock.calls[0][0];
    expect(createArgs.data.amount).toBe(-50);
    expect(createArgs.data.parentInvoiceId).toBe(7);
    expect(createArgs.data.invoiceNum).toMatch(/^CN-/);
  });

  test('amount > original → 400 AMOUNT_EXCEEDS_ORIGINAL', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 7, invoiceNum: 'INV-X', amount: 100, status: 'PAID', tenantId: 1,
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/billing/7/credit-note')
      .send({ amount: 200 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMOUNT_EXCEEDS_ORIGINAL');
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  test('VOIDED original → 400 INVOICE_VOIDED (cannot CN against a voided row)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      id: 7, invoiceNum: 'INV-X', amount: 100, status: 'VOIDED', tenantId: 1,
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/billing/7/credit-note')
      .send({ amount: 50 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVOICE_VOIDED');
  });
});

// ─── GET / — ?fields=summary slim-shape opt-in (#920 slice 31) ─────

describe('GET /api/billing?fields=summary — slim-shape opt-in (#920 slice 31)', () => {
  test('?fields=summary → Prisma called with `select` (no nested includes)', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { id: 1, invoiceNum: 'INV-A', amount: 100, status: 'UNPAID', dueDate: new Date(), issuedDate: new Date(), contactId: 42, dealId: null },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/billing?fields=summary');
    expect(res.status).toBe(200);
    const args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args.select).toBeDefined();
    expect(args.include).toBeUndefined();
    // Slim shape must NOT pull contact / deal — the entire point of the opt-in.
    expect(args.select.id).toBe(true);
    expect(args.select.invoiceNum).toBe(true);
    expect(args.select.amount).toBe(true);
    expect(args.select.status).toBe(true);
    expect(args.select.dueDate).toBe(true);
    expect(args.select.issuedDate).toBe(true);
    expect(args.select.contactId).toBe(true);
    expect(args.select.dealId).toBe(true);
    // Heavy / unused columns must NOT be in the slim projection.
    expect(args.select.contact).toBeUndefined();
    expect(args.select.deal).toBeUndefined();
    expect(args.select.tenantId).toBeUndefined();
    expect(args.select.createdAt).toBeUndefined();
    expect(args.select.updatedAt).toBeUndefined();
    expect(args.select.isRecurring).toBeUndefined();
    expect(args.select.recurFrequency).toBeUndefined();
    expect(args.select.nextRecurDate).toBeUndefined();
    expect(args.select.parentInvoiceId).toBeUndefined();
    expect(args.select.legalEntityCode).toBeUndefined();
    expect(args.select.paidAt).toBeUndefined();
    expect(args.select.visitId).toBeUndefined();
  });

  test('no ?fields param → default include path preserved (back-compat)', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app).get('/api/billing');
    expect(res.status).toBe(200);
    const args = prisma.invoice.findMany.mock.calls[0][0];
    // Default callers MUST still get the full nested shape — this is the
    // safety net on additive-opt-in. If this assertion ever flips, every
    // existing frontend that destructures `inv.contact.name` breaks.
    expect(args.include).toEqual({ contact: true, deal: true });
    expect(args.select).toBeUndefined();
  });

  test('?fields=other (non-exact value) → default include path (strict exact-match)', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    const app = makeApp();
    // Anything other than literal "summary" must fall through to the
    // default include path. Prevents typos / partial matches from
    // accidentally tripping the slim shape.
    const res = await request(app).get('/api/billing?fields=summari');
    expect(res.status).toBe(200);
    const args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args.include).toEqual({ contact: true, deal: true });
    expect(args.select).toBeUndefined();
  });

  test('?fields=summary preserves tenant scoping + status/dueDate ordering', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    const app = makeApp({ tenantId: 42 });
    const res = await request(app).get('/api/billing?fields=summary');
    expect(res.status).toBe(200);
    const args = prisma.invoice.findMany.mock.calls[0][0];
    // Tenant scoping must survive the slim-shape branch — otherwise the
    // opt-in becomes a cross-tenant leak vector.
    expect(args.where).toEqual({ tenantId: 42 });
    // Ordering contract preserved so the Invoices/Billing page still
    // renders status-grouped, due-date-sorted rows under the slim shape.
    expect(args.orderBy).toEqual([{ status: 'desc' }, { dueDate: 'asc' }]);
  });

  test('?fields=summary response body shape — slim row passes through unchanged', async () => {
    // The slim row Prisma returns under `select` has no `contact`/`deal`
    // properties at all — the route must NOT re-fabricate them. This is
    // a pin against a regression where someone later "helpfully" patches
    // missing keys back in after the fieldFilter pass.
    const slimRow = {
      id: 1,
      invoiceNum: 'INV-A',
      amount: 100,
      status: 'UNPAID',
      dueDate: new Date('2026-12-31'),
      issuedDate: new Date('2026-01-01'),
      contactId: 42,
      dealId: null,
    };
    prisma.invoice.findMany.mockResolvedValue([slimRow]);
    const app = makeApp();
    const res = await request(app).get('/api/billing?fields=summary');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(1);
    expect(res.body[0].invoiceNum).toBe('INV-A');
    expect(res.body[0].contactId).toBe(42);
    // contact / deal should NOT have been hydrated by the route.
    expect(res.body[0].contact).toBeUndefined();
    expect(res.body[0].deal).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/billing/public/confirm-payment — tmc-instalment reconciliation
// Pins the new kind='tmc-instalment' branch that prevents confirm-payment from
// accidentally treating an instalment payment as a TravelInvoice payment.
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/billing/public/confirm-payment — tmc-instalment reconciliation', () => {
  function makeTmcPayment(overrides = {}) {
    return {
      id: 902,
      tenantId: 1,
      invoiceId: null,
      gateway: 'razorpay',
      gatewayId: 'plink_tmc_cb',
      status: 'PENDING',
      amount: 50000,
      currency: 'INR',
      metadata: JSON.stringify({
        mode: 'payment_link',
        plinkId: 'plink_tmc_cb',
        kind: 'tmc-instalment',
        instalmentId: '200',
        url: 'https://rzp.io/rzp/CBTEST',
        ...overrides,
      }),
      ...overrides,
    };
  }

  test('tmc-instalment confirm-payment marks instalment paid and updates itinerary', async () => {
    const payment = makeTmcPayment();
    prisma.payment.findFirst
      .mockResolvedValueOnce(payment)       // first call: find pending payment by plinkId
      .mockResolvedValueOnce({              // second call: reload after update
        ...payment,
        status: 'SUCCESS',
        metadata: payment.metadata,
      });
    prisma.payment.update.mockResolvedValue({ ...payment, status: 'SUCCESS' });

    prisma.tripInstalmentPayment.findFirst.mockResolvedValue({
      id: 200, participantId: 5, status: 'pending', amount: 50000,
    });
    prisma.tripInstalmentPayment.update.mockResolvedValue({ id: 200, status: 'paid', paidAmount: 50000 });
    prisma.tripInstalmentPayment.findMany.mockResolvedValue([{ paidAmount: 50000, amount: 50000 }]);
    prisma.tripParticipant.findFirst.mockResolvedValue({ parentEmail: 'parent@test.com' });
    prisma.itinerary.findFirst.mockResolvedValue({ id: 77, advancePaidAmount: 0, status: 'sent' });
    prisma.itinerary.update.mockResolvedValue({ id: 77, status: 'advance_paid', advancePaidAmount: 50000 });

    const app = makeApp();
    const res = await request(app)
      .post('/api/billing/public/confirm-payment')
      .send({
        razorpay_payment_link_id: 'plink_tmc_cb',
        razorpay_payment_link_reference_id: 'tmc-ref-1',
        razorpay_payment_link_status: 'paid',
        razorpay_payment_id: 'pay_tmc_cb',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    // Instalment must be updated
    expect(prisma.tripInstalmentPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 200 },
        data: expect.objectContaining({ status: expect.stringMatching(/^(paid|partial)$/) }),
      }),
    );
    // Itinerary must be updated to reflect payment
    expect(prisma.itinerary.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 77 },
        data: expect.objectContaining({ status: 'advance_paid' }),
      }),
    );
  });

  test('tmc-instalment confirm-payment does NOT reconcile TravelInvoice (kind guard)', async () => {
    // The old bug: billing.js's travelInvoiceId branch would fire even when
    // kind='tmc-instalment', treating the instalment's invoiceId as a TravelInvoice id.
    // After the fix, kind='tmc-instalment' skips the TravelInvoice branch entirely.
    const payment = makeTmcPayment({ travelInvoiceId: '55' }); // old metadata had this
    prisma.payment.findFirst
      .mockResolvedValueOnce(payment)
      .mockResolvedValueOnce({ ...payment, status: 'SUCCESS', metadata: payment.metadata });
    prisma.payment.update.mockResolvedValue({ ...payment, status: 'SUCCESS' });

    const app = makeApp();
    const res = await request(app)
      .post('/api/billing/public/confirm-payment')
      .send({
        razorpay_payment_link_id: 'plink_tmc_cb',
        razorpay_payment_link_reference_id: 'tmc-ref-2',
        razorpay_payment_link_status: 'paid',
        razorpay_payment_id: 'pay_tmc_cb_2',
      });

    expect(res.status).toBe(200);
    // TravelInvoice model must NOT be touched — it's not stubbed, so if the
    // route calls it the test would throw, which would cause the test to fail.
    // The absence of a throw is the assertion.
  });
});
