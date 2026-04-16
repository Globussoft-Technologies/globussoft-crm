const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

// ─── Period Helpers ──────────────────────────────────────────────
// Accepts:
//   "2026-Q2"  — quarter
//   "2026"     — full year
//   "2026-04"  — month
function parsePeriodRange(period) {
  if (!period) {
    const now = new Date();
    const q = Math.floor(now.getMonth() / 3) + 1;
    period = `${now.getFullYear()}-Q${q}`;
  }

  const qMatch = /^(\d{4})-Q([1-4])$/.exec(period);
  if (qMatch) {
    const year = parseInt(qMatch[1], 10);
    const q = parseInt(qMatch[2], 10);
    const startMonth = (q - 1) * 3;
    const start = new Date(Date.UTC(year, startMonth, 1));
    const end = new Date(Date.UTC(year, startMonth + 3, 1));
    return { start, end, period };
  }

  const mMatch = /^(\d{4})-(\d{2})$/.exec(period);
  if (mMatch) {
    const year = parseInt(mMatch[1], 10);
    const month = parseInt(mMatch[2], 10) - 1;
    const start = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 1));
    return { start, end, period };
  }

  const yMatch = /^(\d{4})$/.exec(period);
  if (yMatch) {
    const year = parseInt(yMatch[1], 10);
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year + 1, 0, 1));
    return { start, end, period };
  }

  // fallback: current quarter
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;
  const startMonth = (q - 1) * 3;
  const start = new Date(Date.UTC(now.getFullYear(), startMonth, 1));
  const end = new Date(Date.UTC(now.getFullYear(), startMonth + 3, 1));
  return { start, end, period: `${now.getFullYear()}-Q${q}` };
}

const OPEN_STAGES = (deal) => {
  const s = (deal.stage || "").toLowerCase();
  return s !== "won" && s !== "lost";
};

function bucketDealMetrics(deals) {
  // expected = sum(amount * probability/100) for OPEN deals
  // committed = sum(amount) where stage == "won" OR probability >= 90
  // bestCase  = sum(amount) for ALL OPEN deals
  // closed    = sum(amount) where stage == "won"
  let expected = 0;
  let committed = 0;
  let bestCase = 0;
  let closed = 0;

  for (const d of deals) {
    const amount = Number(d.amount) || 0;
    const probability = Number(d.probability) || 0;
    const stage = (d.stage || "").toLowerCase();
    const isOpen = OPEN_STAGES(d);

    if (isOpen) {
      expected += amount * (probability / 100);
      bestCase += amount;
    }
    if (stage === "won" || probability >= 90) {
      committed += amount;
    }
    if (stage === "won") {
      closed += amount;
    }
  }

  return {
    expected: Math.round(expected * 100) / 100,
    committed: Math.round(committed * 100) / 100,
    bestCase: Math.round(bestCase * 100) / 100,
    closed: Math.round(closed * 100) / 100,
  };
}

// ─── GET /current?period=2026-Q2 ─────────────────────────────────
router.get("/current", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { start, end, period } = parsePeriodRange(req.query.period);

    const deals = await prisma.deal.findMany({
      where: {
        tenantId,
        expectedClose: { gte: start, lt: end },
      },
      include: { owner: { select: { id: true, name: true, email: true } } },
    });

    // Group by ownerId
    const byOwner = new Map();
    for (const d of deals) {
      const ownerId = d.ownerId || 0;
      if (!byOwner.has(ownerId)) {
        byOwner.set(ownerId, {
          userId: ownerId,
          name: d.owner ? (d.owner.name || d.owner.email) : "Unassigned",
          deals: [],
        });
      }
      byOwner.get(ownerId).deals.push(d);
    }

    const byUser = [];
    for (const entry of byOwner.values()) {
      const metrics = bucketDealMetrics(entry.deals);
      byUser.push({
        userId: entry.userId,
        name: entry.name,
        expected: metrics.expected,
        committed: metrics.committed,
        bestCase: metrics.bestCase,
        closed: metrics.closed,
      });
    }

    byUser.sort((a, b) => b.expected - a.expected);
    const total = bucketDealMetrics(deals);

    res.json({ period, byUser, total });
  } catch (err) {
    console.error("[forecasting/current]", err);
    res.status(500).json({ error: "Failed to compute forecast" });
  }
});

// ─── GET /pipeline?period= ───────────────────────────────────────
// Returns deals grouped by stage for the period.
router.get("/pipeline", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { start, end, period } = parsePeriodRange(req.query.period);

    const deals = await prisma.deal.findMany({
      where: {
        tenantId,
        expectedClose: { gte: start, lt: end },
      },
      orderBy: { amount: "desc" },
    });

    const byStage = new Map();
    for (const d of deals) {
      const stage = (d.stage || "lead").toLowerCase();
      if (!byStage.has(stage)) {
        byStage.set(stage, { stage, count: 0, amount: 0, weightedAmount: 0, deals: [] });
      }
      const entry = byStage.get(stage);
      const amount = Number(d.amount) || 0;
      const probability = Number(d.probability) || 0;
      entry.count += 1;
      entry.amount += amount;
      entry.weightedAmount += amount * (probability / 100);
      entry.deals.push({
        id: d.id,
        title: d.title,
        amount,
        probability,
        expectedClose: d.expectedClose,
        ownerId: d.ownerId,
      });
    }

    const stages = Array.from(byStage.values()).map((s) => ({
      ...s,
      amount: Math.round(s.amount * 100) / 100,
      weightedAmount: Math.round(s.weightedAmount * 100) / 100,
    }));

    res.json({ period, stages });
  } catch (err) {
    console.error("[forecasting/pipeline]", err);
    res.status(500).json({ error: "Failed to fetch pipeline forecast" });
  }
});

// ─── GET /trend?months=12 ────────────────────────────────────────
// Monthly closed revenue for past N months.
router.get("/trend", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 60);

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const deals = await prisma.deal.findMany({
      where: {
        tenantId,
        stage: "won",
        expectedClose: { gte: start, lt: end },
      },
      select: { amount: true, expectedClose: true },
    });

    // Build month buckets
    const buckets = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      buckets.push({ month: label, closed: 0 });
    }
    const idxOf = (date) => {
      const d = new Date(date);
      return (d.getUTCFullYear() - start.getUTCFullYear()) * 12 + (d.getUTCMonth() - start.getUTCMonth());
    };

    for (const d of deals) {
      if (!d.expectedClose) continue;
      const i = idxOf(d.expectedClose);
      if (i >= 0 && i < buckets.length) {
        buckets[i].closed += Number(d.amount) || 0;
      }
    }

    buckets.forEach((b) => (b.closed = Math.round(b.closed * 100) / 100));

    res.json({ months, trend: buckets });
  } catch (err) {
    console.error("[forecasting/trend]", err);
    res.status(500).json({ error: "Failed to fetch trend" });
  }
});

// ─── POST /save ──────────────────────────────────────────────────
// Saves a Forecast record (manual override / snapshot).
router.post("/save", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const {
      period,
      expectedRevenue = 0,
      committedRevenue = 0,
      bestCaseRevenue = 0,
      closedRevenue = 0,
      userId = null,
    } = req.body || {};

    if (!period) return res.status(400).json({ error: "period is required" });

    const forecast = await prisma.forecast.create({
      data: {
        period,
        expectedRevenue: Number(expectedRevenue) || 0,
        committedRevenue: Number(committedRevenue) || 0,
        bestCaseRevenue: Number(bestCaseRevenue) || 0,
        closedRevenue: Number(closedRevenue) || 0,
        userId: userId ? Number(userId) : null,
        tenantId,
      },
    });

    res.status(201).json(forecast);
  } catch (err) {
    console.error("[forecasting/save]", err);
    res.status(500).json({ error: "Failed to save forecast" });
  }
});

// ─── GET /history ────────────────────────────────────────────────
router.get("/history", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const records = await prisma.forecast.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json(records);
  } catch (err) {
    console.error("[forecasting/history]", err);
    res.status(500).json({ error: "Failed to fetch forecast history" });
  }
});

module.exports = router;
