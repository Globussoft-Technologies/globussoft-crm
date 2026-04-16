const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

// GET /api/projects — list with optional status filter
router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const where = { tenantId: req.user.tenantId };
    if (status) where.status = status;

    const projects = await prisma.project.findMany({
      where,
      include: { owner: true, contact: true, deal: true, tasks: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(projects);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
});

// GET /api/projects/:id — single project
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid project ID" });

    const project = await prisma.project.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { owner: true, contact: true, deal: true, tasks: true },
    });
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch project" });
  }
});

// POST /api/projects — create project
router.post("/", async (req, res) => {
  try {
    const { name, description, priority, startDate, endDate, budget, contactId, dealId } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const project = await prisma.project.create({
      data: {
        name,
        description: description || null,
        priority: priority || "Medium",
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        budget: budget ? parseFloat(budget) : 0,
        ownerId: req.user.userId,
        contactId: contactId ? parseInt(contactId) : null,
        dealId: dealId ? parseInt(dealId) : null,
        tenantId: req.user.tenantId,
      },
      include: { owner: true, contact: true, deal: true, tasks: true },
    });
    res.status(201).json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create project" });
  }
});

// PUT /api/projects/:id — update project
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid project ID" });

    const existing = await prisma.project.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Project not found" });

    const { name, description, status, priority, startDate, endDate, budget, contactId, dealId } = req.body;
    const data = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (status !== undefined) data.status = status;
    if (priority !== undefined) data.priority = priority;
    if (startDate !== undefined) data.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) data.endDate = endDate ? new Date(endDate) : null;
    if (budget !== undefined) data.budget = parseFloat(budget);
    if (contactId !== undefined) data.contactId = contactId ? parseInt(contactId) : null;
    if (dealId !== undefined) data.dealId = dealId ? parseInt(dealId) : null;

    const project = await prisma.project.update({
      where: { id: existing.id },
      data,
      include: { owner: true, contact: true, deal: true, tasks: true },
    });
    res.json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update project" });
  }
});

// DELETE /api/projects/:id
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid project ID" });
    const existing = await prisma.project.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Project not found" });
    await prisma.project.delete({ where: { id: existing.id } });
    res.json({ message: "Project deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

module.exports = router;
