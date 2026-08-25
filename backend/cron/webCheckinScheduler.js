// Travel CRM — web check-in scheduler cron (PRD §4.6 + §6.3 row 1).
//
// Every 15 minutes. The WebCheckin status model is intentionally binary:
//   pending  → not yet checked in / boarding pass not uploaded
//   done     → boarding pass uploaded or customer confirmed
//
// The cron has ONE job: notify the responsible operator(s) when a pending
// check-in's departureAt is within the next 24 hours. The notification is
// deduped per user per WebCheckin row for 24h so the 15-minute tick does not
// spam.
//
// Notification targets:
//   - If WebCheckin.assignedAgentId is set → that user only.
//   - Otherwise → every ADMIN and MANAGER in the tenant.
//
// No status transitions, no automation, no fallback-agent flow — check-ins
// are handled manually via the Web Check-ins queue.

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { notify } = require("../lib/notificationService");

const T24H_MS = 24 * 60 * 60 * 1000;
const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";

/**
 * Run the scheduler for one travel tenant.
 * @param {number} tenantId
 * @returns {Promise<{ notifiedUsers: number }>}
 */
async function runWebCheckinSchedulerForTenant(tenantId) {
  const now = new Date();
  const horizon = new Date(now.getTime() + T24H_MS);

  const rows = await prisma.webCheckin.findMany({
    where: {
      tenantId,
      status: "pending",
      departureAt: { gte: now, lte: horizon },
    },
    select: {
      id: true,
      pnr: true,
      airlineCode: true,
      flightNumber: true,
      passengerName: true,
      departureAt: true,
      assignedAgentId: true,
      itineraryId: true,
    },
    take: 500,
  });

  if (rows.length === 0) {
    return { notifiedUsers: 0 };
  }

  let notifiedUsers = 0;

  const itineraryIds = [...new Set(rows.map((row) => row.itineraryId).filter(Boolean))];
  const itineraries = itineraryIds.length
    ? await prisma.itinerary.findMany({
        where: { id: { in: itineraryIds } },
        select: { id: true, subBrand: true },
      })
    : [];
  const itineraryById = Object.fromEntries(itineraries.map((itinerary) => [itinerary.id, itinerary]));

  for (const row of rows) {
    // TMC does not use Web Check-in. Existing rows remain untouched, but
    // reminder notifications are commented out for this sub-brand.
    if (itineraryById[row.itineraryId]?.subBrand === "tmc") continue;
    const userIds = await resolveNotifyUserIds(tenantId, row.assignedAgentId);
    if (userIds.length === 0) continue;

    const title = `Web check-in pending: ${row.airlineCode} ${row.flightNumber}`;
    const message =
      `${row.passengerName} — PNR ${row.pnr}. ` +
      `Flight departs ${new Date(row.departureAt).toLocaleString()} and check-in is still pending.`;

    for (const userId of userIds) {
      try {
        const n = await notify({
          userId,
          tenantId,
          title,
          message,
          type: "warning",
          priority: "high",
          entityType: "WebCheckin",
          entityId: row.id,
          link: `${PORTAL_BASE}/travel/web-checkins`,
          dedupWindowHours: 24,
        });
        if (n) notifiedUsers += 1;
      } catch (e) {
        console.error(
          `[WebCheckinScheduler] tenant ${tenantId} checkin ${row.id} notify fail for user ${userId}:`,
          e.message,
        );
      }
    }
  }

  return { notifiedUsers };
}

async function resolveNotifyUserIds(tenantId, assignedAgentId) {
  if (assignedAgentId) {
    const user = await prisma.user.findUnique({
      where: { id: assignedAgentId },
      select: { id: true, tenantId: true },
    });
    // Only notify the assigned agent if they still belong to this tenant.
    return user && user.tenantId === tenantId ? [user.id] : [];
  }

  const managers = await prisma.user.findMany({
    where: {
      tenantId,
      role: { in: ["ADMIN", "MANAGER"] },
    },
    select: { id: true },
  });
  return managers.map((u) => u.id);
}

async function runWebCheckinSchedulerForAllTravelTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "travel", isActive: true },
    select: { id: true, slug: true },
  });
  let totalNotified = 0;
  for (const t of tenants) {
    try {
      const { notifiedUsers } = await runWebCheckinSchedulerForTenant(t.id);
      totalNotified += notifiedUsers;
      if (notifiedUsers) {
        console.log(
          `[WebCheckinScheduler] tenant ${t.slug}: ${notifiedUsers} user notification(s)`,
        );
      }
    } catch (e) {
      console.error("[WebCheckinScheduler] tenant fail:", t.slug, e.message);
    }
  }
  return { notifiedUsers: totalNotified };
}

function initWebCheckinSchedulerCron() {
  // Every 15 minutes. PRD §6.3 row 1 specifies "every 15 min."
  cronRegistry.register({
    name: "webCheckinScheduler",
    description: "Notifies operators of pending web check-ins departing within 24h (every 15 min)",
    defaultSchedule: "13,28,43,58 * * * *",
    tickFn: runWebCheckinSchedulerForAllTravelTenants,
  }).catch((e) => console.error("[WebCheckinScheduler] cronRegistry registration failed:", e.message));
}

module.exports = {
  initWebCheckinSchedulerCron,
  runWebCheckinSchedulerForTenant,
  runWebCheckinSchedulerForAllTravelTenants,
};
