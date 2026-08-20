"use strict";

const SCI_NOTATION_RE = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/;

function expandScientificNotation(value) {
  const text = String(value).trim();
  const match = text.match(SCI_NOTATION_RE);
  if (!match) return text;

  const [, sign, whole, fraction = "", exponentText] = match;
  const exponent = Number(exponentText);
  if (!Number.isFinite(exponent) || exponent < 0) return text;

  const digits = `${whole}${fraction}`.replace(/^0+/, "") || "0";
  const shift = exponent - fraction.length;
  if (shift < 0) return text;

  return `${sign === "-" ? "-" : ""}${digits}${"0".repeat(shift)}`;
}

function normalizePhoneValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  if (typeof value !== "string") {
    return String(value).trim();
  }

  const trimmed = value.trim();
  if (!trimmed) return "";
  return SCI_NOTATION_RE.test(trimmed) ? expandScientificNotation(trimmed) : trimmed;
}

module.exports = {
  expandScientificNotation,
  normalizePhoneValue,
};
