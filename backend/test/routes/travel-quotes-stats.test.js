// @ts-check
/**
 * PRD_TRAVEL_QUOTE_BUILDER §3 — TravelQuote stats rollup endpoint tests.
 *
 * Pins the contract for the read-only rollup handler on
 * backend/routes/travel_quotes.js:
 *   - GET /api/travel/quotes/stats (line 1390+) — envelope: total,
 *     byStatus (4-status: Draft/Sent/Accepted/Rejected), bySubBrand,
 *     grandTotalValue, grandAcceptedValue, acceptanceRate, expiredCount,
 *     lastUpdatedAt
 *
 * Why distinct from sibling travel-quotes-*.test.js files
 * -------------------------------------------------------
 * Seven existing sibling tests cover disjoint scope and DO NOT touch
 * GET /quotes/stats:
 *   - travel-quotes-accept-decline.test.js: POST :id/accept|decline
 *   - travel-quotes-analytics.test.js: GET /quotes/analytics (separate
 *     handler powered by lib/travelQuoteAnalytics — different envelope
 *     shape, different status semantics, different keys)
 *   - travel-quotes-audit-trail.test.js: audit-row write contract
 *   - travel-quotes-bulk-decline-expired.test.js: POST /quotes/bulk-decline-expired
 *   - travel-quotes-convert-to-invoice.test.js: POST :id/convert
 *   - travel-quotes-duplicate-pdf.test.js: POST :id/duplicate + GET :id/pdf
 *   - travel-quotes-expiry.test.js: expiry transition contract
 * GET /quotes/stats was UNCOVERED until this file. No case here duplicates
 * any case in those siblings. The /quotes/analytics endpoint (covered by
 * travel-quotes-analytics.test.js) is a SEPARATE handler with a different
 * envelope shape (Draft/Sent/Accepted/Rejected counts as bare integers
 * not {count,totalValue} pairs, plus avgTimeToDecisionDays, currency)
 * — drift between /stats and /analytics is a deliberate design point.
 *
 * Contracts asserted
 * ------------------
 *   1. ADMIN + mixed statuses → byStatus aggregates count + totalValue
 *      for Draft/Sent/Accepted/Rejected (4-status enum)
 *   2. ADMIN + no rows → zeroed envelope (4 statuses zeroed,
 *      grandTotalValue=0, grandAcceptedValue=0, acceptanceRate=null,
 *      expiredCount=0, lastUpdatedAt=null, bySubBrand={})
 *   3. ?from=ISO + ?to=ISO threads where.createdAt = {gte, lte}
 *   4. ?from=garbage → 400 INVALID_DATE
 *   5. ?to=garbage → 400 INVALID_DATE
 *   6. non-travel tenant → 403 WRONG_VERTICAL (requireTravelTenant)
 *   7. unauthenticated → 401 (verifyToken)
 *   8. sub-brand allow-set EMPTY → zeroed envelope (NOT 403) per #976 fix
 *   9. sub-brand allow-set NARROW → where.subBrand = { in: [...] }
 *  10. tenant-isolation: token tenantId=A → findMany call where.tenantId=A
 *  11. round2() math: totalAmount=9.005 → grandTotalValue=9.01 (half-up 2dp)
 *  12. acceptanceRate = accepted / (accepted + rejected); null when
 *      terminal-count is zero (no Accepted + no Rejected rows)
 *  13. expiredCount counts Draft|Sent rows whose validUntil < now;
 *      Accepted|Rejected with past validUntil do NOT inflate the count
 *  14. bySubBrand defensively coalesces null subBrand → "_tenant" key
 *
 * Mocking strategy
 * ----------------
 * Patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * CJS router via createRequire — module-cache pinned by the patch. Real
 * verifyToken middleware runs (we don't bypass it); real
 * requireTravelTenant middleware runs (tenant.findUnique returns a
 * travel-vertical row by default). Real getSubBrandAccessSet runs
 * (user.findUnique controls the access set; null → unscoped ADMIN).
 * HS256 JWTs signed with the dev fallback secret
 * = "enterprise_super_secret_key_2026".
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

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
  prisma.travelQuote.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ───────────────────────────────────────────────────────────────────────
// GET /api/travel/quotes/stats
// ───────────────────────────────────────────────────────────────────────
describe('GET /api/travel/quotes/stats', () => {
  test('case 1: ADMIN + mixed-status → byStatus aggregates correctly', async () => {
    // 2 Draft (100 + 200), 2 Sent (300 + 150), 2 Accepted (400 + 600),
    // 1 Rejected (50). All validUntil in the future so expiredCount=0.
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 1, status: 'Draft',    totalAmount: 100, validUntil: future, updatedAt: new Date('2026-04-01T00:00:00Z'), subBrand: 'tmc' },
      { id: 2, status: 'Draft',    totalAmount: 200, validUntil: future, updatedAt: new Date('2026-04-02T00:00:00Z'), subBrand: 'tmc' },
      { id: 3, status: 'Sent',     totalAmount: 300, validUntil: future, updatedAt: new Date('2026-04-05T00:00:00Z'), subBrand: 'rfu' },
      { id: 4, status: 'Sent',     totalAmount: 150, validUntil: future, updatedAt: new Date('2026-04-08T00:00:00Z'), subBrand: 'rfu' },
      { id: 5, status: 'Accepted', totalAmount: 400, validUntil: future, updatedAt: new Date('2026-04-15T00:00:00Z'), subBrand: 'travelstall' },
      { id: 6, status: 'Accepted', totalAmount: 600, validUntil: future, updatedAt: new Date('2026-04-20T00:00:00Z'), subBrand: 'travelstall' },
      { id: 7, status: 'Rejected', totalAmount: 50,  validUntil: future, updatedAt: new Date('2026-04-25T00:00:00Z'), subBrand: 'visasure' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(7);
    expect(res.body.byStatus.Draft).toEqual({ count: 2, totalValue: 300 });
    expect(res.body.byStatus.Sent).toEqual({ count: 2, totalValue: 450 });
    expect(res.body.byStatus.Accepted).toEqual({ count: 2, totalValue: 1000 });
    expect(res.body.byStatus.Rejected).toEqual({ count: 1, totalValue: 50 });

    // grandTotalValue = 100+200+300+150+400+600+50 = 1800
    expect(res.body.grandTotalValue).toBe(1800);
    // grandAcceptedValue = 400 + 600 = 1000
    expect(res.body.grandAcceptedValue).toBe(1000);
    // acceptanceRate = 2 accepted / (2 accepted + 1 rejected) = 0.666..., round2 = 0.67
    expect(res.body.acceptanceRate).toBe(0.67);
    // All validUntil future → expiredCount=0.
    expect(res.body.expiredCount).toBe(0);
    // lastUpdatedAt = max updatedAt across all rows (id=7 @ 2026-04-25).
    expect(res.body.lastUpdatedAt).toBe(new Date('2026-04-25T00:00:00Z').toISOString());
    // bySubBrand counts per sub-brand.
    expect(res.body.bySubBrand).toEqual({
      tmc: { count: 2 },
      rfu: { count: 2 },
      travelstall: { count: 2 },
      visasure: { count: 1 },
    });
  });

  test('case 2: ADMIN + no rows → zeroed envelope shape', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 0,
      byStatus: {
        Draft: { count: 0, totalValue: 0 },
        Sent: { count: 0, totalValue: 0 },
        Accepted: { count: 0, totalValue: 0 },
        Rejected: { count: 0, totalValue: 0 },
      },
      grandTotalValue: 0,
      grandAcceptedValue: 0,
      acceptanceRate: null,
      expiredCount: 0,
      lastUpdatedAt: null,
    });
    expect(res.body.bySubBrand).toEqual({});
  });

  test('case 3: ?from=ISO + ?to=ISO threads where.createdAt = {gte, lte}', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);

    const from = '2026-01-01T00:00:00Z';
    const to = '2026-12-31T23:59:59Z';
    const res = await request(makeApp())
      .get(`/api/travel/quotes/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.createdAt).toBeDefined();
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
    expect(call.where.createdAt.gte.toISOString()).toBe(new Date(from).toISOString());
    expect(call.where.createdAt.lte.toISOString()).toBe(new Date(to).toISOString());
  });

  test('case 4: ?from=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/stats?from=not-a-date-at-all')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('case 5: ?to=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/quotes/stats?to=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('case 6: non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Tenant', slug: 'generic',
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('case 7: unauthenticated → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/quotes/stats');
    // verifyToken returns 401 for missing/invalid bearer.
    expect(res.status).toBe(401);
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('case 8: sub-brand allow-set EMPTY → zeroed envelope (NOT 403) per #976 fix', async () => {
    // MANAGER role + subBrandAccess with only INVALID sub-brand strings →
    // VALID_SUB_BRANDS filter empties the Set → route returns zeroed
    // envelope short-circuiting the findMany.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['not-a-valid-brand']),
    });

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.byStatus.Draft).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Sent).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Accepted).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Rejected).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.acceptanceRate).toBeNull();
    expect(res.body.expiredCount).toBe(0);
    expect(res.body.bySubBrand).toEqual({});
    // Short-circuit BEFORE prisma.
    expect(prisma.travelQuote.findMany).not.toHaveBeenCalled();
  });

  test('case 9: sub-brand allow-set NARROW → where.subBrand = { in: [...] }', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 11, status: 'Sent', totalAmount: 100, validUntil: future, updatedAt: new Date('2026-04-05T00:00:00Z'), subBrand: 'rfu' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelQuote.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.total).toBe(1);
    expect(res.body.byStatus.Sent).toEqual({ count: 1, totalValue: 100 });
    expect(res.body.bySubBrand).toEqual({ rfu: { count: 1 } });
  });

  test('case 10: tenant-isolation — token tenantId=A → findMany call where.tenantId=A', async () => {
    prisma.travelQuote.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    const call = prisma.travelQuote.findMany.mock.calls[0][0];
    // Where clause MUST scope to the token's tenantId (req.travelTenant.id).
    expect(call.where.tenantId).toBe(1);
    // select clause pins the fields the handler reads.
    expect(call.select).toEqual({
      id: true,
      subBrand: true,
      status: true,
      totalAmount: true,
      validUntil: true,
      updatedAt: true,
    });
  });

  test('case 11: round2() math — totalAmount=9.005 → grandTotalValue=9.01 (half-up at 2dp)', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 91, status: 'Accepted', totalAmount: 9.005, validUntil: future, updatedAt: new Date('2026-04-05T00:00:00Z'), subBrand: 'tmc' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Per round2 in route: Math.round((9.005 + Number.EPSILON) * 100) / 100 = 9.01
    expect(res.body.grandTotalValue).toBe(9.01);
    expect(res.body.grandAcceptedValue).toBe(9.01);
    expect(res.body.byStatus.Accepted.totalValue).toBe(9.01);
  });

  test('case 12: acceptanceRate = null when terminal-count (accepted+rejected) is zero', async () => {
    // Only Draft + Sent rows → no Accepted, no Rejected → acceptanceRate=null.
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 21, status: 'Draft', totalAmount: 100, validUntil: future, updatedAt: new Date('2026-04-01T00:00:00Z'), subBrand: 'tmc' },
      { id: 22, status: 'Sent',  totalAmount: 200, validUntil: future, updatedAt: new Date('2026-04-02T00:00:00Z'), subBrand: 'rfu' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.byStatus.Accepted.count).toBe(0);
    expect(res.body.byStatus.Rejected.count).toBe(0);
    // Division-by-zero guard: terminal-count=0 → null (not 0, not NaN, not Infinity).
    expect(res.body.acceptanceRate).toBeNull();
    expect(res.body.grandAcceptedValue).toBe(0);
  });

  test('case 13: expiredCount counts only Draft|Sent rows w/ past validUntil', async () => {
    // 2 Draft past-validUntil → counted; 1 Sent past-validUntil → counted;
    // 1 Accepted past-validUntil → NOT counted (terminal status); 1 Rejected
    // past-validUntil → NOT counted (terminal status); 1 Draft future-validUntil
    // → NOT counted; 1 Draft null-validUntil → NOT counted.
    const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 31, status: 'Draft',    totalAmount: 100, validUntil: past,   updatedAt: new Date('2026-04-01T00:00:00Z'), subBrand: 'tmc' },
      { id: 32, status: 'Draft',    totalAmount: 200, validUntil: past,   updatedAt: new Date('2026-04-02T00:00:00Z'), subBrand: 'tmc' },
      { id: 33, status: 'Sent',     totalAmount: 300, validUntil: past,   updatedAt: new Date('2026-04-03T00:00:00Z'), subBrand: 'rfu' },
      { id: 34, status: 'Accepted', totalAmount: 400, validUntil: past,   updatedAt: new Date('2026-04-04T00:00:00Z'), subBrand: 'tmc' },
      { id: 35, status: 'Rejected', totalAmount: 500, validUntil: past,   updatedAt: new Date('2026-04-05T00:00:00Z'), subBrand: 'rfu' },
      { id: 36, status: 'Draft',    totalAmount: 600, validUntil: future, updatedAt: new Date('2026-04-06T00:00:00Z'), subBrand: 'tmc' },
      { id: 37, status: 'Draft',    totalAmount: 700, validUntil: null,   updatedAt: new Date('2026-04-07T00:00:00Z'), subBrand: 'tmc' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Only ids 31, 32, 33 expired (Draft|Sent + past validUntil).
    expect(res.body.expiredCount).toBe(3);
  });

  test('case 14: bySubBrand defensively coalesces null subBrand → "_tenant" key', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    prisma.travelQuote.findMany.mockResolvedValue([
      { id: 41, status: 'Sent', totalAmount: 100, validUntil: future, updatedAt: new Date('2026-04-01T00:00:00Z'), subBrand: null },
      { id: 42, status: 'Sent', totalAmount: 200, validUntil: future, updatedAt: new Date('2026-04-02T00:00:00Z'), subBrand: null },
      { id: 43, status: 'Sent', totalAmount: 50,  validUntil: future, updatedAt: new Date('2026-04-03T00:00:00Z'), subBrand: 'tmc' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/quotes/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    // Null sub-brand rows coalesce to "_tenant" key (per route line ~1501).
    expect(res.body.bySubBrand).toEqual({
      _tenant: { count: 2 },
      tmc: { count: 1 },
    });
  });
});
