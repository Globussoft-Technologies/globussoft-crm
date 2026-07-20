// @ts-check
/**
 * POST /api/travel/itineraries/public/:shareToken/create-payment-order
 * POST /api/travel/itineraries/public/:shareToken/verify-payment
 *
 * Regression coverage for a real billing-correctness bug: verify-payment used
 * to advance the itinerary to advance_paid/fully_paid (and create a Payment
 * row with status:"SUCCESS") based ONLY on `payment.amount > 0` from
 * rp.client.payments.fetch(). Razorpay's `amount` field is present on an
 * "authorized" (charge held, NOT yet settled) payment just as much as on a
 * "captured" (settled) one — so a payment that was only ever authorized (and
 * could later expire/void on Razorpay's side with the money never actually
 * collected) still passed the old check and got recorded as a successful
 * payment. Weeks later, an admin refunding that row would hit Razorpay's
 * real PAYMENT_NOT_CAPTURED rejection — correctly, because nothing was ever
 * captured — but the booking had already been marked paid in our system.
 *
 * The fix: verify-payment now requires payment.status === "captured" before
 * advancing anything, and — since payment_capture:1 wasn't previously passed
 * on order creation either — attempts an explicit payments.capture() call
 * when Razorpay hands back "authorized" instead of immediately failing the
 * customer's checkout. create-payment-order now also passes
 * payment_capture:1 explicitly so this doesn't depend on the tenant's
 * Razorpay account-level capture default.
 *
 * Mocking strategy (mirrors payments-refund.test.js): patch
 * getTenantRazorpayClient BEFORE requiring the router. These are PUBLIC
 * (unauthenticated, shareToken-based) routes — no JWT involved.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const fetchMock = vi.fn();
const captureMock = vi.fn();
const ordersCreateMock = vi.fn();
const getTenantRazorpayClientMock = vi.fn();
requireCJS('../../lib/tenantPaymentGateway').getTenantRazorpayClient = getTenantRazorpayClientMock;

prisma.itinerary = { findUnique: vi.fn(), update: vi.fn() };
prisma.itineraryItem = { findFirst: vi.fn(), findMany: vi.fn() };
prisma.payment = { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 1 }) };
prisma.tenantSetting = { findUnique: vi.fn().mockResolvedValue(null) };
prisma.travelPortalNotification = prisma.travelPortalNotification || {};
prisma.travelPortalNotification.create = vi.fn().mockResolvedValue({ id: 1 });
// Best-effort side-effects on the happy path (notify admin/customer,
// upsert a travel invoice, emit itinerary.accepted) — none are under test
// here, mocked only so they no-op quietly instead of surfacing prisma-
// surface-guard warnings for genuinely out-of-scope call sites.
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn().mockResolvedValue(null);
prisma.travelInvoice = prisma.travelInvoice || {};
prisma.travelInvoice.findFirst = vi.fn().mockResolvedValue(null);
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

const travelItinerariesRouter = requireCJS('../../routes/travel_itineraries');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/travel', travelItinerariesRouter);
  return app;
}

const SHARE_TOKEN = 'a'.repeat(32);
const KEY_SECRET = 'test_key_secret_123';

function itin(overrides = {}) {
  return {
    id: 55,
    tenantId: 1,
    subBrand: 'travelstall',
    contactId: 501,
    destination: 'Spain',
    currency: 'INR',
    status: 'accepted',
    shareToken: SHARE_TOKEN,
    totalAmount: 100000,
    advancePaidAmount: 0,
    paymentReference: null,
    ...overrides,
  };
}

function signature(orderId, paymentId) {
  return crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

beforeEach(() => {
  fetchMock.mockReset();
  captureMock.mockReset();
  ordersCreateMock.mockReset();
  getTenantRazorpayClientMock.mockReset().mockResolvedValue({
    client: { payments: { fetch: fetchMock, capture: captureMock }, orders: { create: ordersCreateMock } },
    keyId: 'rzp_test_abc',
    keySecret: KEY_SECRET,
  });
  prisma.itinerary.findUnique.mockReset();
  prisma.itinerary.update.mockReset().mockImplementation(async ({ data }) => ({ ...itin(), ...data }));
  prisma.itineraryItem.findFirst.mockReset();
  prisma.itineraryItem.findMany.mockReset().mockResolvedValue([]);
  prisma.payment.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('POST /itineraries/public/:shareToken/create-payment-order', () => {
  test('passes payment_capture:1 explicitly — does not rely on the account-level default', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(itin());
    ordersCreateMock.mockResolvedValue({ id: 'order_ABC' });

    await request(makeApp())
      .post(`/api/travel/itineraries/public/${SHARE_TOKEN}/create-payment-order`)
      .send({ kind: 'advance' });

    expect(ordersCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ payment_capture: 1 }),
    );
  });
});

describe('POST /itineraries/public/:shareToken/verify-payment', () => {
  test('captured payment → advances the itinerary and records the payment', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(itin());
    fetchMock.mockResolvedValue({ id: 'pay_1', amount: 5000000, currency: 'INR', status: 'captured' });

    const res = await request(makeApp())
      .post(`/api/travel/itineraries/public/${SHARE_TOKEN}/verify-payment`)
      .send({
        razorpay_order_id: 'order_ABC',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: signature('order_ABC', 'pay_1'),
      });

    expect(res.status).toBe(201);
    expect(captureMock).not.toHaveBeenCalled();
    expect(prisma.itinerary.update).toHaveBeenCalled();
    expect(prisma.payment.create).toHaveBeenCalled();
  });

  // The core regression test: an "authorized" (amount > 0, but NOT settled)
  // payment must NOT be recorded as a successful booking payment merely
  // because amount is present — the OLD code's exact bug.
  test('authorized-but-not-captured payment: attempts capture(); if capture succeeds, proceeds', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(itin());
    fetchMock.mockResolvedValue({ id: 'pay_2', amount: 5000000, currency: 'INR', status: 'authorized' });
    captureMock.mockResolvedValue({ id: 'pay_2', amount: 5000000, currency: 'INR', status: 'captured' });

    const res = await request(makeApp())
      .post(`/api/travel/itineraries/public/${SHARE_TOKEN}/verify-payment`)
      .send({
        razorpay_order_id: 'order_ABC',
        razorpay_payment_id: 'pay_2',
        razorpay_signature: signature('order_ABC', 'pay_2'),
      });

    expect(captureMock).toHaveBeenCalledWith('pay_2', 5000000, 'INR');
    expect(res.status).toBe(201);
    expect(prisma.itinerary.update).toHaveBeenCalled();
    expect(prisma.payment.create).toHaveBeenCalled();
  });

  test('authorized-but-not-captured payment: capture() itself fails → NOT_CAPTURED, itinerary NOT advanced', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(itin());
    fetchMock.mockResolvedValue({ id: 'pay_3', amount: 5000000, currency: 'INR', status: 'authorized' });
    captureMock.mockRejectedValue(new Error('capture failed'));

    const res = await request(makeApp())
      .post(`/api/travel/itineraries/public/${SHARE_TOKEN}/verify-payment`)
      .send({
        razorpay_order_id: 'order_ABC',
        razorpay_payment_id: 'pay_3',
        razorpay_signature: signature('order_ABC', 'pay_3'),
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_CAPTURED');
    expect(prisma.itinerary.update).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  // Regression pin for the OLD bug shape: a payment that's neither captured
  // nor capturable (e.g. failed/voided) must be rejected even though Razorpay
  // still returns a non-zero `amount` field on the fetch response.
  test('failed/voided payment with amount > 0 but status never becomes captured → NOT_CAPTURED', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(itin());
    fetchMock.mockResolvedValue({ id: 'pay_4', amount: 5000000, currency: 'INR', status: 'failed' });

    const res = await request(makeApp())
      .post(`/api/travel/itineraries/public/${SHARE_TOKEN}/verify-payment`)
      .send({
        razorpay_order_id: 'order_ABC',
        razorpay_payment_id: 'pay_4',
        razorpay_signature: signature('order_ABC', 'pay_4'),
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_CAPTURED');
    expect(captureMock).not.toHaveBeenCalled();
    expect(prisma.itinerary.update).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('bad signature is rejected before any Razorpay call', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(itin());

    const res = await request(makeApp())
      .post(`/api/travel/itineraries/public/${SHARE_TOKEN}/verify-payment`)
      .send({
        razorpay_order_id: 'order_ABC',
        razorpay_payment_id: 'pay_5',
        razorpay_signature: 'not-a-real-signature',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_SIGNATURE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('idempotent on paymentReference — already-recorded payment id short-circuits without re-fetching Razorpay', async () => {
    prisma.itinerary.findUnique.mockResolvedValue(itin({ paymentReference: 'pay_1', advancePaidAmount: 30000 }));

    const res = await request(makeApp())
      .post(`/api/travel/itineraries/public/${SHARE_TOKEN}/verify-payment`)
      .send({
        razorpay_order_id: 'order_ABC',
        razorpay_payment_id: 'pay_1',
        razorpay_signature: signature('order_ABC', 'pay_1'),
      });

    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
