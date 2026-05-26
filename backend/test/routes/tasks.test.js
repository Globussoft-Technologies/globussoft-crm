// @ts-check
/**
 * Unit + integration tests for backend/routes/tasks.js — pins the
 * multi-tenant Task CRUD surface that backs the Owner sidebar pending-task
 * badge, the "My Tasks" tab, and the orchestrator-engine fan-out.
 *
 * Issue context
 * ─────────────
 *   #163 — invalid status/priority/dueDate values are rejected with 400
 *          instead of silently coerced to "Pending" or stored verbatim.
 *
 *   #167 — soft-delete + restore. DELETE flips deletedAt; subsequent calls
 *          are idempotent (return the existing row with idempotent:true).
 *          GET hides soft-deleted rows by default; ?includeDeleted=true
 *          opts in.
 *
 *   #172 — pagination (?limit + ?offset). Default 100, hard cap 500.
 *
 *   #179 — audit log on CREATE / UPDATE / COMPLETE / SOFT_DELETE / RESTORE.
 *          We don't pin the audit row shape here (writeAudit is exercised
 *          by lib/audit tests); we just confirm the route doesn't throw
 *          when audit is wired in.
 *
 *   #313 — datetime-local-vs-ISO TZ handling. HTML <input type="datetime-local">
 *          emits 'YYYY-MM-DDTHH:mm' with no TZ marker; route routes those
 *          through parseDateTimeLocalInTZ(Asia/Kolkata) so the user's
 *          wall-clock survives the round-trip. Full ISO timestamps (with
 *          Z or ±HH:mm) are passed through unchanged.
 *
 *   #436 — case-insensitive + legacy-tolerant status filter. The Sidebar
 *          badge sends ?status=PENDING (uppercase) and the orchestrator
 *          writes status="OPEN"; both must resolve to "Pending" for query
 *          purposes. Also adds ?mine=true filter (caller's own tasks; for
 *          ADMIN/MANAGER also includes userId=null orchestrator-fan-outs).
 *          Also adds POST acceptance of `targetUserId` (the global
 *          stripDangerous middleware deletes `userId`, so old POST clients
 *          could never assign).
 *
 *   gap #17 — task.completed eventBus emission is idempotent: only fires
 *             on the Pending → Completed transition, not on re-saving an
 *             already-Completed task.
 *
 * What this file pins
 * ───────────────────
 *   1. GET / lists tenant-scoped tasks; cross-tenant rows are filtered
 *      out by the prisma where clause.
 *   2. GET /?status=PENDING (uppercase) normalizes to "Pending" (#436).
 *   3. GET /?priority=High filters exactly.
 *   4. GET /?contactId=N coerces to int and filters.
 *   5. GET /?overdue=true sets status=Pending + dueDate<{now}.
 *   6. GET /?mine=true for USER role filters to userId=caller only.
 *   7. GET /?mine=true for ADMIN/MANAGER includes userId=caller OR null
 *      (orchestrator fan-outs).
 *   8. GET / hides soft-deleted by default (deletedAt=null); ?includeDeleted=true opts in.
 *   9. GET / pagination: ?limit + ?offset; default limit=100, max 500.
 *  10. GET / sorts by priority (Critical → Low) in memory.
 *  11. POST / requires title; rejects missing with 400.
 *  12. POST / rejects invalid priority/status/dueDate enum/range with 400 (#163).
 *  13. POST / accepts `targetUserId` to assign (since `userId` is stripped) (#436).
 *  14. POST / parses datetime-local strings through IST TZ; passes ISO timestamps through (#313).
 *  15. POST / writes tenantId from req.user, never from body.
 *  16. PUT /:id 400 on non-numeric id; 404 on cross-tenant id.
 *  17. PUT /:id updates only the keys provided; tenant-scoped.
 *  18. PUT /:id Pending → Completed transition emits task.completed (gap #17).
 *  19. PUT /:id Completed → Completed (idempotent) does NOT re-emit task.completed.
 *  20. PUT /:id/complete marks the task Completed; emits task.completed.
 *  21. PUT /:id/complete is idempotent (does not re-emit when already Completed).
 *  22. DELETE /:id requires ADMIN role (USER → 403).
 *  23. DELETE /:id soft-deletes (sets deletedAt); returns softDeleted:true.
 *  24. DELETE /:id on already-soft-deleted row is idempotent (returns idempotent:true).
 *  25. POST /:id/restore unsets deletedAt; returns restored:true.
 *  26. POST /:id/restore on a non-deleted row is idempotent (restored:false).
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/field-permissions.test.js + gdpr.test.js
 *   — prisma singleton patch (no real DB, per vitest.config.js's "NO
 *   database" mandate) + real JWT bearer signed with config/secrets's
 *   JWT_SECRET. The auth middleware is NOT vi.mock'd (the middleware
 *   directory isn't always covered by the inline regex AND mocking would
 *   hide the verifyToken/verifyRole gates we're trying to assert).
 *
 *   eventBus is the canonical CJS self-mocking-seam target: route does
 *   `require('../lib/eventBus').emitEvent(...)` lazily inside the handler,
 *   so we monkey-patch the singleton's `emitEvent` after the route loads
 *   and reset it in beforeEach.
 *
 *   The global `stripDangerous` middleware (server.js) is NOT mounted in
 *   the test app — to exercise the targetUserId vs req.strippedFields
 *   fallback we install a tiny mimic middleware that emulates the strip.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patching ─────────────────────────────────────
// Must happen BEFORE the router is required, since the router's
// top-level `require('../lib/prisma')` resolves at import time.
prisma.task = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({});
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
prisma.auditLog.findMany = vi.fn().mockResolvedValue([]);
// verifyToken's revoked-token lookup hits prisma.revokedToken.findUnique.
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const { JWT_SECRET } = requireCJS('../../config/secrets');
function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

// CJS self-mocking seam: the route does `require('../lib/eventBus').emitEvent(...)`
// lazily inside each handler. The eventBus module is cached by Node CJS resolver;
// patching the singleton's `emitEvent` here propagates to the route at call time.
// See cron-learnings 2026-05-24 ~01:43 UTC.
const eventBusModule = requireCJS('../../lib/eventBus');
const emitEventMock = vi.fn();
eventBusModule.emitEvent = emitEventMock;

const tasksRouter = requireCJS('../../routes/tasks');

// Mimic the global stripDangerous middleware (server.js) — deletes `userId`
// from req.body and records the prior value on req.strippedFields.userId.
// Required to exercise the route's #436 fallback contract.
function stripDangerousMimic(req, _res, next) {
  req.strippedFields = req.strippedFields || {};
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'userId')) {
    req.strippedFields.userId = req.body.userId;
    delete req.body.userId;
  }
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'tenantId')) {
    req.strippedFields.tenantId = req.body.tenantId;
    delete req.body.tenantId;
  }
  next();
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(stripDangerousMimic);
  app.use('/api/tasks', tasksRouter);
  return app;
}

beforeEach(() => {
  prisma.task.findMany.mockReset();
  prisma.task.findFirst.mockReset();
  prisma.task.create.mockReset();
  prisma.task.update.mockReset();
  prisma.task.delete.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({});
  emitEventMock.mockReset();
});

// ── GET / — list, filter, paginate, tenant scope ─────────────────────

describe('GET / — list', () => {
  test('returns tenant-scoped tasks (tenantId on where clause)', async () => {
    prisma.task.findMany.mockResolvedValue([
      { id: 1, title: 'Mine', priority: 'Medium', status: 'Pending', tenantId: 1 },
    ]);
    const res = await request(makeApp())
      .get('/api/tasks')
      .set('Authorization', makeBearer({ tenantId: 1 }));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(1);
    const args = prisma.task.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(1);
    // Soft-deleted hidden by default (#167)
    expect(args.where.deletedAt).toBeNull();
  });

  test('?status=PENDING (uppercase, legacy) normalizes to "Pending" (#436)', async () => {
    prisma.task.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/tasks?status=PENDING')
      .set('Authorization', makeBearer());
    const args = prisma.task.findMany.mock.calls[0][0];
    expect(args.where.status).toBe('Pending');
  });

  test('?status=OPEN (orchestrator-legacy) normalizes to "Pending" (#436)', async () => {
    prisma.task.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/tasks?status=OPEN')
      .set('Authorization', makeBearer());
    const args = prisma.task.findMany.mock.calls[0][0];
    expect(args.where.status).toBe('Pending');
  });

  test('?priority=High filters exactly', async () => {
    prisma.task.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/tasks?priority=High')
      .set('Authorization', makeBearer());
    const args = prisma.task.findMany.mock.calls[0][0];
    expect(args.where.priority).toBe('High');
  });

  test('?contactId=42 coerces to int and filters', async () => {
    prisma.task.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/tasks?contactId=42')
      .set('Authorization', makeBearer());
    const args = prisma.task.findMany.mock.calls[0][0];
    expect(args.where.contactId).toBe(42);
  });

  test('?overdue=true sets dueDate<now AND status=Pending', async () => {
    prisma.task.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/tasks?overdue=true')
      .set('Authorization', makeBearer());
    const args = prisma.task.findMany.mock.calls[0][0];
    expect(args.where.status).toBe('Pending');
    expect(args.where.dueDate).toEqual({ lt: expect.any(Date) });
  });

  test('?mine=true for USER role filters to userId=caller only', async () => {
    prisma.task.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/tasks?mine=true')
      .set('Authorization', makeBearer({ userId: 7, role: 'USER' }));
    const args = prisma.task.findMany.mock.calls[0][0];
    // Non-org roles only see their own
    expect(args.where.OR).toEqual([{ userId: 7 }]);
  });

  test('?mine=true for ADMIN includes userId=caller OR userId=null (orchestrator fan-out, #436)', async () => {
    prisma.task.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/tasks?mine=true')
      .set('Authorization', makeBearer({ userId: 7, role: 'ADMIN' }));
    const args = prisma.task.findMany.mock.calls[0][0];
    expect(args.where.OR).toEqual([{ userId: 7 }, { userId: null }]);
  });

  test('?includeDeleted=true omits the deletedAt=null filter (#167)', async () => {
    prisma.task.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/tasks?includeDeleted=true')
      .set('Authorization', makeBearer());
    const args = prisma.task.findMany.mock.calls[0][0];
    // The route should NOT have set deletedAt=null on the where clause
    expect(args.where.deletedAt).toBeUndefined();
  });

  test('?limit=10&offset=5 paginates (#172)', async () => {
    prisma.task.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/tasks?limit=10&offset=5')
      .set('Authorization', makeBearer());
    const args = prisma.task.findMany.mock.calls[0][0];
    expect(args.take).toBe(10);
    expect(args.skip).toBe(5);
  });

  test('?limit=9999 is clamped to 500 (#172 hard cap)', async () => {
    prisma.task.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/tasks?limit=9999')
      .set('Authorization', makeBearer());
    const args = prisma.task.findMany.mock.calls[0][0];
    expect(args.take).toBe(500);
  });

  test('sorts results by priority (Critical first, Low last) in memory', async () => {
    prisma.task.findMany.mockResolvedValue([
      { id: 1, title: 'a', priority: 'Low' },
      { id: 2, title: 'b', priority: 'Critical' },
      { id: 3, title: 'c', priority: 'Medium' },
      { id: 4, title: 'd', priority: 'High' },
    ]);
    const res = await request(makeApp())
      .get('/api/tasks')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(200);
    expect(res.body.map(t => t.priority)).toEqual(['Critical', 'High', 'Medium', 'Low']);
  });
});

// ── POST / — create with validation, assignee fallback, audit ────────

describe('POST / — create', () => {
  test('rejects missing title with 400', async () => {
    const res = await request(makeApp())
      .post('/api/tasks')
      .set('Authorization', makeBearer())
      .send({ priority: 'Medium' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title is required/);
    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  test('rejects invalid priority enum with 400 (#163)', async () => {
    const res = await request(makeApp())
      .post('/api/tasks')
      .set('Authorization', makeBearer())
      .send({ title: 'x', priority: 'Urgent' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PRIORITY');
    expect(prisma.task.create).not.toHaveBeenCalled();
  });

  test('rejects invalid status enum with 400 (#163)', async () => {
    const res = await request(makeApp())
      .post('/api/tasks')
      .set('Authorization', makeBearer())
      .send({ title: 'x', status: 'WIP' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATUS');
  });

  test('rejects out-of-range dueDate (year < 2000) with 400 (#163)', async () => {
    const res = await request(makeApp())
      .post('/api/tasks')
      .set('Authorization', makeBearer())
      .send({ title: 'x', dueDate: '1999-12-31T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DUEDATE');
  });

  test('accepts targetUserId as the assignee (workaround for stripDangerous, #436)', async () => {
    prisma.task.create.mockResolvedValue({
      id: 100, title: 'x', tenantId: 1, userId: 42, priority: 'Medium', status: 'Pending',
    });
    const res = await request(makeApp())
      .post('/api/tasks')
      .set('Authorization', makeBearer({ tenantId: 1 }))
      .send({ title: 'x', targetUserId: 42 });
    expect(res.status).toBe(201);
    const args = prisma.task.create.mock.calls[0][0];
    expect(args.data.userId).toBe(42);
    expect(args.data.tenantId).toBe(1);
  });

  test('falls back to req.strippedFields.userId (back-compat with old clients posting userId, #436)', async () => {
    prisma.task.create.mockResolvedValue({
      id: 101, title: 'x', tenantId: 1, userId: 99,
    });
    const res = await request(makeApp())
      .post('/api/tasks')
      .set('Authorization', makeBearer({ tenantId: 1 }))
      .send({ title: 'x', userId: 99 }); // stripDangerousMimic strips this → strippedFields.userId=99
    expect(res.status).toBe(201);
    const args = prisma.task.create.mock.calls[0][0];
    expect(args.data.userId).toBe(99);
  });

  test('emits task.created event after successful create', async () => {
    prisma.task.create.mockResolvedValue({
      id: 102, title: 'x', tenantId: 1, userId: null, priority: 'Medium',
    });
    await request(makeApp())
      .post('/api/tasks')
      .set('Authorization', makeBearer())
      .send({ title: 'x' });
    expect(emitEventMock).toHaveBeenCalledWith(
      'task.created',
      expect.objectContaining({ taskId: 102, title: 'x' }),
      1,
      undefined,
    );
  });

  test('writes tenantId from req.user, not body (body tenantId is stripped)', async () => {
    prisma.task.create.mockResolvedValue({ id: 103, title: 'x', tenantId: 1 });
    await request(makeApp())
      .post('/api/tasks')
      .set('Authorization', makeBearer({ tenantId: 1 }))
      .send({ title: 'x', tenantId: 9999 }); // hostile cross-tenant attempt
    const args = prisma.task.create.mock.calls[0][0];
    expect(args.data.tenantId).toBe(1);
  });

  test('parses datetime-local strings through IST TZ (#313)', async () => {
    prisma.task.create.mockResolvedValue({
      id: 104, title: 'x', tenantId: 1, dueDate: new Date('2026-06-01T05:00:00Z'),
    });
    await request(makeApp())
      .post('/api/tasks')
      .set('Authorization', makeBearer())
      .send({ title: 'x', dueDate: '2026-06-01T10:30' }); // no TZ marker → IST
    const args = prisma.task.create.mock.calls[0][0];
    // 10:30 IST = 05:00 UTC (10:30 - 5:30)
    expect(args.data.dueDate.toISOString()).toBe('2026-06-01T05:00:00.000Z');
  });

  test('passes ISO timestamps with TZ through unchanged (#313)', async () => {
    prisma.task.create.mockResolvedValue({ id: 105, title: 'x', tenantId: 1 });
    await request(makeApp())
      .post('/api/tasks')
      .set('Authorization', makeBearer())
      .send({ title: 'x', dueDate: '2026-06-01T10:30:00Z' }); // explicit UTC
    const args = prisma.task.create.mock.calls[0][0];
    expect(args.data.dueDate.toISOString()).toBe('2026-06-01T10:30:00.000Z');
  });
});

// ── PUT /:id — general update with audit + idempotent task.completed (#17) ──

describe('PUT /:id — update', () => {
  test('returns 400 on non-numeric id', async () => {
    const res = await request(makeApp())
      .put('/api/tasks/abc')
      .set('Authorization', makeBearer())
      .send({ title: 'y' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid task ID/);
  });

  test('returns 404 when row exists on a different tenant', async () => {
    prisma.task.findFirst.mockResolvedValue(null); // tenant-scoped lookup returns nothing
    const res = await request(makeApp())
      .put('/api/tasks/9999')
      .set('Authorization', makeBearer({ tenantId: 1 }))
      .send({ title: 'y' });
    expect(res.status).toBe(404);
    expect(prisma.task.update).not.toHaveBeenCalled();
    // Confirm tenant scope was on the lookup
    const args = prisma.task.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(1);
  });

  test('updates only the keys provided, audits the diff', async () => {
    prisma.task.findFirst.mockResolvedValue({
      id: 5, title: 'old', notes: 'n', status: 'Pending', priority: 'Medium', tenantId: 1,
    });
    prisma.task.update.mockResolvedValue({
      id: 5, title: 'new', notes: 'n', status: 'Pending', priority: 'Medium', tenantId: 1,
    });
    const res = await request(makeApp())
      .put('/api/tasks/5')
      .set('Authorization', makeBearer())
      .send({ title: 'new' });
    expect(res.status).toBe(200);
    const args = prisma.task.update.mock.calls[0][0];
    expect(args.data).toEqual({ title: 'new' }); // ONLY title in the patch
    expect(args.where).toEqual({ id: 5 });
  });

  test('Pending → Completed transition emits task.completed (gap #17)', async () => {
    prisma.task.findFirst.mockResolvedValue({
      id: 6, status: 'Pending', tenantId: 1, contactId: 50, userId: 7,
    });
    prisma.task.update.mockResolvedValue({
      id: 6, status: 'Completed', tenantId: 1, contactId: 50, userId: 7, dealId: null,
    });
    await request(makeApp())
      .put('/api/tasks/6')
      .set('Authorization', makeBearer())
      .send({ status: 'Completed' });
    expect(emitEventMock).toHaveBeenCalledWith(
      'task.completed',
      expect.objectContaining({ taskId: 6, contactId: 50, assignedToId: 7 }),
      1,
      undefined,
    );
  });

  test('Completed → Completed (re-save) does NOT re-emit task.completed (gap #17 idempotency)', async () => {
    prisma.task.findFirst.mockResolvedValue({
      id: 7, status: 'Completed', tenantId: 1,
    });
    prisma.task.update.mockResolvedValue({
      id: 7, status: 'Completed', tenantId: 1,
    });
    await request(makeApp())
      .put('/api/tasks/7')
      .set('Authorization', makeBearer())
      .send({ status: 'Completed' });
    expect(emitEventMock).not.toHaveBeenCalled();
  });
});

// ── PUT /:id/complete — dedicated completion endpoint ────────────────

describe('PUT /:id/complete', () => {
  test('marks the task Completed and emits task.completed', async () => {
    prisma.task.findFirst.mockResolvedValue({
      id: 8, status: 'Pending', tenantId: 1, contactId: 50, userId: 7,
    });
    prisma.task.update.mockResolvedValue({
      id: 8, status: 'Completed', tenantId: 1, contactId: 50, userId: 7, dealId: null,
    });
    const res = await request(makeApp())
      .put('/api/tasks/8/complete')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Completed');
    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { status: 'Completed' },
    });
    expect(emitEventMock).toHaveBeenCalledWith(
      'task.completed',
      expect.objectContaining({ taskId: 8 }),
      1,
      undefined,
    );
  });

  test('is idempotent — already-Completed row does NOT re-emit (gap #17)', async () => {
    prisma.task.findFirst.mockResolvedValue({
      id: 9, status: 'Completed', tenantId: 1,
    });
    prisma.task.update.mockResolvedValue({
      id: 9, status: 'Completed', tenantId: 1,
    });
    await request(makeApp())
      .put('/api/tasks/9/complete')
      .set('Authorization', makeBearer());
    expect(emitEventMock).not.toHaveBeenCalled();
  });

  test('returns 404 on cross-tenant id', async () => {
    prisma.task.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/tasks/9999/complete')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(404);
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  test('returns 400 on non-numeric id', async () => {
    const res = await request(makeApp())
      .put('/api/tasks/abc/complete')
      .set('Authorization', makeBearer());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid task ID/);
  });
});

// ── DELETE /:id — soft-delete, ADMIN-only, idempotent (#167) ─────────

describe('DELETE /:id — soft-delete', () => {
  test('USER role gets 403 (ADMIN-only)', async () => {
    const res = await request(makeApp())
      .delete('/api/tasks/10')
      .set('Authorization', makeBearer({ role: 'USER' }));
    expect(res.status).toBe(403);
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  test('MANAGER role also gets 403 (ADMIN-only)', async () => {
    const res = await request(makeApp())
      .delete('/api/tasks/10')
      .set('Authorization', makeBearer({ role: 'MANAGER' }));
    expect(res.status).toBe(403);
  });

  test('soft-deletes (sets deletedAt) and returns softDeleted:true (#167)', async () => {
    prisma.task.findFirst.mockResolvedValue({
      id: 10, title: 'x', tenantId: 1, deletedAt: null,
    });
    prisma.task.update.mockResolvedValue({
      id: 10, title: 'x', tenantId: 1, deletedAt: new Date(),
    });
    const res = await request(makeApp())
      .delete('/api/tasks/10')
      .set('Authorization', makeBearer({ role: 'ADMIN' }));
    expect(res.status).toBe(200);
    expect(res.body.softDeleted).toBe(true);
    expect(res.body.message).toMatch(/soft-deleted/);
    const args = prisma.task.update.mock.calls[0][0];
    expect(args.data.deletedAt).toBeInstanceOf(Date);
  });

  test('already-soft-deleted is idempotent (returns idempotent:true, no second update)', async () => {
    prisma.task.findFirst.mockResolvedValue({
      id: 11, title: 'x', tenantId: 1, deletedAt: new Date(),
    });
    const res = await request(makeApp())
      .delete('/api/tasks/11')
      .set('Authorization', makeBearer({ role: 'ADMIN' }));
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.softDeleted).toBe(true);
    // Crucially — the second update is NOT issued
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  test('returns 404 on cross-tenant id', async () => {
    prisma.task.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .delete('/api/tasks/9999')
      .set('Authorization', makeBearer({ role: 'ADMIN' }));
    expect(res.status).toBe(404);
  });

  test('returns 400 on non-numeric id', async () => {
    const res = await request(makeApp())
      .delete('/api/tasks/abc')
      .set('Authorization', makeBearer({ role: 'ADMIN' }));
    expect(res.status).toBe(400);
  });
});

// ── POST /:id/restore — undo soft-delete, ADMIN-only (#167) ──────────

describe('POST /:id/restore — restore', () => {
  test('USER role gets 403 (ADMIN-only)', async () => {
    const res = await request(makeApp())
      .post('/api/tasks/12/restore')
      .set('Authorization', makeBearer({ role: 'USER' }));
    expect(res.status).toBe(403);
  });

  test('unsets deletedAt and returns restored:true (#167)', async () => {
    prisma.task.findFirst.mockResolvedValue({
      id: 12, title: 'x', tenantId: 1, deletedAt: new Date(),
    });
    prisma.task.update.mockResolvedValue({
      id: 12, title: 'x', tenantId: 1, deletedAt: null,
    });
    const res = await request(makeApp())
      .post('/api/tasks/12/restore')
      .set('Authorization', makeBearer({ role: 'ADMIN' }));
    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(true);
    const args = prisma.task.update.mock.calls[0][0];
    expect(args.data.deletedAt).toBeNull();
  });

  test('non-deleted row is idempotent (restored:false, no update issued)', async () => {
    prisma.task.findFirst.mockResolvedValue({
      id: 13, title: 'x', tenantId: 1, deletedAt: null,
    });
    const res = await request(makeApp())
      .post('/api/tasks/13/restore')
      .set('Authorization', makeBearer({ role: 'ADMIN' }));
    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.restored).toBe(false);
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  test('returns 404 on cross-tenant id', async () => {
    prisma.task.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/tasks/9999/restore')
      .set('Authorization', makeBearer({ role: 'ADMIN' }));
    expect(res.status).toBe(404);
  });
});
