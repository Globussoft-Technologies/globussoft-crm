// @ts-check
/**
 * Unit tests for backend/routes/travel_brochures.js — TMC school brochure flow.
 *
 * Pins the POST /api/travel/brochures/runs contract:
 *   - tripInput is validated server-side; missing required fields return 400
 *     with the missing keys.
 *   - goal is JSON.stringify(tripInput) passed to the engine.
 *   - styleKey defaults to 'tmc-school' for the travel sector.
 *   - the start-run response carries brand-kit soft warnings.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);

// Patch heavy async dependencies before the router is required. The route holds
// the module object references, so mutating exported functions works.
const aiProviderManagement = requireCJS('../../lib/aiProviderManagement');
aiProviderManagement.resolveProviderConfig = vi.fn();
aiProviderManagement.getTenantAiState = vi.fn();

const brochureEngine = requireCJS('../../services/brochureEngineBridge');
brochureEngine.startRun = vi.fn();
brochureEngine.cancelRun = vi.fn();

// Prisma stubs needed by requireTravelTenant + the route handler.
prisma.tenant = {
  findUnique: vi.fn(),
};
prisma.travelBrochure = {
  create: vi.fn(),
  update: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  count: vi.fn(),
};
prisma.brandKit = {
  findFirst: vi.fn(),
};
prisma.travelBrandProfile = {
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
};

const travelBrochuresRouter = requireCJS('../../routes/travel_brochures');

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function bearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '5m' });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/travel', travelBrochuresRouter);
  return app;
}

function validTripInput(overrides = {}) {
  return {
    schoolName: 'Greenfield Academy',
    schoolLogoUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
    schoolLogoFileName: 'logo.png',
    schoolLogoApproved: true,
    tmcBrandKitId: 'tmc-kit-1',
    tripTitle: 'London STEM Tour',
    destinationCountry: 'United Kingdom',
    travelDates: { from: '2026-04-01', to: '2026-04-08' },
    durationDays: 8,
    durationNights: 7,
    targetGrades: 'Grades 9-12',
    tripSummary: 'An educational tour of London focused on STEM and history.',
    primaryObjective: 'Explore science museums and historic landmarks.',
    learningOutcomes: ['Understand British history', 'Experience STEM exhibits', 'Develop teamwork'],
    routeCities: 'London',
    overnightCities: [{ city: 'London', nights: 7 }],
    days: [
      {
        dayNumber: 1,
        date: '2026-04-01',
        route: 'Arrival in London',
        activities: 'Airport transfer and orientation walk',
        overnightCity: 'London',
      },
    ],
    inclusions: ['Flights', 'Hotels', 'Meals', 'Guided tours'],
    exclusions: ['Personal expenses', 'Travel insurance'],
    currency: 'INR',
    pricePerPerson: 185000,
    occupancyBasis: 'Twin sharing',
    deposit: { amount: 25000, dueDate: '2026-01-15' },
    themeMode: 'auto',
    travelSeason: 'Spring',
    primaryPhone: '+91 98765 43210',
    email: 'tours@themodernclassroom.com',
    website: 'https://themodernclassroom.com',
    callToAction: 'Book before 15 Jan 2026',
    ...overrides,
  };
}

describe('POST /api/travel/brochures/runs', () => {
  beforeEach(() => {
    prisma.tenant.findUnique.mockReset().mockResolvedValue({
      id: 1,
      vertical: 'travel',
      name: 'Travel Tenant',
      slug: 'travel-tenant',
    });
    prisma.brandKit.findFirst.mockReset().mockResolvedValue(null);
    prisma.travelBrochure.create.mockReset().mockResolvedValue({ id: 101, runId: 'br_testrun123' });
    prisma.travelBrochure.update.mockReset().mockResolvedValue({});
    aiProviderManagement.resolveProviderConfig.mockReset().mockResolvedValue({
      providerId: 'openai',
      providerLabel: 'OpenAI',
      apiKey: 'sk-test',
    });
    aiProviderManagement.getTenantAiState.mockReset().mockResolvedValue({});
    brochureEngine.startRun.mockReset().mockResolvedValue({
      result: 'done',
      billedUsd: 0.05,
      pdfUrl: '/api/brochure-assets/br_testrun123.pdf',
    });
    brochureEngine.cancelRun.mockReset().mockReturnValue(false);
  });

  test('accepts structured tripInput, returns runId and warnings', async () => {
    const app = makeApp();
    const tripInput = validTripInput();
    const res = await request(app)
      .post('/api/travel/brochures/runs')
      .set('Authorization', bearer())
      .send({ sectorKey: 'travel', styleKey: 'tmc-school', tripInput, brand: {} });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      runId: expect.any(String),
      brochureId: 101,
      status: 'running',
    });
    expect(Array.isArray(res.body.warnings)).toBe(true);

    const call = brochureEngine.startRun.mock.lastCall[0];
    expect(call.sectorKey).toBe('travel');
    expect(call.styleKey).toBe('tmc-school');
    expect(call.goal).toBe(JSON.stringify(tripInput));
    expect(call.brand).toBeUndefined();
  });

  test('defaults styleKey to tmc-school for the travel sector', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/brochures/runs')
      .set('Authorization', bearer())
      .send({ tripInput: validTripInput(), brand: {} });

    expect(res.status).toBe(200);
    const call = brochureEngine.startRun.mock.lastCall[0];
    expect(call.styleKey).toBe('tmc-school');
  });

  test('passes a single { reasoning } model override through to the engine', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/travel/brochures/runs')
      .set('Authorization', bearer())
      .send({
        tripInput: validTripInput(),
        brand: {},
        models: { reasoning: 'gpt-4o', fast: 'gpt-4o-mini' },
      });

    const call = brochureEngine.startRun.mock.lastCall[0];
    expect(call.models).toEqual({ reasoning: 'gpt-4o' });
  });

  test('returns 400 with missing keys when tripInput is invalid', async () => {
    const app = makeApp();
    const tripInput = validTripInput();
    delete tripInput.schoolName;
    delete tripInput.tripTitle;
    delete tripInput.days;

    const res = await request(app)
      .post('/api/travel/brochures/runs')
      .set('Authorization', bearer())
      .send({ tripInput, brand: {} });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRIP_INPUT_INVALID');
    expect(res.body.missing).toEqual(
      expect.arrayContaining(['schoolName', 'tripTitle', 'days']),
    );
  });

  test('returns 400 when a day is missing required fields', async () => {
    const app = makeApp();
    const tripInput = validTripInput({
      days: [{ date: '2026-04-01', route: 'Arrival', activities: 'Walk', overnightCity: 'London' }],
    });

    const res = await request(app)
      .post('/api/travel/brochures/runs')
      .set('Authorization', bearer())
      .send({ tripInput, brand: {} });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TRIP_INPUT_INVALID');
    expect(res.body.missing).toEqual(expect.arrayContaining(['days[0].dayNumber']));
  });

  test('still accepts the legacy string goal for backward compatibility', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/brochures/runs')
      .set('Authorization', bearer())
      .send({ goal: 'A classic travel brief', brand: {} });

    expect(res.status).toBe(200);
    const call = brochureEngine.startRun.mock.lastCall[0];
    expect(call.goal).toBe('A classic travel brief');
    expect(call.styleKey).toBe('tmc-school');
  });

  test('returns 400 when neither tripInput nor goal is provided', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/brochures/runs')
      .set('Authorization', bearer())
      .send({ brand: {} });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('GOAL_REQUIRED');
  });

  test('rejects tripInput when JSON.stringify(tripInput) exceeds 64000 characters', async () => {
    const app = makeApp();
    const tripInput = validTripInput({ tripSummary: 'x'.repeat(65000) });

    const res = await request(app)
      .post('/api/travel/brochures/runs')
      .set('Authorization', bearer())
      .send({ tripInput, brand: {} });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('GOAL_TOO_LONG');
  });

  test('merges an existing brand kit when brand.tmcBrandKitId is a numeric string', async () => {
    const dataLogo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
    prisma.brandKit.findFirst.mockReset().mockResolvedValue({
      id: 42,
      tenantId: 1,
      logoUrl: dataLogo,
      logoDarkUrl: null,
      tagline: 'TRAVEL. EXPERIENCE. LEARN.',
      accentColor: '#1AAFE0',
      supportPhone: '+91 98765 43210',
      supportEmail: 'hello@themodernclassroom.com',
      socialLinksJson: JSON.stringify([
        { network: 'instagram' },
        { network: 'youtube' },
      ]),
    });

    const app = makeApp();
    const res = await request(app)
      .post('/api/travel/brochures/runs')
      .set('Authorization', bearer())
      .send({
        tripInput: validTripInput(),
        brand: { tmcBrandKitId: '42', name: 'Override Name' },
      });

    expect(res.status).toBe(200);
    const call = brochureEngine.startRun.mock.lastCall[0];
    expect(call.brand.logoUrl).toMatch(/^data:image\/png;base64,/);
    expect(call.brand.tagline).toBe('TRAVEL. EXPERIENCE. LEARN.');
    expect(call.brand.colors).toEqual({ accent: '#1AAFE0' });
    expect(call.brand.contact).toEqual(['+91 98765 43210', 'hello@themodernclassroom.com']);
    expect(call.brand.socials).toEqual(['instagram', 'youtube']);
    // Explicit body edits override kit values.
    expect(call.brand.name).toBe('Override Name');
  });
});
