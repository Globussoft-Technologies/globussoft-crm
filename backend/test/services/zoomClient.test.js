// Unit tests for services/zoomClient.js — Server-to-Server-OAuth Zoom meeting
// creation behind the Calendar "Add a Zoom link" option. Creds are read at call
// time, so tests just toggle process.env. global fetch is spied per-test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const zoom = requireCJS("../../services/zoomClient");

const setCreds = (on) => {
  if (on) {
    process.env.ZOOM_ACCOUNT_ID = "acc";
    process.env.ZOOM_CLIENT_ID = "cid";
    process.env.ZOOM_CLIENT_SECRET = "sec";
  } else {
    delete process.env.ZOOM_ACCOUNT_ID;
    delete process.env.ZOOM_CLIENT_ID;
    delete process.env.ZOOM_CLIENT_SECRET;
  }
};

afterEach(() => {
  setCreds(false);
  vi.restoreAllMocks();
});

describe("zoomClient — disabled (no creds)", () => {
  it("isEnabled() is false and createMeeting() returns null without calling fetch", async () => {
    setCreds(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(zoom.isEnabled()).toBe(false);
    expect(await zoom.createMeeting({ topic: "x" })).toBe(null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("zoomClient — enabled", () => {
  beforeEach(() => setCreds(true));

  it("creates a meeting → OAuth then meetings POST, returns the join link", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 123, join_url: "https://zoom.us/j/123", start_url: "https://zoom.us/s/123", password: "p" }),
      });
    const r = await zoom.createMeeting({ topic: "Consult", startTime: "2026-07-01T10:00:00Z", durationMins: 30 });
    expect(zoom.isEnabled()).toBe(true);
    expect(r).toMatchObject({ joinUrl: "https://zoom.us/j/123", meetingId: 123, password: "p" });
    expect(fetchSpy.mock.calls[0][0]).toContain("zoom.us/oauth/token");
    expect(fetchSpy.mock.calls[1][0]).toContain("/v2/users/me/meetings");
  });

  it("throws on a Zoom API error so the route can log + fall back", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad request" });
    await expect(zoom.createMeeting({ topic: "x" })).rejects.toThrow(/Zoom create-meeting failed/);
  });
});
