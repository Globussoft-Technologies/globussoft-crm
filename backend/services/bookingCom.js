/**
 * Booking.com Affiliate Partner API client. Stub-mode pending Q11 vendor
 * handover. Per DC-1 RESOLVED 2026-05-24: Booking.com priority over Expedia
 * (India inventory density + simpler OAuth2 onboarding gates the 2-4 week
 * clock). Replaces the inline stub path in bookingExpediaClient.js once
 * Phase 1 creds land — coexists for now.
 *
 * Architectural framing:
 *   - bookingExpediaClient.js (tick #100 commit db06414) is the UNIFIED
 *     wrapper API surface — it routes per provider, throws
 *     EXPEDIA_NOT_YET_ENABLED 503 for Phase 2, and has its own stub paths
 *     for the Booking-direct flow.
 *   - THIS module (bookingCom.js) is the LOWER-LEVEL Booking.com
 *     Affiliate Partner API provider client. Future eng work would wire
 *     bookingExpediaClient → bookingCom when Phase 1 creds land. They
 *     COEXIST today; this is not a deprecation of the wrapper.
 *
 * Sixth consumer of the cross-cutting per-tenant budget-cap pattern (after
 * llmRouter cb0901f, adsGptClient 9f35040, ratehawkClient 2852b82,
 * callifiedClient 9ec52df, bookingExpediaClient db06414). The cap KEYS
 * registry in `lib/tenantSettings.js` doesn't yet include 'booking_com'
 * (the existing 'booking_expedia' is shared by the unified wrapper). To
 * avoid touching tenantSettings.js (file-collision-risk with sibling
 * agent), we read the cap inline via `getSetting()` with an explicit
 * fallback constant — mirrors the bookingExpediaClient's earlier
 * pre-KEYS-extension workaround pattern. The canonical KEYS extension
 * will land in a separate tick once Q11 creds drop.
 *
 * Cred chase: docs/CREDS_TRACKER.md Cat 1 Q11 row.
 */

const prisma = require('../lib/prisma');
const { getSetting, evaluateCap } = require('../lib/tenantSettings');

const INTEGRATION = 'booking_com';
const BUDGET_CAP_KEY = 'budgetCap_booking_com_monthly_usd_cents';

// Default monthly cap — $100/mo (10000 cents) mirrors the
// bookingExpediaClient + AI_CALLING + LLM defaults. Overridable per-tenant
// via TenantSetting row OR via process.env.BOOKING_COM_MONTHLY_CAP_USD_CENTS.
// TODO post-Q11-cred-drop: promote into tenantSettings.KEYS + DEFAULTS so
// the canonical `getBudgetCap(tenantId, 'booking_com')` path resolves
// without this inline workaround. See bookingExpediaClient.js header NOTE
// for the prior incarnation of this same pattern.
const DEFAULT_CAP_CENTS = Number(
  process.env.BOOKING_COM_MONTHLY_CAP_USD_CENTS ?? 10000,
);

/**
 * Pre-call cap check. Returns { withinCap, capCents, spentCents, percent, alertThreshold }.
 * Throws { code: 'BOOKING_COM_BUDGET_EXCEEDED', spentCents, capCents } if over cap.
 *
 * Spend source: future BookingComBookingLog model (one row per Booking.com
 * booking, costEstimate in Decimal USD). In stub mode, returns 0 spend.
 */
async function checkBudgetCap(tenantId) {
  // Inline cap read (workaround — KEYS doesn't include 'booking_com' yet).
  // Once Q11 creds drop + KEYS is extended, swap to:
  //   const capCents = await getBudgetCap(tenantId, INTEGRATION);
  const capCents = await getSetting(tenantId, BUDGET_CAP_KEY, {
    coerce: Number,
    fallback: DEFAULT_CAP_CENTS,
  });
  // Resolve via module.exports so vi.spyOn(client, 'computeMonthlySpendCents')
  // in unit tests intercepts the call. Direct local-binding reference would
  // bypass the spy (closure-captured at module load). CJS self-mocking seam —
  // sixth instance of this pattern (per CLAUDE.md 2026-05-24 cron-learning).
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly Booking.com hotel-inventory cap reached.');
    err.code = 'BOOKING_COM_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(
      `[bookingCom] tenant ${tenantId} at ${Math.round(evaluation.percent * 100)}% of monthly Booking.com cap ($${(spentCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)})`,
    );
  }
  return evaluation;
}

async function computeMonthlySpendCents(_tenantId) {
  // STUB: Booking.com Affiliate API integration pending Q11 creds. Real
  // implementation will sum a future BookingComBookingLog model (one row
  // per booking, costEstimate in Decimal USD). Mirror the LlmCallLog
  // spend-sum pattern in backend/lib/llmRouter.js (dollar→cent conversion
  // via * 100). For now returns 0 — stub never writes spend rows.
  return 0;
}

/**
 * Search hotels via Booking.com Affiliate Partner API.
 *
 * STUB: Booking.com Affiliate API integration pending Q11 creds. Returns
 * 3-4 deterministic placeholder hotels with stable IDs so downstream
 * tests / UI screenshots stay reproducible. When creds arrive, replace
 * the placeholder array with a real fetch() to
 *   https://distribution-xml.booking.com/2.x/hotels
 * Cap + tenantId guard stays unchanged across the swap.
 *
 * Contract: each hotel has { id, name, address, priceFromCents,
 * currency, cancellationPolicy, vendor: 'booking.com' }.
 */
async function searchHotels({
  tenantId,
  destination,
  checkIn,
  checkOut,
  guests = 2,
  rooms = 1,
  subBrand,
}) {
  if (!tenantId) throw new Error('tenantId required');
  await module.exports.checkBudgetCap(tenantId);

  console.log(
    `[bookingCom STUB] searchHotels: tenantId=${tenantId} subBrand=${subBrand || 'none'} destination=${destination} dates=${checkIn}..${checkOut} guests=${guests} rooms=${rooms}`,
  );

  // STUB: Booking.com Affiliate API integration pending Q11 creds.
  // Deterministic placeholder data — stable hotel IDs / names so spec
  // snapshots + downstream rendering tests don't churn between runs.
  const hotels = [
    {
      id: 'bcom-stub-hotel-001',
      name: 'The Cosmopolitan Stub Hotel',
      address: `${destination || 'Unknown'} — Stub Lane 1`,
      priceFromCents: 1250000, // $12,500 / night placeholder
      currency: 'USD',
      cancellationPolicy: 'free-cancel-24h',
      vendor: 'booking.com',
    },
    {
      id: 'bcom-stub-hotel-002',
      name: 'Stub Heritage Inn',
      address: `${destination || 'Unknown'} — Stub Lane 2`,
      priceFromCents: 850000,
      currency: 'USD',
      cancellationPolicy: 'free-cancel-48h',
      vendor: 'booking.com',
    },
    {
      id: 'bcom-stub-hotel-003',
      name: 'Budget Stub Lodge',
      address: `${destination || 'Unknown'} — Stub Lane 3`,
      priceFromCents: 350000,
      currency: 'USD',
      cancellationPolicy: 'non-refundable',
      vendor: 'booking.com',
    },
    {
      id: 'bcom-stub-hotel-004',
      name: 'Stub Boutique Residences',
      address: `${destination || 'Unknown'} — Stub Lane 4`,
      priceFromCents: 1800000,
      currency: 'USD',
      cancellationPolicy: 'free-cancel-24h',
      vendor: 'booking.com',
    },
  ];

  return {
    stub: true,
    tenantId,
    subBrand: subBrand || null,
    query: { destination, checkIn, checkOut, guests, rooms },
    hotels,
    note: 'Booking.com Affiliate API integration pending Q11 vendor handover. Real hotel inventory will populate once the partner-account swap is done. Per DC-1 RESOLVED 2026-05-24, Booking.com is priority over Expedia (Phase 2 deferred).',
  };
}

/**
 * Get hotel details for a specific Booking.com hotelId.
 *
 * STUB: Booking.com Affiliate API integration pending Q11 creds. Returns
 * a deterministic detail object with a rooms array. When creds arrive,
 * replace with a real GET to the Booking.com hotels endpoint.
 */
async function getHotelDetails(hotelId, tenantId) {
  if (!tenantId) throw new Error('tenantId required');
  if (!hotelId) throw new Error('hotelId required');
  await module.exports.checkBudgetCap(tenantId);

  console.log(
    `[bookingCom STUB] getHotelDetails: tenantId=${tenantId} hotelId=${hotelId}`,
  );

  // STUB: Booking.com Affiliate API integration pending Q11 creds.
  return {
    stub: true,
    tenantId,
    hotel: {
      id: hotelId,
      name: 'Stub Hotel Details',
      address: 'Stub Address, Stub City',
      vendor: 'booking.com',
      starRating: 4,
      amenities: ['wifi', 'parking', 'breakfast', 'pool'],
      rooms: [
        {
          id: `${hotelId}-room-std`,
          type: 'standard',
          priceFromCents: 350000,
          currency: 'USD',
          maxOccupancy: 2,
          cancellationPolicy: 'free-cancel-24h',
        },
        {
          id: `${hotelId}-room-deluxe`,
          type: 'deluxe',
          priceFromCents: 650000,
          currency: 'USD',
          maxOccupancy: 3,
          cancellationPolicy: 'free-cancel-24h',
        },
        {
          id: `${hotelId}-room-suite`,
          type: 'suite',
          priceFromCents: 1500000,
          currency: 'USD',
          maxOccupancy: 4,
          cancellationPolicy: 'non-refundable',
        },
      ],
    },
    note: 'Booking.com Affiliate API integration pending Q11 vendor handover.',
  };
}

/**
 * Book a hotel via Booking.com Affiliate Partner API.
 *
 * STUB: live booking requires Phase 1 creds + production cutover, so this
 * function deliberately throws 503 BOOKING_COM_NOT_YET_ENABLED until Q11
 * creds drop AND the cutover decision is made. Search / details work in
 * stub mode (read-only); writes do not, to prevent any pre-cred booking
 * attempts from creating phantom commitments.
 */
async function bookHotel(_params) {
  // STUB: Booking.com Affiliate API integration pending Q11 creds.
  // Writes are explicitly disabled in stub mode; only reads (search /
  // details) return placeholder data.
  const err = new Error(
    'Booking.com live booking is not yet enabled. Phase 1 pending Q11 vendor handover + production cutover. Read-only stubs (searchHotels, getHotelDetails) work; writes do not.',
  );
  err.code = 'BOOKING_COM_NOT_YET_ENABLED';
  err.statusCode = 503;
  throw err;
}

// Touch prisma so the imported binding isn't flagged unused — real-mode
// swap will likely need direct prisma access for future
// BookingComBookingLog writes (mirror llmRouter's LlmCallLog pattern).
// Keeping the import explicit here makes the swap a one-line change.
void prisma;

module.exports = {
  searchHotels,
  getHotelDetails,
  bookHotel,
  checkBudgetCap,
  computeMonthlySpendCents,
  INTEGRATION,
  BUDGET_CAP_KEY,
  DEFAULT_CAP_CENTS,
};
