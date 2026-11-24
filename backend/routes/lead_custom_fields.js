// Lead Custom Fields — admin-configurable extra fields on Contact/Lead
// records (generic and travel verticals; see Settings > Lead Fields).
//
// Purpose-built for Contact/Lead, deliberately NOT built on the existing
// generic CustomEntity/CustomField/CustomValue EAV system (routes/
// custom_objects.js) — kept isolated so this feature has zero shared blast
// radius with whatever else uses those tables. See the model comment above
// LeadCustomFieldDefinition in prisma/schema.prisma for the full rationale.
//
// Definitions (this file) are ADMIN-only. Reading/writing a lead's actual
// custom-field VALUES happens inline in routes/contacts.js (create/update/
// get), keyed by fieldKey, so a value round-trips through the normal
// Contact create/update/get calls rather than a separate endpoint.

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");

const adminOnly = [verifyToken, verifyRole(["ADMIN"])];

// Definitions and values are tenant-scoped, but keep the vertical boundary
// explicit as well. This prevents a Wellness tenant (or a future unsupported
// vertical) from using the Generic/Travel field-management surface directly.
router.use(async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { vertical: true },
    });
    if (!tenant || !["generic", "travel"].includes(tenant.vertical)) {
      return res.status(403).json({
        error: "Lead custom fields are only available for the generic and travel CRM verticals",
        code: "VERTICAL_NOT_SUPPORTED",
      });
    }
    res.locals.tenantVertical = tenant.vertical;
    next();
  } catch (err) {
    console.error("[lead-custom-fields] vertical-check error:", err && err.message);
    res.status(500).json({ error: "Failed to verify tenant vertical" });
  }
});

const VALID_FIELD_TYPES = new Set(["text", "textarea", "number", "dropdown", "radio", "date", "url", "checkbox", "multiselect"]);
const FIELD_TYPES_WITH_OPTIONS = new Set(["dropdown", "radio", "multiselect"]);
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,49}$/;

function slugifyLabel(label) {
  return String(label || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
}

// Generic CRM built-in fields and custom fields share several consumers that
// address fields by key (Leads columns, Web Forms, imports, and quick-add).
// A custom definition using one of these keys would shadow the built-in field
// in key-indexed consumers. Include both canonical keys and displayed aliases
// so labels such as "Full name" cannot recreate the built-in `name` field.
const GENERIC_RESERVED_FIELD_KEYS = new Set([
  "name", "full name", "email", "phone", "mobile", "whatsappPhone", "whatsapp number", "whatsapp phone",
  "company", "aiScore", "lead score", "source", "webForm", "web form", "lifecycleStage", "lifecycleStageKey",
  "lifecycle stage", "medium", "location", "pickupLocation", "pickup location", "plotAssign", "plot assign",
  "overallPickupStatus", "overall status", "tags", "assignedTo", "assignedToId", "assigned to", "sales owner",
  "createdAt", "created", "campaign", "callified campaign", "callStatus", "call status", "callifiedAi",
  "callified ai call", "callifiedScore", "callified score", "status", "title", "job title", "firstName",
  "first name", "lastName", "last name", "website", "website url", "linkedin", "industry", "service type",
  "companySize", "company size", "no of employee", "subBrand", "sub-brand", "description", "note", "stateCode",
  "state", "lastUpdated", "last updated", "firstTouchSource", "first touch source", "lastTouchSource",
  "last touch source", "pageUrl", "page url", "pageTitle", "page title", "pageSource", "page source",
  "referrerUrl", "referrer url", "landingPageUrl", "landing page url", "currentDomain", "current domain",
  "formName", "form name", "utm_source", "utm source", "utm_medium", "utm medium", "utm_campaign",
  "utm campaign", "utm_id", "utm id", "utm_term", "utm term", "utm_content", "utm content", "gclid",
  "google click id", "gbraid", "google braid id", "wbraid", "google wbraid id", "fbclid", "meta click id",
  "fbc", "meta click cookie", "fbp", "meta browser id", "campaign_id", "campaign id", "adset_id", "ad set id",
  "ad_id", "ad id", "campaign_name", "campaign name", "adset_name", "ad set name", "ad_name", "ad name",
  "placement", "site_source_name", "site source name", "submittedAt", "submission timestamp", "browser",
  "operatingSystem", "operating system", "deviceType", "device type", "treatmentOfInterest",
  "treatment of interest", "birthDate", "birth date", "anniversary", "gst", "gstin", "billingStateCode",
  "billing state code", "actions",
].map(slugifyLabel));

// GET /api/lead-custom-fields — list this tenant's field definitions.
// Open to all authenticated roles (USER/MANAGER need this to render the
// Lead create/edit form) — only mutation is admin-gated.
router.get("/", async (req, res) => {
  try {
    const paginationRequested = req.query.page !== undefined || req.query.offset !== undefined || req.query.limit !== undefined;
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 25;
    const parsedPage = Number.parseInt(req.query.page, 10);
    const page = Number.isFinite(parsedPage) ? Math.max(parsedPage, 1) : 1;
    const parsedOffset = Number.parseInt(req.query.offset, 10);
    const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : (page - 1) * limit;
    const where = { tenantId: req.user.tenantId };
    const [rows, total] = await Promise.all([
      prisma.leadCustomFieldDefinition.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
        ...(paginationRequested ? { skip: offset, take: limit } : {}),
      }),
      paginationRequested ? prisma.leadCustomFieldDefinition.count({ where }) : Promise.resolve(null),
    ]);
    const withParsedOptions = rows.map((r) => ({
      ...r,
      options: Array.isArray(r.options) ? r.options : (r.options ? JSON.parse(r.options) : null),
    }));
    if (paginationRequested) {
      return res.json({ data: withParsedOptions, total, page, offset, limit });
    }
    res.json(withParsedOptions);
  } catch (err) {
    console.error("[lead-custom-fields] list error:", err && err.message);
    res.status(500).json({ error: "Failed to load lead custom fields" });
  }
});

// POST /api/lead-custom-fields — create a new field definition (ADMIN only)
router.post("/", adminOnly, async (req, res) => {
  try {
    const { label, fieldType, options, isRequired, tooltip, placeholder } = req.body || {};

    const trimmedLabel = typeof label === "string" ? label.trim() : "";
    if (!trimmedLabel) {
      return res.status(400).json({ error: "label is required", code: "LABEL_REQUIRED" });
    }
    if (trimmedLabel.length > 80) {
      return res.status(400).json({ error: "label must be 80 characters or fewer", code: "LABEL_TOO_LONG" });
    }
    if (!VALID_FIELD_TYPES.has(fieldType)) {
      return res.status(400).json({
        error: `fieldType must be one of: ${[...VALID_FIELD_TYPES].join(", ")}`,
        code: "INVALID_FIELD_TYPE",
      });
    }

    let optionsJson = null;
    if (FIELD_TYPES_WITH_OPTIONS.has(fieldType)) {
      if (!Array.isArray(options) || options.length === 0) {
        return res.status(400).json({
          error: "options (a non-empty array of strings) is required for this field type",
          code: "OPTIONS_REQUIRED",
        });
      }
      const cleanOptions = options
        .map((o) => String(o).trim())
        .filter(Boolean)
        .slice(0, 50);
      if (!cleanOptions.length) {
        return res.status(400).json({ error: "options must contain at least one non-empty value", code: "OPTIONS_REQUIRED" });
      }
      optionsJson = JSON.stringify(cleanOptions);
    }

    const fieldKey = slugifyLabel(trimmedLabel);
    if (!fieldKey || !FIELD_KEY_RE.test(fieldKey)) {
      return res.status(400).json({
        error: "label must contain at least one letter to derive a valid field key",
        code: "INVALID_FIELD_KEY",
      });
    }

    if (res.locals.tenantVertical === "generic" && GENERIC_RESERVED_FIELD_KEYS.has(fieldKey)) {
      return res.status(409).json({
        error: "A built-in field with this name already exists",
        code: "RESERVED_FIELD_KEY",
      });
    }

    const existing = await prisma.leadCustomFieldDefinition.findUnique({
      where: { tenantId_fieldKey: { tenantId: req.user.tenantId, fieldKey } },
    });
    if (existing) {
      return res.status(409).json({
        error: "A field with this label (or one that produces the same key) already exists",
        code: "DUPLICATE_FIELD_KEY",
      });
    }

    const maxOrder = await prisma.leadCustomFieldDefinition.aggregate({
      where: { tenantId: req.user.tenantId },
      _max: { displayOrder: true },
    });

    const created = await prisma.leadCustomFieldDefinition.create({
      data: {
        tenantId: req.user.tenantId,
        fieldKey,
        label: trimmedLabel,
        fieldType,
        options: optionsJson,
        tooltip: typeof tooltip === "string" ? tooltip.trim().slice(0, 255) || null : null,
        placeholder: typeof placeholder === "string" ? placeholder.trim().slice(0, 255) || null : null,
        isRequired: Boolean(isRequired),
        displayOrder: (maxOrder?._max?.displayOrder ?? 0) + 1,
      },
    });

    res.status(201).json({ ...created, options: optionsJson ? JSON.parse(optionsJson) : null });
  } catch (err) {
    if (err?.code === "P2002") {
      return res.status(409).json({
        error: "A field with this name already exists",
        code: "DUPLICATE_FIELD_KEY",
      });
    }
    console.error("[lead-custom-fields] create error:", err && err.message);
    res.status(500).json({ error: "Failed to create lead custom field" });
  }
});

// POST /api/lead-custom-fields/:id/move — move one definition by one position.
// Reordering is resolved against the complete tenant-scoped list so moving the
// first/last row on a paginated screen also swaps with the adjacent page.
router.post("/:id/move", adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid field id", code: "INVALID_ID" });

    const direction = req.body?.direction;
    if (!["up", "down"].includes(direction)) {
      return res.status(400).json({ error: "direction must be up or down", code: "INVALID_DIRECTION" });
    }

    const definitions = await prisma.leadCustomFieldDefinition.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
    });
    const currentIndex = definitions.findIndex((definition) => definition.id === id);
    if (currentIndex < 0) return res.status(404).json({ error: "Field not found", code: "NOT_FOUND" });

    const targetIndex = currentIndex + (direction === "up" ? -1 : 1);
    if (targetIndex < 0 || targetIndex >= definitions.length) {
      return res.json({ moved: false });
    }

    const reordered = [...definitions];
    [reordered[currentIndex], reordered[targetIndex]] = [reordered[targetIndex], reordered[currentIndex]];
    await prisma.$transaction(
      reordered.map((definition, index) => prisma.leadCustomFieldDefinition.update({
        where: { id: definition.id },
        data: { displayOrder: index + 1 },
      })),
    );
    res.json({ moved: true });
  } catch (err) {
    console.error("[lead-custom-fields] move error:", err && err.message);
    res.status(500).json({ error: "Failed to reorder lead custom field" });
  }
});

// PUT /api/lead-custom-fields/:id — update label/options/required/order (ADMIN only)
// fieldType and fieldKey are immutable after creation — changing a field's
// type after values have been stored against it would silently orphan or
// misinterpret existing LeadCustomFieldValue rows, so a rename-in-place is
// not offered; an admin who needs a different type creates a new field.
router.put("/:id", adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid field id" });

    const existing = await prisma.leadCustomFieldDefinition.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Field not found" });

    const { label, options, isRequired, displayOrder, tooltip, placeholder } = req.body || {};
    const data = {};

    if (label !== undefined) {
      const trimmedLabel = String(label).trim();
      if (!trimmedLabel) return res.status(400).json({ error: "label cannot be empty", code: "LABEL_REQUIRED" });
      if (trimmedLabel.length > 80) return res.status(400).json({ error: "label must be 80 characters or fewer", code: "LABEL_TOO_LONG" });
      data.label = trimmedLabel;
    }
    if (options !== undefined) {
      if (!FIELD_TYPES_WITH_OPTIONS.has(existing.fieldType)) {
        return res.status(400).json({ error: "options can only be set on fields with choices", code: "NOT_A_CHOICE_FIELD" });
      }
      const cleanOptions = Array.isArray(options)
        ? options.map((o) => String(o).trim()).filter(Boolean).slice(0, 50)
        : [];
      if (!cleanOptions.length) {
        return res.status(400).json({ error: "options must contain at least one non-empty value", code: "OPTIONS_REQUIRED" });
      }
      data.options = JSON.stringify(cleanOptions);
    }
    if (tooltip !== undefined) {
      data.tooltip = typeof tooltip === "string" ? tooltip.trim().slice(0, 255) || null : null;
    }
    if (placeholder !== undefined) {
      data.placeholder = typeof placeholder === "string" ? placeholder.trim().slice(0, 255) || null : null;
    }
    if (isRequired !== undefined) data.isRequired = Boolean(isRequired);
    if (displayOrder !== undefined && Number.isFinite(Number(displayOrder))) {
      data.displayOrder = Number(displayOrder);
    }

    const updated = await prisma.leadCustomFieldDefinition.update({ where: { id }, data });
    res.json({ ...updated, options: updated.options ? JSON.parse(updated.options) : null });
  } catch (err) {
    console.error("[lead-custom-fields] update error:", err && err.message);
    res.status(500).json({ error: "Failed to update lead custom field" });
  }
});

// DELETE /api/lead-custom-fields/:id — remove a field definition (ADMIN only).
// Cascades to LeadCustomFieldValue rows (onDelete: Cascade in schema) — a
// deleted field's stored values are removed too, not left orphaned. Generic
// web forms store their selected fields as JSON, so remove the deleted field
// from those snapshots in the same transaction as well.
router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid field id" });

    const existing = await prisma.leadCustomFieldDefinition.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Field not found" });

    const formUpdates = [];
    if (res.locals.tenantVertical === "generic") {
      const forms = await prisma.webForm.findMany({
        where: { tenantId: req.user.tenantId, scope: "generic" },
        select: { id: true, fieldsJson: true },
      });

      for (const form of forms) {
        let fields;
        try {
          fields = JSON.parse(form.fieldsJson);
        } catch (_err) {
          continue;
        }
        if (!Array.isArray(fields)) continue;

        const removedIds = new Set(fields
          .filter((field) => field?.sourceKind === "lead_custom" && field?.sourceKey === existing.fieldKey)
          .map((field) => String(field.id || ""))
          .filter(Boolean));
        const remainingFields = fields
          .filter((field) => !(field?.sourceKind === "lead_custom" && field?.sourceKey === existing.fieldKey))
          .map((field) => {
            const condition = field?.showWhen;
            if (!condition) return field;
            const referencesDeletedField = condition.fieldKey === existing.fieldKey ||
              (condition.fieldId != null && removedIds.has(String(condition.fieldId)));
            return referencesDeletedField ? { ...field, showWhen: null } : field;
          });

        if (remainingFields.length !== fields.length) {
          formUpdates.push(prisma.webForm.update({
            where: { id: form.id },
            data: { fieldsJson: JSON.stringify(remainingFields) },
          }));
        }
      }
    }

    await prisma.$transaction([
      ...formUpdates,
      prisma.leadCustomFieldDefinition.delete({ where: { id } }),
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("[lead-custom-fields] delete error:", err && err.message);
    res.status(500).json({ error: "Failed to delete lead custom field" });
  }
});

module.exports = router;
