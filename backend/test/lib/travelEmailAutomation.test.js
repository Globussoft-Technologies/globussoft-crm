/**
 * Covers travelEmailAutomation context rendering and event dispatch, including
 * paymentId-to-registration metadata fallback so first-payment receipts reach
 * a landing-page payer before a Contact is linked. Prisma and email delivery
 * are mocked; the payment lookup reproduces the hosted-checkout payload shape.
 */
import { describe, expect, test, vi } from "vitest";
import { createRequire } from "node:module";
const requireCJS = createRequire(import.meta.url);

vi.mock("../../lib/emailSender", () => ({ sendEmail: vi.fn().mockResolvedValue({ sent: true }) }));

vi.mock("../../lib/prisma", () => ({
  tenant: { findUnique: vi.fn() },
  tenantSetting: { findUnique: vi.fn() },
  contact: { findFirst: vi.fn() },
  payment: { findFirst: vi.fn() },
  travelEmailTemplate: { findMany: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
  travelEmailSequence: { findMany: vi.fn() },
  travelEmailEnrollment: { create: vi.fn(), findMany: vi.fn() },
  travelEmailDeliveryLog: { create: vi.fn() },
}));
const prisma = requireCJS("../../lib/prisma");
const automation = requireCJS("../../lib/travelEmailAutomation");
const emailSender = requireCJS("../../lib/emailSender");

beforeEach(() => {
  prisma.tenant.findUnique = vi.fn();
  prisma.contact.findFirst = vi.fn();
  prisma.payment.findFirst = vi.fn();
  prisma.travelEmailTemplate.findMany = vi.fn();
  prisma.travelEmailTemplate.createMany = vi.fn();
  prisma.travelEmailTemplate.updateMany = vi.fn();
  prisma.travelEmailSequence.findMany = vi.fn();
  prisma.travelEmailEnrollment.create = vi.fn();
  prisma.travelEmailEnrollment.findMany = vi.fn().mockResolvedValue([]);
  prisma.travelEmailDeliveryLog.create = vi.fn();
  emailSender.sendEmail.mockReset().mockResolvedValue({ sent: true });
});

describe("Travel email automation", () => {
  test("catalogues exactly the requested default and optional events", () => {
    expect(automation.ESSENTIAL_EVENTS).toHaveLength(9);
    expect(automation.OPTIONAL_EVENTS.map(([key]) => key)).toEqual([
      "registration.started",
      "trip.completed",
      "payment.failed",
    ]);
    for (const [, , subject, body] of automation.OPTIONAL_EVENTS) {
      expect(subject).toBeTruthy();
      expect(body).toContain("{{recipient.name}}");
    }
    expect(automation.OPTIONAL_EVENTS.find(([key]) => key === "registration.started")[3]).toContain(">Continue your registration: {{account.setupLink}}</a>");
    expect(automation.OPTIONAL_EVENTS.find(([key]) => key === "trip.completed")[3]).toContain(">Share your review: {{review.url}}</a>");
    expect(automation.ESSENTIAL_EVENTS.map(([key]) => key)).toContain("account.created");
    expect(automation.ESSENTIAL_EVENTS.map(([key]) => key)).toContain("lead.created.welcome");
    expect(automation.ESSENTIAL_EVENTS.map(([key]) => key)).toContain("payment.due_reminder");
    expect(automation.OPTIONAL_EVENTS.map(([key]) => key)).not.toContain("payment.reminder");
    expect(automation.ESSENTIAL_EVENTS.map(([key]) => key)).not.toEqual(expect.arrayContaining([
      "site_visit.scheduled", "trip.confirmed", "booking.confirmed", "trip.reminder",
    ]));
    const paymentReceived = automation.ESSENTIAL_EVENTS.find(([key]) => key === "payment.received");
    expect(paymentReceived[3]).toContain("{{payment.installment}}");
    expect(paymentReceived[3]).toContain("{{payment.method}}");
    expect(paymentReceived[3]).toContain("{{payment.reference}}");
  });

  test("provisions supported optional messages as inactive defaults", async () => {
    prisma.travelEmailTemplate.findMany.mockResolvedValueOnce([]);
    prisma.travelEmailTemplate.updateMany.mockResolvedValue({ count: 0 });
    prisma.travelEmailTemplate.createMany.mockResolvedValueOnce({ count: 12 });

    await automation.ensureDefaultTemplates(7);

    const rows = prisma.travelEmailTemplate.createMany.mock.calls[0][0].data;
    const optionalRows = rows.filter((row) => ["registration.started", "trip.completed", "payment.failed"].includes(row.eventKey));
    expect(optionalRows).toHaveLength(3);
    expect(optionalRows.every((row) => row.isDefault === true && row.isActive === false)).toBe(true);
    expect(optionalRows.every((row) => row.subject && row.body)).toBe(true);
  });

  test("renders secure link placeholders without exposing password fields", () => {
    const rendered = automation.renderText("Hi {{recipient.name}} {{account.signInLink}}", { recipient: { name: "Asha" }, account: { signInLink: "/travel/sign-in" } });
    expect(rendered).toBe("Hi Asha /travel/sign-in");
    expect(rendered).not.toMatch(/password/i);
  });

  test("includes the account deletion reason in the event context", async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ name: "Travel Co", ownerEmail: "hello@travel.co" });
    prisma.contact.findFirst.mockResolvedValueOnce(null);

    const context = await automation.buildContext(7, {
      recipientEmail: "parent@example.com",
      recipientName: "Asha Rao",
      deletionReason: "No longer travelling",
    });

    expect(context.account.deletionReason).toBe("No longer travelling");
  });

  test("normalizes flat event fields into the merge-field context", async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ name: "Travel Co", ownerEmail: "hello@travel.co" });
    prisma.contact.findFirst.mockResolvedValueOnce(null);

    const context = await automation.buildContext(7, {
      recipientEmail: "parent@example.com",
      parentName: "Asha Rao",
      senderName: "Travel Desk",
      tripCode: "TMC-42",
      tripDestination: "Paris",
      tripStartDate: "2026-12-01",
      tripEndDate: "2026-12-08",
      amount: 25000,
      paymentLink: "https://pay.example.test/42",
      studentName: "Riya Rao",
      studentSchool: "Modern School",
      bookingTripCode: "BOOK-42",
      cancellationReason: "Customer requested cancellation",
      refundId: "rfnd_42",
      refundAmount: "INR 5,000",
      refundMethod: "razorpay",
    });

    expect(automation.renderText(
      "{{recipient.name}}|{{sender.email}}|{{trip.code}}|{{trip.tripCode}}|{{trip.destination}}|{{trip.cancellationReason}}|{{payment.amount}}|{{payment.link}}|{{student.name}}|{{student.school}}|{{booking.tripCode}}|{{refund.amount}}|{{refund.reference}}|{{refund.method}}",
      context,
    )).toBe("Asha Rao|hello@travel.co|TMC-42|TMC-42|Paris|Customer requested cancellation|25000|https://pay.example.test/42|Riya Rao|Modern School|BOOK-42|INR 5,000|rfnd_42|razorpay");
  });

  test("does not read or enroll non-Travel tenants", async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ vertical: "generic" });
    await expect(automation.processTravelEmailEvent("account.ready", { recipientEmail: "a@example.com" }, 7)).resolves.toEqual({ ignored: true, reason: "not_travel" });
    expect(prisma.travelEmailTemplate.findMany).not.toHaveBeenCalled();
  });

  test("does not dispatch removed template events", async () => {
    await expect(automation.processTravelEmailEvent("booking.confirmed", { recipientEmail: "a@example.com" }, 7)).resolves.toEqual({
      ignored: true,
      reason: "event_removed",
    });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  test("does not dispatch unsupported optional events from legacy templates", async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ vertical: "travel" });

    await expect(automation.processTravelEmailEvent("lead.assigned", { recipientEmail: "a@example.com" }, 7)).resolves.toEqual({
      ignored: true,
      reason: "unsupported_event",
    });
    expect(prisma.travelEmailTemplate.findMany).not.toHaveBeenCalled();
  });

  test("sends the active event template directly without sequence enrollment", async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ vertical: "travel" }).mockResolvedValueOnce({ name: "Travel Co", slug: "travel", ownerEmail: "hello@travel.co" });
    prisma.travelEmailTemplate.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 10, eventKey: "payment.received", subject: "Payment received", body: "Hello {{recipient.name}}", subBrand: null }]);
    prisma.travelEmailTemplate.createMany.mockResolvedValueOnce({ count: 11 });
    prisma.contact.findFirst.mockResolvedValueOnce({ id: 4, name: "Asha Rao", email: "asha@example.com", subBrand: "tmc" });
    await expect(automation.processTravelEmailEvent("payment.received", { contactId: 4 }, 2)).resolves.toMatchObject({ templateId: 10, recipientEmail: "asha@example.com" });
    expect(prisma.travelEmailDeliveryLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ templateId: 10, eventKey: "payment.received", bodyHtml: "Hello Asha Rao" }) }));
    expect(prisma.travelEmailSequence.findMany).not.toHaveBeenCalled();
    expect(prisma.travelEmailEnrollment.create).not.toHaveBeenCalled();
    expect(prisma.tenant.findUnique).toHaveBeenNthCalledWith(2, {
      where: { id: 2 },
      select: { name: true, slug: true, ownerEmail: true },
    });
  });


  test("sends the first landing-page payment receipt to the payer from payment metadata", async () => {
    prisma.tenant.findUnique
      .mockResolvedValueOnce({ vertical: "travel" })
      .mockResolvedValueOnce({ name: "Travel Stall", ownerEmail: "support@travelstall.test" });
    prisma.payment.findFirst.mockResolvedValueOnce({
      contactId: null,
      metadata: JSON.stringify({
        kind: "landing-page-registration",
        parentEmail: "asha@example.com",
        registration: { parentName: "Asha Rao", parentEmail: "asha@example.com" },
      }),
    });
    prisma.travelEmailTemplate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 11,
        eventKey: "payment.received",
        subject: "Payment received",
        body: "Hello {{recipient.name}}, payment received: {{payment.amount}}",
        subBrand: null,
      }]);

    await expect(automation.processTravelEmailEvent(
      "payment.received",
      { paymentId: 51, amount: 5000 },
      2,
    )).resolves.toMatchObject({ templateId: 11, recipientEmail: "asha@example.com" });

    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
    expect(prisma.travelEmailDeliveryLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        recipientEmail: "asha@example.com",
        bodyHtml: "Hello Asha Rao, payment received: 5000",
      }),
    }));
  });

  test("uses the landing-page title for trip.name when a payment already has a Contact", async () => {
    prisma.tenant.findUnique
      .mockResolvedValueOnce({ vertical: "travel" })
      .mockResolvedValueOnce({ name: "Travel Stall", ownerEmail: "support@travelstall.test" });
    prisma.payment.findFirst.mockResolvedValueOnce({
      contactId: 4,
      metadata: JSON.stringify({ kind: "landing-page-registration", pageTitle: "Bali Family Tour" }),
    });
    prisma.contact.findFirst.mockResolvedValueOnce({
      id: 4, name: "Asha Rao", email: "asha@example.com", subBrand: "tmc",
    });
    prisma.travelEmailTemplate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 12,
        eventKey: "payment.received",
        subject: "Payment received for {{trip.name}}",
        body: "Payment received for {{trip.name}}",
        subBrand: null,
      }]);

    await expect(automation.processTravelEmailEvent(
      "payment.received",
      { paymentId: 52, contactId: 4, amount: 5000 },
      2,
    )).resolves.toMatchObject({ templateId: 12, recipientEmail: "asha@example.com" });

    expect(prisma.travelEmailDeliveryLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        subject: "Payment received for Bali Family Tour",
        bodyHtml: "Payment received for Bali Family Tour",
      }),
    }));
  });

});
