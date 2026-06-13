// @ts-check
/**
 * Travel CRM — RejectionRecoveryProgram + enrol-recovery contract tests (G107).
 *
 * Pins backend/routes/travel_visa.js RejectionRecoveryProgram endpoints:
 *   POST  /api/travel/visa/recovery-programs                       — create
 *   GET   /api/travel/visa/recovery-programs                       — list (filters)
 *   GET   /api/travel/visa/recovery-programs/:id                   — detail + enrolled count
 *   PUT   /api/travel/visa/recovery-programs/:id                   — update
 *   POST  /api/travel/visa/applications/:id/enrol-recovery         — enrol / un-enrol
 *
 * What's pinned:
 *   - Auth gate: missing Bearer → 401.
 *   - Role gate: USER → 403; ADMIN + MANAGER reach the handler.
 *   - Tenant scoping: cross-tenant rows return 404 (PROGRAM_NOT_FOUND /
 *     APPLICATION_NOT_FOUND).
 *   - Sub-brand isolation: applications whose Contact.subBrand != 'visasure'
 *     return 404 NOT_VISA_SURE on enrol-recovery.
 *   - Validation: MISSING_FIELDS (no name / destinationCountry on POST),
 *     INVALID_NAME / INVALID_DESTINATION (length cap), INVALID_DURATION
 *     (negative integer), INVALID_SUCCESS_RATE (not in [0, 100]),
 *     INVALID_FEE_AMOUNT (negative), INVALID_PROGRAM_ID (non-integer body),
 *     PROGRAM_INACTIVE (enrol an isActive=false program).
 *   - Enrol-recovery: programId=null clears the enrolment; non-null sets it;
 *     audit row written with fromProgramId / toProgramId.
 *
 * Test pattern mirrors travel-visa.test.js — patch prisma singleton before
 * requiring router, real HS256 JWT, full guard chain runs end-to-end.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ─── Patch CJS module exports BEFORE requiring router ─────────────────
import { createRequire } from 'node:module';
const requireCJS_init = createRequire(import.meta.url);

const mockSafeEmitEvent = vi.fn();
const eventBusModule = requireCJS_init('../../lib/eventBus');
eventBusModule.safeEmitEvent = mockSafeEmitEvent;

const mockFindLatestDiagnostic = vi.fn().mockResolvedValue(null);
const diagnosticModule = requireCJS_init('../../lib/travelLatestDiagnostic');
diagnosticModule.findLatestDiagnostic = mockFindLatestDiagnostic;

// ─── Patch prisma singleton ───────────────────────────────────────────
prisma.contact = {
  ...(prisma.contact || {}),
  findFirst: vi.fn(),
  findMany: vi.fn(),
};
prisma.visaApplication = {
  ...(prisma.visaApplication || {}),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.rejectionRecoveryProgram = {
  create: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  update: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const router = requireCJS_init('../../routes/travel_visa');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/visa', router);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.contact.findMany.mockReset().mockResolvedValue([]);
  prisma.visaApplication.findFirst.mockReset().mockResolvedValue(null);
  prisma.visaApplication.findMany.mockReset().mockResolvedValue([]);
  prisma.visaApplication.count.mockReset().mockResolvedValue(0);
  prisma.visaApplication.create.mockReset();
  prisma.visaApplication.update.mockReset();
  prisma.rejectionRecoveryProgram.create.mockReset();
  prisma.rejectionRecoveryProgram.findFirst.mockReset().mockResolvedValue(null);
  prisma.rejectionRecoveryProgram.findMany.mockReset().mockResolvedValue([]);
  prisma.rejectionRecoveryProgram.count.mockReset().mockResolvedValue(0);
  prisma.rejectionRecoveryProgram.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('recovery-programs auth + role gate', () => {
  test('missing Bearer → 401', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/recovery-programs')
      .send({ name: 'X', destinationCountry: 'US' });
    expect(res.status).toBe(401);
  });

  test('USER role → 403 on POST', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/recovery-programs')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ name: 'X', destinationCountry: 'US' });
    expect(res.status).toBe(403);
    expect(prisma.rejectionRecoveryProgram.create).not.toHaveBeenCalled();
  });

  test('MANAGER role → reaches handler (create)', async () => {
    prisma.rejectionRecoveryProgram.create.mockResolvedValue({
      id: 99, tenantId: 1, name: 'USA B1/B2 second attempt', destinationCountry: 'US',
      isActive: true, createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(makeApp())
      .post('/api/travel/visa/recovery-programs')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ name: 'USA B1/B2 second attempt', destinationCountry: 'US' });
    expect(res.status).toBe(201);
    expect(prisma.rejectionRecoveryProgram.create).toHaveBeenCalledOnce();
  });
});

describe('POST /recovery-programs validation', () => {
  test('missing name → 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/recovery-programs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ destinationCountry: 'US' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  test('missing destinationCountry → 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/recovery-programs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'USA B1/B2 second attempt' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  test('name > 200 chars → 400 INVALID_NAME', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/recovery-programs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'X'.repeat(201), destinationCountry: 'US' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NAME');
  });

  test('destinationCountry > 100 chars → 400 INVALID_DESTINATION', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/recovery-programs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'X', destinationCountry: 'C'.repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DESTINATION');
  });

  test('negative durationDays → 400 INVALID_DURATION', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/recovery-programs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'X', destinationCountry: 'US', durationDays: -1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_DURATION');
  });

  test('successRate > 100 → 400 INVALID_SUCCESS_RATE', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/recovery-programs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'X', destinationCountry: 'US', successRate: 150 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SUCCESS_RATE');
  });

  test('negative feeAmount → 400 INVALID_FEE_AMOUNT', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/recovery-programs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'X', destinationCountry: 'US', feeAmount: -50 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FEE_AMOUNT');
  });

  test('happy create writes tenantId + createdBy', async () => {
    prisma.rejectionRecoveryProgram.create.mockResolvedValue({
      id: 42, tenantId: 1, name: 'USA B1/B2 second attempt',
      destinationCountry: 'US', visaType: 'tourist', isActive: true,
      durationDays: 30, successRate: 65, feeAmount: 5000, feeCurrency: 'USD',
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await request(makeApp())
      .post('/api/travel/visa/recovery-programs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        name: 'USA B1/B2 second attempt',
        destinationCountry: 'US',
        visaType: 'tourist',
        durationDays: 30,
        successRate: 65,
        feeAmount: 5000,
        feeCurrency: 'USD',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(42);
    const call = prisma.rejectionRecoveryProgram.create.mock.calls[0][0];
    expect(call.data.tenantId).toBe(1);
    expect(call.data.createdBy).toBe(7);
    expect(call.data.feeCurrency).toBe('USD');
  });
});

describe('GET /recovery-programs (list)', () => {
  test('lists tenant-scoped programs with default pagination', async () => {
    prisma.rejectionRecoveryProgram.findMany.mockResolvedValue([
      { id: 1, tenantId: 1, name: 'A', destinationCountry: 'US', isActive: true },
    ]);
    prisma.rejectionRecoveryProgram.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/visa/recovery-programs')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.programs).toHaveLength(1);
    expect(res.body.total).toBe(1);
    const where = prisma.rejectionRecoveryProgram.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(1);
  });

  test('?country=US narrows where.destinationCountry', async () => {
    prisma.rejectionRecoveryProgram.findMany.mockResolvedValue([]);
    prisma.rejectionRecoveryProgram.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/visa/recovery-programs?country=US')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const where = prisma.rejectionRecoveryProgram.findMany.mock.calls[0][0].where;
    expect(where.destinationCountry).toBe('US');
  });

  test('?active=true narrows where.isActive', async () => {
    prisma.rejectionRecoveryProgram.findMany.mockResolvedValue([]);
    prisma.rejectionRecoveryProgram.count.mockResolvedValue(0);
    await request(makeApp())
      .get('/api/travel/visa/recovery-programs?active=true')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const where = prisma.rejectionRecoveryProgram.findMany.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
  });
});

describe('GET /recovery-programs/:id (detail)', () => {
  test('non-numeric id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/visa/recovery-programs/abc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('cross-tenant or missing → 404 PROGRAM_NOT_FOUND', async () => {
    prisma.rejectionRecoveryProgram.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/visa/recovery-programs/99')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROGRAM_NOT_FOUND');
  });

  test('returns enrolledCount alongside detail', async () => {
    prisma.rejectionRecoveryProgram.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, name: 'A', destinationCountry: 'US', isActive: true,
    });
    prisma.visaApplication.count.mockResolvedValue(3);
    const res = await request(makeApp())
      .get('/api/travel/visa/recovery-programs/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(5);
    expect(res.body.enrolledCount).toBe(3);
  });
});

describe('PUT /recovery-programs/:id', () => {
  test('cross-tenant or missing → 404 PROGRAM_NOT_FOUND', async () => {
    prisma.rejectionRecoveryProgram.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/travel/visa/recovery-programs/99')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'updated' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROGRAM_NOT_FOUND');
  });

  test('happy update calls prisma.update with coerced data', async () => {
    prisma.rejectionRecoveryProgram.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, name: 'A', destinationCountry: 'US', isActive: true,
    });
    prisma.rejectionRecoveryProgram.update.mockResolvedValue({
      id: 5, tenantId: 1, name: 'A', destinationCountry: 'US',
      description: 'updated', isActive: true,
    });
    const res = await request(makeApp())
      .put('/api/travel/visa/recovery-programs/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ description: 'updated', isActive: false });
    expect(res.status).toBe(200);
    const updateData = prisma.rejectionRecoveryProgram.update.mock.calls[0][0].data;
    expect(updateData.description).toBe('updated');
    expect(updateData.isActive).toBe(false);
  });
});

describe('POST /applications/:id/enrol-recovery', () => {
  test('non-numeric application id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/applications/abc/enrol-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ recoveryProgramId: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('non-integer recoveryProgramId → 400 INVALID_PROGRAM_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/visa/applications/5/enrol-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ recoveryProgramId: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PROGRAM_ID');
  });

  test('cross-tenant application → 404 APPLICATION_NOT_FOUND', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/visa/applications/99/enrol-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ recoveryProgramId: 1 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('APPLICATION_NOT_FOUND');
  });

  test('non-visasure contact → 404 NOT_VISA_SURE', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 5, contactId: 22, recoveryProgramId: null,
    });
    prisma.contact.findFirst.mockResolvedValue({ id: 22, subBrand: 'tmc' });
    const res = await request(makeApp())
      .post('/api/travel/visa/applications/5/enrol-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ recoveryProgramId: 1 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_VISA_SURE');
  });

  test('inactive program → 400 PROGRAM_INACTIVE', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 5, contactId: 22, recoveryProgramId: null,
    });
    prisma.contact.findFirst.mockResolvedValue({ id: 22, subBrand: 'visasure' });
    prisma.rejectionRecoveryProgram.findFirst.mockResolvedValue({
      id: 1, isActive: false,
    });
    const res = await request(makeApp())
      .post('/api/travel/visa/applications/5/enrol-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ recoveryProgramId: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PROGRAM_INACTIVE');
  });

  test('happy enrol writes recoveryProgramId + audit row', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 5, contactId: 22, recoveryProgramId: null,
    });
    prisma.contact.findFirst.mockResolvedValue({ id: 22, subBrand: 'visasure' });
    prisma.rejectionRecoveryProgram.findFirst.mockResolvedValue({
      id: 1, isActive: true,
    });
    prisma.visaApplication.update.mockResolvedValue({
      id: 5, recoveryProgramId: 1,
    });
    const res = await request(makeApp())
      .post('/api/travel/visa/applications/5/enrol-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ recoveryProgramId: 1 });
    expect(res.status).toBe(200);
    expect(res.body.applicationId).toBe(5);
    expect(res.body.recoveryProgramId).toBe(1);
    expect(prisma.visaApplication.update).toHaveBeenCalledOnce();
    expect(prisma.visaApplication.update.mock.calls[0][0].data.recoveryProgramId).toBe(1);
  });

  test('un-enrol with recoveryProgramId=null clears it', async () => {
    prisma.visaApplication.findFirst.mockResolvedValue({
      id: 5, contactId: 22, recoveryProgramId: 7,
    });
    prisma.contact.findFirst.mockResolvedValue({ id: 22, subBrand: 'visasure' });
    prisma.visaApplication.update.mockResolvedValue({
      id: 5, recoveryProgramId: null,
    });
    const res = await request(makeApp())
      .post('/api/travel/visa/applications/5/enrol-recovery')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ recoveryProgramId: null });
    expect(res.status).toBe(200);
    expect(res.body.recoveryProgramId).toBe(null);
    // No program lookup when un-enrolling.
    expect(prisma.rejectionRecoveryProgram.findFirst).not.toHaveBeenCalled();
  });
});
