// Unit tests for backend/cron/whatsappTokenRefreshEngine.js
//
// Pins:
//   • Never-expires token (tokenExpiresAt=null) → no extend, just stamp health-check
//   • Already-expired token → soft-disconnect + audit + notification
//   • >7 days until expiry → no-op
//   • <7 days → call extendToken, then debugToken for new expiry, then persist
//   • extendToken failing but debugToken says is_valid=false → soft-disconnect
//   • extendToken failing but token still valid → just stamp health-check (will retry tomorrow)

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

if (!prisma.whatsAppConfig) prisma.whatsAppConfig = {};
if (!prisma.notification) prisma.notification = {};
prisma.whatsAppConfig.update = vi.fn();
prisma.notification.create = vi.fn();

const provider = require('../../services/whatsappProvider');
provider.extendToken = vi.fn();
provider.debugToken = vi.fn();

const audit = require('../../lib/audit');
audit.writeAudit = vi.fn().mockResolvedValue({});

const { _internals } = require('../../cron/whatsappTokenRefreshEngine');
const { processOne, SEVEN_DAYS_MS } = _internals;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.whatsAppConfig.update.mockReset();
  prisma.notification.create.mockReset();
  provider.extendToken.mockReset();
  provider.debugToken.mockReset();
  // mockReset() clears mockResolvedValue → re-establish so .catch() chains work.
  audit.writeAudit.mockReset().mockResolvedValue({});
  process.env.META_APP_ID = 'app';
  process.env.META_APP_SECRET = 'secret';
});

describe('processOne', () => {
  test('null tokenExpiresAt → skip_never_expires, just stamp lastHealthCheckAt', async () => {
    prisma.whatsAppConfig.update.mockResolvedValue({});
    const cfg = { id: 1, tenantId: 5, tokenExpiresAt: null, accessToken: 'cipher' };
    const r = await processOne(cfg);
    expect(r.action).toBe('skip_never_expires');
    expect(prisma.whatsAppConfig.update).toHaveBeenCalledOnce();
    expect(prisma.whatsAppConfig.update.mock.calls[0][0].data).toEqual({ lastHealthCheckAt: expect.any(Date) });
    expect(provider.extendToken).not.toHaveBeenCalled();
  });

  test('expired token → soft-disconnect + audit + Notification', async () => {
    prisma.whatsAppConfig.update.mockResolvedValue({});
    prisma.notification.create.mockResolvedValue({});
    const cfg = {
      id: 7, tenantId: 5,
      tokenExpiresAt: new Date(Date.now() - 24 * 3600 * 1000),
      accessToken: 'cipher',
    };
    const r = await processOne(cfg);
    expect(r.action).toBe('expired');
    const upd = prisma.whatsAppConfig.update.mock.calls[0][0].data;
    expect(upd.disconnectedAt).toBeInstanceOf(Date);
    expect(upd.webhookVerified).toBe(false);
    expect(audit.writeAudit).toHaveBeenCalledWith(
      'WhatsAppConfig', 'WHATSAPP_TOKEN_EXPIRED', 7, null, 5, expect.any(Object),
    );
    expect(prisma.notification.create).toHaveBeenCalledOnce();
  });

  test('>7 days until expiry → no_op + stamp lastHealthCheckAt', async () => {
    prisma.whatsAppConfig.update.mockResolvedValue({});
    const cfg = {
      id: 1, tenantId: 5,
      tokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      accessToken: 'cipher',
    };
    const r = await processOne(cfg);
    expect(r.action).toBe('no_op');
    expect(provider.extendToken).not.toHaveBeenCalled();
  });

  test('<7 days → extendToken + debugToken + persist new token', async () => {
    prisma.whatsAppConfig.update.mockResolvedValue({});
    provider.extendToken.mockResolvedValue({ ok: true, data: { access_token: 'NEW_TOK' } });
    const futureSec = Math.floor((Date.now() + 60 * 24 * 3600 * 1000) / 1000);
    provider.debugToken.mockResolvedValue({ ok: true, data: { data: { expires_at: futureSec } } });
    const cfg = {
      id: 8, tenantId: 5,
      tokenExpiresAt: new Date(Date.now() + 3 * 24 * 3600 * 1000),
      accessToken: 'old_cipher',
    };
    const r = await processOne(cfg);
    expect(r.action).toBe('extended');
    expect(provider.extendToken).toHaveBeenCalledOnce();
    expect(provider.debugToken).toHaveBeenCalledOnce();
    const upd = prisma.whatsAppConfig.update.mock.calls[0][0].data;
    expect(typeof upd.accessToken).toBe('string');
    expect(upd.tokenExpiresAt).toBeInstanceOf(Date);
    expect(upd.lastRotatedAt).toBeInstanceOf(Date);
    expect(audit.writeAudit).toHaveBeenCalledWith(
      'WhatsAppConfig', 'WHATSAPP_TOKEN_EXTENDED', 8, null, 5, expect.any(Object),
    );
  });

  test('<7 days, extend fails + debug says is_valid=false → soft-disconnect', async () => {
    prisma.whatsAppConfig.update.mockResolvedValue({});
    provider.extendToken.mockResolvedValue({ ok: false, error: 'oauth fail' });
    provider.debugToken.mockResolvedValue({ ok: true, data: { data: { is_valid: false } } });
    const cfg = {
      id: 9, tenantId: 5,
      tokenExpiresAt: new Date(Date.now() + 3 * 24 * 3600 * 1000),
      accessToken: 'cipher',
    };
    const r = await processOne(cfg);
    expect(r.action).toBe('expired_via_debug');
    const upd = prisma.whatsAppConfig.update.mock.calls[0][0].data;
    expect(upd.disconnectedAt).toBeInstanceOf(Date);
  });

  test('<7 days, extend fails + debug ok → just stamp health-check (retry tomorrow)', async () => {
    prisma.whatsAppConfig.update.mockResolvedValue({});
    provider.extendToken.mockResolvedValue({ ok: false, error: 'oauth fail' });
    provider.debugToken.mockResolvedValue({ ok: true, data: { data: { is_valid: true, expires_at: 9999999999 } } });
    const cfg = {
      id: 10, tenantId: 5,
      tokenExpiresAt: new Date(Date.now() + 3 * 24 * 3600 * 1000),
      accessToken: 'cipher',
    };
    const r = await processOne(cfg);
    expect(r.action).toBe('extend_failed');
    const upd = prisma.whatsAppConfig.update.mock.calls[0][0].data;
    expect(upd.disconnectedAt).toBeUndefined();
    expect(upd.lastHealthCheckAt).toBeInstanceOf(Date);
  });

  test('skip_no_creds when META_APP_ID is missing', async () => {
    delete process.env.META_APP_ID;
    const cfg = {
      id: 11, tenantId: 5,
      tokenExpiresAt: new Date(Date.now() + 3 * 24 * 3600 * 1000),
      accessToken: 'cipher',
    };
    const r = await processOne(cfg);
    expect(r.action).toBe('skip_no_creds');
  });

  test('SEVEN_DAYS_MS is exactly 7 days', () => {
    expect(SEVEN_DAYS_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
