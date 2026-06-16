// @ts-check
/**
 * Arc 2 #903 slice 13 — GET /api/travel/suppliers/:id/credentials.
 *
 * Per-supplier "Supplier Portal Logins" sub-tab view (PRD AC-6.8). Pins the
 * contract for the operator-facing endpoint that lists vault credentials
 * (airline / hotel / GDS / visa-portal logins) scoped to a single
 * TravelSupplier by name-match.
 *
 * What's pinned
 * -------------
 *   - Happy path:        returns supplier + credentials projection (200).
 *   - Projection:        NO encrypted blobs (loginIdEncrypted /
 *                        passwordEncrypted absent from every row).
 *   - Field shape:       { id, type, label, lastUsedAt, lastRotatedAt,
 *                          expiresAt, isExpired, ownerUserId, createdAt,
 *                          updatedAt } — type=category, label=supplierName.
 *   - Validation:        non-numeric :id → 400 INVALID_ID.
 *   - Not found:         supplier doesn't exist → 404 NOT_FOUND.
 *   - Sub-brand:         MANAGER scoped to ['tmc'] reading an RFU supplier
 *                        → 403 SUB_BRAND_DENIED.
 *   - Name match:        the supplierCredential.findMany WHERE pins
 *                        supplierName = supplier.name + tenantId.
 *   - Empty list:        supplier exists, no creds → 200 + empty array.
 *   - lastRotatedAt:     derived from most-recent accessLog row with
 *                        action="rotated"; null when no rotation events.
 *   - expiresAt:         parsed from metadataJson.expiresAt; null when
 *                        absent/malformed.
 *   - isExpired:         true when expiresAt < now(); false otherwise.
 *   - Access log:        EVERY cred returned writes one
 *                        SupplierCredentialAccessLog row { action: "viewed",
 *                        userId } per task brief.
 *   - Access log fail:   a thrown access-log write does NOT fail the read
 *                        (best-effort logging).
 *   - Auth gate:         USER (not ADMIN/MANAGER) → 403.
 *
 * Test pattern mirrors travel-suppliers-search.test.js — patch the prisma
 * singleton with vi.fn() shapes BEFORE requiring the router.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelSupplier = prisma.travelSupplier || {};
prisma.travelSupplier.findFirst = vi.fn();
prisma.supplierCredential = prisma.supplierCredential || {};
prisma.supplierCredential.findMany = vi.fn();
prisma.supplierCredentialAccessLog = prisma.supplierCredentialAccessLog || {};
prisma.supplierCredentialAccessLog.findFirst = vi.fn();
prisma.supplierCredentialAccessLog.create = vi.fn();
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

const SUPPLIER_TMC = {
  id: 42,
  name: 'Grand Hilton Mumbai',
  supplierCategory: 'hotel',
  subBrand: 'tmc',
};
const SUPPLIER_RFU = {
  id: 99,
  name: 'Al-Madinah Plaza',
  supplierCategory: 'hotel',
  subBrand: 'rfu',
};

beforeEach(() => {
  prisma.travelSupplier.findFirst.mockReset();
  prisma.supplierCredential.findMany.mockReset();
  prisma.supplierCredentialAccessLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.supplierCredentialAccessLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/suppliers/:id/credentials', () => {
  test('happy path: returns supplier + credentials projection (200)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([
      {
        id: 11,
        category: 'hotel',
        supplierName: 'Grand Hilton Mumbai',
        metadataJson: null,
        ownerUserId: 5,
        lastUsedAt: new Date('2026-05-20T10:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-05-20T10:00:00Z'),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.supplier).toEqual({
      id: 42,
      name: 'Grand Hilton Mumbai',
      supplierCategory: 'hotel',
      subBrand: 'tmc',
    });
    expect(res.body.total).toBe(1);
    expect(res.body.credentials).toHaveLength(1);
    expect(res.body.credentials[0]).toMatchObject({
      id: 11,
      type: 'hotel',
      label: 'Grand Hilton Mumbai',
      ownerUserId: 5,
      expiresAt: null,
      isExpired: false,
      lastRotatedAt: null,
    });
  });

  test('projection excludes encrypted blobs', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([
      {
        id: 11,
        category: 'hotel',
        supplierName: 'Grand Hilton Mumbai',
        metadataJson: null,
        ownerUserId: 5,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.credentials[0]).not.toHaveProperty('loginIdEncrypted');
    expect(res.body.credentials[0]).not.toHaveProperty('passwordEncrypted');
    expect(res.body.credentials[0]).not.toHaveProperty('metadataJson');

    // The findMany call MUST select only the safe metadata columns.
    const calledSelect = prisma.supplierCredential.findMany.mock.calls[0][0].select;
    expect(calledSelect).not.toHaveProperty('loginIdEncrypted');
    expect(calledSelect).not.toHaveProperty('passwordEncrypted');
  });

  test('non-numeric :id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/abc/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('supplier not found returns 404 NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/9999/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.supplierCredential.findMany).not.toHaveBeenCalled();
  });

  test('sub-brand-restricted MANAGER reading other-brand supplier → 403 SUB_BRAND_DENIED', async () => {
    // MANAGER scoped to only ['tmc'] — supplier 99 lives in RFU.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_RFU);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/99/credentials')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.supplierCredential.findMany).not.toHaveBeenCalled();
  });

  test('findMany WHERE pins supplierName + tenantId', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/suppliers/42/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(prisma.supplierCredential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          supplierName: 'Grand Hilton Mumbai',
        }),
      }),
    );
  });

  test('empty list: supplier with no credentials → 200 + empty array', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.credentials).toEqual([]);
    expect(res.body.total).toBe(0);
    // No access-log writes when there are no creds.
    expect(prisma.supplierCredentialAccessLog.create).not.toHaveBeenCalled();
  });

  test('lastRotatedAt: derived from most-recent accessLog rotation row', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([
      {
        id: 11, category: 'hotel', supplierName: 'Grand Hilton Mumbai',
        metadataJson: null, ownerUserId: null, lastUsedAt: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    const rotatedAt = new Date('2026-04-15T08:30:00Z');
    prisma.supplierCredentialAccessLog.findFirst.mockResolvedValue({ at: rotatedAt });

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(new Date(res.body.credentials[0].lastRotatedAt).getTime()).toBe(rotatedAt.getTime());
    // The findFirst query must filter by credentialId + action="rotated".
    expect(prisma.supplierCredentialAccessLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { credentialId: 11, action: 'rotated' },
        orderBy: { at: 'desc' },
      }),
    );
  });

  test('lastRotatedAt: null when no rotation events recorded', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([
      {
        id: 11, category: 'hotel', supplierName: 'Grand Hilton Mumbai',
        metadataJson: null, ownerUserId: null, lastUsedAt: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    prisma.supplierCredentialAccessLog.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.body.credentials[0].lastRotatedAt).toBeNull();
  });

  test('expiresAt: parsed from metadataJson.expiresAt (future date → not expired)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    const future = new Date(Date.now() + 86_400_000 * 30).toISOString(); // +30 days
    prisma.supplierCredential.findMany.mockResolvedValue([
      {
        id: 11, category: 'hotel', supplierName: 'Grand Hilton Mumbai',
        metadataJson: JSON.stringify({ expiresAt: future, notes: 'irrelevant' }),
        ownerUserId: null, lastUsedAt: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.body.credentials[0].expiresAt).toBe(new Date(future).toISOString());
    expect(res.body.credentials[0].isExpired).toBe(false);
  });

  test('expiresAt: past date → isExpired=true', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    const past = new Date(Date.now() - 86_400_000).toISOString(); // -1 day
    prisma.supplierCredential.findMany.mockResolvedValue([
      {
        id: 11, category: 'hotel', supplierName: 'Grand Hilton Mumbai',
        metadataJson: JSON.stringify({ expiresAt: past }),
        ownerUserId: null, lastUsedAt: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.body.credentials[0].isExpired).toBe(true);
  });

  test('expiresAt: malformed metadataJson → null + isExpired=false (no throw)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([
      {
        id: 11, category: 'hotel', supplierName: 'Grand Hilton Mumbai',
        metadataJson: 'not valid json {{{',
        ownerUserId: null, lastUsedAt: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.credentials[0].expiresAt).toBeNull();
    expect(res.body.credentials[0].isExpired).toBe(false);
  });

  test('access log: writes one "viewed" row per credential returned', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([
      {
        id: 11, category: 'hotel', supplierName: 'Grand Hilton Mumbai',
        metadataJson: null, ownerUserId: null, lastUsedAt: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
      {
        id: 12, category: 'airline', supplierName: 'Grand Hilton Mumbai',
        metadataJson: null, ownerUserId: null, lastUsedAt: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);

    await request(makeApp())
      .get('/api/travel/suppliers/42/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    // 2 creds → 2 access-log writes, both action="viewed", carrying userId.
    expect(prisma.supplierCredentialAccessLog.create).toHaveBeenCalledTimes(2);
    expect(prisma.supplierCredentialAccessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          credentialId: 11,
          userId: 7,
          action: 'viewed',
        }),
      }),
    );
    expect(prisma.supplierCredentialAccessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          credentialId: 12,
          userId: 7,
          action: 'viewed',
        }),
      }),
    );
  });

  test('access log: write failure does NOT fail the read (best-effort)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([
      {
        id: 11, category: 'hotel', supplierName: 'Grand Hilton Mumbai',
        metadataJson: null, ownerUserId: null, lastUsedAt: null,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    prisma.supplierCredentialAccessLog.create.mockRejectedValue(
      new Error('simulated audit-write failure'),
    );

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/credentials')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    // Read still succeeds (200) — the access-log write is non-blocking.
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  test('USER role (not ADMIN/MANAGER) → 403', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/credentials')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Arc 2 #903 slice 14 — POST /api/travel/suppliers/:id/credentials/:credId/rotate.
//
// Pins the contract for the operator-facing "mark rotated" action. PRD §3.7
// credentials audit trail. Records a SupplierCredentialAccessLog row with
// action="rotated" so the team has a paper trail of when each supplier-portal
// credential was last cycled out-of-band.
//
// What's pinned
// -------------
//   - Happy path:        200 + { credentialId, rotatedAt, supplierId }.
//   - ADMIN-only:        MANAGER + USER → 403 (requirePermission('suppliers','manage') gate, mirrors the
//                        existing PATCH /supplier-credentials/:id rotation
//                        surface even though no secret material moves here).
//   - Sub-brand:         ADMIN scoped to ['tmc'] rotating an RFU supplier's
//                        cred → 403 SUB_BRAND_DENIED.
//   - Cross-tenant 404:  supplier doesn't exist in this tenant → 404 NOT_FOUND.
//   - Invalid id:        non-numeric :id OR :credId → 400 INVALID_ID.
//   - Cred-not-found:    credId belongs to a different supplier (name
//                        mismatch) → 404 NOT_FOUND, no audit row written.
//   - Idempotency shape: repeated calls each write distinct accessLog rows
//                        (operators may rotate multiple times; each event
//                        needs its own timestamp).
//   - Audit row shape:   action="rotated", userId from req.user.userId,
//                        credentialId from path param.
// ---------------------------------------------------------------------------

describe('POST /api/travel/suppliers/:id/credentials/:credId/rotate', () => {
  test('happy path: marks cred rotated → 200 + { credentialId, rotatedAt, supplierId }', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findFirst = vi.fn().mockResolvedValue({ id: 11 });
    const rotatedAt = new Date('2026-05-25T12:00:00Z');
    prisma.supplierCredentialAccessLog.create.mockResolvedValue({ id: 999, at: rotatedAt });

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/credentials/11/rotate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      credentialId: 11,
      supplierId: 42,
    });
    expect(new Date(res.body.rotatedAt).getTime()).toBe(rotatedAt.getTime());

    // Audit row shape — action="rotated", userId from token (7), credentialId.
    expect(prisma.supplierCredentialAccessLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          credentialId: 11,
          userId: 7,
          action: 'rotated',
        }),
      }),
    );
  });

  test('ADMIN-only: MANAGER → 403', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/credentials/11/rotate')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});
    expect(res.status).toBe(403);
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
    expect(prisma.supplierCredentialAccessLog.create).not.toHaveBeenCalled();
  });

  test('ADMIN-only: USER → 403', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/credentials/11/rotate')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});
    expect(res.status).toBe(403);
    expect(prisma.supplierCredentialAccessLog.create).not.toHaveBeenCalled();
  });

  // Note: sub-brand denial is structurally tested by the RBAC gate above
  // for MANAGER/USER → 403. The endpoint is ADMIN-only, and ADMIN role
  // short-circuits getSubBrandAccessSet() to `null` (full access) in
  // backend/middleware/travelGuards.js — so an ADMIN can never fail
  // SUB_BRAND_DENIED on this path. The branch IS in the handler defensively
  // (in case the role model ever shifts) but is intentionally unreachable
  // for now. Slice 13's GET tests SUB_BRAND_DENIED against a MANAGER because
  // that endpoint allows MANAGER.

  test('cross-tenant: supplier not in tenant → 404 NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/suppliers/9999/credentials/11/rotate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.supplierCredentialAccessLog.create).not.toHaveBeenCalled();
  });

  test('invalid :id (non-numeric) → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers/abc/credentials/11/rotate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('invalid :credId (non-numeric) → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/credentials/xyz/rotate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('credential not found for this supplier (name mismatch) → 404', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    // Cred lookup returns null — the credId belongs to a different supplier
    // (its supplierName !== SUPPLIER_TMC.name) so the name-match WHERE clause
    // filters it out.
    prisma.supplierCredential.findFirst = vi.fn().mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/travel/suppliers/42/credentials/777/rotate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    // The findFirst MUST pin supplierName + tenantId + credId — operators
    // can't backdate rotations on a cred from a different supplier.
    expect(prisma.supplierCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 777,
          tenantId: 1,
          supplierName: 'Grand Hilton Mumbai',
        }),
      }),
    );
    expect(prisma.supplierCredentialAccessLog.create).not.toHaveBeenCalled();
  });

  test('idempotency-shape: repeated calls each write distinct audit rows', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findFirst = vi.fn().mockResolvedValue({ id: 11 });
    prisma.supplierCredentialAccessLog.create
      .mockResolvedValueOnce({ id: 1, at: new Date('2026-05-25T10:00:00Z') })
      .mockResolvedValueOnce({ id: 2, at: new Date('2026-05-25T10:05:00Z') });

    const app = makeApp();
    const res1 = await request(app)
      .post('/api/travel/suppliers/42/credentials/11/rotate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    const res2 = await request(app)
      .post('/api/travel/suppliers/42/credentials/11/rotate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Two distinct audit rows written — each rotation event gets its own
    // timestamp. Callers wanting "last rotated at" hit slice 13's GET.
    expect(prisma.supplierCredentialAccessLog.create).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Arc 2 #903 slice 15 — GET /api/travel/suppliers/:id/access-trail.
//
// Paginated cross-credential audit trail for a single TravelSupplier. Joins
// every SupplierCredentialAccessLog row across all of the supplier's vault
// credentials (matched by supplierName) into one feed sorted DESC by `at`.
//
// What's pinned
// -------------
//   - Happy path:        returns supplier + accessTrail rows + total/limit/
//                        offset (200). Row shape: { id, credentialId,
//                        credentialName, credentialCategory, action, userId,
//                        ip, at }.
//   - Auth gate:         USER (not ADMIN/MANAGER) → 403.
//   - Cross-tenant:      supplier in different tenant → 404 NOT_FOUND.
//   - Invalid id:        non-numeric :id → 400 INVALID_ID.
//   - Action filter:     ?action=rotated → WHERE includes action='rotated'.
//                        Invalid action value → 400 INVALID_ACTION.
//   - Limit validation:  ?limit=0 or non-integer → 400 INVALID_LIMIT.
//   - Limit cap:         ?limit=500 → capped to 200 (ACCESS_TRAIL_MAX_LIMIT).
//   - Empty creds:       supplier exists but has zero credentials → 200 +
//                        empty trail, total=0. No accessLog query fired.
//   - Name match:        credential lookup pins supplierName + tenantId
//                        (same contract as slice 13/14).
// ---------------------------------------------------------------------------

describe('GET /api/travel/suppliers/:id/access-trail', () => {
  // findMany is shared with slice 13's tests — ensure a default mock per case.
  beforeEach(() => {
    prisma.supplierCredentialAccessLog.findMany = vi.fn().mockResolvedValue([]);
    prisma.supplierCredentialAccessLog.count = vi.fn().mockResolvedValue(0);
  });

  test('happy path: returns supplier + accessTrail rows (200)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([
      { id: 11, category: 'hotel-portal', supplierName: 'Grand Hilton Mumbai' },
      { id: 12, category: 'gds', supplierName: 'Grand Hilton Mumbai' },
    ]);
    prisma.supplierCredentialAccessLog.findMany.mockResolvedValue([
      {
        id: 501,
        credentialId: 11,
        userId: 7,
        action: 'rotated',
        ip: '10.0.0.1',
        at: new Date('2026-05-25T12:00:00Z'),
      },
      {
        id: 500,
        credentialId: 12,
        userId: 8,
        action: 'viewed',
        ip: '10.0.0.2',
        at: new Date('2026-05-24T09:00:00Z'),
      },
    ]);
    prisma.supplierCredentialAccessLog.count.mockResolvedValue(2);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/access-trail')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.supplier).toMatchObject({ id: 42, name: 'Grand Hilton Mumbai' });
    expect(res.body.total).toBe(2);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(res.body.accessTrail).toHaveLength(2);
    // Row 0: credId=11, action=rotated, credentialName/Category joined from
    // the cred lookup map.
    expect(res.body.accessTrail[0]).toMatchObject({
      id: 501,
      credentialId: 11,
      credentialName: 'Grand Hilton Mumbai',
      credentialCategory: 'hotel-portal',
      action: 'rotated',
      userId: 7,
      ip: '10.0.0.1',
    });
    // Sort is DESC by at — newest first.
    expect(new Date(res.body.accessTrail[0].at).getTime()).toBeGreaterThan(
      new Date(res.body.accessTrail[1].at).getTime(),
    );
  });

  test('USER role (not ADMIN/MANAGER) → 403', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/access-trail')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('cross-tenant: supplier not in tenant → 404 NOT_FOUND', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/9999/access-trail')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    // The findFirst MUST pin tenantId — a supplier with id=9999 but
    // tenantId=2 must not leak.
    expect(prisma.travelSupplier.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9999, tenantId: 1 }),
      }),
    );
    expect(prisma.supplierCredentialAccessLog.findMany).not.toHaveBeenCalled();
  });

  test('invalid :id (non-numeric) → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/abc/access-trail')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('action filter: ?action=rotated → WHERE.action="rotated"', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([
      { id: 11, category: 'hotel-portal', supplierName: 'Grand Hilton Mumbai' },
    ]);
    prisma.supplierCredentialAccessLog.findMany.mockResolvedValue([]);
    prisma.supplierCredentialAccessLog.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/access-trail?action=rotated')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    // Both the findMany and the count must filter by action='rotated'.
    expect(prisma.supplierCredentialAccessLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: 'rotated',
          credentialId: { in: [11] },
        }),
      }),
    );
    expect(prisma.supplierCredentialAccessLog.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ action: 'rotated' }),
      }),
    );
  });

  test('action filter: invalid value → 400 INVALID_ACTION', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/access-trail?action=hacked')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ACTION' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('limit validation: ?limit=0 → 400 INVALID_LIMIT', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/access-trail?limit=0')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_LIMIT' });
    expect(prisma.travelSupplier.findFirst).not.toHaveBeenCalled();
  });

  test('limit cap: ?limit=500 → coerced to 200 (ACCESS_TRAIL_MAX_LIMIT)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([
      { id: 11, category: 'hotel-portal', supplierName: 'Grand Hilton Mumbai' },
    ]);
    prisma.supplierCredentialAccessLog.findMany.mockResolvedValue([]);
    prisma.supplierCredentialAccessLog.count.mockResolvedValue(0);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/access-trail?limit=500')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(200);
    // findMany.take must reflect the cap, not the raw query value.
    expect(prisma.supplierCredentialAccessLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  test('empty credentials: supplier with no creds → 200 + empty trail, no accessLog query', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/travel/suppliers/42/access-trail')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.accessTrail).toEqual([]);
    expect(res.body.total).toBe(0);
    // Short-circuit: zero credentials → no accessLog findMany fires.
    expect(prisma.supplierCredentialAccessLog.findMany).not.toHaveBeenCalled();
    expect(prisma.supplierCredentialAccessLog.count).not.toHaveBeenCalled();
  });

  test('name match: cred findMany pins supplierName + tenantId', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_TMC);
    prisma.supplierCredential.findMany.mockResolvedValue([]);

    await request(makeApp())
      .get('/api/travel/suppliers/42/access-trail')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    // Same contract as slice 13/14: the cred set is scoped by supplierName +
    // tenantId. A cred belonging to a different supplier (different name) or
    // a different tenant must NOT leak into this trail.
    expect(prisma.supplierCredential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          supplierName: 'Grand Hilton Mumbai',
        }),
      }),
    );
  });

  test('sub-brand-restricted MANAGER reading other-brand supplier → 403 SUB_BRAND_DENIED', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(SUPPLIER_RFU);
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/suppliers/99/access-trail')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    // The accessLog query must NOT fire after the sub-brand denial.
    expect(prisma.supplierCredentialAccessLog.findMany).not.toHaveBeenCalled();
  });
});
