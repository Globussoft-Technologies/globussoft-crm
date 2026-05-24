// @ts-check
/**
 * D16 Wallet Top-up — Arc 1 slice 2-partial (read-only routes).
 *
 * PRD: docs/PRD_WALLET_TOPUP.md §3 functional requirements.
 *
 * This file ships ONLY the two read-side endpoints needed by the patient
 * Wallet tab (PRD FR-3.7) + the admin wallet-balance viewer:
 *
 *   GET /api/wallet/:patientId/balance       — current balance + lastUpdated
 *   GET /api/wallet/:patientId/transactions  — paginated transaction history
 *
 * Subsequent slices will ship (in dependency order, each gated on the
 * Agent A schema landing — `WalletBonusRule` + `WalletCreditBatch` +
 * extended `WalletTransaction.type` enum + `bucket` / `expiresAt` /
 * `sourceRuleName` / `batchId` fields):
 *
 *   slice 3 — POST /api/wallet/topup         (FR-3.2; applies bonus rules)
 *   slice 3 — POST /api/wallet/redeem        (FR-3.3; FIFO batch debit)
 *   slice 4 — POST /api/wallet/reverse/:txnId (FR-3.10)
 *   slice 5 — POST /api/wallet/expiry/run    (FR-3.5; admin trigger for
 *                                              walletExpiryEngine drain)
 *
 * Why path params (`/:patientId/balance`) here vs PRD's query-param
 * `GET /api/wallet/transactions?patientId=X` for the eventual unified
 * history endpoint: this slice serves the per-patient tab where the
 * patientId is always known + URL-shareable. The query-param variant in
 * PRD FR-3.4 is the FUTURE "cross-patient lookup with type filter +
 * walletBalance envelope" surface — it adds enriched batchDebitDetails
 * + sourceRuleName + expiryBatchId fields that depend on the schema
 * extensions Agent A is shipping this tick. Both surfaces can coexist
 * (additive); the path-param read here is the minimum-viable contract.
 *
 * Auth: phiReadGate (verifyWellnessRole-backed). Wallet balance is
 * financial PHI under DPDP Act §4(2)(c) — treated identically to
 * clinical PHI for the read gate. This MATCHES routes/wellness.js's
 * existing patient-detail read pattern (same role set: doctor /
 * professional / telecaller / admin / manager). USER with no
 * wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN. Unauthenticated → 401.
 *
 * Tenant scoping: tenantWhere helper (mirrored from routes/wellness.js
 * line 147). Cross-tenant reads return 404 — the patient row simply
 * isn't visible to the caller, never leaking the existence of rows
 * outside the caller's tenant.
 *
 * Audit: writeAudit('Patient', 'WALLET_BALANCE_READ', patientId, ...)
 * — fire-and-forget per #534 PERF-1 pattern. Throttling
 * (EMPLOYEE_PROFILE_VIEWED-style once-per-5-min-per-session) is FR-3.4
 * scope, not this slice — every read writes one row here.
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyWellnessRole } = require("../middleware/wellnessRole");
const { writeAudit } = require("../lib/audit");

// Wallet balance is financial PHI. phiReadGate-equivalent: same role set
// as routes/wellness.js's patient-detail / visits / Rx / consents reads
// (doctor / professional / telecaller / admin / manager). Helper +
// cashier intentionally excluded — helpers are non-clinical, cashier is
// gated to POS-only per PRD_WELLNESS_RBAC DD-5.6.
const phiReadGate = verifyWellnessRole([
  "doctor",
  "professional",
  "telecaller",
  "admin",
  "manager",
]);

// Mirrored from routes/wellness.js:147. Centralised so every route in
// this file applies tenant scope the same way.
const tenantWhere = (req, extra = {}) => ({
  tenantId: req.user.tenantId,
  ...extra,
});

// Mirrored from routes/wellness.js's capLimit helper (line 199). Defends
// against `?limit=N&limit=M` pollution + over-large pagination requests.
function capLimit(raw, { def = 25, max = 100 } = {}) {
  const val = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const n = parseInt(val, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

/**
 * GET /api/wallet/:patientId/balance
 *
 * Response 200: { balanceCents: number, currency: string, lastUpdated: ISOString }
 * Response 404: patient not found in caller's tenant.
 *
 * Wallet rows are created lazily — a patient with no prior wallet
 * activity returns `{balanceCents: 0, currency: tenant default, lastUpdated: null}`.
 * No row is written on read (defer wallet-row creation to the first TOPUP
 * write in slice 3 — keeps reads idempotent + zero-write).
 */
router.get("/:patientId/balance", phiReadGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.patientId, 10);
    if (!Number.isFinite(patientId) || patientId <= 0) {
      return res.status(400).json({ error: "Invalid patientId" });
    }

    // Tenant-scoped patient existence check first — cross-tenant probe
    // returns 404 (not 403) so we never reveal whether a row exists in
    // another tenant.
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
      select: { id: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const wallet = await prisma.wallet.findFirst({
      where: tenantWhere(req, { patientId }),
      select: { balance: true, currency: true, updatedAt: true },
    });

    // Float rupees → integer cents at the wire boundary. Math.round (not
    // Math.floor) so 1.555 → 156 cents matches the rounding used in
    // existing cap-banner accounting code (cashbackEngine et al).
    const balanceCents = wallet ? Math.round(wallet.balance * 100) : 0;
    const currency = wallet?.currency || "INR";
    const lastUpdated = wallet?.updatedAt ? wallet.updatedAt.toISOString() : null;

    writeAudit(
      "Patient",
      "WALLET_BALANCE_READ",
      patientId,
      req.user.userId,
      req.user.tenantId,
      { patientId, balanceCents, currency },
    ).catch((auditErr) => {
      console.warn("[wallet] audit WALLET_BALANCE_READ failed:", auditErr.message);
    });

    return res.json({ balanceCents, currency, lastUpdated });
  } catch (e) {
    console.error("[wallet] balance read error:", e.message);
    return res.status(500).json({ error: "Failed to read wallet balance" });
  }
});

/**
 * GET /api/wallet/:patientId/transactions?limit=25&offset=0
 *
 * Response 200: { transactions: WalletTransaction[], total: number }
 * Response 404: patient not found in caller's tenant.
 *
 * Pagination envelope matches routes/wellness.js's `/patients` list
 * convention (`{rows, total}` rather than `{rows, pagination: {...}}`).
 * The enriched PRD FR-3.4 envelope (`pagination` + `walletBalance` +
 * `batchDebitDetails` + `sourceRuleName` + `expiryBatchId`) belongs on
 * the future cross-patient query-param variant — it depends on schema
 * fields shipping in Agent A's slice.
 *
 * Empty patient (no wallet, or wallet with no transactions) returns
 * `{transactions: [], total: 0}` — NOT 404. The patient exists; their
 * wallet has zero history. 404 is reserved for the patient-doesn't-
 * exist-in-tenant case.
 *
 * Default `limit=25` mirrors the PRD FR-3.4 default. `max=100` is a
 * tight bound for a patient-tab paginated view — bulk transaction
 * exports will land as a separate /transactions.csv route.
 */
router.get("/:patientId/transactions", phiReadGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.patientId, 10);
    if (!Number.isFinite(patientId) || patientId <= 0) {
      return res.status(400).json({ error: "Invalid patientId" });
    }

    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
      select: { id: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const wallet = await prisma.wallet.findFirst({
      where: tenantWhere(req, { patientId }),
      select: { id: true },
    });

    // No wallet row yet → no transactions possible. Skip the txn query
    // entirely; return the empty envelope. (We avoid a wallet-aware
    // `WalletTransaction.findMany` against `walletId: undefined` which
    // Prisma would treat as "any" + leak cross-patient rows.)
    if (!wallet) {
      return res.json({ transactions: [], total: 0 });
    }

    const take = capLimit(req.query.limit, { def: 25, max: 100 });
    const skip = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const where = tenantWhere(req, { walletId: wallet.id });

    const [transactions, total] = await Promise.all([
      prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.walletTransaction.count({ where }),
    ]);

    return res.json({ transactions, total });
  } catch (e) {
    console.error("[wallet] transactions read error:", e.message);
    return res.status(500).json({ error: "Failed to read wallet transactions" });
  }
});

// ─────────────────────────────────────────────────────────────────────
// D16 Wallet Top-up — Arc 1 Slice 3 (PRD_WALLET_TOPUP §3.1 + §3.2).
//
// POST /api/wallet/:patientId/topup
//
// Body: { amountCents: number, paymentMethod: 'cash'|'card'|'upi'|'online' }
//
// Logic (single Prisma $transaction so balance + ledger + batches all
// commit-or-roll together):
//   1. Validate amount in (0, 10_000_000] (₹100K cap — defensive against
//      operator typos; real-world maxima land via WalletBonusRule limits).
//   2. Validate paymentMethod ∈ ALLOWED_PAYMENT_METHODS.
//   3. Validate patient exists in caller's tenant (tenantWhere).
//   4. Find-or-create the Wallet row (lazy; first top-up materialises it).
//   5. Find ALL active WalletBonusRule rows for this tenant where
//      minAmountCents ≤ amountCents AND (validFrom NULL OR ≤ now) AND
//      (validTo NULL OR > now). Pick the row with the HIGHEST bonusPercent
//      (DD-5.2 round-2 RESOLVED 2026-05-25 — highest-percent-wins).
//      Ties broken by lowest id for determinism.
//   6. bonusCents = floor(amountCents × bonusPercent / 100); zero if no
//      rule matched.
//   7. expiresAt = now + rule.validityMonths if bonus > 0; null otherwise.
//   8. Write WalletTransaction(type='TOP_UP', amount=amountCents/100 as
//      Float-rupees per existing schema; balanceAfter reflects principal
//      + bonus combined).
//   9. Write PRINCIPAL WalletCreditBatch (expiresAt=null —
//      principal never expires; sourceRuleId=null).
//  10. If bonus > 0, write a BONUS WalletCreditBatch (expiresAt set,
//      sourceRuleId=rule.id, sourceTransactionId=tx.id).
//  11. Update Wallet.balance += (principal + bonus) / 100.
//  12. Audit WALLET_TOPUP event with {patientId, principalCents,
//      bonusCents, ruleId|null}.
//  13. Respond { success, walletId, transactionId, balanceCents,
//      principalBatchId, bonusBatchId|null, bonusRuleId|null, bonusPercent }.
//
// Error codes (4xx are structured for SDK / frontend toast mapping):
//   400 INVALID_AMOUNT          amountCents ≤ 0 or > 10_000_000
//   400 INVALID_PAYMENT_METHOD  paymentMethod ∉ ALLOWED_PAYMENT_METHODS
//   404 PATIENT_NOT_FOUND       patient missing in caller's tenant
//   500 TOPUP_FAILED            unexpected DB / transaction error
//
// RBAC: clinical-role gate (verifyWellnessRole with cashier included —
// counter cashier needs to top up at the till per PRD FR-3.1). Helper +
// telecaller intentionally excluded — helpers don't handle money;
// telecallers are pre-clinical lead routing only.
// ─────────────────────────────────────────────────────────────────────

const ALLOWED_PAYMENT_METHODS = new Set(["cash", "card", "upi", "online"]);
const MAX_TOPUP_CENTS = 10_000_000; // ₹100,000 = ₹1L cap per single top-up

// Clinical-write gate for top-up: cashier is the counter role that
// actually books money; doctor/professional/manager/admin can also top
// up (e.g. an admin reconciling an offline cash bundle). Helper and
// telecaller are excluded — see route comment block above.
const topupGate = verifyWellnessRole([
  "doctor",
  "professional",
  "cashier",
  "admin",
  "manager",
]);

// Prisma Decimal → plain Number helper. WalletBonusRule.bonusPercent is
// `Decimal @db.Decimal(5,2)` which Prisma returns as a Decimal.js
// instance. We need a Number to do `Math.floor(amount * pct / 100)`.
// Mock test runs may return plain JS numbers — handle both.
function decimalToNumber(d) {
  if (d == null) return 0;
  if (typeof d === "number") return d;
  if (typeof d.toNumber === "function") return d.toNumber();
  // Strings + everything else: fall back to Number(); NaN guard.
  const n = Number(d);
  return Number.isFinite(n) ? n : 0;
}

router.post("/:patientId/topup", topupGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.patientId, 10);
    if (!Number.isFinite(patientId) || patientId <= 0) {
      return res
        .status(400)
        .json({ error: "Invalid patientId", code: "INVALID_AMOUNT" });
    }

    const amountCents = parseInt(req.body?.amountCents, 10);
    if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > MAX_TOPUP_CENTS) {
      return res.status(400).json({
        error: "amountCents must be a positive integer ≤ 10,000,000",
        code: "INVALID_AMOUNT",
      });
    }

    const paymentMethod = String(req.body?.paymentMethod || "").toLowerCase();
    if (!ALLOWED_PAYMENT_METHODS.has(paymentMethod)) {
      return res.status(400).json({
        error: "paymentMethod must be one of: cash, card, upi, online",
        code: "INVALID_PAYMENT_METHOD",
      });
    }

    // Tenant-scoped existence guard. Cross-tenant patientId → 404 (never
    // 403) so we don't leak whether the patient row exists in another
    // tenant.
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
      select: { id: true },
    });
    if (!patient) {
      return res
        .status(404)
        .json({ error: "Patient not found", code: "PATIENT_NOT_FOUND" });
    }

    // Resolve the matching bonus rule BEFORE opening the transaction so
    // we don't hold a row lock while iterating rules. Active + within
    // validity window + minAmountCents ≤ amountCents.
    const now = new Date();
    const candidateRules = await prisma.walletBonusRule.findMany({
      where: {
        tenantId: req.user.tenantId,
        active: true,
        minAmountCents: { lte: amountCents },
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
          { OR: [{ validTo: null }, { validTo: { gt: now } }] },
        ],
      },
    });

    // Pick highest bonusPercent (DD-5.2 round-2 RESOLVED 2026-05-25).
    // Tiebreaker: lowest id (deterministic, oldest-rule-wins on a tie).
    let chosenRule = null;
    let chosenPct = 0;
    for (const r of candidateRules) {
      const pct = decimalToNumber(r.bonusPercent);
      if (
        pct > chosenPct ||
        (pct === chosenPct && chosenRule && r.id < chosenRule.id)
      ) {
        chosenRule = r;
        chosenPct = pct;
      }
    }

    const bonusCents = chosenRule ? Math.floor((amountCents * chosenPct) / 100) : 0;
    const expiresAt =
      chosenRule && bonusCents > 0
        ? new Date(now.getTime() + chosenRule.validityMonths * 30 * 24 * 60 * 60 * 1000)
        : null;

    // ── Atomic transaction: wallet upsert + tx row + 1-or-2 batches +
    //    balance update. Throwing inside the callback rolls everything
    //    back so we never observe a partial top-up.
    const result = await prisma.$transaction(async (tx) => {
      // Find-or-create wallet inside the tx so two concurrent first-
      // top-ups for the same patient don't both insert.
      let wallet = await tx.wallet.findFirst({
        where: tenantWhere(req, { patientId }),
      });
      if (!wallet) {
        const tenant = await tx.tenant.findUnique({
          where: { id: req.user.tenantId },
          select: { defaultCurrency: true },
        });
        wallet = await tx.wallet.create({
          data: {
            tenantId: req.user.tenantId,
            patientId,
            currency: tenant?.defaultCurrency || "INR",
          },
        });
      }

      const totalCredit = amountCents + bonusCents;
      const newBalance = +(wallet.balance + totalCredit / 100).toFixed(2);

      const txnRow = await tx.walletTransaction.create({
        data: {
          tenantId: req.user.tenantId,
          walletId: wallet.id,
          type: "TOP_UP",
          amount: amountCents / 100, // float-rupees (existing schema)
          reason: `Top-up via ${paymentMethod}${chosenRule ? ` (bonus: ${chosenRule.name})` : ""}`,
          balanceAfter: newBalance,
          performedBy: req.user.userId,
        },
      });

      const principalBatch = await tx.walletCreditBatch.create({
        data: {
          tenantId: req.user.tenantId,
          walletId: wallet.id,
          batchType: "PRINCIPAL",
          amountCents,
          remainingCents: amountCents,
          expiresAt: null,
          sourceRuleId: null,
          sourceTransactionId: txnRow.id,
          status: "ACTIVE",
        },
      });

      let bonusBatch = null;
      if (bonusCents > 0) {
        bonusBatch = await tx.walletCreditBatch.create({
          data: {
            tenantId: req.user.tenantId,
            walletId: wallet.id,
            batchType: "BONUS",
            amountCents: bonusCents,
            remainingCents: bonusCents,
            expiresAt,
            sourceRuleId: chosenRule.id,
            sourceTransactionId: txnRow.id,
            status: "ACTIVE",
          },
        });
      }

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: newBalance },
      });

      return { wallet, txnRow, principalBatch, bonusBatch, newBalance };
    });

    // Fire-and-forget audit (matches the pattern used by balance read
    // above + Wave-11 Wallet+GiftCard surface in routes/wellness.js).
    writeAudit(
      "Wallet",
      "WALLET_TOPUP",
      result.wallet.id,
      req.user.userId,
      req.user.tenantId,
      {
        patientId,
        principalCents: amountCents,
        bonusCents,
        ruleId: chosenRule ? chosenRule.id : null,
        paymentMethod,
      },
    ).catch((auditErr) => {
      console.warn("[wallet] audit WALLET_TOPUP failed:", auditErr.message);
    });

    return res.json({
      success: true,
      walletId: result.wallet.id,
      transactionId: result.txnRow.id,
      balanceCents: Math.round(result.newBalance * 100),
      principalBatchId: result.principalBatch.id,
      bonusBatchId: result.bonusBatch ? result.bonusBatch.id : null,
      bonusRuleId: chosenRule ? chosenRule.id : null,
      bonusPercent: chosenPct,
    });
  } catch (e) {
    console.error("[wallet] topup error:", e.message);
    return res.status(500).json({ error: "Top-up failed", code: "TOPUP_FAILED" });
  }
});

module.exports = router;
