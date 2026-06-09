// Shared slot-picker math for calendar providers (Google + Outlook).
// Keeps the free/busy → open-slots computation identical across providers so
// the UI behaves the same regardless of which calendar is connected.

function clampInt(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Parse slot-picker query params into a UTC working window.
// Returns { error } on bad input, else
//   { dateStr, durationMins, stepMins, windowStartMs, windowEndMs }.
function parseSlotWindow(query) {
  const dateStr = String((query && query.date) || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { error: "date is required in YYYY-MM-DD format" };
  }
  const durationMins = clampInt(query.durationMins, 30, 5, 480);
  const startHour = clampInt(query.startHour, 9, 0, 23);
  const endHour = clampInt(query.endHour, 18, 1, 24);
  if (endHour <= startHour) {
    return { error: "endHour must be greater than startHour" };
  }
  const stepMins = clampInt(query.stepMins, durationMins, 5, 480);
  const tzOffsetMins = clampInt(query.tzOffsetMins, 0, -840, 840);

  const [y, m, d] = dateStr.split("-").map(Number);
  const localMidnightUtcMs = Date.UTC(y, m - 1, d) - tzOffsetMins * 60_000;
  return {
    dateStr,
    durationMins,
    stepMins,
    windowStartMs: localMidnightUtcMs + startHour * 3_600_000,
    windowEndMs: localMidnightUtcMs + endHour * 3_600_000,
  };
}

// Given busy intervals [{ start: ms, end: ms }], compute open slots of
// durationMins length stepping by stepMins, skipping any that are in the past
// (< nowMs) or overlap a busy block. Returns [{ start: ISO, end: ISO }].
function freeSlots(windowStartMs, windowEndMs, busy, durationMins, stepMins, nowMs) {
  const durationMs = durationMins * 60_000;
  const stepMs = stepMins * 60_000;
  const slots = [];
  for (let t = windowStartMs; t + durationMs <= windowEndMs; t += stepMs) {
    if (t < nowMs) continue;
    const slotEnd = t + durationMs;
    const overlaps = (busy || []).some((b) => t < b.end && slotEnd > b.start);
    if (!overlaps) {
      slots.push({ start: new Date(t).toISOString(), end: new Date(slotEnd).toISOString() });
    }
  }
  return slots;
}

module.exports = { clampInt, parseSlotWindow, freeSlots };
