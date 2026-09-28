const { parseDateTimeLocalInTZ, formatInTenantTZ } = require("./datetime");

const DAY_NAMES = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];

function parseJson(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function isValidTimeZone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function addUtcDays(dateKey, amount) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function clampInt(raw, fallback, min, max) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeWindows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => ({
      start: String(row?.start || ""),
      end: String(row?.end || ""),
    }))
    .filter((row) => /^\d{2}:\d{2}$/.test(row.start) && /^\d{2}:\d{2}$/.test(row.end) && row.end > row.start);
}

function windowsForDate(form, dateKey) {
  const overrides = parseJson(form.dateOverridesJson, {});
  const override = overrides && typeof overrides === "object" ? overrides[dateKey] : null;
  if (override?.closed === true) return [];
  if (override && Array.isArray(override.windows)) return normalizeWindows(override.windows);

  const localNoon = parseDateTimeLocalInTZ(`${dateKey}T12:00`, form.timezone);
  if (Number.isNaN(localNoon.getTime())) return [];
  const dayIndex = Number(formatInTenantTZ(localNoon, form.timezone, "i")) % 7;
  const weekly = parseJson(form.weeklyHoursJson, {});
  return normalizeWindows(weekly[DAY_NAMES[dayIndex]]);
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function makeSlot(form, dateKey, wallTime) {
  const start = parseDateTimeLocalInTZ(`${dateKey}T${wallTime}`, form.timezone);
  if (Number.isNaN(start.getTime())) return null;
  const durationMins = clampInt(form.durationMins, 30, 5, 480);
  const end = new Date(start.getTime() + durationMins * 60_000);
  return {
    start,
    end,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    time: wallTime,
    label: formatInTenantTZ(start, form.timezone, "h:mm a"),
  };
}

function buildAvailability({ form, startDate, days, busyIntervals = [], reservedSlots = [], now = new Date() }) {
  if (!isValidTimeZone(form.timezone)) {
    const error = new Error("Meeting form timezone is invalid");
    error.code = "INVALID_TIMEZONE";
    throw error;
  }
  if (!validDateKey(startDate)) {
    const error = new Error("start must be YYYY-MM-DD");
    error.code = "INVALID_DATE";
    throw error;
  }

  const requestedDays = clampInt(days, 14, 1, 62);
  const interval = clampInt(form.slotIntervalMins, form.durationMins || 30, 5, 480);
  const beforeMs = clampInt(form.bufferBeforeMins, 0, 0, 240) * 60_000;
  const afterMs = clampInt(form.bufferAfterMins, 0, 0, 240) * 60_000;
  const noticeCutoff = now.getTime() + clampInt(form.minimumNoticeMins, 0, 0, 43_200) * 60_000;
  const horizonKey = addUtcDays(formatInTenantTZ(now, form.timezone, "yyyy-MM-dd"), clampInt(form.bookingHorizonDays, 60, 1, 730));
  const blackouts = new Set(parseJson(form.blackoutDatesJson, []));
  const allowedStart = form.allowedStartDate ? formatInTenantTZ(form.allowedStartDate, form.timezone, "yyyy-MM-dd") : null;
  const allowedEnd = form.allowedEndDate ? formatInTenantTZ(form.allowedEndDate, form.timezone, "yyyy-MM-dd") : null;
  const maxPerDay = form.maxBookingsPerDay == null ? null : clampInt(form.maxBookingsPerDay, 1, 1, 500);

  const normalizedBusy = [...busyIntervals, ...reservedSlots].map((row) => ({
    start: new Date(row.start || row.scheduledAt).getTime(),
    end: new Date(row.end || row.endsAt).getTime(),
  })).filter((row) => Number.isFinite(row.start) && Number.isFinite(row.end));

  const results = [];
  for (let offset = 0; offset < requestedDays; offset += 1) {
    const date = addUtcDays(startDate, offset);
    if (!date) continue;
    const outsideRange = (allowedStart && date < allowedStart) || (allowedEnd && date > allowedEnd) || date > horizonKey;
    const dayReservations = reservedSlots.filter((row) => formatInTenantTZ(row.start || row.scheduledAt, form.timezone, "yyyy-MM-dd") === date);
    const dailyLimitReached = maxPerDay != null && dayReservations.length >= maxPerDay;
    const slots = [];
    const displaySlots = [];

    if (!outsideRange && !blackouts.has(date)) {
      for (const window of windowsForDate(form, date)) {
        const [startHour, startMinute] = window.start.split(":").map(Number);
        const [endHour, endMinute] = window.end.split(":").map(Number);
        const firstMinute = startHour * 60 + startMinute;
        const lastMinute = endHour * 60 + endMinute;
        for (let minute = firstMinute; minute + form.durationMins <= lastMinute; minute += interval) {
          const wallTime = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
          const slot = makeSlot(form, date, wallTime);
          if (!slot) continue;
          const occupiedStart = slot.start.getTime() - beforeMs;
          const occupiedEnd = slot.end.getTime() + afterMs;
          const conflict = normalizedBusy.some((busy) => rangesOverlap(occupiedStart, occupiedEnd, busy.start, busy.end));
          const noticeBlocked = slot.start.getTime() < noticeCutoff;
          const available = !dailyLimitReached && !noticeBlocked && !conflict;
          const row = { start: slot.startIso, end: slot.endIso, time: slot.time, label: slot.label };
          displaySlots.push({
            ...row,
            available,
            unavailableReason: available ? null : dailyLimitReached ? "daily_limit" : noticeBlocked ? "notice" : "occupied",
          });
          if (available) {
            slots.push(row);
          }
        }
      }
    }
    results.push({ date, available: slots.length > 0, slots, displaySlots });
  }
  return results;
}

module.exports = {
  buildAvailability,
  isValidTimeZone,
  parseJson,
  normalizeWindows,
  windowsForDate,
  validDateKey,
  addUtcDays,
};
