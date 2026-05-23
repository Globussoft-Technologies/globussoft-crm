/**
 * Booking.com / Expedia direct integration client — STUB MODE.
 *
 * STUB: Booking.com / Expedia integration pending Q-cluster B6/C creds.
 * Per PRD_BOOKING_EXPEDIA_DIRECT DC-1 [RESOLVED 2026-05-24]: Booking.com
 * onboarding starts FIRST; Expedia EAN deferred to Phase 2 (demand-driven).
 * When Booking.com creds arrive, swap the placeholder fetch() with real
 * REST/SOAP call; Expedia code paths stay disabled until the DC-4 timing
 * decision flips.
 *
 * Fifth consumer of the per-tenant cap helper (after llmRouter cb0901f,
 * adsGptClient 9f35040, ratehawkClient 2852b82, callifiedClient 9ec52df).
 * Cap is shared across Booking + Expedia (single 'booking_expedia' key)
 * because they're alternative sources of the same hotel-inventory budget
 * per DC-1's "RateHawk aggregator for Phase 1; direct APIs as inventory
 * deepens" architectural framing.
 *
 * Cap helper KEYS extended with `BOOKING_EXPEDIA_MONTHLY_CAP_USD_CENTS` at
 * tick #101 (this commit); canonical `getBudgetCap` path now works. Prior
 * incarnation used `getSetting(tenantId, BUDGET_CAP_KEY, { fallback })` as
 * a workaround because KEYS was locked to 4 entries at commit d8119a1 —
 * see git log for the swap commit. The $100/mo (10000 cents) default lives
 * in tenantSettings.DEFAULTS now, overridable via
 * `process.env.BOOKING_EXPEDIA_MONTHLY_CAP_USD_CENTS` or per-tenant via a
 * TenantSetting row.
 *
 * Cred chase: docs/CREDS_TRACKER.md Cat 1 B6/C row.
 */

const prisma = require('../lib/prisma');
const { getBudgetCap, evaluateCap } = require('../lib/tenantSettings');

const INTEGRATION = 'booking_expedia';
const BUDGET_CAP_KEY = 'budgetCap_booking_expedia_monthly_usd_cents';
const PROVIDERS = ['booking', 'expedia'];
const PHASE_2_PROVIDERS = ['expedia']; // Per DC-4 — disabled until demand-driven flip.

// Default monthly cap exposed for back-compat / observability (unit tests
// + admin tooling read this constant). Canonical resolution path is now
// `getBudgetCap(tenantId, INTEGRATION)`, which reads
// tenantSettings.DEFAULTS[KEYS.BOOKING_EXPEDIA_MONTHLY_CAP_USD_CENTS]
// (same env-var + same 10000-cent fallback). Kept as a literal here so the
// module's exported shape is stable for downstream consumers.
const DEFAULT_CAP_CENTS = Number(
  process.env.BOOKING_EXPEDIA_MONTHLY_CAP_USD_CENTS ?? 10000,
);

async function checkBudgetCap(tenantId) {
  // Canonical cap lookup — KEYS now includes 'booking_expedia' so
  // getBudgetCap resolves without the prior getSetting() workaround.
  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  // Resolve via module.exports so vi.spyOn(client, 'computeMonthlySpendCents')
  // in unit tests intercepts the call. Direct local-binding reference would
  // bypass the spy (closure-captured at module load). CJS self-mocking seam
  // — fourth instance of this pattern (first: tick #47 safeEmitEvent;
  // second: ratehawkClient; third: callifiedClient).
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly Booking/Expedia hotel-inventory cap reached.');
    err.code = 'BOOKING_EXPEDIA_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(
      `[bookingExpediaClient] tenant ${tenantId} at ${Math.round(evaluation.percent * 100)}% of monthly Booking/Expedia cap ($${(spentCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)})`,
    );
  }
  return evaluation;
}

async function computeMonthlySpendCents(_tenantId) {
  // STUB: real implementation will sum a future HotelBookingLog model
  // (one row per Booking.com or Expedia booking, costEstimate in Decimal
  // USD). Mirror the LlmCallLog spend-sum pattern in backend/lib/llmRouter.js
  // (dollar→cent conversion via * 100). For now returns 0 — stub never
  // writes spend rows.
  return 0;
}

function assertProviderEnabled(provider) {
  if (!PROVIDERS.includes(provider)) {
    const err = new Error(
      `Unknown provider: ${provider}. Allowed: ${PROVIDERS.join(', ')}`,
    );
    err.code = 'UNKNOWN_PROVIDER';
    throw err;
  }
  if (PHASE_2_PROVIDERS.includes(provider)) {
    const err = new Error(
      `${provider} is Phase 2 (DC-4 deferred). Not yet enabled.`,
    );
    err.code = 'EXPEDIA_NOT_YET_ENABLED';
    throw err;
  }
}

/**
 * Search hotels via Booking.com (Expedia disabled per DC-4).
 *
 * STUB: returns canned shape. When Booking.com creds arrive, replace stub
 * body with real fetch() to Booking.com Affiliate Partner API. Cap +
 * provider-gate stays unchanged across the swap.
 */
async function searchHotels({
  tenantId,
  provider = 'booking',
  destinationCity,
  checkInDate,
  checkOutDate,
  guests = 2,
  rooms = 1,
}) {
  if (!tenantId) throw new Error('tenantId required');
  module.exports.assertProviderEnabled(provider);
  await module.exports.checkBudgetCap(tenantId);

  console.log(
    `[bookingExpediaClient STUB] searchHotels: tenantId=${tenantId} provider=${provider} city=${destinationCity} dates=${checkInDate}..${checkOutDate} guests=${guests} rooms=${rooms}`,
  );

  return {
    stub: true,
    tenantId,
    provider,
    query: { destinationCity, checkInDate, checkOutDate, guests, rooms },
    hotels: [],
    note: 'Booking.com integration pending Q-cluster B6/C creds. Real hotel inventory will populate once the partner-account swap is done. Expedia is Phase 2 (DC-4 deferred).',
  };
}

/**
 * Book a hotel via Booking.com.
 *
 * STUB: returns canned shape with status 'pending-cred-drop'.
 */
async function bookHotel({
  tenantId,
  provider = 'booking',
  hotelId,
  roomType,
  checkInDate,
  checkOutDate,
  guestNames,
}) {
  if (!tenantId) throw new Error('tenantId required');
  module.exports.assertProviderEnabled(provider);
  await module.exports.checkBudgetCap(tenantId);

  console.log(
    `[bookingExpediaClient STUB] bookHotel: tenantId=${tenantId} provider=${provider} hotelId=${hotelId} roomType=${roomType} dates=${checkInDate}..${checkOutDate} guestNames=${Array.isArray(guestNames) ? guestNames.length : 0}`,
  );

  return {
    stub: true,
    tenantId,
    provider,
    bookingId: null,
    hotelId: hotelId || null,
    status: 'pending-cred-drop',
    note: 'Booking.com integration pending Q-cluster B6/C creds. Real booking confirmation will populate once the partner-account swap is done.',
  };
}

/**
 * Cancel a hotel booking via Booking.com.
 *
 * STUB: returns canned shape with status 'pending-cred-drop'.
 */
async function cancelBooking({ tenantId, provider = 'booking', bookingId, reason }) {
  if (!tenantId) throw new Error('tenantId required');
  module.exports.assertProviderEnabled(provider);
  await module.exports.checkBudgetCap(tenantId);

  console.log(
    `[bookingExpediaClient STUB] cancelBooking: tenantId=${tenantId} provider=${provider} bookingId=${bookingId} reason=${reason}`,
  );

  return {
    stub: true,
    tenantId,
    provider,
    bookingId: bookingId || null,
    status: 'pending-cred-drop',
    reason: reason || null,
    note: 'Booking.com integration pending Q-cluster B6/C creds. Real cancellation confirmation will populate once the partner-account swap is done.',
  };
}

// Touch prisma so the imported binding isn't flagged unused — real-mode
// swap will likely need direct prisma access for future HotelBookingLog
// writes (mirror llmRouter's LlmCallLog pattern). Keeping the import
// explicit here makes the swap a one-line change.
void prisma;

module.exports = {
  searchHotels,
  bookHotel,
  cancelBooking,
  checkBudgetCap,
  computeMonthlySpendCents,
  assertProviderEnabled,
  INTEGRATION,
  BUDGET_CAP_KEY,
  PROVIDERS,
  PHASE_2_PROVIDERS,
  DEFAULT_CAP_CENTS,
};
