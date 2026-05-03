const express = require("express");
const sanitizeHtml = require("sanitize-html");
const { verifyToken } = require("../middleware/auth");
const { writeAudit, diffFields } = require("../lib/audit");

const router = express.Router();
const prisma = require("../lib/prisma");

// Strip HTML and trim. Mirrors the sanitizer used by routes/sequences.js so
// `<script>…</script>` style payloads can never be persisted.
const ENTITY_DECODE_RE = /&(amp|lt|gt|quot|#x27|#39);/g;
const ENTITY_DECODE_MAP = {
  amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'",
};
const sanitizeText = (input) => {
  if (typeof input !== "string") return input;
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
    textFilter: (text) => text.replace(ENTITY_DECODE_RE, (_, e) => ENTITY_DECODE_MAP[e] || _),
  }).trim();
};

// Shared validators for create + update so a rename via PUT can't slip past
// what POST enforces. Returns null on success, or { status, body } on failure.
const NAME_MIN = 1;
const NAME_MAX = 100;
const ALLOWED_FIELD_TYPES = new Set(["Text", "Number", "Boolean", "Date"]);

function validateEntityPayload({ name, description, fields }, { partial }) {
  if (!partial || name !== undefined) {
    if (typeof name !== "string") {
      return { status: 400, body: { error: "Entity name is required.", code: "INVALID_ENTITY" } };
    }
    const cleanName = sanitizeText(name);
    if (cleanName.length < NAME_MIN || cleanName.length > NAME_MAX) {
      return {
        status: 400,
        body: {
          error: `Entity name must be ${NAME_MIN}-${NAME_MAX} characters.`,
          code: "INVALID_ENTITY",
        },
      };
    }
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    return { status: 400, body: { error: "description must be a string.", code: "INVALID_ENTITY" } };
  }
  if (fields !== undefined) {
    if (!Array.isArray(fields)) {
      return { status: 400, body: { error: "fields must be an array.", code: "INVALID_ENTITY" } };
    }
    for (const f of fields) {
      if (!f || typeof f !== "object" || typeof f.name !== "string" || !sanitizeText(f.name)) {
        return { status: 400, body: { error: "Each field needs a non-empty name.", code: "INVALID_ENTITY" } };
      }
      if (f.type !== undefined && !ALLOWED_FIELD_TYPES.has(f.type)) {
        return {
          status: 400,
          body: {
            error: `Field type must be one of: ${[...ALLOWED_FIELD_TYPES].join(", ")}.`,
            code: "INVALID_ENTITY",
          },
        };
      }
    }
  }
  return null;
}

// Get all Custom Entities (Settings Schema Viewer)
router.get("/entities", verifyToken, async (req, res) => {
  try {
    const list = await prisma.customEntity.findMany({ where: { tenantId: req.user.tenantId }, include: { fields: true }});
    res.json(list);
  } catch(_err) {
    res.status(500).json({ error: "Failed to read EAV entity schema mapping." });
  }
});

// Create new Entity Type & Fields
router.post("/entities", verifyToken, async (req, res) => {
  try {
    const { name, description, fields } = req.body; // fields: [{name, type}]

    const validationError = validateEntityPayload(
      { name, description, fields: fields ?? [] },
      { partial: false }
    );
    if (validationError) return res.status(validationError.status).json(validationError.body);

    const cleanName = sanitizeText(name);
    const cleanDescription =
      description === undefined || description === null ? description : sanitizeText(description);
    const cleanFields = Array.isArray(fields)
      ? fields.map((f) => ({ name: sanitizeText(f.name), type: f.type || "Text" }))
      : [];

    // Prisma nested creation pipeline
    const entity = await prisma.customEntity.create({
      data: {
        name: cleanName,
        description: cleanDescription,
        tenantId: req.user.tenantId,
        fields: {
          create: cleanFields,
        },
      },
      include: { fields: true },
    });
    res.status(201).json(entity);
  } catch(err) {
    // P2002 = unique constraint (tenantId, name). Surface as 409 instead of 500.
    if (err && err.code === "P2002") {
      return res.status(409).json({
        error: "An entity with that name already exists.",
        code: "ENTITY_NAME_TAKEN",
      });
    }
    res.status(500).json({ error: "Custom Object Schema mutation failed" });
  }
});

// Get a single Custom Entity by id (tenant-scoped)
router.get("/entities/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id < 1) {
      return res.status(400).json({ error: "id must be a positive integer", code: "INVALID_ID" });
    }
    const entity = await prisma.customEntity.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { fields: true },
    });
    if (!entity) return res.status(404).json({ error: "Entity not found" });
    res.json(entity);
  } catch (_err) {
    res.status(500).json({ error: "Failed to fetch entity" });
  }
});

// Update a Custom Entity (name + description). Field mutations are out of scope —
// the App Builder shows fields read-only after creation and a separate flow will
// handle add/remove/rename of EAV columns (those affect existing CustomValue rows).
router.put("/entities/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id < 1) {
      return res.status(400).json({ error: "id must be a positive integer", code: "INVALID_ID" });
    }

    // Tenant-scoped existence check — cross-tenant id returns 404, not 403.
    // stripDangerous middleware already removed id/tenantId/createdAt from req.body.
    const existing = await prisma.customEntity.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Entity not found" });

    const { name, description } = req.body;

    const validationError = validateEntityPayload(
      { name, description },
      { partial: true }
    );
    if (validationError) return res.status(validationError.status).json(validationError.body);

    const data = {};
    if (name !== undefined) data.name = sanitizeText(name);
    if (description !== undefined) {
      data.description = description === null ? null : sanitizeText(description);
    }

    let updated;
    try {
      updated = await prisma.customEntity.update({
        where: { id: existing.id },
        data,
        include: { fields: true },
      });
    } catch (err) {
      if (err && err.code === "P2002") {
        return res.status(409).json({
          error: "An entity with that name already exists.",
          code: "ENTITY_NAME_TAKEN",
        });
      }
      throw err;
    }

    // Audit: only log the diff of fields the caller actually changed.
    const changes = diffFields(existing, updated, ["name", "description"]);
    if (Object.keys(changes).length > 0) {
      await writeAudit(
        "CustomEntity",
        "UPDATE",
        updated.id,
        req.user.userId,
        req.user.tenantId,
        { changes }
      );
    }

    res.json(updated);
  } catch (_err) {
    res.status(500).json({ error: "Failed to update entity" });
  }
});

// Delete a Custom Entity. Refuses (409) if any CustomRecord rows exist —
// silent cascade would erase business data. Caller must delete records first
// or migrate them. Future opt-in: ?cascade=true (out of scope here).
router.delete("/entities/:id", verifyToken, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id < 1) {
      return res.status(400).json({ error: "id must be a positive integer", code: "INVALID_ID" });
    }

    const existing = await prisma.customEntity.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Entity not found" });

    const recordCount = await prisma.customRecord.count({
      where: { entityId: existing.id, tenantId: req.user.tenantId },
    });
    if (recordCount > 0) {
      return res.status(409).json({
        error: `Cannot delete entity with ${recordCount} existing record${recordCount === 1 ? "" : "s"} — delete the records first or migrate them.`,
        code: "ENTITY_HAS_RECORDS",
        recordCount,
      });
    }

    // Audit BEFORE the delete so the trail survives a failed delete downstream.
    await writeAudit(
      "CustomEntity",
      "DELETE",
      existing.id,
      req.user.userId,
      req.user.tenantId,
      { name: existing.name, description: existing.description }
    );

    // CustomField has onDelete: Cascade in schema.prisma, so the field rows go
    // with the entity automatically. CustomRecord cascade is moot (count is 0).
    await prisma.customEntity.delete({ where: { id: existing.id } });

    res.json({ success: true });
  } catch (_err) {
    res.status(500).json({ error: "Failed to delete entity" });
  }
});

// Fetch all Custom Records for a specific Entity Name mapping
router.get("/records/:entityName", verifyToken, async (req, res) => {
  try {
    const entity = await prisma.customEntity.findFirst({
      where: { name: req.params.entityName, tenantId: req.user.tenantId },
      include: { fields: true }
    });

    if (!entity) return res.status(404).json({ error: "Entity definition missing." });

    // Fetch generic rows mapping values back to the EAV dictionary
    const records = await prisma.customRecord.findMany({
      where: { entityId: entity.id, tenantId: req.user.tenantId },
      include: { values: { include: { field: true } } }
    });

    // Transformation format for React UI tables
    const formatted = records.map(r => {
      const row = { id: r.id, createdAt: r.createdAt };
      r.values.forEach(v => {
        const valType = v.field.type;
        row[v.field.name] = (valType === 'Number' ? v.valueNum : valType === 'Boolean' ? v.valueBool : valType === 'Date' ? v.valueDate : v.valueStr);
      });
      return row;
    });

    res.json({ entity, records: formatted });
  } catch(_err) {
    res.status(500).json({ error: "Record query compilation failed." });
  }
});

// Create a new Custom Record Instance within EAV Table
router.post("/records/:entityName", verifyToken, async (req, res) => {
  try {
    const entity = await prisma.customEntity.findFirst({
      where: { name: req.params.entityName, tenantId: req.user.tenantId },
      include: { fields: true }
    });

    if (!entity) return res.status(404).json({ error: "Entity constraint violation." });

    const payload = req.body; // { "License Plate": "ABC", "Wheels": 4 }

    const valuesData = entity.fields.map(field => {
      const val = payload[field.name];
      const out = { fieldId: field.id };
      if (field.type === 'Number') out.valueNum = parseFloat(val);
      else if (field.type === 'Boolean') out.valueBool = Boolean(val);
      else out.valueStr = val ? val.toString() : '';
      return out;
    });

    const record = await prisma.customRecord.create({
      data: {
        entityId: entity.id,
        tenantId: req.user.tenantId,
        values: { create: valuesData }
      }
    });

    res.status(201).json(record);
  } catch(_err) {
    res.status(500).json({ error: "Dynamic allocation row creation failed." });
  }
});

module.exports = router;
