// @ts-check
/**
 * Unit tests for #914 slice 1 — additive HttpOnly cookie write from the
 * auth-success paths (login, signup, register, logout, 2fa-verify).
 *
 * What this file pins
 * ───────────────────
 *   POST /api/auth/login    → Set-Cookie: auth_token=... on success
 *   POST /api/auth/signup   → Set-Cookie: auth_token=... on success
 *   POST /api/auth/register → Set-Cookie: auth_token=... on success
 *   POST /api/auth/logout   → Set-Cookie clears auth_token
 *   POST /api/auth/2fa/verify (auth_2fa.js) → Set-Cookie on success
 *
 * What this file does NOT pin (deliberately — those are later slices):
 *   - middleware/auth.js does NOT yet read the cookie. The Bearer-header
 *     flow is untouched. Slice 2 wires cookie-read into verifyToken.
 *   - The response body still returns `token` exactly as before. Specs
 *     pinning the JSON shape are unaffected.
 *   - No CSRF token issued yet. Slice 4.
 *
 * Test pattern: prisma singleton monkey-patch + supertest. Mirrors
 * backend/test/routes/auth-2fa.test.js verbatim — the prisma singleton
 * is captured at require-time by the route module, so we must patch the
 * singleton BEFORE requiring the router.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patch (BEFORE the routers are required) ─────────
prisma.user = {
  findUnique: vi.fn(),
  // Schema drift: User.email composite-unique with tenantId means login
  // now uses findFirst. Delegate to findUnique so existing per-test
  // mockResolvedValue calls cover both paths.
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  // T37 / Class B6: provisionTenantRbacInternal iterates tenant users
  // (scripts/ensureRbacOnBoot.js:618) on the signup/register paths.
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.tenant = {
  findUnique: vi.fn().mockResolvedValue(null), // generateUniqueSlug loop terminator
  create: vi.fn(),
  // T37 / Class B6: ensureRbacOnBoot's discovery path enumerates tenants;
  // provisionTenantRbac itself doesn't normally call findMany on the
  // signup path (it operates on a known tenantId) but stub permissively.
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.auditLog = {
  findFirst: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({}),
};
prisma.revokedToken = {
  findUnique: vi.fn().mockResolvedValue(null),
  upsert: vi.fn().mockResolvedValue({}),
};
// T37 / Class B6 — RBAC self-heal seam. The /login + /signup + /register
// + /2fa/verify paths transit through `provisionRbacForFreshTenant`
// (on signup/register) AND the inline self-heal block in /login
// (auth.js:521-535). Both reach into prisma.userRole / prisma.role /
// prisma.rolePermission / prisma.roleWidget. Without these stubs the
// real Prisma client tries to connect to demo MySQL and the 5s test
// timeout fires (the errors are caught as non-fatal, but the await
// blocks until the underlying socket retry exhausts). All stubs are
// permissive: empty arrays / nulls so the self-heal exits cleanly.
prisma.userRole = {
  count: vi.fn().mockResolvedValue(1), // userRoleCount>0 → self-heal skips
  findUnique: vi.fn().mockResolvedValue(null),
  findFirst: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({}),
};
prisma.role = {
  // Make ensureRole's findFirst return an "existing" row so the
  // provisioner short-circuits without calling create / permissions /
  // widgets. Any truthy id will do — provisioner only reads { id }.
  findFirst: vi.fn().mockResolvedValue({ id: 999 }),
  create: vi.fn().mockResolvedValue({ id: 999 }),
};
prisma.rolePermission = {
  findFirst: vi.fn().mockResolvedValue({ id: 999 }),
  create: vi.fn().mockResolvedValue({}),
};
prisma.roleWidget = {
  create: vi.fn().mockResolvedValue({}),
};

import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const authRouter = requireCJS('../../routes/auth');
const auth2faRouter = requireCJS('../../routes/auth_2fa');

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser()); // supertest's `res.headers['set-cookie']` works regardless,
  // but mounting cookie-parser keeps the app shape closer to production.
  app.use('/api/auth', authRouter);
  app.use('/api/auth/2fa', auth2faRouter);
  return app;
}

/**
 * Find the auth_token Set-Cookie header in supertest's response.
 *
 * supertest exposes Set-Cookie as an array on res.headers['set-cookie'].
 * We return the first cookie matching `auth_token=`, or undefined if no
 * such cookie was sent.
 */
function findAuthCookie(res) {
  const cookies = res.headers['set-cookie'];
  if (!Array.isArray(cookies)) return undefined;
  return cookies.find((c) => c.startsWith('auth_token='));
}

beforeEach(() => {
  prisma.user.findUnique.mockReset();
  prisma.user.findFirst.mockReset();
  prisma.user.create.mockReset();
  prisma.user.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue(null);
  prisma.tenant.create.mockReset();
  prisma.auditLog.create.mockReset().mockResolvedValue({});
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.revokedToken.upsert.mockReset().mockResolvedValue({});
  // T37 / Class B6 — keep self-heal seam permissive across tests.
  prisma.userRole.count.mockReset().mockResolvedValue(1);
  prisma.userRole.findUnique.mockReset().mockResolvedValue(null);
  prisma.userRole.findFirst.mockReset().mockResolvedValue(null);
  prisma.userRole.findMany.mockReset().mockResolvedValue([]);
  prisma.userRole.create.mockReset().mockResolvedValue({});
  prisma.role.findFirst.mockReset().mockResolvedValue({ id: 999 });
  prisma.role.create.mockReset().mockResolvedValue({ id: 999 });
  prisma.rolePermission.findFirst.mockReset().mockResolvedValue({ id: 999 });
  prisma.rolePermission.create.mockReset().mockResolvedValue({});
  prisma.roleWidget.create.mockReset().mockResolvedValue({});
  prisma.user.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.findMany.mockReset().mockResolvedValue([]);
  // After reset: findFirst delegates to findUnique so per-test
  // findUnique.mockResolvedValue calls cover the login code path too.
  prisma.user.findFirst.mockImplementation((...args) => prisma.user.findUnique(...args));
  // Default NODE_ENV to non-production so secure=false in cookie assertions.
  delete process.env.NODE_ENV;
});

// ── POST /api/auth/login — sets the additive HttpOnly cookie ─────────

describe('POST /api/auth/login — Set-Cookie auth_token (#914 slice 1)', () => {
  test('successful login writes auth_token cookie alongside the JWT body', async () => {
    const hashed = await bcrypt.hash('password123', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      email: 'admin@globussoft.com',
      password: hashed,
      role: 'ADMIN',
      wellnessRole: null,
      twoFactorEnabled: false,
      tenantId: 1,
      tenant: { id: 1, name: 'Globussoft', slug: 'globussoft', plan: 'PRO', vertical: 'generic', country: 'US', defaultCurrency: 'USD', locale: 'en-US', logoUrl: null, brandColor: null },
    });

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'admin@globussoft.com', password: 'password123' });

    // BODY contract preserved — the token still rides in the response body
    // exactly as today. Slice 2+ will start consuming the cookie instead;
    // this slice keeps both surfaces alive.
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^eyJ/);

    // COOKIE contract added — auth_token cookie set with the canonical
    // option string. Asserting on the substring shape because supertest
    // serialises Set-Cookie as a raw RFC 6265 string, not the parsed
    // object the helper test pins.
    const cookie = findAuthCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api/i);
    expect(cookie).toMatch(/Max-Age=900/); // 15min * 60s — must match helper default
    // NODE_ENV is not 'production' in this test, so Secure must be absent.
    expect(cookie).not.toMatch(/Secure/);
  });
});

// ── POST /api/auth/signup — sets the additive HttpOnly cookie ────────

describe('POST /api/auth/signup — Set-Cookie auth_token (#914 slice 1)', () => {
  test('successful signup writes auth_token cookie alongside the JWT body', async () => {
    prisma.user.findUnique.mockResolvedValue(null); // email is free
    prisma.tenant.create.mockResolvedValue({ id: 42, name: 'Acme', slug: 'acme', plan: 'TRIAL', vertical: 'generic', country: 'US', defaultCurrency: 'USD', locale: 'en-US', logoUrl: null, brandColor: null });
    prisma.user.create.mockResolvedValue({ id: 100, email: 'new@user.com', name: 'New User', role: 'ADMIN', wellnessRole: null });

    const res = await request(makeApp())
      .post('/api/auth/signup')
      .send({ email: 'new@user.com', password: 'password123', name: 'New User', organizationName: 'Acme' });

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^eyJ/);

    const cookie = findAuthCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api/i);
  });
});

// ── POST /api/auth/register — sets the additive HttpOnly cookie ──────

describe('POST /api/auth/register — Set-Cookie auth_token (#914 slice 1)', () => {
  test('successful register writes auth_token cookie alongside the JWT body', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.tenant.create.mockResolvedValue({ id: 43, name: 'Beta Inc', slug: 'beta-inc', plan: 'TRIAL', vertical: 'generic', country: 'US', defaultCurrency: 'USD', locale: 'en-US', logoUrl: null, brandColor: null });
    prisma.user.create.mockResolvedValue({ id: 101, email: 'reg@user.com', name: 'Reg User', role: 'ADMIN', wellnessRole: null });

    const res = await request(makeApp())
      .post('/api/auth/register')
      .send({ email: 'reg@user.com', password: 'password123', name: 'Reg User', organizationName: 'Beta Inc' });

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^eyJ/);

    const cookie = findAuthCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api/i);
  });
});

// ── POST /api/auth/logout — clears the auth_token cookie ─────────────

describe('POST /api/auth/logout — Set-Cookie clears auth_token (#914 slice 1)', () => {
  test('logout emits a clear-cookie header for auth_token on /api', async () => {
    // Mint a real JWT so verifyToken accepts the request. tenantId + userId
    // are required claims; jti makes the route hit the revokedToken.upsert
    // path (already mocked to resolve).
    const token = jwt.sign(
      { userId: 7, tenantId: 1, role: 'ADMIN', jti: 'a'.repeat(32) },
      JWT_SECRET,
      { expiresIn: '5m' }
    );

    const res = await request(makeApp())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Express's res.clearCookie sets Max-Age=0 + Expires in the past so
    // the browser drops the cookie immediately. Path must match the set
    // call's path or the browser keeps the original cookie.
    const cookie = findAuthCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/Path=\/api/i);
    // Either Max-Age=0 or an Expires in 1970 — both are RFC-valid ways
    // for the framework to express "drop this cookie now."
    expect(cookie).toMatch(/(Max-Age=0|Expires=Thu, 01 Jan 1970)/i);
  });
});

// ── POST /api/auth/2fa/verify — sets the additive HttpOnly cookie ────

describe('POST /api/auth/2fa/verify — Set-Cookie auth_token (#914 slice 1)', () => {
  test('successful 2fa verify writes auth_token cookie alongside the JWT body', async () => {
    // The verify path requires a valid awaiting2FA tempToken + a matching
    // TOTP code. We mock the user row with a known secret and generate a
    // real TOTP code against that secret — same pattern as auth-2fa.test.js.
    const speakeasy = (await import('speakeasy')).default;
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    const code = speakeasy.totp({ secret, encoding: 'base32' });

    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      email: 'admin@globussoft.com',
      name: 'Admin',
      role: 'ADMIN',
      wellnessRole: null,
      tenantId: 1,
      twoFactorEnabled: true,
      twoFactorSecret: secret,
      backupCodes: null,
      tenant: { id: 1, name: 'Globussoft', slug: 'globussoft', plan: 'PRO', vertical: 'generic', country: 'US', defaultCurrency: 'USD', locale: 'en-US', logoUrl: null, brandColor: null },
    });

    const tempToken = jwt.sign(
      { userId: 7, awaiting2FA: true },
      JWT_SECRET,
      { expiresIn: '5m' }
    );

    const res = await request(makeApp())
      .post('/api/auth/2fa/verify')
      .send({ tempToken, code });

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^eyJ/);

    const cookie = findAuthCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api/i);
  });
});
