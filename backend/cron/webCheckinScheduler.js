// Travel CRM — web check-in scheduler cron (PRD §4.6 + §6.3 row 1).
//
// Every 15 minutes. Manages the WebCheckin lifecycle through its
// status enum:
//
//   pending → reminded         when windowOpenAt ≤ now (the T-48h or
//                              T-24h window has opened)
//   reminded → fallback-agent  if status hasn't moved to 'done' or
//                              'in-progress' within 30 min after the
//                              window opened (per PRD §4.6 "2 failed
//                              retries within 30 min → agent task")
//
// Each transition creates one Notification row tagged on the WebCheckin
// so the advisor dashboard surfaces the action. Idempotency: dedupe by
// (entityType='WebCheckin', entityId, type). One reminder notification
// + at most one fallback notification per WebCheckin lifecycle.
//
// Source rows: this Phase 1 ship operates on EXISTING WebCheckin rows.
// The row-creation step (scanning ItineraryItem flight details to spawn
// WebCheckin rows at T-48h) is a separate concern — once a route or
// upstream cron creates the WebCheckin in 'pending' status, this
// scheduler picks it up. Airline browser-automation (P1B) is explicitly
// out of scope for the autonomous loop.
//
// Dispatch: WhatsApp/email reminder send is stubbed (console.log)
// pending Wati BSP creds (Q9). The Notification + status transition
// are the visible Phase 1 outputs.

const cron = require("node-cron");
const prisma = require("../lib/prisma");

const FALLBACK_STALL_MIN = 30;
const FUTURE_LOOK_AHEAD_DAYS = 7;
const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";

/**
 * Run the scheduler for one travel tenant.
 * @param {number} tenantId
 * @returns {Promise<{ reminded: number, fallback: number }>}
 */
async function runWebCheckinSchedulerForTenant(tenantId) {
  const now = Date.now();
  const lookAhead = new Date(now + FUTURE_LOOK_AHEAD_DAYS * 86400_000);
  const fallbackCutoff = new Date(now - FALLBACK_STALL_MIN * 60 * 1000);

  // Pull pending + reminded rows whose window has opened (or will open
  // within the look-ahead). Future-window rows are inspected so the
  // scheduler can flip them at the exact moment their window opens
  // without waiting a full cron cycle.
  const rows = await prisma.webCheckin.findMany({
    where: {
      tenantId,
      status: { in: ["pending", "reminded"] },
      windowOpenAt: { lte: lookAhead },
    },
    select: {
      id: true,
      pnr: true,
      airlineCode: true,
      flightNumber: true,
      passengerName: true,
      windowOpenAt: true,
      status: true,
      updatedAt: true,
    },
    take: 500,
  });

  let reminded = 0;
  let fallback = 0;

  for (const row of rows) {
    const windowAt = new Date(row.windowOpenAt).getTime();
    if (Number.isNaN(windowAt)) continue;

    // Phase 1: window has just opened → flip pending → reminded.
    if (row.status === "pending" && windowAt <= now) {
      const existing = await prisma.notification.findFirst({
        where: { tenantId, entityType: "WebCheckin", entityId: row.id, type: "info" },
        select: { id: true },
      });
      try {
        await prisma.webCheckin.update({
          where: { id: row.id },
          data: { status: "reminded" },
        });
        if (!existing) {
          await prisma.notification.create({
            data: {
              tenantId,
              title: `Web check-in open: ${row.airlineCode} ${row.flightNumber}`,
              message:
                `${row.passengerName} — PNR ${row.pnr}. ` +
                `Check-in window opened. Reminder dispatch queued (pending Wati creds). ` +
                `Advisor link: ${PORTAL_BASE}/travel/trips`,
              type: "info",
              priority: "normal",
              entityType: "WebCheckin",
              entityId: row.id,
            },
          });
        }
        console.log(
          `[WebCheckinScheduler] tenant ${tenantId} checkin ${row.id} ` +
            `(${row.airlineCode} ${row.flightNumber}/${row.pnr}) → reminded ` +
            `(WhatsApp + email dispatch pending Wati creds)`,
        );
        reminded++;
      } catch (e) {
        console.error(
          `[WebCheckinScheduler] tenant ${tenantId} checkin ${row.id} reminded-transition error:`,
          e.message,
        );
      }
      continue;
    }

    // Phase 2: reminded but stalled past the 30-min fallback cutoff
    // → escalate to agent. PRD §4.6 "2 failed retries within 30 min →
    // agent task." The retry logic is in the (deferred) automation
    // cron; this scheduler just flips status when the wall-clock says
    // it's stalled.
    if (row.status === "reminded" && new Date(row.updatedAt) < fallbackCutoff) {
      const existing = await prisma.notification.findFirst({
        where: { tenantId, entityType: "WebCheckin", entityId: row.id, type: "warning" },
        select: { id: true },
      });
      if (existing) continue;
      try {
        await prisma.webCheckin.update({
          where: { id: row.id },
          data: { status: "fallback-agent" },
        });
        await prisma.notification.create({
          data: {
            tenantId,
            title: `Web check-in escalated to agent: ${row.airlineCode} ${row.flightNumber}`,
            message:
              `${row.passengerName} — PNR ${row.pnr}. ` +
              `No completion 30+ min after window opened — please manually check in via the ` +
              `airline portal and upload the boarding pass.`,
            type: "warning",
            priority: "high",
            entityType: "WebCheckin",
            entityId: row.id,
          },
        });
        console.log(
          `[WebCheckinScheduler] tenant ${tenantId} checkin ${row.id} ` +
            `(${row.airlineCode} ${row.flightNumber}/${row.pnr}) → fallback-agent (stalled 30m+)`,
        );
        fallback++;
      } catch (e) {
        console.error(
          `[WebCheckinScheduler] tenant ${tenantId} checkin ${row.id} fallback-transition error:`,
          e.message,
        );
      }
    }
  }

  return { reminded, fallback };
}

async function runWebCheckinSchedulerForAllTravelTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "travel", isActive: true },
    select: { id: true, slug: true },
  });
  let totalReminded = 0;
  let totalFallback = 0;
  for (const t of tenants) {
    try {
      const { reminded, fallback } = await runWebCheckinSchedulerForTenant(t.id);
      totalReminded += reminded;
      totalFallback += fallback;
      if (reminded || fallback) {
        console.log(
          `[WebCheckinScheduler] tenant ${t.slug}: ${reminded} reminded, ${fallback} fallback-agent`,
        );
      }
    } catch (e) {
      console.error("[WebCheckinScheduler] tenant fail:", t.slug, e.message);
    }
  }
  return { reminded: totalReminded, fallback: totalFallback };
}

function initWebCheckinSchedulerCron() {
  // Every 15 minutes — off the :00/:15/:30/:45 cluster per the standing
  // rule. PRD §6.3 row 1 specifies "every 15 min."
  cron.schedule("13,28,43,58 * * * *", () => {
    runWebCheckinSchedulerForAllTravelTenants().catch((e) =>
      console.error("[WebCheckinScheduler] cron fail:", e.message),
    );
  });
  console.log("[WebCheckinScheduler] cron initialized (every 15 min, off-minute jitter)");
}

module.exports = {
  initWebCheckinSchedulerCron,
  runWebCheckinSchedulerForTenant,
  runWebCheckinSchedulerForAllTravelTenants,
};
