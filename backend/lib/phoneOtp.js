// Phone-OTP helpers for self-service registration (org signup + customer/portal
// registration). Pre-registration, identity-by-phone. The route layer owns the
// PhoneVerificationOtp table reads/writes; this module owns: code generation,
// the OTP send stub, and the short-lived "phone-verified" JWT that the
// register/signup endpoints can check + stamp phoneVerifiedAt from.
//
// Mirrors backend/lib/emailOtp.js but for phone numbers. No external packages
// are used — all logic runs on Node built-ins (crypto, jsonwebtoken already
// installed). The sendOtpSms function logs the code server-side only;
// the code is NEVER returned to the HTTP response.

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const OTP_TTL_MS = 10 * 60 * 1000; // codes valid 10 minutes
const VERIFY_TOKEN_TTL = "30m";     // verified-phone token valid 30 minutes
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";
const VALID_PURPOSES = ["signup", "customer-register"];

// Cryptographically-random 6-digit code (000000–999999), zero-padded.
function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// Accepts 10-digit Indian numbers (no country code) or E.164 format
// (starts with +, 8–16 chars total including the +).
function isValidPhone(phone) {
  if (typeof phone !== "string") return false;
  const stripped = phone.trim();
  if (/^\+[0-9]{7,15}$/.test(stripped)) return true; // E.164
  if (/^[0-9]{10}$/.test(stripped)) return true;      // 10-digit Indian local
  return false;
}

// Strip non-digits; if 10 digits remain prepend "91" (Indian country code).
// Already-E.164 numbers (stripped of leading +) pass through as-is.
function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return "91" + digits;
  return digits; // e.g. "919876543210" from "+919876543210"
}

// Send (or stub) the OTP code. Returns { sent: boolean, reason?: string }.
// NEVER surfaces the code in the return value — logging is server-side only.
// This is a stub implementation: no external SMS provider is wired here.
// To integrate a real provider later, replace the body of this function.
async function sendOtpSms(to, code, purpose) {
  // Server-side log only — the code is intentionally NOT returned to the
  // HTTP caller. This mirrors emailOtp's no-SendGrid-key behaviour.
  console.log(`[PhoneOTP] No SMS provider configured — code for ${to} is ${code} (dev log only)`);
  return { sent: false, reason: "no_sms_provider" };
}

// Mint a short-lived token proving the phone was OTP-verified for a purpose.
function issueVerifiedPhoneToken(phone, purpose) {
  const normalized = normalizePhone(phone);
  return jwt.sign(
    { kind: "phone-verified", phone: normalized, purpose },
    JWT_SECRET,
    { expiresIn: VERIFY_TOKEN_TTL },
  );
}

// True iff `token` is a valid, unexpired phone-verified token for (phone, purpose).
function checkVerifiedPhoneToken(token, phone, purpose) {
  if (!token || typeof token !== "string") return false;
  const normalized = normalizePhone(phone);
  try {
    const d = jwt.verify(token, JWT_SECRET);
    return (
      d.kind === "phone-verified" &&
      d.purpose === purpose &&
      d.phone === normalized
    );
  } catch {
    return false;
  }
}

module.exports = {
  OTP_TTL_MS,
  VALID_PURPOSES,
  generateOtpCode,
  isValidPhone,
  normalizePhone,
  sendOtpSms,
  issueVerifiedPhoneToken,
  checkVerifiedPhoneToken,
};
