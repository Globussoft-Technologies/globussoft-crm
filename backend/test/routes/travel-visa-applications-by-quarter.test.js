// @ts-check
/**
 * Travel CRM — Visa Sure GET /api/travel/visa/applications/by-quarter
 * contract tests (Phase 3 cluster B3 operational slice).
 *
 * Pins backend/routes/travel_visa.js:
 *   GET /api/travel/visa/applications/by-quarter
 *
 * Operational complement to /applications/by-month (fc7b8165) +
 * /applications/stats (20d91295) + /applications/:id/status-history
 * (f1741b6c). Same shape family as by-month, with the bucket key swapped
 * from YYYY-MM to YYYY-Qn. Operators review visa pipeline performance
 * quarterly for board reporting + ATL/BTL spend reconciliation; monthly
 * is too noisy and yearly too coarse.
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing Bearer → 401; USER role ACCEPTED (anodyne
 *     aggregate posture, mirrors by-month).
 *   - Path-precedence: /applications/by-quarter resolves BEFORE
 *     /applications/:id (literal-path definition order is the contract).
 *   - Query validation:
 *       INVALID_STATUS for unknown status value.
 *       INVALID_QUARTER_FORMAT for non-YYYY-Qn from/to values.
 *   - Empty-state contract: zero visasure contacts → graceful empty
 *     envelope (NOT 404) with grand-totals at 0 + quarters: [].
 *   - Happy path: 4 applications across 2 UTC quarters → 2 quarter
 *     buckets with correct per-status splits + complexCount + flaggedCount.
 *   - Quarter-boundary correctness: Jan = Q1, Mar = Q1, Apr = Q2,
 *     Jun = Q2, Jul = Q3, Sep = Q3, Oct = Q4, Dec = Q4.
 *   - Sort: orderBy=count:desc inverts the chronological default.
 *   - Status filter: status=approved narrows the where clause.
 *   - from/to window: single-quarter window excludes "unknown" + out-of-range
 *     buckets.
 *   - complexCount counts only complexCase=true; flaggedCount counts any
 *     truthy advisorRiskFlag.
 *   - Tenant isolation: every query narrows to (tenantId, subBrand=visasure).
 *   - No audit row written (anodyne aggregate).
 *   - limit clamped to max 40.
 *
 * Test pattern mirrors backend/test/routes/travel-visa-applications-by-month.test.js
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

describe('GET /applications/by-quarter — auth gate', () => {
  test('missing Bearer → 401 (no DB calls)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter');
    expect(res.status).toBe(401);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
  });

  test('USER role ACCEPTED (anodyne aggregate, same posture as by-month)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      quarters: [],
      totalQuarters: 0,
      grandCount: 0,
    });
  });
});

// ─── Query validation ─────────────────────────────────────────────────

describe('GET /applications/by-quarter — query validation', () => {
  test('unknown status value → 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter?status=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(res.body.error).toMatch(/intake/);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-YYYY-Qn from value (YYYY-MM shape) → 400 INVALID_QUARTER_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter?from=2026-05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_QUARTER_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('Q5 (out of range) → 400 INVALID_QUARTER_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter?to=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_QUARTER_FORMAT' });
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
      .get('/api/travel/visa/applications/by-quarter?status=approved')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.visaApplication.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      contactId: { in: [11] },
      status: 'approved',
    });
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0]).toMatchObject({
      quarter: '2026-Q2',
      count: 1,
      approvedCount: 1,
    });
  });
});

// ─── Path-precedence smoke ───────────────────────────────────────────

describe('GET /applications/by-quarter — path-precedence', () => {
  test('literal /applications/by-quarter is NOT routed to /applications/:id', async () => {
    // If routes were declared in the wrong order, /applications/by-quarter
    // would hit /:id and 400 INVALID_ID because parseInt("by-quarter") is
    // NaN. A 200 empty envelope proves precedence is correct.
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    expect(res.body).toMatchObject({ quarters: [], totalQuarters: 0 });
  });
});

// ─── Empty-state contract ─────────────────────────────────────────────

describe('GET /applications/by-quarter — empty state', () => {
  test('zero visasure contacts → graceful empty envelope (NOT 404)', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      quarters: [],
      totalQuarters: 0,
      grandCount: 0,
      grandApprovedCount: 0,
      grandRejectedCount: 0,
      limit: 12,
      offset: 0,
    });
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
  });

  test('contacts present but zero applications → same empty envelope', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }, { id: 12 }]);
    prisma.visaApplication.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.quarters).toEqual([]);
    expect(res.body.totalQuarters).toBe(0);
    expect(res.body.grandCount).toBe(0);
  });
});

// ─── Happy path: 4 applications across 2 UTC quarters ────────────────

describe('GET /applications/by-quarter — happy path', () => {
  test('4 applications across 2 UTC quarters produces 2 buckets with per-status splits + complex/flagged tallies', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 21 }, { id: 22 }, { id: 23 }, { id: 24 },
    ]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // Q1 2026 (Jan-Mar): 2 apps — 1 intake (complex), 1 filed (flagged medium)
      {
        id: 1, status: 'intake', complexCase: true, advisorRiskFlag: null,
        createdAt: new Date('2026-02-05T03:00:00Z'),
      },
      {
        id: 2, status: 'filed', complexCase: false, advisorRiskFlag: 'medium',
        createdAt: new Date('2026-03-22T18:00:00Z'),
      },
      // Q2 2026 (Apr-Jun): 2 apps — 1 approved, 1 rejected (complex + flagged high)
      {
        id: 3, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-04-10T09:00:00Z'),
      },
      {
        id: 4, status: 'rejected', complexCase: true, advisorRiskFlag: 'high',
        createdAt: new Date('2026-06-28T14:00:00Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(2);
    // Default orderBy=quarter:asc → Q1 first, Q2 second.
    expect(res.body.quarters[0]).toMatchObject({
      quarter: '2026-Q1',
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
    expect(res.body.quarters[1]).toMatchObject({
      quarter: '2026-Q2',
      count: 2,
      intakeCount: 0,
      filedCount: 0,
      approvedCount: 1,
      rejectedCount: 1,
      complexCount: 1,
      flaggedCount: 1, // high counts as flagged
    });
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.grandCount).toBe(4);
    expect(res.body.grandApprovedCount).toBe(1);
    expect(res.body.grandRejectedCount).toBe(1);
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });
});

// ─── Quarter-boundary correctness ─────────────────────────────────────

describe('GET /applications/by-quarter — month → quarter mapping', () => {
  test('Jan/Mar=Q1, Apr/Jun=Q2, Jul/Sep=Q3, Oct/Dec=Q4 across all 4 calendar quarters', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 51 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // Q1 boundaries
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-03-31T23:59:59Z') },
      // Q2 boundaries
      { id: 3, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-04-01T00:00:00Z') },
      { id: 4, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-06-30T23:59:59Z') },
      // Q3 boundaries
      { id: 5, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-07-01T00:00:00Z') },
      { id: 6, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-09-30T23:59:59Z') },
      // Q4 boundaries
      { id: 7, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-10-01T00:00:00Z') },
      { id: 8, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-12-31T23:59:59Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(4);
    expect(res.body.quarters.map((q) => q.quarter)).toEqual([
      '2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4',
    ]);
    expect(res.body.quarters.map((q) => q.count)).toEqual([2, 2, 2, 2]);
  });
});

// ─── Sort ─────────────────────────────────────────────────────────────

describe('GET /applications/by-quarter — orderBy', () => {
  test('orderBy=count:desc inverts the chronological default', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 31 }, { id: 32 }, { id: 33 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // Q1 2026: 1 app
      { id: 1, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-01-10T00:00:00Z') },
      // Q2 2026: 3 apps (highest count) — sorts first under desc
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-04-01T00:00:00Z') },
      { id: 3, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-15T00:00:00Z') },
      { id: 4, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-06-29T00:00:00Z') },
      // Q3 2026: 2 apps
      { id: 5, status: 'rejected', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-07-05T00:00:00Z') },
      { id: 6, status: 'appeal', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-08-12T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // count:desc → Q2 (3), Q3 (2), Q1 (1).
    expect(res.body.quarters.map((q) => q.quarter)).toEqual([
      '2026-Q2', '2026-Q3', '2026-Q1',
    ]);
    expect(res.body.quarters.map((q) => q.count)).toEqual([3, 2, 1]);
  });

  test('unknown orderBy token degrades silently to quarter:asc', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 41 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-01T00:00:00Z') },
      { id: 2, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-01-01T00:00:00Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter?orderBy=garbage:foo')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Default quarter:asc → Q1 before Q2.
    expect(res.body.quarters.map((q) => q.quarter)).toEqual(['2026-Q1', '2026-Q2']);
  });
});

// ─── from/to window filter ────────────────────────────────────────────

describe('GET /applications/by-quarter — from/to window', () => {
  test('single-quarter window includes only the matching bucket and excludes "unknown"', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 41 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-01-10T00:00:00Z') }, // Q1 — out
      { id: 2, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-10T00:00:00Z') }, // Q2 — in
      { id: 3, status: 'rejected', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-06-25T00:00:00Z') }, // Q2 — in
      { id: 4, status: 'filed', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-09-01T00:00:00Z') }, // Q3 — out
      // "unknown" bucket row — excluded when from/to set
      { id: 5, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter?from=2026-Q2&to=2026-Q2')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0]).toMatchObject({
      quarter: '2026-Q2',
      count: 2,
      approvedCount: 1,
      rejectedCount: 1,
    });
    expect(res.body.totalQuarters).toBe(1);
    expect(res.body.grandCount).toBe(2);
    expect(res.body.quarters.find((q) => q.quarter === 'unknown')).toBeUndefined();
  });
});

// ─── complexCount + flaggedCount accuracy ─────────────────────────────

describe('GET /applications/by-quarter — complex + flagged counts', () => {
  test('complexCount counts only complexCase=true; flaggedCount counts any truthy advisorRiskFlag', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 51 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      // All in Q2 2026.
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
      .get('/api/travel/visa/applications/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(1);
    expect(res.body.quarters[0]).toMatchObject({
      quarter: '2026-Q2',
      count: 5,
      intakeCount: 5,
      complexCount: 2,
      flaggedCount: 3,
    });
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────

describe('GET /applications/by-quarter — tenant isolation (cross-tenant safe)', () => {
  test('every Contact + VisaApplication query narrows to (tenantId, subBrand=visasure)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 71 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-01T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter')
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

describe('GET /applications/by-quarter — anodyne (no audit row)', () => {
  test('successful read does NOT call auditLog.create (mirrors /stats + /by-month)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 91 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'approved', complexCase: false, advisorRiskFlag: null,
        createdAt: new Date('2026-05-15T00:00:00Z') },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

// ─── Limit clamping ──────────────────────────────────────────────────

describe('GET /applications/by-quarter — limit clamping', () => {
  test('limit=999 clamps to max 40', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter?limit=999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(40);
  });
});

// ─── Internal error ──────────────────────────────────────────────────

describe('GET /applications/by-quarter — internal errors', () => {
  test('visaApplication.findMany throws → 500 INTERNAL_ERROR (no DB error leak)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }]);
    prisma.visaApplication.findMany.mockRejectedValue(new Error('mysql gone away'));
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res.body)).not.toMatch(/mysql gone away/);
  });
});
