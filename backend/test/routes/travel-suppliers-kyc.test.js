// @ts-check
/**
 * G038 — Supplier KYC + onboarding checklist (PRD_TRAVEL_SUPPLIER_MASTER FR-3.1.h).
 *
 * Pins the contract for the operator-facing KYC endpoints under
 * /api/travel/suppliers/:id/kyc[...]
 *
 * What's pinned
 * -------------
 *   - GET happy path: returns kyc + checklist (200).
 *   - GET no-kyc:     returns { kyc: null } (not 404).
 *   - POST happy:     creates KYC + seeds 6 default items (incl. iata_cert
 *                     only when supplier.supplierCategory='flight').
 *   - POST idempotent:re-calling returns alreadyInitialised=true and does
 *                     NOT create duplicate items.
 *   - PUT panNumber:  invalid PAN format → 400 INVALID_PAN.
 *   - PUT panNumber:  encrypts via fieldEncryption before persist (we don't
 *                     pin the encryption surface — just verify panNumber is
 *                     written and the response masks).
 *   - SUBMIT:         pending → submitted; verified → 409.
 *   - VERIFY:         only from submitted; MANAGER → 403; ADMIN OK.
 *   - REJECT:         requires rejectionReason; only from submitted; MANAGER → 403.
 *   - Checklist PUT:  verify status requires ADMIN; MANAGER can't set verified.
 *   - Sub-brand gate: MANAGER scoped to ['tmc'] reading an RFU supplier → 403.
 *   - Auth gate:      USER (not ADMIN/MANAGER) → 403.
 *
 * Pattern mirrors backend/test/routes/travel-suppliers-credentials.test.js —
 * patch prisma singleton with vi.fn() shapes BEFORE requiring the router.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelSupplier = prisma.travelSupplier || {};
prisma.travelSupplier.findFirst = vi.fn();
prisma.travelSupplierKyc = prisma.travelSupplierKyc || {};
prisma.travelSupplierKyc.findUnique = vi.fn();
prisma.travelSupplierKyc.create = vi.fn();
prisma.travelSupplierKyc.update = vi.fn();
prisma.travelSupplierKycChecklistItem = prisma.travelSupplierKycChecklistItem || {};
prisma.travelSupplierKycChecklistItem.findMany = vi.fn();
prisma.travelSupplierKycChecklistItem.findFirst = vi.fn();
prisma.travelSupplierKycChecklistItem.create = vi.fn();
prisma.travelSupplierKycChecklistItem.update = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const travelSuppliersRouter = requireCJS('../../routes/travel_suppliers');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelSuppliersRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const SUPPLIER_TMC_HOTEL = {
  id: 42,
  name: 'Grand Hilton Mumbai',
  supplierCategory: 'hotel',
  subBrand: 'tmc',
  tenantId: 1,
};
const SUPPLIER_TMC_FLIGHT = {
  id: 43,
  name: 'Indigo Airlines',
  supplierCategory: 'flight',
  subBrand: 'tmc',
  tenantId: 1,
};
const SUPPLIER_RFU = {
  id: 99,
  name: 'Al-Madinah Plaza',
  supplierCategory: 'hotel',
  subBrand: 'rfu',
  tenantId: 1,
};

beforeEach(() => {
  prisma.travelSupplier.findFirst.mockReset();
  prisma.travelSupplierKyc.findUnique.mockReset();
  prisma.travelSupplierKyc.create.mockReset();
  prisma.travelSupplierKyc.update.mockReset();
  prisma.travelSupplierKycChecklistItem.findMany.mockReset().mockResolvedValue([]);
  prisma.travelSupplierKycChecklistItem.findFirst.mockReset();
  prisma.travelSupplierKycChecklistItem.create.mockReset();
  prisma.travelSupplierKycChecklistItem.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/suppliers/:id/kyc', () => {
  test('returns kyc=null when none initialised', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/kyc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supplierId: 42, kyc: null });
  });

  test('returns kyc + checklist when initialised', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue({
      id: 100, supplierId: 42, status: 'submitted',
      panNumber: null, gstinVerified: true, bankAccountVerified: false,
      iataNumber: null, iataExpiry: null, tafiNumber: null,
      contractSigned: false, contractSignedAt: null, contractDocumentUrl: null,
      submittedAt: new Date('2026-06-10T00:00:00Z'),
      verifiedAt: null, verifiedBy: null,
      rejectedAt: null, rejectionReason: null,
      notes: null, createdAt: new Date(), updatedAt: new Date(),
    });
    prisma.travelSupplierKycChecklistItem.findMany.mockResolvedValue([
      { id: 1, itemKey: 'pan_card', itemLabel: 'PAN card', required: true, status: 'pending', sortOrder: 0 },
      { id: 2, itemKey: 'gstin_cert', itemLabel: 'GSTIN certificate', required: true, status: 'verified', sortOrder: 1 },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/kyc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.kyc.status).toBe('submitted');
    expect(res.body.kyc.gstinVerified).toBe(true);
    expect(res.body.kyc.checklistItems).toHaveLength(2);
    expect(res.body.kyc.panOnFile).toBe(false);
    expect(res.body.kyc.panNumberMasked).toBeNull();
  });

  test('non-numeric :id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/abc/kyc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('supplier not found returns 404 NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/9999/kyc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('sub-brand gate blocks MANAGER scoped to [tmc] reading rfu supplier', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_RFU);
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: JSON.stringify(['tmc']) });

    const res = await request(makeApp())
      .get('/api/travel/suppliers/99/kyc')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('USER role gets 403', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/kyc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/travel/suppliers/:id/kyc (init)', () => {
  test('hotel supplier seeds 6 default items (no iata_cert)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue(null);
    prisma.travelSupplierKyc.create.mockResolvedValue({
      id: 100, supplierId: 42, status: 'pending',
      panNumber: null, gstinVerified: false, bankAccountVerified: false,
      iataNumber: null, iataExpiry: null, tafiNumber: null,
      contractSigned: false, contractSignedAt: null, contractDocumentUrl: null,
      submittedAt: null, verifiedAt: null, verifiedBy: null,
      rejectedAt: null, rejectionReason: null, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    let nextId = 1;
    prisma.travelSupplierKycChecklistItem.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: nextId++, ...data, submittedAt: null, verifiedAt: null, verifiedBy: null, documentUrl: null, notes: null, status: 'pending' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/kyc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.kyc.status).toBe('pending');
    expect(res.body.kyc.checklistItems).toHaveLength(5);
    // Hotel supplier should not get iata_cert.
    const keys = res.body.kyc.checklistItems.map((i) => i.itemKey);
    expect(keys).toEqual(['pan_card', 'gstin_cert', 'bank_proof', 'contract', 'insurance']);
  });

  test('flight supplier adds iata_cert to seed (6 items total)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_FLIGHT);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue(null);
    prisma.travelSupplierKyc.create.mockResolvedValue({
      id: 101, supplierId: 43, status: 'pending',
      panNumber: null, gstinVerified: false, bankAccountVerified: false,
      iataNumber: null, iataExpiry: null, tafiNumber: null,
      contractSigned: false, contractSignedAt: null, contractDocumentUrl: null,
      submittedAt: null, verifiedAt: null, verifiedBy: null,
      rejectedAt: null, rejectionReason: null, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    let nextId = 10;
    prisma.travelSupplierKycChecklistItem.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: nextId++, ...data, submittedAt: null, verifiedAt: null, verifiedBy: null, documentUrl: null, notes: null, status: 'pending' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/suppliers/43/kyc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.kyc.checklistItems).toHaveLength(6);
    const keys = res.body.kyc.checklistItems.map((i) => i.itemKey);
    expect(keys).toContain('iata_cert');
  });

  test('idempotent: re-calling returns alreadyInitialised=true, no new items', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue({
      id: 100, supplierId: 42, status: 'pending',
      panNumber: null, gstinVerified: false, bankAccountVerified: false,
      iataNumber: null, iataExpiry: null, tafiNumber: null,
      contractSigned: false, contractSignedAt: null, contractDocumentUrl: null,
      submittedAt: null, verifiedAt: null, verifiedBy: null,
      rejectedAt: null, rejectionReason: null, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    prisma.travelSupplierKycChecklistItem.findMany.mockResolvedValue([
      { id: 1, itemKey: 'pan_card', itemLabel: 'PAN card', required: true, status: 'pending', sortOrder: 0 },
    ]);

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/kyc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.alreadyInitialised).toBe(true);
    expect(prisma.travelSupplierKyc.create).not.toHaveBeenCalled();
    expect(prisma.travelSupplierKycChecklistItem.create).not.toHaveBeenCalled();
  });
});

describe('PUT /api/travel/suppliers/:id/kyc (update)', () => {
  test('valid PAN persists via encrypt + returns mask on read', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    const initialKyc = {
      id: 100, supplierId: 42, status: 'pending',
      panNumber: null, gstinVerified: false, bankAccountVerified: false,
      iataNumber: null, iataExpiry: null, tafiNumber: null,
      contractSigned: false, contractSignedAt: null, contractDocumentUrl: null,
      submittedAt: null, verifiedAt: null, verifiedBy: null,
      rejectedAt: null, rejectionReason: null, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    prisma.travelSupplierKyc.findUnique.mockResolvedValue(initialKyc);
    prisma.travelSupplierKyc.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...initialKyc, ...data }),
    );

    const res = await request(makeApp())
      .put('/api/travel/suppliers/42/kyc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ panNumber: 'ABCDE1234F', gstinVerified: true });

    expect(res.status).toBe(200);
    expect(res.body.kyc.panOnFile).toBe(true);
    // Masked form: 'XXXXX' + last-4 (capped to 10 chars overall).
    expect(res.body.kyc.panNumberMasked).toMatch(/^XXXXX/);
    expect(res.body.kyc.gstinVerified).toBe(true);
    // The data passed to update must include panNumber (encrypted or raw,
    // but NOT undefined).
    const calledData = prisma.travelSupplierKyc.update.mock.calls[0][0].data;
    expect(calledData.panNumber).toBeDefined();
    expect(calledData.gstinVerified).toBe(true);
  });

  test('invalid PAN format returns 400 INVALID_PAN', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue({
      id: 100, supplierId: 42, status: 'pending',
      panNumber: null, gstinVerified: false, bankAccountVerified: false,
      iataNumber: null, iataExpiry: null, tafiNumber: null,
      contractSigned: false, contractSignedAt: null, contractDocumentUrl: null,
      submittedAt: null, verifiedAt: null, verifiedBy: null,
      rejectedAt: null, rejectionReason: null, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await request(makeApp())
      .put('/api/travel/suppliers/42/kyc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ panNumber: 'NOTAPAN' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAN');
  });

  test('PUT before init returns 404 KYC_NOT_INITIALISED', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/travel/suppliers/42/kyc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ gstinVerified: true });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('KYC_NOT_INITIALISED');
  });

  test('empty body returns 400 EMPTY_BODY', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue({
      id: 100, supplierId: 42, status: 'pending',
      panNumber: null, gstinVerified: false, bankAccountVerified: false,
      iataNumber: null, iataExpiry: null, tafiNumber: null,
      contractSigned: false, contractSignedAt: null, contractDocumentUrl: null,
      submittedAt: null, verifiedAt: null, verifiedBy: null,
      rejectedAt: null, rejectionReason: null, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await request(makeApp())
      .put('/api/travel/suppliers/42/kyc')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EMPTY_BODY');
  });
});

describe('State transitions (submit / verify / reject)', () => {
  function pendingKyc() {
    return {
      id: 100, supplierId: 42, status: 'pending',
      panNumber: null, gstinVerified: false, bankAccountVerified: false,
      iataNumber: null, iataExpiry: null, tafiNumber: null,
      contractSigned: false, contractSignedAt: null, contractDocumentUrl: null,
      submittedAt: null, verifiedAt: null, verifiedBy: null,
      rejectedAt: null, rejectionReason: null, notes: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
  }

  test('submit pending → submitted', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue(pendingKyc());
    prisma.travelSupplierKyc.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...pendingKyc(), ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/kyc/submit')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('submitted');
    expect(res.body.submittedAt).toBeTruthy();
  });

  test('submit already-verified → 409 INVALID_STATE_TRANSITION', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue({ ...pendingKyc(), status: 'verified' });

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/kyc/submit')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  test('verify requires ADMIN (MANAGER → 403)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    // MANAGER scoped to all sub-brands.
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/kyc/verify')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
  });

  test('verify ADMIN: submitted → verified', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue({ ...pendingKyc(), status: 'submitted' });
    prisma.travelSupplierKyc.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...pendingKyc(), status: 'submitted', ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/kyc/verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('verified');
    expect(res.body.verifiedAt).toBeTruthy();
    expect(res.body.verifiedBy).toBe(7);
  });

  test('verify from pending → 409', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue(pendingKyc());

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/kyc/verify')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  test('reject requires rejectionReason', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue({ ...pendingKyc(), status: 'submitted' });

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/kyc/reject')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_FIELDS');
  });

  test('reject ADMIN: submitted → rejected with reason', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue({ ...pendingKyc(), status: 'submitted' });
    prisma.travelSupplierKyc.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...pendingKyc(), status: 'submitted', ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/kyc/reject')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ rejectionReason: 'Bank proof unclear' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.rejectionReason).toBe('Bank proof unclear');
  });
});

describe('PUT /api/travel/suppliers/:id/kyc/checklist/:itemId', () => {
  test('MANAGER can submit items but NOT verify (verify → 403 ADMIN_REQUIRED)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    prisma.travelSupplierKyc.findUnique.mockResolvedValue({ id: 100, supplierId: 42 });
    prisma.travelSupplierKycChecklistItem.findFirst.mockResolvedValue({
      id: 1, itemKey: 'pan_card', itemLabel: 'PAN card', required: true,
      status: 'pending', kycId: 100, sortOrder: 0, documentUrl: null, notes: null,
      submittedAt: null, verifiedAt: null, verifiedBy: null,
    });

    const res = await request(makeApp())
      .put('/api/travel/suppliers/42/kyc/checklist/1')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ status: 'verified' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });

  test('ADMIN verify: sets verifiedAt + verifiedBy', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue({ id: 100, supplierId: 42 });
    prisma.travelSupplierKycChecklistItem.findFirst.mockResolvedValue({
      id: 1, itemKey: 'pan_card', itemLabel: 'PAN card', required: true,
      status: 'submitted', kycId: 100, sortOrder: 0, documentUrl: 'http://x', notes: null,
      submittedAt: new Date(), verifiedAt: null, verifiedBy: null,
    });
    prisma.travelSupplierKycChecklistItem.update.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 1, itemKey: 'pan_card', itemLabel: 'PAN card', required: true,
        kycId: 100, sortOrder: 0, documentUrl: 'http://x', notes: null,
        submittedAt: new Date(), status: 'pending', verifiedAt: null, verifiedBy: null, ...data,
      }),
    );

    const res = await request(makeApp())
      .put('/api/travel/suppliers/42/kyc/checklist/1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'verified' });

    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('verified');
    expect(res.body.item.verifiedAt).toBeTruthy();
    expect(res.body.item.verifiedBy).toBe(7);
  });

  test('invalid status returns 400 INVALID_STATUS', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue({ id: 100, supplierId: 42 });
    prisma.travelSupplierKycChecklistItem.findFirst.mockResolvedValue({
      id: 1, itemKey: 'pan_card', kycId: 100, status: 'pending',
    });

    const res = await request(makeApp())
      .put('/api/travel/suppliers/42/kyc/checklist/1')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'wat' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATUS');
  });

  test('checklist item not found returns 404', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC_HOTEL);
    prisma.travelSupplierKyc.findUnique.mockResolvedValue({ id: 100, supplierId: 42 });
    prisma.travelSupplierKycChecklistItem.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/travel/suppliers/42/kyc/checklist/999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'submitted' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
