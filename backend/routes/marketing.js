const express = require("express");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

// Public endpoint for embedded forms to POST to (CORS must be enabled in server.js)
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
        aiScore: score
      }
    });

    const deal = await prisma.deal.create({
      data: {
        title: `Inbound: ${contactCompany}`,
        amount: 0,
        stage: "lead",
        contactId: contact.id
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