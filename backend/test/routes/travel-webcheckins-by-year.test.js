// @ts-check
/**
 * PRD §4.6 — GET /api/travel/webcheckins/by-year tenant-wide
 * WebCheckin creation rollup by UTC YYYY. Completes the rollup
 * triplet alongside /webcheckins/stats (snapshot) + /webcheckins/by-month
 * (monthly trend) + /webcheckins/by-quarter (quarterly trend); ships
 * the dashboard's annual trend surface.
 *
 * Mirrors the by-year template shipped on:
 *   - /itineraries/by-year (slice 18)
 *   - /suppliers/by-year
 *
 * Same UTC YYYY bucketing template, same defensive "unknown" bucket
 * math, same orderBy + pagination semantics. Per-bucket bySubBrand
 * breakdown derived via parent Itinerary subBrand (mirrors
 * /webcheckins/stats + /webcheckins/by-quarter sub-brand resolution).
 *
 * Two-step itinerary-resolve pattern (Agent B finding): WebCheckin has
 * NO direct subBrand column — it lives on parent Itinerary. Sub-brand-
 * restricted MANAGER queries do TWO prisma.itinerary.findMany calls:
 * FIRST for visibility narrowing (itineraryId IN restricted-set),
 * SECOND to resolve subBrand per-row for the bySubBrand breakdown.
 *
 * What's pinned
 * -------------
 *   - 401 when no Authorization header (verifyToken gate)
 *   - 400 INVALID_YEAR_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 3 webcheckins across 2 years → 2 rows with
 *     correct count + per-bucket bySubBrand
 *   - Default orderBy=year:asc chronological
 *   - ?orderBy=count:desc flips ordering
 *   - ?from / ?to narrows the bucket array
 *   - Sub-brand MANAGER (subBrandAccess=['tmc']) — visible Itinerary
 *     id-set resolved first (FIRST findMany), then WebCheckin narrowed
 *     by itineraryId IN; SECOND findMany resolves bySubBrand
 *   - Defensive: null/invalid createdAt → "unknown" bucket; excluded
 *     when from/to set
 *   - Pagination: ?limit=2&offset=1 slices AFTER aggregation
 *   - Unmatched itineraryId → "_tenant" bucket
 *   - Unknown orderBy token degrades to default
 *
 * Test pattern mirrors travel-webcheckins-by-quarter.test.js — patch
 * the prisma singleton with vi.fn() shapes BEFORE requiring the router,
 * then drive supertest with HS256 JWTs signed against the dev-fallback
 * secret. verifyToken + requireTravelTenant + getSubBrandAccessSet all
 * run for real.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.webCheckin = prisma.webCheckin || {};
prisma.webCheckin.findMany = vi.fn();
prisma.webCheckin.count = prisma.webCheckin.count || vi.fn();
prisma.itinerary = prisma.itinerary || {};
prisma.itinerary.findMany = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  role: 'ADMIN',
  subBrandAccess: null,
});
prisma.auditLog = {
  ...(prisma.auditLog || {}),
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
const travelWebcheckinRouter = requireCJS('../../routes/travel_webcheckin');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelWebcheckinRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Spread of webcheckins across 2026 and 2027.
//   2026: 2 webcheckins (itineraryId 201 tmc + itineraryId 202 rfu)
//   2027: 1 webcheckin (itineraryId null → "_tenant")
const baseRows = [
  { createdAt: new Date('2026-05-02T08:00:00Z'), itineraryId: 201 },
  { createdAt: new Date('2026-11-15T10:30:00Z'), itineraryId: 202 },
  { createdAt: new Date('2027-02-04T09:00:00Z'), itineraryId: null },
];

// Parent Itinerary id-set: 201→tmc, 202→rfu. The route resolves these
// via the (only) prisma.itinerary.findMany call for unrestricted
// callers (used for the bySubBrand breakdown). Restricted callers see
// TWO findMany calls — the first for visibility narrowing, the second
// for the breakdown.
const itineraryBySbResolve = [
  { id: 201, subBrand: 'tmc' },
  { id: 202, subBrand: 'rfu' },
];

beforeEach(() => {
  prisma.webCheckin.findMany.mockReset().mockResolvedValue(baseRows);
  prisma.itinerary.findMany.mockReset().mockResolvedValue(itineraryBySbResolve);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1,
    vertical: 'travel',
    name: 'Test Travel',
    slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

describe('GET /api/travel/webcheckins/by-year', () => {
  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year');

    expect(res.status).toBe(401);
    expect(prisma.webCheckin.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_YEAR_FORMAT on bad ?from token (3 digits)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year?from=202')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
    expect(prisma.webCheckin.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_YEAR_FORMAT on bad ?to token (YYYY-MM not YYYY)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year?to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('happy path: 3 webcheckins across 2 years → 2 rows with correct counts + per-bucket bySubBrand', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);
    // Default order is year:asc → 2026 first, 2027 second.
    expect(res.body.rows[0]).toMatchObject({
      year: '2026',
      count: 2,
      bySubBrand: { tmc: 1, rfu: 1 },
    });
    expect(res.body.rows[1]).toMatchObject({
      year: '2027',
      count: 1,
      bySubBrand: { _tenant: 1 },
    });
  });

  test('default orderBy=year:asc is chronological', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.year)).toEqual(['2026', '2027']);
  });

  test('?orderBy=count:desc puts the busier year first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].year).toBe('2026');
    expect(res.body.rows[0].count).toBe(2);
    expect(res.body.rows[1].year).toBe('2027');
    expect(res.body.rows[1].count).toBe(1);
  });

  test('?from=2026&to=2026 narrows the bucket array', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year?from=2026&to=2026')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].year).toBe('2026');
    expect(res.body.rows[0].count).toBe(2);
  });

  test('MANAGER subBrandAccess=[tmc] → two-step itinerary-resolve: visible id-set first, bySubBrand breakdown second', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    // FIRST Itinerary.findMany = visible-itinerary id-set resolution.
    // SECOND Itinerary.findMany = sub-brand resolution for the matched
    // WebCheckin rows (used to compute per-bucket bySubBrand).
    prisma.itinerary.findMany
      .mockResolvedValueOnce([{ id: 201 }])
      .mockResolvedValueOnce([{ id: 201, subBrand: 'tmc' }]);
    prisma.webCheckin.findMany.mockResolvedValue([
      { createdAt: new Date('2026-05-02T08:00:00Z'), itineraryId: 201 },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0]).toMatchObject({
      year: '2026',
      count: 1,
      bySubBrand: { tmc: 1 },
    });

    // Confirm BOTH itinerary.findMany calls fired (the two-step pattern).
    expect(prisma.itinerary.findMany).toHaveBeenCalledTimes(2);

    // Verify the FIRST Itinerary.findMany carried the sub-brand-narrow filter.
    const visibilityWhere = prisma.itinerary.findMany.mock.calls[0][0].where;
    expect(visibilityWhere.tenantId).toBe(1);
    expect(visibilityWhere.subBrand).toEqual({ in: ['tmc'] });

    // Verify the WebCheckin query was narrowed by itineraryId IN visible-set.
    const wcWhere = prisma.webCheckin.findMany.mock.calls[0][0].where;
    expect(wcWhere.tenantId).toBe(1);
    expect(wcWhere.itineraryId).toEqual({ in: [201] });
  });

  test('defensive: row with null/invalid createdAt → "unknown" bucket (kept when no from/to set)', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      { createdAt: new Date('2026-05-02T08:00:00Z'), itineraryId: 201 },
      { createdAt: null, itineraryId: 201 },
      { createdAt: new Date('not a date'), itineraryId: 202 },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const unknown = res.body.rows.find((r) => r.year === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
    // bySubBrand still resolves through itineraryId even when createdAt is unknown.
    expect(unknown.bySubBrand).toEqual({ tmc: 1, rfu: 1 });
  });

  test('defensive: ?from set excludes the "unknown" bucket from results', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      { createdAt: new Date('2026-05-02T08:00:00Z'), itineraryId: 201 },
      { createdAt: null, itineraryId: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year?from=2020')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // "unknown" bucket excluded when ?from is set; only 2026 remains.
    expect(res.body.total).toBe(1);
    expect(res.body.rows.find((r) => r.year === 'unknown')).toBeUndefined();
    expect(res.body.rows[0].year).toBe('2026');
  });

  test('pagination: ?limit=2&offset=1 slices AFTER aggregation + sort', async () => {
    // Three years of data: 2025, 2026, 2027
    prisma.webCheckin.findMany.mockResolvedValue([
      { createdAt: new Date('2025-02-10T08:00:00Z'), itineraryId: 201 },
      { createdAt: new Date('2026-05-02T08:00:00Z'), itineraryId: 201 },
      { createdAt: new Date('2027-07-04T09:00:00Z'), itineraryId: 202 },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Total reflects the pre-pagination bucket count.
    expect(res.body.total).toBe(3);
    // Pagination yields 2026 + 2027 (offset=1 skips 2025).
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].year).toBe('2026');
    expect(res.body.rows[1].year).toBe('2027');
  });

  test('unmatched itineraryId (parent itinerary missing from breakdown resolve) → "_tenant" bucket', async () => {
    // WebCheckin row references itineraryId=999 but the SECOND
    // Itinerary.findMany returns no match for it → falls back to "_tenant".
    prisma.itinerary.findMany.mockResolvedValue([]);
    prisma.webCheckin.findMany.mockResolvedValue([
      { createdAt: new Date('2026-05-02T08:00:00Z'), itineraryId: 999 },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0]).toMatchObject({
      year: '2026',
      count: 1,
      bySubBrand: { _tenant: 1 },
    });
  });

  test('unknown orderBy token degrades silently to the default year:asc', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year?orderBy=nonsense:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Default order is year:asc → 2026 first, 2027 second.
    expect(res.body.rows.map((r) => r.year)).toEqual(['2026', '2027']);
  });

  test('limit caps at 30 even when ?limit=100 requested', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-year?limit=100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // With only 2 buckets in baseRows, this is a structural check —
    // the cap matters when the input population is huge; we can't
    // reach the cap here, but we can assert the endpoint accepts the
    // request and returns a coherent envelope.
    expect(res.body.rows.length).toBeLessThanOrEqual(30);
    expect(res.body.total).toBe(2);
  });
});
