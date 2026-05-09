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

function ensureStringLength(value, { max, min = 0, field, code, required = false, trim = true } = {}) {
  // #337: when `trim` is true (the default for required string fields),
  // a value of all-whitespace ("   ") is treated as empty for both the
  // required check and the min-length check. The value is NOT mutated —
  // routes are expected to also call .trim() before persisting if they
  // want the saved value normalised; this validator only enforces "is
  // there meaningful content".
  if (value == null || value === "") {
    return required
      ? { status: 400, error: `${field} is required`, code: code || `${field.toUpperCase()}_REQUIRED` }
      : null;
  }
  if (typeof value !== "string") {
    return { status: 400, error: `${field} must be a string`, code: code || `${field.toUpperCase()}_INVALID` };
  }
  const effective = trim ? value.trim() : value;
  if (required && effective.length === 0) {
    return { status: 400, error: `${field} is required`, code: code || `${field.toUpperCase()}_REQUIRED` };
  }
  if (effective.length < min) {
    return { status: 400, error: `${field} must be at least ${min} characters`, code: code || `${field.toUpperCase()}_TOO_SHORT` };
  }
  if (typeof max === "number" && value.length > max) {
    return { status: 400, error: `${field} must be at most ${max} characters`, code: code || `${field.toUpperCase()}_TOO_LONG` };
  }
  return null;
}

// PRD Gap §1.1c — Indian GSTIN validator. Canonical 15-char format:
//   2 digits state code  | 5 letters PAN-prefix | 4 digits PAN-mid |
//   1 letter PAN-suffix  | 1 digit entity-num   | 1 literal "Z"    |
//   1 alphanumeric checksum
// Example valid: `29ABCDE1234F1Z5`. Stored verbatim once validated.
const GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9][Z][0-9A-Z]$/;
function isValidGstOrEmpty(g) {
  if (g == null || g === "") return true;
  if (typeof g !== "string") return false;
  return GST_RE.test(g);
}
function ensureGst(g, { required = false } = {}) {
  if (g == null || g === "") {
    return required
      ? { status: 400, error: "gst is required", code: "GST_REQUIRED" }
      : null;
  }
  return isValidGstOrEmpty(g)
    ? null
    : { status: 400, error: "gst must be a valid 15-character GSTIN (e.g. 29ABCDE1234F1Z5)", code: "INVALID_GST" };
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

// #165: turn Prisma validation-class errors and our own thrown validation
// errors into clean 400 responses. Pre-fix the catch-blocks in routes mapped
// every Prisma exception to a generic 500 + "Failed to create X", which
// (a) hid the real validation message from the UI and (b) lit up Sentry's
// 500 channel with what are actually 4xx user errors.
//
// Returns null when the error is genuinely unexpected (DB down, OOM, code
// bug) — those should still propagate as 500.
//
// Covered Prisma codes:
//   P2000 — value too long for column
//   P2003 — foreign-key constraint failed
//   P2005 — invalid value for field type
//   P2006 — provided value not valid
//   P2007 — data validation error
//   P2011 — null constraint violation
//   P2012 — missing required value
//   P2013 — missing required argument
//   P2019 — input error
//   P2020 — value out of range for type
//   P2025 — record to update/delete not found  (treat as 404)
// Plus PrismaClientValidationError (which sets `name`, not `code`).
//
// #556 (HI-07): pre-this-fix the validation-class branch passed
// `e.message.split("\n").pop()` straight into the response. Prisma's
// stringified errors look like:
//
//   Invalid `prisma.contact.create()` invocation:
//   The provided value for the column is too long for the column's type. Column: title
//
// — the last line ("Column: title") leaked the schema column name to any
// caller submitting a too-long input. Pen-test #556 surfaced this on the
// /leads Create form. The fix: stable per-prismaCode generic messages,
// optional `field` extracted from `meta.target` / `meta.column_name` /
// `meta.field_name` (Prisma exposes these structured), but never the raw
// stringified message. The full error is still console.error'd by the
// route's catch block for server-side log diagnosis.
const PRISMA_VALIDATION_MESSAGES = {
  P2000: "Value too long for one of the fields",
  P2003: "Referenced record does not exist",
  P2005: "Invalid value for one of the fields",
  P2006: "Invalid value for one of the fields",
  P2007: "Data validation failed",
  P2011: "A required field is missing",
  P2012: "A required field is missing",
  P2013: "A required argument is missing",
  P2019: "Input value is not valid",
  P2020: "Value out of range for one of the fields",
};
function extractFieldFromPrismaMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  // Prisma populates one of these depending on the error class. Field name
  // alone (without "Column:" prefix and without table-qualified syntax) is
  // safe to surface — the SPA needs it to highlight the right input. The
  // pen-test was specifically about the prefix tokens "Column: " and
  // "Table: " leaking, not the field identifier itself.
  const candidate = meta.field_name || meta.column_name || meta.target;
  if (!candidate) return null;
  if (Array.isArray(candidate)) return candidate.join(",");
  if (typeof candidate !== "string") return null;
  // Strip any "Table.column" qualifier → just the column name.
  const tail = candidate.split(".").pop();
  return tail || null;
}

function httpFromPrismaError(e) {
  if (!e) return null;
  // Re-use the unique-constraint handler so callers only need one helper.
  const conflict = conflictFromPrisma(e);
  if (conflict) return conflict;

  // Our own helper-style errors get propagated through unchanged. Helpers
  // return objects shaped {status, error, code} — if a route happens to
  // throw one (uncommon but legal), surface it directly.
  if (typeof e === "object" && e.status && e.code && typeof e.error === "string") {
    return e;
  }

  if (e.code === "P2025") {
    // P2025's meta.cause is Prisma-authored (e.g. "Record to delete does
    // not exist") and doesn't contain raw column / table names — safe to
    // surface, falls back to a generic message otherwise.
    return {
      status: 404,
      error: e.meta?.cause || "Record not found",
      code: "NOT_FOUND",
    };
  }
  if (PRISMA_VALIDATION_MESSAGES[e.code]) {
    const out = {
      status: 400,
      error: PRISMA_VALIDATION_MESSAGES[e.code],
      code: "INVALID_INPUT",
      prismaCode: e.code,
    };
    const field = extractFieldFromPrismaMeta(e.meta);
    if (field) out.field = field;
    return out;
  }
  // Prisma's validation wrapper (bad shape, wrong type) sets `name` only.
  if (e.name === "PrismaClientValidationError") {
    return {
      status: 400,
      error: "Invalid input shape for this resource",
      code: "INVALID_INPUT",
    };
  }
  return null;
}

module.exports = {
  EMAIL_RE,
  GST_RE,
  ensurePhone,
  ensureEmail,
  ensureGst,
  ensureNumberInRange,
  ensureEnum,
  ensureDateInRange,
  ensureDob,
  ensureVisitDate,
  ensureStringLength,
  ensureEmailList,
  conflictFromPrisma,
  httpFromPrismaError,
  isValidEmailOrEmpty,
  isValidPhoneOrEmpty,
  isValidGstOrEmpty,
};
