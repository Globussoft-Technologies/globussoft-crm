// @ts-check
/**
 * TMC School-Readiness Diagnostic — T14 public readiness-report JSON pin.
 *
 * PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE §10 row T14. One endpoint:
 *
 *   GET /api/travel/diagnostics/public/readiness-report/:slug
 *     - public, no auth (T10's TmcReadinessReport.jsx fetch surface)
 *     - mirrors the T8 PDF endpoint's data pipeline (engine output +
 *       Job A prompt → llmRouter → T7 guard → standing-facts + board
 *       hook + runway display injection) but returns a JSON envelope
 *       instead of streaming a PDF
 *     - returns the §3.5 10-section pre-render struct for the frontend
 *       to compose into the buyer-facing template
 *     - Layer 3 fallback returns 200 with the deterministic template,
 *       NEVER 5xx (matches the PDF endpoint's behaviour)
 *     - `Cache-Control: public, max-age=300` (5 min — content is stable
 *       once submit-tmc persists the diagnostic)
 *
 * What's pinned
 * -------------
 *   - 12 vitest cases covering happy path / 404 (unknown slug) /
 *     404 (non-TMC sub-brand) / Layer 3 fallback / standing-facts honest
 *     numbers literal in JSON / board hook branches (CBSE / IB) / runway
 *     display (international = 180d / "minimum 4 to 6 months") /
 *     catalogue pricing exclusion / engineScoresJson NOT leaked /
 *     tenant identity NOT in envelope / cache header / numeric-id-only
 *     slug malformed.
 *   - The endpoint composes the same data shape the renderer consumes
 *     in T8, minus pricing fields per DD-5.4 (the report is a "what
 *     becomes possible" surface, not a quote — pricing lives in the
 *     human-vetted brief downstream).
 *
 * Test pattern mirrors travel-diagnostics-readiness-report.test.js
 * (T8): patch prisma singleton + llmRouter + guard BEFORE requiring the
 * router so CJS require binds to the spies. Public route is no-auth.
 */

import { describe, test, expect, beforeEach, vi, afterAll } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── CJS self-mocking — patch on the SAME require() path the route uses.

const llmRouter = requireCJS('../../lib/llmRouter');
const originalRouteRequest = llmRouter.routeRequest;
llmRouter.routeRequest = vi.fn();

// Patch prisma singleton — only the models the JSON endpoint reads.
prisma.travelDiagnostic = {
  ...(prisma.travelDiagnostic || {}),
  findFirst: vi.fn(),
};
prisma.tmcTripCatalogue = prisma.tmcTripCatalogue || {};
prisma.tmcTripCatalogue.findMany = vi.fn();
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
    primary_outcome: 'global_awareness',
    secondary_skills: ['Cultural respect and inclusion', 'Lifelong learning and curiosity'],
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
      student_strength: '1000_2000',
      fee_band: '1l_plus',
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

function catalogueRow(overrides = {}) {
  return {
    id: 1,
    tenantId: 1,
    tripId: 'golden-triangle-delhi-agra-jaipur',
    title: 'Golden Triangle',
    tier: 'domestic',
    region: 'North India',
    durationDays: 5,
    durationNights: 4,
    minGradeBand: '6-8',
    maxGradeBand: '11-12',
    boardsSupportedJson: JSON.stringify(['CBSE', 'ICSE_ISC', 'IGCSE', 'IB', 'State Board']),
    minGroupSize: 30,
    priceBand: '30k-75k',
    indicativePricePerStudent: 48000,
    primaryOutcomesJson: JSON.stringify(['global_awareness', 'pride', 'curiosity']),
    skillsDevelopedJson: JSON.stringify(['Cultural respect and inclusion']),
    subjectsTouchedJson: JSON.stringify(['History', 'Geography']),
    anchorExperiencesJson: JSON.stringify([
      { name: 'Red Fort context walk', what_students_do: 'Map Mughal admin', skill_link: 'Cultural respect and inclusion' },
    ]),
    curriculumHooksJson: JSON.stringify([
      { board: 'CBSE', grade_band: '9-10', subject: 'History', topic: 'Heritage tourism', hook_text: 'NEP-aligned' },
    ]),
    reportSkillBlurb: 'Heritage routes done well build pride that holds steady.',
    summaryForBrief: 'Delhi + Agra + Jaipur, anchored on Mughal-period history.',
    imageUrl: null,
    status: 'active',
    ...overrides,
  };
}

function persistedDiag(overrides = {}) {
  return {
    id: 555,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 900,
    engineState: 'strong_match',
    engineScoresJson: JSON.stringify({ survivors: ['golden-triangle'], eliminated: [{ tripId: 'goa', reason: 'tier mismatch' }], weightsUsed: { weightPrimaryOutcome: 50 } }),
    recommendedTripId: 1,
    alternativeTripId: null,
    icpTier: 'breadwinning',
    leadQuality: 'clean',
    flagsJson: '[]',
    answersJson: JSON.stringify(validAnswers()),
    weightsVersion: 'v1',
    createdAt: new Date('2026-06-08T10:00:00Z'),
    ...overrides,
  };
}

function buildSlugFor(id) {
  // Mirrors buildReportSlug's shape: `<id>-<16 hex chars>`.  Tests don't
  // need crypto entropy — they just need the slug to PARSE back to the
  // expected id via parseDiagnosticIdFromSlug.
  return `${id}-abcd1234ef567890`;
}

beforeEach(() => {
  prisma.travelDiagnostic.findFirst.mockReset().mockResolvedValue(persistedDiag());
  prisma.tmcTripCatalogue.findMany.mockReset().mockResolvedValue([catalogueRow()]);
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  llmRouter.routeRequest.mockReset().mockResolvedValue({
    text: '[STUB-TMC-READINESS-NARRATIVE] synthetic prose, fails Layer 1 schema and falls through to template.',
    model: 'stub-claude-opus',
    stub: true,
  });
});

// ────────────────────────────────────────────────────────────────────
// GET /api/travel/diagnostics/public/readiness-report/:slug
// ────────────────────────────────────────────────────────────────────

describe('GET /api/travel/diagnostics/public/readiness-report/:slug', () => {
  test('happy path → 200 with full envelope shape', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/diagnostics/public/readiness-report/${buildSlugFor(555)}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      diagnostic: expect.objectContaining({
        id: 555,
        engineState: 'strong_match',
        icpTier: 'breadwinning',
        weightsVersion: 'v1',
      }),
      narrative: expect.any(Object),
      engineOutput: expect.any(Object),
      standingFacts: expect.any(Object),
      boardHook: expect.objectContaining({
        board: 'CBSE',
        hookText: expect.any(String),
      }),
      runwayDisplay: expect.objectContaining({
        days: expect.any(Number),
        label: expect.any(String),
      }),
      catalogueMatched: expect.any(Array),
      guardLayer: expect.any(Number),
      guardAccepted: expect.any(Boolean),
    });
  });

  test('unknown slug → 404 DIAGNOSTIC_NOT_FOUND', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get(`/api/travel/diagnostics/public/readiness-report/${buildSlugFor(99999)}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DIAGNOSTIC_NOT_FOUND' });
  });

  test('malformed slug (non-numeric prefix) → 404 DIAGNOSTIC_NOT_FOUND (no DB read)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/public/readiness-report/garbage-no-leading-id');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DIAGNOSTIC_NOT_FOUND' });
    // We should NOT have queried the DB for a garbage slug.
    expect(prisma.travelDiagnostic.findFirst).not.toHaveBeenCalled();
  });

  test('slug belongs to non-TMC diagnostic → 404 (cross-tenant / cross-sub-brand isolation)', async () => {
    // The findFirst query is scoped to `subBrand: "tmc"`, so an RFU or
    // Visa Sure diagnostic with the same id returns null → 404.  We
    // simulate by returning null from the spy (the WHERE clause
    // filters out non-TMC at the query layer).
    prisma.travelDiagnostic.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get(`/api/travel/diagnostics/public/readiness-report/${buildSlugFor(777)}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DIAGNOSTIC_NOT_FOUND' });
    // Confirm the route DID pass `subBrand: "tmc"` in its WHERE.
    expect(prisma.travelDiagnostic.findFirst).toHaveBeenCalledWith({
      where: { id: 777, subBrand: 'tmc' },
    });
  });

  test('Layer 3 fallback: stub LLM prose fails Layer 1, guard falls through, endpoint returns 200', async () => {
    // The default stub return in beforeEach is non-JSON prose — Layer 1
    // schema validation rejects, Layer 3 deterministic template fires.
    // The endpoint MUST still return 200 (mirrors PDF endpoint design).
    const res = await request(makeApp())
      .get(`/api/travel/diagnostics/public/readiness-report/${buildSlugFor(555)}`);
    expect(res.status).toBe(200);
    expect(res.body.guardLayer).toBe(3);
    expect(res.body.guardAccepted).toBe(false);
    // The narrative is the deterministic-template Job A shape — the 6
    // required fields are present per PRD §3.7.1's fallback table.
    expect(res.body.narrative).toEqual(expect.objectContaining({
      ambition_restatement: expect.any(String),
      readiness_profile: expect.any(String),
      what_becomes_possible: expect.any(String),
      cost_of_waiting: expect.any(String),
      institutional_benefit: expect.any(String),
      assurance_framing: expect.any(String),
    }));
    // Header surface mirrors the PDF endpoint for ops observability.
    expect(res.headers['x-tmc-report-guard-layer']).toBe('3');
    expect(res.headers['x-tmc-report-guard-accepted']).toBe('false');
  });

  test('board hook branch — CBSE answers → boardHook.board="CBSE", hookText contains NEP framing', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(persistedDiag({
      answersJson: JSON.stringify(validAnswers({ curriculum: ['CBSE'] })),
    }));
    const res = await request(makeApp())
      .get(`/api/travel/diagnostics/public/readiness-report/${buildSlugFor(555)}`);
    expect(res.status).toBe(200);
    expect(res.body.boardHook.board).toBe('CBSE');
    expect(res.body.boardHook.hookText).toContain('NEP 2020');
    expect(res.body.boardHook.hookText).toContain('NCF');
  });

  test('board hook branch — IB answers → hookText contains CAS framing; AC-3 IB never sees NEP', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(persistedDiag({
      answersJson: JSON.stringify(validAnswers({ curriculum: ['IB'] })),
    }));
    const res = await request(makeApp())
      .get(`/api/travel/diagnostics/public/readiness-report/${buildSlugFor(555)}`);
    expect(res.status).toBe(200);
    expect(res.body.boardHook.board).toBe('IB');
    expect(res.body.boardHook.hookText).toContain('CAS');
    // PRD AC-3: an IB school never sees NEP.
    expect(res.body.boardHook.hookText).not.toContain('NEP');
  });

  test('runway display — international geo_preference → days=180, label="minimum 4 to 6 months" (§3.5.2)', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(persistedDiag({
      answersJson: JSON.stringify(validAnswers({ geo_preference: 'international' })),
    }));
    const res = await request(makeApp())
      .get(`/api/travel/diagnostics/public/readiness-report/${buildSlugFor(555)}`);
    expect(res.status).toBe(200);
    expect(res.body.runwayDisplay.days).toBe(180);
    expect(res.body.runwayDisplay.label).toBe('minimum 4 to 6 months');
  });

  test('standing facts honest — response payload contains literal "305", "14018", "12055", "1658" (§3.5.3 peer proof)', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/diagnostics/public/readiness-report/${buildSlugFor(555)}`);
    expect(res.status).toBe(200);
    // PRD §3.5.5 — the standing-facts block injects renderer-authored
    // peer-proof numbers verbatim.  Assert via JSON.stringify includes.
    const json = JSON.stringify(res.body);
    expect(json).toContain('305');
    expect(json).toContain('14018');
    expect(json).toContain('12055');
    expect(json).toContain('1658');
    // §3.5.5 prose figures — "over 50" + "more than 100,000".
    expect(json).toContain('over 50');
    expect(json).toContain('more than 100,000');
    // Structured assertions on the standingFacts subtree.
    expect(res.body.standingFacts.trust.international_students_last_year).toBe(305);
    expect(res.body.standingFacts.trust.students_moved_last_year).toBe(14018);
    expect(res.body.standingFacts.trust.day_students_last_year).toBe(12055);
    expect(res.body.standingFacts.trust.overnight_students_last_year).toBe(1658);
  });

  test('catalogueMatched is buyer-facing — pricing fields excluded (DD-5.4)', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/diagnostics/public/readiness-report/${buildSlugFor(555)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.catalogueMatched)).toBe(true);
    expect(res.body.catalogueMatched.length).toBeGreaterThan(0);
    const trip = res.body.catalogueMatched[0];
    // Trip MUST include the surface the report renders.
    expect(trip).toMatchObject({
      tripId: 'golden-triangle-delhi-agra-jaipur',
      title: 'Golden Triangle',
      tier: 'domestic',
      region: 'North India',
    });
    // Pricing MUST be absent — the report is a "what becomes possible"
    // surface, not a quote.
    expect(trip.indicativePricePerStudent).toBeUndefined();
    expect(trip.priceBand).toBeUndefined();
  });

  test('engineScoresJson NOT leaked — survivors[] + eliminated[] + weightsUsed{} are internal sales artifacts', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/diagnostics/public/readiness-report/${buildSlugFor(555)}`);
    expect(res.status).toBe(200);
    // engineOutput exposes only buyer-safe surface.
    expect(res.body.engineOutput).toMatchObject({
      state: 'strong_match',
      icpTier: 'breadwinning',
      recommendedTripId: 1,
      alternativeTripId: null,
    });
    // The full survivors / eliminated / weightsUsed payload MUST NOT
    // appear anywhere in the JSON response (would leak weight tuning).
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('survivors');
    expect(json).not.toContain('eliminated');
    expect(json).not.toContain('weightsUsed');
  });

  test('tenant identity NOT leaked in envelope — no tenantId / tenant slug / tenant name', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/diagnostics/public/readiness-report/${buildSlugFor(555)}`);
    expect(res.status).toBe(200);
    // The diagnostic block exposes id + engineState + icpTier + weightsVersion + createdAt;
    // tenantId is excluded so a leaked slug doesn't reveal cross-tenant scope.
    expect(res.body.diagnostic.tenantId).toBeUndefined();
    expect(res.body.diagnostic.tenant).toBeUndefined();
    // Sanity — top-level envelope doesn't have tenant fields either.
    expect(res.body.tenantId).toBeUndefined();
    expect(res.body.tenantSlug).toBeUndefined();
  });

  test('cache header → public, max-age=300 (5 minutes)', async () => {
    const res = await request(makeApp())
      .get(`/api/travel/diagnostics/public/readiness-report/${buildSlugFor(555)}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/public.*max-age=300|max-age=300.*public/);
  });
});

// Restore at end so subsequent suites get the real surfaces back.
afterAll(() => {
  llmRouter.routeRequest = originalRouteRequest;
});
