const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// Get all email campaigns
router.get("/campaigns", verifyToken, async (req, res) => {
  try {
    const campaigns = await prisma.campaign.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { createdAt: 'desc' } });
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch campaigns." });
  }
});

// Create a new campaign
router.post("/campaigns", verifyToken, async (req, res) => {
  try {
    const { name, budget } = req.body;
    const campaign = await prisma.campaign.create({
      data: { name, budget: parseFloat(budget || 0), tenantId: req.user.tenantId }
    });
    res.status(201).json(campaign);
  } catch (err) {
    res.status(500).json({ error: "Failed to create campaign." });
  }
});


// Public endpoint for embedded forms to POST to (CORS must be enabled in server.js)
// NOTE: This endpoint is unauthenticated — leads default to Default Org (tenantId=1).
// Multi-tenant routing for embedded forms can be added later via formId -> tenant lookup.
router.post("/submit", async (req, res) => {
  try {
    const { formId, name, full_name, email, company_name } = req.body;

    // Parse dynamic payload mapping
    const contactEmail = email || `${Date.now()}@anonymous.com`;
    const contactName = name || full_name || "Web Lead";
    const contactCompany = company_name || "Inbound Traffic";

    // AI Predictive Lead Scoring (Simulated heuristic algorithm)
    let score = 30; // Base score
    if (contactCompany.toLowerCase().includes("inc") || contactCompany.toLowerCase().includes("llc")) score += 25;
    if (contactEmail.endsWith(".edu") || contactEmail.endsWith(".gov")) score += 35;
    if (contactName.split(" ").length > 1) score += 10;

    console.log(`[FormIngestion] Received lead from form ${formId}:`, req.body, `| Assigned AI Score: ${score}`);

    const contact = await prisma.contact.upsert({
      where: { email: contactEmail },
      update: { source: "Embedded Web Form" },
      create: {
        name: contactName,
        email: contactEmail,
        company: contactCompany,
        status: "Lead",
        source: "Embedded Web Form",
        aiScore: score,
        tenantId: 1, // default org for inbound public form submissions
      }
    });

    const deal = await prisma.deal.create({
      data: {
        title: `Inbound: ${contactCompany}`,
        amount: 0,
        stage: "lead",
        contactId: contact.id,
        tenantId: contact.tenantId || 1,
      }
    });

    // Broadcast to real-time clients!
    if (req.io) {
      req.io.emit('deal_updated', deal);
    }

    res.status(201).json({ success: true, message: "Submission captured successfully in CRM Pipeline." });
  } catch (err) {
    console.error("[FormIngestion Error]:", err);
    res.status(500).json({ error: "Failed to process form submission." });
  }
});

module.exports = router;
