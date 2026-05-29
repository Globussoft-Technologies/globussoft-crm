// @ts-check
/**
 * PRD_TRAVEL_BILLING §3 — TravelInvoice rollup-family endpoint tests.
 *
 * Pins the contract for the three read-only rollup handlers on
 * backend/routes/travel_invoices.js:
 *   - GET /api/travel/invoices/stats        (line 3005+) — envelope: total,
 *     byStatus (5-status), bySubBrand, grandTotalValue, grandPaidValue,
 *     grandOpenValue, paidRate, overdueCount, lastIssuedAt
 *   - GET /api/travel/invoices/by-month     (line 1165+) — YYYY-MM bucket
 *     with invoiceCount + totalValue + per-status counts + paidValue +
 *     openValue
 *   - GET /api/travel/invoices/by-quarter   (line 1463+) — YYYY-Qn bucket
 *     mirror of by-month at coarser granularity
 *
 * Why distinct from travel_invoices.test.js
 * -----------------------------------------
 * The sibling backend/test/routes/travel_invoices.test.js covers a
 * disjoint scope: POST /invoices (create + auto-assigned TINV-YYYY-NNNN
 * serial), PUT /invoices/:id (forward-only status transition matrix),
 * DELETE /invoices/:id (Draft-only delete + audit), GET /invoices/:id
 * (cross-tenant 404). It does NOT exercise the rollup family — those
 * three handlers were UNCOVERED until this file. No case here duplicates
 * any case there.
 *
 * Contracts asserted
 * ------------------
 *   1. /stats ADMIN no-rows → zeroed envelope (5 statuses zeroed,
 *      grandTotalValue=0, paidRate=null, overdueCount=0, lastIssuedAt=null)
 *   2. /stats ADMIN mixed-status → byStatus aggregates correct counts +
 *      sums for Draft/Issued/Partial/Paid/Voided
 *   3. /stats ?from=ISO + ?to=ISO threads where.createdAt = {gte, lte}
 *   4. /stats ?from=garbage → 400 INVALID_DATE
 *   5. /stats ?to=garbage → 400 INVALID_DATE
 *   6. /stats sub-brand allow-set EMPTY → zeroed envelope (NOT 403)
 *   7. /stats sub-brand allow-set NARROW → where.subBrand = { in: [...] }
 *   8. /stats non-travel tenant → 403 WRONG_VERTICAL (requireTravelTenant)
 *   9. /stats unauthenticated → 401
 *   10. /stats round2() math: totalAmount=9.005 → grandTotalValue=9.01
 *       (half-up at 2dp)
 *   11. /by-month happy path → YYYY-MM buckets with invoiceCount +
 *       totalValue keys
 *   12. /by-month tenant-isolation: token tenantId=A → mock returns only
 *       A's rows; where.tenantId=A asserted
 *   13. /by-quarter happy path → YYYY-Qn buckets with invoiceCount +
 *       totalValue keys
 *
 * Mocking strategy
 * ----------------
 * Patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router (CJS require — module-cache pinned by the patch). Real
 * verifyToken middleware runs (we don't bypass it); real
 * requireTravelTenant middleware runs (tenant.findUnique returns a
 * travel-vertical row by default). Real getSubBrandAccessSet runs
 * (user.findUnique controls the access set). HS256 JWTs signed with the
 * dev fallback secret = "enterprise_super_secret_key_2026".
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
// GET /api/travel/invoices/stats
// ───────────────────────────────────────────────────────────────────────
describe('GET /api/travel/invoices/stats', () => {
  test('case 1: ADMIN + no rows → zeroed envelope shape', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 0,
      byStatus: {
        Draft: { count: 0, totalValue: 0 },
        Issued: { count: 0, totalValue: 0 },
        Partial: { count: 0, totalValue: 0 },
        Paid: { count: 0, totalValue: 0 },
        Voided: { count: 0, totalValue: 0 },
      },
      grandTotalValue: 0,
      grandPaidValue: 0,
      grandOpenValue: 0,
      paidRate: null,
      overdueCount: 0,
      lastIssuedAt: null,
    });
    // bySubBrand exists as an object (empty when no rows).
    expect(res.body.bySubBrand).toEqual({});
  });

  test('case 2: ADMIN + mixed-status → byStatus aggregates correctly', async () => {
    // 2 Draft (100 + 200), 1 Issued (300), 1 Partial (500), 2 Paid (400 + 600), 1 Voided (50)
    prisma.travelInvoice.findMany.mockResolvedValue([
      { id: 1, status: 'Draft',   totalAmount: 100, dueDate: null, updatedAt: new Date('2026-04-01T00:00:00Z'), subBrand: 'tmc' },
      { id: 2, status: 'Draft',   totalAmount: 200, dueDate: null, updatedAt: new Date('2026-04-02T00:00:00Z'), subBrand: 'tmc' },
      { id: 3, status: 'Issued',  totalAmount: 300, dueDate: null, updatedAt: new Date('2026-04-05T00:00:00Z'), subBrand: 'rfu' },
      { id: 4, status: 'Partial', totalAmount: 500, dueDate: null, updatedAt: new Date('2026-04-10T00:00:00Z'), subBrand: 'rfu' },
      { id: 5, status: 'Paid',    totalAmount: 400, dueDate: null, updatedAt: new Date('2026-04-15T00:00:00Z'), subBrand: 'travelstall' },
      { id: 6, status: 'Paid',    totalAmount: 600, dueDate: null, updatedAt: new Date('2026-04-20T00:00:00Z'), subBrand: 'travelstall' },
      { id: 7, status: 'Voided',  totalAmount: 50,  dueDate: null, updatedAt: new Date('2026-04-25T00:00:00Z'), subBrand: 'visasure' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(7);
    expect(res.body.byStatus.Draft).toEqual({ count: 2, totalValue: 300 });
    expect(res.body.byStatus.Issued).toEqual({ count: 1, totalValue: 300 });
    expect(res.body.byStatus.Partial).toEqual({ count: 1, totalValue: 500 });
    expect(res.body.byStatus.Paid).toEqual({ count: 2, totalValue: 1000 });
    expect(res.body.byStatus.Voided).toEqual({ count: 1, totalValue: 50 });

    // grandTotalValue = 100+200+300+500+400+600+50 = 2150
    expect(res.body.grandTotalValue).toBe(2150);
    // grandPaidValue = 400 + 600 = 1000
    expect(res.body.grandPaidValue).toBe(1000);
    // grandOpenValue = 2150 - 1000 (paid) - 50 (voided) = 1100
    expect(res.body.grandOpenValue).toBe(1100);
    // paidRate = 1000 / (1000 + 1100) = 0.476..., round2 = 0.48
    expect(res.body.paidRate).toBe(0.48);
    // lastIssuedAt = updatedAt of the most-recent Issued row (id=3).
    expect(res.body.lastIssuedAt).toBe(new Date('2026-04-05T00:00:00Z').toISOString());
  });

  test('case 3: ?from=ISO + ?to=ISO threads where.createdAt = {gte, lte}', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([]);

    const from = '2026-01-01T00:00:00Z';
    const to = '2026-12-31T23:59:59Z';
    const res = await request(makeApp())
      .get(`/api/travel/invoices/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.createdAt).toBeDefined();
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
    expect(call.where.createdAt.gte.toISOString()).toBe(new Date(from).toISOString());
    expect(call.where.createdAt.lte.toISOString()).toBe(new Date(to).toISOString());
  });

  test('case 4: ?from=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/stats?from=not-a-date-at-all')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('case 5: ?to=garbage → 400 INVALID_DATE', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/stats?to=garbage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('case 6: sub-brand allow-set EMPTY → zeroed envelope (NOT 403)', async () => {
    // MANAGER role + subBrandAccess=[] (empty after filter) → empty Set →
    // route returns zeroed envelope short-circuiting the findMany.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      // JSON.parse([]) → [] → empty Set after VALID_SUB_BRANDS filter.
      // Use a string containing only unknown sub-brands so the filter
      // empties the Set.
      subBrandAccess: JSON.stringify(['not-a-valid-brand']),
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.byStatus.Draft).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Issued).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Paid).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.byStatus.Voided).toEqual({ count: 0, totalValue: 0 });
    expect(res.body.paidRate).toBeNull();
    expect(res.body.overdueCount).toBe(0);
    // No findMany call — the empty-set short-circuit returns BEFORE prisma.
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('case 7: sub-brand allow-set NARROW → where.subBrand = { in: [...] }', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelInvoice.findMany.mockResolvedValue([
      { id: 11, status: 'Issued', totalAmount: 100, dueDate: null, updatedAt: new Date('2026-04-05T00:00:00Z'), subBrand: 'rfu' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(res.body.total).toBe(1);
    expect(res.body.byStatus.Issued).toEqual({ count: 1, totalValue: 100 });
  });

  test('case 8: non-travel tenant → 403 WRONG_VERTICAL via requireTravelTenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Tenant', slug: 'generic',
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_VERTICAL');
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('case 9: unauthenticated → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/invoices/stats');
    // verifyToken returns 401 for missing/invalid bearer.
    expect(res.status).toBe(401);
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });

  test('case 10: round2() math — totalAmount=9.005 → grandTotalValue=9.01 (half-up at 2dp)', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      { id: 91, status: 'Paid', totalAmount: 9.005, dueDate: null, updatedAt: new Date('2026-04-05T00:00:00Z'), subBrand: 'tmc' },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Per round2 in route: Math.round((9.005 + Number.EPSILON) * 100) / 100 = 9.01
    expect(res.body.grandTotalValue).toBe(9.01);
    expect(res.body.grandPaidValue).toBe(9.01);
    expect(res.body.byStatus.Paid.totalValue).toBe(9.01);
  });
});

// ───────────────────────────────────────────────────────────────────────
// GET /api/travel/invoices/by-month
// ───────────────────────────────────────────────────────────────────────
describe('GET /api/travel/invoices/by-month', () => {
  test('case 11: happy path — YYYY-MM buckets with invoiceCount + totalValue', async () => {
    // 2 invoices in 2026-05, 1 in 2026-06.
    prisma.travelInvoice.findMany.mockResolvedValue([
      { id: 1, status: 'Issued', totalAmount: 100, createdAt: new Date('2026-05-03T08:00:00Z') },
      { id: 2, status: 'Paid',   totalAmount: 200, createdAt: new Date('2026-05-17T10:30:00Z') },
      { id: 3, status: 'Paid',   totalAmount: 400, createdAt: new Date('2026-06-09T09:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandInvoiceCount).toBe(3);
    expect(res.body.grandTotalValue).toBe(700);
    expect(res.body.grandPaidValue).toBe(600);
    // openValue per row: 2026-05 = (100+200) - 200 paid - 0 voided = 100;
    //                    2026-06 = 400 - 400 paid - 0 voided = 0.
    // grandOpenValue = 100 + 0 = 100.
    expect(res.body.grandOpenValue).toBe(100);
    expect(res.body.months).toHaveLength(2);
    expect(res.body.months[0]).toMatchObject({
      month: '2026-05',
      invoiceCount: 2,
      totalValue: 300,
      issuedCount: 1,
      paidCount: 1,
      paidValue: 200,
      openValue: 100,
    });
    expect(res.body.months[1]).toMatchObject({
      month: '2026-06',
      invoiceCount: 1,
      totalValue: 400,
      paidCount: 1,
      paidValue: 400,
      openValue: 0,
    });
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });

  test('case 12: tenant-isolation — token tenantId=A → where.tenantId=A; mock returns only A rows', async () => {
    // Tenant A = 1 (default); token signed with tenantId=1.
    // Mock returns ONLY tenant-1 rows; we assert the where clause threaded
    // the tenant scope. The route's prisma layer would do the filtering for
    // real; here we pin the SHAPE of the call.
    const tenantARows = [
      { id: 101, status: 'Paid', totalAmount: 50, createdAt: new Date('2026-05-01T00:00:00Z') },
    ];
    prisma.travelInvoice.findMany.mockResolvedValue(tenantARows);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-month')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    // Where clause MUST scope to the token's tenantId.
    const call = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    // Body reflects only tenant-A rows.
    expect(res.body.grandInvoiceCount).toBe(1);
    expect(res.body.grandTotalValue).toBe(50);
  });
});

// ───────────────────────────────────────────────────────────────────────
// GET /api/travel/invoices/by-quarter
// ───────────────────────────────────────────────────────────────────────
describe('GET /api/travel/invoices/by-quarter', () => {
  test('case 13: happy path — YYYY-Qn buckets with invoiceCount + totalValue', async () => {
    // 2026-Q2 (Apr-Jun): 3 invoices; 2026-Q3 (Jul-Sep): 1.
    prisma.travelInvoice.findMany.mockResolvedValue([
      { id: 1, status: 'Issued', totalAmount: 100, createdAt: new Date('2026-04-15T08:00:00Z') },
      { id: 2, status: 'Paid',   totalAmount: 200, createdAt: new Date('2026-05-17T10:30:00Z') },
      { id: 3, status: 'Paid',   totalAmount: 400, createdAt: new Date('2026-06-09T09:00:00Z') },
      { id: 4, status: 'Issued', totalAmount: 50,  createdAt: new Date('2026-07-22T12:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/invoices/by-quarter')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalQuarters).toBe(2);
    expect(res.body.grandInvoiceCount).toBe(4);
    expect(res.body.grandTotalValue).toBe(750);
    expect(res.body.grandPaidValue).toBe(600);
    expect(res.body.quarters).toHaveLength(2);
    expect(res.body.quarters[0]).toMatchObject({
      quarter: '2026-Q2',
      invoiceCount: 3,
      totalValue: 700,
      issuedCount: 1,
      paidCount: 2,
      paidValue: 600,
      // openValue = 700 - 600 paid - 0 voided = 100.
      openValue: 100,
    });
    expect(res.body.quarters[1]).toMatchObject({
      quarter: '2026-Q3',
      invoiceCount: 1,
      totalValue: 50,
      issuedCount: 1,
      paidCount: 0,
      paidValue: 0,
      // openValue = 50 - 0 paid - 0 voided = 50.
      openValue: 50,
    });
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });
});
