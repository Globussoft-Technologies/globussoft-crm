// @ts-check
/**
 * Unit tests for backend/routes/pos.js — D17 POS New Sale Arc 1 Slice 7
 * (POST /api/pos/sales/:id/void  + POST /api/pos/sales/:id/refund).
 *
 * PRD: docs/PRD_POS_NEW_SALE.md §3.9 + DD-5.7 round-2 RESOLVED 2026-05-25
 * (STRICT mode → BOTH endpoints are ADMIN-only; manager rejected).
 *
 * What this file pins (≥11 cases per the slice spec)
 * ────────────────────────────────────────────────────
 *   VOID:
 *     V_OK_1  ADMIN voids COMPLETED sale → status='VOIDED', wallet reversed
 *             (batch.remainingCents restored, Wallet.balance bumped,
 *             WalletTransaction VOID_REVERSAL written), Invoice→VOIDED.
 *     V_403_USER   USER → 403 WELLNESS_ROLE_FORBIDDEN.
 *     V_403_MGR    MANAGER → 403 WELLNESS_ROLE_FORBIDDEN (STRICT mode —
 *                  the existing /sales /shifts /registers routes allow
 *                  manager via adminGate; void/refund deliberately do not).
 *     V_409_ALR    Already-VOIDED sale → 409 SALE_NOT_VOIDABLE.
 *     V_404_XT     Cross-tenant sale (findFirst returns null) → 404
 *                  SALE_NOT_FOUND.
 *     V_400_NOREAS Missing reason → 400 INVALID_REASON.
 *     V_AUDIT      writeAudit('Sale', 'POS_SALE_VOIDED', …) called with
 *                  saleId + reason + walletReversedCents.
 *
 *   REFUND:
 *     R_OK_FULL    ADMIN refunds full amount → status='REFUNDED', Payment
 *                  row written with negative amount + gateway='refund'.
 *     R_OK_PART    amountCents < totalCents → status='PARTIALLY_REFUNDED',
 *                  refundedTotalCents in response.
 *     R_409_EXC    amountCents > totalCents → 409 REFUND_EXCEEDS_BALANCE.
 *     R_403_USER   USER → 403 WELLNESS_ROLE_FORBIDDEN.
 *     R_409_VOID   Refunding a VOIDED sale → 409 SALE_NOT_REFUNDABLE.
 *     R_AUDIT      writeAudit('Sale', 'POS_SALE_REFUNDED', …) called.
 *
 * Mock surface — same singleton-patch pattern as pos-sale-finalize.test.js.
 * The `prisma.$transaction(async cb => …)` mock passes the same prisma
 * singleton as the `tx` proxy so in-route assertions on .toHaveBeenCalledWith
 * continue working.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by /void + /refund ──
prisma.sale = prisma.sale || {};
prisma.sale.findFirst = vi.fn();
prisma.sale.update = vi.fn();

prisma.invoice = prisma.invoice || {};
prisma.invoice.findFirst = vi.fn();
prisma.invoice.update = vi.fn();

prisma.payment = prisma.payment || {};
prisma.payment.findMany = vi.fn();
prisma.payment.create = vi.fn();

prisma.wallet = prisma.wallet || {};
prisma.wallet.findFirst = vi.fn();
prisma.wallet.findUnique = vi.fn();
prisma.wallet.update = vi.fn();

prisma.walletTransaction = prisma.walletTransaction || {};
prisma.walletTransaction.create = vi.fn();

prisma.walletCreditBatch = prisma.walletCreditBatch || {};
prisma.walletCreditBatch.findUnique = vi.fn();
prisma.walletCreditBatch.update = vi.fn();

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'wellness' });

prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);

// requirePermission middleware (backend/middleware/requirePermission.js:178)
// resolves the caller's effective roles via userRole.findMany. When the
// route declares `anyOfPermissions` (POS strictAdminGate does), the deny
// path for a non-allowed wellnessRole calls getUserPermissions →
// loadUserPermissions → our empty-array mock → permSet.size === 0 →
// maybeSelfHealAdminPermissions which queries prisma.user.findUnique.
// We stub both: userRole.findMany to [] (no role grants) AND
// user.findUnique to null (self-heal exits at the "user not found" early
// return), so the middleware lands on the 403 WELLNESS_ROLE_FORBIDDEN
// path the test asserts.
prisma.userRole = prisma.userRole || {};
prisma.userRole.findMany = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue(null);

// $transaction proxy — pass the same prisma singleton as `tx`.
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

beforeEach(() => {
  prisma.sale.findFirst.mockReset();
  prisma.sale.update.mockReset();
  prisma.invoice.findFirst.mockReset();
  prisma.invoice.update.mockReset();
  prisma.payment.findMany.mockReset();
  prisma.payment.create.mockReset();
  prisma.wallet.findFirst.mockReset();
  prisma.wallet.findUnique.mockReset();
  prisma.wallet.update.mockReset();
  prisma.walletTransaction.create.mockReset();
  prisma.walletCreditBatch.findUnique.mockReset();
  prisma.walletCreditBatch.update.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset();
  prisma.auditLog.findFirst.mockResolvedValue(null);
  prisma.userRole.findMany.mockReset().mockResolvedValue([]);

  // Default-pass shapes — overridden per-test.
  prisma.invoice.findFirst.mockResolvedValue({ id: 7000 });
  prisma.invoice.update.mockResolvedValue({ id: 7000, status: 'VOIDED' });
  prisma.payment.findMany.mockResolvedValue([]);
  prisma.payment.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: Math.floor(Math.random() * 1e6), ...data }),
  );
  prisma.sale.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ id: where.id, ...data }),
  );
  prisma.walletCreditBatch.findUnique.mockImplementation(({ where }) =>
    Promise.resolve({ id: where.id, remainingCents: 0, status: 'EXHAUSTED' }),
  );
  prisma.walletCreditBatch.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ id: where.id, ...data }),
  );
  prisma.wallet.findUnique.mockResolvedValue({ balance: 0 });
  prisma.wallet.update.mockResolvedValue({ id: 7, balance: 500 });
  prisma.walletTransaction.create.mockResolvedValue({ id: 902 });
});

// ─────────────────────────────────────────────────────────────────────
// VOID — happy path with wallet reversal
// ─────────────────────────────────────────────────────────────────────

describe('POST /api/pos/sales/:id/void — V_OK_1 happy path', () => {
  test('ADMIN voids COMPLETED sale → status=VOIDED, wallet reversed', async () => {
    // Sale was paid ₹500 via wallet, debited from PRINCIPAL batch #1001.
    prisma.sale.findFirst.mockResolvedValue({
      id: 5000,
      status: 'COMPLETED',
      patientId: 42,
      invoiceNumber: 'POS-2026-0001',
      total: 500,
    });
    // POS_SALE_FINALIZED audit row carries the wallet-batch debit ledger.
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 11,
      details: JSON.stringify({
        saleId: 5000,
        walletBatchesDebited: [
          { batchId: 1001, batchType: 'PRINCIPAL', consumedCents: 50_000 },
        ],
      }),
    });
    prisma.wallet.findFirst.mockResolvedValue({ id: 7, balance: 0 });
    prisma.wallet.findUnique.mockResolvedValue({ balance: 0 });
    prisma.walletCreditBatch.findUnique.mockResolvedValue({
      id: 1001,
      remainingCents: 0,
      status: 'EXHAUSTED',
    });

    const res = await request(makeApp())
      .post('/api/pos/sales/5000/void')
      .send({ reason: 'Wrong patient rang up' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      saleId: 5000,
      status: 'VOIDED',
      walletReversedCents: 50_000,
    });

    // Wallet batch restored to remainingCents=50_000 + status=ACTIVE.
    expect(prisma.walletCreditBatch.update).toHaveBeenCalledWith({
      where: { id: 1001 },
      data: { remainingCents: 50_000, status: 'ACTIVE' },
    });
    // Wallet.balance bumped by ₹500 (50_000 cents).
    expect(prisma.wallet.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { balance: 500 },
    });
    // VOID_REVERSAL WalletTransaction written.
    expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'VOID_REVERSAL',
          amount: 500,
          balanceAfter: 500,
          performedBy: 7,
        }),
      }),
    );
    // Invoice flipped to VOIDED.
    expect(prisma.invoice.update).toHaveBeenCalledWith({
      where: { id: 7000 },
      data: { status: 'VOIDED' },
    });
    // Sale flipped to VOIDED with VOID: prefix on refundReason.
    expect(prisma.sale.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5000 },
        data: expect.objectContaining({
          status: 'VOIDED',
          refundReason: expect.stringMatching(/^VOID: /),
        }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// VOID — RBAC (STRICT mode: USER + MANAGER both rejected)
// ─────────────────────────────────────────────────────────────────────

describe('POST /api/pos/sales/:id/void — V_403_USER USER denied', () => {
  test('role=USER + wellnessRole=null → 403 WELLNESS_ROLE_FORBIDDEN', async () => {
    const res = await request(makeApp({ role: 'USER', wellnessRole: null }))
      .post('/api/pos/sales/5000/void')
      .send({ reason: 'test' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    expect(prisma.sale.findFirst).not.toHaveBeenCalled();
    expect(prisma.sale.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/pos/sales/:id/void — V_403_MGR MANAGER denied (STRICT)', () => {
  test('role=MANAGER → 403 (only ADMIN can void per DD-5.7 STRICT mode)', async () => {
    const res = await request(
      makeApp({ role: 'MANAGER', wellnessRole: 'manager' }),
    )
      .post('/api/pos/sales/5000/void')
      .send({ reason: 'test' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    expect(prisma.sale.findFirst).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// VOID — state guards
// ─────────────────────────────────────────────────────────────────────

describe('POST /api/pos/sales/:id/void — V_409_ALR already voided', () => {
  test('VOIDED sale → 409 SALE_NOT_VOIDABLE', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 5000,
      status: 'VOIDED',
      patientId: 42,
      invoiceNumber: 'POS-2026-0001',
      total: 500,
    });

    const res = await request(makeApp())
      .post('/api/pos/sales/5000/void')
      .send({ reason: 'try-again' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'SALE_NOT_VOIDABLE',
      currentStatus: 'VOIDED',
    });
    expect(prisma.sale.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/pos/sales/:id/void — V_404_XT cross-tenant', () => {
  test('sale not in caller tenant → 404 SALE_NOT_FOUND', async () => {
    prisma.sale.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/pos/sales/9999/void')
      .send({ reason: 'whatever' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SALE_NOT_FOUND');
    expect(prisma.sale.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/pos/sales/:id/void — V_400_NOREAS missing reason', () => {
  test('empty body → 400 INVALID_REASON, no DB writes', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales/5000/void')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REASON');
    expect(prisma.sale.findFirst).not.toHaveBeenCalled();
  });

  test('reason > 500 chars → 400 INVALID_REASON', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales/5000/void')
      .send({ reason: 'x'.repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REASON');
  });
});

// ─────────────────────────────────────────────────────────────────────
// VOID — audit emission
// ─────────────────────────────────────────────────────────────────────

describe('POST /api/pos/sales/:id/void — V_AUDIT audit emission', () => {
  test('successful void calls writeAudit("Sale", "POS_SALE_VOIDED", …)', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 5000,
      status: 'COMPLETED',
      patientId: 42,
      invoiceNumber: 'POS-2026-0001',
      total: 1000,
    });
    prisma.auditLog.findFirst.mockResolvedValue(null); // no wallet path

    const res = await request(makeApp())
      .post('/api/pos/sales/5000/void')
      .send({ reason: 'admin correction' });

    expect(res.status).toBe(200);
    // Audit fires fire-and-forget via .catch(); flush microtasks.
    await new Promise((r) => setTimeout(r, 10));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArg.data.entity).toBe('Sale');
    expect(auditArg.data.action).toBe('POS_SALE_VOIDED');
    const details = typeof auditArg.data.details === 'string'
      ? JSON.parse(auditArg.data.details)
      : auditArg.data.details;
    expect(details).toMatchObject({
      saleId: 5000,
      reason: 'admin correction',
      walletReversedCents: 0,
      batchesReversed: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// REFUND — full + partial happy paths
// ─────────────────────────────────────────────────────────────────────

describe('POST /api/pos/sales/:id/refund — R_OK_FULL full refund', () => {
  test('amountCents=totalCents → status=REFUNDED, negative Payment row', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 5000,
      status: 'COMPLETED',
      patientId: 42,
      invoiceNumber: 'POS-2026-0001',
      total: 1000,
    });
    prisma.payment.findMany.mockResolvedValue([]); // no prior refunds

    const res = await request(makeApp())
      .post('/api/pos/sales/5000/refund')
      .send({ amountCents: 100_000, reason: 'Full refund' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      saleId: 5000,
      status: 'REFUNDED',
      refundedTotalCents: 100_000,
    });

    // Negative Payment row written.
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: -1000,
          currency: 'INR',
          gateway: 'refund',
          status: 'SUCCESS',
          invoiceId: 7000,
        }),
      }),
    );
    // Sale flipped to REFUNDED.
    expect(prisma.sale.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5000 },
        data: expect.objectContaining({ status: 'REFUNDED' }),
      }),
    );
    // Wallet path NOT touched (refund != void).
    expect(prisma.wallet.update).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/pos/sales/:id/refund — R_OK_PART partial refund', () => {
  test('amountCents < totalCents → status=PARTIALLY_REFUNDED', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 5000,
      status: 'COMPLETED',
      patientId: 42,
      invoiceNumber: 'POS-2026-0001',
      total: 1000,
    });
    prisma.payment.findMany.mockResolvedValue([]); // no prior refunds

    const res = await request(makeApp())
      .post('/api/pos/sales/5000/refund')
      .send({ amountCents: 30_000, reason: 'Goodwill 30%' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      saleId: 5000,
      status: 'PARTIALLY_REFUNDED',
      refundedTotalCents: 30_000,
    });
    expect(prisma.sale.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PARTIALLY_REFUNDED' }),
      }),
    );
  });

  test('second partial that completes the total → flips to REFUNDED', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 5000,
      status: 'PARTIALLY_REFUNDED',
      patientId: 42,
      invoiceNumber: 'POS-2026-0001',
      total: 1000,
    });
    // ₹300 already refunded; refund another ₹700 → total.
    prisma.payment.findMany.mockResolvedValue([{ amount: -300 }]);

    const res = await request(makeApp())
      .post('/api/pos/sales/5000/refund')
      .send({ amountCents: 70_000, reason: 'Remaining' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'REFUNDED',
      refundedTotalCents: 100_000,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// REFUND — guards
// ─────────────────────────────────────────────────────────────────────

describe('POST /api/pos/sales/:id/refund — R_409_EXC exceeds balance', () => {
  test('amountCents > totalCents → 409 REFUND_EXCEEDS_BALANCE', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 5000,
      status: 'COMPLETED',
      patientId: 42,
      invoiceNumber: 'POS-2026-0001',
      total: 500,
    });
    prisma.payment.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/api/pos/sales/5000/refund')
      .send({ amountCents: 100_000, reason: 'Over-refund' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'REFUND_EXCEEDS_BALANCE',
      requestedCents: 100_000,
      remainingCents: 50_000,
    });
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.sale.update).not.toHaveBeenCalled();
  });

  test('partial-then-over refund: ₹300 already + request ₹800 → 409', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 5000,
      status: 'PARTIALLY_REFUNDED',
      patientId: 42,
      invoiceNumber: 'POS-2026-0001',
      total: 1000,
    });
    prisma.payment.findMany.mockResolvedValue([{ amount: -300 }]);

    const res = await request(makeApp())
      .post('/api/pos/sales/5000/refund')
      .send({ amountCents: 80_000, reason: 'Too much' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'REFUND_EXCEEDS_BALANCE',
      requestedCents: 80_000,
      remainingCents: 70_000,
    });
  });
});

describe('POST /api/pos/sales/:id/refund — R_403_USER USER denied', () => {
  test('role=USER → 403 WELLNESS_ROLE_FORBIDDEN', async () => {
    const res = await request(makeApp({ role: 'USER', wellnessRole: null }))
      .post('/api/pos/sales/5000/refund')
      .send({ amountCents: 10_000, reason: 'try' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    expect(prisma.sale.findFirst).not.toHaveBeenCalled();
  });
});

describe('POST /api/pos/sales/:id/refund — R_409_VOID voided sale', () => {
  test('VOIDED sale → 409 SALE_NOT_REFUNDABLE', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 5000,
      status: 'VOIDED',
      patientId: 42,
      invoiceNumber: 'POS-2026-0001',
      total: 500,
    });

    const res = await request(makeApp())
      .post('/api/pos/sales/5000/refund')
      .send({ amountCents: 50_000, reason: 'after-void' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'SALE_NOT_REFUNDABLE',
      currentStatus: 'VOIDED',
    });
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.sale.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/pos/sales/:id/refund — validation guards', () => {
  test('missing amountCents → 400 INVALID_AMOUNT', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales/5000/refund')
      .send({ reason: 'no-amount' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
    expect(prisma.sale.findFirst).not.toHaveBeenCalled();
  });

  test('negative amountCents → 400 INVALID_AMOUNT', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales/5000/refund')
      .send({ amountCents: -100, reason: 'bad' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
  });

  test('missing reason → 400 INVALID_REASON', async () => {
    const res = await request(makeApp())
      .post('/api/pos/sales/5000/refund')
      .send({ amountCents: 100 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REASON');
  });
});

// ─────────────────────────────────────────────────────────────────────
// REFUND — audit emission
// ─────────────────────────────────────────────────────────────────────

describe('POST /api/pos/sales/:id/refund — R_AUDIT audit emission', () => {
  test('successful refund calls writeAudit("Sale", "POS_SALE_REFUNDED", …)', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 5000,
      status: 'COMPLETED',
      patientId: 42,
      invoiceNumber: 'POS-2026-0001',
      total: 1000,
    });
    prisma.payment.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/api/pos/sales/5000/refund')
      .send({ amountCents: 100_000, reason: 'goods returned' });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArg = prisma.auditLog.create.mock.calls[0][0];
    expect(auditArg.data.entity).toBe('Sale');
    expect(auditArg.data.action).toBe('POS_SALE_REFUNDED');
    const details = typeof auditArg.data.details === 'string'
      ? JSON.parse(auditArg.data.details)
      : auditArg.data.details;
    expect(details).toMatchObject({
      saleId: 5000,
      amountCents: 100_000,
      reason: 'goods returned',
      refundedTotalCents: 100_000,
      saleTotalCents: 100_000,
      isFullRefund: true,
    });
  });
});
