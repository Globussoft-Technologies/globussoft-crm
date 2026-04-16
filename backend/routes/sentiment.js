/**
 * Sentiment Analysis API
 *
 * Mounted at /api/sentiment by the orchestrator.
 * All routes are protected by the global verifyToken guard in server.js;
 * we attach verifyToken explicitly as a defense-in-depth measure.
 *
 * Multi-tenant: every query is scoped by req.user.tenantId.
 */

const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const { analyzeMessage } = require("../cron/sentimentEngine");

/**
 * POST /api/sentiment/analyze
 * Body: { text: string }
 * Returns: { sentiment, sentimentScore }
 *
 * Stateless ad-hoc analysis (does not touch the DB).
 */
router.post("/analyze", verifyToken, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Field 'text' (string) is required." });
    }
    const result = await analyzeMessage(text);
    res.json(result);
  } catch (err) {
    console.error("[Sentiment][/analyze] Error:", err);
    res.status(500).json({ error: "Failed to analyze text." });
  }
});

/**
 * POST /api/sentiment/analyze-message/:emailId
 * Analyze a specific email (current tenant only) and persist the result.
 */
router.post("/analyze-message/:emailId", verifyToken, async (req, res) => {
  try {
    const emailId = parseInt(req.params.emailId, 10);
    if (Number.isNaN(emailId)) {
      return res.status(400).json({ error: "Invalid emailId." });
    }

    const message = await prisma.emailMessage.findFirst({
      where: { id: emailId, tenantId: req.user.tenantId },
    });
    if (!message) {
      return res.status(404).json({ error: "Email not found." });
    }

    const { sentiment, sentimentScore } = await analyzeMessage(message.body);
    const updated = await prisma.emailMessage.update({
      where: { id: emailId },
      data: { sentiment, sentimentScore },
    });

    res.json({ id: updated.id, sentiment: updated.sentiment, sentimentScore: updated.sentimentScore });
  } catch (err) {
    console.error("[Sentiment][/analyze-message] Error:", err);
    res.status(500).json({ error: "Failed to analyze message." });
  }
});

/**
 * POST /api/sentiment/analyze-batch
 * Body: { emailIds: number[] }
 * Returns: { results: [{ id, sentiment, sentimentScore }], errors: [...] }
 *
 * Tenant-scoped — silently ignores ids that don't belong to this tenant.
 */
router.post("/analyze-batch", verifyToken, async (req, res) => {
  try {
    const { emailIds } = req.body || {};
    if (!Array.isArray(emailIds) || emailIds.length === 0) {
      return res.status(400).json({ error: "Field 'emailIds' (non-empty array) is required." });
    }

    const ids = emailIds
      .map(v => parseInt(v, 10))
      .filter(v => !Number.isNaN(v))
      .slice(0, 200); // hard cap so a single request can't run forever

    const messages = await prisma.emailMessage.findMany({
      where: { id: { in: ids }, tenantId: req.user.tenantId },
    });

    const results = [];
    const errors = [];
    for (const msg of messages) {
      try {
        const { sentiment, sentimentScore } = await analyzeMessage(msg.body);
        await prisma.emailMessage.update({
          where: { id: msg.id },
          data: { sentiment, sentimentScore },
        });
        results.push({ id: msg.id, sentiment, sentimentScore });
      } catch (err) {
        errors.push({ id: msg.id, error: err.message });
      }
    }

    res.json({ requested: ids.length, processed: results.length, results, errors });
  } catch (err) {
    console.error("[Sentiment][/analyze-batch] Error:", err);
    res.status(500).json({ error: "Failed to analyze batch." });
  }
});

/**
 * GET /api/sentiment/stats
 * Returns sentiment distribution, average score, and a 30-day daily trend
 * for the current tenant.
 */
router.get("/stats", verifyToken, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    const grouped = await prisma.emailMessage.groupBy({
      by: ["sentiment"],
      where: { tenantId, sentiment: { not: null } },
      _count: { _all: true },
      _avg: { sentimentScore: true },
    });

    const counts = { positive: 0, neutral: 0, negative: 0 };
    let weightedScoreSum = 0;
    let totalScored = 0;
    for (const row of grouped) {
      const key = row.sentiment;
      if (key in counts) counts[key] = row._count._all;
      if (typeof row._avg.sentimentScore === "number") {
        weightedScoreSum += row._avg.sentimentScore * row._count._all;
        totalScored += row._count._all;
      }
    }
    const avgScore = totalScored > 0 ? Number((weightedScoreSum / totalScored).toFixed(3)) : 0;

    // 30-day daily trend (grouped in JS — works across MySQL/PG without raw SQL)
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recent = await prisma.emailMessage.findMany({
      where: { tenantId, sentiment: { not: null }, createdAt: { gte: since } },
      select: { sentiment: true, sentimentScore: true, createdAt: true },
    });

    const trendMap = {};
    for (const m of recent) {
      const day = m.createdAt.toISOString().slice(0, 10);
      if (!trendMap[day]) {
        trendMap[day] = { date: day, positive: 0, neutral: 0, negative: 0, scoreSum: 0, count: 0 };
      }
      if (m.sentiment in trendMap[day]) trendMap[day][m.sentiment] += 1;
      if (typeof m.sentimentScore === "number") {
        trendMap[day].scoreSum += m.sentimentScore;
        trendMap[day].count += 1;
      }
    }
    const trend = Object.values(trendMap)
      .map(d => ({
        date: d.date,
        positive: d.positive,
        neutral: d.neutral,
        negative: d.negative,
        avgScore: d.count > 0 ? Number((d.scoreSum / d.count).toFixed(3)) : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      counts,
      total: counts.positive + counts.neutral + counts.negative,
      avgScore,
      trend,
    });
  } catch (err) {
    console.error("[Sentiment][/stats] Error:", err);
    res.status(500).json({ error: "Failed to compute sentiment stats." });
  }
});

/**
 * GET /api/sentiment/negative-recent
 * Most recent emails with sentiment=negative for the current tenant.
 * Used as a "needs attention" alert list for support reps.
 *
 * Optional query: ?limit=20 (default 20, max 100)
 */
router.get("/negative-recent", verifyToken, async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (Number.isNaN(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;

    const messages = await prisma.emailMessage.findMany({
      where: { tenantId: req.user.tenantId, sentiment: "negative" },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        contact: { select: { id: true, name: true, email: true, company: true } },
      },
    });

    res.json({ count: messages.length, messages });
  } catch (err) {
    console.error("[Sentiment][/negative-recent] Error:", err);
    res.status(500).json({ error: "Failed to fetch negative emails." });
  }
});

module.exports = router;
