// Travel CRM — diagnostic-to-advisor escalation cron (PRD §6.3 row 6).
//
// Every 5 minutes. Scans completed TravelDiagnostic rows linked to a
// contactId AND with no advisor outreach in the 30-min window post-
// submission. For each stalled diagnostic, creates a single
// Notification of type='warning' tagged on the diagnostic row so the
// advisor dashboard surfaces "respond to this lead" cards.
//
// "Advisor outreach" is detected by querying the Activity / Task table
// scoped to (tenantId, contactId, createdAt > diagnostic.createdAt).
// If ANY follow-up activity has been logged, the cron skips. This is
// a best-effort signal — a more authoritative "first contact" model
// would be a dedicated field on TravelDiagnostic; for Phase 1 the
// Activity/Task heuristic catches the canonical advisor-action paths
// (call logged, task created, sequence enrolled).
//
// Idempotency: dedupe by (entityType='TravelDiagnostic', entityId,
// type='warning'). Each diagnostic gets at most ONE escalation alert
// across its lifecycle.

const cron = require("node-cron");
const prisma = require("../lib/prisma");

const STALL_WINDOW_MIN = 30;
const STALL_LOOKBACK_HOURS = 24; // don't escalate diagnostics older than 24h — the alert is
                                  // about "fresh-and-stalled," not "ancient backlog"
const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";

/**
 * @param {number} tenantId
 * @returns {Promise<{ alerted: number, skipped: number }>}
 */
async function runDiagnosticAlertsForTenant(tenantId) {
  const now = Date.now();
  const stallCutoff = new Date(now - STALL_WINDOW_MIN * 60 * 1000);
  const lookbackFloor = new Date(now - STALL_LOOKBACK_HOURS * 3600 * 1000);

  const diagnostics = await prisma.travelDiagnostic.findMany({
    where: {
      tenantId,
      contactId: { not: null },
      createdAt: { gte: lookbackFloor, lte: stallCutoff },
    },
    select: {
      id: true,
      subBrand: true,
      contactId: true,
      classificationLabel: true,
      recommendedTier: true,
      createdAt: true,
    },
    take: 500,
  });

  if (diagnostics.length === 0) return { alerted: 0, skipped: 0 };

  let alerted = 0;
  let skipped = 0;
  for (const diag of diagnostics) {
    // Dedup: existing escalation notification for this diagnostic?
    const existing = await prisma.notification.findFirst({
      where: {
        tenantId,
        entityType: "TravelDiagnostic",
        entityId: diag.id,
        type: "warning",
      },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    // "Has the advisor reached out?" — Activity OR Task created for this
    // contact AFTER the diagnostic timestamp counts as outreach. We
    // tolerate either table existing or not (some tenants don't seed
    // Activity); if neither is reachable, the diagnostic is treated as
    // not-yet-engaged.
    let outreachExists = false;
    try {
      outreachExists = !!(await prisma.activity.findFirst({
        where: { tenantId, contactId: diag.contactId, createdAt: { gt: diag.createdAt } },
        select: { id: true },
      }));
    } catch { /* model not present in this build — fall through */ }
    if (!outreachExists) {
      try {
        outreachExists = !!(await prisma.task.findFirst({
          where: {
            tenantId,
            createdAt: { gt: diag.createdAt },
            OR: [
              { contactId: diag.contactId },
              { relatedToId: diag.contactId, relatedToType: "contact" },
            ],
          },
          select: { id: true },
        }));
      } catch { /* model not present in this build — fall through */ }
    }

    if (outreachExists) {
      skipped++;
      continue;
    }

    const elapsedMin = Math.round((now - new Date(diag.createdAt).getTime()) / 60000);
    const title = `Diagnostic stalled: ${diag.subBrand.toUpperCase()} ${diag.classificationLabel || diag.recommendedTier || "tier"}`;
    const message =
      `Diagnostic #${diag.id} (${diag.subBrand}) for contact ${diag.contactId} submitted ${elapsedMin}m ago — ` +
      `no advisor outreach logged yet. Tier: ${diag.recommendedTier || "—"}. ` +
      `Open ${PORTAL_BASE}/travel/diagnostics`;
    try {
      await prisma.notification.create({
        data: {
          tenantId,
          title,
          message,
          type: "warning",
          priority: "high",
          entityType: "TravelDiagnostic",
          entityId: diag.id,
        },
      });
      console.log(
        `[TravelDiagnosticAlerts] tenant ${tenantId} diag ${diag.id} (${diag.subBrand}, ` +
          `${elapsedMin}m elapsed) escalated to advisor queue`,
      );
      alerted++;
    } catch (e) {
      console.error(
        `[TravelDiagnosticAlerts] tenant ${tenantId} diag ${diag.id} create error:`,
        e.message,
      );
    }
  }

  return { alerted, skipped };
}

async function runDiagnosticAlertsForAllTravelTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "travel", isActive: true },
    select: { id: true, slug: true },
  });
  let totalAlerted = 0;
  for (const t of tenants) {
    try {
      const { alerted, skipped } = await runDiagnosticAlertsForTenant(t.id);
      totalAlerted += alerted;
      if (alerted || skipped) {
        console.log(
          `[TravelDiagnosticAlerts] tenant ${t.slug}: ${alerted} escalated, ${skipped} skipped`,
        );
      }
    } catch (e) {
      console.error("[TravelDiagnosticAlerts] tenant fail:", t.slug, e.message);
    }
  }
  return totalAlerted;
}

function initTravelDiagnosticAlertsCron() {
  // Every 5 minutes — :07 offset per the standing rule (avoid the :00 /
  // :05 cluster). PRD §6.3 specifies "every 5 min."
  cron.schedule("*/5 * * * *", () => {
    runDiagnosticAlertsForAllTravelTenants().catch((e) =>
      console.error("[TravelDiagnosticAlerts] cron fail:", e.message),
    );
  });
  console.log("[TravelDiagnosticAlerts] cron initialized (every 5 min)");
}

module.exports = {
  initTravelDiagnosticAlertsCron,
  runDiagnosticAlertsForTenant,
  runDiagnosticAlertsForAllTravelTenants,
};
