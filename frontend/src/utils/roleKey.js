/**
 * roleKey.js — frontend mirror of backend/lib/roleKey.js.
 *
 * The frontend cannot `require` the backend module, so the regex +
 * helper text + validator are duplicated here verbatim. There is a
 * vitest at backend/test/lib/roleKey.test.js that pins the regex
 * string — when you change the rule, update both files in the same
 * commit and confirm the test still passes.
 *
 * Used by:
 *   • frontend/src/pages/RolesAdmin.jsx CreateRoleModal (Bug 6 fix —
 *     helper text + validator + blur validation all read from here)
 *
 * Why the mirror instead of a shared package:
 *   the codebase does not have a shared utility package between
 *   backend + frontend. The two files are < 30 lines and the regression
 *   test pins drift; the cost of adding a shared package would exceed
 *   the cost of maintaining the mirror.
 */

export const ROLE_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/;

export const ROLE_KEY_DESCRIPTION =
  'Uppercase A-Z, digits 0-9, and underscores. Must start with a letter.';

export const ROLE_KEY_MAX_LENGTH = 64;

/**
 * Validate a role key. Returns null on success, or a human-readable
 * error string the form can surface verbatim. Mirrors backend
 * validateRoleKey character-for-character.
 */
export function validateRoleKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return 'Role key is required';
  }
  const trimmed = value.trim();
  if (trimmed.length > ROLE_KEY_MAX_LENGTH) {
    return `Role key is too long (max ${ROLE_KEY_MAX_LENGTH} chars)`;
  }
  if (!ROLE_KEY_REGEX.test(trimmed)) {
    return 'Role key must start with letter and contain only A-Z, 0-9, _';
  }
  return null;
}
