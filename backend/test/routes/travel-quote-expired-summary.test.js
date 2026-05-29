// @ts-check
/**
 * #900 — GET /api/travel/quotes/expired-summary actionable rollup.
 *
 * Pins the read-only summary endpoint added to
 * backend/routes/travel_quotes.js:
 *
 *   GET /api/travel/quotes/expired-summary   any verified token
 *
 * Companion to /quotes/expired (full list) + /quotes/stats (single
 * expiredCount aggregate). Returns total + bySubBrand + age-range
 * buckets (0-7d / 8-30d / 31-90d / 90+d) + topCustomers (top-5 by
 * count, tie-break by totalValue desc) + generatedAt ISO timestamp.
 *
 * Response shape:
 *   {
 *     total, totalValue,
 *     bySubBrand: { tmc|rfu|...|_tenant: {count, value} },
 *     byAgeRange: { "0-7d"|"8-30d"|"31-90d"|"90+d": {count, value} },
 *     topCustomers: [ { contactId, count, totalValue }, ... ],
 *     generatedAt,
 *   }
 *
 * Contracts asserted:
 *   - Empty tenant (no quotes) → all-zeros shape, empty bySubBrand,
 *     four age buckets present at {count:0, value:0}, empty topCustomers.
 *   - Happy path: 4-quote mix across sub-brands + age ranges → correct
 *     total + totalValue + per-bucket counts/values.
 *   - byAgeRange bucketing: explicit boundaries (0-7d / 8-30d / 31-90d /
 *     90+d) all populated correctly given mixed expiry ages.
 *   - topCustomers: sorted desc by count, limited to 5, tie-break by
 *     totalValue desc; contactId anonymisation (no name leaked).
 *   - MANAGER subBrandAccess=['rfu'] narrows Prisma where.subBrand
 *     BEFORE aggregation.
 *   - USER role → 200 (anodyne aggregate; no role gate).
 *   - 401 on missing token (verifyToken gate).
 *   - Defensive: null validUntil rows are skipped (not "expired" without
 *     an expiry policy); null totalAmount → 0 (no NaN poisoning).
 *
 * Pattern mirrors travel-quote-stats.test.js — CJS prisma singleton
 * patched BEFORE the router is required so verifyToken's revokedToken
 * probe + the route's findMany call both hit stubs; HS256 JWT via the
 * dev fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelQuote = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelQuoteLine = prisma.travelQuoteLine || {
  findMany: vi.fn(),
  findFirst: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
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
const travelQuotesRouter = requireCJS('../../routes/travel_quotes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelQuotesRouter);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Helper: a Date N days ago.
function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000);
}

function makeQuote(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    status: 'Sent',
    contactId: 1,
    totalAmount: '1000.00',
    currency: 'INR',
    validUntil: daysAgo(3),
    updatedAt: new Date(Date.UTC(2026, 4, 1)),
    createdAt: new Date(Date.UTC(2026, 4, 1)),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelQuote.findMany.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/quotes/expired-summary — empty tenant', () => {
  test('no expired quotes → all-zeros shape', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.totalValue).toBe(0);
    expect(res.body.bySubBrand).toEqual({});
    expect(res.body.byAgeRange).toEqual({
      '0-7d': { count: 0, value: 0 },
      '8-30d': { count: 0, value: 0 },
      '31-90d': { count: 0, value: 0 },
      '90+d': { count: 0, value: 0 },
    });
    expect(res.body.topCustomers).toEqual([]);
    expect(typeof res.body.generatedAt).toBe('string');
    expect(() => new Date(res.body.generatedAt).toISOString()).not.toThrow();
  });
});

describe('GET /api/travel/quotes/expired-summary — happy path', () => {
  test('4 expired quotes mix of sub-brands + ages → correct totals + buckets', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      // 3 days ago → 0-7d bucket, tmc, contact 1
      makeQuote({ id: 1, subBrand: 'tmc', contactId: 1, validUntil: daysAgo(3), totalAmount: '1000.00' }),
      // 15 days ago → 8-30d bucket, rfu, contact 2
      makeQuote({ id: 2, subBrand: 'rfu', contactId: 2, validUntil: daysAgo(15), totalAmount: '2000.00' }),
      // 60 days ago → 31-90d bucket, tmc, contact 1
      makeQuote({ id: 3, subBrand: 'tmc', contactId: 1, validUntil: daysAgo(60), totalAmount: '500.00' }),
      // 120 days ago → 90+d bucket, visasure, contact 3
      makeQuote({ id: 4, subBrand: 'visasure', contactId: 3, validUntil: daysAgo(120), totalAmount: '750.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.totalValue).toBe(4250);
    // bySubBrand counts + values
    expect(res.body.bySubBrand.tmc).toEqual({ count: 2, value: 1500 });
    expect(res.body.bySubBrand.rfu).toEqual({ count: 1, value: 2000 });
    expect(res.body.bySubBrand.visasure).toEqual({ count: 1, value: 750 });
  });
});

describe('GET /api/travel/quotes/expired-summary — byAgeRange bucketing', () => {
  test('explicit boundaries: 0-7d / 8-30d / 31-90d / 90+d all populated', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      // 0-7d bucket (3d, 7d edge)
      makeQuote({ id: 1, validUntil: daysAgo(3), totalAmount: '100.00', contactId: 11 }),
      makeQuote({ id: 2, validUntil: daysAgo(7), totalAmount: '200.00', contactId: 12 }),
      // 8-30d bucket (8d edge, 30d edge)
      makeQuote({ id: 3, validUntil: daysAgo(8), totalAmount: '300.00', contactId: 13 }),
      makeQuote({ id: 4, validUntil: daysAgo(30), totalAmount: '400.00', contactId: 14 }),
      // 31-90d bucket (31d edge, 90d edge)
      makeQuote({ id: 5, validUntil: daysAgo(31), totalAmount: '500.00', contactId: 15 }),
      makeQuote({ id: 6, validUntil: daysAgo(90), totalAmount: '600.00', contactId: 16 }),
      // 90+d bucket (91d, 365d)
      makeQuote({ id: 7, validUntil: daysAgo(91), totalAmount: '700.00', contactId: 17 }),
      makeQuote({ id: 8, validUntil: daysAgo(365), totalAmount: '800.00', contactId: 18 }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byAgeRange['0-7d']).toEqual({ count: 2, value: 300 });
    expect(res.body.byAgeRange['8-30d']).toEqual({ count: 2, value: 700 });
    expect(res.body.byAgeRange['31-90d']).toEqual({ count: 2, value: 1100 });
    expect(res.body.byAgeRange['90+d']).toEqual({ count: 2, value: 1500 });
    expect(res.body.total).toBe(8);
    expect(res.body.totalValue).toBe(3600);
  });
});

describe('GET /api/travel/quotes/expired-summary — topCustomers ranking', () => {
  test('sorted desc by count, limited to 5, tie-break by totalValue desc', async () => {
    // 7 distinct customers; the top-5 by count must surface in order.
    prisma.travelQuote.findMany.mockResolvedValue([
      // contact 100 → 4 quotes
      makeQuote({ id: 1, contactId: 100, totalAmount: '100.00' }),
      makeQuote({ id: 2, contactId: 100, totalAmount: '100.00' }),
      makeQuote({ id: 3, contactId: 100, totalAmount: '100.00' }),
      makeQuote({ id: 4, contactId: 100, totalAmount: '100.00' }),
      // contact 200 → 3 quotes
      makeQuote({ id: 5, contactId: 200, totalAmount: '200.00' }),
      makeQuote({ id: 6, contactId: 200, totalAmount: '200.00' }),
      makeQuote({ id: 7, contactId: 200, totalAmount: '200.00' }),
      // contact 300 → 2 quotes, value 5000 each (tie with 400 on count)
      makeQuote({ id: 8, contactId: 300, totalAmount: '5000.00' }),
      makeQuote({ id: 9, contactId: 300, totalAmount: '5000.00' }),
      // contact 400 → 2 quotes, value 100 each (tie with 300, loses on totalValue)
      makeQuote({ id: 10, contactId: 400, totalAmount: '100.00' }),
      makeQuote({ id: 11, contactId: 400, totalAmount: '100.00' }),
      // contact 500 → 1 quote
      makeQuote({ id: 12, contactId: 500, totalAmount: '50.00' }),
      // contact 600 → 1 quote (loses on totalValue tie-break to 500)
      makeQuote({ id: 13, contactId: 600, totalAmount: '10.00' }),
      // contact 700 → 1 quote (cut off at top-5)
      makeQuote({ id: 14, contactId: 700, totalAmount: '5.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.topCustomers).toHaveLength(5);
    expect(res.body.topCustomers[0]).toEqual({ contactId: 100, count: 4, totalValue: 400 });
    expect(res.body.topCustomers[1]).toEqual({ contactId: 200, count: 3, totalValue: 600 });
    // contact 300 ties with 400 on count(=2) but wins on totalValue(10000 vs 200)
    expect(res.body.topCustomers[2]).toEqual({ contactId: 300, count: 2, totalValue: 10000 });
    expect(res.body.topCustomers[3]).toEqual({ contactId: 400, count: 2, totalValue: 200 });
    // contact 500 ties with 600 on count(=1) but wins on totalValue(50 vs 10)
    expect(res.body.topCustomers[4]).toEqual({ contactId: 500, count: 1, totalValue: 50 });
    // No name field leaked; only contactId + counts.
    for (const c of res.body.topCustomers) {
      expect(Object.keys(c).sort()).toEqual(['contactId', 'count', 'totalValue']);
    }
  });
});

describe('GET /api/travel/quotes/expired-summary — sub-brand narrowing', () => {
  test('MANAGER with subBrandAccess=["rfu"] narrows Prisma where.subBrand', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    let capturedWhere = null;
    prisma.travelQuote.findMany.mockImplementation(async ({ where }) => {
      capturedWhere = where;
      const all = [
        makeQuote({ id: 1, subBrand: 'tmc', contactId: 1, totalAmount: '1000.00', validUntil: daysAgo(5) }),
        makeQuote({ id: 2, subBrand: 'rfu', contactId: 2, totalAmount: '8000.00', validUntil: daysAgo(10) }),
        makeQuote({ id: 3, subBrand: 'travelstall', contactId: 3, totalAmount: '2000.00', validUntil: daysAgo(15) }),
      ];
      if (where && where.subBrand && where.subBrand.in) {
        return all.filter((q) => where.subBrand.in.includes(q.subBrand));
      }
      return all;
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(capturedWhere).toBeTruthy();
    expect(capturedWhere.subBrand).toEqual({ in: ['rfu'] });
    expect(capturedWhere.tenantId).toBe(1);
    expect(capturedWhere.status).toEqual({ in: ['Draft', 'Sent'] });
    expect(res.body.total).toBe(1);
    expect(res.body.bySubBrand.rfu).toEqual({ count: 1, value: 8000 });
    expect(res.body.bySubBrand.tmc).toBeUndefined();
    expect(res.body.bySubBrand.travelstall).toBeUndefined();
  });
});

describe('GET /api/travel/quotes/expired-summary — USER role allowed', () => {
  test('USER role → 200 (anodyne aggregate, no role gate)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, contactId: 1, totalAmount: '1000.00', validUntil: daysAgo(5) }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.totalValue).toBe(1000);
  });
});

describe('GET /api/travel/quotes/expired-summary — auth gate', () => {
  test('401 on missing token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/expired-summary');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/travel/quotes/expired-summary — defensive null handling', () => {
  test('null validUntil rows skipped; null totalAmount → 0', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      // Real expired quote — should be counted.
      makeQuote({ id: 1, contactId: 1, validUntil: daysAgo(5), totalAmount: '1000.00' }),
      // Null validUntil — must be skipped (route filter says validUntil < now,
      // but the mock returns whatever it likes; the route must defend).
      makeQuote({ id: 2, contactId: 2, validUntil: null, totalAmount: '5000.00' }),
      // Null totalAmount — counted but contributes 0 to the sum.
      makeQuote({ id: 3, contactId: 3, validUntil: daysAgo(10), totalAmount: null }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/expired-summary')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Two quotes counted (id 1 + id 3); id 2 skipped on null validUntil.
    expect(res.body.total).toBe(2);
    expect(Number.isNaN(res.body.totalValue)).toBe(false);
    expect(res.body.totalValue).toBe(1000);
    // topCustomers reflects the two counted contacts.
    const contactIds = res.body.topCustomers.map((c) => c.contactId).sort((a, b) => a - b);
    expect(contactIds).toEqual([1, 3]);
  });
});
