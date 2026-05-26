// @ts-check
/**
 * #907 rollup-family completion — GET /api/travel/itineraries/stats.
 *
 * Pins the contract for the tenant-wide aggregate handler on
 * backend/routes/travel_itineraries.js (declared BEFORE GET /:id, so
 * Express doesn't try to parse "stats" as a numeric :id and 400).
 *
 * Why distinct from the existing travel_itineraries.test.js
 * ---------------------------------------------------------
 * The sibling test files cover CRUD + items + by-month/by-quarter/by-year
 * rollups. The /stats endpoint (this file) is the canonical tenant-wide
 * aggregate envelope — separate concern, separate test scaffolding.
 *
 * Status enum (from schema.prisma model Itinerary): draft | sent |
 * revised | accepted | rejected | advance_paid | fully_paid. The
 * agreement-secured trio (accepted + advance_paid + fully_paid) all roll
 * up into grandAcceptedValue per PRD §4.7 Phase 2 50%-advance booking.
 * acceptanceRate denominator = terminal-decision set (accepted +
 * advance_paid + fully_paid + rejected).
 *
 * Contracts asserted (≥10 cases)
 * ------------------------------
 *   1. ADMIN + mixed-status → byStatus aggregates correct counts + sums
 *   2. Empty result → zeroed envelope shape
 *   3. ?from=ISO + ?to=ISO threads where.createdAt = {gte, lte}
 *   4. ?from=garbage → 400 INVALID_DATE
 *   5. ?to=garbage   → 400 INVALID_DATE
 *   6. Non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant
 *   7. Unauthenticated → 401
 *   8. Sub-brand allow-set EMPTY → zeroed envelope (NOT 403, per #976 fix)
 *   9. Sub-brand allow-set NARROW → where.subBrand = { in: [...] }
 *  10. Tenant isolation — token tenantId=A → where.tenantId=A
 *  11. round2 math — totalAmount=9.005 → grandTotalValue=9.01 (half-up 2dp)
 *  12. acceptanceRate null when no terminal rows; computed when terminal>0
 *
 * Mocking strategy
 * ----------------
 * Patch prisma singleton with vi.fn() shapes BEFORE requiring the router
 * (CJS require — module cache is pinned by the patch). Real verifyToken
 * + requireTravelTenant middleware runs. Real getSubBrandAccessSet runs
 * (user.findUnique controls the access set). HS256 JWTs signed with the
 * dev fallback secret = "enterprise_super_secret_key_2026".
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.itinerary = prisma.itinerary || {};
prisma.itinerary.findMany = vi.fn();
prisma.itinerary.findFirst = prisma.itinerary.findFirst || vi.fn();
prisma.itinerary.count = prisma.itinerary.count || vi.fn();
prisma.itinerary.create = prisma.itinerary.create || vi.fn();
prisma.itinerary.update = prisma.itinerary.update || vi.fn();
prisma.itinerary.delete = prisma.itinerary.delete || vi.fn();
prisma.itineraryItem = prisma.itineraryItem || {};
prisma.itineraryItem.findMany = prisma.itineraryItem.findMany || vi.fn();
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelItinerariesRouter = requireCJS('../../routes/travel_itineraries');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelItinerariesRouter);
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
  prisma.itinerary.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/itineraries/stats', () => {
  test('case 1: ADMIN + mixed-status → byStatus aggregates correctly', async () => {
    // 2 draft (100+200), 1 sent (300), 1 revised (50), 1 accepted (1000),
    // 1 rejected (75), 1 advance_paid (500), 1 fully_paid (700).
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 1, status: 'draft',        totalAmount: 100,  subBrand: 'tmc',         updatedAt: new Date('2026-04-01T00:00:00Z') },
      { id: 2, status: 'draft',        totalAmount: 200,  subBrand: 'tmc',         updatedAt: new Date('2026-04-02T00:00:00Z') },
      { id: 3, status: 'sent',         totalAmount: 300,  subBrand: 'rfu',         updatedAt: new Date('2026-04-05T00:00:00Z') },
      { id: 4, status: 'revised',      totalAmount: 50,   subBrand: 'rfu',         updatedAt: new Date('2026-04-06T00:00:00Z') },
      { id: 5, status: 'accepted',     totalAmount: 1000, subBrand: 'travelstall', updatedAt: new Date('2026-04-10T00:00:00Z') },
      { id: 6, status: 'rejected',     totalAmount: 75,   subBrand: 'travelstall', updatedAt: new Date('2026-04-12T00:00:00Z') },
      { id: 7, status: 'advance_paid', totalAmount: 500,  subBrand: 'visasure',    updatedAt: new Date('2026-04-15T00:00:00Z') },
      { id: 8, status: 'fully_paid',   totalAmount: 700,  subBrand: 'visasure',    updatedAt: new Date('2026-04-20T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(8);
    expect(res.body.byStatus.draft).toEqual({ count: 2, totalValue: 300 });
    expect(res.body.byStatus.sent).toEqual({ count: 1, totalValue: 300 });
    expect(res.body.byStatus.revised).toEqual({ count: 1, totalValue: 50 });
    expect(res.body.byStatus.accepted).toEqual({ count: 1, totalValue: 1000 });
    expect(res.body.byStatus.rejected).toEqual({ count: 1, totalValue: 75 });
    expect(res.body.byStatus.advance_paid).toEqual({ count: 1, totalValue: 500 });
    expect(res.body.byStatus.fully_paid).toEqual({ count: 1, totalValue: 700 });

    // grandTotalValue = 100+200+300+50+1000+75+500+700 = 2925
    expect(res.body.grandTotalValue).toBe(2925);
    // grandAcceptedValue = accepted (1000) + advance_paid (500) + fully_paid (700) = 2200
    expect(res.body.grandAcceptedValue).toBe(2200);
    // bySubBrand: tmc=2, rfu=2, travelstall=2, visasure=2
    expect(res.body.bySubBrand).toEqual({
      tmc:         { count: 2 },
      rfu:         { count: 2 },
      travelstall: { count: 2 },
      visasure:    { count: 2 },
    });
    // acceptanceRate: terminal trio (accepted + advance_paid + fully_paid) = 3;
    // terminal denom = 3 + 1 rejected = 4 → 3/4 = 0.75
    expect(res.body.acceptanceRate).toBe(0.75);
    // lastUpdatedAt = max updatedAt (id=8, 2026-04-20)
    expect(res.body.lastUpdatedAt).toBe(new Date('2026-04-20T00:00:00Z').toISOString());
  });

  test('case 2: empty result → zeroed envelope shape (all 7 statuses zeroed)', async () => {
    prisma.itinerary.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 0,
      byStatus: {
        draft:        { count: 0, totalValue: 0 },
        sent:         { count: 0, totalValue: 0 },
        revised:      { count: 0, totalValue: 0 },
        accepted:     { count: 0, totalValue: 0 },
        rejected:     { count: 0, totalValue: 0 },
        advance_paid: { count: 0, totalValue: 0 },
        fully_paid:   { count: 0, totalValue: 0 },
      },
      grandTotalValue: 0,
      grandAcceptedValue: 0,
      acceptanceRate: null,
      lastUpdatedAt: null,
    });
    expect(res.body.bySubBrand).toEqual({});
  });

  test('case 3: ?from=ISO + ?to=ISO threads where.createdAt = {gte, lte}', async () => {
    prisma.itinerary.findMany.mockResolvedValue([]);

    const from = '2026-01-01T00:00:00Z';
    const to = '2026-12-31T23:59:59Z';
    const res = await request(makeApp())
      .get(`/api/travel/itineraries/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const call = prisma.itinerary.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.createdAt).toBeDefined();
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
    expect(call.where.createdAt.gte.toISOString()).toBe(new Date(from).toISOString());
    expect(call.where.createdAt.lte.toISOString()).toBe(new Date(to).toISOString());
  });

  test('case 4: ?from=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/stats?from=not-a-date-at-all')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test('case 5: ?to=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itineraries/stats?to=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test('case 6: non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Tenant', slug: 'generic',
    });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test('case 7: unauthenticated → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/itineraries/stats');
    expect(res.status).toBe(401);
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test('case 8: sub-brand allow-set EMPTY → zeroed envelope (NOT 403, per #976 fix)', async () => {
    // MANAGER role + subBrandAccess JSON with only-invalid brands → after
    // the VALID_SUB_BRANDS filter the Set is empty → route short-circuits
    // to the zeroed envelope BEFORE the findMany call.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['not-a-valid-brand']),
    });

    const res = await request(makeApp())
      .get('/api/travel/itineraries/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.byStatus.accepted).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.advance_paid).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.acceptanceRate).toBeNull();
    // No findMany call — empty-set short-circuit fires BEFORE prisma.
    expect(prisma.itinerary.findMany).not.toHaveBeenCalled();
  });

  test('case 9: sub-brand allow-set NARROW → where.subBrand = { in: [...] }', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 11, status: 'accepted', totalAmount: 100, subBrand: 'rfu', updatedAt: new Date('2026-04-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.itinerary.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.total).toBe(1);
    expect(res.body.byStatus.accepted).toEqual({ count: 1, totalValue: 100 });
    expect(res.body.bySubBrand).toEqual({ rfu: { count: 1 } });
  });

  test('case 10: tenant isolation — token tenantId=A → where.tenantId=A', async () => {
    const tenantARows = [
      { id: 101, status: 'fully_paid', totalAmount: 50, subBrand: 'tmc', updatedAt: new Date('2026-05-01T00:00:00Z') },
    ];
    prisma.itinerary.findMany.mockResolvedValue(tenantARows);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    const call = prisma.itinerary.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(res.body.total).toBe(1);
    expect(res.body.grandTotalValue).toBe(50);
    // fully_paid rolls up into grandAcceptedValue per PRD §4.7.
    expect(res.body.grandAcceptedValue).toBe(50);
  });

  test('case 11: round2 math — totalAmount=9.005 → grandTotalValue=9.01 (half-up at 2dp)', async () => {
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 91, status: 'accepted', totalAmount: 9.005, subBrand: 'tmc', updatedAt: new Date('2026-04-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Math.round((9.005 + Number.EPSILON) * 100) / 100 = 9.01
    expect(res.body.grandTotalValue).toBe(9.01);
    expect(res.body.grandAcceptedValue).toBe(9.01);
    expect(res.body.byStatus.accepted.totalValue).toBe(9.01);
  });

  test('case 12: acceptanceRate null when zero terminal rows; computed otherwise', async () => {
    // Only non-terminal rows (draft + sent + revised) → terminal denom 0
    // → acceptanceRate must be null (not 0, not NaN).
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 1, status: 'draft',   totalAmount: 100, subBrand: 'tmc', updatedAt: new Date('2026-04-01T00:00:00Z') },
      { id: 2, status: 'sent',    totalAmount: 200, subBrand: 'tmc', updatedAt: new Date('2026-04-02T00:00:00Z') },
      { id: 3, status: 'revised', totalAmount: 50,  subBrand: 'tmc', updatedAt: new Date('2026-04-03T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/itineraries/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.acceptanceRate).toBeNull();
    expect(res.body.grandAcceptedValue).toBe(0);

    // Now add 2 accepted + 1 rejected → terminal=3, accepted-like=2 → 2/3 = 0.67
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 1, status: 'accepted', totalAmount: 100, subBrand: 'tmc', updatedAt: new Date('2026-04-01T00:00:00Z') },
      { id: 2, status: 'accepted', totalAmount: 200, subBrand: 'tmc', updatedAt: new Date('2026-04-02T00:00:00Z') },
      { id: 3, status: 'rejected', totalAmount: 50,  subBrand: 'tmc', updatedAt: new Date('2026-04-03T00:00:00Z') },
    ]);

    const res2 = await request(makeApp())
      .get('/api/travel/itineraries/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res2.status).toBe(200);
    // Math.round((2/3 + EPSILON) * 100) / 100 = 0.67
    expect(res2.body.acceptanceRate).toBe(0.67);
    expect(res2.body.grandAcceptedValue).toBe(300);
  });
});
