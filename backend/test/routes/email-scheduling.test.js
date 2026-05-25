// @ts-check
/**
 * Unit + integration tests for backend/routes/email_scheduling.js — pins the
 * ScheduledEmail CRUD, signature, cancel, and send-now flows.
 *
 * What this file pins
 * ───────────────────
 *   1. GET /signature returns the current user's signature (empty string when
 *      unset) — tenant-isolated via req.user.userId.
 *   2. PUT /signature validates `signature` is a string (400 on non-string)
 *      and persists via prisma.user.update.
 *   3. GET / lists ScheduledEmail rows scoped to req.user.tenantId, applies
 *      the 7-day default window unless ?all is set, and uppercases
 *      ?status filter values.
 *   4. POST / requires {to, subject, body, scheduledFor}, rejects invalid
 *      ISO dates, rejects past timestamps, appends the user's signature when
 *      one is set, and writes the row with status=PENDING + the calling
 *      tenant + user.
 *   5. GET /:id returns 404 for missing OR cross-tenant rows (tenant scope
 *      enforced via findFirst's where clause).
 *   6. DELETE /:id behaves identically — 404 on cross-tenant.
 *   7. POST /:id/cancel only flips PENDING → CANCELED (400 otherwise) and
 *      returns the updated row.
 *   8. POST /:id/send-now stable-code contract (#524):
 *        - 404 + code=SCHEDULED_EMAIL_NOT_FOUND for missing rows.
 *        - 400 + code=ALREADY_SENT when status='SENT'.
 *        - 200 + {success:false, code:'SENDGRID_NOT_CONFIGURED'} when the
 *          API key env-var is absent (status code intentionally NOT 5xx —
 *          Cloudflare/Nginx swallow backend 5xx bodies, so the contract is
 *          {code} discriminator in a 200 envelope; truly-internal failures
 *          stay 5xx).
 *        - row marked FAILED with errorMessage on provider rejection.
 *
 * Test pattern
 * ────────────
 *   Mirrors backend/test/routes/communications.test.js — the prisma
 *   singleton is monkey-patched BEFORE the router is required (CJS top-level
 *   `require('../lib/prisma')` resolves at import time). Per-call mocks are
 *   reset in beforeEach so cross-test state can't leak.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching — must happen BEFORE the router is required.
prisma.scheduledEmail = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.user.update = vi.fn();
prisma.emailMessage = prisma.emailMessage || {};
prisma.emailMessage.create = vi.fn();
prisma.emailTracking = prisma.emailTracking || {};
prisma.emailTracking.create = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Strip SENDGRID_API_KEY so send-now hits the no_api_key → SENDGRID_NOT_CONFIGURED
// branch. The route still persists the EmailMessage row + marks the record FAILED
// — both of which we assert below.
delete process.env.SENDGRID_API_KEY;

const router = requireCJS('../../routes/email_scheduling');

function makeApp({ tenantId = 1, userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId };
    next();
  });
  app.use('/api/email-scheduling', router);
  return app;
}

beforeEach(() => {
  prisma.scheduledEmail.findMany.mockReset();
  prisma.scheduledEmail.findFirst.mockReset();
  prisma.scheduledEmail.create.mockReset();
  prisma.scheduledEmail.update.mockReset();
  prisma.scheduledEmail.delete.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.user.update.mockReset();
  prisma.emailMessage.create.mockReset();
  prisma.emailTracking.create.mockReset();

  // Defaults — keep the happy paths green.
  prisma.scheduledEmail.findMany.mockResolvedValue([]);
  prisma.user.findUnique.mockResolvedValue({ id: 7, emailSignature: '' });
  prisma.user.update.mockImplementation(({ data }) =>
    Promise.resolve({ id: 7, emailSignature: data.emailSignature })
  );
  prisma.scheduledEmail.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: 99, ...data })
  );
  prisma.scheduledEmail.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ id: where.id, ...data })
  );
  prisma.scheduledEmail.delete.mockResolvedValue({ id: 99 });
  prisma.emailMessage.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: 1234, ...data })
  );
  prisma.emailTracking.create.mockResolvedValue({ id: 1 });
});

// ─── GET /signature ─────────────────────────────────────────────────

describe('GET /signature', () => {
  test('returns the current user signature', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 7,
      emailSignature: 'Best,\nSumit',
    });
    const res = await request(makeApp()).get('/api/email-scheduling/signature');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signature: 'Best,\nSumit' });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { id: true, emailSignature: true },
    });
  });

  test('returns empty string when user has no signature set', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 7, emailSignature: null });
    const res = await request(makeApp()).get('/api/email-scheduling/signature');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signature: '' });
  });
});

// ─── PUT /signature ─────────────────────────────────────────────────

describe('PUT /signature', () => {
  test('persists the new signature and echoes it back', async () => {
    const res = await request(makeApp())
      .put('/api/email-scheduling/signature')
      .send({ signature: '— Sumit\nGlobussoft' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signature: '— Sumit\nGlobussoft' });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { emailSignature: '— Sumit\nGlobussoft' },
      select: { id: true, emailSignature: true },
    });
  });

  test('rejects non-string signature with 400', async () => {
    const res = await request(makeApp())
      .put('/api/email-scheduling/signature')
      .send({ signature: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/string/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

// ─── GET / (list) ───────────────────────────────────────────────────

describe('GET / — list scheduled emails', () => {
  test('default scope is current tenant + next 7 days, no status filter', async () => {
    const res = await request(makeApp()).get('/api/email-scheduling');
    expect(res.status).toBe(200);
    expect(prisma.scheduledEmail.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.scheduledEmail.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(1);
    expect(args.where.scheduledFor).toBeDefined();
    expect(args.where.scheduledFor.gte).toBeInstanceOf(Date);
    expect(args.where.scheduledFor.lte).toBeInstanceOf(Date);
    const windowMs = args.where.scheduledFor.lte.getTime() - args.where.scheduledFor.gte.getTime();
    // Should be ~7 days; allow loose tolerance for clock drift between assertions.
    expect(windowMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(windowMs).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);
    expect(args.where.status).toBeUndefined();
    expect(args.orderBy).toEqual({ scheduledFor: 'asc' });
    expect(args.take).toBe(200);
  });

  test('?all=1 removes the 7-day window', async () => {
    const res = await request(makeApp()).get('/api/email-scheduling?all=1');
    expect(res.status).toBe(200);
    const args = prisma.scheduledEmail.findMany.mock.calls[0][0];
    expect(args.where.scheduledFor).toBeUndefined();
  });

  test('?status=pending is uppercased before query', async () => {
    const res = await request(makeApp()).get('/api/email-scheduling?status=pending&all=1');
    expect(res.status).toBe(200);
    const args = prisma.scheduledEmail.findMany.mock.calls[0][0];
    expect(args.where.status).toBe('PENDING');
  });
});

// ─── POST / (create) ────────────────────────────────────────────────

describe('POST / — schedule an email', () => {
  const futureIso = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  test('400 when required fields are missing', async () => {
    const res = await request(makeApp())
      .post('/api/email-scheduling')
      .send({ to: 'a@b.com', subject: 'hi' /* no body, no scheduledFor */ });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
    expect(prisma.scheduledEmail.create).not.toHaveBeenCalled();
  });

  test('400 when scheduledFor is not a valid ISO date', async () => {
    const res = await request(makeApp())
      .post('/api/email-scheduling')
      .send({
        to: 'a@b.com',
        subject: 'hi',
        body: 'hello',
        scheduledFor: 'totally-not-a-date',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid ISO date/i);
  });

  test('400 when scheduledFor is in the past', async () => {
    const res = await request(makeApp())
      .post('/api/email-scheduling')
      .send({
        to: 'a@b.com',
        subject: 'hi',
        body: 'hello',
        scheduledFor: new Date(Date.now() - 60_000).toISOString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/);
  });

  test('persists row with PENDING status, current tenant + user, contactId parsed', async () => {
    const res = await request(makeApp())
      .post('/api/email-scheduling')
      .send({
        to: 'recipient@example.com',
        subject: 'follow-up',
        body: 'Hi there.',
        scheduledFor: futureIso(),
        contactId: '42',
      });
    expect(res.status).toBe(201);
    expect(prisma.scheduledEmail.create).toHaveBeenCalledTimes(1);
    const data = prisma.scheduledEmail.create.mock.calls[0][0].data;
    expect(data.to).toBe('recipient@example.com');
    expect(data.subject).toBe('follow-up');
    expect(data.body).toBe('Hi there.'); // signature is empty by default
    expect(data.status).toBe('PENDING');
    expect(data.tenantId).toBe(1);
    expect(data.userId).toBe(7);
    expect(data.contactId).toBe(42); // parseInt
    expect(data.scheduledFor).toBeInstanceOf(Date);
  });

  test('appends the user signature when one is set', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ emailSignature: '— Best,\nDr. Harsh' });
    const res = await request(makeApp())
      .post('/api/email-scheduling')
      .send({
        to: 'patient@example.com',
        subject: 'visit recap',
        body: 'Thanks for coming in.',
        scheduledFor: futureIso(),
      });
    expect(res.status).toBe(201);
    const data = prisma.scheduledEmail.create.mock.calls[0][0].data;
    expect(data.body).toBe('Thanks for coming in.\n\n— Best,\nDr. Harsh');
  });

  test('does NOT double-append when signature is whitespace-only', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ emailSignature: '   \n   ' });
    const res = await request(makeApp())
      .post('/api/email-scheduling')
      .send({
        to: 'x@y.com',
        subject: 's',
        body: 'plain body',
        scheduledFor: futureIso(),
      });
    expect(res.status).toBe(201);
    const data = prisma.scheduledEmail.create.mock.calls[0][0].data;
    expect(data.body).toBe('plain body');
  });
});

// ─── GET /:id ───────────────────────────────────────────────────────

describe('GET /:id', () => {
  test('returns the record when found in tenant', async () => {
    prisma.scheduledEmail.findFirst.mockResolvedValueOnce({
      id: 99,
      to: 'a@b.com',
      tenantId: 1,
      status: 'PENDING',
    });
    const res = await request(makeApp()).get('/api/email-scheduling/99');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(99);
    const args = prisma.scheduledEmail.findFirst.mock.calls[0][0];
    expect(args.where).toEqual({ id: 99, tenantId: 1 });
  });

  test('404 when record belongs to a different tenant (findFirst returns null)', async () => {
    prisma.scheduledEmail.findFirst.mockResolvedValueOnce(null);
    const res = await request(makeApp({ tenantId: 2 })).get('/api/email-scheduling/99');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ─── DELETE /:id ────────────────────────────────────────────────────

describe('DELETE /:id', () => {
  test('deletes the row when found and returns success:true', async () => {
    prisma.scheduledEmail.findFirst.mockResolvedValueOnce({ id: 99, tenantId: 1 });
    const res = await request(makeApp()).delete('/api/email-scheduling/99');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.scheduledEmail.delete).toHaveBeenCalledWith({ where: { id: 99 } });
  });

  test('404 when row is missing OR cross-tenant', async () => {
    prisma.scheduledEmail.findFirst.mockResolvedValueOnce(null);
    const res = await request(makeApp()).delete('/api/email-scheduling/99');
    expect(res.status).toBe(404);
    expect(prisma.scheduledEmail.delete).not.toHaveBeenCalled();
  });
});

// ─── POST /:id/cancel ───────────────────────────────────────────────

describe('POST /:id/cancel', () => {
  test('flips PENDING → CANCELED and returns the updated row', async () => {
    prisma.scheduledEmail.findFirst.mockResolvedValueOnce({
      id: 99,
      tenantId: 1,
      status: 'PENDING',
    });
    const res = await request(makeApp()).post('/api/email-scheduling/99/cancel');
    expect(res.status).toBe(200);
    expect(prisma.scheduledEmail.update).toHaveBeenCalledWith({
      where: { id: 99 },
      data: { status: 'CANCELED' },
    });
    expect(res.body.status).toBe('CANCELED');
  });

  test('refuses to cancel an already-SENT email with 400', async () => {
    prisma.scheduledEmail.findFirst.mockResolvedValueOnce({
      id: 99,
      tenantId: 1,
      status: 'SENT',
    });
    const res = await request(makeApp()).post('/api/email-scheduling/99/cancel');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SENT/);
    expect(prisma.scheduledEmail.update).not.toHaveBeenCalled();
  });

  test('404 when the row is missing or cross-tenant', async () => {
    prisma.scheduledEmail.findFirst.mockResolvedValueOnce(null);
    const res = await request(makeApp()).post('/api/email-scheduling/99/cancel');
    expect(res.status).toBe(404);
  });
});

// ─── POST /:id/send-now (#524 stable-code contract) ────────────────

describe('POST /:id/send-now — #524 stable-code contract', () => {
  test('404 + code=SCHEDULED_EMAIL_NOT_FOUND when row is missing', async () => {
    prisma.scheduledEmail.findFirst.mockResolvedValueOnce(null);
    const res = await request(makeApp()).post('/api/email-scheduling/99/send-now');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SCHEDULED_EMAIL_NOT_FOUND');
  });

  test('400 + code=ALREADY_SENT when status is already SENT', async () => {
    prisma.scheduledEmail.findFirst.mockResolvedValueOnce({
      id: 99,
      tenantId: 1,
      status: 'SENT',
      to: 'a@b.com',
      subject: 's',
      body: 'b',
    });
    const res = await request(makeApp()).post('/api/email-scheduling/99/send-now');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ALREADY_SENT');
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
  });

  test('200 envelope with success:false + code=SENDGRID_NOT_CONFIGURED when no API key', async () => {
    // SENDGRID_API_KEY is stripped at file load; this hits the no_api_key path.
    prisma.scheduledEmail.findFirst.mockResolvedValueOnce({
      id: 99,
      tenantId: 1,
      userId: 7,
      status: 'PENDING',
      to: 'a@b.com',
      subject: 'subject-line',
      body: 'body-text',
      contactId: null,
    });
    const res = await request(makeApp()).post('/api/email-scheduling/99/send-now');
    expect(res.status).toBe(200); // Cloudflare/Nginx swallow 5xx bodies — code is the discriminator
    expect(res.body.success).toBe(false);
    expect(res.body.delivered).toBe(false);
    expect(res.body.code).toBe('SENDGRID_NOT_CONFIGURED');
    // The EmailMessage audit row still landed.
    expect(prisma.emailMessage.create).toHaveBeenCalledTimes(1);
    const emailArgs = prisma.emailMessage.create.mock.calls[0][0];
    expect(emailArgs.data.direction).toBe('OUTBOUND');
    expect(emailArgs.data.tenantId).toBe(1);
    // The ScheduledEmail row got marked FAILED with an errorMessage.
    const updateCall = prisma.scheduledEmail.update.mock.calls.find(
      (c) => c[0].data.status === 'FAILED'
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0].data.errorMessage).toMatch(/no_api_key/);
  });
});
