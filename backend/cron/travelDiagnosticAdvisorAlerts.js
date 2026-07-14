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

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { resolveForSubBrand } = require("../lib/subBrandConfig");
// WhatsApp transport swap (Q9): Wati REST is COMMENTED OUT (kept on disk, not removed);
// travel now dispatches over WhatsApp Web (QR-scan) via a drop-in client.
// const watiClient = require("../services/watiClient"); // legacy Wati REST (disabled)
const watiClient = require("../services/whatsappWebClient");

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

  // One tenant row read per pass for the Q9 cut-over plumbing — the
  // wabaId is logged at escalation time so operators can see which
  // WABA the advisor outreach WOULD route through once Wati creds land.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subBrandConfigJson: true },
  });

  // Notification.userId is non-nullable. Find ONE recipient per tenant to
  // address the alert at — prefer ADMIN, fall back to MANAGER, then any
  // user. If the tenant has zero users (shouldn't happen post-seed) we
  // can't create the notification and skip.
  const recipient =
    (await prisma.user.findFirst({
      where: { tenantId, role: "ADMIN" },
      select: { id: true },
      orderBy: { id: "asc" },
    })) ||
    (await prisma.user.findFirst({
      where: { tenantId, role: "MANAGER" },
      select: { id: true },
      orderBy: { id: "asc" },
    })) ||
    (await prisma.user.findFirst({
      where: { tenantId },
      select: { id: true },
      orderBy: { id: "asc" },
    }));

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
        // Schema fields available on Task: contactId only (no relatedTo*
        // polymorphic columns in this codebase — a follow-up could add them
        // but for now the contactId direct FK is the canonical link).
        outreachExists = !!(await prisma.task.findFirst({
          where: {
            tenantId,
            contactId: diag.contactId,
            createdAt: { gt: diag.createdAt },
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
    if (!recipient) {
      // No user to address this alert to — log + skip. Re-tick will retry
      // once a user is seeded for the tenant.
      console.warn(
        `[TravelDiagnosticAlerts] tenant ${tenantId} has no users — cannot create escalation notification`,
      );
      skipped++;
      continue;
    }
    try {
      await prisma.notification.create({
        data: {
          tenantId,
          userId: recipient.id,
          title,
          message,
          type: "warning",
          priority: "high",
          entityType: "TravelDiagnostic",
          entityId: diag.id,
        },
      });
      const cfg = resolveForSubBrand(tenant, diag.subBrand);
      console.log(
        `[TravelDiagnosticAlerts] tenant ${tenantId} diag ${diag.id} (${diag.subBrand}, ` +
          `${elapsedMin}m elapsed) escalated to advisor queue — would-route ` +
          `wabaId=${cfg.wabaId || "(no-config)"}`,
      );
      // Operator-facing WhatsApp alert via watiClient (Q9). The User model
      // carries no phone column, so the ops-shared recipient comes from
      // WATI_OPS_ALERT_PHONE (the ops desk's WhatsApp number); unset = the
      // in-app notification above remains the only alert surface.
      const opsPhone = process.env.WATI_OPS_ALERT_PHONE;
      if (opsPhone) {
        await watiClient.sendBestEffort({
          tenantId,
          subBrand: diag.subBrand,
          toPhone: opsPhone,
          fallbackText: `⚠ ${title} — ${message}`,
          broadcastName: "travel-diagnostic-advisor-alerts",
        });
      }
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
  // Every 5 minutes. PRD §6.3 specifies "every 5 min."
  cronRegistry.register({
    name: "travelDiagnosticAdvisorAlerts",
    description: "Flags stalled (>30 min, no advisor outreach) travel diagnostics (every 5 min)",
    defaultSchedule: "*/5 * * * *",
    tickFn: runDiagnosticAlertsForAllTravelTenants,
  }).catch((e) => console.error("[TravelDiagnosticAlerts] cronRegistry registration failed:", e.message));
}

module.exports = {
  initTravelDiagnosticAlertsCron,
  runDiagnosticAlertsForTenant,
  runDiagnosticAlertsForAllTravelTenants,
};
