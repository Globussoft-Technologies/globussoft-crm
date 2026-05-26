// @ts-check
/**
 * Arc 2 #900 slice 13 — quote analytics rollup contract.
 *
 * Pins TWO surfaces:
 *
 *   1. backend/lib/travelQuoteAnalytics.js — pure aggregation helper
 *      (computeQuoteAnalytics). Unit-tested without express; verifies
 *      status counts, sub-brand breakdown, totals per status, acceptance
 *      rate over terminal-state quotes, avg time-to-decision in days
 *      (half-up rounded), expired count, mixed-currency null signal.
 *
 *   2. GET /api/travel/quotes/analytics — route layer. Tenant + sub-brand
 *      scoping, ?subBrand and ?from/?to filters, INVALID_FROM /
 *      INVALID_TO / INVALID_RANGE error codes, empty-access-set short
 *      circuit, route ordering (must hit findMany not findFirst —
 *      otherwise Express matched "analytics" as a numeric :id).
 *
 * Why one spec covers both: the helper's contract IS the route's response
 * shape — drift between the two is the most-likely regression vector, so
 * pinning them together in one file makes that drift impossible to land
 * without a co-located red test.
 *
 * Pattern mirrors travel-quotes-expiry.test.js — patch prisma singleton
 * BEFORE requiring the router, supertest with HS256 JWTs.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import {
  computeQuoteAnalytics,
  roundHalfUp2,
} from '../../lib/travelQuoteAnalytics.js';

// Patch prisma BEFORE requiring the router.
prisma.travelQuote = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelQuoteLine = prisma.travelQuoteLine || {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoice = prisma.travelInvoice || {
  findFirst: vi.fn(),
  create: vi.fn(),
};
prisma.travelInvoiceLine = prisma.travelInvoiceLine || {
  createMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.travelMarkupRule = prisma.travelMarkupRule || {
  findMany: vi.fn().mockResolvedValue([]),
};
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

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuote.findMany.mockReset();
  prisma.travelQuote.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Unit tests — computeQuoteAnalytics (pure helper, no DB / no express)
// ---------------------------------------------------------------------------

describe('lib/travelQuoteAnalytics.computeQuoteAnalytics', () => {
  test('empty list → all-zeros rollup, nulls for ratios', () => {
    const out = computeQuoteAnalytics([]);
    expect(out.total).toBe(0);
    expect(out.byStatus).toEqual({ Draft: 0, Sent: 0, Accepted: 0, Rejected: 0 });
    expect(out.bySubBrand).toEqual({});
    expect(out.totalValueByStatus).toEqual({ Draft: 0, Sent: 0, Accepted: 0, Rejected: 0 });
    expect(out.acceptanceRate).toBeNull();
    expect(out.avgTimeToDecisionDays).toBeNull();
    expect(out.expiredCount).toBe(0);
    expect(out.currency).toBeNull();
  });

  test('counts byStatus + sums totalValueByStatus across mixed statuses', () => {
    const now = new Date('2026-05-25T00:00:00Z');
    const quotes = [
      {
        id: 1, subBrand: 'tmc', status: 'Draft', totalAmount: 1000, currency: 'INR',
        validUntil: null, createdAt: now, updatedAt: now,
      },
      {
        id: 2, subBrand: 'tmc', status: 'Sent', totalAmount: 2000, currency: 'INR',
        validUntil: null, createdAt: now, updatedAt: now,
      },
      {
        id: 3, subBrand: 'rfu', status: 'Accepted', totalAmount: 5000, currency: 'INR',
        validUntil: null, createdAt: now, updatedAt: now,
      },
      {
        id: 4, subBrand: 'rfu', status: 'Rejected', totalAmount: 3000, currency: 'INR',
        validUntil: null, createdAt: now, updatedAt: now,
      },
    ];
    const out = computeQuoteAnalytics(quotes, { now });
    expect(out.total).toBe(4);
    expect(out.byStatus).toEqual({ Draft: 1, Sent: 1, Accepted: 1, Rejected: 1 });
    expect(out.totalValueByStatus).toEqual({
      Draft: 1000, Sent: 2000, Accepted: 5000, Rejected: 3000,
    });
  });

  test('bySubBrand breakdown is per-status counters keyed by sub-brand', () => {
    const now = new Date('2026-05-25T00:00:00Z');
    const quotes = [
      { id: 1, subBrand: 'tmc', status: 'Accepted', totalAmount: 100, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
      { id: 2, subBrand: 'tmc', status: 'Accepted', totalAmount: 100, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
      { id: 3, subBrand: 'rfu', status: 'Sent', totalAmount: 100, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
    ];
    const out = computeQuoteAnalytics(quotes, { now });
    expect(out.bySubBrand).toEqual({
      tmc: { total: 2, Draft: 0, Sent: 0, Accepted: 2, Rejected: 0 },
      rfu: { total: 1, Draft: 0, Sent: 1, Accepted: 0, Rejected: 0 },
    });
  });

  test('acceptanceRate ignores Draft+Sent; 2/(2+2) = 0.5', () => {
    const now = new Date('2026-05-25T00:00:00Z');
    const quotes = [
      { id: 1, subBrand: 'tmc', status: 'Draft', totalAmount: 0, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
      { id: 2, subBrand: 'tmc', status: 'Sent', totalAmount: 0, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
      { id: 3, subBrand: 'tmc', status: 'Accepted', totalAmount: 0, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
      { id: 4, subBrand: 'tmc', status: 'Accepted', totalAmount: 0, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
      { id: 5, subBrand: 'tmc', status: 'Rejected', totalAmount: 0, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
      { id: 6, subBrand: 'tmc', status: 'Rejected', totalAmount: 0, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
    ];
    expect(computeQuoteAnalytics(quotes, { now }).acceptanceRate).toBe(0.5);
  });

  test('acceptanceRate is null when no terminal-state quotes (avoids 0% lie)', () => {
    const now = new Date('2026-05-25T00:00:00Z');
    const quotes = [
      { id: 1, subBrand: 'tmc', status: 'Draft', totalAmount: 0, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
      { id: 2, subBrand: 'tmc', status: 'Sent', totalAmount: 0, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
    ];
    expect(computeQuoteAnalytics(quotes, { now }).acceptanceRate).toBeNull();
  });

  test('avgTimeToDecisionDays computed only over Accepted/Rejected; half-up rounded to 2dp', () => {
    const created = new Date('2026-05-01T00:00:00Z');
    const updated2d = new Date('2026-05-03T00:00:00Z'); // 2 days
    const updated5d = new Date('2026-05-06T00:00:00Z'); // 5 days
    const now = new Date('2026-05-25T00:00:00Z');
    const quotes = [
      { id: 1, subBrand: 'tmc', status: 'Accepted', totalAmount: 0, currency: 'INR', validUntil: null, createdAt: created, updatedAt: updated2d },
      { id: 2, subBrand: 'tmc', status: 'Rejected', totalAmount: 0, currency: 'INR', validUntil: null, createdAt: created, updatedAt: updated5d },
      // Draft excluded from time-to-decision aggregation even though its
      // updatedAt > createdAt; only terminal states count.
      { id: 3, subBrand: 'tmc', status: 'Draft', totalAmount: 0, currency: 'INR', validUntil: null, createdAt: created, updatedAt: new Date('2026-05-20T00:00:00Z') },
    ];
    const out = computeQuoteAnalytics(quotes, { now });
    expect(out.avgTimeToDecisionDays).toBe(3.5); // mean(2, 5) = 3.5
  });

  test('expiredCount: status ∈ {Draft, Sent} AND validUntil < now', () => {
    const now = new Date('2026-05-25T00:00:00Z');
    const past = new Date('2020-01-01T00:00:00Z');
    const future = new Date('2099-01-01T00:00:00Z');
    const quotes = [
      // expired
      { id: 1, subBrand: 'tmc', status: 'Draft', totalAmount: 0, currency: 'INR', validUntil: past, createdAt: now, updatedAt: now },
      { id: 2, subBrand: 'tmc', status: 'Sent', totalAmount: 0, currency: 'INR', validUntil: past, createdAt: now, updatedAt: now },
      // not expired — future validUntil
      { id: 3, subBrand: 'tmc', status: 'Sent', totalAmount: 0, currency: 'INR', validUntil: future, createdAt: now, updatedAt: now },
      // not expired — terminal status, validUntil < now but doesn't count
      { id: 4, subBrand: 'tmc', status: 'Accepted', totalAmount: 0, currency: 'INR', validUntil: past, createdAt: now, updatedAt: now },
      // not expired — null validUntil
      { id: 5, subBrand: 'tmc', status: 'Draft', totalAmount: 0, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
    ];
    expect(computeQuoteAnalytics(quotes, { now }).expiredCount).toBe(2);
  });

  test('currency = single value when all quotes share, null when mixed', () => {
    const now = new Date('2026-05-25T00:00:00Z');
    const usd = [
      { id: 1, subBrand: 'tmc', status: 'Draft', totalAmount: 100, currency: 'USD', validUntil: null, createdAt: now, updatedAt: now },
      { id: 2, subBrand: 'tmc', status: 'Sent', totalAmount: 200, currency: 'USD', validUntil: null, createdAt: now, updatedAt: now },
    ];
    expect(computeQuoteAnalytics(usd, { now }).currency).toBe('USD');

    const mixed = [
      ...usd,
      { id: 3, subBrand: 'rfu', status: 'Draft', totalAmount: 100, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
    ];
    expect(computeQuoteAnalytics(mixed, { now }).currency).toBeNull();
  });

  test('skips quotes with unknown status (defensive)', () => {
    const now = new Date('2026-05-25T00:00:00Z');
    const quotes = [
      { id: 1, subBrand: 'tmc', status: 'Draft', totalAmount: 100, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
      { id: 2, subBrand: 'tmc', status: 'BogusStatus', totalAmount: 999, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
    ];
    const out = computeQuoteAnalytics(quotes, { now });
    // Total reflects list length (defensive — bad rows don't disappear from
    // the headline count) but byStatus only counts known statuses.
    expect(out.total).toBe(2);
    expect(out.byStatus).toEqual({ Draft: 1, Sent: 0, Accepted: 0, Rejected: 0 });
    expect(out.totalValueByStatus.Draft).toBe(100);
  });

  test('non-array input → empty rollup (defensive)', () => {
    const out = computeQuoteAnalytics(null);
    expect(out.total).toBe(0);
    expect(out.byStatus.Draft).toBe(0);
  });

  test('roundHalfUp2 — exact .005 rounds up (not banker\'s rounding)', () => {
    // Math.round(0.005 * 100) is 0 on some V8 builds (half-to-even). The
    // epsilon-add in roundHalfUp2 guarantees half-up.
    expect(roundHalfUp2(0.005)).toBe(0.01);
    expect(roundHalfUp2(0.015)).toBe(0.02);
    expect(roundHalfUp2(0.125)).toBe(0.13);
    expect(roundHalfUp2(1.234)).toBe(1.23);
    expect(roundHalfUp2(1.235)).toBe(1.24);
  });
});

// ---------------------------------------------------------------------------
// Route tests — GET /api/travel/quotes/analytics
// ---------------------------------------------------------------------------

describe('GET /api/travel/quotes/analytics', () => {
  test('happy path — ADMIN sees envelope with rolled-up stats', async () => {
    const now = new Date('2026-05-25T00:00:00Z');
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 1, subBrand: 'tmc', status: 'Draft', totalAmount: 1000, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
      { id: 2, subBrand: 'tmc', status: 'Accepted', totalAmount: 2000, currency: 'INR', validUntil: null, createdAt: now, updatedAt: now },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/analytics')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.byStatus.Draft).toBe(1);
    expect(res.body.byStatus.Accepted).toBe(1);
    expect(res.body.totalValueByStatus.Draft).toBe(1000);
    expect(res.body.totalValueByStatus.Accepted).toBe(2000);
    expect(res.body.currency).toBe('INR');
  });

  test('route ordering: "analytics" matches the analytics endpoint, not GET /:id', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .get('/api/travel/quotes/analytics')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // If routing were wrong, findFirst (GET /:id) would have been called.
    expect(prisma.travelQuote.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.travelQuote.findFirst).not.toHaveBeenCalled();
  });

  test('?subBrand=tmc filters the where clause', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/quotes/analytics?subBrand=tmc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const findManyArgs = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(findManyArgs.where.subBrand).toBe('tmc');
    expect(findManyArgs.where.tenantId).toBe(1);
  });

  test('?subBrand=garbage → 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/analytics?subBrand=not-a-sub-brand')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUB_BRAND');
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('?from=ISO&?to=ISO adds createdAt range filter', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/quotes/analytics?from=2026-05-01&to=2026-05-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const findManyArgs = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(findManyArgs.where.createdAt.gte).toBeInstanceOf(Date);
    expect(findManyArgs.where.createdAt.lte).toBeInstanceOf(Date);
    expect(findManyArgs.where.createdAt.gte.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  test('?from=garbage → 400 INVALID_FROM', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/analytics?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FROM');
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('?to=garbage → 400 INVALID_TO', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/analytics?to=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TO');
  });

  test('?from > ?to → 400 INVALID_RANGE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/analytics?from=2026-06-01&to=2026-05-01')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RANGE');
  });

  test('MANAGER with subBrandAccess=["tmc"] sees only tmc-scoped quotes', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER', subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelQuote.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/quotes/analytics')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    const findManyArgs = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(findManyArgs.where.subBrand).toEqual({ in: ['tmc'] });
  });

  test('caller with empty access set → all-zeros rollup (no DB hit, not 403)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER', subBrandAccess: 'not-json',
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/analytics')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.acceptanceRate).toBeNull();
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('selects only the columns the rollup needs', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/quotes/analytics')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const findManyArgs = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(findManyArgs.select).toEqual({
      id: true,
      subBrand: true,
      status: true,
      totalAmount: true,
      currency: true,
      validUntil: true,
      createdAt: true,
      updatedAt: true,
    });
  });
});
