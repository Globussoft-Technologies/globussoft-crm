// Unit tests for cron/paymentDeadlineEngine.js — scan accepted-unpaid →
// reminder (T-10..T-7) / overdue-flag (T-6) → idempotent claim → email + advisor
// notify. Singletons grabbed via createRequire + monkeypatched (proven idiom;
// vi.mock can't reach the SUT's CJS require chain). shouldRemind/dayTag stay
// REAL so the day-gate is exercised end-to-end.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const prisma = requireCJS("../../lib/prisma");
const emailSender = requireCJS("../../lib/emailSender");
const content = requireCJS("../../lib/paymentDeadlineContent");
const notificationService = requireCJS("../../lib/notificationService");
const { runPaymentDeadlineTick, userCanAccess } = requireCJS("../../cron/paymentDeadlineEngine");

const NOW = new Date("2026-06-20T09:00:00Z");
const plusDays = (n) => new Date(Date.UTC(2026, 5, 20 + n, 9, 0, 0));

beforeEach(() => {
  prisma.itinerary = { findMany: vi.fn(), update: vi.fn() };
  prisma.contact = { findMany: vi.fn() };
  prisma.user = { findMany: vi.fn() };
  prisma.paymentDeadlineNudge = { create: vi.fn(), update: vi.fn() };
  emailSender.sendEmail = vi.fn();
  notificationService.notify = vi.fn();
  content.buildReminder = vi.fn(async () => ({ subject: "R", text: "T", html: "T", llmSourced: false }));
  content.buildOverdueNotice = vi.fn(() => ({ subject: "O", text: "T", html: "T", llmSourced: false }));
  content.buildOverdueAdvisorFlag = vi.fn(() => ({ title: "Deposit overdue — review for cancellation", message: "msg #1 expired" }));

  prisma.contact.findMany.mockResolvedValue([{ id: 7, name: "Mohit", email: "mohit@example.com" }]);
  prisma.user.findMany.mockResolvedValue([{ id: 10, role: "USER", subBrandAccess: null }]);
  prisma.paymentDeadlineNudge.create.mockResolvedValue({ id: 100 });
  prisma.paymentDeadlineNudge.update.mockResolvedValue({});
  prisma.itinerary.update.mockResolvedValue({});
  emailSender.sendEmail.mockResolvedValue({ sent: true });
  notificationService.notify.mockResolvedValue({});
});

function itin(overrides = {}) {
  return {
    id: 1, tenantId: 1, subBrand: "travelstall", contactId: 7, destination: "Goa",
    startDate: plusDays(9), totalAmount: 100000, advancePaidAmount: null, currency: "INR", paymentOverdueAt: null,
    ...overrides,
  };
}

describe("paymentDeadlineEngine.runPaymentDeadlineTick — scope", () => {
  it("scans only accepted, non-visasure itineraries in the window", async () => {
    prisma.itinerary.findMany.mockResolvedValue([]);
    await runPaymentDeadlineTick(NOW);
    const where = prisma.itinerary.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("accepted");
    expect(where.subBrand).toEqual({ not: "visasure" });
    expect(where.startDate).toHaveProperty("gte");
    expect(where.startDate).toHaveProperty("lte");
  });
});

describe("paymentDeadlineEngine.runPaymentDeadlineTick — reminders", () => {
  it("fires a deposit reminder on a run-up day (T-9) and emails the customer", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin({ startDate: plusDays(9) })]);
    const s = await runPaymentDeadlineTick(NOW);
    expect(prisma.paymentDeadlineNudge.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ itineraryId: 1, dayTag: "d9", channel: "email" }) }),
    );
    expect(content.buildReminder).toHaveBeenCalledWith(expect.objectContaining({ daysToGo: 9, depositAmount: 50000, destination: "Goa" }));
    expect(emailSender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "mohit@example.com", subject: "R" }));
    expect(notificationService.notify).not.toHaveBeenCalled(); // no advisor flag during run-up
    expect(s).toMatchObject({ remindersSent: 1, flagged: 0, sent: 1 });
  });

  it("records 'logged' (not 'sent') when SendGrid is unconfigured", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin({ startDate: plusDays(8) })]);
    emailSender.sendEmail.mockResolvedValue({ sent: false, reason: "no_api_key" });
    const s = await runPaymentDeadlineTick(NOW);
    expect(prisma.paymentDeadlineNudge.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "logged" }) }));
    expect(s).toMatchObject({ remindersSent: 1, sent: 0 });
  });

  it("skips a day before the window (T-12) — no claim", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin({ startDate: plusDays(12) })]);
    const s = await runPaymentDeadlineTick(NOW);
    expect(prisma.paymentDeadlineNudge.create).not.toHaveBeenCalled();
    expect(s).toMatchObject({ remindersSent: 0, flagged: 0, skipped: 1 });
  });

  it("is idempotent — a unique-violation on the claim skips without emailing", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin({ startDate: plusDays(9) })]);
    prisma.paymentDeadlineNudge.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const s = await runPaymentDeadlineTick(NOW);
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
    expect(s).toMatchObject({ skipped: 1 });
  });
});

describe("paymentDeadlineEngine.runPaymentDeadlineTick — overdue (T-6)", () => {
  it("flags the advisor + warns the customer + stamps paymentOverdueAt, without changing status", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin({ startDate: plusDays(6) })]);
    const s = await runPaymentDeadlineTick(NOW);

    // claimed the 'overdue' bucket
    expect(prisma.paymentDeadlineNudge.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ dayTag: "overdue" }) }),
    );
    // customer at-risk email
    expect(content.buildOverdueNotice).toHaveBeenCalled();
    expect(emailSender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: "O" }));
    // at-risk stamp (NOT a status change)
    const upd = prisma.itinerary.update.mock.calls[0][0];
    expect(upd.data).toHaveProperty("paymentOverdueAt");
    expect(upd.data).not.toHaveProperty("status");
    // advisor notification raised
    expect(notificationService.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 10, entityType: "Itinerary", entityId: 1, type: "warning" }),
    );
    expect(s).toMatchObject({ flagged: 1 });
  });

  it("does not re-stamp paymentOverdueAt if already flagged", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin({ startDate: plusDays(5), paymentOverdueAt: plusDays(-1) })]);
    await runPaymentDeadlineTick(NOW);
    expect(prisma.itinerary.update).not.toHaveBeenCalled();
  });
});

describe("paymentDeadlineEngine.runPaymentDeadlineTick — guards", () => {
  it("skips an itinerary with no amount due", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin({ totalAmount: 0 })]);
    const s = await runPaymentDeadlineTick(NOW);
    expect(prisma.paymentDeadlineNudge.create).not.toHaveBeenCalled();
    expect(s).toMatchObject({ skipped: 1 });
  });

  it("skips when an advance already covers the 50% deposit", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin({ advancePaidAmount: 60000 })]); // ≥ 50% of 100k
    const s = await runPaymentDeadlineTick(NOW);
    expect(prisma.paymentDeadlineNudge.create).not.toHaveBeenCalled();
    expect(s).toMatchObject({ skipped: 1 });
  });

  it("skips an itinerary whose contact has no email", async () => {
    prisma.itinerary.findMany.mockResolvedValue([itin({ startDate: plusDays(9) })]);
    prisma.contact.findMany.mockResolvedValue([{ id: 7, name: "Mohit", email: null }]);
    const s = await runPaymentDeadlineTick(NOW);
    expect(prisma.paymentDeadlineNudge.create).not.toHaveBeenCalled();
    expect(s).toMatchObject({ skipped: 1 });
  });
});

describe("paymentDeadlineEngine.userCanAccess", () => {
  it("honours ADMIN, unset access (= all), explicit allow, and deny-all", () => {
    expect(userCanAccess({ role: "ADMIN", subBrandAccess: null }, "travelstall")).toBe(true);
    expect(userCanAccess({ role: "USER", subBrandAccess: null }, "travelstall")).toBe(true);
    expect(userCanAccess({ role: "USER", subBrandAccess: '["travelstall","rfu"]' }, "travelstall")).toBe(true);
    expect(userCanAccess({ role: "USER", subBrandAccess: '["rfu"]' }, "travelstall")).toBe(false);
    expect(userCanAccess({ role: "USER", subBrandAccess: "[]" }, "travelstall")).toBe(false);
  });
});
