// Unit tests for lib/travelPortalNotificationService.js — the travel customer-
// portal notification inbox (contact-scoped). Prisma singleton monkeypatched
// via createRequire (proven idiom; vi.mock can't reach the SUT's CJS require).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS("../../lib/prisma");
const svc = requireCJS("../../lib/travelPortalNotificationService");

beforeEach(() => {
  prisma.travelPortalNotification = {
    create: vi.fn(async ({ data }) => ({ id: 1, isRead: false, ...data })),
    findMany: vi.fn(async () => [{ id: 1, tenantId: 9, title: "t", message: "m", isRead: false }]),
    count: vi.fn(async () => 2),
    findFirst: vi.fn(),
    update: vi.fn(async ({ data }) => ({ id: 5, isRead: true, ...data })),
    updateMany: vi.fn(async () => ({ count: 3 })),
  };
});

describe("createTravelPortalNotification", () => {
  it("persists with defaults + validates required fields", async () => {
    const row = await svc.createTravelPortalNotification({ contactId: 7, tenantId: 9, title: "Trip ready", message: "Review it" });
    expect(prisma.travelPortalNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contactId: 7, tenantId: 9, type: "info", link: null }) }),
    );
    expect(row.contactId).toBe(7);
    await expect(svc.createTravelPortalNotification({ tenantId: 9, title: "x", message: "y" })).rejects.toThrow(/contactId/);
    await expect(svc.createTravelPortalNotification({ contactId: 7, tenantId: 9, message: "y" })).rejects.toThrow(/title/);
  });
});

describe("safeNotifyTravelCustomer", () => {
  it("returns the row on success", async () => {
    const r = await svc.safeNotifyTravelCustomer({ contactId: 7, tenantId: 9, title: "a", message: "b" });
    expect(r).toBeTruthy();
  });
  it("swallows errors (never throws) and returns null", async () => {
    prisma.travelPortalNotification.create.mockRejectedValueOnce(new Error("db down"));
    const r = await svc.safeNotifyTravelCustomer({ contactId: 7, tenantId: 9, title: "a", message: "b" });
    expect(r).toBe(null);
  });
  it("no-ops without a contactId", async () => {
    const r = await svc.safeNotifyTravelCustomer({ tenantId: 9, title: "a", message: "b" });
    expect(r).toBe(null);
    expect(prisma.travelPortalNotification.create).not.toHaveBeenCalled();
  });
});

describe("listTravelPortalNotifications", () => {
  it("returns items + unreadCount; unreadOnly narrows the where", async () => {
    const out = await svc.listTravelPortalNotifications(7, { unreadOnly: true });
    expect(out.unreadCount).toBe(2);
    expect(out.items).toHaveLength(1);
    expect(prisma.travelPortalNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contactId: 7, isRead: false } }),
    );
  });
});

describe("markTravelPortalNotificationRead", () => {
  it("returns null when the row isn't the caller's", async () => {
    prisma.travelPortalNotification.findFirst.mockResolvedValueOnce(null);
    expect(await svc.markTravelPortalNotificationRead(7, 999)).toBe(null);
  });
  it("is idempotent when already read", async () => {
    prisma.travelPortalNotification.findFirst.mockResolvedValueOnce({ id: 5, contactId: 7, isRead: true });
    const r = await svc.markTravelPortalNotificationRead(7, 5);
    expect(r.isRead).toBe(true);
    expect(prisma.travelPortalNotification.update).not.toHaveBeenCalled();
  });
  it("marks an unread row read", async () => {
    prisma.travelPortalNotification.findFirst.mockResolvedValueOnce({ id: 5, contactId: 7, isRead: false });
    const r = await svc.markTravelPortalNotificationRead(7, 5);
    expect(r.isRead).toBe(true);
    expect(prisma.travelPortalNotification.update).toHaveBeenCalled();
  });
});

describe("markAllTravelPortalNotificationsRead + toPublic", () => {
  it("returns the updated count", async () => {
    expect(await svc.markAllTravelPortalNotificationsRead(7)).toBe(3);
  });
  it("toPublic strips tenantId", () => {
    expect(svc.toPublic({ id: 1, tenantId: 9, title: "t" })).toEqual({ id: 1, title: "t" });
    expect(svc.toPublic(null)).toBe(null);
  });
});
