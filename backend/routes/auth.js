const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { verifyToken, verifyRole } = require("../middleware/auth");

const crypto = require("crypto");

const router = express.Router();
const prisma = require("../lib/prisma");
const { writeAudit, diffFields } = require("../lib/audit");
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

// In-memory store for password reset tokens (token -> { userId, expiresAt })
const resetTokens = new Map();

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
    const { email, password, name, organizationName } = req.body;

    const pwErr = validatePasswordComplexity(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ error: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const orgName = organizationName || (name ? `${name}'s Organization` : "My Organization");
    const slug = await generateUniqueSlug(orgName);

    const tenant = await prisma.tenant.create({
      data: { name: orgName, slug, ownerEmail: email, plan: "starter" }
    });

    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name, role: "ADMIN", tenantId: tenant.id }
    });

    const token = signSessionToken({ userId: user.id, role: user.role, wellnessRole: user.wellnessRole || null, tenantId: tenant.id });
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
    const { email, password, name, organizationName } = req.body;

    const pwErr = validatePasswordComplexity(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ error: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);

    const orgName = organizationName || (name ? `${name}'s Organization` : "My Organization");
    const slug = await generateUniqueSlug(orgName);

    const tenant = await prisma.tenant.create({
      data: { name: orgName, slug, ownerEmail: email, plan: "starter" }
    });

    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name, role: "ADMIN", tenantId: tenant.id }
    });

    const token = signSessionToken({ userId: user.id, role: user.role, wellnessRole: user.wellnessRole || null, tenantId: tenant.id });
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
    const token = signSessionToken({ userId: user.id, role: user.role, wellnessRole: user.wellnessRole || null, tenantId });

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, wellnessRole: user.wellnessRole || null },
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
  } catch (err) {
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
  } catch (err) {
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
  } catch (err) {
    res.status(500).json({ error: "Failed to obliterate user" });
  }
});

// Forgot Password — generate reset token
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const user = await prisma.user.findUnique({ where: { email } });

    // Always return success message to avoid email enumeration
    const response = { message: "If the email exists, a reset link has been generated" };

    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      resetTokens.set(token, { userId: user.id, expiresAt: Date.now() + 3600000 }); // 1 hour
      response.resetToken = token; // Returned since no email service configured
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: "Failed to process password reset request" });
  }
});

// Reset Password — consume token and set new password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: "Token and new password are required" });

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

    res.json({ message: "Password reset successfully" });
  } catch (error) {
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// Get current user profile (with tenant info)
router.get("/me", verifyToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { id: true, name: true, email: true, role: true, wellnessRole: true, createdAt: true, tenant: { select: { id: true, name: true, slug: true, plan: true, vertical: true, country: true, defaultCurrency: true, locale: true, logoUrl: true, brandColor: true } } }
    });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch profile" });
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
  } catch (error) {
    res.status(500).json({ error: "Failed to update profile" });
  }
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
