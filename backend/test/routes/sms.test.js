// @ts-check
/**
 * Unit + integration tests for backend/routes/sms.js — pins the SMS provider
 * config CRUD + send / send-bulk envelopes + OTP filter + webhook receiver
 * contracts that ship across #182, #254, #269, #435, #516, #651, #716.
 *
 * Why this file exists
 * ────────────────────
 *   routes/sms.js is a 748-LOC multi-tier module:
 *     1. ADMIN-ONLY config CRUD — GET /config, PUT /config/:provider, and
 *        POST /drain are gated by `[verifyToken, verifyRole(['ADMIN'])]`.
 *        Credentials are masked on read (#651 — `{configured, last4}` shape,
 *        never plaintext) and only fresh-plaintext values trigger a rotation
 *        + ProviderConfig.ROTATE audit row.
 *     2. AUTHED send + list — POST /send, POST /send-bulk, GET /messages,
 *        + /templates CRUD are tenant-scoped via req.user.tenantId.
 *     3. PUBLIC webhook — POST /webhook/:provider has NO auth (provider
 *        carriers post status updates from arbitrary IPs).
 *
 * What this file pins
 * ───────────────────
 *   SEND
 *   1. POST /send requires `to` AND `body` → 400 otherwise.
 *   2. POST /send 400s when no active SmsConfig row exists for the tenant.
 *   3. POST /send writes an OUTBOUND smsMessage row with the tenant's
 *      `req.user.tenantId` pinned (regression pin — prevents accidental
 *      cross-tenant body-field overrides).
 *   4. POST /send normalizes the recipient (10-digit Indian → "91…") before
 *      persistence — pins normalizePhone() at the route boundary.
 *
 *   SEND-BULK (#516)
 *   5. POST /send-bulk requires `to` → 400 otherwise.
 *   6. POST /send-bulk parses comma-separated recipients + splits deliverable
 *      vs pre-flight failures (invalid_recipient_phone) without blocking
 *      the valid recipients.
 *   7. POST /send-bulk returns the multi-recipient envelope shape
 *      ({success, totalSent, totalFailed, results, failures}) — pins the
 *      additive-envelope contract from #435 that the Inbox + Marketing
 *      Blast composers rely on.
 *
 *   MESSAGES + OTP REDACTION (#254 / #269)
 *   8. GET /messages filters by tenantId — direction + status + contactId
 *      pass through as additional filters.
 *   9. GET /messages excludes rows whose body matches OTP_BODY_RE
 *      (staff inbox MUST NOT see "Your OTP is 123456" rows).
 *
 *   TEMPLATES
 *  10. POST /templates requires name + body → 400 otherwise.
 *  11. PUT /templates/:id 404s when the template lives in another tenant
 *      (regression pin: the tenantId filter on the existence-check is the
 *      cross-tenant guard).
 *
 *   CONFIG + ROTATION (#651, #716)
 *  12. GET /config requires ADMIN — verifyRole returns 403 RBAC_DENIED for
 *      role=USER.
 *  13. GET /config returns the masked `{configured, last4}` shape for
 *      apiKey and authToken — plaintext credentials never round-trip to the
 *      browser.
 *  14. PUT /config/:provider rejects an MSG91 senderId longer than 6 chars
 *      with INVALID_SENDER_ID_LENGTH (#716).
 *
 *   WEBHOOK (NO AUTH)
 *  15. POST /webhook/twilio with a delivery-status payload updates the
 *      smsMessage row by providerMsgId and responds with TwiML XML.
 *  16. POST /webhook/<unknown> → 400 "Unknown provider".
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/chatbots.test.js — prisma singleton
 *   monkey-patch BEFORE the router is required, monkey-patch verifyToken
 *   to a pass-through so the verifyRole(['ADMIN']) admin-gate stays REAL
 *   (we exercise the role-denial path on /config). Mock the smsProvider
 *   service so no outbound HTTP fires.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Auth middleware bypass — pass through verifyToken so we exercise the
// route + verifyRole flow without minting JWTs. verifyRole stays REAL so
// the role-gate assertions are end-to-end.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Mock the smsProvider service BEFORE the router is required. sendSms is
// the outbound-HTTP boundary — replace with a resolved success fn so the
// route's downstream update-status path is exercised without real network.
vi.mock('../../services/smsProvider', () => ({
  normalizePhone: (phone) => {
    if (!phone) return '';
    let digits = String(phone).replace(/\D/g, '');
    if (digits.length === 10) digits = '91' + digits;
    return digits;
  },
  substituteVars: (template, contact) => {
    if (!template) return '';
    if (!contact) return template;
    return template
      .replace(/\{\{name\}\}/g, contact.name || '')
      .replace(/\{\{company\}\}/g, contact.company || '')
      .replace(/\{\{email\}\}/g, contact.email || '')
      .replace(/\{\{phone\}\}/g, contact.phone || '');
  },
  sendSms: vi.fn().mockResolvedValue({ success: true, providerMsgId: 'mock-msg-id' }),
  resolveProviderConfig: vi.fn().mockResolvedValue(null),
}));

// Mock the audit lib so writeAudit's prisma calls don't hit a real DB.
vi.mock('../../lib/audit', () => ({
  writeAudit: vi.fn().mockResolvedValue({ id: 9999 }),
}));

// Prisma singleton patching — must happen BEFORE the router is required.
prisma.smsConfig = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
  updateMany: vi.fn(),
};
prisma.smsMessage = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  count: vi.fn(),
};
prisma.smsTemplate = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();

import express from 'express';
import request from 'supertest';

const smsRouter = requireCJS('../../routes/sms');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/sms', smsRouter);
  return app;
}

beforeEach(() => {
  prisma.smsConfig.findFirst.mockReset();
  prisma.smsConfig.findMany.mockReset();
  prisma.smsConfig.upsert.mockReset();
  prisma.smsConfig.updateMany.mockReset();
  prisma.smsMessage.findFirst.mockReset();
  prisma.smsMessage.findMany.mockReset();
  prisma.smsMessage.create.mockReset();
  prisma.smsMessage.update.mockReset();
  prisma.smsMessage.updateMany.mockReset();
  prisma.smsMessage.count.mockReset();
  prisma.smsTemplate.findFirst.mockReset();
  prisma.smsTemplate.findMany.mockReset();
  prisma.smsTemplate.create.mockReset();
  prisma.smsTemplate.update.mockReset();
  prisma.smsTemplate.delete.mockReset();
  prisma.contact.findFirst.mockReset();

  // Sensible defaults
  prisma.smsConfig.findMany.mockResolvedValue([]);
  prisma.smsMessage.findMany.mockResolvedValue([]);
  prisma.smsMessage.count.mockResolvedValue(0);
  prisma.smsTemplate.findMany.mockResolvedValue([]);
  prisma.smsMessage.updateMany.mockResolvedValue({ count: 0 });
  prisma.smsConfig.updateMany.mockResolvedValue({ count: 0 });
});

// ─── POST /send — validation + persistence ──────────────────────────

describe('POST /send — validation', () => {
  test('400 when `to` is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/sms/send')
      .send({ body: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/to and body are required/i);
  });

  test('400 when `body` is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/sms/send')
      .send({ to: '9999999999' });
    expect(res.status).toBe(400);
  });

  test('400 when no active SmsConfig for the tenant', async () => {
    prisma.smsConfig.findFirst.mockResolvedValue(null);
    const app = makeApp();
    const res = await request(app)
      .post('/api/sms/send')
      .send({ to: '9999999999', body: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No active SMS provider configured/i);
  });

  test('persists OUTBOUND smsMessage with tenantId from req.user', async () => {
    prisma.smsConfig.findFirst.mockResolvedValue({
      id: 1,
      provider: 'msg91',
      apiKey: 'k',
      authToken: null,
      senderId: 'TESTID',
      isActive: true,
      tenantId: 42,
    });
    prisma.smsMessage.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 5001, ...data })
    );
    prisma.smsMessage.update.mockResolvedValue({ id: 5001 });

    const app = makeApp({ tenantId: 42, userId: 7 });
    const res = await request(app)
      .post('/api/sms/send')
      .send({ to: '9999999999', body: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.smsMessage.create.mock.calls[0][0];
    expect(createArgs.data.direction).toBe('OUTBOUND');
    expect(createArgs.data.status).toBe('QUEUED');
    expect(createArgs.data.tenantId).toBe(42);
    expect(createArgs.data.userId).toBe(7);
  });

  test('normalizes 10-digit Indian number to "91…" before persist', async () => {
    prisma.smsConfig.findFirst.mockResolvedValue({
      id: 1,
      provider: 'msg91',
      apiKey: 'k',
      authToken: null,
      senderId: 'TESTID',
      isActive: true,
      tenantId: 1,
    });
    prisma.smsMessage.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 5002, ...data })
    );
    prisma.smsMessage.update.mockResolvedValue({ id: 5002 });

    const app = makeApp();
    const res = await request(app)
      .post('/api/sms/send')
      .send({ to: '9876543210', body: 'hello' });

    expect(res.status).toBe(200);
    const createArgs = prisma.smsMessage.create.mock.calls[0][0];
    expect(createArgs.data.to).toBe('919876543210');
  });
});

// ─── POST /send-bulk — multi-recipient envelope (#516) ──────────────

describe('POST /send-bulk — #516 multi-recipient envelope', () => {
  test('400 when `to` is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/sms/send-bulk')
      .send({ body: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/to is required/i);
  });

  test('parses comma-separated recipients + reports invalid ones in failures', async () => {
    prisma.smsConfig.findFirst.mockResolvedValue({
      id: 1,
      provider: 'msg91',
      apiKey: 'k',
      authToken: null,
      senderId: 'TESTID',
      isActive: true,
      tenantId: 1,
    });
    prisma.smsMessage.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: Math.floor(Math.random() * 10000), ...data })
    );
    prisma.smsMessage.update.mockResolvedValue({ id: 1 });

    const app = makeApp();
    // Mix: two valid + one obviously-too-short invalid.
    const res = await request(app)
      .post('/api/sms/send-bulk')
      .send({
        to: '9876543210, 9123456789, 12',
        body: 'hello',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.totalSent).toBe(2);
    // The "12" recipient is too short — failures array must surface it.
    expect(Array.isArray(res.body.failures)).toBe(true);
    expect(res.body.failures.some(f => f.to === '12' && f.reason === 'invalid_recipient_phone')).toBe(true);
    // Two deliverable rows persisted.
    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(2);
  });

  test('returns multi-recipient envelope shape with results + failures arrays', async () => {
    prisma.smsConfig.findFirst.mockResolvedValue({
      id: 1,
      provider: 'msg91',
      apiKey: 'k',
      authToken: null,
      senderId: 'TESTID',
      isActive: true,
      tenantId: 1,
    });
    prisma.smsMessage.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 7777, ...data })
    );
    prisma.smsMessage.update.mockResolvedValue({ id: 7777 });

    const app = makeApp();
    const res = await request(app)
      .post('/api/sms/send-bulk')
      .send({
        to: ['9876543210', '9123456789'],
        body: 'hello',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      totalSent: 2,
      totalFailed: 0,
    });
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBe(2);
    expect(res.body.results[0]).toMatchObject({
      to: expect.any(String),
      messageId: expect.any(Number),
      status: 'SENT',
    });
    // messageId is the first row's id — back-compat shape for single-recipient
    // callers that destructure body.messageId.
    expect(res.body.messageId).toBe(res.body.results[0].messageId);
  });
});

// ─── GET /messages — OTP redaction (#254 / #269) ────────────────────

describe('GET /messages — OTP filter (#254 / #269)', () => {
  test('filters by tenantId + direction + status', async () => {
    prisma.smsMessage.findMany.mockResolvedValue([]);
    prisma.smsMessage.count.mockResolvedValue(0);

    const app = makeApp({ tenantId: 99 });
    const res = await request(app)
      .get('/api/sms/messages?direction=OUTBOUND&status=SENT');

    expect(res.status).toBe(200);
    expect(prisma.smsMessage.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.smsMessage.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(99);
    expect(args.where.direction).toBe('OUTBOUND');
    expect(args.where.status).toBe('SENT');
  });

  test('excludes OTP-matching rows from the response body', async () => {
    // Mix: 2 real messages + 2 OTP messages. Staff inbox must show only the
    // 2 real ones.
    prisma.smsMessage.findMany.mockResolvedValue([
      { id: 1, body: 'Your appointment is confirmed for tomorrow.', createdAt: new Date(), contact: null },
      { id: 2, body: 'Your verification code is 482910', createdAt: new Date(), contact: null },
      { id: 3, body: 'Hello, how can we help?', createdAt: new Date(), contact: null },
      { id: 4, body: 'Your OTP is: 123456', createdAt: new Date(), contact: null },
    ]);
    prisma.smsMessage.count.mockResolvedValue(4);

    const app = makeApp();
    const res = await request(app).get('/api/sms/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    const bodies = res.body.messages.map(m => m.body);
    // OTP messages must not be in the response at all.
    expect(bodies.every(b => !/verification code|otp/i.test(b))).toBe(true);
  });
});

// ─── Templates CRUD ─────────────────────────────────────────────────

describe('POST /templates — validation', () => {
  test('400 when name or body is missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/sms/templates')
      .send({ name: 'AppointmentReminder' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name and body are required/i);
  });

  test('persists template with tenantId + default category=TRANSACTIONAL', async () => {
    prisma.smsTemplate.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 333, ...data })
    );

    const app = makeApp({ tenantId: 5 });
    const res = await request(app)
      .post('/api/sms/templates')
      .send({ name: 'Reminder', body: 'See you at {{name}}' });

    expect(res.status).toBe(201);
    const createArgs = prisma.smsTemplate.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(5);
    expect(createArgs.data.category).toBe('TRANSACTIONAL');
  });
});

describe('PUT /templates/:id — tenant isolation', () => {
  test('404 when template is in another tenant (tenantId filter pinned)', async () => {
    // findFirst returns null because the tenant filter excludes the template.
    prisma.smsTemplate.findFirst.mockResolvedValue(null);

    const app = makeApp({ tenantId: 1 });
    const res = await request(app)
      .put('/api/sms/templates/999')
      .send({ name: 'try-cross-tenant-update' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Template not found/i);
    // The existence check WAS run with tenantId in the filter — pin it.
    const findArgs = prisma.smsTemplate.findFirst.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(1);
  });
});

// ─── GET /config — ADMIN gate + masking (#651) ──────────────────────

describe('GET /config — admin-only + masked credentials (#651)', () => {
  test('role=USER → 403 RBAC_DENIED', async () => {
    const app = makeApp({ role: 'USER' });
    const res = await request(app).get('/api/sms/config');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    // Never reached prisma.
    expect(prisma.smsConfig.findMany).not.toHaveBeenCalled();
  });

  test('returns masked {configured,last4} shape for apiKey + authToken', async () => {
    prisma.smsConfig.findMany.mockResolvedValue([
      {
        id: 1,
        provider: 'msg91',
        apiKey: 'super-secret-plaintext-credential-a3f1',
        authToken: 'twilio-auth-token-1234',
        senderId: 'GLBUSS',
        dltEntityId: null,
        isActive: true,
        tenantId: 1,
      },
    ]);

    const app = makeApp({ role: 'ADMIN' });
    const res = await request(app).get('/api/sms/config');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].provider).toBe('msg91');
    // Plaintext NEVER round-trips — apiKey is the {configured,last4} shape.
    expect(typeof res.body[0].apiKey).toBe('object');
    expect(res.body[0].apiKey.configured).toBe(true);
    expect(res.body[0].apiKey.last4).toMatch(/^\*\*\*\*/);
    expect(res.body[0].authToken.configured).toBe(true);
    // Non-secret fields pass through verbatim.
    expect(res.body[0].senderId).toBe('GLBUSS');
  });
});

// ─── PUT /config/:provider — MSG91 senderId length (#716) ───────────

describe('PUT /config/:provider — #716 MSG91 senderId length', () => {
  test('rejects 20-char senderId with INVALID_SENDER_ID_LENGTH', async () => {
    const app = makeApp({ role: 'ADMIN' });
    const res = await request(app)
      .put('/api/sms/config/msg91')
      .send({
        senderId: 'WAY-TOO-LONG-SENDERID', // 21 chars
        apiKey: 'fresh-plaintext-key',
        isActive: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SENDER_ID_LENGTH');
    // Never reached prisma.
    expect(prisma.smsConfig.upsert).not.toHaveBeenCalled();
  });
});

// ─── POST /webhook/:provider — no auth, status-mapping ──────────────

describe('POST /webhook/:provider — public, no auth', () => {
  test('twilio delivery-status payload updates smsMessage by providerMsgId + responds TwiML', async () => {
    prisma.smsMessage.updateMany.mockResolvedValue({ count: 1 });

    // Webhook is mounted under the same router but has NO authed user; the
    // makeApp injector sets req.user anyway — the handler ignores it since
    // there's no verifyToken on this route.
    const app = makeApp();
    const res = await request(app)
      .post('/api/sms/webhook/twilio')
      .send({
        MessageSid: 'SMabc123',
        MessageStatus: 'delivered',
      });

    expect(res.status).toBe(200);
    // TwiML response — Content-Type is text/xml.
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(prisma.smsMessage.updateMany).toHaveBeenCalledTimes(1);
    const updArgs = prisma.smsMessage.updateMany.mock.calls[0][0];
    expect(updArgs.where.providerMsgId).toBe('SMabc123');
    expect(updArgs.data.status).toBe('DELIVERED');
  });

  test('unknown provider → 400 "Unknown provider"', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/sms/webhook/some-random-provider')
      .send({ foo: 'bar' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown provider/i);
  });
});
