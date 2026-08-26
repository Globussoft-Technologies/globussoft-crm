/**
 * Prescription renewal / medicine requests — STAFF routes.
 *
 * Mounted at /api/wellness (every path below is namespaced under
 * /prescription-requests/, which routes/wellness.js does not own — same
 * convention as routes/wellness_callified.js).
 *
 * WHAT THIS IS
 *   The clinic-side half of the renewal workflow: the queue an admin or the
 *   prescribing doctor works through after a patient raises a request from
 *   the Android app. List → open → review against the original Rx → call the
 *   customer if needed → accept / reject / complete.
 *
 * WHAT IT IS NOT
 *   A second prescribing surface. Nothing here writes a Prescription. When a
 *   doctor decides to actually re-issue, they use the existing
 *   POST /api/wellness/prescriptions flow and (optionally) link the new Rx
 *   back via `fulfilledPrescriptionId` when completing the request.
 *
 * CALLING THE CUSTOMER
 *   Deliberately absent. The review screen reuses the existing patient-call
 *   endpoints — GET/POST /api/wellness/callified/patients/:patientId/* in
 *   routes/wellness_callified.js — so AI and manual calls placed from here
 *   land in the same CallLog, honour the same redial cooldown, and appear in
 *   Call History exactly like a call placed from the Patients page. A second
 *   set of call endpoints would fork all three.
 *
 * RBAC
 *   `prescription_requests.read` opens the queue; `.update` actions a
 *   request. Both are separate from `prescriptions.*` on purpose: triaging
 *   an inbox is front-desk work, prescribing is not. The wellnessRole allow
 *   list keeps the legacy admin/manager/doctor cohort working without a
 *   grant, and any custom role granted the permission passes through the
 *   `anyOfPermissions` door with no code change.
 */

const express = require("express");
const router = express.Router();

const { verifyToken } = require("../middleware/auth");
const { verifyWellnessRole } = require("../middleware/wellnessRole");
const renewals = require("../lib/prescriptionRenewalService");
const { writeAudit } = require("../lib/audit");

const readGate = [
  verifyToken,
  verifyWellnessRole(
    ["admin", "manager", "doctor", "professional", "receptionist", "telecaller"],
    {
      anyOfPermissions: [
        { module: "prescription_requests", action: "read" },
        // A doctor whose grants pre-date this module still needs to open the
        // request raised against their own prescription. `prescriptions.read`
        // is the closest existing grant and every clinical role has it.
        { module: "prescriptions", action: "read" },
      ],
      // Helpers are non-clinical runners — the queue exposes drug names and
      // patient phone numbers.
      deny: ["helper"],
    },
  ),
];

// Actioning a request is a clinical decision with a patient-visible outcome,
// so the allow list is narrower than read: no telecaller, no professional.
const writeGate = [
  verifyToken,
  verifyWellnessRole(["admin", "manager", "doctor"], {
    anyOfPermissions: [
      { module: "prescription_requests", action: "update" },
      { module: "prescriptions", action: "write" },
    ],
    deny: ["helper", "telecaller"],
  }),
];

function sendRenewalError(res, err, context, fallback) {
  if (err && err.name === "RenewalRequestError") {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(`${context}:`, err?.message || err);
  return res.status(500).json({ error: fallback });
}

/**
 * GET /api/wellness/prescription-requests
 *   ?status=PENDING&patientId=&doctorId=&q=&limit=&skip=
 *
 * Returns { items, total, counts } — `counts` is the per-status tally across
 * the same filter set minus the status itself, so the tab badges stay stable
 * while the operator moves between tabs.
 */
router.get("/prescription-requests", readGate, async (req, res) => {
  try {
    const { items, total, counts } = await renewals.listRequestsForStaff({
      tenantId: req.user.tenantId,
      status: req.query.status,
      patientId: req.query.patientId,
      doctorId: req.query.doctorId,
      q: req.query.q,
      limit: req.query.limit,
      skip: req.query.skip,
    });

    // The list embeds patient names + the requested drug snapshot, so it is a
    // PHI read on the same footing as PRESCRIPTION_LIST_READ. Fire-and-forget
    // — an audit hiccup must not fail the read (same policy as wellness.js).
    writeAudit(
      "PrescriptionRequest",
      "REQUEST_LIST_READ",
      null,
      req.user.userId,
      req.user.tenantId,
      {
        count: items.length,
        filters: {
          status: req.query.status || null,
          patientId: req.query.patientId || null,
          doctorId: req.query.doctorId || null,
          q: req.query.q || null,
        },
      },
    ).catch((err) => {
      console.warn(
        "[wellness] audit prescription-requests list failed:",
        err.message,
      );
    });

    res.json({
      items: items.map((r) => renewals.toPublicRequest(r)),
      total,
      counts,
    });
  } catch (err) {
    sendRenewalError(
      res,
      err,
      "[wellness] list prescription requests",
      "Failed to load prescription requests",
    );
  }
});

/**
 * GET /api/wellness/prescription-requests/:id
 *
 * The review screen's single fetch: the request, the patient, the original
 * prescription (drugs normalised the same way every other Rx response is),
 * the prescribing doctor, and the request's own status history.
 */
router.get("/prescription-requests/:id", readGate, async (req, res) => {
  try {
    const request = await renewals.getRequestForStaff({
      tenantId: req.user.tenantId,
      id: req.params.id,
    });
    if (!request) {
      return res
        .status(404)
        .json({ error: "Request not found", code: "REQUEST_NOT_FOUND" });
    }

    writeAudit(
      "PrescriptionRequest",
      "REQUEST_READ",
      request.id,
      req.user.userId,
      req.user.tenantId,
      { patientId: request.patientId, prescriptionId: request.prescriptionId },
    ).catch((err) => {
      console.warn(
        "[wellness] audit prescription-request read failed:",
        err.message,
      );
    });

    res.json(renewals.toPublicRequest(request));
  } catch (err) {
    sendRenewalError(
      res,
      err,
      "[wellness] get prescription request",
      "Failed to load the prescription request",
    );
  }
});

/**
 * PATCH /api/wellness/prescription-requests/:id/status
 * Body: { status: ACCEPTED|REJECTED|COMPLETED, note?, fulfilledPrescriptionId? }
 *
 * `note` is mandatory on REJECTED — the patient is told the outcome either
 * way, and a bare "declined" is not an answer. The service enforces it along
 * with the legal-transition and concurrent-update guards.
 */
router.patch(
  "/prescription-requests/:id/status",
  writeGate,
  async (req, res) => {
    try {
      const updated = await renewals.transitionRequest({
        tenantId: req.user.tenantId,
        id: req.params.id,
        toStatus: req.body?.status,
        note: req.body?.note,
        fulfilledPrescriptionId: req.body?.fulfilledPrescriptionId,
        user: req.user,
      });
      res.json(renewals.toPublicRequest(updated));
    } catch (err) {
      sendRenewalError(
        res,
        err,
        "[wellness] update prescription request status",
        "Failed to update the prescription request",
      );
    }
  },
);

module.exports = router;
