/**
 * Wellness ↔ Callified calling routes.
 *
 * Mounted at /api/wellness (paths below are all namespaced under /callified/,
 * which routes/wellness.js does not own).
 *
 * WHAT THIS IS
 *   The wellness Appointments page needs the same outbound-calling capability
 *   the generic CRM Leads page has: pick a Callified campaign, then either let
 *   the AI agent make the call or bridge a real staff member's browser to the
 *   customer.
 *
 * WHAT IT IS NOT
 *   A second Callified integration. Every Callified interaction below goes
 *   through services/callifiedClient.js and lib/callifiedAgentBridge.js — the
 *   exact modules the generic CRM uses. The only thing this file adds is the
 *   wellness-shaped entry point: a Visit id instead of a Contact id, and a
 *   wellness RBAC gate instead of the generic ADMIN/MANAGER one.
 *
 * APPOINTMENT → CALLIFIED LEAD MAPPING
 *   Visit → Patient → Contact → Callified lead.
 *
 *   `Patient.contactId` links a wellness patient to the CRM Contact that the
 *   whole Callified stack is keyed on (CallLog.contactId, the phone →
 *   Callified-lead mapping in Integration.settings, the call-status and
 *   transcript surfaces). lib/patientContactLink.js creates that link on
 *   demand; callifiedClient.createLead then reuses or recovers the Callified
 *   lead for the phone number, so repeated calls to the same patient never
 *   create duplicate leads on either side.
 */

const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { verifyToken, RBAC_DENIED_MESSAGE } = require("../middleware/auth");
const { verifyWellnessRole } = require("../middleware/wellnessRole");
const callifiedClient = require("../services/callifiedClient");
const { ensurePatientContact } = require("../lib/patientContactLink");
const { startBrowserCall } = require("../lib/callifiedAgentBridge");
const { sendCallifiedError } = require("../lib/callifiedErrors");
const {
  wasRecentlyDialed,
  redialCooldownError,
} = require("../lib/callifiedRedialGuard");
const { writeAudit } = require("../lib/audit");

// Calling a patient is front-desk work: admins/managers plus the roles that
// actually work the phones. Doctors are deliberately not on the list — they
// consult, they don't run outbound call lists — but any custom role granted
// `appointments.write` (e.g. a tenant-defined "Front Desk" role) passes
// through the permission escape hatch with no code change.
const callGate = [
  verifyToken,
  verifyWellnessRole(["admin", "manager", "telecaller", "receptionist"], {
    anyOfPermissions: [
      { module: "appointments", action: "write" },
      { module: "calendar", action: "write" },
    ],
  }),
];

/**
 * Load a visit within the caller's tenant, with the patient details the
 * calling flow needs. Returns null when the visit does not exist or belongs
 * to another tenant.
 */
async function loadVisitForCall(visitId, tenantId) {
  const id = Number(visitId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return await prisma.visit.findFirst({
    where: { id, tenantId },
    select: {
      id: true,
      visitDate: true,
      status: true,
      patientId: true,
      patient: {
        select: { id: true, name: true, email: true, phone: true, contactId: true },
      },
      service: { select: { id: true, name: true } },
    },
  });
}

/**
 * Resolve the appointment into a callable CRM contact.
 *
 * `ensureContact: false` keeps the lookup read-only (used by the context
 * endpoint so opening the call dialog does not write to the database);
 * `true` creates + back-links the Contact right before a call is placed.
 */
async function resolveCallTarget(visit, tenantId, { ensureContact = false } = {}) {
  const patient = visit.patient;
  if (!patient) {
    const err = new Error("This appointment has no patient on file.");
    err.status = 400;
    err.code = "PATIENT_NOT_FOUND";
    throw err;
  }

  const normalizedPhone = callifiedClient.normalizeCallifiedPhone(patient.phone || "");
  // Callified needs at least a full national number to dial. Anything shorter
  // is a placeholder / partial entry, not a reachable customer.
  const phoneValid = normalizedPhone.replace(/\D/g, "").length >= 10;

  if (!ensureContact) {
    return { patient, normalizedPhone, phoneValid, contact: null };
  }

  if (!phoneValid) {
    const err = new Error("This patient has no valid phone number to call.");
    err.status = 400;
    err.code = "INVALID_PHONE";
    throw err;
  }

  const contact = await ensurePatientContact(patient, tenantId);
  return { patient, normalizedPhone, phoneValid, contact };
}

/**
 * GET /api/wellness/callified/status
 *
 * Whether this tenant can place Callified calls at all, so the Appointments
 * page can hide the call action instead of showing a button that always
 * fails. Never throws — an unconfigured tenant is a normal state, not an
 * error.
 */
router.get("/callified/status", callGate, async (req, res) => {
  try {
    const [config, enabled] = await Promise.all([
      callifiedClient.getCallifiedConfig(req.user.tenantId),
      callifiedClient.isEnabledForTenant(req.user.tenantId).catch(() => false),
    ]);
    res.json({
      configured: Boolean(config && config.isActive),
      enabled: Boolean(enabled),
    });
  } catch (e) {
    console.error("[wellness-callified] status error:", e.message);
    res.json({ configured: false, enabled: false });
  }
});

/**
 * GET /api/wellness/callified/campaigns
 *
 * The campaign list the call dialog picks from. Same Callified campaigns the
 * generic CRM sees — this is one org-level campaign set, not a wellness copy.
 */
router.get("/callified/campaigns", callGate, async (req, res) => {
  try {
    const campaigns = await callifiedClient.listCampaigns(req.user.tenantId);
    res.json({ campaigns: Array.isArray(campaigns) ? campaigns : [] });
  } catch (e) {
    sendCallifiedError(
      res,
      e,
      "[wellness-callified] campaigns",
      "Failed to fetch Callified campaigns",
    );
  }
});

/**
 * GET /api/wellness/callified/visits/:visitId/context
 *
 * Everything the call dialog needs before the user picks a mode: who is being
 * called, whether the number is dialable, whether an existing CRM contact (and
 * therefore call history) is already linked, and whether a call to this
 * customer is still inside the redial cooldown.
 */
router.get("/callified/visits/:visitId/context", callGate, async (req, res) => {
  try {
    const visit = await loadVisitForCall(req.params.visitId, req.user.tenantId);
    if (!visit) {
      return res
        .status(404)
        .json({ error: "Appointment not found", code: "VISIT_NOT_FOUND" });
    }

    const { patient, normalizedPhone, phoneValid } = await resolveCallTarget(
      visit,
      req.user.tenantId,
    );

    let recentCallAt = null;
    if (patient.contactId) {
      const recent = await wasRecentlyDialed(req.user.tenantId, patient.contactId);
      recentCallAt = recent ? recent.toISOString() : null;
    }

    res.json({
      visitId: visit.id,
      visitDate: visit.visitDate,
      serviceName: visit.service?.name || null,
      patientId: patient.id,
      patientName: patient.name,
      // The contact may not exist yet — it is created lazily when the first
      // call is placed. Null here simply means "no call history".
      contactId: patient.contactId || null,
      phone: patient.phone || null,
      normalizedPhone: phoneValid ? normalizedPhone : null,
      phoneValid,
      recentCallAt,
    });
  } catch (e) {
    sendCallifiedError(
      res,
      e,
      "[wellness-callified] visit context",
      "Failed to load call details for this appointment",
    );
  }
});

/**
 * POST /api/wellness/callified/visits/:visitId/ai-call
 *
 * Option 1 — let Callified's AI agent handle the conversation.
 * Body: { campaignId (required), interest? }
 *
 * Delegates to the same callifiedClient.initiateCallForContact the generic
 * CRM Leads page uses: reuse-or-create the Callified lead, enroll it in the
 * campaign, dial, and write the CRM CallLog row.
 */
router.post("/callified/visits/:visitId/ai-call", callGate, async (req, res) => {
  try {
    const { campaignId, interest } = req.body || {};
    if (!campaignId) {
      return res
        .status(400)
        .json({ error: "campaignId is required", code: "MISSING_CAMPAIGN_ID" });
    }

    const visit = await loadVisitForCall(req.params.visitId, req.user.tenantId);
    if (!visit) {
      return res
        .status(404)
        .json({ error: "Appointment not found", code: "VISIT_NOT_FOUND" });
    }

    const { contact, patient } = await resolveCallTarget(visit, req.user.tenantId, {
      ensureContact: true,
    });

    const recentDial = await wasRecentlyDialed(req.user.tenantId, contact.id);
    if (recentDial) {
      return res.status(429).json(redialCooldownError(recentDial));
    }

    const result = await callifiedClient.initiateCallForContact({
      tenantId: req.user.tenantId,
      contactId: contact.id,
      campaignId,
      userId: req.user.userId,
      interest:
        interest ||
        (visit.service?.name
          ? `Appointment — ${visit.service.name}`
          : "Wellness appointment call"),
    });

    await writeAudit(
      "CallifiedCall",
      "INITIATE",
      String(result.callifiedLeadId),
      req.user.userId,
      req.user.tenantId,
      {
        surface: "wellness_appointments",
        mode: "ai",
        visitId: visit.id,
        patientId: patient.id,
        contactId: contact.id,
        campaignId: Number(campaignId),
      },
    );

    res.json({ ...result, mode: "ai", visitId: visit.id, patientId: patient.id });
  } catch (e) {
    sendCallifiedError(
      res,
      e,
      "[wellness-callified] ai-call",
      "Failed to start the AI call",
    );
  }
});

/**
 * POST /api/wellness/callified/visits/:visitId/manual-call
 *
 * Option 2 — a human staff member speaks to the customer from the browser.
 * Body: { campaignId (required), interest?, exotelAccountId?, scheduledCallId? }
 *
 * Callified places the customer leg and bridges its audio to a WebSocket. The
 * response carries a single-use `bridgeTicket` the browser redeems against the
 * CRM relay at `bridgePath` — the raw Callified socket needs the tenant's API
 * credential, which never leaves the server.
 */
router.post("/callified/visits/:visitId/manual-call", callGate, async (req, res) => {
  try {
    const { campaignId, interest, exotelAccountId, scheduledCallId } = req.body || {};
    if (!campaignId) {
      return res
        .status(400)
        .json({ error: "campaignId is required", code: "MISSING_CAMPAIGN_ID" });
    }

    const visit = await loadVisitForCall(req.params.visitId, req.user.tenantId);
    if (!visit) {
      return res
        .status(404)
        .json({ error: "Appointment not found", code: "VISIT_NOT_FOUND" });
    }

    const { contact, patient } = await resolveCallTarget(visit, req.user.tenantId, {
      ensureContact: true,
    });

    const recentDial = await wasRecentlyDialed(req.user.tenantId, contact.id);
    if (recentDial) {
      return res.status(429).json(redialCooldownError(recentDial));
    }

    const result = await startBrowserCall({
      tenantId: req.user.tenantId,
      contactId: contact.id,
      campaignId,
      userId: req.user.userId,
      interest:
        interest ||
        (visit.service?.name
          ? `Appointment — ${visit.service.name}`
          : "Wellness appointment call"),
      exotelAccountId,
      scheduledCallId,
    });

    await writeAudit(
      "CallifiedCall",
      "BROWSER_CALL",
      String(result.callifiedLeadId),
      req.user.userId,
      req.user.tenantId,
      {
        surface: "wellness_appointments",
        mode: "browser",
        visitId: visit.id,
        patientId: patient.id,
        contactId: contact.id,
        campaignId: Number(campaignId),
        callSid: result.callSid,
      },
    );

    res.json({ ...result, visitId: visit.id, patientId: patient.id });
  } catch (e) {
    sendCallifiedError(
      res,
      e,
      "[wellness-callified] manual-call",
      "Failed to start the manual call",
    );
  }
});

// Touch the shared denial copy so a future direct-403 path in this file uses
// the same neutral string the rest of the RBAC surface emits.
void RBAC_DENIED_MESSAGE;

module.exports = router;
