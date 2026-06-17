// Travel CRM — post-trip review routes (2026-06-16).
//
//   PUBLIC (no auth, token-gated — for the email link → /p/review/:token):
//     GET  /api/travel/reviews/public/:token         → form + destination + state
//     POST /api/travel/reviews/public/:token/submit  → store the submission
//
//   ADVISOR (verifyToken + requireTravelTenant):
//     GET  /api/travel/reviews                        → submitted reviews (sub-brand scoped)
//
// The portal has its own logged-in submit path (routes/portal.js) that writes
// the SAME TravelTripReview row. Questions are the fixed set in
// lib/travelReviewQuestions.js with {destination} woven in.

const express = require("express");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const { requireTravelTenant, getSubBrandAccessSet, canAccessSubBrand } = require("../middleware/travelGuards");
const { buildForm, validateSubmission } = require("../lib/travelReviewQuestions");

// ── PUBLIC — fetch the form (by review token) ────────────────────────
router.get("/reviews/public/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const review = await prisma.travelTripReview.findUnique({
      where: { token },
      select: { id: true, status: true, itineraryId: true, overallRating: true },
    });
    if (!review) return res.status(404).json({ error: "Review link not found", code: "NOT_FOUND" });

    const itin = await prisma.itinerary.findUnique({
      where: { id: review.itineraryId },
      select: { destination: true },
    });
    const destination = (itin && itin.destination) || "your trip";
    res.json({
      destination,
      status: review.status, // "requested" | "submitted"
      alreadySubmitted: review.status === "submitted",
      overallRating: review.overallRating,
      form: buildForm(destination),
    });
  } catch (e) {
    console.error("[travel-reviews] public get error:", e.message);
    res.status(500).json({ error: "Failed to load review" });
  }
});

// ── PUBLIC — submit the review (by token) ────────────────────────────
router.post("/reviews/public/:token/submit", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const review = await prisma.travelTripReview.findUnique({
      where: { token },
      select: { id: true, status: true },
    });
    if (!review) return res.status(404).json({ error: "Review link not found", code: "NOT_FOUND" });
    if (review.status === "submitted") {
      return res.status(409).json({ error: "This review has already been submitted — thank you!", code: "ALREADY_SUBMITTED" });
    }

    const { ok, errors, overallRating, clean } = validateSubmission(req.body && req.body.answers);
    if (!ok) return res.status(400).json({ error: "Some answers need attention", code: "INVALID_ANSWERS", errors });

    await prisma.travelTripReview.update({
      where: { id: review.id },
      data: { status: "submitted", overallRating, answersJson: JSON.stringify(clean), submittedAt: new Date() },
    });
    res.status(201).json({ ok: true, overallRating });
  } catch (e) {
    console.error("[travel-reviews] public submit error:", e.message);
    res.status(500).json({ error: "Failed to submit review" });
  }
});

// ── ADVISOR — list submitted reviews (sub-brand scoped) ──────────────
router.get("/reviews", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const reviews = await prisma.travelTripReview.findMany({
      where: { tenantId: req.travelTenant.id, status: "submitted" },
      orderBy: { submittedAt: "desc" },
      take: 200,
      select: { id: true, itineraryId: true, contactId: true, overallRating: true, answersJson: true, submittedAt: true },
    });
    // Enrich with the itinerary's destination + sub-brand AND the reviewer's
    // contact details (name/email — so the advisor sees WHO left it), then
    // filter by the caller's sub-brand access.
    const itinIds = [...new Set(reviews.map((r) => r.itineraryId))];
    const itins = itinIds.length
      ? await prisma.itinerary.findMany({ where: { id: { in: itinIds } }, select: { id: true, destination: true, subBrand: true } })
      : [];
    const itinById = Object.fromEntries(itins.map((i) => [i.id, i]));
    const contactIds = [...new Set(reviews.map((r) => r.contactId).filter(Boolean))];
    const contacts = contactIds.length
      ? await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true, email: true, phone: true } })
      : [];
    const contactById = Object.fromEntries(contacts.map((c) => [c.id, c]));
    const allowed = await getSubBrandAccessSet(req.user.userId);
    const out = reviews
      .map((r) => {
        const it = itinById[r.itineraryId] || {};
        const c = contactById[r.contactId] || {};
        return {
          ...r,
          destination: it.destination || null,
          subBrand: it.subBrand || null,
          contactName: c.name || null,
          contactEmail: c.email || null,
          contactPhone: c.phone || null,
          answers: r.answersJson ? JSON.parse(r.answersJson) : {},
        };
      })
      .filter((r) => !r.subBrand || canAccessSubBrand(allowed, r.subBrand));
    res.json({ reviews: out, total: out.length });
  } catch (e) {
    console.error("[travel-reviews] advisor list error:", e.message);
    res.status(500).json({ error: "Failed to list reviews" });
  }
});

module.exports = router;
