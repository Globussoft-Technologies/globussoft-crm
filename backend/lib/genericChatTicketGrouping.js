const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "can", "could", "do", "does", "for", "how", "i", "is", "it",
  "me", "much", "of", "on", "please", "the", "to", "we", "what", "when", "where", "which", "who", "why", "you",
]);

const GROUPS = [
  ["pricing", ["price", "pricing", "cost", "plan", "plans", "billing", "subscription", "fee"]],
  ["demo", ["demo", "trial", "started", "start", "signup", "sign-up", "register"]],
  ["security", ["security", "sso", "scim", "permission", "permissions", "role", "roles", "2fa", "two-factor"]],
  ["communication", ["email", "sms", "whatsapp", "call", "calling", "voice", "notification"]],
  ["automation", ["automation", "automate", "workflow", "workflows", "sequence", "sequences", "follow-up"]],
  ["integration", ["integration", "integrate", "api", "webhook", "zapier", "salesforce", "hubspot"]],
  ["reporting", ["report", "reports", "analytics", "dashboard", "metric", "metrics"]],
  ["support", ["error", "bug", "issue", "broken", "failed", "failure", "failing", "login", "not-working", "problem"]],
];

function getQuestionGroupKey(question) {
  const words = String(question || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word));
  const matchedEntries = GROUPS.filter(([, terms]) => terms.some((term) => words.includes(term)));
  const matchedGroups = matchedEntries.map(([name]) => name);
  if (matchedGroups.length) {
    // Once a recognized business category is present, use the category as
    // the stable key. Extra wording such as "CRM", "does", or "support"
    // should not split equivalent questions into separate tickets.
    return `topic:${matchedGroups.join("+")}`;
  }

  // Keep uncategorized questions separate, but normalize repeated wording so
  // the same general question asked in a different sentence still groups.
  const normalizedWords = [...new Set(words)].slice(0, 6);
  return `general:${normalizedWords.join("-") || "question"}`;
}

module.exports = { getQuestionGroupKey };
