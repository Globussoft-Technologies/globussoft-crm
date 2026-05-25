// @ts-check
/**
 * Travel CRM — GET /api/travel/diagnostics/stats
 * tenant-wide Diagnostic submissions rollup (PRD_TRAVEL_RFU_DIAGNOSTIC §3).
 *
 * Mirrors #905 slice 18 /commission-profiles/stats + #903 slice 23
 * /suppliers/stats + #908 slice 19 /flyer-templates/global-stats. USER-readable
 * anodyne aggregate that powers the Diagnostics dashboard's header summary
 * strip. Pins the contract for the new route handler added at
 * backend/routes/travel_diagnostics.js (placed BEFORE the /diagnostics/:id
 * family so the literal-path /stats wins over the :id matcher).
 *
 * What's pinned
 * -------------
 *   - Empty tenant:        zeroed envelope with empty bucket maps and
 *                          lastSubmittedAt=null, aggregateExceedsCap=false.
 *   - Happy path:          4 diagnostics across 2 sub-brands + 2 banks →
 *                          counts correct (total, bySubBrand bucket counts,
 *                          byBank bucket counts + bankName synth from
 *                          subBrand+version, lastSubmittedAt is max(createdAt)).
 *   - Cross-tenant scoping:WHERE clause includes tenantId: req.travelTenant.id
 *                          on BOTH findMany + count + bank-resolve fetch —
 *                          no leak from another tenant even if FK IDs would
 *                          have matched.
 *   - MANAGER narrowing:   subBrandAccess=['rfu'] → caller's diagnostic WHERE
 *                          clause narrowed to subBrand:{in:['rfu']} BEFORE
 *                          the Prisma query fires.
 *   - ?from/?to ISO bounds:populated → createdAt gets {gte,lte} clauses;
 *                          invalid date → 400 INVALID_DATE.
 *   - USER-readable:       USER role returns 200 (anodyne aggregate; same
 *                          contract as sibling /stats endpoints).
 *   - Auth gate:           no token → 401.
 *   - Defensive:           0 matching rows → lastSubmittedAt:null and empty
 *                          bucket maps (NOT undefined / NOT missing).
 *
 * Public/auth split: TravelDiagnostic schema has no marker distinguishing
 * public-quiz vs authenticated submissions, so publicCount/authCount are
 * intentionally absent from the response shape. Pin that contract too
 * (response shape does NOT include those keys).
 *
 * Test pattern mirrors travel-supplier-stats.test.js (slice 23) — patch the
 * prisma singleton + mock the LLM router + mock the PDF renderer BEFORE
 * requiring the route, then drive supertest with HS256 JWTs signed against
 * the dev-fallback secret.
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

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.travelDiagnostic.findMany.mockReset();
  prisma.travelDiagnostic.count.mockReset();
  prisma.travelDiagnosticQuestionBank.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
});

describe('GET /api/travel/diagnostics/stats', () => {
  test('empty tenant → all-zeros envelope with empty bucket maps and lastSubmittedAt:null', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([]);
    prisma.travelDiagnostic.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/diagnostics/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 0,
      bySubBrand: {},
      byBank: {},
      lastSubmittedAt: null,
      aggregateExceedsCap: false,
    });
    // publicCount + authCount intentionally absent — schema has no marker.
    expect(res.body).not.toHaveProperty('publicCount');
    expect(res.body).not.toHaveProperty('authCount');
  });

  test('happy path: 4 diagnostics across 2 sub-brands + 2 banks → counts correct', async () => {
    const newest = new Date('2026-05-20T10:00:00Z');
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 1, subBrand: 'tmc', questionBankId: 100, createdAt: new Date('2026-05-10T10:00:00Z') },
      { id: 2, subBrand: 'tmc', questionBankId: 100, createdAt: new Date('2026-05-12T10:00:00Z') },
      { id: 3, subBrand: 'rfu', questionBankId: 200, createdAt: new Date('2026-05-15T10:00:00Z') },
      { id: 4, subBrand: 'rfu', questionBankId: 200, createdAt: newest }, // drives lastSubmittedAt
    ]);
    prisma.travelDiagnostic.count.mockResolvedValue(4);
    prisma.travelDiagnosticQuestionBank.findMany.mockResolvedValue([
      { id: 100, subBrand: 'tmc', version: 1 },
      { id: 200, subBrand: 'rfu', version: 2 },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/diagnostics/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.bySubBrand).toEqual({
      tmc: { count: 2 },
      rfu: { count: 2 },
    });
    expect(res.body.byBank).toEqual({
      100: { count: 2, bankName: 'tmc v1' },
      200: { count: 2, bankName: 'rfu v2' },
    });
    expect(res.body.lastSubmittedAt).toBe(newest.toISOString());
    expect(res.body.aggregateExceedsCap).toBe(false);
  });

  test('cross-tenant: WHERE clause includes tenantId on findMany, count, AND bank-resolve fetch', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 1, subBrand: 'tmc', questionBankId: 100, createdAt: new Date('2026-05-10T10:00:00Z') },
    ]);
    prisma.travelDiagnostic.count.mockResolvedValue(1);
    prisma.travelDiagnosticQuestionBank.findMany.mockResolvedValue([
      { id: 100, subBrand: 'tmc', version: 1 },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/diagnostics/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Pin tenantId on every Prisma WHERE that touches a multi-tenant table.
    const findManyWhere = prisma.travelDiagnostic.findMany.mock.calls[0][0].where;
    expect(findManyWhere.tenantId).toBe(1);
    const countWhere = prisma.travelDiagnostic.count.mock.calls[0][0].where;
    expect(countWhere.tenantId).toBe(1);
    const bankWhere = prisma.travelDiagnosticQuestionBank.findMany.mock.calls[0][0].where;
    expect(bankWhere.tenantId).toBe(1);
  });

  test('MANAGER with subBrandAccess=["rfu"] → query narrowed to rfu only', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 3, subBrand: 'rfu', questionBankId: 200, createdAt: new Date('2026-05-15T10:00:00Z') },
    ]);
    prisma.travelDiagnostic.count.mockResolvedValue(1);
    prisma.travelDiagnosticQuestionBank.findMany.mockResolvedValue([
      { id: 200, subBrand: 'rfu', version: 1 },
    ]);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/diagnostics/stats')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.bySubBrand).toEqual({ rfu: { count: 1 } });
    // The route-level WHERE clause is the load-bearing narrowing surface.
    const whereArg = prisma.travelDiagnostic.findMany.mock.calls[0][0].where;
    expect(whereArg.subBrand).toEqual({ in: ['rfu'] });
  });

  test('?from/?to ISO bounds → createdAt gets {gte,lte} clauses; invalid date → 400 INVALID_DATE', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([]);
    prisma.travelDiagnostic.count.mockResolvedValue(0);

    // Happy path: valid ISO bounds land on createdAt.
    const app = makeApp();
    const ok = await request(app)
      .get('/api/travel/diagnostics/stats?from=2026-05-01&to=2026-05-31')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(ok.status).toBe(200);
    const w = prisma.travelDiagnostic.findMany.mock.calls[0][0].where;
    expect(w.createdAt).toBeTruthy();
    expect(w.createdAt.gte).toBeInstanceOf(Date);
    expect(w.createdAt.lte).toBeInstanceOf(Date);

    // Invalid from → 400 INVALID_DATE.
    const bad = await request(app)
      .get('/api/travel/diagnostics/stats?from=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_DATE');
  });

  test('USER role → 200 (anodyne aggregate; same contract as sibling /stats endpoints)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: null,
    });
    prisma.travelDiagnostic.findMany.mockResolvedValue([]);
    prisma.travelDiagnostic.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/diagnostics/stats')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test('auth gate: missing token → 401', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/travel/diagnostics/stats');
    expect(res.status).toBe(401);
  });

  test('defensive: 0 rows → lastSubmittedAt:null and empty bucket maps (not undefined)', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([]);
    prisma.travelDiagnostic.count.mockResolvedValue(0);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/diagnostics/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.lastSubmittedAt).toBeNull();
    expect(res.body.bySubBrand).toEqual({});
    expect(res.body.byBank).toEqual({});
    // Route-level guarantee: the bank-resolve fetch is SKIPPED when 0 rows
    // (no bankIdsSeen). Confirms the empty short-circuit path.
    expect(prisma.travelDiagnosticQuestionBank.findMany).not.toHaveBeenCalled();
  });

  test('defensive: null subBrand coalesces to `_tenant` bucket (forward-compat)', async () => {
    // Schema says subBrand is non-nullable, but the route defensively
    // coalesces falsy → '_tenant' for forward-compat. Pin that behaviour.
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 1, subBrand: null, questionBankId: null, createdAt: new Date('2026-05-10T10:00:00Z') },
      { id: 2, subBrand: '', questionBankId: null, createdAt: new Date('2026-05-11T10:00:00Z') },
      { id: 3, subBrand: 'tmc', questionBankId: null, createdAt: new Date('2026-05-12T10:00:00Z') },
    ]);
    prisma.travelDiagnostic.count.mockResolvedValue(3);

    const app = makeApp();
    const res = await request(app)
      .get('/api/travel/diagnostics/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.bySubBrand).toEqual({
      _tenant: { count: 2 },
      tmc: { count: 1 },
    });
    // questionBankId null on all rows → byBank is empty (rows that have no
    // bank don't contribute to the bank bucket).
    expect(res.body.byBank).toEqual({});
  });
});
