// @ts-check
/**
 * Arc 2 #901 slice 11 — TravelInvoice doc-type taxonomy contract.
 *
 * Pins the additive `docType` field added to TravelInvoice per
 * PRD_TRAVEL_BILLING FR-3.x. Enum:
 *   Proforma | TaxInvoice | CreditNote | DebitNote | TravelVoucher.
 *
 * The schema column is nullable with a default of "TaxInvoice" — new rows
 * pick up the default unless the caller overrides; pre-slice-11 historical
 * rows stay NULL until updated and are treated by the route layer as
 * "TaxInvoice" semantically.
 *
 * Separate CreditNote / DebitNote workflows (their own sequence prefix,
 * own PDF template, supplier-payable reversal side effects) are deferred
 * to slice 12. This slice ships the field + enum validation + GET list
 * filter only.
 *
 * Mirrors backend/test/routes/travel-invoice-issue.test.js (commit b25e7d0e)
 * and backend/test/routes/travel-invoice-tcs-persistence.test.js (commit
 * 8d5d67ae) — same prisma-singleton-patch + supertest pattern, same JWT
 * signing.
 *
 * Contracts asserted (10 cases):
 *   1. POST with docType="Proforma" → 201, value persisted to create data.
 *   2. POST with docType omitted → 201, create data does NOT pass docType
 *      (Prisma applies the schema default "TaxInvoice" server-side).
 *   3. POST with docType="" empty string → coerced to default (not in data).
 *   4. POST with docType="Invalid" → 400 INVALID_DOC_TYPE.
 *   5. POST with each of the 5 valid values → 201 (rounds out enum).
 *   6. GET ?docType=CreditNote → list filtered (where.docType passed to
 *      prisma.travelInvoice.findMany).
 *   7. GET ?docType=Invalid → 400 INVALID_DOC_TYPE.
 *   8. PUT with docType="CreditNote" → 200, data.docType set.
 *   9. PUT with docType="" or null → data.docType cleared to null (so the
 *      schema default applies on next read).
 *  10. PUT with docType="Invalid" → 400 INVALID_DOC_TYPE.
 *  11. USER role POST → 403 (verifyRole short-circuit).
 *  12. Cross-tenant PUT → 404 NOT_FOUND.
 *
 * Test pattern: patch the prisma singleton with vi.fn() stubs BEFORE the
 * router is required, then drive supertest with real HS256 JWTs signed
 * with the same fallback secret the middleware uses in dev.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelInvoice = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoiceLine = {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  role: 'ADMIN', subBrandAccess: null,
});
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
const travelInvoicesRouter = requireCJS('../../routes/travel_invoices');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelInvoicesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function basePostBody(overrides = {}) {
  return {
    contactId: 999,
    totalAmount: '45000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    subBrand: 'tmc',
    ...overrides,
  };
}

function sourceInvoice(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    invoiceNum: 'TINV-2026-0042',
    status: 'Draft',
    totalAmount: '45000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 14 * 86_400_000),
    docType: 'TaxInvoice',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.findMany.mockReset().mockResolvedValue([]);
  prisma.travelInvoice.count.mockReset().mockResolvedValue(0);
  prisma.travelInvoice.create.mockReset();
  prisma.travelInvoice.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'ADMIN', subBrandAccess: null,
  });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/invoices — docType taxonomy', () => {
  test('docType="Proforma" → 201, value persisted into create data', async () => {
    prisma.travelInvoice.create.mockImplementation(async ({ data }) =>
      sourceInvoice({ ...data, id: 201 }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(basePostBody({ docType: 'Proforma' }));

    expect(res.status).toBe(201);
    expect(prisma.travelInvoice.create).toHaveBeenCalled();
    const args = prisma.travelInvoice.create.mock.calls[0][0];
    expect(args.data.docType).toBe('Proforma');
  });

  test('docType omitted → 201, create data does NOT pass docType (schema default applies)', async () => {
    prisma.travelInvoice.create.mockImplementation(async ({ data }) =>
      sourceInvoice({ ...data, id: 202 }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(basePostBody());

    expect(res.status).toBe(201);
    const args = prisma.travelInvoice.create.mock.calls[0][0];
    // Omitted => route leaves docType out so Prisma applies @default("TaxInvoice").
    expect(args.data).not.toHaveProperty('docType');
  });

  test('docType="" empty string → 201, treated as default (omitted from create data)', async () => {
    prisma.travelInvoice.create.mockImplementation(async ({ data }) =>
      sourceInvoice({ ...data, id: 203 }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(basePostBody({ docType: '' }));

    expect(res.status).toBe(201);
    const args = prisma.travelInvoice.create.mock.calls[0][0];
    expect(args.data).not.toHaveProperty('docType');
  });

  test('docType="Invalid" → 400 INVALID_DOC_TYPE, no create', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send(basePostBody({ docType: 'Invalid' }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DOC_TYPE' });
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('each of the 5 valid enum values → 201 (round-out the enum)', async () => {
    prisma.travelInvoice.create.mockImplementation(async ({ data }) =>
      sourceInvoice({ ...data, id: 204 }),
    );

    for (const dt of [
      'Proforma',
      'TaxInvoice',
      'CreditNote',
      'DebitNote',
      'TravelVoucher',
    ]) {
      const res = await request(makeApp())
        .post('/api/travel/invoices')
        .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
        .send(basePostBody({ docType: dt }));
      expect(res.status).toBe(201);
    }
    // 5 creates total.
    expect(prisma.travelInvoice.create).toHaveBeenCalledTimes(5);
    // Last call carried "TravelVoucher".
    const lastArgs = prisma.travelInvoice.create.mock.calls.at(-1)[0];
    expect(lastArgs.data.docType).toBe('TravelVoucher');
  });

  test('USER role POST → 403, no create', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(basePostBody({ docType: 'Proforma' }));

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/travel/invoices?docType=… — list filter', () => {
  test('?docType=CreditNote → 200, where clause carries docType', async () => {
    prisma.travelInvoice.findMany.mockResolvedValue([
      sourceInvoice({ id: 300, docType: 'CreditNote' }),
    ]);
    prisma.travelInvoice.count.mockResolvedValue(1);

    const res = await request(makeApp())
      .get('/api/travel/invoices?docType=CreditNote')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.travelInvoice.findMany).toHaveBeenCalled();
    const findArgs = prisma.travelInvoice.findMany.mock.calls[0][0];
    expect(findArgs.where).toMatchObject({ docType: 'CreditNote' });
    expect(res.body.invoices).toHaveLength(1);
  });

  test('?docType=Invalid → 400 INVALID_DOC_TYPE, no list query', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices?docType=Invalid')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DOC_TYPE' });
    expect(prisma.travelInvoice.findMany).not.toHaveBeenCalled();
  });
});

describe('PUT /api/travel/invoices/:id — docType update', () => {
  test('docType="CreditNote" → 200, update data carries docType', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 400, docType: 'TaxInvoice' }),
    );
    prisma.travelInvoice.update.mockImplementation(async ({ data }) =>
      sourceInvoice({ id: 400, ...data }),
    );

    const res = await request(makeApp())
      .put('/api/travel/invoices/400')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ docType: 'CreditNote' });

    expect(res.status).toBe(200);
    const args = prisma.travelInvoice.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 400 });
    expect(args.data.docType).toBe('CreditNote');
  });

  test('docType="" empty string → 200, data.docType cleared to null', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 401, docType: 'CreditNote' }),
    );
    prisma.travelInvoice.update.mockImplementation(async ({ data }) =>
      sourceInvoice({ id: 401, ...data }),
    );

    const res = await request(makeApp())
      .put('/api/travel/invoices/401')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ docType: '' });

    expect(res.status).toBe(200);
    const args = prisma.travelInvoice.update.mock.calls[0][0];
    expect(args.data).toHaveProperty('docType', null);
  });

  test('docType="Invalid" → 400 INVALID_DOC_TYPE, no update', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 402 }),
    );

    const res = await request(makeApp())
      .put('/api/travel/invoices/402')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ docType: 'Invalid' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DOC_TYPE' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('cross-tenant PUT → 404 NOT_FOUND, no update', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .put('/api/travel/invoices/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ docType: 'CreditNote' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });
});
