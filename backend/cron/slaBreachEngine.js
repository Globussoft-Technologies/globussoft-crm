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

const cron = require("node-cron");
const prisma = require("../lib/prisma");
const { emitEvent } = require("../lib/eventBus");

const TERMINAL_STATUSES = ["Resolved", "Closed", "Cancelled"];

async function processTenant(tenant) {
  const now = new Date();

  const candidates = await prisma.ticket.findMany({
    where: {
      tenantId: tenant.id,
      status: { notIn: TERMINAL_STATUSES },
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

  const breachedIds = [];
  for (const t of candidates) {
    try {
      const breachedAt = new Date();
      await prisma.ticket.update({
        where: { id: t.id },
        data: { breached: true, breachedAt },
      });

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
          contactId: t.contactId,
          assigneeId: t.assigneeId,
          dueAt,
          breachedAt,
          breachedBy,
        },
        tenant.id,
      );

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
  cron.schedule("*/5 * * * *", () => {
    tickSlaBreaches().catch((e) =>
      console.error("[SLABreach] tick crashed:", e.message),
    );
  });
  console.log("SLA Breach Engine initialized (cron: */5 * * * *)");
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
