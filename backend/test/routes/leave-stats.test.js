// @ts-check
/**
 * Unit tests for backend/routes/leave.js's /stats aggregator endpoint --
 * HRMS polish slice. Pins the first /stats endpoint on the LeaveRequest
 * route: tenant-wide KPI surface for the HR dashboard, mirroring the
 * canonical /stats posture established by travel_suppliers.js's
 * /suppliers/stats (#903 slice 23).
 *
 * Endpoint shape under test
 * -------------------------
 *   GET /api/leave/stats
 *
 *   Auth: verifyToken + verifyRole(['ADMIN','MANAGER'])
 *   Tenant scope: req.user.tenantId
 *   Query: ?from / ?to (ISO date bounds on submittedAt; invalid -> 400 INVALID_DATE)
 *
 *   Response envelope:
 *     {
 *       total: N,
 *       byStatus: { PENDING: N, APPROVED: M, REJECTED: K, CANCELLED: L },
 *       byType:   { CASUAL: N, SICK: M, EARNED: K, ... },
 *       totalDaysApproved: N.NN,
 *       totalDaysPending:  N.NN,
 *       pendingCount: N,
 *       lastRequestedAt: ISO string | null,
 *     }
 *
 * What this file pins
 * -------------------
 *   1.  401 when no Authorization header
 *   2.  403 when role is USER (verifyRole gate denies non-admin/manager)
 *   3.  400 INVALID_DATE on bad ?from
 *   4.  400 INVALID_DATE on bad ?to
 *   5.  Empty-tenant happy path -- zeroed envelope shape
 *   6.  Happy path -- 5 requests across statuses + types
 *   7.  totalDaysApproved sums ONLY APPROVED status
 *   8.  totalDaysPending sums ONLY PENDING status (the schema's
 *       "freshly submitted, awaiting decision" bucket)
 *   9.  pendingCount equals count of PENDING rows
 *  10.  lastRequestedAt resolves to the MAX submittedAt as ISO string
 *  11.  Tenant isolation -- where.tenantId is the JWT tenantId, not query
 *  12.  ?from / ?to narrows the submittedAt window
 *  13.  Fractional `days` half-up rounds to 2dp (forward-compat; schema
 *       presently rejects half-day at /requests POST as
 *       HALF_DAY_NOT_SUPPORTED, but the route's math is fractional-safe)
 *  14.  NO audit row written (read-only meta surface; matches
 *       /suppliers/stats posture)
 *
 * Test pattern mirrors backend/test/routes/attendance-summary.test.js --
 * prisma singleton monkey-patch, supertest with the real verifyToken +
 * verifyRole middleware (HS256 JWT signed with the fallback secret).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching. Must happen BEFORE the router is required.
prisma.leaveRequest = prisma.leaveRequest || {};
prisma.leaveRequest.findMany = vi.fn();
prisma.leavePolicy = prisma.leavePolicy || {};
prisma.leavePolicy.findMany = vi.fn();
prisma.leavePolicy.findFirst = vi.fn();
prisma.leaveBalance = prisma.leaveBalance || {};
prisma.leaveBalance.findUnique = vi.fn();
prisma.$transaction = prisma.$transaction || vi.fn();
// verifyToken does an optional revoked-token lookup -- stub absent so the
// real middleware (which runs in-chain) doesn't 500 hitting MySQL.
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// audit.writeAudit may fire from sibling handlers loaded with the router;
// it MUST NOT fire from the /stats handler itself -- the tests pin that.
// Hoist-safe vi.mock for ESM. The mocked fn is also reset per-test.
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Cron engine require'd at the bottom of leave.js -- stub it absent so
// the router can be loaded without side-effects in unit tests.
vi.mock('../../cron/leavePolicyEngine', () => ({
  runForTenant: vi.fn().mockResolvedValue({ ok: true }),
}));

const leaveRouter = requireCJS('../../routes/leave');
// Pull the mocked writeAudit via ESM import so the vi.mock() factory applies.
// requireCJS('../../lib/audit') would bypass the vitest module-mock layer.
const audit = await import('../../lib/audit.js');
const writeAudit = audit.writeAudit;

// auth middleware reads JWT_SECRET at module init -- keep in sync with
// backend/middleware/auth.js's fallback so signing works in tests.
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

function statsGet({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}, query = '') {
  const token = tokenFor({ tenantId, userId, role });
  return request(makeApp())
    .get(`/api/leave/stats${query}`)
    .set('Authorization', `Bearer ${token}`);
}

// Build a LeaveRequest row. status defaults PENDING; leaveType drives the
// joined policy.leaveType bucket.
function makeRow({
  status = 'PENDING',
  days = 2,
  leaveType = 'CASUAL',
  submittedAt = new Date('2026-01-15T10:00:00.000Z'),
} = {}) {
  return {
    status,
    days,
    submittedAt: submittedAt instanceof Date ? submittedAt : new Date(submittedAt),
    policy: { leaveType },
  };
}

beforeEach(() => {
  prisma.leaveRequest.findMany.mockReset();
  prisma.leaveRequest.findMany.mockResolvedValue([]);
  writeAudit.mockClear();
});

// ── 1 + 2 — auth gates ──────────────────────────────────────────────

describe('GET /api/leave/stats — auth gates', () => {
  test('missing Authorization header → 401', async () => {
    const res = await request(makeApp()).get('/api/leave/stats');
    expect(res.status).toBe(401);
  });

  test('USER role bearer → 403 (verifyRole gate denies non-admin/manager)', async () => {
    const res = await statsGet({ role: 'USER' });
    expect(res.status).toBe(403);
  });

  test('MANAGER role bearer → 200 (verifyRole accepts MANAGER)', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([]);
    const res = await statsGet({ role: 'MANAGER' });
    expect(res.status).toBe(200);
  });
});

// ── 3 + 4 — query-string validation ─────────────────────────────────

describe('GET /api/leave/stats — date-bounds validation', () => {
  test('invalid ?from → 400 INVALID_DATE', async () => {
    const res = await statsGet({}, '?from=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(res.body.error).toMatch(/from must be a valid ISO date/);
  });

  test('invalid ?to → 400 INVALID_DATE', async () => {
    const res = await statsGet({}, '?to=garbage-date');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(res.body.error).toMatch(/to must be a valid ISO date/);
  });

  test('valid ISO ?from + ?to → 200 (no validation 400)', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([]);
    const res = await statsGet({}, '?from=2026-01-01&to=2026-01-31');
    expect(res.status).toBe(200);
  });
});

// ── 5 — empty tenant ────────────────────────────────────────────────

describe('GET /api/leave/stats — empty tenant', () => {
  test('zero rows → zeroed envelope shape', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([]);
    const res = await statsGet();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      byStatus: {},
      byType: {},
      totalDaysApproved: 0,
      totalDaysPending: 0,
      pendingCount: 0,
      lastRequestedAt: null,
    });
  });
});

// ── 6 + 7 + 8 + 9 + 10 — aggregate shape ────────────────────────────

describe('GET /api/leave/stats — aggregate shape', () => {
  test('happy path: 5 requests across statuses + types', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([
      makeRow({ status: 'PENDING', days: 2, leaveType: 'CASUAL', submittedAt: '2026-01-10T09:00:00.000Z' }),
      makeRow({ status: 'APPROVED', days: 3, leaveType: 'SICK', submittedAt: '2026-01-11T09:00:00.000Z' }),
      makeRow({ status: 'APPROVED', days: 5, leaveType: 'EARNED', submittedAt: '2026-01-12T09:00:00.000Z' }),
      makeRow({ status: 'REJECTED', days: 1, leaveType: 'CASUAL', submittedAt: '2026-01-13T09:00:00.000Z' }),
      makeRow({ status: 'CANCELLED', days: 4, leaveType: 'UNPAID', submittedAt: '2026-01-14T09:00:00.000Z' }),
    ]);
    const res = await statsGet();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.byStatus).toEqual({
      PENDING: 1,
      APPROVED: 2,
      REJECTED: 1,
      CANCELLED: 1,
    });
    expect(res.body.byType).toEqual({
      CASUAL: 2,
      SICK: 1,
      EARNED: 1,
      UNPAID: 1,
    });
  });

  test('totalDaysApproved sums ONLY APPROVED status', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([
      makeRow({ status: 'APPROVED', days: 3 }),
      makeRow({ status: 'APPROVED', days: 5 }),
      makeRow({ status: 'PENDING', days: 100 }),   // excluded
      makeRow({ status: 'REJECTED', days: 100 }),  // excluded
      makeRow({ status: 'CANCELLED', days: 100 }), // excluded
    ]);
    const res = await statsGet();
    expect(res.body.totalDaysApproved).toBe(8);
    // pending sum unaffected by the noise above (only the PENDING row counts)
    expect(res.body.totalDaysPending).toBe(100);
  });

  test('totalDaysPending sums ONLY PENDING status (schema enum has no SUBMITTED)', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([
      makeRow({ status: 'PENDING', days: 2 }),
      makeRow({ status: 'PENDING', days: 4 }),
      makeRow({ status: 'APPROVED', days: 99 }),  // excluded
      makeRow({ status: 'REJECTED', days: 99 }),  // excluded
    ]);
    const res = await statsGet();
    expect(res.body.totalDaysPending).toBe(6);
  });

  test('pendingCount equals the PENDING-status row count', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([
      makeRow({ status: 'PENDING' }),
      makeRow({ status: 'PENDING' }),
      makeRow({ status: 'PENDING' }),
      makeRow({ status: 'APPROVED' }),
      makeRow({ status: 'REJECTED' }),
      makeRow({ status: 'CANCELLED' }),
    ]);
    const res = await statsGet();
    expect(res.body.pendingCount).toBe(3);
    expect(res.body.byStatus.PENDING).toBe(3);
  });

  test('lastRequestedAt resolves to MAX submittedAt as ISO string', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([
      makeRow({ submittedAt: '2026-01-05T09:00:00.000Z' }),
      makeRow({ submittedAt: '2026-01-25T14:30:00.000Z' }), // max
      makeRow({ submittedAt: '2026-01-10T11:15:00.000Z' }),
    ]);
    const res = await statsGet();
    expect(res.body.lastRequestedAt).toBe('2026-01-25T14:30:00.000Z');
  });
});

// ── 11 — tenant isolation ───────────────────────────────────────────

describe('GET /api/leave/stats — tenant isolation', () => {
  test('where.tenantId comes from JWT, not any query parameter', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([]);
    await statsGet({ tenantId: 42 });
    expect(prisma.leaveRequest.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.leaveRequest.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
  });

  test('a different tenant\'s bearer scopes the query to its own tenantId', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([]);
    await statsGet({ tenantId: 7 });
    const args = prisma.leaveRequest.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(7);
  });
});

// ── 12 — date window narrowing ──────────────────────────────────────

describe('GET /api/leave/stats — ?from/?to narrows submittedAt window', () => {
  test('?from sets submittedAt.gte on the Prisma where clause', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([]);
    await statsGet({}, '?from=2026-01-01T00:00:00.000Z');
    const args = prisma.leaveRequest.findMany.mock.calls[0][0];
    expect(args.where.submittedAt).toBeDefined();
    expect(args.where.submittedAt.gte).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  test('?to sets submittedAt.lte on the Prisma where clause', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([]);
    await statsGet({}, '?to=2026-01-31T23:59:59.000Z');
    const args = prisma.leaveRequest.findMany.mock.calls[0][0];
    expect(args.where.submittedAt).toBeDefined();
    expect(args.where.submittedAt.lte).toEqual(new Date('2026-01-31T23:59:59.000Z'));
  });

  test('?from + ?to sets BOTH bounds (gte + lte) on the same key', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([]);
    await statsGet({}, '?from=2026-01-01&to=2026-01-31');
    const args = prisma.leaveRequest.findMany.mock.calls[0][0];
    expect(args.where.submittedAt.gte).toEqual(new Date('2026-01-01'));
    expect(args.where.submittedAt.lte).toEqual(new Date('2026-01-31'));
  });
});

// ── 13 — fractional days half-up rounding ───────────────────────────

describe('GET /api/leave/stats — fractional days half-up rounding (forward-compat)', () => {
  test('fractional days sum half-up rounds to 2dp', async () => {
    // The schema rejects half-day at /requests POST as HALF_DAY_NOT_SUPPORTED,
    // but the /stats math has to be forward-compat for any future migration
    // that loosens the Int constraint on LeaveRequest.days.
    prisma.leaveRequest.findMany.mockResolvedValue([
      makeRow({ status: 'APPROVED', days: 0.5 }),
      makeRow({ status: 'APPROVED', days: 1.25 }),
      makeRow({ status: 'APPROVED', days: 0.333 }),
    ]);
    const res = await statsGet();
    // 0.5 + 1.25 + 0.333 = 2.083 -> half-up 2dp -> 2.08
    expect(res.body.totalDaysApproved).toBe(2.08);
  });

  test('fractional pending days half-up rounds to 2dp', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([
      makeRow({ status: 'PENDING', days: 0.5 }),
      makeRow({ status: 'PENDING', days: 0.5 }),
    ]);
    const res = await statsGet();
    expect(res.body.totalDaysPending).toBe(1.0);
    expect(res.body.pendingCount).toBe(2);
  });
});

// ── 14 — NO audit row written ───────────────────────────────────────

describe('GET /api/leave/stats — no audit row written', () => {
  test('happy path response does NOT call writeAudit', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([
      makeRow({ status: 'APPROVED', days: 3 }),
    ]);
    const res = await statsGet();
    expect(res.status).toBe(200);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  test('empty tenant response does NOT call writeAudit', async () => {
    prisma.leaveRequest.findMany.mockResolvedValue([]);
    const res = await statsGet();
    expect(res.status).toBe(200);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  test('400 INVALID_DATE response does NOT call writeAudit', async () => {
    const res = await statsGet({}, '?from=garbage');
    expect(res.status).toBe(400);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
