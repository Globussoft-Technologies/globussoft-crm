/**
 * tdsCalculation.js — Arc 2 #901 slice 21
 * ============================================================================
 *
 * Pure TDS (Tax Deducted at Source) withholding computation over an
 * invoice's existing line composition.
 *
 * PRD_TRAVEL_BILLING §3 — TDS is captured in TravelInvoiceLine rows whose
 * `lineType === 'tds'` (the lineType enum is a String column in Prisma —
 * the allowed values live in a comment on the schema column, NOT in a
 * Prisma `enum`). Operator adds TDS as a SEPARATE invoice line, NOT as a
 * boolean flag on the receivable lines. So the withholding total is just
 * `sum(amount for line where lineType === 'tds')`.
 *
 * This module exposes a single pure function that callers (currently the
 * /:id/issue handler on slice 5; future: invoice-PDF renderer, customer-
 * facing portal, payment-reconciliation cron) pass the in-memory lines
 * array to. NO Prisma access here — keeps it trivially unit-testable and
 * call-site-portable.
 *
 * Rounding convention: half-up to 2 decimal places, matching the rest of
 * the travel-invoice money math (PaymentSchedule milestones, FX baseAmount,
 * TCS amount). The standard JS-half-up idiom is
 *   Math.round((n + Number.EPSILON) * 100) / 100
 * — the Number.EPSILON nudge handles the 0.005 → 0.00 (not 0.01) IEEE-754
 * float quirk on legitimately-half values.
 *
 * Decimal-vs-Number contract: Prisma returns Decimal columns as
 * `Decimal` wrapper objects in some configurations and as plain strings
 * in others ($queryRaw, raw connection-pool reads). The helper coerces
 * via Number(line.amount) which handles both shapes (Decimal has
 * .toString() that survives the implicit conversion; strings parse via
 * the standard numeric coercion). Lines with non-numeric amount (NaN
 * after coercion) are SKIPPED rather than poisoning the sum — defensive
 * for production data that may have legacy rows from pre-slice-9.
 */

'use strict';

const TDS_LINE_TYPE = 'tds';

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Sum TDS withholding from an invoice's lines.
 *
 * @param {Array<{ lineType?: string|null, amount?: number|string|null, id?: number }>} lines
 *   Lines as returned by prisma.travelInvoiceLine.findMany. Each row must
 *   carry lineType (string) and amount (Decimal|number|string). Other
 *   fields are ignored. Pass [] for an invoice with no lines (returns
 *   { totalTds: 0, perLineTds: [] }).
 *
 * @returns {{ totalTds: number, perLineTds: Array<{ lineId: number|null, amount: number }> }}
 *   - totalTds: sum of amounts on lineType==='tds' rows, half-up rounded to 2dp.
 *   - perLineTds: each contributing TDS line's id + numeric amount (rounded
 *     to 2dp), in the input array's order. Empty array when there are no
 *     TDS lines. Used by callers that need to itemize the withholding for
 *     PDF rendering or audit logs.
 */
function computeTdsFromLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { totalTds: 0, perLineTds: [] };
  }

  const perLineTds = [];
  let runningSum = 0;

  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    if (line.lineType !== TDS_LINE_TYPE) continue;

    const raw = line.amount;
    if (raw === null || raw === undefined) continue;

    const num = Number(raw);
    if (!Number.isFinite(num)) continue;

    const rounded = round2(num);
    runningSum += rounded;
    perLineTds.push({
      lineId: Number.isFinite(line.id) ? line.id : null,
      amount: rounded,
    });
  }

  return {
    totalTds: round2(runningSum),
    perLineTds,
  };
}

module.exports = {
  computeTdsFromLines,
  TDS_LINE_TYPE,
};
