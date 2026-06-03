const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyRole } = require("../middleware/auth");

function tenantOf(req, res) {
  const id = req.user?.tenantId;
  if (!id) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return id;
}

// GET /api/canned-responses?category=&fields=summary
router.get("/", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const where = { tenantId };
    if (req.query.category) where.category = String(req.query.category);
    // #920 slice 21: ?fields=summary slim-shape opt-in. Mirrors slices 1-20.
    // CannedResponse has one heavy column (content @db.Text — full template
    // body). When the caller passes ?fields=summary we drop content +
    // tenantId + createdAt + updatedAt, returning only the columns needed
    // for picker / dropdown chrome (id, name, category). Opt-in additive —
    // existing callers (no ?fields, or any non-exact value) get the full
    // row shape unchanged.
    const isSummary = req.query.fields === "summary";
    const findManyArgs = {
      where,
      orderBy: [{ category: "asc" }, { name: "asc" }],
    };
    if (isSummary) {
      findManyArgs.select = {
        id: true,
        name: true,
        category: true,
      };
    }
    const items = await prisma.cannedResponse.findMany(findManyArgs);
    res.json(items);
  } catch (err) {
    console.error("[CannedResponses][list]", err);
    res.status(500).json({ error: "Failed to fetch canned responses" });
  }
});

// POST /api/canned-responses
router.post("/", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const { name, content, category } = req.body;
    if (!name || !content) {
      return res.status(400).json({ error: "name and content are required" });
    }
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const item = await prisma.cannedResponse.create({
      data: {
        name: String(name),
        content: String(content),
        category: category ? String(category) : "General",
        tenantId,
      },
    });
    res.status(201).json(item);
  } catch (err) {
    console.error("[CannedResponses][create]", err);
    res.status(500).json({ error: "Failed to create canned response" });
  }
});

// PUT /api/canned-responses/:id
router.put("/:id", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.cannedResponse.findFirst({
      where: { id, tenantId },
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
router.delete("/:id", verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const tenantId = tenantOf(req, res);
    if (tenantId == null) return;
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await prisma.cannedResponse.findFirst({
      where: { id, tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Canned response not found" });

    await prisma.cannedResponse.delete({ where: { id } });
    res.status(204).end(); // #550: DELETE → 204 No Content
  } catch (err) {
    console.error("[CannedResponses][delete]", err);
    res.status(500).json({ error: "Failed to delete canned response" });
  }
});

module.exports = router;
