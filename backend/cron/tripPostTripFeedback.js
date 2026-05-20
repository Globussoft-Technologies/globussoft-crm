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

const cron = require("node-cron");
const prisma = require("../lib/prisma");

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
          `survey ${survey.id} created; dispatch link: ${link}`,
      );
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
  // 06:13 IST — :13 minute jitter per the standing rule (avoid :00 / :30
  // clustering across the cron fleet). The actual time of day matches the
  // PRD §6.3 "daily 06:00 IST" specification approximately.
  cron.schedule("13 6 * * *", () => {
    runPostTripFeedbackForAllTravelTenants().catch((e) =>
      console.error("[TripPostTripFeedback] cron fail:", e.message),
    );
  });
  console.log("[TripPostTripFeedback] cron initialized (daily 06:13 IST)");
}

module.exports = {
  initTripPostTripFeedbackCron,
  runPostTripFeedbackForTenant,
  runPostTripFeedbackForAllTravelTenants,
};
