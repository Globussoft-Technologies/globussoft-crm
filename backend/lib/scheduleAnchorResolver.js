// PRD_TRAVEL_BILLING G025 (FR-3.2.e) — anchor-relative due-date resolver.
//
// A TravelPaymentSchedule milestone may carry `anchorType` + `anchorOffset`
// metadata. When set, the computed dueDate equals the anchor's date plus the
// offset (in days). The route layer calls this helper at schedule create/
// update time to materialise the dueDate from anchor metadata.
//
// Anchor types:
//   booking_date    — Trip / invoice "deal date" (when the booking was placed).
//                     Today the closest signal is TravelInvoice.createdAt for
//                     invoice-mediated flows; explicit `trip.bookingDate`
//                     also accepted when callers can resolve it.
//   departure_date  — TmcTrip.departDate (first booking leg). Fallback to
//                     explicit invoice.departureDate when present.
//   return_date     — TmcTrip.returnDate (last booking leg). Fallback to
//                     explicit invoice.returnDate when present.
//   issue_date      — TravelInvoice.issuedAt / createdAt
//
// Operator-override semantics:
//   When the operator manually sets `dueDate` on the schedule, the route
//   layer KEEPS the anchor metadata for audit/deviation-detection (see
//   G027) but uses the explicit `dueDate` as the source of truth. The
//   helper is read-only; it doesn't mutate the schedule.
//
// Failure semantics:
//   When the requested anchor isn't available on the trip/invoice context
//   (e.g. anchorType=`return_date` but the trip has no return leg), the
//   helper returns `null`. Caller should fall back to the explicit
//   `dueDate` field or surface a 400 to the operator.
//
// Pure function — no DB access, no side effects, fully unit-testable.

const VALID_ANCHOR_TYPES = ["booking_date", "departure_date", "return_date", "issue_date"];

function isValidAnchorType(t) {
  return VALID_ANCHOR_TYPES.includes(t);
}

/**
 * Resolve an anchor's base date from an invoice + trip context.
 *
 * @param {string} anchorType — booking_date | departure_date | return_date | issue_date
 * @param {object} [invoice] — TravelInvoice row (may carry issuedAt + createdAt + bookingDate)
 * @param {object} [trip] — TmcTrip row (may carry bookingDate + departureDate + returnDate)
 * @returns {Date|null} resolved anchor date, or null when the named anchor isn't available
 */
function resolveAnchorDate(anchorType, invoice, trip) {
  if (!isValidAnchorType(anchorType)) return null;
  // Prefer trip fields over invoice fields when both are present. Travel
  // operators reason about due dates in trip-time, not invoice-time.
  if (anchorType === "booking_date") {
    if (trip && trip.bookingDate) return new Date(trip.bookingDate);
    if (invoice && invoice.bookingDate) return new Date(invoice.bookingDate);
    // Fallback: when no explicit booking date is available, the invoice's
    // createdAt is the closest signal of "when was the deal placed" for
    // invoice-driven flows.
    if (invoice && invoice.createdAt) return new Date(invoice.createdAt);
    return null;
  }
  if (anchorType === "departure_date") {
    // TmcTrip uses `departDate` (no `departure`). Both supported for
    // forward compatibility with any future trip model.
    if (trip && trip.departDate) return new Date(trip.departDate);
    if (trip && trip.departureDate) return new Date(trip.departureDate);
    if (invoice && invoice.departureDate) return new Date(invoice.departureDate);
    return null;
  }
  if (anchorType === "return_date") {
    if (trip && trip.returnDate) return new Date(trip.returnDate);
    if (invoice && invoice.returnDate) return new Date(invoice.returnDate);
    return null;
  }
  if (anchorType === "issue_date") {
    if (invoice && invoice.issuedAt) return new Date(invoice.issuedAt);
    if (invoice && invoice.createdAt) return new Date(invoice.createdAt);
    return null;
  }
  return null;
}

/**
 * Compute a due date from anchor metadata + invoice/trip context.
 *
 * @param {object} args
 * @param {string} args.anchorType — required when anchorOffset is provided
 * @param {number} args.anchorOffset — signed integer days from anchor
 * @param {object} [args.invoice] — TravelInvoice row context
 * @param {object} [args.trip] — TmcTrip row context
 * @returns {Date|null} computed due date, or null when anchor isn't resolvable
 */
function computeDueDate(args) {
  const { anchorType, anchorOffset, invoice, trip } = args || {};
  if (anchorType == null || anchorOffset == null) return null;
  const offset = Number(anchorOffset);
  if (!Number.isFinite(offset) || !Number.isInteger(offset)) return null;
  const anchor = resolveAnchorDate(anchorType, invoice, trip);
  if (!anchor) return null;
  // Mutate a copy so callers can safely pass shared invoice/trip refs.
  const result = new Date(anchor.getTime());
  result.setUTCDate(result.getUTCDate() + offset);
  return result;
}

module.exports = {
  VALID_ANCHOR_TYPES,
  isValidAnchorType,
  resolveAnchorDate,
  computeDueDate,
};
