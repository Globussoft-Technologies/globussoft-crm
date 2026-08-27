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
 * Load a patient within the caller's tenant.
 *
 * The Patients page calls someone with no appointment in the picture, so the
 * patient IS the subject. Filters `deletedAt: null` to match every other
 * patient read — a soft-deleted record must not be dialable.
 */
async function loadPatientForCall(patientId, tenantId) {
  const id = Number(patientId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return await prisma.patient.findFirst({
    where: { id, tenantId, deletedAt: null },
    select: { id: true, name: true, email: true, phone: true, contactId: true },
  });
}

/**
 * Load a lead within the caller's tenant.
 *
 * A "lead" in this CRM is a Contact — both All Leads and Converted Leads are
 * views over Contact, filtered by status — so there is no separate model to
 * load. Filters `deletedAt: null` to match every other contact read.
 */
async function loadLeadForCall(leadId, tenantId) {
  const id = Number(leadId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return await prisma.contact.findFirst({
    where: { id, tenantId, deletedAt: null },
    select: { id: true, name: true, email: true, phone: true },
  });
}

/**
 * A "call subject" is whatever surface the call is placed FROM.
 *
 * Everything downstream — contact resolution, redial cooldown, the dial
 * itself, the CallLog row, the audit entry — is identical whether the
 * operator clicked Call on an appointment row or on a patient row. The two
 * surfaces differ ONLY in how the subject is loaded and how the call is
 * labelled, so they are described here and share one set of handlers below.
 */
function visitSubject(visit) {
  return {
    person: visit.patient,
    surface: "wellness_appointments",
    defaultInterest: visit.service?.name
      ? `Appointment — ${visit.service.name}`
      : "Wellness appointment call",
    // Merged into the audit payload and the JSON response so an appointment
    // call stays traceable back to the appointment it came from.
    ref: { visitId: visit.id, patientId: visit.patient?.id },
    context: {
      visitId: visit.id,
      visitDate: visit.visitDate,
      serviceName: visit.service?.name || null,
    },
  };
}

function patientSubject(patient) {
  return {
    person: patient,
    surface: "wellness_patients",
    // No appointment to name, so the interest says what it actually is.
    defaultInterest: "Wellness patient call",
    ref: { patientId: patient.id },
    context: {},
  };
}

/**
 * Leads / Converted Leads — the subject is a CRM contact.
 *
 * Every other surface has to promote its record into a Contact before it can
 * be dialled. A lead already IS one, so `resolveContact` short-circuits: no
 * lookup, no write, no chance of creating a duplicate contact for a record
 * that was a contact all along.
 */
function leadSubject(contact) {
  return {
    person: contact,
    surface: "wellness_leads",
    defaultInterest: "Wellness lead call",
    ref: { leadId: contact.id },
    context: { leadId: contact.id },
    resolveContact: async (person) => ({ id: person.id }),
  };
}

/**
 * Resolve the appointment into a callable CRM contact.
 *
 * `ensureContact: false` keeps the lookup read-only (used by the context
 * endpoint so opening the call dialog does not write to the database);
 * `true` creates + back-links the Contact right before a call is placed.
 */
async function resolveCallTarget(subject, tenantId, { ensureContact = false } = {}) {
  // The person being called. A patient on the appointment / patient surfaces,
  // a contact on the leads surface — from here down the flow does not care.
  const person = subject.person;
  if (!person) {
    const err = new Error("This appointment has no patient on file.");
    err.status = 400;
    err.code = "PATIENT_NOT_FOUND";
    throw err;
  }

  const normalizedPhone = callifiedClient.normalizeCallifiedPhone(person.phone || "");
  // Callified needs at least a full national number to dial. Anything shorter
  // is a placeholder / partial entry, not a reachable customer.
  const phoneValid = normalizedPhone.replace(/\D/g, "").length >= 10;

  if (!ensureContact) {
    return { person, normalizedPhone, phoneValid, contact: null };
  }

  if (!phoneValid) {
    const err = new Error("This patient has no valid phone number to call.");
    err.status = 400;
    err.code = "INVALID_PHONE";
    throw err;
  }

  // Surfaces whose record is not yet a Contact promote it here; a lead is
  // already one and supplies its own short-circuit.
  const resolveContact = subject.resolveContact || ensurePatientContact;
  const contact = await resolveContact(person, tenantId);
  return { person, normalizedPhone, phoneValid, contact };
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
 * Shared call handlers.
 *
 * `resolveSubject(req)` returns the call subject for that surface, or null
 * when the record does not exist in this tenant. Everything after that point
 * is ONE code path, so a fix to the calling flow — cooldown, contact
 * creation, error mapping, audit — lands on every surface at once instead of
 * being copied per page.
 */
function callContextHandler(resolveSubject, notFound) {
  return async (req, res) => {
    try {
      const subject = await resolveSubject(req);
      if (!subject) return res.status(404).json(notFound);

      const { person, normalizedPhone, phoneValid } = await resolveCallTarget(
        subject,
        req.user.tenantId,
      );

      // A lead IS the contact; a patient may not have been promoted to one
      // yet, in which case there is no call history to be inside a cooldown.
      const contactId = subject.resolveContact ? person.id : person.contactId;
      let recentCallAt = null;
      if (contactId) {
        const recent = await wasRecentlyDialed(req.user.tenantId, contactId);
        recentCallAt = recent ? recent.toISOString() : null;
      }

      res.json({
        // Surface-specific fields (appointment date, service) when there are
        // any; the patient surface simply has none.
        ...subject.context,
        ...subject.ref,
        patientName: person.name,
        // The contact may not exist yet — it is created lazily when the first
        // call is placed. Null here simply means "no call history".
        contactId: contactId || null,
        phone: person.phone || null,
        normalizedPhone: phoneValid ? normalizedPhone : null,
        phoneValid,
        recentCallAt,
      });
    } catch (e) {
      sendCallifiedError(
        res,
        e,
        "[wellness-callified] call context",
        "Failed to load call details for this customer",
      );
    }
  };
}

/**
 * Option 1 — let the Callified AI agent handle the conversation.
 * Body: { campaignId (required), interest? }
 *
 * Delegates to the same callifiedClient.initiateCallForContact the generic
 * CRM Leads page uses: reuse-or-create the Callified lead, enroll it in the
 * campaign, dial, and write the CRM CallLog row.
 */
function aiCallHandler(resolveSubject, notFound) {
  return async (req, res) => {
    try {
      const { campaignId, interest } = req.body || {};
      if (!campaignId) {
        return res
          .status(400)
          .json({ error: "campaignId is required", code: "MISSING_CAMPAIGN_ID" });
      }

      const subject = await resolveSubject(req);
      if (!subject) return res.status(404).json(notFound);

      const { contact } = await resolveCallTarget(subject, req.user.tenantId, {
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
        interest: interest || subject.defaultInterest,
      });

      await writeAudit(
        "CallifiedCall",
        "INITIATE",
        String(result.callifiedLeadId),
        req.user.userId,
        req.user.tenantId,
        {
          surface: subject.surface,
          mode: "ai",
          ...subject.ref,
          contactId: contact.id,
          campaignId: Number(campaignId),
        },
      );

      res.json({ ...result, mode: "ai", ...subject.ref });
    } catch (e) {
      sendCallifiedError(
        res,
        e,
        "[wellness-callified] ai-call",
        "Failed to start the AI call",
      );
    }
  };
}

/**
 * Option 2 — a human staff member speaks to the customer from the browser.
 * Body: { campaignId (required), interest?, exotelAccountId?, scheduledCallId? }
 *
 * Callified places the customer leg and bridges its audio to a WebSocket. The
 * response carries a single-use `bridgeTicket` the browser redeems against the
 * CRM relay at `bridgePath` — the raw Callified socket needs the tenant API
 * credential, which never leaves the server.
 */
function manualCallHandler(resolveSubject, notFound) {
  return async (req, res) => {
    try {
      const { campaignId, interest, exotelAccountId, scheduledCallId } = req.body || {};
      if (!campaignId) {
        return res
          .status(400)
          .json({ error: "campaignId is required", code: "MISSING_CAMPAIGN_ID" });
      }

      const subject = await resolveSubject(req);
      if (!subject) return res.status(404).json(notFound);

      const { contact } = await resolveCallTarget(subject, req.user.tenantId, {
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
        interest: interest || subject.defaultInterest,
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
          surface: subject.surface,
          mode: "browser",
          ...subject.ref,
          contactId: contact.id,
          campaignId: Number(campaignId),
          callSid: result.callSid,
        },
      );

      res.json({ ...result, ...subject.ref });
    } catch (e) {
      sendCallifiedError(
        res,
        e,
        "[wellness-callified] manual-call",
        "Failed to start the manual call",
      );
    }
  };
}

const VISIT_NOT_FOUND = { error: "Appointment not found", code: "VISIT_NOT_FOUND" };
const PATIENT_NOT_FOUND = { error: "Patient not found", code: "PATIENT_NOT_FOUND" };
const LEAD_NOT_FOUND = { error: "Lead not found", code: "LEAD_NOT_FOUND" };

const resolveVisitSubject = async (req) => {
  const visit = await loadVisitForCall(req.params.visitId, req.user.tenantId);
  return visit ? visitSubject(visit) : null;
};

const resolvePatientSubject = async (req) => {
  const patient = await loadPatientForCall(req.params.patientId, req.user.tenantId);
  return patient ? patientSubject(patient) : null;
};

const resolveLeadSubject = async (req) => {
  const contact = await loadLeadForCall(req.params.leadId, req.user.tenantId);
  return contact ? leadSubject(contact) : null;
};

/**
 * Appointments page — call the patient attached to an appointment.
 *
 * GET  /api/wellness/callified/visits/:visitId/context
 * POST /api/wellness/callified/visits/:visitId/ai-call
 * POST /api/wellness/callified/visits/:visitId/manual-call
 */
router.get(
  "/callified/visits/:visitId/context",
  callGate,
  callContextHandler(resolveVisitSubject, VISIT_NOT_FOUND),
);
router.post(
  "/callified/visits/:visitId/ai-call",
  callGate,
  aiCallHandler(resolveVisitSubject, VISIT_NOT_FOUND),
);
router.post(
  "/callified/visits/:visitId/manual-call",
  callGate,
  manualCallHandler(resolveVisitSubject, VISIT_NOT_FOUND),
);

/**
 * Patients page — call a patient directly, with no appointment involved.
 *
 * GET  /api/wellness/callified/patients/:patientId/context
 * POST /api/wellness/callified/patients/:patientId/ai-call
 * POST /api/wellness/callified/patients/:patientId/manual-call
 */
router.get(
  "/callified/patients/:patientId/context",
  callGate,
  callContextHandler(resolvePatientSubject, PATIENT_NOT_FOUND),
);
router.post(
  "/callified/patients/:patientId/ai-call",
  callGate,
  aiCallHandler(resolvePatientSubject, PATIENT_NOT_FOUND),
);
router.post(
  "/callified/patients/:patientId/manual-call",
  callGate,
  manualCallHandler(resolvePatientSubject, PATIENT_NOT_FOUND),
);

/**
 * All Leads + Converted Leads — call a lead directly.
 *
 * Both pages are views over Contact filtered by status, so one route serves
 * both; nothing here needs to know which list the operator was looking at.
 *
 * GET  /api/wellness/callified/leads/:leadId/context
 * POST /api/wellness/callified/leads/:leadId/ai-call
 * POST /api/wellness/callified/leads/:leadId/manual-call
 */
router.get(
  "/callified/leads/:leadId/context",
  callGate,
  callContextHandler(resolveLeadSubject, LEAD_NOT_FOUND),
);
router.post(
  "/callified/leads/:leadId/ai-call",
  callGate,
  aiCallHandler(resolveLeadSubject, LEAD_NOT_FOUND),
);
router.post(
  "/callified/leads/:leadId/manual-call",
  callGate,
  manualCallHandler(resolveLeadSubject, LEAD_NOT_FOUND),
);

// Touch the shared denial copy so a future direct-403 path in this file uses
// the same neutral string the rest of the RBAC surface emits.
void RBAC_DENIED_MESSAGE;

module.exports = router;
module.exports.visitSubject = visitSubject;
module.exports.patientSubject = patientSubject;
module.exports.leadSubject = leadSubject;
