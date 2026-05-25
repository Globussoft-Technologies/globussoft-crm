// @ts-check
/**
 * Unit tests for backend/routes/wallet.js — D16 Wallet Top-up Arc 1
 * Slice 4 (POST /api/wallet/:patientId/redeem).
 *
 * What this file pins (≥12 cases, per the slice spec)
 * ────────────────────────────────────────────────────
 *   HAPPY PATHS:
 *     H1. ₹500 redeem against wallet with ₹1000 PRINCIPAL only — single
 *         batch debited; remaining=₹500; transaction logged as -500.
 *     H2. Multi-batch debit — ₹2000 redeem against ₹1000 PRINCIPAL_1
 *         (older) + ₹1000 PRINCIPAL_2 — both fully consumed,
 *         status='EXHAUSTED' on both.
 *
 *   REDEMPTION PRIORITY (DD-5.3 — customer-fair pattern):
 *     P1. Bonus untouched when principal covers the redeem — ₹500 redeem
 *         from ₹1000 PRINCIPAL + ₹500 BONUS(tomorrow) → PRINCIPAL goes
 *         first (FIFO), bonus untouched.
 *     P2. Expired bonus skipped — wallet has ₹500 BONUS expiresAt=yesterday;
 *         not counted in balance OR debit pool.
 *     P3. Soonest-expiry bonus picked first — 2 BONUS batches
 *         (expiresAt=Jun-01 and expiresAt=May-30); May-30 consumed before
 *         Jun-01.
 *
 *   BALANCE GUARD:
 *     B1. Insufficient balance — redeem ₹2000 from ₹1500 total → 400
 *         INSUFFICIENT_BALANCE with both `availableCents` + `requestedCents`.
 *     B2. Empty wallet (no batches) → 400 INSUFFICIENT_BALANCE (zero
 *         available, zero updates).
 *
 *   ATOMICITY:
 *     A1. Throw mid-batch-update → 500 REDEEM_FAILED + Prisma rolls back;
 *         no balance update surfaced.
 *
 *   VALIDATION:
 *     V1. amountCents=0 → 400 INVALID_AMOUNT.
 *     V2. sourceType='X' → 400 INVALID_SOURCE_TYPE.
 *     V3. sourceId=null → 400 INVALID_SOURCE_ID.
 *
 *   AUTHORISATION:
 *     T1. Cross-tenant patientId → 404 PATIENT_NOT_FOUND.
 *     T2. role=USER + no wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN.
 *
 * Mocked Prisma — singleton-patch pattern matching wallet-topup.test.js.
 * The `prisma.$transaction(async cb => …)` mock replays the callback
 * against a `tx` proxy whose delegates are the same vi.fn() spies, so
 * in-route assertions on .toHaveBeenCalledWith continue working.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by routes/wallet.js redeem path. ──
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
prisma.walletCreditBatch.findMany = vi.fn();
prisma.walletCreditBatch.update = vi.fn();

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  vertical: 'wellness',
  defaultCurrency: 'INR',
});

prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

// $transaction proxy — same pattern as wallet-topup.test.js.
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

/**
 * Helper to seed the per-tier findMany splits. The route invokes
 * walletCreditBatch.findMany ONCE per call (Promise.all over PRINCIPAL +
 * BONUS), so we route by inspecting `where.batchType`.
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
  prisma.wallet.findFirst.mockReset();
  prisma.wallet.update.mockReset();
  prisma.walletTransaction.create.mockReset();
  prisma.walletCreditBatch.findMany.mockReset();
  prisma.walletCreditBatch.update.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });

  // Default-pass shapes: patient + wallet exist with ₹1000 balance; no
  // batches by default (individual tests seed via seedBatches).
  prisma.patient.findFirst.mockResolvedValue({ id: 42 });
  // Default ₹1000 = 1000 float-rupees (Wallet.balance is a Float column in
  // rupees). Tests that need a different starting balance override this.
  prisma.wallet.findFirst.mockResolvedValue({ id: 7, balance: 1000.0, currency: 'INR' });
  prisma.walletCreditBatch.findMany.mockResolvedValue([]);
  prisma.walletCreditBatch.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ id: where.id, ...data }),
  );
  prisma.walletTransaction.create.mockResolvedValue({ id: 901 });
  prisma.wallet.update.mockResolvedValue({ id: 7 });
});

// ─── H1: Happy path — single PRINCIPAL batch ────────────────────────────

describe('POST /api/wallet/:patientId/redeem — H1 single PRINCIPAL batch', () => {
  test('₹500 redeem from ₹1000 PRINCIPAL → single batch debited, remaining=₹500', async () => {
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
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 50_000, sourceType: 'VISIT', sourceId: 123 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      transactionId: 901,
      debitedFromBatches: [
        { batchId: 1001, batchType: 'PRINCIPAL', consumedCents: 50_000 },
      ],
      remainingBalanceCents: 50_000,
    });

    // Exactly 1 batch update with remainingCents=50_000, status='ACTIVE'.
    expect(prisma.walletCreditBatch.update).toHaveBeenCalledTimes(1);
    expect(prisma.walletCreditBatch.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: { remainingCents: 50_000, status: 'ACTIVE' },
    });

    // Ledger row written with type=REDEEM, negative amount, visitId set.
    expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
    expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          walletId: 7,
          type: 'REDEEM',
          amount: -500,
          visitId: 123,
          invoiceId: null,
          balanceAfter: 500, // ₹1000 − ₹500 = ₹500
          performedBy: 7,
        }),
      }),
    );

    // Wallet balance debited.
    expect(prisma.wallet.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { balance: 500 },
    });
  });
});

// ─── H2: Multi-batch debit, both fully consumed ─────────────────────────

describe('POST /api/wallet/:patientId/redeem — H2 multi-batch debit', () => {
  test('₹2000 redeem against 2x ₹1000 PRINCIPAL → both EXHAUSTED', async () => {
    prisma.wallet.findFirst.mockResolvedValue({
      id: 7,
      balance: 2000.0, // ₹2000 = 2000 float-rupees
      currency: 'INR',
    });
    seedBatches({
      principal: [
        {
          id: 1001, // older — FIFO first
          batchType: 'PRINCIPAL',
          remainingCents: 100_000,
          expiresAt: null,
          createdAt: new Date('2026-05-10'),
        },
        {
          id: 1002,
          batchType: 'PRINCIPAL',
          remainingCents: 100_000,
          expiresAt: null,
          createdAt: new Date('2026-05-20'),
        },
      ],
    });

    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 200_000, sourceType: 'SALE', sourceId: 555 });

    expect(res.status).toBe(200);
    expect(res.body.debitedFromBatches).toEqual([
      { batchId: 1001, batchType: 'PRINCIPAL', consumedCents: 100_000 },
      { batchId: 1002, batchType: 'PRINCIPAL', consumedCents: 100_000 },
    ]);
    expect(res.body.remainingBalanceCents).toBe(0);

    // Both batches set to EXHAUSTED with remainingCents=0.
    expect(prisma.walletCreditBatch.update).toHaveBeenCalledTimes(2);
    expect(prisma.walletCreditBatch.update).toHaveBeenNthCalledWith(1, {
      where: { id: 1001 },
      data: { remainingCents: 0, status: 'EXHAUSTED' },
    });
    expect(prisma.walletCreditBatch.update).toHaveBeenNthCalledWith(2, {
      where: { id: 1002 },
      data: { remainingCents: 0, status: 'EXHAUSTED' },
    });

    // SALE → invoiceId populated, not visitId.
    expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'REDEEM',
          amount: -2000,
          visitId: null,
          invoiceId: 555,
          balanceAfter: 0,
        }),
      }),
    );
  });
});

// ─── P1: Bonus untouched when principal covers the redeem ───────────────

describe('POST /api/wallet/:patientId/redeem — P1 PRINCIPAL first (FIFO), bonus untouched', () => {
  test('₹500 redeem from ₹1000 PRINCIPAL + ₹500 BONUS → only PRINCIPAL debited', async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
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
      bonus: [
        {
          id: 2001,
          batchType: 'BONUS',
          remainingCents: 50_000,
          expiresAt: tomorrow,
          createdAt: new Date('2026-05-20'),
        },
      ],
    });

    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 50_000, sourceType: 'VISIT', sourceId: 123 });

    expect(res.status).toBe(200);
    expect(res.body.debitedFromBatches).toEqual([
      { batchId: 1001, batchType: 'PRINCIPAL', consumedCents: 50_000 },
    ]);
    // Only ONE batch update — bonus batch must not have been touched.
    expect(prisma.walletCreditBatch.update).toHaveBeenCalledTimes(1);
    expect(prisma.walletCreditBatch.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: { remainingCents: 50_000, status: 'ACTIVE' },
    });
  });
});

// ─── P2: Expired bonus skipped at the SQL filter ────────────────────────

describe('POST /api/wallet/:patientId/redeem — P2 expired bonus skipped', () => {
  test('expired BONUS not in fetch → balance computed without it', async () => {
    // The route's WHERE clause filters expiresAt > now, so an expired
    // BONUS row would never reach the route. We simulate that by NOT
    // including it in the BONUS findMany result, then assert the filter
    // shape was generated.
    seedBatches({ principal: [], bonus: [] });

    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 50_000, sourceType: 'VISIT', sourceId: 123 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(res.body.availableCents).toBe(0);

    // Verify the SQL filter includes the expiresAt > now guard (so
    // expired bonus batches never enter the candidate set).
    const bonusCall = prisma.walletCreditBatch.findMany.mock.calls.find(
      (c) => c[0].where.batchType === 'BONUS',
    );
    expect(bonusCall).toBeDefined();
    expect(bonusCall[0].where.OR).toEqual([
      { expiresAt: null },
      { expiresAt: { gt: expect.any(Date) } },
    ]);
    expect(bonusCall[0].where.status).toBe('ACTIVE');
  });
});

// ─── P3: Soonest-expiry bonus picked first ──────────────────────────────

describe('POST /api/wallet/:patientId/redeem — P3 soonest-expiry bonus first', () => {
  test('2 BONUS batches → orderBy expiresAt ASC + earliest consumed first', async () => {
    const may30 = new Date('2026-05-30T00:00:00Z');
    const jun01 = new Date('2026-06-01T00:00:00Z');
    seedBatches({
      principal: [],
      // Pre-sort the fixtures by expiresAt ASC so the iteration order
      // matches what the route's `orderBy: { expiresAt: 'asc' }` would
      // yield from Prisma. (Real Prisma applies the orderBy at the DB;
      // the mock can't, so the fixture sequence IS the sort.)
      bonus: [
        {
          id: 2002,
          batchType: 'BONUS',
          remainingCents: 30_000,
          expiresAt: may30,
          createdAt: new Date('2026-05-20'),
        },
        {
          id: 2001,
          batchType: 'BONUS',
          remainingCents: 50_000,
          expiresAt: jun01,
          createdAt: new Date('2026-05-19'),
        },
      ],
    });

    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 40_000, sourceType: 'VISIT', sourceId: 123 });

    expect(res.status).toBe(200);
    // May-30 (id=2002) consumed first (fully, 30k), then Jun-01 (id=2001)
    // partial (10k of 50k).
    expect(res.body.debitedFromBatches).toEqual([
      { batchId: 2002, batchType: 'BONUS', consumedCents: 30_000 },
      { batchId: 2001, batchType: 'BONUS', consumedCents: 10_000 },
    ]);

    // Verify the route asked Prisma to sort BONUS by expiresAt ASC.
    const bonusCall = prisma.walletCreditBatch.findMany.mock.calls.find(
      (c) => c[0].where.batchType === 'BONUS',
    );
    expect(bonusCall[0].orderBy).toEqual({ expiresAt: 'asc' });
  });
});

// ─── B1: Insufficient balance with structured diagnostics ───────────────

describe('POST /api/wallet/:patientId/redeem — B1 insufficient balance', () => {
  test('₹2000 redeem from ₹1500 → 400 + requestedCents + availableCents', async () => {
    seedBatches({
      principal: [
        {
          id: 1001,
          batchType: 'PRINCIPAL',
          remainingCents: 100_000, // ₹1000
          expiresAt: null,
          createdAt: new Date('2026-05-10'),
        },
      ],
      bonus: [
        {
          id: 2001,
          batchType: 'BONUS',
          remainingCents: 50_000, // ₹500
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          createdAt: new Date('2026-05-10'),
        },
      ],
    });

    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 200_000, sourceType: 'VISIT', sourceId: 123 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      requestedCents: 200_000,
      availableCents: 150_000,
    });

    // No batch updates, no ledger write, no balance update.
    expect(prisma.walletCreditBatch.update).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });
});

// ─── B2: Empty wallet (no batches at all) ───────────────────────────────

describe('POST /api/wallet/:patientId/redeem — B2 empty wallet → 400 INSUFFICIENT_BALANCE', () => {
  test('no batches → availableCents=0, INSUFFICIENT_BALANCE', async () => {
    seedBatches({ principal: [], bonus: [] });

    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 1, sourceType: 'VISIT', sourceId: 1 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      requestedCents: 1,
      availableCents: 0,
    });
    expect(prisma.walletCreditBatch.update).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });
});

// ─── A1: Atomic rollback on mid-batch failure ───────────────────────────

describe('POST /api/wallet/:patientId/redeem — A1 atomic rollback', () => {
  test('batch.update throws mid-flight → 500 REDEEM_FAILED, no balance update', async () => {
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

    prisma.walletCreditBatch.update.mockRejectedValueOnce(
      new Error('DB constraint violation'),
    );

    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 50_000, sourceType: 'VISIT', sourceId: 123 });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'REDEEM_FAILED' });
    // Wallet balance MUST NOT have been mutated — the throw happened
    // BEFORE the wallet.update + ledger create calls in the txn.
    expect(prisma.wallet.update).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });
});

// ─── V1: amountCents=0 → 400 INVALID_AMOUNT ─────────────────────────────

describe('POST /api/wallet/:patientId/redeem — V1 amountCents=0 → 400', () => {
  test('zero amount → 400 INVALID_AMOUNT, no DB writes', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 0, sourceType: 'VISIT', sourceId: 1 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  test('negative amount → 400 INVALID_AMOUNT', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: -100, sourceType: 'VISIT', sourceId: 1 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
  });
});

// ─── V2: sourceType invalid ─────────────────────────────────────────────

describe('POST /api/wallet/:patientId/redeem — V2 invalid sourceType → 400', () => {
  test("sourceType='X' → 400 INVALID_SOURCE_TYPE", async () => {
    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 100, sourceType: 'X', sourceId: 1 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SOURCE_TYPE');
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  test("sourceType='PRESCRIPTION' (not in allow-list) → 400", async () => {
    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 100, sourceType: 'PRESCRIPTION', sourceId: 1 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SOURCE_TYPE');
  });

  test('sourceType accepts VISIT and SALE (positive control)', async () => {
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
    for (const sourceType of ['VISIT', 'SALE']) {
      prisma.walletTransaction.create.mockClear();
      const res = await request(makeApp())
        .post('/api/wallet/42/redeem')
        .send({ amountCents: 100, sourceType, sourceId: 1 });
      expect(res.status).toBe(200);
      expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
    }
  });
});

// ─── V3: sourceId not a positive integer ────────────────────────────────

describe('POST /api/wallet/:patientId/redeem — V3 invalid sourceId → 400', () => {
  test('sourceId=null → 400 INVALID_SOURCE_ID', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 100, sourceType: 'VISIT', sourceId: null });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SOURCE_ID');
  });

  test('sourceId=0 → 400 INVALID_SOURCE_ID', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 100, sourceType: 'VISIT', sourceId: 0 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SOURCE_ID');
  });

  test('sourceId=-5 → 400 INVALID_SOURCE_ID', async () => {
    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 100, sourceType: 'VISIT', sourceId: -5 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SOURCE_ID');
  });
});

// ─── T1: cross-tenant patientId → 404 ───────────────────────────────────

describe('POST /api/wallet/:patientId/redeem — T1 cross-tenant 404', () => {
  test('patient in tenant B → ADMIN of tenant A gets 404 (not 403)', async () => {
    prisma.patient.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/wallet/777/redeem')
      .send({ amountCents: 100, sourceType: 'VISIT', sourceId: 1 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PATIENT_NOT_FOUND');
    expect(prisma.wallet.findFirst).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  test('patient exists but wallet missing → 404 WALLET_NOT_FOUND', async () => {
    prisma.wallet.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 100, sourceType: 'VISIT', sourceId: 1 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WALLET_NOT_FOUND');
    expect(prisma.walletCreditBatch.findMany).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });
});

// ─── T2: USER without clinical role → 403 ───────────────────────────────

describe('POST /api/wallet/:patientId/redeem — T2 USER without clinical role → 403', () => {
  test("role=USER + wellnessRole=null → 403 WELLNESS_ROLE_FORBIDDEN", async () => {
    const res = await request(makeApp({ role: 'USER', wellnessRole: null }))
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 100, sourceType: 'VISIT', sourceId: 1 });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WELLNESS_ROLE_FORBIDDEN' });
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  test('wellnessRole=cashier passes the gate (positive control)', async () => {
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
    const res = await request(
      makeApp({ role: 'USER', wellnessRole: 'cashier' }),
    )
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 50_000, sourceType: 'VISIT', sourceId: 1 });

    expect(res.status).toBe(200);
    expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
  });

  test('wellnessRole=helper is BLOCKED (helpers do not handle money)', async () => {
    const res = await request(
      makeApp({ role: 'USER', wellnessRole: 'helper' }),
    )
      .post('/api/wallet/42/redeem')
      .send({ amountCents: 100, sourceType: 'VISIT', sourceId: 1 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });
});
