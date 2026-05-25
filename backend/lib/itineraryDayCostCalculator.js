/**
 * Per-day cost aggregator for travel itinerary items (#907).
 *
 * Operators slice an itinerary into days for customer-facing PDF display
 * and supplier-payable reconciliation. This helper groups items by day
 * (using `dayOffset` from trip start, or explicit `dayNumber`/`date` field)
 * and sums costs.
 *
 * Day-resolution precedence (first non-null wins):
 *   1. `item.dayOffset`  (0-indexed from trip start) — preferred
 *   2. `item.dayNumber`  (1-indexed; converted internally as dayOffset = dayNumber - 1)
 *   3. `item.date`       (ISO date string; resolved against opts.tripStart, defaulting to today UTC)
 *
 * Items with none of the above, with an unparseable `date`, or with a
 * negative resolved dayOffset are skipped (not counted in any day, not
 * counted in the grand total). This keeps the contract predictable when
 * upstream data is partial — callers can validate input shape separately.
 *
 * Costs default to 0 when missing / non-numeric. Numeric strings ("100.50")
 * are coerced via Number() to ease consumption from JSON or DB string columns.
 *
 * Pure JS — no Prisma, no fetch.
 *
 * Refs #907.
 */

/**
 * @typedef {object} ItineraryItem
 * @property {number} [dayOffset]  0-indexed day from trip start (preferred)
 * @property {number} [dayNumber]  1-indexed day (alternate; converted to dayOffset internally)
 * @property {string} [date]       ISO date string (alternate; converted using tripStart)
 * @property {number|string} [cost] line cost in trip currency (numeric or numeric-string)
 * @property {string} [itemType]   hotel | flight | transport | activity | meal | other
 * @property {string} [description]
 */

/**
 * Resolve an item to a 0-indexed dayOffset using the precedence rules above.
 *
 * @param {ItineraryItem} item
 * @param {number} tripStartMs  UTC midnight ms for tripStart (precomputed by caller)
 * @returns {number|null}       dayOffset (>=0) or null if unresolvable / negative
 */
function resolveDayOffset(item, tripStartMs) {
  if (typeof item.dayOffset === 'number' && Number.isFinite(item.dayOffset)) {
    return item.dayOffset >= 0 ? item.dayOffset : null;
  }
  if (typeof item.dayNumber === 'number' && Number.isFinite(item.dayNumber)) {
    const offset = item.dayNumber - 1;
    return offset >= 0 ? offset : null;
  }
  if (item.date) {
    const itemDate = new Date(item.date);
    if (Number.isNaN(itemDate.getTime())) return null;
    const itemMs = Date.UTC(
      itemDate.getUTCFullYear(),
      itemDate.getUTCMonth(),
      itemDate.getUTCDate(),
    );
    const offset = Math.round((itemMs - tripStartMs) / 86_400_000);
    return offset >= 0 ? offset : null;
  }
  return null;
}

/**
 * Group items by day offset from trip start.
 *
 * @param {ItineraryItem[]} items
 * @param {object} [opts]
 * @param {Date} [opts.tripStart]  date trip starts (defaults to today UTC midnight). Required if items use `date`.
 * @returns {Map<number, ItineraryItem[]>}  keys are dayOffsets (0, 1, 2, ...)
 */
function groupItemsByDay(items, opts = {}) {
  const tripStart = opts.tripStart instanceof Date ? opts.tripStart : new Date();
  const tripStartMs = Date.UTC(
    tripStart.getUTCFullYear(),
    tripStart.getUTCMonth(),
    tripStart.getUTCDate(),
  );
  const byDay = new Map();
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    const dayOffset = resolveDayOffset(item, tripStartMs);
    if (dayOffset == null) continue;
    if (!byDay.has(dayOffset)) byDay.set(dayOffset, []);
    byDay.get(dayOffset).push(item);
  }
  return byDay;
}

/**
 * Compute per-day cost summary.
 *
 * @param {ItineraryItem[]} items
 * @param {object} [opts]
 * @param {Date} [opts.tripStart]
 * @returns {{
 *   days: Array<{
 *     dayOffset: number,
 *     items: ItineraryItem[],
 *     totalCost: number,
 *     itemCount: number,
 *     byType: Record<string, number>
 *   }>,
 *   grandTotal: number,
 *   totalDays: number,
 *   averageDailyCost: number
 * }}
 */
function computeDayCosts(items, opts = {}) {
  const byDay = groupItemsByDay(items || [], opts);
  const days = [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([dayOffset, dayItems]) => {
      const totalCost = round2(
        dayItems.reduce((sum, it) => sum + toNumber(it.cost), 0),
      );
      const byType = {};
      for (const it of dayItems) {
        const t = it.itemType || 'other';
        byType[t] = round2((byType[t] || 0) + toNumber(it.cost));
      }
      return {
        dayOffset,
        items: dayItems,
        totalCost,
        itemCount: dayItems.length,
        byType,
      };
    });
  const grandTotal = round2(days.reduce((s, d) => s + d.totalCost, 0));
  const totalDays = days.length;
  const averageDailyCost = totalDays > 0 ? round2(grandTotal / totalDays) : 0;
  return { days, grandTotal, totalDays, averageDailyCost };
}

/**
 * Coerce a value to a finite number (NaN / null / undefined → 0).
 *
 * @param {*} v
 * @returns {number}
 */
function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Round to 2 decimal places, half-up.
 *
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

module.exports = { groupItemsByDay, computeDayCosts };
