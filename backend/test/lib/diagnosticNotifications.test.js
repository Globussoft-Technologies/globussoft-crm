// @ts-check
//
// backend/lib/diagnosticNotifications.js — fan-out orchestrator for "a
// diagnostic was just submitted." Self-mocks sibling modules BEFORE
// requiring the SUT (CJS load semantics bypass vi.mock() — same pattern
// used throughout backend/test/routes/*.test.js in this repo).

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);

const settingsLib = requireCJS("../../lib/diagnosticNotificationSettings");
settingsLib.getNotificationRecipients = vi.fn();

const notificationService = requireCJS("../../lib/notificationService");
notificationService.notify = vi.fn();
notificationService.notifyMany = vi.fn();

const emailSender = requireCJS("../../lib/emailSender");
emailSender.sendEmail = vi.fn();

const whatsappWebClient = requireCJS("../../services/whatsappWebClient");
whatsappWebClient.sendBestEffort = vi.fn();
whatsappWebClient.isConnected = vi.fn();

prisma.user = {
  ...(prisma.user || {}),
  findMany: vi.fn(),
  findFirst: vi.fn(),
};

const diagnosticNotifications = requireCJS("../../lib/diagnosticNotifications");

beforeEach(() => {
  vi.clearAllMocks();
  settingsLib.getNotificationRecipients.mockResolvedValue([]);
  notificationService.notify.mockResolvedValue({ id: 1 });
  notificationService.notifyMany.mockResolvedValue([]);
  emailSender.sendEmail.mockResolvedValue({ sent: true });
  whatsappWebClient.sendBestEffort.mockResolvedValue({ sent: true, stub: false });
  whatsappWebClient.isConnected.mockReturnValue(true);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.user.findFirst.mockResolvedValue(null);
});

describe("notifyDiagnosticSubmitted — zero-config fallback", () => {
  test("falls back to ADMIN/MANAGER via notifyMany(db) when no recipients configured", async () => {
    settingsLib.getNotificationRecipients.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([{ id: 10 }, { id: 11 }]);

    await diagnosticNotifications.notifyDiagnosticSubmitted({
      tenantId: 1, subBrand: "tmc", diagnosticId: 500, contactLabel: "Hampi School",
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, role: { in: ["ADMIN", "MANAGER"] } },
      select: { id: true },
    });
    expect(notificationService.notifyMany).toHaveBeenCalledTimes(1);
    const call = notificationService.notifyMany.mock.calls[0][0];
    expect(call.userIds).toEqual([10, 11]);
    expect(call.channels).toEqual(["db", "socket"]);
    expect(call.title).toMatch(/New TMC diagnostic submission/i);
    expect(call.message).toMatch(/Hampi School submitted a diagnostic/i);
    // Fallback never touches email/WhatsApp.
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
    expect(whatsappWebClient.sendBestEffort).not.toHaveBeenCalled();
  });

  test("does nothing (no crash) when there are no ADMIN/MANAGER users either", async () => {
    settingsLib.getNotificationRecipients.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
    await expect(
      diagnosticNotifications.notifyDiagnosticSubmitted({ tenantId: 1, subBrand: "tmc", diagnosticId: 500 }),
    ).resolves.toBeUndefined();
    expect(notificationService.notifyMany).not.toHaveBeenCalled();
  });
});

describe("notifyDiagnosticSubmitted — configured recipients", () => {
  test("fans out db + email + whatsapp per recipient's own channel selection", async () => {
    settingsLib.getNotificationRecipients.mockResolvedValue([
      { userId: 1, channels: ["db", "email"] },
      { userId: 2, channels: ["whatsapp"] },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 1, email: "priya@example.com", phone: null },
      { id: 2, email: null, phone: "+919999999999" },
    ]);

    await diagnosticNotifications.notifyDiagnosticSubmitted({
      tenantId: 1, subBrand: "tmc", diagnosticId: 500, contactLabel: "Hampi School",
      score: 8, classificationLabel: "Power User",
    });

    // User 1: db via notify(), email via emailSender directly.
    expect(notificationService.notify).toHaveBeenCalledWith(expect.objectContaining({
      userId: 1, tenantId: 1, channels: ["db", "socket"],
      entityType: "TravelDiagnostic", entityId: 500,
    }));
    expect(emailSender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "priya@example.com" }));

    // User 2: whatsapp only — no db notify(), no email.
    expect(notificationService.notify).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 2 }));
    expect(whatsappWebClient.sendBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 1, subBrand: "tmc", toPhone: "+919999999999",
    }));

    // notifyMany (the fallback path) must NOT fire when recipients ARE configured.
    expect(notificationService.notifyMany).not.toHaveBeenCalled();
  });

  test("skips email for a recipient with no email on file, even if selected", async () => {
    settingsLib.getNotificationRecipients.mockResolvedValue([{ userId: 1, channels: ["email"] }]);
    prisma.user.findMany.mockResolvedValue([{ id: 1, email: null, phone: null }]);
    await diagnosticNotifications.notifyDiagnosticSubmitted({ tenantId: 1, subBrand: "tmc", diagnosticId: 1 });
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
  });

  test("skips whatsapp for a recipient with no phone on file, even if selected", async () => {
    settingsLib.getNotificationRecipients.mockResolvedValue([{ userId: 1, channels: ["whatsapp"] }]);
    prisma.user.findMany.mockResolvedValue([{ id: 1, email: null, phone: null }]);
    await diagnosticNotifications.notifyDiagnosticSubmitted({ tenantId: 1, subBrand: "tmc", diagnosticId: 1 });
    expect(whatsappWebClient.sendBestEffort).not.toHaveBeenCalled();
  });

  test("skips a configured userId that no longer exists in this tenant (stale config)", async () => {
    settingsLib.getNotificationRecipients.mockResolvedValue([{ userId: 999, channels: ["db"] }]);
    prisma.user.findMany.mockResolvedValue([]); // the where-clause filters it out
    await diagnosticNotifications.notifyDiagnosticSubmitted({ tenantId: 1, subBrand: "tmc", diagnosticId: 1 });
    expect(notificationService.notify).not.toHaveBeenCalled();
  });

  test("one recipient failing does not block another", async () => {
    settingsLib.getNotificationRecipients.mockResolvedValue([
      { userId: 1, channels: ["db"] },
      { userId: 2, channels: ["db"] },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 1, email: null, phone: null }, { id: 2, email: null, phone: null }]);
    notificationService.notify.mockImplementationOnce(() => { throw new Error("boom"); });

    await diagnosticNotifications.notifyDiagnosticSubmitted({ tenantId: 1, subBrand: "tmc", diagnosticId: 1 });

    expect(notificationService.notify).toHaveBeenCalledTimes(2);
  });

  test("never throws even when the settings lookup itself blows up", async () => {
    settingsLib.getNotificationRecipients.mockRejectedValue(new Error("tenantSetting exploded"));
    await expect(
      diagnosticNotifications.notifyDiagnosticSubmitted({ tenantId: 1, subBrand: "tmc", diagnosticId: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe("sendTestNotification", () => {
  test("throws USER_NOT_FOUND for a userId outside the tenant", async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(
      diagnosticNotifications.sendTestNotification({ tenantId: 1, subBrand: "tmc", userId: 999 }),
    ).rejects.toMatchObject({ status: 404, code: "USER_NOT_FOUND" });
  });

  test("reports 'sent' for every channel when everything is configured + connected", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 1, email: "a@b.com", phone: "+919999999999" });
    process.env.SENDGRID_API_KEY = "test-key";
    whatsappWebClient.isConnected.mockReturnValue(true);

    const result = await diagnosticNotifications.sendTestNotification({ tenantId: 1, subBrand: "tmc", userId: 1 });

    expect(result.db).toBe("sent");
    expect(result.email).toBe("sent");
    expect(result.whatsapp).toBe("sent");
    delete process.env.SENDGRID_API_KEY;
  });

  test("reports 'unavailable' for email/whatsapp when not configured/connected", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 1, email: "a@b.com", phone: "+919999999999" });
    delete process.env.SENDGRID_API_KEY;
    whatsappWebClient.isConnected.mockReturnValue(false);

    const result = await diagnosticNotifications.sendTestNotification({ tenantId: 1, subBrand: "tmc", userId: 1 });

    expect(result.email).toBe("unavailable");
    expect(result.whatsapp).toBe("unavailable");
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
    expect(whatsappWebClient.sendBestEffort).not.toHaveBeenCalled();
  });

  test("reports 'no_email_on_file' / 'no_phone_on_file' when the caller is missing that field", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 1, email: null, phone: null });
    process.env.SENDGRID_API_KEY = "test-key";
    whatsappWebClient.isConnected.mockReturnValue(true);

    const result = await diagnosticNotifications.sendTestNotification({ tenantId: 1, subBrand: "tmc", userId: 1 });

    expect(result.email).toBe("no_email_on_file");
    expect(result.whatsapp).toBe("no_phone_on_file");
    delete process.env.SENDGRID_API_KEY;
  });
});
