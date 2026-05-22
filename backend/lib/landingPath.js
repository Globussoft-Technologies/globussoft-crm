/**
 * Validation + normalisation for Role.landingPath values.
 *
 * Restricts the field to in-app SPA routes (relative paths starting with a
 * single `/`). Blocks protocols, host overrides, whitespace, quotes, angle
 * brackets, and protocol-relative paths (`//evil.com/...`). This is the
 * server-side guard against the "admin with roles.manage redirects every
 * user-with-this-role to an attacker host on login" attack.
 *
 * Mirrored client-side in frontend/src/pages/RolesAdmin.jsx
 * (validateLandingPathClient) for faster feedback, but the server is
 * authoritative.
 */

const ALLOWED_PATH_RE = /^\/[A-Za-z0-9_\-/?=&.,%:]*$/;
const MAX_LANDING_PATH = 200;

/**
 * Validate a landingPath candidate.
 * @param {unknown} value
 * @returns {string|null} validation error message, or null if value is OK
 *   (including the empty / null case — both mean "use vertical default")
 */
function validateLandingPath(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return "landingPath must be a string";
  if (value.length > MAX_LANDING_PATH) {
    return `landingPath is too long (max ${MAX_LANDING_PATH} chars)`;
  }
  if (!ALLOWED_PATH_RE.test(value)) {
    return "landingPath must be a relative SPA path (e.g. /home, /wellness/calendar)";
  }
  if (value.startsWith("//")) return "landingPath cannot start with //"; // protocol-relative
  return null;
}

/**
 * Normalise a landingPath for storage. Trims surrounding whitespace and
 * coerces empty / null / undefined to null so the DB column is consistent.
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeLandingPath(value) {
  if (value === undefined || value === null || value === "") return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

module.exports = { validateLandingPath, normalizeLandingPath };
