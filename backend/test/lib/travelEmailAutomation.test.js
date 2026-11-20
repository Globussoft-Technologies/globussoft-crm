import { describe, expect, test, vi } from "vitest";
import { createRequire } from "node:module";
const requireCJS = createRequire(import.meta.url);

vi.mock("../../lib/emailSender", () => ({ sendEmail: vi.fn().mockResolvedValue({ sent: true }) }));

vi.mock("../../lib/prisma", () => ({
  tenant: { findUnique: vi.fn() },
  tenantSetting: { findUnique: vi.fn() },
  contact: { findFirst: vi.fn() },
  travelEmailTemplate: { findMany: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
  travelEmailSequence: { findMany: vi.fn() },
  travelEmailEnrollment: { create: vi.fn(), findMany: vi.fn() },
  travelEmailDeliveryLog: { create: vi.fn() },
}));
const prisma = requireCJS("../../lib/prisma");
const automation = requireCJS("../../lib/travelEmailAutomation");

beforeEach(() => {
  prisma.tenant.findUnique = vi.fn();
  prisma.contact.findFirst = vi.fn();
  prisma.travelEmailTemplate.findMany = vi.fn();
  prisma.travelEmailTemplate.createMany = vi.fn();
  prisma.travelEmailTemplate.updateMany = vi.fn();
  prisma.travelEmailSequence.findMany = vi.fn();
  prisma.travelEmailEnrollment.create = vi.fn();
  prisma.travelEmailEnrollment.findMany = vi.fn().mockResolvedValue([]);
  prisma.travelEmailDeliveryLog.create = vi.fn();
});

describe("Travel email automation", () => {
  test("catalogues exactly the requested default and optional events", () => {
    expect(automation.ESSENTIAL_EVENTS).toHaveLength(13);
    expect(automation.OPTIONAL_EVENTS).toHaveLength(17);
    expect(automation.OPTIONAL_EVENTS.map(([key]) => key)).toContain("trip.completed");
    expect(automation.ESSENTIAL_EVENTS.map(([key]) => key)).toContain("account.created");
    expect(automation.ESSENTIAL_EVENTS.map(([key]) => key)).toContain("lead.created.welcome");
    expect(automation.OPTIONAL_EVENTS.map(([key]) => key)).toContain("payment.reminder");
    expect(automation.ESSENTIAL_EVENTS.map(([key]) => key)).toContain("booking.confirmed");
    const paymentReceived = automation.ESSENTIAL_EVENTS.find(([key]) => key === "payment.received");
    expect(paymentReceived[3]).toContain("{{payment.installment}}");
    expect(paymentReceived[3]).toContain("{{payment.method}}");
    expect(paymentReceived[3]).toContain("{{payment.reference}}");
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

});
