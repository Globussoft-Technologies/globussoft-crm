import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const prisma = vi.hoisted(() => {
  const Module = require("node:module");
  const fromBackend = Module.createRequire(process.cwd() + "/");
  const prismaPath = fromBackend.resolve("./lib/prisma");
  const mock = { travelMeetingZoomCredential: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), delete: vi.fn() } };
  Module._cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: mock, children: [], paths: [] };
  return mock;
});

const zoom = requireCJS("../../services/travelMeetingZoom");

beforeEach(() => {
  prisma.travelMeetingZoomCredential.findUnique.mockReset();
  prisma.travelMeetingZoomCredential.upsert.mockReset();
  prisma.travelMeetingZoomCredential.update.mockReset();
  prisma.travelMeetingZoomCredential.delete.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("travelMeetingZoom", () => {
  it("verifies, stores, and returns masked tenant credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ access_token: "token", scope: "meeting:write:meeting:admin meeting:delete:meeting:admin" }) });
    prisma.travelMeetingZoomCredential.upsert.mockImplementation(async ({ create }) => ({ id: 1, status: "CONNECTED", verifiedAt: new Date(), lastError: null, ...create }));
    const result = await zoom.connect({ tenantId: 8, accountId: "account-1234", clientId: "client-abcd", clientSecret: "super-secret", zoomHostUserId: "host@example.com" });
    const write = prisma.travelMeetingZoomCredential.upsert.mock.calls[0][0].create;
    expect(write.accountId).toBe("account-1234");
    expect(write.clientSecret).toBe("super-secret");
    expect(result).toMatchObject({ configured: true, accountId: "****1234", clientId: "****abcd", clientSecretConfigured: true, zoomHostUserId: "host@example.com" });
  });

  it("rejects valid credentials when required meeting scopes are missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ access_token: "token", scope: "user:read:user:admin" }) });
    await expect(zoom.connect({ tenantId: 8, accountId: "account", clientId: "client", clientSecret: "secret" })).rejects.toMatchObject({ code: "ZOOM_SCOPES_MISSING", status: 400 });
    expect(prisma.travelMeetingZoomCredential.upsert).not.toHaveBeenCalled();
  });

  it("creates meetings with only the requesting tenant's stored connection", async () => {
    prisma.travelMeetingZoomCredential.findUnique.mockResolvedValue({
      tenantId: 8,
      status: "CONNECTED",
      accountId: "tenant-account",
      clientId: "tenant-client",
      clientSecret: "tenant-secret",
      zoomHostUserId: "host@example.com",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token", scope: "meeting:write:meeting:admin meeting:delete:meeting:admin" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 123, join_url: "https://zoom.us/j/123" }) });
    const result = await zoom.createMeeting({ tenantId: 8, topic: "TMC", startTime: "2026-09-25T05:00:00Z", durationMins: 30, timezone: "Asia/Kolkata" });
    expect(prisma.travelMeetingZoomCredential.findUnique).toHaveBeenCalledWith({ where: { tenantId: 8 } });
    expect(fetchSpy.mock.calls[1][0]).toContain("/users/host%40example.com/meetings");
    expect(result).toMatchObject({ meetingId: 123, joinUrl: "https://zoom.us/j/123" });
  });

  it("permanently removes the tenant credential row on disconnect", async () => {
    prisma.travelMeetingZoomCredential.findUnique.mockResolvedValue({ id: 41 });
    prisma.travelMeetingZoomCredential.delete.mockResolvedValue({ id: 41 });
    const result = await zoom.disconnect(8);
    expect(prisma.travelMeetingZoomCredential.delete).toHaveBeenCalledWith({ where: { tenantId: 8 } });
    expect(result).toMatchObject({ configured: false, status: "NOT_CONFIGURED", clientSecretConfigured: false });
  });
});
