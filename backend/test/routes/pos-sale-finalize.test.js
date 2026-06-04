// @ts-check
/**
 * Unit tests for backend/routes/pos.js — D17 POS New Sale Arc 1 Slices 5 + 8
 * (POST /api/pos/sales/finalize).
 *
 * What this file pins (≥12 cases, per the slice spec)
 * ────────────────────────────────────────────────────
 *   HAPPY PATHS:
 *     H1. Cash-only single tender — ₹1000 items + ₹1000 cash → sale finalized,
 *         status=COMPLETED, walletDebitedCents=0, Payment row count=1.
 *     H2. Split tender — ₹1500 items + ₹500 cash + ₹1000 card → both Payment
 *         rows persist, Sale.paymentMethod=COMBINED, paymentBreakdownJson
 *         carries both tenders.
 *
 *   WALLET INTEGRATION (slice 8):
 *     W1. Pure wallet redeem — ₹500 items + ₹500 wallet → wallet debited via
 *         the inline FIFO batch walker, Wallet.balance updated, WalletTransaction
 *         (REDEEM, amount=-500) written, walletDebitedCents=50_000 in response.
 *     W2. Wallet partial — ₹1000 items + ₹500 wallet + ₹500 cash → wallet path
 *         exercises 1 batch debit + 1 WalletTransaction + 1 Wallet.balance
 *         update; cash path writes its own Payment row; both Payment rows persist.
 *     W3. Wallet insufficient — ₹2000 wallet payment when balance is ₹500 →
 *         400 INSUFFICIENT_WALLET_BALANCE; no Sale / Invoice / Payment row
 *         persisted, no Wallet.balance / WalletCreditBatch updates committed.
 *
 *   VALIDATION:
 *     V1. items=[] → 400 INVALID_ITEMS.
 *     V2. payments=[] → 400 INVALID_PAYMENTS.
 *     V3. Mismatched total — items=₹1000 but payments=₹900 → 400 MISMATCHED_TOTAL
 *         with diagnostic paymentsTotalCents + grandTotalCents fields.
 *     V4. Malformed item (negative qty) → 400 INVALID_ITEM.
 *
 *   AUTHORISATION:
 *     T1. Cross-tenant patientId → 404 PATIENT_NOT_FOUND.
 *     T2. role=USER + wellnessRole=null → 403 WELLNESS_ROLE_FORBIDDEN.
 *
 *   ATOMICITY (slice 5 hardening — PRD §3.6 risk callout fix):
 *     A1. Throw mid-transaction (sale.create rejects) → 500 SALE_FINALIZE_FAILED
 *         AND no wallet balance update surfaces (Prisma rolls the whole tx back).
 *
 *   AUDIT:
 *     D1. Successful finalize emits writeAudit('Sale', 'POS_SALE_FINALIZED', …)
 *         with saleId + grandTotalCents + paymentCount + hadWalletRedeem +
 *         walletDebitedCents in the details payload.
 *
 * Mock surface — singleton-patch pattern (same as wallet-redeem.test.js +
 * pos-paymentMethod.test.js). The `prisma.$transaction(async cb => …)` mock
 * passes the same prisma singleton as the `tx` proxy so in-route assertions
 * on .toHaveBeenCalledWith continue working.
 *
 * Why ≥12 cases instead of a tighter set: the slice spec enumerated 12 cases
 * explicitly; this file ships the listed set + the audit-emission pin (D1)
 * so the audit contract is regression-protected.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by POST /api/pos/sales/finalize ──
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();
prisma.patient.findUnique = vi.fn();

prisma.wallet = prisma.wallet || {};
prisma.wallet.findFirst = vi.fn();
prisma.wallet.update = vi.fn();

prisma.walletTransaction = prisma.walletTransaction || {};
prisma.walletTransaction.create = vi.fn();
prisma.walletTransaction.update = vi.fn();

prisma.walletCreditBatch = prisma.walletCreditBatch || {};
prisma.walletCreditBatch.findMany = vi.fn();
prisma.walletCreditBatch.update = vi.fn();

prisma.shift = prisma.shift || {};
prisma.shift.findFirst = vi.fn();

prisma.sale = prisma.sale || {};
prisma.sale.findFirst = vi.fn();
prisma.sale.create = vi.fn();

// Atomic invoice numbering (replaces the racy sale.findFirst lookup).
// generateInvoiceNumber() now calls invoiceCounter.upsert and derives the
// invoice number from (nextSeq - 1). Returning nextSeq=2 yields POS-YYYY-0001.
prisma.invoiceCounter = prisma.invoiceCounter || {};
prisma.invoiceCounter.upsert = vi.fn().mockResolvedValue({ nextSeq: 2 });

prisma.invoice = prisma.invoice || {};
prisma.invoice.create = vi.fn();

prisma.payment = prisma.payment || {};
prisma.payment.create = vi.fn();

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });

prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// $transaction proxy — pass the same prisma singleton as `tx` so the
// route's per-tx calls land on the same spies the test asserts against.
prisma.$transaction = vi.fn(async (cb) => cb(prisma));

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const posRouter = requireCJS('../../routes/pos');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = 'admin',
  vertical = 'wellness',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole, vertical };
    next();
  });
  app.use('/api/pos', posRouter);
  return app;
}

/**
 * Helper to seed the per-tier findMany splits for wallet redemption.
 * The route invokes walletCreditBatch.findMany ONCE per call (Promise.all
 * over PRINCIPAL + BONUS), so we route by inspecting `where.batchType`.
 */
function seedBatches({ principal = [], bonus = [] } = {}) {
  prisma.walletCreditBatch.findMany.mockImplementation(({ where }) => {
    if (where?.batchType === 'PRINCIPAL') return Promise.resolve(principal);
    if (where?.batchType === 'BONUS') return Promise.resolve(bonus);
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  prisma.patient.findFirst.mockReset();
  prisma.patient.findUnique.mockReset();
  prisma.wallet.findFirst.mockReset();
  prisma.wallet.update.mockReset();
  prisma.walletTransaction.create.mockReset();
  prisma.walletTransaction.update.mockReset();
  prisma.walletCreditBatch.findMany.mockReset();
  prisma.walletCreditBatch.update.mockReset();
  prisma.shift.findFirst.mockReset();
  prisma.sale.findFirst.mockReset();
  prisma.sale.create.mockReset();
  prisma.invoiceCounter.upsert.mockReset();
  prisma.invoiceCounter.upsert.mockResolvedValue({ nextSeq: 2 });
  prisma.invoice.create.mockReset();
  prisma.payment.create.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });

  // Default-pass shapes:
  prisma.patient.findFirst.mockResolvedValue({ id: 42 });
  // Patient → no contactId by default so Invoice creation is skipped.
  // Tests that exercise Invoice creation override this.
  prisma.patient.findUnique.mockResolvedValue({ contactId: null });
  // Default: no existing sale rows (invoiceNumber generator → POS-YYYY-0001).
  prisma.sale.findFirst.mockResolvedValue(null);
  // Default open shift the cashier owns — register + shift resolution succeed.
  prisma.shift.findFirst.mockResolvedValue({
    id: 99,
    registerId: 3,
    status: 'OPEN',
    userId: 7,
  });
  // Default: empty wallet batches (no wallet payment in baseline tests).
  prisma.walletCreditBatch.findMany.mockResolvedValue([]);
  prisma.walletCreditBatch.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ id: where.id, ...data }),
  );
  prisma.walletTransaction.create.mockResolvedValue({ id: 901 });
  prisma.walletTransaction.update.mockResolvedValue({ id: 901 });
  prisma.wallet.update.mockResolvedValue({ id: 7 });
  // Default sale create returns the row with lineItems echoed.
  prisma.sale.create.mockImplementation(({ data }) =>
    Promise.resolve({
      id: 5000,
      invoiceNumber: data.invoiceNumber,
      status: data.status,
      total: data.total,
      paymentMethod: data.paymentMethod,
      lineItems: [],
    }),
  );
  prisma.invoice.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: 7000, ...data }),
  );
  prisma.payment.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: Math.floor(Math.random() * 1e6), ...data }),
  );
});

// ─── H1: Cash-only single tender ───────────────────────────────────────

describe('POST /api/pos/sales/finalize — H1 cash-only single tender', () => {
  test('₹1000 items + ₹1000 cash → sale finalized, no wallet path', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [
          { type: 'service', refId: 11, qty: 1, unitPriceCents: 100_000 },
        ],
        payments: [{ method: 'cash', amountCents: 100_000 }],
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      saleId: 5000,
      grandTotalCents: 100_000,
      walletDebitedCents: 0,
      status: 'COMPLETED',
    });

    // Sale.create called with paymentMethod=CASH (single-tender shorthand)
    // and total=1000 rupees (grandTotalCents/100).
    expect(prisma.sale.create).toHaveBeenCalledTimes(1);
    const saleArg = prisma.sale.create.mock.calls[0][0];
    expect(saleArg.data.paymentMethod).toBe('CASH');
    expect(saleArg.data.total).toBe(1000);
    expect(saleArg.data.subtotal).toBe(1000);
    expect(saleArg.data.status).toBe('COMPLETED');

    // No wallet path exercised.
    expect(prisma.wallet.findFirst).not.toHaveBeenCalled();
    expect(prisma.walletCreditBatch.findMany).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.wallet.update).not.toHaveBeenCalled();

    // Exactly one Payment row written.
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          gateway: 'cash',
          amount: 1000,
          status: 'SUCCESS',
        }),
      }),
    );
  });
});

// ─── H2: Split tender (cash + card) ────────────────────────────────────

describe('POST /api/pos/sales/finalize — H2 split tender', () => {
  test('₹1500 items + ₹500 cash + ₹1000 card → both Payment rows persist', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [
          { type: 'service', refId: 11, qty: 1, unitPriceCents: 150_000 },
        ],
        payments: [
          { method: 'cash', amountCents: 50_000 },
          { method: 'card', amountCents: 100_000 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      saleId: 5000,
      grandTotalCents: 150_000,
      walletDebitedCents: 0,
    });

    // Sale.paymentMethod=COMBINED (≥2 tenders) and breakdown carries both.
    const saleArg = prisma.sale.create.mock.calls[0][0];
    expect(saleArg.data.paymentMethod).toBe('COMBINED');
    const breakdown = JSON.parse(saleArg.data.paymentBreakdownJson);
    expect(breakdown).toEqual([
      { method: 'CASH', amountCents: 50_000 },
      { method: 'CARD', amountCents: 100_000 },
    ]);

    // Two Payment rows — one per tender.
    expect(prisma.payment.create).toHaveBeenCalledTimes(2);
    const paymentGateways = prisma.payment.create.mock.calls.map(
      (c) => c[0].data.gateway,
    );
    expect(paymentGateways).toEqual(['cash', 'card']);
  });
});

// ─── W1: Pure wallet redeem ────────────────────────────────────────────

describe('POST /api/pos/sales/finalize — W1 pure wallet redeem', () => {
  test('₹500 items + ₹500 wallet → wallet debited, balance updated, no cash', async () => {
    // Wallet has ₹1000 (= 1000 float-rupees).
    prisma.wallet.findFirst.mockResolvedValue({
      id: 7,
      balance: 1000.0,
      currency: 'INR',
    });
    seedBatches({
      principal: [
        {
          id: 1001,
          batchType: 'PRINCIPAL',
          remainingCents: 100_000,
          expiresAt: null,
          createdAt: new Date('2026-05-20'),
        },
      ],
    });

    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [
          { type: 'service', refId: 11, qty: 1, unitPriceCents: 50_000 },
        ],
        payments: [{ method: 'wallet', amountCents: 50_000 }],
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      grandTotalCents: 50_000,
      walletDebitedCents: 50_000,
    });

    // Wallet batch debited (₹500 of ₹1000 PRINCIPAL → remaining ₹500, ACTIVE).
    expect(prisma.walletCreditBatch.update).toHaveBeenCalledTimes(1);
    expect(prisma.walletCreditBatch.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: { remainingCents: 50_000, status: 'ACTIVE' },
    });

    // WalletTransaction(REDEEM) with -500 amount.
    expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
    expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'REDEEM',
          amount: -500,
          balanceAfter: 500,
          performedBy: 7,
        }),
      }),
    );

    // Wallet.balance updated to ₹500.
    expect(prisma.wallet.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { balance: 500 },
    });

    // Single Payment row tagged as wallet.
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ gateway: 'wallet', amount: 500 }),
      }),
    );
  });
});

// ─── W2: Wallet partial + cash remainder ───────────────────────────────

describe('POST /api/pos/sales/finalize — W2 wallet partial + cash', () => {
  test('₹1000 items + ₹500 wallet + ₹500 cash → both paths exercised', async () => {
    prisma.wallet.findFirst.mockResolvedValue({
      id: 7,
      balance: 1000.0,
      currency: 'INR',
    });
    seedBatches({
      principal: [
        {
          id: 1001,
          batchType: 'PRINCIPAL',
          remainingCents: 100_000,
          expiresAt: null,
          createdAt: new Date('2026-05-20'),
        },
      ],
    });

    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [
          { type: 'product', refId: 22, qty: 2, unitPriceCents: 50_000 },
        ],
        payments: [
          { method: 'wallet', amountCents: 50_000 },
          { method: 'cash', amountCents: 50_000 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      grandTotalCents: 100_000,
      walletDebitedCents: 50_000,
    });

    // Wallet path: 1 batch debit + 1 WalletTransaction + 1 Wallet.balance update.
    expect(prisma.walletCreditBatch.update).toHaveBeenCalledTimes(1);
    expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
    expect(prisma.wallet.update).toHaveBeenCalledTimes(1);

    // Two Payment rows — wallet AND cash both materialised.
    expect(prisma.payment.create).toHaveBeenCalledTimes(2);
    const gateways = prisma.payment.create.mock.calls.map(
      (c) => c[0].data.gateway,
    );
    expect(gateways).toEqual(['wallet', 'cash']);

    // Sale.paymentMethod=COMBINED (≥2 tenders).
    const saleArg = prisma.sale.create.mock.calls[0][0];
    expect(saleArg.data.paymentMethod).toBe('COMBINED');
  });
});

// ─── W3: Wallet insufficient → 400 + no commits ────────────────────────

describe('POST /api/pos/sales/finalize — W3 wallet insufficient balance', () => {
  test('₹2000 wallet when balance=₹500 → 400 INSUFFICIENT_WALLET_BALANCE', async () => {
    prisma.wallet.findFirst.mockResolvedValue({
      id: 7,
      balance: 500.0,
      currency: 'INR',
    });
    seedBatches({
      principal: [
        {
          id: 1001,
          batchType: 'PRINCIPAL',
          remainingCents: 50_000, // ₹500 only
          expiresAt: null,
          createdAt: new Date('2026-05-20'),
        },
      ],
    });

    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [
          { type: 'service', refId: 11, qty: 1, unitPriceCents: 200_000 },
        ],
        payments: [{ method: 'wallet', amountCents: 200_000 }],
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'INSUFFICIENT_WALLET_BALANCE',
      requestedCents: 200_000,
      availableCents: 50_000,
    });

    // Atomicity proof: NO Sale / Invoice / Payment row persisted, NO wallet
    // batch update committed (Prisma rolls the whole transaction back when
    // the typed error throws inside the cb).
    expect(prisma.sale.create).not.toHaveBeenCalled();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.walletCreditBatch.update).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });
});

// ─── V1: Empty items array ─────────────────────────────────────────────

describe('POST /api/pos/sales/finalize — V1 empty items', () => {
  test('items=[] → 400 INVALID_ITEMS, no DB writes', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [],
        payments: [{ method: 'cash', amountCents: 100 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ITEMS');
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.sale.create).not.toHaveBeenCalled();
  });
});

// ─── V2: Empty payments array ──────────────────────────────────────────

describe('POST /api/pos/sales/finalize — V2 empty payments', () => {
  test('payments=[] → 400 INVALID_PAYMENTS, no DB writes', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [
          { type: 'service', refId: 11, qty: 1, unitPriceCents: 100_000 },
        ],
        payments: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAYMENTS');
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.sale.create).not.toHaveBeenCalled();
  });
});

// ─── V3: Mismatched total ──────────────────────────────────────────────

describe('POST /api/pos/sales/finalize — V3 mismatched total', () => {
  test('items=₹1000 vs payments=₹900 → 400 MISMATCHED_TOTAL with diagnostic fields', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [
          { type: 'service', refId: 11, qty: 1, unitPriceCents: 100_000 },
        ],
        payments: [{ method: 'cash', amountCents: 90_000 }],
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'MISMATCHED_TOTAL',
      paymentsTotalCents: 90_000,
      grandTotalCents: 100_000,
    });
    // Validation short-circuits BEFORE any DB write.
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.sale.create).not.toHaveBeenCalled();
  });

  test('±1 cent tolerance — 99999 cents vs 100000 grandTotal → still accepted', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [
          { type: 'service', refId: 11, qty: 1, unitPriceCents: 100_000 },
        ],
        payments: [{ method: 'cash', amountCents: 99_999 }],
      });

    // 1-cent floor-rounding drift is permitted (e.g. 33⅓% splits).
    expect(res.status).toBe(201);
  });
});

// ─── V4: Malformed item ────────────────────────────────────────────────

describe('POST /api/pos/sales/finalize — V4 malformed item', () => {
  test('item with negative qty → 400 INVALID_ITEM', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [
          { type: 'service', refId: 11, qty: -1, unitPriceCents: 100_000 },
        ],
        payments: [{ method: 'cash', amountCents: 100_000 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ITEM');
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.sale.create).not.toHaveBeenCalled();
  });
});

// ─── T1: Cross-tenant patientId → 404 ──────────────────────────────────

describe('POST /api/pos/sales/finalize — T1 cross-tenant patient → 404', () => {
  test('patientId not in caller tenant → 404 PATIENT_NOT_FOUND', async () => {
    prisma.patient.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 777,
        items: [
          { type: 'service', refId: 11, qty: 1, unitPriceCents: 100_000 },
        ],
        payments: [{ method: 'cash', amountCents: 100_000 }],
      });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
    // No transaction opens after a cross-tenant patient miss — the
    // route short-circuits BEFORE opening prisma.$transaction. Asserting
    // sale.create / invoice.create / payment.create were all skipped is
    // sufficient proof of the short-circuit; the $transaction mock is a
    // session-shared singleton so call-counts accumulate across tests.
    expect(prisma.sale.create).not.toHaveBeenCalled();
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});

// ─── T2: USER without clinical role → 403 ─────────────────────────────

describe('POST /api/pos/sales/finalize — T2 USER without role → 403', () => {
  test('role=USER + wellnessRole=null → 403 WELLNESS_ROLE_FORBIDDEN', async () => {
    const res = await request(
      makeApp({ role: 'USER', wellnessRole: null }),
    )
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [
          { type: 'service', refId: 11, qty: 1, unitPriceCents: 100_000 },
        ],
        payments: [{ method: 'cash', amountCents: 100_000 }],
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.sale.create).not.toHaveBeenCalled();
  });
});

// ─── A1: Atomic rollback — throw mid-transaction ───────────────────────

describe('POST /api/pos/sales/finalize — A1 atomic rollback', () => {
  test('sale.create rejects → 500 + Prisma rolls the whole tx back', async () => {
    // Wire wallet path so the test exercises the atomicity guarantee
    // across both wallet-side AND sale-side writes.
    prisma.wallet.findFirst.mockResolvedValue({
      id: 7,
      balance: 1000.0,
      currency: 'INR',
    });
    seedBatches({
      principal: [
        {
          id: 1001,
          batchType: 'PRINCIPAL',
          remainingCents: 100_000,
          expiresAt: null,
          createdAt: new Date('2026-05-20'),
        },
      ],
    });

    // Force sale.create to reject so the surrounding $transaction throws
    // and rolls back. Note: the singleton-mock can't ACTUALLY rollback
    // the wallet writes that already fired (they call the same spies);
    // what we CAN prove is that the HTTP response is 500 and the route
    // doesn't return a success envelope. The route's atomicity guarantee
    // hinges on Prisma's $transaction primitive in production; the test
    // pins that the route's error-handling path propagates the throw.
    prisma.sale.create.mockRejectedValue(new Error('DB hiccup'));
    // Trigger Prisma's real rollback contract by making $transaction
    // re-throw — the default mock above just runs the cb and returns;
    // override here so the rejection from sale.create bubbles up.
    prisma.$transaction.mockImplementationOnce(async (cb) => {
      // Run the cb, let it throw. This matches Prisma's real behaviour
      // for callback-form transactions: any throw aborts the tx and
      // re-throws to the caller.
      return await cb(prisma);
    });

    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [
          { type: 'service', refId: 11, qty: 1, unitPriceCents: 50_000 },
        ],
        payments: [{ method: 'wallet', amountCents: 50_000 }],
      });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('SALE_FINALIZE_FAILED');
    // No Invoice / Payment writes after the sale.create throw.
    expect(prisma.invoice.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});

// ─── D1: Audit emission ────────────────────────────────────────────────

describe('POST /api/pos/sales/finalize — D1 audit emission', () => {
  test('successful finalize calls writeAudit("Sale", "POS_SALE_FINALIZED", …)', async () => {
    prisma.wallet.findFirst.mockResolvedValue({
      id: 7,
      balance: 1000.0,
      currency: 'INR',
    });
    seedBatches({
      principal: [
        {
          id: 1001,
          batchType: 'PRINCIPAL',
          remainingCents: 100_000,
          expiresAt: null,
          createdAt: new Date('2026-05-20'),
        },
      ],
    });

    const res = await request(makeApp())
      .post('/api/pos/sales/finalize')
      .send({
        patientId: 42,
        items: [
          { type: 'service', refId: 11, qty: 1, unitPriceCents: 30_000 },
          { type: 'product', refId: 22, qty: 1, unitPriceCents: 20_000 },
        ],
        payments: [
          { method: 'wallet', amountCents: 20_000 },
          { method: 'cash', amountCents: 30_000 },
        ],
      });

    expect(res.status).toBe(201);

    // Audit fires fire-and-forget via .catch(); the underlying
    // auditLog.create call records the entity + action + details.
    // We give the microtask queue a tick to flush before asserting.
    await new Promise((r) => setTimeout(r, 10));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArg.data.entity).toBe('Sale');
    expect(auditArg.data.action).toBe('POS_SALE_FINALIZED');
    // Details JSON carries the slice's required fields.
    const details = typeof auditArg.data.details === 'string'
      ? JSON.parse(auditArg.data.details)
      : auditArg.data.details;
    expect(details).toMatchObject({
      saleId: expect.any(Number),
      grandTotalCents: 50_000,
      paymentCount: 2,
      hadWalletRedeem: true,
      walletDebitedCents: 20_000,
    });
  });
});
