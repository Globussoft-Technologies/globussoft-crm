/**
 * Supplier-Payable Reminders Engine
 *
 * #903 Travel Supplier Master — Arc 2 follow-on (PRD_TRAVEL_SUPPLIER_MASTER.md
 * + PRD_TRAVEL_BILLING.md UC-2.3).
 *
 * Scans `TravelSupplierPayable` rows for payables whose `dueDate` falls within
 * reminder windows (T-7, T-3, T-1, T+0 days from "now", bucketed at UTC
 * midnight) and prepares reminder notifications for the supplier. Per PRD
 * UC-2.3 operators need scheduled chases for upcoming + due-today payables
 * ("Air India PO-2026-0123 due in 7 days, ₹45L") so the AP queue stays
 * current without manual scanning.
 *
 * STUB MODE (current default):
 *   Real WhatsApp/email delivery to suppliers is cred-blocked on Q9 (Wati
 *   API key). Today this engine logs `[supplier-payable-reminder STUB] ...`
 *   per match + writes an audit row with `stub: true` so the operator
 *   surface can see what would have been sent.
 *
 *   When Q9 creds drop, the wire-in slice passes a real `notify` callback
 *   into `runSupplierPayableRemindersEngine({ notify })` and the audit
 *   `stub` flag flips to `false` automatically.
 *
 * Window semantics (UTC midnight buckets):
 *   For each `days` in [7, 3, 1, 0] we compute the half-open window
 *   `[start-of-day(now+days), start-of-day(now+days+1))` and find every
 *   pending/scheduled payable whose `dueDate` falls inside it. UTC is
 *   the right anchor because (a) every payable's `dueDate` was stored
 *   as a UTC ISO string by the payable-CRUD routes (slice 3 — `59336ab7`),
 *   and (b) cron ticks happen every 4 hours so any local-TZ drift would
 *   silently double-fire or miss windows depending on the tick-of-day.
 *   UTC midnight buckets are deterministic: a given payable enters T-7
 *   exactly once during the UTC day that's 7 days before its dueDate's
 *   UTC day.
 *
 * Status filter:
 *   Only `pending` and `scheduled` payables trigger reminders. `paid` and
 *   `cancelled` are excluded:
 *     - `paid`      — nothing more to chase; reminding the supplier when
 *                     we already paid them would erode the relationship.
 *     - `cancelled` — operator explicitly killed the obligation (PO void,
 *                     duplicate entry, etc.); chasing would be wrong.
 *   Note: TravelSupplierPayable.status uses the 4-value set per the
 *   schema (pending | scheduled | paid | cancelled), DIFFERENT from
 *   TravelPaymentSchedule's (pending | partial | paid | overdue | waived).
 *
 * Audit ordering:
 *   `notify` is called BEFORE `writeAudit` for each payable. If notify
 *   throws, the catch swallows + logs + skips the audit (we don't want a
 *   "REMINDER_SENT" audit row when delivery failed). The audit row is
 *   the operator-visible signal of "this got chased today" — accuracy
 *   matters more than completeness for that surface.
 *
 * Per-batch isolation:
 *   Each payable is wrapped in its own try/catch — one notify failure
 *   never stops the sweep. Failed payables are logged + recorded in
 *   `errors[]` but not counted in `processed` or `byWindow`. The next
 *   tick re-finds them via the same window query (the cron is naturally
 *   re-entrant on the same UTC day).
 *
 * Tenant scoping:
 *   This engine is multi-tenant-agnostic by design — the payable row
 *   carries its own `tenantId` column directly, and the audit write is
 *   tenant-scoped via that field. There's no per-tenant orchestrator
 *   layer here because the dueDate window query is naturally tenant-
 *   broad; per-tenant filtering would only add N round trips for no
 *   correctness benefit.
 *
 * Mirrors backend/cron/travelMilestoneRemindersEngine.js shape (#901
 * slice 7, commit `6bf0b836`).
 *
 * Schedule:
 *   Every 4 hours via server.js cron (wire-in is a SEPARATE slice, OUT
 *   OF SCOPE for this commit). Window granularity is the UTC day, so
 *   4-hour ticks within the same UTC day will re-find the same payables
 *   — the duplicate-fire guard is the operator's responsibility (e.g.
 *   dedupe on (payableId, windowDays, UTC-day) inside the real Wati
 *   notifier). For the STUB this is intentionally permissive — the
 *   audit row provides the full history.
 */

const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");

// Reminder windows in days from "now" — payables whose dueDate is exactly
// this many UTC days away trigger a reminder this run.
const REMINDER_WINDOWS_DAYS = [7, 3, 1, 0]; // T-7 / T-3 / T-1 / due-today

/**
 * Default STUB notifier — logs the intent + returns. Replaced by the
 * wire-in slice (Q9 cred-drop) with a real Wati / email dispatcher.
 *
 * Exposed on module.exports so tests can self-spy via the CJS-self-
 * mocking-seam pattern (cron-learnings entry, 2026-05-24 ~01:43 UTC).
 */
async function defaultStubNotifier(payable, supplier, windowDays) {
  console.log(
    `[supplier-payable-reminder STUB] supplier=${supplier.name} po=${payable.poNumber || "-"} window=T-${windowDays}d amount=${payable.amount} ${payable.currency}`,
  );
}

/**
 * Fire-and-forget audit wrapper. Mirrors travelMilestoneRemindersEngine's
 * shape. Exposed via module.exports so the per-payable loop can be self-
 * spied in tests without touching audit.js's real chain logic.
 */
function writeAuditSafe(...args) {
  return writeAudit(...args).catch((err) => {
    console.warn(`[supplier-payable-reminder] audit failed: ${err.message}`);
  });
}

/**
 * Compute the half-open UTC-midnight window [target, next) for `days`
 * from `now`. Pure function; exported for direct unit testing.
 *
 * @param {Date} now
 * @param {number} days
 * @returns {{ target: Date, next: Date }}
 */
function computeWindow(now, days) {
  const target = new Date(now);
  target.setUTCHours(0, 0, 0, 0);
  target.setUTCDate(target.getUTCDate() + days);
  const next = new Date(target);
  next.setUTCDate(next.getUTCDate() + 1);
  return { target, next };
}

/**
 * Run one pass of the reminder engine.
 *
 * @param {object} [options]
 * @param {Function} [options.notify] async (payable, supplier, windowDays) => void
 *   Real notifier injection point. When omitted, the STUB logger runs and
 *   the audit row carries `stub: true`.
 * @param {Date} [options.now] Override for testability — defaults to new Date().
 * @returns {Promise<{ processed: number, byWindow: Record<number, number>, errors: Array<{ payableId: number, error: string }> }>}
 */
async function runSupplierPayableRemindersEngine({ notify, now = new Date() } = {}) {
  const isStub = !notify;
  const send = notify || module.exports.defaultStubNotifier;

  const byWindow = { 7: 0, 3: 0, 1: 0, 0: 0 };
  const errors = [];
  let processed = 0;

  for (const days of REMINDER_WINDOWS_DAYS) {
    const { target, next } = computeWindow(now, days);

    const payables = await prisma.travelSupplierPayable.findMany({
      where: {
        status: { in: ["pending", "scheduled"] },
        dueDate: { gte: target, lt: next },
      },
      include: {
        supplier: {
          select: {
            id: true,
            name: true,
            tenantId: true,
            email: true,
            phone: true,
            subBrand: true,
          },
        },
      },
    });

    for (const p of payables) {
      try {
        await send(p, p.supplier, days);
        // Audit AFTER successful notify so failed deliveries don't pollute
        // the "this got chased today" operator signal.
        await module.exports.writeAuditSafe(
          "TravelSupplierPayable",
          "SUPPLIER_PAYABLE_REMINDER_SENT",
          p.id,
          null, // system actor — no User row
          p.tenantId,
          {
            supplierId: p.supplierId,
            poNumber: p.poNumber,
            amount: String(p.amount),
            currency: p.currency,
            windowDays: days,
            stub: isStub,
          },
        );
        byWindow[days] += 1;
        processed += 1;
      } catch (e) {
        console.error(
          `[supplier-payable-reminder] failed for payable=${p.id} window=T-${days}d: ${e.message}`,
        );
        errors.push({ payableId: p.id, error: e.message });
      }
    }
  }

  return { processed, byWindow, errors };
}

module.exports = {
  runSupplierPayableRemindersEngine,
  computeWindow,
  defaultStubNotifier,
  writeAuditSafe,
  REMINDER_WINDOWS_DAYS,
};
