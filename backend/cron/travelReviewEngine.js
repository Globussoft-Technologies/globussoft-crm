// Travel CRM — post-trip review-request engine (2026-06-16 feature).
//
// After a trip completes (the itinerary's `endDate` has passed), email the
// customer a one-minute review with a fixed set of questions
// (lib/travelReviewQuestions.js) whose wording weaves in the destination
// ("How was your trip to Bali?"). The email links to a public review page
// (/p/review/:token); the customer can also submit from their logged-in
// portal — both write the same TravelTripReview row.
//
// Scope: COMMITTED bookings — status ∈ {accepted, advance_paid, fully_paid}
// (the codebase's "agreement-secured" set; a booking the customer agreed to is
// reviewable whether or not payment was recorded). All sub-brands EXCEPT Visa
// Sure (a visa application isn't a trip to review). Only recently-completed
// trips (endDate within the last COMPLETION_LOOKBACK_DAYS) are picked up, so a
// fresh deploy doesn't blast every historical booking.
//
// Idempotency: one TravelTripReview row per itinerary (@unique). The row is
// claimed BEFORE the email so a re-tick can't double-request.
//
// Travel-only: scans the Itinerary model (travel-only) — no-ops for
// wellness/generic.

const cron = require("node-cron");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const emailSender = require("../lib/emailSender");
const content = require("../lib/travelReviewContent");
const { safeNotifyTravelCustomer } = require("../lib/travelPortalNotificationService");

// "Agreement-secured" set — any booking the customer committed to is reviewable
// once it's over (payment state doesn't gate a review).
const REVIEW_STATUSES = ["accepted", "advance_paid", "fully_paid"];
const COMPLETION_LOOKBACK_DAYS = 4; // only trips completed within this window
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";

function reviewUrl(token) {
  return `${PUBLIC_BASE}/p/review/${token}`;
}

// One pass. `now` is injectable for tests. Returns a summary for observability.
async function runTravelReviewTick(now = new Date()) {
  const floor = new Date(now.getTime() - COMPLETION_LOOKBACK_DAYS * 86400000);

  const itineraries = await prisma.itinerary.findMany({
    where: {
      status: { in: REVIEW_STATUSES },
      subBrand: { not: "visasure" },
      endDate: { gte: floor, lt: now }, // completed within the lookback window
    },
    select: { id: true, tenantId: true, contactId: true, destination: true, endDate: true },
  });

  // Skip itineraries that already have a review row (requested or submitted).
  const itinIds = itineraries.map((i) => i.id);
  const existing = itinIds.length
    ? await prisma.travelTripReview.findMany({ where: { itineraryId: { in: itinIds } }, select: { itineraryId: true } })
    : [];
  const haveReview = new Set(existing.map((r) => r.itineraryId));

  // Batch-fetch contact email + name.
  const contactIds = [...new Set(itineraries.map((i) => i.contactId).filter(Boolean))];
  const contacts = contactIds.length
    ? await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true, email: true } })
    : [];
  const contactById = Object.fromEntries(contacts.map((c) => [c.id, c]));

  const summary = { scanned: itineraries.length, requested: 0, sent: 0, skipped: 0 };

  for (const itin of itineraries) {
    if (haveReview.has(itin.id)) { summary.skipped += 1; continue; }
    const contact = itin.contactId ? contactById[itin.contactId] : null;
    if (!contact || !contact.email) { summary.skipped += 1; continue; }

    const token = crypto.randomBytes(24).toString("base64url");

    // Idempotent claim — @unique(itineraryId) means a race/re-tick collides + we skip.
    try {
      await prisma.travelTripReview.create({
        data: { tenantId: itin.tenantId, itineraryId: itin.id, contactId: contact.id, token, status: "requested" },
      });
    } catch {
      summary.skipped += 1; // P2002 — already requested
      continue;
    }

    summary.requested += 1;
    const mail = content.buildRequestEmail({
      destination: itin.destination,
      customerName: contact.name,
      reviewUrl: reviewUrl(token),
    });
    const res = await emailSender.sendEmail({ to: contact.email, subject: mail.subject, text: mail.text, html: mail.html });
    if (res.sent) summary.sent += 1;
    // Mirror to the customer's in-app portal bell (no SMS — no phone collected).
    // The booking detail in the portal hosts the review form. Best-effort.
    await safeNotifyTravelCustomer({
      contactId: contact.id, tenantId: itin.tenantId, type: "info",
      title: `How was your trip to ${itin.destination || "your destination"}?`,
      message: "We'd love your feedback — open your booking to leave a quick review.",
      link: `booking:${itin.id}`,
    });
    const status = res.sent ? "sent" : res.reason === "no_api_key" ? "logged" : "failed";
    console.log(`[TravelReview] itin=${itin.id} dest="${itin.destination}" review requested → email ${status}`);
  }

  if (summary.scanned > 0) {
    console.log(`[TravelReview] tick: scanned=${summary.scanned} requested=${summary.requested} sent=${summary.sent} skipped=${summary.skipped}`);
  }
  return summary;
}

// Daily tick at 09:07 — reviews aren't time-critical; the 4-day lookback covers
// any missed day. Idempotency (one row per itinerary) makes re-runs safe.
function initTravelReviewCron() {
  cron.schedule("7 9 * * *", () => {
    runTravelReviewTick().catch((e) => console.error("[TravelReview] tick error:", e.message));
  });
  console.log("[TravelReview] cron scheduled (daily 09:07)");
}

module.exports = { runTravelReviewTick, initTravelReviewCron, REVIEW_STATUSES, reviewUrl };
