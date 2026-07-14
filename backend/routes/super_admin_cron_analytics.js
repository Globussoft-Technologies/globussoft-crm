/**
 * routes/super_admin_cron_analytics.js — Cron Analytics module (Super Admin
 * Portal). Read-only aggregation over CronExecutionLog for the charts on
 * the /super-admin/cron-analytics page: runs-over-time, success/fail split,
 * average duration trend, and per-cron summary rows.
 *
 * All routes require requireSuperAdmin (mounted with that middleware in
 * server.js), same as routes/super_admin_cron.js.
 *
 * Endpoint: GET /overview?days=<1-90, default 14>
 */

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");

const MAX_DAYS = 90;
const DEFAULT_DAYS = 14;

function dayKey(d) {
  return new Date(d).toISOString().slice(0, 10); // YYYY-MM-DD
}

router.get("/overview", async (req, res) => {
  try {
    const daysRaw = parseInt(req.query.days, 10);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, MAX_DAYS) : DEFAULT_DAYS;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const logs = await prisma.cronExecutionLog.findMany({
      where: { startedAt: { gte: since } },
      select: { cronName: true, startedAt: true, durationMs: true, status: true },
      orderBy: { startedAt: "asc" },
    });

    // Runs-over-time — one bucket per calendar day, counts by status.
    const byDayMap = new Map();
    for (const log of logs) {
      const key = dayKey(log.startedAt);
      if (!byDayMap.has(key)) byDayMap.set(key, { date: key, success: 0, failed: 0, running: 0, total: 0 });
      const bucket = byDayMap.get(key);
      bucket.total += 1;
      if (log.status === "success") bucket.success += 1;
      else if (log.status === "failed") bucket.failed += 1;
      else bucket.running += 1;
    }
    const byDay = [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Overall status split (pie/donut).
    const statusTotals = { success: 0, failed: 0, running: 0 };
    for (const log of logs) {
      if (log.status === "success") statusTotals.success += 1;
      else if (log.status === "failed") statusTotals.failed += 1;
      else statusTotals.running += 1;
    }

    // Per-cron summary — run count, failure count, average duration.
    const perCronMap = new Map();
    for (const log of logs) {
      if (!perCronMap.has(log.cronName)) {
        perCronMap.set(log.cronName, { cronName: log.cronName, runs: 0, failures: 0, totalDurationMs: 0, durationSamples: 0 });
      }
      const c = perCronMap.get(log.cronName);
      c.runs += 1;
      if (log.status === "failed") c.failures += 1;
      if (typeof log.durationMs === "number") {
        c.totalDurationMs += log.durationMs;
        c.durationSamples += 1;
      }
    }
    const perCron = [...perCronMap.values()]
      .map((c) => ({
        cronName: c.cronName,
        runs: c.runs,
        failures: c.failures,
        avgDurationMs: c.durationSamples > 0 ? Math.round(c.totalDurationMs / c.durationSamples) : null,
      }))
      .sort((a, b) => b.runs - a.runs);

    res.json({
      days,
      since: since.toISOString(),
      totals: { runs: logs.length, ...statusTotals },
      byDay,
      perCron,
    });
  } catch (e) {
    console.error("[super-admin-cron-analytics] GET /overview failed:", e.message);
    res.status(500).json({ error: "Failed to load cron analytics" });
  }
});

module.exports = router;
