/**
 * Zikr Cabs Saudi ground-transfer API client. Stub-mode pending the Zikr
 * Cabs B2B API-access decision (issue #926's Decisions-needed block lists
 * vendor onboarding + API model + markup-engine integration + cancellation-
 * policy mapping as the four blockers).
 *
 * Architectural framing:
 *   - Saudi-side ground transfers for RFU Umrah pilgrim groups: Jeddah
 *     airport ↔ Makkah (~80km), Madinah ↔ Jeddah airport (~440km),
 *     Makkah ↔ Madinah (~450km). Quote alongside hotel + flight + HHR
 *     on the unified Umrah itinerary search surface (future). Typical
 *     vehicle classes: sedan (1-3 pax), van (4-8 pax — RFU's default
 *     small-cohort van), minibus (9-15 pax), bus (16-30 pax).
 *   - Pricing varies by vehicle class + distance + group size +
 *     advance-booking window. Stub returns deterministic placeholder
 *     transfers so downstream UI / spec snapshots stay reproducible
 *     until the real API lands.
 *
 * Eighth consumer of the cross-cutting per-tenant budget-cap pattern
 * (after llmRouter cb0901f, adsGptClient 9f35040, ratehawkClient 2852b82,
 * callifiedClient 9ec52df, bookingExpediaClient db06414, bookingCom
 * 1ab0c096, haramainRailClient f261222d). The cap KEYS registry in
 * `lib/tenantSettings.js` does not yet include 'zikr_cabs'. To avoid
 * touching tenantSettings.js (file-collision-risk with sibling agents),
 * we read the cap inline via `getSetting()` with an explicit fallback
 * constant — mirrors the haramainRailClient + bookingCom + bookingExpedia
 * pre-KEYS-extension workaround pattern. The canonical KEYS extension
 * lands in a separate tick once Zikr Cabs B2B API-access creds drop.
 *
 * Cred chase: GH #926 (RFU integration: Zikr Cabs ground-transfer API).
 * Cluster G in docs/MANUAL_CODING_BACKLOG.md.
 *
 * Pattern reference: backend/services/haramainRailClient.js (commit
 * f261222d, shipped tick #184). Tick #186 ship date: 2026-05-24.
 */

const prisma = require('../lib/prisma');
const { getSetting, evaluateCap } = require('../lib/tenantSettings');

const INTEGRATION = 'zikr_cabs';
const BUDGET_CAP_KEY = 'zikr_cabs.monthly_cap_cents';

// Default monthly cap — $300/mo (30000 cents). Lower than HHR's $500/mo
// because ground transfers are typically a single line-item per
// itinerary (1-2 transfers per pilgrim cohort) vs HHR's potentially
// recurring leg-of-trip charges. Overridable per-tenant via
// TenantSetting row OR via process.env.ZIKR_CABS_MONTHLY_CAP_USD_CENTS.
// TODO post-API-access-decision: promote into tenantSettings.KEYS +
// DEFAULTS so the canonical `getBudgetCap(tenantId, 'zikr_cabs')` path
// resolves without this inline workaround. See haramainRailClient.js
// header NOTE for the prior incarnation of this same pattern.
const DEFAULT_CAP_CENTS = Number(
  process.env.ZIKR_CABS_MONTHLY_CAP_USD_CENTS ?? 30000,
);

// Hard-coded deterministic vehicle catalogue (4 classes). Real-mode swap
// will fetch from the Zikr Cabs B2B API endpoint once access is granted.
// Stable transferIds + class shape so spec snapshots / UI tests don't
// churn. Vehicle-class taxonomy aligns with the typical Saudi
// ground-transfer market: sedan / van / minibus / bus.
//
// basePriceCents reflects a ~450km Madinah → Jeddah leg (Zikr Cabs'
// flagship route). Real-mode swap will compute per-route from the API's
// distance + class matrix. perPaxSupplementCents fires when
// passengerCount > baseCapacity (e.g. 5 pax in a sedan triggers an
// upgrade-line on the quote).
const VEHICLE_CATALOGUE = [
  {
    transferId: 'zikr-stub-sedan-001',
    vehicleClass: 'sedan',
    capacity: 3,
    baseCapacity: 3,
    durationMin: 360, // ~6h Madinah → Jeddah by sedan
    basePriceCents: 35000, // SAR 350 placeholder
    perPaxSupplementCents: 5000, // SAR 50 / extra-pax row (upgrade)
    currency: 'SAR',
  },
  {
    transferId: 'zikr-stub-van-001',
    vehicleClass: 'van',
    capacity: 8,
    baseCapacity: 8,
    durationMin: 360, // ~6h same leg by van (RFU default)
    basePriceCents: 60000, // SAR 600 placeholder
    perPaxSupplementCents: 8000, // SAR 80 / extra-pax row
    currency: 'SAR',
  },
  {
    transferId: 'zikr-stub-minibus-001',
    vehicleClass: 'minibus',
    capacity: 15,
    baseCapacity: 15,
    durationMin: 390, // ~6.5h same leg
    basePriceCents: 95000, // SAR 950 placeholder
    perPaxSupplementCents: 6000, // SAR 60 / extra-pax row
    currency: 'SAR',
  },
  {
    transferId: 'zikr-stub-bus-001',
    vehicleClass: 'bus',
    capacity: 30,
    baseCapacity: 30,
    durationMin: 420, // ~7h same leg by full bus
    basePriceCents: 150000, // SAR 1500 placeholder
    perPaxSupplementCents: 5000, // SAR 50 / extra-pax row
    currency: 'SAR',
  },
];

/**
 * Tenant-level enable check. Defaults to enabled; an admin can hide the
 * Zikr Cabs surface for a tenant by setting `zikr_cabs.disabled` =
 * 'true'. Mirrors the haramainRailClient + bookingCom default-on shape.
 */
async function isEnabledForTenant(tenantId) {
  if (!tenantId) return false;
  const disabled = await getSetting(tenantId, 'zikr_cabs.disabled', {
    coerce: (raw) => String(raw).toLowerCase() === 'true',
    fallback: false,
  });
  return !disabled;
}

/**
 * Pre-call cap check. Returns { withinCap, capCents, spentCents, percent, alertThreshold }.
 * Throws { code: 'ZIKR_CABS_BUDGET_EXCEEDED', spentCents, capCents } if
 * over cap. Console-warns at ≥80% (the canonical alert threshold).
 *
 * Spend source: future ZikrCabsBookingLog model (one row per Zikr Cabs
 * booking, costEstimate in Decimal SAR converted to USD cents). In stub
 * mode, returns 0 spend.
 */
async function checkBudgetCap(tenantId, _attemptedCostCents = 0) {
  // Inline cap read (workaround — KEYS doesn't include 'zikr_cabs'
  // yet). Once the API-access decision lands + KEYS is extended, swap
  // to:  const capCents = await getBudgetCap(tenantId, INTEGRATION);
  const capCents = await getSetting(tenantId, BUDGET_CAP_KEY, {
    coerce: Number,
    fallback: DEFAULT_CAP_CENTS,
  });
  // Resolve via module.exports so vi.spyOn(client, 'computeMonthlySpendCents')
  // in unit tests intercepts the call. Direct local-binding reference
  // would bypass the spy (closure-captured at module load). CJS
  // self-mocking seam — EIGHTH instance of this pattern (per CLAUDE.md
  // 2026-05-24 cron-learning: after safeEmitEvent, adsGptClient,
  // ratehawkClient, callifiedClient, bookingExpediaClient, bookingCom,
  // haramainRailClient).
  const spentCents = await module.exports.computeMonthlySpendCents(tenantId);
  const evaluation = evaluateCap(spentCents, capCents);
  if (!evaluation.withinCap) {
    const err = new Error('Monthly Zikr Cabs ground-transfer cap reached.');
    err.code = 'ZIKR_CABS_BUDGET_EXCEEDED';
    err.spentCents = spentCents;
    err.capCents = capCents;
    throw err;
  }
  if (evaluation.alertThreshold) {
    console.warn(
      `[zikrCabs] tenant ${tenantId} at ${Math.round(evaluation.percent * 100)}% of monthly Zikr Cabs cap ($${(spentCents / 100).toFixed(2)} / $${(capCents / 100).toFixed(2)})`,
    );
  }
  return evaluation;
}

async function computeMonthlySpendCents(_tenantId) {
  // STUB: Zikr Cabs B2B API integration pending the API-access decision
  // (#926). Real implementation will sum a future ZikrCabsBookingLog
  // model (one row per booking, costEstimate in Decimal USD-cent-
  // equivalent). Mirror the LlmCallLog spend-sum pattern in
  // backend/lib/llmRouter.js. For now returns 0 — stub never writes
  // spend rows.
  return 0;
}

/**
 * Hash helper — deterministic small-int hash of the stringified args
 * object. Used to seed price jitter so repeat searches with the same
 * inputs return identical price rows (mirror haramainRailClient's
 * passenger-count scaling determinism).
 */
function hashOfArgs(obj) {
  const s = JSON.stringify(obj || {});
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Search Zikr Cabs transfers for a given trip. Returns 3-4 deterministic
 * placeholder transfers filtered by vehicleClass (if provided) and
 * capacity ≥ passengerCount.
 *
 * STUB: Zikr Cabs API integration pending #926 cred drop. Returns rows
 * from the static VEHICLE_CATALOGUE with basePriceCents jittered by a
 * deterministic per-call seed (hash of route+date) so the same query
 * returns identical rows across calls but a different
 * fromCity/toCity/pickupDate triple returns slightly different prices.
 * When access is granted, replace the catalogue lookup with a real
 * fetch() to the Zikr Cabs pricing endpoint. Cap + tenantId guard stay
 * unchanged across the swap.
 *
 * Contract: each transfer has { transferId, vehicleClass, capacity,
 * durationMin, basePriceCents, currency: 'SAR', vendor: 'zikr.cabs' }.
 */
async function searchTransfers({
  tenantId,
  fromCity,
  toCity,
  pickupDate,
  vehicleClass,
  passengerCount = 1,
  subBrand,
}) {
  if (!tenantId) throw new Error('tenantId required');
  await module.exports.checkBudgetCap(tenantId);

  console.log(
    `[zikrCabs STUB] searchTransfers: tenantId=${tenantId} subBrand=${subBrand || 'none'} ${fromCity || '?'} → ${toCity || '?'} on ${pickupDate || '?'} class=${vehicleClass || 'any'} pax=${passengerCount}`,
  );

  // Deterministic price seed from (fromCity, toCity, pickupDate) — same
  // route+date returns identical jitter, different route+date diverges.
  // passengerCount is intentionally NOT in the seed (it scales the
  // per-pax supplement separately in getTransferDetails). vehicleClass
  // also stays out so all classes share the same per-route seed.
  const seed = hashOfArgs({ fromCity, toCity, pickupDate });
  // Jitter ±10% deterministically (seed % 21 - 10 = -10..+10 percent).
  const jitterPct = (seed % 21) - 10;

  // Filter by vehicleClass + by capacity ≥ passengerCount when both
  // gates would still leave ≥3 rows. Otherwise fall through to the full
  // catalogue (mirror haramainRailClient's "always return ≥2" approach
  // — we widen to "always return ≥3" since the spec calls for 3-4 rows).
  let filtered = VEHICLE_CATALOGUE.filter(
    (v) =>
      (!vehicleClass || v.vehicleClass === vehicleClass) &&
      v.capacity >= passengerCount,
  );
  if (filtered.length < 3) {
    // Drop the vehicleClass filter but KEEP the capacity gate so a 30-
    // pax cohort never sees a 3-pax sedan offered.
    filtered = VEHICLE_CATALOGUE.filter((v) => v.capacity >= passengerCount);
  }
  if (filtered.length < 3) {
    // Final fallback — capacity gate also dropped (e.g. impossibly
    // large group); return full catalogue so downstream UI still has
    // something to render.
    filtered = [...VEHICLE_CATALOGUE];
  }

  const transfers = filtered.map((v) => ({
    transferId: v.transferId,
    vehicleClass: v.vehicleClass,
    capacity: v.capacity,
    durationMin: v.durationMin,
    basePriceCents: Math.round(v.basePriceCents * (1 + jitterPct / 100)),
    currency: v.currency,
    vendor: 'zikr.cabs',
  }));

  return {
    stub: true,
    tenantId,
    subBrand: subBrand || null,
    query: {
      fromCity,
      toCity,
      pickupDate,
      vehicleClass,
      passengerCount,
    },
    transfers,
    note: 'Zikr Cabs Saudi ground-transfer API integration pending #926 cred drop (vendor onboarding + API-model + markup-engine + cancellation-policy decisions). Real vehicle inventory + per-class fares + group-discount tiers + cancellation-policy verbatim populate once cred-swap lands. Cluster G in docs/MANUAL_CODING_BACKLOG.md.',
  };
}

/**
 * Get detailed transfer info — adds driver-info placeholder +
 * cancellation policy snippet + total price (base + per-pax supplement
 * when passengerCount > baseCapacity).
 *
 * STUB: Zikr Cabs API integration pending #926. Returns deterministic
 * detail object. When access is granted, replace with a real GET to the
 * Zikr Cabs detail endpoint.
 */
async function getTransferDetails({ transferId, passengerCount = 1 }) {
  if (!transferId) throw new Error('transferId required');

  console.log(
    `[zikrCabs STUB] getTransferDetails: transferId=${transferId} pax=${passengerCount}`,
  );

  // Lookup placeholder; if transferId isn't in catalogue, synthesize
  // from the first row so spec tests against any id stay deterministic.
  const base =
    VEHICLE_CATALOGUE.find((v) => v.transferId === transferId) ||
    VEHICLE_CATALOGUE[0];

  // Per-pax supplement fires when passengerCount exceeds baseCapacity
  // (e.g. 5 pax in a sedan-3 triggers 2 extra-pax rows). Cap the
  // supplement count at 0 if pax ≤ baseCapacity (canonical sub-capacity
  // booking — no upgrade line).
  const overshoot = Math.max(0, passengerCount - base.baseCapacity);
  const supplement = overshoot * base.perPaxSupplementCents;
  const totalPriceCents = base.basePriceCents + supplement;

  return {
    stub: true,
    transfer: {
      transferId,
      vehicleClass: base.vehicleClass,
      capacity: base.capacity,
      baseCapacity: base.baseCapacity,
      durationMin: base.durationMin,
      basePriceCents: base.basePriceCents,
      perPaxSupplementCents: base.perPaxSupplementCents,
      supplementCents: supplement,
      totalPriceCents,
      currency: 'SAR',
      vendor: 'zikr.cabs',
      driver: {
        // Placeholder — real API surfaces driver name + phone + plate
        // post-booking confirmation. Stub returns a deterministic
        // shape so UI can render layout without real-data dependency.
        name: 'Driver TBA (stub)',
        phoneMasked: '+966-5XX-XXX-XXXX',
        languages: ['en', 'ar', 'ur'],
      },
      cancellationPolicy:
        'Full refund up to 48h before pickup; 50% refund 12-48h before; no refund within 12h. (Stub — Zikr Cabs policy verbatim copy pending #926 cred-drop.)',
    },
    note: 'Zikr Cabs Saudi ground-transfer API integration pending #926 cred drop.',
  };
}

/**
 * Book a Zikr Cabs transfer for a passenger group.
 *
 * STUB: live booking requires API access + production cutover, so this
 * function deliberately throws ZIKR_CABS_NOT_YET_ENABLED until #926
 * cred drop AND the cutover decision is made. Search / details work in
 * stub mode (read-only); writes do not, to prevent any pre-cred booking
 * attempts from creating phantom commitments.
 */
async function bookTransfer(_params) {
  // STUB: Zikr Cabs API integration pending #926 cred drop.
  // Writes are explicitly disabled in stub mode; only reads
  // (searchTransfers, getTransferDetails) return placeholder data.
  const err = new Error(
    'Zikr Cabs live booking is not yet enabled. Phase 1 pending #926 cred drop (vendor onboarding + API-model + markup-engine + cancellation-policy decisions). Read-only stubs (searchTransfers, getTransferDetails) work; writes do not.',
  );
  err.code = 'ZIKR_CABS_NOT_YET_ENABLED';
  err.statusCode = 503;
  throw err;
}

// Touch prisma so the imported binding isn't flagged unused — real-mode
// swap will likely need direct prisma access for future
// ZikrCabsBookingLog writes (mirror llmRouter's LlmCallLog pattern).
// Keeping the import explicit here makes the swap a one-line change.
void prisma;

module.exports = {
  isEnabledForTenant,
  searchTransfers,
  getTransferDetails,
  bookTransfer,
  checkBudgetCap,
  computeMonthlySpendCents,
  INTEGRATION,
  BUDGET_CAP_KEY,
  DEFAULT_CAP_CENTS,
};
