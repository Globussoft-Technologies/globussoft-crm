// Pre-trip "countdown" nudge content for cron/tripCountdownEngine.js.
//
// Cadence (per the 2026-06-16 product call): two early check-ins (T-30, T-14)
// then a DAILY nudge through the final week (T-7 … T-0). Each day has its own
// upbeat, on-theme copy so consecutive emails feel fresh ("keep packing").
//
// Content source: LLM-generated per email (task "trip-countdown") when the
// Q11 keys are present; otherwise the deterministic template library below —
// which already gives distinct copy per day. The LLM path auto-engages once
// keys land (routeRequest returns stub=false).

const llmRouter = require("./llmRouter");

// Which days-to-go fire a nudge. Newest-to-departure last.
const FIRE_DAYS = [30, 14, 7, 6, 5, 4, 3, 2, 1, 0];

function shouldFire(daysToGo) {
  return FIRE_DAYS.includes(daysToGo);
}
function dayTag(daysToGo) {
  return `d${daysToGo}`;
}

// Per-day creative templates. {dest} + {name} are interpolated.
const TEMPLATES = {
  30: {
    subject: "{dest} in 30 days — let the countdown begin! 🌍",
    body: "Hi {name},\n\nYour trip to {dest} is just a month away! Now's a great time to start dreaming up your must-dos and sketch a rough plan. We'll check in along the way.\n\nExcited for you,\nTeam Travel Stall",
  },
  14: {
    subject: "Two weeks to {dest}! 📅",
    body: "Hi {name},\n\n14 days to go! A good moment to confirm your leave, double-check your documents (passport validity, any visas), and start a wishlist of experiences for {dest}.\n\nAlmost there,\nTeam Travel Stall",
  },
  7: {
    subject: "One week to {dest} — time to start packing! 🧳",
    body: "Hi {name},\n\n{dest} is just 7 days away! Kick off your packing list this week — clothes for the weather, comfy shoes, and anything you can't buy there.\n\nCounting down with you,\nTeam Travel Stall",
  },
  6: {
    subject: "6 days to {dest} ✈️",
    body: "Hi {name},\n\nSix days! Quick checks today: passport in date, itinerary printed/saved offline, and any bookings confirmed. Smooth sailing from here.\n\nTeam Travel Stall",
  },
  5: {
    subject: "5 days to go — keep packing! 👕",
    body: "Hi {name},\n\nFive days to {dest}! Lay out your outfits and essentials now so the final days are stress-free. Don't forget the little things — sunscreen, adapters, chargers.\n\nTeam Travel Stall",
  },
  4: {
    subject: "4 days! Pack the easy-to-forget stuff 🔌",
    body: "Hi {name},\n\nFour days out. Today's tip: gather chargers, plug adapters, any medication, and copies of your key documents. Future-you will thank present-you.\n\nTeam Travel Stall",
  },
  3: {
    subject: "3 days to {dest} — confirm the logistics 🏨",
    body: "Hi {name},\n\nThree days! Double-check your airport pickup, hotel check-in time, and the first day's plan for {dest}. Everything lining up nicely.\n\nTeam Travel Stall",
  },
  2: {
    subject: "2 days! Money, maps, and music 💱",
    body: "Hi {name},\n\nTwo days to go! Sort a bit of local currency or a travel card, download offline maps for {dest}, and queue up a playlist for the journey.\n\nTeam Travel Stall",
  },
  1: {
    subject: "Tomorrow's the day! 🎒",
    body: "Hi {name},\n\nYour {dest} adventure begins tomorrow! Final pack, charge your devices, set an alarm, and get a good night's sleep. We can't wait for you.\n\nTeam Travel Stall",
  },
  0: {
    subject: "Bon voyage — have an amazing trip! 🎉",
    body: "Hi {name},\n\nToday's the day — safe travels to {dest}! Soak it all in and make wonderful memories. We're just a message away if you need anything.\n\nWith love,\nTeam Travel Stall",
  },
};

function interpolate(str, { destination, customerName }) {
  return String(str)
    .replace(/\{dest\}/g, destination || "your destination")
    .replace(/\{name\}/g, customerName || "traveller");
}

// Deterministic template nudge — the always-available fallback + the unit-test
// surface. Returns { subject, text, html, llmSourced: false }.
function buildFallbackNudge({ destination, daysToGo, customerName }) {
  const tpl = TEMPLATES[daysToGo] || TEMPLATES[0];
  const subject = interpolate(tpl.subject, { destination, customerName });
  const text = interpolate(tpl.body, { destination, customerName });
  return {
    subject,
    text,
    html: text.replace(/\n/g, "<br>"),
    llmSourced: false,
  };
}

// Try the LLM for fresh, personalised copy; fall back to the template on stub
// mode (no keys), error, or unparseable output. Never throws.
async function buildNudge({ tenantId, destination, daysToGo, customerName }) {
  try {
    const result = await llmRouter.routeRequest({
      task: "trip-countdown",
      tenantId,
      payload: {
        destination,
        daysToGo,
        customerName,
        instruction:
          "Write a short, warm, upbeat pre-trip reminder email as JSON " +
          '{"subject":"...","body":"..."}. One emoji max in the subject. ' +
          "Mention the destination and the days-to-go. Keep the body under 80 words.",
      },
    });
    if (result && !result.stub && result.text) {
      const parsed = JSON.parse(result.text);
      if (parsed && parsed.subject && parsed.body) {
        const subject = interpolate(parsed.subject, { destination, customerName });
        const text = interpolate(parsed.body, { destination, customerName });
        return { subject, text, html: text.replace(/\n/g, "<br>"), llmSourced: true };
      }
    }
  } catch {
    /* fall through to template */
  }
  return buildFallbackNudge({ destination, daysToGo, customerName });
}

module.exports = { FIRE_DAYS, shouldFire, dayTag, buildFallbackNudge, buildNudge, TEMPLATES };
