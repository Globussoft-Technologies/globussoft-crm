// Pay-or-cancel deposit-deadline copy for cron/paymentDeadlineEngine.js.
//
// Cadence (2026-06-16 product call): an `accepted` booking must have its 50%
// deposit paid at least 7 days before departure (deadline = startDate - 7d).
// We chase the customer daily T-10 → T-7 with escalating urgency, then — if
// still unpaid when T-6 arrives — flag the advisor + send the customer an
// "at-risk" notice. No auto-cancel: an advisor manually sets status "expired".
//
// Content source mirrors tripCountdownContent.js: LLM-generated per email
// (task "payment-reminder") when the Q11 keys are present; otherwise the
// deterministic template library below (already distinct per day). The LLM
// path auto-engages once keys land (routeRequest returns stub=false).

const llmRouter = require("./llmRouter");

// Which days-to-go fire a deposit reminder. Deadline is T-7, so this is the
// 4-day run-up T-10 → T-7 inclusive. The T-6 "overdue" notice is handled
// separately by the engine (it's not a fire-day reminder).
const FIRE_DAYS = [10, 9, 8, 7];

function shouldRemind(daysToGo) {
  return FIRE_DAYS.includes(daysToGo);
}
function dayTag(daysToGo) {
  return `d${daysToGo}`;
}

// Cheap money formatter — ₹ for INR, otherwise "<CODE> <amount>". Rounds to
// whole units (deposits are quoted in whole rupees in this CRM).
function formatMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "the deposit";
  const rounded = Math.round(n).toLocaleString("en-IN");
  return (currency || "INR") === "INR" ? `₹${rounded}` : `${currency} ${rounded}`;
}

// Per-day escalating templates. {dest} {name} {amount} {deadline} {daysToDeadline}
// are interpolated. daysToDeadline = daysToGo - 7 (3 → 0 across the window).
const TEMPLATES = {
  10: {
    subject: "Action needed: secure your {dest} trip with a 50% deposit",
    body: "Hi {name},\n\nThank you for confirming your trip to {dest}! To lock it in, we need your 50% deposit of {amount} by {deadline} ({daysToDeadline} days away). Paying on time guarantees your booking. Let us know if you have any questions.\n\nTeam Travel Stall",
  },
  9: {
    subject: "Reminder: {dest} deposit due by {deadline}",
    body: "Hi {name},\n\nJust a friendly reminder — your 50% deposit of {amount} for {dest} is due by {deadline}. Once it's in, your booking is fully secured. Reply here if you'd like a payment link.\n\nTeam Travel Stall",
  },
  8: {
    subject: "2 days left to pay your {dest} deposit",
    body: "Hi {name},\n\nYour deposit of {amount} for {dest} is due by {deadline} — just 2 days from now. To avoid losing your booking, please complete the payment soon. We're here to help if anything's unclear.\n\nTeam Travel Stall",
  },
  7: {
    subject: "Final reminder: {dest} deposit due TODAY",
    body: "Hi {name},\n\nToday is the deadline to pay your 50% deposit of {amount} for {dest}. If we don't receive it today, your booking is at risk of cancellation. Please pay now to keep your trip confirmed — contact us immediately if you need assistance.\n\nTeam Travel Stall",
  },
};

// Customer-facing OVERDUE notice (sent at T-6 when the deadline passed unpaid).
// Distinct from the run-up reminders — the tone is "at risk", and we explicitly
// invite them to contact us rather than implying the booking is already gone
// (no auto-cancel; an advisor decides).
const OVERDUE_TEMPLATE = {
  subject: "Your {dest} booking is at risk — deposit overdue",
  body: "Hi {name},\n\nWe haven't yet received the 50% deposit of {amount} for your {dest} trip, and the deadline has now passed. Your booking is at risk of cancellation. Please pay as soon as possible, or contact us right away so we can help keep your trip on track.\n\nTeam Travel Stall",
};

function interpolate(str, vars) {
  return String(str)
    .replace(/\{dest\}/g, vars.destination || "your destination")
    .replace(/\{name\}/g, vars.customerName || "traveller")
    .replace(/\{amount\}/g, vars.amountLabel || "the deposit")
    .replace(/\{deadline\}/g, vars.deadlineLabel || "the deadline")
    .replace(/\{daysToDeadline\}/g, String(vars.daysToDeadline != null ? vars.daysToDeadline : ""));
}

function varsFrom({ destination, customerName, depositAmount, currency, deadlineLabel, daysToGo }) {
  return {
    destination,
    customerName,
    amountLabel: formatMoney(depositAmount, currency),
    deadlineLabel: deadlineLabel || "the deadline",
    daysToDeadline: daysToGo != null ? daysToGo - 7 : null,
  };
}

// Deterministic template reminder — the always-available fallback + unit-test
// surface. Returns { subject, text, html, llmSourced: false }.
function buildFallbackReminder(opts) {
  const tpl = TEMPLATES[opts.daysToGo] || TEMPLATES[7];
  const vars = varsFrom(opts);
  const subject = interpolate(tpl.subject, vars);
  const text = interpolate(tpl.body, vars);
  return { subject, text, html: text.replace(/\n/g, "<br>"), llmSourced: false };
}

// Deterministic OVERDUE customer notice. No LLM path — at-risk wording stays
// fixed so we never soften/over-promise on a cancellation-adjacent message.
function buildOverdueNotice(opts) {
  const vars = varsFrom({ ...opts, daysToGo: null });
  const subject = interpolate(OVERDUE_TEMPLATE.subject, vars);
  const text = interpolate(OVERDUE_TEMPLATE.body, vars);
  return { subject, text, html: text.replace(/\n/g, "<br>"), llmSourced: false };
}

// Advisor flag content for the T-6 "review for cancellation" notification.
function buildOverdueAdvisorFlag({ destination, customerName, depositAmount, currency, itineraryId }) {
  const amountLabel = formatMoney(depositAmount, currency);
  return {
    title: "Deposit overdue — review for cancellation",
    message: `Itinerary #${itineraryId} (${destination || "trip"}, ${customerName || "customer"}) passed its 50% deposit deadline unpaid (${amountLabel} due). The customer has been notified. Set the booking to "expired" to cancel, or follow up to recover the payment.`,
  };
}

// Try the LLM for fresh, on-tone copy; fall back to the template on stub mode
// (no keys), error, or unparseable output. Never throws.
async function buildReminder(opts) {
  const { tenantId, destination, daysToGo, customerName } = opts;
  const vars = varsFrom(opts);
  try {
    const result = await llmRouter.routeRequest({
      task: "payment-reminder",
      tenantId,
      payload: {
        destination,
        customerName,
        daysToGo,
        daysUntilDeadline: vars.daysToDeadline,
        depositAmount: vars.amountLabel,
        deadline: vars.deadlineLabel,
      },
    });
    if (result && !result.stub && result.text) {
      const parsed = JSON.parse(result.text);
      if (parsed && parsed.subject && parsed.body) {
        const subject = interpolate(parsed.subject, vars);
        const text = interpolate(parsed.body, vars);
        return { subject, text, html: text.replace(/\n/g, "<br>"), llmSourced: true };
      }
    }
  } catch {
    /* fall through to template */
  }
  return buildFallbackReminder(opts);
}

module.exports = {
  FIRE_DAYS,
  shouldRemind,
  dayTag,
  formatMoney,
  buildFallbackReminder,
  buildOverdueNotice,
  buildOverdueAdvisorFlag,
  buildReminder,
  TEMPLATES,
};
