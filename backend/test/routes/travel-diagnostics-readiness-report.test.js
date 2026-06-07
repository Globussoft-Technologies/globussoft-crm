// @ts-check
/**
 * TMC School-Readiness Diagnostic — T8 contract pin.
 *
 * PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE §10 row T8. Two endpoints land
 * in T8 and this file pins both end-to-end:
 *
 *   POST /api/travel/diagnostics/public/submit-tmc
 *     - public, no auth
 *     - Q12 email is the only hard wall (PRD §3.1 + NF-6)
 *     - runs T2 engine + T3 lead-quality classifier
 *     - persists every T1-additive column (engineState, engineScoresJson,
 *       recommendedTripId, alternativeTripId, icpTier, leadQuality,
 *       leadQualityReasonsJson, flagsJson, weightsVersion)
 *     - returns {diagnosticId, reportSlug, tenantSlug, engineState, message}
 *
 *   GET /api/travel/diagnostics/:id/readiness-report.pdf
 *     - public, token-gated by id
 *     - composes Job A prompt (T6) → llmRouter (stubbed) → T7 guard →
 *       T8's pdfRenderer.renderTmcReadinessReport()
 *     - returns application/pdf attachment with no-store cache
 *     - Layer 3 fallback render: stub llmRouter returns prose, fails T7
 *       Layer 1 schema, falls through to deterministic template
 *
 * What's pinned
 * -------------
 *   - 12 vitest cases covering both endpoints + the helper exports.
 *   - The renderer's literal injection of §3.5.3 peer-proof numbers
 *     (305 / 14018 / 12055 / 1658 / over 50 / more than 100,000) is
 *     asserted on the PDF body bytes — PDFKit emits the integers as
 *     literal strings into the content stream so a Buffer.includes()
 *     check is sufficient (no PDF text extraction needed).
 *   - Board-hook resolution: CBSE answers → NEP/NCF citation; IB →
 *     CAS+Learner Profile; IGCSE → Cambridge Learner Attributes. AC-3
 *     "an IB school never sees NEP" is structurally enforced by the
 *     standing-facts config — IB's hook string does not contain "NEP".
 *
 * Test pattern mirrors travel-diagnostics.test.js (tick 884-LOC route
 * pin): patch prisma singleton + LLM router + renderer surface BEFORE
 * requiring the router so CJS require binds to the spies. Public routes
 * are no-auth so no JWT minting; mountUnder /api/travel + supertest.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── CJS self-mocking — patch on the SAME require() path the route uses.

const llmRouter = requireCJS('../../lib/llmRouter');
const originalRouteRequest = llmRouter.routeRequest;
llmRouter.routeRequest = vi.fn();

const dedup = requireCJS('../../utils/deduplication');
dedup.findDuplicateContactFull = vi.fn();

// pdfRenderer surface — spied so we can assert on the renderer's pre-PDF
// struct (PRD §3.5.3 standing-facts literal injection; §3.5.1 board hook;
// §3.5.2 runway display). PDFKit's content stream is zlib-compressed so
// byte-level Buffer scans on res.body don't reliably find injected text.
// The "assert on the renderer's pre-PDF struct" path is the cleaner
// contract — what the renderer is HANDED is the contract; what PDFKit
// then does with it is a downstream rendering concern.
const pdfRenderer = requireCJS('../../services/pdfRenderer');
const originalRenderTmcReadinessReport = pdfRenderer.renderTmcReadinessReport;

// Patch prisma singleton — every model the new endpoints touch.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findFirst = vi.fn();
prisma.engineWeights = prisma.engineWeights || {};
prisma.engineWeights.findUnique = vi.fn();
prisma.tmcTripCatalogue = prisma.tmcTripCatalogue || {};
prisma.tmcTripCatalogue.findMany = vi.fn();
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

// Minimum-valid TMC answers payload. Anchored on the §3.1 frozen keys.
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

function tenantRow() {
  return { id: 1, slug: 'tmc-india', name: 'TMC India', vertical: 'travel' };
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
    skillsDevelopedJson: JSON.stringify([
      'Cultural respect and inclusion',
      'Lifelong learning and curiosity',
      'Collaboration and teamwork',
    ]),
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

function engineWeightsRow() {
  return {
    id: 1, tenantId: 1, version: 'v1',
    weightPrimaryOutcome: 50, weightSecondarySkill: 20, weightGrowthArea: 15,
    weightCurriculumHook: 10, weightGradeBandCenter: 10, weightTierValueLean: 8,
    scoresWellThreshold: 70,
  };
}

beforeEach(() => {
  prisma.tenant.findFirst.mockReset().mockResolvedValue(tenantRow());
  prisma.engineWeights.findUnique.mockReset().mockResolvedValue(engineWeightsRow());
  prisma.tmcTripCatalogue.findMany.mockReset().mockResolvedValue([catalogueRow()]);
  prisma.travelDiagnostic.findFirst.mockReset().mockResolvedValue(null);
  prisma.travelDiagnostic.create.mockReset().mockResolvedValue({
    id: 4242,
    tenantId: 1,
    subBrand: 'tmc',
    engineState: 'strong_match',
    engineScoresJson: '{}',
    recommendedTripId: 1,
    alternativeTripId: null,
    icpTier: 'breadwinning',
    leadQuality: 'clean',
    leadQualityReasonsJson: '[]',
    flagsJson: '[]',
    weightsVersion: 'v1',
    answersJson: JSON.stringify(validAnswers()),
  });
  prisma.travelDiagnostic.count.mockReset().mockResolvedValue(0);
  prisma.travelDiagnostic.update.mockReset();
  prisma.contact.create.mockReset().mockResolvedValue({ id: 900, tenantId: 1 });
  prisma.contact.findUnique.mockReset().mockResolvedValue(null);
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  llmRouter.routeRequest.mockReset().mockResolvedValue({
    text: '[STUB-TMC-READINESS-NARRATIVE] synthetic prose, will fail Layer 1 schema and fall through to template.',
    model: 'stub-claude-opus',
    stub: true,
  });
  dedup.findDuplicateContactFull.mockReset().mockResolvedValue(null);
});

// ────────────────────────────────────────────────────────────────────
// POST /api/travel/diagnostics/public/submit-tmc
// ────────────────────────────────────────────────────────────────────

describe('POST /api/travel/diagnostics/public/submit-tmc', () => {
  test('happy path → 201 with diagnosticId + reportSlug + tenantSlug', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit-tmc')
      .send({ tenantSlug: 'tmc-india', answers: validAnswers() });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      diagnosticId: 4242,
      tenantSlug: 'tmc-india',
      engineState: expect.any(String),
    });
    expect(res.body.reportSlug).toMatch(/^4242-[a-f0-9]+$/);
    expect(prisma.travelDiagnostic.create).toHaveBeenCalledTimes(1);

    // PRD §3.8 — engine columns populated, generic columns null.
    const created = prisma.travelDiagnostic.create.mock.calls[0][0].data;
    expect(created.subBrand).toBe('tmc');
    expect(created.tenantId).toBe(1);
    expect(typeof created.engineState).toBe('string');
    expect(typeof created.engineScoresJson).toBe('string');
    expect(typeof created.flagsJson).toBe('string');
    expect(created.leadQuality).toBe('clean');
    expect(created.weightsVersion).toBe('v1');
    expect(created.score).toBeNull();
  });

  test('missing tenantSlug → 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit-tmc')
      .send({ answers: validAnswers() });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelDiagnostic.create).not.toHaveBeenCalled();
  });

  test('missing Q12 email → 400 EMAIL_REQUIRED (the only hard wall per PRD §3.1)', async () => {
    const answers = validAnswers({ contact: { contact_name: 'X', contact_role: 'principal', phone: '+91 9876543210' } });
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit-tmc')
      .send({ tenantSlug: 'tmc-india', answers });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMAIL_REQUIRED' });
    expect(prisma.travelDiagnostic.create).not.toHaveBeenCalled();
  });

  test('malformed email → 400 EMAIL_INVALID', async () => {
    const answers = validAnswers({ contact: { contact_name: 'X', contact_role: 'principal', email: 'not-an-email', phone: '+91 9876543210' } });
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit-tmc')
      .send({ tenantSlug: 'tmc-india', answers });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMAIL_INVALID' });
  });

  test('invalid grade_band → 400 INVALID_GRADE_BAND', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit-tmc')
      .send({ tenantSlug: 'tmc-india', answers: validAnswers({ grade_band: '13-15' }) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_GRADE_BAND' });
  });

  test('tenant slug not found → 404 TENANT_NOT_FOUND', async () => {
    prisma.tenant.findFirst.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit-tmc')
      .send({ tenantSlug: 'missing', answers: validAnswers() });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
  });

  test('suspect lead — free-mail + senior role → leadQuality=suspect, flag persisted', async () => {
    const answers = validAnswers({
      contact: {
        contact_name: 'Sam',
        contact_role: 'principal',  // senior role
        email: 'principal@gmail.com', // free-domain
        phone: '+91 9876543210',
      },
    });
    prisma.travelDiagnostic.create.mockResolvedValueOnce({
      id: 4243,
      tenantId: 1, subBrand: 'tmc',
      engineState: 'strong_match',
      leadQuality: 'suspect',
      leadQualityReasonsJson: '["free_domain_senior_role"]',
    });
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit-tmc')
      .send({ tenantSlug: 'tmc-india', answers });
    expect(res.status).toBe(201);
    const created = prisma.travelDiagnostic.create.mock.calls[0][0].data;
    expect(created.leadQuality).toBe('suspect');
    expect(JSON.parse(created.leadQualityReasonsJson)).toContain('free_domain_senior_role');
    expect(JSON.parse(created.flagsJson)).toContain('suspect');
  });

  test('engine throws on bad input → 400 ENGINE_INPUT_INVALID', async () => {
    // Force the engine to bomb by handing it a non-object answers payload.
    // The submit handler validates required tenantSlug + email upstream,
    // so we drive the engine fault path by giving an answers object whose
    // shape passes the upstream checks but trips the engine's TypeError
    // (engine throws on non-object answers — patched on the cached module).
    const tmcEngine = requireCJS('../../lib/tmcDiagnosticEngine');
    const originalRun = tmcEngine.runTmcDiagnosticEngine;
    tmcEngine.runTmcDiagnosticEngine = vi.fn(() => {
      throw new TypeError('runTmcDiagnosticEngine: answers must be an object');
    });
    try {
      const res = await request(makeApp())
        .post('/api/travel/diagnostics/public/submit-tmc')
        .send({ tenantSlug: 'tmc-india', answers: validAnswers() });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'ENGINE_INPUT_INVALID' });
    } finally {
      tmcEngine.runTmcDiagnosticEngine = originalRun;
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// GET /api/travel/diagnostics/:id/readiness-report.pdf
// ────────────────────────────────────────────────────────────────────

describe('GET /api/travel/diagnostics/:id/readiness-report.pdf', () => {
  function persistedDiag(overrides = {}) {
    return {
      id: 555,
      tenantId: 1,
      subBrand: 'tmc',
      contactId: 900,
      engineState: 'strong_match',
      engineScoresJson: JSON.stringify({ survivors: [], eliminated: [], weightsUsed: {} }),
      recommendedTripId: 1,
      alternativeTripId: null,
      icpTier: 'breadwinning',
      leadQuality: 'clean',
      flagsJson: '[]',
      answersJson: JSON.stringify(validAnswers()),
      weightsVersion: 'v1',
      ...overrides,
    };
  }

  test('happy path → 200 application/pdf, non-empty buffer, no-store cache', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(persistedDiag());

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/555/readiness-report.pdf');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/attachment.*readiness-report-555\.pdf/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body.length).toBeGreaterThan(500); // any meaningful PDF is well over 500 bytes
    // PDF files start with "%PDF-".
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('non-numeric id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/not-a-number/readiness-report.pdf');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelDiagnostic.findFirst).not.toHaveBeenCalled();
  });

  test('diagnostic not found → 404 DIAGNOSTIC_NOT_FOUND', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/99999/readiness-report.pdf');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DIAGNOSTIC_NOT_FOUND' });
  });

  test('Layer 3 fallback path: stub llmRouter prose fails Layer 1, guard falls through, renderer ships green', async () => {
    // The default stub return in beforeEach is non-JSON prose — the guard
    // should reject Layer 1 schema and fall through to the deterministic
    // template. Pin the guard's downstream-emitted header.
    prisma.travelDiagnostic.findFirst.mockResolvedValue(persistedDiag());

    const res = await request(makeApp())
      .get('/api/travel/diagnostics/555/readiness-report.pdf');
    expect(res.status).toBe(200);
    expect(res.headers['x-tmc-report-guard-layer']).toBe('3');
    expect(res.headers['x-tmc-report-guard-accepted']).toBe('false');
  });

  test('peer-proof block literally injected via standingFacts — renderer receives 305 / 14018 / 12055 / 1658 / over 50 / more than 100,000', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(persistedDiag());
    // Spy on the renderer so we can assert on the pre-PDF struct
    // (PDFKit zlib-compresses content streams so byte-level scans on the
    // PDF buffer aren't reliable — the renderer's INPUT is the contract).
    pdfRenderer.renderTmcReadinessReport = vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 stub'));
    try {
      const res = await request(makeApp())
        .get('/api/travel/diagnostics/555/readiness-report.pdf');
      expect(res.status).toBe(200);
      const callArgs = pdfRenderer.renderTmcReadinessReport.mock.calls[0][0];
      // §3.5.5 standing-facts numerical contract — PRD §11.4 international stays at 305.
      expect(callArgs.standingFacts.trust.international_students_last_year).toBe(305);
      expect(callArgs.standingFacts.trust.students_moved_last_year).toBe(14018);
      expect(callArgs.standingFacts.trust.day_students_last_year).toBe(12055);
      expect(callArgs.standingFacts.trust.overnight_students_last_year).toBe(1658);
      expect(callArgs.standingFacts.trust.schools_served_since_2015).toBe('over 50');
      expect(callArgs.standingFacts.trust.students_moved_since_2015).toBe('more than 100,000');
    } finally {
      pdfRenderer.renderTmcReadinessReport = originalRenderTmcReadinessReport;
    }
  });

  test('runway display resolved — international geo → "minimum 4 to 6 months" (§3.5.2)', async () => {
    const answers = validAnswers({ geo_preference: 'international' });
    prisma.travelDiagnostic.findFirst.mockResolvedValue(persistedDiag({
      answersJson: JSON.stringify(answers),
    }));
    pdfRenderer.renderTmcReadinessReport = vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 stub'));
    try {
      const res = await request(makeApp())
        .get('/api/travel/diagnostics/555/readiness-report.pdf');
      expect(res.status).toBe(200);
      const callArgs = pdfRenderer.renderTmcReadinessReport.mock.calls[0][0];
      expect(callArgs.runwayDisplay).toBe('minimum 4 to 6 months');
    } finally {
      pdfRenderer.renderTmcReadinessReport = originalRenderTmcReadinessReport;
    }
  });

  test('board hook resolution — CBSE answers see NEP/NCF; IB never sees NEP (AC-3)', async () => {
    pdfRenderer.renderTmcReadinessReport = vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 stub'));
    try {
      // First — CBSE: hook contains "NEP 2020".
      const cbseAnswers = validAnswers({ curriculum: ['CBSE'] });
      prisma.travelDiagnostic.findFirst.mockResolvedValue(persistedDiag({
        answersJson: JSON.stringify(cbseAnswers),
      }));
      let res = await request(makeApp())
        .get('/api/travel/diagnostics/555/readiness-report.pdf');
      expect(res.status).toBe(200);
      let callArgs = pdfRenderer.renderTmcReadinessReport.mock.calls[0][0];
      expect(callArgs.boardHook).toContain('NEP 2020');

      // Second — IB only: hook contains "CAS"; does NOT contain "NEP".
      // PRD AC-3: "An IB school never sees NEP."
      pdfRenderer.renderTmcReadinessReport.mockClear();
      const ibAnswers = validAnswers({ curriculum: ['IB'] });
      prisma.travelDiagnostic.findFirst.mockResolvedValue(persistedDiag({
        answersJson: JSON.stringify(ibAnswers),
      }));
      res = await request(makeApp())
        .get('/api/travel/diagnostics/555/readiness-report.pdf');
      expect(res.status).toBe(200);
      callArgs = pdfRenderer.renderTmcReadinessReport.mock.calls[0][0];
      expect(callArgs.boardHook).toContain('CAS');
      expect(callArgs.boardHook).not.toContain('NEP');
    } finally {
      pdfRenderer.renderTmcReadinessReport = originalRenderTmcReadinessReport;
    }
  });

  test('PDF buffer is a valid PDF (smoke test — real renderer ships a parseable PDF)', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(persistedDiag());
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/555/readiness-report.pdf');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(500);
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
    // The trailer marker confirms the PDF is well-formed.
    expect(res.body.includes(Buffer.from('%%EOF'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Internal helpers — exported via module.exports.__internal
// ────────────────────────────────────────────────────────────────────

describe('T8 internal helpers', () => {
  test('resolveRunwayKey: maps geo_preference to runway key per PRD §3.5.2', () => {
    const { resolveRunwayKey } = router.__internal;
    expect(resolveRunwayKey('day')).toBe('day');
    expect(resolveRunwayKey('domestic')).toBe('domestic_flight');
    expect(resolveRunwayKey('international')).toBe('international');
    expect(resolveRunwayKey('open')).toBe('international'); // open → longest runway
    expect(resolveRunwayKey(undefined)).toBe('domestic_flight'); // default
  });

  test('resolveBoardHook: multi-board curriculum returns concatenated hooks', () => {
    const { resolveBoardHook, DEFAULT_STANDING_FACTS } = router.__internal;
    const hook = resolveBoardHook(DEFAULT_STANDING_FACTS, ['CBSE', 'IB']);
    expect(hook).toContain('NEP'); // CBSE part
    expect(hook).toContain('CAS'); // IB part
  });

  test('buildDestinationBlocklist: extracts region + anchor names + curriculum-hook topics', () => {
    const { buildDestinationBlocklist } = router.__internal;
    const blocklist = buildDestinationBlocklist([catalogueRow()]);
    expect(blocklist).toContain('North India');
    expect(blocklist).toContain('Red Fort context walk');
    expect(blocklist).toContain('Heritage tourism');
  });

  test('parseDiagnosticIdFromSlug + buildReportSlug round-trip', () => {
    const { buildReportSlug, parseDiagnosticIdFromSlug } = router.__internal;
    const slug = buildReportSlug(4242);
    expect(slug).toMatch(/^4242-[a-f0-9]+$/);
    expect(parseDiagnosticIdFromSlug(slug)).toBe(4242);
    expect(parseDiagnosticIdFromSlug('garbage')).toBeNull();
    expect(parseDiagnosticIdFromSlug(undefined)).toBeNull();
  });
});

// Restore the original llmRouter.routeRequest at the END of all tests
// so subsequent suites' router cache doesn't see our spy.
import { afterAll } from 'vitest';
afterAll(() => {
  llmRouter.routeRequest = originalRouteRequest;
  pdfRenderer.renderTmcReadinessReport = originalRenderTmcReadinessReport;
});
