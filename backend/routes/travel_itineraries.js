// Travel CRM — Itinerary CRUD routes (Phase 1).
//
// Endpoints:
//   GET    /api/travel/itineraries                          — list (paginated, filterable)
//   POST   /api/travel/itineraries                          — create itinerary (+ optional items)
//   GET    /api/travel/itineraries/:id                      — fetch one with items
//   PATCH  /api/travel/itineraries/:id                      — amend top-level fields (not items)
//   POST   /api/travel/itineraries/:id/items                — append a polymorphic item
//   POST   /api/travel/itineraries/:id/items/bulk-reorder   — atomic bulk reposition (#907 slice 8)
//   POST   /api/travel/itineraries/:id/items/bulk-delete    — atomic bulk delete (#907 slice 11)
//   GET    /api/travel/itineraries/:id/items/search         — item notes search/filter (#907 slice 10)
//   PATCH  /api/travel/itineraries/:id/items/:itemId        — amend an item
//   DELETE /api/travel/itineraries/:id/items/:itemId        — remove an item
//   POST   /api/travel/itineraries/:id/draft/regen          — regen LLM-drafted summary (PRD §4.3 + §9.1)
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
const { resolveForSubBrand } = require("../lib/subBrandConfig");
const llmRouter = require("../lib/llmRouter");
const { computeDayCosts } = require("../lib/itineraryDayCostCalculator");

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

// POST /api/travel/itineraries/:id/items/bulk-reorder
//
// #907 slice 8 — atomic bulk reposition of multiple ItineraryItem rows
// in a single call. Visual editor (PRD §3.3) drags items across days; a
// single drag operation can touch up to N items (renumber positions
// within a day, optionally move across day-offsets). Without this
// primitive, the editor would have to issue N PATCH calls — non-atomic
// (partial-failure leaves items in inconsistent order) and chatty.
//
// Body shape:
//   { updates: [ { itemId, position, dayOffset? }, ... ] }
//
// Semantics:
//   - `position`     required per update (integer ≥ 0). Final position
//                    after the bulk write — collisions are the operator's
//                    responsibility; route does not auto-densify.
//   - `dayOffset`    optional per update (non-negative integer). When
//                    present, merges into the item's detailsJson under
//                    key `dayOffset` (slice-2 convention). All other
//                    detailsJson keys preserved; stale `dayNumber` key
//                    removed to avoid dual-source confusion (mirrors the
//                    clone-day endpoint's normalisation).
//   - Atomic via prisma.$transaction — all updates land together or none
//     do.
//   - Hard cap of 200 updates per call (runaway-payload guard).
//   - All itemIds must belong to the target itinerary; cross-itinerary
//     ids → 400 ITEM_NOT_IN_ITINERARY with the offending id list.
//   - Duplicate itemIds in the updates list → 400 DUPLICATE_ITEM_ID.
//
// Response: { updatedCount, items: [...] } where items reflect post-
// update state sorted by position asc — convenient for the editor to
// re-render without a follow-up GET.
//
// Sub-paths BEFORE /:id per Express ordering convention.
router.post(
  "/itineraries/:id/items/bulk-reorder",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);
      const { updates } = req.body || {};

      if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({
          error: "updates must be a non-empty array",
          code: "EMPTY_UPDATES",
        });
      }
      if (updates.length > 200) {
        return res.status(400).json({
          error: "updates capped at 200 per call",
          code: "TOO_MANY_UPDATES",
        });
      }

      // Validate each update + detect dupes.
      const itemIds = [];
      const seenIds = new Set();
      for (const upd of updates) {
        const itemId = parseInt(upd?.itemId, 10);
        if (!Number.isFinite(itemId)) {
          return res.status(400).json({
            error: "each update needs a numeric itemId",
            code: "INVALID_ITEM_ID",
          });
        }
        if (seenIds.has(itemId)) {
          return res.status(400).json({
            error: `itemId ${itemId} appears more than once in updates`,
            code: "DUPLICATE_ITEM_ID",
            itemId,
          });
        }
        seenIds.add(itemId);
        const pos = Number(upd.position);
        if (!Number.isInteger(pos) || pos < 0) {
          return res.status(400).json({
            error: "each update needs an integer position ≥ 0",
            code: "INVALID_POSITION",
            itemId,
          });
        }
        if (upd.dayOffset !== undefined) {
          const d = Number(upd.dayOffset);
          if (!Number.isInteger(d) || d < 0) {
            return res.status(400).json({
              error: "dayOffset must be a non-negative integer when supplied",
              code: "INVALID_DAY_OFFSET",
              itemId,
            });
          }
        }
        itemIds.push(itemId);
      }

      // Fetch current rows; verify all belong to target itinerary.
      const existing = await prisma.itineraryItem.findMany({
        where: { id: { in: itemIds }, itineraryId: itin.id },
        select: { id: true, detailsJson: true },
      });
      if (existing.length !== itemIds.length) {
        const foundIds = new Set(existing.map((r) => r.id));
        const missing = itemIds.filter((id) => !foundIds.has(id));
        return res.status(400).json({
          error: "one or more itemIds do not belong to this itinerary",
          code: "ITEM_NOT_IN_ITINERARY",
          missing,
        });
      }

      // Map current detailsJson by itemId for the dayOffset merge.
      const existingById = new Map(existing.map((r) => [r.id, r]));

      // Build prisma update ops; run as a single transaction.
      const ops = updates.map((upd) => {
        const itemId = parseInt(upd.itemId, 10);
        const data = { position: Number(upd.position) };
        if (upd.dayOffset !== undefined) {
          // Merge into detailsJson; preserve other keys; drop stale dayNumber.
          let details = {};
          try {
            const raw = existingById.get(itemId)?.detailsJson;
            details = raw ? JSON.parse(raw) : {};
          } catch {
            details = {};
          }
          details.dayOffset = Number(upd.dayOffset);
          delete details.dayNumber;
          data.detailsJson = JSON.stringify(details);
        }
        return prisma.itineraryItem.update({ where: { id: itemId }, data });
      });

      await prisma.$transaction(ops);

      // Re-fetch post-update so callers get the canonical row ordering.
      const refreshed = await prisma.itineraryItem.findMany({
        where: { id: { in: itemIds }, itineraryId: itin.id },
        orderBy: { position: "asc" },
      });

      res.json({ updatedCount: refreshed.length, items: refreshed });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] bulk-reorder error:", e.message);
      res.status(500).json({ error: "Failed to bulk-reorder items" });
    }
  },
);

// POST /api/travel/itineraries/:id/items/bulk-delete
//
// #907 slice 11 — atomic bulk delete of multiple ItineraryItem rows in a
// single call. Visual editor (PRD §3.3) operator workflow includes "delete
// all items on day N" (collapse-day) and "remove selected items"
// (multi-select bulk-delete) primitives; without a bulk-delete endpoint
// the editor must issue N DELETE calls — non-atomic (partial failure
// leaves the itinerary in a torn state where the operator can't tell
// which items survived) and chatty.
//
// Body shape:
//   { itemIds: [1, 2, 3, ...] }
//
// Semantics:
//   - itemIds required (non-empty integer array, each ≥ 0).
//   - All itemIds must belong to the target itinerary; cross-itinerary
//     ids → 400 ITEM_NOT_IN_ITINERARY with the offending id list.
//   - Atomic via prisma.itineraryItem.deleteMany — backed by a single
//     SQL DELETE; all rows removed together or none.
//   - Hard cap of 200 ids per call (runaway-payload guard — matches
//     bulk-reorder's cap so the operator's bulk-select UX has a single
//     consistent ceiling).
//   - Duplicate itemIds in the input list → 400 DUPLICATE_ITEM_ID. The
//     operator's editor should de-dupe before submitting; surfacing the
//     dupe explicitly catches client-side bugs early rather than
//     silently accepting a noisy payload.
//
// Response: { deletedCount, deletedIds } — deletedIds reflects the
// canonical id set that was just removed (sorted asc for stable
// caller-side assertions). No `items` echo because the rows no longer
// exist; the caller is expected to refetch the itinerary list if it
// needs the post-delete state.
//
// Sub-paths BEFORE /:id per Express ordering convention.
router.post(
  "/itineraries/:id/items/bulk-delete",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);
      const { itemIds } = req.body || {};

      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        return res.status(400).json({
          error: "itemIds must be a non-empty array",
          code: "EMPTY_ITEM_IDS",
        });
      }
      if (itemIds.length > 200) {
        return res.status(400).json({
          error: "itemIds capped at 200 per call",
          code: "TOO_MANY_ITEM_IDS",
        });
      }

      // Validate each id is a non-negative integer + detect dupes.
      const parsedIds = [];
      const seenIds = new Set();
      for (const raw of itemIds) {
        const itemId = parseInt(raw, 10);
        if (!Number.isInteger(itemId) || itemId < 0) {
          return res.status(400).json({
            error: "each itemId must be a non-negative integer",
            code: "INVALID_ITEM_ID",
          });
        }
        if (seenIds.has(itemId)) {
          return res.status(400).json({
            error: `itemId ${itemId} appears more than once in itemIds`,
            code: "DUPLICATE_ITEM_ID",
            itemId,
          });
        }
        seenIds.add(itemId);
        parsedIds.push(itemId);
      }

      // Verify every id belongs to the target itinerary BEFORE deleting.
      // A blind deleteMany scoped on itineraryId would silently swallow
      // unknown / cross-itinerary ids (returns count 0 for missing rows),
      // hiding caller-side bugs. Explicit pre-flight makes the contract
      // strict: partial set → 400, all-present → atomic delete.
      const existing = await prisma.itineraryItem.findMany({
        where: { id: { in: parsedIds }, itineraryId: itin.id },
        select: { id: true },
      });
      if (existing.length !== parsedIds.length) {
        const foundIds = new Set(existing.map((r) => r.id));
        const missing = parsedIds.filter((id) => !foundIds.has(id));
        return res.status(400).json({
          error: "one or more itemIds do not belong to this itinerary",
          code: "ITEM_NOT_IN_ITINERARY",
          missing,
        });
      }

      const result = await prisma.itineraryItem.deleteMany({
        where: { id: { in: parsedIds }, itineraryId: itin.id },
      });

      // deletedIds sorted asc for stable caller-side assertion shape.
      const deletedIds = [...parsedIds].sort((a, b) => a - b);
      res.json({ deletedCount: result.count, deletedIds });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] bulk-delete error:", e.message);
      res.status(500).json({ error: "Failed to bulk-delete items" });
    }
  },
);

// ─── Items search / filter (#907 slice 10) ───────────────────────────
//
// GET /api/travel/itineraries/:id/items/search?q=<term>&itemType=<t>&dayOffset=<n>
//
// Operator-facing search across an itinerary's items. RFU 14N Umrah and
// TMC 12N Europe packages routinely carry 50-100 items spread across many
// days; locating a specific note ("vegetarian only", "Madinah 3-min walk")
// by scrolling is painful. This endpoint searches case-insensitively
// across description + notes-friendly keys inside detailsJson (notes,
// specialRequests, dietaryNotes, mobility) and returns matches with a
// short snippet + the matched-field list.
//
// Query params:
//   q          required, ≥2 chars after trim; substring case-insensitive.
//   itemType   optional; must be one of VALID_ITEM_TYPES if provided.
//   dayOffset  optional; non-negative integer; filters via
//              detailsJson.dayOffset (preferred) or (detailsJson.dayNumber - 1)
//              fallback (slice-2 convention).
//
// Response:
//   {
//     itineraryId, query, itemType, dayOffset,  // echoed inputs
//     matchCount,
//     items: [{
//       id, itemType, position, description, dayOffset,
//       matchedFields: ["description"|"notes"|"specialRequests"|"dietaryNotes"|"mobility", ...],
//       snippet,   // first ~80 chars surrounding the first match
//     }, ...]
//   }
//
// Express ordering: this sub-path sits BEFORE the PATCH/DELETE
// /:id/items/:itemId verbs (different methods + the /:itemId param could
// otherwise match "search" — but verb mismatch makes the collision moot).
//
// Tenant + sub-brand guard via loadItineraryWithGuard (mirrors slices
// 2/5/6/7/8/9). Read-only — no audit log, no eventBus emit.
//
// PRD: docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §3 (item search/filter
// candidate).
router.get(
  "/itineraries/:id/items/search",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);

      const qRaw = typeof req.query.q === "string" ? req.query.q : "";
      const q = qRaw.trim();
      if (q.length < 2) {
        return res.status(400).json({
          error: "q is required and must be at least 2 chars after trim",
          code: "INVALID_QUERY",
        });
      }

      let itemTypeFilter = null;
      if (req.query.itemType != null && req.query.itemType !== "") {
        if (!VALID_ITEM_TYPES.includes(req.query.itemType)) {
          return res.status(400).json({
            error: `itemType must be one of: ${VALID_ITEM_TYPES.join(", ")}`,
            code: "INVALID_ITEM_TYPE",
          });
        }
        itemTypeFilter = req.query.itemType;
      }

      let dayOffsetFilter = null;
      if (req.query.dayOffset != null && req.query.dayOffset !== "") {
        const n = parseInt(req.query.dayOffset, 10);
        if (!Number.isFinite(n) || n < 0 || String(n) !== String(req.query.dayOffset)) {
          return res.status(400).json({
            error: "dayOffset must be a non-negative integer",
            code: "INVALID_DAY_OFFSET",
          });
        }
        dayOffsetFilter = n;
      }

      const where = { itineraryId: itin.id };
      if (itemTypeFilter) where.itemType = itemTypeFilter;
      const rows = await prisma.itineraryItem.findMany({
        where,
        orderBy: { position: "asc" },
      });

      const NOTE_KEYS = ["notes", "specialRequests", "dietaryNotes", "mobility"];
      const needle = q.toLowerCase();

      function resolveDayOffset(details) {
        if (!details || typeof details !== "object") return null;
        if (typeof details.dayOffset === "number") return details.dayOffset;
        if (typeof details.dayNumber === "number") return details.dayNumber - 1;
        return null;
      }

      function makeSnippet(text) {
        const lower = String(text).toLowerCase();
        const idx = lower.indexOf(needle);
        if (idx < 0) return String(text).slice(0, 80);
        const start = Math.max(0, idx - 30);
        const end = Math.min(String(text).length, idx + needle.length + 30);
        const prefix = start > 0 ? "…" : "";
        const suffix = end < String(text).length ? "…" : "";
        return prefix + String(text).slice(start, end) + suffix;
      }

      const matches = [];
      for (const row of rows) {
        let details = null;
        if (row.detailsJson) {
          try { details = JSON.parse(row.detailsJson); } catch { details = null; }
        }

        const rowDayOffset = resolveDayOffset(details);
        if (dayOffsetFilter !== null && rowDayOffset !== dayOffsetFilter) continue;

        const matchedFields = [];
        let firstHitText = null;

        if (row.description && row.description.toLowerCase().includes(needle)) {
          matchedFields.push("description");
          firstHitText = row.description;
        }
        if (details && typeof details === "object") {
          for (const key of NOTE_KEYS) {
            const val = details[key];
            if (typeof val === "string" && val.toLowerCase().includes(needle)) {
              matchedFields.push(key);
              if (firstHitText === null) firstHitText = val;
            }
          }
        }

        if (matchedFields.length === 0) continue;

        matches.push({
          id: row.id,
          itemType: row.itemType,
          position: row.position,
          description: row.description,
          dayOffset: rowDayOffset,
          matchedFields,
          snippet: firstHitText !== null ? makeSnippet(firstHitText) : null,
        });
      }

      res.json({
        itineraryId: itin.id,
        query: q,
        itemType: itemTypeFilter,
        dayOffset: dayOffsetFilter,
        matchCount: matches.length,
        items: matches,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] items search error:", e.message);
      res.status(500).json({ error: "Failed to search items" });
    }
  },
);

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

    // #929 Part B — fire-and-forget webhook emission on customer accept.
    // Subscribers (Callified.ai, partner SaaSes) can trigger downstream
    // booking workflows (supplier PO creation, payment-request issuance,
    // arrival pre-checks) without polling. Uses shared safeEmitEvent
    // helper (extracted to lib/eventBus.js tick #47).
    const { safeEmitEvent } = require("../lib/eventBus");
    safeEmitEvent(
      "itinerary.accepted",
      {
        id: updated.id,
        contactId: updated.contactId || null,
        tripId: updated.tripId || null,
        subBrand: updated.subBrand || null,
        totalAmount: updated.totalAmount || null,
        currency: updated.currency || null,
        tenantId: req.travelTenant.id,
        acceptedAt: new Date().toISOString(),
      },
      req.travelTenant.id,
      "travel-itin/accept",
    );

    res.json(updated);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] accept error:", e.message);
    res.status(500).json({ error: "Failed to accept itinerary" });
  }
});

// POST /api/travel/itineraries/:id/draft/regen
//
// PRD §4.3 + §9.1: regenerate the customer-facing draft summary block
// via the LLM router (bulk-text task class → Gemini Flash primary,
// Claude Haiku fallback per PRD §9.1's locked Q11 routing table). Third
// consumer of the lib/llmRouter.js scaffold (commit 583c06b) after
// talking-points (cf876af) and form-vs-call (4a7c623), and the FIRST
// non-Claude-Opus consumer — exercises the bulk-text → gemini-flash
// route per PRD §9.1. Until Q11 keys arrive the router returns
// deterministic [STUB-BULK-TEXT] synthetic text so the customer-facing
// PDF + share page can render SOMETHING and tests can pin the contract.
//
// ADMIN/MANAGER-gated: regenerating costs LLM tokens (in real mode) +
// surfaces a fresh block that propagates to the customer-facing share
// page; we don't want every USER firing it. USERs read the
// already-persisted summary via GET /itineraries/:id (draftSummary).
//
// Persists result.text to Itinerary.draftSummary so the next render
// serves the cached prose without re-billing the LLM. Operator-triggered
// only — DO NOT auto-trigger on itinerary create (respects LLM cost).
//
// PII discipline: contact name only — no email / phone / address in
// the payload. Mirrors the talking-points pattern. The router's own
// log line only emits token counts; don't add a console.log of
// `payload` here.
router.post(
  "/itineraries/:id/draft/regen",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  requireTravelTenant,
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);
      // Re-fetch with the columns the LLM payload needs.
      // loadItineraryWithGuard's select is narrow (id + subBrand).
      const full = await prisma.itinerary.findFirst({
        where: { id: itin.id, tenantId: req.travelTenant.id },
        include: { items: { orderBy: { position: "asc" } } },
      });
      if (!full) {
        // Belt-and-braces — loadItineraryWithGuard just succeeded, so
        // this should never fire. Defensive in case of a concurrent
        // delete between the two reads.
        return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
      }

      // Contact for prompt context (name only). Tolerant of
      // contact-not-found — draft still renders against the itinerary
      // structure alone, just without the recipient framing.
      const contact = full.contactId
        ? await prisma.contact.findFirst({
            where: { id: full.contactId, tenantId: req.travelTenant.id },
            select: { name: true },
          })
        : null;

      // PII-minimal payload — mirrors talking-points pattern. NO contact
      // email / phone / address. totalAmount sent as Number so the LLM
      // sees a clean numeric (Prisma returns Decimal as string).
      const payload = {
        subBrand: full.subBrand,
        destination: full.destination,
        startDate: full.startDate,
        endDate: full.endDate,
        totalAmount: full.totalAmount != null ? Number(full.totalAmount) : null,
        currency: full.currency,
        items: full.items.map((it) => ({
          itemType: it.itemType,
          description: it.description,
          totalPrice: it.totalPrice != null ? Number(it.totalPrice) : null,
        })),
        contact: {
          name: contact?.name || null,
        },
      };

      const result = await llmRouter.routeRequest({
        task: "bulk-text",
        payload,
        tenantId: req.travelTenant.id,
      });

      const generatedAt = new Date().toISOString();

      await prisma.itinerary.update({
        where: { id: full.id },
        data: { draftSummary: result.text },
      });

      res.status(201).json({
        id: full.id,
        draftSummary: result.text,
        model: result.model,
        stub: Boolean(result.stub),
        generatedAt,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] draft regen error:", e.message);
      res.status(500).json({ error: "Failed to regenerate draft summary" });
    }
  },
);

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
    // Q9 cut-over plumbing — resolve the per-sub-brand wabaId so when
    // Wati creds land, swapping the stub log for a real WhatsApp blast
    // is a 1-line change here. Today the dispatch is "advisor pastes
    // the URL into a chat manually"; tomorrow the resolved wabaId
    // routes the automated blast. requireTravelTenant doesn't include
    // subBrandConfigJson in its select, so we fetch it separately.
    const tenantCfgRow = await prisma.tenant.findUnique({
      where: { id: req.travelTenant.id },
      select: { subBrandConfigJson: true },
    });
    const cfg = resolveForSubBrand(tenantCfgRow, itin.subBrand);
    console.log(
      `[travel-itin] share token minted for itin ${full.id} (sub-brand=${itin.subBrand}) — ` +
        `would WhatsApp-blast via wabaId=${cfg.wabaId || "(no-config)"} pending Wati creds`,
    );
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
      // PRD §4.3 — operator-generated executive summary block (null
      // until first POST /draft/regen lands). Customer-facing share
      // page + PDF render conditionally on this field.
      draftSummary: itin.draftSummary,
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

// ─── Per-day cost aggregation (#907 slice 2) ────────────────────────
//
// GET /api/travel/itineraries/:id/day-costs
//
// Consumes lib/itineraryDayCostCalculator.js (slice 1, commit 3072e5bf).
// Loads the parent itinerary tenant-scoped + sub-brand-scoped, fetches its
// items, maps each ItineraryItem to the helper's expected shape
// ({ cost, itemType, dayOffset|dayNumber|date }) and returns the
// helper's `{ days, grandTotal, totalDays, averageDailyCost }` envelope.
//
// Day-source mapping (no native column on ItineraryItem — the source
// fields live inside the operator-supplied detailsJson payload):
//   - detailsJson.dayOffset  preferred (0-indexed from trip start)
//   - detailsJson.dayNumber  alternate (1-indexed)
//   - detailsJson.date       alternate (ISO; resolved against tripStart)
//
// tripStart precedence:
//   1. ?tripStart=ISODate query param (operator override)
//   2. itinerary.startDate
//   3. today UTC (helper default)
//
// Cost source per item: `totalPrice` preferred, falls back to `unitCost`.
// Items with neither resolved-day-source nor cost are still PASSED to the
// helper which skips them per its precedence rules (keeps the contract
// auditable from the helper side).
//
// Margin breakdown (#907 slice 5): each ItineraryItem row's `unitCost`,
// `markup`, and `gstAmount` flow through to the helper, which aggregates
// per-day `supplierCost` / `markupTotal` / `gstTotal` alongside the
// existing `totalCost`. Grand-totals mirror the per-day shape
// (`grandSupplierCost` / `grandMarkupTotal` / `grandGstTotal`) so the
// envelope carries a full-trip P&L without consumer re-summing.
router.get("/itineraries/:id/day-costs", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);
    const full = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      select: { id: true, startDate: true },
    });
    if (!full) {
      return res.status(404).json({ error: "Itinerary not found", code: "ITINERARY_NOT_FOUND" });
    }

    const items = await prisma.itineraryItem.findMany({
      where: { itineraryId: full.id },
      orderBy: { position: "asc" },
    });

    // Resolve tripStart per precedence rules above.
    let tripStart;
    if (req.query.tripStart) {
      const overrideDate = new Date(String(req.query.tripStart));
      if (Number.isFinite(overrideDate.getTime())) {
        tripStart = overrideDate;
      }
    }
    if (!tripStart && full.startDate) tripStart = new Date(full.startDate);

    // Map ItineraryItem rows → helper input shape. Day source comes from
    // detailsJson (parsed); customer-facing `cost` is totalPrice (falls
    // back to unitCost); per-line margin components flow through so the
    // helper can surface supplierCost / markupTotal / gstTotal per day
    // (#907 slice 5).
    const helperItems = items.map((row) => {
      let details = {};
      if (row.detailsJson) {
        try { details = JSON.parse(row.detailsJson); } catch { /* malformed → fall through */ }
      }
      const cost = row.totalPrice != null
        ? Number(row.totalPrice)
        : row.unitCost != null ? Number(row.unitCost) : 0;
      const mapped = {
        id: row.id,
        itemType: row.itemType,
        description: row.description,
        cost,
        unitCost: row.unitCost != null ? Number(row.unitCost) : null,
        markup: row.markup != null ? Number(row.markup) : 0,
        gstAmount: row.gstAmount != null ? Number(row.gstAmount) : 0,
      };
      if (typeof details.dayOffset === "number") mapped.dayOffset = details.dayOffset;
      else if (typeof details.dayNumber === "number") mapped.dayNumber = details.dayNumber;
      else if (details.date) mapped.date = details.date;
      return mapped;
    });

    const result = computeDayCosts(helperItems, tripStart ? { tripStart } : {});

    res.json({
      itineraryId: full.id,
      ...result,
    });
  } catch (e) {
    if (e.status) {
      // loadItineraryWithGuard surfaces NOT_FOUND for cross-tenant; rename
      // to ITINERARY_NOT_FOUND for this endpoint's contract.
      if (e.code === "NOT_FOUND") {
        return res.status(404).json({ error: "Itinerary not found", code: "ITINERARY_NOT_FOUND" });
      }
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    console.error("[travel-itin] day-costs error:", e.message);
    res.status(500).json({ error: "Failed to compute per-day costs" });
  }
});

// ─── Bulk-clone day across itineraries (#907 slice 6) ───────────────
//
// POST /api/travel/itineraries/:id/clone-day
// Body: { sourceItineraryId: Int, sourceDayOffset: Int, targetDayOffset: Int }
//
// Copies all ItineraryItem rows from the source itinerary's specified day
// into the receiving (path-param) itinerary's target day. Day-source
// resolution mirrors the day-costs endpoint convention (#907 slice 2):
// the day-source lives in each item's detailsJson (`dayOffset` preferred,
// `dayNumber` fallback). The cloned rows have their detailsJson rewritten
// with `dayOffset: targetDayOffset` so the new home is unambiguous.
//
// Position assignment: append after the target itinerary's current max
// position (same pattern as POST /items).
//
// Tenant + sub-brand guard: BOTH itineraries must belong to the requester's
// tenant; the operator must have sub-brand access to BOTH (source via
// SUB_BRAND_DENIED on source-load, target via loadItineraryWithGuard).
// Sub-brands are NOT required to match — an admin authoring across TMC and
// Travel Stall can lift a Day-3 sightseeing block from one and drop it on
// the other.
//
// Returns 201 + `{ clonedCount, items: [...] }` where items are the freshly
// created rows. clonedCount = 0 (with empty items array) when the source
// day has no matching items — not an error.
//
// Refs PRD docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §3 + §6.5.
router.post("/itineraries/:id/clone-day", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const target = await loadItineraryWithGuard(req);
    const { sourceItineraryId, sourceDayOffset, targetDayOffset } = req.body || {};

    const sourceId = parseInt(sourceItineraryId, 10);
    if (!Number.isFinite(sourceId)) {
      return res.status(400).json({
        error: "sourceItineraryId is required and must be numeric",
        code: "INVALID_SOURCE_ID",
      });
    }
    const srcDay = parseInt(sourceDayOffset, 10);
    const tgtDay = parseInt(targetDayOffset, 10);
    if (!Number.isFinite(srcDay) || srcDay < 0) {
      return res.status(400).json({
        error: "sourceDayOffset must be a non-negative integer",
        code: "INVALID_SOURCE_DAY",
      });
    }
    if (!Number.isFinite(tgtDay) || tgtDay < 0) {
      return res.status(400).json({
        error: "targetDayOffset must be a non-negative integer",
        code: "INVALID_TARGET_DAY",
      });
    }

    // Same-itinerary same-day clone would silently duplicate every line.
    // Reject explicitly to surface operator intent (vs typo).
    if (sourceId === target.id && srcDay === tgtDay) {
      return res.status(400).json({
        error: "source and target day are identical; use POST /items to duplicate",
        code: "SAME_DAY_CLONE",
      });
    }

    // Tenant-scope the source load. SUB_BRAND_DENIED check below.
    const source = await prisma.itinerary.findFirst({
      where: { id: sourceId, tenantId: req.travelTenant.id },
      select: { id: true, subBrand: true },
    });
    if (!source) {
      return res.status(404).json({
        error: "Source itinerary not found",
        code: "SOURCE_NOT_FOUND",
      });
    }
    const allowed = await getSubBrandAccessSet(req.user.userId);
    if (!canAccessSubBrand(allowed, source.subBrand)) {
      return res.status(403).json({
        error: "Sub-brand access denied for source itinerary",
        code: "SOURCE_SUB_BRAND_DENIED",
      });
    }

    // Pull all source items, filter to the requested source day via
    // detailsJson.dayOffset / dayNumber (#907 slice 2 convention).
    const sourceItems = await prisma.itineraryItem.findMany({
      where: { itineraryId: source.id },
      orderBy: { position: "asc" },
    });
    const matching = sourceItems.filter((row) => {
      if (!row.detailsJson) return false;
      let details;
      try { details = JSON.parse(row.detailsJson); } catch { return false; }
      if (typeof details.dayOffset === "number") return details.dayOffset === srcDay;
      if (typeof details.dayNumber === "number") return (details.dayNumber - 1) === srcDay;
      return false;
    });

    if (matching.length === 0) {
      return res.status(201).json({ clonedCount: 0, items: [] });
    }

    // Append after the target itinerary's current max position.
    const maxRow = await prisma.itineraryItem.findFirst({
      where: { itineraryId: target.id },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    let nextPos = (maxRow?.position ?? -1) + 1;

    const cloned = [];
    for (const row of matching) {
      // Rewrite detailsJson with the new dayOffset; preserve all other keys.
      let details = {};
      try { details = row.detailsJson ? JSON.parse(row.detailsJson) : {}; } catch { details = {}; }
      details.dayOffset = tgtDay;
      delete details.dayNumber; // avoid stale dual-source conflicts.

      const created = await prisma.itineraryItem.create({
        data: {
          itineraryId: target.id,
          itemType: row.itemType,
          position: nextPos++,
          description: row.description,
          detailsJson: JSON.stringify(details),
          supplierId: row.supplierId,
          unitCost: row.unitCost != null ? Number(row.unitCost) : null,
          markup: row.markup != null ? Number(row.markup) : null,
          gstAmount: row.gstAmount != null ? Number(row.gstAmount) : null,
          totalPrice: row.totalPrice != null ? Number(row.totalPrice) : null,
        },
      });
      cloned.push(created);
    }

    res.status(201).json({ clonedCount: cloned.length, items: cloned });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] clone-day error:", e.message);
    res.status(500).json({ error: "Failed to clone day" });
  }
});

// ─── Supplier-confirmation rollup (#907 slice 7) ─────────────────────
//
// GET /api/travel/itineraries/:id/supplier-rollup
//
// Operator-facing pre-PO view: "which suppliers are in this itinerary,
// and what do I need to confirm with each?" Aggregates ItineraryItem
// rows by supplierId. Items without supplierId fall into an `unassigned`
// bucket — surfaces gaps before the operator issues POs.
//
// Per-supplier rollup shape:
//   {
//     supplierId,           // null for unassigned bucket
//     supplierName,         // TravelSupplier.name; "Unassigned" for null
//     supplierCategory,     // hotel | flight | transport | visa-consul | other
//     contactPerson,        // free-form contact name (nullable)
//     phone, email,         // contact channels (nullable)
//     itemCount,            // number of ItineraryItem rows mapped to supplier
//     itemTypes,            // unique itemType strings ["hotel","transfer",...]
//     totalSupplierCost,    // sum(unitCost) — half-up to paise (2dp)
//     totalGst,             // sum(gstAmount)
//     totalSalePrice,       // sum(totalPrice)
//     marginTotal,          // totalSalePrice - totalSupplierCost - totalGst
//     marginPct,            // marginTotal / totalSalePrice * 100; null if sale=0
//     items: [{ id, itemType, description, unitCost, gstAmount, totalPrice }]
//   }
//
// Envelope:
//   { itineraryId, suppliers: [...], unassigned: {...} | null,
//     grandTotals: { supplierCost, gst, salePrice, marginTotal, marginPct },
//     supplierCount }
//
// Tenant + sub-brand guard via loadItineraryWithGuard (mirrors slices 2/5/6).
// Read-only — no audit log, no eventBus emit.
//
// Refs PRD docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §3 + §6 (operator
// "Confirmation pipe" workflow before PO issue).
router.get(
  "/itineraries/:id/supplier-rollup",
  verifyToken,
  requireTravelTenant,
  async (req, res) => {
    try {
      const itin = await loadItineraryWithGuard(req);

      const items = await prisma.itineraryItem.findMany({
        where: { itineraryId: itin.id },
        orderBy: { position: "asc" },
      });

      // Half-up to 2dp (paise precision). All money fields are Decimal(15,2)
      // on the DB; the conversion to Number is safe for ≤15-digit values.
      const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

      // Bucket items by supplierId (null bucket kept separate).
      /** @type {Map<number|null, Array<any>>} */
      const buckets = new Map();
      for (const row of items) {
        const key = row.supplierId == null ? null : row.supplierId;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(row);
      }

      // Look up supplier metadata in a single query — only for supplierIds
      // that actually appear in this itinerary's items.
      const supplierIds = [...buckets.keys()].filter((k) => k !== null);
      const supplierMap = new Map();
      if (supplierIds.length > 0) {
        const rows = await prisma.travelSupplier.findMany({
          where: {
            id: { in: supplierIds },
            tenantId: req.travelTenant.id,
          },
          select: {
            id: true,
            name: true,
            supplierCategory: true,
            contactPerson: true,
            phone: true,
            email: true,
          },
        });
        for (const s of rows) supplierMap.set(s.id, s);
      }

      function rollupFor(supplierId, rows) {
        let totalSupplierCost = 0;
        let totalGst = 0;
        let totalSalePrice = 0;
        const itemTypeSet = new Set();
        const lineItems = [];
        for (const r of rows) {
          const unit = r.unitCost != null ? Number(r.unitCost) : 0;
          const gst = r.gstAmount != null ? Number(r.gstAmount) : 0;
          const sale = r.totalPrice != null ? Number(r.totalPrice) : 0;
          totalSupplierCost += unit;
          totalGst += gst;
          totalSalePrice += sale;
          itemTypeSet.add(r.itemType);
          lineItems.push({
            id: r.id,
            itemType: r.itemType,
            description: r.description,
            unitCost: r.unitCost != null ? round2(unit) : null,
            gstAmount: r.gstAmount != null ? round2(gst) : null,
            totalPrice: r.totalPrice != null ? round2(sale) : null,
          });
        }
        const supplierCost = round2(totalSupplierCost);
        const gstTotal = round2(totalGst);
        const sale = round2(totalSalePrice);
        const marginTotal = round2(sale - supplierCost - gstTotal);
        // marginPct null when sale=0 to avoid div-zero / Infinity.
        const marginPct = sale > 0 ? round2((marginTotal / sale) * 100) : null;
        const supplier = supplierId != null ? supplierMap.get(supplierId) : null;
        return {
          supplierId,
          supplierName: supplier ? supplier.name : (supplierId == null ? "Unassigned" : "Unknown supplier"),
          supplierCategory: supplier ? supplier.supplierCategory : null,
          contactPerson: supplier ? supplier.contactPerson : null,
          phone: supplier ? supplier.phone : null,
          email: supplier ? supplier.email : null,
          itemCount: rows.length,
          itemTypes: [...itemTypeSet].sort(),
          totalSupplierCost: supplierCost,
          totalGst: gstTotal,
          totalSalePrice: sale,
          marginTotal,
          marginPct,
          items: lineItems,
        };
      }

      const suppliers = [];
      let unassigned = null;
      for (const [supplierId, rows] of buckets.entries()) {
        const rollup = rollupFor(supplierId, rows);
        if (supplierId == null) {
          unassigned = rollup;
        } else {
          suppliers.push(rollup);
        }
      }
      // Stable order: assigned suppliers sorted by descending sale price
      // (operator wants the biggest spend up top), tiebreak by supplierId asc.
      suppliers.sort((a, b) => {
        if (b.totalSalePrice !== a.totalSalePrice) return b.totalSalePrice - a.totalSalePrice;
        return a.supplierId - b.supplierId;
      });

      // Grand totals span assigned + unassigned (operator's view of the
      // whole itinerary's PO surface).
      const allRollups = unassigned ? [...suppliers, unassigned] : suppliers;
      const grandSupplierCost = round2(
        allRollups.reduce((s, r) => s + r.totalSupplierCost, 0),
      );
      const grandGst = round2(allRollups.reduce((s, r) => s + r.totalGst, 0));
      const grandSalePrice = round2(
        allRollups.reduce((s, r) => s + r.totalSalePrice, 0),
      );
      const grandMargin = round2(grandSalePrice - grandSupplierCost - grandGst);
      const grandMarginPct = grandSalePrice > 0
        ? round2((grandMargin / grandSalePrice) * 100)
        : null;

      res.json({
        itineraryId: itin.id,
        supplierCount: suppliers.length,
        suppliers,
        unassigned,
        grandTotals: {
          supplierCost: grandSupplierCost,
          gst: grandGst,
          salePrice: grandSalePrice,
          marginTotal: grandMargin,
          marginPct: grandMarginPct,
        },
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("[travel-itin] supplier-rollup error:", e.message);
      res.status(500).json({ error: "Failed to compute supplier rollup" });
    }
  },
);

// GET /api/travel/itineraries/:id/versions
//
// #907 slice 9 — read-side companion to the PUT-creates-new-version flow.
// PUT /:id creates a new Itinerary row with parentItineraryId pointing at
// the chain root + version bumped. Operators need a one-call read to see
// the full revision history; without this they'd have to issue N findOne
// calls or query Prisma directly.
//
// Semantics:
//   - Resolves the chain root: original.parentItineraryId || original.id.
//     The "root" is itself the v1 row; all subsequent versions point at it.
//   - Returns ALL siblings (including the root) sorted by version asc.
//   - Per-version payload is intentionally lean — id, version, status,
//     destination, totalAmount, currency, itemCount, createdAt, updatedAt,
//     isRoot, isLatest. The full item list lives behind GET /:id; this
//     endpoint is the index, not the detail.
//   - Item counts are computed in a single groupBy ($queryRaw-free) so
//     the route stays O(1) regardless of chain length.
//   - Tenant guard + sub-brand check are inherited from
//     loadItineraryWithGuard — 401 / 404 NOT_FOUND / 403 SUB_BRAND_DENIED.
//
// Response shape:
//   {
//     itineraryId: <id requested>,
//     chainRootId: <id of v1>,
//     versionCount: N,
//     latestVersionId: <id of most-recent>,
//     versions: [
//       { id, version, status, destination, totalAmount, currency,
//         itemCount, createdAt, updatedAt, isRoot, isLatest },
//       ...
//     ],
//   }
//
// PRD: docs/PRD_TRAVEL_ITINERARY_UPGRADES.md §5.1 (Versioning).
router.get("/itineraries/:id/versions", verifyToken, requireTravelTenant, async (req, res) => {
  try {
    const itin = await loadItineraryWithGuard(req);

    // Resolve chain root — the row whose id equals the parent pointer of
    // every later version. The original PUT handler uses the same logic.
    const original = await prisma.itinerary.findFirst({
      where: { id: itin.id, tenantId: req.travelTenant.id },
      select: { id: true, parentItineraryId: true },
    });
    if (!original) {
      return res.status(404).json({ error: "Itinerary not found", code: "NOT_FOUND" });
    }
    const chainRootId = original.parentItineraryId || original.id;

    // Fetch the full chain in a single query — root + every sibling that
    // points at the root via parentItineraryId.
    const rows = await prisma.itinerary.findMany({
      where: {
        tenantId: req.travelTenant.id,
        OR: [{ id: chainRootId }, { parentItineraryId: chainRootId }],
      },
      orderBy: { version: "asc" },
      select: {
        id: true,
        version: true,
        status: true,
        destination: true,
        totalAmount: true,
        currency: true,
        parentItineraryId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Per-version item counts in a single groupBy keyed on itineraryId.
    // Empty chain → no groupBy call (Prisma will happily run it, but
    // skipping is cheaper and keeps the response symmetrical when the
    // chain is single-row).
    const ids = rows.map((r) => r.id);
    const counts = new Map();
    if (ids.length > 0) {
      const grouped = await prisma.itineraryItem.groupBy({
        by: ["itineraryId"],
        where: { itineraryId: { in: ids } },
        _count: { _all: true },
      });
      for (const g of grouped) counts.set(g.itineraryId, g._count?._all || 0);
    }

    // Latest = highest version (rows are version-asc, so last entry).
    // Stable when versions are unique; ties are not expected (PUT bumps
    // by 1 each time) but defaulted-by-id-asc just in case.
    const latestVersionId = rows.length > 0 ? rows[rows.length - 1].id : null;

    const versions = rows.map((r) => ({
      id: r.id,
      version: r.version,
      status: r.status,
      destination: r.destination,
      totalAmount: r.totalAmount != null ? Number(r.totalAmount) : null,
      currency: r.currency,
      itemCount: counts.get(r.id) || 0,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      isRoot: r.id === chainRootId,
      isLatest: r.id === latestVersionId,
    }));

    res.json({
      itineraryId: itin.id,
      chainRootId,
      versionCount: versions.length,
      latestVersionId,
      versions,
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error("[travel-itin] versions error:", e.message);
    res.status(500).json({ error: "Failed to fetch version chain" });
  }
});

module.exports = router;
