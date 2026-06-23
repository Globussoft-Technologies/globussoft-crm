// PR-E Phase 2.3 — vitest coverage for the TEE-aware route surface.
//
// Endpoints pinned by this file:
//   POST /api/landing-pages/generate-with-tee
//     - input validation (destination required + length, durationDays,
//       audience length, subBrand allowlist)
//     - autoCreate=false → preview shape (no DB write, returns content +
//       teeOutput + templateType)
//     - autoCreate=true → DRAFT row created with AI_GENERATION snapshot
//     - tenant scoping on the new page (tenantId pulled from req.user)
//     - response carries the TEE decision log (family / themeId /
//       composition / traits)
//
//   POST /api/landing-pages/:id/tee/reclassify
//     - 401 without auth
//     - 404 for cross-tenant page
//     - 400 when page lacks destination metadata and body doesn't supply one
//     - happy path returns { tee: { family, themeId, traits, ... } }
//     - body overrides (tripType / audience / _teeOverrides) flow through
//
//   GET /api/landing-pages/:id/preview?version=N
//     - happy path renders the snapshot through the production renderer
//     - 400 on invalid version param
//     - 404 when version doesn't exist
//     - X-Preview-Source response header reflects the source (live vs version:N)
//
// Pattern matches test/routes/landing-pages.test.js — prisma singleton
// patched BEFORE the router is required; jsonwebtoken used to mint
// HS256 tokens; supertest drives the express app.

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ─── Prisma singleton patch (must run BEFORE the router is required) ──
prisma.landingPage = prisma.landingPage || {};
Object.assign(prisma.landingPage, {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
});
prisma.$transaction = vi.fn(async (ops) => Promise.all(Array.isArray(ops) ? ops : []));
prisma.landingPageVersion = prisma.landingPageVersion || {};
Object.assign(prisma.landingPageVersion, {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
});
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
// llmRouter consults these for budget cap + audit log; both are best-effort
// so we just return safe defaults.
prisma.tenantSetting = prisma.tenantSetting || {};
prisma.tenantSetting.findUnique = vi.fn().mockResolvedValue(null);
prisma.tenantSetting.findFirst = vi.fn().mockResolvedValue(null);
prisma.llmCallLog = prisma.llmCallLog || {};
prisma.llmCallLog.aggregate = vi.fn().mockResolvedValue({ _sum: { costEstimate: 0 } });
prisma.llmCallLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.supplierCredential = prisma.supplierCredential || {};
prisma.supplierCredential.findFirst = vi.fn().mockResolvedValue(null);
// generator + tee modules are real — we ask them to run in stub mode by
// keeping NODE_ENV=test, which the llmRouter respects.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const { router: authedRouter } = requireCJS('../../routes/landing_pages');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/landing-pages', authedRouter);
  return app;
}

function tokenFor({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return jwt.sign({ userId, tenantId, role, email: 'admin@test.local' }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  prisma.landingPage.findFirst.mockReset();
  prisma.landingPage.create.mockReset();
  prisma.landingPage.update.mockReset();
  prisma.landingPageVersion.findFirst.mockReset();
  prisma.landingPageVersion.findMany.mockReset();
  prisma.landingPageVersion.create.mockReset().mockResolvedValue({ id: 1, versionNumber: 1 });
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ slug: 'travel-stall' });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

// ─── POST /generate-with-tee ─────────────────────────────────────────

describe('POST /api/landing-pages/generate-with-tee', () => {
  test('401 without Bearer token', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages/generate-with-tee')
      .send({ destination: 'Iceland', durationDays: 8 });
    expect(res.status).toBe(401);
    expect(prisma.landingPage.create).not.toHaveBeenCalled();
  });

  test('400 when destination missing', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages/generate-with-tee')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ durationDays: 8 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DESTINATION');
  });

  test('400 when destination > 80 chars', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages/generate-with-tee')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ destination: 'x'.repeat(81), durationDays: 8 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DESTINATION');
  });

  test('400 when durationDays out of 1..60 range', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages/generate-with-tee')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ destination: 'Iceland', durationDays: 99 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DURATION');
  });

  test('400 on unknown subBrand', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages/generate-with-tee')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ destination: 'Bali', durationDays: 7, subBrand: 'totallynotreal' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUB_BRAND');
  });

  test('autoCreate=false: returns content + teeOutput + templateType WITHOUT writing the DB', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages/generate-with-tee')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({
        destination: 'Iceland Reykjavik',
        durationDays: 8,
        audience: 'couples photographers',
        tripType: 'luxury',
        autoCreate: false,
        skipImages: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.templateType).toBe('luxury-tour-v1');
    expect(res.body.teeOutput.family).toBe('luxury');
    expect(res.body.teeOutput.themeId).toBe('luxury-alpine');
    expect(res.body.content).toBeTruthy();
    expect(prisma.landingPage.create).not.toHaveBeenCalled();
    expect(prisma.landingPageVersion.create).not.toHaveBeenCalled();
  });

  test('autoCreate=true (default): persists DRAFT, creates AI_GENERATION snapshot', async () => {
    let createCallCount = 0;
    prisma.landingPage.create.mockImplementation(async ({ data }) => {
      createCallCount += 1;
      return { id: 100, tenantId: 1, ...data, createdAt: new Date(), updatedAt: new Date() };
    });
    const res = await request(makeApp())
      .post('/api/landing-pages/generate-with-tee')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({
        destination: 'Iceland Reykjavik',
        durationDays: 8,
        audience: 'couples',
        tripType: 'luxury',
        skipImages: true,
      });
    expect(res.status).toBe(201);
    expect(createCallCount).toBe(1);
    const createArgs = prisma.landingPage.create.mock.calls[0][0].data;
    expect(createArgs.status).toBe('DRAFT');
    expect(createArgs.templateType).toBe('luxury-tour-v1');
    expect(createArgs.tenantId).toBe(1);
    expect(createArgs.userId).toBe(7);
    expect(createArgs.generatedByAi).toBe(true);
    expect(createArgs.destination).toBe('Iceland Reykjavik');
    // Version snapshot was attempted.
    expect(prisma.landingPageVersion.create).toHaveBeenCalled();
  });

  test('response includes TEE decision log (family / themeId / composition / traits)', async () => {
    prisma.landingPage.create.mockImplementation(async ({ data }) => ({
      id: 100, tenantId: 1, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));
    const res = await request(makeApp())
      .post('/api/landing-pages/generate-with-tee')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ destination: 'Bali Indonesia', durationDays: 7, audience: 'families', tripType: 'family', skipImages: true });
    expect(res.status).toBe(201);
    expect(res.body.tee).toBeTruthy();
    expect(res.body.tee.family).toBe('family');
    expect(res.body.tee.themeId).toBe('family-tropical');
    expect(Array.isArray(res.body.tee.composition)).toBe(true);
    expect(res.body.tee.traits.climate).toBe('tropical');
    expect(res.body.tee.decisionLog).toBeTruthy();
  });

  test('slug allocation retries on P2002 collision', async () => {
    let attempt = 0;
    prisma.landingPage.create.mockImplementation(async ({ data }) => {
      attempt += 1;
      if (attempt < 3) {
        const err = new Error('Unique constraint');
        err.code = 'P2002';
        throw err;
      }
      return { id: 100, tenantId: 1, ...data, createdAt: new Date(), updatedAt: new Date() };
    });
    const res = await request(makeApp())
      .post('/api/landing-pages/generate-with-tee')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ destination: 'Bali', durationDays: 7, audience: 'families', tripType: 'family', skipImages: true });
    expect(res.status).toBe(201);
    expect(attempt).toBe(3);
  });

  test('Iceland (new destination) routes to luxury-alpine without any new code', async () => {
    prisma.landingPage.create.mockImplementation(async ({ data }) => ({
      id: 100, tenantId: 1, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));
    const res = await request(makeApp())
      .post('/api/landing-pages/generate-with-tee')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ destination: 'Iceland', durationDays: 8, audience: 'couples', tripType: 'luxury', skipImages: true });
    expect(res.status).toBe(201);
    expect(res.body.tee.themeId).toBe('luxury-alpine');
    expect(res.body.tee.traits.climate).toBe('alpine');
  });

  test('Vietnam (new destination) routes to family-tropical without any new code', async () => {
    prisma.landingPage.create.mockImplementation(async ({ data }) => ({
      id: 100, tenantId: 1, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));
    const res = await request(makeApp())
      .post('/api/landing-pages/generate-with-tee')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ destination: 'Vietnam Halong', durationDays: 8, audience: 'families with kids', tripType: 'family', skipImages: true });
    expect(res.status).toBe(201);
    expect(res.body.tee.themeId).toBe('family-tropical');
  });
});

// ─── POST /:id/tee/reclassify ────────────────────────────────────────

describe('POST /api/landing-pages/:id/tee/reclassify', () => {
  test('401 without Bearer', async () => {
    const res = await request(makeApp())
      .post('/api/landing-pages/42/tee/reclassify')
      .send({});
    expect(res.status).toBe(401);
  });

  test('404 for cross-tenant page', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/landing-pages/42/tee/reclassify')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ destination: 'Iceland' });
    expect(res.status).toBe(404);
  });

  test('400 when neither page metadata nor body supplies destination', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({ id: 42, tenantId: 1, destination: null });
    const res = await request(makeApp())
      .post('/api/landing-pages/42/tee/reclassify')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_DESTINATION');
  });

  test('happy path: returns { tee: { family, themeId, composition, traits, decisionLog, imageStrategy } }', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({ id: 42, tenantId: 1, destination: 'Iceland', subBrand: null });
    const res = await request(makeApp())
      .post('/api/landing-pages/42/tee/reclassify')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ tripType: 'luxury', audience: 'couples', durationDays: 8 });
    expect(res.status).toBe(200);
    expect(res.body.tee).toBeTruthy();
    expect(res.body.tee.family).toBe('luxury');
    expect(res.body.tee.themeId).toBe('luxury-alpine');
    expect(res.body.tee.traits).toBeTruthy();
    expect(res.body.tee.imageStrategy).toBeTruthy();
  });

  test('body _teeOverrides bypass classifiers (operator override)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({ id: 42, tenantId: 1, destination: 'Iceland', subBrand: null });
    const res = await request(makeApp())
      .post('/api/landing-pages/42/tee/reclassify')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({
        tripType: 'luxury',
        _teeOverrides: { family: 'family', themeId: 'family-tropical' },
      });
    expect(res.status).toBe(200);
    expect(res.body.tee.family).toBe('family');
    expect(res.body.tee.themeId).toBe('family-tropical');
  });

  test('operator can what-if a different tripType without touching the persisted page', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({ id: 42, tenantId: 1, destination: 'Bali', subBrand: null });
    const r1 = await request(makeApp())
      .post('/api/landing-pages/42/tee/reclassify')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ tripType: 'family', audience: 'families' });
    expect(r1.body.tee.family).toBe('family');
    // Flip tripType — no DB writes, just re-classification.
    const r2 = await request(makeApp())
      .post('/api/landing-pages/42/tee/reclassify')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ tripType: 'luxury', audience: 'couples' });
    expect(r2.body.tee.family).toBe('luxury');
    expect(prisma.landingPage.update).not.toHaveBeenCalled();
  });
});

// ─── GET /:id/preview?version=N ──────────────────────────────────────

describe('GET /api/landing-pages/:id/preview?version=N — historical snapshot preview', () => {
  test('400 on invalid version param', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, slug: 'x', title: 'X', content: '{}', templateType: null,
    });
    const res = await request(makeApp())
      .get('/api/landing-pages/42/preview?version=garbage')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(400);
  });

  test('404 when versionNumber does not exist', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, slug: 'x', title: 'X', content: '{}', templateType: null,
    });
    prisma.landingPageVersion.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/landing-pages/42/preview?version=99')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(404);
    expect(res.text).toContain('Version 99 not found');
  });

  test('happy path: renders the snapshot using the SAME production renderer + sets X-Preview-Source header', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, slug: 'live-slug', title: 'Live Title',
      content: JSON.stringify([{ type: 'heading', props: { text: 'LIVE STATE' } }]),
      templateType: null,
    });
    prisma.landingPageVersion.findFirst.mockResolvedValue({
      content: JSON.stringify([{ type: 'heading', props: { text: 'HISTORICAL SNAPSHOT V3' } }]),
      title: 'Historical Title V3',
      slug: 'live-slug',
      source: 'MANUAL_SAVE',
      versionNumber: 3,
    });
    const res = await request(makeApp())
      .get('/api/landing-pages/42/preview?version=3')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['x-preview-source']).toBe('version:3');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['cache-control']).toContain('no-store');
    // Renders the SNAPSHOT content, not the live content.
    expect(res.text).toContain('HISTORICAL SNAPSHOT V3');
    expect(res.text).not.toContain('LIVE STATE');
  });

  test('without ?version → live-state preview (X-Preview-Source: live-draft)', async () => {
    prisma.landingPage.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, slug: 'x', title: 'X',
      content: JSON.stringify([{ type: 'heading', props: { text: 'LIVE STATE' } }]),
      templateType: null,
    });
    const res = await request(makeApp())
      .get('/api/landing-pages/42/preview')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(200);
    expect(res.headers['x-preview-source']).toBe('live-draft');
    expect(res.text).toContain('LIVE STATE');
    // Versions endpoint was NOT consulted on the live-state preview.
    expect(prisma.landingPageVersion.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant page returns 404', async () => {
    prisma.landingPage.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/landing-pages/42/preview?version=1')
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(res.status).toBe(404);
  });
});
