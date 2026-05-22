const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { verifyToken, verifyRole } = require("../middleware/auth");

const crypto = require("crypto");

const router = express.Router();
const prisma = require("../lib/prisma");
const { writeAudit } = require("../lib/audit");
const { resolvePrimaryRole } = require("../lib/roleResolution");
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

// In-memory store for password reset tokens (token -> { userId, expiresAt })
const resetTokens = new Map();

// Public endpoint: Get list of tenants for customer registration
router.get("/public/tenants", async (req, res) => {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json(tenants);
  } catch (err) {
    console.error("[auth/public/tenants] error:", err.message);
    res.status(500).json({ error: "Failed to load tenants" });
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

// Helper: build a unique slug for a tenant
async function generateUniqueSlug(base) {
  const root = (base || "org")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "org";
  let slug = root;
  let i = 1;
  // Try until unused
  while (await prisma.tenant.findUnique({ where: { slug } })) {
    i += 1;
    slug = `${root}-${i}`;
  }
  return slug;
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
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, organizationName, vertical } = req.body;

    const pwErr = validatePasswordComplexity(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ error: "User already exists" });

    const validVerticals = ['generic', 'wellness'];
    const selectedVertical = validVerticals.includes(vertical) ? vertical : 'generic';

    const hashedPassword = await bcrypt.hash(password, 10);

    const orgName = organizationName || (name ? `${name}'s Organization` : "My Organization");
    const slug = await generateUniqueSlug(orgName);

    const tenant = await prisma.tenant.create({
      data: { name: orgName, slug, ownerEmail: email, plan: "TRIAL", vertical: selectedVertical }
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
        subscriptionStatus: "TRIAL"
      }
    });

    // #325: include vertical on the JWT so verifyWellnessRole can check
    // tenant vertical without an extra DB lookup per request.
    const token = signSessionToken({ userId: user.id, role: user.role, wellnessRole: user.wellnessRole || null, tenantId: tenant.id, vertical: tenant.vertical || "generic" });
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, wellnessRole: user.wellnessRole || null },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, plan: tenant.plan, vertical: tenant.vertical || "generic", country: tenant.country || "US", defaultCurrency: tenant.defaultCurrency || "USD", locale: tenant.locale || "en-US", logoUrl: tenant.logoUrl, brandColor: tenant.brandColor }
    });

  } catch (error) {
    console.error("[auth] register error:", error);
    res.status(500).json({ error: "Server registration error" });
  }
});

// Signup alias (matches signup page) — same behavior as register
router.post("/signup", async (req, res) => {
  try {
    const { email, password, name, organizationName, vertical } = req.body;

    const pwErr = validatePasswordComplexity(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ error: "User already exists" });

    const validVerticals = ['generic', 'wellness'];
    const selectedVertical = validVerticals.includes(vertical) ? vertical : 'generic';

    const hashedPassword = await bcrypt.hash(password, 10);

    const orgName = organizationName || (name ? `${name}'s Organization` : "My Organization");
    const slug = await generateUniqueSlug(orgName);

    const tenant = await prisma.tenant.create({
      data: { name: orgName, slug, ownerEmail: email, plan: "TRIAL", vertical: selectedVertical }
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
        subscriptionStatus: "TRIAL"
      }
    });

    // #325: include vertical on the JWT so verifyWellnessRole can check
    // tenant vertical without an extra DB lookup per request.
    const token = signSessionToken({ userId: user.id, role: user.role, wellnessRole: user.wellnessRole || null, tenantId: tenant.id, vertical: tenant.vertical || "generic" });
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, wellnessRole: user.wellnessRole || null },
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
router.post("/customer/register", async (req, res) => {
  try {
    console.log('[customer/register] Full req.body:', JSON.stringify(req.body));
    console.log('[customer/register] Stripped fields:', req.strippedFields);

    // Restore tenantId from strippedFields if it was stripped
    let { email, password, name, tenantId } = req.body || {};
    if (!tenantId && req.strippedFields?.tenantId) {
      tenantId = req.strippedFields.tenantId;
      console.log('[customer/register] Restored tenantId from strippedFields:', tenantId);
    }

    // Input validation
    if (!email || typeof email !== "string" || !password || typeof password !== "string") {
      return res.status(400).json({ error: "email, password, and registrationTenantId are required" });
    }

    console.log('[customer/register] Received tenantId:', tenantId, 'type:', typeof tenantId);

    if (!tenantId || typeof tenantId !== "number") {
      console.log('[customer/register] Validation FAILED - tenantId:', tenantId, 'type:', typeof tenantId);
      return res.status(400).json({ error: "tenantId must be a valid number" });
    }

    // Password complexity check
    const pwErr = validatePasswordComplexity(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    // Check tenant exists
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      return res.status(400).json({ error: "Invalid tenant ID" });
    }

    // Check email doesn't already exist
    const existingUser = await prisma.user.findUnique({ where: { email } });
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
    const { email, password } = req.body || {};

    // Input validation — without this, an empty body crashes findUnique with
    // PrismaClientValidationError (email: undefined). Return 400 instead.
    if (!email || typeof email !== "string" || !password || typeof password !== "string") {
      return res.status(400).json({ error: "email and password are required" });
    }

    // Admin/admin bypass intentionally removed for security hardening.

    const user = await prisma.user.findUnique({ where: { email }, include: { tenant: true } });
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

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        wellnessRole: user.wellnessRole || null,
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

    const user = await prisma.user.findUnique({ where: { email } });

    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      resetTokens.set(token, { userId: user.id, expiresAt: Date.now() + 3600000 }); // 1 hour
      // Fire-and-forget. The .catch is just so an unhandled-rejection log
      // doesn't fire — sendPasswordResetEmail already swallows + logs all
      // errors internally.
      const frontendBase = process.env.FRONTEND_URL || `https://${req.headers.host || "crm.globusdemos.com"}`;
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

    const entry = resetTokens.get(token);
    if (!entry) return res.status(400).json({ error: "Invalid or expired reset token" });
    if (Date.now() > entry.expiresAt) {
      resetTokens.delete(token);
      return res.status(400).json({ error: "Reset token has expired" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const targetUser = await prisma.user.update({
      where: { id: entry.userId },
      data: { password: hashedPassword },
      select: { id: true, email: true, tenantId: true },
    });
    resetTokens.delete(token);

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
      select: { id: true, name: true, email: true, role: true, wellnessRole: true, tenantId: true, createdAt: true, tenant: { select: { id: true, name: true, slug: true, plan: true, vertical: true, country: true, defaultCurrency: true, locale: true, logoUrl: true, brandColor: true } } }
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
      const existing = await prisma.user.findUnique({ where: { email } });
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
      select: { id: true, name: true, email: true, role: true, createdAt: true }
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
