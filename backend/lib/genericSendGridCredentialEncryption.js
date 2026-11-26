"use strict";

const crypto = require("crypto");

const PREFIX = "GENERIC_SENDGRID_ENC:v1:";

function getKey() {
  const secret = String(process.env.JWT_SECRET || "");
  if (!secret) {
    const error = new Error("JWT_SECRET is required to encrypt Generic SendGrid credentials");
    error.code = "GENERIC_SENDGRID_ENCRYPTION_UNAVAILABLE";
    throw error;
  }
  return crypto.createHash("sha256").update(`generic-sendgrid:${secret}`, "utf8").digest();
}

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function encryptGenericSendGridCredential(value) {
  if (typeof value !== "string" || !value) {
    const error = new Error("Generic SendGrid credential is required");
    error.code = "GENERIC_SENDGRID_CREDENTIAL_REQUIRED";
    throw error;
  }
  if (isEncrypted(value)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

function decryptGenericSendGridCredential(value) {
  if (!isEncrypted(value)) {
    const error = new Error("Stored Generic SendGrid credentials are not encrypted");
    error.code = "GENERIC_SENDGRID_CREDENTIAL_NOT_ENCRYPTED";
    throw error;
  }
  const [, version, ivHex, tagHex, ciphertextHex] = value.split(":");
  if (version !== "v1" || !ivHex || !tagHex || !ciphertextHex) {
    const error = new Error("Stored Generic SendGrid credentials are invalid");
    error.code = "GENERIC_SENDGRID_CREDENTIAL_INVALID";
    throw error;
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    const error = new Error("Stored Generic SendGrid credentials are invalid");
    error.code = "GENERIC_SENDGRID_CREDENTIAL_INVALID";
    error.cause = cause;
    throw error;
  }
}

module.exports = {
  isEncrypted,
  encryptGenericSendGridCredential,
  decryptGenericSendGridCredential,
};
