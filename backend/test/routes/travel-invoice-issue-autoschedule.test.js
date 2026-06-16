// @ts-check
/**
 * Arc 2 #901 slice 17 — auto-create default 25/50/25 PaymentSchedule on
 * POST /api/travel/invoices/:id/issue (PRD_TRAVEL_BILLING UC-2.1 — Umrah
 * staged settlement).
 *
 * Pins the auto-schedule side-effect added to the slice-5 /:id/issue
 * handler. Slice 5 (`5da7bd2c`) shipped the Draft -> Issued transition +
 * per-sub-brand FY numbering; slice 6 (`af0c6709`) shipped the
 * TravelPaymentSchedule CRUD; this slice glues them together so a
 * freshly-issued invoice ships with a sensible default settlement plan
 * (25% at issue / 50% at T+21d / 25% at T+90d) UNLESS the operator
 * pre-populated their own schedule before calling /issue.
 *
 * Contracts asserted:
 *   1. Happy path: issuing a Draft invoice with no schedule creates 3
 *      milestone rows via createMany (orders 1/2/3, currency inherited
 *      from invoice, status='pending').
 *   2. Idempotency: if a schedule already exists (operator pre-customized),
 *      the auto-create is SKIPPED — createMany not called.
 *   3. Amount split: m1 + m2 + m3 === totalAmount EXACTLY (last milestone
 *      absorbs the rounding residual, so the schedule never drifts by 1
 *      paise from the invoice header).
 *   4. dueDate m1 = today (within 1 second of request time).
 *   5. dueDate m2 = today + 21 days (within 1 second).
 *   6. dueDate m3 = today + 90 days (within 1 second).
 *   7. expectedCurrency on all 3 rows === invoice.currency.
 *   8. status='pending' on all 3 rows.
 *   9. USER role -> 403 (auth gate trips before any schedule logic — no
 *      createMany, no invoice update).
 *  10. Audit row TRAVEL_INVOICE_ISSUED details include scheduleAutoCreated=true
 *      + milestoneCount=3 on auto-create path; scheduleAutoCreated=false
 *      when skipped.
 *
 * Rounding semantics decision: each of m1/m2 is computed as
 * `Math.round(total * 0.25 * 100) / 100` (independent 2-decimal rounding);
 * m3 = round2(total - m1 - m2) so it absorbs the 1-paise residual. This
 * matters for dashboard math — "outstanding = total - sum(received)"
 * would surface a permanent 1-paise drift if the three milestones were
 * each rounded independently. Chose total-minus-sum-of-prior over a
 * "largest-milestone absorbs" heuristic because the spec's last milestone
 * is the smallest (25%) and absorbing residual there is least
 * surprising to operators reviewing the schedule.
 *
 * Test pattern mirrors backend/test/routes/travel-invoice-issue.test.js
 * (slice 5) — patch the prisma singleton with vi.fn() shapes BEFORE the
 * router is required, then drive supertest with real HS256 JWTs.
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
prisma.travelPaymentSchedule = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn().mockResolvedValue({ count: 3 }),
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
    id: 200,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    invoiceNum: 'TINV-2026-0001',
    status: 'Draft',
    totalAmount: '120000.00',
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
  prisma.travelPaymentSchedule.findFirst.mockReset();
  prisma.travelPaymentSchedule.createMany.mockReset().mockResolvedValue({ count: 3 });
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

// Helper: drive a happy-path /issue request that ends with a createMany.
// Returns the parsed createMany args + response body.
async function issueAndCapture({
  invoiceId = 200,
  subBrand = 'tmc',
  totalAmount = '120000.00',
  currency = 'INR',
  existingSchedule = null,
  role = 'ADMIN',
} = {}) {
  const invoice = draftInvoice({ id: invoiceId, subBrand, totalAmount, currency });
  prisma.travelInvoice.findFirst
    .mockResolvedValueOnce(invoice)               // route-level load
    .mockResolvedValueOnce(null);                 // FY counter scan
  prisma.travelInvoice.update.mockImplementation(async ({ data }) => ({
    ...invoice,
    ...data,
  }));
  prisma.travelPaymentSchedule.findFirst.mockResolvedValueOnce(existingSchedule);

  const res = await request(makeApp())
    .post(`/api/travel/invoices/${invoiceId}/issue`)
    .set('Authorization', `Bearer ${tokenFor(role)}`);

  const cmCalls = prisma.travelPaymentSchedule.createMany.mock.calls;
  return {
    res,
    createManyCalled: cmCalls.length > 0,
    createManyArgs: cmCalls[0]?.[0],
    rows: cmCalls[0]?.[0]?.data,
  };
}

describe('POST /api/travel/invoices/:id/issue — auto-create 25/50/25 schedule', () => {
  test('happy path: 3 milestone rows created with correct orders + status', async () => {
    const t0 = Date.now();
    const { res, createManyCalled, rows } = await issueAndCapture({
      invoiceId: 200,
      totalAmount: '120000.00',
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Issued');
    expect(createManyCalled).toBe(true);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.milestoneOrder).sort()).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.every((r) => r.invoiceId === 200)).toBe(true);
    expect(rows.every((r) => r.tenantId === 1)).toBe(true);
    // Sanity: the test took less than 60s end-to-end, so the milestone-1
    // dueDate should be >= t0 and <= t0 + 60s.
    const m1 = rows.find((r) => r.milestoneOrder === 1);
    expect(m1.dueDate.getTime()).toBeGreaterThanOrEqual(t0);
    expect(m1.dueDate.getTime()).toBeLessThanOrEqual(t0 + 60_000);
  });

  test('idempotency: existing schedule -> skip auto-create (createMany not called)', async () => {
    const { res, createManyCalled } = await issueAndCapture({
      invoiceId: 201,
      existingSchedule: { id: 99, invoiceId: 201, milestoneOrder: 1 },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Issued');
    expect(createManyCalled).toBe(false);
  });

  test('amount split: m1 + m2 + m3 === totalAmount exactly (no 1-paise drift)', async () => {
    // 120000.00 splits cleanly: 30000 + 60000 + 30000.
    const { rows } = await issueAndCapture({
      invoiceId: 202,
      totalAmount: '120000.00',
    });
    const sum = rows.reduce((a, r) => a + Number(r.expectedAmount), 0);
    expect(sum).toBeCloseTo(120000.0, 2);
    expect(Number(rows.find((r) => r.milestoneOrder === 1).expectedAmount))
      .toBeCloseTo(30000.0, 2);
    expect(Number(rows.find((r) => r.milestoneOrder === 2).expectedAmount))
      .toBeCloseTo(60000.0, 2);
    expect(Number(rows.find((r) => r.milestoneOrder === 3).expectedAmount))
      .toBeCloseTo(30000.0, 2);
  });

  test('rounding residual absorbed by milestone 3 (uneven total)', async () => {
    // 100.01 splits as 25.00 + 50.01 + 25.00 (m3 absorbs the residual to
    // keep the sum exact). Without residual-absorption it'd be 25.00 +
    // 50.01 + 25.00 = 100.01 already, so try a trickier number:
    // 100.03 -> 25.0075 (-> 25.01) + 50.015 (-> 50.02 — banker's? no,
    // Math.round half-away-from-zero so 50.015 -> 50.02) + residual.
    // Whatever the rounding edges, m1 + m2 + m3 MUST equal 100.03.
    const { rows } = await issueAndCapture({
      invoiceId: 203,
      totalAmount: '100.03',
    });
    const sum = rows.reduce((a, r) => a + Number(r.expectedAmount), 0);
    expect(sum).toBeCloseTo(100.03, 2);
  });

  test('milestone 1 dueDate ≈ today (within 1 second of request time)', async () => {
    const before = Date.now();
    const { rows } = await issueAndCapture({ invoiceId: 204 });
    const after = Date.now();
    const m1 = rows.find((r) => r.milestoneOrder === 1);
    expect(m1.dueDate.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(m1.dueDate.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  test('milestone 2 dueDate = today + 21 days', async () => {
    const before = Date.now();
    const { rows } = await issueAndCapture({ invoiceId: 205 });
    const after = Date.now();
    const m2 = rows.find((r) => r.milestoneOrder === 2);
    expect(m2.dueDate.getTime()).toBeGreaterThanOrEqual(before + 21 * 86_400_000 - 1000);
    expect(m2.dueDate.getTime()).toBeLessThanOrEqual(after + 21 * 86_400_000 + 1000);
  });

  test('milestone 3 dueDate = today + 90 days', async () => {
    const before = Date.now();
    const { rows } = await issueAndCapture({ invoiceId: 206 });
    const after = Date.now();
    const m3 = rows.find((r) => r.milestoneOrder === 3);
    expect(m3.dueDate.getTime()).toBeGreaterThanOrEqual(before + 90 * 86_400_000 - 1000);
    expect(m3.dueDate.getTime()).toBeLessThanOrEqual(after + 90 * 86_400_000 + 1000);
  });

  test('all 3 rows inherit invoice.currency (USD invoice -> USD milestones)', async () => {
    const { rows } = await issueAndCapture({
      invoiceId: 207,
      currency: 'USD',
      totalAmount: '5000.00',
    });
    expect(rows.every((r) => r.expectedCurrency === 'USD')).toBe(true);
  });

  test('all 3 rows are status=pending', async () => {
    const { rows } = await issueAndCapture({ invoiceId: 208 });
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);
  });

  test('USER role -> 403 (no createMany, no invoice update)', async () => {
    // No findFirst stub needed — the RBAC gate short-circuits.
    const res = await request(makeApp())
      .post('/api/travel/invoices/200/issue')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);

    expect(res.status).toBe(403);
    expect(prisma.travelPaymentSchedule.createMany).not.toHaveBeenCalled();
    expect(prisma.travelInvoice.update).not.toHaveBeenCalled();
  });

  test('audit row carries scheduleAutoCreated=true + milestoneCount=3', async () => {
    await issueAndCapture({ invoiceId: 209 });
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArgs.data.action).toBe('TRAVEL_INVOICE_ISSUED');
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details).toMatchObject({
      scheduleAutoCreated: true,
      milestoneCount: 3,
    });
  });

  test('audit row carries scheduleAutoCreated=false when operator pre-populated schedule', async () => {
    await issueAndCapture({
      invoiceId: 210,
      existingSchedule: { id: 99, invoiceId: 210, milestoneOrder: 1 },
    });
    const auditArgs = prisma.auditLog.create.mock.calls[0][0];
    const details = typeof auditArgs.data.details === 'string'
      ? JSON.parse(auditArgs.data.details)
      : auditArgs.data.details;
    expect(details.scheduleAutoCreated).toBe(false);
    // milestoneCount NOT set on the skip path (omitted, not undefined-as-null).
    expect(details.milestoneCount).toBeUndefined();
  });
});
