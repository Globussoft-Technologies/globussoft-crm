const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// Fetch activated Ecosystem modules
router.get("/", verifyToken, async (req, res) => {
  try {
    const integrations = await prisma.integration.findMany({ where: { tenantId: req.user.tenantId } });
    res.json(integrations);
  } catch(err) {
    res.status(500).json({ error: "Ecosystem read matrix failure" });
  }
});

// Flip OAuth handshake logic natively
router.post("/toggle", verifyToken, async (req, res) => {
  try {
    const { provider, isActive } = req.body;

    const integration = await prisma.integration.upsert({
      where: { tenantId_provider: { tenantId: req.user.tenantId, provider } },
      update: { isActive, token: isActive ? `oauth_sim_${Date.now()}` : null },
      create: { provider, isActive, token: isActive ? `oauth_sim_${Date.now()}` : null, tenantId: req.user.tenantId }
    });

    res.status(200).json(integration);
  } catch(err) {
    console.error("[integrations] toggle error:", err);
    res.status(500).json({ error: "Failed to authenticate third-party credential handshake." });
  }
});

module.exports = router;
