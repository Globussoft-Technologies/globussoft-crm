/**
 * POS Receipt Dispatcher — Wave 8b residual closure.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  PURPOSE
 * ────────────────────────────────────────────────────────────────────────
 *
 * Subscribes to the in-process eventBus on `sale.completed` and queues
 * outbound SMS receipts for the buying patient, plus a WhatsApp receipt
 * if the patient has WhatsApp opt-in (Contact.whatsappOptIn=true on the
 * patient's matched contact, looked up by normalised phone).
 *
 * ────────────────────────────────────────────────────────────────────────
 *  CONTRACT
 * ────────────────────────────────────────────────────────────────────────
 *
 * Both messages are QUEUED on SmsMessage / WhatsAppMessage rows — the
 * existing provider workers pick them up. Templates are kept short and
 * include: invoice number, total, line summary, clinic name. Localised
 * to the tenant's defaultCurrency for the total formatter.
 *
 * Trigger: `bus.emit('sale.completed', { payload, tenantId })` where
 *   payload = { saleId, status: 'COMPLETED' }.
 *
 * Skip conditions (silent no-op, all logged via console but not thrown):
 *   - payload.status set and !== 'COMPLETED' (refund / cancel reuses the topic)
 *   - sale row not found by saleId+tenantId
 *   - sale.status !== 'COMPLETED' (re-check post-fetch in case of race)
 *   - sale.patientId is null (anonymous walk-in)
 *   - patient row missing or has no phone
 *   - duplicate within DEDUP_WINDOW_MIN (30 min) for same to + invoiceNumber
 *
 * Idempotency: dedup by querying the last 30 minutes of SmsMessage rows
 * for the same to + invoiceNumber substring. A second `sale.completed`
 * for the same sale (e.g. a refund-and-reissue cycle that re-emits) is
 * a no-op. WhatsApp dedup uses the same shape.
 *
 * Wire-in: `start()` is called once on server boot from server.js, after
 * the eventBus is loaded. No cron tick — purely event-driven.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  RATIONALE — why lib/ not inline in pos.js
 * ────────────────────────────────────────────────────────────────────────
 *
 * pos.js fires `sale.completed` synchronously after the create; the
 * subscriber here runs out-of-band so a SMS/WhatsApp provider hiccup
 * can never roll back the sale itself. Same fire-and-forget shape as
 * `lib/autoConsumptionApplier.js`.
 *
 * Alternatives considered:
 *   (A) Direct provider call in pos.js handler — rejected because a
 *       provider timeout would block the sale.created response.
 *   (B) Cron poll over recently-completed sales — rejected as too
 *       laggy; user expects receipt within seconds of payment.
 *   (✓) eventBus subscription — fires synchronously after sale write
 *       commits but rolls forward independently. Failures land in
 *       error logs without rolling back the sale.
 *
 * ────────────────────────────────────────────────────────────────────────
 *  TESTED + ADOPTED
 * ────────────────────────────────────────────────────────────────────────
 *
 * Tested at: backend/test/lib/posReceiptDispatcher.test.js
 *   (vitest cases for SMS template body, WhatsApp template body,
 *    currency formatting, dedup-window probe, skip-conditions matrix)
 *
 * Adopted by:
 *   - server.js — start() wired at boot when DISABLE_CRONS is unset
 *   - routes/pos.js — emits `sale.completed` after every sale create
 *
 * NOT adopted by (deliberate):
 *   - PUT /sales/:id (refund / void) — refunds do NOT emit a new receipt;
 *     a refund-aware template should be added in a future wave if Rishu
 *     asks. Today the dedup-window stops a re-emit on the same invoice.
 */
const prisma = require("./prisma");
const { bus } = require("./eventBus");

// Recently-dispatched dedup window. 30 min is enough to absorb the
// common "void + re-create" cycle without permanently blocking a
// legitimate same-day re-issue (which would have a different sale.id +
// different invoiceNumber anyway).
const DEDUP_WINDOW_MIN = 30;

/**
 * Format an amount with a 3-letter currency symbol fallback. Uses Rs.
 * for INR (DLT-safe) and `$` for USD; other currencies render the raw
 * 3-letter ISO code as the prefix.
 *
 * @param {number|string|null|undefined} amount
 * @param {string|null} currency  3-letter ISO code (INR / USD / etc.)
 * @returns {string}  formatted "<symbol><amount.toFixed(2)>"
 */
function formatMoney(amount, currency) {
  const num = Number(amount) || 0;
  // Currency token only — the existing SMS template doesn't need locale-
  // specific decimal grouping; consumers see "Rs.1234.50" or "$1234.50".
  const symbol = currency === "INR" ? "Rs." : currency === "USD" ? "$" : currency || "";
  return `${symbol}${num.toFixed(2)}`;
}

/**
 * Render the SMS body for a sale receipt. Kept short to fit a single
 * DLT-template segment.
 *
 * @param {{ sale: { total:number|string, invoiceNumber:string }, patientName:string, clinicName:string, currency:string, lineCount:number }} args
 * @returns {string}
 */
function composeSmsBody({ sale, patientName, clinicName, currency, lineCount }) {
  const total = formatMoney(sale.total, currency);
  return `Hi ${patientName || "there"}, thank you for your purchase at ${clinicName}! Invoice ${sale.invoiceNumber} for ${total} (${lineCount} item${lineCount === 1 ? "" : "s"}). Reach us if you have any questions.`;
}

/**
 * Render the WhatsApp body for a sale receipt. Slightly longer than the
 * SMS variant (no DLT length cap on WhatsApp Business API).
 *
 * @param {{ sale: { total:number|string, invoiceNumber:string }, patientName:string, clinicName:string, currency:string, lineCount:number }} args
 * @returns {string}
 */
function composeWhatsappBody({ sale, patientName, clinicName, currency, lineCount }) {
  const total = formatMoney(sale.total, currency);
  return `Hi ${patientName || "there"}, your purchase at ${clinicName} is confirmed. Invoice ${sale.invoiceNumber} • Total ${total} • ${lineCount} item${lineCount === 1 ? "" : "s"}. Thank you!`;
}

/**
 * Dispatch SMS + (conditionally) WhatsApp receipts for a single sale.
 * Exported so the vitest unit can drive it directly without booting
 * the eventBus.
 *
 * @param {{ payload: { saleId:number, status?:string }, tenantId:number }} args
 * @returns {Promise<void>}  fire-and-forget; never throws (catches internally)
 */
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

/**
 * Wire the eventBus subscription at boot. Idempotent — safe to call
 * repeatedly (uses a module-private flag to avoid duplicate listeners
 * across hot reloads in dev).
 *
 * @returns {void}
 */
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
