// @ts-check
/**
 * Travel CRM — GET /api/travel/diagnostics/by-year
 * tenant-wide Diagnostic submissions annual rollup
 * (PRD_TRAVEL_RFU_DIAGNOSTIC §3).
 *
 * Completes the diagnostics rollup triplet: /by-month + /by-quarter +
 * /by-year. Pairs with /diagnostics/stats (KPI tile). Pins the contract
 * for the new route handler added at backend/routes/travel_diagnostics.js
 * (placed BEFORE the /diagnostics/:id family so the literal-path
 * /by-year wins over the :id matcher).
 *
 * Mirrors /itineraries/by-year (#907 slice 18) + /suppliers/by-year +
 * /visa/applications/by-year + /flyer-templates/by-year — same UTC YYYY
 * bucketing template, same defensive math (null/invalid createdAt →
 * "unknown" bucket; excluded when ?from / ?to is set), same orderBy
 * semantics.
 *
 * What's pinned
 * -------------
 *   - 401 when no Authorization header (verifyToken gate)
 *   - 400 INVALID_YEAR_FORMAT on bad ?from / ?to tokens
 *   - Happy path: 3 diagnostics across 2 years → 2 year rows with
 *     correct counts + per-bucket bySubBrand + year-asc default
 *     ordering
 *   - Sort: ?orderBy=count:desc flips the ordering
 *   - ?from/?to narrows the bucket array (inclusive bounds)
 *   - Sub-brand restriction: MANAGER subBrandAccess=['rfu'] threads
 *     `subBrand: { in: ['rfu'] }` into the Prisma where (no `null`
 *     clause — TravelDiagnostic.subBrand is non-nullable, mirrors
 *     /by-quarter posture)
 *   - Empty allowed set → zero-rollup envelope (NOT 403); where carries
 *     the `__none__` sentinel
 *   - Defensive: row with null createdAt → "unknown" bucket; excluded
 *     when ?from/?to set, kept otherwise
 *   - Pagination ?limit / ?offset slices AFTER aggregation
 *   - Defensive: falsy subBrand → `_tenant` bucket (forward-compat)
 *   - Where clause does NOT include `{ subBrand: null }` OR clause
 *   - Unknown orderBy token degrades silently to default
 *   - NO audit row written by this read-only endpoint
 *
 * Pattern mirrors travel-diagnostics-by-quarter.test.js — patch the
 * prisma singleton + mock LLM router + mock PDF renderer + mock fs
 * BEFORE requiring the route, then drive supertest with HS256 JWTs
 * signed against the dev-fallback secret.
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

// Spread of diagnostics across 2025 + 2026, mixed sub-brands.
//   2025: 1 diagnostic, tmc
//   2026: 2 diagnostics — 1 tmc + 1 rfu
const baseRows = [
  { subBrand: 'tmc', createdAt: new Date('2025-11-04T08:00:00Z') }, // 2025
  { subBrand: 'tmc', createdAt: new Date('2026-04-15T08:00:00Z') }, // 2026
  { subBrand: 'rfu', createdAt: new Date('2026-06-10T10:30:00Z') }, // 2026
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

describe('GET /api/travel/diagnostics/by-year', () => {
  test('401 when no Authorization header (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year');

    expect(res.status).toBe(401);
    expect(prisma.travelDiagnostic.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_YEAR_FORMAT on bad ?from token (quarter-shaped)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year?from=2026-Q1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
    expect(prisma.travelDiagnostic.findMany).not.toHaveBeenCalled();
  });

  test('400 INVALID_YEAR_FORMAT on bad ?from token (2-digit short year)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year?from=26')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('400 INVALID_YEAR_FORMAT on bad ?to token (alphabetic)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year?to=abcd')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_YEAR_FORMAT');
  });

  test('happy path: 3 diagnostics across 2 years → 2 rows year:asc with per-bucket bySubBrand', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(3);
    expect(res.body.years).toHaveLength(2);
    expect(res.body.years[0]).toMatchObject({
      year: '2025',
      count: 1,
      bySubBrand: { tmc: { count: 1 } },
    });
    expect(res.body.years[1]).toMatchObject({
      year: '2026',
      count: 2,
      bySubBrand: { tmc: { count: 1 }, rfu: { count: 1 } },
    });
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(0);
  });

  test('default orderBy=year:asc returns chronological order', async () => {
    // Reverse the input order to prove the sort is doing the work.
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-04-15T08:00:00Z') },
      { subBrand: 'rfu', createdAt: new Date('2025-11-04T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[1].year).toBe('2026');
  });

  test('orderBy=count:desc puts the busier year first', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year?orderBy=count:desc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.years[0].count).toBe(2);
    expect(res.body.years[1].year).toBe('2025');
    expect(res.body.years[1].count).toBe(1);
  });

  test('?from=2026&to=2026 narrows the bucket array to a single year', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year?from=2026&to=2026')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.grandCount).toBe(2);
  });

  test('MANAGER subBrandAccess=[rfu] threads { in: [rfu] } into Prisma where (no null clause — non-nullable)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { subBrand: 'rfu', createdAt: new Date('2026-06-10T08:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.years[0].bySubBrand).toEqual({ rfu: { count: 1 } });

    // Verify the where clause carried the sub-brand narrowing.
    const call = prisma.travelDiagnostic.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    // TravelDiagnostic.subBrand is NON-nullable — so this is a single
    // `subBrand: { in: [...] }` clause, NOT the flyer-templates-style
    // `OR: [{ subBrand: { in } }, { subBrand: null }]`.
    expect(call.where.subBrand).toEqual({ in: ['rfu'] });
    expect(call.where.OR).toBeUndefined();
  });

  test('MANAGER subBrandAccess filtered to empty Set returns zero-rollup envelope (NOT 403); where carries __none__ sentinel', async () => {
    // subBrandAccess=['__bogus__'] survives JSON.parse but filters down
    // to an empty Set (no VALID_SUB_BRANDS match) — exercises the
    // empty-allowed-set branch that emits subBrand: "__none__".
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['__not_a_valid_subbrand__']),
    });
    prisma.travelDiagnostic.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(0);
    expect(res.body.grandCount).toBe(0);
    expect(res.body.years).toEqual([]);

    // The where clause carries the force-empty sentinel (not 403).
    const call = prisma.travelDiagnostic.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toBe('__none__');
  });

  test('defensive: row with null createdAt → "unknown" bucket (kept when no from/to set)', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-04-15T08:00:00Z') },
      { subBrand: 'rfu', createdAt: null },
      { subBrand: 'tmc', createdAt: new Date('not a date') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // 1 row in 2026 + 2 in "unknown" → 2 buckets, 3 rows total.
    expect(res.body.totalYears).toBe(2);
    expect(res.body.grandCount).toBe(3);
    const unknown = res.body.years.find((y) => y.year === 'unknown');
    expect(unknown).toBeTruthy();
    expect(unknown.count).toBe(2);
    expect(unknown.bySubBrand).toEqual({
      rfu: { count: 1 },
      tmc: { count: 1 },
    });
  });

  test('defensive: "unknown" bucket EXCLUDED when ?from / ?to is set', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2026-04-15T08:00:00Z') },
      { subBrand: 'rfu', createdAt: null },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year?from=2025')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.totalYears).toBe(1);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    // grand totals reflect the post-filter set.
    expect(res.body.grandCount).toBe(1);
  });

  test('pagination: ?limit=2&offset=1 slices AFTER aggregation; totals reflect full aggregation', async () => {
    // 3-year spread to exercise the slice window cleanly.
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { subBrand: 'tmc', createdAt: new Date('2024-03-01T08:00:00Z') }, // 2024
      { subBrand: 'rfu', createdAt: new Date('2025-04-15T08:00:00Z') }, // 2025
      { subBrand: 'tmc', createdAt: new Date('2026-06-10T10:30:00Z') }, // 2026
    ]);

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year?limit=2&offset=1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    // Totals reflect the FULL aggregation, not the paged window.
    expect(res.body.totalYears).toBe(3);
    expect(res.body.grandCount).toBe(3);
    expect(res.body.years).toHaveLength(2);
    // Default order is year:asc → offset=1 → returns 2025 + 2026.
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[1].year).toBe('2026');
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(1);
  });

  test('defensive: falsy subBrand coalesces to `_tenant` per-bucket (forward-compat)', async () => {
    // Schema says subBrand is non-nullable, but the route defensively
    // coalesces falsy → '_tenant' for forward-compat. Pin that.
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { subBrand: null, createdAt: new Date('2026-04-15T10:00:00Z') },
      { subBrand: '', createdAt: new Date('2026-05-11T10:00:00Z') },
      { subBrand: 'tmc', createdAt: new Date('2026-06-12T10:00:00Z') },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years).toHaveLength(1);
    expect(res.body.years[0].year).toBe('2026');
    expect(res.body.years[0].bySubBrand).toEqual({
      _tenant: { count: 2 },
      tmc: { count: 1 },
    });
  });

  test('admin: where clause carries tenantId but NO subBrand narrowing or null OR clause', async () => {
    // ADMIN has subBrandAccess=null → getSubBrandAccessSet returns null
    // → no narrowing applied. Verify the where clause stays clean.
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    const call = prisma.travelDiagnostic.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.subBrand).toBeUndefined();
    expect(call.where.OR).toBeUndefined();
  });

  test('unknown orderBy token degrades silently to year:asc default', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year?orderBy=bogus:asc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.years[0].year).toBe('2025');
    expect(res.body.years[1].year).toBe('2026');
  });

  test('NO audit row written by this read-only endpoint', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/by-year')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
