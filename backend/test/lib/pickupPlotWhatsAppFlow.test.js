import { beforeEach, describe, expect, test, vi } from "vitest";
import prisma from "../../lib/prisma.js";

for (const modelName of [
  "tenant", "whatsAppConfig", "contact", "plotSite", "pickupLocation",
  "whatsAppMessage", "whatsAppThread", "plotBooking", "customerPickup",
]) {
  if (!prisma[modelName]) prisma[modelName] = {};
}

prisma.tenant.findUnique = vi.fn();
prisma.whatsAppConfig.findFirst = vi.fn();
prisma.contact.findFirst = vi.fn();
prisma.plotSite.findMany = vi.fn();
prisma.plotSite.findFirst = vi.fn();
prisma.pickupLocation.findMany = vi.fn();
prisma.pickupLocation.findFirst = vi.fn();
prisma.whatsAppMessage.findFirst = vi.fn();
prisma.whatsAppMessage.create = vi.fn();
prisma.whatsAppThread.update = vi.fn();
prisma.$transaction = vi.fn();

const provider = require("../../services/whatsappProvider");
vi.spyOn(provider, "sendInteractive").mockResolvedValue({ success: true, providerMsgId: "wamid-list" });
vi.spyOn(provider, "sendText").mockResolvedValue({ success: true, providerMsgId: "wamid-text" });

const flow = require("../../lib/pickupPlotWhatsAppFlow");

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ vertical: "generic" });
  prisma.whatsAppConfig.findFirst.mockResolvedValue({ phoneNumberId: "phone-1", accessToken: "plain:test-token" });
  prisma.contact.findFirst.mockResolvedValue({ id: 21, name: "Priya" });
  prisma.whatsAppMessage.findFirst.mockResolvedValue(null);
  prisma.whatsAppMessage.create.mockResolvedValue({ id: 90 });
  prisma.whatsAppThread.update.mockResolvedValue({ id: 51 });
  provider.sendInteractive.mockResolvedValue({ success: true, providerMsgId: "wamid-list" });
  provider.sendText.mockResolvedValue({ success: true, providerMsgId: "wamid-text" });
});

describe("Generic pickup/plot WhatsApp flow", () => {
  test("a reply to a marked sequence message sends a native list of available plots", async () => {
    prisma.whatsAppMessage.findFirst.mockResolvedValue({
      templateName: "my_plot_selection_template",
      metaType: null,
      interactiveJson: JSON.stringify({
        sequenceKey: "sequence:44:step:8:main",
        sequenceEnrollmentId: 44,
        sequenceId: 9,
        pickupPlotFlow: true,
      }),
    });
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 30, name: "Green Acres", plotNumber: "A-30", block: "A", address: "Airport Road" },
    ]);

    const result = await flow.handleInboundPickupPlotFlow({
      tenantId: 7,
      from: "+919876543210",
      contactId: 21,
      threadId: 51,
      message: { type: "text", text: { body: "Show me" } },
    });

    expect(result).toEqual({ handled: true, action: "plots" });
    expect(provider.sendInteractive).toHaveBeenCalledWith(expect.objectContaining({
      type: "list",
      action: expect.objectContaining({
        sections: [{
          title: "Available options",
          rows: [expect.objectContaining({ id: "pickup_plot:plot:30", title: "Plot A-30" })],
        }],
      }),
    }));
    expect(prisma.whatsAppMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: 7, threadId: 51, metaType: "interactive", status: "SENT" }),
    });
  });

  test("a selected plot shows only that plot's pickup locations", async () => {
    prisma.plotSite.findFirst.mockResolvedValue({
      id: 30,
      name: "Green Acres",
      plotNumber: "A-30",
      pickupLocationId: null,
      pickupLocationIdsJson: "[12,13]",
    });
    prisma.pickupLocation.findMany.mockResolvedValue([
      { id: 12, name: "Central Station", address: "42 Lake Road", googleMapsLink: null },
    ]);

    await flow.handleInboundPickupPlotFlow({
      tenantId: 7,
      from: "+919876543210",
      contactId: 21,
      threadId: 51,
      message: { type: "interactive", interactive: { list_reply: { id: "pickup_plot:plot:30", title: "Plot A-30" } } },
    });

    expect(prisma.pickupLocation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 7, id: { in: [12, 13] }, isActive: true },
    }));
    expect(provider.sendInteractive).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining("Plot A-30"),
      action: expect.objectContaining({
        sections: [{
          title: "Available options",
          rows: [expect.objectContaining({ id: "pickup_plot:pickup:30:12", title: "Central Station" })],
        }],
      }),
    }));
  });

  test("a pickup reply records the plot and pickup, then confirms in the chat", async () => {
    prisma.plotSite.findFirst.mockResolvedValue({
      id: 30,
      name: "Green Acres",
      plotNumber: "A-30",
      price: 250000,
      availability: "AVAILABLE",
      pickupLocationId: 12,
      pickupLocationIdsJson: "[12]",
    });
    prisma.pickupLocation.findFirst.mockResolvedValue({
      id: 12,
      name: "Central Station",
      address: "42 Lake Road",
      googleMapsLink: "https://maps.app.goo.gl/example",
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      plotBooking: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 81 }),
      },
      contact: { update: vi.fn().mockResolvedValue({ id: 21 }) },
      customerPickup: { upsert: vi.fn().mockResolvedValue({ id: 71, pickupAddress: "42 Lake Road" }) },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));

    const result = await flow.handleInboundPickupPlotFlow({
      tenantId: 7,
      from: "+919876543210",
      contactId: 21,
      threadId: 51,
      message: { type: "interactive", interactive: { list_reply: { id: "pickup_plot:pickup:30:12", title: "Central Station" } } },
    });

    expect(result).toEqual({ handled: true, action: "pickup" });
    expect(tx.customerPickup.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ tenantId: 7, contactId: 21, pickupAddress: "42 Lake Road" }),
    }));
    expect(tx.plotBooking.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: 7, contactId: 21, plotSiteId: 30, customerPickupId: 71 }),
    }));
    expect(provider.sendText).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining("Your selection is confirmed"),
    }));
  });

  test("the immediate reply to an existing pickup/plot template opens the plot list", async () => {
    prisma.whatsAppMessage.findFirst.mockResolvedValue({
      templateName: "custom_sequence_plot_template",
      metaType: null,
      interactiveJson: JSON.stringify({
        sequenceKey: "sequence:51:step:12:main",
        sequenceEnrollmentId: 51,
        sequenceId: 14,
        pickupPlotFlow: true,
      }),
    });
    prisma.plotSite.findMany.mockResolvedValue([
      { id: 30, name: "Green Acres", plotNumber: "A-30", block: null, address: "Airport Road" },
    ]);

    await expect(flow.handleInboundPickupPlotFlow({
      tenantId: 7,
      from: "+919876543210",
      contactId: 21,
      threadId: 51,
      message: { type: "text", text: { body: "Yes" } },
    })).resolves.toEqual({ handled: true, action: "plots" });
    expect(provider.sendInteractive).toHaveBeenCalledOnce();
  });

  test("unrelated WhatsApp messages remain untouched", async () => {
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ templateName: null, metaType: "text", interactiveJson: null });
    await expect(flow.handleInboundPickupPlotFlow({
      tenantId: 7,
      from: "+919876543210",
      contactId: 21,
      threadId: 51,
      message: { type: "text", text: { body: "What is my invoice total?" } },
    })).resolves.toEqual({ handled: false });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(provider.sendInteractive).not.toHaveBeenCalled();
  });

  test("typing PLOTS does not start the flow without a marked sequence message", async () => {
    prisma.whatsAppMessage.findFirst.mockResolvedValue({ templateName: null, metaType: "text", interactiveJson: null });
    await expect(flow.handleInboundPickupPlotFlow({
      tenantId: 7,
      from: "+919876543210",
      contactId: 21,
      threadId: 51,
      message: { type: "text", text: { body: "PLOTS" } },
    })).resolves.toEqual({ handled: false });
    expect(provider.sendInteractive).not.toHaveBeenCalled();
  });

  test("a manual send of the same template does not start the flow", async () => {
    prisma.whatsAppMessage.findFirst.mockResolvedValue({
      templateName: "custom_sequence_plot_template",
      metaType: null,
      interactiveJson: JSON.stringify({ parameters: [] }),
    });
    await expect(flow.handleInboundPickupPlotFlow({
      tenantId: 7,
      from: "+919876543210",
      contactId: 21,
      threadId: 51,
      message: { type: "text", text: { body: "Yes" } },
    })).resolves.toEqual({ handled: false });
    expect(provider.sendInteractive).not.toHaveBeenCalled();
  });

  test("non-generic tenants are never changed", async () => {
    prisma.tenant.findUnique.mockResolvedValue({ vertical: "travel" });
    await expect(flow.handleInboundPickupPlotFlow({
      tenantId: 7,
      from: "+919876543210",
      threadId: 51,
      message: { type: "interactive", interactive: { list_reply: { id: "pickup_plot:plot:30", title: "Plot A-30" } } },
    })).resolves.toEqual({ handled: false, code: "GENERIC_ONLY" });
    expect(provider.sendInteractive).not.toHaveBeenCalled();
  });

  test("parses only the flow's own interactive IDs", () => {
    expect(flow._internal.parseAction({ interactive: { list_reply: { id: "pickup_plot:pickup:30:12" } } }))
      .toEqual({ type: "pickup", plotId: 30, pickupLocationId: 12 });
    expect(flow._internal.parseAction({ interactive: { list_reply: { id: "some_other_menu:12" } } }))
      .toBeNull();
  });
});
