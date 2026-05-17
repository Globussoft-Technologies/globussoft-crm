// @ts-check
/**
 * Unit tests for Patient anniversary + gst (Zylu-Gap #792 backend half).
 * Pins the POST + PUT contract introduced for the two new optional fields
 * on routes/wellness.js (~lines 906 + 1003).
 *
 * Backend changes pinned here
 * ───────────────────────────
 *   1. Schema: Patient.anniversary already existed but was silently
 *      dropped by the PUT allow-list pre-fix; Patient.gst is new
 *      (String? @db.VarChar(15)).
 *   2. POST /api/wellness/patients accepts + persists both fields.
 *   3. PUT  /api/wellness/patients/:id accepts + persists both fields
 *      (the v3.7 PUT allow-list omitted anniversary; this commit adds
 *      anniversary + gst to the allowed array).
 *   4. Invalid anniversary date → 400 INVALID_ANNIVERSARY.
 *   5. Invalid GSTIN (wrong length / wrong chars) → 400 INVALID_GST.
 *   6. GST canonicalisation: trimmed + upper-cased before persistence.
 *
 * Pattern mirrors backend/test/routes/wellness-loyalty-rules.test.js
 * (prisma singleton monkey-patch + supertest with a fake auth middleware).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.patient = {
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
// Permissively stub the other prisma surfaces touched at module load.
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });
prisma.referral = prisma.referral || {
  findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), update: vi.fn(),
};
prisma.loyaltyConfig = prisma.loyaltyConfig || { findUnique: vi.fn() };
prisma.loyaltyTransaction = prisma.loyaltyTransaction || {
  findFirst: vi.fn(), aggregate: vi.fn(), findMany: vi.fn(), create: vi.fn(),
};
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }), findFirst: vi.fn().mockResolvedValue(null) };

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole: 'admin' };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

const validBase = {
  name: 'Riya Sharma',
  phone: '+919876543210',
};

beforeEach(() => {
  prisma.patient.findFirst.mockReset();
  prisma.patient.create.mockReset();
  prisma.patient.update.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });
});

// ── POST /patients — accept + persist anniversary + gst ─────────────

describe('POST /api/wellness/patients — anniversary + gst (#792)', () => {
  test('persists anniversary as Date and gst as uppercase string', async () => {
    prisma.patient.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 1001, ...data }),
    );

    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({
        ...validBase,
        anniversary: '2018-12-15',
        gst: ' 27abcde1234f1z5 ', // lowercase + whitespace
      });

    expect(res.status).toBe(201);
    expect(prisma.patient.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.patient.create.mock.calls[0][0];
    expect(createArg.data.anniversary).toBeInstanceOf(Date);
    expect(createArg.data.anniversary.toISOString().slice(0, 10)).toBe('2018-12-15');
    // GST is trimmed + upper-cased — the route handler canonicalises before
    // persistence so reports + invoice rendering doesn't have to normalise.
    expect(createArg.data.gst).toBe('27ABCDE1234F1Z5');
  });

  test('persists null anniversary + null gst when fields omitted', async () => {
    prisma.patient.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 1002, ...data }),
    );
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase });
    expect(res.status).toBe(201);
    const createArg = prisma.patient.create.mock.calls[0][0];
    expect(createArg.data.anniversary).toBeNull();
    expect(createArg.data.gst).toBeNull();
  });

  test('rejects invalid anniversary date with 400 INVALID_ANNIVERSARY', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase, anniversary: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ANNIVERSARY');
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });

  test('rejects GST shorter than 15 chars with 400 INVALID_GST', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase, gst: '27ABCDE1234F' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_GST');
  });

  test('rejects GST with special chars with 400 INVALID_GST', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase, gst: '27ABCDE1234F1Z!' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_GST');
  });

  test('rejects GST longer than 15 chars with 400 INVALID_GST', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase, gst: '27ABCDE1234F1Z5EXTRA' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_GST');
  });
});

// ── PUT /patients/:id — anniversary + gst now in allow-list ─────────

describe('PUT /api/wellness/patients/:id — anniversary + gst (#792)', () => {
  test('updates anniversary on existing patient', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Riya', phone: '+919876543210', anniversary: null, gst: null,
    });
    prisma.patient.update.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 22, tenantId: 1, name: 'Riya', phone: '+919876543210', anniversary: null, gst: null,
        ...data,
      }),
    );
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ anniversary: '2020-06-30' });
    expect(res.status).toBe(200);
    const updArg = prisma.patient.update.mock.calls[0][0];
    expect(updArg.data.anniversary).toBeInstanceOf(Date);
    expect(updArg.data.anniversary.toISOString().slice(0, 10)).toBe('2020-06-30');
  });

  test('updates gst on existing patient (canonicalised uppercase)', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Riya', phone: '+919876543210', gst: null,
    });
    prisma.patient.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 22, ...data }),
    );
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ gst: '27abcde1234f1z5' });
    expect(res.status).toBe(200);
    const updArg = prisma.patient.update.mock.calls[0][0];
    expect(updArg.data.gst).toBe('27ABCDE1234F1Z5');
  });

  test('clears anniversary when sent as empty string', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Riya', phone: '+919876543210',
      anniversary: new Date('2018-12-15'), gst: null,
    });
    prisma.patient.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 22, ...data }),
    );
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ anniversary: '' });
    expect(res.status).toBe(200);
    const updArg = prisma.patient.update.mock.calls[0][0];
    expect(updArg.data.anniversary).toBeNull();
  });

  test('clears gst when sent as empty string', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Riya', phone: '+919876543210',
      gst: '27ABCDE1234F1Z5',
    });
    prisma.patient.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 22, ...data }),
    );
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ gst: '' });
    expect(res.status).toBe(200);
    const updArg = prisma.patient.update.mock.calls[0][0];
    expect(updArg.data.gst).toBeNull();
  });

  test('rejects invalid anniversary on PUT with 400', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Riya', phone: '+919876543210',
    });
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ anniversary: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ANNIVERSARY');
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });

  test('rejects invalid GST on PUT with 400', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Riya', phone: '+919876543210',
    });
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ gst: 'INVALID-CHARS!@' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_GST');
  });
});
