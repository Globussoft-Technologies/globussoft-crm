import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const prisma = vi.hoisted(() => {
  const Module = require("node:module");
  const fromBackend = Module.createRequire(process.cwd() + "/");
  const prismaPath = fromBackend.resolve("./lib/prisma");
  const mock = { travelMeetingBooking: { update: vi.fn() } };
  Module._cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mock, children: [], paths: [] };
  return mock;
});
const calendar = requireCJS("../../services/travelMeetingCalendar");
const { _internal } = requireCJS("../../routes/travel_meeting_forms");

const form = { id: 7, tenantId: 3, hostUserId: 5, calendarProvider: "google", createCalendarEvent: true, name: "Talk to an Expert" };
const booking = { id: 12, contactName: "Priya Sharma", institution: "Delhi Public School", contactEmail: "priya@school.edu.in", scheduledAt: new Date("2026-10-09T04:30:00Z"), endsAt: new Date("2026-10-09T05:00:00Z"), meetingUrl: null };

afterEach(() => vi.restoreAllMocks());

describe("external Meeting Form calendar", () => {
  it("adds a confirmed external booking to the connected host calendar without a Zoom link", async () => {
    const create = vi.spyOn(calendar, "createEvent").mockResolvedValue({ externalId: "google-123", calendarEventId: 2 });
    prisma.travelMeetingBooking.update.mockResolvedValue({ ...booking, status: "CONFIRMED", calendarProvider: "google", calendarEventId: "google-123" });
    const result = await _internal.finishExternalCalendarBooking(form, booking);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 3, userId: 5, attendeeEmail: "priya@school.edu.in", meetingUrl: null }));
    expect(result.calendarEventId).toBe("google-123");
  });

  it("keeps the booking confirmed and records the calendar failure", async () => {
    vi.spyOn(calendar, "createEvent").mockRejectedValue(new Error("Google Calendar unavailable"));
    prisma.travelMeetingBooking.update.mockResolvedValue({ ...booking, status: "CONFIRMED", failureCode: "CALENDAR_CREATE_FAILED" });
    const result = await _internal.finishExternalCalendarBooking(form, booking);
    expect(result.failureCode).toBe("CALENDAR_CREATE_FAILED");
    expect(prisma.travelMeetingBooking.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "CONFIRMED", failureCode: "CALENDAR_CREATE_FAILED" }) }));
  });
});
