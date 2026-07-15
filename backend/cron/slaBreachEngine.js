/**
 * SLA Breach Engine
 *
 * Runs every 5 minutes. Finds Ticket rows where:
 *   - status NOT in (Resolved, Closed, Cancelled)
 *   - firstResponseAt IS NULL (no agent has responded yet)
 *   - slaResponseDue < now()
 *   - breached = false (we haven't already fired for this ticket)
 *
 * For each match: flips breached=true, sets breachedAt=now(), and emits the
 * 'sla.breached' event so any AutomationRule listening on it can react
 * (notify manager, escalate, send Slack ping, etc.).
 *
 * Per-tenant scan + emit + log — same shape as appointmentRemindersEngine.
 *
 * Idempotency: the breached=false precondition is the gate. Once flipped, the
 * cron will never re-fire for that ticket — so we don't spam the bus.
 */

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { getSetting, KEYS } = require("../lib/tenantSettings");
const { emitEvent } = require("../lib/eventBus");

const TERMINAL_STATUSES_DEFAULT = ["Resolved", "Closed", "Cancelled"];

async function processTenant(tenant) {
  const now = new Date();

  // Per-tenant terminal statuses (e.g. some tenants may add "On-Hold" or
  // remove "Cancelled" from the breach-exclusion list).
  const terminalStatusesRaw = await getSetting(tenant.id, KEYS.SLA_TERMINAL_STATUSES, { fallback: JSON.stringify(TERMINAL_STATUSES_DEFAULT) });
  let terminalStatuses = TERMINAL_STATUSES_DEFAULT;
  try { terminalStatuses = JSON.parse(terminalStatusesRaw); } catch { /* keep default */ }
  if (!Array.isArray(terminalStatuses) || terminalStatuses.length === 0) {
    terminalStatuses = TERMINAL_STATUSES_DEFAULT;
  }

  const candidates = await prisma.ticket.findMany({
    where: {
      tenantId: tenant.id,
      status: { notIn: terminalStatuses },
      firstResponseAt: null,
      slaResponseDue: { lt: now },
      breached: false,
    },
    select: {
      id: true,
      subject: true,
      priority: true,
      assigneeId: true,
      slaResponseDue: true,
      tenantId: true,
    },
  });
  // Schema fix (caught by sla-breach-api.spec.js in CI): Ticket has no
  // `contactId` column — only `assigneeId`. Earlier the select listed
  // `contactId: true` and the engine threw PrismaClientValidationError
  // any time a candidate ticket existed. Production cron silently
  // logged the error every 5 min; no SLA breach was ever recorded.
  // Removing contactId from the select here AND from the event payload
  // below.

  const breachedIds = [];
  for (const t of candidates) {
    try {
      const breachedAt = new Date();
      const updateResult = await prisma.ticket.updateMany({
        where: { id: t.id, breached: false },
        data: { breached: true, breachedAt },
      });

      if (updateResult.count !== 1) continue;

      const dueAt = t.slaResponseDue;
      const breachedBy = dueAt
        ? breachedAt.getTime() - new Date(dueAt).getTime()
        : 0;

      await emitEvent(
        "sla.breached",
        {
          ticketId: t.id,
          subject: t.subject,
          priority: t.priority,
          assigneeId: t.assigneeId,
          dueAt,
          breachedAt,
          breachedBy,
        },
        tenant.id,
      );

      // PRD Gap §12 #4b — surface SLA breach on the bell of: (a) the
      // ticket's assignee (if any) so the responsible owner sees it
      // immediately; (b) every ADMIN/MANAGER in the tenant so a manager
      // can step in if the assignee is unavailable. Idempotent because
      // the breached=false precondition above guarantees we reach here
      // exactly once per ticket. Best-effort — a notification failure
      // must not roll back the breach flip.
      try {
        const recipients = new Set();
        if (t.assigneeId) recipients.add(t.assigneeId);
        const managers = await prisma.user.findMany({
          where: { tenantId: tenant.id, role: { in: ["ADMIN", "MANAGER"] } },
          select: { id: true },
        });
        for (const u of managers) recipients.add(u.id);
        if (recipients.size > 0) {
          const title = `SLA breached: ${t.subject || `Ticket #${t.id}`}`;
          const lateMin = breachedBy ? Math.round(breachedBy / 60000) : 0;
          const message = `Ticket #${t.id} (${t.priority || "—"}) has missed its first-response SLA${lateMin > 0 ? ` by ${lateMin} min` : ""}.`;
          await prisma.notification.createMany({
            data: Array.from(recipients).map((uid) => ({
              tenantId: tenant.id,
              userId: uid,
              title,
              message,
              type: "warning",
              link: `/tickets/${t.id}`,
            })),
          });
        }
      } catch (notifErr) {
        console.warn(
          `[SLABreach] tenant=${tenant.id} ticket=${t.id} notify failed:`,
          notifErr.message,
        );
      }

      breachedIds.push(t.id);
    } catch (err) {
      console.error(
        `[SLABreach] tenant=${tenant.id} ticket=${t.id} failed:`,
        err.message,
      );
    }
  }

  return { tenant: tenant.slug || tenant.id, checked: candidates.length, breached: breachedIds.length, ids: breachedIds };
}

async function tickSlaBreaches() {
  const started = Date.now();
  let totalChecked = 0;
  let totalBreached = 0;
  let tenantsProcessed = 0;

  try {
    const tenants = await prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true, slug: true },
    });

    for (const t of tenants) {
      try {
        const res = await processTenant(t);
        totalChecked += res.checked;
        totalBreached += res.breached;
        tenantsProcessed++;
      } catch (err) {
        console.error(
          `[SLABreach] tenant ${t.slug || t.id} failed:`,
          err.message,
        );
      }
    }
  } catch (err) {
    console.error("[SLABreach] top-level error:", err.message);
  }

  const ms = Date.now() - started;
  console.log(
    `[SLABreach] tenants=${tenantsProcessed} checked=${totalChecked} breached=${totalBreached} (${ms}ms)`,
  );
  return { tenantsProcessed, totalChecked, totalBreached };
}

function initSlaBreachCron() {
  cronRegistry.register({
    name: "slaBreachEngine",
    description: "Flips Ticket.breached + emits sla.breached (every 5 min)",
    defaultSchedule: "*/5 * * * *",
    tickFn: tickSlaBreaches,
  }).catch((e) => console.error("[SLABreach] cronRegistry registration failed:", e.message));
}

// Convenience runner for the manual-trigger endpoint: scopes to a single
// tenant and returns { checked, breached, ids } for the response body.
async function runForTenant(tenantId) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, slug: true },
  });
  if (!tenant) return { checked: 0, breached: 0, ids: [] };
  const res = await processTenant(tenant);
  return { checked: res.checked, breached: res.breached, ids: res.ids };
}

module.exports = {
  initSlaBreachCron,
  tickSlaBreaches,
  processTenant,
  runForTenant,
};
