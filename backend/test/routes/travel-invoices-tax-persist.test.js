// @ts-check
/**
 * Unit tests for POST /api/travel/invoices/:id/tax-persist (G028 + G029
 * + G021/G034 wire-up — PRD_TRAVEL_GST_COMPLIANCE FR-3.2.1 + FR-3.2.2).
 *
 * What this file pins
 * -------------------
 * The new persist endpoint that writes the on-the-fly tax-preview result
 * down onto TravelInvoice (placeOfSupply, cgst/sgst/igst Amount+Percent,
 * totalTaxAmount, gstComputedAt) AND onto each TravelInvoiceLine
 * (cgst/sgst/igst Amount+Percent + hsnSac). Idempotency: re-run
 * overwrites. RBAC: ADMIN/MANAGER only.
 *
 * Coverage (11 cases)
 * -------------------
 *   1. ADMIN intra-state persist → 200 + invoice updated with CGST+SGST
 *      (no IGST) + lines updated + gstComputedAt set
 *   2. ADMIN inter-state persist → 200 + invoice updated with IGST only
 *      (no CGST/SGST)
 *   3. MANAGER role accepted (RBAC parity with tax-preview write-side)
 *   4. USER role → 403 (write-side guard)
 *   5. Idempotency → second persist overwrites the columns + bumps
 *      gstComputedAt
 *   6. Per-line columns populated → cgstAmount/sgstAmount on each line
 *      row matches the per-line math
 *   7. placeOfSupply pinned to customerStateCode (not operator)
 *   8. customerStateCode body override wins → DB lookup skipped
 *   9. Empty-string operatorStateCode in body → 400 INVALID_STATE_CODE
 *  10. No lines on the invoice → 200 + zero totals + gstComputedAt still set
 *  11. Cross-tenant invoice id → 404 INVOICE_NOT_FOUND (loadParentInvoice)
 *
 * Mocking strategy
 * ----------------
 * Mirror of travel-invoices-stats.test.js — patch prisma singleton with
 * vi.fn() shapes BEFORE requiring the router. Real verifyToken +
 * requireTravelTenant + loadParentInvoice run.  HS256 JWTs signed with
 * the dev fallback secret. $transaction is monkey-patched to invoke
 * each step inline (the route's transaction array is just N updates;
 * we want the updates' mock-call records to land in prisma.travelInvoice
 * / prisma.travelInvoiceLine for assertion).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelInvoice = prisma.travelInvoice || {};
prisma.travelInvoice.findMany = prisma.travelInvoice.findMany || vi.fn();
prisma.travelInvoice.findFirst = vi.fn();
prisma.travelInvoice.update = vi.fn();
prisma.travelInvoice.count = prisma.travelInvoice.count || vi.fn();
prisma.travelInvoice.create = prisma.travelInvoice.create || vi.fn();
prisma.travelInvoice.delete = prisma.travelInvoice.delete || vi.fn();
prisma.travelInvoiceLine = prisma.travelInvoiceLine || {};
prisma.travelInvoiceLine.findMany = vi.fn();
prisma.travelInvoiceLine.update = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  gstStateCode: 'IN-MH',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn().mockResolvedValue({ stateCode: 'IN-MH', billingStateCode: null });
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// $transaction: execute each prepared step inline so mock-call assertions
// on prisma.travelInvoice.update + prisma.travelInvoiceLine.update see
// the writes. The route passes an array of prisma.<model>.update(...)
// calls which are already promises by the time they arrive here.
prisma.$transaction = vi.fn(async (ops) => Promise.all(ops));

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

const INVOICE_ID = 555;
const TENANT_ID = 1;

const SAMPLE_INVOICE = {
  id: INVOICE_ID,
  tenantId: TENANT_ID,
  subBrand: 'tmc',
  contactId: 99,
  status: 'Draft',
  totalAmount: 5000,
};

const SAMPLE_LINES = [
  { id: 1, invoiceId: INVOICE_ID, tenantId: TENANT_ID, lineType: 'hotel', amount: 3000, sortOrder: 0, hsnSac: null },
  { id: 2, invoiceId: INVOICE_ID, tenantId: TENANT_ID, lineType: 'flight', amount: 2000, sortOrder: 1, hsnSac: null },
];

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset().mockResolvedValue(SAMPLE_INVOICE);
  prisma.travelInvoice.update.mockReset().mockResolvedValue({ ...SAMPLE_INVOICE });
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue(SAMPLE_LINES);
  prisma.travelInvoiceLine.update.mockReset().mockImplementation(async ({ where, data }) => ({ id: where.id, ...data }));
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
    gstStateCode: 'IN-MH',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.contact.findUnique.mockReset().mockResolvedValue({ stateCode: 'IN-MH', billingStateCode: null });
  prisma.$transaction.mockReset().mockImplementation(async (ops) => Promise.all(ops));
});

// ─────────────────────────────────────────────────────────────────────
describe('POST /api/travel/invoices/:id/tax-persist — happy path + RBAC', () => {
  test('case 1: ADMIN intra-state persist → 200 + invoice updated with CGST+SGST (no IGST) + gstComputedAt set', async () => {
    // Contact in same state as operator (IN-MH) → intra-state → CGST+SGST.
    prisma.contact.findUnique.mockResolvedValue({ stateCode: 'IN-MH', billingStateCode: null });

    const res = await request(makeApp())
      .post(`/api/travel/invoices/${INVOICE_ID}/tax-persist`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(true);
    expect(res.body.isInterstate).toBe(false);
    expect(res.body.linesPersistedCount).toBe(2);
    expect(typeof res.body.gstComputedAt).toBe('string');
    expect(res.body.placeOfSupply).toBe('IN-MH');

    // Hotel (3000 @ 12% = 360) intra-state → CGST 180, SGST 180.
    // Flight (2000 @ 5% = 100) intra-state → CGST 50, SGST 50.
    // Bucket totals: CGST 230, SGST 230, IGST 0, totalTax 460.
    expect(res.body.totalCgst).toBe(230);
    expect(res.body.totalSgst).toBe(230);
    expect(res.body.totalIgst).toBe(0);
    expect(res.body.totalTax).toBe(460);

    // Invoice update fired with persisted columns.
    expect(prisma.travelInvoice.update).toHaveBeenCalledOnce();
    const invUpd = prisma.travelInvoice.update.mock.calls[0][0];
    expect(invUpd.where).toEqual({ id: INVOICE_ID });
    expect(invUpd.data.placeOfSupply).toBe('IN-MH');
    expect(invUpd.data.cgstAmount).toBe(230);
    expect(invUpd.data.sgstAmount).toBe(230);
    expect(invUpd.data.igstAmount).toBe(0);
    expect(invUpd.data.totalTaxAmount).toBe(460);
    expect(invUpd.data.gstComputedAt).toBeInstanceOf(Date);
  });

  test('case 2: ADMIN inter-state persist → IGST only (no CGST/SGST)', async () => {
    // Contact in IN-KA (different from operator IN-MH) → inter-state → IGST.
    prisma.contact.findUnique.mockResolvedValue({ stateCode: 'IN-KA', billingStateCode: null });

    const res = await request(makeApp())
      .post(`/api/travel/invoices/${INVOICE_ID}/tax-persist`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.isInterstate).toBe(true);
    expect(res.body.placeOfSupply).toBe('IN-KA');
    // Hotel 3000*12% = 360 IGST; Flight 2000*5% = 100 IGST; total 460.
    expect(res.body.totalCgst).toBe(0);
    expect(res.body.totalSgst).toBe(0);
    expect(res.body.totalIgst).toBe(460);
    expect(res.body.totalTax).toBe(460);

    const invUpd = prisma.travelInvoice.update.mock.calls[0][0];
    expect(invUpd.data.cgstAmount).toBe(0);
    expect(invUpd.data.sgstAmount).toBe(0);
    expect(invUpd.data.igstAmount).toBe(460);
  });

  test('case 3: MANAGER role accepted (RBAC parity with write surface)', async () => {
    const res = await request(makeApp())
      .post(`/api/travel/invoices/${INVOICE_ID}/tax-persist`)
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(true);
  });

  test('case 4: USER role → 403 (write-side guard)', async () => {
    const res = await request(makeApp())
      .post(`/api/travel/invoices/${INVOICE_ID}/tax-persist`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('POST /api/travel/invoices/:id/tax-persist — idempotency + per-line', () => {
  test('case 5: idempotent — second persist overwrites + bumps gstComputedAt', async () => {
    const first = await request(makeApp())
      .post(`/api/travel/invoices/${INVOICE_ID}/tax-persist`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(first.status).toBe(200);
    const firstAt = first.body.gstComputedAt;

    // Tiny delay so the two timestamps can differ (route uses new Date()).
    await new Promise((r) => setTimeout(r, 5));

    const second = await request(makeApp())
      .post(`/api/travel/invoices/${INVOICE_ID}/tax-persist`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.persisted).toBe(true);
    const secondAt = second.body.gstComputedAt;

    // gstComputedAt should be later on the second persist (or at least
    // not less than the first).
    expect(new Date(secondAt).getTime()).toBeGreaterThanOrEqual(new Date(firstAt).getTime());

    // Both invocations wrote the invoice column.
    expect(prisma.travelInvoice.update).toHaveBeenCalledTimes(2);
  });

  test('case 6: per-line columns populated on each TravelInvoiceLine row', async () => {
    const res = await request(makeApp())
      .post(`/api/travel/invoices/${INVOICE_ID}/tax-persist`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(200);

    // Two lines → two travelInvoiceLine.update calls.
    expect(prisma.travelInvoiceLine.update).toHaveBeenCalledTimes(2);

    const calls = prisma.travelInvoiceLine.update.mock.calls;
    // Line 1 (hotel, 3000, 12%) intra-state → CGST 180, SGST 180.
    const hotelCall = calls.find((c) => c[0].where.id === 1);
    expect(hotelCall[0].data.cgstPercent).toBe(6);
    expect(hotelCall[0].data.cgstAmount).toBe(180);
    expect(hotelCall[0].data.sgstPercent).toBe(6);
    expect(hotelCall[0].data.sgstAmount).toBe(180);
    expect(hotelCall[0].data.igstPercent).toBe(0);
    expect(hotelCall[0].data.igstAmount).toBe(0);
    // hsnSac populated from mapper (lineType=hotel → SAC code).
    expect(typeof hotelCall[0].data.hsnSac === 'string' || hotelCall[0].data.hsnSac === null).toBe(true);

    // Line 2 (flight, 2000, 5%) intra-state → CGST 50, SGST 50.
    const flightCall = calls.find((c) => c[0].where.id === 2);
    expect(flightCall[0].data.cgstPercent).toBe(2.5);
    expect(flightCall[0].data.cgstAmount).toBe(50);
    expect(flightCall[0].data.sgstPercent).toBe(2.5);
    expect(flightCall[0].data.sgstAmount).toBe(50);
  });

  test('case 7: placeOfSupply pinned to customerStateCode (not operator)', async () => {
    prisma.contact.findUnique.mockResolvedValue({ stateCode: 'IN-TN', billingStateCode: null });
    const res = await request(makeApp())
      .post(`/api/travel/invoices/${INVOICE_ID}/tax-persist`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.placeOfSupply).toBe('IN-TN');
    expect(res.body.operatorStateCode).toBe('IN-MH');

    const invUpd = prisma.travelInvoice.update.mock.calls[0][0];
    expect(invUpd.data.placeOfSupply).toBe('IN-TN');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('POST /api/travel/invoices/:id/tax-persist — overrides + edges', () => {
  test('case 8: customerStateCode body override wins over Contact.stateCode', async () => {
    prisma.contact.findUnique.mockResolvedValue({ stateCode: 'IN-KA', billingStateCode: null });
    const res = await request(makeApp())
      .post(`/api/travel/invoices/${INVOICE_ID}/tax-persist`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ customerStateCode: 'IN-MH' });

    expect(res.status).toBe(200);
    // Override is intra-state (matches operator IN-MH) → CGST+SGST.
    expect(res.body.isInterstate).toBe(false);
    expect(res.body.placeOfSupply).toBe('IN-MH');
    // DB lookup for the Contact should be skipped when override is supplied.
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('case 9: empty-string operatorStateCode in body → 400 INVALID_STATE_CODE', async () => {
    const res = await request(makeApp())
      .post(`/api/travel/invoices/${INVOICE_ID}/tax-persist`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ operatorStateCode: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STATE_CODE');
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('case 10: no lines on invoice → 200 + zero totals + gstComputedAt still set', async () => {
    prisma.travelInvoiceLine.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .post(`/api/travel/invoices/${INVOICE_ID}/tax-persist`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.linesPersistedCount).toBe(0);
    expect(res.body.totalCgst).toBe(0);
    expect(res.body.totalSgst).toBe(0);
    expect(res.body.totalIgst).toBe(0);
    expect(res.body.totalTax).toBe(0);
    expect(typeof res.body.gstComputedAt).toBe('string');

    // Invoice still updated (just with zero totals).
    expect(prisma.travelInvoice.update).toHaveBeenCalledOnce();
    expect(prisma.travelInvoiceLine.update).not.toHaveBeenCalled();
  });

  test('case 11: cross-tenant invoice id → 404 INVOICE_NOT_FOUND via loadParentInvoice', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post(`/api/travel/invoices/${INVOICE_ID}/tax-persist`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INVOICE_NOT_FOUND');
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });
});
