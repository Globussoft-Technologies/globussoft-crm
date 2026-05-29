// @ts-check
/**
 * Travel CRM — Visa Sure GET /api/travel/visa/applications/by-month
 * contract tests (Phase 3 cluster B3 operational slice).
 *
 * Pins backend/routes/travel_visa.js:
 *   GET /api/travel/visa/applications/by-month
 *
 * Mirrors the V19 analytics endpoint contract pinned at
 * backend/test/routes/travel-visa-analytics-by-month.test.js but lives
 * on the operational route file alongside /applications/stats
 * (20d91295) and /applications/:id/status-history (f1741b6c). Visa-Sure
 * operators hit this file's endpoints from the Applications page; V19
 * powers the V16-V19 reports view in /analytics. Both endpoints serve
 * the same response shape on purpose so the frontend chart component
 * can swap source URLs without changing rendering.
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing Bearer → 401; USER role ACCEPTED (anodyne
 *     aggregate posture, matches /applications/stats which also opens
 *     to USER — this is the key role-posture difference from V19's
 *     ADMIN/MANAGER-only analytics surface).
 *   - Path-precedence: /applications/by-month resolves BEFORE
 *     /applications/:id (this is a smoke check — the literal-path
 *     definition order in the file is the contract).
 *   - Query validation:
 *       INVALID_STATUS for unknown status value.
 *       INVALID_MONTH_FORMAT for non-YYYY-MM from/to values.
 *   - Empty-state contract: zero visasure contacts → graceful empty
 *     envelope (NOT 404) with grand-totals at 0 + months: [].
 *   - Happy path: 4 applications across 2 UTC months → 2 month buckets
 *     with correct per-status splits + complexCount + flaggedCount.
 *   - Sort: orderBy=count:desc inverts the chronological default.
 *   - Status filter: status=approved narrows the where clause; the
 *     full application set passed back from the mock is aggregated
 *     correctly into per-month rows.
 *   - from/to window: single-month window excludes "unknown" + out-of-range
 *     buckets.
 *   - complexCount counts only complexCase=true; flaggedCount counts any
 *     truthy advisorRiskFlag (empty string falsy, all enum values truthy).
 *   - No audit row written (anodyne aggregate, mirrors /stats).
 *
 * Test pattern mirrors backend/test/routes/travel-visa-status-history.test.js
 * — patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, drive supertest with HS256 JWTs signed with the dev-fallback
 * secret, exercise verifyToken + verifyRole + requireTravelTenant fully.
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
  // Default to USER so the role-gate-accepts-USER assertion exercises a
  // real USER token, not a forged ADMIN. Specific tests override this.
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

// ─── Auth + role gate ────────────────────────────────────────────────

describe('GET /applications/by-month — auth gate', () => {
  test('missing Bearer → 401 (no DB calls)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month');
    expect(res.status).toBe(401);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
  });

  test('USER role ACCEPTED (anodyne aggregate posture, same as /stats)', async () => {
    // The role gate is verifyRole(['ADMIN','MANAGER','USER']) — looser
    // than the /applications list (ADMIN/MANAGER) because aggregate
    // counters are anodyne. Mirrors /applications/stats.
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      months: [],
      totalMonths: 0,
      grandCount: 0,
    });
  });
});

// ─── Query validation ─────────────────────────────────────────────────

describe('GET /applications/by-month — query validation', () => {
  test('unknown status value → 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month?status=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(res.body.error).toMatch(/intake/);
    // No DB hit when validation trips.
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-YYYY-MM from value → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month?from=2026/05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MONTH_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-YYYY-MM to value → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month?to=may-2026')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MONTH_FORMAT' });
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
      .get('/api/travel/visa/applications/by-month?status=approved')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Where clause includes the status narrowing.
    expect(prisma.visaApplication.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      contactId: { in: [11] },
      status: 'approved',
    });
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0]).toMatchObject({
      month: '2026-05',
      count: 1,
      approvedCount: 1,
    });
  });
});

// ─── Path-precedence smoke ───────────────────────────────────────────

describe('GET /applications/by-month — path-precedence', () => {
  test('literal /applications/by-month is NOT routed to /applications/:id', async () => {
    // If the routes were declared in the wrong order, /applications/by-month
    // would hit the /:id handler, which would 400 INVALID_ID because
    // parseInt("by-month") returns NaN. Reaching the by-month handler
    // with a 200 empty envelope proves precedence is correct.
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    expect(res.body).toMatchObject({ months: [], totalMonths: 0 });
  });
});

// ─── Empty-state contract ─────────────────────────────────────────────

describe('GET /applications/by-month — empty state', () => {
  test('zero visasure contacts → graceful empty envelope (NOT 404)', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      months: [],
      totalMonths: 0,
      grandCount: 0,
      grandApprovedCount: 0,
      grandRejectedCount: 0,
      limit: 12,
      offset: 0,
    });
    // VisaApplication never queried when the contact set is empty.
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
  });

  test('contacts present but zero applications → same empty envelope', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }, { id: 12 }]);
    prisma.visaApplication.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.months).toEqual([]);
    expect(res.body.totalMonths).toBe(0);
    expect(res.body.grandCount).toBe(0);
  });
});

// ─── Happy path: 4 applications across 2 UTC months ───────────────────

describe('GET /applications/by-month — happy path', () => {
  test('4 applications across 2 UTC months produces 2 buckets with per-status splits + complex/flagged tallies', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 21 }, { id: 22 }, { id: 23 }, { id: 24 },
    ]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // April 2026: 2 apps (1 intake, 1 filed) — 1 complex
      {
        id: 1, status: 'intake', complexCase: true, advisorRiskFlag: null,
        createdAt: new Date('2026-04-05T03:00:00Z'),
      },
      {
        id: 2, status: 'filed', complexCase: false, advisorRiskFlag: 'medium',
        createdAt: new Date('2026-04-22T18:00:00Z'),
      },
      // May 2026: 2 apps (1 approved, 1 rejected) — 1 flagged high
      {
        id: 3, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-10T09:00:00Z'),
      },
      {
        id: 4, status: 'rejected', complexCase: true, advisorRiskFlag: 'high',
        createdAt: new Date('2026-05-28T14:00:00Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(2);
    // Default orderBy=month:asc → April first, May second.
    expect(res.body.months[0]).toMatchObject({
      month: '2026-04',
      count: 2,
      intakeCount: 1,
      docsPendingCount: 0,
      filedCount: 1,
      approvedCount: 0,
      rejectedCount: 0,
      appealCount: 0,
      complexCount: 1,
      flaggedCount: 1, // medium counts as flagged
    });
    expect(res.body.months[1]).toMatchObject({
      month: '2026-05',
      count: 2,
      intakeCount: 0,
      filedCount: 0,
      approvedCount: 1,
      rejectedCount: 1,
      complexCount: 1,
      flaggedCount: 1, // high counts as flagged
    });
    // Grand totals.
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandApprovedCount).toBe(1);
    expect(res.body.grandRejectedCount).toBe(1);
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });
});

// ─── Sort ─────────────────────────────────────────────────────────────

describe('GET /applications/by-month — orderBy', () => {
  test('orderBy=count:desc inverts the chronological default', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 31 }, { id: 32 }, { id: 33 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // March 2026: 1 app
      { id: 1, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-03-10T00:00:00Z') },
      // April 2026: 3 apps (highest count) — should sort first under desc
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-04-01T00:00:00Z') },
      { id: 3, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-04-15T00:00:00Z') },
      { id: 4, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-04-29T00:00:00Z') },
      // May 2026: 2 apps
      { id: 5, status: 'rejected', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-05T00:00:00Z') },
      { id: 6, status: 'appeal', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-12T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // count:desc → April (3), May (2), March (1).
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-04', '2026-05', '2026-03']);
    expect(res.body.months.map((m) => m.count)).toEqual([3, 2, 1]);
  });

  test('unknown orderBy token degrades silently to month:asc', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 41 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-01T00:00:00Z') },
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-03-01T00:00:00Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month?orderBy=garbage:foo')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Default month:asc → March before May.
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-03', '2026-05']);
  });
});

// ─── from/to window filter ────────────────────────────────────────────

describe('GET /applications/by-month — from/to window', () => {
  test('single-month window includes only the matching bucket and excludes "unknown"', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 41 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-03-10T00:00:00Z') }, // out
      { id: 2, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-10T00:00:00Z') }, // in
      { id: 3, status: 'rejected', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-25T00:00:00Z') }, // in
      { id: 4, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-07-01T00:00:00Z') }, // out
      // "unknown" bucket row — should also be excluded when from/to is set
      { id: 5, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month?from=2026-05&to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0]).toMatchObject({
      month: '2026-05',
      count: 2,
      approvedCount: 1,
      rejectedCount: 1,
    });
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.grandCount).toBe(2);
    // "unknown" bucket excluded because from/to is set.
    expect(res.body.months.find((m) => m.month === 'unknown')).toBeUndefined();
  });
});

// ─── complexCount + flaggedCount accuracy ─────────────────────────────

describe('GET /applications/by-month — complex + flagged counts', () => {
  test('complexCount counts only complexCase=true; flaggedCount counts any truthy advisorRiskFlag', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 51 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // All in May 2026.
      // Complex + flagged
      { id: 1, status: 'intake', complexCase: true, advisorRiskFlag: 'high',
        createdAt: new Date('2026-05-01T00:00:00Z') },
      // Complex, NOT flagged (null)
      { id: 2, status: 'intake', complexCase: true, advisorRiskFlag: null,
        createdAt: new Date('2026-05-02T00:00:00Z') },
      // NOT complex (false), flagged (low)
      { id: 3, status: 'intake', complexCase: false, advisorRiskFlag: 'low',
        createdAt: new Date('2026-05-03T00:00:00Z') },
      // Neither (complexCase=false, advisorRiskFlag empty string is falsy)
      { id: 4, status: 'intake', complexCase: false, advisorRiskFlag: '',
        createdAt: new Date('2026-05-04T00:00:00Z') },
      // complexCase explicitly false (not undefined) + flagged 'priority'
      { id: 5, status: 'intake', complexCase: false, advisorRiskFlag: 'priority',
        createdAt: new Date('2026-05-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0]).toMatchObject({
      month: '2026-05',
      count: 5,
      intakeCount: 5,
      // complexCase=true: rows 1, 2 → 2
      complexCount: 2,
      // advisorRiskFlag truthy: rows 1 (high), 3 (low), 5 (priority) → 3
      flaggedCount: 3,
    });
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────

describe('GET /applications/by-month — tenant isolation (cross-tenant safe)', () => {
  test('every Contact + VisaApplication query narrows to (tenantId, subBrand=visasure)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 71 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-01T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);
    expect(res.status).toBe(200);
    // Contact lookup pinned tenantId + subBrand=visasure.
    expect(prisma.contact.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      subBrand: 'visasure',
    });
    // VisaApplication lookup pinned tenantId + the resolved contact set.
    expect(prisma.visaApplication.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      contactId: { in: [71] },
    });
  });
});

// ─── No audit row written ────────────────────────────────────────────

describe('GET /applications/by-month — anodyne (no audit row)', () => {
  test('successful read does NOT call auditLog.create (mirrors /stats posture)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 91 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-15T00:00:00Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // No audit-row creation for this anodyne aggregate read.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

// ─── Internal error ──────────────────────────────────────────────────

describe('GET /applications/by-month — internal errors', () => {
  test('visaApplication.findMany throws → 500 INTERNAL_ERROR (no DB error leak)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }]);
    prisma.visaApplication.findMany.mockRejectedValue(new Error('mysql gone away'));
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toMatch(/mysql gone away/);
  });
});
