// @ts-check
/**
 * PRD_TRAVEL §4.5 + §9.1 — Travel Stall personalised-PDF regen route
 * contract tests (Travel Stall is sub-brand #3 of 4: TMC / RFU /
 * **travelstall** / VisaSure).
 *
 * Pins backend/routes/travel_travelstall.js — currently a single endpoint:
 *   POST /api/travel/travelstall/personalised-pdf/regen
 *     - Auth: verifyToken + verifyRole(['ADMIN','MANAGER'])
 *     - Vertical guard: requireTravelTenant (tenant.vertical === 'travel')
 *     - Loads contact (tenant-scoped) + optional latest TravelDiagnostic
 *       (subBrand='travelstall')
 *     - Calls llmRouter.routeRequest({ task: "bulk-text", payload, tenantId })
 *     - Renders branded PDF via pdfRenderer.renderTravelStallPersonalisedPdf
 *     - Returns { pdfUrl (data:application/pdf;base64,...), generatedAt,
 *       model, stub } at status 201
 *
 * What's pinned
 * -------------
 *   - 401 unauthenticated
 *   - 403 RBAC_DENIED for USER role
 *   - 403 WRONG_VERTICAL for non-travel tenant
 *   - 201 happy path: data: URL pdfUrl, model, stub:true bubbled from
 *     stub-mode llmRouter envelope
 *   - 400 INVALID_CONTACT_ID (missing / non-positive)
 *   - 404 CONTACT_NOT_FOUND (contact outside tenant)
 *   - 400 INVALID_DESTINATIONS (non-array / non-string entries)
 *   - 400 INVALID_BUDGET (non-numeric / negative)
 *   - 400 INVALID_DURATION (non-integer / zero / negative)
 *   - PII discipline: payload sent to llmRouter contains contact NAME
 *     only — never email / phone (PRD §9.1 lock)
 *   - Tenant + sub-brand isolation: contact.findFirst scoped to
 *     req.travelTenant.id; findLatestDiagnostic called with
 *     subBrand='travelstall' (Travel Stall = one of 4 sub-brands;
 *     would mistakenly query 'tmc'/'rfu'/'visasure' if the route had
 *     a slug bug)
 *   - 500 PDF_RENDER_FAILED when renderer throws unexpectedly
 *
 * Test pattern mirrors backend/test/routes/travel_personalised_destinations.test.js
 * (4th LLM consumer of lib/llmRouter — same Module._cache override pattern).
 * Also picks up the requireTravelTenant prisma.tenant.findUnique pattern
 * from travel-rfu-profiles.test.js. JWT signed with the dev fallback
 * secret the middleware uses; verifyToken stays in the chain so auth-gate
 * is exercised end-to-end.
 *
 * Why mocked llmRouter (not the real stub-mode router): keeps the
 * unit-test gate fast + isolated, AND lets us assert the EXACT arguments
 * passed in (PII discipline — `payload.contact` must be `{ name }` only,
 * not the raw contact row with email/phone).
 *
 * Why mocked pdfRenderer: the real renderer instantiates PDFKit, embeds
 * fonts, writes to a stream — slow + filesystem-touching. Mocking returns
 * a tiny Buffer so we can verify base64 wrapping without paying the I/O.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
// requireTravelTenant calls prisma.tenant.findUnique
// The route calls prisma.contact.findFirst + findLatestDiagnostic
// (which internally calls prisma.travelDiagnostic.findFirst).
// verifyToken middleware looks up prisma.revokedToken.findUnique.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.travelDiagnostic = prisma.travelDiagnostic || {};
prisma.travelDiagnostic.findFirst = vi.fn().mockResolvedValue(null);
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Patch lib/llmRouter via Module._cache BEFORE requiring the route so
// the route's `require("../lib/llmRouter")` binds to our mock.
const llmRouterMock = {
  routeRequest: vi.fn().mockResolvedValue({
    text: '[STUB-BULK-TEXT] Travel Stall destination prose (synthetic). Real Gemini lands when Q11 keys arrive.',
    finishReason: 'stop',
    usage: { promptTokens: 50, completionTokens: 200, totalTokens: 250 },
    model: 'gemini-2.5-flash',
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

// Same trick for services/pdfRenderer — the route destructures
// renderTravelStallPersonalisedPdf at require-time, so we MUST install
// the cache override before the router require below.
const pdfRendererMock = {
  renderTravelStallPersonalisedPdf: vi.fn().mockResolvedValue(
    Buffer.from('%PDF-1.4 stub travelstall', 'utf8'),
  ),
};
const pdfRendererPath = requireCJS.resolve('../../services/pdfRenderer');
require('node:module')._cache[pdfRendererPath] = {
  id: pdfRendererPath,
  filename: pdfRendererPath,
  loaded: true,
  exports: pdfRendererMock,
  children: [],
  paths: [],
};

const travelTravelstallRouter = requireCJS('../../routes/travel_travelstall');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelTravelstallRouter);
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
    contactId: 100,
    destinations: ['Maldives', 'Bali', 'Phuket'],
    budget: 350_000,
    durationDays: 7,
    ...overrides,
  };
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.contact.findFirst.mockReset().mockResolvedValue({
    id: 100, name: 'Anita Sharma', email: 'anita@example.com', phone: '+91-98xxxxxx21',
  });
  prisma.travelDiagnostic.findFirst.mockReset().mockResolvedValue(null);
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  llmRouterMock.routeRequest.mockReset().mockResolvedValue({
    text: '[STUB-BULK-TEXT] Travel Stall destination prose (synthetic). Real Gemini lands when Q11 keys arrive.',
    finishReason: 'stop',
    usage: { promptTokens: 50, completionTokens: 200, totalTokens: 250 },
    model: 'gemini-2.5-flash',
    stub: true,
  });
  pdfRendererMock.renderTravelStallPersonalisedPdf
    .mockReset()
    .mockResolvedValue(Buffer.from('%PDF-1.4 stub travelstall', 'utf8'));
});

describe('mount + auth gates', () => {
  test('endpoint mounted at POST /api/travel/travelstall/personalised-pdf/regen', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    // NOT 404 — mount confirmed; 201 = happy-path success.
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(201);
  });

  test('unauthenticated request → 401', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .send(validBody());
    expect(res.status).toBe(401);
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
    expect(pdfRendererMock.renderTravelStallPersonalisedPdf).not.toHaveBeenCalled();
  });

  test('USER role → 403 (RBAC denied — ADMIN/MANAGER only)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(validBody());
    expect(res.status).toBe(403);
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
    expect(pdfRendererMock.renderTravelStallPersonalisedPdf).not.toHaveBeenCalled();
  });

  test('MANAGER role → 201 (per route guard verifyRole([ADMIN,MANAGER]))', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body.stub).toBe(true);
  });
});

describe('vertical guard (requireTravelTenant)', () => {
  test('non-travel tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({
      id: 1, vertical: 'wellness', name: 'Wellness Co', slug: 'wellness-co',
    });
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    // Guard short-circuits: no contact lookup, no LLM call, no PDF render.
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
    expect(pdfRendererMock.renderTravelStallPersonalisedPdf).not.toHaveBeenCalled();
  });
});

describe('happy path — envelope + PII discipline + sub-brand isolation', () => {
  test('201 envelope shape: pdfUrl=data:application/pdf;base64,..., model, stub, generatedAt ISO', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      model: 'gemini-2.5-flash',
      stub: true,
    });
    expect(typeof res.body.pdfUrl).toBe('string');
    expect(res.body.pdfUrl).toMatch(/^data:application\/pdf;base64,/);
    // Base64 of '%PDF-1.4 stub travelstall' is non-empty.
    expect(res.body.pdfUrl.length).toBeGreaterThan('data:application/pdf;base64,'.length);
    // generatedAt is ISO-8601 (Date.toISOString() output).
    expect(res.body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('llmRouter called with task="bulk-text" + payload.subBrand="travelstall" + PII-minimal contact', async () => {
    await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());

    expect(llmRouterMock.routeRequest).toHaveBeenCalledTimes(1);
    const callArgs = llmRouterMock.routeRequest.mock.calls[0][0];
    expect(callArgs).toMatchObject({
      task: 'bulk-text',
      tenantId: 1,
    });
    // Sub-brand discipline: travelstall, NOT tmc/rfu/visasure.
    expect(callArgs.payload.subBrand).toBe('travelstall');
    // PII discipline: contact NAME only — never email / phone.
    expect(callArgs.payload.contact).toEqual({ name: 'Anita Sharma' });
    expect(JSON.stringify(callArgs.payload)).not.toContain('anita@example.com');
    expect(JSON.stringify(callArgs.payload)).not.toContain('98xxxxxx21');
    // Trip-shape fields forwarded.
    expect(callArgs.payload.destinations).toEqual(['Maldives', 'Bali', 'Phuket']);
    expect(callArgs.payload.budget).toBe(350_000);
    expect(callArgs.payload.durationDays).toBe(7);
  });

  test('contact lookup is tenant-scoped (tenantId from req.travelTenant.id, not from body)', async () => {
    await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send({ ...validBody(), tenantId: 99 /* attempted spoof — stripped by global stripDangerous in real stack; harmless here */ });
    expect(prisma.contact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 100, tenantId: 1 }),
      }),
    );
  });

  test('findLatestDiagnostic called with subBrand="travelstall" — sub-brand isolation pin', async () => {
    await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(prisma.travelDiagnostic.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          contactId: 100,
          subBrand: 'travelstall',
        }),
      }),
    );
  });

  test('diagnostic absent → payload.diagnostic = null (prose still renders without tier framing)', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(201);
    const callArgs = llmRouterMock.routeRequest.mock.calls[0][0];
    expect(callArgs.payload.diagnostic).toBeNull();
  });

  test('diagnostic present → payload.diagnostic carries classification + recommendedTier + score', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue({
      id: 5,
      score: 72,
      classification: 'aspirational',
      classificationLabel: 'Aspirational family traveller',
      recommendedTier: 'premium',
      createdAt: new Date('2026-05-20T10:00:00Z'),
    });
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(201);
    const callArgs = llmRouterMock.routeRequest.mock.calls[0][0];
    expect(callArgs.payload.diagnostic).toMatchObject({
      classification: 'aspirational',
      classificationLabel: 'Aspirational family traveller',
      recommendedTier: 'premium',
      score: 72,
    });
  });

  test('renderer receives proseText from llmRouter result + the trip-shape inputs', async () => {
    await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(pdfRendererMock.renderTravelStallPersonalisedPdf).toHaveBeenCalledTimes(1);
    const rendererArgs = pdfRendererMock.renderTravelStallPersonalisedPdf.mock.calls[0][0];
    expect(rendererArgs).toMatchObject({
      destinations: ['Maldives', 'Bali', 'Phuket'],
      budget: 350_000,
      durationDays: 7,
      proseText: expect.stringContaining('[STUB-BULK-TEXT]'),
    });
    // Renderer also gets the contact + generatedAt for the PDF header.
    expect(rendererArgs.contact).toMatchObject({ id: 100, name: 'Anita Sharma' });
    expect(typeof rendererArgs.generatedAt).toBe('string');
  });
});

describe('validation — body shape', () => {
  test('missing contactId → 400 INVALID_CONTACT_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ destinations: ['Bali'] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CONTACT_ID' });
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
  });

  test('contactId=0 → 400 INVALID_CONTACT_ID (must be positive)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 0 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CONTACT_ID' });
  });

  test('contactId="not-a-number" → 400 INVALID_CONTACT_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CONTACT_ID' });
  });

  test('contact outside tenant → 404 CONTACT_NOT_FOUND', async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CONTACT_NOT_FOUND' });
    expect(llmRouterMock.routeRequest).not.toHaveBeenCalled();
    expect(pdfRendererMock.renderTravelStallPersonalisedPdf).not.toHaveBeenCalled();
  });

  test('destinations not an array → 400 INVALID_DESTINATIONS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 100, destinations: 'Bali' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DESTINATIONS' });
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('destinations array with empty-string entry → 400 INVALID_DESTINATIONS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 100, destinations: ['Bali', ''] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DESTINATIONS' });
  });

  test('destinations array with non-string entry → 400 INVALID_DESTINATIONS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 100, destinations: ['Bali', 42] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DESTINATIONS' });
  });

  test('budget negative → 400 INVALID_BUDGET', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 100, budget: -1 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_BUDGET' });
  });

  test('budget="not-a-number" → 400 INVALID_BUDGET', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 100, budget: 'lots' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_BUDGET' });
  });

  test('durationDays=0 → 400 INVALID_DURATION (must be positive integer)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 100, durationDays: 0 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DURATION' });
  });

  test('durationDays=3.5 → 400 INVALID_DURATION (must be integer)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 100, durationDays: 3.5 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DURATION' });
  });
});

describe('optional fields', () => {
  test('omitting destinations/budget/durationDays still returns 201 (only contactId required)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 100 });
    expect(res.status).toBe(201);
    expect(res.body.stub).toBe(true);
    const callArgs = llmRouterMock.routeRequest.mock.calls[0][0];
    expect(callArgs.payload.destinations).toBeNull();
    expect(callArgs.payload.budget).toBeNull();
    expect(callArgs.payload.durationDays).toBeNull();
  });

  test('budget=null + durationDays=null accepted (explicit-null path, not omitted)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ contactId: 100, budget: null, durationDays: null });
    expect(res.status).toBe(201);
  });
});

describe('error paths', () => {
  test('renderer throws → 500 PDF_RENDER_FAILED (LLM result obtained but render failed)', async () => {
    pdfRendererMock.renderTravelStallPersonalisedPdf.mockRejectedValue(
      new Error('PDFKit ran out of memory'),
    );
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'PDF_RENDER_FAILED' });
    // The LLM was called; the failure is downstream of routing.
    expect(llmRouterMock.routeRequest).toHaveBeenCalledTimes(1);
  });

  test('llmRouter throws tagged error (status+code) → forwarded as-is', async () => {
    const err = new Error('LLM budget cap reached');
    /** @type {any} */ (err).status = 429;
    /** @type {any} */ (err).code = 'LLM_BUDGET_EXCEEDED';
    llmRouterMock.routeRequest.mockRejectedValue(err);
    const res = await request(makeApp())
      .post('/api/travel/travelstall/personalised-pdf/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(validBody());
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'LLM_BUDGET_EXCEEDED' });
    // Renderer never called because routing failed first.
    expect(pdfRendererMock.renderTravelStallPersonalisedPdf).not.toHaveBeenCalled();
  });
});
