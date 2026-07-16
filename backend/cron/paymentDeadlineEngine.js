// Travel CRM — pay-or-cancel deposit-deadline engine (2026-06-16 feature).
//
// Business rule (product call): once a customer ACCEPTS an itinerary, the
// booking is committed but not yet paid. They must pay the 50% deposit at
// least 7 days before departure (deadline = startDate - 7d). We:
//
//   T-10 → T-7  email the customer a daily, escalating "pay your deposit"
//               reminder (deadline is T-7).
//   T-6 (deadline missed, still unpaid)
//               → email the customer an "at-risk" notice AND raise an advisor
//                 notification to review for cancellation, AND stamp
//                 Itinerary.paymentOverdueAt so the advisor list badges it.
//
// IMPORTANT: this engine NEVER changes the itinerary status. There is no
// auto-cancel — an advisor manually sets status "expired" to cancel (product
// decision: flag-and-review, not silent destruction of a real booking).
//
// Scope: every travel sub-brand EXCEPT Visa Sure (visa applications don't use
// the 50%-deposit trip model). Only `accepted` itineraries with a positive
// totalAmount and no advance recorded are chased (advance_paid / fully_paid
// have already paid; those get the packing-countdown engine instead).
//
// Idempotency: one PaymentDeadlineNudge row per (itineraryId, dayTag), claimed
// BEFORE sending so an hourly re-tick can't double-send. dayTag ∈
// {d10,d9,d8,d7,overdue}.

const cronRegistry = require("../lib/cronRegistry");
const prisma = require("../lib/prisma");
const emailSender = require("../lib/emailSender");
const content = require("../lib/paymentDeadlineContent");
const notificationService = require("../lib/notificationService");
const { safeNotifyTravelCustomer } = require("../lib/travelPortalNotificationService");

const { FIRE_DAYS, shouldRemind, dayTag } = content;

const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";
const PORTAL_URL = `${PORTAL_BASE}/travel/portal`;

const DEPOSIT_FRACTION = 0.5; // 50% deposit (PRD §4.7)
const DEADLINE_LEAD_DAYS = 7; // deposit due 7 days before departure
const OVERDUE_FROM_DAYS = 6; // T-6 onward (deadline missed) → flag + at-risk
const SCAN_FLOOR_DAYS = 2; // tolerate a trip that started up to 2d ago
const HORIZON_DAYS = Math.max(...FIRE_DAYS) + 1; // scan window upper bound (11)

// Calendar-day difference (UTC) between `now` and the trip start.
function daysToGo(now, start) {
  const a = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const b = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  return Math.round((b - a) / 86400000);
}

// A short, locale-stable deadline label (e.g. "14 Jun 2026").
function formatDeadline(startDate) {
  const d = new Date(startDate.getTime() - DEADLINE_LEAD_DAYS * 86400000);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Mirror of middleware/travelGuards.getSubBrandAccessSet semantics, but applied
// to an already-fetched user row (so we batch-fetch users once per tenant).
function userCanAccess(user, subBrand) {
  if (user.role === "ADMIN") return true;
  if (!user.subBrandAccess) return true; // null/unset = full access
  try {
    const arr = JSON.parse(user.subBrandAccess);
    if (!Array.isArray(arr)) return true; // malformed → full access (preserved)
    if (arr.length === 0) return false; // explicit "[]" → deny-all
    return arr.includes(subBrand);
  } catch {
    return false;
  }
}

// One pass. `now` is injectable for tests. Returns a summary for observability.
async function runPaymentDeadlineTick(now = new Date()) {
  const floor = new Date(now.getTime() - SCAN_FLOOR_DAYS * 86400000);
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 86400000);

  const itineraries = await prisma.itinerary.findMany({
    where: {
      status: "accepted", // committed but unpaid (advance_paid/fully_paid excluded)
      subBrand: { not: "visasure" }, // everything except Visa Sure
      startDate: { gte: floor, lte: horizon },
      // Exclude bookings already in (or past) the customer-cancellation flow —
      // `status` never flips away from "accepted" on cancellation (separate
      // lifecycle field, see schema comment on Itinerary.cancellationStatus),
      // so without this guard the cron keeps re-stamping paymentOverdueAt on
      // an already-cancelled/refunded booking, reviving a stale "Deposit
      // overdue" badge on the itinerary list indefinitely.
      cancellationStatus: null,
    },
    select: {
      id: true, tenantId: true, subBrand: true, contactId: true, destination: true,
      startDate: true, totalAmount: true, advancePaidAmount: true, currency: true, paymentOverdueAt: true,
    },
  });

  // Batch-fetch contact email + name.
  const contactIds = [...new Set(itineraries.map((i) => i.contactId).filter(Boolean))];
  const contacts = contactIds.length
    ? await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true, email: true } })
    : [];
  const contactById = Object.fromEntries(contacts.map((c) => [c.id, c]));

  // Batch-fetch users per tenant for advisor targeting (sub-brand scoped).
  const tenantIds = [...new Set(itineraries.map((i) => i.tenantId))];
  const usersByTenant = {};
  for (const tid of tenantIds) {
    usersByTenant[tid] = await prisma.user.findMany({
      where: { tenantId: tid },
      select: { id: true, role: true, subBrandAccess: true },
    });
  }

  const summary = { scanned: itineraries.length, remindersSent: 0, flagged: 0, sent: 0, skipped: 0 };

  for (const itin of itineraries) {
    if (!itin.startDate) { summary.skipped += 1; continue; }
    const total = Number(itin.totalAmount || 0);
    if (!(total > 0)) { summary.skipped += 1; continue; } // nothing to chase
    const deposit = total * DEPOSIT_FRACTION;
    // Defensive: if an advance somehow covers the deposit while status is still
    // "accepted", treat it as paid and don't chase.
    if (Number(itin.advancePaidAmount || 0) >= deposit) { summary.skipped += 1; continue; }

    const d = daysToGo(now, new Date(itin.startDate));
    const isReminder = shouldRemind(d);
    const isOverdue = d <= OVERDUE_FROM_DAYS;
    if (!isReminder && !isOverdue) { summary.skipped += 1; continue; } // before the window

    const contact = itin.contactId ? contactById[itin.contactId] : null;
    if (!contact || !contact.email) { summary.skipped += 1; continue; }

    const tag = isReminder ? dayTag(d) : "overdue";

    // Idempotent claim — unique([itineraryId, dayTag]) means a re-tick the
    // same bucket collides + we skip.
    let claim;
    try {
      claim = await prisma.paymentDeadlineNudge.create({
        data: { tenantId: itin.tenantId, itineraryId: itin.id, dayTag: tag, channel: "email", status: "sending" },
      });
    } catch {
      summary.skipped += 1; // P2002 — already handled this bucket
      continue;
    }

    const common = {
      tenantId: itin.tenantId,
      destination: itin.destination,
      customerName: contact.name,
      depositAmount: deposit,
      currency: itin.currency,
      daysToGo: d,
      deadlineLabel: formatDeadline(new Date(itin.startDate)),
      portalUrl: PORTAL_URL,
    };

    if (isReminder) {
      let nudge;
      try {
        nudge = await content.buildReminder(common);
      } catch (e) {
        console.error(`[PaymentDeadline] reminder build failed itin=${itin.id} ${tag}: ${e.message}`);
        await prisma.paymentDeadlineNudge.update({ where: { id: claim.id }, data: { status: "failed" } }).catch(() => {});
        continue;
      }
      const res = await emailSender.sendEmail({ to: contact.email, subject: nudge.subject, text: nudge.text, html: nudge.html });
      const status = res.sent ? "sent" : res.reason === "no_api_key" ? "logged" : "failed";
      if (res.sent) summary.sent += 1;
      summary.remindersSent += 1;
      await prisma.paymentDeadlineNudge
        .update({ where: { id: claim.id }, data: { status, subject: nudge.subject, llmSourced: nudge.llmSourced } })
        .catch(() => {});
      // Mirror to the customer's in-app portal bell (no SMS — we don't collect a
      // phone at registration). Best-effort; safeNotify never throws.
      await safeNotifyTravelCustomer({
        contactId: itin.contactId, tenantId: itin.tenantId, type: "payment",
        title: "Deposit reminder",
        message: `Please pay your ${content.formatMoney(deposit, itin.currency)} deposit for ${itin.destination || "your trip"} by ${common.deadlineLabel} to confirm your booking.`,
        link: `booking:${itin.id}`,
      });
      console.log(`[PaymentDeadline] reminder itin=${itin.id} ${tag} → ${status} (llm=${nudge.llmSourced})`);
      continue;
    }

    // ── Overdue (T-6+) — customer at-risk notice + advisor flag, no auto-cancel ──
    const notice = content.buildOverdueNotice(common);
    const res = await emailSender.sendEmail({ to: contact.email, subject: notice.subject, text: notice.text, html: notice.html });
    if (res.sent) summary.sent += 1;
    const emailStatus = res.sent ? "sent" : res.reason === "no_api_key" ? "logged" : "failed";

    // Stamp the at-risk flag so the advisor list can badge it.
    if (!itin.paymentOverdueAt) {
      await prisma.itinerary.update({ where: { id: itin.id }, data: { paymentOverdueAt: now } }).catch(() => {});
    }

    // Raise an advisor notification (sub-brand scoped). Best-effort.
    const flag = content.buildOverdueAdvisorFlag({
      destination: itin.destination, customerName: contact.name, depositAmount: deposit,
      currency: itin.currency, itineraryId: itin.id,
    });
    const advisors = (usersByTenant[itin.tenantId] || []).filter((u) => userCanAccess(u, itin.subBrand));
    for (const u of advisors) {
      await notificationService
        .notify({
          userId: u.id, tenantId: itin.tenantId, title: flag.title, message: flag.message,
          type: "warning", priority: "high", entityType: "Itinerary", entityId: itin.id,
          link: "/travel/itineraries", category: "travel-payment-overdue", dedupWindowHours: 24,
        })
        .catch((e) => console.error(`[PaymentDeadline] advisor notify failed itin=${itin.id} user=${u.id}: ${e.message}`));
    }

    summary.flagged += 1;
    await prisma.paymentDeadlineNudge
      .update({ where: { id: claim.id }, data: { status: "flagged", subject: notice.subject } })
      .catch(() => {});
    // In-app at-risk notice to the customer's portal bell (best-effort).
    await safeNotifyTravelCustomer({
      contactId: itin.contactId, tenantId: itin.tenantId, type: "payment",
      title: "Deposit overdue — action needed",
      message: `The deposit for your ${itin.destination || "trip"} is past due. Please pay now or contact your advisor to keep your booking.`,
      link: `booking:${itin.id}`,
    });
    console.log(`[PaymentDeadline] OVERDUE itin=${itin.id} dest="${itin.destination}" → ${advisors.length} advisor(s) flagged, customer email ${emailStatus}`);
  }

  if (summary.scanned > 0) {
    console.log(`[PaymentDeadline] tick: scanned=${summary.scanned} reminders=${summary.remindersSent} flagged=${summary.flagged} sent=${summary.sent} skipped=${summary.skipped}`);
  }
  return summary;
}

// Hourly tick (at :37 — offset from the trip-countdown :17 so the two don't
// contend). Day-bucket idempotency means the first tick that sees a new bucket
// sends; later ticks that day are no-ops.
function initPaymentDeadlineCron() {
  cronRegistry.register({
    name: "paymentDeadlineEngine",
    description: "Pay-or-cancel deposit-deadline chase for accepted-unpaid travel bookings (hourly :37)",
    defaultSchedule: "37 * * * *",
    tickFn: runPaymentDeadlineTick,
  }).catch((e) => console.error("[PaymentDeadline] cronRegistry registration failed:", e.message));
}

module.exports = { runPaymentDeadlineTick, initPaymentDeadlineCron, daysToGo, formatDeadline, userCanAccess };
