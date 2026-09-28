"use strict";

const crypto = require("crypto");

const PREFIX = "TRAVEL_MEETING_ENC:v1:";
const KEY_ENV = "TRAVEL_MEETING_CREDENTIAL_KEY";

function getKey() {
  const hex = String(process.env[KEY_ENV] || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(hex)) {
    const error = new Error(`${KEY_ENV} must be configured as 64 hexadecimal characters`);
    error.code = "TRAVEL_MEETING_ENCRYPTION_UNAVAILABLE";
    throw error;
  }
  return Buffer.from(hex, "hex");
}

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function encryptTravelMeetingCredential(value) {
  if (typeof value !== "string" || !value) {
    const error = new Error("Travel Meeting credential is required");
    error.code = "TRAVEL_MEETING_CREDENTIAL_REQUIRED";
    throw error;
  }
  if (isEncrypted(value)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

function decryptTravelMeetingCredential(value) {
  if (!isEncrypted(value)) {
    const error = new Error("Stored Travel Meeting credentials are not encrypted");
    error.code = "TRAVEL_MEETING_CREDENTIAL_NOT_ENCRYPTED";
    throw error;
  }
  const [, version, ivHex, tagHex, ciphertextHex] = value.split(":");
  if (version !== "v1" || !ivHex || !tagHex || !ciphertextHex) {
    const error = new Error("Stored Travel Meeting credentials are invalid");
    error.code = "TRAVEL_MEETING_CREDENTIAL_INVALID";
    throw error;
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

module.exports = {
  KEY_ENV,
  isEncrypted,
  encryptTravelMeetingCredential,
  decryptTravelMeetingCredential,
};
