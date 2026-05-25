/**
 * Travel Milestone Reminders Engine
 *
 * #901 Travel Billing — Arc 2 Slice 7 (PRD_TRAVEL_BILLING.md UC-2.4).
 *
 * Scans `TravelPaymentSchedule` rows for milestones whose `dueDate` falls
 * within reminder windows (T-7, T-3, T-1, T+0 days from "now", bucketed at
 * UTC midnight) and prepares reminder notifications for the invoice's
 * customer. Per PRD UC-2.4: *"Customer pays 25% advance via UPI; next-
 * milestone reminder cron picks up the schedule and emails the customer
 * 7 / 3 / 1 day before pre-departure milestone."*
 *
 * STUB MODE (current default):
 *   Real WhatsApp/email delivery is cred-blocked on Q9 (Wati API key) and
 *   Q11 (LLM provider keys, for templated copy). Today this engine logs
 *   `[milestone-reminder STUB] ...` per match + writes an audit row with
 *   `stub: true` so the operator surface can see what would have been sent.
 *
 *   When Q9 / Q11 creds drop, the wire-in slice (#901 slice 8) passes a
 *   real `notify` callback into `runMilestoneRemindersEngine({ notify })`
 *   and the audit `stub` flag flips to `false` automatically.
 *
 * Window semantics (UTC midnight buckets):
 *   For each `days` in [7, 3, 1, 0] we compute the half-open window
 *   `[start-of-day(now+days), start-of-day(now+days+1))` and find every
 *   pending/partial milestone whose `dueDate` falls inside it. UTC is
 *   the right anchor because (a) every milestone's `dueDate` was stored
 *   as a UTC ISO string by the schedule-CRUD routes, and (b) cron ticks
 *   happen every 4 hours so any local-TZ drift would silently double-fire
 *   or miss windows depending on the tick-of-day. UTC midnight buckets
 *   are deterministic: a given milestone enters T-7 exactly once during
 *   the UTC day that's 7 days before its dueDate's UTC day.
 *
 * Status filter:
 *   Only `pending` and `partial` milestones trigger reminders. `paid`,
 *   `overdue`, `waived` are excluded:
 *     - `paid`     — nothing more to chase; reminding would be wrong.
 *     - `overdue`  — already-overdue rows are handled by the future
 *                    overdue-cron (slice 9), which uses different copy.
 *     - `waived`   — operator explicitly cleared the obligation.
 *
 * Audit ordering:
 *   `notify` is called BEFORE `writeAudit` for each milestone. If notify
 *   throws, the catch swallows + logs + skips the audit (we don't want a
 *   "REMINDER_SENT" audit row when delivery failed). The audit row is
 *   the operator-visible signal of "this got chased today" — accuracy
 *   matters more than completeness for that surface.
 *
 * Per-batch isolation:
 *   Each milestone is wrapped in its own try/catch — one notify failure
 *   never stops the sweep. Failed milestones are logged + counted in
 *   neither `processed` nor `byWindow` (they were attempted but not
 *   completed). The next tick re-finds them via the same window query.
 *
 * Tenant scoping:
 *   This engine is multi-tenant-agnostic by design — the milestone row
 *   carries its own tenantId via the relation, and the audit write is
 *   tenant-scoped via that field. There's no per-tenant orchestrator
 *   layer here (unlike walletExpiryEngine) because the dueDate window
 *   query is naturally tenant-broad; per-tenant filtering would only
 *   add N round trips for no correctness benefit.
 *
 * Schedule:
 *   Every 4 hours via server.js cron (wire-in is slice 8 of #901, OUT
 *   OF SCOPE for this commit). Window granularity is the UTC day, so
 *   4-hour ticks within the same UTC day will re-find the same
 *   milestones — the duplicate-fire guard is the operator's responsi-
 *   bility (e.g. dedupe on (milestoneId, windowDays, UTC-day) inside
 *   the real Wati notifier). For the STUB this is intentionally
 *   permissive — the audit row provides the full history.
 */

const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");

// Reminder windows in days from "now" — milestones whose dueDate is exactly
// this many UTC days away trigger a reminder this run.
const REMINDER_WINDOWS_DAYS = [7, 3, 1, 0]; // T-7 / T-3 / T-1 / due-today

/**
 * Default STUB notifier — logs the intent + returns. Replaced by the
 * wire-in slice (Q9 cred-drop) with a real Wati / email dispatcher.
 *
 * Exposed on module.exports so tests can self-spy via the CJS-self-
 * mocking-seam pattern (cron-learnings entry, 2026-05-24 ~01:43 UTC).
 */
async function defaultStubNotifier(milestone, invoice, windowDays) {
  console.log(
    `[milestone-reminder STUB] invoice=${invoice.invoiceNum} milestone=${milestone.id} window=T-${windowDays}d`,
  );
}

/**
 * Fire-and-forget audit wrapper. Mirrors walletExpiryEngine.writeAuditSafe.
 * Exposed via module.exports so the per-milestone loop can be self-spied
 * in tests without touching audit.js's real chain logic.
 */
function writeAuditSafe(...args) {
  return writeAudit(...args).catch((err) => {
    console.warn(`[milestone-reminder] audit failed: ${err.message}`);
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
 * @param {Function} [options.notify] async (milestone, invoice, windowDays) => void
 *   Real notifier injection point. When omitted, the STUB logger runs and
 *   the audit row carries `stub: true`.
 * @param {Date} [options.now] Override for testability — defaults to new Date().
 * @returns {Promise<{ processed: number, byWindow: Record<number, number>, errors: Array<{ milestoneId: number, error: string }> }>}
 */
async function runMilestoneRemindersEngine({ notify, now = new Date() } = {}) {
  const isStub = !notify;
  const send = notify || module.exports.defaultStubNotifier;

  const byWindow = { 7: 0, 3: 0, 1: 0, 0: 0 };
  const errors = [];
  let processed = 0;

  for (const days of REMINDER_WINDOWS_DAYS) {
    const { target, next } = computeWindow(now, days);

    const milestones = await prisma.travelPaymentSchedule.findMany({
      where: {
        status: { in: ["pending", "partial"] },
        dueDate: { gte: target, lt: next },
      },
      include: {
        invoice: {
          select: {
            id: true,
            invoiceNum: true,
            subBrand: true,
            contactId: true,
            tenantId: true,
            currency: true,
          },
        },
      },
    });

    for (const m of milestones) {
      try {
        await send(m, m.invoice, days);
        // Audit AFTER successful notify so failed deliveries don't pollute
        // the "this got chased today" operator signal.
        await module.exports.writeAuditSafe(
          "TravelPaymentSchedule",
          "MILESTONE_REMINDER_SENT",
          m.id,
          null, // system actor — no User row
          m.tenantId,
          {
            invoiceId: m.invoiceId,
            milestoneOrder: m.milestoneOrder,
            windowDays: days,
            stub: isStub,
          },
        );
        byWindow[days] += 1;
        processed += 1;
      } catch (e) {
        console.error(
          `[milestone-reminder] failed for milestone=${m.id} window=T-${days}d: ${e.message}`,
        );
        errors.push({ milestoneId: m.id, error: e.message });
      }
    }
  }

  return { processed, byWindow, errors };
}

module.exports = {
  runMilestoneRemindersEngine,
  computeWindow,
  defaultStubNotifier,
  writeAuditSafe,
  REMINDER_WINDOWS_DAYS,
};
