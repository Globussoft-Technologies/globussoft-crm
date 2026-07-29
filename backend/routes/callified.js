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
const { resolveSubBrand } = require("../lib/subBrandResolve");
const prisma = require("../lib/prisma");

// Sub-brand isolation guard imported from ../lib/subBrandResolve (tick #106
// rule-of-3 promotion — previously inlined here, in ratehawk.js, and in
// booking_expedia.js byte-identically). Contract: API-key-scoped callers
// (req.apiKeySubBrand set by externalAuth/voyagrAuth) get force-pinned to
// their scope and mismatching body rejected as 403 SUB_BRAND_MISMATCH;
// operator JWT callers pass body through. See lib for full JSDoc.

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

/**
 * GET /api/callified/campaigns
 *
 * List active Callified campaigns so the CRM leads page can pick one before
 * dialing. Open to ADMIN/MANAGER — choosing a campaign costs real money.
 */
router.get(
  "/campaigns",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const campaigns = await callifiedClient.listCampaigns(req.user.tenantId);
      res.json({ campaigns: campaigns || [] });
    } catch (e) {
      if (e.code === "CALLIFIED_NOT_CONFIGURED" || e.code === "CALLIFIED_AUTH_FAILED") {
        return res.status(503).json({ error: e.message, code: e.code });
      }
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[callified] campaigns error:", e.message);
      res.status(500).json({ error: "Failed to fetch campaigns" });
    }
  },
);

/**
 * POST /api/callified/leads/:leadId/call
 *
 * Initiates an outbound AI call to a CRM lead/contact via Callified.
 * Body: { campaignId (required), interest? }
 * Creates a Callified lead, enrolls it in the chosen campaign, dials, and
 * persists a CRM CallLog row.
 */
router.post(
  "/leads/:leadId/call",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const { leadId } = req.params;
      const { campaignId, interest } = req.body || {};

      if (!campaignId) {
        return res.status(400).json({ error: "campaignId is required", code: "MISSING_CAMPAIGN_ID" });
      }

      const result = await callifiedClient.initiateCallForContact({
        tenantId: req.user.tenantId,
        contactId: leadId,
        campaignId,
        userId: req.user.userId,
        interest,
      });

      await writeAudit(
        "CallifiedCall",
        "INITIATE",
        String(result.callifiedLeadId),
        req.user.userId,
        req.user.tenantId,
        {
          contactId: Number(leadId),
          campaignId: Number(campaignId),
          interest: interest || null,
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
        return res.status(403).json({ error: e.message, code: "AI_CALLING_DISABLED" });
      }
      if (e.code === "CALLIFIED_NOT_CONFIGURED" || e.code === "CALLIFIED_AUTH_FAILED") {
        return res.status(503).json({ error: e.message, code: e.code });
      }
      if (e.code === "MISSING_PHONE" || e.code === "CONTACT_NOT_FOUND") {
        return res.status(e.status || 400).json({ error: e.message, code: e.code });
      }
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[callified] leads/:leadId/call error:", e.message);
      res.status(500).json({ error: "Failed to initiate call" });
    }
  },
);

/**
 * GET /api/callified/calls/:callId/details
 *
 * Fetch Callified transcripts + AI reviews for a previously created Callified
 * lead (callId). Updates the CRM CallLog and returns the full details object.
 */
router.get(
  "/calls/:callId/details",
  verifyToken,
  async (req, res) => {
    try {
      const { callId } = req.params;
      const callLog = await prisma.callLog.findFirst({
        where: {
          tenantId: req.user.tenantId,
          provider: "callified",
          providerCallId: String(callId),
        },
      });

      const details = await callifiedClient.fetchAndStoreCallDetails({
        tenantId: req.user.tenantId,
        callifiedLeadId: callId,
        contactId: callLog?.contactId || null,
        updateScore: true,
      });

      res.json(details);
    } catch (e) {
      if (e.code === "CALLIFIED_NOT_CONFIGURED" || e.code === "CALLIFIED_AUTH_FAILED") {
        return res.status(503).json({ error: e.message, code: e.code });
      }
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[callified] calls/:callId/details error:", e.message);
      res.status(500).json({ error: "Failed to fetch call details" });
    }
  },
);

/**
 * GET /api/callified/calls/lead/:leadId/attempts
 *
 * Returns every CRM CallLog attempt for a contact, newest first. Each attempt
 * includes the parsed notes (campaign, dial result, initiatedAt, fetched
 * transcripts/reviews) so the UI can render "Call #1", "Call #2", etc.
 */
router.get("/calls/lead/:leadId/attempts", verifyToken, async (req, res) => {
  try {
    const { leadId } = req.params;
    const attempts = await prisma.callLog.findMany({
      where: {
        tenantId: req.user.tenantId,
        contactId: Number(leadId),
        provider: "callified",
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        status: true,
        duration: true,
        recordingUrl: true,
        calleeNumber: true,
        notes: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });

    const parsed = attempts.map((a) => {
      let notes = {};
      if (a.notes) {
        try {
          notes = JSON.parse(a.notes);
        } catch (_) {
          // leave as raw string below
        }
      }
      return {
        ...a,
        notes: typeof notes === "object" && notes !== null ? notes : { raw: a.notes },
      };
    });

    res.json({ attempts: parsed });
  } catch (e) {
    console.error("[callified] calls/lead/:leadId/attempts error:", e.message);
    res.status(500).json({ error: "Failed to fetch call attempts" });
  }
});

/**
 * GET /api/callified/calls/lead/:leadId/latest
 *
 * Returns the most recent Callified CallLog providerCallId (Callified lead id)
 * for a CRM contact. Used by the leads list details icon to know which
 * Callified lead to poll.
 */
router.get("/calls/lead/:leadId/latest", verifyToken, async (req, res) => {
  try {
    const { leadId } = req.params;
    const log = await prisma.callLog.findFirst({
      where: {
        tenantId: req.user.tenantId,
        contactId: Number(leadId),
        provider: "callified",
      },
      orderBy: { createdAt: "desc" },
    });

    if (!log) {
      return res.json({ callifiedLeadId: null });
    }

    let callifiedLeadId = log.providerCallId;
    try {
      const parsed = JSON.parse(log.notes || "{}");
      if (parsed.callifiedLeadId) callifiedLeadId = String(parsed.callifiedLeadId);
    } catch (_) {
      // ignore malformed notes
    }

    res.json({ callifiedLeadId: callifiedLeadId || null });
  } catch (e) {
    console.error("[callified] calls/lead/:leadId/latest error:", e.message);
    res.status(500).json({ error: "Failed to fetch latest call" });
  }
});

module.exports = router;
