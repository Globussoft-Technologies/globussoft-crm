/**
 * superAdminAuth.js — Super Admin Portal authentication middleware.
 *
 * Completely separate from the regular User/JWT auth system
 * (middleware/auth.js). Credentials are NOT stored in the app User/tenant
 * tables — only in environment variables + one auto-managed SystemSetting
 * row (never a full DB table of admins):
 *
 *   SUPER_ADMIN_USERNAME            — plain username, compared verbatim.
 *   SUPER_ADMIN_PASSWORD_HASH       — bcrypt hash of the password (preferred
 *                                     path). Generate once via
 *                                     scripts/hash-super-admin-password.js
 *                                     and paste only the hash into .env —
 *                                     the plaintext password is never
 *                                     written to disk at any point.
 *   SUPER_ADMIN_PASSWORD_PLAINTEXT  — convenience alternative to the above:
 *                                     a PLAIN password typed directly into
 *                                     .env. On the FIRST successful login
 *                                     (or ANY time it's set to a real value
 *                                     again later — see "password change"
 *                                     below) the server bcrypt-hashes it and
 *                                     persists the hash to the SystemSetting
 *                                     table (key "super_admin_password_hash").
 *                                     Immediately after hashing, the server
 *                                     rewrites .env in place, replacing the
 *                                     real password with the sentinel
 *                                     PLAINTEXT_PLACEHOLDER below — so the
 *                                     plaintext never sits on disk longer
 *                                     than one login cycle, and no one has
 *                                     to remember to remove it by hand.
 *
 *                                     PASSWORD CHANGE: to change the
 *                                     password later, just edit .env and set
 *                                     SUPER_ADMIN_PASSWORD_PLAINTEXT to the
 *                                     NEW password (overwriting the
 *                                     placeholder), then log in with that
 *                                     new password. Any value that isn't the
 *                                     exact placeholder sentinel is treated
 *                                     as "operator wants to set this as the
 *                                     new password" — it gets hashed,
 *                                     persisted, and .env is rewritten back
 *                                     to the placeholder again. This works
 *                                     any number of times.
 *   SUPER_ADMIN_JWT_SECRET          — dedicated JWT signing secret
 *                                     (config/secrets.js). No dev fallback:
 *                                     unset disables the whole portal.
 *
 * Token shape: { role: 'SUPER_ADMIN', username }, signed with
 * SUPER_ADMIN_JWT_SECRET, 8h expiry. Sent back as a normal Bearer token
 * (frontend stores it separately from the regular app JWT — different
 * localStorage key — so a Super Admin session and a regular staff session
 * can coexist in the same browser without clobbering each other).
 */

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { SUPER_ADMIN_JWT_SECRET } = require("../config/secrets");
const prisma = require("../lib/prisma");

const TOKEN_EXPIRY = "8h";
const PASSWORD_HASH_SETTING_KEY = "super_admin_password_hash";
const ENV_PATH = path.join(__dirname, "..", ".env");
const ENV_VAR_NAME = "SUPER_ADMIN_PASSWORD_PLAINTEXT";
// The sentinel .env is rewritten to after a plaintext password is hashed +
// persisted. NOT a real password — isPlaintextPlaceholder() below is the
// single source of truth for "is this the placeholder or a real value?".
const PLAINTEXT_PLACEHOLDER = "<hashed — edit this value to change the password>";

function isSuperAdminConfigured() {
  const hasCredential = Boolean(
    process.env.SUPER_ADMIN_PASSWORD_HASH || process.env.SUPER_ADMIN_PASSWORD_PLAINTEXT,
  );
  return Boolean(process.env.SUPER_ADMIN_USERNAME && hasCredential && SUPER_ADMIN_JWT_SECRET);
}

// True for both "unset" and "already the placeholder" — both mean "no
// pending password change here", so callers treat them identically.
function isPlaintextPlaceholder(value) {
  return !value || value === PLAINTEXT_PLACEHOLDER;
}

/**
 * Resolve the bcrypt hash to verify a login attempt against, in priority
 * order: (1) a hash already promoted to SystemSetting from a prior
 * plaintext-env login, (2) SUPER_ADMIN_PASSWORD_HASH from env, (3) null —
 * caller falls back to the plaintext-promotion path in routes/super_admin_auth.js.
 */
async function getPersistedPasswordHash() {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: PASSWORD_HASH_SETTING_KEY } });
    return row ? row.value : null;
  } catch (e) {
    console.warn("[superAdminAuth] failed to read persisted password hash (non-fatal):", e.message);
    return null;
  }
}

async function persistPromotedPasswordHash(hash) {
  await prisma.systemSetting.upsert({
    where: { key: PASSWORD_HASH_SETTING_KEY },
    update: { value: hash, updatedBy: "system (auto-promoted from SUPER_ADMIN_PASSWORD_PLAINTEXT)" },
    create: {
      key: PASSWORD_HASH_SETTING_KEY,
      value: hash,
      category: "super-admin-auth",
      updatedBy: "system (auto-promoted from SUPER_ADMIN_PASSWORD_PLAINTEXT)",
    },
  });
}

/**
 * Rewrites .env in place, replacing the SUPER_ADMIN_PASSWORD_PLAINTEXT line's
 * value with the placeholder sentinel — called immediately after a real
 * plaintext password has been hashed + persisted, so the plaintext never
 * sits on disk longer than one login cycle. Also updates process.env in the
 * running process (a file edit alone wouldn't affect the already-running
 * server until a restart).
 *
 * Best-effort: if the file can't be read/written (permissions, missing
 * file, unexpected format), this logs a warning and returns false — it
 * NEVER throws, because a disk-write failure must not break the login that
 * already succeeded and already persisted the real hash to the DB.
 */
function redactPlaintextInEnvFile() {
  try {
    if (!fs.existsSync(ENV_PATH)) {
      console.warn(`[superAdminAuth] .env not found at ${ENV_PATH} — skipping plaintext redaction (non-fatal)`);
      return false;
    }
    const content = fs.readFileSync(ENV_PATH, "utf8");
    const lineRe = new RegExp(`^${ENV_VAR_NAME}=.*$`, "m");
    if (!lineRe.test(content)) {
      // Nothing to redact — the var isn't set as its own line (e.g. only
      // exported some other way). Not an error; just nothing to do.
      return false;
    }
    const updated = content.replace(lineRe, `${ENV_VAR_NAME}=${PLAINTEXT_PLACEHOLDER}`);
    fs.writeFileSync(ENV_PATH, updated, "utf8");
    process.env[ENV_VAR_NAME] = PLAINTEXT_PLACEHOLDER;
    return true;
  } catch (e) {
    console.warn(`[superAdminAuth] failed to redact ${ENV_VAR_NAME} in .env (non-fatal): ${e.message}`);
    return false;
  }
}

function issueSuperAdminToken(username) {
  return jwt.sign({ role: "SUPER_ADMIN", username }, SUPER_ADMIN_JWT_SECRET, {
    expiresIn: TOKEN_EXPIRY,
  });
}

const WWW_AUTH = "Bearer";
function unauthorized(res, error) {
  res.set("WWW-Authenticate", WWW_AUTH);
  return res.status(401).json({ error });
}

/**
 * Protects every /api/super-admin/* route except /login. Header-only
 * (no cookie fallback — this is a separate, deliberately narrower auth
 * surface than the main app's).
 */
function requireSuperAdmin(req, res, next) {
  if (!isSuperAdminConfigured()) {
    return res.status(503).json({
      error: "Super Admin Portal is not configured on this server (missing env vars)",
      code: "SUPER_ADMIN_NOT_CONFIGURED",
    });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return unauthorized(res, "No Super Admin token provided");

  try {
    const decoded = jwt.verify(token, SUPER_ADMIN_JWT_SECRET);
    if (decoded.role !== "SUPER_ADMIN") {
      return unauthorized(res, "Invalid Super Admin token");
    }
    req.superAdmin = { username: decoded.username };
    next();
  } catch (e) {
    return unauthorized(res, "Invalid or expired Super Admin token: " + e.message);
  }
}

module.exports = {
  requireSuperAdmin,
  issueSuperAdminToken,
  isSuperAdminConfigured,
  getPersistedPasswordHash,
  persistPromotedPasswordHash,
  isPlaintextPlaceholder,
  redactPlaintextInEnvFile,
  PLAINTEXT_PLACEHOLDER,
};
