const express = require("express");
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");

const router = express.Router();

const AVAILABLE_INTEGRATIONS = [
  { provider: "slack", name: "Slack", description: "Send deal/contact notifications to Slack channels", category: "communication" },
  { provider: "google", name: "Google Workspace", description: "Calendar, Contacts, and Drive sync", category: "productivity" },
  { provider: "stripe", name: "Stripe", description: "Payment processing for invoices", category: "payments" },
  { provider: "razorpay", name: "Razorpay", description: "Indian payment gateway for invoices", category: "payments" },
  { provider: "mailchimp", name: "Mailchimp", description: "Email marketing campaign sync", category: "marketing" },
  { provider: "quickbooks", name: "QuickBooks", description: "Accounting & bookkeeping sync", category: "accounting" },
  { provider: "xero", name: "Xero", description: "Cloud accounting platform sync", category: "accounting" },
  { provider: "tally", name: "Tally Prime", description: "Indian accounting software sync", category: "accounting" },
  { provider: "zapier", name: "Zapier", description: "Connect to 5000+ apps via triggers & actions", category: "automation" },
  { provider: "whatsapp", name: "WhatsApp Business", description: "Send messages via WhatsApp Cloud API", category: "communication" },
  { provider: "indiamart", name: "IndiaMART", description: "Auto-import B2B leads", category: "marketplace" },
  { provider: "justdial", name: "JustDial", description: "Auto-import local business leads", category: "marketplace" },
];

router.get("/", verifyToken, async (req, res) => {
  try {
    const connected = await prisma.integration.findMany({ where: { tenantId: req.user.tenantId } });
    const connectedMap = {};
    for (const c of connected) connectedMap[c.provider] = c;

    const integrations = AVAILABLE_INTEGRATIONS.map(a => ({
      ...a,
      isActive: connectedMap[a.provider]?.isActive || false,
      connectedAt: connectedMap[a.provider]?.updatedAt || null,
      id: connectedMap[a.provider]?.id || null,
    }));
    res.json(integrations);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch integrations" });
  }
});

router.post("/connect", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { provider, token, settings } = req.body;
    if (!provider) return res.status(400).json({ error: "Provider required" });

    const integration = await prisma.integration.upsert({
      where: { tenantId_provider: { tenantId: req.user.tenantId, provider } },
      update: { isActive: true, token: token || null, settings: settings ? JSON.stringify(settings) : null },
      create: { provider, isActive: true, token: token || null, settings: settings ? JSON.stringify(settings) : null, tenantId: req.user.tenantId },
    });
    res.json(integration);
  } catch (err) {
    res.status(500).json({ error: "Failed to connect integration" });
  }
});

router.post("/disconnect", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { provider } = req.body;
    await prisma.integration.updateMany({
      where: { tenantId: req.user.tenantId, provider },
      data: { isActive: false, token: null },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

// Legacy toggle endpoint (kept for backwards compat)
router.post("/toggle", verifyToken, async (req, res) => {
  try {
    const { provider, isActive } = req.body;
    const integration = await prisma.integration.upsert({
      where: { tenantId_provider: { tenantId: req.user.tenantId, provider } },
      update: { isActive },
      create: { provider, isActive, tenantId: req.user.tenantId },
    });
    res.json(integration);
  } catch (err) {
    res.status(500).json({ error: "Failed to toggle integration" });
  }
});

module.exports = router;
