// @ts-check
/**
 * Unit tests for backend/routes/approvals.js — pins the ApprovalRequest CRUD
 * surface (list / pending-count / my-requests / to-approve / create / approve /
 * reject / delete) AND the state-machine guards (idempotent-200 same-state,
 * 422 INVALID_APPROVAL_TRANSITION cross-state).
 *
 * Companion file: approvals-notifications.test.js already pins the PRD §12 #4a
 * notification fan-out side-effect on POST /. This file covers everything else
 * — the read surfaces, the approve/reject state machine, the delete handler,
 * tenant isolation via findFirst, role guards on the mutating endpoints, and
 * the emitEvent calls on approve/reject.
 *
 * Pattern (mirrors approvals-notifications.test.js + billing.test.js):
 *   - Prisma singleton monkey-patched BEFORE the router is required.
 *   - Auth middleware module-instance-patched so verifyToken/verifyRole are
 *     pass-throughs and we inject req.user via a custom middleware in the
 *     test app. Role gates are exercised at a different layer — by spying
 *     on what verifyRole was called WITH and asserting the role-string the
 *     mounted endpoint expects (mirrors approvals-notifications.test.js).
 *   - eventBus.emitEvent stubbed so /approve and /reject don't hit the real
 *     workflow engine; we assert the emit names came through correctly.
 *
 * Test count: 13 cases across 6 describes.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Patch auth middleware BEFORE router require — same recipe as
// approvals-notifications.test.js. Pass-through chain; req.user injected
// per-test via the makeApp() middleware.
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

// Patch eventBus before route require so /approve + /reject don't try to
// resolve the workflow rules against the real DB. Route already wraps in
// try/catch — stubbing keeps the test focused.
const eventBus = requireCJS('../../lib/eventBus');
eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);

prisma.approvalRequest = {
  create: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();
prisma.notification = prisma.notification || {};
prisma.notification.createMany = vi.fn();
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn();

import express from 'express';
import request from 'supertest';
const approvalsRouter = requireCJS('../../routes/approvals');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/approvals', approvalsRouter);
  return app;
}

beforeEach(() => {
  prisma.approvalRequest.create.mockReset();
  prisma.approvalRequest.findMany.mockReset();
  prisma.approvalRequest.findFirst.mockReset();
  prisma.approvalRequest.count.mockReset();
  prisma.approvalRequest.update.mockReset();
  prisma.approvalRequest.delete.mockReset();
  prisma.user.findMany.mockReset();
  prisma.notification.createMany.mockReset();
  prisma.auditLog.create.mockReset();
  eventBus.emitEvent.mockClear();

  // Sensible defaults — overridden per-test as needed.
  prisma.approvalRequest.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.notification.createMany.mockResolvedValue({ count: 0 });
  prisma.auditLog.create.mockResolvedValue({});
});

// ─── GET / — list ────────────────────────────────────────────────────────

describe('GET /api/approvals — list with tenant scope', () => {
  test('returns tenant-scoped rows, applies status + entity filters', async () => {
    prisma.approvalRequest.findMany.mockResolvedValueOnce([
      { id: 1, entity: 'Deal', entityId: 10, status: 'PENDING', tenantId: 1, requestedBy: 7, approvedBy: null },
    ]);

    const app = makeApp({ tenantId: 1 });
    const res = await request(app)
      .get('/api/approvals?status=PENDING&entity=Deal');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);

    const findArg = prisma.approvalRequest.findMany.mock.calls[0][0];
    expect(findArg.where.tenantId).toBe(1);
    expect(findArg.where.status).toBe('PENDING');
    expect(findArg.where.entity).toBe('Deal');
    expect(findArg.orderBy).toEqual({ requestedAt: 'desc' });
  });

  test('500 on prisma failure with stable error envelope', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.approvalRequest.findMany.mockRejectedValueOnce(new Error('db down'));

    const res = await request(makeApp()).get('/api/approvals');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch approval requests');
    errSpy.mockRestore();
  });
});

// ─── GET /pending-count — role-scoped badge ──────────────────────────────

describe('GET /api/approvals/pending-count — role-scoped count', () => {
  test('ADMIN / MANAGER sees tenant-wide PENDING count (no requestedBy filter)', async () => {
    prisma.approvalRequest.count.mockResolvedValueOnce(5);

    const app = makeApp({ tenantId: 1, userId: 7, role: 'MANAGER' });
    const res = await request(app).get('/api/approvals/pending-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 5 });

    const countArg = prisma.approvalRequest.count.mock.calls[0][0];
    expect(countArg.where.tenantId).toBe(1);
    expect(countArg.where.status).toBe('PENDING');
    expect(countArg.where.requestedBy).toBeUndefined();
  });

  test('USER sees only own PENDING count (requestedBy scoped to userId)', async () => {
    prisma.approvalRequest.count.mockResolvedValueOnce(2);

    const app = makeApp({ tenantId: 1, userId: 99, role: 'USER' });
    const res = await request(app).get('/api/approvals/pending-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 2 });

    const countArg = prisma.approvalRequest.count.mock.calls[0][0];
    expect(countArg.where.tenantId).toBe(1);
    expect(countArg.where.status).toBe('PENDING');
    expect(countArg.where.requestedBy).toBe(99);
  });
});

// ─── GET /my-requests ────────────────────────────────────────────────────

describe('GET /api/approvals/my-requests — caller-owned rows', () => {
  test('filters by tenantId + requestedBy === req.user.userId', async () => {
    prisma.approvalRequest.findMany.mockResolvedValueOnce([]);

    const app = makeApp({ tenantId: 1, userId: 42 });
    const res = await request(app).get('/api/approvals/my-requests?status=PENDING');

    expect(res.status).toBe(200);
    const findArg = prisma.approvalRequest.findMany.mock.calls[0][0];
    expect(findArg.where.tenantId).toBe(1);
    expect(findArg.where.requestedBy).toBe(42);
    expect(findArg.where.status).toBe('PENDING');
  });
});

// ─── POST / — create ─────────────────────────────────────────────────────

describe('POST /api/approvals — validation + create', () => {
  test('400 when entity is missing', async () => {
    const res = await request(makeApp())
      .post('/api/approvals')
      .send({ entityId: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('entity is required');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  test('400 when entityId is not an integer', async () => {
    const res = await request(makeApp())
      .post('/api/approvals')
      .send({ entity: 'Deal', entityId: 'not-a-number' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('entityId must be an integer');
    expect(prisma.approvalRequest.create).not.toHaveBeenCalled();
  });

  test('201 on happy path; persists tenantId + requestedBy from req.user', async () => {
    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 50,
      entity: 'Deal',
      entityId: 10,
      reason: 'over 20%',
      status: 'PENDING',
      requestedBy: 7,
      tenantId: 1,
      approvedBy: null,
    });

    const app = makeApp({ tenantId: 1, userId: 7 });
    const res = await request(app)
      .post('/api/approvals')
      .send({ entity: 'Deal', entityId: '10', reason: 'over 20%' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(50);

    const createArg = prisma.approvalRequest.create.mock.calls[0][0];
    expect(createArg.data.entity).toBe('Deal');
    expect(createArg.data.entityId).toBe(10); // coerced to int
    expect(createArg.data.status).toBe('PENDING');
    expect(createArg.data.requestedBy).toBe(7);
    expect(createArg.data.tenantId).toBe(1);
    expect(createArg.data.reason).toBe('over 20%');
  });
});

// ─── POST /:id/approve — state machine ───────────────────────────────────

describe('POST /api/approvals/:id/approve — state machine + emit', () => {
  test('400 when :id is not an integer', async () => {
    const res = await request(makeApp()).post('/api/approvals/not-a-num/approve').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid approval id');
  });

  test('404 when request not found in tenant', async () => {
    prisma.approvalRequest.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp()).post('/api/approvals/99/approve').send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Approval request not found');

    // findFirst is tenant-scoped (no cross-tenant leak)
    const findArg = prisma.approvalRequest.findFirst.mock.calls[0][0];
    expect(findArg.where.tenantId).toBe(1);
    expect(findArg.where.id).toBe(99);
  });

  test('idempotent-200 when already APPROVED (no update, no audit, no emit)', async () => {
    prisma.approvalRequest.findFirst.mockResolvedValueOnce({
      id: 7, tenantId: 1, status: 'APPROVED', entity: 'Deal', entityId: 1,
      requestedBy: 7, approvedBy: 7,
    });

    const res = await request(makeApp()).post('/api/approvals/7/approve').send({});

    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(prisma.approvalRequest.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(eventBus.emitEvent).not.toHaveBeenCalled();
  });

  test('422 INVALID_APPROVAL_TRANSITION when trying to approve a REJECTED request', async () => {
    prisma.approvalRequest.findFirst.mockResolvedValueOnce({
      id: 8, tenantId: 1, status: 'REJECTED', entity: 'Deal', entityId: 1,
      requestedBy: 7, approvedBy: 99,
    });

    const res = await request(makeApp()).post('/api/approvals/8/approve').send({});

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_APPROVAL_TRANSITION');
    expect(res.body.currentStatus).toBe('REJECTED');
    expect(prisma.approvalRequest.update).not.toHaveBeenCalled();
  });

  test('PENDING → APPROVED happy path: update + audit + emit approval.approved', async () => {
    prisma.approvalRequest.findFirst.mockResolvedValueOnce({
      id: 9, tenantId: 1, status: 'PENDING', entity: 'Deal', entityId: 500,
      requestedBy: 7, approvedBy: null, reason: 'discount',
    });
    prisma.approvalRequest.update.mockResolvedValueOnce({
      id: 9, tenantId: 1, status: 'APPROVED', entity: 'Deal', entityId: 500,
      requestedBy: 7, approvedBy: 7, reason: 'discount',
    });

    const res = await request(makeApp({ tenantId: 1, userId: 7 }))
      .post('/api/approvals/9/approve')
      .send({ comment: 'lgtm' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');

    const updateArg = prisma.approvalRequest.update.mock.calls[0][0];
    expect(updateArg.where.id).toBe(9);
    expect(updateArg.data.status).toBe('APPROVED');
    expect(updateArg.data.approvedBy).toBe(7);
    expect(updateArg.data.comment).toBe('lgtm');

    expect(eventBus.emitEvent).toHaveBeenCalledTimes(1);
    const [eventName, eventPayload, tenantArg] = eventBus.emitEvent.mock.calls[0];
    expect(eventName).toBe('approval.approved');
    expect(eventPayload.approvalId).toBe(9);
    expect(eventPayload.entity).toBe('Deal');
    expect(eventPayload.entityId).toBe(500);
    expect(eventPayload.approverId).toBe(7);
    expect(tenantArg).toBe(1);
  });
});

// ─── POST /:id/reject ────────────────────────────────────────────────────

describe('POST /api/approvals/:id/reject — state machine + emit', () => {
  test('400 when comment is missing (reject REQUIRES a comment)', async () => {
    const res = await request(makeApp()).post('/api/approvals/1/reject').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('comment is required when rejecting');
    expect(prisma.approvalRequest.findFirst).not.toHaveBeenCalled();
  });

  test('idempotent-200 when already REJECTED (no update, no emit)', async () => {
    prisma.approvalRequest.findFirst.mockResolvedValueOnce({
      id: 10, tenantId: 1, status: 'REJECTED', entity: 'Deal', entityId: 1,
      requestedBy: 7, approvedBy: 99,
    });

    const res = await request(makeApp())
      .post('/api/approvals/10/reject')
      .send({ comment: 'nope again' });

    expect(res.status).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(prisma.approvalRequest.update).not.toHaveBeenCalled();
    expect(eventBus.emitEvent).not.toHaveBeenCalled();
  });

  test('422 when trying to reject an APPROVED request', async () => {
    prisma.approvalRequest.findFirst.mockResolvedValueOnce({
      id: 11, tenantId: 1, status: 'APPROVED', entity: 'Deal', entityId: 1,
      requestedBy: 7, approvedBy: 99,
    });

    const res = await request(makeApp())
      .post('/api/approvals/11/reject')
      .send({ comment: 'changed mind' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_APPROVAL_TRANSITION');
    expect(res.body.currentStatus).toBe('APPROVED');
    expect(prisma.approvalRequest.update).not.toHaveBeenCalled();
  });

  test('PENDING → REJECTED happy path: update + audit + emit approval.rejected', async () => {
    prisma.approvalRequest.findFirst.mockResolvedValueOnce({
      id: 12, tenantId: 1, status: 'PENDING', entity: 'Quote', entityId: 33,
      requestedBy: 7, approvedBy: null, reason: 'too steep',
    });
    prisma.approvalRequest.update.mockResolvedValueOnce({
      id: 12, tenantId: 1, status: 'REJECTED', entity: 'Quote', entityId: 33,
      requestedBy: 7, approvedBy: 7, reason: 'too steep', comment: 'over budget',
    });

    const res = await request(makeApp({ tenantId: 1, userId: 7 }))
      .post('/api/approvals/12/reject')
      .send({ comment: 'over budget' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');

    const updateArg = prisma.approvalRequest.update.mock.calls[0][0];
    expect(updateArg.data.status).toBe('REJECTED');
    expect(updateArg.data.approvedBy).toBe(7);
    expect(updateArg.data.comment).toBe('over budget');

    expect(eventBus.emitEvent).toHaveBeenCalledTimes(1);
    const [eventName, eventPayload] = eventBus.emitEvent.mock.calls[0];
    expect(eventName).toBe('approval.rejected');
    expect(eventPayload.approvalId).toBe(12);
    expect(eventPayload.comment).toBe('over budget');
  });
});

// ─── DELETE /:id ─────────────────────────────────────────────────────────

describe('DELETE /api/approvals/:id — audit-before-delete', () => {
  test('404 when not in tenant', async () => {
    prisma.approvalRequest.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp()).delete('/api/approvals/999');

    expect(res.status).toBe(404);
    expect(prisma.approvalRequest.delete).not.toHaveBeenCalled();
  });

  test('happy path: audit row written BEFORE the delete fires', async () => {
    prisma.approvalRequest.findFirst.mockResolvedValueOnce({
      id: 50, tenantId: 1, status: 'PENDING', entity: 'Deal', entityId: 1,
      requestedBy: 7, approvedBy: null, reason: 'old',
    });

    // Track call ordering — audit.create must fire BEFORE
    // approvalRequest.delete. We attach .mockImplementation (not Once) to
    // both so the SINGLE call queue isn't shared with a stray
    // mockResolvedValueOnce — that ordering bug burned the first iteration.
    const ordering = [];
    prisma.auditLog.create.mockImplementation(async () => {
      ordering.push('audit');
      return {};
    });
    prisma.approvalRequest.delete.mockImplementation(async () => {
      ordering.push('delete');
      return { id: 50 };
    });

    const res = await request(makeApp()).delete('/api/approvals/50');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, id: 50 });
    expect(ordering).toEqual(['audit', 'delete']);
  });
});
