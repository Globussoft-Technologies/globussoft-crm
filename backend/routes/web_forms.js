const express = require("express");

const fs = require("fs");

const path = require("path");

const multer = require("multer");

const prisma = require("../lib/prisma");

const { verifyToken } = require("../middleware/auth");

const { sendEmail } = require("../lib/emailSender");
const { evaluateAutoCampaignRules } = require("../lib/callifiedAutoCampaignRules");
const { getSetting, KEYS } = require("../lib/tenantSettings");

const router = express.Router();

const uploadDir = path.join(__dirname, "..", "uploads", "web-forms");

try {
  fs.mkdirSync(uploadDir, { recursive: true });
} catch {
  /* best effort */
}

const ALLOWED_FILE_MIMES = new Set([
  "image/png",

  "image/jpeg",

  "image/jpg",

  "image/webp",

  "image/gif",

  "application/pdf",

  "text/plain",

  "text/csv",

  "application/msword",

  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

  "application/vnd.ms-excel",

  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const MIME_TO_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),

    filename: (_req, file, cb) => {
      const ext =
        MIME_TO_EXT[String(file.mimetype || "").toLowerCase()] || ".bin";

      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      cb(null, `${stamp}${ext}`);
    },
  }),

  limits: { fileSize: 10 * 1024 * 1024 },

  fileFilter: (_req, file, cb) => {
    if (ALLOWED_FILE_MIMES.has(String(file.mimetype || "").toLowerCase()))
      return cb(null, true);

    return cb(new Error("Unsupported attachment type"));
  },
});

const FIELD_TYPES = new Set([
  "text",
  "textarea",
  "number",
  "dropdown",
  "radio",
  "date",
  "url",
  "checkbox",
  "multiselect",
  "file",
]);

const CHOICE_TYPES = new Set(["dropdown", "radio", "multiselect"]);

const FILE_FORMATS = new Set([
  "CSV",
  "XLSX",
  "JPG",
  "JPEG",
  "PNG",
  "PDF",
  "DOCX",
  "PPTX",
  "TXT",
  "WEBP",
]);

const DEFAULT_FILE_FORMATS = [
  "CSV",
  "XLSX",
  "JPG",
  "JPEG",
  "PNG",
  "PDF",
  "DOCX",
  "PPTX",
];

const CONTACT_FIELDS = new Set([
  "name",
  "firstName",
  "lastName",
  "email",
  "phone",
  "company",
  "title",
  "source",
  "status",
  "aiScore",
  "assignedToId",
  "assignedTo",
  "industry",
  "companySize",
  "website",
  "linkedin",
  "description",
  "tags",
  "stateCode",
  "billingStateCode",
  "gst",
  "birthDate",
  "anniversary",
  "firstTouchSource",
  "lastTouchSource",
  "subBrand",
  "treatmentOfInterest",
]);

// Add-field picker fallback customs ("custom" rows) mapped to the Contact
// column holding the same data. Keeps form submissions from being silently
// dropped when no matching Lead-Field definition exists.
const LEAD_CUSTOM_TO_CONTACT = {
  industry: "industry",
  jobRoles: "title",
  organization: "company",
  numberOfEmployees: "companySize",
  medium: "source",
};
const FORM_SCOPES = new Set(["generic", "travel"]);

function normalizeScope(raw) {
  const scope = textOr(raw, "generic").toLowerCase();

  return FORM_SCOPES.has(scope) ? scope : null;
}

function requestedScope(req, raw) {
  const scope = normalizeScope(raw ?? req.query?.scope);

  if (!scope) {
    const error = new Error("Invalid form scope");
    error.statusCode = 400;
    error.code = "INVALID_FORM_SCOPE";
    throw error;
  }

  if (req.user?.vertical === "travel" && scope !== "travel") {
    const error = new Error("Travel users may only access Travel forms");
    error.statusCode = 403;
    error.code = "FORM_SCOPE_FORBIDDEN";
    throw error;
  }

  if (scope === "travel" && req.user?.vertical !== "travel") {
    const error = new Error("Travel form scope is not available to this tenant");
    error.statusCode = 403;
    error.code = "FORM_SCOPE_FORBIDDEN";
    throw error;
  }

  return scope;
}

function slugify(text) {
  return (
    String(text || "web-form")
      .trim()

      .toLowerCase()

      .replace(/[^a-z0-9]+/g, "-")

      .replace(/(^-|-$)/g, "")

      .slice(0, 60) || "web-form"
  );
}

function textOr(raw, fallback = "") {
  const value = String(raw == null ? "" : raw).trim();

  return value || fallback;
}

function parseJson(raw, fallback) {
  if (raw == null || raw === "") return fallback;

  if (typeof raw === "object") return raw;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseOptions(raw) {
  const parsed = parseJson(raw, []);

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item) => textOr(item))
    .filter(Boolean)
    .slice(0, 50);
}

function parseFileFormats(raw) {
  const parsed = parseJson(raw, []);

  const items = Array.isArray(parsed) ? parsed : [];

  const clean = items
    .map((item) => textOr(item).toUpperCase())
    .filter((item) => FILE_FORMATS.has(item));

  return clean.length ? clean.slice(0, 20) : DEFAULT_FILE_FORMATS;
}

function defaultFields() {
  return [
    {
      id: "contact-name",

      sourceKind: "contact",

      sourceKey: "name",

      fieldType: "text",

      label: "Name",

      placeholder: "Enter full name",

      required: true,

      hidden: false,

      options: [],

      width: "full",
    },

    {
      id: "contact-email",

      sourceKind: "contact",

      sourceKey: "email",

      fieldType: "text",

      label: "Email",

      placeholder: "name@example.com",

      required: true,

      hidden: false,

      options: [],

      width: "full",
    },

    {
      id: "contact-phone",

      sourceKind: "contact",

      sourceKey: "phone",

      fieldType: "text",

      label: "Phone",

      placeholder: "+91 98765 43210",

      required: false,

      hidden: false,

      options: [],

      width: "full",
    },
  ];
}

function defaultStyle() {
  return {
    fontFamily: "system-ui, sans-serif",

    backgroundColor: "#EBEFF3",

    formColor: "#FFFFFF",

    titleColor: "#000000",

    textColor: "#111827",

    fieldLabelColor: "#666666",

    buttonColor: "#12344D",

    accentColor: "#12344D",

    logoUrl: "",
  };
}

function defaultSettings() {
  return {
    formTitle: "",

    createAccount: false,

    createDeal: false,

    submitButtonLabel: "Submit",

    successMessage:
      "Thank you! Your information has been received. We will be in touch with you shortly to assist with your account.",

    afterSubmitAction: "message",

    redirectUrl: "",

    notificationEnabled: false,

    optInEnabled: false,

    optInText:
      "I agree to receive communication on newsletters, promotional content, offers and events.",

    optInLinkText: "",

    optInLinkUrl: "",

    notificationEmail: "",
  };
}

function normalizeField(field, index) {
  const sourceKind = ["contact", "lead_custom", "custom"].includes(
    field?.sourceKind,
  )
    ? field.sourceKind
    : "custom";

  const fieldType = FIELD_TYPES.has(field?.fieldType)
    ? field.fieldType
    : "text";

  return {
    id: textOr(field?.id, `${sourceKind}-${field?.sourceKey || index}`),

    sourceKind,

    sourceKey: textOr(field?.sourceKey, field?.key || `custom_${index}`),

    fieldType,

    label: textOr(field?.label, `Field ${index + 1}`),

    placeholder: textOr(field?.placeholder),

    helpText: textOr(field?.helpText),

    defaultValue: field?.defaultValue == null ? "" : field.defaultValue,

    required: Boolean(field?.required),

    hidden: Boolean(field?.hidden),

    options: CHOICE_TYPES.has(fieldType) ? parseOptions(field?.options) : [],

    fileFormats:
      fieldType === "file" ? parseFileFormats(field?.fileFormats) : [],

    allowMultipleFiles:
      fieldType === "file" ? Boolean(field?.allowMultipleFiles) : false,

    fileTags: fieldType === "file" ? parseOptions(field?.fileTags) : [],

    width: field?.width === "half" ? "half" : "full",
  };
}

function normalizeFields(raw) {
  const parsed = parseJson(raw, null);

  if (!Array.isArray(parsed) || parsed.length === 0) return defaultFields();

  return parsed.map((field, index) => normalizeField(field, index));
}

function normalizeStyle(raw) {
  const style = { ...defaultStyle(), ...(parseJson(raw, {}) || {}) };

  return {
    fontFamily: textOr(style.fontFamily, defaultStyle().fontFamily),

    backgroundColor: textOr(
      style.backgroundColor,
      defaultStyle().backgroundColor,
    ),

    formColor: textOr(style.formColor, defaultStyle().formColor),

    titleColor: textOr(style.titleColor, defaultStyle().titleColor),

    textColor: textOr(style.textColor, defaultStyle().textColor),

    fieldLabelColor: textOr(
      style.fieldLabelColor,
      defaultStyle().fieldLabelColor,
    ),

    buttonColor: textOr(style.buttonColor, defaultStyle().buttonColor),

    accentColor: textOr(style.accentColor, defaultStyle().accentColor),

    logoUrl: textOr(style.logoUrl),
  };
}

function normalizeUrl(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return trimmed;
  } catch (_err) {
    return "";
  }
}

function normalizeSettings(raw) {
  const settings = { ...defaultSettings(), ...(parseJson(raw, {}) || {}) };

  return {
    formTitle: textOr(settings.formTitle),

    createAccount: Boolean(settings.createAccount),

    createDeal: Boolean(settings.createDeal),

    submitButtonLabel: textOr(
      settings.submitButtonLabel,
      defaultSettings().submitButtonLabel,
    ),

    successMessage: textOr(
      settings.successMessage,
      defaultSettings().successMessage,
    ),

    afterSubmitAction:
      settings.afterSubmitAction === "redirect" ? "redirect" : "message",

    redirectUrl: normalizeUrl(settings.redirectUrl),

    notificationEnabled:
      settings.notificationEnabled == null
        ? Boolean(textOr(settings.notificationEmail))
        : Boolean(settings.notificationEnabled),

    notificationEmail: textOr(settings.notificationEmail),

    optInEnabled: Boolean(settings.optInEnabled),

    optInText: textOr(settings.optInText, defaultSettings().optInText),

    optInLinkText: textOr(settings.optInLinkText),

    optInLinkUrl: normalizeUrl(settings.optInLinkUrl),
  };
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")

    .replace(/</g, "&lt;")

    .replace(/>/g, "&gt;")

    .replace(/"/g, "&quot;")

    .replace(/'/g, "&#39;");
}

function buildEmbedCode(form, origin) {
  const base = String(origin || "https://crm.globusdemos.com").replace(
    /\/+$/,
    "",
  );

  const safeTitle = escapeHtml(form?.name || "Web form");

  const query =
    form?.id != null && String(form.id) !== ""
      ? `id=${encodeURIComponent(form.id)}`
      : `slug=${encodeURIComponent(form?.slug || "")}`;

  return [
    "<!-- Globussoft CRM web form -->",

    `<iframe src="${base}/embed/web-form.html?${query}${form?.scope && form.scope !== "generic" ? `&scope=${encodeURIComponent(form.scope)}` : ""}" title="${safeTitle}" style="width:100%;border:0;min-height:760px;" loading="lazy"></iframe>`,
  ].join("\n");
}

async function ensureUniqueSlug(baseSlug, scope = "generic", excludeId = null) {
  const seed = slugify(baseSlug);

  let slug = seed;

  let i = 0;

  while (true) {
    const existing = await prisma.webForm.findFirst({
      where: excludeId
        ? { scope, slug, id: { not: excludeId } }
        : { scope, slug },

      select: { id: true },
    });

    if (!existing) return slug;

    i += 1;

    slug = `${seed}-${Date.now().toString(36)}-${i}`;
  }
}

function shapeForm(row, submissionCount = 0, origin = null, isPublic = false) {
  if (!row) return null;

  const fields = normalizeFields(row.fieldsJson);
  const style = normalizeStyle(row.styleJson);
  const settings = normalizeSettings(row.settingsJson);

  if (isPublic) {
    const payload = {
      id: row.id,
      name: row.name,
      scope: row.scope || "generic",
      slug: row.slug,
      description: row.description,
      isActive: row.isActive,
      fields,
      style,
      settings,
      submissionCount,
    };
    if (origin) payload.embedCode = buildEmbedCode(row, origin);
    return payload;
  }

  const payload = {
    ...row,

    fields,

    style,

    settings,

    submissionCount,
  };

  if (origin) payload.embedCode = buildEmbedCode(row, origin);

  return payload;
}

function readBodyValue(body, key) {
  if (!body || !key) return undefined;

  return body[key];
}

function isTruthyValue(fieldType, raw) {
  if (fieldType === "checkbox") {
    return raw === true || raw === "true" || raw === "1" || raw === "on";
  }

  if (fieldType === "multiselect") {
    if (Array.isArray(raw)) return raw.some((item) => textOr(item));

    if (raw == null) return false;

    return textOr(raw) !== "";
  }

  return textOr(raw) !== "";
}

function coerceCustomFieldValue(def, raw) {
  if (raw == null || raw === "") return null;

  if (def.fieldType === "number") {
    const num = Number(raw);

    return Number.isFinite(num) ? { valueNumber: num } : null;
  }

  if (def.fieldType === "date") {
    const date = new Date(raw);

    return Number.isNaN(date.getTime()) ? null : { valueDate: date };
  }

  if (def.fieldType === "checkbox") {
    return {
      valueBool: raw === true || raw === "true" || raw === "1" || raw === "on",
    };
  }

  if (def.fieldType === "multiselect") {
    const list = Array.isArray(raw) ? raw : [raw];

    const clean = list.map((item) => textOr(item)).filter(Boolean);

    return clean.length ? { valueText: JSON.stringify(clean) } : null;
  }

  if (def.fieldType === "url") {
    const value = textOr(raw);

    if (!value) return null;

    try {
      const url = new URL(value);

      if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;

      return { valueText: value };
    } catch {
      return null;
    }
  }

  return { valueText: textOr(raw).slice(0, 2000) };
}

async function writeLeadCustomFieldValues(
  contactId,
  tenantId,
  customFieldValues,
) {
  const keys = Object.keys(customFieldValues || {});

  if (!keys.length) return;

  const defs = await prisma.leadCustomFieldDefinition.findMany({
    where: { tenantId, fieldKey: { in: keys } },
  });

  const byKey = new Map(defs.map((def) => [def.fieldKey, def]));

  const clearData = {
    valueText: null,
    valueNumber: null,
    valueDate: null,
    valueBool: null,
  };

  for (const key of keys) {
    const def = byKey.get(key);

    if (!def) continue;

    const typed = coerceCustomFieldValue(def, customFieldValues[key]);

    if (!typed) {
      await prisma.leadCustomFieldValue.upsert({
        where: { contactId_fieldId: { contactId, fieldId: def.id } },

        create: { contactId, fieldId: def.id, tenantId, ...clearData },

        update: clearData,
      });

      continue;
    }

    await prisma.leadCustomFieldValue.upsert({
      where: { contactId_fieldId: { contactId, fieldId: def.id } },

      create: { contactId, fieldId: def.id, tenantId, ...clearData, ...typed },

      update: typed,
    });
  }
}

async function listWithCounts(tenantId, scope) {
  const forms = await prisma.webForm.findMany({
    where: { tenantId, scope },

    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const ids = forms.map((form) => form.id);

  let counts = {};

  if (ids.length) {
    const grouped = await prisma.webFormSubmission.groupBy({
      by: ["webFormId"],

      where: { tenantId, webFormId: { in: ids } },

      _count: { _all: true },
    });

    counts = Object.fromEntries(
      grouped.map((row) => [row.webFormId, row._count._all]),
    );
  }

  return forms.map((form) => shapeForm(form, counts[form.id] || 0));
}

// Public routes -------------------------------------------------------------
// Public forms resolve by stable numeric id when the ref is all digits,
// falling back to the legacy slug so previously shared slug links keep working.
async function findPublicForm(ref, scope = "generic") {
  const raw = String(ref || "").trim();

  if (/^\d+$/.test(raw)) {
    const byId = await prisma.webForm.findFirst({
      where: { id: Number(raw), isActive: true },
    });

    if (byId && (byId.scope || "generic") === scope) return byId;
  }

  const slug = slugify(raw);

  if (!slug) return null;

  return prisma.webForm.findFirst({
    where: { slug, scope, isActive: true },
  });
}

router.get("/public/:slug", async (req, res) => {
  try {
    const scope = normalizeScope(req.query?.scope);

    if (!scope)
      return res.status(400).json({ error: "Invalid form scope", code: "INVALID_FORM_SCOPE" });

    const form = await findPublicForm(req.params.slug, scope);

    if (!form)
      return res
        .status(404)
        .json({ error: "Form not found", code: "FORM_NOT_FOUND" });

    const origin = `${req.protocol}://${req.get("host")}`;

    res.json(shapeForm(form, 0, origin, true));
  } catch (err) {
    console.error("[web-forms/public] load error:", err && err.message);

    res.status(500).json({ error: "Failed to load form" });
  }
});

router.post("/public/:slug/submit", upload.any(), async (req, res) => {
  let submitStage = "start";

  try {
    const scope = normalizeScope(req.query?.scope);

    if (!scope)
      return res.status(400).json({ error: "Invalid form scope", code: "INVALID_FORM_SCOPE" });

    submitStage = "load_form";

    submitStage = "load_form";

    const form = await findPublicForm(req.params.slug, scope);

    if (!form)
      return res
        .status(404)
        .json({ error: "Form not found", code: "FORM_NOT_FOUND" });

    submitStage = "normalize_form";

    const fields = normalizeFields(form.fieldsJson);

    const formScope = form.scope || "generic";

    const settings = normalizeSettings(form.settingsJson);

    const body = req.body || {};

    const files = Array.isArray(req.files) ? req.files : [];

    const payload = {};

    const customFieldValues = {};

    const fileRecords = [];

    const contactData = {
      source: formScope === "travel" ? "inbound:web_form" : "website-form",
      status: "Lead",
    };

    const missing = [];

    if (settings.optInEnabled) {
      payload.optInConsent = isTruthyValue("checkbox", body.optInConsent);
    }

    for (const field of fields) {
      if (field.fieldType === "file") {
        if (field.hidden) continue;

        const fieldFiles = files.filter(
          (file) => file.fieldname === field.sourceKey,
        );

        if (field.required && fieldFiles.length === 0)
          missing.push(field.label);

        for (const file of fieldFiles) {
          fileRecords.push({
            fieldKey: field.sourceKey,

            originalName: file.originalname,

            filename: file.filename,

            mimeType: file.mimetype,

            size: file.size,

            url: `/uploads/web-forms/${file.filename}`,
          });
        }

        continue;
      }

      const raw = field.hidden
        ? field.defaultValue
        : readBodyValue(body, field.sourceKey);

      payload[field.sourceKey] = raw == null ? null : raw;

      if (field.required && !isTruthyValue(field.fieldType, raw))
        missing.push(field.label);

      if (
        !CONTACT_FIELDS.has(field.sourceKey) &&
        field.sourceKind === "lead_custom" &&
        !LEAD_CUSTOM_TO_CONTACT[field.sourceKey]
      ) {
        customFieldValues[field.sourceKey] = raw;
      }

      // Web-form fallback customs (the "custom" rows in the Add-field picker
      // — Industry, Job Roles, Organization, No Of Employee, Medium) carry
      // real Contact data, so they write straight to Contact columns instead
      // of being dropped for having no Lead-Field definition. Job title
      // refers to Job title, No Of Employee refers to Company Size, etc.
      if (field.sourceKind === "lead_custom" && LEAD_CUSTOM_TO_CONTACT[field.sourceKey]) {
        const target = LEAD_CUSTOM_TO_CONTACT[field.sourceKey];

        if (target === "source") {
          if (textOr(raw)) contactData.source = textOr(raw);
        } else {
          contactData[target] = textOr(raw) || null;
        }
      }

      if (field.sourceKind === "contact") {
        if (field.sourceKey === "name")
          contactData.name = textOr(raw, contactData.name);
        else if (field.sourceKey === "email") contactData.email = textOr(raw);
        else if (field.sourceKey === "phone") contactData.phone = textOr(raw);
        else if (field.sourceKey === "company")
          contactData.company = textOr(raw);
        else if (field.sourceKey === "title") contactData.title = textOr(raw);
        else if (field.sourceKey === "source")
          contactData.source = textOr(raw, contactData.source);
        else if (field.sourceKey === "status")
          contactData.status = textOr(raw, contactData.status);
        else if (field.sourceKey === "aiScore") {
          const score = Number(raw);

          if (Number.isFinite(score)) contactData.aiScore = score;
        } else if (field.sourceKey === "assignedToId" || field.sourceKey === "assignedTo") {
          const assignedToId = Number(raw);

          if (Number.isInteger(assignedToId) && assignedToId > 0)
            contactData.assignedToId = assignedToId;
          else if (textOr(raw)) contactData.assignedToId = undefined;
        } else if (field.sourceKey === "firstName" || field.sourceKey === "lastName") {
          const part = textOr(raw);
          if (part) {
            const base = textOr(contactData.name, "");
            const baseIsDefault = !base || base === "website-form" || base === "Web form lead";
            contactData._firstName = textOr(contactData._firstName || (field.sourceKey === "firstName" ? part : ""));
            contactData._lastName = textOr(contactData._lastName || (field.sourceKey === "lastName" ? part : ""));
            if (field.sourceKey === "firstName") contactData._firstName = part;
            if (field.sourceKey === "lastName") contactData._lastName = part;
            const combined = [contactData._firstName, contactData._lastName].filter(Boolean).join(" ").trim();
            if (combined && (baseIsDefault || field.sourceKey === "firstName" || field.sourceKey === "lastName")) {
              contactData.name = combined;
            }
          }
        } else if (field.sourceKey === "tags") {
          const list = Array.isArray(raw) ? raw : String(raw == null ? "" : raw).split(",");
          const clean = list.map((t) => textOr(t).slice(0, 60)).filter(Boolean).slice(0, 20);
          if (clean.length) contactData.tagsJson = JSON.stringify(clean);
        } else if (field.sourceKey === "description")
          contactData.description = textOr(raw) || null;
        else if (field.sourceKey === "industry")
          contactData.industry = textOr(raw) || null;
        else if (field.sourceKey === "companySize")
          contactData.companySize = textOr(raw) || null;
        else if (field.sourceKey === "linkedin")
          contactData.linkedin = textOr(raw) || null;
        else if (field.sourceKey === "website")
          contactData.website = textOr(raw) || null;
        else if (field.sourceKey === "firstTouchSource")
          contactData.firstTouchSource = textOr(raw) || null;
        else if (field.sourceKey === "lastTouchSource")
          contactData.lastTouchSource = textOr(raw) || null;
        else if (field.sourceKey === "subBrand")
          contactData.subBrand = textOr(raw) || null;
        else if (field.sourceKey === "treatmentOfInterest")
          contactData.treatmentOfInterest = textOr(raw) || null;
        else if (field.sourceKey === "stateCode")
          contactData.stateCode = textOr(raw) || null;
        else if (field.sourceKey === "billingStateCode")
          contactData.billingStateCode = textOr(raw) || null;
        else if (field.sourceKey === "gst")
          contactData.gst = textOr(raw) || null;
        else if (field.sourceKey === "birthDate") {
          const birthDate = new Date(raw);

          if (!Number.isNaN(birthDate.getTime()))
            contactData.birthDate = birthDate;
        } else if (field.sourceKey === "anniversary") {
          const anniversary = new Date(raw);

          if (!Number.isNaN(anniversary.getTime()))
            contactData.anniversary = anniversary;
        }
      } else if (field.sourceKind === "custom") {
        payload[`custom:${field.sourceKey}`] = raw == null ? null : raw;
      }
    }

    delete contactData._firstName;
    delete contactData._lastName;

    if (missing.length) {
      return res.status(400).json({
        error: `Missing required fields: ${missing.join(", ")}`,

        code: "MISSING_REQUIRED_FIELDS",
      });
    }

    contactData.name = textOr(
      contactData.name,
      contactData.email || contactData.phone || form.name || "Web form lead",
    );

    if (contactData.email === "") contactData.email = null;

    if (contactData.phone === "") contactData.phone = null;

    if (contactData.company === "") contactData.company = null;

    if (contactData.title === "") contactData.title = null;

    if (contactData.source === "")
      contactData.source = formScope === "travel" ? "inbound:web_form" : "website-form";

    submitStage = "validate_assignee";

    if (contactData.assignedToId) {
      const assignee = await prisma.user.findFirst({
        where: {
          id: contactData.assignedToId,
          tenantId: form.tenantId,
          deactivatedAt: null,
        },
      });

      if (!assignee) delete contactData.assignedToId;
    }

    // Auto-assign new Leads to a matching Callified campaign based on the
    // tenant's rule configuration when no campaign was supplied explicitly.
    // Mirrors the logic in contacts.js and external.js.
    if (formScope === "generic" && contactData.status === "Lead" && contactData.callifiedCampaignId == null) {
      try {
        const matchedCampaignId = await evaluateAutoCampaignRules(form.tenantId, contactData, customFieldValues);
        if (matchedCampaignId) {
          contactData.callifiedCampaignId = matchedCampaignId;
        }
      } catch (e) {
        console.error("[web_forms] auto-campaign rule evaluation failed:", e.message);
      }
    }

    let tenantCurrency = "USD";

    if (settings.createDeal) {
      submitStage = "load_tenant_currency";

      const tenant = await prisma.tenant.findUnique({
        where: { id: form.tenantId },

        select: { defaultCurrency: true },
      });

      tenantCurrency = tenant?.defaultCurrency || "USD";
    }

    let contact = null;

    submitStage = "find_existing_contact";

    if (contactData.email) {
      contact = await prisma.contact.findFirst({
        where: { tenantId: form.tenantId, email: contactData.email },
      });
    }

    // Backfill Callified campaign on existing leads when a form re-submission
    // now matches an auto-campaign rule.
    if (formScope === "generic" && contact && contact.callifiedCampaignId == null && contactData.callifiedCampaignId != null) {
      contact = await prisma.contact.update({
        where: { id: contact.id },
        data: { callifiedCampaignId: contactData.callifiedCampaignId },
      });
    }

    if (!contact) {
      submitStage = "create_contact";

      try {
        contact = await prisma.contact.create({
          data: {
            ...contactData,

            tenantId: form.tenantId,
          },
        });
      } catch (err) {
        if (err?.code === "P2002" && contactData.email) {
          contact = await prisma.contact.findFirst({
            where: { tenantId: form.tenantId, email: contactData.email },
          });
        }

        if (!contact) throw err;
      }
    }

    submitStage = "write_custom_fields";

    if (formScope === "generic" && Object.keys(customFieldValues).length) {
      await writeLeadCustomFieldValues(
        contact.id,
        form.tenantId,
        customFieldValues,
      );
    }

    // Auto-dial newly-created web-form Leads that have a Callified campaign + phone
    // when the tenant has enabled auto-dial for new leads. Mirrors external.js.
    if (formScope === "generic" && contact.status === "Lead" && contact.callifiedCampaignId && contact.phone) {
      try {
        const autoDialEnabled = await getSetting(contact.tenantId, KEYS.CALLIFIED_AUTO_DIAL_NEW_LEADS_ENABLED, {
          coerce: (v) => String(v).toLowerCase() !== "false",
        });
        if (autoDialEnabled) {
          const { enqueue } = require("../lib/callifiedAutoDialQueue");
          enqueue({
            tenantId: contact.tenantId,
            contactId: contact.id,
            campaignId: contact.callifiedCampaignId,
            userId: null,
          });
        }
      } catch (_e) {
        console.error("[web_forms] auto-dial enqueue failed:", _e && _e.message);
      }
    }

    let deal = null;

    if (settings.createDeal) {
      submitStage = "create_deal";

      deal = await prisma.deal.create({
        data: {
          title: `${contact.name} - ${form.name}`,

          stage: "lead",

          amount: 0,

          currency: tenantCurrency,

          contactId: contact.id,

          tenantId: form.tenantId,
        },
      });
    }

    submitStage = "save_attachments";

    if (fileRecords.length) {
      for (const file of fileRecords) {
        await prisma.contactAttachment.create({
          data: {
            filename: file.originalName || file.filename,

            fileUrl: file.url,

            fileSize: file.size || null,

            mimeType: file.mimeType || null,

            contactId: contact.id,

            tenantId: form.tenantId,
          },
        });
      }
    }

    submitStage = "create_submission";

    const submission = await prisma.webFormSubmission.create({
      data: {
        webFormId: form.id,

        scope: form.scope || "generic",

        contactId: contact.id,

        payloadJson: JSON.stringify({
          ...payload,

          _meta: {
            sourceUrl: textOr(
              req.get("referer"),
              textOr(req.get("origin"), null),
            ),

            userAgent: textOr(req.get("user-agent"), null),
          },
        }),

        filesJson: fileRecords.length ? JSON.stringify(fileRecords) : null,

        sourceUrl: textOr(req.get("referer"), textOr(req.get("origin"), null)),

        tenantId: form.tenantId,
      },
    });

    submitStage = "send_notification";

    if (settings.notificationEnabled && settings.notificationEmail) {
      const lines = [
        `New web form submission: ${form.name}`,

        `Form slug: ${form.slug}`,

        `Contact: ${contact.name || ""}`,

        contact.email ? `Email: ${contact.email}` : null,

        contact.phone ? `Phone: ${contact.phone}` : null,

        `Submission ID: ${submission.id}`,

        `View public form: ${`${req.protocol}://${req.get("host")}/api/forms/public/${form.slug}?scope=${encodeURIComponent(form.scope || "generic")}`}`,
      ].filter(Boolean);

      sendEmail({
        to: settings.notificationEmail,

        subject: `New web form submission: ${form.name}`,

        text: lines.join("\n"),
      }).catch(() => {});
    }

    const response = {
      success: true,

      submissionId: submission.id,

      contactId: contact.id,

      dealId: deal ? deal.id : null,

      message: settings.successMessage,
    };

    if (settings.afterSubmitAction === "redirect" && settings.redirectUrl) {
      response.redirectUrl = settings.redirectUrl;
    }

    return res.status(201).json(response);
  } catch (err) {
    console.error("[web-forms/public] submit error:", {
      stage: submitStage,
      message: err && err.message,
      code: err && err.code,
      meta: err && err.meta,
    });

    res.status(500).json({
      error: "Failed to submit form",
      code: "WEB_FORM_SUBMIT_FAILED",
      stage: submitStage,
    });
  }
});

// Authenticated CRUD -------------------------------------------------------

router.get("/", verifyToken, async (req, res) => {
  try {
    const scope = requestedScope(req);
    let forms = await listWithCounts(req.user.tenantId, scope);

    if (forms.length === 0) {
      const now = new Date();

      const date = now.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });

      const time = now.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });

      const name = `Untitled form - ${date}, ${time}`;

      const slug = await ensureUniqueSlug(name, scope);

      const form = await prisma.webForm.create({
        data: {
          tenantId: req.user.tenantId,

          scope,

          createdByUserId: req.user.userId,

          name,

          slug,

          description: "",

          isActive: true,

          fieldsJson: JSON.stringify(defaultFields()),

          styleJson: JSON.stringify(defaultStyle()),

          settingsJson: JSON.stringify(defaultSettings()),
        },
      });

      forms = [shapeForm(form, 0, `${req.protocol}://${req.get("host")}`)];
    }

    res.json(forms);
  } catch (err) {
    console.error("[web-forms] list error:", err && err.message);

    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to load forms",
      ...(err.code ? { code: err.code } : {}),
    });
  }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const body = req.body || {};
    const scope = requestedScope(req, body.scope);

    const name = textOr(body.name);

    if (!name) {
      return res
        .status(400)
        .json({ error: "name is required", code: "NAME_REQUIRED" });
    }

    const slug = await ensureUniqueSlug(body.slug || name, scope);

    const form = await prisma.webForm.create({
      data: {
        tenantId: req.user.tenantId,

        scope,

        createdByUserId: req.user.userId,

        name,

        slug,

        description: textOr(body.description),

        isActive: body.isActive !== false,

        fieldsJson: JSON.stringify(normalizeFields(body.fields)),

        styleJson: JSON.stringify(normalizeStyle(body.style)),

        settingsJson: JSON.stringify(normalizeSettings(body.settings)),
      },
    });

    res
      .status(201)
      .json(shapeForm(form, 0, `${req.protocol}://${req.get("host")}`));
  } catch (err) {
    console.error("[web-forms] create error:", err && err.message);

    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to create form",
      ...(err.code ? { code: err.code } : {}),
    });
  }
});

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const scope = requestedScope(req);
    const id = parseInt(req.params.id, 10);

    if (!Number.isFinite(id)) {
      return res
        .status(400)
        .json({ error: "Invalid form id", code: "INVALID_FORM_ID" });
    }

    const form = await prisma.webForm.findFirst({
      where: { id, tenantId: req.user.tenantId, scope },
    });

    if (!form)
      return res
        .status(404)
        .json({ error: "Form not found", code: "FORM_NOT_FOUND" });

    res.json(shapeForm(form, 0, `${req.protocol}://${req.get("host")}`));
  } catch (err) {
    console.error("[web-forms] get error:", err && err.message);

    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to load form",
      ...(err.code ? { code: err.code } : {}),
    });
  }
});

router.put("/:id", verifyToken, async (req, res) => {
  try {
    const scope = requestedScope(req);
    const id = parseInt(req.params.id, 10);

    if (!Number.isFinite(id)) {
      return res
        .status(400)
        .json({ error: "Invalid form id", code: "INVALID_FORM_ID" });
    }

    const existing = await prisma.webForm.findFirst({
      where: { id, tenantId: req.user.tenantId, scope },
    });

    if (!existing)
      return res
        .status(404)
        .json({ error: "Form not found", code: "FORM_NOT_FOUND" });

    const body = req.body || {};

    const data = {};

    if (body.name !== undefined) {
      const name = String(body.name == null ? "" : body.name).trim();

      data.name = name;
    }

    if (body.slug !== undefined) {
      const slug = await ensureUniqueSlug(body.slug || existing.slug, scope, existing.id);

      data.slug = slug;
    }
    // NOTE: slug is intentionally NOT regenerated from name. Public share links
    // prefer the stable numeric id (see buildPublicUrl), and auto-regenerating
    // the slug on rename broke every previously shared URL.

    if (body.description !== undefined)
      data.description = textOr(body.description);

    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);

    if (body.fields !== undefined)
      data.fieldsJson = JSON.stringify(normalizeFields(body.fields));

    if (body.style !== undefined)
      data.styleJson = JSON.stringify(normalizeStyle(body.style));

    if (body.settings !== undefined)
      data.settingsJson = JSON.stringify(normalizeSettings(body.settings));

    const updated = await prisma.webForm.update({
      where: { id: existing.id },
      data,
    });

    res.json(
      shapeForm(
        updated,
        existing.submissionCount || 0,
        `${req.protocol}://${req.get("host")}`,
      ),
    );
  } catch (err) {
    console.error("[web-forms] update error:", err && err.message);

    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to update form",
      ...(err.code ? { code: err.code } : {}),
    });
  }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const scope = requestedScope(req);
    const id = parseInt(req.params.id, 10);

    if (!Number.isFinite(id)) {
      return res
        .status(400)
        .json({ error: "Invalid form id", code: "INVALID_FORM_ID" });
    }

    const existing = await prisma.webForm.findFirst({
      where: { id, tenantId: req.user.tenantId, scope },
    });

    if (!existing)
      return res
        .status(404)
        .json({ error: "Form not found", code: "FORM_NOT_FOUND" });

    await prisma.webForm.delete({ where: { id: existing.id } });

    res.json({ success: true });
  } catch (err) {
    console.error("[web-forms] delete error:", err && err.message);

    res.status(err.statusCode || 500).json({
      error: err.statusCode ? err.message : "Failed to delete form",
      ...(err.code ? { code: err.code } : {}),
    });
  }
});

module.exports = router;

module.exports.buildEmbedCode = buildEmbedCode;

module.exports.defaultFields = defaultFields;

module.exports.defaultStyle = defaultStyle;

module.exports.defaultSettings = defaultSettings;
