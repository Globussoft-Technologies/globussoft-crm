// @ts-check
/**
 * Travel CRM — Visa Sure analytics route (Phase 3 cluster B3) contract tests.
 *
 * Pins backend/routes/travel_visa_analytics.js:
 *   GET /api/travel/visa/analytics/rejection-recovery       (V16)
 *   GET /api/travel/visa/analytics/conversion-by-readiness  (V17)
 *   GET /api/travel/visa/analytics/lead-source-rate         (V18)
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing/garbage Bearer → 401 (verifyToken). Aggregates
 *     never fire when the gate trips.
 *   - Role gate: USER role → 403 (verifyRole(['ADMIN','MANAGER'])).
 *   - Vertical gate: non-travel tenant → 403 WRONG_VERTICAL; tenant row
 *     missing → 404 TENANT_NOT_FOUND.
 *   - Empty-state contract: when zero visasure contacts exist for the
 *     tenant, every endpoint returns a stable shape with `rows: []` and a
 *     `note` field — NOT a 404 (intentional SHELL behaviour per the
 *     route's "graceful for the Reports.jsx SHELL" comment).
 *   - Tenant + sub-brand isolation: every Contact lookup narrows to
 *     `{ tenantId, subBrand: "visasure" }`; VisaApplication queries narrow
 *     to the resolved contactId set + the same tenantId.
 *   - V16 happy path: totalRejected / recoveryAttempts / recoverySuccesses
 *     counts surface verbatim; successRate = successes / attempts, with
 *     zero-attempts safely yielding 0 (no divide-by-zero).
 *   - V17 happy path: every level 1..4 appears in `byReadinessLevel`
 *     (even with zero counts) for stable chart axes; the "unknown" bucket
 *     only appears when null-level rows actually exist.
 *   - V18 happy path: sources sort by leads desc; rate = applications /
 *     leads; null `source` field becomes "(none)".
 *   - Error path: each endpoint returns 500 with a code=INTERNAL_ERROR
 *     envelope when prisma throws — no DB error leak.
 *
 * Test pattern mirrors backend/test/routes/travel-dashboard.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with real HS256 JWTs signed with the dev-fallback
 * secret. verifyToken + verifyRole + requireTravelTenant all stay in the
 * chain (no bypass) so the guards are exercised end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router. The analytics route touches
// 2 tables — contact (groupBy + findMany) + visaApplication (count +
// groupBy + findMany). The audit helper writes through prisma.auditLog
// (wrapped in `.catch(() => {})` so we don't need to assert on it).
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

// ─── Auth + vertical gate (shared across all 3 endpoints) ─────────────

describe('travel-visa-analytics — auth gate', () => {
  test('missing Bearer → 401 (rejection-recovery)', async () => {
    const res = await request(makeApp()).get('/api/travel/visa/analytics/rejection-recovery');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(prisma.visaApplication.count).not.toHaveBeenCalled();
  });

  test('garbage Bearer → 401 (conversion-by-readiness)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/conversion-by-readiness')
      .set('Authorization', 'Bearer not.a.real.jwt');
    expect(res.status).toBe(401);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('USER role is rejected by verifyRole (lead-source-rate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/lead-source-rate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    // verifyRole rejects BEFORE the vertical/Contact lookups fire.
    expect(prisma.contact.groupBy).not.toHaveBeenCalled();
  });
});

describe('travel-visa-analytics — vertical gate', () => {
  test('non-travel tenant → 403 WRONG_VERTICAL (rejection-recovery)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Co', slug: 'generic',
    });
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/rejection-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('wellness-vertical tenant is also rejected (conversion-by-readiness)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'wellness', name: 'Wellness Co', slug: 'wellness',
    });
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/conversion-by-readiness')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
  });

  test('tenant row missing → 404 TENANT_NOT_FOUND (lead-source-rate)', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/lead-source-rate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
    expect(prisma.contact.groupBy).not.toHaveBeenCalled();
  });
});

// ─── V16: GET /rejection-recovery ─────────────────────────────────────

describe('GET /rejection-recovery (V16) — empty + happy paths', () => {
  test('zero visasure contacts → graceful empty envelope with note (NOT 404)', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/rejection-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalRejected: 0,
      recoveryAttempts: 0,
      recoverySuccesses: 0,
      successRate: 0,
      rows: [],
    });
    expect(res.body.note).toMatch(/No Visa Sure contacts yet/);
    // VisaApplication never queried when the contact set is empty.
    expect(prisma.visaApplication.count).not.toHaveBeenCalled();
    expect(prisma.visaApplication.groupBy).not.toHaveBeenCalled();
  });

  test('happy path: counts surface verbatim, successRate = successes / attempts', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }, { id: 12 }, { id: 13 }]);
    // Promise.all order: [totalRejected, recoveryAttempts, recoverySuccesses, byStatus]
    prisma.visaApplication.count
      .mockResolvedValueOnce(20) // totalRejected
      .mockResolvedValueOnce(8)  // recoveryAttempts
      .mockResolvedValueOnce(6); // recoverySuccesses
    prisma.visaApplication.groupBy.mockResolvedValue([
      { status: 'approved', _count: { _all: 30 } },
      { status: 'rejected', _count: { _all: 20 } },
      { status: 'pending', _count: { _all: 5 } },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/rejection-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.totalRejected).toBe(20);
    expect(res.body.recoveryAttempts).toBe(8);
    expect(res.body.recoverySuccesses).toBe(6);
    expect(res.body.successRate).toBeCloseTo(0.75, 4); // 6/8
    expect(res.body.rows).toEqual([
      { status: 'approved', count: 30 },
      { status: 'rejected', count: 20 },
      { status: 'pending', count: 5 },
    ]);

    // Contact lookup narrowed to (tenantId, subBrand=visasure).
    expect(prisma.contact.findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 1, subBrand: 'visasure' },
      select: { id: true },
    });
    // All 3 count() calls narrow to (tenantId=1, contactId in [11,12,13]).
    const baseWhere = expect.objectContaining({
      tenantId: 1,
      contactId: { in: [11, 12, 13] },
    });
    expect(prisma.visaApplication.count.mock.calls[0][0].where).toEqual(baseWhere);
    expect(prisma.visaApplication.count.mock.calls[1][0].where).toEqual(baseWhere);
    expect(prisma.visaApplication.count.mock.calls[2][0].where).toEqual(baseWhere);
  });

  test('zero recoveryAttempts → successRate = 0 (no divide-by-zero)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }]);
    prisma.visaApplication.count
      .mockResolvedValueOnce(5) // totalRejected
      .mockResolvedValueOnce(0) // recoveryAttempts
      .mockResolvedValueOnce(0); // recoverySuccesses
    prisma.visaApplication.groupBy.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/rejection-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.successRate).toBe(0);
    expect(Number.isFinite(res.body.successRate)).toBe(true);
  });

  test('successRate rounded to 4 decimal places (per route Number(x.toFixed(4)) contract)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }]);
    prisma.visaApplication.count
      .mockResolvedValueOnce(10) // totalRejected
      .mockResolvedValueOnce(3)  // recoveryAttempts
      .mockResolvedValueOnce(1); // recoverySuccesses → 1/3 = 0.3333...
    prisma.visaApplication.groupBy.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/rejection-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // 1/3 rounded to 4dp = 0.3333 exactly.
    expect(res.body.successRate).toBe(0.3333);
  });

  test('prisma.contact.findMany throws → 500 INTERNAL_ERROR (no DB error leak)', async () => {
    prisma.contact.findMany.mockRejectedValue(new Error('mysql connection refused'));
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/rejection-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(res.body.error).toMatch(/rejection-recovery/i);
    expect(JSON.stringify(res.body)).not.toMatch(/mysql connection refused/);
  });
});

// ─── V17: GET /conversion-by-readiness ────────────────────────────────

describe('GET /conversion-by-readiness (V17) — empty + happy paths', () => {
  test('zero visasure contacts → graceful empty envelope with note', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/conversion-by-readiness')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      byReadinessLevel: [],
      rows: [],
    });
    expect(res.body.note).toMatch(/No Visa Sure contacts yet/);
    expect(prisma.visaApplication.groupBy).not.toHaveBeenCalled();
  });

  test('happy path: every level 1..4 appears even when only some have data', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 21 }, { id: 22 }]);
    // Promise.all: [totals, converted]
    prisma.visaApplication.groupBy
      .mockResolvedValueOnce([
        // totals
        { readinessLevel: 1, _count: { _all: 10 } },
        { readinessLevel: 3, _count: { _all: 5 } },
        // level 2 + 4 absent → must still appear with count=0
      ])
      .mockResolvedValueOnce([
        // converted
        { readinessLevel: 1, _count: { _all: 2 } },
        { readinessLevel: 3, _count: { _all: 4 } },
      ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/conversion-by-readiness')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.byReadinessLevel).toHaveLength(4); // exactly levels 1..4
    expect(res.body.byReadinessLevel).toEqual([
      { level: 'level_1', count: 10, converted: 2, conversionRate: 0.2 },
      { level: 'level_2', count: 0, converted: 0, conversionRate: 0 },
      { level: 'level_3', count: 5, converted: 4, conversionRate: 0.8 },
      { level: 'level_4', count: 0, converted: 0, conversionRate: 0 },
    ]);
    // rows mirrors byReadinessLevel.
    expect(res.body.rows).toEqual(res.body.byReadinessLevel);
  });

  test('null-level applications surface as an "unknown" bucket', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 21 }]);
    prisma.visaApplication.groupBy
      .mockResolvedValueOnce([
        { readinessLevel: 2, _count: { _all: 4 } },
        { readinessLevel: null, _count: { _all: 3 } }, // unknown
      ])
      .mockResolvedValueOnce([
        { readinessLevel: 2, _count: { _all: 1 } },
        { readinessLevel: null, _count: { _all: 1 } },
      ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/conversion-by-readiness')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // 4 standard levels + 1 unknown bucket.
    expect(res.body.byReadinessLevel).toHaveLength(5);
    const unknown = res.body.byReadinessLevel.find((r) => r.level === 'unknown');
    expect(unknown).toMatchObject({ level: 'unknown', count: 3, converted: 1 });
    expect(unknown.conversionRate).toBeCloseTo(0.3333, 4);
  });

  test('no null-level rows → no "unknown" bucket emitted', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 21 }]);
    prisma.visaApplication.groupBy
      .mockResolvedValueOnce([{ readinessLevel: 1, _count: { _all: 1 } }])
      .mockResolvedValueOnce([]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/conversion-by-readiness')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.byReadinessLevel.find((r) => r.level === 'unknown')).toBeUndefined();
    expect(res.body.byReadinessLevel).toHaveLength(4);
  });

  test('aggregates narrow to tenantId + contactId set (tenant isolation)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 21 }, { id: 22 }, { id: 23 }]);
    prisma.visaApplication.groupBy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await request(makeApp())
      .get('/api/travel/visa/analytics/conversion-by-readiness')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);
    // totals groupBy
    expect(prisma.visaApplication.groupBy.mock.calls[0][0]).toMatchObject({
      by: ['readinessLevel'],
      where: expect.objectContaining({
        tenantId: 1,
        contactId: { in: [21, 22, 23] },
      }),
    });
    // converted groupBy: same scope + outcome/status=approved overlay.
    const convertedWhere = prisma.visaApplication.groupBy.mock.calls[1][0].where;
    expect(convertedWhere).toMatchObject({
      tenantId: 1,
      contactId: { in: [21, 22, 23] },
    });
    expect(convertedWhere).toHaveProperty('OR');
  });

  test('prisma.visaApplication.groupBy throws → 500 INTERNAL_ERROR', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 21 }]);
    prisma.visaApplication.groupBy.mockRejectedValue(new Error('groupBy explosion'));
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/conversion-by-readiness')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(res.body.error).toMatch(/conversion-by-readiness/i);
    expect(JSON.stringify(res.body)).not.toMatch(/groupBy explosion/);
  });
});

// ─── V18: GET /lead-source-rate ───────────────────────────────────────

describe('GET /lead-source-rate (V18) — empty + happy paths', () => {
  test('zero visasure contacts grouped by source → graceful empty envelope with note', async () => {
    prisma.contact.groupBy.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/lead-source-rate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bySource: [], rows: [] });
    expect(res.body.note).toMatch(/No Visa Sure leads yet/);
    // Downstream VisaApplication probe doesn't fire when there are no leads.
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
  });

  test('happy path: bySource sorted desc by leads, rate computed per source', async () => {
    prisma.contact.groupBy.mockResolvedValue([
      { source: 'google-ads', _count: { _all: 10 } },
      { source: 'facebook', _count: { _all: 5 } },
      { source: 'referral', _count: { _all: 2 } },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 31, source: 'google-ads' },
      { id: 32, source: 'google-ads' },
      { id: 33, source: 'google-ads' },
      { id: 34, source: 'facebook' },
      { id: 35, source: 'referral' },
    ]);
    // 3 distinct contacts (32,34,35) have ≥1 visa application.
    prisma.visaApplication.findMany.mockResolvedValue([
      { contactId: 32 },
      { contactId: 34 },
      { contactId: 35 },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/lead-source-rate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Sort: leads desc (10, 5, 2).
    expect(res.body.bySource).toEqual([
      { source: 'google-ads', leads: 10, applications: 1, rate: 0.1 },
      { source: 'facebook', leads: 5, applications: 1, rate: 0.2 },
      { source: 'referral', leads: 2, applications: 1, rate: 0.5 },
    ]);
    expect(res.body.rows).toEqual(res.body.bySource);
  });

  test('null source field surfaces as "(none)" string in the bucket', async () => {
    prisma.contact.groupBy.mockResolvedValue([
      { source: null, _count: { _all: 4 } },
      { source: 'organic', _count: { _all: 3 } },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 41, source: null },
      { id: 42, source: 'organic' },
    ]);
    prisma.visaApplication.findMany.mockResolvedValue([{ contactId: 41 }]);

    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/lead-source-rate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.bySource[0]).toMatchObject({
      source: '(none)', leads: 4, applications: 1, rate: 0.25,
    });
    expect(res.body.bySource[1]).toMatchObject({
      source: 'organic', leads: 3, applications: 0, rate: 0,
    });
  });

  test('Contact queries narrow to (tenantId, subBrand=visasure) for tenant isolation', async () => {
    prisma.contact.groupBy.mockResolvedValue([
      { source: 'organic', _count: { _all: 1 } },
    ]);
    prisma.contact.findMany.mockResolvedValue([{ id: 51, source: 'organic' }]);
    prisma.visaApplication.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/visa/analytics/lead-source-rate')
      .set('Authorization', `Bearer ${tokenFor('MANAGER', { tenantId: 1 })}`);

    // contacts.groupBy narrowed by tenant + subBrand.
    expect(prisma.contact.groupBy.mock.calls[0][0]).toMatchObject({
      by: ['source'],
      where: { tenantId: 1, subBrand: 'visasure' },
    });
    // contacts.findMany narrowed identically.
    expect(prisma.contact.findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 1, subBrand: 'visasure' },
      select: { id: true, source: true },
    });
    // visaApplication.findMany narrowed by tenant + contactId set + distinct.
    expect(prisma.visaApplication.findMany.mock.calls[0][0]).toMatchObject({
      where: expect.objectContaining({
        tenantId: 1,
        contactId: { in: [51] },
      }),
      select: { contactId: true },
      distinct: ['contactId'],
    });
  });

  test('prisma.contact.groupBy throws → 500 INTERNAL_ERROR', async () => {
    prisma.contact.groupBy.mockRejectedValue(new Error('group explosion'));
    const res = await request(makeApp())
      .get('/api/travel/visa/analytics/lead-source-rate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(res.body.error).toMatch(/lead-source-rate/i);
    expect(JSON.stringify(res.body)).not.toMatch(/group explosion/);
  });
});
