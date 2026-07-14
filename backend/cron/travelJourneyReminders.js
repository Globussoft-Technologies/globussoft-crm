// Travel CRM — RFU Umrah journey reminders cron (PRD §4.8 + §6.3).
//
// Every 30 minutes. Fires fixed-point journey-milestone reminders for
// RFU itineraries that have been accepted, the customer has booked, and
// the trip date is approaching. Milestones (relative to itinerary
// startDate):
//
//   T-7d   "Final document checklist" reminder
//   T-3d   "Driver + hotel confirmations" reminder
//   T-1d   "Group meeting point + departure pack" reminder
//   T-0    "Have a blessed Umrah!" send-off
//   T+2d   "Hope you've arrived safely; what to expect for ziyarah" follow-up
//   T+7d   "Returning soon — what to bring home + airport reminders"
//
// Phase 1: creates one Notification per (itineraryId, milestone)
// tuple. Idempotency: (entityType='Itinerary', entityId, title contains
// milestone tag). Each milestone fires AT MOST ONCE per itinerary.
//
// Dispatch deferred: WhatsApp/email send waits on Wati BSP creds (Q9).
// The Notification row is the visible Phase 1 output; advisor dashboard
// picks them up. The cron logs the WhatsApp dispatch line so the
// observability is in place for when creds arrive.
//
// The reminder CONTENT is intentionally generic — Yasin's brand-specific
// copy lands per Q22 (brand assets) + the religious-guidance content
// library. This cron triggers the EVENT; the actual message body comes
// from per-tenant templates in a follow-up commit.

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { resolveForSubBrand } = require("../lib/subBrandConfig");
// WhatsApp transport swap (Q9): Wati REST is COMMENTED OUT (kept on disk, not removed);
// travel now dispatches over WhatsApp Web (QR-scan) via a drop-in client.
// const watiClient = require("../services/watiClient"); // legacy Wati REST (disabled)
const watiClient = require("../services/whatsappWebClient");

const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";

// Milestone definitions — each entry is { tag, offsetMs, title, body }.
// offsetMs is the (startDate - milestoneDate) delta; negative = post-departure.
// Reminders fire when |now - (startDate + offsetMs)| < windowMs.
const MILESTONES = [
  { tag: "doc-checklist-t7", offsetMs:  -7 * 86400_000, title: "Umrah document checklist", body: "Final document checklist — please verify passport / visa / vaccination before T-7." },
  { tag: "driver-hotel-t3",  offsetMs:  -3 * 86400_000, title: "Driver + hotel confirmation", body: "Your driver pickup time + hotel check-in details are confirmed; please review the itinerary." },
  { tag: "group-meeting-t1", offsetMs:  -1 * 86400_000, title: "Group meeting point + departure pack", body: "Tomorrow's group meeting point + departure pack details — please share with all travellers." },
  { tag: "sendoff-t0",       offsetMs:        0,         title: "Have a blessed Umrah",        body: "Wishing you a blessed and safe Umrah. We're with you throughout the journey." },
  { tag: "ziyarah-t2",       offsetMs:   2 * 86400_000, title: "Ziyarah guidance",             body: "Hope you've arrived safely. Here's what to expect for ziyarah and the upcoming itinerary." },
  { tag: "return-t7",        offsetMs:   7 * 86400_000, title: "Return prep",                  body: "Trip wrapping up — airport return reminders + souvenirs guide attached." },
];
// 30-minute window matches the cron cadence; each milestone has one
// chance to fire per :13 tick the cron runs. Slightly wider than the
// cadence so a slow tick doesn't miss the moment.
const FIRE_WINDOW_MS = 35 * 60 * 1000;

function relevantMilestones(startDate) {
  if (!startDate) return [];
  const start = new Date(startDate).getTime();
  if (!Number.isFinite(start)) return [];
  const now = Date.now();
  const out = [];
  for (const m of MILESTONES) {
    const fireAt = start + m.offsetMs;
    if (Math.abs(now - fireAt) <= FIRE_WINDOW_MS) {
      out.push(m);
    }
  }
  return out;
}

/**
 * @param {number} tenantId
 * @returns {Promise<{ fired: number, skipped: number }>}
 */
async function runJourneyRemindersForTenant(tenantId) {
  // Only RFU accepted itineraries fire journey reminders — the milestone
  // schedule is Umrah-specific. Travel Stall family-holiday journey
  // milestones are Phase 2.
  const itineraries = await prisma.itinerary.findMany({
    where: {
      tenantId,
      subBrand: "rfu",
      status: "accepted",
      // Bound the scan to itineraries with a startDate within the
      // milestone envelope: [now - 14d, now + 14d].
      startDate: {
        gte: new Date(Date.now() - 14 * 86400_000),
        lte: new Date(Date.now() + 14 * 86400_000),
      },
    },
    select: { id: true, contactId: true, destination: true, startDate: true },
    take: 500,
  });

  // One tenant row read per pass for the Q9 cut-over plumbing — the
  // wabaId is logged at milestone-fire time so operators can see which
  // WABA the reminder WOULD route through once Wati creds land.
  // Itineraries here are all subBrand=rfu (the where-clause above).
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subBrandConfigJson: true },
  });
  const rfuCfg = resolveForSubBrand(tenant, "rfu");

  // Batch-fetch contact phones for the WhatsApp dispatch leg (Q9).
  // Best-effort: a lookup failure only skips the WA leg — the milestone
  // notification loop below keeps running regardless.
  let contactById = {};
  try {
    const contactIds = [...new Set(itineraries.map((i) => i.contactId).filter(Boolean))];
    const contacts = contactIds.length
      ? await prisma.contact.findMany({
          where: { id: { in: contactIds } },
          select: { id: true, phone: true, name: true },
        })
      : [];
    contactById = Object.fromEntries(contacts.map((c) => [c.id, c]));
  } catch (e) {
    console.error(`[TravelJourneyReminders] contact phone lookup failed (WA leg skipped): ${e.message}`);
  }

  let fired = 0;
  let skipped = 0;

  for (const itin of itineraries) {
    const milestones = relevantMilestones(itin.startDate);
    if (milestones.length === 0) continue;

    for (const m of milestones) {
      // Dedup tag stored as a marker in the title so re-runs in the same
      // 35-min window don't duplicate. Tag is a structured suffix the
      // advisor UI strips for display.
      const titleWithTag = `${m.title} [${m.tag}]`;
      const existing = await prisma.notification.findFirst({
        where: {
          tenantId,
          entityType: "Itinerary",
          entityId: itin.id,
          title: titleWithTag,
        },
        select: { id: true },
      });
      if (existing) {
        skipped++;
        continue;
      }
      try {
        await prisma.notification.create({
          data: {
            tenantId,
            title: titleWithTag,
            message: `${m.body} (Itinerary ${itin.id} · ${itin.destination}). Advisor link: ${PORTAL_BASE}/travel/itineraries`,
            type: "info",
            priority: "normal",
            entityType: "Itinerary",
            entityId: itin.id,
          },
        });
        console.log(
          `[TravelJourneyReminders] tenant ${tenantId} itin ${itin.id} milestone ${m.tag} fired ` +
            `(WhatsApp dispatch via watiClient — subBrand=rfu ` +
            `wabaId=${rfuCfg.wabaId || "(no-config)"})`,
        );
        // WhatsApp dispatch via watiClient (Q9) — stub when creds absent;
        // best-effort, never blocks the milestone loop.
        const contact = itin.contactId ? contactById[itin.contactId] : null;
        if (contact && contact.phone) {
          await watiClient.sendBestEffort({
            tenantId,
            subBrand: "rfu",
            toPhone: contact.phone,
            contactId: contact.id,
            templateName: process.env.WATI_JOURNEY_REMINDER_TEMPLATE || "journey_reminder",
            parameters: [
              { name: "name", value: contact.name || "Pilgrim" },
              { name: "destination", value: itin.destination || "" },
            ],
            broadcastName: "travel-journey-reminders",
            fallbackText: `${m.body} (${itin.destination})`,
          });
        }
        fired++;
      } catch (e) {
        console.error(
          `[TravelJourneyReminders] tenant ${tenantId} itin ${itin.id} milestone ${m.tag} error:`,
          e.message,
        );
      }
    }
  }

  return { fired, skipped };
}

async function runJourneyRemindersForAllTravelTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "travel", isActive: true },
    select: { id: true, slug: true },
  });
  let totalFired = 0;
  for (const t of tenants) {
    try {
      const { fired, skipped } = await runJourneyRemindersForTenant(t.id);
      totalFired += fired;
      if (fired || skipped) {
        console.log(
          `[TravelJourneyReminders] tenant ${t.slug}: ${fired} milestone notifications fired, ${skipped} already-sent skipped`,
        );
      }
    } catch (e) {
      console.error("[TravelJourneyReminders] tenant fail:", t.slug, e.message);
    }
  }
  return totalFired;
}

function initTravelJourneyRemindersCron() {
  // Every 30 minutes. PRD §6.3 specifies "every 30 min."
  cronRegistry.register({
    name: "travelJourneyReminders",
    description: "RFU journey milestone reminders (T-7d/T-3d/T-1d/T-0/T+2d/T+7d), every 30 min",
    defaultSchedule: "13,43 * * * *",
    tickFn: runJourneyRemindersForAllTravelTenants,
  }).catch((e) => console.error("[TravelJourneyReminders] cronRegistry registration failed:", e.message));
}

module.exports = {
  initTravelJourneyRemindersCron,
  runJourneyRemindersForTenant,
  runJourneyRemindersForAllTravelTenants,
  // Exported for unit-test introspection only.
  MILESTONES,
  relevantMilestones,
};
