/**
 * /api/adsgpt — operator wrapper for backend/services/adsGptClient.js
 *
 * Stub-mode today (Q1 cred-blocked per CREDS_TRACKER Cat 1). When Yasin's
 * AdsGPT handover arrives, the service swaps to real-mode and this route
 * stays unchanged — auth + sub-brand isolation + audit + cap surfacing live
 * here; provider invocation lives in the service.
 *
 * PRD_ADSGPT_MARKETING_REPORTS DC-2 [RESOLVED 2026-05-24]: $50/mo cap per
 * tenant — check via /cap-status; report calls return 402 with structured
 * error if cap exceeded.
 *
 * Mirror routes for the wrapper pattern (when other cred-blocked services
 * land their operator routes):
 *   - backend/services/ratehawkClient.js (commit 2852b82) — wrapper TBD
 *   - backend/services/callifiedClient.js (commit 9ec52df) — wrapper TBD
 *   - backend/services/bookingExpediaClient.js (commit db06414) — wrapper TBD
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const adsGptClient = require("../services/adsGptClient");
const { writeAudit } = require("../lib/audit");

// Valid platforms accepted by the provider (per PRD §3.4).
const VALID_PLATFORMS = ["all", "meta", "google", "linkedin", "youtube"];

function assertValidPlatform(p) {
  if (!VALID_PLATFORMS.includes(p)) {
    const err = new Error(
      `platform must be one of: ${VALID_PLATFORMS.join(", ")}`,
    );
    err.status = 400;
    err.code = "INVALID_PLATFORM";
    throw err;
  }
}

/**
 * GET /api/adsgpt/reports/ads
 *
 * Query params: ?subBrand=tmc&fromDate=2026-04-01&toDate=2026-04-30&platform=all|meta|google|linkedin|youtube
 *
 * Delegates to adsGptClient.fetchAdReport. Surfaces the client's
 * ADSGPT_BUDGET_EXCEEDED throw as 402 Payment Required with a structured
 * error body so the operator UI can show a cap-hit banner.
 *
 * Sub-brand isolation: if the request was authenticated with a sub-brand
 * scoped API key (req.apiKeySubBrand set by externalAuth/voyagrAuth), the
 * query-param subBrand is force-pinned to that value AND any mismatching
 * query is rejected with 403 SUB_BRAND_MISMATCH. Operator JWT auth
 * (verifyToken-only) leaves req.apiKeySubBrand undefined so cross-sub-brand
 * report fetches are allowed for operators.
 */
router.get("/reports/ads", verifyToken, async (req, res) => {
  try {
    const queriedSubBrand = req.query.subBrand
      ? String(req.query.subBrand)
      : null;
    const fromDate = req.query.fromDate ? String(req.query.fromDate) : null;
    const toDate = req.query.toDate ? String(req.query.toDate) : null;
    const platform = req.query.platform ? String(req.query.platform) : "all";

    assertValidPlatform(platform);

    // Sub-brand isolation for API-key-scoped callers.
    let effectiveSubBrand = queriedSubBrand;
    if (req.apiKeySubBrand !== undefined && req.apiKeySubBrand !== null) {
      if (queriedSubBrand && queriedSubBrand !== req.apiKeySubBrand) {
        return res.status(403).json({
          error: `API key scoped to '${req.apiKeySubBrand}' cannot fetch report for sub-brand '${queriedSubBrand}'`,
          code: "SUB_BRAND_MISMATCH",
        });
      }
      effectiveSubBrand = req.apiKeySubBrand;
    }

    const report = await adsGptClient.fetchAdReport({
      tenantId: req.user.tenantId,
      subBrand: effectiveSubBrand,
      fromDate,
      toDate,
      platform,
    });

    // Audit on success — operator visibility into who fetched what window.
    await writeAudit(
      "AdsGPTReport",
      "FETCH",
      null,
      req.user.userId,
      req.user.tenantId,
      { subBrand: effectiveSubBrand, fromDate, toDate, platform },
    );

    res.json(report);
  } catch (e) {
    // Client cap-exceeded → 402 Payment Required + structured error.
    if (e.code === "ADSGPT_BUDGET_EXCEEDED") {
      return res.status(402).json({
        error: e.message,
        code: "ADSGPT_BUDGET_EXCEEDED",
        spentCents: e.spentCents,
        capCents: e.capCents,
      });
    }
    if (e.status) {
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    console.error("[adsgpt] reports/ads error:", e.message);
    res.status(500).json({ error: "Failed to fetch ad report" });
  }
});

/**
 * GET /api/adsgpt/cap-status — ADMIN-only operator surface.
 *
 * Returns the current per-tenant cap utilisation so the operator UI can
 * render an "X% of monthly cap" indicator without firing a report call.
 * Read-only — no audit row written.
 */
router.get(
  "/cap-status",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const status = await adsGptClient.checkBudgetCap(req.user.tenantId);
      res.json({
        spentCents: status.spentCents,
        capCents: status.capCents,
        percent: status.percent,
        withinCap: status.withinCap,
        alertThreshold: status.alertThreshold,
      });
    } catch (e) {
      // checkBudgetCap throws when over cap — surface as 402 the same way
      // as reports/ads so the UI can render the same cap-hit banner.
      if (e.code === "ADSGPT_BUDGET_EXCEEDED") {
        return res.status(402).json({
          error: e.message,
          code: "ADSGPT_BUDGET_EXCEEDED",
          spentCents: e.spentCents,
          capCents: e.capCents,
        });
      }
      console.error("[adsgpt] cap-status error:", e.message);
      res.status(500).json({ error: "Failed to read cap status" });
    }
  },
);

module.exports = router;
