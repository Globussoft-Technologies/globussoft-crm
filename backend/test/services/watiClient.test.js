// Unit tests for backend/services/watiClient.js
//
// What this module does:
//   Wati REST client — the TRAVEL vertical's WhatsApp transport (Q9). The
//   wellness/generic vertical's direct Meta Cloud API path
//   (services/whatsappProvider.js) is a SEPARATE track and is not touched
//   by this module. Stub mode (no WATI_API_ENDPOINT / WATI_ACCESS_TOKEN, or
//   NODE_ENV==='test') logs the would-send line + persists a QUEUED
//   WhatsAppMessage row; real mode calls Wati's API
//   (sendTemplateMessage / sendSessionMessage) with Bearer auth and
//   persists SENT/FAILED rows.
//
//   Exports:
//     - isEnabled()                — false under test / missing / placeholder creds
//     - getConfig()                — env read; REPLACE_* placeholders → null
//     - normalizePhone(raw)        — digits-only; 10-digit gets 91 prefix
//     - resolveChannelNumber(t,sb) — subBrandConfigJson phoneNumberId → env fallback
//     - persistMessageRow({...})   — best-effort WhatsAppMessage create; never throws
//     - watiFetch(path, opts)      — Bearer-auth fetch wrapper (real mode only)
//     - sendTemplateMessage({...}) — HSM template send
//     - sendSessionMessage({...})  — 24h-window free-form send
//     - sendBestEffort({...})      — template-first w/ session fallback; never throws
//     - getMessageTemplates()      — template list (real mode)
//
// Surface area covered:
//   1.  Module shape — exports
//   2.  normalizePhone variants
//   3.  getConfig treats REPLACE placeholders as unset; isEnabled false under test
//   4.  stub sendTemplateMessage → QUEUED + WhatsAppMessage row persisted
//   5.  stub sendSessionMessage → QUEUED + row body = text
//   6.  sendBestEffort with neither template nor fallback → SKIPPED
//   7.  sendBestEffort delegates to sendTemplateMessage when templateName given
//   8.  real-mode template success → SENT + providerMsgId persisted
//   9.  real-mode template failure → FAILED + errorMessage persisted
//   10. real-mode sendBestEffort falls back to session message on template failure
//   11. resolveChannelNumber: subBrandConfigJson hit + env fallback
//   12. persistMessageRow swallows prisma errors (returns null, never throws)
//
// CJS self-mocking seam: the SUT calls its own functions via
// module.exports.fn(...) so vi.spyOn(client, 'fn') interception works —
// same pattern as adsGptClient / ratehawkClient / callifiedClient.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Hoisted Prisma mock — persistMessageRow does prisma.whatsAppMessage.create,
// resolveChannelNumber does prisma.tenant.findUnique. Installed into Node's
// Module._cache (vitest's ESM-level vi.mock can't intercept CJS require()).
const prismaMock = vi.hoisted(() => {
  const mock = {
    whatsAppMessage: {
      create: vi.fn().mockResolvedValue({ id: 991 }),
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  const Module = require('node:module');
  const requireFromCwd = Module.createRequire(process.cwd() + '/');
  const prismaLibPath = requireFromCwd.resolve('./lib/prisma');
  Module._cache[prismaLibPath] = {
    id: prismaLibPath,
    filename: prismaLibPath,
    loaded: true,
    exports: mock,
    children: [],
    paths: [],
  };
  return mock;
});

const client = requireCjs('../../services/watiClient');

const ENV_KEYS = ['WATI_API_ENDPOINT', 'WATI_ACCESS_TOKEN', 'WATI_CHANNEL_NUMBER'];
const envBackup = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
  prismaMock.whatsAppMessage.create.mockClear().mockResolvedValue({ id: 991 });
  prismaMock.tenant.findUnique.mockClear().mockResolvedValue(null);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  vi.restoreAllMocks();
});

describe('watiClient — module shape', () => {
  test('1. exports the full client surface', () => {
    expect(typeof client.isEnabled).toBe('function');
    expect(typeof client.getConfig).toBe('function');
    expect(typeof client.normalizePhone).toBe('function');
    expect(typeof client.resolveChannelNumber).toBe('function');
    expect(typeof client.persistMessageRow).toBe('function');
    expect(typeof client.watiFetch).toBe('function');
    expect(typeof client.sendTemplateMessage).toBe('function');
    expect(typeof client.sendSessionMessage).toBe('function');
    expect(typeof client.sendBestEffort).toBe('function');
    expect(typeof client.getMessageTemplates).toBe('function');
  });
});

describe('watiClient — helpers', () => {
  test('2. normalizePhone strips formatting, prefixes 91 on bare 10-digit', () => {
    expect(client.normalizePhone('+91 98765-43210')).toBe('919876543210');
    expect(client.normalizePhone('9876543210')).toBe('919876543210');
    expect(client.normalizePhone('919876543210')).toBe('919876543210');
    expect(client.normalizePhone('+1 (212) 555-0100')).toBe('12125550100');
    expect(client.normalizePhone('')).toBe(null);
    expect(client.normalizePhone(null)).toBe(null);
  });

  test('3. getConfig nulls REPLACE placeholders; isEnabled false under NODE_ENV=test', () => {
    process.env.WATI_API_ENDPOINT = 'https://live-mt-server.wati.io/REPLACE_ACCOUNT_ID';
    process.env.WATI_ACCESS_TOKEN = 'REPLACE_WITH_WATI_ACCESS_TOKEN';
    process.env.WATI_CHANNEL_NUMBER = '91REPLACE_PHONE_NUMBER';
    const cfg = client.getConfig();
    expect(cfg.endpoint).toBe(null);
    expect(cfg.token).toBe(null);
    expect(cfg.channelNumber).toBe(null);

    // Even with REAL-looking values, NODE_ENV==='test' keeps stub mode on
    // (CI must never make live HTTP calls).
    process.env.WATI_API_ENDPOINT = 'https://live-mt-server.wati.io/12345';
    process.env.WATI_ACCESS_TOKEN = 'real-looking-token';
    expect(client.isEnabled()).toBe(false);
  });

  test('11. resolveChannelNumber prefers subBrandConfigJson, falls back to env', async () => {
    process.env.WATI_CHANNEL_NUMBER = '919999900000';
    // No tenant row → env fallback.
    expect(await client.resolveChannelNumber(7, 'tmc')).toBe('919999900000');
    // subBrandConfigJson carries a per-sub-brand channel.
    prismaMock.tenant.findUnique.mockResolvedValue({
      subBrandConfigJson: JSON.stringify({ tmc: { phoneNumberId: '918888800000' } }),
    });
    expect(await client.resolveChannelNumber(7, 'tmc')).toBe('918888800000');
    // No subBrand → env fallback without a DB read.
    expect(await client.resolveChannelNumber(7, null)).toBe('919999900000');
  });

  test('12. persistMessageRow swallows prisma errors and returns null', async () => {
    prismaMock.whatsAppMessage.create.mockRejectedValue(new Error('db down'));
    const row = await client.persistMessageRow({
      tenantId: 3, to: '919876543210', body: 'x', status: 'QUEUED',
    });
    expect(row).toBe(null); // no throw
  });
});

describe('watiClient — stub mode (no creds / test env)', () => {
  test('4. sendTemplateMessage returns QUEUED stub envelope + persists row', async () => {
    const out = await client.sendTemplateMessage({
      tenantId: 3,
      subBrand: 'tmc',
      toPhone: '+91 98765 43210',
      templateName: 'otp_verification',
      parameters: [{ name: 'otp', value: '1234' }],
      bodyPreview: 'Your code is 1234',
    });
    expect(out.stub).toBe(true);
    expect(out.sent).toBe(false);
    expect(out.status).toBe('QUEUED');
    expect(out.to).toBe('919876543210');
    expect(out.messageRowId).toBe(991);
    expect(prismaMock.whatsAppMessage.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.whatsAppMessage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      to: '919876543210',
      direction: 'OUTBOUND',
      status: 'QUEUED',
      templateName: 'otp_verification',
      tenantId: 3,
    });
  });

  test('5. sendSessionMessage returns QUEUED stub envelope with body persisted', async () => {
    const out = await client.sendSessionMessage({
      tenantId: 3,
      toPhone: '9876543210',
      text: 'hello from travel',
    });
    expect(out.stub).toBe(true);
    expect(out.status).toBe('QUEUED');
    const data = prismaMock.whatsAppMessage.create.mock.calls[0][0].data;
    expect(data.body).toBe('hello from travel');
    expect(data.status).toBe('QUEUED');
  });

  test('6. sendBestEffort with neither templateName nor fallbackText → SKIPPED', async () => {
    const out = await client.sendBestEffort({ tenantId: 3, toPhone: '9876543210' });
    expect(out.status).toBe('SKIPPED');
    expect(out.sent).toBe(false);
    expect(prismaMock.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  test('7. sendBestEffort delegates to sendTemplateMessage when templateName given', async () => {
    const spy = vi.spyOn(client, 'sendTemplateMessage');
    const out = await client.sendBestEffort({
      tenantId: 3,
      toPhone: '9876543210',
      templateName: 'journey_reminder',
      fallbackText: 'fallback body',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ templateName: 'journey_reminder' });
    // Stub envelope short-circuits — no session fallback attempted.
    expect(out.stub).toBe(true);
    expect(out.status).toBe('QUEUED');
  });
});

describe('watiClient — real mode (isEnabled spied true, watiFetch mocked)', () => {
  test('8. template success → SENT + providerMsgId persisted', async () => {
    vi.spyOn(client, 'isEnabled').mockReturnValue(true);
    vi.spyOn(client, 'watiFetch').mockResolvedValue({ result: true, id: 'wamid-123' });
    const out = await client.sendTemplateMessage({
      tenantId: 3,
      toPhone: '919876543210',
      templateName: 'payment_reminder_t_minus_n',
      parameters: [{ name: 'amount', value: '₹5,000' }],
    });
    expect(out.sent).toBe(true);
    expect(out.status).toBe('SENT');
    expect(out.providerMsgId).toBe('wamid-123');
    expect(client.watiFetch).toHaveBeenCalledWith(
      '/api/v1/sendTemplateMessage',
      expect.objectContaining({
        method: 'POST',
        query: expect.objectContaining({ whatsappNumber: '919876543210' }),
        body: expect.objectContaining({ template_name: 'payment_reminder_t_minus_n' }),
      }),
    );
    const data = prismaMock.whatsAppMessage.create.mock.calls[0][0].data;
    expect(data.status).toBe('SENT');
    expect(data.providerMsgId).toBe('wamid-123');
  });

  test('9. template failure → FAILED + errorMessage persisted (no throw)', async () => {
    vi.spyOn(client, 'isEnabled').mockReturnValue(true);
    vi.spyOn(client, 'watiFetch').mockRejectedValue(new Error('Wati HTTP 401: invalid token'));
    const out = await client.sendTemplateMessage({
      tenantId: 3,
      toPhone: '919876543210',
      templateName: 'otp_verification',
    });
    expect(out.sent).toBe(false);
    expect(out.status).toBe('FAILED');
    expect(out.error).toContain('401');
    const data = prismaMock.whatsAppMessage.create.mock.calls[0][0].data;
    expect(data.status).toBe('FAILED');
    expect(data.errorMessage).toContain('401');
  });

  test('10. sendBestEffort falls back to session message when template fails', async () => {
    vi.spyOn(client, 'isEnabled').mockReturnValue(true);
    const fetchSpy = vi.spyOn(client, 'watiFetch')
      .mockRejectedValueOnce(new Error('Wati rejected: template not found'))
      .mockResolvedValueOnce({ result: true, id: 'wamid-session-1' });
    const out = await client.sendBestEffort({
      tenantId: 3,
      toPhone: '919876543210',
      templateName: 'not_yet_approved',
      fallbackText: 'session fallback body',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toContain('/api/v1/sendSessionMessage/');
    expect(out.fellBackToSession).toBe(true);
    expect(out.sent).toBe(true);
    expect(out.status).toBe('SENT');
    expect(out.templateError).toContain('template not found');
  });
});
