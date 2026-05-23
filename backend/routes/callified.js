/**
 * /api/callified — operator wrapper for backend/services/callifiedClient.js
 *
 * Stub-mode today (Q1 cred-blocked per CREDS_TRACKER Cat 1). When Yasin's
 * Callified.ai handover arrives, the service swaps to real-mode and this
 * route stays unchanged.
 *
 * PRD_AI_CALLING_CALLIFIED DC-1/2/3/5/7 [RESOLVED 2026-05-24]: $100/mo cap +
 * 90s per-call ceiling + persona-per-sub-brand + counsel-batched TRAI + per-
 * tenant disable toggle. Cap via canonical getBudgetCap('ai_calling').
 *
 * Sibling wrapper routes (same pattern):
 *   - /api/adsgpt (commit 0d66a74)
 *   - /api/ratehawk (commit be67789)
 *
 * Next sibling wrapper: /api/booking-expedia (separate tick due to server.js
 * mount collision risk — 3 wrappers can't all edit server.js in one tick).
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const callifiedClient = require("../services/callifiedClient");
const { writeAudit } = require("../lib/audit");

/**
 * Sub-brand isolation guard — mirrors the /api/ratehawk pattern at commit
 * be67789. If the caller authenticated via a sub-brand-scoped API key
 * (req.apiKeySubBrand set by externalAuth/voyagrAuth), the body subBrand
 * is force-pinned to that value AND any mismatching body is rejected with
 * 403 SUB_BRAND_MISMATCH. Operator JWT auth (verifyToken-only) leaves
 * req.apiKeySubBrand undefined so cross-sub-brand operations are allowed
 * for operators.
 *
 * Returns { ok: true, effectiveSubBrand } or { ok: false, status, body }.
 */
function resolveSubBrand(req, suppliedSubBrand) {
  if (req.apiKeySubBrand !== undefined && req.apiKeySubBrand !== null) {
    if (suppliedSubBrand && suppliedSubBrand !== req.apiKeySubBrand) {
      return {
        ok: false,
        status: 403,
        body: {
          error: `API key scoped to '${req.apiKeySubBrand}' cannot operate on sub-brand '${suppliedSubBrand}'`,
          code: "SUB_BRAND_MISMATCH",
        },
      };
    }
    return { ok: true, effectiveSubBrand: req.apiKeySubBrand };
  }
  return { ok: true, effectiveSubBrand: suppliedSubBrand || null };
}

/**
 * POST /api/callified/calls/initiate
 *
 * Body: { subBrand?, toPhone (required), leadId?, intent?, persona? }
 *
 * ADMIN/MANAGER only — outbound AI calls cost real money + reach real
 * customers, so we gate behind elevated roles even for stub-mode.
 * Delegates to callifiedClient.initiateCall. Two structured error paths:
 *   - AI_CALLING_BUDGET_EXCEEDED → 402 with spent/cap cents
 *   - AI_CALLING_DISABLED        → 403 (per-tenant featureFlag DC-7)
 * Writes a CallifiedCall INITIATE audit row on success.
 */
router.post(
  "/calls/initiate",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const {
        subBrand: bodySubBrand,
        toPhone,
        leadId,
        intent,
        persona,
      } = req.body || {};

      if (!toPhone) {
        return res
          .status(400)
          .json({ error: "toPhone is required", code: "MISSING_TO_PHONE" });
      }

      const sb = resolveSubBrand(req, bodySubBrand);
      if (!sb.ok) return res.status(sb.status).json(sb.body);

      const result = await callifiedClient.initiateCall({
        tenantId: req.user.tenantId,
        subBrand: sb.effectiveSubBrand,
        toPhone,
        leadId,
        intent,
        persona,
      });

      await writeAudit(
        "CallifiedCall",
        "INITIATE",
        result && result.callId ? String(result.callId) : null,
        req.user.userId,
        req.user.tenantId,
        {
          subBrand: sb.effectiveSubBrand,
          toPhone,
          leadId: leadId || null,
          intent: intent || null,
        },
      );

      res.json(result);
    } catch (e) {
      if (e.code === "AI_CALLING_BUDGET_EXCEEDED") {
        return res.status(402).json({
          error: e.message,
          code: "AI_CALLING_BUDGET_EXCEEDED",
          spentCents: e.spentCents,
          capCents: e.capCents,
        });
      }
      if (e.code === "AI_CALLING_DISABLED") {
        return res.status(403).json({
          error: e.message,
          code: "AI_CALLING_DISABLED",
        });
      }
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[callified] calls/initiate error:", e.message);
      res.status(500).json({ error: "Failed to initiate call" });
    }
  },
);

/**
 * GET /api/callified/calls/:callId/result
 *
 * Fetch recording / transcript / summary post-call. Open to any
 * authenticated user — read-only, no role gate. Sub-brand isolation
 * is not applied here (the sub-brand scope was enforced at /initiate
 * time and callId already pins the record).
 */
router.get("/calls/:callId/result", verifyToken, async (req, res) => {
  try {
    const { callId } = req.params;
    const result = await callifiedClient.fetchCallResult({
      tenantId: req.user.tenantId,
      callId,
    });
    res.json(result);
  } catch (e) {
    if (e.status) {
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    console.error("[callified] calls/:callId/result error:", e.message);
    res.status(500).json({ error: "Failed to fetch call result" });
  }
});

/**
 * GET /api/callified/cap-status — ADMIN-only operator surface.
 *
 * Returns the current per-tenant cap utilisation so the operator UI can
 * render an "X% of monthly cap" indicator without firing a call.
 * Read-only — no audit row written.
 */
router.get(
  "/cap-status",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const status = await callifiedClient.checkBudgetCap(req.user.tenantId);
      res.json({
        spentCents: status.spentCents,
        capCents: status.capCents,
        percent: status.percent,
        withinCap: status.withinCap,
        alertThreshold: status.alertThreshold,
      });
    } catch (e) {
      if (e.code === "AI_CALLING_BUDGET_EXCEEDED") {
        return res.status(402).json({
          error: e.message,
          code: "AI_CALLING_BUDGET_EXCEEDED",
          spentCents: e.spentCents,
          capCents: e.capCents,
        });
      }
      console.error("[callified] cap-status error:", e.message);
      res.status(500).json({ error: "Failed to read cap status" });
    }
  },
);

/**
 * GET /api/callified/enabled
 *
 * Returns { enabled: boolean } so the operator UI can decide whether to
 * render the "Place AI call" CTA. Open to any authenticated user — any
 * operator may need to know whether the feature is on (DC-7 per-tenant
 * disable toggle). Defaults to true when the TenantSetting is absent.
 */
router.get("/enabled", verifyToken, async (req, res) => {
  try {
    const enabled = await callifiedClient.isEnabledForTenant(
      req.user.tenantId,
    );
    res.json({ enabled: Boolean(enabled) });
  } catch (e) {
    console.error("[callified] enabled error:", e.message);
    res.status(500).json({ error: "Failed to read enabled flag" });
  }
});

module.exports = router;
