// @ts-check
/**
 * D16 Wallet Top-up — Arc 1 polish slice (admin manual trigger).
 *
 * PRD: docs/PRD_WALLET_TOPUP.md §3.5 Phase 2 (expiry mechanic).
 *
 * Surface
 * ───────
 *   POST /api/wallet/admin/run-expiry  ADMIN-only manual trigger for
 *                                      cron/walletExpiryEngine.js
 *
 * Why this exists
 * ───────────────
 * walletExpiryEngine (tick #3 commit 986245bf) only runs on its daily
 * 03:30 IST cron tick. Ops + tests + on-call need a deterministic way
 * to fire the sweep against the requesting tenant without waiting for
 * the next cron window. This endpoint mirrors the canonical pattern
 * documented in .claude/skills/adding-admin-trigger-endpoint/SKILL.md
 * — /api/forecasting/snapshot/run + /api/billing/recurring/run +
 * /api/gdpr/retention/run all share the shape.
 *
 * Three stacked guards (mirror G-11 retentionEngine — also destructive):
 *   1. verifyToken — must be authenticated.
 *   2. verifyRole(['ADMIN']) — tenant admin only.
 *   3. body.confirmDestructive === true — the sweep DECREMENTS
 *      Wallet.balance for every expired batch (PRD §3.5 Phase 2 explicit:
 *      "decrement Wallet.balance; set batch remainingCents=0"). Without
 *      the flag → 400 CONFIRMATION_REQUIRED, no DB mutation, no audit
 *      row.
 *
 * Engine semantics (mirrors cron/walletExpiryEngine.js):
 *   Delegates to walletExpiryEngine.runForTenant(req.user.tenantId).
 *   Cron + manual paths share the same business logic so they can
 *   never drift on idempotency / decrement semantics. Engine returns
 *   { tenantId, scanned, expired, errors[] }; we splat into the
 *   envelope so the spec sees the engine's counters one-to-one.
 *
 * Response shape
 * ──────────────
 *   200 (success): { success: true, tenantId, scanned, expired, errors }
 *   400 (missing flag): { success: false, error, code: 'CONFIRMATION_REQUIRED' }
 *   401 (no token): handled by verifyToken middleware
 *   403 (non-ADMIN): handled by verifyRole middleware
 *   500 (engine threw): { success: false, tenantId, error, code: 'WALLET_EXPIRY_RUN_FAILED' }
 *
 * Audit:
 *   Fires writeAudit('Wallet', 'WALLET_EXPIRY_MANUAL_TRIGGER', null,
 *   req.user.userId, req.user.tenantId, { via: 'manual', scanned,
 *   expired, errors: errors.length }). The engine itself writes a
 *   per-batch WALLET_EXPIRY audit row inside runForTenant; this one
 *   captures the WHO/WHEN of the manual trigger (matches the G-11
 *   retention pattern where the cron path also writes per-row but the
 *   manual trigger adds an operator audit row).
 *
 * Mount order in server.js MUST come BEFORE `app.use('/api/wallet', ...)`
 * and BEFORE `app.use('/api/wallet/rules', ...)` so that
 * /api/wallet/admin/run-expiry doesn't get caught by the `:patientId`
 * dynamic segment in routes/wallet.js (which would parse 'admin' as a
 * patientId and trip an "Invalid patientId" 400).
 */

const express = require("express");
const router = express.Router();

const { verifyToken, verifyRole } = require("../middleware/auth");
const walletExpiryEngine = require("../cron/walletExpiryEngine");
const { writeAudit } = require("../lib/audit");

// ─────────────────────────────────────────────────────────────────────
// POST /api/wallet/admin/run-expiry
// ─────────────────────────────────────────────────────────────────────
router.post(
  "/run-expiry",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    // Hard guard #3 — the destructive-confirmation flag.
    if (req.body?.confirmDestructive !== true) {
      return res.status(400).json({
        success: false,
        error:
          "Wallet expiry sweep requires explicit confirmDestructive:true in body",
        code: "CONFIRMATION_REQUIRED",
      });
    }

    const tenantId = req.user.tenantId;
    const userId = req.user.userId || null;

    try {
      // Engine returns { tenantId, scanned, expired, errors }.
      // Splat directly so the envelope matches the engine's counters
      // one-to-one (canonical pattern from G-9 / G-10 / G-11 / G-12).
      const result = await walletExpiryEngine.runForTenant(tenantId);

      // Operator audit row — fire-and-forget so an audit hiccup never
      // breaks the trigger response.
      writeAudit(
        "Wallet",
        "WALLET_EXPIRY_MANUAL_TRIGGER",
        null,
        userId,
        tenantId,
        {
          via: "manual",
          scanned: result.scanned,
          expired: result.expired,
          errorCount: Array.isArray(result.errors) ? result.errors.length : 0,
        },
      ).catch((err) => {
        console.warn(
          `[walletAdmin] manual-trigger audit failed: ${err.message}`,
        );
      });

      return res.json({
        success: true,
        tenantId,
        scanned: result.scanned,
        expired: result.expired,
        errors: result.errors || [],
      });
    } catch (err) {
      console.error(
        `[walletAdmin] run-expiry failed for tenant ${tenantId}: ${err.message}`,
      );
      return res.status(500).json({
        success: false,
        tenantId,
        error: err.message,
        code: "WALLET_EXPIRY_RUN_FAILED",
      });
    }
  },
);

module.exports = router;
