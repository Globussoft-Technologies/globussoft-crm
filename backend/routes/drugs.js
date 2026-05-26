// Wave 7 Agent A — Drug catalogue (PRD Gap §10 item 2).
//
// Tenant-scoped CRUD for the new Drug model. Mounted under
// /api/wellness/drugs. Used by the prescription writer's typeahead — the
// route exposes a `?q=` substring search across name + genericName.
//
// Role gates:
//   - LIST + GET typeahead: admin / manager / doctor (the doctor needs
//     to read the catalogue while writing a prescription).
//   - POST / PUT / DELETE: admin / manager (operational catalogue
//     management; doctors don't author the catalogue itself).
//
// Audit emitted on every mutation. Tenant scope inherits from
// req.user.tenantId via tenantWhere.

const express = require("express");
const prisma = require("../lib/prisma");
const { writeAudit, diffFields } = require("../lib/audit");
const { verifyWellnessRole } = require("../middleware/wellnessRole");

const router = express.Router();

const tenantWhere = (req, extra = {}) => ({ tenantId: req.user.tenantId, ...extra });
const readGate = verifyWellnessRole(["admin", "manager", "doctor"]);
const writeGate = verifyWellnessRole(["admin", "manager"]);

// ── Drug CRUD + typeahead ─────────────────────────────────────────

router.get("/", readGate, async (req, res) => {
  try {
    const where = tenantWhere(req);
    if (req.query.isActive === "true") where.isActive = true;
    if (req.query.isActive === "false") where.isActive = false;

    // ?q=para → matches "Paracetamol" + "Acetaminophen (Para)" (genericName)
    const q = String(req.query.q || "").trim();
    if (q.length > 0) {
      where.OR = [
        { name: { contains: q } },
        { genericName: { contains: q } },
      ];
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    // ?fields=summary → slim shape for typeahead callers. Drops heavy free-text
    // `notes` (@db.Text — admin-only contraindications / scheduling info) and
    // timestamps + tenantId chrome that the typeahead UI never renders.
    // Opt-in additive — unspecified fields query returns the full row.
    const isSummary = req.query.fields === "summary";
    const select = isSummary
      ? {
          id: true,
          name: true,
          genericName: true,
          dosageForm: true,
          strengthValue: true,
          strengthUnit: true,
          isActive: true,
        }
      : undefined;

    const items = await prisma.drug.findMany({
      where,
      orderBy: [{ name: "asc" }],
      take: limit,
      ...(select ? { select } : {}),
    });
    res.json(items);
  } catch (e) {
    console.error("[drugs] list error:", e.message);
    res.status(500).json({ error: "Failed to list drugs" });
  }
});

router.get("/:id", readGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "invalid id" });
    const drug = await prisma.drug.findFirst({ where: tenantWhere(req, { id }) });
    if (!drug) return res.status(404).json({ error: "Drug not found" });
    res.json(drug);
  } catch (e) {
    console.error("[drugs] get error:", e.message);
    res.status(500).json({ error: "Failed to fetch drug" });
  }
});

const ALLOWED_DOSAGE_FORMS = new Set(["tablet", "capsule", "syrup", "injection", "topical", "drops", "inhaler", "other"]);

router.post("/", writeGate, async (req, res) => {
  try {
    const {
      name, genericName, dosageForm,
      strengthValue, strengthUnit,
      defaultDosage, defaultFrequency, defaultDuration,
      notes, isActive,
    } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required", code: "NAME_REQUIRED" });
    }
    if (dosageForm && !ALLOWED_DOSAGE_FORMS.has(String(dosageForm))) {
      return res.status(400).json({
        error: `dosageForm must be one of: ${[...ALLOWED_DOSAGE_FORMS].join(", ")}`,
        code: "INVALID_DOSAGE_FORM",
      });
    }
    const drug = await prisma.drug.create({
      data: {
        name: name.trim(),
        genericName: genericName ? String(genericName).trim() : null,
        dosageForm: dosageForm || "tablet",
        strengthValue: strengthValue ? String(strengthValue).trim() : null,
        strengthUnit: strengthUnit ? String(strengthUnit).trim() : null,
        defaultDosage: defaultDosage ? String(defaultDosage).trim() : null,
        defaultFrequency: defaultFrequency ? String(defaultFrequency).trim() : null,
        defaultDuration: defaultDuration ? String(defaultDuration).trim() : null,
        notes: notes || null,
        isActive: isActive !== false,
        tenantId: req.user.tenantId,
      },
    });
    await writeAudit("Drug", "CREATE", drug.id, req.user.userId, req.user.tenantId, {
      name: drug.name,
      genericName: drug.genericName,
      dosageForm: drug.dosageForm,
    });
    res.status(201).json(drug);
  } catch (e) {
    console.error("[drugs] create error:", e.message);
    res.status(500).json({ error: "Failed to create drug" });
  }
});

router.put("/:id", writeGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "invalid id" });
    const existing = await prisma.drug.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Drug not found" });

    const data = {};
    const allowed = [
      "name", "genericName", "dosageForm",
      "strengthValue", "strengthUnit",
      "defaultDosage", "defaultFrequency", "defaultDuration",
      "notes", "isActive",
    ];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];

    if (data.dosageForm && !ALLOWED_DOSAGE_FORMS.has(String(data.dosageForm))) {
      return res.status(400).json({
        error: `dosageForm must be one of: ${[...ALLOWED_DOSAGE_FORMS].join(", ")}`,
        code: "INVALID_DOSAGE_FORM",
      });
    }
    if (typeof data.name === "string") data.name = data.name.trim();
    if (typeof data.genericName === "string") data.genericName = data.genericName.trim() || null;

    const updated = await prisma.drug.update({ where: { id }, data });
    const changes = diffFields(existing, updated, Object.keys(data));
    if (Object.keys(changes).length > 0) {
      await writeAudit("Drug", "UPDATE", id, req.user.userId, req.user.tenantId, { changedFields: changes });
    }
    res.json(updated);
  } catch (e) {
    console.error("[drugs] update error:", e.message);
    res.status(500).json({ error: "Failed to update drug" });
  }
});

router.delete("/:id", writeGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "invalid id" });
    const existing = await prisma.drug.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Drug not found" });

    await prisma.drug.delete({ where: { id } });
    await writeAudit("Drug", "DELETE", id, req.user.userId, req.user.tenantId, { name: existing.name });
    res.status(204).send();
  } catch (e) {
    console.error("[drugs] delete error:", e.message);
    res.status(500).json({ error: "Failed to delete drug" });
  }
});

module.exports = router;
