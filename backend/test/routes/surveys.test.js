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
prisma.tenant = {
  findUnique: vi.fn(),
};
prisma.patient = {
  findFirst: vi.fn(),
};

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const surveysRouter = requireCJS('../../routes/surveys');

function makeApp({ tenantId = 1, userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId };
    next();
  });
  app.use('/api/surveys', surveysRouter);
  return app;
}

beforeEach(() => {
  prisma.survey.findFirst.mockReset();
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

