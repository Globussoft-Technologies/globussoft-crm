import { describe, expect, test, vi } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const { syncPlotBookingInvoice } = requireCJS("../../lib/plotBookingInvoice");

function makeClient() {
  return {
    invoice: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    contact: { findFirst: vi.fn() },
    plotSite: { findFirst: vi.fn() },
    plotInvoiceItem: { create: vi.fn() },
    plotBooking: { update: vi.fn() },
    payment: { update: vi.fn() },
  };
}

describe("syncPlotBookingInvoice", () => {
  test("creates and links a generic plot invoice after the first successful payment", async () => {
    const client = makeClient();
    client.contact.findFirst.mockResolvedValue({ id: 61, name: "Sadab", email: "sadab@example.com", phone: "9000000000" });
    client.plotSite.findFirst.mockResolvedValue({ id: 30, name: "Marathahalli", plotNumber: "10" });
    client.invoice.create.mockImplementation(async ({ data }) => ({ id: 701, ...data }));

    const invoice = await syncPlotBookingInvoice(client, {
      tenantId: 7,
      booking: { id: 501, contactId: 61, plotSiteId: 30, totalAmount: 200000, invoiceId: null },
      paymentId: 801,
      amountPaid: 1,
      balance: 199999,
      paymentMode: "razorpay",
      paidAt: new Date("2026-10-19T06:00:00.000Z"),
    });

    expect(invoice).toMatchObject({ id: 701, status: "UNPAID", amountPaid: 1, balance: 199999 });
    expect(client.plotInvoiceItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: 7, invoiceId: 701, plotBookingId: 501, itemId: 30 }),
    });
    expect(client.plotBooking.update).toHaveBeenCalledWith({ where: { id: 501 }, data: { invoiceId: 701 } });
    expect(client.payment.update).toHaveBeenCalledWith({ where: { id: 801 }, data: { invoiceId: 701 } });
  });

  test("updates an existing invoice and marks it paid only when its balance reaches zero", async () => {
    const client = makeClient();
    client.invoice.findFirst.mockResolvedValue({ id: 701, status: "UNPAID", paidAt: null });
    client.invoice.update.mockResolvedValue({ id: 701, status: "PAID", amountPaid: 200000, balance: 0 });
    const paidAt = new Date("2026-10-19T06:00:00.000Z");

    await syncPlotBookingInvoice(client, {
      tenantId: 7,
      booking: { id: 501, contactId: 61, plotSiteId: 30, totalAmount: 200000, invoiceId: 701 },
      paymentId: 801,
      amountPaid: 200000,
      balance: 0,
      paymentMode: "upi",
      paidAt,
    });

    expect(client.invoice.update).toHaveBeenCalledWith({
      where: { id: 701 },
      data: { amountPaid: 200000, balance: 0, status: "PAID", paidAt, paymentMode: "upi" },
    });
    expect(client.invoice.create).not.toHaveBeenCalled();
  });
});
