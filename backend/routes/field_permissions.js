const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");

const tenantId = (req) => req.user?.tenantId || 1;

// Supported entities + fields registry
const ENTITY_FIELDS = {
  Deal: ["title", "amount", "currency", "probability", "stage", "expectedClose", "ownerId", "lostReason"],
  Contact: ["name", "email", "phone", "company", "title", "status", "source", "aiScore", "industry", "linkedin"],
  Invoice: ["amount", "status", "dueDate"],
  Quote: ["totalAmount", "mrr", "status"],
};

const SUPPORTED_ROLES = ["ADMIN", "MANAGER", "USER"];

// GET /api/field-permissions/entities — registry of supported entities + fields
router.get("/entities", verifyToken, async (_req, res) => {
  res.json(ENTITY_FIELDS);
});

// GET /api/field-permissions/effective?role=USER&entity=Deal
// Returns { field: { canRead, canWrite } } — defaults to full access when no rule exists
router.get("/effective", verifyToken, async (req, res) => {
  try {
    const role = String(req.query.role || "").toUpperCase();
    const entity = String(req.query.entity || "");
    if (!SUPPORTED_ROLES.includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (!ENTITY_FIELDS[entity]) {
      return res.status(400).json({ error: "Unsupported entity" });
    }
    const rules = await prisma.fieldPermission.findMany({
      where: { role, entity, tenantId: tenantId(req) },
    });
    const ruleByField = {};
    rules.forEach((r) => {
      ruleByField[r.field] = { canRead: r.canRead, canWrite: r.canWrite };
    });
    const out = {};
    ENTITY_FIELDS[entity].forEach((f) => {
      out[f] = ruleByField[f] || { canRead: true, canWrite: true };
    });
    res.json(out);
  } catch (err) {
    console.error("[FieldPermissions][effective]", err);
    res.status(500).json({ error: "Failed to compute effective permissions" });
  }
});

// GET /api/field-permissions — list all rules for tenant, grouped by entity
router.get("/", verifyToken, async (req, res) => {
  try {
    const rules = await prisma.fieldPermission.findMany({
      where: { tenantId: tenantId(req) },
      orderBy: [{ entity: "asc" }, { role: "asc" }, { field: "asc" }],
    });
    const grouped = {};
    rules.forEach((r) => {
      if (!grouped[r.entity]) grouped[r.entity] = [];
      grouped[r.entity].push({
        id: r.id,
        role: r.role,
        field: r.field,
        canRead: r.canRead,
        canWrite: r.canWrite,
      });
    });
    res.json(grouped);
  } catch (err) {
    console.error("[FieldPermissions][list]", err);
    res.status(500).json({ error: "Failed to fetch field permissions" });
  }
});

// POST /api/field-permissions — upsert a single rule (admin only)
router.post("/", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { role, entity, field, canRead, canWrite } = req.body || {};
    if (!role || !entity || !field) {
      return res.status(400).json({ error: "role, entity and field are required" });
    }
    const roleUp = String(role).toUpperCase();
    if (!SUPPORTED_ROLES.includes(roleUp)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (!ENTITY_FIELDS[entity]) {
      return res.status(400).json({ error: "Unsupported entity" });
    }
    if (!ENTITY_FIELDS[entity].includes(field)) {
      return res.status(400).json({ error: `Field '${field}' is not supported on ${entity}` });
    }
    const tid = tenantId(req);
    const rule = await prisma.fieldPermission.upsert({
      where: {
        role_entity_field_tenantId: {
          role: roleUp,
          entity,
          field,
          tenantId: tid,
        },
      },
      update: {
        canRead: canRead !== undefined ? Boolean(canRead) : undefined,
        canWrite: canWrite !== undefined ? Boolean(canWrite) : undefined,
      },
      create: {
        role: roleUp,
        entity,
        field,
        canRead: canRead !== undefined ? Boolean(canRead) : true,
        canWrite: canWrite !== undefined ? Boolean(canWrite) : true,
        tenantId: tid,
      },
    });
    res.status(201).json(rule);
  } catch (err) {
    console.error("[FieldPermissions][create]", err);
    res.status(500).json({ error: "Failed to upsert field permission" });
  }
});

// POST /api/field-permissions/bulk-update — upsert multiple rules (admin only)
router.post("/bulk-update", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { rules } = req.body || {};
    if (!Array.isArray(rules)) {
      return res.status(400).json({ error: "rules array is required" });
    }
    const tid = tenantId(req);
    const results = [];
    const errors = [];

    for (const raw of rules) {
      const roleUp = String(raw.role || "").toUpperCase();
      const entity = raw.entity;
      const field = raw.field;
      if (!SUPPORTED_ROLES.includes(roleUp) || !ENTITY_FIELDS[entity] || !ENTITY_FIELDS[entity].includes(field)) {
        errors.push({ role: roleUp, entity, field, error: "invalid role/entity/field" });
        continue;
      }
      try {
        const rule = await prisma.fieldPermission.upsert({
          where: {
            role_entity_field_tenantId: { role: roleUp, entity, field, tenantId: tid },
          },
          update: {
            canRead: Boolean(raw.canRead),
            canWrite: Boolean(raw.canWrite),
          },
          create: {
            role: roleUp,
            entity,
            field,
            canRead: Boolean(raw.canRead),
            canWrite: Boolean(raw.canWrite),
            tenantId: tid,
          },
        });
        results.push(rule);
      } catch (e) {
        console.error("[FieldPermissions][bulk][row]", e);
        errors.push({ role: roleUp, entity, field, error: e.message });
      }
    }

    res.json({ updated: results.length, errors, rules: results });
  } catch (err) {
    console.error("[FieldPermissions][bulk]", err);
    res.status(500).json({ error: "Bulk update failed" });
  }
});

// PUT /api/field-permissions/:id — update (admin, tenant-scoped)
router.put("/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.fieldPermission.findFirst({
      where: { id, tenantId: tenantId(req) },
    });
    if (!existing) return res.status(404).json({ error: "Field permission not found" });

    const { canRead, canWrite } = req.body || {};
    const data = {};
    if (canRead !== undefined) data.canRead = Boolean(canRead);
    if (canWrite !== undefined) data.canWrite = Boolean(canWrite);

    const rule = await prisma.fieldPermission.update({ where: { id }, data });
    res.json(rule);
  } catch (err) {
    console.error("[FieldPermissions][update]", err);
    res.status(500).json({ error: "Failed to update field permission" });
  }
});

// DELETE /api/field-permissions/:id — delete (admin, tenant-scoped)
router.delete("/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.fieldPermission.findFirst({
      where: { id, tenantId: tenantId(req) },
    });
    if (!existing) return res.status(404).json({ error: "Field permission not found" });

    await prisma.fieldPermission.delete({ where: { id } });
    res.json({ message: "Field permission deleted" });
  } catch (err) {
    console.error("[FieldPermissions][delete]", err);
    res.status(500).json({ error: "Failed to delete field permission" });
  }
});

module.exports = router;
module.exports.ENTITY_FIELDS = ENTITY_FIELDS;
module.exports.SUPPORTED_ROLES = SUPPORTED_ROLES;
