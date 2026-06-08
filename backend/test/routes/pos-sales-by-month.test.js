// @ts-check
/**
 * D17 POS New Sale — Arc 1 polish slice: GET /api/pos/sales/by-month.
 *
 * Sibling of /api/pos/sales/stats. Where /stats returns a single
 * tenant-wide KPI envelope, /by-month returns a per-UTC-month time
 * series for the owner-dashboard POS trend chart. Mirrors the surface
 * established by /api/travel/suppliers/by-month +
 * /api/travel/quotes/by-month + /api/travel/flyer-templates/by-month —
 * same UTC YYYY-MM bucketing, JS-side aggregation, same orderBy / limit
 * / offset / from / to surface, same NO-audit-row read-only contract.
 *
 * Contracts pinned by this spec:
 *
 *   - Auth gate:        no req.user → 401 Authentication required
 *                       (verifyWellnessRole).
 *   - RBAC:             role=USER + wellnessRole=null → 403
 *                       WELLNESS_ROLE_FORBIDDEN (adminGate = verify
 *                       WellnessRole(['admin', 'manager'])).
 *   - Month-format:     bad ?from / ?to → 400 INVALID_MONTH_FORMAT.
 *                       MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/.
 *   - Empty tenant:     total=0, rows=[].
 *   - Bucketing:        UTC YYYY-MM keyed Map; null/invalid createdAt →
 *                       "unknown" bucket.
 *   - byStatus:         per-bucket { DRAFT, COMPLETED, VOIDED, REFUNDED,
 *                       PARTIALLY_REFUNDED } counts.
 *   - totalRevenue:     per-bucket sum of Sale.total where
 *                       status='COMPLETED', half-up 2dp via
 *                       Math.round((n + EPSILON) * 100) / 100.
 *   - Ordering:         default 'month:asc'; accepts 'month:desc',
 *                       'count:asc', 'count:desc'.
 *   - Window:           ?from/?to lexicographically narrows the bucket
 *                       array; 'unknown' excluded when either bound is
 *                       set.
 *   - Pagination:       limit default 12, max 60; offset default 0;
 *                       applied AFTER aggregation + sort + filter.
 *   - Tenant iso:       prisma.sale.findMany where always carries the
 *                       JWT's tenantId.
 *   - No audit row:     read-only meta surface; mirrors /sales/stats.
 *
 * Mock pattern mirrors backend/test/routes/pos-sales-stats.test.js —
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, then drive supertest with a custom req.user-stub middleware.
 * prisma.tenant.findUnique returns vertical='wellness' so the wellness-
 * vertical gate inside verifyWellnessRole passes.
 *
 * Sale status enum (schema.prisma + routes/pos.js void/refund):
 *   DRAFT | COMPLETED | VOIDED | REFUNDED | PARTIALLY_REFUNDED
 * Revenue column = Sale.total (Float, default 0).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by /sales/by-month ──
prisma.sale = prisma.sale || {};
prisma.sale.findMany = vi.fn();

// verifyWellnessRole reads tenant.vertical via prisma.tenant.findUnique.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });

prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// requirePermission middleware (backend/middleware/requirePermission.js:178)
// resolves the caller's effective roles via userRole.findMany. When the
// route declares `anyOfPermissions` (POS adminGate does), the deny path
// for a non-allowed wellnessRole calls getUserPermissions → loadUserPermissions
// → our empty-array mock → permSet.size === 0 → maybeSelfHealAdminPermissions
// which queries prisma.user.findUnique. We stub both: userRole.findMany to []
// (no role grants) AND user.findUnique to null (self-heal exits at the
// "user not found" early return), so the middleware lands on the
// 403 WELLNESS_ROLE_FORBIDDEN path the test asserts.
prisma.userRole = prisma.userRole || {};
prisma.userRole.findMany = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const posRouter = requireCJS('../../routes/pos');

/**
 * Build an Express test app with a req.user-stubbing middleware in
 * front of the pos router. Pass `stubUser: false` to skip the stub
 * entirely (simulates a request with no Authorization header —
 * verifyWellnessRole returns 401 Authentication required).
 */
function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = 'admin',
  vertical = 'wellness',
  stubUser = true,
} = {}) {
  const app = express();
  app.use(express.json());
  if (stubUser) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role, wellnessRole, vertical };
      next();
    });
  }
  app.use('/api/pos', posRouter);
  return app;
}

beforeEach(() => {
  prisma.sale.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'wellness' });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.userRole.findMany.mockReset().mockResolvedValue([]);
});

describe('GET /api/pos/sales/by-month', () => {
  test('1. 401 when no req.user (no Authorization header)', async () => {
    const res = await request(makeApp({ stubUser: false })).get(
      '/api/pos/sales/by-month',
    );
    expect(res.status).toBe(401);
    // verifyWellnessRole bails at the !req.user check before any prisma read.
    expect(prisma.sale.findMany).not.toHaveBeenCalled();
  });

  test('2. 403 WELLNESS_ROLE_FORBIDDEN when caller is USER role (no wellnessRole)', async () => {
    const res = await request(
      makeApp({ role: 'USER', wellnessRole: null }),
    ).get('/api/pos/sales/by-month');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    // adminGate denies before the handler body — no prisma reads.
    expect(prisma.sale.findMany).not.toHaveBeenCalled();
  });

  test('3. 400 INVALID_MONTH_FORMAT on bad ?from', async () => {
    const res = await request(makeApp()).get(
      '/api/pos/sales/by-month?from=not-a-month',
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.sale.findMany).not.toHaveBeenCalled();
  });

  test('4. 400 INVALID_MONTH_FORMAT on bad ?to (e.g. 2026-13 month-out-of-range)', async () => {
    const res = await request(makeApp()).get(
      '/api/pos/sales/by-month?to=2026-13',
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.sale.findMany).not.toHaveBeenCalled();
  });

  test('5. Empty tenant: total=0, rows=[]', async () => {
    const res = await request(makeApp()).get('/api/pos/sales/by-month');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, rows: [] });
    // NO audit row written (read-only meta surface).
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('6. Happy path: 5 sales across 2 months → 2 month rows with byStatus + totalRevenue correct', async () => {
    prisma.sale.findMany.mockResolvedValue([
      // April 2026: 2 COMPLETED + 1 DRAFT
      { total: 1000, status: 'COMPLETED', createdAt: new Date('2026-04-10T10:00:00Z') },
      { total: 500, status: 'COMPLETED', createdAt: new Date('2026-04-15T11:00:00Z') },
      { total: 0, status: 'DRAFT', createdAt: new Date('2026-04-20T12:00:00Z') },
      // May 2026: 1 COMPLETED + 1 VOIDED
      { total: 250, status: 'COMPLETED', createdAt: new Date('2026-05-05T09:00:00Z') },
      { total: 100, status: 'VOIDED', createdAt: new Date('2026-05-10T08:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/pos/sales/by-month');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows).toHaveLength(2);

    // Default order = month:asc, so April comes first.
    const apr = res.body.rows[0];
    expect(apr.month).toBe('2026-04');
    expect(apr.count).toBe(3);
    expect(apr.byStatus).toEqual({ COMPLETED: 2, DRAFT: 1 });
    expect(apr.totalRevenue).toBe(1500); // 1000 + 500 (DRAFT excluded)

    const may = res.body.rows[1];
    expect(may.month).toBe('2026-05');
    expect(may.count).toBe(2);
    expect(may.byStatus).toEqual({ COMPLETED: 1, VOIDED: 1 });
    expect(may.totalRevenue).toBe(250); // VOIDED excluded
  });

  test('7. totalRevenue ONLY sums COMPLETED status (drafts/voids/refunds excluded)', async () => {
    prisma.sale.findMany.mockResolvedValue([
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-05-01T10:00:00Z') },
      { total: 200, status: 'DRAFT', createdAt: new Date('2026-05-02T10:00:00Z') },
      { total: 300, status: 'VOIDED', createdAt: new Date('2026-05-03T10:00:00Z') },
      { total: 400, status: 'REFUNDED', createdAt: new Date('2026-05-04T10:00:00Z') },
      { total: 500, status: 'PARTIALLY_REFUNDED', createdAt: new Date('2026-05-05T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/pos/sales/by-month');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].month).toBe('2026-05');
    expect(res.body.rows[0].count).toBe(5);
    // If we'd summed ALL statuses we'd get 1500. Correct sums only COMPLETED = 100.
    expect(res.body.rows[0].totalRevenue).toBe(100);
    expect(res.body.rows[0].byStatus).toEqual({
      COMPLETED: 1,
      DRAFT: 1,
      VOIDED: 1,
      REFUNDED: 1,
      PARTIALLY_REFUNDED: 1,
    });
  });

  test('8. Default ?orderBy=month:asc yields chronological order', async () => {
    prisma.sale.findMany.mockResolvedValue([
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-06-01T10:00:00Z') },
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-04-01T10:00:00Z') },
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/pos/sales/by-month');

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.month)).toEqual([
      '2026-04',
      '2026-05',
      '2026-06',
    ]);
  });

  test('9. ?orderBy=count:desc flips the ordering by bucket count', async () => {
    prisma.sale.findMany.mockResolvedValue([
      // April: 1 sale
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-04-01T10:00:00Z') },
      // May: 3 sales (the leader)
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-05-01T10:00:00Z') },
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-05-02T10:00:00Z') },
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-05-03T10:00:00Z') },
      // June: 2 sales
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-06-01T10:00:00Z') },
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-06-02T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get(
      '/api/pos/sales/by-month?orderBy=count:desc',
    );

    expect(res.status).toBe(200);
    // count:desc → 3 (May), 2 (June), 1 (April).
    expect(res.body.rows.map((r) => r.month)).toEqual([
      '2026-05',
      '2026-06',
      '2026-04',
    ]);
    expect(res.body.rows.map((r) => r.count)).toEqual([3, 2, 1]);
  });

  test('10. ?from/?to narrows the bucket array', async () => {
    prisma.sale.findMany.mockResolvedValue([
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-02-01T10:00:00Z') },
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-04-01T10:00:00Z') },
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-05-01T10:00:00Z') },
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-08-01T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get(
      '/api/pos/sales/by-month?from=2026-04&to=2026-06',
    );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-04', '2026-05']);
  });

  test('11. Defensive: null createdAt → "unknown" bucket (no from/to set)', async () => {
    prisma.sale.findMany.mockResolvedValue([
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-05-01T10:00:00Z') },
      { total: 200, status: 'DRAFT', createdAt: null },
      { total: 300, status: 'COMPLETED', createdAt: null },
    ]);

    const res = await request(makeApp()).get('/api/pos/sales/by-month');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    // month:asc lexicographic — "2026-05" < "unknown"
    expect(res.body.rows[0].month).toBe('2026-05');
    expect(res.body.rows[0].count).toBe(1);
    expect(res.body.rows[1].month).toBe('unknown');
    expect(res.body.rows[1].count).toBe(2);
    expect(res.body.rows[1].byStatus).toEqual({ DRAFT: 1, COMPLETED: 1 });
    expect(res.body.rows[1].totalRevenue).toBe(300); // 1 COMPLETED in the unknown bucket
  });

  test('12. Pagination ?limit=2&offset=1 slices AFTER aggregation + sort', async () => {
    prisma.sale.findMany.mockResolvedValue([
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-01-01T10:00:00Z') },
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-02-01T10:00:00Z') },
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-03-01T10:00:00Z') },
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-04-01T10:00:00Z') },
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get(
      '/api/pos/sales/by-month?limit=2&offset=1',
    );

    expect(res.status).toBe(200);
    // total is PRE-pagination bucket count (5 months total).
    expect(res.body.total).toBe(5);
    // rows is the post-slice window — offset=1 skips Jan; limit=2 gives Feb + Mar.
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows.map((r) => r.month)).toEqual(['2026-02', '2026-03']);
  });

  test('13. Tenant isolation: prisma.sale.findMany is scoped by JWT tenantId', async () => {
    const res = await request(makeApp({ tenantId: 999 })).get(
      '/api/pos/sales/by-month',
    );

    expect(res.status).toBe(200);
    expect(prisma.sale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 999 }),
      }),
    );
  });

  test('14. NO audit row written (read-only meta surface)', async () => {
    prisma.sale.findMany.mockResolvedValue([
      { total: 100, status: 'COMPLETED', createdAt: new Date('2026-05-01T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/pos/sales/by-month');

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('15. Half-up rounding: per-bucket totalRevenue rounds to 2dp', async () => {
    // 3 COMPLETED rows in May: 100.005 + 50.124 + 25.871 = 176.000 → 176.00
    prisma.sale.findMany.mockResolvedValue([
      { total: 100.005, status: 'COMPLETED', createdAt: new Date('2026-05-01T10:00:00Z') },
      { total: 50.124, status: 'COMPLETED', createdAt: new Date('2026-05-02T10:00:00Z') },
      { total: 25.871, status: 'COMPLETED', createdAt: new Date('2026-05-03T10:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/pos/sales/by-month');

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].totalRevenue).toBe(176);
    expect(typeof res.body.rows[0].totalRevenue).toBe('number');
  });
});
