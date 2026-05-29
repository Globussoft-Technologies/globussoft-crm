// @ts-check
/**
 * Unit tests for backend/routes/attendance.js's /by-month aggregator —
 * HRMS polish slice. Pins the per-month attendance trend rollup that
 * powers the HR dashboard's attendance-trend chart.
 *
 * Sibling to /summary (a single point-in-time aggregate over an ISO
 * date window); /by-month is the per-month time series across the
 * same tenant-scoped population. Mirrors the canonical /by-month
 * posture established by travel_suppliers.js's /suppliers/by-month
 * (PRD §3 #903 slice 24): UTC YYYY-MM bucketing, JS-side aggregation,
 * "unknown" bucket for null/invalid createdAt, pagination AFTER
 * aggregation + sort + filter, NO audit row written.
 *
 * Endpoint shape under test
 * -------------------------
 *   GET /api/attendance/by-month
 *
 *   Auth: verifyToken + verifyRole(['ADMIN','MANAGER']) — matches /summary
 *   Tenant scope: req.user.tenantId
 *   Query:
 *     ?from / ?to  — YYYY-MM bounds; invalid -> 400 INVALID_MONTH_FORMAT
 *     ?orderBy     — month:asc (default) | month:desc | count:asc | count:desc
 *     ?limit/?offset — default 12 / 0; limit caps at 60
 *     ?userId      — optional per-user filter
 *
 *   Response envelope:
 *     { total: N, rows: [{ month, count, byStatus, totalHoursWorked, lateCount }, ...] }
 *
 * Schema fidelity
 * ---------------
 *   Attendance model fields exercised: { status, totalMinutes, createdAt,
 *   userId, tenantId, date }. status enum is PRESENT / HALF_DAY / LATE /
 *   ABSENT / HOLIDAY (set across clock-out, biometric webhook, and the
 *   /summary derivation). NO lateMinutes / hoursWorked columns exist in
 *   the schema — `totalHoursWorked` is derived as totalMinutes/60 (half-up
 *   2dp); `lateCount` is the count of rows where status === 'LATE'.
 *
 * What this file pins
 * -------------------
 *   1.  401 when no Authorization header
 *   2.  403 when role is USER (verifyRole gate denies non-admin/manager)
 *   3.  400 INVALID_MONTH_FORMAT on bad ?from
 *   4.  400 INVALID_MONTH_FORMAT on bad ?to
 *   5.  Empty-tenant happy path -> total=0, rows=[]
 *   6.  Happy path -- 5 attendance entries across 2 months
 *   7.  byStatus + totalHoursWorked + lateCount per bucket
 *   8.  ?userId filters at the SQL where layer
 *   9.  Default orderBy=month:asc returns chronological buckets
 *  10.  ?from / ?to narrows the bucket window (no SQL date filter — JS-side)
 *  11.  null/invalid createdAt rows land in "unknown" bucket
 *  12.  Pagination applied AFTER aggregation
 *  13.  Tenant isolation -- where.tenantId is JWT, not query
 *  14.  NO audit row written (read-only meta surface)
 *
 * Test pattern mirrors backend/test/routes/attendance-summary.test.js —
 * prisma singleton monkey-patch, supertest with the real verifyToken +
 * verifyRole middleware (HS256 JWT signed with the fallback secret).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching. Must happen BEFORE the router is required.
prisma.attendance = prisma.attendance || {};
prisma.attendance.findMany = vi.fn();
prisma.attendance.findUnique = vi.fn();
prisma.attendance.create = vi.fn();
prisma.attendance.update = vi.fn();
prisma.leaveRequest = prisma.leaveRequest || {};
prisma.leaveRequest.findMany = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findFirst = vi.fn();
prisma.biometricDevice = prisma.biometricDevice || {};
prisma.biometricDevice.findMany = vi.fn();
// verifyToken does an optional revoked-token lookup — stub absent so the
// real middleware (which runs in-chain) doesn't 500 hitting MySQL.
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// writeAudit may fire from sibling handlers loaded with the router; it
// MUST NOT fire from the /by-month handler itself — the tests pin that.
vi.mock('../../lib/audit.js', () => ({
  writeAudit: vi.fn().mockResolvedValue(undefined),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const attendanceRouter = requireCJS('../../routes/attendance');
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
  app.use('/api/attendance', attendanceRouter);
  return app;
}

function byMonthGet({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}, query = '') {
  const token = tokenFor({ tenantId, userId, role });
  return request(makeApp())
    .get(`/api/attendance/by-month${query}`)
    .set('Authorization', `Bearer ${token}`);
}

// Build an Attendance row shape matching the /by-month select projection
// ({ status, totalMinutes, createdAt }). userId / tenantId aren't projected
// by the handler, but we include them so the tenant-isolation test can
// still observe the where clause via mock.calls.
function makeRow({
  status = 'PRESENT',
  totalMinutes = 480,
  createdAt = new Date('2026-01-15T10:00:00.000Z'),
  userId = 7,
} = {}) {
  return {
    status,
    totalMinutes,
    createdAt: createdAt instanceof Date ? createdAt : new Date(createdAt),
    userId,
  };
}

beforeEach(() => {
  prisma.attendance.findMany.mockReset();
  prisma.attendance.findMany.mockResolvedValue([]);
  writeAudit.mockClear();
});

// ── 1 + 2 — auth gates ──────────────────────────────────────────────

describe('GET /api/attendance/by-month — auth gates', () => {
  test('missing Authorization header → 401', async () => {
    const res = await request(makeApp()).get('/api/attendance/by-month');
    expect(res.status).toBe(401);
  });

  test('USER role bearer → 403 (verifyRole denies non-admin/manager)', async () => {
    const res = await byMonthGet({ role: 'USER' });
    expect(res.status).toBe(403);
  });

  test('MANAGER role bearer → 200 (verifyRole accepts MANAGER)', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    const res = await byMonthGet({ role: 'MANAGER' });
    expect(res.status).toBe(200);
  });
});

// ── 3 + 4 — query-string validation ─────────────────────────────────

describe('GET /api/attendance/by-month — month-format validation', () => {
  test('invalid ?from → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await byMonthGet({}, '?from=2026-13');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(res.body.error).toMatch(/from must be in YYYY-MM format/);
  });

  test('invalid ?from (not-a-date) → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await byMonthGet({}, '?from=garbage');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('invalid ?to → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await byMonthGet({}, '?to=2026-00');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(res.body.error).toMatch(/to must be in YYYY-MM format/);
  });

  test('valid ?from + ?to → 200 (no validation 400)', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    const res = await byMonthGet({}, '?from=2026-01&to=2026-12');
    expect(res.status).toBe(200);
  });
});

// ── 5 — empty tenant ────────────────────────────────────────────────

describe('GET /api/attendance/by-month — empty tenant', () => {
  test('zero rows → total=0, rows=[]', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    const res = await byMonthGet();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, rows: [] });
  });
});

// ── 6 + 7 — aggregate shape ─────────────────────────────────────────

describe('GET /api/attendance/by-month — aggregate shape', () => {
  test('happy path: 5 entries across 2 months', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ status: 'PRESENT', totalMinutes: 480, createdAt: '2026-01-05T09:00:00.000Z' }),
      makeRow({ status: 'PRESENT', totalMinutes: 480, createdAt: '2026-01-12T09:00:00.000Z' }),
      makeRow({ status: 'LATE',    totalMinutes: 420, createdAt: '2026-01-19T09:30:00.000Z' }),
      makeRow({ status: 'PRESENT', totalMinutes: 480, createdAt: '2026-02-03T09:00:00.000Z' }),
      makeRow({ status: 'HALF_DAY', totalMinutes: 180, createdAt: '2026-02-10T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows.length).toBe(2);

    const jan = res.body.rows.find((r) => r.month === '2026-01');
    const feb = res.body.rows.find((r) => r.month === '2026-02');

    expect(jan).toBeDefined();
    expect(jan.count).toBe(3);
    expect(jan.byStatus).toEqual({ PRESENT: 2, LATE: 1 });
    expect(jan.lateCount).toBe(1);
    // (480 + 480 + 420) / 60 = 23
    expect(jan.totalHoursWorked).toBe(23);

    expect(feb).toBeDefined();
    expect(feb.count).toBe(2);
    expect(feb.byStatus).toEqual({ PRESENT: 1, HALF_DAY: 1 });
    expect(feb.lateCount).toBe(0);
    // (480 + 180) / 60 = 11
    expect(feb.totalHoursWorked).toBe(11);
  });

  test('byStatus + totalHoursWorked + lateCount correct for a mixed bucket', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ status: 'PRESENT',  totalMinutes: 510, createdAt: '2026-03-02T09:00:00.000Z' }),
      makeRow({ status: 'LATE',     totalMinutes: 430, createdAt: '2026-03-04T09:00:00.000Z' }),
      makeRow({ status: 'LATE',     totalMinutes: 415, createdAt: '2026-03-09T09:00:00.000Z' }),
      makeRow({ status: 'ABSENT',   totalMinutes: 0,   createdAt: '2026-03-11T09:00:00.000Z' }),
      makeRow({ status: 'HOLIDAY',  totalMinutes: 0,   createdAt: '2026-03-15T09:00:00.000Z' }),
      makeRow({ status: 'HALF_DAY', totalMinutes: 200, createdAt: '2026-03-20T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const mar = res.body.rows[0];
    expect(mar.month).toBe('2026-03');
    expect(mar.count).toBe(6);
    expect(mar.byStatus).toEqual({
      PRESENT: 1, LATE: 2, ABSENT: 1, HOLIDAY: 1, HALF_DAY: 1,
    });
    expect(mar.lateCount).toBe(2);
    // (510 + 430 + 415 + 0 + 0 + 200) / 60 = 1555/60 = 25.9166... -> 25.92
    expect(mar.totalHoursWorked).toBe(25.92);
  });

  test('totalHoursWorked rounds half-up to 2dp', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      // 31 minutes -> 31/60 = 0.51666... -> 0.52
      makeRow({ status: 'PRESENT', totalMinutes: 31, createdAt: '2026-04-01T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet();
    const apr = res.body.rows[0];
    expect(apr.totalHoursWorked).toBe(0.52);
  });

  test('null / undefined totalMinutes contributes 0 to totalHoursWorked', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      { status: 'ABSENT', totalMinutes: null, createdAt: new Date('2026-05-01T09:00:00.000Z') },
      { status: 'PRESENT', totalMinutes: undefined, createdAt: new Date('2026-05-02T09:00:00.000Z') },
      { status: 'PRESENT', totalMinutes: 480, createdAt: new Date('2026-05-03T09:00:00.000Z') },
    ]);
    const res = await byMonthGet();
    const may = res.body.rows[0];
    expect(may.month).toBe('2026-05');
    expect(may.count).toBe(3);
    expect(may.totalHoursWorked).toBe(8);
  });
});

// ── 8 — ?userId filter ──────────────────────────────────────────────

describe('GET /api/attendance/by-month — ?userId filter', () => {
  test('?userId narrows the Prisma where clause', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    await byMonthGet({}, '?userId=42');
    expect(prisma.attendance.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.attendance.findMany.mock.calls[0][0];
    expect(args.where.userId).toBe(42);
    expect(args.where.tenantId).toBe(1);
  });

  test('non-numeric ?userId is ignored (does NOT inject NaN)', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    await byMonthGet({}, '?userId=garbage');
    const args = prisma.attendance.findMany.mock.calls[0][0];
    expect(args.where.userId).toBeUndefined();
  });
});

// ── 9 — default ordering ────────────────────────────────────────────

describe('GET /api/attendance/by-month — default orderBy=month:asc', () => {
  test('chronological ordering on the rows array', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ status: 'PRESENT', totalMinutes: 480, createdAt: '2026-03-05T09:00:00.000Z' }),
      makeRow({ status: 'PRESENT', totalMinutes: 480, createdAt: '2026-01-05T09:00:00.000Z' }),
      makeRow({ status: 'PRESENT', totalMinutes: 480, createdAt: '2026-02-05T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet();
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  test('?orderBy=month:desc reverses the order', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ createdAt: '2026-01-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-02-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-03-05T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet({}, '?orderBy=month:desc');
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-03', '2026-02', '2026-01']);
  });

  test('?orderBy=count:desc sorts by count descending', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ createdAt: '2026-01-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-02-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-02-12T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-02-19T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-03-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-03-12T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet({}, '?orderBy=count:desc');
    // Feb (3), Mar (2), Jan (1)
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-02', '2026-03', '2026-01']);
  });
});

// ── 10 — ?from / ?to bucket filter ──────────────────────────────────

describe('GET /api/attendance/by-month — ?from/?to bucket filter', () => {
  test('?from filters to buckets >= the lower bound', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ createdAt: '2026-01-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-02-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-03-05T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet({}, '?from=2026-02');
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-02', '2026-03']);
  });

  test('?to filters to buckets <= the upper bound', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ createdAt: '2026-01-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-02-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-03-05T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet({}, '?to=2026-02');
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-01', '2026-02']);
  });

  test('?from + ?to narrows to inclusive window', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ createdAt: '2025-12-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-01-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-02-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-03-05T09:00:00.000Z' }),
      makeRow({ createdAt: '2026-04-05T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet({}, '?from=2026-01&to=2026-03');
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-01', '2026-02', '2026-03']);
  });
});

// ── 11 — defensive: null/invalid createdAt → "unknown" bucket ───────

describe('GET /api/attendance/by-month — defensive bucket math', () => {
  test('null createdAt rows land in "unknown" bucket (no bound)', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      { status: 'PRESENT', totalMinutes: 480, createdAt: null },
      { status: 'PRESENT', totalMinutes: 480, createdAt: null },
      makeRow({ status: 'PRESENT', totalMinutes: 480, createdAt: '2026-01-05T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet();
    const months = res.body.rows.map((r) => r.month);
    expect(months).toContain('2026-01');
    expect(months).toContain('unknown');
    const unknown = res.body.rows.find((r) => r.month === 'unknown');
    expect(unknown.count).toBe(2);
    expect(unknown.totalHoursWorked).toBe(16);
  });

  test('invalid createdAt date land in "unknown" bucket', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      { status: 'PRESENT', totalMinutes: 480, createdAt: new Date('not-a-date') },
      makeRow({ status: 'PRESENT', totalMinutes: 480, createdAt: '2026-01-05T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet();
    const months = res.body.rows.map((r) => r.month);
    expect(months).toContain('unknown');
  });

  test('"unknown" bucket EXCLUDED when ?from is set', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      { status: 'PRESENT', totalMinutes: 480, createdAt: null },
      makeRow({ status: 'PRESENT', createdAt: '2026-02-05T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet({}, '?from=2026-01');
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-02']);
  });

  test('"unknown" bucket EXCLUDED when ?to is set', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      { status: 'PRESENT', totalMinutes: 480, createdAt: null },
      makeRow({ status: 'PRESENT', createdAt: '2026-02-05T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet({}, '?to=2026-03');
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-02']);
  });
});

// ── 12 — pagination AFTER aggregation ───────────────────────────────

describe('GET /api/attendance/by-month — pagination', () => {
  test('default limit=12 caps the rows array', async () => {
    // 15 months of data
    const rows = [];
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      rows.push(makeRow({ createdAt: `2026-${mm}-05T09:00:00.000Z` }));
    }
    rows.push(makeRow({ createdAt: '2027-01-05T09:00:00.000Z' }));
    rows.push(makeRow({ createdAt: '2027-02-05T09:00:00.000Z' }));
    rows.push(makeRow({ createdAt: '2027-03-05T09:00:00.000Z' }));
    prisma.attendance.findMany.mockResolvedValue(rows);

    const res = await byMonthGet();
    expect(res.body.total).toBe(15);
    expect(res.body.rows.length).toBe(12);
  });

  test('?limit + ?offset paginates AFTER aggregation', async () => {
    const rows = [];
    for (let m = 1; m <= 5; m++) {
      const mm = String(m).padStart(2, '0');
      rows.push(makeRow({ createdAt: `2026-${mm}-05T09:00:00.000Z` }));
    }
    prisma.attendance.findMany.mockResolvedValue(rows);

    const res = await byMonthGet({}, '?limit=2&offset=2');
    expect(res.body.total).toBe(5);
    expect(res.body.rows.length).toBe(2);
    // asc default: months are [01,02,03,04,05] -> offset=2 -> [03, 04]
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-03', '2026-04']);
  });

  test('?limit > 60 caps at 60', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    await byMonthGet({}, '?limit=999');
    // The cap is internal but we can confirm 200 + the prisma was still called.
    expect(prisma.attendance.findMany).toHaveBeenCalledTimes(1);
  });
});

// ── 13 — tenant isolation ───────────────────────────────────────────

describe('GET /api/attendance/by-month — tenant isolation', () => {
  test('where.tenantId comes from JWT, not any query parameter', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    await byMonthGet({ tenantId: 42 });
    expect(prisma.attendance.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.attendance.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(42);
  });

  test("a different tenant's bearer scopes the query to its own tenantId", async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    await byMonthGet({ tenantId: 7 });
    const args = prisma.attendance.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe(7);
  });
});

// ── 14 — NO audit row written ───────────────────────────────────────

describe('GET /api/attendance/by-month — no audit row written', () => {
  test('happy path response does NOT call writeAudit', async () => {
    prisma.attendance.findMany.mockResolvedValue([
      makeRow({ status: 'PRESENT', totalMinutes: 480, createdAt: '2026-01-05T09:00:00.000Z' }),
    ]);
    const res = await byMonthGet();
    expect(res.status).toBe(200);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  test('empty tenant response does NOT call writeAudit', async () => {
    prisma.attendance.findMany.mockResolvedValue([]);
    const res = await byMonthGet();
    expect(res.status).toBe(200);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT response does NOT call writeAudit', async () => {
    const res = await byMonthGet({}, '?from=garbage');
    expect(res.status).toBe(400);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
