const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

// ─── Stage Order Helpers ─────────────────────────────────────────
// We don't track stage history directly. Use canonical lead → contacted →
// proposal → won/lost ordering as a heuristic for "ever entered".
const DEFAULT_STAGE_ORDER = ["lead", "contacted", "proposal", "won"];
const TERMINAL_STAGES = new Set(["won", "lost"]);

function normalizeStageName(name) {
  return String(name || "").trim().toLowerCase();
}

async function loadStageOrder(tenantId) {
  const stages = await prisma.pipelineStage.findMany({
    where: { tenantId },
    orderBy: { position: "asc" },
  });
  if (!stages.length) {
    return DEFAULT_STAGE_ORDER.map((name, i) => ({ name, position: i }));
  }
  const names = stages.map((s) => normalizeStageName(s.name));
  // Ensure the canonical "won" appears as the final progression bucket
  if (!names.includes("won")) names.push("won");
  return names.map((name, position) => ({ name, position }));
}

function buildDateFilter(from, to) {
  const filter = {};
  if (from) filter.gte = new Date(from);
  if (to) filter.lte = new Date(to);
  return Object.keys(filter).length ? filter : undefined;
}

function dayDiff(a, b) {
  if (!a || !b) return 0;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(0, ms / (1000 * 60 * 60 * 24));
}

// ─── GET /stages ─────────────────────────────────────────────────
// Per-stage funnel breakdown. Uses canonical stage progression so that
// any deal at a later stage is counted as "ever entered" earlier stages.
router.get("/stages", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { pipelineId, from, to } = req.query;

    const stageOrder = await loadStageOrder(tenantId);
    const stageIndex = new Map(stageOrder.map((s, i) => [s.name, i]));

    const where = { tenantId };
    if (pipelineId) where.pipelineId = parseInt(pipelineId, 10);
    const dateFilter = buildDateFilter(from, to);
    if (dateFilter) where.createdAt = dateFilter;

    const deals = await prisma.deal.findMany({ where });

    // Bucket per stage: current count, totalEntered, totalValue, avgDays
    const buckets = stageOrder.map(({ name }) => ({
      name,
      current: 0,
      totalEntered: 0,
      totalValue: 0,
      _ageDays: [],
    }));

    const now = Date.now();

    for (const d of deals) {
      const stage = normalizeStageName(d.stage);
      const idx = stageIndex.has(stage) ? stageIndex.get(stage) : -1;
      if (idx === -1) continue;

      // Mark current
      buckets[idx].current += 1;
      buckets[idx].totalValue += Number(d.amount) || 0;

      // Compute age — for terminal deals use createdAt → expectedClose if set
      const end = TERMINAL_STAGES.has(stage) && d.expectedClose
        ? new Date(d.expectedClose).getTime()
        : now;
      buckets[idx]._ageDays.push(dayDiff(d.createdAt, end));

      // Ever-entered: every stage with index <= current stage
      // (plus "lost" deals also passed through the prior stages)
      for (let i = 0; i <= idx; i++) {
        buckets[i].totalEntered += 1;
      }
    }

    // Lost deals don't have a position in the canonical order — count them as
    // having passed through all non-terminal stages.
    const nonTerminalIndexes = stageOrder
      .map((s, i) => (TERMINAL_STAGES.has(s.name) ? -1 : i))
      .filter((i) => i >= 0);
    for (const d of deals) {
      const stage = normalizeStageName(d.stage);
      if (stage !== "lost") continue;
      for (const i of nonTerminalIndexes) buckets[i].totalEntered += 1;
    }

    const result = buckets.map((b, i) => {
      const next = buckets[i + 1];
      const conversionToNext = next && b.totalEntered > 0
        ? Math.round((next.totalEntered / b.totalEntered) * 1000) / 10
        : null;
      const avgDays = b._ageDays.length
        ? Math.round((b._ageDays.reduce((a, n) => a + n, 0) / b._ageDays.length) * 10) / 10
        : 0;
      return {
        name: b.name,
        current: b.current,
        totalEntered: b.totalEntered,
        conversionToNext,
        avgDays,
        totalValue: Math.round(b.totalValue * 100) / 100,
      };
    });

    res.json({ stages: result });
  } catch (err) {
    console.error("[funnel/stages]", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /conversion-by-source ───────────────────────────────────
router.get("/conversion-by-source", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { from, to } = req.query;
    const where = { tenantId };
    const dateFilter = buildDateFilter(from, to);
    if (dateFilter) where.createdAt = dateFilter;

    const contacts = await prisma.contact.findMany({
      where,
      select: { id: true, source: true, status: true },
    });

    const bySource = new Map();
    for (const c of contacts) {
      const src = c.source || "Unknown";
      if (!bySource.has(src)) bySource.set(src, { source: src, count: 0, won: 0 });
      const b = bySource.get(src);
      b.count += 1;
      if ((c.status || "").toLowerCase() === "customer") b.won += 1;
    }

    const out = Array.from(bySource.values())
      .map((b) => ({
        ...b,
        conversionRate: b.count > 0 ? Math.round((b.won / b.count) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count);

    res.json(out);
  } catch (err) {
    console.error("[funnel/conversion-by-source]", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /by-rep ─────────────────────────────────────────────────
router.get("/by-rep", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { from, to } = req.query;

    const stageOrder = await loadStageOrder(tenantId);
    const stageIndex = new Map(stageOrder.map((s, i) => [s.name, i]));

    const where = { tenantId };
    const dateFilter = buildDateFilter(from, to);
    if (dateFilter) where.createdAt = dateFilter;

    const deals = await prisma.deal.findMany({
      where,
      include: { owner: { select: { id: true, name: true, email: true } } },
    });

    const byRep = new Map();
    for (const d of deals) {
      const ownerId = d.ownerId || 0;
      const ownerLabel = d.owner?.name || d.owner?.email || "Unassigned";
      if (!byRep.has(ownerId)) {
        byRep.set(ownerId, {
          ownerId,
          owner: ownerLabel,
          total: 0,
          won: 0,
          lost: 0,
          open: 0,
          revenue: 0,
          stages: Object.fromEntries(stageOrder.map((s) => [s.name, 0])),
        });
      }
      const r = byRep.get(ownerId);
      r.total += 1;
      const stage = normalizeStageName(d.stage);
      if (stage === "won") {
        r.won += 1;
        r.revenue += Number(d.amount) || 0;
      } else if (stage === "lost") {
        r.lost += 1;
      } else {
        r.open += 1;
      }
      if (stageIndex.has(stage)) {
        r.stages[stage] = (r.stages[stage] || 0) + 1;
      }
    }

    const out = Array.from(byRep.values())
      .map((r) => ({
        ...r,
        winRate: r.total > 0 ? Math.round((r.won / r.total) * 1000) / 10 : 0,
        revenue: Math.round(r.revenue * 100) / 100,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json(out);
  } catch (err) {
    console.error("[funnel/by-rep]", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /velocity ───────────────────────────────────────────────
// Average days a deal has spent (so far) at each stage. For terminal deals
// we use createdAt → expectedClose as the proxy duration.
router.get("/velocity", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const stageOrder = await loadStageOrder(tenantId);
    const deals = await prisma.deal.findMany({ where: { tenantId } });

    const buckets = new Map(stageOrder.map((s) => [s.name, []]));
    const now = Date.now();
    for (const d of deals) {
      const stage = normalizeStageName(d.stage);
      if (!buckets.has(stage)) continue;
      const end = TERMINAL_STAGES.has(stage) && d.expectedClose
        ? new Date(d.expectedClose).getTime()
        : now;
      buckets.get(stage).push(dayDiff(d.createdAt, end));
    }

    const out = stageOrder.map(({ name }) => {
      const arr = buckets.get(name) || [];
      const avg = arr.length ? arr.reduce((a, n) => a + n, 0) / arr.length : 0;
      return { stage: name, avgDaysInStage: Math.round(avg * 10) / 10 };
    });

    res.json(out);
  } catch (err) {
    console.error("[funnel/velocity]", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /trend ──────────────────────────────────────────────────
// Monthly count of deals entering each stage, by createdAt month.
router.get("/trend", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const months = Math.max(1, Math.min(36, parseInt(req.query.months, 10) || 6));

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));

    const stageOrder = await loadStageOrder(tenantId);
    const stageIndex = new Map(stageOrder.map((s, i) => [s.name, i]));

    const deals = await prisma.deal.findMany({
      where: { tenantId, createdAt: { gte: start } },
    });

    // Build month buckets
    const monthKeys = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      monthKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    }

    const empty = () => Object.fromEntries(stageOrder.map((s) => [s.name, 0]));
    const byMonth = new Map(monthKeys.map((k) => [k, { month: k, ...empty() }]));

    for (const d of deals) {
      const created = new Date(d.createdAt);
      const key = `${created.getUTCFullYear()}-${String(created.getUTCMonth() + 1).padStart(2, "0")}`;
      const row = byMonth.get(key);
      if (!row) continue;
      const stage = normalizeStageName(d.stage);
      const idx = stageIndex.has(stage) ? stageIndex.get(stage) : -1;
      if (idx === -1) {
        // lost / unknown — bucket into all non-terminal stages
        for (const s of stageOrder) {
          if (!TERMINAL_STAGES.has(s.name)) row[s.name] += 1;
        }
        continue;
      }
      // Ever entered: every stage with position <= idx
      for (let i = 0; i <= idx; i++) {
        row[stageOrder[i].name] += 1;
      }
    }

    res.json(monthKeys.map((k) => byMonth.get(k)));
  } catch (err) {
    console.error("[funnel/trend]", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
