// @ts-check
/**
 * PRD_AI_CALLING_CALLIFIED — /api/callified operator-wrapper tests.
 *
 * Pins the contract for the thin wrapper added at backend/routes/callified.js,
 * which exposes services/callifiedClient.js (stub-mode today, real post Q1
 * cred handover) to UI consumers without touching the service module.
 *
 * What's pinned
 * -------------
 *   - POST /calls/initiate    ADMIN happy path returns client envelope +
 *                             writes CallifiedCall INITIATE audit.
 *   - POST /calls/initiate    missing toPhone → 400 MISSING_TO_PHONE.
 *   - POST /calls/initiate    client throws AI_CALLING_BUDGET_EXCEEDED
 *                             → 402 + structured error body.
 *   - POST /calls/initiate    client throws AI_CALLING_DISABLED
 *                             → 403 + structured error body.
 *   - GET  /cap-status        ADMIN — returns spent/cap/percent/withinCap;
 *                             USER → 403 (role gate).
 *   - GET  /enabled           returns { enabled: true } for tenant with
 *                             no override (DC-7 defaults ON).
 *   - POST /calls/initiate    API-key sub-brand mismatch (apiKeySubBrand=
 *                             'tmc' + body subBrand='rfu') → 403
 *                             SUB_BRAND_MISMATCH.
 *
 * Test pattern mirrors backend/test/routes/ratehawk.test.js (commit be67789)
 * — patch the callifiedClient module exports with vi.fn() BEFORE requiring
 * the router via the SAME require() path so the router's closure sees our
 * mutations. verifyToken + verifyRole stay in the chain (we don't bypass
 * them) so the auth gate is exercised end-to-end.
 *
 * CJS-mock seam: see the ratehawk.test.js precedent at commit be67789 —
 * vi.mock() can't reliably intercept the SUT's `require()` of a CJS
 * module under vitest with `inline: [/backend\/services\//]`. Use
 * `createRequire(import.meta.url)` to mutate the SAME require-cache
 * object the router reads. Direct vi.mock would silently miss.
 *
 * Note vs simpler AdsGPT/RateHawk wrappers: Callified has TWO structured
 * error paths — AI_CALLING_BUDGET_EXCEEDED (402) AND AI_CALLING_DISABLED
 * (403, per-tenant featureFlag DC-7). Both are explicit tests here.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Resolve callifiedClient + router via the SAME require() path the route
// uses, so mutations to module.exports propagate to the router's closure.
const callifiedClient = requireCJS('../../services/callifiedClient');
callifiedClient.initiateCall = vi.fn();
callifiedClient.fetchCallResult = vi.fn();
callifiedClient.checkBudgetCap = vi.fn();
callifiedClient.isEnabledForTenant = vi.fn();

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

const callifiedRouter = requireCJS('../../routes/callified');

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
  app.use('/api/callified', callifiedRouter);
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
  callifiedClient.initiateCall.mockReset();
  callifiedClient.fetchCallResult.mockReset();
  callifiedClient.checkBudgetCap.mockReset();
  callifiedClient.isEnabledForTenant.mockReset();
  prisma.user.findUnique.mockReset().mockResolvedValue({
    id: 7, role: 'ADMIN', tenantId: 1, isActive: true,
  });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/callified/calls/initiate', () => {
  test('ADMIN happy path returns the client envelope and writes audit', async () => {
    const cannedEnvelope = {
      stub: true,
      callId: null,
      tenantId: 1,
      subBrand: 'rfu',
      toPhone: '+919876543210',
      leadId: 42,
      intent: 'umrah-followup',
      persona: 'rfu-counsellor',
      maxDurationSeconds: 90,
      status: 'pending-cred-drop',
      note: 'Callified.ai integration pending Q1 creds.',
    };
    callifiedClient.initiateCall.mockResolvedValue(cannedEnvelope);

    const res = await request(makeApp())
      .post('/api/callified/calls/initiate')
      .send({
        subBrand: 'rfu',
        toPhone: '+919876543210',
        leadId: 42,
        intent: 'umrah-followup',
        persona: 'rfu-counsellor',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stub: true, tenantId: 1, persona: 'rfu-counsellor' });
    // Tenant came from req.user.tenantId, not the body.
    expect(callifiedClient.initiateCall).toHaveBeenCalledWith({
      tenantId: 1,
      subBrand: 'rfu',
      toPhone: '+919876543210',
      leadId: 42,
      intent: 'umrah-followup',
      persona: 'rfu-counsellor',
    });
    // Audit row written with CallifiedCall INITIATE entity/action.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'CallifiedCall',
      action: 'INITIATE',
      userId: 7,
      tenantId: 1,
    });
  });

  test('missing toPhone → 400 MISSING_TO_PHONE', async () => {
    const res = await request(makeApp())
      .post('/api/callified/calls/initiate')
      .send({
        subBrand: 'rfu',
        leadId: 42,
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_TO_PHONE' });
    expect(callifiedClient.initiateCall).not.toHaveBeenCalled();
  });

  test('client throws AI_CALLING_BUDGET_EXCEEDED → 402 with structured error', async () => {
    const err = new Error('Monthly AI calling spend cap reached for this tenant.');
    err.code = 'AI_CALLING_BUDGET_EXCEEDED';
    err.spentCents = 11000;
    err.capCents = 10000;
    callifiedClient.initiateCall.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/callified/calls/initiate')
      .send({
        toPhone: '+919876543210',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      code: 'AI_CALLING_BUDGET_EXCEEDED',
      spentCents: 11000,
      capCents: 10000,
    });
    expect(res.body.error).toMatch(/cap/i);
    // Audit MUST NOT have been written on a failed initiate.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('client throws AI_CALLING_DISABLED → 403 with structured error', async () => {
    const err = new Error('AI calling disabled for this tenant.');
    err.code = 'AI_CALLING_DISABLED';
    callifiedClient.initiateCall.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/callified/calls/initiate')
      .send({
        toPhone: '+919876543210',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'AI_CALLING_DISABLED' });
    expect(res.body.error).toMatch(/disabled/i);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('API-key sub-brand mismatch (apiKeySubBrand=tmc, body subBrand=rfu) → 403 SUB_BRAND_MISMATCH', async () => {
    const res = await request(makeApp({ apiKeySubBrand: 'tmc' }))
      .post('/api/callified/calls/initiate')
      .send({
        subBrand: 'rfu',
        toPhone: '+919876543210',
      })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_MISMATCH' });
    expect(res.body.error).toMatch(/tmc/);
    expect(res.body.error).toMatch(/rfu/);
    // Client must NOT be called when sub-brand isolation rejects the request.
    expect(callifiedClient.initiateCall).not.toHaveBeenCalled();
  });
});

describe('GET /api/callified/cap-status', () => {
  test('ADMIN returns {spentCents, capCents, percent, withinCap, alertThreshold}', async () => {
    callifiedClient.checkBudgetCap.mockResolvedValue({
      spentCents: 3600,
      capCents: 10000,
      percent: 0.36,
      withinCap: true,
      alertThreshold: false,
    });

    const res = await request(makeApp())
      .get('/api/callified/cap-status')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      spentCents: 3600,
      capCents: 10000,
      percent: 0.36,
      withinCap: true,
      alertThreshold: false,
    });
    expect(callifiedClient.checkBudgetCap).toHaveBeenCalledWith(1);
    // Cap-status is read-only — no audit fires.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('USER → 403 (ADMIN-only gate fires before client)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, role: 'USER', tenantId: 1, isActive: true,
    });

    const res = await request(makeApp())
      .get('/api/callified/cap-status')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    // checkBudgetCap MUST NOT have been called — role gate fires first.
    expect(callifiedClient.checkBudgetCap).not.toHaveBeenCalled();
  });
});

describe('GET /api/callified/enabled', () => {
  test('returns { enabled: true } for tenant with no override (DC-7 default ON)', async () => {
    callifiedClient.isEnabledForTenant.mockResolvedValue(true);

    const res = await request(makeApp())
      .get('/api/callified/enabled')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
    expect(callifiedClient.isEnabledForTenant).toHaveBeenCalledWith(1);
  });

  test('coerces falsy client return via Boolean() → { enabled: false }', async () => {
    // Per DC-7: route wraps client result with Boolean(...) — a null / undefined
    // / 0 from the service still surfaces as a strict boolean to the UI so the
    // CTA-render check stays `body.enabled === true` not truthy-coerced.
    prisma.user.findUnique.mockResolvedValue({
      id: 7, role: 'USER', tenantId: 1, isActive: true,
    });
    callifiedClient.isEnabledForTenant.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/callified/enabled')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
    // Confirms strict-boolean cast — `=== false`, not `null`/`undefined`.
    expect(res.body.enabled).toBe(false);
  });
});

describe('POST /api/callified/calls/initiate — auth/role coverage', () => {
  test('no Authorization header → 401 (verifyToken fires before handler)', async () => {
    const res = await request(makeApp())
      .post('/api/callified/calls/initiate')
      .send({ toPhone: '+919876543210' });

    expect(res.status).toBe(401);
    // Handler MUST NOT run when token is absent.
    expect(callifiedClient.initiateCall).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('USER role → 403 (verifyRole(ADMIN,MANAGER) fires before client)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, role: 'USER', tenantId: 1, isActive: true,
    });

    const res = await request(makeApp())
      .post('/api/callified/calls/initiate')
      .send({ toPhone: '+919876543210' })
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    // Role gate is upstream of validation + client + audit.
    expect(callifiedClient.initiateCall).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('MANAGER role can initiate (gate is ADMIN|MANAGER, not ADMIN-only)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 9, role: 'MANAGER', tenantId: 1, isActive: true,
    });
    callifiedClient.initiateCall.mockResolvedValue({
      stub: true, callId: 'cf-manager-1', tenantId: 1, subBrand: 'tmc',
      toPhone: '+919999000111', status: 'pending-cred-drop',
    });

    const res = await request(makeApp())
      .post('/api/callified/calls/initiate')
      .send({ subBrand: 'tmc', toPhone: '+919999000111' })
      .set('Authorization', `Bearer ${tokenFor('MANAGER', { userId: 9 })}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ callId: 'cf-manager-1', subBrand: 'tmc' });
    expect(callifiedClient.initiateCall).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/callified/calls/initiate — sub-brand resolution + propagation', () => {
  test('API-key sub-brand MATCH (apiKeySubBrand=rfu, body subBrand=rfu) passes through', async () => {
    callifiedClient.initiateCall.mockResolvedValue({
      stub: true, callId: 'cf-match-1', tenantId: 1, subBrand: 'rfu',
      toPhone: '+919876543210', status: 'pending-cred-drop',
    });

    const res = await request(makeApp({ apiKeySubBrand: 'rfu' }))
      .post('/api/callified/calls/initiate')
      .send({ subBrand: 'rfu', toPhone: '+919876543210' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Effective sub-brand is the API-key-pinned 'rfu' (matching body).
    expect(callifiedClient.initiateCall).toHaveBeenCalledWith(
      expect.objectContaining({ subBrand: 'rfu', tenantId: 1 }),
    );
  });

  test('upstream client throws with e.status — route propagates status + code', async () => {
    // Lines 108-110 of the SUT: any error carrying e.status (not the two
    // structured AI_CALLING_* codes) gets that status + code surfaced.
    const err = new Error('Lead not found');
    err.status = 404;
    err.code = 'LEAD_NOT_FOUND';
    callifiedClient.initiateCall.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/callified/calls/initiate')
      .send({ toPhone: '+919876543210', leadId: 99999 })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'LEAD_NOT_FOUND', error: 'Lead not found' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('upstream client throws unknown error (no status, no code) → 500 generic', async () => {
    // Final catch-all branch at line 111-112: covers truly unexpected errors
    // (network blip, DB connection lost, etc) — UI sees a safe 500 rather
    // than the raw stack.
    callifiedClient.initiateCall.mockRejectedValue(new Error('boom unexpected'));

    const res = await request(makeApp())
      .post('/api/callified/calls/initiate')
      .send({ toPhone: '+919876543210' })
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Failed to initiate call' });
    // The original error message is NOT leaked to the response body.
    expect(res.body.error).not.toMatch(/boom/);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/callified/calls/:callId/result', () => {
  test('happy path: delegates to fetchCallResult with tenant scope, returns envelope', async () => {
    // Currently UNDER-PINNED — no existing case covers this endpoint at all.
    const cannedResult = {
      callId: 'cf-abc-123',
      tenantId: 1,
      status: 'completed',
      durationSeconds: 67,
      recordingUrl: null,
      transcript: 'stub-mode: no transcript',
      summary: null,
    };
    callifiedClient.fetchCallResult.mockResolvedValue(cannedResult);

    const res = await request(makeApp())
      .get('/api/callified/calls/cf-abc-123/result')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cannedResult);
    // Tenant scoping — callId from URL, tenantId from JWT.
    expect(callifiedClient.fetchCallResult).toHaveBeenCalledWith({
      tenantId: 1,
      callId: 'cf-abc-123',
    });
    // Read-only — no audit row written.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('upstream throws with e.status → route propagates status + code', async () => {
    const err = new Error('Call record not found for this tenant');
    err.status = 404;
    err.code = 'CALL_NOT_FOUND';
    callifiedClient.fetchCallResult.mockRejectedValue(err);

    const res = await request(makeApp())
      .get('/api/callified/calls/cf-missing/result')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CALL_NOT_FOUND' });
    expect(res.body.error).toMatch(/not found/i);
  });
});
