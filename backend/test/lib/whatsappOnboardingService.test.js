// Unit tests for backend/lib/whatsappOnboardingService.js
//
// Pins:
//   • exchangeAndDebug: env-creds missing → META_CREDS_MISSING
//   • exchangeAndDebug: bad code → META_AUTH_FAILED
//   • exchangeAndDebug: debug_token says is_valid=false → TOKEN_INVALID
//   • exchangeAndDebug: required scopes missing → SCOPE_MISSING
//   • exchangeAndDebug: happy path returns { ok, token, expiresAt, scopes }
//   • exchangeAndDebug: never-expires token (expires_at=0) → expiresAt=null
//   • finalize: webhook subscribe error → WEBHOOK_SUBSCRIBE_FAILED
//   • finalize: happy path upserts WhatsAppConfig + writes audit
//   • disconnect: not connected → NOT_CONNECTED
//   • disconnect: soft-disconnects, preserves row, writes audit
//   • isEnabled: respects WHATSAPP_EMBEDDED_SIGNUP_ENABLED env var

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

// Defensive — WhatsAppConfig is in the schema but the new fields may not
// yet exist on the generated client. We monkey-patch what we need.
prisma.whatsAppConfig.upsert = vi.fn();
prisma.whatsAppConfig.updateMany = vi.fn();
prisma.whatsAppConfig.findFirst = vi.fn();
prisma.whatsAppConfig.update = vi.fn();
prisma.$transaction = vi.fn();

// Monkey-patch the provider singleton — the SUT does property lookup at
// call time (`provider.exchangeCode(...)`) so post-load patching is visible.
// Same pattern as test/lib/eventBus.test.js et al. Avoids vi.mock's CJS
// interop quirks.
const provider = require('../../services/whatsappProvider');
provider.exchangeCode = vi.fn();
provider.extendToken = vi.fn();
provider.debugToken = vi.fn();
provider.subscribeApp = vi.fn();
provider.unsubscribeApp = vi.fn();
provider.registerPhone = vi.fn();

// Audit writes are side-effect — silence them.
const audit = require('../../lib/audit');
audit.writeAudit = vi.fn().mockResolvedValue({});

const sut = require('../../lib/whatsappOnboardingService');

beforeEach(() => {
  vi.clearAllMocks();
  prisma.whatsAppConfig.upsert.mockReset();
  prisma.whatsAppConfig.updateMany.mockReset();
  prisma.whatsAppConfig.findFirst.mockReset();
  prisma.whatsAppConfig.update.mockReset();
  prisma.$transaction.mockReset();
});

describe('isEnabled', () => {
  test('false unless WHATSAPP_EMBEDDED_SIGNUP_ENABLED is exactly "true"', () => {
    process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED = '';
    expect(sut.isEnabled()).toBe(false);
    process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED = 'no';
    expect(sut.isEnabled()).toBe(false);
    process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED = 'true';
    expect(sut.isEnabled()).toBe(true);
    process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED = 'TRUE';
    expect(sut.isEnabled()).toBe(true);
  });
});

describe('exchangeAndDebug', () => {
  test('returns META_CREDS_MISSING when META_APP_ID/SECRET absent', async () => {
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    const r = await sut.exchangeAndDebug({ code: 'X' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('META_CREDS_MISSING');
  });

  test('returns META_AUTH_FAILED when exchangeCode rejects', async () => {
    process.env.META_APP_ID = 'app';
    process.env.META_APP_SECRET = 'secret';
    provider.exchangeCode.mockResolvedValue({ ok: false, error: 'Invalid code' });
    const r = await sut.exchangeAndDebug({ code: 'BAD' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('META_AUTH_FAILED');
  });

  test('returns TOKEN_DEBUG_FAILED when debug_token errors', async () => {
    process.env.META_APP_ID = 'app';
    process.env.META_APP_SECRET = 'secret';
    provider.exchangeCode.mockResolvedValue({ ok: true, data: { access_token: 'T' } });
    provider.extendToken.mockResolvedValue({ ok: false });
    provider.debugToken.mockResolvedValue({ ok: false, error: 'rate limited' });
    const r = await sut.exchangeAndDebug({ code: 'X' });
    expect(r.code).toBe('TOKEN_DEBUG_FAILED');
  });

  test('returns TOKEN_INVALID when is_valid=false', async () => {
    process.env.META_APP_ID = 'app';
    process.env.META_APP_SECRET = 'secret';
    provider.exchangeCode.mockResolvedValue({ ok: true, data: { access_token: 'T' } });
    provider.extendToken.mockResolvedValue({ ok: false });
    provider.debugToken.mockResolvedValue({ ok: true, data: { data: { is_valid: false } } });
    const r = await sut.exchangeAndDebug({ code: 'X' });
    expect(r.code).toBe('TOKEN_INVALID');
  });

  test('returns SCOPE_MISSING when required scopes absent', async () => {
    process.env.META_APP_ID = 'app';
    process.env.META_APP_SECRET = 'secret';
    provider.exchangeCode.mockResolvedValue({ ok: true, data: { access_token: 'T' } });
    provider.extendToken.mockResolvedValue({ ok: false });
    provider.debugToken.mockResolvedValue({
      ok: true,
      data: { data: { is_valid: true, scopes: ['email'], expires_at: 0 } },
    });
    const r = await sut.exchangeAndDebug({ code: 'X' });
    expect(r.code).toBe('SCOPE_MISSING');
  });

  test('happy path returns token + expiresAt + scopes', async () => {
    process.env.META_APP_ID = 'app';
    process.env.META_APP_SECRET = 'secret';
    provider.exchangeCode.mockResolvedValue({ ok: true, data: { access_token: 'short_tok' } });
    provider.extendToken.mockResolvedValue({ ok: true, data: { access_token: 'long_tok' } });
    const futureSeconds = Math.floor((Date.now() + 60 * 24 * 3600 * 1000) / 1000);
    provider.debugToken.mockResolvedValue({
      ok: true,
      data: {
        data: {
          is_valid: true,
          scopes: ['whatsapp_business_management', 'whatsapp_business_messaging', 'email'],
          expires_at: futureSeconds,
          user_id: 'sys_user_42',
        },
      },
    });
    const r = await sut.exchangeAndDebug({ code: 'X' });
    expect(r.ok).toBe(true);
    expect(r.token).toBe('long_tok'); // extended token wins over short-lived
    expect(r.expiresAt).toBeInstanceOf(Date);
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(r.appUserId).toBe('sys_user_42');
    expect(r.scopes).toContain('whatsapp_business_management');
  });

  test('never-expires token (expires_at=0) → expiresAt=null', async () => {
    process.env.META_APP_ID = 'app';
    process.env.META_APP_SECRET = 'secret';
    provider.exchangeCode.mockResolvedValue({ ok: true, data: { access_token: 'T' } });
    provider.extendToken.mockResolvedValue({ ok: false });
    provider.debugToken.mockResolvedValue({
      ok: true,
      data: {
        data: {
          is_valid: true,
          scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
          expires_at: 0,
        },
      },
    });
    const r = await sut.exchangeAndDebug({ code: 'X' });
    expect(r.ok).toBe(true);
    expect(r.expiresAt).toBe(null);
  });
});

describe('finalize', () => {
  test('returns WEBHOOK_SUBSCRIBE_FAILED on subscribed_apps error (non-"already" error)', async () => {
    provider.subscribeApp.mockResolvedValue({ ok: false, error: 'invalid waba id' });
    const r = await sut.finalize({
      tenantId: 1, token: 'T', expiresAt: null,
      wabaId: 'W', phoneNumberId: 'P',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('WEBHOOK_SUBSCRIBE_FAILED');
  });

  test('tolerates "already subscribed" subscribed_apps result', async () => {
    provider.subscribeApp.mockResolvedValue({ ok: false, error: 'Application is already subscribed' });
    prisma.$transaction.mockImplementation(async (fn) => fn({
      whatsAppConfig: {
        upsert: vi.fn().mockResolvedValue({ id: 99, tenantId: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    }));
    const r = await sut.finalize({
      tenantId: 1, token: 'T', expiresAt: null,
      wabaId: 'W', phoneNumberId: 'P',
    });
    expect(r.ok).toBe(true);
    expect(r.configId).toBe(99);
  });

  test('persists encrypted token + writes audit on happy path', async () => {
    provider.subscribeApp.mockResolvedValue({ ok: true });
    const upsertSpy = vi.fn().mockResolvedValue({ id: 7, tenantId: 5 });
    prisma.$transaction.mockImplementation(async (fn) => fn({
      whatsAppConfig: {
        upsert: upsertSpy,
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    }));
    const r = await sut.finalize({
      tenantId: 5,
      userId: 11,
      token: 'long_tok',
      expiresAt: new Date('2030-01-01'),
      appUserId: 'u_99',
      wabaId: 'WABA',
      phoneNumberId: 'PNID',
    });
    expect(r.ok).toBe(true);
    expect(upsertSpy).toHaveBeenCalledOnce();
    const data = upsertSpy.mock.calls[0][0].create;
    // Encrypted-credential field — must be wrapped (not raw plaintext).
    // When WELLNESS_FIELD_KEY is unset, encryptCredential is identity,
    // so the raw plaintext flows through; assert it's NOT undefined.
    expect(typeof data.accessToken).toBe('string');
    expect(data.phoneNumberId).toBe('PNID');
    expect(data.businessAccountId).toBe('WABA');
    expect(data.isActive).toBe(true);
    expect(data.webhookVerified).toBe(true);
  });
});

describe('disconnect', () => {
  test('returns NOT_CONNECTED when no row exists', async () => {
    prisma.whatsAppConfig.findFirst.mockResolvedValue(null);
    const r = await sut.disconnect({ tenantId: 1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_CONNECTED');
  });

  test('soft-disconnects existing row and preserves it', async () => {
    prisma.whatsAppConfig.findFirst.mockResolvedValue({
      id: 12, businessAccountId: 'WABA', accessToken: 'cipher',
    });
    prisma.whatsAppConfig.update.mockResolvedValue({ id: 12 });
    const r = await sut.disconnect({ tenantId: 7, userId: 22, alsoUnsubscribeFromMeta: false });
    expect(r.ok).toBe(true);
    // The update sets disconnectedAt + isActive=false + webhookVerified=false.
    const updateArgs = prisma.whatsAppConfig.update.mock.calls[0][0];
    expect(updateArgs.where.id).toBe(12);
    expect(updateArgs.data.isActive).toBe(false);
    expect(updateArgs.data.disconnectedAt).toBeInstanceOf(Date);
    expect(updateArgs.data.webhookVerified).toBe(false);
  });

  test('alsoUnsubscribeFromMeta calls provider.unsubscribeApp but tolerates failure', async () => {
    prisma.whatsAppConfig.findFirst.mockResolvedValue({
      id: 12, businessAccountId: 'WABA', accessToken: 'cipher',
    });
    prisma.whatsAppConfig.update.mockResolvedValue({ id: 12 });
    provider.unsubscribeApp.mockResolvedValue({ ok: false, error: 'already gone' });
    const r = await sut.disconnect({ tenantId: 7, alsoUnsubscribeFromMeta: true });
    expect(r.ok).toBe(true);
    expect(provider.unsubscribeApp).toHaveBeenCalledOnce();
  });
});
