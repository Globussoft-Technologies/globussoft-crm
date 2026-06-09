// @ts-check
/**
 * TMC submit-tmc — C7 curriculum-fit integration test.
 *
 * Pins POST /api/travel/diagnostics/public/submit-tmc's extension per
 * PRD_TMC_CURRICULUM_MAPPING.md FR-5: the submit handler queries
 * TravelCurriculumMapping for the tenant, hands the active rows to the
 * extended runTmcDiagnosticEngine, persists the resulting top-N
 * curriculum-fit snapshot as curriculumFitJson, and includes the
 * snapshot in the response envelope.
 *
 * What's pinned
 * -------------
 *   1. happy path with curriculum mappings → response includes
 *      curriculumFit array AND persisted row has curriculumFitJson
 *      populated.
 *   2. happy path with NO curriculum mappings → curriculumFit: []
 *      (graceful — engine still recommends a trip).
 *   3. persisted curriculumFitJson is a valid JSON string round-trips
 *      to the same array.
 *   4. cross-tenant: only the request tenant's mappings are queried
 *      (tenant B's curriculum doesn't leak into tenant A's response).
 *   5. engine routing is independent of curriculum-fit — recommended
 *      trip is still computed from the catalogue even with an empty
 *      mapping set.
 *
 * Test pattern mirrors travel-diagnostics-readiness-report.test.js
 * (patch prisma singleton + LLM router BEFORE requiring the router so
 * CJS require binds to the spies).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const llmRouter = requireCJS('../../lib/llmRouter');
llmRouter.routeRequest = vi.fn();

const dedup = requireCJS('../../utils/deduplication');
dedup.findDuplicateContactFull = vi.fn();

// Patch prisma singleton — every model the new endpoint touches.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findFirst = vi.fn();
prisma.engineWeights = prisma.engineWeights || {};
prisma.engineWeights.findUnique = vi.fn();
prisma.tmcTripCatalogue = prisma.tmcTripCatalogue || {};
prisma.tmcTripCatalogue.findMany = vi.fn();
prisma.travelCurriculumMapping = prisma.travelCurriculumMapping || {};
prisma.travelCurriculumMapping.findMany = vi.fn();
prisma.travelDiagnostic = {
  ...(prisma.travelDiagnostic || {}),
  findFirst: vi.fn(),
  create: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
};
prisma.contact = {
  ...(prisma.contact || {}),
  create: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
};
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

const router = requireCJS('../../routes/travel_diagnostics');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/travel', router);
  return app;
}

function validAnswers(overrides = {}) {
  return {
    primary_outcome: 'Empathy',
    secondary_skills: ['Cultural respect and inclusion', 'Self-awareness'],
    growth_area: 'comfort_with_difference',
    growth_area_skill: 'Cultural respect and inclusion',
    travel_maturity: 'occasional_day',
    grade_band: '9-10',
    curriculum: ['CBSE'],
    geo_preference: 'domestic',
    group_size: '35-45',
    budget_band: '30k-75k',
    timeline: 'next_term',
    school_profile: {
      school_name: 'Greenfield Public School',
      city: 'Bengaluru',
      branches: '2',
      student_strength: '1000-2000',
      fee_band: '1l-plus',
    },
    contact: {
      contact_name: 'Asha Krishnan',
      contact_role: 'principal',
      email: 'asha@greenfield.edu.in',
      phone: '+91 9876543210',
    },
    ...overrides,
  };
}

function tenantRow(overrides = {}) {
  return { id: 1, slug: 'tmc-india', name: 'TMC India', vertical: 'travel', ...overrides };
}

function catalogueRow(overrides = {}) {
  return {
    id: 1,
    tenantId: 1,
    tripId: 'golden-triangle',
    title: 'Golden Triangle',
    tier: 'domestic',
    durationDays: 5,
    durationNights: 4,
    minGradeBand: '6-8',
    maxGradeBand: '11-12',
    boardsSupportedJson: JSON.stringify(['CBSE', 'ICSE-ISC']),
    minGroupSize: 30,
    priceBand: '30k-75k',
    primaryOutcomesJson: JSON.stringify(['Empathy']),
    skillsDevelopedJson: JSON.stringify([
      'Cultural respect and inclusion',
      'Self-awareness',
    ]),
    curriculumHooksJson: JSON.stringify([]),
    status: 'active',
    ...overrides,
  };
}

function engineWeightsRow() {
  return {
    id: 1, tenantId: 1, version: 'v1',
    weightPrimaryOutcome: 50, weightSecondarySkill: 20, weightGrowthArea: 15,
    weightCurriculumHook: 10, weightGradeBandCenter: 10, weightTierValueLean: 8,
    scoresWellThreshold: 70,
  };
}

function curriculumMappingRow(overrides = {}) {
  return {
    id: 1,
    tenantId: 1,
    curriculum: 'CBSE',
    grade: 'Class 9',
    subject: 'Social Studies',
    learningOutcome: 'Empathy through field study',
    destinationId: 4,
    destinationLabel: 'Madhya Pradesh',
    fitScore: 50,
    fitRationale: 'Strong NEP alignment',
    isActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  prisma.tenant.findFirst.mockReset().mockResolvedValue(tenantRow());
  prisma.engineWeights.findUnique.mockReset().mockResolvedValue(engineWeightsRow());
  prisma.tmcTripCatalogue.findMany.mockReset().mockResolvedValue([catalogueRow()]);
  prisma.travelCurriculumMapping.findMany.mockReset().mockResolvedValue([]);
  prisma.travelDiagnostic.findFirst.mockReset().mockResolvedValue(null);
  prisma.travelDiagnostic.create.mockReset().mockImplementation(async ({ data }) => ({
    id: 7777,
    ...data,
  }));
  prisma.travelDiagnostic.count.mockReset().mockResolvedValue(0);
  prisma.travelDiagnostic.update.mockReset();
  prisma.contact.create.mockReset().mockResolvedValue({ id: 901, tenantId: 1 });
  prisma.contact.findUnique.mockReset().mockResolvedValue(null);
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  llmRouter.routeRequest.mockReset().mockResolvedValue({
    text: '[stub]', model: 'stub', stub: true,
  });
  dedup.findDuplicateContactFull.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/diagnostics/public/submit-tmc — C7 curriculum-fit', () => {
  test('with curriculum data seeded → response includes curriculumFit array', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      curriculumMappingRow({ id: 1, learningOutcome: 'Empathy through travel' }),
      curriculumMappingRow({
        id: 2,
        learningOutcome: 'Cultural respect and inclusion through field study',
        destinationId: 5,
        destinationLabel: 'Rajasthan',
      }),
    ]);

    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit-tmc')
      .send({ tenantSlug: 'tmc-india', answers: validAnswers() });

    expect(res.status).toBe(201);
    expect(Array.isArray(res.body.curriculumFit)).toBe(true);
    expect(res.body.curriculumFit.length).toBeGreaterThan(0);
    expect(res.body.curriculumFit.length).toBeLessThanOrEqual(5);

    // Each row has the FR-5 contract shape.
    const first = res.body.curriculumFit[0];
    expect(first).toMatchObject({
      mappingId: expect.any(Number),
      board: expect.any(String),
      grade: expect.any(String),
      fitScore: expect.any(Number),
      fitRationale: expect.any(String),
    });
  });

  test('with NO curriculum mappings → curriculumFit: [] (graceful)', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit-tmc')
      .send({ tenantSlug: 'tmc-india', answers: validAnswers() });

    expect(res.status).toBe(201);
    expect(res.body.curriculumFit).toEqual([]);

    // Engine still routes — recommendedTripId is populated from the
    // catalogue (proves curriculum-fit is decoupled from engine routing).
    const created = prisma.travelDiagnostic.create.mock.calls[0][0].data;
    expect(created.recommendedTripId).toBe(1);
    expect(created.curriculumFitJson).toBe('[]');
  });

  test('persisted row has curriculumFitJson populated', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      curriculumMappingRow({ id: 11, learningOutcome: 'Empathy mapping' }),
    ]);

    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit-tmc')
      .send({ tenantSlug: 'tmc-india', answers: validAnswers() });

    expect(res.status).toBe(201);
    const created = prisma.travelDiagnostic.create.mock.calls[0][0].data;
    expect(typeof created.curriculumFitJson).toBe('string');
    const parsed = JSON.parse(created.curriculumFitJson);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0].mappingId).toBe(11);

    // Round-trip parity: persisted shape matches response shape.
    expect(parsed).toEqual(res.body.curriculumFit);
  });

  test('cross-tenant — only request tenant\'s mappings are queried (no leakage)', async () => {
    prisma.tenant.findFirst.mockResolvedValue(tenantRow({ id: 42 }));
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit-tmc')
      .send({ tenantSlug: 'tmc-india', answers: validAnswers() });

    expect(res.status).toBe(201);
    // The findMany call MUST be scoped to tenantId: 42.
    expect(prisma.travelCurriculumMapping.findMany).toHaveBeenCalled();
    const firstCall = prisma.travelCurriculumMapping.findMany.mock.calls[0][0];
    expect(firstCall.where.tenantId).toBe(42);
    expect(firstCall.where.isActive).toBe(true);
  });

  test('curriculum-fit independent of engine routing — engine recommends correct trip even with empty mapping set', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([]);
    // Catalogue has 2 trips; one's primary_outcome matches the school's
    // Q1 strongly. Engine must still pick it regardless of curriculum-fit.
    prisma.tmcTripCatalogue.findMany.mockResolvedValue([
      catalogueRow({
        id: 1, tripId: 'a-bad-fit',
        primaryOutcomesJson: JSON.stringify(['Geography drill']),
      }),
      catalogueRow({
        id: 2, tripId: 'b-good-fit',
        primaryOutcomesJson: JSON.stringify(['Empathy']),
      }),
    ]);

    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit-tmc')
      .send({ tenantSlug: 'tmc-india', answers: validAnswers() });

    expect(res.status).toBe(201);
    expect(res.body.curriculumFit).toEqual([]);
    const created = prisma.travelDiagnostic.create.mock.calls[0][0].data;
    // Good-fit trip (id=2) MUST be the recommended trip — proves the
    // engine routing is unaffected by the empty curriculum-mapping set.
    expect(created.recommendedTripId).toBe(2);
  });
});
