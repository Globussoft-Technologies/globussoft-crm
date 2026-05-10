const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken, verifyRole } = require("../middleware/auth");
// #464: invalidate the in-process fieldFilter cache whenever a rule changes,
// otherwise routes/deals.js + routes/contacts.js (which call filterReadFields
// / filterWriteFields) will keep stripping fields based on the OLD rule for
// up to 30 seconds (CACHE_TTL_MS). This makes admin-side rule changes
// effectively immediate instead of "wait half a minute then retry".
const { clearCache: clearFieldFilterCache } = require("../middleware/fieldFilter");

const tenantId = (req) => req.user?.tenantId || 1;

// Supported entities + fields registry. The synthetic '*' field is the
// module-level marker used by hasModuleAction() — never exposed in the
// per-field UI but accepted here so the bulk-update can ship module-level
// rules as a single row alongside the per-field ones.
const ENTITY_FIELDS = {
  Deal: ["title", "amount", "currency", "probability", "stage", "expectedClose", "ownerId", "lostReason"],
  Contact: ["name", "email", "phone", "company", "title", "status", "source", "aiScore", "industry", "linkedin"],
  Invoice: ["amount", "status", "dueDate"],
  Quote: ["totalAmount", "mrr", "status"],
  // PRD Gap §1.3 — wellness + admin modules added so the module×action matrix
  // covers the full surface a clinic operator cares about. These have only
  // the synthetic '*' field today (module-level) since we don't expose
  // per-field gates for them yet; the matrix UI renders just the action row.
  Patient: ["*"],
  Visit: ["*"],
  Prescription: ["*"],
  ConsentForm: ["*"],
  Staff: ["*"],
  Settings: ["*"],
  Audit: ["*"],
  Reports: ["*"],
};

const SUPPORTED_ROLES = ["ADMIN", "MANAGER", "USER", "doctor", "professional", "telecaller", "helper", "stylist"];

// PRD Gap §1.3 — supported actions. WRITE is the legacy default (preserves
// the existing canWrite-as-permission semantics).
const SUPPORTED_ACTIONS = ["READ", "WRITE", "DELETE", "EXPORT"];

// #574 (CRIT-10): admin-only across the board. The matrix lets a USER read
// the per-role permission topology (canRead/canWrite for ADMIN/MANAGER/USER
// across every entity+field) — that's privilege-escalation reconnaissance
// even when writes are gated. Mirror routes/pipelines.js post-#527.
const adminOnly = [verifyToken, verifyRole(["ADMIN"])];

// GET /api/field-permissions/entities — registry of supported entities + fields
router.get("/entities", ...adminOnly, async (_req, res) => {
  res.json(ENTITY_FIELDS);
});

// GET /api/field-permissions/effective?role=USER&entity=Deal&action=WRITE
// Returns { field: { canRead, canWrite } } — defaults to full access when no rule exists.
// action defaults to "WRITE" (the legacy bucket) for back-compat with callers that
// don't know about the action axis yet.
router.get("/effective", ...adminOnly, async (req, res) => {
  try {
    const roleRaw = String(req.query.role || "");
    const role = SUPPORTED_ROLES.includes(roleRaw) ? roleRaw : roleRaw.toUpperCase();
    const entity = String(req.query.entity || "");
    const action = String(req.query.action || "WRITE").toUpperCase();
    if (!SUPPORTED_ROLES.includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (!ENTITY_FIELDS[entity]) {
      return res.status(400).json({ error: "Unsupported entity" });
    }
    if (!SUPPORTED_ACTIONS.includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }
    const rules = await prisma.fieldPermission.findMany({
      where: { role, entity, action, tenantId: tenantId(req) },
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

// GET /api/field-permissions/actions — registry of supported actions
router.get("/actions", ...adminOnly, async (_req, res) => {
  res.json({ actions: SUPPORTED_ACTIONS, roles: SUPPORTED_ROLES });
});

// GET /api/field-permissions/matrix — full module × action × role topology.
// Returns { [module]: { [role]: { [action]: { canRead, canWrite } } } }
// for every supported (module, role, action) triple. Defaults missing rules
// to { canRead: true, canWrite: true } (default-allow). Admin only.
router.get("/matrix", ...adminOnly, async (req, res) => {
  try {
    const tid = tenantId(req);
    const rules = await prisma.fieldPermission.findMany({
      where: { tenantId: tid, field: "*" },
    });
    const out = {};
    Object.keys(ENTITY_FIELDS).forEach((entity) => {
      out[entity] = {};
      SUPPORTED_ROLES.forEach((role) => {
        out[entity][role] = {};
        SUPPORTED_ACTIONS.forEach((action) => {
          const hit = rules.find((r) => r.entity === entity && r.role === role && r.action === action);
          out[entity][role][action] = hit
            ? { canRead: hit.canRead, canWrite: hit.canWrite }
            : { canRead: true, canWrite: true };
        });
      });
    });
    res.json(out);
  } catch (err) {
    console.error("[FieldPermissions][matrix]", err);
    res.status(500).json({ error: "Failed to fetch module matrix" });
  }
});

// GET /api/field-permissions — list all rules for tenant, grouped by entity
router.get("/", ...adminOnly, async (req, res) => {
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

// Helper: normalize role — keep wellness sub-roles lowercase, RBAC roles uppercase.
function normalizeRole(role) {
  if (!role) return null;
  const r = String(role);
  // Try exact match first (handles "doctor" / "telecaller" etc.).
  if (SUPPORTED_ROLES.includes(r)) return r;
  const up = r.toUpperCase();
  if (SUPPORTED_ROLES.includes(up)) return up;
  return null;
}

// POST /api/field-permissions — upsert a single rule (admin only).
// Body now optionally accepts `action` (defaults to "WRITE" for back-compat).
router.post("/", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { role, entity, field, canRead, canWrite } = req.body || {};
    const action = String(req.body?.action || "WRITE").toUpperCase();
    if (!role || !entity || !field) {
      return res.status(400).json({ error: "role, entity and field are required" });
    }
    const normalizedRole = normalizeRole(role);
    if (!normalizedRole) {
      return res.status(400).json({ error: "Invalid role" });
    }
    if (!ENTITY_FIELDS[entity]) {
      return res.status(400).json({ error: "Unsupported entity" });
    }
    if (!ENTITY_FIELDS[entity].includes(field)) {
      return res.status(400).json({ error: `Field '${field}' is not supported on ${entity}` });
    }
    if (!SUPPORTED_ACTIONS.includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }
    const tid = tenantId(req);
    const rule = await prisma.fieldPermission.upsert({
      where: {
        role_entity_field_action_tenantId: {
          role: normalizedRole,
          entity,
          field,
          action,
          tenantId: tid,
        },
      },
      update: {
        canRead: canRead !== undefined ? Boolean(canRead) : undefined,
        canWrite: canWrite !== undefined ? Boolean(canWrite) : undefined,
      },
      create: {
        role: normalizedRole,
        entity,
        field,
        action,
        canRead: canRead !== undefined ? Boolean(canRead) : true,
        canWrite: canWrite !== undefined ? Boolean(canWrite) : true,
        tenantId: tid,
      },
    });
    clearFieldFilterCache();
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
      const normalizedRole = normalizeRole(raw.role);
      const entity = raw.entity;
      const field = raw.field;
      const action = String(raw.action || "WRITE").toUpperCase();
      if (!normalizedRole || !ENTITY_FIELDS[entity] || !ENTITY_FIELDS[entity].includes(field) || !SUPPORTED_ACTIONS.includes(action)) {
        errors.push({ role: raw.role, entity, field, action, error: "invalid role/entity/field/action" });
        continue;
      }
      try {
        const rule = await prisma.fieldPermission.upsert({
          where: {
            role_entity_field_action_tenantId: { role: normalizedRole, entity, field, action, tenantId: tid },
          },
          update: {
            canRead: Boolean(raw.canRead),
            canWrite: Boolean(raw.canWrite),
          },
          create: {
            role: normalizedRole,
            entity,
            field,
            action,
            canRead: Boolean(raw.canRead),
            canWrite: Boolean(raw.canWrite),
            tenantId: tid,
          },
        });
        results.push(rule);
      } catch (e) {
        console.error("[FieldPermissions][bulk][row]", e);
        errors.push({ role: normalizedRole, entity, field, action, error: e.message });
      }
    }

    if (results.length > 0) clearFieldFilterCache();
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
    clearFieldFilterCache();
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
    clearFieldFilterCache();
    res.status(204).end(); // #550: DELETE → 204 No Content
  } catch (err) {
    console.error("[FieldPermissions][delete]", err);
    res.status(500).json({ error: "Failed to delete field permission" });
  }
});

module.exports = router;
module.exports.ENTITY_FIELDS = ENTITY_FIELDS;
module.exports.SUPPORTED_ROLES = SUPPORTED_ROLES;
module.exports.SUPPORTED_ACTIONS = SUPPORTED_ACTIONS;
