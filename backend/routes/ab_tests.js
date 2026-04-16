const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────
function tenantOf(req) {
  return (req.user && req.user.tenantId) || 1;
}

function safeJsonParse(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_e) {
    return fallback;
  }
}

function serialize(test) {
  if (!test) return test;
  return {
    ...test,
    variantA: safeJsonParse(test.variantA, {}),
    variantB: safeJsonParse(test.variantB, {}),
  };
}

function computeStats(test) {
  const sentA = test.variantASent || 0;
  const sentB = test.variantBSent || 0;
  const clickA = test.variantAClicked || 0;
  const clickB = test.variantBClicked || 0;
  const ctrA = sentA > 0 ? (clickA / sentA) * 100 : 0;
  const ctrB = sentB > 0 ? (clickB / sentB) * 100 : 0;
  const totalSent = sentA + sentB;
  const significant = Math.abs(ctrA - ctrB) > 5 && totalSent > 100;
  let leader = null;
  if (sentA > 0 || sentB > 0) {
    leader = ctrA === ctrB ? "TIE" : ctrA > ctrB ? "A" : "B";
  }
  return {
    variantA: {
      sent: sentA,
      clicked: clickA,
      ctr: Math.round(ctrA * 100) / 100,
    },
    variantB: {
      sent: sentB,
      clicked: clickB,
      ctr: Math.round(ctrB * 100) / 100,
    },
    totalSent,
    significant,
    leader,
  };
}

// ── GET / — list AB tests ────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const tests = await prisma.abTest.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    res.json(tests.map((t) => ({ ...serialize(t), stats: computeStats(t) })));
  } catch (err) {
    console.error("[ab_tests/list]", err);
    res.status(500).json({ error: "Failed to fetch AB tests" });
  }
});

// ── POST / — create ──────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { name, campaignId, variantA, variantB } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });

    const variantAStr =
      typeof variantA === "string" ? variantA : JSON.stringify(variantA || {});
    const variantBStr =
      typeof variantB === "string" ? variantB : JSON.stringify(variantB || {});

    const test = await prisma.abTest.create({
      data: {
        name,
        campaignId: campaignId ? Number(campaignId) : null,
        variantA: variantAStr,
        variantB: variantBStr,
        status: "DRAFT",
        tenantId,
      },
    });
    res.status(201).json(serialize(test));
  } catch (err) {
    console.error("[ab_tests/create]", err);
    res.status(500).json({ error: "Failed to create AB test" });
  }
});

// ── GET /:id — full details + stats ──────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const id = Number(req.params.id);
    const test = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!test) return res.status(404).json({ error: "AB test not found" });
    res.json({ ...serialize(test), stats: computeStats(test) });
  } catch (err) {
    console.error("[ab_tests/detail]", err);
    res.status(500).json({ error: "Failed to fetch AB test" });
  }
});

// ── PUT /:id — update ────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const id = Number(req.params.id);
    const existing = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "AB test not found" });

    const { name, campaignId, variantA, variantB, status, winningVariant } =
      req.body || {};
    const data = {};
    if (name !== undefined) data.name = name;
    if (campaignId !== undefined)
      data.campaignId = campaignId ? Number(campaignId) : null;
    if (variantA !== undefined)
      data.variantA =
        typeof variantA === "string" ? variantA : JSON.stringify(variantA);
    if (variantB !== undefined)
      data.variantB =
        typeof variantB === "string" ? variantB : JSON.stringify(variantB);
    if (status !== undefined) data.status = status;
    if (winningVariant !== undefined) data.winningVariant = winningVariant;

    const updated = await prisma.abTest.update({ where: { id }, data });
    res.json(serialize(updated));
  } catch (err) {
    console.error("[ab_tests/update]", err);
    res.status(500).json({ error: "Failed to update AB test" });
  }
});

// ── DELETE /:id ──────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const id = Number(req.params.id);
    const existing = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "AB test not found" });
    await prisma.abTest.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    console.error("[ab_tests/delete]", err);
    res.status(500).json({ error: "Failed to delete AB test" });
  }
});

// ── POST /:id/start ──────────────────────────────────────────────
router.post("/:id/start", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const id = Number(req.params.id);
    const existing = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "AB test not found" });
    const updated = await prisma.abTest.update({
      where: { id },
      data: { status: "RUNNING" },
    });
    res.json(serialize(updated));
  } catch (err) {
    console.error("[ab_tests/start]", err);
    res.status(500).json({ error: "Failed to start AB test" });
  }
});

// ── POST /:id/track ──────────────────────────────────────────────
// body: { variant: "A"|"B", action: "sent"|"clicked" }
router.post("/:id/track", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const id = Number(req.params.id);
    const { variant, action } = req.body || {};
    if (!["A", "B"].includes(variant)) {
      return res.status(400).json({ error: "variant must be 'A' or 'B'" });
    }
    if (!["sent", "clicked"].includes(action)) {
      return res.status(400).json({ error: "action must be 'sent' or 'clicked'" });
    }
    const existing = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "AB test not found" });

    const fieldMap = {
      "A:sent": "variantASent",
      "A:clicked": "variantAClicked",
      "B:sent": "variantBSent",
      "B:clicked": "variantBClicked",
    };
    const field = fieldMap[`${variant}:${action}`];
    const updated = await prisma.abTest.update({
      where: { id },
      data: { [field]: { increment: 1 } },
    });
    res.json(serialize(updated));
  } catch (err) {
    console.error("[ab_tests/track]", err);
    res.status(500).json({ error: "Failed to track AB test event" });
  }
});

// ── POST /:id/declare-winner ─────────────────────────────────────
router.post("/:id/declare-winner", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const id = Number(req.params.id);
    const { winner } = req.body || {};
    if (!["A", "B"].includes(winner)) {
      return res.status(400).json({ error: "winner must be 'A' or 'B'" });
    }
    const existing = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!existing) return res.status(404).json({ error: "AB test not found" });

    const updated = await prisma.abTest.update({
      where: { id },
      data: { winningVariant: winner, status: "COMPLETED" },
    });
    res.json(serialize(updated));
  } catch (err) {
    console.error("[ab_tests/declare-winner]", err);
    res.status(500).json({ error: "Failed to declare winner" });
  }
});

// ── GET /:id/stats ───────────────────────────────────────────────
router.get("/:id/stats", async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const id = Number(req.params.id);
    const test = await prisma.abTest.findFirst({ where: { id, tenantId } });
    if (!test) return res.status(404).json({ error: "AB test not found" });
    res.json({
      id: test.id,
      name: test.name,
      status: test.status,
      winningVariant: test.winningVariant,
      ...computeStats(test),
    });
  } catch (err) {
    console.error("[ab_tests/stats]", err);
    res.status(500).json({ error: "Failed to compute stats" });
  }
});

module.exports = router;
