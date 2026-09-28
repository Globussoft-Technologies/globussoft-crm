import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const prisma = vi.hoisted(() => {
  const Module = require("node:module");
  const fromBackend = Module.createRequire(process.cwd() + "/");
  const prismaPath = fromBackend.resolve("./lib/prisma");
  const mock = {
    calendarIntegration: { findUnique: vi.fn(), update: vi.fn() },
    calendarEvent: { create: vi.fn(), deleteMany: vi.fn() },
  };
  Module._cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mock, children: [], paths: [] };
  return mock;
});

const calendar = requireCJS("../../services/travelMeetingCalendar");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("travelMeetingCalendar", () => {
  it("creates the host Google event without sending Google's fixed-layout invitation email", async () => {
    const { google } = requireCJS("googleapis");
    const insert = vi.fn().mockResolvedValue({ data: { id: "google-event" } });
    vi.spyOn(google.auth, "OAuth2").mockImplementation(function MockOAuth2() {
      this.setCredentials = vi.fn();
      this.on = vi.fn();
    });
    vi.spyOn(google, "calendar").mockReturnValue({ events: { insert } });
    prisma.calendarIntegration.findUnique.mockResolvedValue({ id: 4, accessToken: "token", calendarId: "primary" });
    prisma.calendarEvent.create.mockResolvedValue({ id: 32 });

    await calendar.createEvent({ tenantId: 2, userId: 5, provider: "google", title: "Conversation", description: "Branded copy", start: new Date("2026-10-15T04:30:00Z"), end: new Date("2026-10-15T05:00:00Z"), attendeeEmail: "asha@example.edu", meetingUrl: "https://zoom.us/j/1" });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      sendUpdates: "none",
      requestBody: expect.objectContaining({ attendees: [{ email: "asha@example.edu" }] }),
    }));
  });

  it("creates an Outlook appointment and its tenant-scoped local event", async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({ id: 4, accessToken: "token", expiresAt: new Date("2099-01-01") });
    prisma.calendarEvent.create.mockResolvedValue({ id: 33 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ id: "outlook-event" }) });
    const result = await calendar.createEvent({ tenantId: 2, userId: 5, provider: "outlook", title: "Conversation", description: "Zoom", start: new Date("2026-10-15T04:30:00Z"), end: new Date("2026-10-15T05:00:00Z"), attendeeEmail: "asha@example.edu", contactId: 7, meetingUrl: "https://zoom.us/j/1" });
    expect(result).toEqual({ externalId: "outlook-event", calendarEventId: 33 });
    expect(prisma.calendarEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: 2, userId: 5, externalId: "outlook-event", contactId: 7 }) });
  });

  it("compensation removes the local event even if provider deletion fails", async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({ id: 4, accessToken: "token", expiresAt: new Date("2099-01-01") });
    prisma.calendarEvent.deleteMany.mockResolvedValue({ count: 1 });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("provider down"));
    await calendar.deleteEvent({ tenantId: 2, userId: 5, provider: "outlook", externalId: "outlook-event" });
    expect(prisma.calendarEvent.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 2, userId: 5, provider: "outlook", externalId: "outlook-event" } });
  });

  it("deletes a provider event when local persistence fails", async () => {
    prisma.calendarIntegration.findUnique.mockResolvedValue({ id: 4, accessToken: "token", expiresAt: new Date("2099-01-01") });
    prisma.calendarEvent.create.mockRejectedValue(new Error("database unavailable"));
    prisma.calendarEvent.deleteMany.mockResolvedValue({ count: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "orphan-candidate" }) })
      .mockResolvedValueOnce({ ok: true });
    await expect(calendar.createEvent({ tenantId: 2, userId: 5, provider: "outlook", title: "Conversation", description: "Zoom", start: new Date("2026-10-15T04:30:00Z"), end: new Date("2026-10-15T05:00:00Z"), attendeeEmail: "asha@example.edu", meetingUrl: "https://zoom.us/j/1" })).rejects.toThrow("database unavailable");
    expect(fetchSpy.mock.calls[1][0]).toContain("/me/events/orphan-candidate");
  });
});
