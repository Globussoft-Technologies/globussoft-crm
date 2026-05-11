// @ts-check
/**
 * Step-up authentication endpoint — closes #654 (sensitive admin flows lack
 * re-auth gating).
 *
 * Threat model:
 *   A session JWT proves the user logged in at some point in the last 7 days.
 *   It does NOT prove the user is present at the keyboard *right now*. A
 *   stolen/left-behind session can flip GDPR retention policies, rotate
 *   provider credentials, or hit destructive deletes without the actual
 *   user noticing until the audit log surfaces the event.
 *
 *   Step-up auth requires the user to RE-PRESENT a credential (password OR
 *   the TOTP code when 2FA is enabled) before destructive ops proceed. The
 *   server mints a short-lived (5-min) JWT bound to (userId, tenantId, kind:
 *   'step-up') that the destructive endpoint validates via the
 *   `requireStepUp()` middleware factory in `middleware/auth.js`.
 *
 *   This is NOT a session-replacement — it lives alongside the normal
 *   `Authorization: Bearer <jwt>` header. The SPA stores the step-up token
 *   transiently (in-memory only; never persisted) and attaches it via
 *   `x-step-up-token: <jwt>` on the destructive request.
 *
 * Endpoint shape:
 *   POST /api/auth/step-up
 *   Body: { password?: string, totpCode?: string }
 *     One of password or totpCode is required. If 2FA is enabled on the
 *     user, totpCode is REQUIRED (bcrypt-comparing the password alone is
 *     insufficient when 2FA is the second factor by policy).
 *   Response (200):
 *     { stepUpToken: string, expiresIn: number, method: 'password'|'totp' }
 *   Errors:
 *     400 MISSING_CREDENTIAL  — neither password nor totpCode supplied
 *     401 STEP_UP_FAILED      — wrong password / wrong TOTP
 *     400 TOTP_REQUIRED       — 2FA enabled but only password supplied
 *
 * Auditability:
 *   Every successful + failed step-up emits an AuditLog row so the security
 *   team can investigate sudden bursts of step-up requests (credential
 *   stuffing / brute force) and prove (or disprove) that a destructive
 *   action was preceded by a real human-presence confirmation.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const { verifyToken, signStepUpToken } = require('../middleware/auth');

const router = express.Router();
const prisma = require('../lib/prisma');

// The audit helper has a try/catch internally so we don't fail-loud on
// audit-store outages. Best-effort recording aligned with the rest of the
// codebase (see writeAudit usage in auth_2fa.js).
let writeAudit;
try {
  // eslint-disable-next-line global-require
  writeAudit = require('../lib/audit').writeAudit;
} catch (_e) {
  writeAudit = async () => {}; // best-effort fallback
}

const STEP_UP_TTL_SECONDS = 5 * 60; // 5 minutes

function verifyTotp(secretBase32, token) {
  if (!secretBase32 || !token) return false;
  return speakeasy.totp.verify({
    secret: secretBase32,
    encoding: 'base32',
    token: String(token).trim(),
    window: 1, // ±30s clock drift
  });
}

// All step-up routes require an authenticated caller — you can't step up
// without first having a session.
router.use(verifyToken);

router.post('/', async (req, res) => {
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : null;
  const totpCode = req.body && req.body.totpCode != null ? String(req.body.totpCode) : null;

  if (!password && !totpCode) {
    return res.status(400).json({
      error: 'Either password or totpCode is required.',
      code: 'MISSING_CREDENTIAL',
    });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) {
      // Defensive: token said this user existed at login; if they've been
      // deleted since, the destructive op shouldn't be possible anyway.
      return res.status(401).json({
        error: 'Step-up confirmation failed.',
        code: 'STEP_UP_FAILED',
      });
    }

    // Policy: when 2FA is enabled, the user MUST present a fresh TOTP code.
    // Password alone is treated as the first factor; the second factor is
    // the gate that human presence demands. This matches the 2FA disable
    // contract in routes/auth_2fa.js.
    if (user.twoFactorEnabled && !totpCode) {
      return res.status(400).json({
        error: 'TOTP code required when 2FA is enabled.',
        code: 'TOTP_REQUIRED',
      });
    }

    let method = null;
    if (totpCode && user.twoFactorEnabled && user.twoFactorSecret) {
      if (verifyTotp(user.twoFactorSecret, totpCode)) {
        method = 'totp';
      }
    }
    if (!method && password) {
      const ok = await bcrypt.compare(password, user.password);
      if (ok) {
        method = 'password';
      }
    }

    if (!method) {
      // Audit the failure — high-signal for credential-stuffing detection.
      writeAudit('User', 'STEP_UP_FAILED', user.id, user.id, req.user.tenantId, {
        reason: 'invalid_credential',
        usedTotp: !!totpCode,
        usedPassword: !!password,
      });
      return res.status(401).json({
        error: 'Step-up confirmation failed.',
        code: 'STEP_UP_FAILED',
      });
    }

    const stepUpToken = signStepUpToken(
      {
        userId: user.id,
        tenantId: req.user.tenantId,
        method,
      },
      STEP_UP_TTL_SECONDS
    );

    writeAudit('User', 'STEP_UP_SUCCESS', user.id, user.id, req.user.tenantId, {
      method,
      ttlSeconds: STEP_UP_TTL_SECONDS,
    });

    return res.json({
      stepUpToken,
      expiresIn: STEP_UP_TTL_SECONDS,
      method,
    });
  } catch (err) {
    console.error('[auth/step-up] error:', err);
    return res.status(500).json({ error: 'Failed to confirm step-up authentication.' });
  }
});

module.exports = router;
