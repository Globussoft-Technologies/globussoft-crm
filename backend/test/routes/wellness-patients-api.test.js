// @ts-check
/**
 * Unit tests for S100 — backend whitelist for `firstName` + `lastName`
 * on POST + PUT /api/wellness/patients.
 *
 * Background — the S62 → S96 → S97 → S100 chain
 * ─────────────────────────────────────────────
 *   S62  (schema)   added Patient.firstName + Patient.lastName columns as
 *                   additive-nullable String?.
 *   S96  (list)     extended the slim-shape projection in lib/listProjection
 *                   to surface both columns on GET /patients?fields=summary.
 *   S97  (frontend) wired PatientCreateModal to send firstName + lastName in
 *                   POST + PUT payloads.
 *   S100 (this)     adds the route-side whitelist so the destructure and the
 *                   PUT allow-list actually persist the fields. Before this,
 *                   the modal's data was silently dropped at the route's
 *                   destructure boundary — every new Patient row landed
 *                   with firstName=null + lastName=null despite the modal
 *                   sending the data.
 *
 * Contract pinned here
 * ────────────────────
 *   POST /api/wellness/patients
 *     C1. firstName + lastName both provided → persisted verbatim (trimmed).
 *     C2. Only firstName provided → firstName persisted, lastName=null.
 *     C3. Neither provided (legacy clients sending only `name`) → both
 *         columns stay null. Existing `name` contract unchanged.
 *     C4. firstName length > 80 → 400 INVALID_NAME_FIELD; no create call.
 *     C5. firstName as empty string ("") → null persisted (don't store
 *         empty-string columns; aligns with existing `name` normalisation).
 *
 *   PUT /api/wellness/patients/:id
 *     C6. firstName provided on PUT → field updated; other fields untouched.
 *     C7. lastName: null on PUT → field CLEARED (admin can blank the last
 *         name on a single-name patient via inline-edit).
 *     C8. firstName length > 80 → 400 INVALID_NAME_FIELD; no update call.
 *     C9. Cross-tenant PUT (existing row not in tenant) → 404; no update.
 *
 *   Integration with S96 slim shape
 *    C10. After POST with firstName/lastName, GET ?fields=summary surfaces
 *         the persisted values in the slim payload (covered via mock
 *         findMany + select, asserts that the slim Select touches the
 *         columns we just persisted).
 *
 * Why mocked prisma (not the live MySQL container): keeps the unit-test
 * gate fast + isolated. The mutation surface IS the contract — we assert
 * the `prisma.patient.create({ data })` payload + the
 * `prisma.patient.update({ where, data })` payload. The e2e-full /
 * api_tests suite exercises the round-trip against real MySQL via
 * `e2e/tests/wellness-clinical-api.spec.js`.
 *
 * Pattern mirrors backend/test/routes/wellness-patient-anniversary-gst.test.js
 * (the working POST + PUT contract harness) — patch the prisma singleton
 * BEFORE requiring the router so the require'd router binds to the spy'd
 * functions, mount under a tiny Express app, inject `req.user` via a
 * synthetic middleware (role=ADMIN + wellnessRole='admin' passes
 * phiWriteGate).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by routes/wellness.js at require-time. ──
prisma.patient = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
};
prisma.visit = prisma.visit || {};
prisma.visit.findMany = vi.fn();
prisma.invoice = prisma.invoice || {};
prisma.invoice.findMany = vi.fn();
// Permissively stub the other prisma surfaces touched at module load time
// (referral linkage on source=referral, tenant lookup in phiWriteGate, etc).
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
// emitEvent calls automationRule.findMany — see anniversary-gst.test.js for
// the same defensive stub explanation.
prisma.automationRule = prisma.automationRule || { findMany: vi.fn().mockResolvedValue([]) };
if (!prisma.automationRule.findMany || !prisma.automationRule.findMany._isMockFunction) {
  prisma.automationRule.findMany = vi.fn().mockResolvedValue([]);
}

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = 'admin',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole };
    next();
  });
  app.use('/api/wellness', wellnessRouter);
  return app;
}

// Minimal valid POST body — name + phone are required by validatePatientInput.
const validBase = {
  name: 'Riya Sharma',
  phone: '+919876543210',
};

beforeEach(() => {
  prisma.patient.findFirst.mockReset();
  prisma.patient.findMany.mockReset();
  prisma.patient.create.mockReset();
  prisma.patient.update.mockReset();
  prisma.patient.count.mockReset();
  prisma.visit.findMany.mockReset();
  prisma.invoice.findMany.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });
  // Default echo-back create — any data passed in lands in the returned row.
  prisma.patient.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: 1001, tenantId: 1, ...data }),
  );
  prisma.patient.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ id: where.id, tenantId: 1, ...data }),
  );
  prisma.patient.count.mockResolvedValue(0);
});

// ─── POST /patients — S100 firstName + lastName whitelist ─────────────

describe('POST /api/wellness/patients — S100 firstName + lastName whitelist', () => {
  test('C1: firstName + lastName both provided → persisted verbatim (trimmed)', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase, firstName: 'Riya', lastName: 'Sharma' });
    expect(res.status).toBe(201);
    expect(prisma.patient.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.patient.create.mock.calls[0][0];
    expect(createArg.data.firstName).toBe('Riya');
    expect(createArg.data.lastName).toBe('Sharma');
    // Body also reflects what the route returned (echo-back mock).
    expect(res.body.firstName).toBe('Riya');
    expect(res.body.lastName).toBe('Sharma');
  });

  test('C1b: leading/trailing whitespace is trimmed before persistence', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({
        ...validBase,
        firstName: '   Riya   ',
        lastName: '  Sharma  ',
      });
    expect(res.status).toBe(201);
    const createArg = prisma.patient.create.mock.calls[0][0];
    expect(createArg.data.firstName).toBe('Riya');
    expect(createArg.data.lastName).toBe('Sharma');
  });

  test('C2: only firstName provided → firstName persisted, lastName null', async () => {
    // Some legal-name cultures use a single name — lastName must be optional.
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase, firstName: 'Madonna' });
    expect(res.status).toBe(201);
    const createArg = prisma.patient.create.mock.calls[0][0];
    expect(createArg.data.firstName).toBe('Madonna');
    expect(createArg.data.lastName).toBeNull();
  });

  test('C3: neither field provided (legacy client) → both columns null', async () => {
    // Pre-S97 clients send only `name`. The whitelist is additive — they
    // continue to work unchanged and both new columns stay null.
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase });
    expect(res.status).toBe(201);
    const createArg = prisma.patient.create.mock.calls[0][0];
    expect(createArg.data.firstName).toBeNull();
    expect(createArg.data.lastName).toBeNull();
    // Existing `name` contract MUST be unchanged — the row still saves
    // the canonical full name verbatim.
    expect(createArg.data.name).toBe('Riya Sharma');
  });

  test('C4: firstName length > 80 → 400 INVALID_NAME_FIELD; no create call', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase, firstName: 'a'.repeat(81) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NAME_FIELD');
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });

  test('C4b: lastName length > 80 → 400 INVALID_NAME_FIELD; no create call', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase, firstName: 'Riya', lastName: 'b'.repeat(81) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NAME_FIELD');
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });

  test('C5: firstName empty string → null persisted (no empty-string columns)', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase, firstName: '', lastName: 'Sharma' });
    expect(res.status).toBe(201);
    const createArg = prisma.patient.create.mock.calls[0][0];
    expect(createArg.data.firstName).toBeNull();
    expect(createArg.data.lastName).toBe('Sharma');
  });

  test('C5b: whitespace-only firstName → null persisted', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase, firstName: '   ', lastName: 'Sharma' });
    expect(res.status).toBe(201);
    const createArg = prisma.patient.create.mock.calls[0][0];
    expect(createArg.data.firstName).toBeNull();
    expect(createArg.data.lastName).toBe('Sharma');
  });

  test('non-string firstName (number) → 400 INVALID_NAME_FIELD', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients')
      .send({ ...validBase, firstName: 12345 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NAME_FIELD');
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });
});

// ─── PUT /patients/:id — S100 firstName + lastName whitelist ──────────

describe('PUT /api/wellness/patients/:id — S100 firstName + lastName whitelist', () => {
  test('C6: firstName provided on PUT → field updated', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Riya Sharma', phone: '+919876543210',
      firstName: 'Riya', lastName: 'Sharma',
    });
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ firstName: 'Priya' });
    expect(res.status).toBe(200);
    expect(prisma.patient.update).toHaveBeenCalledTimes(1);
    const updArg = prisma.patient.update.mock.calls[0][0];
    expect(updArg.data.firstName).toBe('Priya');
    // Other allow-list fields untouched.
    expect(updArg.data).not.toHaveProperty('name');
    expect(updArg.data).not.toHaveProperty('phone');
  });

  test('C6b: PUT with both firstName + lastName updates both fields', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Riya Sharma', phone: '+919876543210',
      firstName: 'Riya', lastName: 'Sharma',
    });
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ firstName: 'Priya', lastName: 'Mehta' });
    expect(res.status).toBe(200);
    const updArg = prisma.patient.update.mock.calls[0][0];
    expect(updArg.data.firstName).toBe('Priya');
    expect(updArg.data.lastName).toBe('Mehta');
  });

  test('C7: PUT lastName: null → field CLEARED on the row', async () => {
    // Admin editing a single-name patient may legitimately blank the
    // lastName via inline-edit.
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Madonna', phone: '+919876543210',
      firstName: 'Madonna', lastName: 'OldFamilyName',
    });
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ lastName: null });
    expect(res.status).toBe(200);
    const updArg = prisma.patient.update.mock.calls[0][0];
    expect(updArg.data.lastName).toBeNull();
  });

  test('C7b: PUT lastName: empty string → field CLEARED on the row', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Madonna', phone: '+919876543210',
      firstName: 'Madonna', lastName: 'OldFamilyName',
    });
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ lastName: '' });
    expect(res.status).toBe(200);
    const updArg = prisma.patient.update.mock.calls[0][0];
    expect(updArg.data.lastName).toBeNull();
  });

  test('C8: PUT firstName length > 80 → 400 INVALID_NAME_FIELD; no update', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Riya Sharma', phone: '+919876543210',
    });
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ firstName: 'a'.repeat(81) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NAME_FIELD');
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });

  test('C8b: PUT lastName length > 80 → 400 INVALID_NAME_FIELD; no update', async () => {
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Riya Sharma', phone: '+919876543210',
    });
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ lastName: 'b'.repeat(81) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NAME_FIELD');
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });

  test('C9: PUT against a row not in this tenant → 404; no update', async () => {
    // tenantWhere() filters by req.user.tenantId; findFirst returns null
    // when the row exists but belongs to a different tenant.
    prisma.patient.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .put('/api/wellness/patients/9999')
      .send({ firstName: 'Hacker', lastName: 'McCrosstenant' });
    expect(res.status).toBe(404);
    expect(prisma.patient.update).not.toHaveBeenCalled();
  });

  test('PUT with only legacy `name` (no firstName/lastName keys) still works', async () => {
    // Pre-S97 clients that only know `name` MUST keep working — the new
    // whitelist is additive, never required.
    prisma.patient.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, name: 'Riya Sharma', phone: '+919876543210',
    });
    const res = await request(makeApp())
      .put('/api/wellness/patients/22')
      .send({ name: 'Riya Updated' });
    expect(res.status).toBe(200);
    const updArg = prisma.patient.update.mock.calls[0][0];
    expect(updArg.data.name).toBe('Riya Updated');
    expect(updArg.data).not.toHaveProperty('firstName');
    expect(updArg.data).not.toHaveProperty('lastName');
  });
});

// ─── Slim-shape integration (S96 + S100) ──────────────────────────────

describe('GET /api/wellness/patients?fields=summary — S96+S100 surface firstName/lastName', () => {
  test('C10: slim-shape Select includes firstName + lastName columns', async () => {
    // Wire mock so we can inspect the findManyArgs the route built.
    prisma.patient.findMany.mockResolvedValue([
      {
        id: 1, name: 'Riya Sharma', firstName: 'Riya', lastName: 'Sharma',
        createdAt: new Date('2026-06-10T10:00:00Z'),
      },
    ]);
    prisma.patient.count.mockResolvedValue(1);

    const res = await request(makeApp()).get('/api/wellness/patients?fields=summary&limit=5');
    expect(res.status).toBe(200);
    // The slim path uses Prisma's `select` projection — assert it touches
    // both columns. listProjection.js (S96) is what populates this select,
    // but the integration boundary the route owns is "we passed `select`,
    // and `select` includes firstName + lastName."
    const findManyArg = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArg.select).toBeDefined();
    expect(findManyArg.select.firstName).toBe(true);
    expect(findManyArg.select.lastName).toBe(true);
    // PHI drops still hold on slim shape — adding firstName/lastName MUST
    // NOT have re-introduced phone/email/dob/allergies/notes.
    expect(findManyArg.select.phone).toBeUndefined();
    expect(findManyArg.select.email).toBeUndefined();
    expect(findManyArg.select.dob).toBeUndefined();
    // Response payload surfaces the persisted values.
    expect(res.body.patients[0]).toMatchObject({
      firstName: 'Riya',
      lastName: 'Sharma',
    });
  });
});
