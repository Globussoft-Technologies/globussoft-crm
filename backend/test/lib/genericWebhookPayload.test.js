import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import prisma from "../../lib/prisma.js";

const require = createRequire(import.meta.url);
const { hydrateGenericWebhookPayload } = require("../../lib/genericWebhookPayload");

describe("Generic CRM workflow webhook payload hydration", () => {
  beforeEach(() => {
    prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: "generic" });
    prisma.contact.findFirst = vi.fn().mockResolvedValue({
      id: 42,
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+919999999999",
      source: "Website",
      tagsJson: '["priority"]',
      callifiedCampaignId: 88,
      callifiedLeadStatus: "qualified",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    prisma.webFormSubmission.findFirst = vi.fn().mockResolvedValue({
      payloadJson: JSON.stringify({
        utm_id: "utm-7",
        _meta: { tracking: { utm_source: "google", browser: "Chrome", pageTitle: "Offer" } },
      }),
      sourceUrl: "https://example.com/offer",
      submittedAt: new Date("2026-01-01T00:00:00.000Z"),
      webForm: { id: 9, name: "Lead form" },
    });
    prisma.touchpoint.findFirst = vi.fn().mockResolvedValue({ medium: "cpc", utmCampaign: "winter" });
    prisma.leadCustomFieldDefinition.findMany = vi.fn().mockResolvedValue([
      { id: 5, fieldKey: "budget", fieldType: "number" },
      { id: 6, fieldKey: "products", fieldType: "multiselect" },
    ]);
    prisma.leadCustomFieldValue.findMany = vi.fn().mockResolvedValue([
      { fieldId: 5, valueNumber: 25000 },
      { fieldId: 6, valueText: '["CRM","Voice"]' },
    ]);
    prisma.callLog.findMany = vi.fn().mockResolvedValue([
      { notes: JSON.stringify({ review: { quality_score: 91 } }) },
    ]);
    prisma.customerPickup.findFirst = vi.fn().mockResolvedValue({ pickupAddress: "Central Station" });
    prisma.plotBooking.findFirst = vi.fn().mockResolvedValue({ plotSiteId: 12, status: "PLOT_RESERVED", paymentStatus: "PAID" });
  });

  it("hydrates built-in, tracking, derived, and tenant custom fields", async () => {
    const result = await hydrateGenericWebhookPayload({ contactId: 42, changedFields: ["status"] }, 7);

    expect(result).toMatchObject({
      contactId: 42,
      name: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      webForm: "Lead form",
      formName: "Lead form",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "winter",
      utm_id: "utm-7",
      browser: "Chrome",
      pickupLocation: "Central Station",
      plotAssign: 12,
      overallPickupStatus: "PLOT_RESERVED",
      callifiedAi: 1,
      callifiedScore: 91,
      budget: 25000,
      products: ["CRM", "Voice"],
      changedFields: ["status"],
    });
    expect(prisma.contact.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 42, tenantId: 7, deletedAt: null },
    }));
  });

  it("leaves non-generic tenant payloads unchanged", async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ vertical: "wellness" });
    const payload = { contactId: 42, name: "Original" };

    await expect(hydrateGenericWebhookPayload(payload, 7)).resolves.toBe(payload);
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  it("leaves events without a contact id unchanged", async () => {
    const payload = { dealId: 3 };
    await expect(hydrateGenericWebhookPayload(payload, 7)).resolves.toBe(payload);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});
