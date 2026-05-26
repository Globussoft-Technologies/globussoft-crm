// @ts-check
/**
 * Travel CRM — GET /api/travel/diagnostics/by-month
 * tenant-wide Diagnostic submissions monthly rollup (PRD_TRAVEL_RFU_DIAGNOSTIC §3).
 *
 * Pairs with /diagnostics/stats (fffc7345). Pins the contract for the new
 * route handler added at backend/routes/travel_diagnostics.js (placed BEFORE
 * the /diagnostics/:id family so the literal-path /by-month wins over the
 * :id matcher).
 *
 * Mirrors #903 slice 24 (/suppliers/by-month) + #908 slice 21
 * (/flyer-templates/by-month) — same UTC YYYY-MM bucketing template, same
 * defensive math (null/invalid createdAt → "unknown" bucket; excluded when
 * ?from / ?to is set), same orderBy semantics.
 *
 * What's pinned
 * -------------
 *   - 400 INVALID_MONTH_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 3 diagnostics across 2 months → 2 month rows with correct
 *     counts + per-bucket bySubBrand + month-asc default ordering
 *   - Sort: ?orderBy=count:desc flips the ordering
 *   - ?from/?to narrows the bucket array
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     `subBrand: { in: ['rfu'] }` into the Prisma where (no `null` clause —
 *     TravelDiagnostic.subBrand is non-nullable, mirrors /suppliers/by-month
 *     posture, distinct from the flyer-templates pattern)
 *   - 401 when no Authorization header (verifyToken gate)
 *   - Defensive: row with null createdAt → "unknown" bucket; excluded when
 *     ?from/?to is set
 *   - Pagination ?limit / ?offset
 *   - NO audit row written by this read-only endpoint
 *
 * Pattern mirrors travel-suppliers-by-month.test.js — patch the prisma
 * singleton + mock the LLM router + mock the PDF renderer BEFORE requiring
 * the route, then drive supertest with HS256 JWTs signed against the
 * dev-fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// ─── CJS self-mocking — patch on the SAME require() path the route uses ───
// Stub LLM router + PDF renderer + dedup so the route's other endpoints
// (which load these on require) don't blow up at module-load time.
const llmRouter = requireCJS('../../lib/llmRouter');
llmRouter.routeRequest = vi.fn();
const pdfRenderer = requireCJS('../../services/pdfRenderer');
pdfRenderer.renderTravelDiagnosticPdf = vi.fn();
const dedup = requireCJS('../../utils/deduplication');
dedup.findDuplicateContactFull = vi.fn();

// Stub fs writeFile + mkdirSync so the route's PDF best-effort write path
// (loaded in the same router module) doesn't touch disk at module-init.
const fs = requireCJS('fs');
fs.promises.writeFile = vi.fn().mockResolvedValue(undefined);
fs.mkdirSync = vi.fn();

// Patch prisma singleton.
prisma.travelDiagnostic = {
  ...(prisma.travelDiagnostic || {}),
  findMany: vi.fn(),
  count: vi.fn(),
};
prisma.travelDiagnosticQuestionBank = {
  ...(prisma.travelDiagnosticQuestionBank || {}),
  findMany: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  role: 'ADMIN', subBrandAccess: null,
});
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};

const router = requireCJS('../../routes/travel_diagnostics');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', router);
  return app;
}

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Spread of diagnostics across May + June 2026, mixed sub-brands.
//   2026-05: 2 diagnostics, both tmc
//   2026-06: 1 diagnostic, rfu
const baseRows = [
  { subBrand: 'tmc', createdAt: new Date('2026-05-03T08:00:00Z') },
  { subBrand: 'tmc', createdAt: new Date('2026-05-17T10:30:00Z') },
  { subBrand: 'rfu', createdAt: new Date('2026-06-09T09:00:00Z') },
];

beforeEach(() => {
  prisma.travelDiagnostic.findMany.mockReset().mockResolvedValue(baseRows);
  prisma.travelDiagnostic.count.mockReset().mockResolvedValue(baseRows.length);
  prisma.travelDiagnosticQuestionBank.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

describe('GET /api/travel/diagnostics/by-month', () => {
  test('400 INVALID_MONTH_FORMAT on bad ?from token (e.g. month 13)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month?from=2026-13')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
    expect(prisma.travelDiagnostic.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_MONTH_FORMAT on bad ?to token (no dash)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month?to=20260501')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MONTH_FORMAT');
  });

  test('happy path: 3 diagnostics across 2 months → 2 rows month:asc with per-bucket bySubBrand', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(3);
    expect(res.body.months).toHaveLength(2);
    expect(res.body.months[0]).toMatchObject({
      month: '2026-05',
      count: 2,
      bySubBrand: { tmc: { count: 2 } },
    });
    expect(res.body.months[1]).toMatchObject({
      month: '2026-06',
      count: 1,
      bySubBrand: { rfu: { count: 1 } },
    });
    expect(res.body.limit).toBe(12);
    expect(res.body.offset).toBe(0);
  });

  test('orderBy=count:desc puts the busier month first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.months[0].count).toBe(2);
    expect(res.body.months[1].month).toBe('2026-06');
    expect(res.body.months[1].count).toBe(1);
  });

  test('?from=2026-05&to=2026-05 narrows the bucket array to a single month', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month?from=2026-05&to=2026-05')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.grandCount).toBe(2);
  });

  test('MANAGER subBrandAccess=[rfu] threads { in: [rfu] } into Prisma where (no null clause — non-nullable)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { subBrand: 'rfu', createdAt: new Date('2026-05-10T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.months[0].bySubBrand).toEqual({ rfu: { count: 1 } });

    // Verify the where clause carried the sub-brand narrowing.
    const call = prisma.travelDiagnostic.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    // TravelDiagnostic.subBrand is NON-nullable — so this is a single
    // `subBrand: { in: [...] }` clause, NOT the flyer-templates-style
    // `OR: [{ subBrand: { in } }, { subBrand: null }]`.
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(call.where.OR).toBeUndefined();
  });

  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month');

    expect(res.status).toBe(401);
    expect(prisma.travelDiagnostic.findMany).not.toHaveBeenCalled();
  });

  test('pagination: ?limit=1&offset=1 returns 2nd row only with stable grand totals', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month?limit=1&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Totals reflect the FULL aggregation, not the paged window.
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(3);
    expect(res.body.months).toHaveLength(1);
    // Default order is month:asc → offset=1 returns 2026-06.
    expect(res.body.months[0].month).toBe('2026-06');
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('defensive: row with null createdAt → "unknown" bucket (kept when no from/to set)', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-05-03T08:00:00Z') },
      { subBrand: 'rfu', createdAt: null },
      { subBrand: 'tmc', createdAt: new Date('not a date') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 1 row in 2026-05 + 2 in "unknown" → 2 buckets, 3 rows total.
    expect(res.body.totalMonths).toBe(2);
    expect(res.body.grandCount).toBe(3);
    const unknown = res.body.months.find((m) => m.month === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
    expect(unknown.bySubBrand).toEqual({
      rfu: { count: 1 },
      tmc: { count: 1 },
    });
  });

  test('defensive: "unknown" bucket EXCLUDED when ?from / ?to is set', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-05-03T08:00:00Z') },
      { subBrand: 'rfu', createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month?from=2026-01')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalMonths).toBe(1);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].month).toBe('2026-05');
    // grand totals reflect the post-filter set.
    expect(res.body.grandCount).toBe(1);
  });

  test('unknown orderBy token degrades silently to month:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.months[0].month).toBe('2026-05');
    expect(res.body.months[1].month).toBe('2026-06');
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('cross-tenant: WHERE clause includes tenantId on findMany', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER', { tenantId: 1 })}`);

    expect(res.status).toBe(200);
    const findManyWhere = prisma.travelDiagnostic.findMany.mock.calls[0][0].where;
    expect(findManyWhere.tenantId).toBe(1);
  });

  test('defensive: null subBrand coalesces to `_tenant` per-bucket (forward-compat)', async () => {
    // Schema says subBrand is non-nullable, but the route defensively
    // coalesces falsy → '_tenant' for forward-compat. Pin that behaviour.
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { subBrand: null, createdAt: new Date('2026-05-10T10:00:00Z') },
      { subBrand: '', createdAt: new Date('2026-05-11T10:00:00Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-05-12T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-month')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0].bySubBrand).toEqual({
      _tenant: { count: 2 },
      tmc: { count: 1 },
    });
  });
});
