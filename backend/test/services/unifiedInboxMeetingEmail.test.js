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
  it("CCs configured team members and excludes the customer address", async () => {
    mocks.sendEmail.mockResolvedValue({ sent: true });
    mocks.prisma.tenant.findUnique.mockResolvedValue({ emailRetention: true });
    mocks.prisma.emailMessage.create.mockResolvedValue({ id: 80 });

    await service.sendMeetingConfirmation({
      form: {
        hostUserId: 5,
        durationMins: 30,
        emailSubject: "Confirmed",
        emailBody: "Join {{meeting_url}}",
        emailCcJson: JSON.stringify(["TEAM1@TMC.TEST", "asha@example.edu", "team2@tmc.test"]),
      },
      booking: { id: 8, tenantId: 2, contactName: "Asha", contactEmail: "asha@example.edu", scheduledAt: new Date("2026-10-15T04:30:00Z"), timezone: "Asia/Kolkata", meetingUrl: "https://zoom.us/j/1" },
    });

    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "asha@example.edu",
      cc: ["team1@tmc.test", "team2@tmc.test"],
    }));
    expect(mocks.prisma.emailMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ cc: "team1@tmc.test,team2@tmc.test" }) });
  });

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

  it("uses the actual external booking duration in a CRM confirmation", () => {
    const rendered = service.renderMeetingTemplate({
      form: { durationMins: 30, emailSubject: "Confirmed", emailBody: "Your {{duration}} minute conversation is confirmed." },
      booking: { contactName: "Asha", scheduledAt: new Date("2026-10-15T04:30:00Z"), endsAt: new Date("2026-10-15T05:15:00Z"), timezone: "Asia/Kolkata", meetingUrl: null },
    });
    expect(rendered.text).toContain("45 minute conversation");
  });

  it("appends the configured form logo after the confirmation content", () => {
    const html = service.buildMeetingHtml({
      form: { name: "The Modern Classroom", emailLogoUrl: "/api/uploads/travel-meeting-email-logos/tenant-2/form-7/logo.png" },
      text: "Hello Asha\nhttps://zoom.us/j/1",
      meetingUrl: "https://zoom.us/j/1",
    });
    expect(html).toContain('<a href="https://zoom.us/j/1" style="color:#2563eb;text-decoration:underline">https://zoom.us/j/1</a>');
    expect(html).toContain('alt="The Modern Classroom logo"');
    expect(html).toContain("/api/uploads/travel-meeting-email-logos/tenant-2/form-7/logo.png");
    expect(html).toContain('style="margin:0 0 14px"');
    expect(html.indexOf("Hello Asha")).toBeLessThan(html.indexOf("<img"));
  });

  it("renders meeting links as URLs and meeting buttons as redirecting CTAs", () => {
    const rendered = service.renderMeetingTemplate({
      form: { durationMins: 30, emailSubject: "Confirmed", emailBody: "Link: {{meeting_url}}\n\n{{meeting_button}}" },
      booking: { contactName: "Asha", institution: "Chennai Public School", scheduledAt: new Date("2026-10-15T04:30:00Z"), timezone: "Asia/Kolkata", meetingUrl: "https://zoom.us/j/1?pwd=abc" },
    });
    const html = service.buildMeetingHtml({ form: {}, text: rendered.text, meetingUrl: rendered.values.meeting_url });

    expect(html).toContain('>https://zoom.us/j/1?pwd=abc</a>');
    expect(html).toContain('>Join Meeting</a>');
    expect(html.match(/href="https:\/\/zoom\.us\/j\/1\?pwd=abc"/g)).toHaveLength(2);
    expect(rendered.plainText).toContain("Join Meeting: https://zoom.us/j/1?pwd=abc");
    expect(rendered.plainText).not.toContain("TMC_MEETING_BUTTON");
    expect(rendered.values.institution).toBe("Chennai Public School");
  });

  it("ignores Vite's path-only BASE_URL when resolving stored logo paths", () => {
    const previous = {
      BASE_URL: process.env.BASE_URL,
      FRONTEND_URL: process.env.FRONTEND_URL,
      PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
    };
    process.env.BASE_URL = "/";
    delete process.env.FRONTEND_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      expect(service.publicAssetUrl("/api/uploads/logo.png")).toBe("https://crm.globusdemos.com/api/uploads/logo.png");
    } finally {
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  it("sends through the shared email pipeline and saves the outbound conversation", async () => {
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
    mocks.sendEmail.mockResolvedValue({ sent: true });
    mocks.prisma.tenant.findUnique.mockResolvedValue({ emailRetention: false });
    await service.sendMeetingConfirmation({
      form: { hostUserId: 5, durationMins: 30, emailSubject: "Confirmed", emailBody: "Details" },
      booking: { id: 10, tenantId: 2, contactName: "Asha", contactEmail: "asha@example.edu", scheduledAt: new Date("2026-10-15T04:30:00Z"), timezone: "Asia/Kolkata", meetingUrl: "https://zoom.us/j/1" },
    });
    expect(mocks.prisma.emailMessage.create).not.toHaveBeenCalled();
  });

  it("records the customer-managed SendGrid sender selected by the shared pipeline", async () => {
    mocks.sendEmail.mockResolvedValue({ sent: true, from: "bookings@tmc.test", source: "tenant" });
    mocks.prisma.tenant.findUnique.mockResolvedValue({ emailRetention: true });
    mocks.prisma.emailMessage.create.mockResolvedValue({ id: 82 });

    const result = await service.sendMeetingConfirmation({
      form: { hostUserId: 5, durationMins: 30, emailSubject: "Confirmed", emailBody: "Join {{meeting_url}}" },
      booking: { id: 11, tenantId: 2, contactId: 7, contactName: "Asha", contactEmail: "asha@example.edu", scheduledAt: new Date("2026-10-15T04:30:00Z"), timezone: "Asia/Kolkata", meetingUrl: "https://zoom.us/j/1" },
    });

    expect(result).toEqual({ sent: true, reason: null, emailMessageId: 82 });
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 2, to: "asha@example.edu" }));
    expect(mocks.prisma.emailMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ from: "bookings@tmc.test", threadId: "travel-meeting-11" }) });
  });

  it("records the CRM-managed SendGrid sender when the tenant has no BYOK configuration", async () => {
    mocks.sendEmail.mockResolvedValue({ sent: true, from: "noreply@crm.globusdemos.com", source: "backend" });
    mocks.prisma.tenant.findUnique.mockResolvedValue({ emailRetention: true });
    mocks.prisma.emailMessage.create.mockResolvedValue({ id: 84 });

    const result = await service.sendMeetingConfirmation({
      form: { hostUserId: 5, durationMins: 30, emailSubject: "Confirmed", emailBody: "Join {{meeting_url}}" },
      booking: { id: 13, tenantId: 2, contactId: 7, contactName: "Asha", contactEmail: "asha@example.edu", scheduledAt: new Date("2026-10-15T04:30:00Z"), timezone: "Asia/Kolkata", meetingUrl: "https://zoom.us/j/1" },
    });

    expect(result).toEqual({ sent: true, reason: null, emailMessageId: 84 });
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 2, to: "asha@example.edu" }));
    expect(mocks.prisma.emailMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ from: "noreply@crm.globusdemos.com" }) });
  });
});
