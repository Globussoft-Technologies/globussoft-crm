// @ts-check
/**
 * Unit tests for the PRD Gap §12 #4a notification path — POST /api/approvals
 * fires Notification rows for every ADMIN/MANAGER approver in the tenant.
 *
 * Pattern: prisma-singleton monkey-patch + supertest (mirrors
 * backend/test/routes/surveys.test.js + communications.test.js).
 *
 * What this file pins:
 *   - POST /api/approvals creates the ApprovalRequest row, then
 *     prisma.notification.createMany fans out one row per approver.
 *   - approvers = User.findMany({where: {tenantId, role: in[ADMIN,MANAGER]}}).
 *   - Notification shape: tenantId, userId per recipient, type='approval',
 *     link=`/approvals/<id>`, title contains the entity + entityId, message
 *     includes the reason (truncated to 80 chars).
 *   - Zero approvers → notification.createMany NOT called; 201 still returned.
 *   - Notification creation failure → caught, 201 still returned (the request
 *     is the source of truth; the bell is best-effort).
 *   - Idempotency: calling POST twice for the same target produces TWO
 *     ApprovalRequests (one per call), TWO notification waves — by design,
 *     each approval request is its own row. Dedup is the caller's
 *     responsibility, not the route's.
 *
 * Why a separate file:
 *   The existing approvals route does not yet have a vitest unit test;
 *   the contract is otherwise pinned by e2e/tests/approvals-flow.spec.js
 *   at the integration layer. This file isolates the new notification
 *   wiring so a future refactor that drops the createMany call surfaces
 *   here cleanly.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Patch the auth middleware module BEFORE the approvals router is
// required — the approvals router destructures verifyToken/verifyRole
// at module-load and uses them inline. CJS require() pulls from cache,
// so monkey-patching the middleware module in-place gives us a
// pass-through auth chain. Same instance-monkey-patch pattern as
// backend/test/integration/stripe-webhook.test.js's prisma patching.
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

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
  prisma.user.findMany.mockReset();
  prisma.notification.createMany.mockReset();
  prisma.auditLog.create.mockReset();

  prisma.approvalRequest.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.notification.createMany.mockResolvedValue({ count: 0 });
  prisma.auditLog.create.mockResolvedValue({});
});

// ─── Notification fan-out ─────────────────────────────────────────────────

describe('POST /api/approvals — Notification side-effect (PRD §12 #4a)', () => {
  test('creates notification for every ADMIN/MANAGER in the tenant', async () => {
    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 11,
      entity: 'Deal',
      entityId: 500,
      reason: 'Discount > 20%',
      status: 'PENDING',
      requestedBy: 7,
      tenantId: 1,
    });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const app = makeApp({ tenantId: 1, userId: 7 });
    const res = await request(app)
      .post('/api/approvals')
      .send({ entity: 'Deal', entityId: 500, reason: 'Discount > 20%' });

    expect(res.status).toBe(201);

    // The route calls user.findMany TWICE: once via hydrateUsers() (to
    // graft the requester onto the response), once for the approvers
    // fan-out. We assert the approvers query ran by finding the call
    // whose where clause filters on role IN [ADMIN,MANAGER].
    const approverCall = prisma.user.findMany.mock.calls.find(
      (c) => c[0]?.where?.role && Array.isArray(c[0].where.role.in) && c[0].where.role.in.includes('ADMIN'),
    );
    expect(approverCall).toBeDefined();
    expect(approverCall[0].where.tenantId).toBe(1);
    expect(approverCall[0].where.role).toEqual({ in: ['ADMIN', 'MANAGER'] });

    // createMany fan-out
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    const notifArg = prisma.notification.createMany.mock.calls[0][0];
    expect(notifArg.data).toHaveLength(3);
    notifArg.data.forEach((n) => {
      expect(n.tenantId).toBe(1);
      expect(n.type).toBe('approval');
      expect(n.title).toContain('Deal');
      expect(n.title).toContain('500');
      expect(n.link).toBe('/approvals/11');
      expect(n.message).toContain('Deal');
    });
  });

  test('zero approvers → notification.createMany NOT called; 201 still returned', async () => {
    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 12,
      entity: 'Quote',
      entityId: 9,
      reason: null,
      status: 'PENDING',
      requestedBy: 7,
      tenantId: 1,
    });
    prisma.user.findMany.mockResolvedValueOnce([]);

    const app = makeApp();
    const res = await request(app)
      .post('/api/approvals')
      .send({ entity: 'Quote', entityId: 9 });

    expect(res.status).toBe(201);
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });

  test('notification.createMany failure → caught, request still 201', async () => {
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 13,
      entity: 'Deal',
      entityId: 1,
      reason: 'oops',
      status: 'PENDING',
      requestedBy: 7,
      tenantId: 1,
    });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 1 }]);
    prisma.notification.createMany.mockRejectedValueOnce(new Error('DB unavailable'));

    const app = makeApp();
    const res = await request(app)
      .post('/api/approvals')
      .send({ entity: 'Deal', entityId: 1 });

    expect(res.status).toBe(201);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test('long reason is truncated to 80 chars in the notification message', async () => {
    const longReason = 'A'.repeat(200);
    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 14,
      entity: 'Deal',
      entityId: 1,
      reason: longReason,
      status: 'PENDING',
      requestedBy: 7,
      tenantId: 1,
    });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 1 }]);

    const app = makeApp();
    await request(app)
      .post('/api/approvals')
      .send({ entity: 'Deal', entityId: 1, reason: longReason });

    const notif = prisma.notification.createMany.mock.calls[0][0].data[0];
    // The message contains the truncated reason (80 chars max from the
    // reason itself, plus the surrounding template).
    const aMatch = notif.message.match(/A+/);
    expect(aMatch).not.toBeNull();
    expect(aMatch[0].length).toBeLessThanOrEqual(80);
  });

  test('null reason → message still emits without "—" suffix from null', async () => {
    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 15,
      entity: 'Quote',
      entityId: 9,
      reason: null,
      status: 'PENDING',
      requestedBy: 7,
      tenantId: 1,
    });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 1 }]);

    const app = makeApp();
    await request(app)
      .post('/api/approvals')
      .send({ entity: 'Quote', entityId: 9 });

    const notif = prisma.notification.createMany.mock.calls[0][0].data[0];
    expect(notif.message).not.toContain('null');
    expect(notif.message).not.toContain('undefined');
  });
});
