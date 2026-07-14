/**
 * Centralized JWT secret resolution.
 *
 * P1.3 from docs/AUDIT_2026-05-17_code.md — the dev-fallback secret
 * constant was duplicated verbatim across 6 source files
 * (middleware/auth.js + routes/{auth,auth_2fa,portal,sso,wellness}.js).
 * One definition here means one place to rotate / reason about, and one
 * place gitleaks has to allowlist.
 *
 * Production MUST set JWT_SECRET — server.js refuses to boot without it.
 * The fallback below is dev-compat only; it is documented in CLAUDE.md
 * "Known Security Notes" and allowlisted in .gitleaks.toml.
 */

// Dev-only fallback. Production sets JWT_SECRET via env; server.js throws
// at boot if it is missing in production.
const DEV_FALLBACK_SECRET = "enterprise_super_secret_key_2026";

if (!process.env.JWT_SECRET) {
  console.error(
    "[secrets] JWT_SECRET environment variable is NOT set — falling back to the " +
      "insecure dev secret. Set JWT_SECRET in your .env for any non-development environment."
  );
}

// User / staff JWTs.
const JWT_SECRET = process.env.JWT_SECRET || DEV_FALLBACK_SECRET;

// Patient-portal JWTs. Prefer a dedicated PORTAL_JWT_SECRET so a leaked
// patient-portal key can't forge staff tokens; fall back to JWT_SECRET
// when unset for transition compatibility.
const PORTAL_JWT_SECRET =
  process.env.PORTAL_JWT_SECRET || process.env.JWT_SECRET || DEV_FALLBACK_SECRET;

// Super Admin Portal JWTs (/super-admin). Deliberately its OWN secret, never
// falling back to JWT_SECRET — Super Admin auth doesn't use the app User
// table at all (env-based credentials only), so its tokens must not be
// forgeable with a leaked regular-user JWT_SECRET and vice versa. No dev
// fallback either: an unset SUPER_ADMIN_JWT_SECRET disables the portal
// entirely (see middleware/superAdminAuth.js) rather than silently running
// on a guessable shared default.
const SUPER_ADMIN_JWT_SECRET = process.env.SUPER_ADMIN_JWT_SECRET || null;

module.exports = { JWT_SECRET, PORTAL_JWT_SECRET, SUPER_ADMIN_JWT_SECRET };
