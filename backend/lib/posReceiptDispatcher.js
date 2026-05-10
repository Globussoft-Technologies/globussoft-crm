/**
 * POS Receipt Dispatcher — Wave 8b residual closure.
 *
 * Subscribes to the in-process eventBus on `sale.completed` and queues
 * outbound SMS receipts for the buying patient, plus a WhatsApp receipt
 * if the patient has WhatsApp opt-in (Contact.whatsappOptIn=true on the
 * patient's matched contact, looked up by normalised phone).
 *
 * Why this lives in lib/ and not as an inline emit-and-go in pos.js:
 *   pos.js fires `sale.completed` synchronously after the create; the
 *   subscriber here runs out-of-band so a SMS/WhatsApp provider hiccup
 *   can never roll back the sale itself. Same fire-and-forget shape as
 *   `lib/autoConsumptionApplier.js`.
 *
 * Both messages are QUEUED on SmsMessage / WhatsAppMessage rows — the
 * existing provider workers pick them up. Templates are kept short and
 * include: invoice number, total, line summary, clinic name. Localised
 * to the tenant's defaultCurrency for the total formatter.
 *
 * Idempotency: dedup by querying the last 30 minutes of SmsMessage rows
 * for the same to + invoiceNumber substring. A second `sale.completed`
 * for the same sale (e.g. a refund-and-reissue cycle that re-emits) is
 * a no-op. WhatsApp dedup uses the same shape.
 *
 * Wire-in: `start()` is called once on server boot from server.js, after
 * the eventBus is loaded. No cron tick — purely event-driven.
 */
const prisma = require("./prisma");
const { bus } = require("./eventBus");

// Recently-dispatched dedup window. 30 min is enough to absorb the
// common "void + re-create" cycle without permanently blocking a
// legitimate same-day re-issue (which would have a different sale.id +
// different invoiceNumber anyway).
const DEDUP_WINDOW_MIN = 30;

function formatMoney(amount, currency) {
  const num = Number(amount) || 0;
  // Currency token only — the existing SMS template doesn't need locale-
  // specific decimal grouping; consumers see "₹1234.50" or "$1234.50".
  const symbol = currency === "INR" ? "Rs." : currency === "USD" ? "$" : currency || "";
  return `${symbol}${num.toFixed(2)}`;
}

function composeSmsBody({ sale, patientName, clinicName, currency, lineCount }) {
  const total = formatMoney(sale.total, currency);
  return `Hi ${patientName || "there"}, thank you for your purchase at ${clinicName}! Invoice ${sale.invoiceNumber} for ${total} (${lineCount} item${lineCount === 1 ? "" : "s"}). Reach us if you have any questions.`;
}

function composeWhatsappBody({ sale, patientName, clinicName, currency, lineCount }) {
  // WhatsApp body can carry slightly more detail (no DLT length cap).
  const total = formatMoney(sale.total, currency);
  return `Hi ${patientName || "there"}, your purchase at ${clinicName} is confirmed. Invoice ${sale.invoiceNumber} • Total ${total} • ${lineCount} item${lineCount === 1 ? "" : "s"}. Thank you!`;
}

async function dispatchReceiptForSale({ payload, tenantId }) {
  // Defensive — skip silently if the payload isn't shaped right (a future
  // refactor of the emitter shouldn't crash this listener and take down
  // the eventBus).
  if (!payload || !payload.saleId) return;

  // Refund/cancel events also fire `sale.completed`-shaped emits in the
  // wave-6a catalogue; only act on the COMPLETED transition.
  if (payload.status && payload.status !== "COMPLETED") return;

  try {
    const sale = await prisma.sale.findFirst({
      where: { id: payload.saleId, tenantId },
      include: { lineItems: true },
    });
    if (!sale || sale.status !== "COMPLETED") return;

    // Anonymous walk-ins (no patientId) skip the receipt — there's
    // nobody to send it to. Cash-and-carry without a patient row is a
    // legitimate POS flow we don't want to block.
    if (!sale.patientId) return;

    const patient = await prisma.patient.findFirst({
      where: { id: sale.patientId, tenantId },
      select: { id: true, name: true, phone: true, locationId: true },
    });
    if (!patient || !patient.phone) return;

    // Tenant + clinic name — kept short for the SMS body.
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, defaultCurrency: true },
    });
    const currency = tenant?.defaultCurrency || "INR";
    const clinicName = tenant?.name || "the clinic";

    // Idempotency probe: any SmsMessage for the same recipient containing
    // this invoiceNumber in the last DEDUP_WINDOW_MIN minutes → bail.
    const cutoff = new Date(Date.now() - DEDUP_WINDOW_MIN * 60_000);
    const existing = await prisma.smsMessage.findFirst({
      where: {
        tenantId,
        to: patient.phone,
        body: { contains: sale.invoiceNumber },
        createdAt: { gte: cutoff },
      },
      select: { id: true },
    });
    if (existing) return;

    const lineCount = (sale.lineItems || []).length;
    const smsBody = composeSmsBody({ sale, patientName: patient.name, clinicName, currency, lineCount });

    // Always queue an SMS (DLT-aware send happens at the provider tier).
    await prisma.smsMessage.create({
      data: {
        to: patient.phone,
        body: smsBody,
        direction: "OUTBOUND",
        status: "QUEUED",
        contactId: null,
        tenantId,
      },
    });

    // WhatsApp receipt only if the matched contact has whatsappOptIn=true.
    // Patient.phone may not 1:1 match a Contact row (CRM has both Patient
    // and Contact entities); look up by normalised last-10 digits.
    const last10 = String(patient.phone).replace(/\D/g, "").slice(-10);
    if (last10.length === 10) {
      const contact = await prisma.contact.findFirst({
        where: {
          tenantId,
          phone: { contains: last10 },
        },
        select: { id: true, whatsappOptIn: true },
      });
      if (contact && contact.whatsappOptIn === true) {
        const waBody = composeWhatsappBody({ sale, patientName: patient.name, clinicName, currency, lineCount });
        await prisma.whatsAppMessage.create({
          data: {
            tenantId,
            contactId: contact.id,
            phoneE164: patient.phone,
            direction: "OUTBOUND",
            body: waBody,
            status: "QUEUED",
          },
        });
      }
    }
  } catch (e) {
    console.error(`[posReceiptDispatcher] tenant=${tenantId} sale=${payload?.saleId} failed:`, e.message);
  }
}

let _started = false;

function start() {
  if (_started) return;
  _started = true;
  bus.on("sale.completed", ({ payload, tenantId }) => {
    // Fire-and-forget — never await in a bus listener (would block
    // subsequent listeners on the same tick).
    dispatchReceiptForSale({ payload, tenantId }).catch((e) => {
      console.error("[posReceiptDispatcher] unhandled:", e.message);
    });
  });
  console.log("[posReceiptDispatcher] subscribed to sale.completed");
}

// Exported for the unit test to drive directly without the eventBus.
module.exports = {
  start,
  dispatchReceiptForSale,
  composeSmsBody,
  composeWhatsappBody,
  formatMoney,
};
