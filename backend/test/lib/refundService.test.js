// @ts-check
/**
 * refundService — shared gateway-refund logic used by the Payments admin
 * override AND the itinerary cancellation flow.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const refundMock = vi.fn();
const getClientMock = vi.fn();
requireCJS('../../lib/tenantPaymentGateway').getTenantRazorpayClient = getClientMock;
const eventBus = requireCJS('../../lib/eventBus');
eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);

prisma.payment = { update: vi.fn() };
prisma.invoice = { update: vi.fn().mockResolvedValue({}) };
prisma.travelQuote = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
prisma.travelPaymentSchedule = { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() };
prisma.travelInvoice = { update: vi.fn() };
prisma.auditLog = { ...(prisma.auditLog || {}), create: vi.fn().mockResolvedValue({ id: 1 }), findFirst: vi.fn().mockResolvedValue(null) };

const svc = requireCJS('../../lib/refundService');

function pay(over = {}) {
  return { id: 5, tenantId: 1, invoiceId: 993, amount: 499, gateway: 'razorpay', gatewayId: 'pay_ABC', status: 'SUCCESS', metadata: null, ...over };
}

beforeEach(() => {
  refundMock.mockReset().mockResolvedValue({ id: 'rfnd_1', status: 'processed', amount: 49900 });
  getClientMock.mockReset().mockResolvedValue({ client: { payments: { refund: refundMock } } });
  prisma.payment.update.mockReset().mockImplementation(async ({ data }) => ({ ...pay(), ...data }));
  prisma.invoice.update.mockReset().mockResolvedValue({});
});

describe('isRefundable', () => {
  test('true only for captured razorpay (pay_) success rows', () => {
    expect(svc.isRefundable(pay())).toBe(true);
    expect(svc.isRefundable(pay({ status: 'PENDING' }))).toBe(false);
    expect(svc.isRefundable(pay({ gateway: 'cash' }))).toBe(false);
    expect(svc.isRefundable(pay({ gatewayId: 'UTR-1' }))).toBe(false);
    expect(svc.isRefundable(null)).toBe(false);
  });
});

describe('isTravelBookingPayment', () => {
  test('detects travel booking metadata shapes', () => {
    expect(svc.isTravelBookingPayment({ type: 'travel-quote-advance' })).toBe(true);
    expect(svc.isTravelBookingPayment({ type: 'travel-payment-schedule' })).toBe(true);
    expect(svc.isTravelBookingPayment({ kind: 'travel-milestone' })).toBe(true);
    expect(svc.isTravelBookingPayment({ kind: 'travel-invoice' })).toBe(true);
    expect(svc.isTravelBookingPayment({ mode: 'payment_link' })).toBe(false);
    expect(svc.isTravelBookingPayment(null)).toBe(false);
  });
});

describe('refundCapturedPayment', () => {
  test('happy path: issues partial refund, marks REFUNDED, returns refund', async () => {
    const r = await svc.refundCapturedPayment({ payment: pay(), amount: 200, reason: 'x', userId: 7 });
    expect(r.ok).toBe(true);
    expect(r.payment.status).toBe('REFUNDED');
    expect(refundMock).toHaveBeenCalledWith('pay_ABC', expect.objectContaining({ amount: 20000 }));
    expect(prisma.invoice.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 993 }, data: { status: 'REFUNDED' } }));
  });

  test('rejects amount above the captured amount', async () => {
    const r = await svc.refundCapturedPayment({ payment: pay(), amount: 9999 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_AMOUNT');
    expect(refundMock).not.toHaveBeenCalled();
  });

  test('already-refunded / not-success / manual guards', async () => {
    expect((await svc.refundCapturedPayment({ payment: pay({ status: 'REFUNDED' }) })).code).toBe('ALREADY_REFUNDED');
    expect((await svc.refundCapturedPayment({ payment: pay({ status: 'PENDING' }) })).code).toBe('NOT_REFUNDABLE');
    expect((await svc.refundCapturedPayment({ payment: pay({ gateway: 'cash', gatewayId: null }) })).code).toBe('MANUAL_PAYMENT');
    expect((await svc.refundCapturedPayment({ payment: pay({ gatewayId: 'UTR-1' }) })).code).toBe('NO_GATEWAY_REFERENCE');
  });

  test('no gateway configured → NO_GATEWAY', async () => {
    getClientMock.mockResolvedValue(null);
    const r = await svc.refundCapturedPayment({ payment: pay() });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_GATEWAY');
  });

  test('gateway throw → REFUND_FAILED (502), payment not mutated', async () => {
    refundMock.mockRejectedValue(new Error('razorpay down'));
    const r = await svc.refundCapturedPayment({ payment: pay() });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REFUND_FAILED');
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });
});
