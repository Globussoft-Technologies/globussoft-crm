const cronRegistry = require("../lib/cronRegistry");
const crypto = require("crypto");
const prisma = require("../lib/prisma");

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

// Cron entry point — picks up Invoice rows where isRecurring=true and
// nextRecurDate has elapsed, then mints a child invoice + advances the
// schedule. Why the explicit notIn against BOTH spellings: the engine
// originally filtered only status='VOID', but routes/billing.js's public
// POST /api/billing/invoices/:id/void route writes status='VOIDED' (line
// 456). Without the second spelling, a voided recurring template could
// still be picked up by the cron and silently regenerate child invoices
// after the operator had explicitly voided it. The /api/billing/recurring/run
// manual endpoint already excluded both spellings (defensive); this
// alignment closes the cron-side gap. Closes #410.
async function processRecurringInvoices(io) {
  try {
    const now = new Date();
    const due = await prisma.invoice.findMany({
      where: {
        isRecurring: true,
        status: { notIn: ["VOID", "VOIDED"] },
        nextRecurDate: { lte: now },
      },
      include: { contact: true },
    });

    let created = 0;
    for (const inv of due) {
      let generated = [];
      try {
        await prisma.$transaction(async (tx) => {
          // Re-read under lock so the row state is current and the
          // transaction serialises with any concurrent worker.
          const parent = await tx.invoice.findUnique({
            where: { id: inv.id },
          });
          if (!parent || !parent.isRecurring || parent.nextRecurDate > now) return;

          // Catch-up loop: mint one child invoice for EVERY missed period
          // from the current nextRecurDate forward until it exceeds now.
          let nextDate = new Date(parent.nextRecurDate);
          while (nextDate <= now) {
            const childNum = `INV-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
            const childDueDate = addInterval(nextDate, parent.recurFrequency);

            await tx.invoice.create({
              data: {
                invoiceNum: childNum,
                amount: parent.amount,
                status: "UNPAID",
                dueDate: childDueDate,
                contactId: parent.contactId,
                dealId: parent.dealId,
                parentInvoiceId: parent.id,
                tenantId: parent.tenantId || 1,
              },
            });

            generated.push(childNum);
            nextDate = addInterval(nextDate, parent.recurFrequency);
          }

          // Advance the parent template to the first future period
          await tx.invoice.update({
            where: { id: parent.id },
            data: { nextRecurDate: nextDate },
          });

          // Single audit log summarising the batch (keeps row count sane)
          await tx.auditLog.create({
            data: {
              action: "CREATE",
              entity: "Invoice",
              details: JSON.stringify({
                source: "Recurring",
                parentInvoice: parent.invoiceNum,
                generated,
                count: generated.length,
              }),
              tenantId: parent.tenantId || 1,
            },
          });
        });

        if (generated.length > 0) {
          console.log(`[RecurringInvoice] Generated ${generated.length} invoice(s) from ${inv.invoiceNum} for ${inv.contact?.name}: ${generated.join(", ")}`);
          created += generated.length;
        }
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
  cronRegistry.register({
    name: "recurringInvoiceEngine",
    description: "Generates due recurring invoices (daily 06:00)",
    defaultSchedule: "0 6 * * *",
    tickFn: () => processRecurringInvoices(io),
  }).catch((e) => console.error("[RecurringInvoice] cronRegistry registration failed:", e.message));
}

module.exports = { initRecurringInvoiceCron, processRecurringInvoices };
