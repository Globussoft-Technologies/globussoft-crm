// @ts-check
/**
 * Unit tests for backend/routes/email_inbound.js — pins the public Mailgun
 * webhook + authed /test passthrough + /verify echo.
 *
 * What this file pins
 * ───────────────────
 *   1. POST / (public Mailgun webhook):
 *      - Happy path: form-encoded body with sender → Contact lookup →
 *        EmailMessage.create with direction=INBOUND, read=false, tenant
 *        inherited from the matched Contact, contactId set, returns
 *        { success: true, emailId } at 200.
 *      - Unmatched sender: still persists EmailMessage with tenantId=1
 *        (default) + contactId=null + no Activity row.
 *      - Matched sender: also writes an Activity row (`type: 'Email'`,
 *        description includes the subject), best-effort — webhook does
 *        NOT fail when activity insert throws.
 *      - Missing sender → 400 { success: false, error: 'Missing sender' }.
 *      - Subject defaults to '(no subject)' when omitted; body falls back
 *        from body-plain → body-html → '' so empty payloads still persist.
 *      - Mailgun field aliases work: `from` (vs `sender`), `to` (vs
 *        `recipient`), `bodyPlain` (vs `body-plain`), `bodyHtml` (vs
 *        `body-html`).
 *      - Sender normalisation: trimmed + lowercased BEFORE the unique
 *        Contact lookup (so `  Foo@Bar.COM ` matches `foo@bar.com`).
 *      - Socket.io fanout: emits `email_received` with {emailId, contactId,
 *        tenantId} when `req.io` is set; tolerates missing io.
 *      - prisma.contact.findUnique throwing (e.g. transient DB blip) does
 *        NOT 500 — falls through to the default-tenant unmatched branch.
 *      - prisma.emailMessage.create throwing surfaces as a 500 with the
 *        error message in the envelope (Mailgun's retry signal).
 *
 *   2. POST /test (authed passthrough):
 *      - Same processor, but JSON body + verifyToken gate.
 *      - Without Authorization → 401 from the middleware.
 *      - With Authorization → 200 + { success, emailId, contactId, tenantId }
 *        (NOTE: returns the full result object, not just emailId).
 *
 *   3. POST /verify:
 *      - Always 200 { ok: true }. Public, no auth.
 *
 * Test pattern
 * ────────────
 *   Mirrors backend/test/routes/email-scheduling.test.js — prisma singleton
 *   monkey-patched BEFORE the router is required. We stub sequenceEngine's
 *   processInboundReplies via require.cache so the threadId-suffixed branch
 *   doesn't accidentally cron-fire during tests.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ─── Prisma singleton patching — BEFORE router require ────────────────
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn();
prisma.emailMessage = prisma.emailMessage || {};
prisma.emailMessage.create = vi.fn();
prisma.activity = prisma.activity || {};
prisma.activity.create = vi.fn();

// ─── Stub sequenceEngine BEFORE router require so the reply-pause hook
//     never touches the real engine ──────────────────────────────────
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const sequenceEnginePath = requireCJS.resolve('../../cron/sequenceEngine');
const processInboundRepliesSpy = vi.fn().mockResolvedValue(undefined);
require.cache && delete require.cache[sequenceEnginePath];
requireCJS.cache[sequenceEnginePath] = {
  id: sequenceEnginePath,
  filename: sequenceEnginePath,
  loaded: true,
  exports: { processInboundReplies: processInboundRepliesSpy },
};

// ─── Mock verifyToken so we can exercise /test ─────────────────────────
const authPath = requireCJS.resolve('../../middleware/auth');
requireCJS.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    verifyToken: (req, res, next) => {
      if (!req.headers.authorization) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      req.user = { userId: 7, tenantId: 1 };
      next();
    },
    verifyRole: () => (_req, _res, next) => next(),
  },
};

import express from 'express';
import request from 'supertest';

const router = requireCJS('../../routes/email_inbound');

function makeApp({ io = null } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    req.io = io;
    next();
  });
  app.use('/api/email/inbound', router);
  return app;
}

const contactRow = {
  id: 42,
  email: 'jane@acme.com',
  tenantId: 9,
  firstName: 'Jane',
  lastName: 'Roe',
};

beforeEach(() => {
  prisma.contact.findUnique.mockReset();
  prisma.emailMessage.create.mockReset();
  prisma.activity.create.mockReset();
  processInboundRepliesSpy.mockClear();

  prisma.contact.findUnique.mockResolvedValue(null);
  prisma.emailMessage.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: 1234, threadId: null, ...data })
  );
  prisma.activity.create.mockResolvedValue({ id: 7777 });
});

// ─── POST / (public Mailgun webhook) ───────────────────────────────────

describe('POST /api/email/inbound (public Mailgun webhook)', () => {
  test('happy path: matched contact → tenant inherited, contactId set, activity logged', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(contactRow);
    const io = { emit: vi.fn() };
    const res = await request(makeApp({ io }))
      .post('/api/email/inbound')
      .type('form')
      .send({
        sender: 'jane@acme.com',
        recipient: 'support@globusdemos.com',
        subject: 'Need help with onboarding',
        'body-plain': 'Hi team — please assist.',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, emailId: 1234 });

    expect(prisma.contact.findUnique).toHaveBeenCalledWith({
      where: { email: 'jane@acme.com' },
    });
    expect(prisma.emailMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subject: 'Need help with onboarding',
        body: 'Hi team — please assist.',
        from: 'jane@acme.com',
        to: 'support@globusdemos.com',
        direction: 'INBOUND',
        read: false,
        tenantId: 9, // inherited from matched Contact
        contactId: 42,
      }),
    });
    expect(prisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'Email',
        contactId: 42,
        tenantId: 9,
        description: expect.stringContaining('Need help with onboarding'),
      }),
    });
    expect(io.emit).toHaveBeenCalledWith('email_received', {
      emailId: 1234,
      contactId: 42,
      tenantId: 9,
    });
  });

  test('unmatched sender → tenantId=1 fallback, contactId=null, no Activity row', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post('/api/email/inbound')
      .type('form')
      .send({
        sender: 'stranger@unknown.io',
        recipient: 'help@globusdemos.com',
        subject: 'Hello',
        'body-plain': 'Anyone home?',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.emailMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 1,
        contactId: null,
        from: 'stranger@unknown.io',
      }),
    });
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  test('missing sender → 400 { success: false, error: "Missing sender" }', async () => {
    const res = await request(makeApp())
      .post('/api/email/inbound')
      .type('form')
      .send({
        recipient: 'help@globusdemos.com',
        subject: 'Anon',
        'body-plain': 'No from header',
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Missing sender' });
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
  });

  test('subject defaults to "(no subject)" when omitted; body falls back to ""', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post('/api/email/inbound')
      .type('form')
      .send({ sender: 'a@b.com' });

    expect(res.status).toBe(200);
    expect(prisma.emailMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subject: '(no subject)',
        body: '',
        from: 'a@b.com',
        to: '',
      }),
    });
  });

  test('Mailgun field aliases: from/to/bodyPlain accepted alongside sender/recipient/body-plain', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post('/api/email/inbound')
      .type('form')
      .send({
        from: 'alias@example.com',
        to: 'desk@globusdemos.com',
        subject: 'Alias test',
        bodyPlain: 'Plain body via camelCase alias',
      });

    expect(res.status).toBe(200);
    expect(prisma.emailMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        from: 'alias@example.com',
        to: 'desk@globusdemos.com',
        subject: 'Alias test',
        body: 'Plain body via camelCase alias',
      }),
    });
  });

  test('falls back to body-html when body-plain is empty', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post('/api/email/inbound')
      .type('form')
      .send({
        sender: 'h@b.com',
        'body-html': '<p>HTML only</p>',
      });

    expect(res.status).toBe(200);
    expect(prisma.emailMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ body: '<p>HTML only</p>' }),
    });
  });

  test('sender is trimmed + lowercased before Contact lookup', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(contactRow);
    const res = await request(makeApp())
      .post('/api/email/inbound')
      .type('form')
      .send({
        sender: '  Jane@Acme.COM  ',
        subject: 'Mixed case',
      });

    expect(res.status).toBe(200);
    expect(prisma.contact.findUnique).toHaveBeenCalledWith({
      where: { email: 'jane@acme.com' },
    });
    expect(prisma.emailMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ from: 'jane@acme.com' }),
    });
  });

  test('tolerates missing req.io (no socket.emit attempted)', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(null);
    // io is null by default in makeApp() — should not throw.
    const res = await request(makeApp({ io: null }))
      .post('/api/email/inbound')
      .type('form')
      .send({ sender: 'noio@b.com', subject: 'No socket' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('contact.findUnique throwing falls through to unmatched branch (no 500)', async () => {
    prisma.contact.findUnique.mockRejectedValueOnce(new Error('connection reset'));
    const res = await request(makeApp())
      .post('/api/email/inbound')
      .type('form')
      .send({
        sender: 'blip@example.com',
        subject: 'DB blip',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prisma.emailMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 1,
        contactId: null,
      }),
    });
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  test('activity insert throwing does NOT fail the webhook (best-effort)', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(contactRow);
    prisma.activity.create.mockRejectedValueOnce(new Error('activity dead'));
    const res = await request(makeApp())
      .post('/api/email/inbound')
      .type('form')
      .send({
        sender: 'jane@acme.com',
        subject: 'Activity blip',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, emailId: 1234 });
  });

  test('emailMessage.create throwing → 500 envelope with error message', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(null);
    prisma.emailMessage.create.mockRejectedValueOnce(new Error('write failed'));
    const res = await request(makeApp())
      .post('/api/email/inbound')
      .type('form')
      .send({
        sender: 'fail@example.com',
        subject: 'Doomed',
      });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'write failed' });
  });

  test('threadId matching /^seq-\\d+$/ fires the sequence reply scanner (fire-and-forget)', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(contactRow);
    prisma.emailMessage.create.mockResolvedValueOnce({
      id: 7001,
      threadId: 'seq-123',
    });
    const res = await request(makeApp())
      .post('/api/email/inbound')
      .type('form')
      .send({
        sender: 'jane@acme.com',
        subject: 'Re: drip step 3',
      });

    expect(res.status).toBe(200);
    expect(processInboundRepliesSpy).toHaveBeenCalledTimes(1);
  });

  test('non-seq threadId does NOT fire the sequence reply scanner', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(contactRow);
    prisma.emailMessage.create.mockResolvedValueOnce({
      id: 7002,
      threadId: 'support-thread-xyz',
    });
    const res = await request(makeApp())
      .post('/api/email/inbound')
      .type('form')
      .send({
        sender: 'jane@acme.com',
        subject: 'Random thread',
      });

    expect(res.status).toBe(200);
    expect(processInboundRepliesSpy).not.toHaveBeenCalled();
  });
});

// ─── POST /test (authed passthrough) ──────────────────────────────────

describe('POST /api/email/inbound/test (authed)', () => {
  test('without Authorization → 401', async () => {
    const res = await request(makeApp())
      .post('/api/email/inbound/test')
      .send({ sender: 'a@b.com', subject: 'QA' });
    expect(res.status).toBe(401);
  });

  test('with Authorization → 200 + full result object', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(contactRow);
    const res = await request(makeApp())
      .post('/api/email/inbound/test')
      .set('Authorization', 'Bearer test-token')
      .send({
        sender: 'jane@acme.com',
        recipient: 'desk@globusdemos.com',
        subject: 'QA payload',
        'body-plain': 'manual test',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      emailId: 1234,
      contactId: 42,
      tenantId: 9,
    });
  });

  test('JSON body (not form) is parsed on the authed test endpoint', async () => {
    prisma.contact.findUnique.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post('/api/email/inbound/test')
      .set('Authorization', 'Bearer test-token')
      .set('Content-Type', 'application/json')
      .send({
        sender: 'json@b.com',
        subject: 'JSON',
        bodyPlain: 'json body',
      });

    expect(res.status).toBe(200);
    expect(prisma.emailMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        from: 'json@b.com',
        body: 'json body',
      }),
    });
  });
});

// ─── POST /verify ─────────────────────────────────────────────────────

describe('POST /api/email/inbound/verify', () => {
  test('always responds 200 { ok: true } (public)', async () => {
    const res = await request(makeApp()).post('/api/email/inbound/verify');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
  });
});
