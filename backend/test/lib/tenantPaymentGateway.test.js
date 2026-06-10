// Unit tests for backend/lib/tenantPaymentGateway.js (#848 minimal slice).
//
// What this module does:
//   Loads a tenant's OWN Razorpay merchant keys (BYOK) from the
//   PaymentGatewayConfig table so customer payments settle into the tenant's
//   account — NOT the platform env keys (those are subscription-only).
//     - getTenantRazorpayCreds(tenantId)  → { keyId, keySecret, webhookSecret }
//                                            or null
//     - getTenantRazorpayClient(tenantId) → { client, ...creds } or null
//
// Surface covered:
//   - module shape + NOT_CONFIGURED_MESSAGE constant
//   - getTenantRazorpayCreds
//       - falsy tenantId → null without touching prisma
//       - no row → null
//       - inactive row → null
//       - active row missing keyId → null (half-configured can't take money)
//       - active row missing keySecret → null
//       - active + complete → decrypted creds (webhookSecret optional)
//   - getTenantRazorpayClient
//       - not configured → null
//       - configured → { client, keyId, keySecret } with a usable SDK client
//
// Pattern source: test/lib/eventBus.test.js — vitest inlines backend/lib/, so
// assigning a mock delegate on the imported prisma singleton propagates to the
// SUT. credentialMasking.decryptCredential is left REAL: with WELLNESS_FIELD_KEY
// unset it is a no-op that returns plaintext, so plaintext fixtures round-trip.
//
// stripDangerous reminder (per CLAUDE.md): not relevant — lib module, no
// Express req/res/body touched.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import gw from '../../lib/tenantPaymentGateway.js';

const {
  PROVIDER,
  NOT_CONFIGURED_MESSAGE,
  getTenantRazorpayCreds,
  getTenantRazorpayClient,
} = gw;

beforeEach(() => {
  // Brand-new delegate — assign the whole object so the test never depends on
  // a freshly-generated Prisma client carrying the paymentGatewayConfig model.
  prisma.paymentGatewayConfig = { findFirst: vi.fn() };
});

describe('module shape', () => {
  test('exports the expected helpers + constants', () => {
    expect(PROVIDER).toBe('razorpay');
    expect(typeof NOT_CONFIGURED_MESSAGE).toBe('string');
    expect(NOT_CONFIGURED_MESSAGE.length).toBeGreaterThan(0);
    expect(typeof getTenantRazorpayCreds).toBe('function');
    expect(typeof getTenantRazorpayClient).toBe('function');
  });
});

describe('getTenantRazorpayCreds', () => {
  test('falsy tenantId → null and never queries prisma', async () => {
    const out = await getTenantRazorpayCreds(0);
    expect(out).toBeNull();
    expect(prisma.paymentGatewayConfig.findFirst).not.toHaveBeenCalled();
  });

  test('no config row → null', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValueOnce(null);
    expect(await getTenantRazorpayCreds(5)).toBeNull();
  });

  test('queries scoped to (tenantId, provider=razorpay)', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValueOnce(null);
    await getTenantRazorpayCreds(7);
    expect(prisma.paymentGatewayConfig.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 7, provider: 'razorpay' },
    });
  });

  test('inactive row → null (disabled gateway never charges)', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValueOnce({
      keyId: 'rzp_live_abc',
      keySecret: 'secret123',
      webhookSecret: 'wh123',
      isActive: false,
    });
    expect(await getTenantRazorpayCreds(5)).toBeNull();
  });

  test('active row missing keyId → null (half-configured)', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValueOnce({
      keyId: null,
      keySecret: 'secret123',
      isActive: true,
    });
    expect(await getTenantRazorpayCreds(5)).toBeNull();
  });

  test('active row missing keySecret → null', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValueOnce({
      keyId: 'rzp_live_abc',
      keySecret: null,
      isActive: true,
    });
    expect(await getTenantRazorpayCreds(5)).toBeNull();
  });

  test('active + complete → decrypted creds (keyId + keySecret only)', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValueOnce({
      keyId: 'rzp_live_abc',
      keySecret: 'secret123',
      isActive: true,
    });
    const out = await getTenantRazorpayCreds(5);
    // Only the two values present in .env are returned — no webhook secret.
    expect(out).toEqual({ keyId: 'rzp_live_abc', keySecret: 'secret123' });
  });

  test('does not return a webhookSecret (none is collected)', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValueOnce({
      keyId: 'rzp_live_abc',
      keySecret: 'secret123',
      // A lingering column value must NOT surface in the creds.
      webhookSecret: 'legacy_value',
      isActive: true,
    });
    const out = await getTenantRazorpayCreds(5);
    expect(out).not.toHaveProperty('webhookSecret');
  });
});

describe('getTenantRazorpayClient', () => {
  test('not configured → null', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValueOnce(null);
    expect(await getTenantRazorpayClient(5)).toBeNull();
  });

  test('configured → returns { client, keyId, keySecret }', async () => {
    prisma.paymentGatewayConfig.findFirst.mockResolvedValueOnce({
      keyId: 'rzp_test_abc',
      keySecret: 'secret123',
      webhookSecret: 'wh',
      isActive: true,
    });
    const out = await getTenantRazorpayClient(5);
    expect(out).toBeTruthy();
    expect(out.keyId).toBe('rzp_test_abc');
    expect(out.keySecret).toBe('secret123');
    // The SDK client is constructed (no network call at construction time).
    expect(out.client).toBeTruthy();
    expect(out.client.orders).toBeDefined();
  });
});
