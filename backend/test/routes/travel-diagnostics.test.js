// @ts-check
/**
 * Travel CRM — diagnostic engine route (backend/routes/travel_diagnostics.js)
 * contract pin (Phase 1 MVP, ~884 LOC).
 *
 * What's pinned
 * -------------
 *   - Question banks (3 routes):
 *       GET    /diagnostic-banks                    all-roles, tenant+sub-brand scoped
 *       GET    /diagnostic-banks/:id                INVALID_ID + NOT_FOUND
 *                                                   + SUB_BRAND_DENIED for non-admins
 *       POST   /diagnostic-banks                    ADMIN-only, MISSING_FIELDS,
 *                                                   INVALID_JSON, EMPTY_QUESTIONS,
 *                                                   EMPTY_BANDS, version auto-increment
 *   - Diagnostic submissions (4 routes):
 *       POST   /diagnostics                         MISSING_FIELDS, BANK_NOT_FOUND,
 *                                                   BANK_INACTIVE, scores + persists
 *       GET    /diagnostics                         pagination + filter scoping
 *       GET    /diagnostics/:id                     INVALID_ID + NOT_FOUND
 *       POST   /diagnostics/:id/talking-points/regen ADMIN/MANAGER-gated, persists
 *                                                   talkingPointsJson envelope
 *       POST   /diagnostics/:id/form-vs-call/compare ADMIN/MANAGER-gated, requires
 *                                                   callAnswers OR callTranscript
 *   - Public endpoints (no auth — Phase 2 Travel Stall wizard):
 *       GET    /diagnostics/public/banks            tenant resolved by ?tenantSlug,
 *                                                   scoringRulesJson STRIPPED
 *       POST   /diagnostics/public/submit           dedup-aware contact create,
 *                                                   raw score NOT in response
 *
 * Pinned guards: verifyToken → [verifyRole?] → requireTravelTenant → handler.
 * Public routes bypass auth (allowlisted in server.js openPaths).
 *
 * Failure-path codes pinned by the route source as of this commit:
 *   400 INVALID_ID / INVALID_BANK_ID / MISSING_FIELDS / INVALID_JSON /
 *       EMPTY_QUESTIONS / EMPTY_BANDS / INVALID_SUB_BRAND
 *   401 — verifyToken (missing Bearer)
 *   403 WRONG_VERTICAL / SUB_BRAND_DENIED — guard stack
 *   404 NOT_FOUND / BANK_NOT_FOUND / TENANT_NOT_FOUND
 *   409 BANK_INACTIVE — submission against deactivated bank
 *   500 BANK_CORRUPTED — bank JSON unparseable at submit time
 *
 * Test pattern mirrors backend/test/routes/travel-visa-analytics.test.js
 * (commit 84593764) — patch the prisma singleton + mock the LLM router +
 * mock the PDF renderer BEFORE requiring the route, then drive supertest
 * with real HS256 JWTs signed with the dev-fallback secret. verifyToken +
 * verifyRole + requireTravelTenant all stay in the chain.
 *
 * Scope note: this file is large (884 LOC, 9 endpoints). We pin the
 * high-value contracts — auth/vertical/role gates, the bank-create JSON
 * validation chain, the diagnostic-submit happy + BANK_INACTIVE paths,
 * and the public-quiz scoring-strip + customer-facing payload. We do NOT
 * exhaustively cover every error branch (PDF best-effort failures,
 * llmRouter network errors, dedup-result-attach branches) — those land
 * in the e2e gate spec at e2e/tests/travel-diagnostics-api.spec.js.
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
// vi.mock() cannot reliably intercept the SUT's `require()` of a CJS module
// when the SUT is itself loaded via createRequire. The proven pattern
// (callified.test.js + ratehawk.test.js + booking_expedia.test.js) is to
// require the module here + overwrite its `module.exports.fn` properties.
// The router then sees the patched fns in its closure when it require()s
// these modules — same singleton instance.

const llmRouter = requireCJS('../../lib/llmRouter');
llmRouter.routeRequest = vi.fn();

const pdfRenderer = requireCJS('../../services/pdfRenderer');
pdfRenderer.renderTravelDiagnosticPdf = vi.fn();

const dedup = requireCJS('../../utils/deduplication');
dedup.findDuplicateContactFull = vi.fn();

// Stub fs.promises.writeFile + mkdirSync so the route's PDF best-effort
// write doesn't touch disk. We patch on the cached module — same node
// global fs across both the test file and the route.
const fs = requireCJS('fs');
const originalWriteFile = fs.promises.writeFile;
const originalMkdirSync = fs.mkdirSync;
fs.promises.writeFile = vi.fn().mockResolvedValue(undefined);
fs.mkdirSync = vi.fn();

// Patch prisma singleton.
prisma.travelDiagnosticQuestionBank = {
  ...(prisma.travelDiagnosticQuestionBank || {}),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
};
prisma.travelDiagnostic = {
  ...(prisma.travelDiagnostic || {}),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
};
prisma.contact = {
  ...(prisma.contact || {}),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.tenant.findFirst = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
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

// Bank scoring fixture — single-question, two-band, weighted-sum.
const QUESTIONS_JSON = JSON.stringify({
  method: 'weighted-sum',
  questions: [
    {
      id: 'budget',
      text: 'What is your budget?',
      type: 'single',
      options: [
        { value: 'low', label: 'Low', weight: 1 },
        { value: 'high', label: 'High', weight: 5 },
      ],
    },
  ],
});
const SCORING_JSON = JSON.stringify({
  bands: [
    { minScore: 0, maxScore: 2, classification: 'level_1', label: 'Budget', recommendedTier: 'entry' },
    { minScore: 3, maxScore: 10, classification: 'level_2', label: 'Premium', recommendedTier: 'premium' },
  ],
});

function bankRow(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    version: 1,
    questionsJson: QUESTIONS_JSON,
    scoringRulesJson: SCORING_JSON,
    isActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelDiagnosticQuestionBank.findMany.mockReset().mockResolvedValue([]);
  prisma.travelDiagnosticQuestionBank.findFirst.mockReset().mockResolvedValue(null);
  prisma.travelDiagnosticQuestionBank.create.mockReset().mockResolvedValue(bankRow());
  prisma.travelDiagnostic.findMany.mockReset().mockResolvedValue([]);
  prisma.travelDiagnostic.findFirst.mockReset().mockResolvedValue(null);
  prisma.travelDiagnostic.create.mockReset().mockResolvedValue({
    id: 500, tenantId: 1, subBrand: 'tmc', contactId: null, leadId: null,
    questionBankId: 100, answersJson: '{}', score: 5,
    classification: 'level_2', classificationLabel: 'Premium', recommendedTier: 'premium',
    reportPdfUrl: null, talkingPointsJson: null, formVsCallJson: null,
  });
  prisma.travelDiagnostic.update.mockReset().mockResolvedValue({ id: 500 });
  prisma.travelDiagnostic.count.mockReset().mockResolvedValue(0);
  prisma.contact.findUnique.mockReset().mockResolvedValue(null);
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.contact.create.mockReset().mockResolvedValue({ id: 900, tenantId: 1 });
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.tenant.findFirst.mockReset().mockResolvedValue(null);
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  llmRouter.routeRequest.mockReset().mockResolvedValue({
    text: '[STUB-TALKING-POINTS] 85% match (synthetic)',
    model: 'stub-claude-opus',
    stub: true,
  });
  pdfRenderer.renderTravelDiagnosticPdf.mockReset().mockResolvedValue(Buffer.from('stub-pdf'));
  dedup.findDuplicateContactFull.mockReset().mockResolvedValue(null);
});

// ─── Auth + vertical gates ────────────────────────────────────────────

describe('travel-diagnostics — auth + vertical gates', () => {
  test('missing Bearer on GET /diagnostic-banks → 401', async () => {
    const res = await request(makeApp()).get('/api/travel/diagnostic-banks');
    expect(res.status).toBe(401);
    expect(prisma.travelDiagnosticQuestionBank.findMany).not.toHaveBeenCalled();
  });

  test('non-travel tenant → 403 WRONG_VERTICAL (GET /diagnostic-banks)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Co', slug: 'generic',
    });
    const res = await request(makeApp())
      .get('/api/travel/diagnostic-banks')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.travelDiagnosticQuestionBank.findMany).not.toHaveBeenCalled();
  });

  test('USER role rejected by verifyRole on POST /diagnostic-banks (ADMIN-only)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/diagnostic-banks')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ subBrand: 'tmc', questionsJson: QUESTIONS_JSON, scoringRulesJson: SCORING_JSON });
    expect(res.status).toBe(403);
    // verifyRole rejects before the route handler — no DB write attempted.
    expect(prisma.travelDiagnosticQuestionBank.create).not.toHaveBeenCalled();
  });
});

// ─── GET /diagnostic-banks ────────────────────────────────────────────

describe('GET /diagnostic-banks', () => {
  test('happy: lists banks scoped to tenant, active filter applied', async () => {
    prisma.travelDiagnosticQuestionBank.findMany.mockResolvedValue([
      bankRow({ id: 100, subBrand: 'tmc', version: 2, isActive: true }),
      bankRow({ id: 99, subBrand: 'tmc', version: 1, isActive: false }),
    ]);
    const res = await request(makeApp())
      .get('/api/travel/diagnostic-banks?subBrand=tmc&active=true')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.banks).toHaveLength(2);
    expect(prisma.travelDiagnosticQuestionBank.findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 1, subBrand: 'tmc', isActive: true },
      orderBy: [{ subBrand: 'asc' }, { version: 'desc' }],
      take: 100,
    });
  });

  test('invalid subBrand → 400 INVALID_SUB_BRAND from assertValidSubBrand', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostic-banks?subBrand=NOPE')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
  });
});

// ─── GET /diagnostic-banks/:id ────────────────────────────────────────

describe('GET /diagnostic-banks/:id', () => {
  test('non-numeric id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostic-banks/not-a-number')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelDiagnosticQuestionBank.findFirst).not.toHaveBeenCalled();
  });

  test('row missing → 404 NOT_FOUND', async () => {
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/diagnostic-banks/100')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('sub-brand-restricted user denied → 403 SUB_BRAND_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(bankRow({ subBrand: 'tmc' }));
    const res = await request(makeApp())
      .get('/api/travel/diagnostic-banks/100')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
  });
});

// ─── POST /diagnostic-banks (ADMIN) ────────────────────────────────────

describe('POST /diagnostic-banks (ADMIN)', () => {
  test('missing fields → 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostic-banks')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ subBrand: 'tmc' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelDiagnosticQuestionBank.create).not.toHaveBeenCalled();
  });

  test('unparseable questionsJson → 400 INVALID_JSON', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostic-banks')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        questionsJson: '{not valid json',
        scoringRulesJson: SCORING_JSON,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_JSON' });
  });

  test('empty questions array → 400 EMPTY_QUESTIONS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostic-banks')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        questionsJson: JSON.stringify({ questions: [], method: 'weighted-sum' }),
        scoringRulesJson: SCORING_JSON,
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_QUESTIONS' });
  });

  test('empty bands array → 400 EMPTY_BANDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostic-banks')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        questionsJson: QUESTIONS_JSON,
        scoringRulesJson: JSON.stringify({ bands: [] }),
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_BANDS' });
  });

  test('happy: creates with auto-incremented version per (tenantId, subBrand)', async () => {
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue({ version: 3 });
    prisma.travelDiagnosticQuestionBank.create.mockResolvedValue(bankRow({ version: 4 }));
    const res = await request(makeApp())
      .post('/api/travel/diagnostic-banks')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        subBrand: 'tmc',
        questionsJson: QUESTIONS_JSON,
        scoringRulesJson: SCORING_JSON,
      });
    expect(res.status).toBe(201);
    // Confirm next-version computation found existing max + 1.
    expect(prisma.travelDiagnosticQuestionBank.findFirst.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 1, subBrand: 'tmc' },
      orderBy: { version: 'desc' },
    });
    const createCall = prisma.travelDiagnosticQuestionBank.create.mock.calls[0][0];
    expect(createCall.data).toMatchObject({
      tenantId: 1,
      subBrand: 'tmc',
      version: 4,
      isActive: true,
    });
  });
});

// ─── POST /diagnostics (submit) ───────────────────────────────────────

describe('POST /diagnostics (submit)', () => {
  test('missing bankId or answers → 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostics')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ bankId: 100 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelDiagnostic.create).not.toHaveBeenCalled();
  });

  test('bank not found → 404 BANK_NOT_FOUND', async () => {
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/diagnostics')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ bankId: 100, answers: { budget: 'high' } });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'BANK_NOT_FOUND' });
  });

  test('inactive bank → 409 BANK_INACTIVE', async () => {
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(bankRow({ isActive: false }));
    const res = await request(makeApp())
      .post('/api/travel/diagnostics')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ bankId: 100, answers: { budget: 'high' } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'BANK_INACTIVE' });
    expect(prisma.travelDiagnostic.create).not.toHaveBeenCalled();
  });

  test('happy: scores via weighted-sum + persists snapshot + surfaces classification', async () => {
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(bankRow());
    // budget=high (weight 5) → score 5 → band level_2 / Premium / premium.
    const res = await request(makeApp())
      .post('/api/travel/diagnostics')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ bankId: 100, answers: { budget: 'high' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      score: 5,
      classification: 'level_2',
      classificationLabel: 'Premium',
      recommendedTier: 'premium',
    });
    // Persist call captured the snapshot + correct tenantId/subBrand.
    const createCall = prisma.travelDiagnostic.create.mock.calls[0][0];
    expect(createCall.data).toMatchObject({
      tenantId: 1,
      subBrand: 'tmc',
      questionBankId: 100,
      score: 5,
      classification: 'level_2',
    });
    // The questionsJson column holds a JSON-stringified snapshot envelope.
    const snapshot = JSON.parse(createCall.data.questionsJson);
    expect(snapshot).toMatchObject({
      bankId: 100,
      bankVersion: 1,
      questionsJson: QUESTIONS_JSON,
    });
  });
});

// ─── GET /diagnostics + GET /diagnostics/:id ──────────────────────────

describe('GET /diagnostics (list)', () => {
  test('happy: paginated with default limit, filters narrow where clause', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([{ id: 500 }, { id: 501 }]);
    prisma.travelDiagnostic.count.mockResolvedValue(2);
    const res = await request(makeApp())
      .get('/api/travel/diagnostics?subBrand=tmc&classification=level_2&contactId=42&limit=25&offset=10')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 2,
      limit: 25,
      offset: 10,
    });
    expect(prisma.travelDiagnostic.findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 1, subBrand: 'tmc', classification: 'level_2', contactId: 42 },
      orderBy: { createdAt: 'desc' },
      take: 25,
      skip: 10,
    });
  });

  test('non-numeric :id on GET /diagnostics/:id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });
});

// ─── POST /diagnostics/:id/talking-points/regen ───────────────────────

describe('POST /diagnostics/:id/talking-points/regen', () => {
  test('USER role rejected (ADMIN/MANAGER only)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/500/talking-points/regen')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});
    expect(res.status).toBe(403);
    expect(llmRouter.routeRequest).not.toHaveBeenCalled();
  });

  test('diagnostic not found → 404 NOT_FOUND', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/500/talking-points/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(llmRouter.routeRequest).not.toHaveBeenCalled();
  });

  test('happy: calls llmRouter with task=talking-points, persists envelope', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue({
      id: 500, tenantId: 1, subBrand: 'tmc', contactId: 42,
      classification: 'level_2', classificationLabel: 'Premium', recommendedTier: 'premium',
      answersJson: '{"budget":"high"}',
    });
    prisma.contact.findFirst.mockResolvedValue({ name: 'Test Lead', company: 'Test Co' });
    prisma.travelDiagnostic.update.mockResolvedValue({
      id: 500, talkingPointsJson: 'snapshot',
    });

    const res = await request(makeApp())
      .post('/api/travel/diagnostics/500/talking-points/regen')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.talkingPoints).toMatchObject({
      text: '[STUB-TALKING-POINTS] 85% match (synthetic)',
      model: 'stub-claude-opus',
      stub: true,
    });
    expect(res.body.talkingPoints.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(llmRouter.routeRequest).toHaveBeenCalledWith(expect.objectContaining({
      task: 'talking-points',
      tenantId: 1,
      payload: expect.objectContaining({
        classification: 'level_2',
        recommendedTier: 'premium',
        subBrand: 'tmc',
        answers: { budget: 'high' },
        contact: { name: 'Test Lead', company: 'Test Co' },
      }),
    }));
    // Envelope persisted via update().
    const updateCall = prisma.travelDiagnostic.update.mock.calls[0][0];
    const persistedEnvelope = JSON.parse(updateCall.data.talkingPointsJson);
    expect(persistedEnvelope).toMatchObject({
      text: '[STUB-TALKING-POINTS] 85% match (synthetic)',
      stub: true,
    });
  });
});

// ─── POST /diagnostics/:id/form-vs-call/compare ───────────────────────

describe('POST /diagnostics/:id/form-vs-call/compare', () => {
  test('neither callAnswers nor callTranscript → 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/500/form-vs-call/compare')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelDiagnostic.findFirst).not.toHaveBeenCalled();
  });

  test('happy: parses LLM percentage + classifies match/review/mismatch (85% → match)', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue({
      id: 500, tenantId: 1, subBrand: 'tmc',
      classification: 'level_2', classificationLabel: 'Premium',
      answersJson: '{"budget":"high"}',
    });
    // Stub returns "85% match" → ≥80 → classification=match.
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/500/form-vs-call/compare')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ callAnswers: { budget: 'high' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      diagnosticId: 500,
      classification: 'match',
      scorePercent: 85,
      stub: true,
    });
    // perFieldDiff includes the matching form key.
    expect(res.body.perFieldDiff).toEqual([
      expect.objectContaining({
        question: 'budget',
        formValue: 'high',
        callValue: 'high',
        matched: true,
      }),
    ]);
    // LLM router was invoked with task=form-vs-call.
    expect(llmRouter.routeRequest).toHaveBeenCalledWith(expect.objectContaining({
      task: 'form-vs-call',
      tenantId: 1,
    }));
  });

  test('LLM text without a percentage → scorePercent null + classification unknown', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue({
      id: 500, tenantId: 1, subBrand: 'tmc',
      classification: 'level_2', answersJson: '{}',
    });
    llmRouter.routeRequest.mockResolvedValue({
      text: 'Advisor should call to clarify — no clear match signal.',
      model: 'stub',
      stub: true,
    });
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/500/form-vs-call/compare')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ callTranscript: 'transcript text' });
    expect(res.status).toBe(200);
    expect(res.body.scorePercent).toBeNull();
    expect(res.body.classification).toBe('unknown');
  });
});

// ─── Public: GET /diagnostics/public/banks ────────────────────────────

describe('GET /diagnostics/public/banks (no auth)', () => {
  test('missing tenantSlug or subBrand → 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/public/banks?tenantSlug=travelstall');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
  });

  test('tenant slug resolves but no active bank → 404 BANK_NOT_FOUND', async () => {
    prisma.tenant.findFirst.mockResolvedValue({
      id: 1, slug: 'travelstall', name: 'Travel Stall', vertical: 'travel',
    });
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/public/banks?tenantSlug=travelstall&subBrand=travelstall');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'BANK_NOT_FOUND' });
  });

  test('happy: strips per-option weights so scoring rules cannot be reverse-engineered', async () => {
    prisma.tenant.findFirst.mockResolvedValue({
      id: 1, slug: 'travelstall', name: 'Travel Stall', vertical: 'travel',
    });
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(
      bankRow({ subBrand: 'travelstall', version: 3 }),
    );
    const res = await request(makeApp())
      .get('/api/travel/diagnostics/public/banks?tenantSlug=travelstall&subBrand=travelstall');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantSlug: 'travelstall',
      subBrand: 'travelstall',
      bankId: 100,
      version: 3,
    });
    // Critical: every option exposes ONLY value + label — NO weight field.
    for (const q of res.body.questions) {
      for (const opt of q.options) {
        expect(opt).toHaveProperty('value');
        expect(opt).toHaveProperty('label');
        expect(opt).not.toHaveProperty('weight');
      }
    }
    // scoringRulesJson is not in the response envelope.
    expect(res.body.scoringRulesJson).toBeUndefined();
  });
});

// ─── Public: POST /diagnostics/public/submit ──────────────────────────

describe('POST /diagnostics/public/submit (no auth)', () => {
  test('missing required fields → 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit')
      .send({ tenantSlug: 'travelstall', subBrand: 'travelstall' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelDiagnostic.create).not.toHaveBeenCalled();
  });

  test('tenant slug not found → 404 TENANT_NOT_FOUND', async () => {
    prisma.tenant.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit')
      .send({
        tenantSlug: 'nope',
        subBrand: 'travelstall',
        bankId: 100,
        answers: { budget: 'high' },
        name: 'Jane Doe',
        phone: '+919876543210',
      });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'TENANT_NOT_FOUND' });
  });

  test('happy: customer-facing payload omits raw score + contactId + diagnosticId', async () => {
    prisma.tenant.findFirst.mockResolvedValue({
      id: 1, slug: 'travelstall', name: 'Travel Stall', vertical: 'travel',
    });
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(
      bankRow({ subBrand: 'travelstall' }),
    );
    // No existing contact → dedup returns null → create new Contact.
    dedup.findDuplicateContactFull.mockResolvedValue(null);
    prisma.contact.create.mockResolvedValue({ id: 900, tenantId: 1 });
    prisma.travelDiagnostic.create.mockResolvedValue({
      id: 700, tenantId: 1, subBrand: 'travelstall',
      score: 5, classification: 'level_2',
      classificationLabel: 'Premium', recommendedTier: 'premium',
    });

    const res = await request(makeApp())
      .post('/api/travel/diagnostics/public/submit')
      .send({
        tenantSlug: 'travelstall',
        subBrand: 'travelstall',
        bankId: 100,
        answers: { budget: 'high' },
        name: 'Jane Doe',
        phone: '+919876543210',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      tenantSlug: 'travelstall',
      subBrand: 'travelstall',
      classification: 'level_2',
      classificationLabel: 'Premium',
      recommendedTier: 'premium',
    });
    expect(res.body.message).toMatch(/Jane/);
    // PII discipline — raw score + internal IDs MUST NOT leak.
    expect(res.body.score).toBeUndefined();
    expect(res.body.contactId).toBeUndefined();
    expect(res.body.diagnosticId).toBeUndefined();
    // Contact created with subBrand stamp + Lead status + correct tenantId.
    expect(prisma.contact.create.mock.calls[0][0].data).toMatchObject({
      tenantId: 1,
      subBrand: 'travelstall',
      status: 'Lead',
      source: 'Travel Stall public quiz',
      name: 'Jane Doe',
      phone: '+919876543210',
    });
  });
});
