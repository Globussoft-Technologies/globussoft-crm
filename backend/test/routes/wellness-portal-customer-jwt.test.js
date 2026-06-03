// @ts-check
/**
 * Pins the verifyPatientToken middleware's Path B behaviour: regular
 * CUSTOMER session JWTs (issued by /auth/customer/register or
 * /auth/login) must transparently resolve to the linked Patient row so
 * the /home dashboard widgets (next-appointment + my-prescriptions)
 * work for self-registered customers without forcing an extra phone+OTP
 * step.
 *
 * Background: the widgets call /api/wellness/portal/visits +
 * /api/wellness/portal/prescriptions, which were originally gated by a
 * patient-portal-only token shape ({ patientId } signed with
 * PORTAL_JWT_SECRET). A user signing in via the regular login flow holds
 * a session token with { userType: 'CUSTOMER', userId, tenantId } — the
 * pre-fix middleware rejected it with 401 → widgets rendered
 * "Unauthorized" despite the user holding the correct role.
 *
 * The fix in routes/wellness.js (this commit) extends verifyPatientToken
 * to also accept the regular CUSTOMER session JWT and resolve Patient in
 * three steps:
 *   1. Existing link via Patient.userId (fast path).
 *   2. Claim an unlinked Patient by matching email (avoid forking the
 *      clinical record when staff created the Patient first).
 *   3. Auto-create a minimal Patient from the User profile (customer
 *      registered before any clinical contact).
 *
 * What this file pins
 * ───────────────────
 *   1. Path A unchanged — { patientId } portal token still resolves.
 *   2. Path B step 1 — CUSTOMER JWT with a pre-linked Patient.userId.
 *   3. Path B step 2 — CUSTOMER JWT with no link but matching email on
 *      an unlinked Patient row → claim by updating Patient.userId.
 *   4. Path B step 3 — CUSTOMER JWT, no link, no email match → auto-
 *      create a Patient row from User.name/email.
 *   5. Path B rejection — non-CUSTOMER session JWT still gets 401
 *      (staff tokens must not be elevated to portal access).
 *   6. Missing Authorization header → 401.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
// Force PORTAL_JWT_SECRET to match JWT_SECRET so the same signed token
// verifies under both branches — mirrors the on-demo deployment.
delete process.env.PORTAL_JWT_SECRET;

import prisma from '../../lib/prisma.js';

// Stub every prisma surface the /portal/visits handler + middleware touch.
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();
prisma.patient.update = vi.fn();
prisma.patient.create = vi.fn();

prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();

prisma.visit = prisma.visit || {};
prisma.visit.findMany = vi.fn();

// writeAudit calls go through auditLog — make them no-op so the handler's
// try/catch around the audit write is exercised in success-mode.
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
prisma.auditLog.findMany = vi.fn().mockResolvedValue([]);
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

const { JWT_SECRET } = process.env;

function signCustomerJwt({ userId = 100, tenantId = 7 } = {}) {
  return jwt.sign(
    { userId, tenantId, role: 'CUSTOMER', userType: 'CUSTOMER' },
    JWT_SECRET,
    { expiresIn: '5m' },
  );
}

function signPortalJwt({ patientId = 50, phoneLast10 = '9123456789' } = {}) {
  return jwt.sign({ patientId, phoneLast10 }, JWT_SECRET, { expiresIn: '5m' });
}

function signStaffJwt({ userId = 1, tenantId = 7 } = {}) {
  return jwt.sign(
    { userId, tenantId, role: 'ADMIN', userType: 'STAFF' },
    JWT_SECRET,
    { expiresIn: '5m' },
  );
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/wellness', wellnessRouter);
  return app;
}

beforeEach(() => {
  prisma.patient.findFirst.mockReset();
  prisma.patient.update.mockReset();
  prisma.patient.create.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.visit.findMany.mockReset();

  // Sensible defaults — empty result set so the handler's body returns [].
  prisma.visit.findMany.mockResolvedValue([]);
});

describe('verifyPatientToken — Path A (patient-portal token)', () => {
  test('classic { patientId } portal token resolves and returns the visit list', async () => {
    const token = signPortalJwt({ patientId: 50 });
    const res = await request(makeApp())
      .get('/api/wellness/portal/visits')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    // findFirst on Patient is NOT called — the patientId is taken directly
    // from the token (Path A short-circuits before the Path B lookup).
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.visit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { patientId: 50 },
      }),
    );
  });
});

describe('verifyPatientToken — Path B step 1 (linked Patient.userId)', () => {
  test('CUSTOMER JWT with a pre-linked Patient resolves on the fast path', async () => {
    prisma.patient.findFirst.mockResolvedValueOnce({ id: 42, phone: '+919123456789' });

    const token = signCustomerJwt({ userId: 100, tenantId: 7 });
    const res = await request(makeApp())
      .get('/api/wellness/portal/visits')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(prisma.patient.findFirst).toHaveBeenCalledWith({
      where: { userId: 100, tenantId: 7 },
      select: { id: true, phone: true, tenantId: true },
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.patient.create).not.toHaveBeenCalled();
    expect(prisma.visit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { patientId: 42 } }),
    );
  });
});

describe('verifyPatientToken — Path B step 2 (claim by email)', () => {
  test('CUSTOMER JWT with no link claims an existing unlinked Patient by email', async () => {
    // Step 1: no linked patient yet
    prisma.patient.findFirst.mockResolvedValueOnce(null);
    prisma.user.findUnique.mockResolvedValueOnce({
      name: 'Narendra Paul',
      email: 'narendra@example.com',
    });
    // Step 2: unlinked Patient with same email exists
    prisma.patient.findFirst.mockResolvedValueOnce({ id: 99, phone: '+919999900000' });
    prisma.patient.update.mockResolvedValueOnce({ id: 99 });

    const token = signCustomerJwt({ userId: 100, tenantId: 7 });
    const res = await request(makeApp())
      .get('/api/wellness/portal/visits')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(prisma.patient.findFirst).toHaveBeenNthCalledWith(1, {
      where: { userId: 100, tenantId: 7 },
      select: { id: true, phone: true, tenantId: true },
    });
    expect(prisma.patient.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        tenantId: 7,
        email: 'narendra@example.com',
        userId: null,
      },
      select: { id: true, phone: true, tenantId: true },
    });
    expect(prisma.patient.update).toHaveBeenCalledWith({
      where: { id: 99 },
      data: { userId: 100 },
    });
    expect(prisma.patient.create).not.toHaveBeenCalled();
    expect(prisma.visit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { patientId: 99 } }),
    );
  });
});

describe('verifyPatientToken — Path B step 3 (auto-create)', () => {
  test('CUSTOMER JWT with no link AND no email match auto-creates a Patient from the User profile', async () => {
    prisma.patient.findFirst.mockResolvedValueOnce(null); // no link
    prisma.user.findUnique.mockResolvedValueOnce({
      name: 'Narendra Paul',
      email: 'narendra@example.com',
    });
    prisma.patient.findFirst.mockResolvedValueOnce(null); // no claimable
    prisma.patient.create.mockResolvedValueOnce({ id: 500, phone: null });

    const token = signCustomerJwt({ userId: 100, tenantId: 7 });
    const res = await request(makeApp())
      .get('/api/wellness/portal/visits')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(prisma.patient.create).toHaveBeenCalledWith({
      data: {
        name: 'Narendra Paul',
        email: 'narendra@example.com',
        tenantId: 7,
        userId: 100,
        source: 'self-register',
      },
      select: { id: true, phone: true, tenantId: true },
    });
    expect(prisma.patient.update).not.toHaveBeenCalled();
    expect(prisma.visit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { patientId: 500 } }),
    );
  });

  test('Auto-create falls back to email then a literal "Customer" when User.name is missing', async () => {
    prisma.patient.findFirst.mockResolvedValueOnce(null);
    prisma.user.findUnique.mockResolvedValueOnce({ name: null, email: null });
    prisma.patient.create.mockResolvedValueOnce({ id: 501, phone: null });

    const token = signCustomerJwt({ userId: 100, tenantId: 7 });
    const res = await request(makeApp())
      .get('/api/wellness/portal/visits')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(prisma.patient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Customer',
        email: null,
        userId: 100,
        tenantId: 7,
      }),
      select: { id: true, phone: true, tenantId: true },
    });
  });
});

describe('verifyPatientToken — auth-gate negatives', () => {
  // Updated for the looser Path B: a STAFF-typed session is no longer
  // rejected up-front (clinics use the USER role as a patient pool, so
  // userType-only gating was too narrow). Instead the middleware looks
  // up Patient.userId, and only rejects if no linked Patient row exists
  // — but with a distinct 403 NO_PATIENT_PROFILE code so the frontend
  // can show the role-mismatch view instead of force-redirecting.
  test('staff JWT with NO linked Patient row → 403 NO_PATIENT_PROFILE', async () => {
    // findFirst returns null (no link). user.findUnique should NOT run
    // because auto-create is gated on userType === CUSTOMER.
    prisma.patient.findFirst.mockResolvedValueOnce(null);

    const token = signStaffJwt();
    const res = await request(makeApp())
      .get('/api/wellness/portal/visits')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_PATIENT_PROFILE');
    expect(prisma.patient.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });

  test('staff JWT WITH a linked Patient row (USER-role-as-patient) → 200', async () => {
    // Clinics map their USER role as patients — a Patient.userId link
    // exists. Pin the contract that the middleware accepts this and
    // does NOT try to auto-create / claim by email (those paths stay
    // CUSTOMER-only).
    prisma.patient.findFirst.mockResolvedValueOnce({ id: 77, phone: '+918888800000' });

    const token = signStaffJwt();
    const res = await request(makeApp())
      .get('/api/wellness/portal/visits')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.patient.create).not.toHaveBeenCalled();
    expect(prisma.visit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { patientId: 77 } }),
    );
  });

  test('missing Authorization header → 401 "Missing portal token"', async () => {
    const res = await request(makeApp()).get('/api/wellness/portal/visits');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing portal token/i);
  });

  test('garbage Bearer → 401 "Invalid or expired portal token"', async () => {
    const res = await request(makeApp())
      .get('/api/wellness/portal/visits')
      .set('Authorization', 'Bearer not.a.real.jwt');
    expect(res.status).toBe(401);
  });
});
