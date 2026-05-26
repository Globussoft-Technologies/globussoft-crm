// @ts-check
/**
 * Unit + integration tests for backend/routes/email_threading.js.
 *
 * Pins the email-conversation threading contract that close issue #422's
 * drift fixes (archive piggyback via __ARCHIVED__: prefix, paginated thread
 * detail, fail-loud cross-tenant guard on /reply). The route is fully
 * tenant-scoped via req.user.tenantId; all happy-path assertions verify
 * that scope is applied at the prisma.where boundary.
 *
 * What this file pins
 * ───────────────────
 *   1. POST /auto-thread — back-fills threadId for null-threadId rows via a
 *      deterministic md5(subject + sorted participants) hash. Returns
 *      `{ processed: N }`.
 *   2. GET /threads — groups EmailMessage rows by threadId, hides
 *      __ARCHIVED__: prefixed threads by default, honours `?includeArchived=1`,
 *      `?contactId=N`, `?limit`, `?offset`. Sorted by lastMessageAt desc.
 *   3. GET /threads/:threadId — paginates messages within a thread,
 *      resolves bare-id AND archived-prefixed-id forms, returns 404 when
 *      empty, returns 400 on bad limit/offset.
 *   4. POST /threads/:threadId/mark-read — flips read:false → read:true
 *      via updateMany, returns `{ updated: count }`. Matches both bare
 *      and archived forms.
 *   5. POST /threads/:threadId/archive — re-keys every message in the
 *      thread with the __ARCHIVED__: prefix; returns 404 if thread not
 *      found; idempotent if invoked on an already-archived id.
 *   6. POST /reply — creates an OUTBOUND EmailMessage swapping from/to
 *      relative to the last message in the thread, preserving the
 *      original threadId. 400 if body+threadId missing. 404 if thread
 *      doesn't exist. 400 IMMUTABLE_FIELD if body had `tenantId`
 *      (drift #3: surfaced via req.strippedFields).
 *   7. GET /messages — raw EmailMessage rows for a contactId, with
 *      ?direction=INBOUND|OUTBOUND filter + ?limit (default 50, max 200).
 *      400 if contactId missing or invalid.
 *   8. GET /stats — thread count, unread thread count, avg response time
 *      (OUTBOUND -> next INBOUND within thread).
 *
 * Tenant-isolation contract
 * ─────────────────────────
 *   Every prisma call in this route includes `tenantId: req.user.tenantId`
 *   in its where-clause. The integration tests verify this on the spy's
 *   call args — a future "let's accept ?tenantId" refactor breaks these
 *   tests deterministically.
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/communications.test.js and
 *   backend/test/routes/contacts-source-filter.test.js — patch the auth
 *   middleware module before requiring the router, monkey-patch
 *   prisma.emailMessage with vi.fn() stubs, inject req.user via a test
 *   middleware. No DB, no network.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Patch auth middleware BEFORE requiring the router so router.use(verifyToken)
// resolves to the pass-through. We inject req.user in the test express layer.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Prisma singleton patching — emailMessage is the only model this route
// touches. Must be in place BEFORE the router is required (the router's
// top-level `require('../lib/prisma')` resolves at import time).
prisma.emailMessage = prisma.emailMessage || {};
prisma.emailMessage.findMany = vi.fn();
prisma.emailMessage.findFirst = vi.fn();
prisma.emailMessage.update = vi.fn();
prisma.emailMessage.updateMany = vi.fn();
prisma.emailMessage.create = vi.fn();
prisma.emailMessage.count = vi.fn();

import express from 'express';
import request from 'supertest';

const emailThreadingRouter = requireCJS('../../routes/email_threading');

function makeApp({ tenantId = 1, userId = 7, strippedFields = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId };
    // Drift #3: middleware/security stashes stripped body fields onto
    // req.strippedFields. Tests that want to exercise that path set it
    // explicitly via the strippedFields option.
    if (strippedFields) req.strippedFields = strippedFields;
    next();
  });
  app.use('/api/email-threading', emailThreadingRouter);
  return app;
}

beforeEach(() => {
  prisma.emailMessage.findMany.mockReset().mockResolvedValue([]);
  prisma.emailMessage.findFirst.mockReset().mockResolvedValue(null);
  prisma.emailMessage.update.mockReset().mockResolvedValue({ id: 1 });
  prisma.emailMessage.updateMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.emailMessage.create.mockReset();
  prisma.emailMessage.count.mockReset().mockResolvedValue(0);
});

// ── POST /auto-thread ─────────────────────────────────────────────────

describe('POST /auto-thread — back-fill threadId for orphans', () => {
  test('hashes (subject + sorted participants) and updates each orphan', async () => {
    const orphans = [
      { id: 1, subject: 'Hello', from: 'a@x.com', to: 'b@x.com' },
      { id: 2, subject: 'Re: Hello', from: 'b@x.com', to: 'a@x.com' },
    ];
    prisma.emailMessage.findMany.mockResolvedValueOnce(orphans);
    const app = makeApp();
    const res = await request(app).post('/api/email-threading/auto-thread').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ processed: 2 });

    // Tenant-scoped findMany for orphans.
    const findArgs = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(findArgs.where).toEqual({ tenantId: 1, threadId: null });

    // Both updates ran. Both should land on the SAME threadId because
    // cleanSubject('Re: Hello') === cleanSubject('Hello') and the
    // participants set is identical when sorted.
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(2);
    const t1 = prisma.emailMessage.update.mock.calls[0][0].data.threadId;
    const t2 = prisma.emailMessage.update.mock.calls[1][0].data.threadId;
    expect(t1).toBe(t2);
    expect(t1).toMatch(/^[a-f0-9]{16}$/);
  });

  test('returns processed:0 when no orphans exist', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([]);
    const app = makeApp();
    const res = await request(app).post('/api/email-threading/auto-thread').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ processed: 0 });
    expect(prisma.emailMessage.update).not.toHaveBeenCalled();
  });
});

// ── GET /threads ──────────────────────────────────────────────────────

describe('GET /threads — list grouped by threadId', () => {
  const SAMPLE_ROWS = [
    {
      id: 1, threadId: 'abc123', subject: 'Hello', from: 'a@x.com', to: 'b@x.com',
      read: true, contactId: 10, createdAt: new Date('2026-05-01T10:00:00Z'),
    },
    {
      id: 2, threadId: 'abc123', subject: 'Re: Hello', from: 'b@x.com', to: 'a@x.com',
      read: false, contactId: 10, createdAt: new Date('2026-05-01T11:00:00Z'),
    },
    {
      id: 3, threadId: 'def456', subject: 'Other', from: 'c@x.com', to: 'a@x.com',
      read: true, contactId: 11, createdAt: new Date('2026-05-02T10:00:00Z'),
    },
    {
      id: 4, threadId: '__ARCHIVED__:zzz999', subject: 'Old chat', from: 'a@x.com', to: 'd@x.com',
      read: true, contactId: 12, createdAt: new Date('2026-04-01T10:00:00Z'),
    },
  ];

  test('groups by threadId, hides archived by default, sorts by lastMessageAt desc', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce(SAMPLE_ROWS);
    const app = makeApp();
    const res = await request(app).get('/api/email-threading/threads');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2); // def456 + abc123, archived hidden
    expect(res.body.threads).toHaveLength(2);
    // def456 has the newer lastMessageAt (May 2 > May 1)
    expect(res.body.threads[0].threadId).toBe('def456');
    expect(res.body.threads[1].threadId).toBe('abc123');

    const abc = res.body.threads[1];
    expect(abc.messageCount).toBe(2);
    expect(abc.unreadCount).toBe(1);
    expect(abc.archived).toBe(false);
    expect(abc.participants.sort()).toEqual(['a@x.com', 'b@x.com']);

    // Tenant scope honoured.
    expect(prisma.emailMessage.findMany.mock.calls[0][0].where.tenantId).toBe(1);
  });

  test('?includeArchived=1 surfaces __ARCHIVED__ threads with archived:true', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce(SAMPLE_ROWS);
    const app = makeApp();
    const res = await request(app).get('/api/email-threading/threads?includeArchived=1');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const archived = res.body.threads.find(t => t.archived);
    expect(archived).toBeTruthy();
    expect(archived.threadId).toBe('__ARCHIVED__:zzz999');
  });

  test('?contactId=N narrows where-clause to that contact', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([]);
    const app = makeApp();
    const res = await request(app).get('/api/email-threading/threads?contactId=42');

    expect(res.status).toBe(200);
    expect(prisma.emailMessage.findMany.mock.calls[0][0].where.contactId).toBe(42);
  });
});

// ── GET /threads/:threadId ────────────────────────────────────────────

describe('GET /threads/:threadId — paginated thread detail', () => {
  test('returns 404 when no messages match', async () => {
    prisma.emailMessage.count.mockResolvedValueOnce(0);
    const app = makeApp();
    const res = await request(app).get('/api/email-threading/threads/abc123');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Thread not found');
  });

  test('honours ?limit + ?offset; returns total separate from page count', async () => {
    prisma.emailMessage.count.mockResolvedValueOnce(75);
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 1, subject: 'm1', threadId: 'abc123' },
      { id: 2, subject: 'm2', threadId: 'abc123' },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/email-threading/threads/abc123?limit=2&offset=10');

    expect(res.status).toBe(200);
    expect(res.body.threadId).toBe('abc123');
    expect(res.body.total).toBe(75);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(10);
    expect(res.body.messageCount).toBe(2); // legacy field — page count
    expect(res.body.messages).toHaveLength(2);

    // Verify prisma skip/take honored
    const findArgs = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(findArgs.skip).toBe(10);
    expect(findArgs.take).toBe(2);
    // Candidates include both bare + archived form so legacy-id bookmarks work.
    expect(findArgs.where.threadId.in).toEqual(['abc123', '__ARCHIVED__:abc123']);
  });

  test('?limit=0 or >200 returns 400', async () => {
    const app = makeApp();
    const r1 = await request(app).get('/api/email-threading/threads/abc?limit=0');
    expect(r1.status).toBe(400);
    expect(r1.body.error).toMatch(/limit/i);

    const r2 = await request(app).get('/api/email-threading/threads/abc?limit=201');
    expect(r2.status).toBe(400);

    const r3 = await request(app).get('/api/email-threading/threads/abc?limit=notanumber');
    expect(r3.status).toBe(400);
  });

  test('?offset=-1 returns 400', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/email-threading/threads/abc?offset=-1');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/offset/i);
  });
});

// ── POST /threads/:threadId/mark-read ─────────────────────────────────

describe('POST /threads/:threadId/mark-read', () => {
  test('updates unread rows to read:true, returns {updated:count}', async () => {
    prisma.emailMessage.updateMany.mockResolvedValueOnce({ count: 5 });
    const app = makeApp();
    const res = await request(app).post('/api/email-threading/threads/abc123/mark-read').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 5 });

    const args = prisma.emailMessage.updateMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(1);
    expect(args.where.threadId.in).toEqual(['abc123', '__ARCHIVED__:abc123']);
    expect(args.where.read).toBe(false);
    expect(args.data).toEqual({ read: true });
  });
});

// ── POST /threads/:threadId/archive ───────────────────────────────────

describe('POST /threads/:threadId/archive', () => {
  test('re-keys every message in the thread with __ARCHIVED__: prefix', async () => {
    prisma.emailMessage.updateMany.mockResolvedValueOnce({ count: 3 });
    const app = makeApp();
    const res = await request(app).post('/api/email-threading/threads/abc123/archive').send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      archived: true,
      threadId: 'abc123',
      archivedThreadId: '__ARCHIVED__:abc123',
      updated: 3,
    });

    const args = prisma.emailMessage.updateMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(1);
    expect(args.where.threadId).toBe('abc123');
    expect(args.data).toEqual({ threadId: '__ARCHIVED__:abc123' });
  });

  test('returns 404 when no messages match the thread', async () => {
    prisma.emailMessage.updateMany.mockResolvedValueOnce({ count: 0 });
    const app = makeApp();
    const res = await request(app).post('/api/email-threading/threads/nonexistent/archive').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Thread not found');
  });

  test('idempotent when called on an already-archived id', async () => {
    prisma.emailMessage.count.mockResolvedValueOnce(3);
    const app = makeApp();
    const res = await request(app)
      .post('/api/email-threading/threads/__ARCHIVED__:abc123/archive')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.alreadyArchived).toBe(true);
    expect(res.body.updated).toBe(0);
    // updateMany NOT called on already-archived path.
    expect(prisma.emailMessage.updateMany).not.toHaveBeenCalled();
  });
});

// ── POST /reply ───────────────────────────────────────────────────────

describe('POST /reply — create OUTBOUND reply on existing thread', () => {
  test('swaps from/to, prefixes Re:, preserves original threadId', async () => {
    const last = {
      id: 99,
      subject: 'Hello',
      from: 'inbound@x.com',
      to: 'outbound@x.com',
      contactId: 50,
      threadId: 'abc123',
    };
    prisma.emailMessage.findFirst.mockResolvedValueOnce(last);
    prisma.emailMessage.create.mockImplementationOnce(({ data }) =>
      Promise.resolve({ id: 100, ...data })
    );

    const app = makeApp();
    const res = await request(app)
      .post('/api/email-threading/reply')
      .send({ threadId: 'abc123', body: 'thanks!' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.code).toBe('THREAD_RESOLVED');
    expect(res.body.email.direction).toBe('OUTBOUND');
    expect(res.body.email.subject).toBe('Re: Hello');
    // Swap: from/to reversed relative to last
    expect(res.body.email.from).toBe('outbound@x.com');
    expect(res.body.email.to).toBe('inbound@x.com');
    // Original threadId preserved
    expect(res.body.email.threadId).toBe('abc123');
    // Tenant + contact carried forward
    expect(res.body.email.tenantId).toBe(1);
    expect(res.body.email.contactId).toBe(50);

    // computedThreadId present + 16-char md5 slice
    expect(res.body.computedThreadId).toMatch(/^[a-f0-9]{16}$/);
  });

  test('does NOT double-prefix Re: when subject already starts with it', async () => {
    prisma.emailMessage.findFirst.mockResolvedValueOnce({
      id: 99, subject: 'Re: Hello', from: 'a@x.com', to: 'b@x.com',
      contactId: 50, threadId: 'abc123',
    });
    prisma.emailMessage.create.mockImplementationOnce(({ data }) =>
      Promise.resolve({ id: 100, ...data })
    );
    const app = makeApp();
    const res = await request(app)
      .post('/api/email-threading/reply')
      .send({ threadId: 'abc123', body: 'thanks!' });

    expect(res.status).toBe(200);
    expect(res.body.email.subject).toBe('Re: Hello'); // NOT "Re: Re: Hello"
  });

  test('400 when body or threadId missing', async () => {
    const app = makeApp();
    const r1 = await request(app).post('/api/email-threading/reply').send({ body: 'hi' });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post('/api/email-threading/reply').send({ threadId: 'abc' });
    expect(r2.status).toBe(400);
  });

  test('404 when thread does not exist', async () => {
    prisma.emailMessage.findFirst.mockResolvedValueOnce(null);
    const app = makeApp();
    const res = await request(app)
      .post('/api/email-threading/reply')
      .send({ threadId: 'ghostthread', body: 'hi' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Thread not found');
  });

  test('400 IMMUTABLE_FIELD when stripDangerous removed tenantId from body', async () => {
    // Simulate stripDangerous having stashed the stripped intent on req.
    const app = makeApp({ strippedFields: { tenantId: 999 } });
    const res = await request(app)
      .post('/api/email-threading/reply')
      .send({ threadId: 'abc', body: 'hi' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IMMUTABLE_FIELD');
    expect(res.body.field).toBe('tenantId');
    // findFirst NOT called — we rejected BEFORE touching prisma.
    expect(prisma.emailMessage.findFirst).not.toHaveBeenCalled();
  });
});

// ── GET /messages ─────────────────────────────────────────────────────

describe('GET /messages — raw rows by contactId', () => {
  test('400 when contactId missing or non-numeric', async () => {
    const app = makeApp();
    const r1 = await request(app).get('/api/email-threading/messages');
    expect(r1.status).toBe(400);
    const r2 = await request(app).get('/api/email-threading/messages?contactId=notanumber');
    expect(r2.status).toBe(400);
  });

  test('200 with rows, default limit 50, tenant-scoped', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([
      { id: 1, contactId: 42, direction: 'OUTBOUND' },
      { id: 2, contactId: 42, direction: 'INBOUND' },
    ]);
    const app = makeApp();
    const res = await request(app).get('/api/email-threading/messages?contactId=42');

    expect(res.status).toBe(200);
    expect(res.body.contactId).toBe(42);
    expect(res.body.count).toBe(2);
    expect(res.body.messages).toHaveLength(2);

    const args = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(1);
    expect(args.where.contactId).toBe(42);
    expect(args.take).toBe(50);
  });

  test('?direction=OUTBOUND narrows where; INBOUND too; invalid → 400', async () => {
    prisma.emailMessage.findMany.mockResolvedValue([]);
    const app = makeApp();

    await request(app).get('/api/email-threading/messages?contactId=42&direction=outbound');
    expect(prisma.emailMessage.findMany.mock.calls.at(-1)[0].where.direction).toBe('OUTBOUND');

    await request(app).get('/api/email-threading/messages?contactId=42&direction=INBOUND');
    expect(prisma.emailMessage.findMany.mock.calls.at(-1)[0].where.direction).toBe('INBOUND');

    const bad = await request(app).get('/api/email-threading/messages?contactId=42&direction=SIDEWAYS');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/direction/i);
  });

  test('?limit caps at 200', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([]);
    const app = makeApp();
    await request(app).get('/api/email-threading/messages?contactId=42&limit=500');
    expect(prisma.emailMessage.findMany.mock.calls.at(-1)[0].take).toBe(200);
  });
});

// ── GET /stats ────────────────────────────────────────────────────────

describe('GET /stats — thread aggregates', () => {
  test('counts threads + unread + avg-response time (OUTBOUND→next INBOUND)', async () => {
    // 2 threads. Thread "t1" has OUTBOUND at t=0, INBOUND at t=60min →
    // response time 3,600,000 ms. Thread "t2" has all-OUTBOUND (no response).
    const rows = [
      { threadId: 't1', direction: 'OUTBOUND', read: true,
        createdAt: new Date('2026-05-01T10:00:00Z') },
      { threadId: 't1', direction: 'INBOUND', read: false,
        createdAt: new Date('2026-05-01T11:00:00Z') },
      { threadId: 't2', direction: 'OUTBOUND', read: true,
        createdAt: new Date('2026-05-02T10:00:00Z') },
    ];
    prisma.emailMessage.findMany.mockResolvedValueOnce(rows);

    const app = makeApp();
    const res = await request(app).get('/api/email-threading/stats');

    expect(res.status).toBe(200);
    expect(res.body.threadCount).toBe(2);
    expect(res.body.unreadThreads).toBe(1); // t1 has unread
    expect(res.body.sampleSize).toBe(1); // only t1 had a paired response
    expect(res.body.avgResponseTimeMs).toBe(3_600_000); // 60 min
    expect(res.body.avgResponseTimeMinutes).toBe(60);

    // Tenant-scoped findMany.
    expect(prisma.emailMessage.findMany.mock.calls[0][0].where.tenantId).toBe(1);
  });

  test('returns zeros for a tenant with no threaded messages', async () => {
    prisma.emailMessage.findMany.mockResolvedValueOnce([]);
    const app = makeApp();
    const res = await request(app).get('/api/email-threading/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      threadCount: 0,
      unreadThreads: 0,
      avgResponseTimeMs: 0,
      avgResponseTimeMinutes: 0,
      sampleSize: 0,
    });
  });
});

// ── Tenant isolation regression pin ───────────────────────────────────

describe('Tenant isolation — every prisma call carries req.user.tenantId', () => {
  test('switching tenantId changes the where clause across endpoints', async () => {
    prisma.emailMessage.findMany.mockResolvedValue([]);
    prisma.emailMessage.count.mockResolvedValue(0);
    prisma.emailMessage.updateMany.mockResolvedValue({ count: 0 });

    const appA = makeApp({ tenantId: 11, userId: 100 });
    const appB = makeApp({ tenantId: 22, userId: 200 });

    await request(appA).get('/api/email-threading/threads');
    expect(prisma.emailMessage.findMany.mock.calls.at(-1)[0].where.tenantId).toBe(11);

    await request(appB).get('/api/email-threading/threads');
    expect(prisma.emailMessage.findMany.mock.calls.at(-1)[0].where.tenantId).toBe(22);

    await request(appA).get('/api/email-threading/stats');
    expect(prisma.emailMessage.findMany.mock.calls.at(-1)[0].where.tenantId).toBe(11);
  });
});
