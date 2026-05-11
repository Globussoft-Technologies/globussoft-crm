/**
 * Credential masking + sentinel detection for Channels provider configs.
 * Closes #651 — third-party credentials must never round-trip plaintext to
 * the browser.
 *
 * The GET /api/{sms,whatsapp,telephony}/config endpoints return
 *   { configured: <bool>, last4: '****1234' | null, lastRotatedAt: <ISO> }
 * for every credential field. The PUT endpoints require the FULL fresh
 * credential — partial / masked input (anything ending "****") is treated as
 * "user did not retype this field" and SKIPPED instead of saved (so the
 * previous credential remains).
 *
 * Encryption at rest is OPT-IN via `WELLNESS_FIELD_KEY` env var (reuses the
 * existing field-encryption AES-256-GCM helper from v3.1). When unset, the
 * helpers transparently fall through to plaintext storage. To turn it on:
 *   1. node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   2. .env  → WELLNESS_FIELD_KEY=<paste>
 *   3. Restart backend (existing plaintext rows keep working — decrypt() is
 *      a no-op on values that don't carry the ENC:v1: prefix).
 */
const { encrypt, decrypt, isEncrypted } = require("./fieldEncryption");

const MASK_SUFFIX = "****";

/**
 * `true` iff `value` is non-null + non-empty + non-undefined.
 * Empty-string is treated as "not configured" so an upsert that wrote
 * apiKey:"" doesn't render as `configured: true` in the UI.
 */
function isPresent(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Extract the last 4 characters of a stored credential. The argument may be
 * either the plaintext or the ENC:v1:<iv>:<tag>:<ct> ciphertext wrapper —
 * we decrypt first so the operator sees the last 4 of the REAL credential,
 * not the last 4 of the base64 ciphertext.
 *
 * Returns `'****<tail>'` for any value with ≥1 char, or `null` for empty /
 * missing values. The mask string itself is short enough (8 chars) that it
 * cannot be confused with a real credential by the rotation handler.
 */
function maskCredential(value) {
  if (!isPresent(value)) return null;
  const plain = isEncrypted(value) ? decrypt(value) : value;
  if (!isPresent(plain)) return null;
  const tail = plain.slice(-4);
  return MASK_SUFFIX + tail;
}

/**
 * `true` if `value` looks like the masked sentinel emitted by GET /config
 * (i.e. starts with "****" and is ≤ 8 chars, since the mask is "****<tail>"
 * where tail is at most 4 chars of plaintext). The frontend rotation UI
 * sends the FULL new credential — anything matching this shape means the
 * user left the field alone, and the route should skip it.
 *
 * Legacy edge case: pre-#651 the backend emitted "abc1234****" (prefix +
 * "****" suffix). We accept that legacy shape as a sentinel too so old
 * frontends in flight don't accidentally rotate a credential to a garbage
 * value during the rollout window.
 *
 * The 8-char cap is important: a real credential that happens to contain
 * "****" wouldn't be filtered by a pure substring check. The 8-char cap
 * ensures we only filter our own short sentinels.
 */
function looksLikeMaskedSentinel(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 12) return false;
  // New shape: "****<tail>" — at most 4 chars of tail.
  if (value.startsWith(MASK_SUFFIX) && value.length <= 8) return true;
  // Legacy shape: "<prefix>****" — at most 12 chars total (6-char prefix + ****).
  if (value.endsWith(MASK_SUFFIX) && value.length <= 12) return true;
  return false;
}

/**
 * Same as maskCredential() but returns the shape the GET /config endpoints
 * expose: { configured, last4 }. Used in route response mappers.
 */
function describeCredential(value) {
  if (!isPresent(value)) return { configured: false, last4: null };
  return { configured: true, last4: maskCredential(value) };
}

/**
 * Encrypt a plaintext credential for at-rest storage. No-op when
 * WELLNESS_FIELD_KEY is unset (graceful plaintext fallback).
 * Returns the value unchanged when input is null/undefined/empty so the
 * upsert path can pass through.
 */
function encryptCredential(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  return encrypt(plaintext);
}

/**
 * Decrypt a stored credential for use in the provider send-path
 * (smsProvider.js / whatsappProvider.js / telephonyProvider.js). Returns
 * plaintext unchanged when input was never encrypted (legacy rows /
 * encryption disabled).
 */
function decryptCredential(ciphertext) {
  if (ciphertext == null || ciphertext === "") return ciphertext;
  return decrypt(ciphertext);
}

/**
 * Build the masked, GET-safe shape of a config row. Pass the list of
 * sensitive field names — each one is replaced by `{ configured, last4 }`
 * and the rest of the row is returned verbatim.
 *
 *   maskConfigRow(smsRow, ['apiKey', 'authToken']) →
 *     { ...nonSensitiveFields,
 *       apiKey:    { configured: true, last4: '****a3f1' },
 *       authToken: { configured: false, last4: null } }
 */
function maskConfigRow(row, sensitiveFields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of sensitiveFields) {
    out[f] = describeCredential(row[f]);
  }
  return out;
}

module.exports = {
  MASK_SUFFIX,
  maskCredential,
  looksLikeMaskedSentinel,
  describeCredential,
  encryptCredential,
  decryptCredential,
  maskConfigRow,
};
