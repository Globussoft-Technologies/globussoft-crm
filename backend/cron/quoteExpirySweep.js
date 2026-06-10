/**
 * backend/cron/quoteExpirySweep.js — daily expiry sweep for TravelQuote (C9).
 *
 * PRD_TRAVEL_QUOTE_BUILDER §3.7 — customer-accept landing + auto-expiry.
 *
 * Scans every Draft / Sent TravelQuote whose validUntil < now and flips
 * status → Expired. Writes an immutable TravelQuoteSnapshot row for each
 * transition (statusBefore=<current>, statusAfter='Expired', changedBy='system',
 * changeReason='validUntil passed') so the operator can reconstruct who-
 * expired-when from the version history.
 *
 * Schedule: 09:00 IST (03:30 UTC) daily — matches the cron-engine cohort
 * already shipping at this slot (lowStockEngine). The window is operator-
 * intuitive ("first thing in the morning") and well outside the customer
 * acknowledgement burst that follows an evening send.
 *
 * Idempotency: a quote already in Expired status is skipped. The snapshot
 * write is conditioned on the status transition actually happening (not
 * on validUntil alone), so re-running the cron — or running it after a
 * stale-replica read — never produces duplicate snapshot rows.
 *
 * Cross-tenant scope: the sweep is global (no tenantId filter on the
 * `prisma.travelQuote.findMany` call). Each tenant's quotes are processed
 * independently — a single-tenant failure does not abort the rest.
 *
 * Hard contract (tests pin every assertion):
 *   1. No expired quotes → returns { quotesSwept: 0, errors: [] }.
 *   2. Draft + validUntil < now → swept + snapshot row created.
 *   3. Sent + validUntil < now → swept + snapshot row created.
 *   4. Already-Expired quote → skipped (no update, no snapshot).
 *   5. Accepted / Rejected / Cancelled with old validUntil → skipped.
 *   6. Cross-tenant: each tenant's quotes are processed independently.
 *   7. Idempotency: re-running the sweep doesn't double-snapshot the
 *      same quote (because pass 2 sees status='Expired' and skips).
 */

const cron = require('node-cron');
const realPrisma = require('../lib/prisma');
const { writeAudit } = require('../lib/audit');

/**
 * One sweep pass. Returns { quotesSwept, errors }.
 *
 * @param {Object} [opts]
 * @param {Date}   [opts.now]    Override "now" for tests.
 * @param {Object} [opts.prisma] Override prisma client for tests.
 */
async function sweep({ now = new Date(), prisma = realPrisma } = {}) {
  const errors = [];
  let quotesSwept = 0;

  let candidates = [];
  try {
    candidates = await prisma.travelQuote.findMany({
      where: {
        status: { in: ['Draft', 'Sent'] },
        validUntil: { lt: now },
      },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });
  } catch (e) {
    errors.push({ stage: 'findMany', message: e.message });
    return { quotesSwept, errors };
  }

  for (const quote of candidates) {
    try {
      // Idempotency double-check — re-read the row in case a concurrent
      // operator action raced ahead. Cheap; one row per candidate.
      const live = await prisma.travelQuote.findFirst({
        where: { id: quote.id },
        select: { id: true, status: true, validUntil: true, tenantId: true },
      });
      if (!live) continue;
      if (live.status !== 'Draft' && live.status !== 'Sent') continue;
      if (!live.validUntil || new Date(live.validUntil).getTime() >= now.getTime()) {
        // Window has shifted; skip.
        continue;
      }

      const statusBefore = quote.status;

      // Next version number per quote.
      const latestSnap = await prisma.travelQuoteSnapshot.findFirst({
        where: { quoteId: quote.id },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true },
      });
      const versionNumber = latestSnap ? latestSnap.versionNumber + 1 : 1;

      // Snapshot the quote shape AT EXPIRY INSTANT.
      const snapshotJson = JSON.stringify({
        quote: {
          id: quote.id,
          tenantId: quote.tenantId,
          subBrand: quote.subBrand,
          contactId: quote.contactId,
          status: quote.status,
          totalAmount: quote.totalAmount,
          currency: quote.currency,
          validUntil: quote.validUntil,
          createdAt: quote.createdAt,
          updatedAt: quote.updatedAt,
        },
        lines: (quote.lines || []).map((l) => ({
          id: l.id,
          lineType: l.lineType,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.amount,
          currency: l.currency,
          supplierId: l.supplierId,
          sortOrder: l.sortOrder,
          notes: l.notes,
        })),
      });

      await prisma.travelQuote.update({
        where: { id: quote.id },
        data: { status: 'Expired' },
      });

      await prisma.travelQuoteSnapshot.create({
        data: {
          quoteId: quote.id,
          tenantId: quote.tenantId,
          versionNumber,
          snapshotJson,
          statusBefore,
          statusAfter: 'Expired',
          changedById: null,
          changedBy: 'system',
          changeReason: 'validUntil passed',
        },
      });

      try {
        await writeAudit(
          'TravelQuote',
          'TRAVEL_QUOTE_SYSTEM_EXPIRED',
          quote.id,
          null,
          quote.tenantId,
          {
            quoteId: quote.id,
            subBrand: quote.subBrand,
            contactId: quote.contactId,
            previousStatus: statusBefore,
            newStatus: 'Expired',
            validUntil: quote.validUntil,
            sweptAt: now.toISOString(),
          },
          { actorType: 'system' },
        );
      } catch (auditErr) {
        // Audit failure must not block the sweep.
        errors.push({ stage: 'audit', quoteId: quote.id, message: auditErr.message });
      }

      quotesSwept += 1;
    } catch (e) {
      errors.push({ stage: 'transition', quoteId: quote.id, message: e.message });
    }
  }

  return { quotesSwept, errors };
}

function initCron() {
  // 09:00 IST = 03:30 UTC. node-cron uses server time by default; the
  // explicit Asia/Kolkata timezone keeps behaviour consistent across
  // demo (UTC-host) and operator-local-time deploys.
  cron.schedule(
    '0 9 * * *',
    () => {
      sweep().then((r) => {
        if (r.quotesSwept > 0 || r.errors.length > 0) {
          console.log('[quoteExpirySweep]', r);
        }
      }).catch((e) => console.error('[quoteExpirySweep] fail:', e.message));
    },
    { timezone: 'Asia/Kolkata' },
  );
  console.log('[quoteExpirySweep] cron initialized (daily 09:00 IST)');
}

module.exports = {
  sweep,
  initCron,
};
