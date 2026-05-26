// @ts-check
/**
 * Unit tests for backend/routes/leave.js — pins the wellness staff-leave
 * management route contract: policies (CRUD), balances (self + admin/manager
 * view), and requests (submit / list / get / approve / reject / cancel) +
 * the admin-gated manual trigger for the leave-policy carry-forward cron.
 *
 * Surfaces under test (per route file's own header):
 *   GET    /api/leave/policies                  — list active policies
 *   POST   /api/leave/policies                  — admin: create policy
 *   PUT    /api/leave/policies/:id              — admin: edit policy
 *   DELETE /api/leave/policies/:id              — admin: soft-delete
 *   GET    /api/leave/balances/me               — own balances (lazy-create)
 *   GET    /api/leave/balances/:userId          — manager/admin: another user
 *   POST   /api/leave/requests                  — submit request
 *   GET    /api/leave/requests                  — list (own / all if mgr+)
 *   GET    /api/leave/requests/:id              — get single
 *   POST   /api/leave/requests/:id/approve      — mgr+: approve
 *   POST   /api/leave/requests/:id/reject       — mgr+: reject
 *   POST   /api/leave/requests/:id/cancel       — requester only, PENDING only
 *   POST   /api/leave/policy-carry-forward/run  — admin: manual cron trigger
 *
 * What this file pins
 * ───────────────────
 *   1. List policies: tenant-scoped, only active by default (isActive=true);
 *      ?includeInactive=1 drops the active filter.
 *   2. Auth gate: no Authorization → 401 (verifyToken).
 *   3. Create policy as USER → 403 (verifyRole ADMIN).
 *   4. Create policy: missing `name` → 400 NAME_REQUIRED.
 *   5. Create policy: invalid `leaveType` → 400 INVALID_LEAVE_TYPE with the
 *      allowed enum list echoed in the response.
 *   6. Create policy: `annualEntitlement` out of [0..365] → 400
 *      INVALID_ANNUAL_ENTITLEMENT.
 *   7. Create policy happy path: 201, persisted with tenantId+trimmed name+
 *      default accrualPattern=UPFRONT.
 *   8. Delete policy: soft-delete (isActive=false), 204 No Content, audit
 *      side-effect not 404 on subsequent reads (tenant-scoped findFirst).
 *   9. Cross-tenant policy update: PUT /policies/:id from tenant 2 against
 *      a tenant-1 row → 404 (tenant-scoped findFirst).
 *  10. Balances/me: lazy-creates LeaveBalance row when none exists for
 *      (user, policy, current year); returns [{policy, balance}].
 *  11. Balances/:userId as USER role → 403 (verifyRole ADMIN/MANAGER).
 *  12. Balances/:userId non-numeric param → 400 INVALID_USER_ID.
 *  13. Balances/:userId cross-tenant user → 404 USER_NOT_FOUND.
 *  14. Submit request: missing policyId → 400 POLICY_REQUIRED.
 *  15. Submit request: half-day `days` value → 400 HALF_DAY_NOT_SUPPORTED
 *      (MVP scope guard).
 *  16. Submit request: missing/malformed startDate/endDate → 400 DATE_REQUIRED.
 *  17. Submit request: endDate < startDate → 400 INVERTED_DATE_RANGE.
 *  18. Submit request: invalid range (>365 days) → 400 INVALID_DAYS.
 *  19. Submit request: unknown policyId in this tenant → 404 POLICY_NOT_FOUND
 *      (tenant-scoped findFirst).
 *  20. Submit request: balance check — INSUFFICIENT_BALANCE → 409 with
 *      available count echoed; no LeaveRequest row created.
 *  21. Submit request: UNPAID policy bypasses balance check (no decrement).
 *  22. List requests: USER role sees only own rows (where.userId pinned).
 *  23. List requests: MANAGER role sees all tenant rows when no ?userId given.
 *  24. Get request by id: USER cannot read another user's row → 403 RBAC_DENIED.
 *  25. Approve as USER → 403 (verifyRole ADMIN/MANAGER).
 *  26. Approve already-decided request → 409 ALREADY_DECIDED.
 *  27. Reject already-decided request → 409 ALREADY_DECIDED.
 *  28. Cancel by non-requester → 403 RBAC_DENIED.
 *  29. policy-carry-forward/run as USER → 403 (verifyRole ADMIN).
 *  30. policy-carry-forward/run with malformed body.now → 400 INVALID_INPUT.
 *
 * Test pattern mirrors backend/test/routes/attendance.test.js — Prisma
 * singleton monkey-patch (before requiring the router), supertest with a
 * real verifyToken middleware fed an HS256 JWT signed with the dev-fallback
 * secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ── Prisma singleton patching. Must happen BEFORE the router is required. ──
prisma.leavePolicy = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.leaveRequest = prisma.leaveRequest || {};
prisma.leaveRequest.findMany = vi.fn();
prisma.leaveRequest.findFirst = vi.fn();
prisma.leaveRequest.create = vi.fn();
prisma.leaveRequest.update = vi.fn();
prisma.leaveBalance = {
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.user = prisma.user || {};
prisma.user.findFirst = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// Patch singletons touched by the writeAudit helper (lib/audit.js) and the
// emitEvent helper (lib/eventBus.js). Both are required transitively via
// the CJS route module, so we can't use vi.mock (which only intercepts ESM
// imports). Patching the singleton makes the real helpers run with stubbed
// prisma calls — they no-op cleanly without touching the DB.
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({});
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
prisma.automationRule = prisma.automationRule || {};
prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
prisma.notification = prisma.notification || {};
prisma.notification.create = vi.fn().mockResolvedValue({});

// Provide a $transaction shim that just invokes the callback with `prisma`
// itself as the tx client. The route's logic only uses the tx for
// leaveBalance and leaveRequest, both of which we've patched above.
prisma.$transaction = vi.fn(async (fnOrArr) => {
  if (typeof fnOrArr === 'function') return fnOrArr(prisma);
  return Promise.all(fnOrArr);
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Stub the leave-policy engine import so the route mount doesn't drag in
// the real cron module. The route only ever calls runForTenant via the
// admin-gated /policy-carry-forward/run endpoint; we mock it inline below.
const leavePolicyEngineMock = {
  runForTenant: vi.fn(),
};
// Mutate the CJS cache entry so the route's `require(...)` resolves to
// our mock instead of the real engine. Path-resolution must match the
// route's require literal verbatim.
const enginePath = requireCJS.resolve('../../cron/leavePolicyEngine');
requireCJS.cache[enginePath] = {
  id: enginePath,
  filename: enginePath,
  loaded: true,
  exports: leavePolicyEngineMock,
};

const leaveRouter = requireCJS('../../routes/leave');

// Keep in sync with backend/config/secrets.js fallback.
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function tokenFor({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/leave', leaveRouter);
  return app;
}

function authedReq(method, url, { tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const token = tokenFor({ tenantId, userId, role });
  return request(makeApp())[method](url).set('Authorization', `Bearer ${token}`);
}

beforeEach(() => {
  prisma.leavePolicy.findMany.mockReset().mockResolvedValue([]);
  prisma.leavePolicy.findFirst.mockReset();
  prisma.leavePolicy.findUnique.mockReset();
  prisma.leavePolicy.create.mockReset();
  prisma.leavePolicy.update.mockReset();
  prisma.leavePolicy.delete.mockReset();
  prisma.leaveRequest.findMany.mockReset().mockResolvedValue([]);
  prisma.leaveRequest.findFirst.mockReset();
  prisma.leaveRequest.create.mockReset();
  prisma.leaveRequest.update.mockReset();
  prisma.leaveBalance.findUnique.mockReset().mockResolvedValue(null);
  prisma.leaveBalance.create.mockReset();
  prisma.leaveBalance.update.mockReset();
  prisma.user.findFirst.mockReset();
  leavePolicyEngineMock.runForTenant.mockReset();
});

// ── /policies ──────────────────────────────────────────────────────────

describe('GET /policies', () => {
  test('default: filters by tenant + isActive=true', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, name: 'Casual Leave', leaveType: 'CASUAL', annualEntitlement: 12, isActive: true },
    ]);

    const res = await authedReq('get', '/api/leave/policies', { tenantId: 1 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const where = prisma.leavePolicy.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(1);
    expect(where.isActive).toBe(true);
  });

  test('?includeInactive=1 drops the isActive filter', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([]);
    await authedReq('get', '/api/leave/policies?includeInactive=1');
    const where = prisma.leavePolicy.findMany.mock.calls[0][0].where;
    expect(where.isActive).toBeUndefined();
  });

  test('missing Authorization → 401 (verifyToken gate)', async () => {
    const res = await request(makeApp()).get('/api/leave/policies');
    expect(res.status).toBe(401);
  });
});

describe('POST /policies', () => {
  test('USER role → 403 (verifyRole ADMIN gate)', async () => {
    const res = await authedReq('post', '/api/leave/policies', { role: 'USER' })
      .send({ name: 'Earned', leaveType: 'EARNED', annualEntitlement: 15 });

    expect(res.status).toBe(403);
    expect(prisma.leavePolicy.create).not.toHaveBeenCalled();
  });

  test('missing name → 400 NAME_REQUIRED', async () => {
    const res = await authedReq('post', '/api/leave/policies', { role: 'ADMIN' })
      .send({ leaveType: 'CASUAL', annualEntitlement: 10 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NAME_REQUIRED');
    expect(prisma.leavePolicy.create).not.toHaveBeenCalled();
  });

  test('invalid leaveType → 400 INVALID_LEAVE_TYPE with allowed enum echoed', async () => {
    const res = await authedReq('post', '/api/leave/policies', { role: 'ADMIN' })
      .send({ name: 'Bogus', leaveType: 'VACATION', annualEntitlement: 10 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_LEAVE_TYPE');
    expect(Array.isArray(res.body.allowed)).toBe(true);
    expect(res.body.allowed).toContain('CASUAL');
    expect(res.body.allowed).toContain('UNPAID');
  });

  test('annualEntitlement out of range → 400 INVALID_ANNUAL_ENTITLEMENT', async () => {
    const res = await authedReq('post', '/api/leave/policies', { role: 'ADMIN' })
      .send({ name: 'Crazy', leaveType: 'CASUAL', annualEntitlement: 500 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ANNUAL_ENTITLEMENT');
  });

  test('happy path: 201 with trimmed name + default accrualPattern=UPFRONT', async () => {
    prisma.leavePolicy.create.mockImplementation(({ data }) => ({ id: 42, ...data }));

    const res = await authedReq('post', '/api/leave/policies', { tenantId: 5, role: 'ADMIN' })
      .send({ name: '  Sick Leave  ', leaveType: 'SICK', annualEntitlement: 12 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(42);
    const createArgs = prisma.leavePolicy.create.mock.calls[0][0];
    expect(createArgs.data.tenantId).toBe(5);
    expect(createArgs.data.name).toBe('Sick Leave');
    expect(createArgs.data.accrualPattern).toBe('UPFRONT');
    expect(createArgs.data.annualEntitlement).toBe(12);
  });
});

describe('PUT /policies/:id', () => {
  test('cross-tenant: 404 (tenant-scoped findFirst)', async () => {
    prisma.leavePolicy.findFirst.mockResolvedValue(null);

    const res = await authedReq('put', '/api/leave/policies/99', { tenantId: 2, role: 'ADMIN' })
      .send({ name: 'Hijack attempt' });

    expect(res.status).toBe(404);
    // The findFirst MUST have been scoped to tenant 2 (not tenant 1).
    const where = prisma.leavePolicy.findFirst.mock.calls[0][0].where;
    expect(where.tenantId).toBe(2);
    expect(where.id).toBe(99);
    expect(prisma.leavePolicy.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /policies/:id', () => {
  test('soft-deletes (isActive=false) with 204 No Content', async () => {
    prisma.leavePolicy.findFirst.mockResolvedValue({ id: 7, tenantId: 1, name: 'Casual' });
    prisma.leavePolicy.update.mockResolvedValue({ id: 7, isActive: false });

    const res = await authedReq('delete', '/api/leave/policies/7', { role: 'ADMIN' });

    expect(res.status).toBe(204);
    const updateArgs = prisma.leavePolicy.update.mock.calls[0][0];
    expect(updateArgs.where.id).toBe(7);
    expect(updateArgs.data.isActive).toBe(false);
    // Soft-delete must NOT use prisma.leavePolicy.delete (would orphan
    // LeaveRequest history rows per the route's documented rationale).
    expect(prisma.leavePolicy.delete).not.toHaveBeenCalled();
  });
});

// ── /balances ──────────────────────────────────────────────────────────

describe('GET /balances/me', () => {
  test('lazy-creates a balance row when none exists for (user, policy, current year)', async () => {
    prisma.leavePolicy.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, name: 'Casual', leaveType: 'CASUAL', annualEntitlement: 12, accrualPattern: 'UPFRONT' },
    ]);
    prisma.leaveBalance.findUnique.mockResolvedValue(null);
    prisma.leaveBalance.create.mockImplementation(({ data }) => ({ id: 100, ...data }));

    const res = await authedReq('get', '/api/leave/balances/me', { tenantId: 1, userId: 7 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].policy.id).toBe(1);
    expect(res.body[0].balance.userId).toBe(7);
    // UPFRONT pattern → accrued=annual entitlement, available=accrued.
    expect(res.body[0].balance.accrued).toBe(12);
    expect(res.body[0].balance.available).toBe(12);
  });
});

describe('GET /balances/:userId', () => {
  test('USER role → 403 (verifyRole ADMIN/MANAGER)', async () => {
    const res = await authedReq('get', '/api/leave/balances/100', { role: 'USER' });
    expect(res.status).toBe(403);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  test('non-numeric :userId → 400 INVALID_USER_ID', async () => {
    const res = await authedReq('get', '/api/leave/balances/not-a-number', { role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_USER_ID');
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant userId → 404 USER_NOT_FOUND', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    const res = await authedReq('get', '/api/leave/balances/200', { tenantId: 1, role: 'ADMIN' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
    // Tenant scope must apply to the user lookup — otherwise tenant 1's admin
    // could read user metadata for tenant 2's userIds.
    expect(prisma.user.findFirst.mock.calls[0][0].where.tenantId).toBe(1);
    expect(prisma.user.findFirst.mock.calls[0][0].where.id).toBe(200);
  });
});

// ── /requests ──────────────────────────────────────────────────────────

describe('POST /requests', () => {
  test('missing policyId → 400 POLICY_REQUIRED', async () => {
    const res = await authedReq('post', '/api/leave/requests').send({
      startDate: '2026-06-01', endDate: '2026-06-03',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('POLICY_REQUIRED');
  });

  test('half-day `days` value → 400 HALF_DAY_NOT_SUPPORTED (MVP scope guard)', async () => {
    const res = await authedReq('post', '/api/leave/requests').send({
      policyId: 1, startDate: '2026-06-01', endDate: '2026-06-01', days: 0.5,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('HALF_DAY_NOT_SUPPORTED');
  });

  test('missing/malformed dates → 400 DATE_REQUIRED', async () => {
    const res = await authedReq('post', '/api/leave/requests').send({
      policyId: 1, startDate: 'not-a-date', endDate: '2026-06-03',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DATE_REQUIRED');
  });

  test('endDate < startDate → 400 INVERTED_DATE_RANGE', async () => {
    const res = await authedReq('post', '/api/leave/requests').send({
      policyId: 1, startDate: '2026-06-05', endDate: '2026-06-01',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVERTED_DATE_RANGE');
  });

  test('unknown policyId in this tenant → 404 POLICY_NOT_FOUND', async () => {
    prisma.leavePolicy.findFirst.mockResolvedValue(null);

    const res = await authedReq('post', '/api/leave/requests', { tenantId: 1 }).send({
      policyId: 999, startDate: '2026-06-01', endDate: '2026-06-03',
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('POLICY_NOT_FOUND');
    // findFirst was tenant-scoped (tenant 1).
    const where = prisma.leavePolicy.findFirst.mock.calls[0][0].where;
    expect(where.tenantId).toBe(1);
    expect(where.isActive).toBe(true);
  });

  test('insufficient balance → 409 INSUFFICIENT_BALANCE with available echoed; no row created', async () => {
    prisma.leavePolicy.findFirst.mockResolvedValue({
      id: 1, tenantId: 1, name: 'Casual', leaveType: 'CASUAL', annualEntitlement: 12,
      accrualPattern: 'UPFRONT', isActive: true,
    });
    // Existing balance row with only 1 day available; request asks for 3 days.
    prisma.leaveBalance.findUnique.mockResolvedValue({
      id: 50, tenantId: 1, userId: 7, policyId: 1,
      entitled: 12, accrued: 12, used: 11, pending: 0, available: 1,
    });

    const res = await authedReq('post', '/api/leave/requests', { tenantId: 1, userId: 7 }).send({
      policyId: 1, startDate: '2026-06-01', endDate: '2026-06-03',
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(res.body.available).toBe(1);
    expect(prisma.leaveRequest.create).not.toHaveBeenCalled();
  });

  test('UNPAID policy bypasses balance check (does not decrement balance)', async () => {
    prisma.leavePolicy.findFirst.mockResolvedValue({
      id: 4, tenantId: 1, name: 'Unpaid', leaveType: 'UNPAID', annualEntitlement: 0,
      accrualPattern: 'UPFRONT', isActive: true,
    });
    // Balance row has 0 available — but UNPAID bypasses the gate.
    prisma.leaveBalance.findUnique.mockResolvedValue({
      id: 60, tenantId: 1, userId: 7, policyId: 4,
      entitled: 0, accrued: 0, used: 0, pending: 0, available: 0,
    });
    prisma.leaveRequest.create.mockImplementation(({ data }) => ({ id: 555, ...data }));

    const res = await authedReq('post', '/api/leave/requests', { tenantId: 1, userId: 7 }).send({
      policyId: 4, startDate: '2026-06-01', endDate: '2026-06-03',
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(555);
    // UNPAID: balance update is skipped per the route's `if (policy.leaveType !== "UNPAID")` guard.
    expect(prisma.leaveBalance.update).not.toHaveBeenCalled();
  });
});

describe('GET /requests', () => {
  test('USER role: where.userId pinned to caller — cannot read peer rows', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([]);

    await authedReq('get', '/api/leave/requests?userId=999', { tenantId: 1, userId: 7, role: 'USER' });

    const where = prisma.leaveRequest.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(1);
    // Even though we passed userId=999, the route silently narrows non-managers to their own userId.
    expect(where.userId).toBe(7);
  });

  test('MANAGER role with no ?userId: where.userId is unset (sees all tenant rows)', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([]);

    await authedReq('get', '/api/leave/requests', { tenantId: 1, userId: 7, role: 'MANAGER' });

    const where = prisma.leaveRequest.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(1);
    expect(where.userId).toBeUndefined();
  });
});

describe('GET /requests/:id', () => {
  test('USER cannot read another user\'s row → 403 RBAC_DENIED', async () => {
    prisma.leaveRequest.findFirst.mockResolvedValue({
      id: 88, tenantId: 1, userId: 99 /* another user */, status: 'PENDING',
      policy: { id: 1, name: 'Casual', leaveType: 'CASUAL' },
    });

    const res = await authedReq('get', '/api/leave/requests/88', { tenantId: 1, userId: 7, role: 'USER' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });
});

// ── /requests/:id/approve & /reject ────────────────────────────────────

describe('POST /requests/:id/approve', () => {
  test('USER role → 403 (verifyRole ADMIN/MANAGER)', async () => {
    const res = await authedReq('post', '/api/leave/requests/1/approve', { role: 'USER' }).send({});
    expect(res.status).toBe(403);
    expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
  });

  test('already-decided request → 409 ALREADY_DECIDED with current status echoed', async () => {
    prisma.leaveRequest.findFirst.mockResolvedValue({
      id: 1, tenantId: 1, userId: 7, policyId: 1, days: 2, status: 'APPROVED',
    });

    const res = await authedReq('post', '/api/leave/requests/1/approve', { role: 'ADMIN' }).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_DECIDED');
    expect(res.body.status).toBe('APPROVED');
    expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
  });
});

describe('POST /requests/:id/reject', () => {
  test('already-decided request → 409 ALREADY_DECIDED with current status echoed', async () => {
    prisma.leaveRequest.findFirst.mockResolvedValue({
      id: 1, tenantId: 1, userId: 7, policyId: 1, days: 2, status: 'REJECTED',
    });

    const res = await authedReq('post', '/api/leave/requests/1/reject', { role: 'ADMIN' }).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_DECIDED');
    expect(res.body.status).toBe('REJECTED');
    expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
  });
});

// ── /requests/:id/cancel ───────────────────────────────────────────────

describe('POST /requests/:id/cancel', () => {
  test('non-requester (different userId) → 403 RBAC_DENIED', async () => {
    prisma.leaveRequest.findFirst.mockResolvedValue({
      id: 1, tenantId: 1, userId: 999 /* not the caller */, policyId: 1, days: 2, status: 'PENDING',
    });

    const res = await authedReq('post', '/api/leave/requests/1/cancel', { tenantId: 1, userId: 7, role: 'ADMIN' })
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
    expect(prisma.leaveRequest.update).not.toHaveBeenCalled();
  });
});

// ── /policy-carry-forward/run ──────────────────────────────────────────

describe('POST /policy-carry-forward/run', () => {
  test('USER role → 403 (verifyRole ADMIN)', async () => {
    const res = await authedReq('post', '/api/leave/policy-carry-forward/run', { role: 'USER' }).send({});
    expect(res.status).toBe(403);
    expect(leavePolicyEngineMock.runForTenant).not.toHaveBeenCalled();
  });

  test('malformed body.now → 400 INVALID_INPUT (does not invoke engine)', async () => {
    const res = await authedReq('post', '/api/leave/policy-carry-forward/run', { role: 'ADMIN' })
      .send({ now: 'not-a-real-date-at-all' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(res.body.success).toBe(false);
    expect(leavePolicyEngineMock.runForTenant).not.toHaveBeenCalled();
  });

  test('happy path: invokes engine.runForTenant with caller tenantId + returns envelope', async () => {
    leavePolicyEngineMock.runForTenant.mockResolvedValue({
      policiesProcessed: 2, balancesCarried: 5, encashed: 1,
    });

    const res = await authedReq('post', '/api/leave/policy-carry-forward/run', { tenantId: 42, role: 'ADMIN' })
      .send({ now: '2026-03-31T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tenantId).toBe(42);
    expect(res.body.policiesProcessed).toBe(2);
    expect(leavePolicyEngineMock.runForTenant).toHaveBeenCalledTimes(1);
    expect(leavePolicyEngineMock.runForTenant.mock.calls[0][0]).toBe(42);
  });
});
