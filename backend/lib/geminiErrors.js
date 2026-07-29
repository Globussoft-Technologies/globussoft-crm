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
  const err = new Error(GEMINI_LIMIT_EXHAUSTED_MESSAGE);
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
