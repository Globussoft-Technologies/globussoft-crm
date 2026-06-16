// @ts-check
/**
 * Arc 2 #901 slice 5 — TravelInvoice issue endpoint contract.
 *
 * Pins POST /api/travel/invoices/:id/issue — the operator-action Draft ->
 * Issued state transition added on top of slices 1-4 (CRUD + lines + PDF
 * + ?include=lines + line PNR/dates).
 *
 * Mirrors backend/test/routes/travel-invoice-pdf.test.js (commit 00d629c5)
 * — same prisma-singleton-patch + supertest pattern, same JWT signing.
 *
 * Contracts asserted:
 *   1. Happy path TMC: Draft -> Issued, invoiceNum starts with "TMC/<FY>/",
 *      status flipped, audit row written with TRAVEL_INVOICE_ISSUED.
 *   2. Happy path RFU: invoiceNum starts with "RFU/<FY>/".
 *   3. Happy path travel_stall: invoiceNum starts with "TS/<FY>/".
 *   4. Sequential issuing within same sub-brand: serial 0001 -> 0002.
 *   5. Issuing an already-Issued invoice -> 400 INVALID_STATE.
 *   6. Issuing a Paid invoice -> 400 INVALID_STATE.
 *   7. USER role -> 403 (RBAC gate).
 *   8. Cross-tenant invoice -> 404 INVOICE_NOT_FOUND.
 *   9. Sub-brand mismatch -> 403 SUB_BRAND_DENIED.
 *  10. Non-numeric :id -> 400 INVALID_ID.
 *  11. Audit details payload carries oldInvoiceNum + newInvoiceNum + subBrand.
 *  12. Cross-sub-brand counter independence: TMC's 0001 and RFU's 0001 coexist.
 *
 * The fiscal-year label is computed at request-time (real Date), so the
 * happy-path tests assert on the PREFIX prefix only ("TMC/", "RFU/", "TS/")
 * + the FY-segment regex (`\d{2}-\d{2}`) — not on a hardcoded "26-27"
 * which would rot on FY rollover.
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
// T32 (Class B4) — auto-create payment schedule block (routes/travel_invoices.js
// :3908) calls travelPaymentSchedule.findFirst + createMany after the Draft ->
// Issued transition. Without these mocks Prisma's real client is reached and
// the test times out. The 6 happy-path / FY-counter / audit-row / cross-sub-
// brand tests don't care about schedule creation — they short-circuit by
// returning a truthy findFirst so the createMany branch is skipped.
prisma.travelPaymentSchedule = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
};
// $transaction passes a "tx" with the same prisma shape — the handler reads
// tx.travelInvoice.findFirst inside nextSubBrandInvoiceNum.
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
const { invoicePrefixFor } = requireCJS('../../lib/travelFiscalYear');

// Compute "today's" expected prefix once per process so the assertions
// stay FY-agnostic (auto-correct across April-1 rollover).
const FY_TODAY = invoicePrefixFor('tmc', new Date()).split('/')[1]; // e.g. "26-27"

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

function draftInvoice(overrides = {}) {
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.travelInvoice.update.mockReset();
  prisma.travelInvoiceLine.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  // T32 (Class B4) — short-circuit the auto-create payment schedule block by
  // returning a truthy findFirst (matches the "operator already populated a
  // custom schedule" branch). The 6 affected tests assert on FY-counter
  // invoice-num formatting, NOT on schedule creation.
  prisma.travelPaymentSchedule.findFirst.mockReset().mockResolvedValue({ id: 1 });
  prisma.travelPaymentSchedule.findMany.mockReset().mockResolvedValue([]);
  prisma.travelPaymentSchedule.create.mockReset();
  prisma.travelPaymentSchedule.createMany.mockReset();
});

describe('POST /api/travel/invoices/:id/issue — Draft -> Issued', () => {
  test('happy path TMC: 200, invoiceNum becomes TMC/<FY>/0001, status=Issued', async () => {
    prisma.travelInvoice.findFirst
      // first call: route-level findFirst loading the invoice
      .mockResolvedValueOnce(draftInvoice({ id: 100, subBrand: 'tmc' }))
      // second call: nextSubBrandInvoiceNum scanning for latest TMC/<FY>/ row
      .mockResolvedValueOnce(null);
    prisma.travelInvoice.update.mockImplementation(async ({ data }) =>
      draftInvoice({ id: 100, subBrand: 'tmc', ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/100/issue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Issued');
    expect(res.body.invoiceNum).toBe(`TMC/${FY_TODAY}/0001`);
    // Confirm update was actually issued with the new shape.
    const updArgs = prisma.travelInvoice.update.mock.calls[0][0];
    expect(updArgs.where).toEqual({ id: 100 });
    expect(updArgs.data.status).toBe('Issued');
    expect(updArgs.data.invoiceNum).toMatch(/^TMC\/\d{2}-\d{2}\/0001$/);
  });

  test('happy path RFU: invoiceNum becomes RFU/<FY>/0001', async () => {
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(draftInvoice({ id: 101, subBrand: 'rfu' }))
      .mockResolvedValueOnce(null);
    prisma.travelInvoice.update.mockImplementation(async ({ data }) =>
      draftInvoice({ id: 101, subBrand: 'rfu', ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/101/issue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.invoiceNum).toMatch(/^RFU\/\d{2}-\d{2}\/0001$/);
    expect(res.body.invoiceNum).toBe(`RFU/${FY_TODAY}/0001`);
  });

  test('happy path travel_stall: invoiceNum becomes TS/<FY>/0001', async () => {
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(draftInvoice({ id: 102, subBrand: 'travel_stall' }))
      .mockResolvedValueOnce(null);
    prisma.travelInvoice.update.mockImplementation(async ({ data }) =>
      draftInvoice({ id: 102, subBrand: 'travel_stall', ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/102/issue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.invoiceNum).toMatch(/^TS\/\d{2}-\d{2}\/0001$/);
    expect(res.body.invoiceNum).toBe(`TS/${FY_TODAY}/0001`);
  });

  test('sequential issuing: second issue increments serial 0001 -> 0002', async () => {
    // Simulate an existing TMC/<FY>/0001 already in the table — the helper
    // should read its serial and increment to 0002.
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(draftInvoice({ id: 103, subBrand: 'tmc' }))
      .mockResolvedValueOnce({ invoiceNum: `TMC/${FY_TODAY}/0001` });
    prisma.travelInvoice.update.mockImplementation(async ({ data }) =>
      draftInvoice({ id: 103, subBrand: 'tmc', ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/103/issue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.invoiceNum).toBe(`TMC/${FY_TODAY}/0002`);
  });

  test('already-Issued invoice returns 400 INVALID_STATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      draftInvoice({ id: 104, subBrand: 'tmc', status: 'Issued' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/104/issue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATE' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  test('Paid invoice returns 400 INVALID_STATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      draftInvoice({ id: 105, subBrand: 'tmc', status: 'Paid' }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/105/issue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_STATE' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('USER role returns 403 (verifyRole short-circuits before findFirst)', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/100/issue')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('cross-tenant invoice returns 404 INVOICE_NOT_FOUND', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(null);

    const res = await request(makeApp())
      .post('/api/travel/invoices/9999/issue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('sub-brand mismatch returns 403 SUB_BRAND_DENIED', async () => {
    // Invoice belongs to RFU; caller MANAGER's subBrandAccess only permits TMC.
    // (ADMIN gets short-circuited to full-access by getSubBrandAccessSet so we
    // use MANAGER here to exercise the deny path.)
    prisma.travelInvoice.findFirst.mockResolvedValueOnce(
      draftInvoice({ id: 106, subBrand: 'rfu' }),
    );
    prisma.user.findUnique.mockResolvedValueOnce({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['tmc']),
    });

    const res = await request(makeApp())
      .post('/api/travel/invoices/106/issue')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'SUB_BRAND_DENIED' });
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('non-numeric :id returns 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/invoices/oops/issue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID' });
    expect(prisma.travelInvoice.findFirst).not.toHaveBeenCalled();
  });

  test('audit row carries oldInvoiceNum + newInvoiceNum + subBrand in details', async () => {
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(
        draftInvoice({ id: 107, subBrand: 'tmc', invoiceNum: 'TINV-2026-0099' }),
      )
      .mockResolvedValueOnce(null);
    prisma.travelInvoice.update.mockImplementation(async ({ data }) =>
      draftInvoice({ id: 107, subBrand: 'tmc', ...data }),
    );

    const res = await request(makeApp())
      .post('/api/travel/invoices/107/issue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data).toMatchObject({
      entity: 'TravelInvoice',
      action: 'TRAVEL_INVOICE_ISSUED',
      entityId: 107,
      userId: 7,
      tenantId: 1,
    });
    // writeAudit JSON-stringifies details — parse and assert.
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({
      oldInvoiceNum: 'TINV-2026-0099',
      newInvoiceNum: `TMC/${FY_TODAY}/0001`,
      subBrand: 'tmc',
    });
  });

  test('cross-sub-brand counter independence: TMC and RFU each start at 0001', async () => {
    // First issue: TMC invoice -> the helper scans for "TMC/<FY>/" rows and
    // finds none, so it returns "TMC/<FY>/0001". Then a fresh issue: RFU
    // invoice -> the helper scans for "RFU/<FY>/" rows and ALSO finds none
    // (the prior TMC row doesn't match the RFU prefix's startsWith filter),
    // so RFU also starts at 0001. We simulate this by returning null from
    // BOTH nextSubBrandInvoiceNum lookups — that's exactly the contract:
    // the per-sub-brand counter is scoped by prefix, not global.
    prisma.travelInvoice.findFirst
      .mockResolvedValueOnce(draftInvoice({ id: 110, subBrand: 'tmc' }))
      .mockResolvedValueOnce(null) // TMC scan finds nothing
      .mockResolvedValueOnce(draftInvoice({ id: 111, subBrand: 'rfu' }))
      .mockResolvedValueOnce(null); // RFU scan finds nothing (independent of TMC)
    prisma.travelInvoice.update
      .mockImplementationOnce(async ({ data }) =>
        draftInvoice({ id: 110, subBrand: 'tmc', ...data }),
      )
      .mockImplementationOnce(async ({ data }) =>
        draftInvoice({ id: 111, subBrand: 'rfu', ...data }),
      );

    const app = makeApp();
    const r1 = await request(app)
      .post('/api/travel/invoices/110/issue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    const r2 = await request(app)
      .post('/api/travel/invoices/111/issue')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.invoiceNum).toBe(`TMC/${FY_TODAY}/0001`);
    expect(r2.body.invoiceNum).toBe(`RFU/${FY_TODAY}/0001`);
    // Their counters are TRULY independent — neither is 0002.
    expect(r1.body.invoiceNum).not.toBe(r2.body.invoiceNum);
  });
});
