// Travel CRM — Itinerary CRUD routes (Phase 1).
//
// Endpoints:
//   GET    /api/travel/itineraries                          — list (paginated, filterable)
//   POST   /api/travel/itineraries                          — create itinerary (+ optional items)
//   GET    /api/travel/itineraries/:id                      — fetch one with items
//   PATCH  /api/travel/itineraries/:id                      — amend top-level fields (not items)
//   POST   /api/travel/itineraries/:id/items                — append a polymorphic item
//   PATCH  /api/travel/itineraries/:id/items/:itemId        — amend an item
//   DELETE /api/travel/itineraries/:id/items/:itemId        — remove an item
//
// Mounted at /api/travel by server.js. Shares the requireTravelTenant
// guard + sub-brand access check with travel_diagnostics.js (extracted
// to a shared helper in Day 11).
//
// Item polymorphism: ItineraryItem.itemType ∈ {flight, hotel, transfer,
// activity, visa, insurance}. detailsJson carries the type-specific
// payload (e.g. for flight: { from, to, depart, return, cabin, pnr }).
// The route validates itemType against the enum + parses detailsJson as
// JSON; per-type field validation is intentionally deferred (Phase 1.5)
// because each type's required fields are still being finalised with
// Yasin's supplier docs.
//
// Money fields use Decimal(15,2) per Q24.
//
// See docs/TRAVEL_CRM_PRD.md §4.3 + §5.1 for the spec.

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const { renderTravelItineraryPdf } = require("../services/pdfRenderer");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
  assertCompletedDiagnostic,
} = require("../middleware/travelGuards");
const { findLatestDiagnostic } = require("../lib/travelLatestDiagnostic");
const { getTravelAdvanceRatio } = require("../lib/tenantSettings");
const { computeWindowOpenAt } = require("../lib/webCheckinWindow");

const VALID_ITEM_TYPES = ["flight", "hotel", "transfer", "activity", "visa", "insurance"];
// Phase 2 (PRD §4.7) extends the enum with advance_paid / fully_paid for
// the 50%-advance booking flow. Existing draft/sent/etc. semantics
// unchanged — the two new values are only set by the public payment
// endpoints. Routes that PATCH status accept all 7 values.
const VALID_STATUSES = ["draft", "sent", "revised", "accepted", "rejected", "advance_paid", "fully_paid"];
// Advance-deposit ratio is now per-tenant + per-sub-brand tunable via
// the TenantSetting table — see lib/tenantSettings.js. The Phase 2
// baseline (Travel Stall 50/50) is the helper's hard-coded fallback
// when no setting row exists; RFU pilgrim packages can override to
// 0.3 (30/70), TMC school trips will use their TripPaymentPlan
// instead. Keep the public GET + record-advance shapes unchanged.

function assertValidItemType(itemType) {
  if (!VALID_ITEM_TYPES.includes(itemType)) {
    const err = new Error(`itemType must be one of: ${VALID_ITEM_TYPES.join(", ")}`);
    err.status = 400;
    err.code = "INVALID_ITEM_TYPE";
    throw err;
  }
}

// ─── List + create ────────────────────────────────────────────────────

// GET /api/travel/itineraries
router.get("/itineraries", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const where = { tenantId: req.travelTenant.id };
    if (req.query.subBrand) {
      assertValidSubBrand(String(req.query.subBrand));
      where.subBrand = String(req.query.subBrand);
    }
    if (req.query.status) {
      if (!VALID_STATUSES.includes(String(req.query.status))) {
        return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
      }
      where.status = String(req.query.status);
    }
    if (req.query.contactId) {
      const cid = parseInt(req.query.contactId, 10);
      if (Number.isFinite(cid)) where.contactId = cid;
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (allowed) {
      where.subBrand = where.subBrand
        ? canAccessSubBrand(allowed, where.subBrand) ? where.subBrand : "__none__"
        : { in: [...allowed] };
    }

    const take = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = parseInt(req.query.offset, 10) || 0;

    const [itineraries, total] = await Promise.all([
      prisma.itinerary.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: { items: { orderBy: { position: "asc" } } },
      }),
      prisma.itinerary.count({ where }),
    ]);
    res.json({ itineraries, total, limit: take, offset: skip });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] list error:", e.message);
    res.status(500).json({ error: "Failed to list itineraries" });
  }
});

// POST /api/travel/itineraries
// Required: subBrand, contactId, destination. Optional: leadId, status,
// startDate, endDate, pricingJson, totalAmount, currency, items[].
router.post("/itineraries", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const { subBrand, contactId, destination } = req.body || {};
    if (!subBrand || !contactId || !destination) {
      return res.status(400).json({
        error: "subBrand, contactId, destination required",
        code: "MISSING_FIELDS",
      });
    }
    assertValidSubBrand(subBrand);
    const cid = parseInt(contactId, 10);
    if (!Number.isFinite(cid)) {
      return res.status(400).json({ error: "contactId must be a number", code: "INVALID_CONTACT_ID" });
    }

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }

    // PRD §4.1 diagnostic-first guard. The Itinerary is the customer-facing
    // quote artifact (PDF + share link); the PRD forbids creating one
    // before the contact has completed a diagnostic for this sub-brand.
    // /pricing/quote stays unguarded — it's pure internal pricing math.
    await assertCompletedDiagnostic(prisma, req.travelTenant.id, cid, subBrand);

    const {
      leadId, status, startDate, endDate,
      pricingJson, totalAmount, currency, shareToken,
      items, productTier: bodyProductTier,
    } = req.body;

    // PRD §6.4 — capture the recommended tier from the contact's latest
    // diagnostic so tier-vs-actual analytics stay stable. Body can override;
    // otherwise default from the diagnostic's recommendedTier (may itself
    // be null if the diagnostic didn't classify, e.g. unanswered Qs).
    let productTier = bodyProductTier || null;
    if (!productTier) {
      const latest = await findLatestDiagnostic(prisma, req.travelTenant.id, cid, subBrand);
      productTier = (latest && latest.recommendedTier) || null;
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
    }

    // Validate items[] up-front so a bad item type rejects before the
    // create transaction starts.
    const itemRows = [];
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || typeof it !== "object") continue;
        if (!it.itemType || !it.description) {
          return res.status(400).json({
            error: `items[${i}]: itemType + description required`,
            code: "ITEM_MISSING_FIELDS",
          });
        }
        assertValidItemType(it.itemType);
        itemRows.push({
          itemType: it.itemType,
          position: typeof it.position === "number" ? it.position : i,
          description: String(it.description),
          detailsJson: it.detailsJson ? String(it.detailsJson) : null,
          supplierId: it.supplierId ? parseInt(it.supplierId, 10) : null,
          unitCost: it.unitCost != null ? Number(it.unitCost) : null,
          markup: it.markup != null ? Number(it.markup) : null,
          gstAmount: it.gstAmount != null ? Number(it.gstAmount) : null,
          totalPrice: it.totalPrice != null ? Number(it.totalPrice) : null,
        });
      }
    }

    const itinerary = await prisma.itinerary.create({
      data: {
        tenantId: req.travelTenant.id,
        subBrand,
        contactId: cid,
        leadId: leadId ? parseInt(leadId, 10) : null,
        status: status || "draft",
        productTier,
        destination: String(destination),
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        pricingJson: pricingJson ? String(pricingJson) : null,
        totalAmount: totalAmount != null ? Number(totalAmount) : null,
        currency: currency || "INR",
        shareToken: shareToken || null,
        items: itemRows.length > 0 ? { create: itemRows } : undefined,
      },
      include: { items: { orderBy: { position: "asc" } } },
    });
    res.status(201).json(itinerary);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    if (e.code === "P2002") {
      return res.status(409).json({ error: "shareToken collision", code: "DUPLICATE_SHARE_TOKEN" });
    }
    console.error("[travel-itin] create error:", e.message);
    res.status(500).json({ error: "Failed to create itinerary" });
  }
});

// ─── Get + amend ──────────────────────────────────────────────────────

// GET /api/travel/itineraries/:id
router.get("/itineraries/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const itin = await prisma.itinerary.findFirst({
      where: { id, tenantId: req.travelTenant.id },
      include: { items: { orderBy: { position: "asc" } } },
    });
    if (!itin) return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, itin.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }
    res.json(itin);
  } catch (e) {
    console.error("[travel-itin] get error:", e.message);
    res.status(500).json({ error: "Failed to get itinerary" });
  }
});

// PATCH /api/travel/itineraries/:id
// Amend top-level fields only (not items — those have their own endpoints).
router.patch("/itineraries/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
    }
    const existing = await prisma.itinerary.findFirst({
      where: { id, tenantId: req.travelTenant.id },
      select: { id: true, subBrand: true },
    });
    if (!existing) return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, existing.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }

    const data = {};
    const {
      status, destination, startDate, endDate,
      pricingJson, totalAmount, currency, pdfUrl, shareToken,
    } = req.body || {};

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: "invalid status", code: "INVALID_STATUS" });
      }
      data.status = status;
    }
    if (destination !== undefined) data.destination = String(destination);
    if (startDate !== undefined) data.startDate = startDate ? new Date(startDate) : null;
    if (endDate !== undefined) data.endDate = endDate ? new Date(endDate) : null;
    if (pricingJson !== undefined) data.pricingJson = pricingJson ? String(pricingJson) : null;
    if (totalAmount !== undefined) data.totalAmount = totalAmount != null ? Number(totalAmount) : null;
    if (currency !== undefined) data.currency = currency || "INR";
    if (pdfUrl !== undefined) data.pdfUrl = pdfUrl || null;
    if (shareToken !== undefined) data.shareToken = shareToken || null;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
    }

    const updated = await prisma.itinerary.update({
      where: { id },
      data,
      include: { items: { orderBy: { position: "asc" } } },
    });
    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    if (e.code === "P2002") {
      return res.status(409).json({ error: "shareToken collision", code: "DUPLICATE_SHARE_TOKEN" });
    }
    console.error("[travel-itin] patch error:", e.message);
    res.status(500).json({ error: "Failed to update itinerary" });
  }
});

// DELETE /api/travel/itineraries/:id — ADMIN only (full delete cascades items).
router.delete(
  "/itineraries/:id",
  verifyToken,
  verifyRole(["ADMIN"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id must be a number", code: "INVALID_ID" });
      }
      const existing = await prisma.itinerary.findFirst({
        where: { id, tenantId: req.travelTenant.id },
      });
      if (!existing) return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
      await prisma.itinerary.delete({ where: { id } });
      res.json({ deleted: true, id });
    } catch (e) {
      console.error("[travel-itin] delete error:", e.message);
      res.status(500).json({ error: "Failed to delete itinerary" });
    }
  },
);

// ─── Item endpoints ───────────────────────────────────────────────────

async function loadItineraryWithGuard(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    const err = new Error("id must be a number");
    err.status = 400;
    err.code = "INVALID_ID";
    throw err;
  }
  const itin = await prisma.itinerary.findFirst({
    where: { id, tenantId: req.travelTenant.id },
    select: { id: true, subBrand: true },
  });
  if (!itin) {
    const err = new Error("Itinerary not found");
    err.status = 404;
    err.code = "NOT_FOUND";
    throw err;
  }
  const allowed = await getSubBrandAccessSet(req.user.userId);
  if (!canAccessSubBrand(allowed, itin.subBrand)) {
    const err = new Error("Sub-brand access denied");
    err.status = 403;
    err.code = "SUB_BRAND_DENIED";
    throw err;
  }
  return itin;
}

// POST /api/travel/itineraries/:id/items
router.post("/itineraries/:id/items", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const { itemType, description, position, detailsJson, supplierId, unitCost, markup, gstAmount, totalPrice } = req.body || {};
    if (!itemType || !description) {
      return res.status(400).json({ error: "itemType + description required", code: "ITEM_MISSING_FIELDS" });
    }
    assertValidItemType(itemType);

    // Auto-position if not provided — append to the end.
    let pos = typeof position === "number" ? position : null;
    if (pos === null) {
      const maxRow = await prisma.itineraryItem.findFirst({
        where: { itineraryId: itin.id },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      pos = (maxRow?.position ?? -1) + 1;
    }

    const created = await prisma.itineraryItem.create({
      data: {
        itineraryId: itin.id,
        itemType,
        position: pos,
        description: String(description),
        detailsJson: detailsJson ? String(detailsJson) : null,
        supplierId: supplierId ? parseInt(supplierId, 10) : null,
        unitCost: unitCost != null ? Number(unitCost) : null,
        markup: markup != null ? Number(markup) : null,
        gstAmount: gstAmount != null ? Number(gstAmount) : null,
        totalPrice: totalPrice != null ? Number(totalPrice) : null,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] item create error:", e.message);
    res.status(500).json({ error: "Failed to create item" });
  }
});

// PATCH /api/travel/itineraries/:id/items/:itemId
router.patch("/itineraries/:id/items/:itemId", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const itemId = parseInt(req.params.itemId, 10);
    if (!Number.isFinite(itemId)) {
      return res.status(400).json({ error: "itemId must be a number", code: "INVALID_ITEM_ID" });
    }
    const existing = await prisma.itineraryItem.findFirst({
      where: { id: itemId, itineraryId: itin.id },
    });
    if (!existing) return res.status(404).json({ error: "Item not found", code: "ITEM_NOT_FOUND" });

    const data = {};
    const { itemType, position, description, detailsJson, supplierId, unitCost, markup, gstAmount, totalPrice } = req.body || {};
    if (itemType !== undefined) {
      assertValidItemType(itemType);
      data.itemType = itemType;
    }
    if (position !== undefined) data.position = Number(position);
    if (description !== undefined) data.description = String(description);
    if (detailsJson !== undefined) data.detailsJson = detailsJson ? String(detailsJson) : null;
    if (supplierId !== undefined) data.supplierId = supplierId ? parseInt(supplierId, 10) : null;
    if (unitCost !== undefined) data.unitCost = unitCost != null ? Number(unitCost) : null;
    if (markup !== undefined) data.markup = markup != null ? Number(markup) : null;
    if (gstAmount !== undefined) data.gstAmount = gstAmount != null ? Number(gstAmount) : null;
    if (totalPrice !== undefined) data.totalPrice = totalPrice != null ? Number(totalPrice) : null;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "no updatable fields provided", code: "EMPTY_BODY" });
    }

    const updated = await prisma.itineraryItem.update({ where: { id: itemId }, data });
    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] item patch error:", e.message);
    res.status(500).json({ error: "Failed to update item" });
  }
});

// DELETE /api/travel/itineraries/:id/items/:itemId
router.delete("/itineraries/:id/items/:itemId", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const itemId = parseInt(req.params.itemId, 10);
    if (!Number.isFinite(itemId)) {
      return res.status(400).json({ error: "itemId must be a number", code: "INVALID_ITEM_ID" });
    }
    const existing = await prisma.itineraryItem.findFirst({
      where: { id: itemId, itineraryId: itin.id },
    });
    if (!existing) return res.status(404).json({ error: "Item not found", code: "ITEM_NOT_FOUND" });
    await prisma.itineraryItem.delete({ where: { id: itemId } });
    res.json({ deleted: true, id: itemId });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] item delete error:", e.message);
    res.status(500).json({ error: "Failed to delete item" });
  }
});

// ─── Status transitions + version chain (PRD §4.3 / §6.1) ───────────
//
// `status` flows: draft → sent → revised → accepted | rejected. The
// accept/reject endpoints are explicit terminal transitions; PUT (full
// replacement with version bump) is the canonical "revised" path —
// creates a NEW Itinerary row chained to the original via
// parentItineraryId so the full revision history is queryable.
//
// Customer-facing share creates a shareToken (random URL slug) the
// itinerary's PDF link uses. The actual PDF rendering hooks into the
// existing pdfRenderer pattern in a follow-up — for now the endpoint
// returns the share URL + token (back-compat with frontend's existing
// /api/travel/itineraries/:id/share contract from PRD §6.1).

// PRD §4.6 — auto-create WebCheckin rows for every flight item on an
// accepted itinerary. Best-effort: failures log + don't block the
// accept (the operator's primary action — confirming the booking —
// must always succeed). Cron sweeps the created rows at T-window
// per airline.
//
// detailsJson on a flight item needs { pnr, flightNumber, departureAt };
// items missing those fields skip silently. The operator can still
// manually POST /api/travel/webcheckins to fill the gap.
//
// Exported for unit-test reach; not used by anything outside this file
// in production.
async function autoCreateWebCheckinsForItinerary(itineraryId, tenantId) {
  const flightItems = await prisma.itineraryItem.findMany({
    where: { itineraryId, itemType: "flight" },
  });
  if (flightItems.length === 0) return { created: 0, skipped: 0 };

  const itinFull = await prisma.itinerary.findUnique({
    where: { id: itineraryId },
    select: { contactId: true, tenantId: true },
  });
  if (!itinFull || itinFull.tenantId !== tenantId) {
    // Defensive — should never trip since the caller already guarded.
    return { created: 0, skipped: flightItems.length };
  }
  // Itinerary has contactId (Int FK) but no `contact` relation pointing
  // back to Contact, so we resolve the passenger-name fallback via a
  // second findUnique on Contact. The first commit (9898e87) tried to
  // join via `select: { contact: { … } }` which Prisma rejected with
  // "Unknown field `contact`" — fix in 01bb911's follow-up.
  const fallbackContact = await prisma.contact.findUnique({
    where: { id: itinFull.contactId },
    select: { name: true },
  });

  let created = 0;
  let skipped = 0;
  for (const item of flightItems) {
    let details = {};
    try { details = JSON.parse(item.detailsJson || "{}"); } catch { /* malformed → skip */ }
    if (!details.pnr || !details.flightNumber || !details.departureAt) {
      skipped++;
      continue;
    }
    const airlineCode = String(
      details.airlineCode
        || (typeof details.flightNumber === "string"
          && details.flightNumber.match(/^[A-Z0-9]{2}/)?.[0])
        || "",
    ).toUpperCase();
    const dep = new Date(details.departureAt);
    if (!Number.isFinite(dep.getTime())) {
      skipped++;
      continue;
    }
    const windowOpenAt = computeWindowOpenAt(dep, airlineCode);
    try {
      await prisma.webCheckin.create({
        data: {
          tenantId: itinFull.tenantId,
          contactId: itinFull.contactId,
          itineraryId,
          pnr: String(details.pnr),
          airlineCode,
          flightNumber: String(details.flightNumber),
          departureAt: dep,
          windowOpenAt: windowOpenAt || dep,
          passengerName: details.passengerName || fallbackContact?.name || "Passenger",
          seatPref: details.seatPref || null,
          mealPref: details.mealPref || null,
          status: "pending",
        },
      });
      created++;
    } catch (e) {
      console.error(
        `[travel-itin] webcheckin auto-create for itinerary ${itineraryId} ` +
          `(PNR ${details.pnr}) failed (non-fatal):`,
        e.message,
      );
      skipped++;
    }
  }
  return { created, skipped };
}

// POST /api/travel/itineraries/:id/accept
//
// Marks the itinerary as customer-accepted (terminal status). Refuses
// if already accepted or rejected — explicit re-statuses require a new
// version via PUT.
//
// Side-effect: fans out one WebCheckin row per flight ItineraryItem
// (PRD §4.6). Fan-out runs AFTER the response is sent so the
// operator's HTTP turnaround stays fast and any auto-create failure
// can't block the primary accept action. Errors log only.
router.post("/itineraries/:id/accept", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const full = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      select: { id: true, status: true },
    });
    if (full.status === "accepted") {
      return res.status(409).json({ error: "Itinerary already accepted", code: "ALREADY_ACCEPTED" });
    }
    if (full.status === "rejected") {
      return res.status(409).json({
        error: "Itinerary was rejected — create a new version via PUT to accept",
        code: "ALREADY_REJECTED",
      });
    }
    const updated = await prisma.itinerary.update({
      where: { id: itin.id },
      data: { status: "accepted" },
    });

    // PRD §4.6 WebCheckin fan-out. Originally fire-and-forget (commit
    // 9898e87) — switched to AWAIT after the deploy gate caught a CI race:
    // shared-infra latency stretched the post-response create past the
    // spec's 5s polling window, making the contract impossible to pin.
    // Awaiting adds ~50-100ms to the operator's /accept turnaround (one
    // findMany + 1-N create calls scoped to flight items only) — a
    // worthwhile trade for the deterministic post-accept invariant
    // "all flight items have a corresponding WebCheckin row".
    //
    // Wrapping in a separate try/catch so a fan-out failure DOES NOT
    // roll back the accept itself (operator's primary action wins).
    // We log the failure + return the accepted itinerary; the cron can
    // sweep + the operator can manually create the missing row later.
    try {
      await autoCreateWebCheckinsForItinerary(itin.id, req.travelTenant.id);
    } catch (e) {
      console.error("[travel-itin] webcheckin auto-create error (non-fatal):", e.message);
    }

    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] accept error:", e.message);
    res.status(500).json({ error: "Failed to accept itinerary" });
  }
});

// POST /api/travel/itineraries/:id/reject
//
// Body: { reason?: string } — optional rejection reason stored on the
// row (reuses pricingJson? no, that's pricing). We add the reason to a
// new column? No — keep it simple, store under `pricingJson` would be
// wrong. The schema doesn't have a rejectionReason field; the reason
// goes into an audit log entry if needed. For now the endpoint just
// flips status — reason is logged but not persisted on the row.
router.post("/itineraries/:id/reject", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const full = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      select: { id: true, status: true },
    });
    if (full.status === "accepted") {
      return res.status(409).json({
        error: "Itinerary was accepted — create a new version via PUT to reject",
        code: "ALREADY_ACCEPTED",
      });
    }
    if (full.status === "rejected") {
      return res.status(409).json({ error: "Itinerary already rejected", code: "ALREADY_REJECTED" });
    }
    const { reason } = req.body || {};
    if (reason) {
      console.log(`[travel-itin] itinerary ${itin.id} rejected — reason: ${String(reason).slice(0, 200)}`);
    }
    const updated = await prisma.itinerary.update({
      where: { id: itin.id },
      data: { status: "rejected" },
    });
    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] reject error:", e.message);
    res.status(500).json({ error: "Failed to reject itinerary" });
  }
});

// PUT /api/travel/itineraries/:id
//
// Per PRD §6.1: "PUT creates new version, links via parentItineraryId."
// This is the "revised" path — the customer pushed back, we recompute
// with a new structure, and ship a new row in the chain. The original
// row is preserved verbatim (history); the new row carries
// parentItineraryId=<originalId>, version=N+1.
router.put("/itineraries/:id", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const original = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
    });
    if (!original) return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });

    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, original.subBrand)) {
      return res.status(403).json({ error: "Sub-brand access denied", code: "SUB_BRAND_DENIED" });
    }

    const {
      destination, startDate, endDate,
      pricingJson, totalAmount, currency, items,
    } = req.body || {};

    // Find the highest version in the chain so we can increment.
    const chainRoot = original.parentItineraryId || original.id;
    const latest = await prisma.itinerary.findFirst({
      where: {
        tenantId: req.travelTenant.id,
        OR: [{ id: chainRoot }, { parentItineraryId: chainRoot }],
      },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const nextVersion = (latest?.version || 1) + 1;

    // Validate item shapes the same way POST does. Inline here to keep
    // imports contained — the assertValidItemType helper is already in
    // scope at the top of the file.
    const itemRows = [];
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || typeof it !== "object") continue;
        if (!it.itemType || !it.description) {
          return res.status(400).json({
            error: `items[${i}]: itemType + description required`,
            code: "ITEM_MISSING_FIELDS",
          });
        }
        assertValidItemType(it.itemType);
        itemRows.push({
          itemType: it.itemType,
          position: typeof it.position === "number" ? it.position : i,
          description: String(it.description),
          detailsJson: it.detailsJson ? String(it.detailsJson) : null,
          supplierId: it.supplierId ? parseInt(it.supplierId, 10) : null,
          unitCost: it.unitCost != null ? Number(it.unitCost) : null,
          markup: it.markup != null ? Number(it.markup) : null,
          gstAmount: it.gstAmount != null ? Number(it.gstAmount) : null,
          totalPrice: it.totalPrice != null ? Number(it.totalPrice) : null,
        });
      }
    }

    const newItin = await prisma.itinerary.create({
      data: {
        tenantId: req.travelTenant.id,
        subBrand: original.subBrand,
        contactId: original.contactId,
        leadId: original.leadId,
        status: "revised",
        version: nextVersion,
        parentItineraryId: chainRoot,
        destination: destination != null ? String(destination) : original.destination,
        startDate: startDate ? new Date(startDate) : original.startDate,
        endDate: endDate ? new Date(endDate) : original.endDate,
        pricingJson: pricingJson != null ? String(pricingJson) : original.pricingJson,
        totalAmount: totalAmount != null ? Number(totalAmount) : original.totalAmount,
        currency: currency || original.currency,
        items: itemRows.length > 0 ? { create: itemRows } : undefined,
      },
      include: { items: { orderBy: { position: "asc" } } },
    });
    res.status(201).json(newItin);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] put error:", e.message);
    res.status(500).json({ error: "Failed to revise itinerary" });
  }
});

// POST /api/travel/itineraries/:id/share
//
// Mints a shareToken (random URL-safe slug) and returns the share URL
// the advisor pastes into WhatsApp/email. Idempotent: re-calling on an
// itinerary that already has a shareToken returns the existing one
// rather than minting a new one (so old WhatsApp links keep working).
router.post("/itineraries/:id/share", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);

    // Re-fetch with the columns we need. loadItineraryWithGuard's select is
    // narrow (id + subBrand); we want shareToken here too.
    const full = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      select: { id: true, shareToken: true },
    });
    if (!full) {
      // Belt-and-braces — loadItineraryWithGuard just succeeded, so this
      // would only fire under a concurrent delete. Surface clearly.
      return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    }

    let token = full.shareToken;
    if (!token) {
      // 32-char random → base64url. crypto already required at the top.
      token = crypto.randomBytes(24).toString("base64url");
      await prisma.itinerary.update({
        where: { id: full.id },
        data: { shareToken: token },
      });
    }

    const portalBase = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";
    const shareUrl = `${portalBase}/p/itinerary/${token}`;
    res.json({ shareToken: token, shareUrl });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    if (e.code === "P2002") {
      // Extremely unlikely with 24 random bytes — surface as 409.
      return res.status(409).json({ error: "shareToken collision — retry", code: "DUPLICATE_SHARE_TOKEN" });
    }
    // Log the full stack so a future gate failure has more than e.message
    // to work with — the prior commit's catch only logged the message and
    // we couldn't see what threw.
    console.error("[travel-itin] share error:", e.message, "\nstack:", e.stack);
    res.status(500).json({ error: "Failed to mint share token", code: "SHARE_FAILED" });
  }
});

// GET /api/travel/itineraries/:id/pdf
//
// Streams a branded itinerary PDF (PRD §6.1). Sub-brand header band,
// trip summary, items table with unit-cost / markup / total, grand
// total band. Uses the existing renderTravelItineraryPdf in
// services/pdfRenderer.js (mirrors the v3.9.2 diagnostic PDF pattern).
//
// Tenant + sub-brand access enforced via loadItineraryWithGuard — same
// access discipline as every other /itineraries/:id endpoint.
router.get("/itineraries/:id/pdf", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const full = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      include: { items: { orderBy: { position: "asc" } } },
    });
    if (!full) {
      return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    }
    const contact = full.contactId
      ? await prisma.contact.findUnique({
          where: { id: full.contactId },
          select: { name: true, email: true, phone: true },
        })
      : { name: "Customer", email: null, phone: null };
    const pdfBuf = await renderTravelItineraryPdf(full, contact);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="itinerary-${full.id}-v${full.version || 1}.pdf"`,
    );
    res.setHeader("Content-Length", pdfBuf.length);
    res.send(pdfBuf);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] pdf error:", e.message, "\nstack:", e.stack);
    res.status(500).json({ error: "Failed to render itinerary PDF", code: "PDF_FAILED" });
  }
});

// ─── PUBLIC ENDPOINTS (no auth) — Phase 2 50%-advance booking (PRD §4.7) ──
//
// Lead receives a `shareToken` URL from the advisor (WhatsApp / email)
// and views their itinerary + pays the 50% deposit without logging in.
//
// Allowlisted in server.js openPaths under `/travel/itineraries/public`.
// shareToken is a 128-bit random slug (crypto.randomUUID() or 32-hex byte
// stream depending on caller) and @@unique on the schema — sufficient
// access control for a "share by link" surface, same model as the TMC
// microsite publicUuid pattern.
//
// What's intentionally NOT exposed:
//   - tenant id (only the slug-friendly tenant name)
//   - contactId / leadId
//   - cost / supplier / markup detail on items (only totalPrice +
//     human-readable description)
//   - portalPasswordHash and other PII (already scrubbed globally by
//     scrubResponse middleware)

// Strip an itinerary item to its public-safe projection.
function publicItemProjection(item) {
  return {
    id: item.id,
    itemType: item.itemType,
    position: item.position,
    description: item.description,
    detailsJson: item.detailsJson, // already curated by the advisor; advisor controls what lands here
    totalPrice: item.totalPrice,
  };
}

// GET /api/travel/itineraries/public/:shareToken
//
// Public read-only fetch by share token. Returns the customer-facing
// view of the itinerary including the 50%-advance summary so the
// payment widget can render the right amount.
router.get("/itineraries/public/:shareToken", async (req, res) => {
  try {
    const token = String(req.params.shareToken || "");
    if (!token || token.length < 16) {
      return res.status(400).json({ error: "shareToken required", code: "MISSING_TOKEN" });
    }
    const itin = await prisma.itinerary.findUnique({
      where: { shareToken: token },
      include: { items: { orderBy: { position: "asc" } }, tenant: { select: { name: true, slug: true } } },
    });
    if (!itin) {
      return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    }
    // Only advisor-completed itineraries (status >= sent) are publicly
    // viewable. A draft is internal work-in-progress; surfacing it would
    // be confusing for the lead.
    if (itin.status === "draft") {
      return res.status(404).json({ error: "Itinerary not yet shared", code: "NOT_SHARED" });
    }
    const total = itin.totalAmount ? Number(itin.totalAmount) : 0;
    const advanceRatio = await getTravelAdvanceRatio(prisma, itin.tenantId, itin.subBrand);
    const advanceDue = total > 0 ? Math.round(total * advanceRatio * 100) / 100 : 0;
    const advancePaid = itin.advancePaidAmount ? Number(itin.advancePaidAmount) : 0;
    const balanceDue = Math.max(0, total - advancePaid);
    res.json({
      shareToken: itin.shareToken,
      tenantName: itin.tenant?.name || null,
      tenantSlug: itin.tenant?.slug || null,
      subBrand: itin.subBrand,
      destination: itin.destination,
      startDate: itin.startDate,
      endDate: itin.endDate,
      status: itin.status,
      totalAmount: total,
      currency: itin.currency,
      advanceRatio,
      advanceDue,
      advancePaid,
      advancePaidAt: itin.advancePaidAt,
      balanceDue,
      items: itin.items.map(publicItemProjection),
      pdfUrl: itin.pdfUrl,
    });
  } catch (e) {
    console.error("[travel-itin-public] get error:", e.message);
    res.status(500).json({ error: "Failed to load itinerary" });
  }
});

// POST /api/travel/itineraries/public/:shareToken/record-advance-payment
//
// Phase 2 demo-mode endpoint: records that an advance payment has
// cleared. In production this will be hit by the payment gateway's
// webhook (Razorpay/Stripe) after a successful charge — the body
// fields map directly to gateway webhook payloads. Until those creds
// land (Q9 + payment-provider track) the endpoint accepts the values
// directly so the booking flow is operable end-to-end in demo/sandbox.
//
// Idempotent on paymentReference: re-submitting the same reference
// no-ops with a 200 + the existing state (gateway webhooks retry).
router.post("/itineraries/public/:shareToken/record-advance-payment", async (req, res) => {
  try {
    const token = String(req.params.shareToken || "");
    if (!token || token.length < 16) {
      return res.status(400).json({ error: "shareToken required", code: "MISSING_TOKEN" });
    }
    const { amount, paymentReference } = req.body || {};
    if (amount == null || !paymentReference) {
      return res.status(400).json({
        error: "amount and paymentReference required",
        code: "MISSING_FIELDS",
      });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "amount must be positive", code: "INVALID_AMOUNT" });
    }

    const itin = await prisma.itinerary.findUnique({ where: { shareToken: token } });
    if (!itin) {
      return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    }
    if (itin.status === "draft") {
      return res.status(409).json({ error: "Itinerary not yet shared", code: "NOT_SHARED" });
    }
    if (itin.status === "rejected" || itin.status === "fully_paid") {
      return res.status(409).json({
        error: `Cannot record advance against an itinerary in '${itin.status}' status`,
        code: "INVALID_STATE",
      });
    }

    // Idempotent webhook re-delivery: same paymentReference → just return
    // current state without mutating. Gateways re-fire on 5xx → idempotency
    // prevents double-counting advances.
    if (itin.paymentReference === String(paymentReference)) {
      return res.json({
        status: itin.status,
        advancePaidAmount: itin.advancePaidAmount ? Number(itin.advancePaidAmount) : 0,
        advancePaidAt: itin.advancePaidAt,
        paymentReference: itin.paymentReference,
        idempotent: true,
      });
    }

    const total = itin.totalAmount ? Number(itin.totalAmount) : 0;
    const newAdvanceTotal = Number(itin.advancePaidAmount || 0) + amt;
    // If the new running total equals or exceeds the trip total, mark
    // fully_paid; otherwise advance_paid. Floating-point tolerance is
    // 1 paisa (0.01) since totalAmount is stored as Decimal(15,2).
    const nextStatus = total > 0 && newAdvanceTotal + 0.01 >= total ? "fully_paid" : "advance_paid";

    const updated = await prisma.itinerary.update({
      where: { id: itin.id },
      data: {
        status: nextStatus,
        advancePaidAmount: newAdvanceTotal,
        advancePaidAt: new Date(),
        paymentReference: String(paymentReference),
      },
    });

    res.status(201).json({
      status: updated.status,
      advancePaidAmount: Number(updated.advancePaidAmount),
      advancePaidAt: updated.advancePaidAt,
      paymentReference: updated.paymentReference,
      balanceDue: Math.max(0, total - Number(updated.advancePaidAmount)),
    });
  } catch (e) {
    console.error("[travel-itin-public] record-advance error:", e.message);
    res.status(500).json({ error: "Failed to record advance" });
  }
});

module.exports = router;
