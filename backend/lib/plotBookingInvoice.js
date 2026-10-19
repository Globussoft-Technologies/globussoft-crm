const crypto = require("crypto");
const { sanitizeJsonForStringColumn } = require("./sanitizeJson");

function money(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

async function syncPlotBookingInvoice(client, {
  tenantId,
  booking,
  contact = null,
  paymentId = null,
  amountPaid,
  balance,
  paymentMode = null,
  paidAt = new Date(),
}) {
  if (!booking?.id || !tenantId) return null;

  const totalAmount = money(booking.totalAmount);
  const paidAmount = Math.min(totalAmount, money(amountPaid));
  const balanceDue = Math.max(0, money(balance));
  const fullyPaid = totalAmount > 0 && balanceDue === 0;
  let invoice = booking.invoiceId
    ? await client.invoice.findFirst({ where: { id: Number(booking.invoiceId), tenantId } })
    : null;

  if (!invoice) {
    const [customer, plot] = await Promise.all([
      contact || client.contact.findFirst({
        where: { id: Number(booking.contactId), tenantId, deletedAt: null },
        select: { id: true, name: true, email: true, phone: true },
      }),
      client.plotSite.findFirst({
        where: { id: Number(booking.plotSiteId), tenantId },
        select: { id: true, name: true, plotNumber: true },
      }),
    ]);
    if (!customer || !plot || totalAmount <= 0) return null;

    const dueDate = new Date(paidAt);
    dueDate.setDate(dueDate.getDate() + 7);
    const description = plot.plotNumber
      ? `${plot.name || "Plot"} — Plot No. ${plot.plotNumber}`
      : plot.name || `Plot ${plot.id}`;
    invoice = await client.invoice.create({
      data: {
        invoiceNum: `PLOT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
        amount: totalAmount,
        status: fullyPaid ? "PAID" : "UNPAID",
        dueDate,
        paidAt: fullyPaid ? paidAt : null,
        contactId: Number(booking.contactId),
        customerName: customer.name || null,
        customerPhone: customer.phone || null,
        customerEmail: customer.email || null,
        paymentMode: paymentMode || null,
        currency: "INR",
        amountPaid: paidAmount,
        balance: balanceDue,
        lineItemsJson: sanitizeJsonForStringColumn([{
          type: "plot",
          itemId: plot.id,
          name: description,
          quantity: 1,
          unitPrice: totalAmount,
          amount: totalAmount,
        }]),
        tenantId,
      },
    });
    await client.plotInvoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        plotBookingId: booking.id,
        itemType: "PLOT",
        itemId: plot.id,
        description,
        quantity: 1,
        unitPrice: totalAmount,
        amount: totalAmount,
      },
    });
    await client.plotBooking.update({
      where: { id: booking.id },
      data: { invoiceId: invoice.id },
    });
  } else {
    const status = invoice.status === "VOIDED"
      ? "VOIDED"
      : fullyPaid ? "PAID" : "UNPAID";
    invoice = await client.invoice.update({
      where: { id: invoice.id },
      data: {
        amountPaid: paidAmount,
        balance: balanceDue,
        status,
        ...(fullyPaid && !invoice.paidAt ? { paidAt } : {}),
        ...(paymentMode ? { paymentMode } : {}),
      },
    });
  }

  if (paymentId) {
    await client.payment.update({ where: { id: paymentId }, data: { invoiceId: invoice.id } });
  }
  return invoice;
}

module.exports = { syncPlotBookingInvoice };
