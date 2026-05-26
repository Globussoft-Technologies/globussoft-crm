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
const { verifyToken, verifyRole } = require("../middleware/auth");
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

// ─────────────────────────────────────────────────────────────────────
// D16 Wallet Top-up — Arc 1 polish slice (PRD_WALLET_TOPUP §3).
//
// GET /api/wallet/stats — tenant-wide KPI aggregate
//
// First tenant-wide aggregate for the wallet route — the existing 4
// endpoints are all per-patient (/:patientId/balance|transactions|
// topup|redeem). This powers the owner dashboard's wallet tile
// ("3 wallets · ₹4.2K balance · ₹500 in topups this week ·
// 2 active credit batches · 1 expiring in 30 days").
//
// Mirrors routes/travel_suppliers.js /suppliers/stats + similar
// /commission-profiles/stats posture — anodyne aggregate, NO audit row
// written (read-only meta surface). USER role intentionally excluded
// from this gate (unlike the per-patient endpoints which use the
// clinical phiReadGate including doctor/professional/telecaller) — the
// tenant-wide aggregate is an owner-dashboard / management surface, so
// ADMIN+MANAGER only minimises the PII surface and keeps the data
// flow consistent with /suppliers/stats + wallet_admin.js.
//
// Query params:
//   ?from / ?to — optional ISO date bounds on WalletTransaction.createdAt.
//                 Narrows totalTopups + totalRedemptions + lastTopupAt
//                 (NOT totalWallets — that's point-in-time count).
//
// Aggregates:
//   - totalWallets        — Wallet rows for the tenant
//   - totalBalance        — sum of Wallet.balance (round half-up 2dp)
//   - totalTopups         — sum of WalletTransaction.amount type='TOP_UP'
//                           in date range (round half-up 2dp; absolute val)
//   - totalRedemptions    — sum of WalletTransaction.amount type='REDEEM'
//                           in date range (round half-up 2dp; absolute val
//                           since REDEEM rows are stored as negative
//                           amount-rupees per routes/wallet.js:673)
//   - activeCreditBatches — WalletCreditBatch with status='ACTIVE',
//                           remainingCents > 0, and (expiresAt > now OR
//                           expiresAt null — principal never expires)
//   - expiringSoonCount   — WalletCreditBatch with status='ACTIVE',
//                           remainingCents > 0, expiresAt in (now, now+30d)
//                           — feeds dashboard expiry alerts
//   - lastTopupAt         — most-recent WalletTransaction.createdAt where
//                           type='TOP_UP' in date range (or null)
//
// Express route ordering: literal-path /stats MUST be declared BEFORE
// the /:patientId/... family or `:patientId="stats"` would 400 on
// parseInt with "Invalid patientId" before reaching this handler.
// ─────────────────────────────────────────────────────────────────────
router.get("/stats", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    // Optional ISO date bounds on WalletTransaction.createdAt.
    const txnWhere = { tenantId };
    const fromRaw = req.query.from ? String(req.query.from) : null;
    const toRaw = req.query.to ? String(req.query.to) : null;
    if (fromRaw) {
      const d = new Date(fromRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "from must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      txnWhere.createdAt = Object.assign(txnWhere.createdAt || {}, { gte: d });
    }
    if (toRaw) {
      const d = new Date(toRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({
          error: "to must be a valid ISO date",
          code: "INVALID_DATE",
        });
      }
      txnWhere.createdAt = Object.assign(txnWhere.createdAt || {}, { lte: d });
    }

    // Half-up round to 2dp — matches /suppliers/stats posture.
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    const now = new Date();
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Wallets are point-in-time — NOT narrowed by the txn ?from/?to window.
    const wallets = await prisma.wallet.findMany({
      where: { tenantId },
      select: { balance: true },
    });

    const totalWallets = wallets.length;
    const totalBalance = round2(
      wallets.reduce((sum, w) => sum + (Number(w.balance) || 0), 0),
    );

    // Transaction aggregates — narrowed by ?from/?to if supplied.
    const topupTxns = await prisma.walletTransaction.findMany({
      where: { ...txnWhere, type: "TOP_UP" },
      select: { amount: true, createdAt: true },
    });
    const redeemTxns = await prisma.walletTransaction.findMany({
      where: { ...txnWhere, type: "REDEEM" },
      select: { amount: true },
    });

    const totalTopups = round2(
      topupTxns.reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0),
    );
    const totalRedemptions = round2(
      redeemTxns.reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0),
    );

    // Most-recent top-up timestamp — picks the newest createdAt across
    // the (already window-filtered) top-up rows.
    let lastTopupAt = null;
    for (const t of topupTxns) {
      const ts = t.createdAt instanceof Date ? t.createdAt : new Date(t.createdAt);
      if (!Number.isNaN(ts.getTime())) {
        if (!lastTopupAt || ts > lastTopupAt) lastTopupAt = ts;
      }
    }

    // Credit-batch aggregates — point-in-time (NOT narrowed by txn
    // window; expiry windows are absolute-now-based, not relative).
    const activeCreditBatches = await prisma.walletCreditBatch.count({
      where: {
        tenantId,
        status: "ACTIVE",
        remainingCents: { gt: 0 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });

    const expiringSoonCount = await prisma.walletCreditBatch.count({
      where: {
        tenantId,
        status: "ACTIVE",
        remainingCents: { gt: 0 },
        expiresAt: { gt: now, lt: thirtyDaysFromNow },
      },
    });

    return res.json({
      totalWallets,
      totalBalance,
      totalTopups,
      totalRedemptions,
      activeCreditBatches,
      expiringSoonCount,
      lastTopupAt: lastTopupAt ? lastTopupAt.toISOString() : null,
    });
  } catch (e) {
    console.error("[wallet] stats error:", e.message);
    return res.status(500).json({ error: "Failed to summarise wallet stats" });
  }
});

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

// ─────────────────────────────────────────────────────────────────────
// D16 Wallet Top-up — Arc 1 Slice 4 (PRD_WALLET_TOPUP §3.3 + DD-5.3).
//
// POST /api/wallet/:patientId/redeem
//
// Body: { amountCents: number, sourceType: 'VISIT'|'SALE', sourceId: number }
//
// Logic (single Prisma $transaction so debits + ledger + balance all
// commit-or-roll together):
//   1. Validate amountCents > 0; sourceType ∈ {VISIT, SALE}; sourceId is a
//      positive integer.
//   2. Validate patient exists in caller's tenant (tenantWhere) → 404 if not.
//   3. Find the patient's wallet → 404 WALLET_NOT_FOUND if no row yet
//      (impossible to redeem against a wallet that's never been topped up).
//   4. Inside the tx, collect ACTIVE non-expired batches for this wallet
//      ordered by redemption priority (DD-5.3 RESOLVED 2026-05-25):
//        a. PRINCIPAL first (FIFO — oldest createdAt wins)
//        b. BONUS second (soonest-expiry first — expiresAt ASC NULLS LAST)
//      "Customer-fair pattern": principal spends before bonus so the
//      customer's own money is consumed first and bonus credits stay
//      live as long as possible.
//   5. Sum the per-batch remainingCents — if total < amountCents, throw
//      INSUFFICIENT_BALANCE with both fields so the caller can render
//      "you have ₹X available, asked ₹Y" toast text.
//   6. Walk batches in order; for each take `consumed = min(remaining, need)`,
//      update batch.remainingCents -= consumed, set status='EXHAUSTED' when
//      it hits zero, decrement `need` by `consumed`, stop on need === 0.
//   7. Write ONE WalletTransaction(type='REDEEM', amount = -amountCents/100).
//      visitId/invoiceId populated based on sourceType for cross-link UX.
//   8. Update Wallet.balance -= amountCents/100.
//   9. Audit WALLET_REDEEM with {patientId, amountCents, sourceType,
//      sourceId, batchesUsed:[{batchId, consumedCents}, ...]}.
//  10. Respond { success, transactionId, debitedFromBatches, remainingBalanceCents }.
//
// Error codes:
//   400 INVALID_AMOUNT         amountCents ≤ 0 or non-integer
//   400 INVALID_SOURCE_TYPE    sourceType ∉ {VISIT, SALE}
//   400 INVALID_SOURCE_ID      sourceId not a positive integer
//   400 INSUFFICIENT_BALANCE   total active < amountCents (+ available + requested fields)
//   404 PATIENT_NOT_FOUND      patient missing in caller's tenant
//   404 WALLET_NOT_FOUND       patient has never been topped up
//   500 REDEEM_FAILED          unexpected DB / transaction error
//
// RBAC: clinical-write gate (same set as /topup — cashier/clerk at checkout).
// ─────────────────────────────────────────────────────────────────────

const ALLOWED_SOURCE_TYPES = new Set(["VISIT", "SALE"]);

// Reuse the topupGate set — cashier-led redemption at the till mirrors
// the top-up role surface exactly. (helper/telecaller intentionally
// excluded — helpers don't handle money; telecallers are pre-clinical.)
const redeemGate = topupGate;

router.post("/:patientId/redeem", redeemGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.patientId, 10);
    if (!Number.isFinite(patientId) || patientId <= 0) {
      return res
        .status(400)
        .json({ error: "Invalid patientId", code: "INVALID_AMOUNT" });
    }

    const amountCents = parseInt(req.body?.amountCents, 10);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({
        error: "amountCents must be a positive integer",
        code: "INVALID_AMOUNT",
      });
    }

    const sourceType = String(req.body?.sourceType || "").toUpperCase();
    if (!ALLOWED_SOURCE_TYPES.has(sourceType)) {
      return res.status(400).json({
        error: "sourceType must be one of: VISIT, SALE",
        code: "INVALID_SOURCE_TYPE",
      });
    }

    const sourceId = parseInt(req.body?.sourceId, 10);
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      return res.status(400).json({
        error: "sourceId must be a positive integer",
        code: "INVALID_SOURCE_ID",
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

    // Wallet existence check OUTSIDE the transaction so we can return a
    // crisp 404 without rolling anything back.
    const walletRow = await prisma.wallet.findFirst({
      where: tenantWhere(req, { patientId }),
      select: { id: true, balance: true },
    });
    if (!walletRow) {
      return res
        .status(404)
        .json({ error: "Wallet not found", code: "WALLET_NOT_FOUND" });
    }

    const now = new Date();

    // ── Atomic transaction: gather batches → check balance → walk debits
    //    → write ledger → update wallet balance. Throwing inside the
    //    callback rolls everything back so we never persist a partial
    //    redemption.
    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        // Fetch ACTIVE non-expired batches in redemption order.
        // We fetch PRINCIPAL and BONUS separately so we can apply the
        // tier-specific orderBy clauses (FIFO for principal, soonest-
        // expiry for bonus) without needing a multi-key sort that some
        // Prisma backends don't honour as "PRINCIPAL first then BONUS".
        const baseWhere = {
          tenantId: req.user.tenantId,
          walletId: walletRow.id,
          status: "ACTIVE",
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        };

        const [principalBatches, bonusBatches] = await Promise.all([
          tx.walletCreditBatch.findMany({
            where: { ...baseWhere, batchType: "PRINCIPAL" },
            orderBy: { createdAt: "asc" }, // FIFO — oldest first
          }),
          tx.walletCreditBatch.findMany({
            where: { ...baseWhere, batchType: "BONUS" },
            // Prisma MySQL doesn't natively support "NULLS LAST" — but
            // BONUS batches always have expiresAt populated (the topup
            // route only sets it for bonus when bonusCents > 0). So a
            // plain ASC on expiresAt is correct here.
            orderBy: { expiresAt: "asc" },
          }),
        ]);

        const orderedBatches = [...principalBatches, ...bonusBatches];

        // Compute total available BEFORE we start mutating.
        const availableCents = orderedBatches.reduce(
          (sum, b) => sum + b.remainingCents,
          0,
        );
        if (availableCents < amountCents) {
          // Throw a structured object so the outer catch can map it to
          // 400 INSUFFICIENT_BALANCE with the diagnostic fields.
          const err = new Error("INSUFFICIENT_BALANCE");
          err.code = "INSUFFICIENT_BALANCE";
          err.requestedCents = amountCents;
          err.availableCents = availableCents;
          throw err;
        }

        // Walk the ordered batch list, debiting each in turn.
        let remaining = amountCents;
        const debitedFromBatches = [];
        for (const batch of orderedBatches) {
          if (remaining <= 0) break;
          const consumed = Math.min(batch.remainingCents, remaining);
          const newRemaining = batch.remainingCents - consumed;
          await tx.walletCreditBatch.update({
            where: { id: batch.id },
            data: {
              remainingCents: newRemaining,
              status: newRemaining === 0 ? "EXHAUSTED" : "ACTIVE",
            },
          });
          debitedFromBatches.push({
            batchId: batch.id,
            batchType: batch.batchType,
            consumedCents: consumed,
          });
          remaining -= consumed;
        }

        // Compute new balance + write the ledger row.
        const newBalance = +(walletRow.balance - amountCents / 100).toFixed(2);
        const txnRow = await tx.walletTransaction.create({
          data: {
            tenantId: req.user.tenantId,
            walletId: walletRow.id,
            type: "REDEEM",
            // Negative to indicate a debit — matches the convention used
            // elsewhere in WalletTransaction-typed ledger writes (existing
            // wellness REDEEM-like consumption rows are stored as negative
            // amount-rupees so balance math is `SUM(amount)`).
            amount: -amountCents / 100,
            reason: `Redemption for ${sourceType} #${sourceId}`,
            visitId: sourceType === "VISIT" ? sourceId : null,
            invoiceId: sourceType === "SALE" ? sourceId : null,
            balanceAfter: newBalance,
            performedBy: req.user.userId,
          },
        });

        await tx.wallet.update({
          where: { id: walletRow.id },
          data: { balance: newBalance },
        });

        return {
          txnRow,
          debitedFromBatches,
          remainingBalanceCents: Math.round(newBalance * 100),
        };
      });
    } catch (txErr) {
      if (txErr.code === "INSUFFICIENT_BALANCE") {
        return res.status(400).json({
          error: "Insufficient wallet balance",
          code: "INSUFFICIENT_BALANCE",
          requestedCents: txErr.requestedCents,
          availableCents: txErr.availableCents,
        });
      }
      throw txErr;
    }

    // Fire-and-forget audit (matches the topup pattern above).
    writeAudit(
      "Wallet",
      "WALLET_REDEEM",
      walletRow.id,
      req.user.userId,
      req.user.tenantId,
      {
        patientId,
        amountCents,
        sourceType,
        sourceId,
        batchesUsed: result.debitedFromBatches,
      },
    ).catch((auditErr) => {
      console.warn("[wallet] audit WALLET_REDEEM failed:", auditErr.message);
    });

    return res.json({
      success: true,
      transactionId: result.txnRow.id,
      debitedFromBatches: result.debitedFromBatches,
      remainingBalanceCents: result.remainingBalanceCents,
    });
  } catch (e) {
    console.error("[wallet] redeem error:", e.message);
    return res
      .status(500)
      .json({ error: "Redemption failed", code: "REDEEM_FAILED" });
  }
});

module.exports = router;
