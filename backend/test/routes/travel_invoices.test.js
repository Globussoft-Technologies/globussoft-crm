// @ts-check
/**
 * PRD_TRAVEL_BILLING DD-5.1 — TravelInvoice CRUD scaffold tests.
 *
 * Pins the contract for the operator-facing invoice surface added to
 * backend/routes/travel_invoices.js (sibling to travel_quotes.js shipped
 * at commit b02c091 and travel_suppliers.js at 192b8c1; all three share
 * the /api/travel mount).
 *
 * What's pinned
 * -------------
 *   - POST   /api/travel/invoices       201 on happy path; auto-assigned
 *           invoiceNum TINV-YYYY-NNNN; 400 on missing dueDate; 400 on
 *           invalid status with allowed-values list; sequential POSTs
 *           increment the per-tenant serial.
 *   - PUT    /api/travel/invoices/:id   forward-only status transition
 *           matrix (Draft -> Issued -> Partial -> Paid; any -> Voided);
 *           422 INVALID_INVOICE_TRANSITION on backward moves.
 *   - DELETE /api/travel/invoices/:id   204 on Draft + audit; 422
 *           INVOICE_DELETE_FORBIDDEN on Issued (voided rows stay for
 *           audit trail).
 *   - GET    /api/travel/invoices/:id   cross-tenant returns 404.
 *
 * Test pattern mirrors backend/test/routes/travel_quotes.test.js —
 * patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, then drive supertest with real HS256 JWTs signed with the
 * same fallback secret the middleware uses in dev. verifyToken stays
 * in the chain (we don't bypass it) so the auth-gate is exercised
 * end-to-end.
 *
 * Date-boundary note (per CLAUDE.md standing rule): all happy-path
 * dueDate values use `tomorrow = new Date(Date.now() + 86400000)` to
 * dodge the TZ-midnight overlap window. dueDate accepts past dates
 * (back-dated invoicing is legitimate ops) but the tests use future
 * dates for clarity.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
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
// $transaction is used by nextInvoiceNum — execute the callback against
// the patched prisma client (the route's `tx` argument is just a proxy).
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
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

const tomorrow = new Date(Date.now() + 86_400_000);
const tomorrowIso = tomorrow.toISOString();
const CURRENT_YEAR = new Date().getFullYear();

beforeAll(() => {
  // No-op: prisma stubs already installed above.
});

beforeEach(() => {
  prisma.travelInvoice.findMany.mockReset();
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.count.mockReset();
  prisma.travelInvoice.create.mockReset();
  prisma.travelInvoice.update.mockReset();
  prisma.travelInvoice.delete.mockReset();
  prisma.$transaction.mockReset();
  prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/invoices', () => {
  test('happy path returns 201 with auto-assigned invoiceNum TINV-YYYY-0001', async () => {
    // No prior invoice this year — serial starts at 1.
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    prisma.travelInvoice.create.mockImplementation(async ({ data }) => ({
      id: 42,
      createdAt: new Date(),
      updatedAt: new Date(),
      paidAt: null,
      ...data,
    }));

    const res = await request(makeApp())
      .post('/api/travel/invoices')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 99,
        totalAmount: '45000.00',
        currency: 'INR',
        subBrand: 'tmc',
        dueDate: tomorrowIso,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 42,
      contactId: 99,
      currency: 'INR',
      subBrand: 'tmc',
      status: 'Draft',
      invoiceNum: `TINV-${CURRENT_YEAR}-0001`,
    });
    expect(prisma.travelInvoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          subBrand: 'tmc',
          contactId: 99,
          status: 'Draft',
          currency: 'INR',
          invoiceNum: `TINV-${CURRENT_YEAR}-0001`,
        }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  test('rejects missing dueDate with 400 MISSING_FIELDS', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 99,
        totalAmount: '100.00',
        currency: 'INR',
        subBrand: 'tmc',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MISSING_FIELDS' });
    expect(res.body.error).toMatch(/dueDate/i);
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('rejects invalid status=WTF with 400 + allowed values', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 1,
        totalAmount: '100.00',
        currency: 'INR',
        subBrand: 'tmc',
        dueDate: tomorrowIso,
        status: 'WTF',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATUS' });
    expect(res.body.error).toMatch(/Draft/);
    expect(res.body.error).toMatch(/Issued/);
    expect(res.body.error).toMatch(/Partial/);
    expect(res.body.error).toMatch(/Paid/);
    expect(res.body.error).toMatch(/Voided/);
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
  });

  test('sequential POSTs return TINV-YYYY-NNNN with serial incremented', async () => {
    // First POST — no prior invoice, serial = 1.
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(null);
    prisma.travelInvoice.create.mockImplementationOnce(async ({ data }) => ({
      id: 1, createdAt: new Date(), updatedAt: new Date(), paidAt: null, ...data,
    }));

    const r1 = await request(makeApp())
      .post('/api/travel/invoices')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 99, totalAmount: '100.00', currency: 'INR',
        subBrand: 'tmc', dueDate: tomorrowIso,
      });
    expect(r1.status).toBe(201);
    expect(r1.body.invoiceNum).toBe(`TINV-${CURRENT_YEAR}-0001`);

    // Second POST — latest serial is now 0001, next is 0002.
    prisma.travelInvoice.findFirst.mockResolvedValueOnce({
      invoiceNum: `TINV-${CURRENT_YEAR}-0001`,
    });
    prisma.travelInvoice.create.mockImplementationOnce(async ({ data }) => ({
      id: 2, createdAt: new Date(), updatedAt: new Date(), paidAt: null, ...data,
    }));

    const r2 = await request(makeApp())
      .post('/api/travel/invoices')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        contactId: 99, totalAmount: '200.00', currency: 'INR',
        subBrand: 'tmc', dueDate: tomorrowIso,
      });
    expect(r2.status).toBe(201);
    expect(r2.body.invoiceNum).toBe(`TINV-${CURRENT_YEAR}-0002`);
  });
});

describe('PUT /api/travel/invoices/:id (status transition matrix)', () => {
  test('Draft -> Issued returns 200 with updated status', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue({
      id: 5, tenantId: 1, subBrand: 'tmc', contactId: 99,
      status: 'Draft', totalAmount: '100.00', currency: 'INR',
      invoiceNum: `TINV-${CURRENT_YEAR}-0001`, dueDate: tomorrow,
    });
    prisma.travelInvoice.update.mockImplementation(async ({ data }) => ({
      id: 5, tenantId: 1, subBrand: 'tmc', contactId: 99,
      totalAmount: '100.00', currency: 'INR',
      invoiceNum: `TINV-${CURRENT_YEAR}-0001`, dueDate: tomorrow,
      ...data,
    }));

    const res = await request(makeApp())
      .put('/api/travel/invoices/5')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'Issued' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, status: 'Issued' });
    expect(prisma.travelInvoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5 },
        data: expect.objectContaining({ status: 'Issued' }),
      }),
    );
  });

  test('Issued -> Draft returns 422 INVALID_INVOICE_TRANSITION (backward)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue({
      id: 6, tenantId: 1, subBrand: 'tmc', contactId: 99,
      status: 'Issued', totalAmount: '100.00', currency: 'INR',
      invoiceNum: `TINV-${CURRENT_YEAR}-0002`, dueDate: tomorrow,
    });

    const res = await request(makeApp())
      .put('/api/travel/invoices/6')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'Draft' });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'INVALID_INVOICE_TRANSITION' });
    expect(res.body.error).toMatch(/Issued/);
    expect(res.body.error).toMatch(/Draft/);
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('any -> Voided is allowed (e.g. Paid -> Voided)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue({
      id: 7, tenantId: 1, subBrand: 'tmc', contactId: 99,
      status: 'Paid', totalAmount: '100.00', currency: 'INR',
      invoiceNum: `TINV-${CURRENT_YEAR}-0003`, dueDate: tomorrow,
    });
    prisma.travelInvoice.update.mockImplementation(async ({ data }) => ({
      id: 7, tenantId: 1, subBrand: 'tmc', contactId: 99,
      totalAmount: '100.00', currency: 'INR',
      invoiceNum: `TINV-${CURRENT_YEAR}-0003`, dueDate: tomorrow,
      ...data,
    }));

    const res = await request(makeApp())
      .put('/api/travel/invoices/7')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'Voided' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, status: 'Voided' });
  });
});

describe('DELETE /api/travel/invoices/:id (status-gated hard-delete)', () => {
  test('Draft invoice returns 204 + writes audit before prisma.delete fires', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue({
      id: 8, tenantId: 1, subBrand: 'tmc', contactId: 99,
      status: 'Draft', totalAmount: '100.00', currency: 'INR',
      invoiceNum: `TINV-${CURRENT_YEAR}-0004`, dueDate: tomorrow,
    });

    const callOrder = [];
    prisma.auditLog.create.mockImplementation(async (args) => {
      callOrder.push('audit');
      return { id: 1, ...args };
    });
    prisma.travelInvoice.delete.mockImplementation(async () => {
      callOrder.push('delete');
      return { id: 8 };
    });

    const res = await request(makeApp())
      .delete('/api/travel/invoices/8')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(prisma.auditLog.create).toHaveBeenCalled();
    expect(prisma.travelInvoice.delete).toHaveBeenCalledWith({ where: { id: 8 } });
    expect(callOrder).toEqual(['audit', 'delete']);

    const auditCallArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditCallArgs.data).toMatchObject({
      entity: 'TravelInvoice',
      action: 'DELETE',
      entityId: 8,
      userId: 7,
      tenantId: 1,
    });
  });

  test('Issued invoice returns 422 INVOICE_DELETE_FORBIDDEN', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue({
      id: 9, tenantId: 1, subBrand: 'tmc', contactId: 99,
      status: 'Issued', totalAmount: '100.00', currency: 'INR',
      invoiceNum: `TINV-${CURRENT_YEAR}-0005`, dueDate: tomorrow,
    });

    const res = await request(makeApp())
      .delete('/api/travel/invoices/9')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'INVOICE_DELETE_FORBIDDEN' });
    expect(res.body.error).toMatch(/Issued/);
    expect(prisma.travelInvoice.delete).not.toHaveBeenCalled();
  });
});

describe('GET /api/travel/invoices/:id (cross-tenant isolation)', () => {
  test('cross-tenant returns 404', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/invoices/9999')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.travelInvoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 9999, tenantId: 1 }),
      }),
    );
  });
});
