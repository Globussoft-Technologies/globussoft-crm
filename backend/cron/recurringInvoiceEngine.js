const cron = require("node-cron");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function addInterval(date, frequency) {
  const d = new Date(date);
  switch (frequency) {
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "quarterly": d.setMonth(d.getMonth() + 3); break;
    case "yearly": d.setFullYear(d.getFullYear() + 1); break;
    default: d.setMonth(d.getMonth() + 1);
  }
  return d;
}

async function processRecurringInvoices(io) {
  try {
    const now = new Date();
    const due = await prisma.invoice.findMany({
      where: {
        isRecurring: true,
        status: { not: "VOID" },
        nextRecurDate: { lte: now },
      },
      include: { contact: true },
    });

    let created = 0;
    for (const inv of due) {
      try {
        const invNum = `INV-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
        const newDueDate = addInterval(now, inv.recurFrequency);

        // Create the new invoice (inherit tenant from parent)
        await prisma.invoice.create({
          data: {
            invoiceNum: invNum,
            amount: inv.amount,
            status: "UNPAID",
            dueDate: newDueDate,
            contactId: inv.contactId,
            dealId: inv.dealId,
            parentInvoiceId: inv.id,
            tenantId: inv.tenantId || 1,
          },
        });

        // Schedule next recurrence
        const nextDate = addInterval(inv.nextRecurDate, inv.recurFrequency);
        await prisma.invoice.update({
          where: { id: inv.id },
          data: { nextRecurDate: nextDate },
        });

        // Create audit log (inherit tenant from parent invoice)
        await prisma.auditLog.create({
          data: {
            action: "CREATE",
            entity: "Invoice",
            details: JSON.stringify({ source: "Recurring", parentInvoice: inv.invoiceNum, newInvoice: invNum }),
            tenantId: inv.tenantId || 1,
          },
        });

        console.log(`[RecurringInvoice] Generated ${invNum} from ${inv.invoiceNum} for ${inv.contact?.name}`);
        created++;
      } catch (err) {
        console.error(`[RecurringInvoice] Failed for invoice ${inv.id}:`, err.message);
      }
    }

    if (created > 0) {
      console.log(`[RecurringInvoice] Created ${created} invoices`);
      if (io) io.emit("invoice_created", { count: created });
    }
  } catch (err) {
    console.error("[RecurringInvoice] Engine error:", err.message);
  }
}

function initRecurringInvoiceCron(io) {
  // Run daily at 6 AM
  cron.schedule("0 6 * * *", () => processRecurringInvoices(io));
  console.log("[RecurringInvoice] Cron scheduled: daily at 6 AM");
}

module.exports = { initRecurringInvoiceCron, processRecurringInvoices };
