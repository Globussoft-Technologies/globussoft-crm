/**
 * RateHawk integration client — STUB MODE.
 *
 * STUB: RateHawk integration pending Q19 creds. Yasin owes the partner
 * onboarding (API key ID + email + endpoint URL + RateHawk B2B agreement).
 * When creds arrive, swap the placeholder fetch() / mock-response with the
 * real HTTP call; the budget-cap + observability scaffold stays unchanged.
 *
 * PRD_RATEHAWK_INTEGRATION DC-1 [RESOLVED 2026-05-24]: per-call cap (cents
 * per search query) via the cross-cutting TenantSetting pattern. This module
 * is the third consumer of the cap helper (after llmRouter cb0901f +
 * adsGptClient 9f35040).
 *
 * Cred chase: docs/CREDS_TRACKER.md Cat 1 Q19 row + docs/PRD_RATEHAWK_INTEGRATION.md §5.
 * NOTE: tick #74 audit flagged this as the only Cat-1 cred-blocked item with
 * NO stub written. This commit lands the skeleton; real-mode swap is ~1 day
 * post-cred (mirror digilockerClient/googleDriveClient pattern).
 *
 * Mirror clients for swap-when-cred pattern:
 *   - backend/services/digilockerClient.js (commit 1babe1b — original)
 *   - backend/services/googleDriveClient.js (commit 192de86 — same pattern)
 *   - backend/services/adsGptClient.js (commit 9f35040 — second cap consumer)
 */

const { getBudgetCap, evaluateCap, KEYS } = require('../lib/tenantSettings');

const INTEGRATION = 'ratehawk';

// Touch KEYS so the imported binding isn't flagged unused — also makes
// the canonical-keys dependency explicit for future readers grep-tracing
// the cap pattern across consumers.
void KEYS;

/**
 * Pre-call cap check. Returns { withinCap, capCents, spentCents, percent, alertThreshold }.
 * Throws { code: 'RATEHAWK_BUDGET_EXCEEDED', error, spentCents, capCents } if over cap.
 *
 * Spend source: future RatehawkSearchLog model (one row per search call,
 * costEstimate in Decimal USD). In stub mode, returns 0 spend (no rows
 * ever written by the stub).
 */
async function checkBudgetCap(tenantId) {
  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  // Resolve via module.exports so vi.spyOn(client, 'computeMonthlySpendCents')
  // in unit tests intercepts the call. Direct local-binding reference would
  // bypass the spy (closure-captured at module load). This is the SECOND
  // instance of the CJS self-mocking seam pattern (first: tick #47
  // safeEmitEvent); worth promoting on next instance.
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly RateHawk spend cap reached for this tenant.');
    err.code = 'RATEHAWK_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(`[ratehawkClient] tenant ${tenantId} at ${Math.round(evaluation.percent * 100)}% of monthly RateHawk cap ($${(spentCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)})`);
  }
  return evaluation;
}

async function computeMonthlySpendCents(_tenantId) {
  // STUB: real implementation will sum a future RatehawkSearchLog model
  // (one row per search call, costEstimate in Decimal USD) — mirror the
  // LlmCallLog spend-sum pattern in backend/lib/llmRouter.js (dollar→cent
  // conversion via * 100). For now returns 0.
  // TODO post-cred: RatehawkSearchLog schema + sum filtered by tenantId +
  // createdAt >= startOfMonth.
  return 0;
}

/**
 * Hotel search — primary RateHawk operation for RFU unified-search flow.
 *
 * STUB: returns canned shape matching the contract described in
 * PRD_RATEHAWK_INTEGRATION §3.1 (destination city, check-in/out, guests,
 * rooms → hotels[] with name, address, rating, room types with rate).
 * When creds arrive, replace stub body with real fetch().
 */
async function searchHotels({ tenantId, destinationCity, checkInDate, checkOutDate, guests = 2, rooms = 1 }) {
  if (!tenantId) throw new Error('tenantId required');
  await checkBudgetCap(tenantId);

  console.log(`[ratehawkClient STUB] searchHotels: tenantId=${tenantId} city=${destinationCity} dates=${checkInDate}..${checkOutDate} guests=${guests} rooms=${rooms}`);

  // STUB response — canned shape matching PRD §3.1
  return {
    stub: true,
    tenantId,
    query: { destinationCity, checkInDate, checkOutDate, guests, rooms },
    hotels: [],
    note: 'RateHawk integration pending Q19 creds (Yasin partner onboarding). Real hotel inventory will populate once the swap is done.',
  };
}

/**
 * Book a hotel — POST to RateHawk reservation endpoint.
 *
 * STUB: returns a canned booking confirmation shape. Caller is the
 * Itinerary write path (PRD §3.2 lowest-rate auto-pick + manual override).
 */
async function bookHotel({ tenantId, hotelId, roomType, checkInDate, checkOutDate, guestNames }) {
  if (!tenantId) throw new Error('tenantId required');
  await checkBudgetCap(tenantId);

  console.log(`[ratehawkClient STUB] bookHotel: tenantId=${tenantId} hotelId=${hotelId} roomType=${roomType} dates=${checkInDate}..${checkOutDate} guests=${(guestNames || []).length}`);

  return {
    stub: true,
    bookingId: null,
    status: 'pending-cred-drop',
    tenantId,
    query: { hotelId, roomType, checkInDate, checkOutDate, guestNames: guestNames || [] },
    note: 'RateHawk integration pending Q19 creds (Yasin partner onboarding). Real booking confirmation will populate once the swap is done.',
  };
}

/**
 * Cancel a hotel booking — DELETE to RateHawk cancellation endpoint.
 */
async function cancelBooking({ tenantId, bookingId, reason }) {
  if (!tenantId) throw new Error('tenantId required');
  await checkBudgetCap(tenantId);

  console.log(`[ratehawkClient STUB] cancelBooking: tenantId=${tenantId} bookingId=${bookingId} reason=${reason}`);

  return {
    stub: true,
    bookingId,
    status: 'pending-cred-drop',
    tenantId,
    reason: reason || null,
    note: 'RateHawk integration pending Q19 creds (Yasin partner onboarding). Real cancellation will be processed once the swap is done.',
  };
}

module.exports = { searchHotels, bookHotel, cancelBooking, checkBudgetCap, computeMonthlySpendCents, INTEGRATION };
