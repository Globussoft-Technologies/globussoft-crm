// @ts-check
/**
 * Unit + integration tests for backend/routes/communications.js — pins the
 * cc/bcc persistence + folder filter + outbound-direction contracts that
 * close GitHub issues #623 and #624.
 *
 * Issue context
 * ─────────────
 *   #623 — Inbox composer had no Cc/Bcc fields. Backend POST /send-email
 *          accepted only `to`/`subject`/`body`/`contactId`; cc/bcc were
 *          silently dropped at the route boundary AND the EmailMessage
 *          schema had no cc/bcc columns to land them in even if they
 *          had reached the persistence layer.
 *
 *   #624 — Sent folder remained empty even with retention ON. Root cause
 *          was twofold: (a) GET /api/communications/inbox returned every
 *          row regardless of direction (no folder filter surface), and
 *          (b) the Inbox UI had no Sent sub-tab so OUTBOUND-only mail
 *          could not be queried for. The persist step itself was already
 *          correct (rows were always written with direction='OUTBOUND'),
 *          so the symptom was UI/query, not write.
 *
 * What this file pins
 * ───────────────────
 *   1. parseRecipients — comma-split, trim, dedupe-lowercase, drop-empty
 *      contract preserved (existing #435 behaviour, retained as the
 *      single shared helper for to/cc/bcc parsing).
 *   2. isValidEmail — rfc-loose probe, the same predicate used to
 *      pre-flight cc/bcc lists before persist.
 *   3. POST /send-email accepts cc/bcc as comma-separated strings AND
 *      arrays, persists them to EmailMessage.cc / EmailMessage.bcc as
 *      single normalized strings (joined with ', ' so they round-trip
 *      identically to the parseRecipients output).
 *   4. POST /send-email persists EmailMessage with direction='OUTBOUND'
 *      so #624's Sent-folder query will surface the row (regression
 *      pin: any future "let's compute direction client-side" refactor
 *      breaks this test).
 *   5. GET /inbox?folder=sent filters where direction='OUTBOUND'.
 *      GET /inbox?folder=inbox filters where direction='INBOUND'.
 *      GET /inbox without `folder` returns both (back-compat).
 *   6. Invalid cc/bcc addresses are surfaced in the `failures` array
 *      but do NOT block a valid To-line send (cc/bcc are non-blocking).
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/integration/stripe-webhook.test.js's prisma
 *   singleton-monkey-patch — the route's `require('../lib/prisma')` would
 *   otherwise hit the real DB on a vitest run with no MySQL up. We patch
 *   prisma.emailMessage / prisma.emailTracking / prisma.activity with
 *   vi.fn() before mounting the router. SendGrid is mocked at the env-
 *   var level (no SENDGRID_API_KEY → `sent:false, reason:'no_api_key'`,
 *   the same path CI hits today; the route still persists the row so
 *   the OUTBOUND assertions remain testable).
 *
 * Why two test tiers in one file
 * ──────────────────────────────
 *   The pure-helper unit tests (parseRecipients / isValidEmail) run in
 *   <1ms and pin the building blocks. The route-level integration tests
 *   pin the assembly: that the parsed cc/bcc actually flow into the
 *   prisma.emailMessage.create call shape. A bug in parseRecipients
 *   would surface in the unit layer; a bug in the route's data-mapping
 *   surfaces only in the integration layer. Both matter.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching — same pattern as stripe-webhook.test.js.
// Must happen BEFORE the router is required, since the router's top-level
// `require('../lib/prisma')` resolves at import time.
prisma.emailMessage = {
  create: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
};
prisma.emailTracking = {
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
};
prisma.activity = {
  create: vi.fn(),
};

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Strip SENDGRID_API_KEY for these tests so the route falls into the
// `no_api_key` branch — we don't want any outbound HTTP. The route still
// persists the EmailMessage row, which is exactly what we're asserting.
delete process.env.SENDGRID_API_KEY;

const communicationsRouter = requireCJS('../../routes/communications');
const { parseRecipients, isValidEmail } = communicationsRouter;

function makeApp({ tenantId = 1, userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  // Inject a fake req.user — production wires this via verifyToken
  // upstream of the router.
  app.use((req, _res, next) => {
    req.user = { userId, tenantId };
    next();
  });
  app.use('/api/communications', communicationsRouter);
  return app;
}

beforeEach(() => {
  prisma.emailMessage.create.mockReset();
  prisma.emailMessage.findMany.mockReset();
  prisma.emailTracking.create.mockReset();
  prisma.activity.create.mockReset();
  // Default: every create resolves with a stub row.
  prisma.emailMessage.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: 1001, ...data, createdAt: new Date() })
  );
  prisma.emailTracking.create.mockResolvedValue({ id: 1, trackingId: 'stub' });
  prisma.activity.create.mockResolvedValue({ id: 1 });
  prisma.emailMessage.findMany.mockResolvedValue([]);
});

// ─── parseRecipients (pure helper) ──────────────────────────────────

describe('parseRecipients — comma-split + dedupe', () => {
  test('single email passes through trimmed', () => {
    expect(parseRecipients('alice@example.com')).toEqual(['alice@example.com']);
    expect(parseRecipients('  alice@example.com  ')).toEqual(['alice@example.com']);
  });

  test('comma-separated splits + drops empties', () => {
    expect(parseRecipients('a@x.com, b@x.com,, c@x.com,')).toEqual([
      'a@x.com', 'b@x.com', 'c@x.com',
    ]);
  });

  test('case-insensitive dedupe (preserves first-seen casing)', () => {
    expect(parseRecipients('Alice@x.com, alice@x.com, ALICE@x.com')).toEqual(['Alice@x.com']);
  });

  test('non-string returns empty array', () => {
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients(null)).toEqual([]);
    expect(parseRecipients(42)).toEqual([]);
  });

  test('empty / whitespace-only string returns empty array', () => {
    expect(parseRecipients('')).toEqual([]);
    expect(parseRecipients('   ')).toEqual([]);
    expect(parseRecipients(', , ,')).toEqual([]);
  });
});

// ─── isValidEmail (pure helper) ─────────────────────────────────────

describe('isValidEmail — rfc-loose probe', () => {
  test('accepts ordinary addresses', () => {
    expect(isValidEmail('a@b.com')).toBe(true);
    expect(isValidEmail('a.b+c@example.co.in')).toBe(true);
  });

  test('rejects malformed addresses', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('also-bad@')).toBe(false);
    expect(isValidEmail('@nope.com')).toBe(false);
    expect(isValidEmail('a b@c.com')).toBe(false);
  });
});

// ─── POST /send-email — cc/bcc persistence (#623) ──────────────────

describe('POST /send-email — #623 cc/bcc persistence', () => {
  test('persists cc + bcc as comma-joined strings on the EmailMessage row', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/communications/send-email')
      .send({
        to: 'primary@example.com',
        cc: 'cc1@example.com, cc2@example.com',
        bcc: 'bcc1@example.com',
        subject: 'with-carbon-copy',
        body: 'hello',
      });
    expect(res.status).toBe(200);
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    const createArgs = prisma.emailMessage.create.mock.calls[0][0];
    expect(createArgs.data.to).toBe('primary@example.com');
    expect(createArgs.data.cc).toBe('cc1@example.com, cc2@example.com');
    expect(createArgs.data.bcc).toBe('bcc1@example.com');
  });

  test('cc/bcc accepted as array (UI may pass either shape)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/communications/send-email')
      .send({
        to: 'primary@example.com',
        cc: ['x@example.com', 'y@example.com'],
        bcc: ['z@example.com'],
        subject: 'array-cc',
        body: 'hello',
      });
    expect(res.status).toBe(200);
    const createArgs = prisma.emailMessage.create.mock.calls[0][0];
    expect(createArgs.data.cc).toBe('x@example.com, y@example.com');
    expect(createArgs.data.bcc).toBe('z@example.com');
  });

  test('omitted cc/bcc → null (not empty string) so the optional column stays NULL', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/communications/send-email')
      .send({
        to: 'primary@example.com',
        subject: 'no-carbon-copy',
        body: 'hello',
      });
    expect(res.status).toBe(200);
    const createArgs = prisma.emailMessage.create.mock.calls[0][0];
    expect(createArgs.data.cc).toBeNull();
    expect(createArgs.data.bcc).toBeNull();
  });

  test('invalid cc address surfaces in failures but does NOT block the send', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/communications/send-email')
      .send({
        to: 'primary@example.com',
        cc: 'bad-cc, good-cc@example.com',
        subject: 'partial-cc-fail',
        body: 'hello',
      });
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.success).toBe(true);
    expect(body.failures.some(f => f.to === 'bad-cc' && f.reason === 'invalid_cc_email')).toBe(true);
    // Valid cc address still persisted.
    const createArgs = prisma.emailMessage.create.mock.calls[0][0];
    expect(createArgs.data.cc).toBe('good-cc@example.com');
  });

  test('invalid bcc address surfaces in failures with reason=invalid_bcc_email', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/communications/send-email')
      .send({
        to: 'primary@example.com',
        bcc: 'no-at-sign-here',
        subject: 'bad-bcc',
        body: 'hello',
      });
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.failures.some(f => f.to === 'no-at-sign-here' && f.reason === 'invalid_bcc_email')).toBe(true);
  });
});

// ─── POST /send-email — direction='OUTBOUND' (#624) ────────────────

describe('POST /send-email — #624 outbound persistence', () => {
  test('persists EmailMessage with direction=OUTBOUND on every send', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/communications/send-email')
      .send({
        to: 'sent-folder-probe@example.com',
        subject: 'outbound-pin',
        body: 'hello',
      });
    expect(res.status).toBe(200);
    expect(prisma.emailMessage.create).toHaveBeenCalled();
    const createArgs = prisma.emailMessage.create.mock.calls[0][0];
    // Pinning this is the entire point of #624 — the Sent folder query
    // filters on direction='OUTBOUND'. If anyone "refactors" this to a
    // null direction or 'OUTGOING' string, the Sent folder breaks again.
    expect(createArgs.data.direction).toBe('OUTBOUND');
    expect(createArgs.data.read).toBe(true);
    expect(createArgs.data.tenantId).toBe(1);
  });

  test('multi-recipient send writes one OUTBOUND row per deliverable recipient', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/communications/send-email')
      .send({
        to: 'a@x.com, b@x.com, c@x.com',
        subject: 'fan-out',
        body: 'hello',
      });
    expect(res.status).toBe(200);
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(3);
    for (const call of prisma.emailMessage.create.mock.calls) {
      expect(call[0].data.direction).toBe('OUTBOUND');
    }
  });
});

// ─── GET /inbox?folder=… — Sent folder query (#624) ────────────────

describe('GET /inbox — #624 folder filter', () => {
  test('?folder=sent filters where direction=OUTBOUND', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/communications/inbox?folder=sent');
    expect(res.status).toBe(200);
    expect(prisma.emailMessage.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(1);
    expect(args.where.direction).toBe('OUTBOUND');
  });

  test('?folder=inbox filters where direction=INBOUND', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/communications/inbox?folder=inbox');
    expect(res.status).toBe(200);
    const args = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(args.where.direction).toBe('INBOUND');
  });

  test('omitting folder returns both directions (back-compat)', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/communications/inbox');
    expect(res.status).toBe(200);
    const args = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(1);
    // No direction filter on the where clause.
    expect(args.where.direction).toBeUndefined();
  });

  test('Sent folder roundtrip — a freshly-sent OUTBOUND row appears in ?folder=sent', async () => {
    const app = makeApp();
    // 1. Send.
    const sent = await request(app)
      .post('/api/communications/send-email')
      .send({
        to: 'roundtrip@example.com',
        subject: 'sent-folder-roundtrip',
        body: 'hello',
      });
    expect(sent.status).toBe(200);
    const createdRow = prisma.emailMessage.create.mock.calls[0][0].data;
    expect(createdRow.direction).toBe('OUTBOUND');

    // 2. Now configure findMany to behave like a real DB: return only
    //    OUTBOUND rows when the where-clause says so.
    prisma.emailMessage.findMany.mockImplementation(({ where }) => {
      const allRows = [
        { id: 1, ...createdRow, contact: null },
        { id: 2, direction: 'INBOUND', subject: 'inbound-noise', contact: null },
      ];
      if (where.direction === 'OUTBOUND') {
        return Promise.resolve(allRows.filter(r => r.direction === 'OUTBOUND'));
      }
      if (where.direction === 'INBOUND') {
        return Promise.resolve(allRows.filter(r => r.direction === 'INBOUND'));
      }
      return Promise.resolve(allRows);
    });

    // 3. Sent folder query returns the OUTBOUND row only.
    const sentRes = await request(app).get('/api/communications/inbox?folder=sent');
    expect(sentRes.status).toBe(200);
    expect(Array.isArray(sentRes.body)).toBe(true);
    expect(sentRes.body.length).toBe(1);
    expect(sentRes.body[0].subject).toBe('sent-folder-roundtrip');
    expect(sentRes.body[0].direction).toBe('OUTBOUND');
  });
});
