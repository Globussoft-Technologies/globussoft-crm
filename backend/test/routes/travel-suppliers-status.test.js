// @ts-check
/**
 * PRD_TRAVEL_SUPPLIER_MASTER G040/G041/G042/G043 — supplier governance.
 *
 * Pins the contract for the new surfaces added to routes/travel_suppliers.js:
 *
 *   G040 — status enum (active | paused | blocked_disputed | archived):
 *          - POST + PUT accept `status` with whitelist validation; invalid
 *            value returns 400 INVALID_STATUS.
 *          - POST /suppliers/:id/pause       — ADMIN/MANAGER
 *          - POST /suppliers/:id/block       — ADMIN, body.reason required
 *          - POST /suppliers/:id/archive     — ADMIN
 *          - POST /suppliers/:id/reactivate  — ADMIN
 *          - Every transition syncs isActive (active → true; other → false)
 *            so the existing default list filter (?includeInactive=0) keeps
 *            archived/blocked suppliers hidden.
 *
 *   G041 — paymentTermsKind enum (net | prepay | on_departure | on_arrival):
 *          - POST + PUT accept `paymentTermsKind`; invalid → 400
 *            INVALID_PAYMENT_TERMS_KIND.
 *          - kind != "net" auto-nulls paymentTermsDays on write.
 *
 *   G043 — GET /suppliers/:id/credit-status:
 *          - Returns { current, limit, utilizationPct, status, currency }.
 *          - 3-band status: ok / warning / exceeded.
 *          - 404 on unknown id; 400 on non-numeric id.
 *
 * Test pattern mirrors travel_suppliers.test.js — patch prisma singleton
 * with vi.fn() shapes BEFORE requiring the router; drive supertest with
 * real HS256 JWTs.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelSupplier = prisma.travelSupplier || {};
prisma.travelSupplier.findFirst = vi.fn();
prisma.travelSupplier.findMany = vi.fn();
prisma.travelSupplier.count = vi.fn();
prisma.travelSupplier.create = vi.fn();
prisma.travelSupplier.update = vi.fn();
prisma.travelSupplierPayable = prisma.travelSupplierPayable || {};
prisma.travelSupplierPayable.aggregate = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
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

beforeEach(() => {
  prisma.travelSupplier.findFirst.mockReset();
  prisma.travelSupplier.findMany.mockReset();
  prisma.travelSupplier.count.mockReset();
  prisma.travelSupplier.create.mockReset();
  prisma.travelSupplier.update.mockReset();
  prisma.travelSupplierPayable.aggregate.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
});

// ─── G040 — status enum on POST + PUT ─────────────────────────────────

describe('G040 — POST /api/travel/suppliers status enum', () => {
  test('accepts status=paused; persists to data and derives isActive=false', async () => {
    prisma.travelSupplier.create.mockResolvedValue({
      id: 1, tenantId: 1, name: 'Paused Co', subBrand: 'tmc',
      status: 'paused', isActive: false,
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Paused Co', subBrand: 'tmc', status: 'paused' });
    expect(res.status).toBe(201);
    expect(prisma.travelSupplier.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'paused',
          isActive: false,
        }),
      }),
    );
  });

  test('default status=active; isActive=true', async () => {
    prisma.travelSupplier.create.mockResolvedValue({
      id: 2, tenantId: 1, name: 'Active Co', subBrand: 'tmc',
      status: 'active', isActive: true,
    });
    await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Active Co', subBrand: 'tmc' });
    expect(prisma.travelSupplier.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'active', isActive: true }),
      }),
    );
  });

  test('invalid status returns 400 INVALID_STATUS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Bad Status', subBrand: 'tmc', status: 'frozen' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.travelSupplier.create).not.toHaveBeenCalled();
  });
});

describe('G040 — PUT /api/travel/suppliers/:id status enum', () => {
  test('PUT status=archived derives isActive=false', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 9, tenantId: 1, name: 'Co', subBrand: 'tmc', status: 'active', isActive: true,
    });
    prisma.travelSupplier.update.mockResolvedValue({
      id: 9, tenantId: 1, name: 'Co', subBrand: 'tmc', status: 'archived', isActive: false,
    });
    const res = await request(makeApp())
      .put('/api/travel/suppliers/9')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'archived' });
    expect(res.status).toBe(200);
    expect(prisma.travelSupplier.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: expect.objectContaining({ status: 'archived', isActive: false }),
    });
  });

  test('PUT invalid status returns 400 INVALID_STATUS', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 9, tenantId: 1, name: 'Co', subBrand: 'tmc',
    });
    const res = await request(makeApp())
      .put('/api/travel/suppliers/9')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'frozen' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(prisma.travelSupplier.update).not.toHaveBeenCalled();
  });
});

// ─── G040 — state-transition endpoints ────────────────────────────────

describe('G040 — POST /suppliers/:id/pause', () => {
  test('happy path 200; status flips to paused; isActive=false', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, name: 'X', subBrand: 'tmc', status: 'active', isActive: true,
    });
    prisma.travelSupplier.update.mockResolvedValue({
      id: 10, tenantId: 1, name: 'X', subBrand: 'tmc', status: 'paused', isActive: false,
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/10/pause')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'paused', isActive: false });
    expect(prisma.travelSupplier.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { status: 'paused', isActive: false },
    });
  });

  test('USER cannot pause (403)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers/10/pause')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('404 when supplier missing', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/suppliers/999/pause')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(404);
  });
});

describe('G040 — POST /suppliers/:id/block (ADMIN, reason required)', () => {
  test('happy path 200 with reason; persists status=blocked_disputed', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, name: 'Dispute Co', subBrand: 'tmc', status: 'active', isActive: true,
    });
    prisma.travelSupplier.update.mockResolvedValue({
      id: 11, status: 'blocked_disputed', isActive: false, name: 'Dispute Co', subBrand: 'tmc',
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/11/block')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ reason: 'Chargeback under review' });
    expect(res.status).toBe(200);
    expect(prisma.travelSupplier.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { status: 'blocked_disputed', isActive: false },
    });
  });

  test('block without reason returns 400 MISSING_FIELDS', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 11, tenantId: 1, name: 'Co', subBrand: 'tmc', status: 'active', isActive: true,
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/11/block')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(prisma.travelSupplier.update).not.toHaveBeenCalled();
  });

  test('MANAGER cannot block (403; ADMIN-only)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers/11/block')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ reason: 'r' });
    expect(res.status).toBe(403);
  });
});

describe('G040 — POST /suppliers/:id/archive + /reactivate', () => {
  test('archive flips to archived + isActive=false (ADMIN)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 12, tenantId: 1, name: 'Old Co', subBrand: 'tmc', status: 'paused', isActive: false,
    });
    prisma.travelSupplier.update.mockResolvedValue({
      id: 12, status: 'archived', isActive: false, name: 'Old Co', subBrand: 'tmc',
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/12/archive')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('archived');
  });

  test('reactivate flips back to active + isActive=true (from any non-active)', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 13, tenantId: 1, name: 'Back Co', subBrand: 'tmc',
      status: 'blocked_disputed', isActive: false,
    });
    prisma.travelSupplier.update.mockResolvedValue({
      id: 13, status: 'active', isActive: true, name: 'Back Co', subBrand: 'tmc',
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers/13/reactivate')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(prisma.travelSupplier.update).toHaveBeenCalledWith({
      where: { id: 13 },
      data: { status: 'active', isActive: true },
    });
  });

  test('archived suppliers hidden from default list (isActive=true filter)', async () => {
    prisma.travelSupplier.findMany.mockResolvedValue([
      { id: 1, name: 'Active', isActive: true, status: 'active' },
    ]);
    prisma.travelSupplier.count.mockResolvedValue(1);
    const res = await request(makeApp())
      .get('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(prisma.travelSupplier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
      }),
    );
  });
});

// ─── G041 — paymentTermsKind enum ─────────────────────────────────────

describe('G041 — paymentTermsKind on POST + PUT', () => {
  test('valid kind=prepay persists; paymentTermsDays auto-nulled', async () => {
    prisma.travelSupplier.create.mockResolvedValue({
      id: 20, tenantId: 1, name: 'Prepay Co', subBrand: 'tmc',
      paymentTermsKind: 'prepay', paymentTermsDays: null,
    });
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Prepay Co', subBrand: 'tmc', paymentTermsKind: 'prepay', paymentTermsDays: 30 });
    expect(res.status).toBe(201);
    expect(prisma.travelSupplier.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentTermsKind: 'prepay',
          paymentTermsDays: null, // auto-nulled because kind != "net"
        }),
      }),
    );
  });

  test('kind=net persists paymentTermsDays as N', async () => {
    prisma.travelSupplier.create.mockResolvedValue({
      id: 21, tenantId: 1, name: 'NET45 Co', subBrand: 'tmc',
      paymentTermsKind: 'net', paymentTermsDays: 45,
    });
    await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'NET45 Co', subBrand: 'tmc', paymentTermsKind: 'net', paymentTermsDays: 45 });
    expect(prisma.travelSupplier.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentTermsKind: 'net',
          paymentTermsDays: 45,
        }),
      }),
    );
  });

  test('invalid kind returns 400 INVALID_PAYMENT_TERMS_KIND', async () => {
    const res = await request(makeApp())
      .post('/api/travel/suppliers')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ name: 'Bad', subBrand: 'tmc', paymentTermsKind: 'cash_on_delivery' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PAYMENT_TERMS_KIND' });
    expect(prisma.travelSupplier.create).not.toHaveBeenCalled();
  });

  test('PUT switching kind from net → on_departure auto-nulls days', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 22, tenantId: 1, subBrand: 'tmc',
      paymentTermsKind: 'net', paymentTermsDays: 30,
    });
    prisma.travelSupplier.update.mockResolvedValue({ id: 22 });
    await request(makeApp())
      .put('/api/travel/suppliers/22')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ paymentTermsKind: 'on_departure' });
    expect(prisma.travelSupplier.update).toHaveBeenCalledWith({
      where: { id: 22 },
      data: expect.objectContaining({
        paymentTermsKind: 'on_departure',
        paymentTermsDays: null,
      }),
    });
  });
});

// ─── G043 — credit-status endpoint ────────────────────────────────────

describe('G043 — GET /suppliers/:id/credit-status', () => {
  test('returns ok band when utilization < 80%', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue({
      id: 30, subBrand: 'tmc', creditCurrency: 'INR',
    });
    prisma.travelSupplierPayable.aggregate.mockResolvedValue({ _sum: { amount: '40000' } });
    // findFirst inside the helper for the supplier + limit
    prisma.travelSupplier.findFirst.mockResolvedValueOnce({
      id: 30, subBrand: 'tmc', creditCurrency: 'INR',
    }).mockResolvedValueOnce({
      id: 30, creditLimit: '100000',
    });
    const res = await request(makeApp())
      .get('/api/travel/suppliers/30/credit-status')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      supplierId: 30,
      current: 40_000,
      limit: 100_000,
      status: 'ok',
      currency: 'INR',
    });
  });

  test('returns warning band when 80% ≤ utilization < 100%', async () => {
    prisma.travelSupplier.findFirst
      .mockResolvedValueOnce({ id: 31, subBrand: 'tmc', creditCurrency: 'INR' })
      .mockResolvedValueOnce({ id: 31, creditLimit: '100000' });
    prisma.travelSupplierPayable.aggregate.mockResolvedValue({ _sum: { amount: '85000' } });
    const res = await request(makeApp())
      .get('/api/travel/suppliers/31/credit-status')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('warning');
    expect(res.body.utilizationPct).toBe(85);
  });

  test('returns exceeded band when utilization ≥ 100%', async () => {
    prisma.travelSupplier.findFirst
      .mockResolvedValueOnce({ id: 32, subBrand: 'tmc', creditCurrency: 'INR' })
      .mockResolvedValueOnce({ id: 32, creditLimit: '100000' });
    prisma.travelSupplierPayable.aggregate.mockResolvedValue({ _sum: { amount: '120000' } });
    const res = await request(makeApp())
      .get('/api/travel/suppliers/32/credit-status')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('exceeded');
    expect(res.body.current).toBe(120_000);
  });

  test('returns Cache-Control header for 60-second caching', async () => {
    prisma.travelSupplier.findFirst
      .mockResolvedValueOnce({ id: 33, subBrand: 'tmc', creditCurrency: 'INR' })
      .mockResolvedValueOnce({ id: 33, creditLimit: null });
    prisma.travelSupplierPayable.aggregate.mockResolvedValue({ _sum: { amount: null } });
    const res = await request(makeApp())
      .get('/api/travel/suppliers/33/credit-status')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/max-age=60/);
  });

  test('404 when supplier not found', async () => {
    prisma.travelSupplier.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/suppliers/9999/credit-status')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  test('400 on non-numeric id', async () => {
    const res = await request(makeApp())
      .get('/api/travel/suppliers/abc/credit-status')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
  });
});
