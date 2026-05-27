// @ts-check
/**
 * PRD_TRAVEL_TMC §3 microsites — GET /api/travel/microsites/stats
 * tenant-wide microsite rollup.
 *
 * Mirrors travel_suppliers.js /suppliers/stats (#903 slice 23). Anodyne
 * aggregate that powers the Microsites library page's KPI header strip.
 * Pins the contract for the new route handler added at
 * backend/routes/travel_microsites.js (placed BEFORE the
 * /microsites/public/:publicUuid family so the literal-path /stats wins
 * over the UUID-regex-checked public family).
 *
 * What's pinned
 * -------------
 *   - Empty tenant:        zeroed envelope with lastPublishedAt=null and
 *                          lastActivityAt=null.
 *   - Happy path:          3 microsites → counts correct (total,
 *                          published, unpublished, expired, withFaq,
 *                          lastPublishedAt = max(publishedAt),
 *                          lastActivityAt = max(updatedAt)).
 *   - published/unpublished split: publishedAt=null rows are "unpublished".
 *   - Expired bucket:      expiresAt set AND in the past → expired+=1.
 *                          Future expiresAt does NOT count.
 *   - Cross-tenant:        WHERE clause uses req.travelTenant.id (no leak).
 *   - USER-readable:       USER role returns 200 (same contract as
 *                          sibling /stats endpoints).
 *   - Auth gate:           no token → 401.
 *   - ?from / ?to bounds:  ISO-validated; invalid date → 400 INVALID_DATE.
 *                          Valid bounds attached to where.createdAt.
 *
 * Test pattern mirrors travel-supplier-stats.test.js — patch the prisma
 * singleton with vi.fn() shapes BEFORE requiring the router, then drive
 * supertest with HS256 JWTs signed against the dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router so the route handler's
// `require('../lib/prisma')` resolves to the patched singleton.
prisma.tripMicrosite = prisma.tripMicrosite || {};
prisma.tripMicrosite.findMany = vi.fn();
prisma.tripMicrosite.count = vi.fn();
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
const travelMicrositesRouter = requireCJS('../../routes/travel_microsites');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelMicrositesRouter);
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
  prisma.tripMicrosite.findMany.mockReset();
  prisma.tripMicrosite.count.mockReset();
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

describe('GET /api/travel/microsites/stats', () => {
  test('empty tenant → all-zeros envelope', async () => {
    prisma.tripMicrosite.findMany.mockResolvedValue([]);
    prisma.tripMicrosite.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/microsites/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      published: 0,
      unpublished: 0,
      expired: 0,
      withFaq: 0,
      lastPublishedAt: null,
      lastActivityAt: null,
      aggregateExceedsCap: false,
    });
  });

  test('happy path: 3 microsites → counts + timestamps correct', async () => {
    const pub1 = new Date('2026-05-01T10:00:00Z');
    const pub2 = new Date('2026-05-15T10:00:00Z'); // newest publishedAt
    const upd1 = new Date('2026-05-10T10:00:00Z');
    const upd2 = new Date('2026-05-18T10:00:00Z');
    const upd3 = new Date('2026-05-20T10:00:00Z'); // newest updatedAt
    prisma.tripMicrosite.findMany.mockResolvedValue([
      {
        id: 1,
        publishedAt: pub1,
        expiresAt: null,
        faqJson: '{"q":"a"}',
        updatedAt: upd1,
      },
      {
        id: 2,
        publishedAt: pub2,
        expiresAt: null,
        faqJson: null,
        updatedAt: upd2,
      },
      {
        id: 3,
        publishedAt: null, // unpublished
        expiresAt: null,
        faqJson: '   ',     // whitespace → not counted in withFaq
        updatedAt: upd3,
      },
    ]);
    prisma.tripMicrosite.count.mockResolvedValue(3);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/microsites/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.published).toBe(2);
    expect(res.body.unpublished).toBe(1);
    expect(res.body.expired).toBe(0);
    expect(res.body.withFaq).toBe(1); // only ms #1 has non-whitespace faqJson
    expect(res.body.lastPublishedAt).toBe(pub2.toISOString());
    expect(res.body.lastActivityAt).toBe(upd3.toISOString());
    expect(res.body.aggregateExceedsCap).toBe(false);
  });

  test('published/unpublished split: publishedAt=null rows count as unpublished', async () => {
    prisma.tripMicrosite.findMany.mockResolvedValue([
      { id: 1, publishedAt: new Date('2026-05-01T10:00:00Z'), expiresAt: null, faqJson: null, updatedAt: new Date() },
      { id: 2, publishedAt: null, expiresAt: null, faqJson: null, updatedAt: new Date() },
      { id: 3, publishedAt: null, expiresAt: null, faqJson: null, updatedAt: new Date() },
      { id: 4, publishedAt: new Date('2026-05-05T10:00:00Z'), expiresAt: null, faqJson: null, updatedAt: new Date() },
    ]);
    prisma.tripMicrosite.count.mockResolvedValue(4);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/microsites/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.published).toBe(2);
    expect(res.body.unpublished).toBe(2);
  });

  test('expired bucket: only expiresAt set AND in the past counts', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);   // yesterday
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow
    prisma.tripMicrosite.findMany.mockResolvedValue([
      { id: 1, publishedAt: new Date('2026-04-01T10:00:00Z'), expiresAt: past, faqJson: null, updatedAt: new Date() },
      { id: 2, publishedAt: new Date('2026-04-01T10:00:00Z'), expiresAt: past, faqJson: null, updatedAt: new Date() },
      { id: 3, publishedAt: new Date('2026-04-01T10:00:00Z'), expiresAt: future, faqJson: null, updatedAt: new Date() },
      { id: 4, publishedAt: new Date('2026-04-01T10:00:00Z'), expiresAt: null, faqJson: null, updatedAt: new Date() },
    ]);
    prisma.tripMicrosite.count.mockResolvedValue(4);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/microsites/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.expired).toBe(2); // only past-expiresAt
  });

  test('cross-tenant: WHERE clause uses req.travelTenant.id (no leak)', async () => {
    // findMany is mocked to return ONLY the caller's rows; we verify the
    // tenantId was actually scoped at the route layer.
    prisma.tripMicrosite.findMany.mockResolvedValue([
      { id: 1, publishedAt: new Date(), expiresAt: null, faqJson: null, updatedAt: new Date() },
    ]);
    prisma.tripMicrosite.count.mockResolvedValue(1);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/microsites/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const findManyWhere = prisma.tripMicrosite.findMany.mock.calls[0][0].where;
    expect(findManyWhere.tenantId).toBe(1);
    const countWhere = prisma.tripMicrosite.count.mock.calls[0][0].where;
    expect(countWhere.tenantId).toBe(1);
  });

  test('USER role → 200 (anodyne aggregate; matches sibling /stats endpoints)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: null,
    });
    prisma.tripMicrosite.findMany.mockResolvedValue([]);
    prisma.tripMicrosite.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/microsites/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test('auth gate: missing token → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/travel/microsites/stats');
    expect(res.status).toBe(401);
  });

  test('?from/?to ISO bounds: valid dates attach to where.createdAt; invalid → 400 INVALID_DATE', async () => {
    prisma.tripMicrosite.findMany.mockResolvedValue([]);
    prisma.tripMicrosite.count.mockResolvedValue(0);

    const app = makeApp();
    // Valid bounds — should attach gte/lte to where.createdAt
    const res = await request(app)
      .get('/api/travel/microsites/stats?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const findManyWhere = prisma.tripMicrosite.findMany.mock.calls[0][0].where;
    expect(findManyWhere.createdAt).toBeDefined();
    expect(findManyWhere.createdAt.gte).toBeInstanceOf(Date);
    expect(findManyWhere.createdAt.lte).toBeInstanceOf(Date);
    expect(findManyWhere.createdAt.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(findManyWhere.createdAt.lte.toISOString()).toBe('2026-12-31T23:59:59.000Z');

    // Invalid from — 400 INVALID_DATE
    prisma.tripMicrosite.findMany.mockReset();
    prisma.tripMicrosite.count.mockReset();
    const resBad = await request(app)
      .get('/api/travel/microsites/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(resBad.status).toBe(400);
    expect(resBad.body.code).toBe('INVALID_DATE');
  });
});
