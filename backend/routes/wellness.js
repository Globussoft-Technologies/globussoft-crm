/**
 * Wellness vertical routes — clinical CRM modules.
 *
 * All endpoints below are tenant-scoped and require auth (mounted under the
 * global auth guard in server.js).
 *
 * Mounted at: /api/wellness
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const prisma = require("../lib/prisma");
const {
  normalizePrescriptionDrugs,
  normalizePrescriptionList,
} = require("../lib/prescriptionHelpers");
const { runForTenant, executeApproved } = require("../cron/orchestratorEngine");
const {
  getAllTreatmentPlans,
  updateTreatmentPlan,
} = require("../controllers/treatmentPlanController");
const {
  getPatientsSummary,
  getPatientDetails,
} = require("../controllers/visitController");
const {
  renderPrescriptionPdf,
  renderConsentPdf,
  renderBrandedInvoicePdf,
  renderPatientSummaryPdf,
  // ₹-glyph fix for the route-level landscape report PDF below.
  applyRupeeCapableFonts,
} = require("../services/pdfRenderer");
const { writeAudit, diffFields } = require("../lib/audit");
// #920 slice S42 — wellness PHI list-endpoint slim projections.
// `?fields=summary` opts into a SQL-level slim shape that drops every PHI
// column from Patient / Visit / Prescription list responses; default shape
// stays full row (back-compat). The PRD §11 PHI-read audit row is still
// written on both paths, but the PII_DISCLOSED row is SKIPPED on the slim
// path because no PHI columns are in the response — the operator never
// SAW PHI, so no disclosure event happened.
const listProjection = require("../lib/listProjection");
const { isFullShape } = listProjection;
const { verifyToken } = require("../middleware/auth");
// Patient-portal notification inbox (additive — patient-scoped, separate from
// the staff Notification table). Backs /portal/me/notifications* below.
const {
  listPatientNotifications,
  markPatientNotificationRead,
  markAllPatientNotificationsRead,
  toPublic: toPublicNotification,
} = require("../lib/patientNotificationService");
// #679/#680/#681/#682 PII masking helpers + viewer policy. Used on list views
// (Locations, Patients list, Telecaller Queue) so low-trust viewers
// (telecaller / helper / generic USER on wellness tenant) see masked
// phones / emails / names / DOB, while ADMIN / MANAGER / clinical staff see
// full PHI. Disclosure events on UNMASKED reads emit a PII_DISCLOSED audit
// row.
const {
  shouldMaskForViewer,
  _maskRow,
  maskRows,
  auditDisclosureDetails,
} = require("../lib/piiMask");
// #313/#244 datetime callsite-sweep: tenant-aware datetime helpers. The
// `IST_OFFSET_MS` shortcut + naive `new Date(req.body.visitDate)` constructions
// in this file pre-date the helper at backend/lib/datetime.js (commit 663bd7c).
// They worked correctly only when both server clock and clinic operated in IST
// — for the wellness vertical that's a product-anchored guarantee (India-based
// clinics, cron schedules pinned to 07:00 IST), so we keep the TZ literally
// pinned to Asia/Kolkata here rather than reading from tenant.locale. The
// migration is a clarity + DST-safety win, not a tenant-multi-TZ enabler.
const { parseDateTimeLocalInTZ, formatInTenantTZ } = require("../lib/datetime");
// Wave 11 Agent GG: 4-class booking-conflict gate.
const { assertVisitSlotAvailable } = require("../lib/bookingAvailability");
// Centralized appointment service — book / cancel / reschedule business
// rules. Both the legacy /appointments/* routes (CUSTOMER session) and
// the new /portal/appointments/* routes (verifyPatientToken accepts both
// CUSTOMER + phone+OTP) converge on this service so business logic
// stays in one place.
const appointmentService = require("../services/appointmentService");
// Issue #207/#214/#216: wellness users carry both `role` (ADMIN/MANAGER/USER)
// and an orthogonal `wellnessRole` (doctor/professional/telecaller/helper).
// verifyRole only knows about the former, so a USER+doctor could hit Owner-
// Dashboard / financial / catalog mutation endpoints. verifyWellnessRole adds
// the second axis: allow lists like ["doctor","admin"] gate clinical writes,
// ["admin","manager"] gates org-wide reports + catalog edits.
const { verifyWellnessRole } = require("../middleware/wellnessRole");
// #539: standard role-gate (orthogonal to verifyWellnessRole — checks the
// generic role enum ADMIN/MANAGER/USER from the JWT, not the wellnessRole
// axis). Used by DELETE /patients/:id and other admin-only operations
// added to this file.
const { verifyRole } = require("../middleware/auth");
// RBAC permission gate for the staff-authed "My Prescriptions" page —
// see GET /api/wellness/my-prescriptions below. Lets any role granted
// `my_prescriptions.read` view their OWN linked Patient's Rx without
// needing the tenant-wide `prescriptions.read`.
const {
  requirePermission,
  userHasPermission,
} = require("../middleware/requirePermission");
// #920 slice S59 — canonical PHI-read gate factory. The original inline
// declaration of `phiReadGate` (which lived just below the `phiReadGate`
// JSDoc block ~line 365) has been replaced with this factory call so the
// gate's policy is defined ONCE in middleware/phiReadGate.js and reused by
// any future route that needs the same PHI-read access semantics. The
// JSDoc block at lines 320-365 below documents WHY the gate exists; the
// factory call returns byte-equivalent behaviour to the prior inline
// `verifyWellnessRole([...], { anyOfPermissions: [...], deny: ["helper"] })`
// declaration. See middleware/phiReadGate.js for the canonical policy.
const { makePhiReadGate } = require("../middleware/phiReadGate");
const {
  uploadImage,
  deleteFile,
  extractKeyFromUrl,
  BUCKET_NAME: S3_BUCKET_NAME,
} = require("../services/s3Service");
// Plan #PAT-EXPORT — XLSX writer for patients export + import template.
// Lazy-loaded at handler time so the require can't crash boot if the
// install somehow ships without xlsx (it's in package.json so this is
// belt-and-braces).
let _xlsxLib = null;
function loadXlsx() {
  if (_xlsxLib) return _xlsxLib;
  _xlsxLib = require("xlsx");
  return _xlsxLib;
}

// Portal tokens carry { patientId } and are issued/verified separately from staff
// tokens. Prefer a dedicated PORTAL_JWT_SECRET so a leaked patient-portal key
// can't forge staff tokens; fall back to JWT_SECRET when unset for transition.
const { PORTAL_JWT_SECRET, JWT_SECRET } = require("../config/secrets");

// Patient-portal inline JWT middleware — used by /portal/* endpoints.
// Portal endpoints bypass the global user-JWT guard (see server.js openPaths)
// so we must verify the token here.
//
// Accepts TWO token shapes:
//   A. patient-portal token (phone+OTP flow): { patientId } signed with
//      PORTAL_JWT_SECRET — used by the public /book + /portal pages.
//   B. regular CUSTOMER session token: { userType: 'CUSTOMER', userId,
//      tenantId } signed with JWT_SECRET — used by Customer-role users who
//      logged in via /auth/customer/register or /auth/login. We resolve
//      Patient via Patient.userId (see schema.prisma "Self-booking user"
//      field) so the dashboard widgets next-appointment / my-prescriptions
//      work for these users without forcing an extra phone+OTP step.
async function verifyPatientToken(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing portal token" });

  let decoded = null;
  try {
    decoded = jwt.verify(token, PORTAL_JWT_SECRET);
  } catch (_e) {
    if (PORTAL_JWT_SECRET !== JWT_SECRET) {
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (_e2) {
        return res
          .status(401)
          .json({ error: "Invalid or expired portal token" });
      }
    } else {
      return res.status(401).json({ error: "Invalid or expired portal token" });
    }
  }

  // Path A — patient-portal token
  if (decoded.patientId) {
    // Look up the patient row to attach tenantId. The phone+OTP JWT only
    // carries { patientId, phoneLast10 } so tenantId is unavailable from
    // the claim alone. Downstream RBAC gates (requirePortalPermission)
    // and audit writes both need tenantId, so resolve it once here and
    // memoize on req.patient.
    try {
      const patientRow = await prisma.patient.findUnique({
        where: { id: decoded.patientId },
        select: { id: true, tenantId: true },
      });
      if (!patientRow) {
        return res.status(401).json({ error: "Invalid portal token" });
      }
      req.patient = {
        id: patientRow.id,
        tenantId: patientRow.tenantId,
        phoneLast10: decoded.phoneLast10,
      };
      return next();
    } catch (err) {
      console.error(
        "[wellness] verifyPatientToken Path A patient lookup failed:",
        err.message,
      );
      return res.status(500).json({ error: "Failed to resolve patient" });
    }
  }

  // Path B — any authenticated session that has (or can claim) a linked
  // Patient row in this tenant.
  //
  // The data model: clinics use BOTH the CUSTOMER system role AND custom
  // STAFF-typed roles (commonly the default "USER" role) as patient
  // pools. The distinguishing characteristic of "this user is a patient"
  // is NOT the role name but whether a Patient row is linked to their
  // userId in this tenant.
  //
  // Resolution order:
  //   1. Direct link via Patient.userId (fast path, applies to ANY role).
  //   2. (CUSTOMER userType only) Claim an unlinked Patient with the
  //      same (email, tenantId) — handles self-registered customers
  //      whose Patient record was created by staff first.
  //   3. (CUSTOMER userType only) Auto-create a minimal Patient row
  //      from the User profile so dashboard widgets work on first
  //      sign-in.
  //
  // STAFF-typed users (USER, DOCTOR, MANAGER, etc.) only get the direct
  // link in step 1 — we deliberately do NOT auto-create Patient rows
  // for them. Real staff (admins, doctors, receptionists) have no
  // linked Patient row and get rejected with 401 here; the frontend
  // shows the role-mismatch view instead of triggering forced logout.
  if (decoded.userId && decoded.tenantId) {
    try {
      let patient = await prisma.patient.findFirst({
        where: { userId: decoded.userId, tenantId: decoded.tenantId },
        select: { id: true, phone: true, tenantId: true },
      });

      if (!patient && decoded.userType === "CUSTOMER") {
        const userRow = await prisma.user.findUnique({
          where: { id: decoded.userId },
          select: { name: true, email: true },
        });
        if (!userRow) {
          return res.status(401).json({ error: "Invalid portal token" });
        }

        // Step 2 — claim an unlinked Patient with the same email so we
        // don't fork the clinical record.
        if (userRow.email) {
          const claimable = await prisma.patient.findFirst({
            where: {
              tenantId: decoded.tenantId,
              email: userRow.email,
              userId: null,
            },
            select: { id: true, phone: true, tenantId: true },
          });
          if (claimable) {
            await prisma.patient.update({
              where: { id: claimable.id },
              data: { userId: decoded.userId },
            });
            patient = claimable;
          }
        }

        // Step 3 — first-time CUSTOMER with no clinical record; create one.
        if (!patient) {
          patient = await prisma.patient.create({
            data: {
              name: userRow.name || userRow.email || "Customer",
              email: userRow.email || null,
              tenantId: decoded.tenantId,
              userId: decoded.userId,
              source: "self-register",
            },
            select: { id: true, phone: true, tenantId: true },
          });
        }
      }

      if (!patient) {
        // No linked Patient row for this user. Surface a distinct error
        // code so the frontend can show "this account isn't linked to a
        // patient profile" rather than treating it as a generic auth
        // failure (which would force-logout via fetchApi's 401 handler).
        return res.status(403).json({
          error: "This account is not linked to a patient profile",
          code: "NO_PATIENT_PROFILE",
        });
      }

      req.patient = {
        id: patient.id,
        tenantId: patient.tenantId,
        phoneLast10:
          (patient.phone || "").replace(/\D/g, "").slice(-10) || null,
      };
      return next();
    } catch (err) {
      console.error(
        "[wellness] verifyPatientToken patient lookup failed:",
        err.message,
      );
      return res.status(500).json({ error: "Failed to resolve patient" });
    }
  }

  return res.status(401).json({ error: "Invalid portal token" });
}

// Patient-portal RBAC resolver — see lib/portalPermissions.js for the full
// rationale. In short: patient is a Patient row, not a User row, so they
// can't have UserRole assignments. Every patient on a tenant implicitly
// inherits that tenant's CUSTOMER role permissions, and the handler still
// scopes data by `patientId: req.patient.id` as defence in depth.
const {
  requirePortalPermission,
  getCustomerRolePermissions,
} = require("../lib/portalPermissions");

const router = express.Router();

// Visit photos: memory storage so the buffer can go to EITHER S3 (when
// AWS creds are configured) OR the local filesystem fallback (CI / any env
// without S3). The POST handler below branches on S3_BUCKET_NAME.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per photo
});

// ── Helpers ────────────────────────────────────────────────────────

// Reject non-numeric :id params with 400 instead of letting Prisma blow up
// later with "Invalid value provided. Expected Int, provided NaN" → 500.
router.param("id", (req, res, next, id) => {
  const n = parseInt(id, 10);
  if (Number.isNaN(n) || n < 1) {
    return res
      .status(400)
      .json({ error: "id must be a positive integer", code: "INVALID_ID" });
  }
  next();
});

const tenantWhere = (req, extra = {}) => ({
  tenantId: req.user.tenantId,
  ...extra,
});

// #527 / #533 (CRIT-02 + HI-04): PHI access gates.
//
// Pre-fix the wellness clinical routes were tenant-scoped but had NO
// wellnessRole check — a JWT with role=USER and no wellnessRole still got
// 200 on GET /patients (full tenant PII), GET /visits, GET /prescriptions,
// PUT /patients/:id, etc. Pen-test repro: a USER-role professional editing
// an Admin-created patient row in tenant 2 (Patient 3584).
//
// Two gates layered onto every previously-ungated clinical route:
//
//   phiReadGate  — reads. Allowed: doctor, professional, telecaller, admin,
//                  manager. Telecaller stays in because they need patient/
//                  visit context to dispose junk leads. Helper is OUT —
//                  helpers are non-clinical (front-desk / runner roles).
//
//   phiWriteGate — writes. Same minus telecaller — telecallers route leads
//                  but don't author clinical records (Rx + consent already
//                  use stricter gates: requireClinicalRole / verifyWellnessRole
//                  with explicit ["doctor"]/["admin"] lists).
//
// Behavioural change: a USER with no wellnessRole now gets 403
// WELLNESS_ROLE_FORBIDDEN on every clinical route instead of 200. ADMIN
// and MANAGER pass through (the verifyWellnessRole "admin"/"manager"
// special tokens). The cross-professional edit surface stays open by design
// — clinics share patients across providers; the audit log already records
// every UPDATE so cross-user edits are traceable.
//
// Tenant.vertical check is inherited from verifyWellnessRole — non-wellness
// tenants get 403 WELLNESS_TENANT_REQUIRED before the role check runs.
// "clinical" is a meta-token resolved by verifyWellnessRole against the
// per-tenant WellnessRoleType catalog — ANY wellnessRole with
// `canTakeVisits = true` (doctor, professional, nurse, stylist, plus any
// future custom clinical role added in Settings → Wellness Role Types)
// passes the gate automatically with NO code change. The literal
// "doctor" / "professional" entries stay alongside it so existing JWTs +
// the legacy PHI_READ_ROLES contract pinned in wellnessOwnership.test.js
// continue to work unchanged; the literal match short-circuits the
// catalog DB lookup for the common case.
//
// `anyOfPermissions` opens a SECOND door alongside the wellnessRole
// match: any user with one of the listed RBAC permissions (granted via
// Roles & Permissions admin) passes the gate even without a matching
// wellnessRole. Each entry mirrors the corresponding page in the
// backend page catalog (lib/pageCatalog.js) — granting the page's
// listed `requiredPermissions` to a custom role makes that role
// immediately usable end-to-end (sidebar → page → API).
// #920 slice S59 — was previously an inline `verifyWellnessRole([...], {
// anyOfPermissions: [...], deny: ["helper"] })` declaration here. The
// policy now lives in middleware/phiReadGate.js (imported at the top of
// this file). `makePhiReadGate()` returns the IDENTICAL middleware the
// inline form did — same allow list, same `anyOfPermissions` cluster,
// same `deny: ["helper"]`. The JSDoc above documents the WHY; the
// middleware module documents the policy contents. All 30+ callsites of
// `phiReadGate` below continue to work unchanged.
const phiReadGate = makePhiReadGate();

// Permission check for practitioner-assignment surfaces (drag-to-reassign,
// "Assign doctor" modal, PATCH /visits/:id/assign-doctor). Doctors must be
// able to edit their OWN visits (vitals, notes, status) but must NOT be able
// to assign/reassign visits to OTHER practitioners. Assignment is reserved
// for admin / manager / receptionist / telecaller, OR any role explicitly
// granted the new `appointments.assign` permission.
async function canAssignPractitioner(req) {
  if (!req.user) return false;
  if (req.user.role === "ADMIN" || req.user.role === "MANAGER") return true;
  const wr = String(req.user.wellnessRole || "").toLowerCase();
  if (wr === "receptionist" || wr === "telecaller") return true;
  // Clinical practitioners are never assignment operators, even if they
  // somehow hold broad `appointments.write` / `calendar.write` grants.
  if (wr === "doctor" || wr === "professional") return false;

  try {
    // Primary gate: the new granular permission.
    const hasAssign = await userHasPermission(req.user, "appointments", "assign");
    if (hasAssign) return true;

    // Fallback for existing tenants before the appointments.assign backfill
    // runs: non-doctor staff who already have booking + calendar write perms
    // (receptionists, telecallers) can assign. Doctors are excluded by their
    // clinical wellnessRole even though they also hold those perms.
    if (wr !== "doctor" && wr !== "professional") {
      const [hasApptWrite, hasCalWrite] = await Promise.all([
        userHasPermission(req.user, "appointments", "write"),
        userHasPermission(req.user, "calendar", "write"),
      ]);
      if (hasApptWrite && hasCalWrite) return true;
    }
  } catch (_e) {
    // Fail-closed: any permission lookup error degrades to deny.
  }
  return false;
}

const phiWriteGate = verifyWellnessRole(
  ["clinical", "doctor", "professional", "admin", "manager"],
  {
    anyOfPermissions: [
      { module: "patients", action: "write" },
      { module: "appointments", action: "write" },
      // `book_appointment.write` + `waitlist.write` opened in v3.8.x
      // when the `appointments` module was split per-page — a telecaller
      // with only `book_appointment.write` still needs to call the
      // booking endpoint, and waitlist promote needs `waitlist.write`.
      { module: "book_appointment", action: "write" },
      { module: "waitlist", action: "write" },
      { module: "calendar", action: "write" },
      { module: "visits", action: "write" },
      { module: "prescriptions", action: "write" },
      { module: "consents", action: "write" },
    ],
    // Per the documented gate intent (comment at line 261):
    //   "phiWriteGate — writes. Same minus telecaller — telecallers
    //    route leads but don't author clinical records"
    // The anyOfPermissions backdoor (added in v3.8.x for custom RBAC
    // roles) accidentally lets telecaller through via the
    // `appointments.write` grant they have for booking-from-call. Deny
    // them explicitly so the gate matches its documented contract.
    // Telecaller's legitimate write paths live on their own gates:
    //   verifyWellnessRole(["telecaller","admin","manager"]) at lines
    //   9173+9226 for queue dispose, plus the booking-specific gates
    //   at /resources, /book/* etc. that list telecaller explicitly.
    // Helpers are non-clinical (front-desk / runner roles) — never get
    // PHI write access. Pinned by memberships-api.spec.js:642+646 and
    // wellness-rbac-regression-api.spec.js:684 (POLICY 1).
    deny: ["helper", "telecaller"],
  },
);

// `adminOrPerm(module, action)` is the canonical factory for admin-only
// wellness routes that ALSO want to accept a specific RBAC permission
// grant. Replaces every `verifyWellnessRole(["admin", "manager"])`
// declaration with a per-route permission unlock — so a custom RBAC
// role granted e.g. `services.write` can create services even without
// a matching wellnessRole. The literal `["admin", "manager"]` array
// stays so RBAC ADMIN/MANAGER continue to short-circuit before any
// permission lookup (no DB hit on the hot path).
const adminOrPerm = (module, action) =>
  verifyWellnessRole(["admin", "manager"], {
    anyOfPermissions: [{ module, action }],
  });

// Plan #PAT-FILTERS / #PAT-TAGS — querystring helpers shared by the
// patient list + export + bulk-tag endpoints.
//
// parseListParam: accepts repeated (`?x=a&x=b`) AND comma-joined
// (`?x=a,b`) forms — Express + qs handle them differently depending on
// caller; we normalize to a deduplicated string list with empties dropped.
// parseDateOnly: returns a Date at UTC midnight for a YYYY-MM-DD input;
// null for empty / invalid. Avoids the new Date("") → InvalidDate trap.
function parseListParam(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(",");
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const s = String(v).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
function parseDateOnly(raw) {
  if (!raw || typeof raw !== "string") return null;
  // Accept YYYY-MM-DD or ISO with timezone — collapse to UTC date.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(
    Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

// Flatten Prisma's PatientTag[] → simple [{id,name,color}] for the API
// response. Mutates a shallow copy so the caller can spread further.
function flattenPatientTags(patient) {
  if (!patient) return patient;
  if (!Array.isArray(patient.tags)) return patient;
  return {
    ...patient,
    tags: patient.tags
      .map((pt) => (pt && pt.tag ? pt.tag : null))
      .filter(Boolean),
  };
}

// #348 — namespacing rule. The /api/wellness/* namespace is reserved for
// CLINICAL resources (patients, visits, prescriptions, consents, treatments,
// services, locations, etc.). Org-level resources — staff, audit logs,
// tenants, billing — live at /api/<resource> and have NO wellness alias.
//
// Pre-fix, the inconsistency was: /api/staff -> 200, /api/wellness/staff -> 403
// (caught by the wellness role gate, no clear error); /api/audit -> 200,
// /api/wellness/audit -> 404 (no handler). Both failure modes left integration
// builders guessing.
//
// We respond with 410 Gone (not 404) and a clear redirect message so the
// caller learns the rule explicitly. See docs/API_NAMESPACING.md.
const wellnessNamespacedRedirect = (canonical) => (req, res) => {
  res.status(410).json({
    error: `Use ${canonical}. Wellness namespace is for clinical resources only.`,
    code: "WELLNESS_NAMESPACE_INVALID",
    canonical,
  });
};
router.all("/staff", wellnessNamespacedRedirect("/api/staff"));
router.all("/staff/*", wellnessNamespacedRedirect("/api/staff"));
router.all("/audit", wellnessNamespacedRedirect("/api/audit"));
router.all("/audit/*", wellnessNamespacedRedirect("/api/audit"));

// Gap #22 / #614: Auto-credit loyalty points on completed visits.
// Earn rule reads from LoyaltyConfig (per-tenant): earnPerVisit (flat) +
// (earnPercentOfSpend × amount/100) + (earnPerCurrencyUnit × amount). Defaults
// preserve the original "10% of amountCharged" behaviour byte-identically when
// no LoyaltyConfig row exists. Idempotent — only one 'earned'
// LoyaltyTransaction per visitId. Failures are swallowed so the visit save
// is never rolled back by a loyalty issue.
async function maybeAutoCreditLoyalty(visit, tenantId) {
  try {
    if (!visit || visit.status !== "completed") return;
    // Load tenant's earn rules; if no row, fall back to historic 10% rule.
    let cfg;
    try {
      cfg = await prisma.loyaltyConfig.findUnique({ where: { tenantId } });
    } catch {
      cfg = null; // schema not yet pushed — keep old behaviour
    }
    const autoEnabled = cfg ? cfg.autoEarnEnabled !== false : true;
    if (!autoEnabled) return;
    const earnPerVisit = cfg?.earnPerVisit ?? 0;
    const earnPercent = cfg?.earnPercentOfSpend ?? 10;
    const earnPerUnit = cfg?.earnPerCurrencyUnit ?? 0;

    const amt = parseFloat(visit.amountCharged) || 0;
    let points = earnPerVisit;
    if (amt > 0) {
      points += Math.floor((amt * earnPercent) / 100);
      points += Math.floor(amt * earnPerUnit);
    }
    if (points <= 0) return;
    // Idempotency: skip if an 'earned' row already exists for this visit
    const existing = await prisma.loyaltyTransaction.findFirst({
      where: { tenantId, visitId: visit.id, type: "earned" },
      select: { id: true },
    });
    if (existing) return;
    await prisma.loyaltyTransaction.create({
      data: {
        patientId: visit.patientId,
        tenantId,
        type: "earned",
        points,
        reason: `Visit #${visit.id} (auto earn)`,
        visitId: visit.id,
      },
    });
  } catch (err) {
    console.error("[wellness] auto-credit loyalty failed:", err.message);
  }
}

// Helper: ensure a wellness Patient is backed by a CRM Contact so that
// invoice-based payment flows (Razorpay Payment Links, etc.) can reuse the
// generic billing model. If the patient already has a contactId, verify it
// still exists; otherwise create a contact from the patient's name/email/phone
// and back-link it. Failures are thrown so the caller can decide whether to
// abort the parent operation.
async function ensurePatientContact(patient, tenantId) {
  if (!patient) throw new Error("Patient not found");

  const desiredName = patient.name || "Unnamed patient";
  const desiredEmail = patient.email || null;
  const desiredPhone = patient.phone || null;

  if (patient.contactId) {
    const existing = await prisma.contact.findUnique({
      where: { id: patient.contactId },
    });
    if (existing) {
      if (
        existing.name !== desiredName ||
        existing.email !== desiredEmail ||
        existing.phone !== desiredPhone
      ) {
        return await prisma.contact.update({
          where: { id: existing.id },
          data: {
            name: desiredName,
            email: desiredEmail,
            phone: desiredPhone,
          },
        });
      }
      return existing;
    }
  }

  const contactData = {
    name: desiredName,
    email: desiredEmail,
    phone: desiredPhone,
    tenantId,
    status: "lead",
  };

  try {
    const contact = await prisma.contact.create({ data: contactData });
    await prisma.patient.update({
      where: { id: patient.id },
      data: { contactId: contact.id },
    });
    return contact;
  } catch (err) {
    // If the create failed because a contact with this email/phone already
    // exists, link to that one instead of leaving the patient orphaned.
    const existing = await prisma.contact.findFirst({
      where: {
        tenantId,
        OR: [
          ...(desiredEmail ? [{ email: desiredEmail }] : []),
          ...(desiredPhone ? [{ phone: desiredPhone }] : []),
        ],
      },
    });
    if (existing) {
      await prisma.patient.update({
        where: { id: patient.id },
        data: { contactId: existing.id },
      });
      if (
        existing.name !== desiredName ||
        existing.email !== desiredEmail ||
        existing.phone !== desiredPhone
      ) {
        return await prisma.contact.update({
          where: { id: existing.id },
          data: {
            name: desiredName,
            email: desiredEmail,
            phone: desiredPhone,
          },
        });
      }
      return existing;
    }
    throw err;
  }
}

// Helper: create (or reuse) an Invoice for a completed wellness visit and
// generate a hosted Razorpay Payment Link via the shared payment-link factory.
// Returns { url, gateway, paymentId } on success, or { error, code } when the
// tenant has no payment gateway configured. Never throws for gateway issues;
// caller handles/ignores the error object.
async function generateVisitPaymentLink({ visit, tenantId, baseUrl }) {
  const { createInvoicePaymentLink } = require("../lib/paymentLink");

  const patient = await prisma.patient.findUnique({
    where: { id: visit.patientId },
    select: { id: true, name: true, email: true, phone: true, contactId: true },
  });

  const contact = await ensurePatientContact(patient, tenantId);

  let invoice = await prisma.invoice.findFirst({
    where: { visitId: visit.id, tenantId },
  });

  if (!invoice) {
    const invoiceNum = `WLV-${visit.id}-${Date.now()}`;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7);

    invoice = await prisma.invoice.create({
      data: {
        invoiceNum,
        amount: Math.round(Number(visit.amountCharged) * 100) / 100,
        dueDate,
        contactId: contact.id,
        tenantId,
        visitId: visit.id,
      },
    });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true },
  });

  return createInvoicePaymentLink({
    tenantId,
    invoice: {
      id: invoice.id,
      invoiceNum: invoice.invoiceNum,
      amount: invoice.amount,
    },
    contact: {
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
    },
    contactId: contact.id,
    currency: "INR",
    gatewayPref: "razorpay",
    tenantName: tenant?.name,
    baseUrl,
    description: `Wellness Visit #${visit.id}`,
  });
}

// Day boundaries in IST (UTC+05:30). Wellness clinics are India-based, so
// "today" must mean the IST calendar day — using server-local hours would
// shift the window by 5h30 on UTC servers (the production default), making
// 00:00–05:30 IST visits land on the previous day.
//
// Migrated from raw IST_OFFSET_MS arithmetic to backend/lib/datetime.js
// (#313 callsite-sweep, 2026-05-07): the helper handles DST-aware zone math
// via date-fns-tz. Asia/Kolkata has no DST so behaviour is byte-identical
// to the offset-math version, but the call shape is now reusable + the
// drift-on-non-IST-tenants risk is gone for any future code that copies
// this pattern.
const WELLNESS_TZ = "Asia/Kolkata";
const startOfDay = (d = new Date()) => {
  // Render the input as the IST calendar date, then re-parse "<date>T00:00"
  // in IST → UTC. Round-trips exactly through the #313 helper.
  const istDate = formatInTenantTZ(d, WELLNESS_TZ, "yyyy-MM-dd");
  return parseDateTimeLocalInTZ(`${istDate}T00:00:00`, WELLNESS_TZ);
};
const endOfDay = (d = new Date()) => {
  const istDate = formatInTenantTZ(d, WELLNESS_TZ, "yyyy-MM-dd");
  // Helper drops sub-second precision; pad with .999ms after parse for
  // strict equivalence with the previous setUTCHours(23,59,59,999) form.
  const utc = parseDateTimeLocalInTZ(`${istDate}T23:59:59`, WELLNESS_TZ);
  return new Date(utc.getTime() + 999);
};

// #313 callsite-sweep: when the route receives a datetime-local form input
// (no TZ marker — a string like "2026-05-15T10:30" emitted by HTML
// <input type="datetime-local">), naively `new Date(input)` parses it as
// UTC and silently drifts by 5h30 on storage. We route those through the
// helper so the wall-clock the user typed is preserved.
//
// Full ISO timestamps (with trailing 'Z' or '±HH:mm' offset) carry their TZ
// in-band; the native Date constructor handles them correctly. We detect
// the difference by sniffing for a TZ marker.
const DATETIME_LOCAL_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
function parseTenantDateInput(input) {
  if (input == null) return null;
  if (input instanceof Date) return input;
  if (typeof input !== "string") return new Date(input);
  // datetime-local form (no TZ suffix) → route through tenant-TZ-aware
  // parser so the wall-clock is preserved.
  if (DATETIME_LOCAL_RE.test(input)) {
    return parseDateTimeLocalInTZ(input, WELLNESS_TZ);
  }
  // Full ISO with TZ marker, RFC2822, etc. — Date constructor handles it.
  return new Date(input);
}

// ─────────────────────────────────────────────────────────────────────
// CLINICAL ARTEFACT RETENTION POLICY (issue #21 — resolved by product/legal):
//
// Clinical artefacts — Patient, Visit, Prescription, ConsentForm,
// AgentRecommendation, ServiceConsumption — are PERMANENT. Once created,
// they are NEVER deleted, neither hard-deleted nor soft-deleted.
//
// Why:
//   • HIPAA Security Rule 164.312(c)(1) integrity controls
//   • India MoHFW EMR Standards 2016 require permanent retention with an
//     amendment trail (not deletion)
//   • DPDP Act 2023 explicit consent + retention rules accommodate this
//
// What this means in code:
//   • DO NOT add DELETE endpoints for these resources. Period.
//   • DO NOT add `deletedAt` columns to these models in schema.prisma.
//   • Corrections happen via PUT/PATCH (amendment) — the audit log captures
//     the prior + new values so the historical state stays auditable.
//   • If a row was created in error (typo, test data), use an out-of-band
//     ops script with a written justification recorded in the audit log.
//     Never expose a DELETE path through the API.
//
// The /visits/:id/photos DELETE below is exempt: it removes photo URL
// strings from a JSON array on the Visit row, NOT the Visit itself. The
// Visit row + its prescriptions + consent + visit history all stay.
// ─────────────────────────────────────────────────────────────────────

// Active treatments — clinical PHI. Read: clinical/ops roles only (matches
// the consent + treatment-plan posture established in #280, #324, #326).
// Write (status update): same clinical-write gate used on POST /prescriptions
// (#326). Without these gates a telecaller / helper / stylist could read all
// treatment plans and update status — same RBAC class as the prescription
// hole #326 closed earlier today.
router.get(
  "/activetreatment",
  verifyWellnessRole(
    ["clinical", "doctor", "professional", "manager", "admin"],
    {
      anyOfPermissions: [
        { module: "patients", action: "read" },
        { module: "visits", action: "read" },
      ],
    },
  ),
  getAllTreatmentPlans,
);
router.put("/treatment-plans/:id", requireClinicalRole, updateTreatmentPlan);

// visited patients — PHI read; gate required (was ungated prior to audit).
router.get("/reports/visit", phiReadGate, getPatientsSummary);
router.get("/reports/visit/:id", phiReadGate, getPatientDetails);

// ── Patients ───────────────────────────────────────────────────────

router.get("/patients", phiReadGate, async (req, res) => {
  try {
    const { q, limit = 50, offset = 0, locationId } = req.query;
    const where = tenantWhere(req);
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { phone: { contains: q } },
        { email: { contains: q } },
      ];
    }
    if (locationId) where.locationId = parseInt(locationId);
    // Plan #PAT-FILTERS: multi-select Source. Repeatable querystring
    // (`source=walk-in&source=referral`) AND comma-separated
    // (`source=walk-in,referral`) — accept both because Express parses
    // repeated params differently depending on whether the caller used
    // qs vs a manual fetch with a comma list. Empty strings drop.
    const sourceList = parseListParam(req.query.source);
    if (sourceList.length) where.source = { in: sourceList };
    // Multi-select Gender (rare — usually 1-2 values, but list-shape
    // keeps the API consistent with Source / Tags).
    const genderList = parseListParam(req.query.gender);
    if (genderList.length) where.gender = { in: genderList };
    // Added-date range. Both ends inclusive at the day boundary; addedTo
    // bumps to end-of-day so a user picking "2026-05-19" gets that day's
    // patients included.
    const addedFrom = parseDateOnly(req.query.addedFrom);
    const addedTo = parseDateOnly(req.query.addedTo);
    if (addedFrom || addedTo) {
      where.createdAt = {};
      if (addedFrom) where.createdAt.gte = addedFrom;
      if (addedTo) {
        const end = new Date(addedTo);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }
    // Tag filter: AND across selected tags (a patient must carry ALL
    // selected tags). `tags=1,2` semantics.
    const tagIds = parseListParam(req.query.tags)
      .map((v) => parseInt(v, 10))
      .filter((n) => Number.isFinite(n));
    if (tagIds.length) {
      where.AND = (where.AND || []).concat(
        tagIds.map((tagId) => ({ tags: { some: { tagId } } })),
      );
    }
    // #628: hide soft-deleted patients from default list. Admin/manager
    // can opt in via ?includeDeleted=1 for compliance / restore views.
    if (
      req.query.includeDeleted !== "1" &&
      req.query.includeDeleted !== "true"
    ) {
      where.deletedAt = null;
    }
    // #920 slice S42: opt-in slim shape via `?fields=summary`. SQL-drops
    // every PHI column at the Prisma layer; default shape stays full row.
    // Slim path also skips the `tags` include (pickers don't render tags;
    // the full-row path keeps it for the patient-list UI).
    const wantFullShape = isFullShape(req.query);
    const findManyArgs = {
      where,
      take: Math.min(parseInt(limit, 10) || 50, 200),
      skip: parseInt(offset, 10) || 0,
      orderBy: { createdAt: "desc" },
    };
    if (wantFullShape) {
      findManyArgs.include = {
        tags: {
          include: { tag: { select: { id: true, name: true, color: true } } },
        },
      };
    } else {
      findManyArgs.select = listProjection("Patient", false);
    }
    const [patients, total] = await Promise.all([
      prisma.patient.findMany(findManyArgs),
      prisma.patient.count({ where }),
    ]);
    // PRD §11: HIPAA / DPDP Act — log every PHI read. Patient list is a
    // bulk PHI read; emit ONE row per request (not N), with no PHI values.
    // #534 (PERF-1): fire-and-forget. The audit row is a regulatory log,
    // not a response-time critical write — awaiting it added 30-100ms to
    // every list call on a cold connection. The promise still completes
    // (its catch logs to console); response goes out without blocking.
    //
    // S42 audit-coordination contract: the PATIENT_LIST_READ row fires on
    // BOTH paths (full + slim). The regulatory "an operator hit the list
    // endpoint" visibility is required regardless of payload shape; what
    // changes on the slim path is the absence of PII_DISCLOSED (because
    // no PII columns are in the response).
    writeAudit(
      "Patient",
      "PATIENT_LIST_READ",
      null,
      req.user.userId,
      req.user.tenantId,
      {
        count: patients.length,
        query: q || null,
        locationId: locationId ? parseInt(locationId) : null,
        // Pin the shape into the audit row so reviewers can answer "did
        // this list call disclose PHI?" without joining two tables.
        shape: wantFullShape ? "full" : "summary",
      },
    ).catch((auditErr) => {
      console.warn(
        "[wellness] audit PATIENT_LIST_READ failed:",
        auditErr.message,
      );
    });
    // #680: low-trust viewers (telecaller / helper / generic USER on wellness
    // tenant) see masked name / phone / email / dob on the list view. Admin /
    // manager / doctor / professional see full PHI (phiReadGate above already
    // gates the route; this further narrows what each role sees inside the
    // payload). Unmasked-disclosure emits a PII_DISCLOSED audit row in
    // addition to PATIENT_LIST_READ so reviewers can answer "who saw the
    // unmasked names + phones?" without joining two log tables.
    //
    // S42: slim path skips the PII_DISCLOSED row (no PHI columns in
    // response = no disclosure event happened). BUT we still apply the
    // existing maskRows() viewer-policy filter on `name` for low-trust
    // viewers — telecallers and any generic-USER who bypassed via an
    // RBAC permission grant. Patient name CAN be PII when combined with
    // other context (a telecaller seeing "Ravi Kumar, location=Mumbai-1"
    // still has actionable PII on slim path). Masking the name preserves
    // the #680 viewer-tier privacy contract on the slim path too.
    //
    // No PII_DISCLOSED audit is written even on the un-masked slim path —
    // the slim response shape doesn't ship phone/email/dob, so the
    // disclosure surface is structurally narrower than the masked column
    // list (`['name','phone','email','dob']`). Reviewers querying for
    // PII_DISCLOSED rows are looking for phone/email/dob leaks; a
    // name-only slim read isn't in that risk class.
    if (!wantFullShape) {
      const outPatientsSlim = shouldMaskForViewer(req)
        ? maskRows(patients, ["name"])
        : patients;
      return res.json({ patients: outPatientsSlim, total });
    }
    const piiFields = ["name", "phone", "email", "dob"];
    const outPatients = shouldMaskForViewer(req)
      ? maskRows(patients, piiFields)
      : patients;
    if (!shouldMaskForViewer(req) && patients.length > 0) {
      writeAudit(
        "Patient",
        "PII_DISCLOSED",
        null,
        req.user.userId,
        req.user.tenantId,
        auditDisclosureDetails(req, "patient_list", patients, {
          fields: piiFields,
        }),
      ).catch((auditErr) => {
        console.warn(
          "[wellness] audit Patient PII_DISCLOSED failed:",
          auditErr.message,
        );
      });
    }
    // Flatten PatientTag[] → [{id,name,color}]. Masking above doesn't touch
    // the `tags` relation; this is intentional — tag names aren't PHI.
    const finalPatients = outPatients.map(flattenPatientTags);
    res.json({ patients: finalPatients, total });
  } catch (e) {
    console.error("[wellness] list patients error:", e.message);
    res.status(500).json({ error: "Failed to list patients" });
  }
});

// #680: patient list CSV/XLSX export.
//
// Policy:
//   - ADMIN / MANAGER gets full DOB + phone + email unmasked (operator-
//     triggered export is the canonical staff-facing audit-trail point;
//     they need the real numbers to call patients / cross-reference an
//     external system).
//   - lower-trust viewers (telecaller / helper / generic USER on wellness
//     tenant) can ONLY trigger the export with `?masked=1`, which forces
//     masked output even though the role is otherwise gated out of CSV.
//   - `?masked=1` always wins regardless of role — admin-triggered exports
//     destined for a third-party (e.g. shared with marketing agency, sent
//     to print vendor) can be intentionally redacted by toggling the flag.
//
// Every unmasked export emits a PII_DISCLOSED audit row with the row count
// + record IDs (capped at 200) — disclosure has full traceability.
router.get("/patients.csv", phiReadGate, async (req, res) => {
  try {
    const { q, locationId } = req.query;
    const wantMasked = req.query.masked === "1" || req.query.masked === "true";
    // Anti-DoS: cap export size so large tenants can't buffer unlimited
    // rows in memory. Default 1000, hard max 5000.
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    const offset = parseInt(req.query.offset, 10) || 0;
    const where = tenantWhere(req);
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { phone: { contains: q } },
        { email: { contains: q } },
      ];
    }
    if (locationId) where.locationId = parseInt(locationId);
    if (
      req.query.includeDeleted !== "1" &&
      req.query.includeDeleted !== "true"
    ) {
      where.deletedAt = null;
    }
    const patients = await prisma.patient.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });
    // Decide mask: query flag wins; otherwise role-based.
    const mustMask = wantMasked || shouldMaskForViewer(req);
    const piiFields = ["name", "phone", "email", "dob"];
    const rows = mustMask ? maskRows(patients, piiFields) : patients;

    const headers = [
      "ID",
      "Name",
      "Phone",
      "Email",
      "DOB",
      "Gender",
      "Created",
    ];

    // Stream the CSV row-by-row to avoid buffering the full payload.
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="patients${mustMask ? "-masked" : ""}-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    // BOM so Excel auto-detects UTF-8.
    res.write("﻿");
    res.write(headers.map(csvEscape).join(",") + "\r\n");
    for (const p of rows) {
      const row = [
        p.id,
        p.name || "",
        p.phone || "",
        p.email || "",
        p.dob
          ? typeof p.dob === "string"
            ? p.dob.slice(0, 10)
            : new Date(p.dob).toISOString().slice(0, 10)
          : "",
        p.gender || "",
        p.createdAt ? new Date(p.createdAt).toISOString() : "",
      ];
      res.write(row.map(csvEscape).join(",") + "\r\n");
    }
    res.end();

    // Audit. Always emit so the export is traceable; flag mask-state in the
    // details payload.
    writeAudit(
      "Patient",
      mustMask ? "PII_EXPORT_MASKED" : "PII_DISCLOSED",
      null,
      req.user.userId,
      req.user.tenantId,
      {
        ...auditDisclosureDetails(req, "patient_export_csv", patients, {
          fields: piiFields,
        }),
        masked: mustMask,
        query: q || null,
        locationId: locationId ? parseInt(locationId) : null,
        limit,
        offset,
      },
    ).catch((e) =>
      console.warn("[wellness] audit Patient export failed:", e.message),
    );
  } catch (e) {
    console.error("[wellness] patients.csv export error:", e.message);
    res.status(500).json({ error: "Failed to export patients" });
  }
});

// ── Plan #PAT-TAGS / #PAT-EXPORT — patient tagging + filtered CSV/XLSX
// export + import template.
//
// IMPORTANT route-ordering: every literal path here (/patients/tags,
// /patients/export, /patients/import-template, /patients/tags/bulk)
// MUST be declared BEFORE the dynamic `/patients/:id` route below.
// Express matches in registration order; `:id` will greedy-match the
// literal segment otherwise and the literal endpoints become unreachable.
// ─────────────────────────────────────────────────────────────────────

// Build the shared patients-list `where` clause from query params, so
// /patients (list) and /patients/export (download) and the bulk tag
// endpoints all interpret filters identically. Mirrors the inline logic
// in GET /patients above — the small duplication keeps the list handler
// readable and the export handler self-contained.
function buildPatientListWhere(req) {
  const where = tenantWhere(req);
  const q = req.query.q;
  if (q) {
    where.OR = [
      { name: { contains: q } },
      { phone: { contains: q } },
      { email: { contains: q } },
    ];
  }
  if (req.query.locationId) where.locationId = parseInt(req.query.locationId);
  const sourceList = parseListParam(req.query.source);
  if (sourceList.length) where.source = { in: sourceList };
  const genderList = parseListParam(req.query.gender);
  if (genderList.length) where.gender = { in: genderList };
  const addedFrom = parseDateOnly(req.query.addedFrom);
  const addedTo = parseDateOnly(req.query.addedTo);
  if (addedFrom || addedTo) {
    where.createdAt = {};
    if (addedFrom) where.createdAt.gte = addedFrom;
    if (addedTo) {
      const end = new Date(addedTo);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }
  const tagIds = parseListParam(req.query.tags)
    .map((v) => parseInt(v, 10))
    .filter((n) => Number.isFinite(n));
  if (tagIds.length) {
    where.AND = (where.AND || []).concat(
      tagIds.map((tagId) => ({ tags: { some: { tagId } } })),
    );
  }
  if (req.query.includeDeleted !== "1" && req.query.includeDeleted !== "true") {
    where.deletedAt = null;
  }
  return where;
}

// First-run defaults for the wellness vertical. When a tenant opens the
// tag picker and has zero tags yet, we seed these 30 once so the user
// has a useful starting palette instead of an empty popover. They're
// fully editable / deletable after that — we DO NOT re-seed on
// subsequent reads, even if the user deletes every tag.
const WELLNESS_DEFAULT_TAGS = [
  "1 lakh & Above",
  "100-10k Customers",
  "10k-25k Customers",
  "25k-50k Customers",
  "50k to 1 lakh",
  "Apoinment Confirm",
  "Ayurveda",
  "Busy call",
  "Client Cut the call",
  "Client will call back later",
  "Client will visit as per convinience",
  "Concern for Freind",
  "dermatologist case",
  "Follow up",
  "Follow up After 1 month",
  "Follow up after 15 days",
  "Follow up after week",
  "Hair Transplant",
  "Hydra Facial",
  "Incoming not available",
  "Inquiry",
  "Interested",
  "Not Answering The call",
  "not interested",
  "Number Doesn't Exit",
  "Out of station",
  "Skin",
  "switch off",
  "visited",
  "wrong number",
];

// Per-tenant guard so the first read doesn't trigger seeding more than
// once even under concurrent calls (StrictMode re-render storm, etc).
const _tagSeedInFlight = new Map();
async function ensureDefaultTagsSeeded(tenantId) {
  if (_tagSeedInFlight.has(tenantId)) return _tagSeedInFlight.get(tenantId);
  const p = (async () => {
    const existing = await prisma.tag.count({ where: { tenantId } });
    if (existing > 0) return;
    await prisma.tag.createMany({
      data: WELLNESS_DEFAULT_TAGS.map((name) => ({ tenantId, name })),
      skipDuplicates: true,
    });
  })();
  _tagSeedInFlight.set(tenantId, p);
  try {
    await p;
  } finally {
    _tagSeedInFlight.delete(tenantId);
  }
}

// GET /patients/tags — list all tenant tags (used by filter panel +
// per-row popover + bulk-action picker). Read-only; phiReadGate is the
// correct fence because tag names are intrinsically tied to PHI lists.
router.get("/patients/tags", phiReadGate, async (req, res) => {
  try {
    // First-visit bootstrap: if this tenant has never had any tag, seed
    // the wellness defaults so the popover isn't empty. Subsequent reads
    // skip the bootstrap (`existing > 0` short-circuits).
    await ensureDefaultTagsSeeded(req.user.tenantId).catch((seedErr) => {
      console.warn("[wellness] default tag seed failed:", seedErr.message);
    });
    const tags = await prisma.tag.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    });
    res.json({ tags });
  } catch (e) {
    console.error("[wellness] list patient tags error:", e.message);
    res.status(500).json({ error: "Failed to list tags" });
  }
});

// POST /patients/tags — create a new tag (or no-op return existing on
// case-insensitive name collision). Body: { name, color? }.
// Returns { tag: {id,name,color}, created: bool }.
router.post("/patients/tags", phiWriteGate, async (req, res) => {
  try {
    const rawName =
      typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!rawName) return res.status(400).json({ error: "name is required" });
    if (rawName.length > 60) {
      return res.status(400).json({ error: "name must be ≤ 60 chars" });
    }
    const color =
      typeof req.body.color === "string" &&
        /^#[0-9a-fA-F]{3,8}$/.test(req.body.color.trim())
        ? req.body.color.trim()
        : null;
    const existing = await prisma.tag.findFirst({
      where: { tenantId: req.user.tenantId, name: rawName },
    });
    if (existing) {
      return res.json({
        tag: { id: existing.id, name: existing.name, color: existing.color },
        created: false,
      });
    }
    const tag = await prisma.tag.create({
      data: { tenantId: req.user.tenantId, name: rawName, color },
      select: { id: true, name: true, color: true },
    });
    res.status(201).json({ tag, created: true });
  } catch (e) {
    console.error("[wellness] create patient tag error:", e.message);
    res.status(500).json({ error: "Failed to create tag" });
  }
});

// POST /patients/tags/bulk — add one or more tags to one or more
// patients. Body: { patientIds: number[], tagIds: number[] }.
// Returns { assigned: count } (rows that were newly linked; existing
// links are silently no-op'd via skipDuplicates).
router.post("/patients/tags/bulk", phiWriteGate, async (req, res) => {
  try {
    const patientIds = Array.isArray(req.body.patientIds)
      ? req.body.patientIds
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isFinite(n))
      : [];
    const tagIds = Array.isArray(req.body.tagIds)
      ? req.body.tagIds
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isFinite(n))
      : [];
    if (!patientIds.length || !tagIds.length) {
      return res
        .status(400)
        .json({ error: "patientIds and tagIds are required arrays" });
    }
    // Tenant-scope check: both patients + tags must belong to req.user.tenantId.
    // Otherwise a tenant could probe + link to another tenant's patient via id.
    const [validPatients, validTags] = await Promise.all([
      prisma.patient.findMany({
        where: {
          tenantId: req.user.tenantId,
          id: { in: patientIds },
          deletedAt: null,
        },
        select: { id: true },
      }),
      prisma.tag.findMany({
        where: { tenantId: req.user.tenantId, id: { in: tagIds } },
        select: { id: true },
      }),
    ]);
    if (!validPatients.length || !validTags.length) {
      return res
        .status(404)
        .json({ error: "no matching patients or tags in tenant" });
    }
    const data = [];
    for (const p of validPatients) {
      for (const t of validTags) data.push({ patientId: p.id, tagId: t.id });
    }
    const result = await prisma.patientTag.createMany({
      data,
      skipDuplicates: true,
    });
    writeAudit(
      "PatientTag",
      "BULK_ASSIGN",
      null,
      req.user.userId,
      req.user.tenantId,
      {
        patientIds: validPatients.map((p) => p.id),
        tagIds: validTags.map((t) => t.id),
        assigned: result.count,
      },
    ).catch((auditErr) => {
      console.warn(
        "[wellness] audit PatientTag BULK_ASSIGN failed:",
        auditErr.message,
      );
    });
    res.json({ assigned: result.count });
  } catch (e) {
    console.error("[wellness] bulk-assign patient tags error:", e.message);
    res.status(500).json({ error: "Failed to bulk-assign tags" });
  }
});

// DELETE /patients/tags/bulk — body-shaped delete (Express + fetch both
// support DELETE-with-body). Body: { patientIds, tagIds }.
// Returns { removed: count }.
router.delete("/patients/tags/bulk", phiWriteGate, async (req, res) => {
  try {
    const patientIds = Array.isArray(req.body.patientIds)
      ? req.body.patientIds
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isFinite(n))
      : [];
    const tagIds = Array.isArray(req.body.tagIds)
      ? req.body.tagIds
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isFinite(n))
      : [];
    if (!patientIds.length || !tagIds.length) {
      return res
        .status(400)
        .json({ error: "patientIds and tagIds are required arrays" });
    }
    // Tenant-scope check: only delete join rows whose Patient belongs
    // to this tenant. Use the Patient relation rather than scanning IDs
    // so a cross-tenant id never lands a delete.
    const result = await prisma.patientTag.deleteMany({
      where: {
        patientId: { in: patientIds },
        tagId: { in: tagIds },
        patient: { tenantId: req.user.tenantId },
        tag: { tenantId: req.user.tenantId },
      },
    });
    writeAudit(
      "PatientTag",
      "BULK_REMOVE",
      null,
      req.user.userId,
      req.user.tenantId,
      { patientIds, tagIds, removed: result.count },
    ).catch((auditErr) => {
      console.warn(
        "[wellness] audit PatientTag BULK_REMOVE failed:",
        auditErr.message,
      );
    });
    res.json({ removed: result.count });
  } catch (e) {
    console.error("[wellness] bulk-remove patient tags error:", e.message);
    res.status(500).json({ error: "Failed to bulk-remove tags" });
  }
});

// Build the patient export rows used by both CSV and XLSX paths.
// Returns { headers: string[], rows: Array<Array<string|number>> }.
async function buildPatientExportPayload(req) {
  const where = buildPatientListWhere(req);
  // Optional explicit-ID selection (used by "Export Selected" from the
  // bulk-action bar). Supersedes the search/filter `where` ONLY for the
  // id filter; the tenantId from buildPatientListWhere stays in.
  const explicitIds = parseListParam(req.query.ids)
    .map((v) => parseInt(v, 10))
    .filter((n) => Number.isFinite(n));
  if (explicitIds.length) {
    where.id = { in: explicitIds };
  }
  const patients = await prisma.patient.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 10000, // hard cap, mirrors wellnessCsv.js
    include: {
      tags: {
        include: { tag: { select: { id: true, name: true, color: true } } },
      },
    },
  });
  // Apply PII mask for low-trust viewers (mirrors patients.csv policy).
  const wantMasked = req.query.masked === "1" || req.query.masked === "true";
  const mustMask = wantMasked || shouldMaskForViewer(req);
  const piiFields = ["name", "phone", "email", "dob"];
  const rows = mustMask ? maskRows(patients, piiFields) : patients;

  const headers = [
    "ID",
    "Name",
    "Phone",
    "Email",
    "DOB",
    "Gender",
    "Source",
    "Tags",
    "Created",
  ];
  const dataRows = rows.map((p) => {
    const tagNames = Array.isArray(p.tags)
      ? p.tags
        .map((pt) => (pt && pt.tag ? pt.tag.name : null))
        .filter(Boolean)
        .join(", ")
      : "";
    return [
      p.id,
      p.name || "",
      p.phone || "",
      p.email || "",
      p.dob
        ? typeof p.dob === "string"
          ? p.dob.slice(0, 10)
          : new Date(p.dob).toISOString().slice(0, 10)
        : "",
      p.gender || "",
      p.source || "",
      tagNames,
      p.createdAt ? new Date(p.createdAt).toISOString() : "",
    ];
  });
  return { headers, rows: dataRows, patients, mustMask, piiFields };
}

// GET /patients/export?format=csv|xlsx&<filters> — replaces the older
// /patients.csv (which stays for back-compat). format defaults to csv.
router.get("/patients/export", phiReadGate, async (req, res) => {
  try {
    const format = (req.query.format || "csv").toString().toLowerCase();
    if (format !== "csv" && format !== "xlsx") {
      return res.status(400).json({ error: "format must be csv or xlsx" });
    }
    const { headers, rows, patients, mustMask, piiFields } =
      await buildPatientExportPayload(req);

    writeAudit(
      "Patient",
      mustMask ? "PII_EXPORT_MASKED" : "PII_DISCLOSED",
      null,
      req.user.userId,
      req.user.tenantId,
      {
        ...auditDisclosureDetails(req, `patient_export_${format}`, patients, {
          fields: piiFields,
        }),
        masked: mustMask,
        format,
        filters: req.query,
      },
    ).catch((e) =>
      console.warn("[wellness] audit Patient export failed:", e.message),
    );

    const stamp = new Date().toISOString().slice(0, 10);
    const baseName = `patients${mustMask ? "-masked" : ""}-${stamp}`;

    if (format === "xlsx") {
      const XLSX = loadXlsx();
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Patients");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${baseName}.xlsx"`,
      );
      return res.end(buf);
    }

    // CSV path — same rowsToCsv writer the legacy /patients.csv uses.
    const csv = rowsToCsv(headers, rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${baseName}.csv"`,
    );
    res.write("﻿");
    res.end(csv);
  } catch (e) {
    console.error("[wellness] patient export error:", e.message);
    res.status(500).json({ error: "Failed to export patients" });
  }
});

// GET /patients/import-template?format=csv|xlsx — column headers the
// importer expects, plus one example row. Mirrors the customers entity
// headers in lib/csvEntities.js so a downloaded template imports cleanly.
router.get("/patients/import-template", phiReadGate, async (req, res) => {
  try {
    const format = (req.query.format || "csv").toString().toLowerCase();
    if (format !== "csv" && format !== "xlsx") {
      return res.status(400).json({ error: "format must be csv or xlsx" });
    }
    // Match the customers entity contract from backend/lib/csvEntities.js.
    const headers = [
      "name",
      "phone",
      "email",
      "gender",
      "dob",
      "source",
      "bloodGroup",
      "allergies",
      "notes",
    ];
    const sample = [
      "Anita Sharma",
      "+919876543210",
      "anita@example.com",
      "F",
      "1992-04-18",
      "walk-in",
      "O+",
      "",
      "",
    ];

    if (format === "xlsx") {
      const XLSX = loadXlsx();
      const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Patients");
      const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="patients-template.xlsx"',
      );
      return res.end(buf);
    }
    const csv = rowsToCsv(headers, [sample]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="patients-template.csv"',
    );
    res.write("﻿");
    res.end(csv);
  } catch (e) {
    console.error("[wellness] patient template error:", e.message);
    res.status(500).json({ error: "Failed to build template" });
  }
});

// POST /patients/:id/tags — assign a single tag to a single patient.
// Body: either { tagId: number } (existing) or { name: string, color? }
// (creates the tag inline + assigns). 200 on success.
router.post("/patients/:id/tags", phiWriteGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (!Number.isFinite(patientId)) {
      return res.status(400).json({ error: "invalid patient id" });
    }
    const patient = await prisma.patient.findFirst({
      where: { id: patientId, tenantId: req.user.tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!patient) return res.status(404).json({ error: "patient not found" });

    let tagId = parseInt(req.body.tagId, 10);
    let tag = null;
    if (Number.isFinite(tagId)) {
      tag = await prisma.tag.findFirst({
        where: { id: tagId, tenantId: req.user.tenantId },
        select: { id: true, name: true, color: true },
      });
    } else if (typeof req.body.name === "string" && req.body.name.trim()) {
      const name = req.body.name.trim();
      if (name.length > 60) {
        return res.status(400).json({ error: "name must be ≤ 60 chars" });
      }
      const color =
        typeof req.body.color === "string" &&
          /^#[0-9a-fA-F]{3,8}$/.test(req.body.color.trim())
          ? req.body.color.trim()
          : null;
      tag = await prisma.tag.findFirst({
        where: { tenantId: req.user.tenantId, name },
        select: { id: true, name: true, color: true },
      });
      if (!tag) {
        tag = await prisma.tag.create({
          data: { tenantId: req.user.tenantId, name, color },
          select: { id: true, name: true, color: true },
        });
      }
    }
    if (!tag)
      return res.status(400).json({ error: "tagId or name is required" });

    await prisma.patientTag.upsert({
      where: { patientId_tagId: { patientId, tagId: tag.id } },
      create: { patientId, tagId: tag.id },
      update: {},
    });
    res.json({ tag });
  } catch (e) {
    console.error("[wellness] add patient tag error:", e.message);
    res.status(500).json({ error: "Failed to add tag" });
  }
});

// DELETE /patients/:id/tags/:tagId — remove a single tag from a single
// patient. Tenant-scoped via the patient join.
router.delete("/patients/:id/tags/:tagId", phiWriteGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    const tagId = parseInt(req.params.tagId, 10);
    if (!Number.isFinite(patientId) || !Number.isFinite(tagId)) {
      return res.status(400).json({ error: "invalid id" });
    }
    // Tenant scope check via inner relation filter.
    const result = await prisma.patientTag.deleteMany({
      where: {
        patientId,
        tagId,
        patient: { tenantId: req.user.tenantId },
        tag: { tenantId: req.user.tenantId },
      },
    });
    if (result.count === 0) {
      return res.status(404).json({ error: "tag link not found" });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[wellness] remove patient tag error:", e.message);
    res.status(500).json({ error: "Failed to remove tag" });
  }
});

router.get("/patients/:id", phiReadGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const where = tenantWhere(req, { id });
    // #628: 404 soft-deleted patients unless ?includeDeleted=1 is passed.
    // Mirrors the contacts.js #167 pattern + the list-endpoint filter
    // already added above.
    if (
      req.query.includeDeleted !== "1" &&
      req.query.includeDeleted !== "true"
    ) {
      where.deletedAt = null;
    }
    const patient = await prisma.patient.findFirst({
      where,
      include: {
        visits: {
          orderBy: { visitDate: "desc" },
          include: {
            service: true,
            doctor: { select: { id: true, name: true, email: true } },
          },
        },
        prescriptions: {
          orderBy: { createdAt: "desc" },
          // #278: include doctor so the Rx detail modal can show "prescribed by".
          include: {
            doctor: { select: { id: true, name: true, email: true } },
          },
        },
        consents: {
          orderBy: { signedAt: "desc" },
          select: {
            id: true,
            templateName: true,
            signedAt: true,
            patientId: true,
            serviceId: true,
            hasPdfBlob: true,
            service: { select: { id: true, name: true } },
            // EXCLUDED: signatureSvg, contentSnapshot, signedPdfBlob
          },
        },
        treatmentPlans: { include: { service: true } },
      },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    // PRD §11: log every patient detail read. Capture the FIELD NAMES returned
    // (so reviewers know what columns were exposed) but NEVER the values —
    // logging allergies/dob/phone here would defeat the audit-log's HIPAA role.
    // #534 (PERF-1): fire-and-forget — see PATIENT_LIST_READ above.
    {
      const accessedFields = Object.keys(patient).filter(
        (k) =>
          !["visits", "prescriptions", "consents", "treatmentPlans"].includes(
            k,
          ),
      );
      writeAudit(
        "Patient",
        "PATIENT_DETAIL_READ",
        patient.id,
        req.user.userId,
        req.user.tenantId,
        {
          patientId: patient.id,
          name: patient.name,
          accessedFields,
        },
      ).catch((auditErr) => {
        console.warn(
          "[wellness] audit PATIENT_DETAIL_READ failed:",
          auditErr.message,
        );
      });
    }
    if (patient.prescriptions) {
      patient.prescriptions = patient.prescriptions.map(normalizePrescriptionDrugs);
    }
    res.json(patient);
  } catch (e) {
    console.error("[wellness] get patient error:", e.message);
    res.status(500).json({ error: "Failed to load patient" });
  }
});

// #346 — nested patient sub-resources. The Patient detail SPA tabs (visits,
// Rx, consents, treatment plans) call these REST-shaped paths directly
// instead of /visits?patientId= etc. Without them every tab returned 404.
// Each handler mirrors the select shape of the corresponding flat list endpoint
// (router.get("/visits"), /prescriptions, /consents, /treatments) and adds a
// patient-existence check so we return 404 for an unknown patient (rather
// than an empty array, which would mask data-integrity bugs in the UI).

// GET /patients/:id/visits — visits for a specific patient
router.get("/patients/:id/visits", phiReadGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.id);
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
      select: { id: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const visits = await prisma.visit.findMany({
      where: tenantWhere(req, { patientId }),
      orderBy: { visitDate: "desc" },
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true, category: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    // Audit-log the read same as the flat /visits list (PRD §11 clinical reads).
    // #534 (PERF-1): fire-and-forget — see PATIENT_LIST_READ above.
    writeAudit(
      "Patient",
      "PATIENT_VISITS_READ",
      patientId,
      req.user.userId,
      req.user.tenantId,
      {
        patientId,
        visitCount: visits.length,
      },
    ).catch((auditErr) => {
      console.warn(
        "[wellness] audit PATIENT_VISITS_READ failed:",
        auditErr.message,
      );
    });
    res.json(visits);
  } catch (e) {
    console.error("[wellness] list patient visits error:", e.message);
    res.status(500).json({ error: "Failed to list patient visits" });
  }
});

// POST /patients/:id/activities — log an Activity (e.g. a scheduled meeting)
// against a Patient. The Inbox "Calendar Sync" modal lets an owner pick a
// patient (not just a generic Contact) and schedule a meeting; the Activity
// timeline is keyed on Contact.id, so we ensure the Patient is linked to a
// Contact (creating + linking one from the patient's details on first use)
// and write the Activity against that contactId. Mirrors the generic
// POST /api/contacts/:id/activities handler so patient + contact meetings
// land in the same activity stream.
router.post("/patients/:id/activities", phiWriteGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.id);
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    // The Activity / first-response timeline is Contact-scoped, and Contact
    // requires a non-null email (@@unique([email, tenantId])). A patient with
    // no email can't be linked, so reject rather than fabricate a placeholder.
    let contactId = patient.contactId;
    if (!contactId) {
      if (!patient.email) {
        return res.status(400).json({
          error: "Patient has no email; cannot associate a meeting",
          code: "PATIENT_NO_EMAIL",
        });
      }
      // Reuse an existing same-email contact in this tenant if present
      // (respects the email-per-tenant uniqueness), else create one.
      const existingContact = await prisma.contact.findFirst({
        where: { email: patient.email, tenantId: req.user.tenantId },
        select: { id: true },
      });
      const contact =
        existingContact ||
        (await prisma.contact.create({
          data: {
            name: patient.name,
            email: patient.email,
            phone: patient.phone || null,
            status: "Customer",
            source: patient.source || "wellness-patient",
            tenantId: req.user.tenantId,
          },
        }));
      contactId = contact.id;
      // Link the patient back to the contact so future activities reuse it.
      await prisma.patient.update({
        where: { id: patient.id },
        data: { contactId },
      });
    }

    const activity = await prisma.activity.create({
      data: {
        ...req.body,
        contactId,
        userId: req.user ? req.user.userId : null,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(activity);
  } catch (e) {
    console.error("[wellness] create patient activity error:", e.message);
    res.status(500).json({ error: "Failed to create patient activity" });
  }
});

// GET /patients/:id/prescriptions — Rx for a specific patient
router.get("/patients/:id/prescriptions", phiReadGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.id);
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
      select: { id: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const items = await prisma.prescription.findMany({
      where: tenantWhere(req, { patientId }),
      orderBy: { createdAt: "desc" },
      include: {
        patient: { select: { id: true, name: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    // #534 (PERF-1): fire-and-forget — see PATIENT_LIST_READ above.
    writeAudit(
      "Patient",
      "PATIENT_RX_READ",
      patientId,
      req.user.userId,
      req.user.tenantId,
      {
        patientId,
        rxCount: items.length,
      },
    ).catch((auditErr) => {
      console.warn(
        "[wellness] audit PATIENT_RX_READ failed:",
        auditErr.message,
      );
    });
    res.json(items.map(normalizePrescriptionDrugs));
  } catch (e) {
    console.error("[wellness] list patient prescriptions error:", e.message);
    res.status(500).json({ error: "Failed to list patient prescriptions" });
  }
});

// GET /patients/:id/consents — signed consent forms for a specific patient
router.get("/patients/:id/consents", phiReadGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.id);
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
      select: { id: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const items = await prisma.consentForm.findMany({
      where: tenantWhere(req, { patientId }),
      orderBy: { signedAt: "desc" },
      select: {
        id: true,
        templateName: true,
        signedAt: true,
        patientId: true,
        serviceId: true,
        hasPdfBlob: true,
        patient: { select: { id: true, name: true } },
        service: { select: { id: true, name: true } },
        // EXCLUDED: signatureSvg, contentSnapshot, signedPdfBlob
      },
    });
    // #534 (PERF-1): fire-and-forget — see PATIENT_LIST_READ above.
    writeAudit(
      "Patient",
      "PATIENT_CONSENTS_READ",
      patientId,
      req.user.userId,
      req.user.tenantId,
      {
        patientId,
        consentCount: items.length,
      },
    ).catch((auditErr) => {
      console.warn(
        "[wellness] audit PATIENT_CONSENTS_READ failed:",
        auditErr.message,
      );
    });
    res.json(items);
  } catch (e) {
    console.error("[wellness] list patient consents error:", e.message);
    res.status(500).json({ error: "Failed to list patient consents" });
  }
});

// GET /patients/:id/treatment-plans — treatment plans for a specific patient
router.get("/patients/:id/treatment-plans", phiReadGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.id);
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
      select: { id: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const plans = await prisma.treatmentPlan.findMany({
      where: tenantWhere(req, { patientId }),
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true, category: true } },
      },
      orderBy: { startedAt: "desc" },
    });
    // #534 (PERF-1): fire-and-forget — see PATIENT_LIST_READ above.
    writeAudit(
      "Patient",
      "PATIENT_TREATMENTS_READ",
      patientId,
      req.user.userId,
      req.user.tenantId,
      {
        patientId,
        planCount: plans.length,
      },
    ).catch((auditErr) => {
      console.warn(
        "[wellness] audit PATIENT_TREATMENTS_READ failed:",
        auditErr.message,
      );
    });
    res.json(plans);
  } catch (e) {
    console.error("[wellness] list patient treatment plans error:", e.message);
    res.status(500).json({ error: "Failed to list patient treatment plans" });
  }
});

// #108: a phone is optional, but if supplied must contain 10–15 digits after
// stripping formatting (+, -, spaces, parens). Pre-fix the field accepted any
// text like "abc123notaphone" which then broke dialer / WhatsApp integration.
// #205: alphanumeric phones like "90361a46074" used to slip through because
// we only counted digits. Now we also require the input to contain ONLY
// phone-shaped characters (digits, +, spaces, dashes, parens). Letters
// reject outright.
function isValidPhoneOrEmpty(p) {
  if (p == null || p === "") return true;
  if (typeof p !== "string") return false;
  if (!/^[0-9+\-\s()]+$/.test(p)) return false;
  const digits = p.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

const {
  ensureEmail,
  ensureDob,
  ensureVisitDate,
  ensureEnum,
  ensureStringLength,
  httpFromPrismaError,
} = require("../lib/validators");
const sanitizeHtml = require("sanitize-html");

// #213 / #187: defence-in-depth XSS scrub for free-text patient fields.
// Strips ALL HTML markup (no whitelist) while preserving the inner text so
// "5 < 6 mg" saves cleanly as "5  6 mg".
//
// #187 fix: sanitize-html's default text filter HTML-encodes `&` → `&amp;`
// when serialising back, which corrupted ordinary input ("A & B" stored as
// "A &amp; B" and then displayed literally everywhere we render outside
// React's auto-escape — PDFs, SMS, patient portal). Storage is raw text;
// entity encoding is a render-time concern handled by React. Override the
// text filter to decode the four entities the library re-encodes so the
// stored value matches what the user typed (minus the stripped tags).
const ENTITY_DECODE_RE = /&(amp|lt|gt|quot|#x27|#39);/g;
const ENTITY_DECODE_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#x27": "'",
  "#39": "'",
};
function decodeBasicEntities(text) {
  return text.replace(ENTITY_DECODE_RE, (_, e) => ENTITY_DECODE_MAP[e] || _);
}
function scrubPlainText(value) {
  if (value == null) return value;
  if (typeof value !== "string") return value;
  // allowedTags=[] + allowedAttributes={} + disallowedTagsMode='discard' →
  // entire tag is dropped (text content kept). textFilter undoes the
  // library's default `&` → `&amp;` encoding so storage stays raw.
  let scrubbed = sanitizeHtml(value, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: "discard",
    textFilter: (text) => decodeBasicEntities(text),
  });
  // #538 (PT-06) hardening: sanitize-html strips COMPLETE tags but leaves
  // residual single `<` / `>` characters from unclosed/malformed shapes
  // (e.g. `Mr. <Smith` or `Smith>` — neither parses as a tag, so the
  // library passes them through). The pen-test flagged this as
  // inconsistent: callers couldn't predict whether their input would be
  // stored verbatim or mutated. Strip ALL residual angle brackets so the
  // post-scrub contract is "no `<` or `>` ever survives", regardless of
  // whether the input was a real tag or just stray punctuation.
  scrubbed = scrubbed.replace(/[<>]/g, "");
  return scrubbed;
}

// #159 #160 #165 #170 #178: shared validation for Patient create + update.
// #213: also mutates body.name / body.notes / body.allergies in place to
// strip HTML so the route persists the sanitised value (see callers below).
function validatePatientInput(body, { isUpdate = false } = {}) {
  // #220: cap at 191 to match utf8mb4 VARCHAR(191) DB column limit. The
  // earlier 200 cap let names through that the DB then rejected with 500.
  const nameErr = ensureStringLength(body.name, {
    max: 191,
    field: "name",
    required: !isUpdate,
  });
  if (nameErr) return nameErr;
  // #538 (PT-06): control characters NEVER legitimately appear in a name
  // (NUL, BEL, vertical-tab, DEL, etc.) — these are usually injection
  // attempts (template-engine bypass, log-line injection, terminal
  // sequences). Reject pre-scrub so the response is "your input is
  // invalid", not silent mutation. Tag-shaped HTML stays as silent-scrub
  // (preserves the long-standing #213 contract + the explicit "scrub is
  // silent" e2e contract test).
  // eslint-disable-next-line no-control-regex
  if (body.name != null && /[\x00-\x1F\x7F]/.test(String(body.name))) {
    return {
      status: 400,
      error: "name contains invalid control characters",
      code: "INVALID_NAME",
    };
  }
  // #213: scrub HTML from free-text PHI fields. Strips ALL tags (no whitelist)
  // — patient names + notes never legitimately contain markup. Mutate the
  // body so the route's prisma.create/update sees the sanitised string.
  if (body.name != null) body.name = scrubPlainText(body.name);
  if (body.notes != null) body.notes = scrubPlainText(body.notes);
  if (body.allergies != null) body.allergies = scrubPlainText(body.allergies);
  // After scrub, re-check the name still has length (a payload that was
  // 100% HTML — e.g. `<img onerror=…>` — collapses to "" and would silently
  // save as a blank name otherwise). Keep this AFTER sanitisation so the
  // 400 reflects the post-scrub state the DB will see.
  if (!isUpdate && (body.name == null || String(body.name).trim() === "")) {
    return { status: 400, error: "name is required", code: "NAME_REQUIRED" };
  }
  // #237 (kept as belt-and-braces): reject any residual JS-shaped payload.
  // sanitize-html already strips tags but it does NOT block raw strings like
  // "javascript:foo" or "onerror=…" sitting in plain text — those are still
  // a phishing/social-engineering vector in printed receipts.
  if (body.name != null && /onerror\s*=|javascript:/i.test(String(body.name))) {
    return {
      status: 400,
      error: "name contains forbidden content",
      code: "INVALID_NAME",
    };
  }
  const emailErr = ensureEmail(body.email);
  if (emailErr) return emailErr;
  // #536 (PT-04): on create, phone is REQUIRED — the SPA marks it as
  // required + downstream flows (SMS reminders, calendar T-24h/T-1h pings,
  // dedup-by-normalizedPhone) silently no-op for phoneless rows. The
  // backend was previously accepting null/omit silently — UI/API contract
  // drift. On update (PUT), phone stays optional (don't force users to
  // re-type it on every edit). isValidPhoneOrEmpty's "empty is OK" return
  // is what we use on update; required-check fires only on create.
  if (!isUpdate && (body.phone == null || String(body.phone).trim() === "")) {
    return { status: 400, error: "phone is required", code: "PHONE_REQUIRED" };
  }
  if (!isValidPhoneOrEmpty(body.phone)) {
    return {
      status: 400,
      error: "phone must contain 10–15 digits",
      code: "INVALID_PHONE",
    };
  }
  const dobErr = ensureDob(body.dob);
  if (dobErr) return dobErr;
  return null;
}

// #401: Prisma surfaces the unique-constraint target differently per
// connector — on MySQL `e.meta.target` is the constraint NAME (string,
// e.g. "patient_tenant_normalized_phone_unique"), on Postgres it's the
// column-name array (["tenantId","normalizedPhone"]). Match either so
// the route correctly translates P2002 to DUPLICATE_PHONE on both DBs.
function isNormalizedPhoneTarget(target) {
  if (Array.isArray(target)) return target.includes("normalizedPhone");
  if (typeof target === "string")
    return /normalized.?phone|patient_tenant_normalized_phone/i.test(target);
  return false;
}

const ALLOWED_VISIT_STATUSES = new Set([
  "booked",
  "arrived",
  "in-treatment",
  "completed",
  "no-show",
  "cancelled",
]);

// #197: visit status state machine. Terminal statuses (completed, cancelled,
// no-show) are not freely re-openable from a PUT — re-opening requires an
// explicit /reopen endpoint (TODO if needed). The matrix below allows the
// natural forward progression and a few corrective backward transitions
// (e.g. accidentally marking arrived → back to booked).
const VISIT_TRANSITIONS = {
  booked: new Set([
    "booked",
    "arrived",
    "in-treatment",
    "completed",
    "no-show",
    "cancelled",
  ]),
  arrived: new Set([
    "arrived",
    "booked",
    "in-treatment",
    "completed",
    "no-show",
    "cancelled",
  ]),
  "in-treatment": new Set([
    "in-treatment",
    "arrived",
    "completed",
    "cancelled",
  ]),
  completed: new Set(["completed"]), // terminal
  "no-show": new Set(["no-show", "booked"]), // allow rebook
  cancelled: new Set(["cancelled"]), // terminal
};

router.post("/patients", phiWriteGate, async (req, res) => {
  try {
    // #213: validate FIRST so validatePatientInput can scrub HTML on body.name
    // / body.notes / body.allergies in place, then destructure the sanitised
    // values for persistence. Pre-fix the destructure happened before the
    // validator and the route saved the raw `<img onerror=…>` payload.
    const inputErr = validatePatientInput(req.body, { isUpdate: false });
    if (inputErr) return res.status(inputErr.status).json(inputErr);
    const {
      name,
      email,
      phone,
      dob,
      gender,
      bloodGroup,
      allergies,
      notes,
      source,
      contactId,
    } = req.body;
    // S100 — structured-intake whitelist for firstName + lastName.
    // S62 added the Patient.firstName + Patient.lastName columns (additive-
    // nullable). S96 surfaced them in the slim list projection. S97 wired
    // the create-customer modal to send them in POST/PUT bodies. But the
    // route handlers (this file, lines ~2063 POST + ~2210 PUT) did NOT
    // whitelist the fields — they were silently dropped at the destructure
    // boundary, so every new row landed with both columns null despite the
    // modal sending the data. This closes the S62 → S96 → S97 chain.
    //
    // Validation: each is OPTIONAL (some legal-name cultures have a single
    // name, so lastName especially must be optional). When provided, must
    // be a non-empty string ≤80 chars. Empty string → null (don't persist
    // blank-string columns; aligns with how `name` is normalised below).
    // Reject 400 INVALID_NAME_FIELD on length / type violations so the SPA
    // surfaces the error before the user hits "save".
    function normaliseStructuredName(raw, fieldLabel) {
      if (raw === undefined || raw === null) return { value: null, error: null };
      if (typeof raw !== "string") {
        return {
          value: null,
          error: {
            status: 400,
            error: `${fieldLabel} must be a string`,
            code: "INVALID_NAME_FIELD",
          },
        };
      }
      const trimmed = raw.trim();
      if (trimmed === "") return { value: null, error: null };
      if (trimmed.length > 80) {
        return {
          value: null,
          error: {
            status: 400,
            error: `${fieldLabel} must be 80 characters or fewer`,
            code: "INVALID_NAME_FIELD",
          },
        };
      }
      return { value: trimmed, error: null };
    }
    const firstNameResult = normaliseStructuredName(req.body.firstName, "firstName");
    if (firstNameResult.error) return res.status(firstNameResult.error.status).json(firstNameResult.error);
    const lastNameResult = normaliseStructuredName(req.body.lastName, "lastName");
    if (lastNameResult.error) return res.status(lastNameResult.error.status).json(lastNameResult.error);
    const firstName = firstNameResult.value;
    const lastName = lastNameResult.value;

    // New CRM-create-customer fields (taxType, instagramHandle, anniversary).
    // All optional; validated lightly here because validatePatientInput
    // only knows the legacy field set.
    const rawTaxType =
      typeof req.body.taxType === "string"
        ? req.body.taxType.trim().toLowerCase()
        : null;
    const taxType =
      rawTaxType === "individual" || rawTaxType === "business"
        ? rawTaxType
        : null;
    const instagramHandleRaw =
      typeof req.body.instagramHandle === "string"
        ? req.body.instagramHandle.trim()
        : null;
    const instagramHandle =
      instagramHandleRaw && instagramHandleRaw.length <= 80
        ? instagramHandleRaw
        : null;
    const anniversaryRaw = req.body.anniversary;
    let anniversary = null;
    if (anniversaryRaw) {
      const d = new Date(anniversaryRaw);
      if (!Number.isNaN(d.getTime())) anniversary = d;
    }
    // #337: persist the trimmed name. validatePatientInput's ensureStringLength
    // now rejects whitespace-only names; this normalises the saved value so
    // the Patients list, search index, prescriptions, and SMS templates all
    // see the clean form.
    const normalisedName = typeof name === "string" ? name.trim() : name;
    // #401: compute normalizedPhone for the @@unique(tenantId,
    // normalizedPhone) gate. Reuses the existing helper so dedup
    // semantics match contacts + marketplace leads.
    // #595: canonicalise the stored display `phone` to E.164
    // (`+919876543210`). Auto-dialer / SMS / WhatsApp keys all
    // require E.164; falling back to the raw value on un-formattable
    // input keeps non-IN demo data un-broken.
    const { normalizePhone, toE164 } = require("../utils/deduplication");
    const normalizedPhone = phone ? normalizePhone(phone) : null;
    const e164Phone = phone ? toE164(phone) || phone : null;
    const patient = await prisma.patient.create({
      data: {
        name: normalisedName,
        // S100 — structured intake additive to canonical `name`. Existing
        // clients that send only `name` continue to work unchanged (both
        // columns stay null); S97-modal clients populate both.
        firstName,
        lastName,
        email,
        phone: e164Phone,
        normalizedPhone,
        dob: dob ? new Date(dob) : null,
        gender,
        bloodGroup,
        allergies,
        notes,
        source,
        contactId: contactId ? parseInt(contactId) : null,
        tenantId: req.user.tenantId,
        anniversary,
        taxType,
        instagramHandle,
      },
    });

    // Agent D: when a patient is created with source=referral, link the matching
    // pending Referral row by phone (last-10-digit match) and advance its status.
    if (source === "referral" && phone) {
      try {
        const last10 = String(phone).replace(/\D/g, "").slice(-10);
        if (last10.length === 10) {
          const pending = await prisma.referral.findFirst({
            where: {
              tenantId: req.user.tenantId,
              status: "pending",
              referredPhone: { endsWith: last10 },
            },
            orderBy: { createdAt: "desc" },
          });
          if (pending) {
            await prisma.referral.update({
              where: { id: pending.id },
              data: { referredPatientId: patient.id, status: "signed_up" },
            });
          }
        }
      } catch (refErr) {
        console.error("[wellness] referral auto-link error:", refErr.message);
      }
    }

    // #179: audit Patient creation. Don't log raw email/phone (PII) — record
    // entityId + minimal metadata; the row itself can be inspected by admins.
    await writeAudit(
      "Patient",
      "CREATE",
      patient.id,
      req.user.userId,
      req.user.tenantId,
      {
        source: patient.source || null,
        hasEmail: !!patient.email,
        hasPhone: !!patient.phone,
      },
    );

    res.status(201).json(patient);
  } catch (e) {
    console.error("[wellness] create patient error:", e.message);
    // #401: specific 409 for the (tenantId, normalizedPhone) unique
    // constraint. Surfaced to the UI as `DUPLICATE_PHONE` so the form
    // can show "A patient with this phone already exists" instead of
    // the generic UNIQUE_CONSTRAINT path. isNormalizedPhoneTarget()
    // handles the MySQL-string vs. Postgres-array shape difference.
    if (e && e.code === "P2002" && isNormalizedPhoneTarget(e.meta?.target)) {
      return res.status(409).json({
        error: "A patient with this phone already exists in your tenant",
        code: "DUPLICATE_PHONE",
      });
    }
    // #165: ultra-long names / FK misses / decimal overflow now return 400
    // with the actual reason instead of "Failed to create patient" 500s.
    const mapped = httpFromPrismaError(e);
    if (mapped) return res.status(mapped.status).json(mapped);
    res.status(500).json({ error: "Failed to create patient" });
  }
});

router.put("/patients/:id", phiWriteGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.patient.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!existing) return res.status(404).json({ error: "Patient not found" });
    // #178: full validation on update mirrors create — phone/email/dob all checked.
    const inputErr = validatePatientInput(req.body, { isUpdate: true });
    if (inputErr) return res.status(inputErr.status).json(inputErr);

    const data = {};
    const allowed = [
      "name",
      "email",
      "phone",
      "gender",
      "bloodGroup",
      "allergies",
      "notes",
      "source",
      "photoUrl",
    ];
    for (const k of allowed)
      if (req.body[k] !== undefined) data[k] = req.body[k];
    if (req.body.dob !== undefined)
      data.dob = req.body.dob ? new Date(req.body.dob) : null;
    // S100 — structured firstName + lastName whitelist (PUT). Mirrors POST
    // semantics: ≤80-char string, empty → null. Explicit null on either
    // field CLEARS that column on the row (this is the inline-edit /
    // form-clear path; an admin editing a row may legitimately blank the
    // last name on a single-name patient). When the body omits the key
    // entirely, the field stays unchanged.
    for (const fld of ["firstName", "lastName"]) {
      if (req.body[fld] === undefined) continue;
      const raw = req.body[fld];
      if (raw === null) {
        data[fld] = null;
        continue;
      }
      if (typeof raw !== "string") {
        return res.status(400).json({
          error: `${fld} must be a string`,
          code: "INVALID_NAME_FIELD",
        });
      }
      const trimmed = raw.trim();
      if (trimmed === "") {
        data[fld] = null;
        continue;
      }
      if (trimmed.length > 80) {
        return res.status(400).json({
          error: `${fld} must be 80 characters or fewer`,
          code: "INVALID_NAME_FIELD",
        });
      }
      data[fld] = trimmed;
    }
    // New customer-create-modal fields. Same enum-clamp / length checks
    // as the POST handler; anniversary parses YYYY-MM-DD or ISO.
    if (req.body.taxType !== undefined) {
      const raw =
        typeof req.body.taxType === "string"
          ? req.body.taxType.trim().toLowerCase()
          : null;
      data.taxType = raw === "individual" || raw === "business" ? raw : null;
    }
    if (req.body.instagramHandle !== undefined) {
      const raw =
        typeof req.body.instagramHandle === "string"
          ? req.body.instagramHandle.trim()
          : null;
      data.instagramHandle = raw && raw.length <= 80 ? raw : null;
    }
    if (req.body.anniversary !== undefined) {
      if (req.body.anniversary) {
        const d = new Date(req.body.anniversary);
        data.anniversary = Number.isNaN(d.getTime()) ? null : d;
      } else {
        data.anniversary = null;
      }
    }

    // #401: keep normalizedPhone in sync with phone on every PUT that
    // touches phone. Without this, an edit-phone flow would leave the
    // dedup gate's index pointing at the OLD phone — second create
    // attempt with the new phone would slip past the constraint.
    // #595: also canonicalise the stored display value to E.164.
    if (req.body.phone !== undefined) {
      const { normalizePhone, toE164 } = require("../utils/deduplication");
      data.normalizedPhone = req.body.phone
        ? normalizePhone(req.body.phone)
        : null;
      data.phone = req.body.phone
        ? toE164(req.body.phone) || req.body.phone
        : null;
    }

    const updated = await prisma.patient.update({ where: { id }, data });
    // #179: audit only the keys that changed. PII (email/phone) is recorded
    // by name only — the actual values are not stored in the audit blob to
    // limit exposure if audit logs leak.
    const changes = diffFields(existing, updated, Object.keys(data));
    const safeKeys = Object.keys(changes).filter(
      (k) => !["email", "phone"].includes(k),
    );
    const piiTouched = Object.keys(changes).filter((k) =>
      ["email", "phone"].includes(k),
    );
    if (safeKeys.length > 0 || piiTouched.length > 0) {
      const safeChanges = {};
      for (const k of safeKeys) safeChanges[k] = changes[k];
      await writeAudit(
        "Patient",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.user.tenantId,
        {
          changedFields: safeChanges,
          piiFieldsTouched: piiTouched,
        },
      );
    }
    res.json(updated);
  } catch (e) {
    console.error("[wellness] update patient error:", e.message);
    // #401: same DUPLICATE_PHONE 409 as create — happens when an edit
    // would collide with another patient's phone in the same tenant.
    if (e && e.code === "P2002" && isNormalizedPhoneTarget(e.meta?.target)) {
      return res.status(409).json({
        error: "Another patient in your tenant already has this phone",
        code: "DUPLICATE_PHONE",
      });
    }
    // #168 #165: same validation-error → 400 mapping as create.
    const mapped = httpFromPrismaError(e);
    if (mapped) return res.status(mapped.status).json(mapped);
    res.status(500).json({ error: "Failed to update patient" });
  }
});

// #539 (PT-02): DELETE /patients/:id was missing — pen-test reported HTML 404
// on a route the demo-monitor scrub script + GDPR DSAR flow both want. This
// is admin-only because deleting clinical records has compliance + legal
// weight. Hard-delete (no soft-delete column on Patient yet); if the patient
// has any FK-bound children (visits/prescriptions/consents/treatment-plans/
// loyalty/referrals), Prisma's Restrict policy throws P2003 and we surface
// a 409 telling the caller they need to clear children first OR file a
// GDPR /export → /retention request which handles the cascade properly.
// Soft-delete semantics + child-detach are a future migration (#527 PHI
// scoping arc).
router.delete("/patients/:id", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) {
      return res
        .status(400)
        .json({ error: "Invalid patient id", code: "INVALID_ID" });
    }
    const existing = await prisma.patient.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!existing) return res.status(404).json({ error: "Patient not found" });
    // #628 — soft-delete: set deletedAt instead of cascade-orphaning
    // visits/Rx/consents. Already-soft-deleted rows return 409.
    if (existing.deletedAt) {
      return res.status(409).json({
        error: "Patient is already soft-deleted",
        code: "PATIENT_ALREADY_DELETED",
      });
    }

    const updated = await prisma.patient.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    // #179 audit pattern — patient name only, no email/phone PII in the blob.
    await writeAudit(
      "Patient",
      "SOFT_DELETE",
      id,
      req.user.userId,
      req.user.tenantId,
      {
        patientName: existing.name,
        deletedAt: updated.deletedAt,
      },
    );

    res.json({ success: true, id, deletedAt: updated.deletedAt });
  } catch (e) {
    if (e && e.code === "P2025") {
      return res.status(404).json({ error: "Patient not found" });
    }
    console.error("[wellness] delete patient error:", e.message);
    res.status(500).json({ error: "Failed to delete patient" });
  }
});

// #628 — Restore a soft-deleted patient. Admin-only; clears deletedAt so
// the row reappears in default lists. No-op (200 idempotent) if already
// restored. Pairs with the soft-delete handler above; hard-purge runs
// through the /privacy retention engine (#576) after the tombstone window.
router.post(
  "/patients/:id/restore",
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (Number.isNaN(id)) {
        return res
          .status(400)
          .json({ error: "Invalid patient id", code: "INVALID_ID" });
      }
      const existing = await prisma.patient.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Patient not found" });
      if (!existing.deletedAt) {
        return res.status(200).json({ success: true, id, idempotent: true });
      }

      const updated = await prisma.patient.update({
        where: { id },
        data: { deletedAt: null },
      });

      await writeAudit(
        "Patient",
        "RESTORE",
        id,
        req.user.userId,
        req.user.tenantId,
        {
          patientName: existing.name,
          restoredFrom: existing.deletedAt,
        },
      );

      res.json({ success: true, id, patient: updated });
    } catch (e) {
      if (e && e.code === "P2025") {
        return res.status(404).json({ error: "Patient not found" });
      }
      console.error("[wellness] restore patient error:", e.message);
      res.status(500).json({ error: "Failed to restore patient" });
    }
  },
);

// ── Visits ─────────────────────────────────────────────────────────

// #280: Visits are the source for the doctor calendar at /wellness/calendar.
// Stylists / helpers are non-clinical staff and must NOT see clinical PHI:
// patient names + service names like "Acne Vulgaris Treatment" or "Hair
// Restoration". Scope their list to:
//   1. visits whose service category is non-clinical (salon-style work), AND
//   2. visits assigned to themselves (their own column).
// Doctors / professionals / admins / managers / telecallers keep full view.
const CLINICAL_SERVICE_CATEGORIES = [
  "hair-transplant",
  "hair-restoration",
  "hair-concern",
  "skin",
  "skin-surgery",
  "dermatology",
  "aesthetics",
  "body-contouring",
  "ayurveda",
  "slimming",
];

router.get("/visits", phiReadGate, async (req, res) => {
  try {
    const {
      patientId,
      doctorId,
      status,
      from,
      to,
      limit = 100,
      offset = 0,
    } = req.query;
    const where = tenantWhere(req);
    if (patientId) where.patientId = parseInt(patientId);
    if (doctorId) where.doctorId = parseInt(doctorId);
    if (status) where.status = status;
    if (from || to) {
      where.visitDate = {};
      if (from) where.visitDate.gte = new Date(from);
      if (to) where.visitDate.lte = new Date(to);
    }

    // #280: professional/helper PHI scope. Bypass for ADMIN/MANAGER (org oversight).
    // "professional" is the canonical wellnessRole post-#214; "stylist" kept
    // for back-compat with older tokens / hypothetical future seeds.
    const wRole = req.user?.wellnessRole;
    const isOrgRole =
      req.user?.role === "ADMIN" || req.user?.role === "MANAGER";
    if (
      !isOrgRole &&
      (wRole === "professional" || wRole === "stylist" || wRole === "helper")
    ) {
      where.OR = [
        { doctorId: req.user.userId }, // own column
        {
          service: {
            is: {
              OR: [
                { category: null },
                { category: { notIn: CLINICAL_SERVICE_CATEGORIES } },
              ],
            },
          },
        },
      ];
    }
    // #324: doctor calendar PHI scope. A doctor opening /wellness/calendar
    // was seeing every other practitioner's column (16 doctors + professionals)
    // — that's other clinicians' patient lists, prescriptions, and consents
    // surfaced via the visit row. Issue body explicitly asks for "Doctor
    // should see Own calendar column, own patients' Rx + consent". Scope
    // their visit feed to visits they're the assigned doctor on. ADMIN /
    // MANAGER keep org-wide oversight, and the explicit ?doctorId= query
    // path (used by the per-doctor profile view) is preserved.
    if (!isOrgRole && wRole === "doctor") {
      where.doctorId = req.user.userId;
    }

    // #920 slice S42: opt-in slim shape via `?fields=summary`. Drops the
    // patient/service/doctor INCLUDES (they ship PHI: patient.name +
    // patient.phone, doctor.name). Slim shape ships only FKs the picker
    // can hop on (patientId, doctorId, serviceId, locationId).
    const wantFullShape = isFullShape(req.query);
    const visitFindArgs = {
      where,
      take: Math.min(parseInt(limit, 10) || 100, 500),
      skip: parseInt(offset, 10) || 0,
      orderBy: { visitDate: "desc" },
    };
    if (wantFullShape) {
      visitFindArgs.include = {
        patient: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true, category: true } },
        doctor: { select: { id: true, name: true } },
      };
    } else {
      visitFindArgs.select = listProjection("Visit", false);
    }
    const visits = await prisma.visit.findMany(visitFindArgs);
    // PRD §11 / T2.2: staff-side cross-patient visit list is a PHI read
    // (response includes patient name + phone on full path). One audit row
    // per request, with the filter params and result count — never the row
    // contents. #534 (PERF-1): fire-and-forget — see PATIENT_LIST_READ above.
    //
    // S42 audit-coordination: VISIT_LIST_READ fires on BOTH paths (the
    // regulatory "operator hit list endpoint" record); the `shape` field
    // distinguishes full vs slim for reviewer queries.
    writeAudit(
      "Visit",
      "VISIT_LIST_READ",
      null,
      req.user.userId,
      req.user.tenantId,
      {
        count: visits.length,
        filters: {
          patientId: patientId ? parseInt(patientId) : null,
          doctorId: doctorId ? parseInt(doctorId) : null,
          status: status || null,
          from: from || null,
          to: to || null,
        },
        shape: wantFullShape ? "full" : "summary",
      },
    ).catch((auditErr) => {
      console.warn("[wellness] audit /visits list failed:", auditErr.message);
    });
    res.json(visits);
  } catch (e) {
    console.error("[wellness] list visits error:", e.message);
    res.status(500).json({ error: "Failed to list visits" });
  }
});

router.get("/visits/:id", phiReadGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const visit = await prisma.visit.findFirst({
      where: tenantWhere(req, { id }),
      include: {
        patient: true,
        service: true,
        doctor: { select: { id: true, name: true, email: true } },
        prescriptions: true,
        consumptions: true,
      },
    });
    if (!visit) return res.status(404).json({ error: "Visit not found" });
    // PRD §11: log clinical encounter reads. Don't store notes content —
    // record presence flags only so amendments can still be diffed against
    // the canonical Visit row, not against the audit blob.
    try {
      await writeAudit(
        "Visit",
        "VISIT_READ",
        visit.id,
        req.user.userId,
        req.user.tenantId,
        {
          visitId: visit.id,
          patientId: visit.patientId,
          hasNotes: Boolean(
            visit.notes && String(visit.notes).trim().length > 0,
          ),
          hasPhotos: Array.isArray(visit.photos)
            ? visit.photos.length > 0
            : Boolean(visit.photos && String(visit.photos).length > 2),
        },
      );
    } catch (auditErr) {
      console.warn("[wellness] audit VISIT_READ failed:", auditErr.message);
    }
    if (visit.prescriptions) {
      visit.prescriptions = visit.prescriptions.map(normalizePrescriptionDrugs);
    }
    res.json(visit);
  } catch (e) {
    console.error("[wellness] get visit error:", e.message);
    res.status(500).json({ error: "Failed to load visit" });
  }
});

router.post("/visits", phiWriteGate, async (req, res) => {
  try {
    // Wave 11 Agent GG: resourceId + locationId added to destructure for the booking gate below.
    const {
      patientId,
      serviceId,
      doctorId,
      visitDate,
      status,
      vitals,
      notes,
      amountCharged,
      treatmentPlanId,
      resourceId,
      locationId,
    } = req.body;
    if (!patientId)
      return res.status(400).json({ error: "patientId is required" });
    // #170: visitDate must be a valid date in [now-5y, now+1y]. Pre-fix the
    // route accepted year 1800 / 3000 (silent 201) and 500'd on bogus strings.
    if (visitDate !== undefined) {
      const dateErr = ensureVisitDate(visitDate);
      if (dateErr) return res.status(dateErr.status).json(dateErr);
    }
    // #170: status restricted to the documented enum (no more "COMPLETELY_BOGUS").
    if (status !== undefined && status !== null && status !== "") {
      const statusErr = ensureEnum(status, ALLOWED_VISIT_STATUSES, {
        field: "status",
        code: "STATUS_INVALID",
      });
      if (statusErr) return res.status(statusErr.status).json(statusErr);
    }
    // #109: a "completed" visit (the default the UI submits) must have a service
    // and doctor — anonymous "ghost visits" corrupt revenue/per-pro reports.
    // Booked/cancelled/no-show statuses can be partial since the visit hasn't happened.
    const isCompleted =
      !status || status === "completed" || status === "in-treatment";
    if (isCompleted && !serviceId)
      return res.status(400).json({
        error: "serviceId is required for a completed visit",
        code: "SERVICE_REQUIRED",
      });
    if (isCompleted && !doctorId)
      return res.status(400).json({
        error: "doctorId is required for a completed visit",
        code: "DOCTOR_REQUIRED",
      });
    // #109: amount must be non-negative — negative charges distort revenue analytics.
    if (
      amountCharged != null &&
      amountCharged !== "" &&
      Number(amountCharged) < 0
    ) {
      return res.status(400).json({
        error: "amountCharged must be 0 or greater",
        code: "AMOUNT_NEGATIVE",
      });
    }
    // #277: cap amountCharged at ₹50,00,000 (₹50L) to match the Service.basePrice
    // ceiling from #209. Without this, a visit can store ₹1e15 (one quadrillion)
    // and blow up Owner Dashboard's expectedRevenue tile to twenty trillion.
    if (
      amountCharged != null &&
      amountCharged !== "" &&
      Number(amountCharged) > 5_000_000
    ) {
      return res.status(400).json({
        error: "amountCharged exceeds the ₹50,00,000 per-visit cap",
        code: "AMOUNT_TOO_LARGE",
      });
    }

    // Doctors can only create visits for themselves unless they explicitly
    // hold the practitioner-assignment permission (or are admin/manager/
    // receptionist/telecaller). This closes the "doctor books another doctor"
    // loophole on the New Visit / empty-slot flow.
    const requestedDoctorId = doctorId ? parseInt(doctorId, 10) : null;
    if (
      requestedDoctorId &&
      requestedDoctorId !== req.user.userId &&
      !(await canAssignPractitioner(req))
    ) {
      return res.status(403).json({
        error: "You do not have permission to assign this visit to another practitioner.",
        code: "ASSIGN_PRACTITIONER_DENIED",
      });
    }

    // Wave 11 Agent GG: 4-class booking conflict gate.
    const slotCheck = await assertVisitSlotAvailable({
      tenantId: req.user.tenantId,
      visitDate: visitDate ? parseTenantDateInput(visitDate) : new Date(),
      doctorId: doctorId ? parseInt(doctorId) : null,
      resourceId: resourceId ? parseInt(resourceId) : null,
      locationId: locationId ? parseInt(locationId) : null,
    });
    if (!slotCheck.ok) {
      return res.status(409).json({
        error: slotCheck.detail,
        code: slotCheck.code,
        detail: slotCheck.detail,
      });
    }

    const visit = await prisma.visit.create({
      data: {
        patientId: parseInt(patientId),
        serviceId: serviceId ? parseInt(serviceId) : null,
        doctorId: doctorId ? parseInt(doctorId) : null,
        resourceId: resourceId ? parseInt(resourceId) : null,
        locationId: locationId ? parseInt(locationId) : null,
        treatmentPlanId: treatmentPlanId ? parseInt(treatmentPlanId) : null,
        // #313: route datetime-local form input ("2026-05-15T10:30") through
        // the tenant-TZ parser; full ISO timestamps stay on the native ctor.
        visitDate: visitDate ? parseTenantDateInput(visitDate) : new Date(),
        status: status || "completed",
        vitals: vitals
          ? typeof vitals === "object"
            ? JSON.stringify(vitals)
            : vitals
          : null,
        notes,
        amountCharged: amountCharged ? parseFloat(amountCharged) : null,
        tenantId: req.user.tenantId,
      },
    });

    // If linked to a treatment plan, increment completedSessions
    if (visit.treatmentPlanId && visit.status === "completed") {
      await prisma.treatmentPlan.update({
        where: { id: visit.treatmentPlanId },
        data: { completedSessions: { increment: 1 } },
      });
    }

    // Gap #22: auto-credit loyalty (10% of amountCharged, floored) on
    // completed visits. Idempotency via unique-per-visit ledger row keyed
    // by (visitId, type='earned'). Failures must not roll back the visit.
    await maybeAutoCreditLoyalty(visit, req.user.tenantId);

    // S94: denormalize Patient.lastVisitDate cache from the just-created
    // visit. Best-effort — a failure here MUST NOT abort the visit insert
    // (the source-of-truth Visit row exists; the cron/backfillLastVisitEngine
    // sweep will reconcile any drift on its next run). The column was added
    // by S62; population is THIS slice. Read path (S96 listProjection slim
    // Select) returns null until this hook lands, so this is the first write
    // path that surfaces it.
    try {
      await prisma.patient.update({
        where: { id: visit.patientId },
        data: { lastVisitDate: visit.visitDate },
      });
    } catch (denormErr) {
      console.error(
        "[wellness] lastVisitDate denorm-update failed",
        denormErr.message,
      );
    }

    // #616: emit wellness sequence triggers. visit.scheduled fires on every
    // create (covers booking-confirmation drips); visit.completed also fires
    // when a same-row create lands as status='completed' (the default). Failure
    // here MUST NOT fail the visit-create response.
    try {
      const { emitEvent } = require("../lib/eventBus");
      emitEvent(
        "visit.scheduled",
        {
          visitId: visit.id,
          patientId: visit.patientId,
          serviceId: visit.serviceId,
          doctorId: visit.doctorId,
          status: visit.status,
          visitDate: visit.visitDate,
        },
        req.user.tenantId,
        req.io,
      );
      if (visit.status === "completed") {
        emitEvent(
          "visit.completed",
          {
            visitId: visit.id,
            patientId: visit.patientId,
            serviceId: visit.serviceId,
            doctorId: visit.doctorId,
            amountCharged: visit.amountCharged,
          },
          req.user.tenantId,
          req.io,
        );
      }
    } catch (_e) {
      /* event bus optional */
    }

    // #179: audit Visit creation.
    await writeAudit(
      "Visit",
      "CREATE",
      visit.id,
      req.user.userId,
      req.user.tenantId,
      {
        patientId: visit.patientId,
        serviceId: visit.serviceId,
        doctorId: visit.doctorId,
        status: visit.status,
        visitDate: visit.visitDate,
        amountCharged: visit.amountCharged,
      },
    );

    res.status(201).json(visit);
  } catch (e) {
    console.error("[wellness] create visit error:", e.message);
    // #165: bad FK / overflow / null-on-required → 400 with the real reason.
    const mapped = httpFromPrismaError(e);
    if (mapped) return res.status(mapped.status).json(mapped);
    res.status(500).json({ error: "Failed to create visit" });
  }
});

// Staff-side endpoint to assign a doctor to a pending appointment (one
// where doctorId is null — typically a portal self-booking with "No
// preference — admin will assign"). Runs the same availability guards
// as the booking flow so the assignment can't create a conflict.
//
// Once applied, the visit moves out of the patient's "Pending
// Assignment" bucket and into "Upcoming" — the patient's MyBookings
// picks this up on its next focus/visibility refresh (no extra
// notification needed for Phase 1).
router.patch("/visits/:id/assign-doctor", phiWriteGate, async (req, res) => {
  try {
    if (!(await canAssignPractitioner(req))) {
      return res.status(403).json({
        error: "You do not have permission to assign practitioners.",
        code: "ASSIGN_PRACTITIONER_DENIED",
      });
    }
    const { visit } = await appointmentService.assignDoctor({
      tenantId: req.user.tenantId,
      visitId: req.params.id,
      doctorId: req.body.doctorId,
      actor: { type: "user", id: req.user.userId },
    });
    res.json({ success: true, visit });
  } catch (err) {
    if (err && err.name === "AppointmentError") {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    console.error("[wellness] assign doctor failed:", err.message);
    res.status(500).json({ error: "Failed to assign doctor" });
  }
});

router.put("/visits/:id", phiWriteGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.visit.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!existing) return res.status(404).json({ error: "Visit not found" });

    const data = {};
    // Agent B: added videoRoom (telehealth Jitsi room name)
    // Wave 11 Agent GG: added doctorId/resourceId/locationId for booking gate.
    const allowed = [
      "status",
      "vitals",
      "notes",
      "photosBefore",
      "photosAfter",
      "amountCharged",
      "videoRoom",
      "doctorId",
      "resourceId",
      "locationId",
    ];
    for (const k of allowed)
      if (req.body[k] !== undefined) data[k] = req.body[k];
    if (data.doctorId !== undefined)
      data.doctorId = data.doctorId ? parseInt(data.doctorId, 10) : null;
    // Doctors may edit their own visits (vitals, notes, status) but may not
    // reassign visits to other practitioners unless they hold the assignment
    // permission or an explicit assigner wellnessRole / admin-manager role.
    if (
      data.doctorId !== undefined &&
      data.doctorId !== existing.doctorId &&
      !(await canAssignPractitioner(req))
    ) {
      return res.status(403).json({
        error: "You do not have permission to reassign practitioners.",
        code: "ASSIGN_PRACTITIONER_DENIED",
      });
    }
    if (data.resourceId !== undefined)
      data.resourceId = data.resourceId ? parseInt(data.resourceId, 10) : null;
    if (data.locationId !== undefined)
      data.locationId = data.locationId ? parseInt(data.locationId, 10) : null;
    // #170 / #197 (PUT-side parity): visitDate must be in [now-5y, now+1y]
    // — same range as POST /visits. Pre-fix the PUT skipped ensureVisitDate
    // and silently accepted year=3001 / year=1800 (parseTenantDateInput
    // only sniffs format, not range), so a UI form-fill bug or scripted
    // caller could relocate a visit to the year 3000. Range-check FIRST,
    // then run the format sniffer.
    if (req.body.visitDate !== undefined) {
      const dateErr = ensureVisitDate(req.body.visitDate);
      if (dateErr) return res.status(dateErr.status).json(dateErr);
      data.visitDate = parseTenantDateInput(req.body.visitDate);
    }

    // #277: same per-visit cap as POST — reject overflow updates.
    if (data.amountCharged != null && data.amountCharged !== "") {
      const amt = Number(data.amountCharged);
      if (amt < 0)
        return res.status(400).json({
          error: "amountCharged must be 0 or greater",
          code: "AMOUNT_NEGATIVE",
        });
      if (amt > 5_000_000)
        return res.status(400).json({
          error: "amountCharged exceeds the ₹50,00,000 per-visit cap",
          code: "AMOUNT_TOO_LARGE",
        });
    }

    // #197: enforce status enum + transition matrix. A junk status like 'frog'
    // can no longer slip through, and terminal statuses (completed/cancelled)
    // cannot be silently regressed.
    if (data.status !== undefined) {
      if (!ALLOWED_VISIT_STATUSES.has(data.status)) {
        return res.status(400).json({
          error: `status must be one of: ${[...ALLOWED_VISIT_STATUSES].join(", ")}`,
          code: "INVALID_VISIT_STATUS",
        });
      }
      const allowedNext =
        VISIT_TRANSITIONS[existing.status] || ALLOWED_VISIT_STATUSES;
      if (!allowedNext.has(data.status)) {
        return res.status(422).json({
          error: `cannot transition visit from '${existing.status}' to '${data.status}'`,
          code: "INVALID_VISIT_TRANSITION",
        });
      }
    }

    // Wave 11 Agent GG: re-run gate when slot dimension changes.
    const slotMutated =
      data.visitDate !== undefined ||
      data.doctorId !== undefined ||
      data.resourceId !== undefined ||
      data.locationId !== undefined;
    if (slotMutated && data.status !== "cancelled") {
      const slotCheck = await assertVisitSlotAvailable({
        id,
        tenantId: req.user.tenantId,
        visitDate: data.visitDate ?? existing.visitDate,
        doctorId:
          data.doctorId !== undefined ? data.doctorId : existing.doctorId,
        resourceId:
          data.resourceId !== undefined ? data.resourceId : existing.resourceId,
        locationId:
          data.locationId !== undefined ? data.locationId : existing.locationId,
      });
      if (!slotCheck.ok) {
        return res.status(409).json({
          error: slotCheck.detail,
          code: slotCheck.code,
          detail: slotCheck.detail,
        });
      }
    }

    const updated = await prisma.visit.update({ where: { id }, data });

    // Gap #22: auto-credit loyalty when a visit is updated to 'completed'
    // with amountCharged > 0. Idempotent via single 'earned' ledger row per visit.
    await maybeAutoCreditLoyalty(updated, req.user.tenantId);

    // Agent B: when a visit transitions to "cancelled", auto-offer the slot
    // to the first matching waitlist entry (same serviceId, status=waiting).
    // Failures here MUST NOT fail the original update — log and continue.
    if (data.status === "cancelled" && existing.status !== "cancelled") {
      try {
        await offerWaitlistSlotForCancelledVisit(updated, req.user.tenantId);
      } catch (hookErr) {
        console.error(
          "[wellness] waitlist auto-offer hook failed:",
          hookErr.message,
        );
      }
    }

    // #616: emit visit.completed when this update transitions the row INTO
    // completed (not on a re-save of an already-completed visit). Failure
    // here MUST NOT fail the user-facing response.
    if (data.status === "completed" && existing.status !== "completed") {
      try {
        const { emitEvent } = require("../lib/eventBus");
        emitEvent(
          "visit.completed",
          {
            visitId: updated.id,
            patientId: updated.patientId,
            serviceId: updated.serviceId,
            doctorId: updated.doctorId,
            amountCharged: updated.amountCharged,
          },
          req.user.tenantId,
          req.io,
        );
      } catch (_e) {
        /* event bus optional */
      }
    }

    // Generate a hosted payment link when a visit transitions INTO completed
    // with a positive charge. The link is stored on the visit so the Log Visit
    // UI can render a "Copy" action. Uses the same tenant BYOK Razorpay keys
    // as the rest of the CRM; gateway issues are logged but do NOT fail the
    // clinical visit update.
    if (
      data.status === "completed" &&
      existing.status !== "completed" &&
      existing.paymentStatus !== "paid" &&
      Number(updated.amountCharged) > 0
    ) {
      try {
        const { getFrontendUrlFromRequest } = require("../lib/requestOrigin");
        const link = await generateVisitPaymentLink({
          visit: updated,
          tenantId: req.user.tenantId,
          baseUrl: getFrontendUrlFromRequest(req),
        });
        if (link.error) {
          console.error(
            "[wellness] visit payment-link generation failed:",
            link.error,
          );
        } else {
          const finalVisit = await prisma.visit.update({
            where: { id: updated.id },
            data: {
              paymentLinkUrl: link.url,
              paymentLinkGeneratedAt: new Date(),
            },
          });
          updated.paymentLinkUrl = finalVisit.paymentLinkUrl;
          updated.paymentLinkGeneratedAt = finalVisit.paymentLinkGeneratedAt;
        }
      } catch (hookErr) {
        console.error(
          "[wellness] visit payment-link hook failed:",
          hookErr.message,
        );
      }
    }

    // #179: audit visit update. Status transitions (booked → in-treatment →
    // completed → cancelled / no-show) are the highest-signal field; always
    // capture from/to explicitly when status changed.
    const changes = diffFields(existing, updated, Object.keys(data));
    if (Object.keys(changes).length > 0) {
      const action =
        changes.status && existing.status !== updated.status
          ? "STATUS_CHANGE"
          : "UPDATE";
      await writeAudit(
        "Visit",
        action,
        updated.id,
        req.user.userId,
        req.user.tenantId,
        {
          priorStatus: existing.status,
          newStatus: updated.status,
          changedFields: changes,
        },
      );
    }

    res.json(updated);
  } catch (e) {
    console.error("[wellness] update visit error:", e.message);
    // #168 #165: same as POST.
    const mapped = httpFromPrismaError(e);
    if (mapped) return res.status(mapped.status).json(mapped);
    res.status(500).json({ error: "Failed to update visit" });
  }
});

// Generate or regenerate a hosted Razorpay Payment Link for a completed
// wellness visit. Returns { url, gateway } on success; 404 if the visit is
// not completed/paid, 400 if it has no charge, and 502/503 for gateway
// failures. Uses the same tenant BYOK keys as the rest of the CRM.
router.post("/visits/:id/payment-link", phiWriteGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const visit = await prisma.visit.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!visit) return res.status(404).json({ error: "Visit not found" });
    if (visit.status !== "completed")
      return res.status(400).json({ error: "Visit is not completed", code: "VISIT_NOT_COMPLETED" });
    if (!Number(visit.amountCharged) || Number(visit.amountCharged) <= 0)
      return res.status(400).json({ error: "Visit has no charge", code: "VISIT_NO_CHARGE" });
    if (visit.paymentStatus === "paid")
      return res.status(400).json({ error: "Visit is already paid", code: "VISIT_ALREADY_PAID" });

    const { getFrontendUrlFromRequest } = require("../lib/requestOrigin");
    const link = await generateVisitPaymentLink({
      visit,
      tenantId: req.user.tenantId,
      baseUrl: getFrontendUrlFromRequest(req),
    });

    if (link.error)
      return res.status(502).json({ error: link.error, code: link.code });

    await prisma.visit.update({
      where: { id: visit.id },
      data: { paymentLinkUrl: link.url, paymentLinkGeneratedAt: new Date() },
    });

    res.json({ url: link.url, gateway: link.gateway, paymentId: link.paymentId });
  } catch (err) {
    console.error("[wellness] visit payment-link error:", err.message);
    res.status(500).json({ error: "Failed to generate payment link" });
  }
});

// ── Visit photos (before/after) ────────────────────────────────────
//
// #743 — photos are stored on the local filesystem and served under
// /api/wellness/visits/:id/photos/:filename (proxied to the backend by
// Nginx). The legacy /uploads/* path fell through to the SPA catch-all and
// returned text/html. Serving here stamps an explicit image Content-Type,
// guards against path traversal, tenant-scopes the read, and validates the
// upload mime. No S3 dependency — works in CI / any env without AWS creds.
const PHOTO_MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
function photoContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return PHOTO_MIME_BY_EXT[ext] || null;
}

router.get("/visits/:id/photos/:filename", phiReadGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const filename = req.params.filename || "";
    // Defense-in-depth path-traversal guard (diskStorage sanitises on write,
    // but a hand-crafted GET could try `..%2F../etc/passwd`).
    if (!/^[a-zA-Z0-9._-]+$/.test(filename) || filename.includes("..")) {
      return res
        .status(400)
        .json({ error: "invalid filename", code: "INVALID_FILENAME" });
    }
    const mime = photoContentType(filename);
    if (!mime) {
      return res
        .status(415)
        .json({ error: "unsupported image type", code: "UNSUPPORTED_MEDIA" });
    }
    // Tenant-scope: the visit must belong to the caller's tenant.
    const visit = await prisma.visit.findFirst({
      where: tenantWhere(req, { id }),
      select: { id: true },
    });
    if (!visit) return res.status(404).json({ error: "Visit not found" });

    const filePath = path.join(
      __dirname,
      "..",
      "uploads",
      "wellness",
      "visits",
      String(id),
      filename,
    );
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Photo not found" });
    }
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(filePath);
  } catch (e) {
    console.error("[wellness] photo serve error:", e.message);
    res.status(500).json({ error: "Photo serve failed" });
  }
});

router.post(
  "/visits/:id/photos",
  phiWriteGate,
  photoUpload.array("photos", 10),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const visit = await prisma.visit.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!visit) return res.status(404).json({ error: "Visit not found" });

      // #743 — reject non-image uploads at the API layer.
      const files = req.files || [];
      for (const f of files) {
        const mime = photoContentType(f.originalname || "");
        if (!mime) {
          return res.status(415).json({
            error:
              "photos must be image/jpeg, image/png, image/webp or image/gif",
            code: "UNSUPPORTED_MEDIA",
          });
        }
      }

      // S3-primary, local-FS fallback. When AWS creds are configured
      // (S3_BUCKET_NAME set) photos go to S3 and we store the S3 URL —
      // unchanged prod behaviour. When S3 isn't configured (CI / any env
      // without creds) we persist to the local filesystem and store the
      // Nginx-proxied /api/wellness/visits/:id/photos/:filename path (served
      // by the GET route above), so the feature never hard-depends on S3.
      const useS3 = !!S3_BUCKET_NAME;
      const added = [];
      for (const f of files) {
        if (useS3) {
          const url = await uploadImage(
            f.buffer,
            f.originalname,
            f.mimetype,
            `visits/${id}`,
          );
          added.push(url);
        } else {
          const dir = path.join(
            __dirname,
            "..",
            "uploads",
            "wellness",
            "visits",
            String(id),
          );
          fs.mkdirSync(dir, { recursive: true });
          const safe = `${Date.now()}-${(f.originalname || "photo").replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          fs.writeFileSync(path.join(dir, safe), f.buffer);
          added.push(`/api/wellness/visits/${id}/photos/${safe}`);
        }
      }

      const which = req.body.kind === "after" ? "photosAfter" : "photosBefore";
      const existing = visit[which] ? JSON.parse(visit[which]) : [];
      const merged = [...existing, ...added];

      const _updated = await prisma.visit.update({
        where: { id },
        data: { [which]: JSON.stringify(merged) },
      });
      res.status(201).json({ kind: which, urls: merged, added });
    } catch (e) {
      console.error("[wellness] photo upload error:", e.message);
      res.status(500).json({ error: "Photo upload failed" });
    }
  },
);

router.delete("/visits/:id/photos", phiWriteGate, async (req, res) => {
  // Body: { url, kind }
  try {
    const id = parseInt(req.params.id);
    const { url, kind = "before" } = req.body;
    const visit = await prisma.visit.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!visit) return res.status(404).json({ error: "Visit not found" });
    const field = kind === "after" ? "photosAfter" : "photosBefore";
    const existing = visit[field] ? JSON.parse(visit[field]) : [];
    const next = existing.filter((u) => u !== url);

    // Delete from S3 if it's an S3 URL
    if (url && url.includes(process.env.AWS_S3_URL || "s3")) {
      try {
        const fileKey = extractKeyFromUrl(url);
        if (fileKey) {
          await deleteFile(fileKey);
        }
      } catch (delErr) {
        console.warn("[wellness] S3 delete warning:", delErr.message);
      }
    }

    await prisma.visit.update({
      where: { id },
      data: { [field]: JSON.stringify(next) },
    });
    res.json({ ok: true, urls: next });
  } catch (_e) {
    res.status(500).json({ error: "Photo delete failed" });
  }
});

// ── Inventory consumption per visit ────────────────────────────────

router.get("/visits/:id/consumptions", phiReadGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const items = await prisma.serviceConsumption.findMany({
      where: tenantWhere(req, { visitId: id }),
      orderBy: { createdAt: "desc" },
    });
    // PRD §11 / T2.2: consumption items reveal what was administered during a
    // visit — clinical context tied to the patient. Audit per request.
    // #534 (PERF-1): fire-and-forget — see PATIENT_LIST_READ above.
    writeAudit(
      "Visit",
      "VISIT_CONSUMPTIONS_READ",
      id,
      req.user.userId,
      req.user.tenantId,
      {
        visitId: id,
        count: items.length,
      },
    ).catch((auditErr) => {
      console.warn(
        "[wellness] audit /visits/:id/consumptions failed:",
        auditErr.message,
      );
    });
    res.json(items);
  } catch (_e) {
    res.status(500).json({ error: "Failed to list consumption items" });
  }
});

router.post("/visits/:id/consumptions", phiWriteGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const visit = await prisma.visit.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!visit) return res.status(404).json({ error: "Visit not found" });

    const { productName, qty = 1, unitCost = 0, productId } = req.body;
    if (!productName)
      return res.status(400).json({ error: "productName required" });

    // #321: cap unitCost + qty + line total. P&L by Service was rendering
    // PRODUCT COST = ₹99,99,98,99,90,48,826 (~100 trillion) because a single
    // ServiceConsumption row carried an unbounded unitCost (likely a paise/
    // rupee unit-mismatch or a fat-fingered entry). Mirrors the ₹50L Visit
    // amountCharged cap from #277. ₹10L per unit is already absurd for any
    // clinic consumable; the line total is capped at ₹1Cr to match the
    // cleanup-script threshold in the output note.
    const qNum = parseInt(qty) || 1;
    const cNum = parseFloat(unitCost) || 0;
    if (qNum < 0 || cNum < 0) {
      return res.status(400).json({
        error: "qty and unitCost must be non-negative",
        code: "AMOUNT_NEGATIVE",
      });
    }
    if (qNum > 10_000) {
      return res.status(400).json({
        error: "qty exceeds the 10,000-unit per-line cap",
        code: "QTY_TOO_LARGE",
      });
    }
    if (cNum > 1_000_000) {
      return res.status(400).json({
        error: "unitCost exceeds the ₹10,00,000 per-unit cap",
        code: "UNIT_COST_TOO_LARGE",
      });
    }
    if (qNum * cNum > 10_000_000) {
      return res.status(400).json({
        error: "consumption line total exceeds the ₹1,00,00,000 per-line cap",
        code: "LINE_TOTAL_TOO_LARGE",
      });
    }

    const c = await prisma.serviceConsumption.create({
      data: {
        productName,
        qty: qNum,
        unitCost: cNum,
        visitId: id,
        productId: productId ? parseInt(productId) : null,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(c);
  } catch (e) {
    console.error("[wellness] consumption add error:", e.message);
    res.status(500).json({ error: "Failed to add consumption item" });
  }
});

// PUT /visits/:id/consumptions/:consumptionId — AMEND a consumption line.
// Per the CLINICAL ARTEFACT RETENTION POLICY above, ServiceConsumption rows
// are permanent and MUST NOT be deleted; corrections are made by amending the
// existing row (typo in product name, wrong qty / unit cost). The audit log
// records prior + new values so the historical state stays reconstructable.
router.put(
  "/visits/:id/consumptions/:consumptionId",
  phiWriteGate,
  async (req, res) => {
    try {
      const visitId = parseInt(req.params.id);
      const consumptionId = parseInt(req.params.consumptionId);

      // Tenant- + visit-scoped lookup so a caller can't amend another
      // tenant's row (or a row from a different visit).
      const existing = await prisma.serviceConsumption.findFirst({
        where: tenantWhere(req, { id: consumptionId, visitId }),
      });
      if (!existing)
        return res.status(404).json({ error: "Consumption item not found" });

      // Only the three user-editable fields are amendable. Anything omitted
      // falls back to the current value so a partial PUT is safe.
      const productName =
        req.body.productName != null ? req.body.productName : existing.productName;
      const qty = req.body.qty != null ? req.body.qty : existing.qty;
      const unitCost =
        req.body.unitCost != null ? req.body.unitCost : existing.unitCost;

      if (!productName || !String(productName).trim())
        return res.status(400).json({ error: "productName required" });

      // Same non-negative + per-line caps as the POST create path (#321).
      const qNum = parseInt(qty) || 0;
      const cNum = parseFloat(unitCost) || 0;
      if (qNum < 1) {
        return res.status(400).json({
          error: "qty must be at least 1",
          code: "AMOUNT_NEGATIVE",
        });
      }
      if (cNum < 0) {
        return res.status(400).json({
          error: "unitCost must be non-negative",
          code: "AMOUNT_NEGATIVE",
        });
      }
      if (qNum > 10_000) {
        return res.status(400).json({
          error: "qty exceeds the 10,000-unit per-line cap",
          code: "QTY_TOO_LARGE",
        });
      }
      if (cNum > 1_000_000) {
        return res.status(400).json({
          error: "unitCost exceeds the ₹10,00,000 per-unit cap",
          code: "UNIT_COST_TOO_LARGE",
        });
      }
      if (qNum * cNum > 10_000_000) {
        return res.status(400).json({
          error: "consumption line total exceeds the ₹1,00,00,000 per-line cap",
          code: "LINE_TOTAL_TOO_LARGE",
        });
      }

      const updated = await prisma.serviceConsumption.update({
        where: { id: existing.id },
        data: {
          productName: String(productName).trim(),
          qty: qNum,
          unitCost: cNum,
        },
      });

      // Amendment trail: capture the before/after for the three editable
      // fields so the permanent record stays auditable (policy §"Corrections").
      writeAudit(
        "ServiceConsumption",
        "CONSUMPTION_AMENDED",
        existing.id,
        req.user.userId,
        req.user.tenantId,
        {
          visitId,
          before: {
            productName: existing.productName,
            qty: existing.qty,
            unitCost: existing.unitCost,
          },
          after: {
            productName: updated.productName,
            qty: updated.qty,
            unitCost: updated.unitCost,
          },
        },
      ).catch((auditErr) => {
        console.warn(
          "[wellness] audit CONSUMPTION_AMENDED failed:",
          auditErr.message,
        );
      });

      res.json(updated);
    } catch (e) {
      console.error("[wellness] consumption amend error:", e.message);
      res.status(500).json({ error: "Failed to amend consumption item" });
    }
  },
);

// ── Prescriptions ──────────────────────────────────────────────────

// #326: clinical-write gate. The reusable verifyWellnessRole emits
// `WELLNESS_ROLE_FORBIDDEN` which collides with non-clinical 403s
// (catalog edits, owner reports). Prescriptions are a medico-legal
// write — frontend + audit need a stable, distinct code so a telecaller
// (or any non-doctor wellnessRole) hitting this route is unmistakably
// blocked for a clinical reason. Allow only doctor wellnessRole or RBAC
// ADMIN. MANAGER is explicitly NOT allowed: managers operate the clinic
// but don't carry a clinical mandate.
function requireClinicalRole(req, res, next) {
  if (!req.user)
    return res.status(401).json({ error: "Authentication required" });
  if (req.user.role === "ADMIN") return next();
  if (req.user.wellnessRole === "doctor") return next();
  // Neutral copy + structured code — no internal role-taxonomy leakage.
  return res.status(403).json({
    error: "You do not have permission to perform this action",
    code: "CLINICAL_ROLE_REQUIRED",
  });
}

router.get("/prescriptions", phiReadGate, async (req, res) => {
  try {
    const { patientId, limit = 50, skip = 0 } = req.query;
    const where = tenantWhere(req);
    if (patientId) where.patientId = parseInt(patientId);
    const take = Math.min(parseInt(limit, 10) || 50, 200);
    const skipN = Math.max(parseInt(skip, 10) || 0, 0);
    // #920 slice S42: opt-in slim shape via `?fields=summary`. Drops the
    // patient/doctor includes (patient.name is PHI under the strict
    // medico-legal classification — and crucially, the `drugs` @db.Text
    // column on Prescription is the load-bearing PHI drop: that's what
    // makes the bare-list call a regulated PHI read). Slim shape returns
    // only FKs the picker can hop on.
    const wantFullShape = isFullShape(req.query);
    const rxFindArgs = {
      where,
      take,
      skip: skipN,
      orderBy: { createdAt: "desc" },
    };
    if (wantFullShape) {
      rxFindArgs.include = {
        patient: { select: { id: true, name: true } },
        doctor: { select: { id: true, name: true } },
      };
    } else {
      rxFindArgs.select = listProjection("Prescription", false);
    }
    const [items, total] = await Promise.all([
      prisma.prescription.findMany(rxFindArgs),
      prisma.prescription.count({ where }),
    ]);
    // PRD §11 / T2.2: staff-side prescription list is a PHI read on the
    // full path (response embeds patient name + the drugs JSON). Medico-
    // legal trail. #534 (PERF-1): fire-and-forget — see PATIENT_LIST_READ
    // above.
    //
    // S42 audit-coordination: PRESCRIPTION_LIST_READ fires on BOTH paths;
    // `shape: 'summary'` indicates no drug list / no patient name was
    // disclosed. A reviewer can answer "did this op leak Rx contents?"
    // without joining tables.
    writeAudit(
      "Prescription",
      "PRESCRIPTION_LIST_READ",
      null,
      req.user.userId,
      req.user.tenantId,
      {
        count: items.length,
        filters: { patientId: patientId ? parseInt(patientId) : null },
        shape: wantFullShape ? "full" : "summary",
      },
    ).catch((auditErr) => {
      console.warn(
        "[wellness] audit /prescriptions list failed:",
        auditErr.message,
      );
    });
    res.json({ items: items.map(normalizePrescriptionDrugs), total });
  } catch (e) {
    console.error("[wellness] list prescriptions error:", e.message);
    res.status(500).json({ error: "Failed to list prescriptions" });
  }
});

// #207/#216: only doctors (or admin owner override) may write prescriptions.
// Managers operate the clinic but don't prescribe; telecallers/helpers/professionals
// have no clinical mandate.
router.post("/prescriptions", requireClinicalRole, async (req, res) => {
  try {
    const { visitId, patientId, doctorId, drugs, instructions } = req.body;
    if (!visitId || !patientId) {
      return res
        .status(400)
        .json({ error: "visitId and patientId are required" });
    }
    // #114: drugs must be a non-empty array with at least one named drug.
    // Pre-fix, the UI sent `drugs: []` (filtered empty) and `!drugs` was false
    // (empty array is truthy), so phantom prescriptions saved with no medication.
    const drugList = Array.isArray(drugs) ? drugs : [];
    const namedDrugs = drugList.filter(
      (d) => d && typeof d.name === "string" && d.name.trim(),
    );
    if (namedDrugs.length === 0) {
      return res.status(400).json({
        error: "At least one drug name is required",
        code: "DRUG_NAME_REQUIRED",
      });
    }
    const rx = await prisma.prescription.create({
      data: {
        visitId: parseInt(visitId),
        patientId: parseInt(patientId),
        doctorId: doctorId ? parseInt(doctorId) : req.user.userId,
        drugs: JSON.stringify(namedDrugs),
        instructions,
        tenantId: req.user.tenantId,
      },
    });
    // #179: audit Rx creation. Medico-legal: capture drug names so amendments
    // can be diffed against the original prescription without joining tables.
    await writeAudit(
      "Prescription",
      "CREATE",
      rx.id,
      req.user.userId,
      req.user.tenantId,
      {
        patientId: rx.patientId,
        visitId: rx.visitId,
        doctorId: rx.doctorId,
        drugNames: namedDrugs.map((d) => d.name).slice(0, 20),
        drugCount: namedDrugs.length,
      },
    );
    res.status(201).json(normalizePrescriptionDrugs(rx));
  } catch (e) {
    console.error("[wellness] create prescription error:", e.message);
    res.status(500).json({ error: "Failed to create prescription" });
  }
});

// #194: amend a prescription. Restricted to the original prescriber or an
// ADMIN — anyone else gets 403. drugs (when supplied) must keep the
// non-empty-with-name invariant of the create path. Hard-delete is NOT
// exposed: clinical records must persist for the medico-legal trail.
// #207/#216: same clinical gate on amend. The body still enforces "only the
// original prescriber or an ADMIN" — this gate just keeps non-clinicals out
// before the row lookup.
router.put("/prescriptions/:id", requireClinicalRole, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.prescription.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!existing)
      return res.status(404).json({ error: "Prescription not found" });
    if (existing.doctorId !== req.user.userId && req.user.role !== "ADMIN") {
      return res.status(403).json({
        error: "Only the prescriber or an admin can amend this prescription",
        code: "AMEND_FORBIDDEN",
      });
    }
    const data = {};
    if (req.body.drugs !== undefined) {
      const drugList = Array.isArray(req.body.drugs) ? req.body.drugs : [];
      const namedDrugs = drugList.filter(
        (d) => d && typeof d.name === "string" && d.name.trim(),
      );
      if (namedDrugs.length === 0) {
        return res.status(400).json({
          error: "At least one drug name is required",
          code: "DRUG_NAME_REQUIRED",
        });
      }
      data.drugs = JSON.stringify(namedDrugs);
    }
    if (req.body.instructions !== undefined)
      data.instructions = req.body.instructions;
    const updated = await prisma.prescription.update({ where: { id }, data });
    // #179: audit Rx amendment. This row is the medico-legal trail —
    // capture before/after drug arrays so the diff is reconstructible without
    // having to read prior versions of the row.
    let priorDrugs = null,
      newDrugs = null;
    try {
      priorDrugs = JSON.parse(existing.drugs || "[]");
    } catch (_) { }
    try {
      newDrugs = JSON.parse(updated.drugs || "[]");
    } catch (_) { }
    await writeAudit(
      "Prescription",
      "UPDATE_PRESCRIPTION",
      updated.id,
      req.user.userId,
      req.user.tenantId,
      {
        patientId: updated.patientId,
        visitId: updated.visitId,
        doctorId: updated.doctorId,
        amendedBy: req.user.userId,
        isOriginalPrescriber: existing.doctorId === req.user.userId,
        priorDrugs,
        newDrugs,
        priorInstructions: existing.instructions || null,
        newInstructions: updated.instructions || null,
      },
    );
    res.json(normalizePrescriptionDrugs(updated));
  } catch (e) {
    console.error("[wellness] amend prescription error:", e.message);
    res.status(500).json({ error: "Failed to amend prescription" });
  }
});

// ── Consent forms ──────────────────────────────────────────────────

router.get("/consents", phiReadGate, async (req, res) => {
  try {
    const { patientId, limit = 50 } = req.query;
    const where = tenantWhere(req);
    if (patientId) where.patientId = parseInt(patientId);
    const items = await prisma.consentForm.findMany({
      where,
      take: Math.min(parseInt(limit, 10) || 50, 200),
      orderBy: { signedAt: "desc" },
      select: {
        id: true,
        templateName: true,
        signedAt: true,
        patientId: true,
        serviceId: true,
        tenantId: true,
        hasPdfBlob: true,
        patient: { select: { id: true, name: true } },
        service: { select: { id: true, name: true } },
        // EXCLUDED: signatureSvg, contentSnapshot, signedPdfBlob
      },
    });
    // PRD §11 / T2.2: staff-side consent list is a PHI read
    // (response embeds patient name + signed template type).
    // #534 (PERF-1): fire-and-forget — see PATIENT_LIST_READ above.
    writeAudit(
      "ConsentForm",
      "CONSENT_LIST_READ",
      null,
      req.user.userId,
      req.user.tenantId,
      {
        count: items.length,
        filters: { patientId: patientId ? parseInt(patientId) : null },
      },
    ).catch((auditErr) => {
      console.warn("[wellness] audit /consents list failed:", auditErr.message);
    });
    res.json(items);
  } catch (e) {
    console.error("[wellness] list consents error:", e.message);
    res.status(500).json({ error: "Failed to list consents" });
  }
});

// #207/#216: consent capture is performed by the clinician (doctor) or the
// professional running the visit; admin owner override allowed. Telecallers
// and helpers cannot record consent.
//
// #564 v3.7.3 — STAFF-TABLET-HANDOFF workflow (chosen disposition). Staff
// pulls up the form on a tablet during patient intake, hands the tablet to
// the patient, the patient signs, and staff confirms + submits. The RBAC
// gate above (doctor/professional/admin only) enforces this — telecallers
// can't capture consent, and the patient portal does NOT POST here (portal
// path is separate at routes/portal.js when/if patient-self-serve ships).
// captureMethod defaults to 'tablet-handoff' to record the workflow at the
// row level; capturedByUserId stamps the staff member who facilitated.
router.post(
  "/consents",
  verifyWellnessRole(["clinical", "doctor", "professional", "admin"], {
    anyOfPermissions: [{ module: "consents", action: "write" }],
  }),
  async (req, res) => {
    try {
      const {
        patientId,
        serviceId,
        templateName,
        signatureSvg,
        captureMethod,
      } = req.body;
      if (!patientId || !templateName) {
        return res
          .status(400)
          .json({ error: "patientId and templateName are required" });
      }
      // Defense-in-depth (#118): reject blank/missing signatures even if the UI
      // is bypassed. A blank 600x180 PNG data-URL is ~220 chars; a real signature
      // with strokes is several KB. 500 chars is well above the empty floor and
      // well below any genuine capture.
      if (
        !signatureSvg ||
        typeof signatureSvg !== "string" ||
        signatureSvg.length < 500
      ) {
        return res.status(400).json({
          error: "Patient signature is required and cannot be blank",
          code: "SIGNATURE_REQUIRED",
        });
      }
      // #564 — DPDP §15 / CONSENT_CAPTURE. Snapshot the matching
      // ConsentTemplate.body server-side so the immutable record reflects the
      // wording shown to the patient at sign time, even if the template body
      // is later edited or the template row is deleted. We deliberately
      // resolve by (tenantId, key=templateName) rather than trusting client
      // input — a tampered request body cannot inject arbitrary contentSnapshot.
      let contentSnapshot = null;
      try {
        const tpl = await prisma.consentTemplate.findFirst({
          where: { tenantId: req.user.tenantId, key: templateName },
          select: { body: true },
        });
        contentSnapshot = tpl?.body || null;
      } catch (_e) {
        /* schema/migration race; leave snapshot null */
      }

      // #564 v3.7.3 — captureMethod allowlist. Client may set 'tablet-handoff'
      // (default), 'portal-self-serve' (future), or 'imported-pdf' (data
      // migration only). Unknown values fall back to the default so a typo
      // doesn't poison the audit trail.
      const ALLOWED_METHODS = new Set([
        "tablet-handoff",
        "portal-self-serve",
        "imported-pdf",
      ]);
      const resolvedCaptureMethod = ALLOWED_METHODS.has(captureMethod)
        ? captureMethod
        : "tablet-handoff";

      const consent = await prisma.consentForm.create({
        data: {
          patientId: parseInt(patientId),
          serviceId: serviceId ? parseInt(serviceId) : null,
          templateName,
          signatureSvg,
          contentSnapshot,
          captureMethod: resolvedCaptureMethod,
          capturedByUserId: req.user.userId,
          tenantId: req.user.tenantId,
        },
      });
      // #179: audit consent creation. Don't store the signatureSvg in the
      // audit blob — it's a few KB, and the row itself holds the canonical copy.
      // #564: emit CONSENT_CAPTURE alongside the legacy CREATE so DPDP / clinical
      // audit reviewers can grep one canonical action verb across the audit log.
      // v3.7.3: include captureMethod + capturedByUserId so the audit row alone
      // is sufficient to answer "who facilitated this consent and via which flow".
      await writeAudit(
        "ConsentForm",
        "CONSENT_CAPTURE",
        consent.id,
        req.user.userId,
        req.user.tenantId,
        {
          patientId: consent.patientId,
          serviceId: consent.serviceId,
          templateName: consent.templateName,
          signatureLength: signatureSvg.length,
          hasContentSnapshot: !!contentSnapshot,
          captureMethod: resolvedCaptureMethod,
          capturedByUserId: req.user.userId,
        },
      );

      // #616: emit consent.signed. Failure here MUST NOT fail the response.
      try {
        const { emitEvent } = require("../lib/eventBus");
        emitEvent(
          "consent.signed",
          {
            consentId: consent.id,
            patientId: consent.patientId,
            serviceId: consent.serviceId,
            templateName: consent.templateName,
          },
          req.user.tenantId,
          req.io,
        );
      } catch (_e) {
        /* event bus optional */
      }

      // #564: fire-and-forget PDF BLOB generation. Generate the signed PDF
      // after signing and store it in signedPdfBlob for fast serving via
      // GET /consents/:id/pdf. Failure here MUST NOT affect the 201 response.
      (async () => {
        try {
          console.log(
            `[wellness] Starting PDF generation for consent ${consent.id}`,
          );
          const [patient, service, clinic] = await Promise.all([
            prisma.patient.findUnique({ where: { id: consent.patientId } }),
            consent.serviceId
              ? prisma.service.findUnique({ where: { id: consent.serviceId } })
              : null,
            primaryClinic(req.user.tenantId),
          ]);
          console.log(
            `[wellness] Fetched patient ${patient?.id}, service ${service?.id}, clinic ${clinic?.id}`,
          );
          const pdfBuf = await renderConsentPdf(
            consent,
            patient,
            service,
            clinic,
            signatureSvg,
          );
          console.log(`[wellness] PDF rendered: ${pdfBuf.length} bytes`);
          await prisma.consentForm.update({
            where: { id: consent.id },
            data: { signedPdfBlob: pdfBuf, hasPdfBlob: true },
          });
          console.log(
            `[wellness] Consent ${consent.id} PDF stored successfully`,
          );
        } catch (pdfErr) {
          console.error(
            "[wellness] consent PDF BLOB generation failed:",
            pdfErr,
          );
        }
      })();

      res.status(201).json(consent);
    } catch (e) {
      console.error("[wellness] create consent error:", e.message);
      res.status(500).json({ error: "Failed to create consent" });
    }
  },
);

// #194: amend a consent form — only the templateName + serviceId metadata
// can be corrected. The signatureSvg is captured-at-signing and is never
// editable post-hoc: that's a forgery vector, not an amendment. ADMIN only.
// #207/#216: consent metadata edits are admin-only (matches existing body
// check). The verifyWellnessRole gate just produces a clean 403 with the
// shared WELLNESS_ROLE_FORBIDDEN code before we touch the DB.
router.put(
  "/consents/:id",
  verifyWellnessRole(["admin"], {
    anyOfPermissions: [{ module: "consents", action: "write" }],
  }),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await prisma.consentForm.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Consent not found" });
      if (req.user.role !== "ADMIN") {
        return res.status(403).json({
          error: "Only an admin can amend consent metadata",
          code: "AMEND_FORBIDDEN",
        });
      }
      const data = {};
      if (req.body.templateName !== undefined)
        data.templateName = req.body.templateName;
      if (req.body.serviceId !== undefined)
        data.serviceId = req.body.serviceId
          ? parseInt(req.body.serviceId)
          : null;
      if (req.body.signatureSvg !== undefined) {
        return res.status(400).json({
          error: "signatureSvg cannot be edited after signing",
          code: "SIGNATURE_IMMUTABLE",
        });
      }
      if (req.body.signedPdfBlob !== undefined) {
        return res.status(400).json({
          error: "signedPdfBlob cannot be edited after signing",
          code: "PDF_BLOB_IMMUTABLE",
        });
      }
      const updated = await prisma.consentForm.update({ where: { id }, data });
      // #179: HIPAA / DPDP — consent metadata amendments are PHI-adjacent and
      // must be auditable. signatureSvg is rejected above so it can't appear
      // in the diff. Audit failure must NOT break the user-facing response.
      try {
        const changes = diffFields(existing, updated, Object.keys(data));
        await writeAudit(
          "ConsentForm",
          "UPDATE",
          updated.id,
          req.user.userId,
          req.user.tenantId,
          {
            patientId: existing.patientId,
            changedFields: changes,
          },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.json(updated);
    } catch (e) {
      console.error("[wellness] amend consent error:", e.message);
      res.status(500).json({ error: "Failed to amend consent" });
    }
  },
);

// ── #612: Consent templates CRUD ───────────────────────────────────
//
// Pre-fix the consent-capture dropdown rendered 5 hardcoded options
// (hair-transplant / botox-fillers / laser / chemical-peel / general)
// inside PatientDetail.jsx. Clinics with paediatric / procedure-specific
// flows could not customise. These endpoints expose ConsentTemplate as a
// per-tenant CRUD resource. Already-signed ConsentForm rows reference the
// template by string `key` so historical signatures stay immutable when
// templates are renamed or deleted.

const SEED_CONSENT_TEMPLATES = [
  { key: "hair-transplant", label: "Hair Transplant" },
  { key: "botox-fillers", label: "Botox / Fillers" },
  { key: "laser", label: "Laser Treatment" },
  { key: "chemical-peel", label: "Chemical Peel" },
  { key: "general", label: "General Procedure" },
];

// Auto-seed the 5 starter templates the first time a tenant lists them.
// isSeed=true marks them so the UI can hint they're tenant-overridable.
async function ensureSeedConsentTemplates(tenantId) {
  const existing = await prisma.consentTemplate.count({ where: { tenantId } });
  if (existing > 0) return;
  for (const t of SEED_CONSENT_TEMPLATES) {
    await prisma.consentTemplate
      .create({
        data: { ...t, tenantId, isSeed: true, isActive: true },
      })
      .catch(() => {
        /* race-safe; @@unique([tenantId,key]) blocks dup */
      });
  }
}

router.get("/consent-templates", async (req, res) => {
  try {
    await ensureSeedConsentTemplates(req.user.tenantId);
    const items = await prisma.consentTemplate.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: [{ isActive: "desc" }, { label: "asc" }],
    });
    res.json(items);
  } catch (e) {
    console.error("[wellness] list consent-templates:", e.message);
    res.status(500).json({ error: "Failed to list consent templates" });
  }
});

router.post("/consent-templates", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { key, label, body, language, isActive } = req.body;
    if (!key || !String(key).trim()) {
      return res
        .status(400)
        .json({ error: "key is required", code: "KEY_REQUIRED" });
    }
    if (!label || !String(label).trim()) {
      return res
        .status(400)
        .json({ error: "label is required", code: "LABEL_REQUIRED" });
    }
    const normalisedKey = String(key)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-");
    const dup = await prisma.consentTemplate.findFirst({
      where: { tenantId: req.user.tenantId, key: normalisedKey },
    });
    if (dup) {
      return res
        .status(409)
        .json({ error: "Template key already exists", code: "DUPLICATE_KEY" });
    }
    const created = await prisma.consentTemplate.create({
      data: {
        key: normalisedKey,
        label: String(label).trim(),
        body: body || null,
        language: language || "en",
        isActive: isActive === undefined ? true : !!isActive,
        isSeed: false,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error("[wellness] create consent-template:", e.message);
    res.status(500).json({ error: "Failed to create consent template" });
  }
});

router.put(
  "/consent-templates/:id",
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id))
        return res.status(400).json({ error: "Invalid template id" });
      const existing = await prisma.consentTemplate.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing)
        return res.status(404).json({ error: "Template not found" });
      const data = {};
      if (req.body.label !== undefined)
        data.label = String(req.body.label).trim();
      if (req.body.body !== undefined) data.body = req.body.body || null;
      if (req.body.language !== undefined)
        data.language = req.body.language || "en";
      if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;
      // key is immutable post-create — historical ConsentForm rows reference it.
      const updated = await prisma.consentTemplate.update({
        where: { id },
        data,
      });
      res.json(updated);
    } catch (e) {
      console.error("[wellness] update consent-template:", e.message);
      res.status(500).json({ error: "Failed to update consent template" });
    }
  },
);

router.delete(
  "/consent-templates/:id",
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id))
        return res.status(400).json({ error: "Invalid template id" });
      const existing = await prisma.consentTemplate.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing)
        return res.status(404).json({ error: "Template not found" });
      await prisma.consentTemplate.delete({ where: { id } });
      res.json({ success: true, deleted: true, id });
    } catch (e) {
      console.error("[wellness] delete consent-template:", e.message);
      res.status(500).json({ error: "Failed to delete consent template" });
    }
  },
);

// ── Treatment plans ────────────────────────────────────────────────
//
// #420: Path consolidation. Pre-fix this resource straddled two paths —
// POST /wellness/treatments (create) but PUT /wellness/treatment-plans/:id
// (update). Same Prisma model, two URLs. That broke the G-20 tenant-isolation
// framework (which assumes one canonical path per resource) and confused
// integration builders. Canonical is now /wellness/treatment-plans for the
// full CRUD; the legacy /treatments paths return 410 Gone with a `canonical`
// pointer per docs/API_NAMESPACING.md so callers self-heal explicitly rather
// than silently working forever on a stale URL.
//
// No DELETE: TreatmentPlan is in the clinical-no-delete cluster (#21). See the
// retention-policy comment block at the top of this file.

// GET /treatment-plans — list (filterable by patientId / status)
router.get("/treatment-plans", phiReadGate, async (req, res) => {
  try {
    const { patientId, status } = req.query;
    const where = tenantWhere(req);
    if (patientId) where.patientId = parseInt(patientId);
    if (status) where.status = status;
    const plans = await prisma.treatmentPlan.findMany({
      where,
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true, category: true } },
      },
      orderBy: { startedAt: "desc" },
    });
    // PRD §11 / T2.2: treatment plans embed patient name + phone + service.
    // #534 (PERF-1): fire-and-forget — see PATIENT_LIST_READ above.
    writeAudit(
      "TreatmentPlan",
      "TREATMENT_PLAN_LIST_READ",
      null,
      req.user.userId,
      req.user.tenantId,
      {
        count: plans.length,
        filters: {
          patientId: patientId ? parseInt(patientId) : null,
          status: status || null,
        },
      },
    ).catch((auditErr) => {
      console.warn(
        "[wellness] audit /treatment-plans list failed:",
        auditErr.message,
      );
    });
    res.json(plans);
  } catch (e) {
    console.error("[wellness] list treatment-plans error:", e.message);
    res.status(500).json({ error: "Failed to list treatment plans" });
  }
});

// GET /treatment-plans/:id — read one (tenant-scoped via findFirst)
router.get("/treatment-plans/:id", phiReadGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const plan = await prisma.treatmentPlan.findFirst({
      where: tenantWhere(req, { id }),
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true, category: true } },
      },
    });
    if (!plan)
      return res.status(404).json({ error: "Treatment plan not found" });
    // PRD §11 / T2.2: treatment plan detail reveals patient + service +
    // session progress. Audit per request.
    try {
      await writeAudit(
        "TreatmentPlan",
        "TREATMENT_PLAN_READ",
        plan.id,
        req.user.userId,
        req.user.tenantId,
        {
          treatmentPlanId: plan.id,
          patientId: plan.patientId,
          serviceId: plan.serviceId,
        },
      );
    } catch (auditErr) {
      console.warn(
        "[wellness] audit /treatment-plans/:id failed:",
        auditErr.message,
      );
    }
    res.json(plan);
  } catch (e) {
    console.error("[wellness] read treatment-plan error:", e.message);
    res.status(500).json({ error: "Failed to read treatment plan" });
  }
});

// POST /treatment-plans — create
router.post("/treatment-plans", phiWriteGate, async (req, res) => {
  try {
    const { name, totalSessions, totalPrice, patientId, serviceId, nextDueAt } =
      req.body;
    if (!name || !totalSessions || !patientId) {
      return res
        .status(400)
        .json({ error: "name, totalSessions, patientId required" });
    }
    // #745 — duplicate-prevention: reject an exact-match plan created in the
    // last 5 minutes with 409 IDEMPOTENT_DUPLICATE (kills rapid double-click /
    // retried-seed dup explosions while still allowing legitimate same-name
    // plans created months apart). TreatmentPlan has no `createdAt` column —
    // `startedAt` (@default now) serves the dedupe window. Ported from main
    // (partial-port gap).
    {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      const dupe = await prisma.treatmentPlan.findFirst({
        where: tenantWhere(req, {
          patientId: parseInt(patientId),
          name: name,
          totalSessions: parseInt(totalSessions),
          startedAt: { gte: fiveMinAgo },
        }),
        select: { id: true },
      });
      if (dupe) {
        return res.status(409).json({
          error:
            "An identical treatment plan was created in the last 5 minutes",
          code: "IDEMPOTENT_DUPLICATE",
          existingId: dupe.id,
        });
      }
    }
    const plan = await prisma.treatmentPlan.create({
      data: {
        name,
        totalSessions: parseInt(totalSessions),
        totalPrice: totalPrice ? parseFloat(totalPrice) : 0,
        patientId: parseInt(patientId),
        serviceId: serviceId ? parseInt(serviceId) : null,
        nextDueAt: nextDueAt ? new Date(nextDueAt) : null,
        tenantId: req.user.tenantId,
      },
    });
    // #179: PHI-adjacent treatment plan create is auditable per PRD §11.
    try {
      await writeAudit(
        "TreatmentPlan",
        "CREATE",
        plan.id,
        req.user.userId,
        req.user.tenantId,
        {
          patientId: plan.patientId,
          serviceId: plan.serviceId,
          name: plan.name,
          totalSessions: plan.totalSessions,
          totalPrice: plan.totalPrice,
        },
      );
    } catch (auditErr) {
      console.warn("[audit]", auditErr.message);
    }

    // #616: emit treatment.started. Failure here MUST NOT fail the response.
    try {
      const { emitEvent } = require("../lib/eventBus");
      emitEvent(
        "treatment.started",
        {
          treatmentPlanId: plan.id,
          patientId: plan.patientId,
          serviceId: plan.serviceId,
          name: plan.name,
          totalSessions: plan.totalSessions,
        },
        req.user.tenantId,
        req.io,
      );
    } catch (_e) {
      /* event bus optional */
    }

    res.status(201).json(plan);
  } catch (e) {
    console.error("[wellness] create treatment-plan error:", e.message);
    res.status(500).json({ error: "Failed to create treatment plan" });
  }
});

// ── Legacy /treatments paths — 410 Gone with canonical pointer (#420) ──
//
// Same shape as the namespacing redirect helper at the top of the file
// (WELLNESS_NAMESPACE_INVALID for /staff and /audit). Callers get a strong,
// machine-readable signal that the URL has moved instead of a silent 404 or,
// worse, silently-working forever on a stale URL.
//
// Timeline note: keep the 410 in place until backend logs show zero hits
// (estimate: one release with no callers). The frontend has been migrated in
// the same commit; partner integrations consume /api/v1/external/* which has
// its own URL contract and is unaffected.
const TREATMENT_PLANS_CANONICAL = "/api/wellness/treatment-plans";
const treatmentsGone = (req, res) => {
  res.status(410).json({
    error:
      "Use /api/wellness/treatment-plans. Treatments path was consolidated to treatment-plans.",
    code: "WELLNESS_TREATMENTS_RENAMED",
    canonical: TREATMENT_PLANS_CANONICAL,
  });
};
router.all("/treatments", treatmentsGone);
router.all("/treatments/*", treatmentsGone);

// ── Services (catalog) ─────────────────────────────────────────────

router.get("/services", async (req, res) => {
  try {
    // Hard cap at 2000 so the BookAppointment / Catalog / Memberships /
    // Calendar / TelecallerQueue / PointOfSale consumers all see the full
    // tenant catalog. The previous 200 cap silently dropped services from
    // every dropdown on tenants with >200 active rows (e.g. Dr. Haror's
    // has 499 active), breaking the marketing-site ?serviceId= deep-link
    // pre-fill on BookAppointment whenever the linked service sorted past
    // position 200.
    const services = await prisma.service.findMany({
      where: tenantWhere(req, { NOT: { isActive: false } }),
      orderBy: [{ ticketTier: "desc" }, { name: "asc" }],
      take: 2000,
    });
    res.json(services);
  } catch (e) {
    console.error("[wellness] list services error:", e.message);
    res.status(500).json({ error: "Failed to list services" });
  }
});

// #216: service-catalog mutations are operational, not clinical. Lock to
// admin/manager — clinical staff (doctors/professionals) read the catalog
// but don't define pricing or duration.
// Wave 2 Agent LL — validate + normalize the supportedBookingTypes input
// for service create/update endpoints. Returns either an error envelope
// (suitable for res.status/json) or a JSON-stringified payload ready for
// the Prisma `data:` field. Empty/omitted input returns null (column
// default → widget falls back to CLINIC_VISIT-only).
function normalizeSupportedBookingTypesInput(raw) {
  if (raw == null || raw === "") return { value: null };
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        error: {
          status: 400,
          error: "supportedBookingTypes must be a JSON array",
          code: "INVALID_INPUT",
        },
      };
    }
  }
  if (!Array.isArray(parsed)) {
    return {
      error: {
        status: 400,
        error: "supportedBookingTypes must be a JSON array",
        code: "INVALID_INPUT",
      },
    };
  }
  // De-dup + uppercase + reject unknowns. Matches the BOOKING_TYPES vocabulary
  // pinned at file-top so the catalog can never persist an enum value the
  // public booking handler doesn't recognize.
  const normalized = Array.from(
    new Set(parsed.map((v) => String(v).trim().toUpperCase()).filter(Boolean)),
  );
  for (const v of normalized) {
    if (!BOOKING_TYPES.includes(v)) {
      return {
        error: {
          status: 400,
          error: `supportedBookingTypes contains unknown value: ${v}`,
          code: "INVALID_INPUT",
        },
      };
    }
  }
  if (normalized.length === 0) return { value: null };
  return { value: JSON.stringify(normalized) };
}

router.post("/services", adminOrPerm("services", "write"), async (req, res) => {
  try {
    const {
      name,
      category,
      ticketTier,
      basePrice,
      durationMin,
      targetRadiusKm,
      description,
      supportedBookingTypes,
      imageUrls,
    } = req.body;
    if (!name || !String(name).trim())
      return res.status(400).json({ error: "name required" });
    // #115: refuse zero-priced services from the catalog. Existing ₹0 rows
    // (e.g. seed-only "spa") stay visible until manually corrected — only
    // new creations are blocked.
    const price = Number(basePrice);
    if (!Number.isFinite(price) || price <= 0) {
      return res
        .status(400)
        .json({
          error: "basePrice must be greater than 0",
          code: "PRICE_REQUIRED",
        });
    }
    // #209: cap basePrice at ₹50L (5_000_000). Public booking page exposes
    // garbage rows like ₹1e15 / 999999 min when there's no upper bound.
    if (price > 5_000_000) {
      return res
        .status(400)
        .json({
          error: "basePrice exceeds maximum (₹50,00,000)",
          code: "PRICE_TOO_HIGH",
        });
    }
    // #149: durationMin must be positive; targetRadiusKm must be non-negative
    // when supplied (null = unlimited is fine).
    // #209: cap durationMin at 8 hours (480 min) — anything beyond that is
    // not a single appointment.
    if (durationMin !== undefined && durationMin !== null) {
      const d = Number(durationMin);
      if (!Number.isFinite(d) || d <= 0) {
        return res
          .status(400)
          .json({
            error: "durationMin must be greater than 0",
            code: "DURATION_INVALID",
          });
      }
      // 720 min (12h) supports real long procedures like full hair transplant
      // sessions, which legitimately take 9-10 hours. The earlier 480 cap
      // accidentally caught real seed rows on the wellness tenant.
      if (d > 720) {
        return res
          .status(400)
          .json({
            error: "durationMin exceeds maximum (720)",
            code: "DURATION_TOO_HIGH",
          });
      }
    }
    if (
      targetRadiusKm !== undefined &&
      targetRadiusKm !== null &&
      targetRadiusKm !== ""
    ) {
      const r = Number(targetRadiusKm);
      if (!Number.isFinite(r) || r < 0) {
        return res
          .status(400)
          .json({
            error: "targetRadiusKm cannot be negative",
            code: "RADIUS_INVALID",
          });
      }
    }
    // Wave 2 Agent LL — validate supportedBookingTypes before write.
    const sbtResult = normalizeSupportedBookingTypesInput(
      supportedBookingTypes,
    );
    if (sbtResult.error) {
      return res
        .status(sbtResult.error.status)
        .json({ error: sbtResult.error.error, code: sbtResult.error.code });
    }
    // imageUrls is a JSON-stringified array of URLs (matches the Prisma
    // column shape). Accept either an array (we stringify) or a pre-
    // stringified value — frontends typically send the array form.
    let imageUrlsValue = null;
    if (imageUrls !== undefined && imageUrls !== null && imageUrls !== "") {
      imageUrlsValue = Array.isArray(imageUrls)
        ? JSON.stringify(imageUrls)
        : String(imageUrls);
    }
    const svc = await prisma.service.create({
      data: {
        name,
        category,
        ticketTier: ticketTier || "medium",
        basePrice: basePrice ? parseFloat(basePrice) : 0,
        durationMin: durationMin ? parseInt(durationMin) : 30,
        targetRadiusKm:
          targetRadiusKm !== undefined && targetRadiusKm !== null
            ? parseInt(targetRadiusKm)
            : null,
        description,
        supportedBookingTypes: sbtResult.value,
        imageUrls: imageUrlsValue,
        tenantId: req.user.tenantId,
      },
    });
    // #179: catalog mutations are operational config — audit so price/duration
    // changes are traceable for billing-dispute investigations.
    try {
      await writeAudit(
        "Service",
        "CREATE",
        svc.id,
        req.user.userId,
        req.user.tenantId,
        {
          name: svc.name,
          category: svc.category,
          basePrice: svc.basePrice,
          durationMin: svc.durationMin,
        },
      );
    } catch (auditErr) {
      console.warn("[audit]", auditErr.message);
    }
    res.status(201).json(svc);
  } catch (e) {
    console.error("[wellness] create service error:", e.message);
    // #165: bad service input now surfaces as 400 with the real reason.
    const mapped = httpFromPrismaError(e);
    if (mapped) return res.status(mapped.status).json(mapped);
    res.status(500).json({ error: "Failed to create service" });
  }
});

router.put(
  "/services/:id",
  adminOrPerm("services", "write"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await prisma.service.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Service not found" });
      const data = {};
      const allowed = [
        "name",
        "category",
        "ticketTier",
        "basePrice",
        "durationMin",
        "targetRadiusKm",
        "description",
        "isActive",
      ];
      for (const k of allowed)
        if (req.body[k] !== undefined) data[k] = req.body[k];
      // imageUrls accepts either an array (we stringify) or a pre-stringified
      // JSON value. Pass `null` or `[]` to clear.
      if (req.body.imageUrls !== undefined) {
        const v = req.body.imageUrls;
        if (v === null || v === "") data.imageUrls = null;
        else data.imageUrls = Array.isArray(v) ? JSON.stringify(v) : String(v);
      }
      // Wave 2 Agent LL — supportedBookingTypes is handled separately because
      // it requires JSON-stringification + vocabulary validation, NOT a raw
      // copy of req.body[k] like the other allowed fields.
      if (req.body.supportedBookingTypes !== undefined) {
        const sbtResult = normalizeSupportedBookingTypesInput(
          req.body.supportedBookingTypes,
        );
        if (sbtResult.error) {
          return res
            .status(sbtResult.error.status)
            .json({ error: sbtResult.error.error, code: sbtResult.error.code });
        }
        data.supportedBookingTypes = sbtResult.value;
      }
      // #115: same price guard on edit — can't update a service to ₹0.
      if (data.basePrice !== undefined) {
        const price = Number(data.basePrice);
        if (!Number.isFinite(price) || price <= 0) {
          return res
            .status(400)
            .json({
              error: "basePrice must be greater than 0",
              code: "PRICE_REQUIRED",
            });
        }
        // #209: same upper-bound cap on edit.
        if (price > 5_000_000) {
          return res
            .status(400)
            .json({
              error: "basePrice exceeds maximum (₹50,00,000)",
              code: "PRICE_TOO_HIGH",
            });
        }
      }
      // #149: same duration / radius guards on edit.
      if (data.durationMin !== undefined && data.durationMin !== null) {
        const d = Number(data.durationMin);
        if (!Number.isFinite(d) || d <= 0) {
          return res
            .status(400)
            .json({
              error: "durationMin must be greater than 0",
              code: "DURATION_INVALID",
            });
        }
        // #209: same 8-hour cap on edit.
        // 720 min (12h) supports real long procedures like full hair transplant
        // sessions, which legitimately take 9-10 hours. The earlier 480 cap
        // accidentally caught real seed rows on the wellness tenant.
        if (d > 720) {
          return res
            .status(400)
            .json({
              error: "durationMin exceeds maximum (720)",
              code: "DURATION_TOO_HIGH",
            });
        }
      }
      if (
        data.targetRadiusKm !== undefined &&
        data.targetRadiusKm !== null &&
        data.targetRadiusKm !== ""
      ) {
        const r = Number(data.targetRadiusKm);
        if (!Number.isFinite(r) || r < 0) {
          return res
            .status(400)
            .json({
              error: "targetRadiusKm cannot be negative",
              code: "RADIUS_INVALID",
            });
        }
      }
      const updated = await prisma.service.update({ where: { id }, data });
      // #179: audit only the keys that actually changed.
      try {
        const changes = diffFields(existing, updated, Object.keys(data));
        if (Object.keys(changes).length > 0) {
          await writeAudit(
            "Service",
            "UPDATE",
            updated.id,
            req.user.userId,
            req.user.tenantId,
            {
              changedFields: changes,
            },
          );
        }
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.json(updated);
    } catch (e) {
      console.error("[wellness] update service error:", e.message);
      // #168 #165: same mapping as create.
      const mapped = httpFromPrismaError(e);
      if (mapped) return res.status(mapped.status).json(mapped);
      res.status(500).json({ error: "Failed to update service" });
    }
  },
);

// ── Wellness role catalog ──────────────────────────────────────────
//
// Per-tenant catalog that replaces the old hard-coded VALID_WELLNESS_ROLES
// whitelist in routes/staff.js. Admins maintain rows like
// {key:"nurse", label:"Nurse", canTakeVisits:true} from Settings; the
// Calendar grid + Staff edit form read this list to discover which
// wellnessRole values are valid for the tenant.
//
// `key` is a slug stored on User.wellnessRole — it's the value the rest
// of the codebase already compares against. Changing it for an in-use
// role would orphan every staff member with that wellnessRole, so the
// PUT handler refuses key-edits on rows in use. DELETE is similarly
// refused while in use.

const {
  ensureRoleKey,
  ensureRoleLabel,
  listForTenant: listRoleTypes,
  seedDefaultsForTenant,
} = require("../lib/wellnessRoleTypes");

router.get("/role-types", async (req, res) => {
  try {
    const activeOnly =
      req.query.activeOnly === "1" || req.query.activeOnly === "true";
    let rows = await listRoleTypes(req.user.tenantId, { activeOnly });
    // Defensive auto-seed: if the tenant has no wellness role catalog yet
    // (fresh signup, restored backup, or data drift), plant the defaults
    // before returning so the Staff form + backend sync can map DOCTOR →
    // "doctor" instead of returning an empty dropdown.
    if (rows.length === 0) {
      await seedDefaultsForTenant(req.user.tenantId);
      rows = await listRoleTypes(req.user.tenantId, { activeOnly });
    }
    res.json(rows);
  } catch (e) {
    console.error("[wellness] list role-types error:", e.message);
    res.status(500).json({ error: "Failed to list role types" });
  }
});

router.post(
  "/role-types",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const { key, label, icon, color, canTakeVisits, sortOrder } =
        req.body || {};
      const keyErr = ensureRoleKey(key);
      if (keyErr) return res.status(keyErr.status).json(keyErr);
      const labelErr = ensureRoleLabel(label);
      if (labelErr) return res.status(labelErr.status).json(labelErr);
      const dupe = await prisma.wellnessRoleType.findFirst({
        where: { tenantId: req.user.tenantId, key },
        select: { id: true },
      });
      if (dupe)
        return res
          .status(409)
          .json({
            error: `Role key "${key}" already exists`,
            code: "ROLE_KEY_DUPLICATE",
          });
      const row = await prisma.wellnessRoleType.create({
        data: {
          key,
          label,
          icon: icon || null,
          color: color || null,
          canTakeVisits:
            canTakeVisits === undefined ? true : Boolean(canTakeVisits),
          sortOrder: Number.isFinite(Number(sortOrder))
            ? parseInt(sortOrder, 10)
            : 0,
          tenantId: req.user.tenantId,
        },
      });
      try {
        await writeAudit(
          "WellnessRoleType",
          "CREATE",
          row.id,
          req.user.userId,
          req.user.tenantId,
          {
            key: row.key,
            label: row.label,
            canTakeVisits: row.canTakeVisits,
          },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.status(201).json(row);
    } catch (e) {
      console.error("[wellness] create role-type error:", e.message);
      res.status(500).json({ error: "Failed to create role type" });
    }
  },
);

router.put(
  "/role-types/:id",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.wellnessRoleType.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing)
        return res.status(404).json({ error: "Role type not found" });
      const data = {};
      if (req.body.label !== undefined) {
        const labelErr = ensureRoleLabel(req.body.label);
        if (labelErr) return res.status(labelErr.status).json(labelErr);
        data.label = req.body.label;
      }
      if (req.body.key !== undefined && req.body.key !== existing.key) {
        // Renaming the key would orphan every User with wellnessRole=oldKey.
        // Refuse if any staff currently uses it; admins can deactivate the
        // old row + create a new one + reassign staff manually.
        const inUse = await prisma.user.count({
          where: { tenantId: req.user.tenantId, wellnessRole: existing.key },
        });
        if (inUse > 0) {
          return res.status(409).json({
            error: `Cannot rename key while ${inUse} staff member(s) use it. Reassign them first.`,
            code: "ROLE_KEY_IN_USE",
          });
        }
        const keyErr = ensureRoleKey(req.body.key);
        if (keyErr) return res.status(keyErr.status).json(keyErr);
        const dupe = await prisma.wellnessRoleType.findFirst({
          where: {
            tenantId: req.user.tenantId,
            key: req.body.key,
            NOT: { id },
          },
          select: { id: true },
        });
        if (dupe)
          return res
            .status(409)
            .json({
              error: `Role key "${req.body.key}" already exists`,
              code: "ROLE_KEY_DUPLICATE",
            });
        data.key = req.body.key;
      }
      if (req.body.icon !== undefined) data.icon = req.body.icon || null;
      if (req.body.color !== undefined) data.color = req.body.color || null;
      if (req.body.canTakeVisits !== undefined)
        data.canTakeVisits = Boolean(req.body.canTakeVisits);
      if (req.body.isActive !== undefined)
        data.isActive = Boolean(req.body.isActive);
      if (req.body.sortOrder !== undefined) {
        const n = Number(req.body.sortOrder);
        if (Number.isFinite(n)) data.sortOrder = parseInt(n, 10);
      }
      const updated = await prisma.wellnessRoleType.update({
        where: { id },
        data,
      });
      try {
        const changes = diffFields(existing, updated, Object.keys(data));
        if (Object.keys(changes).length > 0) {
          await writeAudit(
            "WellnessRoleType",
            "UPDATE",
            updated.id,
            req.user.userId,
            req.user.tenantId,
            {
              changedFields: changes,
            },
          );
        }
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.json(updated);
    } catch (e) {
      console.error("[wellness] update role-type error:", e.message);
      res.status(500).json({ error: "Failed to update role type" });
    }
  },
);

router.delete(
  "/role-types/:id",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.wellnessRoleType.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing)
        return res.status(404).json({ error: "Role type not found" });
      const inUse = await prisma.user.count({
        where: { tenantId: req.user.tenantId, wellnessRole: existing.key },
      });
      if (inUse > 0) {
        return res.status(409).json({
          error: `Cannot delete role while ${inUse} staff member(s) use it. Deactivate instead or reassign staff first.`,
          code: "ROLE_IN_USE",
          inUseCount: inUse,
        });
      }
      await prisma.wellnessRoleType.delete({ where: { id } });
      try {
        await writeAudit(
          "WellnessRoleType",
          "DELETE",
          id,
          req.user.userId,
          req.user.tenantId,
          {
            key: existing.key,
            label: existing.label,
          },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("[wellness] delete role-type error:", e.message);
      res.status(500).json({ error: "Failed to delete role type" });
    }
  },
);

// ── Memberships ────────────────────────────────────────────────────
//
// Wave 11 Agent EE — Memberships (Google Doc audit, 8 May 2026).
//
// Wellness clinics sell time-bound prepaid bundles ("Gold Facial Pack:
// 10 facials over 6 months for ₹15,000"). The catalog row is a
// MembershipPlan (admin-managed); a Patient's instance is a Membership
// (with a running per-service balance); each service consumed against
// it is a MembershipRedemption row (append-only).
//
// Two JSON-string columns to read end-of-end carefully:
//   plan.entitlements   → JSON `[{ serviceId, quantity }]`
//   membership.balance  → JSON `[{ serviceId, remaining }]`
// The balance is stamped from entitlements at purchase, decremented on
// redeem. Stored stringified because (a) reads/writes always happen
// as a unit during a redemption, and (b) MySQL JSON column adoption
// is uneven in this codebase. Mirrors SequenceStep.conditionJson + AbTest
// variantA/B + the project's standing JSON-string-column rule.

// Parse + validate `entitlements` from request body. Returns either an
// error object (suitable for res.status/json) or a normalized array of
// `{ serviceId, quantity }` objects. The serviceId values are NOT yet
// confirmed to belong to this tenant — call validateEntitlementServices
// next for that round-trip.
function parseEntitlementsInput(raw) {
  if (raw == null) {
    return {
      error: {
        status: 400,
        error: "entitlements required",
        code: "ENTITLEMENTS_REQUIRED",
      },
    };
  }
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        error: {
          status: 400,
          error: "entitlements must be valid JSON",
          code: "ENTITLEMENTS_INVALID_JSON",
        },
      };
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return {
      error: {
        status: 400,
        error: "entitlements must be a non-empty array",
        code: "ENTITLEMENTS_EMPTY",
      },
    };
  }
  const seen = new Set();
  const cleaned = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      return {
        error: {
          status: 400,
          error: "each entitlement must be an object",
          code: "ENTITLEMENT_SHAPE_INVALID",
        },
      };
    }
    const sid = parseInt(item.serviceId, 10);
    const qty = parseInt(item.quantity, 10);
    if (!Number.isFinite(sid) || sid < 1) {
      return {
        error: {
          status: 400,
          error: "entitlement serviceId must be a positive integer",
          code: "ENTITLEMENT_SERVICE_INVALID",
        },
      };
    }
    if (!Number.isFinite(qty) || qty < 1) {
      return {
        error: {
          status: 400,
          error: "entitlement quantity must be ≥ 1",
          code: "ENTITLEMENT_QUANTITY_INVALID",
        },
      };
    }
    if (seen.has(sid)) {
      return {
        error: {
          status: 400,
          error: "entitlements must not repeat the same serviceId",
          code: "ENTITLEMENT_DUPLICATE_SERVICE",
        },
      };
    }
    seen.add(sid);
    cleaned.push({ serviceId: sid, quantity: qty });
  }
  return { entitlements: cleaned };
}

// Cross-tenant safety: every serviceId in entitlements must belong to
// the current tenant + be active. Refuses unknown / soft-removed / cross-
// tenant serviceIds with 400 ENTITLEMENT_SERVICE_NOT_FOUND.
async function validateEntitlementServices(req, entitlements) {
  const ids = entitlements.map((e) => e.serviceId);
  const found = await prisma.service.findMany({
    where: tenantWhere(req, { id: { in: ids } }),
    select: { id: true },
  });
  const foundIds = new Set(found.map((s) => s.id));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return {
      status: 400,
      error: `service(s) not found in this tenant: ${missing.join(", ")}`,
      code: "ENTITLEMENT_SERVICE_NOT_FOUND",
      missing,
    };
  }
  return null;
}

// GET /membership-plans — list active plans, all-roles (clinical staff
// need to read so they can offer plans to patients during the visit).
//
// When the caller has a Patient row (typical for self-service buyers and
// also wellness staff who happen to be patients), each plan in the
// response is additively annotated with ownership fields so the Available
// Plans UI can render the three-state card (never purchased / active /
// expired) in one round-trip:
//
//   hasActiveMembership      — bool, true when an unexpired active row exists
//   activeMembershipId       — int | null
//   activeMembershipEndDate  — Date | null
//   hasExpiredMembership     — bool, true when ANY prior row exists that
//                              isn't currently active (status='expired',
//                              'cancelled', or status='active' but
//                              endDate <= now per the lazy-expiry rule)
//
// Admin-only / staff-only callers without a matching Patient row get the
// legacy response shape unchanged. The added fields are additive — every
// existing consumer that destructures `id`/`name`/`price`/etc. keeps
// working without modification.
router.get("/membership-plans", async (req, res) => {
  try {
    const includeInactive =
      req.query.includeInactive === "1" || req.query.includeInactive === "true";
    const includeTeardown =
      req.query.includeTeardown === "1" || req.query.includeTeardown === "true";
    const plans = await prisma.membershipPlan.findMany({
      where: tenantWhere(req, includeInactive ? {} : { isActive: true }),
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      take: 200,
    });
    // #747 — hide test-fixture plans (_teardown_* / _test_*) from default lists
    // so staff can't accidentally sell a real membership against a test row.
    // Admin override surfaces them via ?includeTeardown=1.
    const visible = includeTeardown
      ? plans
      : plans.filter((p) => !/^_teardown_|^_test_/.test(p.name || ""));

    // Annotate with per-plan ownership for the calling user. Single query
    // joined into the response — catalog size is bounded (<50 plans, <100
    // memberships per user typically), so the overhead is negligible.
    let annotated = visible;
    if (req.user && req.user.userId && req.user.tenantId) {
      const patient = await prisma.patient.findFirst({
        where: {
          tenant: { id: req.user.tenantId },
          user: { id: req.user.userId },
        },
        select: { id: true },
      });
      if (patient) {
        const memberships = await prisma.membership.findMany({
          where: { tenantId: req.user.tenantId, patientId: patient.id },
          select: { id: true, planId: true, status: true, endDate: true },
        });
        const now = Date.now();
        const byPlan = new Map();
        for (const m of memberships) {
          if (!byPlan.has(m.planId)) byPlan.set(m.planId, []);
          byPlan.get(m.planId).push(m);
        }
        annotated = visible.map((p) => {
          const rows = byPlan.get(p.id) || [];
          if (rows.length === 0) return p;
          // Active = status === 'active' AND endDate > now. Lazy-expiry
          // means a row can have stale 'active' status past its endDate;
          // checking both fields keeps the ownership view aligned with the
          // canonical "is this membership still usable?" semantics.
          const active = rows.find(
            (m) => m.status === "active" && m.endDate.getTime() > now,
          );
          const hasAnyNonActive = rows.some(
            (m) => !(m.status === "active" && m.endDate.getTime() > now),
          );
          return {
            ...p,
            hasActiveMembership: !!active,
            activeMembershipId: active?.id ?? null,
            activeMembershipEndDate: active?.endDate ?? null,
            hasExpiredMembership: !active && hasAnyNonActive,
          };
        });
      }
    }

    res.json(annotated);
  } catch (e) {
    console.error("[wellness] list membership plans error:", e.message);
    res.status(500).json({ error: "Failed to list membership plans" });
  }
});

router.get("/membership-plans/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const plan = await prisma.membershipPlan.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!plan)
      return res.status(404).json({ error: "Membership plan not found" });
    res.json(plan);
  } catch (e) {
    console.error("[wellness] get membership plan error:", e.message);
    res.status(500).json({ error: "Failed to load membership plan" });
  }
});

// POST /membership-plans — admin/manager only (catalog mutation, mirrors
// /services pattern at line 1955).
router.post(
  "/membership-plans",
  adminOrPerm("services", "write"),
  async (req, res) => {
    try {
      const { name, description, durationDays, price, currency, entitlements } =
        req.body;
      if (!name || !String(name).trim()) {
        return res
          .status(400)
          .json({ error: "name required", code: "NAME_REQUIRED" });
      }
      const dur = parseInt(durationDays, 10);
      if (!Number.isFinite(dur) || dur < 1 || dur > 3650) {
        return res.status(400).json({
          error: "durationDays must be 1..3650",
          code: "DURATION_INVALID",
        });
      }
      const priceNum = Number(price);
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        return res.status(400).json({
          error: "price must be greater than 0",
          code: "PRICE_REQUIRED",
        });
      }
      if (priceNum > 5_000_000) {
        return res.status(400).json({
          error: "price exceeds maximum (5,000,000)",
          code: "PRICE_TOO_HIGH",
        });
      }
      const ent = parseEntitlementsInput(entitlements);
      if (ent.error) return res.status(ent.error.status).json(ent.error);
      const svcErr = await validateEntitlementServices(req, ent.entitlements);
      if (svcErr) return res.status(svcErr.status).json(svcErr);

      const plan = await prisma.membershipPlan.create({
        data: {
          name: String(name).trim(),
          description: description || null,
          durationDays: dur,
          price: priceNum,
          currency: currency || "INR",
          entitlements: JSON.stringify(ent.entitlements),
          tenantId: req.user.tenantId,
        },
      });
      try {
        await writeAudit(
          "MembershipPlan",
          "CREATE",
          plan.id,
          req.user.userId,
          req.user.tenantId,
          {
            name: plan.name,
            durationDays: plan.durationDays,
            price: plan.price,
            entitlementCount: ent.entitlements.length,
          },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      // PRD Gap §13 wave-6a — emit membership.plan_created so workflow rules
      // can react (e.g. announce a new plan to active patients via campaign).
      try {
        require("../lib/eventBus").emitEvent(
          "membership.plan_created",
          {
            planId: plan.id,
            name: plan.name,
            durationDays: plan.durationDays,
            price: plan.price,
            currency: plan.currency,
            entitlementCount: ent.entitlements.length,
          },
          req.user.tenantId,
          req.io,
        );
      } catch (_e) { }
      res.status(201).json(plan);
    } catch (e) {
      console.error("[wellness] create membership plan error:", e.message);
      const mapped = httpFromPrismaError(e);
      if (mapped) return res.status(mapped.status).json(mapped);
      res.status(500).json({ error: "Failed to create membership plan" });
    }
  },
);

router.put(
  "/membership-plans/:id",
  adminOrPerm("services", "write"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.membershipPlan.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Membership plan not found" });
      const data = {};
      if (req.body.name !== undefined) {
        if (!String(req.body.name).trim()) {
          return res
            .status(400)
            .json({ error: "name cannot be empty", code: "NAME_REQUIRED" });
        }
        data.name = String(req.body.name).trim();
      }
      if (req.body.description !== undefined)
        data.description = req.body.description || null;
      if (req.body.durationDays !== undefined) {
        const dur = parseInt(req.body.durationDays, 10);
        if (!Number.isFinite(dur) || dur < 1 || dur > 3650) {
          return res.status(400).json({
            error: "durationDays must be 1..3650",
            code: "DURATION_INVALID",
          });
        }
        data.durationDays = dur;
      }
      if (req.body.price !== undefined) {
        const priceNum = Number(req.body.price);
        if (!Number.isFinite(priceNum) || priceNum <= 0) {
          return res.status(400).json({
            error: "price must be greater than 0",
            code: "PRICE_REQUIRED",
          });
        }
        if (priceNum > 5_000_000) {
          return res.status(400).json({
            error: "price exceeds maximum (5,000,000)",
            code: "PRICE_TOO_HIGH",
          });
        }
        data.price = priceNum;
      }
      if (req.body.currency !== undefined)
        data.currency = String(req.body.currency || "INR");
      if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;
      if (req.body.entitlements !== undefined) {
        const ent = parseEntitlementsInput(req.body.entitlements);
        if (ent.error) return res.status(ent.error.status).json(ent.error);
        const svcErr = await validateEntitlementServices(req, ent.entitlements);
        if (svcErr) return res.status(svcErr.status).json(svcErr);
        data.entitlements = JSON.stringify(ent.entitlements);
      }

      const updated = await prisma.membershipPlan.update({
        where: { id },
        data,
      });
      try {
        const changes = diffFields(existing, updated, Object.keys(data));
        if (Object.keys(changes).length > 0) {
          await writeAudit(
            "MembershipPlan",
            "UPDATE",
            updated.id,
            req.user.userId,
            req.user.tenantId,
            {
              changedFields: changes,
            },
          );
        }
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.json(updated);
    } catch (e) {
      console.error("[wellness] update membership plan error:", e.message);
      const mapped = httpFromPrismaError(e);
      if (mapped) return res.status(mapped.status).json(mapped);
      res.status(500).json({ error: "Failed to update membership plan" });
    }
  },
);

// DELETE /membership-plans/:id — soft-delete (set isActive=false).
// Existing patient memberships are NOT cancelled; they keep their balance
// until expiry. Only stops new sales of this plan.
router.delete(
  "/membership-plans/:id",
  adminOrPerm("services", "write"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.membershipPlan.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Membership plan not found" });
      if (!existing.isActive) {
        return res.status(409).json({
          error: "Membership plan already inactive",
          code: "PLAN_ALREADY_INACTIVE",
        });
      }
      await prisma.membershipPlan.update({
        where: { id },
        data: { isActive: false },
      });
      try {
        await writeAudit(
          "MembershipPlan",
          "SOFT_DELETE",
          id,
          req.user.userId,
          req.user.tenantId,
          {
            name: existing.name,
          },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.json({ success: true, id });
    } catch (e) {
      console.error("[wellness] delete membership plan error:", e.message);
      res.status(500).json({ error: "Failed to delete membership plan" });
    }
  },
);

// POST /patients/:id/memberships — purchase a membership for a patient.
// Computes endDate from plan.durationDays, stamps initial balance from
// plan.entitlements. Audit-logs MEMBERSHIP_PURCHASE.
router.post("/patients/:id/memberships", phiWriteGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId, deletedAt: null }),
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const { planId, startDate, invoiceId } = req.body;
    const planIdInt = parseInt(planId, 10);
    if (!Number.isFinite(planIdInt) || planIdInt < 1) {
      return res
        .status(400)
        .json({ error: "planId required", code: "PLAN_ID_REQUIRED" });
    }
    const plan = await prisma.membershipPlan.findFirst({
      where: tenantWhere(req, { id: planIdInt }),
    });
    if (!plan)
      return res.status(404).json({ error: "Membership plan not found" });
    // #748 — never post a real purchase against a test-fixture plan, even if it
    // slipped through with isActive=true. Mirrors the #747 default-list filter.
    if (/^_teardown_|^_test_/.test(plan.name || "")) {
      return res.status(410).json({
        error: "This plan is a test fixture and cannot be purchased",
        code: "PLAN_ARCHIVED_OR_TEST",
      });
    }
    if (!plan.isActive) {
      return res
        .status(409)
        .json({ error: "Membership plan is inactive", code: "PLAN_INACTIVE" });
    }

    // Block duplicate active enrollment on the same plan. Staff workflow
    // historically allowed stacking (the priorCount → isRenewal logic
    // below treats every nth purchase as a renewal event), but per the
    // 2026-06 lifecycle requirement we now reject while an active row
    // exists and only allow re-purchase after expiry / cancellation.
    // Mirrors the /membership-plans/:id/purchase/order gate so the
    // server-side rule is enforced regardless of caller.
    const staffSideActive = await prisma.membership.findFirst({
      where: {
        tenantId: req.user.tenantId,
        patientId,
        planId: plan.id,
        status: "active",
        endDate: { gt: new Date() },
      },
      select: { id: true, endDate: true },
      orderBy: { endDate: "desc" },
    });
    if (staffSideActive) {
      return res.status(409).json({
        success: false,
        message: "Patient already has an active membership for this plan.",
        error: "Patient already has an active membership for this plan.",
        code: "MEMBERSHIP_ALREADY_ACTIVE",
        activeMembershipId: staffSideActive.id,
        activeMembershipEndDate: staffSideActive.endDate,
      });
    }

    const start = startDate ? new Date(startDate) : new Date();
    if (Number.isNaN(start.getTime())) {
      return res
        .status(400)
        .json({ error: "startDate is invalid", code: "START_DATE_INVALID" });
    }
    const end = new Date(start.getTime() + plan.durationDays * 86400000);

    // Stamp balance from plan.entitlements. JSON parse is safe because
    // we wrote the column via JSON.stringify; a malformed legacy row
    // would surface as 500 rather than a silent zero-balance.
    let entitlements;
    try {
      entitlements = JSON.parse(plan.entitlements);
    } catch {
      return res.status(500).json({
        error: "Plan entitlements are corrupt",
        code: "PLAN_ENTITLEMENTS_CORRUPT",
      });
    }
    const initialBalance = entitlements.map((e) => ({
      serviceId: e.serviceId,
      remaining: e.quantity,
    }));

    const data = {
      tenantId: req.user.tenantId,
      patientId,
      planId: plan.id,
      startDate: start,
      endDate: end,
      balance: JSON.stringify(initialBalance),
      status: "active",
    };
    if (invoiceId !== undefined && invoiceId !== null && invoiceId !== "") {
      const invIdInt = parseInt(invoiceId, 10);
      if (Number.isFinite(invIdInt)) data.invoiceId = invIdInt;
    }
    // PRD Gap §13 wave-6a — sniff whether this is a NEW enrollment or a
    // RENEWAL (prior membership of the same plan exists for this patient).
    // Used to disambiguate the `membership.enrolled` vs `membership.renewed`
    // events emitted below. Best-effort — failure to read prior memberships
    // must NOT break the purchase flow.
    let isRenewal = false;
    try {
      const priorCount = await prisma.membership.count({
        where: { tenantId: req.user.tenantId, patientId, planId: plan.id },
      });
      isRenewal = priorCount > 0;
    } catch (_e) {
      /* best-effort */
    }

    const membership = await prisma.membership.create({ data });
    try {
      await writeAudit(
        "Membership",
        "PURCHASE",
        membership.id,
        req.user.userId,
        req.user.tenantId,
        {
          patientId,
          patientName: patient.name,
          planId: plan.id,
          planName: plan.name,
          price: plan.price,
          endDate: end,
        },
      );
    } catch (auditErr) {
      console.warn("[audit]", auditErr.message);
    }
    // PRD Gap §13 wave-6a — emit membership.enrolled OR membership.renewed
    // so workflow rules can react (welcome SMS on first enrollment,
    // thank-you-for-renewing on re-purchase). Wrapped: workflow failures
    // never break the purchase response.
    try {
      require("../lib/eventBus").emitEvent(
        isRenewal ? "membership.renewed" : "membership.enrolled",
        {
          membershipId: membership.id,
          patientId,
          planId: plan.id,
          planName: plan.name,
          price: plan.price,
          startDate: start,
          endDate: end,
          isRenewal,
        },
        req.user.tenantId,
        req.io,
      );
    } catch (_e) { }
    res.status(201).json(membership);
  } catch (e) {
    console.error("[wellness] purchase membership error:", e.message);
    const mapped = httpFromPrismaError(e);
    if (mapped) return res.status(mapped.status).json(mapped);
    res.status(500).json({ error: "Failed to purchase membership" });
  }
});

// GET /patients/:id/memberships — list a patient's memberships
// (active + cancelled + expired). Includes plan name + parsed balance
// for the UI's at-a-glance render.
router.get("/patients/:id/memberships", phiReadGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    const rows = await prisma.membership.findMany({
      where: tenantWhere(req, { patientId }),
      include: {
        plan: {
          select: {
            id: true,
            name: true,
            durationDays: true,
            price: true,
            currency: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(rows);
  } catch (e) {
    console.error("[wellness] list patient memberships error:", e.message);
    res.status(500).json({ error: "Failed to list memberships" });
  }
});

// GET /memberships/:id — fetch a single membership (with redemption history).
// Numeric-only constraint so non-numeric subpaths like `/memberships/dashboard`
// (Wave 7D Memberships dashboard endpoint at line ~2698) don't collide here
// and parse as `:id="dashboard"` → 400. Express matches routes in declaration
// order; adding the regex ensures `/memberships/dashboard` falls through to
// the right handler regardless of order.
router.get("/memberships/:id(\\d+)", phiReadGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const membership = await prisma.membership.findFirst({
      where: tenantWhere(req, { id }),
      include: {
        plan: {
          select: {
            id: true,
            name: true,
            durationDays: true,
            price: true,
            currency: true,
            entitlements: true,
          },
        },
        patient: { select: { id: true, name: true } },
        redemptions: { orderBy: { redeemedAt: "desc" } },
      },
    });
    if (!membership)
      return res.status(404).json({ error: "Membership not found" });
    res.json(membership);
  } catch (e) {
    console.error("[wellness] get membership error:", e.message);
    res.status(500).json({ error: "Failed to load membership" });
  }
});

// POST /memberships/:id/redeem — redeem 1 unit of a service.
//
// Status codes:
//   200 — redeemed; returns updated balance + redemption row
//   400 — bad serviceId / shape
//   404 — membership not found
//   409 — balance exhausted for that service (MEMBERSHIP_BALANCE_EXHAUSTED)
//   410 — membership expired or cancelled (MEMBERSHIP_EXPIRED / MEMBERSHIP_CANCELLED)
//
// 410 chosen for expired (mirrors /api/wellness namespace's 410-for-Gone
// pattern at the top of this file) so the frontend can distinguish "you
// can buy a new one" from "this never existed."
router.post("/memberships/:id/redeem", phiWriteGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { serviceId, visitId } = req.body;
    const serviceIdInt = parseInt(serviceId, 10);
    if (!Number.isFinite(serviceIdInt) || serviceIdInt < 1) {
      return res
        .status(400)
        .json({ error: "serviceId required", code: "SERVICE_ID_REQUIRED" });
    }

    const membership = await prisma.membership.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!membership)
      return res.status(404).json({ error: "Membership not found" });
    if (membership.status === "cancelled") {
      return res.status(410).json({
        error: "Membership has been cancelled",
        code: "MEMBERSHIP_CANCELLED",
      });
    }
    if (
      membership.status === "expired" ||
      new Date(membership.endDate) < new Date()
    ) {
      // If the timestamp says expired but the row didn't get marked yet,
      // mark it now so subsequent reads are correct.
      const wasJustExpired = membership.status !== "expired";
      if (wasJustExpired) {
        await prisma.membership.update({
          where: { id },
          data: { status: "expired" },
        });
        // PRD Gap §13 wave-6a — emit membership.expired only on the actual
        // active→expired transition (not on every redeem attempt against an
        // already-expired row). Wrapped: workflow failure ≠ block redeem path.
        try {
          require("../lib/eventBus").emitEvent(
            "membership.expired",
            {
              membershipId: id,
              patientId: membership.patientId,
              planId: membership.planId,
              endDate: membership.endDate,
            },
            req.user.tenantId,
            req.io,
          );
        } catch (_e) { }
      }
      return res
        .status(410)
        .json({ error: "Membership has expired", code: "MEMBERSHIP_EXPIRED" });
    }

    let balance;
    try {
      balance = JSON.parse(membership.balance);
    } catch {
      return res.status(500).json({
        error: "Membership balance is corrupt",
        code: "MEMBERSHIP_BALANCE_CORRUPT",
      });
    }
    if (!Array.isArray(balance)) {
      return res.status(500).json({
        error: "Membership balance is corrupt",
        code: "MEMBERSHIP_BALANCE_CORRUPT",
      });
    }
    const line = balance.find((b) => b.serviceId === serviceIdInt);
    if (!line) {
      return res.status(409).json({
        error: "Service not covered by this membership",
        code: "MEMBERSHIP_SERVICE_NOT_COVERED",
      });
    }
    if (line.remaining <= 0) {
      return res.status(409).json({
        error: "Membership balance exhausted for this service",
        code: "MEMBERSHIP_BALANCE_EXHAUSTED",
      });
    }

    line.remaining -= 1;

    const visitIdInt =
      visitId !== undefined && visitId !== null && visitId !== ""
        ? parseInt(visitId, 10)
        : null;

    const [updatedMembership, redemption] = await prisma.$transaction([
      prisma.membership.update({
        where: { id },
        data: { balance: JSON.stringify(balance) },
      }),
      prisma.membershipRedemption.create({
        data: {
          tenantId: req.user.tenantId,
          membershipId: id,
          serviceId: serviceIdInt,
          visitId: Number.isFinite(visitIdInt) ? visitIdInt : null,
          redeemedBy: req.user.userId,
        },
      }),
    ]);

    try {
      await writeAudit(
        "Membership",
        "REDEEM",
        id,
        req.user.userId,
        req.user.tenantId,
        {
          serviceId: serviceIdInt,
          visitId: Number.isFinite(visitIdInt) ? visitIdInt : null,
          remainingForService: line.remaining,
        },
      );
    } catch (auditErr) {
      console.warn("[audit]", auditErr.message);
    }
    // PRD Gap §13 wave-6a — emit membership.benefit_applied so workflow rules
    // can react (e.g. send SMS confirming the service was redeemed against
    // the membership; trigger reminder once balance hits 1 remaining).
    try {
      require("../lib/eventBus").emitEvent(
        "membership.benefit_applied",
        {
          membershipId: id,
          patientId: membership.patientId,
          planId: membership.planId,
          serviceId: serviceIdInt,
          visitId: Number.isFinite(visitIdInt) ? visitIdInt : null,
          remainingForService: line.remaining,
          redemptionId: redemption.id,
        },
        req.user.tenantId,
        req.io,
      );
    } catch (_e) { }

    res.json({
      success: true,
      membership: updatedMembership,
      redemption,
      balance,
    });
  } catch (e) {
    console.error("[wellness] redeem membership error:", e.message);
    res.status(500).json({ error: "Failed to redeem membership" });
  }
});

// Wave 7D — GET /memberships/dashboard — PRD Gap §4 item 8.
// Three aggregates the Memberships page surfaces above its existing list:
//   - active count + total deferred-revenue value (sum of plan.price scaled
//     by remaining-balance fraction across the entitlements array)
//   - expiring-this-week count (active + endDate within next 7 days)
//   - expired count (status='expired' OR endDate < now)
// Tenant-scoped; admin/manager only (mirrors POS/staff/POS-extras gating).
//
// Deferred-revenue maths: a membership's "remaining value" is plan.price *
// (sum(b.remaining) / sum(plan_qty)). That isn't a perfect dollar-cost
// allocation per service (a £100 facial vs a £20 follow-up are valued
// equally here), but it's the simplest defensible per-row calculation and
// matches how the existing Memberships card describes value to admins.
router.get(
  "/memberships/dashboard",
  adminOrPerm("services", "read"),
  async (req, res) => {
    try {
      const now = new Date();
      const weekOut = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      const tenantId = req.user.tenantId;

      const [actives, expiringThisWeek, expiredCount] = await Promise.all([
        prisma.membership.findMany({
          where: { tenantId, status: "active", endDate: { gte: now } },
          include: { plan: { select: { price: true, entitlements: true } } },
        }),
        prisma.membership.count({
          where: {
            tenantId,
            status: "active",
            endDate: { gte: now, lte: weekOut },
          },
        }),
        prisma.membership.count({
          where: {
            tenantId,
            OR: [
              { status: "expired" },
              { AND: [{ status: "active" }, { endDate: { lt: now } }] },
            ],
          },
        }),
      ]);

      // Deferred revenue: per-membership plan.price * (remaining / planTotal).
      // Skip rows with corrupt / unparseable balances rather than failing
      // the whole aggregate — one bad row shouldn't black out the dashboard.
      let deferredRevenue = 0;
      for (const m of actives) {
        try {
          const balance = JSON.parse(m.balance || "[]");
          const plan = JSON.parse(m.plan?.entitlements || "[]");
          if (!Array.isArray(balance) || !Array.isArray(plan)) continue;
          const planTotal = plan.reduce(
            (acc, p) => acc + (parseInt(p.quantity, 10) || 0),
            0,
          );
          if (planTotal <= 0) continue;
          const remaining = balance.reduce(
            (acc, b) => acc + (parseInt(b.remaining, 10) || 0),
            0,
          );
          const fraction = Math.max(0, Math.min(1, remaining / planTotal));
          deferredRevenue += (parseFloat(m.plan?.price) || 0) * fraction;
        } catch {
          /* skip corrupt row */
        }
      }

      res.json({
        active: {
          count: actives.length,
          deferredRevenue: Math.round(deferredRevenue * 100) / 100,
        },
        expiringThisWeek: { count: expiringThisWeek },
        expired: { count: expiredCount },
        asOf: now.toISOString(),
      });
    } catch (e) {
      console.error("[wellness] memberships dashboard error:", e.message);
      res.status(500).json({ error: "Failed to load memberships dashboard" });
    }
  },
);

// POST /memberships/:id/cancel — admin cancel. Sets status='cancelled',
// stamps cancelledAt + cancelReason. Idempotent if already cancelled (200).
router.post(
  "/memberships/:id/cancel",
  adminOrPerm("services", "write"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const membership = await prisma.membership.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!membership)
        return res.status(404).json({ error: "Membership not found" });
      if (membership.status === "cancelled") {
        return res
          .status(200)
          .json({ success: true, idempotent: true, membership });
      }
      const reason = req.body.reason
        ? String(req.body.reason).slice(0, 500)
        : null;
      const updated = await prisma.membership.update({
        where: { id },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancelReason: reason,
        },
      });
      try {
        await writeAudit(
          "Membership",
          "CANCEL",
          id,
          req.user.userId,
          req.user.tenantId,
          {
            patientId: membership.patientId,
            planId: membership.planId,
            reason,
          },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      // PRD Gap §13 wave-6a — emit membership.cancelled so workflow rules can
      // react (refund-warning, win-back campaign enrollment, churn flag).
      try {
        require("../lib/eventBus").emitEvent(
          "membership.cancelled",
          {
            membershipId: id,
            patientId: membership.patientId,
            planId: membership.planId,
            reason,
            cancelledAt: updated.cancelledAt,
          },
          req.user.tenantId,
          req.io,
        );
      } catch (_e) { }
      res.json({ success: true, membership: updated });
    } catch (e) {
      console.error("[wellness] cancel membership error:", e.message);
      res.status(500).json({ error: "Failed to cancel membership" });
    }
  },
);

// ── Agent recommendations ──────────────────────────────────────────

router.get("/recommendations", async (req, res) => {
  try {
    const { status = "pending" } = req.query;
    // #308: a single logical recommendation (e.g. "Boost campaign for
    // Unshaven FUE Hair Transplant") was appearing in Pending, Approved,
    // AND Rejected tabs simultaneously because the orchestrator cron
    // emitted multiple AgentRecommendation rows with the same dedup key
    // (type + title) and the GET endpoint returned every row that
    // matched the requested status filter. Cron-side dedup from #261/
    // #285 only suppresses re-emits within the same UTC day — older
    // pollution + cross-day collisions still leak through.
    //
    // Response-level dedup: collapse rows by (type + lowercased title)
    // and keep the most-recently-resolved instance per group. When the
    // caller asks for status='pending', skip groups whose representative
    // is already approved/rejected; for terminal status filters, return
    // only the chosen representative so the same card never shows up
    // under two tabs at once.
    // Pull a wider window — we need sibling rows of any status to
    // decide whether a pending row is actually superseded.
    const all = await prisma.agentRecommendation.findMany({
      where: tenantWhere(req),
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take: 500,
    });
    const STATUS_RANK = { rejected: 3, approved: 2, snoozed: 1, pending: 0 };
    const groups = new Map();
    for (const r of all) {
      const key = `${r.type || ""}::${(r.title || "").trim().toLowerCase()}`;
      const cur = groups.get(key);
      if (!cur) {
        groups.set(key, r);
        continue;
      }
      const curRank = STATUS_RANK[cur.status] ?? 0;
      const newRank = STATUS_RANK[r.status] ?? 0;
      // Prefer a terminal (approved/rejected) representative over pending.
      // Within the same status tier, the orderBy above means `cur` already
      // wins (higher priority + newer createdAt comes first).
      if (newRank > curRank) groups.set(key, r);
    }
    const reps = Array.from(groups.values());
    const filtered =
      status === "all" ? reps : reps.filter((r) => r.status === status);
    // Keep the original ordering contract.
    filtered.sort((a, b) => {
      const pa = ["high", "medium", "low"].indexOf(a.priority);
      const pb = ["high", "medium", "low"].indexOf(b.priority);
      if (pa !== pb) return pa - pb;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
    res.json(filtered.slice(0, 50));
  } catch (e) {
    console.error("[wellness] list recommendations error:", e.message);
    res.status(500).json({ error: "Failed to list recommendations" });
  }
});

// #194: amend a recommendation while it's still pending. Once a card is
// approved/rejected the body is locked — the resolved record is the audit
// artefact for the dispatched action and shouldn't be re-written. ADMIN /
// MANAGER only since recommendations are operational, not clinical.
// #216: recommendations are owner-dashboard cards — only admin/manager can
// amend or resolve. Existing body still enforces ADMIN/MANAGER on /amend;
// the gate just makes the 403 match the rest of the wellness shape.
router.put(
  "/recommendations/:id",
  adminOrPerm("reports", "write"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await prisma.agentRecommendation.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Recommendation not found" });
      if (req.user.role !== "ADMIN" && req.user.role !== "MANAGER") {
        return res.status(403).json({
          error: "Only ADMIN or MANAGER can amend recommendations",
          code: "AMEND_FORBIDDEN",
        });
      }
      if (existing.status !== "pending" && existing.status !== "snoozed") {
        return res.status(422).json({
          error: `Cannot amend a recommendation in status '${existing.status}'`,
          code: "AMEND_TERMINAL",
          currentStatus: existing.status,
        });
      }
      const data = {};
      const allowed = [
        "title",
        "body",
        "priority",
        "expectedImpact",
        "goalContext",
        "payload",
      ];
      for (const k of allowed)
        if (req.body[k] !== undefined) data[k] = req.body[k];
      if (
        data.priority !== undefined &&
        !["low", "medium", "high"].includes(data.priority)
      ) {
        return res.status(400).json({
          error: "priority must be one of: low, medium, high",
          code: "INVALID_PRIORITY",
        });
      }
      const updated = await prisma.agentRecommendation.update({
        where: { id },
        data,
      });
      // #179: audit recommendation amendment so the trail mirrors approve/reject.
      try {
        const changes = diffFields(existing, updated, Object.keys(data));
        if (Object.keys(changes).length > 0) {
          await writeAudit(
            "AgentRecommendation",
            "UPDATE",
            updated.id,
            req.user.userId,
            req.user.tenantId,
            {
              changedFields: changes,
            },
          );
        }
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.json(updated);
    } catch (e) {
      console.error("[wellness] amend recommendation error:", e.message);
      res.status(500).json({ error: "Failed to amend recommendation" });
    }
  },
);

router.post(
  "/recommendations/:id/approve",
  adminOrPerm("reports", "write"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const rec = await prisma.agentRecommendation.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!rec)
        return res.status(404).json({ error: "Recommendation not found" });

      // #195: an already-rejected card cannot be approved without an explicit
      // /reopen flow. An already-approved card returns idempotently below
      // (count=0 path) — that branch is correct because the dispatcher must
      // not fire twice.
      if (rec.status === "rejected") {
        return res.status(422).json({
          error: "Cannot approve a rejected recommendation",
          code: "INVALID_RECOMMENDATION_TRANSITION",
          currentStatus: rec.status,
        });
      }

      // Race-safe transition: only flip pending→approved. `updateMany` with a
      // status precondition is the atomic gate — if count=0 we lost the race
      // and must NOT fire the dispatcher (double-dispatch would e.g. send
      // the SMS blast twice or create duplicate Tasks).
      const flip = await prisma.agentRecommendation.updateMany({
        where: { id, tenantId: req.user.tenantId, status: "pending" },
        data: {
          status: "approved",
          resolvedById: req.user.userId,
          resolvedAt: new Date(),
        },
      });
      const current = await prisma.agentRecommendation.findFirst({
        where: tenantWhere(req, { id }),
      });

      if (flip.count === 0) {
        // Another request already resolved this card. Return current state
        // without firing the dispatcher again. The final status is authoritative.
        // #185: surface explicit `idempotent` flag so callers can distinguish a
        // first-approve from a re-approve (the dispatcher only fires once).
        return res.json({
          ...current,
          idempotent: true,
          _alreadyResolved: true,
        });
      }

      // We won the race — safe to dispatch the approved action
      let actionResult = null;
      try {
        actionResult = await executeApproved(current, {
          actorUserId: req.user.userId,
        });
      } catch (e) {
        console.error("[orchestrator] dispatch failed:", e.message);
      }
      // #179: audit recommendation approval. We log only AFTER the race-safe
      // flip so a re-approve attempt (count=0 above) does NOT generate a row.
      await writeAudit(
        "AgentRecommendation",
        "APPROVE",
        id,
        req.user.userId,
        req.user.tenantId,
        {
          title: current.title,
          priority: current.priority,
          dispatched: actionResult != null,
        },
      );
      res.json({ ...current, _actionResult: actionResult });
    } catch (e) {
      console.error("[wellness] approve recommendation error:", e.message);
      res.status(500).json({ error: "Failed to approve" });
    }
  },
);

// Manual orchestrator trigger — useful for demos and testing
// #216: manual cron triggers were comment-claimed "Restricted to ADMIN/MANAGER"
// but had no actual gate, so a USER/doctor/telecaller could fire them. These
// dispatch SMS blasts, generate AI recommendations, and rotate orchestrator
// state — operational mutations that must require admin/manager. Add the
// missing verifyWellnessRole gate to all four manual run endpoints.
router.post(
  "/orchestrator/run",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const result = await runForTenant(req.user.tenantId);
      res.json(result);
    } catch (e) {
      console.error("[orchestrator] manual run failed:", e.message);
      res
        .status(500)
        .json({ error: "Failed to run orchestrator", detail: e.message });
    }
  },
);

// Manual triggers for the other 2 crons — for testing + demo replay.
// #216: now actually restricted to ADMIN/MANAGER (was previously only commented
// as such; no enforcement). verifyWellnessRole emits WELLNESS_ROLE_FORBIDDEN.
router.post(
  "/reminders/run",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const { processTenant } = require("../cron/appointmentRemindersEngine");
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { id: true, name: true, slug: true },
      });
      const result = await processTenant(tenant);
      res.json(result);
    } catch (e) {
      console.error("[reminders] manual run failed:", e.message);
      res
        .status(500)
        .json({ error: "Failed to run reminders", detail: e.message });
    }
  },
);

// PRD Gap §12 #4e — manual trigger for the no-show risk Notification fan-out.
// Mirrors /reminders/run shape: admin/manager only, runs the engine for the
// caller's tenant, returns { scored, flagged, notified }.
router.post(
  "/no-show-risk/run",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const {
        runNoShowRiskForTenant,
      } = require("../cron/appointmentRemindersEngine");
      const result = await runNoShowRiskForTenant(req.user.tenantId);
      res.json(result);
    } catch (e) {
      console.error("[no-show-risk] manual run failed:", e.message);
      res
        .status(500)
        .json({ error: "Failed to run no-show risk", detail: e.message });
    }
  },
);

router.post("/ops/run", adminOrPerm("settings", "manage"), async (req, res) => {
  try {
    const {
      runNpsForTenant,
      runRetentionForTenant,
      runMembershipExpiryForTenant,
    } = require("../cron/wellnessOpsEngine");
    const npsSent = await runNpsForTenant(req.user.tenantId);
    const purged = await runRetentionForTenant(req.user.tenantId);
    // PRD Gap §12 #4d — also drive the membership-expiry T-7 notifier so the
    // /ops/run trigger can be exercised end-to-end (mirrors the e2e pattern
    // used by reminders/run + low-stock/run for cron-engine specs).
    const membershipExpiry = await runMembershipExpiryForTenant(
      req.user.tenantId,
    );
    res.json({ npsSent, purged, membershipExpiry });
  } catch (e) {
    console.error("[wellness-ops] manual run failed:", e.message);
    res.status(500).json({ error: "Failed to run ops", detail: e.message });
  }
});

// Manual trigger for the low-stock inventory alert engine.
// Returns the per-tenant breakdown { products, notifications, emails }.
// #216: gate to admin/manager — emails staff and creates notifications.
router.post(
  "/inventory/low-stock/run",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const { runLowStockForTenant } = require("../cron/lowStockEngine");
      const tenant = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { id: true, slug: true, ownerEmail: true },
      });
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });
      const result = await runLowStockForTenant(tenant);
      res.json(result);
    } catch (e) {
      console.error("[low-stock] manual run failed:", e.message);
      res
        .status(500)
        .json({ error: "Failed to run low-stock alerts", detail: e.message });
    }
  },
);

router.post(
  "/recommendations/:id/reject",
  adminOrPerm("reports", "write"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const rec = await prisma.agentRecommendation.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!rec)
        return res.status(404).json({ error: "Recommendation not found" });

      // #195: enforce one-way lifecycle pending → approved | rejected. Terminal
      // statuses cannot be flipped back without an explicit /reopen flow.
      if (rec.status === "rejected") {
        return res.status(200).json({ ...rec, idempotent: true });
      }
      if (rec.status === "approved") {
        return res.status(422).json({
          error: "Cannot reject an already-approved recommendation",
          code: "INVALID_RECOMMENDATION_TRANSITION",
          currentStatus: rec.status,
        });
      }
      if (rec.status !== "pending" && rec.status !== "snoozed") {
        return res.status(422).json({
          error: `Cannot reject from status '${rec.status}'`,
          code: "INVALID_RECOMMENDATION_TRANSITION",
          currentStatus: rec.status,
        });
      }
      // Race-safe transition mirroring the /approve handler.
      const flip = await prisma.agentRecommendation.updateMany({
        where: {
          id,
          tenantId: req.user.tenantId,
          status: { in: ["pending", "snoozed"] },
        },
        data: {
          status: "rejected",
          resolvedById: req.user.userId,
          resolvedAt: new Date(),
        },
      });
      const current = await prisma.agentRecommendation.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (flip.count === 0) {
        return res.json({ ...current, idempotent: true });
      }
      // #179: audit recommendation rejection. As with /approve we only log after
      // the race-safe flip so re-rejection doesn't double-write.
      await writeAudit(
        "AgentRecommendation",
        "REJECT",
        id,
        req.user.userId,
        req.user.tenantId,
        {
          title: current.title,
          priority: current.priority,
          reason: req.body?.reason || null,
        },
      );
      res.json(current);
    } catch (e) {
      console.error("[wellness] reject recommendation error:", e.message);
      res.status(500).json({ error: "Failed to reject" });
    }
  },
);

// Validates optional geofencing fields on Location create/update. Returns
// null when valid, or an { error, code } body to send as a 400. Coordinates
// must arrive as a pair (both or neither) — a lone lat or lng can't anchor a
// geofence. Mirrors the DEFAULT_RADIUS_M note in lib/attendanceGeofence.js:
// radius is optional even when coordinates are set (falls back at punch time).
function validateGeofenceFields({ latitude, longitude, geofenceRadiusM }) {
  const hasLat = latitude !== undefined && latitude !== null && latitude !== "";
  const hasLng = longitude !== undefined && longitude !== null && longitude !== "";
  if (hasLat !== hasLng) {
    return {
      error: "Latitude and longitude must be set together",
      code: "INCOMPLETE_COORDS",
    };
  }
  if (hasLat) {
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return { error: "Latitude must be between -90 and 90", code: "INVALID_LATITUDE" };
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      return { error: "Longitude must be between -180 and 180", code: "INVALID_LONGITUDE" };
    }
  }
  if (
    geofenceRadiusM !== undefined &&
    geofenceRadiusM !== null &&
    geofenceRadiusM !== ""
  ) {
    const r = parseFloat(geofenceRadiusM);
    if (!Number.isFinite(r) || r <= 0) {
      return {
        error: "Geofence radius must be a positive number of meters",
        code: "INVALID_RADIUS",
      };
    }
  }
  return null;
}

// ── Locations (multi-clinic) ───────────────────────────────────────

router.get("/locations", async (req, res) => {
  try {
    const locations = await prisma.location.findMany({
      where: tenantWhere(req),
      orderBy: { name: "asc" },
      take: 200,
    });
    // #679: Locations carry clinic-staff phone + email + address. ADMIN /
    // MANAGER / clinical staff see full contact info (they need it to call
    // the clinic / route patients). Telecaller / helper / generic USER on a
    // wellness tenant see masked phone + email (the address itself is OK to
    // show — it's the clinic's public street address).
    const fields = ["phone", "email"];
    const out = shouldMaskForViewer(req)
      ? maskRows(locations, fields)
      : locations;
    if (!shouldMaskForViewer(req) && locations.length > 0) {
      // Emit PII_DISCLOSED audit for any caller who saw the unmasked rows.
      // Fire-and-forget; audit failures must not block the response.
      writeAudit(
        "Location",
        "PII_DISCLOSED",
        null,
        req.user.userId,
        req.user.tenantId,
        auditDisclosureDetails(req, "location_list", locations, { fields }),
      ).catch((e) =>
        console.warn(
          "[wellness] audit Location PII_DISCLOSED failed:",
          e.message,
        ),
      );
    }
    res.json(out);
  } catch (e) {
    console.error("[wellness] list locations error:", e.message);
    res.status(500).json({ error: "Failed to list locations" });
  }
});

// #216: clinic locations are operational config — admin/manager only.
router.post(
  "/locations",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const {
        name,
        addressLine,
        city,
        state,
        pincode,
        country,
        phone,
        email,
        latitude,
        longitude,
        geofenceRadiusM,
        hours,
      } = req.body;
      if (!name || !addressLine || !city) {
        return res
          .status(400)
          .json({ error: "name, addressLine, city are required" });
      }
      // #385: enforce Indian PIN code shape — exactly 6 digits when supplied.
      // Frontend caps at 6 numeric chars; this gate catches API/scripted callers
      // and any pre-existing bad input that bypassed the new pattern attribute.
      if (
        pincode !== undefined &&
        pincode !== null &&
        pincode !== "" &&
        !/^\d{6}$/.test(String(pincode))
      ) {
        return res.status(400).json({
          error: "Pincode must be exactly 6 digits",
          code: "INVALID_PINCODE",
        });
      }
      // Geofencing (wellness attendance) — lat/lng and radius are optional;
      // when supplied they must be sane values. See lib/attendanceGeofence.js
      // for how these feed the clock-in/out radius check.
      const geoErr = validateGeofenceFields({ latitude, longitude, geofenceRadiusM });
      if (geoErr) return res.status(400).json(geoErr);
      const loc = await prisma.location.create({
        data: {
          name,
          addressLine,
          city,
          state: state || null,
          pincode: pincode || null,
          country: country || "India",
          phone: phone || null,
          email: email || null,
          latitude:
            latitude !== undefined && latitude !== null && latitude !== ""
              ? parseFloat(latitude)
              : null,
          longitude:
            longitude !== undefined && longitude !== null && longitude !== ""
              ? parseFloat(longitude)
              : null,
          geofenceRadiusM:
            geofenceRadiusM !== undefined &&
            geofenceRadiusM !== null &&
            geofenceRadiusM !== ""
              ? Math.round(parseFloat(geofenceRadiusM))
              : null,
          hours: hours
            ? typeof hours === "object"
              ? JSON.stringify(hours)
              : hours
            : null,
          tenantId: req.user.tenantId,
        },
      });
      // #179: clinic location config — audit so changes to addresses / hours are traceable.
      try {
        await writeAudit(
          "Location",
          "CREATE",
          loc.id,
          req.user.userId,
          req.user.tenantId,
          {
            name: loc.name,
            city: loc.city,
            state: loc.state,
          },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.status(201).json(loc);
    } catch (e) {
      console.error("[wellness] create location error:", e.message);
      res.status(500).json({ error: "Failed to create location" });
    }
  },
);

router.put(
  "/locations/:id",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await prisma.location.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Location not found" });

      const data = {};
      const allowed = [
        "name",
        "addressLine",
        "city",
        "state",
        "pincode",
        "country",
        "phone",
        "email",
        "latitude",
        "longitude",
        "geofenceRadiusM",
        "hours",
        "isActive",
      ];
      for (const k of allowed)
        if (req.body[k] !== undefined) data[k] = req.body[k];

      // #385: same 6-digit guard on PUT so partial updates can't bypass the rule.
      if (
        data.pincode !== undefined &&
        data.pincode !== null &&
        data.pincode !== "" &&
        !/^\d{6}$/.test(String(data.pincode))
      ) {
        return res.status(400).json({
          error: "Pincode must be exactly 6 digits",
          code: "INVALID_PINCODE",
        });
      }

      // Same geofencing validation as POST. Uses the EXISTING row's
      // lat/lng/radius as fallback for fields not present in this partial
      // update, so e.g. patching just `geofenceRadiusM` doesn't get flagged
      // as INCOMPLETE_COORDS against an already-complete pair.
      const geoErr = validateGeofenceFields({
        latitude: data.latitude !== undefined ? data.latitude : existing.latitude,
        longitude: data.longitude !== undefined ? data.longitude : existing.longitude,
        geofenceRadiusM:
          data.geofenceRadiusM !== undefined
            ? data.geofenceRadiusM
            : existing.geofenceRadiusM,
      });
      if (geoErr) return res.status(400).json(geoErr);

      if (data.latitude !== undefined) {
        data.latitude = data.latitude === null || data.latitude === "" ? null : parseFloat(data.latitude);
      }
      if (data.longitude !== undefined) {
        data.longitude = data.longitude === null || data.longitude === "" ? null : parseFloat(data.longitude);
      }
      if (data.geofenceRadiusM !== undefined) {
        data.geofenceRadiusM =
          data.geofenceRadiusM === null || data.geofenceRadiusM === ""
            ? null
            : Math.round(parseFloat(data.geofenceRadiusM));
      }

      const updated = await prisma.location.update({ where: { id }, data });
      // #179: audit the changed fields only.
      try {
        const changes = diffFields(existing, updated, Object.keys(data));
        if (Object.keys(changes).length > 0) {
          await writeAudit(
            "Location",
            "UPDATE",
            updated.id,
            req.user.userId,
            req.user.tenantId,
            {
              changedFields: changes,
            },
          );
        }
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.json(updated);
    } catch (e) {
      console.error("[wellness] update location error:", e.message);
      res.status(500).json({ error: "Failed to update location" });
    }
  },
);

// DELETE /api/wellness/locations/:id — hard-delete a clinic location.
// Refuses with 409 LOCATION_IN_USE when any FK-bearing child (patient,
// visit, resource, holiday, register) still references the row. The
// caller should soft-disable via PUT { isActive: false } in that case
// instead — preserves PHI links and historical reporting integrity.
// Same admin-only gate as POST/PUT (clinic config is operational).
router.delete(
  "/locations/:id",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.location.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing) {
        return res.status(404).json({ error: "Location not found" });
      }

      // Count every child relation that has a FK to Location. Even one
      // reference would otherwise cause Prisma to throw a P2003 FK
      // violation under the schema's default onDelete: NoAction — we
      // surface a friendly 409 instead so the UI can guide the operator
      // toward the soft-disable affordance.
      const [patients, visits, resources, holidays, registers] =
        await Promise.all([
          prisma.patient.count({
            where: { locationId: id, tenantId: req.user.tenantId },
          }),
          prisma.visit.count({
            where: { locationId: id, tenantId: req.user.tenantId },
          }),
          prisma.resource.count({
            where: { locationId: id, tenantId: req.user.tenantId },
          }),
          prisma.holiday.count({
            where: { locationId: id, tenantId: req.user.tenantId },
          }),
          prisma.register.count({
            where: { locationId: id, tenantId: req.user.tenantId },
          }),
        ]);
      const total = patients + visits + resources + holidays + registers;
      if (total > 0) {
        return res.status(409).json({
          error: `Cannot delete "${existing.name}" — ${total} record(s) still reference it. Deactivate it instead.`,
          code: "LOCATION_IN_USE",
          inUse: { patients, visits, resources, holidays, registers },
        });
      }

      await prisma.location.delete({ where: { id } });
      try {
        await writeAudit(
          "Location",
          "DELETE",
          id,
          req.user.userId,
          req.user.tenantId,
          { name: existing.name, city: existing.city },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.json({ ok: true });
    } catch (e) {
      console.error("[wellness] delete location error:", e.message);
      res.status(500).json({ error: "Failed to delete location" });
    }
  },
);

// ── Staff ↔ Location assignment (geo-tagged attendance) ─────────────
//
// UserLocation is a many-to-many join between User and Location — see the
// schema comment at prisma/schema.prisma's UserLocation model. A staff
// member with NO rows here is not geofenced at all (attendance.js's
// resolveGeofenceContext treats [] as "not enforced"); one row enforces a
// single clinic; multiple rows let the punch succeed from ANY of them (e.g.
// a doctor splitting time across two locations). Admin/manager only, same
// gate as clinic location config itself.
//
// #348 namespacing rule (see docs/API_NAMESPACING.md): /api/wellness/* is
// clinical-resources-only, and org resources like staff have NO wellness
// alias — router.all("/staff/*", ...) above 410s any /wellness/staff/*
// path unconditionally. This endpoint is about the Location side of the
// relationship (which clinics is this user geofenced to), so it's namespaced
// under /location-assignments/:userId rather than /staff/:userId/locations
// to stay clear of that guard and the org/clinical split it enforces.
router.get(
  "/location-assignments/:userId",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      const target = await prisma.user.findFirst({
        where: { id: userId, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!target) return res.status(404).json({ error: "Staff member not found" });

      const rows = await prisma.userLocation.findMany({
        where: { userId, location: { tenantId: req.user.tenantId } },
        select: { location: { select: { id: true, name: true, city: true } } },
      });
      res.json({ locations: rows.map((r) => r.location) });
    } catch (e) {
      console.error("[wellness] get staff locations error:", e.message);
      res.status(500).json({ error: "Failed to load staff locations" });
    }
  },
);

router.put(
  "/location-assignments/:userId",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      const target = await prisma.user.findFirst({
        where: { id: userId, tenantId: req.user.tenantId },
        select: { id: true, name: true },
      });
      if (!target) return res.status(404).json({ error: "Staff member not found" });

      const { locationIds } = req.body;
      if (!Array.isArray(locationIds)) {
        return res.status(400).json({ error: "locationIds must be an array" });
      }
      const ids = [...new Set(locationIds.map((n) => parseInt(n, 10)))].filter(Number.isFinite);

      // Verify every id belongs to this tenant before wiring — prevents an
      // admin from (even accidentally) assigning staff to another tenant's
      // clinic via a crafted id.
      if (ids.length > 0) {
        const owned = await prisma.location.count({
          where: { id: { in: ids }, tenantId: req.user.tenantId },
        });
        if (owned !== ids.length) {
          return res.status(400).json({ error: "One or more locations not found", code: "INVALID_LOCATION_ID" });
        }
      }

      // Replace-all semantics inside a transaction — simplest correct model
      // for a small per-user assignment set (staff are rarely assigned to
      // more than a handful of clinics).
      await prisma.$transaction([
        prisma.userLocation.deleteMany({ where: { userId } }),
        ...ids.map((locationId) =>
          prisma.userLocation.create({ data: { userId, locationId } }),
        ),
      ]);

      try {
        await writeAudit(
          "UserLocation",
          "UPDATE",
          userId,
          req.user.userId,
          req.user.tenantId,
          { staffName: target.name, locationIds: ids },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }

      const rows = await prisma.userLocation.findMany({
        where: { userId },
        select: { location: { select: { id: true, name: true, city: true } } },
      });
      res.json({ locations: rows.map((r) => r.location) });
    } catch (e) {
      console.error("[wellness] set staff locations error:", e.message);
      res.status(500).json({ error: "Failed to update staff locations" });
    }
  },
);

// -- Resource availability: Resources / Holidays / WorkingHours -----
//
// Wave 11 Agent GG. Closes the Google Doc audit gap (8 May 2026): wellness
// Calendar SYNC was complete but resource AVAILABILITY was missing - no
// Resource model, no Holiday calendar, no per-doctor WorkingHours. The
// 4-class conflict envelope helper lives in backend/lib/bookingAvailability.js
// and is wired into POST/PUT visits above.

router.get(
  "/resources",
  verifyWellnessRole(
    ["clinical", "doctor", "professional", "telecaller", "admin", "manager"],
    {
      // Resources back the Calendar page (calendar.read), Appointments
      // list (appointments.read), My Appointments (my_appointments.read),
      // Book Appointment (book_appointment.write), Waitlist (waitlist.read),
      // the Resources admin page (settings.read), and any clinical surface
      // that needs to check room availability. Any one of these grants
      // unlocks the endpoint so admins don't have to grant an exact-
      // matching permission — just the permission for the page the user
      // is trying to use.
      anyOfPermissions: [
        { module: "calendar", action: "read" },
        { module: "appointments", action: "read" },
        { module: "my_appointments", action: "read" },
        { module: "book_appointment", action: "write" },
        { module: "waitlist", action: "read" },
        { module: "settings", action: "read" },
        { module: "patients", action: "read" },
        { module: "visits", action: "read" },
      ],
    },
  ),
  async (req, res) => {
    try {
      const where = tenantWhere(req);
      if (req.query.locationId !== undefined && req.query.locationId !== "") {
        where.locationId = parseInt(req.query.locationId, 10) || null;
      }
      if (req.query.activeOnly === "1" || req.query.activeOnly === "true") {
        where.isActive = true;
      }
      const rows = await prisma.resource.findMany({
        where,
        orderBy: { name: "asc" },
      });
      res.json(rows);
    } catch (e) {
      console.error("[wellness] list resources error:", e.message);
      res.status(500).json({ error: "Failed to list resources" });
    }
  },
);

router.post(
  "/resources",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const { name, type, locationId, isActive, serviceIds } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return res
          .status(400)
          .json({ error: "name is required", code: "NAME_REQUIRED" });
      }
      const allowedTypes = new Set(["ROOM", "MACHINE", "EQUIPMENT"]);
      if (
        type !== undefined &&
        type !== null &&
        type !== "" &&
        !allowedTypes.has(type)
      ) {
        return res.status(400).json({
          error: "type must be one of: " + [...allowedTypes].join(", "),
          code: "INVALID_TYPE",
        });
      }
      let serviceIdsCol = null;
      if (serviceIds !== undefined && serviceIds !== null) {
        serviceIdsCol = Array.isArray(serviceIds)
          ? JSON.stringify(serviceIds)
          : String(serviceIds);
      }
      const row = await prisma.resource.create({
        data: {
          name: name.trim(),
          type: type || "ROOM",
          locationId: locationId ? parseInt(locationId, 10) : null,
          isActive: isActive !== false,
          serviceIds: serviceIdsCol,
          tenantId: req.user.tenantId,
        },
      });
      try {
        await writeAudit(
          "Resource",
          "CREATE",
          row.id,
          req.user.userId,
          req.user.tenantId,
          { name: row.name, type: row.type, locationId: row.locationId },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.status(201).json(row);
    } catch (e) {
      console.error("[wellness] create resource error:", e.message);
      const mapped = httpFromPrismaError(e);
      if (mapped) return res.status(mapped.status).json(mapped);
      res.status(500).json({ error: "Failed to create resource" });
    }
  },
);

router.put(
  "/resources/:id",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.resource.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Resource not found" });
      const data = {};
      const allowed = ["name", "type", "locationId", "isActive", "serviceIds"];
      for (const k of allowed)
        if (req.body[k] !== undefined) data[k] = req.body[k];
      if (data.type !== undefined) {
        const allowedTypes = new Set(["ROOM", "MACHINE", "EQUIPMENT"]);
        if (!allowedTypes.has(data.type))
          return res.status(400).json({
            error: "type must be one of: " + [...allowedTypes].join(", "),
            code: "INVALID_TYPE",
          });
      }
      if (data.serviceIds !== undefined && data.serviceIds !== null) {
        data.serviceIds = Array.isArray(data.serviceIds)
          ? JSON.stringify(data.serviceIds)
          : String(data.serviceIds);
      }
      if (data.locationId !== undefined)
        data.locationId = data.locationId
          ? parseInt(data.locationId, 10)
          : null;
      const updated = await prisma.resource.update({ where: { id }, data });
      try {
        const changes = diffFields(existing, updated, Object.keys(data));
        if (Object.keys(changes).length > 0)
          await writeAudit(
            "Resource",
            "UPDATE",
            updated.id,
            req.user.userId,
            req.user.tenantId,
            { changedFields: changes },
          );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.json(updated);
    } catch (e) {
      console.error("[wellness] update resource error:", e.message);
      const mapped = httpFromPrismaError(e);
      if (mapped) return res.status(mapped.status).json(mapped);
      res.status(500).json({ error: "Failed to update resource" });
    }
  },
);

router.delete(
  "/resources/:id",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.resource.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Resource not found" });
      await prisma.resource.delete({ where: { id } });
      try {
        await writeAudit(
          "Resource",
          "DELETE",
          id,
          req.user.userId,
          req.user.tenantId,
          { name: existing.name, type: existing.type },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.status(204).end();
    } catch (e) {
      console.error("[wellness] delete resource error:", e.message);
      res.status(500).json({ error: "Failed to delete resource" });
    }
  },
);

router.get(
  "/holidays",
  verifyWellnessRole(
    ["clinical", "doctor", "professional", "telecaller", "admin", "manager"],
    {
      // Holidays back the Calendar page + Holidays admin page. Any clinical
      // or scheduling-related read grant unlocks the endpoint so partial
      // permission sets don't strand the user on a half-loaded calendar.
      anyOfPermissions: [
        { module: "calendar", action: "read" },
        { module: "appointments", action: "read" },
        { module: "my_appointments", action: "read" },
        { module: "book_appointment", action: "write" },
        { module: "waitlist", action: "read" },
        { module: "settings", action: "read" },
        { module: "patients", action: "read" },
        { module: "visits", action: "read" },
      ],
    },
  ),
  async (req, res) => {
    try {
      const { from, to } = req.query;
      // Two-bucket fetch: (a) date-bounded non-recurring rows, (b) all
      // recurringAnnually rows for the tenant (small set; client renders
      // them as "every year on MM-DD"). Without (b), an annual holiday
      // stored in 2026 disappears from the list in 2027.
      const baseWhere = tenantWhere(req);
      const dateBoundWhere = { ...baseWhere };
      if (from || to) {
        dateBoundWhere.date = {};
        if (from) dateBoundWhere.date.gte = new Date(from);
        if (to) dateBoundWhere.date.lte = new Date(to);
      }
      const [bounded, recurring] = await Promise.all([
        prisma.holiday.findMany({
          where: { ...dateBoundWhere, recurringAnnually: false },
          orderBy: { date: "asc" },
        }),
        prisma.holiday.findMany({
          where: { ...baseWhere, recurringAnnually: true },
          orderBy: { date: "asc" },
        }),
      ]);
      // Recurring annuals are stored at the original year's anchor date; to
      // appear in [from, to] their MM-DD must produce an occurrence inside
      // the window for SOME year in the spanning range. Pre-fix the recurring
      // list was returned unfiltered for any from/to query, so an Aug-15
      // Independence Day surfaced as "today's holiday" on May 21 etc.
      let recurringInWindow = recurring;
      if (from && to) {
        const fromDate = new Date(from);
        const toDate = new Date(to);
        if (
          !Number.isNaN(fromDate.getTime()) &&
          !Number.isNaN(toDate.getTime())
        ) {
          const fromMs = fromDate.getTime();
          const toMs = toDate.getTime();
          recurringInWindow = recurring.filter((h) => {
            const hd = new Date(h.date);
            const hM = hd.getUTCMonth();
            const hD = hd.getUTCDate();
            for (
              let y = fromDate.getUTCFullYear();
              y <= toDate.getUTCFullYear();
              y++
            ) {
              const occMs = Date.UTC(y, hM, hD);
              if (occMs >= fromMs && occMs <= toMs) return true;
            }
            return false;
          });
        }
      }
      // De-dupe in case a recurring holiday also falls inside the bounded
      // window (it would otherwise appear twice).
      const seen = new Set();
      const out = [];
      for (const r of [...recurringInWindow, ...bounded]) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
      out.sort((a, b) => new Date(a.date) - new Date(b.date));
      res.json(out);
    } catch (e) {
      console.error("[wellness] list holidays error:", e.message);
      res.status(500).json({ error: "Failed to list holidays" });
    }
  },
);

router.post(
  "/holidays",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const { date, name, locationId, doctorId, recurringAnnually } = req.body;
      if (!date)
        return res
          .status(400)
          .json({ error: "date is required", code: "DATE_REQUIRED" });
      if (!name || typeof name !== "string" || !name.trim())
        return res
          .status(400)
          .json({ error: "name is required", code: "NAME_REQUIRED" });
      const istDay = formatInTenantTZ(
        new Date(date),
        "Asia/Kolkata",
        "yyyy-MM-dd",
      );
      const anchored = new Date(istDay + "T00:00:00.000Z");
      const row = await prisma.holiday.create({
        data: {
          date: anchored,
          name: name.trim(),
          locationId: locationId ? parseInt(locationId, 10) : null,
          doctorId: doctorId ? parseInt(doctorId, 10) : null,
          recurringAnnually: Boolean(recurringAnnually),
          tenantId: req.user.tenantId,
        },
      });
      try {
        await writeAudit(
          "Holiday",
          "CREATE",
          row.id,
          req.user.userId,
          req.user.tenantId,
          {
            date: row.date,
            name: row.name,
            locationId: row.locationId,
            doctorId: row.doctorId,
            recurringAnnually: row.recurringAnnually,
          },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.status(201).json(row);
    } catch (e) {
      console.error("[wellness] create holiday error:", e.message);
      const mapped = httpFromPrismaError(e);
      if (mapped) return res.status(mapped.status).json(mapped);
      res.status(500).json({ error: "Failed to create holiday" });
    }
  },
);

router.delete(
  "/holidays/:id",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.holiday.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Holiday not found" });
      await prisma.holiday.delete({ where: { id } });
      try {
        await writeAudit(
          "Holiday",
          "DELETE",
          id,
          req.user.userId,
          req.user.tenantId,
          { name: existing.name, date: existing.date },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.status(204).end();
    } catch (e) {
      console.error("[wellness] delete holiday error:", e.message);
      res.status(500).json({ error: "Failed to delete holiday" });
    }
  },
);

router.get(
  "/working-hours",
  verifyWellnessRole(
    ["clinical", "doctor", "professional", "telecaller", "admin", "manager"],
    {
      // Working hours back the Calendar page + admin config page. Same
      // wide read set as resources/holidays so partial permissions don't
      // 403 calendar peripherals.
      anyOfPermissions: [
        { module: "calendar", action: "read" },
        { module: "appointments", action: "read" },
        { module: "my_appointments", action: "read" },
        { module: "book_appointment", action: "write" },
        { module: "waitlist", action: "read" },
        { module: "settings", action: "read" },
        { module: "patients", action: "read" },
        { module: "visits", action: "read" },
      ],
    },
  ),
  async (req, res) => {
    try {
      const where = tenantWhere(req);
      if (req.query.doctorId !== undefined && req.query.doctorId !== "")
        where.doctorId = parseInt(req.query.doctorId, 10);
      const rows = await prisma.workingHours.findMany({
        where,
        orderBy: [{ doctorId: "asc" }, { dayOfWeek: "asc" }],
      });
      res.json(rows);
    } catch (e) {
      console.error("[wellness] list working-hours error:", e.message);
      res.status(500).json({ error: "Failed to list working hours" });
    }
  },
);

router.put(
  "/working-hours/:doctorId",
  adminOrPerm("settings", "manage"),
  async (req, res) => {
    try {
      const doctorId = parseInt(req.params.doctorId, 10);
      if (!Number.isFinite(doctorId) || doctorId < 1)
        return res.status(400).json({
          error: "doctorId must be a positive integer",
          code: "INVALID_DOCTOR_ID",
        });
      const { schedule } = req.body;
      if (!Array.isArray(schedule))
        return res.status(400).json({
          error: "schedule must be an array",
          code: "SCHEDULE_REQUIRED",
        });
      const HHMM = /^\d{2}:\d{2}$/;
      for (const s of schedule) {
        if (!Number.isFinite(s.dayOfWeek) || s.dayOfWeek < 0 || s.dayOfWeek > 6)
          return res.status(400).json({
            error: "dayOfWeek must be 0..6",
            code: "INVALID_DAY_OF_WEEK",
          });
        if (!HHMM.test(s.startTime) || !HHMM.test(s.endTime))
          return res.status(400).json({
            error: "startTime/endTime must be HH:mm",
            code: "INVALID_TIME",
          });
        if (s.startTime >= s.endTime)
          return res.status(400).json({
            error: "endTime must be after startTime",
            code: "INVERTED_TIME_RANGE",
          });
      }
      const doctor = await prisma.user.findFirst({
        where: { id: doctorId, tenantId: req.user.tenantId },
      });
      if (!doctor)
        return res.status(404).json({ error: "Doctor not found in tenant" });
      await prisma.$transaction(async (tx) => {
        await tx.workingHours.deleteMany({
          where: { tenantId: req.user.tenantId, doctorId },
        });
        for (const s of schedule) {
          await tx.workingHours.create({
            data: {
              tenantId: req.user.tenantId,
              doctorId,
              dayOfWeek: s.dayOfWeek,
              startTime: s.startTime,
              endTime: s.endTime,
              isActive: s.isActive !== false,
            },
          });
        }
      });
      const rows = await prisma.workingHours.findMany({
        where: { tenantId: req.user.tenantId, doctorId },
        orderBy: { dayOfWeek: "asc" },
      });
      try {
        await writeAudit(
          "WorkingHours",
          "UPDATE",
          doctorId,
          req.user.userId,
          req.user.tenantId,
          { doctorId, scheduleCount: rows.length },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }
      res.json(rows);
    } catch (e) {
      console.error("[wellness] put working-hours error:", e.message);
      const mapped = httpFromPrismaError(e);
      if (mapped) return res.status(mapped.status).json(mapped);
      res.status(500).json({ error: "Failed to update working hours" });
    }
  },
);
// ── Reports: P&L per service / per-professional / per-location ─────
//
// All reports accept ?from=&to=&locationId= filters. Default window: last 30 days.

// #210: date-range guard for /reports endpoints. The picker accepts 5-digit
// years (e.g. 11900) and inverted ranges (from > to) silently, so reports
// render ₹0 / "No data" with no warning. Returns { error } on bad input
// so callers can return 400; otherwise { from, to } as before.
const MIN_REPORT_YEAR = 2000;
const MAX_REPORT_YEAR = 2099;
// #234 fix: when the client sends to=YYYY-MM-DD (no time part), treat it as
// end-of-day in UTC instead of midnight start-of-day. Without this, every
// visit / consumption row created LATER on the to-date is silently excluded —
// which made P&L productCost = ₹0 because the only consumption-bearing visits
// (388/389/397/398) were on 2026-04-26 13:40-13:56 and got dropped when the
// client sent to=2026-04-26 ⇒ parsed as 2026-04-26T00:00:00Z. Same off-by-
// one was deflating visit counts + revenue across all 4 reports tabs.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const reportRange = (req) => {
  const rawTo = req.query.to;
  const to = rawTo ? new Date(rawTo) : new Date();
  if (rawTo && DATE_ONLY.test(rawTo)) to.setUTCHours(23, 59, 59, 999);
  const rawFrom = req.query.from;
  const from = rawFrom
    ? new Date(rawFrom)
    : new Date(Date.now() - 30 * 86400000);
  if (rawFrom && DATE_ONLY.test(rawFrom)) from.setUTCHours(0, 0, 0, 0);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return {
      error: {
        status: 400,
        error: "from and to must be valid dates",
        code: "INVALID_DATE_RANGE",
      },
    };
  }
  const fromY = from.getUTCFullYear();
  const toY = to.getUTCFullYear();
  if (
    fromY < MIN_REPORT_YEAR ||
    fromY > MAX_REPORT_YEAR ||
    toY < MIN_REPORT_YEAR ||
    toY > MAX_REPORT_YEAR
  ) {
    return {
      error: {
        status: 400,
        error: `year must be between ${MIN_REPORT_YEAR} and ${MAX_REPORT_YEAR}`,
        code: "DATE_OUT_OF_RANGE",
      },
    };
  }
  if (from.getTime() > to.getTime()) {
    return {
      error: {
        status: 400,
        error: "'from' must be on or before 'to'",
        code: "INVERTED_DATE_RANGE",
      },
    };
  }
  return { from, to };
};

// #207/#216: org-wide financial reports must not leak to clinical staff.
// Doctors / professionals see their own slice via /per-professional? but
// the unfiltered P&L view stays admin/manager.
// #232: every reports tab reads from the same completed-visit window. To
// stop the four tabs from disagreeing on the headline "visits" count,
// each endpoint surfaces the canonical total separately from its per-row
// breakdown — and surfaces `unbucketed` when rows don't sum to the total
// (e.g. visits without a serviceId, doctorId, locationId, or whose join
// target was deleted). The unbucketed count is what was previously
// silently dropped from every tab independently, which is what produced
// the 87 / 80 / 111 disagreement.
//
// #565 (Wave 9 Agent A, 2026-05-10): the headline `revenue` figure is now
// computed via the shared `sumCompleted()` helper from lib/pnlMath.js so
// /reports/pnl-by-service, /reports/per-professional, /reports/per-location
// AND the Owner-Dashboard yesterday-revenue tile read from the SAME
// definition (sum(amountCharged) where status='completed'). Pre-this,
// canonicalVisitTotals included revenue from cancelled / no-show visits
// whose amountCharged was set when the visit was first scheduled —
// inflating every tab's headline by the cancellation rate.
//
// `visits` count remains unfiltered (matches whatever the route passed in)
// so #281's "+N visits without service" footnote math still works (the
// footnote needs the row-bucketed visits to be a subset of canonical
// visits — which means canonical can't be status-filtered).
const { sumCompleted: pnlSumCompleted } = require("../lib/pnlMath");

function canonicalVisitTotals(visits) {
  const completed = pnlSumCompleted(visits);
  return {
    visits: visits.length,
    revenue: completed.revenue,
    completedCount: completed.count,
  };
}

// #227: each report's calc body is extracted into a pure helper so the JSON
// endpoint AND the new CSV/PDF export endpoints can share a single source of
// truth. Helpers return the same shape the JSON endpoint sent, plus a
// `range` block ({ from, to, locationId }) the export wrappers use to
// build human-readable filenames + PDF subtitles.

async function computePnlByService(req) {
  const tenantId = req.user.tenantId;
  const _rr = reportRange(req);
  if (_rr.error) return { error: _rr.error };
  const { from, to } = _rr;
  const locationId = req.query.locationId
    ? parseInt(req.query.locationId)
    : undefined;

  const visitWhere = {
    tenantId,
    visitDate: { gte: from, lte: to },
    status: "completed",
  };
  if (locationId) visitWhere.locationId = locationId;

  const visits = await prisma.visit.findMany({
    where: visitWhere,
    // #212: id was missing here, so visitIdToCost[v.id || -1] always
    // resolved to -1 → 0 for every row, making PRODUCT COST ₹0
    // and CONTRIBUTION = REVENUE on every service.
    // #565 (Wave 9 Agent A) follow-up: status is required because
    // pnlSumCompleted defensively re-applies the status='completed' filter.
    // Without it every row's v.status is undefined and the helper drops
    // them all → canonical.revenue=0 (visits already pre-filtered by the
    // WHERE above, but the helper doesn't trust that).
    select: {
      id: true,
      status: true,
      serviceId: true,
      amountCharged: true,
      doctorId: true,
    },
  });
  const services = await prisma.service.findMany({
    where: { tenantId },
    select: {
      id: true,
      name: true,
      category: true,
      ticketTier: true,
      basePrice: true,
    },
  });
  // Gap #23: filter consumptions by their visit's visitDate, not by the
  // consumption's createdAt. A consumption logged on day N+1 against a
  // visit on day N would otherwise roll into N+1's productCost, desyncing
  // revenue (visitDate-based) from cost (createdAt-based).
  const consumptionWhere = {
    tenantId,
    visit: { visitDate: { gte: from, lte: to }, status: "completed" },
  };
  if (locationId) consumptionWhere.visit.locationId = locationId;
  const consumptions = await prisma.serviceConsumption.findMany({
    where: consumptionWhere,
    select: { visitId: true, qty: true, unitCost: true },
  });
  const visitIdToCost = {};
  for (const c of consumptions) {
    visitIdToCost[c.visitId] =
      (visitIdToCost[c.visitId] || 0) + c.qty * c.unitCost;
  }

  const acc = {};
  for (const v of visits) {
    if (!v.serviceId) continue;
    const s = services.find((x) => x.id === v.serviceId);
    if (!s) continue;
    if (!acc[s.id])
      acc[s.id] = {
        id: s.id,
        name: s.name,
        category: s.category,
        ticketTier: s.ticketTier,
        count: 0,
        revenue: 0,
        productCost: 0,
      };
    acc[s.id].count += 1;
    acc[s.id].revenue += parseFloat(v.amountCharged) || 0;
    acc[s.id].productCost += visitIdToCost[v.id || -1] || 0;
  }
  const rows = Object.values(acc)
    .map((r) => ({ ...r, contribution: r.revenue - r.productCost }))
    .sort((a, b) => b.revenue - a.revenue);

  // #281 fix: header KPI cards must equal the sum of the displayed
  // rows. Previously we surfaced `canonical.visits` / `canonical.revenue`
  // (all completed visits including those with no serviceId) in the
  // header but only summed the bucketed rows in productCost /
  // contribution. The result: a 116-vs-90 visit mismatch and a ₹27k
  // revenue discrepancy that destroyed the Owner's trust in the report.
  // We now sum the rows for all four header cards and surface the
  // canonical / unbucketed counts separately as `canonical` so the
  // frontend can render a "+N visits without service" footnote without
  // contaminating the headline KPIs.
  const canonical = canonicalVisitTotals(visits);
  const bucketedVisits = rows.reduce((s, r) => s + r.count, 0);
  const bucketedRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const bucketedProductCost = rows.reduce((s, r) => s + r.productCost, 0);
  const bucketedContribution = rows.reduce((s, r) => s + r.contribution, 0);
  const servicesSummary = rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    ticketTier: r.ticketTier,
    count: r.count,
  }));
  return {
    window: { from, to, locationId: locationId || null },
    totals: {
      visits: bucketedVisits,
      revenue: bucketedRevenue,
      productCost: bucketedProductCost,
      contribution: bucketedContribution,
      unbucketed: canonical.visits - bucketedVisits,
    },
    canonical: {
      visits: canonical.visits,
      revenue: canonical.revenue,
    },
    // #565 (HI-16): canonical revenue scalar surfaced at the top level so
    // OwnerDashboard's "today's revenue" KPI and /wellness/reports's P&L
    // tab read from the same field. Equals sum(rows[].revenue) — the
    // bucketed-by-service total, which is what the report's Revenue
    // column displays. Pre-fix, OwnerDashboard pulled its revenue from
    // /api/wellness/dashboard's own client-side aggregation, producing
    // a different figure than the P&L page for the same window.
    totalRevenue: bucketedRevenue,
    servicesSummary,
    rows,
  };
}

async function computePerProfessional(req) {
  const tenantId = req.user.tenantId;
  const _rr = reportRange(req);
  if (_rr.error) return { error: _rr.error };
  const { from, to } = _rr;
  const locationId = req.query.locationId
    ? parseInt(req.query.locationId)
    : undefined;

  const visitWhere = {
    tenantId,
    visitDate: { gte: from, lte: to },
    status: "completed",
  };
  if (locationId) visitWhere.locationId = locationId;

  const visits = await prisma.visit.findMany({
    where: visitWhere,
    // status required because pnlSumCompleted re-applies the filter
    // defensively. See comment at computePnlByService.
    select: {
      status: true,
      doctorId: true,
      amountCharged: true,
      serviceId: true,
    },
  });
  const doctors = await prisma.user.findMany({
    where: { tenantId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      wellnessRole: true,
    },
  });

  const acc = {};
  for (const v of visits) {
    if (!v.doctorId) continue;
    const d = doctors.find((x) => x.id === v.doctorId);
    if (!d) continue;
    if (!acc[d.id])
      acc[d.id] = {
        id: d.id,
        name: d.name,
        role: d.role,
        wellnessRole: d.wellnessRole,
        visits: 0,
        revenue: 0,
      };
    acc[d.id].visits += 1;
    acc[d.id].revenue += parseFloat(v.amountCharged) || 0;
  }
  const rows = Object.values(acc).sort((a, b) => b.revenue - a.revenue);
  const canonical = canonicalVisitTotals(visits);
  const bucketedVisits = rows.reduce((s, r) => s + r.visits, 0);
  return {
    window: { from, to, locationId: locationId || null },
    totals: {
      visits: canonical.visits,
      revenue: canonical.revenue,
      unbucketed: canonical.visits - bucketedVisits,
    },
    rows,
  };
}

async function computeAttribution(req) {
  const tenantId = req.user.tenantId;
  const _rr = reportRange(req);
  if (_rr.error) return { error: _rr.error };
  const { from, to } = _rr;

  const leads = await prisma.contact.findMany({
    where: { tenantId, createdAt: { gte: from, lte: to } },
    select: { firstTouchSource: true, source: true, status: true },
  });
  const visits = await prisma.visit.findMany({
    where: { tenantId, visitDate: { gte: from, lte: to }, status: "completed" },
    select: { amountCharged: true, patient: { select: { source: true } } },
  });

  // #268: filter out junk-source values (test-* / e2e-* / qa-* / rbac-*
  // prefixes + 4 canonical exact values) from attribution aggregations.
  // Same helper that backs the generic /api/attribution route at
  // routes/attribution.js. Without this, every wellness E2E run
  // re-pollutes the wellness P&L Attribution report with synthetic
  // sources. Helper at lib/junkSourceFilter.js (commit bf7bbe1) +
  // 14 vitest cases at test/lib/leadJunkFilter.test.js pin the
  // case-insensitive prefix-match contract.
  const { isJunkSource } = require("../lib/junkSourceFilter");

  const acc = {};
  const bucket = (src) => (src || "unknown").toLowerCase();
  for (const l of leads) {
    const rawSrc = l.firstTouchSource || l.source;
    if (isJunkSource(rawSrc)) continue;
    const k = bucket(rawSrc);
    if (!acc[k])
      acc[k] = { source: k, leads: 0, junk: 0, qualified: 0, revenue: 0 };
    acc[k].leads += 1;
    if (l.status === "Junk") acc[k].junk += 1;
    if (l.status !== "Junk" && l.status !== "Lead") acc[k].qualified += 1;
  }
  // #233: only attribute revenue to source buckets that ALSO had a lead in
  // the same window. Without this, a returning patient whose first contact
  // was last quarter still books their visit revenue against this month's
  // attribution, producing rows like "google-ad — 0 leads — ₹3,13,398.27 revenue"
  // that don't match what marketing actually drove.
  for (const v of visits) {
    const rawSrc = v.patient?.source;
    if (isJunkSource(rawSrc)) continue;
    const k = bucket(rawSrc);
    if (!acc[k]) continue;
    acc[k].revenue += parseFloat(v.amountCharged) || 0;
  }
  const rows = Object.values(acc)
    .map((r) => ({
      ...r,
      junkRate: r.leads ? Math.round((r.junk / r.leads) * 100) : 0,
      conversionRate: r.leads ? Math.round((r.qualified / r.leads) * 100) : 0,
      revenuePerLead: r.leads ? Math.round(r.revenue / r.leads) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    window: { from, to },
    totals: {
      leads: rows.reduce((s, r) => s + r.leads, 0),
      junk: rows.reduce((s, r) => s + r.junk, 0),
      qualified: rows.reduce((s, r) => s + r.qualified, 0),
      revenue: rows.reduce((s, r) => s + r.revenue, 0),
    },
    rows,
  };
}

async function computePerLocation(req) {
  const tenantId = req.user.tenantId;
  const _rr = reportRange(req);
  if (_rr.error) return { error: _rr.error };
  const { from, to } = _rr;

  const visits = await prisma.visit.findMany({
    where: { tenantId, visitDate: { gte: from, lte: to }, status: "completed" },
    // status required for canonicalVisitTotals — see comment at computePnlByService.
    select: { status: true, locationId: true, amountCharged: true },
  });
  const patients = await prisma.patient.groupBy({
    by: ["locationId"],
    where: { tenantId },
    _count: { _all: true },
  });
  const locations = await prisma.location.findMany({
    where: { tenantId },
    select: { id: true, name: true, city: true, state: true, isActive: true },
  });

  const visitAcc = {};
  for (const v of visits) {
    const k = v.locationId ?? 0;
    if (!visitAcc[k]) visitAcc[k] = { visits: 0, revenue: 0 };
    visitAcc[k].visits += 1;
    visitAcc[k].revenue += parseFloat(v.amountCharged) || 0;
  }
  const rows = locations
    .map((l) => ({
      id: l.id,
      name: l.name,
      city: l.city,
      state: l.state,
      isActive: l.isActive,
      visits: visitAcc[l.id]?.visits || 0,
      revenue: visitAcc[l.id]?.revenue || 0,
      patients: patients.find((p) => p.locationId === l.id)?._count?._all || 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  const canonical = canonicalVisitTotals(visits);
  const bucketedVisits = rows.reduce((s, r) => s + r.visits, 0);
  return {
    window: { from, to },
    totals: {
      visits: canonical.visits,
      revenue: canonical.revenue,
      unbucketed: canonical.visits - bucketedVisits,
    },
    rows,
  };
}

router.get(
  "/reports/pnl-by-service",
  // #207/#216 financial-leak fix: financial reports are admin/manager ONLY.
  // Hard wellnessRole gate (NOT adminOrPerm) — the generic `reports.read`
  // permission is held by the base "User" role (seed.js), which every
  // wellness clinical staffer (doctor/professional/helper/telecaller) has,
  // so a permission fallback would leak P&L/revenue data to them.
  verifyWellnessRole(["admin", "manager"]),
  async (req, res) => {
    try {
      const result = await computePnlByService(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      res.json(result);
    } catch (e) {
      console.error("[reports] pnl-by-service:", e.message);
      res.status(500).json({ error: "Failed to compute P&L" });
    }
  },
);

router.get(
  "/reports/per-professional",
  // #207/#216 financial-leak fix — admin/manager only (see pnl-by-service).
  verifyWellnessRole(["admin", "manager"]),
  async (req, res) => {
    try {
      const result = await computePerProfessional(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      res.json(result);
    } catch (e) {
      console.error("[reports] per-professional:", e.message);
      res
        .status(500)
        .json({ error: "Failed to compute per-professional report" });
    }
  },
);

router.get(
  "/reports/attribution",
  // #207/#216 financial-leak fix — admin/manager only (see pnl-by-service).
  verifyWellnessRole(["admin", "manager"]),
  async (req, res) => {
    try {
      const result = await computeAttribution(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      res.json(result);
    } catch (e) {
      console.error("[reports] attribution:", e.message);
      res.status(500).json({ error: "Failed to compute attribution" });
    }
  },
);

router.get(
  "/reports/per-location",
  // #207/#216 financial-leak fix — admin/manager only (see pnl-by-service).
  verifyWellnessRole(["admin", "manager"]),
  async (req, res) => {
    try {
      const result = await computePerLocation(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      res.json(result);
    } catch (e) {
      console.error("[reports] per-location:", e.message);
      res.status(500).json({ error: "Failed to compute per-location report" });
    }
  },
);

// ── Reports: CSV / PDF export endpoints (#227) ─────────────────────
//
// Each existing JSON report has paired .csv and .pdf siblings that re-use the
// same compute helper above and serialise to text/csv or application/pdf with
// a Content-Disposition: attachment header so the browser triggers a download.
//
// Memory note: full report buffered in memory before send. The 4 reports cap
// at <2k rows in practice (services, doctors, locations, sources are bounded
// per tenant). If any tenant ever pushes well past that we'd switch to row
// streaming for CSV; for now buffered keeps the code simple.

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function rowsToCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  return lines.join("\r\n") + "\r\n";
}
function isoDay(d) {
  if (!d) return "";
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}
function rangeLabel(window) {
  return `${isoDay(window?.from) || "?"}-to-${isoDay(window?.to) || "?"}`;
}
function sendCsv(res, baseName, window, csvText) {
  const filename = `${baseName}-${rangeLabel(window)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // BOM so Excel auto-detects UTF-8 (₹ glyph, accented patient names, etc).
  res.write("﻿");
  res.end(csvText);
}

// Generic tabular PDF — a renderer matching the prescription/consent style:
// clinic letterhead, centered title, range subtitle, and a paginated table.
async function renderReportPdf(title, columns, rows, range, clinic) {
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ size: "A4", margin: 40, layout: "landscape" });
  applyRupeeCapableFonts(doc); // ₹ glyph fix
  const chunks = [];
  const bufPromise = new Promise((resolve, reject) => {
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Letterhead — same look as renderPrescriptionPdf's drawClinicHeader.
  const c = {
    name: clinic?.name || "Clinic",
    addressLine: clinic?.addressLine || "",
    city: clinic?.city || "",
    state: clinic?.state || "",
    pincode: clinic?.pincode || "",
    phone: clinic?.phone || "",
    email: clinic?.email || "",
  };
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#111").text(c.name);
  doc.font("Helvetica").fontSize(9).fillColor("#555");
  const addr = [
    c.addressLine,
    [c.city, c.state, c.pincode].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("  ·  ");
  if (addr) doc.text(addr);
  const contact = [c.phone, c.email].filter(Boolean).join("  |  ");
  if (contact) doc.text(contact);
  doc.moveDown(0.3);
  const divY = doc.y;
  doc
    .moveTo(doc.page.margins.left, divY)
    .lineTo(doc.page.width - doc.page.margins.right, divY)
    .lineWidth(0.7)
    .strokeColor("#999")
    .stroke();
  doc.moveDown(0.6);

  // Title + range
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor("#111")
    .text(title, { align: "center" });
  if (range?.from && range?.to) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#666")
      .text(`${isoDay(range.from)} → ${isoDay(range.to)}`, { align: "center" });
  }
  doc.moveDown(0.6);

  // Table — equal-width columns scaled to printable width.
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const printW = right - left;
  const colW = printW / columns.length;
  const headerY = doc.y;
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#333");
  columns.forEach((h, i) => {
    doc.text(String(h), left + i * colW + 2, headerY, {
      width: colW - 4,
      ellipsis: true,
    });
  });
  doc
    .moveTo(left, headerY + 14)
    .lineTo(right, headerY + 14)
    .lineWidth(0.5)
    .strokeColor("#bbb")
    .stroke();

  let y = headerY + 18;
  doc.font("Helvetica").fontSize(9).fillColor("#222");
  const lineH = 14;
  const bottom = doc.page.height - doc.page.margins.bottom - 20;
  for (const row of rows) {
    if (y + lineH > bottom) {
      doc.addPage({ size: "A4", margin: 40, layout: "landscape" });
      y = doc.page.margins.top;
      // re-emit table header on new page for readability
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#333");
      columns.forEach((h, i) => {
        doc.text(String(h), left + i * colW + 2, y, {
          width: colW - 4,
          ellipsis: true,
        });
      });
      doc
        .moveTo(left, y + 14)
        .lineTo(right, y + 14)
        .lineWidth(0.5)
        .strokeColor("#bbb")
        .stroke();
      y += 18;
      doc.font("Helvetica").fontSize(9).fillColor("#222");
    }
    row.forEach((cell, i) => {
      doc.text(
        cell === null || cell === undefined ? "" : String(cell),
        left + i * colW + 2,
        y,
        { width: colW - 4, ellipsis: true },
      );
    });
    y += lineH;
  }
  if (rows.length === 0) {
    doc.fillColor("#888").text("No data in this window.", left, y + 6, {
      width: printW,
      align: "center",
    });
  }

  doc.end();
  return bufPromise;
}

function sendPdf(res, baseName, window, buf) {
  const filename = `${baseName}-${rangeLabel(window)}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", buf.length);
  res.send(buf);
}

// XLSX sibling of sendCsv/sendPdf. Uses the same loadXlsx() helper the
// patient export path already relies on; sheet name reflects the report
// title so Excel's tab strip is meaningful when the file is opened.
function sendXlsxReport(res, baseName, window, sheetName, headers, rows) {
  const XLSX = loadXlsx();
  const aoa = [
    headers.slice(),
    ...rows.map((r) => (Array.isArray(r) ? r : [])),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  // Excel caps sheet names at 31 chars and bans / \ ? * [ ] : characters.
  const safeSheet =
    String(sheetName || "Report")
      .replace(/[\\/?*[\]:]/g, " ")
      .slice(0, 31) || "Report";
  XLSX.utils.book_append_sheet(wb, ws, safeSheet);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const filename = `${baseName}-${rangeLabel(window)}.xlsx`;
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", buf.length);
  res.send(buf);
}

const fmtMoney = (n) => {
  const v = Number(n) || 0;
  return v.toFixed(2);
};

// ── P&L by service exports ─────────────────────────────────────────

router.get(
  "/reports/pnl-by-service.csv",
  adminOrPerm("reports", "export"),
  async (req, res) => {
    try {
      const result = await computePnlByService(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      const headers = [
        "Service",
        "Category",
        "Tier",
        "Visits",
        "Revenue",
        "Product cost",
        "Contribution",
      ];
      const rows = result.rows.map((r) => [
        r.name,
        r.category,
        r.ticketTier,
        r.count,
        fmtMoney(r.revenue),
        fmtMoney(r.productCost),
        fmtMoney(r.contribution),
      ]);
      rows.push([]);
      rows.push([
        "TOTAL",
        "",
        "",
        result.totals.visits,
        fmtMoney(result.totals.revenue),
        fmtMoney(result.totals.productCost),
        fmtMoney(result.totals.contribution),
      ]);
      sendCsv(res, "pnl-by-service", result.window, rowsToCsv(headers, rows));
    } catch (e) {
      console.error("[reports] pnl-by-service.csv:", e.message);
      res.status(500).json({ error: "Failed to export P&L CSV" });
    }
  },
);

router.get(
  "/reports/pnl-by-service.pdf",
  adminOrPerm("reports", "export"),
  async (req, res) => {
    try {
      const result = await computePnlByService(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      const clinic = await primaryClinic(req.user.tenantId);
      const columns = [
        "Service",
        "Category",
        "Tier",
        "Visits",
        "Revenue",
        "Product cost",
        "Contribution",
      ];
      const rows = result.rows.map((r) => [
        r.name,
        r.category,
        r.ticketTier,
        r.count,
        fmtMoney(r.revenue),
        fmtMoney(r.productCost),
        fmtMoney(r.contribution),
      ]);
      rows.push([
        "TOTAL",
        "",
        "",
        result.totals.visits,
        fmtMoney(result.totals.revenue),
        fmtMoney(result.totals.productCost),
        fmtMoney(result.totals.contribution),
      ]);
      const buf = await renderReportPdf(
        "P&L by Service",
        columns,
        rows,
        result.window,
        clinic,
      );
      sendPdf(res, "pnl-by-service", result.window, buf);
    } catch (e) {
      console.error("[reports] pnl-by-service.pdf:", e.message);
      res.status(500).json({ error: "Failed to export P&L PDF" });
    }
  },
);

router.get(
  "/reports/pnl-by-service.xlsx",
  adminOrPerm("reports", "export"),
  async (req, res) => {
    try {
      const result = await computePnlByService(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      const headers = [
        "Service",
        "Category",
        "Tier",
        "Visits",
        "Revenue",
        "Product cost",
        "Contribution",
      ];
      const rows = result.rows.map((r) => [
        r.name,
        r.category,
        r.ticketTier,
        r.count,
        fmtMoney(r.revenue),
        fmtMoney(r.productCost),
        fmtMoney(r.contribution),
      ]);
      rows.push([]);
      rows.push([
        "TOTAL",
        "",
        "",
        result.totals.visits,
        fmtMoney(result.totals.revenue),
        fmtMoney(result.totals.productCost),
        fmtMoney(result.totals.contribution),
      ]);
      sendXlsxReport(
        res,
        "pnl-by-service",
        result.window,
        "P&L by Service",
        headers,
        rows,
      );
    } catch (e) {
      console.error("[reports] pnl-by-service.xlsx:", e.message);
      res.status(500).json({ error: "Failed to export P&L XLSX" });
    }
  },
);

// ── Per-professional exports ───────────────────────────────────────

router.get(
  "/reports/per-professional.csv",
  adminOrPerm("reports", "export"),
  async (req, res) => {
    try {
      const result = await computePerProfessional(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      const headers = ["Staff", "Role", "Visits", "Revenue"];
      const rows = result.rows.map((r) => [
        r.name,
        r.wellnessRole || r.role || "",
        r.visits,
        fmtMoney(r.revenue),
      ]);
      rows.push([]);
      rows.push([
        "TOTAL",
        "",
        result.totals.visits,
        fmtMoney(result.totals.revenue),
      ]);
      sendCsv(res, "per-professional", result.window, rowsToCsv(headers, rows));
    } catch (e) {
      console.error("[reports] per-professional.csv:", e.message);
      res.status(500).json({ error: "Failed to export per-professional CSV" });
    }
  },
);

router.get(
  "/reports/per-professional.pdf",
  adminOrPerm("reports", "export"),
  async (req, res) => {
    try {
      const result = await computePerProfessional(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      const clinic = await primaryClinic(req.user.tenantId);
      const columns = ["Staff", "Role", "Visits", "Revenue"];
      const rows = result.rows.map((r) => [
        r.name,
        r.wellnessRole || r.role || "",
        r.visits,
        fmtMoney(r.revenue),
      ]);
      rows.push([
        "TOTAL",
        "",
        result.totals.visits,
        fmtMoney(result.totals.revenue),
      ]);
      const buf = await renderReportPdf(
        "Per-Professional Report",
        columns,
        rows,
        result.window,
        clinic,
      );
      sendPdf(res, "per-professional", result.window, buf);
    } catch (e) {
      console.error("[reports] per-professional.pdf:", e.message);
      res.status(500).json({ error: "Failed to export per-professional PDF" });
    }
  },
);

router.get(
  "/reports/per-professional.xlsx",
  adminOrPerm("reports", "export"),
  async (req, res) => {
    try {
      const result = await computePerProfessional(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      const headers = ["Staff", "Role", "Visits", "Revenue"];
      const rows = result.rows.map((r) => [
        r.name,
        r.wellnessRole || r.role || "",
        r.visits,
        fmtMoney(r.revenue),
      ]);
      rows.push([]);
      rows.push([
        "TOTAL",
        "",
        result.totals.visits,
        fmtMoney(result.totals.revenue),
      ]);
      sendXlsxReport(
        res,
        "per-professional",
        result.window,
        "Per-Professional",
        headers,
        rows,
      );
    } catch (e) {
      console.error("[reports] per-professional.xlsx:", e.message);
      res.status(500).json({ error: "Failed to export per-professional XLSX" });
    }
  },
);

// ── Per-location exports ───────────────────────────────────────────

router.get(
  "/reports/per-location.csv",
  adminOrPerm("reports", "export"),
  async (req, res) => {
    try {
      const result = await computePerLocation(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      const headers = [
        "Location",
        "City",
        "State",
        "Patients",
        "Visits",
        "Revenue",
        "Status",
      ];
      const rows = result.rows.map((r) => [
        r.name,
        r.city || "",
        r.state || "",
        r.patients,
        r.visits,
        fmtMoney(r.revenue),
        r.isActive ? "Active" : "Inactive",
      ]);
      rows.push([]);
      rows.push([
        "TOTAL",
        "",
        "",
        "",
        result.totals.visits,
        fmtMoney(result.totals.revenue),
        "",
      ]);
      sendCsv(res, "per-location", result.window, rowsToCsv(headers, rows));
    } catch (e) {
      console.error("[reports] per-location.csv:", e.message);
      res.status(500).json({ error: "Failed to export per-location CSV" });
    }
  },
);

router.get(
  "/reports/per-location.pdf",
  adminOrPerm("reports", "export"),
  async (req, res) => {
    try {
      const result = await computePerLocation(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      const clinic = await primaryClinic(req.user.tenantId);
      const columns = [
        "Location",
        "City",
        "State",
        "Patients",
        "Visits",
        "Revenue",
        "Status",
      ];
      const rows = result.rows.map((r) => [
        r.name,
        r.city || "",
        r.state || "",
        r.patients,
        r.visits,
        fmtMoney(r.revenue),
        r.isActive ? "Active" : "Inactive",
      ]);
      rows.push([
        "TOTAL",
        "",
        "",
        "",
        result.totals.visits,
        fmtMoney(result.totals.revenue),
        "",
      ]);
      const buf = await renderReportPdf(
        "Per-Location Report",
        columns,
        rows,
        result.window,
        clinic,
      );
      sendPdf(res, "per-location", result.window, buf);
    } catch (e) {
      console.error("[reports] per-location.pdf:", e.message);
      res.status(500).json({ error: "Failed to export per-location PDF" });
    }
  },
);

router.get(
  "/reports/per-location.xlsx",
  adminOrPerm("reports", "export"),
  async (req, res) => {
    try {
      const result = await computePerLocation(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      const headers = [
        "Location",
        "City",
        "State",
        "Patients",
        "Visits",
        "Revenue",
        "Status",
      ];
      const rows = result.rows.map((r) => [
        r.name,
        r.city || "",
        r.state || "",
        r.patients,
        r.visits,
        fmtMoney(r.revenue),
        r.isActive ? "Active" : "Inactive",
      ]);
      rows.push([]);
      rows.push([
        "TOTAL",
        "",
        "",
        "",
        result.totals.visits,
        fmtMoney(result.totals.revenue),
        "",
      ]);
      sendXlsxReport(
        res,
        "per-location",
        result.window,
        "Per-Location",
        headers,
        rows,
      );
    } catch (e) {
      console.error("[reports] per-location.xlsx:", e.message);
      res.status(500).json({ error: "Failed to export per-location XLSX" });
    }
  },
);

// ── Attribution exports ────────────────────────────────────────────

router.get(
  "/reports/attribution.csv",
  adminOrPerm("reports", "export"),
  async (req, res) => {
    try {
      const result = await computeAttribution(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      const headers = [
        "Source",
        "Leads",
        "Junk",
        "Junk %",
        "Qualified",
        "Conv %",
        "Revenue",
        "Rev / Lead",
      ];
      const rows = result.rows.map((r) => [
        r.source,
        r.leads,
        r.junk,
        `${r.junkRate}%`,
        r.qualified,
        `${r.conversionRate}%`,
        fmtMoney(r.revenue),
        fmtMoney(r.revenuePerLead),
      ]);
      rows.push([]);
      rows.push([
        "TOTAL",
        result.totals.leads,
        result.totals.junk,
        "",
        result.totals.qualified,
        "",
        fmtMoney(result.totals.revenue),
        "",
      ]);
      sendCsv(res, "attribution", result.window, rowsToCsv(headers, rows));
    } catch (e) {
      console.error("[reports] attribution.csv:", e.message);
      res.status(500).json({ error: "Failed to export attribution CSV" });
    }
  },
);

router.get(
  "/reports/attribution.pdf",
  adminOrPerm("reports", "export"),
  async (req, res) => {
    try {
      const result = await computeAttribution(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      const clinic = await primaryClinic(req.user.tenantId);
      const columns = [
        "Source",
        "Leads",
        "Junk",
        "Junk %",
        "Qualified",
        "Conv %",
        "Revenue",
        "Rev / Lead",
      ];
      const rows = result.rows.map((r) => [
        r.source,
        r.leads,
        r.junk,
        `${r.junkRate}%`,
        r.qualified,
        `${r.conversionRate}%`,
        fmtMoney(r.revenue),
        fmtMoney(r.revenuePerLead),
      ]);
      rows.push([
        "TOTAL",
        result.totals.leads,
        result.totals.junk,
        "",
        result.totals.qualified,
        "",
        fmtMoney(result.totals.revenue),
        "",
      ]);
      const buf = await renderReportPdf(
        "Marketing Attribution",
        columns,
        rows,
        result.window,
        clinic,
      );
      sendPdf(res, "attribution", result.window, buf);
    } catch (e) {
      console.error("[reports] attribution.pdf:", e.message);
      res.status(500).json({ error: "Failed to export attribution PDF" });
    }
  },
);

router.get(
  "/reports/attribution.xlsx",
  adminOrPerm("reports", "export"),
  async (req, res) => {
    try {
      const result = await computeAttribution(req);
      if (result.error)
        return res.status(result.error.status).json(result.error);
      const headers = [
        "Source",
        "Leads",
        "Junk",
        "Junk %",
        "Qualified",
        "Conv %",
        "Revenue",
        "Rev / Lead",
      ];
      const rows = result.rows.map((r) => [
        r.source,
        r.leads,
        r.junk,
        `${r.junkRate}%`,
        r.qualified,
        `${r.conversionRate}%`,
        fmtMoney(r.revenue),
        fmtMoney(r.revenuePerLead),
      ]);
      rows.push([]);
      rows.push([
        "TOTAL",
        result.totals.leads,
        result.totals.junk,
        "",
        result.totals.qualified,
        "",
        fmtMoney(result.totals.revenue),
        "",
      ]);
      sendXlsxReport(
        res,
        "attribution",
        result.window,
        "Marketing Attribution",
        headers,
        rows,
      );
    } catch (e) {
      console.error("[reports] attribution.xlsx:", e.message);
      res.status(500).json({ error: "Failed to export attribution XLSX" });
    }
  },
);

// ── Owner dashboard aggregation ────────────────────────────────────

// #207/#216: the Owner Dashboard data endpoint exposes org-wide P&L,
// pending-approvals counts, revenue trend, and recommendations. A doctor
// or telecaller hitting this directly (or via stale frontend cache) sees
// the full clinic financials. Lock to admin/manager.
router.get(
  "/dashboard",
  // #207/#216 financial-leak fix — owner dashboard shows org-wide P&L, so
  // admin/manager ONLY (hard gate). The generic `reports.read` permission is
  // held by the base "User" role that every clinical staffer has, so a
  // permission fallback (adminOrPerm) would leak revenue to doctors.
  verifyWellnessRole(["admin", "manager"]),
  async (req, res) => {
    try {
      const tenantId = req.user.tenantId;
      const locationId = req.query.locationId
        ? parseInt(req.query.locationId)
        : undefined;
      const todayStart = startOfDay();
      const todayEnd = endOfDay();
      const yesterdayStart = startOfDay(new Date(Date.now() - 86400000));
      const yesterdayEnd = endOfDay(new Date(Date.now() - 86400000));
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
      // PRD §6.8 — no-show risk: window of upcoming booked visits in next 24h.
      const next24hStart = new Date();
      const next24hEnd = new Date(Date.now() + 24 * 3600 * 1000);

      const visitWhere = (extra = {}) => ({
        tenantId,
        ...(locationId ? { locationId } : {}),
        ...extra,
      });

      const [
        todayVisits,
        yesterdayVisits,
        pendingRecommendations,
        activeTreatmentPlans,
        newLeadsToday,
        thirtyDayVisits,
        totalPatients,
        totalServices,
        totalLocations,
        upcomingVisits,
      ] = await Promise.all([
        prisma.visit.findMany({
          where: visitWhere({ visitDate: { gte: todayStart, lte: todayEnd } }),
          select: {
            id: true,
            status: true,
            serviceId: true,
            service: { select: { basePrice: true } },
          },
        }),
        prisma.visit.findMany({
          where: visitWhere({
            visitDate: { gte: yesterdayStart, lte: yesterdayEnd },
          }),
          select: { id: true, status: true, amountCharged: true },
        }),
        // #293 fix: when ?locationId= is set, scope these widgets too —
        // previously they fell back to tenant-wide and the Owner saw 36
        // active treatment plans and 2 pending approvals on a freshly
        // created branch with zero patients (very confusing).
        prisma.agentRecommendation.findMany({
          where: locationId
            ? {
              tenantId,
              status: "pending",
              // AgentRecommendation has no direct locationId. The orchestrator
              // stores per-location recommendations with locationId in the
              // JSON `payload`. Match either explicit JSON-substring or
              // tenant-wide recommendations that lack a locationId scope.
              OR: [
                { payload: { contains: `"locationId":${locationId}` } },
                { payload: { contains: `"locationId": ${locationId}` } },
              ],
            }
            : { tenantId, status: "pending" },
          orderBy: { priority: "desc" },
          take: 5,
        }),
        prisma.treatmentPlan.count({
          where: locationId
            ? { tenantId, status: "active", patient: { locationId } }
            : { tenantId, status: "active" },
        }),
        // #335: when the global Locations filter is set, scope new-leads-today
        // to leads tied to a Patient at that location. Contact has no
        // locationId column (leads are tenant-scoped, not location-scoped, in
        // the generic CRM model), so we approximate by matching on phone or
        // email against Patient.locationId. This makes the Leads KPI tile
        // respond to the dropdown the same way Appointments + Revenue do.
        // When locationId is unset we keep the existing tenant-wide count.
        (async () => {
          const baseWhere = {
            tenantId,
            status: "Lead",
            createdAt: { gte: todayStart, lte: todayEnd },
          };
          if (!locationId) return prisma.contact.count({ where: baseWhere });
          const patients = await prisma.patient.findMany({
            where: { tenantId, locationId },
            select: { phone: true, email: true },
          });
          const phones = patients.map((p) => p.phone).filter(Boolean);
          const emails = patients.map((p) => p.email).filter(Boolean);
          if (phones.length === 0 && emails.length === 0) return 0;
          const orClauses = [];
          if (phones.length) orClauses.push({ phone: { in: phones } });
          if (emails.length) orClauses.push({ email: { in: emails } });
          return prisma.contact.count({
            where: { ...baseWhere, OR: orClauses },
          });
        })(),
        prisma.visit.findMany({
          where: visitWhere({ visitDate: { gte: thirtyDaysAgo } }),
          select: { visitDate: true, amountCharged: true },
        }),
        prisma.patient.count({
          where: { tenantId, ...(locationId ? { locationId } : {}) },
        }),
        prisma.service.count({ where: { tenantId, isActive: true } }),
        prisma.location.count({ where: { tenantId, isActive: true } }),
        // PRD §6.8 — upcoming booked visits in the next 24h, with patient
        // context needed to score no-show risk (past no-shows, first-visit,
        // engagement signals, reminder confirmation).
        prisma.visit.findMany({
          where: visitWhere({
            status: "booked",
            visitDate: { gte: next24hStart, lte: next24hEnd },
          }),
          orderBy: { visitDate: "asc" },
          select: {
            id: true,
            visitDate: true,
            patientId: true,
            patient: {
              select: { id: true, name: true, phone: true, createdAt: true },
            },
          },
        }),
      ]);

      // Bucket revenue by day for the 30-day strip
      const dayBuckets = {};
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        dayBuckets[key] = 0;
      }
      for (const v of thirtyDayVisits) {
        const key = v.visitDate.toISOString().slice(0, 10);
        if (key in dayBuckets)
          dayBuckets[key] += parseFloat(v.amountCharged) || 0;
      }
      // #181: round to 2 decimals — float accumulation on amountCharged was producing
      // 14-digit fractional rupees in the dashboard chart axis labels.
      const revenueTrend = Object.entries(dayBuckets).map(
        ([date, revenue]) => ({
          date,
          revenue: Math.round(revenue * 100) / 100,
        }),
      );

      // Rough occupancy: today's "filled" slots / capacity. #289 fix:
      // Previously this counted ONLY status=completed visits, which meant a
      // clinic that had a full booked day showed Occupancy 0% until each
      // visit was clinically closed at end-of-day. That's the opposite of
      // what an Owner expects — they want to know what's on the books NOW.
      // Count booked + completed + arrived/in-progress visits as filled.
      const filledStatuses = new Set([
        "booked",
        "completed",
        "arrived",
        "in-progress",
        "checked-in",
      ]);
      const filledToday = todayVisits.filter((v) =>
        filledStatuses.has(v.status),
      ).length;
      const completedToday = todayVisits.filter(
        (v) => v.status === "completed",
      ).length;
      const capacity = 8 * 17; // 17 staff × 8 slots — generous baseline
      const occupancyPct = Math.min(
        100,
        Math.round((filledToday / capacity) * 100),
      );

      // Expected revenue: sum basePrice of booked+completed visits (expected service cost for today)
      const revenueGeneratingVisits = todayVisits.filter((v) =>
        filledStatuses.has(v.status),
      );
      const expectedRevenueAmount = revenueGeneratingVisits.reduce(
        (total, v) => {
          return (
            total + (v.service?.basePrice ? parseFloat(v.service.basePrice) : 0)
          );
        },
        0,
      );

      // ── PRD §6.8: No-show risk scorer ────────────────────────────────
      // Rule-based, no ML. Score 0–100 per upcoming booked visit; aggregate
      // count of visits scoring ≥40 and surface top 5.
      const patientIds = upcomingVisits.map((v) => v.patientId);
      const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000);
      const thirtyDaysAgoLoyalty = new Date(Date.now() - 30 * 86400000);
      const noShowRisk = {
        count: 0,
        totalUpcoming: upcomingVisits.length,
        topRisks: [],
      };
      if (upcomingVisits.length > 0) {
        const [pastNoShows, anyVisits, smsSent, loyaltyRecent] =
          await Promise.all([
            // +30: any past no-show in last 90d
            prisma.visit.findMany({
              where: {
                tenantId,
                status: "no-show",
                patientId: { in: patientIds },
                visitDate: { gte: ninetyDaysAgo },
              },
              select: { patientId: true },
            }),
            // +15 if first-visit (no prior visit at all) — pull all visit ids per patient
            prisma.visit.findMany({
              where: {
                tenantId,
                patientId: { in: patientIds },
                id: { notIn: upcomingVisits.map((v) => v.id) },
              },
              select: { patientId: true },
            }),
            // +20 (negated when present) if SMS reminder confirmed for this visit. Look
            // for a SENT/DELIVERED outbound SMS to the patient phone in the last 48h
            // that contains the appointment reminder marker text.
            prisma.smsMessage.findMany({
              where: {
                tenantId,
                direction: "OUTBOUND",
                status: { in: ["SENT", "DELIVERED"] },
                createdAt: { gte: new Date(Date.now() - 48 * 3600 * 1000) },
                to: {
                  in: upcomingVisits
                    .map((v) => v.patient?.phone)
                    .filter(Boolean),
                },
                OR: [
                  { body: { contains: "reminder" } },
                  { body: { contains: "appointment" } },
                ],
              },
              select: { to: true },
            }),
            // −10 if patient has a LoyaltyTransaction in last 30d (engaged)
            prisma.loyaltyTransaction.findMany({
              where: {
                tenantId,
                patientId: { in: patientIds },
                createdAt: { gte: thirtyDaysAgoLoyalty },
              },
              select: { patientId: true },
            }),
          ]);
        const noShowSet = new Set(pastNoShows.map((v) => v.patientId));
        const visitedPatientSet = new Set(anyVisits.map((v) => v.patientId));
        const remindedPhones = new Set(smsSent.map((s) => s.to));
        const loyalSet = new Set(loyaltyRecent.map((l) => l.patientId));

        // #289 fix: previously the model scored every upcoming visit and
        // flagged anyone ≥ 40. The "no SMS reminder" rule (+20) fires for
        // every visit booked < 24h ago because the reminder cron runs T-24h
        // and T-1h — i.e., a brand-new booking won't have a reminder yet.
        // Combined with "first-visit patient" (+15), every public-booking
        // visit auto-scored 35; one extra signal (past no-show OR late
        // hour) pushed it over 40 → "11 of 11 upcoming" (100% flagged).
        // A model that flags 100% of visits has zero signal value.
        // Tighten the gate:
        //   • Raise threshold from 40 → 60 so background noise alone can't
        //     clip the bar.
        //   • The "no SMS yet" rule only fires when the visit is ≥ 24h out
        //     (i.e., the T-24h reminder *should* already be sent). Visits
        //     scheduled in the next ~6h are exempt — the reminder cron
        //     hasn't reached them.
        //   • Cap aggregate flagged count at min(N, 0.5 * totalUpcoming):
        //     if more than half the day looks high-risk, the model is
        //     mis-calibrated and we'd rather show "—" than mislead.
        const scored = upcomingVisits.map((v) => {
          const istHour = new Date(
            v.visitDate.getTime() + 5.5 * 3600 * 1000,
          ).getUTCHours();
          const hoursOut = (v.visitDate.getTime() - Date.now()) / 3600000;
          let score = 0;
          if (noShowSet.has(v.patientId)) score += 30;
          // Only penalise missing-reminder if the visit is already in the
          // reminder window (T-24h to T-1h). Outside that window it's
          // expected behaviour, not a risk signal.
          if (
            hoursOut <= 24 &&
            hoursOut >= 1 &&
            !remindedPhones.has(v.patient?.phone)
          )
            score += 20;
          if (!visitedPatientSet.has(v.patientId)) score += 15;
          if (istHour < 10 || istHour >= 18) score += 10;
          if (loyalSet.has(v.patientId)) score -= 10;
          score = Math.max(0, Math.min(100, score));
          return {
            visitId: v.id,
            patientName: v.patient?.name || "—",
            score,
            scheduledAt: v.visitDate,
          };
        });
        scored.sort((a, b) => b.score - a.score);
        const rawCount = scored.filter((s) => s.score >= 60).length;
        // Sanity guard: if the model would flag > half the upcoming list,
        // treat the result as unreliable and surface 0 instead of a noisy
        // "11 of 11". The Owner UI can render "— / N upcoming" when count
        // is 0 with a non-zero totalUpcoming to indicate "no high-risk".
        const halfCap = Math.floor(upcomingVisits.length / 2);
        noShowRisk.count = rawCount > halfCap ? 0 : rawCount;
        noShowRisk.topRisks = scored.slice(0, 5);
      }

      res.json({
        today: {
          visits: todayVisits.length,
          completed: completedToday,
          expectedRevenue: expectedRevenueAmount,
          occupancyPct,
          newLeads: newLeadsToday,
          noShowRisk,
        },
        yesterday: {
          visits: yesterdayVisits.length,
          completed: yesterdayVisits.filter((v) => v.status === "completed")
            .length,
          // #565 (Wave 9 Agent A, 2026-05-10): yesterday.revenue is the
          // canonical figure (sum(amountCharged) WHERE status='completed')
          // so it reconciles byte-for-byte with the corresponding window on
          // /reports/pnl-by-service. Pre-fix this summed amountCharged for
          // ALL yesterday's visits regardless of status, so cancelled /
          // no-show rows whose amountCharged was set when the visit was
          // originally scheduled inflated yesterday's revenue silently.
          // The shared helper at backend/lib/pnlMath.js encodes the
          // canonical definition; see that file's header for the
          // alternatives that were considered + why "completed" won.
          revenue: pnlSumCompleted(yesterdayVisits).revenue,
        },
        pendingApprovals: pendingRecommendations.length,
        pendingRecommendations,
        activeTreatmentPlans,
        revenueTrend,
        totals: {
          patients: totalPatients,
          services: totalServices,
          locations: totalLocations,
        },
      });
    } catch (e) {
      console.error("[wellness] dashboard error:", e.message);
      res.status(500).json({ error: "Failed to load dashboard" });
    }
  },
);

// ── Public booking endpoints (no auth) ─────────────────────────────
// Mounted at /api/wellness/public/* in server.js after these routes get split out.
// These specific 3 endpoints are added to the open paths list so they bypass
// the JWT guard.

router.get("/public/tenant/:slug", async (req, res) => {
  try {
    // #378: tenant slugs are lower-kebab-case ([a-z0-9-]+, length 2-64).
    // Reject anything outside that shape with a fast 404 BEFORE the DB
    // lookup — MySQL's default collation is case-insensitive, so a literal
    // findUnique on "ENHANCED-WELLNESS" would otherwise match the seeded
    // "enhanced-wellness" row. The shape check guarantees public URLs
    // never get a "works in upper, works in lower, ambiguous in between"
    // class of bug for SEO / sharing.
    const slug = String(req.params.slug || "");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) {
      return res.status(404).json({ error: "Clinic not found" });
    }
    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        slug: true,
        vertical: true,
        country: true,
        defaultCurrency: true,
        locale: true,
      },
    });
    if (!tenant || tenant.vertical !== "wellness")
      return res.status(404).json({ error: "Clinic not found" });

    // Wave 7D — also surface the tenant's first active BookingPage rich
    // content (logo / hero / featured / contact) so the public mini-website
    // can render branding alongside the service catalogue. Single page per
    // tenant for the MVP — picks the most-recently-updated active page.
    const [rawServices, allLocations, miniSite, allResources] =
      await Promise.all([
        prisma.service.findMany({
          where: { tenantId: tenant.id, isActive: true },
          // Wave 2 Agent LL — include supportedBookingTypes so the public
          // widget can filter the bookingType picker per-service.
          select: {
            id: true,
            name: true,
            category: true,
            basePrice: true,
            durationMin: true,
            description: true,
            ticketTier: true,
            supportedBookingTypes: true,
          },
          orderBy: [{ category: "asc" }, { name: "asc" }],
        }),
        prisma.location.findMany({
          where: { tenantId: tenant.id, isActive: true },
          select: {
            id: true,
            name: true,
            addressLine: true,
            city: true,
            state: true,
            pincode: true,
            phone: true,
            hours: true,
          },
        }),
        prisma.bookingPage
          .findFirst({
            where: { tenantId: tenant.id, isActive: true },
            orderBy: { updatedAt: "desc" },
            select: {
              slug: true,
              logoUrl: true,
              heroImageUrl: true,
              heroHeadline: true,
              heroSubheadline: true,
              featuredServiceIds: true,
              contactPhone: true,
              contactEmail: true,
              hoursJson: true,
            },
          })
          .catch(() => null),
        // Wave 8b — surface the tenant's active Resource (rooms / chairs /
        // equipment) catalogue so the public booking widget can offer
        // CLINIC_VISIT bookers an optional room/resource preference. Empty
        // array on tenants without any resources keeps the widget simple.
        prisma.resource
          .findMany({
            where: { tenantId: tenant.id, isActive: true },
            select: { id: true, name: true, type: true, locationId: true },
            orderBy: [{ locationId: "asc" }, { name: "asc" }],
          })
          .catch(() => []),
      ]);
    // Wave 2 Agent LL — parse the JSON-string column into a real array on the
    // wire. Legacy services with null column expose ["CLINIC_VISIT"] (the
    // back-compat default) so the widget always has a non-empty supported
    // list — never has to special-case "no field set".
    const services = rawServices.map((s) => ({
      ...s,
      supportedBookingTypes: parseSupportedBookingTypes(
        s.supportedBookingTypes,
      ),
    }));
    // #291: never expose internal/dev location names ("smoke-test", "e2e-…",
    // "test-…", "qa-…") on the customer-facing booking page. The seed and
    // E2E test suites both create such rows, and they leak into the public
    // /book/<slug> step 2 (Pick a clinic) and step 3 (order summary).
    const INTERNAL_LOCATION_NAME_RE =
      /^(smoke-test|e2e[-_ ]|test[-_ ]|qa[-_ ]|dev[-_ ])/i;
    const locations = allLocations.filter(
      (l) => !INTERNAL_LOCATION_NAME_RE.test(String(l.name || "").trim()),
    );
    // Wave 7D — flatten miniSite into a friendlier shape for the widget.
    let miniSitePayload = null;
    if (miniSite) {
      let featuredServiceIds = [];
      try {
        if (miniSite.featuredServiceIds) {
          const parsed = JSON.parse(miniSite.featuredServiceIds);
          if (Array.isArray(parsed))
            featuredServiceIds = parsed
              .map((n) => parseInt(n, 10))
              .filter(Number.isFinite);
        }
      } catch {
        /* leave empty */
      }
      let hours = null;
      try {
        if (miniSite.hoursJson) hours = JSON.parse(miniSite.hoursJson);
      } catch {
        /* leave null */
      }
      miniSitePayload = {
        slug: miniSite.slug,
        logoUrl: miniSite.logoUrl || null,
        heroImageUrl: miniSite.heroImageUrl || null,
        heroHeadline: miniSite.heroHeadline || null,
        heroSubheadline: miniSite.heroSubheadline || null,
        featuredServiceIds,
        contactPhone: miniSite.contactPhone || null,
        contactEmail: miniSite.contactEmail || null,
        hours,
      };
    }
    // Wave 8b — passthrough resources (already filtered to isActive=true).
    // The widget renders these as an optional select per CLINIC_VISIT
    // booking. Empty array → widget hides the picker entirely.
    res.json({
      tenant,
      services,
      locations,
      miniSite: miniSitePayload,
      resources: allResources,
    });
  } catch (_e) {
    res.status(500).json({ error: "Failed to load clinic profile" });
  }
});

// Wave 2 Agent LL — booking-type vocabulary (2026-05-08 Google Doc audit).
// String-enum (not Prisma enum) per the codebase's soft-enum convention
// — matches Visit.status / Service.ticketTier / Patient.source.
//   CLINIC_VISIT — patient comes to the clinic (legacy default)
//   IN_HOME      — staff travels to the patient's address
//   VIDEO        — telehealth call (Jitsi-style URL)
//   PHONE        — voice-only consult (no address, no link)
const BOOKING_TYPES = ["CLINIC_VISIT", "IN_HOME", "VIDEO", "PHONE"];
const DEFAULT_TRAVEL_TIME_MIN = 30; // MVP default; future: pincode-distance-based

// Parse the JSON-string column `Service.supportedBookingTypes` into a JS array.
// Returns the legacy default (`["CLINIC_VISIT"]`) when the column is null/empty
// or contains unparseable JSON — back-compat for services that pre-date the
// column. Filters out any unknown enum values silently.
function parseSupportedBookingTypes(raw) {
  if (raw == null || raw === "") return ["CLINIC_VISIT"];
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return ["CLINIC_VISIT"];
    }
  }
  if (!Array.isArray(parsed)) return ["CLINIC_VISIT"];
  const filtered = parsed.filter((v) => BOOKING_TYPES.includes(v));
  return filtered.length > 0 ? filtered : ["CLINIC_VISIT"];
}

// Build a Jitsi-style room URL for a VIDEO booking. Per-room slug includes
// the visit ID (filled in post-create) so each session is unique. MVP uses
// the public meet.jit.si server; future: per-tenant configured provider.
function buildVideoCallUrl(tenantSlug, patientId) {
  const slug = `${tenantSlug || "clinic"}-p${patientId}-${Date.now().toString(36)}`;
  return `https://meet.jit.si/gbs-${slug.replace(/[^a-z0-9-]/gi, "")}`;
}

// Sanitize + validate UTM input from the public widget. Each field is capped
// at 191 chars (MySQL VARCHAR default) and stripped of control characters.
// Unknown fields are dropped silently. Returns an object the route handler
// can spread into the Visit create payload — null when input is empty.
function sanitizeUtmInput(utm, referrer) {
  const out = {
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    referrer: null,
  };
  if (utm && typeof utm === "object") {
    const trim = (v) =>
      v == null
        ? null
        : String(v)
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x1f\x7f]/g, "")
          .slice(0, 191)
          .trim() || null;
    out.utmSource = trim(utm.utmSource ?? utm.source);
    out.utmMedium = trim(utm.utmMedium ?? utm.medium);
    out.utmCampaign = trim(utm.utmCampaign ?? utm.campaign);
    out.utmTerm = trim(utm.utmTerm ?? utm.term);
    out.utmContent = trim(utm.utmContent ?? utm.content);
  }
  if (referrer != null) {
    out.referrer =
      String(referrer)
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, "")
        .slice(0, 2000)
        .trim() || null;
  }
  return out;
}

// #219: rate-limit /public/book per IP. The endpoint is unauthenticated
// and creates Patient + Visit rows on every 201, so it's the trivial
// flooding vector — Sangeeta's QA pass found the route would 201 five
// concurrent requests in <1s with no throttle. 10 / minute / IP is
// enough headroom for a real clinic's burst (page-loads → form submits)
// and tight enough to make a flooding attack visible in the limiter
// headers. Test mode (NODE_ENV=test) bumps the ceiling so the per-push
// gate's other tests (which fire many requests from 127.0.0.1) don't
// trip the limiter; the per-push spec asserts on header PRESENCE, not
// the 429 itself, same shape as the auth-security spec for #295.
const _publicBookIpMax = process.env.NODE_ENV === "test" ? 5000 : 10;
const publicBookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: _publicBookIpMax,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKeyGenerator(req, res),
  message: {
    error:
      "Too many booking requests from this network. Please try again in a minute.",
    code: "RATE_LIMITED",
  },
});

router.post("/public/book", publicBookLimiter, async (req, res) => {
  try {
    const {
      tenantSlug,
      serviceId,
      locationId,
      name,
      phone,
      email,
      preferredSlot,
      notes,
      // Wave 2 Agent LL — booking-widget completion fields. All optional;
      // bookingType defaults to CLINIC_VISIT for backwards-compat with old
      // payloads (the field-by-field default lives next to the validation
      // block below so the legacy "no bookingType" flow stays visible).
      bookingType: rawBookingType,
      atHomeAddress,
      atHomeCity,
      atHomePincode,
      // Wave 8b — optional Resource (room/chair/equipment) preference
      // surfaced from the public widget. Validated below against the
      // tenant's resource catalogue and stored on Visit.resourceId.
      resourceId: rawResourceId,
      utm,
      referrer,
    } = req.body;
    if (!tenantSlug || !serviceId || !name || !phone) {
      return res
        .status(400)
        .json({ error: "tenantSlug, serviceId, name, phone required" });
    }
    // #219: validation gates on the public endpoint. Anyone on the internet
    // can hit this; the only thing keeping the DB clean is what we check here.
    // Rate limiting (per-IP) is tracked separately as a cross-cutting middleware
    // change — see TODOS.md.
    const trimmedName = String(name).trim();
    if (trimmedName.length < 2 || trimmedName.length > 100) {
      return res
        .status(400)
        .json({ error: "name must be 2–100 characters", code: "INVALID_NAME" });
    }
    const phoneStr = String(phone).trim();
    // Indian mobile: 10 digits starting 6/7/8/9, optionally with +91 / 91 prefix.
    // Reject letters, short numbers, foreign formats — those are the spam vectors.
    if (!/^(\+?91)?[6-9]\d{9}$/.test(phoneStr.replace(/[\s-]/g, ""))) {
      return res.status(400).json({
        error:
          "phone must be a 10-digit Indian mobile (starts 6/7/8/9, optional +91)",
        code: "INVALID_PHONE",
      });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return res
        .status(400)
        .json({ error: "email is not a valid format", code: "INVALID_EMAIL" });
    }
    if (preferredSlot) {
      const slot = new Date(preferredSlot);
      if (Number.isNaN(slot.getTime())) {
        return res.status(400).json({
          error: "preferredSlot is not a valid date",
          code: "INVALID_SLOT",
        });
      }
      const now = new Date();
      const ninetyDays = new Date(now.getTime() + 90 * 24 * 3600000);
      if (slot < now) {
        return res.status(400).json({
          error: "preferredSlot must be in the future",
          code: "SLOT_IN_PAST",
        });
      }
      if (slot > ninetyDays) {
        return res.status(400).json({
          error: "preferredSlot cannot be more than 90 days out",
          code: "SLOT_TOO_FAR",
        });
      }
    }

    // Wave 2 Agent LL — bookingType validation. Default to CLINIC_VISIT when
    // omitted (back-compat for widget payloads from before this column shipped).
    // Reject unknown values with INVALID_INPUT 400 — the widget should never
    // send anything outside the BOOKING_TYPES vocabulary; receiving one means
    // the client is broken or the user is hand-crafting requests.
    const bookingType = rawBookingType
      ? String(rawBookingType).trim().toUpperCase()
      : "CLINIC_VISIT";
    if (!BOOKING_TYPES.includes(bookingType)) {
      return res.status(400).json({
        error: `bookingType must be one of: ${BOOKING_TYPES.join(", ")}`,
        code: "INVALID_INPUT",
      });
    }
    // IN_HOME visits: address + pincode are mandatory. Without them the
    // dispatch system has nowhere to send the staff member, and the visit
    // row would be incomplete in a way that's invisible to the operator.
    // Trim + length-check before the more expensive tenant/service round-trips.
    let normalizedAddress = null;
    let normalizedCity = null;
    let normalizedPincode = null;
    if (bookingType === "IN_HOME") {
      const addr = atHomeAddress != null ? String(atHomeAddress).trim() : "";
      if (addr.length < 5 || addr.length > 500) {
        return res.status(400).json({
          error: "atHomeAddress is required for IN_HOME bookings (5–500 chars)",
          code: "INVALID_INPUT",
        });
      }
      const pin = atHomePincode != null ? String(atHomePincode).trim() : "";
      if (!/^\d{6}$/.test(pin)) {
        return res.status(400).json({
          error:
            "atHomePincode must be a 6-digit Indian pincode for IN_HOME bookings",
          code: "INVALID_INPUT",
        });
      }
      normalizedAddress = addr;
      normalizedCity =
        atHomeCity != null
          ? String(atHomeCity).trim().slice(0, 100) || null
          : null;
      normalizedPincode = pin;
    }

    const tenant = await prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });
    if (!tenant || tenant.vertical !== "wellness")
      return res.status(404).json({ error: "Clinic not found" });
    const parsedServiceId = parseInt(serviceId);
    if (!Number.isFinite(parsedServiceId))
      return res
        .status(400)
        .json({ error: "Invalid service", code: "INVALID_SERVICE" });
    const service = await prisma.service.findFirst({
      where: { id: parsedServiceId, tenantId: tenant.id },
    });
    if (!service)
      return res
        .status(400)
        .json({ error: "Invalid service", code: "INVALID_SERVICE" });

    // Wave 2 Agent LL — cross-check chosen bookingType against the service's
    // supported list. Returns 422 (semantic conflict) rather than 400 because
    // the input shape is valid; the issue is the SERVICE doesn't offer that
    // channel. Lets the widget render an explanatory banner ("This service
    // is in-clinic only") without re-validating the full form.
    const supported = parseSupportedBookingTypes(service.supportedBookingTypes);
    if (!supported.includes(bookingType)) {
      return res.status(422).json({
        error: `Service "${service.name}" does not support bookingType=${bookingType}. Supported: ${supported.join(", ")}`,
        code: "BOOKING_TYPE_NOT_SUPPORTED",
        supportedBookingTypes: supported,
      });
    }

    // #279 fix: previous version had two failure modes that could silently
    // 201 with no side-effects:
    //   (a) `locationId` was used as a truthy gate, but if the client sent
    //       0/""/"null" as a string it could parseInt to NaN and Prisma would
    //       reject the visit insert — the catch returned 500 (not silently),
    //       BUT the patient row created above was already committed with no
    //       transactional partner, so retries created orphan patients.
    //   (b) The fallback `findFirst({ isActive: true })` location lookup ran
    //       inline in the visit `create()` call. If no active location existed
    //       for the tenant, locationId resolved to `null` AND the visit insert
    //       went through — but the dashboard / calendar query (which scopes
    //       by locationId) would never see it.
    // Resolve everything before the write, validate, and then run patient +
    // visit inside a $transaction so partial state can't survive a crash.
    const last10 = String(phone).replace(/\D/g, "").slice(-10);
    const reqLocationId =
      locationId !== undefined && locationId !== null && locationId !== ""
        ? parseInt(locationId)
        : null;
    if (reqLocationId !== null && !Number.isFinite(reqLocationId)) {
      return res.status(400).json({
        error: "locationId must be numeric",
        code: "INVALID_LOCATION",
      });
    }
    let resolvedLocationId = reqLocationId;
    if (resolvedLocationId === null) {
      const fallback = await prisma.location.findFirst({
        where: { tenantId: tenant.id, isActive: true },
        orderBy: { id: "asc" },
      });
      resolvedLocationId = fallback?.id || null;
    } else {
      // Scope-check: the location must belong to this tenant.
      const exists = await prisma.location.findFirst({
        where: { id: resolvedLocationId, tenantId: tenant.id },
      });
      if (!exists)
        return res
          .status(400)
          .json({ error: "Invalid location", code: "INVALID_LOCATION" });
    }

    // Wave 2 Agent LL — sanitize UTM + referrer once, outside the transaction
    // so the cleanup work doesn't hold the DB connection. The HTTP Referer
    // header is read both from the JSON body (when the widget passes it
    // explicitly) and from the request headers (fallback when the widget
    // didn't capture document.referrer client-side).
    const utmFields = sanitizeUtmInput(
      utm,
      referrer ?? req.get("referer") ?? null,
    );

    // Wave 8b — optional Resource preference. Validate against the
    // tenant's catalogue (must be active + tenant-scoped + match the
    // resolved location if both are set). Reject malformed input with
    // INVALID_RESOURCE 400; an unknown ID falls through silently to
    // null so a stale widget reference doesn't 500 an otherwise-valid
    // booking.
    let resolvedResourceId = null;
    if (
      rawResourceId !== undefined &&
      rawResourceId !== null &&
      rawResourceId !== ""
    ) {
      const parsedResourceId = parseInt(rawResourceId);
      if (!Number.isFinite(parsedResourceId)) {
        return res.status(400).json({
          error: "resourceId must be numeric",
          code: "INVALID_RESOURCE",
        });
      }
      const resWhere = {
        id: parsedResourceId,
        tenantId: tenant.id,
        isActive: true,
      };
      const found = await prisma.resource.findFirst({ where: resWhere });
      if (found) {
        // Cross-check the resource's locationId matches the booking's
        // resolvedLocationId — a resource at clinic A can't serve a
        // visit at clinic B.
        if (
          found.locationId == null ||
          found.locationId === resolvedLocationId
        ) {
          resolvedResourceId = found.id;
        }
      }
      // Silent fallthrough — null resolvedResourceId on stale/foreign id.
    }

    // Wave 2 Agent LL — travel-time + video-link defaults per bookingType.
    //   IN_HOME → travelTimeMinutes resolved via lib/pincodeZones.js zone
    //             lookup (Wave 8b residual closure of the original TODO).
    //             Falls back to DEFAULT_TRAVEL_TIME_MIN when either pincode
    //             is missing — preserves legacy behaviour.
    //   VIDEO   → videoCallUrl auto-generated as a Jitsi-style room URL
    //   CLINIC_VISIT / PHONE → both stay null (legacy shape)
    let travelTimeMinutes = null;
    if (bookingType === "IN_HOME") {
      try {
        const { estimateTravelMinutes } = require("../lib/pincodeZones");
        // resolvedLocationId may be null on a no-locations tenant — fetch
        // the clinic pincode if a location was resolved, else fall back.
        let clinicPincode = null;
        if (resolvedLocationId) {
          const loc = await prisma.location.findUnique({
            where: { id: resolvedLocationId },
            select: { pincode: true },
          });
          clinicPincode = loc?.pincode || null;
        }
        travelTimeMinutes = estimateTravelMinutes(
          clinicPincode,
          normalizedPincode,
        );
      } catch (_e) {
        // Defensive — if the helper throws for any reason, fall back to
        // the legacy 30-min default rather than 500 the booking.
        travelTimeMinutes = DEFAULT_TRAVEL_TIME_MIN;
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      let patient = await tx.patient.findFirst({
        where: { tenantId: tenant.id, phone: { contains: last10 } },
      });
      if (!patient) {
        patient = await tx.patient.create({
          data: {
            name: trimmedName,
            phone: phoneStr,
            email: email ? String(email).trim() : null,
            source: "public-booking",
            tenantId: tenant.id,
            locationId: resolvedLocationId,
          },
        });
      }
      // Build the videoCallUrl post-patient-resolve so the slug references
      // a stable patientId (visit ID isn't known yet — Date.now toString
      // gives us per-room uniqueness). Only populated for VIDEO bookings.
      const videoCallUrl =
        bookingType === "VIDEO"
          ? buildVideoCallUrl(tenant.slug, patient.id)
          : null;
      const visit = await tx.visit.create({
        data: {
          visitDate: preferredSlot
            ? new Date(preferredSlot)
            : new Date(Date.now() + 24 * 3600000),
          status: "booked",
          notes: notes || null,
          patientId: patient.id,
          serviceId: service.id,
          locationId: resolvedLocationId,
          amountCharged: service.basePrice,
          tenantId: tenant.id,
          // Wave 2 Agent LL — booking-widget completion fields
          bookingType,
          atHomeAddress: normalizedAddress,
          atHomeCity: normalizedCity,
          atHomePincode: normalizedPincode,
          travelTimeMinutes,
          videoCallUrl,
          // Wave 8b — optional Resource (room/chair/equipment) preference.
          resourceId: resolvedResourceId,
          utmSource: utmFields.utmSource,
          utmMedium: utmFields.utmMedium,
          utmCampaign: utmFields.utmCampaign,
          utmTerm: utmFields.utmTerm,
          utmContent: utmFields.utmContent,
          referrer: utmFields.referrer,
        },
      });
      return { patient, visit };
    });

    res.status(201).json({
      ok: true,
      visit: result.visit,
      patient: { id: result.patient.id, name: result.patient.name },
    });
  } catch (e) {
    console.error("[wellness] public booking failed:", e.message, e.stack);
    res.status(500).json({ error: "Booking failed", detail: e.message });
  }
});

// ── PDF exports (prescriptions / consents / branded invoices) ─────

async function primaryClinic(tenantId) {
  // Prefer active location; fall back to any location.
  const active = await prisma.location.findFirst({
    where: { tenantId, isActive: true },
    orderBy: { id: "asc" },
  });
  if (active) return active;
  return prisma.location.findFirst({
    where: { tenantId },
    orderBy: { id: "asc" },
  });
}

router.get("/prescriptions/:id/pdf", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rx = await prisma.prescription.findFirst({
      where: tenantWhere(req, { id }),
      // #278: include doctor so the PDF letterhead shows the prescriber's name
      // under the signature line. Falls back to the requesting user if the
      // Rx pre-dates the doctorId column being populated.
      include: {
        patient: true,
        doctor: { select: { id: true, name: true, email: true } },
      },
    });
    if (!rx) return res.status(404).json({ error: "Prescription not found" });
    const clinic = await primaryClinic(req.user.tenantId);
    const doctor =
      rx.doctor || (req.user?.name ? { name: req.user.name } : null);
    const { tenant, logoBuffer } = await loadTenantBrandAssets(req.user.tenantId);

    // Treatment name = the service of the prescription's visit (best-effort).
    let treatmentName = null;
    try {
      if (rx.visitId) {
        const visit = await prisma.visit.findFirst({
          where: tenantWhere(req, { id: rx.visitId }),
          select: { service: { select: { name: true } } },
        });
        treatmentName = visit?.service?.name || null;
      }
    } catch (_e) { /* treatment line is optional */ }

    const buf = await renderPrescriptionPdf(rx, rx.patient, clinic, doctor, {
      tenant,
      logoBuffer,
      treatmentName,
    });
    // PRD §11: PDF export of an Rx is a downloadable PHI artefact; the audit
    // row is what proves "who pulled this drug list and when". IDs only —
    // never the drug names (those live in the Prescription row itself).
    try {
      await writeAudit(
        "Prescription",
        "PRESCRIPTION_PDF_DOWNLOAD",
        rx.id,
        req.user.userId,
        req.user.tenantId,
        {
          prescriptionId: rx.id,
          visitId: rx.visitId,
          patientId: rx.patientId,
        },
      );
    } catch (auditErr) {
      console.warn(
        "[wellness] audit PRESCRIPTION_PDF_DOWNLOAD failed:",
        auditErr.message,
      );
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="rx-${id}.pdf"`);
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.send(buf);
  } catch (e) {
    console.error("[wellness] prescription pdf error:", e.message);
    res.status(500).json({ error: "Failed to render prescription PDF" });
  }
});

// ── /my-prescriptions — staff-authed self-view of own Rx ───────────
//
// Companion to the patient-portal /portal/prescriptions endpoint but
// for staff JWTs. Resolves the logged-in user's linked Patient record
// (Patient.userId === req.user.userId, same tenant) and returns ONLY
// that Patient's prescriptions. Gated on `my_prescriptions.read` so
// admins can grant Rx self-view to any staff role (USER, MANAGER,
// DOCTOR, …) without exposing the tenant-wide `prescriptions.read`.
//
// Cross-patient access is structurally impossible: the WHERE clause
// hardcodes `patientId: linkedPatient.id`. If the staff user has no
// linked Patient row, returns an empty list with a 200 — the frontend
// renders an explanatory empty state ("Your patient profile isn't
// linked yet — ask your clinic to link it") rather than treating
// missing-link as an error.
router.get(
  "/my-prescriptions",
  requirePermission("my_prescriptions", "read"),
  async (req, res) => {
    try {
      const patient = await prisma.patient.findFirst({
        where: { userId: req.user.userId, tenantId: req.user.tenantId },
        select: { id: true, name: true },
      });
      if (!patient) {
        return res.json({ patient: null, prescriptions: [] });
      }
      const prescriptions = await prisma.prescription.findMany({
        where: { patientId: patient.id, tenantId: req.user.tenantId },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          visit: {
            select: {
              id: true,
              visitDate: true,
              service: { select: { name: true } },
            },
          },
          doctor: { select: { id: true, name: true } },
        },
      });
      // PRD §11: staff self-access of own Rx list is still a PHI read —
      // log it. ONE row per request; actorType stays 'user' so the staff-
      // side audit viewer can distinguish self-view from clinician pulls.
      try {
        await writeAudit(
          "Prescription",
          "USER_LIST_READ",
          null,
          req.user.userId,
          req.user.tenantId,
          {
            count: prescriptions.length,
            source: "my-prescriptions",
            patientId: patient.id,
          },
        );
      } catch (auditErr) {
        console.warn(
          "[wellness] audit my-prescriptions list failed:",
          auditErr.message,
        );
      }
      res.json({
        patient: { id: patient.id, name: patient.name },
        prescriptions: prescriptions.map(normalizePrescriptionDrugs),
      });
    } catch (e) {
      console.error("[wellness] my-prescriptions list error:", e.message);
      res.status(500).json({ error: "Failed to load prescriptions" });
    }
  },
);

router.get(
  "/my-prescriptions/:id/pdf",
  requirePermission("my_prescriptions", "read"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid prescription id" });
      }
      const patient = await prisma.patient.findFirst({
        where: { userId: req.user.userId, tenantId: req.user.tenantId },
        select: { id: true },
      });
      if (!patient) {
        return res.status(404).json({ error: "Prescription not found" });
      }
      const rx = await prisma.prescription.findFirst({
        where: { id, patientId: patient.id, tenantId: req.user.tenantId },
        include: {
          patient: true,
          doctor: { select: { id: true, name: true, email: true } },
        },
      });
      if (!rx) return res.status(404).json({ error: "Prescription not found" });
      const clinic = await primaryClinic(rx.tenantId);
      const { tenant, logoBuffer } = await loadTenantBrandAssets(rx.tenantId);
      const buf = await renderPrescriptionPdf(
        rx,
        rx.patient,
        clinic,
        rx.doctor || null,
        { tenant, logoBuffer },
      );
      try {
        await writeAudit(
          "Prescription",
          "PRESCRIPTION_PDF_DOWNLOAD",
          rx.id,
          req.user.userId,
          rx.tenantId,
          {
            prescriptionId: rx.id,
            visitId: rx.visitId,
            patientId: rx.patientId,
            source: "my-prescriptions",
          },
        );
      } catch (auditErr) {
        console.warn(
          "[wellness] audit my-prescriptions PDF failed:",
          auditErr.message,
        );
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="rx-${id}.pdf"`);
      res.setHeader("Content-Length", buf.length);
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.send(buf);
    } catch (e) {
      console.error("[wellness] my-prescriptions pdf error:", e.message);
      res.status(500).json({ error: "Failed to render prescription PDF" });
    }
  },
);

// Module-level cache for logo bytes — keyed by absolute file path. The
// bundled globussoft-logo.png is 2.4 MB; without the cache, every PDF
// download did a fresh fs.readFileSync, which dominated /summary.pdf
// latency. The cache lives for the process lifetime; PM2 restart picks
// up any new logo file. A sentinel of `null` records "we already
// checked this path and it doesn't exist" so we don't re-stat per call.
const __logoCache = new Map();
/**
 * Resolve the {tenant, logoBuffer} pair every clinical PDF needs to
 * render the canonical wellness branded header. Both fields are
 * optional from the renderer's perspective — tenant.name lifts the
 * H1 from the location/clinic name to the company brand, and
 * logoBuffer turns on the square logo tile in the header.
 *
 * Path resolution mirrors the patient-summary caller: prefer a tenant-
 * uploaded logo under /uploads, fall back to the bundled
 * frontend/public/globussoft-logo.png. loadCachedLogo memoises both
 * the hit and the "this path doesn't exist" miss so repeated calls
 * are free.
 */
async function loadTenantBrandAssets(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, logoUrl: true },
  });
  const logoBuffer = await resolveLogoBuffer(tenant?.logoUrl);
  return { tenant, logoBuffer };
}

function loadCachedLogo(candidatePaths) {
  for (const p of candidatePaths) {
    if (__logoCache.has(p)) {
      const cached = __logoCache.get(p);
      if (cached) return cached;
      continue;
    }
    try {
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p);
        __logoCache.set(p, buf);
        return buf;
      }
    } catch (_e) {
      /* swallow — fall through to next candidate */
    }
    __logoCache.set(p, null);
  }
  return null;
}

// Bundled fallback logos, used only when the tenant has uploaded none (or the
// upload can't be loaded). The 400×121 "-pdf" variant is PDF-safe; the
// original globussoft-logo.png is 21,618×6,558 (~567 MB decoded) and would
// OOM-kill the process inside PDFKit — it stays ONLY as a last-resort and is
// itself size-guarded below, so it can never actually be embedded.
const DEFAULT_LOGO_CANDIDATES = [
  path.join(__dirname, "..", "..", "frontend", "public", "globussoft-logo-pdf.png"),
  path.join(__dirname, "..", "..", "frontend", "public", "globussoft-logo.png"),
];

// Map a stored tenant logoUrl to an on-disk path when it's a locally-served
// upload. Pure logic + its regression test live in lib/tenantLogo.js; here we
// bind it to this file's backend dir (routes/ → ..). Returns null for remote
// (https) URLs / anything that isn't an uploads path.
const {
  localLogoDiskPath: _localLogoDiskPath,
  isLogoTooLarge,
} = require("../lib/tenantLogo");
function localLogoDiskPath(logoUrl) {
  return _localLogoDiskPath(logoUrl, path.join(__dirname, ".."));
}

// Fetch a remote (S3 / https) logo into a Buffer, memoised by URL (both hits
// and misses) so repeated PDF renders don't re-download.
async function fetchRemoteLogo(url) {
  if (__logoCache.has(url)) return __logoCache.get(url);
  try {
    const r = await fetch(url);
    if (!r.ok) {
      __logoCache.set(url, null);
      return null;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    __logoCache.set(url, buf);
    return buf;
  } catch (_e) {
    __logoCache.set(url, null);
    return null;
  }
}

// Resolve a tenant logoUrl to embeddable image bytes. Order: the tenant's
// uploaded logo (remote S3 URL OR local disk path), then the bundled default.
// Previously every clinical PDF fell straight to the default because the
// resolver only matched a "/uploads/" prefix while uploads are stored as
// "/api/uploads/..." (disk) or "https://..." (S3) — so no uploaded logo ever
// matched. This is the single source of truth for "which logo does a PDF use".
async function resolveLogoBuffer(logoUrl) {
  // 1. Tenant-uploaded logo (remote S3 URL or local disk), but only if it's
  //    a safe size — an oversized upload would OOM PDFKit, so skip it and
  //    fall through to the bundled default rather than crash the request.
  let buf = null;
  if (typeof logoUrl === "string" && /^https?:\/\//i.test(logoUrl)) {
    buf = await fetchRemoteLogo(logoUrl);
  } else {
    const disk = localLogoDiskPath(logoUrl);
    if (disk) buf = loadCachedLogo([disk]);
  }
  if (buf && !isLogoTooLarge(buf)) return buf;

  // 2. Bundled default — prefer the PDF-safe 400px logo; the full-size one is
  //    a last resort and is itself size-guarded (so it can never embed).
  for (const p of DEFAULT_LOGO_CANDIDATES) {
    const d = loadCachedLogo([p]);
    if (d && !isLogoTooLarge(d)) return d;
  }

  // 3. Nothing safe to embed → header draws its heart-glyph fallback.
  return null;
}

// GET /patients/:id/summary.pdf — full multi-page dossier for one patient.
// Bundles profile + case history + visits + Rx + treatment plans + wallet
// + memberships into a single PDF so staff can hand off / archive / share
// a complete patient record in one click. PHI-heavy — audited on every read.
router.get("/patients/:id/summary.pdf", phiReadGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid patient id" });
    }
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id, deletedAt: null }),
      include: {
        visits: {
          orderBy: { visitDate: "desc" },
          include: {
            service: true,
            doctor: { select: { id: true, name: true } },
          },
        },
        prescriptions: {
          orderBy: { createdAt: "desc" },
          include: { doctor: { select: { id: true, name: true } } },
        },
        consents: {
          orderBy: { signedAt: "desc" },
          select: {
            id: true,
            templateName: true,
            signedAt: true,
            patientId: true,
            serviceId: true,
            service: { select: { id: true, name: true } },
          },
        },
        treatmentPlans: { include: { service: true } },
      },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const [tenant, clinic, wallet, memberships] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { id: true, name: true, logoUrl: true, brandColor: true },
      }),
      primaryClinic(req.user.tenantId),
      prisma.wallet.findFirst({
        where: { tenantId: req.user.tenantId, patientId: id },
      }),
      prisma.membership.findMany({
        where: tenantWhere(req, { patientId: id }),
        include: {
          plan: {
            select: {
              id: true,
              name: true,
              durationDays: true,
              price: true,
              currency: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const walletTransactions = wallet
      ? await prisma.walletTransaction.findMany({
        where: { tenantId: req.user.tenantId, walletId: wallet.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      })
      : [];

    // Resolve a logo image to embed: prefer the tenant's uploaded logo
    // (S3 https URL OR local /api/uploads disk path), else the bundled
    // default. The renderer clips whichever source it gets to a left-side
    // square so combined "icon + wordmark" logos surface only the icon
    // portion in the corner slot. resolveLogoBuffer memoises hits + misses.
    const logoBuffer = await resolveLogoBuffer(tenant?.logoUrl);

    // Resolve visit before/after photo files into buffers the renderer
    // can embed. Photos are always uploaded to S3; the photosBefore /
    // photosAfter columns store full https:// URLs returned by the
    // S3 upload helper. We fetch each one over HTTPS in parallel with a
    // hard 4s per-URL timeout so a slow / dead S3 doesn't stall the
    // whole PDF response. Each visit is capped at 6 photos (3 before +
    // 3 after) to match what the renderer surfaces and bound PDF size.
    const parsePhotoJson = (raw) => {
      if (!raw) return [];
      if (Array.isArray(raw)) return raw.filter((u) => typeof u === "string");
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr)
          ? arr.filter((u) => typeof u === "string")
          : [];
      } catch {
        return [];
      }
    };

    const fetchS3Photo = (url) =>
      new Promise((resolve) => {
        if (!/^https?:\/\//i.test(url)) {
          console.warn(`[wellness] photo skipped — not an http(s) URL: ${url}`);
          return resolve(null);
        }
        const get = (target, hopsLeft) => {
          try {
            const lib = target.startsWith("https:")
              ? require("https")
              : require("http");
            const req2 = lib.get(target, (resp) => {
              const code = resp.statusCode || 0;
              // S3 sometimes 302s to a regional host; follow one redirect.
              if (
                code >= 300 &&
                code < 400 &&
                resp.headers.location &&
                hopsLeft > 0
              ) {
                resp.resume();
                return get(resp.headers.location, hopsLeft - 1);
              }
              if (code !== 200) {
                resp.resume();
                console.warn(`[wellness] photo fetch ${target} → HTTP ${code}`);
                return resolve(null);
              }
              const chunks = [];
              resp.on("data", (c) => chunks.push(c));
              resp.on("end", () => resolve(Buffer.concat(chunks)));
              resp.on("error", () => resolve(null));
            });
            req2.setTimeout(4000, () => {
              req2.destroy();
              resolve(null);
            });
            req2.on("error", (e) => {
              console.warn(
                `[wellness] photo fetch ${target} failed: ${e.message}`,
              );
              resolve(null);
            });
          } catch (e) {
            console.warn(
              `[wellness] photo fetch ${target} threw: ${e.message}`,
            );
            resolve(null);
          }
        };
        get(url, 1);
      });

    const photoBuffers = new Map();
    const photoFetchTasks = [];
    for (const v of patient.visits) {
      const urls = [
        ...parsePhotoJson(v.photosBefore).slice(0, 3),
        ...parsePhotoJson(v.photosAfter).slice(0, 3),
      ];
      for (const url of urls) {
        if (photoBuffers.has(url)) continue;
        photoBuffers.set(url, null); // reserve slot so parallel iters dedupe
        photoFetchTasks.push(
          fetchS3Photo(url).then((buf) => {
            if (buf) photoBuffers.set(url, buf);
            else photoBuffers.delete(url); // renderer sees missing → placeholder
          }),
        );
      }
    }
    if (photoFetchTasks.length) await Promise.all(photoFetchTasks);

    const buf = await renderPatientSummaryPdf({
      patient,
      tenant,
      clinic,
      wallet,
      walletTransactions,
      memberships,
      logoBuffer,
      photoBuffers,
    });

    try {
      await writeAudit(
        "Patient",
        "PATIENT_SUMMARY_PDF_DOWNLOAD",
        patient.id,
        req.user.userId,
        req.user.tenantId,
        {
          patientId: patient.id,
          visitCount: patient.visits.length,
          rxCount: patient.prescriptions.length,
          consentCount: patient.consents.length,
          membershipCount: memberships.length,
        },
      );
    } catch (auditErr) {
      console.warn(
        "[wellness] audit PATIENT_SUMMARY_PDF_DOWNLOAD failed:",
        auditErr.message,
      );
    }

    const safeName = String(patient.name || `patient-${id}`).replace(
      /[^a-z0-9_-]+/gi,
      "_",
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}-summary.pdf"`,
    );
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.send(buf);
  } catch (e) {
    console.error("[wellness] patient summary pdf error:", e.message);
    res.status(500).json({ error: "Failed to render patient summary PDF" });
  }
});

router.get("/consents/:id/pdf", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const consent = await prisma.consentForm.findFirst({
      where: tenantWhere(req, { id }),
      include: { patient: true, service: true },
    });
    if (!consent) return res.status(404).json({ error: "Consent not found" });

    // #564: serve from stored BLOB if available (fast path), otherwise
    // generate on-demand (old records pre-BLOB storage).
    let buf;
    let servedFromBlob = false;
    console.log(
      `[wellness] GET /consents/${id}/pdf: hasPdfBlob=${consent.hasPdfBlob}, blobSize=${consent.signedPdfBlob?.length || 0}`,
    );
    if (consent.signedPdfBlob && consent.signedPdfBlob.length > 0) {
      // Prisma Bytes type may not be a proper Buffer; ensure conversion
      buf = Buffer.isBuffer(consent.signedPdfBlob)
        ? consent.signedPdfBlob
        : Buffer.from(consent.signedPdfBlob);
      servedFromBlob = true;
      console.log(`[wellness] Using stored BLOB: ${buf.length} bytes`);
    } else {
      // Fallback: old records without stored PDF
      console.log(
        `[wellness] No BLOB found, generating on-demand for consent ${id}`,
      );
      const clinic = await primaryClinic(req.user.tenantId);
      buf = await renderConsentPdf(
        consent,
        consent.patient,
        consent.service,
        clinic,
        consent.signatureSvg,
      );
      console.log(`[wellness] On-demand PDF generated: ${buf.length} bytes`);
    }
    // PRD §11: consent PDF export carries patient PII + signature image; log it.
    try {
      await writeAudit(
        "ConsentForm",
        "CONSENT_PDF_DOWNLOAD",
        consent.id,
        req.user.userId,
        req.user.tenantId,
        {
          consentId: consent.id,
          patientId: consent.patientId,
          serviceId: consent.serviceId,
          templateName: consent.templateName,
          servedFromBlob,
        },
      );
    } catch (auditErr) {
      console.warn(
        "[wellness] audit CONSENT_PDF_DOWNLOAD failed:",
        auditErr.message,
      );
    }
    res.setHeader("Content-Type", consent.signedPdfMime || "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="consent-${id}.pdf"`,
    );
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    console.log(
      `[wellness] Sending PDF response: ${buf.length} bytes, type=${buf instanceof Buffer ? "Buffer" : typeof buf}`,
    );
    console.log(`[wellness] PDF header check: ${buf.toString("utf8", 0, 4)}`);
    res.send(buf);
  } catch (e) {
    console.error("[wellness] consent pdf error:", e.message);
    res.status(500).json({ error: "Failed to render consent PDF" });
  }
});

// #564 v3.7.3 — POST /consents/:id/archive
// Renders the consent PDF once and persists the exact bytes into
// ConsentForm.signedPdfBlob. After archival, GET /consents/:id/pdf
// returns the frozen bytes verbatim — future PDF-renderer or clinic-
// letterhead changes cannot retroactively alter the document the patient
// saw. Idempotent: re-archiving a row that already has a BLOB returns
// 200 with `alreadyArchived: true` and does NOT overwrite (the whole
// point of the freeze).
//
// RBAC: doctor / professional / admin (same as POST /consents). The
// archive action is a clinical-record finalization, not a patient
// action; staff initiates it.
router.post(
  "/consents/:id/archive",
  verifyWellnessRole(["clinical", "doctor", "professional", "admin"], {
    anyOfPermissions: [{ module: "consents", action: "write" }],
  }),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid consent id" });
      }
      const consent = await prisma.consentForm.findFirst({
        where: tenantWhere(req, { id }),
        include: { patient: true, service: true },
      });
      if (!consent) return res.status(404).json({ error: "Consent not found" });

      if (consent.signedPdfBlob && consent.signedPdfBlob.length > 0) {
        return res.status(200).json({
          ok: true,
          alreadyArchived: true,
          consentId: consent.id,
          sizeBytes: consent.signedPdfBlob.length,
          mime: consent.signedPdfMime || "application/pdf",
        });
      }

      const clinic = await primaryClinic(req.user.tenantId);
      const buf = await renderConsentPdf(
        consent,
        consent.patient,
        consent.service,
        clinic,
        consent.signatureSvg,
      );

      await prisma.consentForm.update({
        where: { id: consent.id },
        data: {
          signedPdfBlob: buf,
          signedPdfMime: "application/pdf",
        },
      });

      try {
        await writeAudit(
          "ConsentForm",
          "CONSENT_PDF_ARCHIVED",
          consent.id,
          req.user.userId,
          req.user.tenantId,
          {
            consentId: consent.id,
            patientId: consent.patientId,
            templateName: consent.templateName,
            sizeBytes: buf.length,
          },
        );
      } catch (auditErr) {
        console.warn(
          "[wellness] audit CONSENT_PDF_ARCHIVED failed:",
          auditErr.message,
        );
      }

      return res.status(200).json({
        ok: true,
        alreadyArchived: false,
        consentId: consent.id,
        sizeBytes: buf.length,
        mime: "application/pdf",
      });
    } catch (e) {
      console.error("[wellness] consent archive error:", e.message);
      res.status(500).json({ error: "Failed to archive consent PDF" });
    }
  },
);

// ── Telecaller queue ───────────────────────────────────────────────

const DISPOSITION_STATUS = {
  interested: "Lead",
  "not interested": "Churned",
  callback: "Lead",
  booked: "Prospect",
  "wrong number": "Junk",
  junk: "Junk",
};

// #214: the queue is the telecaller's daily worklist. Telecaller, manager,
// or admin only — clinical staff (doctor/professional/helper) shouldn't see
// inbound lead pipeline.
router.get(
  "/telecaller/queue",
  verifyWellnessRole(["telecaller", "admin", "manager"]),
  async (req, res) => {
    try {
      const leads = await prisma.contact.findMany({
        where: tenantWhere(req, {
          assignedToId: req.user.userId,
          status: "Lead",
        }),
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          source: true,
          aiScore: true,
          createdAt: true,
        },
        take: 200,
      });
      // #682 / #681: leads in a viewer's own queue are in-scope by definition
      // (assignedToId === req.user.userId). Telecallers / managers / admins
      // working their own queue need the FULL phone + name to make the call.
      // Emit a PII_DISCLOSED audit so the disclosure surface is traceable
      // (every queue load shows up in the audit viewer; reviewers can detect
      // a telecaller exfiltrating queue rows via repeated reads).
      if (leads.length > 0) {
        writeAudit(
          "Contact",
          "PII_DISCLOSED",
          null,
          req.user.userId,
          req.user.tenantId,
          auditDisclosureDetails(req, "telecaller_queue", leads, {
            fields: ["name", "phone", "email"],
          }),
        ).catch((e) =>
          console.warn(
            "[wellness] audit telecaller queue PII_DISCLOSED failed:",
            e.message,
          ),
        );
      }
      res.json({ leads, count: leads.length });
    } catch (e) {
      console.error("[wellness] telecaller queue error:", e.message);
      res.status(500).json({ error: "Failed to load telecaller queue" });
    }
  },
);

router.post(
  "/telecaller/dispose",
  verifyWellnessRole(["telecaller", "admin", "manager"]),
  async (req, res) => {
    try {
      const { contactId, disposition, notes } = req.body || {};
      if (!contactId || !disposition) {
        return res
          .status(400)
          .json({ error: "contactId and disposition are required" });
      }
      const key = String(disposition).toLowerCase().trim();
      if (!(key in DISPOSITION_STATUS)) {
        return res.status(400).json({ error: "Unknown disposition" });
      }
      const contact = await prisma.contact.findFirst({
        where: tenantWhere(req, { id: parseInt(contactId) }),
      });
      if (!contact) return res.status(404).json({ error: "Contact not found" });

      const description = notes ? `${disposition}: ${notes}` : disposition;
      await prisma.activity.create({
        data: {
          type: "CallDisposition",
          description,
          contactId: contact.id,
          tenantId: req.user.tenantId,
          userId: req.user.userId,
        },
      });

      const newStatus = DISPOSITION_STATUS[key];
      if (newStatus !== contact.status) {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { status: newStatus },
        });
      }
      res.json({ ok: true, status: newStatus });
    } catch (e) {
      console.error("[wellness] telecaller dispose error:", e.message);
      res.status(500).json({ error: "Failed to record disposition" });
    }
  },
);

// ── Patient portal (public login + patient-JWT reads) ─────────────

// T1.2: public health probe so PatientPortal.jsx can graceful-degrade
// when the SMS provider is not configured. The phone-OTP form silently
// fails without it; better to render a "contact your clinic" notice
// than a button that emits OTPs that never arrive. No auth: this is
// the patient-facing portal; we expose a single boolean and nothing
// else (don't leak provider name or env-var keys).
//
// Probes the env-var fallback only (MSG91_AUTH_KEY+SENDER_ID or
// FAST2SMS_API_KEY). Per-tenant DB SmsConfig is unreachable here —
// the patient hasn't yet identified which clinic — and a clinic with
// only a DB config but no env-var fallback would still hit the same
// "send fails for THIS patient's tenant" problem the env path catches.
router.get("/portal/health", (req, res) => {
  const smsConfigured = !!(
    (process.env.MSG91_AUTH_KEY && process.env.MSG91_SENDER_ID) ||
    process.env.FAST2SMS_API_KEY
  );
  res.json({ smsConfigured });
});

// POST /portal/login  body: {phone, otp}
// SECURITY: previously accepted any 4-digit OTP without verification — anyone
// who knew a patient's phone could mint a 30-day portal JWT. Now validates
// the OTP against the PatientOtp table the same way /verify-otp does.
// Callers should already be using /portal/login/request-otp + /verify-otp;
// this endpoint stays for backwards compat with older mobile builds.
router.post("/portal/login", async (req, res) => {
  try {
    const { phone, otp } = req.body || {};
    if (!phone || !otp) {
      return res.status(400).json({ error: "phone and otp are required" });
    }
    if (!/^\d{4}$/.test(String(otp))) {
      return res.status(400).json({ error: "OTP must be 4 digits" });
    }
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length < 10) {
      return res.status(400).json({ error: "Invalid phone" });
    }
    const last10 = digits.slice(-10);

    // Verify OTP against PatientOtp table — must be unused and unexpired.
    const otpRecord = await prisma.patientOtp.findFirst({
      where: {
        phone: last10,
        otp: String(otp),
        used: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!otpRecord) {
      return res.status(401).json({ error: "Invalid or expired code" });
    }

    // Patient.phone may be stored with +91 / spaces / dashes — search by "endsWith"
    // via contains on last-10 substring.
    const candidates = await prisma.patient.findMany({
      where: { phone: { contains: last10 } },
      select: { id: true, name: true, phone: true, tenantId: true },
      take: 5,
    });
    const patient = candidates.find((p) => {
      const d = String(p.phone || "").replace(/\D/g, "");
      return d.slice(-10) === last10;
    });
    if (!patient) {
      return res.status(401).json({ error: "Invalid or expired code" });
    }

    // Single-use OTP — mark consumed before issuing the token.
    await prisma.patientOtp.update({
      where: { id: otpRecord.id },
      data: { used: true },
    });

    const token = jwt.sign(
      { patientId: patient.id, phoneLast10: last10 },
      PORTAL_JWT_SECRET,
      { expiresIn: "30d" },
    );
    res.json({
      token,
      patient: { id: patient.id, name: patient.name },
    });
  } catch (e) {
    console.error("[wellness] portal login error:", e.message);
    res.status(500).json({ error: "Portal login failed" });
  }
});

router.get("/portal/me", verifyPatientToken, async (req, res) => {
  try {
    const patient = await prisma.patient.findUnique({
      where: { id: req.patient.id },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        dob: true,
        gender: true,
        tenantId: true,
      },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    // PRD §11: patient self-access via portal is still a PHI read. The actor
    // is the patient (not a staff user) so userId stays null and actorType
    // = 'patient'. Strip tenantId from the response to keep the public shape.
    try {
      const accessedFields = ["id", "name", "phone", "email", "dob", "gender"];
      await writeAudit(
        "Patient",
        "PATIENT_DETAIL_READ",
        patient.id,
        null,
        patient.tenantId,
        {
          patientId: patient.id,
          name: patient.name,
          accessedFields,
          source: "portal",
        },
        { actorType: "patient", patientId: patient.id },
      );
    } catch (auditErr) {
      console.warn("[wellness] audit portal/me failed:", auditErr.message);
    }
    const { tenantId: _t, ...publicShape } = patient;
    res.json(publicShape);
  } catch (e) {
    console.error("[wellness] portal me error:", e.message);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

// GET /portal/me/permissions — the resolved permission set for the
// logged-in patient. Patients inherit the tenant's CUSTOMER system role
// (see lib/portalPermissions.js), so this returns the union of grants on
// that role. The frontend uses this to hide tabs the patient lacks
// permission for (e.g. the Prescriptions tab when `my_prescriptions.read`
// is revoked) — purely cosmetic; the backend gate is the security boundary.
router.get("/portal/me/permissions", verifyPatientToken, async (req, res) => {
  try {
    const perms = await getCustomerRolePermissions(req.patient.tenantId);
    res.json({ permissions: Array.from(perms).sort((a, b) => a.localeCompare(b)) });
  } catch (e) {
    console.error("[wellness] portal/me/permissions error:", e.message);
    res.status(500).json({ error: "Failed to load permissions" });
  }
});

// ── Patient notification inbox (Option A: REST inbox for the patient app) ──
//
// Patient-scoped notifications served from the PatientNotification table —
// distinct from the staff /api/notifications bell (which the portal JWT can't
// reach by design). All three sit behind verifyPatientToken and scope every
// query to req.patient.id, so a patient only ever sees / mutates their own
// rows. The Android app's Room-backed inbox + the web portal can consume these.

// GET /portal/me/notifications — newest-first inbox + live unread count.
//   ?limit=N (default 50, capped 200)   ?unreadOnly=true
router.get("/portal/me/notifications", verifyPatientToken, async (req, res) => {
  try {
    const unreadOnly = req.query.unreadOnly === "true" || req.query.unreadOnly === "1";
    const { items, unreadCount } = await listPatientNotifications(req.patient.id, {
      limit: req.query.limit,
      unreadOnly,
    });
    res.json({
      notifications: items.map(toPublicNotification),
      unreadCount,
      count: items.length,
    });
  } catch (e) {
    console.error("[wellness] portal/me/notifications error:", e.message);
    res.status(500).json({ error: "Failed to load notifications" });
  }
});

// PUT /portal/me/notifications/:id/read — mark ONE read (scoped to patient).
router.put("/portal/me/notifications/:id/read", verifyPatientToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid notification id", code: "INVALID_ID" });
    }
    const updated = await markPatientNotificationRead(req.patient.id, id);
    if (!updated) {
      // Either no such id, or it belongs to another patient — same 404 either
      // way so a patient can't probe other patients' notification ids.
      return res.status(404).json({ error: "Notification not found", code: "NOTIFICATION_NOT_FOUND" });
    }
    res.json(toPublicNotification(updated));
  } catch (e) {
    console.error("[wellness] portal/me/notifications/:id/read error:", e.message);
    res.status(500).json({ error: "Failed to update notification" });
  }
});

// POST /portal/me/notifications/mark-all-read — mark all unread read.
router.post("/portal/me/notifications/mark-all-read", verifyPatientToken, async (req, res) => {
  try {
    const marked = await markAllPatientNotificationsRead(req.patient.id);
    res.json({ success: true, marked });
  } catch (e) {
    console.error("[wellness] portal/me/notifications/mark-all-read error:", e.message);
    res.status(500).json({ error: "Failed to mark all read" });
  }
});

router.get("/portal/visits", verifyPatientToken, async (req, res) => {
  try {
    // ?upcoming=true returns only future, non-cancelled visits, ordered
    // soonest-first — used by the /home dashboard's "next-appointment"
    // widget so it doesn't have to client-side-filter through every
    // historical visit. Default (no flag) keeps the existing newest-first
    // history view used by the PatientPortal /portal page's "My Visits".
    const upcoming =
      req.query.upcoming === "true" || req.query.upcoming === "1";
    const where = { patientId: req.patient.id };
    if (upcoming) {
      where.visitDate = { gte: new Date() };
      // Exclude terminal statuses rather than enumerate active ones — keeps
      // the filter forward-compatible with statuses like 'confirmed' /
      // 'checked-in' used by the Calendar grid + /appointments/my but not
      // present in the canonical ALLOWED_VISIT_STATUSES validator.
      where.status = { notIn: ["cancelled", "completed", "no-show"] };
    }
    const visits = await prisma.visit.findMany({
      where,
      orderBy: { visitDate: upcoming ? "asc" : "desc" },
      take: 50,
      include: {
        service: { select: { id: true, name: true, category: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    // PRD §11: patient-portal list read of own visits. ONE row per request.
    try {
      const tenantId = visits.length ? visits[0].tenantId : null;
      if (tenantId) {
        await writeAudit(
          "Visit",
          "PATIENT_LIST_READ",
          null,
          null,
          tenantId,
          {
            count: visits.length,
            source: "portal/visits",
            patientId: req.patient.id,
          },
          { actorType: "patient", patientId: req.patient.id },
        );
      }
    } catch (auditErr) {
      console.warn("[wellness] audit portal/visits failed:", auditErr.message);
    }
    res.json(visits);
  } catch (e) {
    console.error("[wellness] portal visits error:", e.message);
    res.status(500).json({ error: "Failed to load visits" });
  }
});

router.get(
  "/portal/prescriptions",
  verifyPatientToken,
  requirePortalPermission("my_prescriptions", "read"),
  async (req, res) => {
    try {
      const prescriptions = await prisma.prescription.findMany({
        where: { patientId: req.patient.id },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          visit: {
            select: {
              id: true,
              visitDate: true,
              service: { select: { name: true } },
            },
          },
          doctor: { select: { id: true, name: true } },
        },
      });
      // PRD §11: patient-portal list read of own Rx. ONE row per request.
      try {
        const tenantId = prescriptions.length
          ? prescriptions[0].tenantId
          : null;
        if (tenantId) {
          await writeAudit(
            "Prescription",
            "PATIENT_LIST_READ",
            null,
            null,
            tenantId,
            {
              count: prescriptions.length,
              source: "portal/prescriptions",
              patientId: req.patient.id,
            },
            { actorType: "patient", patientId: req.patient.id },
          );
        }
      } catch (auditErr) {
        console.warn(
          "[wellness] audit portal/prescriptions failed:",
          auditErr.message,
        );
      }
      res.json(prescriptions.map(normalizePrescriptionDrugs));
    } catch (e) {
      console.error("[wellness] portal prescriptions error:", e.message);
      res.status(500).json({ error: "Failed to load prescriptions" });
    }
  },
);

// GET /my-transactions — the signed-in user/customer's own financial history.
//
// Aggregates every money-touching record tied to the caller's own Patient into
// ONE normalised, date-sorted timeline so the user can see, in one place,
// everything they paid for — POS purchases (services / products / memberships
// / gift cards), online gateway payments, wallet top-ups + spends, membership
// purchases, treatment-plan packages, gift cards, and platform subscriptions.
//
// Auth: the normal app JWT via the global guard (verifyToken populates
// req.user). NOT mounted under /portal so it works for BOTH a customer-tier
// USER and a self-registered CUSTOMER — whoever is signed in. We resolve the
// caller's OWN Patient via Patient.userId and filter every query on that
// patient's id, so one user can never read another's history. A signed-in
// user with no linked Patient simply gets an empty history (not an error).
//
// Summary math (de-dup reasoning, documented so future edits don't double
// count): `totalPaid` = value of purchases the customer made =
//   Σ COMPLETED Sale.total − Σ REFUNDED Sale.total   (POS, any tender)
//   + Σ SUCCESS Payment.amount                        (online gateway)
//   + Σ non-cancelled Subscription.amount             (recurring plans)
// Wallet TOP_UPs are a FUNDING mechanism (money loaded, later spent at POS
// which is already in Sale.total) so they are reported SEPARATELY under the
// wallet block rather than added into totalPaid — adding both would count the
// same rupee twice (once on top-up, once on the wallet-tendered sale).
router.get("/my-transactions", verifyToken, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    const tenantId = req.user.tenantId;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { defaultCurrency: true },
    });
    const currency = tenant?.defaultCurrency || "INR";

    // Resolve the caller's own Patient. CUSTOMER self-registered users link
    // via Patient.userId; staff/USER who are also a patient resolve the same
    // way. No linked Patient ⇒ empty history (a 200, not a 404) so the page
    // renders a clean empty state rather than an error toast.
    const patient = await prisma.patient.findFirst({
      where: { userId: req.user.userId, tenantId },
      select: { id: true, tenantId: true, userId: true },
    });
    if (!patient) {
      return res.json({
        currency,
        summary: {
          totalPaid: 0,
          posTotal: 0,
          onlineTotal: 0,
          subscriptionsTotal: 0,
          walletBalance: 0,
          walletTopUps: 0,
          transactionCount: 0,
        },
        transactions: [],
      });
    }

    // Optional ?from / ?to ISO date filtering. Invalid values are ignored
    // (the page only ever sends well-formed ISO strings or nothing).
    const fromDate = req.query.from ? new Date(req.query.from) : null;
    const toDate = req.query.to ? new Date(req.query.to) : null;
    const range = {};
    if (fromDate && !Number.isNaN(fromDate.getTime())) range.gte = fromDate;
    if (toDate && !Number.isNaN(toDate.getTime())) range.lte = toDate;
    const hasRange = Object.keys(range).length > 0;
    const onCreated = hasRange ? { createdAt: range } : {};

    // 1. POS sales (services / products / memberships / gift cards rung up
    //    at the till) + their line-item breakdown.
    const sales = await prisma.sale.findMany({
      where: { patientId: patient.id, ...onCreated },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        lineItems: {
          select: {
            id: true,
            lineType: true,
            name: true,
            quantity: true,
            unitPrice: true,
            lineTotal: true,
          },
        },
      },
    });

    // 2. Wallet ledger (top-ups, redemptions, cashback, gift-card moves).
    const wallet = await prisma.wallet.findFirst({
      where: { patientId: patient.id },
      select: { id: true, balance: true, currency: true },
    });
    let walletTxns = [];
    if (wallet) {
      walletTxns = await prisma.walletTransaction.findMany({
        where: { walletId: wallet.id, ...onCreated },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
    }

    // 3. Membership purchases.
    const memberships = await prisma.membership.findMany({
      where: { patientId: patient.id, ...onCreated },
      orderBy: { createdAt: "desc" },
      include: {
        plan: { select: { name: true, price: true, currency: true } },
      },
    });

    // 4. Treatment-plan packages (startedAt is the purchase moment).
    const plans = await prisma.treatmentPlan.findMany({
      where: {
        patientId: patient.id,
        ...(hasRange ? { startedAt: range } : {}),
      },
      orderBy: { startedAt: "desc" },
      include: { service: { select: { name: true } } },
    });

    // 5. Gift cards received or redeemed by this patient (informational —
    //    NOT added to totalPaid; the purchase itself already shows up as a
    //    POS sale line / wallet move).
    const giftCards = await prisma.giftCard.findMany({
      where: {
        OR: [{ issuedTo: patient.id }, { redeemedBy: patient.id }],
        ...onCreated,
      },
      orderBy: { createdAt: "desc" },
    });

    // 6. Online gateway payments tied to this patient's visit invoices.
    const visits = await prisma.visit.findMany({
      where: { patientId: patient.id },
      select: { id: true },
    });
    const visitIds = visits.map((v) => v.id);
    let invoicePayments = [];
    if (visitIds.length) {
      const invoices = await prisma.invoice.findMany({
        where: { visitId: { in: visitIds } },
        select: { id: true, invoiceNum: true },
      });
      const invoiceById = new Map(invoices.map((i) => [i.id, i]));
      const invoiceIds = invoices.map((i) => i.id);
      if (invoiceIds.length) {
        const rows = await prisma.payment.findMany({
          where: { invoiceId: { in: invoiceIds }, ...onCreated },
          orderBy: { createdAt: "desc" },
          take: 200,
        });
        invoicePayments = rows.map((p) => ({
          ...p,
          invoiceNum: p.invoiceId
            ? invoiceById.get(p.invoiceId)?.invoiceNum || null
            : null,
          kind: "invoice",
        }));
      }
    }

    // 6b. Gift-card-purchase gateway payments. These have invoiceId = null
    //     (the buyer's id lives in Payment.metadata), so the invoice join
    //     above misses them. This is the ACTUAL money the customer spent
    //     buying a gift card — the matching EXPENSE for the wallet credit
    //     that shows separately as a WalletTransaction. Fetch the tenant's
    //     invoice-less payments raw; buildTransactionTimeline() filters them
    //     down to this caller's confirmed gift-card buys via the metadata.
    const giftCardPaymentRows = await prisma.payment.findMany({
      where: { tenantId, invoiceId: null, ...onCreated },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    // 7. Platform / recurring subscriptions (User-level, not Patient).
    let subscriptions = [];
    if (patient.userId) {
      subscriptions = await prisma.subscription.findMany({
        where: {
          userId: patient.userId,
          tenantId,
          ...(hasRange ? { startDate: range } : {}),
        },
        orderBy: { startDate: "desc" },
      });
    }

    // ── Normalise + summarise (pure helper, unit-tested separately) ──────
    const { buildTransactionTimeline } = require("../lib/transactionTimeline");
    const { transactions: txns, summary } = buildTransactionTimeline({
      patient,
      sales,
      walletTxns,
      memberships,
      plans,
      giftCards,
      invoicePayments,
      giftCardPaymentRows,
      subscriptions,
      walletBalance: wallet?.balance || 0,
    });

    // Best-effort PHI-read audit, mirroring the sibling portal list routes.
    try {
      await writeAudit(
        "Payment",
        "PATIENT_LIST_READ",
        null,
        null,
        tenantId,
        {
          count: txns.length,
          source: "portal/transactions",
          patientId: patient.id,
        },
        { actorType: "patient", patientId: patient.id },
      );
    } catch (auditErr) {
      console.warn(
        "[wellness] audit portal/transactions failed:",
        auditErr.message,
      );
    }

    res.json({ currency, summary, transactions: txns });
  } catch (e) {
    console.error("[wellness] portal transactions error:", e.message);
    res.status(500).json({ error: "Failed to load transactions" });
  }
});

// ── Patient-portal product catalogue ───────────────────────────────
//
// Read-only product browsing for patients. Mirrors the staff
// /products + /product-categories list endpoints but:
//   - runs under verifyPatientToken (req.patient, not req.user)
//   - uses requirePortalPermission('products', 'read') so the
//     CUSTOMER role grant in the Roles & Permissions matrix is the
//     authoritative switch (admin unchecks it → patients no longer
//     see the catalogue)
//   - returns ONLY safe fields — no SKU, stock, purchase/dealer
//     price, manufacturer, or tax internals — so the clinic's
//     inventory-management data stays out of patient hands even if
//     the same Product row is shared with the staff endpoint
//   - hides products flagged Consumption (clinic-only consumables)
//     and inactive rows so the shopping surface only shows things
//     a patient could plausibly buy
router.get(
  "/portal/products",
  verifyPatientToken,
  requirePortalPermission("products", "read"),
  async (req, res) => {
    try {
      const items = await prisma.product.findMany({
        where: {
          tenantId: req.patient.tenantId,
          isActive: true,
          // Consumption-only products are clinic supplies (gauze,
          // disposables) — not part of the patient-facing catalogue.
          // Treat null productType as Sale (back-compat with pre-v3.4
          // rows that didn't set the field).
          NOT: { productType: "Consumption" },
        },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          description: true,
          price: true,
          discountedPrice: true,
          imageUrl: true,
          brandName: true,
          volume: true,
          unit: true,
          category: { select: { id: true, name: true } },
        },
      });
      res.json(items);
    } catch (e) {
      console.error("[wellness] portal products error:", e.message);
      res.status(500).json({ error: "Failed to load products" });
    }
  },
);

router.get(
  "/portal/product-categories",
  verifyPatientToken,
  requirePortalPermission("products", "read"),
  async (req, res) => {
    try {
      const items = await prisma.productCategory.findMany({
        where: {
          tenantId: req.patient.tenantId,
          isActive: true,
        },
        orderBy: [{ parentId: "asc" }, { name: "asc" }],
        select: {
          id: true,
          name: true,
          parentId: true,
          imageUrl: true,
          color: true,
        },
      });
      res.json(items);
    } catch (e) {
      console.error("[wellness] portal product-categories error:", e.message);
      res.status(500).json({ error: "Failed to load product categories" });
    }
  },
);

// GET /portal/prescriptions/:id/pdf — patient self-download of an Rx PDF.
//
// Staff use the sibling `/prescriptions/:id/pdf` endpoint which runs under
// the global staff-JWT guard. Patients arrive with a portal token
// (carries `patientId`, NOT `userId` / `tenantId`) so they hit /portal/*
// instead — the openPaths whitelist in server.js routes /portal/* around
// the global guard, and verifyPatientToken below proves the patient
// owns the prescription before we render a PDF.
//
// Scope discipline: filter on `patientId: req.patient.id` (NOT tenantId
// alone — the patient already proved tenancy via the OTP login flow, and
// filtering on tenantId would leak Rx for OTHER patients in the same
// clinic). The Rx's own tenantId then drives the clinic letterhead.
router.get(
  "/portal/prescriptions/:id/pdf",
  verifyPatientToken,
  requirePortalPermission("my_prescriptions", "read"),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid prescription id" });
      }
      const rx = await prisma.prescription.findFirst({
        where: { id, patientId: req.patient.id },
        include: {
          patient: true,
          doctor: { select: { id: true, name: true, email: true } },
        },
      });
      if (!rx) return res.status(404).json({ error: "Prescription not found" });
      const clinic = await primaryClinic(rx.tenantId);
      const doctor = rx.doctor || null;
      const { tenant, logoBuffer } = await loadTenantBrandAssets(rx.tenantId);
      const buf = await renderPrescriptionPdf(rx, rx.patient, clinic, doctor, {
        tenant,
        logoBuffer,
      });
      // PRD §11: PDF downloads of PHI go to the audit ledger. ONE row per
      // request; actorType='patient' so the staff-side audit viewer can
      // distinguish self-downloads from clinician-pulled copies.
      try {
        await writeAudit(
          "Prescription",
          "PRESCRIPTION_PDF_DOWNLOAD",
          rx.id,
          null,
          rx.tenantId,
          {
            prescriptionId: rx.id,
            visitId: rx.visitId,
            patientId: rx.patientId,
            source: "portal",
          },
          { actorType: "patient", patientId: req.patient.id },
        );
      } catch (auditErr) {
        console.warn(
          "[wellness] audit portal PRESCRIPTION_PDF_DOWNLOAD failed:",
          auditErr.message,
        );
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="rx-${id}.pdf"`);
      res.setHeader("Content-Length", buf.length);
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.send(buf);
    } catch (e) {
      console.error("[wellness] portal prescription pdf error:", e.message);
      res.status(500).json({ error: "Failed to render prescription PDF" });
    }
  },
);

// POST /portal/export — patient self-DSAR (DPDP Act §15 / GDPR Article 15).
// Closes v3.4.8 carry-over #2: prior to this endpoint, wellness-portal
// patients had NO mechanism to obtain a copy of their own data — they
// could only read scoped slices via /portal/me + /portal/visits +
// /portal/prescriptions. The staff-side equivalent is POST
// /api/gdpr/export/me but the global auth gate (middleware/auth.js:23)
// blocks portal tokens from /api/gdpr/* by design (those tokens carry
// patientId, not userId).
//
// Mirrors the SHAPE of /api/gdpr/export/me: returns one JSON envelope
// keyed by entity, plus a `counts` summary, and writes ONE AuditLog row
// (action='GDPR_EXPORT_SELF', entity='Patient', actorType='patient').
// FK chain walked: Patient → Visit → Prescription → ConsentForm →
// TreatmentPlan → LoyaltyTransaction → Referral. Every query filters by
// `patientId: req.patient.id` (NOT tenantId — the patient already proved
// tenancy via the OTP login flow; filtering on tenantId only would leak
// other patients' rows in the same clinic).
//
// Field-level encryption (WELLNESS_FIELD_KEY, see CLAUDE.md): the Prisma
// $extends client decrypts on read since v3.2.1, so findMany returns
// plaintext — no manual decryption here.
//
// Audit: writeAudit gets actorType='patient' + patientId=req.patient.id
// per backend/lib/audit.js convention so a reviewer filtering by
// _actorType="patient" + action=GDPR_EXPORT_SELF can audit every
// self-export trivially. Audit failures are caught — a logging blip
// must not block the patient's data-access right.
router.post("/portal/export", verifyPatientToken, async (req, res) => {
  try {
    const patient = await prisma.patient.findUnique({
      where: { id: req.patient.id },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        dob: true,
        gender: true,
        bloodGroup: true,
        allergies: true,
        notes: true,
        photoUrl: true,
        source: true,
        contactId: true,
        tenantId: true,
        locationId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    // Fan-out FK-chain reads. All filtered by patientId (the OTP login
    // already pinned tenancy; tenantId-only filters would cross-leak).
    const [
      visits,
      prescriptions,
      consents,
      treatmentPlans,
      loyaltyTransactions,
      referrals,
    ] = await Promise.all([
      prisma.visit.findMany({
        where: { patientId: patient.id },
        orderBy: { visitDate: "desc" },
        include: {
          service: { select: { id: true, name: true, category: true } },
          doctor: { select: { id: true, name: true } },
        },
      }),
      prisma.prescription.findMany({
        where: { patientId: patient.id },
        orderBy: { createdAt: "desc" },
        include: {
          doctor: { select: { id: true, name: true } },
        },
      }),
      prisma.consentForm.findMany({
        where: { patientId: patient.id },
        orderBy: { signedAt: "desc" },
      }),
      prisma.treatmentPlan.findMany({
        where: { patientId: patient.id },
        orderBy: { startedAt: "desc" },
      }),
      prisma.loyaltyTransaction
        .findMany({
          where: { patientId: patient.id },
          orderBy: { createdAt: "desc" },
        })
        .catch(() => []),
      prisma.referral
        .findMany({
          where: { referrerPatientId: patient.id },
          orderBy: { createdAt: "desc" },
        })
        .catch(() => []),
    ]);

    const counts = {
      patient: 1,
      visits: visits.length,
      prescriptions: prescriptions.length,
      consents: consents.length,
      treatmentPlans: treatmentPlans.length,
      loyaltyTransactions: loyaltyTransactions.length,
      referrals: referrals.length,
    };

    // PRD §11 + DPDP Act §15: every self-DSAR is itself a PHI access event
    // and MUST land in AuditLog. Distinct action name `_SELF` so reviewers
    // can filter staff-initiated GDPR_EXPORT vs patient-initiated exports
    // without parsing details JSON.
    let audited = false;
    try {
      await writeAudit(
        "Patient",
        "GDPR_EXPORT_SELF",
        patient.id,
        null,
        patient.tenantId,
        {
          reason: "DPDP §15 / GDPR Article 15 self-export (portal)",
          source: "portal/export",
          counts,
        },
        { actorType: "patient", patientId: patient.id },
      );
      audited = true;
    } catch (auditErr) {
      console.warn("[wellness] audit portal/export failed:", auditErr.message);
    }

    // Strip tenantId from the public response shape — patient never needs
    // to see the integer id of their clinic.
    const { tenantId: _t, ...patientPublic } = patient;

    res.set(
      "Content-Disposition",
      `attachment; filename=patient-${patient.id}-export.json`,
    );
    res.json({
      exportedAt: new Date().toISOString(),
      patient: patientPublic,
      visits,
      prescriptions,
      consents,
      treatmentPlans,
      loyaltyTransactions,
      referrals,
      counts,
      audited,
    });
  } catch (e) {
    console.error("[wellness] portal export error:", e.message);
    res.status(500).json({ error: "Failed to export patient data" });
  }
});

router.get("/invoices/:id/branded-pdf", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const invoice = await prisma.invoice.findFirst({
      where: tenantWhere(req, { id }),
      include: { contact: true },
    });
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    const clinic = await primaryClinic(req.user.tenantId);
    const buf = await renderBrandedInvoicePdf(invoice, invoice.contact, clinic);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="invoice-${id}.pdf"`,
    );
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (e) {
    console.error("[wellness] branded invoice pdf error:", e.message);
    res.status(500).json({ error: "Failed to render invoice PDF" });
  }
});

// ── Agent C: White-label branding (logo + brand color) ─────────────
//
// Logo storage mirrors the visit-photo contract: S3-primary, local-FS
// fallback. When AWS creds are configured (S3_BUCKET_NAME set) the logo is
// uploaded to S3 under branding/tenant-<id>/ and we store the S3 URL;
// otherwise it persists to uploads/branding/tenant-<id>/ and we store the
// /api/uploads/... path served statically by server.js. Replacing the logo
// deletes the previous asset (S3 object or local file) so nothing orphans.
// Limit: 20 MB, common image types only. ADMIN only for mutations; GET is
// readable by any authenticated tenant user (sidebar + login flows).

// memoryStorage so the buffer is available to hand to S3 (uploadImage) or to
// write to disk in the fallback path.
const brandingLogoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/i.test(
      file.mimetype || "",
    );
    if (!ok)
      return cb(new Error("Logo must be an image (png/jpg/gif/webp/svg)"));
    cb(null, true);
  },
});

// Best-effort delete of a previously-saved logo so replacing the image never
// leaves an orphan behind. Handles both S3 URLs (http/https → deleteFile) and
// local paths (/uploads/... or /api/uploads/... → fs.unlink). Never throws —
// a failed cleanup must not block the new logo from being saved.
async function deleteOldBrandingLogo(oldLogoUrl) {
  if (!oldLogoUrl) return;
  try {
    if (/^https?:\/\//i.test(oldLogoUrl)) {
      // Remote URL — remove the object if it lives in our S3 bucket.
      const fileKey = extractKeyFromUrl(oldLogoUrl);
      if (fileKey) await deleteFile(fileKey);
    } else {
      // Local path — map /uploads/<rest> or /api/uploads/<rest> back to disk.
      const m = oldLogoUrl.match(/\/(?:api\/)?uploads\/(.+)$/);
      if (m) {
        const rel = m[1].split("?")[0];
        const abs = path.join(__dirname, "..", "uploads", rel);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      }
    }
  } catch (e) {
    console.warn("[wellness] old logo cleanup warning:", e.message);
  }
}

function requireTenantAdmin(req, res, next) {
  if (!req.user || req.user.role !== "ADMIN") {
    // Neutral copy + structured code — no internal role-taxonomy leakage.
    return res.status(403).json({
      error: "You do not have permission to perform this action",
      code: "TENANT_ADMIN_REQUIRED",
    });
  }
  next();
}

router.post(
  "/branding/logo",
  requireTenantAdmin,
  (req, res, next) => {
    brandingLogoUpload.single("logo")(req, res, (err) => {
      if (err) {
        const msg =
          err.code === "LIMIT_FILE_SIZE"
            ? "Logo file too large (max 20 MB)"
            : err.message || "Logo upload failed";
        return res.status(400).json({ error: msg });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file)
        return res
          .status(400)
          .json({ error: "No logo file provided (field 'logo')" });

      // Capture the currently-saved logo BEFORE we overwrite the column, so we
      // can delete the old asset once the new one is safely in place.
      const current = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { logoUrl: true },
      });
      const oldLogoUrl = current ? current.logoUrl : null;

      // S3-primary, local-FS fallback (same contract as visit photos).
      let logoUrl;
      if (S3_BUCKET_NAME) {
        logoUrl = await uploadImage(
          req.file.buffer,
          req.file.originalname || "logo.png",
          req.file.mimetype,
          `branding/tenant-${req.user.tenantId}`,
        );
      } else {
        const dir = path.join(
          __dirname,
          "..",
          "uploads",
          "branding",
          `tenant-${req.user.tenantId}`,
        );
        fs.mkdirSync(dir, { recursive: true });
        const ext =
          (path.extname(req.file.originalname || "") || ".png")
            .toLowerCase()
            .replace(/[^.a-z0-9]/g, "") || ".png";
        // Timestamped name so each replacement is a distinct file — the old one
        // is then explicitly deleted below, and cached URLs never serve stale art.
        const filename = `logo-${Date.now()}${ext}`;
        fs.writeFileSync(path.join(dir, filename), req.file.buffer);
        logoUrl = `/api/uploads/branding/tenant-${req.user.tenantId}/${filename}`;
      }

      await prisma.tenant.update({
        where: { id: req.user.tenantId },
        data: { logoUrl },
      });

      // Replace = delete the previous asset. Best-effort, after the new URL is
      // persisted, and skipped when the path is unchanged.
      if (oldLogoUrl && oldLogoUrl !== logoUrl) {
        await deleteOldBrandingLogo(oldLogoUrl);
      }

      res.json({ logoUrl });
    } catch (e) {
      console.error("[wellness] branding logo error:", e.message);
      res.status(500).json({ error: "Failed to save logo" });
    }
  },
);

// DELETE /branding/logo (2026-07-08) — clears Tenant.logoUrl and removes the
// underlying file from S3/disk. Companion to POST /branding/logo, whose only
// prior path to "remove a logo" was uploading a replacement.
router.delete("/branding/logo", requireTenantAdmin, async (req, res) => {
  try {
    const current = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { logoUrl: true },
    });
    if (!current?.logoUrl) {
      return res.json({ logoUrl: null }); // already logo-less — no-op
    }
    await prisma.tenant.update({
      where: { id: req.user.tenantId },
      data: { logoUrl: null },
    });
    await deleteOldBrandingLogo(current.logoUrl);
    res.json({ logoUrl: null });
  } catch (e) {
    console.error("[wellness] branding logo delete error:", e.message);
    res.status(500).json({ error: "Failed to delete logo" });
  }
});

router.put("/branding/color", requireTenantAdmin, async (req, res) => {
  try {
    const { brandColor } = req.body || {};
    if (
      brandColor !== null &&
      brandColor !== "" &&
      !/^#[0-9a-fA-F]{6}$/.test(brandColor || "")
    ) {
      return res
        .status(400)
        .json({ error: "brandColor must be a 6-digit hex like #265855" });
    }
    const tenant = await prisma.tenant.update({
      where: { id: req.user.tenantId },
      data: { brandColor: brandColor || null },
    });
    res.json({ brandColor: tenant.brandColor });
  } catch (e) {
    console.error("[wellness] branding color error:", e.message);
    res.status(500).json({ error: "Failed to save brand color" });
  }
});

router.put("/branding/theme-color", requireTenantAdmin, async (req, res) => {
  try {
    const { themeColor } = req.body || {};
    if (
      themeColor !== null &&
      themeColor !== "" &&
      !/^#[0-9a-fA-F]{6}$/.test(themeColor || "")
    ) {
      return res
        .status(400)
        .json({ error: "themeColor must be a 6-digit hex like #C9A063" });
    }
    try {
      const tenant = await prisma.tenant.update({
        where: { id: req.user.tenantId },
        data: { themeColor: themeColor || null },
      });
      res.json({ themeColor: tenant.themeColor });
    } catch (prismaErr) {
      if (prismaErr.message && prismaErr.message.includes("Unknown field")) {
        // Prisma client not yet regenerated after schema migration.
        // The DB column exists; run `prisma generate` + restart to activate.
        return res.status(503).json({
          error: "Theme color field not yet available — restart the backend after running `npx prisma generate`.",
        });
      }
      throw prismaErr;
    }
  } catch (e) {
    console.error("[wellness] branding theme-color error:", e.message);
    res.status(500).json({ error: "Failed to save theme color" });
  }
});

router.get("/branding", async (req, res) => {
  try {
    // Select fields that exist in the currently-generated Prisma client.
    // themeColor is fetched in a separate try block so a stale Prisma
    // client (not yet regenerated after the schema migration) doesn't
    // crash the entire branding endpoint — it will just return null for
    // themeColor until the backend is restarted after `prisma generate`.
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: {
        logoUrl: true,
        brandColor: true,
        name: true,
        defaultCurrency: true,
      },
    });
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    let themeColor = null;
    try {
      const t2 = await prisma.tenant.findUnique({
        where: { id: req.user.tenantId },
        select: { themeColor: true },
      });
      themeColor = t2?.themeColor || null;
    } catch (_ignored) {
      // Prisma client not yet regenerated — themeColor unavailable until restart
    }

    res.json({ ...tenant, themeColor });
  } catch (e) {
    console.error("[wellness] branding get error:", e.message);
    res.status(500).json({ error: "Failed to load branding" });
  }
});

// ── Agent D: Loyalty + Referrals ─────────────────────────────────────
//
// Loyalty model: append-only ledger of LoyaltyTransaction rows (positive
// for credits, negative for redemptions). Balance is SUM(points). Default
// earn rule (applied client-side / by future cron): 10% of amountCharged
// rounded down. We do NOT auto-earn here on visit creation — keeps the
// route surface explicit; managers/staff credit via /loyalty/:id/credit.
//
// Referral lifecycle: pending -> signed_up -> first_visit -> rewarded.
// /referrals/:id/reward writes the bonus points + flips status atomically.

function requireManagerPlus(req, res, next) {
  const role = req.user?.role;
  if (role === "ADMIN" || role === "MANAGER") return next();
  // Neutral copy + structured code — no internal role-taxonomy leakage.
  return res.status(403).json({
    error: "You do not have permission to perform this action",
    code: "MANAGER_ROLE_REQUIRED",
  });
}

// #614 — Loyalty rules (earn / burn config). Per-tenant row in LoyaltyConfig.
// Defaults mirror the historic hardcoded rule (10% of spend) so behaviour is
// byte-identical when no row exists. NOTE: these /loyalty/rules routes MUST
// be registered BEFORE /loyalty/:patientId — otherwise Express's :patientId
// path-param swallows "rules" as an integer-parse failure (400).
const LOYALTY_DEFAULTS = {
  earnPerVisit: 0,
  earnPercentOfSpend: 10,
  earnPerCurrencyUnit: 0,
  redeemPointsPerUnit: 10,
  welcomeBonus: 0,
  referralBonus: 100,
  autoEarnEnabled: true,
};

async function loadLoyaltyConfig(tenantId) {
  const cfg = await prisma.loyaltyConfig.findUnique({ where: { tenantId } });
  return cfg
    ? { ...LOYALTY_DEFAULTS, ...cfg }
    : { ...LOYALTY_DEFAULTS, tenantId };
}

router.get("/loyalty/rules", async (req, res) => {
  try {
    const cfg = await loadLoyaltyConfig(req.user.tenantId);
    res.json(cfg);
  } catch (e) {
    console.error("[wellness] loyalty rules get error:", e.message);
    res.status(500).json({ error: "Failed to load loyalty rules" });
  }
});

router.put("/loyalty/rules", requireManagerPlus, async (req, res) => {
  try {
    const allowed = [
      "earnPerVisit",
      "earnPercentOfSpend",
      "earnPerCurrencyUnit",
      "redeemPointsPerUnit",
      "welcomeBonus",
      "referralBonus",
      "autoEarnEnabled",
    ];
    const data = {};
    for (const k of allowed) {
      if (req.body[k] === undefined) continue;
      if (k === "autoEarnEnabled") {
        data[k] = !!req.body[k];
        continue;
      }
      const n = Number(req.body[k]);
      if (!Number.isFinite(n) || n < 0) {
        return res
          .status(400)
          .json({ error: `${k} must be a non-negative number` });
      }
      // Integers vs floats: percent + earnPerCurrencyUnit are floats; the rest are integers.
      data[k] = ["earnPercentOfSpend", "earnPerCurrencyUnit"].includes(k)
        ? n
        : Math.floor(n);
    }
    if (
      data.earnPercentOfSpend !== undefined &&
      data.earnPercentOfSpend > 100
    ) {
      return res
        .status(400)
        .json({ error: "earnPercentOfSpend must be ≤ 100" });
    }

    const tenantId = req.user.tenantId;
    const cfg = await prisma.loyaltyConfig.upsert({
      where: { tenantId },
      update: data,
      create: { tenantId, ...data },
    });
    await writeAudit(
      "LoyaltyConfig",
      "UPDATE",
      cfg.id,
      req.user.userId,
      tenantId,
      data,
    );
    res.json({ ...LOYALTY_DEFAULTS, ...cfg });
  } catch (e) {
    console.error("[wellness] loyalty rules put error:", e.message);
    res.status(500).json({ error: "Failed to update loyalty rules" });
  }
});

router.get("/loyalty/:patientId", async (req, res) => {
  try {
    const patientId = parseInt(req.params.patientId, 10);
    if (Number.isNaN(patientId)) {
      return res.status(400).json({ error: "patientId must be an integer" });
    }
    // Confirm patient is in this tenant
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
      select: { id: true, name: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const [agg, transactions, monthAgg] = await Promise.all([
      prisma.loyaltyTransaction.aggregate({
        where: { tenantId: req.user.tenantId, patientId },
        _sum: { points: true },
      }),
      prisma.loyaltyTransaction.findMany({
        where: { tenantId: req.user.tenantId, patientId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.loyaltyTransaction.aggregate({
        where: {
          tenantId: req.user.tenantId,
          patientId,
          points: { gt: 0 },
          createdAt: {
            gte: startOfDay(
              new Date(new Date().getFullYear(), new Date().getMonth(), 1),
            ),
          },
        },
        _sum: { points: true },
      }),
    ]);

    res.json({
      patient,
      balance: agg._sum.points || 0,
      earnedThisMonth: monthAgg._sum.points || 0,
      transactions,
    });
  } catch (e) {
    console.error("[wellness] loyalty get error:", e.message);
    res.status(500).json({ error: "Failed to load loyalty" });
  }
});

router.post(
  "/loyalty/:patientId/credit",
  requireManagerPlus,
  async (req, res) => {
    try {
      const patientId = parseInt(req.params.patientId, 10);
      if (Number.isNaN(patientId)) {
        return res.status(400).json({ error: "patientId must be an integer" });
      }
      const points = parseInt(req.body.points, 10);
      const reason = req.body.reason || "Manual credit";
      if (Number.isNaN(points) || points <= 0) {
        return res
          .status(400)
          .json({ error: "points must be a positive integer" });
      }
      const patient = await prisma.patient.findFirst({
        where: tenantWhere(req, { id: patientId }),
        select: { id: true },
      });
      if (!patient) return res.status(404).json({ error: "Patient not found" });

      const tx = await prisma.loyaltyTransaction.create({
        data: {
          patientId,
          tenantId: req.user.tenantId,
          type: "manual_credit",
          points,
          reason,
        },
      });
      // #179: audit manual loyalty credits — these are a fraud surface
      // (a manager can hand out points). entityId is the patient, not the tx,
      // so admins can browse a patient's full credit history at a glance.
      await writeAudit(
        "Patient",
        "CREDIT_LOYALTY",
        patientId,
        req.user.userId,
        req.user.tenantId,
        {
          transactionId: tx.id,
          points,
          reason,
        },
      );
      res.status(201).json(tx);
    } catch (e) {
      console.error("[wellness] loyalty credit error:", e.message);
      res.status(500).json({ error: "Failed to credit loyalty" });
    }
  },
);

router.post("/loyalty/:patientId/redeem", async (req, res) => {
  try {
    const patientId = parseInt(req.params.patientId, 10);
    if (Number.isNaN(patientId)) {
      return res.status(400).json({ error: "patientId must be an integer" });
    }
    const points = parseInt(req.body.points, 10);
    const reason = req.body.reason || "Redemption";
    if (Number.isNaN(points) || points <= 0) {
      return res
        .status(400)
        .json({ error: "points must be a positive integer" });
    }
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
      select: { id: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const agg = await prisma.loyaltyTransaction.aggregate({
      where: { tenantId: req.user.tenantId, patientId },
      _sum: { points: true },
    });
    const balance = agg._sum.points || 0;
    if (balance < points) {
      return res.status(400).json({
        error: `Insufficient balance: ${balance} points available, ${points} requested`,
        code: "INSUFFICIENT_BALANCE",
        balance,
      });
    }

    const tx = await prisma.loyaltyTransaction.create({
      data: {
        patientId,
        tenantId: req.user.tenantId,
        type: "redeemed",
        points: -points,
        reason,
      },
    });
    // #179: audit redemption with balance-after for ledger reconciliation.
    await writeAudit(
      "Patient",
      "REDEEM_LOYALTY",
      patientId,
      req.user.userId,
      req.user.tenantId,
      {
        transactionId: tx.id,
        points,
        reason,
        balanceBefore: balance,
        balanceAfter: balance - points,
      },
    );
    res.status(201).json({ ...tx, balanceAfter: balance - points });
  } catch (e) {
    console.error("[wellness] loyalty redeem error:", e.message);
    res.status(500).json({ error: "Failed to redeem loyalty" });
  }
});

router.get("/referrals", requireManagerPlus, async (req, res) => {
  try {
    const { status, limit = 100, offset = 0 } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;
    const [referrals, total] = await Promise.all([
      prisma.referral.findMany({
        where,
        take: Math.min(parseInt(limit, 10) || 100, 500),
        skip: parseInt(offset, 10) || 0,
        orderBy: { createdAt: "desc" },
        include: {
          referrer: { select: { id: true, name: true, phone: true } },
        },
      }),
      prisma.referral.count({ where }),
    ]);
    res.json({ referrals, total });
  } catch (e) {
    console.error("[wellness] list referrals error:", e.message);
    res.status(500).json({ error: "Failed to list referrals" });
  }
});

router.post("/referrals", async (req, res) => {
  try {
    const { referrerPatientId, referredName, referredPhone, referredEmail } =
      req.body;
    if (!referrerPatientId || !referredName || !referredPhone) {
      return res.status(400).json({
        error:
          "referrerPatientId, referredName, and referredPhone are required",
      });
    }
    const referrer = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: parseInt(referrerPatientId, 10) }),
      select: { id: true },
    });
    if (!referrer)
      return res.status(404).json({ error: "Referrer not found in tenant" });

    const referral = await prisma.referral.create({
      data: {
        referrerPatientId: referrer.id,
        referredName,
        referredPhone,
        referredEmail: referredEmail || null,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(referral);
  } catch (e) {
    console.error("[wellness] create referral error:", e.message);
    res.status(500).json({ error: "Failed to create referral" });
  }
});

router.put("/referrals/:id/reward", requireManagerPlus, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rewardPoints = parseInt(req.body.rewardPoints || 100, 10);
    if (Number.isNaN(rewardPoints) || rewardPoints <= 0) {
      return res
        .status(400)
        .json({ error: "rewardPoints must be a positive integer" });
    }
    const referral = await prisma.referral.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!referral) return res.status(404).json({ error: "Referral not found" });
    if (referral.status === "rewarded") {
      return res.status(400).json({ error: "Referral already rewarded" });
    }

    // Atomically reward + ledger entry
    const [updated, tx] = await prisma.$transaction([
      prisma.referral.update({
        where: { id: referral.id },
        data: {
          status: "rewarded",
          rewardPoints,
          rewardedAt: new Date(),
        },
      }),
      prisma.loyaltyTransaction.create({
        data: {
          patientId: referral.referrerPatientId,
          tenantId: req.user.tenantId,
          type: "referral_bonus",
          points: rewardPoints,
          reason: `Referral bonus — ${referral.referredName}`,
        },
      }),
    ]);

    res.json({ referral: updated, transaction: tx });
  } catch (e) {
    console.error("[wellness] reward referral error:", e.message);
    res.status(500).json({ error: "Failed to reward referral" });
  }
});

// Loyalty leaderboard — top patients by points earned this calendar month.
router.get(
  "/loyalty/leaderboard/month",
  requireManagerPlus,
  async (req, res) => {
    try {
      const monthStart = new Date(
        new Date().getFullYear(),
        new Date().getMonth(),
        1,
      );
      const grouped = await prisma.loyaltyTransaction.groupBy({
        by: ["patientId"],
        where: {
          tenantId: req.user.tenantId,
          points: { gt: 0 },
          createdAt: { gte: monthStart },
        },
        _sum: { points: true },
        // #440: ties on _sum points used to leak the underlying row order, which
        // varied between query runs (no stable secondary sort). Anchor ties on
        // patientId asc so the leaderboard is deterministic across refreshes —
        // customers complained about jumping from rank 4 to rank 6 with zero
        // points change. Lower id = earlier-registered patient = stable surrogate.
        orderBy: [{ _sum: { points: "desc" } }, { patientId: "asc" }],
        take: 10,
      });
      const ids = grouped.map((g) => g.patientId);
      const patients = ids.length
        ? await prisma.patient.findMany({
          where: { id: { in: ids }, tenantId: req.user.tenantId },
          select: { id: true, name: true, phone: true },
        })
        : [];
      const byId = Object.fromEntries(patients.map((p) => [p.id, p]));
      res.json(
        grouped.map((g) => ({
          patient: byId[g.patientId] || { id: g.patientId, name: "—" },
          earned: g._sum.points || 0,
        })),
      );
    } catch (e) {
      console.error("[wellness] loyalty leaderboard error:", e.message);
      res.status(500).json({ error: "Failed to load leaderboard" });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────
// Agent B: Waitlist + auto-fill on cancellation
// ─────────────────────────────────────────────────────────────────────

// Helper: when a visit is cancelled, find the first matching waitlist
// entry (same serviceId, status=waiting) for the same tenant, mark it
// "offered" with offeredAt=now, and queue an SMS via SmsMessage. The
// outbound-SMS cron / smsProvider already drains the queue.
async function offerWaitlistSlotForCancelledVisit(visit, tenantId) {
  if (!visit.serviceId) return null; // no service → no waitlist match
  const candidate = await prisma.waitlist.findFirst({
    where: {
      tenantId,
      status: "waiting",
      serviceId: visit.serviceId,
    },
    orderBy: { createdAt: "asc" }, // FIFO
    include: {
      patient: { select: { id: true, name: true, phone: true } },
    },
  });
  if (!candidate) return null;

  const service = await prisma.service.findUnique({
    where: { id: visit.serviceId },
    select: { name: true },
  });
  const serviceName = service?.name || "your appointment";
  const patientName = candidate.patient?.name || "there";
  const phone = candidate.patient?.phone || "";

  const offerExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h hold

  await prisma.waitlist.update({
    where: { id: candidate.id },
    data: { status: "offered", offeredAt: new Date(), expiresAt: offerExpires },
  });

  if (phone) {
    await prisma.smsMessage.create({
      data: {
        to: phone,
        body: `Hi ${patientName}, a slot just opened for ${serviceName}. Reply YES to book.`,
        direction: "OUTBOUND",
        status: "QUEUED",
        tenantId,
      },
    });
  }

  return candidate.id;
}

// GET /waitlist?status=waiting
router.get("/waitlist", async (req, res) => {
  try {
    const where = tenantWhere(req);
    if (req.query.status) where.status = String(req.query.status);
    const items = await prisma.waitlist.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        patient: { select: { id: true, name: true, phone: true } },
      },
      take: 200,
    });
    res.json(items);
  } catch (e) {
    console.error("[wellness] list waitlist error:", e.message);
    res.status(500).json({ error: "Failed to list waitlist" });
  }
});

// POST /waitlist  body: {patientId, serviceId?, locationId?, preferredDateRange?, notes?}
router.post("/waitlist", async (req, res) => {
  try {
    const { patientId, serviceId, locationId, preferredDateRange, notes } =
      req.body || {};
    if (!patientId)
      return res.status(400).json({ error: "patientId is required" });

    // Verify the patient belongs to this tenant
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: parseInt(patientId) }),
      select: { id: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    const created = await prisma.waitlist.create({
      data: {
        patientId: patient.id,
        serviceId: serviceId ? parseInt(serviceId) : null,
        locationId: locationId ? parseInt(locationId) : null,
        preferredDateRange: preferredDateRange || null,
        notes: notes || null,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error("[wellness] create waitlist error:", e.message);
    res.status(500).json({ error: "Failed to create waitlist entry" });
  }
});

// PUT /waitlist/:id  body: {status?, notes?, preferredDateRange?, expiresAt?, offeredAt?}
router.put("/waitlist/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.waitlist.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!existing)
      return res.status(404).json({ error: "Waitlist entry not found" });

    const data = {};
    const allowed = ["status", "notes", "preferredDateRange"];
    for (const k of allowed)
      if (req.body[k] !== undefined) data[k] = req.body[k];
    // #313: datetime-local form input from the waitlist UI gets routed
    // through the tenant-TZ parser. Full ISO timestamps stay native.
    if (req.body.expiresAt !== undefined) {
      data.expiresAt = req.body.expiresAt
        ? parseTenantDateInput(req.body.expiresAt)
        : null;
    }
    if (req.body.offeredAt !== undefined) {
      data.offeredAt = req.body.offeredAt
        ? parseTenantDateInput(req.body.offeredAt)
        : null;
    }

    // #282: side-effects for the waiting → offered → booked state machine.
    // Previously the row's `status` flipped but neither `offered_at` nor a
    // calendar Visit were written, defeating the entire purpose of the
    // waitlist (cancellation backfill).
    //   • offered: stamp offered_at = now() if not already set, so the UI
    //     can show "Offered 27/4 14:32" instead of "—".
    //   • booked: create a real Visit row (status=booked) tied to the
    //     waitlist entry's patient + service + location, so it materialises
    //     on /wellness/calendar. Picks visitDate from req.body.visitDate
    //     (if the client supplies a slot), else preferredDateRange parsed
    //     as a Date, else now() + 24h as a safe fallback.
    let createdVisit = null;
    const newStatus = data.status;
    if (
      newStatus === "offered" &&
      !existing.offeredAt &&
      data.offeredAt === undefined
    ) {
      data.offeredAt = new Date();
    }
    if (newStatus === "booked") {
      // Belt-and-braces: also stamp offeredAt if it was never set (some
      // clients skip the offered step and go straight to booked).
      if (!existing.offeredAt && data.offeredAt === undefined) {
        data.offeredAt = new Date();
      }
      // Pick a slot for the materialised Visit. Preference order:
      //   1. body.visitDate (client-supplied — explicit slot)
      //   2. body.preferredSlot (alias)
      //   3. existing.preferredDateRange parsed as a Date (best-effort)
      //   4. now() + 24h
      let slot = null;
      const candidate =
        req.body.visitDate ||
        req.body.preferredSlot ||
        existing.preferredDateRange;
      if (candidate) {
        // #313: route datetime-local form input through tenant-TZ parser.
        const parsed = parseTenantDateInput(candidate);
        if (parsed && !Number.isNaN(parsed.getTime())) slot = parsed;
      }
      if (!slot) slot = new Date(Date.now() + 24 * 3600000);

      // Resolve the service price for amountCharged so the calendar tile
      // shows revenue. Falls back to 0 when the waitlist entry isn't tied
      // to a service.
      let amount = 0;
      if (existing.serviceId) {
        const svc = await prisma.service.findFirst({
          where: { id: existing.serviceId, tenantId: req.user.tenantId },
          select: { basePrice: true },
        });
        if (svc?.basePrice != null) amount = svc.basePrice;
      }

      createdVisit = await prisma.visit.create({
        data: {
          visitDate: slot,
          status: "booked",
          notes: existing.notes
            ? `From waitlist #${existing.id}: ${existing.notes}`
            : `From waitlist #${existing.id}`,
          patientId: existing.patientId,
          serviceId: existing.serviceId || null,
          locationId: existing.locationId || null,
          amountCharged: amount,
          tenantId: req.user.tenantId,
        },
      });
    }

    const updated = await prisma.waitlist.update({ where: { id }, data });
    res.json(createdVisit ? { ...updated, visit: createdVisit } : updated);
  } catch (e) {
    console.error("[wellness] update waitlist error:", e.message);
    res.status(500).json({ error: "Failed to update waitlist entry" });
  }
});

// DELETE /waitlist/:id
router.delete("/waitlist/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.waitlist.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!existing)
      return res.status(404).json({ error: "Waitlist entry not found" });
    await prisma.waitlist.delete({ where: { id } });
    res.status(204).end();
  } catch (e) {
    console.error("[wellness] delete waitlist error:", e.message);
    res.status(500).json({ error: "Failed to delete waitlist entry" });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Agent B: Patient-portal real SMS-OTP login
// /portal/login (the legacy mock endpoint above) is left intact for
// backward compat. New flow: request-otp → verify-otp.
// Both endpoints DO NOT leak whether a phone exists (always return
// {ok:true} on request-otp). They are public (under /wellness/portal,
// already on server.js openPaths allowlist).
// ─────────────────────────────────────────────────────────────────────

// #295: hard rate limits on /portal/login/request-otp. Without these any
// caller could fan out 20+ OTP requests in parallel, costing SMS credits
// and (worse) flooding a real patient's phone if used for harassment.
// Two stacked limiters: phone-level (3 / 10 min per last-10-digit phone)
// and IP-level (10 / 10 min per source IP). Both must pass.
// In NODE_ENV=test the local-stack + CI gates fan out many requests from a
// single IP / phone (the auth-security spec stamps multiple rate-limit-header
// assertions). Bump the ceilings so the test budget never bumps into them.
// Production stays at the security-tuned numbers.
const _otpPhoneMax = process.env.NODE_ENV === "test" ? 1000 : 3;
const _otpIpMax = process.env.NODE_ENV === "test" ? 5000 : 10;
const portalRequestOtpPhoneLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: _otpPhoneMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const raw = String(req.body?.phone || "").replace(/\D/g, "");
    const last10 = raw.slice(-10);
    // Fall back to IP when phone missing/invalid so we don't share a single
    // empty bucket across callers (which would let one bad actor lock the
    // route for everyone). Use ipKeyGenerator for IPv6 safety.
    return last10.length === 10 ? `phone:${last10}` : ipKeyGenerator(req, res);
  },
  message: {
    error: "Too many OTP requests for this number. Try again in 10 minutes.",
  },
});

const portalRequestOtpIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: _otpIpMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKeyGenerator(req, res),
  message: {
    error: "Too many OTP requests from this network. Try again later.",
  },
});

router.post(
  "/portal/login/request-otp",
  portalRequestOtpIpLimiter,
  portalRequestOtpPhoneLimiter,
  async (req, res) => {
    try {
      const { phone } = req.body || {};
      if (!phone) return res.status(400).json({ error: "phone is required" });

      const digits = String(phone).replace(/\D/g, "");
      if (digits.length < 10) {
        return res.status(400).json({ error: "Invalid phone" });
      }
      const last10 = digits.slice(-10);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      // Patient lookup is tenant-agnostic (visitor has no tenant context).
      const candidates = await prisma.patient.findMany({
        where: { phone: { contains: last10 } },
        select: { id: true, name: true, phone: true, tenantId: true },
        take: 5,
      });
      const patient = candidates.find((p) => {
        const d = String(p.phone || "").replace(/\D/g, "");
        return d.slice(-10) === last10;
      });

      let _generatedOtp = null;
      if (patient) {
        const otp = String(Math.floor(1000 + Math.random() * 9000)); // 4-digit
        _generatedOtp = otp;
        await prisma.patientOtp.create({
          data: {
            phone: last10,
            otp,
            expiresAt,
            tenantId: patient.tenantId,
          },
        });
        // Queue an outbound SMS via SmsMessage table (drained by smsProvider).
        await prisma.smsMessage.create({
          data: {
            to: patient.phone || last10,
            body: `Your verification code is ${otp}. Valid for 10 minutes.`,
            direction: "OUTBOUND",
            status: "QUEUED",
            tenantId: patient.tenantId,
          },
        });
      }

      // #300 [P0]: NEVER return the OTP in the response body. The previous gate
      // (NODE_ENV !== 'production') leaked the OTP on the public demo server,
      // enabling unauthenticated account takeover for any patient phone. The
      // OTP is delivered out-of-band via SMS only. E2E tests that need to read
      // the OTP must read it from the PatientOtp DB table directly (no env-var
      // bypass — easier to forget than to disable). Always return ok:true so
      // we don't leak whether the phone is registered.
      res.json({ ok: true, expiresAt });
    } catch (e) {
      console.error("[wellness] portal request-otp error:", e.message);
      res.status(500).json({ error: "Failed to request OTP" });
    }
  },
);

router.post("/portal/login/verify-otp", async (req, res) => {
  try {
    const { phone, otp } = req.body || {};
    if (!phone || !otp)
      return res.status(400).json({ error: "phone and otp are required" });
    if (!/^\d{4}$/.test(String(otp))) {
      return res.status(400).json({ error: "OTP must be 4 digits" });
    }
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length < 10)
      return res.status(400).json({ error: "Invalid phone" });
    const last10 = digits.slice(-10);

    // #238 demo bypass: when WELLNESS_DEMO_OTP is set in env (e.g. "1234"),
    // accept it as a valid OTP without checking the PatientOtp table. Still
    // requires a real seeded patient to exist for the phone — this is for
    // the demo / QA flow, not an auth weakening for unknown phones.
    //
    // #292 hardening: the bypass was previously accepted for ANY existing
    // patient phone, which meant attackers could log in as any real patient
    // (e.g. Kavita Reddy 9811891334) using `1234`. Tighten the gate:
    //   1. Only honor the bypass outside production (NODE_ENV !== 'production').
    //      Production opt-in still possible via WELLNESS_DEMO_OTP_ALLOW_PROD=1.
    //   2. Restrict to an explicit phone whitelist (last-10-digit match).
    //      Default whitelist is the seeded demo patient (+919876500001 →
    //      "9876500001"). Override via WELLNESS_DEMO_OTP_PHONES (comma-sep,
    //      digits only — last 10 used).
    const demoOtp = process.env.WELLNESS_DEMO_OTP;
    const demoOtpAllowedInProd =
      process.env.WELLNESS_DEMO_OTP_ALLOW_PROD === "1";
    const demoOtpEnvOk =
      process.env.NODE_ENV !== "production" || demoOtpAllowedInProd;
    const demoOtpPhones = (process.env.WELLNESS_DEMO_OTP_PHONES || "9876500001")
      .split(",")
      .map((p) => String(p).replace(/\D/g, "").slice(-10))
      .filter((p) => p.length === 10);
    const isDemoBypass =
      Boolean(demoOtp) &&
      demoOtpEnvOk &&
      String(otp) === String(demoOtp) &&
      demoOtpPhones.includes(last10);

    let record = null;
    if (!isDemoBypass) {
      record = await prisma.patientOtp.findFirst({
        where: {
          phone: last10,
          otp: String(otp),
          used: false,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });
      if (!record) {
        return res.status(401).json({ error: "Invalid or expired code" });
      }
    }

    // Resolve the patient by last-10-digit phone (tenant-agnostic).
    const candidates = await prisma.patient.findMany({
      where: { phone: { contains: last10 } },
      select: { id: true, name: true, phone: true, tenantId: true },
      take: 5,
    });
    const patient = candidates.find((p) => {
      const d = String(p.phone || "").replace(/\D/g, "");
      return d.slice(-10) === last10;
    });
    if (!patient) {
      return res.status(401).json({ error: "Invalid or expired code" });
    }

    // Mark OTP used (single-use). Skip for demo bypass — no record exists.
    if (record) {
      await prisma.patientOtp.update({
        where: { id: record.id },
        data: { used: true },
      });
    }

    const token = jwt.sign(
      { patientId: patient.id, phoneLast10: last10 },
      PORTAL_JWT_SECRET,
      { expiresIn: "30d" },
    );
    res.json({
      token,
      patient: { id: patient.id, name: patient.name },
    });
  } catch (e) {
    console.error("[wellness] portal verify-otp error:", e.message);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Wave 11 Agent FF — Wallet + GiftCard + Coupon + Cashback ledger system.
//
// Surface map: see commit body. All routes tenant-scoped via tenantWhere.
// Sign convention on WalletTransaction.amount: credits positive, debits
// negative (mirrors QuickBooks). All ledger writes go through Prisma
// $transaction so balance + ledger row stay in lock-step.
// ─────────────────────────────────────────────────────────────────────
const {
  generateGiftCode,
  hashGiftCode,
  verifyGiftCode,
  maskGiftCode,
  lastFour,
  computeCouponDiscount,
  computeCashbackEarn,
} = require("../lib/walletCodes");

async function writeWalletTransaction({
  tenantId,
  walletId,
  type,
  absAmount,
  performedBy,
  reason,
  visitId = null,
  invoiceId = null,
  giftCardId = null,
  couponId = null,
}) {
  const isCredit = String(type || "").startsWith("CREDIT_");
  const isDebit = String(type || "").startsWith("DEBIT_");
  if (!isCredit && !isDebit) {
    throw new Error(`Invalid wallet transaction type: ${type}`);
  }
  const signed = isCredit ? Math.abs(absAmount) : -Math.abs(absAmount);
  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findFirst({
      where: { id: walletId, tenantId },
    });
    if (!wallet) throw new Error("WALLET_NOT_FOUND");
    const newBalance = +(wallet.balance + signed).toFixed(2);
    if (newBalance < 0) {
      const e = new Error("INSUFFICIENT_BALANCE");
      e.code = "INSUFFICIENT_BALANCE";
      throw e;
    }
    await tx.wallet.update({
      where: { id: walletId },
      data: { balance: newBalance },
    });
    return tx.walletTransaction.create({
      data: {
        tenantId,
        walletId,
        type,
        amount: signed,
        reason: reason || null,
        visitId,
        invoiceId,
        giftCardId,
        couponId,
        balanceAfter: newBalance,
        performedBy,
      },
    });
  });
}

async function getOrCreateWallet(req, patientId) {
  let wallet = await prisma.wallet.findFirst({
    where: { tenantId: req.user.tenantId, patientId },
  });
  if (wallet) return wallet;
  const tenant = await prisma.tenant.findUnique({
    where: { id: req.user.tenantId },
    select: { defaultCurrency: true },
  });
  return prisma.wallet.create({
    data: {
      tenantId: req.user.tenantId,
      patientId,
      currency: tenant?.defaultCurrency || "INR",
    },
  });
}

router.get("/patients/:id/wallet", phiReadGate, async (req, res) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
      select: { id: true, name: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    const wallet = await getOrCreateWallet(req, patientId);
    const transactions = await prisma.walletTransaction.findMany({
      where: { tenantId: req.user.tenantId, walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ patient, wallet, transactions });
  } catch (e) {
    console.error("[wellness] wallet get error:", e.message);
    res.status(500).json({ error: "Failed to load wallet" });
  }
});

router.post(
  "/wallet/:walletId/credit",
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const walletId = parseInt(req.params.walletId, 10);
      const amount = Number(req.body.amount);
      const reason = req.body.reason || "Manual credit";
      if (!Number.isFinite(amount) || amount <= 0) {
        return res
          .status(400)
          .json({ error: "amount must be a positive number" });
      }
      const wallet = await prisma.wallet.findFirst({
        where: { id: walletId, tenantId: req.user.tenantId },
      });
      if (!wallet) return res.status(404).json({ error: "Wallet not found" });
      const tx = await writeWalletTransaction({
        tenantId: req.user.tenantId,
        walletId,
        type: "CREDIT_REFUND",
        absAmount: amount,
        performedBy: req.user.userId,
        reason,
      });
      await writeAudit(
        "Wallet",
        "CREDIT",
        walletId,
        req.user.userId,
        req.user.tenantId,
        {
          transactionId: tx.id,
          amount,
          reason,
        },
      );
      // PRD Gap §13 wave-6a — emit wallet.topup so workflow rules can react to
      // every credit (manual, refund, gift-card redemption, cashback). Wrapped
      // so workflow failures never break the ledger response.
      try {
        require("../lib/eventBus").emitEvent(
          "wallet.topup",
          {
            walletId,
            patientId: wallet.patientId,
            transactionId: tx.id,
            amount,
            balanceAfter: tx.balanceAfter,
            type: tx.type,
            reason,
          },
          req.user.tenantId,
          req.io,
        );
      } catch (_e) { }
      res.status(201).json(tx);
    } catch (e) {
      console.error("[wellness] wallet credit error:", e.message);
      res.status(500).json({ error: "Failed to credit wallet" });
    }
  },
);

router.post(
  "/wallet/:walletId/debit",
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const walletId = parseInt(req.params.walletId, 10);
      const amount = Number(req.body.amount);
      const reason = req.body.reason || "Manual debit";
      if (!Number.isFinite(amount) || amount <= 0) {
        return res
          .status(400)
          .json({ error: "amount must be a positive number" });
      }
      const wallet = await prisma.wallet.findFirst({
        where: { id: walletId, tenantId: req.user.tenantId },
      });
      if (!wallet) return res.status(404).json({ error: "Wallet not found" });
      let tx;
      try {
        tx = await writeWalletTransaction({
          tenantId: req.user.tenantId,
          walletId,
          type: "DEBIT_REVERSAL",
          absAmount: amount,
          performedBy: req.user.userId,
          reason,
        });
      } catch (err) {
        if (err.code === "INSUFFICIENT_BALANCE") {
          return res.status(409).json({
            error: "Wallet has insufficient balance",
            code: "INSUFFICIENT_BALANCE",
          });
        }
        throw err;
      }
      await writeAudit(
        "Wallet",
        "DEBIT",
        walletId,
        req.user.userId,
        req.user.tenantId,
        {
          transactionId: tx.id,
          amount,
          reason,
        },
      );
      // PRD Gap §13 wave-6a — emit wallet.spent so workflow rules can react to
      // every debit (redemption, reversal, manual debit). Mirrors wallet.topup.
      try {
        require("../lib/eventBus").emitEvent(
          "wallet.spent",
          {
            walletId,
            patientId: wallet.patientId,
            transactionId: tx.id,
            amount,
            balanceAfter: tx.balanceAfter,
            type: tx.type,
            reason,
          },
          req.user.tenantId,
          req.io,
        );
      } catch (_e) { }
      res.status(201).json(tx);
    } catch (e) {
      console.error("[wellness] wallet debit error:", e.message);
      res.status(500).json({ error: "Failed to debit wallet" });
    }
  },
);

// Wave-B Agent 3 (#653) — GET list never returns the bcrypt hash or any
// redeemable secret. The `code` column now stores a masked display value
// ("ABCD****WXYZ"); we additionally select `codeLast4` for UI display
// ("ending in WXYZ") and explicitly omit `codeHash`.
router.get("/giftcards", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const { status, limit = 100, offset = 0 } = req.query;
    const where = tenantWhere(req);
    if (status) where.status = String(status);
    const [giftCards, total] = await Promise.all([
      prisma.giftCard.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Math.min(parseInt(limit, 10) || 100, 500),
        skip: parseInt(offset, 10) || 0,
        select: {
          id: true,
          tenantId: true,
          code: true,
          codeLast4: true,
          amount: true,
          currency: true,
          status: true,
          expiresAt: true,
          issuedTo: true,
          issuedFrom: true,
          redeemedAt: true,
          redeemedBy: true,
          createdAt: true,
          updatedAt: true,
          // codeHash deliberately omitted — never leaks via list.
        },
      }),
      prisma.giftCard.count({ where }),
    ]);
    res.json({ giftCards, total });
  } catch (e) {
    console.error("[wellness] giftcards list error:", e.message);
    res.status(500).json({ error: "Failed to list gift cards" });
  }
});

// Wave-B Agent 3 (#653) — POST returns plaintext as `code` + `oneTimeCode`
// in the response (one-time disclosure). The DB stores `codeHash` (bcrypt)
// + a masked `code` ("ABCD****WXYZ") + `codeLast4`. Subsequent reads of
// the row will NEVER return the redeemable plaintext again — operators
// who lose it must reissue.
router.post(
  "/giftcards",
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const amount = Number(req.body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res
          .status(400)
          .json({ error: "amount must be a positive number" });
      }
      // v3.7.17 — optional template-style fields. All nullable, all
      // tolerant of missing values to keep the legacy /giftcards POST
      // contract working for existing callers (wallet-giftcard spec,
      // PointOfSale issue flow). validityDays takes precedence over
      // an explicit expiresAt — if both are sent we honor expiresAt.
      const name =
        typeof req.body.name === "string" && req.body.name.trim()
          ? req.body.name.trim()
          : null;
      let price = null;
      if (req.body.price != null && req.body.price !== "") {
        const p = Number(req.body.price);
        if (!Number.isFinite(p) || p < 0) {
          return res
            .status(400)
            .json({ error: "price must be a non-negative number" });
        }
        price = p;
      }
      let validityDays = null;
      if (req.body.validityDays != null && req.body.validityDays !== "") {
        const v = parseInt(req.body.validityDays, 10);
        if (!Number.isInteger(v) || v <= 0 || v > 3650) {
          return res
            .status(400)
            .json({
              error: "validityDays must be an integer between 1 and 3650",
            });
        }
        validityDays = v;
      }
      const color =
        typeof req.body.color === "string" &&
          /^#[0-9a-fA-F]{3,8}$/.test(req.body.color.trim())
          ? req.body.color.trim()
          : null;

      let expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
      if (expiresAt && Number.isNaN(expiresAt.getTime())) {
        return res
          .status(400)
          .json({ error: "expiresAt must be a valid date" });
      }
      // Derive expiresAt from validityDays when the caller didn't send
      // an explicit one. The expiresAt column stays authoritative; the
      // validityDays metadata persists alongside so the UI can re-show
      // "Validity: 3 months" when editing.
      if (!expiresAt && validityDays) {
        expiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000);
      }
      if (expiresAt && expiresAt.getTime() < Date.now()) {
        return res
          .status(400)
          .json({ error: "expiresAt must be in the future" });
      }
      const issuedTo = req.body.issuedTo
        ? parseInt(req.body.issuedTo, 10)
        : null;
      if (issuedTo) {
        const recipient = await prisma.patient.findFirst({
          where: tenantWhere(req, { id: issuedTo }),
          select: { id: true },
        });
        if (!recipient)
          return res.status(404).json({ error: "Recipient patient not found" });
      }
      let row = null;
      let plaintext = null;
      for (let i = 0; i < 3 && !row; i++) {
        const candidate = generateGiftCode(16);
        const maskedCode = maskGiftCode(candidate);
        const codeHash = await hashGiftCode(candidate);
        const codeLast4 = lastFour(candidate);
        try {
          row = await prisma.giftCard.create({
            data: {
              tenantId: req.user.tenantId,
              code: maskedCode, // non-secret masked display value
              codeHash, // bcrypt at rest
              codeLast4, // last-4 for UI + lookup narrowing
              amount,
              name,
              price,
              validityDays,
              color,
              currency: req.body.currency || "INR",
              expiresAt,
              issuedTo,
              issuedFrom: req.user.userId,
            },
          });
          plaintext = candidate;
        } catch (err) {
          if (err.code !== "P2002") throw err;
        }
      }
      if (!row || !plaintext) {
        return res
          .status(500)
          .json({ error: "Failed to allocate gift-card code" });
      }
      // Audit row stores ONLY the masked code + last-4 — never the
      // plaintext, so a leaked audit log cannot redeem.
      await writeAudit(
        "GiftCard",
        "CREATE",
        row.id,
        req.user.userId,
        req.user.tenantId,
        {
          code: row.code,
          codeLast4: row.codeLast4,
          amount,
          issuedTo,
        },
      );
      // PRD Gap §13 wave-6a — emit giftcard.issued so workflow rules can react
      // (e.g. send WhatsApp ack to issuedTo, log against an attribution campaign).
      // The event carries the plaintext so workflow rules (SMS/WhatsApp to the
      // recipient) can transmit the redeemable secret. Subscribers must treat
      // it with the same care as a password.
      try {
        require("../lib/eventBus").emitEvent(
          "giftcard.issued",
          {
            giftCardId: row.id,
            code: plaintext,
            codeLast4: row.codeLast4,
            amount: row.amount,
            currency: row.currency,
            issuedTo: row.issuedTo,
            issuedFrom: row.issuedFrom,
            expiresAt: row.expiresAt,
          },
          req.user.tenantId,
          req.io,
        );
      } catch (_e) { }
      // Return the plaintext ONCE in the response as `code` (back-compat with
      // 48 existing spec assertions) + `oneTimeCode` (explicit alias making
      // the disclosure semantics obvious to API consumers).
      const { codeHash: _drop, ...rowOut } = row;
      res.status(201).json({
        ...rowOut,
        code: plaintext,
        oneTimeCode: plaintext,
      });
    } catch (e) {
      console.error("[wellness] giftcard create error:", e.message);
      res.status(500).json({ error: "Failed to issue gift card" });
    }
  },
);

// v3.7.17 — PATCH /giftcards/:id for admin-driven status transitions.
//
// Allowed flips:
//   active     ⇄ cancelled
//
// Disallowed:
//   * Flipping TO or FROM `redeemed` (that's a redeemer-driven terminal
//     state — only POST /giftcards/redeem can set it).
//   * Flipping TO `expired` (computed from expiresAt; an admin who
//     wants to retire a card uses `cancelled`).
//
// Audited like every other GiftCard mutation so a tamper trail exists.
router.patch(
  "/giftcards/:id",
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid gift card id" });
      }
      const nextStatus = String(req.body.status || "").toLowerCase();
      if (nextStatus !== "active" && nextStatus !== "cancelled") {
        return res.status(400).json({
          error: "status must be one of: active, cancelled",
          code: "STATUS_INVALID",
        });
      }
      const existing = await prisma.giftCard.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Gift card not found" });
      // Redeemed cards are terminal — admins can't reactivate them.
      if (existing.status === "redeemed") {
        return res.status(409).json({
          error: "Redeemed gift cards cannot change status",
          code: "STATUS_TERMINAL",
        });
      }
      // No-op when the requested status matches the current one.
      if (existing.status === nextStatus) {
        return res.json(existing);
      }
      const updated = await prisma.giftCard.update({
        where: { id },
        data: { status: nextStatus },
      });
      await writeAudit(
        "GiftCard",
        nextStatus === "cancelled" ? "CANCEL" : "REACTIVATE",
        id,
        req.user.userId,
        req.user.tenantId,
        {
          from: existing.status,
          to: nextStatus,
          codeLast4: existing.codeLast4,
        },
      );
      res.json(updated);
    } catch (e) {
      console.error("[wellness] giftcard patch error:", e.message);
      res.status(500).json({ error: "Failed to update gift card status" });
    }
  },
);

// Wave-B Agent 3 (#653) — Lookup now hashes the incoming code via
// bcrypt.compare against candidate rows narrowed by codeLast4. We never
// plaintext-match against the (masked) `code` column. The 404 path is
// indistinguishable from "wrong code" by design — the route returns the
// same GIFTCARD_NOT_FOUND code whether the row is absent or the hash
// mismatched, so an attacker can't enumerate which last-4 are in use.
router.post("/giftcards/redeem", phiReadGate, async (req, res) => {
  try {
    const plaintext = String(req.body.code || "")
      .trim()
      .toUpperCase();
    const patientId = parseInt(req.body.patientId, 10);
    if (!plaintext)
      return res
        .status(400)
        .json({ error: "code is required", code: "CODE_REQUIRED" });
    if (!Number.isFinite(patientId) || patientId < 1) {
      return res.status(400).json({ error: "patientId is required" });
    }
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: patientId }),
      select: { id: true, name: true },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });

    // Narrow candidate set: only cards in this tenant with matching last-4
    // are considered. With 30^4 = 810,000 possible last-4 values, this is
    // effectively a single row in practice. We then bcrypt.compare to confirm.
    const last4 = lastFour(plaintext);
    const candidates = await prisma.giftCard.findMany({
      where: { tenantId: req.user.tenantId, codeLast4: last4 },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    let giftCard = null;
    for (const row of candidates) {
      if (!row.codeHash) continue;
      if (await verifyGiftCode(plaintext, row.codeHash)) {
        giftCard = row;
        break;
      }
    }
    if (!giftCard) {
      return res
        .status(404)
        .json({ error: "Gift card not found", code: "GIFTCARD_NOT_FOUND" });
    }
    if (giftCard.status === "redeemed") {
      return res.status(409).json({
        error: "Gift card already redeemed",
        code: "GIFTCARD_ALREADY_REDEEMED",
      });
    }
    if (giftCard.status !== "active") {
      return res.status(409).json({
        error: `Gift card status is ${giftCard.status}`,
        code: "GIFTCARD_INACTIVE",
      });
    }
    if (giftCard.expiresAt && giftCard.expiresAt.getTime() < Date.now()) {
      await prisma.giftCard.update({
        where: { id: giftCard.id },
        data: { status: "expired" },
      });
      return res
        .status(410)
        .json({ error: "Gift card has expired", code: "GIFTCARD_EXPIRED" });
    }
    const wallet = await getOrCreateWallet(req, patientId);
    let tx;
    try {
      tx = await writeWalletTransaction({
        tenantId: req.user.tenantId,
        walletId: wallet.id,
        type: "CREDIT_GIFTCARD",
        absAmount: giftCard.amount,
        performedBy: req.user.userId,
        // Reason uses the MASKED code (giftCard.code) — never the plaintext —
        // so the ledger row + audit trail does not leak the redeemable secret.
        reason: `Gift card ${giftCard.code} redeemed`,
        giftCardId: giftCard.id,
      });
    } catch (err) {
      console.error("[wellness] giftcard redeem write tx error:", err.message);
      return res.status(500).json({ error: "Failed to credit wallet" });
    }
    const updated = await prisma.giftCard.update({
      where: { id: giftCard.id },
      data: {
        status: "redeemed",
        redeemedAt: new Date(),
        redeemedBy: patientId,
      },
      select: {
        id: true,
        tenantId: true,
        code: true,
        codeLast4: true,
        amount: true,
        currency: true,
        status: true,
        expiresAt: true,
        issuedTo: true,
        issuedFrom: true,
        redeemedAt: true,
        redeemedBy: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    await writeAudit(
      "GiftCard",
      "REDEEM",
      giftCard.id,
      req.user.userId,
      req.user.tenantId,
      {
        // Audit stores masked code + last-4 only.
        code: giftCard.code,
        codeLast4: giftCard.codeLast4,
        amount: giftCard.amount,
        patientId,
        transactionId: tx.id,
      },
    );
    // PRD Gap §13 wave-6a — emit giftcard.redeemed so workflow rules can
    // react (top-up confirmation SMS, refer-a-friend bonus on redemption).
    try {
      require("../lib/eventBus").emitEvent(
        "giftcard.redeemed",
        // Event carries masked code only; plaintext is no longer needed
        // post-redemption (status flips to "redeemed").
        {
          giftCardId: giftCard.id,
          code: giftCard.code,
          codeLast4: giftCard.codeLast4,
          amount: giftCard.amount,
          patientId,
          transactionId: tx.id,
          walletId: wallet.id,
        },
        req.user.tenantId,
        req.io,
      );
    } catch (_e) { }
    res.status(201).json({ giftCard: updated, transaction: tx });
  } catch (e) {
    console.error("[wellness] giftcard redeem error:", e.message);
    res.status(500).json({ error: "Failed to redeem gift card" });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Gift-card STOREFRONT — customer-facing purchase flow.
//
//   GET  /giftcards/storefront                  — list buyable gift cards
//   POST /giftcards/:id/purchase/order          — create Razorpay order
//   POST /giftcards/:id/purchase/confirm        — verify + credit wallet
//
// Visibility model: any authenticated user in the tenant can browse +
// buy. The admin-curated catalogue lives in the existing /giftcards
// admin page (status="active", no issuedTo, no redeemedAt) — those rows
// double as storefront inventory. Code / codeHash are NEVER returned
// from these endpoints; the buyer doesn't need the redemption secret
// because the confirm handler credits the wallet directly on payment
// success. Mirrors the /api/payments/create-razorpay-order +
// /confirm-razorpay handshake used by Invoices "Pay Now".
// ─────────────────────────────────────────────────────────────────────

// GET /giftcards/storefront — open to any tenant-authenticated user
// (no wellnessRole gate). Returns active, unissued, unredeemed,
// not-yet-expired gift cards. Display-safe projection only.
router.get("/giftcards/storefront", async (req, res) => {
  try {
    const now = new Date();
    const cards = await prisma.giftCard.findMany({
      where: {
        tenantId: req.user.tenantId,
        status: "active",
        issuedTo: null,
        redeemedAt: null,
        // Only cards with a price are listed in the storefront — a row
        // with price=null is admin-issuance only (sold offline / gifted).
        price: { not: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: {
        id: true,
        name: true,
        amount: true,
        price: true,
        color: true,
        validityDays: true,
        currency: true,
        expiresAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ giftCards: cards });
  } catch (e) {
    console.error("[wellness] giftcard storefront error:", e.message);
    res.status(500).json({ error: "Failed to load storefront" });
  }
});

// Storefront-state guard — single source of truth for "is this card still
// buyable?" Used by both the order + confirm handlers so a card that
// gets reserved / sold between the two calls returns the same 409.
async function loadStorefrontCard(tenantId, id) {
  const card = await prisma.giftCard.findFirst({
    where: { id, tenantId },
  });
  if (!card) {
    const e = new Error("GIFTCARD_NOT_FOUND");
    e.status = 404;
    throw e;
  }
  if (
    card.status !== "active" ||
    card.issuedTo !== null ||
    card.redeemedAt !== null ||
    card.price == null
  ) {
    const e = new Error("GIFTCARD_NOT_AVAILABLE");
    e.status = 409;
    throw e;
  }
  if (card.expiresAt && card.expiresAt <= new Date()) {
    const e = new Error("GIFTCARD_EXPIRED");
    e.status = 409;
    throw e;
  }
  return card;
}

// Resolve (or lazily create) the Patient that represents the signed-in user
// THEMSELVES. Used by the customer storefront's "buy for myself" path so a
// customer doesn't have to search the patient directory to credit their own
// wallet. Mirrors verifyPatientToken's Patient.userId resolve-or-create
// ladder: (1) existing link, (2) claim an unlinked same-email patient,
// (3) create a minimal patient linked by userId. Returns { id, name }.
async function resolveSelfPatient(user) {
  const tenantId = user.tenantId;
  const userId = user.userId;
  let patient = await prisma.patient.findFirst({
    where: { userId, tenantId },
    select: { id: true, name: true },
  });
  if (patient) return patient;

  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  if (!userRow) {
    const e = new Error("User not found");
    e.status = 401;
    throw e;
  }

  // Claim an unlinked patient with the same email so we don't fork a
  // clinical record that staff may have created first.
  if (userRow.email) {
    const claimable = await prisma.patient.findFirst({
      where: { tenantId, email: userRow.email, userId: null },
      select: { id: true, name: true },
    });
    if (claimable) {
      await prisma.patient.update({
        where: { id: claimable.id },
        data: { userId },
      });
      return claimable;
    }
  }

  patient = await prisma.patient.create({
    data: {
      name: userRow.name || userRow.email || "Customer",
      email: userRow.email || null,
      tenantId,
      userId,
      source: "self-register",
    },
    select: { id: true, name: true },
  });
  return patient;
}

// POST /giftcards/:id/purchase/order — body: { patientId? }. Omit patientId
// to buy for YOURSELF (the storefront default — the credit lands on the
// signed-in user's own wallet); supply patientId to GIFT the card to another
// patient. Creates a Razorpay order for the card's `price` (sale price),
// records a Payment
// Razorpay order for the card's `price` (sale price), records a Payment
// row whose metadata.giftCardId + metadata.patientId carry the context
// the confirm handler needs to credit the right wallet.
router.post("/giftcards/:id/purchase/order", async (req, res) => {
  try {
    // Customer payment (customer → tenant) — use the tenant's OWN Razorpay
    // keys (BYOK) so the money settles into the clinic's account, not the
    // platform's. No silent env fallback.
    const {
      getTenantRazorpayClient,
      NOT_CONFIGURED_MESSAGE,
    } = require("../lib/tenantPaymentGateway");
    const rp = await getTenantRazorpayClient(req.user.tenantId);
    if (!rp) {
      return res
        .status(503)
        .json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });
    }
    const razorpay = rp.client;

    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid gift card id" });
    }

    // Recipient resolution. A supplied patientId means "gift this card to
    // that patient" (staff / gift flow). No patientId means "buy for
    // myself" — resolve (or lazily create) the Patient linked to the
    // signed-in user so the wallet credit has a home. This makes the
    // customer storefront default to self without exposing the whole
    // patient directory in a typeahead.
    const rawPatientId = req.body?.patientId;
    const gifting =
      rawPatientId !== undefined &&
      rawPatientId !== null &&
      String(rawPatientId).trim() !== "";
    let patient;
    if (gifting) {
      const patientId = parseInt(rawPatientId, 10);
      if (!Number.isInteger(patientId) || patientId <= 0) {
        return res.status(400).json({ error: "Invalid patientId" });
      }
      patient = await prisma.patient.findFirst({
        where: { id: patientId, tenantId: req.user.tenantId },
        select: { id: true, name: true },
      });
      if (!patient) {
        return res.status(404).json({ error: "Patient not found" });
      }
    } else {
      try {
        patient = await resolveSelfPatient(req.user);
      } catch (err) {
        return res
          .status(err.status || 500)
          .json({ error: err.message || "Failed to resolve your account" });
      }
    }

    let card;
    try {
      card = await loadStorefrontCard(req.user.tenantId, id);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }

    const amountPaise = Math.round(Number(card.price) * 100);
    const currency = String(card.currency || "INR").toUpperCase();

    let order;
    try {
      order = await razorpay.orders.create({
        amount: amountPaise,
        currency,
        receipt: `gc_${card.id}_${Date.now()}`,
        notes: {
          tenantId: String(req.user.tenantId),
          giftCardId: String(card.id),
          patientId: String(patient.id),
          kind: "giftcard_purchase",
        },
      });
    } catch (gatewayErr) {
      console.error(
        "[wellness] razorpay order failed:",
        gatewayErr && gatewayErr.message,
      );
      return res.status(502).json({ error: "Failed to create payment order" });
    }

    const payment = await prisma.payment.create({
      data: {
        invoiceId: null,
        amount: Number(card.price),
        currency,
        gateway: "razorpay",
        gatewayId: order.id,
        status: "PENDING",
        tenantId: req.user.tenantId,
        metadata: JSON.stringify({
          kind: "giftcard_purchase",
          giftCardId: card.id,
          // patientId = recipient whose wallet gets credited. buyerUserId =
          // who actually paid (== recipient for "buy for myself"). Recording
          // the buyer lets the My Transactions history attribute the EXPENSE
          // to the payer even when they gifted the card to someone else.
          patientId: patient.id,
          buyerUserId: req.user.userId,
          orderId: order.id,
          orderStatus: order.status,
        }),
      },
    });

    res.json({
      orderId: order.id,
      paymentId: payment.id,
      key: rp.keyId,
      amount: amountPaise,
      currency,
      giftCardId: card.id,
      patientId: patient.id,
      patientName: patient.name,
    });
  } catch (e) {
    console.error("[wellness] giftcard purchase order error:", e.message);
    res.status(500).json({ error: "Failed to start gift card purchase" });
  }
});

// POST /giftcards/:id/purchase/confirm — body: { paymentId,
// razorpay_order_id, razorpay_payment_id, razorpay_signature }. Verifies
// the HMAC, marks the Payment SUCCESS, marks the gift card redeemed by
// the buyer's patient, credits the wallet, audits, emits.
router.post("/giftcards/:id/purchase/confirm", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "Invalid gift card id" });
    }

    const {
      paymentId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};

    if (
      !paymentId ||
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const {
      getTenantRazorpayCreds,
      NOT_CONFIGURED_MESSAGE,
    } = require("../lib/tenantPaymentGateway");
    const creds = await getTenantRazorpayCreds(req.user.tenantId);
    const secret = creds && creds.keySecret;
    if (!secret) {
      return res
        .status(503)
        .json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });
    }

    const payment = await prisma.payment.findFirst({
      where: { id: parseInt(paymentId, 10), tenantId: req.user.tenantId },
    });
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    // HMAC-SHA256(order_id|payment_id) under the key secret — same
    // contract as /api/payments/confirm-razorpay.
    const expected = require("crypto")
      .createHmac("sha256", secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });
      return res.status(400).json({ error: "Signature verification failed" });
    }

    // Pull giftCardId + patientId from the metadata the order handler
    // stored. Defence-in-depth: the URL :id must match the metadata
    // giftCardId so a confirm call can't redirect the credit to a
    // different card.
    let meta = {};
    try {
      meta = JSON.parse(payment.metadata || "{}");
    } catch (_e) {
      /* malformed metadata is treated as missing */
    }
    if (meta.giftCardId !== id || meta.kind !== "giftcard_purchase") {
      return res
        .status(400)
        .json({ error: "Payment does not match gift card" });
    }
    const patientId = parseInt(meta.patientId, 10);
    if (!Number.isInteger(patientId) || patientId <= 0) {
      return res
        .status(400)
        .json({ error: "Payment is missing patient context" });
    }

    // Re-verify storefront eligibility — guards against a concurrent
    // admin issuance / redemption between order-create and confirm.
    let card;
    try {
      card = await loadStorefrontCard(req.user.tenantId, id);
    } catch (err) {
      // If the card is no longer available, mark the payment FAILED so
      // the buyer can be refunded out-of-band. Razorpay still charged
      // them; an operator follows up via the Payments dashboard.
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });
      return res.status(err.status || 500).json({ error: err.message });
    }

    // Mark Payment SUCCESS first so the row is durable even if the
    // wallet credit fails downstream (operator can hand-credit).
    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "SUCCESS",
        paidAt: new Date(),
        gatewayId: razorpay_payment_id,
        metadata: JSON.stringify({
          ...meta,
          razorpay_order_id,
          razorpay_payment_id,
          verifiedAt: new Date().toISOString(),
        }),
      },
    });

    // Find-or-create the wallet for the buyer's patient, then credit it
    // by the gift card's `amount` (gift value — distinct from `price`
    // which is what they paid). Same writeWalletTransaction helper used
    // by /giftcards/redeem so the ledger shape is identical.
    const wallet = await getOrCreateWallet(req, patientId);
    let tx;
    try {
      tx = await writeWalletTransaction({
        tenantId: req.user.tenantId,
        walletId: wallet.id,
        type: "CREDIT_GIFTCARD",
        absAmount: Number(card.amount),
        performedBy: req.user.userId,
        reason: `Gift card ${card.name || card.code} purchased`,
        giftCardId: card.id,
      });
    } catch (err) {
      console.error("[wellness] giftcard purchase credit error:", err.message);
      return res.status(500).json({ error: "Failed to credit wallet" });
    }

    const updatedCard = await prisma.giftCard.update({
      where: { id: card.id },
      data: {
        status: "redeemed",
        issuedTo: patientId,
        issuedFrom: req.user.userId,
        redeemedAt: new Date(),
        redeemedBy: patientId,
      },
      select: {
        id: true,
        name: true,
        amount: true,
        price: true,
        currency: true,
        status: true,
        issuedTo: true,
        redeemedAt: true,
      },
    });

    await writeAudit(
      "GiftCard",
      "PURCHASE",
      card.id,
      req.user.userId,
      req.user.tenantId,
      {
        paymentId: payment.id,
        patientId,
        amount: card.amount,
        price: card.price,
        razorpay_payment_id,
      },
    );

    // Mirror the /giftcards/redeem emission so workflow rules + the
    // Wallet transaction stream see the same shape regardless of whether
    // the credit came from an admin-issued code or a customer purchase.
    try {
      require("../lib/eventBus").emitEvent(
        "giftcard.redeemed",
        {
          giftCardId: card.id,
          amount: card.amount,
          patientId,
          transactionId: tx.id,
          walletId: wallet.id,
          source: "purchase",
        },
        req.user.tenantId,
        req.io,
      );
    } catch (_e) { }

    res.json({
      success: true,
      giftCard: updatedCard,
      transaction: tx,
      payment: { id: updatedPayment.id, status: updatedPayment.status },
    });
  } catch (e) {
    console.error("[wellness] giftcard purchase confirm error:", e.message);
    res.status(500).json({ error: "Failed to confirm gift card purchase" });
  }
});

// ─────────────────────────────────────────────────────────────────
// Self-service membership purchase — mirrors the gift-card storefront flow
// above. A patient-portal / wellness user browses /wellness/memberships,
// clicks "Buy", goes through the Razorpay handshake, and ends up with an
// active Membership row in their own account (no admin involvement).
//
//   POST /membership-plans/:id/purchase/order   — create Razorpay order
//   POST /membership-plans/:id/purchase/confirm — verify + create Membership
//
// Authenticated against the regular JWT (any tenant user can buy a plan for
// themself). The Patient row is get-or-created from req.user — same pattern
// /appointments/book uses so a user who's never been to the clinic can still
// purchase + immediately apply the membership at booking time.
// ─────────────────────────────────────────────────────────────────

router.post(
  "/membership-plans/:id/purchase/order",
  verifyToken,
  async (req, res) => {
    try {
      // Customer payment (customer → tenant) — use the tenant's OWN Razorpay
      // keys (BYOK); no silent env fallback.
      const {
        getTenantRazorpayClient,
        NOT_CONFIGURED_MESSAGE,
      } = require("../lib/tenantPaymentGateway");
      const rp = await getTenantRazorpayClient(req.user.tenantId);
      if (!rp) {
        return res
          .status(503)
          .json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });
      }
      const razorpay = rp.client;

      const planIdInt = parseInt(req.params.id, 10);
      if (!Number.isFinite(planIdInt) || planIdInt < 1) {
        return res.status(400).json({ error: "Invalid plan id" });
      }

      const plan = await prisma.membershipPlan.findFirst({
        where: { id: planIdInt, tenantId: req.user.tenantId },
      });
      if (!plan) {
        return res.status(404).json({ error: "Membership plan not found" });
      }
      if (/^_teardown_|^_test_/.test(plan.name || "")) {
        return res.status(410).json({
          error: "This plan is a test fixture and cannot be purchased",
          code: "PLAN_ARCHIVED_OR_TEST",
        });
      }
      if (!plan.isActive) {
        return res
          .status(409)
          .json({
            error: "Membership plan is inactive",
            code: "PLAN_INACTIVE",
          });
      }

      // Get-or-create the buyer's patient record (same pattern as
      // /appointments/book). Lets first-time users buy without a prior
      // clinic visit; staff can merge / annotate the row later.
      const { userId, tenantId } = req.user;
      let patient = await prisma.patient.findFirst({
        where: { tenant: { id: tenantId }, user: { id: userId } },
      });
      if (!patient) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        });
        patient = await prisma.patient.create({
          data: {
            name: user?.name || user?.email || "Patient",
            email: user?.email,
            source: "self-purchase",
            tenant: { connect: { id: tenantId } },
            user: { connect: { id: userId } },
          },
        });
      }

      // Reject duplicate purchase while an active membership exists for
      // the same plan. Active = status='active' AND endDate > now. Lazy
      // expiry means we MUST check both fields together — checking
      // status alone would let a user re-buy past expiry (acceptable —
      // they should be able to renew), but also let them double-buy on
      // an unexpired-but-stale row (NOT acceptable). Returns 409 BEFORE
      // touching Razorpay so the user is never charged for the duplicate.
      const existingActive = await prisma.membership.findFirst({
        where: {
          tenantId,
          patientId: patient.id,
          planId: plan.id,
          status: "active",
          endDate: { gt: new Date() },
        },
        select: { id: true, endDate: true },
        orderBy: { endDate: "desc" },
      });
      if (existingActive) {
        return res.status(409).json({
          success: false,
          message: "You already have an active membership for this plan.",
          // Legacy envelope fields kept for back-compat with the
          // generic fetchApi error toast which reads `error` /
          // `code` first. Cross-cutting standing rule prefers
          // additive over breaking.
          error: "You already have an active membership for this plan.",
          code: "MEMBERSHIP_ALREADY_ACTIVE",
          activeMembershipId: existingActive.id,
          activeMembershipEndDate: existingActive.endDate,
        });
      }

      const amountPaise = Math.round(Number(plan.price) * 100);
      const currency = String(plan.currency || "INR").toUpperCase();

      let order;
      try {
        order = await razorpay.orders.create({
          amount: amountPaise,
          currency,
          receipt: `mp_${plan.id}_${Date.now()}`,
          notes: {
            tenantId: String(tenantId),
            planId: String(plan.id),
            patientId: String(patient.id),
            kind: "membership_purchase",
          },
        });
      } catch (gatewayErr) {
        console.error(
          "[wellness] razorpay order failed (membership):",
          gatewayErr && gatewayErr.message,
        );
        return res
          .status(502)
          .json({ error: "Failed to create payment order" });
      }

      const payment = await prisma.payment.create({
        data: {
          invoiceId: null,
          amount: Number(plan.price),
          currency,
          gateway: "razorpay",
          gatewayId: order.id,
          status: "PENDING",
          tenantId,
          metadata: JSON.stringify({
            kind: "membership_purchase",
            planId: plan.id,
            patientId: patient.id,
            orderId: order.id,
            orderStatus: order.status,
          }),
        },
      });

      res.json({
        orderId: order.id,
        paymentId: payment.id,
        key: rp.keyId,
        amount: amountPaise,
        currency,
        planId: plan.id,
        patientId: patient.id,
      });
    } catch (e) {
      console.error("[wellness] membership purchase order error:", e.message);
      res.status(500).json({ error: "Failed to start membership purchase" });
    }
  },
);

// Verifies the Razorpay signature, marks the Payment SUCCESS, and creates
// the Membership row (matching the staff-side /patients/:id/memberships
// purchase semantics — endDate from durationDays, balance stamped from
// plan.entitlements). Defence-in-depth: metadata.planId must match URL :id.
router.post(
  "/membership-plans/:id/purchase/confirm",
  verifyToken,
  async (req, res) => {
    try {
      const planIdInt = parseInt(req.params.id, 10);
      if (!Number.isFinite(planIdInt) || planIdInt < 1) {
        return res.status(400).json({ error: "Invalid plan id" });
      }

      const {
        paymentId,
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      } = req.body || {};

      if (
        !paymentId ||
        !razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature
      ) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const {
        getTenantRazorpayCreds,
        NOT_CONFIGURED_MESSAGE,
      } = require("../lib/tenantPaymentGateway");
      const creds = await getTenantRazorpayCreds(req.user.tenantId);
      const secret = creds && creds.keySecret;
      if (!secret) {
        return res
          .status(503)
          .json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });
      }

      const payment = await prisma.payment.findFirst({
        where: {
          id: parseInt(paymentId, 10),
          tenantId: req.user.tenantId,
        },
      });
      if (!payment) {
        return res.status(404).json({ error: "Payment not found" });
      }

      const expected = require("crypto")
        .createHmac("sha256", secret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest("hex");

      if (expected !== razorpay_signature) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: "FAILED" },
        });
        return res.status(400).json({ error: "Signature verification failed" });
      }

      // Pull plan + patient out of the metadata the order handler stored.
      // The URL :id must match metadata.planId so a confirm call can't
      // redirect the purchase to a different plan.
      let meta = {};
      try {
        meta = JSON.parse(payment.metadata || "{}");
      } catch (_e) {
        /* malformed metadata is treated as missing */
      }
      if (meta.planId !== planIdInt || meta.kind !== "membership_purchase") {
        return res
          .status(400)
          .json({ error: "Payment does not match membership plan" });
      }
      const patientId = parseInt(meta.patientId, 10);
      if (!Number.isInteger(patientId) || patientId <= 0) {
        return res
          .status(400)
          .json({ error: "Payment is missing patient context" });
      }

      // Re-verify plan eligibility (in case an admin deactivated between
      // order-create and confirm — Razorpay still charged the user; we
      // fail the Payment so an operator refunds out-of-band).
      const plan = await prisma.membershipPlan.findFirst({
        where: { id: planIdInt, tenantId: req.user.tenantId },
      });
      if (!plan || !plan.isActive) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: "FAILED" },
        });
        return res
          .status(410)
          .json({ error: "Membership plan is no longer available" });
      }

      // Defence-in-depth duplicate-active check — the /order endpoint
      // gates the same condition, but a race (two concurrent orders
      // created in the same tick, or a /confirm called against a stale
      // order that pre-dated the user's now-active membership) could
      // slip through. Failing the Payment here triggers the same
      // out-of-band refund the deactivated-plan branch above expects.
      const existingActiveConfirm = await prisma.membership.findFirst({
        where: {
          tenantId: req.user.tenantId,
          patientId,
          planId: plan.id,
          status: "active",
          endDate: { gt: new Date() },
        },
        select: { id: true, endDate: true },
        orderBy: { endDate: "desc" },
      });
      if (existingActiveConfirm) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: "FAILED" },
        });
        return res.status(409).json({
          success: false,
          message: "You already have an active membership for this plan.",
          error: "You already have an active membership for this plan.",
          code: "MEMBERSHIP_ALREADY_ACTIVE",
          activeMembershipId: existingActiveConfirm.id,
          activeMembershipEndDate: existingActiveConfirm.endDate,
        });
      }

      const updatedPayment = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "SUCCESS",
          paidAt: new Date(),
          gatewayId: razorpay_payment_id,
          metadata: JSON.stringify({
            ...meta,
            razorpay_order_id,
            razorpay_payment_id,
            verifiedAt: new Date().toISOString(),
          }),
        },
      });

      // Stamp initial balance from plan.entitlements — same shape the
      // staff-side /patients/:id/memberships POST writes so redemption,
      // expiry-notification, and balance reads work identically.
      let entitlements;
      try {
        entitlements = JSON.parse(plan.entitlements);
      } catch {
        return res.status(500).json({
          error: "Plan entitlements are corrupt",
          code: "PLAN_ENTITLEMENTS_CORRUPT",
        });
      }
      const initialBalance = (
        Array.isArray(entitlements) ? entitlements : []
      ).map((e) => ({ serviceId: e.serviceId, remaining: e.quantity }));

      const start = new Date();
      const end = new Date(start.getTime() + plan.durationDays * 86400000);

      let isRenewal = false;
      try {
        const priorCount = await prisma.membership.count({
          where: {
            tenantId: req.user.tenantId,
            patientId,
            planId: plan.id,
          },
        });
        isRenewal = priorCount > 0;
      } catch (_e) {
        /* best-effort */
      }

      const membership = await prisma.membership.create({
        data: {
          tenantId: req.user.tenantId,
          patientId,
          planId: plan.id,
          startDate: start,
          endDate: end,
          balance: JSON.stringify(initialBalance),
          status: "active",
        },
      });

      try {
        await writeAudit(
          "Membership",
          "PURCHASE",
          membership.id,
          req.user.userId,
          req.user.tenantId,
          {
            patientId,
            planId: plan.id,
            planName: plan.name,
            price: plan.price,
            paymentId: payment.id,
            razorpay_payment_id,
            source: "self-purchase",
          },
        );
      } catch (auditErr) {
        console.warn("[audit]", auditErr.message);
      }

      try {
        require("../lib/eventBus").emitEvent(
          isRenewal ? "membership.renewed" : "membership.enrolled",
          {
            membershipId: membership.id,
            patientId,
            planId: plan.id,
            planName: plan.name,
            price: plan.price,
            startDate: start,
            endDate: end,
            isRenewal,
            source: "self-purchase",
          },
          req.user.tenantId,
          req.io,
        );
      } catch (_e) { }

      res.json({
        success: true,
        membership: {
          id: membership.id,
          planId: plan.id,
          planName: plan.name,
          startDate: start,
          endDate: end,
          status: membership.status,
        },
        payment: { id: updatedPayment.id, status: updatedPayment.status },
      });
    } catch (e) {
      console.error("[wellness] membership purchase confirm error:", e.message);
      res.status(500).json({ error: "Failed to confirm membership purchase" });
    }
  },
);

// Admin-applied gift-card credit. The /giftcards/redeem path above requires
// the plaintext code (recipient flow — SMS/email/printed card → patient
// portal). This route is the parallel operator flow: an ADMIN or MANAGER
// applies a gift card they (or another operator) issued directly to a
// patient's wallet, by row id. No code/hash check — we trust the
// authenticated session, the same way we trust admins to issue cards or
// manually credit wallets via /wallets/:id/credit.
//
// Threat model: the #653 bcrypt-hashing protection is specifically aimed
// at unauthenticated DB-dump attacks (anyone with the SQL dump being able
// to redeem). This endpoint is gated on JWT + role + audit-logged, so it
// doesn't undermine that protection. A compromised admin session could
// apply gift cards, but the same session could already issue arbitrary new
// cards or credit wallets directly — the ceiling doesn't move.
//
// Distinct audit action ("APPLY") + event ("giftcard.applied") so the
// trail clearly distinguishes operator-applied from code-redeemed entries.
router.post(
  "/giftcards/:id/apply",
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const patientId = parseInt(req.body.patientId, 10);
      if (!Number.isFinite(patientId) || patientId < 1) {
        return res
          .status(400)
          .json({ error: "patientId is required", code: "PATIENT_REQUIRED" });
      }
      const patient = await prisma.patient.findFirst({
        where: tenantWhere(req, { id: patientId }),
        select: { id: true, name: true },
      });
      if (!patient)
        return res
          .status(404)
          .json({ error: "Patient not found", code: "PATIENT_NOT_FOUND" });

      const giftCard = await prisma.giftCard.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!giftCard) {
        return res
          .status(404)
          .json({ error: "Gift card not found", code: "GIFTCARD_NOT_FOUND" });
      }
      if (giftCard.status === "redeemed") {
        return res.status(409).json({
          error: "Gift card already redeemed",
          code: "GIFTCARD_ALREADY_REDEEMED",
        });
      }
      if (giftCard.status !== "active") {
        return res.status(409).json({
          error: `Gift card status is ${giftCard.status}`,
          code: "GIFTCARD_INACTIVE",
        });
      }
      if (giftCard.expiresAt && giftCard.expiresAt.getTime() < Date.now()) {
        await prisma.giftCard.update({
          where: { id: giftCard.id },
          data: { status: "expired" },
        });
        return res
          .status(410)
          .json({ error: "Gift card has expired", code: "GIFTCARD_EXPIRED" });
      }

      const wallet = await getOrCreateWallet(req, patientId);
      let tx;
      try {
        tx = await writeWalletTransaction({
          tenantId: req.user.tenantId,
          walletId: wallet.id,
          type: "CREDIT_GIFTCARD",
          absAmount: giftCard.amount,
          performedBy: req.user.userId,
          // Masked code only — never the plaintext (which we don't have anyway).
          reason: `Gift card ${giftCard.code} applied by operator`,
          giftCardId: giftCard.id,
        });
      } catch (err) {
        console.error("[wellness] giftcard apply write tx error:", err.message);
        return res.status(500).json({ error: "Failed to credit wallet" });
      }
      const updated = await prisma.giftCard.update({
        where: { id: giftCard.id },
        data: {
          status: "redeemed",
          redeemedAt: new Date(),
          redeemedBy: patientId,
        },
        select: {
          id: true,
          tenantId: true,
          code: true,
          codeLast4: true,
          amount: true,
          currency: true,
          status: true,
          expiresAt: true,
          issuedTo: true,
          issuedFrom: true,
          redeemedAt: true,
          redeemedBy: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      await writeAudit(
        "GiftCard",
        "APPLY",
        giftCard.id,
        req.user.userId,
        req.user.tenantId,
        {
          code: giftCard.code,
          codeLast4: giftCard.codeLast4,
          amount: giftCard.amount,
          patientId,
          transactionId: tx.id,
          appliedBy: req.user.userId,
        },
      );
      try {
        require("../lib/eventBus").emitEvent(
          "giftcard.applied",
          {
            giftCardId: giftCard.id,
            code: giftCard.code,
            codeLast4: giftCard.codeLast4,
            amount: giftCard.amount,
            patientId,
            transactionId: tx.id,
            walletId: wallet.id,
            appliedBy: req.user.userId,
          },
          req.user.tenantId,
          req.io,
        );
      } catch (_e) { }
      res.status(201).json({ giftCard: updated, transaction: tx });
    } catch (e) {
      console.error("[wellness] giftcard apply error:", e.message);
      res.status(500).json({ error: "Failed to apply gift card" });
    }
  },
);

function validateCouponBody(body) {
  const errors = [];
  if (!body.code || !String(body.code).trim()) errors.push("code is required");
  if (!["PERCENT", "FLAT"].includes(body.discountType)) {
    errors.push("discountType must be PERCENT or FLAT");
  }
  const v = Number(body.discountValue);
  if (!Number.isFinite(v) || v <= 0)
    errors.push("discountValue must be a positive number");
  if (body.discountType === "PERCENT" && v > 100)
    errors.push("PERCENT discountValue must be ≤ 100");
  if (body.maxRedemptions != null) {
    const m = parseInt(body.maxRedemptions, 10);
    if (!Number.isFinite(m) || m < 0)
      errors.push("maxRedemptions must be a non-negative integer");
  }
  return errors;
}

router.get("/coupons", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const where = tenantWhere(req);
    if (req.query.isActive === "true") where.isActive = true;
    if (req.query.isActive === "false") where.isActive = false;
    const coupons = await prisma.coupon.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ coupons });
  } catch (e) {
    console.error("[wellness] coupons list error:", e.message);
    res.status(500).json({ error: "Failed to list coupons" });
  }
});

router.post("/coupons", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const errors = validateCouponBody(req.body);
    if (errors.length)
      return res.status(400).json({ error: errors.join("; ") });
    const code = String(req.body.code).trim().toUpperCase();
    const data = {
      tenantId: req.user.tenantId,
      code,
      discountType: req.body.discountType,
      discountValue: Number(req.body.discountValue),
      maxRedemptions:
        req.body.maxRedemptions != null
          ? parseInt(req.body.maxRedemptions, 10)
          : null,
      validFrom: req.body.validFrom ? new Date(req.body.validFrom) : null,
      validUntil: req.body.validUntil ? new Date(req.body.validUntil) : null,
      serviceIds: req.body.serviceIds
        ? Array.isArray(req.body.serviceIds)
          ? JSON.stringify(
            req.body.serviceIds
              .map((n) => parseInt(n, 10))
              .filter(Number.isFinite),
          )
          : String(req.body.serviceIds)
        : null,
      isActive: req.body.isActive === false ? false : true,
    };
    let row;
    try {
      row = await prisma.coupon.create({ data });
    } catch (err) {
      if (err.code === "P2002") {
        return res.status(409).json({
          error: "Coupon code already exists in this tenant",
          code: "COUPON_DUPLICATE",
        });
      }
      throw err;
    }
    await writeAudit(
      "Coupon",
      "CREATE",
      row.id,
      req.user.userId,
      req.user.tenantId,
      {
        code: row.code,
        discountType: row.discountType,
        discountValue: row.discountValue,
      },
    );
    res.status(201).json(row);
  } catch (e) {
    console.error("[wellness] coupon create error:", e.message);
    res.status(500).json({ error: "Failed to create coupon" });
  }
});

router.put(
  "/coupons/:id",
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.coupon.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing) return res.status(404).json({ error: "Coupon not found" });
      const data = {};
      const allowed = [
        "discountType",
        "discountValue",
        "maxRedemptions",
        "validFrom",
        "validUntil",
        "isActive",
        "serviceIds",
      ];
      for (const k of allowed) {
        if (req.body[k] === undefined) continue;
        if (k === "discountValue") {
          const v = Number(req.body[k]);
          if (!Number.isFinite(v) || v <= 0)
            return res
              .status(400)
              .json({ error: "discountValue must be positive" });
          data[k] = v;
        } else if (k === "discountType") {
          if (!["PERCENT", "FLAT"].includes(req.body[k])) {
            return res
              .status(400)
              .json({ error: "discountType must be PERCENT or FLAT" });
          }
          data[k] = req.body[k];
        } else if (k === "maxRedemptions") {
          data[k] = req.body[k] == null ? null : parseInt(req.body[k], 10);
        } else if (k === "validFrom" || k === "validUntil") {
          data[k] = req.body[k] ? new Date(req.body[k]) : null;
        } else if (k === "isActive") {
          data[k] = !!req.body[k];
        } else if (k === "serviceIds") {
          data[k] = req.body[k]
            ? Array.isArray(req.body[k])
              ? JSON.stringify(
                req.body[k]
                  .map((n) => parseInt(n, 10))
                  .filter(Number.isFinite),
              )
              : String(req.body[k])
            : null;
        }
      }
      const updated = await prisma.coupon.update({ where: { id }, data });
      await writeAudit(
        "Coupon",
        "UPDATE",
        id,
        req.user.userId,
        req.user.tenantId,
        diffFields(existing, updated),
      );
      res.json(updated);
    } catch (e) {
      console.error("[wellness] coupon update error:", e.message);
      res.status(500).json({ error: "Failed to update coupon" });
    }
  },
);

router.delete("/coupons/:id", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await prisma.coupon.findFirst({
      where: tenantWhere(req, { id }),
    });
    if (!existing) return res.status(404).json({ error: "Coupon not found" });
    await prisma.coupon.delete({ where: { id } });
    await writeAudit(
      "Coupon",
      "DELETE",
      id,
      req.user.userId,
      req.user.tenantId,
      { code: existing.code },
    );
    res.status(204).send();
  } catch (e) {
    console.error("[wellness] coupon delete error:", e.message);
    res.status(500).json({ error: "Failed to delete coupon" });
  }
});

// tenantId is passed explicitly so callers without a req.user (anonymous public
// payment flow) can reuse this. Existing auth'd callers pass req.user.tenantId.
async function loadCouponForApply(tenantId, code) {
  const coupon = await prisma.coupon.findFirst({
    where: {
      tenantId,
      code: String(code || "")
        .trim()
        .toUpperCase(),
    },
  });
  if (!coupon)
    return {
      error: {
        status: 404,
        code: "COUPON_NOT_FOUND",
        message: "Coupon not found",
      },
    };
  if (!coupon.isActive)
    return {
      error: {
        status: 409,
        code: "COUPON_INACTIVE",
        message: "Coupon is inactive",
      },
      coupon,
    };
  const now = Date.now();
  if (coupon.validFrom && coupon.validFrom.getTime() > now) {
    return {
      error: {
        status: 409,
        code: "COUPON_NOT_YET_VALID",
        message: "Coupon is not yet valid",
      },
      coupon,
    };
  }
  if (coupon.validUntil && coupon.validUntil.getTime() < now) {
    return {
      error: {
        status: 410,
        code: "COUPON_EXPIRED",
        message: "Coupon has expired",
      },
      coupon,
    };
  }
  if (
    coupon.maxRedemptions != null &&
    coupon.redemptionCount >= coupon.maxRedemptions
  ) {
    return {
      error: {
        status: 409,
        code: "COUPON_LIMIT_REACHED",
        message: "Coupon redemption limit reached",
      },
      coupon,
    };
  }
  return { coupon };
}

router.post("/coupons/preview", async (req, res) => {
  try {
    const { code, baseAmount, serviceId } = req.body || {};
    const base = Number(baseAmount);
    if (!Number.isFinite(base) || base <= 0) {
      return res
        .status(400)
        .json({ error: "baseAmount must be a positive number" });
    }
    const lookup = await loadCouponForApply(req.user.tenantId, code);
    if (lookup.error) {
      return res
        .status(lookup.error.status)
        .json({ error: lookup.error.message, code: lookup.error.code });
    }
    const result = computeCouponDiscount(
      lookup.coupon,
      base,
      serviceId ? parseInt(serviceId, 10) : null,
    );
    res.json({
      code: lookup.coupon.code,
      discountType: lookup.coupon.discountType,
      discountValue: lookup.coupon.discountValue,
      baseAmount: +base.toFixed(2),
      ...result,
    });
  } catch (e) {
    console.error("[wellness] coupon preview error:", e.message);
    res.status(500).json({ error: "Failed to preview coupon" });
  }
});

router.post("/coupons/apply", phiReadGate, async (req, res) => {
  try {
    const { code, baseAmount, invoiceId, serviceId } = req.body || {};
    const base = Number(baseAmount);
    if (!Number.isFinite(base) || base <= 0) {
      return res
        .status(400)
        .json({ error: "baseAmount must be a positive number" });
    }
    const lookup = await loadCouponForApply(req.user.tenantId, code);
    if (lookup.error) {
      return res
        .status(lookup.error.status)
        .json({ error: lookup.error.message, code: lookup.error.code });
    }
    const result = computeCouponDiscount(
      lookup.coupon,
      base,
      serviceId ? parseInt(serviceId, 10) : null,
    );
    if (!result.applied) {
      return res.status(409).json({
        error: "Coupon does not apply to this purchase",
        code: "COUPON_NOT_APPLICABLE",
      });
    }
    const updated = await prisma.coupon.update({
      where: { id: lookup.coupon.id },
      data: { redemptionCount: { increment: 1 } },
    });
    await writeAudit(
      "Coupon",
      "APPLY",
      lookup.coupon.id,
      req.user.userId,
      req.user.tenantId,
      {
        code: lookup.coupon.code,
        baseAmount: +base.toFixed(2),
        discount: result.discount,
        finalAmount: result.finalAmount,
        invoiceId: invoiceId ? parseInt(invoiceId, 10) : null,
        serviceId: serviceId ? parseInt(serviceId, 10) : null,
      },
    );
    res.json({
      code: lookup.coupon.code,
      ...result,
      redemptionCount: updated.redemptionCount,
    });
  } catch (e) {
    console.error("[wellness] coupon apply error:", e.message);
    res.status(500).json({ error: "Failed to apply coupon" });
  }
});

function validateCashbackRuleBody(body) {
  const errors = [];
  if (!body.name || !String(body.name).trim()) errors.push("name is required");
  const v = Number(body.earnPercent);
  if (!Number.isFinite(v) || v < 0)
    errors.push("earnPercent must be a non-negative number");
  if (v > 100) errors.push("earnPercent must be ≤ 100");
  if (body.minSpend != null) {
    const m = Number(body.minSpend);
    if (!Number.isFinite(m) || m < 0)
      errors.push("minSpend must be a non-negative number");
  }
  if (body.expiresAt != null && body.expiresAt !== "") {
    const d = new Date(body.expiresAt);
    if (Number.isNaN(d.getTime()))
      errors.push("expiresAt must be a valid ISO date");
  }
  return errors;
}

router.get(
  "/cashback-rules",
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const where = tenantWhere(req);
      if (req.query.isActive === "true") where.isActive = true;
      if (req.query.isActive === "false") where.isActive = false;
      const rules = await prisma.cashbackRule.findMany({
        where,
        orderBy: { createdAt: "desc" },
      });
      res.json({ rules });
    } catch (e) {
      console.error("[wellness] cashback list error:", e.message);
      res.status(500).json({ error: "Failed to list cashback rules" });
    }
  },
);

router.post(
  "/cashback-rules",
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const errors = validateCashbackRuleBody(req.body);
      if (errors.length)
        return res.status(400).json({ error: errors.join("; ") });
      const data = {
        tenantId: req.user.tenantId,
        name: String(req.body.name).trim(),
        earnPercent: Number(req.body.earnPercent),
        minSpend: req.body.minSpend != null ? Number(req.body.minSpend) : null,
        serviceIds: req.body.serviceIds
          ? Array.isArray(req.body.serviceIds)
            ? JSON.stringify(
              req.body.serviceIds
                .map((n) => parseInt(n, 10))
                .filter(Number.isFinite),
            )
            : String(req.body.serviceIds)
          : null,
        isActive: req.body.isActive === false ? false : true,
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
      };
      const row = await prisma.cashbackRule.create({ data });
      await writeAudit(
        "CashbackRule",
        "CREATE",
        row.id,
        req.user.userId,
        req.user.tenantId,
        {
          name: row.name,
          earnPercent: row.earnPercent,
        },
      );
      res.status(201).json(row);
    } catch (e) {
      console.error("[wellness] cashback create error:", e.message);
      res.status(500).json({ error: "Failed to create cashback rule" });
    }
  },
);

router.put(
  "/cashback-rules/:id",
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.cashbackRule.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Cashback rule not found" });
      const data = {};
      const allowed = [
        "name",
        "earnPercent",
        "minSpend",
        "serviceIds",
        "isActive",
        "expiresAt",
      ];
      for (const k of allowed) {
        if (req.body[k] === undefined) continue;
        if (k === "name") {
          data[k] = String(req.body[k]).trim();
        } else if (k === "earnPercent") {
          const v = Number(req.body[k]);
          if (!Number.isFinite(v) || v < 0 || v > 100) {
            return res
              .status(400)
              .json({ error: "earnPercent must be 0..100" });
          }
          data[k] = v;
        } else if (k === "minSpend") {
          data[k] = req.body[k] == null ? null : Number(req.body[k]);
        } else if (k === "isActive") {
          data[k] = !!req.body[k];
        } else if (k === "serviceIds") {
          data[k] = req.body[k]
            ? Array.isArray(req.body[k])
              ? JSON.stringify(
                req.body[k]
                  .map((n) => parseInt(n, 10))
                  .filter(Number.isFinite),
              )
              : String(req.body[k])
            : null;
        } else if (k === "expiresAt") {
          if (req.body[k] === null || req.body[k] === "") {
            data[k] = null;
          } else {
            const d = new Date(req.body[k]);
            if (Number.isNaN(d.getTime())) {
              return res
                .status(400)
                .json({ error: "expiresAt must be a valid ISO date" });
            }
            data[k] = d;
          }
        }
      }
      const updated = await prisma.cashbackRule.update({ where: { id }, data });
      await writeAudit(
        "CashbackRule",
        "UPDATE",
        id,
        req.user.userId,
        req.user.tenantId,
        diffFields(existing, updated),
      );
      res.json(updated);
    } catch (e) {
      console.error("[wellness] cashback update error:", e.message);
      res.status(500).json({ error: "Failed to update cashback rule" });
    }
  },
);

router.delete(
  "/cashback-rules/:id",
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = await prisma.cashbackRule.findFirst({
        where: tenantWhere(req, { id }),
      });
      if (!existing)
        return res.status(404).json({ error: "Cashback rule not found" });
      await prisma.cashbackRule.delete({ where: { id } });
      await writeAudit(
        "CashbackRule",
        "DELETE",
        id,
        req.user.userId,
        req.user.tenantId,
        { name: existing.name },
      );
      res.status(204).send();
    } catch (e) {
      console.error("[wellness] cashback delete error:", e.message);
      res.status(500).json({ error: "Failed to delete cashback rule" });
    }
  },
);

router.post("/visits/:id/apply-cashback", phiWriteGate, async (req, res) => {
  try {
    const visitId = parseInt(req.params.id, 10);
    const visit = await prisma.visit.findFirst({
      where: tenantWhere(req, { id: visitId }),
      select: {
        id: true,
        patientId: true,
        serviceId: true,
        amountCharged: true,
        status: true,
      },
    });
    if (!visit) return res.status(404).json({ error: "Visit not found" });
    if (visit.status !== "completed") {
      return res.status(409).json({
        error: "Cashback can only be applied to completed visits",
        code: "VISIT_NOT_COMPLETED",
      });
    }
    const existing = await prisma.walletTransaction.findFirst({
      where: { tenantId: req.user.tenantId, visitId, type: "CREDIT_CASHBACK" },
      select: { id: true, amount: true },
    });
    if (existing) {
      return res.status(409).json({
        error: "Cashback already applied for this visit",
        code: "CASHBACK_ALREADY_APPLIED",
        transactionId: existing.id,
      });
    }
    const now = new Date();
    const rules = await prisma.cashbackRule.findMany({
      where: {
        tenantId: req.user.tenantId,
        isActive: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: "asc" },
    });
    const result = computeCashbackEarn(
      rules,
      Number(visit.amountCharged) || 0,
      visit.serviceId,
    );
    if (!result.applied) {
      return res.json({ applied: false, earn: 0, ruleId: null });
    }
    const wallet = await getOrCreateWallet(req, visit.patientId);
    const tx = await writeWalletTransaction({
      tenantId: req.user.tenantId,
      walletId: wallet.id,
      type: "CREDIT_CASHBACK",
      absAmount: result.earn,
      performedBy: req.user.userId,
      reason: `Cashback for Visit #${visitId} (rule ${result.ruleId})`,
      visitId,
    });
    await writeAudit(
      "Patient",
      "CASHBACK_EARN",
      visit.patientId,
      req.user.userId,
      req.user.tenantId,
      {
        visitId,
        ruleId: result.ruleId,
        earn: result.earn,
        transactionId: tx.id,
      },
    );
    // PRD Gap §13 wave-6a — emit cashback.credited so workflow rules can
    // react (cashback-redemption SMS, loyalty-tier upgrades).
    try {
      require("../lib/eventBus").emitEvent(
        "cashback.credited",
        {
          patientId: visit.patientId,
          visitId,
          ruleId: result.ruleId,
          amount: result.earn,
          walletId: wallet.id,
          transactionId: tx.id,
        },
        req.user.tenantId,
        req.io,
      );
    } catch (_e) { }
    res.status(201).json({
      applied: true,
      earn: result.earn,
      ruleId: result.ruleId,
      transaction: tx,
    });
  } catch (e) {
    console.error("[wellness] cashback apply error:", e.message);
    res.status(500).json({ error: "Failed to apply cashback" });
  }
});

// Get doctors availability for patient appointment booking
// Returns minimal doctor info (only id, name, availability status)
// No email or sensitive fields exposed to prevent data leakage to patients
router.get("/doctors/availability", verifyToken, async (req, res) => {
  try {
    const { tenantId } = req.user;
    const dateParam = req.query.date || new Date().toISOString().split("T")[0];
    console.log(`[availability] tenantId=${tenantId} date=${dateParam}`);

    // Strict whitelist: only users with wellnessRole = doctor or
    // professional are bookable. The looser RBAC/specialty/fallback
    // matches previously included generic staff who then 404'd on the
    // time-slots endpoint (which gates on the same whitelist below),
    // leaving the slot dropdown empty.
    let doctors = await prisma.user.findMany({
      where: {
        tenantId,
        deactivatedAt: null,
        wellnessRole: { in: ["doctor", "professional"] },
      },
      select: { id: true, name: true, specialty: true, wellnessRole: true },
      orderBy: { name: "asc" },
    });

    // Fallback for tenants where staff exist but wellnessRole was never
    // backfilled (e.g. created before the field existed or via bulk import).
    // Use distinct doctorIds from Visit records as the bookable-doctor set.
    if (doctors.length === 0) {
      const refs = await prisma.visit.findMany({
        where: { tenantId, doctorId: { not: null } },
        select: { doctorId: true },
        distinct: ["doctorId"],
      });
      const ids = refs.map((r) => r.doctorId).filter(Boolean);
      if (ids.length) {
        // No tenantId filter here — security is guaranteed by the Visit.tenantId
        // scope above. Doctor users may belong to a shared/admin tenant while
        // only serving visits for this tenant.
        doctors = await prisma.user.findMany({
          where: { id: { in: ids }, deactivatedAt: null },
          select: { id: true, name: true, specialty: true, wellnessRole: true },
          orderBy: { name: "asc" },
        });
        console.log(`[availability] fallback via visits found ${doctors.length} doctor(s) from ids`, ids);
      }
    }
    console.log(`[availability] returning ${doctors.length} doctor(s)`);

    // Fetch approved leave requests for all doctors on the specified date
    const targetDate = new Date(dateParam + "T00:00:00Z");
    if (isNaN(targetDate.getTime())) {
      return res
        .status(400)
        .json({ error: "Invalid date format. Use YYYY-MM-DD." });
    }

    const startOfDay = new Date(targetDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const approvedLeaves = await prisma.leaveRequest.findMany({
      where: {
        tenantId,
        status: "APPROVED",
        startDate: { lte: endOfDay },
        endDate: { gte: startOfDay },
      },
      select: {
        userId: true,
      },
    });

    // Also check for block times (breaks, personal time, etc.) that span the entire day
    const blockTimes = await prisma.blockTime.findMany({
      where: {
        tenantId,
        startAt: { lte: endOfDay },
        endAt: { gte: startOfDay },
      },
      select: {
        userId: true,
      },
    });

    const onLeaveIds = new Set(approvedLeaves.map((l) => l.userId));
    const hasBlockTimeIds = new Set(blockTimes.map((b) => b.userId));

    // Return only necessary fields: id, name, specialty, role, availability
    const doctorsList = doctors.map((doctor) => ({
      id: doctor.id,
      name: doctor.name,
      specialty: doctor.specialty || null,
      wellnessRole: doctor.wellnessRole || null,
      available: !onLeaveIds.has(doctor.id) && !hasBlockTimeIds.has(doctor.id),
    }));

    res.json(doctorsList);
  } catch (err) {
    console.error("[wellness] get doctors availability error:", err.message);
    res.status(500).json({ error: "Failed to fetch doctors availability" });
  }
});

// Get available time slots for a doctor on a specific date
// Returns array of 30-min slots between 9 AM - 6 PM that are not already booked
router.get("/doctors/:doctorId/time-slots", verifyToken, async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { tenantId } = req.user;
    const dateParam = req.query.date || new Date().toISOString().split("T")[0];

    // Validate doctor/professional exists and belongs to tenant.
    // Primary: strict wellnessRole whitelist. Fallback: user has at least
    // one visit record as doctorId in this tenant (covers tenants where
    // wellnessRole was never backfilled but doctors exist via admin booking).
    let doctor = await prisma.user.findFirst({
      where: {
        id: parseInt(doctorId),
        tenantId,
        wellnessRole: { in: ["doctor", "professional"] },
        deactivatedAt: null,
      },
      select: { id: true },
    });

    if (!doctor) {
      const hasVisit = await prisma.visit.findFirst({
        where: { tenantId, doctorId: parseInt(doctorId) },
        select: { id: true },
      });
      if (hasVisit) {
        doctor = await prisma.user.findFirst({
          where: { id: parseInt(doctorId), deactivatedAt: null },
          select: { id: true },
        });
      }
    }

    if (!doctor) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    // Check if doctor is on leave
    const targetDate = new Date(dateParam + "T00:00:00Z");
    const startOfDay = new Date(targetDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const leaveReq = await prisma.leaveRequest.findFirst({
      where: {
        tenantId,
        userId: parseInt(doctorId),
        status: "APPROVED",
        startDate: { lte: endOfDay },
        endDate: { gte: startOfDay },
      },
    });

    if (leaveReq) {
      return res.json({
        available: false,
        reason: "Doctor is on leave",
        slots: [],
      });
    }

    // Check for block times (breaks, personal time, etc.)
    const blockTime = await prisma.blockTime.findFirst({
      where: {
        tenantId,
        userId: parseInt(doctorId),
        startAt: { lte: endOfDay },
        endAt: { gte: startOfDay },
      },
    });

    if (blockTime) {
      return res.json({
        available: false,
        reason: `Doctor unavailable: ${blockTime.reason}`,
        slots: [],
      });
    }

    // Get all booked visits for this doctor on this date
    const bookedVisits = await prisma.visit.findMany({
      where: {
        tenantId,
        doctorId: parseInt(doctorId),
        visitDate: {
          gte: new Date(dateParam + "T00:00:00+05:30"),
          lte: new Date(dateParam + "T23:59:59+05:30"),
        },
        status: { not: "cancelled" },
      },
      select: { visitDate: true },
    });

    // Generate 30-min slots from 9 AM to 6 PM
    const slots = [];
    for (let hour = 9; hour < 18; hour++) {
      for (let min = 0; min < 60; min += 30) {
        const timeStr = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;

        // Check if this slot is booked
        const isBooked = bookedVisits.some((visit) => {
          const visitHour = visit.visitDate.getHours();
          const visitMin = visit.visitDate.getMinutes();
          return visitHour === hour && visitMin === min;
        });

        slots.push({
          time: timeStr,
          available: !isBooked,
        });
      }
    }

    res.json({
      available: true,
      date: dateParam,
      doctorId: parseInt(doctorId),
      slots: slots.filter((s) => s.available).map((s) => s.time),
    });
  } catch (err) {
    console.error("[wellness] get time slots error:", err.message);
    res.status(500).json({ error: "Failed to fetch available time slots" });
  }
});

// Resolve the patient for an appointment booking.
//
// When a staff member is booking on behalf of a patient they may pass an
// explicit `patientId`. In that case we validate the patient belongs to the
// current tenant and return it. Customers (self-booking) cannot pass a
// patientId for another person; they always resolve to their own Patient
// row, creating it on first book. This prevents staff bookings from being
// silently attached to the logged-in admin's patient record.
async function resolveBookingPatient(req, tenantId) {
  const { userId, role } = req.user;
  const requestedPatientId = req.body.patientId
    ? parseInt(req.body.patientId, 10)
    : null;

  if (requestedPatientId && role !== "CUSTOMER") {
    const patient = await prisma.patient.findFirst({
      where: { id: requestedPatientId, tenantId },
    });
    if (!patient) {
      const error = new Error("Patient not found");
      error.name = "AppointmentError";
      error.status = 404;
      error.code = "PATIENT_NOT_FOUND";
      throw error;
    }
    return patient;
  }

  // Always use the current user's profile name for self-booking patients.
  // This prevents the appointment list from showing stale or admin names.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  const userName = user?.name || user?.email || "Patient";
  const userEmail = user?.email || null;

  let patient = await prisma.patient.findFirst({
    where: { tenant: { id: tenantId }, user: { id: userId } },
  });

  if (!patient) {
    patient = await prisma.patient.create({
      data: {
        name: userName,
        email: userEmail,
        source: "self-booking",
        tenant: { connect: { id: tenantId } },
        user: { connect: { id: userId } },
      },
    });
  } else if (patient.name !== userName || patient.email !== userEmail) {
    patient = await prisma.patient.update({
      where: { id: patient.id },
      data: {
        name: userName,
        email: userEmail,
      },
    });
  }

  return patient;
}

// User appointment booking endpoint
// Allows any authenticated user to book an appointment
// Legacy CUSTOMER-session booking endpoint. Thin adapter around
// appointmentService.bookAppointment — business rules live in the
// service so this route and /portal/appointments/book can't drift.
// Patient resolution (create-on-first-book or explicit patientId for staff)
// stays at the route layer because the CUSTOMER cohort's user→patient
// mapping differs from the phone+OTP cohort's already-resolved req.patient.
router.post("/appointments/book", verifyToken, async (req, res) => {
  try {
    const { userId, tenantId } = req.user;
    const patient = await resolveBookingPatient(req, tenantId);

    const { visit } = await appointmentService.bookAppointment({
      tenantId,
      patientId: patient.id,
      doctorId: req.body.doctorId,
      serviceId: req.body.serviceId,
      membershipId: req.body.membershipId,
      appointmentDate: req.body.appointmentDate,
      appointmentTime: req.body.appointmentTime,
      reason: req.body.reason,
      bookingType: req.body.bookingType || "CLINIC_VISIT",
      actor: { type: "user", id: userId },
    });

    res.status(201).json({
      success: true,
      appointment: {
        id: visit.id,
        patientName: visit.patient.name,
        doctorName: visit.doctor?.name || "Pending assignment",
        serviceName: visit.service?.name || "General",
        appointmentDate: visit.visitDate,
        status: visit.status,
        reason: visit.reason,
        membershipId: visit.membershipId,
        doctorAssigned: !!visit.doctorId,
      },
    });
  } catch (err) {
    if (err && err.name === "AppointmentError") {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    console.error("[wellness] appointment booking failed:", err.message);
    res.status(500).json({
      error: "Failed to book appointment",
      code: "APPOINTMENT_BOOKING_FAILED",
    });
  }
});

// ─────────────────────────────────────────────────────────────────
// Pay-now booking flow: customer pays via Razorpay BEFORE the slot is
// reserved. Two-step handshake mirrors the gift-card storefront pattern.
//   1. POST /appointments/book-and-pay
//        Creates Razorpay Order + PENDING Payment row with booking intent
//        stashed in metadata. Does NOT create the Visit yet.
//   2. POST /appointments/confirm-payment
//        Verifies the HMAC signature, creates the Visit using the
//        existing appointmentService, marks Payment SUCCESS.
// "Pay later" path is the existing /appointments/book — Visit created
// immediately, no payment row.
// ─────────────────────────────────────────────────────────────────

const APPOINTMENT_GST_RATE = 0.18;
const APPOINTMENT_CONVENIENCE_FEE = 49;

router.post("/appointments/book-and-pay", verifyToken, async (req, res) => {
  try {
    const crypto = require("crypto");
    const {
      getTenantRazorpayClient,
      NOT_CONFIGURED_MESSAGE,
    } = require("../lib/tenantPaymentGateway");

    const { userId, tenantId, role } = req.user;
    const {
      reason,
      doctorId,
      serviceId,
      membershipId,
      appointmentDate,
      appointmentTime,
      bookingType,
      patientId,
    } = req.body || {};

    if (!reason || !serviceId || !appointmentDate || !appointmentTime) {
      return res.status(400).json({
        error: "reason, serviceId, appointmentDate, appointmentTime required",
        code: "INVALID_INPUT",
      });
    }

    // Resolve the service + its price. Pay-now requires a real basePrice.
    const service = await prisma.service.findFirst({
      where: { id: parseInt(serviceId, 10), tenantId, isActive: true },
    });
    if (!service) {
      return res.status(404).json({ error: "Service not found", code: "SERVICE_NOT_FOUND" });
    }
    if (service.basePrice == null || Number(service.basePrice) <= 0) {
      return res.status(409).json({
        error: "This service is consultation-priced. Please choose 'Pay after service' instead.",
        code: "SERVICE_NOT_PAYABLE",
      });
    }

    // Validate explicit patientId (staff booking on behalf of a patient) just
    // like the /appointments/book path. The id is stashed in metadata so
    // confirm-payment can bind the visit to the same patient. For self-booking,
    // resolve the patient now so the Payment row can be linked to the correct
    // contact and the payments list shows the customer's name instead of admin.
    let resolvedPatientId = null;
    let resolvedContactId = null;
    const requestedPatientId = patientId ? parseInt(patientId, 10) : null;
    if (requestedPatientId && role !== "CUSTOMER") {
      const patient = await prisma.patient.findFirst({
        where: { id: requestedPatientId, tenantId },
      });
      if (!patient) {
        return res.status(404).json({ error: "Patient not found", code: "PATIENT_NOT_FOUND" });
      }
      resolvedPatientId = patient.id;
      const contact = await ensurePatientContact(patient, tenantId);
      resolvedContactId = contact.id;
    } else {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });
      const userName = user?.name || user?.email || "Patient";
      const userEmail = user?.email || null;

      let patient = await prisma.patient.findFirst({
        where: { tenant: { id: tenantId }, user: { id: userId } },
      });

      if (!patient) {
        patient = await prisma.patient.create({
          data: {
            name: userName,
            email: userEmail,
            source: "self-booking",
            tenant: { connect: { id: tenantId } },
            user: { connect: { id: userId } },
          },
        });
      } else if (patient.name !== userName || patient.email !== userEmail) {
        patient = await prisma.patient.update({
          where: { id: patient.id },
          data: { name: userName, email: userEmail },
        });
      }

      const contact = await ensurePatientContact(patient, tenantId);
      resolvedContactId = contact.id;
    }

    // Server-side price computation. baseAmount + 18% GST + ₹49 convenience.
    const baseAmount = Number(service.basePrice);
    const tax = Math.round(baseAmount * APPOINTMENT_GST_RATE * 100) / 100;
    const total = Math.round((baseAmount + tax + APPOINTMENT_CONVENIENCE_FEE) * 100) / 100;

    // Load the tenant's Razorpay client (BYOK).
    const rp = await getTenantRazorpayClient(tenantId);
    if (!rp) {
      return res.status(503).json({
        error: NOT_CONFIGURED_MESSAGE,
        code: "GATEWAY_NOT_CONFIGURED",
      });
    }

    let order;
    try {
      order = await rp.client.orders.create({
        amount: Math.round(total * 100),
        currency: "INR",
        receipt: `apt_${userId}_${Date.now()}`,
        notes: {
          tenantId: String(tenantId),
          userId: String(userId),
          serviceId: String(service.id),
          kind: "appointment_payment",
        },
      });
    } catch (gatewayErr) {
      console.error("[wellness] book-and-pay order failed:", gatewayErr && gatewayErr.message);
      return res.status(502).json({ error: "Failed to create payment order", code: "GATEWAY_ERROR" });
    }

    const breakdown = {
      baseAmount: +baseAmount.toFixed(2),
      tax: +tax.toFixed(2),
      convenienceFee: APPOINTMENT_CONVENIENCE_FEE,
      total: +total.toFixed(2),
    };

    const payment = await prisma.payment.create({
      data: {
        invoiceId: null,
        contactId: resolvedContactId,
        amount: total,
        currency: "INR",
        gateway: "razorpay",
        gatewayId: order.id,
        status: "PENDING",
        tenantId,
        metadata: JSON.stringify({
          kind: "appointment_payment",
          userId,
          serviceId: service.id,
          doctorId: doctorId ? parseInt(doctorId, 10) : null,
          membershipId: membershipId ? parseInt(membershipId, 10) : null,
          appointmentDate,
          appointmentTime,
          reason: String(reason).slice(0, 1000),
          bookingType: bookingType || "CLINIC_VISIT",
          patientId: resolvedPatientId,
          breakdown,
        }),
      },
    });

    res.status(201).json({
      orderId: order.id,
      paymentId: payment.id,
      key: rp.keyId,
      amount: Math.round(total * 100),
      currency: "INR",
      breakdown,
      service: { id: service.id, name: service.name },
    });
  } catch (err) {
    console.error("[wellness] book-and-pay error:", err.message, err.stack);
    res.status(500).json({ error: "Failed to start payment", code: "BOOK_AND_PAY_FAILED" });
  }
});

router.post("/appointments/confirm-payment", verifyToken, async (req, res) => {
  try {
    const crypto = require("crypto");
    const {
      getTenantRazorpayCreds,
      NOT_CONFIGURED_MESSAGE,
    } = require("../lib/tenantPaymentGateway");

    const { userId, tenantId } = req.user;
    const {
      paymentId,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};

    if (!paymentId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res
        .status(400)
        .json({ error: "Missing required fields", code: "INVALID_INPUT" });
    }

    const payment = await prisma.payment.findFirst({
      where: { id: parseInt(paymentId, 10), tenantId },
    });
    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    // Idempotency: if a prior call already finalized this payment, return
    // the existing visit instead of double-charging or double-creating.
    const existingMeta = (() => {
      try { return JSON.parse(payment.metadata || "{}"); } catch { return {}; }
    })();
    if (payment.status === "SUCCESS" && existingMeta.visitId) {
      return res.json({
        success: true,
        visitId: existingMeta.visitId,
        alreadyConfirmed: true,
      });
    }

    // HMAC verify against tenant's Razorpay secret.
    const creds = await getTenantRazorpayCreds(tenantId);
    if (!creds || !creds.keySecret) {
      return res
        .status(503)
        .json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });
    }
    const expected = crypto
      .createHmac("sha256", creds.keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (expected !== razorpay_signature) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });
      return res
        .status(400)
        .json({ error: "Signature verification failed", code: "BAD_SIGNATURE" });
    }

    // Resolve the Patient row. If the booking was started on behalf of a
    // specific patient (staff flow), the patientId was verified at
    // /book-and-pay time and is stashed in metadata. Otherwise fall back to
    // the logged-in user's own patient record (self-booking).
    let patient;
    if (existingMeta.patientId) {
      patient = await prisma.patient.findFirst({
        where: { id: existingMeta.patientId, tenantId },
      });
      if (!patient) {
        return res.status(404).json({ error: "Patient not found", code: "PATIENT_NOT_FOUND" });
      }
    } else {
      // Always use the current user's profile name for self-booking patients.
      // This prevents the appointment list from showing stale or admin names.
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      });
      const userName = user?.name || user?.email || "Patient";
      const userEmail = user?.email || null;

      patient = await prisma.patient.findFirst({
        where: { tenant: { id: tenantId }, user: { id: userId } },
      });

      if (!patient) {
        patient = await prisma.patient.create({
          data: {
            name: userName,
            email: userEmail,
            source: "self-booking",
            tenant: { connect: { id: tenantId } },
            user: { connect: { id: userId } },
          },
        });
      } else if (patient.name !== userName || patient.email !== userEmail) {
        patient = await prisma.patient.update({
          where: { id: patient.id },
          data: {
            name: userName,
            email: userEmail,
          },
        });
      }
    }

    // Create the visit using the same service that backs /appointments/book.
    let visit;
    try {
      const result = await appointmentService.bookAppointment({
        tenantId,
        patientId: patient.id,
        doctorId: existingMeta.doctorId,
        serviceId: existingMeta.serviceId,
        membershipId: existingMeta.membershipId,
        appointmentDate: existingMeta.appointmentDate,
        appointmentTime: existingMeta.appointmentTime,
        reason: existingMeta.reason,
        bookingType: existingMeta.bookingType || "CLINIC_VISIT",
        actor: { type: "user", id: userId },
      });
      visit = result.visit;
    } catch (bookErr) {
      // The Razorpay charge already succeeded, so we can't reject here.
      // Mark payment SUCCESS but record the failure for ops follow-up.
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "SUCCESS",
          paidAt: new Date(),
          gatewayId: razorpay_payment_id,
          metadata: JSON.stringify({
            ...existingMeta,
            razorpay_order_id,
            razorpay_payment_id,
            bookingError: bookErr.message || String(bookErr),
            needsManualBooking: true,
          }),
        },
      });
      return res.status(500).json({
        error: "Payment succeeded but the slot couldn't be reserved automatically. Our team will reach out shortly.",
        code: "BOOKING_AFTER_PAYMENT_FAILED",
        paymentId: payment.id,
      });
    }

    // Mark Payment SUCCESS + stash visitId for idempotency.
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "SUCCESS",
        paidAt: new Date(),
        gatewayId: razorpay_payment_id,
        metadata: JSON.stringify({
          ...existingMeta,
          razorpay_order_id,
          razorpay_payment_id,
          visitId: visit.id,
          verifiedAt: new Date().toISOString(),
        }),
      },
    });

    // Emit payment.collected so workflow rules / notifications run, same
    // shape as the existing payments.js handlers use.
    try {
      require("../lib/eventBus").emitEvent(
        "payment.collected",
        {
          invoiceId: null,
          paymentId: payment.id,
          amount: Number(payment.amount),
          method: "razorpay",
          currency: "INR",
          paidAt: new Date(),
        },
        tenantId,
        userId,
      );
    } catch (_e) { /* best-effort */ }

    res.json({
      success: true,
      visitId: visit.id,
      appointment: {
        id: visit.id,
        serviceName: visit.service?.name || "General",
        appointmentDate: visit.visitDate,
        status: visit.status,
      },
    });
  } catch (err) {
    console.error("[wellness] confirm-payment error:", err.message, err.stack);
    res.status(500).json({ error: "Failed to confirm payment", code: "CONFIRM_PAYMENT_FAILED" });
  }
});

// Get user's appointments
router.get("/appointments/my", verifyToken, async (req, res) => {
  try {
    const { userId, tenantId } = req.user;

    // Find patient record for current user
    const patient = await prisma.patient.findFirst({
      where: {
        tenant: { id: tenantId },
        user: { id: userId },
      },
    });

    if (!patient) {
      return res.json([]);
    }

    // Get all visits for this patient (booked, arrived, in-treatment; exclude cancelled/completed/no-show)
    const visits = await prisma.visit.findMany({
      where: {
        tenantId,
        patientId: patient.id,
        status: { in: ["booked", "arrived", "in-treatment", "checked-in"] },
      },
      include: {
        doctor: { select: { id: true, name: true } },
        service: { select: { id: true, name: true } },
      },
      orderBy: { visitDate: "asc" },
    });

    const appointments = visits.map((v) => ({
      id: v.id,
      doctorName: v.doctor?.name || "Pending assignment",
      serviceName: v.service?.name || "General",
      appointmentDate: v.visitDate,
      status: v.status,
      reason: v.reason || null,
      doctorAssigned: !!v.doctorId,
    }));

    res.json(appointments);
  } catch (err) {
    console.error("[wellness] get appointments failed:", err.message);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});

// List active memberships the current user can apply to a booking. The
// staff-side `/patients/:id/memberships` endpoint is phiReadGate-protected,
// so the self-booking page can't reach it from the patient's own session.
// This endpoint mirrors that read but scopes by req.user → patient and
// filters to active, non-expired rows.
router.get("/appointments/my-memberships", verifyToken, async (req, res) => {
  try {
    const { userId, tenantId } = req.user;
    const patient = await prisma.patient.findFirst({
      where: { tenant: { id: tenantId }, user: { id: userId } },
    });
    if (!patient) return res.json([]);

    const now = new Date();
    const rows = await prisma.membership.findMany({
      where: {
        tenantId,
        patientId: patient.id,
        status: "active",
        endDate: { gte: now },
      },
      include: {
        plan: { select: { id: true, name: true, durationDays: true } },
      },
      orderBy: { endDate: "asc" },
    });
    res.json(
      rows.map((m) => {
        let balance = [];
        try {
          const parsed = JSON.parse(m.balance || "[]");
          if (Array.isArray(parsed)) balance = parsed;
        } catch {
          /* leave as [] */
        }
        return {
          id: m.id,
          planId: m.planId,
          planName: m.plan?.name || "Membership",
          planDurationDays: m.plan?.durationDays || null,
          startDate: m.startDate,
          endDate: m.endDate,
          createdAt: m.createdAt,
          status: m.status,
          balance,
        };
      }),
    );
  } catch (err) {
    console.error("[wellness] my memberships failed:", err.message);
    res.status(500).json({ error: "Failed to fetch memberships" });
  }
});

// Cancel appointment
// Legacy CUSTOMER-session cancellation endpoint. Thin adapter — see
// appointmentService.cancelAppointment for the business rules.
router.post("/appointments/:id/cancel", verifyToken, async (req, res) => {
  try {
    const { userId, tenantId } = req.user;
    const patient = await prisma.patient.findFirst({
      where: { tenantId, userId },
      select: { id: true },
    });
    if (!patient) {
      return res.status(404).json({ error: "Appointment not found" });
    }
    const { visit } = await appointmentService.cancelAppointment({
      tenantId,
      patientId: patient.id,
      visitId: req.params.id,
      actor: { type: "user", id: userId },
    });
    res.json({
      success: true,
      appointment: { id: visit.id, status: visit.status },
    });
  } catch (err) {
    if (err && err.name === "AppointmentError") {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    console.error("[wellness] cancel appointment failed:", err.message);
    res.status(500).json({ error: "Failed to cancel appointment" });
  }
});

// ───────────────────────────────────────────────────────────────────
// Patient portal appointment endpoints — accept BOTH cohorts via
// verifyPatientToken (Path A = phone+OTP, Path B = CUSTOMER session
// resolved to Patient). Business logic lives in appointmentService;
// these routes only handle token verification + envelope shape.
// ───────────────────────────────────────────────────────────────────

router.get("/portal/appointments", verifyPatientToken, async (req, res) => {
  try {
    const bucket = String(req.query.bucket || "upcoming");
    const visits = await appointmentService.listPatientAppointments({
      tenantId: req.patient.tenantId,
      patientId: req.patient.id,
      bucket,
    });
    const appointments = visits.map(appointmentService.mapVisitToAppointment);
    res.json({ bucket, count: appointments.length, appointments });
  } catch (err) {
    if (err && err.name === "AppointmentError") {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    console.error("[wellness] portal list appointments failed:", err.message);
    res.status(500).json({ error: "Failed to load appointments" });
  }
});

router.post(
  "/portal/appointments/book",
  verifyPatientToken,
  async (req, res) => {
    try {
      const { visit } = await appointmentService.bookAppointment({
        tenantId: req.patient.tenantId,
        patientId: req.patient.id,
        doctorId: req.body.doctorId,
        serviceId: req.body.serviceId,
        membershipId: req.body.membershipId,
        appointmentDate: req.body.appointmentDate,
        appointmentTime: req.body.appointmentTime,
        reason: req.body.reason,
        bookingType: req.body.bookingType || "CLINIC_VISIT",
        actor: { type: "patient", id: req.patient.id },
      });
      res.status(201).json({
        success: true,
        appointment: appointmentService.mapVisitToAppointment(visit),
      });
    } catch (err) {
      if (err && err.name === "AppointmentError") {
        return res
          .status(err.status)
          .json({ error: err.message, code: err.code });
      }
      console.error("[wellness] portal book appointment failed:", err.message);
      res.status(500).json({
        error: "Failed to book appointment",
        code: "APPOINTMENT_BOOKING_FAILED",
      });
    }
  },
);

router.post(
  "/portal/appointments/:id/cancel",
  verifyPatientToken,
  async (req, res) => {
    try {
      const { visit } = await appointmentService.cancelAppointment({
        tenantId: req.patient.tenantId,
        patientId: req.patient.id,
        visitId: req.params.id,
        actor: { type: "patient", id: req.patient.id },
      });
      res.json({
        success: true,
        appointment: appointmentService.mapVisitToAppointment(visit),
      });
    } catch (err) {
      if (err && err.name === "AppointmentError") {
        return res
          .status(err.status)
          .json({ error: err.message, code: err.code });
      }
      console.error(
        "[wellness] portal cancel appointment failed:",
        err.message,
      );
      res.status(500).json({ error: "Failed to cancel appointment" });
    }
  },
);

router.patch(
  "/portal/appointments/:id/reschedule",
  verifyPatientToken,
  async (req, res) => {
    try {
      const { visit } = await appointmentService.rescheduleAppointment({
        tenantId: req.patient.tenantId,
        patientId: req.patient.id,
        visitId: req.params.id,
        newAppointmentDate: req.body.appointmentDate,
        newAppointmentTime: req.body.appointmentTime,
        actor: { type: "patient", id: req.patient.id },
      });
      res.json({
        success: true,
        appointment: appointmentService.mapVisitToAppointment(visit),
      });
    } catch (err) {
      if (err && err.name === "AppointmentError") {
        return res
          .status(err.status)
          .json({ error: err.message, code: err.code });
      }
      console.error(
        "[wellness] portal reschedule appointment failed:",
        err.message,
      );
      res.status(500).json({ error: "Failed to reschedule appointment" });
    }
  },
);

module.exports = router;
