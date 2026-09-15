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
prisma.patient.findUnique = vi.fn();
prisma.patient.findFirst = vi.fn();
prisma.patient.update = vi.fn();
prisma.patient.create = vi.fn();

prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();

prisma.visit = prisma.visit || {};
prisma.visit.findMany = vi.fn();
prisma.visit.findFirst = vi.fn();

prisma.consentForm = prisma.consentForm || {};
prisma.consentForm.findMany = vi.fn();
prisma.consentForm.findFirst = vi.fn();
prisma.signatureRequest = prisma.signatureRequest || {};
prisma.signatureRequest.findMany = vi.fn();
prisma.signatureRequest.findFirst = vi.fn();
prisma.service = prisma.service || {};
prisma.service.findMany = vi.fn();
prisma.location = prisma.location || {};
prisma.location.findFirst = vi.fn();
prisma.role = prisma.role || {};
prisma.role.findFirst = vi.fn();

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
const { clearCustomerRoleCache } = requireCJS('../../lib/portalPermissions');

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
  prisma.patient.findUnique.mockReset();
  prisma.patient.findFirst.mockReset();
  prisma.patient.update.mockReset();
  prisma.patient.create.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.visit.findMany.mockReset();
  prisma.visit.findFirst.mockReset();
  prisma.consentForm.findMany.mockReset();
  prisma.consentForm.findFirst.mockReset();
  prisma.signatureRequest.findMany.mockReset();
  prisma.signatureRequest.findFirst.mockReset();
  prisma.service.findMany.mockReset();
  prisma.location.findFirst.mockReset();
  prisma.role.findFirst.mockReset();
  clearCustomerRoleCache();

  // Sensible defaults — empty result set so the handler's body returns [].
  prisma.visit.findMany.mockResolvedValue([]);
  prisma.visit.findFirst.mockResolvedValue(null);
  // Path A default: patient exists so portal tokens resolve.
  prisma.patient.findUnique.mockResolvedValue({ id: 50, tenantId: 7 });
  prisma.consentForm.findMany.mockResolvedValue([]);
  prisma.consentForm.findFirst.mockResolvedValue(null);
  prisma.signatureRequest.findMany.mockResolvedValue([]);
  prisma.signatureRequest.findFirst.mockResolvedValue(null);
  prisma.service.findMany.mockResolvedValue([]);
  prisma.location.findFirst.mockResolvedValue(null);
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
      where: { userId: 100, tenantId: 7, deletedAt: null },
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
      where: { userId: 100, tenantId: 7, deletedAt: null },
      select: { id: true, phone: true, tenantId: true },
    });
    expect(prisma.patient.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        tenantId: 7,
        email: 'narendra@example.com',
        userId: null,
        deletedAt: null,
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
describe('portal consent read scope', () => {
  beforeEach(() => {
    prisma.role.findFirst.mockResolvedValue({
      id: 7,
      permissions: [{ module: 'consents', action: 'read' }],
    });
  });

  test('lists only signed consent forms belonging to the portal patient', async () => {
    const rows = [{
      id: 801,
      templateName: 'Hair Transplant',
      signedAt: new Date('2026-08-28T14:33:00.000Z'),
      patientId: 50,
      serviceId: 12,
      hasPdfBlob: true,
      service: { id: 12, name: 'Hair Transplant' },
    }];
    prisma.consentForm.findMany.mockResolvedValue(rows);

    const token = signPortalJwt({ patientId: 50 });
    const res = await request(makeApp())
      .get('/api/wellness/portal/consents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 801, patientId: 50 }),
    ]));
    expect(prisma.role.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, key: 'CUSTOMER' },
    }));
    expect(prisma.consentForm.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { patientId: 50, tenantId: 7 },
    }));
  });

  test('denies list access when CUSTOMER role lacks consents.read', async () => {
    prisma.role.findFirst.mockResolvedValue({ id: 7, permissions: [] });

    const token = signPortalJwt({ patientId: 50 });
    const res = await request(makeApp())
      .get('/api/wellness/portal/consents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_RBAC_DENIED');
    expect(prisma.consentForm.findMany).not.toHaveBeenCalled();
  });

  test('includes signed patient e-signatures in the consent list without replacing legacy rows', async () => {
    prisma.consentForm.findMany.mockResolvedValueOnce([{
      id: 802,
      templateName: 'Legacy consent',
      patientId: 50,
      signedAt: new Date('2026-08-01T10:00:00.000Z'),
      serviceId: 12,
      service: { id: 12, name: 'Legacy service' },
    }]);
    prisma.signatureRequest.findMany.mockResolvedValueOnce([{
      id: 910,
      documentName: 'Hair Transplant Consent',
      signedAt: new Date('2026-08-28T10:00:00.000Z'),
      patientId: 50,
      visitId: 901,
      serviceIds: '[12]',
    }]);
    prisma.service.findMany.mockResolvedValueOnce([{ id: 12, name: 'Hair Transplant' }]);

    const token = signPortalJwt({ patientId: 50 });
    const res = await request(makeApp())
      .get('/api/wellness/portal/consents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 802, source: 'consent' }),
      expect.objectContaining({ id: 910, source: 'signature', signatureRequestId: 910, visitId: 901 }),
    ]));
    expect(prisma.signatureRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ patientId: 50, tenantId: 7, status: 'SIGNED', documentType: 'Custom' }),
    }));
  });

  test('regular CUSTOMER session token can list its linked consent forms', async () => {
    prisma.patient.findFirst.mockResolvedValueOnce({ id: 50, phone: '+919123456789', tenantId: 7 });
    prisma.consentForm.findMany.mockResolvedValueOnce([
      { id: 802, templateName: 'General', patientId: 50, signedAt: new Date() },
    ]);

    const token = signCustomerJwt({ userId: 100, tenantId: 7 });
    const res = await request(makeApp())
      .get('/api/wellness/portal/consents')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual(expect.objectContaining({ id: 802, patientId: 50 }));
    expect(prisma.patient.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 100, tenantId: 7, deletedAt: null },
    }));
  });

  test('returns a scoped consent PDF for the portal patient', async () => {
    prisma.consentForm.findFirst.mockResolvedValue({
      id: 801,
      tenantId: 7,
      patientId: 50,
      serviceId: 12,
      templateName: 'Hair Transplant',
      signedPdfBlob: Buffer.from('%PDF-1.4 test'),
      signedPdfMime: 'application/pdf',
      patient: { id: 50, name: 'Patient' },
      service: { id: 12, name: 'Hair Transplant' },
    });

    const token = signPortalJwt({ patientId: 50 });
    const res = await request(makeApp())
      .get('/api/wellness/portal/consents/801/pdf')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(prisma.consentForm.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 801, patientId: 50, tenantId: 7 },
    }));
  });

  test('does not return a consent PDF belonging to another patient', async () => {
    prisma.consentForm.findFirst.mockResolvedValue(null);

    const token = signPortalJwt({ patientId: 50 });
    const res = await request(makeApp())
      .get('/api/wellness/portal/consents/999/pdf')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(prisma.consentForm.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 999, patientId: 50, tenantId: 7 },
    }));
  });

  test('returns a scoped PDF for a signed patient e-signature', async () => {
    prisma.signatureRequest.findFirst.mockResolvedValueOnce({
      id: 910,
      patientId: 50,
      visitId: 901,
      serviceIds: '[12]',
      documentName: 'Hair Transplant Consent',
      signedAt: new Date('2026-08-28T10:00:00.000Z'),
      signature: null,
    });
    prisma.patient.findFirst.mockResolvedValueOnce({ id: 50, name: 'Patient', email: 'patient@example.com', phone: '+919123456789' });
    prisma.visit.findFirst.mockResolvedValueOnce({
      id: 901,
      visitDate: new Date('2026-08-28T09:00:00.000Z'),
      serviceId: 12,
      service: { id: 12, name: 'Hair Transplant' },
    });
    prisma.service.findMany.mockResolvedValueOnce([{ id: 12, name: 'Hair Transplant' }]);

    const token = signPortalJwt({ patientId: 50 });
    const res = await request(makeApp())
      .get('/api/wellness/portal/signatures/910/pdf')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(prisma.signatureRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 910, patientId: 50, tenantId: 7, status: 'SIGNED' }),
    }));
  });
});
