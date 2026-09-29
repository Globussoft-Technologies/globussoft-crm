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
const { formatInTenantTZ, parseDateTimeLocalInTZ } = require("./datetime");

const DNP_RETRY_TICK_MS = 60 * 1000; // 1 minute

let tickInterval = null;
let isProcessingTick = false;
let isProcessingPendingTick = false;

/**
 * Lazy accessor for the auto-dial queue so this module and the queue module
 * can both reference each other without a circular-require crash.
 */
function getAutoDialQueue() {
  return require("./callifiedAutoDialQueue");
}

async function getDnpRetrySettings(tenantId) {
  const [enabledRaw, maxRetriesRaw, intervalMinutesRaw, mode, dayIntervalRaw, timeLocal, timezone] = await Promise.all([
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
    getSetting(tenantId, KEYS.CALLIFIED_DNP_RETRY_MODE, { fallback: "delay" }),
    getSetting(tenantId, KEYS.CALLIFIED_DNP_RETRY_DAY_INTERVAL, { coerce: Number, fallback: 1 }),
    getSetting(tenantId, KEYS.CALLIFIED_DNP_RETRY_TIME_LOCAL, { fallback: "10:00" }),
    getSetting(tenantId, KEYS.CALLIFIED_RETRY_TIMEZONE, { fallback: "UTC" }),
  ]);

  const enabled = Boolean(enabledRaw);
  const maxRetries = Math.max(1, Math.min(Number.isFinite(maxRetriesRaw) ? maxRetriesRaw : 3, 10));
  const intervalMinutes = Math.max(
    5,
    Math.min(Number.isFinite(intervalMinutesRaw) ? intervalMinutesRaw : 60, 30 * 24 * 60),
  );
  const dayInterval = Math.max(1, Math.min(Number.isFinite(dayIntervalRaw) ? dayIntervalRaw : 1, 30));
  return {
    enabled, maxRetries, intervalMinutes,
    mode: String(mode) === "scheduled" ? "scheduled" : "delay",
    dayInterval,
    timeLocal: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(timeLocal)) ? String(timeLocal) : "10:00",
    timezone: String(timezone || "UTC"),
  };
}

async function getPendingRetrySettings(tenantId) {
  const [enabledRaw, maxRetriesRaw, intervalMinutesRaw, mode, dayIntervalRaw, timeLocal, timezone] = await Promise.all([
    getSetting(tenantId, KEYS.CALLIFIED_PENDING_RETRY_ENABLED, {
      coerce: (v) => String(v).toLowerCase() === "true" || v === "1" || v === 1 || v === true,
      fallback: true,
    }),
    getSetting(tenantId, KEYS.CALLIFIED_PENDING_RETRY_MAX_RETRIES, { coerce: Number, fallback: 3 }),
    getSetting(tenantId, KEYS.CALLIFIED_PENDING_RETRY_INTERVAL_MINUTES, { coerce: Number, fallback: 60 }),
    getSetting(tenantId, KEYS.CALLIFIED_PENDING_RETRY_MODE, { fallback: "delay" }),
    getSetting(tenantId, KEYS.CALLIFIED_PENDING_RETRY_DAY_INTERVAL, { coerce: Number, fallback: 1 }),
    getSetting(tenantId, KEYS.CALLIFIED_PENDING_RETRY_TIME_LOCAL, { fallback: "10:00" }),
    getSetting(tenantId, KEYS.CALLIFIED_RETRY_TIMEZONE, { fallback: "UTC" }),
  ]);
  return {
    enabled: Boolean(enabledRaw),
    maxRetries: Math.max(1, Math.min(Number.isFinite(maxRetriesRaw) ? maxRetriesRaw : 3, 10)),
    intervalMinutes: Math.max(5, Math.min(Number.isFinite(intervalMinutesRaw) ? intervalMinutesRaw : 60, 30 * 24 * 60)),
    mode: String(mode) === "scheduled" ? "scheduled" : "delay",
    dayInterval: Math.max(1, Math.min(Number.isFinite(dayIntervalRaw) ? dayIntervalRaw : 1, 30)),
    timeLocal: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(timeLocal)) ? String(timeLocal) : "10:00",
    timezone: String(timezone || "UTC"),
  };
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function computeNextRetryAt(settings, now = new Date()) {
  if (settings.mode !== "scheduled") {
    return new Date(now.getTime() + settings.intervalMinutes * 60 * 1000);
  }
  const todayKey = formatInTenantTZ(now, settings.timezone, "yyyy-MM-dd");
  let dateKey = todayKey;
  let candidate = parseDateTimeLocalInTZ(`${dateKey}T${settings.timeLocal}`, settings.timezone);
  const mustAdvance = settings.dayInterval > 1 || Number.isNaN(candidate.getTime()) || candidate <= now;
  if (mustAdvance) {
    dateKey = addDaysToDateKey(todayKey, settings.dayInterval);
    candidate = parseDateTimeLocalInTZ(`${dateKey}T${settings.timeLocal}`, settings.timezone);
  }
  return Number.isNaN(candidate.getTime())
    ? new Date(now.getTime() + settings.dayInterval * 24 * 60 * 60 * 1000)
    : candidate;
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
  const settings = await getDnpRetrySettings(tenantId);
  const { enabled } = settings;
  if (!enabled) return null;

  const nextRetryAt = computeNextRetryAt(settings);
  return prisma.contact.update({
    where: { id: Number(contactId), tenantId },
    data: {
      callifiedDnpNextRetryAt: nextRetryAt,
    },
  });
}

async function schedulePendingRetry(tenantId, contactId) {
  const settings = await getPendingRetrySettings(tenantId);
  const { enabled } = settings;
  if (!enabled) return null;
  return prisma.contact.update({
    where: { id: Number(contactId), tenantId },
    data: { callifiedDnpNextRetryAt: computeNextRetryAt(settings) },
  });
}

async function processPendingRetries(now = new Date()) {
  if (isProcessingPendingTick) return;
  isProcessingPendingTick = true;
  try {
    const dueContacts = await prisma.contact.findMany({
      where: {
        status: "Lead",
        deletedAt: null,
        tenant: { vertical: "generic" },
        callifiedLeadStatus: CALL_STATUS.PENDING,
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
        callifiedDnpNextRetryAt: true,
        callifiedLeadStatus: true,
      },
    });

    const byTenant = new Map();
    for (const contact of dueContacts.filter((row) => row.callifiedLeadStatus === CALL_STATUS.PENDING)) {
      const list = byTenant.get(contact.tenantId) || [];
      list.push(contact);
      byTenant.set(contact.tenantId, list);
    }
    for (const [tenantId, contacts] of byTenant) {
      const settings = await getPendingRetrySettings(Number(tenantId));
      if (!settings.enabled) continue;
      for (const contact of contacts) {
        if (contact.callifiedDnpRetryCount >= settings.maxRetries) continue;
        const nextRetryAt = computeNextRetryAt(settings, now);

        // Leads that became Pending while retries were disabled have no due
        // timestamp. Start their configured delay now; do not dial them
        // immediately or consume a retry before the delay has elapsed.
        if (!contact.callifiedDnpNextRetryAt) {
          await prisma.contact.update({
            where: { id: contact.id, tenantId: Number(tenantId) },
            data: { callifiedDnpNextRetryAt: nextRetryAt },
          });
          continue;
        }

        await prisma.contact.update({
          where: { id: contact.id, tenantId: Number(tenantId) },
          data: {
            callifiedDnpRetryCount: { increment: 1 },
            callifiedDnpNextRetryAt: nextRetryAt,
          },
        });
        getAutoDialQueue().enqueue({
          tenantId: Number(tenantId), contactId: contact.id,
          campaignId: contact.callifiedCampaignId, userId: null,
        });
      }
    }
  } catch (e) {
    console.error("[callifiedPendingRetry] tick error:", e.message);
  } finally {
    isProcessingPendingTick = false;
  }
}

/**
 * Main tick: find DNP leads whose retry window has arrived and enqueue them
 * for an auto-dial. Grouped by tenant so per-tenant retry settings are honored.
 */
async function processDnpRetries(now = new Date()) {
  if (isProcessingTick) return;
  isProcessingTick = true;

  try {
    // Pre-filter with a loose upper bound; exact max is enforced per-tenant below.
    const dueContacts = await prisma.contact.findMany({
      where: {
        status: "Lead",
        deletedAt: null,
        tenant: { vertical: "generic" },
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
        callifiedDnpNextRetryAt: true,
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

        const nextRetryAt = computeNextRetryAt(settings, now);
        try {
          // A DNP recorded while retries were disabled must first receive its
          // configured delay. It is not an immediately-due retry.
          if (!contact.callifiedDnpNextRetryAt) {
            await prisma.contact.update({
              where: { id: contact.id, tenantId: Number(tenantId) },
              data: { callifiedDnpNextRetryAt: nextRetryAt },
            });
            continue;
          }

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
    processPendingRetries().catch((e) => console.error("[callifiedPendingRetry] interval tick error:", e.message));
  }, DNP_RETRY_TICK_MS);

  // Process any work that is already due immediately on startup.
  processDnpRetries().catch((e) => console.error("[callifiedDnpRetry] initial tick error:", e.message));
  processPendingRetries().catch((e) => console.error("[callifiedPendingRetry] initial tick error:", e.message));
  console.log("[callifiedDnpRetry] engine started");
}

function stopDnpRetryEngine() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  isProcessingTick = false;
  isProcessingPendingTick = false;
}

module.exports = {
  getDnpRetrySettings,
  getPendingRetrySettings,
  computeNextRetryAt,
  scheduleDnpRetry,
  schedulePendingRetry,
  clearDnpRetryState,
  processDnpRetries,
  processPendingRetries,
  startDnpRetryEngine,
  stopDnpRetryEngine,
};
