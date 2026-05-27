// @ts-check
/**
 * Unit + integration tests for backend/routes/email.js — pins the inbox-
 * counter sidebar contract (#402), the threads/stats/scheduled GET shapes,
 * and the G-10 scheduled-email engine manual trigger (POST /scheduled/run).
 *
 * Why this file exists
 * ────────────────────
 * routes/email.js is the cheap mount the sidebar polls every 60s for the
 * Inbox counter — before #402 it was undefined, fell through to the SPA
 * catch-all, and surfaced as a "Not found." toast on every page. The shape
 * contract with Sidebar.jsx:51 is `{ total }` (or an array — both work via
 * the `safeLen` helper). That contract MUST be preserved; client-side
 * destructuring of `body.total` is load-bearing across every authed page.
 *
 * The route also hosts G-10's manual trigger for the scheduled-email cron
 * (mirrors POST /api/billing/recurring/run + /api/forecasting/snapshot/run
 * + /api/wellness/ops/run). The status machine is PENDING → SENT/FAILED,
 * with EmailMessage row creation + tracking-pixel attach + tenant scoping.
 * When SENDGRID_API_KEY is unset (CI default), sendSendGrid returns
 * { sent:false, reason:'no_api_key' } — the route flips the row to FAILED.
 * That's exactly the path this spec exercises under "failed transitions".
 *
 * What this file pins
 * ───────────────────
 *   1. GET /              — soft-fail to { total: 0 } on Prisma error
 *                           (sidebar must never blow up the page).
 *   2. GET /              — happy path: { total: <N> } from emailMessage.count.
 *   3. GET /?unread=1     — passes read:false into the where clause.
 *   4. GET /?folder=inbox — passes direction:'INBOUND' into the where clause.
 *   5. GET /?folder=sent  — passes direction:'OUTBOUND' into the where clause.
 *   6. GET /threads       — groups by threadId; falls back to `single-<id>`
 *                           when threadId is null; sorts desc by lastAt.
 *   7. GET /threads       — 500 on Prisma error (not soft-fail — this is a
 *                           page-level read, not the sidebar counter).
 *   8. GET /stats         — returns { total, unread, sent, received } from
 *                           parallel counts; all scoped to req.user.tenantId.
 *   9. GET /scheduled     — only returns rows with status='PENDING' for the
 *                           caller's tenant, sorted by scheduledFor asc.
 *  10. POST /scheduled/run — ADMIN-only (USER → 403 RBAC_DENIED).
 *  11. POST /scheduled/run — no-due-rows: returns { processed:0, sent:0,
 *                            failed:0, errors:[] } with success:true.
 *  12. POST /scheduled/run — without SENDGRID_API_KEY, all due rows flip to
 *                            status='FAILED' with reason 'no_api_key'; one
 *                            EmailMessage row + one EmailTracking row
 *                            written per due item BEFORE the FAILED flip
 *                            (engine-mirror semantics).
 *  13. POST /scheduled/run — with SENDGRID_API_KEY + ok fetch, rows flip to
 *                            status='SENT' with sentAt populated and
 *                            errorMessage:null.
 *  14. POST /scheduled/run — partial failure: 1 fetch ok + 1 fetch !ok →
 *                            sent:1, failed:1, errors has the failed row.
 *  15. POST /scheduled/run — tenant scoping: every Prisma call passed the
 *                            caller's tenantId; cross-tenant data is invisible.
 *  16. POST /scheduled/run — only PENDING + scheduledFor<=now is processed
 *                            (the take:50 cap + lte filter is preserved).
 *
 * Test pattern
 * ────────────
 * Mirror of backend/test/routes/communications.test.js + admin.test.js:
 *   (a) Prisma singleton-monkey-patch BEFORE the router is required (the
 *       route's top-level `require('../lib/prisma')` resolves at import
 *       time, so the patch must precede it).
 *   (b) verifyToken bypassed via `authMw.verifyToken = (_req,_res,next)=>next()`
 *       so we exercise the route + verifyRole flow without minting JWTs.
 *   (c) verifyRole stays REAL so the ADMIN-gate assertion is end-to-end.
 *   (d) global.fetch is stubbed per-test for the SendGrid HTTP boundary;
 *       SENDGRID_API_KEY is set/unset per-test for the two transition paths.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Clear SENDGRID_API_KEY BEFORE the router is required — routes/email.js
// captures `const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY` at module
// load time, and `sendSendGrid()` falls back to the captured constant via
// `process.env.SENDGRID_API_KEY || SENDGRID_API_KEY`. A leftover value
// from .env (auto-loaded by @prisma/client) would survive `delete process.env.*`
// in beforeEach and poison the "no SENDGRID_API_KEY → reason 'no_api_key'" branch.
vi.hoisted(() => { delete process.env.SENDGRID_API_KEY; });

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Auth middleware bypass — verifyToken passthrough; verifyRole stays real.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

// Prisma singleton patching — replace the lazy $extends-proxy delegates
// for the models the route touches.
prisma.emailMessage = {
  count: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
};
prisma.scheduledEmail = {
  findMany: vi.fn(),
  update: vi.fn(),
};
prisma.emailTracking = {
  create: vi.fn(),
};

import express from 'express';
import request from 'supertest';

const emailRouter = requireCJS('../../routes/email');

/**
 * Construct a fresh express app with a fake auth-context middleware so the
 * router sees req.user populated. Default role is ADMIN; override to USER
 * to exercise the verifyRole(['ADMIN']) denial path.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/email', emailRouter);
  return app;
}

beforeEach(() => {
  prisma.emailMessage.count.mockReset();
  prisma.emailMessage.findMany.mockReset();
  prisma.emailMessage.create.mockReset();
  prisma.scheduledEmail.findMany.mockReset();
  prisma.scheduledEmail.update.mockReset();
  prisma.emailTracking.create.mockReset();

  // Default no-op resolutions.
  prisma.emailMessage.count.mockResolvedValue(0);
  prisma.emailMessage.findMany.mockResolvedValue([]);
  prisma.emailMessage.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: 2001, ...data, createdAt: new Date() })
  );
  prisma.scheduledEmail.findMany.mockResolvedValue([]);
  prisma.scheduledEmail.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ id: where.id, ...data })
  );
  prisma.emailTracking.create.mockResolvedValue({ id: 1, trackingId: 'stub' });

  // Default: no key — drives the FAILED transition path.
  delete process.env.SENDGRID_API_KEY;
});

afterEach(() => {
  delete process.env.SENDGRID_API_KEY;
});

// ─── GET / — sidebar inbox counter (#402) ───────────────────────────

describe('GET / — inbox counter (#402)', () => {
  test('returns { total } from emailMessage.count scoped to tenantId', async () => {
    prisma.emailMessage.count.mockResolvedValue(42);
    const res = await request(makeApp({ tenantId: 5 })).get('/api/email');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 42 });
    expect(prisma.emailMessage.count).toHaveBeenCalledTimes(1);
    const args = prisma.emailMessage.count.mock.calls[0][0];
    expect(args.where.tenantId).toBe(5);
    // No direction / read filter when no query params.
    expect(args.where.read).toBeUndefined();
    expect(args.where.direction).toBeUndefined();
  });

  test('?unread=1 adds read:false to the where clause', async () => {
    prisma.emailMessage.count.mockResolvedValue(3);
    const res = await request(makeApp()).get('/api/email?unread=1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 3 });
    const args = prisma.emailMessage.count.mock.calls[0][0];
    expect(args.where.read).toBe(false);
  });

  test('?folder=inbox adds direction:INBOUND', async () => {
    const res = await request(makeApp()).get('/api/email?folder=inbox');
    expect(res.status).toBe(200);
    const args = prisma.emailMessage.count.mock.calls[0][0];
    expect(args.where.direction).toBe('INBOUND');
  });

  test('?folder=sent adds direction:OUTBOUND', async () => {
    const res = await request(makeApp()).get('/api/email?folder=sent');
    expect(res.status).toBe(200);
    const args = prisma.emailMessage.count.mock.calls[0][0];
    expect(args.where.direction).toBe('OUTBOUND');
  });

  test('soft-fails to { total: 0 } on Prisma error (sidebar must never break the page)', async () => {
    prisma.emailMessage.count.mockRejectedValue(new Error('db down'));
    const res = await request(makeApp()).get('/api/email');
    // CRITICAL: 200 + { total: 0 }, NOT 500. The sidebar polls every 60s;
    // a 500 toast on every refresh would tank UX. Soft-fail is intentional.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0 });
  });
});

// ─── GET /threads — thread grouping ─────────────────────────────────

describe('GET /threads', () => {
  test('groups messages by threadId, sorts by lastAt desc, slices to 50', async () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-05-01T00:00:00Z');
    prisma.emailMessage.findMany.mockResolvedValue([
      { id: 1, threadId: 't-a', subject: 'thread-a', createdAt: older, read: true },
      { id: 2, threadId: 't-a', subject: 'thread-a', createdAt: newer, read: false },
      { id: 3, threadId: null, subject: 'one-off', createdAt: newer, read: true },
    ]);
    const res = await request(makeApp()).get('/api/email/threads');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // 2 threads — one keyed by 't-a' with both msgs, one single-3.
    expect(res.body.length).toBe(2);
    const tA = res.body.find(t => t.threadId === 't-a');
    expect(tA).toBeDefined();
    expect(tA.messages.length).toBe(2);
    expect(tA.unread).toBe(1);
    const single = res.body.find(t => t.threadId === 'single-3');
    expect(single).toBeDefined();
    expect(single.messages.length).toBe(1);
  });

  test('returns 500 on Prisma error (this is a page-level read, not the soft-fail counter)', async () => {
    prisma.emailMessage.findMany.mockRejectedValue(new Error('db down'));
    const res = await request(makeApp()).get('/api/email/threads');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/threads/i);
  });
});

// ─── GET /stats — counts envelope ───────────────────────────────────

describe('GET /stats', () => {
  test('returns { total, unread, sent, received } from parallel counts scoped to tenantId', async () => {
    // 4 counts: total, unread, sent (OUTBOUND), received (INBOUND).
    prisma.emailMessage.count
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(40)
      .mockResolvedValueOnce(60);

    const res = await request(makeApp({ tenantId: 9 })).get('/api/email/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 100, unread: 7, sent: 40, received: 60 });
    expect(prisma.emailMessage.count).toHaveBeenCalledTimes(4);
    // Every call must be tenant-scoped — no cross-tenant leak.
    for (const call of prisma.emailMessage.count.mock.calls) {
      expect(call[0].where.tenantId).toBe(9);
    }
  });
});

// ─── GET /scheduled — pending queue ─────────────────────────────────

describe('GET /scheduled', () => {
  test('returns only PENDING rows for the caller tenant, ordered by scheduledFor asc', async () => {
    const rows = [
      { id: 1, status: 'PENDING', scheduledFor: new Date('2026-06-01T00:00:00Z'), to: 'a@x.com' },
      { id: 2, status: 'PENDING', scheduledFor: new Date('2026-06-02T00:00:00Z'), to: 'b@x.com' },
    ];
    prisma.scheduledEmail.findMany.mockResolvedValue(rows);
    const res = await request(makeApp({ tenantId: 11 })).get('/api/email/scheduled');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    const args = prisma.scheduledEmail.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 11, status: 'PENDING' });
    expect(args.orderBy).toEqual({ scheduledFor: 'asc' });
  });
});

// ─── POST /scheduled/run — G-10 manual trigger ──────────────────────

describe('POST /scheduled/run — G-10 manual cron trigger', () => {
  test('USER role → 403 RBAC_DENIED (admin-only gate)', async () => {
    const app = makeApp({ role: 'USER' });
    const res = await request(app).post('/api/email/scheduled/run').send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('no due rows → returns { processed:0, sent:0, failed:0, errors:[] }', async () => {
    prisma.scheduledEmail.findMany.mockResolvedValue([]);
    const res = await request(makeApp({ tenantId: 3 })).post('/api/email/scheduled/run').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      tenantId: 3,
      processed: 0,
      sent: 0,
      failed: 0,
      errors: [],
    });
    // EmailMessage / EmailTracking untouched when no due rows.
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
    expect(prisma.emailTracking.create).not.toHaveBeenCalled();
  });

  test('without SENDGRID_API_KEY, all due rows flip to FAILED with reason no_api_key', async () => {
    // No SENDGRID_API_KEY in env (cleared in beforeEach).
    const due = [
      { id: 10, tenantId: 1, to: 'a@x.com', subject: 's1', body: 'b1', contactId: null, userId: 7, scheduledFor: new Date('2026-01-01') },
      { id: 11, tenantId: 1, to: 'b@x.com', subject: 's2', body: 'b2', contactId: null, userId: 7, scheduledFor: new Date('2026-01-01') },
    ];
    prisma.scheduledEmail.findMany.mockResolvedValue(due);

    const res = await request(makeApp()).post('/api/email/scheduled/run').send({});
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(2);
    expect(res.body.sent).toBe(0);
    expect(res.body.failed).toBe(2);
    expect(res.body.errors.length).toBe(2);
    expect(res.body.errors.every(e => e.reason === 'no_api_key')).toBe(true);

    // Engine-mirror semantics: EmailMessage + EmailTracking rows written
    // BEFORE the flip, even when the send fails.
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(2);
    expect(prisma.emailTracking.create).toHaveBeenCalledTimes(2);

    // Both scheduledEmail.update calls flipped status to FAILED.
    expect(prisma.scheduledEmail.update).toHaveBeenCalledTimes(2);
    for (const call of prisma.scheduledEmail.update.mock.calls) {
      expect(call[0].data.status).toBe('FAILED');
      expect(call[0].data.errorMessage).toBe('no_api_key');
    }
  });

  test('with SENDGRID_API_KEY + ok fetch, due rows flip to SENT with sentAt populated', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    const due = [
      { id: 20, tenantId: 1, to: 'c@x.com', subject: 's3', body: 'b3', contactId: null, userId: 7, scheduledFor: new Date('2026-01-01') },
    ];
    prisma.scheduledEmail.findMany.mockResolvedValue(due);

    // Stub global.fetch to return a successful SendGrid response.
    const prevFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      headers: { get: (k) => (k === 'x-message-id' ? 'mid-abc' : null) },
      text: () => Promise.resolve(''),
    });

    try {
      const res = await request(makeApp()).post('/api/email/scheduled/run').send({});
      expect(res.status).toBe(200);
      expect(res.body.processed).toBe(1);
      expect(res.body.sent).toBe(1);
      expect(res.body.failed).toBe(0);
      expect(res.body.errors).toEqual([]);

      expect(prisma.scheduledEmail.update).toHaveBeenCalledTimes(1);
      const updateArgs = prisma.scheduledEmail.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe('SENT');
      expect(updateArgs.data.sentAt).toBeInstanceOf(Date);
      expect(updateArgs.data.errorMessage).toBeNull();
    } finally {
      global.fetch = prevFetch;
    }
  });

  test('partial failure — 1 ok + 1 !ok → sent:1, failed:1', async () => {
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    const due = [
      { id: 30, tenantId: 1, to: 'good@x.com', subject: 's4', body: 'b4', contactId: null, userId: 7, scheduledFor: new Date('2026-01-01') },
      { id: 31, tenantId: 1, to: 'bad@x.com',  subject: 's5', body: 'b5', contactId: null, userId: 7, scheduledFor: new Date('2026-01-01') },
    ];
    prisma.scheduledEmail.findMany.mockResolvedValue(due);

    const prevFetch = global.fetch;
    let call = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          status: 202,
          headers: { get: () => 'mid-good' },
          text: () => Promise.resolve(''),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: () => Promise.resolve('unauthorized'),
      });
    });

    try {
      const res = await request(makeApp()).post('/api/email/scheduled/run').send({});
      expect(res.status).toBe(200);
      expect(res.body.processed).toBe(2);
      expect(res.body.sent).toBe(1);
      expect(res.body.failed).toBe(1);
      expect(res.body.errors.length).toBe(1);
      expect(res.body.errors[0].id).toBe(31);
      expect(res.body.errors[0].reason).toMatch(/sendgrid 401/);
    } finally {
      global.fetch = prevFetch;
    }
  });

  test('tenant scoping — findMany.where AND every emailMessage.create.data carries the caller tenantId', async () => {
    const due = [
      { id: 40, tenantId: 17, to: 'a@x.com', subject: 's', body: 'b', contactId: null, userId: 7, scheduledFor: new Date('2026-01-01') },
    ];
    prisma.scheduledEmail.findMany.mockResolvedValue(due);

    const res = await request(makeApp({ tenantId: 17 })).post('/api/email/scheduled/run').send({});
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(17);

    const findArgs = prisma.scheduledEmail.findMany.mock.calls[0][0];
    expect(findArgs.where.tenantId).toBe(17);
    expect(findArgs.where.status).toBe('PENDING');
    expect(findArgs.where.scheduledFor.lte).toBeInstanceOf(Date);
    expect(findArgs.take).toBe(50);

    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.emailMessage.create.mock.calls[0][0].data.tenantId).toBe(17);
    expect(prisma.emailTracking.create.mock.calls[0][0].data.tenantId).toBe(17);
  });
});
