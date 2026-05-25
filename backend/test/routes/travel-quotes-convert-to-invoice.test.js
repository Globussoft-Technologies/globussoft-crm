// @ts-check
/**
 * Arc 2 #900 slice 10 — POST /api/travel/quotes/:id/convert-to-invoice contract.
 *
 * Pins the convert-to-invoice operator surface added to
 * backend/routes/travel_quotes.js on top of the existing duplicate +
 * PDF + pricing-preview + tax-preview endpoints.
 *
 * What's pinned
 * -------------
 *   POST /api/travel/quotes/:id/convert-to-invoice
 *     - ADMIN+MANAGER gate, USER role → 403 RBAC_DENIED.
 *     - Malformed :id (non-numeric) → 400 INVALID_ID.
 *     - Tenant-scoped source lookup; cross-tenant → 404 QUOTE_NOT_FOUND.
 *     - Sub-brand isolation: caller without source's sub-brand → 403
 *       SUB_BRAND_DENIED.
 *     - Happy path: 201 + { invoice: {...}, linesCloned: N }. Invoice
 *       is created in Draft status, quoteId FK is set to the source
 *       quote's id (reverse-link per FR-3.9.2).
 *     - Line clone: every TravelQuoteLine row under the source quote
 *       maps to a TravelInvoiceLine row under the new invoice (same
 *       lineType / description / quantity / unitPrice / amount /
 *       currency / sortOrder / notes).
 *     - Idempotency (AC-6.11): if an invoice already references this
 *       quote, second call returns 200 + { invoice, alreadyConverted:
 *       true, code: 'ALREADY_CONVERTED' } and createMany is NOT called
 *       a second time.
 *     - dueDate: server defaults to today + 30 days (operator can edit
 *       on the invoice later).
 *     - Audit: writes TRAVEL_QUOTE_CONVERTED on the source quote +
 *       a separate CREATE row for the new invoice.
 *
 * Pattern mirrors backend/test/routes/travel-quotes-duplicate-pdf.test.js
 * — patch the prisma singleton with vi.fn() shapes BEFORE requiring the
 * router, drive supertest with real HS256 JWTs signed with the dev
 * fallback secret. verifyToken stays in the chain (no bypass).
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelQuote = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelQuoteLine = {
  findMany: vi.fn().mockResolvedValue([]),
  findFirst: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoice = {
  findFirst: vi.fn(),
  create: vi.fn(),
};
prisma.travelInvoiceLine = {
  createMany: vi.fn().mockResolvedValue({ count: 0 }),
};
prisma.travelMarkupRule = {
  findMany: vi.fn().mockResolvedValue([]),
};
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
const travelQuotesRouter = requireCJS('../../routes/travel_quotes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', travelQuotesRouter);
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
  prisma.travelQuote.findFirst.mockReset();
  prisma.travelQuoteLine.findMany.mockReset().mockResolvedValue([]);
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.create.mockReset();
  prisma.travelInvoiceLine.createMany.mockReset().mockResolvedValue({ count: 0 });
  prisma.$transaction.mockReset();
  prisma.$transaction.mockImplementation(async (cb) => cb(prisma));
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
});

describe('POST /api/travel/quotes/:id/convert-to-invoice', () => {
  test('USER role → 403 RBAC_DENIED', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/convert-to-invoice')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('malformed :id (non-numeric) → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/quotes/notanumber/convert-to-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('cross-tenant source → 404 QUOTE_NOT_FOUND', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/quotes/99/convert-to-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_FOUND');
  });

  test('sub-brand denied → 403 SUB_BRAND_DENIED', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'rfu', contactId: 100,
      status: 'Accepted', totalAmount: '1000.00', currency: 'INR', validUntil: null,
    });
    // MANAGER scoped to ['tmc'] only — cannot access rfu source. Note:
    // ADMIN role bypasses the sub-brand check (getSubBrandAccessSet
    // returns null for ADMIN regardless of the subBrandAccess column),
    // so this test deliberately uses MANAGER to exercise the deny path.
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER', subBrandAccess: JSON.stringify(['tmc']),
    });
    const res = await request(makeApp())
      .post('/api/travel/quotes/42/convert-to-invoice')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUB_BRAND_DENIED');
  });

  test('happy path → 201 + invoice envelope with quoteId reverse-link + Draft status', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Accepted', totalAmount: '12500.00', currency: 'INR', validUntil: null,
    });
    // No existing invoice → idempotency check passes through.
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    // Source quote has 2 line items.
    prisma.travelQuoteLine.findMany.mockResolvedValue([
      { id: 1001, quoteId: 42, tenantId: 1, lineType: 'hotel', description: 'Hilton', quantity: 3, unitPrice: '4000.00', amount: '12000.00', currency: 'INR', sortOrder: 0, notes: null },
      { id: 1002, quoteId: 42, tenantId: 1, lineType: 'service', description: 'Visa fee', quantity: 1, unitPrice: '500.00', amount: '500.00', currency: 'INR', sortOrder: 1, notes: null },
    ]);
    // $transaction returns the latest serial → next becomes 0001.
    prisma.$transaction.mockImplementation(async (cb) => {
      const tx = {
        travelInvoice: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      return cb(tx);
    });
    prisma.travelInvoice.create.mockResolvedValue({
      id: 7777, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      quoteId: 42, invoiceNum: `TINV-${new Date().getFullYear()}-0001`,
      status: 'Draft', totalAmount: '12500.00', currency: 'INR',
      dueDate: new Date(),
    });

    const res = await request(makeApp())
      .post('/api/travel/quotes/42/convert-to-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.invoice.id).toBe(7777);
    expect(res.body.invoice.quoteId).toBe(42);
    expect(res.body.invoice.status).toBe('Draft');
    expect(res.body.linesCloned).toBe(2);

    // Verify createMany was called with the cloned-line payload.
    expect(prisma.travelInvoiceLine.createMany).toHaveBeenCalledTimes(1);
    const cloneArgs = prisma.travelInvoiceLine.createMany.mock.calls[0][0];
    expect(cloneArgs.data).toHaveLength(2);
    expect(cloneArgs.data[0].lineType).toBe('hotel');
    expect(cloneArgs.data[0].invoiceId).toBe(7777);
    expect(cloneArgs.data[1].lineType).toBe('service');

    // Two audit rows: TRAVEL_QUOTE_CONVERTED on the quote + CREATE on
    // the invoice.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    const auditActions = prisma.auditLog.create.mock.calls.map(
      (c) => c[0].data.action,
    );
    expect(auditActions).toContain('TRAVEL_QUOTE_CONVERTED');
    expect(auditActions).toContain('CREATE');
  });

  test('idempotency (AC-6.11): existing invoice → 200 + alreadyConverted=true; no second create', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 42, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Accepted', totalAmount: '12500.00', currency: 'INR',
    });
    // Existing invoice references this quote.
    prisma.travelInvoice.findFirst.mockResolvedValue({
      id: 7000, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      quoteId: 42, invoiceNum: 'TINV-2026-0042', status: 'Draft',
      totalAmount: '12500.00', currency: 'INR',
    });

    const res = await request(makeApp())
      .post('/api/travel/quotes/42/convert-to-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.alreadyConverted).toBe(true);
    expect(res.body.code).toBe('ALREADY_CONVERTED');
    expect(res.body.invoice.id).toBe(7000);

    // CRITICAL: second click never creates a duplicate invoice or line
    // clones. Both create-paths stay untouched.
    expect(prisma.travelInvoice.create).not.toHaveBeenCalled();
    expect(prisma.travelInvoiceLine.createMany).not.toHaveBeenCalled();
  });

  test('quote with zero lines → 201 + linesCloned=0 + no createMany call', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Draft', totalAmount: '0.00', currency: 'INR',
    });
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    prisma.travelQuoteLine.findMany.mockResolvedValue([]); // No lines.
    prisma.$transaction.mockImplementation(async (cb) => {
      const tx = { travelInvoice: { findFirst: vi.fn().mockResolvedValue(null) } };
      return cb(tx);
    });
    prisma.travelInvoice.create.mockResolvedValue({
      id: 8000, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      quoteId: 50, invoiceNum: `TINV-${new Date().getFullYear()}-0001`,
      status: 'Draft', totalAmount: '0.00', currency: 'INR',
    });

    const res = await request(makeApp())
      .post('/api/travel/quotes/50/convert-to-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.linesCloned).toBe(0);
    // Skip the createMany call entirely when there are no source lines.
    expect(prisma.travelInvoiceLine.createMany).not.toHaveBeenCalled();
  });

  test('default dueDate ≈ today + 30 days', async () => {
    prisma.travelQuote.findFirst.mockResolvedValue({
      id: 60, tenantId: 1, subBrand: 'tmc', contactId: 5001,
      status: 'Accepted', totalAmount: '1000.00', currency: 'INR',
    });
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    prisma.travelQuoteLine.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation(async (cb) => {
      const tx = { travelInvoice: { findFirst: vi.fn().mockResolvedValue(null) } };
      return cb(tx);
    });
    prisma.travelInvoice.create.mockResolvedValue({
      id: 9000, tenantId: 1, quoteId: 60, status: 'Draft',
      invoiceNum: 'TINV-2026-0001', dueDate: new Date(),
    });

    await request(makeApp())
      .post('/api/travel/quotes/60/convert-to-invoice')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    // Inspect the create call's dueDate to verify the +30d default.
    const createArgs = prisma.travelInvoice.create.mock.calls[0][0];
    const dueDate = createArgs.data.dueDate;
    const expectedMs = Date.now() + 30 * 86_400_000;
    // Allow 5s slack for the test's wall-clock between Date.now()s.
    expect(Math.abs(dueDate.getTime() - expectedMs)).toBeLessThan(5_000);
  });
});
