// @ts-check
/**
 * Route-level tests for the prescription clinical narrative —
 * POST /api/wellness/prescriptions and PUT /api/wellness/prescriptions/:id.
 *
 * Chief Complaint / Diagnosis / Investigations / Advice used to be recovered
 * ONLY by scanning the free-text `instructions` for "Diagnosis:"-style line
 * prefixes. That reader exists for prescriptions migrated from Zylu, whose
 * notes carried those sections inline — but nothing in this CRM ever WROTE
 * them, so on every natively-written prescription all four rendered as an em
 * dash and there was no way to fill them.
 *
 * They are real columns now. What needs pinning here is the wiring, and above
 * all the BACK-COMPAT: a client that has never heard of these fields must
 * behave exactly as it did before.
 *
 * Pattern mirrors wellness-prescription-validity.test.js.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();

const prisma = requireCJS('../../lib/prisma');
prisma.prescription = prisma.prescription || {};
prisma.prescription.create = vi.fn();
prisma.prescription.update = vi.fn();
prisma.prescription.findFirst = vi.fn();
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn();
prisma.auditLog.findFirst = vi.fn();

const express = requireCJS('express');
const request = requireCJS('supertest');
const router = requireCJS('../../routes/wellness');

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

const NARRATIVE = {
  chiefComplaint: 'Itchy scalp for three weeks',
  diagnosis: 'Seborrheic dermatitis',
  investigations: 'KOH mount negative',
  advice: 'Review in four weeks',
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.prescription.create.mockImplementation(async ({ data }) => ({ id: 900, ...data }));
  prisma.prescription.findFirst.mockResolvedValue({
    id: 900,
    patientId: 3,
    visitId: 4,
    doctorId: 7,
    tenantId: 1,
    drugs: JSON.stringify(DRUGS),
    createdAt: new Date('2026-06-01T09:00:00.000Z'),
  });
  prisma.prescription.update.mockImplementation(async ({ data }) => ({
    id: 900,
    patientId: 3,
    visitId: 4,
    createdAt: new Date('2026-06-01T09:00:00.000Z'),
    drugs: JSON.stringify(DRUGS),
    ...data,
  }));
});

describe('POST /api/wellness/prescriptions — clinical narrative', () => {
  test('persists all four fields to their own columns', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/prescriptions')
      .send({ visitId: 4, patientId: 3, drugs: DRUGS, ...NARRATIVE });

    expect(res.status).toBe(201);
    const { data } = prisma.prescription.create.mock.calls[0][0];
    expect(data).toMatchObject(NARRATIVE);
  });

  test('does NOT smuggle them into instructions — that was the old format', async () => {
    await request(makeApp())
      .post('/api/wellness/prescriptions')
      .send({ visitId: 4, patientId: 3, drugs: DRUGS, ...NARRATIVE, instructions: 'Take with food' });

    const { data } = prisma.prescription.create.mock.calls[0][0];
    expect(data.instructions).toBe('Take with food');
    expect(data.instructions).not.toMatch(/Diagnosis:/i);
  });

  test('a blank field stores NULL, not an empty string', async () => {
    // "Not recorded" has to stay distinguishable from "recorded as blank",
    // because the read path falls back to the legacy parser only on NULL.
    await request(makeApp())
      .post('/api/wellness/prescriptions')
      .send({ visitId: 4, patientId: 3, drugs: DRUGS, diagnosis: '   ', advice: '' });

    const { data } = prisma.prescription.create.mock.calls[0][0];
    expect(data.diagnosis).toBeNull();
    expect(data.advice).toBeNull();
  });

  test('BACK-COMPAT: a client that sends none of them is completely unaffected', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/prescriptions')
      .send({ visitId: 4, patientId: 3, drugs: DRUGS, instructions: 'Take with food' });

    expect(res.status).toBe(201);
    const { data } = prisma.prescription.create.mock.calls[0][0];
    // Absent keys are not written at all, so the column defaults to NULL and
    // the create payload is byte-identical to what it was before this change.
    for (const key of Object.keys(NARRATIVE)) {
      expect(data).not.toHaveProperty(key);
    }
    expect(data.instructions).toBe('Take with food');
  });

  test('an over-long field is a 400 with a branchable code, not a silent truncation', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/prescriptions')
      .send({ visitId: 4, patientId: 3, drugs: DRUGS, diagnosis: 'x'.repeat(5001) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CLINICAL_FIELD_TOO_LONG');
    expect(prisma.prescription.create).not.toHaveBeenCalled();
  });
});

describe('PUT /api/wellness/prescriptions/:id — clinical narrative', () => {
  test('updates only the fields the caller sent', async () => {
    await request(makeApp())
      .put('/api/wellness/prescriptions/900')
      .send({ diagnosis: 'Contact dermatitis' });

    const { data } = prisma.prescription.update.mock.calls[0][0];
    expect(data.diagnosis).toBe('Contact dermatitis');
    // An omitted field must be left alone, never blanked.
    expect(data).not.toHaveProperty('chiefComplaint');
    expect(data).not.toHaveProperty('advice');
  });

  test('an explicit null clears a field', async () => {
    await request(makeApp())
      .put('/api/wellness/prescriptions/900')
      .send({ diagnosis: null });

    const { data } = prisma.prescription.update.mock.calls[0][0];
    expect(data.diagnosis).toBeNull();
  });

  test('BACK-COMPAT: an amend that touches only drugs writes no clinical keys', async () => {
    await request(makeApp())
      .put('/api/wellness/prescriptions/900')
      .send({ drugs: DRUGS });

    const { data } = prisma.prescription.update.mock.calls[0][0];
    for (const key of Object.keys(NARRATIVE)) {
      expect(data).not.toHaveProperty(key);
    }
  });
});
