import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const { buildAvailability, storedDateKey } = requireCJS("../../lib/travelMeetingAvailability");

function form(overrides = {}) {
  return {
    timezone: "Asia/Kolkata",
    durationMins: 30,
    slotIntervalMins: 30,
    bufferBeforeMins: 0,
    bufferAfterMins: 0,
    minimumNoticeMins: 0,
    bookingHorizonDays: 365,
    maxBookingsPerDay: null,
    allowedStartDate: null,
    allowedEndDate: null,
    weeklyHoursJson: JSON.stringify({
      monday: [{ start: "10:00", end: "12:00" }],
      tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [],
    }),
    dateOverridesJson: "{}",
    blackoutDatesJson: "[]",
    ...overrides,
  };
}

describe("travelMeetingAvailability", () => {
  it("keeps stored date-only boundaries on their selected calendar day", () => {
    expect(storedDateKey(new Date("2026-10-01T23:59:59.999Z"))).toBe("2026-10-01");
    expect(storedDateKey("2026-10-01")).toBe("2026-10-01");
  });

  it("returns past dates as unavailable without exposing past time controls", () => {
    const dates = buildAvailability({
      form: form(),
      startDate: "2026-09-28",
      days: 1,
      now: new Date("2026-09-29T06:00:00Z"),
    });
    expect(dates[0]).toMatchObject({ date: "2026-09-28", available: false, slots: [], displaySlots: [] });
  });

  it("creates timezone-correct slots from customizable weekly hours", () => {
    const dates = buildAvailability({ form: form(), startDate: "2026-09-28", days: 1, now: new Date("2026-09-01T00:00:00Z") });
    expect(dates[0].slots).toHaveLength(4);
    expect(dates[0].slots[0]).toMatchObject({ time: "10:00", start: "2026-09-28T04:30:00.000Z" });
  });

  it("honours closed dates and date-specific replacement windows", () => {
    const closed = buildAvailability({
      form: form({ dateOverridesJson: JSON.stringify({ "2026-09-28": { closed: true } }) }),
      startDate: "2026-09-28", days: 1, now: new Date("2026-09-01T00:00:00Z"),
    });
    expect(closed[0].slots).toEqual([]);

    const replacement = buildAvailability({
      form: form({ dateOverridesJson: JSON.stringify({ "2026-09-28": { windows: [{ start: "15:00", end: "16:00" }] } }) }),
      startDate: "2026-09-28", days: 1, now: new Date("2026-09-01T00:00:00Z"),
    });
    expect(replacement[0].slots.map((slot) => slot.time)).toEqual(["15:00", "15:30"]);
  });

  it("removes provider-busy and atomically reserved slots", () => {
    const dates = buildAvailability({
      form: form(),
      startDate: "2026-09-28",
      days: 1,
      now: new Date("2026-09-01T00:00:00Z"),
      busyIntervals: [{ start: "2026-09-28T04:30:00.000Z", end: "2026-09-28T05:00:00.000Z" }],
      reservedSlots: [{ scheduledAt: "2026-09-28T05:30:00.000Z", endsAt: "2026-09-28T06:00:00.000Z" }],
    });
    expect(dates[0].slots.map((slot) => slot.time)).toEqual(["10:30", "11:30"]);
    expect(dates[0].displaySlots.map((slot) => slot.time)).toEqual(["10:00", "10:30", "11:00", "11:30"]);
    expect(dates[0].displaySlots.find((slot) => slot.time === "11:00")).toMatchObject({ available: false, unavailableReason: "occupied" });
  });

  it("applies buffers, notice, blackout dates, horizon and daily limits", () => {
    const buffered = buildAvailability({
      form: form({ bufferBeforeMins: 15, blackoutDatesJson: "[]" }),
      startDate: "2026-09-28",
      days: 1,
      now: new Date("2026-09-01T00:00:00Z"),
      busyIntervals: [{ start: "2026-09-28T05:20:00.000Z", end: "2026-09-28T05:25:00.000Z" }],
    });
    expect(buffered[0].slots.map((slot) => slot.time)).not.toContain("11:00");

    const limited = buildAvailability({
      form: form({ maxBookingsPerDay: 1 }),
      startDate: "2026-09-28", days: 1, now: new Date("2026-09-01T00:00:00Z"),
      reservedSlots: [{ scheduledAt: "2026-09-28T04:30:00.000Z", endsAt: "2026-09-28T05:00:00.000Z" }],
    });
    expect(limited[0].available).toBe(false);
  });
});
