// @ts-check
/**
 * Travel CRM — C6 slice route tests for the 3 new endpoints in
 * backend/routes/travel_curriculum.js:
 *
 *   POST /api/travel-curriculum/import.csv  (ADMIN+MANAGER, tenant-scoped)
 *   GET  /api/travel-curriculum/export.csv  (ADMIN+MANAGER, tenant-scoped)
 *   GET  /api/travel-curriculum/coverage    (ADMIN+MANAGER, tenant-scoped)
 *
 * Pattern reference
 * -----------------
 * Mirrors backend/test/routes/travel-curriculum-stats.test.js (Prisma
 * singleton patched BEFORE the router is required; supertest + HS256 JWTs
 * signed against the dev-fallback secret). All 3 endpoints behave the same
 * way for auth: verifyToken first, then verifyRole(['ADMIN','MANAGER']) —
 * USER role returns 403; missing token returns 401.
 *
 * What's pinned
 * -------------
 *   - POST /import.csv with the valid-sample.csv fixture → 200 with
 *     { rowsProcessed, rowsCreated, rowsUpdated, errors:[] }.
 *   - POST /import.csv with missing-column.csv → 400 CSV_HEADER_INVALID
 *     + zero create/update calls (atomic rejection).
 *   - POST /import.csv with invalid-board.csv → 400 CSV_ROWS_INVALID +
 *     errors[] populated + zero create/update calls (atomic per AC-2).
 *   - POST /import.csv idempotency: re-uploading the same file produces
 *     0 created / N updated.
 *   - POST /import.csv role gate: USER → 403 RBAC_DENIED.
 *   - GET /export.csv happy path: 200 + text/csv + Content-Disposition
 *     + BOM-prefixed body + header row + N data rows.
 *   - GET /export.csv ?curriculum filter narrows the where clause.
 *   - GET /export.csv empty result → header-only CSV.
 *   - GET /export.csv tenant scoping: the WHERE clause carries
 *     tenantId from req.user, not a body-supplied value.
 *   - GET /coverage happy path: matrix shape valid; outcomesMissing
 *     reflects the 7 canonical TMC skills.
 *   - GET /coverage zero-mappings tenant: synthesised rows for the 4
 *     allowed curricula, each with all 7 skills missing.
 *   - GET /coverage role gate: USER → 403 RBAC_DENIED.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Patch prisma BEFORE requiring the router.
prisma.travelCurriculumMapping = {
  ...(prisma.travelCurriculumMapping || {}),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

const travelCurriculumRouter = requireCJS('../../routes/travel_curriculum');

function makeApp() {
  const app = express();
  // Note: NO global text-body parser here — the route file scopes its own
  // text/csv parser to /import.csv (so the test exercises the real parser
  // mount, not a sibling).
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

function bufferParser(r, cb) {
  const chunks = [];
  r.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
}

const FIXTURES_DIR = path.join(
  process.cwd(),
  'test',
  'fixtures',
  'curriculum',
);
const validSampleCsv = fs.readFileSync(
  path.join(FIXTURES_DIR, 'valid-sample.csv'),
  'utf8',
);
const missingColumnCsv = fs.readFileSync(
  path.join(FIXTURES_DIR, 'missing-column.csv'),
  'utf8',
);
const invalidBoardCsv = fs.readFileSync(
  path.join(FIXTURES_DIR, 'invalid-board.csv'),
  'utf8',
);

beforeEach(() => {
  prisma.travelCurriculumMapping.findFirst.mockReset();
  prisma.travelCurriculumMapping.findMany.mockReset();
  prisma.travelCurriculumMapping.count.mockReset();
  prisma.travelCurriculumMapping.create.mockReset();
  prisma.travelCurriculumMapping.update.mockReset();
});

// ─── POST /api/travel-curriculum/import.csv ───────────────────────

describe('POST /api/travel-curriculum/import.csv', () => {
  test('case 1: valid CSV → 200 with rowsCreated count + zero errors', async () => {
    // First lookup returns null (new row), so every row gets created.
    prisma.travelCurriculumMapping.findFirst.mockResolvedValue(null);
    prisma.travelCurriculumMapping.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 100, ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel-curriculum/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(validSampleCsv);

    expect(res.status).toBe(200);
    expect(res.body.rowsProcessed).toBe(8); // valid-sample.csv has 8 rows
    expect(res.body.rowsCreated).toBe(8);
    expect(res.body.rowsUpdated).toBe(0);
    expect(res.body.errors).toEqual([]);
    expect(prisma.travelCurriculumMapping.create).toHaveBeenCalledTimes(8);
    expect(prisma.travelCurriculumMapping.update).not.toHaveBeenCalled();

    // Tenant-scoping: every lookup carries tenantId from the token.
    for (const call of prisma.travelCurriculumMapping.findFirst.mock.calls) {
      expect(call[0].where.tenantId).toBe(1);
    }
    // Tenant-scoping: every create stamps tenantId.
    for (const call of prisma.travelCurriculumMapping.create.mock.calls) {
      expect(call[0].data.tenantId).toBe(1);
    }
  });

  test('case 2: missing-column CSV → 400 CSV_HEADER_INVALID + no DB writes', async () => {
    const res = await request(makeApp())
      .post('/api/travel-curriculum/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(missingColumnCsv);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CSV_HEADER_INVALID');
    expect(res.body.error).toMatch(/learningOutcome/);
    expect(prisma.travelCurriculumMapping.create).not.toHaveBeenCalled();
    expect(prisma.travelCurriculumMapping.update).not.toHaveBeenCalled();
  });

  test('case 3: invalid-board CSV → 400 CSV_ROWS_INVALID + atomic rejection (no DB writes)', async () => {
    const res = await request(makeApp())
      .post('/api/travel-curriculum/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(invalidBoardCsv);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CSV_ROWS_INVALID');
    expect(res.body.errors.length).toBeGreaterThanOrEqual(1);
    expect(res.body.errors[0].row).toBe(3); // row 3 in invalid-board.csv has FOO
    expect(res.body.errors[0].message).toMatch(/curriculum "FOO" not in allowed set/);
    // Atomic — even valid rows aren't persisted when any row fails.
    expect(prisma.travelCurriculumMapping.create).not.toHaveBeenCalled();
    expect(prisma.travelCurriculumMapping.update).not.toHaveBeenCalled();
  });

  test('case 4: idempotency — re-uploading same file yields 0 created / N updated', async () => {
    // Every findFirst returns an existing row → every iteration takes the
    // update branch.
    prisma.travelCurriculumMapping.findFirst.mockImplementation(({ where }) =>
      Promise.resolve({ id: 42, ...where }),
    );
    prisma.travelCurriculumMapping.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 42, ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel-curriculum/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(validSampleCsv);

    expect(res.status).toBe(200);
    expect(res.body.rowsProcessed).toBe(8);
    expect(res.body.rowsCreated).toBe(0);
    expect(res.body.rowsUpdated).toBe(8);
    expect(prisma.travelCurriculumMapping.create).not.toHaveBeenCalled();
    expect(prisma.travelCurriculumMapping.update).toHaveBeenCalledTimes(8);
  });

  test('case 5: role gate — USER → 403 RBAC_DENIED, no DB writes', async () => {
    const res = await request(makeApp())
      .post('/api/travel-curriculum/import.csv')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .set('Content-Type', 'text/csv')
      .send(validSampleCsv);

    expect(res.status).toBe(403);
    expect(prisma.travelCurriculumMapping.create).not.toHaveBeenCalled();
    expect(prisma.travelCurriculumMapping.update).not.toHaveBeenCalled();
  });

  test('case 5b: missing token → 401', async () => {
    const res = await request(makeApp())
      .post('/api/travel-curriculum/import.csv')
      .set('Content-Type', 'text/csv')
      .send(validSampleCsv);
    expect(res.status).toBe(401);
  });

  test('case 5c: empty body → 400 NO_CSV', async () => {
    const res = await request(makeApp())
      .post('/api/travel-curriculum/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send('');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_CSV');
  });

  test('case 5d: MANAGER role accepted (not just ADMIN)', async () => {
    prisma.travelCurriculumMapping.findFirst.mockResolvedValue(null);
    prisma.travelCurriculumMapping.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 100, ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel-curriculum/import.csv')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .set('Content-Type', 'text/csv')
      .send(validSampleCsv);

    expect(res.status).toBe(200);
    expect(res.body.rowsCreated).toBe(8);
  });
});

// ─── GET /api/travel-curriculum/export.csv ────────────────────────

describe('GET /api/travel-curriculum/export.csv', () => {
  test('case 6: happy path → 200 + text/csv + Content-Disposition + BOM + header', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      {
        id: 1,
        curriculum: 'CBSE',
        grade: 'Class 9',
        subject: 'Geography',
        learningOutcome: 'Plate tectonics',
        destinationLabel: 'Mussoorie',
        destinationId: null,
        fitScore: 85,
        fitRationale: 'Field observation',
        isActive: true,
      },
      {
        id: 2,
        curriculum: 'CBSE',
        grade: 'Class 9',
        subject: 'Biology',
        learningOutcome: 'Diversity in Living Organisms',
        destinationLabel: 'Andaman',
        destinationId: 7,
        fitScore: 92,
        fitRationale: 'Coral reef study',
        isActive: true,
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/export.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="curriculum-export-\d{4}-\d{2}-\d{2}\.csv"/,
    );

    // BOM check (UTF-8 BOM = EF BB BF).
    expect(res.body[0]).toBe(0xef);
    expect(res.body[1]).toBe(0xbb);
    expect(res.body[2]).toBe(0xef >> 24 | 0xbf); // 0xbf
    const text = res.body.toString('utf8').replace(/^﻿/, '');
    expect(text).toContain('curriculum,grade,subject,learningOutcome');
    expect(text).toContain('CBSE,Class 9,Geography,Plate tectonics');
    expect(text).toContain('CBSE,Class 9,Biology,Diversity in Living Organisms');
  });

  test('case 7: ?curriculum=CBSE filter narrows where clause', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel-curriculum/export.csv?curriculum=CBSE&grade=Class+9&subject=Geography')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(prisma.travelCurriculumMapping.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.travelCurriculumMapping.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.curriculum).toBe('CBSE');
    expect(call.where.grade).toBe('Class 9');
    expect(call.where.subject).toBe('Geography');
  });

  test('case 8: empty result → header-only CSV (parseable)', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/export.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    const text = res.body.toString('utf8').replace(/^﻿/, '');
    expect(text).toBe(
      'curriculum,grade,subject,learningOutcome,destinationLabel,destinationId,fitScore,fitRationale,isActive',
    );
  });

  test('case 9: tenant-scoping — WHERE carries tenantId from req.user not body', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel-curriculum/export.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN', { tenantId: 99 })}`);

    const call = prisma.travelCurriculumMapping.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(99);
  });

  test('case 9b: role gate — USER → 403', async () => {
    const res = await request(makeApp())
      .get('/api/travel-curriculum/export.csv')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
  });

  test('case 9c: missing token → 401', async () => {
    const res = await request(makeApp())
      .get('/api/travel-curriculum/export.csv');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/travel-curriculum/coverage ──────────────────────────

describe('GET /api/travel-curriculum/coverage', () => {
  test('case 10: happy path with mappings → coverage matrix valid', async () => {
    // 3 mappings: CBSE/Class 9 has 2 (one mentions Empathy, one mentions
    // Mindfulness); ICSE/Class 9 has 1 (mentions Self-awareness).
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      {
        curriculum: 'CBSE',
        grade: 'Class 9',
        learningOutcome: 'Empathy through community service projects',
      },
      {
        curriculum: 'CBSE',
        grade: 'Class 9',
        learningOutcome: 'Mindfulness via yoga + meditation sessions',
      },
      {
        curriculum: 'ICSE',
        grade: 'Class 9',
        learningOutcome: 'Building Self-awareness through reflection journaling',
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/coverage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('coverage');
    expect(res.body).toHaveProperty('totals');
    expect(Array.isArray(res.body.coverage)).toBe(true);

    const cbse = res.body.coverage.find(
      (r) => r.curriculum === 'CBSE' && r.gradeBand === 'Class 9',
    );
    expect(cbse).toBeTruthy();
    expect(cbse.mappingCount).toBe(2);
    expect(cbse.outcomesCovered).toEqual(
      expect.arrayContaining(['Empathy', 'Mindfulness']),
    );
    expect(cbse.outcomesMissing.length).toBe(5);
    expect(cbse.outcomesMissing).not.toContain('Empathy');
    expect(cbse.outcomesMissing).not.toContain('Mindfulness');

    const icse = res.body.coverage.find(
      (r) => r.curriculum === 'ICSE' && r.gradeBand === 'Class 9',
    );
    expect(icse.outcomesCovered).toEqual(['Self-awareness']);
    expect(icse.outcomesMissing.length).toBe(6);

    expect(res.body.totals.totalMappings).toBe(3);
    expect(res.body.totals.boardsCovered).toBe(2);
    expect(res.body.totals.fullCoverageBoards).toEqual([]);
    expect(res.body.totals.gapCount).toBeGreaterThan(0);

    // tenant-scoping — only ACTIVE rows queried.
    const call = prisma.travelCurriculumMapping.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(1);
    expect(call.where.isActive).toBe(true);
  });

  test('case 11: zero-mappings tenant → all 7 canonical skills missing per allowed curriculum', async () => {
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/coverage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // 4 allowed curricula × all-7 missing.
    expect(res.body.coverage).toHaveLength(4);
    for (const row of res.body.coverage) {
      expect(row.mappingCount).toBe(0);
      expect(row.outcomesCovered).toEqual([]);
      expect(row.outcomesMissing).toHaveLength(7);
      expect(row.outcomesMissing).toEqual(
        expect.arrayContaining([
          'Empathy',
          'Self-awareness',
          'Collaboration and teamwork',
          'Mindfulness',
          'Lifelong learning and curiosity',
          'Cultural respect and inclusion',
          'Emotional resilience',
        ]),
      );
    }
    expect(res.body.totals.totalMappings).toBe(0);
    expect(res.body.totals.boardsCovered).toBe(0);
    expect(res.body.totals.fullCoverageBoards).toEqual([]);
    expect(res.body.totals.gapCount).toBe(4 * 7);
  });

  test('case 12: role gate — USER → 403', async () => {
    const res = await request(makeApp())
      .get('/api/travel-curriculum/coverage')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
  });

  test('case 12b: missing token → 401', async () => {
    const res = await request(makeApp())
      .get('/api/travel-curriculum/coverage');
    expect(res.status).toBe(401);
  });

  test('case 12c: full-coverage curriculum lands in totals.fullCoverageBoards', async () => {
    // One CBSE row that mentions every canonical skill — the row's
    // learningOutcome is contrived to hit all 7 substring matches.
    prisma.travelCurriculumMapping.findMany.mockResolvedValue([
      {
        curriculum: 'CBSE',
        grade: 'Class 9',
        learningOutcome:
          'Empathy + Self-awareness + Collaboration and teamwork + Mindfulness + Lifelong learning and curiosity + Cultural respect and inclusion + Emotional resilience',
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel-curriculum/coverage')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.coverage[0].outcomesMissing).toEqual([]);
    expect(res.body.totals.fullCoverageBoards).toEqual(['CBSE']);
  });
});
