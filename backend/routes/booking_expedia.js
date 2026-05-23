/**
 * /api/booking-expedia — operator wrapper for backend/services/bookingExpediaClient.js
 *
 * Stub-mode today (Q-cluster B6/C cred-blocked per CREDS_TRACKER Cat 1).
 * Booking.com is Phase 1 (DC-1 RESOLVED 2026-05-24 — Booking first, Expedia
 * Phase 2 demand-driven). Expedia code paths throw EXPEDIA_NOT_YET_ENABLED
 * (503 — Service Unavailable) until DC-4 flips the demand-threshold.
 *
 * Cap helper KEYS extended to `booking_expedia` at commit 991416c (tick #101).
 * Single cap shared across both providers because they're alternative sources
 * of the same hotel-inventory budget.
 *
 * FOURTH and FINAL wrapper in the cred-stub series:
 *   - /api/adsgpt (commit 0d66a74, tick #102)
 *   - /api/ratehawk (commit be67789, tick #103)
 *   - /api/callified (commit cdad62d, tick #104)
 *   - /api/booking-expedia (this commit)
 *
 * All 5 cap consumers (llmRouter + 4 stubbed services) now have UI-reachable
 * operator routes. Admin UI rollout follows in subsequent ticks.
 */

const express = require("express");
const router = express.Router();
const { verifyToken, verifyRole } = require("../middleware/auth");
const bookingExpediaClient = require("../services/bookingExpediaClient");
const { writeAudit } = require("../lib/audit");

/**
 * Sub-brand isolation guard — mirrors the /api/ratehawk pattern at commit
 * be67789. If the caller authenticated via a sub-brand-scoped API key
 * (req.apiKeySubBrand set by externalAuth/voyagrAuth), the body subBrand
 * is force-pinned to that value AND any mismatching body is rejected with
 * 403 SUB_BRAND_MISMATCH. Operator JWT auth (verifyToken-only) leaves
 * req.apiKeySubBrand undefined so cross-sub-brand operations are allowed
 * for operators.
 *
 * NOT yet promoted to backend/lib/subBrandResolve.js — fourth copy/paste
 * (adsgpt/ratehawk/callified/booking-expedia). Promotion deferred to a
 * dedicated tick to avoid file-overlap with the four wrapper-route ticks.
 *
 * Returns { ok: true, effectiveSubBrand } or { ok: false, status, body }.
 */
function resolveSubBrand(req, suppliedSubBrand) {
  if (req.apiKeySubBrand !== undefined && req.apiKeySubBrand !== null) {
    if (suppliedSubBrand && suppliedSubBrand !== req.apiKeySubBrand) {
      return {
        ok: false,
        status: 403,
        body: {
          error: `API key scoped to '${req.apiKeySubBrand}' cannot operate on sub-brand '${suppliedSubBrand}'`,
          code: "SUB_BRAND_MISMATCH",
        },
      };
    }
    return { ok: true, effectiveSubBrand: req.apiKeySubBrand };
  }
  return { ok: true, effectiveSubBrand: suppliedSubBrand || null };
}

/**
 * Map a thrown client error to the right HTTP response. Centralised so all
 * three handlers (/search, /book, /cancel) share consistent semantics for:
 *   - BOOKING_EXPEDIA_BUDGET_EXCEEDED → 402 Payment Required
 *   - EXPEDIA_NOT_YET_ENABLED         → 503 Service Unavailable (Phase 2
 *                                       deferred-by-design — NOT 400, since
 *                                       the caller's input is well-formed
 *                                       and they should retry once DC-4
 *                                       flips the demand-threshold)
 *   - UNKNOWN_PROVIDER                → 400 Bad Request
 *   - any other e.status              → use it
 *   - everything else                 → 500 Internal Server Error
 * Returns true if the error was handled and the response sent.
 */
function sendClientError(res, e, fallbackMessage) {
  if (e.code === "BOOKING_EXPEDIA_BUDGET_EXCEEDED") {
    res.status(402).json({
      error: e.message,
      code: "BOOKING_EXPEDIA_BUDGET_EXCEEDED",
      spentCents: e.spentCents,
      capCents: e.capCents,
    });
    return true;
  }
  if (e.code === "EXPEDIA_NOT_YET_ENABLED") {
    res.status(503).json({
      error: e.message,
      code: "EXPEDIA_NOT_YET_ENABLED",
    });
    return true;
  }
  if (e.code === "UNKNOWN_PROVIDER") {
    res.status(400).json({
      error: e.message,
      code: "UNKNOWN_PROVIDER",
    });
    return true;
  }
  if (e.status) {
    res.status(e.status).json({ error: e.message, code: e.code });
    return true;
  }
  console.error(`[booking-expedia] ${fallbackMessage}:`, e.message);
  res.status(500).json({ error: fallbackMessage });
  return true;
}

/**
 * POST /api/booking-expedia/search
 *
 * Body: { provider = 'booking', subBrand?, destinationCity (required),
 *         checkInDate (required), checkOutDate (required),
 *         guests = 2, rooms = 1 }
 *
 * Delegates to bookingExpediaClient.searchHotels. Open to any authenticated
 * user (operators may search for client quotes without being ADMIN/MANAGER).
 *
 * Provider gate:
 *   - provider='booking'  → Phase 1, search proceeds
 *   - provider='expedia'  → 503 EXPEDIA_NOT_YET_ENABLED (DC-4 deferred)
 *   - provider=anything   → 400 UNKNOWN_PROVIDER
 */
router.post("/search", verifyToken, async (req, res) => {
  try {
    const {
      provider = "booking",
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

    const result = await bookingExpediaClient.searchHotels({
      tenantId: req.user.tenantId,
      provider,
      subBrand: sb.effectiveSubBrand,
      destinationCity,
      checkInDate,
      checkOutDate,
      guests,
      rooms,
    });

    res.json(result);
  } catch (e) {
    sendClientError(res, e, "Failed to search hotels");
  }
});

/**
 * POST /api/booking-expedia/book
 *
 * Body: { provider = 'booking', subBrand?, hotelId (required),
 *         roomType (required), checkInDate (required),
 *         checkOutDate (required), guestNames? }
 *
 * ADMIN/MANAGER only. Delegates to bookingExpediaClient.bookHotel. Writes
 * a BookingExpediaBooking BOOK audit row on success.
 */
router.post(
  "/book",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const {
        provider = "booking",
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

      const result = await bookingExpediaClient.bookHotel({
        tenantId: req.user.tenantId,
        provider,
        subBrand: sb.effectiveSubBrand,
        hotelId,
        roomType,
        checkInDate,
        checkOutDate,
        guestNames,
      });

      await writeAudit(
        "BookingExpediaBooking",
        "BOOK",
        result && result.bookingId ? String(result.bookingId) : null,
        req.user.userId,
        req.user.tenantId,
        {
          provider,
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
      sendClientError(res, e, "Failed to book hotel");
    }
  },
);

/**
 * POST /api/booking-expedia/cancel/:bookingId
 *
 * Body: { provider = 'booking', reason? }
 *
 * ADMIN/MANAGER only. Delegates to bookingExpediaClient.cancelBooking.
 * Writes a BookingExpediaBooking CANCEL audit row on success. Sub-brand
 * isolation does not apply here (cancellations target an existing
 * bookingId; the sub-brand scope was enforced at /book time).
 */
router.post(
  "/cancel/:bookingId",
  verifyToken,
  verifyRole(["ADMIN", "MANAGER"]),
  async (req, res) => {
    try {
      const { bookingId } = req.params;
      const { provider = "booking", reason } = req.body || {};

      const result = await bookingExpediaClient.cancelBooking({
        tenantId: req.user.tenantId,
        provider,
        bookingId,
        reason,
      });

      await writeAudit(
        "BookingExpediaBooking",
        "CANCEL",
        String(bookingId),
        req.user.userId,
        req.user.tenantId,
        { provider, bookingId, reason: reason || null },
      );

      res.json(result);
    } catch (e) {
      sendClientError(res, e, "Failed to cancel booking");
    }
  },
);

/**
 * GET /api/booking-expedia/cap-status — ADMIN-only operator surface.
 *
 * Returns the current per-tenant cap utilisation so the operator UI can
 * render an "X% of monthly cap" indicator without firing a search call.
 * Read-only — no audit row written. The cap is shared across booking +
 * expedia providers (single 'booking_expedia' key per DC-1's "aggregator-
 * for-Phase-1, direct-APIs-as-inventory-deepens" architecture).
 */
router.get(
  "/cap-status",
  verifyToken,
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const status = await bookingExpediaClient.checkBudgetCap(req.user.tenantId);
      res.json({
        spentCents: status.spentCents,
        capCents: status.capCents,
        percent: status.percent,
        withinCap: status.withinCap,
        alertThreshold: status.alertThreshold,
      });
    } catch (e) {
      if (e.code === "BOOKING_EXPEDIA_BUDGET_EXCEEDED") {
        return res.status(402).json({
          error: e.message,
          code: "BOOKING_EXPEDIA_BUDGET_EXCEEDED",
          spentCents: e.spentCents,
          capCents: e.capCents,
        });
      }
      console.error("[booking-expedia] cap-status error:", e.message);
      res.status(500).json({ error: "Failed to read cap status" });
    }
  },
);

module.exports = router;
