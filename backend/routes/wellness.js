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
const { runForTenant, executeApproved } = require("../cron/orchestratorEngine");
const {
  renderPrescriptionPdf,
  renderConsentPdf,
  renderBrandedInvoicePdf,
} = require("../services/pdfRenderer");
const { writeAudit, diffFields } = require("../lib/audit");
// Issue #207/#214/#216: wellness users carry both `role` (ADMIN/MANAGER/USER)
// and an orthogonal `wellnessRole` (doctor/professional/telecaller/helper).
// verifyRole only knows about the former, so a USER+doctor could hit Owner-
// Dashboard / financial / catalog mutation endpoints. verifyWellnessRole adds
// the second axis: allow lists like ["doctor","admin"] gate clinical writes,
// ["admin","manager"] gates org-wide reports + catalog edits.
const { verifyWellnessRole } = require("../middleware/wellnessRole");

// Portal tokens carry { patientId } and are issued/verified separately from staff
// tokens. Prefer a dedicated PORTAL_JWT_SECRET so a leaked patient-portal key
// can't forge staff tokens; fall back to JWT_SECRET when unset for transition.
const PORTAL_JWT_SECRET =
  process.env.PORTAL_JWT_SECRET ||
  process.env.JWT_SECRET ||
  "enterprise_super_secret_key_2026";

// Patient-portal inline JWT middleware — used by /portal/* endpoints.
// Portal endpoints bypass the global user-JWT guard (see server.js openPaths)
// so we must verify the patient token here.
function verifyPatientToken(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing portal token" });
  try {
    const decoded = jwt.verify(token, PORTAL_JWT_SECRET);
    if (!decoded.patientId) {
      return res.status(401).json({ error: "Invalid portal token" });
    }
    req.patient = {
      id: decoded.patientId,
      phoneLast10: decoded.phoneLast10,
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired portal token" });
  }
}

const router = express.Router();

// Multer storage for visit photos: uploads/wellness/visits/<visitId>/<filename>
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const visitId = req.params.id;
      const dir = path.join(__dirname, "..", "uploads", "wellness", "visits", String(visitId));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const safe = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      cb(null, safe);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per photo
});

// ── Helpers ────────────────────────────────────────────────────────

// Reject non-numeric :id params with 400 instead of letting Prisma blow up
// later with "Invalid value provided. Expected Int, provided NaN" → 500.
router.param("id", (req, res, next, id) => {
  const n = parseInt(id, 10);
  if (Number.isNaN(n) || n < 1) {
    return res.status(400).json({ error: "id must be a positive integer", code: "INVALID_ID" });
  }
  next();
});

const tenantWhere = (req, extra = {}) => ({ tenantId: req.user.tenantId, ...extra });

// Gap #22: Auto-credit loyalty points on completed visits.
// Earn rule: 10% of amountCharged (floored). Idempotent — only one 'earned'
// LoyaltyTransaction per visitId. Failures are swallowed so the visit save
// is never rolled back by a loyalty issue.
async function maybeAutoCreditLoyalty(visit, tenantId) {
  try {
    if (!visit || visit.status !== "completed") return;
    const amt = parseFloat(visit.amountCharged);
    if (!amt || amt <= 0) return;
    const points = Math.floor(amt * 0.1);
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
        reason: `Visit #${visit.id} (auto 10% earn)`,
        visitId: visit.id,
      },
    });
  } catch (err) {
    console.error("[wellness] auto-credit loyalty failed:", err.message);
  }
}

// Day boundaries in IST (UTC+05:30). Wellness clinics are India-based, so
// "today" must mean the IST calendar day — using server-local hours would
// shift the window by 5h30 on UTC servers (the production default), making
// 00:00–05:30 IST visits land on the previous day.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const startOfDay = (d = new Date()) => {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
};
const endOfDay = (d = new Date()) => {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(23, 59, 59, 999);
  return new Date(ist.getTime() - IST_OFFSET_MS);
};

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

// ── Patients ───────────────────────────────────────────────────────

router.get("/patients", async (req, res) => {
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
    const [patients, total] = await Promise.all([
      prisma.patient.findMany({
        where,
        take: Math.min(parseInt(limit), 200),
        skip: parseInt(offset),
        orderBy: { createdAt: "desc" },
      }),
      prisma.patient.count({ where }),
    ]);
    // PRD §11: HIPAA / DPDP Act — log every PHI read. Patient list is a
    // bulk PHI read; emit ONE row per request (not N), with no PHI values.
    try {
      await writeAudit('Patient', 'PATIENT_LIST_READ', null, req.user.userId, req.user.tenantId, {
        count: patients.length,
        query: q || null,
        locationId: locationId ? parseInt(locationId) : null,
      });
    } catch (auditErr) {
      console.warn("[wellness] audit PATIENT_LIST_READ failed:", auditErr.message);
    }
    res.json({ patients, total });
  } catch (e) {
    console.error("[wellness] list patients error:", e.message);
    res.status(500).json({ error: "Failed to list patients" });
  }
});

router.get("/patients/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const patient = await prisma.patient.findFirst({
      where: tenantWhere(req, { id }),
      include: {
        visits: {
          orderBy: { visitDate: "desc" },
          include: { service: true, doctor: { select: { id: true, name: true, email: true } } },
        },
        prescriptions: {
          orderBy: { createdAt: "desc" },
          // #278: include doctor so the Rx detail modal can show "prescribed by".
          include: { doctor: { select: { id: true, name: true, email: true } } },
        },
        consents: { orderBy: { signedAt: "desc" }, include: { service: true } },
        treatmentPlans: { include: { service: true } },
      },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    // PRD §11: log every patient detail read. Capture the FIELD NAMES returned
    // (so reviewers know what columns were exposed) but NEVER the values —
    // logging allergies/dob/phone here would defeat the audit-log's HIPAA role.
    try {
      const accessedFields = Object.keys(patient).filter(
        (k) => !["visits", "prescriptions", "consents", "treatmentPlans"].includes(k)
      );
      await writeAudit('Patient', 'PATIENT_DETAIL_READ', patient.id, req.user.userId, req.user.tenantId, {
        patientId: patient.id,
        name: patient.name,
        accessedFields,
      });
    } catch (auditErr) {
      console.warn("[wellness] audit PATIENT_DETAIL_READ failed:", auditErr.message);
    }
    res.json(patient);
  } catch (e) {
    console.error("[wellness] get patient error:", e.message);
    res.status(500).json({ error: "Failed to load patient" });
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

const { ensureEmail, ensureDob, ensureVisitDate, ensureEnum, ensureStringLength } = require("../lib/validators");

// #159 #160 #165 #170 #178: shared validation for Patient create + update.
function validatePatientInput(body, { isUpdate = false } = {}) {
  // #220: cap at 191 to match utf8mb4 VARCHAR(191) DB column limit. The
  // earlier 200 cap let names through that the DB then rejected with 500.
  const nameErr = ensureStringLength(body.name, { max: 191, field: "name", required: !isUpdate });
  if (nameErr) return nameErr;
  // #237: reject HTML/JS-shaped chars in patient names so they can't pollute
  // SMS/WhatsApp templates, CSV exports, or printed receipts where escaping
  // rules differ from React's. React already escapes at render — this is
  // defence-in-depth at the ingestion layer.
  if (body.name != null && /[<>]|onerror\s*=|javascript:/i.test(String(body.name))) {
    return { status: 400, error: "name contains forbidden characters", code: "INVALID_NAME" };
  }
  const emailErr = ensureEmail(body.email);
  if (emailErr) return emailErr;
  if (!isValidPhoneOrEmpty(body.phone)) {
    return { status: 400, error: "phone must contain 10–15 digits", code: "INVALID_PHONE" };
  }
  const dobErr = ensureDob(body.dob);
  if (dobErr) return dobErr;
  return null;
}

const ALLOWED_VISIT_STATUSES = new Set(["booked", "arrived", "in-treatment", "completed", "no-show", "cancelled"]);

// #197: visit status state machine. Terminal statuses (completed, cancelled,
// no-show) are not freely re-openable from a PUT — re-opening requires an
// explicit /reopen endpoint (TODO if needed). The matrix below allows the
// natural forward progression and a few corrective backward transitions
// (e.g. accidentally marking arrived → back to booked).
const VISIT_TRANSITIONS = {
  "booked":       new Set(["booked", "arrived", "in-treatment", "completed", "no-show", "cancelled"]),
  "arrived":      new Set(["arrived", "booked", "in-treatment", "completed", "no-show", "cancelled"]),
  "in-treatment": new Set(["in-treatment", "arrived", "completed", "cancelled"]),
  "completed":    new Set(["completed"]), // terminal
  "no-show":      new Set(["no-show", "booked"]), // allow rebook
  "cancelled":    new Set(["cancelled"]), // terminal
};

router.post("/patients", async (req, res) => {
  try {
    const { name, email, phone, dob, gender, bloodGroup, allergies, notes, source, contactId } = req.body;
    const inputErr = validatePatientInput(req.body, { isUpdate: false });
    if (inputErr) return res.status(inputErr.status).json(inputErr);
    // #337: persist the trimmed name. validatePatientInput's ensureStringLength
    // now rejects whitespace-only names; this normalises the saved value so
    // the Patients list, search index, prescriptions, and SMS templates all
    // see the clean form.
    const normalisedName = typeof name === "string" ? name.trim() : name;
    const patient = await prisma.patient.create({
      data: {
        name: normalisedName,
        email,
        phone,
        dob: dob ? new Date(dob) : null,
        gender,
        bloodGroup,
        allergies,
        notes,
        source,
        contactId: contactId ? parseInt(contactId) : null,
        tenantId: req.user.tenantId,
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
    await writeAudit('Patient', 'CREATE', patient.id, req.user.userId, req.user.tenantId, {
      source: patient.source || null,
      hasEmail: !!patient.email,
      hasPhone: !!patient.phone,
    });

    res.status(201).json(patient);
  } catch (e) {
    console.error("[wellness] create patient error:", e.message);
    res.status(500).json({ error: "Failed to create patient" });
  }
});

router.put("/patients/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.patient.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Patient not found" });
    // #178: full validation on update mirrors create — phone/email/dob all checked.
    const inputErr = validatePatientInput(req.body, { isUpdate: true });
    if (inputErr) return res.status(inputErr.status).json(inputErr);

    const data = {};
    const allowed = ["name", "email", "phone", "gender", "bloodGroup", "allergies", "notes", "source", "photoUrl"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
    if (req.body.dob !== undefined) data.dob = req.body.dob ? new Date(req.body.dob) : null;

    const updated = await prisma.patient.update({ where: { id }, data });
    // #179: audit only the keys that changed. PII (email/phone) is recorded
    // by name only — the actual values are not stored in the audit blob to
    // limit exposure if audit logs leak.
    const changes = diffFields(existing, updated, Object.keys(data));
    const safeKeys = Object.keys(changes).filter((k) => !["email", "phone"].includes(k));
    const piiTouched = Object.keys(changes).filter((k) => ["email", "phone"].includes(k));
    if (safeKeys.length > 0 || piiTouched.length > 0) {
      const safeChanges = {};
      for (const k of safeKeys) safeChanges[k] = changes[k];
      await writeAudit('Patient', 'UPDATE', updated.id, req.user.userId, req.user.tenantId, {
        changedFields: safeChanges,
        piiFieldsTouched: piiTouched,
      });
    }
    res.json(updated);
  } catch (e) {
    console.error("[wellness] update patient error:", e.message);
    res.status(500).json({ error: "Failed to update patient" });
  }
});

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

router.get("/visits", async (req, res) => {
  try {
    const { patientId, doctorId, status, from, to, limit = 100, offset = 0 } = req.query;
    const where = tenantWhere(req);
    if (patientId) where.patientId = parseInt(patientId);
    if (doctorId) where.doctorId = parseInt(doctorId);
    if (status) where.status = status;
    if (from || to) {
      where.visitDate = {};
      if (from) where.visitDate.gte = new Date(from);
      if (to) where.visitDate.lte = new Date(to);
    }

    // #280: stylist/helper PHI scope. Bypass for ADMIN/MANAGER (org oversight).
    const wRole = req.user?.wellnessRole;
    const isOrgRole = req.user?.role === "ADMIN" || req.user?.role === "MANAGER";
    if (!isOrgRole && (wRole === "stylist" || wRole === "helper")) {
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

    const visits = await prisma.visit.findMany({
      where,
      take: Math.min(parseInt(limit), 500),
      skip: parseInt(offset),
      orderBy: { visitDate: "desc" },
      include: {
        patient: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true, category: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    res.json(visits);
  } catch (e) {
    console.error("[wellness] list visits error:", e.message);
    res.status(500).json({ error: "Failed to list visits" });
  }
});

router.get("/visits/:id", async (req, res) => {
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
      await writeAudit('Visit', 'VISIT_READ', visit.id, req.user.userId, req.user.tenantId, {
        visitId: visit.id,
        patientId: visit.patientId,
        hasNotes: Boolean(visit.notes && String(visit.notes).trim().length > 0),
        hasPhotos: Array.isArray(visit.photos)
          ? visit.photos.length > 0
          : Boolean(visit.photos && String(visit.photos).length > 2),
      });
    } catch (auditErr) {
      console.warn("[wellness] audit VISIT_READ failed:", auditErr.message);
    }
    res.json(visit);
  } catch (e) {
    console.error("[wellness] get visit error:", e.message);
    res.status(500).json({ error: "Failed to load visit" });
  }
});

router.post("/visits", async (req, res) => {
  try {
    const { patientId, serviceId, doctorId, visitDate, status, vitals, notes, amountCharged, treatmentPlanId } = req.body;
    if (!patientId) return res.status(400).json({ error: "patientId is required" });
    // #170: visitDate must be a valid date in [now-5y, now+1y]. Pre-fix the
    // route accepted year 1800 / 3000 (silent 201) and 500'd on bogus strings.
    if (visitDate !== undefined) {
      const dateErr = ensureVisitDate(visitDate);
      if (dateErr) return res.status(dateErr.status).json(dateErr);
    }
    // #170: status restricted to the documented enum (no more "COMPLETELY_BOGUS").
    if (status !== undefined && status !== null && status !== "") {
      const statusErr = ensureEnum(status, ALLOWED_VISIT_STATUSES, { field: "status", code: "STATUS_INVALID" });
      if (statusErr) return res.status(statusErr.status).json(statusErr);
    }
    // #109: a "completed" visit (the default the UI submits) must have a service
    // and doctor — anonymous "ghost visits" corrupt revenue/per-pro reports.
    // Booked/cancelled/no-show statuses can be partial since the visit hasn't happened.
    const isCompleted = !status || status === "completed" || status === "in-treatment";
    if (isCompleted && !serviceId) return res.status(400).json({ error: "serviceId is required for a completed visit", code: "SERVICE_REQUIRED" });
    if (isCompleted && !doctorId) return res.status(400).json({ error: "doctorId is required for a completed visit", code: "DOCTOR_REQUIRED" });
    // #109: amount must be non-negative — negative charges distort revenue analytics.
    if (amountCharged != null && amountCharged !== "" && Number(amountCharged) < 0) {
      return res.status(400).json({ error: "amountCharged must be 0 or greater", code: "AMOUNT_NEGATIVE" });
    }
    // #277: cap amountCharged at ₹50,00,000 (₹50L) to match the Service.basePrice
    // ceiling from #209. Without this, a visit can store ₹1e15 (one quadrillion)
    // and blow up Owner Dashboard's expectedRevenue tile to twenty trillion.
    if (amountCharged != null && amountCharged !== "" && Number(amountCharged) > 5_000_000) {
      return res.status(400).json({ error: "amountCharged exceeds the ₹50,00,000 per-visit cap", code: "AMOUNT_TOO_LARGE" });
    }

    const visit = await prisma.visit.create({
      data: {
        patientId: parseInt(patientId),
        serviceId: serviceId ? parseInt(serviceId) : null,
        doctorId: doctorId ? parseInt(doctorId) : null,
        treatmentPlanId: treatmentPlanId ? parseInt(treatmentPlanId) : null,
        visitDate: visitDate ? new Date(visitDate) : new Date(),
        status: status || "completed",
        vitals: vitals ? (typeof vitals === "object" ? JSON.stringify(vitals) : vitals) : null,
        notes,
        amountCharged: amountCharged ? parseFloat(amountCharged) : null,
        tenantId: req.user.tenantId,
      },
    });

    // If linked to a treatment plan, increment completedSessions
    if (visit.treatmentPlanId && (visit.status === "completed")) {
      await prisma.treatmentPlan.update({
        where: { id: visit.treatmentPlanId },
        data: { completedSessions: { increment: 1 } },
      });
    }

    // Gap #22: auto-credit loyalty (10% of amountCharged, floored) on
    // completed visits. Idempotency via unique-per-visit ledger row keyed
    // by (visitId, type='earned'). Failures must not roll back the visit.
    await maybeAutoCreditLoyalty(visit, req.user.tenantId);

    // #179: audit Visit creation.
    await writeAudit('Visit', 'CREATE', visit.id, req.user.userId, req.user.tenantId, {
      patientId: visit.patientId,
      serviceId: visit.serviceId,
      doctorId: visit.doctorId,
      status: visit.status,
      visitDate: visit.visitDate,
      amountCharged: visit.amountCharged,
    });

    res.status(201).json(visit);
  } catch (e) {
    console.error("[wellness] create visit error:", e.message);
    res.status(500).json({ error: "Failed to create visit" });
  }
});

router.put("/visits/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.visit.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Visit not found" });

    const data = {};
    // Agent B: added videoRoom (telehealth Jitsi room name)
    const allowed = ["status", "vitals", "notes", "photosBefore", "photosAfter", "amountCharged", "videoRoom"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
    if (req.body.visitDate !== undefined) data.visitDate = new Date(req.body.visitDate);

    // #277: same per-visit cap as POST — reject overflow updates.
    if (data.amountCharged != null && data.amountCharged !== "") {
      const amt = Number(data.amountCharged);
      if (amt < 0) return res.status(400).json({ error: "amountCharged must be 0 or greater", code: "AMOUNT_NEGATIVE" });
      if (amt > 5_000_000) return res.status(400).json({ error: "amountCharged exceeds the ₹50,00,000 per-visit cap", code: "AMOUNT_TOO_LARGE" });
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
      const allowedNext = VISIT_TRANSITIONS[existing.status] || ALLOWED_VISIT_STATUSES;
      if (!allowedNext.has(data.status)) {
        return res.status(422).json({
          error: `cannot transition visit from '${existing.status}' to '${data.status}'`,
          code: "INVALID_VISIT_TRANSITION",
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
        console.error("[wellness] waitlist auto-offer hook failed:", hookErr.message);
      }
    }

    // #179: audit visit update. Status transitions (booked → in-treatment →
    // completed → cancelled / no-show) are the highest-signal field; always
    // capture from/to explicitly when status changed.
    const changes = diffFields(existing, updated, Object.keys(data));
    if (Object.keys(changes).length > 0) {
      const action = (changes.status && existing.status !== updated.status) ? 'STATUS_CHANGE' : 'UPDATE';
      await writeAudit('Visit', action, updated.id, req.user.userId, req.user.tenantId, {
        priorStatus: existing.status,
        newStatus: updated.status,
        changedFields: changes,
      });
    }

    res.json(updated);
  } catch (e) {
    console.error("[wellness] update visit error:", e.message);
    res.status(500).json({ error: "Failed to update visit" });
  }
});

// ── Visit photos (before/after) ────────────────────────────────────

router.post("/visits/:id/photos", photoUpload.array("photos", 10), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const visit = await prisma.visit.findFirst({ where: tenantWhere(req, { id }) });
    if (!visit) return res.status(404).json({ error: "Visit not found" });

    const which = req.body.kind === "after" ? "photosAfter" : "photosBefore";
    const existing = visit[which] ? JSON.parse(visit[which]) : [];
    const added = (req.files || []).map((f) => `/uploads/wellness/visits/${id}/${path.basename(f.path)}`);
    const merged = [...existing, ...added];

    const updated = await prisma.visit.update({
      where: { id },
      data: { [which]: JSON.stringify(merged) },
    });
    res.status(201).json({ kind: which, urls: merged, added });
  } catch (e) {
    console.error("[wellness] photo upload error:", e.message);
    res.status(500).json({ error: "Photo upload failed" });
  }
});

router.delete("/visits/:id/photos", async (req, res) => {
  // Body: { url, kind }
  try {
    const id = parseInt(req.params.id);
    const { url, kind = "before" } = req.body;
    const visit = await prisma.visit.findFirst({ where: tenantWhere(req, { id }) });
    if (!visit) return res.status(404).json({ error: "Visit not found" });
    const field = kind === "after" ? "photosAfter" : "photosBefore";
    const existing = visit[field] ? JSON.parse(visit[field]) : [];
    const next = existing.filter((u) => u !== url);
    await prisma.visit.update({ where: { id }, data: { [field]: JSON.stringify(next) } });
    res.json({ ok: true, urls: next });
  } catch (e) {
    res.status(500).json({ error: "Photo delete failed" });
  }
});

// ── Inventory consumption per visit ────────────────────────────────

router.get("/visits/:id/consumptions", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const items = await prisma.serviceConsumption.findMany({
      where: tenantWhere(req, { visitId: id }),
      orderBy: { createdAt: "desc" },
    });
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: "Failed to list consumption items" });
  }
});

router.post("/visits/:id/consumptions", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const visit = await prisma.visit.findFirst({ where: tenantWhere(req, { id }) });
    if (!visit) return res.status(404).json({ error: "Visit not found" });

    const { productName, qty = 1, unitCost = 0, productId } = req.body;
    if (!productName) return res.status(400).json({ error: "productName required" });

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
      return res.status(400).json({ error: "qty and unitCost must be non-negative", code: "AMOUNT_NEGATIVE" });
    }
    if (qNum > 10_000) {
      return res.status(400).json({ error: "qty exceeds the 10,000-unit per-line cap", code: "QTY_TOO_LARGE" });
    }
    if (cNum > 1_000_000) {
      return res.status(400).json({ error: "unitCost exceeds the ₹10,00,000 per-unit cap", code: "UNIT_COST_TOO_LARGE" });
    }
    if (qNum * cNum > 10_000_000) {
      return res.status(400).json({ error: "consumption line total exceeds the ₹1,00,00,000 per-line cap", code: "LINE_TOTAL_TOO_LARGE" });
    }

    const c = await prisma.serviceConsumption.create({
      data: {
        productName, qty: qNum, unitCost: cNum,
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
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (req.user.role === "ADMIN") return next();
  if (req.user.wellnessRole === "doctor") return next();
  return res.status(403).json({
    error: "Only clinical staff (doctor) may write prescriptions",
    code: "CLINICAL_ROLE_REQUIRED",
  });
}

router.get("/prescriptions", async (req, res) => {
  try {
    const { patientId, limit = 50 } = req.query;
    const where = tenantWhere(req);
    if (patientId) where.patientId = parseInt(patientId);
    const items = await prisma.prescription.findMany({
      where,
      take: Math.min(parseInt(limit), 200),
      orderBy: { createdAt: "desc" },
      include: {
        patient: { select: { id: true, name: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    res.json(items);
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
      return res.status(400).json({ error: "visitId and patientId are required" });
    }
    // #114: drugs must be a non-empty array with at least one named drug.
    // Pre-fix, the UI sent `drugs: []` (filtered empty) and `!drugs` was false
    // (empty array is truthy), so phantom prescriptions saved with no medication.
    const drugList = Array.isArray(drugs) ? drugs : [];
    const namedDrugs = drugList.filter((d) => d && typeof d.name === "string" && d.name.trim());
    if (namedDrugs.length === 0) {
      return res.status(400).json({ error: "At least one drug name is required", code: "DRUG_NAME_REQUIRED" });
    }
    const rx = await prisma.prescription.create({
      data: {
        visitId: parseInt(visitId),
        patientId: parseInt(patientId),
        doctorId: doctorId ? parseInt(doctorId) : req.user.id,
        drugs: JSON.stringify(namedDrugs),
        instructions,
        tenantId: req.user.tenantId,
      },
    });
    // #179: audit Rx creation. Medico-legal: capture drug names so amendments
    // can be diffed against the original prescription without joining tables.
    await writeAudit('Prescription', 'CREATE', rx.id, req.user.userId, req.user.tenantId, {
      patientId: rx.patientId,
      visitId: rx.visitId,
      doctorId: rx.doctorId,
      drugNames: namedDrugs.map((d) => d.name).slice(0, 20),
      drugCount: namedDrugs.length,
    });
    res.status(201).json(rx);
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
    const existing = await prisma.prescription.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Prescription not found" });
    if (existing.doctorId !== req.user.id && req.user.role !== "ADMIN") {
      return res.status(403).json({ error: "Only the prescriber or an admin can amend this prescription", code: "AMEND_FORBIDDEN" });
    }
    const data = {};
    if (req.body.drugs !== undefined) {
      const drugList = Array.isArray(req.body.drugs) ? req.body.drugs : [];
      const namedDrugs = drugList.filter((d) => d && typeof d.name === "string" && d.name.trim());
      if (namedDrugs.length === 0) {
        return res.status(400).json({ error: "At least one drug name is required", code: "DRUG_NAME_REQUIRED" });
      }
      data.drugs = JSON.stringify(namedDrugs);
    }
    if (req.body.instructions !== undefined) data.instructions = req.body.instructions;
    const updated = await prisma.prescription.update({ where: { id }, data });
    // #179: audit Rx amendment. This row is the medico-legal trail —
    // capture before/after drug arrays so the diff is reconstructible without
    // having to read prior versions of the row.
    let priorDrugs = null, newDrugs = null;
    try { priorDrugs = JSON.parse(existing.drugs || '[]'); } catch (_) {}
    try { newDrugs = JSON.parse(updated.drugs || '[]'); } catch (_) {}
    await writeAudit('Prescription', 'UPDATE_PRESCRIPTION', updated.id, req.user.userId, req.user.tenantId, {
      patientId: updated.patientId,
      visitId: updated.visitId,
      doctorId: updated.doctorId,
      amendedBy: req.user.userId,
      isOriginalPrescriber: existing.doctorId === req.user.id,
      priorDrugs,
      newDrugs,
      priorInstructions: existing.instructions || null,
      newInstructions: updated.instructions || null,
    });
    res.json(updated);
  } catch (e) {
    console.error("[wellness] amend prescription error:", e.message);
    res.status(500).json({ error: "Failed to amend prescription" });
  }
});

// ── Consent forms ──────────────────────────────────────────────────

router.get("/consents", async (req, res) => {
  try {
    const { patientId, limit = 50 } = req.query;
    const where = tenantWhere(req);
    if (patientId) where.patientId = parseInt(patientId);
    const items = await prisma.consentForm.findMany({
      where,
      take: Math.min(parseInt(limit), 200),
      orderBy: { signedAt: "desc" },
      include: {
        patient: { select: { id: true, name: true } },
        service: { select: { id: true, name: true } },
      },
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
router.post("/consents", verifyWellnessRole(["doctor", "professional", "admin"]), async (req, res) => {
  try {
    const { patientId, serviceId, templateName, signatureSvg } = req.body;
    if (!patientId || !templateName) {
      return res.status(400).json({ error: "patientId and templateName are required" });
    }
    // Defense-in-depth (#118): reject blank/missing signatures even if the UI
    // is bypassed. A blank 600x180 PNG data-URL is ~220 chars; a real signature
    // with strokes is several KB. 500 chars is well above the empty floor and
    // well below any genuine capture.
    if (!signatureSvg || typeof signatureSvg !== "string" || signatureSvg.length < 500) {
      return res.status(400).json({ error: "Patient signature is required and cannot be blank", code: "SIGNATURE_REQUIRED" });
    }
    const consent = await prisma.consentForm.create({
      data: {
        patientId: parseInt(patientId),
        serviceId: serviceId ? parseInt(serviceId) : null,
        templateName,
        signatureSvg,
        tenantId: req.user.tenantId,
      },
    });
    // #179: audit consent creation. Don't store the signatureSvg in the
    // audit blob — it's a few KB, and the row itself holds the canonical copy.
    await writeAudit('ConsentForm', 'CREATE', consent.id, req.user.userId, req.user.tenantId, {
      patientId: consent.patientId,
      serviceId: consent.serviceId,
      templateName: consent.templateName,
      signatureLength: signatureSvg.length,
    });
    res.status(201).json(consent);
  } catch (e) {
    console.error("[wellness] create consent error:", e.message);
    res.status(500).json({ error: "Failed to create consent" });
  }
});

// #194: amend a consent form — only the templateName + serviceId metadata
// can be corrected. The signatureSvg is captured-at-signing and is never
// editable post-hoc: that's a forgery vector, not an amendment. ADMIN only.
// #207/#216: consent metadata edits are admin-only (matches existing body
// check). The verifyWellnessRole gate just produces a clean 403 with the
// shared WELLNESS_ROLE_FORBIDDEN code before we touch the DB.
router.put("/consents/:id", verifyWellnessRole(["admin"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.consentForm.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Consent not found" });
    if (req.user.role !== "ADMIN") {
      return res.status(403).json({ error: "Only an admin can amend consent metadata", code: "AMEND_FORBIDDEN" });
    }
    const data = {};
    if (req.body.templateName !== undefined) data.templateName = req.body.templateName;
    if (req.body.serviceId !== undefined) data.serviceId = req.body.serviceId ? parseInt(req.body.serviceId) : null;
    if (req.body.signatureSvg !== undefined) {
      return res.status(400).json({ error: "signatureSvg cannot be edited after signing", code: "SIGNATURE_IMMUTABLE" });
    }
    const updated = await prisma.consentForm.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    console.error("[wellness] amend consent error:", e.message);
    res.status(500).json({ error: "Failed to amend consent" });
  }
});

// ── Treatment plans ────────────────────────────────────────────────

router.get("/treatments", async (req, res) => {
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
    res.json(plans);
  } catch (e) {
    console.error("[wellness] list treatments error:", e.message);
    res.status(500).json({ error: "Failed to list treatment plans" });
  }
});

router.post("/treatments", async (req, res) => {
  try {
    const { name, totalSessions, totalPrice, patientId, serviceId, nextDueAt } = req.body;
    if (!name || !totalSessions || !patientId) {
      return res.status(400).json({ error: "name, totalSessions, patientId required" });
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
    res.status(201).json(plan);
  } catch (e) {
    console.error("[wellness] create treatment error:", e.message);
    res.status(500).json({ error: "Failed to create treatment plan" });
  }
});

// ── Services (catalog) ─────────────────────────────────────────────

router.get("/services", async (req, res) => {
  try {
    const services = await prisma.service.findMany({
      where: tenantWhere(req, { isActive: true }),
      orderBy: [{ ticketTier: "desc" }, { name: "asc" }],
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
router.post("/services", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const { name, category, ticketTier, basePrice, durationMin, targetRadiusKm, description } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name required" });
    // #115: refuse zero-priced services from the catalog. Existing ₹0 rows
    // (e.g. seed-only "spa") stay visible until manually corrected — only
    // new creations are blocked.
    const price = Number(basePrice);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: "basePrice must be greater than 0", code: "PRICE_REQUIRED" });
    }
    // #209: cap basePrice at ₹50L (5_000_000). Public booking page exposes
    // garbage rows like ₹1e15 / 999999 min when there's no upper bound.
    if (price > 5_000_000) {
      return res.status(400).json({ error: "basePrice exceeds maximum (₹50,00,000)", code: "PRICE_TOO_HIGH" });
    }
    // #149: durationMin must be positive; targetRadiusKm must be non-negative
    // when supplied (null = unlimited is fine).
    // #209: cap durationMin at 8 hours (480 min) — anything beyond that is
    // not a single appointment.
    if (durationMin !== undefined && durationMin !== null) {
      const d = Number(durationMin);
      if (!Number.isFinite(d) || d <= 0) {
        return res.status(400).json({ error: "durationMin must be greater than 0", code: "DURATION_INVALID" });
      }
      // 720 min (12h) supports real long procedures like full hair transplant
      // sessions, which legitimately take 9-10 hours. The earlier 480 cap
      // accidentally caught real seed rows on the wellness tenant.
      if (d > 720) {
        return res.status(400).json({ error: "durationMin exceeds maximum (720)", code: "DURATION_TOO_HIGH" });
      }
    }
    if (targetRadiusKm !== undefined && targetRadiusKm !== null && targetRadiusKm !== "") {
      const r = Number(targetRadiusKm);
      if (!Number.isFinite(r) || r < 0) {
        return res.status(400).json({ error: "targetRadiusKm cannot be negative", code: "RADIUS_INVALID" });
      }
    }
    const svc = await prisma.service.create({
      data: {
        name,
        category,
        ticketTier: ticketTier || "medium",
        basePrice: basePrice ? parseFloat(basePrice) : 0,
        durationMin: durationMin ? parseInt(durationMin) : 30,
        targetRadiusKm: targetRadiusKm !== undefined && targetRadiusKm !== null ? parseInt(targetRadiusKm) : null,
        description,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(svc);
  } catch (e) {
    console.error("[wellness] create service error:", e.message);
    res.status(500).json({ error: "Failed to create service" });
  }
});

router.put("/services/:id", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.service.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Service not found" });
    const data = {};
    const allowed = ["name", "category", "ticketTier", "basePrice", "durationMin", "targetRadiusKm", "description", "isActive"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
    // #115: same price guard on edit — can't update a service to ₹0.
    if (data.basePrice !== undefined) {
      const price = Number(data.basePrice);
      if (!Number.isFinite(price) || price <= 0) {
        return res.status(400).json({ error: "basePrice must be greater than 0", code: "PRICE_REQUIRED" });
      }
      // #209: same upper-bound cap on edit.
      if (price > 5_000_000) {
        return res.status(400).json({ error: "basePrice exceeds maximum (₹50,00,000)", code: "PRICE_TOO_HIGH" });
      }
    }
    // #149: same duration / radius guards on edit.
    if (data.durationMin !== undefined && data.durationMin !== null) {
      const d = Number(data.durationMin);
      if (!Number.isFinite(d) || d <= 0) {
        return res.status(400).json({ error: "durationMin must be greater than 0", code: "DURATION_INVALID" });
      }
      // #209: same 8-hour cap on edit.
      // 720 min (12h) supports real long procedures like full hair transplant
      // sessions, which legitimately take 9-10 hours. The earlier 480 cap
      // accidentally caught real seed rows on the wellness tenant.
      if (d > 720) {
        return res.status(400).json({ error: "durationMin exceeds maximum (720)", code: "DURATION_TOO_HIGH" });
      }
    }
    if (data.targetRadiusKm !== undefined && data.targetRadiusKm !== null && data.targetRadiusKm !== "") {
      const r = Number(data.targetRadiusKm);
      if (!Number.isFinite(r) || r < 0) {
        return res.status(400).json({ error: "targetRadiusKm cannot be negative", code: "RADIUS_INVALID" });
      }
    }
    const updated = await prisma.service.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    console.error("[wellness] update service error:", e.message);
    res.status(500).json({ error: "Failed to update service" });
  }
});

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
      orderBy: [
        { priority: "desc" },
        { createdAt: "desc" },
      ],
      take: 500,
    });
    const STATUS_RANK = { rejected: 3, approved: 2, snoozed: 1, pending: 0 };
    const groups = new Map();
    for (const r of all) {
      const key = `${r.type || ""}::${(r.title || "").trim().toLowerCase()}`;
      const cur = groups.get(key);
      if (!cur) { groups.set(key, r); continue; }
      const curRank = STATUS_RANK[cur.status] ?? 0;
      const newRank = STATUS_RANK[r.status] ?? 0;
      // Prefer a terminal (approved/rejected) representative over pending.
      // Within the same status tier, the orderBy above means `cur` already
      // wins (higher priority + newer createdAt comes first).
      if (newRank > curRank) groups.set(key, r);
    }
    const reps = Array.from(groups.values());
    const filtered = status === "all"
      ? reps
      : reps.filter((r) => r.status === status);
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
router.put("/recommendations/:id", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.agentRecommendation.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Recommendation not found" });
    if (req.user.role !== "ADMIN" && req.user.role !== "MANAGER") {
      return res.status(403).json({ error: "Only ADMIN or MANAGER can amend recommendations", code: "AMEND_FORBIDDEN" });
    }
    if (existing.status !== "pending" && existing.status !== "snoozed") {
      return res.status(422).json({
        error: `Cannot amend a recommendation in status '${existing.status}'`,
        code: "AMEND_TERMINAL",
        currentStatus: existing.status,
      });
    }
    const data = {};
    const allowed = ["title", "body", "priority", "expectedImpact", "goalContext", "payload"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
    if (data.priority !== undefined && !["low", "medium", "high"].includes(data.priority)) {
      return res.status(400).json({ error: "priority must be one of: low, medium, high", code: "INVALID_PRIORITY" });
    }
    const updated = await prisma.agentRecommendation.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    console.error("[wellness] amend recommendation error:", e.message);
    res.status(500).json({ error: "Failed to amend recommendation" });
  }
});

router.post("/recommendations/:id/approve", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rec = await prisma.agentRecommendation.findFirst({ where: tenantWhere(req, { id }) });
    if (!rec) return res.status(404).json({ error: "Recommendation not found" });

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
      data: { status: "approved", resolvedById: req.user.id, resolvedAt: new Date() },
    });
    const current = await prisma.agentRecommendation.findFirst({ where: tenantWhere(req, { id }) });

    if (flip.count === 0) {
      // Another request already resolved this card. Return current state
      // without firing the dispatcher again. The final status is authoritative.
      // #185: surface explicit `idempotent` flag so callers can distinguish a
      // first-approve from a re-approve (the dispatcher only fires once).
      return res.json({ ...current, idempotent: true, _alreadyResolved: true });
    }

    // We won the race — safe to dispatch the approved action
    let actionResult = null;
    try { actionResult = await executeApproved(current, { actorUserId: req.user.id }); }
    catch (e) { console.error("[orchestrator] dispatch failed:", e.message); }
    // #179: audit recommendation approval. We log only AFTER the race-safe
    // flip so a re-approve attempt (count=0 above) does NOT generate a row.
    await writeAudit('AgentRecommendation', 'APPROVE', id, req.user.userId, req.user.tenantId, {
      title: current.title,
      priority: current.priority,
      dispatched: actionResult != null,
    });
    res.json({ ...current, _actionResult: actionResult });
  } catch (e) {
    console.error("[wellness] approve recommendation error:", e.message);
    res.status(500).json({ error: "Failed to approve" });
  }
});

// Manual orchestrator trigger — useful for demos and testing
router.post("/orchestrator/run", async (req, res) => {
  try {
    const result = await runForTenant(req.user.tenantId);
    res.json(result);
  } catch (e) {
    console.error("[orchestrator] manual run failed:", e.message);
    res.status(500).json({ error: "Failed to run orchestrator", detail: e.message });
  }
});

// Manual triggers for the other 2 crons — for testing + demo replay.
// Restricted to ADMIN/MANAGER (verify role via req.user.role check).
router.post("/reminders/run", async (req, res) => {
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
    res.status(500).json({ error: "Failed to run reminders", detail: e.message });
  }
});

router.post("/ops/run", async (req, res) => {
  try {
    const { runNpsForTenant, runRetentionForTenant } = require("../cron/wellnessOpsEngine");
    const npsSent = await runNpsForTenant(req.user.tenantId);
    const purged = await runRetentionForTenant(req.user.tenantId);
    res.json({ npsSent, purged });
  } catch (e) {
    console.error("[wellness-ops] manual run failed:", e.message);
    res.status(500).json({ error: "Failed to run ops", detail: e.message });
  }
});

// Manual trigger for the low-stock inventory alert engine.
// Returns the per-tenant breakdown { products, notifications, emails }.
router.post("/inventory/low-stock/run", async (req, res) => {
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
    res.status(500).json({ error: "Failed to run low-stock alerts", detail: e.message });
  }
});

router.post("/recommendations/:id/reject", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const rec = await prisma.agentRecommendation.findFirst({ where: tenantWhere(req, { id }) });
    if (!rec) return res.status(404).json({ error: "Recommendation not found" });

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
      where: { id, tenantId: req.user.tenantId, status: { in: ["pending", "snoozed"] } },
      data: { status: "rejected", resolvedById: req.user.id, resolvedAt: new Date() },
    });
    const current = await prisma.agentRecommendation.findFirst({ where: tenantWhere(req, { id }) });
    if (flip.count === 0) {
      return res.json({ ...current, idempotent: true });
    }
    // #179: audit recommendation rejection. As with /approve we only log after
    // the race-safe flip so re-rejection doesn't double-write.
    await writeAudit('AgentRecommendation', 'REJECT', id, req.user.userId, req.user.tenantId, {
      title: current.title,
      priority: current.priority,
      reason: req.body?.reason || null,
    });
    res.json(current);
  } catch (e) {
    console.error("[wellness] reject recommendation error:", e.message);
    res.status(500).json({ error: "Failed to reject" });
  }
});

// ── Locations (multi-clinic) ───────────────────────────────────────

router.get("/locations", async (req, res) => {
  try {
    const locations = await prisma.location.findMany({
      where: tenantWhere(req),
      orderBy: { name: "asc" },
    });
    res.json(locations);
  } catch (e) {
    console.error("[wellness] list locations error:", e.message);
    res.status(500).json({ error: "Failed to list locations" });
  }
});

// #216: clinic locations are operational config — admin/manager only.
router.post("/locations", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const { name, addressLine, city, state, pincode, country, phone, email, latitude, longitude, hours } = req.body;
    if (!name || !addressLine || !city) {
      return res.status(400).json({ error: "name, addressLine, city are required" });
    }
    const loc = await prisma.location.create({
      data: {
        name, addressLine, city,
        state: state || null,
        pincode: pincode || null,
        country: country || "India",
        phone: phone || null,
        email: email || null,
        latitude: latitude !== undefined ? parseFloat(latitude) : null,
        longitude: longitude !== undefined ? parseFloat(longitude) : null,
        hours: hours ? (typeof hours === "object" ? JSON.stringify(hours) : hours) : null,
        tenantId: req.user.tenantId,
      },
    });
    res.status(201).json(loc);
  } catch (e) {
    console.error("[wellness] create location error:", e.message);
    res.status(500).json({ error: "Failed to create location" });
  }
});

router.put("/locations/:id", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.location.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Location not found" });

    const data = {};
    const allowed = ["name", "addressLine", "city", "state", "pincode", "country", "phone", "email", "latitude", "longitude", "hours", "isActive"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];

    const updated = await prisma.location.update({ where: { id }, data });
    res.json(updated);
  } catch (e) {
    console.error("[wellness] update location error:", e.message);
    res.status(500).json({ error: "Failed to update location" });
  }
});

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
  const from = rawFrom ? new Date(rawFrom) : new Date(Date.now() - 30 * 86400000);
  if (rawFrom && DATE_ONLY.test(rawFrom)) from.setUTCHours(0, 0, 0, 0);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: { status: 400, error: "from and to must be valid dates", code: "INVALID_DATE_RANGE" } };
  }
  const fromY = from.getUTCFullYear();
  const toY = to.getUTCFullYear();
  if (fromY < MIN_REPORT_YEAR || fromY > MAX_REPORT_YEAR || toY < MIN_REPORT_YEAR || toY > MAX_REPORT_YEAR) {
    return { error: { status: 400, error: `year must be between ${MIN_REPORT_YEAR} and ${MAX_REPORT_YEAR}`, code: "DATE_OUT_OF_RANGE" } };
  }
  if (from.getTime() > to.getTime()) {
    return { error: { status: 400, error: "'from' must be on or before 'to'", code: "INVERTED_DATE_RANGE" } };
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
function canonicalVisitTotals(visits) {
  return {
    visits: visits.length,
    revenue: visits.reduce((s, v) => s + (parseFloat(v.amountCharged) || 0), 0),
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
  const locationId = req.query.locationId ? parseInt(req.query.locationId) : undefined;

  const visitWhere = { tenantId, visitDate: { gte: from, lte: to }, status: "completed" };
  if (locationId) visitWhere.locationId = locationId;

  const visits = await prisma.visit.findMany({
    where: visitWhere,
    // #212: id was missing here, so visitIdToCost[v.id || -1] always
    // resolved to -1 → 0 for every row, making PRODUCT COST ₹0
    // and CONTRIBUTION = REVENUE on every service.
    select: { id: true, serviceId: true, amountCharged: true, doctorId: true },
  });
  const services = await prisma.service.findMany({
    where: { tenantId },
    select: { id: true, name: true, category: true, ticketTier: true, basePrice: true },
  });
  // Gap #23: filter consumptions by their visit's visitDate, not by the
  // consumption's createdAt. A consumption logged on day N+1 against a
  // visit on day N would otherwise roll into N+1's productCost, desyncing
  // revenue (visitDate-based) from cost (createdAt-based).
  const consumptionWhere = { tenantId, visit: { visitDate: { gte: from, lte: to }, status: "completed" } };
  if (locationId) consumptionWhere.visit.locationId = locationId;
  const consumptions = await prisma.serviceConsumption.findMany({
    where: consumptionWhere,
    select: { visitId: true, qty: true, unitCost: true },
  });
  const visitIdToCost = {};
  for (const c of consumptions) {
    visitIdToCost[c.visitId] = (visitIdToCost[c.visitId] || 0) + (c.qty * c.unitCost);
  }

  const acc = {};
  for (const v of visits) {
    if (!v.serviceId) continue;
    const s = services.find((x) => x.id === v.serviceId);
    if (!s) continue;
    if (!acc[s.id]) acc[s.id] = { id: s.id, name: s.name, category: s.category, ticketTier: s.ticketTier, count: 0, revenue: 0, productCost: 0 };
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
    rows,
  };
}

async function computePerProfessional(req) {
  const tenantId = req.user.tenantId;
  const _rr = reportRange(req);
  if (_rr.error) return { error: _rr.error };
  const { from, to } = _rr;
  const locationId = req.query.locationId ? parseInt(req.query.locationId) : undefined;

  const visitWhere = { tenantId, visitDate: { gte: from, lte: to }, status: "completed" };
  if (locationId) visitWhere.locationId = locationId;

  const visits = await prisma.visit.findMany({
    where: visitWhere,
    select: { doctorId: true, amountCharged: true, serviceId: true },
  });
  const doctors = await prisma.user.findMany({
    where: { tenantId },
    select: { id: true, name: true, email: true, role: true, wellnessRole: true },
  });

  const acc = {};
  for (const v of visits) {
    if (!v.doctorId) continue;
    const d = doctors.find((x) => x.id === v.doctorId);
    if (!d) continue;
    if (!acc[d.id]) acc[d.id] = { id: d.id, name: d.name, role: d.role, wellnessRole: d.wellnessRole, visits: 0, revenue: 0 };
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

  const acc = {};
  const bucket = (src) => (src || "unknown").toLowerCase();
  for (const l of leads) {
    const k = bucket(l.firstTouchSource || l.source);
    if (!acc[k]) acc[k] = { source: k, leads: 0, junk: 0, qualified: 0, revenue: 0 };
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
    const k = bucket(v.patient?.source);
    if (!acc[k]) continue;
    acc[k].revenue += parseFloat(v.amountCharged) || 0;
  }
  const rows = Object.values(acc).map((r) => ({
    ...r,
    junkRate: r.leads ? Math.round((r.junk / r.leads) * 100) : 0,
    conversionRate: r.leads ? Math.round((r.qualified / r.leads) * 100) : 0,
    revenuePerLead: r.leads ? Math.round(r.revenue / r.leads) : 0,
  })).sort((a, b) => b.revenue - a.revenue);

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
    select: { locationId: true, amountCharged: true },
  });
  const patients = await prisma.patient.groupBy({
    by: ["locationId"], where: { tenantId }, _count: { _all: true },
  });
  const locations = await prisma.location.findMany({
    where: { tenantId }, select: { id: true, name: true, city: true, state: true, isActive: true },
  });

  const visitAcc = {};
  for (const v of visits) {
    const k = v.locationId ?? 0;
    if (!visitAcc[k]) visitAcc[k] = { visits: 0, revenue: 0 };
    visitAcc[k].visits += 1;
    visitAcc[k].revenue += parseFloat(v.amountCharged) || 0;
  }
  const rows = locations.map((l) => ({
    id: l.id, name: l.name, city: l.city, state: l.state, isActive: l.isActive,
    visits: visitAcc[l.id]?.visits || 0,
    revenue: visitAcc[l.id]?.revenue || 0,
    patients: patients.find((p) => p.locationId === l.id)?._count?._all || 0,
  })).sort((a, b) => b.revenue - a.revenue);

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

router.get("/reports/pnl-by-service", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const result = await computePnlByService(req);
    if (result.error) return res.status(result.error.status).json(result.error);
    res.json(result);
  } catch (e) {
    console.error("[reports] pnl-by-service:", e.message);
    res.status(500).json({ error: "Failed to compute P&L" });
  }
});

router.get("/reports/per-professional", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const result = await computePerProfessional(req);
    if (result.error) return res.status(result.error.status).json(result.error);
    res.json(result);
  } catch (e) {
    console.error("[reports] per-professional:", e.message);
    res.status(500).json({ error: "Failed to compute per-professional report" });
  }
});

router.get("/reports/attribution", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const result = await computeAttribution(req);
    if (result.error) return res.status(result.error.status).json(result.error);
    res.json(result);
  } catch (e) {
    console.error("[reports] attribution:", e.message);
    res.status(500).json({ error: "Failed to compute attribution" });
  }
});

router.get("/reports/per-location", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const result = await computePerLocation(req);
    if (result.error) return res.status(result.error.status).json(result.error);
    res.json(result);
  } catch (e) {
    console.error("[reports] per-location:", e.message);
    res.status(500).json({ error: "Failed to compute per-location report" });
  }
});

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
  try { return new Date(d).toISOString().slice(0, 10); } catch { return ""; }
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
  const addr = [c.addressLine, [c.city, c.state, c.pincode].filter(Boolean).join(", ")]
    .filter(Boolean).join("  ·  ");
  if (addr) doc.text(addr);
  const contact = [c.phone, c.email].filter(Boolean).join("  |  ");
  if (contact) doc.text(contact);
  doc.moveDown(0.3);
  const divY = doc.y;
  doc.moveTo(doc.page.margins.left, divY)
    .lineTo(doc.page.width - doc.page.margins.right, divY)
    .lineWidth(0.7).strokeColor("#999").stroke();
  doc.moveDown(0.6);

  // Title + range
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#111").text(title, { align: "center" });
  if (range?.from && range?.to) {
    doc.font("Helvetica").fontSize(9).fillColor("#666")
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
    doc.text(String(h), left + i * colW + 2, headerY, { width: colW - 4, ellipsis: true });
  });
  doc.moveTo(left, headerY + 14).lineTo(right, headerY + 14)
    .lineWidth(0.5).strokeColor("#bbb").stroke();

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
        doc.text(String(h), left + i * colW + 2, y, { width: colW - 4, ellipsis: true });
      });
      doc.moveTo(left, y + 14).lineTo(right, y + 14)
        .lineWidth(0.5).strokeColor("#bbb").stroke();
      y += 18;
      doc.font("Helvetica").fontSize(9).fillColor("#222");
    }
    row.forEach((cell, i) => {
      doc.text(cell === null || cell === undefined ? "" : String(cell),
        left + i * colW + 2, y, { width: colW - 4, ellipsis: true });
    });
    y += lineH;
  }
  if (rows.length === 0) {
    doc.fillColor("#888").text("No data in this window.", left, y + 6, { width: printW, align: "center" });
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

const fmtMoney = (n) => {
  const v = Number(n) || 0;
  return v.toFixed(2);
};

// ── P&L by service exports ─────────────────────────────────────────

router.get("/reports/pnl-by-service.csv", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const result = await computePnlByService(req);
    if (result.error) return res.status(result.error.status).json(result.error);
    const headers = ["Service", "Category", "Tier", "Visits", "Revenue", "Product cost", "Contribution"];
    const rows = result.rows.map((r) => [r.name, r.category, r.ticketTier, r.count, fmtMoney(r.revenue), fmtMoney(r.productCost), fmtMoney(r.contribution)]);
    rows.push([]);
    rows.push(["TOTAL", "", "", result.totals.visits, fmtMoney(result.totals.revenue), fmtMoney(result.totals.productCost), fmtMoney(result.totals.contribution)]);
    sendCsv(res, "pnl-by-service", result.window, rowsToCsv(headers, rows));
  } catch (e) {
    console.error("[reports] pnl-by-service.csv:", e.message);
    res.status(500).json({ error: "Failed to export P&L CSV" });
  }
});

router.get("/reports/pnl-by-service.pdf", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const result = await computePnlByService(req);
    if (result.error) return res.status(result.error.status).json(result.error);
    const clinic = await primaryClinic(req.user.tenantId);
    const columns = ["Service", "Category", "Tier", "Visits", "Revenue", "Product cost", "Contribution"];
    const rows = result.rows.map((r) => [r.name, r.category, r.ticketTier, r.count, fmtMoney(r.revenue), fmtMoney(r.productCost), fmtMoney(r.contribution)]);
    rows.push(["TOTAL", "", "", result.totals.visits, fmtMoney(result.totals.revenue), fmtMoney(result.totals.productCost), fmtMoney(result.totals.contribution)]);
    const buf = await renderReportPdf("P&L by Service", columns, rows, result.window, clinic);
    sendPdf(res, "pnl-by-service", result.window, buf);
  } catch (e) {
    console.error("[reports] pnl-by-service.pdf:", e.message);
    res.status(500).json({ error: "Failed to export P&L PDF" });
  }
});

// ── Per-professional exports ───────────────────────────────────────

router.get("/reports/per-professional.csv", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const result = await computePerProfessional(req);
    if (result.error) return res.status(result.error.status).json(result.error);
    const headers = ["Staff", "Role", "Visits", "Revenue"];
    const rows = result.rows.map((r) => [r.name, r.wellnessRole || r.role || "", r.visits, fmtMoney(r.revenue)]);
    rows.push([]);
    rows.push(["TOTAL", "", result.totals.visits, fmtMoney(result.totals.revenue)]);
    sendCsv(res, "per-professional", result.window, rowsToCsv(headers, rows));
  } catch (e) {
    console.error("[reports] per-professional.csv:", e.message);
    res.status(500).json({ error: "Failed to export per-professional CSV" });
  }
});

router.get("/reports/per-professional.pdf", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const result = await computePerProfessional(req);
    if (result.error) return res.status(result.error.status).json(result.error);
    const clinic = await primaryClinic(req.user.tenantId);
    const columns = ["Staff", "Role", "Visits", "Revenue"];
    const rows = result.rows.map((r) => [r.name, r.wellnessRole || r.role || "", r.visits, fmtMoney(r.revenue)]);
    rows.push(["TOTAL", "", result.totals.visits, fmtMoney(result.totals.revenue)]);
    const buf = await renderReportPdf("Per-Professional Report", columns, rows, result.window, clinic);
    sendPdf(res, "per-professional", result.window, buf);
  } catch (e) {
    console.error("[reports] per-professional.pdf:", e.message);
    res.status(500).json({ error: "Failed to export per-professional PDF" });
  }
});

// ── Per-location exports ───────────────────────────────────────────

router.get("/reports/per-location.csv", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const result = await computePerLocation(req);
    if (result.error) return res.status(result.error.status).json(result.error);
    const headers = ["Location", "City", "State", "Patients", "Visits", "Revenue", "Status"];
    const rows = result.rows.map((r) => [r.name, r.city || "", r.state || "", r.patients, r.visits, fmtMoney(r.revenue), r.isActive ? "Active" : "Inactive"]);
    rows.push([]);
    rows.push(["TOTAL", "", "", "", result.totals.visits, fmtMoney(result.totals.revenue), ""]);
    sendCsv(res, "per-location", result.window, rowsToCsv(headers, rows));
  } catch (e) {
    console.error("[reports] per-location.csv:", e.message);
    res.status(500).json({ error: "Failed to export per-location CSV" });
  }
});

router.get("/reports/per-location.pdf", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const result = await computePerLocation(req);
    if (result.error) return res.status(result.error.status).json(result.error);
    const clinic = await primaryClinic(req.user.tenantId);
    const columns = ["Location", "City", "State", "Patients", "Visits", "Revenue", "Status"];
    const rows = result.rows.map((r) => [r.name, r.city || "", r.state || "", r.patients, r.visits, fmtMoney(r.revenue), r.isActive ? "Active" : "Inactive"]);
    rows.push(["TOTAL", "", "", "", result.totals.visits, fmtMoney(result.totals.revenue), ""]);
    const buf = await renderReportPdf("Per-Location Report", columns, rows, result.window, clinic);
    sendPdf(res, "per-location", result.window, buf);
  } catch (e) {
    console.error("[reports] per-location.pdf:", e.message);
    res.status(500).json({ error: "Failed to export per-location PDF" });
  }
});

// ── Attribution exports ────────────────────────────────────────────

router.get("/reports/attribution.csv", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const result = await computeAttribution(req);
    if (result.error) return res.status(result.error.status).json(result.error);
    const headers = ["Source", "Leads", "Junk", "Junk %", "Qualified", "Conv %", "Revenue", "Rev / Lead"];
    const rows = result.rows.map((r) => [r.source, r.leads, r.junk, `${r.junkRate}%`, r.qualified, `${r.conversionRate}%`, fmtMoney(r.revenue), fmtMoney(r.revenuePerLead)]);
    rows.push([]);
    rows.push(["TOTAL", result.totals.leads, result.totals.junk, "", result.totals.qualified, "", fmtMoney(result.totals.revenue), ""]);
    sendCsv(res, "attribution", result.window, rowsToCsv(headers, rows));
  } catch (e) {
    console.error("[reports] attribution.csv:", e.message);
    res.status(500).json({ error: "Failed to export attribution CSV" });
  }
});

router.get("/reports/attribution.pdf", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const result = await computeAttribution(req);
    if (result.error) return res.status(result.error.status).json(result.error);
    const clinic = await primaryClinic(req.user.tenantId);
    const columns = ["Source", "Leads", "Junk", "Junk %", "Qualified", "Conv %", "Revenue", "Rev / Lead"];
    const rows = result.rows.map((r) => [r.source, r.leads, r.junk, `${r.junkRate}%`, r.qualified, `${r.conversionRate}%`, fmtMoney(r.revenue), fmtMoney(r.revenuePerLead)]);
    rows.push(["TOTAL", result.totals.leads, result.totals.junk, "", result.totals.qualified, "", fmtMoney(result.totals.revenue), ""]);
    const buf = await renderReportPdf("Marketing Attribution", columns, rows, result.window, clinic);
    sendPdf(res, "attribution", result.window, buf);
  } catch (e) {
    console.error("[reports] attribution.pdf:", e.message);
    res.status(500).json({ error: "Failed to export attribution PDF" });
  }
});

// ── Owner dashboard aggregation ────────────────────────────────────

// #207/#216: the Owner Dashboard data endpoint exposes org-wide P&L,
// pending-approvals counts, revenue trend, and recommendations. A doctor
// or telecaller hitting this directly (or via stale frontend cache) sees
// the full clinic financials. Lock to admin/manager.
router.get("/dashboard", verifyWellnessRole(["admin", "manager"]), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const locationId = req.query.locationId ? parseInt(req.query.locationId) : undefined;
    const todayStart = startOfDay();
    const todayEnd = endOfDay();
    const yesterdayStart = startOfDay(new Date(Date.now() - 86400000));
    const yesterdayEnd = endOfDay(new Date(Date.now() - 86400000));
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    // PRD §6.8 — no-show risk: window of upcoming booked visits in next 24h.
    const next24hStart = new Date();
    const next24hEnd = new Date(Date.now() + 24 * 3600 * 1000);

    const visitWhere = (extra = {}) => ({ tenantId, ...(locationId ? { locationId } : {}), ...extra });

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
        select: { id: true, status: true, amountCharged: true, serviceId: true },
      }),
      prisma.visit.findMany({
        where: visitWhere({ visitDate: { gte: yesterdayStart, lte: yesterdayEnd } }),
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
        const baseWhere = { tenantId, status: "Lead", createdAt: { gte: todayStart, lte: todayEnd } };
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
        return prisma.contact.count({ where: { ...baseWhere, OR: orClauses } });
      })(),
      prisma.visit.findMany({
        where: visitWhere({ visitDate: { gte: thirtyDaysAgo } }),
        select: { visitDate: true, amountCharged: true },
      }),
      prisma.patient.count({ where: { tenantId, ...(locationId ? { locationId } : {}) } }),
      prisma.service.count({ where: { tenantId, isActive: true } }),
      prisma.location.count({ where: { tenantId, isActive: true } }),
      // PRD §6.8 — upcoming booked visits in the next 24h, with patient
      // context needed to score no-show risk (past no-shows, first-visit,
      // engagement signals, reminder confirmation).
      prisma.visit.findMany({
        where: visitWhere({ status: "booked", visitDate: { gte: next24hStart, lte: next24hEnd } }),
        orderBy: { visitDate: "asc" },
        select: {
          id: true, visitDate: true, patientId: true,
          patient: { select: { id: true, name: true, phone: true, createdAt: true } },
        },
      }),
    ]);

    const sum = (arr, k) => arr.reduce((s, x) => s + (parseFloat(x[k]) || 0), 0);

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
      if (key in dayBuckets) dayBuckets[key] += parseFloat(v.amountCharged) || 0;
    }
    // #181: round to 2 decimals — float accumulation on amountCharged was producing
    // 14-digit fractional rupees in the dashboard chart axis labels.
    const revenueTrend = Object.entries(dayBuckets).map(([date, revenue]) => ({ date, revenue: Math.round(revenue * 100) / 100 }));

    // Rough occupancy: today's "filled" slots / capacity. #289 fix:
    // Previously this counted ONLY status=completed visits, which meant a
    // clinic that had a full booked day showed Occupancy 0% until each
    // visit was clinically closed at end-of-day. That's the opposite of
    // what an Owner expects — they want to know what's on the books NOW.
    // Count booked + completed + arrived/in-progress visits as filled.
    const filledStatuses = new Set(["booked", "completed", "arrived", "in-progress", "checked-in"]);
    const filledToday = todayVisits.filter((v) => filledStatuses.has(v.status)).length;
    const completedToday = todayVisits.filter((v) => v.status === "completed").length;
    const capacity = 8 * 17; // 17 staff × 8 slots — generous baseline
    const occupancyPct = Math.min(100, Math.round((filledToday / capacity) * 100));

    // ── PRD §6.8: No-show risk scorer ────────────────────────────────
    // Rule-based, no ML. Score 0–100 per upcoming booked visit; aggregate
    // count of visits scoring ≥40 and surface top 5.
    const patientIds = upcomingVisits.map((v) => v.patientId);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000);
    const thirtyDaysAgoLoyalty = new Date(Date.now() - 30 * 86400000);
    const noShowRisk = { count: 0, totalUpcoming: upcomingVisits.length, topRisks: [] };
    if (upcomingVisits.length > 0) {
      const [pastNoShows, anyVisits, smsSent, loyaltyRecent] = await Promise.all([
        // +30: any past no-show in last 90d
        prisma.visit.findMany({
          where: { tenantId, status: "no-show", patientId: { in: patientIds }, visitDate: { gte: ninetyDaysAgo } },
          select: { patientId: true },
        }),
        // +15 if first-visit (no prior visit at all) — pull all visit ids per patient
        prisma.visit.findMany({
          where: { tenantId, patientId: { in: patientIds }, id: { notIn: upcomingVisits.map((v) => v.id) } },
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
            to: { in: upcomingVisits.map((v) => v.patient?.phone).filter(Boolean) },
            OR: [{ body: { contains: "reminder" } }, { body: { contains: "appointment" } }],
          },
          select: { to: true },
        }),
        // −10 if patient has a LoyaltyTransaction in last 30d (engaged)
        prisma.loyaltyTransaction.findMany({
          where: { tenantId, patientId: { in: patientIds }, createdAt: { gte: thirtyDaysAgoLoyalty } },
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
        const istHour = new Date(v.visitDate.getTime() + 5.5 * 3600 * 1000).getUTCHours();
        const hoursOut = (v.visitDate.getTime() - Date.now()) / 3600000;
        let score = 0;
        if (noShowSet.has(v.patientId)) score += 30;
        // Only penalise missing-reminder if the visit is already in the
        // reminder window (T-24h to T-1h). Outside that window it's
        // expected behaviour, not a risk signal.
        if (hoursOut <= 24 && hoursOut >= 1 && !remindedPhones.has(v.patient?.phone)) score += 20;
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
        expectedRevenue: sum(todayVisits, "amountCharged"),
        occupancyPct,
        newLeads: newLeadsToday,
        noShowRisk,
      },
      yesterday: {
        visits: yesterdayVisits.length,
        completed: yesterdayVisits.filter((v) => v.status === "completed").length,
        revenue: sum(yesterdayVisits, "amountCharged"),
      },
      pendingApprovals: pendingRecommendations.length,
      pendingRecommendations,
      activeTreatmentPlans,
      revenueTrend,
      totals: { patients: totalPatients, services: totalServices, locations: totalLocations },
    });
  } catch (e) {
    console.error("[wellness] dashboard error:", e.message);
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});

// ── Public booking endpoints (no auth) ─────────────────────────────
// Mounted at /api/wellness/public/* in server.js after these routes get split out.
// These specific 3 endpoints are added to the open paths list so they bypass
// the JWT guard.

router.get("/public/tenant/:slug", async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: req.params.slug },
      select: { id: true, name: true, slug: true, vertical: true, country: true, defaultCurrency: true, locale: true },
    });
    if (!tenant || tenant.vertical !== "wellness") return res.status(404).json({ error: "Clinic not found" });

    const [services, allLocations] = await Promise.all([
      prisma.service.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: { id: true, name: true, category: true, basePrice: true, durationMin: true, description: true, ticketTier: true },
        orderBy: [{ category: "asc" }, { name: "asc" }],
      }),
      prisma.location.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: { id: true, name: true, addressLine: true, city: true, state: true, pincode: true, phone: true, hours: true },
      }),
    ]);
    // #291: never expose internal/dev location names ("smoke-test", "e2e-…",
    // "test-…", "qa-…") on the customer-facing booking page. The seed and
    // E2E test suites both create such rows, and they leak into the public
    // /book/<slug> step 2 (Pick a clinic) and step 3 (order summary).
    const INTERNAL_LOCATION_NAME_RE = /^(smoke-test|e2e[-_ ]|test[-_ ]|qa[-_ ]|dev[-_ ])/i;
    const locations = allLocations.filter((l) => !INTERNAL_LOCATION_NAME_RE.test(String(l.name || "").trim()));
    res.json({ tenant, services, locations });
  } catch (e) {
    res.status(500).json({ error: "Failed to load clinic profile" });
  }
});

router.post("/public/book", async (req, res) => {
  try {
    const { tenantSlug, serviceId, locationId, name, phone, email, preferredSlot, notes } = req.body;
    if (!tenantSlug || !serviceId || !name || !phone) {
      return res.status(400).json({ error: "tenantSlug, serviceId, name, phone required" });
    }
    // #219: validation gates on the public endpoint. Anyone on the internet
    // can hit this; the only thing keeping the DB clean is what we check here.
    // Rate limiting (per-IP) is tracked separately as a cross-cutting middleware
    // change — see TODOS.md.
    const trimmedName = String(name).trim();
    if (trimmedName.length < 2 || trimmedName.length > 100) {
      return res.status(400).json({ error: "name must be 2–100 characters", code: "INVALID_NAME" });
    }
    const phoneStr = String(phone).trim();
    // Indian mobile: 10 digits starting 6/7/8/9, optionally with +91 / 91 prefix.
    // Reject letters, short numbers, foreign formats — those are the spam vectors.
    if (!/^(\+?91)?[6-9]\d{9}$/.test(phoneStr.replace(/[\s-]/g, ""))) {
      return res.status(400).json({ error: "phone must be a 10-digit Indian mobile (starts 6/7/8/9, optional +91)", code: "INVALID_PHONE" });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      return res.status(400).json({ error: "email is not a valid format", code: "INVALID_EMAIL" });
    }
    if (preferredSlot) {
      const slot = new Date(preferredSlot);
      if (Number.isNaN(slot.getTime())) {
        return res.status(400).json({ error: "preferredSlot is not a valid date", code: "INVALID_SLOT" });
      }
      const now = new Date();
      const ninetyDays = new Date(now.getTime() + 90 * 24 * 3600000);
      if (slot < now) {
        return res.status(400).json({ error: "preferredSlot must be in the future", code: "SLOT_IN_PAST" });
      }
      if (slot > ninetyDays) {
        return res.status(400).json({ error: "preferredSlot cannot be more than 90 days out", code: "SLOT_TOO_FAR" });
      }
    }
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || tenant.vertical !== "wellness") return res.status(404).json({ error: "Clinic not found" });
    const parsedServiceId = parseInt(serviceId);
    if (!Number.isFinite(parsedServiceId)) return res.status(400).json({ error: "Invalid service", code: "INVALID_SERVICE" });
    const service = await prisma.service.findFirst({ where: { id: parsedServiceId, tenantId: tenant.id } });
    if (!service) return res.status(400).json({ error: "Invalid service", code: "INVALID_SERVICE" });

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
    const reqLocationId = locationId !== undefined && locationId !== null && locationId !== ""
      ? parseInt(locationId)
      : null;
    if (reqLocationId !== null && !Number.isFinite(reqLocationId)) {
      return res.status(400).json({ error: "locationId must be numeric", code: "INVALID_LOCATION" });
    }
    let resolvedLocationId = reqLocationId;
    if (resolvedLocationId === null) {
      const fallback = await prisma.location.findFirst({ where: { tenantId: tenant.id, isActive: true }, orderBy: { id: "asc" } });
      resolvedLocationId = fallback?.id || null;
    } else {
      // Scope-check: the location must belong to this tenant.
      const exists = await prisma.location.findFirst({ where: { id: resolvedLocationId, tenantId: tenant.id } });
      if (!exists) return res.status(400).json({ error: "Invalid location", code: "INVALID_LOCATION" });
    }

    const result = await prisma.$transaction(async (tx) => {
      let patient = await tx.patient.findFirst({
        where: { tenantId: tenant.id, phone: { contains: last10 } },
      });
      if (!patient) {
        patient = await tx.patient.create({
          data: {
            name: trimmedName, phone: phoneStr, email: email ? String(email).trim() : null,
            source: "public-booking",
            tenantId: tenant.id,
            locationId: resolvedLocationId,
          },
        });
      }
      const visit = await tx.visit.create({
        data: {
          visitDate: preferredSlot ? new Date(preferredSlot) : new Date(Date.now() + 24 * 3600000),
          status: "booked",
          notes: notes || null,
          patientId: patient.id,
          serviceId: service.id,
          locationId: resolvedLocationId,
          amountCharged: service.basePrice,
          tenantId: tenant.id,
        },
      });
      return { patient, visit };
    });

    res.status(201).json({ ok: true, visit: result.visit, patient: { id: result.patient.id, name: result.patient.name } });
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
  return prisma.location.findFirst({ where: { tenantId }, orderBy: { id: "asc" } });
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
    const doctor = rx.doctor || (req.user?.name ? { name: req.user.name } : null);
    const buf = await renderPrescriptionPdf(rx, rx.patient, clinic, doctor);
    // PRD §11: PDF export of an Rx is a downloadable PHI artefact; the audit
    // row is what proves "who pulled this drug list and when". IDs only —
    // never the drug names (those live in the Prescription row itself).
    try {
      await writeAudit('Prescription', 'PRESCRIPTION_PDF_DOWNLOAD', rx.id, req.user.userId, req.user.tenantId, {
        prescriptionId: rx.id,
        visitId: rx.visitId,
        patientId: rx.patientId,
      });
    } catch (auditErr) {
      console.warn("[wellness] audit PRESCRIPTION_PDF_DOWNLOAD failed:", auditErr.message);
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="rx-${id}.pdf"`);
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (e) {
    console.error("[wellness] prescription pdf error:", e.message);
    res.status(500).json({ error: "Failed to render prescription PDF" });
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
    const clinic = await primaryClinic(req.user.tenantId);
    const buf = await renderConsentPdf(
      consent,
      consent.patient,
      consent.service,
      clinic,
      consent.signatureSvg,
    );
    // PRD §11: consent PDF export carries patient PII + signature image; log it.
    try {
      await writeAudit('ConsentForm', 'CONSENT_PDF_DOWNLOAD', consent.id, req.user.userId, req.user.tenantId, {
        consentId: consent.id,
        patientId: consent.patientId,
        serviceId: consent.serviceId,
        templateName: consent.templateName,
      });
    } catch (auditErr) {
      console.warn("[wellness] audit CONSENT_PDF_DOWNLOAD failed:", auditErr.message);
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="consent-${id}.pdf"`);
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (e) {
    console.error("[wellness] consent pdf error:", e.message);
    res.status(500).json({ error: "Failed to render consent PDF" });
  }
});

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
router.get("/telecaller/queue", verifyWellnessRole(["telecaller", "admin", "manager"]), async (req, res) => {
  try {
    const leads = await prisma.contact.findMany({
      where: tenantWhere(req, {
        assignedToId: req.user.id,
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
    res.json({ leads, count: leads.length });
  } catch (e) {
    console.error("[wellness] telecaller queue error:", e.message);
    res.status(500).json({ error: "Failed to load telecaller queue" });
  }
});

router.post("/telecaller/dispose", verifyWellnessRole(["telecaller", "admin", "manager"]), async (req, res) => {
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
        userId: req.user.id,
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
});

// ── Patient portal (public login + patient-JWT reads) ─────────────

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
    await prisma.patientOtp.update({ where: { id: otpRecord.id }, data: { used: true } });

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
        'Patient',
        'PATIENT_DETAIL_READ',
        patient.id,
        null,
        patient.tenantId,
        { patientId: patient.id, name: patient.name, accessedFields, source: 'portal' },
        { actorType: 'patient', patientId: patient.id }
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

router.get("/portal/visits", verifyPatientToken, async (req, res) => {
  try {
    const visits = await prisma.visit.findMany({
      where: { patientId: req.patient.id },
      orderBy: { visitDate: "desc" },
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
          'Visit',
          'PATIENT_LIST_READ',
          null,
          null,
          tenantId,
          { count: visits.length, source: 'portal/visits', patientId: req.patient.id },
          { actorType: 'patient', patientId: req.patient.id }
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

router.get("/portal/prescriptions", verifyPatientToken, async (req, res) => {
  try {
    const prescriptions = await prisma.prescription.findMany({
      where: { patientId: req.patient.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        visit: {
          select: { id: true, visitDate: true, service: { select: { name: true } } },
        },
        doctor: { select: { id: true, name: true } },
      },
    });
    // PRD §11: patient-portal list read of own Rx. ONE row per request.
    try {
      const tenantId = prescriptions.length ? prescriptions[0].tenantId : null;
      if (tenantId) {
        await writeAudit(
          'Prescription',
          'PATIENT_LIST_READ',
          null,
          null,
          tenantId,
          { count: prescriptions.length, source: 'portal/prescriptions', patientId: req.patient.id },
          { actorType: 'patient', patientId: req.patient.id }
        );
      }
    } catch (auditErr) {
      console.warn("[wellness] audit portal/prescriptions failed:", auditErr.message);
    }
    res.json(prescriptions);
  } catch (e) {
    console.error("[wellness] portal prescriptions error:", e.message);
    res.status(500).json({ error: "Failed to load prescriptions" });
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
    res.setHeader("Content-Disposition", `inline; filename="invoice-${id}.pdf"`);
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (e) {
    console.error("[wellness] branded invoice pdf error:", e.message);
    res.status(500).json({ error: "Failed to render invoice PDF" });
  }
});

// ── Agent C: White-label branding (logo + brand color) ─────────────
//
// Logos stored under uploads/branding/tenant-<id>/logo.<ext>.
// Limit: 2 MB, common image types only. ADMIN only for mutations; GET is
// readable by any authenticated tenant user (sidebar + login flows).

const brandingLogoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(
        __dirname, "..", "uploads", "branding", `tenant-${req.user.tenantId}`
      );
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".png")
        .toLowerCase()
        .replace(/[^.a-z0-9]/g, "");
      cb(null, `logo${ext || ".png"}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/i.test(file.mimetype || "");
    if (!ok) return cb(new Error("Logo must be an image (png/jpg/gif/webp/svg)"));
    cb(null, true);
  },
});

function requireTenantAdmin(req, res, next) {
  if (!req.user || req.user.role !== "ADMIN") {
    return res.status(403).json({ error: "Tenant ADMIN required" });
  }
  next();
}

router.post(
  "/branding/logo",
  requireTenantAdmin,
  (req, res, next) => {
    brandingLogoUpload.single("logo")(req, res, (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE"
          ? "Logo file too large (max 2 MB)"
          : (err.message || "Logo upload failed");
        return res.status(400).json({ error: msg });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No logo file provided (field 'logo')" });
      const logoUrl = `/uploads/branding/tenant-${req.user.tenantId}/${path.basename(req.file.path)}`;
      await prisma.tenant.update({
        where: { id: req.user.tenantId },
        data: { logoUrl },
      });
      res.json({ logoUrl });
    } catch (e) {
      console.error("[wellness] branding logo error:", e.message);
      res.status(500).json({ error: "Failed to save logo" });
    }
  }
);

router.put("/branding/color", requireTenantAdmin, async (req, res) => {
  try {
    const { brandColor } = req.body || {};
    if (brandColor !== null && brandColor !== "" && !/^#[0-9a-fA-F]{6}$/.test(brandColor || "")) {
      return res.status(400).json({ error: "brandColor must be a 6-digit hex like #265855" });
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

router.get("/branding", async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { logoUrl: true, brandColor: true, name: true, defaultCurrency: true },
    });
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });
    res.json(tenant);
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
  return res.status(403).json({ error: "Manager or admin role required" });
}

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
          createdAt: { gte: startOfDay(new Date(new Date().getFullYear(), new Date().getMonth(), 1)) },
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

router.post("/loyalty/:patientId/credit", requireManagerPlus, async (req, res) => {
  try {
    const patientId = parseInt(req.params.patientId, 10);
    if (Number.isNaN(patientId)) {
      return res.status(400).json({ error: "patientId must be an integer" });
    }
    const points = parseInt(req.body.points, 10);
    const reason = req.body.reason || "Manual credit";
    if (Number.isNaN(points) || points <= 0) {
      return res.status(400).json({ error: "points must be a positive integer" });
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
    await writeAudit('Patient', 'CREDIT_LOYALTY', patientId, req.user.userId, req.user.tenantId, {
      transactionId: tx.id,
      points,
      reason,
    });
    res.status(201).json(tx);
  } catch (e) {
    console.error("[wellness] loyalty credit error:", e.message);
    res.status(500).json({ error: "Failed to credit loyalty" });
  }
});

router.post("/loyalty/:patientId/redeem", async (req, res) => {
  try {
    const patientId = parseInt(req.params.patientId, 10);
    if (Number.isNaN(patientId)) {
      return res.status(400).json({ error: "patientId must be an integer" });
    }
    const points = parseInt(req.body.points, 10);
    const reason = req.body.reason || "Redemption";
    if (Number.isNaN(points) || points <= 0) {
      return res.status(400).json({ error: "points must be a positive integer" });
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
    await writeAudit('Patient', 'REDEEM_LOYALTY', patientId, req.user.userId, req.user.tenantId, {
      transactionId: tx.id,
      points,
      reason,
      balanceBefore: balance,
      balanceAfter: balance - points,
    });
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
    const { referrerPatientId, referredName, referredPhone, referredEmail } = req.body;
    if (!referrerPatientId || !referredName || !referredPhone) {
      return res.status(400).json({
        error: "referrerPatientId, referredName, and referredPhone are required",
      });
    }
    const referrer = await prisma.patient.findFirst({
      where: tenantWhere(req, { id: parseInt(referrerPatientId, 10) }),
      select: { id: true },
    });
    if (!referrer) return res.status(404).json({ error: "Referrer not found in tenant" });

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
      return res.status(400).json({ error: "rewardPoints must be a positive integer" });
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
router.get("/loyalty/leaderboard/month", requireManagerPlus, async (req, res) => {
  try {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const grouped = await prisma.loyaltyTransaction.groupBy({
      by: ["patientId"],
      where: {
        tenantId: req.user.tenantId,
        points: { gt: 0 },
        createdAt: { gte: monthStart },
      },
      _sum: { points: true },
      orderBy: { _sum: { points: "desc" } },
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
});

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
    const { patientId, serviceId, locationId, preferredDateRange, notes } = req.body || {};
    if (!patientId) return res.status(400).json({ error: "patientId is required" });

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
    const existing = await prisma.waitlist.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Waitlist entry not found" });

    const data = {};
    const allowed = ["status", "notes", "preferredDateRange"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];
    if (req.body.expiresAt !== undefined) {
      data.expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
    }
    if (req.body.offeredAt !== undefined) {
      data.offeredAt = req.body.offeredAt ? new Date(req.body.offeredAt) : null;
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
    if (newStatus === "offered" && !existing.offeredAt && data.offeredAt === undefined) {
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
      const candidate = req.body.visitDate || req.body.preferredSlot || existing.preferredDateRange;
      if (candidate) {
        const parsed = new Date(candidate);
        if (!Number.isNaN(parsed.getTime())) slot = parsed;
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
          notes: existing.notes ? `From waitlist #${existing.id}: ${existing.notes}` : `From waitlist #${existing.id}`,
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
    const existing = await prisma.waitlist.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Waitlist entry not found" });
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
const portalRequestOtpPhoneLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
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
  message: { error: "Too many OTP requests for this number. Try again in 10 minutes." },
});

const portalRequestOtpIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKeyGenerator(req, res),
  message: { error: "Too many OTP requests from this network. Try again later." },
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

    let generatedOtp = null;
    if (patient) {
      const otp = String(Math.floor(1000 + Math.random() * 9000)); // 4-digit
      generatedOtp = otp;
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
});

router.post("/portal/login/verify-otp", async (req, res) => {
  try {
    const { phone, otp } = req.body || {};
    if (!phone || !otp) return res.status(400).json({ error: "phone and otp are required" });
    if (!/^\d{4}$/.test(String(otp))) {
      return res.status(400).json({ error: "OTP must be 4 digits" });
    }
    const digits = String(phone).replace(/\D/g, "");
    if (digits.length < 10) return res.status(400).json({ error: "Invalid phone" });
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
    const demoOtpAllowedInProd = process.env.WELLNESS_DEMO_OTP_ALLOW_PROD === "1";
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
      await prisma.patientOtp.update({ where: { id: record.id }, data: { used: true } });
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

module.exports = router;
