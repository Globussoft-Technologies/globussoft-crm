// @ts-check
/**
 * PRD_TRAVEL_BILLING §3 — TravelInvoice annual-rollup endpoint tests.
 *
 * Pins the contract for the by-year rollup handler on
 * backend/routes/travel_invoices.js:
 *   - GET /api/travel/invoices/by-year (line 1765+) — YYYY bucket with
 *     invoiceCount + totalValue + per-status counts (draft/issued/partial/
 *     paid/voided) + paidValue + openValue. Grand-totals envelope mirrors
 *     by-month + by-quarter so dashboard tiles can swap granularity
 *     without re-shaping the response.
 *
 * Why distinct from travel-invoices-stats.test.js
 * -----------------------------------------------
 * The sibling backend/test/routes/travel-invoices-stats.test.js covers
 * the OTHER three rollup handlers in the family — /stats (line 3005+),
 * /by-month (line 1165+), /by-quarter (line 1463+). This file ONLY
 * covers /by-year. Together the two files complete the rollup-triplet
 * coverage shipped across `5c96a28e` (stats + by-month + by-quarter) →
 * this slice closes the loop with by-year. No case here duplicates any
 * case there.
 *
 * Why distinct from travel_invoices.test.js
 * -----------------------------------------
 * The route-level travel_invoices.test.js covers POST /invoices +
 * PUT /invoices/:id + DELETE /invoices/:id + GET /invoices/:id — the
 * CRUD surface. No rollup coverage there.
 *
 * Contracts asserted
 * ------------------
 *   1. happy path — invoices spanning 3 UTC years → 3 YYYY buckets with
 *      correct envelope keys (year, invoiceCount, totalValue,
 *      draftCount, issuedCount, partialCount, paidCount, voidedCount,
 *      paidValue, openValue) + grand-totals envelope
 *   2. empty result — returns { years: [], totalYears: 0, grand* = 0 }
 *   3. non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant
 *   4. unauthenticated → 401 via verifyToken
 *   5. ?from=YYYY + ?to=YYYY filter applied to the buckets (post-aggregation)
 *   6. ?from=garbage → 400 INVALID_YEAR_FORMAT
 *   7. ?to=garbage → 400 INVALID_YEAR_FORMAT
 *   8. sub-brand allow-set EMPTY → zeroed envelope (per #976 fix —
 *      handler short-circuits BEFORE findMany)
 *   9. sub-brand allow-set NARROW → where.subBrand = { in: [...] }
 *   10. status grouping — Draft/Issued/Partial/Paid/Voided each
 *       contribute to their per-bucket sub-totals
 *   11. tenant-isolation — token tenantId=A → findMany where.tenantId=A
 *   12. round2 math — totalAmount=9.005 → totalValue=9.01 (half-up at 2dp)
 *
 * Mocking strategy
 * ----------------
 * Patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router (CJS require — module-cache pinned by the patch). Real
 * verifyToken middleware runs (we don't bypass it); real
 * requireTravelTenant middleware runs (tenant.findUnique returns a
 * travel-vertical row by default). Real getSubBrandAccessSet runs
 * (user.findUnique controls the access set). HS256 JWTs signed with the
 * dev fallback secret = "enterprise_super_secret_key_2026". Mirrors
 * travel-invoices-stats.test.js exactly.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelInvoice = prisma.travelInvoice || {};
prisma.travelInvoice.findMany = vi.fn();
prisma.travelInvoice.findFirst = prisma.travelInvoice.findFirst || vi.fn();
prisma.travelInvoice.count = prisma.travelInvoice.count || vi.fn();
prisma.travelInvoice.create = prisma.travelInvoice.create || vi.fn();
prisma.travelInvoice.update = prisma.travelInvoice.update || vi.fn();
prisma.travelInvoice.delete = prisma.travelInvoice.delete || vi.fn();
prisma.travelInvoiceLine = prisma.travelInvoiceLine || {};
prisma.travelInvoiceLine.findMany = prisma.travelInvoiceLine.findMany || vi.fn();
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
const travelInvoicesRouter = requireCJS('../../routes/travel_invoices');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelInvoicesRouter);
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
  prisma.travelInvoice.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN',
    subBrandAccess: null,
  });
});

// ───────────────────────────────────────────────────────────────────────
// GET /api/travel/invoices/by-year
// ───────────────────────────────────────────────────────────────────────
describe('GET /api/travel/invoices/by-year', () => {
  test('case 1: happy path — invoices spanning 3 UTC years → 3 YYYY buckets', async () => {
    // 2024: 1 Issued (100). 2025: 2 (Paid 200 + Voided 50). 2026: 1 Paid (400).
    prisma.travelInvoice.findMany.mockResolvedValue([
      { id: 1, status: 'Issued', totalAmount: 100, createdAt: new Date('2024-03-15T08:00:00Z') },
      { id: 2, status: 'Paid',   totalAmount: 200, createdAt: new Date('2025-07-17T10:30:00Z') },
      { id: 3, status: 'Voided', totalAmount: 50,  createdAt: new Date('2025-11-09T09:00:00Z') },
      { id: 4, status: 'Paid',   totalAmount: 400, createdAt: new Date('2026-02-22T12:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(3);
    expect(res.body.grandInvoiceCount).toBe(4);
    // grandTotalValue = 100 + 200 + 50 + 400 = 750
    expect(res.body.grandTotalValue).toBe(750);
    // grandPaidValue = 200 + 400 = 600 (Voided excluded from paidValue)
    expect(res.body.grandPaidValue).toBe(600);
    // openValue per row: 2024 = 100 - 0 paid - 0 voided = 100;
    //                    2025 = 250 - 200 paid - 50 voided = 0;
    //                    2026 = 400 - 400 paid - 0 voided = 0.
    // grandOpenValue = 100 + 0 + 0 = 100.
    expect(res.body.grandOpenValue).toBe(100);
    expect(res.body.years).toHaveLength(3);
    // Default orderBy is year:asc → 2024, 2025, 2026.
    expect(res.body.years[0]).toMatchObject({
      year: '2024',
      invoiceCount: 1,
      totalValue: 100,
      issuedCount: 1,
      paidCount: 0,
      voidedCount: 0,
      paidValue: 0,
      openValue: 100,
    });
    expect(res.body.years[1]).toMatchObject({
      year: '2025',
      invoiceCount: 2,
      totalValue: 250,
      paidCount: 1,
      voidedCount: 1,
      paidValue: 200,
      openValue: 0,
    });
    expect(res.body.years[2]).toMatchObject({
      year: '2026',
      invoiceCount: 1,
      totalValue: 400,
      paidCount: 1,
      paidValue: 400,
      openValue: 0,
    });
    // Default limit/offset per route: limit=10 (Math.min(10, 30)), offset=0.
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  test('case 2: empty result — returns empty years[] + zeroed grand-totals', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      years: [],
      totalYears: 0,
      grandInvoiceCount: 0,
      grandTotalValue: 0,
      grandPaidValue: 0,
      grandOpenValue: 0,
    });
  });

  test('case 3: non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Tenant', slug: 'generic',
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('case 4: unauthenticated → 401 via verifyToken', async () => {
    const res = await request(makeApp()).get('/api/travel/invoices/by-year');
    expect(res.status).toBe(401);
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('case 5: ?from=YYYY + ?to=YYYY filter applied to buckets', async () => {
    // 4 invoices spanning 2023..2026; ?from=2024&to=2025 → 2 buckets.
    prisma.travelInvoice.findMany.mockResolvedValue([
      { id: 1, status: 'Issued', totalAmount: 50,  createdAt: new Date('2023-06-15T00:00:00Z') },
      { id: 2, status: 'Paid',   totalAmount: 100, createdAt: new Date('2024-03-15T00:00:00Z') },
      { id: 3, status: 'Paid',   totalAmount: 200, createdAt: new Date('2025-07-17T00:00:00Z') },
      { id: 4, status: 'Paid',   totalAmount: 400, createdAt: new Date('2026-02-22T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year?from=2024&to=2025')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.years.map((y) => y.year)).toEqual(['2024', '2025']);
    // grand-totals reflect ONLY the filtered slice.
    expect(res.body.grandInvoiceCount).toBe(2);
    expect(res.body.grandTotalValue).toBe(300);
    expect(res.body.grandPaidValue).toBe(300);
  });

  test('case 6: ?from=garbage → 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year?from=not-a-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('case 7: ?to=garbage → 400 INVALID_YEAR_FORMAT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year?to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('case 8: sub-brand allow-set EMPTY → zeroed envelope (NOT 403)', async () => {
    // MANAGER role + subBrandAccess containing only unknown brand → empty
    // Set after VALID_SUB_BRANDS filter → short-circuit BEFORE findMany.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['not-a-valid-brand']),
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      years: [],
      totalYears: 0,
      grandInvoiceCount: 0,
      grandTotalValue: 0,
      grandPaidValue: 0,
      grandOpenValue: 0,
    });
    // No findMany call — short-circuit returns BEFORE prisma.
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('case 9: sub-brand allow-set NARROW → where.subBrand = { in: [...] }', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelInvoice.findMany.mockResolvedValue([
      { id: 11, status: 'Issued', totalAmount: 100, createdAt: new Date('2026-04-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years[0]).toMatchObject({
      year: '2026',
      invoiceCount: 1,
      issuedCount: 1,
      totalValue: 100,
    });
  });

  test('case 10: status grouping — all 5 statuses populate their sub-counts', async () => {
    // All 5 status values in the same UTC year → single bucket with each
    // sub-count populated.
    prisma.travelInvoice.findMany.mockResolvedValue([
      { id: 1, status: 'Draft',   totalAmount: 100, createdAt: new Date('2026-01-01T00:00:00Z') },
      { id: 2, status: 'Issued',  totalAmount: 200, createdAt: new Date('2026-02-01T00:00:00Z') },
      { id: 3, status: 'Partial', totalAmount: 300, createdAt: new Date('2026-03-01T00:00:00Z') },
      { id: 4, status: 'Paid',    totalAmount: 400, createdAt: new Date('2026-04-01T00:00:00Z') },
      { id: 5, status: 'Voided',  totalAmount: 500, createdAt: new Date('2026-05-01T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    const y = res.body.years[0];
    expect(y).toMatchObject({
      year: '2026',
      invoiceCount: 5,
      totalValue: 1500,
      draftCount: 1,
      issuedCount: 1,
      partialCount: 1,
      paidCount: 1,
      voidedCount: 1,
      paidValue: 400,
      // openValue = 1500 - 400 paid - 500 voided = 600.
      openValue: 600,
    });
  });

  test('case 11: tenant-isolation — token tenantId=A → where.tenantId=A', async () => {
    const tenantARows = [
      { id: 101, status: 'Paid', totalAmount: 50, createdAt: new Date('2026-05-01T00:00:00Z') },
    ];
    prisma.travelInvoice.findMany.mockResolvedValue(tenantARows);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    // Where clause MUST scope to the token's tenantId.
    const call = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(res.body.grandInvoiceCount).toBe(1);
    expect(res.body.grandTotalValue).toBe(50);
  });

  test('case 12: round2 math — totalAmount=9.005 → totalValue=9.01 (half-up at 2dp)', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      { id: 91, status: 'Paid', totalAmount: 9.005, createdAt: new Date('2026-04-05T00:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Per round2 in route: Math.round((9.005 + Number.EPSILON) * 100) / 100 = 9.01
    expect(res.body.years[0].totalValue).toBe(9.01);
    expect(res.body.years[0].paidValue).toBe(9.01);
    expect(res.body.grandTotalValue).toBe(9.01);
    expect(res.body.grandPaidValue).toBe(9.01);
  });
});
