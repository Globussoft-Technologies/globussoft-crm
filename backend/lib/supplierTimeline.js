// Travel CRM — Supplier Timeline composer (PRD_TRAVEL_SUPPLIER_MASTER §3.7.a
// "per-supplier dashboard" + §3.1.g "dispute history + chargeback log").
//
// Slice 21 of #903. Pure helper that merges + sorts heterogeneous event
// streams for ONE supplier into a single chronologically-descending feed
// suitable for a supplier detail-page "Activity" / "Timeline" widget.
//
// Sources merged in this slice (all derived from existing models — no schema
// edit needed):
//
//   - SUPPLIER_CREATED       — from TravelSupplier.createdAt
//   - SUPPLIER_UPDATED       — from TravelSupplier.updatedAt if strictly
//                              later than createdAt (>1s delta to ignore the
//                              same-transaction createdAt/updatedAt mirror)
//   - PAYABLE_CREATED        — one per TravelSupplierPayable.createdAt
//   - PAYABLE_PAID           — one per TravelSupplierPayable with paidAt set
//   - PAYABLE_CANCELLED      — one per TravelSupplierPayable with status=cancelled
//                              (uses updatedAt as the event timestamp; payables
//                              do not have a dedicated cancelledAt column)
//   - CREDENTIAL_CREATED     — one per SupplierCredential.createdAt
//   - CREDENTIAL_ACCESS_*    — one per SupplierCredentialAccessLog row
//                              (kind = CREDENTIAL_<ACTION.toUpperCase()> e.g.
//                              CREDENTIAL_ROTATED, CREDENTIAL_VIEWED,
//                              CREDENTIAL_USED_IN_CHECKIN, CREDENTIAL_DELETED).
//
// Sort: descending by `at` (newest first). Within the same `at`, deterministic
// secondary sort by (kind, id) so two events at the exact same millisecond
// have a stable order across calls — useful for cursor pagination later.
//
// Limit applied AFTER merge + sort so the caller can pass per-source
// findMany takes that are larger than the limit if they want a wider sample
// window (e.g. take 200 of each, surface top 50).
//
// Pure JS — no Prisma, no fetch, no IO. Route consumption (the supplier
// /timeline endpoint feeding the Travel admin's supplier-detail dashboard)
// lands alongside this helper.

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Compose a chronological supplier timeline from raw event sources.
 *
 * @param {object} sources
 * @param {object} sources.supplier        — TravelSupplier row (id, createdAt, updatedAt)
 * @param {Array}  [sources.payables]      — TravelSupplierPayable[]
 * @param {Array}  [sources.credentials]   — SupplierCredential[]
 * @param {Array}  [sources.accessLog]     — SupplierCredentialAccessLog[]
 * @param {object} [opts]
 * @param {number} [opts.limit=100]        — max events returned (clamped to 500)
 * @param {Date|string} [opts.since]       — only events strictly after this
 * @returns {Array<{kind, at, ...payload}>}
 */
function composeSupplierTimeline(sources, opts = {}) {
  const events = [];
  const { supplier, payables = [], credentials = [], accessLog = [] } = sources || {};

  if (supplier && supplier.createdAt) {
    events.push({
      kind: "SUPPLIER_CREATED",
      at: toDate(supplier.createdAt),
      id: `supplier-created-${supplier.id}`,
      supplierId: supplier.id,
    });
    if (supplier.updatedAt) {
      const created = toDate(supplier.createdAt).getTime();
      const updated = toDate(supplier.updatedAt).getTime();
      // 1s threshold — Prisma auto-stamps updatedAt at row create alongside
      // createdAt; the mirror is typically <1ms apart. Treating anything
      // beyond 1s as a real update event.
      if (Number.isFinite(updated) && updated - created > 1000) {
        events.push({
          kind: "SUPPLIER_UPDATED",
          at: new Date(updated),
          id: `supplier-updated-${supplier.id}`,
          supplierId: supplier.id,
        });
      }
    }
  }

  for (const p of payables) {
    if (p.createdAt) {
      events.push({
        kind: "PAYABLE_CREATED",
        at: toDate(p.createdAt),
        id: `payable-created-${p.id}`,
        payableId: p.id,
        amount: p.amount != null ? Number(p.amount) : null,
        currency: p.currency || null,
        poNumber: p.poNumber || null,
      });
    }
    if (p.paidAt) {
      events.push({
        kind: "PAYABLE_PAID",
        at: toDate(p.paidAt),
        id: `payable-paid-${p.id}`,
        payableId: p.id,
        amount: p.amount != null ? Number(p.amount) : null,
        currency: p.currency || null,
        poNumber: p.poNumber || null,
      });
    }
    if (p.status === "cancelled" && p.updatedAt) {
      events.push({
        kind: "PAYABLE_CANCELLED",
        at: toDate(p.updatedAt),
        id: `payable-cancelled-${p.id}`,
        payableId: p.id,
        amount: p.amount != null ? Number(p.amount) : null,
        currency: p.currency || null,
        poNumber: p.poNumber || null,
      });
    }
  }

  for (const c of credentials) {
    if (c.createdAt) {
      events.push({
        kind: "CREDENTIAL_CREATED",
        at: toDate(c.createdAt),
        id: `credential-created-${c.id}`,
        credentialId: c.id,
        category: c.category || null,
      });
    }
  }

  for (const a of accessLog) {
    if (!a.at) continue;
    const action = (a.action || "unknown")
      .toString()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_");
    events.push({
      kind: `CREDENTIAL_${action}`,
      at: toDate(a.at),
      id: `accesslog-${a.id}`,
      credentialId: a.credentialId,
      userId: a.userId,
    });
  }

  // ?since=ISODate filter — strict-after semantics so paginating from a
  // known cursor doesn't re-deliver the cursor event itself.
  if (opts.since != null) {
    const since = toDate(opts.since);
    if (Number.isFinite(since.getTime())) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].at.getTime() <= since.getTime()) events.splice(i, 1);
      }
    }
  }

  // Sort: newest first. Tiebreaker on (kind, id) so duplicate-timestamp
  // events are deterministic across calls.
  events.sort((a, b) => {
    const t = b.at.getTime() - a.at.getTime();
    if (t !== 0) return t;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  const limit = clampLimit(opts.limit);
  return events.slice(0, limit);
}

function toDate(d) {
  if (d instanceof Date) return d;
  return new Date(d);
}

function clampLimit(n) {
  if (n == null) return DEFAULT_LIMIT;
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1) return DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

module.exports = {
  composeSupplierTimeline,
  TIMELINE_DEFAULT_LIMIT: DEFAULT_LIMIT,
  TIMELINE_MAX_LIMIT: MAX_LIMIT,
};
