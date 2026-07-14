// Travel CRM — post-trip feedback cron (PRD §4.8 + §6.3).
//
// Daily 06:13 IST (the :13 is the standing-rule off-minute jitter — every
// cron at :00 hits the fleet at the same instant). Scans TmcTrip rows for
// completed trips and creates a Survey row + logs the dispatch link.
//
// Window: returnDate ∈ [now - 7d, now - 1d]. The 1-day floor gives the
// trip leader time to wrap up before pinging for feedback; the 7-day
// ceiling stops the cron from re-scanning ancient trips forever (the
// idempotency guard catches duplicates inside the window anyway).
//
// Idempotency: Survey.name = `posttrip-trip-<tripId>`. If the row exists,
// the trip is skipped. Re-runs are safe.
//
// Dispatch: this Phase 1 ship creates the Survey row only; the WhatsApp /
// email dispatch lives behind cred-blocked external integrations
// (Wati BSP for WhatsApp per Q9; email is autonomous-doable but the
// existing wellness NPS pattern uses SmsMessage which we don't want to
// reuse here). When Wati creds land, the dispatch loop adds a
// WhatsAppMessage row keyed to schoolContact.phone with the survey link.

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { resolveForSubBrand } = require("../lib/subBrandConfig");
// WhatsApp transport swap (Q9): Wati REST is COMMENTED OUT (kept on disk, not removed);
// travel now dispatches over WhatsApp Web (QR-scan) via a drop-in client.
// const watiClient = require("../services/watiClient"); // legacy Wati REST (disabled)
const watiClient = require("../services/whatsappWebClient");

const WINDOW_FLOOR_DAYS = 7;
const WINDOW_CEILING_HOURS = 24;
const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";

/**
 * Run the post-trip-feedback sweep for a single travel tenant.
 *
 * @param {number} tenantId
 * @returns {Promise<{ created: number, skipped: number }>}
 */
async function runPostTripFeedbackForTenant(tenantId) {
  const now = Date.now();
  const ceiling = new Date(now - WINDOW_CEILING_HOURS * 3600_000);
  const floor = new Date(now - WINDOW_FLOOR_DAYS * 86400_000);

  // Trips whose return date is 1-7 days ago. Status enum includes
  // 'completed', 'in-trip' (residual travelers), and 'confirmed'. For
  // post-trip feedback we accept 'completed' OR 'in-trip' so a trip the
  // operator forgot to mark completed still gets surveyed; 'cancelled' is
  // excluded.
  const trips = await prisma.tmcTrip.findMany({
    where: {
      tenantId,
      returnDate: { gte: floor, lte: ceiling },
      status: { in: ["completed", "in-trip", "confirmed"] },
    },
    select: {
      id: true,
      tripCode: true,
      destination: true,
      schoolContactId: true,
    },
    take: 200,
  });

  // One tenant row read per pass for the Q9 cut-over plumbing — the
  // wabaId is logged at survey-create time so operators can see which
  // WABA the post-trip outreach WOULD route through once Wati creds
  // land. TmcTrip rows are subBrand=tmc by construction.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subBrandConfigJson: true },
  });
  const tmcCfg = resolveForSubBrand(tenant, "tmc");

  let created = 0;
  let skipped = 0;
  for (const trip of trips) {
    const tag = `posttrip-trip-${trip.id}`;
    const existing = await prisma.survey.findFirst({
      where: { tenantId, name: tag },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }
    try {
      const survey = await prisma.survey.create({
        data: {
          tenantId,
          name: tag,
          type: "NPS",
          question: `How was your ${trip.destination} trip with us? Reply 0-10 (10 = loved it). We'd love to hear what made it memorable.`,
        },
      });
      const link = `${PORTAL_BASE}/survey/${survey.id}?c=${trip.schoolContactId}&tripId=${trip.id}`;
      console.log(
        `[TripPostTripFeedback] tenant ${tenantId} trip ${trip.tripCode} → ` +
          `survey ${survey.id} created; dispatch link: ${link} — would-route ` +
          `subBrand=tmc wabaId=${tmcCfg.wabaId || "(no-config)"}`,
      );
      // WhatsApp dispatch via watiClient (Q9) — stub when creds absent.
      // Own try/catch: a contact-lookup or send failure must not eat the
      // created++ below (the survey row already landed). Per-created-survey
      // contact lookup is fine: created counts are small.
      try {
        if (trip.schoolContactId) {
          const contact = await prisma.contact.findFirst({
            where: { id: trip.schoolContactId, tenantId },
            select: { id: true, phone: true, name: true },
          });
          if (contact && contact.phone) {
            await watiClient.sendBestEffort({
              tenantId,
              subBrand: "tmc",
              toPhone: contact.phone,
              contactId: contact.id,
              templateName: process.env.WATI_POST_TRIP_FEEDBACK_TEMPLATE || "post_trip_feedback",
              parameters: [
                { name: "name", value: contact.name || "there" },
                { name: "destination", value: trip.destination || "" },
                { name: "link", value: link },
              ],
              broadcastName: "travel-post-trip-feedback",
              fallbackText: `How was your ${trip.destination} trip with us? Tell us here: ${link}`,
            });
          }
        }
      } catch (waErr) {
        console.error(`[TripPostTripFeedback] WA dispatch failed (survey ${survey.id} still created): ${waErr.message}`);
      }
      created++;
    } catch (e) {
      // Race-condition tolerance: another worker may have inserted the
      // same `name` between our findFirst and create. Skip + continue.
      console.error(
        `[TripPostTripFeedback] tenant ${tenantId} trip ${trip.id} create error:`,
        e.message,
      );
    }
  }

  return { created, skipped };
}

/**
 * Run the sweep for all travel tenants. Used by the cron schedule.
 */
async function runPostTripFeedbackForAllTravelTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "travel", isActive: true },
    select: { id: true, slug: true },
  });
  let totalCreated = 0;
  for (const t of tenants) {
    try {
      const { created, skipped } = await runPostTripFeedbackForTenant(t.id);
      totalCreated += created;
      if (created || skipped) {
        console.log(
          `[TripPostTripFeedback] tenant ${t.slug}: ${created} surveys created, ${skipped} skipped (already invited)`,
        );
      }
    } catch (e) {
      console.error("[TripPostTripFeedback] tenant fail:", t.slug, e.message);
    }
  }
  return totalCreated;
}

function initTripPostTripFeedbackCron() {
  // 06:13 IST — matches the PRD §6.3 "daily 06:00 IST" specification approximately.
  cronRegistry.register({
    name: "tripPostTripFeedback",
    description: "Creates a post-trip feedback Survey for recently-returned TmcTrips (daily 06:13 IST)",
    defaultSchedule: "13 6 * * *",
    tickFn: runPostTripFeedbackForAllTravelTenants,
  }).catch((e) => console.error("[TripPostTripFeedback] cronRegistry registration failed:", e.message));
}

module.exports = {
  initTripPostTripFeedbackCron,
  runPostTripFeedbackForTenant,
  runPostTripFeedbackForAllTravelTenants,
};
