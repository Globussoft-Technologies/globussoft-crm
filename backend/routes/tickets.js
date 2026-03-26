const express = require("express");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

// Publicly Exposed Ingress for Support Portal Submission
router.post("/submit", async (req, res) => {
  try {
    const { subject, description, priority } = req.body;
    
    const ticket = await prisma.ticket.create({
      data: {
        subject,
        description,
        priority: priority || "Low",
        status: "Open"
      }
    });

    res.status(201).json({ success: true, ticketId: ticket.id, message: "Telemetry tracked." });
  } catch (err) {
    res.status(500).json({ error: "Architecture failed to lodge support ticket parameters." });
  }
});

module.exports = router;
