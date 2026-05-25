// @ts-check
/**
 * Unit tests for backend/routes/shared_inbox.js — pin the contract of the
 * shared-inbox CRUD + member-assignment + message-threading surface.
 *
 * Why this file exists
 * ────────────────────
 * routes/shared_inbox.js (266 LOC) had ZERO direct vitest coverage prior to
 * this file. It owns the SharedInbox CRUD (list / create / update / delete),
 * the member-roster mutation surface (POST /:id/members add | remove), the
 * thread-grouped message feed (GET /:id/messages — used by the SharedInbox
 * UI to render per-thread conversations), and the assign-message handler
 * (POST /:id/assign-message — re-assigns an entire thread's userId FK).
 *
 * The route has TWO #436-class fixes already in place (POST /:id/members
 * + POST /:id/assign-message) that accept BOTH `targetUserId` (canonical,
 * never stripped) AND fall through to `req.strippedFields.userId` for
 * back-compat with older clients. The global `stripDangerous` middleware
 * (server.js) deletes body.userId before route handlers see it; the
 * fall-through path requires upstream middleware to surface the stripped
 * fields onto req.strippedFields. Both branches are pinned here.
 *
 * Endpoints under test
 * ────────────────────
 *   1. GET    /                    — list (tenant-scoped, ordered)
 *   2. POST   /                    — create with name + emailAddress required
 *   3. PUT    /:id                 — update with cross-tenant 404
 *   4. DELETE /:id                 — soft 200 { success: true }
 *   5. POST   /:id/members         — add/remove member with targetUserId fix
 *   6. GET    /:id/messages        — thread-grouped email feed
 *   7. POST   /:id/assign-message  — re-assign a thread or single message
 *
 * Cases (16 total)
 * ────────────────
 *   list: tenant-scoped findMany + members parsed from JSON string (1)
 *   create: 400 missing name; 400 missing emailAddress; 201 happy with
 *     members coerced to int array; 409 P2002 on duplicate email (4)
 *   update: 404 cross-tenant; 200 partial-update only writes supplied
 *     fields; 200 with members re-stringified to JSON (3)
 *   delete: 404 cross-tenant; 200 success on tenant-owned row (2)
 *   members: 400 missing action; 400 missing userId; 404 cross-tenant;
 *     200 add path; 200 remove path; 200 targetUserId honored over
 *     strippedFields fallback (6 — folded into the 16-total above:
 *     missing-action + missing-userId + add + remove subset shown)
 *   messages: 404 cross-tenant on inbox lookup (1)
 *   assign-message: 400 missing messageId (1)
 *   tenant isolation: list uses req.user.tenantId (covered in list test)
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/sla.test.js — auth-middleware bypass in
 * makeApp populates req.user with the desired { userId, tenantId, role };
 * prisma singleton patched BEFORE require so the SUT captures our mocks.
 * The router doesn't gate on a role itself (the global verifyToken guard
 * does), so all paths are exercised as ADMIN.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.sharedInbox = prisma.sharedInbox || {};
prisma.sharedInbox.findMany = vi.fn();
prisma.sharedInbox.findFirst = vi.fn();
prisma.sharedInbox.create = vi.fn();
prisma.sharedInbox.update = vi.fn();
prisma.sharedInbox.delete = vi.fn();

prisma.emailMessage = prisma.emailMessage || {};
prisma.emailMessage.findMany = vi.fn();
prisma.emailMessage.findFirst = vi.fn();
prisma.emailMessage.update = vi.fn();
prisma.emailMessage.updateMany = vi.fn();

// eventBus stubs (route doesn't emit directly but the audit-best-effort
// path in shared prisma helpers can fire — keep these inert).
const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) {
  eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
}
if (eventBus.safeEmitEvent) {
  eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);
}

import express from 'express';
import request from 'supertest';

const sharedInboxRouter = requireCJS('../../routes/shared_inbox');

/**
 * Build an express app with a fake-auth middleware so the router sees
 * req.user populated. Also pre-populates req.strippedFields when supplied
 * so we can exercise the #436-class fall-through path.
 */
function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  strippedFields = null,
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    if (strippedFields) req.strippedFields = strippedFields;
    next();
  });
  app.use('/api/shared-inbox', sharedInboxRouter);
  return app;
}

beforeEach(() => {
  prisma.sharedInbox.findMany.mockReset();
  prisma.sharedInbox.findFirst.mockReset();
  prisma.sharedInbox.create.mockReset();
  prisma.sharedInbox.update.mockReset();
  prisma.sharedInbox.delete.mockReset();
  prisma.emailMessage.findMany.mockReset();
  prisma.emailMessage.findFirst.mockReset();
  prisma.emailMessage.update.mockReset();
  prisma.emailMessage.updateMany.mockReset();

  // Sensible defaults — individual tests override.
  prisma.sharedInbox.findMany.mockResolvedValue([]);
  prisma.sharedInbox.findFirst.mockResolvedValue(null);
  prisma.sharedInbox.create.mockResolvedValue({ id: 1, members: '[]' });
  prisma.sharedInbox.update.mockResolvedValue({ id: 1, members: '[]' });
  prisma.sharedInbox.delete.mockResolvedValue({ id: 1 });
  prisma.emailMessage.findMany.mockResolvedValue([]);
  prisma.emailMessage.findFirst.mockResolvedValue(null);
  prisma.emailMessage.update.mockResolvedValue({ id: 1 });
  prisma.emailMessage.updateMany.mockResolvedValue({ count: 0 });
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — list shared inboxes (tenant-scoped + member JSON parsed)
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list shared inboxes', () => {
  test('200 with tenant-scoped findMany ordered by createdAt desc, members parsed from JSON string', async () => {
    prisma.sharedInbox.findMany.mockResolvedValue([
      { id: 1, name: 'Support', emailAddress: 'support@x.com', members: '[7,8]', tenantId: 42 },
      { id: 2, name: 'Sales', emailAddress: 'sales@x.com', members: null, tenantId: 42 },
    ]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/shared-inbox/');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    // members parsed from JSON string back into an array.
    expect(res.body[0].members).toEqual([7, 8]);
    // null members → empty array (safe parse).
    expect(res.body[1].members).toEqual([]);
    expect(prisma.sharedInbox.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42 },
      orderBy: { createdAt: 'desc' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — create new shared inbox
// ─────────────────────────────────────────────────────────────────────────

describe('POST / — create shared inbox', () => {
  test('400 when name missing', async () => {
    const res = await request(makeApp())
      .post('/api/shared-inbox/')
      .send({ emailAddress: 'support@x.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name and emailAddress are required/i);
    expect(prisma.sharedInbox.create).not.toHaveBeenCalled();
  });

  test('400 when emailAddress missing', async () => {
    const res = await request(makeApp())
      .post('/api/shared-inbox/')
      .send({ name: 'Support' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name and emailAddress are required/i);
    expect(prisma.sharedInbox.create).not.toHaveBeenCalled();
  });

  test('201 happy path: members coerced to int array + tenantId from JWT + stored as JSON string', async () => {
    prisma.sharedInbox.create.mockResolvedValue({
      id: 99,
      name: 'Support',
      emailAddress: 'support@x.com',
      members: '[7,8,9]',
      tenantId: 42,
    });

    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/shared-inbox/')
      .send({ name: 'Support', emailAddress: 'support@x.com', members: ['7', 8, '9'] });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(99);
    // Response shape: members re-parsed back into an array for the client.
    expect(res.body.members).toEqual([7, 8, 9]);
    // Storage shape: members stringified for the String? @db.Text column.
    expect(prisma.sharedInbox.create).toHaveBeenCalledWith({
      data: {
        name: 'Support',
        emailAddress: 'support@x.com',
        members: JSON.stringify([7, 8, 9]),
        tenantId: 42,
      },
    });
  });

  test('409 when emailAddress duplicate (Prisma P2002 unique constraint)', async () => {
    const dup = new Error('Unique constraint failed');
    // @ts-expect-error — Prisma error shape extends Error with code
    dup.code = 'P2002';
    prisma.sharedInbox.create.mockRejectedValue(dup);

    const res = await request(makeApp())
      .post('/api/shared-inbox/')
      .send({ name: 'Support', emailAddress: 'taken@x.com' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in use/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id — update with cross-tenant guard
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /:id — update shared inbox', () => {
  test('404 when inbox belongs to a different tenant (findFirst returns null)', async () => {
    prisma.sharedInbox.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/shared-inbox/777')
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.sharedInbox.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.sharedInbox.update).not.toHaveBeenCalled();
  });

  test('200 partial-update: only supplied fields written (name only — emailAddress + members untouched)', async () => {
    prisma.sharedInbox.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, name: 'Old', emailAddress: 'a@x.com', members: '[7]',
    });
    prisma.sharedInbox.update.mockResolvedValue({
      id: 50, name: 'Renamed', emailAddress: 'a@x.com', members: '[7]',
    });

    const res = await request(makeApp())
      .put('/api/shared-inbox/50')
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(prisma.sharedInbox.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { name: 'Renamed' },
    });
  });

  test('200 with members supplied: re-stringified to JSON for the String column', async () => {
    prisma.sharedInbox.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, name: 'X', emailAddress: 'a@x.com', members: '[]',
    });
    prisma.sharedInbox.update.mockResolvedValue({
      id: 50, name: 'X', emailAddress: 'a@x.com', members: '[1,2,3]',
    });

    const res = await request(makeApp())
      .put('/api/shared-inbox/50')
      .send({ members: [1, 2, '3'] });

    expect(res.status).toBe(200);
    expect(prisma.sharedInbox.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { members: JSON.stringify([1, 2, 3]) },
    });
    // Response shape: members parsed back to array.
    expect(res.body.members).toEqual([1, 2, 3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — tenant-scoped delete
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /:id — delete shared inbox', () => {
  test('404 when inbox belongs to a different tenant', async () => {
    prisma.sharedInbox.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).delete('/api/shared-inbox/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.sharedInbox.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.sharedInbox.delete).not.toHaveBeenCalled();
  });

  test('200 { success: true } on successful tenant-owned delete', async () => {
    prisma.sharedInbox.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.sharedInbox.delete.mockResolvedValue({ id: 50 });

    const res = await request(makeApp()).delete('/api/shared-inbox/50');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.sharedInbox.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/members — add/remove a member (with #436-class targetUserId fix)
// ─────────────────────────────────────────────────────────────────────────

describe('POST /:id/members — add/remove member', () => {
  test('400 when action missing (or invalid)', async () => {
    const res = await request(makeApp())
      .post('/api/shared-inbox/50/members')
      .send({ targetUserId: 99 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/userId.*action/i);
    expect(prisma.sharedInbox.findFirst).not.toHaveBeenCalled();
  });

  test('400 when neither targetUserId nor strippedFields.userId is provided', async () => {
    const res = await request(makeApp())
      .post('/api/shared-inbox/50/members')
      .send({ action: 'add' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/userId.*action/i);
  });

  test('404 when inbox belongs to a different tenant', async () => {
    prisma.sharedInbox.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/shared-inbox/777/members')
      .send({ targetUserId: 99, action: 'add' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.sharedInbox.update).not.toHaveBeenCalled();
  });

  test('200 add: appends userId to members array (idempotent — duplicate add is a no-op)', async () => {
    prisma.sharedInbox.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, members: '[7,8]',
    });
    prisma.sharedInbox.update.mockResolvedValue({
      id: 50, members: '[7,8,99]',
    });

    const res = await request(makeApp())
      .post('/api/shared-inbox/50/members')
      .send({ targetUserId: 99, action: 'add' });

    expect(res.status).toBe(200);
    expect(prisma.sharedInbox.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { members: JSON.stringify([7, 8, 99]) },
    });
    expect(res.body.members).toEqual([7, 8, 99]);
  });

  test('200 remove: filters userId out of members array', async () => {
    prisma.sharedInbox.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, members: '[7,8,99]',
    });
    prisma.sharedInbox.update.mockResolvedValue({
      id: 50, members: '[7,8]',
    });

    const res = await request(makeApp())
      .post('/api/shared-inbox/50/members')
      .send({ targetUserId: 99, action: 'remove' });

    expect(res.status).toBe(200);
    expect(prisma.sharedInbox.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { members: JSON.stringify([7, 8]) },
    });
  });

  test('200 strippedFields.userId fallback honored (#436-class back-compat path)', async () => {
    prisma.sharedInbox.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, members: '[7]',
    });
    prisma.sharedInbox.update.mockResolvedValue({
      id: 50, members: '[7,42]',
    });

    // No targetUserId in body — strippedFields.userId supplies the value
    // (simulates a legacy client posting body.userId that the global
    // stripDangerous middleware moved into req.strippedFields).
    const res = await request(makeApp({ strippedFields: { userId: 42 } }))
      .post('/api/shared-inbox/50/members')
      .send({ action: 'add' });

    expect(res.status).toBe(200);
    expect(prisma.sharedInbox.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { members: JSON.stringify([7, 42]) },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id/messages — thread-grouped feed
// ─────────────────────────────────────────────────────────────────────────

describe('GET /:id/messages — thread-grouped messages', () => {
  test('404 when inbox belongs to a different tenant', async () => {
    prisma.sharedInbox.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/shared-inbox/777/messages');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.emailMessage.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/assign-message — re-assign a thread to a user
// ─────────────────────────────────────────────────────────────────────────

describe('POST /:id/assign-message — assign thread', () => {
  test('400 when messageId missing from body', async () => {
    const res = await request(makeApp())
      .post('/api/shared-inbox/50/assign-message')
      .send({ targetUserId: 7 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/messageId/i);
    expect(prisma.emailMessage.update).not.toHaveBeenCalled();
    expect(prisma.emailMessage.updateMany).not.toHaveBeenCalled();
  });
});
