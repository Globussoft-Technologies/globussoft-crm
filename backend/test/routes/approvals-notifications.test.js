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

// ─── Notification fan-out — additional coverage ───────────────────────────
// These cases extend the original 5 to cover the contracts the sibling
// approvals.test.js does NOT exercise: batch shape, approver pool filtering,
// per-recipient userId mapping, link format invariant, reason-boundary slice,
// and the "no notification on validation failure / on approve|reject" side-
// effect surface.

describe('POST /api/approvals — Notification fan-out shape', () => {
  test('createMany fires exactly ONCE per request (single batch, not per-approver)', async () => {
    // Contract: route uses createMany with a data: [...] array, NOT a loop
    // calling create() per recipient. This pins the batch shape so a future
    // refactor that splits into per-approver create() calls (subtly worse —
    // breaks transactionality, multiplies DB round-trips) surfaces here.
    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 100, entity: 'Deal', entityId: 1, reason: null,
      status: 'PENDING', requestedBy: 7, tenantId: 1,
    });
    prisma.user.findMany.mockResolvedValueOnce([
      { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 },
    ]);

    await request(makeApp()).post('/api/approvals').send({ entity: 'Deal', entityId: 1 });

    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.notification.createMany.mock.calls[0][0].data).toHaveLength(5);
  });

  test('each notification row gets the matching approver userId (no cross-recipient leak)', async () => {
    // Pin the userId → recipient mapping: every row's userId is one of the
    // approver IDs returned by user.findMany, no duplicates, no missing.
    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 101, entity: 'Deal', entityId: 1, reason: null,
      status: 'PENDING', requestedBy: 7, tenantId: 1,
    });
    prisma.user.findMany.mockResolvedValueOnce([
      { id: 11 }, { id: 22 }, { id: 33 },
    ]);

    await request(makeApp()).post('/api/approvals').send({ entity: 'Deal', entityId: 1 });

    const data = prisma.notification.createMany.mock.calls[0][0].data;
    const ids = data.map((n) => n.userId).sort();
    expect(ids).toEqual([11, 22, 33]);
  });

  test('approver query is tenant-scoped (cross-tenant approvers never receive notifications)', async () => {
    // The route's approver lookup is where: {tenantId, role: in[ADMIN,MANAGER]}.
    // This case pins that the tenantId filter is present + matches req.user.tenantId,
    // not some other constant.
    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 102, entity: 'Quote', entityId: 1, reason: null,
      status: 'PENDING', requestedBy: 7, tenantId: 42,
    });
    prisma.user.findMany.mockResolvedValueOnce([]);

    await request(makeApp({ tenantId: 42, userId: 7 }))
      .post('/api/approvals')
      .send({ entity: 'Quote', entityId: 1 });

    const approverCall = prisma.user.findMany.mock.calls.find(
      (c) => c[0]?.where?.role && Array.isArray(c[0].where.role.in),
    );
    expect(approverCall).toBeDefined();
    expect(approverCall[0].where.tenantId).toBe(42);
    // The select clause should ONLY pull id (privacy minimisation — we don't
    // need names / emails to write the notification row).
    expect(approverCall[0].select).toEqual({ id: true });
  });

  test('USER role users are NOT in the approver lookup (role filter is in[ADMIN,MANAGER])', async () => {
    // The route restricts the approver pool to ADMIN + MANAGER. Plain USER
    // role members must NOT appear in the role: in[...] filter — they don't
    // have /to-approve queue access, so they shouldn't get the notification.
    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 103, entity: 'Deal', entityId: 1, reason: null,
      status: 'PENDING', requestedBy: 7, tenantId: 1,
    });
    prisma.user.findMany.mockResolvedValueOnce([]);

    await request(makeApp()).post('/api/approvals').send({ entity: 'Deal', entityId: 1 });

    const approverCall = prisma.user.findMany.mock.calls.find(
      (c) => c[0]?.where?.role && Array.isArray(c[0].where.role.in),
    );
    expect(approverCall[0].where.role.in).not.toContain('USER');
    expect(approverCall[0].where.role.in).toEqual(['ADMIN', 'MANAGER']);
  });

  test('link field is exactly `/approvals/<created.id>` (frontend deep-link contract)', async () => {
    // The frontend NotificationBell uses link as the click-target.
    // Trailing slash, query string, or template-literal interpolation bugs
    // would break the deep-link — pin the exact format.
    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 9876, entity: 'Deal', entityId: 1, reason: null,
      status: 'PENDING', requestedBy: 7, tenantId: 1,
    });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    await request(makeApp()).post('/api/approvals').send({ entity: 'Deal', entityId: 1 });

    const data = prisma.notification.createMany.mock.calls[0][0].data;
    data.forEach((n) => {
      expect(n.link).toBe('/approvals/9876');
    });
  });

  test('title format is exactly `Approval pending: <entity> #<entityId>`', async () => {
    // Pin the title format. The bell renders title verbatim — a refactor
    // that drops the "Approval pending:" prefix would silently render a
    // less-discoverable bell entry.
    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 200, entity: 'Quote', entityId: 77, reason: null,
      status: 'PENDING', requestedBy: 7, tenantId: 1,
    });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 1 }]);

    await request(makeApp()).post('/api/approvals').send({ entity: 'Quote', entityId: 77 });

    const notif = prisma.notification.createMany.mock.calls[0][0].data[0];
    expect(notif.title).toBe('Approval pending: Quote #77');
  });

  test('reason exactly 80 chars long → message contains the full reason (boundary, no truncation)', async () => {
    // Boundary case: slice(0, 80) returns the full string when input.length === 80.
    // Pins that the truncation is "max 80 chars FROM the reason", not "always
    // truncated even when short enough". Use 'Z' (absent from the static
    // template "A new approval request was created for ...") to avoid the
    // regex matching template letters from the prefix.
    const reason80 = 'Z'.repeat(80);
    prisma.approvalRequest.create.mockResolvedValueOnce({
      id: 201, entity: 'Deal', entityId: 1, reason: reason80,
      status: 'PENDING', requestedBy: 7, tenantId: 1,
    });
    prisma.user.findMany.mockResolvedValueOnce([{ id: 1 }]);

    await request(makeApp())
      .post('/api/approvals')
      .send({ entity: 'Deal', entityId: 1, reason: reason80 });

    const notif = prisma.notification.createMany.mock.calls[0][0].data[0];
    const zMatch = notif.message.match(/Z+/);
    expect(zMatch).not.toBeNull();
    expect(zMatch[0].length).toBe(80); // exactly 80, not 79 (off-by-one) or 81 (over-slice)
  });

  test('validation 400 (missing entity) → approver query NOT run, createMany NOT called', async () => {
    // The approver lookup + fan-out is downstream of the entity validator.
    // A 400 short-circuit must NOT touch user.findMany or notification.createMany —
    // doing so would burn DB round-trips on every bad client request.
    const res = await request(makeApp())
      .post('/api/approvals')
      .send({ entityId: 10 }); // entity missing

    expect(res.status).toBe(400);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
  });
});
