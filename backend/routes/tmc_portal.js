const express = require("express");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const router = express.Router();
const prisma = require("../lib/prisma");
const { JWT_SECRET } = require("../config/secrets");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requireAnyPermission } = require("../middleware/requirePermission");
const { requireTravelTenant } = require("../middleware/travelGuards");
const { sanitizeText } = require("../lib/sanitizeJson");
const { getFrontendUrlFromRequest } = require("../lib/requestOrigin");
const { notifyMany } = require("../lib/notificationService");
const { writeAudit } = require("../lib/audit");
const tmcEngine = require("../lib/tmcDiagnosticEngine");
const tmcLeadQuality = require("../lib/tmcLeadQuality");
const travelRag = require("../lib/travelRag");
const diagnosticChosenInterests = require("../lib/diagnosticChosenInterests");
const diagnosticNotifications = require("../lib/diagnosticNotifications");
const visaDocStore = require("../lib/visaDocStore");
const visaLetterStore = require("../lib/visaLetterStore");
const {
  PDF_MIME_TYPE,
  convertTmcConsentTemplateToPdf,
  pdfFilename,
} = require("../lib/tmcConsentPdf");
const {
  validateParentSubmission,
  buildParentForm,
} = require("../lib/travelReviewQuestions");
const { buildExternalReviewCta } = require("../lib/travelReviewExternal");
const {
  buildTmcParentRegistrationUrl,
  verifyTmcRegistrationToken,
  setTmcRegistrationContext,
} = require("../lib/tmcRegistrationContext");
const { requiredParentDocumentTypes } = require("../lib/travelDocumentPolicy");

const TMC_CONSENT_TEMPLATE_ASSETS = Object.freeze({
  day_trip: { filename: "day-tour-terms.pdf", sourceFile: "day-tour-terms.pdf" },
  domestic: { filename: "domestic-terms.pdf", sourceFile: "domestic-terms.pdf" },
  international: { filename: "international-terms.pdf", sourceFile: "international-terms.pdf" },
});
const TMC_CONSENT_TEMPLATE_ASSET_DIR = path.resolve(__dirname, "../assets/tmc-consent-templates");

function verifyPortalToken(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token)
    return res
      .status(401)
      .json({ error: "Portal token required", code: "PORTAL_TOKEN_REQUIRED" });
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    if (claims.type !== "PORTAL") {
      return res
        .status(401)
        .json({ error: "Invalid portal token", code: "INVALID_PORTAL_TOKEN" });
    }
    req.portal = claims;
    next();
  } catch (_err) {
    return res.status(401).json({
      error: "Invalid or expired portal token",
      code: "INVALID_PORTAL_TOKEN",
    });
  }
}

async function requireTmcTenant(req, res, next) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: Number(req.portal?.tenantId) },
      select: { id: true, vertical: true, slug: true },
    });
    if (!tenant)
      return res
        .status(404)
        .json({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });
    if (tenant.vertical !== "travel") {
      return res.status(403).json({
        error: "TMC portal requires a travel tenant",
        code: "NOT_TRAVEL_TENANT",
      });
    }
    req.tmcTenant = tenant;
    next();
  } catch (err) {
    console.error("[tmc-portal][tenant-guard]", err);
    res.status(500).json({ error: "Tenant lookup failed" });
  }
}

async function requirePortalPersona(persona, req, res, next) {
  try {
    const contact = await prisma.contact.findFirst({
      where: {
        id: Number(req.portal.contactId),
        tenantId: Number(req.portal.tenantId),
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        subBrand: true,
        portalRole: true,
      },
    });
    if (!contact)
      return res.status(404).json({
        error: "Portal profile not found",
        code: "PORTAL_CONTACT_NOT_FOUND",
      });
    if (contact.subBrand !== "tmc" || contact.portalRole !== persona) {
      return res.status(403).json({
        error: "This TMC portal is not available for this account",
        code: "TMC_PORTAL_PERSONA_REQUIRED",
      });
    }
    req.tmcContact = contact;
    next();
  } catch (err) {
    console.error("[tmc-portal][persona-guard]", err);
    res.status(500).json({ error: "Portal profile lookup failed" });
  }
}

function requireTeacher(req, res, next) {
  return requirePortalPersona("TEACHER", req, res, next);
}

function requireParent(req, res, next) {
  return requirePortalPersona("PARENT", req, res, next);
}

const TMC_PARENT_DOCUMENT_TYPES = new Set([
  "passport",
  "aadhaar",
  "consent-form",
  "visa",
]);

const TMC_PARENT_DOCUMENT_MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "application/pdf": ".pdf",
};

const tmcParentDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (TMC_PARENT_DOCUMENT_MIME_EXT[(file.mimetype || "").toLowerCase()]) {
      return cb(null, true);
    }
    return cb(new Error("UNSUPPORTED_MIME"));
  },
});

const tmcParentDocumentUploadHandler = (req, res, next) => {
  tmcParentDocumentUpload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large (max 10 MB)", code: "FILE_TOO_LARGE" });
      }
      return res.status(400).json({ error: "Upload error", code: "UPLOAD_ERROR" });
    }
    if (err) {
      return res.status(400).json({ error: "Only JPG, PNG, or PDF files are allowed", code: "UNSUPPORTED_MIME" });
    }
    return next();
  });
};

const tmcParentVisaLetterUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || "").toLowerCase() === "application/pdf") return cb(null, true);
    return cb(new Error("UNSUPPORTED_MIME"));
  },
});

const portalVisaLetterUploadHandler = (req, res, next) => {
  tmcParentVisaLetterUpload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large (max 10 MB)", code: "FILE_TOO_LARGE" });
      }
      return res.status(400).json({ error: "Upload error", code: "UPLOAD_ERROR" });
    }
    if (err) {
      return res.status(400).json({ error: "Only PDF files are allowed", code: "UNSUPPORTED_MIME" });
    }
    return next();
  });
};

async function getParentAccessibleTripIds(req) {
  const tenantId = Number(req.portal.tenantId);
  const parentContactId = Number(req.tmcContact.id);
  const email = String(req.tmcContact.email || "").trim().toLowerCase();
  const [parentLinks, participantRows] = await Promise.all([
    prisma.tmcParentTrip.findMany({
      where: { tenantId, parentContactId },
      select: { tripId: true, teacherContactId: true },
    }),
    email
      ? prisma.tripParticipant.findMany({
          where: { parentEmail: email, trip: { tenantId } },
          select: { tripId: true, trip: { select: { teacherContactId: true } } },
        })
      : [],
  ]);
  const teacherContactIds = [
    ...new Set([
      ...parentLinks.map((row) => Number(row.teacherContactId)),
      ...participantRows.map((row) => Number(row.trip?.teacherContactId)),
    ].filter((id) => Number.isInteger(id) && id > 0)),
  ];
  const teacherTrips = teacherContactIds.length
    ? await prisma.tmcTrip.findMany({
        where: {
          tenantId,
          teacherContactId: { in: teacherContactIds },
          status: { not: "cancelled" },
        },
        select: { id: true },
      })
    : [];
  return [
    ...new Set([
      ...parentLinks.map((row) => Number(row.tripId)),
      ...participantRows.map((row) => Number(row.tripId)),
      ...teacherTrips.map((row) => Number(row.id)),
    ].filter((id) => Number.isInteger(id) && id > 0)),
  ];
}

function projectTmcParentDocument(document, trip = null) {
  return {
    id: document.id,
    documentType: document.documentType,
    filename: document.filename,
    fileSize: document.fileSize,
    mimeType: document.mimeType,
    status: document.status,
    notes: document.notes,
    uploadedAt: document.uploadedAt,
    createdAt: document.createdAt,
    tripId: document.tripId,
    trip: trip
      ? {
          id: trip.id,
          tripCode: trip.tripCode,
          destination: trip.destination,
          tripType: trip.tripType,
          departDate: trip.departDate,
          returnDate: trip.returnDate,
        }
      : null,
  };
}

const TMC_PARENT_VISA_LETTER_STATUSES = ["SENT", "SIGNED_UPLOADED"];

function projectTmcParentVisaLetter(document) {
  return {
    id: document.id,
    generationId: document.generationId,
    documentType: document.documentType,
    docType: document.documentType,
    status: document.status,
    generatedFileName: document.generatedFileName,
    signedFileName: document.signedFileName || null,
    generatedAt: document.generatedAt,
    sentAt: document.sentAt || null,
    signedUploadedAt: document.signedUploadedAt || null,
  };
}

function projectTmcParentVisaApplication(application) {
  return {
    id: application.id,
    applicationType: application.applicationType,
    destinationCountry: application.destinationCountry,
    status: application.status,
    createdAt: application.createdAt,
    trip: application.trip
      ? {
          id: application.trip.id,
          tripCode: application.trip.tripCode,
          destination: application.trip.destination,
          departDate: application.trip.departDate,
          returnDate: application.trip.returnDate,
        }
      : null,
    participant: application.participant
      ? {
          id: application.participant.id,
          fullName: application.participant.fullName,
        }
      : null,
    visaLetters: (application.visaLetterDocuments || []).map(projectTmcParentVisaLetter),
  };
}

const TMC_CONSENT_TRIP_TYPES = new Set(["day_trip", "domestic", "international"]);

function normalizeTmcConsentTripType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "day" || normalized === "day_tour") return "day_trip";
  return TMC_CONSENT_TRIP_TYPES.has(normalized) ? normalized : null;
}

function projectTmcConsentTemplate(template) {
  if (!template) return null;
  const filename = pdfFilename(template.filename);
  return {
    id: template.id,
    tripType: template.tripType,
    filename,
    mimeType: PDF_MIME_TYPE,
    fileSize: template.mimeType === PDF_MIME_TYPE ? template.fileSize : null,
  };
}

function projectTmcConsentDocument(document) {
  return document
    ? {
        id: document.id,
        filename: document.filename,
        fileSize: document.fileSize,
        mimeType: document.mimeType,
        status: document.status,
        uploadedAt: document.uploadedAt,
      }
    : null;
}

function isMissingTmcConsentTemplateStoreError(err) {
  if (!err) return false;
  // P2021 means the table is not present and P2022 means the generated
  // client/schema is out of sync with the database. Both can occur briefly
  // during a rolling demo deploy, before the Prisma sync step has completed.
  if (err.code === "P2021" || err.code === "P2022") return true;
  return /tmcConsentTemplate|TmcConsentTemplate|does not exist|unknown field/i.test(String(err.message || err));
}

function loadBundledTmcConsentTemplate(tripType) {
  const asset = TMC_CONSENT_TEMPLATE_ASSETS[tripType];
  if (!asset) return null;
  const filePath = path.join(TMC_CONSENT_TEMPLATE_ASSET_DIR, asset.sourceFile);
  if (!fs.existsSync(filePath)) return null;
  const fileBlob = fs.readFileSync(filePath);
  return {
    id: null,
    tripType,
    filename: asset.filename,
    mimeType: PDF_MIME_TYPE,
    fileSize: fileBlob.length,
    fileBlob,
  };
}

async function loadTmcConsentTemplate(tenantId, tripType) {
  if (prisma.tmcConsentTemplate && typeof prisma.tmcConsentTemplate.findUnique === "function") {
    try {
      const template = await prisma.tmcConsentTemplate.findUnique({
        where: { tenantId_tripType: { tenantId, tripType } },
      });
      if (template) return template;
    } catch (err) {
      if (!isMissingTmcConsentTemplateStoreError(err)) throw err;
      console.warn(
        `[tmc-portal] consent template store unavailable; using bundled ${tripType} terms: ${err.message || err}`,
      );
    }
  } else {
    console.warn("[tmc-portal] generated Prisma client has no tmcConsentTemplate model; using bundled terms");
  }

  // The database remains the source of truth when available. This fallback
  // keeps parent documents usable during a deploy where the new table/client
  // has not reached every demo process yet; the bundled files are the same
  // assets used by seed-tmc-consent-templates.js.
  return loadBundledTmcConsentTemplate(tripType);
}

async function loadParentConsentContext(req, tripId) {
  const accessibleTripIds = await getParentAccessibleTripIds(req);
  if (!accessibleTripIds.includes(tripId)) return null;
  const trip = await prisma.tmcTrip.findFirst({
    where: {
      id: tripId,
      tenantId: Number(req.portal.tenantId),
      status: { not: "cancelled" },
    },
    select: {
      id: true,
      tripCode: true,
      destination: true,
      tripType: true,
      departDate: true,
      returnDate: true,
    },
  });
  if (!trip) return null;
  const tripType = normalizeTmcConsentTripType(trip.tripType);
  if (!tripType) return { trip, tripType: null, template: null };
  const template = await loadTmcConsentTemplate(Number(req.portal.tenantId), tripType);
  const signedDocument = await prisma.tmcParentDocument.findFirst({
    where: {
      tenantId: Number(req.portal.tenantId),
      parentContactId: Number(req.tmcContact.id),
      tripId,
      documentType: "consent-form",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      filename: true,
      fileSize: true,
      mimeType: true,
      status: true,
      uploadedAt: true,
    },
  });
  return { trip, tripType, template, signedDocument };
}

async function loadParentVisaLetter(req, letterId) {
  const accessibleTripIds = await getParentAccessibleTripIds(req);
  if (!accessibleTripIds.length) return null;
  return prisma.visaLetterDocument.findFirst({
    where: {
      id: letterId,
      tenantId: Number(req.portal.tenantId),
      tripId: { in: accessibleTripIds },
      status: { in: TMC_PARENT_VISA_LETTER_STATUSES },
    },
  });
}

async function streamTmcParentVisaLetter(res, descriptor, fileName, { download = false } = {}) {
  const buffer = await visaLetterStore.readLetterBuffer(descriptor);
  if (!buffer) {
    return res.status(404).json({ error: "Letter file not found", code: "NOT_FOUND" });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${fileName || "visa-letter.pdf"}"`,
  );
  return res.send(buffer);
}

function parseReviewAnswers(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function parentReviewShape(review) {
  if (!review) return null;
  return {
    id: review.id,
    tmcTripId: review.tmcTripId,
    status: review.status,
    overallRating: review.overallRating,
    answers: parseReviewAnswers(review.answersJson),
    submittedAt: review.submittedAt,
  };
}

function buildTeacherReportPdfUrl(diagnostic) {
  const id = Number(diagnostic?.id);
  const token = String(diagnostic?.reportSlugToken || "").trim();
  if (!Number.isInteger(id) || id <= 0 || !/^[0-9a-f]{16}$/i.test(token)) {
    return null;
  }
  return `/api/travel/diagnostics/public/readiness-report/${id}-${token.toLowerCase()}.pdf`;
}

async function loadParentReviewTrip(req, res) {
  const tripId = Number(req.params.tripId);
  if (!Number.isInteger(tripId) || tripId <= 0) {
    res.status(400).json({
      error: "tripId must be a positive integer",
      code: "INVALID_TRIP_ID",
    });
    return null;
  }

  const email = String(req.tmcContact.email || "")
    .trim()
    .toLowerCase();
  const trip = await prisma.tmcTrip.findFirst({
    where: {
      id: tripId,
      tenantId: Number(req.portal.tenantId),
      OR: [
        {
          parentPortalLinks: {
            some: {
              tenantId: Number(req.portal.tenantId),
              parentContactId: Number(req.tmcContact.id),
            },
          },
        },
        ...(email ? [{ participants: { some: { parentEmail: email } } }] : []),
      ],
    },
    select: {
      id: true,
      tripCode: true,
      destination: true,
      tripType: true,
      departDate: true,
      returnDate: true,
      status: true,
    },
  });
  if (!trip) {
    res.status(404).json({ error: "Trip not found", code: "TRIP_NOT_FOUND" });
    return null;
  }
  if (trip.status !== "completed") {
    res.status(409).json({
      error: "Reviews are available after the trip is completed",
      code: "TRIP_NOT_COMPLETED",
    });
    return null;
  }
  return trip;
}

function buildPublishedTripUrl(landingPage) {
  if (landingPage?.status !== "PUBLISHED" || landingPage.id == null)
    return null;
  return `/trips/${encodeURIComponent(String(landingPage.id))}`;
}

function parseJson(raw, fallback) {
  if (raw && typeof raw === "object") return raw;
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function normalizeDiagnosticType(type, options = []) {
  const normalized = String(type || "single-choice")
    .trim()
    .toLowerCase();
  if (
    [
      "multi",
      "multiple",
      "multi-select",
      "multi-choice",
      "multiple-choice",
      "checkbox",
      "checkboxes",
      "select-multiple",
    ].includes(normalized)
  )
    return "multi";
  if (["group", "fieldset", "object"].includes(normalized)) return "group";
  if (
    [
      "single",
      "single-choice",
      "radio",
      "select",
      "dropdown",
      "select-one",
    ].includes(normalized)
  ) {
    return options.some((option) => option?.mappedSkill)
      ? "single-mapped"
      : "single";
  }
  if (
    [
      "text",
      "textarea",
      "email",
      "tel",
      "number",
      "date",
      "time",
      "url",
    ].includes(normalized)
  )
    return normalized;
  return options.some((option) => option?.mappedSkill)
    ? "single-mapped"
    : "single";
}

function isDiagnosticRequired(value) {
  return (
    value === true ||
    value === 1 ||
    String(value || "")
      .trim()
      .toLowerCase() === "true"
  );
}

function normalizeIdentityFieldType(type) {
  const normalized = String(type || "text")
    .trim()
    .toLowerCase();
  return ["email", "tel", "number", "date", "time", "url", "textarea"].includes(
    normalized,
  )
    ? normalized
    : "text";
}

function projectTeacherIdentityField(field) {
  return {
    id: field.id,
    label: field.label || field.id,
    helper: field.helper || null,
    type: normalizeIdentityFieldType(field.type),
    enabled: field.enabled !== false,
    required: isDiagnosticRequired(field.required),
    placeholder: field.placeholder || null,
  };
}

function buildTeacherQuestions(parsed) {
  const questions = Array.isArray(parsed?.questions)
    ? parsed.questions.slice()
    : [];
  if (
    questions.some((question) => (question.field || question.id) === "contact")
  )
    return questions;
  const identityFields = Array.isArray(parsed?.identityFields)
    ? parsed.identityFields.filter((field) => field?.enabled !== false)
    : [];
  if (!identityFields.length) return questions;
  const fieldIdMap = { name: "contact_name", email: "email", phone: "phone" };
  questions.push({
    id: "teacher_contact",
    field: "contact",
    text: "Your contact details",
    type: "group",
    required: false,
    fields: identityFields.map((field) => ({
      ...field,
      id: fieldIdMap[field.id] || field.id,
      type: normalizeIdentityFieldType(field.type),
    })),
  });
  return questions;
}

function teacherQuestionType(question) {
  return normalizeDiagnosticType(question?.type, question?.options || []);
}

function projectTeacherQuestion(question) {
  const minSelections = Number.isInteger(question.minSelections)
    ? question.minSelections
    : question.min;
  const maxSelections = Number.isInteger(question.maxSelections)
    ? question.maxSelections
    : question.max;
  return {
    id: question.id,
    field: question.field || question.id,
    text: question.text || "",
    helper: question.helper || null,
    type: teacherQuestionType(question),
    hardWall: question.hardWall === true || question.field === "contact",
    required: isDiagnosticRequired(question.required),
    min: Number.isInteger(minSelections) ? minSelections : undefined,
    max: Number.isInteger(maxSelections) ? maxSelections : undefined,
    options: Array.isArray(question.options)
      ? question.options.map((option) => ({
          value: option.value,
          label: option.label,
          mappedSkill: option.mappedSkill || undefined,
        }))
      : undefined,
    fields: Array.isArray(question.fields)
      ? question.fields.map((field) => {
          const minFieldSelections = Number.isInteger(field.minSelections)
            ? field.minSelections
            : field.min;
          const maxFieldSelections = Number.isInteger(field.maxSelections)
            ? field.maxSelections
            : field.max;
          return {
            id: field.id,
            label: field.label,
            helper: field.helper || null,
            type: normalizeDiagnosticType(field.type, field.options || []),
            required: isDiagnosticRequired(field.required),
            min: Number.isInteger(minFieldSelections)
              ? minFieldSelections
              : undefined,
            max: Number.isInteger(maxFieldSelections)
              ? maxFieldSelections
              : undefined,
            options: Array.isArray(field.options)
              ? field.options.map((option) => ({
                  value: option.value,
                  label: option.label,
                  mappedSkill: option.mappedSkill || undefined,
                }))
              : undefined,
          };
        })
      : undefined,
  };
}

function normalizeDiagnosticAnswerValue(value, question) {
  const type = teacherQuestionType(question);
  if (type === "multi") {
    return (Array.isArray(value) ? value : [value])
      .filter(
        (item) =>
          item != null && ["string", "number", "boolean"].includes(typeof item),
      )
      .map((item) => String(item));
  }
  if (type === "group") {
    const sourceGroup =
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return (Array.isArray(question.fields) ? question.fields : []).reduce(
      (group, child) => {
        if (sourceGroup[child.id] != null)
          group[child.id] = normalizeDiagnosticAnswerValue(
            sourceGroup[child.id],
            child,
          );
        return group;
      },
      {},
    );
  }
  return String(value);
}

function normalizeTeacherAnswers(raw, questions) {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const answers = {};
  for (const question of questions) {
    const field = question.field || question.id;
    const value = source[field];
    if (value == null) continue;
    answers[field] = normalizeDiagnosticAnswerValue(value, question);
    if (
      teacherQuestionType(question) !== "group" &&
      teacherQuestionType(question) !== "multi"
    ) {
      const selectedOption = Array.isArray(question.options)
        ? question.options.find(
            (option) => String(option.value) === answers[field],
          )
        : null;
      if (selectedOption?.mappedSkill)
        answers[`${field}_skill`] = String(selectedOption.mappedSkill);
    }
  }
  return answers;
}

function emptyDiagnosticValue(value) {
  return (
    value == null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0) ||
    (value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
}

function diagnosticValidationError(message, code, questionId) {
  return { message, code, ...(questionId ? { questionId } : {}) };
}

function validateOptionValue(question, value, label) {
  const options = Array.isArray(question.options) ? question.options : [];
  if (!options.length || emptyDiagnosticValue(value)) return null;
  const allowed = new Set(options.map((option) => String(option.value)));
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => !allowed.has(String(item)))) {
    return diagnosticValidationError(
      `${label} contains an invalid option.`,
      "INVALID_OPTION",
      question.id,
    );
  }
  return null;
}

function validateDiagnosticValueType(question, value, label) {
  if (
    teacherQuestionType(question) === "email" &&
    !emptyDiagnosticValue(value)
  ) {
    const email = String(value).trim();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return diagnosticValidationError(
        `${label} must be a valid email address.`,
        "EMAIL_INVALID",
        question.id,
      );
    }
  }
  return null;
}

function validateSelectionBounds(question, value, label) {
  if (!Array.isArray(value)) return null;
  const minSelections = Number.isInteger(question.minSelections)
    ? question.minSelections
    : question.min;
  const maxSelections = Number.isInteger(question.maxSelections)
    ? question.maxSelections
    : question.max;
  if (Number.isInteger(minSelections) && value.length < minSelections) {
    return diagnosticValidationError(
      `${label} requires at least ${minSelections} selection${minSelections === 1 ? "" : "s"}.`,
      "MIN_SELECTIONS",
      question.id,
    );
  }
  if (Number.isInteger(maxSelections) && value.length > maxSelections) {
    return diagnosticValidationError(
      `${label} allows at most ${maxSelections} selection${maxSelections === 1 ? "" : "s"}.`,
      "MAX_SELECTIONS",
      question.id,
    );
  }
  return null;
}

function validateDiagnosticQuestion(
  question,
  value,
  label,
  requiredCode = "REQUIRED_FIELD_MISSING",
) {
  const type = teacherQuestionType(question);
  if (isDiagnosticRequired(question.required) && emptyDiagnosticValue(value)) {
    return diagnosticValidationError(
      type === "group" || requiredCode !== "REQUIRED_QUESTION_MISSING"
        ? `${label} is required.`
        : `"${label}" is required.`,
      requiredCode,
      question.id,
    );
  }
  if (type === "group") {
    const group =
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    for (const child of Array.isArray(question.fields) ? question.fields : []) {
      const childError = validateDiagnosticQuestion(
        child,
        group[child.id],
        child.label || child.id,
      );
      if (childError) return childError;
    }
    return null;
  }
  if (type === "multi") {
    const boundsError = validateSelectionBounds(question, value, label);
    if (boundsError) return boundsError;
  }
  return (
    validateOptionValue(question, value, label) ||
    validateDiagnosticValueType(question, value, label)
  );
}

function validateDiagnosticAnswers(answers, questions) {
  for (const question of questions) {
    const field = question.field || question.id;
    const validationError = validateDiagnosticQuestion(
      question,
      answers[field],
      question.text || field,
      "REQUIRED_QUESTION_MISSING",
    );
    if (validationError) return validationError;
  }
  return null;
}

function recommendationFromTrip(trip) {
  const anchorExperiences = parseJson(trip.anchorExperiencesJson, []);
  const learnings = Array.isArray(anchorExperiences)
    ? anchorExperiences
        .map((experience) => experience?.what_students_do || experience?.name)
        .filter(Boolean)
        .slice(0, 4)
    : [];
  return {
    name: trip.title || trip.tripId,
    tripId: trip.tripId || null,
    category: trip.tier
      ? String(trip.tier).replace(/_/g, " ")
      : "Recommended trip",
    summary:
      trip.tagline ||
      trip.summaryForBrief ||
      "A curriculum-aligned TMC school programme.",
    learnings,
    driveLink: "",
  };
}

function recommendationsFromEngine(engineOutput) {
  const seen = new Set();
  const recommendations = [];
  const addRecommendation = (recommendation) => {
    const key = String(recommendation?.name || "")
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    recommendations.push(recommendation);
    return recommendations.length >= 10;
  };

  // Keep the curriculum-first ordering used by the public report. The TMC
  // engine's curriculum matches are already persisted in its compact array
  // shape, while older/public rows use the nested `recommendations` shape.
  const curriculumFit = Array.isArray(engineOutput?.curriculumFit)
    ? engineOutput.curriculumFit
    : engineOutput?.curriculumFit?.recommendations || [];
  for (const match of curriculumFit) {
    const name = String(
      match?.destinationLabel || match?.destination || "",
    ).trim();
    if (!name) continue;
    if (
      addRecommendation({
        name,
        tripId: match.destinationId || null,
        category: match.subject || match.category || "Curriculum match",
        summary:
          match.fitRationale ||
          (match.reasons || [])
            .map(
              (reason) =>
                reason?.rationale || reason?.learningOutcome || reason?.subject,
            )
            .filter(Boolean)
            .slice(0, 2)
            .join(" ") ||
          "A curriculum-aligned destination match for your school.",
        learnings: match.learningOutcome
          ? [match.learningOutcome]
          : (match.reasons || [])
              .map((reason) => reason?.learningOutcome)
              .filter(Boolean)
              .slice(0, 4),
        driveLink: match.brochurePdfUrl || "",
      })
    )
      break;
  }

  // The public report's remaining cards come from the persisted Travel
  // Knowledge/RAG result. Supplying it here keeps this authenticated portal
  // flow visually and functionally equivalent to that picker.
  for (const trip of engineOutput?.ragResult?.recommendations
    ?.recommendedTrips || []) {
    if (
      addRecommendation({
        name: String(trip?.name || trip?.tripName || "").trim(),
        tripId: trip?.tripId || null,
        category: trip?.category || "Other",
        summary: trip?.summary || "",
        learnings: Array.isArray(trip?.learnings) ? trip.learnings : [],
        driveLink: trip?.driveLink || "",
      })
    )
      break;
  }

  for (const scored of engineOutput?.scores?.survivors || []) {
    const trip = scored?.trip;
    if (!trip) continue;
    const recommendation = recommendationFromTrip(trip);
    if (addRecommendation(recommendation)) break;
  }
  if (recommendations.length > 0) return recommendations;

  // A curriculum mapping can still give the teacher useful options when the
  // catalogue filters produce no survivors. Keep this fallback shape aligned
  // with the native trip-picker cards.
  for (const match of engineOutput?.curriculumFit || []) {
    const name = String(
      match.destinationLabel || match.destination || "",
    ).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    recommendations.push({
      name,
      tripId: match.destinationId || null,
      category: match.subject || "Curriculum match",
      summary:
        match.fitRationale ||
        "A curriculum-aligned destination match for your school.",
      learnings: match.learningOutcome ? [match.learningOutcome] : [],
      driveLink: match.brochurePdfUrl || "",
    });
    if (recommendations.length >= 10) break;
  }
  return recommendations;
}

function recommendationPayloadFromDiagnostic(diagnostic, ragResult = null) {
  const engineScores = parseJson(diagnostic.engineScoresJson, {});
  const curriculumFit = parseJson(diagnostic.curriculumFitJson, []);
  return recommendationsFromEngine({
    scores: engineScores,
    curriculumFit: Array.isArray(curriculumFit) ? curriculumFit : [],
    ragResult,
  });
}

const TEACHER_REVIEW_RATINGS = new Set(["excellent", "good", "fair", "poor"]);
const TEACHER_REVIEW_TEXT_FIELDS = [
  "institution",
  "tourDestination",
  "coordinator",
  "grade",
  "signature",
];
const TEACHER_REVIEW_RATING_FIELDS = [
  "travelRating",
  "foodRating",
  "activitiesRating",
  "careSupportRating",
  "overallRating",
];

function validateTeacherReview(body = {}) {
  const errors = {};
  const clean = {};

  TEACHER_REVIEW_TEXT_FIELDS.forEach((field) => {
    const value =
      typeof body[field] === "string" ? sanitizeText(body[field]).trim() : "";
    if (!value) errors[field] = "This field is required";
    else clean[field] = value.slice(0, field === "signature" ? 160 : 191);
  });

  const reportDate =
    typeof body.reportDate === "string" ? body.reportDate.trim() : "";
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(reportDate) ||
    Number.isNaN(new Date(`${reportDate}T00:00:00.000Z`).getTime())
  ) {
    errors.reportDate = "Enter a valid report date";
  } else {
    clean.reportDate = new Date(`${reportDate}T00:00:00.000Z`);
  }

  TEACHER_REVIEW_RATING_FIELDS.forEach((field) => {
    const value =
      typeof body[field] === "string" ? body[field].trim().toLowerCase() : "";
    if (!TEACHER_REVIEW_RATINGS.has(value)) errors[field] = "Choose a rating";
    else clean[field] = value;
  });

  const feedback =
    typeof body.feedback === "string" ? sanitizeText(body.feedback).trim() : "";
  clean.feedback = feedback ? feedback.slice(0, 5000) : null;

  ["studentCount", "staffCount", "totalPassengers"].forEach((field) => {
    const value = Number(body[field]);
    if (!Number.isInteger(value) || value < 0 || value > 100000)
      errors[field] = "Enter a valid non-negative number";
    else clean[field] = value;
  });

  return { ok: Object.keys(errors).length === 0, errors, clean };
}

function teacherReviewSelect() {
  return {
    id: true,
    tenantId: true,
    tripId: true,
    teacherContactId: true,
    reportDate: true,
    institution: true,
    tourDestination: true,
    coordinator: true,
    grade: true,
    travelRating: true,
    foodRating: true,
    activitiesRating: true,
    careSupportRating: true,
    overallRating: true,
    feedback: true,
    studentCount: true,
    staffCount: true,
    totalPassengers: true,
    signature: true,
    submittedAt: true,
    updatedAt: true,
  };
}

function whereAndReviewData(where, clean) {
  return { ...where, ...clean };
}

// Staff-only lookup used by the trip admin surface when assigning a TMC trip
// to a teacher. Teachers are Contacts, not CRM staff Users, so this is kept
// separate from the portal-token endpoints below.
router.get(
  "/staff/teachers",
  verifyToken,
  requireTravelTenant,
  requireAnyPermission([
    { module: "trips", action: "update" },
    { module: "roles", action: "read" },
  ]),
  async (req, res) => {
    try {
      const teachers = await prisma.contact.findMany({
        where: {
          tenantId: req.travelTenant.id,
          subBrand: "tmc",
          portalRole: "TEACHER",
          deletedAt: null,
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: { id: true, name: true, email: true, phone: true },
      });
      res.json({ teachers });
    } catch (err) {
      console.error("[tmc-portal][staff/teachers]", err);
      res.status(500).json({ error: "Failed to load TMC teachers" });
    }
  },
);

// Staff-only parent registration link generation. Parent links are issued by
// the travel administrator after a teacher has been assigned to the trip;
// teachers can still review their trip data, but cannot mint/share links.
// The URL is deliberately derived from the same deterministic token helper
// used by the Roles page and the public landing-page decorator.
router.post(
  "/staff/trips/:tripId/parent-link",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const tripId = Number(req.params.tripId);
      if (!Number.isInteger(tripId) || tripId <= 0) {
        return res.status(400).json({
          error: "tripId must be a positive integer",
          code: "INVALID_TRIP_ID",
        });
      }

      const trip = await prisma.tmcTrip.findFirst({
        where: { id: tripId, tenantId: req.travelTenant.id },
        select: {
          id: true,
          tripCode: true,
          destination: true,
          teacherContactId: true,
        },
      });
      if (!trip) {
        return res
          .status(404)
          .json({ error: "Trip not found", code: "TRIP_NOT_FOUND" });
      }
      if (!trip.teacherContactId) {
        return res.status(409).json({
          error:
            "Assign a teacher before generating a parent registration link",
          code: "TEACHER_REQUIRED",
        });
      }

      const baseUrl = getFrontendUrlFromRequest(req);
      return res.json({
        link: buildTmcParentRegistrationUrl({
          baseUrl,
          tenantId: req.travelTenant.id,
          teacherContactId: trip.teacherContactId,
          tripId: trip.id,
        }),
        linkType: "trip-specific",
        trip: {
          id: trip.id,
          tripCode: trip.tripCode,
          destination: trip.destination,
        },
      });
    } catch (err) {
      console.error("[tmc-portal][staff/parent-link]", err);
      return res
        .status(500)
        .json({ error: "Failed to generate parent registration link" });
    }
  },
);

// Staff-only teacher workspace data. This powers the admin onboarding
// drill-down without exposing portal tokens or requiring a teacher portal
// session. The response includes the teacher's assigned trips, the canonical
// parent-registration link for each trip, the canonical participant list,
// and completed parent portal accounts.
router.get(
  "/staff/teachers/:teacherId/overview",
  verifyToken,
  requireTravelTenant,
  requireAnyPermission([
    { module: "trips", action: "update" },
    { module: "roles", action: "read" },
  ]),
  async (req, res) => {
    try {
      const teacherId = Number(req.params.teacherId);
      if (!Number.isInteger(teacherId) || teacherId <= 0) {
        return res.status(400).json({
          error: "teacherId must be a positive integer",
          code: "INVALID_TEACHER_ID",
        });
      }

      const teacher = await prisma.contact.findFirst({
        where: {
          id: teacherId,
          tenantId: req.travelTenant.id,
          subBrand: "tmc",
          portalRole: "TEACHER",
          deletedAt: null,
        },
        select: { id: true, name: true, email: true, phone: true },
      });
      if (!teacher) {
        return res
          .status(404)
          .json({ error: "TMC teacher not found", code: "TEACHER_NOT_FOUND" });
      }

      const trips = await prisma.tmcTrip.findMany({
        where: {
          tenantId: req.travelTenant.id,
          teacherContactId: teacher.id,
          status: { not: "cancelled" },
        },
        orderBy: [{ departDate: "asc" }, { id: "asc" }],
        select: {
          id: true,
          tripCode: true,
          destination: true,
          tripType: true,
          departDate: true,
          returnDate: true,
          status: true,
          landingPage: { select: { id: true, title: true, status: true } },
        },
      });

      const tripIds = trips.map((trip) => trip.id);
      if (tripIds.length === 0) {
        return res.json({ teacher, trips: [] });
      }

      // A parent portal registration is recorded in TmcParentTrip after the
      // parent completes sign-up through the trip-specific portal link. Keep
      // this count independent from TripParticipant rows: one parent can
      // register multiple students, and a participant can exist before the
      // parent creates portal credentials.
      const [participants, parentLinks] = await Promise.all([
        prisma.tripParticipant.findMany({
          // The parent TmcTrip query is tenant-scoped above; TripParticipant
          // carries tripId but has no tenantId column of its own.
          // eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic
          where: { tripId: { in: tripIds } },
          orderBy: { id: "asc" },
          select: {
            id: true,
            tripId: true,
            fullName: true,
            applicationStatus: true,
            parentName: true,
            parentEmail: true,
            parentPhone: true,
            consentCapturedAt: true,
            createdAt: true,
            pendingRegistration: {
              select: {
                studentName: true,
                studentDob: true,
                studentSchool: true,
                studentClass: true,
                studentGender: true,
                parentName: true,
                parentEmail: true,
                parentPhone: true,
                parentRelation: true,
              },
            },
          },
        }),
        prisma.tmcParentTrip.findMany({
          where: {
            tenantId: req.travelTenant.id,
            teacherContactId: teacher.id,
            tripId: { in: tripIds },
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            tripId: true,
            createdAt: true,
            parent: {
              select: { id: true, name: true, email: true, phone: true },
            },
          },
        }),
      ]);

      const participantsByTrip = new Map();
      participants.forEach((participant) => {
        const current = participantsByTrip.get(participant.tripId) || [];
        const registration = participant.pendingRegistration || {};
        const normalizedParticipant = {
          ...participant,
          fullName: participant.fullName || registration.studentName || null,
          parentName: participant.parentName || registration.parentName || null,
          parentEmail:
            participant.parentEmail || registration.parentEmail || null,
          parentPhone:
            participant.parentPhone || registration.parentPhone || null,
          studentDob: registration.studentDob || null,
          studentSchool: registration.studentSchool || null,
          studentClass: registration.studentClass || null,
          studentGender: registration.studentGender || null,
          parentRelation: registration.parentRelation || null,
        };
        current.push(normalizedParticipant);
        participantsByTrip.set(participant.tripId, current);
      });
      const parentLinksByTrip = new Map();
      parentLinks.forEach((link) => {
        const current = parentLinksByTrip.get(link.tripId) || [];
        current.push(link);
        parentLinksByTrip.set(link.tripId, current);
      });

      const baseUrl = getFrontendUrlFromRequest(req);
      const tripDetails = trips.map((trip) => {
        const tripParticipants = participantsByTrip.get(trip.id) || [];
        const tripParentRegistrations = (
          parentLinksByTrip.get(trip.id) || []
        ).map((link) => ({
          id: link.id,
          name: link.parent?.name || "Unnamed parent",
          email: link.parent?.email || null,
          phone: link.parent?.phone || null,
          createdAt: link.createdAt,
        }));
        return {
          ...trip,
          parentPortalLink: buildTmcParentRegistrationUrl({
            baseUrl,
            tenantId: req.travelTenant.id,
            teacherContactId: teacher.id,
            tripId: trip.id,
          }),
          participants: tripParticipants,
          parentRegistrations: tripParentRegistrations,
          participantCount: tripParticipants.length,
          parentCount: tripParentRegistrations.length,
        };
      });

      return res.json({ teacher, trips: tripDetails });
    } catch (err) {
      console.error("[tmc-portal][staff/teacher-overview]", err);
      return res
        .status(500)
        .json({ error: "Failed to load teacher trip details" });
    }
  },
);

async function loadTeacherTrip(req, res) {
  const tripId = Number(req.params.tripId);
  if (!Number.isInteger(tripId) || tripId <= 0) {
    res.status(400).json({
      error: "tripId must be a positive integer",
      code: "INVALID_TRIP_ID",
    });
    return null;
  }
  const trip = await prisma.tmcTrip.findFirst({
    where: {
      id: tripId,
      tenantId: Number(req.portal.tenantId),
      teacherContactId: Number(req.tmcContact.id),
    },
    select: {
      id: true,
      tripCode: true,
      destination: true,
      tripType: true,
      departDate: true,
      returnDate: true,
      status: true,
      teacherContactId: true,
      _count: {
        select: {
          participants: true,
          // Converted/rejected registration drafts are historical records.
          // Their students are either already in TripParticipant or were not
          // accepted, so they must not inflate the teacher-facing count.
          pendingRegistrations: {
            where: {
              status: { not: "REJECTED" },
              convertedToParticipantId: null,
            },
          },
        },
      },
    },
  });
  if (!trip) {
    res.status(404).json({
      error: "Trip not found for this teacher",
      code: "TRIP_NOT_ASSIGNED",
    });
    return null;
  }
  return trip;
}

// GET /api/portal/tmc/registration-context?token=...
// Public entry point for the TMC registration links. It stores only the
// signed token in an HttpOnly cookie, then the shared registration form can
// submit normally without adding TMC-specific fields.
router.get("/registration-context", async (req, res) => {
  let context = verifyTmcRegistrationToken(req.query?.token);
  if (
    !context &&
    req.query?.registrationType === "TEACHER" &&
    !req.query?.token
  ) {
    // The teacher URL is permanent and shared by all TMC teachers. The short
    // lived signed cookie only carries the route context while the user fills
    // out the shared registration form; it is not an expiring URL/invitation.
    const token = jwt.sign(
      {
        type: "TMC_REGISTRATION",
        registrationType: "TEACHER",
        subBrand: "tmc",
      },
      JWT_SECRET,
      { expiresIn: "1h" },
    );
    context = verifyTmcRegistrationToken(token);
    setTmcRegistrationContext(res, token, 60 * 60 * 1000);
    return res.json({
      ok: true,
      registrationType: "TEACHER",
      next: "/tmc/teacher-portal",
    });
  }
  if (!context)
    return res.status(400).json({
      error: "Invalid or expired TMC registration link",
      code: "INVALID_REGISTRATION_LINK",
    });
  const tenant = context.tenantId
    ? await prisma.tenant.findUnique({
        where: { id: context.tenantId },
        select: { id: true, vertical: true, slug: true },
      })
    : null;
  if (context.tenantId && (!tenant || tenant.vertical !== "travel")) {
    return res.status(400).json({
      error: "This registration link is not available",
      code: "INVALID_REGISTRATION_TENANT",
    });
  }
  if (context.registrationType === "PARENT") {
    const teacher = await prisma.contact.findFirst({
      where: {
        id: context.teacherContactId,
        tenantId: context.tenantId,
        subBrand: "tmc",
        portalRole: "TEACHER",
        deletedAt: null,
      },
      select: { id: true },
    });
    const trip = await prisma.tmcTrip.findFirst({
      where: {
        id: context.tripId,
        tenantId: context.tenantId,
        teacherContactId: context.teacherContactId,
      },
      select: { id: true },
    });
    if (!teacher || !trip)
      return res.status(400).json({
        error: "This parent registration link is no longer valid",
        code: "REGISTRATION_LINK_REVOKED",
      });
  }
  setTmcRegistrationContext(res, String(req.query.token));
  res.json({
    ok: true,
    registrationType: context.registrationType,
    tenantSlug: tenant?.slug || null,
    next:
      context.registrationType === "TEACHER"
        ? "/tmc/teacher-portal"
        : "/tmc/parent-portal",
  });
});

router.get(
  "/teacher/me",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    res.json({
      contact: req.tmcContact,
      tenant: req.tmcTenant,
      portalRole: "TEACHER",
      subBrand: "tmc",
    });
  },
);

// GET /api/portal/tmc/teacher/diagnostic
//
// The teacher portal owns this diagnostic flow. It reads the active TMC bank
// directly instead of loading the published public-form configuration. The
// response deliberately projects only answerable fields; scoring weights and
// other operator-only bank data never leave the server.
router.get(
  "/teacher/diagnostic",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    try {
      const bank = await prisma.travelDiagnosticQuestionBank.findFirst({
        where: {
          tenantId: Number(req.portal.tenantId),
          subBrand: "tmc",
          isActive: true,
        },
        orderBy: { version: "desc" },
        select: { id: true, version: true, questionsJson: true },
      });
      if (!bank)
        return res.status(404).json({
          error: "No TMC diagnostic is available right now",
          code: "BANK_NOT_FOUND",
        });
      const parsed = parseJson(bank.questionsJson, null);
      if (!parsed || !Array.isArray(parsed.questions)) {
        return res.status(500).json({
          error: "TMC diagnostic is temporarily unavailable",
          code: "BANK_CORRUPTED",
        });
      }
      res.json({
        available: true,
        bankId: bank.id,
        version: bank.version,
        questions: buildTeacherQuestions(parsed).map(projectTeacherQuestion),
        identityFields: Array.isArray(parsed.identityFields)
          ? parsed.identityFields
              .map(projectTeacherIdentityField)
              .filter((field) => field.enabled)
          : [],
      });
    } catch (err) {
      console.error("[tmc-portal][teacher/diagnostic]", err);
      res.status(500).json({ error: "Failed to load TMC diagnostic" });
    }
  },
);

// POST /api/portal/tmc/teacher/diagnostics
//
// Authenticated equivalent of the public TMC readiness submission. It runs
// the existing deterministic TMC engine against the tenant's active
// catalogue, binds the diagnostic to the logged-in teacher Contact, and does
// not mint a public report slug.
router.post(
  "/teacher/diagnostics",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    try {
      const rawAnswers = req.body?.answers;
      if (
        !rawAnswers ||
        typeof rawAnswers !== "object" ||
        Array.isArray(rawAnswers)
      ) {
        return res
          .status(400)
          .json({ error: "answers object required", code: "MISSING_FIELDS" });
      }

      const bank = await prisma.travelDiagnosticQuestionBank.findFirst({
        where: {
          tenantId: Number(req.portal.tenantId),
          subBrand: "tmc",
          isActive: true,
        },
        orderBy: { version: "desc" },
      });
      if (!bank)
        return res.status(404).json({
          error: "No TMC diagnostic is available right now",
          code: "BANK_NOT_FOUND",
        });

      const parsedBank = parseJson(bank.questionsJson, {});
      const bankQuestions = buildTeacherQuestions(parsedBank);
      if (!Array.isArray(bankQuestions)) {
        return res.status(500).json({
          error: "TMC diagnostic is temporarily unavailable",
          code: "BANK_CORRUPTED",
        });
      }

      const answers = normalizeTeacherAnswers(rawAnswers, bankQuestions);
      const contactQuestion = bankQuestions.find(
        (question) => (question.field || question.id) === "contact",
      );
      const contactFields = Array.isArray(contactQuestion?.fields)
        ? contactQuestion.fields
        : [];
      const emailField = contactFields.find((field) => field.id === "email");
      const suppliedContact =
        answers.contact && typeof answers.contact === "object"
          ? answers.contact
          : {};
      const email = emailField
        ? String(suppliedContact.email || req.tmcContact.email || "").trim()
        : "";
      if (isDiagnosticRequired(emailField?.required) && !email) {
        return res.status(400).json({
          error: "Email is required to generate your readiness report.",
          code: "EMAIL_REQUIRED",
        });
      }
      if (
        email &&
        (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      ) {
        return res.status(400).json({
          error: "Please enter a valid email address.",
          code: "EMAIL_INVALID",
        });
      }
      if (contactQuestion) {
        const configuredContactIds = new Set(
          contactFields.map((field) => field.id),
        );
        const contact = {};
        for (const field of contactFields) {
          if (suppliedContact[field.id] != null)
            contact[field.id] = suppliedContact[field.id];
        }
        if (configuredContactIds.has("contact_name")) {
          contact.contact_name = String(
            suppliedContact.contact_name || req.tmcContact.name || "",
          )
            .trim()
            .slice(0, 120);
        }
        if (configuredContactIds.has("email") && email) contact.email = email;
        if (configuredContactIds.has("phone")) {
          contact.phone = String(
            suppliedContact.phone || req.tmcContact.phone || "",
          )
            .trim()
            .slice(0, 40);
        }
        answers.contact = contact;
      }
      const validationError = validateDiagnosticAnswers(
        answers,
        bankQuestions,
      );
      if (validationError) {
        return res.status(400).json({
          error: validationError.message,
          code: validationError.code,
          ...(validationError.questionId
            ? { questionId: validationError.questionId }
            : {}),
        });
      }

      const [catalogue, weightsRow, curriculumMappings] = await Promise.all([
        prisma.tmcTripCatalogue.findMany({
          where: { tenantId: Number(req.portal.tenantId), status: "active" },
        }),
        prisma.engineWeights
          .findUnique({ where: { tenantId: Number(req.portal.tenantId) } })
          .catch(() => null),
        prisma.travelCurriculumMapping
          .findMany({
            where: { tenantId: Number(req.portal.tenantId), isActive: true },
          })
          .catch(() => []),
      ]);
      const weights = weightsRow
        ? {
            weightPrimaryOutcome: weightsRow.weightPrimaryOutcome,
            weightSecondarySkill: weightsRow.weightSecondarySkill,
            weightGrowthArea: weightsRow.weightGrowthArea,
            weightCurriculumHook: weightsRow.weightCurriculumHook,
            weightGradeBandCenter: weightsRow.weightGradeBandCenter,
            weightTierValueLean: weightsRow.weightTierValueLean,
            scoresWellThreshold: weightsRow.scoresWellThreshold,
          }
        : undefined;
      const engineOutput = tmcEngine.runTmcDiagnosticEngine(
        answers,
        catalogue,
        weights,
        curriculumMappings,
      );
      const leadQuality = tmcLeadQuality.classifyLeadQuality(answers, {
        priorSubmissionsLast24h: 0,
      });
      const flags = Array.isArray(engineOutput.flags)
        ? [...engineOutput.flags]
        : [];
      if (
        leadQuality.leadQuality === "suspect" &&
        !flags.includes("suspect")
      ) {
        flags.push("suspect");
      }

      const reportSlugToken = crypto.randomBytes(8).toString("hex");
      const diag = await prisma.travelDiagnostic.create({
        data: {
          tenantId: Number(req.portal.tenantId),
          subBrand: "tmc",
          contactId: Number(req.tmcContact.id),
          questionBankId: bank.id,
          questionsJson: JSON.stringify({
            bankId: bank.id,
            bankVersion: bank.version,
            specVersion: "TMC_DIAGNOSTIC_ENGINE_V1_2026-06-08",
          }),
          answersJson: JSON.stringify(answers),
          score: null,
          classification: null,
          classificationLabel: null,
          recommendedTier: null,
          engineState: engineOutput.state,
          engineScoresJson: JSON.stringify({
            ...engineOutput.scores,
            weightsUsed: engineOutput.scores.weightsUsed,
          }),
          recommendedTripId: engineOutput.primary?.id || null,
          alternativeTripId: engineOutput.alternative?.id || null,
          icpTier: engineOutput.icpTier,
          leadQuality: leadQuality.leadQuality,
          leadQualityReasonsJson: JSON.stringify(leadQuality.reasons || []),
          flagsJson: JSON.stringify(flags),
          weightsVersion: weightsRow
            ? String(weightsRow.version || "v1")
            : "v1",
          curriculumFitJson: JSON.stringify(engineOutput.curriculumFit || []),
          source: "tmc_teacher_portal",
          reportSlugToken,
        },
      });

      // Match the public report's brochure-backed shortlist when Travel
      // Knowledge is configured. This is best-effort; deterministic catalogue
      // recommendations remain available if RAG is unavailable.
      let ragResult = null;
      try {
        ragResult = await travelRag.runRagForDiagnostic({
          tenantId: Number(req.portal.tenantId),
          diagnosticId: diag.id,
          subBrand: "tmc",
          answers,
          bank,
        });
      } catch (ragErr) {
        console.warn(
          "[tmc-portal][teacher/diagnostics] RAG failed (non-fatal):",
          ragErr.message,
        );
      }

      try {
        await diagnosticNotifications.notifyDiagnosticSubmitted({
          tenantId: Number(req.portal.tenantId),
          subBrand: "tmc",
          diagnosticId: diag.id,
          contactLabel:
            answers.contact?.contact_name ||
            req.tmcContact.email ||
            `Diagnostic #${diag.id}`,
          classificationLabel: engineOutput.state,
          recommendedTier: leadQuality.leadQuality,
        });
      } catch (notifyErr) {
        console.warn(
          "[tmc-portal][teacher/diagnostics] notification failed (non-fatal):",
          notifyErr.message,
        );
      }

      res.status(201).json({
        id: diag.id,
        diagnosticId: diag.id,
        engineState: engineOutput.state,
        classificationLabel: "Routed by TMC Engine",
        recommendedTier: "engine",
        curriculumFit: engineOutput.curriculumFit || [],
        recommendations: recommendationsFromEngine({
          ...engineOutput,
          ragResult,
        }),
        reportPdfUrl: buildTeacherReportPdfUrl({
          id: diag.id,
          reportSlugToken,
        }),
        createdAt: diag.createdAt,
        chosenInterests: null,
      });
    } catch (err) {
      if (err?.status)
        return res
          .status(err.status)
          .json({ error: err.message, code: err.code });
      console.error("[tmc-portal][teacher/diagnostics POST]", err);
      res.status(500).json({
        error: "Failed to submit TMC diagnostic",
        code: "TMC_SUBMIT_FAILED",
      });
    }
  },
);

// The TMC diagnostic submit/report engine already exists in the travel
// diagnostic routes. This endpoint gives a teacher an authenticated history
// surface for reports submitted from this portal. New dynamic-form reports
// use the same signed report slug as the customer flow; older rows without a
// public-form token retain their legacy report link.
router.get(
  "/teacher/diagnostics",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    try {
      const diagnostics = await prisma.travelDiagnostic.findMany({
        where: {
          tenantId: Number(req.portal.tenantId),
          subBrand: "tmc",
          contactId: Number(req.tmcContact.id),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          engineState: true,
          createdAt: true,
          curriculumFitJson: true,
          reportSlugToken: true,
        },
      });
      res.json({
        diagnostics: diagnostics.map((diagnostic) => ({
          id: diagnostic.id,
          engineState: diagnostic.engineState,
          createdAt: diagnostic.createdAt,
          reportPdfUrl: buildTeacherReportPdfUrl(diagnostic),
          hasCurriculumRecommendations: Boolean(diagnostic.curriculumFitJson),
        })),
      });
    } catch (err) {
      console.error("[tmc-portal][teacher/diagnostics]", err);
      res.status(500).json({ error: "Failed to load diagnostic reports" });
    }
  },
);

// GET /api/portal/tmc/teacher/diagnostics/:id
//
// Returns the native report/trip-picker data for one report. The diagnostic
// is scoped to the logged-in teacher, tenant, and TMC sub-brand.
router.get(
  "/teacher/diagnostics/:id",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0)
        return res.status(400).json({
          error: "id must be a positive integer",
          code: "INVALID_ID",
        });
      const diagnostic = await prisma.travelDiagnostic.findFirst({
        where: {
          id,
          tenantId: Number(req.portal.tenantId),
          contactId: Number(req.tmcContact.id),
          subBrand: "tmc",
        },
        select: {
          id: true,
          engineState: true,
          createdAt: true,
          engineScoresJson: true,
          curriculumFitJson: true,
          reportPdfUrl: true,
          reportSlugToken: true,
        },
      });
      if (!diagnostic)
        return res.status(404).json({
          error: "Diagnostic report not found",
          code: "NOT_FOUND",
        });

      let ragResult = null;
      try {
        ragResult = await travelRag.getRagResultForDiagnostic(id);
      } catch (ragErr) {
        console.warn(
          "[tmc-portal][teacher/diagnostics/:id] RAG load failed (non-fatal):",
          ragErr.message,
        );
      }
      const chosenInterests = await diagnosticChosenInterests.getChosenInterests(
        {
          tenantId: Number(req.portal.tenantId),
          diagnosticId: id,
        },
      );
      res.json({
        diagnostic: {
          id: diagnostic.id,
          engineState: diagnostic.engineState,
          classificationLabel: "Routed by TMC Engine",
          recommendedTier: "engine",
          createdAt: diagnostic.createdAt,
          reportPdfUrl: buildTeacherReportPdfUrl(diagnostic),
          recommendations: recommendationPayloadFromDiagnostic(
            diagnostic,
            ragResult,
          ),
          chosenInterests,
        },
      });
    } catch (err) {
      console.error("[tmc-portal][teacher/diagnostics/:id]", err);
      res.status(500).json({ error: "Failed to load diagnostic report" });
    }
  },
);

// POST /api/portal/tmc/teacher/diagnostics/:id/interests
//
// Saves the teacher's chosen trips without a public report slug. The storage
// helper keeps the existing overwrite semantics used by the public report and
// the generic customer portal.
router.post(
  "/teacher/diagnostics/:id/interests",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0)
        return res.status(400).json({
          error: "id must be a positive integer",
          code: "INVALID_ID",
        });
      const diagnostic = await prisma.travelDiagnostic.findFirst({
        where: {
          id,
          tenantId: Number(req.portal.tenantId),
          contactId: Number(req.tmcContact.id),
          subBrand: "tmc",
        },
        select: { id: true, tenantId: true },
      });
      if (!diagnostic)
        return res.status(404).json({
          error: "Diagnostic report not found",
          code: "NOT_FOUND",
        });
      const interests = Array.isArray(req.body?.interests)
        ? req.body.interests
        : [];
      const saved = await diagnosticChosenInterests.saveChosenInterests({
        tenantId: diagnostic.tenantId,
        diagnosticId: diagnostic.id,
        interests,
      });
      res.json({ ok: true, ...saved });
    } catch (err) {
      if (err?.status)
        return res
          .status(err.status)
          .json({ error: err.message, code: err.code });
      console.error(
        "[tmc-portal][teacher/diagnostics/:id/interests]",
        err,
      );
      res.status(500).json({ error: "Failed to save chosen trips" });
    }
  },
);

router.get(
  "/teacher/trips",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    try {
      const trips = await prisma.tmcTrip.findMany({
        where: {
          tenantId: Number(req.portal.tenantId),
          teacherContactId: Number(req.tmcContact.id),
        },
        orderBy: [{ departDate: "asc" }, { id: "asc" }],
        select: {
          id: true,
          tripCode: true,
          destination: true,
          tripType: true,
          departDate: true,
          returnDate: true,
          status: true,
          _count: {
            select: {
              participants: true,
              // A converted draft is retained for audit history and points to
              // its TripParticipant. Count only registrations still awaiting
              // conversion so the same student is not counted twice.
              pendingRegistrations: {
                where: {
                  status: { not: "REJECTED" },
                  convertedToParticipantId: null,
                },
              },
            },
          },
        },
      });
      res.json({ trips });
    } catch (err) {
      console.error("[tmc-portal][teacher/trips]", err);
      res.status(500).json({ error: "Failed to load assigned trips" });
    }
  },
);

// List completed trips assigned to this teacher and attach the teacher's
// existing report, if one has already been submitted. The portal loads this
// collection during startup, so it must remain independent from the
// per-trip-detail endpoint below.
router.get(
  "/teacher/reviews",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    try {
      const tenantId = Number(req.portal.tenantId);
      const teacherContactId = Number(req.tmcContact.id);
      const trips = await prisma.tmcTrip.findMany({
        where: {
          tenantId,
          teacherContactId,
          status: "completed",
        },
        orderBy: [{ returnDate: "desc" }, { id: "desc" }],
        select: {
          id: true,
          tripCode: true,
          destination: true,
          tripType: true,
          departDate: true,
          returnDate: true,
          status: true,
        },
      });

      const reviews = trips.length
        ? await prisma.tmcTripTeacherReview.findMany({
            where: {
              tenantId,
              teacherContactId,
              tripId: { in: trips.map((trip) => trip.id) },
            },
            orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
            select: teacherReviewSelect(),
          })
        : [];
      const reviewByTrip = new Map(
        reviews.map((review) => [review.tripId, review]),
      );

      res.json({
        trips: trips.map((trip) => ({
          ...trip,
          review: reviewByTrip.get(trip.id) || null,
          reviewSubmitted: reviewByTrip.has(trip.id),
        })),
      });
    } catch (err) {
      console.error("[tmc-portal][teacher/reviews]", err);
      res.status(500).json({ error: "Failed to load teacher reviews" });
    }
  },
);

router.get(
  "/teacher/trips/:tripId/review",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    try {
      const trip = await loadTeacherTrip(req, res);
      if (!trip) return;
      if (trip.status !== "completed") {
        return res.status(409).json({
          error: "Teacher reports are available after the trip is completed",
          code: "TRIP_NOT_COMPLETED",
        });
      }
      const review = await prisma.tmcTripTeacherReview.findFirst({
        where: {
          tenantId: Number(req.portal.tenantId),
          tripId: trip.id,
          teacherContactId: Number(req.tmcContact.id),
        },
        select: teacherReviewSelect(),
      });
      res.json({ trip, review: review || null });
    } catch (err) {
      console.error("[tmc-portal][teacher/review]", err);
      res.status(500).json({ error: "Failed to load the teacher report" });
    }
  },
);

router.put(
  "/teacher/trips/:tripId/review",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    try {
      const trip = await loadTeacherTrip(req, res);
      if (!trip) return;
      if (trip.status !== "completed") {
        return res.status(409).json({
          error: "Teacher reports are available after the trip is completed",
          code: "TRIP_NOT_COMPLETED",
        });
      }
      const { ok, errors, clean } = validateTeacherReview(req.body || {});
      if (!ok)
        return res.status(400).json({
          error: "Please complete all required report fields",
          code: "INVALID_TEACHER_REVIEW",
          errors,
        });

      const where = {
        tenantId: Number(req.portal.tenantId),
        tripId: trip.id,
        teacherContactId: Number(req.tmcContact.id),
      };
      const existing = await prisma.tmcTripTeacherReview.findFirst({
        where,
        select: { id: true },
      });
      const review = existing
        ? await prisma.tmcTripTeacherReview.update({
            where: { id: existing.id },
            data: clean,
            select: teacherReviewSelect(),
          })
        : await prisma.tmcTripTeacherReview.create({
            data: whereAndReviewData(where, clean),
            select: teacherReviewSelect(),
          });
      res.status(existing ? 200 : 201).json({ ok: true, review });
    } catch (err) {
      console.error("[tmc-portal][teacher/review-submit]", err);
      res.status(500).json({ error: "Failed to submit the teacher report" });
    }
  },
);

router.get(
  "/teacher/trips/:tripId/registrations",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    try {
      const trip = await loadTeacherTrip(req, res);
      if (!trip) return;
      const [registrations, parentLinks] = await Promise.all([
        prisma.pendingTripRegistration.findMany({
          where: {
            tenantId: Number(req.portal.tenantId),
            tripId: trip.id,
            status: { not: "REJECTED" },
            convertedToParticipantId: null,
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            tripId: true,
            studentName: true,
            studentDob: true,
            studentSchool: true,
            studentClass: true,
            studentGender: true,
            parentName: true,
            parentEmail: true,
            parentPhone: true,
            parentRelation: true,
            status: true,
            otpVerified: true,
            convertedToParticipantId: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        prisma.tmcParentTrip.findMany({
          where: {
            tenantId: Number(req.portal.tenantId),
            tripId: trip.id,
            teacherContactId: Number(req.tmcContact.id),
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            tripId: true,
            createdAt: true,
            parent: {
              select: { id: true, name: true, email: true, phone: true },
            },
          },
        }),
      ]);
      res.json({ trip, registrations, parentLinks });
    } catch (err) {
      console.error("[tmc-portal][teacher/registrations]", err);
      res.status(500).json({ error: "Failed to load registrations" });
    }
  },
);

router.get(
  "/teacher/trips/:tripId/participants",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    try {
      const trip = await loadTeacherTrip(req, res);
      if (!trip) return;
      // loadTeacherTrip has already tenant-scoped the parent TmcTrip; the
      // participant model carries tripId rather than its own tenantId.
      const participants = await prisma.tripParticipant.findMany({
        // The parent TmcTrip was tenant-scoped by loadTeacherTrip; TripParticipant
        // has no tenantId column of its own.
        // eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic
        where: { tripId: trip.id },
        orderBy: { id: "asc" },
        select: {
          id: true,
          tripId: true,
          fullName: true,
          applicationStatus: true,
          parentName: true,
          parentEmail: true,
          parentPhone: true,
          consentCapturedAt: true,
          createdAt: true,
        },
      });
      res.json({ trip, participants });
    } catch (err) {
      console.error("[tmc-portal][teacher/participants]", err);
      res.status(500).json({ error: "Failed to load participants" });
    }
  },
);

// Teachers can view the published landing page for trips assigned to them.
// This endpoint intentionally exposes no builder fields or write operation;
// loadTeacherTrip enforces both tenant and teacher ownership first.
router.get(
  "/teacher/trips/:tripId/landing-page",
  verifyPortalToken,
  requireTmcTenant,
  requireTeacher,
  async (req, res) => {
    try {
      const trip = await loadTeacherTrip(req, res);
      if (!trip) return;
      const landingPage = await prisma.landingPage.findFirst({
        where: {
          tenantId: Number(req.portal.tenantId),
          tripId: trip.id,
          status: "PUBLISHED",
        },
        select: {
          id: true,
          tripId: true,
          slug: true,
          title: true,
          status: true,
          destination: true,
          publishedAt: true,
          updatedAt: true,
        },
      });
      if (!landingPage) {
        return res.status(404).json({
          error: "No published landing page is linked to this trip",
          code: "NO_PUBLISHED_LANDING_PAGE",
        });
      }
      res.json({
        landingPage,
        publicUrl: buildPublishedTripUrl(landingPage),
      });
    } catch (err) {
      console.error("[tmc-portal][teacher/landing-page]", err);
      res.status(500).json({ error: "Failed to load the trip landing page" });
    }
  },
);

router.get(
  "/parent/me",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    res.json({
      contact: req.tmcContact,
      portalRole: "PARENT",
      subBrand: "tmc",
    });
  },
);

router.get(
  "/parent/trips",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    try {
      const email = String(req.tmcContact.email || "")
        .trim()
        .toLowerCase();
      const [participants, registrations, parentLinks] = await Promise.all([
        prisma.tripParticipant.findMany({
          where: {
            parentEmail: email,
            trip: { tenantId: Number(req.portal.tenantId) },
          },
          orderBy: { id: "desc" },
          select: {
            id: true,
            tripId: true,
            fullName: true,
            applicationStatus: true,
            trip: {
              select: {
                id: true,
                tripCode: true,
                destination: true,
                tripType: true,
                departDate: true,
                returnDate: true,
                status: true,
              },
            },
          },
        }),
        prisma.pendingTripRegistration.findMany({
          where: {
            tenantId: Number(req.portal.tenantId),
            parentEmail: email,
            status: { not: "REJECTED" },
          },
          orderBy: { id: "desc" },
          select: {
            id: true,
            tripId: true,
            studentName: true,
            status: true,
            createdAt: true,
            trip: {
              select: {
                id: true,
                tripCode: true,
                destination: true,
                tripType: true,
                departDate: true,
                returnDate: true,
                status: true,
              },
            },
          },
        }),
        prisma.tmcParentTrip.findMany({
          where: {
            tenantId: Number(req.portal.tenantId),
            parentContactId: Number(req.tmcContact.id),
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            tripId: true,
            createdAt: true,
            teacher: { select: { id: true, name: true, email: true } },
            trip: {
              select: {
                id: true,
                tripCode: true,
                destination: true,
                tripType: true,
                departDate: true,
                returnDate: true,
                status: true,
                landingPage: {
                  select: { id: true, slug: true, title: true, status: true },
                },
              },
            },
          },
        }),
      ]);
      const linkedTrips = parentLinks.map((row) => ({
        ...row,
        landingUrl: buildPublishedTripUrl(row.trip?.landingPage),
      }));
      const linkedTripIds = [
        ...new Set(parentLinks.map((row) => row.tripId).filter(Boolean)),
      ];
      // Existing parent accounts are associated with the teacher who issued
      // their earlier registration link. Include newly assigned trips for
      // those teachers so parents do not need to create a second account or
      // re-register just because a teacher was assigned to another trip.
      const teacherContactIds = [
        ...new Set(
          parentLinks
            .map((row) => Number(row.teacher?.id))
            .filter((id) => Number.isInteger(id) && id > 0),
        ),
      ];
      const tripAccessFilters = [];
      if (linkedTripIds.length) {
        tripAccessFilters.push({ id: { in: linkedTripIds } });
      }
      if (teacherContactIds.length) {
        tripAccessFilters.push({ teacherContactId: { in: teacherContactIds } });
      }
      const assignedTrips = tripAccessFilters.length
        ? await prisma.tmcTrip.findMany({
            where: {
              tenantId: Number(req.portal.tenantId),
              status: { not: "cancelled" },
              OR: tripAccessFilters,
            },
            orderBy: [{ departDate: "asc" }, { id: "asc" }],
            select: {
              id: true,
              tripCode: true,
              destination: true,
              tripType: true,
              departDate: true,
              returnDate: true,
              status: true,
              teacher: { select: { id: true, name: true, email: true } },
              landingPage: {
                select: { id: true, slug: true, title: true, status: true },
              },
            },
          })
        : [];
      const trips = assignedTrips.map((trip) => ({
        ...trip,
        tripId: trip.id,
        landingUrl: buildPublishedTripUrl(trip.landingPage),
      }));
      res.json({
        participants,
        registrations,
        parentLinks: linkedTrips,
        trips,
      });
    } catch (err) {
      console.error("[tmc-portal][parent/trips]", err);
      res.status(500).json({ error: "Failed to load parent trips" });
    }
  },
);

// Visa letter packets sent to a parent. A TMC parent is scoped by the trips
// linked to the parent account (and participant parent-email fallback), rather
// than by VisaApplication.contactId. Visa applications are often created for
// a participant while the portal account belongs to that participant's parent.
router.get(
  "/parent/visa-letters",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    try {
      const tenantId = Number(req.portal.tenantId);
      const tripIds = await getParentAccessibleTripIds(req);
      if (!tripIds.length) return res.json({ applications: [] });

      const applications = await prisma.visaApplication.findMany({
        where: {
          tenantId,
          tripId: { in: tripIds },
          visaLetterDocuments: {
            some: {
              tenantId,
              status: { in: TMC_PARENT_VISA_LETTER_STATUSES },
            },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          applicationType: true,
          destinationCountry: true,
          status: true,
          createdAt: true,
          trip: {
            select: {
              id: true,
              tripCode: true,
              destination: true,
              departDate: true,
              returnDate: true,
            },
          },
          participant: {
            select: { id: true, fullName: true },
          },
          visaLetterDocuments: {
            where: {
              tenantId,
              status: { in: TMC_PARENT_VISA_LETTER_STATUSES },
            },
            orderBy: [{ generationId: "desc" }, { id: "asc" }],
          },
        },
      });
      return res.json({ applications: applications.map(projectTmcParentVisaApplication) });
    } catch (err) {
      console.error("[tmc-portal][parent/visa-letters]", err);
      return res.status(500).json({ error: "Failed to load visa letters" });
    }
  },
);

router.get(
  "/parent/visa-letters/:letterId/generated",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    try {
      const letterId = Number.parseInt(req.params.letterId, 10);
      if (!Number.isInteger(letterId) || letterId <= 0) {
        return res.status(400).json({ error: "letterId must be a positive integer", code: "INVALID_ID" });
      }
      const document = await loadParentVisaLetter(req, letterId);
      if (!document) return res.status(404).json({ error: "Letter not found", code: "NOT_FOUND" });
      return streamTmcParentVisaLetter(
        res,
        { storage: document.generatedFileStorage, key: document.generatedFileKey },
        document.generatedFileName,
        { download: req.query.download === "1" },
      );
    } catch (err) {
      console.error("[tmc-portal][parent/visa-letters/generated]", err);
      return res.status(500).json({ error: "Failed to open letter" });
    }
  },
);

router.get(
  "/parent/visa-letters/:letterId/signed",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    try {
      const letterId = Number.parseInt(req.params.letterId, 10);
      if (!Number.isInteger(letterId) || letterId <= 0) {
        return res.status(400).json({ error: "letterId must be a positive integer", code: "INVALID_ID" });
      }
      const document = await loadParentVisaLetter(req, letterId);
      if (!document || document.status !== "SIGNED_UPLOADED" || !document.signedFileKey) {
        return res.status(404).json({ error: "Signed letter not found", code: "NOT_FOUND" });
      }
      return streamTmcParentVisaLetter(
        res,
        { storage: document.signedFileStorage, key: document.signedFileKey },
        document.signedFileName || document.generatedFileName,
        { download: req.query.download === "1" },
      );
    } catch (err) {
      console.error("[tmc-portal][parent/visa-letters/signed]", err);
      return res.status(500).json({ error: "Failed to open signed letter" });
    }
  },
);

router.post(
  "/parent/visa-letters/:letterId/signed-upload",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  portalVisaLetterUploadHandler,
  async (req, res) => {
    try {
      const letterId = Number.parseInt(req.params.letterId, 10);
      if (!Number.isInteger(letterId) || letterId <= 0) {
        return res.status(400).json({ error: "letterId must be a positive integer", code: "INVALID_ID" });
      }
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "no file uploaded (field name: 'file')", code: "NO_FILE" });
      }

      const document = await loadParentVisaLetter(req, letterId);
      if (!document) return res.status(404).json({ error: "Letter not found", code: "NOT_FOUND" });

      let stored;
      try {
        stored = await visaLetterStore.storeLetterPdf(req.file.buffer, {
          applicationId: document.visaApplicationId,
          participantId: document.participantId,
          kind: "signed",
          fileName: (req.file.originalname || "signed-visa-letter.pdf").slice(0, 160),
        });
      } catch (err) {
        console.error("[tmc-portal][parent/visa-letters/signed-upload] storage error:", err.message);
        return res.status(502).json({ error: "Couldn't store the uploaded file. Please try again.", code: "STORAGE_FAILED" });
      }

      const signedFileName = (req.file.originalname || "signed-visa-letter.pdf").slice(0, 255);
      const updated = await prisma.visaLetterDocument.update({
        where: { id: document.id },
        data: {
          status: "SIGNED_UPLOADED",
          signedFileUrl: stored.url,
          signedFileKey: stored.key,
          signedFileStorage: stored.storage,
          signedFileName,
          signedUploadedAt: new Date(),
          signedUploadedByContactId: Number(req.tmcContact.id),
        },
      });
      if (document.signedFileKey && document.signedFileKey !== stored.key) {
        await visaLetterStore.removeLetter({ storage: document.signedFileStorage, key: document.signedFileKey });
      }

      const generationDocuments = await prisma.visaLetterDocument.findMany({
        where: { generationId: document.generationId, tenantId: Number(req.portal.tenantId) },
        select: { status: true },
      });
      const allSigned = generationDocuments.length > 0 && generationDocuments.every((row) => row.status === "SIGNED_UPLOADED");
      await prisma.visaLetterGeneration.update({
        where: { id: document.generationId },
        data: { status: allSigned ? "SIGNED_COMPLETE" : "PARTIALLY_SIGNED" },
      }).catch(() => {});

      try {
        const staffUserIds = await prisma.user.findMany({
          where: { tenantId: Number(req.portal.tenantId), role: { in: ["ADMIN", "MANAGER"] } },
          select: { id: true },
        }).then((rows) => rows.map((row) => row.id));
        if (staffUserIds.length > 0) {
          await notifyMany({
            userIds: staffUserIds,
            tenantId: Number(req.portal.tenantId),
            title: "Signed visa letter uploaded",
            message: `${req.tmcContact.name || "A parent"} uploaded ${document.documentType} for application #${document.visaApplicationId}.`,
            type: "info",
            link: `/travel/visa/applications/${document.visaApplicationId}`,
            io: req.io || null,
          });
        }
      } catch (notifyErr) {
        console.warn("[tmc-portal][parent/visa-letters/signed-upload] staff notification failed:", notifyErr.message);
      }

      writeAudit(
        "VisaLetterDocument",
        "signed.uploaded",
        document.id,
        null,
        Number(req.portal.tenantId),
        { visaApplicationId: document.visaApplicationId, storage: stored.storage, portalContactId: Number(req.tmcContact.id) },
        { actorType: "portal" },
      ).catch(() => {});

      return res.status(201).json({ letter: projectTmcParentVisaLetter(updated) });
    } catch (err) {
      console.error("[tmc-portal][parent/visa-letters/signed-upload]", err);
      return res.status(500).json({ error: "Failed to upload signed letter" });
    }
  },
);

// Consent terms follow the same authenticated, trip-scoped file flow as visa
// letters. The source PDF is selected by the TMC trip type and is stored in
// the database, so parents always receive the current terms for that trip.
router.get(
  "/parent/consent-forms/:tripId",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    try {
      const tripId = Number.parseInt(req.params.tripId, 10);
      if (!Number.isInteger(tripId) || tripId <= 0) {
        return res.status(400).json({ error: "tripId must be a positive integer", code: "INVALID_TRIP_ID" });
      }
      const context = await loadParentConsentContext(req, tripId);
      if (!context) return res.status(404).json({ error: "Trip not found", code: "TRIP_NOT_FOUND" });
      return res.json({
        trip: context.trip,
        tripType: context.tripType,
        template: projectTmcConsentTemplate(context.template),
        signedDocument: projectTmcConsentDocument(context.signedDocument),
      });
    } catch (err) {
      console.error("[tmc-portal][parent/consent-forms]", err);
      return res.status(500).json({ error: "Failed to load consent form" });
    }
  },
);

router.get(
  "/parent/consent-forms/:tripId/file",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    try {
      const tripId = Number.parseInt(req.params.tripId, 10);
      if (!Number.isInteger(tripId) || tripId <= 0) {
        return res.status(400).json({ error: "tripId must be a positive integer", code: "INVALID_TRIP_ID" });
      }
      const context = await loadParentConsentContext(req, tripId);
      if (!context || !context.template || !context.template.fileBlob) {
        return res.status(404).json({ error: "Consent form not found", code: "NOT_FOUND" });
      }
      const rendered = await convertTmcConsentTemplateToPdf(context.template);
      const filename = rendered.filename.replace(/[\r\n"]/g, "");
      res.setHeader("Content-Type", rendered.mimeType);
      res.setHeader(
        "Content-Disposition",
        `${req.query.download === "1" ? "attachment" : "inline"}; filename="${filename}"`,
      );
      return res.send(rendered.buffer);
    } catch (err) {
      console.error("[tmc-portal][parent/consent-forms:file]", err);
      return res.status(500).json({ error: "Failed to open consent form" });
    }
  },
);

// Parent travel documents. Regular files use the private visa-document store;
// signed consent images are stored in the database. Both are only exposed
// through authenticated, owner-scoped routes.
router.get(
  "/parent/documents",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    try {
      const tenantId = Number(req.portal.tenantId);
      const parentContactId = Number(req.tmcContact.id);
      const documents = await prisma.tmcParentDocument.findMany({
        where: { tenantId, parentContactId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          documentType: true,
          filename: true,
          fileSize: true,
          mimeType: true,
          status: true,
          notes: true,
          uploadedAt: true,
          createdAt: true,
          tripId: true,
        },
      });
      const tripIds = [...new Set(documents.map((document) => document.tripId).filter(Boolean))];
      const trips = tripIds.length
        ? await prisma.tmcTrip.findMany({
            where: { tenantId, id: { in: tripIds } },
          select: { id: true, tripCode: true, destination: true, tripType: true, departDate: true, returnDate: true },
          })
        : [];
      const tripById = new Map(trips.map((trip) => [trip.id, trip]));
      res.json({
        documents: documents.map((document) => projectTmcParentDocument(document, tripById.get(document.tripId))),
      });
    } catch (err) {
      console.error("[tmc-portal][parent/documents]", err);
      res.status(500).json({ error: "Failed to load parent documents" });
    }
  },
);

router.post(
  "/parent/documents",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  tmcParentDocumentUploadHandler,
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "Please choose a document to upload", code: "NO_FILE" });
      }
      const documentType = String(req.body?.documentType || "").trim().toLowerCase();
      if (!TMC_PARENT_DOCUMENT_TYPES.has(documentType)) {
        return res.status(400).json({ error: "Choose a valid document type", code: "INVALID_DOCUMENT_TYPE" });
      }

      if (req.body?.tripId === undefined || String(req.body.tripId).trim() === "") {
        return res.status(400).json({
          error: "Select the related trip before uploading a document",
          code: "TRIP_REQUIRED",
        });
      }
      const tripId = Number(req.body.tripId);
      if (!Number.isInteger(tripId) || tripId <= 0) {
        return res.status(400).json({ error: "tripId must be a positive integer", code: "INVALID_TRIP_ID" });
      }
      const accessibleTripIds = await getParentAccessibleTripIds(req);
      if (!accessibleTripIds.includes(tripId)) {
        return res.status(404).json({ error: "Trip not found", code: "TRIP_NOT_FOUND" });
      }
      const trip = await prisma.tmcTrip.findFirst({
        where: { id: tripId, tenantId: Number(req.portal.tenantId) },
        select: { id: true, tripType: true },
      });
      if (!trip) return res.status(404).json({ error: "Trip not found", code: "TRIP_NOT_FOUND" });
      const requiredDocumentTypes = requiredParentDocumentTypes(trip.tripType);
      if (!requiredDocumentTypes.includes(documentType)) {
        return res.status(400).json({
          error: "This document is not required for the selected trip",
          code: "DOCUMENT_NOT_REQUIRED_FOR_TRIP",
          tripType: trip.tripType,
          requiredDocumentTypes,
        });
      }
      if (documentType === "consent-form" && !["image/jpeg", "image/png"].includes(String(req.file.mimetype || "").toLowerCase())) {
        return res.status(400).json({
          error: "Signed consent forms must be uploaded as a JPG or PNG image",
          code: "CONSENT_IMAGE_REQUIRED",
        });
      }

      let stored;
      if (documentType === "consent-form") {
        stored = { storage: "db", url: null, key: null };
      } else {
        try {
          stored = await visaDocStore.storeDoc(req.file.buffer, req.file.mimetype);
        } catch (err) {
          console.error("[tmc-portal][parent/documents:upload] storage error:", err.message);
          return res.status(502).json({ error: "Couldn't store the uploaded file. Please try again.", code: "STORAGE_FAILED" });
        }
      }

      const document = await prisma.tmcParentDocument.create({
        data: {
          tenantId: Number(req.portal.tenantId),
          parentContactId: Number(req.tmcContact.id),
          tripId,
          documentType,
          filename: (req.file.originalname || "travel-document").slice(0, 255),
          fileUrl: stored.url,
          fileBlob: documentType === "consent-form" ? req.file.buffer : null,
          fileSize: req.file.size || null,
          mimeType: req.file.mimetype || null,
          storage: stored.storage,
          storageKey: stored.key,
          status: "in_review",
          uploadedAt: new Date(),
        },
        select: {
          id: true,
          documentType: true,
          filename: true,
          fileSize: true,
          mimeType: true,
          status: true,
          notes: true,
          uploadedAt: true,
          createdAt: true,
          tripId: true,
        },
      });
      return res.status(201).json({ document: projectTmcParentDocument(document) });
    } catch (err) {
      console.error("[tmc-portal][parent/documents:upload]", err);
      return res.status(500).json({ error: "Failed to upload document" });
    }
  },
);

router.get(
  "/parent/documents/:documentId/file",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    try {
      const documentId = Number(req.params.documentId);
      if (!Number.isInteger(documentId) || documentId <= 0) {
        return res.status(400).json({ error: "documentId must be a positive integer", code: "INVALID_DOCUMENT_ID" });
      }
      const document = await prisma.tmcParentDocument.findFirst({
        where: {
          id: documentId,
          tenantId: Number(req.portal.tenantId),
          parentContactId: Number(req.tmcContact.id),
        },
        select: { id: true, fileBlob: true, fileUrl: true, storage: true, storageKey: true, mimeType: true, filename: true },
      });
      if (!document) return res.status(404).json({ error: "Document not found", code: "NOT_FOUND" });
      const buffer = document.fileBlob
        ? Buffer.from(document.fileBlob)
        : await visaDocStore.readDocBuffer({
            attachmentUrl: document.fileUrl,
            attachmentStorage: document.storage,
            attachmentKey: document.storageKey,
          });
      if (!buffer) return res.status(404).json({ error: "Document file not found", code: "NOT_FOUND" });
      const filename = String(document.filename || "travel-document").replace(/[\r\n"]/g, "");
      res.setHeader("Content-Type", document.mimeType || "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `${req.query.download === "1" ? "attachment" : "inline"}; filename="${filename}"`,
      );
      return res.send(buffer);
    } catch (err) {
      console.error("[tmc-portal][parent/documents:file]", err);
      return res.status(500).json({ error: "Failed to open document" });
    }
  },
);

router.get(
  "/parent/documents/:documentId/view-url",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    try {
      const documentId = Number(req.params.documentId);
      if (!Number.isInteger(documentId) || documentId <= 0) {
        return res.status(400).json({ error: "documentId must be a positive integer", code: "INVALID_DOCUMENT_ID" });
      }
      const document = await prisma.tmcParentDocument.findFirst({
        where: {
          id: documentId,
          tenantId: Number(req.portal.tenantId),
          parentContactId: Number(req.tmcContact.id),
        },
        select: { id: true, fileUrl: true, storage: true, storageKey: true },
      });
      if (!document) return res.status(404).json({ error: "Document not found", code: "NOT_FOUND" });
      const url = await visaDocStore.resolveViewUrl({
        attachmentUrl: document.fileUrl,
        attachmentStorage: document.storage,
        attachmentKey: document.storageKey,
      });
      if (!url) return res.status(404).json({ error: "Document not found", code: "NOT_FOUND" });
      return res.json({ url, expiresIn: visaDocStore.DEFAULT_VIEW_TTL_SEC });
    } catch (err) {
      console.error("[tmc-portal][parent/documents:view-url]", err);
      return res.status(500).json({ error: "Failed to open document" });
    }
  },
);

// Parent customer reviews. Only completed trips that belong to the logged-in
// parent are returned; this prevents a parent who shares a teacher from
// reviewing another parent's trip registration.
router.get(
  "/parent/reviews",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    try {
      const tenantId = Number(req.portal.tenantId);
      const parentContactId = Number(req.tmcContact.id);
      const email = String(req.tmcContact.email || "")
        .trim()
        .toLowerCase();
      const [parentLinks, participantRows] = await Promise.all([
        prisma.tmcParentTrip.findMany({
          where: { tenantId, parentContactId },
          select: { tripId: true },
        }),
        email
          ? prisma.tripParticipant.findMany({
              where: { parentEmail: email, trip: { tenantId } },
              select: { tripId: true },
            })
          : [],
      ]);
      const tripIds = [
        ...new Set([
          ...parentLinks
            .map((row) => Number(row.tripId))
            .filter((id) => Number.isInteger(id) && id > 0),
          ...participantRows
            .map((row) => Number(row.tripId))
            .filter((id) => Number.isInteger(id) && id > 0),
        ]),
      ];
      if (!tripIds.length) return res.json({ trips: [] });

      const trips = await prisma.tmcTrip.findMany({
        where: { tenantId, id: { in: tripIds }, status: "completed" },
        orderBy: [{ returnDate: "desc" }, { id: "desc" }],
        select: {
          id: true,
          tripCode: true,
          destination: true,
          tripType: true,
          departDate: true,
          returnDate: true,
          status: true,
        },
      });
      const reviews = await prisma.travelTripReview.findMany({
        where: {
          tenantId,
          tmcTripId: { in: trips.map((trip) => trip.id) },
          contactId: parentContactId,
        },
        orderBy: { submittedAt: "desc" },
        select: {
          id: true,
          tmcTripId: true,
          status: true,
          overallRating: true,
          answersJson: true,
          submittedAt: true,
        },
      });
      const reviewByTrip = new Map(
        reviews.map((review) => [review.tmcTripId, review]),
      );
      res.json({
        trips: trips.map((trip) => ({
          ...trip,
          review: parentReviewShape(reviewByTrip.get(trip.id)),
          reviewSubmitted: reviewByTrip.has(trip.id),
        })),
      });
    } catch (err) {
      console.error("[tmc-portal][parent/reviews]", err);
      res.status(500).json({ error: "Failed to load parent reviews" });
    }
  },
);

router.get(
  "/parent/reviews/:tripId",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    try {
      const trip = await loadParentReviewTrip(req, res);
      if (!trip) return;
      const review = await prisma.travelTripReview.findFirst({
        where: {
          tenantId: Number(req.portal.tenantId),
          tmcTripId: trip.id,
          contactId: Number(req.tmcContact.id),
        },
        select: {
          id: true,
          tmcTripId: true,
          status: true,
          overallRating: true,
          answersJson: true,
          submittedAt: true,
        },
      });
      res.json({
        trip,
        form: buildParentForm(trip.destination),
        review: parentReviewShape(review),
        alreadySubmitted: review?.status === "submitted",
      });
    } catch (err) {
      console.error("[tmc-portal][parent/review-get]", err);
      res.status(500).json({ error: "Failed to load parent review" });
    }
  },
);

router.post(
  "/parent/trips/:tripId/review",
  verifyPortalToken,
  requireTmcTenant,
  requireParent,
  async (req, res) => {
    try {
      const trip = await loadParentReviewTrip(req, res);
      if (!trip) return;
      const { ok, errors, overallRating, clean } = validateParentSubmission(
        req.body && req.body.answers,
      );
      if (!ok)
        return res.status(400).json({
          error: "Please complete your rating and experience",
          code: "INVALID_REVIEW",
          errors,
        });

      const tenantId = Number(req.portal.tenantId);
      const contactId = Number(req.tmcContact.id);
      const existing = await prisma.travelTripReview.findFirst({
        where: { tenantId, tmcTripId: trip.id, contactId },
        select: { id: true, status: true },
      });
      if (existing?.status === "submitted") {
        return res.status(409).json({
          error: "You've already reviewed this trip — thank you!",
          code: "ALREADY_SUBMITTED",
        });
      }

      const data = {
        status: "submitted",
        overallRating,
        answersJson: JSON.stringify(clean),
        submittedAt: new Date(),
      };
      if (existing) {
        await prisma.travelTripReview.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await prisma.travelTripReview.create({
          data: {
            tenantId,
            tmcTripId: trip.id,
            contactId,
            token: crypto.randomBytes(24).toString("base64url"),
            ...data,
          },
        });
      }

      let externalReview = null;
      try {
        externalReview = await buildExternalReviewCta({
          tenantId,
          destination: trip.destination,
          overallRating,
          answers: clean,
        });
      } catch (err) {
        // A sentiment/settings provider outage must not turn a saved review
        // into a failed submission. The parent still gets the in-app thank-you.
        console.warn("[tmc-portal][parent/review-external]", err.message);
      }
      res.status(201).json({ ok: true, overallRating, externalReview });
    } catch (err) {
      console.error("[tmc-portal][parent/review-submit]", err);
      res.status(500).json({ error: "Failed to submit parent review" });
    }
  },
);

module.exports = router;
