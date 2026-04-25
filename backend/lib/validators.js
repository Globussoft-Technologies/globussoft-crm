/**
 * Shared input validators used across route files.
 *
 * Every helper returns either `null` (valid) or an error object
 * `{ status: 400, error: "<human msg>", code: "<MACHINE_CODE>" }` that
 * the caller can send directly:
 *
 *   const err = ensureEmail(email);
 *   if (err) return res.status(err.status).json(err);
 *
 * Keeping the shape consistent across routes makes the API contract
 * uniform for the frontend (#165: stop returning 500 on bad input).
 */

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

// Phone validation — same rule as wellness.js / external.js use today:
// 10–15 digits after stripping +, -, spaces, parens.
function isValidPhoneOrEmpty(p) {
  if (p == null || p === "") return true;
  if (typeof p !== "string") return false;
  const digits = p.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}
function ensurePhone(p) {
  return isValidPhoneOrEmpty(p)
    ? null
    : { status: 400, error: "phone must contain 10–15 digits", code: "INVALID_PHONE" };
}

function isValidEmailOrEmpty(e) {
  if (e == null || e === "") return true;
  return typeof e === "string" && EMAIL_RE.test(e);
}
function ensureEmail(e, { required = false } = {}) {
  if (e == null || e === "") {
    return required
      ? { status: 400, error: "email is required", code: "EMAIL_REQUIRED" }
      : null;
  }
  return isValidEmailOrEmpty(e)
    ? null
    : { status: 400, error: "email is not a valid address", code: "INVALID_EMAIL" };
}

// Numeric range. Accepts undefined/null/empty as "skip" unless required=true.
function ensureNumberInRange(value, { min, max, field, code, required = false } = {}) {
  if (value == null || value === "") {
    return required
      ? { status: 400, error: `${field} is required`, code: code || `${field.toUpperCase()}_REQUIRED` }
      : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { status: 400, error: `${field} must be a number`, code: code || `INVALID_${field.toUpperCase()}` };
  }
  if (typeof min === "number" && n < min) {
    return { status: 400, error: `${field} must be ≥ ${min}`, code: code || `${field.toUpperCase()}_TOO_LOW` };
  }
  if (typeof max === "number" && n > max) {
    return { status: 400, error: `${field} must be ≤ ${max}`, code: code || `${field.toUpperCase()}_TOO_HIGH` };
  }
  return null;
}

// Enum check. Accepts undefined/null/empty as "skip" unless required=true.
function ensureEnum(value, allowed, { field, code, required = false } = {}) {
  if (value == null || value === "") {
    return required
      ? { status: 400, error: `${field} is required`, code: code || `${field.toUpperCase()}_REQUIRED` }
      : null;
  }
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  if (!set.has(value)) {
    return {
      status: 400,
      error: `${field} must be one of: ${[...set].join(", ")}`,
      code: code || `INVALID_${field.toUpperCase()}`,
    };
  }
  return null;
}

// Date validation. Returns null if valid (or empty + not required), else a 400.
// Pass minYear/maxYear (or use the convenience reasonablePastDate / reasonableFutureDate).
function ensureDateInRange(value, { minYear, maxYear, field, code, required = false } = {}) {
  if (value == null || value === "") {
    return required
      ? { status: 400, error: `${field} is required`, code: code || `${field.toUpperCase()}_REQUIRED` }
      : null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return { status: 400, error: `${field} is not a valid date`, code: code || `INVALID_${field.toUpperCase()}` };
  }
  const y = d.getUTCFullYear();
  if (typeof minYear === "number" && y < minYear) {
    return { status: 400, error: `${field} must be on or after ${minYear}-01-01`, code: code || `${field.toUpperCase()}_TOO_OLD` };
  }
  if (typeof maxYear === "number" && y > maxYear) {
    return { status: 400, error: `${field} must be on or before ${maxYear}-12-31`, code: code || `${field.toUpperCase()}_TOO_FUTURE` };
  }
  return null;
}

// "Date of birth" — must be in [1900, today].
function ensureDob(value, { required = false } = {}) {
  if (value == null || value === "") {
    return required
      ? { status: 400, error: "dob is required", code: "DOB_REQUIRED" }
      : null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return { status: 400, error: "dob is not a valid date", code: "INVALID_DOB" };
  }
  const y = d.getUTCFullYear();
  const todayY = new Date().getUTCFullYear();
  if (y < 1900) return { status: 400, error: "dob must be after 1900", code: "DOB_OUT_OF_RANGE" };
  if (d.getTime() > Date.now()) return { status: 400, error: "dob cannot be in the future", code: "DOB_OUT_OF_RANGE" };
  // Defensive: y > todayY shouldn't happen given the future check, but cheap.
  if (y > todayY) return { status: 400, error: "dob cannot be in the future", code: "DOB_OUT_OF_RANGE" };
  return null;
}

// Visit-style date — must be within [now - 5y, now + 1y]. Tighter than DOB.
function ensureVisitDate(value, { required = false } = {}) {
  if (value == null || value === "") {
    return required
      ? { status: 400, error: "visitDate is required", code: "VISIT_DATE_REQUIRED" }
      : null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return { status: 400, error: "visitDate is not a valid date", code: "VISIT_DATE_INVALID" };
  }
  const now = Date.now();
  const fiveYearsAgo = now - 5 * 365 * 86400_000;
  const oneYearAhead = now + 365 * 86400_000;
  if (d.getTime() < fiveYearsAgo || d.getTime() > oneYearAhead) {
    return { status: 400, error: "visitDate must be within the last 5 years and next 1 year", code: "VISIT_DATE_OUT_OF_RANGE" };
  }
  return null;
}

function ensureStringLength(value, { max, min = 0, field, code, required = false } = {}) {
  if (value == null || value === "") {
    return required
      ? { status: 400, error: `${field} is required`, code: code || `${field.toUpperCase()}_REQUIRED` }
      : null;
  }
  if (typeof value !== "string") {
    return { status: 400, error: `${field} must be a string`, code: code || `${field.toUpperCase()}_INVALID` };
  }
  if (value.length < min) {
    return { status: 400, error: `${field} must be at least ${min} characters`, code: code || `${field.toUpperCase()}_TOO_SHORT` };
  }
  if (typeof max === "number" && value.length > max) {
    return { status: 400, error: `${field} must be at most ${max} characters`, code: code || `${field.toUpperCase()}_TOO_LONG` };
  }
  return null;
}

// Validates an array of email recipients (strings).
function ensureEmailList(list, { field = "recipients", min = 1, max = 50 } = {}) {
  if (!Array.isArray(list)) {
    return { status: 400, error: `${field} must be an array`, code: "RECIPIENTS_INVALID" };
  }
  if (list.length < min) {
    return { status: 400, error: `${field} must have at least ${min} entry`, code: "RECIPIENTS_REQUIRED" };
  }
  if (list.length > max) {
    return { status: 400, error: `${field} cannot exceed ${max} entries`, code: "RECIPIENTS_TOO_MANY" };
  }
  const bad = list.map((r) => String(r).trim()).filter((r) => !EMAIL_RE.test(r));
  if (bad.length) {
    return { status: 400, error: `Invalid email address(es): ${bad.join(", ")}`, code: "INVALID_RECIPIENT" };
  }
  return null;
}

// Wraps Prisma P2002 (unique constraint) into a clean 409 response.
// Usage:  catch (e) { const c = conflictFromPrisma(e); if (c) return res.status(c.status).json(c); ... }
function conflictFromPrisma(e) {
  if (e && e.code === "P2002") {
    const target = Array.isArray(e.meta?.target) ? e.meta.target.join("+") : (e.meta?.target || "field");
    return {
      status: 409,
      error: `Duplicate value for ${target}`,
      code: "UNIQUE_CONSTRAINT",
      field: target,
    };
  }
  return null;
}

module.exports = {
  EMAIL_RE,
  ensurePhone,
  ensureEmail,
  ensureNumberInRange,
  ensureEnum,
  ensureDateInRange,
  ensureDob,
  ensureVisitDate,
  ensureStringLength,
  ensureEmailList,
  conflictFromPrisma,
  isValidEmailOrEmpty,
  isValidPhoneOrEmpty,
};
