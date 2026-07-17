// Travel CRM — pricing engine.
//
// Pure functions that compose:
//   - baseRate    (from a TravelCostMaster row)
//   - seasonMul   (max multiplier among active TravelSeasonCalendar rows
//                  that contain the trip date)
//   - markup      (best-match TravelMarkupRule, by priority)
//
// All inputs are plain JS objects — the route handler does the Prisma
// lookups and feeds the helper a list of candidate rows. Pure surface
// so we can vitest the math without touching the DB.
//
// Why pure: pricing is the kind of code that ABSOLUTELY needs to
// reproduce yesterday's quote bit-for-bit a year from now (refund
// dispute resolution, audit). Keeping the math out of the route +
// out of Prisma means the audit-snapshot stored on the Itinerary
// can be replayed deterministically against the same row inputs.
//
// See docs/TRAVEL_CRM_PRD.md §4.3 + §5.1.

/**
 * @typedef {Object} CostRow
 * @property {number} baseRate
 * @property {string} category
 * @property {string} subBrand
 * @property {string} routeOrSku
 */

/**
 * @typedef {Object} SeasonRow
 * @property {string} subBrand
 * @property {string|Date} startDate
 * @property {string|Date} endDate
 * @property {number|null} multiplier
 * @property {boolean} [isActive]
 */

/**
 * @typedef {Object} MarkupRow
 * @property {string} subBrand
 * @property {string} scope          // flight | hotel | transport | package
 * @property {string} matchKeyJson   // JSON for the scope-specific match keys
 * @property {number|null} markupPct
 * @property {number|null} markupFlat
 * @property {number|null} minPax    // minimum pax count for the rule to apply (AC-6.2 group discount)
 * @property {number|null} ownerUserId
 * @property {number} priority
 * @property {boolean} isActive
 */

/**
 * @typedef {Object} QuoteResult
 * @property {number} baseRate          As supplied
 * @property {number} seasonMultiplier  1.0 when no season matched
 * @property {number} markupAmount      Pct on top of (base*season) OR flat
 * @property {number} subtotal          baseRate * seasonMultiplier
 * @property {number} grandTotal        subtotal + markupAmount
 * @property {string|null} matchedSeasonName
 * @property {number|null} matchedMarkupRuleId
 * @property {number|null} matchedMarkupMinPax  minPax threshold of the matched rule, null if no rule or no minPax
 * @property {string[]} warnings
 */

function _toDate(v) {
  if (v instanceof Date) return v;
  return new Date(v);
}

/**
 * Pick the season-multiplier that applies on `tripDate`. Multiple
 * overlapping season rows are allowed (e.g. "school-holiday" + "peak"
 * both cover 1-Jun → 30-Jun).
 *
 * Selection rule: the FIRST eligible row in the input array wins.
 * "Eligible" means (subBrand match) ∧ (isActive !== false) ∧ (tripDate
 * within [startDate, endDate]). Authors curate priority via array
 * order — earlier in the array = higher priority. This is more
 * predictable than "highest multiplier wins" because lean-season
 * discounts (multiplier < 1.0) need to be selectable too; a
 * "highest wins" rule would silently never apply a discount when
 * any other ≥1.0 season also overlapped.
 *
 * Returns { multiplier, matchedSeasonName }. When no row matches,
 * returns { multiplier: 1.0, matchedSeasonName: null }.
 */
function pickSeason(seasons, tripDate, subBrand) {
  const date = _toDate(tripDate);
  for (const s of seasons || []) {
    if (s.subBrand !== subBrand) continue;
    if (s.isActive === false) continue;
    const start = _toDate(s.startDate);
    const end = _toDate(s.endDate);
    if (!(date >= start && date <= end)) continue;
    return {
      multiplier: s.multiplier != null ? Number(s.multiplier) : 1.0,
      matchedSeasonName: s.seasonName || null,
    };
  }
  return { multiplier: 1.0, matchedSeasonName: null };
}

/**
 * Pick the markup rule that applies. Rules are scoped to (subBrand,
 * scope) and ranked by `priority` ascending (lower number = higher
 * priority — matches the existing CRM's pipeline/automation
 * convention). Returns the first active rule that matches; per-user
 * rules win when both a global and a per-user rule are eligible
 * because the route should pass ownerUserId only when the caller is
 * acting as that user.
 *
 * minPax filtering (AC-6.2): a rule with minPax set only applies when
 * the supplied paxCount meets or exceeds that threshold. Rules with no
 * minPax (null / undefined) apply regardless of paxCount.
 *
 * Returns { rule, markupAmount } where markupAmount is computed
 * against the supplied subtotal.
 */
function pickMarkup(rules, subBrand, scope, subtotal, ownerUserId = null, paxCount = null) {
  const eligible = (rules || [])
    .filter((r) => r.isActive !== false)
    .filter((r) => r.subBrand === subBrand)
    .filter((r) => r.scope === scope)
    .filter((r) => r.ownerUserId == null || r.ownerUserId === ownerUserId)
    .filter((r) => r.minPax == null || (paxCount != null && paxCount >= r.minPax));
  if (eligible.length === 0) return { rule: null, markupAmount: 0 };

  eligible.sort((a, b) => {
    const pa = a.priority ?? 1000;
    const pb = b.priority ?? 1000;
    return pa - pb;
  });
  const rule = eligible[0];
  let amount = 0;
  if (rule.markupPct != null) {
    amount = subtotal * (Number(rule.markupPct) / 100);
  } else if (rule.markupFlat != null) {
    amount = Number(rule.markupFlat);
  }
  return { rule, markupAmount: Math.round(amount * 100) / 100 };
}

/**
 * Compose the full quote. Inputs are plain objects so the route can
 * pass arrays from Prisma directly.
 *
 * @param {{
 *   cost: CostRow,
 *   seasons: SeasonRow[],
 *   rules: MarkupRow[],
 *   subBrand: string,
 *   tripDate: string|Date,
 *   ownerUserId?: number|null,
 *   paxCount?: number|null,
 * }} input
 * @returns {QuoteResult}
 */
function quote(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("quote: input must be an object");
  }
  const { cost, seasons = [], rules = [], subBrand, tripDate, ownerUserId = null, paxCount = null } = input;
  if (!cost || typeof cost !== "object") {
    throw new TypeError("quote: cost row required");
  }
  if (!subBrand) {
    throw new TypeError("quote: subBrand required");
  }

  const warnings = [];
  const baseRate = Number(cost.baseRate) || 0;

  // 1. Season multiplier
  const seasonRes = pickSeason(seasons, tripDate, subBrand);
  if (seasons.length > 0 && seasonRes.matchedSeasonName === null) {
    warnings.push(`no-season-matched:${subBrand}:${_toDate(tripDate).toISOString().slice(0, 10)}`);
  }

  const subtotal = Math.round(baseRate * seasonRes.multiplier * 100) / 100;

  // 2. Markup — scope inferred from cost row's category mapping
  const scope = mapCategoryToScope(cost.category);
  const markupRes = pickMarkup(rules, subBrand, scope, subtotal, ownerUserId, paxCount);
  if (rules.length > 0 && markupRes.rule === null) {
    warnings.push(`no-markup-rule-matched:${subBrand}:${scope}`);
  }

  const grandTotal = Math.round((subtotal + markupRes.markupAmount) * 100) / 100;

  return {
    baseRate,
    seasonMultiplier: seasonRes.multiplier,
    markupAmount: markupRes.markupAmount,
    subtotal,
    grandTotal,
    matchedSeasonName: seasonRes.matchedSeasonName,
    matchedMarkupRuleId: markupRes.rule?.id ?? null,
    matchedMarkupMinPax: markupRes.rule?.minPax ?? null,
    warnings,
  };
}

/**
 * Cost-category → markup-scope translation. Cost-master uses
 * {hotel, flight, transport, visa, insurance}; markup rules use a
 * slightly wider {flight, hotel, transport, package}. Map them so
 * the route doesn't have to keep two parallel enums in its head.
 *
 * Returns the scope verbatim if the input is already a scope value.
 */
function mapCategoryToScope(category) {
  if (!category) return "package";
  if (category === "visa" || category === "insurance") return "package"; // packaged into trip total
  return category; // hotel | flight | transport pass through
}

module.exports = { quote, pickSeason, pickMarkup, mapCategoryToScope };
