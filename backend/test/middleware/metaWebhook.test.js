// Unit tests for backend/middleware/metaWebhook.js
//
// P1 — Webhook ingress middleware for the WhatsApp SaaS rollout. Pins:
//   • X-Hub-Signature-256 verification: timing-safe HMAC compare
//   • Dev-mode signature skip when META_APP_SECRET is unset (NON-prod only)
//   • Tenant routing by value.metadata.phone_number_id — never tenantId=1
//   • Idempotency: duplicate event ids are recorded as DUPLICATE, not
//     re-processed
//   • Multi-tenant batch: a payload mixing two tenants' entries routes
//     each entry to its correct tenant
//   • Raw-body availability check
//
// MOCK STRATEGY — matches the repo convention documented in
// test/lib/eventBus.test.js: monkey-patch model methods on the imported
// prisma singleton. The vitest deps-inlining (vitest.config.js) ensures
// the SUT and the test share the same `prisma` instance.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';

// Monkey-patch the methods the SUT touches. We use defensive assignment so
// the test runs even when `prisma generate` hasn't yet been re-run after
// the P1 schema additions — the SUT and the test share the same singleton
// so the patched namespace is visible from both sides.
if (!prisma.webhookEvent) prisma.webhookEvent = {};
prisma.whatsAppConfig.findMany = vi.fn();
prisma.webhookEvent.create = vi.fn();
prisma.webhookEvent.updateMany = vi.fn();

// SUT reads env vars per-call (envSecret/envIsProd/envVerify) so we only
// need to set process.env before calling the middleware function — no
// module reloading required.
const metaWebhook = require('../../middleware/metaWebhook');

function loadModule(env = {}) {
  // Apply env overrides for this test. Keys passed as '' are honoured.
  Object.assign(process.env, env);
  return metaWebhook;
}

function fakeReqRes({ body, headers = {} } = {}) {
  const req = {
    body,
    headers,
    waSignatureVerified: undefined,
    waParsedBody: undefined,
    waContext: undefined,
    waEvents: undefined,
  };
  const res = {
    statusCode: 200,
    headersSent: false,
    _payload: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this._payload = obj; this.headersSent = true; return this; },
    send(text) { this._payload = text; this.headersSent = true; return this; },
  };
  return { req, res };
}

function hmac(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

beforeEach(() => {
  prisma.whatsAppConfig.findMany.mockReset();
  prisma.webhookEvent.create.mockReset();
  prisma.webhookEvent.updateMany.mockReset();
});

// ─────────────────────────────────────────────────────────────────────
// verifySignature
// ─────────────────────────────────────────────────────────────────────
describe('verifySignature', () => {
  test('passes when HMAC matches', () => {
    const sut = loadModule({ META_APP_SECRET: 'test-secret-abc', NODE_ENV: 'production' });
    const rawBody = Buffer.from('{"hello":"world"}', 'utf8');
    const sig = 'sha256=' + hmac('test-secret-abc', rawBody);
    const { req, res } = fakeReqRes({ body: rawBody, headers: { 'x-hub-signature-256': sig } });
    const next = vi.fn();
    sut.verifySignature(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.waSignatureVerified).toBe(true);
  });

  test('403 on signature mismatch (timing-safe path)', () => {
    const sut = loadModule({ META_APP_SECRET: 'test-secret-abc', NODE_ENV: 'production' });
    const rawBody = Buffer.from('{"hello":"world"}', 'utf8');
    const wrong = 'sha256=' + hmac('different-secret', rawBody);
    const { req, res } = fakeReqRes({ body: rawBody, headers: { 'x-hub-signature-256': wrong } });
    const next = vi.fn();
    sut.verifySignature(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res._payload.code).toBe('SIGNATURE_INVALID');
  });

  test('403 when header is missing or malformed', () => {
    const sut = loadModule({ META_APP_SECRET: 'test-secret-abc', NODE_ENV: 'production' });
    const { req, res } = fakeReqRes({ body: Buffer.from('{}'), headers: {} });
    const next = vi.fn();
    sut.verifySignature(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res._payload.code).toBe('BAD_SIGNATURE_HEADER');
  });

  test('500 when req.body is not a Buffer (mount-order bug)', () => {
    const sut = loadModule({ META_APP_SECRET: 'test-secret-abc', NODE_ENV: 'production' });
    const { req, res } = fakeReqRes({
      body: { already: 'parsed' },
      headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
    });
    const next = vi.fn();
    sut.verifySignature(req, res, next);
    expect(res.statusCode).toBe(500);
    expect(res._payload.code).toBe('RAW_BODY_MISSING');
  });

  test('production + unset secret = 503', () => {
    const sut = loadModule({ META_APP_SECRET: '', NODE_ENV: 'production' });
    const { req, res } = fakeReqRes({ body: Buffer.from('{}') });
    const next = vi.fn();
    sut.verifySignature(req, res, next);
    expect(res.statusCode).toBe(503);
    expect(res._payload.code).toBe('META_APP_SECRET_MISSING');
  });

  test('development + unset secret = pass through (no verification)', () => {
    const sut = loadModule({ META_APP_SECRET: '', NODE_ENV: 'development' });
    const { req, res } = fakeReqRes({ body: Buffer.from('{}') });
    const next = vi.fn();
    sut.verifySignature(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.waSignatureVerified).toBe(false);
    expect(req.waSignatureReason).toBe('dev_no_secret');
  });

  test('mismatched hex lengths do not throw (timing-safe handles unequal Buffers)', () => {
    const sut = loadModule({ META_APP_SECRET: 'test-secret-abc', NODE_ENV: 'production' });
    const { req, res } = fakeReqRes({
      body: Buffer.from('{}'),
      headers: { 'x-hub-signature-256': 'sha256=abc' }, // 3-char hex, wrong length
    });
    const next = vi.fn();
    sut.verifySignature(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res._payload.code).toBe('SIGNATURE_INVALID');
  });
});

// ─────────────────────────────────────────────────────────────────────
// parseBody
// ─────────────────────────────────────────────────────────────────────
describe('parseBody', () => {
  test('JSON-parses a Buffer into waParsedBody', () => {
    const sut = loadModule();
    const { req, res } = fakeReqRes({ body: Buffer.from('{"x":1}') });
    const next = vi.fn();
    sut.parseBody(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.waParsedBody).toEqual({ x: 1 });
  });

  test('400 on malformed JSON', () => {
    const sut = loadModule();
    const { req, res } = fakeReqRes({ body: Buffer.from('{not json') });
    const next = vi.fn();
    sut.parseBody(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(res._payload.code).toBe('MALFORMED_JSON');
  });

  test('accepts pre-parsed object (dev-mode fallback path)', () => {
    const sut = loadModule();
    const { req, res } = fakeReqRes({ body: { hello: 'world' } });
    const next = vi.fn();
    sut.parseBody(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.waParsedBody).toEqual({ hello: 'world' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// routeToTenant
// ─────────────────────────────────────────────────────────────────────
describe('routeToTenant', () => {
  test('attaches tenantId + configId per entry when phone_number_id matches a config', async () => {
    const sut = loadModule();
    prisma.whatsAppConfig.findMany.mockResolvedValue([
      { id: 11, tenantId: 2, phoneNumberId: 'pn_A', disconnectedAt: null, businessRestricted: false },
      { id: 12, tenantId: 3, phoneNumberId: 'pn_B', disconnectedAt: null, businessRestricted: false },
    ]);

    const body = {
      entry: [
        { changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn_A' }, messages: [] } }] },
        { changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn_B' }, messages: [] } }] },
      ],
    };
    const { req, res } = fakeReqRes();
    req.waParsedBody = body;
    const next = vi.fn();
    await sut.routeToTenant(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.waContext.entries).toEqual([
      { tenantId: 2, configId: 11, phoneNumberId: 'pn_A', disconnected: false, restricted: false },
      { tenantId: 3, configId: 12, phoneNumberId: 'pn_B', disconnected: false, restricted: false },
    ]);
  });

  test('marks entry unknown when phone_number_id has no matching config (NEVER defaults to tenant 1)', async () => {
    const sut = loadModule();
    prisma.whatsAppConfig.findMany.mockResolvedValue([]);
    const body = {
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn_orphan' } } }] }],
    };
    const { req, res } = fakeReqRes();
    req.waParsedBody = body;
    await sut.routeToTenant(req, res, vi.fn());
    expect(req.waContext.entries[0].unknown).toBe(true);
    expect(req.waContext.entries[0].reason).toBe('no_matching_config');
    expect(req.waContext.entries[0].tenantId).toBeUndefined();
  });

  test('marks entry unknown when phone_number_id is absent', async () => {
    const sut = loadModule();
    prisma.whatsAppConfig.findMany.mockResolvedValue([]);
    const body = { entry: [{ changes: [{ field: 'messages', value: { metadata: {} } }] }] };
    const { req, res } = fakeReqRes();
    req.waParsedBody = body;
    await sut.routeToTenant(req, res, vi.fn());
    expect(req.waContext.entries[0]).toEqual({ unknown: true, reason: 'no_phone_number_id' });
  });

  test('disconnected/restricted flags propagate to the context', async () => {
    const sut = loadModule();
    prisma.whatsAppConfig.findMany.mockResolvedValue([
      { id: 99, tenantId: 7, phoneNumberId: 'pn_X', disconnectedAt: new Date(), businessRestricted: true },
    ]);
    const body = { entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'pn_X' } } }] }] };
    const { req, res } = fakeReqRes();
    req.waParsedBody = body;
    await sut.routeToTenant(req, res, vi.fn());
    expect(req.waContext.entries[0].disconnected).toBe(true);
    expect(req.waContext.entries[0].restricted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// ensureIdempotency
// ─────────────────────────────────────────────────────────────────────
describe('ensureIdempotency', () => {
  test('inserts WebhookEvent and pushes processable events', async () => {
    const sut = loadModule();
    prisma.webhookEvent.create.mockImplementation(({ data }) => Promise.resolve({ id: 100, ...data }));

    const { req, res } = fakeReqRes();
    req.waSignatureVerified = true;
    req.waContext = { entries: [{ tenantId: 5, configId: 9, phoneNumberId: 'pn_A' }] };
    req.waParsedBody = {
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'pn_A' },
            messages: [{ id: 'wamid.1', from: '919...', text: { body: 'hi' } }],
          },
        }],
      }],
    };

    await sut.ensureIdempotency(req, res, vi.fn());
    expect(prisma.webhookEvent.create).toHaveBeenCalledOnce();
    const call = prisma.webhookEvent.create.mock.calls[0][0].data;
    expect(call.source).toBe('meta_whatsapp');
    expect(call.metaEventId).toBe('pn_A:msg:wamid.1');
    expect(call.tenantId).toBe(5);
    expect(call.signatureOk).toBe(true);
    expect(req.waEvents).toHaveLength(1);
    expect(req.waEvents[0].tenantId).toBe(5);
  });

  test('records IGNORED + does NOT enqueue when entry is unknown', async () => {
    const sut = loadModule();
    prisma.webhookEvent.create.mockResolvedValue({ id: 200 });

    const { req, res } = fakeReqRes();
    req.waSignatureVerified = true;
    req.waContext = { entries: [{ unknown: true, reason: 'no_matching_config', phoneNumberId: 'pn_ZZ' }] };
    req.waParsedBody = {
      entry: [{
        changes: [{
          field: 'messages',
          value: { metadata: { phone_number_id: 'pn_ZZ' }, messages: [{ id: 'wamid.ZZ' }] },
        }],
      }],
    };

    await sut.ensureIdempotency(req, res, vi.fn());
    const call = prisma.webhookEvent.create.mock.calls[0][0].data;
    expect(call.status).toBe('IGNORED');
    expect(call.tenantId).toBe(null);
    expect(req.waEvents).toHaveLength(0);
  });

  test('handles P2002 (duplicate) by marking DUPLICATE and skipping enqueue', async () => {
    const sut = loadModule();
    const dupErr = Object.assign(new Error('unique violation'), { code: 'P2002' });
    prisma.webhookEvent.create.mockRejectedValueOnce(dupErr);
    prisma.webhookEvent.updateMany.mockResolvedValue({ count: 1 });

    const { req, res } = fakeReqRes();
    req.waSignatureVerified = true;
    req.waContext = { entries: [{ tenantId: 5, configId: 9 }] };
    req.waParsedBody = {
      entry: [{
        changes: [{
          field: 'messages',
          value: { metadata: { phone_number_id: 'pn_A' }, messages: [{ id: 'wamid.dup' }] },
        }],
      }],
    };

    await sut.ensureIdempotency(req, res, vi.fn());
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledOnce();
    const updArgs = prisma.webhookEvent.updateMany.mock.calls[0][0];
    expect(updArgs.where.metaEventId).toBe('pn_A:msg:wamid.dup');
    expect(updArgs.data.status).toBe('DUPLICATE');
    expect(req.waEvents).toHaveLength(0);
  });

  test('status events produce metaEventId including the status value', async () => {
    const sut = loadModule();
    prisma.webhookEvent.create.mockResolvedValue({ id: 300 });

    const { req, res } = fakeReqRes();
    req.waSignatureVerified = true;
    req.waContext = { entries: [{ tenantId: 5, configId: 9 }] };
    req.waParsedBody = {
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'pn_A' },
            statuses: [{ id: 'wamid.s1', status: 'delivered', recipient_id: '...' }],
          },
        }],
      }],
    };

    await sut.ensureIdempotency(req, res, vi.fn());
    const call = prisma.webhookEvent.create.mock.calls[0][0].data;
    expect(call.metaEventId).toBe('pn_A:status:wamid.s1:delivered');
  });
});

// ─────────────────────────────────────────────────────────────────────
// respondImmediately
// ─────────────────────────────────────────────────────────────────────
describe('respondImmediately', () => {
  test('sends 200 then defers next() with setImmediate', () => new Promise((resolve) => {
    const sut = loadModule();
    const { req, res } = fakeReqRes();
    let nextCalled = false;
    sut.respondImmediately(req, res, () => { nextCalled = true; resolve(); });
    expect(res.statusCode).toBe(200);
    expect(res.headersSent).toBe(true);
    expect(nextCalled).toBe(false);
  }));

  test('does not re-send if headers already sent', () => {
    const sut = loadModule();
    const { req, res } = fakeReqRes();
    res.headersSent = true;
    sut.respondImmediately(req, res, vi.fn());
    expect(res._payload).toBe(null);
  });
});
