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

module.exports = router;
