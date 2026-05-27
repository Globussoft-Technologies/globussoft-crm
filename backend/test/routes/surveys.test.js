// @ts-check
/**
 * Unit tests for backend/routes/surveys.js — pins the #613 aggregate-endpoint
 * contract so the Surveys detail view can render NPS / promoter-passive-detractor
 * splits + score distribution from a single server-side computation (no
 * client-side reduce-over-paginated-list bug class).
 *
 * What this file pins
 * ───────────────────
 *   1. GET /:id/aggregate computes the NPS bucket split correctly:
 *      promoters (9-10), passives (7-8), detractors (0-6).
 *   2. NPS formula: (promoters - detractors) / count * 100. Sample
 *      fixture: 5 promoters, 3 passives, 2 detractors of 10 → NPS = 30.
 *   3. Empty survey returns count=0, npsScore=0 (NPS), avgScore=0.
 *   4. Distribution is shaped as [{score, count}, ...] for direct chart binding.
 *   5. Non-NPS surveys return npsScore=null.
 *   6. Tenant scoping is honoured (responses from another tenant are excluded).
 *   7. 404 when survey id is unknown / cross-tenant.
 *
 * Test pattern mirrors backend/test/routes/communications.test.js (prisma
 * singleton monkey-patch + supertest).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// Prisma singleton patching — mounted before the router require below.
prisma.survey = {
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.surveyResponse = {
  findMany: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
};
prisma.contact = {
  findMany: vi.fn(),
};
prisma.patient = {
  findMany: vi.fn(),
};
// v3.7.17 — Parent-child review system tables. The new endpoints under
// /api/surveys/:id/questions, /api/surveys/questions/:qid, and
// /api/surveys/:id/submit need these mocked.
prisma.surveyQuestion = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.surveyAnswer = {
  create: vi.fn(),
  findMany: vi.fn(),
};
prisma.auditLog = {
  findFirst: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({}),
};
prisma.tenant = {
  findUnique: vi.fn(),
};
// Merge note: prisma.patient was defined above (with findMany); this
// adds findFirst on the same object instead of redeclaring (which would
// silently lose findMany).
prisma.patient.findFirst = vi.fn();

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const surveysRouter = requireCJS('../../routes/surveys');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/surveys', surveysRouter);
  return app;
}

beforeEach(() => {
  prisma.survey.findFirst.mockReset();
  prisma.survey.create.mockReset();
  prisma.survey.update.mockReset();
  prisma.survey.findUnique.mockReset();
  prisma.survey.findMany.mockReset();
  prisma.survey.create.mockReset();
  prisma.survey.update.mockReset();
  prisma.survey.delete.mockReset();
  prisma.surveyResponse.findMany.mockReset();
  prisma.surveyResponse.create.mockReset();
  prisma.surveyResponse.deleteMany.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.contact.findMany.mockResolvedValue([]);
  prisma.patient.findMany.mockReset();
  prisma.patient.findMany.mockResolvedValue([]);
  prisma.surveyQuestion.findFirst.mockReset();
  prisma.surveyQuestion.findMany.mockReset();
  prisma.surveyQuestion.create.mockReset();
  prisma.surveyQuestion.update.mockReset();
  prisma.surveyQuestion.delete.mockReset();
  prisma.surveyAnswer.create.mockReset();
  prisma.surveyAnswer.findMany.mockReset();
  prisma.surveyAnswer.findMany.mockResolvedValue([]);
  prisma.auditLog.findFirst.mockReset();
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({});
  prisma.tenant.findUnique.mockReset();
  prisma.tenant.findUnique.mockResolvedValue(null);
  prisma.patient.findFirst.mockReset();
});

// ── Aggregate endpoint ─────────────────────────────────────────────

describe('GET /:id/aggregate — #613 NPS bucket split', () => {
  test('computes NPS=30 for canonical 5/3/2 fixture', async () => {
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, tenantId: 1, type: 'NPS', name: 'Q2 NPS', question: 'How likely?',
    });
    // 5 promoters (10, 10, 9, 9, 9), 3 passives (8, 8, 7), 2 detractors (3, 1) = 10 total
    const scores = [10, 10, 9, 9, 9, 8, 8, 7, 3, 1];
    prisma.surveyResponse.findMany.mockResolvedValue(scores.map(score => ({ score })));

    const res = await request(makeApp()).get('/api/surveys/1/aggregate');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(10);
    expect(res.body.promoters).toBe(5);
    expect(res.body.passives).toBe(3);
    expect(res.body.detractors).toBe(2);
    // (5 - 2) / 10 * 100 = 30
    expect(res.body.npsScore).toBe(30);
    expect(res.body.type).toBe('NPS');
    expect(res.body.avgScore).toBeCloseTo(7.4, 2);
  });

  test('distribution returns [{score, count}, ...] shape across all 11 buckets', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 1, tenantId: 1, type: 'NPS', name: 's', question: 'q' });
    prisma.surveyResponse.findMany.mockResolvedValue([
      { score: 10 }, { score: 10 }, { score: 5 }, { score: 0 },
    ]);
    const res = await request(makeApp()).get('/api/surveys/1/aggregate');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.distribution)).toBe(true);
    expect(res.body.distribution).toHaveLength(11);
    expect(res.body.distribution[0]).toEqual({ score: 0, count: 1 });
    expect(res.body.distribution[5]).toEqual({ score: 5, count: 1 });
    expect(res.body.distribution[10]).toEqual({ score: 10, count: 2 });
    expect(res.body.distribution[7]).toEqual({ score: 7, count: 0 });
  });

  test('empty survey → count=0, NPS=0', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 1, tenantId: 1, type: 'NPS', name: 's', question: 'q' });
    prisma.surveyResponse.findMany.mockResolvedValue([]);
    const res = await request(makeApp()).get('/api/surveys/1/aggregate');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.npsScore).toBe(0);
    expect(res.body.avgScore).toBe(0);
    expect(res.body.promoters).toBe(0);
    expect(res.body.detractors).toBe(0);
  });

  test('CSAT survey returns npsScore=null (only NPS surveys compute it)', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 1, tenantId: 1, type: 'CSAT', name: 's', question: 'q' });
    prisma.surveyResponse.findMany.mockResolvedValue([
      { score: 5 }, { score: 4 }, { score: 3 },
    ]);
    const res = await request(makeApp()).get('/api/surveys/1/aggregate');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('CSAT');
    expect(res.body.npsScore).toBeNull();
    expect(res.body.avgScore).toBeCloseTo(4, 2);
  });

  test('404 for unknown / cross-tenant survey', async () => {
    prisma.survey.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/surveys/999/aggregate');
    expect(res.status).toBe(404);
  });

  test('400 for non-numeric :id', async () => {
    const res = await request(makeApp()).get('/api/surveys/not-a-number/aggregate');
    expect(res.status).toBe(400);
  });

  test('tenant scoping is enforced on the responses query', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 1, tenantId: 1, type: 'NPS', name: 's', question: 'q' });
    prisma.surveyResponse.findMany.mockResolvedValue([{ score: 10 }, { score: 0 }]);
    await request(makeApp({ tenantId: 42 })).get('/api/surveys/1/aggregate');
    // The route should pass req.user.tenantId into BOTH the survey lookup
    // and the responses lookup so cross-tenant data never bleeds through.
    expect(prisma.survey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 42 }) })
    );
    expect(prisma.surveyResponse.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 42 }) })
    );
  });
});

// ── CSV export ─────────────────────────────────────────────────────

describe('GET /:id/export.csv — #613 raw response export', () => {
  test('returns text/csv with header row + one data row per response', async () => {
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, tenantId: 1, type: 'NPS', name: 'Q2', question: 'how likely?',
    });
    prisma.surveyResponse.findMany.mockResolvedValue([
      { score: 9, comment: 'great', contactId: 5, respondedAt: new Date('2026-04-01T10:00:00Z') },
      { score: 6, comment: 'meh, comma here', contactId: null, respondedAt: new Date('2026-04-02T11:00:00Z') },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 5, name: 'Anita Patel', email: 'anita@example.in' },
    ]);

    const res = await request(makeApp()).get('/api/surveys/1/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment.*Q2-responses\.csv/);
    const lines = res.text.split('\r\n');
    expect(lines[0]).toBe('respondedAt,score,contactName,contactEmail,comment');
    expect(lines[1]).toContain(',9,Anita Patel,anita@example.in,great');
    // Comma in comment is escaped via double-quoting.
    expect(lines[2]).toContain('"meh, comma here"');
  });
});

// ── v3.7.17 — Parent-child review system ──────────────────────────────
//
// Pins the new SurveyQuestion + SurveyAnswer surface plumbed alongside
// the legacy NPS / CSAT flow. Each describe covers one endpoint.

describe('POST /api/surveys — multi-question types', () => {
  test('PRODUCT survey accepts title + relatedEntityId; question is optional', async () => {
    prisma.survey.create.mockResolvedValue({
      id: 9, name: 'product-9', title: 'Acne Cream Review', type: 'PRODUCT',
      relatedEntityId: 42, isActive: true, tenantId: 1,
    });
    const res = await request(makeApp()).post('/api/surveys').send({
      name: 'product-9',
      title: 'Acne Cream Review',
      type: 'PRODUCT',
      relatedEntityId: 42,
    });
    expect(res.status).toBe(201);
    const createArgs = prisma.survey.create.mock.calls[0][0];
    expect(createArgs.data.type).toBe('PRODUCT');
    expect(createArgs.data.title).toBe('Acne Cream Review');
    expect(createArgs.data.relatedEntityId).toBe(42);
    // question is null for multi-question types — questions live in
    // SurveyQuestion rows, not on the Survey row.
    expect(createArgs.data.question).toBeNull();
  });

  test('NPS survey still requires the single `question` text (legacy contract preserved)', async () => {
    const res = await request(makeApp()).post('/api/surveys').send({
      name: 'nps-1', type: 'NPS', // no question
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Question is required/);
  });

  test('PRODUCT / SERVICE / DOCTOR surveys require ADMIN or MANAGER role', async () => {
    const res = await request(makeApp({ role: 'USER' })).post('/api/surveys').send({
      name: 'svc-1', type: 'SERVICE', title: 'X',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/ADMIN or MANAGER/);
  });
});

describe('POST /api/surveys/:id/questions — create question', () => {
  function mockSurvey(type = 'PRODUCT') {
    prisma.survey.findFirst.mockResolvedValue({ id: 1, type, tenantId: 1 });
  }

  test('TEXT question — no options or rating required', async () => {
    mockSurvey();
    prisma.surveyQuestion.create.mockResolvedValue({
      id: 10, surveyId: 1, question: 'Why?', fieldType: 'TEXT',
      options: null, minRating: null, maxRating: null, order: 0,
      isRequired: true, isActive: true, tenantId: 1,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(makeApp()).post('/api/surveys/1/questions').send({
      question: 'Why?', fieldType: 'TEXT', order: 0,
    });
    expect(res.status).toBe(201);
    expect(res.body.fieldType).toBe('TEXT');
    expect(res.body.options).toBeNull();
    // The route stores options=null for TEXT.
    expect(prisma.surveyQuestion.create.mock.calls[0][0].data.options).toBeNull();
  });

  test('SELECT question — options array stored as JSON string', async () => {
    mockSurvey();
    prisma.surveyQuestion.create.mockResolvedValue({
      id: 11, surveyId: 1, question: 'Which?', fieldType: 'SELECT',
      options: JSON.stringify(['A', 'B', 'C']), minRating: null, maxRating: null,
      order: 1, isRequired: true, isActive: true, tenantId: 1,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(makeApp()).post('/api/surveys/1/questions').send({
      question: 'Which?', fieldType: 'SELECT', options: ['A', 'B', 'C'], order: 1,
    });
    expect(res.status).toBe(201);
    // API contract: options come back as a parsed array, never a string.
    expect(res.body.options).toEqual(['A', 'B', 'C']);
    // Storage contract: options went to Prisma as a JSON-encoded string
    // (per the JSON-string-column standing rule in CLAUDE.md).
    const dataArg = prisma.surveyQuestion.create.mock.calls[0][0].data;
    expect(typeof dataArg.options).toBe('string');
    expect(JSON.parse(dataArg.options)).toEqual(['A', 'B', 'C']);
  });

  test('SELECT question rejects empty options array with OPTIONS_REQUIRED', async () => {
    mockSurvey();
    const res = await request(makeApp()).post('/api/surveys/1/questions').send({
      question: 'Which?', fieldType: 'SELECT', options: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FIELD_TYPE_REQUIREMENTS_NOT_MET');
    expect(res.body.errors).toContainEqual({ field: 'options', code: 'OPTIONS_REQUIRED' });
  });

  test('SELECT question rejects duplicate options (case-insensitive)', async () => {
    mockSurvey();
    const res = await request(makeApp()).post('/api/surveys/1/questions').send({
      question: 'Which?', fieldType: 'SELECT', options: ['Yes', 'yes', 'Maybe'],
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toContainEqual({ field: 'options', code: 'OPTIONS_DUPLICATE' });
  });

  test('SELECT question rejects empty-string options', async () => {
    mockSurvey();
    const res = await request(makeApp()).post('/api/surveys/1/questions').send({
      question: 'Which?', fieldType: 'SELECT', options: ['Good', '   '],
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toContainEqual({ field: 'options', code: 'OPTIONS_EMPTY' });
  });

  test('RATE question stores minRating + maxRating; rejects inverted range', async () => {
    mockSurvey();
    const res = await request(makeApp()).post('/api/surveys/1/questions').send({
      question: 'Rate it', fieldType: 'RATE', minRating: 5, maxRating: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toContainEqual({ field: 'maxRating', code: 'RATING_RANGE_INVERTED' });
  });

  test('RATE question rejects maxRating > 100', async () => {
    mockSurvey();
    const res = await request(makeApp()).post('/api/surveys/1/questions').send({
      question: 'Rate it', fieldType: 'RATE', minRating: 0, maxRating: 200,
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toContainEqual({ field: 'maxRating', code: 'MAX_RATING_INVALID' });
  });

  test('RATE question — happy path with 1..5 range', async () => {
    mockSurvey();
    prisma.surveyQuestion.create.mockResolvedValue({
      id: 12, surveyId: 1, question: 'Rate', fieldType: 'RATE',
      options: null, minRating: 1, maxRating: 5, order: 0,
      isRequired: true, isActive: true, tenantId: 1,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(makeApp()).post('/api/surveys/1/questions').send({
      question: 'Rate', fieldType: 'RATE', minRating: 1, maxRating: 5,
    });
    expect(res.status).toBe(201);
    expect(res.body.minRating).toBe(1);
    expect(res.body.maxRating).toBe(5);
  });

  test('YES_NO question force-sets options to ["True","False"] regardless of caller input', async () => {
    mockSurvey();
    prisma.surveyQuestion.create.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 13, surveyId: 1, question: 'Was it good?', fieldType: 'YES_NO',
        options: data.options, minRating: null, maxRating: null, order: 0,
        isRequired: true, isActive: true, tenantId: 1,
        createdAt: new Date(), updatedAt: new Date(),
      }),
    );
    const res = await request(makeApp()).post('/api/surveys/1/questions').send({
      question: 'Was it good?',
      fieldType: 'YES_NO',
      // The caller's options are intentionally bogus; server overrides.
      options: ['Yes', 'No', 'Maybe', 'Strong agree'],
    });
    expect(res.status).toBe(201);
    expect(res.body.options).toEqual(['True', 'False']);
  });

  test('rejects unknown fieldType with FIELD_TYPE_INVALID', async () => {
    mockSurvey();
    const res = await request(makeApp()).post('/api/surveys/1/questions').send({
      question: 'X', fieldType: 'SLIDER',
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toContainEqual({ field: 'fieldType', code: 'FIELD_TYPE_INVALID' });
  });

  test('refuses to add questions to a legacy NPS survey', async () => {
    mockSurvey('NPS');
    const res = await request(makeApp()).post('/api/surveys/1/questions').send({
      question: 'X', fieldType: 'TEXT',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SURVEY_TYPE_NOT_MULTI_QUESTION');
  });

  test('non-admin / non-manager role gets 403', async () => {
    const res = await request(makeApp({ role: 'USER' }))
      .post('/api/surveys/1/questions').send({ question: 'X', fieldType: 'TEXT' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/surveys/:id/questions — list ordered questions', () => {
  test('returns questions ordered by `order` with options parsed as arrays', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 1 });
    prisma.surveyQuestion.findMany.mockResolvedValue([
      {
        id: 1, surveyId: 1, question: 'Q1', fieldType: 'SELECT',
        options: JSON.stringify(['A', 'B']), minRating: null, maxRating: null,
        order: 0, isRequired: true, isActive: true,
        createdAt: new Date(), updatedAt: new Date(),
      },
      {
        id: 2, surveyId: 1, question: 'Q2', fieldType: 'RATE',
        options: null, minRating: 1, maxRating: 10,
        order: 1, isRequired: false, isActive: true,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    const res = await request(makeApp()).get('/api/surveys/1/questions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].options).toEqual(['A', 'B']);
    expect(res.body[1].options).toBeNull();
    // The route MUST request rows ordered by order asc, id asc.
    const orderArg = prisma.surveyQuestion.findMany.mock.calls[0][0].orderBy;
    expect(orderArg).toEqual([{ order: 'asc' }, { id: 'asc' }]);
  });
});

describe('PUT /api/surveys/questions/:qid — update', () => {
  test('changing fieldType away from RATE clears stale rating bounds', async () => {
    prisma.surveyQuestion.findFirst.mockResolvedValue({
      id: 5, surveyId: 1, tenantId: 1, question: 'old',
      fieldType: 'RATE', options: null, minRating: 1, maxRating: 5,
      order: 0, isRequired: true, isActive: true,
    });
    prisma.surveyQuestion.update.mockImplementation(({ data, where }) =>
      Promise.resolve({
        id: where.id, surveyId: 1, question: 'old',
        fieldType: data.fieldType || 'RATE',
        options: data.options ?? null,
        minRating: data.minRating === undefined ? 1 : data.minRating,
        maxRating: data.maxRating === undefined ? 5 : data.maxRating,
        order: 0, isRequired: true, isActive: true,
        createdAt: new Date(), updatedAt: new Date(),
      }),
    );
    const res = await request(makeApp()).put('/api/surveys/questions/5').send({
      fieldType: 'TEXT',
    });
    expect(res.status).toBe(200);
    const updArgs = prisma.surveyQuestion.update.mock.calls[0][0];
    expect(updArgs.data.minRating).toBeNull();
    expect(updArgs.data.maxRating).toBeNull();
    expect(updArgs.data.options).toBeNull();
  });
});

describe('DELETE /api/surveys/questions/:qid', () => {
  test('returns 204 and deletes the row', async () => {
    prisma.surveyQuestion.findFirst.mockResolvedValue({ id: 7, surveyId: 1 });
    prisma.surveyQuestion.delete.mockResolvedValue({});
    const res = await request(makeApp()).delete('/api/surveys/questions/7');
    expect(res.status).toBe(204);
    expect(prisma.surveyQuestion.delete).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  test('cross-tenant id returns 404', async () => {
    prisma.surveyQuestion.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).delete('/api/surveys/questions/9999');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/surveys/:id/submit — bulk answer insert', () => {
  test('happy path: inserts one SurveyAnswer row per question in a transaction', async () => {
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, type: 'PRODUCT', isActive: true,
    });
    prisma.surveyQuestion.findMany.mockResolvedValue([
      { id: 11, isRequired: true },
      { id: 12, isRequired: false },
    ]);
    // The route uses prisma.$transaction([...]) — stub it to resolve
    // with one fake row per input call.
    prisma.$transaction = vi.fn().mockResolvedValue([
      { id: 1 }, { id: 2 },
    ]);
    const res = await request(makeApp()).post('/api/surveys/1/submit').send({
      answers: [
        { questionId: 11, answer: 'Great' },
        { questionId: 12, answer: '5' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.submitted).toBe(2);
    // Every answer fired through the transaction batch — no fire-and-
    // forget create calls on the side.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  test('rejects when a required question is missing from the submission', async () => {
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, type: 'PRODUCT', isActive: true,
    });
    prisma.surveyQuestion.findMany.mockResolvedValue([
      { id: 11, isRequired: true },
      { id: 12, isRequired: true },
    ]);
    const res = await request(makeApp()).post('/api/surveys/1/submit').send({
      answers: [{ questionId: 11, answer: 'x' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_ANSWER_MISSING');
  });

  test('rejects answers referencing an unknown questionId', async () => {
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, type: 'PRODUCT', isActive: true,
    });
    prisma.surveyQuestion.findMany.mockResolvedValue([
      { id: 11, isRequired: true },
    ]);
    const res = await request(makeApp()).post('/api/surveys/1/submit').send({
      answers: [{ questionId: 99, answer: 'x' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('QUESTION_ID_INVALID');
  });

  test('rejects submission to a closed (isActive=false) survey with 410', async () => {
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, type: 'PRODUCT', isActive: false,
    });
    const res = await request(makeApp()).post('/api/surveys/1/submit').send({
      answers: [{ questionId: 11, answer: 'x' }],
    });
    expect(res.status).toBe(410);
  });

  test('refuses submission to a legacy NPS survey (use /respond/:token instead)', async () => {
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, type: 'NPS', isActive: true,
    });
    const res = await request(makeApp()).post('/api/surveys/1/submit').send({
      answers: [{ questionId: 11, answer: 'x' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SURVEY_TYPE_NOT_MULTI_QUESTION');
  });
});

// ── POST /:id/send — wellness vertical Patient recipient support ──────
//
// The send endpoint was extended to accept `patientIds` alongside the
// legacy `contactIds`. Pins:
//   - Old payload shape still works (contactIds only).
//   - patientIds-only payload works (no contacts needed).
//   - Both arrays merge into one recipient stream and the response
//     reports per-recipient outcomes tagged with the recipient kind.
//   - 400 when neither array is populated.

describe('POST /:id/send — recipient pool (v3.7.17)', () => {
  test('legacy contactIds-only path keeps working unchanged', async () => {
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, type: 'NPS', isActive: true, name: 'Q2 NPS', question: 'How likely?',
    });
    prisma.contact.findMany.mockResolvedValue([
      { id: 5, name: 'Anita', email: 'anita@example.in' },
    ]);
    const res = await request(makeApp()).post('/api/surveys/1/send').send({
      contactIds: [5],
    });
    expect(res.status).toBe(200);
    expect(res.body.attempted).toBe(1);
    // Patient model must NOT be queried when only contactIds are sent.
    expect(prisma.patient.findMany).not.toHaveBeenCalled();
    // Result row carries the contactId field (back-compat with pre-v3.7.17 callers).
    expect(res.body.results[0].contactId).toBe(5);
    expect(res.body.results[0].kind).toBe('contact');
  });

  test('patientIds-only payload sends to wellness Patient rows', async () => {
    prisma.survey.findFirst.mockResolvedValue({
      id: 9, type: 'PRODUCT', isActive: true, name: 'product-9', title: 'Acne Cream Review',
    });
    prisma.patient.findMany.mockResolvedValue([
      { id: 11, name: 'Priya', email: 'priya@example.in' },
      { id: 12, name: 'Rohit', email: null }, // no email — should report no_email reason
    ]);
    const res = await request(makeApp()).post('/api/surveys/9/send').send({
      patientIds: [11, 12],
    });
    expect(res.status).toBe(200);
    expect(res.body.attempted).toBe(2);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    // Each result row carries patientId + kind=patient.
    const r11 = res.body.results.find((r) => r.patientId === 11);
    const r12 = res.body.results.find((r) => r.patientId === 12);
    expect(r11.kind).toBe('patient');
    expect(r12.kind).toBe('patient');
    expect(r12.reason).toBe('no_email');
  });

  test('mixed contactIds + patientIds payload merges into one recipient stream', async () => {
    prisma.survey.findFirst.mockResolvedValue({
      id: 9, type: 'SERVICE', isActive: true, name: 'svc-9', title: 'GFC Hair feedback',
    });
    prisma.contact.findMany.mockResolvedValue([
      { id: 5, name: 'Anita', email: 'a@example.in' },
    ]);
    prisma.patient.findMany.mockResolvedValue([
      { id: 11, name: 'Priya', email: 'p@example.in' },
    ]);
    const res = await request(makeApp()).post('/api/surveys/9/send').send({
      contactIds: [5],
      patientIds: [11],
    });
    expect(res.status).toBe(200);
    expect(res.body.attempted).toBe(2);
    const kinds = res.body.results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['contact', 'patient']);
  });

  test('400 RECIPIENTS_REQUIRED when neither array is populated', async () => {
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, type: 'NPS', isActive: true,
    });
    const res = await request(makeApp()).post('/api/surveys/1/send').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RECIPIENTS_REQUIRED');
  });
});

// ── Token-based respond endpoints (v3.7.17) ───────────────────────────
//
// Public (no-auth) endpoints that the email-link respondent hits:
//   GET  /respond/:token           — fetch survey (+ questions for multi-Q)
//   POST /respond/:token           — legacy NPS / CSAT single-score submission
//   POST /respond/:token/submit    — multi-question SurveyAnswer bulk insert
//
// The token store is in-memory at module scope (responseTokens Map),
// exported under `surveysRouter.__testHooks` so tests can seed valid
// token entries without going through a real Send flow.

describe('GET + POST /respond/:token (v3.7.17)', () => {
  const { responseTokens } = surveysRouter.__testHooks;

  beforeEach(() => {
    // Token map is module-scoped; reset between tests so a stale
    // entry from a previous test can't leak into this one.
    responseTokens.clear();
  });

  function makePublicApp() {
    // The /respond/:token routes don't read req.user (they're public),
    // but the existing makeApp() injects a fake user — that's fine,
    // these endpoints just don't consult it.
    return makeApp();
  }

  function seedToken(token, override = {}) {
    responseTokens.set(token, {
      surveyId: 1,
      tenantId: 1,
      contactId: 99,
      patientId: null,
      expiresAt: Date.now() + 60_000,
      used: false,
      ...override,
    });
  }

  test('GET /respond/:token returns 404 for an unknown token', async () => {
    const res = await request(makePublicApp()).get('/api/surveys/respond/bogus');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Invalid or expired/);
  });

  test('GET /respond/:token surfaces nested questions for multi-question surveys', async () => {
    seedToken('tok-multi');
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, name: 'svc-1', title: 'Acne Cream Review', type: 'PRODUCT', isActive: true, question: null,
    });
    prisma.surveyQuestion.findMany.mockResolvedValue([
      {
        id: 11, surveyId: 1, question: 'How satisfied?', fieldType: 'RATE',
        options: null, minRating: 1, maxRating: 5, order: 0,
        isRequired: true, isActive: true,
        createdAt: new Date(), updatedAt: new Date(),
      },
      {
        id: 12, surveyId: 1, question: 'Comments?', fieldType: 'TEXTAREA',
        options: null, minRating: null, maxRating: null, order: 1,
        isRequired: false, isActive: true,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    const res = await request(makePublicApp()).get('/api/surveys/respond/tok-multi');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('PRODUCT');
    expect(res.body.title).toBe('Acne Cream Review');
    expect(Array.isArray(res.body.questions)).toBe(true);
    expect(res.body.questions).toHaveLength(2);
    expect(res.body.questions[0].fieldType).toBe('RATE');
    expect(res.body.questions[0].minRating).toBe(1);
    // findMany must request rows ordered by order asc, id asc — same
    // ordering as the admin's question list.
    const orderArg = prisma.surveyQuestion.findMany.mock.calls[0][0].orderBy;
    expect(orderArg).toEqual([{ order: 'asc' }, { id: 'asc' }]);
  });

  test('GET /respond/:token does NOT include `questions` for legacy NPS surveys (back-compat)', async () => {
    seedToken('tok-nps');
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, name: 'nps-1', type: 'NPS', isActive: true, question: 'How likely?', title: null,
    });
    const res = await request(makePublicApp()).get('/api/surveys/respond/tok-nps');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('NPS');
    expect(res.body.question).toBe('How likely?');
    expect(res.body.questions).toBeUndefined();
    // surveyQuestion.findMany must NOT have been called for legacy types.
    expect(prisma.surveyQuestion.findMany).not.toHaveBeenCalled();
  });

  test('POST /respond/:token/submit happy path: inserts one SurveyAnswer per question and marks token used', async () => {
    seedToken('tok-submit');
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, type: 'PRODUCT', isActive: true,
    });
    prisma.surveyQuestion.findMany.mockResolvedValue([
      { id: 11, isRequired: true },
      { id: 12, isRequired: false },
    ]);
    prisma.$transaction = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const res = await request(makePublicApp())
      .post('/api/surveys/respond/tok-submit/submit')
      .send({
        answers: [
          { questionId: 11, answer: '5' },
          { questionId: 12, answer: 'Great service' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.submitted).toBe(2);
    // Token now marked used → a second submit must 410.
    expect(responseTokens.get('tok-submit').used).toBe(true);
  });

  test('POST /respond/:token/submit rejects a second submission on the same token (410 Gone)', async () => {
    seedToken('tok-once', { used: true });
    const res = await request(makePublicApp())
      .post('/api/surveys/respond/tok-once/submit')
      .send({ answers: [{ questionId: 11, answer: 'x' }] });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/already been answered/i);
  });

  test('POST /respond/:token/submit rejects unknown questionId with QUESTION_ID_INVALID', async () => {
    seedToken('tok-bad-qid');
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, type: 'PRODUCT', isActive: true,
    });
    prisma.surveyQuestion.findMany.mockResolvedValue([{ id: 11, isRequired: true }]);
    const res = await request(makePublicApp())
      .post('/api/surveys/respond/tok-bad-qid/submit')
      .send({ answers: [{ questionId: 999, answer: 'x' }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('QUESTION_ID_INVALID');
  });

  test('POST /respond/:token/submit rejects when a required questionId is missing', async () => {
    seedToken('tok-required-missing');
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, type: 'PRODUCT', isActive: true,
    });
    prisma.surveyQuestion.findMany.mockResolvedValue([
      { id: 11, isRequired: true },
      { id: 12, isRequired: true },
    ]);
    const res = await request(makePublicApp())
      .post('/api/surveys/respond/tok-required-missing/submit')
      .send({ answers: [{ questionId: 11, answer: 'x' }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUIRED_ANSWER_MISSING');
  });

  test('POST /respond/:token/submit refuses an NPS survey (use POST /respond/:token instead)', async () => {
    seedToken('tok-nps-submit');
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, type: 'NPS', isActive: true,
    });
    const res = await request(makePublicApp())
      .post('/api/surveys/respond/tok-nps-submit/submit')
      .send({ answers: [{ questionId: 11, answer: '8' }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SURVEY_TYPE_NOT_MULTI_QUESTION');
  });

  test('POST /respond/:token/submit stamps the same submissionId across every answer row in the batch', async () => {
    seedToken('tok-submission-id');
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, type: 'PRODUCT', isActive: true,
    });
    prisma.surveyQuestion.findMany.mockResolvedValue([
      { id: 11, isRequired: false },
      { id: 12, isRequired: false },
    ]);
    // Capture the data argument from every create call so we can
    // assert the grouping key.
    const capturedData = [];
    prisma.$transaction = vi.fn(async (promises) => {
      // The route passes pre-built prisma create promises into
      // $transaction. We don't actually need to execute them — just
      // reach into each call's args, since the route built them via
      // prisma.surveyAnswer.create({ data: … }) which the mock
      // captured below.
      for (const call of prisma.surveyAnswer.create.mock.calls) {
        capturedData.push(call[0].data);
      }
      return promises.map((_, i) => ({ id: i + 1 }));
    });
    prisma.surveyAnswer.create.mockImplementation((args) => Promise.resolve({ id: 1, ...args.data }));

    const res = await request(makePublicApp())
      .post('/api/surveys/respond/tok-submission-id/submit')
      .send({
        answers: [
          { questionId: 11, answer: 'A' },
          { questionId: 12, answer: 'B' },
        ],
      });
    expect(res.status).toBe(201);
    expect(capturedData).toHaveLength(2);
    // Both rows in this submit share one submissionId — that's the
    // whole point of the v3.7.17 column. The id itself is a 32-hex
    // random token; we just need it to be set + identical.
    expect(typeof capturedData[0].submissionId).toBe('string');
    expect(capturedData[0].submissionId).toMatch(/^[0-9a-f]{32}$/);
    expect(capturedData[1].submissionId).toBe(capturedData[0].submissionId);
  });
});

describe('GET /api/surveys/:id/answers — submission grouping (v3.7.17)', () => {
  test('groups answer rows by submissionId, ordered by submittedAt desc', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 9, tenantId: 1 });
    prisma.surveyAnswer.findMany.mockResolvedValue([
      // submission A — newer
      {
        id: 101, surveyId: 9, questionId: 11, userId: null,
        answer: '5', submissionId: 'sub-a', tenantId: 1,
        createdAt: new Date('2026-05-21T10:00:00.000Z'),
        question: { id: 11, question: 'Rate it', fieldType: 'RATE', order: 0 },
      },
      {
        id: 102, surveyId: 9, questionId: 12, userId: null,
        answer: 'Great', submissionId: 'sub-a', tenantId: 1,
        createdAt: new Date('2026-05-21T10:00:00.000Z'),
        question: { id: 12, question: 'Comment', fieldType: 'TEXTAREA', order: 1 },
      },
      // submission B — older
      {
        id: 103, surveyId: 9, questionId: 11, userId: null,
        answer: '3', submissionId: 'sub-b', tenantId: 1,
        createdAt: new Date('2026-05-20T10:00:00.000Z'),
        question: { id: 11, question: 'Rate it', fieldType: 'RATE', order: 0 },
      },
    ]);
    const res = await request(makeApp()).get('/api/surveys/9/answers');
    expect(res.status).toBe(200);
    expect(res.body.submissionCount).toBe(2);
    expect(res.body.answerCount).toBe(3);
    expect(res.body.submissions).toHaveLength(2);
    // Newest submission first.
    expect(res.body.submissions[0].submissionId).toBe('sub-a');
    expect(res.body.submissions[1].submissionId).toBe('sub-b');
    // Inside a submission, answers are sorted by question.order asc.
    expect(res.body.submissions[0].answers[0].questionId).toBe(11);
    expect(res.body.submissions[0].answers[1].questionId).toBe(12);
    // Question metadata (text + fieldType) is inlined on each answer.
    expect(res.body.submissions[0].answers[0].question).toBe('Rate it');
    expect(res.body.submissions[0].answers[0].fieldType).toBe('RATE');
  });

  test('legacy answers (submissionId=null) each render as their own one-row group', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 9, tenantId: 1 });
    prisma.surveyAnswer.findMany.mockResolvedValue([
      {
        id: 200, surveyId: 9, questionId: 11, userId: null,
        answer: 'pre-v3.7.17', submissionId: null, tenantId: 1,
        createdAt: new Date('2026-05-20T09:00:00.000Z'),
        question: { id: 11, question: 'Old Q', fieldType: 'TEXT', order: 0 },
      },
      {
        id: 201, surveyId: 9, questionId: 11, userId: null,
        answer: 'also-pre', submissionId: null, tenantId: 1,
        createdAt: new Date('2026-05-19T09:00:00.000Z'),
        question: { id: 11, question: 'Old Q', fieldType: 'TEXT', order: 0 },
      },
    ]);
    const res = await request(makeApp()).get('/api/surveys/9/answers');
    expect(res.status).toBe(200);
    // Two null-submissionId rows are NOT collapsed into one group —
    // each renders as a one-row legacy submission so the admin sees
    // both pre-v3.7.17 answers separately.
    expect(res.body.submissionCount).toBe(2);
    expect(res.body.submissions[0].submissionId).toBeNull();
    expect(res.body.submissions[1].submissionId).toBeNull();
  });

  test('empty survey returns submissionCount=0, no submissions array entries', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 9, tenantId: 1 });
    prisma.surveyAnswer.findMany.mockResolvedValue([]);
    const res = await request(makeApp()).get('/api/surveys/9/answers');
    expect(res.status).toBe(200);
    expect(res.body.submissionCount).toBe(0);
    expect(res.body.submissions).toEqual([]);
  });

  test('cross-tenant survey id returns 404', async () => {
    prisma.survey.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/surveys/9999/answers');
    expect(res.status).toBe(404);
  });

  test('inlines recipient Contact info (name + email + phone + company) per submission', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 9, tenantId: 1 });
    prisma.surveyAnswer.findMany.mockResolvedValue([
      {
        id: 301, surveyId: 9, questionId: 11, userId: null,
        answer: 'Great', submissionId: 'sub-c', tenantId: 1,
        contactId: 55, patientId: null,
        createdAt: new Date('2026-05-21T10:00:00.000Z'),
        question: { id: 11, question: 'Comments?', fieldType: 'TEXTAREA', order: 0 },
      },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 55, name: 'Anita Patel', email: 'anita@x.test', phone: '+919999', company: 'Acme' },
    ]);
    const res = await request(makeApp()).get('/api/surveys/9/answers');
    expect(res.status).toBe(200);
    expect(res.body.submissions[0].recipient).toEqual({
      kind: 'contact', id: 55, name: 'Anita Patel', email: 'anita@x.test', phone: '+919999', company: 'Acme',
    });
    // The contacts endpoint was queried with the deduped id set.
    expect(prisma.contact.findMany.mock.calls[0][0].where.id.in).toEqual([55]);
    // patient.findMany must NOT have been called — there were no patient rows.
    expect(prisma.patient.findMany).not.toHaveBeenCalled();
  });

  test('inlines recipient Patient info when the submission was sent to a patient', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 9, tenantId: 1 });
    prisma.surveyAnswer.findMany.mockResolvedValue([
      {
        id: 401, surveyId: 9, questionId: 11, userId: null,
        answer: '5', submissionId: 'sub-p', tenantId: 1,
        contactId: null, patientId: 77,
        createdAt: new Date('2026-05-21T10:00:00.000Z'),
        question: { id: 11, question: 'Rate', fieldType: 'RATE', order: 0 },
      },
    ]);
    prisma.patient.findMany.mockResolvedValue([
      { id: 77, name: 'Priya Sharma', email: 'priya@x.test', phone: '+919876500000' },
    ]);
    const res = await request(makeApp()).get('/api/surveys/9/answers');
    expect(res.status).toBe(200);
    expect(res.body.submissions[0].recipient.kind).toBe('patient');
    expect(res.body.submissions[0].recipient.name).toBe('Priya Sharma');
    expect(res.body.submissions[0].recipient.phone).toBe('+919876500000');
  });

  test('submissions with neither contactId nor patientId surface `recipient: null`', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 9, tenantId: 1 });
    prisma.surveyAnswer.findMany.mockResolvedValue([
      {
        id: 501, surveyId: 9, questionId: 11, userId: null,
        answer: 'x', submissionId: 'sub-anon', tenantId: 1,
        contactId: null, patientId: null,
        createdAt: new Date('2026-05-21T10:00:00.000Z'),
        question: { id: 11, question: 'Q', fieldType: 'TEXT', order: 0 },
      },
    ]);
    const res = await request(makeApp()).get('/api/surveys/9/answers');
    expect(res.status).toBe(200);
    expect(res.body.submissions[0].recipient).toBeNull();
  });
});
// ── Authenticated CRUD ─────────────────────────────────────────────

describe('GET / — list surveys with response counts + NPS rollup', () => {
  test('enriches each survey with responseCount, avgScore, and (for NPS) npsScore', async () => {
    prisma.survey.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, type: 'NPS', name: 'Q1 NPS', question: 'q', isActive: true },
      { id: 2, tenantId: 1, type: 'CSAT', name: 'Sat', question: 'q', isActive: true },
    ]);
    // Survey #1: 2 promoters, 1 detractor → NPS = (2-1)/3*100 = 33
    // Survey #2: avg of [4, 5] = 4.5
    prisma.surveyResponse.findMany.mockResolvedValue([
      { surveyId: 1, score: 10 }, { surveyId: 1, score: 9 }, { surveyId: 1, score: 3 },
      { surveyId: 2, score: 4 }, { surveyId: 2, score: 5 },
    ]);

    const res = await request(makeApp()).get('/api/surveys/');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    const s1 = res.body.find(s => s.id === 1);
    expect(s1.responseCount).toBe(3);
    expect(s1.npsScore).toBe(33);
    expect(s1.avgScore).toBeCloseTo(7.33, 1);
    const s2 = res.body.find(s => s.id === 2);
    expect(s2.responseCount).toBe(2);
    expect(s2.avgScore).toBeCloseTo(4.5, 2);
    // CSAT is never an NPS — npsScore stays null.
    expect(s2.npsScore).toBeNull();
  });
});

// ── POST / (create) ────────────────────────────────────────────────

describe('POST / — create survey', () => {
  test('400 when name missing', async () => {
    const res = await request(makeApp())
      .post('/api/surveys/')
      .send({ question: 'How likely?', type: 'NPS' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
    expect(prisma.survey.create).not.toHaveBeenCalled();
  });

  test('400 when question missing', async () => {
    const res = await request(makeApp())
      .post('/api/surveys/')
      .send({ name: 'Q3 NPS', type: 'NPS' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/question/i);
    expect(prisma.survey.create).not.toHaveBeenCalled();
  });

  test('unknown type falls back to NPS default; tenantId stamped from req.user', async () => {
    prisma.survey.create.mockImplementation(async ({ data }) => ({ id: 99, ...data }));
    const res = await request(makeApp({ tenantId: 7 }))
      .post('/api/surveys/')
      .send({ name: 'My Survey', question: 'How?', type: 'NOT_A_TYPE' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('NPS');
    expect(prisma.survey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 7, isActive: true, type: 'NPS' }),
      })
    );
  });
});

// ── PUT /:id (update) + DELETE /:id ────────────────────────────────

describe('PUT /:id — update survey', () => {
  test('404 when survey is missing or cross-tenant', async () => {
    prisma.survey.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/surveys/123')
      .send({ isActive: false });
    expect(res.status).toBe(404);
    expect(prisma.survey.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /:id — also cascades responses for this tenant', () => {
  test('deletes responses first then the survey', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 5, tenantId: 1, type: 'NPS' });
    prisma.surveyResponse.deleteMany.mockResolvedValue({ count: 3 });
    prisma.survey.delete.mockResolvedValue({});

    const res = await request(makeApp()).delete('/api/surveys/5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Order matters — responses must be cleared before the parent (no FK orphan).
    expect(prisma.surveyResponse.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ surveyId: 5, tenantId: 1 }),
      })
    );
    expect(prisma.survey.delete).toHaveBeenCalledWith({ where: { id: 5 } });
  });
});

// ── POST /:id/send ─────────────────────────────────────────────────

describe('POST /:id/send — dispatch survey to contacts', () => {
  test('400 when survey is inactive', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 1, tenantId: 1, type: 'NPS', isActive: false });
    const res = await request(makeApp())
      .post('/api/surveys/1/send')
      .send({ contactIds: [1, 2, 3] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inactive/i);
  });

  test('400 when contactIds is missing or empty', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 1, tenantId: 1, type: 'NPS', isActive: true });
    const res = await request(makeApp())
      .post('/api/surveys/1/send')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contactIds/);
  });

  test('contacts with no email get reason=no_email and are skipped', async () => {
    prisma.survey.findFirst.mockResolvedValue({
      id: 1, tenantId: 1, type: 'NPS', name: 'Q', question: 'q', isActive: true,
    });
    prisma.contact.findMany.mockResolvedValue([
      { id: 10, name: 'No Email', email: null },
      { id: 11, name: 'Has Email', email: 'has@example.com' },
    ]);

    const res = await request(makeApp())
      .post('/api/surveys/1/send')
      .send({ contactIds: [10, 11] });

    expect(res.status).toBe(200);
    expect(res.body.attempted).toBe(2);
    const noEmail = res.body.results.find(r => r.contactId === 10);
    expect(noEmail.sent).toBe(false);
    expect(noEmail.reason).toBe('no_email');
    // Has-email contact still got attempted (mailgun likely unconfigured in test → sent=false reason=no_api_key)
    const hasEmail = res.body.results.find(r => r.contactId === 11);
    expect(hasEmail).toBeDefined();
  });
});

// ── POST /public/:id/respond ───────────────────────────────────────

describe('POST /public/:id/respond — public response submission', () => {
  test('CSAT survey: rejects score > 5 with explicit max in message', async () => {
    prisma.survey.findUnique.mockResolvedValue({
      id: 1, tenantId: 1, type: 'CSAT', isActive: true, question: 'q',
    });
    const res = await request(makeApp())
      .post('/api/surveys/public/1/respond')
      .send({ score: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 0 and 5/);
    expect(prisma.surveyResponse.create).not.toHaveBeenCalled();
  });

  test('410 Gone when public survey is inactive', async () => {
    prisma.survey.findUnique.mockResolvedValue({
      id: 1, tenantId: 1, type: 'NPS', isActive: false, question: 'q',
    });
    const res = await request(makeApp())
      .post('/api/surveys/public/1/respond')
      .send({ score: 8 });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/no longer active/i);
  });
});

// ── GET /:id/responses ─────────────────────────────────────────────

describe('GET /:id/responses — list responses with contact info', () => {
  test('null contactId → contact:null in enriched payload (anonymous response)', async () => {
    prisma.survey.findFirst.mockResolvedValue({ id: 1, tenantId: 1, type: 'NPS' });
    prisma.surveyResponse.findMany.mockResolvedValue([
      { id: 100, surveyId: 1, score: 9, contactId: 5, comment: 'good', respondedAt: new Date() },
      { id: 101, surveyId: 1, score: 4, contactId: null, comment: 'anon', respondedAt: new Date() },
    ]);
    prisma.contact.findMany.mockResolvedValue([
      { id: 5, name: 'Rohan Verma', email: 'rohan@example.in', company: 'Acme' },
    ]);

    const res = await request(makeApp()).get('/api/surveys/1/responses');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const identified = res.body.find(r => r.id === 100);
    expect(identified.contact).toEqual(
      expect.objectContaining({ name: 'Rohan Verma', email: 'rohan@example.in' })
    );
    const anon = res.body.find(r => r.id === 101);
    expect(anon.contact).toBeNull();
  });
});

// ── GET /?fields=summary — slim-shape opt-in (#920 slice 8) ──────────
//
// Mirror of slice 1 (contacts), slice 2 (deals), slice 3 (tickets),
// slice 4 (tasks), slice 5 (projects), slice 6 (expenses), slice 7
// (notifications). When the caller passes ?fields=summary, the route
// emits a slim Prisma `select` keyed on the columns a survey list view
// actually renders (id, name, type, isActive, createdAt) and drops the
// per-survey response rollup (responseCount / avgScore / npsScore) +
// the heavier `question` column.

describe('GET /?fields=summary — slim-shape opt-in (#920 slice 8)', () => {
  test('?fields=summary triggers prisma.survey.findMany with `select` (slim cols), not the default no-select shape', async () => {
    prisma.survey.findMany.mockResolvedValue([]);

    await request(makeApp()).get('/api/surveys/?fields=summary');

    const args = prisma.survey.findMany.mock.calls[0][0];
    expect(args.select).toBeDefined();
    expect(args.select).toEqual({
      id: true,
      name: true,
      type: true,
      isActive: true,
      createdAt: true,
    });
    // Slim shape must NOT include the heavier `question` column or the
    // computed rollup fields (those are server-computed on the full path).
    expect(args.select.question).toBeUndefined();
    expect(args.select.tenantId).toBeUndefined();
    expect(args.select.updatedAt).toBeUndefined();
    // include must NOT be set on slim path.
    expect(args.include).toBeUndefined();
  });

  test('default (no ?fields) preserves the full-row shape — no `select` arg passed to findMany', async () => {
    prisma.survey.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, type: 'NPS', name: 'Q', question: 'q?', isActive: true },
    ]);
    prisma.surveyResponse.findMany.mockResolvedValue([{ surveyId: 1, score: 9 }]);

    await request(makeApp()).get('/api/surveys/');

    const args = prisma.survey.findMany.mock.calls[0][0];
    expect(args.select).toBeUndefined();
    expect(args.include).toBeUndefined();
    // Full path still queries response counts for the rollup whenever
    // surveys exist — this is the cost the slim opt-in avoids.
    expect(prisma.surveyResponse.findMany).toHaveBeenCalled();
  });

  test('?fields=summary response rows reflect the slim Prisma select verbatim and DROP the rollup fields', async () => {
    // Prisma `select` honours only the chosen columns. The route forwards
    // whatever Prisma returns, so we pin the contract by mocking the slim
    // rows and confirming heavy keys + rollup are absent in the body.
    prisma.survey.findMany.mockResolvedValue([
      { id: 1, name: 'Slim A', type: 'NPS', isActive: true, createdAt: new Date('2026-05-26T00:00:00Z') },
      { id: 2, name: 'Slim B', type: 'CSAT', isActive: false, createdAt: new Date('2026-05-26T01:00:00Z') },
    ]);

    const res = await request(makeApp()).get('/api/surveys/?fields=summary');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    for (const row of res.body) {
      expect(row.id).toBeDefined();
      expect(row.name).toBeDefined();
      expect(row.type).toBeDefined();
      expect(row.isActive).toBeDefined();
      // Heavy + server-computed fields MUST be absent in the slim shape.
      expect(row.question).toBeUndefined();
      expect(row.responseCount).toBeUndefined();
      expect(row.avgScore).toBeUndefined();
      expect(row.npsScore).toBeUndefined();
    }
    // The slim path must NOT call surveyResponse.findMany — opt-in skips
    // the per-survey rollup query entirely (cheap-list contract).
    expect(prisma.surveyResponse.findMany).not.toHaveBeenCalled();
  });

  test('?fields=summary preserves tenant isolation on the where clause', async () => {
    prisma.survey.findMany.mockResolvedValue([]);

    await request(makeApp({ tenantId: 42 })).get('/api/surveys/?fields=summary');

    const args = prisma.survey.findMany.mock.calls[0][0];
    // tenantId is sourced from req.user (JWT), not the query.
    expect(args.where).toEqual({ tenantId: 42 });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  test('?fields=other (any non-exact value) falls through to the default enriched shape', async () => {
    // Only the literal string "summary" opts into slim — every other value
    // (including "Summary", "full", arbitrary tokens) must preserve the
    // existing wire shape so we don't accidentally trim production callers.
    prisma.survey.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, type: 'NPS', name: 'Q', question: 'q?', isActive: true },
    ]);
    prisma.surveyResponse.findMany.mockResolvedValue([
      { surveyId: 1, score: 10 }, { surveyId: 1, score: 9 }, { surveyId: 1, score: 0 },
    ]);

    const res = await request(makeApp()).get('/api/surveys/?fields=Summary');

    expect(res.status).toBe(200);
    expect(prisma.survey.findMany.mock.calls[0][0].select).toBeUndefined();
    // Full enriched shape includes the rollup fields.
    expect(res.body[0]).toEqual(expect.objectContaining({
      id: 1,
      question: 'q?',
      responseCount: 3,
      npsScore: expect.any(Number),
      avgScore: expect.any(Number),
    }));
  });

  test('?fields=summary still orders by createdAt desc and scopes to req.user.tenantId', async () => {
    prisma.survey.findMany.mockResolvedValue([
      { id: 3, name: 'Newest', type: 'NPS', isActive: true, createdAt: new Date('2026-05-26T03:00:00Z') },
      { id: 2, name: 'Older',  type: 'NPS', isActive: true, createdAt: new Date('2026-05-26T02:00:00Z') },
      { id: 1, name: 'Oldest', type: 'NPS', isActive: false, createdAt: new Date('2026-05-26T01:00:00Z') },
    ]);

    const res = await request(makeApp({ tenantId: 7 })).get('/api/surveys/?fields=summary');

    expect(res.status).toBe(200);
    expect(res.body.map(r => r.id)).toEqual([3, 2, 1]);
    const args = prisma.survey.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.where).toEqual({ tenantId: 7 });
  });
});

