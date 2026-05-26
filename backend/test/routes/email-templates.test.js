// @ts-check
/**
 * Unit tests for backend/routes/email_templates.js — pins the EmailTemplate
 * CRUD contract used by the Inbox / Sequences / Marketing surfaces.
 *
 * Why this file exists
 * --------------------
 *   The route is 88 LOC and previously had ZERO direct vitest coverage at the
 *   route level. The frontend EmailTemplates page (and the Sequences picker)
 *   destructure { id, name, subject, body, category, updatedAt } from the list
 *   endpoint; any silent contract drift (envelope reshape, validation-code
 *   rename, missing tenant scope) would silently break those surfaces.
 *
 * Auth model
 * ----------
 *   The route file has NO local auth middleware — protection is provided by
 *   the global verifyToken gate mounted in server.js. For these unit tests
 *   the router is mounted under a tiny pass-through middleware that wires
 *   req.user = { userId, tenantId, role }, matching the production surface
 *   the handlers actually read.
 *
 * What's pinned (9 cases across 6 describe blocks)
 * ------------------------------------------------
 *   GET / (list):
 *    1. tenant-scoped findMany — where: { tenantId } passed to prisma
 *    2. returns the list in updatedAt-desc order envelope
 *
 *   GET /:id:
 *    3. cross-tenant template → 404 "Template not found"
 *
 *   POST / (create):
 *    4. missing name/subject/body → 400 with "required" error message
 *    5. happy path — defaults category="General" when omitted, persists
 *       tenantId from req.user.tenantId, returns 201
 *
 *   PUT /:id (update):
 *    6. cross-tenant id → 404 "Template not found" (existing check before update)
 *    7. happy path — partial update only sends defined fields to prisma
 *
 *   DELETE /:id:
 *    8. happy path → { success: true } envelope
 *
 *   Auth gate:
 *    9. no req.user → 500 (handler reads req.user.tenantId, throws) —
 *       documents that the route relies on the global gate, not local auth
 *
 * Test pattern
 * ------------
 *   Mirrors backend/test/routes/consent-templates.test.js — patch the prisma
 *   singleton with vi.fn() shapes BEFORE requiring the router so the route's
 *   top-level `require("../lib/prisma")` resolves to the stub. Drive via
 *   supertest. No real DB.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Stub the prisma surface the email_templates router touches.
prisma.emailTemplate = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const router = requireCJS('../../routes/email_templates');

function makeApp({ user = { userId: 7, tenantId: 1, role: 'ADMIN' } } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use('/api/email_templates', router);
  return app;
}

beforeEach(() => {
  prisma.emailTemplate.findMany.mockReset();
  prisma.emailTemplate.findFirst.mockReset();
  prisma.emailTemplate.create.mockReset();
  prisma.emailTemplate.update.mockReset();
  prisma.emailTemplate.delete.mockReset();
});

describe('GET /api/email_templates — list', () => {
  test('tenant-scoped findMany with updatedAt desc + returns rows', async () => {
    const rows = [
      { id: 11, name: 'Welcome', subject: 'Hi {{name}}', body: 'Hello', category: 'General', tenantId: 1, updatedAt: new Date('2026-05-01').toISOString() },
      { id: 12, name: 'Follow-up', subject: 'Re: {{deal}}', body: 'Body', category: 'Sales', tenantId: 1, updatedAt: new Date('2026-04-15').toISOString() },
    ];
    prisma.emailTemplate.findMany.mockResolvedValueOnce(rows);

    const app = makeApp();
    const res = await request(app).get('/api/email_templates');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);

    expect(prisma.emailTemplate.findMany).toHaveBeenCalledOnce();
    const args = prisma.emailTemplate.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 1 });
    expect(args.orderBy).toEqual({ updatedAt: 'desc' });
  });

  test('500 on prisma failure with "Failed to fetch" message', async () => {
    prisma.emailTemplate.findMany.mockRejectedValueOnce(new Error('connection lost'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = makeApp();
    const res = await request(app).get('/api/email_templates');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch email templates' });
    errSpy.mockRestore();
  });
});

describe('GET /api/email_templates/:id — single', () => {
  test('cross-tenant template → 404 Template not found', async () => {
    // Tenant 1 asks for id 99, which belongs to tenant 2 — findFirst returns
    // null because the WHERE clause is { id, tenantId } so the row is invisible.
    prisma.emailTemplate.findFirst.mockResolvedValueOnce(null);

    const app = makeApp({ user: { userId: 7, tenantId: 1, role: 'ADMIN' } });
    const res = await request(app).get('/api/email_templates/99');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Template not found' });

    // Verify the tenant scope was applied — this is the actual isolation check.
    const where = prisma.emailTemplate.findFirst.mock.calls[0][0].where;
    expect(where.tenantId).toBe(1);
    expect(where.id).toBe(99);
  });

  test('happy path — returns the template body', async () => {
    const row = { id: 11, name: 'Welcome', subject: 'Hi', body: 'Hello', category: 'General', tenantId: 1 };
    prisma.emailTemplate.findFirst.mockResolvedValueOnce(row);

    const app = makeApp();
    const res = await request(app).get('/api/email_templates/11');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(row);
  });
});

describe('POST /api/email_templates — create', () => {
  test('missing name → 400 "name, subject, and body are required"', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/email_templates')
      .send({ subject: 'S', body: 'B' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'name, subject, and body are required' });
    expect(prisma.emailTemplate.create).not.toHaveBeenCalled();
  });

  test('missing subject → 400 same error envelope', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/email_templates')
      .send({ name: 'N', body: 'B' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
    expect(prisma.emailTemplate.create).not.toHaveBeenCalled();
  });

  test('missing body → 400 same error envelope', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/email_templates')
      .send({ name: 'N', subject: 'S' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
    expect(prisma.emailTemplate.create).not.toHaveBeenCalled();
  });

  test('happy path — defaults category="General" + persists tenantId from req.user', async () => {
    const created = {
      id: 42, name: 'Welcome', subject: 'Hi {{name}}', body: 'Hello there',
      category: 'General', tenantId: 1,
    };
    prisma.emailTemplate.create.mockResolvedValueOnce(created);

    const app = makeApp({ user: { userId: 7, tenantId: 1, role: 'ADMIN' } });
    const res = await request(app)
      .post('/api/email_templates')
      .send({ name: 'Welcome', subject: 'Hi {{name}}', body: 'Hello there' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);

    expect(prisma.emailTemplate.create).toHaveBeenCalledOnce();
    const data = prisma.emailTemplate.create.mock.calls[0][0].data;
    expect(data.name).toBe('Welcome');
    expect(data.subject).toBe('Hi {{name}}');
    expect(data.body).toBe('Hello there');
    expect(data.category).toBe('General'); // default
    expect(data.tenantId).toBe(1);         // from req.user.tenantId
  });

  test('explicit category honoured over default', async () => {
    prisma.emailTemplate.create.mockResolvedValueOnce({ id: 43 });

    const app = makeApp();
    await request(app)
      .post('/api/email_templates')
      .send({ name: 'X', subject: 'Y', body: 'Z', category: 'Sales' });

    const data = prisma.emailTemplate.create.mock.calls[0][0].data;
    expect(data.category).toBe('Sales');
  });
});

describe('PUT /api/email_templates/:id — update', () => {
  test('cross-tenant id → 404 + zero update call', async () => {
    prisma.emailTemplate.findFirst.mockResolvedValueOnce(null);

    const app = makeApp({ user: { userId: 7, tenantId: 1, role: 'ADMIN' } });
    const res = await request(app)
      .put('/api/email_templates/99')
      .send({ name: 'New Name' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Template not found' });
    expect(prisma.emailTemplate.update).not.toHaveBeenCalled();

    // The pre-update existence check is tenant-scoped.
    const where = prisma.emailTemplate.findFirst.mock.calls[0][0].where;
    expect(where.tenantId).toBe(1);
    expect(where.id).toBe(99);
  });

  test('happy path — only defined fields are forwarded to prisma.update', async () => {
    const existing = { id: 11, name: 'Old', subject: 'Old S', body: 'Old B', category: 'General', tenantId: 1 };
    prisma.emailTemplate.findFirst.mockResolvedValueOnce(existing);
    prisma.emailTemplate.update.mockResolvedValueOnce({ ...existing, name: 'New' });

    const app = makeApp();
    const res = await request(app)
      .put('/api/email_templates/11')
      .send({ name: 'New' }); // only name; subject/body/category undefined

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');

    const data = prisma.emailTemplate.update.mock.calls[0][0].data;
    expect(data).toEqual({ name: 'New' });          // ONLY name — partial update
    expect(data.subject).toBeUndefined();
    expect(data.body).toBeUndefined();
    expect(data.category).toBeUndefined();

    // update WHERE clause uses the inner id from the pre-check row, not raw params.
    expect(prisma.emailTemplate.update.mock.calls[0][0].where).toEqual({ id: 11 });
  });
});

describe('DELETE /api/email_templates/:id', () => {
  test('cross-tenant id → 404 + zero delete call', async () => {
    prisma.emailTemplate.findFirst.mockResolvedValueOnce(null);

    const app = makeApp();
    const res = await request(app).delete('/api/email_templates/99');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Template not found' });
    expect(prisma.emailTemplate.delete).not.toHaveBeenCalled();
  });

  test('happy path → { success: true } envelope + tenant-scoped existence check', async () => {
    prisma.emailTemplate.findFirst.mockResolvedValueOnce({ id: 11, tenantId: 1 });
    prisma.emailTemplate.delete.mockResolvedValueOnce({ id: 11 });

    const app = makeApp({ user: { userId: 7, tenantId: 1, role: 'ADMIN' } });
    const res = await request(app).delete('/api/email_templates/11');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.emailTemplate.delete).toHaveBeenCalledOnce();

    const where = prisma.emailTemplate.findFirst.mock.calls[0][0].where;
    expect(where.tenantId).toBe(1);
  });
});

describe('GET /api/email_templates?fields=summary — #920 slice 9 slim-shape opt-in', () => {
  // Mirrors slices 1-7. Pins:
  //   (a) ?fields=summary forwards a slim Prisma `select` that drops the
  //       heavy `body` column (@db.Text, multi-KB HTML payloads).
  //   (b) absent / unknown ?fields values stay on the full-row default
  //       (back-compat — existing callers like SequenceBuilder must keep
  //       receiving the full shape).
  //   (c) tenant scope + orderBy contract is preserved on the summary branch.

  test('?fields=summary forwards slim select dropping body', async () => {
    const rows = [
      { id: 11, name: 'Welcome', subject: 'Hi', category: 'General', tenantId: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ];
    prisma.emailTemplate.findMany.mockResolvedValueOnce(rows);

    const app = makeApp();
    const res = await request(app).get('/api/email_templates?fields=summary');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);

    const args = prisma.emailTemplate.findMany.mock.calls[0][0];
    expect(args.select).toBeDefined();
    expect(args.select).toEqual({
      id: true,
      name: true,
      subject: true,
      category: true,
      tenantId: true,
      createdAt: true,
      updatedAt: true,
    });
    // body is intentionally absent — that's the whole point of the slim shape.
    expect(args.select.body).toBeUndefined();
  });

  test('default (no ?fields) does NOT forward select — back-compat preserved', async () => {
    prisma.emailTemplate.findMany.mockResolvedValueOnce([]);

    const app = makeApp();
    await request(app).get('/api/email_templates');

    const args = prisma.emailTemplate.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
    // Full-row shape — Prisma returns every scalar column including `body`.
  });

  test('?fields=anythingElse falls back to full-row shape (exact match only)', async () => {
    prisma.emailTemplate.findMany.mockResolvedValueOnce([]);

    const app = makeApp();
    await request(app).get('/api/email_templates?fields=full');

    const args = prisma.emailTemplate.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
  });

  test('?fields=SUMMARY (uppercase) falls back to full-row — case-sensitive opt-in', async () => {
    prisma.emailTemplate.findMany.mockResolvedValueOnce([]);

    const app = makeApp();
    await request(app).get('/api/email_templates?fields=SUMMARY');

    const args = prisma.emailTemplate.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
  });

  test('?fields=summary preserves tenant scope + updatedAt-desc order', async () => {
    prisma.emailTemplate.findMany.mockResolvedValueOnce([]);

    const app = makeApp({ user: { userId: 7, tenantId: 42, role: 'ADMIN' } });
    await request(app).get('/api/email_templates?fields=summary');

    const args = prisma.emailTemplate.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 42 });
    expect(args.orderBy).toEqual({ updatedAt: 'desc' });
    expect(args.select).toBeDefined(); // slim-shape branch fired
  });
});

describe('Auth surface — req.user contract', () => {
  // The route itself has NO local auth middleware; protection is via the
  // global verifyToken gate in server.js. These tests document that contract:
  // when req.user is absent (i.e. the global gate would have already 401'd),
  // the route handlers throw because they read req.user.tenantId — they
  // surface as 500 rather than 401, which is correct given the global gate
  // is the only protection layer.
  test('absent req.user → 500 (route relies on global gate, not local auth)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = makeApp({ user: null });
    const res = await request(app).get('/api/email_templates');

    // Reading req.user.tenantId throws → caught by route catch → 500.
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to fetch/);
    expect(prisma.emailTemplate.findMany).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });
});
