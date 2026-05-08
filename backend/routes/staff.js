const express = require("express");
const crypto = require("crypto");
const { verifyRole } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");

const router = express.Router();
const prisma = require("../lib/prisma");

const VALID_ROLES = ["ADMIN", "MANAGER", "USER"];
const VALID_WELLNESS_ROLES = ["doctor", "professional", "telecaller", "helper", "stylist"];

// Module-scoped reset / invite token stores. Mirrors the pattern in
// routes/auth.js's `resetTokens` Map — in-memory, 1-hour TTL, hex-32 key.
// In a multi-instance deploy these would move to Redis; the demo box runs
// a single backend so a Map suffices.
const adminResetTokens = new Map();   // token -> { userId, expiresAt }
const inviteTokens = new Map();        // token -> { userId, expiresAt }

// SendGrid wrapper — fire-and-forget, never throws. Mirrors the contract in
// routes/auth.js sendPasswordResetEmail (kept local instead of importing so
// the two modules stay independently testable; promoting both into a shared
// lib/sendgrid.js is a separate cleanup tracked in TODOS).
async function sendEmail(toEmail, subject, plainText, html) {
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
  const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";
  if (!SENDGRID_API_KEY) {
    console.log(`[staff] SendGrid not configured — would send to ${toEmail}: ${subject}\n${plainText}`);
    return;
  }
  try {
    const payload = {
      personalizations: [{ to: [{ email: toEmail }] }],
      from: { email: FROM_EMAIL },
      subject,
      content: [
        { type: "text/plain", value: plainText },
        { type: "text/html", value: html || `<p>${plainText.replace(/\n/g, "<br>")}</p>` },
      ],
    };
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[staff] SendGrid error ${response.status}: ${text}`);
    }
  } catch (err) {
    console.error("[staff] SendGrid send failed:", err.message);
  }
}

// GET / — list users in current tenant (exclude password)
router.get("/", async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { tenantId: req.user.tenantId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        // #221: include wellnessRole so the wellness UI can filter for doctors,
        // professionals, telecallers, helpers. The Log Visit form's Doctor
        // dropdown was empty because this field wasn't returned and the
        // frontend filter `u.wellnessRole === 'doctor'` matched nothing.
        wellnessRole: true,
        createdAt: true,
        // #618 — surface deactivatedAt so the directory can flag inactive rows
        // (UI renders an "Inactive" badge; the row stays in the list so an
        // admin can re-activate it instead of having to soul-search the audit log).
        deactivatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(users);
  } catch (_err) {
    res.status(500).json({ error: "Failed to fetch staff." });
  }
});

// PUT /:id/role — update user role (ADMIN only)
router.put("/:id/role", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { role } = req.body;

    if (!role || !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` });
    }

    const userId = parseInt(req.params.id, 10);

    // Prevent self-demotion
    if (req.user.userId === userId && role !== "ADMIN") {
      return res.status(400).json({ error: "Cannot change your own role." });
    }

    const target = await prisma.user.findFirst({ where: { id: userId, tenantId: req.user.tenantId } });
    if (!target) return res.status(404).json({ error: "User not found." });

    const user = await prisma.user.update({
      where: { id: target.id },
      data: { role },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });
    res.json(user);
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "User not found." });
    }
    res.status(500).json({ error: "Failed to update role." });
  }
});

// PUT /:id — edit user fields (ADMIN only). #618 — Settings Staff Directory
// row-edit. Allows changing name, email, role, wellnessRole. Email uniqueness
// is enforced by Prisma's @unique constraint; we surface a 409 on collision.
router.put("/:id", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "Invalid user id." });
    }

    const target = await prisma.user.findFirst({ where: { id: userId, tenantId: req.user.tenantId } });
    if (!target) return res.status(404).json({ error: "User not found." });

    const { name, email, role, wellnessRole } = req.body || {};
    const data = {};
    const changed = {};

    if (typeof name === "string" && name.trim() !== target.name) {
      data.name = name.trim() || null;
      changed.name = { from: target.name, to: data.name };
    }
    if (typeof email === "string" && email.trim() && email.trim() !== target.email) {
      data.email = email.trim();
      changed.email = { from: target.email, to: data.email };
    }
    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}` });
      }
      // Prevent self-demotion (mirror PUT /:id/role guard)
      if (req.user.userId === userId && role !== "ADMIN" && target.role === "ADMIN") {
        return res.status(400).json({ error: "Cannot change your own role." });
      }
      if (role !== target.role) {
        data.role = role;
        changed.role = { from: target.role, to: role };
      }
    }
    if (wellnessRole !== undefined) {
      if (wellnessRole !== null && !VALID_WELLNESS_ROLES.includes(wellnessRole)) {
        return res.status(400).json({ error: `Invalid wellnessRole. Must be one of: ${VALID_WELLNESS_ROLES.join(", ")} or null` });
      }
      if (wellnessRole !== target.wellnessRole) {
        data.wellnessRole = wellnessRole;
        changed.wellnessRole = { from: target.wellnessRole, to: wellnessRole };
      }
    }

    if (Object.keys(data).length === 0) {
      // No-op edit — return current row without writing audit.
      return res.json({
        id: target.id,
        email: target.email,
        name: target.name,
        role: target.role,
        wellnessRole: target.wellnessRole,
        createdAt: target.createdAt,
        deactivatedAt: target.deactivatedAt,
      });
    }

    let user;
    try {
      user = await prisma.user.update({
        where: { id: target.id },
        data,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          wellnessRole: true,
          createdAt: true,
          deactivatedAt: true,
        },
      });
    } catch (err) {
      if (err.code === "P2002") {
        return res.status(409).json({ error: "Email already in use." });
      }
      throw err;
    }

    await writeAudit("User", "EDIT", user.id, req.user.userId, req.user.tenantId, {
      targetUserId: user.id,
      targetEmail: user.email,
      changed,
    });

    res.json(user);
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "User not found." });
    }
    res.status(500).json({ error: "Failed to update user." });
  }
});

// PATCH /:id — currently only the deactivate / reactivate toggle. #618 —
// reversible alternative to DELETE. Body: `{ active: false }` sets
// deactivatedAt = now(); `{ active: true }` clears it.
router.patch("/:id", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "Invalid user id." });
    }

    if (req.user.userId === userId) {
      return res.status(400).json({ error: "Cannot deactivate your own account." });
    }

    const { active } = req.body || {};
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "Body must include { active: boolean }." });
    }

    const target = await prisma.user.findFirst({ where: { id: userId, tenantId: req.user.tenantId } });
    if (!target) return res.status(404).json({ error: "User not found." });

    const user = await prisma.user.update({
      where: { id: target.id },
      data: { deactivatedAt: active ? null : new Date() },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        wellnessRole: true,
        createdAt: true,
        deactivatedAt: true,
      },
    });

    await writeAudit("User", active ? "REACTIVATE" : "DEACTIVATE", user.id, req.user.userId, req.user.tenantId, {
      targetUserId: user.id,
      targetEmail: user.email,
    });

    res.json(user);
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "User not found." });
    }
    res.status(500).json({ error: "Failed to update user." });
  }
});

// POST /:id/reset-password — admin-triggered password reset. Generates a
// 1-hour token, emails the link to the user, writes an audit row. Token
// itself is NEVER returned in the response (#526 hardening — same shape as
// /api/auth/forgot-password). Returns 200 + a tokenIssued boolean so the UI
// can confirm.
router.post("/:id/reset-password", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "Invalid user id." });
    }

    const target = await prisma.user.findFirst({ where: { id: userId, tenantId: req.user.tenantId } });
    if (!target) return res.status(404).json({ error: "User not found." });

    const token = crypto.randomBytes(32).toString("hex");
    adminResetTokens.set(token, { userId: target.id, expiresAt: Date.now() + 3600000 });

    const frontendBase = process.env.FRONTEND_URL || `https://${req.headers.host || "crm.globusdemos.com"}`;
    const resetUrl = `${frontendBase}/reset-password?token=${encodeURIComponent(token)}`;

    // Fire-and-forget — never block the admin's UI on SendGrid latency.
    sendEmail(
      target.email,
      "Your Globussoft CRM password has been reset",
      `An admin has triggered a password reset for your account. Click this link (valid 1 hour) to choose a new password:\n\n${resetUrl}\n\nIf you weren't expecting this, contact your administrator.`,
      `<p>An admin has triggered a password reset for your account.</p><p><a href="${resetUrl}">Choose a new password</a> (valid 1 hour).</p>`
    ).catch(() => {});

    await writeAudit("User", "PASSWORD_RESET", target.id, req.user.userId, req.user.tenantId, {
      targetUserId: target.id,
      targetEmail: target.email,
      via: "admin-trigger",
    });

    res.json({ status: "ok", code: "PASSWORD_RESET_LINK_SENT", tokenIssued: true });
  } catch (_err) {
    res.status(500).json({ error: "Failed to issue password reset." });
  }
});

// POST /:id/resend-invite — re-send the welcome invite email. Same shape as
// reset-password but a different audit action and a different email body.
// Useful when the original invite landed in spam / was deleted before the
// user enrolled.
router.post("/:id/resend-invite", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "Invalid user id." });
    }

    const target = await prisma.user.findFirst({ where: { id: userId, tenantId: req.user.tenantId } });
    if (!target) return res.status(404).json({ error: "User not found." });

    const token = crypto.randomBytes(32).toString("hex");
    inviteTokens.set(token, { userId: target.id, expiresAt: Date.now() + 24 * 3600000 });

    const frontendBase = process.env.FRONTEND_URL || `https://${req.headers.host || "crm.globusdemos.com"}`;
    const inviteUrl = `${frontendBase}/reset-password?token=${encodeURIComponent(token)}`;

    sendEmail(
      target.email,
      "You're invited to Globussoft CRM",
      `You've been invited to access Globussoft CRM. Click this link to set your password and sign in (valid 24 hours):\n\n${inviteUrl}\n\nIf you weren't expecting this, you can safely ignore this email.`,
      `<p>You've been invited to access Globussoft CRM.</p><p><a href="${inviteUrl}">Set your password</a> to get started (valid 24 hours).</p>`
    ).catch(() => {});

    await writeAudit("User", "INVITE_RESEND", target.id, req.user.userId, req.user.tenantId, {
      targetUserId: target.id,
      targetEmail: target.email,
    });

    res.json({ status: "ok", code: "INVITE_RESENT" });
  } catch (_err) {
    res.status(500).json({ error: "Failed to resend invite." });
  }
});

// DELETE /:id — delete user (ADMIN only)
router.delete("/:id", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);

    // Prevent self-deletion
    if (req.user.userId === userId) {
      return res.status(400).json({ error: "Cannot delete your own account." });
    }

    const target = await prisma.user.findFirst({ where: { id: userId, tenantId: req.user.tenantId } });
    if (!target) return res.status(404).json({ error: "User not found." });

    await prisma.user.delete({
      where: { id: target.id },
    });
    res.status(204).end(); // #550: DELETE → 204 No Content
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "User not found." });
    }
    res.status(500).json({ error: "Failed to delete user." });
  }
});

module.exports = router;
// Test hooks — exported only for backend/test/routes/staff.test.js.
module.exports.__testHooks = { adminResetTokens, inviteTokens };
