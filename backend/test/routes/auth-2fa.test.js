// @ts-check
/**
 * Unit tests for backend/routes/auth_2fa.js — pins the 2FA enrollment +
 * verification contract because every behavior here is security-critical
 * (TOTP secret bootstrap, code-replay surface, backup-code consumption,
 * password re-auth on disable, tempToken acceptance on verify).
 *
 * Surface pinned
 * ──────────────
 *   POST /setup    — verifyToken-gated; generates a base32 TOTP secret +
 *                    persists it to user.twoFactorSecret (NOT yet enabled),
 *                    returns secret + QR-code data URL.
 *   POST /enable   — verifyToken-gated; verifies a TOTP code against the
 *                    pre-saved secret, flips twoFactorEnabled=true, and
 *                    issues 10 plaintext backup codes (returned ONCE).
 *   POST /disable  — verifyToken-gated; requires BOTH current password AND
 *                    current TOTP code, clears 2FA state.
 *   POST /verify   — NO verifyToken; consumes a short-lived tempToken
 *                    (awaiting2FA:true claim) from the /login flow, accepts
 *                    a TOTP code OR a single-use backup code, and issues
 *                    the final 7-day JWT.
 *
 * What this file pins (13 cases)
 * ──────────────────────────────
 *   1.  POST /setup writes a base32 secret to the user row and returns it
 *       with a data-URL QR code.
 *   2.  POST /setup with no matching user → 404.
 *   3.  POST /enable rejects an empty code with 400 (validation error).
 *   4.  POST /enable with no prior /setup → 400 ("not initialized").
 *   5.  POST /enable with a bad TOTP code → 400 + does NOT flip
 *       twoFactorEnabled (replay/guessing-attack guard).
 *   6.  POST /enable happy path: flips twoFactorEnabled=true, returns 10
 *       plaintext backup codes, persists them HASHED (the plaintext is
 *       never re-readable from DB).
 *   7.  POST /disable requires both password AND code (400 otherwise).
 *   8.  POST /disable with wrong password → 400 + 2FA stays enabled
 *       (re-auth guard against stolen-session disable).
 *   9.  POST /disable with bad TOTP code → 400 + 2FA stays enabled.
 *  10.  POST /disable happy path clears secret + backupCodes + enabled flag.
 *  11.  POST /verify rejects a tempToken whose awaiting2FA claim is missing
 *       (401) — defense against using a regular login JWT as a 2FA bypass.
 *  12.  POST /verify with an expired tempToken returns 401 + the
 *       "challenge expired" envelope (NOT a generic 401, so the client can
 *       prompt re-login vs. wrong-code retry).
 *  13.  POST /verify happy path: returns the final 7-day JWT, the user +
 *       tenant payload, and backupCodeUsed=false on TOTP-code verify.
 *  14.  POST /verify backup-code path: consumes ONE backup code (it's
 *       removed from the hashed list on success); reusing the same code
 *       a second time fails. This is the replay-attack guard.
 *  15.  Auth gate: /setup, /enable, /disable all require verifyToken
 *       (no auth header → 401 via the project's verifyToken middleware).
 *       /verify is intentionally unauthenticated (tempToken IS the auth).
 *
 * Test pattern mirrors backend/test/routes/staff.test.js — prisma singleton
 * monkey-patch + supertest with a fake auth middleware for the gated routes,
 * plus a separate app instance with NO auth middleware to exercise /verify
 * (which has no verifyToken).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patch (must happen BEFORE the router is require()d
// because the router captures `prisma` at load time via lib/prisma).
// Also stub auditLog.* so writeAudit (called by /verify) becomes a no-op
// instead of attempting a real DB hit. The CJS route loader bypasses
// vi.mock() so we patch the singleton itself. ─────────────────────────
prisma.user = {
  findUnique: vi.fn(),
  update: vi.fn(),
};
prisma.auditLog = {
  findFirst: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({}),
};
// verifyToken middleware does a revoked-jti lookup; the JWTs we mint in
// tests don't carry a jti so this is technically dead code on the test
// path, but stubbing it defensively keeps the helper resilient if a
// future Bearer construction adds one.
prisma.revokedToken = {
  findUnique: vi.fn().mockResolvedValue(null),
};

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const auth2faRouter = requireCJS('../../routes/auth_2fa');

// JWT_SECRET resolution — config/secrets.js prefers JWT_SECRET env, else the
// documented dev fallback. We hard-code the dev fallback here so the secret
// the route uses matches the secret we sign tempTokens with.
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Build a real Bearer token that verifyToken (middleware/auth.js) will
// accept — same JWT_SECRET, userId claim present. This is the cleanest way
// to traverse the auth middleware without mocking it.
function bearer({ userId = 7, tenantId = 1, role = 'USER' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '5m' });
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth/2fa', auth2faRouter);
  return app;
}
// /verify is unauthenticated (the tempToken IS the auth). The app shape
// is identical to makeApp(); we just don't set an Authorization header on
// /verify calls. Aliased for readability at call sites.
const makePublicApp = makeApp;

// Helper: generate a valid TOTP token for a given base32 secret using the
// same library the route uses. NOT a mock — we exercise the real
// speakeasy.totp.verify path against a real speakeasy.totp() output.
function totpFor(secretBase32) {
  return speakeasy.totp({ secret: secretBase32, encoding: 'base32' });
}

beforeEach(() => {
  prisma.user.findUnique.mockReset();
  prisma.user.update.mockReset();
});

// ── POST /setup ────────────────────────────────────────────────────

describe('POST /setup — initialize TOTP secret', () => {
  test('saves a base32 secret and returns it with a data-URL QR code', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'rishu@enhancedwellness.in', twoFactorSecret: null,
    });
    prisma.user.update.mockResolvedValue({});

    const res = await request(makeApp())
      .post('/api/auth/2fa/setup')
      .set('Authorization', bearer())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^[A-Z2-7]+$/); // base32 alphabet
    expect(res.body.qrCode).toMatch(/^data:image\/png;base64,/);

    // Persisted to the user row, NOT yet enabled.
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7 },
      data: { twoFactorSecret: res.body.secret },
    }));
  });

  test('user not found → 404', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/auth/2fa/setup')
      .set('Authorization', bearer())
      .send({});
    expect(res.status).toBe(404);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

// ── POST /enable ───────────────────────────────────────────────────

describe('POST /enable — verify code + flip twoFactorEnabled', () => {
  test('rejects empty body with 400', async () => {
    const res = await request(makeApp())
      .post('/api/auth/2fa/enable')
      .set('Authorization', bearer())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('no prior /setup → 400 (must initialize first)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', twoFactorSecret: null,
    });
    const res = await request(makeApp())
      .post('/api/auth/2fa/enable')
      .set('Authorization', bearer())
      .send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not been initialized/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('bad TOTP code → 400 + twoFactorEnabled NOT flipped', async () => {
    // A genuine secret, but we submit a code that doesn't match.
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', twoFactorSecret: secret,
    });

    const res = await request(makeApp())
      .post('/api/auth/2fa/enable')
      .set('Authorization', bearer())
      .send({ code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    // Critical: failed enroll attempt must NOT touch the user row.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('happy path: flips enabled=true, returns 10 plaintext backup codes, persists them HASHED', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', twoFactorSecret: secret,
    });
    prisma.user.update.mockResolvedValue({});

    const res = await request(makeApp())
      .post('/api/auth/2fa/enable')
      .set('Authorization', bearer())
      .send({ code: totpFor(secret) });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.backupCodes)).toBe(true);
    expect(res.body.backupCodes).toHaveLength(10);
    // Each code is 8 chars from the unambiguous alphabet.
    for (const code of res.body.backupCodes) {
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    }

    const updateArgs = prisma.user.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 7 });
    expect(updateArgs.data.twoFactorEnabled).toBe(true);

    // Backup codes are stored HASHED — the plaintext array we just got back
    // must NOT appear anywhere in the persisted column.
    const storedJson = updateArgs.data.backupCodes;
    expect(typeof storedJson).toBe('string');
    const stored = JSON.parse(storedJson);
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      // bcrypt hashes start with $2 — proves it's not plaintext.
      expect(stored[i]).toMatch(/^\$2[aby]\$/);
      expect(stored[i]).not.toBe(res.body.backupCodes[i]);
    }
  });
});

// ── POST /disable ──────────────────────────────────────────────────

describe('POST /disable — re-auth gate + clear state', () => {
  test('requires BOTH password and code (missing either → 400)', async () => {
    const res = await request(makeApp())
      .post('/api/auth/2fa/disable')
      .set('Authorization', bearer())
      .send({ password: 'only-password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('wrong password → 400 + 2FA stays enabled', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const pwHash = await bcrypt.hash('correct-password', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', password: pwHash,
      twoFactorSecret: secret, twoFactorEnabled: true,
    });

    const res = await request(makeApp())
      .post('/api/auth/2fa/disable')
      .set('Authorization', bearer())
      .send({ password: 'wrong-password', code: totpFor(secret) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password is incorrect/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('bad TOTP code → 400 + 2FA stays enabled', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const pwHash = await bcrypt.hash('correct-password', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', password: pwHash,
      twoFactorSecret: secret, twoFactorEnabled: true,
    });

    const res = await request(makeApp())
      .post('/api/auth/2fa/disable')
      .set('Authorization', bearer())
      .send({ password: 'correct-password', code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid verification code/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('2FA not enabled → 400', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', password: 'hashed',
      twoFactorSecret: null, twoFactorEnabled: false,
    });
    const res = await request(makeApp())
      .post('/api/auth/2fa/disable')
      .set('Authorization', bearer())
      .send({ password: 'any', code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not enabled/i);
  });

  test('happy path clears twoFactorEnabled + twoFactorSecret + backupCodes', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const pwHash = await bcrypt.hash('correct-password', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'r@x.com', password: pwHash,
      twoFactorSecret: secret, twoFactorEnabled: true,
      backupCodes: JSON.stringify(['$2a$10$abc']),
    });
    prisma.user.update.mockResolvedValue({});

    const res = await request(makeApp())
      .post('/api/auth/2fa/disable')
      .set('Authorization', bearer())
      .send({ password: 'correct-password', code: totpFor(secret) });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const updateArgs = prisma.user.update.mock.calls[0][0];
    expect(updateArgs.data).toEqual({
      twoFactorEnabled: false,
      twoFactorSecret: null,
      backupCodes: null,
    });
  });
});

// ── POST /verify — tempToken + TOTP / backup code → final JWT ─────

describe('POST /verify — login-step-2 surface', () => {
  test('tempToken missing awaiting2FA:true claim → 401', async () => {
    // A "regular" login JWT would have userId but NOT awaiting2FA — must
    // not be accepted as a 2FA challenge token.
    const fakeToken = jwt.sign({ userId: 7 }, JWT_SECRET, { expiresIn: '5m' });
    const res = await request(makePublicApp())
      .post('/api/auth/2fa/verify')
      .send({ tempToken: fakeToken, code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid 2fa challenge token/i);
  });

  test('expired tempToken → 401 with "challenge expired" envelope', async () => {
    const expired = jwt.sign(
      { userId: 7, awaiting2FA: true },
      JWT_SECRET,
      { expiresIn: '-5s' } // already expired
    );
    const res = await request(makePublicApp())
      .post('/api/auth/2fa/verify')
      .send({ tempToken: expired, code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  test('happy path: valid TOTP returns 7-day JWT + user + tenant; backupCodeUsed=false', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    prisma.user.findUnique.mockResolvedValue({
      id: 7, email: 'rishu@enhancedwellness.in', name: 'Rishu',
      role: 'ADMIN', wellnessRole: null, tenantId: 2,
      twoFactorEnabled: true, twoFactorSecret: secret,
      backupCodes: JSON.stringify([]),
      tenant: { id: 2, name: 'Enhanced Wellness', slug: 'wellness',
        plan: 'pro', vertical: 'wellness', country: 'IN',
        defaultCurrency: 'INR', locale: 'en-IN', logoUrl: null, brandColor: null },
    });

    const tempToken = jwt.sign(
      { userId: 7, awaiting2FA: true },
      JWT_SECRET,
      { expiresIn: '5m' }
    );

    const res = await request(makePublicApp())
      .post('/api/auth/2fa/verify')
      .send({ tempToken, code: totpFor(secret) });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.backupCodeUsed).toBe(false);

    // The issued JWT carries the 7-day TTL + the expected claims.
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.userId).toBe(7);
    expect(decoded.role).toBe('ADMIN');
    expect(decoded.tenantId).toBe(2);
    expect(decoded.vertical).toBe('wellness');
    expect(decoded.jti).toMatch(/^[a-f0-9]{32}$/); // 16 random bytes hex-encoded

    expect(res.body.user.email).toBe('rishu@enhancedwellness.in');
    expect(res.body.tenant.vertical).toBe('wellness');
    expect(res.body.tenant.defaultCurrency).toBe('INR');
  });

  test('backup code: consumed on success → reuse of same code fails', async () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const plain = 'ABCD2345';
    const hashed = await bcrypt.hash(plain, 10);
    // Track current hashed list across the two-step call sequence.
    let currentBackup = JSON.stringify([hashed]);

    prisma.user.findUnique.mockImplementation(async () => ({
      id: 7, email: 'r@x.com', name: 'R', role: 'USER', wellnessRole: null,
      tenantId: 1, twoFactorEnabled: true, twoFactorSecret: secret,
      backupCodes: currentBackup,
      tenant: { id: 1, name: 'T', slug: 't', plan: 'free', vertical: 'generic',
        country: 'US', defaultCurrency: 'USD', locale: 'en-US', logoUrl: null, brandColor: null },
    }));
    prisma.user.update.mockImplementation(async ({ data }) => {
      if (typeof data.backupCodes === 'string') currentBackup = data.backupCodes;
      return {};
    });

    const tempToken = jwt.sign({ userId: 7, awaiting2FA: true }, JWT_SECRET, { expiresIn: '5m' });

    // First attempt: backup code (NOT a valid TOTP) — should succeed and
    // the route should call prisma.user.update with the code removed from
    // the hashed list (now empty array).
    const r1 = await request(makePublicApp())
      .post('/api/auth/2fa/verify')
      .send({ tempToken, code: plain });
    expect(r1.status).toBe(200);
    expect(r1.body.backupCodeUsed).toBe(true);
    // The persisted column should now be an empty JSON array — proving
    // single-use consumption.
    expect(JSON.parse(currentBackup)).toEqual([]);

    // Second attempt with the SAME backup code: must fail (replay guard).
    const r2 = await request(makePublicApp())
      .post('/api/auth/2fa/verify')
      .send({ tempToken, code: plain });
    expect(r2.status).toBe(401);
    expect(r2.body.error).toMatch(/invalid verification code/i);
  });

  test('missing tempToken or code → 400', async () => {
    const res = await request(makePublicApp())
      .post('/api/auth/2fa/verify').send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });
});
