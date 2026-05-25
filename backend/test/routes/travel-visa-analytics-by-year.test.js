// @ts-check
/**
 * Travel CRM — Visa Sure analytics by-year rollup (V21) contract tests.
 *
 * Pins backend/routes/travel_visa_analytics.js:
 *   GET /api/travel/visa/analytics/by-year
 *
 * 6th analytics endpoint (V21) completing the V16-V21 set.
 * Mirrors V19 (/by-month) + V20 (/by-quarter) at calendar-year resolution.
 * Tenant-wide VisaApplication time-series bucketed by UTC YYYY (4-digit
 * calendar year), joined via Contact.subBrand='visasure'.
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing Bearer → 401; USER role → 403.
 *   - Vertical gate: inherited from requireTravelTenant (sibling spec
 *     pins this; not duplicated here).
 *   - Query validation:
 *       INVALID_STATUS for unknown status value.
 *       INVALID_YEAR_FORMAT for non-YYYY from/to values.
 *   - Empty-state contract: zero visasure contacts → graceful empty
 *     envelope (NOT 404) with grand-totals at 0 + years: [].
 *   - Happy path: applications spanning 3 UTC years → 3 year buckets
 *     with correct per-status splits + complexCount + flaggedCount.
 *   - Sort: orderBy=count:desc inverts the chronological default.
 *   - Status filter: status=approved narrows the where clause.
 *   - from/to window: single-year window excludes "unknown" +
 *     out-of-range buckets.
 *   - Cross-tenant isolation: every Contact + VisaApplication query
 *     narrows to (tenantId, subBrand='visasure'); the resolved contactId
 *     set is the join key.
 *   - Bucket key uses UTC year (not local time). UTC-year boundary edge:
 *     2025-12-31T23:59:59Z → "2025"; 2026-01-01T00:00:00Z → "2026".
 *
 * Test pattern mirrors backend/test/routes/travel-visa-analytics-by-quarter.test.js —
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, drive supertest with HS256 JWTs signed with the dev-fallback
 * secret, exercise verifyToken + verifyRole + requireTravelTenant fully.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.contact = {
  ...(prisma.contact || {}),
  findMany: vi.fn(),
  groupBy: vi.fn(),
};
prisma.visaApplication = {
  ...(prisma.visaApplication || {}),
  count: vi.fn(),
  groupBy: vi.fn(),
  findMany: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const router = requireCJS('../../routes/travel_visa_analytics');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/visa/analytics', router);
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
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.contact.groupBy.mockReset().mockResolvedValue([]);
  prisma.visaApplication.count.mockReset().mockResolvedValue(0);
  prisma.visaApplication.groupBy.mockReset().mockResolvedValue([]);
  prisma.visaApplication.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ─── Auth gate ────────────────────────────────────────────────────────

describe('GET /by-year — auth gate', () => {
  test('missing Bearer → 401 (no DB calls)', async () => {
    const res = await request(makeApp()).get('/api/travel/visa/analytics/by-year');
    expect(res.status).toBe(401);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
  });

  test('USER role is rejected by verifyRole (403, no DB calls)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });
});

// ─── Query validation ─────────────────────────────────────────────────

describe('GET /by-year — query validation', () => {
  test('unknown status value → 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year?status=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(res.body.error).toMatch(/intake/);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-YYYY from value → 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year?from=2026-05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-YYYY to value → 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year?to=Y2026')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
  });

  test('3-digit year rejected (strict 4-digit YYYY)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year?from=999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_YEAR_FORMAT' });
  });

  test('5-digit year rejected (strict 4-digit YYYY)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year?to=10000')
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
      .get('/api/travel/visa/analytics/by-year?status=approved')
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

// ─── Empty-state contract ─────────────────────────────────────────────

describe('GET /by-year — empty state', () => {
  test('zero visasure contacts → graceful empty envelope (NOT 404)', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year')
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
      .get('/api/travel/visa/analytics/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.years).toEqual([]);
    expect(res.body.totalYears).toBe(0);
    expect(res.body.grandCount).toBe(0);
  });
});

// ─── Happy path: 6 applications across 3 UTC years ────────────────────

describe('GET /by-year — happy path', () => {
  test('6 applications across 3 UTC years produces 3 buckets with per-status splits + complex/flagged tallies', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 21 }, { id: 22 }, { id: 23 }, { id: 24 }, { id: 25 }, { id: 26 },
    ]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // 2024: 1 app (intake) — 1 complex
      {
        id: 1, status: 'intake', complexCase: true, advisorRiskFlag: null,
        createdAt: new Date('2024-06-15T03:00:00Z'),
      },
      // 2025: 2 apps (1 filed, 1 approved) — 1 flagged
      {
        id: 2, status: 'filed', complexCase: false, advisorRiskFlag: 'medium',
        createdAt: new Date('2025-03-22T18:00:00Z'),
      },
      {
        id: 3, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2025-11-30T23:00:00Z'),
      },
      // 2026: 3 apps (1 approved, 1 rejected, 1 appeal) — 1 complex + 1 flagged
      {
        id: 4, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 5, status: 'rejected', complexCase: true, advisorRiskFlag: 'high',
        createdAt: new Date('2026-05-28T14:00:00Z'),
      },
      {
        id: 6, status: 'appeal', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-12-15T08:00:00Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(3);
    // Default orderBy=year:asc → 2024, 2025, 2026.
    expect(res.body.years[0]).toMatchObject({
      year: '2024',
      count: 1,
      intakeCount: 1,
      docsPendingCount: 0,
      filedCount: 0,
      approvedCount: 0,
      rejectedCount: 0,
      appealCount: 0,
      complexCount: 1,
      flaggedCount: 0,
    });
    expect(res.body.years[1]).toMatchObject({
      year: '2025',
      count: 2,
      filedCount: 1,
      approvedCount: 1,
      complexCount: 0,
      flaggedCount: 1, // medium counts as flagged
    });
    expect(res.body.years[2]).toMatchObject({
      year: '2026',
      count: 3,
      approvedCount: 1,
      rejectedCount: 1,
      appealCount: 1,
      complexCount: 1,
      flaggedCount: 1, // high counts as flagged
    });
    // Grand totals.
    expect(res.body.totalYears).toBe(3);
    expect(res.body.grandCount).toBe(6);
    expect(res.body.grandApprovedCount).toBe(2);
    expect(res.body.grandRejectedCount).toBe(1);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });
});

// ─── Sort ─────────────────────────────────────────────────────────────

describe('GET /by-year — orderBy', () => {
  test('orderBy=count:desc inverts the chronological default', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 31 }, { id: 32 }, { id: 33 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // 2024: 1 app
      { id: 1, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2024-02-10T00:00:00Z') },
      // 2025: 3 apps (highest count) — sorts first under desc
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2025-04-01T00:00:00Z') },
      { id: 3, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2025-05-15T00:00:00Z') },
      { id: 4, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2025-09-29T00:00:00Z') },
      // 2026: 2 apps
      { id: 5, status: 'rejected', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-07-05T00:00:00Z') },
      { id: 6, status: 'appeal', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-09-12T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // count:desc → 2025 (3), 2026 (2), 2024 (1).
    expect(res.body.years.map((y) => y.year)).toEqual([
      '2025', '2026', '2024',
    ]);
    expect(res.body.years.map((y) => y.count)).toEqual([3, 2, 1]);
  });
});

// ─── from/to window filter ────────────────────────────────────────────

describe('GET /by-year — from/to window', () => {
  test('single-year window includes only the matching bucket', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 41 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2024-02-10T00:00:00Z') }, // 2024 — out
      { id: 2, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-04-10T00:00:00Z') }, // 2026 — in
      { id: 3, status: 'rejected', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-06-25T00:00:00Z') }, // 2026 — in
      { id: 4, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2027-10-01T00:00:00Z') }, // 2027 — out
      // "unknown" bucket row — also excluded when from/to is set
      { id: 5, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year?from=2026&to=2026')
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

describe('GET /by-year — complex + flagged counts', () => {
  test('complexCount counts only complexCase=true; flaggedCount counts any truthy advisorRiskFlag', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 51 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // All in 2026.
      // Complex + flagged
      { id: 1, status: 'intake', complexCase: true, advisorRiskFlag: 'high',
        createdAt: new Date('2026-04-01T00:00:00Z') },
      // Complex, NOT flagged (null)
      { id: 2, status: 'intake', complexCase: true, advisorRiskFlag: null,
        createdAt: new Date('2026-05-02T00:00:00Z') },
      // NOT complex (false), flagged (low)
      { id: 3, status: 'intake', complexCase: false, advisorRiskFlag: 'low',
        createdAt: new Date('2026-05-03T00:00:00Z') },
      // Neither (complexCase=false, advisorRiskFlag empty string is falsy)
      { id: 4, status: 'intake', complexCase: false, advisorRiskFlag: '',
        createdAt: new Date('2026-06-04T00:00:00Z') },
      // complexCase explicitly false + flagged 'priority'
      { id: 5, status: 'intake', complexCase: false, advisorRiskFlag: 'priority',
        createdAt: new Date('2026-06-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0]).toMatchObject({
      year: '2026',
      count: 5,
      intakeCount: 5,
      // complexCase=true: rows 1, 2 → 2
      complexCount: 2,
      // advisorRiskFlag truthy: rows 1 (high), 3 (low), 5 (priority) → 3
      flaggedCount: 3,
    });
  });
});

// ─── UTC year boundary edge ───────────────────────────────────────────

describe('GET /by-year — UTC year boundary edges', () => {
  test('2025-12-31T23:59:59Z → "2025"; 2026-01-01T00:00:00Z → "2026"', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 81 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // 2025 edge: 2025-12-31 UTC last second → "2025"
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2025-12-31T23:59:59Z') },
      // 2026 edge: 2026-01-01 UTC first second → "2026"
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-01-01T00:00:00Z') },
      // 2026 mid-year
      { id: 3, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-07-15T12:00:00Z') },
      // 2026 last second
      { id: 4, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-12-31T23:59:59Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.years.map((y) => [y.year, y.count]));
    expect(byKey['2025']).toBe(1);
    expect(byKey['2026']).toBe(3);
  });

  test('null createdAt rows bucket into "unknown" (kept when no from/to filter)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 91 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: null },
      { id: 2, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-10T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    const buckets = res.body.years.map((y) => y.year);
    expect(buckets).toContain('unknown');
    expect(buckets).toContain('2026');
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(2);
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────

describe('GET /by-year — tenant isolation (cross-tenant safe)', () => {
  test('Contact lookup narrowed to (tenantId, subBrand=visasure); VisaApplication scoped to contactId set + tenantId', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }, { id: 62 }]);
    prisma.visaApplication.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/visa/analytics/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER', { tenantId: 1 })}`);

    expect(prisma.contact.findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 1, subBrand: 'visasure' },
      select: { id: true },
    });
    expect(prisma.visaApplication.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      contactId: { in: [61, 62] },
    });
  });

  test('zero cross-tenant leak: when Contact set is empty for this tenant, VisaApplication is NEVER queried', async () => {
    prisma.contact.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 999 })}`);
    expect(res.status).toBe(200);
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
    expect(res.body.grandCount).toBe(0);
    expect(res.body.years).toEqual([]);
  });
});

// ─── limit cap ────────────────────────────────────────────────────────

describe('GET /by-year — limit cap', () => {
  test('limit=999 caps to 30 (max enforced)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 101 }]);
    prisma.visaApplication.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year?limit=999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(30);
  });

  test('default limit is 10 (one decade) when ?limit omitted', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 102 }]);
    prisma.visaApplication.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(10);
  });
});

// ─── Error path ───────────────────────────────────────────────────────

describe('GET /by-year — error path', () => {
  test('prisma.visaApplication.findMany throws → 500 INTERNAL_ERROR (no DB error leak)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 71 }]);
    prisma.visaApplication.findMany.mockRejectedValue(new Error('mysql connection refused'));
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(res.body.error).toMatch(/by-year/i);
    expect(JSON.stringify(res.body)).not.toMatch(/mysql connection refused/);
  });
});
