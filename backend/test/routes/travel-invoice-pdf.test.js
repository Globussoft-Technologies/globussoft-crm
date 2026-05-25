// @ts-check
/**
 * Arc 2 #901 slice 2 — TravelInvoice PDF endpoint contract.
 *
 * Pins the GET /api/travel/invoices/:id/pdf handler added to
 * backend/routes/travel_invoices.js on top of the slice-1 CRUD + line-item
 * scaffold (commit 00d629c5).
 *
 * Mirrors the shape of backend/test/routes/travel-quotes-duplicate-pdf.test.js
 * (commit bfd21db3) — the quote `/pdf` endpoint is the canonical pattern this
 * invoice variant copies.
 *
 * Contracts asserted:
 *   - Happy path: 200 + Content-Type=application/pdf + body Buffer starts
 *     with %PDF magic + body length > 2KB.
 *   - Content-Disposition is `attachment; filename="invoice-<id>.pdf"`.
 *   - USER role → 403 (verifyRole gate blocks before findFirst).
 *   - Cross-tenant invoice → 404 INVOICE_NOT_FOUND.
 *   - Sub-brand mismatch → 403 SUB_BRAND_DENIED.
 *   - Non-numeric :id → 400 INVALID_ID.
 *   - Audit row stamped with action=TRAVEL_INVOICE_PDF_DOWNLOADED carrying
 *     invoiceId in the JSON-stringified details column.
 *   - Empty-lines case (invoice with zero line items): PDF still renders
 *     cleanly (the helper draws a "(No line items on this invoice yet.)"
 *     placeholder and totals fall back to the invoice header amount).
 *   - PDF render exception (helper throws) → 500 PDF_RENDER_FAILED. The
 *     spy works because the route references the renderer as
 *     `pdfRenderer.generateTravelInvoicePdf(...)` (CJS self-mocking seam).
 *
 * PDF render runs the REAL services/pdfRenderer.generateTravelInvoicePdf for
 * all cases except the explicit "render throws" test — the function is
 * pure-cpu (pdfkit is already in the dep tree) so mocking by default would
 * only test the mock.
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
const pdfRenderer = requireCJS('../../services/pdfRenderer');

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

function sourceInvoice(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    invoiceNum: 'TINV-2026-0042',
    status: 'Issued',
    totalAmount: '45000.00',
    currency: 'INR',
    dueDate: new Date(Date.now() + 14 * 86_400_000),
    issuedDate: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function sampleLines() {
  return [
    {
      id: 1, invoiceId: 100, tenantId: 1,
      lineType: 'per_pax', description: 'Adult package',
      quantity: 2, unitPrice: 15000, amount: 30000,
      currency: 'INR', sortOrder: 0, notes: null,
    },
    {
      id: 2, invoiceId: 100, tenantId: 1,
      lineType: 'tax', description: 'GST 5%',
      quantity: 1, unitPrice: 1500, amount: 1500,
      currency: 'INR', sortOrder: 1, notes: null,
    },
  ];
}

// Parse the binary response body as a Buffer (supertest defaults to
// string, which corrupts the PDF bytes on .toString() round-trip).
function bufferParser(r, cb) {
  const chunks = [];
  r.on('data', (c) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.findMany.mockReset();
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/invoices/:id/pdf', () => {
  test('happy path: 200 with Content-Type=application/pdf and a valid %PDF Buffer', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(sourceInvoice({ id: 100 }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue(sampleLines());

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    // Any real branded PDF (header band + meta + table + totals + footer) is
    // well over 2KB; pdfkit's empty doc is around 1KB so 2KB is a safe floor.
    expect(res.body.length).toBeGreaterThan(2048);
    // PDF magic bytes — pdfkit always emits "%PDF-" at the start.
    expect(res.body.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('Content-Disposition is attachment with filename="invoice-<id>.pdf"', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(sourceInvoice({ id: 100 }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue(sampleLines());

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-disposition']).toMatch(/filename="invoice-100\.pdf"/);
  });

  test('USER role returns 403 (gate blocks before findFirst)', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/pdf')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('cross-tenant lookup returns 404 INVOICE_NOT_FOUND', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/invoices/9999/pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('sub-brand mismatch returns 403 SUB_BRAND_DENIED', async () => {
    // Invoice belongs to RFU sub-brand; caller is MANAGER whose
    // subBrandAccess only permits TMC. ADMIN is short-circuited by
    // getSubBrandAccessSet to null (= full access), so we deliberately
    // use MANAGER here to exercise the deny path.
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 100, subBrand: 'rfu' }),
    );
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/pdf')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('malformed :id (non-numeric) returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/oops/pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
  });

  test('audit row written with action=TRAVEL_INVOICE_PDF_DOWNLOADED + invoiceId in details', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(sourceInvoice({ id: 100 }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue(sampleLines());

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelInvoice',
      action: 'TRAVEL_INVOICE_PDF_DOWNLOADED',
      entityId: 100,
      userId: 7,
      tenantId: 1,
    });
    // writeAudit stores `details` as a JSON-stringified column — parse and assert.
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({
      invoiceId: 100,
      subBrand: 'tmc',
      lineCount: 2,
    });
  });

  test('empty-lines case: invoice with zero line items still renders a PDF', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      sourceInvoice({ id: 100, totalAmount: '0.00' }),
    );
    prisma.travelInvoiceLine.findMany.mockResolvedValue([]); // explicit empty

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/pdf')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.slice(0, 5).toString('latin1')).toBe('%PDF-');
    // Even empty-lines case produces a full branded doc (header + meta +
    // empty-state placeholder + totals + footer); >2KB confirms the layout
    // primitives executed end-to-end.
    expect(res.body.length).toBeGreaterThan(2048);

    // Audit STILL fires (the "no lines" case is a valid operator-initiated
    // download, not a no-op skip).
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({ invoiceId: 100, lineCount: 0 });
  });

  test('PDF render exception returns 500 PDF_RENDER_FAILED (no audit, render-failure log path)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(sourceInvoice({ id: 100 }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue(sampleLines());

    // CJS self-mocking seam — the route reads
    // `pdfRenderer.generateTravelInvoicePdf` off the module-exports object,
    // so a spy on that property is intercepted by the handler.
    const spy = vi
      .spyOn(pdfRenderer, 'generateTravelInvoicePdf')
      .mockRejectedValueOnce(new Error('pdfkit font resolution failed'));

    try {
      const res = await request(makeApp())
        .get('/api/travel/invoices/100/pdf')
        .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ code: 'PDF_RENDER_FAILED' });
      // Audit must NOT fire on render failure — the trail only records
      // successful downloads (the BEFORE-send ordering on the success path
      // means the audit comes AFTER the helper call).
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('MANAGER role can also download the PDF (mirrors ADMIN path)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(sourceInvoice({ id: 100 }));
    prisma.travelInvoiceLine.findMany.mockResolvedValue(sampleLines());
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });

    const res = await request(makeApp())
      .get('/api/travel/invoices/100/pdf')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(2048);
  });
});
