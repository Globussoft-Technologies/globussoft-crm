/**
 * Haramain High-Speed Rail (HHR) pricing API client. Stub-mode pending
 * the HHR API-access decision (public B2C only, or B2B partner program —
 * issue #928's Decisions-needed block lists this as the first blocker).
 *
 * Architectural framing:
 *   - Saudi Arabia's HHR connects Makkah ↔ Madinah (~450km in 2.5h),
 *     the common alternative to the Madinah → Jeddah road transfer for
 *     RFU Umrah pilgrim groups. Quote alongside hotel + flight on the
 *     unified Umrah itinerary search surface (future).
 *   - Pricing varies by class (economy/business) + group size + advance-
 *     booking window. Stub returns deterministic placeholder routes so
 *     downstream UI / spec snapshots stay reproducible until the real
 *     API lands.
 *
 * Seventh consumer of the cross-cutting per-tenant budget-cap pattern
 * (after llmRouter cb0901f, adsGptClient 9f35040, ratehawkClient 2852b82,
 * callifiedClient 9ec52df, bookingExpediaClient db06414, bookingCom
 * 1ab0c096). The cap KEYS registry in `lib/tenantSettings.js` does not
 * yet include 'haramain_rail'. To avoid touching tenantSettings.js
 * (file-collision-risk with sibling agents), we read the cap inline via
 * `getSetting()` with an explicit fallback constant — mirrors the
 * bookingCom + bookingExpediaClient pre-KEYS-extension workaround
 * pattern. The canonical KEYS extension lands in a separate tick once
 * HHR API-access creds drop.
 *
 * Cred chase: GH #928 (RFU integration: Haramain High-Speed Rail
 * pricing API). Cluster G in docs/MANUAL_CODING_BACKLOG.md.
 *
 * Pattern reference: backend/services/bookingCom.js (commit 1ab0c096,
 * shipped tick #183). Tick #184 ship date: 2026-05-24.
 */

const prisma = require('../lib/prisma');
const { getSetting, evaluateCap } = require('../lib/tenantSettings');

const INTEGRATION = 'haramain_rail';
const BUDGET_CAP_KEY = 'budgetCap_haramain_rail_monthly_usd_cents';

// Default monthly cap — $500/mo (50000 cents). Higher than the hotel /
// LLM / AdsGPT defaults because HHR fares are typically $30-80 per
// passenger × group size (10-30 pax for RFU Umrah cohorts) so a few
// bookings burn through a lower cap fast. Overridable per-tenant via
// TenantSetting row OR via process.env.HARAMAIN_RAIL_MONTHLY_CAP_USD_CENTS.
// TODO post-API-access-decision: promote into tenantSettings.KEYS +
// DEFAULTS so the canonical `getBudgetCap(tenantId, 'haramain_rail')`
// path resolves without this inline workaround. See bookingCom.js
// header NOTE for the prior incarnation of this same pattern.
const DEFAULT_CAP_CENTS = Number(
  process.env.HARAMAIN_RAIL_MONTHLY_CAP_USD_CENTS ?? 50000,
);

// Hard-coded deterministic route catalogue (3 routes). Real-mode swap
// will fetch from the HHR API endpoint once access is granted. Stable
// ids + departures so spec snapshots / UI tests don't churn. Times
// chosen to reflect the actual HHR timetable: Makkah → Madinah
// departures every 1-2h between 06:00 and 22:00, ~2.5h duration.
const ROUTE_CATALOGUE = [
  {
    trainId: 'hhr-stub-train-001',
    departure: '08:00',
    arrival: '10:30',
    durationMin: 150,
    classType: 'economy',
    basePriceCents: 15000, // SAR 150 placeholder
    currency: 'SAR',
  },
  {
    trainId: 'hhr-stub-train-002',
    departure: '12:00',
    arrival: '14:30',
    durationMin: 150,
    classType: 'economy',
    basePriceCents: 15000,
    currency: 'SAR',
  },
  {
    trainId: 'hhr-stub-train-003',
    departure: '16:00',
    arrival: '18:30',
    durationMin: 150,
    classType: 'business',
    basePriceCents: 30000, // SAR 300 placeholder (~2× economy)
    currency: 'SAR',
  },
];

/**
 * Tenant-level enable check. Defaults to enabled; an admin can hide
 * the HHR surface for a tenant by setting `haramain_rail.disabled` =
 * 'true'. Mirrors the bookingCom default-on shape.
 */
async function isEnabledForTenant(tenantId) {
  if (!tenantId) return false;
  const disabled = await getSetting(tenantId, 'haramain_rail.disabled', {
    coerce: (raw) => String(raw).toLowerCase() === 'true',
    fallback: false,
  });
  return !disabled;
}

/**
 * Pre-call cap check. Returns { withinCap, capCents, spentCents, percent, alertThreshold }.
 * Throws { code: 'HARAMAIN_RAIL_BUDGET_EXCEEDED', spentCents, capCents }
 * if over cap. Console-warns at ≥80% (the canonical alert threshold).
 *
 * Spend source: future HaramainRailBookingLog model (one row per HHR
 * booking, costEstimate in Decimal SAR converted to USD cents). In
 * stub mode, returns 0 spend.
 */
async function checkBudgetCap(tenantId, _attemptedCostCents = 0) {
  // Inline cap read (workaround — KEYS doesn't include 'haramain_rail'
  // yet). Once the API-access decision lands + KEYS is extended, swap
  // to:  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  const capCents = await getSetting(tenantId, BUDGET_CAP_KEY, {
    coerce: Number,
    fallback: DEFAULT_CAP_CENTS,
  });
  // Resolve via module.exports so vi.spyOn(client, 'computeMonthlySpendCents')
  // in unit tests intercepts the call. Direct local-binding reference
  // would bypass the spy (closure-captured at module load). CJS
  // self-mocking seam — seventh instance of this pattern (per CLAUDE.md
  // 2026-05-24 cron-learning).
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly Haramain High-Speed Rail cap reached.');
    err.code = 'HARAMAIN_RAIL_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(
      `[haramainRail] tenant ${tenantId} at ${Math.round(evaluation.percent * 100)}% of monthly Haramain Rail cap ($${(spentCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)})`,
    );
  }
  return evaluation;
}

async function computeMonthlySpendCents(_tenantId) {
  // STUB: Haramain High-Speed Rail API integration pending the API-
  // access decision (#928). Real implementation will sum a future
  // HaramainRailBookingLog model (one row per booking, costEstimate
  // in Decimal USD-cent-equivalent). Mirror the LlmCallLog spend-sum
  // pattern in backend/lib/llmRouter.js. For now returns 0 — stub
  // never writes spend rows.
  return 0;
}

/**
 * Search HHR routes for a given trip. Returns 2-3 deterministic
 * placeholder rows filtered by classType if provided.
 *
 * STUB: HHR API integration pending #928 cred drop. Returns rows
 * from the static ROUTE_CATALOGUE with prices scaled by passengerCount
 * so the test suite can pin (passengerCount=1) vs (passengerCount=4)
 * outputs. When access is granted, replace the catalogue lookup with
 * a real fetch() to the HHR pricing endpoint. Cap + tenantId guard
 * stays unchanged across the swap.
 *
 * Contract: each route has { trainId, departure, arrival, durationMin,
 * classType, basePriceCents, currency, vendor: 'haramain.rail' }.
 */
async function searchRoutes({
  tenantId,
  fromStation,
  toStation,
  travelDate,
  classType,
  passengerCount = 1,
  subBrand,
}) {
  if (!tenantId) throw new Error('tenantId required');
  await module.exports.checkBudgetCap(tenantId);

  console.log(
    `[haramainRail STUB] searchRoutes: tenantId=${tenantId} subBrand=${subBrand || 'none'} ${fromStation || '?'} → ${toStation || '?'} on ${travelDate || '?'} class=${classType || 'any'} pax=${passengerCount}`,
  );

  // STUB: filter the static catalogue by classType (if provided),
  // and scale the basePriceCents by passengerCount so multi-pax
  // queries return larger totals deterministically.
  const filtered = ROUTE_CATALOGUE.filter(
    (r) => !classType || r.classType === classType,
  );
  // Always return at least 2 entries to keep the search surface useful
  // even when classType filtering would zero out (e.g. an unknown class
  // value falls through to the full catalogue rather than [] — mirrors
  // the bookingCom "always return 3-4 placeholders" approach).
  const rows = (filtered.length >= 2 ? filtered : ROUTE_CATALOGUE).map((r) => ({
    ...r,
    basePriceCents: r.basePriceCents * Math.max(1, passengerCount),
    vendor: 'haramain.rail',
  }));

  return {
    stub: true,
    tenantId,
    subBrand: subBrand || null,
    query: { fromStation, toStation, travelDate, classType, passengerCount },
    routes: rows,
    note: 'Haramain High-Speed Rail API integration pending #928 cred drop (API-access decision — public B2C vs B2B partner program). Real route inventory + per-class fares + group-discount tiers populate once cred-swap lands. Cluster G in docs/MANUAL_CODING_BACKLOG.md.',
  };
}

/**
 * Get detailed route info (availability + per-class seat counts +
 * cancellation policy snippet).
 *
 * STUB: HHR API integration pending #928. Returns deterministic
 * detail object with seat availability across both classes. When
 * access is granted, replace with a real GET to the HHR detail
 * endpoint.
 */
async function getRouteDetails({ trainId, classType, passengerCount = 1 }) {
  if (!trainId) throw new Error('trainId required');

  console.log(
    `[haramainRail STUB] getRouteDetails: trainId=${trainId} class=${classType || 'any'} pax=${passengerCount}`,
  );

  // Lookup placeholder; if trainId isn't in catalogue, synthesize a
  // record so spec tests against any id stay deterministic.
  const base =
    ROUTE_CATALOGUE.find((r) => r.trainId === trainId) || ROUTE_CATALOGUE[0];

  return {
    stub: true,
    route: {
      trainId,
      departure: base.departure,
      arrival: base.arrival,
      durationMin: base.durationMin,
      classType: classType || base.classType,
      basePriceCents: base.basePriceCents * Math.max(1, passengerCount),
      currency: 'SAR',
      vendor: 'haramain.rail',
      availability: {
        economy: { seatsRemaining: 42, totalSeats: 200 },
        business: { seatsRemaining: 12, totalSeats: 40 },
      },
      cancellationPolicy:
        'Full refund up to 24h before departure; 50% refund 1-24h before; no refund within 1h. (Stub — HHR policy verbatim copy pending #928 cred-drop.)',
    },
    note: 'Haramain High-Speed Rail API integration pending #928 cred drop.',
  };
}

/**
 * Book HHR seats for a passenger group.
 *
 * STUB: live booking requires API access + production cutover, so
 * this function deliberately throws HARAMAIN_RAIL_NOT_YET_ENABLED
 * until #928 cred drop AND the cutover decision is made. Search /
 * details work in stub mode (read-only); writes do not, to prevent
 * any pre-cred booking attempts from creating phantom commitments.
 */
async function bookRoute(_params) {
  // STUB: HHR API integration pending #928 cred drop.
  // Writes are explicitly disabled in stub mode; only reads (search
  // routes, get details) return placeholder data.
  const err = new Error(
    'Haramain High-Speed Rail live booking is not yet enabled. Phase 1 pending #928 cred drop (API-access decision — public B2C vs B2B partner program). Read-only stubs (searchRoutes, getRouteDetails) work; writes do not.',
  );
  err.code = 'HARAMAIN_RAIL_NOT_YET_ENABLED';
  err.statusCode = 503;
  throw err;
}

// Touch prisma so the imported binding isn't flagged unused — real-
// mode swap will likely need direct prisma access for future
// HaramainRailBookingLog writes (mirror llmRouter's LlmCallLog
// pattern). Keeping the import explicit here makes the swap a
// one-line change.
void prisma;

module.exports = {
  isEnabledForTenant,
  searchRoutes,
  getRouteDetails,
  bookRoute,
  checkBudgetCap,
  computeMonthlySpendCents,
  INTEGRATION,
  BUDGET_CAP_KEY,
  DEFAULT_CAP_CENTS,
};
