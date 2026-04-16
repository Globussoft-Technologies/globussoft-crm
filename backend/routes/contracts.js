const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

// GET /api/contracts — list with optional status filter
router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;

    const contracts = await prisma.contract.findMany({
      where,
      include: { contact: true, deal: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(contracts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch contracts" });
  }
});

// GET /api/contracts/:id — single contract with relations
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contract ID" });

    const contract = await prisma.contract.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { contact: true, deal: true },
    });
    if (!contract) return res.status(404).json({ error: "Contract not found" });
    res.json(contract);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch contract" });
  }
});

// POST /api/contracts — create contract
router.post("/", async (req, res) => {
  try {
    const { title, status, startDate, endDate, value, terms, contactId, dealId } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });

    const contract = await prisma.contract.create({
      data: {
        title,
        status: status || "Draft",
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        value: value ? parseFloat(value) : 0.0,
        terms: terms || null,
        contactId: contactId ? parseInt(contactId) : null,
        dealId: dealId ? parseInt(dealId) : null,
        tenantId: req.user.tenantId,
      },
      include: { contact: true, deal: true },
    });
    res.status(201).json(contract);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create contract" });
  }
});

// PUT /api/contracts/:id — update contract fields
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contract ID" });

    const existing = await prisma.contract.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Contract not found" });

    const { title, status, startDate, endDate, value, terms, contactId, dealId } = req.body;
    const data = {};
    if (title !== undefined) data.title = title;
    if (status !== undefined) data.status = status;
    if (startDate !== undefined) data.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) data.endDate = endDate ? new Date(endDate) : null;
    if (value !== undefined) data.value = parseFloat(value);
    if (terms !== undefined) data.terms = terms;
    if (contactId !== undefined) data.contactId = contactId ? parseInt(contactId) : null;
    if (dealId !== undefined) data.dealId = dealId ? parseInt(dealId) : null;

    const contract = await prisma.contract.update({
      where: { id: existing.id },
      data,
      include: { contact: true, deal: true },
    });
    res.json(contract);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update contract" });
  }
});

// DELETE /api/contracts/:id
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid contract ID" });
    const existing = await prisma.contract.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Contract not found" });
    await prisma.contract.delete({ where: { id: existing.id } });
    res.json({ message: "Contract deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete contract" });
  }
});

module.exports = router;
