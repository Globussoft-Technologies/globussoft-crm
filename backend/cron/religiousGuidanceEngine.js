// Travel CRM — Religious-guidance content delivery cron (RFU).
// PRD §4.8 + §4.10 RFU sub-brand.
//
// Daily 09:13 IST. For each travel-vertical tenant, scans upcoming
// RFU itineraries with startDate set and status in {sent, accepted,
// advance_paid, fully_paid}; computes daysToDeparture; for each
// active ReligiousGuidancePacket whose dayOffset equals the
// itinerary's daysToDeparture, creates one Notification per
// (packet, itinerary, year) dedup window.
//
// Year-tagged dedup key: title contains
//   [religious-guidance-{packetId}-itin-{itineraryId}]
// preventing double-fire across retries within the same year. Future
// re-runs ARE allowed once the itinerary departs + a new trip with
// the same itineraryId would never occur (autoincrement) so the
// per-year tag is belt-and-braces.
//
// Channels:
//   - wa    → console.log [wati-stub] line (Q9 cred-blocked, mirrors
//             contactGreetingsEngine + travelJourneyReminders)
//   - email → log only ("[religious-guidance] email channel — TODO
//             wire scheduledEmail")
//   - sms   → log only ("[religious-guidance] sms channel — TODO")
//
// Scoped to vertical=travel tenants per PRD; other verticals can
// adopt the engine by widening the tenant query in a follow-up.

const cron = require("node-cron");
const prisma = require("../lib/prisma");
const { resolveForSubBrand } = require("../lib/subBrandConfig");
// WhatsApp transport swap (Q9): Wati REST is COMMENTED OUT (kept on disk, not removed);
// travel now dispatches over WhatsApp Web (QR-scan) via a drop-in client.
// const watiClient = require("../services/watiClient"); // legacy Wati REST (disabled)
const watiClient = require("../services/whatsappWebClient");

const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";

const ELIGIBLE_STATUSES = ["sent", "accepted", "advance_paid", "fully_paid"];
const MAX_LOOKAHEAD_DAYS = 14;
const ONE_DAY_MS = 86_400_000;

/**
 * Compute integer days from now until `startDate`. Floor so the
 * "day of" boundary is inclusive (a flight tomorrow morning at 06:00
 * still reads as daysToDeparture=1, not 0, while now() is yesterday).
 *
 * Returns null on invalid / missing input so the caller can skip.
 *
 * @param {Date|string|null} startDate
 * @param {Date} [now=new Date()]
 * @returns {number|null}
 */
function daysToDeparture(startDate, now = new Date()) {
  if (!startDate) return null;
  const d = new Date(startDate);
  if (!Number.isFinite(d.getTime())) return null;
  return Math.floor((d.getTime() - now.getTime()) / ONE_DAY_MS);
}

/**
 * Run the religious-guidance sweep for one travel tenant.
 * @param {number} tenantId
 * @returns {Promise<{ fired: number, skipped: number }>}
 */
async function runReligiousGuidanceForTenant(tenantId) {
  // Fetch active RFU packets for this tenant. Single query — list is
  // small (Phase 1 ships 3 placeholder packets per tenant).
  const packets = await prisma.religiousGuidancePacket.findMany({
    where: { tenantId, subBrand: "rfu", isActive: true },
    select: { id: true, dayOffset: true, title: true, contentHtml: true, channels: true },
  });
  if (packets.length === 0) return { fired: 0, skipped: 0 };

  // One tenant row read per pass for the Q9 cut-over plumbing — the
  // wabaId is logged at dispatch-stub time so operators can see which
  // WABA the message WOULD route through once Wati creds land.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subBrandConfigJson: true },
  });
  const rfuCfg = resolveForSubBrand(tenant, "rfu");

  // Fetch eligible RFU itineraries with startDate set.
  const itineraries = await prisma.itinerary.findMany({
    where: {
      tenantId,
      subBrand: "rfu",
      status: { in: ELIGIBLE_STATUSES },
      startDate: { not: null },
    },
    select: {
      id: true,
      contactId: true,
      destination: true,
      startDate: true,
    },
    take: 2000,
  });
  if (itineraries.length === 0) return { fired: 0, skipped: 0 };

  const currentYear = new Date().getFullYear();
  let fired = 0;
  let skipped = 0;

  for (const itin of itineraries) {
    const dtd = daysToDeparture(itin.startDate);
    // Skip if already departed (negative) or too far out (>14d).
    if (dtd === null) continue;
    if (dtd < 0 || dtd > MAX_LOOKAHEAD_DAYS) continue;

    for (const packet of packets) {
      if (packet.dayOffset !== dtd) continue;

      const tag = `[religious-guidance-${packet.id}-itin-${itin.id}-${currentYear}]`;
      const existing = await prisma.notification.findFirst({
        where: {
          tenantId,
          entityType: "Itinerary",
          entityId: itin.id,
          title: { contains: tag },
        },
        select: { id: true },
      });
      if (existing) {
        skipped++;
        continue;
      }

      try {
        // Strip HTML to a plain-text snippet for the Notification.message
        // body. Notification renders message as plain text; the
        // contentHtml lives on the packet for real-channel dispatch.
        const snippet = (packet.contentHtml || "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 280);

        await prisma.notification.create({
          data: {
            tenantId,
            title: `🕋 ${packet.title} ${tag}`,
            message:
              `${snippet} ` +
              `(Itinerary ${itin.id} · ${itin.destination} · T-${dtd}d). ` +
              `Advisor link: ${PORTAL_BASE}/travel/itineraries`,
            type: "info",
            priority: "normal",
            entityType: "Itinerary",
            entityId: itin.id,
          },
        });

        // Per-channel dispatch — Phase 1 stays stub-mode across the
        // board. Wati WA cred lands via Q9; email + sms wire-in to the
        // scheduledEmail engine is a follow-up commit.
        const channels = String(packet.channels || "")
          .split(",")
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean);
        for (const ch of channels) {
          if (ch === "wa") {
            console.log(
              `[wati] religious-guidance packet ${packet.id} ` +
                `to itin ${itin.id} contact ${itin.contactId} (T-${dtd}d, ${packet.title}) ` +
                `— dispatch via watiClient — subBrand=rfu ` +
                `wabaId=${rfuCfg.wabaId || "(no-config)"}`,
            );
            // WhatsApp dispatch via watiClient (Q9) — stub when creds absent.
            // Own try/catch: a contact-lookup or send failure must not eat
            // the fired++ below (the notification row already landed).
            // Per-fired-packet contact lookup: fired volume is small (T-day
            // exact matches only), so no batching needed here.
            try {
              if (itin.contactId) {
                const contact = await prisma.contact.findFirst({
                  where: { id: itin.contactId, tenantId },
                  select: { id: true, phone: true, name: true },
                });
                if (contact && contact.phone) {
                  await watiClient.sendBestEffort({
                    tenantId,
                    subBrand: "rfu",
                    toPhone: contact.phone,
                    contactId: contact.id,
                    fallbackText: `${packet.title} (T-${dtd} days): ${snippet}`,
                    broadcastName: "travel-religious-guidance",
                  });
                }
              }
            } catch (waErr) {
              console.error(`[ReligiousGuidance] WA dispatch failed (notification still fired): ${waErr.message}`);
            }
          } else if (ch === "email") {
            console.log(
              `[religious-guidance] email channel — TODO wire scheduledEmail ` +
                `(packet ${packet.id} → itin ${itin.id} contact ${itin.contactId})`,
            );
          } else if (ch === "sms") {
            console.log(
              `[religious-guidance] sms channel — TODO ` +
                `(packet ${packet.id} → itin ${itin.id} contact ${itin.contactId})`,
            );
          }
        }

        fired++;
      } catch (e) {
        // Race-tolerance: continue with the next itinerary/packet on
        // create failure (e.g. concurrent run, FK violation if
        // itinerary deleted between fetch + create).
        console.error(
          `[ReligiousGuidance] tenant ${tenantId} packet ${packet.id} itin ${itin.id} error:`,
          e.message,
        );
      }
    }
  }

  return { fired, skipped };
}

async function runReligiousGuidanceForAllTravelTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "travel", isActive: true },
    select: { id: true, slug: true },
  });
  let totalFired = 0;
  let totalSkipped = 0;
  for (const t of tenants) {
    try {
      const { fired, skipped } = await runReligiousGuidanceForTenant(t.id);
      totalFired += fired;
      totalSkipped += skipped;
      if (fired || skipped) {
        console.log(
          `[ReligiousGuidance] tenant ${t.slug}: ${fired} fired, ${skipped} skipped (already-sent)`,
        );
      }
    } catch (e) {
      console.error("[ReligiousGuidance] tenant fail:", t.slug, e.message);
    }
  }
  return { fired: totalFired, skipped: totalSkipped };
}

function initReligiousGuidanceCron() {
  // Daily 09:13 IST — :13 minute offset per the standing rule (avoid
  // :00 / :30 cluster). One daily fire scans the whole tenant's
  // upcoming-14d RFU window.
  cron.schedule("13 9 * * *", () => {
    runReligiousGuidanceForAllTravelTenants().catch((e) =>
      console.error("[ReligiousGuidance] cron fail:", e.message),
    );
  });
  console.log("[ReligiousGuidance] cron initialized (daily 09:13 IST)");
}

module.exports = {
  initReligiousGuidanceCron,
  runReligiousGuidanceForTenant,
  runReligiousGuidanceForAllTravelTenants,
  // Exported for unit-test introspection only.
  daysToDeparture,
  ELIGIBLE_STATUSES,
  MAX_LOOKAHEAD_DAYS,
};
