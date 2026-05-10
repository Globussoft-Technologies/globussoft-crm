// Wave 7 Agent A — Service Catalogue depth (PRD Gap §10 item 1).
//
// Tenant-scoped CRUD for the new ServiceCategory taxonomy. Mounted under
// /api/wellness/service-categories so the URL space mirrors the existing
// /api/wellness/product-categories surface (routes/inventory.js).
//
// All endpoints require admin or manager wellnessRole — operational config,
// not PHI. Tenant scope inherits from req.user.tenantId via tenantWhere.
// Audit emitted on every mutation to feed the AuditLog hash chain.

const express = require("express");
const prisma = require("../lib/prisma");
const { writeAudit, diffFields } = require("../lib/audit");
const { verifyWellnessRole } = require("../middleware/wellnessRole");

const router = express.Router();

const tenantWhere = (req, extra = {}) => ({ tenantId: req.user.tenantId, ...extra });
const adminGate = verifyWellnessRole(["admin", "manager"]);

// ── ServiceCategory CRUD ───────────────────────────────────────────

router.get("/", async (req, res) => {
  // List is OPEN to any authenticated tenant user (the picker on the
  // wellness service form needs to read the list — no admin gate).
  try {
    const where = tenantWhere(req);
    if (req.query.isActive === "true") where.isActive = true;
    if (req.query.isActive === "false") where.isActive = false;
    const items = await prisma.serviceCategory.findMany({
      where,
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { services: true, children: true } } },
    });
    res.json(items);
  } catch (e) {
    console.error("[service-categories] list error:", e.message);
    res.status(500).json({ error: "Failed to list service categories" });
  }
});

router.post("/", adminGate, async (req, res) => {
  try {
    const { name, parentId, displayOrder, isActive } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "name is required", code: "NAME_REQUIRED" });
    }
    if (parentId !== undefined && parentId !== null) {
      const parent = await prisma.serviceCategory.findFirst({
        where: tenantWhere(req, { id: parseInt(parentId) }),
      });
      if (!parent) return res.status(400).json({ error: "parentId does not exist in this tenant", code: "PARENT_NOT_FOUND" });
    }
    // (tenantId, name) is unique. Catch the Prisma P2002 + map to a friendly 409.
    try {
      const cat = await prisma.serviceCategory.create({
        data: {
          name: name.trim(),
          parentId: parentId ? parseInt(parentId) : null,
          displayOrder: typeof displayOrder === "number" ? displayOrder : 0,
          isActive: isActive !== false,
          tenantId: req.user.tenantId,
        },
      });
      await writeAudit("ServiceCategory", "CREATE", cat.id, req.user.userId, req.user.tenantId, {
        name: cat.name,
        parentId: cat.parentId,
      });
      res.status(201).json(cat);
    } catch (err) {
      if (err && err.code === "P2002") {
        return res.status(409).json({ error: "category name already exists in this tenant", code: "DUPLICATE_NAME" });
      }
      throw err;
    }
  } catch (e) {
    console.error("[service-categories] create error:", e.message);
    res.status(500).json({ error: "Failed to create service category" });
  }
});

router.put("/:id", adminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "invalid id" });
    const existing = await prisma.serviceCategory.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Service category not found" });

    const data = {};
    const allowed = ["name", "parentId", "displayOrder", "isActive"];
    for (const k of allowed) if (req.body[k] !== undefined) data[k] = req.body[k];

    if (data.parentId === id) {
      return res.status(400).json({ error: "category cannot be its own parent", code: "PARENT_SELF_REFERENCE" });
    }
    if (data.parentId !== undefined && data.parentId !== null) {
      const parent = await prisma.serviceCategory.findFirst({
        where: tenantWhere(req, { id: parseInt(data.parentId) }),
      });
      if (!parent) return res.status(400).json({ error: "parentId does not exist in this tenant", code: "PARENT_NOT_FOUND" });
      data.parentId = parseInt(data.parentId);
    }
    if (typeof data.name === "string") data.name = data.name.trim();

    try {
      const updated = await prisma.serviceCategory.update({ where: { id }, data });
      const changes = diffFields(existing, updated, Object.keys(data));
      if (Object.keys(changes).length > 0) {
        await writeAudit("ServiceCategory", "UPDATE", id, req.user.userId, req.user.tenantId, { changedFields: changes });
      }
      res.json(updated);
    } catch (err) {
      if (err && err.code === "P2002") {
        return res.status(409).json({ error: "category name already exists in this tenant", code: "DUPLICATE_NAME" });
      }
      throw err;
    }
  } catch (e) {
    console.error("[service-categories] update error:", e.message);
    res.status(500).json({ error: "Failed to update service category" });
  }
});

router.delete("/:id", adminGate, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "invalid id" });
    const existing = await prisma.serviceCategory.findFirst({ where: tenantWhere(req, { id }) });
    if (!existing) return res.status(404).json({ error: "Service category not found" });

    // Service.categoryId uses onDelete: SetNull — services keep working,
    // they just lose the FK. Children re-parent to root.
    await prisma.serviceCategory.delete({ where: { id } });
    await writeAudit("ServiceCategory", "DELETE", id, req.user.userId, req.user.tenantId, { name: existing.name });
    res.status(204).send();
  } catch (e) {
    console.error("[service-categories] delete error:", e.message);
    res.status(500).json({ error: "Failed to delete service category" });
  }
});

module.exports = router;
