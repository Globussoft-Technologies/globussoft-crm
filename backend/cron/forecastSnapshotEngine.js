const cron = require("node-cron");
const prisma = require("../lib/prisma");

// ── Helpers ─────────────────────────────────────────────────────────

function currentQuarter() {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}

function quarterRange(period) {
  // period = "2026-Q2"
  const [year, q] = period.split("-Q");
  const startMonth = (parseInt(q) - 1) * 3;
  return {
    start: new Date(parseInt(year), startMonth, 1),
    end: new Date(parseInt(year), startMonth + 3, 0, 23, 59, 59),
  };
}

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sun, 1 = Mon
  const diff = (day === 0 ? -6 : 1 - day); // back to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(date) {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return end;
}

// ── Forecast computation ────────────────────────────────────────────

function computeForecast(deals, qStart, qEnd) {
  let expectedRevenue = 0;
  let committedRevenue = 0;
  let bestCaseRevenue = 0;
  let closedRevenue = 0;

  for (const deal of deals) {
    const amount = deal.amount || 0;
    const probability = deal.probability || 0;
    const stage = (deal.stage || "").toLowerCase();
    const isOpen = stage !== "won" && stage !== "lost";
    const expectedClose = deal.expectedClose ? new Date(deal.expectedClose) : null;
    const closesInQuarter =
      expectedClose && expectedClose >= qStart && expectedClose <= qEnd;

    // bestCase: ALL open deals
    if (isOpen) {
      bestCaseRevenue += amount;
    }

    // expected: open deals expected to close in current quarter, weighted by probability
    if (isOpen && closesInQuarter) {
      expectedRevenue += amount * (probability / 100);
    }

    // committed: stage=won OR probability >= 90
    if (stage === "won" || probability >= 90) {
      committedRevenue += amount;
    }

    // closed: stage=won AND closed in this quarter (use expectedClose as close date proxy)
    if (stage === "won" && closesInQuarter) {
      closedRevenue += amount;
    }
  }

  return {
    expectedRevenue,
    committedRevenue,
    bestCaseRevenue,
    closedRevenue,
  };
}

// ── Main runner ─────────────────────────────────────────────────────

async function runForecastSnapshot() {
  try {
    const period = currentQuarter();
    const { start: qStart, end: qEnd } = quarterRange(period);

    const tenants = await prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    });

    const weekStart = startOfWeek(new Date());
    const weekEnd = endOfWeek(new Date());

    let savedCount = 0;

    for (const tenant of tenants) {
      try {
        const deals = await prisma.deal.findMany({
          where: { tenantId: tenant.id },
          select: {
            id: true,
            amount: true,
            probability: true,
            stage: true,
            expectedClose: true,
            ownerId: true,
          },
        });

        // Group deals by ownerId
        const byOwner = new Map();
        for (const deal of deals) {
          const key = deal.ownerId == null ? "null" : String(deal.ownerId);
          if (!byOwner.has(key)) byOwner.set(key, []);
          byOwner.get(key).push(deal);
        }

        // Per-user forecasts
        for (const [ownerKey, ownerDeals] of byOwner.entries()) {
          if (ownerKey === "null") continue; // skip unowned for per-user
          const userId = parseInt(ownerKey);
          const metrics = computeForecast(ownerDeals, qStart, qEnd);
          await upsertWeeklyForecast({
            tenantId: tenant.id,
            userId,
            period,
            metrics,
            weekStart,
            weekEnd,
          });
          savedCount++;
        }

        // Tenant-level rollup (userId=null) over ALL deals
        const tenantMetrics = computeForecast(deals, qStart, qEnd);
        await upsertWeeklyForecast({
          tenantId: tenant.id,
          userId: null,
          period,
          metrics: tenantMetrics,
          weekStart,
          weekEnd,
        });
        savedCount++;
      } catch (err) {
        console.error(
          `[ForecastSnapshot] Failed for tenant ${tenant.id} (${tenant.name}):`,
          err.message
        );
      }
    }

    console.log(`[ForecastSnapshot] saved ${savedCount} tenant forecasts`);
    return savedCount;
  } catch (err) {
    console.error("[ForecastSnapshot] Engine error:", err.message);
    return 0;
  }
}

async function upsertWeeklyForecast({ tenantId, userId, period, metrics, weekStart, weekEnd }) {
  // Find existing forecast for this tenant/user/period created this week
  const existing = await prisma.forecast.findFirst({
    where: {
      tenantId,
      userId: userId == null ? null : userId,
      period,
      createdAt: { gte: weekStart, lt: weekEnd },
    },
  });

  if (existing) {
    await prisma.forecast.update({
      where: { id: existing.id },
      data: {
        expectedRevenue: metrics.expectedRevenue,
        committedRevenue: metrics.committedRevenue,
        bestCaseRevenue: metrics.bestCaseRevenue,
        closedRevenue: metrics.closedRevenue,
      },
    });
  } else {
    await prisma.forecast.create({
      data: {
        tenantId,
        userId: userId == null ? null : userId,
        period,
        expectedRevenue: metrics.expectedRevenue,
        committedRevenue: metrics.committedRevenue,
        bestCaseRevenue: metrics.bestCaseRevenue,
        closedRevenue: metrics.closedRevenue,
      },
    });
  }
}

// ── Cron init ───────────────────────────────────────────────────────

function initForecastSnapshotCron() {
  // Every Monday at 1 AM
  cron.schedule("0 1 * * 1", () => {
    runForecastSnapshot().catch((err) =>
      console.error("[ForecastSnapshot] Scheduled run failed:", err.message)
    );
  });
  console.log("[ForecastSnapshot] cron initialized");
}

module.exports = {
  initForecastSnapshotCron,
  runForecastSnapshot,
  currentQuarter,
  quarterRange,
};
