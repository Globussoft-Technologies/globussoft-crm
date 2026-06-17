// Travel CRM — web check-in reminder EMAIL engine (2026-06-16 feature).
//
// The CUSTOMER-FACING email layer on top of the existing WebCheckin system
// (cron/webCheckinScheduler.js owns the status lifecycle + WhatsApp nudge +
// agent fallback; routes/travel_webcheckin.js the CRUD/queue). This engine
// does NOT create its own rows — it reads the SAME WebCheckin rows (one per
// flight, fanned out on itinerary accept) and emails the passenger 3 times,
// 12h apart, before the flight's real `departureAt`:
//
//   T-36h  heads-up (check-in opens ~24h out)
//   T-24h  check-in is open now
//   T-12h  last reminder
//
// Each email links to the customer portal, where "Yes, I've checked in" flips
// the WebCheckin row(s) to status `done` → this engine skips done rows AND the
// scheduler stops escalating, so one confirm silences everything.
//
// Scope: only WebCheckin rows whose PARENT itinerary is PAID
// (advance_paid/fully_paid) and non-Visa-Sure (per the 2026-06-16 product
// call). Idempotency: WebCheckin.emailRemindersJson holds the milestone tags
// already emailed (["h36","h24",...]).
//
// Travel-only: WebCheckin rows exist only in the travel vertical, so this
// no-ops for wellness/generic tenants.

const cron = require("node-cron");
const prisma = require("../lib/prisma");
const emailSender = require("../lib/emailSender");
const content = require("../lib/webCheckinContent");

const { MILESTONES, milestoneTag, dueMilestone } = content;
const PAID_STATUSES = ["advance_paid", "fully_paid"];
const ACTIVE_WC_STATUSES = ["pending", "reminded"]; // skip done/in-progress/fallback-agent/failed
const HORIZON_HOURS = Math.max(...MILESTONES) + 1; // 37h scan window upper bound
const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";
const PORTAL_URL = `${PORTAL_BASE}/travel/portal`;

function parseSent(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// One pass. `now` is injectable for tests. Returns a summary for observability.
async function runWebCheckinTick(now = new Date()) {
  const horizon = new Date(now.getTime() + HORIZON_HOURS * 3600000);

  const rows = await prisma.webCheckin.findMany({
    where: {
      status: { in: ACTIVE_WC_STATUSES },
      departureAt: { gte: now, lte: horizon },
      itineraryId: { not: null },
    },
    select: {
      id: true, tenantId: true, itineraryId: true, contactId: true,
      pnr: true, airlineCode: true, flightNumber: true, passengerName: true,
      departureAt: true, emailRemindersJson: true,
    },
  });

  // Batch-fetch parent itineraries for the paid + non-visasure gate.
  const itinIds = [...new Set(rows.map((r) => r.itineraryId).filter(Boolean))];
  const itins = itinIds.length
    ? await prisma.itinerary.findMany({ where: { id: { in: itinIds } }, select: { id: true, status: true, subBrand: true } })
    : [];
  const itinById = Object.fromEntries(itins.map((i) => [i.id, i]));

  // Batch-fetch contact emails.
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter(Boolean))];
  const contacts = contactIds.length
    ? await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true, email: true } })
    : [];
  const contactById = Object.fromEntries(contacts.map((c) => [c.id, c]));

  const summary = { scanned: rows.length, fired: 0, sent: 0, skipped: 0 };

  for (const row of rows) {
    const itin = itinById[row.itineraryId];
    // Gate: parent itinerary must be PAID + non-Visa-Sure.
    if (!itin || !PAID_STATUSES.includes(itin.status) || itin.subBrand === "visasure") { summary.skipped += 1; continue; }

    const hoursToGo = (new Date(row.departureAt).getTime() - now.getTime()) / 3600000;
    const milestone = dueMilestone(hoursToGo);
    if (milestone == null) { summary.skipped += 1; continue; }

    const tag = milestoneTag(milestone);
    const already = parseSent(row.emailRemindersJson);
    if (already.includes(tag)) { summary.skipped += 1; continue; } // idempotent

    const contact = row.contactId ? contactById[row.contactId] : null;
    const to = (contact && contact.email) || null;
    if (!to) { summary.skipped += 1; continue; }

    summary.fired += 1;
    const mail = content.buildReminder({
      passengerName: row.passengerName || (contact && contact.name),
      airlineCode: row.airlineCode,
      flightNumber: row.flightNumber,
      pnr: row.pnr,
      milestone,
      portalUrl: PORTAL_URL,
    });
    const res = await emailSender.sendEmail({ to, subject: mail.subject, text: mail.text, html: mail.html });
    if (res.sent) summary.sent += 1;
    // Record the milestone as sent regardless of delivery outcome (logged/sent)
    // so a re-tick doesn't retry a no-key send forever. A hard failure is rare
    // and acceptable to drop — the next milestone still fires.
    const next = [...already, tag];
    await prisma.webCheckin.update({ where: { id: row.id }, data: { emailRemindersJson: JSON.stringify(next) } }).catch(() => {});
    const status = res.sent ? "sent" : res.reason === "no_api_key" ? "logged" : "failed";
    console.log(`[WebCheckinEmail] checkin=${row.id} ${row.airlineCode} ${row.flightNumber} ${tag} → ${status}`);
  }

  if (summary.scanned > 0) {
    console.log(`[WebCheckinEmail] tick: scanned=${summary.scanned} fired=${summary.fired} sent=${summary.sent} skipped=${summary.skipped}`);
  }
  return summary;
}

// Hourly tick (at :47 — offset from trip-countdown :17, payment-deadline :37,
// and the existing webCheckinScheduler's :13/:28/:43/:58). The 12h milestone
// windows mean an hourly tick reliably fires each of T-36/24/12h once.
function initWebCheckinCron() {
  cron.schedule("47 * * * *", () => {
    runWebCheckinTick().catch((e) => console.error("[WebCheckinEmail] tick error:", e.message));
  });
  console.log("[WebCheckinEmail] cron scheduled (hourly :47)");
}

module.exports = { runWebCheckinTick, initWebCheckinCron, PAID_STATUSES };
