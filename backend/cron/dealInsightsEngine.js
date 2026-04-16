const cron = require("node-cron");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), override: true });

const prisma = require("../lib/prisma");
const { runHeuristicRules, persistInsights } = require("../routes/deal_insights");

/**
 * Single tick — scan every tenant's open deals, run the heuristic rule engine,
 * dedupe against existing unresolved insights, and persist new ones.
 */
async function tickDealInsightsEngine(io) {
  const startedAt = Date.now();
  let totalDealsScanned = 0;
  let totalInsightsCreated = 0;

  try {
    // Distinct tenants currently owning deals
    const tenantRows = await prisma.deal.findMany({
      where: {
        stage: { notIn: ["won", "lost"] },
      },
      distinct: ["tenantId"],
      select: { tenantId: true },
    });

    for (const { tenantId } of tenantRows) {
      try {
        const openDeals = await prisma.deal.findMany({
          where: {
            tenantId,
            stage: { notIn: ["won", "lost"] },
          },
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

        for (const deal of openDeals) {
          totalDealsScanned++;
          try {
            const candidates = await runHeuristicRules(deal);
            // persistInsights already dedupes by (dealId, type, insight) when unresolved
            const saved = await persistInsights(deal.id, tenantId, candidates);
            totalInsightsCreated += saved.length;
          } catch (dealErr) {
            console.warn(`[DealInsightsEngine] Deal ${deal.id} failed:`, dealErr.message);
          }
        }
      } catch (tenantErr) {
        console.warn(`[DealInsightsEngine] Tenant ${tenantId} failed:`, tenantErr.message);
      }
    }

    const ms = Date.now() - startedAt;
    console.log(
      `[DealInsightsEngine] Scanned ${totalDealsScanned} open deal(s) across ${tenantRows.length} tenant(s); created ${totalInsightsCreated} new insight(s) in ${ms}ms.`
    );

    if (io) {
      io.emit("deal_insights_updated", {
        scanned: totalDealsScanned,
        created: totalInsightsCreated,
        ts: new Date(),
      });
    }

    return { scanned: totalDealsScanned, created: totalInsightsCreated };
  } catch (err) {
    console.error("[DealInsightsEngine] Tick failed:", err);
    return { scanned: totalDealsScanned, created: totalInsightsCreated, error: err.message };
  }
}

/**
 * Initialise the cron job (every 6 hours).
 * Wire this from server.js — orchestrator passes the socket.io instance.
 */
function initDealInsightsCron(io) {
  cron.schedule("0 */6 * * *", () => {
    console.log("[DealInsightsEngine] Cron tick — scanning open deals...");
    tickDealInsightsEngine(io).catch(err => console.error("[DealInsightsEngine] Cron error:", err));
  });
  console.log("[DealInsightsEngine] Cron initialized (every 6 hours).");
}

module.exports = { initDealInsightsCron, tickDealInsightsEngine };
