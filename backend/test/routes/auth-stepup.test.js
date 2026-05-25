// @ts-check
/**
 * Unit tests for backend/routes/auth_stepup.js — pins the step-up
 * authentication contract because every behavior here is security-critical
 * (re-auth gate for destructive admin flows, TOTP-required-when-2FA-enabled
 * policy, audit emission on failure for credential-stuffing detection, and
 * the short-lived 5-minute step-up token shape).
 *
 * Threat model (mirrors the route's header)
 * ─────────────────────────────────────────
 *   A session JWT proves "user logged in within the last 7 days"; it does
 *   NOT prove "user is at the keyboard right now". POST /api/auth/step-up
 *   forces re-presentation of a credential (password OR TOTP) and mints a
 *   5-min `stepUpToken` (kind: 'step-up') that destructive endpoints
 *   validate via requireStepUp() in middleware/auth.js.
 *
 * Surface pinned
 * ──────────────
 *   POST /api/auth/step-up
 *     Body: { password?: string, totpCode?: string }
 *     - One of password or totpCode is REQUIRED.
 *     - If user.twoFactorEnabled, totpCode is REQUIRED (password alone is
 *       insufficient — the second factor is the human-presence gate).
 *   Response (200):
 *     { stepUpToken: string, expiresIn: 300, method: 'password' | 'totp' }
 *   Errors:
 *     400 MISSING_CREDENTIAL  — neither password nor totpCode supplied
 *     400 TOTP_REQUIRED        — 2FA enabled but only password supplied
 *     401 STEP_UP_FAILED       — wrong credential or user-not-found
 *
 * What this file pins (12 cases)
 * ──────────────────────────────
 *    1. verifyToken gate: missing Authorization header → 401 (no
 *       step-up without an active session).
 *    2. Missing both credentials → 400 MISSING_CREDENTIAL.
 *    3. User-not-found (token says userId N but DB has none) →
 *       401 STEP_UP_FAILED, NOT 500 — defensive contract.
 *    4. 2FA enabled but caller sent ONLY password → 400 TOTP_REQUIRED
 *       (policy: when 2FA is on, second factor is mandatory).
 *    5. Happy path — password (2FA disabled): returns a 5-min
 *       stepUpToken whose decoded claims carry kind:'step-up',
 *       userId, tenantId, method:'password'.
 *    6. Wrong password (2FA disabled) → 401 STEP_UP_FAILED.
 *    7. Happy path — TOTP (2FA enabled): returns step-up token with
 *       method:'totp'. Audit-log row records the success.
 *    8. Wrong TOTP code (2FA enabled, also wrong password supplied) →
 *       401 STEP_UP_FAILED + audit row records the FAILURE with
 *       usedTotp:true, usedPassword:true (credential-stuffing signal).
 *    9. TOTP precedence: when 2FA is enabled and BOTH totp + password
 *       supplied, the TOTP path wins (method:'totp', not 'password') —
 *       guards against the password-alone-acceptance regression class.
 *   10. Token TTL: the issued stepUpToken's exp claim is ~300 seconds
 *       from iat (the 5-minute STEP_UP_TTL_SECONDS contract). Important
 *       because middleware/auth.js requireStepUp() also enforces a
 *       wall-clock timeoutMs and the JWT exp must match.
 *   11. Cross-user replay guard: the issued token's userId claim
 *       matches the AUTHENTICATED caller's userId — a step-up cannot
 *       be minted FOR a different user (defense-in-depth alongside
 *       requireStepUp's userId-mismatch rejection).
 *   12. tenantId propagation: the step-up token's tenantId claim
 *       comes from req.user (the session JWT), NOT from req.body, so
 *       a body-injected tenantId cannot escape the caller's tenant.
 *
 * Test pattern mirrors backend/test/routes/auth-2fa.test.js — prisma
 * singleton monkey-patch BEFORE requiring the router, supertest with a
 * real Bearer JWT (so we traverse the real verifyToken middleware), and
 * speakeasy is used to generate genuine TOTP codes against a real secret
 * (no totp-verify mock).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patch (must happen BEFORE the router require()s,
// because the router captures `prisma` at load time via lib/prisma). Also
// stub auditLog.* so the writeAudit calls (success + failure paths) become
// no-ops instead of attempting real DB writes. The CJS route loader bypasses
// vi.mock() so we patch the singleton itself.
prisma.user = {
  findUnique: vi.fn(),
};
prisma.auditLog = {
  findFirst: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({}),
};
prisma.revokedToken = {
  findUnique: vi.fn().mockResolvedValue(null),
};

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const stepUpRouter = requireCJS('../../routes/auth_stepup');

// JWT_SECRET resolution — config/secrets.js prefers JWT_SECRET env, else the
// documented dev fallback. We hard-code the dev fallback here so the secret
// the route uses matches the secret we sign Bearer tokens with.
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Build a real Bearer token that verifyToken (middleware/auth.js) accepts —
// same JWT_SECRET, userId + tenantId + role claims. This is the cleanest way
// to traverse the auth middleware without mocking it.
function bearer({ userId = 7, tenantId = 1, role = 'USER' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '5m' });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth/step-up', stepUpRouter);
  return app;
}

// Helper: generate a valid TOTP token for a given base32 secret using the
// same library the route uses. NOT a mock — we exercise the real
// speakeasy.totp.verify path against a real speakeasy.totp() output.
function totpFor(secretBase32) {
  return speakeasy.totp({ secret: secretBase32, encoding: 'base32' });
}

beforeEach(() => {
  prisma.user.findUnique.mockReset();
  prisma.auditLog.create.mockClear();
});

// ── Auth gate ──────────────────────────────────────────────────────

describe('verifyToken gate', () => {
  test('missing Authorization header → 401 (cannot step up without session)', async () => {
    const res = await request(makeApp())
      .post('/api/auth/step-up')
      .send({ password: 'anything' });
    expect(res.status).toBe(401);
    // Critical: we must NOT reach the route handler if auth is missing.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

// ── Body validation ────────────────────────────────────────────────

describe('POST / — body validation', () => {
  test('missing both password and totpCode → 400 MISSING_CREDENTIAL', async () => {
    const res = await request(makeApp())
      .post('/api/auth/step-up')
      .set('Authorization', bearer())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_CREDENTIAL');
    expect(res.body.error).toMatch(/password or totpCode is required/i);
    // Validation must run BEFORE we hit the database — cheap guard.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

// ── User lookup ────────────────────────────────────────────────────

describe('POST / — user resolution', () => {
  test('user-not-found in DB → 401 STEP_UP_FAILED (defensive — never 500)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/auth/step-up')
      .set('Authorization', bearer())
      .send({ password: 'anything' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('STEP_UP_FAILED');
  });
});

// ── 2FA policy gate ────────────────────────────────────────────────

describe('POST / — 2FA-enabled policy', () => {
  test('2FA enabled but only password supplied → 400 TOTP_REQUIRED', async () => {
    const pwHash = await bcrypt.hash('correct-password', 10);
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', password: pwHash,
      twoFactorEnabled: true, twoFactorSecret: secret,
    });

    const res = await request(makeApp())
      .post('/api/auth/step-up')
      .set('Authorization', bearer())
      .send({ password: 'correct-password' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOTP_REQUIRED');
    expect(res.body.error).toMatch(/TOTP code required/i);
  });
});

// ── Happy paths ────────────────────────────────────────────────────

describe('POST / — password method (2FA disabled)', () => {
  test('correct password → 200 + stepUpToken with kind:step-up, method:password', async () => {
    const pwHash = await bcrypt.hash('correct-password', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', password: pwHash,
      twoFactorEnabled: false, twoFactorSecret: null,
    });

    const res = await request(makeApp())
      .post('/api/auth/step-up')
      .set('Authorization', bearer({ userId: 7, tenantId: 1 }))
      .send({ password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.stepUpToken).toBeTruthy();
    expect(res.body.expiresIn).toBe(300);
    expect(res.body.method).toBe('password');

    // Decode the issued step-up token and verify claims match the contract.
    const decoded = jwt.verify(res.body.stepUpToken, JWT_SECRET);
    expect(decoded.kind).toBe('step-up');
    expect(decoded.userId).toBe(7);
    expect(decoded.tenantId).toBe(1);
    expect(decoded.method).toBe('password');
  });

  test('wrong password (2FA disabled) → 401 STEP_UP_FAILED', async () => {
    const pwHash = await bcrypt.hash('correct-password', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', password: pwHash,
      twoFactorEnabled: false, twoFactorSecret: null,
    });

    const res = await request(makeApp())
      .post('/api/auth/step-up')
      .set('Authorization', bearer())
      .send({ password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('STEP_UP_FAILED');
  });
});

describe('POST / — totp method (2FA enabled)', () => {
  test('correct TOTP code → 200 + stepUpToken method:totp + audit-success row', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', password: 'irrelevant-hash',
      twoFactorEnabled: true, twoFactorSecret: secret,
    });

    const res = await request(makeApp())
      .post('/api/auth/step-up')
      .set('Authorization', bearer({ userId: 7, tenantId: 1 }))
      .send({ totpCode: totpFor(secret) });
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('totp');
    expect(res.body.expiresIn).toBe(300);

    const decoded = jwt.verify(res.body.stepUpToken, JWT_SECRET);
    expect(decoded.kind).toBe('step-up');
    expect(decoded.method).toBe('totp');

    // Audit row recorded the success — important for the
    // "prove human-presence preceded the destructive action" claim.
    // writeAudit ultimately invokes prisma.auditLog.create.
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const auditArgs = prisma.auditLog.create.mock.calls.find(
      (c) => c[0] && c[0].data && c[0].data.action === 'STEP_UP_SUCCESS',
    );
    expect(auditArgs).toBeDefined();
    expect(auditArgs[0].data.entity).toBe('User');
    expect(auditArgs[0].data.userId).toBe(7);
  });

  test('wrong TOTP + wrong password (2FA enabled) → 401 STEP_UP_FAILED + audit-failure row', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const pwHash = await bcrypt.hash('correct-password', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', password: pwHash,
      twoFactorEnabled: true, twoFactorSecret: secret,
    });

    const res = await request(makeApp())
      .post('/api/auth/step-up')
      .set('Authorization', bearer())
      .send({ totpCode: '000000', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('STEP_UP_FAILED');

    // Audit row records the FAILURE with both usedTotp + usedPassword true —
    // high-signal for credential-stuffing detection per the route header.
    const failureCall = prisma.auditLog.create.mock.calls.find(
      (c) => c[0] && c[0].data && c[0].data.action === 'STEP_UP_FAILED',
    );
    expect(failureCall).toBeDefined();
    const detailsJson = failureCall[0].data.details;
    expect(typeof detailsJson).toBe('string');
    const details = JSON.parse(detailsJson);
    expect(details.reason).toBe('invalid_credential');
    expect(details.usedTotp).toBe(true);
    expect(details.usedPassword).toBe(true);
  });

  test('TOTP-precedence: when 2FA enabled + both totpCode + password sent, method is "totp" (NOT "password")', async () => {
    // Regression guard: if the route ever short-circuited on a valid
    // password before checking TOTP, this test would catch the slip —
    // a stolen password alone could mint a step-up despite 2FA being
    // mandatory. The current handler enforces totpCode FIRST when 2FA
    // is enabled (lines 112-116), so method must be 'totp'.
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const pwHash = await bcrypt.hash('correct-password', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', password: pwHash,
      twoFactorEnabled: true, twoFactorSecret: secret,
    });

    const res = await request(makeApp())
      .post('/api/auth/step-up')
      .set('Authorization', bearer())
      .send({ totpCode: totpFor(secret), password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('totp');
  });
});

// ── Token shape contracts ──────────────────────────────────────────

describe('POST / — issued stepUpToken shape', () => {
  test('exp claim is ~300 seconds from iat (STEP_UP_TTL_SECONDS contract)', async () => {
    const pwHash = await bcrypt.hash('correct-password', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', password: pwHash,
      twoFactorEnabled: false, twoFactorSecret: null,
    });

    const res = await request(makeApp())
      .post('/api/auth/step-up')
      .set('Authorization', bearer())
      .send({ password: 'correct-password' });
    expect(res.status).toBe(200);

    const decoded = jwt.verify(res.body.stepUpToken, JWT_SECRET);
    expect(typeof decoded.iat).toBe('number');
    expect(typeof decoded.exp).toBe('number');
    const ttl = decoded.exp - decoded.iat;
    // jwt rounds iat/exp to whole seconds — exact equality is fine,
    // but allow ±1s for any future clock-resolution wobble.
    expect(ttl).toBeGreaterThanOrEqual(299);
    expect(ttl).toBeLessThanOrEqual(301);
  });

  test('userId in token comes from session JWT (req.user), pinning who-issued binding', async () => {
    // The session JWT says userId=42. Even if the body or DB row carried
    // a different id, the step-up token's userId claim must reflect the
    // authenticated caller (req.user.userId) — required for
    // requireStepUp()'s userId-mismatch rejection to work.
    const pwHash = await bcrypt.hash('correct-password', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 42, email: 'r@x.com', password: pwHash,
      twoFactorEnabled: false, twoFactorSecret: null,
    });

    const res = await request(makeApp())
      .post('/api/auth/step-up')
      .set('Authorization', bearer({ userId: 42, tenantId: 99 }))
      .send({ password: 'correct-password' });
    expect(res.status).toBe(200);

    const decoded = jwt.verify(res.body.stepUpToken, JWT_SECRET);
    expect(decoded.userId).toBe(42);
    expect(decoded.tenantId).toBe(99);
  });

  test('tenantId comes from session JWT, NOT from request body (cross-tenant guard)', async () => {
    // If the route incorrectly read req.body.tenantId, an attacker with a
    // stolen tenant-1 session could mint a step-up token claiming tenantId=2
    // and use it against tenant-2 destructive endpoints. The global
    // stripDangerous middleware already deletes body.tenantId on real
    // traffic, but this unit-level guard pins the route's INTERNAL
    // contract (req.user.tenantId, not req.body.tenantId).
    const pwHash = await bcrypt.hash('correct-password', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', password: pwHash,
      twoFactorEnabled: false, twoFactorSecret: null,
    });

    const res = await request(makeApp())
      .post('/api/auth/step-up')
      .set('Authorization', bearer({ userId: 7, tenantId: 1 }))
      // Try to coerce tenantId via the body — this test app does NOT mount
      // stripDangerous, so if the route trusted req.body.tenantId we'd
      // see tenantId=999 in the token. Real server mounts stripDangerous;
      // this test pins the route's resilience even WITHOUT that defense.
      .send({ password: 'correct-password', tenantId: 999 });
    expect(res.status).toBe(200);

    const decoded = jwt.verify(res.body.stepUpToken, JWT_SECRET);
    expect(decoded.tenantId).toBe(1);
    expect(decoded.tenantId).not.toBe(999);
  });
});
