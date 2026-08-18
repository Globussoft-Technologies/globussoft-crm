// Unit tests for backend/lib/whatsappTenantConnect.js
//
// What this module does:
//   Manual per-tenant WhatsApp Cloud API connect — the credential-paste
//   counterpart to lib/whatsappOnboardingService.js (Embedded Signup, which
//   stays gated behind WHATSAPP_EMBEDDED_SIGNUP_ENABLED until Meta App Review
//   clears). A tenant admin supplies their OWN phoneNumberId / WABA id /
//   system-user token; we probe Graph with those credentials and only persist +
//   activate on success.
//
// Surface area covered (18 cases):
//   - validateAndConnect happy path (4): probes Graph with the tenant's token,
//                       encrypts before persisting, activates + stamps
//                       onboardedAt, stands down sibling providers
//   - required fields (3): missing phoneNumberId / businessAccountId /
//                       accessToken → MISSING_FIELDS with the field list
//   - Meta rejection (4): code 190 → INVALID_ACCESS_TOKEN, other number error
//                       → INVALID_PHONE_NUMBER_ID, WABA read failure →
//                       INVALID_BUSINESS_ACCOUNT_ID, number not on the WABA →
//                       PHONE_NUMBER_WABA_MISMATCH
//   - client isolation (2): another tenant already owns the phoneNumberId →
//                       PHONE_NUMBER_CLAIMED and NO write; a failed probe
//                       deactivates instead of leaving a stale active row
//   - secret handling (2): masked sentinel echo reuses the stored token
//                       (no re-encrypt); plaintext never appears in the result
//   - disconnect (2):   soft-disconnects (isActive false + disconnectedAt) and
//                       keeps credentials; missing config → NOT_CONFIGURED
//   - getConnectionState (1): masked shape + the callback URL we generate
//
// The contract these pin is the security boundary: a tenant's credentials are
// validated with Meta before activation, are never returned in plaintext, and
// can never be attached to a phone number another tenant already claims.

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Mocks ─────────────────────────────────────────────────────────────
//
// Monkey-patch the CJS singletons post-load rather than vi.mock — the SUT does
// property lookup at call time, so post-load patching is visible and we dodge
// vi.mock's CJS interop quirks. Same pattern as
// test/lib/whatsappOnboardingService.test.js.
//
// Encryption is deliberately NOT mocked: encryptCredential/decryptCredential
// run for real so the credential round-trip assertions mean something. Note
// they are pass-through when no field-encryption key is configured (CI), which
// is why the storage assertion below pins the DECRYPT round-trip rather than
// "the string looks like ciphertext".
prisma.whatsAppConfig.findUnique = vi.fn();
prisma.whatsAppConfig.findFirst = vi.fn();
prisma.whatsAppConfig.upsert = vi.fn();
prisma.whatsAppConfig.update = vi.fn();
prisma.whatsAppConfig.updateMany = vi.fn();

const providerMock = require('../../services/whatsappProvider');
providerMock.graphRequest = vi.fn();
providerMock.listPhoneNumbers = vi.fn();
providerMock.subscribeApp = vi.fn();
providerMock.unsubscribeApp = vi.fn();
providerMock.debugToken = vi.fn();

const audit = require('../../lib/audit');
audit.writeAudit = vi.fn().mockResolvedValue({});

const {
  validateAndConnect,
  disconnect,
  getConnectionState,
  META_CLOUD_PROVIDER,
} = require('../../lib/whatsappTenantConnect');
const { encryptCredential, decryptCredential } = require('../../lib/credentialMasking');

const prismaMock = prisma;

const GOOD_INPUT = {
  tenantId: 7,
  userId: 3,
  phoneNumberId: 'PNID_777',
  businessAccountId: 'WABA_777',
  accessToken: 'EAAG-tenant-7-system-user-token',
};

/** Graph responses for a fully valid credential set. */
function stubHappyGraph() {
  providerMock.graphRequest.mockResolvedValue({
    ok: true,
    data: {
      id: 'PNID_777',
      display_phone_number: '+91 98765 43210',
      verified_name: 'Tenant Seven Travel',
      quality_rating: 'GREEN',
    },
  });
  providerMock.listPhoneNumbers.mockResolvedValue({
    ok: true,
    data: { data: [{ id: 'PNID_777', display_phone_number: '+91 98765 43210' }] },
  });
  providerMock.subscribeApp.mockResolvedValue({ ok: true, data: { success: true } });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.whatsAppConfig.findUnique.mockResolvedValue(null);
  prismaMock.whatsAppConfig.findFirst.mockResolvedValue(null);
  prismaMock.whatsAppConfig.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.whatsAppConfig.upsert.mockImplementation(async ({ create }) => ({
    id: 42,
    provider: META_CLOUD_PROVIDER,
    tenantId: 7,
    isActive: true,
    disconnectedAt: null,
    onboardedAt: new Date('2026-08-17T00:00:00Z'),
    tokenExpiresAt: null,
    qualityRating: 'GREEN',
    webhookVerified: true,
    ...create,
  }));
  // debugToken only fires when META_APP_ID/SECRET are set; default them off so
  // the base cases exercise the "manual system-user token" path.
  delete process.env.META_APP_ID;
  delete process.env.META_SECRET;
  delete process.env.META_APP_SECRET;
});

describe('validateAndConnect — happy path', () => {
  test('probes Meta with the tenant’s own token before persisting', async () => {
    stubHappyGraph();
    const res = await validateAndConnect(GOOD_INPUT);

    expect(res.ok).toBe(true);
    // The number probe used THIS tenant's token, not a platform one.
    expect(providerMock.graphRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/PNID_777',
        accessToken: GOOD_INPUT.accessToken,
      }),
    );
    // And the WABA-ownership cross-check ran with the same token.
    expect(providerMock.listPhoneNumbers).toHaveBeenCalledWith({
      wabaId: 'WABA_777',
      accessToken: GOOD_INPUT.accessToken,
    });
  });

  test('activates the config and stamps onboardedAt on first connect', async () => {
    stubHappyGraph();
    await validateAndConnect(GOOD_INPUT);

    const arg = prismaMock.whatsAppConfig.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      tenantId_provider: { tenantId: 7, provider: META_CLOUD_PROVIDER },
    });
    expect(arg.create.isActive).toBe(true);
    expect(arg.create.onboardedAt).toBeInstanceOf(Date);
    expect(arg.create.disconnectedAt).toBeNull();
    expect(arg.create.webhookVerified).toBe(true);
  });

  test('writes the token through the credential-encryption helper', async () => {
    stubHappyGraph();
    await validateAndConnect(GOOD_INPUT);

    const arg = prismaMock.whatsAppConfig.upsert.mock.calls[0][0];
    expect(arg.create.accessToken).toBeTruthy();
    // Pins the storage contract that holds in both modes: whatever lands in the
    // column decrypts back to the token. With a field-encryption key present
    // that value is AES-256-GCM ciphertext; without one (CI default) the helper
    // is pass-through. Asserting the round-trip keeps this test honest either
    // way — the "never in plaintext over the wire" guarantee is pinned
    // separately by the masking test below, which holds unconditionally.
    expect(decryptCredential(arg.create.accessToken)).toBe(GOOD_INPUT.accessToken);
  });

  test('stands down sibling providers for THIS tenant only', async () => {
    stubHappyGraph();
    await validateAndConnect(GOOD_INPUT);

    expect(prismaMock.whatsAppConfig.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 7, provider: { not: META_CLOUD_PROVIDER } },
      data: { isActive: false },
    });
  });
});

describe('validateAndConnect — required fields', () => {
  test.each([
    ['phoneNumberId'],
    ['businessAccountId'],
    ['accessToken'],
  ])('missing %s → MISSING_FIELDS listing that field', async (field) => {
    stubHappyGraph();
    const input = { ...GOOD_INPUT, [field]: '' };
    const res = await validateAndConnect(input);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('MISSING_FIELDS');
    expect(res.fields).toContain(field);
    // No Graph call and no write on a client-side validation failure.
    expect(providerMock.graphRequest).not.toHaveBeenCalled();
    expect(prismaMock.whatsAppConfig.upsert).not.toHaveBeenCalled();
  });
});

describe('validateAndConnect — Meta rejects the credentials', () => {
  test('Graph code 190 → INVALID_ACCESS_TOKEN', async () => {
    providerMock.graphRequest.mockResolvedValue({
      ok: false,
      code: 190,
      error: 'Error validating access token: Session has expired.',
    });
    const res = await validateAndConnect(GOOD_INPUT);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_ACCESS_TOKEN');
    expect(prismaMock.whatsAppConfig.upsert).not.toHaveBeenCalled();
  });

  test('non-190 number failure → INVALID_PHONE_NUMBER_ID', async () => {
    providerMock.graphRequest.mockResolvedValue({
      ok: false,
      code: 100,
      error: 'Unsupported get request. Object with ID does not exist.',
    });
    const res = await validateAndConnect(GOOD_INPUT);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_PHONE_NUMBER_ID');
  });

  test('WABA read failure → INVALID_BUSINESS_ACCOUNT_ID', async () => {
    stubHappyGraph();
    providerMock.listPhoneNumbers.mockResolvedValue({
      ok: false,
      error: 'Object with ID WABA_BAD does not exist',
    });
    const res = await validateAndConnect(GOOD_INPUT);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_BUSINESS_ACCOUNT_ID');
  });

  test('number not attached to the declared WABA → PHONE_NUMBER_WABA_MISMATCH', async () => {
    stubHappyGraph();
    providerMock.listPhoneNumbers.mockResolvedValue({
      ok: true,
      data: { data: [{ id: 'SOME_OTHER_PNID' }] },
    });
    const res = await validateAndConnect(GOOD_INPUT);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('PHONE_NUMBER_WABA_MISMATCH');
    expect(prismaMock.whatsAppConfig.upsert).not.toHaveBeenCalled();
  });
});

describe('validateAndConnect — client isolation', () => {
  test('phone number already claimed by another tenant → PHONE_NUMBER_CLAIMED, no write', async () => {
    stubHappyGraph();
    prismaMock.whatsAppConfig.findFirst.mockResolvedValue({ id: 99 });

    const res = await validateAndConnect(GOOD_INPUT);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('PHONE_NUMBER_CLAIMED');
    // The guard runs BEFORE any Graph spend, and never reassigns the number.
    expect(providerMock.graphRequest).not.toHaveBeenCalled();
    expect(prismaMock.whatsAppConfig.upsert).not.toHaveBeenCalled();
    // Scoped to OTHER tenants — a tenant re-validating its own number is fine.
    expect(prismaMock.whatsAppConfig.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { phoneNumberId: 'PNID_777', tenantId: { not: 7 } },
      }),
    );
  });

  test('a failed probe deactivates an existing active row (never leaves a false "Connected")', async () => {
    prismaMock.whatsAppConfig.findUnique.mockResolvedValue({
      id: 5,
      tenantId: 7,
      provider: META_CLOUD_PROVIDER,
      phoneNumberId: 'PNID_777',
      businessAccountId: 'WABA_777',
      accessToken: encryptCredential('stored-token'),
      isActive: true,
      onboardedAt: new Date('2026-01-01T00:00:00Z'),
    });
    providerMock.graphRequest.mockResolvedValue({ ok: false, code: 190, error: 'expired' });
    prismaMock.whatsAppConfig.update.mockResolvedValue({ id: 5, isActive: false });

    const res = await validateAndConnect({ ...GOOD_INPUT, accessToken: undefined });

    expect(res.ok).toBe(false);
    expect(prismaMock.whatsAppConfig.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { isActive: false },
    });
  });
});

describe('validateAndConnect — secret handling', () => {
  test('a masked sentinel echo reuses the stored token instead of re-encrypting it', async () => {
    const storedCipher = encryptCredential('EAAG-previously-saved');
    prismaMock.whatsAppConfig.findUnique.mockResolvedValue({
      id: 5,
      tenantId: 7,
      provider: META_CLOUD_PROVIDER,
      phoneNumberId: 'PNID_777',
      businessAccountId: 'WABA_777',
      accessToken: storedCipher,
      isActive: false,
      onboardedAt: new Date('2026-01-01T00:00:00Z'),
    });
    stubHappyGraph();

    const res = await validateAndConnect({ ...GOOD_INPUT, accessToken: '****aved' });

    expect(res.ok).toBe(true);
    // Probed with the DECRYPTED stored token…
    expect(providerMock.graphRequest).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'EAAG-previously-saved' }),
    );
    // …and the update did not rewrite the accessToken column.
    const arg = prismaMock.whatsAppConfig.upsert.mock.calls[0][0];
    expect(arg.update.accessToken).toBeUndefined();
  });

  test('the returned config never contains the plaintext token', async () => {
    stubHappyGraph();
    const res = await validateAndConnect(GOOD_INPUT);

    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(GOOD_INPUT.accessToken);
    expect(res.config.accessToken).toEqual(
      expect.objectContaining({ configured: expect.any(Boolean) }),
    );
  });
});

describe('disconnect', () => {
  test('soft-disconnects and preserves credentials', async () => {
    prismaMock.whatsAppConfig.findUnique.mockResolvedValue({
      id: 5,
      tenantId: 7,
      provider: META_CLOUD_PROVIDER,
      phoneNumberId: 'PNID_777',
      businessAccountId: 'WABA_777',
      accessToken: encryptCredential('tok'),
      isActive: true,
    });
    providerMock.unsubscribeApp.mockResolvedValue({ ok: true });
    prismaMock.whatsAppConfig.update.mockResolvedValue({
      id: 5,
      isActive: false,
      disconnectedAt: new Date('2026-08-17T00:00:00Z'),
      accessToken: encryptCredential('tok'),
    });

    const res = await disconnect({ tenantId: 7, userId: 3 });

    expect(res.ok).toBe(true);
    const arg = prismaMock.whatsAppConfig.update.mock.calls[0][0];
    expect(arg.data.isActive).toBe(false);
    expect(arg.data.webhookVerified).toBe(false);
    expect(arg.data.disconnectedAt).toBeInstanceOf(Date);
    // Credentials are NOT cleared — reconnect is a re-validate, not a re-setup.
    expect(arg.data).not.toHaveProperty('accessToken');
  });

  test('no config → NOT_CONFIGURED', async () => {
    prismaMock.whatsAppConfig.findUnique.mockResolvedValue(null);
    const res = await disconnect({ tenantId: 7 });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NOT_CONFIGURED');
  });
});

describe('getConnectionState', () => {
  test('returns masked config plus the callback URL we generate', async () => {
    const prevBase = process.env.WEBHOOK_BASE_URL;
    process.env.WEBHOOK_BASE_URL = 'https://crm.example.com/';
    prismaMock.whatsAppConfig.findUnique.mockResolvedValue({
      id: 5,
      tenantId: 7,
      provider: META_CLOUD_PROVIDER,
      phoneNumberId: 'PNID_777',
      businessAccountId: 'WABA_777',
      accessToken: encryptCredential('tok-1234'),
      webhookVerifyToken: null,
      isActive: true,
      disconnectedAt: null,
      onboardedAt: new Date('2026-01-01T00:00:00Z'),
      settings: JSON.stringify({ displayPhoneNumber: '+91 98765 43210', metaBusinessId: 'BIZ_1' }),
    });

    try {
      const state = await getConnectionState({ tenantId: 7 });
      expect(state.configured).toBe(true);
      // Trailing slash on the env value must not double up.
      expect(state.ours.callbackUrl).toBe('https://crm.example.com/api/whatsapp/webhook');
      expect(state.ours.callbackUrlConfigured).toBe(true);
      // Operators paste the FULL callback URL as WEBHOOK_BASE_URL just as often
      // as they paste the bare origin (Meta's own UI shows the full URL). Both
      // must yield the same single-path result — appending blindly produced
      // ".../api/whatsapp/webhook/api/whatsapp/webhook", which Express won't
      // route, so Meta verification failed with no clear cause.
      process.env.WEBHOOK_BASE_URL = 'https://crm.example.com/api/whatsapp/webhook';
      const already = await getConnectionState({ tenantId: 7 });
      expect(already.ours.callbackUrl).toBe('https://crm.example.com/api/whatsapp/webhook');
      expect(state.meta.displayPhoneNumber).toBe('+91 98765 43210');
      expect(state.meta.metaBusinessId).toBe('BIZ_1');
      expect(JSON.stringify(state)).not.toContain('tok-1234');
    } finally {
      if (prevBase === undefined) delete process.env.WEBHOOK_BASE_URL;
      else process.env.WEBHOOK_BASE_URL = prevBase;
    }
  });
});
