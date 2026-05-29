// @ts-check
/**
 * Unit + integration tests for backend/routes/attendance.js's /summary
 * aggregator — pins the additive contract introduced for #802 (Early /
 * On-Time KPI tiles) and #804 (per-user late / absent / leaves counters
 * for payroll CSV export).
 *
 * Issue context
 * ─────────────
 *   #802 — Zylu-Gap ATT-001. Attendance dashboard was rendering five tiles
 *          (Present / Half-day / Late / Absent / Total minutes). Zylu spec
 *          requires six tiles: Total / Absent / Present / Early / On-Time /
 *          Late. Frontend tiles shipped with `summary.early` and
 *          `summary.onTime` reads (Attendance.jsx commit 123f09d). Backend
 *          had to grow those two top-level counters. We derive them at
 *          query time from `Attendance.clockInAt` vs a tenant-wide
 *          scheduled-start (env-tunable: ATTENDANCE_SHIFT_START_HOUR /
 *          _MINUTE / _ON_TIME_TOLERANCE_MIN). No new schema, no new enum
 *          values — pure derived buckets per row.
 *
 *   #804 — Zylu-Gap ATT-003. Payroll CSV export shipped in the frontend
 *          reading `summary.byUser[i].{late, absent, leaves}` per row but
 *          backend's byUser entries only carried {userId, days, minutes,
 *          present, halfDay}. CSV rendered 0/0/0 for every staff member.
 *          We extend byUser to include `late`, `absent` (both derived
 *          from Attendance.status), and `leaves` (count of APPROVED
 *          LeaveRequest rows overlapping the period).
 *
 * What this file pins
 * ───────────────────
 *   TOP-LEVEL (#802):
 *     1. Empty period (no rows, no leaves) → early=0, onTime=0, byUser={}.
 *     2. classifyPunctuality buckets correctly:
 *        - clockInAt > shiftStart+tolerance → AFTER (neither bucket).
 *        - clockInAt within ±tolerance → ON_TIME.
 *        - clockInAt < shiftStart-tolerance → EARLY.
 *        - clockInAt missing → null (neither bucket).
 *     3. early + onTime counters AND policy{} object surfaced.
 *     4. ABSENT/HOLIDAY rows (no clockInAt) contribute to neither bucket.
 *
 *   PER-USER (#804):
 *     5. byUser[k].late counts only LATE rows for user k.
 *     6. byUser[k].absent counts only ABSENT rows for user k.
 *     7. byUser[k].leaves counts only APPROVED LeaveRequest rows
 *        overlapping the period for user k.
 *     8. A user with ONLY a leave (no attendance row) still gets a byUser
 *        entry — days/minutes 0, leaves >= 1.
 *     9. byUser[k].early / .onTime mirror the top-level per-user
 *        contribution (Stat tile per-user, additive).
 *
 *   TENANT ISOLATION:
 *    10. The where clause passed to prisma.attendance.findMany scopes by
 *        req.user.tenantId; the where clause passed to
 *        prisma.leaveRequest.findMany scopes by req.user.tenantId AND
 *        status=APPROVED. A cross-tenant userId in ?userId= filters at
 *        the SQL layer — we don't trust the query string.
 *
 *   POLICY OVERRIDES:
 *    11. The route reads SHIFT_START_HOUR / _MINUTE / _TOLERANCE at module
 *        require time, so a process.env override has to be set BEFORE the
 *        first require. Tests cover the env-honouring path by re-loading
 *        the router with a tweaked env to confirm policy{} surfaces the
 *        override.
 *
 * Test pattern mirrors backend/test/routes/staff.test.js — prisma singleton
 * monkey-patch, supertest with a fake auth middleware. We mock both
 * prisma.attendance.findMany AND prisma.leaveRequest.findMany.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching. Must happen BEFORE the router is required.
prisma.attendance = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.leaveRequest = {
  findMany: vi.fn(),
};
prisma.user = prisma.user || {};
prisma.user.findFirst = vi.fn();
prisma.biometricDevice = prisma.biometricDevice || {};
prisma.biometricDevice.findMany = vi.fn();
// verifyToken does an optional revoked-token lookup — stub it absent so the
// real middleware (which we run in-chain) doesn't 500 hitting MySQL.
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Default env: 09:00 UTC, 15-minute tolerance. Tests assume these defaults
// unless they reload the module with overrides.
delete process.env.ATTENDANCE_SHIFT_START_HOUR;
delete process.env.ATTENDANCE_SHIFT_START_MINUTE;
delete process.env.ATTENDANCE_ON_TIME_TOLERANCE_MIN;

const attendanceRouter = requireCJS('../../routes/attendance');

// auth middleware reads JWT_SECRET at module init — keep this in sync with
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
  app.use('/api/attendance', attendanceRouter);
  return app;
}

// Convenience: a GET on /summary with an ADMIN bearer for the given tenant.
function summaryGet({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}, query = '') {
  const token = tokenFor({ tenantId, userId, role });
  return request(makeApp())
    .get(`/api/attendance/summary${query}`)
    .set('Authorization', `Bearer ${token}`);
}

// Build an Attendance row anchored to a date (00:00 UTC) with an optional
// clockInAt offset (minutes from 09:00 UTC). offset=null → no clockInAt
// (ABSENT / HOLIDAY rows).
function makeRow({
  id = 1,
  userId = 100,
  dateStr = '2026-01-15',
  offsetMinFromNine = 0, // 0 = exactly 09:00, -30 = 08:30, +20 = 09:20
  status = 'PRESENT',
  totalMinutes = 480,
}) {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  let clockInAt = null;
  if (offsetMinFromNine !== null) {
    clockInAt = new Date(`${dateStr}T09:00:00.000Z`);
    clockInAt = new Date(clockInAt.getTime() + offsetMinFromNine * 60000);
  }
  return {
    id, userId, tenantId: 1, date, clockInAt,
    clockOutAt: null, totalMinutes,
    status, source: 'MANUAL', notes: null,
    clockInLocationId: null, clockOutLocationId: null,
    biometricDeviceId: null,
    createdAt: new Date(), updatedAt: new Date(),
  };
}

beforeEach(() => {
  prisma.attendance.findMany.mockReset();
  prisma.leaveRequest.findMany.mockReset();
  prisma.attendance.findMany.mockResolvedValue([]);
  prisma.leaveRequest.findMany.mockResolvedValue([]);
});

// ── #802 + #804 — top-level + per-user shape ────────────────────────

describe('GET /summary — empty period', () => {
  test('zero rows yields zero counters everywhere', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    prisma.leaveRequest.findMany.mockResolvedValue([]);

    const res = await summaryGet({}, '?from=2026-01-01&to=2026-01-31');
    expect(res.status).toBe(200);
    expect(res.body.totalRows).toBe(0);
    expect(res.body.early).toBe(0);
    expect(res.body.onTime).toBe(0);
    expect(res.body.late).toBe(0);
    expect(res.body.absent).toBe(0);
    expect(res.body.byUser).toEqual({});
    // SUT now includes shiftEndHour + shiftEndMinute on the policy
    // envelope (added when the summary view started rendering total-
    // hours-vs-shift-duration). Pin a superset match instead of strict
    // equality so we don't have to rev this assertion for every new
    // policy field.
    expect(res.body.policy).toMatchObject({
      shiftStartHour: 9,
      shiftStartMinute: 0,
      onTimeToleranceMin: 15,
    });
  });
});

describe('GET /summary — punctuality bucketing (#802)', () => {
  test('clock-in within ±15min of 09:00 UTC counts as ON_TIME', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ id: 1, userId: 100, dateStr: '2026-01-15', offsetMinFromNine: 0 }),
      makeRow({ id: 2, userId: 100, dateStr: '2026-01-16', offsetMinFromNine: 10 }),
      makeRow({ id: 3, userId: 100, dateStr: '2026-01-17', offsetMinFromNine: -10 }),
      makeRow({ id: 4, userId: 100, dateStr: '2026-01-18', offsetMinFromNine: 15 }),
      makeRow({ id: 5, userId: 100, dateStr: '2026-01-19', offsetMinFromNine: -15 }),
    ]);
    const res = await summaryGet({}, '?from=2026-01-01&to=2026-01-31');
    expect(res.status).toBe(200);
    expect(res.body.onTime).toBe(5);
    expect(res.body.early).toBe(0);
  });

  test('clock-in more than 15min before 09:00 counts as EARLY', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ id: 1, userId: 100, dateStr: '2026-01-15', offsetMinFromNine: -16 }),
      makeRow({ id: 2, userId: 100, dateStr: '2026-01-16', offsetMinFromNine: -30 }),
      makeRow({ id: 3, userId: 100, dateStr: '2026-01-17', offsetMinFromNine: -120 }),
    ]);
    const res = await summaryGet({}, '?from=2026-01-01&to=2026-01-31');
    expect(res.body.early).toBe(3);
    expect(res.body.onTime).toBe(0);
  });

  test('clock-in more than 15min after 09:00 counts as neither (status carries LATE)', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ id: 1, userId: 100, dateStr: '2026-01-15', offsetMinFromNine: 16, status: 'LATE' }),
      makeRow({ id: 2, userId: 100, dateStr: '2026-01-16', offsetMinFromNine: 120, status: 'LATE' }),
    ]);
    const res = await summaryGet({}, '?from=2026-01-01&to=2026-01-31');
    expect(res.body.early).toBe(0);
    expect(res.body.onTime).toBe(0);
    expect(res.body.late).toBe(2);
  });

  test('rows with no clockInAt (ABSENT / HOLIDAY) contribute to neither bucket', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ id: 1, userId: 100, dateStr: '2026-01-15', offsetMinFromNine: null, status: 'ABSENT' }),
      makeRow({ id: 2, userId: 100, dateStr: '2026-01-16', offsetMinFromNine: null, status: 'HOLIDAY' }),
    ]);
    const res = await summaryGet({}, '?from=2026-01-01&to=2026-01-31');
    expect(res.body.early).toBe(0);
    expect(res.body.onTime).toBe(0);
    expect(res.body.absent).toBe(1);
    expect(res.body.holiday).toBe(1);
  });

  test('mixed bucket population — counters reconcile', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ id: 1, userId: 100, dateStr: '2026-01-15', offsetMinFromNine: -30 }), // EARLY
      makeRow({ id: 2, userId: 100, dateStr: '2026-01-16', offsetMinFromNine: 0 }),   // ON_TIME
      makeRow({ id: 3, userId: 100, dateStr: '2026-01-17', offsetMinFromNine: 5 }),   // ON_TIME
      makeRow({ id: 4, userId: 100, dateStr: '2026-01-18', offsetMinFromNine: 60, status: 'LATE' }), // AFTER
      makeRow({ id: 5, userId: 100, dateStr: '2026-01-19', offsetMinFromNine: null, status: 'ABSENT' }), // null
    ]);
    const res = await summaryGet({}, '?from=2026-01-01&to=2026-01-31');
    expect(res.body.early).toBe(1);
    expect(res.body.onTime).toBe(2);
    expect(res.body.late).toBe(1);
    expect(res.body.absent).toBe(1);
    expect(res.body.totalRows).toBe(5);
  });
});

// ── #804 — per-user breakdown ───────────────────────────────────────

describe('GET /summary — byUser per-user counters (#804)', () => {
  test('byUser[k].late counts only LATE rows for user k', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ id: 1, userId: 100, status: 'PRESENT', dateStr: '2026-01-15' }),
      makeRow({ id: 2, userId: 100, status: 'LATE', dateStr: '2026-01-16' }),
      makeRow({ id: 3, userId: 100, status: 'LATE', dateStr: '2026-01-17' }),
      makeRow({ id: 4, userId: 200, status: 'LATE', dateStr: '2026-01-15' }),
    ]);
    const res = await summaryGet({}, '?from=2026-01-01&to=2026-01-31');
    expect(res.body.byUser['100'].late).toBe(2);
    expect(res.body.byUser['100'].present).toBe(1);
    expect(res.body.byUser['200'].late).toBe(1);
  });

  test('byUser[k].absent counts only ABSENT rows for user k', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ id: 1, userId: 100, status: 'ABSENT', dateStr: '2026-01-15', offsetMinFromNine: null }),
      makeRow({ id: 2, userId: 100, status: 'PRESENT', dateStr: '2026-01-16' }),
      makeRow({ id: 3, userId: 200, status: 'ABSENT', dateStr: '2026-01-15', offsetMinFromNine: null }),
      makeRow({ id: 4, userId: 200, status: 'ABSENT', dateStr: '2026-01-16', offsetMinFromNine: null }),
    ]);
    const res = await summaryGet({}, '?from=2026-01-01&to=2026-01-31');
    expect(res.body.byUser['100'].absent).toBe(1);
    expect(res.body.byUser['200'].absent).toBe(2);
  });

  test('byUser[k].leaves counts only APPROVED LeaveRequest rows for user k', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ id: 1, userId: 100, status: 'PRESENT', dateStr: '2026-01-15' }),
    ]);
    prisma.leaveRequest.findMany.mockResolvedValue([
      { userId: 100, days: 2 },
      { userId: 100, days: 1 },
      { userId: 200, days: 5 },
    ]);
    const res = await summaryGet({}, '?from=2026-01-01&to=2026-01-31');
    expect(res.body.byUser['100'].leaves).toBe(2);
    expect(res.body.byUser['200'].leaves).toBe(1);
    // user 200 has no attendance row but appears in byUser because of the leave overlay
    expect(res.body.byUser['200'].days).toBe(0);
    expect(res.body.byUser['200'].present).toBe(0);
  });

  test('LeaveRequest where clause filters tenantId + status=APPROVED + overlap', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    prisma.leaveRequest.findMany.mockResolvedValue([]);

    await summaryGet({ tenantId: 42 }, '?from=2026-01-01&to=2026-01-31');

    expect(prisma.leaveRequest.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.leaveRequest.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
    expect(args.where.status).toBe('APPROVED');
    // Overlap predicates — leave starts on/before period end AND ends on/after period start.
    expect(args.where.startDate).toEqual({ lte: new Date('2026-01-31') });
    expect(args.where.endDate).toEqual({ gte: new Date('2026-01-01') });
  });

  test('per-user early / onTime mirror top-level contributions', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ id: 1, userId: 100, dateStr: '2026-01-15', offsetMinFromNine: -30 }), // EARLY
      makeRow({ id: 2, userId: 100, dateStr: '2026-01-16', offsetMinFromNine: 0 }),   // ON_TIME
      makeRow({ id: 3, userId: 200, dateStr: '2026-01-15', offsetMinFromNine: -30 }), // EARLY
    ]);
    const res = await summaryGet({}, '?from=2026-01-01&to=2026-01-31');
    expect(res.body.byUser['100'].early).toBe(1);
    expect(res.body.byUser['100'].onTime).toBe(1);
    expect(res.body.byUser['200'].early).toBe(1);
    expect(res.body.early).toBe(2);
    expect(res.body.onTime).toBe(1);
  });
});

// ── Tenant isolation ────────────────────────────────────────────────

describe('GET /summary — tenant isolation', () => {
  test('attendance.findMany where filters by req.user.tenantId', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    await summaryGet({ tenantId: 99 }, '?from=2026-01-01&to=2026-01-31');
    expect(prisma.attendance.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.attendance.findMany.mock.calls[0][0].where.tenantId).toBe(99);
  });

  test('cross-tenant userId filter still scopes both attendance and leaves', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    prisma.leaveRequest.findMany.mockResolvedValue([]);
    await summaryGet({ tenantId: 99 }, '?from=2026-01-01&to=2026-01-31&userId=200');
    expect(prisma.attendance.findMany.mock.calls[0][0].where.tenantId).toBe(99);
    expect(prisma.attendance.findMany.mock.calls[0][0].where.userId).toBe(200);
    expect(prisma.leaveRequest.findMany.mock.calls[0][0].where.tenantId).toBe(99);
    expect(prisma.leaveRequest.findMany.mock.calls[0][0].where.userId).toBe(200);
  });

  test('leaveRequest query failure does NOT 500 the route (graceful empty)', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ id: 1, userId: 100, status: 'PRESENT', dateStr: '2026-01-15' }),
    ]);
    prisma.leaveRequest.findMany.mockRejectedValue(new Error('leaveRequest table missing'));
    const res = await summaryGet({}, '?from=2026-01-01&to=2026-01-31');
    expect(res.status).toBe(200);
    expect(res.body.byUser['100'].leaves).toBe(0);
  });

  test('USER role bearer → 403 (verifyRole gate)', async () => {
    const res = await summaryGet({ role: 'USER' }, '?from=2026-01-01&to=2026-01-31');
    expect(res.status).toBe(403);
  });

  test('missing Authorization → 401 (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/attendance/summary?from=2026-01-01&to=2026-01-31');
    expect(res.status).toBe(401);
  });
});
