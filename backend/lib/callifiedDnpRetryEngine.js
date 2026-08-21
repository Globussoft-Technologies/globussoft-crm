/**
 * DNP retry engine for Callified AI calls.
 *
 * When a lead is marked DNP (Did Not Pick up), this engine schedules an
 * automatic re-dial after a configurable interval, up to a max number of
 * retries. Manual calls and manual status overrides clear the pending retry
 * state so the lead follows the normal flow immediately.
 *
 * The engine runs on a 1-minute tick, scans for DNP leads that are due for
 * retry, and enqueues them in the existing auto-dial queue.
 */

const prisma = require("./prisma");
const { getSetting, KEYS } = require("./tenantSettings");
const { CALL_STATUS } = require("./callifiedLeadStatus");

const DNP_RETRY_TICK_MS = 60 * 1000; // 1 minute

let tickInterval = null;
let isProcessingTick = false;

/**
 * Lazy accessor for the auto-dial queue so this module and the queue module
 * can both reference each other without a circular-require crash.
 */
function getAutoDialQueue() {
  return require("./callifiedAutoDialQueue");
}

async function getDnpRetrySettings(tenantId) {
  const [enabledRaw, maxRetriesRaw, intervalMinutesRaw] = await Promise.all([
    getSetting(tenantId, KEYS.CALLIFIED_DNP_RETRY_ENABLED, {
      coerce: (v) => String(v).toLowerCase() === "true" || v === "1" || v === 1 || v === true,
      fallback: true,
    }),
    getSetting(tenantId, KEYS.CALLIFIED_DNP_RETRY_MAX_RETRIES, {
      coerce: Number,
      fallback: 3,
    }),
    getSetting(tenantId, KEYS.CALLIFIED_DNP_RETRY_INTERVAL_MINUTES, {
      coerce: Number,
      fallback: 60,
    }),
  ]);

  const enabled = Boolean(enabledRaw);
  const maxRetries = Math.max(1, Math.min(Number.isFinite(maxRetriesRaw) ? maxRetriesRaw : 3, 10));
  const intervalMinutes = Math.max(
    5,
    Math.min(Number.isFinite(intervalMinutesRaw) ? intervalMinutesRaw : 60, 24 * 60),
  );

  return { enabled, maxRetries, intervalMinutes };
}

/**
 * Reset retry counters for a lead. Called when:
 *   - a lead becomes Qualified or Junk
 *   - a manual call is placed for the lead
 *   - a manual status override changes the status away from DNP
 */
async function clearDnpRetryState(contactId) {
  return prisma.contact.update({
    where: { id: Number(contactId) },
    data: {
      callifiedDnpRetryCount: 0,
      callifiedDnpNextRetryAt: null,
    },
  });
}

/**
 * Schedule the next retry for a DNP lead. Preserves the existing retry count
 * so the x/y display and the max-retries ceiling stay consistent across
 * automatic retries. Manual DNP overrides reset the count before calling this.
 */
async function scheduleDnpRetry(tenantId, contactId) {
  const { enabled, intervalMinutes } = await getDnpRetrySettings(tenantId);
  if (!enabled) return null;

  const nextRetryAt = new Date(Date.now() + intervalMinutes * 60 * 1000);
  return prisma.contact.update({
    where: { id: Number(contactId), tenantId },
    data: {
      callifiedDnpNextRetryAt: nextRetryAt,
    },
  });
}

/**
 * Main tick: find DNP leads whose retry window has arrived and enqueue them
 * for an auto-dial. Grouped by tenant so per-tenant retry settings are honored.
 */
async function processDnpRetries() {
  if (isProcessingTick) return;
  isProcessingTick = true;

  try {
    const now = new Date();
    // Pre-filter with a loose upper bound; exact max is enforced per-tenant below.
    const dueContacts = await prisma.contact.findMany({
      where: {
        status: "Lead",
        deletedAt: null,
        callifiedLeadStatus: CALL_STATUS.DNP,
        callifiedDnpRetryCount: { lt: 10 },
        callifiedCampaignId: { not: null },
        phone: { not: null },
        OR: [{ callifiedDnpNextRetryAt: { lte: now } }, { callifiedDnpNextRetryAt: null }],
      },
      select: {
        id: true,
        tenantId: true,
        callifiedCampaignId: true,
        callifiedDnpRetryCount: true,
      },
    });

    if (!dueContacts.length) return;

    const byTenant = new Map();
    for (const contact of dueContacts) {
      const list = byTenant.get(contact.tenantId) || [];
      list.push(contact);
      byTenant.set(contact.tenantId, list);
    }

    for (const [tenantId, contacts] of byTenant) {
      let settings;
      try {
        settings = await getDnpRetrySettings(Number(tenantId));
      } catch (e) {
        console.error(`[callifiedDnpRetry] failed to read settings for tenant ${tenantId}:`, e.message);
        continue;
      }

      if (!settings.enabled) continue;

      for (const contact of contacts) {
        if (contact.callifiedDnpRetryCount >= settings.maxRetries) continue;

        const nextRetryAt = new Date(Date.now() + settings.intervalMinutes * 60 * 1000);
        try {
          await prisma.contact.update({
            where: { id: contact.id, tenantId: Number(tenantId) },
            data: {
              callifiedDnpRetryCount: { increment: 1 },
              callifiedDnpNextRetryAt: nextRetryAt,
            },
          });

          getAutoDialQueue().enqueue({
            tenantId: Number(tenantId),
            contactId: contact.id,
            campaignId: contact.callifiedCampaignId,
            userId: null,
          });

          console.log(
            `[callifiedDnpRetry] enqueued retry ${contact.callifiedDnpRetryCount + 1}/${settings.maxRetries} for contact ${contact.id} (tenant ${tenantId})`,
          );
        } catch (err) {
          console.error(`[callifiedDnpRetry] failed to enqueue retry for contact ${contact.id}:`, err.message);
        }
      }
    }
  } catch (e) {
    console.error("[callifiedDnpRetry] tick error:", e.message);
  } finally {
    isProcessingTick = false;
  }
}

function startDnpRetryEngine() {
  if (tickInterval) return;
  tickInterval = setInterval(() => {
    processDnpRetries().catch((e) => console.error("[callifiedDnpRetry] interval tick error:", e.message));
  }, DNP_RETRY_TICK_MS);

  // Process any work that is already due immediately on startup.
  processDnpRetries().catch((e) => console.error("[callifiedDnpRetry] initial tick error:", e.message));
  console.log("[callifiedDnpRetry] engine started");
}

function stopDnpRetryEngine() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  isProcessingTick = false;
}

module.exports = {
  getDnpRetrySettings,
  scheduleDnpRetry,
  clearDnpRetryState,
  processDnpRetries,
  startDnpRetryEngine,
  stopDnpRetryEngine,
};
