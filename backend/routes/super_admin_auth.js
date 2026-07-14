/**
 * routes/super_admin_auth.js — Super Admin Portal authentication.
 *
 * Deliberately separate from routes/auth.js. Credentials are environment-
 * based only (see middleware/superAdminAuth.js for the full contract) —
 * there is no SuperAdmin database table and no self-registration.
 *
 * Password flow (see middleware/superAdminAuth.js docblock for the full
 * design rationale):
 *   1. If SUPER_ADMIN_PASSWORD_PLAINTEXT is set to something other than the
 *      placeholder sentinel AND it matches the SUBMITTED password exactly
 *      (proving the caller actually knows the new value, not just that
 *      .env happens to hold one) — treat this as the operator setting/
 *      changing the password: hash it, OVERWRITE the persisted SystemSetting
 *      hash (upsert — there is only ever one row, so the old hash can never
 *      linger and be checked against by mistake), redact .env back to the
 *      placeholder, and log in successfully with a notice. This makes "edit
 *      .env, restart, log in with the new password" work every time, not
 *      just on first bootstrap — and a wrong-password guess never triggers
 *      a re-hash cycle, since it can't match the plaintext either.
 *   2. Otherwise, verify the submitted password against whatever hash is
 *      already current (the previously-persisted one, or
 *      SUPER_ADMIN_PASSWORD_HASH from env as a fallback).
 *
 * Endpoints:
 *   POST /api/super-admin/auth/login   — { username, password } -> { token, username }
 *   GET  /api/super-admin/auth/me      — current Super Admin session (requireSuperAdmin)
 *   POST /api/super-admin/auth/logout  — stateless (JWT-based); client just discards the token
 */

const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();
const {
  requireSuperAdmin,
  issueSuperAdminToken,
  isSuperAdminConfigured,
  getPersistedPasswordHash,
  persistPromotedPasswordHash,
  isPlaintextPlaceholder,
  redactPlaintextInEnvFile,
} = require("../middleware/superAdminAuth");

const DUMMY_HASH = "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva";

router.post("/login", async (req, res) => {
  if (!isSuperAdminConfigured()) {
    return res.status(503).json({
      error: "Super Admin Portal is not configured on this server",
      code: "SUPER_ADMIN_NOT_CONFIGURED",
    });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  // Constant-shape response for both "wrong username" and "wrong password"
  // so the endpoint doesn't leak which one was incorrect (username
  // enumeration hardening) — mirrors routes/auth.js's login contract.
  const expectedUsername = process.env.SUPER_ADMIN_USERNAME;

  if (username !== expectedUsername) {
    // Still run a bcrypt.compare against a dummy hash so the response
    // timing doesn't reveal "the username didn't even match" vs "the
    // password was wrong" via a fast-path short-circuit.
    const decoyHash = (await getPersistedPasswordHash()) || process.env.SUPER_ADMIN_PASSWORD_HASH || DUMMY_HASH;
    await bcrypt.compare(password, decoyHash);
    return res.status(401).json({ error: "Invalid Super Admin credentials" });
  }

  // A real (non-placeholder) plaintext value in .env that matches the
  // SUBMITTED password is treated as "apply this as the current password
  // now" — whether or not a hash already exists. This is what makes
  // password CHANGE work (not just first-login bootstrap): edit .env,
  // restart, log in with the new password. Requiring the submission to
  // match (not just checking .env in isolation) means a wrong-password
  // guess never triggers a re-hash, and the caller has to actually know the
  // new value to swap it in.
  const envPlaintext = process.env.SUPER_ADMIN_PASSWORD_PLAINTEXT || null;
  if (!isPlaintextPlaceholder(envPlaintext) && password === envPlaintext) {
    const newHash = await bcrypt.hash(envPlaintext, 10);
    await persistPromotedPasswordHash(newHash); // upsert — fully replaces the old hash, never leaves both live
    redactPlaintextInEnvFile();
    const token = issueSuperAdminToken(username);
    return res.json({
      token,
      username,
      notice: "Password updated from .env and hashed. The plaintext has been cleared from .env automatically.",
    });
  }

  const hashToCheck = (await getPersistedPasswordHash()) || process.env.SUPER_ADMIN_PASSWORD_HASH || null;
  if (!hashToCheck) {
    // isSuperAdminConfigured() guarantees a credential is set, so this is
    // unreachable in practice — kept as a safe fallback.
    return res.status(401).json({ error: "Invalid Super Admin credentials" });
  }

  const match = await bcrypt.compare(password, hashToCheck);
  if (!match) {
    return res.status(401).json({ error: "Invalid Super Admin credentials" });
  }

  const token = issueSuperAdminToken(username);
  return res.json({ token, username });
});

router.get("/me", requireSuperAdmin, (req, res) => {
  res.json({ username: req.superAdmin.username, role: "SUPER_ADMIN" });
});

// Stateless JWT — nothing to invalidate server-side. Kept as a real
// endpoint (not just a frontend no-op) so the client always has something
// to call, and so a future move to a token-blocklist has a landing spot.
router.post("/logout", requireSuperAdmin, (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
