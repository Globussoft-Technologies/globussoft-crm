// Unit tests for cron/webCheckinEngine.js — the email layer over the existing
// WebCheckin rows. Scan active rows → paid+non-visasure parent gate → milestone
// gate → idempotent (emailRemindersJson) → email. Singletons grabbed via
// createRequire + monkeypatched (proven idiom). dueMilestone/milestoneTag real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS("../../lib/prisma");
const emailSender = requireCJS("../../lib/emailSender");
const content = requireCJS("../../lib/webCheckinContent");
const { runWebCheckinTick } = requireCJS("../../cron/webCheckinEngine");

const NOW = new Date("2026-06-20T09:00:00Z");
const plusHours = (h) => new Date(NOW.getTime() + h * 3600000);

beforeEach(() => {
  prisma.webCheckin = { findMany: vi.fn(), update: vi.fn() };
  prisma.itinerary = { findMany: vi.fn() };
  prisma.contact = { findMany: vi.fn() };
  prisma.travelPortalNotification = { create: vi.fn().mockResolvedValue({ id: 1 }) };
  emailSender.sendEmail = vi.fn();
  content.buildReminder = vi.fn(() => ({ subject: "WC", text: "T", html: "T" }));

  // Default: parent itinerary is PAID + travelstall; contact has an email.
  prisma.itinerary.findMany.mockResolvedValue([{ id: 50, status: "advance_paid", subBrand: "travelstall" }]);
  prisma.contact.findMany.mockResolvedValue([{ id: 7, name: "Mohit", email: "mohit@example.com" }]);
  prisma.webCheckin.update.mockResolvedValue({});
  emailSender.sendEmail.mockResolvedValue({ sent: true });
});

function wc(overrides = {}) {
  return {
    id: 1, tenantId: 1, itineraryId: 50, contactId: 7,
    pnr: "ABC123", airlineCode: "AI", flightNumber: "302", passengerName: "Mohit",
    departureAt: plusHours(24), emailRemindersJson: null, ...overrides,
  };
}

describe("webCheckinEngine — scope query", () => {
  it("scans only active rows with a parent itinerary in the 37h window", async () => {
    prisma.webCheckin.findMany.mockResolvedValue([]);
    await runWebCheckinTick(NOW);
    const where = prisma.webCheckin.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["pending", "reminded"] });
    expect(where.itineraryId).toEqual({ not: null });
    expect(where.departureAt).toHaveProperty("gte");
    expect(where.departureAt).toHaveProperty("lte");
  });
});

describe("webCheckinEngine — fire", () => {
  it("emails the passenger at T-24h and records the milestone", async () => {
    prisma.webCheckin.findMany.mockResolvedValue([wc({ departureAt: plusHours(24) })]);
    const s = await runWebCheckinTick(NOW);
    expect(content.buildReminder).toHaveBeenCalledWith(expect.objectContaining({ milestone: 24, airlineCode: "AI", pnr: "ABC123" }));
    expect(emailSender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "mohit@example.com", subject: "WC" }));
    const upd = prisma.webCheckin.update.mock.calls[0][0];
    expect(JSON.parse(upd.data.emailRemindersJson)).toContain("h24");
    // also mirrored to the customer's in-app portal bell (deep-linked to the trip)
    expect(prisma.travelPortalNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contactId: 7, tenantId: 1, type: "itinerary", link: "booking:50" }) }),
    );
    expect(s).toMatchObject({ fired: 1, sent: 1 });
  });

  it("appends to existing milestones already sent (h36 → adds h24)", async () => {
    prisma.webCheckin.findMany.mockResolvedValue([wc({ departureAt: plusHours(24), emailRemindersJson: JSON.stringify(["h36"]) })]);
    await runWebCheckinTick(NOW);
    const upd = prisma.webCheckin.update.mock.calls[0][0];
    expect(JSON.parse(upd.data.emailRemindersJson).sort()).toEqual(["h24", "h36"]);
  });
});

describe("webCheckinEngine — guards", () => {
  it("is idempotent — skips a milestone already emailed", async () => {
    prisma.webCheckin.findMany.mockResolvedValue([wc({ departureAt: plusHours(24), emailRemindersJson: JSON.stringify(["h24"]) })]);
    const s = await runWebCheckinTick(NOW);
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
    expect(s).toMatchObject({ fired: 0, skipped: 1 });
  });

  it("skips when the parent itinerary is NOT paid", async () => {
    prisma.webCheckin.findMany.mockResolvedValue([wc()]);
    prisma.itinerary.findMany.mockResolvedValue([{ id: 50, status: "accepted", subBrand: "travelstall" }]);
    const s = await runWebCheckinTick(NOW);
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
    expect(s).toMatchObject({ fired: 0, skipped: 1 });
  });

  it("skips when the parent itinerary is Visa Sure", async () => {
    prisma.webCheckin.findMany.mockResolvedValue([wc()]);
    prisma.itinerary.findMany.mockResolvedValue([{ id: 50, status: "fully_paid", subBrand: "visasure" }]);
    const s = await runWebCheckinTick(NOW);
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
    expect(s).toMatchObject({ fired: 0, skipped: 1 });
  });

  it("skips a row outside every milestone window (T-40h)", async () => {
    prisma.webCheckin.findMany.mockResolvedValue([wc({ departureAt: plusHours(40) })]);
    const s = await runWebCheckinTick(NOW);
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
    expect(s).toMatchObject({ fired: 0, skipped: 1 });
  });

  it("skips when the contact has no email", async () => {
    prisma.webCheckin.findMany.mockResolvedValue([wc()]);
    prisma.contact.findMany.mockResolvedValue([{ id: 7, name: "Mohit", email: null }]);
    const s = await runWebCheckinTick(NOW);
    expect(s).toMatchObject({ fired: 0, skipped: 1 });
  });

  it("still records the milestone (no retry loop) when SendGrid is unconfigured", async () => {
    prisma.webCheckin.findMany.mockResolvedValue([wc({ departureAt: plusHours(12) })]);
    emailSender.sendEmail.mockResolvedValue({ sent: false, reason: "no_api_key" });
    const s = await runWebCheckinTick(NOW);
    const upd = prisma.webCheckin.update.mock.calls[0][0];
    expect(JSON.parse(upd.data.emailRemindersJson)).toContain("h12");
    expect(s).toMatchObject({ fired: 1, sent: 0 });
  });
});
