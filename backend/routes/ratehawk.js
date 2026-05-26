/**
 * /api/ratehawk — operator wrapper for backend/services/ratehawkClient.js
 *
 * Stub-mode today (Q19 cred-blocked per CREDS_TRACKER Cat 1). When RateHawk
 * partner onboarding lands, the service swaps to real-mode and this route
 * stays unchanged — auth + sub-brand isolation + audit + cap surfacing live
 * here; provider invocation lives in the service.
 *
 * PRD_RATEHAWK_INTEGRATION DC-1 [RESOLVED 2026-05-24]: per-call cap (cents
 * per search query) via cross-cutting TenantSetting pattern. Reads cap via
 * canonical `getBudgetCap('ratehawk')` per commit 991416c.
 *
 * Sibling wrapper routes (same pattern):
 *   - /api/adsgpt — commit 0d66a74 (tick #102)
 *
 * Future siblings (this tick spawns them sequentially):
 *   - /api/callified (next tick)
 *   - /api/booking-expedia (after that)
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const ratehawkClient = require("../services/ratehawkClient");
const { writeAudit } = require("../lib/audit");
const { resolveSubBrand } = require("../lib/subBrandResolve");

// Sub-brand isolation guard imported from ../lib/subBrandResolve (tick #106
// rule-of-3 promotion — previously inlined here, in callified.js, and in
// booking_expedia.js byte-identically). Contract: API-key-scoped callers
// (req.apiKeySubBrand set by externalAuth/voyagrAuth) get force-pinned to
// their scope and mismatching body rejected as 403 SUB_BRAND_MISMATCH;
// operator JWT callers pass body through. See lib for full JSDoc.

/**
 * POST /api/ratehawk/search
 *
 * Body: { subBrand?, destinationCity (required), checkInDate (required),
 *         checkOutDate (required), guests = 2, rooms = 1 }
 *
 * Delegates to ratehawkClient.searchHotels. Surfaces the client's
 * RATEHAWK_BUDGET_EXCEEDED throw as 402 Payment Required with a
 * structured error body so the operator UI can show a cap-hit banner.
 *
 * Open to any authenticated user (operators may search for client quotes
 * without being ADMIN/MANAGER).
 */
router.post("/search", verifyToken, async (req, res) => {
  try {
    const {
      subBrand: bodySubBrand,
      destinationCity,
      checkInDate,
      checkOutDate,
      guests = 2,
      rooms = 1,
    } = req.body || {};

    if (!destinationCity) {
      return res
        .status(400)
        .json({ error: "destinationCity is required", code: "MISSING_DESTINATION" });
    }
    if (!checkInDate) {
      return res
        .status(400)
        .json({ error: "checkInDate is required", code: "MISSING_CHECKIN" });
    }
    if (!checkOutDate) {
      return res
        .status(400)
        .json({ error: "checkOutDate is required", code: "MISSING_CHECKOUT" });
    }

    const sb = resolveSubBrand(req, bodySubBrand);
    if (!sb.ok) return res.status(sb.status).json(sb.body);

    const result = await ratehawkClient.searchHotels({
      tenantId: req.user.tenantId,
      subBrand: sb.effectiveSubBrand,
      destinationCity,
      checkInDate,
      checkOutDate,
      guests,
      rooms,
    });

    res.json(result);
  } catch (e) {
    if (e.code === "RATEHAWK_BUDGET_EXCEEDED") {
      return res.status(402).json({
        error: e.message,
        code: "RATEHAWK_BUDGET_EXCEEDED",
        spentCents: e.spentCents,
        capCents: e.capCents,
      });
    }
    if (e.status) {
      return res.status(e.status).json({ error: e.message, code: e.code });
    }
    console.error("[ratehawk] search error:", e.message);
    res.status(500).json({ error: "Failed to search hotels" });
  }
});

/**
 * POST /api/ratehawk/book
 *
 * Body: { subBrand?, hotelId (required), roomType (required),
 *         checkInDate (required), checkOutDate (required), guestNames? }
 *
 * ADMIN/MANAGER only. Delegates to ratehawkClient.bookHotel. Writes a
 * RateHawkBooking BOOK audit row on success.
 */
router.post(
  "/book",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const {
        subBrand: bodySubBrand,
        hotelId,
        roomType,
        checkInDate,
        checkOutDate,
        guestNames,
      } = req.body || {};

      if (!hotelId) {
        return res
          .status(400)
          .json({ error: "hotelId is required", code: "MISSING_HOTEL_ID" });
      }
      if (!roomType) {
        return res
          .status(400)
          .json({ error: "roomType is required", code: "MISSING_ROOM_TYPE" });
      }
      if (!checkInDate) {
        return res
          .status(400)
          .json({ error: "checkInDate is required", code: "MISSING_CHECKIN" });
      }
      if (!checkOutDate) {
        return res
          .status(400)
          .json({ error: "checkOutDate is required", code: "MISSING_CHECKOUT" });
      }

      const sb = resolveSubBrand(req, bodySubBrand);
      if (!sb.ok) return res.status(sb.status).json(sb.body);

      const result = await ratehawkClient.bookHotel({
        tenantId: req.user.tenantId,
        subBrand: sb.effectiveSubBrand,
        hotelId,
        roomType,
        checkInDate,
        checkOutDate,
        guestNames,
      });

      await writeAudit(
        "RateHawkBooking",
        "BOOK",
        result && result.bookingId ? String(result.bookingId) : null,
        req.user.userId,
        req.user.tenantId,
        {
          subBrand: sb.effectiveSubBrand,
          hotelId,
          roomType,
          checkInDate,
          checkOutDate,
          guestCount: Array.isArray(guestNames) ? guestNames.length : 0,
        },
      );

      res.json(result);
    } catch (e) {
      if (e.code === "RATEHAWK_BUDGET_EXCEEDED") {
        return res.status(402).json({
          error: e.message,
          code: "RATEHAWK_BUDGET_EXCEEDED",
          spentCents: e.spentCents,
          capCents: e.capCents,
        });
      }
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[ratehawk] book error:", e.message);
      res.status(500).json({ error: "Failed to book hotel" });
    }
  },
);

/**
 * POST /api/ratehawk/cancel/:bookingId
 *
 * Body: { reason? }
 *
 * ADMIN/MANAGER only. Delegates to ratehawkClient.cancelBooking. Writes
 * a RateHawkBooking CANCEL audit row on success. Sub-brand isolation
 * does not apply here (cancellations target an existing bookingId; the
 * sub-brand scope was enforced at /book time).
 */
router.post(
  "/cancel/:bookingId",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const { bookingId } = req.params;
      const { reason } = req.body || {};

      const result = await ratehawkClient.cancelBooking({
        tenantId: req.user.tenantId,
        bookingId,
        reason,
      });

      await writeAudit(
        "RateHawkBooking",
        "CANCEL",
        String(bookingId),
        req.user.userId,
        req.user.tenantId,
        { bookingId, reason: reason || null },
      );

      res.json(result);
    } catch (e) {
      if (e.code === "RATEHAWK_BUDGET_EXCEEDED") {
        return res.status(402).json({
          error: e.message,
          code: "RATEHAWK_BUDGET_EXCEEDED",
          spentCents: e.spentCents,
          capCents: e.capCents,
        });
      }
      if (e.status) {
        return res.status(e.status).json({ error: e.message, code: e.code });
      }
      console.error("[ratehawk] cancel error:", e.message);
      res.status(500).json({ error: "Failed to cancel booking" });
    }
  },
);

/**
 * GET /api/ratehawk/cap-status — ADMIN-only operator surface.
 *
 * Returns the current per-tenant cap utilisation so the operator UI can
 * render an "X% of monthly cap" indicator without firing a search call.
 * Read-only — no audit row written.
 */
router.get(
  "/cap-status",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const status = await ratehawkClient.checkBudgetCap(req.user.tenantId);
      res.json({
        spentCents: status.spentCents,
        capCents: status.capCents,
        percent: status.percent,
        withinCap: status.withinCap,
        alertThreshold: status.alertThreshold,
      });
    } catch (e) {
      if (e.code === "RATEHAWK_BUDGET_EXCEEDED") {
        return res.status(402).json({
          error: e.message,
          code: "RATEHAWK_BUDGET_EXCEEDED",
          spentCents: e.spentCents,
          capCents: e.capCents,
        });
      }
      console.error("[ratehawk] cap-status error:", e.message);
      res.status(500).json({ error: "Failed to read cap status" });
    }
  },
);

module.exports = router;
