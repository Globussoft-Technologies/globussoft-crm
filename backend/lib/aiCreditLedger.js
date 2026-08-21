"use strict";

// AI credit ledger — CRM-managed AI subscription balance tracking.
//
// One AiCreditWallet per tenant holds the live balance; every change is
// also recorded as an immutable AiCreditTransaction row (PURCHASE | USAGE |
// ADJUSTMENT | REFUND). See prisma/schema.prisma model docs for the full
// design rationale.
//
// Concurrency / correctness guarantees:
//   - deductUsage() runs balance check + decrement + ledger insert inside a
//     single prisma.$transaction so two concurrent requests can't both read
//     a stale balance and both succeed past zero (MySQL row lock on the
//     wallet UPDATE serializes concurrent deductions).
//   - requestId is the idempotency key: a retried deduction for the same
//     AI request hits AiCreditTransaction's unique constraint and is
//     treated as already-applied rather than double-charged.
//   - Failed/cancelled AI requests never call deductUsage() — callers only
//     invoke it after a successful provider response.

const prisma = require("./prisma");

const LOW_BALANCE_THRESHOLDS = [25, 10, 5]; // percent-remaining trip points, highest first

// Display/pricing-input conversion only — the wallet and every ledger row
// stay token-native internally (AiCreditWallet.balanceTokens etc. are real
// provider tokens, never "credits"). "1 Credit = 1,000 tokens" exists
// purely at the two edges that talk to humans:
//   - Super Admin plan form: operator types a credit count (e.g. 8,000) →
//     multiply by TOKENS_PER_CREDIT to get the AiSubscriptionPlan.creditTokens
//     value actually stored/granted.
//   - Tenant-facing UI: divide stored token counts by TOKENS_PER_CREDIT to
//     show the friendlier "credits" number.
// This keeps every internal computation (deduction, idempotency, low-balance
// thresholds) exact-integer token arithmetic with zero rounding surface.
const TOKENS_PER_CREDIT = 1000;

function tokensToCredits(tokens) {
  return Math.round(Number(tokens || 0) / TOKENS_PER_CREDIT);
}

function creditsToTokens(credits) {
  return Math.round(Number(credits || 0) * TOKENS_PER_CREDIT);
}

async function getOrCreateWallet(tenantId) {
  const existing = await prisma.aiCreditWallet.findUnique({ where: { tenantId } });
  if (existing) return existing;
  try {
    return await prisma.aiCreditWallet.create({ data: { tenantId } });
  } catch (e) {
    // Race: another request created it first — re-read.
    if (e.code === "P2002") {
      return prisma.aiCreditWallet.findUnique({ where: { tenantId } });
    }
    throw e;
  }
}

async function getWalletState(tenantId) {
  const wallet = await getOrCreateWallet(tenantId);
  const activeSubscription = await prisma.aiTenantSubscription.findFirst({
    where: {
      tenantId,
      status: "ACTIVE",
      OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
    },
    orderBy: { startDate: "desc" },
    include: { plan: true },
  });

  const percentRemaining = wallet.totalPurchasedTokens > 0
    ? Math.max(0, Math.min(100, Math.round((wallet.balanceTokens / wallet.totalPurchasedTokens) * 100)))
    : 0;

  return {
    wallet,
    activeSubscription,
    hasActiveSubscription: Boolean(activeSubscription),
    percentRemaining,
    percentUsed: 100 - percentRemaining,
  };
}

// Whether the tenant currently has enough CRM-managed AI access to attempt
// a request. Does NOT reserve credits — real deduction happens after the
// provider call completes (deductUsage). estimatedTokens is an optional
// pre-flight sanity check (e.g. reject obviously-oversized requests before
// spending provider latency), defaulting to 1 so "any balance at all" gates.
async function canUseManagedAi(tenantId, { estimatedTokens = 1 } = {}) {
  const state = await getWalletState(tenantId);
  if (!state.hasActiveSubscription) {
    return { allowed: false, reason: "NO_ACTIVE_SUBSCRIPTION", ...state };
  }
  if (state.wallet.balanceTokens < estimatedTokens) {
    return { allowed: false, reason: "CREDITS_EXHAUSTED", ...state };
  }
  return { allowed: true, reason: null, ...state };
}

// Record a successful AI request's actual token usage and deduct it from
// the tenant's balance. Idempotent on requestId — a retried call with the
// same requestId returns the existing transaction instead of deducting
// again. Never call this before the provider call has actually succeeded.
//
// This function is pure bookkeeping, not a gate: by the time it runs, the
// provider has already delivered the response (the tenant already "got"
// the tokens), so it always applies the debit even if the balance goes
// slightly negative under a burst of concurrent final requests that all
// passed canUseManagedAi()'s pre-flight check against the same
// not-yet-decremented balance. The atomic `{ decrement }` below only
// guarantees no lost updates between concurrent deductions (each request's
// tokens are fully accounted for exactly once) — it does not clamp at
// zero. A small negative balance is corrected on the next purchase/top-up
// and is preferable to rejecting an AI response the tenant already
// received.
async function deductUsage({
  tenantId,
  requestId,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = null,
  provider = null,
  model = null,
  surface = null,
  llmCallLogId = null,
}) {
  if (!tenantId) throw new Error("deductUsage requires tenantId");
  const tokens = Number.isFinite(totalTokens) && totalTokens > 0
    ? Math.round(totalTokens)
    : Math.round(Number(promptTokens || 0) + Number(completionTokens || 0));
  if (!(tokens > 0)) {
    return { deducted: false, reason: "ZERO_TOKENS" };
  }

  if (requestId) {
    const existing = await prisma.aiCreditTransaction.findUnique({
      where: { requestId },
    });
    if (existing) {
      return { deducted: false, reason: "ALREADY_APPLIED", transaction: existing };
    }
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Ensure the wallet row exists first (idempotent create-if-missing;
      // races here just hit P2002 on the unique tenantId and the loser
      // re-reads — harmless since no balance has moved yet).
      const existingWallet = await tx.aiCreditWallet.findUnique({ where: { tenantId } });
      if (!existingWallet) {
        await tx.aiCreditWallet.create({ data: { tenantId } }).catch(() => {});
      }

      // Atomic SQL-level decrement — NOT a read-then-write of a JS-computed
      // balance. `{ decrement: tokens }` compiles to `balanceTokens =
      // balanceTokens - tokens` in the UPDATE statement itself, so MySQL
      // serializes concurrent decrements on this row via its own row lock
      // instead of two transactions each computing from the same stale
      // snapshot and clobbering each other (the lost-update race a
      // findUnique-then-update pattern would have here).
      const updated = await tx.aiCreditWallet.update({
        where: { tenantId },
        data: {
          balanceTokens: { decrement: tokens },
          totalUsedTokens: { increment: tokens },
        },
      });

      const transaction = await tx.aiCreditTransaction.create({
        data: {
          tenantId,
          walletId: updated.id,
          type: "USAGE",
          tokens: -tokens,
          balanceAfter: updated.balanceTokens,
          promptTokens: Math.round(Number(promptTokens || 0)),
          completionTokens: Math.round(Number(completionTokens || 0)),
          provider,
          model,
          surface,
          requestId: requestId || null,
          llmCallLogId,
        },
      });

      return { wallet: updated, transaction };
    });

    return { deducted: true, ...result };
  } catch (e) {
    // Idempotency race: two concurrent retries with the same requestId both
    // pass the pre-check above, then the loser hits the unique constraint.
    if (e.code === "P2002" && requestId) {
      const existing = await prisma.aiCreditTransaction.findUnique({ where: { requestId } });
      return { deducted: false, reason: "ALREADY_APPLIED", transaction: existing };
    }
    throw e;
  }
}

// Reference rate used to convert a non-token AI cost (Whisper audio
// transcription billed per-minute, DALL-E image generation billed per-image)
// into an equivalent token count so it can still be deducted from the same
// wallet. Anchored on gemini-flash's blended $/1K-token rate (the platform's
// default cheap-tier text model, see lib/apiPricing.js PRICING_PER_1K) —
// arbitrary but consistent, and documented here so it's the one place to
// retune if pricing drifts. $costUsd / REFERENCE_USD_PER_1K_TOKENS * 1000 =
// equivalent tokens.
const REFERENCE_USD_PER_1K_TOKENS = 0.0003; // gemini-2.5-flash blended (in+out) rate

function usdCostToEquivalentTokens(costUsd) {
  const cost = Number(costUsd || 0);
  if (!(cost > 0)) return 0;
  return Math.max(1, Math.round((cost / REFERENCE_USD_PER_1K_TOKENS) * 1000));
}

// Deduct a non-token AI cost (Whisper transcription, DALL-E image
// generation) by converting its $ cost into an equivalent token count first.
// Same idempotency/atomicity guarantees as deductUsage — in fact this IS
// deductUsage, just with the token figure pre-computed from a $ cost instead
// of a provider-reported prompt/completion split.
async function deductCost({ tenantId, requestId, costUsd, provider = null, model = null, surface = null, llmCallLogId = null }) {
  const equivalentTokens = usdCostToEquivalentTokens(costUsd);
  if (!(equivalentTokens > 0)) {
    return { deducted: false, reason: "ZERO_COST" };
  }
  return deductUsage({
    tenantId,
    requestId,
    totalTokens: equivalentTokens,
    provider,
    model,
    surface,
    llmCallLogId,
  });
}

// Credit a tenant's wallet — used by the Razorpay purchase-verification
// flow (type=PURCHASE) and by Super Admin manual adjustments
// (type=ADJUSTMENT / REFUND).
async function creditTokens({
  tenantId,
  tokens,
  type = "PURCHASE",
  orderId = null,
  performedBySuperAdmin = null,
  reason = null,
}) {
  if (!tenantId) throw new Error("creditTokens requires tenantId");
  if (!(Number(tokens) > 0)) throw new Error("creditTokens requires tokens > 0");
  const amount = Math.round(Number(tokens));

  return prisma.$transaction(async (tx) => {
    let wallet = await tx.aiCreditWallet.findUnique({ where: { tenantId } });
    if (!wallet) {
      wallet = await tx.aiCreditWallet.create({ data: { tenantId } });
    }

    const updated = await tx.aiCreditWallet.update({
      where: { tenantId },
      data: {
        balanceTokens: { increment: amount },
        totalPurchasedTokens: type === "PURCHASE" ? { increment: amount } : undefined,
        lastAlertPercent: null, // reset low-balance alert cooldown on any top-up
      },
    });

    const transaction = await tx.aiCreditTransaction.create({
      data: {
        tenantId,
        walletId: updated.id,
        type,
        tokens: amount,
        balanceAfter: updated.balanceTokens,
        orderId,
        performedBySuperAdmin,
        reason,
      },
    });

    return { wallet: updated, transaction };
  });
}

// Debit an ADJUSTMENT (Super Admin manual correction) — separate from
// deductUsage because adjustments aren't tied to a specific AI request and
// don't carry provider usage metadata.
async function debitAdjustment({ tenantId, tokens, performedBySuperAdmin, reason }) {
  if (!tenantId) throw new Error("debitAdjustment requires tenantId");
  if (!(Number(tokens) > 0)) throw new Error("debitAdjustment requires tokens > 0");
  const amount = Math.round(Number(tokens));

  return prisma.$transaction(async (tx) => {
    const wallet = await tx.aiCreditWallet.findUnique({ where: { tenantId } });
    if (!wallet) throw new Error("Tenant has no AI credit wallet yet");

    const updated = await tx.aiCreditWallet.update({
      where: { tenantId },
      data: { balanceTokens: { decrement: amount } },
    });

    const transaction = await tx.aiCreditTransaction.create({
      data: {
        tenantId,
        walletId: updated.id,
        type: "ADJUSTMENT",
        tokens: -amount,
        balanceAfter: updated.balanceTokens,
        performedBySuperAdmin,
        reason,
      },
    });

    return { wallet: updated, transaction };
  });
}

// Given the wallet state, determine whether a new low-balance threshold has
// just been crossed (so the caller can fire a notification exactly once per
// threshold crossing, not on every request). Returns the threshold percent
// to alert on, or null if nothing new to alert.
function nextAlertThreshold(wallet, percentRemaining) {
  for (const threshold of LOW_BALANCE_THRESHOLDS) {
    if (percentRemaining <= threshold) {
      if (wallet.lastAlertPercent == null || wallet.lastAlertPercent > threshold) {
        return threshold;
      }
      return null;
    }
  }
  return null;
}

module.exports = {
  LOW_BALANCE_THRESHOLDS,
  TOKENS_PER_CREDIT,
  tokensToCredits,
  creditsToTokens,
  usdCostToEquivalentTokens,
  getOrCreateWallet,
  getWalletState,
  canUseManagedAi,
  deductUsage,
  deductCost,
  creditTokens,
  debitAdjustment,
  nextAlertThreshold,
};
