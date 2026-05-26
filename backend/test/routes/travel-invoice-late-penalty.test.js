// @ts-check
/**
 * Arc 2 #901 slice 24 — TravelInvoice late-payment penalty endpoint
 * (PRD_TRAVEL_BILLING §3 — late-payment surcharge math).
 *
 * Pins the read-only late-payment-penalty preview endpoint added to
 * backend/routes/travel_invoices.js by slice 24:
 *
 *   GET /api/travel/invoices/:id/late-penalty       any verified token
 *
 * The endpoint is a pure compute — no Prisma writes, no audit, no
 * persistence. It surfaces what the penalty WOULD be if the operator
 * surcharged this overdue invoice as-of `asOf` (defaults to wall clock).
 *
 * Library consumer:
 *   - lib/latePenaltyCalculation.js (new this slice) — exports
 *     computeLatePenalty + DEFAULT_GRACE_DAYS (7) +
 *     DEFAULT_ANNUAL_RATE_PERCENT (18) + DEFAULT_FLAT_FEE_PERCENT (2).
 *
 * Contracts asserted:
 *   - 401 when no token.
 *   - 400 INVALID_ID when :id is not numeric.
 *   - 404 INVOICE_NOT_FOUND when missing or cross-tenant.
 *   - Defaults envelope (graceDays=7, annualRatePercent=18,
 *     flatFeePercent=2) echoed back regardless of overrides.
 *   - applies=false + reason='INVOICE_CLOSED' when status is Paid/Voided.
 *   - applies=false + reason='NO_DUE_DATE' when dueDate is null.
 *   - applies=false + reason='NOT_YET_DUE' when asOf <= dueDate.
 *   - applies=false + reason='IN_GRACE_WINDOW' when 0 < daysOverdue <= grace.
 *   - applies=true with simple-mode math:
 *       penalty = round2(principal * (annual/100) * (chargeableDays / 365))
 *     (e.g. ₹10,000 × 18% × (30/365) ≈ ₹147.95).
 *   - applies=true with flat-mode math: penalty = round2(principal * (flat/100))
 *     (e.g. ₹10,000 × 2% = ₹200).
 *   - graceDays override (e.g. 14) suppresses penalty for daysOverdue ≤ 14.
 *   - 400 INVALID_AS_OF when asOf is unparseable.
 *   - 400 INVALID_NUMERIC_QUERY when graceDays/annualRatePercent/flatFeePercent
 *     are non-numeric or negative.
 *   - 400 INVALID_MODE when mode is neither 'simple' nor 'flat'.
 *
 * Pattern mirrors backend/test/routes/travel-invoice-tcs-preview.test.js:
 * CJS prisma singleton patched BEFORE the router is required so
 * verifyToken's revokedToken probe + loadParentInvoice's findFirst probe
 * both hit stubs; HS256 JWT via the dev fallback secret.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.travelInvoice = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.travelInvoiceLine = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.$transaction = vi.fn(async (cb) => cb(prisma));
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.contact = prisma.contact || {};
prisma.contact.findUnique = vi.fn().mockResolvedValue(null);
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'USER', subBrandAccess: null });
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

function tokenFor(role = 'USER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function parentInvoice(overrides = {}) {
  return {
    id: 100,
    tenantId: 1,
    subBrand: 'tmc',
    contactId: 999,
    quoteId: null,
    invoiceNum: 'TINV-2026-0001',
    status: 'Issued',
    totalAmount: '10000.00',
    currency: 'INR',
    // 30 full days ago — past the 7-day default grace; ~23 chargeable days.
    dueDate: new Date(Date.now() - 30 * 86_400_000),
    paidAt: null,
    docType: 'TaxInvoice',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function defaultTenantFindUniqueImpl() {
  return Promise.resolve({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
}

beforeEach(() => {
  prisma.travelInvoice.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset().mockImplementation(defaultTenantFindUniqueImpl);
  prisma.contact.findUnique.mockReset().mockResolvedValue(null);
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'USER', subBrandAccess: null });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

describe('GET /api/travel/invoices/:id/late-penalty — auth + load gating', () => {
  test('401 when no token', async () => {
    const res = await request(makeApp()).get('/api/travel/invoices/100/late-penalty');
    expect(res.status).toBe(401);
  });

  test('400 INVALID_ID when :id is not numeric', async () => {
    const res = await request(makeApp())
      .get('/api/travel/invoices/not-a-number/late-penalty')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('404 INVOICE_NOT_FOUND when invoice missing', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/late-penalty')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INVOICE_NOT_FOUND');
  });
});

describe('GET /api/travel/invoices/:id/late-penalty — defaults envelope + non-applies branches', () => {
  test('envelope includes the system defaults (7d grace, 18% annual, 2% flat)', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/late-penalty')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.defaults).toEqual({
      graceDays: 7,
      annualRatePercent: 18,
      flatFeePercent: 2,
    });
    expect(res.body.invoiceId).toBe(100);
    expect(res.body.status).toBe('Issued');
    expect(res.body.totalAmount).toBe(10000);
  });

  test('Paid invoice → applies=false + reason INVOICE_CLOSED', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ status: 'Paid' }),
    );
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/late-penalty')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.applies).toBe(false);
    expect(res.body.reason).toBe('INVOICE_CLOSED');
    expect(res.body.penalty).toBe(0);
  });

  test('Voided invoice → applies=false + reason INVOICE_CLOSED', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ status: 'Voided' }),
    );
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/late-penalty')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.applies).toBe(false);
    expect(res.body.reason).toBe('INVOICE_CLOSED');
  });

  test('Issued invoice with null dueDate → applies=false + reason NO_DUE_DATE', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ dueDate: null }),
    );
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/late-penalty')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.applies).toBe(false);
    expect(res.body.reason).toBe('NO_DUE_DATE');
  });

  test('Issued invoice with dueDate in the future → applies=false + reason NOT_YET_DUE', async () => {
    const future = new Date(Date.now() + 5 * 86_400_000);
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ dueDate: future }),
    );
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/late-penalty')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.applies).toBe(false);
    expect(res.body.reason).toBe('NOT_YET_DUE');
    expect(res.body.daysOverdue).toBe(0);
  });

  test('Issued invoice 3 days overdue → applies=false + reason IN_GRACE_WINDOW', async () => {
    const due = new Date(Date.now() - 3 * 86_400_000);
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ dueDate: due }),
    );
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/late-penalty')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.applies).toBe(false);
    expect(res.body.reason).toBe('IN_GRACE_WINDOW');
    expect(res.body.daysOverdue).toBe(3);
    expect(res.body.chargeableDays).toBe(0);
  });
});

describe('GET /api/travel/invoices/:id/late-penalty — applies=true math (simple + flat)', () => {
  // Pin asOf to a stable epoch so the chargeableDays math is deterministic
  // (avoids drift between Date.now() when the request is built vs handled).
  const FROZEN_ASOF = '2026-06-01T00:00:00.000Z';
  // Due 30 full days before FROZEN_ASOF → 30 daysOverdue, 23 chargeable
  // after the 7-day default grace.
  const DUE_30D_BEFORE = new Date(
    new Date(FROZEN_ASOF).getTime() - 30 * 86_400_000,
  );

  test('simple-mode default: ₹10,000 × 18% × (23/365) ≈ ₹113.42', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ dueDate: DUE_30D_BEFORE }),
    );
    const res = await request(makeApp())
      .get(`/api/travel/invoices/100/late-penalty?asOf=${FROZEN_ASOF}`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.applies).toBe(true);
    expect(res.body.mode).toBe('simple');
    expect(res.body.ratePercent).toBe(18);
    expect(res.body.graceDays).toBe(7);
    expect(res.body.daysOverdue).toBe(30);
    expect(res.body.chargeableDays).toBe(23);
    // 10000 * 0.18 * 23 / 365 = 113.4246... → 113.42 half-up.
    expect(res.body.penalty).toBe(113.42);
    expect(res.body.newBalance).toBe(10113.42);
    expect(res.body.reason).toBeNull();
  });

  test('flat-mode override: ₹10,000 × 2% = ₹200 regardless of chargeable-day count', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ dueDate: DUE_30D_BEFORE }),
    );
    const res = await request(makeApp())
      .get(`/api/travel/invoices/100/late-penalty?asOf=${FROZEN_ASOF}&mode=flat`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.applies).toBe(true);
    expect(res.body.mode).toBe('flat');
    expect(res.body.ratePercent).toBe(2);
    expect(res.body.penalty).toBe(200);
    expect(res.body.newBalance).toBe(10200);
  });

  test('graceDays override (14) suppresses penalty for daysOverdue=10', async () => {
    const due10 = new Date(new Date(FROZEN_ASOF).getTime() - 10 * 86_400_000);
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ dueDate: due10 }),
    );
    const res = await request(makeApp())
      .get(`/api/travel/invoices/100/late-penalty?asOf=${FROZEN_ASOF}&graceDays=14`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.applies).toBe(false);
    expect(res.body.reason).toBe('IN_GRACE_WINDOW');
    expect(res.body.graceDays).toBe(14);
    expect(res.body.chargeableDays).toBe(0);
  });

  test('Partial-status invoice accrues penalty just like Issued', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ status: 'Partial', dueDate: DUE_30D_BEFORE }),
    );
    const res = await request(makeApp())
      .get(`/api/travel/invoices/100/late-penalty?asOf=${FROZEN_ASOF}`)
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.applies).toBe(true);
    expect(res.body.status).toBe('Partial');
    expect(res.body.penalty).toBeGreaterThan(0);
  });

  test('annualRatePercent override (24) increases penalty proportionally', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(
      parentInvoice({ dueDate: DUE_30D_BEFORE }),
    );
    const res = await request(makeApp())
      .get(
        `/api/travel/invoices/100/late-penalty?asOf=${FROZEN_ASOF}&annualRatePercent=24`,
      )
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(200);
    expect(res.body.ratePercent).toBe(24);
    // 10000 * 0.24 * 23 / 365 = 151.2328... → 151.23 half-up.
    expect(res.body.penalty).toBe(151.23);
  });
});

describe('GET /api/travel/invoices/:id/late-penalty — input validation', () => {
  test('400 INVALID_AS_OF when asOf cannot be parsed', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/late-penalty?asOf=not-a-date')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AS_OF');
  });

  test('400 INVALID_NUMERIC_QUERY when graceDays is negative', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/late-penalty?graceDays=-3')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NUMERIC_QUERY');
  });

  test('400 INVALID_NUMERIC_QUERY when annualRatePercent is non-numeric', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/late-penalty?annualRatePercent=abc')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NUMERIC_QUERY');
  });

  test('400 INVALID_MODE when mode is neither simple nor flat', async () => {
    prisma.travelInvoice.findFirst.mockResolvedValue(parentInvoice());
    const res = await request(makeApp())
      .get('/api/travel/invoices/100/late-penalty?mode=tiered')
      .set('Authorization', `Bearer ${tokenFor('USER')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MODE');
  });
});
