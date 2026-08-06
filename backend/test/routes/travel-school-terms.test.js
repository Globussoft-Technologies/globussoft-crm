// @ts-check
// Unit tests for backend/routes/travel_school_terms.js — TMC school
// term/holiday/exam-blackout calendar CRUD + the /check date helper.
//
// Pattern: patch authMw.verifyToken + the RBAC gate to pass-through BEFORE
// requiring the route (so the role gate doesn't block handler tests), inject
// req.user via app middleware, and replace the prisma singleton's
// travelSchoolTerm delegate with bare vi.fn() surfaces.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

prisma.travelSchoolTerm = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

import express from 'express';
import request from 'supertest';
const router = requireCJS('../../routes/travel_school_terms');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { userId, tenantId, role }; next(); });
  app.use('/api/travel-school-terms', router);
  return app;
}

beforeEach(() => {
  prisma.travelSchoolTerm.findMany.mockReset().mockResolvedValue([]);
  prisma.travelSchoolTerm.findFirst.mockReset().mockResolvedValue(null);
  prisma.travelSchoolTerm.create.mockReset().mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
  prisma.travelSchoolTerm.update.mockReset().mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
});

describe('GET /api/travel-school-terms', () => {
  test('lists rows scoped to the tenant', async () => {
    prisma.travelSchoolTerm.findMany.mockResolvedValue([{ id: 1, label: 'Summer Break' }]);
    const res = await request(makeApp({ tenantId: 42 })).get('/api/travel-school-terms?kind=holiday');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const args = prisma.travelSchoolTerm.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ tenantId: 42, kind: 'holiday' });
  });
});

describe('GET /api/travel-school-terms/check', () => {
  test('400 when date is missing', async () => {
    const res = await request(makeApp()).get('/api/travel-school-terms/check');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('a holiday window → ok:true; an exam window → ok:false + blocking', async () => {
    // Dates are generated relative to now, not hardcoded — the route rejects
    // past dates, so a literal like '2026-05-01' silently rots into a 400 the
    // day it falls behind the clock.
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 30);
    const soonIso = soon.toISOString().slice(0, 10);

    // Holiday match → trips are fine.
    prisma.travelSchoolTerm.findMany.mockResolvedValueOnce([
      { id: 1, kind: 'holiday', label: 'Summer Break', schoolName: null, startDate: new Date(), endDate: new Date() },
    ]);
    let res = await request(makeApp()).get(`/api/travel-school-terms/check?date=${soonIso}`);
    expect(res.status).toBe(200);
    expect(res.body.inWindow).toBe(true);
    expect(res.body.ok).toBe(true);
    expect(res.body.blocking).toHaveLength(0);

    // Exam-blackout match → not ok, surfaced as blocking.
    prisma.travelSchoolTerm.findMany.mockResolvedValueOnce([
      { id: 2, kind: 'exam-blackout', label: 'Half-yearly Exams', schoolName: 'DPS', startDate: new Date(), endDate: new Date() },
    ]);
    res = await request(makeApp()).get(`/api/travel-school-terms/check?date=${soonIso}&schoolName=DPS`);
    expect(res.body.ok).toBe(false);
    expect(res.body.blocking[0]).toMatchObject({ kind: 'exam-blackout' });
    // The school's own AND baseline (null) windows are queried.
    const where = prisma.travelSchoolTerm.findMany.mock.calls[1][0].where;
    expect(where.OR).toEqual([{ schoolName: 'DPS' }, { schoolName: null }]);
  });

  // A future date, built at call time so these never age into the past.
  const futureDate = () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 30);
    return d.toISOString().slice(0, 10);
  };

  test('a date with NO window on file → status "unknown", not a green light', async () => {
    // Regression: `ok` is true whenever nothing BLOCKS the date, which is
    // also true when no window covers it at all — so a date the calendar
    // knows nothing about rendered identically to a confirmed holiday.
    prisma.travelSchoolTerm.findMany.mockResolvedValueOnce([]);

    const res = await request(makeApp()).get(`/api/travel-school-terms/check?date=${futureDate()}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unknown');
    expect(res.body.inWindow).toBe(false);
    expect(res.body.matches).toHaveLength(0);
    expect(res.body.blocking).toHaveLength(0);
  });

  test('a holiday window → status "clear"; a term window → status "blocked"', async () => {
    prisma.travelSchoolTerm.findMany.mockResolvedValueOnce([
      { id: 1, kind: 'holiday', label: 'Summer Break', schoolName: null, startDate: new Date(), endDate: new Date() },
    ]);
    let res = await request(makeApp()).get(`/api/travel-school-terms/check?date=${futureDate()}`);
    expect(res.body.status).toBe('clear');

    // `term` blocks just like `exam-blackout` — trips must avoid term-time.
    prisma.travelSchoolTerm.findMany.mockResolvedValueOnce([
      { id: 2, kind: 'term', label: 'Autumn Term', schoolName: null, startDate: new Date(), endDate: new Date() },
    ]);
    res = await request(makeApp()).get(`/api/travel-school-terms/check?date=${futureDate()}`);
    expect(res.body.status).toBe('blocked');
    expect(res.body.ok).toBe(false);
    expect(res.body.blocking[0]).toMatchObject({ kind: 'term', label: 'Autumn Term' });
  });

  test('a past date → 400 PAST_DATE, no query issued', async () => {
    const res = await request(makeApp()).get('/api/travel-school-terms/check?date=2020-01-01');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PAST_DATE');
    expect(prisma.travelSchoolTerm.findMany).not.toHaveBeenCalled();
  });

  test("today itself is allowed — it's not a past date", async () => {
    prisma.travelSchoolTerm.findMany.mockResolvedValueOnce([]);
    const today = new Date().toISOString().slice(0, 10);

    const res = await request(makeApp()).get(`/api/travel-school-terms/check?date=${today}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unknown');
  });
});

describe('POST /api/travel-school-terms', () => {
  test('400 MISSING_FIELDS without label/dates', async () => {
    const res = await request(makeApp()).post('/api/travel-school-terms').send({ label: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  test('400 INVALID_KIND for a bad kind', async () => {
    const res = await request(makeApp()).post('/api/travel-school-terms').send({
      label: 'x', kind: 'nonsense', startDate: '2026-05-01', endDate: '2026-05-10',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_KIND');
  });

  test('400 INVALID_DATE when endDate < startDate', async () => {
    const res = await request(makeApp()).post('/api/travel-school-terms').send({
      label: 'x', kind: 'holiday', startDate: '2026-05-10', endDate: '2026-05-01',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DATE');
  });

  test('201 creates a tenant-scoped tmc row', async () => {
    const res = await request(makeApp({ tenantId: 9 })).post('/api/travel-school-terms').send({
      schoolName: 'DPS Bangalore', board: 'CBSE', kind: 'holiday', label: 'Summer Break 2026',
      startDate: '2026-04-20', endDate: '2026-06-10',
    });
    expect(res.status).toBe(201);
    const data = prisma.travelSchoolTerm.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenantId: 9, subBrand: 'tmc', kind: 'holiday', source: 'manual', schoolName: 'DPS Bangalore' });
  });
});

describe('PUT/DELETE /api/travel-school-terms/:id', () => {
  test('404 when the row is missing', async () => {
    prisma.travelSchoolTerm.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).put('/api/travel-school-terms/5').send({ label: 'new' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('DELETE soft-deletes (isActive=false)', async () => {
    prisma.travelSchoolTerm.findFirst.mockResolvedValue({ id: 5, tenantId: 1 });
    const res = await request(makeApp()).delete('/api/travel-school-terms/5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.travelSchoolTerm.update.mock.calls[0][0].data).toEqual({ isActive: false });
  });
});
