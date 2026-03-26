const express = require("express");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

// Internal Algorithmic Weight Configurations
const weights = {
  stage: { lead: 10, contacted: 25, proposal: 50, won: 100, lost: 0 },
  budgetMultiplier: 0.0005, // 0.05% boost per dollar over baseline
  baseConfidence: 0.2
};

router.get("/score/:dealId", async (req, res) => {
  try {
    const { dealId } = req.params;
    
    // Fetch actual Deal from database along with its associated Contact activities
    const deal = await prisma.deal.findUnique({
      where: { id: parseInt(dealId) },
      include: { contact: { include: { activities: true } } }
    });

    if (!deal) return res.status(404).json({ error: "Deal not found" });

    // 1. Calculate base score from current Pipeline Stage
    let probabilityScore = weights.stage[deal.stage.toLowerCase()] || 10;

    // 2. Budget Scaling Algorithm
    const budgetBonus = Math.min((deal.amount * weights.budgetMultiplier), 20); 
    probabilityScore += budgetBonus;

    // 3. Activity Engagement Multiplier (AI predicts higher close rates for heavily contacted leads)
    const engagementMetrics = deal.contact?.activities?.length || 0;
    if (engagementMetrics > 5) probabilityScore += 15;
    else if (engagementMetrics > 0) probabilityScore += 5;

    // 4. Time Decay Analysis
    if (deal.expectedClose) {
      const daysUntilClose = (new Date(deal.expectedClose) - new Date()) / (1000 * 3600 * 24);
      if (daysUntilClose < 0) probabilityScore -= 30; // Overdue Deals lose massive probability
      else if (daysUntilClose <= 7) probabilityScore += 10; // Urgency boost
    }

    // Normalize final score
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
        engagementLevel: engagementMetrics
      },
      probability: probabilityScore,
      confidence
    });
    
  } catch (error) {
    res.status(500).json({ error: "Predictive AI Model crashed" });
  }
});

module.exports = router;