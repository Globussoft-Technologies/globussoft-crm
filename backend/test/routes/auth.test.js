// @ts-check
/**
 * Unit tests for backend/routes/auth.js — pins the MAIN-flow auth contract
 * (login, signup, register, /me, logout, password change/reset, session
 * revocation, tenant-switch). Complements the three sibling slice tests:
 *
 *   - auth-2fa.test.js         — 2FA setup/enable/disable/verify
 *   - auth-cookie-set.test.js  — #914 slice 1 Set-Cookie emission
 *   - auth-stepup.test.js      — #654 step-up auth gate
 *
 * What THIS file pins
 * ───────────────────
 *   POST /api/auth/login
 *     - 200 happy path: returns { token, user, tenant } envelope, JWT
 *       carries userId + tenantId + role + wellnessRole + vertical claims,
 *       writeAudit('Auth','LOGIN', …) emitted
 *     - 401 wrong password (Invalid credentials)
 *     - 401 unknown email — SAME envelope as wrong-password (anti-
 *       enumeration; the route runs a dummy bcrypt.compare to equalise
 *       wall-clock timing per #192)
 *     - 400 missing body (empty {}) — defensive 400, not a Prisma 500
 *     - 200 with `requires2FA:true + tempToken` when user.twoFactorEnabled
 *       (no full JWT issued)
 *   POST /api/auth/signup
 *     - 201 happy path: creates Tenant + User, returns { token, user, tenant }
 *     - 400 duplicate email
 *     - 400 weak password (no digit, <8 chars, etc.)
 *   POST /api/auth/register
 *     - 201 happy path mirrors /signup
 *     - 400 duplicate email
 *   GET  /api/auth/me
 *     - 401 without Authorization header (verifyToken gate)
 *     - 200 with valid Bearer: returns profile + features.smsConfigured
 *     - 404 when token user no longer exists
 *   POST /api/auth/logout
 *     - 200 happy path: upserts RevokedToken keyed on jti, clears the
 *       auth_token cookie (path=/api), writes audit 'User' 'LOGOUT' per #569
 *     - 200 legacy token (no jti claim): returns { ok:true, revoked:false }
 *   PUT  /api/auth/me — password change
 *     - 400 wrong current password (Current password is incorrect)
 *     - 400 missing current password when newPassword supplied
 *     - 400 weak new password (WEAK_PASSWORD code)
 *     - 400 newPassword > 72 chars (PASSWORD_TOO_LONG code — bcrypt-truncation guard)
 *   POST /api/auth/forgot-password
 *     - 200 ack identical envelope for known + unknown emails (anti-enumeration #531)
 *   POST /api/auth/reset-password
 *     - 400 weak new password (WEAK_PASSWORD)
 *     - 400 invalid/expired token
 *   POST /api/auth/tenant-switch
 *     - 410 GONE with code TENANT_SWITCH_DISABLED (#555 lock-per-session)
 *
 * Test pattern: prisma singleton monkey-patch + supertest. Mirrors
 * auth-cookie-set.test.js exactly — the prisma singleton is captured at
 * route-load time, so we must patch the singleton BEFORE requiring the router.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import prisma from '../../lib/prisma.js';

// ── prisma singleton patch (BEFORE the router is required) ───────────
prisma.user = {
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
prisma.tenant = {
  findUnique: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
};
prisma.auditLog = {
  findFirst: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({}),
};
prisma.revokedToken = {
  findUnique: vi.fn().mockResolvedValue(null),
  upsert: vi.fn().mockResolvedValue({}),
  findMany: vi.fn().mockResolvedValue([]),
};
prisma.smsConfig = {
  findFirst: vi.fn().mockResolvedValue(null),
};
// T37 / Class B6 — RBAC self-heal seam. /login (inline self-heal block
// at routes/auth.js:521-535) AND /signup + /register (call
// provisionRbacForFreshTenant unconditionally at lines 260 + 323) reach
// into prisma.userRole / prisma.role / prisma.rolePermission /
// prisma.roleWidget via scripts/ensureRbacOnBoot.js. Without these the
// real Prisma client tries to reach demo MySQL — errors are caught as
// non-fatal but each socket retry burns 5s and the test timeout fires.
// Permissive stubs: userRole.count=1 short-circuits the /login self-heal
// before it calls the provisioner; role.findFirst returns an "existing"
// row so ensureRole skips create + permissions + widget seeding for
// signup/register paths.
prisma.userRole = {
  count: vi.fn().mockResolvedValue(1),
  findUnique: vi.fn().mockResolvedValue(null),
  findFirst: vi.fn().mockResolvedValue(null),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({}),
};
prisma.role = {
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

const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  return app;
}

function bearer({ userId = 7, tenantId = 1, role = 'ADMIN', jti } = {}) {
  const payload = { userId, tenantId, role };
  if (jti) payload.jti = jti;
  return 'Bearer ' + jwt.sign(payload, JWT_SECRET, { expiresIn: '5m' });
}

function findAuthCookie(res) {
  const cookies = res.headers['set-cookie'];
  if (!Array.isArray(cookies)) return undefined;
  return cookies.find((c) => c.startsWith('auth_token='));
}

beforeEach(() => {
  prisma.user.findUnique.mockReset();
  prisma.user.findFirst.mockReset();
  prisma.user.findMany.mockReset().mockResolvedValue([]);
  prisma.user.create.mockReset();
  prisma.user.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue(null);
  prisma.tenant.findMany.mockReset().mockResolvedValue([]);
  prisma.tenant.create.mockReset();
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({});
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.revokedToken.upsert.mockReset().mockResolvedValue({});
  prisma.smsConfig.findFirst.mockReset().mockResolvedValue(null);
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
  delete process.env.NODE_ENV;

  // Schema-drift compat shim: User.email is now composite-unique with
  // tenantId (@@unique([email, tenantId])), so login + signup + register +
  // duplicate-email checks use findFirst not findUnique. The existing
  // tests in this file pre-date the migration and mock findUnique. Have
  // findFirst delegate so every existing `prisma.user.findUnique.mockResolvedValue(...)`
  // assertion keeps working without per-test edits.
  prisma.user.findFirst.mockImplementation((...args) => prisma.user.findUnique(...args));
});

// ── POST /api/auth/login ─────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  test('happy path: returns { token, user, tenant } and writes LOGIN audit', async () => {
    const hashed = await bcrypt.hash('password123', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      email: 'admin@globussoft.com',
      name: 'Admin',
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

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^eyJ/);
    expect(res.body.user).toMatchObject({ id: 7, email: 'admin@globussoft.com', role: 'ADMIN' });
    expect(res.body.tenant).toMatchObject({ id: 1, slug: 'globussoft', plan: 'PRO' });

    // JWT carries the expected claims (userId, tenantId, role, vertical, jti).
    const decoded = jwt.verify(res.body.token, JWT_SECRET);
    expect(decoded.userId).toBe(7);
    expect(decoded.tenantId).toBe(1);
    expect(decoded.role).toBe('ADMIN');
    expect(decoded.vertical).toBe('generic');
    expect(typeof decoded.jti).toBe('string');
    expect(decoded.jti.length).toBe(32); // crypto.randomBytes(16).toString('hex')

    // #555: LOGIN audit row emitted.
    const loginAudit = prisma.auditLog.create.mock.calls.find(
      (c) => c[0] && c[0].data && c[0].data.action === 'LOGIN',
    );
    expect(loginAudit).toBeDefined();
    expect(loginAudit[0].data.entity).toBe('Auth');
  });

  test('wrong password → 401 Invalid credentials (no body token)', async () => {
    const hashed = await bcrypt.hash('password123', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      email: 'admin@globussoft.com',
      password: hashed,
      role: 'ADMIN',
      wellnessRole: null,
      twoFactorEnabled: false,
      tenantId: 1,
      tenant: { id: 1, name: 'Globussoft', vertical: 'generic' },
    });

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'admin@globussoft.com', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
    expect(res.body.token).toBeUndefined();
  });

  test('unknown email → 401 same envelope as wrong-password (anti-enumeration #192)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'ghost@nowhere.example', password: 'whatever' });

    // Critical: identical 401 body to the wrong-password case — never disclose
    // "user not found" vs "wrong password". The route also runs a dummy
    // bcrypt.compare on the absent-user path to equalise timing.
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
  });

  test('empty body → 400 (defensive, not a Prisma 500)', async () => {
    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email and password are required/i);
    // Critical: validation runs BEFORE the DB call — no findUnique with
    // email:undefined (which would crash Prisma).
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('user.twoFactorEnabled → returns { requires2FA:true, tempToken } not full JWT', async () => {
    const hashed = await bcrypt.hash('password123', 10);
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      email: 'admin@globussoft.com',
      password: hashed,
      role: 'ADMIN',
      wellnessRole: null,
      twoFactorEnabled: true, // gate the 2FA branch
      tenantId: 1,
      tenant: { id: 1, name: 'Globussoft', vertical: 'generic' },
    });

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'admin@globussoft.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.requires2FA).toBe(true);
    expect(res.body.tempToken).toMatch(/^eyJ/);
    expect(res.body.token).toBeUndefined();
    expect(res.body.user).toBeUndefined();

    // The tempToken carries awaiting2FA:true and a 5-min expiry.
    const decoded = jwt.verify(res.body.tempToken, JWT_SECRET);
    expect(decoded.awaiting2FA).toBe(true);
    expect(decoded.userId).toBe(7);
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(300);
  });
});

// ── POST /api/auth/signup ────────────────────────────────────────────

describe('POST /api/auth/signup', () => {
  test('happy path → 201 with { token, user, tenant }, creates User + Tenant', async () => {
    prisma.user.findUnique.mockResolvedValue(null); // email is free
    prisma.tenant.create.mockResolvedValue({
      id: 42, name: 'Acme', slug: 'acme', plan: 'TRIAL', vertical: 'generic',
      country: 'US', defaultCurrency: 'USD', locale: 'en-US', logoUrl: null, brandColor: null,
    });
    prisma.user.create.mockResolvedValue({
      id: 100, email: 'new@user.com', name: 'New User', role: 'ADMIN', wellnessRole: null,
    });

    const res = await request(makeApp())
      .post('/api/auth/signup')
      .send({ email: 'new@user.com', password: 'password123', name: 'New User', organizationName: 'Acme' });

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^eyJ/);
    expect(res.body.user).toMatchObject({ id: 100, email: 'new@user.com', role: 'ADMIN' });
    expect(res.body.tenant).toMatchObject({ id: 42, slug: 'acme', plan: 'TRIAL' });

    // bcrypt.hash was applied (password field on the create payload is NOT the plaintext).
    expect(prisma.user.create).toHaveBeenCalled();
    const createArg = prisma.user.create.mock.calls[0][0];
    expect(createArg.data.password).not.toBe('password123');
    expect(createArg.data.password).toMatch(/^\$2[ab]\$/); // bcrypt prefix
  });

  // DRIFT: User.email is now composite-unique with tenantId, so the
  // signup route INTENTIONALLY no longer pre-checks for duplicate email
  // (see routes/auth.js:217-220 comment — "same email is allowed to own
  // multiple orgs"). The old "already exists" contract is gone. If a
  // future migration restores a global email uniqueness the test below
  // can be revived.
  test.skip('duplicate email → 400 "User already exists" (SUT no longer dup-checks)', () => {});

  test('weak password (no digit) → 400 with complexity-error message', async () => {
    const res = await request(makeApp())
      .post('/api/auth/signup')
      .send({ email: 'new@user.com', password: 'onlyletters', name: 'New' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one number/i);
    // Critical: password validation runs FIRST so we never even look up the email.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('weak password (< 8 chars) → 400', async () => {
    const res = await request(makeApp())
      .post('/api/auth/signup')
      .send({ email: 'new@user.com', password: 'a1b2', name: 'New' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 8 characters/i);
  });
});

// ── POST /api/auth/register ──────────────────────────────────────────

describe('POST /api/auth/register', () => {
  test('happy path → 201 with { token, user, tenant } (mirrors /signup)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.tenant.create.mockResolvedValue({
      id: 43, name: 'Beta Inc', slug: 'beta-inc', plan: 'TRIAL', vertical: 'generic',
      country: 'US', defaultCurrency: 'USD', locale: 'en-US', logoUrl: null, brandColor: null,
    });
    prisma.user.create.mockResolvedValue({
      id: 101, email: 'reg@user.com', name: 'Reg User', role: 'ADMIN', wellnessRole: null,
    });

    const res = await request(makeApp())
      .post('/api/auth/register')
      .send({ email: 'reg@user.com', password: 'password123', name: 'Reg User', organizationName: 'Beta Inc' });

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^eyJ/);
    expect(res.body.tenant.slug).toBe('beta-inc');
  });

  // DRIFT: same as /signup — the register route no longer pre-checks
  // duplicate email (see routes/auth.js:217-220). Composite-unique
  // [email, tenantId] makes the same email valid across orgs.
  test.skip('duplicate email → 400 "User already exists" (SUT no longer dup-checks)', () => {});
});

// ── GET /api/auth/me ─────────────────────────────────────────────────

describe('GET /api/auth/me', () => {
  test('without Authorization header → 401 (verifyToken gate)', async () => {
    const res = await request(makeApp()).get('/api/auth/me');
    expect(res.status).toBe(401);
    // Critical: we must never even reach the route handler.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('happy path → 200 with profile + features.smsConfigured', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 7, name: 'Admin', email: 'admin@globussoft.com', role: 'ADMIN',
      wellnessRole: null, createdAt: new Date('2026-01-01T00:00:00Z'),
      tenant: { id: 1, name: 'Globussoft', slug: 'globussoft', plan: 'PRO', vertical: 'generic', country: 'US', defaultCurrency: 'USD', locale: 'en-US', logoUrl: null, brandColor: null },
    });

    const res = await request(makeApp())
      .get('/api/auth/me')
      .set('Authorization', bearer());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    expect(res.body.email).toBe('admin@globussoft.com');
    expect(res.body.tenant.slug).toBe('globussoft');
    // T1.2 feature flag — features.smsConfigured surfaced for the FE to gate
    // the patient-portal OTP UI. The value depends on tenant SmsConfig +
    // MSG91/TWILIO/FAST2SMS env fallbacks (resolveProviderConfig), so we
    // pin the SHAPE (boolean present) rather than the value.
    expect(res.body.features).toBeDefined();
    expect(typeof res.body.features.smsConfigured).toBe('boolean');
  });

  test('token user no longer exists → 404 (not 500)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .get('/api/auth/me')
      .set('Authorization', bearer());

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/user not found/i);
  });
});

// ── POST /api/auth/logout (#180 + #569 + #914 slice 1) ───────────────

describe('POST /api/auth/logout', () => {
  test('happy path: upserts RevokedToken on jti, clears auth_token cookie, writes LOGOUT audit', async () => {
    const jti = 'a'.repeat(32);
    const res = await request(makeApp())
      .post('/api/auth/logout')
      .set('Authorization', bearer({ jti }))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // #180: RevokedToken row upserted keyed on the JWT's jti.
    expect(prisma.revokedToken.upsert).toHaveBeenCalled();
    const upsertArg = prisma.revokedToken.upsert.mock.calls[0][0];
    expect(upsertArg.where.jti).toBe(jti);
    expect(upsertArg.create.reason).toBe('user_logout');
    expect(upsertArg.create.userId).toBe(7);

    // #914 slice 1: auth_token cookie cleared (Path=/api, Max-Age=0 or Expires=1970).
    const cookie = findAuthCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/Path=\/api/i);
    expect(cookie).toMatch(/(Max-Age=0|Expires=Thu, 01 Jan 1970)/i);

    // #569: LOGOUT audit row written.
    const logoutAudit = prisma.auditLog.create.mock.calls.find(
      (c) => c[0] && c[0].data && c[0].data.action === 'LOGOUT',
    );
    expect(logoutAudit).toBeDefined();
    expect(logoutAudit[0].data.entity).toBe('User');
    expect(logoutAudit[0].data.userId).toBe(7);
  });

  test('legacy token (no jti) → 200 { ok:true, revoked:false } (no RevokedToken row)', async () => {
    // Bearer without jti claim — represents the migration-window case.
    const res = await request(makeApp())
      .post('/api/auth/logout')
      .set('Authorization', bearer()) // no jti
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.revoked).toBe(false);
    expect(res.body.reason).toBe('legacy_token_no_jti');
    // Critical: no jti means no stable identifier — we must NOT insert
    // a blank row, otherwise the cleanup job has nothing to key on.
    expect(prisma.revokedToken.upsert).not.toHaveBeenCalled();
  });
});

// ── PUT /api/auth/me — password change (#711) ────────────────────────

describe('PUT /api/auth/me — password change', () => {
  test('wrong current password → 400 "Current password is incorrect"', async () => {
    const hashed = await bcrypt.hash('actual-password', 10);
    prisma.user.findUnique.mockResolvedValue({ id: 7, password: hashed });

    const res = await request(makeApp())
      .put('/api/auth/me')
      .set('Authorization', bearer())
      .send({ currentPassword: 'wrong-current', newPassword: 'newpass123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/current password is incorrect/i);
    // Critical: wrong old-password aborts BEFORE bcrypt.hash on the new one.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('newPassword without currentPassword → 400', async () => {
    const res = await request(makeApp())
      .put('/api/auth/me')
      .set('Authorization', bearer())
      .send({ newPassword: 'newpass123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/current password is required/i);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('weak newPassword → 400 with code WEAK_PASSWORD (#711)', async () => {
    const res = await request(makeApp())
      .put('/api/auth/me')
      .set('Authorization', bearer())
      .send({ currentPassword: 'anything', newPassword: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEAK_PASSWORD');
    // Complexity check happens before bcrypt.compare on current — we never
    // hit the DB on a malformed new password.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('newPassword > 72 chars → 400 PASSWORD_TOO_LONG (bcrypt truncation guard #711)', async () => {
    // bcrypt silently truncates inputs > 72 bytes — any 100-char password
    // would forever match its first-72-bytes prefix. Reject before hashing.
    const tooLong = 'a1' + 'X'.repeat(72); // 74 chars, satisfies complexity, exceeds length cap
    const res = await request(makeApp())
      .put('/api/auth/me')
      .set('Authorization', bearer())
      .send({ currentPassword: 'anything', newPassword: tooLong });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSWORD_TOO_LONG');
  });
});

// ── POST /api/auth/forgot-password (#531 anti-enumeration) ───────────

describe('POST /api/auth/forgot-password', () => {
  test('known email → 200 { status:"ack", code:"RESET_LINK_REQUESTED" }, no token in body', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 7, email: 'admin@globussoft.com' });

    const res = await request(makeApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'admin@globussoft.com' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ack');
    expect(res.body.code).toBe('RESET_LINK_REQUESTED');
    // CRITICAL (#526 / HI-02): the reset token must NEVER ship in the response.
    expect(res.body.resetToken).toBeUndefined();
    expect(res.body.token).toBeUndefined();
  });

  test('unknown email → identical 200 envelope (anti-enumeration #531)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/auth/forgot-password')
      .send({ email: 'ghost@nowhere.example' });

    // CRITICAL: known + unknown must return THE SAME shape. If this test
    // ever sees a code/status diff between known + unknown, we've regressed
    // the user-enumeration oracle fix.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ack');
    expect(res.body.code).toBe('RESET_LINK_REQUESTED');
  });
});

// ── POST /api/auth/reset-password ────────────────────────────────────

describe('POST /api/auth/reset-password', () => {
  test('weak new password → 400 WEAK_PASSWORD (#711)', async () => {
    const res = await request(makeApp())
      .post('/api/auth/reset-password')
      .send({ token: 'some-token', newPassword: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEAK_PASSWORD');
    // Complexity check happens before the reset-token lookup. The route
    // must enforce the same policy /register and PUT /me enforce per #711.
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  test('invalid/expired reset token → 400 with "Invalid or expired" message', async () => {
    const res = await request(makeApp())
      .post('/api/auth/reset-password')
      .send({ token: 'no-such-token', newPassword: 'newpass123' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired reset token/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

// ── POST /api/auth/tenant-switch (#555 lock-per-session) ─────────────

describe('POST /api/auth/tenant-switch', () => {
  test('always returns 410 GONE with code TENANT_SWITCH_DISABLED (#555)', async () => {
    const res = await request(makeApp())
      .post('/api/auth/tenant-switch')
      .set('Authorization', bearer())
      .send({ tenantId: 99 });

    // POLICY (v3.7.3): lock-per-session — picking a tenant requires logout
    // + re-login. Any in-session switcher is a privilege-confusion surface.
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('TENANT_SWITCH_DISABLED');
    expect(res.body.error).toMatch(/log out and log in again/i);
    expect(res.body.hint).toMatch(/logout/i);
  });
});
