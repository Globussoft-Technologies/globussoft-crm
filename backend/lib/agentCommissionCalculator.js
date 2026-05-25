// Travel CRM — B2B agent commission calculator (pure math).
//
// Slice 1 of the #905 B2B Agent Portal module (PRD:
// docs/PRD_TRAVEL_B2B_AGENT_PORTAL.md). Travel agencies (Travel Stall /
// TMC / RFU) work with downstream B2B agents who refer or sell trips on
// commission. This file ships ONLY the pure commission math against an
// in-memory profile object — no Prisma, no fetch, no IO. Schema
// (additive nullable AgentCommissionProfile) lands in slice 2; route
// consumption from invoice / sale flows lands in slice 3.
//
// === Supported profile types ===
//
//   flat_percent   — agent gets `percent`% of the sale value.
//   tiered         — agent gets `percent`% on each band, where each band
//                    covers (prev.uptoCents, this.uptoCents]. The last
//                    tier with `uptoCents == null` (or omitted) covers
//                    everything above the previous cap.
//   per_pax_flat   — agent gets `amountPerPax` × number of passengers,
//                    regardless of sale price.
//   hybrid         — agent gets `baseAmount` (always paid) plus
//                    `overagePercent`% on the portion of sale above
//                    `thresholdAmount`. Below threshold → just base.
//
// === Tier boundary semantics ===
//
// Each tier defines an UPPER cap. The band the tier covers is
// (prev_cap, this_cap], exclusive at the lower end and inclusive at the
// upper. Concretely, a tiers array of
//
//   [{ uptoCents: 50000, percent: 10 },
//    { uptoCents: 200000, percent: 5 },
//    { uptoCents: null,  percent: 2 }]
//
// against a sale of 100000 fills:
//   - band 0–50000 (width 50000)   at 10% → 5000
//   - band 50000–100000 (taken 50000) at 5%  → 2500
// → total 7500.
//
// This matches the way commission-statement vendors (TravClan / TBO / IATA
// IBE) compute tiered slabs: each percent applies to the SLICE inside its
// band, not to the whole cumulative figure. The alternative "winner takes
// all (highest band's percent on the entire sale)" semantics produces
// surprising step-function jumps at boundaries and is widely rejected by
// agents at month-end reconciliation, so don't add a flag for it — pin
// slab-style tiers and document.
//
// === Rounding ===
//
// Half-up to 2 decimal places via Math.round((n + Number.EPSILON) * 100)
// / 100. The Number.EPSILON nudge guards against the classic 1.005 → 1.00
// double-rounding error from the binary representation. Matches the way
// gstCalculation.js / tcsCalculation.js round, so the eventual
// invoice-render layer (slice 3 consumer) can sum commission + GST + TCS
// lines without 1-paisa reconciliation noise.
//
// === Defensive input handling ===
//
// Negative / NaN / non-numeric sale → coerced to 0.
// Missing or null profile → `{ commission: 0, breakdown: 'no profile' }`.
// Unknown profile.type → `{ commission: 0, breakdown: 'unknown profile type <type>' }`.
// These returns let the route layer surface the unrecoverable case as a
// clean 200-with-zero rather than a 500 throw — agents will see a $0
// commission row and audit-log can flag the misconfigured profile.

/**
 * @typedef {object} FlatPercentProfile
 * @property {"flat_percent"} type
 * @property {number} percent - e.g. 5 for 5%
 */

/**
 * @typedef {object} TieredProfile
 * @property {"tiered"} type
 * @property {Array<{ uptoCents: number|null, percent: number }>} tiers
 *   Each tier covers the band (prev.uptoCents, this.uptoCents] at this.percent.
 *   The last tier with uptoCents === null (or omitted) covers everything above.
 */

/**
 * @typedef {object} PerPaxProfile
 * @property {"per_pax_flat"} type
 * @property {number} amountPerPax - e.g. 500 for ₹500/pax
 */

/**
 * @typedef {object} HybridProfile
 * @property {"hybrid"} type
 * @property {number} baseAmount - base flat (always paid)
 * @property {number} overagePercent - % on amount above thresholdAmount
 * @property {number} thresholdAmount
 */

/**
 * Compute commission for a sale.
 *
 * @param {object} args
 * @param {number} args.saleAmount - sale total in operator's base currency
 * @param {number} [args.paxCount] - number of passengers (only used by per_pax_flat). Default 1.
 * @param {FlatPercentProfile|TieredProfile|PerPaxProfile|HybridProfile} args.profile
 * @returns {{ commission: number, breakdown: string, profileType: string }}
 */
function computeCommission({ saleAmount, paxCount = 1, profile } = {}) {
  // 0 / NaN / negative sale → 0 commission, defensive.
  const saleRaw = Number(saleAmount);
  const sale = Number.isFinite(saleRaw) && saleRaw > 0 ? saleRaw : 0;

  if (!profile || typeof profile !== "object") {
    return { commission: 0, breakdown: "no profile", profileType: "unknown" };
  }

  switch (profile.type) {
    case "flat_percent": {
      const pct = Number(profile.percent) || 0;
      const c = round2((sale * pct) / 100);
      return {
        commission: c,
        breakdown: `${pct}% of ${sale} = ${c}`,
        profileType: profile.type,
      };
    }

    case "tiered": {
      // Normalise: nulls become Infinity, sort ascending by cap so we walk
      // bands in order regardless of caller order.
      const tiers = (profile.tiers || [])
        .slice()
        .map((t) => ({
          cap: t.uptoCents == null ? Infinity : Number(t.uptoCents),
          percent: Number(t.percent) || 0,
        }))
        .sort((a, b) => a.cap - b.cap);

      let remaining = sale;
      let prevCap = 0;
      let total = 0;
      const parts = [];
      for (const tier of tiers) {
        if (remaining <= 0) break;
        const bandWidth = tier.cap - prevCap;
        if (bandWidth <= 0) {
          prevCap = tier.cap;
          continue;
        }
        const taken = Math.min(remaining, bandWidth);
        if (taken > 0) {
          const earned = (taken * tier.percent) / 100;
          total += earned;
          parts.push(`${taken}@${tier.percent}%=${round2(earned)}`);
          remaining -= taken;
        }
        prevCap = tier.cap;
      }
      return {
        commission: round2(total),
        breakdown: parts.length ? parts.join(" + ") : "no tier coverage",
        profileType: profile.type,
      };
    }

    case "per_pax_flat": {
      const perPax = Number(profile.amountPerPax) || 0;
      const paxRaw = Number(paxCount);
      const pax = Number.isFinite(paxRaw) && paxRaw > 0 ? paxRaw : 0;
      const c = round2(perPax * pax);
      return {
        commission: c,
        breakdown: `${pax} pax × ${perPax} = ${c}`,
        profileType: profile.type,
      };
    }

    case "hybrid": {
      const base = Number(profile.baseAmount) || 0;
      const threshold = Number(profile.thresholdAmount) || 0;
      const overagePct = Number(profile.overagePercent) || 0;
      const overage = Math.max(0, sale - threshold);
      const overageCommission = round2((overage * overagePct) / 100);
      const total = round2(base + overageCommission);
      return {
        commission: total,
        breakdown: `${base} base + ${overage} overage @ ${overagePct}% = ${total}`,
        profileType: profile.type,
      };
    }

    default:
      return {
        commission: 0,
        breakdown: `unknown profile type ${profile.type}`,
        profileType: String(profile.type),
      };
  }
}

/**
 * Half-up round to 2 decimal places. The Number.EPSILON nudge avoids the
 * binary-representation tie-breaker artefact (e.g. 1.005 → 1.00 instead
 * of 1.01). Matches the rounding in gstCalculation.js / tcsCalculation.js.
 *
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

module.exports = { computeCommission };
