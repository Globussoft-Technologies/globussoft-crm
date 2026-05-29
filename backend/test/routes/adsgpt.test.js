// @ts-check
/**
 * PRD_ADSGPT_MARKETING_REPORTS — /api/adsgpt operator-wrapper tests.
 *
 * Pins the contract for the thin wrapper added at backend/routes/adsgpt.js,
 * which exposes services/adsGptClient.js (stub-mode today, real post Q1
 * cred handover) to UI consumers without touching the service module.
 *
 * What's pinned
 * -------------
 *   - GET /reports/ads  happy path returns the client's envelope verbatim.
 *   - GET /reports/ads  cap-exceeded throw → 402 + structured error body.
 *   - GET /cap-status   ADMIN only — returns spentCents/capCents/percent/
 *                       withinCap/alertThreshold from checkBudgetCap.
 *   - GET /cap-status   MANAGER → 403 (verifyRole gate).
 *   - GET /reports/ads  API-key sub-brand mismatch (apiKeySubBrand='tmc' +
 *                       query subBrand=rfu) → 403 SUB_BRAND_MISMATCH.
 *
 * Test pattern mirrors backend/test/routes/travel_quotes.test.js — patch
 * the adsGptClient module exports with vi.fn() BEFORE requiring the
 * router, then drive supertest with real HS256 JWTs signed with the same
 * fallback secret the middleware uses in dev. verifyToken + verifyRole
 * stay in the chain (we don't bypass them) so the auth gate is exercised
 * end-to-end.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Resolve adsGptClient + router via the SAME require() path the route
// uses, so mutations to module.exports propagate to the router's closure.
// (ESM default-import of a CJS module returns a wrapped object in some
// vitest configs; requireCJS guarantees we mutate the require-cache
// object the router is reading.)
const adsGptClient = requireCJS('../../services/adsGptClient');
adsGptClient.fetchAdReport = vi.fn();
adsGptClient.checkBudgetCap = vi.fn();

// Prisma stubs for the auth-middleware path (verifyToken loads the user
// + checks revokedToken) and the audit-write path.
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  id: 7, role: 'ADMIN', tenantId: 1, isActive: true,
});
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};

const adsgptRouter = requireCJS('../../routes/adsgpt');

function makeApp({ apiKeySubBrand } = {}) {
  const app = express();
  app.use(express.json());
  // Optional pre-middleware to simulate externalAuth/voyagrAuth having
  // pinned req.apiKeySubBrand. Used by the SUB_BRAND_MISMATCH probe.
  if (apiKeySubBrand !== undefined) {
    app.use((req, _res, next) => {
      req.apiKeySubBrand = apiKeySubBrand;
      next();
    });
  }
  app.use('/api/adsgpt', adsgptRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeAll(() => {
  // No-op: stubs already installed above.
});

beforeEach(() => {
  adsGptClient.fetchAdReport.mockReset();
  adsGptClient.checkBudgetCap.mockReset();
  prisma.user.findUnique.mockReset().mockResolvedValue({
    id: 7, role: 'ADMIN', tenantId: 1, isActive: true,
  });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/adsgpt/reports/ads', () => {
  test('happy path returns the client envelope verbatim', async () => {
    const cannedEnvelope = {
      stub: true,
      tenantId: 1,
      subBrand: 'tmc',
      platform: 'all',
      window: { fromDate: '2026-04-01', toDate: '2026-04-30' },
      metrics: { spendUsdCents: 0, impressions: 0, clicks: 0, conversions: 0, cpaCents: 0, roas: 0 },
      rows: [],
      note: 'AdsGPT integration pending Q1 creds (Yasin handover).',
    };
    adsGptClient.fetchAdReport.mockResolvedValue(cannedEnvelope);

    const res = await request(makeApp())
      .get('/api/adsgpt/reports/ads')
      .query({ subBrand: 'tmc', fromDate: '2026-04-01', toDate: '2026-04-30', platform: 'all' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stub: true, tenantId: 1, subBrand: 'tmc', platform: 'all' });
    // Tenant came from req.user.tenantId, not the query string.
    expect(adsGptClient.fetchAdReport).toHaveBeenCalledWith({
      tenantId: 1,
      subBrand: 'tmc',
      fromDate: '2026-04-01',
      toDate: '2026-04-30',
      platform: 'all',
    });
    // Audit row written on success.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'AdsGPTReport',
      action: 'FETCH',
      userId: 7,
      tenantId: 1,
    });
  });

  test('client throws ADSGPT_BUDGET_EXCEEDED → 402 with structured error', async () => {
    const err = new Error('Monthly AdsGPT spend cap reached for this tenant.');
    err.code = 'ADSGPT_BUDGET_EXCEEDED';
    err.spentCents = 5100;
    err.capCents = 5000;
    adsGptClient.fetchAdReport.mockRejectedValue(err);

    const res = await request(makeApp())
      .get('/api/adsgpt/reports/ads')
      .query({ subBrand: 'tmc', fromDate: '2026-04-01', toDate: '2026-04-30' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      code: 'ADSGPT_BUDGET_EXCEEDED',
      spentCents: 5100,
      capCents: 5000,
    });
    expect(res.body.error).toMatch(/cap/i);
    // Audit must NOT fire on the cap-exceeded throw path (the error is
    // raised by checkBudgetCap inside fetchAdReport, before any report
    // data exists worth auditing).
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('API-key sub-brand mismatch (apiKeySubBrand=tmc, query=rfu) → 403 SUB_BRAND_MISMATCH', async () => {
    const res = await request(makeApp({ apiKeySubBrand: 'tmc' }))
      .get('/api/adsgpt/reports/ads')
      .query({ subBrand: 'rfu', fromDate: '2026-04-01', toDate: '2026-04-30' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_MISMATCH' });
    expect(res.body.error).toMatch(/tmc/);
    expect(res.body.error).toMatch(/rfu/);
    // Client must NOT be called when sub-brand isolation rejects the request.
    expect(adsGptClient.fetchAdReport).not.toHaveBeenCalled();
  });
});

describe('GET /api/adsgpt/cap-status', () => {
  test('ADMIN returns {spentCents, capCents, percent, withinCap, alertThreshold}', async () => {
    adsGptClient.checkBudgetCap.mockResolvedValue({
      spentCents: 1250,
      capCents: 5000,
      percent: 0.25,
      withinCap: true,
      alertThreshold: false,
    });

    const res = await request(makeApp())
      .get('/api/adsgpt/cap-status')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      spentCents: 1250,
      capCents: 5000,
      percent: 0.25,
      withinCap: true,
      alertThreshold: false,
    });
    expect(adsGptClient.checkBudgetCap).toHaveBeenCalledWith(1);
    // Cap-status is read-only — no audit fires.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('MANAGER returns 403 (ADMIN-only gate)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, role: 'MANAGER', tenantId: 1, isActive: true,
    });

    const res = await request(makeApp())
      .get('/api/adsgpt/cap-status')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    // checkBudgetCap MUST NOT have been called — the role gate fires
    // before the handler runs.
    expect(adsGptClient.checkBudgetCap).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Extended coverage (tick #N, +8 cases) — pinning the un-tested edges of
// the wrapper: platform validation, auth-gate, default-platform, sub-brand
// match (not mismatch), generic-error fall-through, cap-status auth+errors,
// and tenant scope coming from JWT not query.
// ---------------------------------------------------------------------------
describe('GET /api/adsgpt/reports/ads — extended coverage', () => {
  test('invalid platform → 400 INVALID_PLATFORM (assertValidPlatform gate)', async () => {
    const res = await request(makeApp())
      .get('/api/adsgpt/reports/ads')
      .query({ subBrand: 'tmc', platform: 'tiktok' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PLATFORM' });
    expect(res.body.error).toMatch(/platform must be one of/i);
    // Provider must not be invoked when validation fails.
    expect(adsGptClient.fetchAdReport).not.toHaveBeenCalled();
    // No audit row when the call short-circuits at validation.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('missing Authorization header → 401 (verifyToken gate)', async () => {
    const res = await request(makeApp())
      .get('/api/adsgpt/reports/ads')
      .query({ subBrand: 'tmc' });
    // No Authorization header set.

    expect(res.status).toBe(401);
    expect(adsGptClient.fetchAdReport).not.toHaveBeenCalled();
  });

  test('platform defaults to "all" when query param omitted', async () => {
    adsGptClient.fetchAdReport.mockResolvedValue({
      stub: true, tenantId: 1, subBrand: 'tmc', platform: 'all',
      window: { fromDate: null, toDate: null },
      metrics: {}, rows: [], note: 'stub',
    });

    const res = await request(makeApp())
      .get('/api/adsgpt/reports/ads')
      .query({ subBrand: 'tmc' })
      // No platform, fromDate, or toDate in the query.
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(adsGptClient.fetchAdReport).toHaveBeenCalledWith({
      tenantId: 1,
      subBrand: 'tmc',
      fromDate: null,
      toDate: null,
      platform: 'all',
    });
  });

  test('API-key sub-brand match (apiKeySubBrand=tmc, query=tmc) succeeds + force-pins subBrand', async () => {
    adsGptClient.fetchAdReport.mockResolvedValue({
      stub: true, tenantId: 1, subBrand: 'tmc', platform: 'all',
      window: {}, metrics: {}, rows: [], note: 'stub',
    });

    const res = await request(makeApp({ apiKeySubBrand: 'tmc' }))
      .get('/api/adsgpt/reports/ads')
      .query({ subBrand: 'tmc', platform: 'meta' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // effectiveSubBrand is force-pinned to req.apiKeySubBrand (matches here).
    expect(adsGptClient.fetchAdReport).toHaveBeenCalledWith(
      expect.objectContaining({ subBrand: 'tmc', platform: 'meta', tenantId: 1 }),
    );
  });

  test('API-key sub-brand with no query subBrand → effectiveSubBrand forced to apiKeySubBrand', async () => {
    adsGptClient.fetchAdReport.mockResolvedValue({
      stub: true, tenantId: 1, subBrand: 'rfu', platform: 'all',
      window: {}, metrics: {}, rows: [], note: 'stub',
    });

    const res = await request(makeApp({ apiKeySubBrand: 'rfu' }))
      .get('/api/adsgpt/reports/ads')
      // No query.subBrand at all — API-key value should win.
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(adsGptClient.fetchAdReport).toHaveBeenCalledWith(
      expect.objectContaining({ subBrand: 'rfu' }),
    );
  });

  test('generic client error (no .code, no .status) → 500 "Failed to fetch ad report"', async () => {
    adsGptClient.fetchAdReport.mockRejectedValue(new Error('upstream blew up'));

    const res = await request(makeApp())
      .get('/api/adsgpt/reports/ads')
      .query({ subBrand: 'tmc' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch ad report' });
    // No audit row written when the upstream call throws.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('client error with .status property (e.g. 503) propagates status + code', async () => {
    const err = new Error('AdsGPT provider unreachable');
    err.status = 503;
    err.code = 'ADSGPT_UNREACHABLE';
    adsGptClient.fetchAdReport.mockRejectedValue(err);

    const res = await request(makeApp())
      .get('/api/adsgpt/reports/ads')
      .query({ subBrand: 'tmc' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'ADSGPT_UNREACHABLE',
      error: 'AdsGPT provider unreachable',
    });
  });

  test('tenantId comes from req.user.tenantId, not from any client-controlled query', async () => {
    // JWT pins tenantId=42; query attempts to spoof tenantId=99.
    adsGptClient.fetchAdReport.mockResolvedValue({
      stub: true, tenantId: 42, subBrand: 'tmc', platform: 'all',
      window: {}, metrics: {}, rows: [], note: 'stub',
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 7, role: 'ADMIN', tenantId: 42, isActive: true,
    });

    const res = await request(makeApp())
      .get('/api/adsgpt/reports/ads')
      .query({ subBrand: 'tmc', tenantId: '99' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 42 })}`);

    expect(res.status).toBe(200);
    // The spoofed tenantId=99 in the query is ignored; JWT's 42 wins.
    expect(adsGptClient.fetchAdReport).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 42 }),
    );
  });
});

describe('GET /api/adsgpt/cap-status — extended coverage', () => {
  test('missing Authorization header → 401 (verifyToken gate fires before role gate)', async () => {
    const res = await request(makeApp())
      .get('/api/adsgpt/cap-status');
    // No Authorization header.

    expect(res.status).toBe(401);
    expect(adsGptClient.checkBudgetCap).not.toHaveBeenCalled();
  });

  test('client throws ADSGPT_BUDGET_EXCEEDED → 402 with structured error body', async () => {
    const err = new Error('Monthly AdsGPT spend cap reached for this tenant.');
    err.code = 'ADSGPT_BUDGET_EXCEEDED';
    err.spentCents = 6000;
    err.capCents = 5000;
    adsGptClient.checkBudgetCap.mockRejectedValue(err);

    const res = await request(makeApp())
      .get('/api/adsgpt/cap-status')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      code: 'ADSGPT_BUDGET_EXCEEDED',
      spentCents: 6000,
      capCents: 5000,
    });
    expect(res.body.error).toMatch(/cap/i);
  });

  test('generic client error (no .code) → 500 "Failed to read cap status"', async () => {
    adsGptClient.checkBudgetCap.mockRejectedValue(new Error('db hiccup'));

    const res = await request(makeApp())
      .get('/api/adsgpt/cap-status')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to read cap status' });
  });
});
