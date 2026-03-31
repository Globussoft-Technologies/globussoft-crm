const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();
const prisma = new PrismaClient();

// Internal Algorithmic Weight Configurations (Deal-based scoring)
const weights = {
  stage: { lead: 10, contacted: 25, proposal: 50, won: 100, lost: 0 },
  budgetMultiplier: 0.0005,
  baseConfidence: 0.2,
};

// ─── Deal-based scoring (existing endpoint, unchanged) ─────────────────────
router.get("/score/:dealId", async (req, res) => {
  try {
    const { dealId } = req.params;

    const deal = await prisma.deal.findUnique({
      where: { id: parseInt(dealId) },
      include: { contact: { include: { activities: true } } },
    });

    if (!deal) return res.status(404).json({ error: "Deal not found" });

    let probabilityScore = weights.stage[deal.stage.toLowerCase()] || 10;
    const budgetBonus = Math.min(deal.amount * weights.budgetMultiplier, 20);
    probabilityScore += budgetBonus;

    const engagementMetrics = deal.contact?.activities?.length || 0;
    if (engagementMetrics > 5) probabilityScore += 15;
    else if (engagementMetrics > 0) probabilityScore += 5;

    if (deal.expectedClose) {
      const daysUntilClose =
        (new Date(deal.expectedClose) - new Date()) / (1000 * 3600 * 24);
      if (daysUntilClose < 0) probabilityScore -= 30;
      else if (daysUntilClose <= 7) probabilityScore += 10;
    }

    probabilityScore = Math.max(1, Math.min(Math.round(probabilityScore), 99));

    let confidence = "Low";
    if (probabilityScore > 75) confidence = "Extremely High";
    else if (probabilityScore > 50) confidence = "Moderate";

    res.json({
      dealId: deal.id,
      title: deal.title,
      predictiveVariables: {
        stageWeight: weights.stage[deal.stage.toLowerCase()] || 0,
        budgetBonus: Math.round(budgetBonus),
        engagementLevel: engagementMetrics,
      },
      probability: probabilityScore,
      confidence,
    });
  } catch (error) {
    res.status(500).json({ error: "Predictive AI Model crashed" });
  }
});

// ─── Contact-level score breakdown ─────────────────────────────────────────
router.get("/contact/:contactId", verifyToken, async (req, res) => {
  try {
    const contactId = parseInt(req.params.contactId);
    if (isNaN(contactId)) return res.status(400).json({ error: "Invalid contactId" });

    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        deals: true,
        activities: true,
        sequenceEnrollments: true,
      },
    });

    if (!contact) return res.status(404).json({ error: "Contact not found" });

    const { computeScore } = require("../cron/leadScoringEngine");
    const score = computeScore(contact);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentActivityCount = contact.activities.filter(
      (a) => new Date(a.createdAt) > thirtyDaysAgo
    ).length;

    res.json({
      contactId: contact.id,
      name: contact.name,
      currentStoredScore: contact.aiScore,
      liveComputedScore: score,
      factors: {
        status: contact.status,
        totalDeals: contact.deals.length,
        wonDeals: contact.deals.filter((d) => d.stage === "won").length,
        proposalDeals: contact.deals.filter((d) => d.stage === "proposal").length,
        recentActivities: recentActivityCount,
        activeSequences: contact.sequenceEnrollments.filter(
          (e) => e.status === "Active"
        ).length,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get contact score" });
  }
});

// ─── Debug trigger endpoint ─────────────────────────────────────────────────
router.post("/trigger", async (req, res) => {
  try {
    const { tickLeadScoringEngine } = require("../cron/leadScoringEngine");
    const result = await tickLeadScoringEngine(req.io);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Scoring trigger failed" });
  }
});

module.exports = router;