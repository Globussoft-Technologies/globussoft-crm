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
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const prisma = require("../lib/prisma");
const {
  requireTravelTenant,
  getSubBrandAccessSet,
  canAccessSubBrand,
  assertValidSubBrand,
  assertCompletedDiagnostic,
} = require("../middleware/travelGuards");

const VALID_ITEM_TYPES = ["flight", "hotel", "transfer", "activity", "visa", "insurance"];
const VALID_STATUSES = ["draft", "sent", "revised", "accepted", "rejected"];

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
      items,
    } = req.body;

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

module.exports = router;
