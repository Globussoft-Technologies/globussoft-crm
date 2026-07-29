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

/**
 * GET /api/callified/campaigns/with-lead-counts
 *
 * Returns every active Callified campaign plus the number of CRM leads
 * currently assigned to each campaign via Contact.callifiedCampaignId.
 */
router.get(
  "/campaigns/with-lead-counts",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const campaigns = await callifiedClient.listCampaigns(req.user.tenantId);
      const list = Array.isArray(campaigns) ? campaigns : [];
      const counts = await prisma.contact.groupBy({
        by: ["callifiedCampaignId"],
        where: {
          tenantId: req.user.tenantId,
          status: "Lead",
          deletedAt: null,
          callifiedCampaignId: { not: null },
        },
        _count: { callifiedCampaignId: true },
      });
      const countById = new Map(counts.map((c) => [c.callifiedCampaignId, c._count.callifiedCampaignId]));
      const enriched = list.map((c) => ({
        id: c.id,
        name: c.name,
        product_name: c.product_name || null,
        leadCount: countById.get(Number(c.id)) || 0,
      }));
      res.json({ campaigns: enriched });
    } catch (e) {
      if (e.code === "CALLIFIED_NOT_CONFIGURED" || e.code === "CALLIFIED_AUTH_FAILED") {
        return res.status(503).json({ error: e.message, code: e.code });
      }
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[callified] campaigns/with-lead-counts error:", e.message);
      res.status(500).json({ error: "Failed to fetch campaign counts" });
    }
  },
);

/**
 * POST /api/callified/campaigns/:campaignId/dial-all
 *
 * Dials every CRM lead assigned to the given Callified campaign.
 * Calls are initiated sequentially so Callified's queue receives them one
 * by one. Per-lead errors are captured and do not abort the batch.
 */
router.post(
  "/campaigns/:campaignId/dial-all",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const campaignId = Number(req.params.campaignId);
      if (!Number.isFinite(campaignId) || campaignId <= 0) {
        return res.status(400).json({ error: "Invalid campaignId", code: "INVALID_CAMPAIGN_ID" });
      }

      const leads = await prisma.contact.findMany({
        where: {
          tenantId: req.user.tenantId,
          status: "Lead",
          deletedAt: null,
          callifiedCampaignId: campaignId,
          phone: { not: null },
        },
        orderBy: { id: "asc" },
      });

      const results = [];
      let succeeded = 0;
      let failed = 0;

      for (const lead of leads) {
        try {
          const result = await callifiedClient.initiateCallForContact({
            tenantId: req.user.tenantId,
            contactId: lead.id,
            campaignId,
            userId: req.user.userId,
            interest: "Bulk campaign dial",
          });
          await writeAudit(
            "CallifiedCall",
            "INITIATE",
            String(result.callifiedLeadId),
            req.user.userId,
            req.user.tenantId,
            { contactId: lead.id, campaignId, batch: true },
          );
          results.push({ contactId: lead.id, ok: true, callifiedLeadId: result.callifiedLeadId });
          succeeded += 1;
        } catch (e) {
          const code = e.code || `CALLIFIED_API_${e.status || "ERROR"}`;
          results.push({ contactId: lead.id, ok: false, error: e.message, code });
          failed += 1;
          // Fatal config/auth/budget errors should stop the batch.
          if (
            e.code === "AI_CALLING_BUDGET_EXCEEDED" ||
            e.code === "AI_CALLING_DISABLED" ||
            e.code === "CALLIFIED_NOT_CONFIGURED" ||
            e.code === "CALLIFIED_AUTH_FAILED"
          ) {
            break;
          }
        }
      }

      res.json({ total: leads.length, succeeded, failed, results });
    } catch (e) {
      if (e.code === "AI_CALLING_BUDGET_EXCEEDED") {
        return res.status(402).json({ error: e.message, code: e.code, spentCents: e.spentCents, capCents: e.capCents });
      }
      if (e.code === "AI_CALLING_DISABLED") {
        return res.status(403).json({ error: e.message, code: e.code });
      }
      if (e.code === "CALLIFIED_NOT_CONFIGURED" || e.code === "CALLIFIED_AUTH_FAILED") {
        return res.status(503).json({ error: e.message, code: e.code });
      }
      console.error("[callified] campaigns/:campaignId/dial-all error:", e.message);
      res.status(500).json({ error: "Failed to dial campaign leads" });
    }
  },
);

/**
 * GET /api/callified/leads/call-summary
 *
 * Batch endpoint: returns Callified call count and the latest quality score
 * for a set of CRM contacts. Used by the Leads table to render the call-count
 * badge and the Callified Score column without per-row requests.
 *
 * Query: ?contactIds=1,2,3 (comma-separated, max 100)
 */
router.get("/leads/call-summary", verifyToken, async (req, res) => {
  try {
    const raw = String(req.query.contactIds || "");
    const ids = raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) {
      return res.json({ summaries: {} });
    }
    const maxIds = 100;
    const limited = ids.slice(0, maxIds);

    const logs = await prisma.callLog.findMany({
      where: {
        tenantId: req.user.tenantId,
        contactId: { in: limited },
        provider: "callified",
      },
      orderBy: { createdAt: "desc" },
      select: { contactId: true, notes: true },
    });

    // Keep only the most recent log per contact (Prisma returns them ordered
    // newest-first, so the first row per contactId wins).
    const byContact = new Map();
    for (const log of logs) {
      if (!byContact.has(log.contactId)) {
        byContact.set(log.contactId, log);
      }
    }

    const callCounts = await prisma.callLog.groupBy({
      by: ["contactId"],
      where: {
        tenantId: req.user.tenantId,
        contactId: { in: limited },
        provider: "callified",
      },
      _count: { contactId: true },
    });
    const countByContact = new Map(callCounts.map((c) => [c.contactId, c._count.contactId]));

    const summaries = {};
    for (const contactId of limited) {
      const log = byContact.get(contactId);
      let lastScore = null;
      let lastCallifiedLeadId = null;
      if (log?.notes) {
        try {
          const parsed = JSON.parse(log.notes);
          lastCallifiedLeadId = parsed.callifiedLeadId ? String(parsed.callifiedLeadId) : null;
          const reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
          const goodReview = reviews.find((r) => r && !r.error && typeof r.quality_score === "number");
          if (goodReview) {
            lastScore = Math.round(Number(goodReview.quality_score));
          }
        } catch (_) {
          // ignore malformed notes
        }
      }
      summaries[contactId] = {
        callCount: countByContact.get(contactId) || 0,
        lastCallifiedLeadId,
        lastScore,
      };
    }

    res.json({ summaries });
  } catch (e) {
    console.error("[callified] leads/call-summary error:", e.message);
    res.status(500).json({ error: "Failed to fetch call summaries" });
  }
});

module.exports = router;
