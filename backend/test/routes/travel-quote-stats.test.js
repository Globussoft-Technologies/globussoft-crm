// @ts-check
/**
 * #900 slice 19 — GET /api/travel/quotes/stats tenant-wide rollup.
 *
 * Pins the read-only point-in-time KPI-tile endpoint added to
 * backend/routes/travel_quotes.js:
 *
 *   GET /api/travel/quotes/stats     any verified token
 *
 * Mirrors #903 slice 23 (/suppliers/stats), #905 slice 18
 * (/commission-profiles/stats) and #908 slice 19
 * (/flyer-templates/global-stats) — same KPI shape:
 *
 *   {
 *     total,
 *     byStatus: { Draft|Sent|Accepted|Rejected: {count, totalValue} },
 *     bySubBrand: { tmc|rfu|...|_tenant: {count} },
 *     grandTotalValue, grandAcceptedValue,
 *     acceptanceRate,        // accepted / (accepted + rejected); null if denom=0
 *     expiredCount,          // status IN (Draft, Sent) AND validUntil < now
 *     lastUpdatedAt,
 *   }
 *
 * Contracts asserted:
 *   - Empty tenant (no quotes) → zeroed shape with acceptanceRate=null,
 *     expiredCount=0, all byStatus buckets present at {count:0,totalValue:0}.
 *   - Happy path: 4-quote mix (Draft/Sent/Accepted/Rejected) → correct
 *     per-status counts + sums + grandTotalValue + grandAcceptedValue +
 *     acceptanceRate.
 *   - Cross-tenant: where.tenantId narrows aggregation — Prisma findMany
 *     filter contains the caller's tenantId, not the row's tenantId.
 *   - MANAGER subBrandAccess=['rfu'] narrows the Prisma where.subBrand
 *     to `{ in: ['rfu'] }` BEFORE aggregation.
 *   - USER role → 200 (anodyne aggregate, USER-readable; no role gate).
 *   - 401 on missing token (verifyToken gate).
 *   - expiredCount: 1 Sent quote with validUntil past → counted; Accepted
 *     with validUntil past → NOT counted (terminal state); Draft with
 *     future validUntil → NOT counted.
 *   - acceptanceRate: 2 Accepted + 1 Rejected → 0.67 (half-up 2dp).
 *
 * Pattern mirrors travel-quote-by-quarter.test.js — CJS prisma singleton
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

function makeQuote(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    status: 'Draft',
    totalAmount: '10000.00',
    currency: 'INR',
    validUntil: null,
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

describe('GET /api/travel/quotes/stats — empty tenant', () => {
  test('no quotes → all-zeros shape with acceptanceRate=null', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.byStatus.Draft).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Sent).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Accepted).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Rejected).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.bySubBrand).toEqual({});
    expect(res.body.grandTotalValue).toBe(0);
    expect(res.body.grandAcceptedValue).toBe(0);
    expect(res.body.acceptanceRate).toBeNull();
    expect(res.body.expiredCount).toBe(0);
    expect(res.body.lastUpdatedAt).toBeNull();
  });
});

describe('GET /api/travel/quotes/stats — happy path', () => {
  test('4 quotes (Draft/Sent/Accepted/Rejected) → correct buckets + sums + acceptanceRate', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, status: 'Draft', totalAmount: '1000.00', subBrand: 'tmc' }),
      makeQuote({ id: 2, status: 'Sent', totalAmount: '2000.00', subBrand: 'rfu' }),
      makeQuote({ id: 3, status: 'Accepted', totalAmount: '5000.00', subBrand: 'tmc' }),
      makeQuote({ id: 4, status: 'Rejected', totalAmount: '500.00', subBrand: 'visasure' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.byStatus.Draft).toEqual({ count: 1, totalValue: 1000 });
    expect(res.body.byStatus.Sent).toEqual({ count: 1, totalValue: 2000 });
    expect(res.body.byStatus.Accepted).toEqual({ count: 1, totalValue: 5000 });
    expect(res.body.byStatus.Rejected).toEqual({ count: 1, totalValue: 500 });
    expect(res.body.grandTotalValue).toBe(8500);
    expect(res.body.grandAcceptedValue).toBe(5000);
    // 1 Accepted / (1 Accepted + 1 Rejected) = 0.5
    expect(res.body.acceptanceRate).toBe(0.5);
    expect(res.body.bySubBrand.tmc).toEqual({ count: 2 });
    expect(res.body.bySubBrand.rfu).toEqual({ count: 1 });
    expect(res.body.bySubBrand.visasure).toEqual({ count: 1 });
  });
});

describe('GET /api/travel/quotes/stats — cross-tenant isolation', () => {
  test('Prisma findMany where.tenantId is the caller token tenant, not arbitrary', async () => {
    let capturedWhere = null;
    prisma.travelQuote.findMany.mockImplementation(async ({ where }) => {
      capturedWhere = where;
      // Return only the caller-tenant rows (simulating Prisma).
      return [];
    });
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    expect(capturedWhere).toBeTruthy();
    expect(capturedWhere.tenantId).toBe(1);
    expect(res.body.total).toBe(0);
  });
});

describe('GET /api/travel/quotes/stats — sub-brand narrowing', () => {
  test('MANAGER with subBrandAccess=["rfu"] sees only rfu quotes', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });

    let capturedWhere = null;
    prisma.travelQuote.findMany.mockImplementation(async ({ where }) => {
      capturedWhere = where;
      const all = [
        makeQuote({ id: 1, subBrand: 'tmc', status: 'Accepted', totalAmount: '1000.00' }),
        makeQuote({ id: 2, subBrand: 'rfu', status: 'Accepted', totalAmount: '8000.00' }),
        makeQuote({ id: 3, subBrand: 'travelstall', status: 'Draft', totalAmount: '2000.00' }),
      ];
      if (where && where.subBrand && where.subBrand.in) {
        return all.filter((q) => where.subBrand.in.includes(q.subBrand));
      }
      return all;
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(capturedWhere).toBeTruthy();
    expect(capturedWhere.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.total).toBe(1);
    expect(res.body.bySubBrand.rfu).toEqual({ count: 1 });
    expect(res.body.bySubBrand.tmc).toBeUndefined();
    expect(res.body.bySubBrand.travelstall).toBeUndefined();
    expect(res.body.grandAcceptedValue).toBe(8000);
  });
});

describe('GET /api/travel/quotes/stats — USER role allowed', () => {
  test('USER role → 200 (anodyne aggregate, no role gate)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, status: 'Sent', totalAmount: '1000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });
});

describe('GET /api/travel/quotes/stats — auth gate', () => {
  test('401 on missing token', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/stats');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/travel/quotes/stats — expiredCount semantics', () => {
  test('Sent + validUntil past → counted; Accepted past → NOT counted; Draft + future → NOT counted', async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    const tomorrow = new Date(Date.now() + 86_400_000);
    prisma.travelQuote.findMany.mockResolvedValue([
      // Sent + past → expired
      makeQuote({ id: 1, status: 'Sent', validUntil: yesterday, totalAmount: '1000.00' }),
      // Accepted + past → NOT expired (terminal state)
      makeQuote({ id: 2, status: 'Accepted', validUntil: yesterday, totalAmount: '2000.00' }),
      // Draft + future → NOT expired
      makeQuote({ id: 3, status: 'Draft', validUntil: tomorrow, totalAmount: '3000.00' }),
      // Draft + null validUntil → NOT expired (no expiry policy)
      makeQuote({ id: 4, status: 'Draft', validUntil: null, totalAmount: '500.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.expiredCount).toBe(1);
    expect(res.body.total).toBe(4);
  });
});

describe('GET /api/travel/quotes/stats — acceptanceRate math', () => {
  test('2 Accepted + 1 Rejected → 0.67 (half-up 2dp)', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, status: 'Accepted', totalAmount: '1000.00' }),
      makeQuote({ id: 2, status: 'Accepted', totalAmount: '2000.00' }),
      makeQuote({ id: 3, status: 'Rejected', totalAmount: '500.00' }),
      // Draft + Sent rows do NOT contribute to the acceptanceRate denominator.
      makeQuote({ id: 4, status: 'Draft', totalAmount: '5000.00' }),
      makeQuote({ id: 5, status: 'Sent', totalAmount: '7000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byStatus.Accepted.count).toBe(2);
    expect(res.body.byStatus.Rejected.count).toBe(1);
    // 2 / (2 + 1) = 0.6666... → 0.67 half-up 2dp
    expect(res.body.acceptanceRate).toBe(0.67);
    expect(res.body.grandAcceptedValue).toBe(3000);
  });
});

describe('GET /api/travel/quotes/stats — defensive math', () => {
  test('null/non-numeric totalAmount → 0; no NaN poisoning', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([
      makeQuote({ id: 1, status: 'Accepted', totalAmount: null }),
      makeQuote({ id: 2, status: 'Accepted', totalAmount: 'not-a-number' }),
      makeQuote({ id: 3, status: 'Accepted', totalAmount: '5000.00' }),
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.byStatus.Accepted.count).toBe(3);
    expect(res.body.byStatus.Accepted.totalValue).toBe(5000);
    expect(Number.isNaN(res.body.grandTotalValue)).toBe(false);
    expect(res.body.grandTotalValue).toBe(5000);
    expect(res.body.grandAcceptedValue).toBe(5000);
  });
});
