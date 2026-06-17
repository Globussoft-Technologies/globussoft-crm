/**
 * roleKey.js — single source of truth for Role.key validation.
 *
 * Pre-2026-06-16 the regex `^[A-Z][A-Z0-9_]*$` was duplicated inline at
 * backend/routes/roles.js (CREATE handler) and frontend/src/pages/RolesAdmin.jsx
 * (CreateRoleModal client validate). The frontend helper text read
 * "Uppercase + underscores only" — which didn't mention the
 * "must-start-with-a-letter" requirement, so an admin who typed
 * `1ADMIN` got "Required" on the field and was told (by the helper
 * text) the input was fine. Bug 6 in the QA punch-list.
 *
 * Both layers now import from here so:
 *   • the regex itself lives in one place,
 *   • the human-readable rule string matches the regex character-for-character,
 *   • added tests on this file guard against drift.
 *
 * Frontend mirror: frontend/src/utils/roleKey.js holds the same constants
 * (the frontend cannot `require` backend/lib/). The two files MUST stay
 * in lockstep — there is a regression test in
 * backend/test/lib/roleKey.test.js that pins the regex string.
 */

const ROLE_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/;

// Rendered as the form field's helper text AND as the validation error
// message. Keep this phrasing identical between backend + frontend so an
// admin sees the same explanation everywhere.
const ROLE_KEY_DESCRIPTION =
  "Uppercase A-Z, digits 0-9, and underscores. Must start with a letter.";

const ROLE_KEY_MAX_LENGTH = 64;

/**
 * Validate a role key. Returns null on success, or a human-readable
 * error string the form / API can surface verbatim.
 *
 *   validateRoleKey('ADMIN')      → null
 *   validateRoleKey('admin')      → "Role key must start with letter and contain only A-Z, 0-9, _"
 *   validateRoleKey('1ADMIN')     → same
 *   validateRoleKey('A'.repeat(65)) → "Role key is too long (max 64 chars)"
 *
 * Defensive against non-string inputs — callers should normalize first
 * but a stray null shouldn't 500 the route.
 */
function validateRoleKey(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return "Role key is required";
  }
  const trimmed = value.trim();
  if (trimmed.length > ROLE_KEY_MAX_LENGTH) {
    return `Role key is too long (max ${ROLE_KEY_MAX_LENGTH} chars)`;
  }
  if (!ROLE_KEY_REGEX.test(trimmed)) {
    return "Role key must start with letter and contain only A-Z, 0-9, _";
  }
  return null;
}

module.exports = {
  ROLE_KEY_REGEX,
  ROLE_KEY_DESCRIPTION,
  ROLE_KEY_MAX_LENGTH,
  validateRoleKey,
};
