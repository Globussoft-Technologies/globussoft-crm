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
};
prisma.surveyResponse = {
  findMany: vi.fn(),
};
prisma.contact = {
  findMany: vi.fn(),
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
  prisma.surveyResponse.findMany.mockReset();
  prisma.contact.findMany.mockReset();
  prisma.contact.findMany.mockResolvedValue([]);
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
