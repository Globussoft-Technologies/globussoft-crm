/**
 * Lead-side SLA Breach Engine (PRD §6.4)
 *
 * Distinct from cron/slaBreachEngine.js (which covers Ticket-side SLAs).
 *
 * Runs every 2 minutes. For each tenant, finds Contact rows where:
 *   - status = 'Lead'
 *   - firstResponseAt IS NULL          (no human has acknowledged yet)
 *   - firstResponseDueAt < now()       (clock has expired)
 *   - slaBreached = false              (we haven't already fired)
 *
 * For each match: flips slaBreached=true + stamps slaBreachedAt=now,
 * then emits 'lead.sla_breached' on the in-process event bus so any
 * AutomationRule listening on it can react (notify manager, escalate,
 * send a holding WhatsApp via the Callified-driven holding template,
 * etc. — per PRD §6.7 "zero missed leads" agent goal).
 *
 * Per-tenant scan + emit + log — same shape as slaBreachEngine.js and
 * appointmentRemindersEngine.js. The slaBreached=false precondition is the
 * idempotency gate: once flipped, the cron will never re-fire for that lead.
 */

const cron = require("node-cron");
const prisma = require("../lib/prisma");
const { emitEvent } = require("../lib/eventBus");

async function processTenant(tenant) {
  const now = new Date();

  const candidates = await prisma.contact.findMany({
    where: {
      tenantId: tenant.id,
      status: "Lead",
      firstResponseAt: null,
      firstResponseDueAt: { lt: now },
      slaBreached: false,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      source: true,
      assignedToId: true,
      firstResponseDueAt: true,
      tenantId: true,
    },
  });

  const breachedIds = [];
  for (const c of candidates) {
    try {
      const breachedAt = new Date();
      await prisma.contact.update({
        where: { id: c.id },
        data: { slaBreached: true, slaBreachedAt: breachedAt },
      });

      const dueAt = c.firstResponseDueAt;
      const breachedBy = dueAt
        ? breachedAt.getTime() - new Date(dueAt).getTime()
        : 0;

      await emitEvent(
        "lead.sla_breached",
        {
          contactId: c.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          source: c.source,
          assigneeId: c.assignedToId,
          dueAt,
          breachedAt,
          breachedBy,
        },
        tenant.id,
      );

      breachedIds.push(c.id);
    } catch (err) {
      console.error(
        `[LeadSLABreach] tenant=${tenant.id} contact=${c.id} failed:`,
        err.message,
      );
    }
  }

  return {
    tenant: tenant.slug || tenant.id,
    checked: candidates.length,
    breached: breachedIds.length,
    ids: breachedIds,
  };
}

async function tickLeadSlaBreaches() {
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
          `[LeadSLABreach] tenant ${t.slug || t.id} failed:`,
          err.message,
        );
      }
    }
  } catch (err) {
    console.error("[LeadSLABreach] top-level error:", err.message);
  }

  const ms = Date.now() - started;
  console.log(
    `[LeadSLABreach] tenants=${tenantsProcessed} checked=${totalChecked} breached=${totalBreached} (${ms}ms)`,
  );
  return { tenantsProcessed, totalChecked, totalBreached };
}

function initLeadSlaCron() {
  cron.schedule("*/2 * * * *", () => {
    tickLeadSlaBreaches().catch((e) =>
      console.error("[LeadSLABreach] tick crashed:", e.message),
    );
  });
  console.log("Lead SLA Breach Engine initialized (cron: */2 * * * *)");
}

// Convenience runner for the manual-trigger endpoint and tests: scopes to a
// single tenant and returns { checked, breached, ids } for the response body.
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
  initLeadSlaCron,
  tickLeadSlaBreaches,
  processTenant,
  runForTenant,
};
