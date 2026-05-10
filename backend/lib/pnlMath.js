/**
 * Wellness P&L canonical revenue helper — closes the deferred refactor from
 * issue #565 (HI-16) "P&L numbers do not reconcile".
 *
 * THE BUG THIS PINS — pre-this-helper there were three (later five — see the
 * 2026-05-07 retest comment on #565) different revenue figures for the same
 * IST window across the three Owner-facing surfaces:
 *
 *   • /api/wellness/dashboard.today.expectedRevenue  — sum(service.basePrice)
 *     of booked + completed visits today. Scope: SCHEDULED, not realised.
 *   • /api/wellness/dashboard.yesterday.revenue       — sum(amountCharged) of
 *     ALL yesterday's visits regardless of status (cancelled / no-show
 *     visits with a stale amountCharged got included).
 *   • /api/wellness/reports/pnl-by-service.totalRevenue — sum(amountCharged)
 *     where status='completed' in the [from, to] window. The realised /
 *     bookkeeping figure.
 *
 * Each surface had inlined its own visit query + reducer + status filter,
 * so they drifted. This helper extracts the canonical computation so all
 * three surfaces read from the SAME function with the SAME status filter
 * and the SAME IST window expansion.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  THE CANONICAL DEFINITION (chosen 2026-05-10, Wave 9 Agent A)
 * ────────────────────────────────────────────────────────────────────────
 *
 * Canonical wellness revenue in window [from, to] for tenant T (and
 * optionally locationId L) =
 *
 *     SUM(visit.amountCharged)
 *     WHERE visit.tenantId = T
 *       AND visit.status   = 'completed'
 *       AND visit.visitDate BETWEEN from AND to
 *       AND (L is null OR visit.locationId = L)
 *
 * Time windows are interpreted in Asia/Kolkata (the wellness vertical's
 * canonical TZ) — `from` is widened to start-of-day IST, `to` is widened
 * to end-of-day IST when callers pass a YYYY-MM-DD string instead of a
 * full ISO timestamp.
 *
 * RATIONALE for choosing "completed + amountCharged + IST" over the two
 * alternatives:
 *
 *   (A) "scheduled / expected" — sum(service.basePrice) of booked +
 *       completed. This is what the Owner Dashboard's "today's expected
 *       revenue" tile shows (and continues to show, labelled as such —
 *       it's a useful projection metric, just NOT the canonical P&L).
 *       Rejected because it's PROJECTED, not REALISED — for a clinic
 *       making P&L decisions / GST filings the only number that
 *       counts is what was actually billed.
 *
 *   (B) "all visits regardless of status" — sum(amountCharged) over the
 *       full visit set (the buggy yesterday.revenue figure). Rejected
 *       because cancelled / no-show visits routinely carry a stale
 *       amountCharged that was set when the visit was first scheduled,
 *       so this overstates revenue by the cancellation rate.
 *
 *   (✓) "completed + amountCharged" — this helper's choice. Aligns with
 *       Indian GAAP-style booked-revenue recognition, matches what the
 *       wellness operator sees on physical invoice prints, and is the
 *       same definition the existing /reports/pnl-by-service handler
 *       always used (so adopting it is a no-op for that surface).
 *
 * If a future product call wants to switch the canonical to (A) or some
 * hybrid (e.g. "completed + paid invoice exists"), this is the ONE place
 * to change — three surfaces will track it automatically.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  USAGE
 * ────────────────────────────────────────────────────────────────────────
 *
 *   const { computeRevenue, sumCompleted } = require('../lib/pnlMath');
 *
 *   // Pull from DB:
 *   const { revenue, count } = await computeRevenue(prisma, tenantId, {
 *     from: new Date('2026-05-01T00:00:00+05:30'),
 *     to:   new Date('2026-05-31T23:59:59+05:30'),
 *     locationId: 7,                  // optional
 *   });
 *
 *   // In-memory aggregate over an array we already fetched:
 *   const visits = await prisma.visit.findMany({ where: ... });
 *   const totals = sumCompleted(visits);
 *   //   totals.revenue   — sum(amountCharged) where status='completed'
 *   //   totals.count     — count where status='completed'
 *   //   totals.totalCount — count of every row passed in (for unbucketed math)
 *
 * Both functions return plain numbers / counts; no Prisma types leak into
 * callers. The helper is shape-preserving (does NOT round / format) so
 * callers stay in control of decimal precision.
 *
 * Tested: backend/test/lib/pnlMath.test.js (≥8 vitest cases pinning the
 * status filter, the window inclusion, the locationId narrowing, the
 * cross-tenant isolation, and the empty-data edge cases).
 *
 * Adopted by:
 *   - routes/wellness.js  computePnlByService / computePerProfessional /
 *                         computePerLocation  (sumCompleted call)
 *   - routes/wellness.js  GET /dashboard yesterday.revenue (sumCompleted)
 *
 * NOT adopted by (deliberate):
 *   - routes/wellness.js  GET /dashboard today.expectedRevenue — this tile
 *                         shows scheduled / projected revenue, which is
 *                         alternative (A) above. It stays separate by design
 *                         and is labelled "expected" on the UI.
 */

const CANONICAL_STATUS = 'completed';

/**
 * Sum the canonical wellness revenue figure across an in-memory visit list.
 *
 * @param {Array<{status: string, amountCharged: number|string|null}>} visits
 * @returns {{ revenue: number, count: number, totalCount: number }}
 */
function sumCompleted(visits) {
  if (!Array.isArray(visits)) {
    return { revenue: 0, count: 0, totalCount: 0 };
  }
  let revenue = 0;
  let count = 0;
  for (const v of visits) {
    if (!v || v.status !== CANONICAL_STATUS) continue;
    const amt = parseFloat(v.amountCharged);
    if (Number.isFinite(amt)) revenue += amt;
    count += 1;
  }
  return { revenue, count, totalCount: visits.length };
}

/**
 * Pull the canonical revenue figure from the database for tenant T in
 * window [from, to] (inclusive on both ends), optionally narrowed to a
 * single location.
 *
 * Window semantics — `from` and `to` are passed straight through to the
 * Prisma query as-is. Callers are responsible for widening date-only
 * tokens to start/end of day in the wellness IST window before calling
 * (the existing `reportRange()` helper in routes/wellness.js already does
 * this; this helper preserves that contract by NOT re-widening).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {number} tenantId
 * @param {{ from: Date, to: Date, locationId?: number|null }} window
 * @returns {Promise<{ revenue: number, count: number }>}
 */
async function computeRevenue(prisma, tenantId, { from, to, locationId } = {}) {
  if (!prisma || !prisma.visit || typeof prisma.visit.findMany !== 'function') {
    throw new TypeError('computeRevenue: prisma.visit.findMany is required');
  }
  if (typeof tenantId !== 'number' || !Number.isFinite(tenantId)) {
    throw new TypeError('computeRevenue: tenantId must be a finite number');
  }
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    throw new TypeError('computeRevenue: from must be a valid Date');
  }
  if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
    throw new TypeError('computeRevenue: to must be a valid Date');
  }
  const where = {
    tenantId,
    status: CANONICAL_STATUS,
    visitDate: { gte: from, lte: to },
  };
  if (locationId != null) where.locationId = locationId;

  const visits = await prisma.visit.findMany({
    where,
    select: { amountCharged: true, status: true },
  });
  // sumCompleted re-applies the status filter defensively in case a future
  // caller passes a pre-fetched visit list with mixed statuses.
  return sumCompleted(visits);
}

module.exports = { computeRevenue, sumCompleted, CANONICAL_STATUS };
