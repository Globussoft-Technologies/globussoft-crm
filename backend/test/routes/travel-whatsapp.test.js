/**
 * travel-whatsapp.test.js — vitest contract pin for
 * backend/routes/travel_whatsapp.js (Q9 — travel 2-way WhatsApp chat,
 * Wati transport).
 *
 * Endpoints pinned:
 *   GET  /api/travel/whatsapp/status   — { enabled, channelNumber } (masked)
 *   POST /api/travel/whatsapp/send     — session text + template send via
 *                                        watiClient; thread upsert; opt-out
 *                                        gate (422 CONTACT_OPTED_OUT);
 *                                        201 { success, status, thread }
 *   GET  /api/travel/whatsapp/webhook  — 200 echo (Wati URL verification)
 *   POST /api/travel/whatsapp/webhook  — inbound ingest: thread upsert
 *                                        (unread semantics mirror the Meta
 *                                        webhook), INBOUND row, socket emit
 *                                        "whatsapp:received"; DELIVERED/READ/
 *                                        FAILED receipts via providerMsgId
 *                                        (FAILED persists failedDetail as
 *                                        errorMessage); token guard via
 *                                        WATI_WEBHOOK_TOKEN.
 *   POST /api/travel/whatsapp/sync     — outbound delivery-state
 *                                        reconciliation: Wati getMessages
 *                                        statusString/failedDetail adopted
 *                                        onto OUTBOUND rows by providerMsgId,
 *                                        rank-guarded (never downgrades),
 *                                        "whatsapp:status" emit per change.
 *
 * Harness mirrors travel-cancellation-policies.test.js — patch the prisma
 * singleton BEFORE requiring the router; real HS256 JWTs so the full
 * verifyToken + requireTravelTenant guard stack runs. watiClient is left
 * REAL: under NODE_ENV=test it is hard-wired to stub mode (no network), so
 * the suite also pins the stub QUEUED contract the UI banner relies on.
 *
 * Wellness/generic isolation note: nothing here touches routes/whatsapp.js
 * or whatsapp_webhook.js — the travel router is a separate file with its
 * own mount.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.whatsAppOptOut = { findFirst: vi.fn() };
prisma.whatsAppThread = {
  upsert: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
};
prisma.whatsAppMessage = {
  ...(prisma.whatsAppMessage || {}),
  create: vi.fn(),
  updateMany: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
};
prisma.contact = { ...(prisma.contact || {}), findFirst: vi.fn() };
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.tenant.findFirst = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const router = requireCJS('../../routes/travel_whatsapp');
// Same CJS module instance the router holds — spies on it intercept the
// router's calls (watiClient's documented self-mocking seam).
const watiClient = requireCJS('../../services/watiClient');

// Captured socket emits — the fake req.io mirror of server.js's injection.
let emits = [];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.io = { to: (room) => ({ emit: (ev, payload) => emits.push({ room, ev, payload }) }) };
    next();
  });
  app.use('/api/travel', router);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 3 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const TRAVEL_TENANT = { id: 3, vertical: 'travel', name: 'Travel Stall', slug: 'travel-stall', isActive: true };
const THREAD = { id: 11, tenantId: 3, contactPhone: '+919811111102', status: 'OPEN', unreadCount: 0, assignedToId: null, contactId: null };

beforeEach(() => {
  emits = [];
  prisma.whatsAppOptOut.findFirst.mockReset().mockResolvedValue(null);
  prisma.whatsAppThread.upsert.mockReset().mockResolvedValue(THREAD);
  prisma.whatsAppThread.findUnique.mockReset().mockResolvedValue(null);
  prisma.whatsAppThread.update.mockReset().mockResolvedValue(THREAD);
  prisma.whatsAppThread.create.mockReset().mockResolvedValue({ ...THREAD, unreadCount: 1 });
  prisma.whatsAppMessage.create.mockReset().mockResolvedValue({ id: 991 });
  prisma.whatsAppMessage.updateMany.mockReset().mockResolvedValue({ count: 1 });
  prisma.whatsAppMessage.findFirst.mockReset().mockResolvedValue(null);
  prisma.whatsAppMessage.update.mockReset().mockResolvedValue({ id: 47 });
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.tenant.findUnique.mockReset().mockResolvedValue(TRAVEL_TENANT);
  prisma.tenant.findFirst.mockReset().mockResolvedValue(TRAVEL_TENANT);
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  delete process.env.WATI_WEBHOOK_TOKEN;
});

afterEach(() => {
  delete process.env.WATI_WEBHOOK_TOKEN;
});

// ─── GET /whatsapp/status ───────────────────────────────────────────

describe('GET /api/travel/whatsapp/status', () => {
  test('1. returns stub state under test env (enabled:false)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/whatsapp/status')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  test('2. requires auth (401 without token)', async () => {
    const res = await request(makeApp()).get('/api/travel/whatsapp/status');
    expect(res.status).toBe(401);
  });

  test('3. non-travel tenant bounced by requireTravelTenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ ...TRAVEL_TENANT, vertical: 'generic' });
    const res = await request(makeApp())
      .get('/api/travel/whatsapp/status')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(403);
  });
});

// ─── POST /whatsapp/send ────────────────────────────────────────────

describe('POST /api/travel/whatsapp/send', () => {
  test('4. missing to → 400 MISSING_TO', async () => {
    const res = await request(makeApp())
      .post('/api/travel/whatsapp/send')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ body: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_TO');
  });

  test('5. missing body AND templateName → 400 MISSING_BODY', async () => {
    const res = await request(makeApp())
      .post('/api/travel/whatsapp/send')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ to: '919811111102' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_BODY');
  });

  test('6. opted-out contact → 422 CONTACT_OPTED_OUT, no thread upsert', async () => {
    prisma.whatsAppOptOut.findFirst.mockResolvedValue({ id: 5 });
    const res = await request(makeApp())
      .post('/api/travel/whatsapp/send')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ to: '919811111102', body: 'hi' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CONTACT_OPTED_OUT');
    expect(prisma.whatsAppThread.upsert).not.toHaveBeenCalled();
  });

  test('7. session text happy path → 201 QUEUED (stub) + thread-linked row', async () => {
    const res = await request(makeApp())
      .post('/api/travel/whatsapp/send')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ to: '98111 11102', body: 'hello from travel chat' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('QUEUED'); // stub mode under NODE_ENV=test
    expect(res.body.stub).toBe(true);
    expect(res.body.thread).toMatchObject({ id: 11 });

    // Thread keyed on E.164 form + tenant from the guard.
    const upsertArg = prisma.whatsAppThread.upsert.mock.calls[0][0];
    expect(upsertArg.where.tenantId_contactPhone).toEqual({
      tenantId: 3,
      contactPhone: '+919811111102',
    });

    // Single message row, linked to the thread + sender, E.164 `to`.
    expect(prisma.whatsAppMessage.create).toHaveBeenCalledTimes(1);
    const msgData = prisma.whatsAppMessage.create.mock.calls[0][0].data;
    expect(msgData).toMatchObject({
      to: '+919811111102',
      direction: 'OUTBOUND',
      status: 'QUEUED',
      body: 'hello from travel chat',
      tenantId: 3,
      threadId: 11,
      userId: 7,
    });
  });

  test('8. template path persists templateName on the row', async () => {
    const res = await request(makeApp())
      .post('/api/travel/whatsapp/send')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ to: '919811111102', templateName: 'journey_reminder', parameters: ['Ahmed', 'Goa'] });
    expect(res.status).toBe(201);
    const msgData = prisma.whatsAppMessage.create.mock.calls[0][0].data;
    expect(msgData.templateName).toBe('journey_reminder');
    expect(msgData.threadId).toBe(11);
  });

  test('9. contact match links contactId on thread create + message row', async () => {
    prisma.contact.findFirst.mockResolvedValue({ id: 65, name: 'Ahmed Khan' });
    await request(makeApp())
      .post('/api/travel/whatsapp/send')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ to: '919811111102', body: 'hi' });
    const upsertArg = prisma.whatsAppThread.upsert.mock.calls[0][0];
    expect(upsertArg.create.contactId).toBe(65);
    const msgData = prisma.whatsAppMessage.create.mock.calls[0][0].data;
    expect(msgData.contactId).toBe(65);
  });
});

// ─── GET /whatsapp/templates + POST /whatsapp/sync ─────────────────

describe('GET /api/travel/whatsapp/templates', () => {
  test('18. stub mode returns empty mapped list with stub:true', async () => {
    const res = await request(makeApp())
      .get('/api/travel/whatsapp/templates')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ templates: [], stub: true });
  });
});

describe('POST /api/travel/whatsapp/sync', () => {
  test('19. stub mode short-circuits (no Wati pull attempted)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/whatsapp/sync')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ synced: false, reason: 'stub-mode' });
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });
});

// ─── Sync outbound delivery-state reconciliation ────────────────────
// The send path stamps SENT when Wati's HTTP API accepts the call, but
// Meta can reject asynchronously (live-confirmed 2026-06-12: "(#131037)
// display name approval" failed every send while the UI showed a grey
// SENT tick). The sync must adopt getMessages' statusString/failedDetail.

describe('POST /api/travel/whatsapp/sync — outbound status reconciliation', () => {
  const FAIL_DETAIL =
    '(#131037) WhatsApp provided number needs display name approval before message can be sent.';

  function outboundItem(overrides = {}) {
    return {
      id: '6a2bb9c00e16a58679f56ae4',
      eventType: 'message',
      type: 'text',
      text: 'hello',
      owner: true,
      statusString: 'FAILED',
      failedDetail: FAIL_DETAIL,
      created: '2026-06-12T07:48:16.823Z',
      ...overrides,
    };
  }

  function primeWati(items) {
    vi.spyOn(watiClient, 'isEnabled').mockReturnValue(true);
    vi.spyOn(watiClient, 'getContacts').mockResolvedValue({
      stub: false,
      contacts: [{ wAid: '916200039874' }],
    });
    vi.spyOn(watiClient, 'getMessages').mockResolvedValue({ stub: false, items });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('20. FAILED statusString flips a SENT row to FAILED + errorMessage + whatsapp:status emit', async () => {
    primeWati([outboundItem()]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ id: 47, status: 'SENT', threadId: 11 });

    const res = await request(makeApp())
      .post('/api/travel/whatsapp/sync?force=1')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(true);
    expect(res.body.statusUpdates).toBe(1);

    // Row matched by providerMsgId, scoped to OUTBOUND + tenant.
    const findArg = prisma.whatsAppMessage.findFirst.mock.calls[0][0];
    expect(findArg.where).toMatchObject({
      tenantId: 3,
      providerMsgId: '6a2bb9c00e16a58679f56ae4',
      direction: 'OUTBOUND',
    });

    const upd = prisma.whatsAppMessage.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 47 });
    expect(upd.data.status).toBe('FAILED');
    expect(upd.data.errorMessage).toMatch(/131037/);

    const statusEmit = emits.find((e) => e.ev === 'whatsapp:status');
    expect(statusEmit.room).toBe('tenant:3');
    expect(statusEmit.payload).toMatchObject({
      tenantId: 3,
      threadId: 11,
      status: 'FAILED',
      errorMessage: FAIL_DETAIL,
    });
  });

  test('21. never downgrades — READ row ignores a DELIVERED statusString', async () => {
    primeWati([outboundItem({ statusString: 'DELIVERED', failedDetail: null })]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ id: 47, status: 'READ', threadId: 11 });

    const res = await request(makeApp())
      .post('/api/travel/whatsapp/sync?force=1')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.statusUpdates).toBe(0);
    expect(prisma.whatsAppMessage.update).not.toHaveBeenCalled();
    expect(emits.find((e) => e.ev === 'whatsapp:status')).toBeUndefined();
  });

  test('22. unknown providerMsgId is skipped without writes', async () => {
    primeWati([outboundItem()]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/whatsapp/sync?force=1')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.statusUpdates).toBe(0);
    expect(prisma.whatsAppMessage.update).not.toHaveBeenCalled();
  });

  test('23. DELIVERED statusString advances a SENT row (no errorMessage written)', async () => {
    primeWati([outboundItem({ statusString: 'DELIVERED', failedDetail: null })]);
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ id: 47, status: 'SENT', threadId: 11 });

    const res = await request(makeApp())
      .post('/api/travel/whatsapp/sync?force=1')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.body.statusUpdates).toBe(1);
    const upd = prisma.whatsAppMessage.update.mock.calls[0][0];
    expect(upd.data.status).toBe('DELIVERED');
    expect(upd.data.errorMessage).toBeUndefined();
  });
});

// ─── Wati webhook ───────────────────────────────────────────────────

describe('GET /api/travel/whatsapp/webhook', () => {
  test('10. open echo for Wati URL verification', async () => {
    const res = await request(makeApp()).get('/api/travel/whatsapp/webhook');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/travel/whatsapp/webhook', () => {
  const INBOUND = {
    eventType: 'message',
    owner: false,
    waId: '919811111102',
    text: 'salaam, is the Umrah package still available?',
    id: 'wati-msg-abc',
    type: 'text',
    senderName: 'Ahmed Khan',
  };

  test('11. inbound message → new thread (unread 1) + INBOUND row + whatsapp:received emit', async () => {
    const res = await request(makeApp())
      .post('/api/travel/whatsapp/webhook?tenantId=3')
      .send(INBOUND);
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.threadId).toBe(11);

    const createArg = prisma.whatsAppThread.create.mock.calls[0][0].data;
    expect(createArg).toMatchObject({
      tenantId: 3,
      contactPhone: '+919811111102',
      unreadCount: 1,
      status: 'OPEN',
    });

    const msgData = prisma.whatsAppMessage.create.mock.calls[0][0].data;
    expect(msgData).toMatchObject({
      from: '+919811111102',
      direction: 'INBOUND',
      status: 'DELIVERED',
      body: INBOUND.text,
      providerMsgId: 'wati-msg-abc',
      tenantId: 3,
      threadId: 11,
    });

    expect(emits).toHaveLength(1);
    expect(emits[0].room).toBe('tenant:3');
    expect(emits[0].ev).toBe('whatsapp:received');
    expect(emits[0].payload).toMatchObject({ tenantId: 3, threadId: 11, contactPhone: '+919811111102' });
  });

  test('12. inbound on existing ASSIGNED thread does NOT bump unreadCount', async () => {
    prisma.whatsAppThread.findUnique.mockResolvedValue({ ...THREAD, assignedToId: 42, unreadCount: 0 });
    await request(makeApp())
      .post('/api/travel/whatsapp/webhook?tenantId=3')
      .send(INBOUND);
    const updateArg = prisma.whatsAppThread.update.mock.calls[0][0].data;
    expect(updateArg.unreadCount).toBeUndefined();
    expect(updateArg.status).toBe('OPEN');
  });

  test('13. owner:true echo events are ignored (already persisted at send time)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/whatsapp/webhook?tenantId=3')
      .send({ ...INBOUND, owner: true, eventType: 'sessionMessageSent' });
    expect(res.status).toBe(200);
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
    expect(emits).toHaveLength(0);
  });

  test('14. DELIVERED receipt updates row by providerMsgId + whatsapp:status emit', async () => {
    const res = await request(makeApp())
      .post('/api/travel/whatsapp/webhook?tenantId=3')
      .send({ eventType: 'sentMessageDELIVERED', whatsappMessageId: 'wamid-9' });
    expect(res.status).toBe(200);
    const arg = prisma.whatsAppMessage.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ tenantId: 3, providerMsgId: 'wamid-9' });
    expect(arg.data.status).toBe('DELIVERED');
    expect(emits[0].ev).toBe('whatsapp:status');
    expect(emits[0].payload.status).toBe('DELIVERED');
  });

  test('15. READ receipt maps to READ status', async () => {
    await request(makeApp())
      .post('/api/travel/whatsapp/webhook?tenantId=3')
      .send({ eventType: 'sentMessageREAD', whatsappMessageId: 'wamid-9' });
    expect(prisma.whatsAppMessage.updateMany.mock.calls[0][0].data.status).toBe('READ');
  });

  test('15b. FAILED receipt maps to FAILED + persists failedDetail as errorMessage', async () => {
    const res = await request(makeApp())
      .post('/api/travel/whatsapp/webhook?tenantId=3')
      .send({
        eventType: 'sentMessageFAILED',
        whatsappMessageId: 'wamid-9',
        failedDetail: '(#131037) WhatsApp provided number needs display name approval before message can be sent.',
      });
    expect(res.status).toBe(200);
    const arg = prisma.whatsAppMessage.updateMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ tenantId: 3, providerMsgId: 'wamid-9' });
    expect(arg.data.status).toBe('FAILED');
    expect(arg.data.errorMessage).toMatch(/131037/);
    expect(emits[0].ev).toBe('whatsapp:status');
    expect(emits[0].payload).toMatchObject({ status: 'FAILED' });
    expect(emits[0].payload.errorMessage).toMatch(/display name approval/);
  });

  test('16. token guard: WATI_WEBHOOK_TOKEN set + wrong token → 401; right token → 200', async () => {
    process.env.WATI_WEBHOOK_TOKEN = 'sekret';
    const bad = await request(makeApp())
      .post('/api/travel/whatsapp/webhook?tenantId=3&token=wrong')
      .send(INBOUND);
    expect(bad.status).toBe(401);

    const good = await request(makeApp())
      .post('/api/travel/whatsapp/webhook?tenantId=3&token=sekret')
      .send(INBOUND);
    expect(good.status).toBe(200);
    expect(good.body.received).toBe(true);
  });

  test('17. no resolvable travel tenant → event dropped gracefully (still 200)', async () => {
    prisma.tenant.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/whatsapp/webhook')
      .send(INBOUND);
    expect(res.status).toBe(200);
    expect(res.body.dropped).toBe(true);
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });
});
