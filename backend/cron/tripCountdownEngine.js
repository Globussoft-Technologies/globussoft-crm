// Travel CRM — pre-trip "countdown" nudge engine (2026-06-16 feature).
//
// For every travel itinerary the customer has PAID for — i.e. status ∈
// {advance_paid, fully_paid} (the 50% deposit has at least landed) — with a
// trip start date approaching, email a short, creative reminder:
//
//   T-30, T-14  early check-ins
//   T-7 … T-0   a DAILY nudge through the final week ("keep packing!")
//
// Why paid-only and not `accepted`: an `accepted`-but-unpaid booking is still
// in the deposit-chase phase, handled by cron/paymentDeadlineEngine.js
// (pay-or-cancel reminders T-10 → T-7 + an overdue advisor flag). Sending a
// "keep packing!" email to someone who still owes a deposit is the wrong
// message — and at T-7 both engines would otherwise fire. Once they pay
// (status → advance_paid), they graduate from the payment track to this
// packing track. (PRD §4.7 / 2026-06-16 product call.)
//
// Content: LLM-generated per email (task "trip-countdown") when Q11 keys are
// present; otherwise the deterministic template library in
// lib/tripCountdownContent.js (distinct copy per day). Delivery: real SendGrid
// email (lib/emailSender.js) to Contact.email.
//
// Idempotency: one TripCountdownNudge row per (itineraryId, dayTag), claimed
// BEFORE sending so an hourly re-tick on the same day can't double-email.
//
// Spans ALL travel sub-brands. (RFU also has the religious-milestone cron
// travelJourneyReminders.js, which only writes Notification rows — no email —
// so the two don't double-send.)

const cron = require("node-cron");
const prisma = require("../lib/prisma");
const emailSender = require("../lib/emailSender");
const content = require("../lib/tripCountdownContent");
// Pure helpers are safe to bind directly; sendEmail + buildNudge are called
// through their module object (emailSender.* / content.*) so a singleton
// monkeypatch in the unit tests can intercept them (vi.mock can't reach the
// SUT's CJS require chain under this vitest setup).
const { FIRE_DAYS, shouldFire, dayTag } = content;

// Packing nudges go only to PAID trips — `accepted`-but-unpaid is the deposit-
// chase phase (cron/paymentDeadlineEngine.js owns it). Kept as PAID_STATUSES;
// the old name AGREEMENT_SECURED is exported as an alias for back-compat.
const PAID_STATUSES = ["advance_paid", "fully_paid"];
const AGREEMENT_SECURED = PAID_STATUSES;
const HORIZON_DAYS = Math.max(...FIRE_DAYS); // scan window upper bound (30)

// Calendar-day difference (UTC) between `now` and the trip start.
function daysToGo(now, start) {
  const a = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const b = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  return Math.round((b - a) / 86400000);
}

// One pass. `now` is injectable for tests. Returns a summary for observability.
async function runTripCountdownTick(now = new Date()) {
  const floor = new Date(now.getTime() - 86400000); // tolerate same-day/just-past
  const horizon = new Date(now.getTime() + (HORIZON_DAYS + 1) * 86400000);

  const itineraries = await prisma.itinerary.findMany({
    where: {
      status: { in: AGREEMENT_SECURED },
      startDate: { gte: floor, lte: horizon },
    },
    select: { id: true, tenantId: true, subBrand: true, contactId: true, destination: true, startDate: true },
  });

  // Batch-fetch contact email + name.
  const contactIds = [...new Set(itineraries.map((i) => i.contactId).filter(Boolean))];
  const contacts = contactIds.length
    ? await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true, email: true } })
    : [];
  const contactById = Object.fromEntries(contacts.map((c) => [c.id, c]));

  const summary = { scanned: itineraries.length, fired: 0, sent: 0, skipped: 0 };

  for (const itin of itineraries) {
    if (!itin.startDate) { summary.skipped += 1; continue; }
    const d = daysToGo(now, new Date(itin.startDate));
    if (!shouldFire(d)) { summary.skipped += 1; continue; }

    const contact = itin.contactId ? contactById[itin.contactId] : null;
    if (!contact || !contact.email) { summary.skipped += 1; continue; }

    const tag = dayTag(d);

    // Idempotent claim — unique([itineraryId, dayTag]) means a re-tick the
    // same day collides + we skip (at-most-once email per day-bucket).
    let claim;
    try {
      claim = await prisma.tripCountdownNudge.create({
        data: { tenantId: itin.tenantId, itineraryId: itin.id, dayTag: tag, channel: "email", status: "sending" },
      });
    } catch {
      // P2002 unique violation → already handled this day-bucket.
      summary.skipped += 1;
      continue;
    }

    summary.fired += 1;
    let nudge;
    try {
      nudge = await content.buildNudge({
        tenantId: itin.tenantId,
        destination: itin.destination,
        daysToGo: d,
        customerName: contact.name,
      });
    } catch (e) {
      console.error(`[TripCountdown] content build failed for itin=${itin.id} ${tag}: ${e.message}`);
      await prisma.tripCountdownNudge.update({ where: { id: claim.id }, data: { status: "failed" } }).catch(() => {});
      continue;
    }

    const res = await emailSender.sendEmail({ to: contact.email, subject: nudge.subject, text: nudge.text, html: nudge.html });
    const status = res.sent ? "sent" : res.reason === "no_api_key" ? "logged" : "failed";
    if (res.sent) summary.sent += 1;
    await prisma.tripCountdownNudge
      .update({ where: { id: claim.id }, data: { status, subject: nudge.subject, llmSourced: nudge.llmSourced } })
      .catch(() => {});
    console.log(`[TripCountdown] itin=${itin.id} dest="${itin.destination}" ${tag} → ${status} (llm=${nudge.llmSourced})`);
  }

  if (summary.fired > 0 || summary.scanned > 0) {
    console.log(`[TripCountdown] tick: scanned=${summary.scanned} fired=${summary.fired} sent=${summary.sent} skipped=${summary.skipped}`);
  }
  return summary;
}

// Hourly tick (at :17). Daily-bucket idempotency means the first tick of each
// day that sees a new days-to-go sends; later ticks that day are no-ops.
function initTripCountdownCron() {
  cron.schedule("17 * * * *", () => {
    runTripCountdownTick().catch((e) => console.error("[TripCountdown] tick error:", e.message));
  });
  console.log("[TripCountdown] cron scheduled (hourly :17)");
}

module.exports = { runTripCountdownTick, initTripCountdownCron, daysToGo, PAID_STATUSES, AGREEMENT_SECURED };
