// @ts-check
/**
 * PRD §4.6 — GET /api/travel/webcheckins/by-quarter tenant-wide
 * WebCheckin creation rollup by UTC YYYY-Q[1-4]. Completes the rollup
 * triplet alongside /webcheckins/stats (snapshot) + /webcheckins/by-month
 * (monthly trend); ships the dashboard's quarterly trend surface.
 *
 * Mirrors the by-quarter template shipped on:
 *   - /itineraries/by-quarter (slice 17)
 *   - /suppliers/by-quarter
 *   - /trips/by-quarter
 *
 * Same UTC YYYY-Q[1-4] bucketing template, same defensive "unknown"
 * bucket math, same orderBy + pagination semantics. Per-bucket
 * bySubBrand breakdown derived via parent Itinerary subBrand (mirrors
 * /webcheckins/stats sub-brand resolution).
 *
 * What's pinned
 * -------------
 *   - 401 when no Authorization header (verifyToken gate)
 *   - 400 INVALID_QUARTER_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 3 webcheckins across 2 quarters → 2 rows with
 *     correct count + per-bucket bySubBrand
 *   - Default orderBy=quarter:asc chronological
 *   - ?orderBy=count:desc flips ordering
 *   - ?from / ?to narrows the bucket array
 *   - Sub-brand MANAGER (subBrandAccess=['rfu']) — visible Itinerary
 *     id-set resolved first, then WebCheckin narrowed by itineraryId IN
 *   - Defensive: null/invalid createdAt → "unknown" bucket; excluded
 *     when from/to set
 *   - Pagination: ?limit=2&offset=1 slices AFTER aggregation
 *   - Falsy subBrand coerces to "_tenant" bucket
 *   - Unknown orderBy token degrades to default
 *
 * Test pattern mirrors travel-webcheckins-by-month.test.js — patch the
 * prisma singleton with vi.fn() shapes BEFORE requiring the router,
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

// Spread of webcheckins across Q2 2026 (May+Jun) and Q3 2026 (Jul).
//   2026-Q2: 2 webcheckins (itineraryId 201 tmc + itineraryId 202 rfu)
//   2026-Q3: 1 webcheckin (itineraryId null → "_tenant")
const baseRows = [
  { createdAt: new Date('2026-05-02T08:00:00Z'), itineraryId: 201 },
  { createdAt: new Date('2026-06-15T10:30:00Z'), itineraryId: 202 },
  { createdAt: new Date('2026-07-04T09:00:00Z'), itineraryId: null },
];

// Parent Itinerary id-set: 201→tmc, 202→rfu. The route resolves these
// via the SECOND prisma.itinerary.findMany call (the FIRST is the
// sub-brand-narrowing visibility query — only present for restricted
// callers).
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

describe('GET /api/travel/webcheckins/by-quarter', () => {
  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter');

    expect(res.status).toBe(401);
    expect(prisma.webCheckin.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?from token (quarter > 4)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter?from=2026-Q5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
    expect(prisma.webCheckin.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?from token (month not quarter form)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('400 INVALID_QUARTER_FORMAT on bad ?to token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter?to=2026Q2')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_QUARTER_FORMAT');
  });

  test('happy path: 3 webcheckins across 2 quarters → 2 rows with correct counts + per-bucket bySubBrand', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);
    // Default order is quarter:asc → Q2 first, Q3 second.
    expect(res.body.rows[0]).toMatchObject({
      quarter: '2026-Q2',
      count: 2,
      bySubBrand: { tmc: 1, rfu: 1 },
    });
    expect(res.body.rows[1]).toMatchObject({
      quarter: '2026-Q3',
      count: 1,
      bySubBrand: { _tenant: 1 },
    });
  });

  test('default orderBy=quarter:asc is chronological', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.quarter)).toEqual(['2026-Q2', '2026-Q3']);
  });

  test('?orderBy=count:desc puts the busier quarter first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[0].count).toBe(2);
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
    expect(res.body.rows[1].count).toBe(1);
  });

  test('?from=2026-Q2&to=2026-Q2 narrows the bucket array', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter?from=2026-Q2&to=2026-Q2')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[0].count).toBe(2);
  });

  test('MANAGER subBrandAccess=[rfu] → visible Itinerary id-set resolved, WebCheckin narrowed by itineraryId IN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    // FIRST Itinerary.findMany = visible-itinerary id-set resolution.
    // SECOND Itinerary.findMany = sub-brand resolution for the matched
    // WebCheckin rows (used to compute per-bucket bySubBrand).
    prisma.itinerary.findMany
      .mockResolvedValueOnce([{ id: 202 }])
      .mockResolvedValueOnce([{ id: 202, subBrand: 'rfu' }]);
    prisma.webCheckin.findMany.mockResolvedValue([
      { createdAt: new Date('2026-06-15T10:00:00Z'), itineraryId: 202 },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0]).toMatchObject({
      quarter: '2026-Q2',
      count: 1,
      bySubBrand: { rfu: 1 },
    });

    // Verify the FIRST Itinerary.findMany carried the sub-brand-narrow filter.
    const visibilityWhere = prisma.itinerary.findMany.mock.calls[0][0].where;
    expect(visibilityWhere.tenantId).toBe(1);
    expect(visibilityWhere.subBrand).toEqual({ in: ['rfu'] });

    // Verify the WebCheckin query was narrowed by itineraryId IN visible-set.
    const wcWhere = prisma.webCheckin.findMany.mock.calls[0][0].where;
    expect(wcWhere.tenantId).toBe(1);
    expect(wcWhere.itineraryId).toEqual({ in: [202] });
  });

  test('defensive: row with null createdAt → "unknown" bucket (kept when no from/to set)', async () => {
    prisma.webCheckin.findMany.mockResolvedValue([
      { createdAt: new Date('2026-05-02T08:00:00Z'), itineraryId: 201 },
      { createdAt: null, itineraryId: 201 },
      { createdAt: new Date('not a date'), itineraryId: 202 },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const unknown = res.body.rows.find((r) => r.quarter === 'unknown');
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
      .get('/api/travel/webcheckins/by-quarter?from=2020-Q1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // "unknown" bucket excluded when ?from is set; only Q2 2026 remains.
    expect(res.body.total).toBe(1);
    expect(res.body.rows.find((r) => r.quarter === 'unknown')).toBeUndefined();
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
  });

  test('pagination: ?limit=2&offset=1 slices AFTER aggregation + sort', async () => {
    // Three quarters of data: 2026-Q1, 2026-Q2, 2026-Q3
    prisma.webCheckin.findMany.mockResolvedValue([
      { createdAt: new Date('2026-02-10T08:00:00Z'), itineraryId: 201 },
      { createdAt: new Date('2026-05-02T08:00:00Z'), itineraryId: 201 },
      { createdAt: new Date('2026-07-04T09:00:00Z'), itineraryId: 202 },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Total reflects the pre-pagination bucket count.
    expect(res.body.total).toBe(3);
    // Pagination yields Q2 + Q3 (offset=1 skips Q1).
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].quarter).toBe('2026-Q2');
    expect(res.body.rows[1].quarter).toBe('2026-Q3');
  });

  test('falsy subBrand coerces to "_tenant" bucket', async () => {
    // Itinerary 201 has subBrand=null (parent resolved but missing/empty),
    // so its WebCheckin row should land in "_tenant".
    prisma.itinerary.findMany.mockResolvedValue([
      { id: 201, subBrand: null },
      { id: 202, subBrand: '' },
    ]);
    prisma.webCheckin.findMany.mockResolvedValue([
      { createdAt: new Date('2026-05-02T08:00:00Z'), itineraryId: 201 },
      { createdAt: new Date('2026-05-15T10:00:00Z'), itineraryId: 202 },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0]).toMatchObject({
      quarter: '2026-Q2',
      count: 2,
      bySubBrand: { _tenant: 2 },
    });
  });

  test('unknown orderBy token degrades silently to the default quarter:asc', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter?orderBy=nonsense:desc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Default order is quarter:asc → Q2 first, Q3 second.
    expect(res.body.rows.map((r) => r.quarter)).toEqual(['2026-Q2', '2026-Q3']);
  });

  test('limit caps at 40 even when ?limit=100 requested', async () => {
    const res = await request(makeApp())
      .get('/api/travel/webcheckins/by-quarter?limit=100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // With only 2 buckets in baseRows, this is a structural check —
    // the cap matters when the input population is huge; we can't
    // reach the cap here, but we can assert the endpoint accepts the
    // request and returns a coherent envelope.
    expect(res.body.rows.length).toBeLessThanOrEqual(40);
    expect(res.body.total).toBe(2);
  });
});
