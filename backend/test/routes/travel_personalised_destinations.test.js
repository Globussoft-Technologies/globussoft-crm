// @ts-check
/**
 * TS18 Phase 2 SHELL — Travel Stall personalised destination recommender
 * (LLM consumer) route contract tests (tick #185, 2026-05-24).
 *
 * Pins backend/routes/travel_personalised_destinations.js:
 *   - Endpoint mounted at POST /api/travel-personalised-destinations/recommend
 *   - Auth: verifyToken + verifyRole(['ADMIN','MANAGER'])
 *   - Stub-mode envelope shape from lib/llmRouter.routeRequest
 *     ({ text, finishReason, usage, model, stub:true })
 *   - destinations: null in Phase 2 SHELL (parser lands Phase 2.5)
 *   - Validation surface: customerName / budgetINR / travelMonth /
 *     partySize / interests / pastDestinations
 *
 * Test pattern mirrors backend/test/routes/embassy_rules.test.js +
 * backend/test/routes/travel_curriculum.test.js — patch the
 * lib/llmRouter singleton BEFORE requiring the router so the
 * require()'d router binds to the spy'd routeRequest. JWT minted
 * with the same dev-fallback secret the middleware uses; verifyToken
 * runs in the chain (no bypass) so auth-gates are exercised end-to-end.
 *
 * Why mocked llmRouter (not the real stub-mode router): keeps the
 * unit-test gate fast + isolated. The stub-mode router would also
 * work here (it's deterministic) but mocking lets us assert the
 * exact arguments passed in and shape the failure paths.
 *
 * Why mocked prisma: verifyToken middleware looks up RevokedToken;
 * without the stub the lookup throws against an uninitialised
 * Prisma client. Mock is the same pattern used by embassy_rules.test.js.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router. Only revokedToken is needed
// (verifyToken's lookup) — this route doesn't touch any Prisma model.
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Patch lib/llmRouter via Module._cache BEFORE requiring the route so
// the route's `require("../lib/llmRouter")` binds to our mock. The ESM
// default-import would wrap the CJS exports in a Module Namespace object,
// not give us a write-through reference. The cache-replacement pattern
// here mirrors backend/test/lib/llmRouter.test.js's prismaMock approach.
const llmRouterMock = {
  routeRequest: vi.fn().mockResolvedValue({
    text: '[STUB-REASONING] Reasoning output (synthetic). Real Gemini Flash/GPT lands when Q11 keys arrive.',
    finishReason: 'stop',
    usage: { promptTokens: 42, completionTokens: 24, totalTokens: 66 },
    model: 'gemini-flash',
    stub: true,
  }),
};
const llmRouterPath = requireCJS.resolve('../../lib/llmRouter');
require('node:module')._cache[llmRouterPath] = {
  id: llmRouterPath,
  filename: llmRouterPath,
  loaded: true,
  exports: llmRouterMock,
  children: [],
  paths: [],
};

const travelPersonalisedDestinationsRouter = requireCJS(
  '../../routes/travel_personalised_destinations',
);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel-personalised-destinations', travelPersonalisedDestinationsRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function validBody(overrides = {}) {
  return {
    customerName: 'Anita Sharma',
    budgetINR: 200_000,
    travelMonth: 'december',
    partySize: 4,
    interests: ['beaches', 'family-friendly'],
    pastDestinations: ['Goa', 'Pondicherry'],
    ...overrides,
  };
}

beforeAll(() => {
  // No-op: stubs already installed above.
});

beforeEach(() => {
  llmRouterMock.routeRequest.mockReset();
  prisma.revokedToken.findUnique.mockResolvedValue(null);
  // Reinstall the default deterministic stub-mode envelope so each
  // test starts from a known-happy router. Cases that need a different
  // router behaviour (errors, budget-cap) override per case.
  llmRouterMock.routeRequest.mockResolvedValue({
    text: '[STUB-REASONING] Reasoning output (synthetic). Real Gemini Flash/GPT lands when Q11 keys arrive.',
    finishReason: 'stop',
    usage: { promptTokens: 42, completionTokens: 24, totalTokens: 66 },
    model: 'gemini-flash',
    stub: true,
  });
});

describe('mount + auth', () => {
  test('endpoint mounted at POST /api/travel-personalised-destinations/recommend', async () => {
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    // Mount confirmed: NOT 404 (which would mean Express never found the
    // route handler at all). 200 = happy-path success.
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
  });

  test('unauthenticated request → 401', async () => {
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .send(validBody());
    expect(res.status).toBe(401);
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
  });

  test('USER role → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(validBody());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
  });
});

describe('happy path — stub-mode envelope shape', () => {
  test('ADMIN with valid body → 200 + envelope { text, model, stub: true }', async () => {
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      text: expect.stringContaining('[STUB-REASONING]'),
      model: 'gemini-flash',
      stub: true,
      finishReason: 'stop',
      destinations: null,
    });
    expect(res.body.usage).toMatchObject({
      promptTokens: 42,
      completionTokens: 24,
      totalTokens: 66,
    });
    // Router was called with the right task + tenantId + surface hint.
    expect(llmRouterMock.routeRequest).toHaveBeenCalledTimes(1);
    const callArgs = llmRouterMock.routeRequest.mock.calls[0][0];
    expect(callArgs).toMatchObject({
      task: 'reasoning',
      tenantId: 1,
      __userId: 7,
      __surface: 'personalised-destinations',
    });
    // Prompt MUST contain the structured customer profile fields.
    expect(callArgs.prompt).toContain('Anita Sharma');
    expect(callArgs.prompt).toContain('200000');
    expect(callArgs.prompt).toContain('december');
  });

  test('MANAGER with valid body → 200', async () => {
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send(validBody());
    expect(res.status).toBe(200);
    expect(res.body.stub).toBe(true);
    expect(llmRouterMock.routeRequest).toHaveBeenCalledTimes(1);
  });
});

describe('validation — INVALID_PAYLOAD / BUDGET_EXCEEDED', () => {
  test('missing customerName → 400 INVALID_PAYLOAD', async () => {
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody({ customerName: undefined }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
  });

  test('budgetINR=0 → 400 INVALID_PAYLOAD', async () => {
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody({ budgetINR: 0 }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
  });

  test('budgetINR above cap → 400 BUDGET_EXCEEDED', async () => {
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody({ budgetINR: 50_000_000 }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
  });

  test("travelMonth='blue' → 400 INVALID_PAYLOAD", async () => {
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody({ travelMonth: 'blue' }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
  });

  test('partySize=25 → 400 INVALID_PAYLOAD', async () => {
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody({ partySize: 25 }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
  });
});

describe('validation — array bounds', () => {
  test('interests > 10 entries → 400 INVALID_PAYLOAD', async () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `tag-${i}`);
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody({ interests: tooMany }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(res.body.error).toMatch(/interests/);
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
  });

  test('pastDestinations > 20 entries → 400 INVALID_PAYLOAD', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `place-${i}`);
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody({ pastDestinations: tooMany }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(res.body.error).toMatch(/pastDestinations/);
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
  });
});

describe('error paths — LLM_BUDGET_EXCEEDED + LLM_ERROR', () => {
  test('router throws LLM_BUDGET_EXCEEDED → 429 forwarded', async () => {
    const err = new Error('Monthly LLM spend cap reached for this tenant.');
    /** @type {any} */ (err).code = 'LLM_BUDGET_EXCEEDED';
    /** @type {any} */ (err).spentCents = 10500;
    /** @type {any} */ (err).capCents = 10000;
    llmRouterMock.routeRequest.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      code: 'LLM_BUDGET_EXCEEDED',
      spentCents: 10500,
      capCents: 10000,
    });
  });

  test('router throws generic error → 502 LLM_ERROR', async () => {
    llmRouterMock.routeRequest.mockRejectedValue(new Error('socket hang up'));

    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'LLM_ERROR' });
  });
});

describe('optional fields default to []', () => {
  test('omitting interests + pastDestinations still returns 200', async () => {
    const res = await request(makeApp())
      .post('/api/travel-personalised-destinations/recommend')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        customerName: 'Rahul Verma',
        budgetINR: 150_000,
        travelMonth: 'march',
        partySize: 2,
      });
    expect(res.status).toBe(200);
    expect(res.body.stub).toBe(true);
    const callArgs = llmRouterMock.routeRequest.mock.calls[0][0];
    // The prompt explicitly handles the "no interests" + "no past
    // destinations" wording so the LLM doesn't hallucinate empty strings.
    expect(callArgs.prompt).toMatch(/Interests: not specified/);
    expect(callArgs.prompt).toMatch(/Past destinations: none recorded/);
  });
});
