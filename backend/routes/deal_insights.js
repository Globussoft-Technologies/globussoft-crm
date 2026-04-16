const express = require("express");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const router = express.Router();

const GEMINI_KEY = process.env.GEMINI_API_KEY;
let aiModel = null;
if (GEMINI_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    aiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    console.log("[DealInsights] Gemini initialized");
  } catch (err) {
    console.warn("[DealInsights] Gemini init failed:", err.message);
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

router.use(verifyToken);

// ── GET / : list insights for tenant (filter by severity, dealId, isResolved) ─
router.get("/", async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    if (req.query.severity) where.severity = req.query.severity;
    if (req.query.dealId) where.dealId = parseInt(req.query.dealId);
    if (req.query.isResolved !== undefined) {
      where.isResolved = req.query.isResolved === "true";
    }
    const insights = await prisma.dealInsight.findMany({
      where,
      orderBy: { generatedAt: "desc" },
      take: 500,
    });
    res.json(insights);
  } catch (err) {
    console.error("[DealInsights GET /] ", err);
    res.status(500).json({ error: "Failed to fetch insights" });
  }
});

// ── GET /stats : count by type/severity for tenant ──
router.get("/stats", async (req, res) => {
  try {
    const where = { tenantId: req.user.tenantId };
    const [byType, bySeverity, openCount, resolvedCount] = await Promise.all([
      prisma.dealInsight.groupBy({ by: ["type"], where, _count: { _all: true } }),
      prisma.dealInsight.groupBy({ by: ["severity"], where, _count: { _all: true } }),
      prisma.dealInsight.count({ where: { ...where, isResolved: false } }),
      prisma.dealInsight.count({ where: { ...where, isResolved: true } }),
    ]);
    res.json({
      byType: byType.map(r => ({ type: r.type, count: r._count._all })),
      bySeverity: bySeverity.map(r => ({ severity: r.severity, count: r._count._all })),
      openCount,
      resolvedCount,
    });
  } catch (err) {
    console.error("[DealInsights GET /stats] ", err);
    res.status(500).json({ error: "Failed to compute stats" });
  }
});

// ── GET /deal/:dealId : list insights for a specific deal ──
router.get("/deal/:dealId", async (req, res) => {
  try {
    const dealId = parseInt(req.params.dealId);
    if (isNaN(dealId)) return res.status(400).json({ error: "Invalid dealId" });
    // Verify deal belongs to tenant
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, tenantId: req.user.tenantId },
    });
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    const insights = await prisma.dealInsight.findMany({
      where: { dealId, tenantId: req.user.tenantId },
      orderBy: { generatedAt: "desc" },
    });
    res.json(insights);
  } catch (err) {
    console.error("[DealInsights GET /deal/:id] ", err);
    res.status(500).json({ error: "Failed to fetch deal insights" });
  }
});

// ── Heuristic rules engine (shared with cron) ─────────────────────
async function runHeuristicRules(deal) {
  const insights = [];
  const now = new Date();

  // Combine activity-like signals
  const activities = deal.contact?.activities || [];
  const emails = deal.contact?.emails || [];
  const calls = deal.contact?.callLogs || [];

  const allTouchTimes = [
    ...activities.map(a => new Date(a.createdAt)),
    ...emails.map(e => new Date(e.createdAt)),
    ...calls.map(c => new Date(c.createdAt)),
  ].sort((a, b) => b - a);

  const lastTouch = allTouchTimes[0];
  const stage = (deal.stage || "").toLowerCase();

  // RISK: No activity in 30+ days
  if (!lastTouch || (now - lastTouch) > 30 * MS_PER_DAY) {
    insights.push({
      type: "RISK",
      severity: "WARNING",
      insight: lastTouch
        ? `No activity in ${Math.floor((now - lastTouch) / MS_PER_DAY)} days. Deal may be going cold.`
        : "No activity recorded for this deal. Initiate outreach immediately.",
    });
  }

  // RISK: Past expected close date
  if (deal.expectedClose && new Date(deal.expectedClose) < now && stage !== "won" && stage !== "lost") {
    const daysOverdue = Math.floor((now - new Date(deal.expectedClose)) / MS_PER_DAY);
    insights.push({
      type: "RISK",
      severity: "CRITICAL",
      insight: `Deal is ${daysOverdue} day(s) past expected close date and still in "${deal.stage}" stage.`,
    });
  }

  // RISK: Low engagement
  if (emails.length === 0 && calls.length === 0) {
    insights.push({
      type: "RISK",
      severity: "WARNING",
      insight: "Low engagement: no emails or calls logged with this contact yet.",
    });
  }

  // OPPORTUNITY: Multiple decision makers engaged (>3 distinct email addresses)
  const distinctEmailParticipants = new Set();
  emails.forEach(e => {
    if (e.from) distinctEmailParticipants.add(String(e.from).toLowerCase());
    if (e.to) distinctEmailParticipants.add(String(e.to).toLowerCase());
  });
  if (distinctEmailParticipants.size > 3) {
    insights.push({
      type: "OPPORTUNITY",
      severity: "INFO",
      insight: `Multiple decision makers engaged (${distinctEmailParticipants.size} distinct participants). Strong buying signal.`,
    });
  }

  // NEXT_BEST_ACTION: Send follow-up if last email was 7-14 days ago
  const lastEmail = emails
    .map(e => new Date(e.createdAt))
    .sort((a, b) => b - a)[0];
  if (lastEmail) {
    const daysSinceEmail = (now - lastEmail) / MS_PER_DAY;
    if (daysSinceEmail >= 7 && daysSinceEmail <= 14) {
      insights.push({
        type: "NEXT_BEST_ACTION",
        severity: "INFO",
        insight: `Last email was ${Math.floor(daysSinceEmail)} days ago — ideal window to send a follow-up.`,
      });
    }
  }

  return insights;
}

// ── Persist insights with dedup (don't recreate same type+insight if unresolved exists) ──
async function persistInsights(dealId, tenantId, candidates) {
  const saved = [];
  for (const c of candidates) {
    const existing = await prisma.dealInsight.findFirst({
      where: {
        dealId,
        tenantId,
        type: c.type,
        insight: c.insight,
        isResolved: false,
      },
    });
    if (existing) continue;
    const created = await prisma.dealInsight.create({
      data: {
        dealId,
        tenantId,
        type: c.type,
        severity: c.severity || "INFO",
        insight: c.insight,
      },
    });
    saved.push(created);
  }
  return saved;
}

// ── POST /generate/:dealId : run rules + AI for this deal ─────────
router.post("/generate/:dealId", async (req, res) => {
  try {
    const dealId = parseInt(req.params.dealId);
    if (isNaN(dealId)) return res.status(400).json({ error: "Invalid dealId" });

    const deal = await prisma.deal.findFirst({
      where: { id: dealId, tenantId: req.user.tenantId },
      include: {
        contact: {
          include: {
            activities: { orderBy: { createdAt: "desc" }, take: 50 },
            emails: { orderBy: { createdAt: "desc" }, take: 50 },
            callLogs: { orderBy: { createdAt: "desc" }, take: 50 },
          },
        },
      },
    });
    if (!deal) return res.status(404).json({ error: "Deal not found" });

    const candidates = await runHeuristicRules(deal);

    // Optional Gemini-generated insight
    if (aiModel) {
      try {
        const prompt = `You are a CRM sales analyst. Based on the following deal data, give EXACTLY ONE sentence (max 30 words) of actionable insight for the sales rep. No preamble, no quotes, no markdown — just one sentence.

Deal: "${deal.title}"
Amount: $${deal.amount}
Stage: ${deal.stage}
Probability: ${deal.probability}%
Expected close: ${deal.expectedClose || "not set"}
Contact: ${deal.contact?.name || "Unknown"} at ${deal.contact?.company || "Unknown company"}
Status: ${deal.contact?.status || "unknown"}
Recent emails: ${(deal.contact?.emails || []).slice(0, 3).map(e => e.subject).join("; ") || "none"}
Recent calls: ${(deal.contact?.callLogs || []).length} call(s)
Recent activities: ${(deal.contact?.activities || []).slice(0, 3).map(a => `${a.type}: ${(a.description || "").slice(0, 60)}`).join("; ") || "none"}`;

        const result = await aiModel.generateContent(prompt);
        const aiText = (result.response.text() || "").trim().replace(/^["']|["']$/g, "");
        if (aiText) {
          candidates.push({
            type: "NEXT_BEST_ACTION",
            severity: "INFO",
            insight: `[AI] ${aiText}`,
          });
        }
      } catch (aiErr) {
        console.warn("[DealInsights] AI insight skipped:", aiErr.message);
      }
    }

    const saved = await persistInsights(dealId, req.user.tenantId, candidates);
    res.json({ generated: saved.length, insights: saved, evaluated: candidates.length });
  } catch (err) {
    console.error("[DealInsights POST /generate/:id] ", err);
    res.status(500).json({ error: "Failed to generate insights" });
  }
});

// ── POST /:id/resolve : mark insight as resolved ──
router.post("/:id/resolve", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const existing = await prisma.dealInsight.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Insight not found" });
    const updated = await prisma.dealInsight.update({
      where: { id },
      data: { isResolved: true },
    });
    res.json(updated);
  } catch (err) {
    console.error("[DealInsights POST /:id/resolve] ", err);
    res.status(500).json({ error: "Failed to resolve insight" });
  }
});

// ── DELETE /:id (tenant-checked) ──
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const existing = await prisma.dealInsight.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing) return res.status(404).json({ error: "Insight not found" });
    await prisma.dealInsight.delete({ where: { id } });
    res.json({ deleted: true });
  } catch (err) {
    console.error("[DealInsights DELETE /:id] ", err);
    res.status(500).json({ error: "Failed to delete insight" });
  }
});

module.exports = router;
module.exports.runHeuristicRules = runHeuristicRules;
module.exports.persistInsights = persistInsights;
