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
const { routeRequest, llmEnabled } = require("../lib/llmRouter");
const { notify } = require("../lib/notificationService");

// Sub-brand isolation guard imported from ../lib/subBrandResolve (tick #106
// rule-of-3 promotion — previously inlined here, in ratehawk.js, and in
// booking_expedia.js byte-identically). Contract: API-key-scoped callers
// (req.apiKeySubBrand set by externalAuth/voyagrAuth) get force-pinned to
// their scope and mismatching body rejected as 403 SUB_BRAND_MISMATCH;
// operator JWT callers pass body through. See lib for full JSDoc.

// Minimum time between AI calls to the same CRM contact (default 1 minute for testing).
const REDIAL_COOLDOWN_MS = Number(process.env.CALLIFIED_REDIAL_COOLDOWN_MS) || 60 * 1000;
const DIAL_ALL_DELAY_MS = Number(process.env.CALLIFIED_DIAL_ALL_DELAY_MS) || 800;

function normalizeForDial(phone) {
  return callifiedClient.normalizeCallifiedPhone(phone);
}

async function wasRecentlyDialed(tenantId, contactId, sinceMs = REDIAL_COOLDOWN_MS) {
  const since = new Date(Date.now() - sinceMs);
  const recent = await prisma.callLog.findFirst({
    where: {
      tenantId,
      contactId: Number(contactId),
      provider: 'callified',
      createdAt: { gte: since },
    },
    orderBy: { createdAt: 'desc' },
  });
  return recent ? recent.createdAt : null;
}

function pickLatestReview(parsed) {
  const transcripts = Array.isArray(parsed?.transcripts) ? parsed.transcripts : [];
  const reviews = Array.isArray(parsed?.reviews) ? parsed.reviews : [];
  const goodReviews = reviews.filter((r) => r && !r.error && typeof r.quality_score === 'number');
  if (goodReviews.length === 0) return null;
  const reviewByTx = new Map();
  for (const r of goodReviews) {
    if (!reviewByTx.has(r.transcript_id)) reviewByTx.set(r.transcript_id, r);
  }
  const sortedTranscripts = transcripts
    .filter((t) => t && t.created_at)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  for (const t of sortedTranscripts) {
    const r = reviewByTx.get(t.id);
    if (r) return r;
  }
  return goodReviews[0];
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

      const recentDial = await wasRecentlyDialed(req.user.tenantId, leadId);
      if (recentDial) {
        return res.status(429).json({
          error: `Lead was called recently at ${recentDial.toISOString()}. Redial cooldown is ${REDIAL_COOLDOWN_MS / 3600000} hours.`,
          code: "CALLIFIED_REDIAL_COOLDOWN",
          redialAfter: new Date(Date.now() + REDIAL_COOLDOWN_MS).toISOString(),
        });
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

const VALID_LEAD_STATUSES = ["hot", "cold", "yet_to_call"];

function normalizeLeadStatus(raw) {
  if (!raw) return "yet_to_call";
  const s = String(raw).toLowerCase().trim().replace(/\s+/g, "_");
  if (s.includes("hot")) return "hot";
  if (s.includes("cold")) return "cold";
  return "yet_to_call";
}

function isTruthy(value) {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const s = value.toLowerCase().trim();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

async function fetchLatestCallReviewForContact(tenantId, contactId) {
  const logs = await prisma.callLog.findMany({
    where: { tenantId, contactId: Number(contactId), provider: "callified" },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  if (!logs || logs.length === 0) return { hasCall: false, review: null, transcript: null };

  // Collect every Callified lead id referenced by this contact's call logs.
  const leadIds = [];
  for (const log of logs) {
    let id = log.providerCallId;
    try {
      const parsed = JSON.parse(log.notes || "{}");
      if (parsed.callifiedLeadId) id = String(parsed.callifiedLeadId);
    } catch (_) {
      // ignore malformed notes
    }
    if (id && !leadIds.includes(id)) leadIds.push(id);
  }

  if (leadIds.length === 0) return { hasCall: true, log: logs[0], review: null, transcript: null };

  // Fetch fresh details for each unique lead id and keep the newest transcript
  // + its matching review across all of them.
  let bestTranscript = null;
  let bestReview = null;
  let bestLog = logs[0];
  for (const callifiedLeadId of leadIds) {
    const details = await callifiedClient.getCallDetails(tenantId, callifiedLeadId).catch((e) => {
      console.error(`[callified] getCallDetails failed for lead ${callifiedLeadId}: ${e.message}`);
      return { transcripts: [], reviews: [] };
    });
    const sortedTranscripts = Array.isArray(details.transcripts)
      ? [...details.transcripts]
        .filter((t) => t && t.created_at)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      : [];
    const latestTranscript = sortedTranscripts[0] || null;
    const latestReview =
      details.reviews?.find((r) => r && !r.error && (latestTranscript ? r.transcript_id === latestTranscript.id : true)) ||
      details.reviews?.find((r) => r && !r.error) ||
      null;

    if (latestTranscript && (!bestTranscript || new Date(latestTranscript.created_at).getTime() > new Date(bestTranscript.created_at).getTime())) {
      bestTranscript = latestTranscript;
      bestReview = latestReview;
      bestLog = logs.find((l) => {
        let id = l.providerCallId;
        try {
          const parsed = JSON.parse(l.notes || "{}");
          if (parsed.callifiedLeadId) id = String(parsed.callifiedLeadId);
        } catch (_) { /* ignore */ }
        return id === callifiedLeadId;
      }) || logs[0];
    }
  }

  return { hasCall: true, log: bestLog, review: bestReview, transcript: bestTranscript };
}

async function updateCallLogNotesWithReview(tenantId, contactId, review) {
  if (!review || !contactId) return;
  try {
    const log = await prisma.callLog.findFirst({
      where: { tenantId, contactId: Number(contactId), provider: "callified" },
      orderBy: { createdAt: "desc" },
    });
    if (!log || !log.notes) return;
    let notes = {};
    try {
      notes = JSON.parse(log.notes);
    } catch (_) {
      notes = { raw: log.notes };
    }
    if (typeof notes !== "object" || notes === null) notes = {};
    notes.reviews = [{
      transcript_id: review.transcript_id || review.transcriptId,
      sentiment: review.sentiment,
      quality_score: review.quality_score,
      summary: review.summary,
      appointment_booked: review.appointment_booked,
      what_went_well: review.what_went_well,
      what_went_wrong: review.what_went_wrong,
      coaching_insight: review.coaching_insight,
    }];
    notes.fetchedAt = new Date().toISOString();
    await prisma.callLog.update({
      where: { id: log.id },
      data: { notes: JSON.stringify(notes) },
    });
  } catch (e) {
    console.error(`[callified] updateCallLogNotesWithReview failed for contact ${contactId}: ${e.message}`);
  }
}

function fallbackClassify(review) {
  if (!review) return { status: "yet_to_call", reason: "No Callified review data available yet." };
  const score = Number(review.quality_score) || 0;
  const appointment = isTruthy(review.appointment_booked);
  if (appointment) {
    return { status: "hot", reason: `Appointment booked (score ${score}/5).` };
  }
  if (score >= 4) {
    return { status: "hot", reason: `High Callified score ${score}/5.` };
  }
  if (score <= 2) {
    return { status: "cold", reason: `Low Callified score ${score}/5.` };
  }
  return { status: "cold", reason: `Neutral Callified score ${score}/5.` };
}

async function classifyLeadStatus(tenantId, contactId) {
  const { hasCall, review, transcript } = await fetchLatestCallReviewForContact(tenantId, contactId);
  if (!hasCall) {
    return {
      status: "yet_to_call",
      source: "score",
      reason: "No Callified call has been made for this lead yet.",
    };
  }

  // Persist the fresh review back to the cached CallLog notes so the
  // call-summary endpoint (which reads cached notes) serves the latest score
  // without requiring a details-drawer open.
  await updateCallLogNotesWithReview(tenantId, contactId, review);

  // Fallback classification is always computed from the Callified review/score.
  // It acts as the source of truth when Gemini is unavailable, and as a guard
  // rail when Gemini returns a result that contradicts hard signals.
  const fallback = fallbackClassify(review);

  // If no Gemini key is configured, use the score/appointment fallback directly.
  const geminiReady = await llmEnabled("callified-lead-status", tenantId).catch((e) => {
    console.error(`[callified] llmEnabled check failed for tenant ${tenantId}: ${e.message}`);
    return false;
  });
  if (!geminiReady) {
    console.log(`[callified] No Gemini key available for tenant ${tenantId}; using score/appointment fallback for contact ${contactId}.`);
    return { status: fallback.status, source: "score", reason: fallback.reason };
  }

  const transcriptText = transcript?.transcript_text || transcript?.transcript || transcript?.text || "";
  const reviewPayload = review
    ? {
      sentiment: review.sentiment,
      quality_score: review.quality_score,
      appointment_booked: isTruthy(review.appointment_booked),
      summary: review.summary,
    }
    : null;

  const payload = {
    transcript: transcriptText,
    review: reviewPayload,
    hasTranscript: !!transcriptText,
    hasReview: !!reviewPayload,
  };

  try {
    const result = await routeRequest({ task: "callified-lead-status", payload, tenantId });
    let parsed;
    try {
      parsed = JSON.parse(result.text || "{}");
    } catch (_) {
      console.error(`[callified] Gemini returned non-JSON for contact ${contactId}: ${result.text}. Falling back to score.`);
      return { status: fallback.status, source: "score", reason: fallback.reason };
    }
    let status = normalizeLeadStatus(parsed.status);
    let source = "gemini";
    let reason = parsed.reason || "Classified by Gemini";

    // Guard rail: if Gemini contradicts hard Callified signals, trust the data.
    const score = Number(review?.quality_score) || 0;
    const appointmentBooked = isTruthy(review?.appointment_booked);
    if (appointmentBooked || score >= 4) {
      if (status !== "hot") {
        console.log(`[callified] Gemini returned ${status} but review signals hot (appointment=${appointmentBooked}, score=${score}); overriding to hot.`);
        status = "hot";
        source = "score";
        reason = fallback.reason;
      }
    } else if (score <= 2 && status === "hot") {
      console.log(`[callified] Gemini returned hot but review score is low (${score}); overriding to cold.`);
      status = "cold";
      source = "score";
      reason = fallback.reason;
    }

    console.log(`[callified] classified contact ${contactId} as ${status} (source=${source})`);
    return { status, source, reason };
  } catch (e) {
    console.error(`[callified] Gemini classification failed for contact ${contactId}: ${e.message}`);
    return { status: fallback.status, source: "score", reason: fallback.reason };
  }
}

async function assignHotLeadRoundRobin(tenantId, contactId, status, options = {}) {
  if (status !== "hot") {
    console.log(`[callified] assignHotLeadRoundRobin skipped for contact ${contactId}: status is ${status}`);
    return null;
  }
  const { force = false } = options;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const contact = await tx.contact.findFirst({
        where: { id: Number(contactId), tenantId },
        select: { id: true, assignedToId: true },
      });
      if (!contact) {
        console.log(`[callified] assignHotLeadRoundRobin skipped for contact ${contactId}: contact not found`);
        return { assignedToId: null, reason: "contact_not_found" };
      }

      const staff = await tx.user.findMany({
        where: {
          tenantId,
          deactivatedAt: null,
          role: { in: ["ADMIN", "MANAGER", "USER"] },
        },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      if (staff.length === 0) {
        console.log(`[callified] assignHotLeadRoundRobin skipped for contact ${contactId}: no active staff in tenant ${tenantId}`);
        return { assignedToId: null, reason: "no_active_staff" };
      }

      let shouldReassign = force;
      if (!force && contact.assignedToId) {
        const currentActive = staff.some((s) => Number(s.id) === Number(contact.assignedToId));
        if (!currentActive) {
          console.log(`[callified] assignHotLeadRoundRobin reassigning contact ${contactId}: current owner ${contact.assignedToId} is inactive/not in staff pool`);
          shouldReassign = true;
        }
      }

      if (!shouldReassign && contact.assignedToId) {
        console.log(`[callified] assignHotLeadRoundRobin skipped for contact ${contactId}: already assigned to active user ${contact.assignedToId}`);
        return { assignedToId: null, reason: "already_assigned_active" };
      }

      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { callifiedLastHotAssignedUserId: true },
      });

      const lastId = tenant?.callifiedLastHotAssignedUserId || null;
      let startIndex = 0;
      if (lastId) {
        const idx = staff.findIndex((s) => Number(s.id) === Number(lastId));
        if (idx >= 0) startIndex = (idx + 1) % staff.length;
      }

      let nextUser = null;
      for (let i = 0; i < staff.length; i += 1) {
        const candidate = staff[(startIndex + i) % staff.length];
        if (Number(candidate.id) !== Number(lastId)) {
          nextUser = candidate;
          break;
        }
      }
      if (!nextUser) nextUser = staff[0];

      await tx.contact.update({
        where: { id: Number(contactId) },
        data: { assignedToId: nextUser.id },
      });
      await tx.tenant.update({
        where: { id: tenantId },
        data: { callifiedLastHotAssignedUserId: nextUser.id },
      });

      return { assignedToId: nextUser.id, reason: "assigned" };
    });

    const assignedToId = result.assignedToId;
    if (!assignedToId) return null;

    try {
      await notify({
        userId: assignedToId,
        tenantId,
        title: "Hot lead assigned",
        message: "A hot lead has been auto-assigned to you from Callified AI calls.",
        type: "info",
        category: "lead",
        entityType: "lead",
        entityId: Number(contactId),
        link: `/contacts/${contactId}`,
      });
    } catch (e) {
      console.error("[callified] hot lead assignment notify failed:", e.message);
    }

    console.log(`[callified] assignHotLeadRoundRobin assigned contact ${contactId} to user ${assignedToId}`);
    return assignedToId;
  } catch (e) {
    console.error(`[callified] assignHotLeadRoundRobin failed for contact ${contactId}:`, e.message);
    return null;
  }
}

/**
 * POST /api/callified/leads/:leadId/classify
 *
 * Classifies a CRM lead as hot/cold/yet_to_call based on the latest Callified
 * call transcript. Uses Gemini 2.5 Flash Lite when available; falls back to the
 * Callified review score + appointment_booked flag. Hot leads with no current
 * assignee are automatically assigned to the next staff user in round-robin.
 */
router.post("/leads/:leadId/classify", verifyToken, async (req, res) => {
  try {
    const leadId = Number(req.params.leadId);
    if (!Number.isFinite(leadId) || leadId <= 0) {
      return res.status(400).json({ error: "Invalid leadId", code: "INVALID_LEAD_ID" });
    }

    const contact = await prisma.contact.findFirst({
      where: { id: leadId, tenantId: req.user.tenantId },
    });
    if (!contact) return res.status(404).json({ error: "Lead not found" });

    const classification = await classifyLeadStatus(req.user.tenantId, leadId);
    const updateData = {
      callifiedLeadStatus: classification.status,
      callifiedLeadStatusSource: classification.source,
      callifiedLeadStatusReason: classification.reason,
      callifiedLeadStatusUpdatedAt: new Date(),
    };

    if (classification.status === "hot" && !contact.assignedToId) {
      const assignedToId = await assignHotLeadRoundRobin(req.user.tenantId, leadId, classification.status);
      if (assignedToId) updateData.assignedToId = assignedToId;
    }

    const updated = await prisma.contact.update({
      where: { id: leadId },
      data: updateData,
      include: { assignedTo: { select: { id: true, name: true, email: true } } },
    });

    res.json({
      id: updated.id,
      callifiedLeadStatus: updated.callifiedLeadStatus,
      callifiedLeadStatusSource: updated.callifiedLeadStatusSource,
      callifiedLeadStatusUpdatedAt: updated.callifiedLeadStatusUpdatedAt,
      assignedToId: updated.assignedToId,
      assignedTo: updated.assignedTo,
      reason: classification.reason,
    });
  } catch (e) {
    console.error("[callified] leads/:leadId/classify error:", e.message);
    res.status(500).json({ error: "Failed to classify lead" });
  }
});

/**
 * PUT /api/callified/leads/:leadId/lead-status
 *
 * Manual override of the Callified lead status. Also triggers round-robin
 * assignment when the status is set to hot and the lead is currently unassigned.
 */
router.put("/leads/:leadId/lead-status", verifyToken, async (req, res) => {
  try {
    const leadId = Number(req.params.leadId);
    const { status } = req.body || {};
    const normalized = normalizeLeadStatus(status);
    if (!VALID_LEAD_STATUSES.includes(normalized)) {
      return res.status(400).json({ error: "Invalid status", code: "INVALID_STATUS" });
    }

    const contact = await prisma.contact.findFirst({
      where: { id: leadId, tenantId: req.user.tenantId },
    });
    if (!contact) return res.status(404).json({ error: "Lead not found" });

    const updateData = {
      callifiedLeadStatus: normalized,
      callifiedLeadStatusSource: "manual",
      callifiedLeadStatusReason: "Status changed manually by user.",
      callifiedLeadStatusUpdatedAt: new Date(),
    };
    if (normalized === "hot" && !contact.assignedToId) {
      const assignedToId = await assignHotLeadRoundRobin(req.user.tenantId, leadId, normalized);
      if (assignedToId) updateData.assignedToId = assignedToId;
    }

    const updated = await prisma.contact.update({
      where: { id: leadId },
      data: updateData,
      include: { assignedTo: { select: { id: true, name: true, email: true } } },
    });

    res.json({
      id: updated.id,
      callifiedLeadStatus: updated.callifiedLeadStatus,
      callifiedLeadStatusSource: updated.callifiedLeadStatusSource,
      callifiedLeadStatusUpdatedAt: updated.callifiedLeadStatusUpdatedAt,
      assignedToId: updated.assignedToId,
      assignedTo: updated.assignedTo,
    });
  } catch (e) {
    console.error("[callified] leads/:leadId/lead-status error:", e.message);
    res.status(500).json({ error: "Failed to update lead status" });
  }
});

/**
 * POST /api/callified/leads/ensure-assigned
 *
 * Backfills assignment for hot leads that are currently unassigned. This is
 * useful when:
 *   - existing hot leads were created before the auto-assignment feature
 *   - transient assignment failures left hot leads without an owner
 *   - an admin wants to reconcile the leads list without manually picking
 *     each assignee
 *
 * Body: { contactIds?: number[] } — if omitted, every hot unassigned lead in
 * the tenant is processed.
 *
 * Returns { assigned: number, skipped: number, details: [{ contactId, assignedToId, reason }] }.
 */
router.post("/leads/ensure-assigned", verifyToken, async (req, res) => {
  try {
    const { contactIds } = req.body || {};
    const tenantId = req.user.tenantId;

    const where = {
      tenantId,
      status: "Lead",
      deletedAt: null,
      callifiedLeadStatus: "hot",
      assignedToId: null,
    };
    if (Array.isArray(contactIds) && contactIds.length > 0) {
      where.id = { in: contactIds.map((id) => Number(id)).filter(Number.isFinite) };
    }

    const hotLeads = await prisma.contact.findMany({
      where,
      select: { id: true },
      orderBy: { id: "asc" },
    });

    const details = [];
    let assigned = 0;
    let skipped = 0;
    for (const lead of hotLeads) {
      const assignedToId = await assignHotLeadRoundRobin(tenantId, lead.id, "hot");
      if (assignedToId) {
        assigned += 1;
        details.push({ contactId: lead.id, assignedToId, reason: "assigned" });
      } else {
        skipped += 1;
        details.push({ contactId: lead.id, assignedToId: null, reason: "not_assignable" });
      }
    }

    res.json({ assigned, skipped, details });
  } catch (e) {
    console.error("[callified] leads/ensure-assigned error:", e.message);
    res.status(500).json({ error: "Failed to ensure hot leads are assigned" });
  }
});

/**
 * GET /api/callified/leads/call-status-history
 *
 * Returns the full Callified call status history for the tenant. Used by the
 * "Call Status" button in the generic CRM leads page. Reads from existing
 * CallLog rows so history survives refresh and cookie clearing.
 */
router.get("/leads/call-status-history", verifyToken, async (req, res) => {
  try {
    const logs = await prisma.callLog.findMany({
      where: {
        tenantId: req.user.tenantId,
        provider: "callified",
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        status: true,
        duration: true,
        calleeNumber: true,
        contactId: true,
        notes: true,
        user: { select: { id: true, name: true, email: true } },
        contact: { select: { id: true, name: true, email: true, phone: true } },
      },
    });

    const history = logs.map((log) => {
      let notes = {};
      try {
        notes = JSON.parse(log.notes || "{}");
      } catch (_) {
        notes = { raw: log.notes };
      }
      return {
        ...log,
        notes,
        displayStatus: log.status === "INITIATED" || log.status === "RINGING"
          ? "Calling…"
          : log.status === "COMPLETED"
            ? "Call completed"
            : log.status === "MISSED" || log.status === "FAILED"
              ? "Lead hung up / did not answer"
              : log.status,
      };
    });

    res.json({ history });
  } catch (e) {
    console.error("[callified] leads/call-status-history error:", e.message);
    res.status(500).json({ error: "Failed to fetch call status history" });
  }
});

/**
 * DELETE /api/callified/leads/call-status-history
 *
 * Clears the Callified call status history for the tenant. Used by the
 * "Clear history" option in the Call Status button drawer.
 */
router.delete("/leads/call-status-history", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const { count } = await prisma.callLog.deleteMany({
      where: {
        tenantId: req.user.tenantId,
        provider: "callified",
      },
    });
    res.json({ deleted: count });
  } catch (e) {
    console.error("[callified] delete call-status-history error:", e.message);
    res.status(500).json({ error: "Failed to clear call status history" });
  }
});

/**
 * POST /api/callified/leads/:leadId/ensure-hot-assigned
 *
 * Idempotent safety net: if a lead is Hot and is not currently assigned to an
 * active staff user, round-robin assign it. Used by the frontend on page load
 * for existing Hot leads and after manual status override.
 */
router.post("/leads/:leadId/ensure-hot-assigned", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const leadId = Number(req.params.leadId);
    if (!Number.isFinite(leadId) || leadId <= 0) {
      return res.status(400).json({ error: "Invalid leadId", code: "INVALID_LEAD_ID" });
    }

    const contact = await prisma.contact.findFirst({
      where: { id: leadId, tenantId: req.user.tenantId },
    });
    if (!contact) return res.status(404).json({ error: "Lead not found" });
    if (contact.callifiedLeadStatus !== "hot") {
      return res.status(400).json({ error: "Lead is not Hot", code: "NOT_HOT" });
    }

    console.log(`[callified] ensure-hot-assigned: contact ${leadId} status=${contact.callifiedLeadStatus}, current assignedToId=${contact.assignedToId}`);
    const assignedToId = await assignHotLeadRoundRobin(req.user.tenantId, leadId, "hot");
    const updated = await prisma.contact.findUnique({
      where: { id: leadId },
      include: { assignedTo: { select: { id: true, name: true, email: true } } },
    });

    console.log(`[callified] ensure-hot-assigned: contact ${leadId} result assigned=${!!assignedToId}, assignedToId=${updated.assignedToId}`);
    res.json({
      id: updated.id,
      assignedToId: updated.assignedToId,
      assignedTo: updated.assignedTo,
      assigned: !!assignedToId,
    });
  } catch (e) {
    console.error("[callified] leads/:leadId/ensure-hot-assigned error:", e.message);
    res.status(500).json({ error: "Failed to ensure hot lead assignment" });
  }
});

/**
 * POST /api/callified/leads/sync-call-statuses
 *
 * Polls Callified for every CRM CallLog still in INITIATED/RINGING/CONNECTED
 * state, fetches the latest transcript/review, and updates the CallLog status.
 * Used by the Call Status drawer to keep statuses fluid and real-time without
 * requiring the user to open each lead's details panel.
 */
router.post("/leads/sync-call-statuses", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const { updated, errors, pending } = await callifiedClient.syncPendingCallifiedStatuses(req.user.tenantId);
    res.json({ updated, errors, pending });
  } catch (e) {
    console.error("[callified] leads/sync-call-statuses error:", e.message);
    res.status(500).json({ error: "Failed to sync call statuses" });
  }
});

/**
 * GET /api/callified/auto-campaign
 *
 * Returns the tenant's default Callified campaign id (or null) so the generic
 * CRM leads page can pre-select the auto-assign dropdown.
 */
router.get("/auto-campaign", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { callifiedAutoCampaignId: true },
    });
    res.json({ callifiedAutoCampaignId: tenant?.callifiedAutoCampaignId || null });
  } catch (e) {
    console.error("[callified] auto-campaign GET error:", e.message);
    res.status(500).json({ error: "Failed to read auto-campaign" });
  }
});

/**
 * PUT /api/callified/auto-campaign
 *
 * Sets or clears the tenant's default Callified campaign id. New Leads will be
 * auto-assigned to this campaign by POST /api/contacts when no explicit
 * campaign is supplied.
 */
router.put("/auto-campaign", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const { callifiedAutoCampaignId } = req.body || {};
    const value = callifiedAutoCampaignId == null || callifiedAutoCampaignId === "" ? null : Number(callifiedAutoCampaignId);
    if (value != null && (!Number.isFinite(value) || value <= 0)) {
      return res.status(400).json({ error: "Invalid campaign id", code: "INVALID_CAMPAIGN_ID" });
    }
    await prisma.tenant.update({
      where: { id: req.user.tenantId },
      data: { callifiedAutoCampaignId: value },
    });
    res.json({ callifiedAutoCampaignId: value });
  } catch (e) {
    console.error("[callified] auto-campaign PUT error:", e.message);
    res.status(500).json({ error: "Failed to set auto-campaign" });
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
      let skippedCooldown = 0;
      let invalidPhone = 0;
      let lastDialAttempted = false;

      for (let i = 0; i < leads.length; i += 1) {
        const lead = leads[i];
        const normalizedPhone = normalizeForDial(lead.phone);
        if (!normalizedPhone) {
          invalidPhone += 1;
          results.push({ contactId: lead.id, ok: false, code: "INVALID_PHONE", skipped: true });
          continue;
        }

        const recentDial = await wasRecentlyDialed(req.user.tenantId, lead.id);
        if (recentDial) {
          skippedCooldown += 1;
          results.push({
            contactId: lead.id,
            ok: false,
            code: "CALLIFIED_REDIAL_COOLDOWN",
            skipped: true,
            recentDial: recentDial.toISOString(),
          });
          continue;
        }

        // Small delay between actual dial attempts so Callified/Exotel is not flooded.
        if (lastDialAttempted) {
          await new Promise((r) => setTimeout(r, DIAL_ALL_DELAY_MS));
        }
        lastDialAttempted = true;

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

      res.json({
        total: leads.length,
        succeeded,
        failed,
        skipped: skippedCooldown + invalidPhone,
        skippedCooldown,
        invalidPhone,
        results,
      });
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
          const latestReview = pickLatestReview(parsed);
          if (latestReview) {
            lastScore = Math.round(Number(latestReview.quality_score));
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
