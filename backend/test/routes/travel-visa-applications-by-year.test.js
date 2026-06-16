// @ts-check
/**
 * Travel CRM — Visa Sure GET /api/travel/visa/applications/by-year
 * contract tests (Phase 3 cluster B3 operational slice — completes the
 * rollup triplet: by-month + by-quarter + by-year).
 *
 * Pins backend/routes/travel_visa.js:
 *   GET /api/travel/visa/applications/by-year
 *
 * Operational complement to /applications/by-month (fc7b8165) +
 * /applications/by-quarter (<prior commit>) + /applications/stats
 * (20d91295) + /applications/:id/status-history (f1741b6c). Same shape
 * family as by-quarter, with the bucket key swapped from YYYY-Qn to
 * YYYY. Board-level reporting + multi-year trend visualisations need
 * annual resolution.
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing Bearer → 401; USER role ACCEPTED (anodyne
 *     aggregate posture, mirrors by-month + by-quarter).
 *   - Path-precedence: /applications/by-year resolves BEFORE
 *     /applications/:id (literal-path definition order is the contract).
 *   - Query validation:
 *       INVALID_STATUS for unknown status value.
 *       INVALID_YEAR_FORMAT for non-YYYY from/to values (YYYY-MM, YY,
 *       non-digit, etc.).
 *   - Empty-state contract: zero visasure contacts → graceful empty
 *     envelope (NOT 404) with grand-totals at 0 + years: [].
 *   - Happy path: 3 applications across 2 UTC years → 2 year buckets
 *     with correct per-status splits.
 *   - Year-boundary correctness: Dec 31 23:59 UTC = current year;
 *     Jan 1 00:00 UTC = next year.
 *   - Sort: default year:asc; orderBy=count:desc flips ordering;
 *     unknown orderBy token degrades silently to year:asc.
 *   - Status filter: status=approved narrows the where clause.
 *   - from/to window: bounds-narrowing excludes out-of-range buckets
 *     AND the "unknown" defensive fallback bucket.
 *   - complexCount counts only complexCase=true; flaggedCount counts
 *     any truthy advisorRiskFlag.
 *   - Defensive: null createdAt → "unknown" bucket; excluded when
 *     ?from/?to set.
 *   - Pagination ?limit=2&offset=1 slices AFTER aggregation + sort.
 *   - Tenant isolation: every query narrows to (tenantId, subBrand=visasure).
 *   - No audit row written (anodyne aggregate).
 *   - limit default 10, clamped to max 30.
 *   - findMany throws → 500 INTERNAL_ERROR (no DB error leak).
 *
 * Test pattern mirrors backend/test/routes/travel-visa-applications-by-quarter.test.js
 * verbatim — patch the prisma singleton with vi.fn() shapes BEFORE
 * requiring the router, drive supertest with HS256 JWTs signed with the
 * dev-fallback secret, exercise verifyToken + requirePermission +
 * requireTravelTenant fully.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

import { createRequire } from 'node:module';
const requireCJS_init = createRequire(import.meta.url);

// findLatestDiagnostic / eventBus aren't reachable from this endpoint but
// the route module loads them at the top — pre-stub so they don't try to
// hit a real DB at module-load time.
const eventBusModule = requireCJS_init('../../lib/eventBus');
eventBusModule.safeEmitEvent = vi.fn();
const diagnosticModule = requireCJS_init('../../lib/travelLatestDiagnostic');
diagnosticModule.findLatestDiagnostic = vi.fn().mockResolvedValue(null);

// ─── Patch prisma singleton BEFORE requiring the router ──────────────
prisma.contact = {
  ...(prisma.contact || {}),
  findFirst: vi.fn(),
  findMany: vi.fn(),
};
prisma.visaApplication = {
  ...(prisma.visaApplication || {}),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'USER', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
  findMany: vi.fn(),
  count: vi.fn(),
};

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const router = requireCJS_init('../../routes/travel_visa');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/visa', router);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.visaApplication.findFirst.mockReset().mockResolvedValue(null);
  prisma.visaApplication.findMany.mockReset().mockResolvedValue([]);
  prisma.visaApplication.count.mockReset().mockResolvedValue(0);
  prisma.visaApplication.create.mockReset();
  prisma.visaApplication.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

// ─── Auth + role gate ────────────────────────────────────────────────

describe('GET /applications/by-year — auth gate', () => {
  test('missing Bearer → 401 (no DB calls)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year');
    expect(res.status).toBe(401);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
  });

  test('USER role ACCEPTED (anodyne aggregate, same posture as by-quarter)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      years: [],
      totalYears: 0,
      grandCount: 0,
    });
  });
});

// ─── Query validation ─────────────────────────────────────────────────

describe('GET /applications/by-year — query validation', () => {
  test('unknown status value → 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year?status=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(res.body.error).toMatch(/intake/);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-YYYY from value (YYYY-MM shape "2026-Q1") → 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year?from=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-YYYY to value ("abcd" non-digit) → 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year?to=abcd')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
  });

  test('two-digit year "26" → 400 INVALID_YEAR_FORMAT (strict 4-digit)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year?from=26')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
  });

  test('valid status (approved) passes validation + narrows the where clause', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      {
        id: 1, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-15T10:00:00Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year?status=approved')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.visaApplication.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      contactId: { in: [11] },
      status: 'approved',
    });
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0]).toMatchObject({
      year: '2026',
      count: 1,
      approvedCount: 1,
    });
  });
});

// ─── Path-precedence smoke ───────────────────────────────────────────

describe('GET /applications/by-year — path-precedence', () => {
  test('literal /applications/by-year is NOT routed to /applications/:id', async () => {
    // If routes were declared in the wrong order, /applications/by-year
    // would hit /:id and 400 INVALID_ID because parseInt("by-year") is
    // NaN. A 200 empty envelope proves precedence is correct.
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    expect(res.body).toMatchObject({ years: [], totalYears: 0 });
  });
});

// ─── Empty-state contract ─────────────────────────────────────────────

describe('GET /applications/by-year — empty state', () => {
  test('zero visasure contacts → graceful empty envelope (NOT 404)', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      years: [],
      totalYears: 0,
      grandCount: 0,
      grandApprovedCount: 0,
      grandRejectedCount: 0,
      limit: 10,
      offset: 0,
    });
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
  });

  test('contacts present but zero applications → same empty envelope', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }, { id: 12 }]);
    prisma.visaApplication.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.years).toEqual([]);
    expect(res.body.totalYears).toBe(0);
    expect(res.body.grandCount).toBe(0);
  });
});

// ─── Happy path: 3 applications across 2 UTC years ────────────────────

describe('GET /applications/by-year — happy path', () => {
  test('3 applications across 2 UTC years produces 2 buckets with correct counts + per-status splits', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 21 }, { id: 22 }, { id: 23 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // 2025: 1 app — approved
      {
        id: 1, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2025-10-15T03:00:00Z'),
      },
      // 2026: 2 apps — 1 filed (complex), 1 rejected (flagged high)
      {
        id: 2, status: 'filed', complexCase: true, advisorRiskFlag: null,
        createdAt: new Date('2026-03-22T18:00:00Z'),
      },
      {
        id: 3, status: 'rejected', complexCase: false, advisorRiskFlag: 'high',
        createdAt: new Date('2026-11-10T09:00:00Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(2);
    // Default orderBy=year:asc → 2025 first, 2026 second.
    expect(res.body.years[0]).toMatchObject({
      year: '2025',
      count: 1,
      intakeCount: 0,
      docsPendingCount: 0,
      filedCount: 0,
      approvedCount: 1,
      rejectedCount: 0,
      appealCount: 0,
      complexCount: 0,
      flaggedCount: 0,
    });
    expect(res.body.years[1]).toMatchObject({
      year: '2026',
      count: 2,
      filedCount: 1,
      rejectedCount: 1,
      complexCount: 1,
      flaggedCount: 1,
    });
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(3);
    expect(res.body.grandApprovedCount).toBe(1);
    expect(res.body.grandRejectedCount).toBe(1);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });
});

// ─── Year-boundary correctness ────────────────────────────────────────

describe('GET /applications/by-year — UTC year boundary', () => {
  test('Dec-31 23:59 UTC = current year; Jan-1 00:00 UTC = next year', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 51 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // 2025 last second UTC
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2025-12-31T23:59:59Z') },
      // 2026 first instant UTC
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-01-01T00:00:00Z') },
      // 2026 last second UTC
      { id: 3, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-12-31T23:59:59Z') },
      // 2027 first instant UTC
      { id: 4, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2027-01-01T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(3);
    expect(res.body.years.map((y) => y.year)).toEqual(['2025', '2026', '2027']);
    expect(res.body.years.map((y) => y.count)).toEqual([1, 2, 1]);
  });
});

// ─── Sort ─────────────────────────────────────────────────────────────

describe('GET /applications/by-year — orderBy', () => {
  test('default orderBy=year:asc is chronological', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 41 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2027-05-01T00:00:00Z') },
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2025-01-01T00:00:00Z') },
      { id: 3, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-08-15T00:00:00Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Default year:asc → 2025, 2026, 2027.
    expect(res.body.years.map((y) => y.year)).toEqual(['2025', '2026', '2027']);
  });

  test('orderBy=count:desc inverts the chronological default', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 31 }, { id: 32 }, { id: 33 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // 2024: 1 app
      { id: 1, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2024-01-10T00:00:00Z') },
      // 2026: 3 apps (highest count) — sorts first under desc
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-04-01T00:00:00Z') },
      { id: 3, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-15T00:00:00Z') },
      { id: 4, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-06-29T00:00:00Z') },
      // 2025: 2 apps
      { id: 5, status: 'rejected', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2025-07-05T00:00:00Z') },
      { id: 6, status: 'appeal', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2025-08-12T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // count:desc → 2026 (3), 2025 (2), 2024 (1).
    expect(res.body.years.map((y) => y.year)).toEqual(['2026', '2025', '2024']);
    expect(res.body.years.map((y) => y.count)).toEqual([3, 2, 1]);
  });

  test('unknown orderBy token degrades silently to year:asc', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 41 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-01T00:00:00Z') },
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2025-01-01T00:00:00Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year?orderBy=garbage:foo')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Default year:asc → 2025 before 2026.
    expect(res.body.years.map((y) => y.year)).toEqual(['2025', '2026']);
  });
});

// ─── from/to window filter ────────────────────────────────────────────

describe('GET /applications/by-year — from/to window', () => {
  test('single-year window includes only the matching bucket and excludes "unknown"', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 41 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2024-01-10T00:00:00Z') }, // 2024 — out
      { id: 2, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-10T00:00:00Z') }, // 2026 — in
      { id: 3, status: 'rejected', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-09-25T00:00:00Z') }, // 2026 — in
      { id: 4, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2028-09-01T00:00:00Z') }, // 2028 — out
      // "unknown" bucket row — excluded when from/to set
      { id: 5, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year?from=2026&to=2026')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0]).toMatchObject({
      year: '2026',
      count: 2,
      approvedCount: 1,
      rejectedCount: 1,
    });
    expect(res.body.totalYears).toBe(1);
    expect(res.body.grandCount).toBe(2);
    expect(res.body.years.find((y) => y.year === 'unknown')).toBeUndefined();
  });
});

// ─── complexCount + flaggedCount accuracy ─────────────────────────────

describe('GET /applications/by-year — complex + flagged counts', () => {
  test('complexCount counts only complexCase=true; flaggedCount counts any truthy advisorRiskFlag', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 51 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // All in 2026.
      // Complex + flagged
      { id: 1, status: 'intake', complexCase: true, advisorRiskFlag: 'high',
        createdAt: new Date('2026-04-01T00:00:00Z') },
      // Complex, NOT flagged (null)
      { id: 2, status: 'intake', complexCase: true, advisorRiskFlag: null,
        createdAt: new Date('2026-04-02T00:00:00Z') },
      // NOT complex, flagged (low)
      { id: 3, status: 'intake', complexCase: false, advisorRiskFlag: 'low',
        createdAt: new Date('2026-05-03T00:00:00Z') },
      // Neither (complexCase=false, advisorRiskFlag empty string falsy)
      { id: 4, status: 'intake', complexCase: false, advisorRiskFlag: '',
        createdAt: new Date('2026-05-04T00:00:00Z') },
      // complexCase explicitly false + flagged 'priority'
      { id: 5, status: 'intake', complexCase: false, advisorRiskFlag: 'priority',
        createdAt: new Date('2026-06-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0]).toMatchObject({
      year: '2026',
      count: 5,
      intakeCount: 5,
      complexCount: 2,
      flaggedCount: 3,
    });
  });
});

// ─── Defensive: null createdAt → "unknown" bucket ─────────────────────

describe('GET /applications/by-year — defensive unknown bucket', () => {
  test('null createdAt produces "unknown" bucket when no from/to set', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-01T00:00:00Z') },
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: null },
      { id: 3, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const unknownBucket = res.body.years.find((y) => y.year === 'unknown');
    expect(unknownBucket).toMatchObject({ year: 'unknown', count: 2 });
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(3);
  });

  test('null createdAt EXCLUDED from result when ?from set', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-01T00:00:00Z') },
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year?from=2020')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.years.find((y) => y.year === 'unknown')).toBeUndefined();
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0]).toMatchObject({ year: '2026', count: 1 });
  });
});

// ─── Pagination AFTER aggregation ─────────────────────────────────────

describe('GET /applications/by-year — pagination', () => {
  test('?limit=2&offset=1 slices AFTER aggregation + sort', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 71 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2024-01-01T00:00:00Z') },
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2025-01-01T00:00:00Z') },
      { id: 3, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 4, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2027-01-01T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Sort year:asc → [2024, 2025, 2026, 2027]; offset 1, limit 2 → [2025, 2026].
    expect(res.body.years.map((y) => y.year)).toEqual(['2025', '2026']);
    // totalYears is PRE-pagination bucket count.
    expect(res.body.totalYears).toBe(4);
    // grandCount also pre-pagination — counts ALL buckets.
    expect(res.body.grandCount).toBe(4);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(1);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────

describe('GET /applications/by-year — tenant isolation (cross-tenant safe)', () => {
  test('every Contact + VisaApplication query narrows to (tenantId, subBrand=visasure)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 71 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-01T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);
    expect(res.status).toBe(200);
    expect(prisma.contact.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      subBrand: 'visasure',
    });
    expect(prisma.visaApplication.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      contactId: { in: [71] },
    });
  });
});

// ─── No audit row written ────────────────────────────────────────────

describe('GET /applications/by-year — anodyne (no audit row)', () => {
  test('successful read does NOT call auditLog.create (mirrors /stats + /by-month + /by-quarter)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 91 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-15T00:00:00Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

// ─── Limit clamping ──────────────────────────────────────────────────

describe('GET /applications/by-year — limit clamping', () => {
  test('limit=999 clamps to max 30', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year?limit=999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(30);
  });
});

// ─── Internal error ──────────────────────────────────────────────────

describe('GET /applications/by-year — internal errors', () => {
  test('visaApplication.findMany throws → 500 INTERNAL_ERROR (no DB error leak)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }]);
    prisma.visaApplication.findMany.mockRejectedValue(new Error('mysql gone away'));
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toMatch(/mysql gone away/);
  });
});
