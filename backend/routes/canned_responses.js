const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

const tenantId = (req) => req.user?.tenantId || 1;

// GET /api/canned-responses?category=
router.get("/", async (req, res) => {
  try {
    const where = { tenantId: tenantId(req) };
    if (req.query.category) where.category = String(req.query.category);
    const items = await prisma.cannedResponse.findMany({
      where,
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
    res.json(items);
  } catch (err) {
    console.error("[CannedResponses][list]", err);
    res.status(500).json({ error: "Failed to fetch canned responses" });
  }
});

// POST /api/canned-responses
router.post("/", async (req, res) => {
  try {
    const { name, content, category } = req.body;
    if (!name || !content) {
      return res.status(400).json({ error: "name and content are required" });
    }
    const item = await prisma.cannedResponse.create({
      data: {
        name: String(name),
        content: String(content),
        category: category ? String(category) : "General",
        tenantId: tenantId(req),
      },
    });
    res.status(201).json(item);
  } catch (err) {
    console.error("[CannedResponses][create]", err);
    res.status(500).json({ error: "Failed to create canned response" });
  }
});

// PUT /api/canned-responses/:id
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.cannedResponse.findFirst({
      where: { id, tenantId: tenantId(req) },
    });
    if (!existing) return res.status(404).json({ error: "Canned response not found" });

    const { name, content, category } = req.body;
    const data = {};
    if (name !== undefined) data.name = String(name);
    if (content !== undefined) data.content = String(content);
    if (category !== undefined) data.category = String(category);

    const item = await prisma.cannedResponse.update({ where: { id }, data });
    res.json(item);
  } catch (err) {
    console.error("[CannedResponses][update]", err);
    res.status(500).json({ error: "Failed to update canned response" });
  }
});

// DELETE /api/canned-responses/:id
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.cannedResponse.findFirst({
      where: { id, tenantId: tenantId(req) },
    });
    if (!existing) return res.status(404).json({ error: "Canned response not found" });

    await prisma.cannedResponse.delete({ where: { id } });
    res.json({ message: "Canned response deleted" });
  } catch (err) {
    console.error("[CannedResponses][delete]", err);
    res.status(500).json({ error: "Failed to delete canned response" });
  }
});

module.exports = router;
