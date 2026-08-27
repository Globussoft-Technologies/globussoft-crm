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
const { notifyDrugNeedsStock } = require("../lib/drugStock");

const router = express.Router();

const tenantWhere = (req, extra = {}) => ({ tenantId: req.user.tenantId, ...extra });
// "clinical" meta-token resolves dynamically against the per-tenant
// WellnessRoleType catalog (doctor / professional / nurse / stylist /
// any future custom clinical role with canTakeVisits=true).
// `anyOfPermissions` adds an RBAC-permission unlock: any custom role
// granted `prescriptions.read` (the same permission that surfaces the
// Drug Catalogue page in the sidebar, per the page catalog) hits the
// route — no code change needed.
const readGate = verifyWellnessRole(
  ["admin", "manager", "clinical", "doctor"],
  { anyOfPermissions: [{ module: "prescriptions", action: "read" }] },
);
const writeGate = verifyWellnessRole(
  ["admin", "manager"],
  { anyOfPermissions: [{ module: "prescriptions", action: "write" }] },
);
// Quick-add is a PRESCRIBER action, not catalogue admin — a doctor who finds
// no "Paracetamol" mid-consultation has to be able to add it, or they will type
// it as free text and the catalogue never learns about it. Narrower than
// writeGate in what it can set (name + form only, never stock).
const prescriberGate = verifyWellnessRole(
  ["admin", "manager", "clinical", "doctor"],
  { anyOfPermissions: [{ module: "prescriptions", action: "write" }] },
);

/**
 * Parse a stock count. Returns null when the value is present but unusable so
 * the route can 400 rather than silently storing something the admin didn't
 * mean. `0` is a legitimate value for both fields.
 */
function parseStockNumber(raw) {
  if (raw === "" || raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

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

    const wantsPagination = req.query.page !== undefined || req.query.limit !== undefined;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = wantsPagination ? (page - 1) * limit : 0;

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
          // Stock is part of the typeahead's job now — the prescriber needs to
          // see what's on the shelf BEFORE writing the drug, not after the
          // patient asks for it.
          quantity: true,
          lowStockThreshold: true,
        }
      : undefined;

    const items = await prisma.drug.findMany({
      where,
      orderBy: [{ name: "asc" }],
      take: wantsPagination ? limit : undefined,
      skip: wantsPagination ? skip : undefined,
      ...(select ? { select } : {}),
    });
    if (!wantsPagination) {
      return res.json(items);
    }

    const total = await prisma.drug.count({ where });
    return res.json({
      items,
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
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
        quantity: parseStockNumber(req.body.quantity) ?? 0,
        lowStockThreshold: parseStockNumber(req.body.lowStockThreshold) ?? 0,
        tenantId: req.user.tenantId,
      },
    });
    await writeAudit("Drug", "CREATE", drug.id, req.user.userId, req.user.tenantId, {
      name: drug.name,
      genericName: drug.genericName,
      dosageForm: drug.dosageForm,
      quantity: drug.quantity,
      lowStockThreshold: drug.lowStockThreshold,
    });
    res.status(201).json(drug);
  } catch (e) {
    console.error("[drugs] create error:", e.message);
    res.status(500).json({ error: "Failed to create drug" });
  }
});

/**
 * POST /drugs/quick-add — create a catalogue row from the prescription writer.
 *
 * WHY THIS IS NOT `POST /drugs`
 *   Full drug CRUD is admin/manager work (`writeGate`). But a doctor mid-
 *   consultation who types "Paracetamol" and finds nothing must not be blocked
 *   on an admin — they'd type it as free text instead, and the catalogue would
 *   never learn about it. This endpoint lets a PRESCRIBER add the row, and
 *   nothing else: name and dosage form only.
 *
 *   Stock is deliberately NOT settable here. The new drug lands at quantity 0
 *   with no reorder point, and the admins are notified to set both. A
 *   prescriber guessing at stock counts is how a stock ledger becomes fiction.
 */
router.post("/quick-add", prescriberGate, async (req, res) => {
  try {
    const rawName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!rawName) {
      return res.status(400).json({ error: "name is required", code: "NAME_REQUIRED" });
    }
    const dosageForm = req.body?.dosageForm || "other";
    if (!ALLOWED_DOSAGE_FORMS.has(String(dosageForm))) {
      return res.status(400).json({
        error: `dosageForm must be one of: ${[...ALLOWED_DOSAGE_FORMS].join(", ")}`,
        code: "INVALID_DOSAGE_FORM",
      });
    }

    // Idempotent on name: a doctor clicking "add" twice, or two doctors adding
    // the same missing drug in the same clinic session, must not fork the
    // catalogue. Returns the existing row rather than erroring — the caller
    // only wants "a drug id for this name".
    const existing = await prisma.drug.findFirst({
      where: { tenantId: req.user.tenantId, name: rawName },
    });
    if (existing) return res.json({ ...existing, created: false });

    const drug = await prisma.drug.create({
      data: {
        name: rawName,
        dosageForm,
        strengthValue: req.body?.strengthValue ? String(req.body.strengthValue).trim() : null,
        strengthUnit: req.body?.strengthUnit ? String(req.body.strengthUnit).trim() : null,
        quantity: 0,
        lowStockThreshold: 0,
        isActive: true,
        tenantId: req.user.tenantId,
      },
    });

    await writeAudit("Drug", "QUICK_ADD", drug.id, req.user.userId, req.user.tenantId, {
      name: drug.name,
      dosageForm: drug.dosageForm,
      source: "prescription-writer",
    });

    // Tell the admins so the new row doesn't sit at 0 forever. Best-effort:
    // the drug exists either way and the doctor is mid-consultation.
    notifyDrugNeedsStock({
      tenantId: req.user.tenantId,
      drug,
      addedByUserId: req.user.userId,
      io: req.io,
    }).catch((err) =>
      console.warn("[drugs] quick-add notification failed:", err.message),
    );

    res.status(201).json({ ...drug, created: true });
  } catch (e) {
    console.error("[drugs] quick-add error:", e.message);
    res.status(500).json({ error: "Failed to add the drug" });
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

    // Stock. Both are plain non-negative counts; `0` is meaningful for each
    // (nothing on hand / don't alert on this one), so they are parsed rather
    // than truthiness-checked.
    for (const k of ["quantity", "lowStockThreshold"]) {
      // An empty box means "leave it alone", not "set it to zero" — the edit
      // form round-trips every field, and a blank must never silently wipe a
      // stock count the admin didn't intend to touch.
      if (req.body[k] === undefined || req.body[k] === "" || req.body[k] === null) continue;
      const parsed = parseStockNumber(req.body[k]);
      if (parsed === null) {
        return res.status(400).json({
          error: `${k} must be a whole number of 0 or more`,
          code: "INVALID_STOCK_VALUE",
        });
      }
      data[k] = parsed;
    }

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
