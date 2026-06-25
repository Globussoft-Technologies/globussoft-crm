// @ts-check
/**
 * POST /api/payments/:id/refund — real gateway refund via the tenant's BYOK
 * Razorpay keys. Issues the refund, flips the Payment to REFUNDED, reverses the
 * linked record, audits.
 *
 * Pins:
 *   - Happy path: razorpay SUCCESS payment with a pay_… id → calls
 *     client.payments.refund(pay_…, { amount }) and returns REFUNDED + refund.
 *   - 409 ALREADY_REFUNDED / 400 NOT_REFUNDABLE (pending) guards.
 *   - 422 NO_GATEWAY_REFERENCE when the row has no pay_… id (manual/uncaptured).
 *   - 422 MANUAL_PAYMENT for a non-gateway (cash/upi) row.
 *   - Generic invoice reversal: the linked Invoice flips to REFUNDED.
 *
 * Patches the gateway client + eventBus before requiring the router (the router
 * destructures getTenantRazorpayClient + require()s eventBus inline).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Patch the BYOK gateway client + eventBus BEFORE the router requires them.
const refundMock = vi.fn();
const getTenantRazorpayClientMock = vi.fn();
requireCJS('../../lib/tenantPaymentGateway').getTenantRazorpayClient = getTenantRazorpayClientMock;
const eventBus = requireCJS('../../lib/eventBus');
eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);

prisma.payment = { findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn(), create: vi.fn() };
prisma.invoice = { findFirst: vi.fn(), update: vi.fn() };
prisma.travelPaymentSchedule = { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() };
prisma.travelInvoice = { update: vi.fn() };
prisma.travelQuote = { updateMany: vi.fn() };
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ id: 1, vertical: 'travel', name: 'Travel Stall' });
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN' });
prisma.auditLog = { ...(prisma.auditLog || {}), create: vi.fn().mockResolvedValue({ id: 1 }), findFirst: vi.fn().mockResolvedValue(null) };
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const paymentsRouter = requireCJS('../../routes/payments');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Mimic the global auth guard: attach req.user from the bearer token.
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (tok) { try { req.user = jwt.verify(tok, JWT_SECRET); } catch { /* leave unset */ } }
    next();
  });
  app.use('/api/payments', paymentsRouter);
  return app;
}
function token(role = 'ADMIN') {
  return jwt.sign({ userId: 7, tenantId: 1, role, email: 'a@test.local' }, JWT_SECRET, { expiresIn: '1h' });
}

function razorpayPayment(over = {}) {
  return { id: 5, tenantId: 1, invoiceId: 993, amount: 499, currency: 'INR', gateway: 'razorpay', gatewayId: 'pay_ABC123', status: 'SUCCESS', metadata: null, ...over };
}

beforeEach(() => {
  refundMock.mockReset().mockResolvedValue({ id: 'rfnd_XYZ', status: 'processed', amount: 49900 });
  getTenantRazorpayClientMock.mockReset().mockResolvedValue({ client: { payments: { refund: refundMock } } });
  prisma.payment.findFirst.mockReset();
  prisma.payment.update.mockReset().mockImplementation(async ({ data }) => ({ ...razorpayPayment(), ...data }));
  prisma.invoice.update.mockReset().mockResolvedValue({ id: 993, status: 'REFUNDED' });
});

describe('POST /api/payments/:id/refund', () => {
  test('happy path: razorpay SUCCESS → issues refund, marks REFUNDED, reverses invoice', async () => {
    prisma.payment.findFirst.mockResolvedValue(razorpayPayment());

    const res = await request(makeApp())
      .post('/api/payments/5/refund')
      .set('Authorization', `Bearer ${token('ADMIN')}`)
      .send({ reason: 'customer cancelled' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REFUNDED');
    expect(res.body.refund).toMatchObject({ id: 'rfnd_XYZ', status: 'processed' });
    // Real gateway call with the pay_ id + paise amount.
    expect(refundMock).toHaveBeenCalledWith('pay_ABC123', expect.objectContaining({ amount: 49900 }));
    // Linked generic invoice flipped to REFUNDED.
    expect(prisma.invoice.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 993 }, data: { status: 'REFUNDED' } }));
  });

  test('409 when already refunded', async () => {
    prisma.payment.findFirst.mockResolvedValue(razorpayPayment({ status: 'REFUNDED' }));
    const res = await request(makeApp()).post('/api/payments/5/refund').set('Authorization', `Bearer ${token('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_REFUNDED');
    expect(refundMock).not.toHaveBeenCalled();
  });

  test('400 when payment is not SUCCESS (pending)', async () => {
    prisma.payment.findFirst.mockResolvedValue(razorpayPayment({ status: 'PENDING' }));
    const res = await request(makeApp()).post('/api/payments/5/refund').set('Authorization', `Bearer ${token('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_REFUNDABLE');
  });

  test('422 when no Razorpay pay_ id (manual/uncaptured)', async () => {
    prisma.payment.findFirst.mockResolvedValue(razorpayPayment({ gatewayId: 'UTR-12345' }));
    const res = await request(makeApp()).post('/api/payments/5/refund').set('Authorization', `Bearer ${token('ADMIN')}`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NO_GATEWAY_REFERENCE');
  });

  test('422 for a manual (non-gateway) payment', async () => {
    prisma.payment.findFirst.mockResolvedValue(razorpayPayment({ gateway: 'cash', gatewayId: null }));
    const res = await request(makeApp()).post('/api/payments/5/refund').set('Authorization', `Bearer ${token('ADMIN')}`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MANUAL_PAYMENT');
  });

  test('404 when payment not found', async () => {
    prisma.payment.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).post('/api/payments/9/refund').set('Authorization', `Bearer ${token('ADMIN')}`);
    expect(res.status).toBe(404);
  });
});

describe('travel booking payment — cancellation-flow-first gating', () => {
  const bookingPayment = (over = {}) =>
    razorpayPayment({ invoiceId: null, metadata: JSON.stringify({ type: 'travel-quote-advance', quoteId: 1 }), ...over });

  beforeEach(() => {
    prisma.travelQuote.updateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  test('MANAGER cannot raw-refund a booking payment → 403 USE_CANCELLATION_FLOW', async () => {
    prisma.payment.findFirst.mockResolvedValue(bookingPayment());
    const res = await request(makeApp())
      .post('/api/payments/5/refund')
      .set('Authorization', `Bearer ${token('MANAGER')}`)
      .send({ reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('USE_CANCELLATION_FLOW');
    expect(refundMock).not.toHaveBeenCalled();
  });

  test('ADMIN override on a booking payment requires a reason → 400 REASON_REQUIRED', async () => {
    prisma.payment.findFirst.mockResolvedValue(bookingPayment());
    const res = await request(makeApp())
      .post('/api/payments/5/refund')
      .set('Authorization', `Bearer ${token('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REASON_REQUIRED');
  });

  test('ADMIN override with a reason succeeds', async () => {
    prisma.payment.findFirst.mockResolvedValue(bookingPayment());
    const res = await request(makeApp())
      .post('/api/payments/5/refund')
      .set('Authorization', `Bearer ${token('ADMIN')}`)
      .send({ reason: 'goodwill exception' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REFUNDED');
    expect(refundMock).toHaveBeenCalled();
    // The linked quote was rolled back.
    expect(prisma.travelQuote.updateMany).toHaveBeenCalled();
  });
});
