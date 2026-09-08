// @ts-check
/**
 * Route-level tests for prescription validity — POST /api/wellness/prescriptions
 * and PUT /api/wellness/prescriptions/:id.
 *
 * The helper's rules are pinned in test/lib/prescriptionHelpers.test.js. What
 * needs pinning HERE is the wiring, which is where this would actually break:
 *   • an omitted validity stores NULL on both columns — "no stated validity",
 *     never 0 and never an implied expiry;
 *   • `validUntil` is DERIVED server-side, so a client cannot post a lapse
 *     date that disagrees with the days it also sent;
 *   • a bad value is a 400 with a branchable code, not a silently dropped
 *     field — losing what the clinician typed is the dangerous failure;
 *   • amending re-anchors to the ORIGINAL createdAt, so editing the validity
 *     of a course written last week does not restart the patient's clock;
 *   • the change lands in the medico-legal audit trail.
 *
 * Pattern: auth-middleware bypass + prisma singleton monkey-patch, same as
 * backend/test/routes/wellness-prescription-requests.test.js.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

const prisma = requireCJS('../../lib/prisma');

prisma.prescription = prisma.prescription || {};
prisma.prescription.create = vi.fn();
prisma.prescription.findFirst = vi.fn();
prisma.prescription.update = vi.fn();
prisma.prescription.findMany = vi.fn().mockResolvedValue([]);
prisma.prescription.count = vi.fn().mockResolvedValue(0);

prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });
prisma.userRole = prisma.userRole || {};
prisma.userRole.findMany = vi.fn().mockResolvedValue([]);
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue(null);

const eventBus = requireCJS('../../lib/eventBus');
if (eventBus.emitEvent) eventBus.emitEvent = vi.fn().mockResolvedValue(undefined);
if (eventBus.safeEmitEvent) eventBus.safeEmitEvent = vi.fn().mockResolvedValue(undefined);

import express from 'express';
import request from 'supertest';

const router = requireCJS('../../routes/wellness');

// requireClinicalRole admits ADMIN outright, which keeps these tests focused
// on the validity wiring rather than re-testing the clinical gate.
function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, vertical: 'wellness' };
    next();
  });
  app.use('/api/wellness', router);
  return app;
}

const DRUGS = [{ name: 'Amoxicillin 500mg', dosage: 1, frequency: 3, duration: 5 }];

beforeEach(() => {
  vi.clearAllMocks();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.prescription.create.mockImplementation(async ({ data }) => ({
    id: 900,
    ...data,
  }));
  prisma.prescription.update.mockImplementation(async ({ data }) => ({
    id: 900,
    patientId: 3,
    visitId: 4,
    doctorId: 7,
    drugs: JSON.stringify(DRUGS),
    createdAt: new Date('2026-06-01T09:00:00.000Z'),
    ...data,
  }));
});

describe('POST /api/wellness/prescriptions — validity', () => {
  test('omitting validity stores NULL on both columns, not 0', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/prescriptions')
      .send({ visitId: 4, patientId: 3, drugs: DRUGS });

    expect(res.status).toBe(201);
    const data = prisma.prescription.create.mock.calls[0][0].data;
    expect(data.validityDays).toBeNull();
    expect(data.validUntil).toBeNull();
  });

  test('stores the days and derives validUntil from the issue date', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/prescriptions')
      .send({ visitId: 4, patientId: 3, drugs: DRUGS, validityDays: 30 });

    expect(res.status).toBe(201);
    const data = prisma.prescription.create.mock.calls[0][0].data;
    expect(data.validityDays).toBe(30);
    // createdAt is pinned to the same instant the lapse date is measured from,
    // so the two can never drift by the width of the insert.
    const delta = data.validUntil.getTime() - data.createdAt.getTime();
    expect(delta).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test('accepts a numeric string, as an HTML number input sends', async () => {
    await request(makeApp())
      .post('/api/wellness/prescriptions')
      .send({ visitId: 4, patientId: 3, drugs: DRUGS, validityDays: '45' });

    expect(prisma.prescription.create.mock.calls[0][0].data.validityDays).toBe(45);
  });

  test('ignores a client-supplied validUntil — the server derives it', async () => {
    await request(makeApp())
      .post('/api/wellness/prescriptions')
      .send({
        visitId: 4,
        patientId: 3,
        drugs: DRUGS,
        validityDays: 30,
        // A client trying to set a lapse date inconsistent with the days.
        validUntil: '2099-01-01T00:00:00.000Z',
      });

    const data = prisma.prescription.create.mock.calls[0][0].data;
    expect(data.validUntil.getFullYear()).not.toBe(2099);
    expect(data.validUntil.getTime() - data.createdAt.getTime()).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
  });

  test('a bad value is a 400 with a branchable code, and writes nothing', async () => {
    for (const bad of [0, -5, 1.5, 'soon', 366]) {
      prisma.prescription.create.mockClear();
      const res = await request(makeApp())
        .post('/api/wellness/prescriptions')
        .send({ visitId: 4, patientId: 3, drugs: DRUGS, validityDays: bad });

      expect(res.status, `validityDays=${bad}`).toBe(400);
      expect(res.body.code).toBe('INVALID_VALIDITY_DAYS');
      expect(prisma.prescription.create).not.toHaveBeenCalled();
    }
  });

  test('records the validity in the medico-legal audit entry', async () => {
    await request(makeApp())
      .post('/api/wellness/prescriptions')
      .send({ visitId: 4, patientId: 3, drugs: DRUGS, validityDays: 30 });

    const entry = prisma.auditLog.create.mock.calls.find(
      (c) => c[0]?.data?.action === 'CREATE',
    );
    expect(entry).toBeTruthy();
    expect(JSON.parse(entry[0].data.details).validityDays).toBe(30);
  });
});

describe('PUT /api/wellness/prescriptions/:id — validity', () => {
  const ISSUED = new Date('2026-06-01T09:00:00.000Z');

  beforeEach(() => {
    prisma.prescription.findFirst.mockResolvedValue({
      id: 900,
      tenantId: 1,
      patientId: 3,
      visitId: 4,
      doctorId: 7,
      drugs: JSON.stringify(DRUGS),
      instructions: 'After food',
      validityDays: null,
      createdAt: ISSUED,
    });
  });

  test('re-anchors the lapse date to the ORIGINAL issue date, not to now', async () => {
    const res = await request(makeApp())
      .put('/api/wellness/prescriptions/900')
      .send({ validityDays: 30 });

    expect(res.status).toBe(200);
    const data = prisma.prescription.update.mock.calls[0][0].data;
    expect(data.validityDays).toBe(30);
    // 1 June + 30 days — editing weeks later must not restart the patient's
    // clock at "today + 30".
    expect(data.validUntil.toISOString()).toBe('2026-07-01T09:00:00.000Z');
  });

  test('leaves validity untouched when the field is absent from the body', async () => {
    await request(makeApp())
      .put('/api/wellness/prescriptions/900')
      .send({ instructions: 'Before food' });

    const data = prisma.prescription.update.mock.calls[0][0].data;
    expect('validityDays' in data).toBe(false);
    expect('validUntil' in data).toBe(false);
  });

  test('an explicit blank clears the validity back to "no stated validity"', async () => {
    await request(makeApp())
      .put('/api/wellness/prescriptions/900')
      .send({ validityDays: '' });

    const data = prisma.prescription.update.mock.calls[0][0].data;
    expect(data.validityDays).toBeNull();
    expect(data.validUntil).toBeNull();
  });

  test('a bad value is a 400 and writes nothing', async () => {
    const res = await request(makeApp())
      .put('/api/wellness/prescriptions/900')
      .send({ validityDays: 999 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VALIDITY_DAYS');
    expect(prisma.prescription.update).not.toHaveBeenCalled();
  });

  test('the audit entry carries the before and after validity', async () => {
    await request(makeApp())
      .put('/api/wellness/prescriptions/900')
      .send({ validityDays: 60 });

    const entry = prisma.auditLog.create.mock.calls.find(
      (c) => c[0]?.data?.action === 'UPDATE_PRESCRIPTION',
    );
    expect(entry).toBeTruthy();
    const details = JSON.parse(entry[0].data.details);
    expect(details.priorValidityDays).toBeNull();
    expect(details.newValidityDays).toBe(60);
  });
});
