// @ts-check
/**
 * Travel CRM — Visa Sure analytics by-month rollup (V19) contract tests.
 *
 * Pins backend/routes/travel_visa_analytics.js:
 *   GET /api/travel/visa/analytics/by-month
 *
 * 4th analytics endpoint complementing V16 (rejection-recovery),
 * V17 (conversion-by-readiness), V18 (lead-source-rate) shipped in
 * slice 3. Tenant-wide VisaApplication time-series bucketed by UTC
 * YYYY-MM, joined via Contact.subBrand='visasure'.
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing Bearer → 401; USER role → 403.
 *   - Vertical gate: inherited from requireTravelTenant (sibling spec
 *     pins this; not duplicated here).
 *   - Query validation:
 *       INVALID_STATUS for unknown status value.
 *       INVALID_MONTH_FORMAT for non-YYYY-MM from/to values.
 *   - Empty-state contract: zero visasure contacts → graceful empty
 *     envelope (NOT 404) with grand-totals at 0 + months: [].
 *   - Happy path: 4 applications across 2 UTC months → 2 month buckets
 *     with correct per-status splits + complexCount + flaggedCount.
 *   - Sort: orderBy=count:desc inverts the chronological default.
 *   - Status filter: status=approved narrows the where clause; the
 *     full application set passed back from the mock should still be
 *     aggregated correctly into per-month rows.
 *   - from/to window: single-month window excludes "unknown" + out-of-range
 *     buckets.
 *   - Cross-tenant isolation: every Contact + VisaApplication query
 *     narrows to (tenantId, subBrand='visasure'); the resolved contactId
 *     set is the join key.
 *   - Bucket key uses UTC year/month (not local time).
 *
 * Test pattern mirrors backend/test/routes/travel-visa-analytics.test.js —
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

describe('GET /by-month — auth gate', () => {
  test('missing Bearer → 401 (no DB calls)', async () => {
    const res = await request(makeApp()).get('/api/travel/visa/analytics/by-month');
    expect(res.status).toBe(401);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
  });

  test('USER role is rejected by verifyRole (403, no DB calls)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });
});

// ─── Query validation ─────────────────────────────────────────────────

describe('GET /by-month — query validation', () => {
  test('unknown status value → 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-month?status=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(res.body.error).toMatch(/intake/);
    // No DB hit when validation trips.
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-YYYY-MM from value → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-month?from=2026/05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_MONTH_FORMAT' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-YYYY-MM to value → 400 INVALID_MONTH_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-month?to=may-2026')
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
      .get('/api/travel/visa/analytics/by-month?status=approved')
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

// ─── Empty-state contract ─────────────────────────────────────────────

describe('GET /by-month — empty state', () => {
  test('zero visasure contacts → graceful empty envelope (NOT 404)', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-month')
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
      .get('/api/travel/visa/analytics/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.months).toEqual([]);
    expect(res.body.totalMonths).toBe(0);
    expect(res.body.grandCount).toBe(0);
  });
});

// ─── Happy path: 4 applications across 2 UTC months ───────────────────

describe('GET /by-month — happy path', () => {
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
      .get('/api/travel/visa/analytics/by-month')
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

describe('GET /by-month — orderBy', () => {
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
      .get('/api/travel/visa/analytics/by-month?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // count:desc → April (3), May (2), March (1).
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-04', '2026-05', '2026-03']);
    expect(res.body.months.map((m) => m.count)).toEqual([3, 2, 1]);
  });
});

// ─── from/to window filter ────────────────────────────────────────────

describe('GET /by-month — from/to window', () => {
  test('single-month window includes only the matching bucket', async () => {
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
      .get('/api/travel/visa/analytics/by-month?from=2026-05&to=2026-05')
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

describe('GET /by-month — complex + flagged counts', () => {
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
      .get('/api/travel/visa/analytics/by-month')
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

describe('GET /by-month — tenant isolation (cross-tenant safe)', () => {
  test('Contact lookup narrowed to (tenantId, subBrand=visasure); VisaApplication scoped to contactId set + tenantId', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 61 }, { id: 62 }]);
    prisma.visaApplication.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/visa/analytics/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER', { tenantId: 1 })}`);

    // Contact lookup narrowed to (tenantId, subBrand=visasure).
    expect(prisma.contact.findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 1, subBrand: 'visasure' },
      select: { id: true },
    });
    // VisaApplication.findMany narrowed to (tenantId, contactId in [61,62]).
    expect(prisma.visaApplication.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      contactId: { in: [61, 62] },
    });
  });

  test('zero cross-tenant leak: when Contact set is empty (no visasure contacts for this tenant), VisaApplication is NEVER queried', async () => {
    prisma.contact.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 999 })}`);
    expect(res.status).toBe(200);
    // Confirms VisaApplication.findMany was not called.
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
    // Empty envelope.
    expect(res.body.grandCount).toBe(0);
    expect(res.body.months).toEqual([]);
  });
});

// ─── Error path ───────────────────────────────────────────────────────

describe('GET /by-month — error path', () => {
  test('prisma.visaApplication.findMany throws → 500 INTERNAL_ERROR (no DB error leak)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 71 }]);
    prisma.visaApplication.findMany.mockRejectedValue(new Error('mysql connection refused'));
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(res.body.error).toMatch(/by-month/i);
    expect(JSON.stringify(res.body)).not.toMatch(/mysql connection refused/);
  });
});
