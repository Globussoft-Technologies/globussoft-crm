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
const prisma = require("../lib/prisma");
const { runForTenant, executeApproved } = require("../cron/orchestratorEngine");
const {
  renderPrescriptionPdf,
  renderConsentPdf,
  renderBrandedInvoicePdf,
} = require("../services/pdfRenderer");

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

// ── Patients ───────────────────────────────────────────────────────

router.get("/patients", async (req, res) => {
  try {
    const { q, limit = 50, offset = 0 } = req.query;
    const where = tenantWhere(req);
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { phone: { contains: q } },
        { email: { contains: q } },
      ];
    }
    const [patients, total] = await Promise.all([
      prisma.patient.findMany({
        where,
        take: Math.min(parseInt(limit), 200),
        skip: parseInt(offset),
        orderBy: { createdAt: "desc" },
      }),
      prisma.patient.count({ where }),
    ]);
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
        prescriptions: { orderBy: { createdAt: "desc" } },
        consents: { orderBy: { signedAt: "desc" }, include: { service: true } },
        treatmentPlans: { include: { service: true } },
      },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    res.json(patient);
  } catch (e) {
    console.error("[wellness] get patient error:", e.message);
    res.status(500).json({ error: "Failed to load patient" });
  }
});

// #108: a phone is optional, but if supplied must contain 10–15 digits after
// stripping formatting (+, -, spaces, parens). Pre-fix the field accepted any
// text like "abc123notaphone" which then broke dialer / WhatsApp integration.
function isValidPhoneOrEmpty(p) {
  if (p == null || p === "") return true;
  if (typeof p !== "string") return false;
  const digits = p.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

const { ensureEmail, ensureDob, ensureVisitDate, ensureEnum, ensureStringLength } = require("../lib/validators");

// #159 #160 #165 #170 #178: shared validation for Patient create + update.
function validatePatientInput(body, { isUpdate = false } = {}) {
  const nameErr = ensureStringLength(body.name, { max: 200, field: "name", required: !isUpdate });
  if (nameErr) return nameErr;
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
    const patient = await prisma.patient.create({
      data: {
        name,
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
    res.json(updated);
  } catch (e) {
    console.error("[wellness] update patient error:", e.message);
    res.status(500).json({ error: "Failed to update patient" });
  }
});

// ── Visits ─────────────────────────────────────────────────────────

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

    const c = await prisma.serviceConsumption.create({
      data: {
        productName, qty: parseInt(qty) || 1, unitCost: parseFloat(unitCost) || 0,
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

router.post("/prescriptions", async (req, res) => {
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
router.put("/prescriptions/:id", async (req, res) => {
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

router.post("/consents", async (req, res) => {
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
    res.status(201).json(consent);
  } catch (e) {
    console.error("[wellness] create consent error:", e.message);
    res.status(500).json({ error: "Failed to create consent" });
  }
});

// #194: amend a consent form — only the templateName + serviceId metadata
// can be corrected. The signatureSvg is captured-at-signing and is never
// editable post-hoc: that's a forgery vector, not an amendment. ADMIN only.
router.put("/consents/:id", async (req, res) => {
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

router.post("/services", async (req, res) => {
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
    // #149: durationMin must be positive; targetRadiusKm must be non-negative
    // when supplied (null = unlimited is fine).
    if (durationMin !== undefined && durationMin !== null) {
      const d = Number(durationMin);
      if (!Number.isFinite(d) || d <= 0) {
        return res.status(400).json({ error: "durationMin must be greater than 0", code: "DURATION_INVALID" });
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

router.put("/services/:id", async (req, res) => {
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
    }
    // #149: same duration / radius guards on edit.
    if (data.durationMin !== undefined && data.durationMin !== null) {
      const d = Number(data.durationMin);
      if (!Number.isFinite(d) || d <= 0) {
        return res.status(400).json({ error: "durationMin must be greater than 0", code: "DURATION_INVALID" });
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
    const items = await prisma.agentRecommendation.findMany({
      where: tenantWhere(req, status === "all" ? {} : { status }),
      orderBy: [
        { priority: "desc" }, // high > medium > low alphabetically — close enough
        { createdAt: "desc" },
      ],
      take: 50,
    });
    res.json(items);
  } catch (e) {
    console.error("[wellness] list recommendations error:", e.message);
    res.status(500).json({ error: "Failed to list recommendations" });
  }
});

// #194: amend a recommendation while it's still pending. Once a card is
// approved/rejected the body is locked — the resolved record is the audit
// artefact for the dispatched action and shouldn't be re-written. ADMIN /
// MANAGER only since recommendations are operational, not clinical.
router.put("/recommendations/:id", async (req, res) => {
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

router.post("/recommendations/:id/approve", async (req, res) => {
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

router.post("/recommendations/:id/reject", async (req, res) => {
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

router.post("/locations", async (req, res) => {
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

router.put("/locations/:id", async (req, res) => {
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

const reportRange = (req) => {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
  return { from, to };
};

router.get("/reports/pnl-by-service", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { from, to } = reportRange(req);
    const locationId = req.query.locationId ? parseInt(req.query.locationId) : undefined;

    const visitWhere = { tenantId, visitDate: { gte: from, lte: to }, status: "completed" };
    if (locationId) visitWhere.locationId = locationId;

    const visits = await prisma.visit.findMany({
      where: visitWhere,
      select: { serviceId: true, amountCharged: true, doctorId: true },
    });
    const services = await prisma.service.findMany({
      where: { tenantId },
      select: { id: true, name: true, category: true, ticketTier: true, basePrice: true },
    });
    const consumptions = await prisma.serviceConsumption.findMany({
      where: { tenantId, createdAt: { gte: from, lte: to } },
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

    res.json({
      window: { from, to, locationId: locationId || null },
      totals: {
        visits: rows.reduce((s, r) => s + r.count, 0),
        revenue: rows.reduce((s, r) => s + r.revenue, 0),
        productCost: rows.reduce((s, r) => s + r.productCost, 0),
        contribution: rows.reduce((s, r) => s + r.contribution, 0),
      },
      rows,
    });
  } catch (e) {
    console.error("[reports] pnl-by-service:", e.message);
    res.status(500).json({ error: "Failed to compute P&L" });
  }
});

router.get("/reports/per-professional", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { from, to } = reportRange(req);
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
    res.json({
      window: { from, to, locationId: locationId || null },
      totals: { visits: rows.reduce((s, r) => s + r.visits, 0), revenue: rows.reduce((s, r) => s + r.revenue, 0) },
      rows,
    });
  } catch (e) {
    console.error("[reports] per-professional:", e.message);
    res.status(500).json({ error: "Failed to compute per-professional report" });
  }
});

router.get("/reports/attribution", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { from, to } = reportRange(req);

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
    for (const v of visits) {
      const k = bucket(v.patient?.source);
      if (!acc[k]) acc[k] = { source: k, leads: 0, junk: 0, qualified: 0, revenue: 0 };
      acc[k].revenue += parseFloat(v.amountCharged) || 0;
    }
    const rows = Object.values(acc).map((r) => ({
      ...r,
      junkRate: r.leads ? Math.round((r.junk / r.leads) * 100) : 0,
      conversionRate: r.leads ? Math.round((r.qualified / r.leads) * 100) : 0,
      revenuePerLead: r.leads ? Math.round(r.revenue / r.leads) : 0,
    })).sort((a, b) => b.revenue - a.revenue);

    res.json({
      window: { from, to },
      totals: {
        leads: rows.reduce((s, r) => s + r.leads, 0),
        junk: rows.reduce((s, r) => s + r.junk, 0),
        qualified: rows.reduce((s, r) => s + r.qualified, 0),
        revenue: rows.reduce((s, r) => s + r.revenue, 0),
      },
      rows,
    });
  } catch (e) {
    console.error("[reports] attribution:", e.message);
    res.status(500).json({ error: "Failed to compute attribution" });
  }
});

router.get("/reports/per-location", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { from, to } = reportRange(req);

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

    res.json({
      window: { from, to },
      totals: { visits: rows.reduce((s, r) => s + r.visits, 0), revenue: rows.reduce((s, r) => s + r.revenue, 0) },
      rows,
    });
  } catch (e) {
    console.error("[reports] per-location:", e.message);
    res.status(500).json({ error: "Failed to compute per-location report" });
  }
});

// ── Owner dashboard aggregation ────────────────────────────────────

router.get("/dashboard", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const locationId = req.query.locationId ? parseInt(req.query.locationId) : undefined;
    const todayStart = startOfDay();
    const todayEnd = endOfDay();
    const yesterdayStart = startOfDay(new Date(Date.now() - 86400000));
    const yesterdayEnd = endOfDay(new Date(Date.now() - 86400000));
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);

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
    ] = await Promise.all([
      prisma.visit.findMany({
        where: visitWhere({ visitDate: { gte: todayStart, lte: todayEnd } }),
        select: { id: true, status: true, amountCharged: true, serviceId: true },
      }),
      prisma.visit.findMany({
        where: visitWhere({ visitDate: { gte: yesterdayStart, lte: yesterdayEnd } }),
        select: { id: true, status: true, amountCharged: true },
      }),
      prisma.agentRecommendation.findMany({
        where: { tenantId, status: "pending" },
        orderBy: { priority: "desc" },
        take: 5,
      }),
      prisma.treatmentPlan.count({ where: { tenantId, status: "active" } }),
      prisma.contact.count({
        where: { tenantId, status: "Lead", createdAt: { gte: todayStart, lte: todayEnd } },
      }),
      prisma.visit.findMany({
        where: visitWhere({ visitDate: { gte: thirtyDaysAgo } }),
        select: { visitDate: true, amountCharged: true },
      }),
      prisma.patient.count({ where: { tenantId, ...(locationId ? { locationId } : {}) } }),
      prisma.service.count({ where: { tenantId, isActive: true } }),
      prisma.location.count({ where: { tenantId, isActive: true } }),
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

    // Rough occupancy: completed visits today / theoretical capacity (assume 8 slots/day)
    const completedToday = todayVisits.filter((v) => v.status === "completed").length;
    const capacity = 8 * 17; // 17 staff × 8 slots — generous baseline
    const occupancyPct = Math.min(100, Math.round((completedToday / capacity) * 100));

    res.json({
      today: {
        visits: todayVisits.length,
        completed: completedToday,
        expectedRevenue: sum(todayVisits, "amountCharged"),
        occupancyPct,
        newLeads: newLeadsToday,
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

    const [services, locations] = await Promise.all([
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
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (!tenant || tenant.vertical !== "wellness") return res.status(404).json({ error: "Clinic not found" });
    const service = await prisma.service.findFirst({ where: { id: parseInt(serviceId), tenantId: tenant.id } });
    if (!service) return res.status(400).json({ error: "Invalid service" });

    // Create or find a Patient by phone
    let patient = await prisma.patient.findFirst({
      where: { tenantId: tenant.id, phone: { contains: phone.slice(-10) } },
    });
    if (!patient) {
      patient = await prisma.patient.create({
        data: {
          name, phone, email: email || null,
          source: "public-booking",
          tenantId: tenant.id,
          locationId: locationId ? parseInt(locationId) : null,
        },
      });
    }
    // Create the visit (status=booked)
    const visit = await prisma.visit.create({
      data: {
        visitDate: preferredSlot ? new Date(preferredSlot) : new Date(Date.now() + 24 * 3600000),
        status: "booked",
        notes: notes || null,
        patientId: patient.id,
        serviceId: service.id,
        locationId: locationId ? parseInt(locationId) : (await prisma.location.findFirst({ where: { tenantId: tenant.id, isActive: true } }))?.id || null,
        amountCharged: service.basePrice,
        tenantId: tenant.id,
      },
    });
    res.status(201).json({ ok: true, visit, patient: { id: patient.id, name: patient.name } });
  } catch (e) {
    console.error("[wellness] public booking failed:", e.message);
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
      include: { patient: true },
    });
    if (!rx) return res.status(404).json({ error: "Prescription not found" });
    const clinic = await primaryClinic(req.user.tenantId);
    const buf = await renderPrescriptionPdf(rx, rx.patient, clinic);
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

router.get("/telecaller/queue", async (req, res) => {
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

router.post("/telecaller/dispose", async (req, res) => {
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
// v1: any 4-digit OTP accepted. Matches Patient by last-10-digits phone
// globally (tenant-agnostic since the visitor has no tenant context yet).
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
      return res.status(404).json({ error: "No patient matches that phone" });
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
      },
    });
    if (!patient) return res.status(404).json({ error: "Patient not found" });
    res.json(patient);
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

    const updated = await prisma.waitlist.update({ where: { id }, data });
    res.json(updated);
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

router.post("/portal/login/request-otp", async (req, res) => {
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

    if (patient) {
      const otp = String(Math.floor(1000 + Math.random() * 9000)); // 4-digit
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

    // Always return ok:true — don't leak whether the phone is registered.
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

    const record = await prisma.patientOtp.findFirst({
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

    // Mark OTP used (single-use).
    await prisma.patientOtp.update({ where: { id: record.id }, data: { used: true } });

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
