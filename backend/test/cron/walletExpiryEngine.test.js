// @ts-check
/**
 * Unit tests for backend/cron/walletExpiryEngine.js — daily 03:30 IST sweep
 * that flips ACTIVE WalletCreditBatch rows whose expiresAt has passed to
 * EXPIRED, debits the corresponding Wallet.balance, writes a signed-negative
 * WalletTransaction (type=EXPIRY), and emits a WALLET_EXPIRY audit row per
 * batch. D16 Wallet Top-up — Arc 1 Slice 6 (PRD_WALLET_TOPUP §3.5 Phase 2).
 *
 * Why this file exists (gap class — new engine, ledger-correctness critical):
 *   - Wallet.balance reflects redeemable credits; mis-decrementing on expiry
 *     either (a) leaves phantom credit the patient sees but can't spend, or
 *     (b) under-debits silently — both surface only at next-redeem time.
 *   - The query filter (`status='ACTIVE' AND expiresAt <= now`) is the
 *     idempotency gate. A second pass within the same window MUST find zero
 *     matching rows; a regression that drops the status filter would
 *     double-decrement balance on every cron tick.
 *   - Per-tenant scope is enforced at the prisma WHERE level; runForTenant
 *     must not touch other tenants' batches.
 *   - Each batch is its own $transaction so mid-sweep failures don't leak
 *     partial state (batch flipped but no transaction row, or vice versa).
 *
 * Functions covered:
 *   - runForTenant
 *       Happy path: 2 expired BONUS batches → status flipped to EXPIRED +
 *         2 WalletTransaction rows + Wallet.balance decremented by total.
 *       Not-yet-expired batch → query filter rejects; untouched.
 *       Already-EXPIRED batch → query filter rejects; no-op.
 *       remainingCents=0 batch → query filter rejects (already drained).
 *       Tenant scoping: runForTenant(A) doesn't touch tenant B's batches.
 *       Empty: no batches → no errors, scanned=0, expired=0.
 *       Audit row emitted per expired batch (WALLET_EXPIRY).
 *       Batch isolation: throw on 2nd of 3 batches → 1st committed, 3rd still
 *         attempted (per-batch transaction; sweep continues past failures).
 *       Concurrent-redeem race: fresh re-read inside tx sees remainingCents=0
 *         → status flipped but no transaction row + no balance debit.
 *       Orphaned batch (wallet vanished): batch flipped to EXPIRED anyway.
 *   - run (orchestrator)
 *       Iterates active tenants only.
 *       Per-tenant error containment: one tenant throws → siblings still run.
 *       Aggregates totalExpired across tenants.
 *
 * NOT covered (intentional):
 *   - initWalletExpiryCron: schedule shell (cron.schedule + console.log).
 *   - Actual cron-tick timing — node-cron internals.
 *
 * Mocking strategy:
 *   Standard prisma-singleton monkey-patch + $transaction replays against a
 *   `tx` proxy whose delegates are the same vi.fn() spies (so assertions
 *   continue working unchanged). SUT module inlined via vitest.config.js.
 *   writeAuditSafe is self-spied via module.exports to avoid spinning a
 *   real prisma.auditLog lookup (CJS-self-mocking-seam pattern, cron-
 *   learnings entry 2026-05-24 ~01:43 UTC).
 */
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const engine = requireCJS('../../cron/walletExpiryEngine.js');

beforeAll(() => {
  prisma.walletCreditBatch = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  prisma.wallet = {
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  prisma.walletTransaction = {
    create: vi.fn(),
  };
  prisma.tenant = prisma.tenant || {};
  prisma.tenant.findMany = vi.fn();

  // $transaction proxies tx delegates back onto the singleton spies so
  // .toHaveBeenCalledWith assertions continue to work inside the callback.
  prisma.$transaction = vi.fn(async (cb) => {
    const tx = {
      walletCreditBatch: prisma.walletCreditBatch,
      wallet: prisma.wallet,
      walletTransaction: prisma.walletTransaction,
    };
    return cb(tx);
  });
});

beforeEach(() => {
  prisma.walletCreditBatch.findMany.mockReset();
  prisma.walletCreditBatch.findUnique.mockReset();
  prisma.walletCreditBatch.update.mockReset();
  prisma.wallet.findUnique.mockReset();
  prisma.wallet.update.mockReset();
  prisma.walletTransaction.create.mockReset();
  prisma.tenant.findMany.mockReset();
  prisma.$transaction.mockClear();

  // Default-pass shapes: empty world.
  prisma.walletCreditBatch.findMany.mockResolvedValue([]);
  prisma.walletCreditBatch.update.mockResolvedValue({});
  prisma.wallet.update.mockResolvedValue({});
  prisma.walletTransaction.create.mockResolvedValue({ id: 1 });
  prisma.tenant.findMany.mockResolvedValue([]);

  // Spy on the self-mock seam so we can assert audit calls without
  // spinning real audit.js writes. Replace per-test if a test wants to
  // assert the args.
  engine.writeAuditSafe = vi.fn();
});

function batch({
  id,
  tenantId = 1,
  walletId = 100,
  remainingCents = 50_00,
  status = 'ACTIVE',
  sourceRuleId = 7,
  expiresAt = new Date(Date.now() - 60_000), // 1 min ago by default
}) {
  return { id, tenantId, walletId, remainingCents, status, sourceRuleId, expiresAt };
}

function wallet({ id = 100, balance = 100, patientId = 555 } = {}) {
  return { id, balance, patientId };
}

// ─── Query shape ────────────────────────────────────────────────────────────

describe('cron/walletExpiryEngine — query shape', () => {
  test('runForTenant scopes WHERE to tenantId + status=ACTIVE + expiresAt<=now + remainingCents>0', async () => {
    const before = Date.now();
    await engine.runForTenant(1);

    expect(prisma.walletCreditBatch.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.walletCreditBatch.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(1);
    expect(arg.where.status).toBe('ACTIVE');
    expect(arg.where.remainingCents).toEqual({ gt: 0 });
    expect(arg.where.expiresAt).toHaveProperty('not', null);
    expect(arg.where.expiresAt).toHaveProperty('lte');
    const lte = arg.where.expiresAt.lte.getTime();
    // Filter cutoff is "now" — close to test start time.
    expect(lte).toBeGreaterThanOrEqual(before - 200);
    expect(lte).toBeLessThanOrEqual(Date.now() + 200);
  });

  test('runForTenant throws if no tenantId provided', async () => {
    await expect(engine.runForTenant()).rejects.toThrow(/tenantId/);
    await expect(engine.runForTenant(null)).rejects.toThrow(/tenantId/);
    await expect(engine.runForTenant(0)).rejects.toThrow(/tenantId/);
  });
});

// ─── Happy path: expired batches processed ──────────────────────────────────

describe('cron/walletExpiryEngine — happy path', () => {
  test('2 expired BONUS batches → both flipped EXPIRED + 2 ledger rows + balance debited by combined total', async () => {
    const b1 = batch({ id: 11, walletId: 100, remainingCents: 20_00 });
    const b2 = batch({ id: 12, walletId: 100, remainingCents: 30_00 });
    prisma.walletCreditBatch.findMany.mockResolvedValueOnce([b1, b2]);

    // findUnique re-reads inside the tx return ACTIVE state both times.
    prisma.walletCreditBatch.findUnique
      .mockResolvedValueOnce({ ...b1 })
      .mockResolvedValueOnce({ ...b2 });

    // Wallet starts at ₹100; after b1 (₹20 expired) → ₹80; after b2 (₹30) → ₹50.
    prisma.wallet.findUnique
      .mockResolvedValueOnce(wallet({ id: 100, balance: 100, patientId: 555 }))
      .mockResolvedValueOnce(wallet({ id: 100, balance: 80, patientId: 555 }));

    const res = await engine.runForTenant(1);

    expect(res).toMatchObject({ tenantId: 1, scanned: 2, expired: 2 });
    expect(res.errors).toEqual([]);

    // Each batch flipped to EXPIRED with remainingCents=0.
    expect(prisma.walletCreditBatch.update).toHaveBeenCalledTimes(2);
    expect(prisma.walletCreditBatch.update.mock.calls[0][0]).toEqual({
      where: { id: 11 },
      data: { status: 'EXPIRED', remainingCents: 0 },
    });
    expect(prisma.walletCreditBatch.update.mock.calls[1][0]).toEqual({
      where: { id: 12 },
      data: { status: 'EXPIRED', remainingCents: 0 },
    });

    // 2 WalletTransaction rows, signed-negative amount in rupees.
    expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(2);
    const tx1 = prisma.walletTransaction.create.mock.calls[0][0].data;
    expect(tx1.type).toBe('EXPIRY');
    expect(tx1.amount).toBe(-20);
    expect(tx1.balanceAfter).toBe(80);
    expect(tx1.walletId).toBe(100);
    expect(tx1.tenantId).toBe(1);
    expect(tx1.performedBy).toBe(0); // system actor
    expect(tx1.reason).toContain('Batch 11 expired');

    const tx2 = prisma.walletTransaction.create.mock.calls[1][0].data;
    expect(tx2.amount).toBe(-30);
    expect(tx2.balanceAfter).toBe(50);

    // Wallet.balance updated twice: ₹100→₹80, then ₹80→₹50.
    expect(prisma.wallet.update).toHaveBeenCalledTimes(2);
    expect(prisma.wallet.update.mock.calls[0][0]).toEqual({
      where: { id: 100 },
      data: { balance: 80 },
    });
    expect(prisma.wallet.update.mock.calls[1][0]).toEqual({
      where: { id: 100 },
      data: { balance: 50 },
    });
  });

  test('audit row WALLET_EXPIRY emitted per expired batch with batchId + walletId + patientId + expiredCents + ruleId', async () => {
    const b = batch({ id: 99, walletId: 100, remainingCents: 75_00, sourceRuleId: 42 });
    prisma.walletCreditBatch.findMany.mockResolvedValueOnce([b]);
    prisma.walletCreditBatch.findUnique.mockResolvedValueOnce({ ...b });
    prisma.wallet.findUnique.mockResolvedValueOnce(
      wallet({ id: 100, balance: 200, patientId: 555 }),
    );

    await engine.runForTenant(1);

    expect(engine.writeAuditSafe).toHaveBeenCalledTimes(1);
    const args = engine.writeAuditSafe.mock.calls[0];
    expect(args[0]).toBe('Wallet');
    expect(args[1]).toBe('WALLET_EXPIRY');
    expect(args[2]).toBe(99); // entityId = batchId
    expect(args[3]).toBe(null); // system actor
    expect(args[4]).toBe(1); // tenantId
    expect(args[5]).toMatchObject({
      walletId: 100,
      patientId: 555,
      batchId: 99,
      expiredCents: 7500,
      ruleId: 42,
    });
  });

  test('console.warn fired per expired batch with tenant/patient/batch context', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = batch({ id: 7, walletId: 100, remainingCents: 100_00 });
    prisma.walletCreditBatch.findMany.mockResolvedValueOnce([b]);
    prisma.walletCreditBatch.findUnique.mockResolvedValueOnce({ ...b });
    prisma.wallet.findUnique.mockResolvedValueOnce(
      wallet({ id: 100, balance: 300, patientId: 88 }),
    );

    await engine.runForTenant(1);

    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toMatch(/walletExpiry/);
    expect(logged).toMatch(/tenant 1/);
    expect(logged).toMatch(/patient 88/);
    expect(logged).toMatch(/batch 7/);
    expect(logged).toMatch(/expiredCents 10000/);

    warn.mockRestore();
  });

  test('reason string includes batch id + rupee-formatted expired amount', async () => {
    const b = batch({ id: 555, remainingCents: 199_50 });
    prisma.walletCreditBatch.findMany.mockResolvedValueOnce([b]);
    prisma.walletCreditBatch.findUnique.mockResolvedValueOnce({ ...b });
    prisma.wallet.findUnique.mockResolvedValueOnce(wallet({ balance: 500 }));

    await engine.runForTenant(1);

    const reason = prisma.walletTransaction.create.mock.calls[0][0].data.reason;
    expect(reason).toContain('Batch 555 expired');
    expect(reason).toContain('₹199.50');
  });
});

// ─── Idempotency: re-running finds zero ACTIVE batches ──────────────────────

describe('cron/walletExpiryEngine — idempotency', () => {
  test('second pass within the same window finds zero ACTIVE batches → no-op', async () => {
    // First pass: 1 batch expired.
    const b = batch({ id: 1, remainingCents: 50_00 });
    prisma.walletCreditBatch.findMany.mockResolvedValueOnce([b]);
    prisma.walletCreditBatch.findUnique.mockResolvedValueOnce({ ...b });
    prisma.wallet.findUnique.mockResolvedValueOnce(wallet({ balance: 100 }));

    await engine.runForTenant(1);

    // Second pass: findMany returns empty (filter excludes the now-EXPIRED row).
    prisma.walletCreditBatch.findMany.mockResolvedValueOnce([]);
    prisma.walletCreditBatch.update.mockClear();
    prisma.walletTransaction.create.mockClear();
    prisma.wallet.update.mockClear();

    const res = await engine.runForTenant(1);
    expect(res).toMatchObject({ tenantId: 1, scanned: 0, expired: 0 });
    expect(prisma.walletCreditBatch.update).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });

  test('concurrent-redeem race: fresh re-read shows status=EXHAUSTED → skipped (no ledger row, no balance debit)', async () => {
    const b = batch({ id: 7, remainingCents: 30_00 });
    prisma.walletCreditBatch.findMany.mockResolvedValueOnce([b]);
    // findUnique inside the tx sees the batch was depleted + status flipped
    // by a parallel redeem between the findMany snapshot and the tx.
    prisma.walletCreditBatch.findUnique.mockResolvedValueOnce({
      id: 7,
      tenantId: 1,
      walletId: 100,
      remainingCents: 0,
      status: 'EXHAUSTED',
      sourceRuleId: 7,
    });

    const res = await engine.runForTenant(1);

    // Batch counted as scanned but NOT expired.
    expect(res.scanned).toBe(1);
    expect(res.expired).toBe(0);
    // No ledger row, no balance debit, no batch update.
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.wallet.update).not.toHaveBeenCalled();
    expect(prisma.walletCreditBatch.update).not.toHaveBeenCalled();
  });
});

// ─── Tenant scoping ─────────────────────────────────────────────────────────

describe('cron/walletExpiryEngine — tenant scoping', () => {
  test('runForTenant(A) only finds tenant A batches — WHERE.tenantId=A pinned', async () => {
    await engine.runForTenant(42);
    const arg = prisma.walletCreditBatch.findMany.mock.calls[0][0];
    expect(arg.where.tenantId).toBe(42);
    expect(arg.where.tenantId).not.toBe(1);
  });

  test('two separate runForTenant calls produce two separate findMany WHERE.tenantId values', async () => {
    await engine.runForTenant(1);
    await engine.runForTenant(2);
    expect(prisma.walletCreditBatch.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.walletCreditBatch.findMany.mock.calls[0][0].where.tenantId).toBe(1);
    expect(prisma.walletCreditBatch.findMany.mock.calls[1][0].where.tenantId).toBe(2);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('cron/walletExpiryEngine — edge cases', () => {
  test('empty batch set → returns zeros, no DB writes, no errors', async () => {
    prisma.walletCreditBatch.findMany.mockResolvedValueOnce([]);

    const res = await engine.runForTenant(1);

    expect(res).toEqual({ tenantId: 1, scanned: 0, expired: 0, errors: [] });
    expect(prisma.walletCreditBatch.update).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });

  test('orphaned batch (wallet vanished) → batch still flipped to EXPIRED; no ledger row, no balance update', async () => {
    const b = batch({ id: 3, walletId: 999, remainingCents: 20_00 });
    prisma.walletCreditBatch.findMany.mockResolvedValueOnce([b]);
    prisma.walletCreditBatch.findUnique.mockResolvedValueOnce({ ...b });
    prisma.wallet.findUnique.mockResolvedValueOnce(null); // orphaned

    const res = await engine.runForTenant(1);

    expect(prisma.walletCreditBatch.update).toHaveBeenCalledTimes(1);
    expect(prisma.walletCreditBatch.update.mock.calls[0][0]).toEqual({
      where: { id: 3 },
      data: { status: 'EXPIRED', remainingCents: 0 },
    });
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.wallet.update).not.toHaveBeenCalled();
    // Counted as scanned but not as "expired" in the success sense — the
    // orphaned-batch path returns early before incrementing expired.
    expect(res.scanned).toBe(1);
    expect(res.expired).toBe(0);
  });

  test('batch.findUnique returns null inside tx → treated as skipped (no work)', async () => {
    const b = batch({ id: 5, remainingCents: 10_00 });
    prisma.walletCreditBatch.findMany.mockResolvedValueOnce([b]);
    prisma.walletCreditBatch.findUnique.mockResolvedValueOnce(null);

    const res = await engine.runForTenant(1);

    expect(res.scanned).toBe(1);
    expect(res.expired).toBe(0);
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });
});

// ─── Atomicity / per-batch isolation ────────────────────────────────────────

describe('cron/walletExpiryEngine — atomicity (per-batch transaction)', () => {
  test('each batch processed in its OWN $transaction (not one mega-transaction)', async () => {
    const b1 = batch({ id: 1, remainingCents: 10_00 });
    const b2 = batch({ id: 2, remainingCents: 20_00 });
    prisma.walletCreditBatch.findMany.mockResolvedValueOnce([b1, b2]);
    prisma.walletCreditBatch.findUnique
      .mockResolvedValueOnce({ ...b1 })
      .mockResolvedValueOnce({ ...b2 });
    prisma.wallet.findUnique
      .mockResolvedValueOnce(wallet({ balance: 100 }))
      .mockResolvedValueOnce(wallet({ balance: 90 }));

    await engine.runForTenant(1);

    // 2 separate $transaction calls — one per batch.
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  test('throw mid-sweep: 1st batch commits, 2nd throws, 3rd still attempted (per-batch isolation)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const b1 = batch({ id: 1, remainingCents: 10_00 });
    const b2 = batch({ id: 2, remainingCents: 20_00 });
    const b3 = batch({ id: 3, remainingCents: 30_00 });
    prisma.walletCreditBatch.findMany.mockResolvedValueOnce([b1, b2, b3]);

    // b1: succeeds.
    prisma.walletCreditBatch.findUnique
      .mockResolvedValueOnce({ ...b1 })
      // b2: findUnique throws (simulating DB failure mid-sweep)
      .mockRejectedValueOnce(new Error('DB blew up on b2'))
      // b3: succeeds.
      .mockResolvedValueOnce({ ...b3 });
    prisma.wallet.findUnique
      .mockResolvedValueOnce(wallet({ balance: 100 }))
      // b2 never reaches wallet.findUnique
      .mockResolvedValueOnce(wallet({ balance: 90 }));

    const res = await engine.runForTenant(1);

    expect(res.scanned).toBe(3);
    expect(res.expired).toBe(2); // b1 + b3
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ batchId: 2, error: 'DB blew up on b2' });

    // 2 successful batch updates (b1, b3).
    expect(prisma.walletCreditBatch.update).toHaveBeenCalledTimes(2);
    // 2 successful ledger rows (b1, b3).
    expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(2);

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ─── Orchestrator (run — all tenants) ───────────────────────────────────────

describe('cron/walletExpiryEngine — orchestrator (run)', () => {
  test('queries tenants WHERE isActive=true; iterates each via runForTenant', async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([
      { id: 1, slug: 'tA' },
      { id: 2, slug: 'tB' },
    ]);

    // Spy on runForTenant via module.exports seam (the engine calls
    // module.exports.runForTenant from run()).
    const spy = vi
      .spyOn(engine, 'runForTenant')
      .mockResolvedValueOnce({ tenantId: 1, scanned: 0, expired: 3, errors: [] })
      .mockResolvedValueOnce({ tenantId: 2, scanned: 0, expired: 5, errors: [] });

    const res = await engine.run();

    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.tenant.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(1);
    expect(spy).toHaveBeenCalledWith(2);
    expect(res).toMatchObject({ tenants: 2, expired: 8 });
    expect(res.results).toHaveLength(2);
    expect(res.results[0]).toMatchObject({ tenant: 'tA', expired: 3 });
    expect(res.results[1]).toMatchObject({ tenant: 'tB', expired: 5 });

    spy.mockRestore();
  });

  test('per-tenant error containment: tenant A throws → tenant B still processed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    prisma.tenant.findMany.mockResolvedValueOnce([
      { id: 1, slug: 'tA' },
      { id: 2, slug: 'tB' },
    ]);

    const spy = vi
      .spyOn(engine, 'runForTenant')
      .mockRejectedValueOnce(new Error('tA blew up'))
      .mockResolvedValueOnce({ tenantId: 2, scanned: 0, expired: 1, errors: [] });

    const res = await engine.run();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.tenants).toBe(2);
    expect(res.expired).toBe(1);
    expect(res.results[0]).toMatchObject({ tenant: 'tA', error: 'tA blew up' });
    expect(res.results[1]).toMatchObject({ tenant: 'tB', expired: 1 });

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
    spy.mockRestore();
  });

  test('empty tenants set → returns zeros without further DB calls', async () => {
    prisma.tenant.findMany.mockResolvedValueOnce([]);

    const res = await engine.run();

    expect(res).toMatchObject({ tenants: 0, expired: 0 });
    expect(prisma.walletCreditBatch.findMany).not.toHaveBeenCalled();
  });

  test('outermost tenant.findMany throws → run returns { error } shape (does NOT re-throw)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    prisma.tenant.findMany.mockRejectedValueOnce(new Error('tenant lookup down'));

    const res = await engine.run();

    expect(res).toMatchObject({ tenants: 0, expired: 0, error: 'tenant lookup down' });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
