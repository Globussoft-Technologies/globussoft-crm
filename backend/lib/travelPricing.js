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
 * matchContext (Issue 11): rules may carry a `matchKeyJson` object with
 * per-product / per-season filters (e.g. {"city":"Makkah"} or
 * {"seasonName":"hajj-2026"}). A rule matches when every key in its
 * matchKeyJson equals the corresponding value in matchContext. An empty
 * object or invalid JSON matches any context, so existing fallback rules
 * keep working.
 *
 * Returns { rule, markupAmount } where markupAmount is computed
 * against the supplied subtotal.
 */
function pickMarkup(rules, subBrand, scope, subtotal, ownerUserId = null, paxCount = null, matchContext = null) {
  function ruleMatchesContext(r) {
    const keyJson = String(r.matchKeyJson || "{}");
    let keys;
    try {
      keys = keyJson ? JSON.parse(keyJson) : {};
    } catch {
      return true; // malformed JSON acts as a wildcard (backward-compat)
    }
    if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.keys(keys).length === 0) {
      return true;
    }
    const ctx = matchContext && typeof matchContext === "object" ? matchContext : {};
    return Object.entries(keys).every(([k, v]) => ctx[k] === v);
  }

  const eligible = (rules || [])
    .filter((r) => r.isActive !== false)
    .filter((r) => r.subBrand === subBrand)
    .filter((r) => r.scope === scope)
    .filter((r) => r.ownerUserId == null || r.ownerUserId === ownerUserId)
    .filter((r) => r.minPax == null || (paxCount != null && paxCount >= r.minPax))
    .filter((r) => ruleMatchesContext(r));
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
 *   matchContext?: object|null,
 * }} input
 * @returns {QuoteResult}
 */
function quote(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("quote: input must be an object");
  }
  const { cost, seasons = [], rules = [], subBrand, tripDate, ownerUserId = null, paxCount = null, matchContext = null } = input;
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

  // 2. Markup — scope inferred from cost row's category mapping.
  //    Default matchContext carries the cost row + matched season so
  //    per-product / per-season markup rules (Issue 11) resolve.
  const scope = mapCategoryToScope(cost.category);
  const ctx = matchContext && typeof matchContext === "object"
    ? matchContext
    : {
        category: cost.category,
        routeOrSku: cost.routeOrSku,
        seasonName: seasonRes.matchedSeasonName,
      };
  const markupRes = pickMarkup(rules, subBrand, scope, subtotal, ownerUserId, paxCount, ctx);
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

/**
 * Best-effort extract of per-product match keys from a quote line's
 * free-text description. Used by composeQuoteBreakdown to let per-city /
 * per-route markup rules resolve on quote lines.
 */
function buildLineMatchContext(line, seasonName) {
  const ctx = {
    category: line.lineType || null,
    seasonName: seasonName || null,
  };
  const desc = String(line.description || "");
  if (line.lineType === "hotel") {
    const m = /,\s*([^—-]+?)\s*(?:—|-|$)/.exec(desc);
    if (m && m[1]) ctx.city = m[1].trim();
  }
  if (line.lineType === "flight" || line.lineType === "transport") {
    const m = /\b([A-Za-z]{3})\s*(?:→|->|to|-)\s*([A-Za-z]{3})\b/i.exec(desc);
    if (m) ctx.route = `${m[1].toUpperCase()}-${m[2].toUpperCase()}`;
  }
  return ctx;
}

/**
 * Compose a worked-example pricing breakdown for a TravelQuote + its lines.
 * This is the shared engine behind:
 *   - GET /api/travel/quotes/:id/pricing-preview
 *   - GET /api/travel/quotes/public/quote/:shareToken
 *
 * @param {Object} quote
 * @param {Array} lines
 * @param {Array} seasons
 * @param {Array} rules
 * @returns {Object} breakdown envelope
 */
function composeQuoteBreakdown(quote, lines, seasons, rules) {
  const round2 = (n) => Math.round(n * 100) / 100;
  const decoratedLines = [];
  const ruleAggregateById = new Map();
  let baseSubtotalAccum = 0;
  let seasonAdjustedSubtotalAccum = 0;

  const tripDate = quote.tripDate ? new Date(quote.tripDate) : null;
  const seasonResult = tripDate && !Number.isNaN(tripDate.getTime())
    ? pickSeason(seasons, tripDate, quote.subBrand)
    : { multiplier: 1.0, matchedSeasonName: null };

  for (const l of lines || []) {
    const baseAmount = Number(l.amount || 0);
    baseSubtotalAccum += baseAmount;
    const seasonAmount = round2(baseAmount * seasonResult.multiplier);
    seasonAdjustedSubtotalAccum += seasonAmount;

    const scope = mapCategoryToScope(l.lineType);
    const matchContext = buildLineMatchContext(l, seasonResult.matchedSeasonName);
    const { rule, markupAmount } = pickMarkup(
      rules,
      quote.subBrand,
      scope,
      seasonAmount,
      null,
      null,
      matchContext,
    );

    const finalAmount = round2(seasonAmount + markupAmount);
    decoratedLines.push({
      lineId: l.id,
      id: l.id,
      lineType: l.lineType,
      description: l.description,
      baseAmount: round2(baseAmount),
      amount: round2(baseAmount),
      seasonMultiplier: seasonResult.multiplier,
      matchedSeasonName: seasonResult.matchedSeasonName,
      seasonAmount,
      markupAmount: round2(markupAmount),
      markupRuleId: rule?.id ?? null,
      markupRuleName: rule?.matchKeyJson || null,
      finalAmount,
      amountWithMarkup: finalAmount,
    });

    if (rule && markupAmount > 0) {
      const prior = ruleAggregateById.get(rule.id);
      if (prior) {
        prior.amount = round2(prior.amount + markupAmount);
      } else {
        ruleAggregateById.set(rule.id, {
          ruleId: rule.id,
          ruleName: rule.matchKeyJson || `rule-${rule.id}`,
          percent: rule.markupPct != null ? Number(rule.markupPct) : null,
          amount: round2(markupAmount),
        });
      }
    }
  }

  const baseSubtotal = round2(baseSubtotalAccum);
  const subtotal = round2(seasonAdjustedSubtotalAccum);
  const markupApplied = Array.from(ruleAggregateById.values());
  const totalMarkup = markupApplied.reduce((acc, r) => acc + r.amount, 0);
  const total = round2(subtotal + totalMarkup);

  return {
    baseSubtotal,
    subtotal,
    markupApplied,
    total,
    matchedSeasonName: seasonResult.matchedSeasonName,
    seasonMultiplier: seasonResult.multiplier,
    tripDate: tripDate ? tripDate.toISOString().slice(0, 10) : null,
    lines: decoratedLines,
  };
}

module.exports = { quote, pickSeason, pickMarkup, mapCategoryToScope, composeQuoteBreakdown };
