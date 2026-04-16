const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

function safeJson(str, fallback) {
  if (!str) return fallback;
  if (typeof str === "object") return str;
  try { return JSON.parse(str); } catch { return fallback; }
}

function shape(t, extra = {}) {
  return {
    ...t,
    regions: safeJson(t.regions, []),
    assignedUserIds: safeJson(t.assignedUserIds, []),
    ...extra,
  };
}

// GET / — list territories with counts
router.get("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const territories = await prisma.territory.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    });

    // Count contacts per territory in one go
    const ids = territories.map(t => t.id);
    let counts = {};
    if (ids.length) {
      const grouped = await prisma.contact.groupBy({
        by: ["territoryId"],
        where: { tenantId, territoryId: { in: ids } },
        _count: { _all: true },
      });
      counts = Object.fromEntries(grouped.map(g => [g.territoryId, g._count._all]));
    }

    res.json(territories.map(t => shape(t, { contactCount: counts[t.id] || 0 })));
  } catch (err) {
    console.error("territories GET / error:", err);
    res.status(500).json({ error: "Failed to load territories" });
  }
});

// POST / — create
router.post("/", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { name, regions, assignedUserIds } = req.body || {};
    if (!name) return res.status(400).json({ error: "Name is required" });

    const territory = await prisma.territory.create({
      data: {
        name,
        regions: JSON.stringify(Array.isArray(regions) ? regions : []),
        assignedUserIds: JSON.stringify(
          Array.isArray(assignedUserIds) ? assignedUserIds.map(Number).filter(n => !Number.isNaN(n)) : []
        ),
        tenantId,
      },
    });
    res.status(201).json(shape(territory, { contactCount: 0 }));
  } catch (err) {
    console.error("territories POST / error:", err);
    res.status(500).json({ error: "Failed to create territory" });
  }
});

// PUT /:id — update
router.put("/:id", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.territory.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Territory not found" });

    const { name, regions, assignedUserIds } = req.body || {};
    const updated = await prisma.territory.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(regions !== undefined && { regions: JSON.stringify(Array.isArray(regions) ? regions : []) }),
        ...(assignedUserIds !== undefined && {
          assignedUserIds: JSON.stringify(
            Array.isArray(assignedUserIds) ? assignedUserIds.map(Number).filter(n => !Number.isNaN(n)) : []
          ),
        }),
      },
    });
    res.json(shape(updated));
  } catch (err) {
    console.error("territories PUT /:id error:", err);
    res.status(500).json({ error: "Failed to update territory" });
  }
});

// DELETE /:id
router.delete("/:id", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.territory.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "Territory not found" });

    // Detach contacts
    await prisma.contact.updateMany({
      where: { tenantId, territoryId: id },
      data: { territoryId: null },
    });
    await prisma.territory.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("territories DELETE /:id error:", err);
    res.status(500).json({ error: "Failed to delete territory" });
  }
});

// POST /:id/assign-contact — assign contact to territory
router.post("/:id/assign-contact", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = Number(req.params.id);
    const { contactId } = req.body || {};
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid territory id" });
    if (!contactId) return res.status(400).json({ error: "contactId is required" });

    const territory = await prisma.territory.findFirst({ where: { id, tenantId } });
    if (!territory) return res.status(404).json({ error: "Territory not found" });

    const contact = await prisma.contact.findFirst({
      where: { id: Number(contactId), tenantId },
    });
    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const updated = await prisma.contact.update({
      where: { id: contact.id },
      data: { territoryId: id },
    });
    res.json({ success: true, contact: { id: updated.id, territoryId: updated.territoryId } });
  } catch (err) {
    console.error("territories assign-contact error:", err);
    res.status(500).json({ error: "Failed to assign contact" });
  }
});

// GET /:id/contacts — list contacts in territory
router.get("/:id/contacts", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const territory = await prisma.territory.findFirst({ where: { id, tenantId } });
    if (!territory) return res.status(404).json({ error: "Territory not found" });

    const contacts = await prisma.contact.findMany({
      where: { tenantId, territoryId: id },
      select: {
        id: true, name: true, email: true, phone: true, company: true,
        status: true, source: true, assignedToId: true,
      },
      orderBy: { id: "desc" },
    });
    res.json(contacts);
  } catch (err) {
    console.error("territories GET /:id/contacts error:", err);
    res.status(500).json({ error: "Failed to load territory contacts" });
  }
});

module.exports = router;
