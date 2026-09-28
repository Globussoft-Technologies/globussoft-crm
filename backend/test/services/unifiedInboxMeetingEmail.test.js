import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const mocks = vi.hoisted(() => {
  const Module = require("node:module");
  const fromBackend = Module.createRequire(process.cwd() + "/");
  const prismaPath = fromBackend.resolve("./lib/prisma");
  const emailPath = fromBackend.resolve("./lib/emailSender");
  const prisma = {
    tenant: { findUnique: vi.fn() },
    emailMessage: { create: vi.fn() },
    gmailIntegration: { findUnique: vi.fn(), update: vi.fn() },
  };
  const sendEmail = vi.fn();
  Module._cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prisma, children: [], paths: [] };
  Module._cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: { sendEmail }, children: [], paths: [] };
  return { prisma, sendEmail };
});

const service = requireCJS("../../services/unifiedInboxMeetingEmail");

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("unifiedInboxMeetingEmail", () => {
  it("renders one configured template for calendar invitations and confirmation emails", () => {
    const rendered = service.renderMeetingTemplate({
      form: { durationMins: 45, emailSubject: "Confirmed for {{name}}", emailBody: "Hi {{name}}\n{{date}} at {{time}}\nJoin: {{meeting_url}}" },
      booking: { contactName: "Asha", scheduledAt: new Date("2026-10-15T04:30:00Z"), timezone: "Asia/Kolkata", meetingUrl: "https://zoom.us/j/1" },
    });
    expect(rendered.subject).toBe("Confirmed for Asha");
    expect(rendered.text).toContain("Hi Asha");
    expect(rendered.text).toContain("https://zoom.us/j/1");
    expect(rendered.text).not.toContain("{{");
  });

  it("appends the configured form logo after the confirmation content", () => {
    const html = service.buildMeetingHtml({
      form: { name: "The Modern Classroom", emailLogoUrl: "/api/uploads/travel-meeting-email-logos/tenant-2/form-7/logo.png" },
      text: "Hello Asha\nhttps://zoom.us/j/1",
      meetingUrl: "https://zoom.us/j/1",
    });
    expect(html).toContain("Join Zoom Meeting");
    expect(html).toContain('alt="The Modern Classroom logo"');
    expect(html).toContain("/api/uploads/travel-meeting-email-logos/tenant-2/form-7/logo.png");
    expect(html).toContain('style="margin:0 0 14px"');
    expect(html.indexOf("Hello Asha")).toBeLessThan(html.indexOf("<img"));
  });

  it("ignores Vite's path-only BASE_URL when resolving stored logo paths", () => {
    const previous = process.env.BASE_URL;
    process.env.BASE_URL = "/";
    try {
      expect(service.publicAssetUrl("/api/uploads/logo.png")).toBe("https://crm.globusdemos.com/api/uploads/logo.png");
    } finally {
      if (previous === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous;
    }
  });

  it("sends through the shared email pipeline and saves the outbound conversation", async () => {
    mocks.prisma.gmailIntegration.findUnique.mockResolvedValue(null);
    mocks.sendEmail.mockResolvedValue({ sent: true });
    mocks.prisma.tenant.findUnique.mockResolvedValue({ emailRetention: true });
    mocks.prisma.emailMessage.create.mockResolvedValue({ id: 81 });
    const result = await service.sendMeetingConfirmation({
      form: { hostUserId: 5, durationMins: 30, emailSubject: "Confirmed, {{name}}", emailBody: "Join: {{meeting_url}}" },
      booking: { id: 9, tenantId: 2, contactId: 7, contactName: "Asha", contactEmail: "asha@example.edu", scheduledAt: new Date("2026-10-15T04:30:00Z"), timezone: "Asia/Kolkata", meetingUrl: "https://zoom.us/j/1" },
    });
    expect(result).toEqual({ sent: true, reason: null, emailMessageId: 81 });
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "asha@example.edu", subject: "Confirmed, Asha" }));
    expect(mocks.prisma.emailMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: 2, contactId: 7, direction: "OUTBOUND", threadId: "travel-meeting-9" }) });
  });

  it("respects tenant Unified Inbox retention settings", async () => {
    mocks.prisma.gmailIntegration.findUnique.mockResolvedValue(null);
    mocks.sendEmail.mockResolvedValue({ sent: true });
    mocks.prisma.tenant.findUnique.mockResolvedValue({ emailRetention: false });
    await service.sendMeetingConfirmation({
      form: { hostUserId: 5, durationMins: 30, emailSubject: "Confirmed", emailBody: "Details" },
      booking: { id: 10, tenantId: 2, contactName: "Asha", contactEmail: "asha@example.edu", scheduledAt: new Date("2026-10-15T04:30:00Z"), timezone: "Asia/Kolkata", meetingUrl: "https://zoom.us/j/1" },
    });
    expect(mocks.prisma.emailMessage.create).not.toHaveBeenCalled();
  });

  it("uses the host mailbox connected to Unified Inbox before the SendGrid fallback", async () => {
    const { google } = requireCJS("googleapis");
    const setCredentials = vi.fn();
    const on = vi.fn();
    const gmailSend = vi.fn().mockResolvedValue({ data: { id: "gmail-1", threadId: "thread-1" } });
    vi.spyOn(google.auth, "OAuth2").mockImplementation(function MockOAuth2() {
      this.setCredentials = setCredentials;
      this.on = on;
    });
    vi.spyOn(google, "gmail").mockReturnValue({ users: { messages: { send: gmailSend } } });
    mocks.prisma.gmailIntegration.findUnique.mockResolvedValue({
      id: 12,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      emailAddress: "host@tmc.test",
    });
    mocks.prisma.tenant.findUnique.mockResolvedValue({ emailRetention: true });
    mocks.prisma.emailMessage.create.mockResolvedValue({ id: 82 });

    const result = await service.sendMeetingConfirmation({
      form: { hostUserId: 5, durationMins: 30, emailSubject: "Confirmed", emailBody: "Join {{meeting_url}}" },
      booking: { id: 11, tenantId: 2, contactId: 7, contactName: "Asha", contactEmail: "asha@example.edu", scheduledAt: new Date("2026-10-15T04:30:00Z"), timezone: "Asia/Kolkata", meetingUrl: "https://zoom.us/j/1" },
    });

    expect(result).toEqual({ sent: true, reason: null, emailMessageId: 82 });
    expect(gmailSend).toHaveBeenCalledOnce();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.prisma.emailMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ from: "host@tmc.test", threadId: "thread-1" }) });
  });

  it("falls back to SendGrid when the connected host mailbox rejects the send", async () => {
    const { google } = requireCJS("googleapis");
    vi.spyOn(google.auth, "OAuth2").mockImplementation(function MockOAuth2() {
      this.setCredentials = vi.fn();
      this.on = vi.fn();
    });
    vi.spyOn(google, "gmail").mockReturnValue({ users: { messages: { send: vi.fn().mockRejectedValue(Object.assign(new Error("expired"), { code: 401 })) } } });
    mocks.prisma.gmailIntegration.findUnique.mockResolvedValue({ id: 12, accessToken: "expired", emailAddress: "host@tmc.test" });
    mocks.sendEmail.mockResolvedValue({ sent: true, from: "confirmed@tmc.test" });
    mocks.prisma.tenant.findUnique.mockResolvedValue({ emailRetention: true });
    mocks.prisma.emailMessage.create.mockResolvedValue({ id: 83 });

    const result = await service.sendMeetingConfirmation({
      form: { hostUserId: 5, durationMins: 30, emailSubject: "Confirmed", emailBody: "Join {{meeting_url}}" },
      booking: { id: 12, tenantId: 2, contactId: 7, contactName: "Asha", contactEmail: "asha@example.edu", scheduledAt: new Date("2026-10-15T04:30:00Z"), timezone: "Asia/Kolkata", meetingUrl: "https://zoom.us/j/1" },
    });

    expect(result).toEqual({ sent: true, reason: null, emailMessageId: 83 });
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "asha@example.edu" }));
    expect(mocks.prisma.emailMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ from: "confirmed@tmc.test" }) });
  });
});
