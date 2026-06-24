/**
 * whatsappWebClient.test.js — vitest contract pin for
 * backend/services/whatsappWebClient.js (Q9 — WhatsApp Web (QR-scan) travel
 * transport that replaced the Wati REST client).
 *
 * Under NODE_ENV=test the module NEVER launches a browser (canLaunch()=false),
 * so every send hard-stubs (QUEUED row + log) and connect() records a
 * DISCONNECTED stub session. That keeps CI offline + deterministic — exactly
 * the same discipline watiClient.test.js pins for the old transport.
 *
 * Pinned:
 *   - phone helpers (normalizePhone / toChatId / fromChatId)
 *   - isEnabled / getState / getConfig stub semantics
 *   - connect()/disconnect() never launch under test
 *   - send* stub envelopes + persisted-row shape (incl. templateName carry)
 *   - getMessageTemplates / getContacts / getMessages stub shapes
 *   - mapAck enum mapping
 *   - ingestInbound: INBOUND row + thread upsert + whatsapp:received emit
 *   - applyAck: rank-guarded status advance + whatsapp:status emit
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Patch the prisma singleton BEFORE the SUT lazily require()s it.
prisma.whatsAppMessage = {
  ...(prisma.whatsAppMessage || {}),
  create: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
};
prisma.whatsAppThread = {
  ...(prisma.whatsAppThread || {}),
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
};
prisma.contact = { ...(prisma.contact || {}), findFirst: vi.fn() };

const wa = requireCJS('../../services/whatsappWebClient');

const TENANT = 3;
let emits = [];

beforeEach(() => {
  emits = [];
  prisma.whatsAppMessage.create.mockReset().mockResolvedValue({ id: 991 });
  prisma.whatsAppMessage.findFirst.mockReset().mockResolvedValue(null);
  prisma.whatsAppMessage.update.mockReset().mockResolvedValue({ id: 47 });
  prisma.whatsAppThread.findUnique.mockReset().mockResolvedValue(null);
  prisma.whatsAppThread.update.mockReset().mockResolvedValue({ id: 11 });
  prisma.whatsAppThread.create.mockReset().mockResolvedValue({ id: 11, unreadCount: 1 });
  prisma.whatsAppMessage.deleteMany.mockReset().mockResolvedValue({ count: 6 });
  prisma.whatsAppThread.deleteMany.mockReset().mockResolvedValue({ count: 2 });
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  // Fake socket so emit-bearing paths are observable.
  wa.init({ to: (room) => ({ emit: (ev, payload) => emits.push({ room, ev, payload }) }) });
});

describe('phone helpers', () => {
  test('normalizePhone adds 91 for bare 10-digit, strips non-digits', () => {
    expect(wa.normalizePhone('9811111102')).toBe('919811111102');
    expect(wa.normalizePhone('+91 98111-11102')).toBe('919811111102');
    expect(wa.normalizePhone('')).toBeNull();
  });
  test('toChatId / fromChatId round-trip', () => {
    expect(wa.toChatId('9811111102')).toBe('919811111102@c.us');
    expect(wa.fromChatId('919811111102@c.us')).toBe('919811111102');
  });
});

describe('chat classification (@c.us + @lid are 1:1; groups/channels excluded)', () => {
  test('chatAddressKind maps the address spaces', () => {
    expect(wa.chatAddressKind('919811111102@c.us')).toBe('c.us');
    expect(wa.chatAddressKind('103946932773095@lid')).toBe('lid');
    expect(wa.chatAddressKind('120363156588550165@g.us')).toBe('group');
    expect(wa.chatAddressKind('120363156588550165@newsletter')).toBe('newsletter');
    expect(wa.chatAddressKind('status@broadcast')).toBe('broadcast');
  });
  test('isIndividualChatId accepts @c.us AND @lid only', () => {
    expect(wa.isIndividualChatId('919811111102@c.us')).toBe(true);
    expect(wa.isIndividualChatId('103946932773095@lid')).toBe(true);
    expect(wa.isIndividualChatId('120363156588550165@g.us')).toBe(false);
    expect(wa.isIndividualChatId('120363156588550165@newsletter')).toBe(false);
    expect(wa.isIndividualChatId('status@broadcast')).toBe(false);
  });
  test('resolveIndividual: @c.us derives the number from the id', async () => {
    const r = await wa.resolveIndividual({}, '919811111102@c.us');
    expect(r).toMatchObject({ phone: '+919811111102', key: '+919811111102' });
  });
  test('resolveIndividual: @lid resolves real phone via getContactLidAndPhone', async () => {
    const client = {
      getContactLidAndPhone: async () => [{ lid: '103946932773095@lid', phone: '919812345678@c.us' }],
      getContactById: async () => ({ name: 'Aisha', pushname: 'Aisha' }),
    };
    const r = await wa.resolveIndividual(client, '103946932773095@lid');
    expect(r.phone).toBe('+919812345678');
    expect(r.name).toBe('Aisha');
    expect(r.key).toBe('+919812345678');
  });
  test('resolveIndividual: unresolvable @lid falls back to a stable lid key', async () => {
    const client = { getContactById: async () => null };
    const r = await wa.resolveIndividual(client, '103946932773095@lid');
    expect(r.phone).toBeNull();
    expect(r.key).toBe('lid:103946932773095');
  });
});

describe('stub semantics under test env', () => {
  test('isEnabled is false (no tenant / not connected)', () => {
    expect(wa.isEnabled(TENANT)).toBe(false);
    expect(wa.isEnabled()).toBe(false);
  });
  test('getState for unknown tenant is DISCONNECTED', () => {
    expect(wa.getState(999)).toMatchObject({ state: 'DISCONNECTED', connected: false });
  });
  test('connect() never launches a browser under test → DISCONNECTED stub', async () => {
    const st = await wa.connect(TENANT);
    expect(st.connected).toBe(false);
    expect(st.state).toBe('DISCONNECTED');
    await wa.disconnect(TENANT);
  });
  test('disconnect() returns DISCONNECTED', async () => {
    const st = await wa.disconnect(TENANT);
    expect(st).toMatchObject({ connected: false, state: 'DISCONNECTED' });
  });
});

describe('send surface (stub → QUEUED + persisted row)', () => {
  test('sendSessionMessage persists a QUEUED OUTBOUND row', async () => {
    const out = await wa.sendSessionMessage({ tenantId: TENANT, toPhone: '9811111102', text: 'hi', threadId: 11, userId: 7 });
    expect(out).toMatchObject({ stub: true, sent: false, status: 'QUEUED' });
    const data = prisma.whatsAppMessage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ direction: 'OUTBOUND', status: 'QUEUED', body: 'hi', tenantId: 3, threadId: 11, userId: 7 });
  });

  test('sendSessionMessage WITHOUT a threadId ensures a thread and links the message', async () => {
    // No caller-supplied threadId (the quote/share path) → the send must
    // create/resolve a conversation thread so it shows in the Threads inbox.
    prisma.whatsAppThread.findUnique.mockResolvedValue(null); // no prior thread
    prisma.whatsAppThread.create.mockResolvedValue({ id: 55, unreadCount: 0 });
    const out = await wa.sendSessionMessage({ tenantId: TENANT, toPhone: '9811111103', text: 'your quote' });
    expect(out.status).toBe('QUEUED');
    expect(prisma.whatsAppThread.create).toHaveBeenCalled();
    const data = prisma.whatsAppMessage.create.mock.calls.at(-1)[0].data;
    expect(data).toMatchObject({ direction: 'OUTBOUND', threadId: 55 });
  });

  test('sendTemplateMessage carries templateName onto the row + renders bodyPreview', async () => {
    const out = await wa.sendTemplateMessage({
      tenantId: TENANT, toPhone: '9811111102', templateName: 'journey_reminder',
      parameters: [{ name: 'name', value: 'Ahmed' }], bodyPreview: 'Hi Ahmed, your trip is soon',
    });
    expect(out.status).toBe('QUEUED');
    const data = prisma.whatsAppMessage.create.mock.calls[0][0].data;
    expect(data.templateName).toBe('journey_reminder');
    expect(data.body).toBe('Hi Ahmed, your trip is soon');
  });

  test('sendBestEffort sends fallbackText (no template gate on WhatsApp Web)', async () => {
    const out = await wa.sendBestEffort({ tenantId: TENANT, toPhone: '9811111102', templateName: 'x', fallbackText: 'plain body' });
    expect(out.status).toBe('QUEUED');
    expect(prisma.whatsAppMessage.create.mock.calls[0][0].data.body).toBe('plain body');
  });

  test('sendSessionFile persists QUEUED row with media metadata', async () => {
    const out = await wa.sendSessionFile({
      tenantId: TENANT, toPhone: '9811111102', buffer: Buffer.from('xx'),
      filename: 'a.jpg', mimeType: 'image/jpeg', caption: 'pic', mediaUrl: '/uploads/x.jpg',
    });
    expect(out.status).toBe('QUEUED');
    const data = prisma.whatsAppMessage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ direction: 'OUTBOUND', mediaUrl: '/uploads/x.jpg', mediaType: 'image/jpeg', metaType: 'image' });
  });
});

describe('read surface stubs', () => {
  test('getMessageTemplates is empty (WhatsApp Web has no template catalogue)', async () => {
    await expect(wa.getMessageTemplates()).resolves.toEqual({ stub: true, templates: [] });
  });
  test('getContacts / getMessages return empty when not connected', async () => {
    await expect(wa.getContacts({ tenantId: TENANT })).resolves.toEqual({ stub: true, contacts: [] });
    await expect(wa.getMessages({ tenantId: TENANT, whatsappNumber: '9811111102' })).resolves.toEqual({ stub: true, items: [] });
  });
});

describe('ack mapping', () => {
  test('mapAck covers the WhatsApp ack ladder', () => {
    expect(wa.mapAck(-1)).toBe('FAILED');
    expect(wa.mapAck(1)).toBe('SENT');
    expect(wa.mapAck(2)).toBe('DELIVERED');
    expect(wa.mapAck(3)).toBe('READ');
    expect(wa.mapAck(4)).toBe('READ');
    expect(wa.mapAck(0)).toBeNull();
  });

  test('applyAck advances a SENT row to READ + emits whatsapp:status', async () => {
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ id: 47, status: 'SENT', threadId: 11 });
    await wa.applyAck(TENANT, { id: { _serialized: 'wamid-1' } }, 3);
    expect(prisma.whatsAppMessage.update.mock.calls[0][0].data.status).toBe('READ');
    const emit = emits.find((e) => e.ev === 'whatsapp:status');
    expect(emit.payload).toMatchObject({ status: 'READ', providerMsgId: 'wamid-1' });
  });

  test('applyAck never downgrades (READ row ignores DELIVERED ack)', async () => {
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ id: 47, status: 'READ', threadId: 11 });
    await wa.applyAck(TENANT, { id: { _serialized: 'wamid-1' } }, 2);
    expect(prisma.whatsAppMessage.update).not.toHaveBeenCalled();
  });
});

describe('purgeChats (disconnect clears the mirror)', () => {
  test('deletes all messages then threads for the tenant', async () => {
    const out = await wa.purgeChats(TENANT);
    expect(prisma.whatsAppMessage.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 3 } });
    expect(prisma.whatsAppThread.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 3 } });
    expect(out).toEqual({ threads: 2, messages: 6 });
  });
});

describe('contactName fallback (stale Prisma client)', () => {
  test('thread create retries without contactName when the column is unknown', async () => {
    // Simulate a client that doesn't know the new column yet.
    prisma.whatsAppThread.create
      .mockReset()
      .mockRejectedValueOnce(new Error("Unknown argument `contactName`. Available options are..."))
      .mockResolvedValueOnce({ id: 11, unreadCount: 1 });
    prisma.whatsAppThread.findUnique.mockResolvedValue(null);
    const out = await wa.ingestInbound(TENANT, {
      fromMe: false, from: '919811111102@c.us', body: 'hi', id: { _serialized: 'wamid-x' }, type: 'chat', hasMedia: false,
      _data: { notifyName: 'Ahmed' },
    });
    expect(out).toMatchObject({ threadId: 11 });
    // Two attempts: first with contactName (rejected), then without.
    expect(prisma.whatsAppThread.create).toHaveBeenCalledTimes(2);
    expect('contactName' in prisma.whatsAppThread.create.mock.calls[0][0].data).toBe(true);
    expect('contactName' in prisma.whatsAppThread.create.mock.calls[1][0].data).toBe(false);
  });
});

describe('shutdown (graceful teardown so the auth store flushes — prevents "logged out on restart")', () => {
  test('destroys every live client, suppresses auto-reconnect, and does NOT wipe the dir', async () => {
    // connect() under test records a DISCONNECTED stub session; promote it to a
    // fake "live" session with a destroyable client to exercise shutdown.
    await wa.connect(TENANT);
    const destroy = vi.fn().mockResolvedValue(undefined);
    const s = wa.getSession(TENANT);
    s.client = { destroy };
    s.state = 'CONNECTED';

    const out = await wa.shutdown();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(s.manualClose).toBe(true); // disconnect event must NOT auto-reconnect
    expect(out.closed).toBe(1);
  });

  test('a hung client.destroy is time-boxed, never blocking shutdown', async () => {
    await wa.connect(TENANT);
    const s = wa.getSession(TENANT);
    s.client = { destroy: () => new Promise(() => {}) }; // never resolves
    s.state = 'CONNECTED';
    // perClientTimeoutMs short so the test is fast; shutdown still resolves.
    await expect(wa.shutdown({ perClientTimeoutMs: 20 })).resolves.toEqual({ closed: 1 });
    // Drop the never-resolving client so it can't stall later teardown paths.
    s.client = null;
  });

  test('shutdown is safe with no destroyable clients (returns a count)', async () => {
    // Stub sessions (client:null) are skipped — shutdown stays fast + resolves.
    const out = await wa.shutdown();
    expect(out).toHaveProperty('closed');
  });
});

describe('isPuppeteerTeardownError (crash guard only swallows benign puppeteer teardown noise)', () => {
  test('classifies the real "detached Frame" crash as a teardown error', () => {
    const err = new Error("Attempted to use detached Frame '2352BF3D'.");
    err.stack = `${err.message}\n    at Client.inject (.../whatsapp-web.js/src/Client.js:126:38)`;
    expect(wa.isPuppeteerTeardownError(err)).toBe(true);
  });

  test('classifies "Target closed" / "Session closed" as teardown errors', () => {
    expect(wa.isPuppeteerTeardownError(new Error('Protocol error: Target closed'))).toBe(true);
    expect(wa.isPuppeteerTeardownError(new Error('Session closed. Most likely the page has been closed.'))).toBe(true);
  });

  test('does NOT swallow a genuine application error (must still crash)', () => {
    expect(wa.isPuppeteerTeardownError(new Error('Cannot read properties of undefined (reading id)'))).toBe(false);
    expect(wa.isPuppeteerTeardownError(new Error('ECONNREFUSED 127.0.0.1:3306'))).toBe(false);
    expect(wa.isPuppeteerTeardownError(null)).toBe(false);
  });
});

describe('clearStaleLocks (recover a session locked by an unclean restart)', () => {
  const fs = requireCJS('fs');
  const pathMod = requireCJS('path');
  const AUTH_DIR = pathMod.join(__dirname, '..', '..', '.wwebjs_auth');
  const LOCK_TENANT = 9421; // unlikely to collide with a real linked session
  const dir = pathMod.join(AUTH_DIR, `session-travel-${LOCK_TENANT}`);

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('removes stale Chromium singleton locks but KEEPS the session data', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pathMod.join(dir, 'SingletonLock'), 'x');
    fs.writeFileSync(pathMod.join(dir, 'SingletonCookie'), 'x');
    fs.writeFileSync(pathMod.join(dir, 'DevToolsActivePort'), '1234');
    // Real session payload that MUST survive the cleanup.
    fs.mkdirSync(pathMod.join(dir, 'Default'), { recursive: true });
    fs.writeFileSync(pathMod.join(dir, 'Default', 'session.json'), '{"creds":1}');

    wa.clearStaleLocks(LOCK_TENANT);

    expect(fs.existsSync(pathMod.join(dir, 'SingletonLock'))).toBe(false);
    expect(fs.existsSync(pathMod.join(dir, 'SingletonCookie'))).toBe(false);
    expect(fs.existsSync(pathMod.join(dir, 'DevToolsActivePort'))).toBe(false);
    // The actual saved session is untouched → next connect resumes, no QR.
    expect(fs.existsSync(pathMod.join(dir, 'Default', 'session.json'))).toBe(true);
  });

  test('is a safe no-op when the session dir does not exist', () => {
    expect(() => wa.clearStaleLocks(999999)).not.toThrow();
  });
});

describe('thread create race (P2002 recovery)', () => {
  test('a concurrent create that loses the race recovers by updating the winner', async () => {
    // findUnique sees no thread (we lost the TOCTOU race); create then trips the
    // compound-unique P2002; the helper must fall back to update, not throw.
    prisma.whatsAppThread.findUnique.mockResolvedValue(null);
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    prisma.whatsAppThread.create.mockReset().mockRejectedValue(p2002);
    prisma.whatsAppThread.update.mockReset().mockResolvedValue({ id: 77 });

    const out = await wa.ingestInbound(TENANT, {
      fromMe: false, from: '919811111102@c.us', body: 'hi', id: { _serialized: 'wamid-race' },
      type: 'chat', hasMedia: false, _data: { notifyName: 'Ahmed' },
    });

    expect(out).toMatchObject({ threadId: 77 }); // recovered, not thrown
    expect(prisma.whatsAppThread.update).toHaveBeenCalled();
    const where = prisma.whatsAppThread.update.mock.calls.at(-1)[0].where;
    expect(where).toEqual({ tenantId_contactPhone: { tenantId: 3, contactPhone: '+919811111102' } });
  });
});

describe('ingestInbound', () => {
  function inboundMsg(overrides = {}) {
    return {
      fromMe: false,
      from: '919811111102@c.us',
      body: 'salaam, is the package available?',
      id: { _serialized: 'wamid-abc' },
      type: 'chat',
      hasMedia: false,
      ...overrides,
    };
  }

  test('new inbound → thread create (unread 1) + INBOUND row + whatsapp:received emit', async () => {
    const out = await wa.ingestInbound(TENANT, inboundMsg());
    expect(out).toMatchObject({ threadId: 11, messageId: 991 });

    const threadData = prisma.whatsAppThread.create.mock.calls[0][0].data;
    expect(threadData).toMatchObject({ tenantId: 3, contactPhone: '+919811111102', unreadCount: 1, status: 'OPEN' });

    const msgData = prisma.whatsAppMessage.create.mock.calls[0][0].data;
    expect(msgData).toMatchObject({
      from: '+919811111102', direction: 'INBOUND', status: 'DELIVERED',
      body: 'salaam, is the package available?', providerMsgId: 'wamid-abc', tenantId: 3, threadId: 11,
    });

    const emit = emits.find((e) => e.ev === 'whatsapp:received');
    expect(emit.room).toBe('tenant:3');
    expect(emit.payload).toMatchObject({ tenantId: 3, threadId: 11, contactPhone: '+919811111102' });
  });

  test('fromMe echoes, channels, and status broadcasts are skipped', async () => {
    await wa.ingestInbound(TENANT, inboundMsg({ fromMe: true }));
    await wa.ingestInbound(TENANT, inboundMsg({ from: '120363@newsletter' }));
    await wa.ingestInbound(TENANT, inboundMsg({ from: 'status@broadcast' }));
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  test('group (@g.us) messages ARE ingested, keyed by the group id, sender-prefixed', async () => {
    prisma.whatsAppThread.findUnique.mockResolvedValue(null);
    const out = await wa.ingestInbound(TENANT, inboundMsg({
      from: '120363999@g.us', body: 'hi team', _data: { notifyName: 'Alice' },
    }));
    expect(out).toMatchObject({ threadId: 11 });
    const threadData = prisma.whatsAppThread.create.mock.calls[0][0].data;
    expect(threadData.contactPhone).toBe('120363999@g.us');
    const msgData = prisma.whatsAppMessage.create.mock.calls[0][0].data;
    expect(msgData.body).toBe('Alice: hi team'); // sender attribution
  });

  test('duplicate providerMsgId is not re-persisted', async () => {
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ id: 5 });
    await wa.ingestInbound(TENANT, inboundMsg());
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  test('existing ASSIGNED thread does not bump unreadCount', async () => {
    prisma.whatsAppThread.findUnique.mockResolvedValue({ id: 11, assignedToId: 42, unreadCount: 0, contactId: 1 });
    await wa.ingestInbound(TENANT, inboundMsg());
    const updateData = prisma.whatsAppThread.update.mock.calls[0][0].data;
    expect(updateData.unreadCount).toBeUndefined();
    expect(updateData.status).toBe('OPEN');
  });
});
