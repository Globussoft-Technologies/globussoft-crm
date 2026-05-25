// @ts-check
/**
 * Unit tests for backend/routes/wallet.js — D16 Wallet Top-up Arc 1
 * Slice 3 (POST /api/wallet/:patientId/topup).
 *
 * What this file pins
 * ───────────────────
 *   HAPPY PATHS:
 *     H1. No-rule path — ₹1000 (100_000 cents) top-up writes 1
 *         WalletTransaction (type='TOP_UP') + 1 PRINCIPAL batch
 *         (remainingCents=100_000, expiresAt=null, sourceRuleId=null).
 *         Wallet.balance updated +10.00. bonusCents=0, bonusBatchId=null.
 *     H2. With-rule path — ₹1000 + active 10%-bonus rule on minAmountCents
 *         ≤ 50_000 → 1 PRINCIPAL (100_000) + 1 BONUS (10_000) batch.
 *         BONUS batch has expiresAt populated, sourceRuleId set.
 *
 *   BONUS-RULE ENGINE (DD-5.2 highest-percent-wins):
 *     B1. Two active rules (5% min 50_000, 10% min 50_000) both match
 *         → 10% applied (highest-percent-wins).
 *     B2. Below threshold — rule.minAmountCents=200_000 but top-up is
 *         100_000 → no bonus (rule filtered out by findMany).
 *     B3. Inactive rule — rule.active=false → not in candidate set.
 *     B4. Expired rule — rule.validTo < now → not in candidate set.
 *
 *   ATOMICITY:
 *     A1. `$transaction` callback throws mid-flight → no partial rows
 *         persisted (Prisma rolls back; we verify via the mock that
 *         the route surfaces 500 + TOPUP_FAILED).
 *
 *   VALIDATION:
 *     V1. amountCents=0 → 400 INVALID_AMOUNT.
 *     V2. amountCents > 10_000_000 → 400 INVALID_AMOUNT.
 *     V3. paymentMethod invalid (e.g. 'cheque') → 400
 *         INVALID_PAYMENT_METHOD.
 *
 *   AUTHORISATION:
 *     P1. Cross-tenant patientId — caller's tenant has no patient with
 *         that id → 404 PATIENT_NOT_FOUND (NOT 403 — we never leak
 *         cross-tenant existence).
 *     P2. role=USER + no wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN
 *         (the topupGate fires before the handler body runs).
 *
 * Mocked Prisma — same singleton-patch pattern as the existing
 * wallet.test.js + wellness-patients-bulk-tags.test.js. We mock the
 * `prisma.$transaction(async cb => …)` to execute the callback against
 * a sibling `tx` object that proxies every delegate the route uses, so
 * the in-route assertions still flow against vi.fn() spies.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by routes/wallet.js + wellnessRole gate ──
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();

prisma.wallet = prisma.wallet || {};
prisma.wallet.findFirst = vi.fn();
prisma.wallet.create = vi.fn();
prisma.wallet.update = vi.fn();

prisma.walletTransaction = prisma.walletTransaction || {};
prisma.walletTransaction.create = vi.fn();
prisma.walletTransaction.findMany = vi.fn();
prisma.walletTransaction.count = vi.fn();

prisma.walletBonusRule = prisma.walletBonusRule || {};
prisma.walletBonusRule.findMany = vi.fn();

prisma.walletCreditBatch = prisma.walletCreditBatch || {};
prisma.walletCreditBatch.create = vi.fn();

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness', defaultCurrency: 'INR' });

prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

// $transaction callback: replay against a `tx` proxy whose delegates
// are the same vi.fn() spies. This lets in-test assertions on
// .toHaveBeenCalledWith continue working unchanged. The route uses
// tx.wallet.findFirst/create/update, tx.walletTransaction.create,
// tx.walletCreditBatch.create, tx.tenant.findUnique.
prisma.$transaction = vi.fn(async (cb) => {
  const tx = {
    wallet: prisma.wallet,
    walletTransaction: prisma.walletTransaction,
    walletCreditBatch: prisma.walletCreditBatch,
    tenant: prisma.tenant,
  };
  return cb(tx);
});

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const walletRouter = requireCJS('../../routes/wallet');

function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = null,
  vertical = 'wellness',
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role, wellnessRole, vertical };
    next();
  });
  app.use('/api/wallet', walletRouter);
  return app;
}

beforeEach(() => {
  prisma.patient.findFirst.mockReset();
  prisma.wallet.findFirst.mockReset();
  prisma.wallet.create.mockReset();
  prisma.wallet.update.mockReset();
  prisma.walletTransaction.create.mockReset();
  prisma.walletBonusRule.findMany.mockReset();
  prisma.walletCreditBatch.create.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness', defaultCurrency: 'INR' });

  // Default-pass shapes so individual tests only override what they're
  // pinning. Wallet exists with balance 0; no bonus rules; transaction
  // + batch creates return autoincrement ids.
  prisma.patient.findFirst.mockResolvedValue({ id: 42 });
  prisma.wallet.findFirst.mockResolvedValue({ id: 7, balance: 0, currency: 'INR' });
  prisma.walletBonusRule.findMany.mockResolvedValue([]);
  prisma.walletTransaction.create.mockResolvedValue({ id: 901 });
  prisma.walletCreditBatch.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: data.batchType === 'PRINCIPAL' ? 1001 : 1002, ...data }),
  );
  prisma.wallet.update.mockResolvedValue({ id: 7 });
});

// ─── H1: Happy path, no rule ────────────────────────────────────────────

describe('POST /api/wallet/:patientId/topup — H1 happy path no rule', () => {
  test('₹1000 top-up creates 1 WalletTransaction + 1 PRINCIPAL batch (no bonus)', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/42/topup')
      .send({ amountCents: 100_000, paymentMethod: 'cash' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      walletId: 7,
      transactionId: 901,
      balanceCents: 100_000,
      principalBatchId: 1001,
      bonusBatchId: null,
      bonusRuleId: null,
      bonusPercent: 0,
    });

    // Exactly 1 WalletTransaction written, with type='TOP_UP'.
    expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
    expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          walletId: 7,
          type: 'TOP_UP',
          amount: 1000, // float-rupees
          balanceAfter: 1000,
          performedBy: 7,
        }),
      }),
    );

    // Exactly 1 PRINCIPAL batch (no bonus call).
    expect(prisma.walletCreditBatch.create).toHaveBeenCalledTimes(1);
    expect(prisma.walletCreditBatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          batchType: 'PRINCIPAL',
          amountCents: 100_000,
          remainingCents: 100_000,
          expiresAt: null,
          sourceRuleId: null,
          sourceTransactionId: 901,
        }),
      }),
    );

    // Balance updated.
    expect(prisma.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: { balance: 1000 },
      }),
    );
  });
});

// ─── H2: Happy path, with rule (10% bonus on ≥ ₹500) ────────────────────

describe('POST /api/wallet/:patientId/topup — H2 happy path with bonus rule', () => {
  test('active 10% rule + ₹1000 top-up → 1 PRINCIPAL + 1 BONUS (₹100) batch with expiresAt', async () => {
    prisma.walletBonusRule.findMany.mockResolvedValue([
      {
        id: 50,
        name: '10% top-up bonus',
        minAmountCents: 50_000,
        bonusPercent: 10,
        validityMonths: 6,
        active: true,
        validFrom: null,
        validTo: null,
      },
    ]);

    const res = await request(makeApp())
      .post('/api/wallet/42/topup')
      .send({ amountCents: 100_000, paymentMethod: 'upi' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      walletId: 7,
      transactionId: 901,
      balanceCents: 110_000, // 100_000 principal + 10_000 bonus = 110_000 cents
      principalBatchId: 1001,
      bonusBatchId: 1002,
      bonusRuleId: 50,
      bonusPercent: 10,
    });

    // 2 batch writes: PRINCIPAL then BONUS.
    expect(prisma.walletCreditBatch.create).toHaveBeenCalledTimes(2);
    const firstBatchData = prisma.walletCreditBatch.create.mock.calls[0][0].data;
    const secondBatchData = prisma.walletCreditBatch.create.mock.calls[1][0].data;
    expect(firstBatchData.batchType).toBe('PRINCIPAL');
    expect(firstBatchData.amountCents).toBe(100_000);
    expect(firstBatchData.expiresAt).toBeNull();
    expect(secondBatchData.batchType).toBe('BONUS');
    expect(secondBatchData.amountCents).toBe(10_000);
    expect(secondBatchData.remainingCents).toBe(10_000);
    expect(secondBatchData.sourceRuleId).toBe(50);
    expect(secondBatchData.expiresAt).toBeInstanceOf(Date);
    expect(secondBatchData.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

// ─── B1: Highest-percent-wins (DD-5.2) ──────────────────────────────────

describe('POST /api/wallet/:patientId/topup — B1 highest-percent-wins', () => {
  test('two active rules (5% and 10%) → 10% applied', async () => {
    prisma.walletBonusRule.findMany.mockResolvedValue([
      {
        id: 50,
        name: '5% bonus',
        minAmountCents: 50_000,
        bonusPercent: 5,
        validityMonths: 6,
        active: true,
        validFrom: null,
        validTo: null,
      },
      {
        id: 51,
        name: '10% bonus',
        minAmountCents: 50_000,
        bonusPercent: 10,
        validityMonths: 6,
        active: true,
        validFrom: null,
        validTo: null,
      },
    ]);

    const res = await request(makeApp())
      .post('/api/wallet/42/topup')
      .send({ amountCents: 100_000, paymentMethod: 'card' });

    expect(res.status).toBe(200);
    expect(res.body.bonusRuleId).toBe(51);
    expect(res.body.bonusPercent).toBe(10);
    expect(res.body.balanceCents).toBe(110_000); // 100_000 + 10% = 110_000
  });
});

// ─── B2: Below threshold ────────────────────────────────────────────────

describe('POST /api/wallet/:patientId/topup — B2 below-threshold no bonus', () => {
  test('rule.minAmountCents=200_000, top-up 100_000 → no bonus applied', async () => {
    // The route's Prisma `where: { minAmountCents: { lte: amountCents } }`
    // filter does the rejection — simulate by returning an empty array
    // (which is what findMany would return for this filter shape).
    prisma.walletBonusRule.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/api/wallet/42/topup')
      .send({ amountCents: 100_000, paymentMethod: 'cash' });

    expect(res.status).toBe(200);
    expect(res.body.bonusRuleId).toBeNull();
    expect(res.body.bonusBatchId).toBeNull();
    expect(res.body.bonusPercent).toBe(0);
    expect(prisma.walletCreditBatch.create).toHaveBeenCalledTimes(1); // PRINCIPAL only

    // Verify the SQL filter actually carries the minAmountCents bound so
    // a misconfigured rule of 200_000 would have been excluded by the DB
    // (not by us post-hoc).
    expect(prisma.walletBonusRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 1,
          active: true,
          minAmountCents: { lte: 100_000 },
        }),
      }),
    );
  });
});

// ─── B3: Inactive rule ──────────────────────────────────────────────────

describe('POST /api/wallet/:patientId/topup — B3 inactive rule not applied', () => {
  test('the active=true filter is applied at the DB layer', async () => {
    prisma.walletBonusRule.findMany.mockResolvedValue([]); // inactive rules filtered server-side

    const res = await request(makeApp())
      .post('/api/wallet/42/topup')
      .send({ amountCents: 100_000, paymentMethod: 'cash' });

    expect(res.status).toBe(200);
    expect(res.body.bonusRuleId).toBeNull();
    // The route SQL must always include active:true so inactive rules
    // never enter the candidate set.
    expect(prisma.walletBonusRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ active: true }),
      }),
    );
  });
});

// ─── B4: Expired rule ───────────────────────────────────────────────────

describe('POST /api/wallet/:patientId/topup — B4 expired rule not applied', () => {
  test('validTo < now filter shows up in the SQL WHERE clause', async () => {
    prisma.walletBonusRule.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/api/wallet/42/topup')
      .send({ amountCents: 100_000, paymentMethod: 'cash' });

    expect(res.status).toBe(200);
    expect(res.body.bonusRuleId).toBeNull();
    // The route SQL must include validTo>now (OR NULL) so expired rules
    // never enter the candidate set. We assert the shape was generated.
    const callArg = prisma.walletBonusRule.findMany.mock.calls[0][0];
    const andClause = callArg.where.AND;
    expect(Array.isArray(andClause)).toBe(true);
    // The second AND entry is the validTo window check.
    const validToCheck = andClause[1];
    expect(validToCheck).toEqual({
      OR: [{ validTo: null }, { validTo: { gt: expect.any(Date) } }],
    });
  });
});

// ─── A1: Atomic transaction — no partial rows on mid-flight failure ─────

describe('POST /api/wallet/:patientId/topup — A1 atomic transaction', () => {
  test('throw mid-transaction → 500 TOPUP_FAILED + no partial commits surfaced', async () => {
    // Simulate a transaction-time failure: principal batch write rejects.
    prisma.walletCreditBatch.create.mockRejectedValueOnce(
      new Error('DB constraint violation'),
    );

    const res = await request(makeApp())
      .post('/api/wallet/42/topup')
      .send({ amountCents: 100_000, paymentMethod: 'cash' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'TOPUP_FAILED' });
    // The wallet.update for new balance must NOT have been called —
    // the route reaches it AFTER the batch writes, so if the batch
    // throws we never reach balance mutation. (Real Prisma rolls back
    // the whole tx; here we verify the call-order guarantee.)
    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });
});

// ─── V1: amountCents = 0 ────────────────────────────────────────────────

describe('POST /api/wallet/:patientId/topup — V1 amountCents=0 → 400', () => {
  test('zero amount → 400 INVALID_AMOUNT, no DB writes', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/42/topup')
      .send({ amountCents: 0, paymentMethod: 'cash' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.walletCreditBatch.create).not.toHaveBeenCalled();
  });
});

// ─── V2: amountCents > 10M ──────────────────────────────────────────────

describe('POST /api/wallet/:patientId/topup — V2 amountCents > 10M → 400', () => {
  test('amount cap exceeded → 400 INVALID_AMOUNT', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/42/topup')
      .send({ amountCents: 10_000_001, paymentMethod: 'cash' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });
});

// ─── V3: invalid paymentMethod ──────────────────────────────────────────

describe('POST /api/wallet/:patientId/topup — V3 invalid paymentMethod → 400', () => {
  test("paymentMethod='cheque' → 400 INVALID_PAYMENT_METHOD", async () => {
    const res = await request(makeApp())
      .post('/api/wallet/42/topup')
      .send({ amountCents: 100_000, paymentMethod: 'cheque' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAYMENT_METHOD');
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  test('paymentMethod accepts cash/card/upi/online (positive control)', async () => {
    for (const method of ['cash', 'card', 'upi', 'online']) {
      prisma.walletTransaction.create.mockClear();
      const res = await request(makeApp())
        .post('/api/wallet/42/topup')
        .send({ amountCents: 100_000, paymentMethod: method });
      expect(res.status).toBe(200);
      expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
    }
  });
});

// ─── P1: cross-tenant patientId → 404 ───────────────────────────────────

describe('POST /api/wallet/:patientId/topup — P1 cross-tenant 404', () => {
  test("patient in tenant B → ADMIN of tenant A gets 404 (not 403)", async () => {
    prisma.patient.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/wallet/777/topup')
      .send({ amountCents: 100_000, paymentMethod: 'cash' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
    // No subsequent writes — the existence guard fires before the
    // wallet/transaction/batch surface.
    expect(prisma.walletBonusRule.findMany).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });
});

// ─── P2: USER with no wellness role → 403 ───────────────────────────────

describe('POST /api/wallet/:patientId/topup — P2 USER without clinical role → 403', () => {
  test("role=USER + wellnessRole=null → 403 WELLNESS_ROLE_FORBIDDEN", async () => {
    const res = await request(makeApp({ role: 'USER', wellnessRole: null }))
      .post('/api/wallet/42/topup')
      .send({ amountCents: 100_000, paymentMethod: 'cash' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WELLNESS_ROLE_FORBIDDEN' });
    // Gate fires before the handler body — no patient/wallet/tx writes.
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  test('wellnessRole=cashier passes the gate (positive control)', async () => {
    const res = await request(
      makeApp({ role: 'USER', wellnessRole: 'cashier' }),
    )
      .post('/api/wallet/42/topup')
      .send({ amountCents: 100_000, paymentMethod: 'cash' });

    expect(res.status).toBe(200);
    expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
  });

  test('wellnessRole=helper is BLOCKED (helpers do not handle money)', async () => {
    const res = await request(
      makeApp({ role: 'USER', wellnessRole: 'helper' }),
    )
      .post('/api/wallet/42/topup')
      .send({ amountCents: 100_000, paymentMethod: 'cash' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });
});
