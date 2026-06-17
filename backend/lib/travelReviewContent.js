// Post-trip review-request email copy for cron/travelReviewEngine.js.
// TEMPLATE-only. {destination} woven in so the ask reads naturally
// ("How was your trip to Bali?"). Links to the public review page.

function interp(str, vars) {
  return String(str)
    .replace(/\{destination\}/g, vars.destination || "your recent trip")
    .replace(/\{name\}/g, vars.customerName || "traveller")
    .replace(/\{url\}/g, vars.reviewUrl || "");
}

const TEMPLATE = {
  subject: "How was your trip to {destination}? 🌍",
  body:
    "Hi {name},\n\nWelcome back! We hope you had a wonderful trip to {destination}. " +
    "We'd love to hear how it went — it takes about a minute and helps us make every " +
    "journey better.\n\nLeave your review here:\n{url}\n\nThank you,\nTeam Travel Stall",
};

// Build the review-request email. Returns { subject, text, html }.
function buildRequestEmail({ destination, customerName, reviewUrl }) {
  const vars = { destination, customerName, reviewUrl };
  const subject = interp(TEMPLATE.subject, vars);
  const text = interp(TEMPLATE.body, vars);
  return { subject, text, html: text.replace(/\n/g, "<br>") };
}

module.exports = { buildRequestEmail, TEMPLATE };
