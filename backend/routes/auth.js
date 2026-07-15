const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const speakeasy = require("speakeasy");
const { verifyToken, verifyRole } = require("../middleware/auth");

const crypto = require("crypto");

const router = express.Router();
const prisma = require("../lib/prisma");
const emailOtp = require("../lib/emailOtp");
const phoneOtp = require("../lib/phoneOtp");
const { registerLimiter, otpRequestLimiter, otpVerifyLimiter } = require("../middleware/apiRateLimiters");
const { writeAudit } = require("../lib/audit");
const { resolvePrimaryRole } = require("../lib/roleResolution");
const { provisionTenantRbac } = require("../scripts/ensureRbacOnBoot");
// Module-object require so vi.mock-style replacement of the exports at
// test time is observable here (the destructured form captures function
// references at require-time and bypasses any later patching).
const s3Service = require("../services/s3Service");

// Memory-storage multer for profile-picture uploads — 5 MB cap, image-only.
// The route below hands the buffer to s3Service.uploadImage() which gates
// the mimetype again, but rejecting at the multer layer gives a cleaner
// error path for oversized files (multer's MulterError vs a thrown
// "Invalid image MIME type" deep in the S3 client).
const profilePictureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Wrap multer's single-file middleware so MulterError instances (e.g.
// LIMIT_FILE_SIZE) are translated into JSON responses inside this route
// rather than bubbling up to the global error handler as a 500. Without
// this, a 6 MB upload returns the default express error page instead of
// a clean { code: "FILE_TOO_LARGE" } envelope the frontend can read.
function profilePictureUploadHandler(req, res, next) {
  profilePictureUpload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: "Profile picture must be 5 MB or smaller",
          code: "FILE_TOO_LARGE",
        });
      }
      return res.status(400).json({ error: "Upload error", code: err.code });
    }
    if (err) return next(err);
    next();
  });
}

// After a fresh tenant is created via /register or /signup, ensure the
// canonical RBAC role set exists for that tenant AND the freshly-created
// admin user is assigned to the ADMIN role. Without this, the new admin
// holds User.role='ADMIN' (legacy string makes the sidebar's isAdmin
// gate true) but has zero RolePermission grants, so /api/pages/me
// returns nothing and the catalog-driven sidebar sections all collapse —
// the canonical "I created my account and the sidebar is almost empty"
// symptom. Idempotent; safe to call even if a prior call partially
// succeeded.
async function provisionRbacForFreshTenant(tenantId, vertical, adminUserId) {
  try {
    // `vertical` is one of 'wellness' | 'travel' | 'generic' (or null,
    // treated as 'generic'). Was previously a boolean `isWellness` —
    // changed to a string so travel signups don't collapse into the
    // generic bucket and miss their TRAVEL_MODULES catalog snapshot.
    await provisionTenantRbac(tenantId, { vertical });
    // Assign the new admin user to the tenant's ADMIN role row. The
    // provisioner's user-iteration loop ALSO does this when it sees a
    // User.role='ADMIN' row for the tenant, but the loop is best-effort
    // (skips on conflict). Doing it explicitly here too makes the wire-
    // up failure-mode visible (any error bubbles up to the caller).
    if (adminUserId) {
      const adminRole = await prisma.role.findFirst({
        where: { tenantId, key: 'ADMIN' },
        select: { id: true },
      });
      if (adminRole) {
        const existing = await prisma.userRole.findUnique({
          where: { userId_roleId: { userId: adminUserId, roleId: adminRole.id } },
        });
        if (!existing) {
          await prisma.userRole.create({
            data: { userId: adminUserId, roleId: adminRole.id },
          });
        }
      }
    }
  } catch (err) {
    // Failure here is non-fatal for the signup flow itself — the user
    // and tenant rows have already been persisted, and the next server
    // boot's ensureRbacOnBoot will pick up the gap. Log so an operator
    // can diagnose if the inline call repeatedly fails.
    console.error(
      `[auth] provisionRbacForFreshTenant failed for tenant ${tenantId}:`,
      err && err.message ? err.message : err,
    );
  }
}
const { JWT_SECRET } = require("../config/secrets");
// #914 slice 1 — additive HttpOnly cookie set alongside the JWT body. The
// middleware does NOT yet read this cookie (slice 2) and the frontend does
// NOT yet drop localStorage (slice 3+). Setting a cookie nothing reads is a
// pure no-op for existing consumers; this passes the cross-cutting-shape-
// change guard because zero behaviour changes downstream.
const { setAuthCookie, clearAuthCookie } = require("../lib/authCookies");

// Password-reset token store. Primary: the PasswordResetToken DB table (so
// links survive backend restarts / redeploys / multiple instances). Fallback:
// this in-memory Map — used only when the Prisma client predates the table
// (i.e. `prisma generate` hasn't run yet), so the flow never hard-breaks.
const resetTokens = new Map();

// Persist a freshly-issued reset token. Uses RAW SQL against the
// PasswordResetToken table so it works even when the Prisma client hasn't been
// regenerated yet (the table is created by `prisma db push`; raw queries don't
// need the generated model). Memory fallback only if the table itself is
// missing.
async function storeResetToken(token, userId, expiresAt) {
  try {
    await prisma.$executeRawUnsafe(
      "INSERT INTO `PasswordResetToken` (`token`, `userId`, `expiresAt`) VALUES (?, ?, ?)",
      token, userId, expiresAt,
    );
  } catch (e) {
    console.warn(`[auth] reset-token DB persist failed, using in-memory fallback: ${e.message}`);
    resetTokens.set(token, { userId, expiresAt: expiresAt.getTime() });
  }
}

// Consume a reset token: returns { userId } when valid, { error } when
// expired/used, or null when unknown. Checks the DB (raw) first, then memory.
async function consumeResetToken(token) {
  let row = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      "SELECT `userId` AS userId, `expiresAt` AS expiresAt, `usedAt` AS usedAt FROM `PasswordResetToken` WHERE `token` = ? LIMIT 1",
      token,
    );
    row = Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch { row = null; }
  if (row) {
    if (row.usedAt) return { error: "Reset link has already been used" };
    if (Date.now() > new Date(row.expiresAt).getTime()) return { error: "Reset token has expired" };
    try { await prisma.$executeRawUnsafe("UPDATE `PasswordResetToken` SET `usedAt` = NOW(3) WHERE `token` = ?", token); } catch { /* best-effort */ }
    return { userId: Number(row.userId) };
  }
  const entry = resetTokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { resetTokens.delete(token); return { error: "Reset token has expired" }; }
  resetTokens.delete(token);
  return { userId: entry.userId };
}

// Public endpoint: Get list of tenants for customer registration
router.get("/public/tenants", async (req, res) => {
  try {
    const tenants = await prisma.tenant.findMany({
      // eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic -- safe: PUBLIC route (no verifyToken) listing tenants for the registration dropdown — there is no req.user.tenantId to scope by; the response is intentionally cross-tenant. S36 (FR-3.4 / #919) audit-reviewed false-positive.
      where: { isActive: true },
      // `slug` is included so the customer-register + login pages can map a
      // `?tenantSlug=` handoff param (e.g. from the Dr. Haror's marketing
      // site) to a tenant id and pre-select the dropdown.
      // `vertical` lets the customer-register page route a travel-org signup
      // to the Travel Customer Portal API instead of the staff User registration.
      select: { id: true, name: true, slug: true, vertical: true },
      orderBy: { name: 'asc' },
    });
    res.json(tenants);
  } catch (err) {
    console.error("[auth/public/tenants] error:", err.message);
    res.status(500).json({ error: "Failed to load tenants" });
  }
});

// Marketing /get-started wizard: check whether an email already belongs to
// any active user in the system. Returns { exists: boolean } so the frontend
// can route existing users to /login and new users into the register flow.
// Intentionally scoped globally (not per-tenant) for the landing-page funnel.
router.post("/check-email", async (req, res) => {
  try {
    const rawEmail = req.body?.email;
    const email = typeof rawEmail === "string" ? rawEmail.toLowerCase().trim() : "";

    // Consistent-timing guard: even invalid emails run a short fixed delay
    // so response timing does not leak whether an email exists. 80 ms is
    // enough to smooth Prisma variance without hurting UX.
    const checkStart = Date.now();

    let exists = false;
    if (email && email.includes("@")) {
      const count = await prisma.user.count({
        where: {
          email,
          deactivatedAt: null,
        },
      });
      exists = count > 0;
    }

    const elapsed = Date.now() - checkStart;
    const minDelay = 80;
    if (elapsed < minDelay) {
      await new Promise((r) => setTimeout(r, minDelay - elapsed));
    }

    res.json({ exists });
  } catch (err) {
    console.error("[auth/check-email] error:", err.message);
    // Never expose internal errors; still return the same shape.
    res.status(500).json({ exists: false });
  }
});

// #526 (CRIT-01): Send password-reset link via SendGrid. Local helper
// because the same `sendSendGrid` function is duplicated in
// `lib/notificationService.js` and `routes/email_scheduling.js`; promoting
// to a shared `lib/sendgrid.js` is a separate cleanup (filed for follow-up).
//
// CRITICAL contract: this MUST NOT throw on a missing SENDGRID_API_KEY or
// a SendGrid API error. The endpoint must respond identically for known
// vs unknown emails to avoid the user-enumeration oracle (HI-02 / #531).
// We therefore call this WITHOUT awaiting from the route handler — the
// HTTP response goes out before the SendGrid round-trip even completes,
// so timing is also identical. On dev/local with no API key, the link
// is logged to stdout so QA can still complete the flow.
async function sendPasswordResetEmail(toEmail, token, frontendBase) {
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
  const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";
  const resetUrl = `${frontendBase}/reset-password?token=${encodeURIComponent(token)}`;

  if (!SENDGRID_API_KEY) {
    console.log(`[auth/forgot-password] SendGrid not configured — reset link for ${toEmail}: ${resetUrl}`);
    return;
  }

  try {
    const payload = {
      personalizations: [{ to: [{ email: toEmail }] }],
      from: { email: FROM_EMAIL },
      subject: "Reset your Globussoft CRM password",
      content: [
        { type: "text/plain", value: `Click this link to reset your Globussoft CRM password (valid 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.` },
        { type: "text/html", value: `<p>Click the link below to reset your Globussoft CRM password (valid 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can safely ignore this email.</p>` }
      ]
    };
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[auth/forgot-password] SendGrid error ${response.status}: ${text}`);
    }
  } catch (err) {
    console.error("[auth/forgot-password] SendGrid send failed:", err.message);
  }
}

// Issue #180: every newly-issued JWT carries a unique `jti` so it can be
// revoked individually via the RevokedToken table. Old tokens without jti
// still verify (they just can't be revoked) until their 7-day TTL runs out.
function newJti() {
  return crypto.randomBytes(16).toString("hex");
}

// Sign a session JWT with a fresh jti. Keeps the 7-day TTL for back-compat
// with frontend storage. The jti claim is what verifyToken consults against
// the RevokedToken table on every request.
function signSessionToken(payload) {
  return jwt.sign({ ...payload, jti: newJti() }, JWT_SECRET, { expiresIn: "7d" });
}

// True when the request carries a valid session token — i.e. an authenticated
// admin "managing their team" (Settings → invite team member), as opposed to
// an anonymous public self-signup. /auth/register is an openPath so the global
// guard never populates req.user; we verify the bearer here. Team invitation is
// NOT email-OTP gated (product call 2026-06-17) — only anonymous signup is.
function isAuthenticatedCaller(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return false;
  try {
    jwt.verify(h.slice(7), JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

// Helper: build a unique slug for a tenant
async function generateUniqueSlug(base) {
  const root = (base || "org")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "org";
  let slug = root;
  let i = 1;
  const MAX_ATTEMPTS = 100;
  while (i <= MAX_ATTEMPTS) {
    const existing = await prisma.tenant.findUnique({ where: { slug } });
    if (!existing) return slug;
    i += 1;
    slug = `${root}-${i}`;
  }
  // Fallback: UUID suffix guarantees uniqueness under collision storms.
  const suffix = require("crypto").randomUUID().slice(0, 8);
  return `${root}-${suffix}`;
}

// Password complexity: minimum 8 chars, must contain at least one letter AND one number
function validatePasswordComplexity(password) {
  if (!password || typeof password !== "string") return "Password is required";
  if (password.length < 8) return "Password must be at least 8 characters long";
  if (!/[A-Za-z]/.test(password)) return "Password must contain at least one letter";
  if (!/[0-9]/.test(password)) return "Password must contain at least one number";
  return null;
}

// Register Epic — creates a new Tenant + first User (org owner)
// ─── Email OTP for self-service registration (org signup + customer reg) ──
//
// Pre-registration email verification. The form sends { email, purpose };
// /request stores a hashed 6-digit code (10-min expiry) + emails it via
// SendGrid; /verify checks it + returns a short-lived "verificationToken"
// the register/signup endpoints stamp emailVerifiedAt from. Both are OPEN
// paths (no auth) — they run before any account exists.
//   purpose ∈ { "signup" (create org), "customer-register" (create account) }

// POST /api/auth/email-otp/request  { email, purpose }
router.post("/email-otp/request", otpRequestLimiter, async (req, res) => {
  try {
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    const purpose = String((req.body || {}).purpose || "");
    if (!emailOtp.isValidEmail(email)) {
      return res.status(400).json({ error: "A valid email address is required", code: "INVALID_EMAIL" });
    }
    if (!emailOtp.VALID_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: "Invalid verification purpose", code: "INVALID_PURPOSE" });
    }
    // Light rate-limit: at most one code per (email, purpose) per 60s.
    const recent = await prisma.emailVerificationOtp.findFirst({
      where: { email, purpose, createdAt: { gt: new Date(Date.now() - 60_000) } },
    });
    if (recent) {
      return res.status(429).json({ error: "Please wait a moment before requesting another code", code: "OTP_RATE_LIMIT" });
    }
    const code = emailOtp.generateOtpCode();
    const otpHash = await bcrypt.hash(code, 10);
    await prisma.emailVerificationOtp.create({
      data: { email, purpose, otpHash, expiresAt: new Date(Date.now() + emailOtp.OTP_TTL_MS) },
    });
    const result = await emailOtp.sendOtpEmail(email, code, purpose);
    // Only expose devCode when SendGrid is genuinely absent (no key configured
    // at all). A real send failure must never leak the code to the HTTP response.
    const devCode =
      result.reason === "no_api_key" && process.env.NODE_ENV !== "production" ? code : undefined;
    return res.status(201).json({ sent: !!result.sent, ...(devCode ? { devCode } : {}) });
  } catch (error) {
    console.error("[auth] email-otp/request error:", error.message);
    return res.status(500).json({ error: "Failed to send verification code" });
  }
});

// POST /api/auth/email-otp/verify  { email, purpose, code }
router.post("/email-otp/verify", otpVerifyLimiter, async (req, res) => {
  try {
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    const purpose = String((req.body || {}).purpose || "");
    const code = String((req.body || {}).code || "").trim();
    if (!email || !purpose || !code) {
      return res.status(400).json({ error: "email, purpose and code are required", code: "MISSING_FIELDS" });
    }
    const otp = await prisma.emailVerificationOtp.findFirst({
      where: { email, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!otp) {
      return res.status(400).json({ error: "Code expired or not found — request a new one", code: "OTP_INVALID" });
    }
    if (otp.attempts >= 5) {
      return res.status(429).json({ error: "Too many attempts — request a new code", code: "OTP_LOCKED" });
    }
    const match = await bcrypt.compare(code, otp.otpHash);
    if (!match) {
      await prisma.emailVerificationOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      return res.status(400).json({ error: "Incorrect code", code: "OTP_INVALID" });
    }
    await prisma.emailVerificationOtp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
    const verificationToken = emailOtp.issueVerificationToken(email, purpose);
    return res.json({ verified: true, verificationToken });
  } catch (error) {
    console.error("[auth] email-otp/verify error:", error.message);
    return res.status(500).json({ error: "Failed to verify code" });
  }
});

// ─── Phone OTP for self-service registration ──────────────────────────────
//
// Mirrors the email-otp flow above but identifies by phone number instead.
// Both routes are OPEN paths (no auth) — they run before any account exists.
//   purpose ∈ { "signup" (create org), "customer-register" (create account) }

// POST /api/auth/phone-otp/request  { phone, purpose }
router.post("/phone-otp/request", otpRequestLimiter, async (req, res) => {
  try {
    const phone = String((req.body || {}).phone || "").trim();
    const purpose = String((req.body || {}).purpose || "");
    if (!phoneOtp.isValidPhone(phone)) {
      return res.status(400).json({ error: "A valid phone number is required (10 digits or E.164 format)", code: "INVALID_PHONE" });
    }
    if (!phoneOtp.VALID_PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: "Invalid verification purpose", code: "INVALID_PURPOSE" });
    }
    // Light rate-limit: at most one code per (phone, purpose) per 60s.
    const normalizedPhone = phoneOtp.normalizePhone(phone);
    const recent = await prisma.phoneVerificationOtp.findFirst({
      where: { phone: normalizedPhone, purpose, createdAt: { gt: new Date(Date.now() - 60_000) } },
    });
    if (recent) {
      return res.status(429).json({ error: "Please wait a moment before requesting another code", code: "OTP_RATE_LIMIT" });
    }
    const code = phoneOtp.generateOtpCode();
    const otpHash = await bcrypt.hash(code, 10);
    await prisma.phoneVerificationOtp.create({
      data: { phone: normalizedPhone, purpose, otpHash, expiresAt: new Date(Date.now() + phoneOtp.OTP_TTL_MS) },
    });
    const result = await phoneOtp.sendOtpSms(normalizedPhone, code, purpose);
    // NEVER return the code to the HTTP response — not even in dev/CI.
    // The code is logged server-side only (same as emailOtp with no SendGrid key).
    return res.status(201).json({ sent: !!result.sent });
  } catch (error) {
    console.error("[auth] phone-otp/request error:", error.message);
    return res.status(500).json({ error: "Failed to send verification code" });
  }
});

// POST /api/auth/phone-otp/verify  { phone, purpose, code }
router.post("/phone-otp/verify", otpVerifyLimiter, async (req, res) => {
  try {
    const phone = String((req.body || {}).phone || "").trim();
    const purpose = String((req.body || {}).purpose || "");
    const code = String((req.body || {}).code || "").trim();
    if (!phone || !purpose || !code) {
      return res.status(400).json({ error: "phone, purpose and code are required", code: "MISSING_FIELDS" });
    }
    const normalizedPhone = phoneOtp.normalizePhone(phone);
    const otp = await prisma.phoneVerificationOtp.findFirst({
      where: { phone: normalizedPhone, purpose, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!otp) {
      return res.status(400).json({ error: "Code expired or not found — request a new one", code: "OTP_INVALID" });
    }
    if (otp.attempts >= 5) {
      return res.status(429).json({ error: "Too many attempts — request a new code", code: "OTP_LOCKED" });
    }
    const match = await bcrypt.compare(code, otp.otpHash);
    if (!match) {
      await prisma.phoneVerificationOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      return res.status(400).json({ error: "Incorrect code", code: "OTP_INVALID" });
    }
    await prisma.phoneVerificationOtp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
    const verificationToken = phoneOtp.issueVerifiedPhoneToken(normalizedPhone, purpose);
    return res.json({ verified: true, verificationToken });
  } catch (error) {
    console.error("[auth] phone-otp/verify error:", error.message);
    return res.status(500).json({ error: "Failed to verify code" });
  }
});

router.post("/register", registerLimiter, async (req, res) => {
  try {
    const { email, phone, password, name, organizationName, vertical, themePreference, verificationToken } = req.body;

    const pwErr = validatePasswordComplexity(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "A valid email address is required", code: "EMAIL_REQUIRED" });
    }

    // Verification gate for anonymous (public) self-signup.
    // The verificationToken may be issued by EITHER the email-OTP flow
    // (kind:"email-verified") or the phone-OTP flow (kind:"phone-verified").
    // Decode the token to determine which path was used and validate it against
    // the correct contact field. An authenticated admin caller (team invite) is
    // exempt from the gate entirely.
    let emailVerifiedAt = null;
    if (!isAuthenticatedCaller(req)) {
      const tokenProvided = verificationToken !== undefined && verificationToken !== null && verificationToken !== "";
      if (tokenProvided) {
        // Detect token kind without fully verifying first, then re-verify with
        // the correct contact to prevent cross-contact token reuse.
        let decodedKind;
        try {
          const decoded = jwt.decode(verificationToken);
          decodedKind = decoded && decoded.kind;
        } catch { decodedKind = null; }

        if (decodedKind === "phone-verified") {
          const phoneValue = phone && typeof phone === "string" ? phone.trim() : "";
          if (!phoneOtp.isValidPhone(phoneValue)) {
            return res.status(400).json({ error: "A valid phone number is required to match the phone verification token", code: "PHONE_REQUIRED" });
          }
          if (!phoneOtp.checkVerifiedPhoneToken(verificationToken, phoneValue, "signup")) {
            return res.status(403).json({ error: "Phone verification failed — please verify your phone again", code: "PHONE_NOT_VERIFIED" });
          }
          // Phone verified; emailVerifiedAt stays null (no email OTP was done)
        } else {
          // Treat as email-verified token (the original path)
          const otpGate = emailOtp.enforceRegistrationOtp(verificationToken, email, "signup");
          if (!otpGate.ok) return res.status(otpGate.status).json({ error: otpGate.error, code: otpGate.code });
          emailVerifiedAt = otpGate.emailVerifiedAt;
        }
      } else {
        // No token: fall through to the standard email-OTP enforcement check
        // (enforceRegistrationOtp handles the REQUIRE_EMAIL_OTP env gate)
        const otpGate = emailOtp.enforceRegistrationOtp(undefined, email, "signup");
        if (!otpGate.ok) return res.status(otpGate.status).json({ error: otpGate.error, code: otpGate.code });
        emailVerifiedAt = otpGate.emailVerifiedAt;
      }
    }

    // Org creation makes a brand-new tenant, so (email, newTenantId) can never
    // collide — email is unique per-tenant now (see User schema). The same
    // email is allowed to own/belong to multiple orgs, so there is no global
    // "already exists" pre-check here.

    const validVerticals = ['generic', 'wellness', 'travel'];
    const selectedVertical = validVerticals.includes(vertical) ? vertical : 'generic';

    const validThemes = ['light', 'dark', 'system'];
    const selectedTheme = validThemes.includes(themePreference) ? themePreference : 'system';

    const hashedPassword = await bcrypt.hash(password, 10);

    const orgName = organizationName || (name ? `${name}'s Organization` : "My Organization");
    const slug = await generateUniqueSlug(orgName);

    const tenant = await prisma.tenant.create({
      data: { name: orgName, slug, ownerEmail: email, plan: "TRIAL", vertical: selectedVertical, emailVerifiedAt }
    });

    const trialDays = parseInt(process.env.FREE_TRIAL_DAYS || 15);
    const now = new Date();
    const trialEnd = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: "ADMIN",
        tenantId: tenant.id,
        trialStartDate: now,
        trialEndsAt: trialEnd,
        subscriptionStatus: "TRIAL",
        themePreference: selectedTheme,
        emailVerifiedAt
      }
    });

    // Provision the canonical RBAC role set for the fresh tenant + assign
    // the new admin user to the ADMIN role row. Without this, the new
    // admin has no RolePermission grants and the catalog-driven sidebar
    // sections collapse on first login (the "sidebar is almost empty"
    // signup bug). Awaited so the user lands on a fully-RBAC'd session.
    await provisionRbacForFreshTenant(tenant.id, selectedVertical || 'generic', user.id);

    // #325: include vertical on the JWT so verifyWellnessRole can check
    // tenant vertical without an extra DB lookup per request.
    const token = signSessionToken({ userId: user.id, role: user.role, wellnessRole: user.wellnessRole || null, tenantId: tenant.id, vertical: tenant.vertical || "generic" });
    setAuthCookie(res, token); // #914 slice 1 — additive HttpOnly cookie (no consumer reads it yet)
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, wellnessRole: user.wellnessRole || null, themePreference: user.themePreference || 'system' },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan, vertical: tenant.vertical || "generic", country: tenant.country || "US", defaultCurrency: tenant.defaultCurrency || "USD", locale: tenant.locale || "en-US", logoUrl: tenant.logoUrl, brandColor: tenant.brandColor }
    });

  } catch (error) {
    console.error("[auth] register error:", error);
    res.status(500).json({ error: "Server registration error" });
  }
});

// Signup alias (matches signup page) — same behavior as register
router.post("/signup", registerLimiter, async (req, res) => {
  try {
    const { email, phone, password, name, organizationName, vertical, themePreference, verificationToken } = req.body;

    const pwErr = validatePasswordComplexity(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "A valid email address is required", code: "EMAIL_REQUIRED" });
    }

    // Email OTP gate (same posture as /register — this is its alias). Auth'd
    // admin (team invite) exempt; anonymous public signup gated.
    // Handles both email-verified and phone-verified tokens — same logic as /register.
    let emailVerifiedAt = null;
    if (!isAuthenticatedCaller(req)) {
      const tokenProvided = verificationToken !== undefined && verificationToken !== null && verificationToken !== "";
      if (tokenProvided) {
        let decodedKind;
        try {
          const decoded = jwt.decode(verificationToken);
          decodedKind = decoded && decoded.kind;
        } catch { decodedKind = null; }

        if (decodedKind === "phone-verified") {
          const phoneValue = phone && typeof phone === "string" ? phone.trim() : "";
          if (!phoneOtp.isValidPhone(phoneValue)) {
            return res.status(400).json({ error: "A valid phone number is required to match the phone verification token", code: "PHONE_REQUIRED" });
          }
          if (!phoneOtp.checkVerifiedPhoneToken(verificationToken, phoneValue, "signup")) {
            return res.status(403).json({ error: "Phone verification failed — please verify your phone again", code: "PHONE_NOT_VERIFIED" });
          }
        } else {
          const otpGate = emailOtp.enforceRegistrationOtp(verificationToken, email, "signup");
          if (!otpGate.ok) return res.status(otpGate.status).json({ error: otpGate.error, code: otpGate.code });
          emailVerifiedAt = otpGate.emailVerifiedAt;
        }
      } else {
        const otpGate = emailOtp.enforceRegistrationOtp(undefined, email, "signup");
        if (!otpGate.ok) return res.status(otpGate.status).json({ error: otpGate.error, code: otpGate.code });
        emailVerifiedAt = otpGate.emailVerifiedAt;
      }
    }

    // Org creation makes a brand-new tenant, so (email, newTenantId) can never
    // collide — email is unique per-tenant now (see User schema). The same
    // email is allowed to own/belong to multiple orgs, so there is no global
    // "already exists" pre-check here.

    const validVerticals = ['generic', 'wellness', 'travel'];
    const selectedVertical = validVerticals.includes(vertical) ? vertical : 'generic';

    const validThemes = ['light', 'dark', 'system'];
    const selectedTheme = validThemes.includes(themePreference) ? themePreference : 'system';

    const hashedPassword = await bcrypt.hash(password, 10);

    const orgName = organizationName || (name ? `${name}'s Organization` : "My Organization");
    const slug = await generateUniqueSlug(orgName);

    const tenant = await prisma.tenant.create({
      data: { name: orgName, slug, ownerEmail: email, plan: "TRIAL", vertical: selectedVertical, emailVerifiedAt }
    });

    const trialDays = parseInt(process.env.FREE_TRIAL_DAYS || 15);
    const now = new Date();
    const trialEnd = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: "ADMIN",
        tenantId: tenant.id,
        trialStartDate: now,
        trialEndsAt: trialEnd,
        subscriptionStatus: "TRIAL",
        themePreference: selectedTheme,
        emailVerifiedAt
      }
    });

    // Provision the canonical RBAC role set for the fresh tenant + assign
    // the new admin user to the ADMIN role row. See /register for the
    // longer comment — same bug, same fix.
    await provisionRbacForFreshTenant(tenant.id, selectedVertical || 'generic', user.id);

    // #325: include vertical on the JWT so verifyWellnessRole can check
    // tenant vertical without an extra DB lookup per request.
    const token = signSessionToken({ userId: user.id, role: user.role, wellnessRole: user.wellnessRole || null, tenantId: tenant.id, vertical: tenant.vertical || "generic" });
    setAuthCookie(res, token); // #914 slice 1 — additive HttpOnly cookie (no consumer reads it yet)
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, wellnessRole: user.wellnessRole || null, themePreference: user.themePreference || 'system' },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan, vertical: tenant.vertical || "generic", country: tenant.country || "US", defaultCurrency: tenant.defaultCurrency || "USD", locale: tenant.locale || "en-US", logoUrl: tenant.logoUrl, brandColor: tenant.brandColor }
    });

  } catch (error) {
    console.error("[auth] signup error:", error);
    res.status(500).json({ error: "Signup failed" });
  }
});

// GET /api/auth/customer/tenants — public list of active tenants for the
// customer self-registration dropdown. Returns minimal display fields only
// (id, name, vertical) — no plan, owner, billing, or branding metadata.
// Used by the CustomerRegister page to populate its Organization dropdown
// so new tenants created via /api/auth/signup show up automatically without
// a frontend redeploy.
router.get("/customer/tenants", async (req, res) => {
  try {
    const tenants = await prisma.tenant.findMany({
      // eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic -- safe: PUBLIC route (no verifyToken) for the customer self-registration dropdown — no req.user.tenantId exists pre-registration. Returns minimal display fields only (id, name, vertical) — no plan, owner, billing, or branding metadata. S36 (FR-3.4 / #919) audit-reviewed false-positive.
      where: { isActive: true },
      select: { id: true, name: true, vertical: true },
      orderBy: { name: "asc" },
    });
    res.json(tenants);
  } catch (error) {
    console.error("[auth] customer/tenants error:", error);
    res.status(500).json({ error: "Failed to fetch tenants" });
  }
});

// Customer Registration — open path for CUSTOMER userType self-registration
// Creates a new User with userType: 'CUSTOMER' and assigns the tenant's CUSTOMER role
router.post("/customer/register", registerLimiter, async (req, res) => {
  try {
    // The target tenant is supplied in the body and MUST be named
    // `registrationTenantId`, NOT `tenantId`: the global stripDangerous
    // middleware deletes `tenantId` from every request body (see CLAUDE.md
    // standing rules), so a `tenantId` field would always arrive undefined
    // and registration would 400. `registrationTenantId` is not on the strip
    // list, so it passes through intact.
    const { email, phone, password, name, registrationTenantId, verificationToken } = req.body || {};

    // Input validation — email is always required (it's the login credential and a required DB field)
    if (!email || typeof email !== "string" || !email.includes("@") || !password || typeof password !== "string") {
      return res.status(400).json({ error: "email, password, and registrationTenantId are required" });
    }

    // Verification gate — token may be email-verified or phone-verified.
    // Detect kind and validate against the correct contact field.
    let emailVerifiedAt = null;
    const tokenProvided = verificationToken !== undefined && verificationToken !== null && verificationToken !== "";
    if (tokenProvided) {
      let decodedKind;
      try {
        const decoded = jwt.decode(verificationToken);
        decodedKind = decoded && decoded.kind;
      } catch { decodedKind = null; }

      if (decodedKind === "phone-verified") {
        const phoneValue = phone && typeof phone === "string" ? phone.trim() : "";
        if (!phoneOtp.isValidPhone(phoneValue)) {
          return res.status(400).json({ error: "A valid phone number is required to match the phone verification token", code: "PHONE_REQUIRED" });
        }
        if (!phoneOtp.checkVerifiedPhoneToken(verificationToken, phoneValue, "customer-register")) {
          return res.status(403).json({ error: "Phone verification failed — please verify your phone again", code: "PHONE_NOT_VERIFIED" });
        }
        // Phone verified; emailVerifiedAt stays null
      } else {
        const otpGate = emailOtp.enforceRegistrationOtp(verificationToken, email, "customer-register");
        if (!otpGate.ok) return res.status(otpGate.status).json({ error: otpGate.error, code: otpGate.code });
        emailVerifiedAt = otpGate.emailVerifiedAt;
      }
    } else {
      const otpGate = emailOtp.enforceRegistrationOtp(undefined, email, "customer-register");
      if (!otpGate.ok) return res.status(otpGate.status).json({ error: otpGate.error, code: otpGate.code });
      emailVerifiedAt = otpGate.emailVerifiedAt;
    }

    // Coerce to a number — JSON sends it numeric, but accept a numeric string
    // defensively. Reject anything that isn't a positive integer.
    const tenantId = Number(registrationTenantId);
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: "registrationTenantId must be a valid number" });
    }

    // Password complexity check
    const pwErr = validatePasswordComplexity(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    // Check tenant exists
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      return res.status(400).json({ error: "Invalid tenant ID" });
    }

    // Check email isn't already registered IN THIS ORG. Email is unique
    // per-tenant, so the same address may register at another org — we only
    // block a duplicate within the same tenant.
    const existingUser = await prisma.user.findFirst({ where: { email, tenantId } });
    if (existingUser) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Create CUSTOMER user
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name: name || email.split('@')[0],
        userType: 'CUSTOMER',
        role: 'CUSTOMER', // Legacy field for backward compat
        tenantId,
        emailVerifiedAt,
      },
      include: { tenant: true }
    });

    // Assign CUSTOMER role via UserRole junction
    // Find the tenant's CUSTOMER system role
    const customerRole = await prisma.role.findFirst({
      where: {
        tenantId: tenantId,
        key: 'CUSTOMER',
        isSystem: true
      }
    });

    if (customerRole) {
      await prisma.userRole.create({
        data: {
          userId: user.id,
          roleId: customerRole.id
        }
      });
    }

    // Emit audit log for customer registration
    await writeAudit('User', 'CUSTOMER_REGISTRATION', user.id, user.id, tenantId, {
      email: user.email,
      name: user.name,
      tenantId: tenantId
    });

    // Bridge travel customers into the Customer Portal identity store. The
    // portal (POST /api/portal/login) authenticates against
    // Contact.portalPasswordHash — NOT the User table — so without this a
    // self-registered travel customer could never sign into /travel/portal
    // (they'd get "Invalid credentials", while seeded contacts like
    // ahmed.pilgrim@demo.test work). We reuse the SAME bcrypt hash so one
    // password works in both stores. Travel-only + best-effort: any failure
    // here must never break the User registration above.
    if ((user.tenant?.vertical || tenant.vertical) === "travel") {
      try {
        await prisma.contact.upsert({
          where: { email_tenantId: { email, tenantId } },
          update: { portalPasswordHash: hashedPassword },
          create: {
            name: name || email.split("@")[0],
            email,
            subBrand: "travelstall",
            status: "Lead",
            tenantId,
            portalPasswordHash: hashedPassword,
          },
        });
      } catch (e) {
        console.error(`[auth] customer/register portal-contact bridge failed (non-fatal): ${e.message}`);
      }
    }

    // Issue JWT
    const jwtPayload = {
      userId: user.id,
      role: 'CUSTOMER',
      wellnessRole: null,
      tenantId: tenantId,
      vertical: user.tenant?.vertical || "generic",
      userType: 'CUSTOMER',
      isOwner: false,
    };
    const token = signSessionToken(jwtPayload);

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, userType: 'CUSTOMER' },
      tenant: user.tenant ? { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug, vertical: user.tenant.vertical || "generic" } : null
    });

  } catch (error) {
    console.error("[auth] customer/register error:", error);
    res.status(500).json({ error: "Customer registration failed" });
  }
});

// Login Epic
// NOTE: Login throttling is handled at the server level via express-rate-limit
// (1000 req/15min on auth/login per server.js).
router.post("/login", async (req, res) => {
  try {
    const { email, password, loginTenantId } = req.body || {};

    // Input validation — without this, an empty body crashes findFirst with
    // PrismaClientValidationError (email: undefined). Return 400 instead.
    if (!email || typeof email !== "string" || !password || typeof password !== "string") {
      return res.status(400).json({ error: "email and password are required" });
    }

    // Admin/admin bypass intentionally removed for security hardening.

    // Email is unique per-tenant, not globally (see schema User model), so an
    // email can match an account in more than one org. The login form sends
    // the chosen org as `loginTenantId` (a non-stripped name — `tenantId`
    // would be deleted by stripDangerous). When supplied we scope to it; when
    // absent (legacy API callers) we fall back to the first match by email.
    const scopedTenantId = Number(loginTenantId);
    const tenantFilter = Number.isInteger(scopedTenantId) && scopedTenantId > 0
      ? { tenantId: scopedTenantId }
      : {};
    const user = await prisma.user.findFirst({ where: { email, ...tenantFilter }, include: { tenant: true } });
    // #192: when the email isn't found, run a dummy bcrypt compare against a
    // fixed-cost hash so the unknown-email path takes the same wall time as
    // the known-email-wrong-password path. Closes the timing-oracle that let
    // attackers enumerate valid emails without sending an "is this a user?"
    // request that would show up in IDS.
    if (!user) {
      // 2b$10 hash of "_no_user_dummy_" — never matches a real password.
      await bcrypt.compare(password, "$2b$10$CwTycUXWue0Thq9StjUM0uJ8jSxR0rfP3hXqDB0SEovQbYdcKqGVC");
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

    const tenantId = user.tenantId || 1;

    // Self-heal for signups created BEFORE provisionRbacForFreshTenant
    // was wired into /register + /signup. Those flows persisted the
    // tenant + user but never created the canonical Role rows or
    // RolePermission grants — the user holds User.role='ADMIN' (so the
    // legacy sidebar isAdmin gate passes) yet the resolver returns an
    // empty Set, collapsing every catalog-driven nav section. Detect
    // and repair here: if the user's tenant has no ADMIN role row, OR
    // if this admin user has no UserRole assignment at all, run the
    // provisioner before issuing the JWT. The provisioner is idempotent
    // (find-first-then-create) so a healthy session does a single
    // userRole.count and exits early. Wrapped so a failure during
    // self-heal can never block a legitimate login.
    if (user.userType !== 'OWNER' && user.tenantId) {
      try {
        const isLegacyAdmin = String(user.role || '').toUpperCase() === 'ADMIN';
        const userRoleCount = await prisma.userRole.count({ where: { userId: user.id } });
        if (isLegacyAdmin && userRoleCount === 0) {
          const vertical = user.tenant?.vertical || 'generic';
          await provisionRbacForFreshTenant(user.tenantId, vertical, user.id);
        }
      } catch (healErr) {
        console.warn(
          '[auth/login] RBAC self-heal failed (non-fatal):',
          healErr && healErr.message ? healErr.message : healErr,
        );
      }
    }

    // If 2FA is enabled, return short-lived temp token instead of final JWT.
    // Frontend must POST /api/auth/2fa/verify with { tempToken, code } to complete login.
    if (user.twoFactorEnabled) {
      const tempToken = jwt.sign(
        { userId: user.id, awaiting2FA: true },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({ requires2FA: true, tempToken });
    }

    // Issue #207/#214/#216: include wellnessRole on the JWT so verifyWellnessRole
    // (orthogonal to verifyRole) can gate clinical / operational endpoints
    // without re-reading the user row on every request.
    // #325: include vertical on the JWT so verifyWellnessRole can check
    // tenant vertical without an extra DB lookup per request.
    // RBAC: include userType and isOwner for new permission system
    const jwtPayload = {
      userId: user.id,
      role: user.role,
      wellnessRole: user.wellnessRole || null,
      tenantId,
      vertical: user.tenant?.vertical || "generic",
      userType: user.userType || 'STAFF',
      isOwner: user.userType === 'OWNER',
    };
    const token = signSessionToken(jwtPayload);

    // #555: Audit tenant session selection (Option C - single tenant per session)
    await writeAudit('Auth', 'LOGIN', user.id, user.id, tenantId, {
      email: user.email,
      tenantName: user.tenant?.name || 'Unknown',
      action: 'Tenant session locked',
      sessionInfo: 'Single tenant per session enforced'
    });

    // Resolve the user's primary RBAC role so the frontend can route to
    // its configured landingPath on login. Falls back gracefully through
    // UserRole join → legacy User.role string → null (vertical default).
    const primaryRole = await resolvePrimaryRole({ id: user.id, role: user.role, tenantId });

    setAuthCookie(res, token); // #914 slice 1 — additive HttpOnly cookie (no consumer reads it yet)
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        // userType lets the frontend route self-service customers to the
        // customer portal instead of the staff dashboard.
        userType: user.userType || 'STAFF',
        wellnessRole: user.wellnessRole || null,
        // Sub-brand access scope (travel vertical). Lets the sidebar switcher
        // render only the brands this user may activate; the authoritative gate
        // stays server-side (travelGuards.getSubBrandAccessSet). Null = full
        // access (admins / unset). Harmless extra field for non-travel clients.
        subBrandAccess: user.subBrandAccess || null,
        // #1123 — include profilePicture so the header avatar matches the
        // /me payload after re-login. Without this the frontend persists a
        // user object missing profilePicture, falls back to initials, and
        // appears to "revert" the avatar that the user just uploaded.
        profilePicture: user.profilePicture || null,
        primaryRole, // { id, key, name, landingPath } | null
        landingPath: primaryRole?.landingPath || null,
      },
      tenant: user.tenant ? { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug, plan: user.tenant.plan, vertical: user.tenant.vertical || "generic", country: user.tenant.country || "US", defaultCurrency: user.tenant.defaultCurrency || "USD", locale: user.tenant.locale || "en-US", logoUrl: user.tenant.logoUrl, brandColor: user.tenant.brandColor } : null
    });
  } catch (error) {
    console.error("[auth] login error:", error);
    res.status(500).json({ error: "Login system failure" });
  }
});

// Admin User Management — scoped to current tenant
router.get("/users", verifyToken, verifyRole(["ADMIN", "MANAGER"]), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true, email: true, name: true, role: true, createdAt: true }
    });
    res.json(users);
  } catch (_err) {
    res.status(500).json({ error: "Failed to fetch directory" });
  }
});

router.put("/users/:id/role", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { role } = req.body;
    // Ensure target user is in same tenant
    const target = await prisma.user.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!target) return res.status(404).json({ error: "User not found in your organization" });
    const user = await prisma.user.update({ where: { id: target.id }, data: { role } });
    // #179: audit role changes — these are privilege escalations / demotions
    // and are the most important security events to record. Skip a no-op
    // re-assignment of the same role.
    if (target.role !== user.role) {
      await writeAudit('User', 'UPDATE_USER_ROLE', user.id, req.user.userId, req.user.tenantId, {
        targetUserId: user.id,
        targetEmail: user.email,
        oldRole: target.role,
        newRole: user.role,
      });
    }
    res.json(user);
  } catch (_err) {
    res.status(500).json({ error: "Failed to update role" });
  }
});

router.delete("/users/:id", verifyToken, verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const target = await prisma.user.findFirst({ where: { id: parseInt(req.params.id), tenantId: req.user.tenantId } });
    if (!target) return res.status(404).json({ error: "User not found in your organization" });
    // #179: write audit BEFORE the destructive delete so the row exists even
    // if the cascade fails. User model has no deletedAt column (verified in
    // schema.prisma) so this is a hard delete — the audit row is the only
    // post-mortem trail of the deleted account's metadata.
    await writeAudit('User', 'DELETE_USER', target.id, req.user.userId, req.user.tenantId, {
      targetUserId: target.id,
      targetEmail: target.email,
      targetName: target.name,
      targetRole: target.role,
    });
    await prisma.user.delete({ where: { id: target.id } });
    res.json({ success: true });
  } catch (_err) {
    res.status(500).json({ error: "Failed to obliterate user" });
  }
});

// Forgot Password — generate reset token + email it via SendGrid
//
// #526 (CRIT-01) HARDENING (2026-05-06): the response body NO LONGER contains
// the reset token. Previously `response.resetToken = token` returned a valid
// reset token to any unauthenticated caller — full account takeover for any
// known email. Token now ships via SendGrid only; if SENDGRID_API_KEY is
// unset the link is logged to server stdout (dev/local fallback). The
// SendGrid call is fire-and-forget so response timing is identical for
// known and unknown emails, mitigating the user-enumeration oracle (HI-02 /
// #531). Carries a regression-guard test in e2e/tests/forgot-password.spec.js
// that asserts the response body never contains a `resetToken`/`token` field.
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    // Email is unique per-tenant now, so findFirst (not findUnique). If the
    // same email exists in multiple orgs this resets the first match; a future
    // enhancement could disambiguate by org, but the common case is one org.
    const user = await prisma.user.findFirst({ where: { email } });

    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      // Persist (DB, memory-fallback) — fire-and-forget to preserve the
      // anti-enumeration timing (response goes out before any round-trip).
      storeResetToken(token, user.id, new Date(Date.now() + 3600000)).catch(() => {}); // 1 hour
      // Fire-and-forget. The .catch is just so an unhandled-rejection log
      // doesn't fire — sendPasswordResetEmail already swallows + logs all
      // errors internally.
      // Reset links must target the FRONTEND SPA page (/reset-password), not
      // the auth-guarded API. Strip a trailing slash AND a stray "/api"
      // suffix so a deployment whose FRONTEND_URL is mistakenly set to the
      // API base (e.g. https://host/api) still produces a working SPA link
      // instead of https://host/api/reset-password → "Authentication required".
      const frontendBase = (process.env.FRONTEND_URL || `https://${req.headers.host || "crm.globusdemos.com"}`)
        .replace(/\/+$/, "")
        .replace(/\/api$/i, "");
      sendPasswordResetEmail(user.email, token, frontendBase).catch(() => { });
    }

    // Identical body for known + unknown emails (anti-enumeration). Token
    // is delivered via the email channel only — never in this response.
    res.json({ status: "ack", code: "RESET_LINK_REQUESTED" }); // #550
  } catch (_error) {
    res.status(500).json({ error: "Failed to process password reset request" });
  }
});

// Reset Password — consume token and set new password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: "Token and new password are required" });

    // #711 (HIGH): apply the same complexity policy to password-reset that
    // /register and PUT /auth/me enforce — otherwise an attacker who phishes
    // a reset link could set a 1-char password and the user would never see
    // an error from the client UI.
    const pwErr = validatePasswordComplexity(newPassword);
    if (pwErr) return res.status(400).json({ error: pwErr, code: 'WEAK_PASSWORD' });
    if (typeof newPassword !== 'string' || newPassword.length > 72) {
      return res.status(400).json({
        error: 'Password must be 72 characters or fewer',
        code: 'PASSWORD_TOO_LONG',
      });
    }

    const entry = await consumeResetToken(token);
    if (!entry) return res.status(400).json({ error: "Invalid or expired reset token" });
    if (entry.error) return res.status(400).json({ error: entry.error });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const targetUser = await prisma.user.update({
      where: { id: entry.userId },
      data: { password: hashedPassword },
      select: { id: true, email: true, tenantId: true },
    });
    // Token already consumed (marked used / removed) by consumeResetToken above.

    // #179: audit completed password reset. The reset-password endpoint is
    // unauthenticated (the token IS the auth), so userId on the audit row is
    // the target user themselves, not an actor. CRITICAL: never include the
    // password value (or its hash) in the details blob.
    await writeAudit('User', 'PASSWORD_RESET_COMPLETED', targetUser.id, targetUser.id, targetUser.tenantId, {
      targetUserId: targetUser.id,
      targetEmail: targetUser.email,
      via: 'reset-token',
    });

    res.json({ status: "ok", code: "PASSWORD_RESET_OK" }); // #550
  } catch (_error) {
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// Get current user profile (with tenant info)
router.get("/me", verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      // ssoProvider + twoFactorEnabled are additive (no consumer strips the
      // envelope) — the Profile danger zone uses them to decide whether the
      // delete-account flow asks for a current password and/or a TOTP code.
      select: { id: true, name: true, email: true, role: true, wellnessRole: true, subBrandAccess: true, profilePicture: true, tenantId: true, createdAt: true, ssoProvider: true, twoFactorEnabled: true, tenant: { select: { id: true, name: true, slug: true, plan: true, vertical: true, country: true, defaultCurrency: true, locale: true, logoUrl: true, brandColor: true } } }
    });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // T1.2: surface tenant-scoped feature flags so the frontend can gate
    // UI it can't deliver right now. SMS provider is the first one — when
    // no provider is configured (no SmsConfig DB row + no MSG91/Twilio/
    // Fast2SMS env vars), the patient portal phone+OTP flow is broken-by-
    // default (cron drains queued messages as FAILED per #182). Frontend
    // checks `features.smsConfigured` and hides/disables OTP UI when false
    // instead of silently sending users to a dead end.
    let smsConfigured = false;
    try {
      const { resolveProviderConfig } = require("../services/smsProvider");
      const cfg = await resolveProviderConfig(prisma, user.tenant?.id);
      smsConfigured = !!cfg;
    } catch (_e) {
      smsConfigured = false;
    }

    // Carry primaryRole + landingPath on /me so a page-refresh restores the
    // same routing context the login response gave us.
    const primaryRole = await resolvePrimaryRole({ id: user.id, role: user.role, tenantId: user.tenantId });

    res.json({
      ...user,
      tenantId: undefined, // hide raw FK; client should use user.tenant.id
      primaryRole,
      landingPath: primaryRole?.landingPath || null,
      features: { smsConfigured },
    });
  } catch (_error) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// GET /api/auth/me/permissions — return merged permissions from all assigned roles
router.get("/me/permissions", verifyToken, async (req, res) => {
  try {
    const { getUserPermissions } = require("../middleware/requirePermission");

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      include: {
        userRoles: {
          include: { role: true }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Build response: OWNER always returns empty permission list (short-circuit)
    if (req.user.isOwner) {
      return res.json({
        isOwner: true,
        userType: 'OWNER',
        roles: ['OWNER'],
        permissions: [], // OWNER bypasses all checks at middleware level
        primaryRole: null,
        landingPath: null,
      });
    }

    // Load merged permissions for non-OWNER users
    const permissions = await getUserPermissions(req.user.tenantId, req.user.userId);
    const permissionArray = Array.from(permissions).sort();

    // Extract role names from userRoles
    const roleNames = user.userRoles.map(ur => ur.role.key);

    // Single-role-per-user: surface the primary role + its landing path so
    // the frontend doesn't need a second round-trip to figure out where to
    // route this user. Falls back through the same precedence as
    // /api/auth/login (UserRole join → legacy User.role string → null).
    const primaryRole = await resolvePrimaryRole({
      id: user.id,
      role: user.role,
      tenantId: req.user.tenantId,
    });

    res.json({
      isOwner: false,
      userType: user.userType || 'STAFF',
      roles: roleNames,
      permissions: permissionArray,
      primaryRole,
      landingPath: primaryRole?.landingPath || null,
    });
  } catch (_error) {
    console.error("[auth/me/permissions] error:", _error);
    res.status(500).json({ error: "Failed to fetch permissions" });
  }
});

// Update current user profile
router.put("/me", verifyToken, async (req, res) => {
  try {
    const { name, email, currentPassword, newPassword } = req.body;
    const updateData = {};

    if (name) updateData.name = name;

    if (email) {
      // Email is unique per-tenant — only block if another account IN THE
      // SAME tenant already uses it.
      const existing = await prisma.user.findFirst({ where: { email, tenantId: req.user.tenantId } });
      if (existing && existing.id !== req.user.userId) {
        return res.status(400).json({ error: "Email already in use by another account" });
      }
      updateData.email = email;
    }

    // Password change requires current password verification
    if (newPassword) {
      if (!currentPassword) return res.status(400).json({ error: "Current password is required to set a new password" });

      // #711 (HIGH): enforce the same password-complexity policy used by
      // /register, /signup, /reset-password on PUT /auth/me as well. Pre-fix
      // this endpoint accepted ANY string as newPassword — a 1-char or
      // all-letters password was a regression of the #526 / #531 auth-
      // hardening work. Reuses validatePasswordComplexity() defined above.
      const pwErr = validatePasswordComplexity(newPassword);
      if (pwErr) return res.status(400).json({ error: pwErr, code: 'WEAK_PASSWORD' });

      // #711 (HIGH): bcrypt silently truncates inputs > 72 bytes, which
      // means any password longer than 72 chars matches its first-72-bytes
      // prefix forever — a real footgun, not a theoretical one. Reject
      // before hashing so the caller gets a clean error message.
      if (typeof newPassword !== 'string' || newPassword.length > 72) {
        return res.status(400).json({
          error: 'Password must be 72 characters or fewer',
          code: 'PASSWORD_TOO_LONG',
        });
      }

      const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      if (!isMatch) return res.status(400).json({ error: "Current password is incorrect" });

      updateData.password = await bcrypt.hash(newPassword, 10);
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user.userId },
      data: updateData,
      select: { id: true, name: true, email: true, role: true, profilePicture: true, createdAt: true }
    });

    // #179: audit profile changes. CRITICAL: never include the password value
    // (or its hash) in the details blob — log only that a password change
    // happened, with a separate PASSWORD_CHANGE action so it shows up cleanly
    // in the audit-log filter UI.
    const changedKeys = Object.keys(updateData).filter((k) => k !== 'password');
    if (changedKeys.length > 0) {
      const safeChanges = {};
      for (const k of changedKeys) safeChanges[k] = updateData[k];
      await writeAudit('User', 'UPDATE_PROFILE', updatedUser.id, req.user.userId, req.user.tenantId, {
        changedFields: safeChanges,
      });
    }
    if (updateData.password !== undefined) {
      await writeAudit('User', 'PASSWORD_CHANGE', updatedUser.id, req.user.userId, req.user.tenantId, {
        // No password / hash anywhere — only the fact and timestamp.
        via: 'self-service',
      });
    }

    res.json(updatedUser);
  } catch (_error) {
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// POST /api/auth/me/profile-picture — upload (or replace) the signed-in
// user's avatar. multipart/form-data with a single `file` field. On
// replace, the previous S3 object is deleted so the bucket doesn't
// accumulate orphans. The delete is best-effort: a failure to remove the
// old key is logged but does not fail the upload (the new picture is
// already in S3 and the DB pointer would otherwise be stale).
router.post(
  "/me/profile-picture",
  verifyToken,
  profilePictureUploadHandler,
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: "No file uploaded", code: "NO_FILE" });
      }

      const existing = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { id: true, profilePicture: true },
      });
      if (!existing) {
        return res.status(404).json({ error: "User not found" });
      }

      let newUrl;
      try {
        newUrl = await s3Service.uploadImage(
          req.file.buffer,
          req.file.originalname || "profile.jpg",
          req.file.mimetype,
          `avatars/${req.user.userId}`,
        );
      } catch (uploadErr) {
        if (/Invalid image MIME type/.test(uploadErr.message || "")) {
          return res.status(415).json({
            error: "Profile picture must be an image (jpeg/png/gif/webp/svg)",
            code: "UNSUPPORTED_MEDIA",
          });
        }
        if (/S3 bucket not configured/.test(uploadErr.message || "")) {
          return res.status(503).json({
            error: "Profile picture storage is not configured",
            code: "STORAGE_UNCONFIGURED",
          });
        }
        throw uploadErr;
      }

      const updated = await prisma.user.update({
        where: { id: req.user.userId },
        data: { profilePicture: newUrl },
        select: { id: true, name: true, email: true, role: true, profilePicture: true },
      });

      // Best-effort delete of the previous S3 object so we don't leak
      // orphan avatars on every replace.
      if (existing.profilePicture && existing.profilePicture !== newUrl) {
        const oldKey = s3Service.extractKeyFromUrl(existing.profilePicture);
        if (oldKey) {
          try {
            await s3Service.deleteFile(oldKey);
          } catch (delErr) {
            console.warn(
              "[auth/me/profile-picture] failed to delete previous S3 key:",
              oldKey,
              delErr.message,
            );
          }
        }
      }

      await writeAudit(
        "User",
        "UPDATE_PROFILE_PICTURE",
        updated.id,
        req.user.userId,
        req.user.tenantId,
        { replaced: !!existing.profilePicture },
      );

      res.json(updated);
    } catch (err) {
      console.error("[auth/me/profile-picture] upload error:", err && err.message);
      res.status(500).json({ error: "Failed to upload profile picture" });
    }
  },
);

// DELETE /api/auth/me/profile-picture — clear the avatar + remove the S3
// object. Idempotent: returns 200 with profilePicture:null whether or not
// one was set.
router.delete("/me/profile-picture", verifyToken, async (req, res) => {
  try {
    const existing = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, profilePicture: true },
    });
    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }

    if (existing.profilePicture) {
      const key = s3Service.extractKeyFromUrl(existing.profilePicture);
      if (key) {
        try {
          await s3Service.deleteFile(key);
        } catch (delErr) {
          console.warn(
            "[auth/me/profile-picture] failed to delete S3 key:",
            key,
            delErr.message,
          );
        }
      }
    }

    const updated = await prisma.user.update({
      where: { id: req.user.userId },
      data: { profilePicture: null },
      select: { id: true, name: true, email: true, role: true, profilePicture: true },
    });

    if (existing.profilePicture) {
      await writeAudit(
        "User",
        "DELETE_PROFILE_PICTURE",
        updated.id,
        req.user.userId,
        req.user.tenantId,
        {},
      );
    }

    res.json(updated);
  } catch (err) {
    console.error("[auth/me/profile-picture] delete error:", err && err.message);
    res.status(500).json({ error: "Failed to remove profile picture" });
  }
});

// DELETE /api/auth/me/account — self-service account deletion (all verticals).
//
// Privacy policy §10.1 promises in-app account deletion; this is that
// endpoint. Hard delete, irreversible — relations on User carry explicit
// onDelete rules (Cascade for personal rows like Notification/ApiKey/
// Attendance, SetNull for shared business records like Deal/Task/Activity)
// so a bare user.delete is safe and leaves tenant business data intact.
//
// Scope rules:
//   - sole user of the tenant     → delete the whole TENANT (every model
//     carries tenant onDelete: Cascade, so this erases all workspace data —
//     a personal workspace with no remaining members must not orphan data)
//   - last ADMIN, others remain   → 409 LAST_ADMIN (transfer admin first;
//     deleting would orphan the workspace for the remaining members)
//   - everyone else               → delete the USER row only
//
// Re-authentication (mirrors the 2FA-disable bar in auth_2fa.js):
//   - password accounts must present the current password
//   - SSO accounts hold an unusable random hash (routes/sso.js) so the
//     confirmDestructive flag is their bar — they re-auth via their IdP
//   - 2FA-enabled accounts must also present a valid TOTP code
router.delete("/me/account", verifyToken, async (req, res) => {
  try {
    const { password, code, confirmDestructive } = req.body || {};

    // Same explicit-confirmation gate as the GDPR retention endpoints —
    // a stray scripted DELETE without the flag must not erase an account.
    if (confirmDestructive !== true) {
      return res.status(400).json({
        error: "Account deletion requires explicit confirmation",
        code: "CONFIRMATION_REQUIRED",
      });
    }

    const user = await prisma.user.findFirst({
      where: { id: req.user.userId, tenantId: req.user.tenantId },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const isSsoAccount = !!user.ssoProvider;
    if (!isSsoAccount) {
      if (!password) {
        return res.status(400).json({
          error: "Current password is required to delete your account",
          code: "PASSWORD_REQUIRED",
        });
      }
      const passwordOk = await bcrypt.compare(password, user.password);
      if (!passwordOk) {
        return res.status(400).json({
          error: "Current password is incorrect",
          code: "PASSWORD_INCORRECT",
        });
      }
    }

    if (user.twoFactorEnabled) {
      const totpOk =
        !!code &&
        speakeasy.totp.verify({
          secret: user.twoFactorSecret,
          encoding: "base32",
          token: String(code).trim(),
          window: 1,
        });
      if (!totpOk) {
        return res.status(400).json({
          error: "A valid two-factor verification code is required",
          code: "TOTP_REQUIRED",
        });
      }
    }

    const otherUsers = await prisma.user.count({
      where: { tenantId: req.user.tenantId, id: { not: user.id } },
    });
    const deleteScope = otherUsers === 0 ? "tenant" : "user";

    if (deleteScope === "user" && user.role === "ADMIN") {
      const otherAdmins = await prisma.user.count({
        where: {
          tenantId: req.user.tenantId,
          id: { not: user.id },
          role: "ADMIN",
          deactivatedAt: null,
        },
      });
      if (otherAdmins === 0) {
        return res.status(409).json({
          error:
            "You are the only admin of this organization. Promote another member to admin before deleting your account.",
          code: "LAST_ADMIN",
        });
      }
    }

    // Audit BEFORE the destructive delete (mirrors DELETE /users/:id) so a
    // mid-cascade failure still leaves a trail. For tenant-scope deletions
    // the audit row itself is cascaded away with the tenant — full erasure
    // is the intent there, so that is correct, not a gap.
    await writeAudit("User", "DELETE_ACCOUNT_SELF", user.id, user.id, req.user.tenantId, {
      email: user.email,
      name: user.name,
      role: user.role,
      scope: deleteScope,
      ssoProvider: user.ssoProvider || null,
    });

    if (deleteScope === "tenant") {
      await prisma.tenant.delete({ where: { id: req.user.tenantId } });
    } else {
      await prisma.user.delete({ where: { id: user.id } });
    }

    // Kill the session on the same response: drop the HttpOnly cookie and
    // revoke the jti so the bearer dies server-side immediately (the
    // frontend also clears its local copy and redirects to /login).
    clearAuthCookie(res);
    if (req.user.jti) {
      try {
        await prisma.revokedToken.upsert({
          where: { jti: req.user.jti },
          update: {},
          create: {
            jti: req.user.jti,
            userId: user.id,
            tenantId: req.user.tenantId,
            expiresAt: jtiExpiresAt(req),
            reason: "account_deleted",
          },
        });
      } catch (revokeErr) {
        // Tenant-scope deletions cascade RevokedToken's tenant FK away, so
        // this insert can fail — the tenant (and all its data) is already
        // gone, so the orphaned-but-signed JWT can only reach empty scopes
        // until its natural expiry. Non-fatal by design.
        console.warn("[auth/me/account] post-delete jti revoke failed:", revokeErr.message);
      }
    }

    res.json({ ok: true, deleted: deleteScope });
  } catch (err) {
    console.error("[auth/me/account] delete error:", err && err.message);
    res.status(500).json({ error: "Failed to delete account" });
  }
});

// ---------- Issue #555 (HI-06): tenant access — LOCK PER SESSION ----------
//
// Pre-fix, the SPA's tenant context flipped silently based purely on URL
// pathname (/dashboard vs /wellness) — no switcher in the chrome, no
// audit entry on the flip, localStorage.tenant could disagree with the
// rendered shell. Privilege-confusion surface.
//
// POLICY (v3.7.3): lock-per-session. A user picks their tenant at LOGIN
// and cannot switch without logging out. Rationale: the JWT's tenantId
// is the only trustworthy scope boundary for per-tenant data isolation;
// any in-session switcher creates a window where the JWT and the
// rendered shell can disagree, and pen-test flagged that window as a
// privilege-confusion surface. The accountability surface is the LOGIN
// audit row emitted on every successful authentication.
//
// DATA MODEL: today every user has exactly one tenantId (User.tenantId
// is an Int @default(1), no UserTenant join table). When a UserTenant
// join table eventually lands, the policy stays the same: pick at login,
// log out to switch — only the login page would need a tenant-picker
// dropdown for users with multi-tenant access.
//
// /tenants — kept (read-only list, used by the topbar tenant chip).
// /tenant-switch — DEPRECATED, always returns 410 Gone with code
// TENANT_SWITCH_DISABLED + hint. Logout + login is the documented path.

// GET /api/auth/tenants — list of tenants the caller can switch into.
// Today: always [currentTenant]. Documented future-proofing point.
router.get("/tenants", verifyToken, async (req, res) => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { id: true, name: true, slug: true, vertical: true, plan: true, defaultCurrency: true, locale: true, country: true },
    });
    if (!tenant) return res.json({ tenants: [], activeTenantId: req.user.tenantId });
    return res.json({ tenants: [tenant], activeTenantId: req.user.tenantId });
  } catch (_e) {
    return res.status(500).json({ error: "Failed to load tenants" });
  }
});

// POST /api/auth/tenant-switch — DEPRECATED under the lock-per-session
// policy. Always returns 410 Gone with code TENANT_SWITCH_DISABLED.
// Clients that previously called this endpoint should redirect to the
// logout flow + present the login page; users pick their tenant at login
// and the JWT's tenantId is fixed for the rest of the session.
router.post("/tenant-switch", verifyToken, async (req, res) => {
  return res.status(410).json({
    error: "Tenant switching is disabled. Log out and log in again to access a different tenant.",
    code: "TENANT_SWITCH_DISABLED",
    hint: "POST /api/auth/logout, then /api/auth/login with the destination tenant's credentials.",
  });
});

// ---------- Issue #180: session revocation ----------
//
// Pre-#180 the system had no way to invalidate a JWT before its 7-day TTL —
// stolen tokens stayed live, "log out" was just a localStorage delete on the
// client. Now every login mints a token with a unique `jti`, and we can
// blacklist that jti in the RevokedToken table. verifyToken consults the
// table on every request.
//
// Backwards-compat note: tokens issued before this change have no jti claim
// and can't be revoked individually. They still verify normally and expire
// on their own 7-day clock — no forced re-login at deploy time.

// Compute the jti's expiry from the JWT's own `exp` claim. If exp is missing
// (extremely old token), fall back to "now + 7d" so the row still gets cleaned
// up by the future cron purge instead of sticking around forever.
function jtiExpiresAt(req) {
  if (req.user && typeof req.user.exp === "number") {
    return new Date(req.user.exp * 1000);
  }
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

// POST /api/auth/logout — revoke the current session.
router.post("/logout", verifyToken, async (req, res) => {
  try {
    // #914 slice 1 — drop the additive HttpOnly cookie regardless of which
    // path we take below. Safe to call even if the cookie was never set
    // (the browser ignores clearCookie for an absent cookie). Must happen
    // BEFORE any res.json() so the Set-Cookie clear header rides on the
    // success response.
    clearAuthCookie(res);

    if (!req.user || !req.user.jti) {
      // Old token (no jti). The client should still clear local storage; we
      // can't add it to the blacklist because we have no stable identifier.
      return res.json({ ok: true, revoked: false, reason: "legacy_token_no_jti" });
    }
    await prisma.revokedToken.upsert({
      where: { jti: req.user.jti },
      update: {}, // already revoked, no-op
      create: {
        jti: req.user.jti,
        userId: req.user.userId,
        tenantId: req.user.tenantId,
        expiresAt: jtiExpiresAt(req),
        reason: "user_logout",
      },
    });

    // #569: emit AuditLog 'User' 'LOGOUT' so session-end events surface in
    // /api/audit alongside session-start events. SOC2 / DPDP audit trails
    // require both halves. Non-fatal — the JWT revocation above is the
    // security-critical primitive; audit-log failure must not break the
    // response.
    try {
      await writeAudit('User', 'LOGOUT', req.user.userId, req.user.userId, req.user.tenantId, {
        jti: req.user.jti || null,
      });
    } catch (auditErr) {
      console.warn('[auth/logout] audit failed:', auditErr.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[auth] logout error:", err);
    res.status(500).json({ error: "Failed to log out" });
  }
});

// GET /api/auth/sessions — list this user's revoked-session history.
//
// Caveat: we don't yet track ACTIVE sessions explicitly (that would require an
// IssuedToken table populated at login — out of scope for #180). What we DO
// track is the revocation history. The UI can show this as "Recently signed-out
// devices" and offer a "Sign out everywhere" action that revokes the current
// jti (and, once IssuedToken lands, every other active jti).
router.get("/sessions", verifyToken, async (req, res) => {
  try {
    const revoked = await prisma.revokedToken.findMany({
      where: { userId: req.user.userId, tenantId: req.user.tenantId },
      orderBy: { revokedAt: "desc" },
      take: 50,
      select: {
        jti: true,
        revokedAt: true,
        expiresAt: true,
        reason: true,
      },
    });
    res.json({
      currentJti: req.user.jti || null,
      // #180 limitation: no IssuedToken table yet, so we can't enumerate live
      // sessions. We surface the revocation history instead and document the
      // gap for the next iteration.
      activeSessions: req.user.jti
        ? [{ jti: req.user.jti, current: true }]
        : [],
      revokedSessions: revoked,
      note: "Active session enumeration requires an IssuedToken table (planned, not in #180). Revoked history is authoritative.",
    });
  } catch (err) {
    console.error("[auth] sessions list error:", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// DELETE /api/auth/sessions/:jti — revoke a specific session.
//
// Used by a future "Active sessions" UI: user clicks "Sign out" next to a
// device row, the row's jti gets posted here. We only let a user revoke their
// OWN tokens — admins killing other users' sessions belongs in a separate
// admin endpoint, not here.
router.delete("/sessions/:jti", verifyToken, async (req, res) => {
  try {
    const { jti } = req.params;
    if (!jti || typeof jti !== "string" || jti.length < 8 || jti.length > 64) {
      return res.status(400).json({ error: "Invalid session id" });
    }
    // Self-revocation only: we don't have an IssuedToken table to check the
    // owner, so we trust the jti claim on the *current* token if it matches,
    // and otherwise just record the revocation tagged with the caller's
    // userId/tenantId. Result: a malicious caller could at worst burn an
    // unknown jti, which is harmless (it'd 401 next time anyway).
    await prisma.revokedToken.upsert({
      where: { jti },
      update: {}, // already revoked
      create: {
        jti,
        userId: req.user.userId,
        tenantId: req.user.tenantId,
        // We don't know the target token's exp, so use 7d window for cleanup.
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        reason: jti === req.user.jti ? "user_logout" : "session_revoked_by_user",
      },
    });
    res.json({ ok: true, jti });
  } catch (err) {
    console.error("[auth] session revoke error:", err);
    res.status(500).json({ error: "Failed to revoke session" });
  }
});

module.exports = router;
