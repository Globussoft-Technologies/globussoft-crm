// Unit tests for backend/lib/paymentLink.js
//
// Covers the pure gateway-selection logic + the input guards. The actual
// Stripe/Razorpay link creation is NOT exercised here (it would require live
// SDK calls — the Stripe key in .env is sk_live). The route + live tests cover
// the happy gateway path; here we pin selection + the safe early-returns.
//
// Gateway availability is env-driven and the SDK clients are cached on first
// use, so describe blocks are ORDERED: the "no gateway" block runs first
// (env cleared, nothing constructed/cached), then the "configured" block sets
// fake keys. Fake keys only construct SDK objects (no network), never charge.

import { describe, test, expect, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const prisma = requireCjs('../../lib/prisma');

// Never let a real payment row hit the DB.
prisma.payment = prisma.payment || {};
prisma.payment.create = vi.fn().mockResolvedValue({ id: 123 });

const { createInvoicePaymentLink, resolveGateway } = requireCjs('../../lib/paymentLink');

describe('paymentLink — input guards (gateway-independent)', () => {
  test('rejects an invoice with no positive amount → BAD_INVOICE', async () => {
    const r = await createInvoicePaymentLink({
      tenantId: 1, invoice: { id: 5, amount: 0 }, currency: 'INR',
    });
    expect(r.code).toBe('BAD_INVOICE');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test('rejects a missing invoice id → BAD_INVOICE', async () => {
    const r = await createInvoicePaymentLink({
      tenantId: 1, invoice: { amount: 100 }, currency: 'INR',
    });
    expect(r.code).toBe('BAD_INVOICE');
  });
});

describe('paymentLink — no gateway configured (runs first, nothing cached)', () => {
  beforeAll(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  test('resolveGateway defaults to razorpay for INR / explicit razorpay even when tenant BYOK is unconfigured', () => {
    expect(resolveGateway('auto', 'INR')).toBe('razorpay');
    expect(resolveGateway('razorpay', 'INR')).toBe('razorpay');
    // No Stripe env key is set, so a non-INR explicit preference falls through
    // to the final razorpay default rather than returning null.
    expect(resolveGateway('stripe', 'USD')).toBe('razorpay');
  });

  test('createInvoicePaymentLink short-circuits to NO_GATEWAY when tenant BYOK is missing (no DB write, no API call)', async () => {
    prisma.paymentGatewayConfig = prisma.paymentGatewayConfig || {};
    prisma.paymentGatewayConfig.findFirst = vi.fn().mockResolvedValue(null);
    const r = await createInvoicePaymentLink({
      tenantId: 1, invoice: { id: 5, invoiceNum: 'INV-1', amount: 100 }, currency: 'INR',
    });
    expect(r.code).toBe('NO_GATEWAY');
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});

describe('paymentLink — both gateways configured (fake keys, no network)', () => {
  beforeAll(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_unit';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
    process.env.RAZORPAY_KEY_SECRET = 'fake_secret';
  });

  test('auto + INR currency → razorpay (INR-native)', () => {
    expect(resolveGateway('auto', 'INR')).toBe('razorpay');
  });

  test('auto + non-INR currency → stripe', () => {
    expect(resolveGateway('auto', 'USD')).toBe('stripe');
  });

  test('explicit preference is honoured when that gateway is configured', () => {
    expect(resolveGateway('stripe', 'INR')).toBe('stripe');
    expect(resolveGateway('razorpay', 'USD')).toBe('razorpay');
  });
});
