const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { verifyRole } = require("../middleware/auth");
const { writeAudit } = require("../lib/audit");
// #714 (HIGH): server-side validation for Staff edit. Pre-fix PUT /:id
// allowed empty name and an arbitrary "not-an-email" string for email.
// `ensureEmail` + `ensureStringLength` are the shared helpers used by
// other routes; reusing them keeps the error-code contract uniform.
const { ensureEmail, ensureStringLength } = require("../lib/validators");
// #682 PII masking — staff directory leaks internal user IDs + full names
// to non-admin viewers. Helpers gate the role check + mask the row shape.
const {
  shouldMaskForViewer,
  maskRows,
  maskUserId,
  auditDisclosureDetails,
} = require("../lib/piiMask");

const router = express.Router();
const prisma = require("../lib/prisma");
// Wellness-role catalog lookup. Wellness tenants validate wellnessRole
// against their per-tenant WellnessRoleType catalog (admins can add
// custom roles like "nurse" from Settings). Generic tenants fall back
// to the legacy whitelist below — they never use wellnessRole in
// practice but the historical contract returned 400 on unknown values,
// which we preserve for back-compat.
const { isCatalogedKey } = require("../lib/wellnessRoleTypes");

const VALID_ROLES = ["ADMIN", "MANAGER", "USER"];
// Legacy whitelist — used only when the caller's tenant is non-wellness.
// Wellness tenants consult the WellnessRoleType catalog instead.
const LEGACY_WELLNESS_ROLES = [
  "doctor",
  "professional",
  "telecaller",
  "helper",
  "stylist",
];

// Resolve the caller's tenant vertical so we know which validator to run.
// Cached on req.user for the request lifetime (matches the pattern in
// middleware/wellnessRole.js's resolveTenantVertical).
async function getCallerVertical(req) {
  if (req.user?.vertical) return req.user.vertical;
  if (!req.user?.tenantId) return "generic";
  try {
    const t = await prisma.tenant.findUnique({
      where: { id: req.user.tenantId },
      select: { vertical: true },
    });
    const v = t?.vertical || "generic";
    req.user.vertical = v;
    return v;
  } catch (_e) {
    return "generic";
  }
}

// Returns null when wellnessRole is valid (or absent), or an error
// envelope when it isn't. Wellness tenants check the per-tenant catalog;
// generic tenants check the legacy whitelist.
async function validateWellnessRole(req, value) {
  if (value === undefined || value === null || value === "") return null;
  const vertical = await getCallerVertical(req);
  if (vertical === "wellness") {
    const ok = await isCatalogedKey(req.user.tenantId, value);
    if (!ok) {
      return {
        status: 400,
        error:
          "Unknown wellness role for this tenant. Add it under Settings → Wellness Role Types first.",
        code: "ROLE_NOT_IN_CATALOG",
      };
    }
    return null;
  }
  if (!LEGACY_WELLNESS_ROLES.includes(value)) {
    return {
      status: 400,
      error: `Invalid wellness role. Must be one of: ${LEGACY_WELLNESS_ROLES.join(", ")}`,
      code: "INVALID_WELLNESS_ROLE",
    };
  }
  return null;
}

// Module-scoped reset / invite token stores. Mirrors the pattern in
// routes/auth.js's `resetTokens` Map — in-memory, 1-hour TTL, hex-32 key.
// In a multi-instance deploy these would move to Redis; the demo box runs
// a single backend so a Map suffices.
const adminResetTokens = new Map(); // token -> { userId, expiresAt }
const inviteTokens = new Map(); // token -> { userId, expiresAt }

// SendGrid wrapper — fire-and-forget, never throws. Mirrors the contract in
// routes/auth.js sendPasswordResetEmail (kept local instead of importing so
// the two modules stay independently testable; promoting both into a shared
// lib/sendgrid.js is a separate cleanup tracked in TODOS).
async function sendEmail(toEmail, subject, plainText, html) {
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
  const FROM_EMAIL =
    process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com";
  if (!SENDGRID_API_KEY) {
    console.log(
      `[staff] SendGrid not configured — would send to ${toEmail}: ${subject}\n${plainText}`,
    );
    return;
  }
  try {
    const payload = {
      personalizations: [{ to: [{ email: toEmail }] }],
      from: { email: FROM_EMAIL },
      subject,
      content: [
        { type: "text/plain", value: plainText },
        {
          type: "text/html",
          value: html || `<p>${plainText.replace(/\n/g, "<br>")}</p>`,
        },
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
//
// #682: low-trust viewers (USER role / wellness telecaller / helper) see
// MASKED staff details — internal user IDs hashed to a 3-digit tail, names
// shown as "F. Last", emails masked to "x****@domain". ADMIN / MANAGER see
// full directory (operational ground truth — they manage the team).
// Doctors / professionals on the wellness vertical see full directory
// (they need to identify peers for referrals / handovers).
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
        // PRD Gap §1.5 — assigned commission profile (FK, nullable). Frontend
        // dropdown reads this to show the current assignment.
        commissionProfileId: true,
        createdAt: true,
        // #618 — surface deactivatedAt so the directory can flag inactive rows
        // (UI renders an "Inactive" badge; the row stays in the list so an
        // admin can re-activate it instead of having to soul-search the audit log).
        deactivatedAt: true,
        // Per-row primary RBAC role assignment so the Staff page can
        // display + edit the new Custom roles (DOCTOR / NURSE / etc.)
        // without a per-row roundtrip. Includes nested Role for the
        // display badge. Single-role-per-user enforced upstream, so
        // findFirst with desc order is deterministic.
        userRoles: {
          take: 1,
          orderBy: { assignedAt: "desc" },
          select: {
            roleId: true,
            role: {
              select: { id: true, key: true, name: true, landingPath: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Flatten userRoles[0] → primaryRole on each row so the frontend can
    // render `member.primaryRole?.key` without poking at the join shape.
    for (const u of users) {
      u.primaryRole =
        u.userRoles && u.userRoles[0] && u.userRoles[0].role
          ? {
              id: u.userRoles[0].role.id,
              key: u.userRoles[0].role.key,
              name: u.userRoles[0].role.name,
              landingPath: u.userRoles[0].role.landingPath || null,
            }
          : null;
      delete u.userRoles;
    }
    // #682: apply PII masking + audit emission.
    const mustMask = shouldMaskForViewer(req);
    let out;
    if (mustMask) {
      // Replace numeric ids with a 3-digit hashed token so the UI can still
      // render row keys without revealing the autoincrement (which gives away
      // signup order + total count). Also mask name + email.
      out = users.map((u) => ({
        ...u,
        id: maskUserId(u.id),
        name: u.name
          ? u.name.split(/\s+/)[0][0] +
            ". " +
            u.name.split(/\s+/).slice(1).join(" ")
          : u.name,
        email: u.email
          ? u.email[0] + "****@" + (u.email.split("@")[1] || "")
          : u.email,
      }));
    } else {
      out = users;
      if (users.length > 0) {
        writeAudit(
          "User",
          "PII_DISCLOSED",
          null,
          req.user.userId,
          req.user.tenantId,
          auditDisclosureDetails(req, "staff_list", users, {
            fields: ["id", "name", "email"],
          }),
        ).catch((e) =>
          console.warn("[staff] audit User PII_DISCLOSED failed:", e.message),
        );
      }
    }
    res.json(out);
  } catch (_err) {
    res.status(500).json({ error: "Failed to fetch staff." });
  }
});

// POST / — admin-driven staff creation. The "Add Staff" button in the Staff
// Directory opens a modal that POSTs here. Unlike /auth/signup (which creates
// a NEW tenant), this endpoint creates a user inside the requesting admin's
// existing tenant — the canonical way for a clinic / org admin to onboard a
// colleague. The new user's role is whatever the admin selected, so the
// role-aware Dashboard (frontend/src/pages/Dashboard.jsx) automatically
// renders the correct landing view on their first login.
router.post("/", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { name, email, password, role, wellnessRole, rbacRoleId } =
      req.body || {};

    // Basic field presence + shape checks. Mirror auth.js/signup so the
    // error envelope is uniform across signup and admin-create paths.
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return res.status(400).json({ error: "Name is required." });
    }
    if (
      !email ||
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({ error: "A valid work email is required." });
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters." });
    }
    if (!role || !VALID_ROLES.includes(role)) {
      return res
        .status(400)
        .json({
          error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}`,
        });
    }
    const wrErr = await validateWellnessRole(req, wellnessRole);
    if (wrErr)
      return res
        .status(wrErr.status)
        .json({ error: wrErr.error, code: wrErr.code });

    // Optional rbacRoleId: pre-validate before we create the user, so a bad
    // role id doesn't leave a half-created user behind. Must be an integer
    // pointing at a Role row in THIS tenant with userType='STAFF' (CUSTOMER
    // roles can't be assigned to staff via this endpoint).
    let rbacRole = null;
    if (rbacRoleId !== undefined && rbacRoleId !== null && rbacRoleId !== "") {
      const roleIdNum = parseInt(rbacRoleId, 10);
      if (!Number.isInteger(roleIdNum) || roleIdNum <= 0) {
        return res.status(400).json({ error: "Invalid rbacRoleId." });
      }
      rbacRole = await prisma.role.findFirst({
        where: { id: roleIdNum, tenantId: req.user.tenantId },
      });
      if (!rbacRole) {
        return res
          .status(404)
          .json({ error: "Role not found in this tenant." });
      }
      if (rbacRole.userType && rbacRole.userType !== "STAFF") {
        return res
          .status(400)
          .json({ error: "Cannot assign a CUSTOMER role to a staff member." });
      }
    }

    // Email is globally unique (Prisma @unique). Pre-check inside the
    // tenant so the admin gets a meaningful 409 instead of Prisma's raw
    // P2002 unique-constraint error.
    const existing = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (existing) {
      return res
        .status(409)
        .json({ error: "A user with that email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Atomic: create user + the UserRole junction in one transaction. If
    // either fails, the entire create rolls back. Avoids "user created
    // but role assignment failed" half-state that requires manual cleanup.
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: name.trim(),
          email: email.toLowerCase(),
          password: passwordHash,
          role,
          wellnessRole: wellnessRole || null,
          tenantId: req.user.tenantId,
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          wellnessRole: true,
          commissionProfileId: true,
          createdAt: true,
          deactivatedAt: true,
        },
      });
      if (rbacRole) {
        await tx.userRole.create({
          data: {
            userId: user.id,
            roleId: rbacRole.id,
            assignedById: req.user.userId,
          },
        });
      }
      return user;
    });

    await writeAudit(
      "User",
      "CREATE",
      created.id,
      req.user.userId,
      req.user.tenantId,
      {
        targetEmail: created.email,
        role: created.role,
        wellnessRole: created.wellnessRole || null,
        rbacRoleId: rbacRole ? rbacRole.id : null,
        rbacRoleKey: rbacRole ? rbacRole.key : null,
      },
    ).catch((e) =>
      console.warn("[staff] audit User CREATE failed:", e.message),
    );

    res.status(201).json({
      ...created,
      // Echo the assignment so the frontend can update its row state
      // without a refetch.
      primaryRole: rbacRole
        ? {
            id: rbacRole.id,
            key: rbacRole.key,
            name: rbacRole.name,
            landingPath: rbacRole.landingPath || null,
          }
        : null,
    });
  } catch (err) {
    if (err && err.code === "P2002") {
      return res
        .status(409)
        .json({ error: "A user with that email already exists." });
    }
    console.error("[staff] POST / failed:", err);
    res.status(500).json({ error: "Failed to create staff member." });
  }
});

// PUT /:id/role — update user role (ADMIN only)
router.put("/:id/role", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { role } = req.body;

    if (!role || !VALID_ROLES.includes(role)) {
      return res
        .status(400)
        .json({
          error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}`,
        });
    }

    const userId = parseInt(req.params.id, 10);

    // Prevent self-demotion
    if (req.user.userId === userId && role !== "ADMIN") {
      return res.status(400).json({ error: "Cannot change your own role." });
    }

    const target = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.user.tenantId },
    });
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

    const target = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.user.tenantId },
    });
    if (!target) return res.status(404).json({ error: "User not found." });

    const { name, email, role, wellnessRole, commissionProfileId, rbacRoleId } =
      req.body || {};
    const data = {};
    const changed = {};
    // rbacRoleId handled outside the User.update because it lives on the
    // UserRole junction table. Validate up-front so we don't mutate User
    // and then fail the junction write.
    let nextRbacRoleId = undefined; // undefined = no change requested
    let validatedRbacRole = null;
    if (rbacRoleId !== undefined) {
      if (rbacRoleId === null || rbacRoleId === "") {
        nextRbacRoleId = null; // explicit clear
      } else {
        const roleIdNum = parseInt(rbacRoleId, 10);
        if (!Number.isInteger(roleIdNum) || roleIdNum <= 0) {
          return res.status(400).json({ error: "Invalid rbacRoleId." });
        }
        validatedRbacRole = await prisma.role.findFirst({
          where: { id: roleIdNum, tenantId: req.user.tenantId },
        });
        if (!validatedRbacRole) {
          return res
            .status(404)
            .json({ error: "Role not found in this tenant." });
        }
        if (
          validatedRbacRole.userType &&
          validatedRbacRole.userType !== "STAFF"
        ) {
          return res
            .status(400)
            .json({
              error: "Cannot assign a CUSTOMER role to a staff member.",
            });
        }
        nextRbacRoleId = roleIdNum;
      }
    }

    // #714 (HIGH): server-side validation. Name is REQUIRED when included
    // (no clearing-to-empty), email must look like an email when included.
    // Pre-fix the trim()-falsy path persisted `null` into User.name, and
    // any non-empty string was accepted as email — pen-test reproduced
    // with `not-email` and the row was silently corrupted.
    if (name !== undefined) {
      const nameErr = ensureStringLength(name, {
        field: "name",
        min: 1,
        max: 200,
        required: true,
        trim: true,
      });
      if (nameErr) return res.status(nameErr.status).json(nameErr);
      const trimmed = String(name).trim();
      if (trimmed !== target.name) {
        data.name = trimmed;
        changed.name = { from: target.name, to: data.name };
      }
    }
    if (email !== undefined) {
      const emailErr = ensureEmail(email, { required: true });
      if (emailErr) return res.status(emailErr.status).json(emailErr);
      const trimmed = String(email).trim();
      if (trimmed !== target.email) {
        data.email = trimmed;
        changed.email = { from: target.email, to: data.email };
      }
    }
    if (role !== undefined) {
      if (!VALID_ROLES.includes(role)) {
        return res
          .status(400)
          .json({
            error: `Invalid role. Must be one of: ${VALID_ROLES.join(", ")}`,
          });
      }
      // Prevent self-demotion (mirror PUT /:id/role guard)
      if (
        req.user.userId === userId &&
        role !== "ADMIN" &&
        target.role === "ADMIN"
      ) {
        return res.status(400).json({ error: "Cannot change your own role." });
      }
      if (role !== target.role) {
        data.role = role;
        changed.role = { from: target.role, to: role };
      }
    }
    if (wellnessRole !== undefined) {
      if (wellnessRole !== null) {
        const wrErr = await validateWellnessRole(req, wellnessRole);
        if (wrErr)
          return res
            .status(wrErr.status)
            .json({ error: wrErr.error, code: wrErr.code });
      }
      if (wellnessRole !== target.wellnessRole) {
        data.wellnessRole = wellnessRole;
        changed.wellnessRole = { from: target.wellnessRole, to: wellnessRole };
      }
    }
    // PRD Gap §1.5 — assign / clear a commission profile.
    if (commissionProfileId !== undefined) {
      const next =
        commissionProfileId == null || commissionProfileId === ""
          ? null
          : parseInt(commissionProfileId, 10);
      if (next !== null && (!Number.isInteger(next) || next <= 0)) {
        return res.status(400).json({ error: "Invalid commissionProfileId." });
      }
      if (next !== null) {
        // Verify the profile belongs to the same tenant.
        const profile = await prisma.commissionProfile.findFirst({
          where: { id: next, tenantId: req.user.tenantId },
        });
        if (!profile)
          return res
            .status(404)
            .json({ error: "Commission profile not found." });
      }
      if (next !== target.commissionProfileId) {
        data.commissionProfileId = next;
        changed.commissionProfileId = {
          from: target.commissionProfileId,
          to: next,
        };
      }
    }

    // rbacRoleId is the only field that lives outside the User table, so
    // it's handled separately. Snapshot whether the RBAC role actually
    // changed so we can audit + skip-no-op without an extra UserRole read.
    const currentRbacRow =
      nextRbacRoleId !== undefined
        ? await prisma.userRole.findFirst({
            where: { userId: target.id },
            orderBy: { assignedAt: "desc" },
          })
        : null;
    const currentRbacRoleId = currentRbacRow ? currentRbacRow.roleId : null;
    const rbacRoleChanged =
      nextRbacRoleId !== undefined && nextRbacRoleId !== currentRbacRoleId;

    if (Object.keys(data).length === 0 && !rbacRoleChanged) {
      // No-op edit — return current row without writing audit.
      return res.json({
        id: target.id,
        email: target.email,
        name: target.name,
        role: target.role,
        wellnessRole: target.wellnessRole,
        commissionProfileId: target.commissionProfileId,
        createdAt: target.createdAt,
        deactivatedAt: target.deactivatedAt,
      });
    }

    let user;
    try {
      // Wrap the User.update + UserRole swap in a transaction so a failure
      // on either half rolls back. Single-role-per-user is application-
      // enforced: deleteMany existing rows then create the new one.
      user = await prisma.$transaction(async (tx) => {
        const updated =
          Object.keys(data).length === 0
            ? target
            : await tx.user.update({
                where: { id: target.id },
                data,
                select: {
                  id: true,
                  email: true,
                  name: true,
                  role: true,
                  wellnessRole: true,
                  commissionProfileId: true,
                  createdAt: true,
                  deactivatedAt: true,
                },
              });

        if (rbacRoleChanged) {
          await tx.userRole.deleteMany({ where: { userId: target.id } });
          if (nextRbacRoleId !== null) {
            await tx.userRole.create({
              data: {
                userId: target.id,
                roleId: nextRbacRoleId,
                assignedById: req.user.userId,
              },
            });
          }
          changed.rbacRoleId = { from: currentRbacRoleId, to: nextRbacRoleId };
        }

        return updated;
      });
    } catch (err) {
      if (err.code === "P2002") {
        return res.status(409).json({ error: "Email already in use." });
      }
      throw err;
    }

    await writeAudit(
      "User",
      "EDIT",
      user.id,
      req.user.userId,
      req.user.tenantId,
      {
        targetUserId: user.id,
        targetEmail: user.email,
        changed,
      },
    );

    // Echo the resolved RBAC role on the response so the staff list can
    // update its row state without a refetch.
    const echoedRbacRole = (() => {
      if (nextRbacRoleId === undefined) {
        // RBAC role not part of this PUT — surface the current assignment
        // from the snapshot read above.
        return currentRbacRow && validatedRbacRole === null
          ? { id: currentRbacRoleId }
          : null;
      }
      if (validatedRbacRole) {
        return {
          id: validatedRbacRole.id,
          key: validatedRbacRole.key,
          name: validatedRbacRole.name,
          landingPath: validatedRbacRole.landingPath || null,
        };
      }
      return null; // explicit clear
    })();

    res.json({ ...user, primaryRole: echoedRbacRole });
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
      return res
        .status(400)
        .json({ error: "Cannot deactivate your own account." });
    }

    const { active } = req.body || {};
    if (typeof active !== "boolean") {
      return res
        .status(400)
        .json({ error: "Body must include { active: boolean }." });
    }

    const target = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.user.tenantId },
    });
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
        commissionProfileId: true,
        createdAt: true,
        deactivatedAt: true,
      },
    });

    await writeAudit(
      "User",
      active ? "REACTIVATE" : "DEACTIVATE",
      user.id,
      req.user.userId,
      req.user.tenantId,
      {
        targetUserId: user.id,
        targetEmail: user.email,
      },
    );

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

    const target = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.user.tenantId },
    });
    if (!target) return res.status(404).json({ error: "User not found." });

    const token = crypto.randomBytes(32).toString("hex");
    adminResetTokens.set(token, {
      userId: target.id,
      expiresAt: Date.now() + 3600000,
    });

    const frontendBase =
      process.env.FRONTEND_URL ||
      `https://${req.headers.host || "crm.globusdemos.com"}`;
    const resetUrl = `${frontendBase}/reset-password?token=${encodeURIComponent(token)}`;

    // Fire-and-forget — never block the admin's UI on SendGrid latency.
    sendEmail(
      target.email,
      "Your Globussoft CRM password has been reset",
      `An admin has triggered a password reset for your account. Click this link (valid 1 hour) to choose a new password:\n\n${resetUrl}\n\nIf you weren't expecting this, contact your administrator.`,
      `<p>An admin has triggered a password reset for your account.</p><p><a href="${resetUrl}">Choose a new password</a> (valid 1 hour).</p>`,
    ).catch(() => {});

    await writeAudit(
      "User",
      "PASSWORD_RESET",
      target.id,
      req.user.userId,
      req.user.tenantId,
      {
        targetUserId: target.id,
        targetEmail: target.email,
        via: "admin-trigger",
      },
    );

    res.json({
      status: "ok",
      code: "PASSWORD_RESET_LINK_SENT",
      tokenIssued: true,
    });
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

    const target = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.user.tenantId },
    });
    if (!target) return res.status(404).json({ error: "User not found." });

    const token = crypto.randomBytes(32).toString("hex");
    inviteTokens.set(token, {
      userId: target.id,
      expiresAt: Date.now() + 24 * 3600000,
    });

    const frontendBase =
      process.env.FRONTEND_URL ||
      `https://${req.headers.host || "crm.globusdemos.com"}`;
    const inviteUrl = `${frontendBase}/reset-password?token=${encodeURIComponent(token)}`;

    sendEmail(
      target.email,
      "You're invited to Globussoft CRM",
      `You've been invited to access Globussoft CRM. Click this link to set your password and sign in (valid 24 hours):\n\n${inviteUrl}\n\nIf you weren't expecting this, you can safely ignore this email.`,
      `<p>You've been invited to access Globussoft CRM.</p><p><a href="${inviteUrl}">Set your password</a> to get started (valid 24 hours).</p>`,
    ).catch(() => {});

    await writeAudit(
      "User",
      "INVITE_RESEND",
      target.id,
      req.user.userId,
      req.user.tenantId,
      {
        targetUserId: target.id,
        targetEmail: target.email,
      },
    );

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

    const target = await prisma.user.findFirst({
      where: { id: userId, tenantId: req.user.tenantId },
    });
    if (!target) return res.status(404).json({ error: "User not found." });

    // #323: refuse to delete the tenant OWNER. The owner is the sole user with
    // userType=OWNER (set during signup); managers/admins must not be able to
    // remove them, regardless of RBAC role.
    if (target.userType === "OWNER") {
      return res
        .status(403)
        .json({
          error: "Cannot delete the tenant owner.",
          code: "OWNER_PROTECTED",
        });
    }

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

// ───────────────────────────────────────────────────────────────────
// PRD Gap §1.5 — Commission profiles
//
// Tenant-scoped commission rule sets. Mounted under /api/staff/commission-
// profiles. ADMIN-only (mirrors the staff edit/delete endpoints — payroll
// rules are sensitive). The User.commissionProfileId FK is set via the
// PUT /api/staff/:id endpoint above (we extended its data block to accept
// `commissionProfileId`); CRUD here only manages the profile rows.
// ───────────────────────────────────────────────────────────────────

const VALID_COMMISSION_BASIS = [
  "PER_SERVICE",
  "PER_PRODUCT",
  "REVENUE_PERCENT",
  "FLAT_PER_INVOICE",
];

function validateCommissionBody(body, { partial = false } = {}) {
  const errors = [];
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim())
      errors.push("name is required");
  }
  if (
    body.basis !== undefined &&
    !VALID_COMMISSION_BASIS.includes(body.basis)
  ) {
    errors.push(`basis must be one of: ${VALID_COMMISSION_BASIS.join(", ")}`);
  }
  // percentage / flatAmount: at least one is required on create. Validate ranges.
  const pct = body.percentage;
  const flat = body.flatAmount;
  if (pct !== undefined && pct !== null) {
    const n = Number(pct);
    if (!Number.isFinite(n) || n < 0 || n > 100)
      errors.push("percentage must be 0..100");
  }
  if (flat !== undefined && flat !== null) {
    const n = Number(flat);
    if (!Number.isFinite(n) || n < 0) errors.push("flatAmount must be >= 0");
  }
  if (
    !partial &&
    (pct == null || pct === "") &&
    (flat == null || flat === "")
  ) {
    errors.push("either percentage or flatAmount must be set");
  }
  return errors;
}

// GET /commission-profiles — list (admin only)
router.get("/commission-profiles", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const rows = await prisma.commissionProfile.findMany({
      where: { tenantId: req.user.tenantId },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
    });
    res.json(rows);
  } catch (err) {
    console.error("[staff][commission-profiles][list]", err);
    res.status(500).json({ error: "Failed to fetch commission profiles." });
  }
});

// POST /commission-profiles — create (admin only)
router.post("/commission-profiles", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const errors = validateCommissionBody(req.body || {}, { partial: false });
    if (errors.length)
      return res.status(400).json({ error: errors.join("; ") });

    const { name, percentage, flatAmount, basis, appliesToCategory, isActive } =
      req.body;
    const row = await prisma.commissionProfile.create({
      data: {
        tenantId: req.user.tenantId,
        name: String(name).trim(),
        percentage:
          percentage == null || percentage === "" ? null : String(percentage),
        flatAmount:
          flatAmount == null || flatAmount === "" ? null : String(flatAmount),
        basis: basis || "REVENUE_PERCENT",
        appliesToCategory: appliesToCategory || null,
        isActive: isActive === false ? false : true,
      },
    });
    await writeAudit(
      "CommissionProfile",
      "CREATE",
      row.id,
      req.user.userId,
      req.user.tenantId,
      {
        name: row.name,
        basis: row.basis,
      },
    );
    res.status(201).json(row);
  } catch (err) {
    if (err.code === "P2002")
      return res
        .status(409)
        .json({ error: "A commission profile with that name already exists." });
    console.error("[staff][commission-profiles][create]", err);
    res.status(500).json({ error: "Failed to create commission profile." });
  }
});

// PUT /commission-profiles/:id — update (admin only)
router.put(
  "/commission-profiles/:id",
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0)
        return res.status(400).json({ error: "Invalid id." });
      const existing = await prisma.commissionProfile.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing)
        return res.status(404).json({ error: "Commission profile not found." });

      const errors = validateCommissionBody(req.body || {}, { partial: true });
      if (errors.length)
        return res.status(400).json({ error: errors.join("; ") });

      const {
        name,
        percentage,
        flatAmount,
        basis,
        appliesToCategory,
        isActive,
      } = req.body || {};
      const data = {};
      if (name !== undefined) data.name = String(name).trim();
      if (percentage !== undefined)
        data.percentage =
          percentage == null || percentage === "" ? null : String(percentage);
      if (flatAmount !== undefined)
        data.flatAmount =
          flatAmount == null || flatAmount === "" ? null : String(flatAmount);
      if (basis !== undefined) data.basis = basis;
      if (appliesToCategory !== undefined)
        data.appliesToCategory = appliesToCategory || null;
      if (isActive !== undefined) data.isActive = Boolean(isActive);

      const row = await prisma.commissionProfile.update({
        where: { id },
        data,
      });
      await writeAudit(
        "CommissionProfile",
        "UPDATE",
        row.id,
        req.user.userId,
        req.user.tenantId,
        { id },
      );
      res.json(row);
    } catch (err) {
      if (err.code === "P2002")
        return res
          .status(409)
          .json({
            error: "A commission profile with that name already exists.",
          });
      if (err.code === "P2025")
        return res.status(404).json({ error: "Commission profile not found." });
      console.error("[staff][commission-profiles][update]", err);
      res.status(500).json({ error: "Failed to update commission profile." });
    }
  },
);

// DELETE /commission-profiles/:id — delete (admin only). Cascading FK
// nulls User.commissionProfileId on every assigned user (SetNull).
router.delete(
  "/commission-profiles/:id",
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id) || id <= 0)
        return res.status(400).json({ error: "Invalid id." });
      const existing = await prisma.commissionProfile.findFirst({
        where: { id, tenantId: req.user.tenantId },
      });
      if (!existing)
        return res.status(404).json({ error: "Commission profile not found." });

      await prisma.commissionProfile.delete({ where: { id } });
      await writeAudit(
        "CommissionProfile",
        "DELETE",
        id,
        req.user.userId,
        req.user.tenantId,
        { name: existing.name },
      );
      res.status(204).end();
    } catch (err) {
      if (err.code === "P2025")
        return res.status(404).json({ error: "Commission profile not found." });
      console.error("[staff][commission-profiles][delete]", err);
      res.status(500).json({ error: "Failed to delete commission profile." });
    }
  },
);

// ───────────────────────────────────────────────────────────────────
// PRD Gap §1.6 — Staff revenue goals
//
// Per-user, per-period revenue target. Distinct from generic Quota.
// achievedAmount is computed on GET as SUM(Sale.total) over the period
// where Sale.cashierId = userId AND Sale.status = 'COMPLETED'. The
// stored achievedAmount column is kept for cron / payroll consumers
// that don't want to re-aggregate; we update it on read so it's
// always fresh enough for the dashboard widget.
// ───────────────────────────────────────────────────────────────────

const VALID_GOAL_PERIOD = ["MONTHLY", "QUARTERLY", "YEARLY"];
const VALID_GOAL_SCOPE = ["ALL", "SERVICE", "PRODUCT", "MEMBERSHIP"];

function validateGoalBody(body, { partial = false } = {}) {
  const errors = [];
  // PRD Gap §1.6 follow-up: stripDangerous deletes req.body.userId, so we
  // accept `targetUserId` (non-stripped name per the CLAUDE.md standing rule).
  // Legacy `userId` in body would silently be dropped — caller must use
  // targetUserId. The ESLint no-restricted-syntax rule enforces this on
  // future writes; the helper here is the runtime backstop.
  const inputUserId =
    body.targetUserId !== undefined ? body.targetUserId : body.userId;
  if (!partial || inputUserId !== undefined) {
    const uid = parseInt(inputUserId, 10);
    if (!Number.isInteger(uid) || uid <= 0)
      errors.push("targetUserId is required (positive integer)");
  }
  if (body.period !== undefined && !VALID_GOAL_PERIOD.includes(body.period)) {
    errors.push(`period must be one of: ${VALID_GOAL_PERIOD.join(", ")}`);
  }
  if (body.scope !== undefined && !VALID_GOAL_SCOPE.includes(body.scope)) {
    errors.push(`scope must be one of: ${VALID_GOAL_SCOPE.join(", ")}`);
  }
  if (!partial || body.targetAmount !== undefined) {
    const n = Number(body.targetAmount);
    if (!Number.isFinite(n) || n < 0) errors.push("targetAmount must be >= 0");
  }
  if (!partial || body.periodStart !== undefined) {
    const d = new Date(body.periodStart);
    if (isNaN(d.getTime())) errors.push("periodStart must be a valid date");
  }
  if (!partial || body.periodEnd !== undefined) {
    const d = new Date(body.periodEnd);
    if (isNaN(d.getTime())) errors.push("periodEnd must be a valid date");
  }
  if (!partial && body.periodStart && body.periodEnd) {
    if (
      new Date(body.periodStart).getTime() >= new Date(body.periodEnd).getTime()
    ) {
      errors.push("periodStart must be before periodEnd");
    }
  }
  return errors;
}

// Compute SUM(Sale.total) for a userId in [periodStart, periodEnd]. Returns
// a Number; 0 on empty/error so the UI can render "₹0 / ₹50,000".
async function computeAchievedAmount(
  tenantId,
  userId,
  periodStart,
  periodEnd,
  scope,
  _scopeFilter,
) {
  try {
    const where = {
      tenantId,
      cashierId: userId,
      status: "COMPLETED",
      createdAt: { gte: periodStart, lt: periodEnd },
    };
    // For scope filtering, we'd join on SaleLineItem; ALL is the common case.
    // SERVICE / PRODUCT / MEMBERSHIP narrow via lineItems.lineType match.
    if (scope && scope !== "ALL") {
      // Aggregate over SaleLineItem joined to Sale by sale.cashierId etc.
      const rows = await prisma.saleLineItem.findMany({
        where: {
          tenantId,
          lineType: scope,
          sale: where,
        },
        select: { lineTotal: true },
      });
      return rows.reduce((acc, r) => acc + Number(r.lineTotal || 0), 0);
    }
    const agg = await prisma.sale.aggregate({
      where,
      _sum: { total: true },
    });
    return Number(agg._sum.total || 0);
  } catch (err) {
    console.error("[staff][revenue-goals][computeAchieved]", err);
    return 0;
  }
}

// GET /revenue-goals — admin sees all, USER sees only their own goals.
router.get("/revenue-goals", async (req, res) => {
  try {
    const isPrivileged =
      req.user.role === "ADMIN" || req.user.role === "MANAGER";
    const where = { tenantId: req.user.tenantId };
    if (!isPrivileged) where.userId = req.user.userId;
    if (req.query.userId) {
      const filterUid = parseInt(req.query.userId, 10);
      if (!isPrivileged && filterUid !== req.user.userId) {
        return res
          .status(403)
          .json({ error: "Cannot read other users' revenue goals." });
      }
      where.userId = filterUid;
    }
    const rows = await prisma.staffRevenueGoal.findMany({
      where,
      orderBy: [{ periodStart: "desc" }, { id: "desc" }],
      include: {
        user: {
          select: { id: true, name: true, email: true, wellnessRole: true },
        },
      },
    });

    // Refresh achievedAmount on read.
    const out = await Promise.all(
      rows.map(async (g) => {
        const achieved = await computeAchievedAmount(
          req.user.tenantId,
          g.userId,
          g.periodStart,
          g.periodEnd,
          g.scope,
          g.scopeFilter,
        );
        // Best-effort write-back; don't fail the read if it errors.
        prisma.staffRevenueGoal
          .update({
            where: { id: g.id },
            data: { achievedAmount: String(achieved) },
          })
          .catch(() => {});
        return { ...g, achievedAmount: achieved };
      }),
    );
    res.json(out);
  } catch (err) {
    console.error("[staff][revenue-goals][list]", err);
    res.status(500).json({ error: "Failed to fetch revenue goals." });
  }
});

// POST /revenue-goals — create (admin only)
router.post("/revenue-goals", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const errors = validateGoalBody(req.body || {}, { partial: false });
    if (errors.length)
      return res.status(400).json({ error: errors.join("; ") });

    const {
      targetUserId,
      period,
      periodStart,
      periodEnd,
      targetAmount,
      scope,
      scopeFilter,
      notes,
    } = req.body;
    // PRD Gap §1.6 follow-up: prefer targetUserId (non-stripped name).
    // eslint-disable-next-line no-restricted-syntax
    const resolvedUserId = targetUserId !== undefined ? targetUserId : req.body.userId;
    // Verify user belongs to this tenant.
    const target = await prisma.user.findFirst({
      where: { id: parseInt(resolvedUserId, 10), tenantId: req.user.tenantId },
    });
    if (!target)
      return res
        .status(404)
        .json({ error: "Target user not found in this tenant." });

    const row = await prisma.staffRevenueGoal.create({
      data: {
        tenantId: req.user.tenantId,
        userId: target.id,
        period: period || "MONTHLY",
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        targetAmount: String(targetAmount),
        scope: scope || "ALL",
        scopeFilter: scopeFilter || null,
        notes: notes || null,
      },
    });
    await writeAudit(
      "StaffRevenueGoal",
      "CREATE",
      row.id,
      req.user.userId,
      req.user.tenantId,
      {
        targetUserId: target.id,
        period: row.period,
        target: targetAmount,
      },
    );
    res.status(201).json(row);
  } catch (err) {
    if (err.code === "P2002")
      return res
        .status(409)
        .json({
          error: "A goal already exists for this user / period / start.",
        });
    console.error("[staff][revenue-goals][create]", err);
    res.status(500).json({ error: "Failed to create revenue goal." });
  }
});

// PUT /revenue-goals/:id — update (admin only)
router.put("/revenue-goals/:id", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ error: "Invalid id." });
    const existing = await prisma.staffRevenueGoal.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing)
      return res.status(404).json({ error: "Revenue goal not found." });

    const errors = validateGoalBody(req.body || {}, { partial: true });
    if (errors.length)
      return res.status(400).json({ error: errors.join("; ") });

    const {
      period,
      periodStart,
      periodEnd,
      targetAmount,
      scope,
      scopeFilter,
      notes,
    } = req.body || {};
    const data = {};
    if (period !== undefined) data.period = period;
    if (periodStart !== undefined) data.periodStart = new Date(periodStart);
    if (periodEnd !== undefined) data.periodEnd = new Date(periodEnd);
    if (targetAmount !== undefined) data.targetAmount = String(targetAmount);
    if (scope !== undefined) data.scope = scope;
    if (scopeFilter !== undefined) data.scopeFilter = scopeFilter || null;
    if (notes !== undefined) data.notes = notes || null;

    const row = await prisma.staffRevenueGoal.update({ where: { id }, data });
    await writeAudit(
      "StaffRevenueGoal",
      "UPDATE",
      row.id,
      req.user.userId,
      req.user.tenantId,
      { id },
    );
    res.json(row);
  } catch (err) {
    if (err.code === "P2025")
      return res.status(404).json({ error: "Revenue goal not found." });
    console.error("[staff][revenue-goals][update]", err);
    res.status(500).json({ error: "Failed to update revenue goal." });
  }
});

// DELETE /revenue-goals/:id — delete (admin only)
router.delete("/revenue-goals/:id", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ error: "Invalid id." });
    const existing = await prisma.staffRevenueGoal.findFirst({
      where: { id, tenantId: req.user.tenantId },
    });
    if (!existing)
      return res.status(404).json({ error: "Revenue goal not found." });

    await prisma.staffRevenueGoal.delete({ where: { id } });
    await writeAudit(
      "StaffRevenueGoal",
      "DELETE",
      id,
      req.user.userId,
      req.user.tenantId,
      {
        targetUserId: existing.userId,
        period: existing.period,
      },
    );
    res.status(204).end();
  } catch (err) {
    if (err.code === "P2025")
      return res.status(404).json({ error: "Revenue goal not found." });
    console.error("[staff][revenue-goals][delete]", err);
    res.status(500).json({ error: "Failed to delete revenue goal." });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Commission Data — Historical payroll/commission records
// ─────────────────────────────────────────────────────────────────────

// GET /commission-data — list all commission records (admin only)
router.get("/commission-data", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const { startDate, endDate, employeeName } = req.query;
    const where = { tenantId: req.user.tenantId };

    if (startDate || endDate) {
      where.periodStart = {};
      if (startDate) where.periodStart.gte = new Date(startDate);
      if (endDate) where.periodStart.lte = new Date(endDate);
    }

    if (employeeName) where.employeeName = { contains: employeeName };

    const records = await prisma.commissionData.findMany({
      where,
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: [{ periodStart: "desc" }, { employeeName: "asc" }],
    });

    res.json(records);
  } catch (err) {
    console.error("[staff][commission-data][list]", err);
    res.status(500).json({ error: "Failed to fetch commission data." });
  }
});

// GET /commission-data/:id — get single commission record
router.get("/commission-data/:id", verifyRole(["ADMIN"]), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ error: "Invalid id." });

    const record = await prisma.commissionData.findFirst({
      where: { id, tenantId: req.user.tenantId },
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    if (!record)
      return res.status(404).json({ error: "Commission record not found." });
    res.json(record);
  } catch (err) {
    console.error("[staff][commission-data][detail]", err);
    res.status(500).json({ error: "Failed to fetch commission record." });
  }
});

// GET /commission-data/summary/by-employee — aggregate by employee
router.get(
  "/commission-data/summary/by-employee",
  verifyRole(["ADMIN"]),
  async (req, res) => {
    try {
      const records = await prisma.commissionData.findMany({
        where: { tenantId: req.user.tenantId },
        select: {
          employeeName: true,
          serviceRevenue: true,
          productRevenue: true,
          packageRevenue: true,
          membershipRevenue: true,
          totalSales: true,
        },
      });

      const summary = {};
      records.forEach((r) => {
        if (!summary[r.employeeName]) {
          summary[r.employeeName] = {
            employeeName: r.employeeName,
            serviceRevenue: 0,
            productRevenue: 0,
            packageRevenue: 0,
            membershipRevenue: 0,
            totalSales: 0,
            recordCount: 0,
          };
        }
        summary[r.employeeName].serviceRevenue +=
          parseFloat(r.serviceRevenue) || 0;
        summary[r.employeeName].productRevenue +=
          parseFloat(r.productRevenue) || 0;
        summary[r.employeeName].packageRevenue +=
          parseFloat(r.packageRevenue) || 0;
        summary[r.employeeName].membershipRevenue +=
          parseFloat(r.membershipRevenue) || 0;
        summary[r.employeeName].totalSales += parseFloat(r.totalSales) || 0;
        summary[r.employeeName].recordCount += 1;
      });

      const rows = Object.values(summary).sort(
        (a, b) => b.totalSales - a.totalSales,
      );
      res.json(rows);
    } catch (err) {
      console.error("[staff][commission-data][summary]", err);
      res.status(500).json({ error: "Failed to compute commission summary." });
    }
  },
);

module.exports = router;
// Test hooks — exported only for backend/test/routes/staff.test.js.
module.exports.__testHooks = { adminResetTokens, inviteTokens };
module.exports.__internals = { computeAchievedAmount };
