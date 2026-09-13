import { fetchApi } from "../utils/api";

const ALLOWED_FIELDS = ["eventType", "featureKey", "tourKey", "stepKey", "reason", "sessionId"];

// This boundary intentionally drops every field that could carry record data,
// names, email addresses, search text, URLs or arbitrary UI content.
export function recordOnboardingEvent(event) {
  const body = Object.fromEntries(ALLOWED_FIELDS
    .filter((key) => event?.[key] != null)
    .map((key) => [key, event[key]]));
  return fetchApi("/api/onboarding/events", {
    method: "POST",
    body: JSON.stringify(body),
    silent: true,
  }).catch(() => null);
}
