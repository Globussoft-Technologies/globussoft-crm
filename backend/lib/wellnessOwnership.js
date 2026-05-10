/**
 * Wellness ownership / authorization-policy module.
 *
 * Closes the deferred policy formalization from issue #527 (CRIT-02).
 *
 * Background — what #527's close-comment left open:
 *
 *   sumitglobussoft 2026-05-06 closing comment on #527:
 *   > Cross-professional patient edits stay open by design (multi-doctor
 *   > clinic semantics — providers share patients across visits) — the
 *   > existing audit log on PUT /patients/:id captures every cross-user
 *   > UPDATE so the action is traceable. Per-record ownership is the
 *   > remaining open question; tracked in [memory: project_wellness_phi_policy]
 *   > for Rishu's product call.
 *
 * That close-comment formalized phiReadGate / phiWriteGate (commit cd664f9,
 * v3.4.14) but DEFERRED the per-record / per-location ownership policy as
 * a product call. Wave 9 Agent A (2026-05-10) — formalize the chosen
 * defaults so future code can reference one source of truth.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  CHOSEN POLICIES (Wave 9 Agent A defaults, 2026-05-10)
 * ────────────────────────────────────────────────────────────────────────
 *
 *  POLICY 1 — TELECALLER READ ACCESS
 *  =================================
 *  WHO    : USER with wellnessRole='telecaller'
 *  WHAT   : Read clinical patient/visit/lead context needed to dispose
 *           junk leads + book appointments
 *  HOW    : phiReadGate already includes 'telecaller' in the allowed
 *           list. Confirmed shipped at routes/wellness.js:145 (cd664f9).
 *           This module re-exports the policy CONSTANT for callsites
 *           that want to assert "what is allowed today?" without
 *           grepping the gate definition.
 *  RATIONALE: telecaller's daily work (junk-lead disposition + booking
 *           callbacks) requires patient/visit context. Restricting them
 *           to lead-only views means they can't see whether a "junk"
 *           lead is actually a returning patient with a clinical history,
 *           which causes false-positive junk dispositions and PHI leaks
 *           when telecallers escalate to a doctor without context. The
 *           tradeoff (telecaller can read PHI) is mitigated by:
 *             - phiWriteGate EXCLUDES telecaller (no clinical writes)
 *             - audit log records every read on /patients/:id
 *
 *  POLICY 2 — CROSS-PROFESSIONAL VISIT/PATIENT EDITS
 *  =================================================
 *  WHO    : USER with wellnessRole in ['doctor', 'professional']
 *  WHAT   : Edit any patient record OR visit record within their tenant,
 *           regardless of which practitioner authored the original row
 *           or which location the visit belongs to.
 *  HOW    : phiWriteGate allows ['doctor', 'professional', 'admin',
 *           'manager']. No additional ownership check is applied. The
 *           audit log captures every UPDATE so cross-user edits are
 *           traceable.
 *  RATIONALE: clinic operations require coverage between professionals.
 *           A patient who books with Dr. Harsh today and walks in
 *           tomorrow when only Dr. Vikas is on shift cannot be served
 *           if writes are restricted to the original practitioner.
 *           Multi-location chains likewise need coverage between
 *           branches when one branch is short-staffed. The audit log
 *           is the accountability surface for cross-user/cross-location
 *           edits — not a permission gate.
 *
 *  POLICY 3 — HELPER (FRONT-DESK / RUNNER)
 *  =======================================
 *  WHO    : USER with wellnessRole='helper'
 *  WHAT   : Helper has NO clinical read or write access. They can use
 *           non-clinical surfaces (booking pages, calendar view of own
 *           workload, expenses, attendance).
 *  HOW    : phiReadGate and phiWriteGate both EXCLUDE 'helper'. A helper
 *           hitting any clinical route gets 403 WELLNESS_ROLE_FORBIDDEN.
 *  RATIONALE: helpers are typically front-desk / runner roles without
 *           clinical training. Reading prescription dosages or treatment
 *           plans is not in their job description and creates PHI-leak
 *           liability for the clinic.
 *
 *  POLICY 4 — STANDARD RBAC OVERRIDE
 *  =================================
 *  WHO    : role='ADMIN' or role='MANAGER' (regardless of wellnessRole)
 *  WHAT   : Pass through every clinical gate (read + write).
 *  HOW    : verifyWellnessRole's "admin" / "manager" alias tokens.
 *  RATIONALE: org-level roles (clinic owner, operations manager) need
 *           full visibility for compliance + escalations. Tenant-vertical
 *           gate (#325) ensures generic-tenant ADMINs cannot reach the
 *           wellness namespace.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  WHERE THE LIMITS COME FROM (schema reality, not aspiration)
 * ────────────────────────────────────────────────────────────────────────
 *
 * The original wave-9 dispatch prompt suggested "professional can edit
 * any visit at their assigned location, NOT just visits where they're
 * listed as the practitioner". Investigation found:
 *
 *   - User schema has NO `locationId` field (backend/prisma/schema.prisma).
 *   - There is no StaffLocation junction table.
 *   - Visit.locationId exists but the per-staff "assigned location"
 *     concept is not currently expressible in the data model.
 *
 * So the policy chosen is the CURRENT MAX of what the schema supports:
 * tenant-scoped + audit-logged + wellnessRole-gated.
 *
 * To upgrade to per-location ownership in a future wave, the schema needs
 * either:
 *   (a) User.locationId Int? FK with cascade-on-delete, OR
 *   (b) StaffLocation { userId, locationId, role } junction
 * The helper functions below are written so the future per-location check
 * is a one-line addition (search "PER-LOCATION TODO" below).
 *
 * ────────────────────────────────────────────────────────────────────────
 *  USAGE
 * ────────────────────────────────────────────────────────────────────────
 *
 *   const { canReadPhi, canWritePhi, isClinicalStaff } = require('../lib/wellnessOwnership');
 *
 *   if (!canReadPhi(req.user)) return res.status(403).json({...});
 *
 *   // For policy decisions inside route handlers (post-gate):
 *   if (isClinicalStaff(req.user) && visit.tenantId === req.user.tenantId) {
 *     // edit allowed — audit log will capture WHO edited
 *   }
 *
 * The middleware-level gates (phiReadGate / phiWriteGate in routes/
 * wellness.js) remain the FIRST line of defense; this module is the
 * SOURCE OF TRUTH for what those gates' allowed lists mean — used by
 * unit tests, future route handlers, and any new wellness module that
 * needs the same policy.
 *
 * To OVERRIDE these defaults: change the constants below and update the
 * unit tests at backend/test/middleware/wellnessOwnership.test.js. The
 * gate definitions in routes/wellness.js MUST stay in sync with the
 * constants here — the wellnessOwnership.test.js spec asserts that
 * sync explicitly.
 */

/**
 * Canonical PHI READ allowed wellness roles. Mirrors phiReadGate's
 * allowed list at routes/wellness.js. Keep in sync.
 */
const PHI_READ_ROLES = Object.freeze([
  'doctor', 'professional', 'telecaller', 'admin', 'manager',
]);

/**
 * Canonical PHI WRITE allowed wellness roles. Mirrors phiWriteGate's
 * allowed list at routes/wellness.js. Keep in sync.
 *
 * Telecaller is OUT — they route leads but don't author clinical records.
 * Helper is OUT — front-desk/runner role without clinical training.
 */
const PHI_WRITE_ROLES = Object.freeze([
  'doctor', 'professional', 'admin', 'manager',
]);

/**
 * Wellness roles considered "clinical staff" — i.e. doctors and
 * professionals (stylists / aestheticians / therapists). Excludes
 * telecaller and helper.
 */
const CLINICAL_WELLNESS_ROLES = Object.freeze(['doctor', 'professional']);

/**
 * True if the user is allowed to READ PHI on the wellness clinical
 * surfaces (patients, visits, Rx, consent, treatments, services).
 *
 * @param {{ role?: string, wellnessRole?: string }|null|undefined} user
 * @returns {boolean}
 */
function canReadPhi(user) {
  if (!user) return false;
  if (user.role === 'ADMIN' || user.role === 'MANAGER') return true;
  if (typeof user.wellnessRole !== 'string') return false;
  return PHI_READ_ROLES.includes(user.wellnessRole);
}

/**
 * True if the user is allowed to WRITE PHI on the wellness clinical
 * surfaces (POST/PUT/DELETE on patients, visits, Rx, consent, treatments).
 *
 * @param {{ role?: string, wellnessRole?: string }|null|undefined} user
 * @returns {boolean}
 */
function canWritePhi(user) {
  if (!user) return false;
  if (user.role === 'ADMIN' || user.role === 'MANAGER') return true;
  if (typeof user.wellnessRole !== 'string') return false;
  return PHI_WRITE_ROLES.includes(user.wellnessRole);
}

/**
 * True if the user is a doctor or professional (excludes telecaller and
 * helper, even though telecaller has read access via canReadPhi).
 *
 * Useful for "this is the practitioner authoring the row" checks where
 * we want to distinguish from operational/support staff.
 *
 * @param {{ role?: string, wellnessRole?: string }|null|undefined} user
 * @returns {boolean}
 */
function isClinicalStaff(user) {
  if (!user) return false;
  return CLINICAL_WELLNESS_ROLES.includes(user.wellnessRole);
}

/**
 * True if the user can edit (mutate) the given visit record. Per
 * POLICY 2, any tenant-scoped clinical staff can edit any visit
 * regardless of which practitioner is listed on the visit.
 *
 * PER-LOCATION TODO: when User gains a locationId field (future wave),
 * narrow this to `user.locationId == visit.locationId || user.role IN
 * ['ADMIN','MANAGER']`. The audit log already records every UPDATE so
 * the narrowing would be a defense-in-depth, not a primary check.
 *
 * @param {{ role?: string, wellnessRole?: string, tenantId?: number }} user
 * @param {{ tenantId?: number, locationId?: number|null }} visit
 * @returns {boolean}
 */
function canEditVisit(user, visit) {
  if (!user || !visit) return false;
  if (user.tenantId !== visit.tenantId) return false;       // tenant gate
  if (!canWritePhi(user)) return false;                      // role gate
  // PER-LOCATION TODO (when User.locationId ships):
  // if (user.role !== 'ADMIN' && user.role !== 'MANAGER' &&
  //     user.locationId != null && visit.locationId != null &&
  //     user.locationId !== visit.locationId) return false;
  return true;
}

/**
 * True if the user can edit the given patient record. Per POLICY 2,
 * any tenant-scoped clinical staff can edit any patient regardless of
 * which provider authored the row.
 *
 * @param {{ role?: string, wellnessRole?: string, tenantId?: number }} user
 * @param {{ tenantId?: number, locationId?: number|null }} patient
 * @returns {boolean}
 */
function canEditPatient(user, patient) {
  if (!user || !patient) return false;
  if (user.tenantId !== patient.tenantId) return false;
  if (!canWritePhi(user)) return false;
  return true;
}

module.exports = {
  PHI_READ_ROLES,
  PHI_WRITE_ROLES,
  CLINICAL_WELLNESS_ROLES,
  canReadPhi,
  canWritePhi,
  isClinicalStaff,
  canEditVisit,
  canEditPatient,
};
