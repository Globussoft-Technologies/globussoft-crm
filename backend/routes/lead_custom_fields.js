// Lead Custom Fields — admin-configurable extra fields on Contact/Lead
// records (generic vertical only; see Settings > Lead Fields).
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

// GET /api/lead-custom-fields — list this tenant's field definitions.
// Open to all authenticated roles (USER/MANAGER need this to render the
// Lead create/edit form) — only mutation is admin-gated.
router.get("/", async (req, res) => {
  try {
    const rows = await prisma.leadCustomFieldDefinition.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
    });
    const withParsedOptions = rows.map((r) => ({
      ...r,
      options: r.options ? JSON.parse(r.options) : null,
    }));
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
    console.error("[lead-custom-fields] create error:", err && err.message);
    res.status(500).json({ error: "Failed to create lead custom field" });
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
// deleted field's stored values are removed too, not left orphaned.
router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid field id" });

    const existing = await prisma.leadCustomFieldDefinition.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Field not found" });

    await prisma.leadCustomFieldDefinition.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("[lead-custom-fields] delete error:", err && err.message);
    res.status(500).json({ error: "Failed to delete lead custom field" });
  }
});

module.exports = router;
