// @ts-check
/**
 * Unit tests for #820 (tick #191) — additive list filters on the patient
 * listing surface (GET /api/wellness/patients, /patients.csv, /patients.xlsx).
 *
 * What this file pins
 * ───────────────────
 *   1. ?source=<string>     → mutates where.source verbatim
 *   2. ?source= (empty)     → no-op (where.source stays undefined)
 *   3. ?gender=F            → where.gender = 'F'
 *   4. ?gender=BAD          → silently ignored (no 400, where.gender absent)
 *   5. ?createdFrom=<ISO>   → where.createdAt.gte populated
 *   6. ?createdTo=<ISO>     → where.createdAt.lte populated
 *   7. ?createdFrom&createdTo → both sides of the range populated
 *   8. ?createdFrom=garbage → silently ignored (no 400, no gte/lte clause)
 *   9. combined source + gender + createdFrom ANDs onto a single where clause
 *  10. same source filter on /patients.csv → CSV body reflects the filter +
 *      prisma.findMany received the same `where.source` clause.
 *
 * Why mocked prisma (not the live MySQL container): keeps the unit-test gate
 * fast + isolated. The mutation surface IS the contract — we assert that
 * `prisma.patient.findMany` is called with the correct `where` payload for
 * each filter combination. The e2e-full / api_tests suite exercises the
 * round-trip against real MySQL via the wellness-*-api.spec.js partner.
 *
 * Test pattern mirrors backend/test/routes/wellness-patients-xlsx.test.js
 * (tick #187) — patch the prisma singleton BEFORE requiring the router so
 * the require'd router binds to the spy'd functions, mount under a tiny
 * Express app, and inject `req.user` via a synthetic middleware.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by routes/wellness.js at require-time. ──
prisma.patient = prisma.patient || {};
prisma.patient.findMany = vi.fn();
prisma.patient.count = vi.fn();
prisma.patient.findFirst = prisma.patient.findFirst || vi.fn();

// auditLog.create is what writeAudit ultimately calls.
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

// Other delegates touched at module-eval time inside routes/wellness.js
// (defensive permissive stubs):
prisma.loyaltyConfig = prisma.loyaltyConfig || { findUnique: vi.fn(), upsert: vi.fn() };
prisma.loyaltyTransaction = prisma.loyaltyTransaction || {
  findFirst: vi.fn(), aggregate: vi.fn(), findMany: vi.fn(), create: vi.fn(),
};
prisma.referral = prisma.referral || { findMany: vi.fn(), count: vi.fn() };

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = null,
  vertical = 'wellness',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole, vertical };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

function makePatient(id, overrides = {}) {
  return {
    id,
    tenantId: 1,
    name: `Patient ${id}`,
    phone: `9876543${String(id).padStart(3, '0')}`,
    email: `patient${id}@example.com`,
    dob: new Date('1990-01-15T00:00:00Z'),
    gender: id % 2 === 0 ? 'F' : 'M',
    source: 'walk-in',
    locationId: 1,
    deletedAt: null,
    createdAt: new Date('2026-05-01T10:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.patient.findMany.mockReset();
  prisma.patient.count.mockReset();
  prisma.patient.findMany.mockResolvedValue([]);
  prisma.patient.count.mockResolvedValue(0);
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
});

describe('GET /api/wellness/patients filters — #820 (1) ?source=<string>', () => {
  test('?source=walk-in is passed to prisma where clause', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1)]);
    prisma.patient.count.mockResolvedValue(1);
    const res = await request(makeApp()).get('/api/wellness/patients?source=walk-in');
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.source).toBe('walk-in');
  });
});

describe('GET /api/wellness/patients filters — #820 (2) ?source= (empty) is no-op', () => {
  test('?source= does NOT add a where.source clause', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1)]);
    prisma.patient.count.mockResolvedValue(1);
    const res = await request(makeApp()).get('/api/wellness/patients?source=');
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.source).toBeUndefined();
  });
});

describe('GET /api/wellness/patients filters — #820 (3) ?gender=F', () => {
  test('?gender=F mutates where.gender to "F"', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(2)]);
    prisma.patient.count.mockResolvedValue(1);
    const res = await request(makeApp()).get('/api/wellness/patients?gender=F');
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.gender).toBe('F');
  });

  test('?gender=f (lowercase) is normalised to "F"', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(2)]);
    prisma.patient.count.mockResolvedValue(1);
    const res = await request(makeApp()).get('/api/wellness/patients?gender=f');
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.gender).toBe('F');
  });
});

describe('GET /api/wellness/patients filters — #820 (4) ?gender=BAD is silently ignored', () => {
  test('?gender=BAD returns 200 (not 400) and does NOT add where.gender', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1), makePatient(2)]);
    prisma.patient.count.mockResolvedValue(2);
    const res = await request(makeApp()).get('/api/wellness/patients?gender=BAD');
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.gender).toBeUndefined();
  });

  test('?gender=Z is silently ignored', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1)]);
    prisma.patient.count.mockResolvedValue(1);
    const res = await request(makeApp()).get('/api/wellness/patients?gender=Z');
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.gender).toBeUndefined();
  });
});

describe('GET /api/wellness/patients filters — #820 (5) ?createdFrom=<ISO>', () => {
  test('?createdFrom=2026-01-01 populates where.createdAt.gte', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1)]);
    prisma.patient.count.mockResolvedValue(1);
    const res = await request(makeApp()).get('/api/wellness/patients?createdFrom=2026-01-01');
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.createdAt).toBeDefined();
    expect(findManyArgs.where.createdAt.gte).toBeInstanceOf(Date);
    expect(findManyArgs.where.createdAt.gte.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(findManyArgs.where.createdAt.lte).toBeUndefined();
  });
});

describe('GET /api/wellness/patients filters — #820 (6) ?createdTo=<ISO>', () => {
  test('?createdTo=2026-12-31 populates where.createdAt.lte', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1)]);
    prisma.patient.count.mockResolvedValue(1);
    const res = await request(makeApp()).get('/api/wellness/patients?createdTo=2026-12-31');
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.createdAt).toBeDefined();
    expect(findManyArgs.where.createdAt.lte).toBeInstanceOf(Date);
    expect(findManyArgs.where.createdAt.lte.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(findManyArgs.where.createdAt.gte).toBeUndefined();
  });
});

describe('GET /api/wellness/patients filters — #820 (7) range: createdFrom + createdTo', () => {
  test('?createdFrom=2026-06-01&createdTo=2026-06-30 populates both sides of the range', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1)]);
    prisma.patient.count.mockResolvedValue(1);
    const res = await request(makeApp()).get(
      '/api/wellness/patients?createdFrom=2026-06-01&createdTo=2026-06-30',
    );
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.createdAt).toBeDefined();
    expect(findManyArgs.where.createdAt.gte).toBeInstanceOf(Date);
    expect(findManyArgs.where.createdAt.lte).toBeInstanceOf(Date);
    expect(findManyArgs.where.createdAt.gte.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(findManyArgs.where.createdAt.lte.toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });
});

describe('GET /api/wellness/patients filters — #820 (8) ?createdFrom=garbage is silently ignored', () => {
  test('?createdFrom=garbage returns 200 + no createdAt clause', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1)]);
    prisma.patient.count.mockResolvedValue(1);
    const res = await request(makeApp()).get('/api/wellness/patients?createdFrom=garbage');
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.createdAt).toBeUndefined();
  });

  test('?createdTo=not-a-date is silently ignored', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1)]);
    prisma.patient.count.mockResolvedValue(1);
    const res = await request(makeApp()).get('/api/wellness/patients?createdTo=not-a-date');
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.createdAt).toBeUndefined();
  });
});

describe('GET /api/wellness/patients filters — #820 (9) combined filters AND together', () => {
  test('?source=X&gender=F&createdFrom=2026-01-01 → all three clauses applied to same where', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(2)]);
    prisma.patient.count.mockResolvedValue(1);
    const res = await request(makeApp()).get(
      '/api/wellness/patients?source=referral&gender=F&createdFrom=2026-01-01',
    );
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.source).toBe('referral');
    expect(findManyArgs.where.gender).toBe('F');
    expect(findManyArgs.where.createdAt.gte).toBeInstanceOf(Date);
    // tenant scope still applied
    expect(findManyArgs.where.tenantId).toBe(1);
  });
});

describe('GET /api/wellness/patients.csv filters — #820 (10) export mirrors listing filters', () => {
  test('?source=walk-in on /patients.csv → prisma.findMany receives the same source filter', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatient(1, { source: 'walk-in' }),
      makePatient(2, { source: 'walk-in' }),
    ]);
    const res = await request(makeApp()).get('/api/wellness/patients.csv?source=walk-in');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.source).toBe('walk-in');
  });

  test('?gender=F&createdFrom=2026-01-01 on /patients.csv → filters applied identically', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(2)]);
    const res = await request(makeApp()).get(
      '/api/wellness/patients.csv?gender=F&createdFrom=2026-01-01',
    );
    expect(res.status).toBe(200);
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.gender).toBe('F');
    expect(findManyArgs.where.createdAt.gte).toBeInstanceOf(Date);
  });
});
