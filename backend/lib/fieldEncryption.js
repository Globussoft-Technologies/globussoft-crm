/**
 * Field-level encryption for patient PII (DPDP Act 2023 prep).
 *
 * AES-256-GCM with a 32-byte key from env:
 *   WELLNESS_FIELD_KEY=<64 hex chars>   # 32 bytes
 *
 * Wraps values as "ENC:v1:<iv-hex>:<tag-hex>:<ct-hex>" so we can detect
 * already-encrypted values on read and avoid double-encryption / corrupt
 * decrypt of plaintext that predates this module.
 *
 * Disabled-by-default behaviour: if WELLNESS_FIELD_KEY is missing, encrypt()
 * is a no-op (returns input unchanged) and decrypt() falls through cleanly.
 * This means you can deploy the code first, then flip the switch when you've
 * generated and stored a key — no data loss either way.
 *
 * To turn it on:
 *   1. node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   2. Add to .env  → WELLNESS_FIELD_KEY=<paste>
 *   3. Restart the backend
 *   4. (optional) Run scripts/encrypt-existing-pii.js to backfill old rows
 *
 * Usage:
 *   const { encrypt, decrypt, isEncrypted } = require('../lib/fieldEncryption');
 *   const cipher = encrypt("Patient is allergic to penicillin");
 *   const plain  = decrypt(cipher);
 */
const crypto = require("crypto");

const PREFIX = "ENC:v1:";
const ALGO = "aes-256-gcm";

let _key = null;
function getKey() {
  if (_key !== null) return _key;
  const hex = process.env.WELLNESS_FIELD_KEY;
  if (!hex) { _key = false; return false; }
  if (!/^[a-f0-9]{64}$/i.test(hex)) {
    console.warn("[fieldEncryption] WELLNESS_FIELD_KEY must be 64 hex chars (32 bytes). Disabled.");
    _key = false;
    return false;
  }
  _key = Buffer.from(hex, "hex");
  return _key;
}

function isEncrypted(v) {
  return typeof v === "string" && v.startsWith(PREFIX);
}

function encrypt(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  if (typeof plaintext !== "string") plaintext = JSON.stringify(plaintext);
  if (isEncrypted(plaintext)) return plaintext;
  const key = getKey();
  if (!key) return plaintext; // no-op when key missing
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

function decrypt(ciphertext) {
  if (!isEncrypted(ciphertext)) return ciphertext; // plaintext or null — return as-is
  const key = getKey();
  if (!key) return ciphertext; // we'd corrupt it without a key — let caller handle
  try {
    const [, , iv, tag, ct] = ciphertext.split(":");
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "hex")), decipher.final()]).toString("utf8");
  } catch (e) {
    console.warn("[fieldEncryption] decrypt failed:", e.message);
    return ciphertext; // return ciphertext rather than crash — surface the issue but stay alive
  }
}

module.exports = { encrypt, decrypt, isEncrypted };
