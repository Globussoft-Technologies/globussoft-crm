/**
 * Wallet Expiry Engine
 *
 * D16 Wallet Top-up — Arc 1 Slice 6 (PRD_WALLET_TOPUP §3.5 Phase 2).
 *
 * Sweeps `WalletCreditBatch` rows where `status='ACTIVE'` AND
 * `expiresAt IS NOT NULL` AND `expiresAt <= now()` AND `remainingCents > 0`,
 * and atomically:
 *
 *   1. flips batch `status` → 'EXPIRED'
 *   2. zeros batch `remainingCents` (so future redemption queries can't
 *      pick it up even if a code path forgets the status filter)
 *   3. writes ONE `WalletTransaction` row (type='EXPIRY',
 *      amount = −remainingCents/100, balanceAfter snapshot)
 *   4. decrements `Wallet.balance` by the same amount
 *
 * Why decrement Wallet.balance here (PRD §3.5 Phase 2 explicit):
 *   The PRD spells out "decrement Wallet.balance; set batch remainingCents=0"
 *   inside the same transaction. Wallet.balance reflects redeemable credits,
 *   so expiring a batch MUST debit balance — otherwise the patient sees
 *   wallet credit they can no longer spend, the next redeem call attempts
 *   to deplete a phantom amount, and downstream invoice math drifts.
 *
 * Idempotency:
 *   - The query filter (`status='ACTIVE' AND expiresAt <= now`) is the
 *     only set-once gate. Running the engine twice within the same window
 *     finds zero rows on the second pass because the first pass flipped
 *     every matching row to status='EXPIRED'.
 *   - Each batch is its own `prisma.$transaction` so a mid-sweep crash
 *     leaves earlier batches fully committed and later ones untouched.
 *     Recovery on next tick re-finds only the still-ACTIVE ones.
 *
 * Per-tenant scoping:
 *   `runForTenant(tenantId)` exists for tests + the future admin manual-
 *   trigger endpoint (deferred to Slice 7+). `run()` iterates every
 *   active tenant (vertical-agnostic — wallet feature is enabled per
 *   tenant.walletEnabled, but the schema default is true and the
 *   feature toggle is Phase-2 work, so for now we sweep all active
 *   tenants and short-circuit when their wallet batches are empty).
 *
 * Notification:
 *   Logs `console.warn` per expired batch ("wallet expiry: tenant T,
 *   patient P, batch B, expiredCents N"). The customer-facing SMS / push
 *   notification half (PRD §3.5 Phase 1 T-7d warning + Phase 2 T-0
 *   notification fan-out) is a separate engine in v2 — this slice ships
 *   the ledger-correct expiry mechanic only.
 *
 * Audit:
 *   Fires `writeAudit('Wallet', 'WALLET_EXPIRY', batchId, null, tenantId,
 *   { walletId, patientId, batchId, expiredCents, ruleId })` per expired
 *   batch (PRD §3.8 audit-action enumeration). Actor is `null` →
 *   audit.js sets actorType='system' automatically. Fire-and-forget so an
 *   audit hiccup never rolls back the ledger.
 *
 * Schedule:
 *   Daily at 03:30 IST (cron expression `30 3 * * *` with explicit
 *   Asia/Kolkata timezone). Configurable via `WALLET_EXPIRY_CRON_SCHEDULE`
 *   env var per PRD §4.
 */

const cron = require("node-cron");
const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");

const DEFAULT_SCHEDULE = process.env.WALLET_EXPIRY_CRON_SCHEDULE || "30 3 * * *";

/**
 * Process a single batch row inside its own atomic transaction:
 *   - flip status → EXPIRED
 *   - zero remainingCents
 *   - write WalletTransaction (type=EXPIRY, signed-negative)
 *   - decrement Wallet.balance by remainingCents/100
 *
 * Returns { expiredCents, walletId, batchId } on success; throws on failure
 * so the caller can decide whether to abort the sweep or continue. Failures
 * are isolated to the single batch.
 */
async function expireBatch(batch) {
  return prisma.$transaction(async (tx) => {
    // Re-read inside the tx so concurrent redeem flows (which deplete
    // remainingCents) don't race with the snapshot. If the batch has
    // since been EXHAUSTED, remainingCents=0 → the EXPIRY transaction
    // amount becomes 0 → balance untouched → still safe.
    const fresh = await tx.walletCreditBatch.findUnique({
      where: { id: batch.id },
      select: {
        id: true,
        tenantId: true,
        walletId: true,
        remainingCents: true,
        status: true,
        sourceRuleId: true,
      },
    });

    if (!fresh || fresh.status !== "ACTIVE") {
      // Already-processed (idempotent path) or vanished.
      return { skipped: true, batchId: batch.id };
    }

    const expiredCents = fresh.remainingCents;
    const debitAmount = expiredCents / 100; // float-rupees (existing schema)

    const wallet = await tx.wallet.findUnique({
      where: { id: fresh.walletId },
      select: { id: true, balance: true, patientId: true },
    });

    if (!wallet) {
      // Orphaned batch (wallet was hard-deleted). Flip status anyway so
      // the next sweep doesn't re-pick this row.
      await tx.walletCreditBatch.update({
        where: { id: fresh.id },
        data: { status: "EXPIRED", remainingCents: 0 },
      });
      return { orphaned: true, batchId: fresh.id };
    }

    const newBalance = +(wallet.balance - debitAmount).toFixed(2);

    await tx.walletCreditBatch.update({
      where: { id: fresh.id },
      data: { status: "EXPIRED", remainingCents: 0 },
    });

    if (expiredCents > 0) {
      await tx.walletTransaction.create({
        data: {
          tenantId: fresh.tenantId,
          walletId: fresh.walletId,
          type: "EXPIRY",
          amount: -debitAmount,
          reason: `Batch ${fresh.id} expired (₹${debitAmount.toFixed(2)} bonus credits)`,
          balanceAfter: newBalance,
          performedBy: 0, // system actor — no User row
        },
      });

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance },
      });
    }

    return {
      batchId: fresh.id,
      walletId: fresh.walletId,
      patientId: wallet.patientId,
      tenantId: fresh.tenantId,
      sourceRuleId: fresh.sourceRuleId,
      expiredCents,
      newBalance,
    };
  });
}

/**
 * Run the expiry sweep for ONE tenant. Used by tests + the (future)
 * admin manual-trigger endpoint.
 *
 * Returns { tenantId, scanned, expired, errors[] }.
 */
async function runForTenant(tenantId) {
  if (!tenantId) {
    throw new Error("runForTenant requires a tenantId");
  }
  const now = new Date();

  const batches = await prisma.walletCreditBatch.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      expiresAt: { not: null, lte: now },
      remainingCents: { gt: 0 },
    },
    select: {
      id: true,
      tenantId: true,
      walletId: true,
      remainingCents: true,
      sourceRuleId: true,
      expiresAt: true,
    },
  });

  let expired = 0;
  const errors = [];

  for (const batch of batches) {
    try {
      const result = await expireBatch(batch);
      if (result && !result.skipped && !result.orphaned) {
        expired += 1;
        console.warn(
          `[walletExpiry] tenant ${result.tenantId}, patient ${result.patientId}, batch ${result.batchId}, expiredCents ${result.expiredCents}`,
        );
        // Fire-and-forget audit — never blocks the ledger.
        module.exports.writeAuditSafe(
          "Wallet",
          "WALLET_EXPIRY",
          result.batchId,
          null,
          result.tenantId,
          {
            walletId: result.walletId,
            patientId: result.patientId,
            batchId: result.batchId,
            expiredCents: result.expiredCents,
            ruleId: result.sourceRuleId,
          },
        );
      }
    } catch (err) {
      console.error(
        `[walletExpiry] batch ${batch.id} failed: ${err.message}`,
      );
      errors.push({ batchId: batch.id, error: err.message });
    }
  }

  return { tenantId, scanned: batches.length, expired, errors };
}

/**
 * Tiny wrapper so the audit call can be self-mocked in tests via
 * `module.exports.writeAuditSafe` without spawning a real prisma.auditLog
 * lookup. The CJS-self-mocking-seam pattern (cron-learnings entry,
 * 2026-05-24 ~01:43 UTC) — inter-function calls within a CJS module MUST
 * go through `module.exports.fn(...)` not the local closure binding, or
 * `vi.spyOn(engine, 'fn')` cannot intercept them.
 */
function writeAuditSafe(...args) {
  return writeAudit(...args).catch((err) => {
    console.warn(`[walletExpiry] audit failed: ${err.message}`);
  });
}

/**
 * Sweep every active tenant. Cron entry point.
 *
 * Per-tenant error containment: one tenant throwing doesn't abort siblings.
 */
async function run() {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true, slug: true },
    });

    const results = [];
    let totalExpired = 0;

    for (const t of tenants) {
      try {
        const r = await module.exports.runForTenant(t.id);
        results.push({ tenant: t.slug, ...r });
        totalExpired += r.expired;
      } catch (err) {
        console.error(`[walletExpiry] tenant ${t.slug} failed: ${err.message}`);
        results.push({ tenant: t.slug, error: err.message });
      }
    }

    if (totalExpired > 0) {
      console.log(
        `[walletExpiry] swept ${tenants.length} tenants, expired ${totalExpired} batches`,
      );
    }

    return { tenants: tenants.length, expired: totalExpired, results };
  } catch (err) {
    console.error(`[walletExpiry] sweep failed: ${err.message}`);
    return { tenants: 0, expired: 0, error: err.message };
  }
}

/**
 * Register the daily cron. Safe to call once at boot.
 *
 * 03:30 IST = 22:00 UTC the previous day. node-cron evaluates the
 * expression against the timezone we pass in, so `30 3 * * *` +
 * `timezone: 'Asia/Kolkata'` fires at 03:30 IST regardless of the
 * server's local TZ.
 */
function initWalletExpiryCron() {
  cron.schedule(
    DEFAULT_SCHEDULE,
    () => {
      module.exports.run().catch((e) =>
        console.error(`[walletExpiry] cron tick failed: ${e.message}`),
      );
    },
    { timezone: "Asia/Kolkata" },
  );
  console.log("[walletExpiry] cron initialized (daily 03:30 IST)");
}

module.exports = {
  initWalletExpiryCron,
  run,
  runForTenant,
  expireBatch,
  writeAuditSafe,
  DEFAULT_SCHEDULE,
};
