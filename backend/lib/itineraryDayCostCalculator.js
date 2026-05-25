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
 * @property {number|string} [cost] line cost in trip currency (numeric or numeric-string).
 *                                  Treated as the customer-facing total for the line. The
 *                                  per-day `totalCost` aggregates this field.
 * @property {number|string} [unitCost]  supplier-payable cost for the line (PRD §3.6(d)
 *                                       pricing transparency). Aggregates into per-day
 *                                       `supplierCost`. Falls back to `cost` when absent so
 *                                       callers that only pass `cost` still get a margin
 *                                       breakdown (with markup/gst=0).
 * @property {number|string} [markup]    operator markup added to unitCost (#907 slice 5).
 *                                       Aggregates into per-day `markupTotal`.
 * @property {number|string} [gstAmount] GST applied to the line. Aggregates into per-day
 *                                       `gstTotal`.
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
 * Each day surfaces the customer-facing aggregate (`totalCost`) plus the
 * margin breakdown (PRD §3.6(d) pricing transparency, #907 slice 5):
 *   - `supplierCost`  sum of unitCost (falls back to cost when unitCost
 *                     is absent on a line — keeps the contract usable for
 *                     callers that only pass top-line cost).
 *   - `markupTotal`   sum of markup; 0 when absent.
 *   - `gstTotal`      sum of gstAmount; 0 when absent.
 * The grand-total envelope mirrors the per-day shape (`grandSupplierCost`,
 * `grandMarkupTotal`, `grandGstTotal`) so consumers can render a
 * full-trip P&L without re-summing.
 *
 * Margin identity (informational, not enforced by the helper):
 *   totalCost ≈ supplierCost + markupTotal + gstTotal
 * Real-world lines often violate the identity (operator-entered totalPrice
 * is the source of truth, the components are estimates) — so we surface
 * BOTH the components AND the totalCost separately rather than reconciling.
 *
 * @param {ItineraryItem[]} items
 * @param {object} [opts]
 * @param {Date} [opts.tripStart]
 * @returns {{
 *   days: Array<{
 *     dayOffset: number,
 *     items: ItineraryItem[],
 *     totalCost: number,
 *     supplierCost: number,
 *     markupTotal: number,
 *     gstTotal: number,
 *     itemCount: number,
 *     byType: Record<string, number>
 *   }>,
 *   grandTotal: number,
 *   grandSupplierCost: number,
 *   grandMarkupTotal: number,
 *   grandGstTotal: number,
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
      // Per-line margin components. unitCost falls back to cost so callers
      // who only pass top-line cost still get a non-zero supplierCost.
      const supplierCost = round2(
        dayItems.reduce((sum, it) => {
          const u = it.unitCost != null ? toNumber(it.unitCost) : toNumber(it.cost);
          return sum + u;
        }, 0),
      );
      const markupTotal = round2(
        dayItems.reduce((sum, it) => sum + toNumber(it.markup), 0),
      );
      const gstTotal = round2(
        dayItems.reduce((sum, it) => sum + toNumber(it.gstAmount), 0),
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
        supplierCost,
        markupTotal,
        gstTotal,
        itemCount: dayItems.length,
        byType,
      };
    });
  const grandTotal = round2(days.reduce((s, d) => s + d.totalCost, 0));
  const grandSupplierCost = round2(days.reduce((s, d) => s + d.supplierCost, 0));
  const grandMarkupTotal = round2(days.reduce((s, d) => s + d.markupTotal, 0));
  const grandGstTotal = round2(days.reduce((s, d) => s + d.gstTotal, 0));
  const totalDays = days.length;
  const averageDailyCost = totalDays > 0 ? round2(grandTotal / totalDays) : 0;
  return {
    days,
    grandTotal,
    grandSupplierCost,
    grandMarkupTotal,
    grandGstTotal,
    totalDays,
    averageDailyCost,
  };
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
