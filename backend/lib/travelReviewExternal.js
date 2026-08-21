const { KEYS, getSetting } = require("./tenantSettings");
const { analyzeMessageDetailed } = require("../cron/sentimentEngine");

const POSITIVE_MESSAGE = "We're so glad you had a great experience! Would you mind sharing this review on your review page? It really helps us.";

function normalizeUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch (_err) {
    return null;
  }
}

function pushLine(lines, label, value) {
  const clean = String(value || "").trim();
  if (clean) lines.push(`${label}: ${clean}`);
}

function buildAnalysisText({ destination, overallRating, answers }) {
  const a = answers || {};
  const lines = [`Trip destination: ${destination || "your trip"}`];
  if (typeof overallRating === "number") lines.push(`Overall rating: ${overallRating}/5`);
  pushLine(lines, "Accommodation", a.rate_accommodation);
  pushLine(lines, "Transportation", a.rate_transport);
  pushLine(lines, "Activities", a.rate_activities);
  pushLine(lines, "Support", a.rate_support);
  pushLine(lines, "Value", a.rate_value);
  pushLine(lines, "Would recommend", a.recommend);
  pushLine(lines, "Would book again", a.rebook);
  pushLine(lines, "Loved most", a.loved_most);
  pushLine(lines, "Could do better", a.improve);
  pushLine(lines, "Memorable moment", a.highlight);
  return lines.join("\n");
}

function buildSuggestedReview({ destination, answers }) {
  const a = answers || {};
  const parts = [];
  if (a.loved_most) parts.push(String(a.loved_most).trim());
  if (a.highlight) parts.push(String(a.highlight).trim());
  const summary = parts.filter(Boolean).join(" ");
  if (summary) return summary;
  if (destination) return `I had a great experience on my ${destination} trip.`;
  return "I had a great experience and wanted to share my feedback.";
}

async function buildExternalReviewCta({ tenantId, destination, overallRating, answers }) {
  const configuredUrl = normalizeUrl(
    await getSetting(tenantId, KEYS.TRAVEL_EXTERNAL_REVIEW_URL, {
      coerce: (value) => String(value || ""),
      fallback: "",
    }),
  );
  if (!configuredUrl) return null;

  const analysis = await analyzeMessageDetailed(
    buildAnalysisText({ destination, overallRating, answers }),
  );

  if (!analysis || !analysis.trusted || analysis.usedFallback) return null;

  const positive = analysis.sentiment === "positive" && Number(analysis.sentimentScore) >= 0.35;
  if (!positive) return null;

  return {
    enabled: true,
    url: configuredUrl,
    label: "Post to Google",
    message: POSITIVE_MESSAGE,
    suggestedReview: buildSuggestedReview({ destination, answers }),
    analysis: {
      sentiment: analysis.sentiment,
      sentimentScore: analysis.sentimentScore,
      provider: analysis.provider,
      trusted: analysis.trusted,
    },
  };
}

module.exports = {
  buildExternalReviewCta,
  buildAnalysisText,
  buildSuggestedReview,
  normalizeUrl,
};
