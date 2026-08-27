const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const { notify } = require("../lib/notificationService");

const REMINDER_WINDOWS = [
  {
    key: "24h",
    label: "24 hours",
    ms: 24 * 60 * 60 * 1000,
    minMs: 23 * 60 * 60 * 1000,
    maxMs: 25 * 60 * 60 * 1000,
  },
  {
    key: "30m",
    label: "30 minutes",
    ms: 30 * 60 * 1000,
    minMs: 25 * 60 * 1000,
    maxMs: 35 * 60 * 1000,
  },
  {
    key: "10m",
    label: "10 minutes",
    ms: 10 * 60 * 1000,
    minMs: 5 * 60 * 1000,
    maxMs: 15 * 60 * 1000,
  },
];

function isBirthdayLikeEvent(event) {
  const text = `${event?.title || ""} ${event?.description || ""}`.toLowerCase();
  return text.includes("birthday");
}

function hashReminderEntityId(key) {
  let hash = 2166136261;
  const text = String(key);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const normalized = hash & 0x7fffffff;
  return normalized === 0 ? 1 : normalized;
}

function formatReminderTime(date) {
  try {
    return new Date(date).toLocaleString("en-IN", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      day: "numeric",
      month: "short",
    });
  } catch {
    return new Date(date).toISOString();
  }
}

function buildReminderEntityId(tenantId, userId, event, reminderKey) {
  const startIso = new Date(event.startTime).toISOString();
  return hashReminderEntityId([tenantId, userId, event.id, startIso, reminderKey].join(":"));
}

function buildReminderCopy(event, windowSpec) {
  const titleBase = event.title || "Meeting";
  if (windowSpec.key === "30m") {
    return {
      title: `Meeting starting in 30 mins: ${titleBase}`,
      message: `${titleBase} starts at ${formatReminderTime(event.startTime)}. This is your 30-minute reminder.`,
    };
  }
  if (windowSpec.key === "10m") {
    return {
      title: `Meeting starting in 10 mins: ${titleBase}`,
      message: `${titleBase} starts at ${formatReminderTime(event.startTime)}. This is your 10-minute reminder.`,
    };
  }
  return {
    title: `Meeting reminder: ${titleBase}`,
    message: `${titleBase} starts at ${formatReminderTime(event.startTime)}. This is your 24-hour reminder.`,
  };
}

async function runCalendarRemindersForTenant(tenantId, io = null) {
  const now = new Date();
  const horizon = new Date(now.getTime() + Math.max(...REMINDER_WINDOWS.map((w) => w.maxMs)));

  const events = await prisma.calendarEvent.findMany({
    where: {
      tenantId,
      startTime: { gte: now, lte: horizon },
    },
    select: {
      id: true,
      title: true,
      description: true,
      startTime: true,
      userId: true,
      provider: true,
      tenantId: true,
    },
  });

  if (events.length === 0) {
    return { notified: 0, skipped: 0 };
  }

  let notified = 0;
  let skipped = 0;

  for (const event of events) {
    if (isBirthdayLikeEvent(event)) {
      skipped += 1;
      continue;
    }

    const timeUntilStart = new Date(event.startTime).getTime() - now.getTime();
    if (timeUntilStart <= 0) {
      skipped += 1;
      continue;
    }

    for (const windowSpec of REMINDER_WINDOWS) {
      if (timeUntilStart < windowSpec.minMs || timeUntilStart > windowSpec.maxMs) continue;

      const reminderCopy = buildReminderCopy(event, windowSpec);
      const entityId = buildReminderEntityId(tenantId, event.userId, event, windowSpec.key);

      try {
        const result = await notify({
          userId: event.userId,
          tenantId,
          title: reminderCopy.title,
          message: reminderCopy.message,
          type: "warning",
          priority: windowSpec.key === "10m" ? "high" : "normal",
          link: "/calendar-sync",
          entityType: "calendar_alert",
          entityId,
          io,
        });
        if (result) notified += 1;
      } catch (e) {
        console.error(
          `[CalendarReminder] tenant=${tenantId} event=${event.id} window=${windowSpec.key} failed:`,
          e.message,
        );
      }
    }
  }

  return { notified, skipped };
}

async function runCalendarRemindersForAllTenants(io = null) {
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true },
    select: { id: true, slug: true },
  });

  let totalNotified = 0;
  let totalSkipped = 0;

  for (const tenant of tenants) {
    try {
      const result = await runCalendarRemindersForTenant(tenant.id, io);
      totalNotified += result.notified;
      totalSkipped += result.skipped;
      if (result.notified > 0) {
        console.log(
          `[CalendarReminder] tenant ${tenant.slug || tenant.id}: notified=${result.notified} skipped=${result.skipped}`,
        );
      }
    } catch (e) {
      console.error(`[CalendarReminder] tenant ${tenant.slug || tenant.id} failed:`, e.message);
    }
  }

  return { totalNotified, totalSkipped };
}

function initCalendarReminderCron(io = null) {
  cronRegistry.register({
    name: "calendarReminderEngine",
    description: "Calendar meeting notifications at T-24h/T-30m/T-10m",
    defaultSchedule: "*/1 * * * *",
    tickFn: () => runCalendarRemindersForAllTenants(io),
  }).catch((e) => console.error("[CalendarReminder] cronRegistry registration failed:", e.message));
}

module.exports = {
  initCalendarReminderCron,
  runCalendarRemindersForTenant,
  runCalendarRemindersForAllTenants,
};
