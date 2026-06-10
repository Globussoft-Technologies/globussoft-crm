// Unit tests for lib/webhookEntitlement.js — the subscription-entitlement +
// per-tenant signing-secret resolver shared by routes/developer.js and
// lib/webhookDelivery.js.
//
// Mocking strategy: monkey-patch the prisma singleton (vi.mock doesn't
// intercept the SUT's CJS require('./prisma') in this vitest setup), same as
// webhookDelivery.test.js. The SUT also requires('./fieldEncryption'); we let
// the real decrypt() run — it's a no-op for plaintext (no ENC:v1: prefix) and
// when WELLNESS_FIELD_KEY is unset, so a plaintext stored secret round-trips
// unchanged.
import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import ent from '../../lib/webhookEntitlement.js';

const { isTenantWebhookEntitled, resolveTenantWebhookSecret } = ent;

beforeAll(() => {
  prisma.subscription = { findFirst: vi.fn() };
  prisma.user = { findFirst: vi.fn() };
  prisma.webhookCredential = { findFirst: vi.fn() };
});

beforeEach(() => {
  prisma.subscription.findFirst.mockReset();
  prisma.user.findFirst.mockReset();
  prisma.webhookCredential.findFirst.mockReset();
  delete process.env.WEBHOOK_HMAC_SECRET;
});

afterEach(() => {
  delete process.env.WEBHOOK_HMAC_SECRET;
  vi.restoreAllMocks();
});

describe('isTenantWebhookEntitled', () => {
  test('entitled via an active paid subscription', async () => {
    prisma.subscription.findFirst.mockResolvedValue({ id: 1 });
    const r = await isTenantWebhookEntitled(9);
    expect(r).toEqual({ entitled: true, reason: 'active_subscription' });
    // Short-circuits: trial lookup not needed.
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  test('entitled via an active trial when no paid subscription', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue({ id: 7 });
    const r = await isTenantWebhookEntitled(9);
    expect(r).toEqual({ entitled: true, reason: 'active_trial' });
  });

  test('NOT entitled when neither active subscription nor active trial', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    const r = await isTenantWebhookEntitled(9);
    expect(r).toEqual({ entitled: false, reason: 'no_active_subscription' });
  });

  test('subscription query uses a live [startDate, endDate) window', async () => {
    prisma.subscription.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    await isTenantWebhookEntitled(9);
    const where = prisma.subscription.findFirst.mock.calls[0][0].where;
    expect(where.tenantId).toBe(9);
    expect(where.status).toBe('ACTIVE');
    expect(where.startDate).toHaveProperty('lte'); // started
    // endDate is open-ended (null) OR strictly in the future.
    expect(where.OR).toEqual([{ endDate: null }, { endDate: { gt: expect.any(Date) } }]);
  });

  test('falsy tenantId is not entitled (defensive, no DB call)', async () => {
    const r = await isTenantWebhookEntitled(0);
    expect(r).toEqual({ entitled: false, reason: 'no_active_subscription' });
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
  });
});

describe('resolveTenantWebhookSecret', () => {
  test("returns the tenant's ACTIVE WebhookCredential secret (source=credential)", async () => {
    prisma.webhookCredential.findFirst.mockResolvedValue({ secret: 'tenant-raw-secret' });
    const r = await resolveTenantWebhookSecret(9);
    expect(r).toEqual({ secret: 'tenant-raw-secret', source: 'credential' });
    // Only ACTIVE credentials are matched.
    expect(prisma.webhookCredential.findFirst.mock.calls[0][0].where).toEqual({ tenantId: 9, status: 'ACTIVE' });
  });

  test('falls back to env secret when no credential (source=env)', async () => {
    prisma.webhookCredential.findFirst.mockResolvedValue(null);
    process.env.WEBHOOK_HMAC_SECRET = 'env-global-secret';
    const r = await resolveTenantWebhookSecret(9);
    expect(r).toEqual({ secret: 'env-global-secret', source: 'env' });
  });

  test('returns null secret when neither credential nor env (source=none)', async () => {
    prisma.webhookCredential.findFirst.mockResolvedValue(null);
    const r = await resolveTenantWebhookSecret(9);
    expect(r).toEqual({ secret: null, source: 'none' });
  });

  test('credential secret wins over env secret', async () => {
    prisma.webhookCredential.findFirst.mockResolvedValue({ secret: 'cred-wins' });
    process.env.WEBHOOK_HMAC_SECRET = 'env-loses';
    const r = await resolveTenantWebhookSecret(9);
    expect(r.secret).toBe('cred-wins');
    expect(r.source).toBe('credential');
  });

  test('a plaintext (non-ENC) stored secret round-trips unchanged through decrypt', async () => {
    // decrypt() is a no-op for values without the ENC:v1: prefix, so a secret
    // stored while WELLNESS_FIELD_KEY was unset resolves to itself. (Real
    // AES round-tripping is covered by fieldEncryption's own unit tests.)
    prisma.webhookCredential.findFirst.mockResolvedValue({ secret: '9f64d2aa-plaintext' });
    const r = await resolveTenantWebhookSecret(9);
    expect(r.secret).toBe('9f64d2aa-plaintext');
    expect(r.source).toBe('credential');
  });
});
