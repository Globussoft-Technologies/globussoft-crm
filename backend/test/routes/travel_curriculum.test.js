// @ts-check
/**
 * TMC (Travel) Phase 1 / PC-1 + PC-2/3/4/5 — TravelCurriculumMapping CRUD
 * scaffold tests (tick #180).
 *
 * Pins the contract for backend/routes/travel_curriculum.js. The schema
 * shipped tick #178 (commit 3441fda4) + tick #179 key-byte triage
 * (b2d188ff): @@unique([tenantId, curriculum, grade, subject,
 * learningOutcome]) constraint, VarChar(32/32/64/300) for the composite
 * key components, optional destinationId/destinationLabel/fitScore (1-100)/
 * fitRationale/isActive.
 *
 * Test pattern mirrors backend/test/routes/embassy_rules.test.js — patch
 * the prisma singleton BEFORE requiring the router so the require()'d
 * router binds to the spy'd functions. JWT minted with the same dev
 * fallback secret the middleware uses; verifyToken runs in the chain
 * (no bypass) so auth-gates are exercised end-to-end.
 *
 * Why mocked prisma (not the live MySQL container): keeps the unit-test
 * gate fast + isolated. The e2e-full / api_tests gates exercise the
 * round-trip against real MySQL via the e2e/tests/*-api.spec.js layer
 * (added in a follow-up tick if needed).
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelCurriculumMapping = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelCurriculumRouter = requireCJS('../../routes/travel_curriculum');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel-curriculum', travelCurriculumRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.travelCurriculumMapping.findMany.mockReset();
  prisma.travelCurriculumMapping.findFirst.mockReset();
  prisma.travelCurriculumMapping.count.mockReset();
  prisma.travelCurriculumMapping.create.mockReset();
  prisma.travelCurriculumMapping.update.mockReset();
});

describe('GET /api/travel-curriculum', () => {
  test('returns seeded rows under tenant scoping', async () => {
    // Simulates the 6 seeded starter rows from seed-travel-curriculum.js.
    const seeded = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      tenantId: 1,
      curriculum: i < 3 ? 'CBSE' : 'ICSE',
      grade: 'Class 10',
      subject: 'Geography',
      learningOutcome: `Outcome ${i + 1}`,
      destinationId: null,
      destinationLabel: 'Mussoorie + Dehradun',
      fitScore: 70 + i,
      fitRationale: null,
      isActive: true,
      createdById: 7,
    }));
    prisma.travelCurriculumMapping.findMany.mockResolvedValue(seeded);
    prisma.travelCurriculumMapping.count.mockResolvedValue(6);

    const res = await request(makeApp())
      .get('/api/travel-curriculum')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.mappings).toHaveLength(6);
    expect(res.body.total).toBe(6);
    expect(prisma.travelCurriculumMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1 }),
      }),
    );
  });

  test('list filtered by ?curriculum returns scoped rows', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      {
        id: 1, tenantId: 1, curriculum: 'CBSE', grade: 'Class 10',
        subject: 'Geography', learningOutcome: 'Plate tectonics',
        destinationId: null, destinationLabel: 'Mussoorie',
        fitScore: 80, fitRationale: null, isActive: true, createdById: 7,
      },
    ]);
    prisma.travelCurriculumMapping.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel-curriculum?curriculum=CBSE')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.mappings).toHaveLength(1);
    expect(prisma.travelCurriculumMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, curriculum: 'CBSE' }),
      }),
    );
  });

  test('list filtered by ?isActive=false excludes active rows', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      {
        id: 9, tenantId: 1, curriculum: 'CBSE', grade: 'Class 10',
        subject: 'History', learningOutcome: 'Mughal architecture',
        destinationId: null, destinationLabel: 'Delhi + Agra',
        fitScore: 60, fitRationale: null, isActive: false, createdById: 7,
      },
    ]);
    prisma.travelCurriculumMapping.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel-curriculum?isActive=false')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.mappings[0].isActive).toBe(false);
    expect(prisma.travelCurriculumMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, isActive: false }),
      }),
    );
  });
});

describe('POST /api/travel-curriculum', () => {
  test('happy path returns 201 with stamped tenantId + createdById', async () => {
    prisma.travelCurriculumMapping.create.mockImplementation(async ({ data }) => ({
      id: 42, ...data, createdAt: new Date(), updatedAt: new Date(),
    }));
    const res = await request(makeApp())
      .post('/api/travel-curriculum')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { userId: 7, tenantId: 1 })}`)
      .send({
        curriculum: 'IB',
        grade: 'IB Year 1',
        subject: 'Biology',
        learningOutcome: 'Ecosystem dynamics + biodiversity',
        destinationLabel: 'Western Ghats',
        fitScore: 85,
        fitRationale: 'High biodiversity index + accessible logistics',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 42,
      curriculum: 'IB',
      grade: 'IB Year 1',
      subject: 'Biology',
      fitScore: 85,
      isActive: true,
    });
    expect(res.body.createdAt).toBeDefined();
    // tenantId + createdById stamped from req.user — not body.
    expect(prisma.travelCurriculumMapping.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          createdById: 7,
          curriculum: 'IB',
        }),
      }),
    );
  });

  test('rejects fitScore=150 with 400 INVALID_FIT_SCORE', async () => {
    const res = await request(makeApp())
      .post('/api/travel-curriculum')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        curriculum: 'CBSE',
        grade: 'Class 9',
        subject: 'Physics',
        fitScore: 150, // over-cap — must be 1..100
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_FIT_SCORE' });
    expect(prisma.travelCurriculumMapping.create).not.toHaveBeenCalled();
  });

  test('rejects fitScore=-5 with 400 INVALID_FIT_SCORE', async () => {
    const res = await request(makeApp())
      .post('/api/travel-curriculum')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        curriculum: 'CBSE',
        grade: 'Class 9',
        subject: 'Physics',
        fitScore: -5, // negative — must be 1..100
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_FIT_SCORE' });
    expect(prisma.travelCurriculumMapping.create).not.toHaveBeenCalled();
  });

  test('rejects missing curriculum field with 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel-curriculum')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        // curriculum absent
        grade: 'Class 10',
        subject: 'Geography',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelCurriculumMapping.create).not.toHaveBeenCalled();
  });

  test('rejects duplicate (curriculum,grade,subject,learningOutcome) with 409 CURRICULUM_DUPLICATE', async () => {
    const p2002 = new Error(
      'Unique constraint failed on the fields: (`tenantId`,`curriculum`,`grade`,`subject`,`learningOutcome`)',
    );
    // @ts-expect-error — synthesising a Prisma error shape
    p2002.code = 'P2002';
    prisma.travelCurriculumMapping.create.mockRejectedValue(p2002);
    const res = await request(makeApp())
      .post('/api/travel-curriculum')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        curriculum: 'CBSE',
        grade: 'Class 10',
        subject: 'Geography',
        learningOutcome: 'Plate tectonics + landform formation',
      });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'CURRICULUM_DUPLICATE' });
  });
});

describe('PUT /api/travel-curriculum/:id', () => {
  test('updates allowed fields; tenantId/createdById reassignment is ignored', async () => {
    prisma.travelCurriculumMapping.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, curriculum: 'CBSE', grade: 'Class 10',
      subject: 'Geography', learningOutcome: 'Old outcome',
      destinationId: null, destinationLabel: null,
      fitScore: 50, fitRationale: null, isActive: true, createdById: 7,
    });
    prisma.travelCurriculumMapping.update.mockImplementation(async ({ data }) => ({
      id: 5, tenantId: 1, curriculum: 'CBSE', grade: 'Class 10',
      subject: 'Geography', learningOutcome: 'Updated outcome',
      destinationId: null, destinationLabel: null,
      fitScore: 90, fitRationale: null, isActive: true, createdById: 7, ...data,
    }));
    const res = await request(makeApp())
      .put('/api/travel-curriculum/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 1 })}`)
      .send({
        learningOutcome: 'Updated outcome',
        fitScore: 90,
        // Attempt to slip a tenantId / createdById in — handler never reads them.
        tenantId: 999,
        createdById: 999,
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, tenantId: 1, createdById: 7 });

    const updateCall = prisma.travelCurriculumMapping.update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('tenantId');
    expect(updateCall.data).not.toHaveProperty('createdById');
    expect(updateCall.data).toMatchObject({
      learningOutcome: 'Updated outcome',
      fitScore: 90,
    });
  });
});

describe('DELETE /api/travel-curriculum/:id (soft-delete)', () => {
  test('flips isActive=false', async () => {
    prisma.travelCurriculumMapping.findFirst.mockResolvedValue({
      id: 9, tenantId: 1, curriculum: 'CBSE', grade: 'Class 10',
      subject: 'History', learningOutcome: 'Mughal architecture',
      destinationId: null, destinationLabel: 'Delhi + Agra',
      fitScore: 60, fitRationale: null, isActive: true, createdById: 7,
    });
    prisma.travelCurriculumMapping.update.mockResolvedValue({
      id: 9, tenantId: 1, curriculum: 'CBSE', grade: 'Class 10',
      subject: 'History', learningOutcome: 'Mughal architecture',
      destinationId: null, destinationLabel: 'Delhi + Agra',
      fitScore: 60, fitRationale: null, isActive: false, createdById: 7,
    });

    const delRes = await request(makeApp())
      .delete('/api/travel-curriculum/9')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body).toMatchObject({ id: 9, isActive: false });

    // Soft-delete shape — prisma.update called with isActive: false.
    expect(prisma.travelCurriculumMapping.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { isActive: false },
    });
  });
});

describe('Cross-tenant isolation', () => {
  test('mapping under tenant 1 is invisible to tenant 2', async () => {
    // Caller is tenant 2 → findFirst returns null because the where
    // clause filters on tenantId=2 even though id=42 exists for tenant 1.
    prisma.travelCurriculumMapping.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel-curriculum/42')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 2 })}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'CURRICULUM_NOT_FOUND' });
    expect(prisma.travelCurriculumMapping.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 42, tenantId: 2 }),
      }),
    );
  });
});

describe('RBAC — USER role on write paths returns 403', () => {
  test('POST as USER → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .post('/api/travel-curriculum')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({
        curriculum: 'CBSE',
        grade: 'Class 10',
        subject: 'Geography',
      });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.travelCurriculumMapping.create).not.toHaveBeenCalled();
  });

  test('PUT as USER → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .put('/api/travel-curriculum/1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ fitScore: 80 });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.travelCurriculumMapping.update).not.toHaveBeenCalled();
  });

  test('DELETE as USER → 403 RBAC_DENIED', async () => {
    const res = await request(makeApp())
      .delete('/api/travel-curriculum/1')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RBAC_DENIED' });
    expect(prisma.travelCurriculumMapping.update).not.toHaveBeenCalled();
  });
});
