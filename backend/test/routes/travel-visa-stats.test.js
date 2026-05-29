// @ts-check
/**
 * Travel CRM — Visa Sure GET /api/travel/visa/applications/stats contract tests
 * (Phase 3 cluster B3, tenant-wide rollup slice mirroring #905 slice 18 +
 * #903 slice 23 + #908 slice 19).
 *
 * Pins backend/routes/travel_visa.js (stats surface):
 *
 *   GET /api/travel/visa/applications/stats
 *
 * What's pinned
 * -------------
 *   - Auth gate: missing Bearer → 401. USER role accepted (anodyne aggregate,
 *     matches /suppliers/stats + /commission-profiles/stats posture).
 *   - Empty tenant (zero visa-sure contacts) → all-zeros envelope with
 *     byStatus pre-seeded to every enum value at zero.
 *   - Visa-sure contacts present but no applications → same zeroed envelope.
 *   - Happy path: 5 applications mixing statuses + types + destinations →
 *     buckets correct (byStatus, byApplicationType, byDestinationCountry).
 *   - complexCount = count where complexCase=true.
 *   - flaggedCount = count where advisorRiskFlag IS NOT NULL (any value).
 *   - lastActivityAt = max(updatedAt) ISO across all matching rows; null
 *     when zero rows.
 *   - Cross-tenant isolation: only contacts for the calling tenant are
 *     resolved (Contact.findMany.where carries the calling tenant id, not
 *     a sibling tenant's).
 *   - Defensive: null applicationType / null destinationCountry skip their
 *     bucket without crashing.
 *   - byDestinationCountry capped to top-10; overflow aggregates into _other.
 *   - ?from / ?to ISO bounds applied to VisaApplication.createdAt via the
 *     `where.createdAt` filter; garbage → 400 INVALID_DATE.
 *
 * Mocking pattern mirrors travel-visa-status-history.test.js — monkey-patch
 * the prisma singleton BEFORE requiring the router so verifyToken +
 * verifyRole + requireTravelTenant stay in the chain (no bypass).
 *
 * Why this matters
 * ----------------
 *   - Stats power the Applications.jsx (875c082) header summary strip; the
 *     contract here must stay stable so the frontend doesn't have to
 *     bisect on a moving aggregate shape.
 *   - The endpoint MUST be declared BEFORE the /applications/:id family
 *     (path-precedence test inline: a request to .../stats with no `:id`
 *     fallback should return 200 with the aggregate shape, NOT 400
 *     INVALID_ID).
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
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
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

const VALID_STATUSES = [
  'intake',
  'docs-pending',
  'filed',
  'approved',
  'rejected',
  'appeal',
];

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
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ─── Auth gate ───────────────────────────────────────────────────────

describe('GET /applications/stats — auth gate', () => {
  test('missing Bearer → 401 (no DB calls)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/stats');
    expect(res.status).toBe(401);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
  });

  test('USER role accepted (anodyne aggregate posture)', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
  });
});

// ─── Empty tenant ────────────────────────────────────────────────────

describe('GET /applications/stats — empty tenant', () => {
  test('zero visa-sure contacts → all-zeros envelope with byStatus pre-seeded', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.complexCount).toBe(0);
    expect(res.body.flaggedCount).toBe(0);
    expect(res.body.lastActivityAt).toBeNull();
    expect(res.body.byApplicationType).toEqual({});
    expect(res.body.byDestinationCountry).toEqual({});
    // byStatus is pre-seeded with all enum values at zero so the frontend
    // can render every status tile without missing-key defensiveness.
    for (const s of VALID_STATUSES) {
      expect(res.body.byStatus[s]).toEqual({ count: 0 });
    }
    // VisaApplication.findMany not fired since no contact ids resolved.
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
  });

  test('visa-sure contacts present but no applications → same zeroed envelope', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }, { id: 12 }]);
    prisma.visaApplication.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.lastActivityAt).toBeNull();
    for (const s of VALID_STATUSES) {
      expect(res.body.byStatus[s]).toEqual({ count: 0 });
    }
  });
});

// ─── Happy path ──────────────────────────────────────────────────────

describe('GET /applications/stats — happy path', () => {
  test('5 applications mix → buckets correct + complexCount + flaggedCount + lastActivityAt', async () => {
    prisma.contact.findMany.mockResolvedValue([
      { id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }, { id: 15 },
    ]);
    const t1 = new Date('2026-05-01T08:00:00.000Z');
    const t2 = new Date('2026-05-02T10:30:00.000Z');
    const t3 = new Date('2026-05-03T14:15:00.000Z');
    const t4 = new Date('2026-05-04T18:00:00.000Z');
    const t5 = new Date('2026-05-05T22:45:00.000Z'); // newest — should be lastActivityAt
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake',       applicationType: 'tourist',  destinationCountry: 'AE', complexCase: false, advisorRiskFlag: null,       updatedAt: t1 },
      { id: 2, status: 'intake',       applicationType: 'business', destinationCountry: 'US', complexCase: true,  advisorRiskFlag: 'medium',   updatedAt: t2 },
      { id: 3, status: 'docs-pending', applicationType: 'tourist',  destinationCountry: 'AE', complexCase: false, advisorRiskFlag: 'low',      updatedAt: t3 },
      { id: 4, status: 'filed',        applicationType: 'umrah',    destinationCountry: 'SA', complexCase: true,  advisorRiskFlag: 'priority', updatedAt: t4 },
      { id: 5, status: 'approved',     applicationType: 'tourist',  destinationCountry: 'UK', complexCase: false, advisorRiskFlag: null,       updatedAt: t5 },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);

    // byStatus
    expect(res.body.byStatus.intake).toEqual({ count: 2 });
    expect(res.body.byStatus['docs-pending']).toEqual({ count: 1 });
    expect(res.body.byStatus.filed).toEqual({ count: 1 });
    expect(res.body.byStatus.approved).toEqual({ count: 1 });
    expect(res.body.byStatus.rejected).toEqual({ count: 0 });
    expect(res.body.byStatus.appeal).toEqual({ count: 0 });

    // byApplicationType
    expect(res.body.byApplicationType.tourist).toEqual({ count: 3 });
    expect(res.body.byApplicationType.business).toEqual({ count: 1 });
    expect(res.body.byApplicationType.umrah).toEqual({ count: 1 });

    // byDestinationCountry
    expect(res.body.byDestinationCountry.AE).toEqual({ count: 2 });
    expect(res.body.byDestinationCountry.US).toEqual({ count: 1 });
    expect(res.body.byDestinationCountry.SA).toEqual({ count: 1 });
    expect(res.body.byDestinationCountry.UK).toEqual({ count: 1 });
    // No overflow at 4 unique destinations (cap is 10) — no _other key.
    expect(res.body.byDestinationCountry._other).toBeUndefined();

    // complexCount + flaggedCount
    expect(res.body.complexCount).toBe(2);
    expect(res.body.flaggedCount).toBe(3); // 'medium' + 'low' + 'priority' (null filters out)

    // lastActivityAt = max(updatedAt)
    expect(res.body.lastActivityAt).toBe(t5.toISOString());

    // VisaApplication.findMany where carried tenantId + contactId IN list +
    // no createdAt filter (no ?from / ?to passed).
    const findCall = prisma.visaApplication.findMany.mock.calls[0][0];
    expect(findCall.where.tenantId).toBe(1);
    expect(findCall.where.contactId.in).toEqual([11, 12, 13, 14, 15]);
    expect(findCall.where.createdAt).toBeUndefined();
  });
});

// ─── Cross-tenant isolation ──────────────────────────────────────────

describe('GET /applications/stats — cross-tenant', () => {
  test('Contact.findMany.where carries calling tenant id, not a sibling', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/visa/applications/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);
    expect(prisma.contact.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 1,
      subBrand: 'visasure',
    });
  });

  test('contacts from tenant=2 do not bleed when caller is tenant=1', async () => {
    // The mock returns only tenant=1's contacts; the route's where clause
    // is what enforces isolation in prod. The pin here is that the WHERE
    // we send to Prisma carries the caller's tenantId. We also need to
    // stub the tenant lookup to match.
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'travel', name: 'Tenant One', slug: 't1',
    });
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', applicationType: 'tourist', destinationCountry: 'AE', complexCase: false, advisorRiskFlag: null, updatedAt: new Date('2026-05-01T00:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(prisma.visaApplication.findMany.mock.calls[0][0].where.tenantId).toBe(1);
  });
});

// ─── Defensive nulls ─────────────────────────────────────────────────

describe('GET /applications/stats — defensive nulls', () => {
  test('null applicationType / null destinationCountry skip their buckets without crashing', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }, { id: 12 }]);
    prisma.visaApplication.findMany.mockResolvedValue([
      { id: 1, status: 'intake', applicationType: null, destinationCountry: null, complexCase: false, advisorRiskFlag: null, updatedAt: new Date('2026-05-01T00:00:00.000Z') },
      { id: 2, status: 'intake', applicationType: 'tourist', destinationCountry: 'AE', complexCase: false, advisorRiskFlag: null, updatedAt: new Date('2026-05-02T00:00:00.000Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    // Only the non-null row creates buckets.
    expect(res.body.byApplicationType.tourist).toEqual({ count: 1 });
    expect(Object.keys(res.body.byApplicationType)).toEqual(['tourist']);
    expect(res.body.byDestinationCountry.AE).toEqual({ count: 1 });
    expect(Object.keys(res.body.byDestinationCountry)).toEqual(['AE']);
  });
});

// ─── byDestinationCountry top-10 cap ─────────────────────────────────

describe('GET /applications/stats — destination cap', () => {
  test('12 unique destinations → top-10 returned + _other aggregates the rest', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }]);
    // Build 12 destinations with decreasing counts: 12, 11, 10, ..., 1.
    // After the top-10 cap, destinations ranked 11+12 (counts 2 + 1 = 3)
    // should merge into _other.
    const rows = [];
    const destinations = ['US', 'UK', 'AE', 'SA', 'FR', 'DE', 'JP', 'CA', 'AU', 'NL', 'IT', 'ES'];
    let counter = 1;
    for (let i = 0; i < destinations.length; i += 1) {
      const dest = destinations[i];
      const count = destinations.length - i; // 12, 11, 10, ...
      for (let n = 0; n < count; n += 1) {
        rows.push({
          id: counter,
          status: 'intake',
          applicationType: 'tourist',
          destinationCountry: dest,
          complexCase: false,
          advisorRiskFlag: null,
          updatedAt: new Date('2026-05-01T00:00:00.000Z'),
        });
        counter += 1;
      }
    }
    prisma.visaApplication.findMany.mockResolvedValue(rows);

    const res = await request(makeApp())
      .get('/api/travel/visa/applications/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    // Top-10 kept; the two lowest-ranked (IT=1, ES=... wait — last two by count).
    // With the construction above: US=12, UK=11, AE=10, SA=9, FR=8, DE=7,
    // JP=6, CA=5, AU=4, NL=3, IT=2, ES=1. Top-10 are US..NL. _other = IT + ES = 3.
    expect(res.body.byDestinationCountry.US).toEqual({ count: 12 });
    expect(res.body.byDestinationCountry.NL).toEqual({ count: 3 });
    expect(res.body.byDestinationCountry.IT).toBeUndefined();
    expect(res.body.byDestinationCountry.ES).toBeUndefined();
    expect(res.body.byDestinationCountry._other).toEqual({ count: 3 });
  });
});

// ─── Date bounds ─────────────────────────────────────────────────────

describe('GET /applications/stats — date bounds', () => {
  test('?from / ?to ISO bounds applied to VisaApplication.createdAt', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }]);
    prisma.visaApplication.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/visa/applications/stats?from=2026-05-01T00:00:00.000Z&to=2026-05-31T23:59:59.999Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const findCall = prisma.visaApplication.findMany.mock.calls[0][0];
    expect(findCall.where.createdAt).toBeDefined();
    expect(findCall.where.createdAt.gte).toEqual(new Date('2026-05-01T00:00:00.000Z'));
    expect(findCall.where.createdAt.lte).toEqual(new Date('2026-05-31T23:59:59.999Z'));
  });

  test('?from=garbage → 400 INVALID_DATE (no DB hit beyond contacts/tenant guard)', async () => {
    prisma.contact.findMany.mockResolvedValue([{ id: 11 }]);
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
    expect(prisma.visaApplication.findMany).not.toHaveBeenCalled();
  });

  test('?to=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/applications/stats?to=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATE' });
  });
});
