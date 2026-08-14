"use strict";

const GEMINI_LIMIT_EXHAUSTED_CODE = "GEMINI_LIMIT_EXHAUSTED";
const GEMINI_LIMIT_EXHAUSTED_MESSAGE =
  "Gemini limit has been exhausted. Please try again later.";

function normaliseErrorMessage(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return String(err.message || err.error || err.statusText || "");
}

function isGeminiLimitError(err) {
  // aiGateway.js centrally detects a provider quota/rate-limit failure and
  // rewrites it into a friendly AI_PROVIDER_RATE_LIMITED error with a
  // clear, BYOK-vs-CRM-managed-aware message (see lib/aiGateway.js's
  // friendlyProviderErrorOrNull). That rewritten message no longer matches
  // the raw-provider-text patterns below, so check the code first —
  // every aiGateway-routed call site's existing isGeminiLimitError check
  // keeps working without per-call-site changes.
  if (err && err.code === "AI_PROVIDER_RATE_LIMITED") return true;
  const msg = normaliseErrorMessage(err).toLowerCase();
  if (!msg) return false;
  return (
    /(?:^|\b)429(?:\b|$)/.test(msg) ||
    /too many requests/.test(msg) ||
    /quota exceeded/.test(msg) ||
    /exceeded.*quota/.test(msg) ||
    /resource[_ -]?exhausted/.test(msg) ||
    /rate limit/.test(msg) ||
    /limit has been exhausted/.test(msg) ||
    /try again later/.test(msg)
  );
}

function buildGeminiLimitError(cause) {
  // Preserve aiGateway.js's BYOK-vs-CRM-managed-specific wording when the
  // cause already carries one (AI_PROVIDER_RATE_LIMITED); fall back to the
  // generic message for raw provider errors from non-gateway call sites.
  const message = cause && cause.code === "AI_PROVIDER_RATE_LIMITED" && cause.message
    ? cause.message
    : GEMINI_LIMIT_EXHAUSTED_MESSAGE;
  const err = new Error(message);
  err.code = GEMINI_LIMIT_EXHAUSTED_CODE;
  err.status = 429;
  if (cause !== undefined) err.cause = cause;
  return err;
}

function formatGeminiLimitMessage(err) {
  return isGeminiLimitError(err) ? GEMINI_LIMIT_EXHAUSTED_MESSAGE : null;
}

module.exports = {
  GEMINI_LIMIT_EXHAUSTED_CODE,
  GEMINI_LIMIT_EXHAUSTED_MESSAGE,
  isGeminiLimitError,
  buildGeminiLimitError,
  formatGeminiLimitMessage,
};
