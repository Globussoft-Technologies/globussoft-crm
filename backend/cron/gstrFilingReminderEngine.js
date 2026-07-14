/**
 * GSTR-1 Monthly Filing Reminder Engine — #902 slice 11.
 *
 * GST-registered Indian operators must file GSTR-1 (outward-supplies return)
 * by the 10th of the month following each tax period. Missing the deadline
 * incurs a per-day late fee (₹50 nil-return / ₹200 with-supplies — capped at
 * ₹10,000) plus 18% interest on any net tax payable. This engine ensures the
 * operator gets nudged before — and chased after — the deadline so the
 * compliance lapse never silently rolls forward.
 *
 * Reminder tier ladder (relative to the 10th-of-this-month deadline):
 *   T-3  → "first reminder" — 3 days before deadline (7th of month)
 *   T-1  → "urgent reminder" — day before (9th of month)
 *   T-0  → "final reminder" — day of (10th)
 *   T+1+ → "late warning" — any day after, until the operator files
 *
 * Intermediate days (T-7 ... T-4, T-2) are intentionally SILENT — reminders
 * before T-3 are noise (operators ignore early nudges), and T-2 sits in the
 * "T-3 already fired" cooldown. Post-deadline (T+1+) collapses to a single
 * "T+" tier because escalating frequency every day after the 10th creates
 * spam without compliance benefit (the late fee accrues regardless).
 *
 * Tenant selection criteria:
 *   - vertical = "travel" (GST handling lives in the travel vertical for now;
 *     other verticals extend via a vertical-broad GstrRegistration model
 *     when they ship — out of scope here).
 *   - At least one TravelInvoice with docType in {"TaxInvoice", null} created
 *     during the prior calendar month. NULL-treated-as-TaxInvoice mirrors the
 *     route-layer convention introduced in slice 11 of PRD_TRAVEL_BILLING —
 *     pre-slice-11 historical rows have NULL docType but render as
 *     TaxInvoice for tax/return purposes. CreditNote / DebitNote /
 *     Proforma / TravelVoucher docTypes are EXCLUDED — they don't enter
 *     GSTR-1 outward-supplies (credit notes adjust prior returns; proforma
 *     + vouchers aren't tax documents). Operators with ONLY non-TaxInvoice
 *     activity in the prior month don't have a GSTR-1 to file and skip
 *     the reminder ladder entirely.
 *
 * STUB mode (current default):
 *   Real Wati WhatsApp + Mailgun email delivery are cred-blocked on Q9 (Wati
 *   API key) and Q1 (Mailgun credentials). Today the engine calls the
 *   `defaultStubNotifier` which `console.log`s the intent + the audit row
 *   carries `stub: true`. When Q9 / Q1 land, the wire-in slice passes a real
 *   `notify` callback into `runGstrFilingReminderEngine({ notify })` and
 *   the audit `stub` flag flips to `false` automatically.
 *
 * Audit ordering:
 *   notify is called BEFORE writeAudit per tenant. If notify throws, the
 *   catch swallows + logs + skips the audit (we don't want a
 *   "GSTR_FILING_REMINDER_SENT" audit row when delivery failed). Per-tenant
 *   try/catch isolates failures — one stuck Wati request doesn't abort the
 *   sweep.
 *
 * Schedule:
 *   Daily at 08:00 UTC via server.js cron (wire-in is OUT OF SCOPE for this
 *   commit per slice-rejection-trigger #3). The engine self-throttles to one
 *   reminder per tenant per tier per day — the audit row is the operator-
 *   visible "this got chased today" signal. Multiple ticks within the same
 *   UTC day would re-find the same tenants; dedupe lives in the eventual
 *   real Wati notifier (cred-blocked, so we don't pre-build it here).
 *
 * Mirrors `backend/cron/travelMilestoneRemindersEngine.js` shape (Arc 2 slice
 * 7, commit 6bf0b836) — same prisma-singleton mocking surface, same self-spy
 * `module.exports.writeAuditSafe` seam, same `now` override for testability.
 *
 * Refs #902. PRD: docs/PRD_TRAVEL_GST_COMPLIANCE.md.
 */

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");

// GoI rule: GSTR-1 monthly due by the 10th of the month following the tax
// period. Quarterly Sahaj filers (QRMP scheme) get the 13th, but the vast
// majority of operators file monthly — Sahaj support is a future slice when
// the operator-settings surface gains the filer-cadence preference.
const FILING_DEADLINE_DAY = 10;

/**
 * Map a signed `daysUntilDeadline` integer to the reminder tier identifier.
 * Returns null for silent days (T-7 ... T-4, T-2 — see ladder docs above).
 *
 * @param {number} daysUntilDeadline  Signed integer; positive = before, 0 =
 *   deadline-day, negative = post-deadline.
 * @returns {"T-3"|"T-1"|"T-0"|"T+"|null}
 */
function reminderTier(daysUntilDeadline) {
  if (daysUntilDeadline === 3) return "T-3";
  if (daysUntilDeadline === 1) return "T-1";
  if (daysUntilDeadline === 0) return "T-0";
  if (daysUntilDeadline < 0) return "T+";
  return null;
}

/**
 * Default STUB notifier — logs the intent + returns. Replaced by the wire-in
 * slice (Q9 + Q1 cred-drop) with a real Wati / Mailgun dispatcher. Exposed
 * on module.exports so tests can self-spy via the CJS-self-mocking-seam
 * pattern (cron-learnings entry 2026-05-24 ~01:43 UTC).
 */
async function defaultStubNotifier(tenant, tier, daysToDeadline) {
  console.log(
    `[gstr-reminder STUB] tenant=${tenant.id} tier=${tier} days=${daysToDeadline}`,
  );
}

/**
 * Fire-and-forget audit wrapper. Mirrors travelMilestoneRemindersEngine's
 * writeAuditSafe — exposed via module.exports so the per-tenant loop can be
 * self-spied in tests without exercising audit.js's real hash-chain logic.
 */
function writeAuditSafe(...args) {
  return writeAudit(...args).catch((err) => {
    console.warn(`[gstr-reminder] audit failed: ${err.message}`);
  });
}

/**
 * Compute the UTC-midnight filing deadline for the current tax period:
 * the 10th of `now.getUTCMonth()` (e.g. for `now=2026-05-25` → deadline =
 * 2026-05-10 UTC midnight; for `now=2026-05-08` → deadline =
 * 2026-05-10 UTC midnight). Pure function; exported for direct unit testing.
 *
 * @param {Date} now
 * @returns {Date}
 */
function computeDeadline(now) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), FILING_DEADLINE_DAY),
  );
}

/**
 * Compute the [start, end) half-open UTC window for the calendar month
 * IMMEDIATELY PRIOR to `now`. The tenant-selection query filters
 * TravelInvoice.createdAt to this window so operators with no activity in
 * the prior month skip the reminder ladder entirely.
 *
 * For `now=2026-05-25` → [2026-04-01 UTC, 2026-05-01 UTC).
 * For `now=2026-01-15` → [2025-12-01 UTC, 2026-01-01 UTC). (Year rollover
 * is correct by virtue of Date.UTC(year, month, ...) accepting month=-1.)
 *
 * @param {Date} now
 * @returns {{ start: Date, end: Date }}
 */
function computePriorMonthWindow(now) {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, end };
}

/**
 * Run one pass of the GSTR-1 filing-reminder engine.
 *
 * @param {object} [options]
 * @param {Function} [options.notify] async (tenant, tier, daysToDeadline) => void
 *   Real notifier injection point. When omitted, the STUB logger runs and
 *   the audit row carries `stub: true`.
 * @param {Date} [options.now] Override for testability — defaults to new Date().
 * @returns {Promise<{ processed: number, tier: string|null, daysToDeadline: number, errors: Array<{ tenantId: number, error: string }> }>}
 */
async function runGstrFilingReminderEngine({ notify, now = new Date() } = {}) {
  const isStub = !notify;
  const send = notify || module.exports.defaultStubNotifier;

  const deadline = module.exports.computeDeadline(now);
  // Day delta is computed at UTC-midnight granularity so a tick at 23:55 UTC
  // on the 9th and one at 00:05 UTC on the 10th read T-1 and T-0 respectively
  // (not "0.99 days" / "0.003 days"). Floor the midnight-anchored delta.
  const todayMidnight = new Date(now);
  todayMidnight.setUTCHours(0, 0, 0, 0);
  const daysToDeadline = Math.round(
    (deadline.getTime() - todayMidnight.getTime()) / 86_400_000,
  );

  const tier = module.exports.reminderTier(daysToDeadline);
  if (!tier) {
    return { processed: 0, tier: null, daysToDeadline, errors: [] };
  }

  const { start: lastMonthStart, end: lastMonthEnd } =
    module.exports.computePriorMonthWindow(now);

  const tenants = await prisma.tenant.findMany({
    where: {
      vertical: "travel",
      travelInvoices: {
        some: {
          docType: { in: ["TaxInvoice", null] },
          createdAt: { gte: lastMonthStart, lt: lastMonthEnd },
        },
      },
    },
    select: { id: true, name: true, slug: true },
  });

  const errors = [];
  let processed = 0;

  for (const tenant of tenants) {
    try {
      await send(tenant, tier, daysToDeadline);
      // Audit AFTER successful notify so failed deliveries don't pollute
      // the operator-visible "this got chased today" signal.
      await module.exports.writeAuditSafe(
        "Tenant",
        "GSTR_FILING_REMINDER_SENT",
        tenant.id,
        null, // system actor — no User row
        tenant.id,
        { tier, daysToDeadline, stub: isStub },
      );
      processed += 1;
    } catch (e) {
      console.error(
        `[gstr-reminder] failed for tenant=${tenant.id} tier=${tier}: ${e.message}`,
      );
      errors.push({ tenantId: tenant.id, error: e.message });
    }
  }

  return { processed, tier, daysToDeadline, errors };
}

// Super Admin Portal / Cron Maintenance — was previously wired via a raw
// _cron.schedule("0 5 * * *", ...) call inline in server.js instead of an
// init*Cron() function like every other engine. Moved to the same
// cronRegistry.register() pattern so it's enable/disable/reschedule-able
// from the Super Admin UI like the other 45 engines.
function initCron() {
  cronRegistry.register({
    name: "gstrFilingReminderEngine",
    description: "Tiered GSTR-1 filing deadline reminders for travel tenants (daily 05:00 UTC / 10:30 IST)",
    defaultSchedule: "0 5 * * *",
    tickFn: runGstrFilingReminderEngine,
  }).catch((e) => console.error("[gstr-filing-reminder] cronRegistry registration failed:", e.message));
}

module.exports = {
  runGstrFilingReminderEngine,
  reminderTier,
  computeDeadline,
  computePriorMonthWindow,
  defaultStubNotifier,
  writeAuditSafe,
  FILING_DEADLINE_DAY,
  initCron,
};
