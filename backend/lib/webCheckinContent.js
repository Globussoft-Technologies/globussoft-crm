// Web check-in reminder EMAIL copy for cron/webCheckinEngine.js.
//
// This is the CUSTOMER-FACING email layer that complements the existing
// cron/webCheckinScheduler.js (which owns the WebCheckin status lifecycle +
// the WhatsApp nudge + agent fallback). Both read the same WebCheckin rows —
// single source of truth. These emails fire 3 times, 12h apart, before the
// flight's `departureAt`: T-36h (heads-up), T-24h (check-in open), T-12h (last
// call). Each links to the customer portal, where "Yes, I've checked in" flips
// the WebCheckin row(s) to `done` so BOTH this engine and the scheduler stop.
//
// TEMPLATE-only (no LLM): web check-in is procedural; wording must be clear and
// consistent. Counts down from the flight's real `departureAt`.

// Hour milestones before `departureAt` that fire a reminder. Disjoint 12h
// windows: 36 → (24,36], 24 → (12,24], 12 → (0,12].
const MILESTONES = [36, 24, 12];

function milestoneTag(hours) {
  return `h${hours}`;
}

// Which milestone (if any) the given hours-to-departure falls into. Returns the
// milestone number (36/24/12) or null when outside every window.
function dueMilestone(hoursToGo) {
  for (const m of MILESTONES) {
    if (hoursToGo <= m && hoursToGo > m - 12) return m;
  }
  return null;
}

function flightLabel({ airlineCode, flightNumber }) {
  const code = [airlineCode, flightNumber].filter(Boolean).join(" ").trim();
  return code || "your flight";
}

const TEMPLATES = {
  36: {
    subject: "Web check-in for {flight} opens soon ✈️",
    body: "Hi {name},\n\nYour flight {flight} (PNR {pnr}) departs in about 36 hours. Online web check-in usually opens 24 hours before departure — keep your passport/ID handy.\n\nOnce you've checked in with the airline, open your portal and tap \"Yes, I've checked in\" so we can stop reminding you:\n{portalUrl}\n\nSafe travels,\nTeam Travel Stall",
  },
  24: {
    subject: "Web check-in is open for {flight}",
    body: "Hi {name},\n\nWeb check-in for {flight} (PNR {pnr}) should now be open. Please check in online, choose your seats, and save your boarding pass.\n\nAlready done it? Confirm in your portal so we stop the reminders:\n{portalUrl}\n\nTeam Travel Stall",
  },
  12: {
    subject: "Last reminder: web check-in for {flight}",
    body: "Hi {name},\n\nThis is your final reminder to complete web check-in for {flight} (PNR {pnr}) before you head to the airport — it only takes a couple of minutes online.\n\nWhen you're done, mark it in your portal to stop these reminders:\n{portalUrl}\n\nHave a wonderful trip,\nTeam Travel Stall",
  },
};

function interpolate(str, vars) {
  return String(str)
    .replace(/\{name\}/g, vars.passengerName || "traveller")
    .replace(/\{flight\}/g, vars.flight || "your flight")
    .replace(/\{pnr\}/g, vars.pnr || "—")
    .replace(/\{portalUrl\}/g, vars.portalUrl || "your customer portal");
}

// Build the reminder email for a given milestone from a WebCheckin row's
// fields. Returns { subject, text, html }.
function buildReminder({ passengerName, airlineCode, flightNumber, pnr, milestone, portalUrl }) {
  const tpl = TEMPLATES[milestone] || TEMPLATES[12];
  const vars = { passengerName, flight: flightLabel({ airlineCode, flightNumber }), pnr, portalUrl };
  const subject = interpolate(tpl.subject, vars);
  const text = interpolate(tpl.body, vars);
  return { subject, text, html: text.replace(/\n/g, "<br>") };
}

module.exports = { MILESTONES, milestoneTag, dueMilestone, flightLabel, buildReminder, TEMPLATES };
