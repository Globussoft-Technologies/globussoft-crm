// Email-OTP helpers for self-service registration (org signup + customer/portal
// registration). Pre-registration, identity-by-email. The route layer owns the
// EmailVerificationOtp table reads/writes; this module owns: code generation,
// the SendGrid email send, and the short-lived "email-verified" JWT that the
// register/signup endpoints check + stamp emailVerifiedAt from.
//
// Mirrors the SendGrid fetch pattern in routes/communications.js + the
// short-lived-access-JWT pattern in routes/travel_microsites.js verify-otp.

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const OTP_TTL_MS = 10 * 60 * 1000; // codes valid 10 minutes
const VERIFY_TOKEN_TTL = "30m"; // verified-email token valid 30 minutes
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";
const VALID_PURPOSES = ["signup", "customer-register"];

// Cryptographically-random 6-digit code (000000–999999), zero-padded.
function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
}

// Send the code via SendGrid. Returns { sent, reason? }. When SENDGRID_API_KEY
// is unset it logs (and the caller may surface a dev code in non-prod) rather
// than throwing — so the flow is exercisable locally / in CI without keys.
async function sendOtpEmail(to, code, purpose) {
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
  const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";
  const what = purpose === "signup" ? "create your organization" : "create your account";
  const subject = "Your Globussoft verification code";
  const body =
    `Your verification code is ${code}.\n\n` +
    `Enter it to ${what}. The code expires in 10 minutes.\n\n` +
    `If you didn't request this, you can safely ignore this email.`;

  if (!SENDGRID_API_KEY) {
    console.log(`[EmailOTP] SendGrid not configured — code for ${to} is ${code} (dev log only)`);
    return { sent: false, reason: "no_api_key" };
  }
  try {
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: FROM_EMAIL },
        subject,
        content: [
          { type: "text/plain", value: body },
          { type: "text/html", value: body.replace(/\n/g, "<br>") },
        ],
      }),
    });
    if (resp.ok) {
      console.log(`[EmailOTP] Sent verification code to ${to} (${purpose})`);
      return { sent: true };
    }
    const text = await resp.text();
    console.error(`[EmailOTP] SendGrid error ${resp.status}: ${text}`);
    return { sent: false, reason: text };
  } catch (err) {
    console.error("[EmailOTP] send failed:", err.message);
    return { sent: false, reason: err.message };
  }
}

// Mint a short-lived token proving the email was OTP-verified for a purpose.
function issueVerificationToken(email, purpose) {
  return jwt.sign(
    { kind: "email-verified", email: String(email).trim().toLowerCase(), purpose },
    JWT_SECRET,
    { expiresIn: VERIFY_TOKEN_TTL },
  );
}

// True iff `token` is a valid, unexpired verification token for (email,purpose).
function checkVerificationToken(token, email, purpose) {
  if (!token || typeof token !== "string") return false;
  try {
    const d = jwt.verify(token, JWT_SECRET);
    return (
      d.kind === "email-verified" &&
      d.purpose === purpose &&
      d.email === String(email || "").trim().toLowerCase()
    );
  } catch {
    return false;
  }
}

// Whether registration endpoints REQUIRE a verified-email token at the route
// layer (closes the API-bypass where a direct POST simply omits the token).
//
// OPT-IN ONLY (default OFF, including in production). Why not auto-on in prod:
// POST /api/auth/register is shared by THREE callers, only one of which does
// OTP — Signup.jsx (has OTP) vs GetStarted.jsx (no OTP) vs Settings.jsx
// "invite team member" (no OTP). Auto-enforcing would 403 the latter two. So
// enforcement is a deliberate switch: set REQUIRE_EMAIL_OTP=1 ONLY after
// GetStarted.jsx gains an OTP step and the Settings invite is moved off
// /auth/register. The mechanism is in place; flipping it is intentional.
function isRegistrationOtpEnforced() {
  return process.env.REQUIRE_EMAIL_OTP === "1";
}

// Single route-layer gate shared by /auth/register, /auth/signup,
// /auth/customer/register, /portal/register. Returns either
//   { ok: true,  emailVerifiedAt: Date|null }
//   { ok: false, status, error, code }   ← return verbatim to the client
// Behaviour:
//   token present + valid    → ok, emailVerifiedAt = now
//   token present + invalid  → 403 EMAIL_NOT_VERIFIED  (tampered/expired/wrong-purpose)
//   token absent + enforced  → 403 EMAIL_VERIFICATION_REQUIRED  (the bypass, now closed)
//   token absent + relaxed   → ok, emailVerifiedAt = null  (backward-compatible)
function enforceRegistrationOtp(verificationToken, email, purpose) {
  const provided = verificationToken !== undefined && verificationToken !== null && verificationToken !== "";
  if (provided) {
    if (!checkVerificationToken(verificationToken, email, purpose)) {
      return { ok: false, status: 403, error: "Email verification failed — please verify your email again", code: "EMAIL_NOT_VERIFIED" };
    }
    return { ok: true, emailVerifiedAt: new Date() };
  }
  if (isRegistrationOtpEnforced()) {
    return { ok: false, status: 403, error: "Email verification is required — please verify your email to continue", code: "EMAIL_VERIFICATION_REQUIRED" };
  }
  return { ok: true, emailVerifiedAt: null };
}

module.exports = {
  OTP_TTL_MS,
  VERIFY_TOKEN_TTL,
  VALID_PURPOSES,
  generateOtpCode,
  isValidEmail,
  sendOtpEmail,
  issueVerificationToken,
  checkVerificationToken,
  isRegistrationOtpEnforced,
  enforceRegistrationOtp,
};
